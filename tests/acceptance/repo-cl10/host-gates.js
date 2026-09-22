#!/usr/bin/env node
// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const root = path.resolve(__dirname, '../../..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'v1-host-gates-'));
const oldEnv = { ...process.env };
const workspaces = [];
const runDirs = [];
function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return (r.stdout || '').trim();
}
function put(dir, name, value) {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
}
function fixture(name) {
  const base = path.join(temp, name);
  const remote = path.join(base, 'remote.git');
  const target = path.join(base, 'target');
  fs.mkdirSync(base);
  git(base, 'init', '-q', '--bare', '-b', 'main', remote);
  git(base, 'clone', '-q', remote, target);
  git(target, 'config', 'user.email', 'test@example.com');
  git(target, 'config', 'user.name', 'test');
  put(target, 'pipeline.config.json', JSON.stringify({ defaultBranch: 'main',
    verifyCommand: 'true', scopePolicy: 'required', dependencies: {} }));
  put(target, 'src/app.ts', 'original\n');
  put(target, 'docs/decisions.md', 'original\n');
  git(target, 'add', '-A');
  git(target, 'commit', '-qm', 'trusted fork');
  git(target, 'push', '-q', 'origin', 'main');
  return { target, remote };
}
function workspaceFromLog(log) {
  const raw = fs.readFileSync(log.logFile, 'utf8');
  const match = /workspace ready: (.+?) on task\//.exec(raw);
  if (!match) return null;
  const dir = path.resolve(match[1]);
  const prefix = path.join(os.tmpdir(), 'pipeline-repo-cl10-');
  assert.ok(dir.startsWith(prefix), `unexpected workspace path: ${dir}`);
  workspaces.push(dir);
  return dir;
}
async function runCase(name, description, stubBody) {
  const f = fixture(name);
  const runId = `repo-cl10-${name}-${process.pid}`;
  const preload = path.join(temp, `${name}-bd.js`);
  fs.writeFileSync(preload, `const path=require('path');
if(path.basename(process.argv[1]||'')==='show') console.log(JSON.stringify({
 id:'repo-cl10',title:'host gate fixture',description:process.env.V1_TEST_DESCRIPTION,
 acceptance_criteria:'done',design:'design-ref: test'}));
else if(path.basename(process.argv[1]||'')==='memories') console.log('{}');
process.exit(0);\n`);
  const stub = path.join(temp, `${name}-agent.sh`);
  fs.writeFileSync(stub, `#!/bin/sh\nset -e\n${stubBody}\n`);
  process.env.PIPELINE_BD_CMD = process.execPath;
  process.env.NODE_OPTIONS = `${oldEnv.NODE_OPTIONS || ''} --require ${preload}`.trim();
  process.env.V1_TEST_DESCRIPTION = description;
  process.env.PIPELINE_EXEC_STUB = stub;
  process.env.PIPELINE_GH_CMD = 'echo https://example.invalid/pr/1';
  delete process.env.PIPELINE_KEEP_WORKSPACE;
  const { startRun } = require('../../../runner/log');
  const { runOneTask } = require('../../../runner/run');
  const log = startRun(root, runId);
  runDirs.push(log.dir);
  const row = await runOneTask({ targetRepoPath: f.target, targetRepoRemote: f.remote,
    image: 'unused', wallClockMinutes: 2, concurrency: 1 },
    { id: 'repo-cl10', title: 'host gate fixture' }, log, 'unused', { admit: async () => true });
  return { row, log, workspace: workspaceFromLog(log), remote: f.remote };
}
async function main() {
  const failures = [];
  async function check(label, fn) {
    try {
      await fn();
      console.log(`ok - ${label}`);
    } catch (e) {
      failures.push(`${label}: ${e.message}`);
      console.error(`not ok - ${label}: ${e.message}`);
    }
  }
  // Every required-list defect must be refused before the agent stub executes.
  for (const [name, description] of [
    ['missing', '## Constraints\nNo allowed list.\n'],
    ['duplicate', '## Constraints\nAllowed implementation files: src/app.ts.\nAllowed implementation files: src/app.ts.\n'],
    ['malformed', '## Constraints\nAllowed implementation files: src/app.ts, .\n'],
  ]) {
    await check(`${name} required list is blocked before agent work`, async () => {
      const r = await runCase(name, description, 'exit 0');
      const logText = fs.readFileSync(r.log.logFile, 'utf8');
      assert.doesNotMatch(logText, /exec stub exited|container ran/,
        `${name} required list reached agent work`);
      assert.strictEqual(r.row.outcome, 'failed', `${name} list was not blocked`);
      assert.strictEqual(r.row.pushed, false);
      assert.strictEqual(r.row.prUrl, null);
      assert.match(JSON.stringify(r.row), /scope|allowed|list/i);
    });
  }

  const description = '## Constraints\nAllowed implementation files: src/app.ts.\n';
  const stub = 'printf "unauthorized\\n" > docs/decisions.md\n'
    + 'git config user.email test@example.com\n'
    + 'git config user.name test\n'
    + 'git add -A\n'
    + 'git commit -qm "unauthorized docs change"\n'
    + 'mkdir -p "$RUN_DIR"\n'
    + 'printf \'{"issueId":"repo-cl10","timestamp":"2026-09-21T00:00:00Z","acceptance":"pass","regressions":"absent"}\\n\' > "$RUN_DIR/verify.json"';
  await check('blocked branch remains local and report names the real reason', async () => {
    const r = await runCase('blocked', description, stub);
    assert.strictEqual(r.row.outcome, 'failed');
    assert.strictEqual(r.row.pushed, false);
    assert.strictEqual(r.row.prUrl, null);
    assert.ok(r.row.scope && r.row.scope.disallowedPaths.includes('docs/decisions.md'));
    assert.strictEqual(git(r.remote, 'for-each-ref', '--format=%(refname:short)', 'refs/heads'), 'main');
    assert.ok(r.workspace && fs.existsSync(r.workspace),
      'blocked branch and its unauthorized commit were discarded instead of retained locally');
    assert.match(git(r.workspace, 'show', '--format=', '--name-only', 'HEAD'), /docs\/decisions\.md/);
    const { renderReport } = require('../../../runner/report');
    const report = renderReport({ runId: r.log.runId, startedAt: '2026-09-21',
      finishedAt: '2026-09-21', tasks: [r.row] });
    assert.match(report, /docs\/decisions\.md/);
    assert.match(report, /nothing pushed|not pushed/i);
    assert.doesNotMatch(report, /not pushed . no commits/i,
      'report incorrectly says a blocked branch had no commits');
  });
  assert.strictEqual(failures.length, 0, failures.join('\n'));
}
main().finally(() => {
  process.env = oldEnv;
  for (const dir of workspaces) {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  }
  for (const dir of runDirs) {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  }
  fs.rmSync(temp, { recursive: true, force: true });
}).catch((e) => { console.error(e); process.exitCode = 1; });
