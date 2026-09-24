#!/usr/bin/env node
// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const tool = require('../../scripts/uninstall-write-protection');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'v1-guard-uninstall-'));
let failed = 0;
let serial = 0;

function fixture() {
  const root = path.join(scratch, `case-${++serial}`);
  process.env.WRITE_PROTECTION_CLAUDE_DIR = path.join(root, 'claude');
  process.env.WRITE_PROTECTION_CODEX_DIR = path.join(root, 'codex');
  process.env.WRITE_PROTECTION_HOST_STATE_DIR = path.join(root, 'state');
  return root;
}
function put(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
function claude(groupExtras = []) {
  return {
    theme: 'dark', model: 'opus',
    hooks: {
      SessionStart: [{ hooks: [{ type: 'command', command: 'bd prime' }] }],
      PreToolUse: [
        { matcher: 'Bash', hooks: [{ type: 'command', command: 'node unrelated.js' }] },
        { matcher: 'Write|Edit|MultiEdit|NotebookEdit|Bash|PowerShell', hooks: [
          { type: 'command', command: tool.command('claude') }, ...groupExtras,
        ] },
      ],
    },
  };
}
function block() {
  const cmd = JSON.stringify(tool.command('codex'));
  return [
    '# BEGIN WRITE PROTECTION (multi-agent-pipelines)',
    '# Installed by node scripts/write-protection.js install.',
    '[[hooks.PreToolUse]]', 'matcher = "^Bash$"', '[[hooks.PreToolUse.hooks]]',
    'type = "command"', `command = ${cmd}`, '',
    '[[hooks.PreToolUse]]', 'matcher = "^apply_patch$"', '[[hooks.PreToolUse.hooks]]',
    'type = "command"', `command = ${cmd}`,
    '# END WRITE PROTECTION (multi-agent-pipelines)',
  ].join('\n');
}
function state(index, value = 'false') {
  return `[hooks.state.'${tool.settingsFile('codex')}:pre_tool_use:${index}:0']\nenabled = ${value}\n`;
}
function appBlock(first = 0, unrelated = '') {
  return block().replace('# END WRITE PROTECTION (multi-agent-pipelines)',
    `[hooks.state]\n${unrelated}${state(first)}${state(first + 1)}[tui.model_availability_nux]\nshown = true\n# END WRITE PROTECTION (multi-agent-pipelines)`);
}
function check(name, fn) {
  try { fn(); console.log(`PASS  ${name}`); }
  catch (error) { failed += 1; console.log(`FAIL  ${name}: ${error.stack || error.message}`); }
}

check('missing settings are an idempotent no-op with no backup', () => {
  fixture();
  assert.deepEqual(tool.uninstall().changes, []);
  assert.deepEqual(tool.uninstall(true).changes, []);
  assert.equal(fs.existsSync(tool.backupDir()), false);
});
check('dry-run reports changes without touching settings or creating a backup', () => {
  fixture();
  const cf = tool.settingsFile('claude');
  const xf = tool.settingsFile('codex');
  const originalClaude = Buffer.from(`${JSON.stringify(claude(), null, 2)}\n`);
  const originalCodex = Buffer.from(`model = "gpt"\n${appBlock()}\n`);
  put(cf, originalClaude); put(xf, originalCodex);
  const result = tool.uninstall();
  assert.equal(result.mode, 'dry-run');
  assert.equal(result.changes.length, 2);
  assert.equal(result.changes.find((c) => c.client === 'codex').stateTablesRemoved, 2);
  assert.deepEqual(fs.readFileSync(cf), originalClaude);
  assert.deepEqual(fs.readFileSync(xf), originalCodex);
  assert.equal(fs.existsSync(tool.backupDir()), false);
  const output = [];
  assert.equal(tool.run(['--json'], { out: (line) => output.push(line), err: (line) => { throw new Error(line); } }), 0);
  assert.equal(JSON.parse(output[0]).mode, 'dry-run');
});
check('apply preserves unrelated Claude hooks, Codex state, TUI, and bytes in backup', () => {
  fixture();
  const cf = tool.settingsFile('claude');
  const xf = tool.settingsFile('codex');
  const extra = { type: 'command', command: 'node second.js' };
  const originalClaude = Buffer.from(`${JSON.stringify(claude([extra]), null, 2)}\n`);
  const prior = '[[hooks.PreToolUse]]\nmatcher = "^Read$"\n[[hooks.PreToolUse.hooks]]\ntype = "command"\ncommand = "node prior.js"\n';
  const later = '[[hooks.PreToolUse]]\nmatcher = "^Other$"\n[[hooks.PreToolUse.hooks]]\ntype = "command"\ncommand = "node later.js"\n';
  const originalCodex = Buffer.from(`model = "gpt"\n${prior}${appBlock(1, state(0, 'true'))}\n${later}`);
  put(cf, originalClaude); put(xf, originalCodex);
  const result = tool.uninstall(true);
  assert.equal(result.mode, 'applied');
  assert.equal(result.changes.length, 2);
  const backup = JSON.parse(fs.readFileSync(result.backupFile, 'utf8'));
  assert.deepEqual(Buffer.from(backup.files.find((f) => f.client === 'claude').before, 'base64'), originalClaude);
  assert.deepEqual(Buffer.from(backup.files.find((f) => f.client === 'codex').before, 'base64'), originalCodex);
  const nextClaude = JSON.parse(fs.readFileSync(cf, 'utf8'));
  assert.equal(nextClaude.theme, 'dark');
  assert.deepEqual(nextClaude.hooks.SessionStart, claude().hooks.SessionStart);
  assert.deepEqual(nextClaude.hooks.PreToolUse[0], claude().hooks.PreToolUse[0]);
  assert.deepEqual(nextClaude.hooks.PreToolUse[1].hooks, [extra]);
  const nextCodex = fs.readFileSync(xf, 'utf8');
  assert(nextCodex.includes('node prior.js'));
  assert(nextCodex.includes('node later.js'));
  assert(nextCodex.includes(state(0, 'true')));
  assert(nextCodex.includes('[tui.model_availability_nux]\nshown = true'));
  assert(!nextCodex.includes(state(1)) && !nextCodex.includes(state(2)));
  assert(!nextCodex.includes('write-guard-bridge.js'));
  const parsed = spawnSync('python', ['-c', 'import sys,tomllib; tomllib.loads(sys.stdin.read())'],
    { input: nextCodex, encoding: 'utf8', windowsHide: true });
  if (parsed.error && !['EPERM', 'ENOENT'].includes(parsed.error.code)) throw parsed.error;
  if (!parsed.error) assert.equal(parsed.status, 0, parsed.stderr);
  assert.deepEqual(tool.uninstall(true).changes, []);
});
check('explicit restore checks drift and restores exact bytes', () => {
  fixture();
  const cf = tool.settingsFile('claude');
  const xf = tool.settingsFile('codex');
  const originalClaude = Buffer.from(`${JSON.stringify(claude(), null, 2)}\n`);
  const originalCodex = Buffer.from(`model = "gpt"\n${appBlock()}\n`);
  put(cf, originalClaude); put(xf, originalCodex);
  const applied = tool.uninstall(true);
  const after = fs.readFileSync(xf);
  assert.equal(tool.restore().mode, 'dry-run');
  assert.deepEqual(fs.readFileSync(xf), after);
  fs.appendFileSync(xf, '# changed later\n');
  assert.throws(() => tool.restore(true), /changed after uninstall/);
  assert.deepEqual(fs.readFileSync(cf), Buffer.from(`${JSON.stringify({ ...claude(), hooks: {
    ...claude().hooks, PreToolUse: [claude().hooks.PreToolUse[0]],
  } }, null, 2)}\n`));
  put(xf, after);
  assert.equal(tool.restore(true).mode, 'restored');
  assert.deepEqual(fs.readFileSync(cf), originalClaude);
  assert.deepEqual(fs.readFileSync(xf), originalCodex);
  assert.equal(path.basename(applied.backupFile).endsWith('.json'), true);
});
check('malformed and duplicate Codex markers, command drift, and unmarked bridge refuse all edits', () => {
  const cases = [
    block().replace('# END WRITE PROTECTION (multi-agent-pipelines)', ''),
    `${block()}\n${block()}`,
    block().replace('matcher = "^Bash$"', 'matcher = "^Read$"'),
    `[[hooks.PreToolUse]]\ncommand = ${JSON.stringify(tool.command('codex'))}\n`,
    block().replace('# END WRITE PROTECTION (multi-agent-pipelines)', 'extra = true\n# END WRITE PROTECTION (multi-agent-pipelines)'),
    `${block()}\nextra = true\n`,
  ];
  for (const bad of cases) {
    fixture();
    const cf = tool.settingsFile('claude');
    const xf = tool.settingsFile('codex');
    const beforeClaude = Buffer.from(`${JSON.stringify(claude(), null, 2)}\n`);
    put(cf, beforeClaude); put(xf, bad);
    assert.throws(() => tool.uninstall(true), /Codex|write-protection|hook/);
    assert.deepEqual(fs.readFileSync(cf), beforeClaude);
    assert.equal(fs.readFileSync(xf, 'utf8'), bad);
    assert.equal(fs.existsSync(tool.backupDir()), false);
  }
});
check('later positional state refuses migration without changing either client', () => {
  fixture();
  const cf = tool.settingsFile('claude');
  const xf = tool.settingsFile('codex');
  const originalClaude = Buffer.from(`${JSON.stringify(claude(), null, 2)}\n`);
  const later = '[[hooks.PreToolUse]]\nmatcher = "^Read$"\n[[hooks.PreToolUse.hooks]]\ntype = "command"\ncommand = "node read.js"\n';
  const originalCodex = Buffer.from(`${appBlock().replace('[tui.model_availability_nux]', `${state(2)}[tui.model_availability_nux]`)}\n${later}`);
  put(cf, originalClaude); put(xf, originalCodex);
  assert.throws(() => tool.uninstall(true), /reindexing/);
  assert.deepEqual(fs.readFileSync(cf), originalClaude);
  assert.deepEqual(fs.readFileSync(xf), originalCodex);
});
check('unmarked Claude bridge outside PreToolUse refuses uninstall', () => {
  fixture();
  const cf = tool.settingsFile('claude');
  const xf = tool.settingsFile('codex');
  const bad = { hooks: { PostToolUse: [{ hooks: [{ type: 'command', command: tool.command('claude') }] }] } };
  const beforeClaude = Buffer.from(`${JSON.stringify(bad, null, 2)}\n`);
  const beforeCodex = Buffer.from(`${appBlock()}\n`);
  put(cf, beforeClaude); put(xf, beforeCodex);
  assert.throws(() => tool.uninstall(true), /outside PreToolUse/);
  assert.deepEqual(fs.readFileSync(cf), beforeClaude);
  assert.deepEqual(fs.readFileSync(xf), beforeCodex);
});
check('CRLF and BOM are retained around the removed Codex block', () => {
  fixture();
  const xf = tool.settingsFile('codex');
  const source = `\uFEFFmodel = "gpt"\r\n${appBlock().replace(/\n/g, '\r\n')}\r\n[after]\r\nx = 1\r\n`;
  put(xf, source);
  tool.uninstall(true);
  const after = fs.readFileSync(xf, 'utf8');
  assert(after.startsWith('\uFEFFmodel = "gpt"\r\n'));
  assert(after.includes('[hooks.state]\r\n'));
  assert(after.includes('[tui.model_availability_nux]\r\nshown = true\r\n'));
  assert(after.endsWith('[after]\r\nx = 1\r\n'));
  assert(!after.includes('write-guard-bridge.js'));
});
check('partial write failure restores the first client from its current backup', () => {
  fixture();
  const cf = tool.settingsFile('claude');
  const xf = tool.settingsFile('codex');
  const beforeClaude = Buffer.from(`${JSON.stringify(claude(), null, 2)}\n`);
  const beforeCodex = Buffer.from(`${appBlock()}\n`);
  put(cf, beforeClaude); put(xf, beforeCodex);
  const originalRename = fs.renameSync;
  fs.renameSync = function(from, to) {
    if (to === xf) { const error = new Error('simulated Codex write failure'); error.code = 'EIO'; throw error; }
    return originalRename.apply(this, arguments);
  };
  try { assert.throws(() => tool.uninstall(true), /unchanged settings restored/); }
  finally { fs.renameSync = originalRename; }
  assert.deepEqual(fs.readFileSync(cf), beforeClaude);
  assert.deepEqual(fs.readFileSync(xf), beforeCodex);
  assert(fs.readdirSync(tool.backupDir()).some((name) => name.endsWith('.json')));
});
check('restore write failure returns to the fully uninstalled state', () => {
  fixture();
  const cf = tool.settingsFile('claude');
  const xf = tool.settingsFile('codex');
  put(cf, `${JSON.stringify(claude(), null, 2)}\n`);
  put(xf, `${appBlock()}\n`);
  tool.uninstall(true);
  const afterClaude = fs.readFileSync(cf);
  const afterCodex = fs.readFileSync(xf);
  const originalRename = fs.renameSync;
  fs.renameSync = function(from, to) {
    if (to === xf) { const error = new Error('simulated Codex restore failure'); error.code = 'EIO'; throw error; }
    return originalRename.apply(this, arguments);
  };
  try { assert.throws(() => tool.restore(true), /uninstalled settings restored/); }
  finally { fs.renameSync = originalRename; }
  assert.deepEqual(fs.readFileSync(cf), afterClaude);
  assert.deepEqual(fs.readFileSync(xf), afterCodex);
});
check('partial copy fallback reports manual recovery and keeps its backup', () => {
  fixture();
  const cf = tool.settingsFile('claude');
  const xf = tool.settingsFile('codex');
  const beforeClaude = Buffer.from(`${JSON.stringify(claude(), null, 2)}\n`);
  put(cf, beforeClaude); put(xf, `${appBlock()}\n`);
  const originalRename = fs.renameSync;
  const originalCopy = fs.copyFileSync;
  fs.renameSync = function(from, to) {
    if (to === xf) { const error = new Error('rename refused'); error.code = 'EPERM'; throw error; }
    return originalRename.apply(this, arguments);
  };
  fs.copyFileSync = function(from, to) {
    if (to === xf) { fs.writeFileSync(to, 'partial'); throw new Error('copy interrupted'); }
    return originalCopy.apply(this, arguments);
  };
  try {
    assert.throws(() => tool.uninstall(true), /partial or drifted settings need manual recovery.*backup:/);
  } finally { fs.renameSync = originalRename; fs.copyFileSync = originalCopy; }
  assert.deepEqual(fs.readFileSync(cf), beforeClaude);
  assert.equal(fs.readFileSync(xf, 'utf8'), 'partial');
  assert(fs.readdirSync(tool.backupDir()).some((name) => name.endsWith('.json')));
});
check('backup destination inside a checkout is refused before settings change', () => {
  const root = fixture();
  const cf = tool.settingsFile('claude');
  const before = Buffer.from(`${JSON.stringify(claude(), null, 2)}\n`);
  put(cf, before);
  const repo = path.join(root, 'checkout');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  process.env.WRITE_PROTECTION_HOST_STATE_DIR = path.join(repo, 'state');
  assert.throws(() => tool.uninstall(true), /inside a Git checkout/);
  assert.deepEqual(fs.readFileSync(cf), before);
  assert.equal(fs.existsSync(path.join(repo, 'state')), false);
});

const resolved = fs.realpathSync(scratch);
assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
assert(path.basename(resolved).startsWith('v1-guard-uninstall-'));
fs.rmSync(resolved, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
