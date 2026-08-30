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
const { runSync, failureText } = require('../runner/process');
const { acquire, release } = require('../runner/lock');
const { compareSuites } = require('./freeze-gate');
const {
  protectedManifest, manifestHash, manifestDifference, normalizedManagedManifest, within, sha,
} = require('./protected-tree');

const ROOT = path.resolve(__dirname, '..');
const GATE = path.join(ROOT, 'scripts', 'freeze-gate.js');
const PROBE_PREFIX = 'multi-agent-green-probe-';
const PROBE_ROOT_NAME = 'multi-agent-green-probes';
const MARKER = '.pipeline-green-probe.json';
const OWNER_SUFFIX = '.pipeline-green-probe-owner.json';
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
}

function discardNewContainer(container) {
  try { fs.rmSync(container, { recursive: true, force: true }); } catch { /* best effort */ }
  try { fs.rmSync(ownerRecordPath(container), { force: true }); } catch { /* best effort */ }
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
    const probeManifest = normalizedManagedManifest(probe,
      protectedManifest(probe, policy, marker.issue), marker.issue);
    const baselineManifest = normalizedManagedManifest(baseline,
      protectedManifest(baseline, policy, marker.issue), marker.issue);
    const targetHash = manifestHash(targetManifest);
    const probeHash = manifestHash(probeManifest);
    const baselineHash = manifestHash(baselineManifest);
    if (probeHash !== marker.manifestHash) {
      return { ok: false, managed: true, error: 'the retained probe changed a protected path after it was proven' };
    }
    if (baselineHash !== marker.manifestHash) {
      return { ok: false, managed: true, error: 'the retained red baseline changed a protected path after it was proven' };
    }
    const targetIsProbe = targetHash === marker.manifestHash;
    const targetIsBase = targetHash === marker.baseManifestHash;
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

function prepareProbe(built, model, run = runSync, tempRoot = os.tmpdir()) {
  const suiteId = suiteIdOf(built);
  if (!validIssueId(built && built.id) || !validIssueId(suiteId)) {
    return { ok: false, error: `unsafe issue or suite id: ${(built && built.id) || suiteId}` };
  }
  const sourceSuite = path.join(built.folder.dir, 'tests', 'acceptance', suiteId);
  if (!fs.existsSync(sourceSuite) || !fs.statSync(sourceSuite).isDirectory()) {
    return { ok: false, error: `the authored suite does not exist at ${sourceSuite}` };
  }
  const probeRoot = path.join(path.resolve(tempRoot), PROBE_ROOT_NAME);
  fs.mkdirSync(probeRoot, { recursive: true, mode: 0o700 });
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
    sourceWorktree: path.resolve(built.folder.dir), createdAt: new Date().toISOString(),
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
  try { baseManifest = normalizedManagedManifest(baseline,
    protectedManifest(baseline, built.policy, suiteId), suiteId); }
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
    previous ? `\nPREVIOUS HOST GATE EVIDENCE:\n${previous}` : '',
  ].filter(Boolean).join('\n');
}

function launchProbe(built, prepared, model, previous = '', run = runSync) {
  const timeoutMs = Math.max(1, Number(built.cfg.wallClockMinutes) || 240) * 60 * 1000;
  return run(process.env.PIPELINE_TEST_PROBE_CMD || 'claude', [
    '-p', '--model', model,
    '--restricted', '--permission-mode', 'acceptEdits',
    '--tools', PROBE_TOOLS,
    '--allowedTools', PROBE_TOOLS,
    '--disallowedTools', PROBE_DENIED,
    '--no-session-persistence',
  ], {
    cfg: built.cfg, cwd: prepared.probe, input: `${probePrompt(built, previous)}\n`, timeoutMs,
    label: 'Claude green-probe session', maxBuffer: MAX_BUFFER,
    // hostEnv belongs only to the host verifier below. It must not alter Claude's executable,
    // module loader, Git behavior, or permission configuration.
    env: { ...process.env },
  });
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
  const prepared = (seams.prepareProbe || prepareProbe)(built, model, run, seams.tempRoot || os.tmpdir());
  if (!prepared.ok) return { ok: false, kind: 'setup', error: prepared.error };
  const attempts = Math.max(1, Number(built.cfg.testProbeAttempts) || 3);
  let evidence = '';
  let keepBaseline = false;
  try {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const launched = (seams.launchProbe || launchProbe)(built, prepared, model, evidence, run);
      if (launched.status !== 0) {
        return { ok: false, kind: 'agent', attempt, probe: prepared.probe,
          error: failureText(launched, 'green-probe agent failed') };
      }
      const before = (seams.invariantErrors || invariantErrors)(built, prepared);
      if (before.length) return { ok: false, kind: 'tamper', attempt, probe: prepared.probe, error: before.join('; ') };

      const gated = (seams.runGate || runGate)(built, prepared, run);
      evidence = `${gated.stdout || ''}${gated.stderr || ''}`.trim();
      const after = (seams.invariantErrors || invariantErrors)(built, prepared);
      if (after.length) return { ok: false, kind: 'tamper', attempt, probe: prepared.probe, error: after.join('; '), evidence };
      if (gated.status === 0) {
        (seams.markProven || markProven)(prepared, attempt, evidence);
        keepBaseline = true;
        return { ok: true, attempt, probe: prepared.probe, container: prepared.container, evidence,
          agentOutput: String(launched.stdout || '').trim() };
      }
      if (attempt === attempts) {
        return { ok: false, kind: 'unproven', attempt, probe: prepared.probe,
          error: `the green probe did not pass after ${attempts} attempt(s)`, evidence };
      }
    }
    return { ok: false, kind: 'unproven', probe: prepared.probe, error: 'green probe ended without a verdict' };
  } catch (e) {
    return { ok: false, kind: 'setup', probe: prepared.probe, error: (e && e.message) || String(e) };
  } finally {
    if (!keepBaseline) {
      try { removeOwnedPath(prepared.container, prepared.baseline); } catch { /* probe remains for inspection */ }
    }
  }
}

const USAGE = 'usage: node scripts/prove-tests.js <issue-id> --config run.config.<project>.json';
function parseArgs(argv) {
  const opts = { id: null, config: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--config') {
      const value = argv[++i];
      if (value === undefined || value.startsWith('--')) return { error: '--config needs a value' };
      opts.config = value;
    } else if (arg === '-h' || arg === '--help') opts.help = true;
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
    const proof = (seams.proveTests || proveTests)(built, model, seams.probeSeams || {});
    if (proof.evidence) out(proof.evidence);
    if (!proof.ok) {
      err(`prove-tests: ${proof.error}`);
      if (proof.probe) err(`probe retained for inspection: ${proof.probe}`);
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
  manifestHash, manifestDifference, normalizedManagedManifest, invariantErrors, suiteDifference, validIssueId,
  suiteIdOf,
  ownerRecordPath, ownedContainer, removeOwnedPath, removeOwnedContainer, readManagedProbe, validateManagedProbe,
  promoteManagedSuite, rollbackManagedPromotion, finalizeManagedPromotion, markProven, policyAt,
  PROBE_TOOLS, PROBE_DENIED, PROBE_PREFIX, PROBE_ROOT_NAME, MARKER,
};

if (require.main === module) process.exit(main(process.argv.slice(2)));
