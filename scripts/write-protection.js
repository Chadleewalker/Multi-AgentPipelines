#!/usr/bin/env node
// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// The host side of pipeline-first write protection: what a person runs, and what the
// pipeline's own stages call (DESIGN.md §3.2, §3.4, §4.12, §6.2; change-log row `repo-324`).
//
//   install / status / uninstall   the client hooks, for Claude and for Codex
//   review --client codex          record an interactive `/hooks` trust review, bound to the
//                                   exact currently-installed hook definitions
//   lease --grant                  host-owned authority for one role, one target, one run
//   allow-writes / revoke          the one explicit, user-authorized way out, and its undo
//   admit                          the backstop: may this checkout be mutated right now?
//   recover                        a Git-registered home for edits admission refused
//
// TWO THINGS THIS DELIBERATELY DOES NOT DO. It never edits the checkout it is asked about —
// not to clean it, not to stash it, not to "help". A refusal that moved a person's
// uncommitted work would be the failure it exists to prevent, arrived at from the other
// side. And it never claims enforcement it does not have: `status` reports a client whose
// hooks are locally mutable, disabled, malformed, partly matched or not yet trusted as
// exactly that, because a security control that overstates itself is worse than one that is
// honestly partial.
//
// Host seams (all three name directories OUTSIDE any repository):
//   WRITE_PROTECTION_HOST_STATE_DIR   leases, opt-out and review records
//   WRITE_PROTECTION_CLAUDE_DIR       the Claude client configuration directory
//   WRITE_PROTECTION_CODEX_DIR        the Codex client configuration directory
//   WRITE_PROTECTION_MANAGED          set when local client policy is centrally managed and
//                                     therefore not disableable by whoever is sitting here
//
// The two client-directory seams are also the deterministic way to VALIDATE a client
// configuration without the client: aim one at a directory holding any profile and `status
// --json` judges it exactly as it judges a real installation, on a machine where neither
// agent CLI exists. `parseToml` and `codexState` are exported for the same reason. What that
// cannot answer — whether a real session loads the profile and refuses through it — is the
// black-box recipe in `docs/control-plane.md` (change-log row `repo-wwi`).
//
// Valid centrally managed hooks (`WRITE_PROTECTION_MANAGED`) are trusted by policy: they
// cannot be disabled by whoever is sitting here, so they need no personal review and are
// eligible for `enforced` on shape alone. A non-managed installation is different: its
// DEFINITION is locally mutable, so shape alone only proves the file reads correctly today —
// it proves nothing about whether a person looked at it. `review --client codex` records that
// a person ran the interactive `/hooks` review and bound the attestation to a digest of the
// exact installed command definitions; it stops being honoured the instant either definition
// changes, and an unrelated edit elsewhere in the file does not touch it.
//
// Checks: `node tests/acceptance/repo-324/test.js`, `node tests/acceptance/repo-wwi/test.js`.
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
const REVIEW_KIND = 'reviews';

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
// not happen while other projects have runs in flight. A review record is the one kind that
// IS rewritten in place by design — `name` is the client, and re-running `review` replaces the
// prior attestation with a fresh one bound to whatever is installed right now.
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
    hooks: [{ type: 'command', command: `node "${posix(bridge)}"` }],
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

// ---- the Codex client ---------------------------------------------------------------------------

function codexConfigFile(dir) { return path.join(dir, 'config.toml'); }

// A TOML basic string, escaped so that any character a path can carry survives the round trip.
function tomlString(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

// The hook command, as ONE command line rather than an argv array: Codex reads
// `[[hooks.PreToolUse.hooks]].command` as a string and rejects the profile outright when it is
// a sequence — `invalid type: sequence, expected a string` — which fails the WHOLE profile
// rather than one hook (change-log row `repo-gy3`). One pair of double quotes around the path
// is the only quoting form a POSIX shell and cmd.exe both read the same way, so a bridge
// installed under a directory with a space in its name still runs.
function codexCommandLine(bridge) {
  return `node "${posix(bridge)}"`;
}

// One matcher group per declared tool path, anchored to that tool alone. A bare name and an
// anchored expression are read identically by an exact-match client; an alternation would only
// work on a client that reads matchers as regular expressions.
function codexMatcher(tool) {
  return `^${String(tool).replace(/[\\^$+*?.()|{}[\]]/g, (c) => `\\${c}`)}$`;
}

function codexBlock(bridge) {
  const tools = policy.contract().clients.codex.toolPaths;
  const command = tomlString(codexCommandLine(bridge));
  const lines = [
    CODEX_BEGIN,
    '# Installed by node scripts/write-protection.js install — remove with `uninstall`.',
    '# `command` is a TOML string on purpose: an argv array is rejected as `invalid type:',
    '# sequence, expected a string` and takes the whole profile down with it.',
    '# Activation happens the moment this loads. Non-managed hooks still need an interactive',
    '# /hooks TRUST review before `status` calls them enforced — see `review --client codex`.',
  ];
  for (const tool of tools) {
    lines.push('', '[[hooks.PreToolUse]]', `matcher = ${tomlString(codexMatcher(tool))}`,
      '', '[[hooks.PreToolUse.hooks]]', 'type = "command"', `command = ${command}`);
  }
  lines.push(CODEX_END);
  return lines.join('\n');
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

// ---- reading a Codex profile ----------------------------------------------------------------
//
// `status` PARSES config.toml rather than looking for the sentinel comments it wrote. Shapes
// this project shipped before were valid TOML that Codex accepted and dispatched nothing from,
// and both carried the sentinel: presence of a block we wrote is exactly the evidence that
// failed (change-log rows `repo-ak5` and `repo-gy3`). What follows is enough of a TOML reader
// to answer the question honestly — table headers, array-of-table headers, dotted and quoted
// keys, strings, booleans, integers, arrays and inline tables — and, crucially, it keeps a
// value's KIND, because "a string, never an array" is part of what changed.

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

function tomlDepth(text) {
  let depth = 0;
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
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

// A value may span lines; a table header is balanced and never does, so joining on an unclosed
// bracket cannot swallow one.
function tomlLines(text) {
  const raw = String(text || '').split(/\r?\n/).map(tomlStripComment);
  const out = [];
  for (let i = 0; i < raw.length; i += 1) {
    let line = raw[i].trim();
    if (!line) continue;
    while (tomlDepth(line) > 0 && i + 1 < raw.length) { i += 1; line += ` ${raw[i].trim()}`; }
    out.push(line);
  }
  return out;
}

function tomlKeyPath(src) {
  const segs = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quote) {
      if (ch === quote) { quote = null; continue; }
      cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '.') { segs.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  segs.push(cur.trim());
  return segs.filter((s) => s.length);
}

function tomlValue(src, start) {
  let i = start;
  while (i < src.length && /\s/.test(src[i])) i += 1;
  const ch = src[i];
  if (ch === '"' || ch === "'") {
    const quote = ch;
    let out = '';
    i += 1;
    while (i < src.length) {
      const c = src[i];
      if (quote === '"' && c === '\\') {
        const next = src[i + 1] || '';
        out += next === 'n' ? '\n' : next;
        i += 2;
        continue;
      }
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
      const r = tomlValue(src, i);
      arr.push(r.value);
      i = r.i;
    }
    return { value: arr, i };
  }
  if (ch === '{') {
    const obj = {};
    i += 1;
    for (;;) {
      while (i < src.length && /[\s,]/.test(src[i])) i += 1;
      if (i >= src.length || src[i] === '}') { i += 1; break; }
      let key = '';
      if (src[i] === '"' || src[i] === "'") { const r = tomlValue(src, i); key = r.value; i = r.i; }
      else { while (i < src.length && !/[=\s]/.test(src[i])) { key += src[i]; i += 1; } }
      while (i < src.length && /\s/.test(src[i])) i += 1;
      if (src[i] === '=') i += 1;
      const r = tomlValue(src, i);
      tomlAssign(obj, tomlKeyPath(key), r.value);
      i = r.i;
    }
    return { value: obj, i };
  }
  let token = '';
  while (i < src.length && !/[,\]}]/.test(src[i])) { token += src[i]; i += 1; }
  token = token.trim();
  if (token === 'true') return { value: true, i };
  if (token === 'false') return { value: false, i };
  if (/^-?\d+$/.test(token)) return { value: Number(token), i };
  return { value: token, i };
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

function tomlAssign(table, segs, value) {
  if (!segs.length) return;
  const holder = tomlDescend(table, segs.slice(0, -1));
  holder[segs[segs.length - 1]] = value;
}

// The first `=` outside a string and outside a bracket.
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

function parseToml(text) {
  const root = {};
  let table = root;
  for (const line of tomlLines(text)) {
    const arrayHeader = /^\[\[(.+)\]\]$/.exec(line);
    const tableHeader = arrayHeader ? null : /^\[(.+)\]$/.exec(line);
    if (arrayHeader || tableHeader) {
      const segs = tomlKeyPath((arrayHeader || tableHeader)[1].trim());
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
    tomlAssign(table, tomlKeyPath(kv[0]), tomlValue(kv[1], 0).value);
  }
  return root;
}

// A cheap, whole-file well-formedness signal a real TOML parser would refuse to load on: an odd
// number of (non-comment) double-quote characters means some basic string was opened and never
// closed before end of line, which is invalid TOML. Every string this module itself ever writes
// is balanced by construction, so this only fires on a profile it did not produce.
function tomlQuoteBalanceOk(text) {
  let count = 0;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const stripped = tomlStripComment(raw);
    for (let i = 0; i < stripped.length; i += 1) {
      if (stripped[i] === '"') count += 1;
    }
  }
  return count % 2 === 0;
}

// ---- what a Codex profile has to say for itself ------------------------------------------------

const asList = (v) => (Array.isArray(v) ? v : (v === undefined || v === null ? [] : [v]));
const isTable = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

// `command_windows` where this platform would use it, `command` otherwise: the key a Codex on
// THIS host would actually run. Both are supported on the way in; only a string is accepted.
const CODEX_COMMAND_KEYS = ['command', 'command_windows'];

function codexCommandEntries(handler) {
  const out = [];
  for (const key of CODEX_COMMAND_KEYS) {
    const value = handler && handler[key];
    if (value === undefined || value === null) continue;
    if (Array.isArray(value) ? value.length === 0 : String(value).trim() === '') continue;
    out.push({ key, value });
  }
  return out;
}

function codexEffectiveCommand(handler) {
  const entries = codexCommandEntries(handler);
  if (!entries.length) return null;
  const windows = entries.find((e) => e.key === 'command_windows');
  const general = entries.find((e) => e.key === 'command');
  if (process.platform === 'win32' && windows) return windows.value;
  return (general || windows).value;
}

// Tokenise a command line the way a shell would, so the file it runs can be read out of it.
// Used only to ask WHICH program a handler names — never to decide whether the value was
// written as a string, which is asked of the parsed kind.
function commandTokens(value) {
  if (Array.isArray(value)) return value.map(String).filter((s) => s.length);
  const one = String(value === undefined || value === null ? '' : value).trim();
  if (!one) return [];
  return (one.match(/"[^"]*"|'[^']*'|\S+/g) || []).map((t) => t.replace(/^["']|["']$/g, ''));
}

const samePath = (a, b) => {
  const one = path.resolve(String(a));
  const two = path.resolve(String(b));
  return process.platform === 'win32' ? one.toLowerCase() === two.toLowerCase() : one === two;
};

const mentionsSigil = (value) => commandTokens(value).some((t) => posix(String(t)).includes(SIGIL));
const codexHandlerIsOurs = (h) => codexCommandEntries(h).some((e) => mentionsSigil(e.value));

// Every command assignment anywhere in the profile, whatever table it sits under — an older
// layout put them under `[[hooks.apply_patch]]`, which is not a matcher group at all.
function codexCommandsAnywhere(cfg) {
  const out = [];
  const walk = (node) => {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (!isTable(node)) return;
    for (const entry of codexCommandEntries(node)) out.push(entry);
    for (const value of Object.values(node)) walk(value);
  };
  walk(cfg);
  return out;
}

const codexGroups = (cfg) => asList(cfg && cfg.hooks && cfg.hooks.PreToolUse).filter(isTable);
const codexHandlers = (group) => asList(group && group.hooks).filter(isTable);

// An EFFECTIVE STRING HANDLER: nested under a matcher group, declared `type = "command"`, every
// command key it carries written as a TOML string, and running the bridge this installation put
// in place. Anything less is configuration that reads well and dispatches nothing.
function codexHandlerIsEffective(handler, bridge) {
  if (String((handler && handler.type) || '') !== 'command') return false;
  const entries = codexCommandEntries(handler);
  if (!entries.length) return false;
  if (!entries.every((e) => typeof e.value === 'string' && e.value.trim().length)) return false;
  return commandTokens(codexEffectiveCommand(handler)).some((t) => samePath(t, bridge));
}

function codexGroupCovers(group, tool) {
  return [...asList(group && group.matcher), ...asList(group && group.matchers)]
    .some((m) => matcherCovers(m, [tool]));
}

// Switched off at the client wins over everything else: a profile that turns hooks off has
// turned ours off too, whether or not our entry is still written down in it. Asked of the parse
// in the spellings this reader models, and of the raw text for any it does not.
function codexHooksOff(cfg, text) {
  if (isTable(cfg.features) && cfg.features.hooks === false) return 'hooks = false under [features]';
  if (cfg.hooks === false) return 'hooks = false';
  if (isTable(cfg.hooks) && cfg.hooks.enabled === false) return 'hooks.enabled = false';
  if (/^\s*(?:hooks|hooks_enabled|enable_hooks)\s*=\s*false\b/m.test(String(text || ''))) {
    return 'hooks = false';
  }
  return null;
}

// The canonical shape a review is bound to: every EFFECTIVE handler of ours, keyed by the
// matcher(s) covering it, with every command value it declares — nothing else in the file
// contributes, which is what lets an unrelated edit elsewhere leave a review valid while a
// change to one of these two definitions invalidates it.
function codexOurDefinitions(cfg, bridge) {
  const map = {};
  for (const group of codexGroups(cfg)) {
    const matchers = [...asList(group.matcher), ...asList(group.matchers)].map(String).sort();
    if (!matchers.length) continue;
    for (const handler of codexHandlers(group)) {
      if (!codexHandlerIsEffective(handler, bridge)) continue;
      const key = matchers.join('|');
      const cmd = String(codexEffectiveCommand(handler));
      if (!map[key]) map[key] = [];
      map[key].push(cmd);
    }
  }
  return map;
}

function codexDefinitionsDigest(dir) {
  const { text } = readCodex(dir);
  if (text === null) return null;
  let cfg;
  try { cfg = parseToml(text); } catch { return null; }
  const map = codexOurDefinitions(cfg, payloadPaths(dir).bridge);
  const keys = Object.keys(map).sort();
  if (!keys.length) return null;
  const canonical = keys.map((k) => `${k} ${map[k].slice().sort().join('')}`).join('');
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

function codexReviewRecord() {
  return policy.readRecords(REVIEW_KIND)
    .map(({ record }) => record)
    .find((r) => r && r.client === 'codex') || null;
}

function codexReviewValid(dir) {
  const digest = codexDefinitionsDigest(dir);
  if (!digest) return false;
  const record = codexReviewRecord();
  return Boolean(record) && String(record.digest || '') === digest;
}

function codexState(dir) {
  const tools = policy.contract().clients.codex.toolPaths;
  let stat = null;
  try { stat = fs.statSync(dir); } catch { stat = null; }
  if (stat && !stat.isDirectory()) return { state: 'unsupported', detail: `${dir} is not a directory` };
  const { file, text } = readCodex(dir);
  if (text === null) return { state: 'uninstalled', detail: `no ${file}` };

  let cfg;
  try { cfg = parseToml(text); }
  catch (e) {
    return { state: 'degraded', detail: `${file} could not be read as TOML (${String(e && e.message)})` };
  }

  const off = codexHooksOff(cfg, text);
  if (off) return { state: 'disabled', detail: `${file} sets ${off}, so no hook of ours runs` };

  if (!tomlQuoteBalanceOk(text)) {
    return { state: 'degraded', detail: `${file} could not be parsed as valid TOML (an unterminated string)` };
  }

  const groups = codexGroups(cfg);
  const nested = groups.flatMap(codexHandlers);
  const ours = nested.filter(codexHandlerIsOurs);
  const elsewhere = codexCommandsAnywhere(cfg).filter((e) => mentionsSigil(e.value));
  if (!ours.length && !elsewhere.length && !text.includes(CODEX_BEGIN)) {
    return { state: 'uninstalled', detail: `no hook entry in ${file}` };
  }
  if (!payloadComplete(dir)) {
    return { state: 'degraded', detail: `the hook is configured but ${payloadPaths(dir).base} is incomplete` };
  }

  const bridge = payloadPaths(dir).bridge;
  const covered = tools.filter((tool) => groups.some((g) => codexGroupCovers(g, tool)
    && codexHandlers(g).some((h) => codexHandlerIsEffective(h, bridge))));
  const uncovered = tools.filter((t) => !covered.includes(t));
  if (uncovered.length) {
    // Say WHICH way it fails, because the three ways are repaired differently and two of them
    // were shipped by this project itself.
    const arrayed = ours.some((h) => codexCommandEntries(h).some((e) => Array.isArray(e.value)))
      || elsewhere.some((e) => Array.isArray(e.value));
    const untyped = ours.some((h) => String((h && h.type) || '') !== 'command');
    const detail = arrayed
      ? `a hook command in ${file} is written as an array; Codex reads this key as a string and `
        + `rejects the profile, so ${uncovered.join(', ')} is not guarded`
      : untyped
        ? `a nested hook in ${file} omits type = "command", so ${uncovered.join(', ')} is not dispatched`
        : `no effective string handler running ${bridge} covers ${uncovered.join(', ')}`;
    return { state: 'degraded', detail };
  }

  // The shape is fully correct. Centrally managed policy cannot be locally disabled, so it needs
  // no personal review; a non-managed installation is a file this session could rewrite, so
  // `enforced` requires a review bound to exactly what is installed right now.
  if (managedPolicy()) return { state: 'enforced', detail: `${file}` };
  if (!codexReviewValid(dir)) {
    return {
      state: 'unreviewed',
      detail: `${file} — hook definitions are installed and match the contract, but have not `
        + 'been reviewed; use /hooks in an interactive Codex session to trust both entries, then '
        + 'run node scripts/write-protection.js review --client codex',
    };
  }
  return { state: 'enforced', detail: `${file}` };
}

// ---- review ------------------------------------------------------------------------------------

function review(opts, out, err) {
  const client = String(opts.client || '').trim();
  if (!client) { err('write-protection: review needs --client'); return EXIT_USAGE; }
  if (client !== 'codex') {
    err(`write-protection: review does not support client ${client}`);
    return EXIT_USAGE;
  }
  const dir = clientDir('codex');
  const digest = codexDefinitionsDigest(dir);
  if (!digest) {
    err('write-protection: no reviewable Codex hook definitions are installed — run `install` first');
    return EXIT_REFUSED;
  }
  const record = {
    version: policy.contract().version,
    client,
    digest,
    reviewedAt: new Date().toISOString(),
  };
  const file = writeRecord(REVIEW_KIND, client, record);
  if (opts.json) out(JSON.stringify({ reviewed: true, client, digest, file }));
  else {
    out(`codex: recorded the interactive /hooks TRUST review for the currently installed hook definitions`);
    out(`record ${file}`);
    out('This attestation stops being honoured the moment either definition changes.');
  }
  return EXIT_OK;
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
    limitations.push('codex: the same — its hook lives in config.toml, which a session can rewrite, '
      + 'and a non-managed installation additionally needs an interactive /hooks trust review before '
      + 'it counts as enforced. Organizations needing non-disableable local policy should install '
      + 'these hooks through centrally managed configuration (docs/control-plane.md).');
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
    if (!managedPolicy()) {
      out('');
      out('Installed and ACTIVE is not the same as TRUSTED. Centrally managed hooks are trusted');
      out('by policy and need no further step. This non-managed Codex installation does: open an');
      out('interactive Codex session, run /hooks, and trust both entries above — then record that');
      out('review, bound to exactly what is installed, with:');
      out('  node scripts/write-protection.js review --client codex');
      out('`status` will not call the Codex hook enforced until that review exists and matches.');
    }
  }
  return failed ? EXIT_REFUSED : EXIT_OK;
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
    case 'review': return review(opts, out, err);
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

module.exports = {
  run,
  admit: policy.admit,
  // The client-configuration validation seam: a profile in, a state out, no client needed.
  parseToml,
  codexState,
  claudeState,
};
