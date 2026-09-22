#!/usr/bin/env node
// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const ROOT = path.resolve(__dirname, '../../..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'v1-gates-'));
let checks = 0;
const run = (cmd, args, cwd, env = {}) => spawnSync(cmd, args,
  { cwd, encoding: 'utf8', env: { ...process.env, ...env } });
function git(dir, ...args) {
  const r = run('git', args, dir);
  assert.strictEqual(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return (r.stdout || '').trim();
}
function put(dir, name, content) {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
function repo(name, config) {
  const dir = path.join(temp, name);
  fs.mkdirSync(dir);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'test');
  put(dir, 'pipeline.config.json', JSON.stringify(config));
  put(dir, 'tools/test.sh', '#!/bin/sh\nexit 0\n');
  put(dir, 'tools/build.sh', '#!/bin/sh\ntest -f compile.ok\n');
  put(dir, 'tests/acceptance/repo-cl9/test.sh', '#!/bin/sh\nexit 0\n');
  put(dir, 'src/app.ts', 'export const x = 1;\n');
  put(dir, 'docs/decisions.md', 'original\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'frozen baseline');
  const forkPoint = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'checkout', '-qb', 'task/repo-cl9');
  return { dir, forkPoint };
}
function check(name, fn) { fn(); checks++; console.log(`ok - ${name}`); }
try {
  const config = { defaultBranch: 'main', verifyCommand: 'sh tools/test.sh',
    buildCommand: 'sh tools/build.sh', frozenPaths: ['tools/test.sh', 'tools/build.sh'],
    dependencies: {} };
  const v = repo('verify', config);
  function verify() {
    const r = run(process.execPath, [path.join(ROOT, 'pipeline/verify.js')], v.dir,
      { WORKSPACE: v.dir, ISSUE_ID: 'repo-cl9' });
    return { rc: r.status, value: JSON.parse(fs.readFileSync(path.join(v.dir, '.run/verify.json'), 'utf8')) };
  }
  check('passing acceptance cannot mask a failing build', () => {
    const r = verify();
    assert.strictEqual(r.rc, 1);
    assert.strictEqual(r.value.build, 'fail');
  });
  check('passing build permits success', () => {
    put(v.dir, 'compile.ok', 'ok\n');
    const r = verify();
    assert.strictEqual(r.rc, 0);
    assert.strictEqual(r.value.build, 'pass');
  });
  check('worktree config cannot bypass the frozen build command', () => {
    fs.rmSync(path.join(v.dir, 'compile.ok'));
    put(v.dir, 'pipeline.config.json', JSON.stringify({ ...config, buildCommand: 'true' }));
    assert.strictEqual(verify().rc, 1);
    git(v.dir, 'checkout', '-q', '--', 'pipeline.config.json');
  });
  check('modifying a frozen build helper is tampering', () => {
    put(v.dir, 'tools/build.sh', '#!/bin/sh\nexit 0\n');
    assert.strictEqual(verify().rc, 3);
  });

  const s = repo('scope', { ...config, scopePolicy: 'required' });
  const { checkScope } = require(path.join(ROOT, 'runner/scope.js'));
  const issue = { description: '## Constraints\nAllowed implementation files: src/app.ts, PROJECT_STATE.md.\n' };
  const scope = (description = issue.description, policy = 'required') =>
    checkScope({ dir: s.dir, forkPoint: s.forkPoint, issue: { description }, policy });
  check('allowed source change passes final scope check', () => {
    put(s.dir, 'src/app.ts', 'export const x = 2;\n');
    assert.strictEqual(scope().ok, true);
  });
  check('out-of-scope docs change is named and rejected', () => {
    put(s.dir, 'docs/decisions.md', 'unauthorized\n');
    const r = scope();
    assert.strictEqual(r.ok, false);
    assert.ok(r.disallowedPaths.includes('docs/decisions.md'));
    git(s.dir, 'checkout', '-q', '--', 'docs/decisions.md');
  });
  check('untracked file and rename destination are rejected', () => {
    put(s.dir, 'leak.txt', 'untracked\n');
    assert.ok(scope().disallowedPaths.includes('leak.txt'));
    fs.rmSync(path.join(s.dir, 'leak.txt'));
    git(s.dir, 'mv', 'src/app.ts', 'src/renamed.ts');
    assert.ok(scope().disallowedPaths.includes('src/renamed.ts'));
  });
  check('required scope fails closed on missing or unsafe allowlists', () => {
    assert.strictEqual(scope('## Constraints\nNo file list.').ok, false);
    assert.strictEqual(scope('## Constraints\nAllowed implementation files: ../escape.txt.').ok, false);
  });
  check('legacy target may omit an allowlist when policy is optional', () => {
    assert.strictEqual(scope('## Constraints\nNo file list.', 'optional').ok, true);
  });
  console.log(`PASS ${checks} V1 gate assertions`);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
