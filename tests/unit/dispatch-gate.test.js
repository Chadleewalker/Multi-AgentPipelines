#!/usr/bin/env node
// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// Unit suite for the ready queue's dispatchability gate — `runner/queue.js`, DESIGN.md
// §4.12's second admission rule and §4.11's `undispatchable` outcome (change-log rows
// `dispatch-gate`, `repo-5yu`). Re-runnable: the sweep picks it up through
// scripts/test-dispatch-gate.sh. Its job is the half of tests/acceptance/repo-5yu/ that has
// to outlive that task — a frozen acceptance directory is an artifact of a finished run and
// is never executed again, while this gate decides, on every run for ever, whether a batch
// goes out at all.
//
// Plain Node, no test framework, no Docker, no network, no `bd`: run it as
// `node tests/unit/dispatch-gate.test.js` from anywhere. One line per check — `ok - <label>`
// / `FAIL - <label>` — and a non-zero exit if any check failed. Fixtures are throwaway bare
// remotes and working copies under the OS temp dir, on the tests/unit/trace.test.js and
// verdict.test.js precedent; every repository pins `--initial-branch`, sets its HEAD symref
// explicitly, and sets `commit.gpgsign=false` plus GIT_AUTHOR_*/GIT_COMMITTER_*, because a
// container has no git identity and commits fail outright without them.
//
// WHERE THIS GOES BEYOND THE FROZEN SUITE, on purpose:
//
//   * THE `ls-remote --symref` LINK OF THE BRANCH CHAIN IS NEVER EXERCISED THERE. Every
//     frozen fixture writes a `pipeline.config.json` naming `defaultBranch`, so the first
//     link answers every time and the second and third are dead code to it. Here a target
//     working copy with no `pipeline.config.json` at all resolves through the remote's HEAD
//     symref — and does so against a `master` project, which is the fixture that
//     discriminates this design from `runner/workspace.js`'s `detectDefaultBranch`: an
//     implementation whose chain ends at the literal `'main'` empties `ls-tree` for every
//     issue and refuses the whole queue with a confident wrong reason.
//   * NEITHER SOURCE ANSWERING must abort rather than guess, and the abort must not name a
//     branch nobody chose.
//   * PREFIX COLLISION. `ls-tree -- tests/acceptance/<id>` against a tree holding only
//     `tests/acceptance/<id>-r2` must answer empty. A pathspec that matched by string prefix
//     would dispatch an unfrozen task, which is the exact failure the gate exists to prevent
//     and is invisible to any fixture whose ids do not share a prefix.
//   * THE BOUND IS STRUCTURAL AS WELL AS BEHAVIOURAL. The frozen suite proves a 1 ms ceiling
//     aborts one call path; this one scans the source and asserts EVERY `spawnSync` in
//     `runner/queue.js` is built from `gitSpawnOptions`, which is the whole value of the
//     `runner/bd.js` `spawnOptions` precedent (change-log row `repo-sls`) and exactly the
//     kind of constraint that decays silently while every behavioural check stays green.
//   * `gitTimeoutMs` IS VALIDATED AT CONFIG LOAD, by name and before a run starts, exactly
//     as `bdTimeoutMs` is — a fractional or zero value reaches `spawnSync` and fails late
//     and obscurely.
//   * THE THROWAWAY REPOSITORY IS REMOVED. The gate runs once per run for the life of the
//     project; a fetch directory leaked per run is a slow disk leak nothing would report,
//     and the suite proves both halves — that no dispatch-gate directory survives the call,
//     and that none survives an ABORTED call either, which is the path where a `finally` is
//     easiest to omit.
//   * `run.js` IS PINNED STRUCTURALLY at the seams no Docker-free test can execute: it sits
//     behind the token load and the Docker preflight, so "the two failure channels are told
//     apart" and "the refused rows reach the manifest" are only assertable as source facts.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const QUEUE_SRC = path.join(ROOT, 'runner', 'queue.js');
const RUN_SRC = path.join(ROOT, 'runner', 'run.js');

// The suite owns its fixtures: a seam inherited from the shell would let the caller's
// environment decide the result — or, worse, point the gate at a real project.
delete process.env.PIPELINE_BD_CMD;

const queue = require(QUEUE_SRC);
const report = require(path.join(ROOT, 'runner', 'report.js'));
const { loadConfig, DEFAULTS } = require(path.join(ROOT, 'runner', 'config.js'));

let failed = 0;
function check(name, cond) {
  console.log(`${cond ? 'ok' : 'FAIL'} - ${name}`);
  if (!cond) failed = 1;
}
// A section whose setup threw is a FAIL, never a skip: a suite that quietly stops asserting
// is the vacuous-green this repo has already shipped once.
function guarded(name, fn) {
  try { fn(); } catch (e) { check(`${name} [threw: ${e && e.message}]`, false); }
}

// ---- git fixtures ----------------------------------------------------------------------
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'unit', GIT_AUTHOR_EMAIL: 'unit@test.local',
  GIT_COMMITTER_NAME: 'unit', GIT_COMMITTER_EMAIL: 'unit@test.local',
  GIT_CONFIG_NOSYSTEM: '1',
};
function git(cwd, args) {
  return spawnSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false',
    '-c', 'core.eol=lf', ...args], { cwd, encoding: 'utf8', env: GIT_ENV });
}
const mk = (d) => { fs.mkdirSync(d, { recursive: true }); return d; };
const tmp = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `unit-gate-${tag}-`));

// A bare remote whose HEAD symref names `branch` explicitly — the `ls-remote --symref`
// fallback reads exactly that, so leaving it to the host's init.defaultBranch would make
// this suite's answer depend on the machine it runs on.
function mkBare(dir, branch) {
  mk(dir);
  git(dir, ['init', '--bare', '--initial-branch', branch, '.']);
  git(dir, ['symbolic-ref', 'HEAD', `refs/heads/${branch}`]);
  return dir;
}
// A working copy on `branch`, wired to `remote` as origin and pushed. `pipelineConfig` is
// the object to write as pipeline.config.json, or null to write NO such file at all — which
// is what forces branch resolution onto the remote.
function mkWork(dir, remote, branch, pipelineConfig) {
  mk(dir);
  git(dir, ['init', '--initial-branch', branch, '.']);
  git(dir, ['remote', 'add', 'origin', remote]);
  fs.writeFileSync(path.join(dir, 'README.md'), 'fixture\n');
  if (pipelineConfig) {
    fs.writeFileSync(path.join(dir, 'pipeline.config.json'),
      JSON.stringify(pipelineConfig, null, 2));
  }
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', 'init']);
  git(dir, ['push', '-q', 'origin', branch]);
  return dir;
}
function addSuite(work, branch, id, { push = true, asFile = false } = {}) {
  const p = path.join(work, 'tests', 'acceptance', id);
  if (asFile) { mk(path.dirname(p)); fs.writeFileSync(p, 'not a directory\n'); }
  else { mk(p); fs.writeFileSync(path.join(p, 'test.js'), 'process.exit(1);\n'); }
  git(work, ['add', '-A']);
  git(work, ['commit', '-qm', `suite ${id}`]);
  if (push) git(work, ['push', '-q', 'origin', branch]);
}

// ---- the bd seam -----------------------------------------------------------------------
// A .js preload run through process.execPath, never a #!/bin/sh script: spawnSync without a
// shell fails such a script with EFTYPE on the Windows host, so the suite would pass in a
// container and fail in the host sweep.
//
// The two traps this recipe has already cost the project, both encoded below:
//   the STAND-ASIDE GUARD is the first statement and is keyed on something STRUCTURAL —
//     whether this node process is running a real script — never on a flag, because node
//     owns `-C` as the short form of `--conditions`. Without it the preload reaches every
//     node process and kills the one it was never meant to touch;
//   the verb is matched on the BASENAME and printed with fs.writeSync(1, …). Node resolves
//     the first argument to an absolute path before a preload sees process.argv, so `ready`
//     arrives as `<cwd>/ready`; and stdout to a pipe is asynchronous on Windows, so
//     process.exit() truncates a pending process.stdout.write and the caller reads an EMPTY
//     queue — silent, well-formed and false, and every fixture here becomes unreachable.
function writeBdStub(dir, entries, logFile) {
  const stub = path.join(dir, 'bd-stub.js');
  fs.writeFileSync(stub, [
    "'use strict';",
    'const fs = require("fs");',
    'const argv = process.argv.slice(1);',
    'if (argv.length && /\\.js$/i.test(argv[0]) && fs.existsSync(argv[0])) return;',
    `fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify(argv) + "\\n");`,
    'if (argv.some((a) => /(^|[\\\\/])ready$/.test(String(a)))) {',
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

// The SHIPPED example with per-key overrides, never a hand-built literal, which breaks on
// the next required key rather than on anything this suite is about.
const EXAMPLE = JSON.parse(fs.readFileSync(path.join(ROOT, 'run.config.example.json'), 'utf8'));
const cfgFor = (over) => ({ ...EXAMPLE, ...over });
const issue = (id, over = {}) => ({
  id, title: `t ${id}`, issue_type: 'task', priority: 2,
  created_at: '2026-01-01T00:00:00Z', ...over,
});

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

// What the gate leaves behind in the OS temp dir. The prefix is the implementation's own,
// which is the point: a rename that stopped cleaning up would still be caught, because the
// check below counts what a call ADDED rather than what matches one fixed name.
const tmpListing = () => {
  try { return fs.readdirSync(os.tmpdir()).filter((n) => /^pipeline-dispatch-gate-/.test(n)); }
  catch { return []; }
};

// =======================================================================================
// G0 — the gate reads the repository the CONTAINERS will clone
// =======================================================================================
// The discriminating pair, and the reason it has to live in the re-runnable suite as well
// as the frozen one: `targetRepoPath` and `targetRepoRemote` are independent config keys
// `runner/config.js` never relates, and every OTHER fixture in this file has them agree —
// so an implementation that read `origin/<branch>` in the working copy, or the working tree
// itself, would pass all of them. Five of the seven failures this gate was built for had
// their suite present locally, in an unpushed commit or untracked. Freezing locally is not
// freezing.
guarded('G0', () => {
  const base = tmp('g0');
  const cfg = { verifyCommand: 'sh tools/run-acceptance.sh', defaultBranch: 'trunk' };

  // (a) origin HOLDS the suite; targetRepoRemote does not. The target remote is SEEDED with
  // its own commit on the branch and merely lacks this suite — an empty bare repo would
  // have no branch at all, which is an abort, and the fixture could then never tell the two
  // implementations apart.
  const originA = mkBare(path.join(base, 'a-origin.git'), 'trunk');
  const targetA = mkBare(path.join(base, 'a-target.git'), 'trunk');
  mkWork(path.join(base, 'a-seed'), targetA, 'trunk', cfg);
  const workA = mkWork(path.join(base, 'a-work'), originA, 'trunk', cfg);
  addSuite(workA, 'trunk', 'pair-a');                       // lands on originA only
  const a = run(workA, targetA, [issue('pair-a')]);
  check('G0a a suite in `origin` but not in targetRepoRemote is REFUSED',
    a.res.ok === true && !has(a.res.issues, 'pair-a') && has(a.res.undispatchable, 'pair-a'));

  // (b) the mirror: origin is bare of it, targetRepoRemote holds it.
  const originB = mkBare(path.join(base, 'b-origin.git'), 'trunk');
  const targetB = mkBare(path.join(base, 'b-target.git'), 'trunk');
  const seedB = mkWork(path.join(base, 'b-seed'), targetB, 'trunk', cfg);
  addSuite(seedB, 'trunk', 'pair-b');                       // lands on targetB only
  const workB = mkWork(path.join(base, 'b-work'), originB, 'trunk', cfg);
  const b = run(workB, targetB, [issue('pair-b')]);
  check('G0b a suite in targetRepoRemote but not in `origin` is DISPATCHED',
    b.res.ok === true && has(b.res.issues, 'pair-b') && !has(b.res.undispatchable, 'pair-b'));

  // (c)/(d) the two local shapes: committed and never pushed, and never committed at all.
  const remoteC = mkBare(path.join(base, 'c.git'), 'trunk');
  const workC = mkWork(path.join(base, 'c-work'), remoteC, 'trunk', cfg);
  addSuite(workC, 'trunk', 'local-commit', { push: false });
  mk(path.join(workC, 'tests', 'acceptance', 'untracked'));
  fs.writeFileSync(path.join(workC, 'tests', 'acceptance', 'untracked', 'test.js'), 'x\n');
  const c = run(workC, remoteC, [issue('local-commit'), issue('untracked')]);
  check('G0c a suite committed locally and never pushed is REFUSED',
    c.res.ok === true && has(c.res.undispatchable, 'local-commit'));
  check('G0d a suite untracked in the working tree is REFUSED',
    c.res.ok === true && has(c.res.undispatchable, 'untracked'));
});

// =======================================================================================
// G1 — the branch chain's SECOND link: the remote's own HEAD symref
// =======================================================================================
// Not one frozen fixture reaches this path: they all write a pipeline.config.json naming
// `defaultBranch`, so the first link answers every time. And the branch here is `master`,
// which is the fixture that separates this design from `detectDefaultBranch`'s literal
// 'main' — the wrong chain refuses BOTH issues below with a confident wrong reason.
guarded('G1', () => {
  const base = tmp('g1');
  const remote = mkBare(path.join(base, 'r.git'), 'master');
  const work = mkWork(path.join(base, 'w'), remote, 'master', null);   // NO pipeline.config.json
  addSuite(work, 'master', 'frozen-m');
  const { res } = run(work, remote, [issue('frozen-m'), issue('bare-m')]);

  check('G1a with no pipeline.config.json the branch comes from the remote HEAD symref',
    res.ok === true);
  check('G1b a `master` project dispatches its frozen task — no literal `main` fallback',
    res.ok === true && has(res.issues, 'frozen-m'));
  check('G1c the same run still refuses the unfrozen one', res.ok === true && has(res.undispatchable, 'bare-m'));
  check('G1d the refusal reason names the branch that was actually resolved',
    res.ok === true && /\bmaster\b/.test((res.undispatchable[0] || {}).reason || ''));

  // The first link still WINS when both could answer: pipeline.config.json names a branch
  // the remote's HEAD does not, and the gate must read the branch containers fork from.
  const base2 = tmp('g1b');
  const remote2 = mkBare(path.join(base2, 'r.git'), 'master');
  const work2 = mkWork(path.join(base2, 'w'), remote2, 'master',
    { verifyCommand: 'sh tools/run-acceptance.sh', defaultBranch: 'ship' });
  git(work2, ['checkout', '-q', '-b', 'ship']);
  addSuite(work2, 'ship', 'only-on-ship');
  const r2 = run(work2, remote2, [issue('only-on-ship')]);
  check('G1e pipeline.config.json wins over the remote HEAD symref',
    r2.res.ok === true && has(r2.res.issues, 'only-on-ship'));
});

// =======================================================================================
// G2 — neither source answers: abort, and never a guess
// =======================================================================================
guarded('G2', () => {
  const base = tmp('g2');
  // An empty bare repo answers `ls-remote --symref HEAD` with nothing at all: reachable,
  // and no branch to resolve. A chain with a literal last resort would sail past this.
  const empty = mkBare(path.join(base, 'empty.git'), 'trunk');
  const work = mkWork(path.join(base, 'w'), mkBare(path.join(base, 'other.git'), 'trunk'), 'trunk', null);
  const { res } = run(work, empty, [issue('anything')]);
  check('G2a an unresolvable branch aborts with cause `git`', res.ok === false && res.cause === 'git');
  check('G2b the abort names the remote it could not resolve',
    res.ok === false && typeof res.error === 'string' && res.error.includes(empty));
  check('G2c the abort names no branch nobody chose',
    res.ok === false && !/\brefs\/heads\/(main|master)\b/.test(res.error || ''));
  check('G2d an unresolvable branch dispatches nothing and refuses nothing — never a partial answer',
    res.ok === false && !(res.issues || []).length && !(res.undispatchable || []).length);

  // A working copy whose pipeline.config.json is unreadable JSON must fall THROUGH to the
  // remote rather than throwing: a half-written config is a bad reason to end a run.
  const base2 = tmp('g2b');
  const remote2 = mkBare(path.join(base2, 'r.git'), 'trunk');
  const work2 = mkWork(path.join(base2, 'w'), remote2, 'trunk', null);
  fs.writeFileSync(path.join(work2, 'pipeline.config.json'), '{ not json');
  addSuite(work2, 'trunk', 'ok-anyway');
  const r2 = run(work2, remote2, [issue('ok-anyway')]);
  check('G2e an unparseable pipeline.config.json falls through to the remote instead of throwing',
    r2.res.ok === true && has(r2.res.issues, 'ok-anyway'));
});

// =======================================================================================
// G3 — the tree is read as a DIRECTORY, at a path boundary
// =======================================================================================
guarded('G3', () => {
  const base = tmp('g3');
  const remote = mkBare(path.join(base, 'r.git'), 'trunk');
  const work = mkWork(path.join(base, 'w'), remote, 'trunk',
    { verifyCommand: 'sh tools/run-acceptance.sh', defaultBranch: 'trunk' });
  // Only the RE-RUN suite exists. An id that matched by string prefix would dispatch `job-7`
  // on the strength of `job-7-r2`'s directory — an unfrozen task straight into a container,
  // which is the precise failure the gate exists to prevent.
  addSuite(work, 'trunk', 'job-7-r2');
  addSuite(work, 'trunk', 'job-8');
  addSuite(work, 'trunk', 'job-9', { asFile: true });
  const { res } = run(work, remote, [issue('job-7'), issue('job-8'), issue('job-9')]);
  check('G3a a sibling whose name merely EXTENDS the id does not make it dispatchable',
    res.ok === true && !has(res.issues, 'job-7') && has(res.undispatchable, 'job-7'));
  check('G3b the exact directory dispatches', res.ok === true && has(res.issues, 'job-8'));
  check('G3c a regular file at the suite path is refused — the `-d` is load-bearing',
    res.ok === true && has(res.undispatchable, 'job-9'));
});

// =======================================================================================
// G4 — the bound: applied to the spawn, built from ONE place, validated at config load
// =======================================================================================
guarded('G4', () => {
  const opts = queue.gitSpawnOptions(cfgFor({ gitTimeoutMs: 4321 }));
  check('G4a gitSpawnOptions honours an explicit bound',
    opts.timeout === 4321 && !!opts.killSignal);
  check('G4b the kill signal is SIGKILL — a bound a wedged process can decline is not a bound',
    opts.killSignal === 'SIGKILL');
  // Junk must DEFAULT rather than reach spawnSync, where 0 means "no timeout" and a
  // fractional value fails late and obscurely.
  const junk = [0, -1, 1.5, '60000', null, NaN, Infinity, undefined];
  check('G4c every non-positive-integer bound falls back to the default',
    junk.every((v) => queue.gitSpawnOptions(cfgFor({ gitTimeoutMs: v })).timeout
      === queue.DEFAULT_GIT_TIMEOUT_MS));
  check('G4d gitSpawnOptions survives no config at all',
    queue.gitSpawnOptions(undefined).timeout === queue.DEFAULT_GIT_TIMEOUT_MS
      && queue.gitSpawnOptions(null).timeout === queue.DEFAULT_GIT_TIMEOUT_MS);
  check('G4e `extra` wins, so a call site can still add cwd or env',
    queue.gitSpawnOptions(cfgFor({}), { cwd: '/x' }).cwd === '/x');

  // STRUCTURAL, and the whole value of the runner/bd.js `spawnOptions` precedent: an
  // exported builder that some spawn ignores is scaffolding. Behavioural checks cannot see
  // a NEW unbounded spawn added beside the bounded ones.
  const src = fs.readFileSync(QUEUE_SRC, 'utf8');
  const sites = src.split('\n')
    .map((l, i) => ({ line: l.trim(), n: i + 1 }))
    .filter((l) => /spawnSync\s*\(/.test(l.line) && !l.line.startsWith('//'));
  check('G4f runner/queue.js still spawns at all (the scan is not vacuous)', sites.length >= 1);
  check('G4g every spawnSync in runner/queue.js is built from gitSpawnOptions',
    sites.length >= 1 && sites.every((l) => /gitSpawnOptions\s*\(/.test(l.line)));

  // Validated by name, before a run starts, exactly as bdTimeoutMs is.
  const cdir = tmp('g4cfg');
  const write = (o) => {
    const f = path.join(cdir, `run.config.${Math.abs(o.gitTimeoutMs === undefined ? 0 : 1)}-${String(o.gitTimeoutMs).replace(/\W/g, '')}.json`);
    fs.writeFileSync(f, JSON.stringify({
      targetRepoPath: cdir, targetRepoRemote: 'https://example.invalid/r.git',
      image: 'x:local', ...o,
    }));
    return f;
  };
  const rejects = (v) => {
    try { loadConfig(write({ gitTimeoutMs: v })); return false; }
    catch (e) { return /gitTimeoutMs/.test(e.message); }
  };
  check('G4h loadConfig rejects a zero, negative, fractional or non-numeric gitTimeoutMs',
    [0, -5, 1.5, '60000'].every(rejects));
  let loaded = null;
  try { loaded = loadConfig(write({ gitTimeoutMs: 90000 })); } catch { /* reported */ }
  check('G4i loadConfig accepts a positive whole gitTimeoutMs', !!loaded && loaded.gitTimeoutMs === 90000);
  let dflt = null;
  try { dflt = loadConfig(write({})); } catch { /* reported */ }
  check('G4j an absent gitTimeoutMs defaults to 60000, and DEFAULTS says so',
    !!dflt && dflt.gitTimeoutMs === 60000 && DEFAULTS.gitTimeoutMs === 60000);
  check('G4k run.config.example.json carries gitTimeoutMs at its default, as bdTimeoutMs is',
    EXAMPLE.gitTimeoutMs === DEFAULTS.gitTimeoutMs);
});

// =======================================================================================
// G5 — laziness, cleanup, and leaving the operator's working copy alone
// =======================================================================================
guarded('G5', () => {
  const base = tmp('g5');
  const remote = mkBare(path.join(base, 'r.git'), 'trunk');
  const work = mkWork(path.join(base, 'w'), remote, 'trunk',
    { verifyCommand: 'sh tools/run-acceptance.sh', defaultBranch: 'trunk' });
  addSuite(work, 'trunk', 'live');
  const gone = path.join(base, 'never.git');

  // LAZY: an unreachable remote plus nothing to dispatch is not an abort. An eager gate
  // turns the normal state of a drained project into an exit-1 failure.
  check('G5a an empty queue neither fetches nor aborts', run(work, gone, []).res.ok === true);
  check('G5b a queue of only excluded types neither fetches nor aborts',
    run(work, gone, [issue('e', { issue_type: 'epic' })]).res.ok === true);
  // ...and an entry whose type is absent, null or '' is a CANDIDATE (the deny-list's
  // back-compat direction), so it does reach the gate and is judged like any other.
  const untyped = run(work, remote, [issue('untyped-x', { issue_type: null })]);
  check('G5c an untyped entry still reaches the gate rather than being skipped',
    untyped.res.ok === true && has(untyped.res.undispatchable, 'untyped-x')
      && !idsOf(untyped.res.skipped).includes('untyped-x'));

  // The throwaway repository is REMOVED — on the happy path and, harder, on the abort path.
  const beforeOk = tmpListing().length;
  run(work, remote, [issue('live')]);
  check('G5d a successful gate leaves no throwaway repository behind', tmpListing().length === beforeOk);
  const beforeBad = tmpListing().length;
  run(work, gone, [issue('live')]);
  check('G5e an ABORTED gate leaves no throwaway repository behind either',
    tmpListing().length === beforeBad);

  // FETCH_HEAD is per-repository state: the working copy an operator is using must be
  // untouched, refs, tree and .git contents alike.
  const snap = () => `${git(work, ['show-ref']).stdout || ''}|`
    + `${git(work, ['status', '--porcelain']).stdout || ''}|`
    + `${fs.readdirSync(path.join(work, '.git')).sort().join(',')}`;
  const pre = snap();
  run(work, remote, [issue('live'), issue('dead')]);
  check('G5f the gate leaves the target working copy refs, tree and .git contents unchanged',
    snap() === pre);
});

// =======================================================================================
// G6 — Beads is untouched, and the row is manufactured
// =======================================================================================
guarded('G6', () => {
  const base = tmp('g6');
  const remote = mkBare(path.join(base, 'r.git'), 'trunk');
  const work = mkWork(path.join(base, 'w'), remote, 'trunk',
    { verifyCommand: 'sh tools/run-acceptance.sh', defaultBranch: 'trunk' });
  addSuite(work, 'trunk', 'yes-1');
  const { res, argv } = run(work, remote, [issue('yes-1'), issue('no-1'), issue('no-2')]);
  const verbs = argv.map((a) => a.join(' '));
  check('G6a exactly one `ready` reached the bd seam',
    verbs.filter((v) => /\bready\b/.test(v)).length === 1);
  check('G6b no bd write of any kind reached the seam',
    !verbs.some((v) => /\b(update|note|close|create|remember|import|sync|dolt)\b/.test(v)));
  check('G6c one entry per refusal, each carrying its issue and a non-empty reason',
    res.ok === true && res.undispatchable.length === 2
      && res.undispatchable.every((u) => u.issue && typeof u.reason === 'string' && u.reason.length > 0));

  const row = queue.undispatchableRow(res.undispatchable[0].issue, res.undispatchable[0].reason, 'run-9');
  check('G6d the row carries the id, the title and the outcome',
    row.issueId === 'no-1' && row.title === 't no-1' && row.outcome === 'undispatchable');
  check('G6e the attempt note names the run and the remedy path',
    Array.isArray(row.attemptNotes) && row.attemptNotes.length === 1
      && /run-9/.test(row.attemptNotes[0]) && /tests\/acceptance\/no-1/.test(row.attemptNotes[0]));
  check('G6f the row carries a change summary, so the report body says what to do',
    typeof row.changeSummary === 'string' && /tests\/acceptance\/no-1/.test(row.changeSummary));
  // additionalProperties:false — a field the schema does not know invalidates the manifest.
  const allowed = new Set(Object.keys(JSON.parse(
    fs.readFileSync(path.join(ROOT, 'schemas', 'run.schema.json'), 'utf8')
  ).properties.tasks.items.properties));
  check('G6g every field of the manufactured row is a field run.schema.json declares',
    Object.keys(row).every((k) => allowed.has(k)));
  check('G6h `undispatchable` is in the schema enum',
    JSON.parse(fs.readFileSync(path.join(ROOT, 'schemas', 'run.schema.json'), 'utf8'))
      .properties.tasks.items.properties.outcome.enum.includes('undispatchable'));
  // The function is PURE: it reads its runId from the argument, not from a module global,
  // so two calls with different runs cannot share one answer.
  check('G6i undispatchableRow is pure in its runId',
    queue.undispatchableRow(issue('z'), 'r', 'A').attemptNotes[0]
      !== queue.undispatchableRow(issue('z'), 'r', 'B').attemptNotes[0]);
});

// =======================================================================================
// G7 — the summary line: appended to, never rewoven
// =======================================================================================
guarded('G7', () => {
  const dispatchable = [issue('x-one'), issue('x-two', { issue_type: 'bug' })];
  const skipped = [issue('e-one', { issue_type: 'epic' })];
  const historic = 'ready queue: 2 task(s) — x-one, x-two; skipped 1 by type: e-one (epic); running 1 non-task: x-two (bug)';
  check('G7a with no refusals the line is byte-identical to the historic one',
    queue.queueSummary(dispatchable, skipped, []) === historic);
  check('G7b and identical again when the third argument is omitted entirely',
    queue.queueSummary(dispatchable, skipped) === historic);
  check('G7c an empty queue still reads `(empty)`',
    queue.queueSummary([], [], []) === 'ready queue: 0 task(s) — (empty)');

  const refused = [{ issue: issue('r-one'), reason: 'no suite' }, { issue: issue('r-two'), reason: 'no suite' }];
  const line = queue.queueSummary(dispatchable, skipped, refused);
  check('G7d the historic line is a PREFIX of the one carrying refusals',
    line.startsWith(historic));
  check('G7e the refusal clause names every refused id and the remedy path',
    line.includes('r-one') && line.includes('r-two') && line.includes('tests/acceptance'));
  check('G7f no refused id reaches the segment the dashboard parses',
    !line.split(';')[0].includes('r-one') && !line.split(';')[0].includes('r-two'));

  // The dashboard reads ids from the first ` — ` to the first `;` and is DOWNSTREAM of this
  // wording. It is required here rather than trusted, because an appended clause that leaked
  // into that list would render refused tasks as queued.
  const dash = require(path.join(ROOT, 'scripts', 'dashboard.js'));
  check('G7g the dashboard id parser returns only the dispatchable ids',
    dash.readyQueueIds([{ msg: line }]).join(',') === 'x-one,x-two');
});

// =======================================================================================
// G8 — the report and the manifest
// =======================================================================================
guarded('G8', () => {
  const rows = [
    { issueId: 'a-done', outcome: 'done', attempts: 1 },
    { issueId: 'b-paused', outcome: 'paused' },
    { issueId: 'c-failed', outcome: 'failed' },
    { issueId: 'd-partial', outcome: 'partial' },
    { issueId: 'e-tampered', outcome: 'tampered' },
    { issueId: 'f-stuck', outcome: 'stuck' },
    { issueId: 'g-undisp', outcome: 'undispatchable' },
    { issueId: 'h-unknown', outcome: 'whatever' },
  ];
  const dir = tmp('g8');
  const { manifest } = report.writeManifest(dir, {
    runId: 'r', startedAt: 'x', finishedAt: 'y', tasks: rows,
  });
  const order = manifest.tasks.map((t) => t.outcome);
  check('G8a undispatchable ranks immediately after tampered',
    order.indexOf('undispatchable') === order.indexOf('tampered') + 1);
  check('G8b the six existing outcomes keep their relative order',
    order.indexOf('tampered') < order.indexOf('stuck')
      && order.indexOf('stuck') < order.indexOf('partial')
      && order.indexOf('partial') < order.indexOf('failed')
      && order.indexOf('failed') < order.indexOf('paused')
      && order.indexOf('paused') < order.indexOf('done'));
  check('G8c the unknown-outcome fallback was not re-homed — it still shares `failed`\'s rank',
    order.indexOf('whatever') === order.indexOf('failed') + 1);

  const md = report.renderReport(manifest);
  check('G8d the heading uses a label of its own, not the bare outcome word',
    /##\s+g-undisp\s+—\s+UNDISPATCHABLE\s+—\s+\S/.test(md));
  check('G8e the section names the remedy path for THAT issue, from a row carrying nothing else',
    md.includes('tests/acceptance/g-undisp/'));
  check('G8f the section says Beads was not touched and the issue is still open',
    /Beads was never touched/i.test(md) && /still `open`/.test(md));
  // Every other outcome's section is unchanged: the block is keyed on the outcome, so a row
  // that is not undispatchable must not gain a remedy paragraph.
  const doneSection = md.slice(md.indexOf('## a-done'));
  check('G8g no other outcome gained the remedy paragraph', !/Not dispatched/.test(doneSection));
});

// =======================================================================================
// G9 [structural] — runner/run.js's seams, which no Docker-free test can execute
// =======================================================================================
// main() sits behind loadToken and the Docker preflight. These three facts are therefore
// only assertable as source facts, and each is one an ordinary refactor removes silently.
guarded('G9', () => {
  const src = fs.readFileSync(RUN_SRC, 'utf8');
  const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  check('G9a run.js branches on the `cause` FIELD, not on message wording',
    /q\.cause\s*===\s*'git'/.test(code));
  check('G9b the Beads channel still says what it always said',
    code.includes('cannot read the Beads ready queue'));
  // The branch's OWN message, sliced out between the test and the `else` that follows it:
  // a fetch failure reported under the Beads wording sends a person to the wrong system,
  // which is the entire reason the cause field exists rather than a message prefix.
  const at = code.indexOf("q.cause === 'git'");
  const gitBranch = at < 0 ? '' : code.slice(at, code.indexOf('} else {', at));
  check('G9c the git channel says nothing about Beads',
    !!gitBranch && !/Beads|\bbd\b/.test(gitBranch) && /log\.error\(/.test(gitBranch));
  // The third population reaches the summary line THROUGH `logQueueRead` since change-log row
  // `repo-3xw`: the prose line and its `queue.read` ledger twin are written by one call from
  // one timestamp, so `run.js` no longer calls `queueSummary` itself — two call sites would be
  // two chances for the line and the event to describe different queues. The property this
  // check has always guarded is unchanged and now spans two files, so it is asserted in both:
  // `run.js` hands over the WHOLE queue result, and the helper hands all three populations to
  // `queueSummary`. Asserting only the first would pass a helper that dropped the refusals.
  check('G9d run.js hands the whole queue result — third population included — to logQueueRead',
    /logQueueRead\(\s*log\s*,\s*q\s*\)/.test(code) && !/queueSummary\(/.test(code));
  {
    const qsrc = fs.readFileSync(path.join(ROOT, 'runner', 'queue.js'), 'utf8')
      .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    check('G9d\' ...and logQueueRead passes all three populations on to the summary line',
      /queueSummary\(\s*issues\s*,\s*skipped\s*,\s*refused\s*\)/.test(qsrc)
      && /q\.undispatchable/.test(qsrc));
  }
  check('G9e refused rows are manufactured through the exported pure function',
    /undispatchableRow\(/.test(code) && /require\('\.\/queue'\)/.test(src));
  check('G9f the manufactured rows reach the manifest',
    /tasks:\s*\[\s*\.\.\.results,\s*\.\.\.refusedRows\s*\]/.test(code));
  check('G9g the drain\'s closing line names the refusals too',
    /queue drained[\s\S]{0,120}refusedRows/.test(code));
});

process.exit(failed);
