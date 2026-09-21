#!/usr/bin/env node
// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// The host side of pipeline-first write protection: what a person runs, and what the
// pipeline's own stages call (DESIGN.md §3.2, §3.4, §4.12, §6.2; change-log row `repo-324`).
//
//   install / status / uninstall   the client hooks, for Claude and for Codex
//   lease --grant                  host-owned authority for one role, one target, one run
//   allow-writes / revoke          the one explicit, user-authorized way out, and its undo
//   admit                          the backstop: may this checkout be mutated right now?
//   recover                        a Git-registered home for edits admission refused
//
// TWO THINGS THIS DELIBERATELY DOES NOT DO. It never edits the checkout it is asked about —
// not to clean it, not to stash it, not to "help". A refusal that moved a person's
// uncommitted work would be the failure it exists to prevent, arrived at from the other
// side. And it never claims enforcement it does not have: `status` reports a client whose
// hooks are locally mutable, disabled, malformed or partly matched as exactly that, because
// a security control that overstates itself is worse than one that is honestly partial.
//
// Host seams (all three name directories OUTSIDE any repository):
//   WRITE_PROTECTION_HOST_STATE_DIR   leases and opt-out records
//   WRITE_PROTECTION_CLAUDE_DIR       the Claude client configuration directory
//   WRITE_PROTECTION_CODEX_DIR        the Codex client configuration directory
//   WRITE_PROTECTION_MANAGED          set when local client policy is centrally managed and
//                                     therefore not disableable by whoever is sitting here
//
// Checks: `node tests/acceptance/repo-324/test.js`.
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const policy = require('./write-protection-policy');

const ROOT = path.resolve(__dirname, '..');
const PAYLOAD = ['scripts/write-guard.js', 'scripts/write-guard-bridge.js',
  'scripts/write-protection-policy.js', 'contracts/write-protection.json'];
const HOOK_DIR = path.join('hooks', 'write-protection');
const SIGIL = 'write-guard-bridge.js';
const CODEX_BEGIN = '# BEGIN WRITE PROTECTION (multi-agent-pipelines)';
const CODEX_END = '# END WRITE PROTECTION (multi-agent-pipelines)';
const REVIEW_DIR = 'reviews';

const EXIT_OK = 0;
const EXIT_REFUSED = 1;
const EXIT_USAGE = 2;

const USAGE = [
  'usage:',
  '  node scripts/write-protection.js status [--json]',
  '  node scripts/write-protection.js install [--json]',
  '  node scripts/write-protection.js uninstall [--json]',
  '  node scripts/write-protection.js review --client codex [--json]',
  '  node scripts/write-protection.js lease --grant --target <dir> --role <role>',
  '        [--issue <id>] [--run <id>] [--workspace <dir>] [--pid <n>] [--minutes <n>] [--json]',
  '  node scripts/write-protection.js allow-writes --target <dir> --session <id> [--minutes <n>] [--json]',
  '  node scripts/write-protection.js revoke --target <dir> --session <id> [--json]',
  '  node scripts/write-protection.js admit --target <dir> [--issue <id>]... [--json]',
  '  node scripts/write-protection.js recover --target <dir> [--issue <id>]... [--json]',
].join('\n');

// ---- arguments -----------------------------------------------------------------------------

const VALUE_FLAGS = new Set(['--target', '--role', '--issue', '--run', '--workspace', '--pid',
  '--minutes', '--session', '--client']);
const BARE_FLAGS = new Set(['--json', '--grant']);

function parseArgs(argv) {
  const opts = { positional: [], issues: [], json: false, grant: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (VALUE_FLAGS.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) return { error: `${arg} needs a value` };
      if (arg === '--issue') opts.issues.push(value);
      else opts[arg.slice(2)] = value;
      i += 1;
      continue;
    }
    if (BARE_FLAGS.has(arg)) { opts[arg.slice(2)] = true; continue; }
    if (arg.startsWith('--')) return { error: `unknown option ${arg}` };
    opts.positional.push(arg);
  }
  return { opts };
}

// ---- host records ---------------------------------------------------------------------------

function recordDir(kind) {
  const dir = path.join(policy.hostStateDir(), kind);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// One file per record, written once and never rewritten. A shared index would mean granting
// authority for one target rewrote a file that describes another, which is exactly what must
// not happen while other projects have runs in flight.
function writeRecord(kind, name, value) {
  const file = path.join(recordDir(kind), `${name}.json`);
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return file;
}

function slug(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
}

function minutesFrom(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function grantLease(opts, out, err) {
  if (!opts.target) { err('write-protection: lease --grant needs --target'); return EXIT_USAGE; }
  if (!opts.role) { err('write-protection: lease --grant needs --role'); return EXIT_USAGE; }
  const roles = policy.contract().roles || {};
  if (!Object.prototype.hasOwnProperty.call(roles, opts.role)) {
    err(`write-protection: unknown role ${opts.role}`);
    return EXIT_USAGE;
  }
  const target = policy.canonical(opts.target);
  const place = policy.locate(target);
  if (!place || !place.commonDir) {
    err(`write-protection: ${opts.target} is not a Git checkout, so nothing can be leased over it`);
    return EXIT_USAGE;
  }
  const pid = Number.isInteger(Number(opts.pid)) ? Number(opts.pid) : process.pid;
  const minutes = minutesFrom(opts.minutes, 60);
  const leaseId = `${slug(opts.role)}-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
  const record = {
    version: policy.contract().version,
    leaseId,
    target,
    gitCommonDir: policy.canonical(place.commonDir),
    role: String(opts.role),
    issueId: opts.issues[0] || opts.issue || null,
    runId: opts.run || null,
    workspace: opts.workspace ? policy.canonical(opts.workspace) : null,
    controllerPid: pid,
    controllerStart: policy.startIdentity(pid),
    pathClasses: Array.isArray(roles[opts.role].pathClasses) ? roles[opts.role].pathClasses : [],
    expiresAt: new Date(Date.now() + minutes * 60000).toISOString(),
    token: crypto.randomBytes(36).toString('base64url'),
  };
  const file = writeRecord(policy.LEASE_DIR, leaseId, record);
  const answer = {
    leaseId, token: record.token, file, role: record.role, target,
    expiresAt: record.expiresAt,
  };
  if (opts.json) out(JSON.stringify(answer));
  else {
    out(`lease ${leaseId} for ${record.role} on ${target}`);
    out(`record  ${file}`);
    out(`expires ${record.expiresAt}`);
  }
  return EXIT_OK;
}

function allowWrites(opts, out, err) {
  if (!opts.target) { err('write-protection: allow-writes needs --target'); return EXIT_USAGE; }
  if (!opts.session) { err('write-protection: allow-writes needs --session'); return EXIT_USAGE; }
  const target = policy.canonical(opts.target);
  const minutes = minutesFrom(opts.minutes, 60);
  const key = crypto.createHash('sha256').update(`${target}\0${opts.session}`).digest('hex').slice(0, 16);
  const record = {
    version: policy.contract().version,
    target,
    session: String(opts.session),
    grantedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + minutes * 60000).toISOString(),
  };
  const file = writeRecord(policy.OPTOUT_DIR, `${slug(path.basename(target))}-${key}`, record);
  if (opts.json) out(JSON.stringify({ ...record, file }));
  else {
    out(`session ${record.session} may write ${target} until ${record.expiresAt}`);
    out(`record ${file}`);
    out(`revoke with: node scripts/write-protection.js revoke --target ${target} --session ${record.session}`);
  }
  return EXIT_OK;
}

function revoke(opts, out, err) {
  if (!opts.target) { err('write-protection: revoke needs --target'); return EXIT_USAGE; }
  if (!opts.session) { err('write-protection: revoke needs --session'); return EXIT_USAGE; }
  const target = policy.canonical(opts.target);
  let removed = 0;
  for (const { file, record } of policy.readRecords(policy.OPTOUT_DIR)) {
    if (!record) continue;
    if (String(record.session) !== String(opts.session)) continue;
    if (policy.canonical(record.target || '') !== target) continue;
    try { fs.rmSync(file); removed += 1; } catch { /* already gone is the outcome asked for */ }
  }
  if (opts.json) out(JSON.stringify({ revoked: removed, target, session: String(opts.session) }));
  else out(`revoked ${removed} opt-out record(s) for ${opts.session} on ${target}`);
  return EXIT_OK;
}

// ---- clients ---------------------------------------------------------------------------------

function clientDir(name) {
  const explicit = String(process.env[`WRITE_PROTECTION_${name.toUpperCase()}_DIR`] || '').trim();
  if (explicit) return path.resolve(explicit);
  return path.join(os.homedir(), name === 'claude' ? '.claude' : '.codex');
}

function payloadPaths(dir) {
  const base = path.join(dir, HOOK_DIR);
  return {
    base,
    bridge: path.join(base, 'scripts', 'write-guard-bridge.js'),
    files: PAYLOAD.map((rel) => path.join(base, ...rel.split('/'))),
  };
}

function installPayload(dir) {
  const { base, bridge } = payloadPaths(dir);
  for (const rel of PAYLOAD) {
    const from = path.join(ROOT, ...rel.split('/'));
    const to = path.join(base, ...rel.split('/'));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
  return bridge;
}

function removePayload(dir) {
  const { base } = payloadPaths(dir);
  try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* best effort */ }
}

function payloadComplete(dir) {
  return payloadPaths(dir).files.every((f) => fs.existsSync(f));
}

const posix = (p) => p.split(path.sep).join('/');

// ---- the Claude client -------------------------------------------------------------------------

function claudeSettingsFile(dir) { return path.join(dir, 'settings.json'); }

function readClaude(dir) {
  const file = claudeSettingsFile(dir);
  if (!fs.existsSync(file)) return { file, settings: {}, missing: true };
  const raw = fs.readFileSync(file, 'utf8');
  if (!raw.trim()) return { file, settings: {}, missing: true };
  try { return { file, settings: JSON.parse(raw) }; }
  catch (e) { return { file, settings: null, malformed: String(e.message) }; }
}

function ourClaudeGroups(settings) {
  const groups = (settings && settings.hooks && Array.isArray(settings.hooks.PreToolUse))
    ? settings.hooks.PreToolUse : [];
  return groups.filter((g) => g && Array.isArray(g.hooks)
    && g.hooks.some((h) => h && String(h.command || '').includes(SIGIL)));
}

function matcherCovers(matcher, tools) {
  const raw = String(matcher === undefined || matcher === null ? '' : matcher).trim();
  if (!raw || raw === '*') return true;
  let re;
  try { re = new RegExp(`^(?:${raw})$`); } catch { return false; }
  return tools.every((t) => re.test(t));
}

function stripClaude(settings) {
  let removed = 0;
  const hooks = settings && settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : null;
  if (!hooks || !Array.isArray(hooks.PreToolUse)) return { settings, removed };
  hooks.PreToolUse = hooks.PreToolUse.map((group) => {
    if (!group || !Array.isArray(group.hooks)) return group;
    const kept = group.hooks.filter((h) => {
      const ours = h && typeof h.command === 'string' && h.command.includes(SIGIL);
      if (ours) removed += 1;
      return !ours;
    });
    return { ...group, hooks: kept };
  }).filter((group) => !group || !Array.isArray(group.hooks) || group.hooks.length > 0);
  if (hooks.PreToolUse.length === 0) delete hooks.PreToolUse;
  if (Object.keys(hooks).length === 0) delete settings.hooks;
  return { settings, removed };
}

function installClaude(dir) {
  const tools = policy.contract().clients.claude.toolPaths;
  const bridge = installPayload(dir);
  const read = readClaude(dir);
  if (read.settings === null) {
    return { ok: false, error: `${read.file} is not valid JSON (${read.malformed}) — fix or move it, then re-run` };
  }
  const { settings } = stripClaude(read.settings);
  if (!settings.hooks || typeof settings.hooks !== 'object') settings.hooks = {};
  if (!Array.isArray(settings.hooks.PreToolUse)) settings.hooks.PreToolUse = [];
  settings.hooks.PreToolUse.push({
    matcher: tools.join('|'),
    hooks: [{ type: 'command', command: `node "${posix(bridge)}" --client claude` }],
  });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(read.file, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  return { ok: true, file: read.file };
}

function uninstallClaude(dir) {
  const read = readClaude(dir);
  if (read.settings === null) {
    removePayload(dir);
    return { ok: false, error: `${read.file} is not valid JSON — our hook entry was left alone` };
  }
  const { settings, removed } = stripClaude(read.settings);
  if (!read.missing) fs.writeFileSync(read.file, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  removePayload(dir);
  return { ok: true, removed };
}

function claudeState(dir) {
  const tools = policy.contract().clients.claude.toolPaths;
  let stat = null;
  try { stat = fs.statSync(dir); } catch { stat = null; }
  if (stat && !stat.isDirectory()) {
    return { state: 'unsupported', detail: `${dir} is not a directory` };
  }
  const read = readClaude(dir);
  if (read.settings === null) {
    return { state: 'degraded', detail: `${read.file} is not valid JSON, so what it configures cannot be read` };
  }
  const groups = ourClaudeGroups(read.settings);
  if (!groups.length) return { state: 'uninstalled', detail: `no hook entry in ${read.file}` };
  if (!payloadComplete(dir)) {
    return { state: 'degraded', detail: `the hook is configured but ${payloadPaths(dir).base} is incomplete` };
  }
  const uncovered = tools.filter((t) => !groups.some((g) => matcherCovers(g.matcher, [t])));
  if (uncovered.length) {
    return { state: 'degraded', detail: `no matcher covers ${uncovered.join(', ')}` };
  }
  return { state: 'enforced', detail: `${read.file}` };
}

// ---- a small TOML reader, enough of it and no more ----------------------------------------
//
// Codex's own config.toml is read here rather than detected by a sentinel string, because a
// sentinel only proves a block we wrote is textually present — not that Codex parsed it, or
// parsed it into the shape we think it did (`repo-gy3`, `repo-ak5`). This reads just enough of
// the TOML grammar to answer the structural questions §C0/§C3 ask: table paths, array-of-
// tables nesting, string/array/bool/number values, and comments.

function tomlStripComment(line) {
  let out = '';
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) {
      out += ch;
      if (ch === '\\' && quote === '"') { out += line[i + 1] || ''; i += 1; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; out += ch; continue; }
    if (ch === '#') break;
    out += ch;
  }
  return out;
}

function tomlBracketDepth(s) {
  let depth = 0;
  let quote = null;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (quote) {
      if (ch === '\\' && quote === '"') { i += 1; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '[' || ch === '{') depth += 1;
    else if (ch === ']' || ch === '}') depth -= 1;
  }
  return depth;
}

function tomlLogicalLines(text) {
  const raw = String(text || '').split(/\r?\n/).map(tomlStripComment);
  const out = [];
  for (let i = 0; i < raw.length; i += 1) {
    let line = raw[i].trim();
    if (!line) continue;
    while (tomlBracketDepth(line) > 0 && i + 1 < raw.length) { i += 1; line += ` ${raw[i].trim()}`; }
    out.push(line);
  }
  return out;
}

function tomlSplitKeyPath(src) {
  const segs = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quote) { if (ch === quote) { quote = null; continue; } cur += ch; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '.') { segs.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  segs.push(cur.trim());
  return segs.filter((s) => s.length);
}

function tomlSplitAssign(line) {
  let quote = null;
  let depth = 0;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) {
      if (ch === '\\' && quote === '"') { i += 1; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '[' || ch === '{') depth += 1;
    else if (ch === ']' || ch === '}') depth -= 1;
    else if (ch === '=' && depth === 0) return [line.slice(0, i).trim(), line.slice(i + 1).trim()];
  }
  return null;
}

function tomlParseValue(src, start) {
  let i = start;
  while (i < src.length && /\s/.test(src[i])) i += 1;
  const ch = src[i];
  if (ch === '"' || ch === "'") {
    const quote = ch;
    let out = '';
    i += 1;
    while (i < src.length) {
      const c = src[i];
      if (quote === '"' && c === '\\') { const nxt = src[i + 1] || ''; out += nxt === 'n' ? '\n' : nxt; i += 2; continue; }
      if (c === quote) { i += 1; break; }
      out += c;
      i += 1;
    }
    return { value: out, i };
  }
  if (ch === '[') {
    const arr = [];
    i += 1;
    for (;;) {
      while (i < src.length && /[\s,]/.test(src[i])) i += 1;
      if (i >= src.length || src[i] === ']') { i += 1; break; }
      const r = tomlParseValue(src, i);
      arr.push(r.value);
      i = r.i;
    }
    return { value: arr, i };
  }
  let tok = '';
  while (i < src.length && !/[,\]}]/.test(src[i])) { tok += src[i]; i += 1; }
  tok = tok.trim();
  if (tok === 'true') return { value: true, i };
  if (tok === 'false') return { value: false, i };
  if (/^-?\d+$/.test(tok)) return { value: Number(tok), i };
  return { value: tok, i };
}

function tomlDescend(root, segs) {
  let node = root;
  for (const seg of segs) {
    if (!node[seg] || typeof node[seg] !== 'object') node[seg] = {};
    if (Array.isArray(node[seg])) {
      if (!node[seg].length) node[seg].push({});
      node = node[seg][node[seg].length - 1];
    } else node = node[seg];
  }
  return node;
}

function tomlAssignPath(table, segs, value) {
  if (!segs.length) return;
  const holder = tomlDescend(table, segs.slice(0, -1));
  holder[segs[segs.length - 1]] = value;
}

function parseTomlLite(text) {
  const root = {};
  let table = root;
  for (const line of tomlLogicalLines(text)) {
    const arrayHeader = /^\[\[(.+)\]\]$/.exec(line);
    const tableHeader = arrayHeader ? null : /^\[(.+)\]$/.exec(line);
    if (arrayHeader || tableHeader) {
      const segs = tomlSplitKeyPath((arrayHeader || tableHeader)[1].trim());
      if (!segs.length) { table = root; continue; }
      const holder = tomlDescend(root, segs.slice(0, -1));
      const last = segs[segs.length - 1];
      if (arrayHeader) {
        if (!Array.isArray(holder[last])) holder[last] = [];
        const fresh = {};
        holder[last].push(fresh);
        table = fresh;
      } else if (Array.isArray(holder[last])) {
        if (!holder[last].length) holder[last].push({});
        table = holder[last][holder[last].length - 1];
      } else {
        if (!holder[last] || typeof holder[last] !== 'object') holder[last] = {};
        table = holder[last];
      }
      continue;
    }
    const kv = tomlSplitAssign(line);
    if (!kv) continue;
    tomlAssignPath(table, tomlSplitKeyPath(kv[0]), tomlParseValue(kv[1], 0).value);
  }
  return root;
}

// A basic string left open past the end of its line is a real TOML parse error (this reader
// does not implement multi-line `"""` strings, which is a documented, deliberate limit —
// nothing this project installs ever needs one). Detected independently of `parseTomlLite`,
// which is lenient by construction, so a malformed file is reported as malformed rather than
// silently read as whatever the lenient parser happened to produce from it.
function tomlQuoteIssues(text) {
  const issues = [];
  const lines = String(text || '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const stripped = tomlStripComment(lines[i]);
    let count = 0;
    for (let j = 0; j < stripped.length; j += 1) {
      const ch = stripped[j];
      if (ch === '\\') { j += 1; continue; }
      if (ch === '"' || ch === "'") count += 1;
    }
    if (count % 2 !== 0) issues.push(`line ${i + 1} carries an unterminated quoted string`);
  }
  return issues;
}

function parseCodexToml(text) {
  const issues = tomlQuoteIssues(text);
  let cfg = {};
  try { cfg = parseTomlLite(text); } catch (e) { issues.push(`could not be parsed (${e.message})`); }
  return { cfg, issues };
}

// ---- reading the parsed profile for OUR hook definitions ----------------------------------

const asTomlList = (v) => (Array.isArray(v) ? v : (v === undefined || v === null ? [] : [v]));

function preToolUseGroups(cfg) {
  const hooks = cfg && cfg.hooks;
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return [];
  return asTomlList(hooks.PreToolUse).filter((g) => g && typeof g === 'object' && !Array.isArray(g));
}

function nestedHandlers(group) {
  return asTomlList(group && group.hooks).filter((h) => h && typeof h === 'object' && !Array.isArray(h));
}

function tomlNormalizeArgv(value) {
  if (Array.isArray(value)) return value.map(String).filter((s) => s.length);
  const one = String(value === undefined || value === null ? '' : value).trim();
  if (!one) return [];
  return (one.match(/"[^"]*"|'[^']*'|\S+/g) || []).map((t) => t.replace(/^["']|["']$/g, ''));
}

function effectiveCommandValue(handler) {
  const win = handler && handler.command_windows;
  const gen = handler && handler.command;
  if (process.platform === 'win32' && win !== undefined) return win;
  return gen !== undefined ? gen : win;
}

function carriesClientIdentity(argv, client) {
  return argv.some((a, i) => a === '--client' && argv[i + 1] === client);
}

function samePath(a, b) {
  return posix(path.resolve(String(a))).toLowerCase() === posix(path.resolve(String(b))).toLowerCase();
}

function argvNamesBridge(argv, bridge) {
  return argv.some((a) => samePath(a, bridge));
}

// A handler counts as OURS, effective and codex-identified only when every one of these
// holds — this is also exactly what a `[[hooks.PreToolUse.hooks]]` handler must be for the
// review digest to bind it. A direct matcher-level command, a missing `type`, an argv-array
// command, a handler naming a different file and a missing `--client codex` flag all fail
// this and therefore read as "not effectively installed" rather than crash anything.
function codexHandlerValid(handler, bridge) {
  if (!handler || String(handler.type || '') !== 'command') return false;
  const value = effectiveCommandValue(handler);
  if (typeof value !== 'string' || !value.trim()) return false;
  const argv = tomlNormalizeArgv(value);
  return argvNamesBridge(argv, bridge) && carriesClientIdentity(argv, 'codex');
}

function codexCoverage(cfg, bridge, tools) {
  const groups = preToolUseGroups(cfg);
  const out = {};
  for (const tool of tools) {
    const literal = `^${tool}$`;
    const matching = groups.filter((g) => String(g.matcher === undefined || g.matcher === null ? '' : g.matcher).trim() === literal);
    out[tool] = matching.some((g) => nestedHandlers(g).some((h) => codexHandlerValid(h, bridge)));
  }
  return out;
}

// Whether our bridge is mentioned ANYWHERE in the parsed profile — a top-level array-of-
// tables layout (the shape this project itself installed before this issue), someone else's
// copy, or a nested group missing one of the properties `codexHandlerValid` requires. This is
// what tells "nothing of ours here" (`uninstalled`) apart from "something of ours, but not
// effectively installed" (`degraded`) — the old layout must read as the latter, never the
// former, because it is still Codex configuration that runs our bridge.
function collectCommandValues(node, acc) {
  if (Array.isArray(node)) { for (const n of node) collectCommandValues(n, acc); return acc; }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === 'command' || k === 'command_windows') {
        if (typeof v === 'string' || Array.isArray(v)) acc.push(v);
      } else collectCommandValues(v, acc);
    }
  }
  return acc;
}

function anyMentionsBridge(cfg, bridge) {
  return collectCommandValues(cfg, []).some((v) => argvNamesBridge(tomlNormalizeArgv(v), bridge));
}

function codexHooksDisabled(cfg, text) {
  if (/^\s*hooks\s*=\s*false\b/m.test(text)) return true;
  if (cfg && cfg.features && cfg.features.hooks === false) return true;
  if (cfg && cfg.hooks && typeof cfg.hooks === 'object' && !Array.isArray(cfg.hooks) && cfg.hooks.enabled === false) return true;
  return false;
}

// A digest over exactly the two things that make a Codex hook definition trustworthy: which
// tool path it matches and what command it runs. Bound to BOTH exact definitions, including
// client identity (`codexHandlerValid` already requires `--client codex`), so it changes the
// instant either handler's command changes and is silent about everything else in the file —
// an edit to an unrelated key never invalidates a review that already happened.
function reviewDigest(cfg, bridge, tools) {
  const groups = preToolUseGroups(cfg);
  const parts = [];
  for (const tool of tools) {
    const literal = `^${tool}$`;
    const matching = groups.filter((g) => String(g.matcher === undefined || g.matcher === null ? '' : g.matcher).trim() === literal);
    const handler = matching.flatMap((g) => nestedHandlers(g)).find((h) => codexHandlerValid(h, bridge));
    if (!handler) return null;
    parts.push(`${tool}::${effectiveCommandValue(handler)}`);
  }
  return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

function reviewRecordFile(client) {
  return path.join(recordDir(REVIEW_DIR), `${slug(client)}.json`);
}

function readReview(client) {
  try { return JSON.parse(fs.readFileSync(reviewRecordFile(client), 'utf8')); }
  catch { return null; }
}

// ---- the Codex client ---------------------------------------------------------------------------

function codexConfigFile(dir) { return path.join(dir, 'config.toml'); }

// The official inline shape: one `[[hooks.PreToolUse]]` array-of-tables entry per tool path
// this contract declares for Codex, each immediately followed by its own nested
// `[[hooks.PreToolUse.hooks]]` handler — written as HEADER tables, never an inline
// `hooks = [{...}]` array, and with `command` a TOML STRING. Codex's own loader rejects a
// sequence there with "invalid type: sequence, expected a string" and fails the whole
// profile, which is how PR #81 shipped a status that said `enforced` while dispatching
// nothing (`repo-gy3`). `--client codex` is what lets the bridge tell this invocation apart
// from Claude's, now that both send `Bash` as a plain string.
function codexHookGroup(tool, bridge) {
  const command = `node "${posix(bridge)}" --client codex`;
  return [
    '[[hooks.PreToolUse]]',
    `matcher = ${JSON.stringify(`^${tool}$`)}`,
    '',
    '[[hooks.PreToolUse.hooks]]',
    'type = "command"',
    `command = ${JSON.stringify(command)}`,
  ].join('\n');
}

function codexBlock(bridge) {
  const tools = policy.contract().clients.codex.toolPaths;
  return [
    CODEX_BEGIN,
    '# Installed by node scripts/write-protection.js install — remove with `uninstall`.',
    '# Activation is not trust: Codex will not treat this hook as authoritative until a',
    '# person reviews it with the interactive `/hooks` command, then records that with',
    '# `node scripts/write-protection.js review --client codex`.',
    tools.map((tool) => codexHookGroup(tool, bridge)).join('\n\n'),
    CODEX_END,
  ].join('\n');
}

function stripCodex(text) {
  const start = text.indexOf(CODEX_BEGIN);
  if (start === -1) return { text, removed: 0 };
  const end = text.indexOf(CODEX_END, start);
  if (end === -1) return { text: text.slice(0, start), removed: 1 };
  const after = end + CODEX_END.length;
  return { text: `${text.slice(0, start)}${text.slice(after).replace(/^\r?\n/, '')}`, removed: 1 };
}

function readCodex(dir) {
  const file = codexConfigFile(dir);
  let text = null;
  try { text = fs.readFileSync(file, 'utf8'); } catch { text = null; }
  return { file, text };
}

function installCodex(dir) {
  const bridge = installPayload(dir);
  const { file, text } = readCodex(dir);
  const base = stripCodex(text === null ? '' : text).text;
  const joined = base && !base.endsWith('\n') ? `${base}\n` : base;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, `${joined}${joined ? '\n' : ''}${codexBlock(bridge)}\n`, 'utf8');
  return { ok: true, file };
}

function uninstallCodex(dir) {
  const { file, text } = readCodex(dir);
  if (text !== null) {
    const stripped = stripCodex(text);
    fs.writeFileSync(file, stripped.text, 'utf8');
  }
  removePayload(dir);
  return { ok: true };
}

function codexState(dir) {
  let stat = null;
  try { stat = fs.statSync(dir); } catch { stat = null; }
  if (stat && !stat.isDirectory()) return { state: 'unsupported', detail: `${dir} is not a directory` };

  const { file, text } = readCodex(dir);
  if (text === null) return { state: 'uninstalled', detail: `no ${file}` };

  const { cfg, issues } = parseCodexToml(text);

  // Switched off at the client wins over everything else: a config that turns hooks off has
  // turned OURS off too, whether or not the entry is still written down in it.
  if (codexHooksDisabled(cfg, text)) {
    return { state: 'disabled', detail: `${file} turns hooks off, so no hook of ours runs` };
  }

  const bridge = payloadPaths(dir).bridge;
  if (!anyMentionsBridge(cfg, bridge) && !text.includes(CODEX_BEGIN)) {
    return { state: 'uninstalled', detail: `no hook entry in ${file}` };
  }

  if (issues.length) {
    return { state: 'degraded', detail: `${file} is malformed: ${issues[0]}` };
  }
  if (!payloadComplete(dir)) {
    return { state: 'degraded', detail: `the hook is configured but ${payloadPaths(dir).base} is incomplete` };
  }

  const tools = policy.contract().clients.codex.toolPaths;
  const coverage = codexCoverage(cfg, bridge, tools);
  const uncovered = tools.filter((t) => !coverage[t]);
  if (uncovered.length) {
    return {
      state: 'degraded',
      detail: `no effective nested \`[[hooks.PreToolUse.hooks]]\` handler names this exact `
        + `bridge with an explicit Codex client identity for ${uncovered.join(', ')}`,
    };
  }

  if (managedPolicy()) return { state: 'enforced', detail: `${file} (centrally managed policy)` };

  const digest = reviewDigest(cfg, bridge, tools);
  const record = readReview('codex');
  if (digest && record && record.digest === digest) {
    return { state: 'enforced', detail: `${file} (reviewed ${record.reviewedAt})` };
  }
  return {
    state: 'untrusted',
    detail: `${file} is correctly configured but has not been interactively reviewed — run `
      + '`/hooks` in a Codex session to trust both exact definitions, then '
      + '`node scripts/write-protection.js review --client codex`',
  };
}

// ---- status ----------------------------------------------------------------------------------

// Centrally managed client policy is the ONLY configuration in which a local session cannot
// turn these hooks off, and therefore the only one in which "complete" would be true.
function managedPolicy() {
  const raw = String(process.env.WRITE_PROTECTION_MANAGED || '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(raw);
}

function status(opts, out) {
  const dirs = { claude: clientDir('claude'), codex: clientDir('codex') };
  const clients = {
    claude: { ...claudeState(dirs.claude), configDir: dirs.claude },
    codex: { ...codexState(dirs.codex), configDir: dirs.codex },
  };
  const limitations = [];
  for (const [name, info] of Object.entries(clients)) {
    if (info.state !== 'enforced') limitations.push(`${name}: ${info.state} — ${info.detail}`);
  }
  if (!managedPolicy()) {
    limitations.push('claude: this hook is configured in a file on this host, so whoever is sitting '
      + 'here can disable it; hooks are prevention, not a perimeter.');
    limitations.push('codex: the same — its hook lives in config.toml, which a session can rewrite. '
      + 'Organizations needing non-disableable local policy should install these hooks through '
      + 'centrally managed configuration (docs/control-plane.md).');
  }
  limitations.push('every client: a tool path no installed matcher covers is not guarded at all, '
    + 'which is why admission runs again over the real checkout before a freeze, a preparation '
    + 'or a dispatch mutates it.');

  const enforcementComplete = managedPolicy()
    && Object.values(clients).every((c) => c.state === 'enforced');

  const optOuts = policy.readRecords(policy.OPTOUT_DIR)
    .map(({ file, record }) => record && ({
      target: record.target, session: record.session, expiresAt: record.expiresAt,
      live: policy.notExpired(record.expiresAt), file,
    }))
    .filter(Boolean);
  const leases = policy.readRecords(policy.LEASE_DIR)
    .map(({ file, record }) => record && ({
      leaseId: record.leaseId, role: record.role, target: record.target,
      issueId: record.issueId, runId: record.runId, expiresAt: record.expiresAt,
      live: policy.notExpired(record.expiresAt) && policy.pidAlive(Number(record.controllerPid)),
      file,
    }))
    .filter(Boolean);

  const answer = {
    contract: policy.contractFile,
    hostState: policy.hostStateDir(),
    clients,
    enforcementComplete,
    managedPolicy: managedPolicy(),
    limitations,
    optOuts,
    leases,
  };
  if (opts.json) { out(JSON.stringify(answer)); return EXIT_OK; }

  out(`contract   : ${answer.contract}`);
  out(`host state : ${answer.hostState}`);
  for (const [name, info] of Object.entries(clients)) {
    out(`${name.padEnd(11)}: ${info.state}  (${info.detail})`);
  }
  out(`enforcement complete: ${enforcementComplete ? 'yes' : 'no'}`);
  for (const line of limitations) out(`  - ${line}`);
  for (const grant of optOuts) {
    out(`opt-out    : session ${grant.session} on ${grant.target} until ${grant.expiresAt}`
      + `${grant.live ? '' : ' (expired)'}`);
  }
  for (const lease of leases) {
    out(`lease      : ${lease.role} on ${lease.target} until ${lease.expiresAt}${lease.live ? '' : ' (dead)'}`);
  }
  return EXIT_OK;
}

function install(opts, out, err) {
  const dirs = { claude: clientDir('claude'), codex: clientDir('codex') };
  const results = {};
  let failed = false;
  for (const [name, dir] of Object.entries(dirs)) {
    const r = name === 'claude' ? installClaude(dir) : installCodex(dir);
    results[name] = r;
    if (!r.ok) { failed = true; err(`write-protection: ${name}: ${r.error}`); }
  }
  if (opts.json) out(JSON.stringify({ installed: !failed, clients: results }));
  else {
    for (const [name, dir] of Object.entries(dirs)) {
      out(`${name}: ${results[name].ok ? `hook installed in ${dir}` : results[name].error}`);
    }
    out('Active in sessions started from now on. Check it with:');
    out('  node scripts/write-protection.js status');
    out('');
    out('Activation is not trust. A non-managed Codex client will not treat a freshly');
    out('installed hook as authoritative until a person reviews it: run the interactive');
    out('`/hooks` command in a Codex session, confirm both installed definitions, then');
    out('record that with:');
    out('  node scripts/write-protection.js review --client codex');
  }
  return failed ? EXIT_REFUSED : EXIT_OK;
}

function reviewCommand(opts, out, err) {
  if (opts.client !== 'codex') {
    err(`write-protection: review --client ${opts.client || '<missing>'} is not supported `
      + '(only codex needs an interactive trust record right now)');
    return EXIT_USAGE;
  }
  const dir = clientDir('codex');
  const { text } = readCodex(dir);
  if (text === null) {
    err('write-protection: no Codex configuration is installed to review — run `install` first');
    return EXIT_REFUSED;
  }
  const { cfg, issues } = parseCodexToml(text);
  if (issues.length) {
    err(`write-protection: the installed Codex configuration is malformed (${issues[0]}) — fix it, `
      + 're-run `install`, then review again');
    return EXIT_REFUSED;
  }
  const bridge = payloadPaths(dir).bridge;
  const tools = policy.contract().clients.codex.toolPaths;
  const digest = reviewDigest(cfg, bridge, tools);
  if (!digest) {
    err('write-protection: the installed Codex configuration does not carry a complete, '
      + 'client-identified hook definition for every tool path — run `install` first');
    return EXIT_REFUSED;
  }
  const record = {
    version: policy.contract().version, client: 'codex', digest, reviewedAt: new Date().toISOString(),
  };
  const file = writeRecord(REVIEW_DIR, 'codex', record);
  if (opts.json) out(JSON.stringify({ reviewed: true, client: 'codex', digest, file }));
  else {
    out('recorded: a person has run the interactive `/hooks` review for the Codex hook');
    out(`definitions currently installed (${file})`);
    out('`status` will honour this until either installed definition changes.');
  }
  return EXIT_OK;
}

function uninstall(opts, out) {
  const dirs = { claude: clientDir('claude'), codex: clientDir('codex') };
  const results = {
    claude: uninstallClaude(dirs.claude),
    codex: uninstallCodex(dirs.codex),
  };
  if (opts.json) out(JSON.stringify({ uninstalled: true, clients: results }));
  else {
    out('claude: hook entry removed; every other entry in that file was left alone');
    out('codex: hook block removed; every other setting in that file was left alone');
    out('Sessions started from now on are no longer guarded by these hooks. Admission still refuses');
    out('a dirty protected checkout at freeze, preparation and dispatch.');
  }
  return EXIT_OK;
}

// ---- admission and recovery ------------------------------------------------------------------

function admit(opts, out, err) {
  if (!opts.target) { err('write-protection: admit needs --target'); return EXIT_USAGE; }
  const result = policy.admit(opts.target, { issues: opts.issues });
  if (opts.json) { out(JSON.stringify(result)); return result.admit ? EXIT_OK : EXIT_REFUSED; }
  if (result.admit) {
    out(`admitted: ${result.target}`);
    return EXIT_OK;
  }
  for (const line of policy.admissionRefusal(result, { label: result.target, issues: opts.issues })) {
    err(line);
  }
  return EXIT_REFUSED;
}

function git(root, args) {
  return spawnSync('git', args, {
    cwd: root, encoding: 'utf8', timeout: 120000, windowsHide: true, maxBuffer: 64 * 1024 * 1024,
  });
}

// A dedicated, Git-REGISTERED worktree, never a loose copy: registered means `git worktree
// list` can find it, `git status` inside it works, and the branch it sits on can be reviewed
// or merged like any other. The only thing this changes in the target is the worktree registry
// inside the Git common directory; the project files, the index, the working tree, HEAD and the
// stash stack are all left exactly as they were.
function recoveryHome(root, label) {
  const parent = path.dirname(root);
  const base = path.join(parent, `${path.basename(root)}-recovery`);
  for (let n = 1; n < 10000; n += 1) {
    const dir = path.join(base, `${label}-${n}`);
    const branch = `write-protection/recovery/${label}-${n}`;
    if (fs.existsSync(dir)) continue;
    const known = git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
    if (known.status === 0) continue;
    return { dir, branch };
  }
  return null;
}

function recover(opts, out, err) {
  if (!opts.target) { err('write-protection: recover needs --target'); return EXIT_USAGE; }
  const result = policy.admit(opts.target, { issues: opts.issues });
  const root = result.target;
  const place = policy.locate(root);
  if (!place) { err(`write-protection: ${opts.target} is not a Git checkout`); return EXIT_USAGE; }

  const label = slug(opts.issues[0] || 'session') || 'session';
  const home = recoveryHome(place.root, label);
  if (!home) { err('write-protection: could not find an unused recovery home'); return EXIT_REFUSED; }
  fs.mkdirSync(path.dirname(home.dir), { recursive: true });

  const added = git(place.root, ['worktree', 'add', '-b', home.branch, home.dir, 'HEAD']);
  if (added.status !== 0) {
    err(`write-protection: git worktree add failed — ${(added.stderr || '').trim()}`);
    return EXIT_REFUSED;
  }

  const metaDir = path.join(home.dir, '.write-protection-recovery');
  fs.mkdirSync(path.join(metaDir, 'patches'), { recursive: true });

  const entries = [];
  for (const refusal of result.refusals) {
    const rel = refusal.path;
    const from = path.join(place.root, ...rel.split('/'));
    const to = path.join(home.dir, ...rel.split('/'));
    const tracked = git(place.root, ['ls-files', '--error-unmatch', '--', rel]).status === 0;
    const entry = { path: rel, kind: tracked ? 'patch' : 'copy', state: refusal.state };
    if (tracked) {
      const diff = git(place.root, ['diff', 'HEAD', '--', rel]);
      const name = `${slug(rel) || 'entry'}.patch`;
      fs.writeFileSync(path.join(metaDir, 'patches', name), diff.stdout || '', 'utf8');
      entry.patch = `.write-protection-recovery/patches/${name}`;
    }
    // The bytes come across either way, so the recovery worktree IS the work, not a receipt
    // for it. The original is read and never touched.
    try {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
      entry.copy = rel;
    } catch { entry.copy = null; }
    entries.push(entry);
  }

  const manifest = {
    version: policy.contract().version,
    target: place.root,
    worktree: home.dir,
    branch: home.branch,
    issues: opts.issues,
    createdAt: new Date().toISOString(),
    entries,
  };
  const manifestFile = path.join(metaDir, 'manifest.json');
  fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  const answer = { worktree: home.dir, branch: home.branch, manifest: manifestFile, entries };
  if (opts.json) { out(JSON.stringify(answer)); return EXIT_OK; }
  out(`recovery worktree : ${home.dir}`);
  out(`branch            : ${home.branch}`);
  out(`manifest          : ${manifestFile}`);
  out(`${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} carried across; the originals are untouched.`);
  return EXIT_OK;
}

// ---- main ---------------------------------------------------------------------------------------

function run(argv, io = {}) {
  const out = io.out || ((line) => process.stdout.write(`${line}\n`));
  const err = io.err || ((line) => process.stderr.write(`${line}\n`));
  const command = argv[0];
  const parsed = parseArgs(argv.slice(1));
  if (parsed.error) { err(`write-protection: ${parsed.error}`); err(USAGE); return EXIT_USAGE; }
  const opts = parsed.opts;

  switch (command) {
    case 'status': return status(opts, out, err);
    case 'install': return install(opts, out, err);
    case 'uninstall': return uninstall(opts, out, err);
    case 'review': return reviewCommand(opts, out, err);
    case 'lease':
      if (!opts.grant) { err('write-protection: lease needs --grant'); err(USAGE); return EXIT_USAGE; }
      return grantLease(opts, out, err);
    case 'allow-writes': return allowWrites(opts, out, err);
    case 'revoke': return revoke(opts, out, err);
    case 'admit': return admit(opts, out, err);
    case 'recover': return recover(opts, out, err);
    default:
      err(command ? `write-protection: unknown command ${command}` : 'write-protection: a command is required');
      err(USAGE);
      return EXIT_USAGE;
  }
}

if (require.main === module) process.exit(run(process.argv.slice(2)));

module.exports = { run, admit: policy.admit };
