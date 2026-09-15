// Frozen acceptance test — repo-djf.42: do not classify interrupted-partial acceptance suites
// as freeze-ready. This is the RED half; `guard.js` beside it carries the checks that are
// already green at the fork point and must stay green while this file's checks turn green for
// the first time.
//
// CRITERION PAIRING — every check below also names its own criterion in its label.
//
//   C1  durable author-generation evidence distinguishes absent, actively authoring,
//       interrupted-partial, authored-unproven, proven and frozen; file existence alone cannot
//       select freeze or print a freeze command.                    -> T1
//   C2  interruption after any subset of suite writes preserves exact partial bytes and
//       diagnostics outside the model-editable tree, then exposes one explicit bounded
//       resume/re-author path without manual deletion.               -> T2
//   C3  recovery never duplicates Beads reads/issues, worktrees, proof generations or model
//       launches, and never edits product/frozen paths.              -> T3
//   C4  a zero/nonzero/missing terminal provider result and process interruption converge on
//       truthful outcomes compatible with repo-7a0; completed unproven batch recovery remains
//       compatible with repo-djf.17.                                 -> T4
//   C5  deterministic tests cover interruption before files, between files, after files but
//       before terminal result, during proof, and concurrent retry, while completed/proven/
//       frozen paths retain their existing human-approval gates.     -> T5
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE FROZEN INTERFACE. Neither the issue nor Beads names a module or function surface, so this
// suite fixes one, built from the vocabulary `scripts/prepare-batch-worker.js` and
// `scripts/author-tests.js` already write durably today (no new data field is required of
// either): a worker result's `outcome` is one of `proven-at-base` | `unproven` | `agent-failed`
// | `agent-incomplete` | `boundary-violation` | `interrupted` | `abandoned` | `setup-failed` |
// `invalid`, and every one of those already reaches `runner/preparation-state.js` via the
// existing `writeWorkerResult`. Nothing here asks any existing recorder to write a new field.
//
// `runner/author-evidence.js` (NEW) exports:
//
//   STATES
//     `{ ABSENT: 'absent', AUTHORING: 'authoring', INTERRUPTED_PARTIAL: 'interrupted-partial',
//        AUTHORED_UNPROVEN: 'authored-unproven', PROVEN: 'proven', FROZEN: 'frozen' }`, frozen.
//
//   AUTHOR_INCOMPLETE_OUTCOMES
//     An array (or Set) containing at least `agent-failed`, `agent-incomplete`,
//     `boundary-violation`, `interrupted`, `setup-failed` — the durable outcomes that mean an
//     `author-proof` attempt's AUTHORING half never reached a terminal completed result.
//
//   classify({ frozen, suiteFiles, latest, isLive }) -> { state, reason }
//     Pure and synchronous. `frozen` (boolean) wins outright. `suiteFiles` is `null` (no suite
//     directory) or a string array of file names present. `latest` is `{ started, result }` in
//     the exact shape `readWorkerRecords`'s latest row already has (`started.phase` is
//     `author-proof` or `proof`; `result` is `null` or `{ outcome, ... }`), or `null` when no
//     attempt was ever recorded. `isLive(identity)` decides whether an unresolved attempt is
//     still running.
//       * frozen                                                           -> FROZEN
//       * no attempt, no suite files                                       -> ABSENT
//       * no attempt, suite files present (hand-authored/legacy, nothing contradicts them)
//                                                                           -> AUTHORED_UNPROVEN
//       * an `author-proof` attempt with no result, live                   -> AUTHORING
//       * an `author-proof` attempt with no result, not live               -> INTERRUPTED_PARTIAL
//       * an `author-proof` attempt whose result.outcome is in
//         AUTHOR_INCOMPLETE_OUTCOMES                                       -> INTERRUPTED_PARTIAL
//         — REGARDLESS of `suiteFiles`: this is the file-existence-alone rule from C1.
//       * an `author-proof` attempt whose result.outcome is `unproven`     -> AUTHORED_UNPROVEN
//       * an `author-proof` attempt whose result.outcome is `proven-at-base`/`proven`
//                                                                           -> PROVEN
//       * a `proof` attempt (no result, live or not; or settled not-proven)-> AUTHORED_UNPROVEN
//       * a `proof` attempt whose result.outcome is `proven-at-base`/`proven`
//                                                                           -> PROVEN
//
//   mayPrintFreezeCommand(state) -> boolean
//     True only for AUTHORED_UNPROVEN, PROVEN, FROZEN.
//
// `scripts/prepare-batch.js` changes:
//
//   classifyBuilt(id, built, evidence = null)
//     A NEW third, optional parameter. Every existing two-argument call (guard.js G1, and every
//     call already in this codebase) is untouched. When `evidence` is supplied and
//     `evidence.state === 'interrupted-partial'`, a `built.state` of `freeze` or `re-gate` (a
//     suite directory that merely HAS FILES) selects `action: 'author-proof'` instead of
//     `action: 'proof'` — the file-existence-alone selection C1 forbids.
//
//   parseArgs(argv)
//     A new bare flag `--resume-partial`, accepted only by `retry`, surfaced as
//     `answer.resumePartial` (boolean, default false).
//
//   execute(opts, io, seams)
//     In `retry`, when an acknowledged interruption's `interruptedPhase` is `author-proof` and
//     the freshly (evidence-aware) computed action would otherwise mismatch it, `opts.resumePartial
//     === true` accepts the retry — forcing `action: 'author-proof'` and launching exactly one
//     new worker generation in the EXISTING worktree — instead of the existing `attention`
//     refusal. Without the flag, or for any other mismatch, behaviour is BYTE IDENTICAL to today
//     (guard.js G2 — the exact fixture tests/unit/prepare-batch.test.js calls "M4"). Nothing in
//     this path deletes, moves or archives the partial suite bytes; they are simply left for the
//     resumed worker to continue from.
//
// `scripts/spec-brief.js` changes:
//
//   classifyLocal(cfg, canonicalId, requestedId, folder, seams = {})
//     Now exported (it was internal). A new optional fifth `seams` parameter; `seams.evidence
//     (canonicalId)`, when supplied, returns `{ state, reason }` or `null` and OVERRIDES the
//     default evidence lookup. When the local suite directory holds files and evidence says
//     `interrupted-partial`, the return becomes `{ ok:true, state:'write',
//     local:'interrupted-partial', suiteId }` instead of `{ state:'freeze', local:[...files] }`.
//     With no contradicting evidence (`seams.evidence` absent, or the default lookup finding no
//     durable record for that suite), behaviour is BYTE IDENTICAL to today — every hand-authored
//     suite already in this repository, including this one before it is frozen, is unaffected.
//
// `scripts/author-tests.js` changes:
//
//   main(argv, io, seams)
//     A new optional `seams.authorEvidence(built) -> { state, reason }` seam (defaulted in
//     production to a real evidence lookup). In the branch that already runs whenever
//     `built.state !== 'write'`, the freeze command (`nextStep(...)`) is now printed only when
//     `AUTHOR_EVIDENCE.mayPrintFreezeCommand(evidenceState)` is true; otherwise the command
//     prints an explicit, bounded instruction to re-run this exact CLI invocation (the solo
//     path's own one-explicit-bounded-resume: a solo re-run always continues in the SAME
//     already-existing worktree, so no extra flag is needed here the way batch `retry` needs
//     `--resume-partial`).
//
// SPEC DEFECTS FOUND — see the bottom of this file.
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');

for (const name of ['CODEX_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) {
  delete process.env[name];
}

const P = require(path.join(ROOT, 'scripts', 'prepare-batch.js'));
const AUTHOR = require(path.join(ROOT, 'scripts', 'author-tests.js'));
const State = require(path.join(ROOT, 'runner', 'preparation-state.js'));
const Lock = require(path.join(ROOT, 'runner', 'lock.js'));
const EVIDENCE_FILE = path.join(ROOT, 'runner', 'author-evidence.js');

const tests = [];
function test(name, body) { tests.push({ name, body }); }

function evidence() {
  assert(fs.existsSync(EVIDENCE_FILE), `runner/author-evidence.js does not exist: ${EVIDENCE_FILE}`);
  // eslint-disable-next-line global-require
  return require(EVIDENCE_FILE);
}

const temps = [];
function tmp(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `repo-djf42-${tag}-`));
  temps.push(dir);
  return dir;
}
function cleanup() {
  for (const dir of temps.splice(0)) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
}

function built(id, state, extra = {}) {
  const folder = extra.folder || { dir: path.join(os.tmpdir(), `freeze-${id}`), branch: `freeze-${id}`, exists: true };
  return {
    ok: true, id, state, branch: 'main', text: `brief for ${id}`,
    cfg: { targetRepoPath: os.tmpdir(), model: 'opus', wallClockMinutes: 1 },
    policy: { verifyCommand: 'sh tools/run-acceptance.sh', frozenPaths: [] },
    folder, criteria: { source: 'structured', sha256: 'a'.repeat(64), text: '1. works' },
    issue: { id, title: id, priority: 2, dependencies: [] },
    ...extra,
  };
}

function attempt(phase, result, pid = 4242) {
  return { started: { phase, pid, process: { pid } }, result };
}
function outcome(value) { return { outcome: value }; }
const ALWAYS_LIVE = () => true;
const NEVER_LIVE = () => false;

// Set up a durable batch with one recorded, acknowledged author-proof interruption and a real
// partial suite directory in `target`. Returns everything a retry test needs.
function interruptedFixture(tag, phaseAcked = 'author-proof') {
  const stateRoot = tmp(`${tag}-state`);
  const target = tmp(`${tag}-target`);
  const id = `djf42-${tag}`;
  const batch = `wave-${tag}`;
  const cfg = { targetRepoPath: target, allowHalfProven: false, model: 'opus' };
  State.createManifest(stateRoot, batch, {
    project: 'fixture', runConfig: 'run.json', intent: 'test', concurrency: 1,
    integrationBranch: 'main', integrationHead: 'f'.repeat(40),
    config: cfg, issues: [{ id, dependencies: [] }],
  });
  const suiteDir = path.join(target, 'tests', 'acceptance', id);
  fs.mkdirSync(suiteDir, { recursive: true });
  const partialFile = path.join(suiteDir, 'guard.js');
  const partialBytes = '// partial: interrupted before test.js was ever written\n';
  fs.writeFileSync(partialFile, partialBytes);
  State.writeWorkerStarted(stateRoot, batch, id, { nonce: 'd'.repeat(32), phase: phaseAcked, pid: 2147483000 });
  const ackOwner = Lock.acquire(ROOT, target, `${tag}-ack-owner`, { allowPreparationRecovery: true });
  P.acknowledgeInterrupted(stateRoot, batch, [id], State, cfg, { out() {}, err() {} }, { ownership: ackOwner.ownership });
  Lock.release(ROOT, target, ackOwner.ownership);
  return { stateRoot, target, id, batch, cfg, suiteDir, partialFile, partialBytes };
}

// ── T1 / C1 ──────────────────────────────────────────────────────────────────────────────────
test('T1 C1 durable evidence distinguishes all six states, and file existence alone never selects freeze', () => {
  const E = evidence();
  assert(E.STATES && typeof E.STATES === 'object');
  for (const key of ['ABSENT', 'AUTHORING', 'INTERRUPTED_PARTIAL', 'AUTHORED_UNPROVEN', 'PROVEN', 'FROZEN']) {
    assert(typeof E.STATES[key] === 'string' && E.STATES[key].length, `STATES.${key} is missing`);
  }
  assert.strictEqual(E.STATES.INTERRUPTED_PARTIAL, 'interrupted-partial');

  // frozen wins outright, even over an unresolved attempt.
  assert.strictEqual(E.classify({ frozen: true, suiteFiles: [], latest: attempt('author-proof', null), isLive: NEVER_LIVE }).state,
    E.STATES.FROZEN);

  // no attempt at all.
  assert.strictEqual(E.classify({ frozen: false, suiteFiles: null, latest: null }).state, E.STATES.ABSENT);
  // no attempt, but files exist — nothing contradicts them (hand-authored/legacy), so file
  // existence alone is STILL respected in the absence of contradicting evidence.
  assert.strictEqual(E.classify({ frozen: false, suiteFiles: ['guard.js', 'test.js'], latest: null }).state,
    E.STATES.AUTHORED_UNPROVEN);

  // a live author-proof attempt.
  assert.strictEqual(E.classify({ suiteFiles: [], latest: attempt('author-proof', null), isLive: ALWAYS_LIVE }).state,
    E.STATES.AUTHORING);

  // THE CORE RULE: a settled-incomplete author-proof attempt is interrupted-partial NO MATTER
  // HOW MANY SUITE FILES EXIST — file existence alone cannot select freeze.
  const E_OUTCOMES = Array.isArray(E.AUTHOR_INCOMPLETE_OUTCOMES) ? E.AUTHOR_INCOMPLETE_OUTCOMES : [...E.AUTHOR_INCOMPLETE_OUTCOMES];
  for (const badOutcome of ['agent-failed', 'agent-incomplete', 'boundary-violation', 'interrupted', 'setup-failed']) {
    assert(E_OUTCOMES.includes(badOutcome), `AUTHOR_INCOMPLETE_OUTCOMES is missing ${badOutcome}`);
    for (const files of [null, [], ['guard.js'], ['guard.js', 'test.js']]) {
      const r = E.classify({ suiteFiles: files, latest: attempt('author-proof', outcome(badOutcome)), isLive: NEVER_LIVE });
      assert.strictEqual(r.state, E.STATES.INTERRUPTED_PARTIAL,
        `outcome=${badOutcome} files=${JSON.stringify(files)} classified as ${r.state}, not interrupted-partial`);
    }
  }
  // an unresolved (no result, not live) author-proof attempt is interrupted-partial too.
  assert.strictEqual(E.classify({ suiteFiles: ['guard.js'], latest: attempt('author-proof', null), isLive: NEVER_LIVE }).state,
    E.STATES.INTERRUPTED_PARTIAL);

  // authoring completed with a terminal result: unproven proof keeps it authored-unproven.
  assert.strictEqual(E.classify({ suiteFiles: ['guard.js', 'test.js'], latest: attempt('author-proof', outcome('unproven')), isLive: NEVER_LIVE }).state,
    E.STATES.AUTHORED_UNPROVEN);
  // ...and a successful proof is proven.
  assert.strictEqual(E.classify({ suiteFiles: ['guard.js', 'test.js'], latest: attempt('author-proof', outcome('proven-at-base')), isLive: NEVER_LIVE }).state,
    E.STATES.PROVEN);
  assert.strictEqual(E.classify({ suiteFiles: ['guard.js', 'test.js'], latest: attempt('proof', outcome('proven-at-base')), isLive: NEVER_LIVE }).state,
    E.STATES.PROVEN);

  // mayPrintFreezeCommand: only for the three states that were ever going to be a real freeze.
  for (const s of [E.STATES.ABSENT, E.STATES.AUTHORING, E.STATES.INTERRUPTED_PARTIAL]) {
    assert.strictEqual(E.mayPrintFreezeCommand(s), false, `mayPrintFreezeCommand(${s}) must be false`);
  }
  for (const s of [E.STATES.AUTHORED_UNPROVEN, E.STATES.PROVEN, E.STATES.FROZEN]) {
    assert.strictEqual(E.mayPrintFreezeCommand(s), true, `mayPrintFreezeCommand(${s}) must be true`);
  }

  // WIRING: classifyBuilt(id, built, evidence) — a `freeze`/`re-gate` built.state (raw file
  // existence) does not select `proof` when evidence says interrupted-partial.
  const interrupted = { state: E.STATES.INTERRUPTED_PARTIAL, reason: 'fixture' };
  assert.strictEqual(P.classifyBuilt('app-1', built('app-1', 'freeze'), interrupted).action, 'author-proof');
  assert.strictEqual(P.classifyBuilt('app-1', built('app-1', 're-gate'), interrupted).action, 'author-proof');
  // ...but an authored-unproven or proven evidence value leaves today's selection alone.
  const unproven = { state: E.STATES.AUTHORED_UNPROVEN, reason: 'fixture' };
  assert.strictEqual(P.classifyBuilt('app-1', built('app-1', 'freeze'), unproven).action, 'proof');

  // WIRING: scripts/spec-brief.js's classifyLocal is exported and evidence-aware. A suite
  // directory holding only a partial write, with durable evidence saying interrupted-partial,
  // classifies as `write`/`interrupted-partial` — never `freeze` — even though files exist.
  const SPEC = require(path.join(ROOT, 'scripts', 'spec-brief.js'));
  assert.strictEqual(typeof SPEC.classifyLocal, 'function', 'scripts/spec-brief.js does not export classifyLocal');
  const folderDir = tmp('t1-classifylocal');
  const suiteDir = path.join(folderDir, 'tests', 'acceptance', 'djf42-t1');
  fs.mkdirSync(suiteDir, { recursive: true });
  fs.writeFileSync(path.join(suiteDir, 'guard.js'), '// partial\n');
  const folder = { dir: folderDir, exists: true, branch: 'freeze-djf42-t1' };
  const withEvidence = SPEC.classifyLocal({ targetRepoPath: folderDir }, 'djf42-t1', 'djf42-t1', folder,
    { evidence: () => interrupted });
  assert.strictEqual(withEvidence.ok, true, JSON.stringify(withEvidence));
  assert.strictEqual(withEvidence.state, 'write', JSON.stringify(withEvidence));
  assert.strictEqual(withEvidence.local, 'interrupted-partial', JSON.stringify(withEvidence));
  // With NO contradicting evidence (the historical default), the exact same files still freeze —
  // hand-authored suites, including this very suite before it is frozen, are unaffected.
  const withoutEvidence = SPEC.classifyLocal({ targetRepoPath: folderDir }, 'djf42-t1', 'djf42-t1', folder,
    { evidence: () => null });
  assert.strictEqual(withoutEvidence.state, 'freeze', JSON.stringify(withoutEvidence));

  // WIRING: author-tests.js's main() never prints the freeze command for an interrupted-partial
  // suite — "file existence alone cannot ... print a freeze command".
  const outLines = [];
  const code = AUTHOR.main(['djf42-t1', '--config', 'run.json'], { out: (l) => outLines.push(String(l)), err() {} }, {
    loadConfig: () => ({ targetRepoPath: folderDir }),
    acquireLock: () => ({ ok: true, tookOver: false, ownership: {} }), releaseLock() {},
    buildBrief: () => ({
      ok: true, state: 'freeze', id: 'djf42-t1', suiteId: 'djf42-t1',
      cfg: { targetRepoPath: folderDir, model: 'opus', testAuthorModel: 'opus', testProbeModel: 'opus' },
      folder, policy: { verifyCommand: 'sh tools/run-acceptance.sh' },
    }),
    authorEvidence: () => interrupted,
  });
  const text = outLines.join('\n');
  assert.strictEqual(code, 0, text);
  assert(!/freeze\.js commit/.test(text), `an interrupted-partial suite must not print the freeze command: ${text}`);
  assert(/interrupted/i.test(text), `no interrupted-partial explanation was printed: ${text}`);
});

// ── T2 / C2 ──────────────────────────────────────────────────────────────────────────────────
test('T2 C2 interruption preserves exact partial bytes and durable diagnostics, and --resume-partial resumes without deleting anything', async () => {
  const fx = interruptedFixture('t2');

  // --resume-partial parses as a retry-only bare flag.
  const parsed = P.parseArgs(['retry', fx.batch, fx.id, '--resume-partial']);
  assert(!parsed.error, parsed.error);
  assert.strictEqual(parsed.resumePartial, true);
  const misplaced = P.parseArgs(['resume', fx.batch, '--resume-partial']);
  assert(/retry/.test(misplaced.error || ''), '--resume-partial must be rejected outside retry');

  // Diagnostics (the durable started/result records) live entirely under the preparation root,
  // never inside the worktree — "outside the model-editable tree".
  const before = State.readWorkerRecords(fx.stateRoot, fx.batch, fx.id);
  assert.strictEqual(before.length, 1, JSON.stringify(before));
  assert(path.resolve(fx.stateRoot) !== path.resolve(fx.target));
  assert(!fs.existsSync(path.join(fx.target, path.basename(fx.stateRoot))));

  // Exact partial bytes, untouched before any recovery is attempted.
  assert.strictEqual(fs.readFileSync(fx.partialFile, 'utf8'), fx.partialBytes);

  let launched = 0; const launchedActions = [];
  const partial = built(fx.id, 'freeze', { cfg: fx.cfg, folder: { dir: fx.target, branch: `freeze-${fx.id}`, exists: true } });
  const code = await P.execute({ mode: 'retry', batch: fx.batch, issues: [fx.id], concurrency: 2, resumePartial: true },
    { out() {}, err() {} }, {
      state: State, preparationRoot: () => fx.stateRoot, loadConfig: () => fx.cfg,
      acquire: () => ({ ok: true, tookOver: false, ownership: {} }), release() {},
      inspectIntegration: () => ({ ok: true, branch: 'main', head: 'f'.repeat(40) }),
      readyQueue: () => ({ ok: true, issues: [] }),
      runSync: () => ({ status: 0, stdout: 'f'.repeat(40), stderr: '' }),
      buildBrief: () => partial,
      runWorker: (root, batch, item) => { launched += 1; launchedActions.push(item.action); },
    });

  // The one explicit bounded resume path: no attention refusal, exactly one worker relaunched,
  // continuing authoring — never jumping straight to proof-only on the strength of stale files.
  assert.notStrictEqual(code, P.EXIT_ATTENTION, 'resume-partial must not be blocked as an unresolved mismatch');
  assert.strictEqual(launched, 1, 'exactly one worker must be relaunched');
  assert.deepStrictEqual(launchedActions, ['author-proof']);

  // Nothing deleted, moved or rewritten the partial bytes — the coordinator preserves them for
  // the resumed author to continue from, "without manual deletion".
  assert(fs.existsSync(fx.partialFile), 'the partial suite file must not be deleted');
  assert.strictEqual(fs.readFileSync(fx.partialFile, 'utf8'), fx.partialBytes);

  // BOUNDED: --resume-partial does not blanket-bypass every mismatch — an acknowledged PROOF
  // interruption (authoring already succeeded) is not "resumed" as if it were an author problem.
  const fx2 = interruptedFixture('t2-proof-phase', 'proof');
  let proofLaunches = 0;
  const partial2 = built(fx2.id, 'freeze', { cfg: fx2.cfg, folder: { dir: fx2.target, branch: `freeze-${fx2.id}`, exists: true } });
  const code2 = await P.execute({ mode: 'retry', batch: fx2.batch, issues: [fx2.id], concurrency: 2, resumePartial: true },
    { out() {}, err() {} }, {
      state: State, preparationRoot: () => fx2.stateRoot, loadConfig: () => fx2.cfg,
      acquire: () => ({ ok: true, tookOver: false, ownership: {} }), release() {},
      inspectIntegration: () => ({ ok: true, branch: 'main', head: 'f'.repeat(40) }),
      readyQueue: () => ({ ok: true, issues: [] }),
      runSync: () => ({ status: 0, stdout: 'f'.repeat(40), stderr: '' }),
      buildBrief: () => partial2,
      runWorker: () => { proofLaunches += 1; },
    });
  // A proof-phase acknowledgement never mismatches proof-only reclassification, so this retry
  // was never blocked in the first place, and --resume-partial changes nothing about it.
  assert.notStrictEqual(code2, P.EXIT_ATTENTION, 'a proof-phase acknowledgement must not be attention-blocked by a matching reclassification');
});

// ── T3 / C3 ──────────────────────────────────────────────────────────────────────────────────
test('T3 C3 recovery reads Beads once, reuses the existing worktree, allocates exactly one new generation, and touches nothing outside the suite', async () => {
  const fx = interruptedFixture('t3');
  const outsideFile = path.join(fx.target, 'DESIGN.md');
  fs.writeFileSync(outsideFile, 'untouched product content\n');
  const outsideBefore = fs.readFileSync(outsideFile, 'utf8');

  let buildBriefCalls = 0; let worktreeCreations = 0; let runWorkerCalls = 0;
  const partial = built(fx.id, 'freeze', { cfg: fx.cfg, folder: { dir: fx.target, branch: `freeze-${fx.id}`, exists: true } });
  const code = await P.execute({ mode: 'retry', batch: fx.batch, issues: [fx.id], concurrency: 2, resumePartial: true },
    { out() {}, err() {} }, {
      state: State, preparationRoot: () => fx.stateRoot, loadConfig: () => fx.cfg,
      acquire: () => ({ ok: true, tookOver: false, ownership: {} }), release() {},
      inspectIntegration: () => ({ ok: true, branch: 'main', head: 'f'.repeat(40) }),
      readyQueue: () => ({ ok: true, issues: [] }),
      runSync: (cmd, args) => {
        if (Array.isArray(args) && args[0] === 'worktree') worktreeCreations += 1;
        return { status: 0, stdout: 'f'.repeat(40), stderr: '' };
      },
      buildBrief: () => { buildBriefCalls += 1; return partial; },
      runWorker: () => { runWorkerCalls += 1; },
    });

  assert.notStrictEqual(code, P.EXIT_ATTENTION);
  // Exactly one Beads-standing read per issue (buildBrief is the sole bd-reading seam here).
  assert.strictEqual(buildBriefCalls, 1, `buildBrief must be read exactly once, got ${buildBriefCalls}`);
  // The worktree already exists; recovery must not create a second one.
  assert.strictEqual(worktreeCreations, 0, 'recovery must not create a duplicate worktree');
  // Exactly one new model launch.
  assert.strictEqual(runWorkerCalls, 1, 'recovery must not duplicate the model launch');
  // Exactly one new generation on top of the original interrupted attempt.
  const records = State.readWorkerRecords(fx.stateRoot, fx.batch, fx.id);
  assert.strictEqual(records.length, 1, 'in this fixture only the started record exists until runWorker itself records a new one; recovery must not fabricate extra generations before launch');

  // Nothing outside the suite directory was touched.
  assert.strictEqual(fs.readFileSync(outsideFile, 'utf8'), outsideBefore, 'recovery must never edit product/frozen paths');
});

// ── T4 / C4 ──────────────────────────────────────────────────────────────────────────────────
test('T4 C4 zero/nonzero/missing terminal result and process interruption converge on interrupted-partial, compatibly with repo-7a0 and repo-djf.17', () => {
  const E = evidence();
  // repo-7a0's own vocabulary: a zero exit with no terminal completed result becomes
  // agent-incomplete; a nonzero exit becomes agent-failed; a killed/crashed worker becomes
  // interrupted; none of the three is ever silently treated as proven, authored-unproven or
  // frozen.
  for (const settledOutcome of ['agent-incomplete', 'agent-failed', 'interrupted', 'boundary-violation']) {
    const r = E.classify({ suiteFiles: ['guard.js', 'test.js'],
      latest: attempt('author-proof', outcome(settledOutcome)), isLive: NEVER_LIVE });
    assert.strictEqual(r.state, E.STATES.INTERRUPTED_PARTIAL, `${settledOutcome} -> ${r.state}`);
  }
  // A live process (not yet exited at all) is authoring, not any flavour of failure.
  assert.strictEqual(E.classify({ suiteFiles: [], latest: attempt('author-proof', null), isLive: ALWAYS_LIVE }).state,
    E.STATES.AUTHORING);

  // repo-djf.17 compatibility: a "completed unproven" attempt — authoring finished, the proof
  // failed — is authored-unproven, not interrupted-partial, and remains the exact case
  // repo-djf.17's recovery targets.
  const completedUnproven = E.classify({ suiteFiles: ['guard.js', 'test.js'],
    latest: attempt('author-proof', outcome('unproven')), isLive: NEVER_LIVE });
  assert.strictEqual(completedUnproven.state, E.STATES.AUTHORED_UNPROVEN);

  // classifyBuilt's legacy two-argument re-gate path — what a re-gate/proof-only recovery reads
  // before any evidence is available — is untouched, so repo-djf.17's own recovery is unaffected.
  assert.strictEqual(P.classifyBuilt('app-1', built('app-1', 're-gate')).action, 'proof');
});

// ── T5 / C5 ──────────────────────────────────────────────────────────────────────────────────
test('T5 C5 the five interruption timing points, concurrent retry, and unchanged human-approval gates', async () => {
  const E = evidence();

  // (a) before any file: no suite directory at all.
  assert.strictEqual(E.classify({ suiteFiles: null, latest: attempt('author-proof', outcome('agent-incomplete')), isLive: NEVER_LIVE }).state,
    E.STATES.INTERRUPTED_PARTIAL);
  // (b) between files: one file landed, more were planned.
  assert.strictEqual(E.classify({ suiteFiles: ['guard.js'], latest: attempt('author-proof', outcome('agent-incomplete')), isLive: NEVER_LIVE }).state,
    E.STATES.INTERRUPTED_PARTIAL);
  // (c) after files, but before a terminal provider result: every file landed, still incomplete.
  assert.strictEqual(E.classify({ suiteFiles: ['guard.js', 'test.js'], latest: attempt('author-proof', outcome('agent-incomplete')), isLive: NEVER_LIVE }).state,
    E.STATES.INTERRUPTED_PARTIAL);
  // (d) during proof: authoring already succeeded (a standalone proof-only attempt exists),
  // and that attempt itself is unresolved — never interrupted-partial, since authoring is not in
  // question here.
  assert.strictEqual(E.classify({ suiteFiles: ['guard.js', 'test.js'], latest: attempt('proof', null), isLive: NEVER_LIVE }).state,
    E.STATES.AUTHORED_UNPROVEN);
  assert.strictEqual(E.classify({ suiteFiles: ['guard.js', 'test.js'], latest: attempt('proof', null), isLive: ALWAYS_LIVE }).state,
    E.STATES.AUTHORED_UNPROVEN);

  // (e) concurrent retry: a second --resume-partial retry for the same interrupted issue, while
  // the first still holds ownership, is refused and launches nothing — recovery never races
  // itself into two worktrees or two model launches (C3, exercised again here under concurrency).
  const fx = interruptedFixture('t5-concurrent');
  const partial = built(fx.id, 'freeze', { cfg: fx.cfg, folder: { dir: fx.target, branch: `freeze-${fx.id}`, exists: true } });
  let firstLaunches = 0;
  const firstCode = await P.execute({ mode: 'retry', batch: fx.batch, issues: [fx.id], concurrency: 2, resumePartial: true },
    { out() {}, err() {} }, {
      state: State, preparationRoot: () => fx.stateRoot, loadConfig: () => fx.cfg,
      acquire: () => ({ ok: true, tookOver: false, ownership: {} }), release() {},
      inspectIntegration: () => ({ ok: true, branch: 'main', head: 'f'.repeat(40) }),
      readyQueue: () => ({ ok: true, issues: [] }),
      runSync: () => ({ status: 0, stdout: 'f'.repeat(40), stderr: '' }),
      buildBrief: () => partial, runWorker: () => { firstLaunches += 1; },
    });
  assert.notStrictEqual(firstCode, P.EXIT_ATTENTION);
  assert.strictEqual(firstLaunches, 1);
  let secondLaunches = 0;
  const secondCode = await P.execute({ mode: 'retry', batch: fx.batch, issues: [fx.id], concurrency: 2, resumePartial: true },
    { out() {}, err() {} }, {
      state: State, preparationRoot: () => fx.stateRoot, loadConfig: () => fx.cfg,
      acquire: () => ({ ok: false, holder: { runId: 'first-attempt', pid: 999999 } }), release() {},
      inspectIntegration: () => ({ ok: true, branch: 'main', head: 'f'.repeat(40) }),
      readyQueue: () => ({ ok: true, issues: [] }),
      runSync: () => ({ status: 0, stdout: 'f'.repeat(40), stderr: '' }),
      buildBrief: () => partial, runWorker: () => { secondLaunches += 1; },
    });
  assert.strictEqual(secondCode, P.EXIT_REFUSED, 'a concurrent retry must be refused by the same target lock, not race the first');
  assert.strictEqual(secondLaunches, 0, 'a concurrently refused retry must launch nothing');

  // Completed/proven/frozen paths retain the existing human-approval gate: the freeze command is
  // still printed, unchanged, once evidence clears the suite.
  const nextStepText = AUTHOR.nextStep('djf42-t5', 'run.config.json', null);
  assert(/Human approval is mandatory/.test(nextStepText), nextStepText);
  assert(/scripts\/freeze\.js commit djf42-t5/.test(nextStepText), nextStepText);
  // --resume-partial has no bearing on an evidence state that was never interrupted-partial in
  // the first place: an authored-unproven suite's classifyBuilt selection is unaffected by it.
  const unproven = { state: evidence().STATES.AUTHORED_UNPROVEN, reason: 'fixture' };
  assert.strictEqual(P.classifyBuilt('app-1', built('app-1', 'freeze'), unproven).action, 'proof');
});

(async () => {
  let failed = 0;
  for (const item of tests) {
    try { await item.body(); console.log(`[test] PASS ${item.name}`); }
    catch (error) { failed += 1; console.error(`[test] FAIL ${item.name}: ${error.stack || error.message}`); }
  }
  cleanup();
  if (failed) { console.error(`[test] FAIL ${failed}/${tests.length} focused checks`); process.exitCode = 1; }
  else console.log(`[test] PASS ${tests.length}/${tests.length} focused checks`);
})().catch((error) => {
  cleanup();
  console.error(`[test] FAIL harness: ${error.stack || error.message}`);
  process.exitCode = 1;
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// SPEC DEFECTS FOUND
//
// D1 (C1) The issue names six states but "actively authoring" has no durable trace distinct from
//    "about to be interrupted" until the process actually stops: a live PID is the only signal
//    that separates AUTHORING from INTERRUPTED_PARTIAL, and a PID is inherently racy (it can die
//    between the liveness check and the caller acting on it). This suite reads "actively
//    authoring" as "durable evidence plus a liveness check both currently agree the attempt is
//    running" — a best-effort, not a guarantee — because nothing stronger is achievable without a
//    heartbeat protocol the issue does not ask for.
//
// D2 (C2/DO-NOT-TOUCH) tests/unit/prepare-batch.test.js already pins a scenario ("M4") that is
//    the literal negative of this issue's C2: an acknowledged author-proof interruption whose
//    suite now naively reclassifies as proof-only is REQUIRED to stay `attention`-blocked with
//    zero workers launched, on a bare `retry`. Since tests/unit/ is protected and this suite may
//    not touch it, C2's "one explicit bounded resume/re-author path" can only be satisfied
//    ADDITIVELY — a new, separate, explicitly-opted-into path (this suite fixes it as
//    `retry --resume-partial`) that leaves the bare-`retry` refusal M4 pins completely
//    unchanged. A reading of C2 that required bare `retry` itself to stop blocking that scenario
//    would be UNREACHABLE by any implementation permitted to touch only non-frozen paths; this
//    suite deliberately does not read it that way.
//
// D3 (C1/C5) "during proof" interruption has no separate named state in C1's list of six. This
//    suite resolves it by construction: because authoring and proving currently share one worker
//    attempt in `scripts/prepare-batch-worker.js`, an attempt killed after authoring completed
//    but partway through the proof step is durably indistinguishable, by result alone, from one
//    killed partway through authoring. This suite therefore only asserts the unambiguous case — a
//    STANDALONE `proof`-phase attempt (which already exists whenever a suite is proof-only, e.g.
//    after a prior successful author-proof attempt) — as AUTHORED_UNPROVEN when interrupted,
//    rather than inventing a finer-grained mid-attempt signal the issue does not ask for.
