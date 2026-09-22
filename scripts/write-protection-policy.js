// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// The V1 decision procedure behind pipeline-first agent writes.
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
// Four things live here and nowhere else:
//
//   classify()   which class of the contract a repository-relative path belongs to
//   decide()     one write/shell/patch request in, one allow-or-deny verdict out
//   admit()      whether a real checkout may be mutated by a freeze, a preparation or a
//                dispatch, given what is already dirty in it
//   createLease()/revokeLease() controller-owned, short-lived test-author authority
//
// All three read `contracts/write-protection.json`, resolved from THIS FILE'S installation
// — never from the checkout being judged. A guard that read its policy out of the tree it
// is judging would let a session widen its own permissions with one edit. Admission is what
// catches an edit to the contract itself, because admission runs on the host over a
// checkout whose contract copy has no authority.
//
// AUTHORITY IS A HOST RECORD, NOT A FOLDER. A Git worktree is isolation, not permission:
// The test-author launcher writes a record outside every repository, binding the canonical
// target, Git common directory, issue suite, session nonce, controlling process (pid AND
// start identity), expiry and an unguessable token. A lease a
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
  // Resolve every existing symlink component, including a dangling final symlink. A plain
  // realpathSync on the full path fails when the destination has not yet been created, which
  // would otherwise let plans/link -> backend/new.py masquerade as a planning write.
  for (let hops = 0; hops < 40; hops += 1) {
    const parsed = path.parse(resolved);
    const parts = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean);
    let cursor = parsed.root;
    let redirected = false;
    for (let i = 0; i < parts.length; i += 1) {
      const candidate = path.join(cursor, parts[i]);
      let stat;
      try { stat = fs.lstatSync(candidate); } catch { cursor = candidate; continue; }
      if (!stat.isSymbolicLink()) { cursor = candidate; continue; }
      const link = fs.readlinkSync(candidate);
      resolved = path.resolve(path.dirname(candidate), link, ...parts.slice(i + 1));
      redirected = true;
      break;
    }
    if (!redirected) return WIN ? cursor.toLowerCase() : cursor;
  }
  throw new Error('symlink resolution exceeded 40 hops');
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

// Resolve the actual checkout and Git common directory. Linked worktrees share the common
// directory, but each is a distinct write target and a lease never crosses between them.
function locate(start) {
  let dir = path.resolve(start);
  for (;;) {
    const dotgit = path.join(dir, '.git');
    let st = null;
    try { st = fs.statSync(dotgit); } catch { st = null; }
    if (st && st.isDirectory()) return { root: dir, commonDir: dotgit, isMain: true };
    if (st && st.isFile()) {
      let commonDir = null;
      try {
        const found = git(dir, ['rev-parse', '--git-common-dir']);
        if (found.status === 0 && found.stdout.trim()) {
          commonDir = path.resolve(dir, found.stdout.trim());
        }
      } catch { /* no common directory means leases cannot authorize */ }
      return { root: dir, commonDir, isMain: false };
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
    ctx = {
      repo: true,
      protected: policy !== null,
      root: place.root,
      target: canonical(place.root),
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

// Every repo path is classified. An unknown source path is product, not a hole that bypasses
// the guard when a new project uses a directory this pipeline did not anticipate.
function classify(relPath, ctx, contractOverride) {
  const c = contractOverride || contract();
  const classes = c.pathClasses || {};
  const order = c.classPrecedence || Object.keys(classes);
  const clean = String(relPath).replace(/\\/g, '/').replace(/^\.\//, '');
  if (!clean || clean === '..' || clean.startsWith('../')) return null;
  for (const name of order) {
    const patterns = name === 'frozen' ? frozenPatterns(ctx) : (classes[name] || []);
    for (const pattern of patterns) {
      if (matches(pattern, clean)) return name;
    }
  }
  return 'product';
}

// ---- host state ---------------------------------------------------------------------------

// Outside every repository, by construction: a lease a model can reach is not a lease.
function hostStateDir() {
  const explicit = String(process.env.WRITE_PROTECTION_HOST_STATE_DIR || '').trim();
  const dir = explicit ? path.resolve(explicit)
    : path.join(os.homedir(), '.multi-agent-pipelines', 'write-protection');
  if (locate(dir)) throw new Error('host lease state must be outside every Git checkout');
  return dir;
}

const LEASE_DIR = 'leases';

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

// A PID alone can be recycled. Every lease records the controller's process start identity,
// and a hook checks it again before accepting a token.
function startIdentity(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (WIN) {
    const command = `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
      encoding: 'utf8', timeout: 5000, windowsHide: true,
    });
    const ticks = String(result.stdout || '').trim();
    return result.status === 0 && /^\d+$/.test(ticks) ? `windows:${ticks}` : null;
  }
  if (process.platform !== 'linux') return null;
  let raw;
  try { raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); } catch { return null; }
  const close = raw.lastIndexOf(')');
  if (close < 0) return null;
  const fields = raw.slice(close + 1).trim().split(/\s+/);
  return fields.length > 19 ? `linux:${fields[19]}` : null;
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

// The V1 launcher is the only supported lease issuer. It starts a model with file-edit tools
// only, then revokes this record in a finally block. The PID and expiration also invalidate
// a record if that cleanup cannot run.
function createLease(options = {}) {
  const role = String(options.role || '');
  if (role !== 'test-author') throw new Error('only test-author leases are supported');
  const issueId = String(options.issueId || '');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(issueId)) throw new Error('invalid issue ID');
  const sessionId = String(options.sessionId || '');
  if (sessionId.length < 16) throw new Error('session ID must be an unpredictable nonce');
  const target = canonical(options.target || '');
  const ctx = contextFor(target);
  if (!ctx.protected || !ctx.commonDir || canonical(ctx.root) !== target) {
    throw new Error('target must be an onboarded Git checkout');
  }
  const controllerPid = Number(options.controllerPid);
  if (!pidAlive(controllerPid)) throw new Error('controller process is not running');
  const controllerStart = startIdentity(controllerPid);
  if (!controllerStart) throw new Error('controller process start cannot be verified');
  const minutes = options.minutes === undefined ? 30 : Number(options.minutes);
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 120) {
    throw new Error('lease minutes must be in (0, 120]');
  }
  const state = canonical(hostStateDir());
  if (within(target, state)) throw new Error('host lease state must be outside target');
  const dir = path.join(state, LEASE_DIR);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const leaseId = crypto.randomBytes(18).toString('hex');
  const token = crypto.randomBytes(36).toString('base64url');
  const expiresAt = new Date(Date.now() + minutes * 60000).toISOString();
  const file = path.join(dir, `${leaseId}.json`);
  const record = {
    version: contract().version, leaseId, token, role, issueId, sessionId,
    target, gitCommonDir: ctx.commonDir,
    controllerPid, controllerStart, expiresAt,
  };
  fs.writeFileSync(file, `${JSON.stringify(record)}\n`, { flag: 'wx', mode: 0o600 });
  return { leaseId, token, file, expiresAt };
}

function revokeLease(leaseId) {
  const id = String(leaseId || '');
  if (!/^[a-f0-9]{36}$/.test(id)) return false;
  const file = path.join(hostStateDir(), LEASE_DIR, `${id}.json`);
  try { fs.unlinkSync(file); return true; }
  catch (error) { if (error && error.code === 'ENOENT') return false; throw error; }
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

// Conservative read-only shell commands. A guarded checkout can be inspected through shell,
// but all shell writes go through dedicated file-edit tools where the target path is explicit.
const READ_ONLY = new Set([
  'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'file',
  'stat', 'pwd', 'echo', 'printf', 'which', 'type', 'basename', 'dirname', 'realpath',
  'readlink', 'date', 'uniq', 'cut', 'tr', 'diff', 'comm', 'du', 'df', 'tree',
  'jq', 'md5sum', 'sha1sum', 'sha256sum', 'true', 'false', 'sleep',
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
  const targets = writeTargets(seg);
  if (!words.length) return { targets, reason: null };
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]) || PREFIXES.has(commandName(words[0]))
    || commandName(words[0]) === 'env' || /[\\/]/.test(words[0])) {
    return { targets, reason: 'unknown-shell-form' };
  }
  const name = commandName(words[0]);
  const rest = words.slice(1);

  if (name === 'git') {
    if (rest.some((arg) => /^(?:-c|--config-env|--exec-path|--output|--ext-diff|--textconv|--open-files-in-pager)(?:$|=)/.test(arg))) {
      return { targets, reason: 'unknown-shell-form' };
    }
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
  if (name === 'rg' && rest.some((arg) => /^--pre(?:$|=|-glob)/.test(arg))) {
    return { targets, reason: 'unknown-shell-form' };
  }
  if (READ_ONLY.has(name)) return { targets, reason: null };
  if (WRITERS.has(name)) return { targets, reason: 'pipeline-first' };
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
    m = /^(?:---|\+\+\+)\s+(?:[ab]\/)?(.+?)\s*$/.exec(line);
    if (m) {
      const named = m[1].split('\t')[0].trim();
      if (named !== '/dev/null') out.push(named);
      continue;
    }
    m = /^(?:rename|copy)\s+(?:from|to)\s+(.+?)\s*$/.exec(line);
    if (m) out.push(m[1]);
  }
  return out.map((p) => p.trim()).filter(Boolean);
}

// ---- the verdict ------------------------------------------------------------------------------

function verdict(decision, reason, isProtected) {
  return { decision, reason, protected: Boolean(isProtected) };
}

// One path, in the checkout it lands in. Returns null when there is nothing to refuse.
function judgePath(absPath, request) {
  const realPath = canonical(absPath);
  const ctx = contextFor(realPath);
  const token = request.token ? String(request.token) : '';
  if (token) {
    const lease = findLease(token);
    if (!lease) return { ctx, deny: 'lease-invalid' };
    const bad = leaseInvalid(lease, canonical(lease.target || ''), request.sessionId);
    if (bad) return { ctx, deny: bad };
    if (!ctx.protected || ctx.target !== canonical(lease.target)) return { ctx, deny: 'role-path' };
    const scopedPath = rel(ctx.root, realPath);
    if (!scopedPath || scopedPath === '..' || scopedPath.startsWith('../')) {
      return { ctx, deny: 'role-path' };
    }
    return { ctx, deny: roleDenial(lease, ctx, scopedPath, classify(scopedPath, ctx)) };
  }

  if (!ctx.repo || !ctx.protected) return { ctx, deny: null };
  const relPath = rel(ctx.root, realPath);
  if (!relPath || relPath === '..' || relPath.startsWith('../')) {
    return { ctx, deny: 'pipeline-first' };
  }
  const cls = classify(relPath, ctx);

  return { ctx, deny: cls === 'planning' ? null : 'pipeline-first' };
}

// Every way a lease fails to be one. Order matters only for the message a person reads.
function leaseInvalid(lease, targetOfPath, sessionId) {
  if (!lease || typeof lease !== 'object') return 'lease-invalid';
  if (lease.version !== contract().version) return 'lease-invalid';
  if (!notExpired(lease.expiresAt)) return 'lease-invalid';
  if (lease.role !== 'test-author') return 'lease-invalid';
  if (!sessionId || String(lease.sessionId || '') !== String(sessionId)) return 'lease-invalid';
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(String(lease.issueId || ''))) return 'lease-invalid';

  const leaseTarget = lease.target ? canonical(lease.target) : null;
  if (!leaseTarget) return 'lease-invalid';

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
  if (!now || !then || then !== now) return 'lease-invalid';

  if (targetOfPath !== leaseTarget) return 'lease-invalid';
  return null;
}

function roleDenial(lease, ctx, relPath, cls) {
  if (ctx.target !== canonical(lease.target) || cls !== 'frozen') return 'role-path';
  const issue = String(lease.issueId);
  return relPath.startsWith(`tests/acceptance/${issue}/`) ? null : 'role-path';
}

// One request in, one verdict out. `read`, and any action this has no opinion about, allows.
function decide(request) {
  const req = request && typeof request === 'object' ? request : {};
  const action = String(req.action || '');
  const cwd = req.cwd ? path.resolve(String(req.cwd)) : process.cwd();
  const cwdContext = contextFor(cwd);

  if (action !== 'write' && action !== 'shell' && action !== 'patch') {
    return verdict('allow', 'not-a-mutation', cwdContext.protected);
  }

  // A test-author lease never grants command execution, including apparently read-only
  // commands. There is no sound path-scoping rule for shell/interpreter side effects.
  if (action === 'shell' && req.token) {
    const lease = findLease(String(req.token));
    if (!lease) return verdict('deny', 'lease-invalid', cwdContext.protected);
    const bad = leaseInvalid(lease, canonical(lease.target || ''), req.sessionId);
    return verdict('deny', bad || 'test-author-shell', true);
  }

  let paths = [];
  let formReason = null;
  if (action === 'write') {
    const raw = String(req.path || '');
    if (!raw) return verdict(cwdContext.protected || req.token ? 'deny' : 'allow',
      cwdContext.protected || req.token ? 'unknown-write-form' : 'unprotected',
      cwdContext.protected || Boolean(req.token));
    paths = [path.resolve(cwd, raw)];
  } else if (action === 'patch') {
    const named = patchTargets(req.patch);
    if (!named.length) formReason = 'unknown-patch-form';
    paths = named.map((p) => path.resolve(cwd, p));
  } else {
    const command = String(req.command || '');
    // Variable expansion, command substitution and delayed environment expansion make a
    // command's path operands unknowable to this reader. Refuse those forms in a guarded cwd.
    if (cwdContext.protected && /[$`%!]/.test(command)) {
      return verdict('deny', 'unknown-shell-form', true);
    }
    const tokens = tokenise(stripHeredocs(command));
    const parts = segments(tokens);
    if (!parts.length) return verdict('allow', 'empty-command', contextFor(cwd).protected);
    for (const seg of parts) {
      const read = readSegment(seg);
      if (read.reason && !formReason) formReason = read.reason;
      paths.push(...read.targets.map((p) => path.resolve(cwd, p)));
    }
    if (paths.length && !formReason) formReason = 'pipeline-first';
  }

  let isProtected = cwdContext.protected || Boolean(req.token);
  for (const abs of paths) {
    const { ctx, deny } = judgePath(abs, req);
    if (ctx.protected) isProtected = true;
    if (deny) return verdict('deny', deny, true);
  }

  // Unknown forms are denied even when a lease is present. A role/path lease is not authority
  // to run a command whose effects the policy cannot see.
  if (formReason && isProtected) return verdict('deny', formReason, true);
  return verdict('allow', isProtected ? 'authorized' : 'unprotected', isProtected);
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
    const state = x === '?' ? 'untracked' : (x !== ' ' && x !== '?' ? 'staged' : 'unstaged');
    out.push({ path: name.replace(/\\/g, '/'), state });
    // Porcelain -z puts a rename/copy origin in the next NUL field. Both ends matter:
    // moving product source to a planning path must not make the product deletion vanish.
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
      const origin = fields[i + 1];
      if (origin) out.push({ path: origin.replace(/\\/g, '/'), state });
      i += 1;
    }
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
    return { admit: false, protected: true, target: place.root, refusals: [], undecidable: true };
  }

  const guarded = new Set(contract().admissionClasses || []);
  const refusals = [];
  for (const entry of entries) {
    const cls = classify(entry.path, ctx);
    if (!guarded.has(cls)) continue;

    // Frozen-test provenance: this issue's own acceptance suite is exactly what a freeze is
    // there to commit, so it is the one protected change that arrives with a reason.
    const suite = /^tests\/acceptance\/([^/]+)\//.exec(entry.path);
    if (suite && issues.includes(suite[1])) continue;

    // Controller metadata, not a change to a frozen path: the freeze gate writes a receipt
    // beside every suite it judges, and an untracked one is that write and nothing else. The
    // same narrow rule `scripts/protected-tree.js` already makes for a sibling receipt.
    if (suite && issues.includes(suite[1]) && entry.path.endsWith(`/${RECEIPT_NAME}`) && entry.state === 'untracked'
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
  if (result.undecidable) return [
    `Git status could not be read for ${label}; pipeline admission cannot verify its paths.`,
    `Inspect ${result.target} and retry after Git status works. No files were changed.`,
  ];
  const lines = [
    `${label} carries changes to protected paths that no plan or frozen suite accounts for,`,
    'so nothing was staged, committed, promoted or dispatched. Nothing was reset, cleaned,',
    'stashed, overwritten or moved either — the files are exactly where you left them.',
    '',
  ];
  for (const entry of result.refusals) lines.push(`  ${String(entry.state).padEnd(9)} ${entry.path}`);
  lines.push('');
  lines.push(`Review the listed paths in ${result.target} with git status and move unrelated work`);
  lines.push('to its own checkout before retrying. Preserve the original files during review.');
  return lines;
}

module.exports = {
  contract, contractFile: CONTRACT_FILE, admissionRefusal,
  classify, frozenPatterns, matches, regexFor,
  locate, contextFor, canonical, rel, within,
  hostStateDir, LEASE_DIR, readRecords, findLease, createLease, revokeLease,
  pidAlive, startIdentity, notExpired,
  tokenise, segments, stripHeredocs, readSegment, writeTargets, patchTargets,
  decide, admit, git, MARKER, RECEIPT_NAME,
};
