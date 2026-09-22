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
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v1-fork-gate-'));
function git(...args) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return (r.stdout || '').trim();
}
function put(name, value) {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
}
try {
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  const frozen = { defaultBranch: 'main', verifyCommand: 'sh tools/test.sh',
    buildCommand: 'sh tools/build.sh', frozenPaths: ['tools/test.sh', 'tools/build.sh'] };
  put('pipeline.config.json', JSON.stringify(frozen));
  put('tools/test.sh', '#!/bin/sh\nexit 0\n');
  put('tools/build.sh', '#!/bin/sh\ntest -f compile.ok\n');
  put('tests/acceptance/repo-cl10/test.sh', '#!/bin/sh\nexit 0\n');
  git('add', '-A');
  git('commit', '-qm', 'trusted fork with required build');
  const trustedFork = git('rev-parse', 'HEAD');
  git('checkout', '-qb', 'task/repo-cl10');

  // The task owns its branch and working config. It commits a weaker config and
  // points defaultBranch at an agent-created ref on that same commit. The trusted
  // integration branch still requires a build, which fails without compile.ok.
  put('pipeline.config.json', JSON.stringify({ ...frozen,
    defaultBranch: 'agent-ref', buildCommand: 'true' }));
  git('add', 'pipeline.config.json');
  git('commit', '-qm', 'try to redirect the verifier fork');
  git('branch', 'agent-ref');
  const r = spawnSync(process.execPath, [path.join(root, 'pipeline/verify.js')], {
    cwd: dir, encoding: 'utf8', env: { ...process.env, WORKSPACE: dir,
      ISSUE_ID: 'repo-cl10', PIPELINE_FORK_POINT: trustedFork },
  });
  const verify = JSON.parse(fs.readFileSync(path.join(dir, '.run/verify.json'), 'utf8'));
  assert.strictEqual(verify.acceptance, 'pass', `fixture acceptance could not run: ${JSON.stringify(verify)}`);
  assert.strictEqual(r.status, 1, `mutable defaultBranch bypassed build: ${JSON.stringify(verify)}`);
  assert.strictEqual(verify.build, 'fail', `trusted build was not run: ${JSON.stringify(verify)}`);
  console.log('ok - agent-created branch cannot redirect the frozen build gate');

  const { buildArgs } = require(path.join(root, 'runner/container.js'));
  const args = buildArgs({ network: 'none', proxyUrl: '', image: 'fixture' }, {
    containerName: 'fixture', workspaceDir: dir, pipelineDir: root,
    issueId: 'repo-cl10', token: '', forkPoint: trustedFork,
  });
  assert.ok(args.includes(`PIPELINE_FORK_POINT=${trustedFork}`),
    'host did not pass the trusted fork SHA into the task container');
  console.log('ok - container receives the host-pinned fork SHA');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
