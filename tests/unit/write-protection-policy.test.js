#!/usr/bin/env node
// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'v1-write-policy-'));
const state = path.join(scratch, 'host-state');
process.env.WRITE_PROTECTION_HOST_STATE_DIR = state;
const policy = require('../../scripts/write-protection-policy');

let checks = 0;
function check(name, actual, expected) {
  assert.deepStrictEqual(actual, expected, name);
  checks += 1;
  console.log(`PASS ${name}`);
}
function runGit(repo, args) {
  const result = spawnSync('git', ['-C', repo, '-c', 'user.email=fixture@example.invalid',
    '-c', 'user.name=Fixture', '-c', 'commit.gpgsign=false', ...args],
  { encoding: 'utf8', timeout: 20000, windowsHide: true });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}
function put(root, relative, body = '') {
  const file = path.join(root, ...relative.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}
function fixture(name, protectedRepo = true) {
  const root = path.join(scratch, name);
  fs.mkdirSync(root);
  runGit(root, ['init', '-q']);
  put(root, 'README.md', 'fixture\n');
  put(root, '.gitignore', '.env\n');
  put(root, 'backend/app/main.py', 'before\n');
  put(root, 'frontend/src/App.tsx', 'before\n');
  put(root, 'plans/061.md', 'plan\n');
  put(root, 'tests/acceptance/tde-oim/test_a1.py', 'before\n');
  put(root, 'tests/acceptance/tde-41a/test_b1.py', 'before\n');
  if (protectedRepo) put(root, 'pipeline.config.json', JSON.stringify({
    frozenPaths: ['tools/run-acceptance.sh', 'frontend/src/setupTests.ts'],
  }));
  runGit(root, ['add', '-A']);
  runGit(root, ['commit', '-qm', 'fixture']);
  return root;
}

const target = fixture('target');
const unprotected = fixture('unprotected', false);
const sessionId = crypto.randomUUID();
let sibling = null;
let lease = null;
try {
  const ctx = policy.contextFor(target);
  check('committed marker protects target', ctx.protected, true);
  check('backend is product', policy.classify('backend/app/main.py', ctx), 'product');
  check('frontend is product', policy.classify('frontend/src/App.tsx', ctx), 'product');
  check('unknown source is product', policy.classify('new-layout/service.py', ctx), 'product');
  check('plan is planning', policy.classify('plans/061.md', ctx), 'planning');
  check('acceptance is frozen', policy.classify('tests/acceptance/tde-oim/test_a1.py', ctx), 'frozen');
  check('target-declared freeze wins', policy.classify('frontend/src/setupTests.ts', ctx), 'frozen');
  check('agent instructions are control', policy.classify('AGENTS.md', ctx), 'control');

  const write = (where, relative, extra = {}) => policy.decide({
    action: 'write', cwd: where, path: relative, ...extra,
  });
  check('planning write is available without lease', write(target, 'plans/062.md').decision, 'allow');
  check('backend write denied without lease', write(target, 'backend/app/main.py').reason, 'pipeline-first');
  check('frontend write denied without lease', write(target, 'frontend/src/App.tsx').decision, 'deny');
  check('unknown source denied without lease', write(target, 'new-layout/service.py').decision, 'deny');
  check('dot-dot-prefixed filename denied without lease', write(target, '..secret').decision, 'deny');
  check('ignored .env still denied', write(target, '.env').decision, 'deny');
  check('acceptance write denied without lease', write(target, 'tests/acceptance/tde-oim/test_a2.py').decision, 'deny');
  check('malformed protected write denied', write(target, '').reason, 'unknown-write-form');
  check('checkout root path denied', write(target, '.').decision, 'deny');
  check('repo without marker remains unprotected', write(unprotected, 'backend/app/main.py').decision, 'allow');
  process.env.WRITE_PROTECTION_HOST_STATE_DIR = path.join(unprotected, 'lease-state');
  check('host lease state cannot be inside any checkout', (() => {
    try { policy.hostStateDir(); return false; }
    catch (error) { return /outside every Git checkout/.test(error.message); }
  })(), true);
  process.env.WRITE_PROTECTION_HOST_STATE_DIR = state;
  try {
    fs.symlinkSync(path.join(target, 'backend', 'app'),
      path.join(target, 'plans', 'backend-alias'), 'junction');
    check('directory symlink into product denied', write(target,
      'plans/backend-alias/new.py').decision, 'deny');
  } catch (error) {
    if (error.code !== 'EPERM' && error.code !== 'EACCES') throw error;
    console.log('SKIP symlink escape fixture: host does not permit creating junctions');
  }

  lease = policy.createLease({ target, role: 'test-author', issueId: 'tde-oim',
    sessionId, controllerPid: process.pid, minutes: 2 });
  check('lease state outside target', policy.within(target, lease.file), false);
  check('lease record exists', fs.existsSync(lease.file), true);
  const authority = { token: lease.token, sessionId };
  check('own issue suite is writable', write(target, 'tests/acceptance/tde-oim/test_a2.py', authority).decision, 'allow');
  check('sibling suite denied with lease', write(target, 'tests/acceptance/tde-41a/test_b1.py', authority).reason, 'role-path');
  check('backend denied with lease', write(target, 'backend/app/main.py', authority).reason, 'role-path');
  check('frontend denied with lease', write(target, 'frontend/src/App.tsx', authority).reason, 'role-path');
  check('plans denied with test-author lease', write(target, 'plans/061.md', authority).reason, 'role-path');
  check('unprotected checkout denied with test-author lease', write(unprotected,
    'backend/app/main.py', authority).reason, 'role-path');
  check('outside scratch path denied with test-author lease', write(target,
    path.join(scratch, 'outside.txt'), authority).reason, 'role-path');
  check('wrong session denied', write(target, 'tests/acceptance/tde-oim/x.py',
    { token: lease.token, sessionId: crypto.randomUUID() }).reason, 'lease-invalid');
  check('wrong token denied', write(target, 'tests/acceptance/tde-oim/x.py',
    { token: crypto.randomBytes(24).toString('hex'), sessionId }).reason, 'lease-invalid');
  check('test-author read-only shell denied', policy.decide({
    action: 'shell', cwd: target, command: 'git status', ...authority,
  }).reason, 'test-author-shell');
  check('test-author interpreter denied', policy.decide({
    action: 'shell', cwd: target, command: 'node -e "process.exit(0)"', ...authority,
  }).reason, 'test-author-shell');
  check('test-author unknown shell denied', policy.decide({
    action: 'shell', cwd: target, command: 'opaque-command', ...authority,
  }).reason, 'test-author-shell');
  check('unknown shell denied without lease', policy.decide({
    action: 'shell', cwd: target, command: 'opaque-command',
  }).reason, 'unknown-shell-form');
  check('read-only shell remains available', policy.decide({
    action: 'shell', cwd: target, command: 'git status --short',
  }).decision, 'allow');
  check('variable-expanded shell denied', policy.decide({
    action: 'shell', cwd: target, command: 'tee $TARGET',
  }).reason, 'unknown-shell-form');
  check('shell redirect to plan denied', policy.decide({
    action: 'shell', cwd: target, command: 'echo text > plans/new.md',
  }).decision, 'deny');
  check('shell delete checkout root denied', policy.decide({
    action: 'shell', cwd: target, command: 'rm -rf .',
  }).decision, 'deny');
  check('shell delete target from parent denied', policy.decide({
    action: 'shell', cwd: path.dirname(target), command: `rm -rf ${path.basename(target)}`,
  }).decision, 'deny');
  check('find delete denied', policy.decide({
    action: 'shell', cwd: target, command: 'find . -delete',
  }).decision, 'deny');
  check('sort output file denied', policy.decide({
    action: 'shell', cwd: target, command: 'sort -o backend/app/main.py README.md',
  }).decision, 'deny');
  check('ripgrep preprocessor denied', policy.decide({
    action: 'shell', cwd: target, command: 'rg --pre node pattern backend',
  }).decision, 'deny');
  check('git output file denied', policy.decide({
    action: 'shell', cwd: target, command: 'git diff --output=plans/new.md',
  }).decision, 'deny');
  check('unreadable patch denied', policy.decide({
    action: 'patch', cwd: target, patch: 'not a patch',
  }).reason, 'unknown-patch-form');
  check('unified diff rename origin denied', policy.decide({
    action: 'patch', cwd: target,
    patch: '--- a/backend/app/main.py\n+++ b/plans/moved.md\n@@ -1 +1 @@\n-before\n+after\n',
  }).decision, 'deny');
  check('git rename-from origin denied', policy.decide({
    action: 'patch', cwd: target,
    patch: 'diff --git a/backend/app/main.py b/plans/moved.md\nrename from backend/app/main.py\nrename to plans/moved.md\n',
  }).decision, 'deny');

  const altered = JSON.parse(fs.readFileSync(lease.file, 'utf8'));
  fs.writeFileSync(lease.file, JSON.stringify({ ...altered, expiresAt: '2000-01-01T00:00:00.000Z' }));
  check('expired lease denied', write(target, 'tests/acceptance/tde-oim/x.py', authority).reason, 'lease-invalid');
  fs.writeFileSync(lease.file, JSON.stringify({ ...altered, controllerStart: 'windows:0' }));
  check('wrong controller start denied', write(target, 'tests/acceptance/tde-oim/x.py', authority).reason, 'lease-invalid');
  fs.writeFileSync(lease.file, JSON.stringify({ ...altered, gitCommonDir: scratch }));
  check('wrong Git common directory denied', write(target,
    'tests/acceptance/tde-oim/x.py', authority).reason, 'lease-invalid');
  fs.writeFileSync(lease.file, JSON.stringify({ ...altered, version: 1 }));
  check('old lease format denied', write(target,
    'tests/acceptance/tde-oim/x.py', authority).reason, 'lease-invalid');
  fs.writeFileSync(lease.file, JSON.stringify(altered));

  sibling = path.join(scratch, 'sibling-worktree');
  runGit(target, ['worktree', 'add', '-q', '-b', 'sibling', sibling]);
  check('sibling shares Git common dir', policy.contextFor(sibling).commonDir, ctx.commonDir);
  check('sibling worktree write denied', write(sibling,
    'tests/acceptance/tde-oim/x.py', authority).reason, 'role-path');

  // The independent admission backstop judges actual Git changes, not a claimed hook state.
  put(target, 'plans/new.md', 'planning\n');
  put(target, 'tests/acceptance/tde-oim/test_a2.py', 'new test\n');
  put(target, 'backend/app/main.py', 'modified\n');
  put(target, 'new-layout/service.py', 'unknown source\n');
  put(target, '..secret', 'unknown source\n');
  const admission = policy.admit(target, { issues: ['tde-oim'] });
  check('admission refuses dirty product', admission.admit, false);
  check('admission names backend', admission.refusals.some((r) => r.path === 'backend/app/main.py'), true);
  check('admission names unknown source', admission.refusals.some((r) => r.path === 'new-layout/service.py'), true);
  check('admission names dot-dot-prefixed file', admission.refusals.some((r) => r.path === '..secret'), true);
  check('admission allows current issue suite', admission.refusals.some((r) => r.path.includes('tde-oim')), false);
  check('admission allows planning draft', admission.refusals.some((r) => r.path === 'plans/new.md'), false);

  const renamed = fixture('renamed-target');
  runGit(renamed, ['mv', 'backend/app/main.py', 'plans/moved-source.md']);
  const renamedAdmission = policy.admit(renamed);
  check('staged rename from product is refused', renamedAdmission.admit, false);
  check('rename refusal names product origin', renamedAdmission.refusals.some(
    (r) => r.path === 'backend/app/main.py'), true);

  check('lease revoked', policy.revokeLease(lease.leaseId), true);
  lease = null;
  check('revoked lease denied', write(target, 'tests/acceptance/tde-oim/x.py', authority).reason, 'lease-invalid');
} finally {
  if (lease) policy.revokeLease(lease.leaseId);
  if (sibling) {
    try { runGit(target, ['worktree', 'remove', '--force', sibling]); } catch { /* scratch cleanup follows */ }
  }
  fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
console.log(`PASS ${checks} write-protection policy checks`);
