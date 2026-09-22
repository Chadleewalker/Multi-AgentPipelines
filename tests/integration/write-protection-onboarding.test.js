#!/usr/bin/env node
// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0
'use strict';

// Fresh-machine/target rehearsal: install the shipped hook files into isolated
// client directories, then send actual client-shaped Write payloads through the
// installed bridge and policy with a live controller-owned lease.
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'v1-guard-onboarding-'));
process.env.WRITE_PROTECTION_CLAUDE_DIR = path.join(temp, 'claude');
process.env.WRITE_PROTECTION_CODEX_DIR = path.join(temp, 'codex');
process.env.WRITE_PROTECTION_HOST_STATE_DIR = path.join(temp, 'state');
const policy = require('../../scripts/write-protection-policy');
const installer = require('../../scripts/write-protection');
const target = path.join(temp, 'target');
let failures = 0;

function check(name, fn) {
  try { fn(); console.log(`PASS  ${name}`); }
  catch (error) { failures += 1; console.log(`FAIL  ${name}: ${error.stack || error}`); }
}
function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
}
function hook(file, env = {}) {
  const payload = {
    cwd: target, session_id: env.PIPELINE_WRITE_SESSION_ID || crypto.randomUUID(),
    tool_name: 'Write', tool_input: { file_path: file, content: 'canary' },
  };
  return spawnSync(process.execPath, [installer.hookRoot('claude') + '/scripts/write-guard-bridge.js', '--client', 'claude'], {
    input: JSON.stringify(payload), encoding: 'utf8', windowsHide: true,
    env: { ...process.env, ...env }, timeout: 20000,
  });
}

try {
  fs.mkdirSync(target);
  git(target, 'init');
  fs.writeFileSync(path.join(target, 'pipeline.config.json'), '{}\n');
  git(target, 'add', 'pipeline.config.json');
  git(target, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'onboard');

  check('installer configures both clients and can be rolled back', () => {
    const result = installer.install();
    assert.equal(result.doctor.ok, true, JSON.stringify(result.doctor));
  });

  const sessionId = crypto.randomUUID();
  const lease = policy.createLease({ target, role: 'test-author', issueId: 'canary-1',
    sessionId, controllerPid: process.pid, minutes: 1 });
  const trusted = { PIPELINE_WRITE_LEASE_TOKEN: lease.token, PIPELINE_WRITE_SESSION_ID: sessionId };

  check('installed bridge allows its own acceptance suite Write', () => {
    const result = hook('tests/acceptance/canary-1/test.js', trusted);
    assert.equal(result.status, 0, result.stderr || result.error?.message);
  });
  check('installed bridge rejects a sibling acceptance suite Write', () => {
    const result = hook('tests/acceptance/canary-2/test.js', trusted);
    assert.equal(result.status, 2, result.stderr || result.error?.message);
  });
  check('installed bridge rejects backend and frontend Write', () => {
    for (const file of ['backend/app/main.py', 'frontend/src/App.tsx']) {
      const result = hook(file, trusted);
      assert.equal(result.status, 2, `${file}: ${result.stderr || result.error?.message}`);
    }
  });
  check('installed bridge rejects missing lease', () => {
    const result = hook('tests/acceptance/canary-1/test.js');
    assert.equal(result.status, 2, result.stderr || result.error?.message);
  });
  check('installed bridge rejects expired lease', () => {
    const record = JSON.parse(fs.readFileSync(lease.file, 'utf8'));
    record.expiresAt = new Date(Date.now() - 1000).toISOString();
    fs.writeFileSync(lease.file, `${JSON.stringify(record)}\n`);
    const result = hook('tests/acceptance/canary-1/test.js', trusted);
    assert.equal(result.status, 2, result.stderr || result.error?.message);
  });

  policy.revokeLease(lease.leaseId);
  check('rollback restores the pre-install client state', () => {
    installer.rollback();
    assert.equal(installer.doctor().ok, false);
  });
} finally {
  const full = fs.realpathSync(temp);
  assert.equal(path.dirname(full), fs.realpathSync(os.tmpdir()), 'scratch path outside temp');
  assert(path.basename(full).startsWith('v1-guard-onboarding-'), 'unexpected scratch name');
  fs.rmSync(full, { recursive: true, force: true });
}
process.exitCode = failures ? 1 : 0;
