// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0
'use strict';

// A candidate is input to a NEW proof, never permission to rewrite an old proof.
// The caller holds normal target ownership; an explicit hash pins the inspected input.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { classify } = require('./write-protection-policy');
const { sha, within } = require('./protected-tree');
const { canonicalTarget } = require('../runner/lock');

const MAX_FILES = 10000;
const MAX_BYTES = 128 * 1024 * 1024;
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_CHANGES = 256;
const fail = (message) => { throw new Error(`proof candidate: ${message}`); };
const digest = (value) => sha(Buffer.from(JSON.stringify(value)));

function git(root, args, input) {
  const result = spawnSync('git', ['--no-replace-objects', '-c', 'core.fsmonitor=false', ...args], {
    cwd: root, input, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 60000,
  });
  if (result.status !== 0 || result.error || result.signal) fail(`Git inspection failed: ${args[0]}`);
  return result.stdout;
}

function safePath(rel) {
  if (!rel || path.isAbsolute(rel) || /[\\:\x00-\x1f\x7f]/.test(rel)
      || rel.startsWith('-') || rel.split('/').some((part) => !part || part === '.' || part === '..'
        || /[. ]$/.test(part) || /^\.git$/i.test(part)
        || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) fail('unsafe candidate path');
  return rel;
}

function regularFile(root, rel) {
  let current = root;
  for (const part of safePath(rel).split('/')) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || !within(root, fs.realpathSync(current))) fail(`linked path: ${rel}`);
    if (current !== path.join(root, rel) && !stat.isDirectory()) fail(`invalid ancestor: ${rel}`);
  }
  const stat = fs.lstatSync(current);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_FILE_BYTES) fail(`unsupported file: ${rel}`);
  return stat;
}

function snapshot(root, policy, accept) {
  const index = new Map();
  for (const row of git(root, ['ls-files', '--stage', '-z']).split('\0').filter(Boolean)) {
    const match = /^(\d+) [0-9a-f]+ (\d)\t([\s\S]+)$/.exec(row);
    if (!match || match[2] !== '0') fail('unmerged candidate index');
    index.set(match[3], match[1]);
  }
  const names = new Set([...index.keys(),
    ...git(root, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean),
    ...git(root, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z']).split('\0').filter(Boolean)]);
  if (names.size > MAX_FILES) fail('candidate file limit exceeded');
  // The index is authoritative on hosts whose filesystem cannot represent Git's exec bit.
  const trusted = git(root, ['config', '--bool', 'core.filemode']).trim() === 'true';
  const files = []; const aliases = new Set(); let bytes = 0;
  for (const rel of [...names].sort()) {
    safePath(rel);
    if (!accept(rel, classify(rel, { policy }))) continue;
    const key = rel.toLowerCase();
    if (aliases.has(key)) fail(`case-aliased candidate path: ${rel}`);
    aliases.add(key);
    const indexedMode = index.get(rel);
    if (indexedMode && !['100644', '100755'].includes(indexedMode)) fail(`unsupported Git mode: ${rel}`);
    let stat;
    try { stat = regularFile(root, rel); }
    catch (error) {
      if (error.code === 'ENOENT') continue; // A deleted tracked file is a product delta too.
      throw error;
    }
    bytes += stat.size;
    if (bytes > MAX_BYTES) fail('candidate byte limit exceeded');
    const content = fs.readFileSync(path.join(root, rel));
    if (content.length !== stat.size) fail(`candidate changed during inspection: ${rel}`);
    const mode = trusted ? ((stat.mode & 0o111) ? '100755' : '100644') : (indexedMode || '100644');
    files.push({ path: rel, mode, bytes: content.length, sha256: sha(content) });
  }
  return { hash: digest(files), files };
}

function productSnapshot(root, policy) {
  return snapshot(root, policy, (_rel, kind) => kind === 'product');
}

function otherSnapshot(root, policy, id) {
  const suite = `tests/acceptance/${id}/`;
  return snapshot(root, policy, (rel, kind) => kind !== 'product' && !rel.startsWith(suite));
}

function suiteHash(manifest, id) {
  const prefix = `tests/acceptance/${id}/`;
  return digest(manifest.filter(([name]) => name.startsWith(prefix)));
}

function inspectCandidate(built, probePath, proofApi) {
  const probe = path.resolve(probePath); const container = path.dirname(probe);
  if (path.basename(probe) !== 'probe' || !proofApi.ownedContainer(container)) fail('candidate has no managed ownership');
  const stat = fs.lstatSync(probe);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(probe) !== probe) fail('candidate path is linked');
  const gitDir = fs.lstatSync(path.join(probe, '.git'));
  if (!gitDir.isDirectory() || gitDir.isSymbolicLink()) fail('candidate Git directory is linked or external');
  const markerPath = path.join(container, proofApi.MARKER);
  if (fs.lstatSync(markerPath).isSymbolicLink()) fail('candidate marker is linked');
  const markerBytes = fs.readFileSync(markerPath);
  const marker = JSON.parse(markerBytes);
  const id = proofApi.suiteIdOf(built);
  if (marker.issue !== id || path.resolve(marker.sourceWorktree || '') !== path.resolve(built.folder.dir)
      || marker.targetIdentity !== canonicalTarget(built.cfg.targetRepoPath)) fail('candidate repository/issue/worktree mismatch');
  const head = git(probe, ['rev-parse', 'HEAD']).trim();
  if (!/^[0-9a-f]{40,64}$/.test(head) || head !== marker.head
      || git(built.folder.dir, ['rev-parse', 'HEAD']).trim() !== head) fail('candidate base mismatch');
  const manifest = proofApi.normalizedManagedManifest(probe,
    proofApi.protectedManifest(probe, built.policy, id), id);
  if (proofApi.manifestHash(manifest) !== marker.manifestHash) fail('candidate protected paths or original suite changed');
  const products = productSnapshot(probe, built.policy);
  const identity = { version: 1, source: probe, markerHash: sha(markerBytes),
    target: marker.targetIdentity, issue: id, head,
    oldSuiteHash: suiteHash(manifest, id), productHash: products.hash,
    otherHash: otherSnapshot(probe, built.policy, id).hash };
  return { ...identity, hash: digest(identity), products, marker };
}

function copyProduct(prepared, candidate, built) {
  if (otherSnapshot(candidate.source, built.policy, candidate.issue).hash
      !== otherSnapshot(prepared.baseline, built.policy, candidate.issue).hash) fail('candidate changed a non-product path');
  const base = productSnapshot(prepared.baseline, built.policy);
  const previous = new Map(base.files.map((entry) => [entry.path, entry]));
  const current = new Map(candidate.products.files.map((entry) => [entry.path, entry]));
  const changes = [];
  for (const rel of [...new Set([...previous.keys(), ...current.keys()])].sort()) {
    if (JSON.stringify(previous.get(rel)) === JSON.stringify(current.get(rel))) continue;
    changes.push({ path: rel, ...(current.get(rel) || { deleted: true }) });
  }
  if (changes.length > MAX_CHANGES) fail('candidate change limit exceeded');
  for (const change of changes) {
    const dest = path.join(prepared.probe, change.path);
    if (!within(prepared.probe, dest)) fail('candidate destination escapes probe');
    if (change.deleted) {
      regularFile(prepared.probe, change.path);
      fs.unlinkSync(dest);
      git(prepared.probe, ['update-index', '--force-remove', '--', change.path]);
      continue;
    }
    regularFile(candidate.source, change.path);
    const bytes = fs.readFileSync(path.join(candidate.source, change.path));
    if (sha(bytes) !== change.sha256) fail('candidate changed during transfer');
    let parent = prepared.probe;
    for (const part of change.path.split('/').slice(0, -1)) {
      parent = path.join(parent, part);
      if (!fs.existsSync(parent)) fs.mkdirSync(parent);
      const stat = fs.lstatSync(parent);
      if (!stat.isDirectory() || stat.isSymbolicLink() || !within(prepared.probe, fs.realpathSync(parent))) fail('linked destination');
    }
    if (fs.existsSync(dest)) regularFile(prepared.probe, change.path);
    fs.writeFileSync(dest, bytes);
    fs.chmodSync(dest, change.mode === '100755' ? 0o755 : 0o644);
    const blob = git(prepared.probe, ['hash-object', '-w', '--stdin'], bytes).trim();
    git(prepared.probe, ['update-index', '--add', '--cacheinfo', change.mode, blob, change.path]);
  }
  if (productSnapshot(prepared.probe, built.policy).hash !== candidate.products.hash) fail('copied candidate bytes or modes differ');
  return changes;
}

function prepareCandidate(built, model, selector, proofApi, run, tempRoot) {
  let prepared;
  try {
    if (!selector || typeof selector.path !== 'string' || !/^[0-9a-f]{64}$/.test(selector.hash || '')) fail('explicit candidate path and hash required');
    const candidate = inspectCandidate(built, selector.path, proofApi);
    if (candidate.hash !== selector.hash) fail('candidate changed since inspection');
    prepared = proofApi.prepareProbe(built, model, run, tempRoot);
    if (!prepared.ok) return prepared;
    const markerPath = path.join(prepared.container, proofApi.MARKER);
    const marker = JSON.parse(fs.readFileSync(markerPath));
    if (prepared.head !== candidate.head || marker.baseManifestHash !== candidate.marker.baseManifestHash) fail('candidate integration base changed');
    const changes = copyProduct(prepared, candidate, built);
    if (inspectCandidate(built, candidate.source, proofApi).hash !== candidate.hash) fail('candidate changed during preparation');
    const reuse = { version: 1, source: candidate.source, sourceHash: candidate.hash,
      sourceMarkerHash: candidate.markerHash, head: candidate.head,
      oldSuiteHash: candidate.oldSuiteHash, newSuiteHash: suiteHash(prepared.manifest, candidate.issue),
      productHash: candidate.products.hash, otherHash: candidate.otherHash,
      changes, modelLaunchedForAdoption: false };
    marker.candidateReuse = reuse;
    fs.writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`);
    return { ...prepared, candidateReuse: reuse };
  } catch (error) {
    if (prepared && prepared.ok) {
      try { proofApi.removeOwnedContainer(prepared.container); } catch { /* preserve unverified ownership */ }
    }
    return { ok: false, error: error.message };
  }
}

function candidateIntegrityErrors(built, prepared, proofApi) {
  if (!prepared.candidateReuse) return [];
  try {
    const reuse = prepared.candidateReuse;
    if (inspectCandidate(built, reuse.source, proofApi).hash !== reuse.sourceHash) return ['source candidate changed during proof'];
    if (productSnapshot(prepared.probe, built.policy).hash !== reuse.productHash) return ['adopted product changed during proof'];
    if (otherSnapshot(prepared.probe, built.policy, proofApi.suiteIdOf(built)).hash !== reuse.otherHash) return ['adopted non-product path changed during proof'];
    return [];
  } catch (error) { return [error.message]; }
}

module.exports = { inspectCandidate, prepareCandidate, productSnapshot, candidateIntegrityErrors,
  MAX_FILES, MAX_BYTES, MAX_FILE_BYTES, MAX_CHANGES };
