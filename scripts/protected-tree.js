// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0
'use strict';

// One byte-level view of the judge and verifier contract. Frozen paths are Git pathspecs in
// pipeline/verify.js, not literal filenames; this module therefore asks Git for tracked,
// untracked and ignored matches when a repository is available. The filesystem fallback keeps
// manual repo-shaped probes honest without pretending they have an index.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { parseReceipt } = require('../runner/queue');

const RECEIPT_NAME = '.freeze-gate.json';
const HASH_BATCH_PATHS = 256;
// Windows CreateProcess has a 32,767 UTF-16 command-line limit. This conservative estimate
// includes quoting expansion and leaves room for the executable and fixed arguments.
const HASH_BATCH_ARG_UNITS = 12000;
const GIT_TIMEOUT_MS = 60000;
// ResourceUID::id_to_text emits a variable-width base-34 number. Godot's generator alphabet
// is a-y plus 0-8 and the engine caps the encoded number at 13 characters. Shorter values are
// normal (and present in real projects), so exact-width validation would turn generated cache
// sidecars into protected test evidence.
const GENERATED_GODOT_UID = /^uid:\/\/[a-y0-8]{1,13}\r?\n?$/;
// Git records four object modes and nothing else. Everything a filesystem adds on top of them
// is invisible to Git, so it must be invisible to a manifest whose whole job is to notice what
// Git would notice: a Windows checkout bind-mounted into a Linux container shows 0o777 for every
// file where a clean in-container copy shows 0o644, `git status` is clean across that boundary,
// and hashing the raw twelve bits therefore made `managedArtifactsIntact` call an untouched tree
// "changed after it was proven" and discard an expensive proven gate.
const GIT_MODE_FILE = '100644';
const GIT_MODE_EXEC = '100755';
const GIT_MODE_LINK = '120000';
const GIT_MODE_DIR = '40000';
// A fifo, socket or device node has no Git mode at all: Git cannot record one, so neither this
// module nor any comparison built on it may claim to have read one.
const GIT_MODE_NONE = 'none';

function sha(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function normalize(rel) { return String(rel).split(path.sep).join('/').replace(/^\.\//, '').replace(/\/+$/, ''); }
function within(root, candidate) {
  const base = path.resolve(root); const resolved = path.resolve(candidate);
  return resolved === base || resolved.startsWith(`${base}${path.sep}`);
}

function safePattern(raw, root) {
  if (typeof raw !== 'string' || !raw.trim() || raw.includes('\0')) {
    throw new Error('protected path must be a non-empty string');
  }
  const rel = normalize(raw.trim());
  if (!rel || path.isAbsolute(raw) || /^[A-Za-z]:/.test(rel) || rel.split('/').includes('..')) {
    throw new Error(`protected path must stay repository-relative: ${raw}`);
  }
  // Resolve the non-pattern prefix as a second containment check. Git pathspec magic is not
  // part of the project contract and is rejected rather than interpreted differently here.
  if (rel.startsWith(':')) {
    throw new Error(`protected pathspec magic is not supported: ${raw}`);
  }
  const prefix = rel.split(/[*?[]/, 1)[0];
  if (!within(root, path.resolve(root, prefix || '.'))) throw new Error(`protected path escapes the repository: ${raw}`);
  return rel;
}

function regexFor(pattern) {
  let out = '^';
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') { out += '.*'; i += 1; }
      else out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else if (c === '[') {
      const end = pattern.indexOf(']', i + 1);
      if (end === -1) out += '\\[';
      else { out += pattern.slice(i, end + 1); i = end; }
    } else out += /[\\^$+?.()|{}]/.test(c) ? `\\${c}` : c;
  }
  // A literal directory pathspec selects its descendants too.
  return new RegExp(`${out}(?:/.*)?$`);
}

function allFilesystemPaths(root) {
  const out = [];
  function visit(current) {
    const rel = normalize(path.relative(root, current));
    if (rel === '.git' || rel.startsWith('.git/')) return;
    let stat;
    try { stat = fs.lstatSync(current); } catch { return; }
    if (rel && (!stat.isDirectory() || stat.isSymbolicLink())) out.push(rel);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      for (const name of fs.readdirSync(current).sort()) visit(path.join(current, name));
    }
  }
  visit(root);
  return out;
}

function gitPaths(root, patterns, run = spawnSync) {
  const base = ['ls-files', '-z'];
  const calls = [
    [...base, '--cached', '--others', '--exclude-standard', '--', ...patterns],
    [...base, '--others', '--ignored', '--exclude-standard', '--', ...patterns],
  ];
  const paths = new Set();
  for (const args of calls) {
    const r = run('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
      timeout: GIT_TIMEOUT_MS, killSignal: 'SIGKILL' });
    if (r.status !== 0) return null;
    for (const name of String(r.stdout || '').split('\0').filter(Boolean)) paths.add(normalize(name));
  }
  return [...paths];
}

function gitFileHashes(root, rels, run = spawnSync) {
  const hashes = new Map();
  let batch = []; let units = 0;
  function flush() {
    if (!batch.length) return;
    const current = batch; batch = []; units = 0;
    const result = run('git', ['hash-object', '--', ...current], {
      cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
      timeout: GIT_TIMEOUT_MS, killSignal: 'SIGKILL',
    });
    if (result.status !== 0 || result.error || result.signal) {
      const detail = (result.stderr || '').trim()
        || (result.error && result.error.message)
        || (result.signal ? `signal ${result.signal}` : `exit ${result.status}`);
      throw new Error(`cannot bulk-hash protected paths: ${detail}`);
    }
    const lines = String(result.stdout || '').split(/\r?\n/);
    if (lines[lines.length - 1] === '') lines.pop();
    if (lines.length !== current.length || lines.some((line) => !/^[0-9a-f]{40}$/.test(line))) {
      throw new Error(`cannot bulk-hash protected paths: expected ${current.length} object ids, got ${lines.length}`);
    }
    current.forEach((rel, index) => hashes.set(rel, lines[index]));
  }
  for (const rel of rels) {
    // Upper-bound Windows quoting cost without duplicating Git's argv encoder.
    const nextUnits = 2 * String(rel).length + 3;
    if (batch.length && (batch.length >= HASH_BATCH_PATHS || units + nextUnits > HASH_BATCH_ARG_UNITS)) flush();
    batch.push(rel); units += nextUnits;
  }
  flush();
  return hashes;
}

// Whether Git trusts this working tree's executable bit. `core.filemode` is probed once at
// clone or init time and travels in the checkout's own config, which is exactly what makes it
// the right oracle here: a Windows-created checkout says `false` and keeps saying `false` when
// a Linux container reads it through a bind mount, so both sides of a managed proof agree about
// a bit neither filesystem represents the same way. Where the setting is absent, fall back to
// Git's own compile-time default rather than to whatever the mount happens to show.
function executableBitIsTrusted(root, run = spawnSync) {
  const result = run('git', ['config', '--get', 'core.filemode'], {
    cwd: root, encoding: 'utf8', maxBuffer: 1024 * 1024,
    timeout: GIT_TIMEOUT_MS, killSignal: 'SIGKILL',
  });
  const value = String((result && result.stdout) || '').trim().toLowerCase();
  if (['false', 'off', 'no', '0'].includes(value)) return false;
  if (['true', 'on', 'yes', '1'].includes(value)) return true;
  return process.platform !== 'win32';
}

// The index is the second half of that oracle. Where the executable bit is not trusted, Git
// keeps recording whatever mode the entry already carries, so `git ls-files --stage` — not the
// filesystem — is what says whether a tracked path is executable in Git's eyes. Read only when
// it is needed: on a trusted filesystem the stat answers, and this call is one spawn saved.
function indexFileModes(root, run = spawnSync) {
  const modes = new Map();
  const result = run('git', ['ls-files', '--stage', '-z'], {
    cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    timeout: GIT_TIMEOUT_MS, killSignal: 'SIGKILL',
  });
  if (!result || result.status !== 0 || result.error || result.signal) return modes;
  for (const record of String(result.stdout || '').split('\0')) {
    const tab = record.indexOf('\t');
    if (tab === -1) continue;
    const mode = record.slice(0, 6);
    if (/^[0-7]{6}$/.test(mode)) modes.set(normalize(record.slice(tab + 1)), mode);
  }
  return modes;
}

// Git's own `ce_mode_from_stat`, stated for this module: a link is a link, a tree is a tree, and
// a regular file is executable only where the executable bit is trusted — otherwise the index
// says. Nothing else about `stat.mode` reaches the manifest.
function gitModeOf(stat, rel, modeSource) {
  if (stat.isSymbolicLink()) return GIT_MODE_LINK;
  if (stat.isDirectory()) return GIT_MODE_DIR;
  if (!stat.isFile()) return GIT_MODE_NONE;
  const source = modeSource || {};
  if (source.trusted === false) {
    return (source.index && source.index.get(rel)) === GIT_MODE_EXEC ? GIT_MODE_EXEC : GIT_MODE_FILE;
  }
  return (stat.mode & 0o111) ? GIT_MODE_EXEC : GIT_MODE_FILE;
}

function entryFor(root, rel, gitBacked, gitHashes = null, modeSource = null) {
  const file = path.resolve(root, ...rel.split('/'));
  if (!within(root, file)) throw new Error(`protected match escapes the repository: ${rel}`);
  let stat;
  try { stat = fs.lstatSync(file); } catch { return `missing`; }
  const mode = gitModeOf(stat, rel, modeSource);
  if (stat.isSymbolicLink()) return `link:${mode}:${sha(Buffer.from(fs.readlinkSync(file)))}`;
  if (stat.isFile()) {
    if (gitBacked) {
      const blob = gitHashes && gitHashes.get(rel);
      if (!/^[0-9a-f]{40}$/.test(blob || '')) throw new Error(`cannot hash protected path ${rel}: no bulk object id`);
      return `file:${mode}:blob:${blob}`;
    }
    const bytes = fs.readFileSync(file);
    const blob = crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    return `file:${mode}:blob:${blob}`;
  }
  if (stat.isDirectory()) return `dir:${mode}`;
  return `other:${mode}`;
}

function protectedManifest(repoRoot, policy, issueId, run = spawnSync) {
  const root = path.resolve(repoRoot);
  const patterns = ['tests/acceptance', 'pipeline.config.json', ...((policy && policy.frozenPaths) || [])]
    .map((p) => safePattern(p, root));
  let matches = gitPaths(root, patterns, run);
  const gitBacked = matches !== null;
  if (matches === null) {
    const matchers = patterns.map(regexFor);
    matches = allFilesystemPaths(root).filter((rel) => matchers.some((re) => re.test(rel)));
  }
  const ignoredReceipt = `tests/acceptance/${issueId}/${RECEIPT_NAME}`;
  matches = matches.filter((rel) => rel !== ignoredReceipt);
  const regularFiles = matches.filter((rel) => {
    try {
      const stat = fs.lstatSync(path.resolve(root, ...rel.split('/')));
      return stat.isFile() && !stat.isSymbolicLink();
    } catch { return false; }
  });
  const gitHashes = gitBacked ? gitFileHashes(root, regularFiles, run) : null;
  // A repo-shaped tree with no index has no Git to ask, so the platform default stands in for
  // `core.filemode` and there is no index to consult. That is not a gap this module can close:
  // where Git is absent there is no recorded mode, and inventing one would be the plausible-but-
  // wrong evidence the whole comparison exists to refuse.
  const trusted = gitBacked ? executableBitIsTrusted(root, run) : process.platform !== 'win32';
  const modeSource = { trusted, index: (!trusted && gitBacked) ? indexFileModes(root, run) : null };
  const out = new Map();
  for (const rel of matches.sort()) {
    out.set(rel, entryFor(root, rel, gitBacked, gitHashes, modeSource));
  }
  return [...out.entries()].sort((a, b) => Buffer.from(a[0]).compare(Buffer.from(b[0])));
}

function manifestHash(manifest) { return sha(Buffer.from(JSON.stringify(manifest))); }
function manifestDifference(want, got) {
  const a = new Map(want); const b = new Map(got); const changed = [];
  for (const [name, value] of a) {
    if (!b.has(name)) changed.push(`removed ${name}`);
    else if (b.get(name) !== value) changed.push(`edited ${name}`);
  }
  for (const name of b.keys()) if (!a.has(name)) changed.push(`added ${name}`);
  return changed.sort();
}

function generatedGodotUid(repoRoot, rel, companionPresent, run = spawnSync) {
  if (!/^tests\/acceptance\/[^/]+\/.+\.gd\.uid$/.test(rel) || !companionPresent) return false;
  const file = path.resolve(repoRoot, ...rel.split('/'));
  if (!within(repoRoot, file)) return false;
  let stat; let bytes;
  try { stat = fs.lstatSync(file); bytes = fs.readFileSync(file, 'utf8'); }
  catch { return false; }
  if (!stat.isFile() || stat.isSymbolicLink() || !GENERATED_GODOT_UID.test(bytes)) return false;
  const ignored = run('git', ['check-ignore', '--quiet', '--', rel], {
    cwd: repoRoot, encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 5000,
  });
  const tracked = run('git', ['ls-files', '--error-unmatch', '--', rel], {
    cwd: repoRoot, encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 5000,
  });
  return ignored.status === 0 && !ignored.error && !ignored.signal
    && tracked.status === 1 && !tracked.error && !tracked.signal;
}

function nulPaths(output) {
  const text = String(output || '');
  if (!text) return [];
  if (!text.endsWith('\0')) return null;
  return text.slice(0, -1).split('\0').map(normalize);
}

function generatedGodotUids(repoRoot, manifest, issueId, run = spawnSync) {
  const entries = new Map(manifest);
  const candidates = [];
  for (const [rel] of manifest) {
    const match = /^tests\/acceptance\/([^/]+)\/(.+\.gd)\.uid$/.exec(rel);
    if (!match || match[1] === issueId
        || !entries.has(`tests/acceptance/${match[1]}/${match[2]}`)) continue;
    const file = path.resolve(repoRoot, ...rel.split('/'));
    let stat; let bytes;
    try { stat = fs.lstatSync(file); bytes = fs.readFileSync(file, 'utf8'); }
    catch { continue; }
    if (stat.isFile() && !stat.isSymbolicLink() && GENERATED_GODOT_UID.test(bytes)) candidates.push(rel);
  }
  if (!candidates.length) return new Set();

  // `check-ignore --stdin -z` preserves arbitrary path bytes and avoids both the Windows argv
  // ceiling and one process per sidecar. Any ambiguous response keeps every candidate protected.
  const input = Buffer.from(`${candidates.join('\0')}\0`);
  const ignoredResult = run('git', ['check-ignore', '-z', '--stdin'], {
    cwd: repoRoot, input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    timeout: GIT_TIMEOUT_MS, killSignal: 'SIGKILL',
  });
  if (![0, 1].includes(ignoredResult.status) || ignoredResult.error || ignoredResult.signal) return new Set();
  const ignoredPaths = nulPaths(ignoredResult.stdout);
  if (ignoredPaths === null || (ignoredResult.status === 1 && ignoredPaths.length)) return new Set();
  const candidateSet = new Set(candidates);
  if (ignoredPaths.some((rel) => !candidateSet.has(rel))) return new Set();

  // A single complete tracked-path snapshot replaces `ls-files --error-unmatch` per sidecar.
  const trackedResult = run('git', ['ls-files', '-z', '--cached'], {
    cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    timeout: GIT_TIMEOUT_MS, killSignal: 'SIGKILL',
  });
  if (trackedResult.status !== 0 || trackedResult.error || trackedResult.signal) return new Set();
  const trackedPaths = nulPaths(trackedResult.stdout);
  if (trackedPaths === null) return new Set();
  const tracked = new Set(trackedPaths);
  const ignored = new Set(ignoredPaths);
  return new Set(candidates.filter((rel) => ignored.has(rel) && !tracked.has(rel)));
}

function untrackedSiblingReceipt(repoRoot, rel, issueId, run = spawnSync) {
  const match = /^tests\/acceptance\/([^/]+)\/\.freeze-gate\.json$/.exec(rel);
  if (!match || match[1] === issueId) return false;
  const file = path.resolve(repoRoot, ...rel.split('/'));
  if (!within(repoRoot, file)) return false;
  let stat; let text;
  try { stat = fs.lstatSync(file); text = fs.readFileSync(file, 'utf8'); }
  catch { return false; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !parseReceipt(text).ok) return false;
  const tracked = run('git', ['ls-files', '--error-unmatch', '--', rel], {
    cwd: repoRoot, encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 5000,
  });
  return tracked.status === 1 && !tracked.error && !tracked.signal;
}

// Managed proof compares a clean commit-shaped clone with a long-lived integration checkout.
// Freeze receipts are controller metadata rather than executable tests, and a receipt written
// beside one unrelated suite must not stale the proof of another; promotion never copies or
// rewrites those other suites. Godot also writes ignored `<script>.uid` sidecars when it scans a
// project. Normalize only those two exact controller/generated shapes. The suite being proved's
// test bytes, tracked/staged files, symlinks, malformed UIDs, missing companions and every other
// protected path remain protected.
function normalizedManagedManifest(repoRoot, manifest, issueId, runOrOptions = spawnSync) {
  const run = typeof runOrOptions === 'function' ? runOrOptions : spawnSync;
  const options = typeof runOrOptions === 'function' ? {} : (runOrOptions || {});
  const answer = [];
  const entries = new Map(manifest);
  const generatedUids = generatedGodotUids(repoRoot, manifest, issueId, run);
  for (const [rel, value] of manifest) {
    // This projection is authorized only for the long-lived integration target. Baseline and
    // probe identities stay bound to every raw byte the proof marker originally hashed.
    if (options.targetComparison === true && untrackedSiblingReceipt(repoRoot, rel, issueId, run)) continue;
    const match = /^tests\/acceptance\/([^/]+)\/(.+\.gd)\.uid$/.exec(rel);
    if (!match || match[1] === issueId || !entries.has(`tests/acceptance/${match[1]}/${match[2]}`)) {
      answer.push([rel, value]); continue;
    }
    if (!generatedUids.has(rel)) answer.push([rel, value]);
  }
  return answer;
}

module.exports = {
  protectedManifest, manifestHash, manifestDifference, normalizedManagedManifest,
  generatedGodotUid, generatedGodotUids, nulPaths,
  gitFileHashes,
  untrackedSiblingReceipt,
  safePattern, regexFor, within, sha,
  HASH_BATCH_PATHS, HASH_BATCH_ARG_UNITS, GIT_TIMEOUT_MS,
};
