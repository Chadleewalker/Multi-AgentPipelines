#!/usr/bin/env node
// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { author, parseArgs } = require('../../scripts/author-acceptance');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`PASS  ${name}`); }
  catch (error) { failures += 1; console.log(`FAIL  ${name}: ${error.stack || error}`); }
}
function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.strictEqual(result.status, 0, result.stderr);
}
function removeUnder(parent, child) {
  const root = fs.realpathSync(parent);
  const full = fs.realpathSync(child);
  const relative = path.relative(root, full);
  assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'unsafe recursive test cleanup');
  fs.rmSync(full, { recursive: true, force: true });
}
function removeScratch(dir) {
  const full = fs.realpathSync(dir);
  assert.equal(path.dirname(full), fs.realpathSync(os.tmpdir()), 'scratch path outside temp');
  assert(path.basename(full).startsWith('author-acceptance-'), 'unexpected scratch name');
  fs.rmSync(full, { recursive: true, force: true });
}

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'author-acceptance-'));
const target = path.join(temp, 'target');
fs.mkdirSync(target);
git(target, 'init');
fs.writeFileSync(path.join(target, 'pipeline.config.json'), '{}\n');
fs.writeFileSync(path.join(target, '.gitignore'), '.env\n');
git(target, 'add', 'pipeline.config.json', '.gitignore');
git(target, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'initial');
const prompt = path.join(temp, 'brief.txt');
fs.writeFileSync(prompt, 'A1: prove the new auth table exists.\n');
const config = path.join(temp, 'run.config.test.json');
fs.writeFileSync(config, JSON.stringify({
  targetRepoPath: target, targetRepoRemote: 'https://example.invalid/test.git', image: 'test:local',
  model: 'claude-opus-4-8', wallClockMinutes: 1,
}));
const options = { issue: 'tde-oim', config, worktree: target, 'prompt-file': prompt };

function fakePolicy() {
  const state = { grants: [], revokes: [] };
  return {
    state,
    createLease(input) {
      state.grants.push(input);
      return { leaseId: 'lease-1', token: 'secret-test-token' };
    },
    revokeLease(id) { state.revokes.push(id); },
  };
}
function fakeSpawn(writePath, output = { type: 'result', subtype: 'success', is_error: false, result: 'done' }) {
  return (command, args, opts) => {
    if (command !== 'claude') return spawnSync(command, args, opts);
    assert(args.includes('--model') && args.includes('claude-opus-4-8'));
    assert(!args.join(' ').includes('Bash('));
    assert.strictEqual(opts.env.PIPELINE_WRITE_LEASE_TOKEN, 'secret-test-token');
    assert.strictEqual(opts.env.PIPELINE_WRITE_SESSION_ID, args[args.indexOf('--session-id') + 1]);
    if (writePath) {
      fs.mkdirSync(path.dirname(writePath), { recursive: true });
      fs.writeFileSync(writePath, 'assert False\n');
    }
    return { status: 0, stdout: JSON.stringify(output), stderr: '' };
  };
}

check('CLI requires a prompt file and one issue id', () => {
  assert.throws(() => parseArgs(['tde-oim', '--config', 'x', '--worktree', 'y']), /prompt-file/);
  assert.throws(() => parseArgs(['../outside', '--config', 'x', '--worktree', 'y', '--prompt-file', 'z']), /issue id/);
});

check('successful author gets one scoped lease and releases it', () => {
  const guard = fakePolicy();
  const file = path.join(target, 'tests', 'acceptance', 'tde-oim', 'test_a1.py');
  const result = author(options, { policy: guard, spawn: fakeSpawn(file), doctor: () => ({ ok: true }) });
  assert.strictEqual(result.issue, 'tde-oim');
  assert.deepStrictEqual(result.paths, ['tests/acceptance/tde-oim/test_a1.py']);
  assert.strictEqual(guard.state.grants[0].issueId, 'tde-oim');
  assert.strictEqual(guard.state.grants[0].role, 'test-author');
  assert.strictEqual(guard.state.grants[0].controllerPid, process.pid);
  assert.deepStrictEqual(guard.state.revokes, ['lease-1']);
  removeUnder(target, path.join(target, 'tests'));
});

check('doctor failure prevents a lease and agent launch', () => {
  const guard = fakePolicy();
  assert.throws(() => author(options, { policy: guard, spawn: fakeSpawn(null), doctor: () => ({ ok: false, reason: 'missing hook' }) }), /doctor failed/);
  assert.strictEqual(guard.state.grants.length, 0);
});

check('a dirty sibling suite prevents lease creation', () => {
  const sibling = path.join(target, 'tests', 'acceptance', 'other', 'test.py');
  fs.mkdirSync(path.dirname(sibling), { recursive: true });
  fs.writeFileSync(sibling, 'assert True\n');
  const guard = fakePolicy();
  assert.throws(() => author(options, { policy: guard, spawn: fakeSpawn(null), doctor: () => ({ ok: true }) }), /outside tests\/acceptance\/tde-oim/);
  assert.strictEqual(guard.state.grants.length, 0);
  removeUnder(target, path.join(target, 'tests'));
});

check('out-of-suite agent write is caught and lease is revoked', () => {
  const guard = fakePolicy();
  assert.throws(() => author(options, { policy: guard, spawn: fakeSpawn(path.join(target, 'backend', 'app.py')), doctor: () => ({ ok: true }) }), /author wrote outside/);
  assert.deepStrictEqual(guard.state.revokes, ['lease-1']);
  removeUnder(target, path.join(target, 'backend'));
});

check('an ignored file write is caught by the author audit', () => {
  const guard = fakePolicy();
  const secret = path.join(target, '.env');
  assert.throws(() => author(options, { policy: guard, spawn: fakeSpawn(secret), doctor: () => ({ ok: true }) }), /author wrote outside/);
  assert.deepStrictEqual(guard.state.revokes, ['lease-1']);
  fs.rmSync(secret, { force: true });
});

check('an unsuccessful agent still loses its lease', () => {
  const guard = fakePolicy();
  const spawn = (command, args, opts) => command === 'claude'
    ? { status: 1, stdout: '', stderr: 'denied' }
    : spawnSync(command, args, opts);
  assert.throws(() => author(options, { policy: guard, spawn, doctor: () => ({ ok: true }) }), /Claude test author failed/);
  assert.deepStrictEqual(guard.state.revokes, ['lease-1']);
});

check('a reported success without an acceptance change is rejected', () => {
  const guard = fakePolicy();
  assert.throws(() => author(options, { policy: guard, spawn: fakeSpawn(null), doctor: () => ({ ok: true }) }),
    /without changing/);
  assert.deepStrictEqual(guard.state.revokes, ['lease-1']);
});

removeScratch(temp);
process.exitCode = failures ? 1 : 0;
