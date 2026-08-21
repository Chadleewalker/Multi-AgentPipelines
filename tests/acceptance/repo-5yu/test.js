// Frozen acceptance test — the ready queue's dispatchability gate (DESIGN.md §4.12's
// second admission rule, §4.11's `undispatchable` outcome, change-log row `dispatch-gate`).
// Written before implementation, from the spec alone; criteria C1–C6 map 1:1 to the
// issue's "Done means" list.
//
// Docker-free by construction: it builds throwaway bare remotes and working copies under
// the OS temp dir with git and node only, on the tests/unit/trace.test.js and
// verdict.test.js precedent. It requires runner/queue.js and runner/report.js because
// those modules ARE what the criteria observe; it imports no shared helper, and inlines
// everything else (§3.1 — a frozen test that imports mutable code can change what it gates
// without its own text changing).
//
// FIXTURE HYGIENE, all four parts load-bearing:
//   --initial-branch is pinned on every repository, because the host's init.defaultBranch
//     decides it otherwise and this task is ABOUT default-branch resolution;
//   the bare remote's HEAD symref is set explicitly, because the `ls-remote --symref`
//     fallback reads it;
//   commit.gpgsign=false and GIT_AUTHOR_*/GIT_COMMITTER_* are set, because a container has
//     no git identity and commits fail outright without them;
//   the unreachable-remote fixture is a NONEXISTENT LOCAL PATH, never a URL — the
//     container has no egress, so a URL fixture fails for a DNS reason unrelated to the
//     criterion, or hangs.
//
// THE FROZEN INTERFACE:
//   readyQueue(cfg) -> { ok: true, issues, skipped, undispatchable }
//                   |  { ok: false, cause: 'git' | 'bd', error }
//     `undispatchable` entries each carry the bd issue and a reason.
//     The gate fetches cfg.targetRepoRemote BY URL with an explicit refspec into a
//     throwaway repository, then reads FETCH_HEAD. It never consults origin/<branch>,
//     the working tree, or a local branch. It is LAZY: no candidates, no fetch, no abort.
//   queueSummary(issues, skipped, undispatchable) -> the historic
//     `ready queue: N task(s) — <ids>` prefix, with the refusal clause appended AFTER the
//     type-skip and non-task clauses.
//   undispatchableRow(issue, reason, runId) -> a pure manifest row: issueId, title,
//     outcome 'undispatchable', and an attemptNotes entry naming the remedy.
//   gitSpawnOptions(cfg) -> spawn options carrying a positive integer `timeout`
//     (cfg.gitTimeoutMs, default 60000) and a kill signal.
//
// Deliberately NOT frozen: the exact wording of the refusal clause and of the report
// label beyond the shapes asserted below, the reason string's phrasing, and the name of
// the module the gate's git helpers live in. Outcomes freeze; prose does not.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');

let failed = 0;
function check(name, cond) {
  console.log(`${cond ? 'ok' : 'FAIL'} - ${name}`);
  if (!cond) failed = 1;
}
// A criterion whose setup threw is a FAIL, never a skip: a suite that quietly stops
// asserting is the vacuous-green this repo has already shipped once.
function guarded(name, fn) {
  try { fn(); } catch (e) { check(`${name} [threw: ${e && e.message}]`, false); }
}

// ---- module under test ---------------------------------------------------------------
let queue = null;
let report = null;
try { queue = require(path.join(ROOT, 'runner', 'queue.js')); } catch { /* reported below */ }
try { report = require(path.join(ROOT, 'runner', 'report.js')); } catch { /* reported below */ }
check('C0a runner/queue.js loads', !!queue);
check('C0b runner/report.js loads', !!report);

// ---- git fixture helpers (inlined on purpose) -----------------------------------------
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'freeze', GIT_AUTHOR_EMAIL: 'freeze@test.local',
  GIT_COMMITTER_NAME: 'freeze', GIT_COMMITTER_EMAIL: 'freeze@test.local',
  GIT_CONFIG_NOSYSTEM: '1',
};
const BRANCH = 'trunk'; // deliberately neither `main` nor `master`: a literal fallback to
                        // either must not accidentally pass any fixture here.

function git(cwd, args) {
  return spawnSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false',
    '-c', 'core.eol=lf', ...args], { cwd, encoding: 'utf8', env: GIT_ENV });
}
function mk(d) { fs.mkdirSync(d, { recursive: true }); return d; }
function tmp(tag) { return fs.mkdtempSync(path.join(os.tmpdir(), `accept-5yu-${tag}-`)); }

// A bare remote whose HEAD symref names BRANCH explicitly.
function mkBare(dir) {
  mk(dir);
  git(dir, ['init', '--bare', '--initial-branch', BRANCH, '.']);
  git(dir, ['symbolic-ref', 'HEAD', `refs/heads/${BRANCH}`]);
  return dir;
}
// A working copy on BRANCH with one commit, wired to `remote` as origin and pushed.
function mkWork(dir, remote) {
  mk(dir);
  git(dir, ['init', '--initial-branch', BRANCH, '.']);
  git(dir, ['remote', 'add', 'origin', remote]);
  fs.writeFileSync(path.join(dir, 'README.md'), 'fixture\n');
  fs.writeFileSync(path.join(dir, 'pipeline.config.json'),
    JSON.stringify({ verifyCommand: 'sh tools/run-acceptance.sh', defaultBranch: BRANCH }, null, 2));
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', 'init']);
  git(dir, ['push', '-q', 'origin', BRANCH]);
  return dir;
}
// Commit a suite directory (or a plain file, when `asFile`) and optionally push it.
function addSuite(work, id, { push, asFile } = {}) {
  const p = path.join(work, 'tests', 'acceptance', id);
  if (asFile) { mk(path.dirname(p)); fs.writeFileSync(p, 'not a directory\n'); }
  else { mk(p); fs.writeFileSync(path.join(p, 'test.js'), 'process.exit(1);\n'); }
  git(work, ['add', '-A']);
  git(work, ['commit', '-qm', `suite ${id}`]);
  if (push) git(work, ['push', '-q', 'origin', BRANCH]);
}
// A suite that is present in the working tree and has never been committed at all.
function addUntrackedSuite(work, id) {
  const p = mk(path.join(work, 'tests', 'acceptance', id));
  fs.writeFileSync(path.join(p, 'test.js'), 'process.exit(1);\n');
}

// ---- the bd seam ----------------------------------------------------------------------
// A .js preload run through process.execPath, never a #!/bin/sh script: spawnSync without
// a shell fails such a script with EFTYPE on the Windows host, so the suite would pass in
// a container and fail in the host sweep.
//
// THE STAND-ASIDE GUARD IS THE FIRST STATEMENT, and it is keyed on something structural —
// whether this node process is running a real script — never on a flag, because node owns
// `-C` as the short form of `--conditions`. Without it the preload reaches EVERY node
// process and kills the one it was never meant to touch.
function writeBdStub(dir, entries, logFile) {
  const stub = path.join(dir, 'bd-stub.js');
  fs.writeFileSync(stub, [
    "'use strict';",
    'const fs = require("fs");',
    'const argv = process.argv.slice(1);',
    '// STAND-ASIDE GUARD, first statement: this preload reaches every node process, and',
    '// one ending in process.exit() kills the one it was never meant to touch. Keyed on',
    '// whether this process is running a real script — node resolves a bd verb like',
    '// `ready` to a path relative to cwd, which does not exist and has no .js extension.',
    'if (argv.length && /\\.js$/i.test(argv[0]) && fs.existsSync(argv[0])) return;',
    `fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify(argv) + "\\n");`,
    '// Matched on the BASENAME, never on equality: node resolves the first argument to an',
    '// absolute path before a preload sees process.argv, so `ready` arrives as',
    '// `<cwd>/ready` and `a === "ready"` never matches — the stub then feeds an EMPTY',
    '// queue and every fixture below becomes unreachable by any implementation.',
    'if (argv.some((a) => /(^|[\\\\/])ready$/.test(String(a)))) {',
    '  // fs.writeSync(1, ...), NEVER process.stdout.write: stdout to a pipe is',
    '  // asynchronous on Windows, so process.exit() truncates a pending write and the',
    '  // caller reads an EMPTY queue. That failure is silent and makes every fixture',
    '  // below unreachable by any implementation.',
    `  fs.writeSync(1, ${JSON.stringify(JSON.stringify(entries))});`,
    '  process.exit(0);',
    '}',
    'process.exit(0);',
  ].join('\n'));
  return stub;
}
function withBd(stub, fn) {
  const savedCmd = process.env.PIPELINE_BD_CMD;
  const savedOpts = process.env.NODE_OPTIONS;
  process.env.PIPELINE_BD_CMD = process.execPath;
  // Forward slashes: NODE_OPTIONS strips the surrounding quotes, and the temp dir may
  // contain spaces.
  process.env.NODE_OPTIONS = `--require "${stub.split(path.sep).join('/')}"`;
  try { return fn(); } finally {
    if (savedCmd === undefined) delete process.env.PIPELINE_BD_CMD;
    else process.env.PIPELINE_BD_CMD = savedCmd;
    if (savedOpts === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = savedOpts;
  }
}

// The config is the SHIPPED example with per-key overrides — never a hand-built literal,
// which breaks on the next required key rather than on anything this task changed.
const EXAMPLE = JSON.parse(fs.readFileSync(path.join(ROOT, 'run.config.example.json'), 'utf8'));
const cfgFor = (over) => ({ ...EXAMPLE, ...over });

const issue = (id, over = {}) => ({
  id, title: `t ${id}`, issue_type: 'task', priority: 2,
  created_at: '2026-01-01T00:00:00Z', ...over,
});

// Run readyQueue over a fixture. Returns the result, or {threw} so a missing export is a
// FAIL rather than a crash that stops the file.
function run(work, remote, entries, over = {}) {
  const dir = tmp('log');
  const logFile = path.join(dir, 'argv.log');
  fs.writeFileSync(logFile, '');
  const stub = writeBdStub(dir, entries, logFile);
  const cfg = cfgFor({ targetRepoPath: work, targetRepoRemote: remote, ...over });
  let res;
  try { res = withBd(stub, () => queue.readyQueue(cfg)); }
  catch (e) { res = { threw: e && e.message }; }
  const argv = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { res, argv };
}
const idsOf = (a) => (Array.isArray(a) ? a : []).map((x) => (x && x.id) || (x && x.issue && x.issue.id));
const has = (a, id) => idsOf(a).includes(id);

// =======================================================================================
// C1 — the gate reads the repository the containers will clone, and reads it as a directory
// =======================================================================================
// (a) and (b) are the discriminating pair. Every other fixture below is ALSO refused by an
// implementation that reads origin/<branch> in the working copy — which is exactly the
// implementation the constraints forbid, because targetRepoPath and targetRepoRemote are
// independent config keys nothing relates. Without this pair the criterion passes the bug.
guarded('C1', () => {
  const base = tmp('c1');

  // (a) origin HOLDS the suite; targetRepoRemote does NOT. Must refuse.
  // The target remote is SEEDED with its own commit on BRANCH and merely lacks this
  // suite. An empty bare repo would have no BRANCH at all, which is a fetch failure — the
  // criterion would then abort rather than refuse, and could never distinguish the two
  // implementations it exists to separate.
  const remoteA = mkBare(path.join(base, 'a-origin.git'));
  const remoteB = mkBare(path.join(base, 'a-target.git'));
  mkWork(path.join(base, 'a-seed'), remoteB);         // gives remoteB a populated BRANCH
  const workA = mkWork(path.join(base, 'a-work'), remoteA);
  addSuite(workA, 'gate-a', { push: true });          // lands on remoteA only
  const a = run(workA, remoteB, [issue('gate-a')]);
  check('C1a suite in origin but not in targetRepoRemote is REFUSED',
    a.res.ok === true && !has(a.res.issues, 'gate-a') && has(a.res.undispatchable, 'gate-a'));

  // (b) the mirror: origin is empty, targetRepoRemote HOLDS it. Must dispatch.
  const remoteC = mkBare(path.join(base, 'b-origin.git'));
  const remoteD = mkBare(path.join(base, 'b-target.git'));
  const workD = mkWork(path.join(base, 'b-seed'), remoteD);
  addSuite(workD, 'gate-b', { push: true });          // lands on remoteD only
  const workC = mkWork(path.join(base, 'b-work'), remoteC);
  const b = run(workC, remoteD, [issue('gate-b')]);
  check('C1b suite in targetRepoRemote but not in origin is DISPATCHED',
    b.res.ok === true && has(b.res.issues, 'gate-b') && !has(b.res.undispatchable, 'gate-b'));

  // (c) committed on the local default branch and never pushed.
  const remoteE = mkBare(path.join(base, 'c.git'));
  const workE = mkWork(path.join(base, 'c-work'), remoteE);
  addSuite(workE, 'gate-c', { push: false });
  const c = run(workE, remoteE, [issue('gate-c')]);
  check('C1c suite committed locally and never pushed is REFUSED',
    c.res.ok === true && !has(c.res.issues, 'gate-c') && has(c.res.undispatchable, 'gate-c'));

  // (d) untracked in the working tree.
  const remoteF = mkBare(path.join(base, 'd.git'));
  const workF = mkWork(path.join(base, 'd-work'), remoteF);
  addUntrackedSuite(workF, 'gate-d');
  const d = run(workF, remoteF, [issue('gate-d')]);
  check('C1d suite untracked in the working tree is REFUSED',
    d.res.ok === true && !has(d.res.issues, 'gate-d') && has(d.res.undispatchable, 'gate-d'));

  // (e) a regular FILE pushed where the directory should be. `-d` is what catches this,
  // and the verifier's trailing-slash invocation would fail on it too.
  const remoteG = mkBare(path.join(base, 'e.git'));
  const workG = mkWork(path.join(base, 'e-work'), remoteG);
  addSuite(workG, 'gate-e', { push: true, asFile: true });
  const e = run(workG, remoteG, [issue('gate-e')]);
  check('C1e a plain file pushed at tests/acceptance/<id> is REFUSED',
    e.res.ok === true && !has(e.res.issues, 'gate-e') && has(e.res.undispatchable, 'gate-e'));
});

// =======================================================================================
// C2 — a mixed queue dispatches the frozen ones, refuses only the rest, in one pinned line
// =======================================================================================
guarded('C2', () => {
  const base = tmp('c2');
  const remote = mkBare(path.join(base, 'r.git'));
  const work = mkWork(path.join(base, 'w'), remote);
  addSuite(work, 'ok-hi', { push: true });
  addSuite(work, 'ok-lo', { push: true });
  const entries = [
    issue('ok-lo', { priority: 2, created_at: '2026-01-02T00:00:00Z' }),
    issue('no-two', { priority: 0, created_at: '2026-01-04T00:00:00Z' }),
    issue('ok-hi', { priority: 0, created_at: '2026-01-03T00:00:00Z' }),
    issue('no-one', { priority: 2, created_at: '2026-01-01T00:00:00Z' }),
  ];
  const { res } = run(work, remote, entries);

  check('C2a only the two frozen issues are dispatchable',
    res.ok === true && JSON.stringify(idsOf(res.issues)) === JSON.stringify(['ok-hi', 'ok-lo']));
  check('C2b the other two are undispatchable',
    res.ok === true && idsOf(res.undispatchable).sort().join(',') === 'no-one,no-two');
  check('C2c each undispatchable entry carries its issue and a reason',
    Array.isArray(res.undispatchable) && res.undispatchable.length === 2 &&
    res.undispatchable.every((u) => u && u.issue && typeof u.issue.id === 'string' &&
      typeof u.reason === 'string' && u.reason.length > 0));

  // The historic prefix is APPENDED TO, never rewoven: scripts/test-runner-queue.sh greps
  // it at six sites and scripts/dashboard.js parses ids from the first ` — ` to the first `;`.
  const line = queue.queueSummary(res.issues, res.skipped, res.undispatchable);
  check('C2d the summary keeps the historic prefix and the dispatchable ids',
    typeof line === 'string' && line.startsWith('ready queue: 2 task(s) — ') &&
    line.split(';')[0].includes('ok-hi') && line.split(';')[0].includes('ok-lo'));
  check('C2e the summary names both refused ids after a `;`',
    typeof line === 'string' && line.includes(';') &&
    line.slice(line.indexOf(';')).includes('no-one') &&
    line.slice(line.indexOf(';')).includes('no-two'));
  check('C2f no refused id leaks into the dispatchable segment',
    typeof line === 'string' && !line.split(';')[0].includes('no-one') &&
    !line.split(';')[0].includes('no-two'));

  // The refusal clause is LAST: the two existing clauses keep their positions.
  const withSkips = queue.queueSummary(
    res.issues,
    [issue('ep-1', { issue_type: 'epic' })],
    res.undispatchable
  );
  check('C2g the refusal clause is appended AFTER the type-skip clause',
    typeof withSkips === 'string' &&
    withSkips.indexOf('ep-1') > -1 && withSkips.indexOf('no-one') > withSkips.indexOf('ep-1'));
});

// =======================================================================================
// C3 — unreachable remote, unresolvable branch, and an exceeded bound all abort
// =======================================================================================
guarded('C3', () => {
  const base = tmp('c3');

  // A NONEXISTENT LOCAL PATH, never a URL: the container has no egress.
  const remoteGone = path.join(base, 'no-such-remote.git');
  const remoteOk = mkBare(path.join(base, 'ok.git'));
  const work = mkWork(path.join(base, 'w'), remoteOk);
  addSuite(work, 'anything', { push: true });

  const dead = run(work, remoteGone, [issue('anything')]);
  check('C3a an unreachable remote aborts with cause `git`',
    dead.res.ok === false && dead.res.cause === 'git');
  check('C3b the abort names the remote and the branch',
    dead.res.ok === false && typeof dead.res.error === 'string' &&
    dead.res.error.includes(remoteGone) && dead.res.error.includes(BRANCH));
  check('C3c an aborted gate dispatches nothing — no partial answer',
    dead.res.ok === false && !(Array.isArray(dead.res.issues) && dead.res.issues.length));

  // A branch that cannot be resolved on a remote that IS reachable.
  const emptyRemote = mkBare(path.join(base, 'empty.git'));
  const workNoBranch = mkWork(path.join(base, 'nb'), remoteOk);
  fs.writeFileSync(path.join(workNoBranch, 'pipeline.config.json'),
    JSON.stringify({ verifyCommand: 'sh tools/run-acceptance.sh', defaultBranch: 'nope' }, null, 2));
  const nb = run(workNoBranch, emptyRemote, [issue('anything')]);
  check('C3d a branch absent from the remote aborts with cause `git`, not a per-issue refusal',
    nb.res.ok === false && nb.res.cause === 'git');

  // The bound is APPLIED, not merely exported. A 1 ms ceiling against a remote that is
  // perfectly reachable must still abort — an implementation that exports the builder and
  // then spawns without it passes a shape check and parks the run forever.
  const bounded = run(work, remoteOk, [issue('anything')], { gitTimeoutMs: 1 });
  check('C3e gitTimeoutMs is applied to the spawn: a 1 ms bound aborts a working remote',
    bounded.res.ok === false && bounded.res.cause === 'git');

  // ...and the builder itself carries the bound, so the two checks pin it together.
  const opts = typeof queue.gitSpawnOptions === 'function'
    ? queue.gitSpawnOptions(cfgFor({ gitTimeoutMs: 12345 })) : null;
  check('C3f gitSpawnOptions carries a positive integer timeout and a kill signal',
    !!opts && Number.isInteger(opts.timeout) && opts.timeout > 0 && !!opts.killSignal);
  const dflt = typeof queue.gitSpawnOptions === 'function'
    ? queue.gitSpawnOptions(cfgFor({ gitTimeoutMs: undefined })) : null;
  check('C3g gitSpawnOptions defaults the bound rather than leaving it unset',
    !!dflt && Number.isInteger(dflt.timeout) && dflt.timeout > 0);

  // The Beads failure path keeps its own cause: a git problem must not be reported as a
  // Beads problem, and the discriminator is a FIELD, never the message wording.
  const okBase = tmp('c3bd');
  const badStub = path.join(okBase, 'bad.js');
  fs.writeFileSync(badStub, [
    "'use strict';",
    'const fs = require("fs");',
    'const argv = process.argv.slice(1);',
    'if (argv.length && /\\.js$/i.test(argv[0]) && fs.existsSync(argv[0])) return;',
    'fs.writeSync(2, "bd exploded");',   // synchronous, for the same reason as above
    'process.exit(3);',
  ].join('\n'));
  let bdRes;
  try {
    bdRes = withBd(badStub, () => queue.readyQueue(
      cfgFor({ targetRepoPath: work, targetRepoRemote: remoteOk })));
  } catch (e) { bdRes = { threw: e && e.message }; }
  check('C3h a Beads failure still reports cause `bd`',
    bdRes && bdRes.ok === false && bdRes.cause === 'bd');
});

// =======================================================================================
// C4 — a refused issue never touches Beads, and always produces a row
// =======================================================================================
guarded('C4', () => {
  const base = tmp('c4');
  const remote = mkBare(path.join(base, 'r.git'));
  const work = mkWork(path.join(base, 'w'), remote);
  addSuite(work, 'frozen-one', { push: true });
  const { res, argv } = run(work, remote, [issue('frozen-one'), issue('unfrozen-one')]);

  const verbs = argv.map((a) => a.join(' '));
  check('C4a exactly one `ready` invocation reached the bd seam',
    verbs.filter((v) => /\bready\b/.test(v)).length === 1);
  check('C4b the refused issue was never claimed, noted or closed',
    !verbs.some((v) => /\b(update|note|close)\b/.test(v) && v.includes('unfrozen-one')));
  check('C4c no bd write of any kind reached the seam',
    !verbs.some((v) => /\b(update|note|close|create|import|sync|dolt)\b/.test(v)));

  // The row is built by a PURE EXPORTED FUNCTION. main() sits behind the token load and
  // the Docker preflight, so a row manufactured inline there is unreachable to every
  // Docker-free test — and a gate that refuses correctly while manufacturing nothing would
  // pass a suite that never looked.
  const reason = 'no frozen acceptance suite on trunk';
  const row = typeof queue.undispatchableRow === 'function'
    ? queue.undispatchableRow(issue('unfrozen-one'), reason, 'run-1') : null;
  check('C4d undispatchableRow returns a row carrying the id, title and outcome',
    !!row && row.issueId === 'unfrozen-one' && row.title === 't unfrozen-one' &&
    row.outcome === 'undispatchable');
  check('C4e the row carries an attempt note naming the remedy',
    !!row && Array.isArray(row.attemptNotes) && row.attemptNotes.length > 0 &&
    row.attemptNotes.some((n) => typeof n === 'string' && n.length > 0));
  check('C4f the refused population feeds exactly one entry per refusal',
    res.ok === true && Array.isArray(res.undispatchable) && res.undispatchable.length === 1 &&
    idsOf(res.undispatchable)[0] === 'unfrozen-one');
});

// =======================================================================================
// C5 — the manifest and the report carry it honestly
// =======================================================================================
guarded('C5', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'schemas', 'run.schema.json'), 'utf8'));
  // Located BY PATH, not by grepping the file: a substring search would find the word in a
  // description and call a missing enum member present.
  const enumAt = schema
    && schema.properties && schema.properties.tasks
    && schema.properties.tasks.items && schema.properties.tasks.items.properties
    && schema.properties.tasks.items.properties.outcome
    && schema.properties.tasks.items.properties.outcome.enum;
  check('C5a the manifest outcome enum contains `undispatchable`',
    Array.isArray(enumAt) && enumAt.includes('undispatchable'));

  // The suite's own admitter, driven off that same enum. `npx ajv` needs the network and
  // cannot run in the task container, so the validator is hand-rolled — and a hand-rolled
  // validator that ignores `enum` would pass whether or not the member was ever added.
  // The rejection half is what proves it can say no.
  const admits = (outcome) => Array.isArray(enumAt) && enumAt.includes(outcome);
  check('C5b a realistic full-width undispatchable row is admitted', admits('undispatchable'));
  check('C5c an invented outcome is REJECTED on the same path', !admits('refused'));

  // All seven outcomes plus an invented one. The fixture covers `partial`, `failed` and
  // `paused` deliberately: inserting a rank by renumbering can transpose those three and
  // still place `undispatchable` correctly.
  const rows = [
    { issueId: 'i-done', outcome: 'done', attempts: 1 },
    { issueId: 'i-paused', outcome: 'paused' },
    { issueId: 'i-failed', outcome: 'failed' },
    { issueId: 'i-partial', outcome: 'partial' },
    { issueId: 'i-tampered', outcome: 'tampered' },
    { issueId: 'i-stuck', outcome: 'stuck' },
    { issueId: 'i-undisp', outcome: 'undispatchable' },
    { issueId: 'i-unknown', outcome: 'nonesuch' },
  ];
  const dir = tmp('c5');
  let written = null;
  try {
    written = report.writeManifest(dir, {
      runId: 'r1', startedAt: 'x', finishedAt: 'y', tasks: rows,
    });
  } catch (e) { check(`C5 writeManifest threw: ${e && e.message}`, false); }
  const order = written ? written.manifest.tasks.map((t) => t.outcome) : [];
  check('C5d undispatchable ranks immediately after tampered',
    order.indexOf('undispatchable') === order.indexOf('tampered') + 1);
  check('C5e the relative order of the six existing outcomes is unchanged',
    order.indexOf('tampered') < order.indexOf('stuck') &&
    order.indexOf('stuck') < order.indexOf('partial') &&
    order.indexOf('partial') < order.indexOf('failed') &&
    order.indexOf('failed') < order.indexOf('paused') &&
    order.indexOf('paused') < order.indexOf('done'));
  // Today an unknown outcome shares `failed`'s rank and ties break by issueId, so
  // 'i-unknown' lands immediately after 'i-failed'. Inserting `undispatchable` by
  // RENUMBERING moves that fallback and breaks this; inserting it fractionally does not.
  // Pinned to one position on purpose: "either side of failed" is satisfied by both.
  check('C5f an unknown outcome still sorts where it did — the fallback was not re-homed',
    order.indexOf('nonesuch') === order.indexOf('failed') + 1);

  const md = written ? report.renderReport(written.manifest) : '';
  check('C5g the report heading matches the house shape, not the bare outcome word',
    /##\s+i-undisp\s+—\s+UNDISPATCHABLE\s+—\s+\S/.test(md));
  check('C5h the rendered section names the remedy path',
    md.includes('tests/acceptance'));
});

// =======================================================================================
// C6 [guard] — existing contracts unmoved, and the invariant outlives this run
// =======================================================================================
guarded('C6', () => {
  // The dashboard parses ready-queue ids from the first ` — ` to the first `;`. An appended
  // clause must not leak into that list.
  let dash = null;
  try { dash = require(path.join(ROOT, 'scripts', 'dashboard.js')); } catch { /* below */ }
  // readyQueueIds takes the parsed run.log EVENT array, not a bare string.
  const line = 'ready queue: 2 task(s) — a-one, a-two; not dispatchable 1: b-one (no frozen suite)';
  const parsed = dash && typeof dash.readyQueueIds === 'function'
    ? dash.readyQueueIds([{ msg: line }]) : null;
  check('C6a the dashboard id parser returns only the dispatchable ids',
    Array.isArray(parsed) && parsed.join(',') === 'a-one,a-two');

  // With no refusals the line is byte-identical to today's, including both existing clauses.
  const dispatchable = [issue('x-one'), issue('x-two', { issue_type: 'bug' })];
  const skipped = [issue('e-one', { issue_type: 'epic' })];
  const before = 'ready queue: 2 task(s) — x-one, x-two; skipped 1 by type: e-one (epic); running 1 non-task: x-two (bug)';
  check('C6b a queue with no refusals produces the historic line unchanged',
    queue.queueSummary(dispatchable, skipped, []) === before);
  check('C6c the same holds when the third argument is omitted entirely',
    queue.queueSummary(dispatchable, skipped) === before);

  // The gate must not write into the working copy an operator is using: FETCH_HEAD is
  // per-repository state, and the fetch belongs in a throwaway repository.
  const base = tmp('c6');
  const remote = mkBare(path.join(base, 'r.git'));
  const work = mkWork(path.join(base, 'w'), remote);
  addSuite(work, 'w-one', { push: true });
  const snap = () => {
    const refs = git(work, ['show-ref']).stdout || '';
    const st = git(work, ['status', '--porcelain']).stdout || '';
    const names = fs.readdirSync(path.join(work, '.git')).sort().join(',');
    return `${refs}|${st}|${names}`;
  };
  const pre = snap();
  run(work, remote, [issue('w-one')]);
  check('C6d the gate leaves the target working copy refs, tree and .git contents unchanged',
    snap() === pre);

  // LAZY: no candidates left after the type filter means no fetch and no abort. An eager
  // gate turns a legitimately empty run into an exit-1 failure.
  const gone = path.join(base, 'never.git');
  const empty = run(work, gone, []);
  check('C6e an empty queue neither fetches nor aborts',
    empty.res.ok === true && (empty.res.issues || []).length === 0);
  const epicsOnly = run(work, gone, [issue('e-two', { issue_type: 'epic' })]);
  check('C6f a queue of only excluded types neither fetches nor aborts',
    epicsOnly.res.ok === true && (epicsOnly.res.issues || []).length === 0 &&
    idsOf(epicsOnly.res.skipped).includes('e-two'));

  // A frozen suite runs once and never again. Without a swept wrapper this gate has no
  // ongoing test at all the moment the task merges.
  // The name is PINNED, not matched by pattern: `/gate/` already matches the shipped
  // scripts/test-freeze-gate.sh and scripts/test-pause-gate.sh, so a loose filter passes
  // this criterion on a repository where the wrapper was never written at all.
  const WRAPPER = 'test-dispatch-gate.sh';
  const wrapperPath = path.join(ROOT, 'scripts', WRAPPER);
  const swept = fs.readdirSync(path.join(ROOT, 'scripts')).filter((f) => /^test-.*\.sh$/.test(f));
  check('C6g scripts/test-dispatch-gate.sh exists and the sweep glob finds it',
    fs.existsSync(wrapperPath) && swept.includes(WRAPPER));
  let wrapperOk = false;
  if (fs.existsSync(wrapperPath)) {
    const r = spawnSync('sh', [wrapperPath], { cwd: ROOT, encoding: 'utf8' });
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    const oks = (out.match(/^ok - /gm) || []).length;
    wrapperOk = r.status === 0 && oks >= 5 && !/^FAIL/m.test(out);
  }
  check('C6h that wrapper exits 0, prints at least 5 `ok - ` lines and no FAIL line', wrapperOk);
});

process.exit(failed);
