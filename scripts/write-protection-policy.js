// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// The one decision procedure behind pipeline-first agent writes
// (DESIGN.md §3.2, §3.4, §4.12, §6.2; change-log row `repo-324`).
//
// WHAT THIS IS FOR. `scripts/session-guard.js` answers a machine-level question — one
// session, one folder — and answers it fail-open, because a broken folder rule is worse
// than the collision it watches for. It has nothing to say about the question this module
// answers: whether the session in front of it is allowed to change this project AT ALL.
// A session that recognises an onboarded repository and implements in it directly has not
// broken the folder rule; it has bypassed the pipeline, and every guarantee this system
// makes about review, freezing and evidence with it.
//
// The marker is `pipeline.config.json` at the selected integration fork point. Its presence
// is what makes a checkout pipeline-first; its absence leaves the checkout exactly as
// unprotected as it was before this file existed. Nothing in the tree opts out, because
// everything in the tree is something a model can write.
//
// THREE THINGS LIVE HERE AND NOWHERE ELSE:
//
//   classify()   which class of the contract a repository-relative path belongs to
//   decide()     one write/shell/patch request in, one allow-or-deny verdict out
//   admit()      whether a real checkout may be mutated by a freeze, a preparation or a
//                dispatch, given what is already dirty in it
//
// All three read `contracts/write-protection.json`, resolved from THIS FILE'S installation
// — never from the checkout being judged. A guard that read its policy out of the tree it
// is judging would let a session widen its own permissions with one edit. Admission is what
// catches an edit to the contract itself, because admission runs on the host over a
// checkout whose contract copy has no authority.
//
// AUTHORITY IS A HOST RECORD, NOT A FOLDER. A Git worktree is isolation, not permission:
// `scripts/write-protection.js lease --grant` writes a record outside every repository,
// binding the canonical target, the Git common directory, the role, the issue and run
// identity, the controlling process (pid AND its start identity, so a recycled pid is not
// an inheritance), the allowed path classes, an expiry and an unguessable token. A lease a
// model could write is not a lease, so nothing inside a repository is ever consulted.
//
// Zero dependencies beyond node built-ins and `git`.
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CONTRACT_FILE = path.resolve(__dirname, '..', 'contracts', 'write-protection.json');
const MARKER = 'pipeline.config.json';
const RECEIPT_NAME = '.freeze-gate.json';
const GIT = process.env.WRITE_PROTECTION_GIT || 'git';
const GIT_TIMEOUT_MS = 20000;
const WIN = process.platform === 'win32';

// ---- contract ---------------------------------------------------------------------------

let cachedContract = null;
function contract() {
  if (cachedContract) return cachedContract;
  cachedContract = JSON.parse(fs.readFileSync(CONTRACT_FILE, 'utf8'));
  return cachedContract;
}

// ---- paths ------------------------------------------------------------------------------

function norm(p) {
  const a = path.resolve(p);
  return WIN ? a.toLowerCase() : a;
}

function canonical(p) {
  let resolved = path.resolve(String(p));
  try {
    resolved = fs.realpathSync.native ? fs.realpathSync.native(resolved) : fs.realpathSync(resolved);
  } catch { /* not created yet — the resolved spelling is still stable */ }
  return WIN ? resolved.toLowerCase() : resolved;
}

function rel(root, abs) {
  return path.relative(root, abs).split(path.sep).join('/');
}

function within(dir, child) {
  const r = path.relative(norm(dir), norm(child));
  return r === '' || (!r.startsWith('..') && !path.isAbsolute(r));
}

// A repository-relative glob, in the one dialect this project already uses for frozen paths
// (`scripts/protected-tree.js`): `*` stops at a separator, `**` does not, and a literal
// directory name selects its descendants. Written out here rather than imported because this
// module runs once per tool call and must not drag the runner's config loader in with it.
function regexFor(pattern) {
  let out = '^';
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') { out += '.*'; i += 1; } else out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else out += /[\\^$+?.()|{}[\]]/.test(c) ? `\\${c}` : c;
  }
  return new RegExp(`${out}(?:/.*)?$`);
}

const matcherCache = new Map();
function matches(pattern, relPath) {
  let re = matcherCache.get(pattern);
  if (!re) { re = regexFor(String(pattern).replace(/\/+$/, '')); matcherCache.set(pattern, re); }
  return re.test(relPath);
}

// ---- locating a checkout ------------------------------------------------------------------

// Walk up for the `.git` entry, exactly as `scripts/session-guard.js` does. Which KIND of
// entry it is answers the question: a directory is the main checkout, a file is a worktree
// and names the common directory it belongs to. No spawn, which matters on a path taken once
// per tool call.
function locate(start) {
  let dir = path.resolve(start);
  for (;;) {
    const dotgit = path.join(dir, '.git');
    let st = null;
    try { st = fs.statSync(dotgit); } catch { st = null; }
    if (st && st.isDirectory()) return { root: dir, commonDir: dotgit, main: dir, isMain: true };
    if (st && st.isFile()) {
      let main = null;
      let commonDir = null;
      try {
        const m = /gitdir:\s*(.+)/.exec(fs.readFileSync(dotgit, 'utf8'));
        if (m) {
          const gitdir = path.resolve(dir, m[1].trim().replace(/[\\/]+$/, ''));
          const parts = gitdir.split(/[\\/]/);
          const at = parts.lastIndexOf('worktrees');
          if (at > 1 && parts[at - 1] === '.git') {
            main = parts.slice(0, at - 1).join(path.sep) || path.sep;
            commonDir = path.join(main, '.git');
          }
        }
      } catch { main = null; }
      return { root: dir, commonDir, main, isMain: false };
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function git(root, args, extra = {}) {
  return spawnSync(GIT, args, {
    cwd: root, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, windowsHide: true,
    maxBuffer: 32 * 1024 * 1024, ...extra,
  });
}

// The protection marker at the SELECTED INTEGRATION FORK POINT. Reading the working tree
// first would make `rm pipeline.config.json` the cheapest opt-out in the system, so the
// committed blob wins and the working tree is only a fallback for a checkout that has no
// commit yet (a fresh `git init`, or a repo-shaped tree that is not a repository at all).
function policyAtForkPoint(place) {
  const root = place && place.root;
  if (!root) return null;
  const shown = git(root, ['show', `HEAD:${MARKER}`]);
  if (shown && shown.status === 0 && typeof shown.stdout === 'string') {
    try { return JSON.parse(shown.stdout); } catch { return {}; }
  }
  try { return JSON.parse(fs.readFileSync(path.join(root, MARKER), 'utf8')); }
  catch { /* fall through */ }
  return fs.existsSync(path.join(root, MARKER)) ? {} : null;
}

const contextCache = new Map();

// Everything a verdict needs to know about the checkout a path lands in.
function contextFor(somePath) {
  const key = norm(somePath);
  if (contextCache.has(key)) return contextCache.get(key);
  const place = locate(somePath);
  let ctx;
  if (!place) {
    ctx = { repo: false, protected: false, root: null, target: null, commonDir: null, policy: null };
  } else {
    const policy = policyAtForkPoint(place);
    const main = place.main || place.root;
    ctx = {
      repo: true,
      protected: policy !== null,
      root: place.root,
      target: canonical(main),
      commonDir: place.commonDir ? canonical(place.commonDir) : null,
      policy: policy || {},
    };
  }
  contextCache.set(key, ctx);
  return ctx;
}

// ---- classification -----------------------------------------------------------------------

// The frozen class is the union of the contract's own globs and the ones THIS TARGET declares
// in its `pipeline.config.json`. That second half is why `vendor/pinned.txt` is frozen in a
// project that says so and unclassified everywhere else: the guard has no baked-in list.
function frozenPatterns(ctx) {
  const declared = (ctx && ctx.policy && Array.isArray(ctx.policy.frozenPaths))
    ? ctx.policy.frozenPaths.filter((p) => typeof p === 'string' && p.trim() && !p.includes('\0')
      && !path.isAbsolute(p) && !p.split(/[\\/]/).includes('..') && !p.startsWith(':'))
    : [];
  return [...(contract().pathClasses.frozen || []), ...declared.map((p) => p.replace(/\\/g, '/'))];
}

// The first class in the contract's declared precedence that claims this path, or null. Null
// is a real answer and not a hole: an unclassified path is one this project has not declared,
// and the contract widening (or not) is what decides it — never a catch-all here.
function classify(relPath, ctx, contractOverride) {
  const c = contractOverride || contract();
  const classes = c.pathClasses || {};
  const order = c.classPrecedence || Object.keys(classes);
  const clean = String(relPath).replace(/\\/g, '/').replace(/^\.\//, '');
  if (!clean || clean.startsWith('..')) return null;
  for (const name of order) {
    const patterns = name === 'frozen' ? frozenPatterns(ctx) : (classes[name] || []);
    for (const pattern of patterns) {
      if (matches(pattern, clean)) return name;
    }
  }
  return null;
}

// `.gitignore` IS the host-artifact allowlist — writing a second copy of it here would go
// stale the first time the file gained an entry, and `runs/` staying writable is the existing
// policy C6 preserves.
function isIgnored(root, relPath) {
  if (!relPath || relPath.startsWith('..')) return true;
  if (relPath === '.git' || relPath.startsWith('.git/')) return true;
  const r = git(root, ['check-ignore', '-q', '--', relPath]);
  if (r.error || typeof r.status !== 'number') return false;
  return r.status === 0;
}

// ---- host state ---------------------------------------------------------------------------

// Outside every repository, by construction: a lease a model can reach is not a lease.
function hostStateDir() {
  const explicit = String(process.env.WRITE_PROTECTION_HOST_STATE_DIR || '').trim();
  if (explicit) return path.resolve(explicit);
  return path.join(os.homedir(), '.multi-agent-pipelines', 'write-protection');
}

const LEASE_DIR = 'leases';
const OPTOUT_DIR = 'opt-outs';

function readRecords(kind) {
  const dir = path.join(hostStateDir(), kind);
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(dir, name);
    try { out.push({ file, record: JSON.parse(fs.readFileSync(file, 'utf8')) }); }
    catch { /* a malformed record authorizes nothing, which is the same as not being there */ }
  }
  return out;
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }
}

// Linux: field 22 of /proc/<pid>/stat, the start time in clock ticks since boot. It is what
// makes a recycled pid decidable rather than merely improbable. Where it cannot be read the
// answer is the string `unknown`, and two `unknown`s fall back to liveness alone rather than
// pretending to an identity nobody has.
function startIdentity(pid) {
  if (process.platform !== 'linux' || !Number.isInteger(pid) || pid <= 0) return 'unknown';
  let raw;
  try { raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); } catch { return 'unknown'; }
  const close = raw.lastIndexOf(')');
  if (close < 0) return 'unknown';
  const fields = raw.slice(close + 1).trim().split(/\s+/);
  return fields.length > 19 ? `linux:${fields[19]}` : 'unknown';
}

function notExpired(value) {
  const t = Date.parse(String(value || ''));
  return Number.isFinite(t) && t > Date.now();
}

function sameToken(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  if (left.length !== right.length || !left.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function findLease(token) {
  if (!token) return null;
  for (const { record } of readRecords(LEASE_DIR)) {
    if (record && sameToken(record.token, token)) return record;
  }
  return null;
}

function liveOptOut(target, sessionId) {
  if (!sessionId) return null;
  for (const { record } of readRecords(OPTOUT_DIR)) {
    if (!record || String(record.session) !== String(sessionId)) continue;
    if (canonical(record.target || '') !== target) continue;
    if (!notExpired(record.expiresAt)) continue;
    return record;
  }
  return null;
}

// ---- shell reading --------------------------------------------------------------------------

// A here-document body is data being written, not commands being run. The introducer's own
// line is kept so `tee tracked.md <<EOF` is still judged on its operand — the same reasoning,
// and the same code shape, as `scripts/session-guard.js`.
function stripHeredocs(command) {
  const lines = String(command).split('\n');
  const kept = [];
  let terminator = null;
  for (const line of lines) {
    if (terminator !== null) {
      if (line.trim() === terminator) terminator = null;
      continue;
    }
    kept.push(line);
    const intro = [...line.matchAll(/<<-?\s*(["']?)([A-Za-z_][A-Za-z0-9_]*)\1/g)].pop();
    if (intro) terminator = intro[2];
  }
  return kept.join('\n');
}

const CONTROL = /^(?:\|\|?|&&?|;;?|\(|\)|\n)$/;
const REDIRECT_OUT = /^\d*>>?$/;

function tokenise(command) {
  const out = [];
  let cur = ''; let had = false; let quote = null;
  const push = () => { if (had) out.push(cur); cur = ''; had = false; };
  for (let i = 0; i < command.length; i += 1) {
    const c = command[i];
    if (quote) {
      if (c === quote) quote = null; else { cur += c; had = true; }
      continue;
    }
    if (c === '"' || c === "'") { quote = c; had = true; continue; }
    if (c === '\\' && i + 1 < command.length) { cur += command[i + 1]; had = true; i += 1; continue; }
    if (c === '\n') { push(); out.push('\n'); continue; }
    if (/\s/.test(c)) { push(); continue; }
    if (c === '|' || c === ';' || c === '&') {
      push();
      let run = c;
      while (command[i + 1] === c) { run += c; i += 1; }
      out.push(run);
      continue;
    }
    if (c === '(' || c === ')') { push(); out.push(c); continue; }
    if (c === '>' || c === '<') {
      let fd = '';
      if (had && /^\d+$/.test(cur)) { fd = cur; cur = ''; had = false; } else push();
      let op = c;
      while (command[i + 1] === c) { op += c; i += 1; }
      if (command[i + 1] === '&') { op += '&'; i += 1; }
      out.push(fd + op);
      continue;
    }
    cur += c; had = true;
  }
  push();
  return out;
}

function segments(tokens) {
  const out = [];
  let current = [];
  for (const t of tokens) {
    if (CONTROL.test(t)) { if (current.length) out.push(current); current = []; continue; }
    current.push(t);
  }
  if (current.length) out.push(current);
  return out;
}

// Commands that read and never write. `printf` and `echo` are here on purpose: what makes
// `printf x > file` a write is the redirect, which is judged separately, and refusing the
// command itself would refuse every harmless use of it.
const READ_ONLY = new Set([
  'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'find', 'file',
  'stat', 'pwd', 'echo', 'printf', 'which', 'type', 'basename', 'dirname', 'realpath',
  'readlink', 'date', 'sort', 'uniq', 'cut', 'tr', 'diff', 'comm', 'du', 'df', 'tree',
  'less', 'more', 'jq', 'yq', 'md5sum', 'sha1sum', 'sha256sum', 'true', 'false', 'sleep',
  'test', 'printenv', 'uname', 'whoami', 'hostname', 'id', 'seq', 'tac', 'nl', 'column',
]);

// Commands that write, and whose operands this reader knows how to find. Anything that
// mutates in a way this list does not describe is not on it, and therefore fails closed.
const WRITERS = new Set(['tee', 'sed', 'cp', 'mv', 'rm', 'touch', 'mkdir', 'ln', 'install', 'truncate']);

// Interpreters. A version or help probe reads; anything else runs a program this reader
// cannot see inside, so it is refused for what it MIGHT write rather than allowed for what it
// happens to say.
const INTERPRETERS = new Set(['node', 'nodejs', 'python', 'python2', 'python3', 'ruby', 'perl',
  'php', 'deno', 'bun', 'osascript', 'powershell', 'pwsh', 'awk', 'gawk', 'mawk']);
const PROBE_ONLY = /^(--version|-v|-V|--help|-h)$/;

const GIT_READ_ONLY = new Set(['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'ls-tree',
  'cat-file', 'blame', 'describe', 'shortlog', 'grep', 'check-ignore', 'merge-base', 'diff-tree',
  'name-rev', 'var', 'help', 'version', 'rev-list', 'for-each-ref', 'symbolic-ref', 'ls-remote',
  'count-objects', 'whatchanged', 'annotate', 'cherry', 'range-diff']);
const GIT_DESTRUCTIVE = new Set(['reset', 'clean', 'checkout', 'restore', 'stash', 'rebase',
  'filter-branch', 'gc', 'prune', 'switch']);

const isFlag = (t) => t.startsWith('-') && t !== '-' && !REDIRECT_OUT.test(t);

function commandName(token) {
  const bare = String(token || '').split(/[\\/]/).pop();
  return bare.replace(/\.(exe|cmd|bat)$/i, '');
}

const PREFIXES = new Set(['sudo', 'nohup', 'time', 'command', 'exec', 'nice', 'ionice', 'stdbuf']);

// Split one segment into the words that form the command and the files its redirects write.
// A redirect's operand is a file name and never the command; an INPUT redirect's operand is
// read, so it is neither.
function splitRedirects(seg) {
  const words = [];
  const targets = [];
  for (let i = 0; i < seg.length; i += 1) {
    const t = seg[i];
    if (/^\d*[<>]+&$/.test(t)) continue;                 // duplicates a descriptor, writes no file
    if (REDIRECT_OUT.test(t)) {
      if (i + 1 < seg.length) { targets.push(seg[i + 1]); i += 1; }
      continue;
    }
    if (/^\d*<+$/.test(t)) { i += 1; continue; }         // heredoc or input file: read, not written
    words.push(t);
  }
  return { words, targets };
}

// The file operands of the constructs an agent actually edits files with. Inputs are
// deliberately not collected: `sed -n 1,5p tracked.md > /tmp/out` writes the scratch file and
// reads the tracked one.
function writeTargets(seg) {
  const { words, targets } = splitRedirects(seg);
  const name = commandName(words[0] || '');
  const rest = words.slice(1);
  const operands = rest.filter((t) => !isFlag(t));
  const flags = rest.filter(isFlag);

  if (name === 'tee') targets.push(...operands);
  else if (name === 'sed') {
    const inPlace = flags.some((f) => f === '--in-place' || /^--in-place=/.test(f) || /^-[^-]*i/.test(f));
    if (inPlace) {
      const scripted = flags.some((f) => /^-[^-]*[ef]/.test(f) || f === '--expression' || f === '--file');
      targets.push(...(scripted ? operands : operands.slice(1)));
    }
  } else if (['rm', 'mv', 'touch', 'mkdir', 'truncate'].includes(name)) targets.push(...operands);
  else if (['cp', 'ln', 'install'].includes(name)) {
    if (operands.length > 1) targets.push(operands[operands.length - 1]);
  }
  return targets.filter((t) => t && !t.startsWith('-') && !/^\$/.test(t) && !/^<+/.test(t));
}

// One shell segment, read as far as this module can honestly read it. Returns the write
// targets it found plus, where the command form itself is the verdict, a deny reason.
function readSegment(seg) {
  const words = splitRedirects(seg).words.slice();
  while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words.shift();
  while (words.length && PREFIXES.has(commandName(words[0]))) words.shift();
  if (words.length && commandName(words[0]) === 'env') {
    words.shift();
    while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words.shift();
  }

  const targets = writeTargets(seg);
  if (!words.length) return { targets, reason: null };
  const name = commandName(words[0]);
  const rest = words.slice(1);

  if (name === 'git') {
    const sub = rest.find((t) => !isFlag(t));
    if (GIT_DESTRUCTIVE.has(sub)) return { targets, reason: 'destructive-git' };
    if (sub === 'add' || sub === 'commit' || sub === 'push' || sub === 'apply' || sub === 'am') {
      return { targets, reason: 'destructive-git' };
    }
    if (sub === 'worktree') {
      return { targets, reason: rest.includes('list') ? null : 'destructive-git' };
    }
    if (!sub || GIT_READ_ONLY.has(sub)) return { targets, reason: null };
    return { targets, reason: 'unknown-shell-form' };
  }
  if (INTERPRETERS.has(name)) {
    const probeOnly = rest.length > 0 && rest.every((t) => PROBE_ONLY.test(t));
    return { targets, reason: probeOnly ? null : 'interpreter-write' };
  }
  if (READ_ONLY.has(name) || WRITERS.has(name)) return { targets, reason: null };
  return { targets, reason: 'unknown-shell-form' };
}

// ---- patch reading ---------------------------------------------------------------------------

// The two patch dialects an agent actually sends: the `*** Begin Patch` envelope Codex uses,
// and a unified diff. A patch this cannot read names no files, and a patch that names no files
// is refused for being unreadable rather than allowed for being quiet.
function patchTargets(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    let m = /^\*\*\*\s+(?:Add|Update|Delete)\s+File:\s*(.+?)\s*$/.exec(line);
    if (m) { out.push(m[1]); continue; }
    m = /^\*\*\*\s+Move\s+to:\s*(.+?)\s*$/.exec(line);
    if (m) { out.push(m[1]); continue; }
    m = /^\+\+\+\s+(?:b\/)?(.+?)\s*$/.exec(line);
    if (m && m[1] !== '/dev/null') { out.push(m[1]); continue; }
  }
  return out.map((p) => p.trim()).filter(Boolean);
}

// ---- the verdict ------------------------------------------------------------------------------

function verdict(decision, reason, isProtected) {
  return { decision, reason, protected: Boolean(isProtected) };
}

// One path, in the checkout it lands in. Returns null when there is nothing to refuse.
function judgePath(absPath, request) {
  const ctx = contextFor(path.dirname(absPath));
  if (!ctx.repo || !ctx.protected) return { ctx, deny: null };
  const relPath = rel(ctx.root, absPath);
  if (!relPath || relPath.startsWith('..')) return { ctx, deny: null };
  if (isIgnored(ctx.root, relPath)) return { ctx, deny: null };

  const cls = classify(relPath, ctx);
  const token = request.token ? String(request.token) : '';

  if (token) {
    const lease = findLease(token);
    if (!lease) return { ctx, deny: 'lease-invalid' };
    const bad = leaseInvalid(lease, ctx.target);
    if (bad) return { ctx, deny: bad };
    return { ctx, deny: roleDenial(lease, ctx, relPath, cls) };
  }

  if (liveOptOut(ctx.target, request.sessionId)) return { ctx, deny: null };
  if (cls === null) return { ctx, deny: null };
  return { ctx, deny: 'pipeline-first' };
}

// Every way a lease fails to be one. Order matters only for the message a person reads.
function leaseInvalid(lease, targetOfPath) {
  if (!lease || typeof lease !== 'object') return 'lease-invalid';
  if (!notExpired(lease.expiresAt)) return 'lease-invalid';
  const roles = contract().roles || {};
  const role = roles[String(lease.role)];
  if (!role) return 'lease-invalid';

  const leaseTarget = lease.target ? canonical(lease.target) : null;
  if (!leaseTarget) return 'lease-invalid';
  const workspace = lease.workspace ? canonical(lease.workspace) : null;

  // The record must still describe the checkout it names. A lease whose Git common directory
  // points somewhere else has been copied, edited or aimed at another repository.
  const place = locate(leaseTarget);
  const actualCommon = place && place.commonDir ? canonical(place.commonDir) : null;
  if (!actualCommon || !lease.gitCommonDir || canonical(lease.gitCommonDir) !== actualCommon) {
    return 'lease-invalid';
  }

  const pid = Number(lease.controllerPid);
  if (!pidAlive(pid)) return 'lease-invalid';
  const now = startIdentity(pid);
  const then = String(lease.controllerStart || '');
  if (then !== 'unknown' && now !== 'unknown' && then !== now) return 'lease-invalid';

  if (targetOfPath !== leaseTarget && (!workspace || targetOfPath !== workspace)) return 'lease-invalid';
  return null;
}

function roleDenial(lease, ctx, relPath, cls) {
  const role = (contract().roles || {})[String(lease.role)] || {};
  const scope = String(role.scope || 'target');
  const leaseTarget = canonical(lease.target);
  const workspace = lease.workspace ? canonical(lease.workspace) : null;

  if (scope === 'workspace') {
    if (!workspace || ctx.target !== workspace) return 'role-path';
  } else if (ctx.target !== leaseTarget) return 'role-path';

  if (scope === 'issue-suite') {
    const issue = String(lease.issueId || '');
    if (!issue) return 'role-path';
    return relPath === `tests/acceptance/${issue}` || relPath.startsWith(`tests/acceptance/${issue}/`)
      ? null : 'role-path';
  }

  const allowed = new Set([
    ...(Array.isArray(role.pathClasses) ? role.pathClasses : []),
  ].filter((c) => !Array.isArray(lease.pathClasses) || lease.pathClasses.includes(c)));
  if (cls === null || !allowed.has(cls)) return 'role-path';
  return null;
}

// One request in, one verdict out. `read`, and any action this has no opinion about, allows.
function decide(request) {
  const req = request && typeof request === 'object' ? request : {};
  const action = String(req.action || '');
  const cwd = req.cwd ? path.resolve(String(req.cwd)) : process.cwd();

  if (action !== 'write' && action !== 'shell' && action !== 'patch') {
    const ctx = contextFor(cwd);
    return verdict('allow', 'not-a-mutation', ctx.protected);
  }

  let paths = [];
  let formReason = null;
  if (action === 'write') {
    const raw = String(req.path || '');
    if (!raw) return verdict('allow', 'no-path', contextFor(cwd).protected);
    paths = [path.resolve(cwd, raw)];
  } else if (action === 'patch') {
    const named = patchTargets(req.patch);
    if (!named.length) formReason = 'unknown-patch-form';
    paths = named.map((p) => path.resolve(cwd, p));
  } else {
    const tokens = tokenise(stripHeredocs(String(req.command || '')));
    const parts = segments(tokens);
    if (!parts.length) return verdict('allow', 'empty-command', contextFor(cwd).protected);
    for (const seg of parts) {
      const read = readSegment(seg);
      if (read.reason && !formReason) formReason = read.reason;
      paths.push(...read.targets.map((p) => path.resolve(cwd, p)));
    }
  }

  let isProtected = contextFor(cwd).protected;
  for (const abs of paths) {
    const { ctx, deny } = judgePath(abs, req);
    if (ctx.protected) isProtected = true;
    if (deny) return verdict('deny', deny, true);
  }

  // A command form this reader cannot vouch for only matters where protection is on: an
  // unprotected checkout is exactly as unguarded as it was before any of this existed.
  if (formReason && isProtected) {
    if (!authorized(cwd, req)) return verdict('deny', formReason, true);
  }
  return verdict('allow', isProtected ? 'authorized' : 'unprotected', isProtected);
}

// Whether the session holds any host-granted authority in the checkout it is running in. Used
// only for command FORMS, where there is no path to judge a role against.
function authorized(cwd, req) {
  const ctx = contextFor(cwd);
  if (!ctx.repo || !ctx.protected) return true;
  if (liveOptOut(ctx.target, req.sessionId)) return true;
  const lease = req.token ? findLease(String(req.token)) : null;
  return Boolean(lease && !leaseInvalid(lease, ctx.target));
}

// ---- admission ------------------------------------------------------------------------------

function porcelainEntries(root) {
  const r = git(root, ['status', '--porcelain', '-uall', '-z']);
  if (!r || r.status !== 0) return null;
  const raw = String(r.stdout || '');
  const out = [];
  const fields = raw.split('\0');
  for (let i = 0; i < fields.length; i += 1) {
    const record = fields[i];
    if (!record || record.length < 4) continue;
    const x = record[0];
    const y = record[1];
    const name = record.slice(3);
    if (x === 'R' || x === 'C') i += 1;   // rename/copy carries its origin in the next field
    const state = x === '?' ? 'untracked' : (x !== ' ' && x !== '?' ? 'staged' : 'unstaged');
    out.push({ path: name.replace(/\\/g, '/'), state });
  }
  return out;
}

function isTracked(root, relPath) {
  const r = git(root, ['ls-files', '--error-unmatch', '--', relPath]);
  return Boolean(r) && r.status === 0;
}

// The hard backstop: what is already dirty in the checkout a freeze, a preparation or a
// dispatch is about to write to. It inspects and reports; it never resets, cleans, stashes,
// overwrites, commits or moves anything.
function admit(targetRepoPath, options = {}) {
  const issues = (Array.isArray(options.issues) ? options.issues : [options.issue])
    .map((i) => String(i || '').trim()).filter(Boolean);
  const root = path.resolve(String(targetRepoPath || '.'));
  const place = locate(root);
  if (!place) return { admit: true, protected: false, target: root, refusals: [] };
  const ctx = contextFor(root);
  if (!ctx.protected) return { admit: true, protected: false, target: root, refusals: [] };

  const entries = porcelainEntries(place.root);
  if (entries === null) {
    return { admit: true, protected: true, target: place.root, refusals: [], undecidable: true };
  }

  const guarded = new Set(contract().admissionClasses || []);
  const refusals = [];
  for (const entry of entries) {
    const cls = classify(entry.path, ctx);
    if (cls === null || !guarded.has(cls)) continue;

    // Frozen-test provenance: this issue's own acceptance suite is exactly what a freeze is
    // there to commit, so it is the one protected change that arrives with a reason.
    const suite = /^tests\/acceptance\/([^/]+)\//.exec(entry.path);
    if (suite && issues.includes(suite[1])) continue;

    // Controller metadata, not a change to a frozen path: the freeze gate writes a receipt
    // beside every suite it judges, and an untracked one is that write and nothing else. The
    // same narrow rule `scripts/protected-tree.js` already makes for a sibling receipt.
    if (suite && entry.path.endsWith(`/${RECEIPT_NAME}`) && entry.state === 'untracked'
      && !isTracked(place.root, entry.path)) continue;

    refusals.push({ path: entry.path, state: entry.state, class: cls });
  }
  refusals.sort((a, b) => a.path.localeCompare(b.path));
  return { admit: refusals.length === 0, protected: true, target: place.root, refusals };
}

// The one refusal text, so a freeze, a preparation and a dispatch all say the same thing and
// name the same recovery command. Diagnostics list the EXACT paths, because "something is
// dirty" is not something a person can act on at nine at night.
function admissionRefusal(result, options = {}) {
  const label = String(options.label || 'this checkout');
  const issues = (Array.isArray(options.issues) ? options.issues : []).filter(Boolean);
  const lines = [
    `${label} carries changes to protected paths that no plan or frozen suite accounts for,`,
    'so nothing was staged, committed, promoted or dispatched. Nothing was reset, cleaned,',
    'stashed, overwritten or moved either — the files are exactly where you left them.',
    '',
  ];
  for (const entry of result.refusals) lines.push(`  ${String(entry.state).padEnd(9)} ${entry.path}`);
  lines.push('');
  lines.push('Move them to a Git-registered home of their own, originals left in place:');
  lines.push(`  node scripts/write-protection.js recover --target ${result.target}`
    + issues.map((i) => ` --issue ${i}`).join(''));
  lines.push('Then decide, file by file, whether each belongs in a plan or in a run.');
  return lines;
}

module.exports = {
  contract, contractFile: CONTRACT_FILE, admissionRefusal,
  classify, frozenPatterns, matches, regexFor,
  locate, contextFor, canonical, rel, within, isIgnored,
  hostStateDir, LEASE_DIR, OPTOUT_DIR, readRecords, findLease, liveOptOut,
  pidAlive, startIdentity, notExpired,
  tokenise, segments, stripHeredocs, readSegment, writeTargets, patchTargets,
  decide, admit, git, MARKER, RECEIPT_NAME,
};
