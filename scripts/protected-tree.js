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

const RECEIPT_NAME = '.freeze-gate.json';

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

function gitPaths(root, patterns) {
  const base = ['ls-files', '-z'];
  const calls = [
    [...base, '--cached', '--others', '--exclude-standard', '--', ...patterns],
    [...base, '--others', '--ignored', '--exclude-standard', '--', ...patterns],
  ];
  const paths = new Set();
  for (const args of calls) {
    const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0) return null;
    for (const name of String(r.stdout || '').split('\0').filter(Boolean)) paths.add(normalize(name));
  }
  return [...paths];
}

function entryFor(root, rel, gitBacked) {
  const file = path.resolve(root, ...rel.split('/'));
  if (!within(root, file)) throw new Error(`protected match escapes the repository: ${rel}`);
  let stat;
  try { stat = fs.lstatSync(file); } catch { return `missing`; }
  const mode = (stat.mode & 0o7777).toString(8);
  if (stat.isSymbolicLink()) return `link:${mode}:${sha(Buffer.from(fs.readlinkSync(file)))}`;
  if (stat.isFile()) {
    if (gitBacked) {
      const h = spawnSync('git', ['hash-object', '--path', rel, '--', rel], {
        cwd: root, encoding: 'utf8', maxBuffer: 1024 * 1024,
      });
      const blob = String(h.stdout || '').trim();
      if (h.status !== 0 || !/^[0-9a-f]{40}$/.test(blob)) {
        throw new Error(`cannot hash protected path ${rel}: ${(h.stderr || '').trim() || `exit ${h.status}`}`);
      }
      return `file:${mode}:blob:${blob}`;
    }
    const bytes = fs.readFileSync(file);
    const blob = crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    return `file:${mode}:blob:${blob}`;
  }
  if (stat.isDirectory()) return `dir:${mode}`;
  return `other:${mode}`;
}

function protectedManifest(repoRoot, policy, issueId) {
  const root = path.resolve(repoRoot);
  const patterns = ['tests/acceptance', 'pipeline.config.json', ...((policy && policy.frozenPaths) || [])]
    .map((p) => safePattern(p, root));
  let matches = gitPaths(root, patterns);
  const gitBacked = matches !== null;
  if (matches === null) {
    const matchers = patterns.map(regexFor);
    matches = allFilesystemPaths(root).filter((rel) => matchers.some((re) => re.test(rel)));
  }
  const ignoredReceipt = `tests/acceptance/${issueId}/${RECEIPT_NAME}`;
  const out = new Map();
  for (const rel of matches.sort()) {
    if (rel === ignoredReceipt || rel.endsWith(`/${RECEIPT_NAME}`) && rel === ignoredReceipt) continue;
    out.set(rel, entryFor(root, rel, gitBacked));
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

module.exports = { protectedManifest, manifestHash, manifestDifference, safePattern, regexFor, within, sha };
