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

// The one file that says a containment root belongs to a particular launch. Its content is a
// nonce only this launch knows, and it is the first thing written into a root that is kept —
// name, prefix and shared parent are each matched equally by a concurrent author, a foreign
// lookalike and a directory re-created at a once-owned path, so none of them is evidence.
const OWNERSHIP_MARKER_NAME = '.author-containment-owner';

// The single shared parent every per-launch shim root is created beneath. It is never
// enumerated and never swept: removal always names one exact literal path.
const CONTAINMENT_ROOT_NAME = 'multi-agent-author-containment';

// How much of a failure report may be spent naming roles. Rollback and disposal failures speak
// roles ("shim", "fallback[0]") and nothing else — never a host path, an OS errno string, or
// any provider output, all three of which are either private or attacker-influenced.
const ROLE_TEXT_MAX_CHARS = 160;

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

// The one shared parent. Every launch's shim root is a fresh child of it, which is what makes
// a per-launch root disposable without any launch ever consulting the parent's contents.
function containmentRoot() {
  const root = path.join(os.tmpdir(), CONTAINMENT_ROOT_NAME);
  realDir(root, 0o700);
  return root;
}

// Outside the author's worktree by construction: anything written inside it would show up in
// the boundary audit as an edit the author may not make. A fresh directory PER CALL, even for
// one issue id — two author sessions for the same issue may run at once, and a shared root
// would make either one's disposal reach into the other's live containment.
function containmentDir(issueId) {
  const id = safeIssueId(issueId);
  if (!id) throw new Error(`author containment needs a safe issue id, got ${JSON.stringify(issueId)}`);
  return fs.mkdtempSync(path.join(containmentRoot(), `${id}-`));
}

// Where a candidate goes when the shim root's own filesystem cannot carry an executable. Kept
// free of any repository require: the durable state root, or the user's home beneath it.
function fallbackParentDirs() {
  const stateRoot = String(process.env.PIPELINE_STATE_DIR || '').trim()
    || path.join(os.homedir() || os.tmpdir(), '.multi-agent-pipelines');
  return [path.join(stateRoot, 'author-containment')];
}

// Can a generated file on this filesystem carry an executable bit at all? Deliberately NOT a
// spawn: the hardened verifier's temp mount may refuse to execute anything, and spawnSync in a
// restricted sandbox answers EPERM — a spawn-based probe would read either as "this root is
// unusable" and fall back forever. The probe file is transient and removed before the ownership
// marker becomes the root's first retained content.
//
// Two outcomes, and only two. A probe whose exec bit did NOT survive returns `false`: the root
// is fine, this FILESYSTEM cannot carry an executable, so the candidate is retained for disposal
// and fallback is permitted. But a probe whose write, chmod, or stat itself FAILS is not a
// usability answer at all — a failed observation must never be reported as "usable". Such an
// error is left to propagate so prepare()'s construction-failure handling rolls this exact root
// back and, only once that succeeds, tries the next candidate; returning `true` here would assert
// a candidate is runnable on the strength of a probe that never completed.
function defaultSelfTest(root) {
  if (process.platform === 'win32') return true;
  const probe = path.join(root, `.exec-probe-${process.pid}`);
  try {
    fs.writeFileSync(probe, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    fs.chmodSync(probe, 0o755);
    return (fs.statSync(probe).mode & 0o100) !== 0;
  } finally {
    try { fs.rmSync(probe, { force: true }); } catch { /* best effort */ }
  }
}

// The first content written into a root that is kept, so an interrupted construction can never
// leave behind a root that looks owned to a later disposal.
function writeOwnershipMarker(root, nonce) {
  fs.writeFileSync(path.join(root, OWNERSHIP_MARKER_NAME), `${nonce}\n`, { mode: 0o600 });
}

// null: no marker at all. undefined: a marker we could not read, which is not an answer and is
// never treated as one. Otherwise the recorded nonce.
function readOwnershipMarker(root) {
  try { return fs.readFileSync(path.join(root, OWNERSHIP_MARKER_NAME), 'utf8').trim(); }
  catch (error) { return error && error.code === 'ENOENT' ? null : undefined; }
}

// Remove ONE exact literal path, or refuse. Never a pattern, never a prefix, never a parent's
// contents: a concurrent launch's root lives in that same shared parent, and enumerating it is
// the one mistake that would let either launch delete the other's live containment.
//
// `requireMarker` is true once this root's ownership initialization has completed — from then
// on an absent or mismatched marker means the path is no longer the thing we created, and
// removing it would be a guess. Before that point the marker is not yet a fact about the root,
// so a root carrying no marker at all is still removable through the exact path this call
// created moments earlier, while a marker naming SOMEONE ELSE is refused either way.
function removeOwnedRoot(root, nonce, options = {}) {
  try {
    const target = path.resolve(root);
    const parents = options.parents || null;
    if (parents && !parents.includes(path.dirname(target))) return false;
    let stat = null;
    try { stat = fs.lstatSync(target); }
    catch (error) { return Boolean(error && error.code === 'ENOENT'); }
    // A reparse point substituted for an owned root points somewhere this launch never created
    // and has no right to remove; refusing also leaves the link itself in place as evidence.
    if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
    const marker = readOwnershipMarker(target);
    if (marker === undefined) return false;
    if (marker === null) { if (options.requireMarker) return false; }
    else if (marker !== nonce) return false;
    fs.rmSync(target, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

function roleText(roles) {
  const text = roles.join(', ');
  return text.length <= ROLE_TEXT_MAX_CHARS ? text : `${text.slice(0, ROLE_TEXT_MAX_CHARS - 3)}...`;
}

function rollbackErrorText(roles) {
  return `author-containment rollback failed for: ${roleText(roles)}`;
}

function disposeErrorText(roles) {
  return `author-containment dispose failed for: ${roleText(roles)}`;
}

// Bounded, role-only, and free of the underlying error: an OS errno string carries a host path,
// and provider output is not ours to repeat. What a reader can act on is which root failed.
function constructionErrorText(role) {
  return `author containment could not initialize its owned root (${role});`
    + ' the contained launch was not started.';
}

// Claim one shim name inside a root this call is initializing: create it empty and EXCLUSIVELY,
// before either name carries a byte. Two things fall out of reserving the pair first. A root
// that already holds a `bd` or a `bd.cmd` this call did not write is not a root we own, and
// overwriting it would be exactly the guess `removeOwnedRoot` refuses to make — exclusive
// creation turns that into an ordinary ownership-initialization failure, rolled back with the
// rest of the candidate. And the pair is reserved as a unit, so a failure part-way through
// leaves a visibly incomplete root rather than one advertising only the dialect that happened
// to land first.
function reserveShimName(target, mode) {
  fs.closeSync(fs.openSync(target, 'wx', mode));
}

// Write the interception shim into `root` under both names, so it wins PATH lookup from a POSIX
// shell (`bd`, mode 0755) and from cmd.exe (`bd.cmd`, found through PATHEXT) alike. Every
// invocation — with any subcommand or none — exits non-zero and says the same bounded thing.
function writeShims(root, id) {
  const message = refusalText(id);
  const posix = path.join(root, 'bd');
  const windows = path.join(root, 'bd.cmd');
  reserveShimName(posix, 0o700);
  reserveShimName(windows, 0o600);
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

// Build one contained root for this launch, falling back through `fallbackParents` when a
// candidate's filesystem cannot carry an executable, and return the per-launch handle that
// disposal — and construction-time rollback — name their exact paths from.
//
// ORDER IS THE CONTRACT. Per candidate: create the directory, REGISTER it in the handle, then
// self-test it, then write its ownership marker, then its two shims. Registration happens
// before the first byte of ownership initialization is written, so a candidate that dies
// part-way through — its marker write, either shim write, or a self-test that throws instead of
// answering — is still a path this call can name and remove exactly. Rolling it back at once is
// what keeps a half-built root from outliving the launch that made it; the conveyor must leave
// no owned containment directory behind on any construction failure.
//
// A self-test that answers `false` is a different thing entirely: the root is fine, this
// FILESYSTEM cannot run the shim. Such a candidate is marked and retained, exactly as
// repo-djf.40 fixed, so dispose() removes it with the rest of the launch.
//
// AND A ROLLBACK THAT REFUSES ENDS THE SEARCH. A candidate this call cannot prove it removed is
// not something a later, usable fallback candidate makes up for: the whole preparation fails,
// no launch environment is built, and the unaccountable root is left exactly as it stands, as
// evidence for the human it now belongs to.
function prepare(dir, options = {}) {
  const id = safeIssueId(options && options.issueId);
  if (!id) throw new Error(`author containment needs a safe issue id, got ${JSON.stringify(options && options.issueId)}`);
  if (typeof dir !== 'string' || !dir.trim()) throw new Error('author containment needs a directory');
  const parents = (Array.isArray(options.fallbackParents) ? options.fallbackParents : [])
    .filter((parent) => typeof parent === 'string' && parent.trim());
  const selfTest = typeof options.selfTest === 'function' ? options.selfTest : defaultSelfTest;

  const nonce = crypto.randomBytes(24).toString('hex');
  const handle = { issueId: id, nonce, shimRoot: path.resolve(dir), fallbackRoots: [] };
  const owned = [];          // exact roots created by this call that are still on disk
  const rollbackRoles = [];  // roles whose rollback itself failed, in attempt order
  let constructionError = null;

  // True when this exact root is accounted for — removed, or already gone. False when removal
  // refused or errored, which is the one answer that ends the search below.
  const rollback = (entry) => {
    if (removeOwnedRoot(entry.root, nonce, { requireMarker: entry.marked })) return true;
    rollbackRoles.push(entry.role);
    return false;
  };

  const candidates = [{
    role: 'shim',
    create: () => { realDir(handle.shimRoot, 0o700); return handle.shimRoot; },
  }];
  parents.forEach((parent, index) => candidates.push({
    role: `fallback[${index}]`,
    create: () => {
      const resolved = path.resolve(parent);
      realDir(resolved, 0o700);
      const root = fs.mkdtempSync(path.join(resolved, `author-containment-${id}-`));
      handle.fallbackRoots.push(root);
      return root;
    },
  }));

  for (const candidate of candidates) {
    let entry = null;
    try {
      entry = { role: candidate.role, root: candidate.create(), marked: false };
      owned.push(entry);
      const usable = Boolean(selfTest(entry.root));
      writeOwnershipMarker(entry.root, nonce);
      entry.marked = true;
      if (!usable) continue;
      writeShims(entry.root, id);
      return { ok: true, dir: entry.root, issueId: id, names: ['bd', 'bd.cmd'], handle };
    } catch {
      if (!constructionError) constructionError = constructionErrorText(candidate.role);
      // A REFUSED OR FAILED ROLLBACK ENDS THE WHOLE PREPARATION. Recovering through the next
      // fallback candidate here would start a contained session while a directory this call
      // created, and cannot account for, is still standing under its authority: its ownership
      // marker is gone, names someone else, or the root has been swapped for a reparse point,
      // so from the outside "safely cleaned up" and "someone else's data now sits where our
      // shim used to be" are the same picture. A later candidate being perfectly usable does
      // not make that directory explained, so the search stops here and the failure is
      // reported rather than recovered from. A creation that threw before any root existed
      // leaves nothing to account for, and construction continues as before.
      if (entry) {
        owned.splice(owned.indexOf(entry), 1);
        if (!rollback(entry)) break;
      }
    }
  }

  // No candidate ever became a contained root, so nothing this call created is wanted: attempt
  // every remaining owned root regardless of an earlier rollback failure, and report the
  // primary construction error with the rollback's own trouble attached beside it, never on top
  // of it.
  for (const entry of owned.splice(0)) rollback(entry);
  return {
    ok: false,
    error: constructionError
      || 'author containment found no root whose filesystem can carry an executable shim.',
    rollbackError: rollbackRoles.length ? rollbackErrorText(rollbackRoles) : null,
    handle: null,
  };
}

// Only a handle shaped like prepare()'s own is ever acted on. A bare path, a string, a partial
// object or a number is refused before the filesystem is touched at all.
function readHandle(handle) {
  if (!handle || typeof handle !== 'object' || Array.isArray(handle)) return null;
  const issueId = safeIssueId(handle.issueId);
  const nonce = typeof handle.nonce === 'string' ? handle.nonce.trim() : '';
  const shimRoot = typeof handle.shimRoot === 'string' ? handle.shimRoot.trim() : '';
  if (!issueId || !nonce || !shimRoot || !Array.isArray(handle.fallbackRoots)) return null;
  const fallbackRoots = [];
  for (const root of handle.fallbackRoots) {
    if (typeof root !== 'string' || !root.trim()) return null;
    fallbackRoots.push(root);
  }
  return { issueId, nonce, shimRoot, fallbackRoots };
}

// Remove exactly the roots one launch owns, and nothing else. Every root must sit directly
// under a parent the caller declares, must not be a reparse point, and must carry this
// launch's own nonce; a root that is already gone counts as disposed. Every root is attempted
// even after one fails, and the single reported error names roles only.
function dispose(handle, options = {}) {
  const owned = readHandle(handle);
  if (!owned) return { ok: false, error: 'author-containment dispose needs the handle prepare() returned' };
  const shimParent = typeof options.shimParent === 'string' && options.shimParent.trim()
    ? [path.resolve(options.shimParent)] : [];
  const fallbackParents = (Array.isArray(options.fallbackParents) ? options.fallbackParents : [])
    .filter((parent) => typeof parent === 'string' && parent.trim())
    .map((parent) => path.resolve(parent));

  const targets = owned.fallbackRoots
    .map((root, index) => ({ role: `fallback[${index}]`, root, parents: fallbackParents }))
    // Longest path first, so a nested root can never be orphaned by an ancestor's removal.
    .sort((a, b) => path.resolve(b.root).length - path.resolve(a.root).length);
  targets.unshift({ role: 'shim', root: owned.shimRoot, parents: shimParent });

  const failed = [];
  for (const target of targets) {
    if (!removeOwnedRoot(target.root, owned.nonce, { parents: target.parents, requireMarker: true })) {
      failed.push(target.role);
    }
  }
  return failed.length ? { ok: false, error: disposeErrorText(failed) } : { ok: true };
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

// The two calls the author stage makes. beginLaunch() builds one launch's containment and
// hands back everything endLaunch() needs to take it down again — the handle plus the exact
// safe parents its roots must have been created under. The handle is HOST-OWNED: only
// `prepared.dir` reaches applyEnv, so neither the nonce nor the root list can travel into the
// author's prompt or child environment.
function beginLaunch(baseEnv, issueId) {
  const id = safeIssueId(issueId);
  if (!id) throw new Error(`author containment needs a safe issue id, got ${JSON.stringify(issueId)}`);
  const shimParent = containmentRoot();
  const fallbackParents = fallbackParentDirs();
  const prepared = prepare(containmentDir(id), { issueId: id, fallbackParents });
  if (!prepared.ok) {
    return { ok: false, error: prepared.error, rollbackError: prepared.rollbackError || null };
  }
  return {
    ok: true, env: applyEnv(baseEnv, prepared), dir: prepared.dir,
    handle: prepared.handle, shimParent, fallbackParents,
  };
}

function endLaunch(contained) {
  if (!contained || !contained.ok) return { ok: true };
  return dispose(contained.handle, {
    shimParent: contained.shimParent, fallbackParents: contained.fallbackParents,
  });
}

// The legacy single-call form: prepare the shim for this issue and return the launch
// environment that closes Beads around it. Kept for callers that own no launch lifetime; a
// caller that must dispose afterwards uses beginLaunch/endLaunch instead.
function containEnv(baseEnv, issueId) {
  const contained = beginLaunch(baseEnv, issueId);
  if (!contained.ok) throw new Error(contained.error);
  return contained.env;
}

module.exports = {
  REFUSAL_MAX_CHARS, REFUSAL_EXIT, BRIEF_NOTICE, BD_OVERRIDE_NAMES, OWNERSHIP_MARKER_NAME,
  refusalText, containmentRoot, containmentDir, fallbackParentDirs,
  prepare, dispose, applyEnv, beginLaunch, endLaunch, containEnv,
};
