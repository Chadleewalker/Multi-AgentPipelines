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

const EXIT_OK = 0;
const EXIT_REFUSED = 1;
const EXIT_USAGE = 2;

const USAGE = [
  'usage:',
  '  node scripts/write-protection.js status [--json]',
  '  node scripts/write-protection.js install [--json]',
  '  node scripts/write-protection.js uninstall [--json]',
  '  node scripts/write-protection.js lease --grant --target <dir> --role <role>',
  '        [--issue <id>] [--run <id>] [--workspace <dir>] [--pid <n>] [--minutes <n>] [--json]',
  '  node scripts/write-protection.js allow-writes --target <dir> --session <id> [--minutes <n>] [--json]',
  '  node scripts/write-protection.js revoke --target <dir> --session <id> [--json]',
  '  node scripts/write-protection.js admit --target <dir> [--issue <id>]... [--json]',
  '  node scripts/write-protection.js recover --target <dir> [--issue <id>]... [--json]',
].join('\n');

// ---- arguments -----------------------------------------------------------------------------

const VALUE_FLAGS = new Set(['--target', '--role', '--issue', '--run', '--workspace', '--pid',
  '--minutes', '--session']);
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

// Codex hooks are `PreToolUse` matcher groups carrying a command, and the event they send is
// the `tool_name` / `tool_input` envelope the bridge reads (change-log row `repo-l2w`). The
// tables this used to write — `[[hooks.apply_patch]]` and `[[hooks.unified_exec]]` — are not a
// dialect of that, they are a configuration the client never reads: an installation carrying
// them is unguarded while `status` calls it enforced, which is the failure this file exists to
// not commit.
//
// ONE GROUP PER TOOL PATH, matcher spelled as the bare tool name. A client that matches a
// matcher exactly and a client that matches it as a regular expression both read a bare name
// the same way, and an alternation would be read by only one of them. Three groups cost three
// lines and are correct under either reading.

function codexConfigFile(dir) { return path.join(dir, 'config.toml'); }

function codexTools() {
  const declared = policy.contract().clients.codex.toolPaths;
  return Array.isArray(declared) ? declared.map(String) : [];
}

function codexBlock(bridge) {
  const lines = [
    CODEX_BEGIN,
    '# Installed by node scripts/write-protection.js install — remove with `uninstall`.',
    '# One PreToolUse matcher group per guarded tool path.',
  ];
  for (const tool of codexTools()) {
    lines.push('', '[[hooks.PreToolUse]]', `matcher = "${tool}"`,
      `command = ["node", "${posix(bridge)}"]`);
  }
  lines.push(CODEX_END);
  return lines.join('\n');
}

// ---- reading a config.toml, as far as this needs to ------------------------------------------

// Three constructs, because they are the only three any answer below turns on: a table header,
// `key = <value>`, and the strings inside a value. A full TOML parser would be a dependency and
// a second opinion about syntax this file has none about.
function codexRows(text) {
  const rows = [];
  let header = '';
  for (const line of String(text || '').split(/\r?\n/)) {
    const bare = line.replace(/(^|\s)#.*$/, '').trim();
    const h = /^\[\[?\s*([^\]]+?)\s*\]\]?$/.exec(bare);
    if (h) { header = h[1].replace(/"/g, ''); rows.push({ header, key: null, value: null }); continue; }
    const kv = /^([A-Za-z0-9_.\-"']+)\s*=\s*(.+)$/.exec(bare);
    if (kv) rows.push({ header, key: kv[1].replace(/"/g, ''), value: kv[2].trim() });
  }
  return rows;
}

function tomlStrings(value) {
  const out = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'/g;
  let m = re.exec(String(value || ''));
  while (m) { out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2]); m = re.exec(String(value || '')); }
  return out;
}

// Every hook group whose table path carries a `PreToolUse` segment, with the matchers and
// commands declared in it or in a table nested beneath it. A repeat of the same header is the
// next element of an array of tables and therefore the next group, which is what keeps somebody
// else's entry in the shared table from being read as part of ours.
function codexGroups(text) {
  const groups = [];
  let open = null;
  for (const row of codexRows(text)) {
    if (row.key === null) {
      if (open && row.header.startsWith(`${open.header}.`)) continue;
      if (row.header.split('.').some((seg) => seg === 'PreToolUse')) {
        open = { header: row.header, matchers: [], commands: [] };
        groups.push(open);
        continue;
      }
      open = null;
      continue;
    }
    if (!open) continue;
    if (['matcher', 'matchers', 'tools'].includes(row.key)) open.matchers.push(...tomlStrings(row.value));
    if (['command', 'commands', 'argv'].includes(row.key)) {
      const argv = tomlStrings(row.value);
      if (argv.length) open.commands.push(argv);
    }
  }
  return groups;
}

// The same rule the Claude half applies, one tool at a time: absent or `*` covers everything,
// an alternation covers what it lists, anything else is tried as a whole-name regular
// expression. A group in a table named after a tool covers that tool too.
function codexGroupCovers(group, tool) {
  if (group.header.split('.').some((seg) => seg === tool)) return true;
  return group.matchers.some((raw) => {
    const m = String(raw === undefined || raw === null ? '' : raw).trim();
    if (!m || m === '*') return true;
    if (m.split(/[|,]/).map((s) => s.trim()).some((s) => s === tool || s === '*')) return true;
    try { return new RegExp(`^(?:${m})$`).test(tool); } catch { return false; }
  });
}

// Whether a hook group runs THIS installation's own bridge. Not "a file whose name looks like
// ours" — the exact path `install` wrote, because a group re-pointed at something else is a
// hook whose behaviour this command knows nothing about and may not vouch for.
function runsOurBridge(group, dir) {
  const want = posix(payloadPaths(dir).bridge).toLowerCase();
  return group.commands.some((argv) => argv.some((a) => posix(String(a)).toLowerCase() === want));
}

// Hooks switched off at the client, in either spelling. This wins over everything else: a
// configuration that turns hooks off has turned OURS off too, whether or not the entry is
// still written down in it.
function codexHooksOff(text) {
  const falsey = (v) => /^false\b/i.test(String(v || '').trim());
  for (const row of codexRows(text)) {
    if (row.key === null) continue;
    if (row.key === 'hooks' && falsey(row.value)) return `${row.header || '(root)'}.hooks = false`;
    if (row.header === 'hooks' && row.key === 'enabled' && falsey(row.value)) return '[hooks] enabled = false';
    if (row.key === 'hooks.enabled' && falsey(row.value)) return 'hooks.enabled = false';
  }
  return null;
}

// Codex will not run a hook in a project it has not been told to trust. A trust level declared
// at the root is the setting that governs sessions generally; per-project entries govern one
// path each and are reported as a limitation rather than as this client's state, because a
// project nobody guards here is not evidence about the projects that are.
function codexTrust(text) {
  const global = [];
  const projects = [];
  for (const row of codexRows(text)) {
    if (row.key === null) continue;
    const leaf = row.key.split('.').pop();
    if (leaf !== 'trust_level') continue;
    const value = (tomlStrings(row.value)[0] || String(row.value)).trim();
    if (value === 'trusted') continue;
    const scope = `${row.header ? `${row.header}.` : ''}${row.key}`;
    if (row.header === '' && row.key === 'trust_level') global.push(`${scope} = "${value}"`);
    else projects.push(`${scope} = "${value}"`);
  }
  return { global, projects };
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

// Nothing here reports `enforced` on the strength of the block being written down. Every step
// between the file and a tool call the client would actually refuse is asked separately, and
// the first one that cannot be answered is the state — because the failure this repairs was a
// configuration that said enforced while a normal session rewrote a protected file.
function codexState(dir) {
  let stat = null;
  try { stat = fs.statSync(dir); } catch { stat = null; }
  if (stat && !stat.isDirectory()) return { state: 'unsupported', detail: `${dir} is not a directory` };
  const { file, text } = readCodex(dir);
  if (text === null) return { state: 'uninstalled', detail: `no ${file}` };

  // Switched off at the client wins over everything else, including over there being nothing
  // installed: a configuration that turns hooks off has turned OURS off too, and reporting it
  // as merely uninstalled would invite an `install` that changes nothing.
  const off = codexHooksOff(text);
  if (off) return { state: 'disabled', detail: `${file} sets ${off}, so no hook of ours runs` };

  const groups = codexGroups(text);
  const ours = groups.filter((g) => runsOurBridge(g, dir));
  if (!ours.length && !text.includes(CODEX_BEGIN)) {
    return { state: 'uninstalled', detail: `no PreToolUse hook entry of ours in ${file}` };
  }

  const trust = codexTrust(text);
  if (trust.global.length) {
    return {
      state: 'degraded',
      detail: `${file} withholds the trust a hook needs before it runs (${trust.global.join(', ')})`,
      untrustedProjects: trust.projects,
    };
  }

  if (!ours.length) {
    return {
      state: 'degraded',
      detail: `${file} carries a hook block, but no PreToolUse group in it runs ${posix(payloadPaths(dir).bridge)}`,
      untrustedProjects: trust.projects,
    };
  }
  if (!payloadComplete(dir)) {
    return {
      state: 'degraded',
      detail: `the hook is configured but ${payloadPaths(dir).base} is incomplete`,
      untrustedProjects: trust.projects,
    };
  }

  const uncovered = codexTools().filter((t) => !ours.some((g) => codexGroupCovers(g, t)));
  if (uncovered.length) {
    return {
      state: 'degraded',
      detail: `no PreToolUse matcher of ours covers ${uncovered.join(', ')}`,
      untrustedProjects: trust.projects,
    };
  }
  return { state: 'enforced', detail: `${file}`, untrustedProjects: trust.projects };
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
    const untrusted = Array.isArray(info.untrustedProjects) ? info.untrustedProjects : [];
    if (untrusted.length) {
      limitations.push(`${name}: no hook of ours runs in the projects this client has not been `
        + `told to trust (${untrusted.join(', ')}); admission still refuses there.`);
    }
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
