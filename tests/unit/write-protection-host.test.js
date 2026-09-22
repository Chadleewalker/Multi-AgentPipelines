#!/usr/bin/env node
// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..', '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v1-guard-install-'));
process.env.WRITE_PROTECTION_CLAUDE_DIR = path.join(tmp, 'claude');
process.env.WRITE_PROTECTION_CODEX_DIR = path.join(tmp, 'codex');
process.env.WRITE_PROTECTION_HOST_STATE_DIR = path.join(tmp, 'state');

const bridge = require('../../scripts/write-guard-bridge');
const installer = require('../../scripts/write-protection');
let failures = 0;
function removeScratch(dir, prefix) {
  const full = fs.realpathSync(dir);
  assert.equal(path.dirname(full), fs.realpathSync(os.tmpdir()), 'scratch path outside temp');
  assert(path.basename(full).startsWith(prefix), 'unexpected scratch name');
  fs.rmSync(full, { recursive: true, force: true });
}
function check(name, fn) {
  try { fn(); console.log(`PASS  ${name}`); }
  catch (e) { failures += 1; console.log(`FAIL  ${name}: ${e.message}`); }
}

check('bridge takes authority only from launcher environment', () => {
  const req = bridge.requestFrom({
    cwd: tmp, session_id: 'trusted-session', token: 'forged', tool_name: 'Write',
    tool_input: { file_path: 'tests/acceptance/tde-oim/test_a1.py', token: 'forged' },
  }, 'claude', { PIPELINE_WRITE_LEASE_TOKEN: 'trusted', PIPELINE_WRITE_SESSION_ID: 'trusted-session' });
  assert.equal(req.token, 'trusted');
  assert.equal(req.sessionId, 'trusted-session');
  assert.throws(() => bridge.requestFrom({ cwd: tmp, session_id: 'forged', tool_name: 'Write',
    tool_input: { file_path: 'tests/acceptance/tde-oim/test_a1.py' } }, 'claude',
  { PIPELINE_WRITE_LEASE_TOKEN: 'trusted', PIPELINE_WRITE_SESSION_ID: 'trusted-session' }));
});
check('bridge refuses malformed write payload rather than bypassing it', () => {
  assert.throws(() => bridge.requestFrom({ cwd: tmp, tool_name: 'Write', tool_input: {} }, 'claude'));
  const r = spawnSync(process.execPath, [path.join(root, 'scripts/write-guard-bridge.js'), '--client', 'claude'], {
    input: '{', encoding: 'utf8', windowsHide: true,
  });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /write-protection/);
});
check('Claude PowerShell calls are covered as shell actions', () => {
  const req = bridge.requestFrom({ cwd: tmp, tool_name: 'PowerShell',
    tool_input: { command: 'Set-Content backend/app/main.py bad' } }, 'claude');
  assert.equal(req.action, 'shell');
  assert.match(req.command, /^powershell /);
});
check('Codex malformed hook receives a structured denial', () => {
  const r = spawnSync(process.execPath, [path.join(root, 'scripts/write-guard-bridge.js'), '--client', 'codex'], {
    input: '{', encoding: 'utf8', windowsHide: true,
  });
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny');
});
check('installer preserves unrelated Claude hooks and Codex settings', () => {
  fs.mkdirSync(process.env.WRITE_PROTECTION_CLAUDE_DIR, { recursive: true });
  fs.mkdirSync(process.env.WRITE_PROTECTION_CODEX_DIR, { recursive: true });
  const claudeFile = path.join(process.env.WRITE_PROTECTION_CLAUDE_DIR, 'settings.json');
  const codexFile = path.join(process.env.WRITE_PROTECTION_CODEX_DIR, 'config.toml');
  const originalClaude = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node unrelated.js' }] }] }, theme: 'dark' };
  fs.writeFileSync(claudeFile, `${JSON.stringify(originalClaude, null, 2)}\n`);
  fs.writeFileSync(codexFile, 'model = "gpt-6-astra"\n[desktop]\nfoo = true\n');
  const result = installer.install();
  assert.equal(result.doctor.ok, true, JSON.stringify(result.doctor));
  assert(result.doctor.clients.claude.coverage.covered.includes('PowerShell'));
  const nextClaude = JSON.parse(fs.readFileSync(claudeFile, 'utf8'));
  assert.equal(nextClaude.theme, 'dark');
  assert(nextClaude.hooks.PreToolUse.some((group) => group.hooks.some((h) => h.command === 'node unrelated.js')));
  assert.match(fs.readFileSync(codexFile, 'utf8'), /model = "gpt-6-astra"/);
  assert.match(fs.readFileSync(codexFile, 'utf8'), /foo = true/);
  assert.equal(installer.doctor().clients.codex.coverage.runtimeVerified, false);
  installer.rollback();
  assert.deepEqual(JSON.parse(fs.readFileSync(claudeFile, 'utf8')), originalClaude);
  assert.equal(fs.readFileSync(codexFile, 'utf8'), 'model = "gpt-6-astra"\n[desktop]\nfoo = true\n');
});
check('doctor notices payload drift and rollback refuses to overwrite later edits', () => {
  installer.install();
  const payload = path.join(installer.hookRoot('claude'), 'scripts', 'write-guard-bridge.js');
  fs.appendFileSync(payload, '\n// changed after install\n');
  assert.equal(installer.doctor().ok, false);
  assert.throws(() => installer.rollback(), /changed after installation/);
});
check('rollback refuses a deleted installed payload as drift', () => {
  const payload = path.join(installer.hookRoot('codex'), 'scripts', 'write-guard-bridge.js');
  fs.rmSync(payload, { force: true });
  assert.throws(() => installer.rollback(), /changed after installation/);
});
check('successive installs roll back one version at a time', () => {
  const separate = fs.mkdtempSync(path.join(os.tmpdir(), 'v1-guard-upgrade-'));
  process.env.WRITE_PROTECTION_CLAUDE_DIR = path.join(separate, 'claude');
  process.env.WRITE_PROTECTION_CODEX_DIR = path.join(separate, 'codex');
  process.env.WRITE_PROTECTION_HOST_STATE_DIR = path.join(separate, 'state');
  installer.install();
  installer.install();
  assert.equal(installer.doctor().ok, true);
  installer.rollback();
  assert.equal(installer.doctor().ok, true);
  installer.rollback();
  assert.equal(installer.doctor().ok, false);
  removeScratch(separate, 'v1-guard-upgrade-');
});
check('Codex trust records survive doctor and reinstall', () => {
  const separate = fs.mkdtempSync(path.join(os.tmpdir(), 'v1-guard-trust-'));
  process.env.WRITE_PROTECTION_CLAUDE_DIR = path.join(separate, 'claude');
  process.env.WRITE_PROTECTION_CODEX_DIR = path.join(separate, 'codex');
  process.env.WRITE_PROTECTION_HOST_STATE_DIR = path.join(separate, 'state');
  installer.install();
  const codexFile = path.join(process.env.WRITE_PROTECTION_CODEX_DIR, 'config.toml');
  const trust = '[hooks.state]\n[hooks.state."hook-id"]\ntrusted_hash = "sha256:example"\n';
  const before = fs.readFileSync(codexFile, 'utf8');
  fs.writeFileSync(codexFile, before.replace('# END WRITE PROTECTION (multi-agent-pipelines)',
    `${trust}# END WRITE PROTECTION (multi-agent-pipelines)`));
  assert.equal(installer.doctor().ok, true);
  installer.install();
  assert(fs.readFileSync(codexFile, 'utf8').includes(trust));
  assert.equal(installer.doctor().ok, true);
  removeScratch(separate, 'v1-guard-trust-');
});

try { removeScratch(tmp, 'v1-guard-install-'); } catch {}
process.exit(failures ? 1 : 0);
