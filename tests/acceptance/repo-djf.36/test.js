// Frozen acceptance test — repo-djf.36: canonical supervisor project identity.
//
// CRITERION PAIRING
// C1: Windows-equivalent kickoff targets and project spellings are accepted once.
// C2: those spellings select one durable supervisor state directory.
// C3: a different canonical target changes state identity and is refused before journaling.
// C4: POSIX case and symlink identity is checked by guard.js and this suite's state-key seam.
// C5: restart through an equivalent spelling reuses its journal and immutable receipts once.
// C6: these probes use production proposal-supervisor and kickoff verification with no external calls.
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..', '..');
const MODULE = path.join(ROOT, 'runner', 'proposal-supervisor.js');
const kickoff = require(path.join(ROOT, 'scripts', 'kickoff.js'));
const lock = require(path.join(ROOT, 'runner', 'lock.js'));
const api = require(MODULE);
const tests = [];
function test(name, body) { tests.push({ name, body }); }
function record(id, target) {
  const intent = JSON.stringify({ version: 'kickoff-intake/1', title: 'identity proof', description: '', constraints: [], examples: [], nonGoals: [], priority: 3, relations: [], origin: null });
  return { version: 'kickoff-intake/1', id, target, intent,
    hash: `sha256:${crypto.createHash('sha256').update(intent).digest('hex')}`,
    createdAt: '2026-09-14T00:00:00.000Z' };
}
// This injected authority represents runner/lock's Windows result without pretending that
// the POSIX test host has Windows path semantics. Every listed spelling is one repository.
const WINDOWS_TARGET = 'c:\\tmp\\mixed\\project';
const windowsSpellings = [
  'C:\\tmp\\Mixed\\Project', 'c:/tmp/mixed/project/',
  'C:\\tmp\\Mixed\\.\\Project', 'C:\\tmp\\Mixed\\scratch\\..\\Project', '.\\Project',
];
function windowsCanonical(value) {
  if (windowsSpellings.includes(value) || value === WINDOWS_TARGET) return WINDOWS_TARGET;
  if (value === 'D:\\tmp\\Elsewhere\\Project') return 'd:\\tmp\\elsewhere\\project';
  throw new Error(`unexpected Windows spelling: ${value}`);
}
function journalEvents(dir) {
  const file = path.join(dir, 'events.jsonl');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse) : [];
}

test('C1+C6 production kickoff verification accepts every injected Windows-equivalent spelling exactly once', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-djf36-c1-'));
  try {
    const stateDir = path.join(root, 'state');
    const production = api.productionAdapters(ROOT);
    const verified = record('kp-windows-identity', 'C:\\tmp\\Mixed\\Project');
    // This is the actual immutable kickoff verifier, not a replacement test adapter.
    assert.deepStrictEqual(production.kickoff.verify(verified), kickoff.verifyRecord(verified, verified.id, verified.target));
    const supervisor = api.createProductionSupervisor({ project: windowsSpellings[0], stateDir,
      adapters: { ...production, kickoff: { verify: production.kickoff.verify, list: async () => [] } },
      canonicalTarget: windowsCanonical, testingSentinel: api.TESTING_SENTINEL });
    const results = [];
    for (const spelling of windowsSpellings) {
      // A restart/configuration spelling is the input identity being tested, not record mutation.
      const peer = api.createProductionSupervisor({ project: spelling, stateDir,
        adapters: { ...production, kickoff: { verify: production.kickoff.verify, list: async () => [] } },
        canonicalTarget: windowsCanonical, testingSentinel: api.TESTING_SENTINEL });
      results.push(await peer.submit(verified));
    }
    const events = journalEvents(stateDir).filter(e => e.type === 'proposal.submitted');
    assert(results.every(r => r && r.accepted === true), JSON.stringify(results));
    assert.strictEqual(events.length, 1, JSON.stringify(events));
    assert.strictEqual((await supervisor.status(verified.id)).kickoffHash, verified.hash);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('C2+C4 supervisorStateDirFor hashes canonical identity, preserving real POSIX distinctions', () => {
  const env = { PIPELINE_STATE_DIR: path.join(os.tmpdir(), 'repo-djf36-state-root') };
  const windows = windowsSpellings.map(spelling => api.supervisorStateDirFor(spelling, env, windowsCanonical));
  assert.strictEqual(new Set(windows).size, 1, JSON.stringify(windows));
  if (process.platform === 'win32') return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-djf36-posix-'));
  try {
    const lower = path.join(root, 'project'), upper = path.join(root, 'PROJECT'), link = path.join(root, 'link');
    fs.mkdirSync(lower); fs.mkdirSync(upper); fs.symlinkSync(lower, link);
    assert.notStrictEqual(api.supervisorStateDirFor(lower, env, lock.canonicalTarget), api.supervisorStateDirFor(upper, env, lock.canonicalTarget));
    assert.strictEqual(api.supervisorStateDirFor(lower, env, lock.canonicalTarget), api.supervisorStateDirFor(link, env, lock.canonicalTarget));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('C3 a genuinely different canonical target is refused before journal mutation and receives a different state directory', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-djf36-c3-'));
  try {
    const stateDir = path.join(root, 'state');
    const before = journalEvents(stateDir);
    const production = api.productionAdapters(ROOT);
    const supervisor = api.createProductionSupervisor({ project: windowsSpellings[0], stateDir,
      adapters: { ...production, kickoff: { verify: production.kickoff.verify, list: async () => [] } },
      canonicalTarget: windowsCanonical, testingSentinel: api.TESTING_SENTINEL });
    await assert.rejects(() => supervisor.submit(record('kp-other', 'D:\\tmp\\Elsewhere\\Project')), /kickoff verification failed/i);
    assert.deepStrictEqual(journalEvents(stateDir), before);
    const env = { PIPELINE_STATE_DIR: path.join(root, 'durable') };
    assert.notStrictEqual(api.supervisorStateDirFor(windowsSpellings[0], env, windowsCanonical), api.supervisorStateDirFor('D:\\tmp\\Elsewhere\\Project', env, windowsCanonical));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('C5+C6 production restart through an equivalent spelling reuses one journal and ingests immutable receipts once', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-djf36-c5-'));
  try {
    const env = { PIPELINE_STATE_DIR: path.join(root, 'durable') };
    const stateDir = api.supervisorStateDirFor(windowsSpellings[0], env, windowsCanonical);
    const receipt = record('kp-restart-receipt', 'C:\\tmp\\Mixed\\Project');
    const production = api.productionAdapters(ROOT);
    const adapters = { ...production, kickoff: { verify: production.kickoff.verify, list: async () => [receipt] },
      specification: { execute: async () => ({ status: 'needs-input', question: 'fixture pause', evidenceHash: 'fixture' }) } };
    const first = api.createProductionSupervisor({ project: windowsSpellings[0], stateDir, adapters, canonicalTarget: windowsCanonical, testingSentinel: api.TESTING_SENTINEL });
    await first.resume();
    const restartedStateDir = api.supervisorStateDirFor(windowsSpellings[1], env, windowsCanonical);
    assert.strictEqual(restartedStateDir, stateDir, 'equivalent restart spelling must reopen the original durable journal');
    const restarted = api.createProductionSupervisor({ project: windowsSpellings[1],
      stateDir: restartedStateDir, adapters,
      canonicalTarget: windowsCanonical, testingSentinel: api.TESTING_SENTINEL });
    await restarted.resume();
    const events = journalEvents(stateDir).filter(e => e.type === 'proposal.submitted');
    assert.strictEqual(events.length, 1, JSON.stringify(events));
    assert.strictEqual((await restarted.status(receipt.id)).kickoffHash, receipt.hash);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

(async () => {
  let failed = 0;
  for (const item of tests) {
    try { await item.body(); console.log(`[test] PASS ${item.name}`); }
    catch (error) { failed += 1; console.error(`[test] FAIL ${item.name}: ${error.stack || error.message}`); }
  }
  if (failed) { console.error(`[test] FAIL ${failed}/${tests.length} focused checks`); process.exitCode = 1; }
  else console.log(`[test] PASS ${tests.length}/${tests.length} focused checks`);
})().catch(error => { console.error(`[test] FAIL harness: ${error.stack || error.message}`); process.exitCode = 1; });
