// Frozen acceptance test — repo-3ec, the [guard] half: the behaviour the Git-authoritative
// executable-mode change must NOT alter.
//
// [guard] Every check in this file is GREEN at the fork point and must stay green. They pin the
// invariants the executable-mode fix (see test.js) has to PRESERVE while it makes Git-authoritative
// modes decide publishable executable semantics: ordinary files stay mode 100644, a pre-existing
// executable stays 100755 when untouched, and an explicit `--chmod=-x` removal yields 100644 —
// with NO blanket-chmod and NO extension/shebang inference (C3); a frozen path whose CONTENT is
// changed is still refused as tampering by the real verifier, and a frozen symlink is still
// judged clean when unchanged (C5); the required-regression publication gate still permits a PR
// when the real regression evidence passes and refuses one when it does not, and the
// credential-disclosure scan still permits a clean branch and refuses one that introduces a
// secret (C5) — each with a positive control, an observable PR-CLI counter and real
// production-generated verifier evidence, never invented pass/outcome fields, an all-zero fork
// point or a nonexistent workspace; and the real verifier / entrypoint / publication modules this
// suite drives are present and this suite was merely added beside them (C6). Nothing red belongs
// here — a [guard] file red at the fork point is a stale pin and refuses the freeze.
//
// SELF-CONTAINED (run alone by the gate's guard subset): Node built-ins, a real local Git repo
// (with a real fork point and, where publication is exercised, a real bare remote) per case, the
// REAL entrypoint (pipeline/entrypoint.sh), the REAL verifier (pipeline/verify.js) and the REAL
// publication (runner/publish.js). Only the model and GitHub CLIs are replaced. No provider key,
// no network, no container.
//
// CRITERION PAIRING: G1->C3; G2,G4->C5; G3,G5->C5; G7->C5; G8->C5 (ownership boundary);
// G9->C5 (fork-point config authority); G6->C6; G10->C6 (materialization / verifier-operation
// error fails closed, no PR). C5 (index-only frozen-mode refusal, and the frozen
// content/symlink/regression/credential/ownership/fork-config invariants) is PRESERVED behaviour
// and is therefore proven entirely by guards; the new executable-mode behaviour C1..C4 and the
// integration RED paths C6 are driven in test.js (C3->T1,T5; C6->T5,T6,T7,T9).
//
// re-author correction 2: the materialization / verifier-operation-error case is a GUARD (G10),
// not a RED test — a scoped fault at an EXISTING production verifier operation (the frozen-config
// read `git show <forkPoint>:pipeline.config.json`) is already handled by the verifier's
// fail-closed try/catch at the fork point, so a correct executable-mode fix must PRESERVE it.
// re-author correction 3: G2 and G7 each carry an unchanged real pass/0 positive control; the
// ownership (G8) and fork-point-config (G9) boundaries are real producer/consumer positive-negative
// fixtures, not file-presence checks (G6 is a surface sanity guard only).
// re-author correction 6: every guard that spawns a production Git/CLI child sanitizes the ambient
// process.env boundary it inherits and restores it in a finally.
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const VERIFY = path.join(ROOT, 'pipeline', 'verify.js');
const ENTRYPOINT = path.join(ROOT, 'pipeline', 'entrypoint.sh');
const PIPE = path.join(ROOT, 'pipeline');
const publishMod = require(path.join(ROOT, 'runner', 'publish.js'));
const { outcomeFor } = require(path.join(ROOT, 'runner', 'queue.js'));
const { collectArtifacts } = require(path.join(ROOT, 'runner', 'workspace.js'));
const lock = require(path.join(ROOT, 'runner', 'lock.js'));
const { PR_ELIGIBLE_OUTCOMES } = publishMod;

const POSIX = process.platform !== 'win32';
const ISSUE = 'exec-fixture';
const SHELL = process.env.ACCEPTANCE_BASH || (process.platform === 'win32'
  && fs.existsSync('C:/Program Files/Git/bin/bash.exe') ? 'C:/Program Files/Git/bin/bash.exe' : 'bash');

// Isolate inherited Git global/system config and parent Node loader/test seams, and THREAD IT into
// every git()/run() and every spawned production path below (correction 8: not an unused copy). An
// EMPTY CONFIG FILE, not os.devNull, neutralises the inherited config on both Linux and the Windows
// author host, where pointing GIT_CONFIG_GLOBAL at the NUL device breaks every git config read.
const NULL_GITCONFIG = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'r3ecg-nullcfg-')), 'null.gitconfig');
fs.writeFileSync(NULL_GITCONFIG, '');
function isolatedEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of ['CODEX_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN',
    'PIPELINE_BD_CMD', 'PIPELINE_IMAGE_BD_CMD', 'PIPELINE_CHATGPT_AUTH', 'PIPELINE_GH_CMD',
    'NODE_OPTIONS', 'NODE_TEST_CONTEXT', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT',
    'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0',
    'GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE', 'GIT_OBJECT_DIRECTORY']) delete env[k];
  env.GIT_CONFIG_GLOBAL = NULL_GITCONFIG;
  env.GIT_CONFIG_SYSTEM = NULL_GITCONFIG;
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_TERMINAL_PROMPT = '0';
  return { ...env, ...extra };
}
const BASE_ENV = isolatedEnv();

const temps = [];
const tests = [];
function test(name, body) { tests.push({ name, body }); }

function run(cmd, args, options = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', timeout: 180000, windowsHide: true, env: BASE_ENV, ...options });
}
function git(dir, ...args) { return run('git', ['-c', 'core.autocrlf=false', ...args], { cwd: dir }); }
function mkTemp(tag) { const d = fs.mkdtempSync(path.join(os.tmpdir(), `r3ecg-${tag}-`)); temps.push(d); return d; }
const posix = (p) => p.split(path.sep).join('/');
function treeMode(dir, commit, file) {
  const r = git(dir, 'ls-tree', commit, '--', file);
  const m = /^(\d{6}) /.exec((r.stdout || '').trim());
  return m ? m[1] : null;
}
function indexMode(dir, file) {
  const r = git(dir, 'ls-files', '--stage', '--', file);
  const m = /^(\d{6}) ([0-9a-f]{40})/.exec((r.stdout || '').trim());
  return m ? { mode: m[1], blob: m[2] } : null;
}

// Run the REAL verifier against a fixture HEAD (WORKSPACE + ISSUE_ID, isolated env), returning the
// parsed verify.json and the exit code — the same production evidence the runner collects.
function runVerifier(dir, extraEnv = {}) {
  const r = run(process.execPath, [VERIFY], {
    cwd: dir, env: { ...BASE_ENV, WORKSPACE: dir, ISSUE_ID: ISSUE, ...extraEnv },
  });
  let json = null;
  try { json = JSON.parse(fs.readFileSync(path.join(dir, '.run', 'verify.json'), 'utf8')); }
  catch { /* reported by the caller */ }
  return { rc: r.status, json };
}

// A full-pipeline world with a pre-existing executable (bin/keepexec.sh, 100755) and a second
// pre-existing executable the model will explicitly de-x (bin/dropexec.sh, 100755). The configured
// verify command trivially passes, so the ONLY things these checks observe are the resulting Git
// modes — the mode-preservation behaviour the fix must not disturb. core.filemode is disabled.
function makeModeWorld(tag) {
  const root = mkTemp(tag);
  const target = path.join(root, 'target');
  fs.mkdirSync(target, { recursive: true });
  git(target, 'init', '-q', '-b', 'main');
  git(target, 'config', 'user.email', 'fixture@example.invalid');
  git(target, 'config', 'user.name', 'repo-3ec guard');
  git(target, 'config', 'core.filemode', 'false');
  git(target, 'config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(target, 'pipeline.config.json'),
    `${JSON.stringify({ defaultBranch: 'main', verifyCommand: 'sh verify-ok.sh', frozenPaths: [] }, null, 2)}\n`);
  fs.writeFileSync(path.join(target, 'verify-ok.sh'), '#!/bin/sh\nexit 0\n');
  fs.mkdirSync(path.join(target, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(target, 'bin', 'keepexec.sh'), '#!/bin/sh\necho keep\n');
  fs.writeFileSync(path.join(target, 'bin', 'dropexec.sh'), '#!/bin/sh\necho drop\n');
  fs.mkdirSync(path.join(target, 'tests', 'acceptance', ISSUE), { recursive: true });
  fs.writeFileSync(path.join(target, 'tests', 'acceptance', ISSUE, 'case.sh'), '# frozen placeholder\n');
  git(target, 'add', '-A');
  git(target, 'update-index', '--chmod=+x', '--', 'bin/keepexec.sh');
  git(target, 'update-index', '--chmod=+x', '--', 'bin/dropexec.sh');
  git(target, 'commit', '-qm', 'base with executables');
  assert.strictEqual(treeMode(target, 'HEAD', 'bin/keepexec.sh'), '100755', 'keepexec must start executable');
  assert.strictEqual(treeMode(target, 'HEAD', 'bin/dropexec.sh'), '100755', 'dropexec must start executable');
  git(target, 'checkout', '-q', '-b', 'task/exec');
  fs.mkdirSync(path.join(target, '.run'), { recursive: true });
  fs.writeFileSync(path.join(target, '.run', 'issue.md'), 'repo-3ec mode-preservation guard\n');
  const agent = path.join(root, 'agent.js');
  fs.writeFileSync(agent, [
    "'use strict';",
    'const fs = require("fs");',
    'const cp = require("child_process");',
    'let prompt = ""; try { prompt = fs.readFileSync(0, "utf8"); } catch { prompt = ""; }',
    'const git = (...a) => cp.spawnSync("git", a, { encoding: "utf8" });',
    'if (/change summary/i.test(prompt) || /in-repo documentation/i.test(prompt)) { process.stdout.write("mode-preservation guard summary.\\n"); process.exit(0); }',
    'fs.writeFileSync("plain.txt", "ordinary content\\n");',           // ordinary file -> 100644
    'git("update-index", "--chmod=-x", "--", "bin/dropexec.sh");',     // explicit removal -> 100644
    'process.exit(0);',                                                 // keepexec.sh untouched -> 100755
    '',
  ].join('\n'));
  return { root, target, agent };
}

function runEntrypoint(world) {
  return run(SHELL, [ENTRYPOINT], {
    cwd: world.target,
    env: {
      ...BASE_ENV, WORKSPACE: world.target, ISSUE_ID: ISSUE, PIPELINE_DIR: PIPE,
      PIPELINE_AGENT_CMD: `node "${posix(world.agent)}"`,
      PIPELINE_TESTING_NESTED_ENTRYPOINT: '1', PIPELINE_MAX_ATTEMPTS: '1',
      HOME: mkTemp('home'),
    },
  });
}

// Read only production-generated artifacts through the same schema/issue-id boundary as the host.
function entrypointArtifacts(target, tag) {
  const artifacts = collectArtifacts(target, mkTemp(`${tag}-artifacts`), ISSUE);
  for (const kind of ['status', 'verify']) {
    assert(artifacts.contracts[kind].ok,
      `${tag}: the real entrypoint must produce valid ${kind}: ${JSON.stringify(artifacts.contracts[kind])}`);
  }
  assert(artifacts.status.attempts.length >= 1, `${tag}: the entrypoint must record a verifier attempt`);
  return artifacts;
}

// ── G1 / C3 [guard] ─────────────────────────────────────────────────────────────────────────
test('G1 C3 [guard] the real entrypoint\'s staging preserves Git modes: after a verified run an ordinary new file is committed 100644, a pre-existing executable left untouched stays 100755, and a file the model explicitly de-executes with --chmod=-x becomes 100644 — no blanket chmod and no extension/shebang inference', () => {
  const w = makeModeWorld('g1');
  const r = runEntrypoint(w);
  assert.strictEqual(r.status, 0, `the guard run must verify and complete (rc=${r.status}; stderr ${(r.stderr || '').slice(-300)})`);
  const head = (git(w.target, 'rev-parse', 'HEAD').stdout || '').trim();
  assert.strictEqual(treeMode(w.target, head, 'plain.txt'), '100644', 'an ordinary file must be committed at 100644');
  assert.strictEqual(treeMode(w.target, head, 'bin/keepexec.sh'), '100755', 'a pre-existing executable left untouched must retain 100755');
  assert.strictEqual(treeMode(w.target, head, 'bin/dropexec.sh'), '100644', 'an explicit executable removal must yield 100644');
});

// ── G2 / C5 [guard] ─────────────────────────────────────────────────────────────────────────
test('G2 C5 [guard] the real verifier still refuses a frozen-path CONTENT change as tampering, and does not run the acceptance suite when it does: an UNCHANGED tree verifies pass/exit 0 with the acceptance command run exactly once (positive control), then editing tests/acceptance/<id>/case.sh in the worktree makes the verdict "tampered", exits 3, NAMES the affected frozen path, and the acceptance-run counter does NOT advance — the tests were not run (correction 3)', () => {
  const dir = mkTemp('g2');
  // The acceptance command increments a counter each time it runs, so "the tests are not run" on a
  // tampered verdict is an OBSERVABLE fact, not a claim. The counter lives outside the frozen tree.
  const sentinel = path.join(mkTemp('g2sent'), 'ran.txt');
  const countRuns = () => (fs.existsSync(sentinel) ? fs.readFileSync(sentinel, 'utf8').split('\n').filter(Boolean).length : 0);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'fixture@example.invalid');
  git(dir, 'config', 'user.name', 'repo-3ec guard');
  git(dir, 'config', 'core.filemode', 'false');
  git(dir, 'config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(dir, 'pipeline.config.json'),
    `${JSON.stringify({ defaultBranch: 'main', verifyCommand: 'sh verify-count.sh', frozenPaths: [] }, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, 'verify-count.sh'), '#!/bin/sh\nprintf \'ran\\n\' >> "$VC_SENTINEL"\nexit 0\n');
  fs.mkdirSync(path.join(dir, 'tests', 'acceptance', ISSUE), { recursive: true });
  const relFrozen = `tests/acceptance/${ISSUE}/case.sh`;
  const frozen = path.join(dir, 'tests', 'acceptance', ISSUE, 'case.sh');
  fs.writeFileSync(frozen, '# frozen placeholder\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'base');

  // Positive control: the unchanged tree verifies pass, exit 0, and the acceptance command ran once.
  const clean = runVerifier(dir, { VC_SENTINEL: sentinel });
  assert(clean.json, 'the verifier wrote no result for the unchanged tree');
  assert.strictEqual(clean.json.acceptance, 'pass', `the unchanged tree must verify pass, got ${clean.json.acceptance}`);
  assert.strictEqual(clean.rc, 0, `the unchanged tree must exit 0 (rc=${clean.rc})`);
  assert.strictEqual(countRuns(), 1, 'the acceptance command must have run exactly once for the clean control');

  // Now change the frozen file's CONTENT: it must be refused as tampering, the path named, and the
  // acceptance command must NOT run again.
  fs.appendFileSync(frozen, 'echo injected\n');
  const v = runVerifier(dir, { VC_SENTINEL: sentinel });
  assert(v.json, 'the verifier wrote no result for the frozen content change');
  assert.strictEqual(v.json.acceptance, 'tampered', `a frozen content change must be tampered, got ${v.json.acceptance}`);
  assert.strictEqual(v.rc, 3, `a tampered verdict must exit 3 (rc=${v.rc})`);
  assert(Array.isArray(v.json.tamperedPaths)
    && v.json.tamperedPaths.some((p) => p.replace(/\\/g, '/') === relFrozen),
    `the tampered verdict must name the affected frozen path, got ${JSON.stringify(v.json.tamperedPaths)}`);
  assert.strictEqual(countRuns(), 1, 'the acceptance command must NOT run on a tampered verdict — the counter must not advance');
});

// ── real publication world (G3/G5) ───────────────────────────────────────────────────────────
// A real disposable repo with a real fork-point commit, a real bare remote as origin, and a real
// task-branch commit; the REAL entrypoint produces status and verifier evidence, collected through
// the host's production artifact/schema reader before any outcome or publication is computed, and
// the outcome is computed with production outcomeFor(). No invented acceptance/outcome fields, no
// all-zero fork point, no nonexistent workspace (correction 7).
function realPublishWorld(tag, { regressionCommand, secretValue = null, extraTaskFiles = {} }) {
  const root = mkTemp(tag);
  const remote = path.join(root, 'remote.git');
  const dir = path.join(root, 'work');
  fs.mkdirSync(dir, { recursive: true });
  git(root, 'init', '-q', '--bare', '-b', 'main', remote);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'fixture@example.invalid');
  git(dir, 'config', 'user.name', 'repo-3ec guard');
  git(dir, 'config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(dir, 'pipeline.config.json'),
    `${JSON.stringify({ defaultBranch: 'main', verifyCommand: 'sh verify-ok.sh', regressionCommand, frozenPaths: [] }, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, 'verify-ok.sh'), '#!/bin/sh\nexit 0\n');
  fs.writeFileSync(path.join(dir, 'regress-pass.sh'), '#!/bin/sh\nexit 0\n');
  fs.writeFileSync(path.join(dir, 'regress-fail.sh'), '#!/bin/sh\nexit 1\n');
  fs.writeFileSync(path.join(dir, 'README.md'), 'base\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'base');
  const forkPoint = (git(dir, 'rev-parse', 'HEAD').stdout || '').trim();
  git(dir, 'remote', 'add', 'origin', remote);
  git(dir, 'push', '-q', 'origin', 'main');
  git(dir, 'checkout', '-q', '-b', 'task/x');
  fs.mkdirSync(path.join(dir, '.run'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.run', 'issue.md'), 'repo-3ec publication guard\n');
  const taskFiles = { 'feature.txt': 'implemented feature\n', ...extraTaskFiles };
  if (secretValue) taskFiles['exposed.txt'] = `${secretValue}\n`;
  const agent = path.join(root, 'agent.js');
  fs.writeFileSync(agent, [
    "'use strict';",
    'const fs = require("fs"); const path = require("path");',
    'const prompt = fs.readFileSync(0, "utf8");',
    'if (/change summary/i.test(prompt) || /in-repo documentation/i.test(prompt)) { process.stdout.write("publication guard summary.\\n"); process.exit(0); }',
    `for (const [rel, body] of Object.entries(${JSON.stringify(taskFiles)})) {`,
    '  fs.mkdirSync(path.dirname(rel), { recursive: true }); fs.writeFileSync(rel, body);',
    '}',
    '',
  ].join('\n'));
  const r = runEntrypoint({ target: dir, agent });
  assert.strictEqual(r.status, 0, `${tag}: the real entrypoint must complete (stderr ${(r.stderr || '').slice(-300)})`);
  const artifacts = entrypointArtifacts(dir, tag);
  assert.strictEqual(artifacts.verify.acceptance, 'pass', `${tag}: acceptance must be a real pass`);
  return { root, remote, dir, forkPoint, ...artifacts, rc: r.status };
}

// Call the REAL publish() with a real ctx, counting PR-CLI invocations via the production seam.
function publishWith(world, { regressionPolicy, secrets = [] }) {
  const ghLog = path.join(world.root, `gh-${path.basename(world.dir)}-${Math.random().toString(36).slice(2)}.txt`);
  const ctx = {
    ws: { dir: world.dir, branch: 'task/x', forkPoint: world.forkPoint, defaultBranch: 'main', regressionPolicy },
    outcome: outcomeFor(world.rc, world.verify),
    hasCommits: true,
    issueMarkdown: 'x',
    status: world.status,
    verify: world.verify,
    issue: { id: ISSUE, title: 't' },
    runId: 'guard',
    secrets,
  };
  // correction 6: publish() and its openPr seam spawn production Git/CLI children from the AMBIENT
  // process.env, not from this suite's BASE_ENV — so sanitize that actual boundary here and restore
  // every changed parent variable in the finally. A poison value is installed first for the seams
  // this test can observe through a real child (the PR CLI records what env it was handed), so
  // "sanitized" is an observation about the child, not an unused env object.
  const envSeen = path.join(world.root, `env-seen-${path.basename(world.dir)}-${Math.random().toString(36).slice(2)}.txt`);
  const saved = {};
  const set = (k, v) => { if (!(k in saved)) saved[k] = process.env[k]; process.env[k] = v; };
  const del = (k) => { if (!(k in saved)) saved[k] = process.env[k]; delete process.env[k]; };
  // The seams a leak would ride in on, installed as poison so the child can be seen to NOT inherit
  // them. NODE_OPTIONS is a harmless valid flag; the git config seams are benign values.
  set('NODE_OPTIONS', '--no-warnings');
  set('NODE_TEST_CONTEXT', 'poison-guard');
  set('GIT_CONFIG_COUNT', '1'); set('GIT_CONFIG_KEY_0', 'core.autocrlf'); set('GIT_CONFIG_VALUE_0', 'input');
  set('ANTHROPIC_API_KEY', 'poison-guard-key');
  // Now sanitize the boundary the git/CLI children actually inherit.
  set('GIT_CONFIG_GLOBAL', NULL_GITCONFIG); set('GIT_CONFIG_SYSTEM', NULL_GITCONFIG);
  set('GIT_CONFIG_NOSYSTEM', '1'); set('GIT_TERMINAL_PROMPT', '0');
  for (const k of ['CODEX_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN',
    'PIPELINE_BD_CMD', 'PIPELINE_IMAGE_BD_CMD', 'PIPELINE_CHATGPT_AUTH', 'PIPELINE_AGENT_CMD',
    'NODE_OPTIONS', 'NODE_TEST_CONTEXT', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT',
    'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0',
    'GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE', 'GIT_OBJECT_DIRECTORY']) del(k);
  // The PR CLI seam RECORDS the Git config count, Node loader seam and a credential var it was
  // handed, then behaves as the historic counter+URL stub.
  set('PIPELINE_GH_CMD', 'printf \'gcc=[%s] no=[%s] key=[%s]\\n\' "${GIT_CONFIG_COUNT:-unset}" '
    + '"${NODE_OPTIONS:-unset}" "${ANTHROPIC_API_KEY:-unset}" >> "' + posix(envSeen) + '"; '
    + 'printf \'call\\n\' >> "' + posix(ghLog) + '"; printf \'https://example.test/pr/1\\n\'');
  let res;
  try { res = publishMod.publish({ targetRepoPath: world.dir, gitTimeoutMs: 60000 }, ctx, { info() {}, error() {} }, 't'); }
  finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
  const prCalls = fs.existsSync(ghLog) ? fs.readFileSync(ghLog, 'utf8').split('\n').filter(Boolean).length : 0;
  const childEnv = fs.existsSync(envSeen) ? fs.readFileSync(envSeen, 'utf8').trim() : '';
  return { res, prCalls, childEnv };
}

// ── G3 / C5 [guard] ─────────────────────────────────────────────────────────────────────────
test('G3 C5 [guard] the required-regression publication gate is preserved with a positive control and an observable PR-CLI counter: with regressionPolicy "required" and REAL passing regression evidence the branch publishes (a PR is opened, PR-CLI called >=1), while REAL non-passing regression evidence refuses publication without opening a PR (PR-CLI called 0) and names the regression gate — real production-generated evidence, a real fork point and a real workspace throughout', () => {
  // Positive control: real regression pass permits publication.
  const passWorld = realPublishWorld('g3-pass', { regressionCommand: 'sh regress-pass.sh' });
  assert.strictEqual(passWorld.verify.regressions, 'pass', 'the positive control must carry real passing regression evidence');
  const okPub = publishWith(passWorld, { regressionPolicy: 'required' });
  assert(okPub.res && okPub.res.ok === true, `required regressions that pass must publish, got ${JSON.stringify(okPub.res)}`);
  assert(okPub.res.prUrl, 'the passing required-regression control must open a PR');
  assert(okPub.prCalls >= 1, `the passing control must call the PR CLI, got ${okPub.prCalls}`);
  // correction 6: the actual PR-CLI child inherited the SANITIZED ambient env — the leaked Git
  // config seam, the Node loader/test seam and a provider credential were all stripped before it ran.
  assert(/gcc=\[unset\] no=\[unset\] key=\[unset\]/.test(okPub.childEnv),
    `the PR-CLI child must observe a sanitized environment (no leaked GIT_CONFIG_COUNT, NODE_OPTIONS or credential), got ${JSON.stringify(okPub.childEnv)}`);

  // Refusal: real regression non-pass refuses.
  const failWorld = realPublishWorld('g3-fail', { regressionCommand: 'sh regress-fail.sh' });
  assert.strictEqual(failWorld.verify.regressions, 'fail', 'the refusal case must carry real non-passing regression evidence');
  const noPub = publishWith(failWorld, { regressionPolicy: 'required' });
  assert(noPub.res && noPub.res.ok === false, `required regressions that do not pass must refuse publication, got ${JSON.stringify(noPub.res)}`);
  assert(noPub.res.prUrl == null, 'a refused regression gate must not open a PR');
  assert.strictEqual(noPub.prCalls, 0, `a refused regression gate must not call the PR CLI, got ${noPub.prCalls}`);
  assert(/regression/i.test(noPub.res.error || ''), `the refusal must name the regression gate, got ${noPub.res.error}`);
});

// ── G4 / C5 [guard] ─────────────────────────────────────────────────────────────────────────
test('G4 C5 [guard] a frozen symlink is preserved, not mis-judged: an UNCHANGED frozen tree containing a committed symlink (Git mode 120000) verifies clean — the tamper check does not false-positive on the symlink, and the fix must not turn symlink handling into an executable-mode inference. POSIX-only — skipped and reported on win32', () => {
  if (!POSIX) {
    console.log('    (frozen-symlink guard skipped on win32 — symlink creation needs privilege; exercised by the canonical Linux gate)');
    return;
  }
  const dir = mkTemp('g4');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'fixture@example.invalid');
  git(dir, 'config', 'user.name', 'repo-3ec guard');
  git(dir, 'config', 'core.filemode', 'false');
  git(dir, 'config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(dir, 'pipeline.config.json'),
    `${JSON.stringify({ defaultBranch: 'main', verifyCommand: 'sh verify-ok.sh', frozenPaths: [] }, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, 'verify-ok.sh'), '#!/bin/sh\nexit 0\n');
  fs.mkdirSync(path.join(dir, 'tests', 'acceptance', ISSUE), { recursive: true });
  fs.writeFileSync(path.join(dir, 'tests', 'acceptance', ISSUE, 'case.sh'), '# frozen placeholder\n');
  fs.symlinkSync('case.sh', path.join(dir, 'tests', 'acceptance', ISSUE, 'link.sh'));
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'base with frozen symlink');
  assert.strictEqual(treeMode(dir, 'HEAD', `tests/acceptance/${ISSUE}/link.sh`), '120000', 'the frozen symlink must be committed at 120000');
  const v = runVerifier(dir);
  assert(v.json, 'the verifier wrote no result for the unchanged symlink tree');
  assert.notStrictEqual(v.json.acceptance, 'tampered', 'an unchanged frozen symlink must not be mis-detected as tampering');
  assert.strictEqual(v.json.acceptance, 'pass', `an unchanged frozen tree must verify pass, got ${v.json.acceptance}`);
});

// ── G5 / C5 [guard] ─────────────────────────────────────────────────────────────────────────
test('G5 C5 [guard] the credential-disclosure scan is preserved with a positive control and an observable PR-CLI counter: an otherwise identical clean branch publishes (a PR is opened, PR-CLI called >=1), while a branch whose introduced objects contain a secret is refused before push/PR (PR-CLI called 0, not pushed), names the disclosure scan, and never reflects the secret bytes in its diagnostics — the executable-mode change must not weaken the exfiltration boundary', () => {
  // Never a literal secret in this tracked file — the sanitize checker reads bytes. Assembled here.
  const secret = ['repo3ec', 'guard', 'S'.repeat(32)].join('-');

  // Positive control: a clean branch (the secret value is NOT present) publishes. Passing it as a
  // secret proves the scan looked and found nothing, not that scanning was skipped.
  const cleanWorld = realPublishWorld('g5-clean', { regressionCommand: 'sh regress-pass.sh' });
  const okPub = publishWith(cleanWorld, { regressionPolicy: 'evidence', secrets: [secret] });
  assert(okPub.res && okPub.res.ok === true, `a clean branch must publish, got ${JSON.stringify(okPub.res)}`);
  assert(okPub.res.prUrl, 'the clean control must open a PR');
  assert(okPub.prCalls >= 1, `the clean control must call the PR CLI, got ${okPub.prCalls}`);

  // Refusal: the introduced object carries the secret.
  const secretWorld = realPublishWorld('g5-secret', { regressionCommand: 'sh regress-pass.sh', secretValue: secret });
  const noPub = publishWith(secretWorld, { regressionPolicy: 'evidence', secrets: [secret] });
  assert(noPub.res && noPub.res.ok === false, `a branch introducing a secret must be refused, got ${JSON.stringify(noPub.res)}`);
  assert(noPub.res.prUrl == null, 'a refused credential scan must not open a PR');
  assert(noPub.res.pushed !== true, 'a branch failing the disclosure scan must not be pushed');
  assert.strictEqual(noPub.prCalls, 0, `a refused credential scan must not call the PR CLI, got ${noPub.prCalls}`);
  assert(/disclosure|credential/i.test(noPub.res.error || ''), `the refusal must name the disclosure scan, got ${noPub.res.error}`);
  assert(!String(noPub.res.error || '').includes(secret), 'the secret bytes must never be reflected in the refusal diagnostics');
});

// ── G6 / C6 [guard] ─────────────────────────────────────────────────────────────────────────
test('G6 C6 [guard] the real verifier, entrypoint and publication modules this suite drives are present, and this task added its own suite (test.js + guard.js) beside them — a sanity guard on the production surface, not a roster of any historical suite', () => {
  for (const rel of [
    'pipeline/verify.js', 'pipeline/entrypoint.sh', 'runner/publish.js', 'scripts/freeze-gate.js',
    'scripts/prove-tests.js', 'runner/run.js', 'runner/queue.js',
  ]) {
    assert(fs.existsSync(path.join(ROOT, rel)), `a production module this suite drives is missing: ${rel}`);
  }
  const here = path.join(ROOT, 'tests', 'acceptance', 'repo-3ec');
  assert(fs.existsSync(path.join(here, 'test.js')), 'the new red suite (test.js) is missing');
  assert(fs.existsSync(path.join(here, 'guard.js')), 'the new guard suite (guard.js) is missing');
});

// ── G7 / C5 [guard] ─────────────────────────────────────────────────────────────────────────
test('G7 C5 [guard] an index-only mutation of a FROZEN path\'s Git mode is REFUSED as tampering and NOT silently repaired — preserved behaviour a correct executable-mode fix must keep: with core.filemode=false, staging `git update-index --chmod=+x` on tests/acceptance/<id>/case.sh (same blob, unchanged workspace bytes, unchanged HEAD) makes the real verifier report acceptance=tampered / exit 3 and name the frozen path, and after the refusal the index (still 100755, same blob), HEAD (still 100644) and workspace bytes/mode are all exactly as staged, so nothing was repaired', () => {
  const dir = mkTemp('g7');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'fixture@example.invalid');
  git(dir, 'config', 'user.name', 'repo-3ec guard');
  git(dir, 'config', 'core.filemode', 'false');
  git(dir, 'config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(dir, 'pipeline.config.json'),
    `${JSON.stringify({ defaultBranch: 'main', verifyCommand: 'sh verify-ok.sh', frozenPaths: [] }, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, 'verify-ok.sh'), '#!/bin/sh\nexit 0\n');
  fs.mkdirSync(path.join(dir, 'tests', 'acceptance', ISSUE), { recursive: true });
  const frozen = `tests/acceptance/${ISSUE}/case.sh`;
  const abs = path.join(dir, 'tests', 'acceptance', ISSUE, 'case.sh');
  fs.writeFileSync(abs, '# frozen placeholder\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'base');
  // Positive control (correction 3): the unchanged tree verifies pass / exit 0, so the refusal
  // below is a specific answer to the index-only mode mutation and not an unrelated earlier reject.
  const clean = runVerifier(dir);
  assert(clean.json && clean.json.acceptance === 'pass' && clean.rc === 0,
    `the unchanged frozen tree must verify pass/0 first, got acceptance=${clean.json && clean.json.acceptance} rc=${clean.rc}`);
  const beforeIndex = indexMode(dir, frozen);
  assert.strictEqual(treeMode(dir, 'HEAD', frozen), '100644', 'the frozen placeholder must start at 100644');
  assert(beforeIndex && beforeIndex.mode === '100644', `frozen index must start 100644, got ${JSON.stringify(beforeIndex)}`);

  // Stage an index-only executable-mode change to the frozen path.
  git(dir, 'update-index', '--chmod=+x', '--', frozen);
  const savedIndex = indexMode(dir, frozen);
  const savedBytes = fs.readFileSync(abs);
  const savedWsMode = POSIX ? (fs.statSync(abs).mode & 0o777) : null;
  assert(savedIndex && savedIndex.mode === '100755' && savedIndex.blob === beforeIndex.blob,
    `the mutation must be index-mode-only (same blob), got ${JSON.stringify(savedIndex)}`);

  const v = runVerifier(dir);
  assert(v.json, 'the verifier wrote no result for the index-only frozen mode mutation');
  assert.strictEqual(v.json.acceptance, 'tampered', `an index-only frozen mode mutation must be refused as tampering, got ${v.json.acceptance}`);
  assert.strictEqual(v.rc, 3, `a tampered verdict must exit 3 (rc=${v.rc})`);
  assert(Array.isArray(v.json.tamperedPaths) && v.json.tamperedPaths.some((p) => p.replace(/\\/g, '/') === frozen),
    `the refused frozen path must be named, got ${JSON.stringify(v.json.tamperedPaths)}`);

  // Refused, NOT repaired: re-read everything after the verifier and require exact equality.
  const afterIndex = indexMode(dir, frozen);
  assert(afterIndex && afterIndex.mode === '100755' && afterIndex.blob === savedIndex.blob,
    `the refused index mode/blob must be left exactly as staged (100755, same blob), not repaired, got ${JSON.stringify(afterIndex)}`);
  assert.strictEqual(treeMode(dir, 'HEAD', frozen), '100644', 'HEAD must still be 100644 (never silently committed/repaired)');
  assert(Buffer.compare(fs.readFileSync(abs), savedBytes) === 0, 'the frozen file bytes must be untouched by the refusal');
  if (POSIX) {
    assert.strictEqual(fs.statSync(abs).mode & 0o777, savedWsMode, 'the frozen file workspace mode must be untouched by the refusal');
  }
});

// ── G8 / C5 [guard] ─────────────────────────────────────────────────────────────────────────
// correction 3: a real producer/consumer ownership fixture through runner/lock.js — not a
// file-presence check. Create private checkout/target directories, isolate the host-global lock
// dir, acquire a real owner, refuse a competing checkout for the SAME target, release only the
// acquired owner, then allow the successor. Restore PIPELINE_GLOBAL_LOCK_DIR afterwards. The
// executable-mode fix must not weaken this ownership boundary.
test('G8 C5 [guard] the host-global target-ownership authority is preserved: a first checkout acquires a target, a competing checkout naming the SAME target is refused and told which run holds it (creating no false ownership mirror), and after the owner releases, a successor checkout acquires it', () => {
  const home = mkTemp('g8');
  const savedGlobal = process.env.PIPELINE_GLOBAL_LOCK_DIR;
  process.env.PIPELINE_GLOBAL_LOCK_DIR = path.join(home, 'host-global');
  try {
    const pipelineA = path.join(home, 'pipeline-a');
    const pipelineB = path.join(home, 'pipeline-b');
    const target = path.join(home, 'target');
    for (const p of [pipelineA, pipelineB, target]) fs.mkdirSync(p, { recursive: true });

    const first = lock.acquire(pipelineA, target, 'run-a');
    assert(first.ok === true, `the first checkout must acquire the target authority, got ${JSON.stringify(first)}`);
    const rival = lock.acquire(pipelineB, target, 'run-b');
    assert(rival.ok === false, 'a competing checkout for the same target must be refused');
    assert(rival.holder && rival.holder.runId === 'run-a',
      `the refusal must name the holding run, got ${JSON.stringify(rival.holder)}`);
    assert(!fs.existsSync(lock.lockPath(pipelineB, target)),
      'a refused checkout must create no false ownership mirror of its own');

    lock.release(pipelineA, target, first.ownership);
    const successor = lock.acquire(pipelineB, target, 'run-c');
    assert(successor.ok === true,
      `after the owner releases, a successor checkout must acquire the target, got ${JSON.stringify(successor)}`);
    lock.release(pipelineB, target, successor.ownership);
  } finally {
    if (savedGlobal === undefined) delete process.env.PIPELINE_GLOBAL_LOCK_DIR;
    else process.env.PIPELINE_GLOBAL_LOCK_DIR = savedGlobal;
  }
});

// ── G9 / C5 [guard] ─────────────────────────────────────────────────────────────────────────
// correction 3: the fork-point configuration boundary as a real producer/consumer positive-negative
// fixture. The verifier locates the fork point from the working-tree defaultBranch but reads the
// AUTHORITATIVE verifyCommand from the fork-point commit — so an implementation cannot edit its
// working-tree config to change the verdict. Positive: a fork-point PASS command wins over a
// working-tree edit to a failing one. Negative: a fork-point FAIL command wins over a working-tree
// edit to a passing one. The executable-mode fix must preserve this fork-point authority.
function makeForkConfigWorld(tag, { forkCmd, worktreeCmd }) {
  const dir = mkTemp(tag);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'fixture@example.invalid');
  git(dir, 'config', 'user.name', 'repo-3ec guard');
  git(dir, 'config', 'core.filemode', 'false');
  git(dir, 'config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(dir, 'verify-pass.sh'), '#!/bin/sh\nexit 0\n');
  fs.writeFileSync(path.join(dir, 'verify-fail.sh'), '#!/bin/sh\nexit 1\n');
  fs.mkdirSync(path.join(dir, 'tests', 'acceptance', ISSUE), { recursive: true });
  fs.writeFileSync(path.join(dir, 'tests', 'acceptance', ISSUE, 'case.sh'), '# frozen placeholder\n');
  // The fork-point commit carries the authoritative verifyCommand.
  fs.writeFileSync(path.join(dir, 'pipeline.config.json'),
    `${JSON.stringify({ defaultBranch: 'main', verifyCommand: forkCmd, frozenPaths: [] }, null, 2)}\n`);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'fork point');
  // A task branch whose working-tree config names a DIFFERENT command. pipeline.config.json is not
  // a frozen path, so this commit is not tampering; the verifier must still ignore it.
  git(dir, 'checkout', '-q', '-b', 'task/x');
  fs.writeFileSync(path.join(dir, 'pipeline.config.json'),
    `${JSON.stringify({ defaultBranch: 'main', verifyCommand: worktreeCmd, frozenPaths: [] }, null, 2)}\n`);
  git(dir, 'commit', '-qm', 'task edits working-tree config', '-a');
  return { dir };
}
test('G9 C5 [guard] the verifier reads its authoritative verifyCommand from the FORK POINT, not the working tree: a fork-point PASS command yields pass even when the working tree was edited to a failing command, and a fork-point FAIL command yields fail even when the working tree was edited to a passing command — the working-tree edit never changes the verdict', () => {
  const A = makeForkConfigWorld('g9a', { forkCmd: 'sh verify-pass.sh', worktreeCmd: 'sh verify-fail.sh' });
  const va = runVerifier(A.dir);
  assert(va.json && va.json.acceptance === 'pass' && va.rc === 0,
    `the fork-point PASS command must decide the verdict despite a working-tree edit to a failing command, got acceptance=${va.json && va.json.acceptance} rc=${va.rc}`);
  const B = makeForkConfigWorld('g9b', { forkCmd: 'sh verify-fail.sh', worktreeCmd: 'sh verify-pass.sh' });
  const vb = runVerifier(B.dir);
  assert(vb.json && vb.json.acceptance === 'fail' && vb.rc === 1,
    `the fork-point FAIL command must decide the verdict despite a working-tree edit to a passing command, got acceptance=${vb.json && vb.json.acceptance} rc=${vb.rc}`);
});

// ── G10 / C6 [guard] ────────────────────────────────────────────────────────────────────────
// correction 2: a materialization / verifier-operation error fails CLOSED, with no verified success
// and no PR. The old T8 faulted `git archive`/`git checkout-index`, prescribing how a future
// materializer must be built; instead this guard faults an EXISTING production verifier operation —
// the frozen-config read `git show <forkPoint>:pipeline.config.json` — with a pass-through git
// adapter installed IDENTICALLY in the positive and negative cases, changing only fault enablement.
// Because the real verifier's own try/catch ALREADY fails closed on that fault at the fork point,
// this is PRESERVED behaviour (a guard), not a new RED requirement.
//
// POSIX-only: a PATH-resolved `git` shim needs POSIX shell PATH semantics (win32 execSync resolves
// git.exe via PATHEXT and never sees an extensionless shim), so the whole guard is skipped and
// reported on win32 and exercised by the canonical Linux gate.
const G10_ADAPTER = [
  '#!/bin/sh',
  'printf \'%s\\n\' "$*" >> "$R3EC_GIT_TRACE" 2>/dev/null',
  // Scope STRICTLY to the verifier's frozen-config read; every other git command (fixture setup,
  // staging/commit, publication) is delegated unchanged. No materialization, mode logic or verdict.
  'if [ -n "$R3EC_FAULT" ] && [ "$1" = "show" ]; then',
  '  case "$*" in',
  '    *:pipeline.config.json*)',
  '      printf \'git show %s\\n\' "$2" >> "$R3EC_GIT_FAULTED" 2>/dev/null',
  '      echo "repo-3ec: injected fault at git show <forkPoint>:pipeline.config.json" >&2',
  '      exit 3 ;;',
  '  esac',
  'fi',
  'exec "$R3EC_GIT_REAL" "$@"',
  '',
].join('\n');
function makeMatWorld(tag) {
  const root = mkTemp(tag);
  const remote = path.join(root, 'remote.git');
  const target = path.join(root, 'target');
  fs.mkdirSync(target, { recursive: true });
  git(root, 'init', '-q', '--bare', '-b', 'main', remote);
  git(target, 'init', '-q', '-b', 'main');
  git(target, 'config', 'user.email', 'fixture@example.invalid');
  git(target, 'config', 'user.name', 'repo-3ec guard');
  git(target, 'config', 'core.filemode', 'false');
  git(target, 'config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(target, 'pipeline.config.json'),
    `${JSON.stringify({ defaultBranch: 'main', verifyCommand: 'sh verify-ok.sh', frozenPaths: [] }, null, 2)}\n`);
  fs.writeFileSync(path.join(target, 'verify-ok.sh'), '#!/bin/sh\nexit 0\n');
  fs.writeFileSync(path.join(target, 'README.md'), '# fixture\n');
  fs.mkdirSync(path.join(target, 'tests', 'acceptance', ISSUE), { recursive: true });
  fs.writeFileSync(path.join(target, 'tests', 'acceptance', ISSUE, 'case.sh'), '# frozen placeholder\n');
  git(target, 'add', '-A');
  git(target, 'commit', '-qm', 'seed');
  const forkPoint = (git(target, 'rev-parse', 'HEAD').stdout || '').trim();
  git(target, 'remote', 'add', 'origin', remote);
  git(target, 'push', '-q', 'origin', 'main');
  git(target, 'checkout', '-q', '-b', 'task/x');
  fs.mkdirSync(path.join(target, '.run'), { recursive: true });
  fs.writeFileSync(path.join(target, '.run', 'issue.md'), 'repo-3ec materialization/verifier-error guard\n');
  const agent = path.join(root, 'agent.js');
  fs.writeFileSync(agent, [
    "'use strict';",
    'const fs = require("fs");',
    'let prompt = ""; try { prompt = fs.readFileSync(0, "utf8"); } catch { prompt = ""; }',
    'if (/change summary/i.test(prompt) || /in-repo documentation/i.test(prompt)) { process.stdout.write("mat guard summary.\\n"); process.exit(0); }',
    'fs.writeFileSync("feature.txt", "implemented feature\\n");',
    'process.exit(0);',
    '',
  ].join('\n'));
  return { root, remote, target, agent, forkPoint };
}
function runMatEntrypoint(world, shim, fault) {
  const env = {
    ...BASE_ENV, WORKSPACE: world.target, ISSUE_ID: ISSUE, PIPELINE_DIR: PIPE,
    PIPELINE_AGENT_CMD: `node "${posix(world.agent)}"`,
    PIPELINE_TESTING_NESTED_ENTRYPOINT: '1', PIPELINE_MAX_ATTEMPTS: '1',
    HOME: mkTemp('g10home'),
    R3EC_GIT_REAL: shim.realGit, R3EC_GIT_TRACE: posix(shim.trace), R3EC_GIT_FAULTED: posix(shim.faulted),
    PATH: `${posix(shim.dir)}${path.delimiter}${process.env.PATH || ''}`,
  };
  if (fault) env.R3EC_FAULT = '1';
  const r = run(SHELL, [ENTRYPOINT], { cwd: world.target, env });
  const artifacts = entrypointArtifacts(world.target, fault ? 'g10-fault' : 'g10-pass');
  return { rc: r.status, stderr: r.stderr, ...artifacts };
}
// Publish the real workspace through the REAL runner/publish.js, counting PR-CLI calls, with the
// ambient process.env boundary sanitized and restored (correction 6).
function matPublish(world, outcome, { status, verify }) {
  const ghLog = path.join(world.root, `gh-${Math.random().toString(36).slice(2)}.txt`);
  const hasCommitsVal = ((git(world.target, 'rev-list', '--count', `${world.forkPoint}..HEAD`).stdout || '0').trim() !== '0');
  const ctx = {
    ws: { dir: world.target, branch: 'task/x', forkPoint: world.forkPoint, defaultBranch: 'main', regressionPolicy: 'evidence' },
    outcome, hasCommits: hasCommitsVal, issueMarkdown: 'x', status,
    verify, issue: { id: ISSUE, title: 't' }, runId: 'guard', secrets: ['g10-secret-absent'],
  };
  const saved = {};
  const set = (k, v) => { if (!(k in saved)) saved[k] = process.env[k]; process.env[k] = v; };
  const del = (k) => { if (!(k in saved)) saved[k] = process.env[k]; delete process.env[k]; };
  set('GIT_CONFIG_GLOBAL', NULL_GITCONFIG); set('GIT_CONFIG_SYSTEM', NULL_GITCONFIG);
  set('GIT_CONFIG_NOSYSTEM', '1'); set('GIT_TERMINAL_PROMPT', '0');
  for (const k of ['CODEX_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN',
    'PIPELINE_BD_CMD', 'PIPELINE_IMAGE_BD_CMD', 'PIPELINE_CHATGPT_AUTH', 'PIPELINE_AGENT_CMD',
    'NODE_OPTIONS', 'NODE_TEST_CONTEXT', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT',
    'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE',
    'GIT_OBJECT_DIRECTORY']) del(k);
  set('PIPELINE_GH_CMD', 'printf \'call\\n\' >> "' + posix(ghLog) + '"; printf \'https://example.test/pr/1\\n\'');
  let res;
  try { res = publishMod.publish({ targetRepoPath: world.target, gitTimeoutMs: 60000 }, ctx, { info() {}, error() {} }, 'g10-secret-absent'); }
  finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
  const prCalls = fs.existsSync(ghLog) ? fs.readFileSync(ghLog, 'utf8').split('\n').filter(Boolean).length : 0;
  return { res, prCalls };
}
test('G10 C6 [guard] a materialization / verifier-operation error fails CLOSED with no success and no PR: a pass-through git adapter is installed identically in both cases and faults ONLY the verifier\'s frozen-config read; the UNFAULTED positive verifies, publishes and opens a PR (the targeted operation delegated), while the FAULTED run reaches acceptance=error with bounded diagnostics naming the failed operation, a non-PR-eligible real outcome, null PR URL and ZERO PR-creation calls (the targeted operation faulted). POSIX-only — skipped and reported on win32', () => {
  if (!POSIX) {
    console.log('    (G10 materialization/verifier-operation-error skipped on win32 — a PATH-resolved git shim needs POSIX PATH semantics; exercised by the canonical Linux gate)');
    return;
  }
  const realGit = (run(SHELL, ['-c', 'command -v git']).stdout || '').trim().split('\n').pop();
  const mkShim = (tag) => {
    const dir = mkTemp(tag);
    fs.writeFileSync(path.join(dir, 'git'), G10_ADAPTER);
    try { fs.chmodSync(path.join(dir, 'git'), 0o755); } catch { /* posix */ }
    return { dir, realGit, trace: path.join(dir, 'trace.txt'), faulted: path.join(dir, 'faulted.txt') };
  };

  // Positive control: identical adapter, no fault -> the config read is delegated, verify passes,
  // the real outcome is PR-eligible, and a PR is opened.
  const posWorld = makeMatWorld('g10-ok');
  const posShim = mkShim('g10-ok-shim');
  const okRun = runMatEntrypoint(posWorld, posShim, false);
  assert(okRun.verify && okRun.verify.acceptance === 'pass',
    `the unfaulted positive must verify pass, got ${JSON.stringify(okRun.verify)} (stderr ${(okRun.stderr || '').slice(-200)})`);
  const okTrace = fs.existsSync(posShim.trace) ? fs.readFileSync(posShim.trace, 'utf8') : '';
  assert(/(^|\n)show .*:pipeline\.config\.json/.test(okTrace),
    'the frozen-config read must have been reached and delegated by the pass-through adapter in the positive case');
  const okOutcome = outcomeFor(okRun.rc, okRun.verify);
  assert(PR_ELIGIBLE_OUTCOMES.has(okOutcome.status),
    `the unfaulted positive must reach a PR-eligible real outcome, got ${okOutcome.status}`);
  const okPub = matPublish(posWorld, okOutcome, okRun);
  assert(okPub.res && okPub.res.prUrl && okPub.prCalls >= 1,
    `the unfaulted positive must open a PR, got ${JSON.stringify(okPub.res)} prCalls=${okPub.prCalls}`);

  // Faulted run: identical adapter, fault enabled -> the verifier fails closed on the frozen-config
  // read; no success, bounded diagnostics naming the failed operation, null PR, zero PR calls.
  const faultWorld = makeMatWorld('g10-fault');
  const faultShim = mkShim('g10-fault-shim');
  const badRun = runMatEntrypoint(faultWorld, faultShim, true);
  const faulted = fs.existsSync(faultShim.faulted) ? fs.readFileSync(faultShim.faulted, 'utf8') : '';
  assert(/git show .*:pipeline\.config\.json/.test(faulted),
    `the targeted verifier operation (frozen-config read) must have been reached and faulted, got ${JSON.stringify(faulted)}`);
  assert(badRun.verify && badRun.verify.acceptance === 'error',
    `the faulted verifier must fail closed as acceptance=error, got ${JSON.stringify(badRun.verify)}`);
  assert(typeof badRun.verify.error === 'string' && /frozen config/i.test(badRun.verify.error)
    && badRun.verify.error.length <= 400,
    `the failure must carry a bounded diagnostic naming the failed operation, got ${JSON.stringify(badRun.verify.error)}`);
  const badOutcome = outcomeFor(badRun.rc, badRun.verify);
  assert(!PR_ELIGIBLE_OUTCOMES.has(badOutcome.status),
    `a faulted verifier operation must not reach a verified-success outcome, got ${badOutcome.status}`);
  const badPub = matPublish(faultWorld, badOutcome, badRun);
  assert((badPub.res && badPub.res.prUrl == null) && badPub.prCalls === 0,
    `a faulted verifier operation must open no PR and make zero PR-creation calls, got ${JSON.stringify(badPub.res)} prCalls=${badPub.prCalls}`);
});

(async () => {
  let failed = 0;
  for (const item of tests) {
    try { await item.body(); console.log(`ok - ${item.name}`); }
    catch (error) { failed = 1; console.log(`FAIL - ${item.name} — ${error && error.message ? error.message : error}`); }
  }
  for (const dir of temps.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* disposable */ }
  }
  process.exit(failed);
})().catch((error) => {
  console.log(`FAIL - harness — ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
