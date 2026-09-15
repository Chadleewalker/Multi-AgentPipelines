// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// Setup containment for the test-author stage — DESIGN.md §4.3.
//
// The coordinator has already read Beads once and embedded the issue in an immutable brief.
// A Codex author session, however, reaches its own shell freely: one `bd prime` reloads the
// target project's entire memory corpus into a context that was deliberately bounded. Two
// author attempts consumed 231 memories each and exited zero having written no suite.
//
// Containment is mechanical rather than advisory, and it travels in the ENVIRONMENT: the
// Codex author argv is pinned byte for byte by tests/acceptance/repo-45g, so a flag is not
// available even if one existed. A `bd` shim leads the author's PATH, every invocation of it
// is refused within a hard character bound, and the host's own `bd` overrides are removed so
// there is no second door onto the same corpus. Claude closes Beads a different way — its
// `--disallowedTools` already carries `Bash(bd *)` — and keeps doing so unchanged.
//
// The shim is disposable state, not a cache. One root is created per launch, it is needed only
// for the lifetime of a synchronous provider process, and a conveyor of ideas would otherwise
// accumulate one ignored directory per author session forever. So every root this module creates
// carries an ownership marker holding a fresh per-launch nonce, `prepare` hands back an opaque
// handle naming the exact roots it created, and `dispose` removes those literal paths and nothing
// else: no parent is ever enumerated, so two concurrent launches are independent by construction
// and a foreign directory that merely looks like ours is refused rather than swept.
//
// Node built-ins only, synchronous, and free of any repository require, so the author stage
// can build a launch environment without loading config, Beads or a container engine.
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

// The hard ceiling on EVERYTHING one contained `bd` invocation may emit across both streams.
// This is what makes a corpus dump impossible rather than merely discouraged: a truncation
// bound large enough to carry memories would satisfy "concise" and still leak the corpus.
const REFUSAL_MAX_CHARS = 240;

// Distinct from 1 (a bd query that legitimately found nothing) and from 127 (bd absent), so a
// refusal is legible in a transcript rather than looking like a broken host.
const REFUSAL_EXIT = 78;

// The host-side doors onto the same corpus. runner/bd.js honours PIPELINE_BD_CMD, and the
// stub seams the Docker-free suites use answer on the other three; a contained session that
// inherited any of them would route around the shim entirely.
const BD_OVERRIDE_NAMES = Object.freeze(['PIPELINE_BD_CMD', 'BD_ARGS_LOG', 'BD_STUB_OUT', 'BD_STUB_EXIT']);

// Written into every root this module creates, before any other content, and holding that
// launch's nonce. Ownership is therefore proven by something only this process wrote — never by
// a directory's name, its prefix or the fact that it sits under a root we also use.
const OWNERSHIP_MARKER_NAME = '.author-containment-owner';

// A cleanup failure reaches an operator's terminal and a run report, so it names the ROLES that
// could not be removed and nothing else: no host path, no OS error text, no provider output.
const CLEANUP_ERROR_MAX_CHARS = 200;

// What the author is told in the brief, so containment is an explained boundary rather than a
// tool that mysteriously fails. The module owns this wording; scripts/spec-brief.js emits it.
const BRIEF_NOTICE = Object.freeze([
  'BEADS IS CLOSED FOR THIS SESSION. The issue above is already snapshotted into this brief,',
  'criteria and all, so `bd` is intercepted on your PATH and every invocation — prime, show,',
  'memories — is refused in one line. Reloading the whole project memory corpus is what left',
  'two earlier author sessions with no suite written at all. Work from the criteria here.',
]);

// The same shape runner/queue.js and scripts/spec-brief.js accept. An id is interpolated into
// two shell scripts below, so it is validated rather than quoted.
const SAFE_ISSUE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function safeIssueId(value) {
  const id = String(value == null ? '' : value).trim();
  return SAFE_ISSUE_ID.test(id) && id.length <= 80 ? id : null;
}

// One line, naming the snapshotted issue and why the tool is closed. Deliberately free of
// quotes, `%`, and cmd.exe's metacharacters so it survives both shim dialects verbatim.
function refusalText(issueId) {
  return `bd is closed for this author session: ${issueId} is already snapshotted in your brief.`
    + ' Work from the criteria there.';
}

// A real directory, never a symlink someone else can aim elsewhere: the shim is executable and
// leads the author's PATH, so the path it resolves through is a trust boundary.
function realDir(target, mode) {
  let stat = null;
  try { stat = fs.lstatSync(target); } catch { /* absent, created below */ }
  if (stat && stat.isSymbolicLink()) {
    throw new Error(`author containment path is a symlink: ${target}`);
  }
  if (stat && !stat.isDirectory()) {
    throw new Error(`author containment path is not a directory: ${target}`);
  }
  if (!stat) fs.mkdirSync(target, { recursive: true, mode });
}

// The one shared parent every shim root is created directly beneath. It is a durable, mode-0700
// cache root: launches create and remove children of it, never the root itself.
function containmentParent() {
  const root = path.join(os.tmpdir(), 'multi-agent-author-containment');
  realDir(root, 0o700);
  return root;
}

// Where an executable shim can be staged when the temp mount itself refuses execution. Both are
// durable parents shared by every launch, so — like the shim parent — they are created and left
// alone; only the per-launch child beneath them is ever removed.
function defaultFallbackParents() {
  const parents = [path.resolve(__dirname, '..', 'runs', 'author-containment')];
  const cache = process.env.LOCALAPPDATA
    || process.env.XDG_CACHE_HOME
    || (os.homedir() ? path.join(os.homedir(), '.cache') : null);
  if (cache) parents.push(path.join(cache, 'multi-agent-pipelines', 'author-containment'));
  return parents;
}

// Outside the author's worktree by construction: anything written inside it would show up in
// the boundary audit as an edit the author may not make. FRESH on every call, including two
// launches of the same issue id — a shared per-issue directory cannot be disposed by either of
// two concurrent authors without breaking the other.
function containmentDir(issueId) {
  const id = safeIssueId(issueId);
  if (!id) throw new Error(`author containment needs a safe issue id, got ${JSON.stringify(issueId)}`);
  return fs.mkdtempSync(path.join(containmentParent(), `${id}-`));
}

// Execution usability without spawning anything. A noexec mount is exactly what `access(X_OK)`
// reports on: the kernel refuses the execute bit for a regular file there, so this answers the
// noexec question that matters while a hardened verifier's restricted tmpfs — where spawning a
// freshly written temp file may fail for reasons that have nothing to do with the mount — stays
// out of the decision entirely.
function defaultSelfTest(candidate) {
  try {
    fs.accessSync(path.join(candidate, process.platform === 'win32' ? 'bd.cmd' : 'bd'), fs.constants.X_OK);
    return true;
  } catch { return false; }
}

// Write the interception shim into `root` under both names, so it wins PATH lookup from a POSIX
// shell (`bd`, mode 0755) and from cmd.exe (`bd.cmd`, found through PATHEXT) alike. Every
// invocation — with any subcommand or none — exits non-zero and says the same bounded thing.
function writeShims(root, id) {
  const message = refusalText(id);
  const posix = path.join(root, 'bd');
  const windows = path.join(root, 'bd.cmd');
  // printf with a literal format and the message as an argument: no expansion of anything the
  // issue id could carry, and exactly one trailing newline on stderr.
  fs.writeFileSync(posix, [
    '#!/bin/sh',
    '# Beads interception for one contained test-author session. Written by',
    '# runner/author-containment.js; every subcommand is refused, bounded, and corpus-free.',
    `printf '%s\\n' '${message}' >&2`,
    `exit ${REFUSAL_EXIT}`,
    '',
  ].join('\n'));
  try { fs.chmodSync(posix, 0o755); } catch { /* Windows carries no mode bits */ }
  fs.writeFileSync(windows, [
    '@echo off',
    'rem Beads interception for one contained test-author session.',
    `>&2 echo ${message}`,
    `exit /b ${REFUSAL_EXIT}`,
    '',
  ].join('\r\n'));
}

// The marker goes down BEFORE the shim: a root that carries shim content but no marker is one
// this module cannot prove it owns, and it would rather leak that root than delete it.
function claimRoot(root, nonce) {
  realDir(root, 0o700);
  fs.writeFileSync(path.join(root, OWNERSHIP_MARKER_NAME), `${nonce}\n`, { mode: 0o600 });
}

// A fresh child of one shared fallback parent. The parent is created when absent and is never
// tracked for rollback or disposal — it is shared, durable, and not this launch's to remove.
function stageCandidate(parent, id, nonce) {
  const parentDir = path.resolve(String(parent));
  fs.mkdirSync(parentDir, { recursive: true, mode: 0o700 });
  const candidate = fs.mkdtempSync(path.join(parentDir, `${id}-`));
  claimRoot(candidate, nonce);
  return candidate;
}

function bounded(text) {
  const line = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  return line.length > CLEANUP_ERROR_MAX_CHARS ? `${line.slice(0, CLEANUP_ERROR_MAX_CHARS - 1)}…` : line;
}

// Remove roots created during one failed prepare(). The caller's original error is what a human
// needs; a failure here is reported beside it, in role terms, never in place of it.
function rollback(roots) {
  const failed = [];
  for (let i = roots.length - 1; i >= 0; i -= 1) {
    try { fs.rmSync(roots[i], { recursive: true, force: true }); }
    catch { failed.push(i === 0 ? 'shim' : `fallback[${i - 1}]`); }
  }
  return failed.length
    ? bounded(`author-containment rollback could not remove: ${failed.reverse().join(', ')}`)
    : null;
}

// Build one launch's containment. `dir` is tried first; when it fails its own execution
// self-test — a noexec temp mount is the real case — a candidate is staged under each fallback
// parent in turn until one is usable. Every root actually created is recorded in the returned
// handle, including a candidate that failed, so disposal can reach all of them later. If nothing
// is usable, every root created during this call is rolled back and no handle is returned.
function prepare(dir, options = {}) {
  const created = [];
  const fallbackRoots = [];
  try {
    const id = safeIssueId(options && options.issueId);
    if (!id) throw new Error(`author containment needs a safe issue id, got ${JSON.stringify(options && options.issueId)}`);
    if (typeof dir !== 'string' || !dir.trim()) throw new Error('author containment needs a directory');
    const opts = options || {};
    const selfTest = typeof opts.selfTest === 'function' ? opts.selfTest : defaultSelfTest;
    const parents = Array.isArray(opts.fallbackParents) ? opts.fallbackParents : defaultFallbackParents();
    const nonce = crypto.randomBytes(16).toString('hex');

    const shimRoot = path.resolve(dir);
    claimRoot(shimRoot, nonce);
    created.push(shimRoot);
    writeShims(shimRoot, id);
    let usable = selfTest(shimRoot) ? shimRoot : null;

    for (const parent of parents) {
      if (usable) break;
      const candidate = stageCandidate(parent, id, nonce);
      created.push(candidate);
      fallbackRoots.push(candidate);
      writeShims(candidate, id);
      if (selfTest(candidate)) usable = candidate;
    }
    if (!usable) {
      throw new Error(`no author containment root is executable: ${created.length} candidate(s) failed the execution self-test`);
    }
    return {
      ok: true,
      dir: usable,
      issueId: id,
      names: ['bd', 'bd.cmd'],
      handle: { issueId: id, nonce, shimRoot, fallbackRoots },
    };
  } catch (error) {
    return {
      ok: false,
      error: bounded((error && error.message) || String(error)),
      rollbackError: rollback(created),
      handle: null,
    };
  }
}

// A NEW environment in which the shim leads PATH and the host bd overrides are gone. Everything
// else survives untouched: containment closes Beads, not the stage's own environment, which
// still carries licence paths and off-PATH binaries the author legitimately needs.
function applyEnv(baseEnv, prepared) {
  const source = baseEnv && typeof baseEnv === 'object' ? baseEnv : {};
  if (!prepared || typeof prepared.dir !== 'string' || !prepared.dir) {
    throw new Error('applyEnv needs a prepared containment directory');
  }
  const dir = path.resolve(prepared.dir);
  const env = {};
  // Windows spells it `Path`, a caller may have added `PATH`, and a child reads whichever it
  // happens to look for — so they collapse into one key here, spelled PATH.
  let explicit = null;
  let other = null;
  for (const [key, value] of Object.entries(source)) {
    if (key.toLowerCase() === 'path') {
      if (key === 'PATH') explicit = value;
      else if (other === null) other = value;
      continue;
    }
    if (BD_OVERRIDE_NAMES.includes(key)) continue;
    env[key] = value;
  }
  const inherited = explicit === null ? other : explicit;
  const rest = typeof inherited === 'string' && inherited ? `${path.delimiter}${inherited}` : '';
  env.PATH = `${dir}${rest}`;
  return env;
}

// Everything a handle has to be before dispose() will look at the filesystem at all. A path, a
// string, a `{ dir }` from some other launcher or a partially-shaped object is refused outright.
function isHandle(handle) {
  return !!handle && typeof handle === 'object' && !Array.isArray(handle)
    && typeof handle.nonce === 'string' && handle.nonce.length > 0
    && typeof handle.shimRoot === 'string' && handle.shimRoot.length > 0
    && typeof handle.issueId === 'string' && handle.issueId.length > 0
    && Array.isArray(handle.fallbackRoots)
    && handle.fallbackRoots.every((root) => typeof root === 'string' && root.length > 0);
}

// Remove one owned root, or refuse it. Ownership is four separate questions, and a no to any of
// them means the directory stays exactly as it is: it must be a real directory rather than a
// symlink or reparse point (which would make removal reach into someone else's tree), it must sit
// directly under a parent the caller declared safe, and it must carry our marker holding THIS
// launch's nonce. A root that is already gone was already disposed, which is success.
function removeOwned(root, parents, nonce) {
  let stat = null;
  try { stat = fs.lstatSync(root); }
  catch (error) { return error && error.code === 'ENOENT'; }
  if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
  if (!parents.includes(path.dirname(root))) return false;
  let marker = null;
  try { marker = fs.readFileSync(path.join(root, OWNERSHIP_MARKER_NAME), 'utf8'); }
  catch { return false; }
  if (marker.trim() !== nonce) return false;
  // Only this literal path, and only its own contents: the parent is never read.
  try { fs.rmSync(root, { recursive: true, force: true }); }
  catch { return false; }
  try { fs.lstatSync(root); return false; }
  catch (error) { return !!error && error.code === 'ENOENT'; }
}

// Dispose one launch's containment. Every owned root is attempted even when an earlier one
// fails, and the single bounded error names only the failed roles.
function dispose(handle, options = {}) {
  if (!isHandle(handle)) {
    return { ok: false, error: 'author-containment dispose refused: not a launch handle' };
  }
  const opts = options || {};
  const shimParents = typeof opts.shimParent === 'string' && opts.shimParent.trim()
    ? [path.resolve(opts.shimParent)] : [];
  const fallbackParents = (Array.isArray(opts.fallbackParents) ? opts.fallbackParents : defaultFallbackParents())
    .filter((parent) => typeof parent === 'string' && parent.trim())
    .map((parent) => path.resolve(parent));

  // The shim root first, then the fallbacks longest path first, so a nested root can never be
  // orphaned by the removal of something above it.
  const targets = [{ role: 'shim', root: path.resolve(handle.shimRoot), parents: shimParents }];
  handle.fallbackRoots
    .map((root, index) => ({ role: `fallback[${index}]`, root: path.resolve(root), parents: fallbackParents }))
    .sort((a, b) => b.root.length - a.root.length)
    .forEach((target) => targets.push(target));

  const failed = [];
  for (const target of targets) {
    if (!removeOwned(target.root, target.parents, handle.nonce)) failed.push(target.role);
  }
  return failed.length
    ? { ok: false, error: bounded(`author-containment dispose failed for: ${failed.join(', ')}`) }
    : { ok: true };
}

// The one call the author stage makes before the provider: build this launch's containment and
// hand back both the launch environment and the host-owned session the caller disposes after the
// provider settles. The session never reaches the child — only `env` does.
function beginLaunch(baseEnv, issueId, options = {}) {
  const opts = options || {};
  const fallbackParents = Array.isArray(opts.fallbackParents) ? opts.fallbackParents : defaultFallbackParents();
  let dir = null;
  let shimParent = null;
  try {
    dir = containmentDir(issueId);
    shimParent = path.dirname(path.resolve(dir));
  } catch (error) {
    return { ok: false, error: bounded((error && error.message) || String(error)) };
  }
  const prepared = prepare(dir, { issueId, fallbackParents, selfTest: opts.selfTest });
  if (!prepared.ok) {
    return { ok: false, error: prepared.error, rollbackError: prepared.rollbackError || null };
  }
  return {
    ok: true,
    env: applyEnv(baseEnv, prepared),
    handle: prepared.handle,
    shimParent,
    fallbackParents,
  };
}

// The mirror of beginLaunch, called once the provider process has settled or thrown.
function endLaunch(session) {
  if (!session || !session.ok) return { ok: false, error: 'author-containment dispose refused: no launch session' };
  return dispose(session.handle, { shimParent: session.shimParent, fallbackParents: session.fallbackParents });
}

// Backward-compatible one-shot: containment with no disposal handle returned to the caller.
// Prefer beginLaunch/endLaunch, which is what lets a launch clean up after itself.
function containEnv(baseEnv, issueId) {
  const prepared = prepare(containmentDir(issueId), { issueId });
  if (!prepared.ok) throw new Error(prepared.error);
  return applyEnv(baseEnv, prepared);
}

module.exports = {
  REFUSAL_MAX_CHARS, REFUSAL_EXIT, BRIEF_NOTICE, BD_OVERRIDE_NAMES, OWNERSHIP_MARKER_NAME,
  refusalText, containmentDir, containmentParent, defaultFallbackParents,
  prepare, dispose, applyEnv, containEnv, beginLaunch, endLaunch,
};
