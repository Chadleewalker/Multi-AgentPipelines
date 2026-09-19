#!/usr/bin/env node
// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0
//
// repo-3ec review-correction regression coverage (UNFROZEN, run explicitly alongside the frozen
// tests/acceptance/repo-3ec suite and the mandatory profile). The frozen suite already covers the
// six product outcomes and the stale-content/stale-mode/materialization-error paths through the
// real verifier, entrypoint, host publication and canonical proof. THIS file adds bounded,
// deterministic coverage for the five defects the independent review of PR #167 found, each
// through its real production consumer:
//
//   C1  freeze-gate materializes the candidate INSIDE the verifier container, not on the host —
//       the mount handed to `docker run` is the raw repo, the materialization runs against it, and
//       the Git-mode verdict is still `red`.                       (scripts/freeze-gate.js)
//   C2  the verified-evidence binding fails CLOSED when it is REQUIRED (mode-untrusted candidate)
//       but missing / malformed / uncheckable, while a faithful worktree with no binding is still
//       "nothing to enforce".                                       (runner/run.js staleEvidence)
//   C3  materialization is faithful: it retains an `export-ignore` tracked file that `git archive`
//       would silently drop, restores modes and symlinks, and carries real `.git` metadata for a
//       Git-dependent verifier.                                     (pipeline/materialize.js)
//   C4  the real verifier runs a REQUIRED regression executable predicate against the SAME
//       materialized candidate as acceptance, so acceptance-only materialization cannot satisfy a
//       regression `test -x`.                                       (pipeline/verify.js)
//   C5  the docs-rollback restore pairs the verified-tree binding with verify.json, so a rejected
//       docs delta restores a binding that still matches the restored implementation tree.
//                                                                   (pipeline/entrypoint.sh)
//
// Windows-to-Docker is the coordinator's job (this author container cannot launch Docker); these
// are the deterministic local boundaries, not an invented pass. Native-exec assertions are gated
// behind POSIX and reported as skipped on win32 rather than faked.
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const VERIFY = path.join(ROOT, 'pipeline', 'verify.js');
const GATE = path.join(ROOT, 'scripts', 'freeze-gate.js');
const ENTRYPOINT = path.join(ROOT, 'pipeline', 'entrypoint.sh');
const materialize = require(path.join(ROOT, 'pipeline', 'materialize.js'));
const runmod = require(path.join(ROOT, 'runner', 'run.js'));

const POSIX = process.platform !== 'win32';
const ISSUE = 'mode-review-fixture';
const temps = [];
const tests = [];
let failed = 0;

// A sanitized base environment: the child git/verifier/gate must not inherit a developer's global
// Git config, credential seams, or a Node loader/test preload (repo-3ec correction 8 family).
const STRIP = ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT',
  'GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE', 'GIT_OBJECT_DIRECTORY', 'NODE_OPTIONS',
  'NODE_TEST_CONTEXT', 'FREEZE_GATE_CMD', 'FREEZE_GATE_DOCKER_CMD', 'FREEZE_GATE_DOCKER_IMAGE',
  'CODEX_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN',
  'PIPELINE_BD_CMD', 'PIPELINE_GH_CMD', 'PIPELINE_AGENT_CMD'];
const BASE_ENV = (() => {
  const e = { ...process.env };
  for (const k of STRIP) delete e[k];
  e.GIT_CONFIG_NOSYSTEM = '1';
  e.GIT_TERMINAL_PROMPT = '0';
  return e;
})();

function mkTemp(tag) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `r3ec-mr-${tag}-`));
  temps.push(d);
  return d;
}
function posix(p) { return p.split(path.sep).join('/'); }
function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', env: BASE_ENV, ...opts });
}
function git(dir, ...args) {
  const r = run('git', ['-C', dir, ...args]);
  return r;
}
function test(name, fn) { tests.push({ name, fn }); }

// A git repo in the reproduced Windows shape: core.filemode disabled, so the worktree exec bit is
// not trusted and the Git index/tree mode is authoritative.
function initRepo(tag) {
  const dir = mkTemp(tag);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'fixture@example.invalid');
  git(dir, 'config', 'user.name', 'repo-3ec mode-review');
  git(dir, 'config', 'core.filemode', 'false');
  git(dir, 'config', 'core.autocrlf', 'false');
  return dir;
}
function treeMode(dir, commit, file) {
  const r = git(dir, 'ls-tree', commit, '--', file);
  const m = /^(\d{6}) /.exec((r.stdout || '').trim());
  return m ? m[1] : null;
}

// ── C3 · faithful materialization ─────────────────────────────────────────────────────────────
test('C3 materializeCandidate is faithful: it retains an export-ignore tracked file git archive '
  + 'would drop, restores 100755/100644 and symlinks, and carries real .git for a Git-dependent '
  + 'verifier', () => {
  const dir = initRepo('c3');
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'bin', 'tool.sh'), '#!/bin/sh\necho hi\n');
  fs.writeFileSync(path.join(dir, 'ordinary.txt'), 'plain\n');
  // A tracked file marked export-ignore: `git archive` omits it, a faithful materializer keeps it.
  fs.writeFileSync(path.join(dir, 'keep-me.txt'), 'must survive materialization\n');
  fs.writeFileSync(path.join(dir, '.gitattributes'), 'keep-me.txt export-ignore\n');
  if (POSIX) fs.symlinkSync('bin/tool.sh', path.join(dir, 'link-to-tool'));
  git(dir, 'add', '-A');
  git(dir, 'update-index', '--chmod=+x', '--', 'bin/tool.sh');
  git(dir, 'commit', '-qm', 'faithful fixture');
  assert.strictEqual(treeMode(dir, 'HEAD', 'bin/tool.sh'), '100755', 'bin/tool.sh must be staged 100755');
  // Negative control proving the fixture discriminates: `git archive | tar` DROPS the export-ignore
  // file, which is exactly the unfaithfulness correction 3 removes.
  const arDir = mkTemp('c3-archive');
  const ar = run('sh', ['-c', `git -C "${posix(dir)}" archive --format=tar HEAD | tar -x -C "${posix(arDir)}"`]);
  assert.strictEqual(ar.status, 0, 'git archive control must run');
  assert(!fs.existsSync(path.join(arDir, 'keep-me.txt')),
    'control: git archive must DROP the export-ignore file (otherwise the fixture proves nothing)');

  const mat = materialize.materializeCandidate(dir);
  try {
    assert(mat.ok, `materialization must succeed: ${mat.error}`);
    assert(mat.dir && mat.dir !== dir, 'materialization must produce a distinct directory');
    assert(/^[0-9a-f]{40,64}$/.test(mat.tree), `materialization must return a tree id, got ${mat.tree}`);
    // Faithful: the export-ignore file survives (git archive dropped it above).
    assert(fs.existsSync(path.join(mat.dir, 'keep-me.txt')),
      'the export-ignore tracked file must be RETAINED by a faithful materialization');
    assert(fs.existsSync(path.join(mat.dir, 'ordinary.txt')), 'ordinary tracked files must be present');
    // Real .git metadata for a Git-dependent verifier.
    assert(fs.existsSync(path.join(mat.dir, '.git')), 'the materialized tree must carry .git metadata');
    const dep = git(mat.dir, 'rev-parse', 'HEAD');
    assert.strictEqual(dep.status, 0, `a Git-dependent verifier must work in the materialized tree: ${dep.stderr}`);
    if (POSIX) {
      const x = run('sh', ['-c', `test -x "${posix(path.join(mat.dir, 'bin', 'tool.sh'))}"`]);
      assert.strictEqual(x.status, 0, 'the 100755 file must be natively executable in the materialization');
      const o = run('sh', ['-c', `test -x "${posix(path.join(mat.dir, 'ordinary.txt'))}"`]);
      assert.notStrictEqual(o.status, 0, 'an ordinary 100644 file must NOT be executable');
      assert(fs.lstatSync(path.join(mat.dir, 'link-to-tool')).isSymbolicLink(),
        'a committed symlink must be restored as a symlink, not dereferenced');
    }
    // The original workspace and its index are untouched.
    assert.strictEqual((git(dir, 'status', '--porcelain').stdout || '').trim(), '',
      'materialization must not change the original workspace or index');
  } finally {
    if (mat.cleanup) mat.cleanup();
  }
});

test('C3 materializeCandidate fails CLOSED with a bounded reason when the candidate is not a git '
  + 'repo, rather than masking a failed producer behind a successful extraction', () => {
  const bare = mkTemp('c3-notgit');
  fs.writeFileSync(path.join(bare, 'a.txt'), 'x\n');
  const mat = materialize.materializeCandidate(bare);
  try {
    assert(!mat.ok, 'materialization of a non-repo must fail');
    assert(typeof mat.error === 'string' && mat.error.length > 0 && mat.error.length < 400,
      `the failure must carry a bounded actionable reason, got: ${mat.error}`);
  } finally {
    if (mat.cleanup) mat.cleanup();
  }
});

function checkedGit(dir, ...args) {
  const result = git(dir, ...args);
  assert.strictEqual(result.status, 0, 'git ' + args.join(' ') + ': ' + result.stderr);
  return String(result.stdout || '').trim();
}

test('C3 preserves the local integration branch for a task-branch Git-dependent verifier', () => {
  const dir = initRepo('c3-refs');
  fs.writeFileSync(path.join(dir, 'base.txt'), 'base\n');
  checkedGit(dir, 'add', '-A');
  checkedGit(dir, 'commit', '-qm', 'base');
  const base = checkedGit(dir, 'rev-parse', 'HEAD');
  checkedGit(dir, 'checkout', '-qb', 'task/mode-review');
  fs.writeFileSync(path.join(dir, 'candidate.txt'), 'candidate\n');
  checkedGit(dir, 'add', '-A');
  checkedGit(dir, 'commit', '-qm', 'candidate');
  assert.strictEqual(checkedGit(dir, 'merge-base', 'main', 'HEAD'), base);
  const mat = materialize.materializeCandidate(dir);
  try {
    assert(mat.ok, mat.error);
    assert.strictEqual(checkedGit(mat.dir, 'merge-base', 'main', 'HEAD'), base,
      'the same verifier must resolve the same integration fork point in the candidate');
    assert.strictEqual(checkedGit(mat.dir, 'symbolic-ref', '--short', 'HEAD'), 'task/mode-review');
  } finally { if (mat.cleanup) mat.cleanup(); }
});

test('C3 materialization retains raw blob bytes despite checkout conversion attributes', () => {
  const dir = initRepo('c3-bytes');
  fs.writeFileSync(path.join(dir, '.gitattributes'),
    'crlf.txt text eol=crlf\nident.txt ident\nutf16.txt text working-tree-encoding=UTF-16LE\n');
  fs.writeFileSync(path.join(dir, 'crlf.txt'), 'first\nsecond\n');
  fs.writeFileSync(path.join(dir, 'ident.txt'), '$Id$\n');
  fs.writeFileSync(path.join(dir, 'utf16.txt'), Buffer.from('encoded\n', 'utf16le'));
  checkedGit(dir, 'add', '-A');
  checkedGit(dir, 'commit', '-qm', 'conversion attributes');
  const bytes = {};
  for (const name of ['.gitattributes', 'crlf.txt', 'ident.txt', 'utf16.txt']) {
    const r = run('git', ['-C', dir, 'cat-file', 'blob', 'HEAD:' + name], { encoding: null });
    assert.strictEqual(r.status, 0, String(r.stderr));
    bytes[name] = r.stdout;
  }
  // A plain checkout must demonstrably transform this fixture; otherwise the assertion is vacuous.
  const plain = mkTemp('c3-plain-checkout');
  checkedGit(dir, 'clone', '--quiet', '--shared', '--no-checkout', dir, plain);
  checkedGit(plain, 'read-tree', 'HEAD');
  checkedGit(plain, 'checkout-index', '-a', '-f');
  assert(!fs.readFileSync(path.join(plain, 'crlf.txt')).equals(bytes['crlf.txt']));
  const mat = materialize.materializeCandidate(dir);
  try {
    assert(mat.ok, mat.error);
    for (const name of Object.keys(bytes)) {
      assert(fs.readFileSync(path.join(mat.dir, name)).equals(bytes[name]), name + ' differs from Git blob');
    }
    assert(!fs.existsSync(path.join(mat.dir, '.git', 'info', 'attributes')),
      'the materialization override must not remain active during verification');
  } finally { if (mat.cleanup) mat.cleanup(); }
});

// ── C4 · acceptance and regression judge the same native candidate ─────────────────────────────
test('C4 the real verifier runs a REQUIRED regression executable predicate against the SAME '
  + 'materialized candidate as acceptance: with acceptance passing and bin/tool.sh at Git 100755 '
  + 'but a non-executable workspace bit, regressions=pass only because regression ran in the '
  + 'candidate (RED if it had run in the untrusted workspace)', () => {
  if (!POSIX) { console.log('    (native regression exec skipped on win32)'); return; }
  const dir = initRepo('c4');
  // Acceptance always passes, so the ONLY discriminator is where the regression predicate runs.
  fs.writeFileSync(path.join(dir, 'pipeline.config.json'),
    `${JSON.stringify({
      defaultBranch: 'main',
      verifyCommand: 'sh accept.sh',
      regressionCommand: 'test -x bin/tool.sh',
      frozenPaths: [],
    }, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, 'accept.sh'), '#!/bin/sh\nexit 0\n');
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'bin', 'tool.sh'), '#!/bin/sh\necho tool\n');
  fs.mkdirSync(path.join(dir, 'tests', 'acceptance', ISSUE), { recursive: true });
  fs.writeFileSync(path.join(dir, 'tests', 'acceptance', ISSUE, 'case.sh'), '# placeholder\n');
  git(dir, 'add', '-A');
  git(dir, 'update-index', '--chmod=+x', '--', 'bin/tool.sh');
  git(dir, 'commit', '-qm', 'c4 fixture');
  assert.strictEqual(treeMode(dir, 'HEAD', 'bin/tool.sh'), '100755', 'bin/tool.sh must be 100755');
  // Make the WORKSPACE copy non-executable: if regression ran in the workspace it would FAIL.
  fs.chmodSync(path.join(dir, 'bin', 'tool.sh'), 0o644);
  assert.notStrictEqual(run('sh', ['-c', `test -x "${posix(path.join(dir, 'bin', 'tool.sh'))}"`]).status, 0,
    'the workspace bit must be non-executable (so workspace-run regression would fail)');

  const r = run(process.execPath, [VERIFY], { cwd: dir, env: { ...BASE_ENV, WORKSPACE: dir, ISSUE_ID: ISSUE } });
  let json = null;
  try { json = JSON.parse(fs.readFileSync(path.join(dir, '.run', 'verify.json'), 'utf8')); } catch { /* reported */ }
  assert(json, `verify.json must be written: rc=${r.status} ${r.stderr}`);
  assert.strictEqual(json.acceptance, 'pass', `acceptance must pass, got ${json.acceptance}`);
  assert.strictEqual(json.regressions, 'pass',
    `the required regression exec predicate must PASS via the materialized candidate, got '${json.regressions}' `
    + '(fail means regression ran against the untrusted workspace, not the candidate)');
});

// ── C2 · required verified-evidence binding fails closed ───────────────────────────────────────
function bindingRepo(tag, { withBinding = null, filemode = 'false' } = {}) {
  const dir = initRepo(tag);
  if (filemode !== 'false') git(dir, 'config', 'core.filemode', filemode);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'body\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'binding fixture');
  fs.mkdirSync(path.join(dir, '.run'), { recursive: true });
  if (withBinding !== null) fs.writeFileSync(path.join(dir, '.run', 'verified-tree'), withBinding);
  return dir;
}

test('C2 staleEvidence fails CLOSED on a mode-untrusted candidate whose required binding is '
  + 'MISSING — the verified-success outcome and PR are refused, not skipped', () => {
  const dir = bindingRepo('c2-missing', { withBinding: null });
  assert(materialize.fileModeUntrusted(dir), 'the fixture must be mode-untrusted');
  const v = runmod.staleEvidence(dir, null, {});
  assert(typeof v === 'string' && /required/.test(v),
    `a missing required binding must be refused, got ${JSON.stringify(v)}`);
});

test('C2 staleEvidence fails CLOSED on a mode-untrusted candidate whose required binding is '
  + 'MALFORMED', () => {
  const dir = bindingRepo('c2-malformed', { withBinding: 'not-a-tree-id\n' });
  const v = runmod.staleEvidence(dir, null, {});
  assert(typeof v === 'string' && /malformed|required/.test(v),
    `a malformed required binding must be refused, got ${JSON.stringify(v)}`);
});

test('C2 staleEvidence PASSES (null) when the required binding matches the candidate tree, and '
  + 'REFUSES when the candidate tree changed after verification', () => {
  const dir = bindingRepo('c2-valid', { withBinding: null });
  const head = (git(dir, 'rev-parse', 'HEAD^{tree}').stdout || '').trim();
  fs.writeFileSync(path.join(dir, '.run', 'verified-tree'), `${head}\n`);
  assert.strictEqual(runmod.staleEvidence(dir, null, {}), null,
    'a binding that matches the current tree must not be refused');
  // Mutate content after "verification": commit a change so HEAD^{tree} differs from the binding.
  fs.writeFileSync(path.join(dir, 'a.txt'), 'changed body\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'post-verification mutation');
  const v = runmod.staleEvidence(dir, null, {});
  assert(typeof v === 'string' && /stale/.test(v),
    `a candidate changed after verification must be refused as stale, got ${JSON.stringify(v)}`);
});

test('C2 staleEvidence preserves the legacy path: a mode-TRUSTED candidate with NO binding is '
  + '"nothing to enforce" (null), not a refusal', () => {
  const dir = bindingRepo('c2-legacy', { withBinding: null, filemode: 'true' });
  assert(!materialize.fileModeUntrusted(dir), 'the fixture must be mode-trusted');
  assert.strictEqual(runmod.staleEvidence(dir, null, {}), null,
    'a faithful worktree with no binding must not be refused (ordinary/legacy runs unchanged)');
});

// Host producer/consumer regression. Only external Git setup, Beads, execution, probe and
// GitHub boundaries are substituted; prepare, verify, status, pause and publication are real.
async function bindingBoundary(behavior) {
  const world = mkTemp('c2-boundary-' + behavior);
  const seed = path.join(world, 'seed');
  const remote = path.join(world, 'remote.git');
  const evidencePath = path.join(world, 'evidence.json');
  const tracePath = path.join(world, 'verification-runs.txt');
  const ghPath = path.join(world, 'gh-calls.txt');
  fs.mkdirSync(seed);
  checkedGit(world, 'init', '-q', '--bare', '-b', 'main', remote);
  checkedGit(seed, 'init', '-q', '-b', 'main');
  checkedGit(seed, 'config', 'user.name', 'Mode boundary fixture');
  checkedGit(seed, 'config', 'user.email', 'fixture@example.invalid');
  checkedGit(seed, 'config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(seed, 'pipeline.config.json'), JSON.stringify({
    defaultBranch: 'main', verifyCommand: 'node accept.cjs', frozenPaths: [],
  }) + '\n');
  fs.writeFileSync(path.join(seed, 'product.txt'), 'initial\n');
  fs.writeFileSync(path.join(seed, 'accept.cjs'), [
    'const fs = require("fs");',
    'fs.appendFileSync(process.env.BOUNDARY_TRACE, "verified\\n");',
    'process.exit(fs.readFileSync("product.txt", "utf8") === "verified\\n" ? 0 : 1);',
  ].join('\n'));
  fs.mkdirSync(path.join(seed, 'tests', 'acceptance', ISSUE), { recursive: true });
  fs.writeFileSync(path.join(seed, 'tests', 'acceptance', ISSUE, 'case.txt'), 'frozen placeholder\n');
  checkedGit(seed, 'add', '-A');
  checkedGit(seed, 'commit', '-qm', 'seed');
  checkedGit(seed, 'remote', 'add', 'origin', remote);
  checkedGit(seed, 'push', '-q', 'origin', 'main');

  const bd = path.join(world, 'bd.cjs');
  fs.writeFileSync(bd, [
    'const fs = require("fs"), path = require("path");',
    'const verb = path.basename(process.argv[1] || "");',
    'if (new Set(["show", "update", "ready", "note", "remember", "export", "create", "close", "list", "memories"]).has(verb)) {',
    '  fs.writeSync(1, verb === "show" ? JSON.stringify([{ id: process.env.BOUNDARY_ISSUE, title: "mode binding fixture", description: "Keep verified tree binding", acceptance_criteria: "pass", design: "DESIGN.md 4.4" }]) : "[]");',
    '  process.exit(0);',
    '}',
  ].join('\n'));
  const gh = path.join(world, 'gh.cjs');
  fs.writeFileSync(gh, 'require("fs").appendFileSync(process.env.BOUNDARY_GH_LOG,"called\\n"); console.log("https://example.test/pr/1");\n');
  const driver = path.join(world, 'execution.cjs');
  fs.writeFileSync(driver, [
    'const fs = require("fs"), path = require("path"), cp = require("child_process"), assert = require("assert");',
    'function command(exe,args) { const r=cp.spawnSync(exe,args,{encoding:"utf8"}); assert.strictEqual(r.status,0,exe+" "+args.join(" ")+": "+r.stderr); return String(r.stdout||"").trim(); }',
    'const git=(...args)=>command("git",args);',
    'const evidence=process.env.BOUNDARY_EVIDENCE;',
    'if (fs.existsSync(evidence)) {',
    '  const prior=JSON.parse(fs.readFileSync(evidence,"utf8"));',
    '  prior.resumed=true; prior.resumeFilemode=git("config","--bool","core.filemode");',
    '  prior.verificationAfterResume=fs.readFileSync(".run/verify.json","utf8");',
    '  fs.writeFileSync(evidence,JSON.stringify(prior)); process.exit(0);',
    '}',
    'const initialFilemode=git("config","--bool","core.filemode");',
    'assert.strictEqual(initialFilemode,"false","the real host-prepared clone must already be mode-untrusted before external execution");',
    'git("config","user.name","Mode boundary fixture"); git("config","user.email","fixture@example.invalid");',
    'fs.writeFileSync("product.txt","verified\\n"); git("add","product.txt"); git("commit","-qm","verified candidate");',
    'const status=path.join(process.env.BOUNDARY_PIPE,"status.js");',
    'command(process.execPath,[status,"init",process.env.ISSUE_ID]);',
    'command(process.execPath,[path.join(process.env.BOUNDARY_PIPE,"verify.js")]);',
    'command(process.execPath,[status,"append","pass"]);',
    'command(process.execPath,[status,"set","changeSummary","Verified candidate fixture"]);',
    'const before=fs.readFileSync(".run/verify.json","utf8"); assert.strictEqual(JSON.parse(before).acceptance,"pass");',
    'const binding=fs.readFileSync(".run/verified-tree","utf8").trim();',
    'const treeBefore=git("rev-parse","HEAD^{tree}"); assert.strictEqual(binding,treeBefore);',
    'if (process.env.BOUNDARY_BEHAVIOR === "downgrade") {',
    '  fs.unlinkSync(".run/verified-tree"); git("config","core.filemode","true");',
    '  fs.writeFileSync("product.txt","unverified changed bytes\\n"); git("add","product.txt"); git("commit","--amend","--no-edit","-q");',
    '}',
    'fs.writeFileSync(evidence,JSON.stringify({initialFilemode,binding,treeBefore,treeAfter:git("rev-parse","HEAD^{tree}"),filemodeAfter:git("config","--bool","core.filemode"),bindingPresent:fs.existsSync(".run/verified-tree"),verificationBefore:before,verificationAfter:fs.readFileSync(".run/verify.json","utf8")}));',
    '// A real rate-limit relaunch must retain the host snapshot despite the changed config.',
    'process.exit(process.env.BOUNDARY_BEHAVIOR === "downgrade" ? 20 : 0);',
  ].join('\n'));
  const execution = path.join(world, 'execution.sh');
  fs.writeFileSync(execution, '#!/bin/sh\nexec node "$BOUNDARY_DRIVER"\n');

  const env = { ...BASE_ENV };
  for (const name of ['PIPELINE_CHILD_AUTHORITY', 'PIPELINE_CHATGPT_AUTH', 'PIPELINE_KEEP_WORKSPACE',
    'PIPELINE_EXEC_STUB', 'WORKSPACE', 'RUN_DIR', 'ISSUE_ID']) delete env[name];
  const nullConfig = path.join(world, 'empty.gitconfig');
  fs.writeFileSync(nullConfig, '');
  Object.assign(env, {
    GIT_CONFIG_GLOBAL: nullConfig, GIT_CONFIG_SYSTEM: nullConfig,
    BD_SKIP_AUTO_PUSH: '1', BD_SKIP_AUTO_PULL: '1',
    PIPELINE_BD_CMD: process.execPath, NODE_OPTIONS: `--require "${posix(bd)}"`,
    PIPELINE_GH_CMD: `node "${posix(gh)}"`, PIPELINE_EXEC_STUB: execution,
    PIPELINE_PROBE_CMD: 'exit 0',
    BOUNDARY_ISSUE: ISSUE, BOUNDARY_BEHAVIOR: behavior,
    BOUNDARY_DRIVER: driver, BOUNDARY_PIPE: path.join(ROOT, 'pipeline'),
    BOUNDARY_EVIDENCE: evidencePath, BOUNDARY_TRACE: tracePath, BOUNDARY_GH_LOG: ghPath,
  });
  if (POSIX) {
    // On Windows a fresh real clone naturally has core.filemode=false. On Linux substitute
    // only the Git process boundary: do the real clone, then establish that host premise
    // before returning to prepare. Do not modify the host snapshot or its consumer.
    const realGit = run('sh', ['-c', 'command -v git'], { env }).stdout.trim();
    assert(path.isAbsolute(realGit), 'resolve a real Git executable before installing the adapter');
    const bin = path.join(world, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'git'), [
      '#!/bin/sh',
      `"${realGit}" "$@"; rc=$?`,
      '[ "$rc" -eq 0 ] || exit "$rc"',
      'clone=0; last=""',
      'for arg do [ "$arg" = clone ] && clone=1; last="$arg"; done',
      `if [ "$clone" -eq 1 ]; then "${realGit}" -C "$last" config core.filemode false || exit 1; fi`,
      'exit 0',
    ].join('\n'), { mode: 0o755 });
    env.PATH = bin + path.delimiter + env.PATH;
  }
  const cfg = {
    targetRepoPath: seed, targetRepoRemote: remote, image: 'unused:local',
    wallClockMinutes: 5, maxAttempts: 1, concurrency: 1,
    probeIntervalMinutes: 0, maxPauseCycles: 2,
    gitTimeoutMs: 60000, bdTimeoutMs: 60000, lifecycleTimeoutMs: 60000,
    hostShell: process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash',
  };
  const savedEnv = { ...process.env };
  let row;
  try {
    for (const name of Object.keys(process.env)) delete process.env[name];
    Object.assign(process.env, env);
    const log = require(path.join(ROOT, 'runner', 'log')).startRun(path.join(world, 'runs'), 'mode-boundary-' + behavior);
    const gate = require(path.join(ROOT, 'runner', 'pause')).createPauseGate(cfg, log, { token: 'fixture-token' });
    row = await runmod.runOneTask(cfg, { id: ISSUE, title: 'mode binding fixture', priority: 1 }, log, 'fixture-token', gate);
  } finally {
    for (const name of Object.keys(process.env)) delete process.env[name];
    Object.assign(process.env, savedEnv);
  }
  assert(fs.existsSync(evidencePath), 'the external execution must have completed real verification');
  const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
  assert.strictEqual(evidence.initialFilemode, 'false');
  assert.strictEqual(evidence.verificationAfter, evidence.verificationBefore, 'passing verifier evidence must not be rewritten');
  assert.strictEqual(fs.readFileSync(tracePath, 'utf8'), 'verified\n', 'the verifier must run exactly once');
  const ghCalls = fs.existsSync(ghPath) ? fs.readFileSync(ghPath, 'utf8').trim().split('\n').length : 0;
  if (behavior === 'control') {
    assert(evidence.bindingPresent, 'control keeps the real binding');
    assert.strictEqual(row.outcome, 'done', JSON.stringify(row));
    assert.strictEqual(ghCalls, 1, 'the positive control must reach real PR creation');
  } else {
    assert.strictEqual(evidence.bindingPresent, false);
    assert.strictEqual(evidence.filemodeAfter, 'true');
    assert.notStrictEqual(evidence.treeAfter, evidence.treeBefore, 'candidate must change after verification');
    assert.strictEqual(evidence.resumed, true, 'must traverse the actual pause/relaunch loop');
    assert.strictEqual(evidence.resumeFilemode, 'true', 'relaunch sees the changed mutable config');
    assert.strictEqual(evidence.verificationAfterResume, evidence.verificationBefore);
    assert.strictEqual(row.pauses, 1);
    assert.strictEqual(row.outcome, 'failed', JSON.stringify(row));
    assert(/binding.*required|required.*binding/.test(row.error || ''), 'refusal must identify required binding');
    assert.strictEqual(ghCalls, 0, 'missing required binding must never reach PR creation');
  }
}

test('C2 runOneTask publishes a genuinely verified candidate with its binding intact', () => bindingBoundary('control'));
test('C2 runOneTask refuses missing binding after config downgrade, tree change and actual relaunch', () => bindingBoundary('downgrade'));


// ── C1 · the canonical gate materializes IN the container, not on the host ──────────────────────
function buildGateTree(tag, root, mode, worktreeExec) {
  const dir = path.join(root, tag);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'fixture@example.invalid');
  git(dir, 'config', 'user.name', 'repo-3ec mode-review');
  git(dir, 'config', 'core.filemode', 'false');
  git(dir, 'config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(dir, 'pipeline.config.json'),
    `${JSON.stringify({ defaultBranch: 'main', verifyCommand: 'sh run-tests.sh', frozenPaths: [] }, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, 'run-tests.sh'),
    '#!/bin/sh\ngit merge-base main HEAD >/dev/null 2>&1 || exit 75\n'
    + 'node -e \'const fs=require("fs"),cp=require("child_process");const r=cp.spawnSync("git",["cat-file","blob","HEAD:payload.txt"]);process.exit(r.status===0&&fs.readFileSync("payload.txt").equals(r.stdout)?0:1)\' || exit 75\n'
    + 'd="$1"\nn=0\nfor f in "$d"*.sh; do [ -e "$f" ] || continue; n=$((n+1)); sh "$f" || exit 1; done\n'
    + '[ "$n" -gt 0 ] || { echo "no test files in $d" >&2; exit 1; }\nexit 0\n');
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'bin', 'tool.sh'), '#!/bin/sh\necho tool\n');
  fs.mkdirSync(path.join(dir, 'tests', 'acceptance', '_control'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'tests', 'acceptance', '_control', 'ok.sh'), '#!/bin/sh\nexit 0\n');
  fs.mkdirSync(path.join(dir, 'tests', 'acceptance', ISSUE), { recursive: true });
  fs.writeFileSync(path.join(dir, 'tests', 'acceptance', ISSUE, '01-exec.sh'),
    '#!/bin/sh\ntest -x bin/tool.sh\n');
  git(dir, 'add', '-A');
  if (mode === '100755') git(dir, 'update-index', '--chmod=+x', '--', 'bin/tool.sh');
  fs.writeFileSync(path.join(dir, '.gitattributes'), 'payload.txt text eol=crlf\n');
  fs.writeFileSync(path.join(dir, 'payload.txt'), 'exact Git bytes\n');
  checkedGit(dir, 'add', '.gitattributes', 'payload.txt');
  checkedGit(dir, 'commit', '-qm', 'gate fixture');
  // Real tasks run on task branches: clone must preserve the local main ref as well.
  checkedGit(dir, 'checkout', '-qb', 'task/gate-review');
  assert.strictEqual(treeMode(dir, 'HEAD', 'bin/tool.sh'), mode, `${tag} did not commit at ${mode}`);
  fs.chmodSync(path.join(dir, 'bin', 'tool.sh'), worktreeExec ? 0o755 : 0o644);
  return dir;
}

test('C1 the real freeze-gate materializes the candidate INSIDE the container (the mount handed '
  + 'to docker run is the RAW repo, materialization runs against it), and still judges by the Git '
  + 'mode — baseline 100644 RED, probe 100755 GREEN, verdict red', () => {
  if (!POSIX) { console.log('    (freeze-gate mode discrimination skipped on win32)'); return; }
  const root = mkTemp('c1');
  const baseline = buildGateTree('baseline', root, '100644', true);
  const probe = buildGateTree('probe', root, '100755', false);
  const mountsLog = path.join(root, 'mounts.tsv');
  // The mount-address adapter (correction 1 boundary): it records the -v mount, then translates
  // `docker run … -v <host>:/workspace … -c "<script>" freeze-gate <dir>` into `sh -c "<script>"`
  // run in <host>. Mount-address translation ONLY — it performs no materialization or chmod.
  const adapter = path.join(root, 'adapter.sh');
  fs.writeFileSync(adapter, [
    '#!/bin/sh',
    '[ "$1" = "rm" ] && exit 0',
    'mount=""',
    'script=""',
    'while [ $# -gt 0 ]; do',
    '  case "$1" in',
    '    -v) mount="${2%%:/workspace}"; shift 2 ;;',
    '    -c) script="$2"; shift 2; break ;;',
    '    *) shift ;;',
    '  esac',
    'done',
    '[ -n "$mount" ] || exit 1',
    `printf '%s\\n' "$mount" >> '${posix(mountsLog)}'`,
    'cd "$mount" || exit 1',
    'exec sh -c "$script" "$@"',
    '',
  ].join('\n'));
  fs.chmodSync(adapter, 0o755);

  const env = {
    ...BASE_ENV,
    FREEZE_GATE_DOCKER_IMAGE: 'repo-3ec/mode-review:local',
    FREEZE_GATE_DOCKER_CMD: adapter,
  };
  const g = run(process.execPath, [
    GATE, '--repo', baseline, '--tests', `tests/acceptance/${ISSUE}/`, '--green', probe,
  ], { cwd: ROOT, env });
  const out = (g.stdout || '') + (g.stderr || '');
  assert.notStrictEqual(g.status, 2, `the gate must run the fixture (2=indeterminate/harness fault): ${out.slice(-400)}`);
  assert.strictEqual(g.status, 0, `the Git-mode-judged verdict must be red (exit 0), got ${g.status}: ${out.slice(-400)}`);
  // Correction 1: the mount is the RAW candidate root — NOT a host-materialized temp dir. Under
  // the pre-correction code the host built r3ec-mat-* and mounted THAT.
  const mounts = fs.existsSync(mountsLog)
    ? fs.readFileSync(mountsLog, 'utf8').split('\n').filter(Boolean).map((m) => fs.realpathSync(m))
    : [];
  assert(mounts.length >= 2, `the gate must invoke the docker adapter for each side, saw ${mounts.length} mount(s)`);
  const rawRoots = new Set([fs.realpathSync(baseline), fs.realpathSync(probe)]);
  for (const m of mounts) {
    assert(rawRoots.has(m),
      `every mount must be a RAW candidate root (in-container materialization), not a host temp: ${m}`);
    assert(!/r3ec-mat-/.test(m), `a host-materialized directory must never be mounted: ${m}`);
  }
});

// ── C5 · docs rollback restores the verified-tree binding paired with verify.json ──────────────
test('C5 the real entrypoint restore_verified restores the verified-tree binding together with '
  + 'verify.json, so a rejected docs delta leaves the restored implementation tree matching its '
  + 'binding (not labelled stale)', () => {
  // Extract the REAL restore_verified function from the production entrypoint and drive it.
  const src = fs.readFileSync(ENTRYPOINT, 'utf8');
  const m = /\nrestore_verified\(\) \{[^\n]*\n[\s\S]*?\n\}\n/.exec(src);
  assert(m, 'restore_verified must be present in the entrypoint');
  const fnSrc = m[0];
  assert(/verified-tree/.test(fnSrc), 'restore_verified must handle the verified-tree binding (correction 5)');

  const repo = initRepo('c5');
  fs.writeFileSync(path.join(repo, 'impl.txt'), 'implementation\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'implementation');
  const implCommit = (git(repo, 'rev-parse', 'HEAD').stdout || '').trim();
  const implTree = (git(repo, 'rev-parse', 'HEAD^{tree}').stdout || '').trim();
  // A docs commit on top with a different tree — the state final-verify would have re-bound to.
  fs.writeFileSync(path.join(repo, 'README.md'), '# docs\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'docs');
  const docsTree = (git(repo, 'rev-parse', 'HEAD^{tree}').stdout || '').trim();
  assert.notStrictEqual(implTree, docsTree, 'the docs tree must differ from the implementation tree');

  const runDir = path.join(repo, '.run');
  fs.mkdirSync(runDir, { recursive: true });
  const implVerify = JSON.stringify({ issueId: ISSUE, acceptance: 'pass' });
  // Emulate the entrypoint state at the point of a docs rejection: the final verifier has already
  // overwritten the binding with the DOCS tree, and we captured the implementation's evidence.
  fs.writeFileSync(path.join(runDir, 'verify.json'), `${docsTree}\n`); // any stale content
  fs.writeFileSync(path.join(runDir, 'verified-tree'), `${docsTree}\n`);

  // Drive the REAL restore_verified with the captured implementation pair.
  const harness = [
    'set -eu',
    `RUN=${JSON.stringify(posix(runDir))}`,
    'die30() { echo "$1" >&2; exit 30; }',
    // Captured beside VERIFIED_RESULT by the entrypoint (correction 5).
    'VERIFIED_TREE_PRESENT=1',
    `VERIFIED_TREE=${JSON.stringify(implTree)}`,
    `cd ${JSON.stringify(posix(repo))}`,
    fnSrc,
    `restore_verified ${JSON.stringify(implCommit)} 1 ${JSON.stringify(implVerify)}`,
  ].join('\n');
  const r = run('sh', ['-c', harness]);
  assert.strictEqual(r.status, 0, `restore_verified must succeed: ${r.stderr}`);
  // HEAD is back at the implementation, and the binding matches the implementation tree.
  const restoredTree = (git(repo, 'rev-parse', 'HEAD^{tree}').stdout || '').trim();
  assert.strictEqual(restoredTree, implTree, 'HEAD must be restored to the implementation tree');
  const restoredBinding = fs.readFileSync(path.join(runDir, 'verified-tree'), 'utf8').trim();
  assert.strictEqual(restoredBinding, implTree,
    'the restored verified-tree binding must match the restored implementation tree, not the docs tree');
  // The paired verify.json is restored too.
  assert.strictEqual(fs.readFileSync(path.join(runDir, 'verify.json'), 'utf8').trim(), implVerify,
    'the restored verify.json must be the implementation evidence');

  // The host must NOT label this restored implementation stale.
  assert.strictEqual(runmod.staleEvidence(repo, null, {}), null,
    'the restored implementation + binding pair must not read as stale evidence');
});

// ── runner ─────────────────────────────────────────────────────────────────────────────────────
(async () => {
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`ok - ${t.name}`);
    } catch (e) {
      failed += 1;
      console.log(`not ok - ${t.name}`);
      console.log(`  ${(e && e.stack ? e.stack : String(e)).split('\n').join('\n  ')}`);
    }
  }
  for (const d of temps) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
  console.log(`\n${tests.length - failed}/${tests.length} checks passed`);
  process.exit(failed ? 1 : 0);
})();
