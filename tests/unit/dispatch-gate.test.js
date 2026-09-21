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
//
// §4.12's THIRD admission rule — the receipt (change-log row `repo-isq`) — is covered by G10
// and G11 below. Two things about those fixtures are load-bearing rather than incidental:
//
//   EVERY RECEIPT HERE IS WRITTEN BY `runner/suite-hash.js`, never by a formula this file
//   carries. A second copy of the formula would agree with a wrong implementation and disagree
//   with the gate, which is the one failure mode the shared module exists to make impossible.
//   `addSuite` therefore hashes the suite the way the freeze gate does — over the WORKING TREE,
//   before the commit — and the gate under test hashes the branch; the fixtures pass only if
//   the two sides genuinely agree.
//
//   THE BRANCH-NOT-WORKING-COPY PAIR IS REPEATED HERE (G10i/G10j), because it is the only
//   fixture shape that separates a gate reading FETCH_HEAD from one reading the operator's
//   desk. Every other receipt fixture in this file has the two agree — an implementation that
//   hashed `targetRepoPath` would pass all of them, and would then refuse a correctly frozen
//   queue the moment anyone edited a test file while a run was in flight.
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
// The SHARED formula, and the freeze gate's own version constant. Both are required rather
// than retyped: a receipt this file computed itself would agree with a wrong gate.
const { suiteHash, workingTreeEntries, RECEIPT_NAME } = require(path.join(ROOT, 'runner', 'suite-hash.js'));
const { RECEIPT_VERSION } = require(path.join(ROOT, 'scripts', 'freeze-gate.js'));

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
// A receipt for the suite AS IT STANDS IN THE WORKING COPY, written the way
// `scripts/freeze-gate.js` writes one: the shared formula, over the working tree, before the
// commit. `over` replaces fields — that is how the malformed-receipt fixtures are built — and
// a string body is written verbatim, for the truncated-JSON case.
function writeReceipt(work, id, over = {}) {
  const dir = path.join(work, 'tests', 'acceptance', id);
  const body = typeof over === 'string' ? over : `${JSON.stringify({
    gateVersion: RECEIPT_VERSION,
    verdict: 'red',
    probeSupplied: true,
    suiteHash: suiteHash(workingTreeEntries(work, `tests/acceptance/${id}`)),
    gateHead: null,
    guards: null,
    brittleness: 0,
    writtenAt: '2026-08-28T00:00:00.000Z',
    ...over,
  }, null, 2)}\n`;
  fs.writeFileSync(path.join(dir, RECEIPT_NAME), body);
}

// `receipt` is the receipt's overrides (the default is a matching `red` one, which is what a
// gated suite carries), `null` for a suite the gate never blessed, or a raw string body.
function addSuite(work, branch, id, { push = true, asFile = false, receipt = {} } = {}) {
  const p = path.join(work, 'tests', 'acceptance', id);
  if (asFile) { mk(path.dirname(p)); fs.writeFileSync(p, 'not a directory\n'); }
  else {
    mk(p);
    fs.writeFileSync(path.join(p, 'test.js'), 'process.exit(1);\n');
    if (receipt !== null) writeReceipt(work, id, receipt);
  }
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

  // THE LINE NOW LEADS WITH THE COUNT THAT MATTERS (change-log row `refused-exit-design`).
  // It used to open `ready queue: 2 task(s)`, which is true and, on the runs this exists for,
  // useless: a queue of eight that dispatched none of them read `0 task(s) — (empty)`, and
  // *empty* is the first word a skimming operator takes in while the load-bearing half waits
  // after a semicolon at the end of a long line. Three consecutive runs were read that way.
  const clean = 'ready queue: 2 of 2 dispatchable — x-one, x-two; skipped 1 by type: e-one (epic); running 1 non-task: x-two (bug)';
  check('G7a with no refusals the total equals the dispatchable count',
    queue.queueSummary(dispatchable, skipped, []) === clean);
  check('G7b and identical again when the third argument is omitted entirely',
    queue.queueSummary(dispatchable, skipped) === clean);
  check('G7c a genuinely empty queue says so as 0 of 0, and never claims a refusal',
    queue.queueSummary([], [], []) === 'ready queue: 0 of 0 dispatchable — (none)');

  const refused = [{ issue: issue('r-one'), refusal: 'no-suite', reason: 'no suite' },
    { issue: issue('r-two'), refusal: 'no-receipt', reason: 'no receipt' }];
  const line = queue.queueSummary(dispatchable, skipped, refused);
  check('G7d the denominator counts the refused candidates, so 2 of 4 is visible at a glance',
    line.startsWith('ready queue: 2 of 4 dispatchable — x-one, x-two;'));
  check('G7e the refusal clause names every refused id',
    line.includes('r-one') && line.includes('r-two'));
  // BY KIND, which the third admission rule deliberately left to this task: a receipt that was
  // never pushed and a suite edited after the gate blessed it send a person to different places,
  // and one sentence naming only the common case sends them to the wrong one.
  check('G7f the clause names the refusal kinds, not just a count',
    /NOT DISPATCHABLE 2 \(no-suite, no-receipt\)/.test(line));
  check('G7g and the remedy is a command the reader can type, not a description of one',
    line.includes('scripts/freeze.js status') && line.includes('scripts/freeze.js commit'));

  // THE ID SLOT IS THE CONTRACT. `scripts/dashboard.js` finds the first ` — ` and reads ids up
  // to the first `;`, and every log already on disk is parsed by that same reader — so the words
  // before the dash could move and the slot after it could not. Both halves are asserted here
  // because the wording change that broke either would look harmless in a diff.
  check('G7h no refused id reaches the segment the dashboard parses',
    !line.split(';')[0].includes('r-one') && !line.split(';')[0].includes('r-two'));
  {
    const D = require(path.join(ROOT, 'scripts', 'dashboard.js'));
    const ev = (msg) => ({ msg, issueId: 'preflight' });
    check('G7i the dashboard still reads the dispatchable ids out of the new wording',
      D.readyQueueIds([ev(line)]).join(',') === 'x-one,x-two');
    check('G7j and reads no id at all out of a wholly-refused queue',
      D.readyQueueIds([ev(queue.queueSummary([], [], refused))]).length === 0);
  }

  // ---- the exit code, as the pure function the design names -------------------------------
  // A run that read eight ready issues and dispatched none exited 0, which no script could tell
  // from a run with nothing to do. Narrow on purpose: an empty queue is a legitimate no-op and
  // must stay 0, or the code means nothing on a drained project — which is most days.
  check('G7k a queue that dispatched nothing but refused something exits 4',
    queue.queueExitCode(0, 8) === 4);
  check('G7l a genuinely empty queue is still a no-op at 0',
    queue.queueExitCode(0, 0) === 0);
  check('G7m and any dispatch at all is a run that did work, however much it refused',
    queue.queueExitCode(1, 7) === 0 && queue.queueExitCode(8, 0) === 0);
  // 4 and not 2: 2 is already a bad config and a missing token, and an exit code that means two
  // things means neither.
  check('G7n the code is 4, which is not one already taken by a config or token failure',
    queue.EXIT_NOTHING_DISPATCHABLE === 4);

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

  // THE SIGNAL AUTOMATION NEEDED. A run that refused all eight of its candidates exited 0 and
  // was, to any script, indistinguishable from a run with nothing to do — a lie told to the
  // operator session that launches runs on "go", and the property that turned a missing freeze
  // from a mistake somebody made once into a class that recurs.
  //
  // Through the PURE FUNCTION, never an inline comparison: `main()` sits behind the token load
  // and the Docker preflight, so a condition written there is one no Docker-free test can
  // execute — the same reason `queueSummary` was lifted out of it. The decision itself is
  // asserted at G7k-n, where it can be called rather than read.
  check('G9h the run takes its queue exit code from the exported pure function',
    /queueExitCode\(/.test(code) && /queueExitCode,/.test(src));
  check('G9i and sets it through process.exitCode, so the manifest, report and lock release still happen',
    /process\.exitCode = queueExit/.test(code) && !/process\.exit\(queueExit/.test(code));
  check('G9j and never overwrites an exit code an earlier failure already set',
    /queueExit && !process\.exitCode/.test(code));
  // The counts are recorded as NUMBERS as well as prose. A log can be truncated, rotated or
  // simply unread; a reader comparing two runs of one queue has no other way to tell "there was
  // nothing to do" from "there was work and none of it could start".
  const sourceAt = code.indexOf('createFeedSource(');
  const manifestAt = code.indexOf('writeManifest(', sourceAt);
  const sourceBlock = sourceAt < 0 || manifestAt < 0 ? '' : code.slice(sourceAt, manifestAt);
  const manifestBlock = manifestAt < 0 ? '' : code.slice(manifestAt);
  check('G9k the queue counts reach the manifest',
    /queue: queueCounts/.test(manifestBlock)
    && !/queue: queueCounts/.test(sourceBlock)
    && /ready: results\.length \+ stillRefused\.length/.test(code)
    && /refused: stillRefused\.length/.test(code));
  check('G9l queueCounts is declared before the manifest consumes it',
    code.indexOf('const queueCounts') >= 0
    && manifestAt > code.indexOf('const queueCounts'));
  const queueSchema = JSON.parse(fs.readFileSync(path.join(ROOT, 'schemas', 'run.schema.json'), 'utf8'))
    .properties.queue;
  check('G9m the closed run manifest schema admits all three final queue counts',
    !!queueSchema && queueSchema.additionalProperties === false
    && ['ready', 'dispatched', 'refused'].every((name) =>
      queueSchema.required.includes(name)
      && queueSchema.properties[name].type === 'integer'
      && queueSchema.properties[name].minimum === 0));
});

// =======================================================================================
// G10 — §4.12's THIRD admission rule: the freeze receipt
// =======================================================================================
// The second rule proves a suite is PRESENT; this one proves it was GATED. Every fixture below
// is a suite that the second rule admits, so nothing here can pass by accident on the older
// check — and each one is refused for a DIFFERENT reason, because a single "not dispatchable"
// verdict over four causes sends three readers in four to the wrong remedy.
guarded('G10', () => {
  const base = tmp('g10');
  const cfg = { verifyCommand: 'sh tools/run-acceptance.sh', defaultBranch: 'trunk' };
  const remote = mkBare(path.join(base, 'r.git'), 'trunk');
  const work = mkWork(path.join(base, 'w'), remote, 'trunk', cfg);

  addSuite(work, 'trunk', 'gated');                                  // a matching red receipt
  addSuite(work, 'trunk', 'ungated', { receipt: null });             // no receipt at all
  addSuite(work, 'trunk', 'halfp', { receipt: { verdict: 'half-proven', probeSupplied: false } });
  addSuite(work, 'trunk', 'verd', { receipt: { verdict: 'green' } });
  addSuite(work, 'trunk', 'vers', { receipt: { gateVersion: 99 } });
  addSuite(work, 'trunk', 'trunc', { receipt: '{"gateVersion": 1, "verdict": "red", "suiteHa' });
  addSuite(work, 'trunk', 'nohash', { receipt: { suiteHash: true } });
  // Gated, then edited and pushed without re-running the gate — the shape the rule exists for.
  addSuite(work, 'trunk', 'moved');
  fs.appendFileSync(path.join(work, 'tests', 'acceptance', 'moved', 'test.js'), '// after the gate\n');
  git(work, ['add', '-A']); git(work, ['commit', '-qm', 'edit moved']); git(work, ['push', '-q', 'origin', 'trunk']);

  const ids = ['gated', 'ungated', 'halfp', 'verd', 'vers', 'trunc', 'nohash', 'moved', 'never-frozen'];
  const { res, argv } = run(work, remote, ids.map((i) => issue(i)));
  const kindOf = (id) => {
    const u = (res.undispatchable || []).find((x) => x.issue && x.issue.id === id);
    return u ? u.refusal : null;
  };
  const reasonOf = (id) => {
    const u = (res.undispatchable || []).find((x) => x.issue && x.issue.id === id);
    return (u && u.reason) || '';
  };

  check('G10a the gate still answers with all nine candidates judged',
    res.ok === true && res.issues.length + res.undispatchable.length === 9);
  check('G10b a suite carrying a matching red receipt is DISPATCHED',
    has(res.issues, 'gated') && !has(res.undispatchable, 'gated'));
  check('G10c a suite the gate never blessed is refused `no-receipt`',
    kindOf('ungated') === 'no-receipt' && /no freeze receipt/.test(reasonOf('ungated')));
  check('G10c1 an ungated suite carries its receipt-independent content identity for planning',
    /^[0-9a-f]{64}$/.test(((res.undispatchable || [])
      .find((x) => x.issue && x.issue.id === 'ungated') || {}).suiteHash || ''));
  check('G10d a suite edited after its receipt was written is refused `receipt-mismatch`',
    kindOf('moved') === 'receipt-mismatch' && /receipt does not match/.test(reasonOf('moved')));
  check('G10e a half-proven receipt is refused `half-proven` by default',
    kindOf('halfp') === 'half-proven' && /half-proven/.test(reasonOf('halfp')));
  // The three malformed shapes are ONE refusal, not three: a receipt the runner cannot
  // interpret is a receipt it does not have, and reading one anyway is how a suite nobody
  // gated reaches a container.
  check('G10f a receipt of an unknown VERDICT is `no-receipt`, never a pass',
    kindOf('verd') === 'no-receipt' && !has(res.issues, 'verd'));
  check('G10g a receipt of an unknown gateVersion is `no-receipt`',
    kindOf('vers') === 'no-receipt' && !has(res.issues, 'vers'));
  check('G10h truncated JSON is `no-receipt`', kindOf('trunc') === 'no-receipt');
  // ...and a receipt whose hash field is not a digest is `no-receipt` rather than
  // `receipt-mismatch`: a junk hash compares unequal to everything, so the lazy reading would
  // send a person to re-gate a suite whose real problem is the receipt beside it.
  check('G10i a receipt recording no usable suite hash is `no-receipt`, not a mismatch',
    kindOf('nohash') === 'no-receipt');
  // CHECK ORDER: suite -> receipt -> hash -> verdict, first refusal wins. A suite that is
  // absent has no receipt either, and naming the downstream symptom would send a person to run
  // a gate over a directory that does not exist.
  check('G10j an absent suite is still `no-suite`, not `no-receipt`',
    kindOf('never-frozen') === 'no-suite' && /no frozen acceptance suite/.test(reasonOf('never-frozen')));
  check('G10k every refusal carries one of the four declared kinds',
    (res.undispatchable || []).every((u) => queue.REFUSAL
      && Object.values(queue.REFUSAL).includes(u.refusal)));
  const enumOf = JSON.parse(fs.readFileSync(path.join(ROOT, 'schemas', 'run.schema.json'), 'utf8'))
    .properties.tasks.items.properties.refusal.enum;
  check('G10l the four kinds are exactly run.schema.json\'s `refusal` enum',
    [...Object.values(queue.REFUSAL)].sort().join() === [...enumOf].sort().join());
  check('G10m no bd write of any kind reached the seam while refusing them',
    !argv.map((a) => a.join(' ')).some((v) => /\b(update|note|close|create|remember)\b/.test(v)));

  // allowHalfProven moves EXACTLY ONE of them. A knob that also admitted an ungated or a
  // changed suite would be an off switch for the whole rule wearing the name of one refusal.
  const on = run(work, remote, ids.map((i) => issue(i)), { allowHalfProven: true }).res;
  check('G10n with allowHalfProven the half-proven suite dispatches',
    on.ok === true && has(on.issues, 'halfp'));
  check('G10o ...and nothing else moves — the other refusals are unchanged',
    on.ok === true
      && (on.undispatchable || []).map((u) => `${u.issue.id}:${u.refusal}`).sort().join()
        === (res.undispatchable || []).filter((u) => u.issue.id !== 'halfp')
          .map((u) => `${u.issue.id}:${u.refusal}`).sort().join());

  // The throwaway repository is still removed on the receipt paths, which now read the tree
  // twice more per candidate — the easiest place for an early `return` to skip a `finally`.
  const before = tmpListing().length;
  run(work, remote, [issue('ungated'), issue('moved')]);
  check('G10p a run that refuses on the receipt leaves no throwaway repository behind',
    tmpListing().length === before);
});

// =======================================================================================
// G10b — the branch, never the operator's working copy
// =======================================================================================
// The ONE fixture shape that separates this design from a gate reading `targetRepoPath`. Every
// other receipt fixture has the two agree, so an implementation hashing the working copy passes
// all of them — and then refuses a correctly frozen queue the moment anyone edits a test file
// while a run is in flight, which is the normal state of a planning session beside a fed run.
guarded('G10-branch', () => {
  const base = tmp('g10b');
  const cfg = { verifyCommand: 'sh tools/run-acceptance.sh', defaultBranch: 'trunk' };
  const remote = mkBare(path.join(base, 'r.git'), 'trunk');
  const work = mkWork(path.join(base, 'w'), remote, 'trunk', cfg);
  addSuite(work, 'trunk', 'pair');

  // (a) the branch matches its receipt; the working copy carries an uncommitted edit.
  fs.appendFileSync(path.join(work, 'tests', 'acceptance', 'pair', 'test.js'), '// uncommitted\n');
  const a = run(work, remote, [issue('pair')]).res;
  check('G10q an uncommitted working-copy edit does not refuse a branch that matches its receipt',
    a.ok === true && has(a.issues, 'pair'));

  // (b) the mirror: the working copy is pristine at the receipt's hash, and the BRANCH moved.
  git(work, ['checkout', '--', 'tests/acceptance/pair/test.js']);
  const other = mk(path.join(base, 'other'));
  git(other, ['clone', '-q', remote, '.']);
  fs.appendFileSync(path.join(other, 'tests', 'acceptance', 'pair', 'test.js'), '// pushed from elsewhere\n');
  git(other, ['add', '-A']); git(other, ['commit', '-qm', 'one more byte']); git(other, ['push', '-q', 'origin', 'trunk']);
  const b = run(work, remote, [issue('pair')]).res;
  check('G10r a pristine working copy does not admit a branch whose suite moved past its receipt',
    b.ok === true && !has(b.issues, 'pair')
      && (b.undispatchable[0] || {}).refusal === 'receipt-mismatch');
});

// =======================================================================================
// G11 — the kind travels: the row, the schema, the report, the config, the call sites
// =======================================================================================
guarded('G11', () => {
  const props = JSON.parse(fs.readFileSync(path.join(ROOT, 'schemas', 'run.schema.json'), 'utf8'))
    .properties.tasks.items.properties;
  const kinds = Object.values(queue.REFUSAL);
  const rows = kinds.map((k) => queue.undispatchableRow(issue('x-1'), `because ${k}`, 'run-2', k));
  check('G11a every kind produces a row carrying it, and only schema-declared keys',
    rows.length === 4 && rows.every((r, i) => r.refusal === kinds[i]
      && r.outcome === 'undispatchable' && Object.keys(r).every((key) => key in props)));
  const legacy = queue.undispatchableRow(issue('x-1'), 'because', 'run-2');
  check('G11b a row asked for no kind carries no `refusal` key at all',
    !('refusal' in legacy) && legacy.outcome === 'undispatchable');
  check('G11c an unknown kind falls back rather than travelling into the manifest',
    !('refusal' in queue.undispatchableRow(issue('x-1'), 'because', 'run-2', 'invented')));
  check('G11d the four remedies are pairwise distinct',
    new Set(rows.map((r) => r.changeSummary)).size === 4);
  // Each kind's remedy names ITS OWN fix and no other kind's. A shared sentence would be four
  // ways of telling a reader to do the wrong thing three times.
  const md = (row) => report.renderReport({
    runId: 'r', startedAt: 'a', finishedAt: 'b', targetRepo: 'x', tasks: [row],
  });
  const byKind = Object.fromEntries(rows.map((r) => [r.refusal, md(r)]));
  check('G11e the no-suite report says freeze the suite and never mentions the gate',
    /freeze/i.test(byKind['no-suite']) && !/freeze gate/i.test(byKind['no-suite']));
  check('G11f the no-receipt and receipt-mismatch reports send the reader to the freeze gate',
    /run the freeze gate/i.test(byKind['no-receipt'])
      && /freeze gate/i.test(byKind['receipt-mismatch']));
  check('G11g ...and neither offers the half-proven escape hatch',
    !/--green|allowHalfProven/.test(byKind['no-receipt'])
      && !/--green|allowHalfProven/.test(byKind['receipt-mismatch']));
  check('G11h the half-proven report names the probe and the knob, and claims no missing suite',
    /--green/.test(byKind['half-proven']) && /allowHalfProven/.test(byKind['half-proven'])
      && !/no frozen/i.test(byKind['half-proven']));
  check('G11i the four headings are distinct',
    new Set(Object.values(byKind).map((m) => (m.split('\n').find((l) => /^## x-1 /.test(l)) || ''))).size === 4);
  check('G11j a row with no kind still renders the historic sentence',
    /no frozen acceptance suite on the integration branch/.test(md(legacy)));

  // The reader's half of a constant whose writer's half lives in scripts/freeze-gate.js. Two
  // constants that must overlap and cannot see each other drift in silence — the receipt would
  // then be written in a version the runner refuses, and every freeze would read `no-receipt`.
  check('G11k the runner understands the version the freeze gate writes',
    queue.KNOWN_GATE_VERSIONS instanceof Set && queue.KNOWN_GATE_VERSIONS.has(RECEIPT_VERSION));
  check('G11l the accepted verdicts are exactly the two the gate writes a receipt for',
    [...queue.RECEIPT_VERDICTS].sort().join() === 'half-proven,red');

  // The formula is IMPORTED, never re-derived: `runner/queue.js` must not grow a digest of its
  // own, because a second copy would agree with a wrong gate and disagree with the real one.
  const qsrc = fs.readFileSync(QUEUE_SRC, 'utf8');
  check('G11m runner/queue.js requires the shared formula and computes no hash of its own',
    /require\('\.\/suite-hash'\)/.test(qsrc) && !/createHash/.test(qsrc));

  // Config: the knob is validated by name, defaults to false, and ships in the example.
  const cdir = tmp('g11cfg');
  const write = (o, tag) => {
    const f = path.join(cdir, `run.config.${tag}.json`);
    fs.writeFileSync(f, JSON.stringify({
      targetRepoPath: cdir, targetRepoRemote: 'https://example.invalid/r.git', image: 'x:local', ...o,
    }));
    return f;
  };
  const rejects = (v, tag) => {
    try { loadConfig(write({ allowHalfProven: v }, tag)); return false; }
    catch (e) { return /allowHalfProven/.test(e.message); }
  };
  check('G11n loadConfig rejects a non-boolean allowHalfProven BY NAME',
    ['yes', 1, 0, null, []].every((v, i) => rejects(v, `bad${i}`)));
  let dflt = null; let on = null;
  try { dflt = loadConfig(write({}, 'dflt')); on = loadConfig(write({ allowHalfProven: true }, 'on')); }
  catch { /* reported below */ }
  check('G11o an absent allowHalfProven loads as false, and DEFAULTS says so',
    !!dflt && dflt.allowHalfProven === false && DEFAULTS.allowHalfProven === false);
  check('G11p an explicit true survives the load', !!on && on.allowHalfProven === true);
  check('G11q run.config.example.json carries the knob at its default',
    EXAMPLE.allowHalfProven === DEFAULTS.allowHalfProven);
  check('G11r the manifest schema declares it top-level as a boolean',
    JSON.parse(fs.readFileSync(path.join(ROOT, 'schemas', 'run.schema.json'), 'utf8'))
      .properties.allowHalfProven.type === 'boolean');

  // run.js's two call sites, structural for the usual reason: main() sits behind the token load
  // and the Docker preflight, so neither is executable by any Docker-free test. A kind dropped
  // at the first is a report that names the wrong remedy; the second is the only record of
  // which rule the run applied.
  const rsrc = fs.readFileSync(RUN_SRC, 'utf8').split('\n')
    .filter((l) => !l.trim().startsWith('//')).join('\n');
  check('G11s run.js passes the refusal kind into the manufactured row',
    /undispatchableRow\(u\.issue,\s*u\.reason,\s*log\.runId,\s*u\.refusal\)/.test(rsrc));
  check('G11t run.js records the effective allowHalfProven in the manifest',
    /allowHalfProven:\s*cfg\.allowHalfProven/.test(rsrc));

  // And the feed, which is what carries the kind from the gate to the row across a whole run.
  const feed = require(path.join(ROOT, 'runner', 'feed.js'));
  const src = feed.createFeedSource([], {
    poll: () => ({ ok: true, issues: [], undispatchable: [] }),
    undispatchable: [{ issue: issue('f-1'), reason: 'no freeze receipt', refusal: 'no-receipt' },
      { issue: issue('f-2'), reason: 'no frozen acceptance suite' }],
  });
  const left = src.undispatchable();
  check('G11u the feed carries the kind through, and invents none where there was none',
    left.length === 2 && left[0].refusal === 'no-receipt' && !('refusal' in left[1]));
});

process.exit(failed);
