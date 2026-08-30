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
    "const id = argv.find((a) => all.some((i) => i.id === a || i.id.endsWith('-' + a)));",
    "const hit = all.filter((i) => i.id === id || i.id.endsWith('-' + id));",
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
  check('B4 the gate is pointed at the injective full-id worktree', /-freeze-app-1$/.test(gateArg));
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
  const previous = { PIPELINE_BD_CMD: process.env.PIPELINE_BD_CMD,
    ISSUES_FILE: process.env.ISSUES_FILE, NODE_OPTIONS: process.env.NODE_OPTIONS };
  Object.assign(process.env, env);
  const built = require(SCRIPT).buildBrief({ id: 'app-1', config: w.cfgFile });
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  check('B16 structured brief carries JSON-safe issue identity, criteria source/hash and update clock',
    built.ok && built.issue.id === 'app-1' && built.criteria.source === 'structured'
      && /^[a-f0-9]{64}$/.test(built.criteria.sha256) && built.issueUpdatedAt === null
      && (() => { try { JSON.stringify(built); return true; } catch { return false; } })());
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
  const wt = path.join(w.base, 'target-freeze-app-1');
  git(w.target, ['worktree', 'add', '-q', '-b', 'freeze-app-1', wt, 'master']);

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
    return /worktree add -b freeze-app-9/.test(r2.text);
  })());
  check('D4 and warns that you cannot write into it from the folder you made it in', (() => {
    const w2 = makeWorld();
    const e2 = bdEnv(w2, [ISSUE('app-9')]);
    const r2 = cli(w2, ['app-9', '--config', w2.cfgFile], e2);
    return /cannot write into a worktree from the folder you made it in/.test(r2.text);
  })());
  const B = require(SCRIPT);
  check('D5 full issue ids with the same suffix receive different branch and folder names',
    B.issueNames('app-9').branch === 'freeze-app-9'
      && B.issueNames('other-9').branch === 'freeze-other-9'
      && B.issueNames('app-9').dirSuffix !== B.issueNames('other-9').dirSuffix);
  const duplicate = B.resolveIssueFolder({ targetRepoPath: w.target }, 'app-9', [
    { dir: path.join(w.base, 'one'), branch: 'freeze-app-9' },
    { dir: path.join(w.base, 'two'), branch: 'freeze-app-9' },
  ]);
  check('D5b ambiguous exact-branch registry results fail closed',
    !duplicate.ok && duplicate.kind === 'collision' && /multiple worktrees/.test(duplicate.error));
}

// A suite in somebody else's tree is evidence to preserve, not a naming fallback. The old
// resolver silently adopted the first worktree containing the directory, including active and
// contaminated sessions.
{
  const w = makeWorld();
  const env = bdEnv(w, [ISSUE('app-1')]);
  const legacy = path.join(w.base, 'legacy');
  git(w.target, ['worktree', 'add', '-q', '-b', 'freeze-1', legacy, 'master']);
  const suite = path.join(legacy, 'tests', 'acceptance', 'app-1');
  fs.mkdirSync(suite, { recursive: true });
  fs.writeFileSync(path.join(suite, 'legacy.sh'), '# preserve me\n');
  const r = cli(w, ['app-1', '--config', w.cfgFile], env);
  check('D6 a legacy suite-bearing worktree is surfaced as a collision, never adopted',
    r.code === 3 && /legacy or ambiguous worktree/.test(r.text) && /freeze-1/.test(r.text));
}

// A suite committed on the integration branch is inherited by every later worktree. Those clean,
// integration-identical copies are not unpublished ownership claims. Working-tree and committed
// divergence still are, including a clean divergent branch that status alone would miss.
{
  const w = makeWorld();
  const B = require(SCRIPT);
  const id = 'app-inherited';
  const relative = path.join('tests', 'acceptance', id);
  const suite = path.join(w.target, relative);
  const original = '# inherited from integration\n';
  fs.mkdirSync(suite, { recursive: true });
  fs.writeFileSync(path.join(suite, 'acceptance.sh'), original);
  fs.writeFileSync(path.join(suite, 'helper.gd'), 'extends RefCounted\n');
  git(w.target, ['add', relative]);
  git(w.target, ['commit', '-qm', 'an inherited acceptance suite']);
  const integrationTree = git(w.target, ['rev-parse', `HEAD:${fwd(relative)}`]).out.trim();
  const { suiteHash, treeEntries } = require(path.join(ROOT, 'runner', 'suite-hash.js'));
  const integrationHash = suiteHash(treeEntries(w.target, 'HEAD', fwd(relative)));

  const legacyA = path.join(w.base, 'legacy-inherited-a');
  const legacyB = path.join(w.base, 'legacy-inherited-b');
  git(w.target, ['worktree', 'add', '-q', '-b', 'legacy-inherited-a', legacyA, 'master']);
  git(w.target, ['worktree', 'add', '-q', '-b', 'legacy-inherited-b', legacyB, 'master']);
  const registered = [
    { dir: legacyA, branch: 'legacy-inherited-a', locked: false, prunable: false },
    { dir: legacyB, branch: 'legacy-inherited-b', locked: false, prunable: false },
  ];
  const inherited = B.resolveIssueFolder({ targetRepoPath: w.target }, id, registered, integrationTree);
  check('D6a clean integration-identical legacy suites are ignored only with a re-gate base',
    inherited.ok && inherited.folder && inherited.folder.exists === false);
  check('D6b local/write resolution keeps the original conservative collision', (() => {
    const local = B.resolveIssueFolder({ targetRepoPath: w.target }, id, registered);
    return !local.ok && local.kind === 'collision';
  })());

  // The integration branch later gains only the receipt. Its raw suite tree changes, but the
  // receipt-independent suite identity does not; older worktrees remain inherited, not claims.
  fs.writeFileSync(path.join(suite, '.freeze-gate.json'), '{}\n');
  git(w.target, ['add', relative]);
  git(w.target, ['commit', '-qm', 'add only the freeze receipt']);
  const receiptTree = git(w.target, ['rev-parse', `HEAD:${fwd(relative)}`]).out.trim();
  check('D6b1 a receipt-only integration change does not create a false legacy collision', (() => {
    const found = B.resolveIssueFolder({ targetRepoPath: w.target }, id, id, registered,
      { suiteId: id, tree: receiptTree, suiteHash: integrationHash });
    return receiptTree !== integrationTree && found.ok && found.folder && found.folder.exists === false;
  })());

  const legacyFile = path.join(legacyA, relative, 'acceptance.sh');
  fs.appendFileSync(legacyFile, '# local divergence\n');
  check('D6c a modified inherited suite remains a collision', (() => {
    const found = B.resolveIssueFolder({ targetRepoPath: w.target }, id, registered, integrationTree);
    return !found.ok && found.kind === 'collision' && /legacy-inherited-a/.test(found.error);
  })());
  fs.writeFileSync(legacyFile, original);

  const extra = path.join(legacyA, relative, 'untracked.txt');
  fs.writeFileSync(extra, 'unpublished evidence\n');
  check('D6d an untracked file prevents the inherited-suite exemption', (() => {
    const found = B.resolveIssueFolder({ targetRepoPath: w.target }, id, registered, integrationTree);
    return !found.ok && found.kind === 'collision';
  })());
  fs.rmSync(extra);

  const ignored = path.join(legacyA, relative, 'ignored.tmp');
  fs.appendFileSync(path.join(legacyA, '.gitignore'), '\n*.tmp\n');
  fs.writeFileSync(ignored, 'ignored unpublished evidence\n');
  check('D6e an ignored file prevents the inherited-suite exemption', (() => {
    const found = B.resolveIssueFolder({ targetRepoPath: w.target }, id, registered, integrationTree);
    return !found.ok && found.kind === 'collision';
  })());
  fs.rmSync(ignored); fs.rmSync(path.join(legacyA, '.gitignore'));

  const generatedUid = path.join(legacyA, relative, 'helper.gd.uid');
  fs.appendFileSync(path.join(legacyA, '.gitignore'), '\n*.uid\n');
  fs.writeFileSync(generatedUid, 'uid://b123456780a\n');
  check('D6e1 a canonical ignored Godot sidecar does not make an inherited suite collide', (() => {
    const found = B.resolveIssueFolder({ targetRepoPath: w.target }, id, registered, integrationTree);
    return found.ok && found.folder && found.folder.exists === false;
  })());
  fs.writeFileSync(generatedUid, 'not-a-generated-uid\n');
  check('D6e2 a malformed ignored UID sidecar remains a collision', (() => {
    const found = B.resolveIssueFolder({ targetRepoPath: w.target }, id, registered, integrationTree);
    return !found.ok && found.kind === 'collision';
  })());
  fs.rmSync(generatedUid); fs.rmSync(path.join(legacyA, '.gitignore'));

  fs.appendFileSync(legacyFile, '# committed divergence\n');
  git(legacyA, ['add', relative]);
  git(legacyA, ['commit', '-qm', 'diverge the legacy suite']);
  check('D6f a clean but committed divergent legacy suite remains a collision', (() => {
    const found = B.resolveIssueFolder({ targetRepoPath: w.target }, id, registered, integrationTree);
    return !found.ok && found.kind === 'collision';
  })());

  const notGit = path.join(w.base, 'legacy-not-git');
  fs.mkdirSync(path.join(notGit, relative), { recursive: true });
  fs.writeFileSync(path.join(notGit, relative, 'acceptance.sh'), original);
  check('D6g an unreadable legacy Git identity fails closed as a collision', (() => {
    const found = B.resolveIssueFolder({ targetRepoPath: w.target }, id,
      [{ dir: notGit, branch: 'legacy-not-git', locked: false, prunable: false }], integrationTree);
    return !found.ok && found.kind === 'collision';
  })());
}

// Re-gate is classified from a throwaway fetch, not from the host checkout. The collision
// exemption must therefore carry the exact fetched suite tree through the gate. Re-resolving
// `master` locally is wrong in both directions: an ahead local ref creates false collisions,
// while a behind local ref can hide genuinely divergent legacy evidence.
{
  const w = makeWorld();
  const id = 'app-remote-ahead';
  const relative = path.join('tests', 'acceptance', id);
  const suite = path.join(w.target, relative);
  fs.mkdirSync(suite, { recursive: true });
  fs.writeFileSync(path.join(suite, 'acceptance.sh'), '# remote version\n');
  git(w.target, ['add', relative]);
  git(w.target, ['commit', '-qm', 'remote suite']);
  git(w.target, ['push', '-q', w.origin, 'HEAD:refs/heads/master']);
  const remoteCommit = git(w.target, ['rev-parse', 'HEAD']).out.trim();

  const legacy = path.join(w.base, 'legacy-remote-ahead');
  git(w.target, ['worktree', 'add', '-q', '-b', 'legacy-remote-ahead', legacy, remoteCommit]);
  fs.writeFileSync(path.join(suite, 'acceptance.sh'), '# local ahead version\n');
  git(w.target, ['add', relative]);
  git(w.target, ['commit', '-qm', 'local branch moves suite ahead']);
  // Leave refs/heads/master ahead while the shared worktree itself is clean at the remote
  // commit, so the only difference is which branch identity the exemption resolves.
  git(w.target, ['checkout', '-q', '--detach', remoteCommit]);

  const r = cli(w, [id, '--config', w.cfgFile], bdEnv(w, [ISSUE(id)]));
  check('D6h an ahead local branch cannot create collisions for remote-identical inherited suites',
    r.code === 0 && /THE SUITE IS ALREADY ON master/.test(r.text));
}
{
  const w = makeWorld();
  const id = 'app-remote-behind';
  const relative = path.join('tests', 'acceptance', id);
  const suite = path.join(w.target, relative);
  fs.mkdirSync(suite, { recursive: true });
  fs.writeFileSync(path.join(suite, 'acceptance.sh'), '# old local version\n');
  git(w.target, ['add', relative]);
  git(w.target, ['commit', '-qm', 'old local suite']);
  git(w.target, ['push', '-q', w.origin, 'HEAD:refs/heads/master']);
  const legacy = path.join(w.base, 'legacy-remote-behind');
  git(w.target, ['worktree', 'add', '-q', '-b', 'legacy-remote-behind', legacy, 'master']);

  const publisher = path.join(w.base, 'publisher');
  spawnSync('git', ['clone', '-q', w.origin, publisher]);
  for (const kv of [['user.email', 'fixture@test.local'], ['user.name', 'f'],
    ['commit.gpgsign', 'false'], ['core.autocrlf', 'false'], ['core.eol', 'lf']]) git(publisher, ['config', ...kv]);
  fs.writeFileSync(path.join(publisher, relative, 'acceptance.sh'), '# newer remote version\n');
  git(publisher, ['add', relative]);
  git(publisher, ['commit', '-qm', 'remote moves suite ahead']);
  git(publisher, ['push', '-q', 'origin', 'master']);

  const r = cli(w, [id, '--config', w.cfgFile], bdEnv(w, [ISSUE(id)]));
  check('D6i a behind local branch cannot exempt legacy suites divergent from fetched remote',
    r.code === 3 && /legacy or ambiguous worktree/.test(r.text)
      && /legacy-remote-behind/.test(r.text));
}
{
  const w = makeWorld();
  const env = bdEnv(w, [ISSUE('app-1')]);
  const suite = path.join(w.target, 'tests', 'acceptance', 'app-1');
  fs.mkdirSync(suite, { recursive: true });
  fs.writeFileSync(path.join(suite, 'unowned.sh'), '# preserve me\n');
  const r = cli(w, ['app-1', '--config', w.cfgFile], env);
  check('D7 an unowned suite in dirty shared main is a collision, not freeze state',
    r.code === 3 && /shared checkout contains/.test(r.text) && !/THE TESTS ARE ALREADY WRITTEN/.test(r.text));
}
{
  const B = require(SCRIPT);
  let failedList = false;
  try { B.worktrees({ targetRepoPath: path.join(os.tmpdir(), 'missing-worktree-registry-root') }); }
  catch (e) { failedList = Boolean(e && e.message); }
  check('D8 a failed git worktree registry read fails closed instead of becoming an empty list', failedList);
  for (const field of ['locked', 'prunable']) {
    const found = B.resolveIssueFolder({ targetRepoPath: os.tmpdir() }, 'app-1', [
      { dir: path.join(os.tmpdir(), `unsafe-${field}`), branch: 'freeze-app-1', [field]: true },
    ]);
    check(`D9 exact worktree marked ${field} is a collision, never adopted`,
      !found.ok && found.kind === 'collision' && /locked or prunable/.test(found.error));
  }
  const w = makeWorld();
  const unsafe = cli(w, ['app..1', '--config', w.cfgFile], bdEnv(w, [ISSUE('app..1')]));
  check('D10 Git-invalid double-dot issue ids are rejected before any brief is built',
    unsafe.code === 2 && /safe issue id/.test(unsafe.text));

  const canonical = B.canonicalIssueId({ id: 'Junkstronaut_Final-u9f' }, 'u9f');
  check('D11 a short Beads lookup keeps the canonical returned issue id for suite paths',
    canonical.ok && canonical.id === 'Junkstronaut_Final-u9f');
  check('D12 an unrelated Beads resolution fails closed',
    !B.canonicalIssueId({ id: 'another-project-x1' }, 'u9f').ok);

  const legacyDir = path.join(os.tmpdir(), 'legacy-canonical-u9f');
  fs.mkdirSync(path.join(legacyDir, 'tests', 'acceptance', 'Junkstronaut_Final-u9f'), { recursive: true });
  const adopted = B.resolveIssueFolder({ targetRepoPath: os.tmpdir() },
    'Junkstronaut_Final-u9f', 'u9f', [
      { dir: legacyDir, branch: 'freeze-u9f', locked: false, prunable: false },
    ]);
  check('D13 one exact legacy alias branch may preserve a canonical suite without copying it',
    adopted.ok && adopted.folder.dir === legacyDir && adopted.folder.legacyBranchAlias === true);
  const ambiguous = B.resolveIssueFolder({ targetRepoPath: os.tmpdir() },
    'Junkstronaut_Final-u9f', 'u9f', [
      { dir: legacyDir, branch: 'freeze-u9f', locked: false, prunable: false },
      { dir: path.join(os.tmpdir(), 'canonical-u9f'), branch: 'freeze-Junkstronaut_Final-u9f', locked: false, prunable: false },
    ]);
  check('D14 canonical and legacy branches together are a collision',
    !ambiguous.ok && ambiguous.kind === 'collision');

  const aliasRemote = makeWorld();
  const aliasSuite = path.join(aliasRemote.target, 'tests', 'acceptance', 'u9f');
  fs.mkdirSync(aliasSuite, { recursive: true });
  fs.writeFileSync(path.join(aliasSuite, 'test.js'), 'process.exit(1);\n');
  git(aliasRemote.target, ['add', '--', 'tests/acceptance/u9f']);
  git(aliasRemote.target, ['commit', '-qm', 'legacy alias suite']);
  git(aliasRemote.target, ['push', '-q', aliasRemote.origin, 'HEAD:refs/heads/master']);
  const aliasRemoteResult = cli(aliasRemote, ['u9f', '--config', aliasRemote.cfgFile],
    bdEnv(aliasRemote, [ISSUE('Junkstronaut_Final-u9f')]));
  check('D15 an integration-branch alias suite is a re-cut collision, never runner-ready',
    aliasRemoteResult.code === 3 && /runner requires canonical/.test(aliasRemoteResult.text));
}

// ---- E. the three states are told apart -----------------------------------------------------------
{
  // WRITE vs FREEZE is decided by the WORKING TREE, which is the only place that knows: a session
  // that wrote tests and stopped one step short leaves exactly this state, and no branch-side
  // check can see it.
  const w = makeWorld();
  const env = bdEnv(w, [ISSUE('app-2')]);
  const wt = path.join(w.base, 'target-freeze-app-2');
  git(w.target, ['worktree', 'add', '-q', '-b', 'freeze-app-2', wt, 'master']);
  const dir = path.join(wt, 'tests', 'acceptance', 'app-2');
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
  const mainDir = path.join(w.target, 'tests', 'acceptance', 'app-2');
  fs.mkdirSync(mainDir, { recursive: true });
  fs.writeFileSync(path.join(mainDir, '01-a-check.sh'), '# a check\n');
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

// Older issues put a numbered Done-means list in description because their Beads version did not
// expose the structured field. The fallback is intentionally a tiny grammar, not a prose guess:
// an exact Markdown heading and a top-level list beginning at 1, bounded by the next peer heading.
{
  const w = makeWorld();
  const lhi = ISSUE('app-6', {
    acceptance_criteria: ' \r\n ',
    description: [
      'Keep the hold feedback readable during long sessions.',
      '',
      '## aCcEpTaNcE CrItErIa:',
      '',
      '1. Holding cargo displays the remaining safe duration.',
      '2. Releasing cargo clears the display.',
      '',
      '## Implementation notes',
      'This sentence is not a criterion.',
    ].join('\r\n'),
  });
  const env = bdEnv(w, [lhi]);
  const r = cli(w, ['app-6', '--config', w.cfgFile], env);
  check('G2 a numbered Acceptance criteria description section is the legacy fallback',
    /1\. Holding cargo displays/.test(r.text) && /2\. Releasing cargo clears/.test(r.text));
  check('G3 the fallback stops at the next equal-level heading',
    !/Implementation notes/.test(r.text) && !/not a criterion/.test(r.text));
}
{
  const w = makeWorld();
  const env = bdEnv(w, [ISSUE('app-7', {
    acceptance_criteria: 'A1. Structured wins.',
    description: '## Acceptance criteria\n1. Description loses.',
  })]);
  const r = cli(w, ['app-7', '--config', w.cfgFile], env);
  check('G4 nonblank structured criteria take precedence over the description fallback',
    /A1\. Structured wins\./.test(r.text) && !/Description loses/.test(r.text));
}
{
  const w = makeWorld();
  const issues = [
    ISSUE('app-8', { acceptance_criteria: '', description: 'Context only.\n\n1. Unlabelled list.' }),
    ISSUE('app-9', { acceptance_criteria: '', description: '## Acceptance criteria\n- A bullet is not the numbered contract.' }),
    ISSUE('app-10', { acceptance_criteria: '', description: '## Acceptance criteria and notes\n1. Not an exact heading.' }),
  ];
  const env = bdEnv(w, issues);
  const unlabeled = cli(w, ['app-8', '--config', w.cfgFile], env);
  const unnumbered = cli(w, ['app-9', '--config', w.cfgFile], env);
  const inexact = cli(w, ['app-10', '--config', w.cfgFile], env);
  check('G5 arbitrary description prose and an unlabeled list remain rejected',
    /NO ACCEPTANCE CRITERIA/.test(unlabeled.text));
  check('G6 an unnumbered Acceptance criteria section remains rejected',
    /NO ACCEPTANCE CRITERIA/.test(unnumbered.text));
  check('G7 the fallback heading must be exactly Acceptance criteria',
    /NO ACCEPTANCE CRITERIA/.test(inexact.text));
}
{
  const w = makeWorld();
  const issues = [
    ISSUE('app-11', {
      acceptance_criteria: '',
      description: '```md\n## Acceptance criteria\n1. This is only an example.\n```\nNo contract follows.',
    }),
    ISSUE('app-12', {
      acceptance_criteria: '',
      description: [
        '### Acceptance criteria',
        '1. The first real criterion.',
        '~~~~ markdown',
        '## A peer-looking heading inside the example',
        '~~~~',
        '2. The second real criterion survives the fence.',
        '## Actual next section',
        'This is outside the contract.',
      ].join('\n'),
    }),
  ];
  const env = bdEnv(w, issues);
  const fake = cli(w, ['app-11', '--config', w.cfgFile], env);
  const fencedPeer = cli(w, ['app-12', '--config', w.cfgFile], env);
  check('G8 an Acceptance criteria heading inside a backtick fence is not a fallback section',
    /NO ACCEPTANCE CRITERIA/.test(fake.text));
  check('G9 a peer heading inside a tilde fence does not end a real criteria section',
    /2\. The second real criterion survives/.test(fencedPeer.text)
      && !/outside the contract/.test(fencedPeer.text));
}
{
  const { acceptanceCriteria, criteriaInfo } = require(SCRIPT);
  const description = '## Acceptance criteria\n1. A valid legacy criterion.';
  check('G10 a missing structured field may use the strict legacy fallback',
    acceptanceCriteria({ description }) === '1. A valid legacy criterion.');
  check('G11 every present non-string structured value fails closed instead of falling back',
    [null, undefined, 0, false, [], {}]
      .every((acceptance_criteria) => acceptanceCriteria({ acceptance_criteria, description }) === ''));
  const structured = criteriaInfo({ acceptance_criteria: ' A1. Exact. ', description });
  const fallback = criteriaInfo({ acceptance_criteria: '', description });
  const none = criteriaInfo({ acceptance_criteria: null, description });
  check('G11b criteria metadata names its canonical source and stable digest',
    structured.text === 'A1. Exact.' && structured.source === 'structured'
      && fallback.source === 'description' && /^[a-f0-9]{64}$/.test(fallback.sha256)
      && none.source === 'none' && none.text === '');
}
{
  const w = makeWorld();
  const issues = [
    ISSUE('app-13', {
      acceptance_criteria: '',
      description: '<!--\n## Acceptance criteria\n1. Template placeholder only.\n-->\nNo contract follows.',
    }),
    ISSUE('app-14', {
      acceptance_criteria: '',
      description: [
        '## Acceptance criteria',
        '1. The first real criterion.',
        '<!--',
        '## Commented next-section template',
        '-->',
        '2. The second real criterion survives the comment.',
        '## Actual next section',
        'This is outside the contract.',
      ].join('\n'),
    }),
    ISSUE('app-15', {
      acceptance_criteria: '',
      description: '## Acceptance criteria\n1. The captured criterion.\nNext section\n---\nOutside peer section.',
    }),
    ISSUE('app-16', {
      acceptance_criteria: '',
      description: '### Acceptance criteria\n1. The captured criterion.\nHigher section\n===\nOutside higher section.',
    }),
    ISSUE('app-17', {
      acceptance_criteria: '',
      description: [
        '# Acceptance criteria',
        '1. The first criterion.',
        'Lower subsection',
        '---',
        '2. A lower Setext heading does not end an H1 criteria section.',
        '# Actual peer section',
        'This is outside the contract.',
      ].join('\n'),
    }),
    ISSUE('app-18', {
      acceptance_criteria: '',
      description: '## Acceptance criteria\n1. Looks valid.\n<!-- unclosed template',
    }),
  ];
  const env = bdEnv(w, issues);
  const commented = cli(w, ['app-13', '--config', w.cfgFile], env);
  const commentedPeer = cli(w, ['app-14', '--config', w.cfgFile], env);
  const peerSetext = cli(w, ['app-15', '--config', w.cfgFile], env);
  const higherSetext = cli(w, ['app-16', '--config', w.cfgFile], env);
  const lowerSetext = cli(w, ['app-17', '--config', w.cfgFile], env);
  const unclosed = cli(w, ['app-18', '--config', w.cfgFile], env);
  check('G12 a commented Acceptance criteria template is not a fallback section',
    /NO ACCEPTANCE CRITERIA/.test(commented.text));
  check('G13 an ATX peer heading inside an HTML comment does not end real criteria',
    /2\. The second real criterion survives/.test(commentedPeer.text)
      && !/outside the contract/.test(commentedPeer.text));
  check('G14 a peer Setext heading ends an H2 criteria section before its title',
    !/Next section/.test(peerSetext.text) && !/Outside peer/.test(peerSetext.text));
  check('G15 a higher Setext heading ends an H3 criteria section before its title',
    !/Higher section/.test(higherSetext.text) && !/Outside higher/.test(higherSetext.text));
  check('G16 a lower Setext heading remains inside an H1 criteria section',
    /Lower subsection/.test(lowerSetext.text)
      && /2\. A lower Setext heading does not end/.test(lowerSetext.text)
      && !/outside the contract/.test(lowerSetext.text));
  check('G17 an unclosed HTML comment makes the description fallback fail closed',
    /NO ACCEPTANCE CRITERIA/.test(unclosed.text));
}
{
  const w = makeWorld();
  const issues = [
    ISSUE('app-19', {
      acceptance_criteria: '',
      description: '## Acceptance criteria\n1. The first criterion.\n---\n2. The second criterion survives the divider.',
    }),
    ISSUE('app-20', {
      acceptance_criteria: '',
      description: '<pre>\n## Acceptance criteria\n1. Fake criterion in raw HTML.\n</pre>',
    }),
    ISSUE('app-21', {
      acceptance_criteria: '',
      description: '<script>\n## Acceptance criteria\n1. Fake script template.\n</script>',
    }),
    ISSUE('app-22', {
      acceptance_criteria: '',
      description: '## Acceptance criteria\n1. Otherwise valid.\n\n<div>Benign supporting note.</div>',
    }),
  ];
  const env = bdEnv(w, issues);
  const divider = cli(w, ['app-19', '--config', w.cfgFile], env);
  const pre = cli(w, ['app-20', '--config', w.cfgFile], env);
  const script = cli(w, ['app-21', '--config', w.cfgFile], env);
  const benignHtml = cli(w, ['app-22', '--config', w.cfgFile], env);
  check('G18 a horizontal divider after a numbered criterion is not a Setext boundary',
    /1\. The first criterion/.test(divider.text)
      && /2\. The second criterion survives/.test(divider.text));
  check('G19 raw pre HTML cannot expose a fake criteria heading',
    /NO ACCEPTANCE CRITERIA/.test(pre.text));
  check('G20 raw script HTML cannot expose a fake criteria heading',
    /NO ACCEPTANCE CRITERIA/.test(script.text));
  check('G21 any visible raw HTML tag line makes an otherwise valid fallback fail closed',
    /NO ACCEPTANCE CRITERIA/.test(benignHtml.text));
}
{
  const w = makeWorld();
  const issues = [
    ISSUE('app-23', {
      acceptance_criteria: '',
      description: '<!ELEMENT note (\n## Acceptance criteria\n1. Fake declaration criterion.\n)>',
    }),
    ISSUE('app-24', {
      acceptance_criteria: '',
      description: '## Acceptance criteria\n1. Looks valid before raw HTML.\n<!ELEMENT note (unclosed',
    }),
    ISSUE('app-25', {
      acceptance_criteria: '',
      description: '<!DOCTYPE html>\n## Acceptance criteria\n1. Looks valid after the declaration.',
    }),
  ];
  const env = bdEnv(w, issues);
  const element = cli(w, ['app-23', '--config', w.cfgFile], env);
  const unclosedElement = cli(w, ['app-24', '--config', w.cfgFile], env);
  const doctype = cli(w, ['app-25', '--config', w.cfgFile], env);
  check('G22 a criteria-shaped template inside an ELEMENT declaration is rejected',
    /NO ACCEPTANCE CRITERIA/.test(element.text));
  check('G23 an unclosed uppercase declaration makes fallback fail closed',
    /NO ACCEPTANCE CRITERIA/.test(unclosedElement.text));
  check('G24 DOCTYPE remains a visible raw-HTML refusal',
    /NO ACCEPTANCE CRITERIA/.test(doctype.text));
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

// verifyCommand enters both a shell invocation and Claude's comma/parenthesis-delimited tool
// permission grammar. It therefore has a deliberately smaller language than arbitrary shell.
{
  const { verifyCommandError } = require(SCRIPT);
  check('H6 an ordinary argv-shaped verifier remains valid', !verifyCommandError('sh tools/run-acceptance.sh --strict'));
  for (const command of [
    'sh tools/run.sh\nBash(git push)', 'sh tools/run.sh,Bash(git push)',
    'sh tools/run.sh; git push', 'sh tools/run.sh && git push', 'sh $(evil)',
    'sh tools/run.sh | tee leak', 'sh tools/run.sh > changed',
  ]) {
    check(`H7 verifier injection is rejected: ${JSON.stringify(command)}`, !!verifyCommandError(command));
  }
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
