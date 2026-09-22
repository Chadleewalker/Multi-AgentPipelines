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
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'v1-final-verify-'));
const dir = path.join(temp, 'target');
function put(file, value) {
  const p = path.join(dir, file);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, value);
}
function git(...args) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
}
function shellPath(p) {
  const r = spawnSync('cygpath', ['-u', p], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : p.replace(/\\/g, '/');
}
try {
  fs.mkdirSync(dir);
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  put('pipeline.config.json', JSON.stringify({ defaultBranch: 'main',
    verifyCommand: 'sh tools/test.sh', buildCommand: 'sh tools/build.sh',
    frozenPaths: ['tools/test.sh', 'tools/build.sh'], dependencies: {} }));
  put('tools/test.sh', '#!/bin/sh\nexit 0\n');
  put('tools/build.sh', '#!/bin/sh\ntest -f compile.ok\n');
  put('tests/acceptance/repo-cl9/test.sh', '#!/bin/sh\nexit 0\n');
  put('compile.ok', 'initial build passes\n');
  git('add', '-A');
  git('commit', '-qm', 'frozen baseline');
  git('checkout', '-qb', 'task/repo-cl9');
  const agent = path.join(temp, 'agent.sh');
  fs.writeFileSync(agent, '#!/bin/sh\nprompt=$(cat)\ncase "$prompt" in\n  *"Verification for task"*) rm -f compile.ok; echo "Docs phase changed a build input." ;;\n  *) echo "Implementation complete." ;;\nesac\n');
  put('.run/issue.md', '# repo-cl9\n\n## Constraints\nAllowed implementation files: compile.ok.\n');
  const home = path.join(temp, 'home');
  fs.mkdirSync(home);
  const r = spawnSync('sh', [shellPath(path.join(root, 'pipeline/entrypoint.sh'))], {
    cwd: dir, encoding: 'utf8', env: { ...process.env,
      HOME: shellPath(home), WORKSPACE: shellPath(dir), PIPELINE_DIR: shellPath(path.join(root, 'pipeline')),
      PIPELINE_AGENT_CMD: `sh ${shellPath(agent)}`, ISSUE_ID: 'repo-cl9', PIPELINE_MAX_ATTEMPTS: '1',
    },
  });
  assert.notStrictEqual(r.status, 0, `docs-phase build break returned success:\n${r.stdout}\n${r.stderr}`);
  const verify = JSON.parse(fs.readFileSync(path.join(dir, '.run/verify.json'), 'utf8'));
  assert.strictEqual(verify.build, 'fail', `final verifier did not see build failure: ${JSON.stringify(verify)}`);
  console.log('ok - docs-phase build break cannot inherit an earlier verifier pass');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
