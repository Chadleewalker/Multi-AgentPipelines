#!/usr/bin/env node
// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0
'use strict';

// V1 host installation. The issue-scoped lease controller is author-acceptance.js.
// Hook files are installed outside tracked checkouts; runner admission is separate.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const policy = require('./write-protection-policy');

const ROOT = path.resolve(__dirname, '..');
const PAYLOAD = [
  'scripts/write-guard.js', 'scripts/write-guard-bridge.js',
  'scripts/write-protection-policy.js', 'contracts/write-protection.json',
];
const BEGIN = '# BEGIN WRITE PROTECTION (multi-agent-pipelines)';
const END = '# END WRITE PROTECTION (multi-agent-pipelines)';
const CLAUDE_MATCHER = 'Write|Edit|MultiEdit|NotebookEdit|Bash|PowerShell';
const CLAUDE_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash', 'PowerShell'];

function clientDir(name) {
  const env = name === 'claude' ? 'WRITE_PROTECTION_CLAUDE_DIR' : 'WRITE_PROTECTION_CODEX_DIR';
  return path.resolve(process.env[env] || path.join(os.homedir(), `.${name}`));
}
function hookRoot(name) { return path.join(clientDir(name), 'hooks', 'write-protection'); }
function hookBridge(name) { return path.join(hookRoot(name), 'scripts', 'write-guard-bridge.js'); }
function settingsFile(name) { return path.join(clientDir(name), name === 'claude' ? 'settings.json' : 'config.toml'); }
function stateDir() { return path.resolve(policy.hostStateDir()); }
function sha(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function read(file) { try { return fs.readFileSync(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
function slash(p) { return p.split(path.sep).join('/'); }
function command(name) { return `node "${slash(hookBridge(name))}" --client ${name}`; }
function writeAtomic(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, bytes, { mode: 0o600 });
  try { fs.renameSync(tmp, file); }
  catch (e) {
    // Some Windows filesystems refuse rename-over-existing. The install transaction
    // already holds the original bytes and restores them if this replacement fails.
    if (read(file) && ['EEXIST', 'EPERM', 'EACCES'].includes(e.code)) {
      try { fs.copyFileSync(tmp, file); fs.rmSync(tmp, { force: true }); return; }
      catch (copyError) { e = copyError; }
    }
    try { fs.rmSync(tmp, { force: true }); } catch {}
    throw e;
  }
}

function parseArgs(argv) {
  const cmd = argv[0];
  const opts = { json: false };
  for (let i = 1; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === '--json') { opts.json = true; continue; }
    throw new Error(`unknown option ${key}`);
  }
  return { cmd, opts };
}

function withoutOwnClaudeHooks(settings) {
  if (!settings.hooks || !Array.isArray(settings.hooks.PreToolUse)) return settings;
  settings.hooks.PreToolUse = settings.hooks.PreToolUse.flatMap((group) => {
    if (!group || !Array.isArray(group.hooks)) return [group];
    const hooks = group.hooks.filter((h) => !(h && typeof h.command === 'string'
      && h.command.includes('write-guard-bridge.js') && h.command.includes('write-protection')));
    return hooks.length ? [{ ...group, hooks }] : [];
  });
  return settings;
}
function claudeSettings(bytes) {
  let settings = {};
  if (bytes) {
    settings = JSON.parse(bytes.toString('utf8'));
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Claude settings must be a JSON object');
  }
  withoutOwnClaudeHooks(settings);
  settings.hooks ||= {};
  settings.hooks.PreToolUse ||= [];
  if (!Array.isArray(settings.hooks.PreToolUse)) throw new Error('Claude PreToolUse must be an array');
  settings.hooks.PreToolUse.push({ matcher: CLAUDE_MATCHER, hooks: [{ type: 'command', command: command('claude') }] });
  return Buffer.from(`${JSON.stringify(settings, null, 2)}\n`);
}
function codexBlock() {
  const cmd = JSON.stringify(command('codex'));
  return [BEGIN,
    '# Installed by node scripts/write-protection.js install.',
    '[[hooks.PreToolUse]]', 'matcher = "^Bash$"', '[[hooks.PreToolUse.hooks]]',
    'type = "command"', `command = ${cmd}`, '',
    '[[hooks.PreToolUse]]', 'matcher = "^apply_patch$"', '[[hooks.PreToolUse.hooks]]',
    'type = "command"', `command = ${cmd}`, END].join('\n');
}
function stripCodex(text) {
  const start = text.indexOf(BEGIN);
  const end = text.indexOf(END);
  if (start === -1 && end === -1) return text;
  if (start < 0 || end < start || text.indexOf(BEGIN, start + 1) >= 0 || text.indexOf(END, end + 1) >= 0) {
    throw new Error('Codex managed hook block is malformed');
  }
  // Codex writes hook trust (and sometimes TUI state) immediately before the
  // trailing marker. Keep that state when refreshing the managed hook block.
  const core = codexBlock().slice(0, -END.length);
  if (!text.slice(start, end).startsWith(core)) {
    throw new Error('Codex managed hook definitions changed after installation');
  }
  const appended = text.slice(start + core.length, end);
  return `${text.slice(0, start).trimEnd()}\n${appended.trim()}\n${text.slice(end + END.length).trimStart()}`.trimEnd();
}
function codexSettings(bytes) {
  const text = stripCodex(bytes ? bytes.toString('utf8').replace(/\r\n/g, '\n') : '');
  // Another unmarked copy is ambiguous and cannot be safely rewritten.
  if (text.includes('write-guard-bridge.js')) throw new Error('unmanaged Codex write-protection hook present');
  return Buffer.from(`${text}\n\n${codexBlock()}\n`.trimStart());
}

function filesToInstall() {
  const changes = [];
  for (const name of ['claude', 'codex']) {
    for (const rel of PAYLOAD) {
      const source = path.join(ROOT, rel);
      const contents = read(source);
      if (!contents) throw new Error(`missing source payload ${rel}`);
      changes.push({ file: path.join(hookRoot(name), rel), contents });
    }
    const file = settingsFile(name);
    const original = read(file);
    changes.push({ file, contents: name === 'claude' ? claudeSettings(original) : codexSettings(original) });
  }
  return changes;
}
function install() {
  const changes = filesToInstall(); // validate both clients before changing either
  const backupDir = path.join(stateDir(), 'install-backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const latestFile = path.join(backupDir, 'latest');
  const id = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
  const previousLatest = read(latestFile);
  const manifest = { version: 1, id, createdAt: new Date().toISOString(),
    previousLatest: previousLatest ? previousLatest.toString('base64') : null, files: [] };
  for (const { file, contents } of changes) {
    const before = read(file);
    manifest.files.push({ file, before: before ? before.toString('base64') : null, afterHash: sha(contents) });
  }
  const backupFile = path.join(backupDir, `${id}.json`);
  writeAtomic(backupFile, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
  try {
    for (const { file, contents } of changes) writeAtomic(file, contents);
    writeAtomic(latestFile, Buffer.from(id));
    const diagnosis = doctor();
    if (!diagnosis.ok) throw new Error(`installed hook failed doctor: ${diagnosis.reason}`);
    return { backupFile, doctor: diagnosis };
  } catch (e) {
    restore(manifest, true);
    if (manifest.previousLatest === null) fs.rmSync(latestFile, { force: true });
    else writeAtomic(latestFile, Buffer.from(manifest.previousLatest, 'base64'));
    throw e;
  }
}
function restore(manifest, force = false) {
  for (const item of manifest.files) {
    const current = read(item.file);
    if (!force && (!current || sha(current) !== item.afterHash)) {
      throw new Error(`refusing rollback because ${item.file} changed after installation`);
    }
  }
  for (const item of manifest.files) {
    if (item.before === null) fs.rmSync(item.file, { force: true });
    else writeAtomic(item.file, Buffer.from(item.before, 'base64'));
  }
}
function rollback() {
  const dir = path.join(stateDir(), 'install-backups');
  const id = read(path.join(dir, 'latest'))?.toString('utf8').trim();
  if (!id || !/^\d+-[0-9a-f]{12}$/.test(id)) throw new Error('no installation backup available');
  const file = path.join(dir, `${id}.json`);
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  restore(manifest);
  if (manifest.previousLatest === null) fs.rmSync(path.join(dir, 'latest'), { force: true });
  else writeAtomic(path.join(dir, 'latest'), Buffer.from(manifest.previousLatest, 'base64'));
  return { restoredFrom: file, doctor: doctor() };
}

function payloadState(name) {
  const mismatches = [];
  for (const rel of PAYLOAD) {
    const source = read(path.join(ROOT, rel));
    const installed = read(path.join(hookRoot(name), rel));
    if (!source || !installed || sha(source) !== sha(installed)) mismatches.push(rel);
  }
  return mismatches;
}
function claudeCoverage() {
  const bytes = read(settingsFile('claude'));
  if (!bytes) return { configured: false, reason: 'settings missing' };
  try {
    const cfg = JSON.parse(bytes.toString('utf8'));
    const groups = cfg.hooks?.PreToolUse || [];
    if (!Array.isArray(groups)) return { configured: false, reason: 'PreToolUse malformed' };
    const covered = CLAUDE_TOOLS.filter((tool) => groups.some((group) => {
      try {
        const matcher = new RegExp(`^(?:${group.matcher || ''})$`);
        return matcher.test(tool) && Array.isArray(group.hooks)
          && group.hooks.some((h) => h.type === 'command' && h.command === command('claude'));
      } catch { return false; }
    }));
    const duplicate = groups.some((group) => Array.isArray(group?.hooks)
      && group.hooks.some((h) => typeof h?.command === 'string'
        && h.command.includes('write-guard-bridge.js') && h.command !== command('claude')));
    return { configured: covered.length === CLAUDE_TOOLS.length && !duplicate,
      covered, reason: duplicate ? 'stale or duplicate bridge command' : undefined };
  } catch { return { configured: false, reason: 'settings invalid JSON' }; }
}
function codexCoverage() {
  const bytes = read(settingsFile('codex'));
  if (!bytes) return { configured: false, reason: 'config missing' };
  const text = bytes.toString('utf8').replace(/\r\n/g, '\n');
  const core = codexBlock().slice(0, -END.length);
  const disabled = /(?:^|\n)\s*(?:enabled\s*=\s*false|hooks\s*=\s*false)/m.test(text);
  let duplicate = false;
  let corePresent = false;
  try {
    const start = text.indexOf(BEGIN);
    corePresent = start >= 0 && text.slice(start).startsWith(core);
    duplicate = stripCodex(text).includes('write-guard-bridge.js');
  }
  catch { duplicate = true; }
  return {
    configured: corePresent && !disabled && !duplicate,
    covered: corePresent && !disabled && !duplicate ? ['Bash', 'apply_patch'] : [],
    reason: disabled ? 'hooks disabled in config' : duplicate ? 'stale or duplicate bridge command' : undefined,
    runtimeVerified: false,
    runtimeNote: 'Codex hook trust and tool delivery require an interactive client canary',
  };
}
function bridgeCanary(name) {
  const bridge = hookBridge(name);
  if (!read(bridge)) return false;
  const env = { ...process.env };
  delete env.PIPELINE_WRITE_LEASE_TOKEN;
  delete env.PIPELINE_WRITE_SESSION_ID;
  const probe = (payload) => spawnSync(process.execPath, [bridge, '--client', name], {
    input: payload, encoding: 'utf8', timeout: 10000, windowsHide: true, env,
  });
  const malformed = probe('{');
  const expectedDeny = (result) => {
    if (name === 'claude') return result.status === 2 && String(result.stderr).includes('write-protection:');
    if (result.status !== 0) return false;
    try { return JSON.parse(result.stdout).hookSpecificOutput.permissionDecision === 'deny'; } catch { return false; }
  };
  if (!expectedDeny(malformed)) return false;
  const payloads = name === 'claude'
    ? [{ cwd: ROOT, tool_name: 'Write', tool_input: { file_path: path.join(ROOT, 'runner', 'run.js') } }]
    : [
      { cwd: ROOT, tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Update File: runner/run.js\n@@\n-x\n+y\n*** End Patch' } },
      { cwd: ROOT, tool_name: 'Bash', tool_input: { command: 'echo changed > runner/run.js' } },
    ];
  return payloads.every((payload) => expectedDeny(probe(JSON.stringify(payload))));
}
function doctor() {
  const clients = {};
  for (const name of ['claude', 'codex']) {
    const mismatches = payloadState(name);
    const coverage = name === 'claude' ? claudeCoverage() : codexCoverage();
    const canary = bridgeCanary(name);
    clients[name] = {
      state: mismatches.length || !coverage.configured || !canary ? 'degraded' : 'configured',
      payloadMismatches: mismatches, coverage, bridgeCanary: canary,
      runtimeVerified: false,
    };
  }
  const ok = Object.values(clients).every((client) => client.state === 'configured');
  return {
    ok,
    reason: ok ? 'both hook installations and direct bridge canaries are configured'
      : 'one or more hook installations or direct bridge canaries are degraded',
    clients,
    note: 'Configured hooks are not proof that a client has activated or trusted them; run client canaries.',
  };
}

function run(argv, io = { out: console.log, err: console.error }) {
  try {
    const { cmd, opts } = parseArgs(argv);
    let result;
    if (cmd === 'install') result = install();
    else if (cmd === 'doctor' || cmd === 'status') result = doctor();
    else if (cmd === 'rollback') result = rollback();
    else throw new Error('usage: write-protection.js install|doctor|rollback');
    io.out(opts.json ? JSON.stringify(result) : JSON.stringify(result, null, 2));
    return 0;
  } catch (e) { io.err(`write-protection: ${e.message}`); return 2; }
}

if (require.main === module) process.exit(run(process.argv.slice(2)));
module.exports = { run, install, doctor, rollback, clientDir, hookRoot, command, codexBlock };
