// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { prepare, discard } = require('../../runner/workspace');
const { startRun } = require('../../runner/log');
const { runOneTask } = require('../../runner/run');

const root = path.resolve(__dirname, '../..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'v1-cleanup-test-'));
const runNonce = path.basename(temp);
const runDirs = [];
const oldEnv = { ...process.env };
const issueId = `cleanup-${process.pid}`;
const bashSystem = spawnSync('bash', ['-lc', 'uname -s'], { encoding: 'utf8' });

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.strictEqual(result.status, 0, `git ${args.join(' ')}: ${result.stderr || result.error}`);
  return (result.stdout || '').trim();
}

function workspaces() {
  return fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith(`pipeline-${issueId}-`)).sort();
}
const initialWorkspaces = new Set(workspaces());

function workspaceFromLog(log) {
  const raw = fs.readFileSync(log.logFile, 'utf8');
  const match = /workspace ready: (.+?) on task\//.exec(raw);
  assert.ok(match, 'workspace path missing from run log');
  const dir = path.resolve(match[1]);
  assert.strictEqual(path.dirname(dir), path.resolve(os.tmpdir()));
  assert.ok(path.basename(dir).startsWith(`pipeline-${issueId}-`));
  return dir;
}

async function task(name, stubBody, gate, keep = false, guardDeps = {}) {
  const stub = path.join(temp, `${name}.sh`);
  fs.writeFileSync(stub, `#!/bin/sh\n${stubBody}\n`);
  const windowsTail = stub.slice(2).replace(/\\/g, '/');
  process.env.PIPELINE_EXEC_STUB = process.platform === 'win32'
    ? `${bashSystem.stdout.trim() === 'Linux' ? '/mnt' : ''}/${stub[0].toLowerCase()}${windowsTail}`
    : stub;
  if (keep) process.env.PIPELINE_KEEP_WORKSPACE = '1';
  else delete process.env.PIPELINE_KEEP_WORKSPACE;
  const log = startRun(root, `cleanup-${name}-${runNonce}`);
  runDirs.push(log.dir);
  const promise = runOneTask({ targetRepoPath: target, targetRepoRemote: remote,
    image: 'unused', wallClockMinutes: 2, concurrency: 1 },
  { id: issueId, title: 'cleanup fixture' }, log, 'unused', gate, {
    guardInstallation: () => ({ ok: true }), guardAdmission: () => ({ ok: true }), ...guardDeps,
  });
  return { promise, log };
}

const remote = path.join(temp, 'remote.git');
const target = path.join(temp, 'target');

async function main() {
  const before = workspaces();
  const failed = prepare({ targetRepoRemote: path.join(temp, 'missing.git') }, issueId,
    'fixture', { info() {}, error(message) { throw new Error(message); } }, 'prep');
  assert.strictEqual(failed.ok, false);
  assert.deepStrictEqual(workspaces(), before, 'failed clone left a temp directory');
  console.log('ok - failed preparation removes its temp directory');

  git(temp, 'init', '-q', '--bare', '-b', 'main', remote);
  git(temp, 'clone', '-q', remote, target);
  git(target, 'config', 'user.name', 'Cleanup Test');
  git(target, 'config', 'user.email', 'cleanup@example.com');
  fs.writeFileSync(path.join(target, 'pipeline.config.json'),
    JSON.stringify({ defaultBranch: 'main', verifyCommand: 'true', dependencies: {} }));
  git(target, 'add', '.');
  git(target, 'commit', '-qm', 'baseline');
  git(target, 'push', '-q', 'origin', 'main');

  const preload = path.join(temp, 'bd.js');
  fs.writeFileSync(preload, `const path=require('path');
if(path.basename(process.argv[1]||'')==='show') console.log(JSON.stringify({
 id:process.env.V1_CLEANUP_ISSUE,title:'cleanup fixture',description:'fixture',
 acceptance_criteria:'done',design:'design-ref: test'}));
else if(path.basename(process.argv[1]||'')==='memories') console.log('{}');
process.exit(0);\n`);
  process.env.PIPELINE_BD_CMD = process.execPath;
  process.env.NODE_OPTIONS = `${oldEnv.NODE_OPTIONS || ''} --require "${preload.replace(/\\/g, '/')}"`.trim();
  process.env.V1_CLEANUP_ISSUE = issueId;

  const beforeRefusal = workspaces();
  const installationBlock = await task('installation-block', 'exit 0', { admit: async () => true }, false, {
    guardInstallation: () => ({ ok: false, stage: 'installation', reason: 'stale guard fixture' }),
  });
  const installationRow = await installationBlock.promise;
  assert.match(installationRow.error, /stale guard fixture/);
  assert.deepStrictEqual(workspaces(), beforeRefusal, 'installation refusal prepared a workspace');
  console.log('ok - stale installation refuses before preparation');

  // Dirt in the primary checkout must not be the target of task admission.
  fs.writeFileSync(path.join(target, 'user-owned.txt'), 'preserve me');
  const dispatchBlock = await task('dispatch-block', 'touch "$TASK_DIR/agent-ran"\nexit 0',
    { admit: async () => true }, false, {
      guardAdmission: (dir) => {
        assert.notStrictEqual(path.resolve(dir), path.resolve(target));
        assert.strictEqual(git(dir, 'status', '--porcelain'), '');
        return { ok: false, stage: 'target', reason: 'incomplete target protection fixture' };
      },
    });
  const dispatchRow = await dispatchBlock.promise;
  assert.strictEqual(dispatchRow.attempts, 0);
  assert.match(dispatchRow.error, /incomplete target protection fixture/);
  assert.strictEqual(fs.existsSync(path.join(dispatchBlock.log.taskDir(issueId), 'agent-ran')), false);
  assert.strictEqual(fs.readFileSync(path.join(target, 'user-owned.txt'), 'utf8'), 'preserve me');
  console.log('ok - dispatch admission checks the clean clone and refuses before agent execution');

  let resumeHealthCalls = 0;
  const resumeBlock = await task('resume-block', 'exit 20', {
    admit: async () => true, reportLimit: async () => ({ resumed: true }),
  }, false, {
    guardInstallation: () => (++resumeHealthCalls === 1 ? { ok: true }
      : { ok: false, stage: 'installation', reason: 'guard lost while paused' }),
  });
  const resumeRow = await resumeBlock.promise;
  assert.match(resumeRow.error, /guard lost while paused/);
  const resumeLog = fs.readFileSync(resumeBlock.log.logFile, 'utf8');
  assert.strictEqual((resumeLog.match(/exec stub exited 20/g) || []).length, 1,
    'the guard block must prevent a second dispatch');
  assert.doesNotMatch(resumeLog, /relaunching in a fresh container/);
  assert.strictEqual(resumeHealthCalls, 2);
  console.log('ok - stale installation after a pause prevents relaunch');

  let admissionCalls = 0;
  const publicationBlock = await task('publication-block',
    'git config user.name "Cleanup Test"\n'
    + 'git config user.email "cleanup@example.com"\n'
    + 'printf committed > finished.txt\n'
    + 'git add finished.txt && git commit -qm "task work"\nexit 30',
    { admit: async () => true }, false, {
      guardInstallation: () => (++admissionCalls === 1 ? { ok: true }
        : { ok: false, stage: 'installation', reason: 'installation changed during task' }),
    });
  const publicationRow = await publicationBlock.promise;
  assert.strictEqual(admissionCalls, 2);
  assert.strictEqual(publicationRow.pushed, false);
  assert.match(publicationRow.error, /installation changed during task/);
  assert.strictEqual(git(remote, 'for-each-ref', `refs/heads/task/${issueId}`), '');
  const blockedDir = workspaceFromLog(publicationBlock.log);
  assert.strictEqual(fs.existsSync(path.join(blockedDir, 'finished.txt')), true);
  assert.strictEqual(discard(blockedDir).ok, true);
  console.log('ok - changed guard refuses publication and retains committed evidence');

  const normal = await task('normal', 'exit 30', { admit: async () => true });
  const normalRow = await normal.promise;
  assert.strictEqual(normalRow.outcome, 'failed');
  assert.strictEqual(fs.existsSync(workspaceFromLog(normal.log)), false);
  console.log('ok - completed task removes its clone');

  const interrupted = await task('throw', 'exit 20', {
    admit: async () => true,
    reportLimit: async () => { throw new Error('synthetic gate failure'); },
  });
  await assert.rejects(interrupted.promise, /synthetic gate failure/);
  assert.strictEqual(fs.existsSync(workspaceFromLog(interrupted.log)), false);
  console.log('ok - thrown task removes its clone');

  const uncommitted = await task('uncommitted', 'printf changed > unfinished.txt\nexit 30',
    { admit: async () => true });
  await uncommitted.promise;
  const uncommittedDir = workspaceFromLog(uncommitted.log);
  assert.strictEqual(fs.existsSync(path.join(uncommittedDir, 'unfinished.txt')), true);
  assert.match(fs.readFileSync(uncommitted.log.logFile, 'utf8'), /uncommitted changes — retained for recovery/);
  assert.strictEqual(discard(uncommittedDir).ok, true);
  console.log('ok - uncommitted task work is retained for recovery');

  const pushFailure = await task('push-failure',
    'git config user.name "Cleanup Test"\n'
    + 'git config user.email "cleanup@example.com"\n'
    + 'printf committed > finished.txt\n'
    + 'git add finished.txt && git commit -qm "task work"\n'
    + 'git remote set-url origin /missing/push.git\n'
    + 'exit 30', { admit: async () => true });
  const pushRow = await pushFailure.promise;
  assert.strictEqual(pushRow.pushed, false);
  const pushDir = workspaceFromLog(pushFailure.log);
  assert.strictEqual(git(pushDir, 'rev-list', '--count', `${git(pushDir, 'merge-base', 'origin/main', 'HEAD')}..HEAD`), '1');
  assert.match(fs.readFileSync(pushFailure.log.logFile, 'utf8'), /unpushed commits — retained for recovery/);
  assert.strictEqual(discard(pushDir).ok, true);
  console.log('ok - failed push retains the only committed copy');

  const retained = await task('keep', 'exit 30', { admit: async () => true }, true);
  await retained.promise;
  const keptDir = workspaceFromLog(retained.log);
  assert.strictEqual(fs.existsSync(keptDir), true);
  assert.strictEqual(discard(keptDir).ok, true);
  console.log('ok - explicit keep retains its clone');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  for (const dir of runDirs) fs.rmSync(dir, { recursive: true, force: true });
  for (const name of workspaces()) {
    if (initialWorkspaces.has(name)) continue;
    const dir = path.join(os.tmpdir(), name);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  fs.rmSync(temp, { recursive: true, force: true });
  process.env = oldEnv;
});
