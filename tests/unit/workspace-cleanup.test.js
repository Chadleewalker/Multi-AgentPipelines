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

async function task(name, stubBody, gate, keep = false) {
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
  { id: issueId, title: 'cleanup fixture' }, log, 'unused', gate);
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
