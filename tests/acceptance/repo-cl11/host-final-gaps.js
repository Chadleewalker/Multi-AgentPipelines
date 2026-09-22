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
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'v1-final-gaps-'));
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

function fixture(name, configKind) {
  const base = path.join(temp, name);
  const remote = path.join(base, 'remote.git');
  const target = path.join(base, 'target');
  const emptyHooks = path.join(base, 'empty-hooks');
  fs.mkdirSync(base);
  fs.mkdirSync(emptyHooks);
  git(base, 'init', '-q', '--bare', '-b', 'main', remote);
  git(base, 'clone', '-q', remote, target);
  git(target, 'config', 'user.email', 'test@example.com');
  git(target, 'config', 'user.name', 'test');
  git(target, 'config', 'core.hooksPath', emptyHooks);
  if (configKind === 'valid') {
    put(target, 'pipeline.config.json', JSON.stringify({ defaultBranch: 'main',
      verifyCommand: 'true', scopePolicy: 'required', dependencies: {} }));
  } else if (configKind === 'malformed') {
    put(target, 'pipeline.config.json', '{ "scopePolicy": "required",\n');
  }
  put(target, 'src/app.ts', 'original\n');
  put(target, 'docs/decisions.md', 'original\n');
  git(target, 'add', '-A');
  git(target, 'commit', '-qm', 'trusted fork');
  git(target, 'push', '-q', 'origin', 'main');
  return { remote, target };
}

function workspaceFromLog(log) {
  const raw = fs.readFileSync(log.logFile, 'utf8');
  const match = /workspace ready: (.+?) on task\//.exec(raw);
  assert.ok(match, `workspace not recorded in ${log.logFile}`);
  const dir = path.resolve(match[1]);
  const prefix = path.join(os.tmpdir(), 'pipeline-repo-cl11-');
  assert.ok(dir.startsWith(prefix), `unexpected workspace path: ${dir}`);
  workspaces.push(dir);
  return dir;
}

async function runCase(name, configKind, description, stubBody) {
  const f = fixture(name, configKind);
  const runId = `repo-cl11-${name}-${process.pid}`;
  const preload = path.join(temp, `${name}-bd.js`);
  fs.writeFileSync(preload, `const path=require('path');
if(path.basename(process.argv[1]||'')==='show') console.log(JSON.stringify({
 id:'repo-cl11',title:'final gate fixture',description:process.env.V1_TEST_DESCRIPTION,
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
  { id: 'repo-cl11', title: 'final gate fixture' }, log, 'unused', { admit: async () => true });
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

  const description = '## Constraints\nAllowed implementation files: src/app.ts.\n';
  // A valid list deliberately removes list admission as a possible explanation. The
  // fork-point config itself must be readable and valid before an agent may start.
  for (const configKind of ['malformed', 'missing']) {
    await check(`${configKind} fork-point config blocks before agent work`, async () => {
      const marker = path.join(temp, `${configKind}-agent-ran`);
      const markerForShell = marker.replace(/\\/g, '/');
      const r = await runCase(configKind, configKind, description,
        `printf launched > "${markerForShell}"`);
      assert.strictEqual(fs.existsSync(marker), false, 'agent ran despite unreadable fork config');
      assert.strictEqual(r.row.outcome, 'failed', JSON.stringify(r.row));
      assert.strictEqual(r.row.pushed, false);
      assert.strictEqual(r.row.prUrl, null);
      assert.match(JSON.stringify(r.row), /fork|pipeline\.config|config/i,
        'the block was not attributed to the fork-point config');
      assert.strictEqual(git(r.remote, 'for-each-ref', '--format=%(refname:short)',
        'refs/heads'), 'main');
    });
  }

  await check('zero-commit uncommitted out-of-scope change is blocked and retained', async () => {
    const stub = 'printf "unauthorized\\n" > docs/decisions.md\n'
      + 'mkdir -p "$RUN_DIR"\n'
      + 'printf \'{"issueId":"repo-cl11","timestamp":"2026-09-21T00:00:00Z","acceptance":"pass","regressions":"absent"}\\n\' > "$RUN_DIR/verify.json"';
    const r = await runCase('uncommitted', 'valid', description, stub);
    assert.strictEqual(r.row.outcome, 'failed', JSON.stringify(r.row));
    assert.strictEqual(r.row.pushed, false);
    assert.strictEqual(r.row.prUrl, null);
    assert.ok(r.row.scope && r.row.scope.disallowedPaths.includes('docs/decisions.md'),
      `out-of-scope path missing from result: ${JSON.stringify(r.row)}`);
    assert.strictEqual(git(r.remote, 'for-each-ref', '--format=%(refname:short)',
      'refs/heads'), 'main');
    assert.ok(fs.existsSync(r.workspace), 'blocked uncommitted workspace was discarded');
    assert.strictEqual(git(r.workspace, 'rev-list', '--count', 'origin/main..HEAD'), '0',
      'fixture unexpectedly created a commit');
    assert.match(git(r.workspace, 'status', '--porcelain'), /docs\/decisions\.md/);
  });
  assert.strictEqual(failures.length, 0, failures.join('\n'));
}

main().finally(() => {
  process.env = oldEnv;
  for (const dir of workspaces) {
    const prefix = path.join(os.tmpdir(), 'pipeline-repo-cl11-');
    if (path.resolve(dir).startsWith(prefix) && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  for (const dir of runDirs) {
    const runsRoot = path.join(root, 'runs') + path.sep;
    if (path.resolve(dir).startsWith(runsRoot) && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  const tempRoot = path.resolve(os.tmpdir()) + path.sep;
  if (path.resolve(temp).startsWith(tempRoot)) fs.rmSync(temp, { recursive: true, force: true });
}).catch((e) => { console.error(e); process.exitCode = 1; });
