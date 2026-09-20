// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0
'use strict';

// Explicit, hash-pinned reference data. This module never applies product changes.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const candidateApi = require('../scripts/proof-candidate');
const proof = require('../scripts/prove-tests');
const { canonicalTarget } = require('./lock');
const { suiteHash, workingTreeEntries, treeEntries } = require('./suite-hash');
const { classify } = require('../scripts/write-protection-policy');

const MAX_BYTES = 256 * 1024;
const MAX_FILES = 4;
const NAME = 'implementation-reference.json';
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const fail = message => { throw new Error(`implementation reference: ${message}`); };
function git(root, args) {
  const env = { ...process.env };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[key];
  const r = spawnSync('git', ['--no-replace-objects', '-c', 'core.fsmonitor=false', ...args], {
    cwd: root, env, encoding: 'utf8', timeout: 60000, maxBuffer: MAX_BYTES * 4, windowsHide: true,
  });
  if (r.status !== 0 || r.error || r.signal) fail(`Git inspection failed (${args[0]})`);
  return r.stdout;
}
function text(bytes) {
  const value = bytes.toString('utf8');
  if (!Buffer.from(value, 'utf8').equals(bytes) || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) fail('only regular UTF-8 text is supported');
  return value;
}
function readBounded(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_BYTES) fail('unsafe or oversized reference file');
  const bytes = fs.readFileSync(file);
  if (bytes.length > MAX_BYTES) fail('reference exceeds byte limit');
  return bytes;
}
function productIdentity(root, policy) {
  const dirty = git(root, ['diff', '--name-only', '-z', 'HEAD']).split('\0').filter(Boolean);
  const others = [false, true].flatMap(ignored => git(root,
    ['ls-files', '--others', ...(ignored ? ['--ignored'] : []), '--exclude-standard', '-z']).split('\0').filter(Boolean));
  if ([...dirty, ...others].some(rel => classify(rel, { policy }) === 'product')) fail('product base changed');
  const entries = git(root, ['ls-tree', '-r', '-z', 'HEAD']).split('\0').filter(Boolean).map(row => {
    const match = /^(\d+) blob ([0-9a-f]+)\t([\s\S]+)$/.exec(row);
    return match && classify(match[3], { policy }) === 'product' ? [match[3], match[1], match[2]] : null;
  }).filter(Boolean);
  return hash(Buffer.from(JSON.stringify(entries)));
}
function capture({ target, issue, probePath, candidateHash }) {
  if (!proof.validIssueId(issue) || !/^[0-9a-f]{64}$/.test(candidateHash || '')) fail('explicit issue and inspected candidate hash required');
  const managed = proof.readManagedProbe(probePath);
  if (!managed) fail('a managed proof is required');
  const head = git(target, ['rev-parse', 'HEAD']).trim();
  const checked = proof.validateManagedProbe(probePath, target, [issue], head);
  if (!checked.ok || !checked.managed) fail(checked.error || 'successful managed proof required');
  const built = { id: issue, cfg: { targetRepoPath: target }, folder: { dir: managed.marker.sourceWorktree }, policy: proof.policyAt(target) };
  const candidate = candidateApi.inspectCandidate(built, probePath, proof);
  if (candidate.hash !== candidateHash) fail('candidate changed since inspection');
  const recordedProduct = managed.marker.productHash || (managed.marker.candidateReuse && managed.marker.candidateReuse.productHash);
  if (!/^[0-9a-f]{64}$/.test(managed.marker.evidenceHash || '') || recordedProduct !== candidate.products.hash) {
    fail('successful proof has no matching recorded product binding; re-prove before capture');
  }
  const base = candidateApi.productSnapshot(checked.baseline, built.policy);
  const previous = new Map(base.files.map(row => [row.path, row]));
  if (candidate.products.files.length !== base.files.length) fail('added/deleted/renamed files are outside this trial');
  const changes = [];
  for (const row of candidate.products.files) {
    const old = previous.get(row.path);
    if (!old || old.mode !== row.mode) fail('added/deleted/renamed files or mode changes are outside this trial');
    if (old.sha256 === row.sha256) continue;
    const before = readBounded(path.join(checked.baseline, row.path));
    const after = readBounded(path.join(checked.probe, row.path));
    text(before); text(after);
    changes.push({ path: row.path, beforeHash: hash(before), afterHash: hash(after),
      diff: git(checked.probe, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', 'HEAD', '--', row.path]) });
  }
  if (!changes.length || changes.length > MAX_FILES) fail(`reference must change between 1 and ${MAX_FILES} existing text files`);
  if (candidateApi.inspectCandidate(built, probePath, proof).hash !== candidateHash) fail('candidate changed during capture');
  const value = { version: 1, kind: 'implementation-reference', target: canonicalTarget(target), issue,
    head, candidateHash, baseProductHash: productIdentity(checked.baseline, built.policy),
    suiteHash: suiteHash(workingTreeEntries(checked.probe, `tests/acceptance/${issue}`)), changes };
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  if (bytes.length > MAX_BYTES) fail('reference exceeds byte limit');
  return { value, bytes, hash: hash(bytes) };
}
function load(file, expectedHash, cfg) {
  if (!/^[0-9a-f]{64}$/.test(expectedHash || '')) fail('explicit artifact hash required');
  if (cfg.feedIdleGraceMinutes !== 0 || cfg.concurrency !== 1) fail('trial requires a fixed, single-worker run');
  const bytes = readBounded(file);
  if (hash(bytes) !== expectedHash) fail('artifact hash mismatch');
  let value;
  try { value = JSON.parse(text(bytes)); } catch { fail('invalid reference JSON'); }
  if (!value || value.version !== 1 || value.kind !== 'implementation-reference'
      || !proof.validIssueId(value.issue) || value.target !== canonicalTarget(cfg.targetRepoPath)
      || !/^[0-9a-f]{40,64}$/.test(value.head || '')
      || !['candidateHash', 'baseProductHash', 'suiteHash'].every(key => /^[0-9a-f]{64}$/.test(value[key] || ''))
      || !Array.isArray(value.changes) || !value.changes.length || value.changes.length > MAX_FILES) fail('invalid identity or target');
  const policy = proof.policyAt(cfg.targetRepoPath);
  const seen = new Set();
  for (const change of value.changes) {
    const rel = change && change.path;
    if (typeof rel !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(rel)
        || rel.split('/').some(part => !part || part === '.' || part === '..')
        || seen.has(rel.toLowerCase()) || classify(rel, { policy }) !== 'product'
        || !/^[0-9a-f]{64}$/.test(change.beforeHash || '') || !/^[0-9a-f]{64}$/.test(change.afterHash || '')
        || typeof change.diff !== 'string' || !change.diff.trim()) fail('invalid product reference');
    text(Buffer.from(change.diff)); seen.add(rel.toLowerCase());
  }
  return { value, bytes, hash: expectedHash };
}
function selectQueue(reference, queue) {
  if (!queue || !queue.ok || queue.issues.length !== 1 || queue.issues[0].id !== reference.value.issue) {
    fail('ready queue must contain exactly the selected issue');
  }
  return queue;
}
function stage(reference, cfg, issueId, workspace, admission) {
  const value = reference.value;
  if (hash(reference.bytes) !== reference.hash || JSON.stringify(JSON.parse(reference.bytes)) !== JSON.stringify(value)) fail('reference changed after admission');
  if (value.issue !== issueId || value.target !== canonicalTarget(cfg.targetRepoPath)) fail('issue or target mismatch');
  if (!admission || !admission.ok || !Array.isArray(admission.admitted)
      || !admission.admitted.some(row => row.id === issueId && row.suiteHash === value.suiteHash)) fail('published suite admission mismatch');
  const prefix = `tests/acceptance/${issueId}/`;
  const changed = git(workspace.dir, ['diff', '--name-only', '-z', value.head, workspace.forkPoint]).split('\0').filter(Boolean);
  if (changed.some(rel => !rel.startsWith(prefix))) fail('integration changed outside the selected freeze');
  git(workspace.dir, ['merge-base', '--is-ancestor', value.head, workspace.forkPoint]);
  if (suiteHash(treeEntries(workspace.dir, workspace.forkPoint, prefix.slice(0, -1))) !== value.suiteHash) fail('workspace suite mismatch');
  if (productIdentity(workspace.dir, proof.policyAt(workspace.dir)) !== value.baseProductHash) fail('product base changed');
  const destination = path.join(workspace.dir, '.run', NAME);
  if (fs.existsSync(destination)) fail('reference destination already exists');
  fs.writeFileSync(destination, reference.bytes, { flag: 'wx', mode: 0o444 });
  return destination;
}
module.exports = { capture, load, selectQueue, stage, productIdentity, hash, NAME, MAX_BYTES };
