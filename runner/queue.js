// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// Beads queue integration — DESIGN.md §4.10, §4.11, §4.12 (T12).
// The host runner is the SOLE Beads writer. Task order: the ready queue (open,
// unblocked, dependencies satisfied), ranked by priority (0 = highest), FIFO within
// the same priority. Terminal transitions come from the §4.11 outcome table.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { bd, bdJson } = require('./bd');
// ONE FORMULA, ONE FILE (§3.2, change-log row `receipt-design`). The freeze gate writes the
// receipt's `suiteHash` with `suiteHash(workingTreeEntries(...))` and this module recomputes it
// with `suiteHash(treeEntries(...))` from the fetched branch. A second copy of that formula
// here would drift from the gate's silently and unattended — the `runner/pause.js` precedent —
// and the failure would be a whole batch refused for a reason nobody could reproduce, or a
// changed suite admitted.
const { suiteHash, treeEntries, RECEIPT_NAME } = require('./suite-hash');

// §4.11 outcome table: exit code -> {report status, Beads status}. 'killed' is the
// host-observed wall-clock kill, which produces no exit code.
const OUTCOMES = {
  0: { status: 'done', beads: 'closed' },          // refined to 'partial' via verify.json
  10: { status: 'stuck', beads: 'blocked' },
  11: { status: 'tampered', beads: 'blocked' },
  20: { status: 'paused', beads: null },           // stays in_progress; runner parks it
  30: { status: 'failed', beads: 'blocked' },
  killed: { status: 'failed', beads: 'blocked' },
};

function outcomeFor(exitCode, verify) {
  const key = exitCode === 'killed' ? 'killed' : Number(exitCode);
  const base = OUTCOMES[key] || OUTCOMES[30];
  // done vs partial is decided by verify.json, not by the exit code (§4.11).
  if (base.status === 'done' && verify && verify.regressions === 'fail') {
    return { status: 'partial', beads: 'closed' };
  }
  return { ...base };
}

// Types the runner never runs (§3.1, §4.12). A DENY-LIST, not an allow-list: bd also
// has bug, feature, chore and decision, and the runner drains all of them. Admitting
// only 'task' would make a legitimately-typed issue carrying a full spec vanish from
// every run with nothing to say why.
const EXCLUDED_TYPES = new Set(['epic']);

// The type as bd reports it, normalised for comparison. Absent, null or empty comes
// back as '' — which no excluded name matches, so such an entry is KEPT (§4.12
// back-compat: failing closed on a missing field would drain nothing at all against an
// older bd, the catastrophic direction).
function typeOf(issue) {
  const t = issue && issue.issue_type;
  return typeof t === 'string' ? t.trim().toLowerCase() : '';
}

// ---- the dispatchability gate (§4.12's SECOND admission rule) -------------------------
// A task whose frozen acceptance suite is not on the branch its container will fork from
// can never pass: the verifier's first act is `<verifyCommand> tests/acceptance/<id>/`,
// which exits 1 against a missing directory before any of the agent's work is consulted,
// three times, once per attempt. Dispatching it spends a container to record `stuck`.
//
// The bound, on the `runner/bd.js` `spawnOptions(cfg)` precedent — and the value of that
// precedent is that EVERY spawn in the module is built from it, so an exported builder that
// some spawn ignores is scaffolding. `git fetch` against an unreachable host parks
// indefinitely in exactly the way an unbounded `bd` once parked whole runs.
const DEFAULT_GIT_TIMEOUT_MS = 60000;

function gitSpawnOptions(cfg, extra = {}) {
  const want = cfg && cfg.gitTimeoutMs;
  const timeout = Number.isInteger(want) && want > 0 ? want : DEFAULT_GIT_TIMEOUT_MS;
  // SIGKILL for the same reason bd.js uses it: a bound a wedged process can decline to
  // honour is not a bound. A timed-out spawnSync reports status null and signal SIGKILL,
  // which every call site below already reads as "not zero" — an abort, never an answer.
  return { encoding: 'utf8', timeout, killSignal: 'SIGKILL', ...extra };
}

const git = (cfg, args, extra) => spawnSync('git', args, gitSpawnOptions(cfg, extra));

// WITHOUT A LITERAL FALLBACK, and failing to resolve aborts. Deliberately not
// `runner/workspace.js`'s `detectDefaultBranch`, whose chain ends at the literal 'main':
// correct there, because it only ever runs against a fresh clone where `origin/HEAD` is
// always set, and catastrophic here, where guessing `main` for a `master` project empties
// `ls-tree` for EVERY issue and refuses the whole queue with a confident wrong reason.
function resolveBranch(cfg) {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(cfg.targetRepoPath, 'pipeline.config.json'), 'utf8'));
    const named = parsed && parsed.defaultBranch;
    if (typeof named === 'string' && named.trim()) return { ok: true, branch: named.trim() };
  } catch { /* no config, unreadable, or not valid JSON: ask the remote instead */ }
  // The remote itself, by URL — not `origin/HEAD` in a checkout that may point elsewhere.
  const r = git(cfg, ['ls-remote', '--symref', cfg.targetRepoRemote, 'HEAD']);
  // `\s*$` inside the pattern, not a trim of the whole output: the working copy on the
  // reference host is CRLF and the container is LF (CLAUDE.md's line-ending rule).
  const m = /^ref:\s+refs\/heads\/(\S+)\s+HEAD\s*$/m.exec(r.stdout || '');
  if (r.status === 0 && m) return { ok: true, branch: m[1] };
  return {
    ok: false,
    error: `cannot resolve the integration branch of ${cfg.targetRepoRemote}: `
      + `pipeline.config.json in ${cfg.targetRepoPath} names no defaultBranch, and `
      + `\`git ls-remote --symref\` returned no HEAD symref`
      + `${(r.stderr || '').trim() ? ` — ${(r.stderr || '').trim()}` : ''}`,
  };
}

// One fetch per run, BY URL and with an EXPLICIT REFSPEC, into a throwaway repository.
//   by URL     — `targetRepoPath` and `targetRepoRemote` are independent config keys
//                `runner/config.js` never relates, so a working copy whose `origin` points
//                elsewhere would answer confidently about a different repository;
//   refspec    — a bare `git fetch <url>` sets FETCH_HEAD to the remote's HEAD and silently
//                discards the resolved branch;
//   throwaway  — FETCH_HEAD is per-repository state, and writing it into the working copy
//                an operator is using is a side effect §5's readers are forbidden to have.
// Returns a probe that answers one candidate at a time, plus its own cleanup.
function fetchBranch(cfg, branch) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-dispatch-gate-'));
  const cleanup = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ } };
  // No `--initial-branch`: the throwaway's own branch name is never read (FETCH_HEAD is),
  // and pinning it would make the gate — which runs before every dispatch — require a git
  // newer than 2.28 for no benefit at all.
  const init = git(cfg, ['init', '-q', dir]);
  if (init.status !== 0) {
    cleanup();
    return { ok: false, error: `cannot prepare a throwaway repository for the dispatch check: ${(init.stderr || '').trim() || `git init exited ${init.status}`}` };
  }
  const fetched = git(cfg, ['fetch', '--quiet', cfg.targetRepoRemote, branch], { cwd: dir });
  if (fetched.status !== 0) {
    cleanup();
    return {
      ok: false,
      error: `cannot read branch '${branch}' of ${cfg.targetRepoRemote} to check which tasks are frozen: `
        + `${(fetched.stderr || '').trim() || `git fetch exited ${fetched.status}`}`,
    };
  }
  return { ok: true, dir, cleanup };
}

// `-d` is not leniency to be tidied away later: a suite committed as a single FILE answers
// empty here and is refused, which matches the verifier, whose trailing-slash invocation
// would fail on a file too.
function suitePath(issueId) { return `tests/acceptance/${issueId}`; }

function hasSuite(cfg, probe, issueId) {
  const r = git(cfg, ['ls-tree', '-d', '--name-only', 'FETCH_HEAD', '--', suitePath(issueId)],
    { cwd: probe.dir });
  if (r.status !== 0) {
    return { ok: false, error: `cannot read FETCH_HEAD while checking ${suitePath(issueId)}: ${(r.stderr || '').trim() || `git ls-tree exited ${r.status}`}` };
  }
  return { ok: true, present: !!(r.stdout || '').trim() };
}

// ---- §4.12's THIRD admission rule: the receipt ----------------------------------------
// The second rule proves a suite is PRESENT; this one proves it was GATED. The freeze gate
// writes `tests/acceptance/<issue-id>/.freeze-gate.json` on a verdict that proceeds (§3.2), and
// a suite that carries none — or carries one written for a different suite than the branch now
// holds — is a suite nothing has ever proved an implementation can turn green. Twelve stuck
// tasks in one fortnight were traced to exactly that, so it is a refusal rather than a note.
//
// The four kinds. They are a CLOSED VOCABULARY, shared with `schemas/run.schema.json`'s
// `tasks.items.properties.refusal` enum and with the report's per-kind heading and remedy: a
// refusal a reader cannot name is a refusal nobody can act on, which is the whole failure this
// gate exists to end.
const REFUSAL = {
  NO_SUITE: 'no-suite',
  NO_RECEIPT: 'no-receipt',
  MISMATCH: 'receipt-mismatch',
  HALF_PROVEN: 'half-proven',
};

// Verdicts the gate writes a receipt for at all (§3.2): `red` — the suite fails at the fork
// point and passes in a probe — and `half-proven` — red, but no probe was supplied, so the
// green side has never been seen. Anything else in the field is a receipt this runner cannot
// interpret and is treated as no receipt, never as a pass.
const RECEIPT_VERDICTS = new Set(['red', 'half-proven']);

// The receipt schema versions this runner understands. Deliberately the READER's own set and
// not an import of `scripts/freeze-gate.js`'s `RECEIPT_VERSION`: a writer writes exactly one
// version and a reader accepts every version it can still interpret, so the two are different
// facts that only happen to have one element in common today. `tests/unit/dispatch-gate.test.js`
// pins the overlap — the gate's current version must be in here — which is the drift the two
// constants could otherwise develop in silence.
const KNOWN_GATE_VERSIONS = new Set([1]);

// The receipt as it stands on the branch, or null where there is none to read. `git show` of a
// path a tree does not hold exits non-zero, which is the ordinary "no receipt" answer; a spawn
// that never answered at all (status null — the bound fired) is the discriminator being
// unavailable and aborts, exactly as an unreadable tree does. Reporting a timed-out git as a
// missing receipt would refuse a perfectly frozen queue with a confident wrong reason.
function readReceipt(cfg, probe, issueId) {
  const rel = `${suitePath(issueId)}/${RECEIPT_NAME}`;
  const r = git(cfg, ['show', `FETCH_HEAD:${rel}`], { cwd: probe.dir });
  if (r.status === null) {
    return { ok: false, error: `cannot read ${rel} from FETCH_HEAD: ${(r.stderr || '').trim() || `git show was killed by ${r.signal || 'a signal'}`}` };
  }
  if (r.status !== 0) return { ok: true, text: null };
  return { ok: true, text: r.stdout || '' };
}

// What the runner will accept as a receipt, or the reason it will not. Unparseable, missing
// either load-bearing field, an unknown verdict and an unknown version are ALL "no receipt"
// (§4.12): each of them is
// a file the runner cannot interpret, and interpreting one anyway is how a suite nobody gated
// reaches a container. The distinction is kept in `detail` so the refusal reason can say which.
function parseReceipt(text) {
  if (text === null || text === undefined) return { ok: false, detail: 'the freeze gate has never been run over it, or its receipt was not pushed' };
  let parsed;
  try { parsed = JSON.parse(text); } catch { return { ok: false, detail: 'the file beside the suite is not valid JSON' }; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, detail: 'the file beside the suite is not a receipt object' };
  }
  if (!KNOWN_GATE_VERSIONS.has(parsed.gateVersion)) {
    return { ok: false, detail: `its gateVersion ${JSON.stringify(parsed.gateVersion)} is not one this runner understands` };
  }
  if (typeof parsed.verdict !== 'string' || !RECEIPT_VERDICTS.has(parsed.verdict)) {
    return { ok: false, detail: `its verdict ${JSON.stringify(parsed.verdict)} is not one the gate writes a receipt for` };
  }
  // Hex, and long enough to be a digest: a `suiteHash` of `true`, `""` or `0` compares unequal
  // to everything and would be reported as a mismatch — the wrong refusal, sending a person to
  // re-gate a suite whose real problem is the receipt.
  if (typeof parsed.suiteHash !== 'string' || !/^[0-9a-f]{40,128}$/.test(parsed.suiteHash)) {
    return { ok: false, detail: 'it records no suite hash' };
  }
  return { ok: true, receipt: { gateVersion: parsed.gateVersion, verdict: parsed.verdict, suiteHash: parsed.suiteHash } };
}

// The suite's hash AS THE BRANCH HOLDS IT — never the working copy, which is the operator's
// desk and routinely holds an uncommitted edit made while a run is in flight. `treeEntries`
// reads blob ids straight out of the fetched tree and is bounded by the run's own git timeout,
// so no unbounded spawn enters the gate through the shared formula.
function branchSuiteHash(cfg, probe, issueId) {
  const rel = suitePath(issueId);
  try {
    return { ok: true, hash: suiteHash(treeEntries(probe.dir, 'FETCH_HEAD', rel, { timeoutMs: gitSpawnOptions(cfg).timeout })) };
  } catch (e) {
    return { ok: false, error: `cannot hash ${rel}/ on the fetched branch: ${(e && e.message) || String(e)}` };
  }
}

// One candidate, in the order the design fixes: suite -> receipt -> hash -> verdict, first
// refusal wins (§4.12). The order is not cosmetic — a suite that is absent has no receipt and
// no hash either, and reporting the downstream symptom would send a person to re-run a gate
// over a directory that does not exist.
function judge(cfg, probe, issue, branch) {
  const where = `${suitePath(issue.id)}/ on ${branch} of ${cfg.targetRepoRemote}`;
  const present = hasSuite(cfg, probe, issue.id);
  // An unreadable tree is the discriminator being unavailable (§3.2): it aborts rather than
  // quietly refusing the whole queue with a confident wrong reason.
  if (!present.ok) return { abort: present.error };
  if (!present.present) {
    return { refusal: REFUSAL.NO_SUITE, reason: `no frozen acceptance suite at ${where}` };
  }

  const raw = readReceipt(cfg, probe, issue.id);
  if (!raw.ok) return { abort: raw.error };
  const parsed = parseReceipt(raw.text);
  if (!parsed.ok) {
    return {
      refusal: REFUSAL.NO_RECEIPT,
      reason: `no freeze receipt the runner can read at ${suitePath(issue.id)}/${RECEIPT_NAME} on ${branch} of ${cfg.targetRepoRemote} — ${parsed.detail}`,
    };
  }

  const hashed = branchSuiteHash(cfg, probe, issue.id);
  if (!hashed.ok) return { abort: hashed.error };
  if (hashed.hash !== parsed.receipt.suiteHash) {
    return {
      refusal: REFUSAL.MISMATCH,
      reason: `the freeze receipt does not match the suite at ${where}: the gate blessed `
        + `${parsed.receipt.suiteHash.slice(0, 12)} and the branch now holds ${hashed.hash.slice(0, 12)}`,
    };
  }

  // The one refusal an operator can turn off, and it is off by default: a probe is what catches
  // a frozen suite no implementation can satisfy, and that class was seven of the twelve stuck
  // tasks. `!== true` rather than a truthiness test, so a config that says "yes" says it in the
  // boolean `run.config.json` validates rather than in whatever a JSON file happens to carry.
  if (parsed.receipt.verdict === 'half-proven' && cfg.allowHalfProven !== true) {
    return {
      refusal: REFUSAL.HALF_PROVEN,
      reason: `the freeze receipt for ${where} records a half-proven freeze — the suite was red `
        + 'at the fork point but no probe was supplied, so nothing has ever shown an '
        + 'implementation can turn it green, and this run does not admit half-proven suites',
    };
  }
  return { dispatch: true };
}

// Split the candidates into what may be dispatched and what may not. LAZY at the caller:
// a queue with no candidates never reaches here, so it neither fetches nor aborts — an
// eager gate turns a legitimately empty run into an exit-1 failure.
function partitionByFreeze(cfg, candidates) {
  const resolved = resolveBranch(cfg);
  if (!resolved.ok) return { ok: false, error: resolved.error };
  const branch = resolved.branch;
  const probe = fetchBranch(cfg, branch);
  if (!probe.ok) return { ok: false, error: probe.error };
  try {
    const issues = [];
    const undispatchable = [];
    for (const issue of candidates) {
      const answer = judge(cfg, probe, issue, branch);
      if (answer.abort) return { ok: false, error: answer.abort };
      if (answer.dispatch) issues.push(issue);
      // The KIND travels beside the reason from here on: through the feed's live refusal map,
      // onto the manifest row, and into the report's heading and remedy. A reason is prose a
      // human reads; the kind is what every consumer downstream branches on.
      else undispatchable.push({ issue, reason: answer.reason, refusal: answer.refusal });
    }
    return { ok: true, issues, undispatchable, branch };
  } finally {
    probe.cleanup();
  }
}

// Ready work: bd's own blocker-aware semantics (verified in T2), then our ordering, then
// §4.12's second admission rule. Returns the survivors, the entries filtered out by type,
// and the entries refused for want of a frozen suite, so the caller can name both
// populations in the queue-summary line — a skip nobody can see is the silent-failure
// family this design has already paid for.
//
// The two failure channels are told apart by a FIELD, never by message wording: `run.js`
// logs a `bd` cause as "cannot read the Beads ready queue", and reporting a fetch failure
// under that cause sends a person to the wrong system. The wording cannot be the contract,
// because the run's log line lives behind `main()` where no Docker-free test can reach it.
function readyQueue(cfg) {
  const res = bdJson(cfg, ['ready']);
  if (!res.ok) return { ok: false, cause: 'bd', error: res.error };
  const entries = Array.isArray(res.data) ? res.data : [];
  const skipped = entries.filter((i) => EXCLUDED_TYPES.has(typeOf(i)));
  const candidates = entries.filter((i) => !EXCLUDED_TYPES.has(typeOf(i))).sort((a, b) => {
    const pa = a.priority ?? 2;
    const pb = b.priority ?? 2;
    if (pa !== pb) return pa - pb;                                   // 0 = highest first
    return String(a.created_at || '').localeCompare(String(b.created_at || '')); // FIFO
  });
  // LAZY (§4.12): nothing to dispatch means nothing to check. Fetching here would turn an
  // empty queue — the normal state of a drained project — into a run abort.
  if (!candidates.length) return { ok: true, issues: [], skipped, undispatchable: [] };

  const gate = partitionByFreeze(cfg, candidates);
  // Never a partial or fallback answer: the gate could not tell frozen from unfrozen, so
  // the run has no basis for dispatching anything at all.
  if (!gate.ok) return { ok: false, cause: 'git', error: gate.error };
  return { ok: true, issues: gate.issues, skipped, undispatchable: gate.undispatchable };
}

// The manufactured manifest row for a refused issue — a PURE EXPORTED FUNCTION, not inline
// code in `main()`, which sits behind the token load and the Docker preflight and is
// therefore unreachable to every Docker-free test (the reason `queueSummary` was lifted out
// of it in the first place). A refused task never enters `drainQueue`, so unlike the
// rate-limit refusal there is no row for `.filter(Boolean)` to preserve: this is the only
// place that information still exists.
//
// It carries more than the outcome word because the report renders a row's BODY from these
// fields, and a minimal row produces a section reading "no change summary produced" that
// tells the reader nothing to do — the outcome this whole gate exists to prevent.
// The remedy, KEYED BY KIND. Four refusals with one remedy between them would be four ways of
// telling a reader to do the wrong thing three times: freezing a suite that already exists
// changes nothing, and re-running the gate over a suite that is missing cannot even start.
// `runner/report.js` renders the same four kinds into its heading and its body paragraph and
// keeps its own wording, because a heading is a phrase and this is an instruction.
const REMEDY = {
  [REFUSAL.NO_SUITE]: (id) => `freeze the suite at ${suitePath(id)}/ on the integration branch and push it`,
  [REFUSAL.NO_RECEIPT]: (id) => `run the freeze gate over ${suitePath(id)}/ and push the ${RECEIPT_NAME} it writes beside the suite`,
  [REFUSAL.MISMATCH]: (id) => `run the freeze gate over ${suitePath(id)}/ again and push the suite and its fresh ${RECEIPT_NAME} together`,
  [REFUSAL.HALF_PROVEN]: (id) => `re-gate ${suitePath(id)}/ with a probe so the green side is seen, or set \`allowHalfProven: true\` in the run config to accept a half-proven freeze`,
};
const REFUSAL_KINDS = new Set(Object.values(REFUSAL));

// `refusal` is optional and the fallback is the historic remedy: a manifest written before the
// third admission rule existed, and any other writer of this outcome, carries no kind at all,
// and a row that renders "undefined" for one is worse than a row that renders the old sentence.
function undispatchableRow(issue, reason, runId, refusal) {
  const id = (issue && issue.id) || '';
  const kind = REFUSAL_KINDS.has(refusal) ? refusal : null;
  const remedy = (REMEDY[kind] || REMEDY[REFUSAL.NO_SUITE])(id);
  const row = {
    issueId: id,
    title: (issue && issue.title) || '',
    outcome: 'undispatchable',
    changeSummary: `Nothing ran: ${reason}. To dispatch it, ${remedy}. Beads was never touched — the issue is still \`open\` and the next run picks it up unchanged.`,
    attemptNotes: [`run ${runId}: not dispatched — ${reason}\n  remedy: ${remedy}; the issue is untouched in Beads and stays open`],
  };
  // Set only when it is known: `additionalProperties: false` accepts the field, but a row
  // carrying `refusal: undefined` would serialise it away and read, to every later consumer,
  // exactly like a row that was never given one — while `Object.keys` says otherwise.
  if (kind) row.refusal = kind;
  return row;
}

const describe = (i) => `${i.id} (${typeOf(i) || 'untyped'})`;

// The run's queue-summary line, built here rather than inline in run.js so it can be
// tested at all: run.js only reaches it after loadToken and the Docker preflight, which
// no Docker-free test can execute (same move repo-dhp made with shouldFileMemory).
// The historic prefix is load-bearing — scripts/test-runner-queue.sh greps it at six
// sites — so both clauses are APPENDED, never woven into it.
function queueSummary(issues, skipped, undispatchable) {
  const list = Array.isArray(issues) ? issues : [];
  const out = Array.isArray(skipped) ? skipped : [];
  const refused = Array.isArray(undispatchable) ? undispatchable : [];
  let line = `ready queue: ${list.length} task(s) — ${list.map((i) => i.id).join(', ') || '(empty)'}`;
  if (out.length) {
    line += `; skipped ${out.length} by type: ${out.map(describe).join(', ')}`;
  }
  // Kept entries that are not plain tasks are named too: the deny-list means the runner
  // will happily run a bug or a chore, and a reviewer should see that it did.
  const nonTask = list.filter((i) => typeOf(i) && typeOf(i) !== 'task');
  if (nonTask.length) {
    line += `; running ${nonTask.length} non-task: ${nonTask.map(describe).join(', ')}`;
  }
  // §4.12's second admission rule, LAST — after both historic clauses, so neither moves.
  // Named with the remedy, because this skip is worse than most: until the gate shipped the
  // tasks did appear in the report, as three-attempt failures indexed under the agent's
  // name rather than under the missing freeze.
  if (refused.length) {
    const ids = refused.map((u) => (u && u.issue && u.issue.id) || String(u && u.id || '')).join(', ');
    line += `; NOT DISPATCHABLE ${refused.length}: ${ids}`
      + ' — no frozen suite at tests/acceptance/<issue-id>/ on the integration branch;'
      + ' freeze and push it, then re-run (the issues stay open, untouched)';
  }
  return line;
}

// ---- the ledger's two queue facts (§4.12, §5; change-log row `repo-3xw`) ----------------
// What the run decided about its own queue is the fact no reader can get today: the summary
// line above is prose, and the per-issue refusals reach `run.log` and nowhere else. Both now
// have a structured twin.
//
// They are HELPERS HERE rather than inline code in `run.js` for the reason `queueSummary`
// and `undispatchableRow` already are: `main()` sits behind the token load and the Docker
// preflight, so anything written there is unreachable to every Docker-free test — and an
// event that is emitted by nobody's test is an event that stops being emitted quietly.
//
// IDS, NEVER ISSUE OBJECTS. A `bd` issue carries a title, a description and whatever fields a
// future `bd` adds; putting one in the ledger would make every event line grow without anyone
// deciding to, and would put issue prose into an artifact whose whole value is that it can be
// read by machine. The id is the join key; a reader that wants the title has `run.json`.

// One call, one timestamp, two records: the `ready queue: ` line a human reads and the
// structured twin a reader joins on. Building the message here — rather than logging the
// summary in `run.js` and the event separately — is what makes "the two cannot disagree"
// true by construction rather than by discipline.
function logQueueRead(log, q) {
  const issues = (q && Array.isArray(q.issues)) ? q.issues : [];
  const skipped = (q && Array.isArray(q.skipped)) ? q.skipped : [];
  const refused = (q && Array.isArray(q.undispatchable)) ? q.undispatchable : [];
  log.info(log.trace('preflight'), queueSummary(issues, skipped, refused), {
    event: 'queue.read',
    data: {
      ready: issues.map((i) => String((i && i.id) || '')),
      // The type is carried because it is WHY the entry was skipped, and the deny-list can
      // grow: an id alone would say an issue vanished without saying what removed it.
      skipped: skipped.map((i) => ({ id: String((i && i.id) || ''), type: typeOf(i) })),
      refused: refused.map(refusalFacts),
    },
  });
}

// The per-issue refusal, paired with the `not dispatched: ` ERROR line it already writes.
// Traced to the ISSUE, not to `preflight`: a refusal is a fact about one task, and the
// ledger's `issueId` is the trace's tail, so tracing it run-level would file it under no
// issue at all — the reader asking "what happened to r-4" would find nothing.
function logUndispatched(log, u) {
  const facts = refusalFacts(u);
  log.error(log.trace(facts.id), `not dispatched: ${facts.reason} — Beads untouched, the issue stays open`, {
    event: 'task.undispatched',
    data: facts,
  });
}

// `refusal` is the refusal KIND — a short machine token, where `reason` is the sentence a
// human reads. Nothing produces one yet (the gate has exactly one way to refuse), so it is
// carried only when present rather than defaulted: a `refusal: null` on every line would be a
// field a later reader has to learn to ignore, and inventing a kind here would fix the
// vocabulary before the task that owns it has chosen one.
function refusalFacts(u) {
  const issue = (u && u.issue) || {};
  const facts = {
    id: String(issue.id || (u && u.id) || ''),
    reason: String((u && u.reason) || ''),
  };
  if (u && typeof u.refusal === 'string' && u.refusal) facts.refusal = u.refusal;
  return facts;
}

function claim(cfg, issueId) {
  return bd(cfg, ['update', issueId, '--status', 'in_progress']).status === 0;
}

// Export the issue for the container: read-only file mounted at .run/issue.md (§4.10).
// The container never talks to Beads.
function exportIssue(cfg, issueId) {
  const res = bdJson(cfg, ['show', issueId]);
  if (!res.ok) return { ok: false, error: res.error };
  const i = Array.isArray(res.data) ? res.data[0] : res.data;
  if (!i) return { ok: false, error: `issue ${issueId} not found` };
  const md = [
    `# ${i.id}: ${i.title || ''}`,
    '',
    i.description || '',
    '',
    '## Acceptance criteria',
    i.acceptance_criteria || '(none recorded)',
    '',
    '## Design reference',
    i.design || '(none recorded)',
    '',
  ].join('\n');
  return { ok: true, markdown: md, issue: i };
}

// Terminal write-back after a container exits (§4.10: notes travel via the status file).
function finish(cfg, issueId, outcome, notes) {
  for (const n of notes.filter(Boolean)) bd(cfg, ['note', issueId, n]);
  if (!outcome.beads) return;                       // paused: leave in_progress
  if (outcome.beads === 'closed') bd(cfg, ['close', issueId]);
  else bd(cfg, ['update', issueId, '--status', outcome.beads]);
}

// Attempt-log line from the container's status file (§4.11).
// memoryIn is the count exported into the container (§3.6 In channel): a number, or
// null when the export failed. Recorded next to the outgoing notes so both halves of
// the channel are visible on the issue at review time — an In channel that quietly
// stops delivering is otherwise invisible, since an empty export still succeeds.
function attemptNotes(runId, outcome, status, memoryIn) {
  const lines = [`run ${runId}: outcome ${outcome.status}`];
  for (const a of (status && status.attempts) || []) {
    lines.push(`  attempt ${a.number}: ${a.verifierResult} at ${a.timestamp}`);
  }
  if (status && status.stuckState) lines.push(`  stuck: ${status.stuckState}`);
  if (status && status.rateLimitResetAt) lines.push(`  paused until ${status.rateLimitResetAt}`);
  if (status && status.docsPhaseError) lines.push(`  docs: ${status.docsPhaseError}`);
  // Proposed memory notes are visible at review — that is where the §3.6 promotion rule
  // is applied (a note that keeps recurring graduates into repo files).
  if (status && Array.isArray(status.memoryNotes) && status.memoryNotes.length) {
    lines.push(`  memory notes: ${status.memoryNotes.length}`);
  }
  // §3.7. A count here and the full text in the report and PR body: this line lands on the
  // Beads issue, which is where someone asking "what happened to that task" looks, and a
  // concern that reached only the status file reached nobody at all.
  if (status && Array.isArray(status.specConcerns) && status.specConcerns.length) {
    lines.push(`  SPEC CONCERNS RAISED: ${status.specConcerns.length} — see the run report`);
  }
  if (memoryIn === null) lines.push('  memory in: export failed');
  else if (typeof memoryIn === 'number') lines.push(`  memory in: ${memoryIn}`);
  return [lines.join('\n')];
}

// `EXCLUDED_TYPES` and `typeOf` are exported as a pair, and only as a pair: the deny-list is
// meaningless without the normalisation that decides what an entry's type IS (absent, null
// and '' all read as '' and are therefore KEPT). `scripts/batch.js` applies exactly this
// filter before calling any live-queue entry an extra, because bd returns epic parents by
// design and a reader that reported them would raise the false alarm every time. A second
// copy of the rule would drift from the runner's, and the whole value of the reconciliation
// is that it predicts what the runner will actually drain.
//
// `gitSpawnOptions` and `undispatchableRow` are exported for the reason every other pure
// helper in this file is: `main()` sits behind the token load and the Docker preflight, so
// a bound applied there, or a row manufactured there, is unreachable to every Docker-free
// test — and a gate that refuses correctly while manufacturing nothing would pass a suite
// that never looked.
//
// `REFUSAL` and `KNOWN_GATE_VERSIONS` are exported for the same reason again, and for one more:
// the version set is the READER's half of a constant whose writer's half lives in
// `scripts/freeze-gate.js`, and two constants that must overlap and cannot see each other drift
// in silence. `tests/unit/dispatch-gate.test.js` reads both and pins the overlap.
module.exports = {
  readyQueue, queueSummary, claim, exportIssue, finish, outcomeFor, attemptNotes, OUTCOMES,
  EXCLUDED_TYPES, typeOf, gitSpawnOptions, undispatchableRow, DEFAULT_GIT_TIMEOUT_MS,
  logQueueRead, logUndispatched,
  REFUSAL, KNOWN_GATE_VERSIONS, RECEIPT_VERDICTS,
};
