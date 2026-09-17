// Frozen acceptance test — repo-djf.48: retire superseded frozen acceptance contracts
// explicitly. This is the RED half; `guard.js` beside it carries the checks that are already
// green at the fork point (the byte-pinned canonical profiles, repo-7a0/repo-djf.40 immutability
// and direct loadability, the mandatory regression profile, and the four consumer entry points)
// and must stay green.
//
// SCOPE. Two frozen acceptance suites in this repository now contradict each other. repo-7a0
// pins the author-containment shim as still present and still refusing `bd` AFTER
// `launchAuthor()` has returned; repo-djf.40 requires that same shim to be disposed once the
// provider call settles. Whichever of the two is running last is red, and today the only thing
// that runs the whole acceptance tree — `scripts/verify-pr.sh`'s sibling loop — can do nothing
// with that but call it "ALREADY red at the fork point", which is exactly how a real regression
// gets to look normal. Nothing in the tree records WHY a suite is red on purpose, which issue
// replaced it, or at which commit that replacement became true. This suite is scoped to exactly
// that gap: an explicit, machine-readable retirement contract plus one resolver every consumer
// of the roster shares.
//
// CRITERION PAIRING — every check below also names its own criterion in its label.
//
//   C1  A canonical machine-readable contract records that one frozen acceptance suite is
//       superseded by a specific newer issue and replacement suite, with rationale and
//       integration commit identity; unknown fields, duplicate entries, cycles, missing suites,
//       unfrozen replacements, future or absent commits, and self-supersession fail closed.
//                                                                             -> T1, T2
//   C2  Supersession becomes effective only after the replacement suite is frozen on the
//       integration branch and the superseding implementation is present at the exact candidate
//       under validation; RED-baseline proof for the replacement still sees the older behaviour
//       and cannot hide it.                                                   -> T3, T4
//   C3  fast-full-sweep, test-all, hosted validation and exact-head publication share one
//       resolver: active suites run, superseded suites are reported visibly with their
//       replacement and rationale, and no mutable roster is copied among consumers.
//                                                                       -> T5, T6, T14, T15
//       (guard.js G1 and G4 carry C3's stay-green half.)
//   C4  The repo-7a0 post-launch-persistence assertions are explicitly superseded only by
//       repo-djf.40's per-launch-disposal contract; repo-7a0 history remains immutable and
//       directly runnable, while the active sweep on the corrected candidate is green.
//                                                                             -> T7, T8
//       (guard.js G2 carries C4's stay-green half.)
//   C5  Deterministic tests cover activation timing, stale or forged metadata, chained
//       supersession, Windows path/case behaviour, direct historical execution, reporting, and
//       a planted contradiction; mandatory regressions and all active acceptance suites remain
//       green.
//         activation timing            -> T3
//         stale or forged metadata     -> T11
//         chained supersession         -> T9
//         Windows path/case behaviour  -> T10
//         direct historical execution  -> T8
//         reporting                    -> T12
//         a planted contradiction      -> T11
//         mandatory regressions        -> guard.js G3
//         active acceptance suites green -> T13
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// SPEC DEFECT, REPORTED NOT PAPERED OVER. C3 names `test-all` as one of the four consumers that
// must share the resolver. `scripts/test-all.sh` is unreachable for any implementation: it is
// matched by the `scripts/test-*.sh` frozen pathspec in `pipeline.config.json`, and
// `tests/acceptance/repo-djf.2/` additionally pins its sha256 (and `test-ci.sh`'s) by value, so
// it can be neither edited nor joined by a new sibling leaf suite. The same glob forbids adding
// `scripts/test-<anything>.sh`. The only reachable reading of the `test-all` consumer is the
// coordinator that owns test-all.sh's invocation and its plan, `scripts/fast-full-sweep.js`.
// T5 therefore pins the `test-all` position as: test-all.sh stays byte-identical, and the
// coordinator that drives it resolves the acceptance roster through the shared resolver ON ITS
// OPERATIONAL PATH, before it starts the profiles test-all.sh owns. guard.js G1 keeps the
// byte-identity half green.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHAT COUNTS AS "SHARES ONE RESOLVER". An import, an export, a re-export, a source mention or a
// function-identity comparison says only that a consumer CAN reach the resolver. C3 is about what
// the consumer DOES: T5, T14 and T15 drive each real entry point over a fixture repository and
// require observable runtime evidence that the operational path itself resolved that fixture's
// roster — its own superseded and pending rows in the consumer's own output — and that invalid
// resolver metadata stops the consumer BEFORE it does the work it exists to do. The identity
// comparison is kept alongside that evidence as the single-source half (one function object, no
// second implementation), never as the evidence of use.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE FROZEN INTERFACE. The issue names no module, file or function surface, so this suite fixes
// one. Node built-ins only, synchronous, no container engine, no network, NO PROVIDER KEY.
//
// `contracts/superseded-suites.json` (new) — the canonical machine-readable contract. Exactly
// two top-level keys:
//
//   { "version": 1, "supersessions": [ <entry>, ... ] }
//
// and each entry has exactly these five keys and no others:
//
//   suite              the retired frozen acceptance suite id, a bare directory name under
//                      tests/acceptance/ matching /^[A-Za-z0-9][A-Za-z0-9._-]*$/, spelled
//                      exactly as the directory is spelled on disk.
//   supersededBy       the newer ISSUE id that retires it.
//   replacementSuite   the newer suite id, a bare directory name under tests/acceptance/.
//   rationale          a non-empty single-line string saying why.
//   integrationCommit  40 lowercase hex — the commit ON THE INTEGRATION BRANCH at which the
//                      replacement suite was frozen. EXACTLY that commit: the one that
//                      INTRODUCED the replacement suite (its files are there in that commit's
//                      tree and in no parent of it), not merely some later commit that still
//                      carries them. "Superseded at commit X" is a claim about when the
//                      replacement became true, and every commit after the freeze carries the
//                      files too — so accepting a later commit would accept an identity that
//                      says nothing. T2 and T11 plant later-but-containing commits; T7 requires
//                      the repository's own entry to record the commit derived from Git history.
//
// `runner/suite-supersession.js` (new) exports. It depends on Node built-ins and Git alone, so
// a checkout that carries this one file (as the T15 fixture does) can run it:
//
//   CONTRACT_PATH — the string 'contracts/superseded-suites.json'.
//
//   readContract(root) -> { ok: true, version, entries: [...] } | { ok: false, error: <text> }
//     Parses and shape-validates the contract alone (no Git, no filesystem beyond the file), and
//     returns deeply frozen entries. An ABSENT contract file is { ok: true, entries: [] } — not a
//     refusal — so a checkout that has no retirements, and every fixture that models one, keeps
//     working unchanged.
//
//   resolveSuites({ root, integrationRef, candidateRef, runSuite })
//     -> { ok: true, active, superseded, pending, report } | { ok: false, error: <text> }
//     `root` is the candidate tree under validation. `integrationRef` defaults to the first of
//     `origin/<defaultBranch>`, `<defaultBranch>`, `HEAD` that resolves; `candidateRef` defaults
//     to 'HEAD'. `runSuite(suiteId) -> { ok: <boolean> }` is the seam that answers "is the
//     superseding implementation present at this candidate"; it defaults to running the
//     project's own `verifyCommand` against `tests/acceptance/<suiteId>/` from `root`.
//     Beyond readContract()'s shape rules it also refuses, without handing back any roster: a
//     suite id that is not the exact on-disk directory name, a suite or replacement directory
//     that is not there, a recorded commit that is absent from or unreachable on
//     `integrationRef` or that is not the exact commit which introduced the replacement suite
//     (earlier, later and forged commits alike), a cycle, and a RETIRED SUITE WHOSE WORKING-TREE
//     BYTES NO LONGER MATCH `candidateRef` — a retirement is a claim about immutable history, so
//     history edited under it makes the claim uncheckable.
//       active      sorted suite ids that MUST be run: every immediate subdirectory of
//                   tests/acceptance/ except `_control`, minus the effective retirements. A
//                   checkout with no tests/acceptance/ at all resolves to an empty roster rather
//                   than a refusal, the same way an absent contract does — `scripts/*` fixtures
//                   that carry no acceptance tree are ordinary inputs, not defects.
//       superseded  the effective retirements, each carrying all five contract fields.
//       pending     entries that are valid but not yet effective, each { suite,
//                   replacementSuite, reason: <non-empty text> }; their suites stay in `active`.
//       report      one single-line string per roster row, in the formats T12 pins.
//     Everything returned is deeply frozen, and every call returns fresh objects.
//     CHAINS. Retirements may chain (a retired by b, b retired by c). An entry's presence probe
//     is its TERMINAL replacement — follow `replacementSuite` until a suite that is not itself
//     retired — so no link may be retired on the strength of a link that is itself retired, and
//     `runSuite` is asked about each distinct terminal replacement exactly once. A chain that
//     closes on itself is a cycle and fails closed.
//
//   main(argv) — the CLI. `node runner/suite-supersession.js plan --repo <root>` prints `report`
//     one line per row and exits 0; a refusal prints the error on stderr and exits non-zero.
//
// CONSUMERS. Each entry point must be wired on the path it actually runs, and each is driven
// over a fixture repository to prove it:
//
//   `scripts/fast-full-sweep.js` — `main()`, given `--repo <root>`, resolves <root>'s roster and
//     writes every report row to its own stdout BEFORE it starts any of the profiles it
//     coordinates. A refusal is printed and exits non-zero with no test command started.
//
//   `scripts/freeze.js` — the `commit` verb resolves the roster of `cfg.targetRepoPath` and
//     writes every report row through its `out` channel BEFORE any publication mutation: before
//     the gate writes a receipt into the suite, and before anything is promoted, staged,
//     committed or pushed. A refusal is reported through `err`, returns a non-zero exit code,
//     and leaves the integration checkout, its index and its remote exactly as they were.
//
//   `scripts/verify-pr.sh` — cannot export anything, so it invokes the CLI above over the
//     checkout it is validating: the suites it re-runs on the host are the resolver's `active`
//     roster, the retirements are printed where a reviewer reads them, and a resolver refusal is
//     printed and makes the verification fail rather than quietly passing.
//
//   Both JS consumers also export the resolver itself as `resolveAcceptanceRoster` — the same
//   function object, not a copy or a wrapper. That is the single-source half of C3 (T5), and it
//   is never on its own accepted as evidence that the operational path uses it.
// ─────────────────────────────────────────────────────────────────────────────────────────────
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const RESOLVER_FILE = path.join(ROOT, 'runner', 'suite-supersession.js');
const CONTRACT_FILE = path.join(ROOT, 'contracts', 'superseded-suites.json');
const RUN_ACCEPTANCE = path.join(ROOT, 'tools', 'run-acceptance.sh');

for (const name of ['CODEX_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN',
  'PIPELINE_BD_CMD', 'BD_ARGS_LOG', 'BD_STUB_OUT', 'BD_STUB_EXIT']) delete process.env[name];

const RETIRED = 'repo-7a0';
const REPLACEMENT = 'repo-djf.40';

const tests = [];
function test(name, body) { tests.push({ name, body }); }

const temps = [];
function tmp(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `repo-djf48-${tag}-`));
  temps.push(dir);
  return dir;
}
function cleanupTemps() {
  for (const dir of temps.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* best effort */ }
  }
}

function RESOLVER() {
  assert(fs.existsSync(RESOLVER_FILE), `runner/suite-supersession.js does not exist: ${RESOLVER_FILE}`);
  // eslint-disable-next-line global-require
  return require(RESOLVER_FILE);
}

function run(cmd, args, o = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', timeout: 180000, maxBuffer: 64 * 1024 * 1024, windowsHide: true, ...o });
}
function git(dir, ...args) { return run('git', ['-c', 'safe.directory=*', ...args], { cwd: dir }); }
function head(dir, ref = 'HEAD') { return String(git(dir, 'rev-parse', ref).stdout || '').trim(); }
function write(dir, rel, bytes) {
  const file = path.join(dir, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
}
function commit(dir, msg) {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', msg);
  return head(dir);
}

// A recursive content fingerprint: proves "byte-identical", not merely "still there".
function snapshotTree(dir) {
  const items = [];
  (function walk(rel) {
    const abs = path.join(dir, rel);
    const stat = fs.lstatSync(abs);
    if (stat.isSymbolicLink()) { items.push(`${rel}\0symlink\0${fs.readlinkSync(abs)}`); return; }
    if (stat.isDirectory()) { for (const child of fs.readdirSync(abs).sort()) walk(path.join(rel, child)); return; }
    items.push(`${rel}\0file\0${crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex')}`);
  }('.'));
  return items.sort().join('\n');
}

function assertDeepFrozen(value, label, seen = new Set()) {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return;
  if (seen.has(value)) return;
  seen.add(value);
  assert(Object.isFrozen(value), `${label} is not frozen: ${JSON.stringify(value)}`);
  for (const key of Object.keys(value)) assertDeepFrozen(value[key], `${label}.${key}`, seen);
}

function assertRefusal(result, label, mustName) {
  assert.strictEqual(result && result.ok, false, `${label} was not refused: ${JSON.stringify(result)}`);
  assert(typeof result.error === 'string' && result.error.trim().length > 0,
    `${label} was refused with no error text: ${JSON.stringify(result)}`);
  assert.strictEqual(result.active, undefined, `${label} still handed back an active roster: ${JSON.stringify(result.active)}`);
  assert.strictEqual(result.superseded, undefined, `${label} still handed back a superseded roster`);
  for (const needle of (mustName === undefined || mustName === null ? [] : [].concat(mustName))) {
    assert(result.error.includes(needle), `${label} refusal does not name ${JSON.stringify(needle)}: ${result.error}`);
  }
}

// ── Fixture construction ────────────────────────────────────────────────────────────────────
// A minimal project the resolver can read: this repo's own (frozen, unmodified) acceptance
// runner, a pipeline.config.json naming it, and acceptance suites whose pass/fail is chosen by
// the test. `main` is the integration branch.
function newRepo(tag) {
  const root = tmp(tag);
  fs.mkdirSync(path.join(root, 'tools'), { recursive: true });
  fs.copyFileSync(RUN_ACCEPTANCE, path.join(root, 'tools', 'run-acceptance.sh'));
  write(root, 'pipeline.config.json', `${JSON.stringify({
    verifyCommand: 'sh tools/run-acceptance.sh',
    regressionCommand: 'bash scripts/test-ci.sh',
    regressionPolicy: 'required',
    defaultBranch: 'main',
    frozenPaths: [],
  }, null, 2)}\n`);
  write(root, 'tests/acceptance/_control/test.js', "'use strict';\n");
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'fixture@example.invalid');
  git(root, 'config', 'user.name', 'fixture');
  git(root, 'config', 'commit.gpgsign', 'false');
  commit(root, 'base');
  return root;
}

// `exit` is the suite's own verdict; `ran` (optional absolute path) is appended to when the
// suite actually executes, which is how T8 proves a retired suite is still directly runnable.
function addSuite(root, id, { exit = 0, ran = null } = {}) {
  const lines = ["'use strict';"];
  if (ran) lines.push(`require('fs').appendFileSync(${JSON.stringify(ran)}, ${JSON.stringify(`${id}\n`)});`);
  lines.push(`console.log(${JSON.stringify(`[fixture] ${id}`)});`);
  lines.push(`process.exit(${exit});`);
  write(root, `tests/acceptance/${id}/test.js`, `${lines.join('\n')}\n`);
}

function writeContract(root, entries, extra = {}) {
  write(root, 'contracts/superseded-suites.json',
    `${JSON.stringify({ version: 1, supersessions: entries, ...extra }, null, 2)}\n`);
}

function entry(suite, replacement, integrationCommit, overrides = {}) {
  return {
    suite,
    supersededBy: replacement,
    replacementSuite: replacement,
    rationale: `${replacement} replaces ${suite}: the older assertions now contradict the shipped behaviour.`,
    integrationCommit,
    ...overrides,
  };
}

// The common shape: `old` and `new` both frozen on main, `new` frozen at the returned commit,
// the contract committed on top of it.
function supersessionRepo(tag, { oldExit = 1, newExit = 0, ran = null } = {}) {
  const root = newRepo(tag);
  addSuite(root, 'old', { exit: oldExit, ran });
  const beforeReplacement = commit(root, 'freeze old');
  addSuite(root, 'new', { exit: newExit, ran });
  const freezeCommit = commit(root, 'freeze new');
  writeContract(root, [entry('old', 'new', freezeCommit)]);
  const candidate = commit(root, 'record the retirement');
  return { root, beforeReplacement, freezeCommit, candidate };
}

function stub(map) {
  const calls = [];
  const fn = (suiteId) => { calls.push(suiteId); return { ok: map[suiteId] === true }; };
  fn.calls = calls;
  return fn;
}

const ABSENT_COMMIT = 'b'.repeat(40);
function text(result) { return `${result.stdout || ''}${result.stderr || ''}`; }
function lines(blob) { return String(blob).split(/\r?\n/); }
function reports(blob, row) { return lines(blob).some((line) => line.includes(row)); }
function readLog(file) {
  try { return fs.readFileSync(file, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean); }
  catch { return []; }
}
function logFile(tag) { return path.join(tmp(`${tag}-log`), `${tag}.log`); }

// scripts/verify-pr.sh declares bash; the acceptance runner only guarantees `sh`. Ask once which
// POSIX shell this host actually has rather than assuming either.
const SHELL = (() => {
  for (const candidate of ['bash', 'sh']) {
    const probe = run(candidate, ['-c', 'exit 0'], { timeout: 30000 });
    if (!probe.error && probe.status === 0) return candidate;
  }
  return 'sh';
})();

// ── Consumer fixtures ───────────────────────────────────────────────────────────────────────
// Each real entry point is driven over a synthetic repository rather than over this one, so the
// evidence is deterministic and this suite never publishes anything. The rows each consumer is
// required to print are computed from the resolver itself, against the same fixture, so a
// consumer that re-implements the roster instead of resolving it cannot match them.

// `scripts/fast-full-sweep.js --repo <root>` reads <root>/scripts/{test-ci,test-all,e2e}.sh, so a
// synthetic root exercises the whole operational path with none of this repository's profiles.
// Every profile run appends to `log`: an empty log is proof that no test command was started.
//
// The fixture's own input metadata — the audit marker each profile writes when it is actually
// executed, in the order the coordinator is required to execute them. The stub profiles below
// are generated from this, and T5's expectation is read back from it.
const SWEEP_PROFILES = ['test-ci', 'test-all'];
function sweepFixture(tag, { integrationCommit = null } = {}) {
  const root = newRepo(tag);
  const log = logFile(tag);
  addSuite(root, 'old', { exit: 1 });
  addSuite(root, 'stale', { exit: 1 });
  commit(root, 'freeze the older suites');
  addSuite(root, 'new', { exit: 0 });
  addSuite(root, 'stale-next', { exit: 1 });
  const freezeCommit = commit(root, 'freeze the replacements');
  const recorded = integrationCommit === null ? freezeCommit : integrationCommit;
  writeContract(root, [entry('old', 'new', recorded), entry('stale', 'stale-next', recorded)]);
  const profile = (name, body) => write(root, `scripts/${name}`, `#!/bin/sh\nset -u\n${body}\n`);
  const audited = (marker, list) => [
    `if [ "\${1:-}" = --list ]; then printf '%s\\n' ${list}; exit 0; fi`,
    `echo "[fixture] ${marker} ran"`,
    `echo ${marker} >> "$FIXTURE_SWEEP_LOG"`,
  ].join('\n');
  profile(`${SWEEP_PROFILES[0]}.sh`, audited(SWEEP_PROFILES[0], 'test-unit.sh'));
  profile(`${SWEEP_PROFILES[1]}.sh`, audited(SWEEP_PROFILES[1],
    "'3 suites, in order:' test-unit.sh test-isolation.sh e2e.sh"));
  // The nested-isolation witness the coordinator insists on reading in scripts/e2e.sh.
  profile('e2e.sh', 'sh "$(dirname "$0")/test-isolation.sh"');
  profile('test-isolation.sh', 'exit 0');
  const candidate = commit(root, 'record the retirements beside the host profiles');
  return { root, log, freezeCommit, candidate, profiles: SWEEP_PROFILES.slice() };
}

function runSweep(fixture) {
  return run(process.execPath, [path.join(ROOT, 'scripts', 'fast-full-sweep.js'), '--repo', fixture.root],
    { cwd: ROOT, env: { ...process.env, FIXTURE_SWEEP_LOG: fixture.log } });
}

// An integration checkout with a real remote, the shape `scripts/freeze.js commit` publishes
// into: `old` is retired by `new`, `stale` is waiting for `stale-next`, and one further suite is
// on disk uncommitted for this freeze to gate and publish.
const FREEZE_ID = 'freeze-me';
function freezeFixture(tag, { integrationCommit = null } = {}) {
  const dir = tmp(tag);
  const bare = path.join(dir, 'remote.git');
  const target = path.join(dir, 'target');
  git(dir, 'init', '-q', '--bare', '-b', 'main', bare);
  git(dir, 'clone', '-q', bare, target);
  git(target, 'config', 'user.email', 'fixture@example.invalid');
  git(target, 'config', 'user.name', 'fixture');
  git(target, 'config', 'commit.gpgsign', 'false');
  git(target, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  fs.mkdirSync(path.join(target, 'tools'), { recursive: true });
  fs.copyFileSync(RUN_ACCEPTANCE, path.join(target, 'tools', 'run-acceptance.sh'));
  write(target, 'pipeline.config.json', `${JSON.stringify({
    verifyCommand: 'sh tools/run-acceptance.sh',
    regressionCommand: 'true',
    regressionPolicy: 'required',
    defaultBranch: 'main',
    frozenPaths: [],
  }, null, 2)}\n`);
  write(target, 'tests/acceptance/_control/test.js', "'use strict';\n");
  addSuite(target, 'old', { exit: 1 });
  addSuite(target, 'stale', { exit: 1 });
  commit(target, 'freeze the older suites');
  addSuite(target, 'new', { exit: 0 });
  addSuite(target, 'stale-next', { exit: 1 });
  const freezeCommit = commit(target, 'freeze the replacements');
  const recorded = integrationCommit === null ? freezeCommit : integrationCommit;
  writeContract(target, [entry('old', 'new', recorded), entry('stale', 'stale-next', recorded)]);
  commit(target, 'record the retirements');
  git(target, 'push', '-q', 'origin', 'main');
  // The suite this freeze exists to publish: red, never frozen, still only in the working tree.
  addSuite(target, FREEZE_ID, { exit: 1 });
  const config = path.join(dir, 'run.json');
  fs.writeFileSync(config, `${JSON.stringify({
    targetRepoPath: target,
    targetRepoRemote: bare,
    defaultBranch: 'main',
    image: 'fixture',
    allowHalfProven: true,
  }, null, 2)}\n`);
  return { dir, bare, target, config, freezeCommit, head: head(target), remoteHead: head(bare, 'main') };
}

function runFreeze(fixture) {
  return run(process.execPath,
    [path.join(ROOT, 'scripts', 'freeze.js'), 'commit', FREEZE_ID, '--config', fixture.config, '--allow-half-proven'],
    {
      cwd: fixture.dir,
      env: { ...process.env, PIPELINE_TESTING_FREEZE_GATE_SEAM: '1', FREEZE_GATE_CMD: 'sh tools/run-acceptance.sh' },
    });
}

// A pushed branch for `scripts/verify-pr.sh <repo> <branch>` to validate on the host. The
// resolver is copied in because hosted validation runs it out of the checkout under review,
// which is the only place it can be: verify-pr.sh cannot export or import anything.
function hostedFixture(tag, { integrationCommit = null } = {}) {
  const dir = tmp(tag);
  const bare = path.join(dir, 'remote.git');
  const target = path.join(dir, 'target');
  const log = logFile(tag);
  git(dir, 'init', '-q', '--bare', '-b', 'main', bare);
  git(dir, 'clone', '-q', bare, target);
  git(target, 'config', 'user.email', 'fixture@example.invalid');
  git(target, 'config', 'user.name', 'fixture');
  git(target, 'config', 'commit.gpgsign', 'false');
  git(target, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  fs.mkdirSync(path.join(target, 'tools'), { recursive: true });
  fs.copyFileSync(RUN_ACCEPTANCE, path.join(target, 'tools', 'run-acceptance.sh'));
  fs.mkdirSync(path.join(target, 'runner'), { recursive: true });
  // T15 has already required the resolver to exist before it builds this; the existence check is
  // here only so the fixture itself is buildable for inspection on a checkout that has none.
  if (fs.existsSync(RESOLVER_FILE)) {
    fs.copyFileSync(RESOLVER_FILE, path.join(target, 'runner', 'suite-supersession.js'));
  }
  write(target, 'pipeline.config.json', `${JSON.stringify({
    verifyCommand: 'sh tools/run-acceptance.sh',
    regressionCommand: 'true',
    regressionPolicy: 'required',
    defaultBranch: 'main',
    frozenPaths: [],
  }, null, 2)}\n`);
  write(target, 'tests/acceptance/_control/test.js', "'use strict';\n");
  addSuite(target, 'old', { exit: 1, ran: log });
  addSuite(target, 'kept', { exit: 0, ran: log });
  commit(target, 'freeze the older suites');
  addSuite(target, 'new', { exit: 0, ran: log });
  const freezeCommit = commit(target, 'freeze the replacement');
  const recorded = integrationCommit === null ? freezeCommit : integrationCommit;
  writeContract(target, [entry('old', 'new', recorded)]);
  commit(target, 'record the retirement');
  git(target, 'push', '-q', 'origin', 'main');
  return { dir, bare, target, log, freezeCommit };
}

// ── T1 / C1 ──────────────────────────────────────────────────────────────────────────────────
test('T1 C1 the canonical contract records suite, superseding issue, replacement suite, rationale and integration commit identity, and an absent contract is an empty retirement set rather than a refusal', () => {
  const resolver = RESOLVER();
  assert.strictEqual(resolver.CONTRACT_PATH, 'contracts/superseded-suites.json',
    `CONTRACT_PATH is not the canonical location: ${JSON.stringify(resolver.CONTRACT_PATH)}`);

  const f = supersessionRepo('t1');
  const read = resolver.readContract(f.root);
  assert.strictEqual(read.ok, true, JSON.stringify(read));
  assert.strictEqual(read.entries.length, 1, JSON.stringify(read.entries));
  const row = read.entries[0];
  assert.strictEqual(row.suite, 'old', JSON.stringify(row));
  assert.strictEqual(row.supersededBy, 'new', JSON.stringify(row));
  assert.strictEqual(row.replacementSuite, 'new', JSON.stringify(row));
  assert.strictEqual(typeof row.rationale === 'string' && row.rationale.trim().length > 0, true,
    `the contract lost its rationale: ${JSON.stringify(row)}`);
  assert.strictEqual(row.integrationCommit, f.freezeCommit,
    `the contract lost the integration commit identity: ${JSON.stringify(row)}`);
  assertDeepFrozen(read.entries, 'readContract().entries');

  // An absent contract is the ordinary state of every other checkout and of every fixture that
  // models one. It must not be a refusal, or every consumer fails closed on a repository that
  // has simply never retired anything.
  const bare = newRepo('t1-bare');
  addSuite(bare, 'only', { exit: 0 });
  commit(bare, 'freeze only');
  const none = resolver.readContract(bare);
  assert.strictEqual(none.ok, true, JSON.stringify(none));
  assert.deepStrictEqual([...none.entries], [], JSON.stringify(none.entries));
  const resolved = resolver.resolveSuites({ root: bare, integrationRef: 'main', runSuite: stub({}) });
  assert.strictEqual(resolved.ok, true, JSON.stringify(resolved));
  assert.deepStrictEqual([...resolved.active], ['only'], JSON.stringify(resolved.active));
  assert.deepStrictEqual([...resolved.superseded], [], JSON.stringify(resolved.superseded));
  assert.deepStrictEqual([...resolved.pending], [], JSON.stringify(resolved.pending));
});

// ── T2 / C1 ──────────────────────────────────────────────────────────────────────────────────
test('T2 C1 unknown fields, duplicate entries, cycles, missing suites, unfrozen replacements, later-but-containing, future or absent commits, self-supersession and malformed values all fail closed with no roster handed back', () => {
  const resolver = RESOLVER();
  const f = supersessionRepo('t2');
  const good = entry('old', 'new', f.freezeCommit);

  // A commit that exists but is not reachable from the integration branch: "future".
  git(f.root, 'checkout', '-q', '-b', 'sidecar');
  addSuite(f.root, 'sidecar-only', { exit: 0 });
  const futureCommit = commit(f.root, 'not on the integration branch');
  git(f.root, 'checkout', '-q', 'main');

  const absentCommit = ABSENT_COMMIT;
  const cases = [
    ['unknown top-level field', [good], { retiredSuites: ['old'] }, 'retiredSuites'],
    ['unknown entry field', [{ ...good, note: 'extra' }], {}, 'note'],
    ['duplicate entries', [good, { ...good, rationale: 'a second, contradictory claim.' }], {}, 'old'],
    ['self-supersession', [entry('old', 'old', f.freezeCommit)], {}, 'old'],
    ['missing superseded suite', [entry('never-frozen', 'new', f.freezeCommit)], {}, 'never-frozen'],
    ['missing replacement suite', [entry('old', 'never-frozen', f.freezeCommit)], {}, 'never-frozen'],
    ['unfrozen replacement', [entry('old', 'new', f.beforeReplacement)], {}, 'new'],
    // Every commit after the freeze still carries the replacement suite, so "contains it" is not
    // an identity: only the commit that INTRODUCED it says when the retirement became true.
    ['later commit that merely still contains the replacement', [entry('old', 'new', f.candidate)], {}, f.candidate],
    ['absent integration commit', [entry('old', 'new', absentCommit)], {}, absentCommit],
    ['future integration commit', [entry('old', 'new', futureCommit)], {}, futureCommit],
    ['empty rationale', [{ ...good, rationale: '   ' }], {}, 'old'],
    ['malformed integration commit', [{ ...good, integrationCommit: 'HEAD~1' }], {}, 'old'],
    ['supersessions is not an array', { nope: true }, {}, null],
    ['unknown contract version', [good], { version: 2 }, null],
  ];

  for (const [label, entries, extra, mustName] of cases) {
    if (Array.isArray(entries)) writeContract(f.root, entries, extra);
    else write(f.root, 'contracts/superseded-suites.json', `${JSON.stringify({ version: 1, supersessions: entries, ...extra }, null, 2)}\n`);
    const resolved = resolver.resolveSuites({ root: f.root, integrationRef: 'main', runSuite: stub({ new: true }) });
    assertRefusal(resolved, `resolveSuites with ${label}`, mustName);
  }

  // A cycle, in its own fixture so that every suite it names really exists and really was frozen
  // at the commit each entry records: the ONLY defect left is that the chain closes on itself.
  const ring = newRepo('t2-cycle');
  for (const id of ['a', 'b', 'c']) addSuite(ring, id, { exit: 0 });
  const ringCommit = commit(ring, 'freeze a, b and c together');
  writeContract(ring, [entry('a', 'b', ringCommit), entry('b', 'c', ringCommit), entry('c', 'a', ringCommit)]);
  commit(ring, 'record a cycle');
  assertRefusal(resolver.resolveSuites({ root: ring, integrationRef: 'main', runSuite: stub({ a: true, b: true, c: true }) }),
    'resolveSuites with a three-entry cycle', ['a', 'b', 'c']);

  // The same refusals must reach a consumer through the CLI, which is how verify-pr.sh sees them.
  writeContract(f.root, [entry('old', 'new', absentCommit)]);
  const cli = run(process.execPath, [RESOLVER_FILE, 'plan', '--repo', f.root], { cwd: ROOT });
  assert.notStrictEqual(cli.status, 0, `the CLI accepted an absent integration commit: ${cli.stdout}${cli.stderr}`);
  assert(`${cli.stdout}${cli.stderr}`.includes(absentCommit),
    `the CLI refusal does not name the absent commit: ${cli.stdout}${cli.stderr}`);
});

// ── T3 / C2, C5(activation timing) ───────────────────────────────────────────────────────────
test('T3 C2,C5(activation timing) supersession becomes effective only once the replacement suite is frozen on the integration branch and its implementation is present at the exact candidate, and the presence question is asked once per replacement', () => {
  const resolver = RESOLVER();
  const f = supersessionRepo('t3');

  // (a) Replacement frozen, implementation ABSENT at the candidate: not yet effective.
  const absent = stub({ new: false });
  const early = resolver.resolveSuites({ root: f.root, integrationRef: 'main', runSuite: absent });
  assert.strictEqual(early.ok, true, JSON.stringify(early));
  assert(early.active.includes('old'), `the retired suite left the active roster before its replacement was proven: ${JSON.stringify(early.active)}`);
  assert(early.active.includes('new'), JSON.stringify(early.active));
  assert.deepStrictEqual([...early.superseded], [], JSON.stringify(early.superseded));
  assert.strictEqual(early.pending.length, 1, JSON.stringify(early.pending));
  assert.strictEqual(early.pending[0].suite, 'old', JSON.stringify(early.pending[0]));
  assert.strictEqual(early.pending[0].replacementSuite, 'new', JSON.stringify(early.pending[0]));
  assert(typeof early.pending[0].reason === 'string' && early.pending[0].reason.trim().length > 0,
    `a pending retirement carries no reason: ${JSON.stringify(early.pending[0])}`);
  assert.deepStrictEqual(absent.calls, ['new'],
    `the candidate-presence seam was not consulted exactly once per replacement: ${JSON.stringify(absent.calls)}`);

  // (b) Implementation PRESENT at the candidate: effective.
  const present = stub({ new: true });
  const late = resolver.resolveSuites({ root: f.root, integrationRef: 'main', runSuite: present });
  assert.strictEqual(late.ok, true, JSON.stringify(late));
  assert.strictEqual(late.active.includes('old'), false, `a proven retirement left its suite active: ${JSON.stringify(late.active)}`);
  assert(late.active.includes('new'), JSON.stringify(late.active));
  assert.strictEqual(late.superseded.length, 1, JSON.stringify(late.superseded));
  assert.strictEqual(late.superseded[0].suite, 'old', JSON.stringify(late.superseded[0]));
  assert.strictEqual(late.superseded[0].supersededBy, 'new', JSON.stringify(late.superseded[0]));
  assert.strictEqual(late.superseded[0].integrationCommit, f.freezeCommit, JSON.stringify(late.superseded[0]));
  assert(typeof late.superseded[0].rationale === 'string' && late.superseded[0].rationale.trim().length > 0,
    JSON.stringify(late.superseded[0]));
  assert.deepStrictEqual([...late.pending], [], JSON.stringify(late.pending));
  assert.deepStrictEqual(present.calls, ['new'], JSON.stringify(present.calls));

  // (c) The replacement is NOT yet frozen on the integration branch the caller named, even
  // though it is present in the candidate tree and its implementation is proven. Fail closed:
  // "not yet frozen on integration" is never the same answer as "retired".
  git(f.root, 'branch', '-f', 'older-integration', f.beforeReplacement);
  const unfrozen = resolver.resolveSuites({ root: f.root, integrationRef: 'older-integration', runSuite: stub({ new: true }) });
  assertRefusal(unfrozen, 'resolveSuites against an integration ref predating the replacement freeze');
});

// ── T4 / C2 ──────────────────────────────────────────────────────────────────────────────────
test('T4 C2 a RED-baseline candidate still runs the older suite and reports the unproven retirement visibly, and an unanswerable presence probe fails closed rather than retiring anything', () => {
  const resolver = RESOLVER();
  const f = supersessionRepo('t4');

  // The RED baseline of the replacement's own proof: the superseding implementation is absent by
  // construction. The older suite must run there, and the retirement must be stated out loud —
  // a silent skip is precisely how the older behaviour gets hidden.
  const red = resolver.resolveSuites({ root: f.root, integrationRef: 'main', runSuite: stub({ new: false }) });
  assert.strictEqual(red.ok, true, JSON.stringify(red));
  assert(red.active.includes('old'), JSON.stringify(red.active));
  const pendingLines = red.report.filter((line) => /^pending\b/.test(line));
  assert.strictEqual(pendingLines.length, 1, `the unproven retirement was not reported: ${JSON.stringify(red.report)}`);
  assert(pendingLines[0].includes('old') && pendingLines[0].includes('new'),
    `the pending report names neither the retired suite nor its replacement: ${pendingLines[0]}`);
  assert.strictEqual(red.report.some((line) => /^superseded\b/.test(line)), false,
    `an unproven retirement was reported as superseded: ${JSON.stringify(red.report)}`);

  // A presence probe that cannot answer is not a licence to retire anything, and is not a
  // licence to quietly treat the retirement as absent either.
  const thrower = () => { throw new Error('probe could not run'); };
  const broken = resolver.resolveSuites({ root: f.root, integrationRef: 'main', runSuite: thrower });
  assertRefusal(broken, 'resolveSuites with a presence probe that throws', 'new');

  // Neither does a probe that answers with something that is not a verdict.
  const vague = resolver.resolveSuites({ root: f.root, integrationRef: 'main', runSuite: () => ({}) });
  assertRefusal(vague, 'resolveSuites with a presence probe that returns no verdict', 'new');
});

// ── T5 / C3 ──────────────────────────────────────────────────────────────────────────────────
test('T5 C3 the fast-full-sweep coordinator resolves the acceptance roster on its own operational path — reporting the fixture\'s superseded and pending rows, and refusing invalid resolver metadata before a single test profile starts — while the frozen test-all profile is left byte-identical', () => {
  const resolver = RESOLVER();
  assert.strictEqual(typeof resolver.resolveSuites, 'function', 'runner/suite-supersession.js does not export resolveSuites()');

  // (1) SINGLE SOURCE, not evidence of use. fast-full-sweep.js and freeze.js must hand back the
  // resolver ITSELF, so that the roster has exactly one implementation: a re-implementation, a
  // wrapper or a bound copy all fail this. What each consumer DOES with it is proven at runtime
  // below (and in T14/T15), because an export on its own proves only that it could.
  // fast-full-sweep.js is loaded in a child because today it runs main() at require time;
  // passing this also proves it stopped doing that.
  const probe = [
    'const path = require("path");',
    'const resolver = require(process.argv[2]);',
    'const out = [];',
    'for (const rel of ["scripts/fast-full-sweep.js", "scripts/freeze.js"]) {',
    '  const mod = require(path.join(process.argv[3], ...rel.split("/")));',
    '  out.push(rel + "=" + (mod.resolveAcceptanceRoster === resolver.resolveSuites ? "same" : "different"));',
    '}',
    'process.stdout.write(out.join("\\n"));',
  ].join('\n');
  const probeFile = path.join(tmp('t5-probe'), 'probe.js');
  fs.writeFileSync(probeFile, `${probe}\n`);
  const shared = run(process.execPath, [probeFile, RESOLVER_FILE, ROOT], { cwd: ROOT });
  assert.strictEqual(shared.status, 0,
    `loading the consumers alongside the resolver failed (exit ${shared.status}):\n${shared.stdout}\n${shared.stderr}`);
  assert.strictEqual(shared.stdout.trim(),
    'scripts/fast-full-sweep.js=same\nscripts/freeze.js=same',
    `a consumer does not export the shared resolver itself: ${shared.stdout}`);

  // (2) THE OPERATIONAL PATH ITSELF. The real coordinator is driven over a synthetic checkout
  // that carries its own profiles, its own suites and its own contract. The rows it has to print
  // are computed here from the resolver against that same fixture, so reporting them at all
  // means the roster was resolved from the contract in the run that just happened.
  const good = sweepFixture('t5-sweep');
  const expected = resolver.resolveSuites({ root: good.root });
  assert.strictEqual(expected.ok, true, `the coordinator fixture does not resolve: ${JSON.stringify(expected)}`);
  const supersededRows = expected.report.filter((line) => /^superseded\b/.test(line));
  const pendingRows = expected.report.filter((line) => /^pending\b/.test(line));
  assert.strictEqual(supersededRows.length, 1,
    `the coordinator fixture must offer one effective retirement: ${JSON.stringify(expected.report)}`);
  assert.strictEqual(pendingRows.length, 1,
    `the coordinator fixture must offer one retirement that is not yet effective: ${JSON.stringify(expected.report)}`);
  const requiredRows = [...supersededRows, ...pendingRows];

  const swept = runSweep(good);
  const sweptOut = text(swept);
  assert.strictEqual(swept.status, 0,
    `the coordinator did not complete over the fixture (exit ${swept.status}):\n${sweptOut}`);
  for (const row of requiredRows) {
    assert(reports(sweptOut, row),
      `the coordinator never reported the roster row ${JSON.stringify(row)} — a retirement it never `
      + `mentions is a retirement nobody sees:\n${sweptOut}`);
  }
  assert.deepStrictEqual(readLog(good.log), good.profiles,
    `the coordinator did not run the fixture's profiles exactly once each, in order: `
    + `${JSON.stringify(readLog(good.log))}\n${sweptOut}`);

  // (3) AND IT FAILS CLOSED FIRST. The same fixture with one unusable integration commit — a
  // well-formed contract naming a commit that is not in the repository. The coordinator must
  // refuse before it starts the profiles it coordinates, which the untouched profile log proves:
  // a sweep that runs the mandatory profile first and reads the roster afterwards has already
  // spent the run it was supposed to refuse.
  const broken = sweepFixture('t5-broken', { integrationCommit: ABSENT_COMMIT });
  const refused = runSweep(broken);
  const refusedOut = text(refused);
  assert.notStrictEqual(refused.status, 0,
    `the coordinator accepted an unusable retirement contract:\n${refusedOut}`);
  assert(refusedOut.includes(ABSENT_COMMIT),
    `the coordinator's refusal does not name the commit it could not use:\n${refusedOut}`);
  assert.deepStrictEqual(readLog(broken.log), [],
    `a test profile was started despite the refused roster: ${JSON.stringify(readLog(broken.log))}\n${refusedOut}`);

  // The `test-all` consumer, in the only reachable form this repository permits — see the SPEC
  // DEFECT note in this file's header. scripts/test-all.sh is frozen by pathspec AND pinned by
  // tests/acceptance/repo-djf.2/, so its position is carried by the coordinator that owns its
  // invocation — the one the run above just watched resolve the roster before invoking it.
  //
  // "Left byte-identical" is asked of Git, not of a digest typed into this suite: the script is
  // tracked at the candidate's HEAD and the working tree still matches what HEAD records for it,
  // and pipeline.config.json still declares the glob that makes it unreachable in the first place.
  const tracked = git(ROOT, 'ls-tree', '-r', '--name-only', 'HEAD', '--', 'scripts/test-all.sh');
  assert.strictEqual(tracked.status, 0, `git could not read HEAD for scripts/test-all.sh: ${tracked.stderr}`);
  assert(String(tracked.stdout || '').split(/\r?\n/).map((line) => line.trim()).includes('scripts/test-all.sh'),
    `scripts/test-all.sh is not tracked at the candidate's HEAD: ${tracked.stdout}${tracked.stderr}`);
  const edited = git(ROOT, 'diff', '--quiet', 'HEAD', '--', 'scripts/test-all.sh');
  assert.strictEqual(edited.status, 0,
    'scripts/test-all.sh was edited; it is a frozen path and repo-djf.2 pins its bytes');
  const frozenPaths = JSON.parse(fs.readFileSync(path.join(ROOT, 'pipeline.config.json'), 'utf8')).frozenPaths;
  assert(Array.isArray(frozenPaths) && frozenPaths.includes('scripts/test-*.sh'),
    `pipeline.config.json no longer freezes scripts/test-*.sh: ${JSON.stringify(frozenPaths)}`);
});

// ── T6 / C3 ──────────────────────────────────────────────────────────────────────────────────
test('T6 C3 no mutable roster is copied among consumers: every resolution is deeply frozen, each call hands back fresh objects, and no consumer carries a retirement roster of its own', () => {
  const resolver = RESOLVER();
  const f = supersessionRepo('t6');

  const first = resolver.resolveSuites({ root: f.root, integrationRef: 'main', runSuite: stub({ new: true }) });
  assert.strictEqual(first.ok, true, JSON.stringify(first));
  assertDeepFrozen(first, 'resolveSuites() result');

  const second = resolver.resolveSuites({ root: f.root, integrationRef: 'main', runSuite: stub({ new: true }) });
  assert.strictEqual(second.ok, true, JSON.stringify(second));
  assert.notStrictEqual(second.active, first.active, 'two consumers were handed the same active roster array');
  assert.notStrictEqual(second.superseded, first.superseded, 'two consumers were handed the same superseded roster array');
  assert.notStrictEqual(second.report, first.report, 'two consumers were handed the same report array');
  assert.deepStrictEqual([...second.active], [...first.active], 'two calls disagreed about the active roster');

  // One consumer cannot reach into another's view, whether it pushes, assigns or deletes.
  for (const mutate of [() => first.active.push('smuggled'), () => { first.active[0] = 'smuggled'; },
    () => { first.superseded[0].suite = 'smuggled'; }, () => { delete first.superseded[0].rationale; }]) {
    try { mutate(); } catch { /* frozen objects throw in strict mode; either way nothing may change */ }
  }
  const third = resolver.resolveSuites({ root: f.root, integrationRef: 'main', runSuite: stub({ new: true }) });
  assert.strictEqual(third.active.includes('smuggled'), false, `a mutation leaked into a later resolution: ${JSON.stringify(third.active)}`);
  assert.deepStrictEqual([...third.active], [...second.active], 'a mutation changed what a later consumer saw');
  assert.strictEqual(third.superseded[0].suite, 'old', JSON.stringify(third.superseded[0]));
  assert(typeof third.superseded[0].rationale === 'string' && third.superseded[0].rationale.trim().length > 0,
    'a deleted rationale survived into a later resolution');

  // The roster lives in the contract and nowhere else: neither the resolver nor any consumer may
  // name the suites it retires.
  for (const rel of ['runner/suite-supersession.js', 'scripts/fast-full-sweep.js',
    'scripts/verify-pr.sh', 'scripts/freeze.js']) {
    const source = fs.readFileSync(path.join(ROOT, ...rel.split('/')), 'utf8');
    for (const id of [RETIRED, REPLACEMENT]) {
      assert.strictEqual(source.includes(id), false, `${rel} hard-codes the retirement roster entry ${id}`);
    }
  }
});

// ── T7 / C4 ──────────────────────────────────────────────────────────────────────────────────
test('T7 C4 the repository\'s own contract retires the repo-7a0 post-launch-persistence assertions, only by repo-djf.40, with a rationale and with the exact commit that froze repo-djf.40 — derived from Git history, not any later ancestor that still contains it', () => {
  const resolver = RESOLVER();
  assert(fs.existsSync(CONTRACT_FILE), `contracts/superseded-suites.json does not exist: ${CONTRACT_FILE}`);

  const read = resolver.readContract(ROOT);
  assert.strictEqual(read.ok, true, `this repository's own contract does not validate: ${JSON.stringify(read)}`);

  const forRetired = read.entries.filter((row) => row.suite === RETIRED);
  assert.strictEqual(forRetired.length, 1,
    `${RETIRED} is retired ${forRetired.length} times, not exactly once: ${JSON.stringify(forRetired)}`);
  const row = forRetired[0];
  assert.strictEqual(row.supersededBy, REPLACEMENT,
    `${RETIRED} is retired by ${JSON.stringify(row.supersededBy)} rather than ${REPLACEMENT}`);
  assert.strictEqual(row.replacementSuite, REPLACEMENT, JSON.stringify(row));
  assert(/launch|dispos|persist/i.test(row.rationale),
    `the rationale does not say what was retired — the post-launch persistence assertions: ${JSON.stringify(row.rationale)}`);

  // Nothing retires repo-djf.40, and repo-7a0 retires nothing: the retirement is one-directional
  // and this is the only claim made about either suite.
  assert.strictEqual(read.entries.some((e) => e.suite === REPLACEMENT), false,
    `${REPLACEMENT} is itself recorded as retired: ${JSON.stringify(read.entries)}`);
  assert.strictEqual(read.entries.some((e) => e.suite !== RETIRED && e.replacementSuite === RETIRED), false,
    `${RETIRED} is recorded as a replacement for another suite: ${JSON.stringify(read.entries)}`);

  // The integration commit identity is real, reachable, and is THE commit that froze
  // repo-djf.40 — derived here from this repository's own history rather than typed in, because
  // a literal would be a second copy of the fact and would rot the moment history is rewritten.
  assert(/^[0-9a-f]{40}$/.test(String(row.integrationCommit)),
    `the integration commit identity is not a 40-hex commit: ${JSON.stringify(row.integrationCommit)}`);
  const type = git(ROOT, 'cat-file', '-t', row.integrationCommit);
  assert.strictEqual(String(type.stdout || '').trim(), 'commit',
    `the integration commit does not exist in this repository: ${row.integrationCommit}`);
  const ancestor = git(ROOT, 'merge-base', '--is-ancestor', row.integrationCommit, 'HEAD');
  assert.strictEqual(ancestor.status, 0,
    `the integration commit ${row.integrationCommit} is not an ancestor of the candidate under validation`);

  // The derivation: the earliest commit reachable from the candidate that ADDED each of the
  // files a frozen suite cannot be without. A freeze lands them together, so the two answers
  // must agree; if they ever stop agreeing, this says so rather than picking one.
  const introduced = new Map();
  for (const name of ['guard.js', 'test.js']) {
    const rel = `tests/acceptance/${REPLACEMENT}/${name}`;
    const added = git(ROOT, 'log', '--diff-filter=A', '--format=%H', 'HEAD', '--', rel);
    assert.strictEqual(added.status, 0, `git could not read the history of ${rel}: ${added.stderr}`);
    const commits = String(added.stdout || '').trim().split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    assert(commits.length > 0, `Git history records no commit that added ${rel}`);
    introduced.set(rel, commits[commits.length - 1]);            // the earliest such commit
  }
  const derived = [...new Set(introduced.values())];
  assert.strictEqual(derived.length, 1,
    `repo-djf.40's required files were not introduced by one freeze commit: ${JSON.stringify([...introduced])}`);
  const freezeCommit = derived[0];
  for (const name of ['guard.js', 'test.js']) {
    const at = git(ROOT, 'cat-file', '-e', `${freezeCommit}:tests/acceptance/${REPLACEMENT}/${name}`);
    assert.strictEqual(at.status, 0,
      `tests/acceptance/${REPLACEMENT}/${name} is not in the derived freeze commit ${freezeCommit}`);
  }
  const parents = String(git(ROOT, 'rev-list', '--parents', '-n', '1', freezeCommit).stdout || '')
    .trim().split(/\s+/).slice(1);
  for (const parent of parents) {
    const before = git(ROOT, 'cat-file', '-e', `${parent}:tests/acceptance/${REPLACEMENT}/test.js`);
    assert.notStrictEqual(before.status, 0,
      `${freezeCommit} is not where ${REPLACEMENT} was introduced — its parent ${parent} already carried it`);
  }

  // Non-vacuous: later commits carry repo-djf.40 too, so "an ancestor that contains the suite"
  // would have many answers and this has exactly one. THE recorded identity must be the freeze.
  const laterCount = Number(String(git(ROOT, 'rev-list', '--count', `${freezeCommit}..HEAD`).stdout || '0').trim());
  assert(laterCount > 0,
    `the candidate adds no commit after ${REPLACEMENT} was frozen, so this check cannot tell the `
    + 'freeze commit from a later one — rebase the candidate onto the integration branch');
  assert.strictEqual(row.integrationCommit, freezeCommit,
    `the contract records ${row.integrationCommit}, which is not the commit that froze ${REPLACEMENT} `
    + `(${freezeCommit}); ${laterCount} later commit(s) also carry that suite and none of them is its freeze`);
});

// ── T8 / C4, C5(direct historical execution) ─────────────────────────────────────────────────
test('T8 C4,C5(direct historical execution) a retired suite is never edited, moved or deleted and stays directly runnable through the frozen acceptance runner, while the active sweep on the corrected candidate is green', () => {
  const resolver = RESOLVER();
  const ranLog = path.join(tmp('t8-log'), 'ran.log');
  // `old` fails at the corrected candidate — that is the contradiction being retired — and `new`
  // passes there.
  const f = supersessionRepo('t8', { oldExit: 1, newExit: 0, ran: ranLog });

  const before = snapshotTree(path.join(f.root, 'tests', 'acceptance'));
  // No injected seam here: the real presence probe runs the replacement suite at the candidate.
  const resolved = resolver.resolveSuites({ root: f.root, integrationRef: 'main' });
  assert.strictEqual(resolved.ok, true, JSON.stringify(resolved));
  assert.strictEqual(snapshotTree(path.join(f.root, 'tests', 'acceptance')), before,
    'resolving the roster edited, moved or removed something under tests/acceptance/');
  assert.strictEqual(resolved.superseded.length, 1, JSON.stringify(resolved.superseded));
  assert.strictEqual(resolved.superseded[0].suite, 'old', JSON.stringify(resolved.superseded[0]));
  assert.strictEqual(resolved.active.includes('old'), false, JSON.stringify(resolved.active));

  // The active sweep on the corrected candidate is green — and it is green because the retired
  // suite was retired, not because anything claimed it passed.
  for (const id of resolved.active) {
    const suite = run('sh', ['tools/run-acceptance.sh', `tests/acceptance/${id}/`], { cwd: f.root });
    assert.strictEqual(suite.status, 0,
      `the active sweep is not green on the corrected candidate: ${id} exited ${suite.status}\n${suite.stdout}\n${suite.stderr}`);
  }

  // The retired suite is still there, byte for byte, and still runs directly through the frozen
  // runner with its own historical verdict — unchanged and unhidden.
  fs.writeFileSync(ranLog, '');
  const direct = run('sh', ['tools/run-acceptance.sh', 'tests/acceptance/old/'], { cwd: f.root });
  assert.strictEqual(fs.readFileSync(ranLog, 'utf8').includes('old'), true,
    `the retired suite did not actually execute when run directly: ${direct.stdout}${direct.stderr}`);
  assert.notStrictEqual(direct.status, 0,
    'running the retired suite directly reported its historical failure as a pass');
  assert.strictEqual(snapshotTree(path.join(f.root, 'tests', 'acceptance')), before,
    'running the retired suite directly changed the frozen tree');
});

// ── T9 / C5(chained supersession) ────────────────────────────────────────────────────────────
test('T9 C5(chained supersession) a chain of retirements resolves to its terminal replacement: every link leaves the active roster only once that terminal suite is proven at the candidate', () => {
  const resolver = RESOLVER();

  // The fixture's own input metadata, and the only place the planted chain's shape is written
  // down: `a` retired by `b`, `b` retired by `c`, so `c` is the terminal replacement. Every
  // roster expectation below is computed from exactly these links, so a longer chain here stays
  // a change to this table alone.
  const links = [['a', 'b'], ['b', 'c']];
  const terminal = links[links.length - 1][1];
  const retiredSuites = links.map(([suite]) => suite).sort();
  const allSuites = [...new Set(links.flat())].sort();

  const root = newRepo('t9');
  addSuite(root, links[0][0], { exit: 1 });
  commit(root, `freeze ${links[0][0]}`);
  const entries = links.map(([suite, replacement]) => {
    // Only the terminal replacement passes at the candidate; every intermediate link carries the
    // failing verdict that got it retired in turn.
    addSuite(root, replacement, { exit: replacement === terminal ? 0 : 1 });
    return entry(suite, replacement, commit(root, `freeze ${replacement}`));
  });
  writeContract(root, entries);
  commit(root, 'record the chain');

  // Terminal replacement proven: every link retires, only the terminal suite stays active. The
  // intermediate links answer "absent" — a chain may only be walked to its terminus.
  const proven = stub({ [terminal]: true });
  const done = resolver.resolveSuites({ root, integrationRef: 'main', runSuite: proven });
  assert.strictEqual(done.ok, true, JSON.stringify(done));
  assert.deepStrictEqual([...done.active], [terminal], JSON.stringify(done.active));
  assert.deepStrictEqual(done.superseded.map((r) => r.suite).sort(), retiredSuites, JSON.stringify(done.superseded));
  for (const [suite, replacement] of links) {
    const row = done.superseded.find((r) => r.suite === suite);
    assert(row, `${suite} did not retire once its terminal replacement was proven: ${JSON.stringify(done.superseded)}`);
    assert.strictEqual(row.replacementSuite, replacement,
      'a chained retirement rewrote the replacement it actually records');
  }
  assert.deepStrictEqual([...done.pending], [], JSON.stringify(done.pending));

  // Terminal replacement NOT proven: nothing retires, and the whole chain is reported pending.
  // An intermediate link must never be retired on the strength of a link that is itself retired,
  // so every non-terminal replacement answers "present" here and must still buy nothing.
  const unproven = stub(Object.fromEntries(allSuites.map((id) => [id, id !== terminal])));
  const waiting = resolver.resolveSuites({ root, integrationRef: 'main', runSuite: unproven });
  assert.strictEqual(waiting.ok, true, JSON.stringify(waiting));
  assert.deepStrictEqual([...waiting.active], allSuites, JSON.stringify(waiting.active));
  assert.deepStrictEqual([...waiting.superseded], [], JSON.stringify(waiting.superseded));
  assert.deepStrictEqual(waiting.pending.map((r) => r.suite).sort(), retiredSuites, JSON.stringify(waiting.pending));
});

// ── T10 / C5(Windows path/case behaviour) ────────────────────────────────────────────────────
test('T10 C5(Windows path/case) suite ids are bare directory names spelled exactly as they sit on disk: a case-folded, separator-bearing or traversing id fails closed even where the filesystem would happily open it', () => {
  const resolver = RESOLVER();
  const f = supersessionRepo('t10');

  // On the case-insensitive reference host `tests/acceptance/OLD/` opens the real directory. It is
  // still not the suite's name, and a roster that folded case would run or retire something the
  // contract never named.
  const folded = fs.existsSync(path.join(f.root, 'tests', 'acceptance', 'OLD'));
  writeContract(f.root, [entry('OLD', 'new', f.freezeCommit)]);
  assertRefusal(resolver.resolveSuites({ root: f.root, integrationRef: 'main', runSuite: stub({ new: true }) }),
    `resolveSuites with a case-folded suite id (host folds case: ${folded})`, 'OLD');

  for (const bad of ['tests/acceptance/old', 'old/', '.\\old', 'old\\', '..\\old', '../old', '.', '..', '', 'C:\\old']) {
    writeContract(f.root, [entry(bad, 'new', f.freezeCommit)]);
    assertRefusal(resolver.resolveSuites({ root: f.root, integrationRef: 'main', runSuite: stub({ new: true }) }),
      `resolveSuites with the suite id ${JSON.stringify(bad)}`);
    writeContract(f.root, [entry('old', bad, f.freezeCommit)]);
    assertRefusal(resolver.resolveSuites({ root: f.root, integrationRef: 'main', runSuite: stub({ new: true }) }),
      `resolveSuites with the replacement suite id ${JSON.stringify(bad)}`);
  }

  // The roster itself is reported in bare suite-id form, never as a host path, so no consumer has
  // to re-derive separators for its own platform.
  writeContract(f.root, [entry('old', 'new', f.freezeCommit)]);
  const ok = resolver.resolveSuites({ root: f.root, integrationRef: 'main', runSuite: stub({ new: true }) });
  assert.strictEqual(ok.ok, true, JSON.stringify(ok));
  for (const id of ok.active) {
    assert(/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id), `the active roster carries a path rather than a suite id: ${JSON.stringify(id)}`);
  }
  assert.strictEqual(ok.report.join('\n').includes(f.root), false,
    `the roster report leaked the host path of the candidate: ${ok.report.join('\n')}`);
});

// ── T11 / C5(stale or forged metadata, planted contradiction) ────────────────────────────────
test('T11 C5(stale/forged metadata, planted contradiction) a retirement whose recorded commit predates or postdates the freeze of its replacement, whose retired suite no longer matches the candidate\'s committed bytes, or which contradicts another entry, fails closed and names what it caught', () => {
  const resolver = RESOLVER();

  // (a) FORGED: a real, reachable commit that never carried the replacement suite. The claim is
  // well-formed and the commit resolves; only actually looking inside it catches this.
  const forged = supersessionRepo('t11-forged');
  writeContract(forged.root, [entry('old', 'new', forged.beforeReplacement)]);
  assertRefusal(resolver.resolveSuites({ root: forged.root, integrationRef: 'main', runSuite: stub({ new: true }) }),
    'resolveSuites with a forged integration commit', [forged.beforeReplacement]);

  // (a2) STALE THE OTHER WAY: a real, reachable commit that DOES carry the replacement suite,
  // but is not the commit that froze it — every commit after the freeze looks like this, so a
  // resolver that accepts "contains it" accepts an identity that dates nothing. The freeze
  // commit in the same fixture is accepted, which is what makes this a distinction and not a ban.
  const drifted = supersessionRepo('t11-later');
  write(drifted.root, 'docs/notes.md', 'work that happened after the freeze\n');
  const later = commit(drifted.root, 'a later commit that still carries the replacement');
  assert.notStrictEqual(later, drifted.freezeCommit, 'the fixture did not advance past the freeze commit');
  const carries = git(drifted.root, 'cat-file', '-e', `${later}:tests/acceptance/new/test.js`);
  assert.strictEqual(carries.status, 0, 'the later fixture commit does not carry the replacement suite');
  writeContract(drifted.root, [entry('old', 'new', later)]);
  assertRefusal(resolver.resolveSuites({ root: drifted.root, integrationRef: 'main', runSuite: stub({ new: true }) }),
    'resolveSuites with a later commit that merely still contains the replacement', [later]);
  writeContract(drifted.root, [entry('old', 'new', drifted.freezeCommit)]);
  const exact = resolver.resolveSuites({ root: drifted.root, integrationRef: 'main', runSuite: stub({ new: true }) });
  assert.strictEqual(exact.ok, true,
    `the exact freeze commit was refused in the same fixture: ${JSON.stringify(exact)}`);
  assert.deepStrictEqual(exact.superseded.map((r) => r.suite), ['old'], JSON.stringify(exact.superseded));

  // (b) STALE / PLANTED: the retired suite's bytes in the candidate tree no longer match the
  // bytes the candidate committed. A retirement is a statement about immutable history; if that
  // history has been edited under it, the statement is not checkable and must not be believed.
  const tampered = supersessionRepo('t11-tampered');
  const clean = resolver.resolveSuites({ root: tampered.root, integrationRef: 'main', runSuite: stub({ new: true }) });
  assert.strictEqual(clean.ok, true, `the untampered fixture did not resolve: ${JSON.stringify(clean)}`);
  fs.appendFileSync(path.join(tampered.root, 'tests', 'acceptance', 'old', 'test.js'), '// planted\n');
  assertRefusal(resolver.resolveSuites({ root: tampered.root, integrationRef: 'main', runSuite: stub({ new: true }) }),
    'resolveSuites with a retired suite edited out from under its retirement', 'old');

  // (c) PLANTED CONTRADICTION: two entries that retire each other. Both are individually
  // well-formed, both name real suites and real commits, and together they say nothing at all.
  const mutual = supersessionRepo('t11-mutual');
  writeContract(mutual.root, [entry('old', 'new', mutual.freezeCommit), entry('new', 'old', mutual.freezeCommit)]);
  assertRefusal(resolver.resolveSuites({ root: mutual.root, integrationRef: 'main', runSuite: stub({ new: true, old: true }) }),
    'resolveSuites with two entries retiring each other', ['old', 'new']);
});

// ── T12 / C5(reporting) ──────────────────────────────────────────────────────────────────────
test('T12 C5(reporting) every roster row is reported on one visible line — active, superseded with its replacement, rationale and integration commit, or pending with its reason — and the CLI prints exactly that report', () => {
  const resolver = RESOLVER();
  const root = newRepo('t12');

  // The fixture's own input metadata: each planted suite, the verdict it carries at the candidate,
  // and the older suite it retires (if any). No injected seam here, so `exit` IS the presence
  // answer — a replacement that passes proves its retirement, one that fails leaves it pending —
  // and every roster and report expectation below is computed from this table.
  const planted = [
    { id: 'kept', exit: 0, retires: null },
    { id: 'gone', exit: 1, retires: null },
    { id: 'waiting', exit: 1, retires: null },
    { id: 'gone-next', exit: 0, retires: 'gone' },
    { id: 'waiting-next', exit: 1, retires: 'waiting' },
  ];
  const olderSuites = planted.filter((row) => row.retires === null);
  const replacements = planted.filter((row) => row.retires !== null);
  const effective = replacements.filter((row) => row.exit === 0);
  const notYetEffective = replacements.filter((row) => row.exit !== 0);

  for (const row of olderSuites) addSuite(root, row.id, { exit: row.exit });
  commit(root, 'freeze the older suites');
  for (const row of replacements) addSuite(root, row.id, { exit: row.exit });
  const freeze = commit(root, 'freeze the replacements');
  writeContract(root, replacements.map((row) => entry(row.retires, row.id, freeze,
    { rationale: `per-launch disposal replaces post-launch persistence in ${row.retires}.` })));
  commit(root, 'record the retirements');

  const resolved = resolver.resolveSuites({ root, integrationRef: 'main' });
  assert.strictEqual(resolved.ok, true, JSON.stringify(resolved));
  const retired = effective.map((row) => row.retires);
  assert.deepStrictEqual([...resolved.active].sort(),
    planted.map((row) => row.id).filter((id) => !retired.includes(id)).sort(),
    JSON.stringify(resolved.active));

  for (const line of resolved.report) {
    assert.strictEqual(typeof line, 'string', `a report row is not a string: ${JSON.stringify(line)}`);
    assert.strictEqual(line.includes('\n'), false, `a report row spans more than one line: ${JSON.stringify(line)}`);
    assert(/^(active|superseded|pending)\b/.test(line), `a report row carries no row kind: ${JSON.stringify(line)}`);
  }
  const kinds = (kind) => resolved.report.filter((line) => new RegExp(`^${kind}\\b`).test(line));
  assert.strictEqual(kinds('active').length, resolved.active.length,
    `active rows and active roster disagree: ${JSON.stringify(resolved.report)}`);

  const supersededLines = kinds('superseded');
  assert.strictEqual(supersededLines.length, effective.length, JSON.stringify(resolved.report));
  for (const replacement of effective) {
    const row = resolved.superseded.find((r) => r.suite === replacement.retires);
    assert(row, `${replacement.retires} is not reported superseded: ${JSON.stringify(resolved.superseded)}`);
    const line = supersededLines.find((l) => l.includes(replacement.retires) && l.includes(replacement.id));
    assert(line, `no superseded row names ${replacement.retires} and its replacement ${replacement.id}: `
      + JSON.stringify(supersededLines));
    for (const needle of [row.rationale, freeze]) {
      assert(line.includes(needle), `the superseded row does not state ${JSON.stringify(needle)}: ${line}`);
    }
  }

  const pendingLines = kinds('pending');
  assert.strictEqual(pendingLines.length, notYetEffective.length, JSON.stringify(resolved.report));
  assert.strictEqual(resolved.pending.length, notYetEffective.length, JSON.stringify(resolved.pending));
  for (const replacement of notYetEffective) {
    const row = resolved.pending.find((r) => r.suite === replacement.retires);
    assert(row, `${replacement.retires} is not reported pending: ${JSON.stringify(resolved.pending)}`);
    assert.strictEqual(row.replacementSuite, replacement.id, JSON.stringify(row));
    const line = pendingLines.find((l) => l.includes(replacement.retires) && l.includes(replacement.id));
    assert(line, `no pending row names ${replacement.retires} and its replacement ${replacement.id}: `
      + JSON.stringify(pendingLines));
    assert(line.includes(row.reason),
      `the pending row does not state the reason the retirement is not yet effective: ${line}`);
  }

  // A consumer that can only read stdout sees the same report, unabridged.
  const cli = run(process.execPath, [RESOLVER_FILE, 'plan', '--repo', root], { cwd: ROOT });
  assert.strictEqual(cli.status, 0, `the resolver CLI refused a valid contract: ${cli.stdout}${cli.stderr}`);
  const printed = cli.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const line of resolved.report) {
    assert(printed.includes(line.trim()), `the CLI did not print the report row ${JSON.stringify(line)}:\n${cli.stdout}`);
  }
});

// ── T13 / C5(active acceptance suites green) ─────────────────────────────────────────────────
test('T13 C5(active acceptance suites) this repository resolves to an active roster covering every acceptance suite that is not effectively retired, and the sibling suite this change reaches into is still green', () => {
  const resolver = RESOLVER();
  const acceptance = path.join(ROOT, 'tests', 'acceptance');
  const onDisk = fs.readdirSync(acceptance, { withFileTypes: true })
    .filter((item) => item.isDirectory() && item.name !== '_control')
    .map((item) => item.name).sort();

  const resolved = resolver.resolveSuites({ root: ROOT });
  assert.strictEqual(resolved.ok, true, `this repository's own roster does not resolve: ${JSON.stringify(resolved)}`);
  const accounted = [...resolved.active, ...resolved.superseded.map((row) => row.suite)].sort();
  assert.deepStrictEqual(accounted, onDisk,
    'the resolved roster does not account for every acceptance suite directory exactly once');
  assert.strictEqual(new Set(resolved.active).size, resolved.active.length,
    `the active roster repeats a suite: ${JSON.stringify(resolved.active)}`);
  for (const row of resolved.superseded) {
    assert.strictEqual(resolved.active.includes(row.suite), false,
      `${row.suite} is reported both active and retired`);
    assert(resolved.active.includes(row.replacementSuite) || resolved.superseded.some((r) => r.suite === row.replacementSuite),
      `${row.suite}'s replacement ${row.replacementSuite} is in neither roster`);
  }

  // repo-djf.2 is the frozen contract for the fast-full-sweep coordinator C3 rewires, and it
  // independently pins the canonical profile bytes. It must still pass in full.
  for (const name of ['guard.js', 'test.js']) {
    const file = path.join(acceptance, 'repo-djf.2', name);
    assert(fs.existsSync(file), `sibling suite file is missing: ${file}`);
    const result = run(process.execPath, [file], { cwd: ROOT, timeout: 600000 });
    assert.strictEqual(result.status, 0,
      `tests/acceptance/repo-djf.2/${name} did not pass (exit ${JSON.stringify(result.status)}) — a valid repo-djf.48 `
      + `fix must leave the coordinator's own frozen contract intact\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`);
  }
});

// ── T14 / C3 ─────────────────────────────────────────────────────────────────────────────────
test('T14 C3 exact-head publication resolves the roster on its own operational path: `freeze commit` reports the integration checkout\'s superseded and pending rows in the run that publishes, and refuses invalid resolver metadata before the gate writes a receipt and before anything is staged, committed or pushed', () => {
  const resolver = RESOLVER();

  const f = freezeFixture('t14-freeze');
  const expected = resolver.resolveSuites({ root: f.target });
  assert.strictEqual(expected.ok, true, `the publication fixture does not resolve: ${JSON.stringify(expected)}`);
  const supersededRows = expected.report.filter((line) => /^superseded\b/.test(line));
  const pendingRows = expected.report.filter((line) => /^pending\b/.test(line));
  assert.strictEqual(supersededRows.length, 1,
    `the publication fixture must offer one effective retirement: ${JSON.stringify(expected.report)}`);
  assert.strictEqual(pendingRows.length, 1,
    `the publication fixture must offer one retirement that is not yet effective: ${JSON.stringify(expected.report)}`);
  const requiredRows = [...supersededRows, ...pendingRows];

  // A real publication: the gate runs, the suite is committed, and the exact HEAD reaches the
  // remote. Anything the command printed on the way is therefore something it printed WHILE
  // publishing, not instead of publishing.
  const published = runFreeze(f);
  const out = text(published);
  assert.notStrictEqual(head(f.target), f.head,
    `the freeze never reached publication over the fixture, so its ordering proves nothing `
    + `(exit ${published.status}):\n${out}`);
  assert.notStrictEqual(head(f.bare, 'main'), f.remoteHead,
    `the freeze commit never reached the remote integration branch:\n${out}`);
  for (const row of requiredRows) {
    assert(reports(out, row),
      `the publication path never reported the roster row ${JSON.stringify(row)} — the operator who `
      + `just published sees nothing about what is retired:\n${out}`);
  }

  // The same fixture with one unusable integration commit. Publication is a one-way door, so the
  // refusal has to arrive before the first mutation of any kind: no receipt written into the
  // suite by the gate, nothing staged, no commit, no push.
  const bad = freezeFixture('t14-refused', { integrationCommit: ABSENT_COMMIT });
  const before = snapshotTree(path.join(bad.target, 'tests'));
  const refused = runFreeze(bad);
  const refusedOut = text(refused);
  assert.notStrictEqual(refused.status, 0,
    `the publication path accepted an unusable retirement contract:\n${refusedOut}`);
  assert(refusedOut.includes(ABSENT_COMMIT),
    `the refusal does not name the commit it could not use:\n${refusedOut}`);
  assert.strictEqual(head(bad.target), bad.head,
    `the integration checkout moved despite the refusal:\n${refusedOut}`);
  assert.strictEqual(head(bad.bare, 'main'), bad.remoteHead,
    `the remote integration branch moved despite the refusal:\n${refusedOut}`);
  const staged = String(git(bad.target, 'diff', '--cached', '--name-only').stdout || '').trim();
  assert.strictEqual(staged, '', `paths were staged despite the refusal: ${JSON.stringify(staged)}\n${refusedOut}`);
  assert.strictEqual(snapshotTree(path.join(bad.target, 'tests')), before,
    'the refusal arrived after the gate had already written into the suite — the roster is being '
    + `resolved too late to be a gate on publication:\n${refusedOut}`);
});

// ── T15 / C3 ─────────────────────────────────────────────────────────────────────────────────
test('T15 C3 hosted validation enumerates the active roster through the shared CLI: the retired suite is reported where a reviewer reads it rather than re-run, and a resolver refusal blocks the verification instead of passing it', () => {
  const resolver = RESOLVER();
  const verifyPr = path.join(ROOT, 'scripts', 'verify-pr.sh');
  assert(fs.existsSync(verifyPr), 'scripts/verify-pr.sh is missing');

  const f = hostedFixture('t15-hosted');
  const expected = resolver.resolveSuites({ root: f.target });
  assert.strictEqual(expected.ok, true, `the hosted fixture does not resolve: ${JSON.stringify(expected)}`);
  const supersededRows = expected.report.filter((line) => /^superseded\b/.test(line));
  assert.strictEqual(supersededRows.length, 1,
    `the hosted fixture must offer exactly one retirement: ${JSON.stringify(expected.report)}`);
  // The probe above ran the replacement suite; start the execution record from here so it
  // answers only for what hosted validation itself chose to run.
  fs.writeFileSync(f.log, '');

  const hosted = run(SHELL, [verifyPr, f.target, 'main'], { cwd: ROOT, timeout: 900000 });
  const out = text(hosted);
  assert.strictEqual(hosted.status, 0,
    `hosted validation did not pass over a clean fixture branch (exit ${hosted.status}):\n${out}`);
  for (const row of supersededRows) {
    assert(reports(out, row),
      `hosted validation never reported the retirement row ${JSON.stringify(row)} — "ALREADY red at `
      + `the fork point" is exactly the silence this contract exists to end:\n${out}`);
  }
  const ran = readLog(f.log);
  assert(ran.includes('kept') && ran.includes('new'),
    `hosted validation did not run the active suites: ${JSON.stringify(ran)}\n${out}`);
  assert.strictEqual(ran.includes('old'), false,
    `hosted validation re-ran the retired suite instead of reporting it: ${JSON.stringify(ran)}\n${out}`);

  const bad = hostedFixture('t15-refused', { integrationCommit: ABSENT_COMMIT });
  const blocked = run(SHELL, [verifyPr, bad.target, 'main'], { cwd: ROOT, timeout: 900000 });
  const blockedOut = text(blocked);
  assert.notStrictEqual(blocked.status, 0,
    `a refused roster became a successful validation — the merge gate would wave it through:\n${blockedOut}`);
  assert.strictEqual(/CLEAN/.test(blockedOut), false,
    `hosted validation called a checkout it could not resolve a roster for clean:\n${blockedOut}`);
  assert(blockedOut.includes(ABSENT_COMMIT),
    `hosted validation hid which retirement metadata it could not use:\n${blockedOut}`);
});

(async () => {
  let failed = 0;
  for (const item of tests) {
    try { await item.body(); console.log(`[test] PASS ${item.name}`); }
    catch (error) { failed += 1; console.error(`[test] FAIL ${item.name}: ${error.stack || error.message}`); }
  }
  cleanupTemps();
  if (failed) { console.error(`[test] FAIL ${failed}/${tests.length} focused checks`); process.exitCode = 1; }
  else console.log(`[test] PASS ${tests.length}/${tests.length} focused checks`);
})().catch((error) => {
  cleanupTemps();
  console.error(`[test] FAIL harness: ${error.stack || error.message}`);
  process.exitCode = 1;
});
