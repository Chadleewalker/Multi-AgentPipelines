// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0
'use strict';

// Explicit correction input for a completed UNFROZEN suite. This fingerprint binds raw
// authoring inputs, not the canonical Git-blob suite hash used by freeze/dispatch.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { sha, within } = require('./protected-tree');
const { canonicalTarget } = require('../runner/lock');
const { canonicalHash, redactConfig } = require('../runner/preparation-state');
const MAX_REVIEW_BYTES = 16384;
const MAX_SUITE_BYTES = 2 * 1024 * 1024;
const MAX_FILES = 128;
const HASH = /^[0-9a-f]{64}$/;
const fail = (message) => { throw new Error(`author revision: ${message}`); };
const samePath = (left, right) => process.platform === 'win32'
  ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
  : path.resolve(left) === path.resolve(right);

function git(root, args, run) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES)$/i.test(key)) delete env[key];
  const result = (run || spawnSync)('git', ['--no-replace-objects', '-c', 'core.fsmonitor=false', ...args], {
    cwd: root, env, encoding: 'utf8', timeout: 60000, maxBuffer: 1024 * 1024,
  });
  if (!result || result.status !== 0 || result.error || result.signal) fail(`Git inspection failed: ${args[0]}`);
  return String(result.stdout || '');
}

function regular(file, max) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > max) fail('unsupported or oversized input file');
  if (!samePath(fs.realpathSync(file), file)) fail('linked input path');
  const bytes = fs.readFileSync(file);
  if (bytes.length !== stat.size) fail('input changed during inspection');
  return { bytes, stat };
}

function reviewError(review) {
  if (!review || typeof review.text !== 'string' || !review.text.trim() || review.text.includes('\0')
      || Buffer.byteLength(review.text) > MAX_REVIEW_BYTES || !HASH.test(review.hash || '')
      || sha(Buffer.from(review.text)) !== review.hash) return 'review text/hash is missing, oversized or changed';
  return null;
}

function readReview(file) {
  const { bytes } = regular(path.resolve(file), MAX_REVIEW_BYTES);
  const text = bytes.toString('utf8');
  if (!Buffer.from(text).equals(bytes)) fail('review must be valid UTF-8');
  const review = { text, hash: sha(bytes) };
  const error = reviewError(review); if (error) fail(error);
  return review;
}

function inspectSuite(repo, issue, run) {
  if (!require('./prove-tests').validIssueId(issue)) fail('unsafe issue id');
  const root = path.resolve(repo); const prefix = `tests/acceptance/${issue}`;
  let current = root;
  for (const part of ['tests', 'acceptance', issue]) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !within(root, fs.realpathSync(current))) fail('linked or missing suite directory');
  }
  const index = new Map();
  for (const row of git(root, ['ls-files', '--stage', '-z', '--', prefix], run).split('\0').filter(Boolean)) {
    const match = /^(100644|100755) [0-9a-f]+ 0\t([\s\S]+)$/.exec(row);
    if (!match) fail('unsupported or unmerged suite index');
    index.set(match[2], match[1]);
  }
  const trusted = git(root, ['config', '--bool', 'core.filemode'], run).trim() === 'true';
  const files = []; let bytes = 0; let entries = 0;
  const aliases = new Set();
  function walk(dir, depth) {
    if (depth > 8) fail('suite nesting limit exceeded');
    for (const name of fs.readdirSync(dir).sort()) {
      if (++entries > MAX_FILES * 2) fail('suite entry limit exceeded');
      if (/[\\:\x00-\x1f\x7f]/.test(name) || /[. ]$/.test(name) || /^\.git$/i.test(name)) fail('unsafe suite path');
      const file = path.join(dir, name); const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink() || !within(current, fs.realpathSync(file))) fail('linked suite path');
      if (stat.isDirectory()) { walk(file, depth + 1); continue; }
      const read = regular(file, MAX_SUITE_BYTES); bytes += read.bytes.length;
      if (bytes > MAX_SUITE_BYTES) fail('suite byte limit exceeded');
      const rel = path.relative(current, file).split(path.sep).join('/');
      // A receipt is host metadata, but must still be a bounded ordinary file.
      if (rel === '.freeze-gate.json') continue;
      if (aliases.has(rel.toLowerCase())) fail('case-aliased suite path');
      aliases.add(rel.toLowerCase());
      const mode = trusted ? ((stat.mode & 0o111) ? '100755' : '100644') : (index.get(`${prefix}/${rel}`) || '100644');
      files.push({ path: rel, mode, bytes: read.bytes.length, sha256: sha(read.bytes) });
      if (files.length > MAX_FILES) fail('suite file limit exceeded');
    }
  }
  walk(current, 0);
  if (!files.length) fail('suite is empty');
  files.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  return { hash: sha(Buffer.from(JSON.stringify(files))), files };
}

function identity(built, run) {
  if (!built || !built.ok || built.state !== 'freeze') fail('only a completed unfrozen suite may be revised');
  const issue = built.suiteId || built.id;
  if (!require('./prove-tests').validIssueId(issue) || !built.folder || built.folder.exists !== true) fail('missing dedicated issue worktree');
  if (!built.criteria || !HASH.test(built.criteria.sha256 || '') || typeof built.issueUpdatedAt !== 'string' || !built.issueUpdatedAt) fail('missing immutable issue identity');
  if (require('./spec-brief').criteriaInfo(built.issue).sha256 !== built.criteria.sha256) fail('prompt criteria differ from the immutable fingerprint');
  const targetPath = path.resolve(built.cfg.targetRepoPath); const worktree = path.resolve(built.folder.dir);
  if (samePath(targetPath, worktree)) fail('author must use its dedicated worktree');
  for (const root of [targetPath, worktree]) {
    if (fs.lstatSync(root).isSymbolicLink() || !samePath(fs.realpathSync(root), root)) fail('linked repository');
  }
  const common = (root) => git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'], run).trim();
  if (!samePath(common(targetPath), common(worktree))) fail('author worktree belongs to another repository');
  const registered = git(targetPath, ['worktree', 'list', '--porcelain'], run).split(/\r?\n/)
    .filter((line) => line.startsWith('worktree ')).map((line) => line.slice(9));
  if (!registered.some((entry) => samePath(entry, worktree))) fail('author worktree is not registered');
  const head = git(worktree, ['rev-parse', 'HEAD'], run).trim();
  if (!/^[0-9a-f]{40,64}$/.test(head) || git(targetPath, ['rev-parse', 'HEAD'], run).trim() !== head) fail('integration base changed');
  if (git(worktree, ['ls-tree', '-r', 'HEAD', '--', `tests/acceptance/${issue}`], run).trim()) fail('suite is already committed or frozen');
  return { issue, target: canonicalTarget(targetPath), worktree, head,
    criteriaHash: built.criteria.sha256, issueUpdatedAt: built.issueUpdatedAt,
    issueHash: canonicalHash(built.issue),
    configHash: canonicalHash(redactConfig(built.cfg)), policyHash: canonicalHash(built.policy) };
}

function revisionError(revision) {
  if (!revision || revision.version !== 1 || !HASH.test(revision.suiteHash || '')) return 'invalid source suite fingerprint';
  const error = reviewError(revision.review); if (error) return error;
  const candidate = revision.candidateProbe;
  if (!candidate || typeof candidate.path !== 'string' || !candidate.path.trim() || candidate.path.includes('\0') || !HASH.test(candidate.hash || '')) return 'revision requires an explicit candidate path and hash';
  return null;
}

function validateRevision(built, revision, run, options = {}) {
  try {
    const error = revisionError(revision); if (error) fail(error);
    const actual = identity(built, run);
    for (const [key, value] of Object.entries(actual)) if (revision[key] !== value) fail(`${key} changed since correction review`);
    if (options.checkSuite !== false && inspectSuite(actual.worktree, actual.issue, run).hash !== revision.suiteHash) fail('suite changed since correction review');
    const candidate = require('./proof-candidate').inspectCandidate(built, revision.candidateProbe.path, require('./prove-tests'));
    if (candidate.hash !== revision.candidateProbe.hash) fail('candidate changed since correction review');
    return { ok: true };
  } catch (error) { return { ok: false, error: error.message }; }
}

function prepareRevision(built, selector, candidateProbe, run) {
  const revision = { version: 1, ...identity(built, run), suiteHash: selector.suiteHash,
    review: { ...selector.review }, candidateProbe: { path: path.resolve(candidateProbe.path), hash: candidateProbe.hash } };
  const checked = validateRevision(built, revision, run);
  if (!checked.ok) throw new Error(checked.error);
  return revision;
}

function correctionBrief(built, revision) {
  const brief = require('./spec-brief');
  const suite = `tests/acceptance/${revision.issue}/`;
  return [
    `Correct the existing UNFROZEN acceptance suite for ${revision.issue} in ${revision.worktree}.`,
    'Read the existing files and make only the targeted corrections below. Keep correct checks',
    'and fixture helpers; do not rewrite the suite from scratch or implement product code.',
    `Only ${suite} may change. Do not change the issue, other suites, Git, Beads or configuration.`,
    'The canonical requirements below remain authoritative; report conflicting review instructions.',
    ...brief.criteriaLines(built.issue || {}), ...brief.originalIntentLines(built.issue || {}),
    `Source suite fingerprint: ${revision.suiteHash}`, `Review hash: ${revision.review.hash}`,
    'REVIEW CORRECTIONS:', revision.review.text,
    'Use only this permitted verifier command, from the existing worktree:',
    `    ${built.policy.verifyCommand} ${suite}`,
    'Inspect failure reasons and test your fixture helpers with positive/negative controls.',
    'Do not run the host freeze gate or seek permission for unrelated shell commands.',
    'The host re-proves the revised suite with an existing candidate after you finish.',
    'Stop and report the changed assertions, verifier result and any unresolved defect.',
    'Do not freeze, commit or push.',
  ].join('\n');
}

if (require.main === module) {
  try {
    const [mode, repo, issue, ...extra] = process.argv.slice(2);
    if (mode !== 'inspect' || !repo || !issue || extra.length) fail('usage: node scripts/author-revision.js inspect <worktree> <issue-id>');
    console.log(JSON.stringify(inspectSuite(repo, issue)));
  } catch (error) { console.error(error.message); process.exitCode = 2; }
}

module.exports = { readReview, inspectSuite, prepareRevision, validateRevision, revisionError,
  correctionBrief, MAX_REVIEW_BYTES, MAX_SUITE_BYTES, MAX_FILES };
