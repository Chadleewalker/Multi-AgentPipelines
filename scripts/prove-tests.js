#!/usr/bin/env node
// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0
'use strict';

// The second half of frozen-test proof. A test-author worktree establishes RED without touching
// product code. This module copies that suite into two independent local clones at the author's
// exact HEAD, lets a separately sandboxed model alter product code in only one clone, and asks
// freeze-gate to prove RED in the baseline and GREEN in the probe. It never freezes, commits,
// merges or pushes. Both successful trees are retained for the later human-approved freeze.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { loadConfig } = require('../runner/config');
const AGENT = require('../runner/agent-provider');
const MODE_INTENT = require('./probe-mode-intent');
const { runSync, failureText } = require('../runner/process');
const { acquire, release, canonicalTarget } = require('../runner/lock');
const { compareSuites } = require('./freeze-gate');
const {
  protectedManifest, manifestHash, manifestDifference, normalizedManagedManifest, gitFileHashes,
  generatedGodotUids,
  HASH_BATCH_PATHS, within, sha,
} = require('./protected-tree');

const ROOT = path.resolve(__dirname, '..');
const GATE = path.join(ROOT, 'scripts', 'freeze-gate.js');
const PROBE_PREFIX = 'multi-agent-green-probe-';
const PROBE_ROOT_NAME = 'multi-agent-green-probes';
const MARKER = '.pipeline-green-probe.json';
const OWNER_SUFFIX = '.pipeline-green-probe-owner.json';
const PROOF_STAGES = new Set([
  'prepare', 'probe-agent', 'protected-check-before', 'gate', 'protected-check-after', 'marker-write',
]);
const MAX_BUFFER = 64 * 1024 * 1024;
const PROBE_TOOLS = 'Read,Edit,Write,Glob,Grep';
const PROBE_DENIED = 'Bash,WebFetch,WebSearch';
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function validIssueId(id) {
  if (typeof id !== 'string' || !SAFE_ID.test(id) || id === '.' || id.includes('..') || id.endsWith('.')) return false;
  const stem = id.split('.')[0].toUpperCase();
  return !/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem);
}

function suiteIdOf(built) { return built && (built.suiteId || built.id); }

// The repository a proof was cloned from is part of that proof's identity, and a path string is
// not: a config edited between attempts, a redundant or differently-cased spelling, and a
// junction or symlink retargeted underneath a stable literal path all reach resumeProbe() with
// the same author worktree and the same issue id. Bind to the identity runner/lock.js already
// computes for target ownership so one authority answers "the same repository?" for the lock and
// for a retained proof, rather than two rules free to drift apart.
function targetIdentityOf(built) {
  const identity = canonicalTarget(built && built.cfg ? built.cfg.targetRepoPath : undefined);
  if (typeof identity !== 'string' || !identity) throw new Error('canonical target identity is empty');
  return identity;
}

// A missing or malformed recorded identity is refused rather than waved through: an unbound
// container is no evidence at all about which repository its clones came from, so there is
// nothing for this resume to be judged against.
function targetIdentityRefusal(built, marker) {
  const recorded = marker ? marker.targetIdentity : undefined;
  if (typeof recorded !== 'string' || !recorded.trim()) {
    return 'retained probe records no canonical target repository identity';
  }
  let current;
  try { current = targetIdentityOf(built); }
  catch (e) { return `this proof names no canonical target repository: ${(e && e.message) || String(e)}`; }
  if (current !== recorded) {
    return `retained probe was prepared from target repository ${recorded}, not ${current}`;
  }
  return null;
}


function suiteDifference(source, candidate) {
  const diff = compareSuites(source, candidate);
  if (diff.probeMissing) return ['suite directory is missing'];
  return [
    ...diff.absent.map((f) => `removed ${f}`),
    ...diff.differing.map((f) => `edited ${f}`),
    ...diff.extra.map((f) => `added ${f}`),
  ];
}

function cloneAt(cfg, source, head, destination, run = runSync) {
  const cloned = run('git', ['clone', '--no-hardlinks', '--no-checkout', source, destination], {
    cfg, kind: 'git', cwd: path.dirname(destination), label: 'create isolated green-probe clone',
  });
  if (cloned.status !== 0) return { ok: false, error: failureText(cloned, 'git clone failed') };
  const checked = run('git', ['checkout', '--detach', head], {
    cfg, kind: 'git', cwd: destination, label: `check out green-probe baseline ${head}`,
  });
  if (checked.status !== 0) return { ok: false, error: failureText(checked, 'git checkout failed') };
  return { ok: true };
}

function ownerRecordPath(container) {
  const resolved = path.resolve(container);
  return path.join(path.dirname(resolved), `.${path.basename(resolved)}${OWNER_SUFFIX}`);
}

function removeEmptyProbeRoots(container) {
  const probeRoot = path.dirname(path.resolve(container));
  if (path.basename(probeRoot) !== PROBE_ROOT_NAME) return;
  try { fs.rmdirSync(probeRoot); } catch { return; }
  const namespace = path.dirname(probeRoot);
  if (new RegExp(`^\\.${PROBE_ROOT_NAME}-[A-Za-z0-9]{6}$`).test(path.basename(namespace))) {
    try { fs.rmdirSync(namespace); } catch { /* best effort */ }
  }
}

function ownedContainer(container) {
  const marker = path.join(container, MARKER);
  const ownerRecord = ownerRecordPath(container);
  if (!path.basename(container).startsWith(PROBE_PREFIX)
      || !fs.existsSync(marker) || !fs.existsSync(ownerRecord)) return false;
  try {
    const stat = fs.lstatSync(container);
    const ownerStat = fs.lstatSync(ownerRecord);
    if (!stat.isDirectory() || stat.isSymbolicLink()
        || !ownerStat.isFile() || ownerStat.isSymbolicLink()) return false;
    const real = fs.realpathSync(container);
    const parsed = JSON.parse(fs.readFileSync(marker, 'utf8'));
    const owner = JSON.parse(fs.readFileSync(ownerRecord, 'utf8'));
    return parsed.kind === 'multi-agent-green-probe'
      && /^[a-f0-9]{64}$/.test(parsed.cleanupToken || '')
      && path.resolve(parsed.container || '') === real
      && path.resolve(parsed.probeRoot || '') === path.dirname(real)
      && path.basename(path.dirname(real)) === PROBE_ROOT_NAME
      && owner.kind === 'multi-agent-green-probe-owner'
      && owner.version === 1
      && owner.cleanupToken === parsed.cleanupToken
      && path.resolve(owner.container || '') === real
      && path.resolve(owner.probeRoot || '') === path.dirname(real);
  }
  catch { return false; }
}

function removeOwnedPath(container, target) {
  if (!ownedContainer(container) || !within(container, target) || path.resolve(container) === path.resolve(target)) {
    throw new Error(`refusing cleanup outside an owned probe container: ${target}`);
  }
  fs.rmSync(target, { recursive: true, force: true });
}

function removeOwnedContainer(container) {
  if (!ownedContainer(container)) throw new Error(`refusing cleanup of an unowned probe container: ${container}`);
  const ownerRecord = ownerRecordPath(container);
  fs.rmSync(container, { recursive: true, force: true });
  fs.rmSync(ownerRecord, { force: true });
  removeEmptyProbeRoots(container);
}

function discardNewContainer(container) {
  try { fs.rmSync(container, { recursive: true, force: true }); } catch { /* best effort */ }
  try { fs.rmSync(ownerRecordPath(container), { force: true }); } catch { /* best effort */ }
  removeEmptyProbeRoots(container);
}

function readManagedProbe(probePath) {
  const probe = path.resolve(probePath);
  const container = path.dirname(probe);
  if (path.basename(probe) !== 'probe' || !ownedContainer(container)) return null;
  try {
    const baseline = path.join(container, 'baseline');
    for (const child of [probe, baseline]) {
      const stat = fs.lstatSync(child);
      if (!stat.isDirectory() || stat.isSymbolicLink() || !within(container, fs.realpathSync(child))) return null;
    }
    return { marker: JSON.parse(fs.readFileSync(path.join(container, MARKER), 'utf8')),
      container, probe, baseline };
  }
  catch { return null; }
}

function policyAt(repoRoot) {
  const file = path.join(repoRoot, 'pipeline.config.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  return { frozenPaths: Array.isArray(raw.frozenPaths) ? raw.frozenPaths : [] };
}

// A base is the integration commit, not the issue-specific view used after a gate may rewrite
// that issue's receipt. Include every receipt here so independently prepared proofs at one HEAD
// get one identity, while malformed, forged or subsequently changed receipt bytes still move it.
function integrationBaseManifest(repoRoot, policy, issueId, options = {}) {
  return normalizedManagedManifest(repoRoot,
    protectedManifest(repoRoot, policy, issueId, undefined, { includeIssueReceipt: true }),
    issueId, { ...options, baseIdentity: true });
}

function validateManagedProbe(probePath, targetRepoPath, ids, head) {
  const resolvedProbe = path.resolve(probePath);
  const managedShape = path.basename(resolvedProbe) === 'probe'
    && path.basename(path.dirname(resolvedProbe)).startsWith(PROBE_PREFIX);
  const managed = readManagedProbe(probePath);
  if (!managed) return managedShape
    ? { ok: false, managed: true, error: 'managed-looking probe has a missing, malformed or unsafe ownership marker' }
    : { ok: true, managed: false };
  const { marker, probe, baseline } = managed;
  if (ids.length !== 1 || marker.issue !== ids[0]) {
    return { ok: false, managed: true, error: `managed probe belongs to ${marker.issue}, not ${ids.join(', ')}` };
  }
  if (marker.status !== 'proven') return { ok: false, managed: true, error: 'managed probe has no successful proof marker' };
  if (marker.head !== head) return { ok: false, managed: true, error: `managed probe was built at ${marker.head}, current HEAD is ${head}` };
  try {
    const policy = policyAt(targetRepoPath);
    const targetManifest = normalizedManagedManifest(targetRepoPath,
      protectedManifest(targetRepoPath, policy, marker.issue), marker.issue,
      { targetComparison: true });
    const targetBaseManifest = integrationBaseManifest(targetRepoPath, policy, marker.issue,
      { targetComparison: true });
    const probeManifest = normalizedManagedManifest(probe,
      protectedManifest(probe, policy, marker.issue), marker.issue);
    const baselineManifest = normalizedManagedManifest(baseline,
      protectedManifest(baseline, policy, marker.issue), marker.issue);
    const targetHash = manifestHash(targetManifest);
    const targetBaseHash = manifestHash(targetBaseManifest);
    const probeHash = manifestHash(probeManifest);
    const baselineHash = manifestHash(baselineManifest);
    if (probeHash !== marker.manifestHash) {
      return { ok: false, managed: true, error: 'the retained probe changed a protected path after it was proven' };
    }
    if (baselineHash !== marker.manifestHash) {
      return { ok: false, managed: true, error: 'the retained red baseline changed a protected path after it was proven' };
    }
    const targetIsProbe = targetHash === marker.manifestHash;
    const targetIsBase = targetBaseHash === marker.baseManifestHash;
    if (!targetIsProbe && !targetIsBase) {
      // A pre-promotion integration checkout is expected to resemble the clean base, while an
      // already-promoted checkout resembles the proven tree. Report the closer identity so the
      // expected absence of the not-yet-promoted suite does not bury the actual concurrent byte.
      const fromBase = manifestDifference(baselineManifest, targetManifest);
      const fromProbe = manifestDifference(probeManifest, targetManifest);
      const details = (fromBase.length <= fromProbe.length ? fromBase : fromProbe).slice(0, 5);
      return { ok: false, managed: true, error: 'the integration suite or another protected path moved after the probe was built'
        + `${details.length ? `: ${details.join(', ')}` : ''}` };
    }
    return { ok: true, managed: true, ...managed, needsPromotion: targetIsBase && !targetIsProbe };
  } catch (e) { return { ok: false, managed: true, error: e.message }; }
}

// The author deliberately writes in a dedicated worktree, while freeze deliberately commits in
// the integration checkout. A managed proof is the bridge between them: after validating both
// the exact pre-author protected tree and the exact proven tree, the human-approved freeze may
// promote only this one suite. A temporary sibling plus a backup avoids leaving a half-copied
// judge if Windows interrupts a directory replacement.
function promoteManagedSuite(managed, targetRepoPath) {
  if (!managed || !managed.managed || !validIssueId(managed.marker.issue)) {
    return { ok: true, promoted: false };
  }
  const id = managed.marker.issue;
  const acceptance = path.resolve(targetRepoPath, 'tests', 'acceptance');
  const source = path.join(managed.baseline, 'tests', 'acceptance', id);
  const target = path.join(acceptance, id);
  if (!within(path.resolve(targetRepoPath), acceptance) || !within(acceptance, target)
      || !fs.existsSync(source) || !fs.statSync(source).isDirectory()) {
    return { ok: false, error: 'the managed probe does not contain a safe authored suite to promote' };
  }
  fs.mkdirSync(acceptance, { recursive: true });
  const nonce = `${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
  // Keep transitional directories outside tests/acceptance: that entire tree is protected, so
  // even a cleanup failure must not manufacture a second acceptance suite.
  const staged = path.join(path.resolve(targetRepoPath), `.pipeline-green-probe-promote-${id}-${nonce}`);
  const backup = path.join(path.resolve(targetRepoPath), `.pipeline-green-probe-backup-${id}-${nonce}`);
  let backedUp = false;
  try {
    fs.cpSync(source, staged, { recursive: true, force: true });
    const copied = suiteDifference(source, staged);
    if (copied.length) throw new Error(`the proven suite copy was not byte-identical: ${copied.join(', ')}`);
    if (fs.existsSync(target)) { fs.renameSync(target, backup); backedUp = true; }
    fs.renameSync(staged, target);
    return { ok: true, promoted: true, target, backup, hadTarget: backedUp,
      repoRoot: path.resolve(targetRepoPath) };
  } catch (e) {
    try { if (fs.existsSync(staged)) fs.rmSync(staged, { recursive: true, force: true }); } catch { /* best effort */ }
    try {
      if (backedUp && fs.existsSync(backup) && !fs.existsSync(target)) fs.renameSync(backup, target);
    } catch { /* preserve the backup for recovery */ }
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

function rollbackManagedPromotion(tx) {
  if (!tx || !tx.promoted || !within(tx.repoRoot, tx.target) || !within(tx.repoRoot, tx.backup)) {
    return { ok: true, rolledBack: false };
  }
  try {
    if (fs.existsSync(tx.target)) fs.rmSync(tx.target, { recursive: true, force: true });
    if (tx.hadTarget && fs.existsSync(tx.backup)) fs.renameSync(tx.backup, tx.target);
    else if (fs.existsSync(tx.backup)) fs.rmSync(tx.backup, { recursive: true, force: true });
    return { ok: true, rolledBack: true };
  } catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
}

function finalizeManagedPromotion(tx) {
  if (!tx || !tx.promoted || !within(tx.repoRoot, tx.backup)) return { ok: true };
  try {
    if (fs.existsSync(tx.backup)) fs.rmSync(tx.backup, { recursive: true, force: true });
    return { ok: true };
  } catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
}

function markProven(prepared, attempt, evidence) {
  const markerPath = path.join(prepared.container, MARKER);
  const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  Object.assign(marker, { status: 'proven', attempts: attempt, evidenceHash: sha(Buffer.from(evidence || '')),
    provenAt: new Date().toISOString() });
  fs.writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`);
}

// An interrupted or exhausted proof is worth keeping only while we can still prove the container
// is ours. Ownership is re-read here rather than carried from preparation time: the container has
// been writable by a sandboxed model in between, and a marker, an owner record or the directory
// itself may have been removed, forged, corrupted or swapped for a reparse point since. A false
// answer authorizes nothing — no marker rewrite, no traversal, and no cleanup.
function retainUnfinished(prepared) {
  const container = prepared && prepared.container;
  if (typeof container !== 'string' || !container || !ownedContainer(container)) return false;
  const markerPath = path.join(container, MARKER);
  try {
    const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    // Only a successful gate ever writes "proven"; an unfinished state may never overwrite one.
    if (marker.status === 'proven') return false;
    marker.status = 'unfinished';
    marker.unfinishedAt = new Date().toISOString();
    fs.writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`);
    // A claim of retention is a claim about what is on disk, so read the state back before making
    // it. A write that cannot durably land reports no retention at all.
    return JSON.parse(fs.readFileSync(markerPath, 'utf8')).status === 'unfinished';
  } catch { return false; }
}

function validStageEvent(event) {
  return !!event && typeof event === 'object' && PROOF_STAGES.has(event.stage)
    && ['start', 'done'].includes(event.phase)
    && (event.attempt === null || event.attempt === undefined
      || Number.isInteger(event.attempt) && event.attempt > 0)
    && (event.elapsedMs === undefined || Number.isInteger(event.elapsedMs) && event.elapsedMs >= 0);
}

function proofStageLine(event) {
  if (!validStageEvent(event)) return null;
  const attempt = event.attempt ? ` attempt ${event.attempt}` : '';
  const elapsed = event.phase === 'done' && Number.isInteger(event.elapsedMs) ? ` in ${event.elapsedMs}ms` : '';
  return `proof${attempt}: ${event.stage} ${event.phase === 'start' ? 'started' : `finished${elapsed}`}`;
}

function runStage(seams, stage, attempt, fn) {
  const now = typeof seams.now === 'function' ? seams.now : Date.now;
  const emit = (event) => {
    if (typeof seams.onStage !== 'function') return;
    try { seams.onStage(Object.freeze(event)); } catch { /* progress is observational */ }
  };
  const started = now();
  emit({ stage, phase: 'start', attempt });
  try { return fn(); }
  finally {
    const elapsedMs = Math.max(0, Math.round(now() - started));
    emit({ stage, phase: 'done', attempt, elapsedMs });
  }
}

function prepareProbe(built, model, run = runSync, tempRoot = os.tmpdir()) {
  const suiteId = suiteIdOf(built);
  if (!validIssueId(built && built.id) || !validIssueId(suiteId)) {
    return { ok: false, error: `unsafe issue or suite id: ${(built && built.id) || suiteId}` };
  }
  const sourceSuite = path.join(built.folder.dir, 'tests', 'acceptance', suiteId);
  if (!fs.existsSync(sourceSuite) || !fs.statSync(sourceSuite).isDirectory()) {
    return { ok: false, error: `the authored suite does not exist at ${sourceSuite}` };
  }
  // Resolved before anything is created: a target that cannot be canonicalized can never be
  // re-proven the same way later, so there is no probe worth building for it.
  let targetIdentity;
  try { targetIdentity = targetIdentityOf(built); }
  catch (e) { return { ok: false, error: `cannot canonicalize the target repository: ${(e && e.message) || String(e)}` }; }
  // A verifier may run under a different host identity than the planning worker. A shared
  // mode-0700 root in the OS temp directory would then strand every later proof behind the
  // first identity that created it. Give each preparation a private namespace while retaining
  // the fixed innermost root name that the ownership validator recognizes.
  const resolvedTempRoot = path.resolve(tempRoot);
  fs.mkdirSync(resolvedTempRoot, { recursive: true });
  const namespace = fs.mkdtempSync(path.join(resolvedTempRoot, `.${PROBE_ROOT_NAME}-`));
  const probeRoot = path.join(namespace, PROBE_ROOT_NAME);
  fs.mkdirSync(probeRoot, { mode: 0o700 });
  const container = fs.mkdtempSync(path.join(probeRoot, `${PROBE_PREFIX}${suiteId}-`));
  const baseline = path.join(container, 'baseline');
  const probe = path.join(container, 'probe');
  const markerPath = path.join(container, MARKER);
  const cleanupToken = crypto.randomBytes(32).toString('hex');
  const ownership = {
    probeRoot: fs.realpathSync(probeRoot), container: fs.realpathSync(container), cleanupToken,
  };
  // The model is restricted to the probe clone inside `container`. Keep a second ownership
  // record beside, not inside, that editable container so forging its marker alone can never
  // authorize recursive cleanup in the later freeze process.
  fs.writeFileSync(ownerRecordPath(container), `${JSON.stringify({
    kind: 'multi-agent-green-probe-owner', version: 1, ...ownership,
  }, null, 2)}\n`, { mode: 0o600 });
  fs.writeFileSync(markerPath, `${JSON.stringify({
    kind: 'multi-agent-green-probe', version: 1, issue: suiteId,
    requestedIssue: built.id, model,
    sourceWorktree: path.resolve(built.folder.dir), targetIdentity,
    createdAt: new Date().toISOString(),
    ...ownership,
  }, null, 2)}\n`);

  const headResult = run('git', ['rev-parse', 'HEAD'], {
    cfg: built.cfg, kind: 'git', cwd: built.folder.dir, label: 'read test-author HEAD',
  });
  const head = String(headResult.stdout || '').trim();
  if (headResult.status !== 0 || !/^[0-9a-f]{40,64}$/i.test(head)) {
    discardNewContainer(container);
    return { ok: false, error: failureText(headResult, 'could not resolve test-author HEAD') };
  }

  for (const destination of [baseline, probe]) {
    const made = cloneAt(built.cfg, built.cfg.targetRepoPath, head, destination, run);
    if (!made.ok) {
      discardNewContainer(container);
      return made;
    }
  }

  let baseManifest;
  try { baseManifest = integrationBaseManifest(baseline, built.policy, suiteId); }
  catch (e) {
    discardNewContainer(container);
    return { ok: false, error: e.message };
  }

  for (const destination of [baseline, probe]) {
    const destSuite = path.join(destination, 'tests', 'acceptance', suiteId);
    fs.rmSync(destSuite, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(destSuite), { recursive: true });
    fs.cpSync(sourceSuite, destSuite, { recursive: true, force: true });
  }

  const baselineSuite = path.join(baseline, 'tests', 'acceptance', suiteId);
  const probeSuite = path.join(probe, 'tests', 'acceptance', suiteId);
  const copied = [...suiteDifference(sourceSuite, baselineSuite), ...suiteDifference(sourceSuite, probeSuite)];
  if (copied.length) {
    discardNewContainer(container);
    return { ok: false, error: `the suite copy was not byte-identical: ${copied.join(', ')}` };
  }

  let manifest;
  try { manifest = normalizedManagedManifest(baseline,
    protectedManifest(baseline, built.policy, suiteId), suiteId); }
  catch (e) {
    discardNewContainer(container);
    return { ok: false, error: e.message };
  }
  const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  Object.assign(marker, { head, baseManifestHash: manifestHash(baseManifest), manifestHash: manifestHash(manifest) });
  fs.writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`);
  return { ok: true, container, baseline, probe, sourceSuite, baselineSuite, probeSuite, head, manifest };
}

function resumeProbe(built, probePath, run = runSync) {
  const managed = readManagedProbe(probePath);
  if (!managed) return { ok: false, error: 'retained probe has missing or invalid ownership evidence' };
  const suiteId = suiteIdOf(built);
  const { marker, container, baseline, probe } = managed;
  // Asked first, and answered from the marker already in hand: a refusal here must not launch
  // anything, run the gate, rewrite the marker or sweep a tree, so it precedes every step below
  // that reads or writes the retained container's contents.
  const crossedRepository = targetIdentityRefusal(built, marker);
  if (crossedRepository) return { ok: false, error: crossedRepository };
  const sourceSuite = path.join(built.folder.dir, 'tests', 'acceptance', suiteId);
  const baselineSuite = path.join(baseline, 'tests', 'acceptance', suiteId);
  const probeSuite = path.join(probe, 'tests', 'acceptance', suiteId);
  if (marker.issue !== suiteId || path.resolve(marker.sourceWorktree || '') !== path.resolve(built.folder.dir)
      || marker.status === 'proven') return { ok: false, error: 'retained probe identity does not match this unfinished proof' };
  const headResult = run('git', ['rev-parse', 'HEAD'], {
    cfg: built.cfg, kind: 'git', cwd: built.folder.dir, label: 'validate retained green-probe HEAD',
  });
  const head = String(headResult.stdout || '').trim();
  if (headResult.status !== 0 || head !== marker.head) return { ok: false, error: 'retained probe no longer matches the author HEAD' };
  try {
    const manifest = normalizedManagedManifest(baseline,
      protectedManifest(baseline, built.policy, suiteId), suiteId);
    if (manifestHash(manifest) !== marker.manifestHash || suiteDifference(sourceSuite, baselineSuite).length
        || suiteDifference(sourceSuite, probeSuite).length) {
      return { ok: false, error: 'retained probe or authored suite changed while preparation was parked' };
    }
    return { ok: true, container, baseline, probe, sourceSuite, baselineSuite, probeSuite, head, manifest };
  } catch (e) { return { ok: false, error: e.message }; }
}

function probePrompt(built, previous = '') {
  const suite = `tests/acceptance/${suiteIdOf(built)}/`;
  return [
    `You are building a disposable GREEN PROBE for ${built.id}.`,
    `Make every check in ${suite} pass by editing PRODUCT CODE in this disposable clone.`,
    'This is not the production implementation. A crude, local satisfaction of the written',
    'contract is enough; the point is to prove the acceptance suite is reachable.',
    '',
    'Never edit, add, remove or rename anything under tests/acceptance/. Never edit',
    'pipeline.config.json or any frozen path. Do not use Git or Beads. You have no shell:',
    'the host controller runs the verifier after you exit and will return its evidence on a',
    'later attempt. Read the tests carefully, edit only product files, and then stop.',
    '',
    'If a product file needs an explicit Git executable-mode change, request it in your FINAL',
    'response without using Git or a shell. The host accepts only existing regular product files',
    'inside this probe, refuses protected paths, and runs the unchanged native gate afterward.',
    'For a mode request, your entire final response must be the following header and one JSON',
    'object (at most 64 changes). Use only modes 100644 and 100755 and literal relative paths:',
    MODE_INTENT.HEADER,
    '{"version":1,"changes":[{"path":"src/example.sh","mode":"100755"}]}',
    'The example is a format only: name only files whose mode you explicitly intend to change.',
    'Do not wrap a mode request in Markdown fences or add prose before or after it.',
    'If no mode changes are needed, finish with your ordinary response; no request file is needed.',
    previous ? `\nPREVIOUS HOST GATE EVIDENCE:\n${previous}` : '',
  ].filter(Boolean).join('\n');
}

function launchProbe(built, prepared, model, previous = '', run = runSync, options = {}) {
  const timeoutMs = Math.max(1, Number(built.cfg.wallClockMinutes) || 240) * 60 * 1000;
  // Direct legacy callers retain their exact argv. The managed proof explicitly requests
  // Claude's terminal JSON envelope so stdout chatter cannot become a mode request.
  const provider = AGENT.providerFor(built.cfg, 'test-probe');
  const structuredClaude = provider === 'claude' && options.structuredResult === true;
  const launched = AGENT.launch({
    provider,
    model,
    reasoningEffort: AGENT.reasoningEffortFor(built.cfg, 'test-probe'),
    command: process.env.PIPELINE_TEST_PROBE_CMD || null,
    claudeArgs: [
      '-p', '--model', model,
      '--restricted', '--permission-mode', 'acceptEdits',
      '--tools', PROBE_TOOLS,
      '--allowedTools', PROBE_TOOLS,
      '--disallowedTools', PROBE_DENIED,
      '--no-session-persistence',
      ...(structuredClaude ? ['--output-format', 'json'] : []),
    ],
    runOptions: {
      cfg: built.cfg, cwd: prepared.probe, input: `${probePrompt(built, previous)}\n`, timeoutMs,
      label: `${provider} green-probe session`, maxBuffer: MAX_BUFFER,
      // hostEnv belongs only to the host verifier below. It must not alter the agent's
      // executable, module loader, Git behavior, or permission configuration.
      env: { ...process.env },
    },
  }, run);
  // This format marker is assigned by the host, never read from model output.
  return structuredClaude ? { ...launched, probeResponseFormat: 'claude-json' } : launched;
}

function runGate(built, prepared, run = runSync) {
  const suite = `tests/acceptance/${suiteIdOf(built)}/`;
  const timeoutMs = Math.max(1, Number(built.cfg.wallClockMinutes) || 240) * 60 * 1000;
  const env = { ...process.env, FREEZE_GATE_DOCKER_IMAGE: built.cfg.image };
  if (env.PIPELINE_TESTING_FREEZE_GATE_SEAM !== '1') {
    delete env.FREEZE_GATE_CMD; delete env.FREEZE_GATE_DOCKER_CMD;
  }
  return run(process.execPath, [
    GATE, '--repo', prepared.baseline, '--tests', suite, '--green', prepared.probe,
  ], {
    cfg: built.cfg, cwd: ROOT, timeoutMs, label: 'two-direction frozen-test gate',
    maxBuffer: MAX_BUFFER, env,
  });
}

function invariantErrors(built, prepared) {
  const suiteId = suiteIdOf(built);
  const errors = [];
  for (const [label, suite] of [['baseline', prepared.baselineSuite], ['probe', prepared.probeSuite]]) {
    for (const detail of suiteDifference(prepared.sourceSuite, suite)) errors.push(`${label} suite ${detail}`);
  }
  let baseline; let probe;
  try {
    baseline = normalizedManagedManifest(prepared.baseline,
      protectedManifest(prepared.baseline, built.policy, suiteId), suiteId);
    probe = normalizedManagedManifest(prepared.probe,
      protectedManifest(prepared.probe, built.policy, suiteId), suiteId);
  } catch (e) { return [...errors, e.message]; }
  for (const detail of manifestDifference(prepared.manifest, baseline)) errors.push(`baseline protected path ${detail}`);
  for (const detail of manifestDifference(prepared.manifest, probe)) errors.push(`probe protected path ${detail}`);
  return errors;
}

function proveTests(built, model, seams = {}) {
  const run = seams.runSync || runSync;
  const prepared = runStage(seams, 'prepare', null,
    () => seams.retainedProbe
      ? (seams.resumeProbe || resumeProbe)(built, seams.retainedProbe, run)
      : (seams.prepareProbe || prepareProbe)(built, model, run, seams.tempRoot || os.tmpdir()));
  if (!prepared.ok) return { ok: false, kind: 'setup', retained: false, error: prepared.error };
  // Skipping the agent is meaningful only when resuming an already-built probe: there is nothing
  // to re-gate otherwise, and RED is never rebuilt here either way.
  const skipAgent = seams.skipAgent === true && !!seams.retainedProbe;
  const attempts = skipAgent ? 1 : Math.max(1, Number(built.cfg.testProbeAttempts) || 3);
  let evidence = '';
  let keepBaseline = false;
  try {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const launched = skipAgent
        ? { status: 0, stdout: '' }
        : runStage(seams, 'probe-agent', attempt,
          () => (seams.launchProbe || launchProbe)(built, prepared, model, evidence, run,
            { structuredResult: true }));
      if (launched.status !== 0) {
        const provider = AGENT.providerFor(built.cfg, 'test-probe');
        const limited = AGENT.usageLimitFromLaunch(provider, launched, model);
        if (limited) {
          keepBaseline = true;
          return { ...limited, kind: 'usage-limit', attempt, probe: prepared.probe, retained: true };
        }
        return { ok: false, kind: 'agent', attempt, probe: prepared.probe, retained: false,
          error: failureText(launched, 'green-probe agent failed') };
      }
      const before = runStage(seams, 'protected-check-before', attempt,
        () => (seams.invariantErrors || invariantErrors)(built, prepared));
      // Tampering is never resumable, however intact the container's ownership still looks: the
      // tree the proof would resume from is no longer the tree that was prepared.
      if (before.length) {
        return { ok: false, kind: 'tamper', attempt, probe: prepared.probe, retained: false,
          error: before.join('; ') };
      }

      let modeAudit = null;
      if (!skipAgent) {
        const requested = MODE_INTENT.requestFromLaunch(AGENT.providerFor(built.cfg, 'test-probe'), launched);
        if (requested) {
          modeAudit = MODE_INTENT.applyRequest(built, prepared, requested, readManagedProbe);
          const applied = (seams.invariantErrors || invariantErrors)(built, prepared);
          if (applied.length) return { ok: false, kind: 'tamper', attempt, probe: prepared.probe,
            retained: false, error: applied.join('; ') };
        }
      }
      const gated = runStage(seams, 'gate', attempt,
        () => (seams.runGate || runGate)(built, prepared, run));
      evidence = `${gated.stdout || ''}${gated.stderr || ''}`.trim();
      MODE_INTENT.verifyApplied(built, prepared, modeAudit, readManagedProbe);
      const after = runStage(seams, 'protected-check-after', attempt,
        () => (seams.invariantErrors || invariantErrors)(built, prepared));
      if (after.length) {
        return { ok: false, kind: 'tamper', attempt, probe: prepared.probe, retained: false,
          error: after.join('; '), evidence };
      }
      if (gated.status === 0) {
        runStage(seams, 'marker-write', attempt,
          () => (seams.markProven || markProven)(prepared, attempt, evidence));
        keepBaseline = true;
        return { ok: true, attempt, probe: prepared.probe, container: prepared.container, evidence,
          retained: true, agentOutput: String(launched.stdout || '').trim() };
      }
      if (attempt === attempts) {
        const retained = retainUnfinished(prepared);
        keepBaseline = true;
        return { ok: false, kind: 'unproven', attempt, probe: prepared.probe, retained,
          error: `the green probe did not pass after ${attempts} attempt(s)`, evidence };
      }
    }
    const retained = retainUnfinished(prepared);
    keepBaseline = true;
    return { ok: false, kind: 'unproven', probe: prepared.probe, retained,
      error: 'green probe ended without a verdict' };
  } catch (e) {
    // A recoverable fault after preparation is an interruption, not a verdict. It is retained on
    // exactly the same fresh-ownership terms as ordinary exhaustion.
    const retained = retainUnfinished(prepared);
    keepBaseline = true;
    return { ok: false, kind: 'setup', probe: prepared.probe, retained,
      error: (e && e.message) || String(e),
      ...(e && typeof e.modeIntentEvidence === 'string' ? { evidence: e.modeIntentEvidence } : {}) };
  } finally {
    // Reaching a retention decision is what sets keepBaseline above, whichever way that decision
    // went: a successful retention must survive, and a refused one proved nothing about who owns
    // the container, so neither authorizes a sweep here.
    if (!keepBaseline) {
      try { removeOwnedPath(prepared.container, prepared.baseline); } catch { /* probe remains for inspection */ }
    }
  }
}

// A refusal is diagnostic, not a transcript. Keep the reason, drop anything a wrapped host error
// may have appended past it, so one unbounded OS message cannot bury the line above it.
const MAX_DIAGNOSTIC = 300;
function boundedDiagnostic(text) {
  const line = String(text === undefined || text === null ? '' : text)
    .replace(/\s+/g, ' ').trim() || 'no reason was reported';
  return line.length <= MAX_DIAGNOSTIC ? line : `${line.slice(0, MAX_DIAGNOSTIC - 3)}...`;
}

const USAGE = 'usage: node scripts/prove-tests.js <issue-id> --config run.config.<project>.json'
  + ' [--resume-probe <retained probe dir>] [--skip-agent]';
function parseArgs(argv) {
  const opts = { id: null, config: null, resumeProbe: null, skipAgent: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--config') {
      const value = argv[++i];
      if (value === undefined || value.startsWith('--')) return { error: '--config needs a value' };
      opts.config = value;
    } else if (arg === '--resume-probe') {
      const value = argv[++i];
      if (value === undefined || value.startsWith('--')) return { error: '--resume-probe needs a value' };
      opts.resumeProbe = value;
    } else if (arg === '--skip-agent') opts.skipAgent = true;
    else if (arg === '-h' || arg === '--help') opts.help = true;
    else if (arg.startsWith('--')) return { error: `unknown option "${arg}"` };
    else if (opts.id) return { error: 'only one issue id may be proven at a time' };
    else opts.id = arg;
  }
  return opts;
}

function main(argv, out = console.log, err = console.error, seams = {}) {
  const opts = parseArgs(argv);
  if (opts.help) { out(USAGE); return 0; }
  if (opts.error || !opts.id || !opts.config || !validIssueId(opts.id)) {
    err(`prove-tests: ${opts.error || 'a safe issue id and --config are required'}`); err(USAGE); return 2;
  }
  // Re-gating without an agent only makes sense against an already-built retained probe. Refuse
  // rather than quietly preparing a fresh pair of clones and gating a probe nobody edited.
  if (opts.skipAgent && !opts.resumeProbe) {
    err('prove-tests: --skip-agent only applies to a retained probe named by --resume-probe'); err(USAGE); return 2;
  }
  const configPath = path.resolve(opts.config);
  let lockCfg;
  try { lockCfg = (seams.loadConfig || loadConfig)(configPath); }
  catch (e) { err(`prove-tests: ${(e && e.message) || String(e)}`); return 2; }
  // The structured proveTests() API deliberately owns no global lock: batch workers already
  // run under their coordinator's target ownership. The standalone CLI loads only enough
  // config to name the target, then locks before buildBrief's sole Beads read.
  const root = path.resolve(__dirname, '..');
  const lockRunId = `test-proof-cli-${process.pid}-${Date.now()}`;
  const locked = (seams.acquireLock || acquire)(root, lockCfg.targetRepoPath, lockRunId);
  if (!locked.ok) {
    const holder = locked.holder || {};
    err(`prove-tests: target is already owned by ${holder.runId || 'another live operation'}`
      + `${holder.pid ? ` (pid ${holder.pid})` : ''}; no probe was created.`);
    return 3;
  }
  try {
    if (locked.tookOver) {
      err('prove-tests: stale target ownership requires normal pipeline recovery; no Beads read or probe was started.');
      return 3;
    }
    const builder = seams.buildBrief || require('./spec-brief').buildBrief;
    const built = builder(opts);
    if (!built.ok) { err(`prove-tests: ${built.error}`); return 3; }
    if (!built.cfg || typeof built.cfg.targetRepoPath !== 'string'
        || path.resolve(built.cfg.targetRepoPath) !== path.resolve(lockCfg.targetRepoPath)) {
      err('prove-tests: run config target changed after target ownership was acquired; no probe was created.');
      return 3;
    }
    if (built.state === 'ready') { out(`${opts.id} is already frozen and dispatchable.`); return 0; }
    if (!built.folder || !built.folder.exists) {
      err(`prove-tests: no existing issue worktree contains ${opts.id}; run author-tests first`); return 3;
    }
    const model = String(built.cfg.testProbeModel || built.cfg.testAuthorModel || built.cfg.model || '').trim();
    if (!model) { err('prove-tests: no probe model is configured'); return 3; }
    const probeSeams = { ...(seams.probeSeams || {}) };
    // Additive, exactly like onStage below: a caller's own launchProbe/runGate stubs still apply,
    // and an invocation naming neither flag is byte-for-byte the command it has always been.
    if (opts.resumeProbe) probeSeams.retainedProbe = path.resolve(opts.resumeProbe);
    if (opts.skipAgent) probeSeams.skipAgent = true;
    if (typeof probeSeams.onStage !== 'function') probeSeams.onStage = (event) => {
      const line = proofStageLine(event); if (line) err(`prove-tests: ${line}`);
    };
    const proof = (seams.proveTests || proveTests)(built, model, probeSeams);
    if (proof.evidence) out(proof.evidence);
    if (!proof.ok) {
      err(`prove-tests: ${boundedDiagnostic(proof.error)}`);
      if (proof.probe) err(`probe retained for inspection: ${proof.probe}`);
      if (proof.retained === true) {
        err(`prove-tests: the unfinished proof is resumable: re-run with --resume-probe (add --skip-agent to re-gate ${opts.id} without another model launch).`);
      }
      return 4;
    }
    out(`fully proven on attempt ${proof.attempt}; retained probe: ${proof.probe}`);
    out(`human approval is still required before: node scripts/freeze.js commit ${opts.id} --config "${path.resolve(opts.config)}" --probe "${proof.probe}"`);
    return 0;
  } finally {
    (seams.releaseLock || release)(root, lockCfg.targetRepoPath, locked.ownership);
  }
}

module.exports = {
  main, parseArgs, proveTests, prepareProbe, launchProbe, runGate, probePrompt, protectedManifest,
  manifestHash, manifestDifference, normalizedManagedManifest, gitFileHashes, generatedGodotUids,
  HASH_BATCH_PATHS,
  invariantErrors, suiteDifference, validIssueId,
  suiteIdOf,
  ownerRecordPath, ownedContainer, removeOwnedPath, removeOwnedContainer, readManagedProbe, validateManagedProbe,
  resumeProbe, retainUnfinished,
  promoteManagedSuite, rollbackManagedPromotion, finalizeManagedPromotion, markProven, policyAt,
  validStageEvent, proofStageLine, runStage, PROOF_STAGES,
  PROBE_TOOLS, PROBE_DENIED, PROBE_PREFIX, PROBE_ROOT_NAME, MARKER,
};

if (require.main === module) process.exit(main(process.argv.slice(2)));
