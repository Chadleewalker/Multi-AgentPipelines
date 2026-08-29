#!/usr/bin/env node
// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// Checks for `scripts/spec-brief.js` — the generated brief (change-log row `spec-brief`).
//
// WHAT THIS SUITE IS ACTUALLY GUARDING. The brief's value is not that it reads well; it is that
// six facts in it are right, and the hand-written version got four of them wrong on its first
// outing. Three of those four produce a gate result that LOOKS like an answer: a binary that is
// not on PATH makes every test false-fail into a red the control fixture certifies as
// discriminating, and a `--repo` aimed at the shared checkout grades a directory that is not
// there. So the assertions below are about the facts, not the prose:
//
//   * the gate is pointed at the WORKTREE, and the shared checkout appears nowhere near it;
//   * the verify command is the target's own and is never defaulted or guessed;
//   * an existing worktree is REUSED — an agent told to create one that exists loses its first
//     move to an error message;
//   * the frozen paths are named, because a criterion naming one ends every attempt as tampered;
//   * the host environment is emitted when the config carries it, and its absence is silent
//     rather than a fabricated export;
//   * the example suite is the most recent real one, never `_control` and never the target's own.
//
// And the three states are told apart from the two places that actually know: the runner's gate
// for what the branch holds, and the working tree for what a session wrote and did not freeze.

'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'spec-brief.js');

let failures = 0;
function check(name, ok) {
  if (ok) console.log(`PASS  ${name}`);
  else { console.log(`FAIL  ${name}`); failures += 1; }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-brief-'));
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ } });

const fwd = (p) => p.split(path.sep).join('/');
const both = (r) => `${r.stdout || ''}${r.stderr || ''}`;

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}
function initRepo(dir, branch) {
  fs.mkdirSync(dir, { recursive: true });
  if (git(dir, ['init', '-q', '--initial-branch', branch, '.']).status !== 0) git(dir, ['init', '-q', '.']);
  for (const kv of [['user.email', 'fixture@test.local'], ['user.name', 'f'], ['commit.gpgsign', 'false'],
    ['core.autocrlf', 'false'], ['core.eol', 'lf']]) git(dir, ['config', ...kv]);
}

// `master`, deliberately: a brief that fell back to a literal `main` would send an agent to fork
// from a branch this project does not have, and every project here that matters uses `master`.
let n = 0;
function makeWorld(opts = {}) {
  n += 1;
  const base = path.join(TMP, `w${n}`);
  const origin = path.join(base, 'origin.git');
  const target = path.join(base, 'target');
  fs.mkdirSync(origin, { recursive: true });
  spawnSync('git', ['init', '-q', '--bare', '--initial-branch', 'master', '.'], { cwd: origin });

  initRepo(target, 'master');
  fs.writeFileSync(path.join(target, 'pipeline.config.json'), JSON.stringify({
    verifyCommand: 'sh tools/run-acceptance.sh',
    defaultBranch: 'master',
    frozenPaths: ['tools/run-acceptance.sh'],
  }, null, 2));
  // An older suite and a newer one, so "most recent" is a claim with a wrong answer available.
  for (const [name, when] of [['app-old', 1], ['app-new', 2]]) {
    const d = path.join(target, 'tests', 'acceptance', name);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, `0${when}-a-check.sh`), '# a check\n');
    fs.utimesSync(d, new Date(2020, 0, when), new Date(2020, 0, when));
  }
  const control = path.join(target, 'tests', 'acceptance', '_control');
  fs.mkdirSync(control, { recursive: true });
  fs.writeFileSync(path.join(control, 'control.js'), 'process.exit(0);\n');
  fs.utimesSync(control, new Date(2030, 0, 1), new Date(2030, 0, 1));   // newest, and never the example
  git(target, ['add', '--', 'pipeline.config.json', 'tests']);
  git(target, ['commit', '-qm', 'fixture']);
  git(target, ['push', '-q', origin, 'HEAD:refs/heads/master']);

  const cfg = {
    targetRepoPath: target, targetRepoRemote: origin, image: 'fixture:latest',
    ...(opts.hostEnv ? { hostEnv: opts.hostEnv } : {}),
  };
  const cfgFile = path.join(base, 'run.config.json');
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2));
  return { base, origin, target, cfgFile };
}

// The bd seam the runner already owns. The main-module path, never the bare word: node resolves
// `show` against its cwd, so `process.argv[1]` is an absolute path ending in `show`.
function bdEnv(world, issues) {
  const stub = path.join(world.base, 'bd-stub.js');
  const file = path.join(world.base, 'issues.json');
  fs.writeFileSync(file, JSON.stringify(issues));
  fs.writeFileSync(stub, [
    "'use strict';",
    "const fs = require('fs');",
    'const argv = process.argv.slice(1);',
    "if (argv.some((a) => /spec-brief\\.js$/.test(String(a)))) return;",
    "if (!argv.some((a) => /[\\\\/]show$/.test(String(a)))) return;",
    "const all = JSON.parse(fs.readFileSync(process.env.ISSUES_FILE, 'utf8'));",
    'const id = argv.find((a) => /^app-/.test(String(a)));',
    'const hit = all.filter((i) => i.id === id);',
    'process.stdout.write(JSON.stringify(hit));',
    'process.exit(0);',
  ].join('\n'));
  return {
    PIPELINE_BD_CMD: process.execPath,
    ISSUES_FILE: file,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require "${fwd(stub)}"`.trim(),
  };
}

function cli(world, args, extraEnv) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args],
    { encoding: 'utf8', env: { ...process.env, ...(extraEnv || {}) }, cwd: world.base });
  return { code: r.status, text: both(r) };
}

const ISSUE = (id, extra = {}) => ({
  id, title: 'A thing that must happen', issue_type: 'task',
  acceptance_criteria: 'A1. The first observable outcome.\nA2. The second.', ...extra,
});

// ---- A. the command line ------------------------------------------------------------------------
{
  const B = require(SCRIPT);
  check('A1 a value flag with no value is a usage error', B.parseArgs(['--config']).error === '--config needs a value');
  check('A2 two issue ids at once is refused — the brief is per issue',
    /only one issue id at a time/.test(B.parseArgs(['a', 'b']).error || ''));
  check('A3 an unknown option is named', /unknown option "--nope"/.test(B.parseArgs(['--nope']).error || ''));

  const w = makeWorld();
  check('A4 no arguments prints usage and exits 2', cli(w, []).code === 2);
  check('A5 an id with no --config is a usage error', cli(w, ['app-1']).code === 2);
}

// ---- B. the six facts, in the WRITE brief ---------------------------------------------------------
{
  const w = makeWorld({ hostEnv: { GODOT: '/c/tools/godot/godot_console.exe' } });
  const env = bdEnv(w, [ISSUE('app-1')]);
  const r = cli(w, ['app-1', '--config', w.cfgFile], env);
  check('B1 an issue with no suite anywhere produces a brief', r.code === 0 && r.text.length > 500);
  check('B2 it names the issue and its title', /app-1/.test(r.text) && /A thing that must happen/.test(r.text));

  // THE VERIFY COMMAND IS THE TARGET'S OWN. A guessed one sends an agent to write tests no runner
  // will invoke, and the guess stays plausible right up to the gate.
  check('B3 the verify command comes from the target config, with the suite path appended',
    r.text.includes('sh tools/run-acceptance.sh tests/acceptance/app-1/'));

  // THE GATE IS POINTED AT THE WORKTREE. Aimed at the shared checkout it grades a directory that
  // does not exist and answers indeterminate — an answer that looks like one and is not.
  // THE COMMAND LINE, not the sentence above it. The paragraph explaining the flag contains the
  // literal `--repo` too, and a naive first-match picks the prose — which carries no path at all,
  // so the check would fail on a correct brief and could never pass on any.
  const gateArg = (r.text.split(/\r?\n/).find((l) => /^\s+--repo\s/.test(l)) || '')
    .trim().replace(/\s*\\$/, '').replace(/^--repo\s+/, '');
  check('B4 the gate is pointed at the worktree', /-freeze-1$/.test(gateArg));
  // The shared checkout is where the tests are NOT. A brief naming it would send the gate to grade
  // a directory that does not exist, and indeterminate is never a pass.
  check('B5 and never at the shared checkout', gateArg !== w.target && gateArg !== fwd(w.target));
  check('B6 and the gate is run from a checkout of THIS repo, named explicitly',
    /^\s*cd \S+/m.test(r.text) && r.text.includes('node scripts/freeze-gate.js'));

  check('B7 the integration branch is read, never defaulted to main',
    /off master/.test(r.text) && !/off main\b/.test(r.text));
  check('B8 the frozen paths are named as untouchable',
    /tools\/run-acceptance\.sh/.test(r.text) && /tampered/.test(r.text));
  check('B9 the host environment is emitted as an export the reader can paste',
    r.text.includes('export GODOT="/c/tools/godot/godot_console.exe"'));
  check('B10 and it says why a missing binary is worse than an ordinary failure here',
    /certify that as a discriminating red/.test(r.text));
  check('B11 the criteria are quoted from Beads',
    /A1\. The first observable outcome\./.test(r.text) && /A2\. The second\./.test(r.text));
  check('B12 the example suite is the most recently written real one',
    /tests\/acceptance\/app-new\//.test(r.text));
  check('B13 and is never the control fixture, whatever its timestamp',
    !/copy the file shape from tests\/acceptance\/_control/i.test(r.text));
  check('B14 the brief refuses to let a red guard through',
    /\[guard\]/.test(r.text) && /GREEN at the fork point/.test(r.text));
  check('B15 it ends at approval, never at a push',
    /do not freeze/i.test(r.text) && /Approval comes before the freeze/.test(r.text));
}

// ---- C. it writes nothing it was not asked to write --------------------------------------------------
{
  const w = makeWorld();
  const env = bdEnv(w, [ISSUE('app-1')]);
  const before = git(w.target, ['status', '--porcelain']).out;
  cli(w, ['app-1', '--config', w.cfgFile], env);
  check('C1 generating a brief leaves the target checkout untouched',
    git(w.target, ['status', '--porcelain']).out === before);

  const out = path.join(w.base, 'brief.md');
  const r = cli(w, ['app-1', '--config', w.cfgFile, '--out', out], env);
  check('C2 --out writes the brief and names the state it chose',
    r.code === 0 && fs.existsSync(out) && /\(write\)/.test(r.text));
  check('C3 and the file holds the brief, not the confirmation line',
    fs.readFileSync(out, 'utf8').includes('sh tools/run-acceptance.sh'));
}

// ---- D. an existing worktree is reused, never re-created --------------------------------------------
{
  const w = makeWorld();
  const env = bdEnv(w, [ISSUE('app-1')]);
  const wt = path.join(w.base, 'target-freeze-1');
  git(w.target, ['worktree', 'add', '-q', '-b', 'freeze-1', wt, 'master']);

  const r = cli(w, ['app-1', '--config', w.cfgFile], env);
  check('D1 an existing worktree is found in git\'s own registry and reused',
    r.text.includes(wt.split(path.sep).join(path.sep)) || r.text.includes(fwd(wt)));
  // An agent told to create a folder that exists loses its first move to an error, and the error
  // reads like the guard refusing it — which is a different problem entirely.
  check('D2 and the brief does not tell the reader to create it',
    !/worktree add/.test(r.text));
  check('D3 with no worktree, the brief gives the exact command to make one', (() => {
    const w2 = makeWorld();
    const e2 = bdEnv(w2, [ISSUE('app-9')]);
    const r2 = cli(w2, ['app-9', '--config', w2.cfgFile], e2);
    return /worktree add -b freeze-9/.test(r2.text);
  })());
  check('D4 and warns that you cannot write into it from the folder you made it in', (() => {
    const w2 = makeWorld();
    const e2 = bdEnv(w2, [ISSUE('app-9')]);
    const r2 = cli(w2, ['app-9', '--config', w2.cfgFile], e2);
    return /cannot write into a worktree from the folder you made it in/.test(r2.text);
  })());
}

// ---- E. the three states are told apart -----------------------------------------------------------
{
  // WRITE vs FREEZE is decided by the WORKING TREE, which is the only place that knows: a session
  // that wrote tests and stopped one step short leaves exactly this state, and no branch-side
  // check can see it.
  const w = makeWorld();
  const env = bdEnv(w, [ISSUE('app-2')]);
  const dir = path.join(w.target, 'tests', 'acceptance', 'app-2');
  fs.mkdirSync(dir, { recursive: true });

  const empty = cli(w, ['app-2', '--config', w.cfgFile], env);
  check('E1 an EMPTY suite directory is still "write", and says why it is worse than none',
    /YOUR JOB is to write/.test(empty.text) && /no\s*\n?\s*test files/.test(empty.text));

  fs.writeFileSync(path.join(dir, '01-a-check.sh'), '# a check\n');
  const unfrozen = cli(w, ['app-2', '--config', w.cfgFile], env);
  check('E2 a suite in the working tree the branch has never seen is "freeze", not "write"',
    /THE TESTS ARE ALREADY WRITTEN/.test(unfrozen.text) && !/YOUR JOB is to write/.test(unfrozen.text));
  check('E3 and it names the freeze command rather than describing the steps',
    /scripts\/freeze\.js commit app-2/.test(unfrozen.text));
  check('E4 and still refuses to freeze on a verdict that is not red or half-proven',
    /do not freeze/i.test(unfrozen.text) && /green, unreachable or stale-guard/.test(unfrozen.text));

  // RE-GATE: on the branch, refused for the receipt rather than for the suite. It looks identical
  // to a missing suite in any report that does not separate them, and it is ninety per cent done.
  git(w.target, ['add', '--', 'tests/acceptance/app-2']);
  git(w.target, ['commit', '-qm', 'a suite with no receipt']);
  git(w.target, ['push', '-q', w.origin, 'HEAD:refs/heads/master']);
  const regate = cli(w, ['app-2', '--config', w.cfgFile], env);
  check('E5 a suite on the branch with no receipt is "re-gate"',
    /THE SUITE IS ALREADY ON master/.test(regate.text));
  check('E6 and it quotes the runner\'s own refusal rather than paraphrasing it',
    /freeze receipt/.test(regate.text));
  check('E7 and says plainly that nothing needs writing',
    /Nothing needs writing/.test(regate.text));
  check('E8 and warns that time on the branch is not evidence the suite discriminates',
    /does not mean it was ever discriminating/.test(regate.text));
}

// ---- F. an already-dispatchable issue needs no brief at all --------------------------------------
{
  // Not an error and not a brief: the honest answer is that there is nothing to do. A brief here
  // would send someone to re-freeze work that is already running.
  const w = makeWorld();
  const env = bdEnv(w, [ISSUE('app-3')]);
  const dir = path.join(w.target, 'tests', 'acceptance', 'app-3');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '01-a-check.sh'), '# a check\n');
  fs.writeFileSync(path.join(dir, '.freeze-gate.json'), JSON.stringify({
    gateVersion: 1, verdict: 'red', suiteHash: 'a'.repeat(64), probeSupplied: true,
  }));
  git(w.target, ['add', '--', 'tests/acceptance/app-3']);
  git(w.target, ['commit', '-qm', 'frozen']);
  git(w.target, ['push', '-q', w.origin, 'HEAD:refs/heads/master']);
  // The hash is deliberately wrong, so this lands on receipt-mismatch — still a re-gate, and the
  // brief must say WHICH, because "re-run the gate" and "the suite moved" send you to different files.
  const r = cli(w, ['app-3', '--config', w.cfgFile], env);
  check('F1 a receipt that does not match the suite is a re-gate naming the mismatch',
    /THE SUITE IS ALREADY ON master/.test(r.text) && /edited after the gate blessed it/.test(r.text));
}

// ---- G. an issue with no criteria is a spec bug, not a brief -------------------------------------
{
  const w = makeWorld();
  const env = bdEnv(w, [ISSUE('app-4', { acceptance_criteria: '' })]);
  const r = cli(w, ['app-4', '--config', w.cfgFile], env);
  check('G1 an issue carrying no acceptance criteria says so and tells the reader to stop',
    /NO ACCEPTANCE CRITERIA/.test(r.text) && /Report it and stop/.test(r.text));
}

// ---- H. the config key -----------------------------------------------------------------------------
{
  const { loadConfig } = require(path.join(ROOT, 'runner', 'config.js'));
  const w = makeWorld();
  const bad = path.join(w.base, 'bad.json');
  const write = (v) => fs.writeFileSync(bad, JSON.stringify({
    targetRepoPath: w.target, targetRepoRemote: w.origin, image: 'x:latest', hostEnv: v,
  }));
  const throws = (v) => { write(v); try { loadConfig(bad); return false; } catch { return true; } };
  check('H1 hostEnv must be an object', throws(['GODOT=x']) && throws('GODOT=x'));
  check('H2 and every value must be a string — a number would reach a shell as a surprise',
    throws({ GODOT: 4 }));
  check('H3 a well-formed hostEnv loads', (() => { write({ GODOT: '/x' }); return loadConfig(bad).hostEnv.GODOT === '/x'; })());
  check('H4 and its absence is not an error', (() => {
    const ok = path.join(w.base, 'ok.json');
    fs.writeFileSync(ok, JSON.stringify({ targetRepoPath: w.target, targetRepoRemote: w.origin, image: 'x:latest' }));
    return loadConfig(ok).hostEnv === undefined;
  })());
  // A config with no hostEnv must produce no SETUP block at all — a fabricated export is worse
  // than none, because the reader will run it.
  const env = bdEnv(w, [ISSUE('app-5')]);
  const r = cli(w, ['app-5', '--config', w.cfgFile], env);
  check('H5 with no hostEnv the brief emits no export block rather than an invented one',
    !/^export /m.test(r.text) && !/SETUP, BEFORE ANYTHING ELSE/.test(r.text));
}

// ---- I. it restates no rule it could import ---------------------------------------------------------
{
  const src = fs.readFileSync(SCRIPT, 'utf8');
  check('I1 the state is decided by the runner\'s own gate, not a second copy of the rule',
    /partitionByFreeze/.test(src) && /require\('\.\.\/runner\/queue'\)/.test(src));
  check('I2 the branch is resolved by the runner\'s own resolver',
    /resolveBranch/.test(src));
  check('I3 the verify command is never defaulted anywhere in the file',
    !/verifyCommand\s*\|\|/.test(src) && !/'sh tools\/run-acceptance\.sh'/.test(src));
  check('I4 and no integration branch is hard-coded',
    !/'main'/.test(src) && !/'master'/.test(src));
  check('I5 it writes nothing but --out', (src.match(/writeFileSync/g) || []).length === 1);
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
