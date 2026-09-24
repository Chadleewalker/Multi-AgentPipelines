#!/usr/bin/env node
// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0
'use strict';

// Retires only the two host registrations made by V1 write-protection.js.
// The payload, lease state, and unrelated client configuration are left alone.
// This file deliberately has no dependency on the installer, which is removed
// from the repository by the V1 rollback.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BEGIN = '# BEGIN WRITE PROTECTION (multi-agent-pipelines)';
const END = '# END WRITE PROTECTION (multi-agent-pipelines)';
const CLAUDE_MATCHER = 'Write|Edit|MultiEdit|NotebookEdit|Bash|PowerShell';
const BRIDGE_NAME = 'write-guard-bridge.js';

function clientDir(name) {
  const key = name === 'claude' ? 'WRITE_PROTECTION_CLAUDE_DIR' : 'WRITE_PROTECTION_CODEX_DIR';
  return path.resolve(process.env[key] || path.join(os.homedir(), `.${name}`));
}
function settingsFile(name) {
  return path.join(clientDir(name), name === 'claude' ? 'settings.json' : 'config.toml');
}
function stateDir() {
  return path.resolve(process.env.WRITE_PROTECTION_HOST_STATE_DIR
    || path.join(os.homedir(), '.multi-agent-pipelines', 'write-protection'));
}
function backupDir() { return path.join(stateDir(), 'uninstall-backups'); }
function assertOutsideCheckout(dir) {
  let current = path.resolve(dir);
  for (;;) {
    if (fs.existsSync(path.join(current, '.git'))) {
      throw new Error(`refusing backup directory inside a Git checkout: ${dir}`);
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}
function sha(bytes) { return bytes === null ? null : crypto.createHash('sha256').update(bytes).digest('hex'); }
function slash(file) { return file.split(path.sep).join('/'); }
function command(name) {
  return `node "${slash(path.join(clientDir(name), 'hooks', 'write-protection', 'scripts', BRIDGE_NAME))}" --client ${name}`;
}
function read(file) {
  let stat;
  try { stat = fs.lstatSync(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!stat.isFile()) throw new Error(`refusing non-regular file ${file}`);
  return fs.readFileSync(file);
}
function utf8(bytes, file) {
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error(`${file} is not valid UTF-8`);
  return text;
}
function same(a, b) { return a === null ? b === null : b !== null && a.equals(b); }

function claudeAfter(before, file) {
  if (before === null) return { after: null, removed: 0 };
  const raw = utf8(before, file);
  let settings;
  try { settings = JSON.parse(raw.replace(/^\uFEFF/, '')); }
  catch { throw new Error(`Claude settings are malformed JSON: ${file}`); }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new Error('Claude settings must be a JSON object');
  }
  if (settings.hooks === undefined) {
    if (raw.includes(BRIDGE_NAME)) throw new Error('unmarked Claude write-protection bridge present');
    return { after: before, removed: 0 };
  }
  if (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) {
    throw new Error('Claude hooks are malformed');
  }
  const groups = settings.hooks.PreToolUse;
  if (groups === undefined) {
    if (raw.includes(BRIDGE_NAME)) throw new Error('Claude write-protection bridge outside PreToolUse');
    return { after: before, removed: 0 };
  }
  if (!Array.isArray(groups)) throw new Error('Claude PreToolUse must be an array');
  let removed = 0;
  const next = groups.flatMap((group) => {
    if (!group || typeof group !== 'object' || Array.isArray(group) || !Array.isArray(group.hooks)) {
      throw new Error('Claude PreToolUse group is malformed');
    }
    const hooks = group.hooks.filter((hook) => {
      if (!hook || typeof hook !== 'object' || Array.isArray(hook)) {
        throw new Error('Claude PreToolUse hook is malformed');
      }
      if (typeof hook.command !== 'string' || !hook.command.includes(BRIDGE_NAME)) return true;
      if (hook.command !== command('claude') || hook.type !== 'command'
        || group.matcher !== CLAUDE_MATCHER || Object.keys(hook).some((key) => !['type', 'command'].includes(key))) {
        throw new Error('Claude write-protection bridge changed or is unmarked');
      }
      removed += 1;
      return false;
    });
    return hooks.length ? [{ ...group, hooks }] : [];
  });
  if (removed > 1) throw new Error('multiple Claude write-protection bridges are ambiguous');
  if (!removed) {
    if (raw.includes(BRIDGE_NAME)) throw new Error('unmarked Claude write-protection bridge present');
    return { after: before, removed: 0 };
  }
  settings.hooks.PreToolUse = next;
  if (JSON.stringify(settings).includes(BRIDGE_NAME)) {
    throw new Error('another Claude write-protection bridge remains outside PreToolUse');
  }
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const trailing = /(?:\r?\n)$/.test(raw) ? eol : '';
  const bom = raw.startsWith('\uFEFF') ? '\uFEFF' : '';
  return { after: Buffer.from(bom + JSON.stringify(settings, null, 2).replace(/\n/g, eol) + trailing), removed };
}

function codexCore() {
  const cmd = JSON.stringify(command('codex'));
  return [BEGIN, '# Installed by node scripts/write-protection.js install.',
    '[[hooks.PreToolUse]]', 'matcher = "^Bash$"', '[[hooks.PreToolUse.hooks]]',
    'type = "command"', `command = ${cmd}`, '',
    '[[hooks.PreToolUse]]', 'matcher = "^apply_patch$"', '[[hooks.PreToolUse.hooks]]',
    'type = "command"', `command = ${cmd}`, ''].join('\n');
}
function markerLines(text, marker) {
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...text.matchAll(new RegExp(`^${escaped}\\r?$`, 'gm'))];
}
function consumeCore(raw, expected) {
  let i = 0;
  for (const char of expected) {
    if (char === '\n' && raw.slice(i, i + 2) === '\r\n') { i += 2; continue; }
    if (raw[i] !== char) throw new Error('Codex managed hook definitions changed after installation');
    i += 1;
  }
  return i;
}
function substantiveFirst(text) {
  return text.split(/\r?\n/).find((line) => line.trim() && !line.trim().startsWith('#'))?.trim() || '';
}
function isTable(line) { return /^\[(?:\[[^\]]+\]|[^\]]+)\]$/.test(line); }
function appSuffixInfo(suffix) {
  const first = substantiveFirst(suffix);
  if (first && !isTable(first)) {
    throw new Error('Codex app state after managed hooks does not start a table');
  }
  let table = false;
  let stateTables = 0;
  for (const line of suffix.split(/\r?\n/)) {
    const part = line.trim();
    if (!part || part.startsWith('#')) continue;
    if (isTable(part)) {
      if (!/^\[hooks\.state(?:\.(?:'[^']+'|"(?:[^"\\]|\\.)+"))?\]$/.test(part)
        && !/^\[tui(?:\.[A-Za-z0-9_.-]+)?\]$/.test(part)) {
        throw new Error('Codex managed block contains unexpected appended table');
      }
      table = true;
      if (part.startsWith('[hooks.state.')) stateTables += 1;
      continue;
    }
    if (!table || !/^(?:[A-Za-z0-9_.-]+|'[^']+'|"[^"]+")\s*=/.test(part)) {
      throw new Error('Codex app state after managed hooks is malformed');
    }
  }
  return { hasTable: table, stateTables };
}
function preToolUseCount(text) {
  return [...text.matchAll(/^\[\[hooks\.PreToolUse\]\]\r?$/gm)].length;
}
function stateKey(header) {
  const literal = /^\[hooks\.state\.'([^']+)'\]\r?$/.exec(header);
  if (literal) return literal[1];
  const quoted = /^\[hooks\.state\.("(?:[^"\\]|\\.)+")\]\r?$/.exec(header);
  if (quoted) {
    try { return JSON.parse(quoted[1]); }
    catch { throw new Error('Codex positional hook state key is malformed'); }
  }
  if (header.startsWith('[hooks.state.')) throw new Error('Codex positional hook state key is malformed');
  return null;
}
function stateKeys(text) {
  return [...text.matchAll(/^\[(?:\[[^\]]+\]|[^\]]+)\]\r?$/gm)]
    .map((match) => stateKey(match[0])).filter((key) => key !== null);
}
function removeOwnedState(suffix, file, firstIndex, laterCount) {
  const headers = [...suffix.matchAll(/^\[(?:\[[^\]]+\]|[^\]]+)\]\r?$/gm)];
  const ownKeys = new Set([firstIndex, firstIndex + 1]
    .map((index) => `${file}:pre_tool_use:${index}:0`));
  let removed = 0;
  let result = '';
  let cursor = 0;
  for (let i = 0; i < headers.length; i += 1) {
    const header = headers[i];
    const key = stateKey(header[0]);
    if (key === null) continue;
    const prefix = `${file}:pre_tool_use:`;
    if (key.startsWith(prefix)) {
      const indexMatch = /^(\d+):(\d+)$/.exec(key.slice(prefix.length));
      if (!indexMatch) throw new Error('Codex positional hook state is ambiguous');
      const index = Number(indexMatch[1]);
      if (ownKeys.has(key)) {
        result += suffix.slice(cursor, header.index);
        cursor = i + 1 < headers.length ? headers[i + 1].index : suffix.length;
        removed += 1;
      } else if (index >= firstIndex + 2) {
        throw new Error(laterCount ? 'Codex later hook state requires reindexing; refusing uninstall'
          : 'Codex stale positional hook state is ambiguous');
      } else if (index === firstIndex || index === firstIndex + 1) {
        throw new Error('Codex managed hook state has unexpected hook index');
      }
    }
  }
  result += suffix.slice(cursor);
  return { text: result, removed };
}
function codexAfter(before, file) {
  if (before === null) return { after: null, removed: 0, stateTablesPreserved: 0 };
  const text = utf8(before, file);
  const starts = markerLines(text, BEGIN);
  const ends = markerLines(text, END);
  if (starts.length === 0 && ends.length === 0) {
    if (text.includes(BEGIN) || text.includes(END) || text.includes(BRIDGE_NAME)) {
      throw new Error('unmarked or malformed Codex write-protection hook present');
    }
    return { after: before, removed: 0, stateTablesPreserved: 0 };
  }
  if (starts.length !== 1 || ends.length !== 1 || starts[0].index >= ends[0].index
    || text.slice(0, starts[0].index).includes(BEGIN)
    || text.slice(ends[0].index + ends[0][0].length).includes(END)) {
    throw new Error('Codex managed hook markers are malformed or duplicated');
  }
  const start = starts[0].index;
  const end = ends[0].index;
  const prefix = text.slice(0, start);
  const body = text.slice(start, end);
  const suffix = body.slice(consumeCore(body, codexCore()));
  const endLine = end + ends[0][0].length;
  const endNewline = text.slice(endLine, endLine + 2) === '\r\n' ? 2
    : text[endLine] === '\n' ? 1 : 0;
  const post = text.slice(endLine + endNewline);
  if (prefix.includes(BRIDGE_NAME) || suffix.includes(BRIDGE_NAME) || post.includes(BRIDGE_NAME)
    || suffix.includes(BEGIN) || suffix.includes(END)) {
    throw new Error('unmarked or duplicate Codex write-protection hook present');
  }
  const info = appSuffixInfo(suffix);
  const firstIndex = preToolUseCount(prefix);
  const laterCount = preToolUseCount(post);
  for (const key of stateKeys(prefix).concat(stateKeys(post))) {
    if (!key.startsWith(`${file}:pre_tool_use:`)) continue;
    const record = /^(\d+):(\d+)$/.exec(key.slice(`${file}:pre_tool_use:`.length));
    if (!record || Number(record[1]) >= firstIndex) {
      throw new Error('Codex positional hook state outside marked block is ambiguous');
    }
  }
  const postFirst = substantiveFirst(post);
  if (postFirst && !isTable(postFirst)) {
    throw new Error('Codex keys after managed block would change table ownership');
  }
  const state = removeOwnedState(suffix, file, firstIndex, laterCount);
  return { after: Buffer.from(prefix + state.text + post), removed: 2,
    stateTablesPreserved: info.stateTables - state.removed,
    stateTablesRemoved: state.removed };
}

function plan() {
  const changes = [];
  for (const client of ['claude', 'codex']) {
    const file = settingsFile(client);
    const before = read(file);
    const result = client === 'claude' ? claudeAfter(before, file) : codexAfter(before, file);
    if (!same(before, result.after)) changes.push({ client, file, before, after: result.after,
      removed: result.removed, stateTablesPreserved: result.stateTablesPreserved || 0,
      stateTablesRemoved: result.stateTablesRemoved || 0 });
  }
  return changes;
}
function writeAtomic(file, bytes, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  fs.writeFileSync(tmp, bytes, { flag: 'wx', mode });
  try {
    try { fs.renameSync(tmp, file); }
    catch (error) {
      if (!['EEXIST', 'EPERM', 'EACCES'].includes(error.code) || read(file) === null) throw error;
      fs.copyFileSync(tmp, file);
      fs.rmSync(tmp, { force: true });
    }
  } finally { try { fs.rmSync(tmp, { force: true }); } catch {} }
}
function replace(file, bytes) {
  if (bytes === null) { fs.rmSync(file, { force: true }); return; }
  const mode = fs.existsSync(file) ? fs.statSync(file).mode & 0o777 : 0o600;
  writeAtomic(file, bytes, mode);
}
function summary(changes) {
  return changes.map(({ client, file, before, after, removed, stateTablesPreserved, stateTablesRemoved }) => ({
    client, file, removed, beforeHash: sha(before), afterHash: sha(after),
    stateTablesPreserved, stateTablesRemoved,
  }));
}
function uninstall(apply = false) {
  const changes = plan(); // validate both clients before writing either one
  const result = { mode: apply ? 'applied' : 'dry-run', changes: summary(changes) };
  if (!apply || changes.length === 0) return result;
  const dir = backupDir();
  assertOutsideCheckout(dir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  assertOutsideCheckout(fs.realpathSync(dir));
  const id = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
  const backupFile = path.join(dir, `${id}.json`);
  const manifest = { version: 1, id, createdAt: new Date().toISOString(),
    files: changes.map(({ client, file, before, after }) => ({
      client, file, before: before === null ? null : before.toString('base64'),
      beforeHash: sha(before), afterHash: sha(after),
    })) };
  writeAtomic(backupFile, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`), 0o600);
  result.backupFile = backupFile;
  for (const change of changes) {
    if (!same(read(change.file), change.before)) throw new Error(`settings changed during uninstall: ${change.file}; backup: ${backupFile}`);
  }
  const attempted = [];
  try {
    for (const change of changes) {
      attempted.push(change);
      replace(change.file, change.after);
      if (!same(read(change.file), change.after)) throw new Error(`write verification failed: ${change.file}`);
    }
    writeAtomic(path.join(dir, 'latest'), Buffer.from(id), 0o600);
  } catch (error) {
    const drifted = [];
    for (const change of attempted.reverse()) {
      if (same(read(change.file), change.after)) replace(change.file, change.before);
      else if (same(read(change.file), change.before)) continue;
      else drifted.push(change.file);
    }
    if (drifted.length) throw new Error(`${error.message}; partial or drifted settings need manual recovery: ${drifted.join(', ')}; backup: ${backupFile}`);
    throw new Error(`${error.message}; unchanged settings restored; backup: ${backupFile}`);
  }
  return result;
}
function restore(apply = false, requestedId = null) {
  const dir = backupDir();
  assertOutsideCheckout(dir);
  if (fs.existsSync(dir)) assertOutsideCheckout(fs.realpathSync(dir));
  const id = requestedId || read(path.join(dir, 'latest'))?.toString('utf8').trim();
  if (!id || !/^\d+-[0-9a-f]{12}$/.test(id)) throw new Error('no valid uninstall backup id available');
  const backupFile = path.join(dir, `${id}.json`);
  const bytes = read(backupFile);
  if (!bytes) throw new Error(`uninstall backup missing: ${backupFile}`);
  let manifest;
  try { manifest = JSON.parse(utf8(bytes, backupFile)); }
  catch { throw new Error(`uninstall backup malformed: ${backupFile}`); }
  if (manifest.version !== 1 || manifest.id !== id || !Array.isArray(manifest.files)
    || manifest.files.length < 1 || manifest.files.length > 2) throw new Error('uninstall backup has invalid shape');
  const seen = new Set();
  const changes = manifest.files.map((item) => {
    if (!['claude', 'codex'].includes(item.client) || seen.has(item.client)
      || item.file !== settingsFile(item.client)) throw new Error('uninstall backup targets unexpected settings');
    seen.add(item.client);
    const before = item.before === null ? null : Buffer.from(item.before, 'base64');
    if (sha(before) !== item.beforeHash || !/^[0-9a-f]{64}$/.test(item.afterHash)) {
      throw new Error('uninstall backup hash mismatch');
    }
    const after = read(item.file);
    if (sha(after) !== item.afterHash) throw new Error(`refusing restore because ${item.file} changed after uninstall`);
    return { client: item.client, file: item.file, before, after };
  });
  const result = { mode: apply ? 'restored' : 'dry-run', backupFile,
    changes: changes.map(({ client, file, before, after }) => ({
      client, file, beforeHash: sha(after), afterHash: sha(before),
    })) };
  if (!apply) return result;
  for (const change of changes) {
    if (!same(read(change.file), change.after)) throw new Error(`settings changed during restore: ${change.file}`);
  }
  const attempted = [];
  try {
    for (const change of changes) {
      attempted.push(change);
      replace(change.file, change.before);
      if (!same(read(change.file), change.before)) throw new Error(`restore verification failed: ${change.file}`);
    }
  } catch (error) {
    const drifted = [];
    for (const change of attempted.reverse()) {
      if (same(read(change.file), change.before)) replace(change.file, change.after);
      else if (same(read(change.file), change.after)) continue;
      else drifted.push(change.file);
    }
    if (drifted.length) throw new Error(`${error.message}; partial or drifted settings need manual recovery: ${drifted.join(', ')}`);
    throw new Error(`${error.message}; uninstalled settings restored`);
  }
  return result;
}
function run(argv, io = { out: console.log, err: console.error }) {
  try {
    let action = 'uninstall';
    let apply = false;
    let json = false;
    let backupId = null;
    for (let i = 0; i < argv.length; i += 1) {
      const arg = argv[i];
      if (arg === 'uninstall' || arg === 'restore') action = arg;
      else if (arg === '--apply') apply = true;
      else if (arg === '--json') json = true;
      else if (arg === '--backup' && i + 1 < argv.length) backupId = argv[++i];
      else throw new Error('usage: uninstall-write-protection.js [uninstall|restore] [--apply] [--json] [--backup ID]');
    }
    if (backupId && action !== 'restore') throw new Error('--backup is only valid with restore');
    const result = action === 'restore' ? restore(apply, backupId) : uninstall(apply);
    io.out(json ? JSON.stringify(result) : JSON.stringify(result, null, 2));
    return 0;
  } catch (error) { io.err(`uninstall-write-protection: ${error.message}`); return 2; }
}

if (require.main === module) process.exit(run(process.argv.slice(2)));
module.exports = { run, plan, uninstall, restore, claudeAfter, codexAfter, settingsFile, backupDir, command };
