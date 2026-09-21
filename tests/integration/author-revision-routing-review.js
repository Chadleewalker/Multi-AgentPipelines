#!/usr/bin/env node
// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0
'use strict';

// Routing checks only. The companion author-revision review checks real Git fingerprints,
// source/candidate identity, author boundaries and the model-free reproof itself.
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const P = require('../../scripts/prepare-batch');
const W = require('../../scripts/prepare-batch-worker');
const State = require('../../runner/preparation-state');
const Evidence = require('../../runner/author-evidence');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'author-revision-routing-'));
const target = path.join(root, 'target');
const suite = path.join(target, 'tests', 'acceptance', 'app-1');
fs.mkdirSync(suite, { recursive: true });
fs.writeFileSync(path.join(suite, 'test.js'), '// existing authored bytes\n');
const sourceHash = 'a'.repeat(64);
const candidate = { path: path.join(root, 'candidate', 'probe'), hash: 'b'.repeat(64) };
const review = { text: 'Correct only the reviewed assertion.', hash: 'c'.repeat(64) };
const revision = { version: 1, suiteHash: sourceHash, review, candidateProbe: candidate };
const expectedAudit = { version: 1, sourceSuiteHash: sourceHash, reviewHash: review.hash, candidateHash: candidate.hash };
const cfg = { targetRepoPath: target, model: 'opus', allowHalfProven: false };
const built = { ok: true, id: 'app-1', state: 'freeze', cfg,
  policy: { verifyCommand: 'sh tools/run-acceptance.sh', frozenPaths: [] },
  folder: { exists: true, dir: target, branch: 'freeze-app-1' }, text: 'original immutable brief',
  criteria: { source: 'structured', sha256: sourceHash, text: '1. Existing behavior.' },
  issue: { id: 'app-1', title: 'fixture', dependencies: [] }, issueUpdatedAt: '2026-09-20T01:00:00Z' };
const pair = ['--candidate-probe', candidate.path, '--candidate-hash', candidate.hash];
const flags = ['--revise-suite', sourceHash, '--review', path.join(root, 'review.txt'), ...pair];
const options = () => P.parseArgs(['retry', 'wave', 'app-1', ...flags]);
let passed = 0;
function check(name, run) { run(); passed++; console.log(`PASS ${name}`); }

async function route(change = {}) {
  const prior = change.prior === null ? { started: null, result: null } : (change.prior || {
    started: { phase: 'author-proof', nonce: 'd'.repeat(32), pid: 1 },
    result: { outcome: 'unproven', data: { ok: false, kind: 'agent', outcome: 'unproven' } },
  });
  const before = JSON.stringify(prior);
  const events = []; const workers = []; const prepared = []; const messages = [];
  let ensured = 0; let reviewReads = 0;
  const snapshot = { ...built, ...(change.built || {}) };
  const state = {
    readManifest: () => ({ runConfig: 'fixture.json', concurrency: 1, issues: [{ id: 'app-1' }],
      configHash: change.configHash || 'cfg', integrationHead: 'f'.repeat(40) }),
    canonicalHash: () => 'cfg', redactConfig: (v) => v,
    readEvents: () => [{ type: 'issue.snapshotted', payload: { issueId: 'app-1',
      criteriaHash: built.criteria.sha256, issueUpdatedAt: built.issueUpdatedAt } }],
    readWorkerRecords: () => [prior], appendEvent: (_r, _b, type, payload) => events.push({ type, payload }),
  };
  const code = await P.execute({ ...options(), ...(change.opts || {}) }, { out() {}, err: (s) => messages.push(s) }, {
    state, preparationRoot: () => path.join(root, 'absent-preparations'),
    loadConfig: () => cfg, admitEntry: () => ({ ok: true, mode: 'standalone' }),
    acquire: () => ({ ok: true, tookOver: false, ownership: {} }), release() {},
    inspectIntegration: () => ({ ok: true, branch: 'main', head: change.head || 'f'.repeat(40) }),
    runSync: () => ({ status: 0, stdout: 'f'.repeat(40) }), readyQueue: () => ({ ok: true, issues: [] }),
    resolveDesign: () => change.design || ({ ok: true, commit: 'f'.repeat(40), reasons: [] }),
    buildBrief: () => snapshot, ensureWorktree: () => { ensured++; return { ok: true }; },
    readReview: () => { reviewReads++; return review; },
    prepareRevision: (b, request, selected) => {
      prepared.push({ b, request, selected });
      if (change.prepareError) throw Error(change.prepareError);
      return revision;
    },
    runWorker: async (_r, _b, item) => { workers.push(item); return { id: item.id, ok: true, outcome: 'proven-at-base' }; },
  });
  assert.equal(JSON.stringify(prior), before, 'routing must not rewrite prior evidence');
  return { code, events, workers, prepared, messages, ensured, reviewReads };
}

async function main() {
  check('revision parser requires the complete explicit single-issue selection', () => {
    const parsed = options();
    assert.equal(parsed.error, undefined); assert.equal(parsed.reviseSuite, sourceHash);
    assert.deepEqual(parsed.candidateProbe, candidate);
    for (const args of [
      ['retry', 'wave', 'app-1', '--revise-suite', sourceHash, ...pair],
      ['retry', 'wave', 'app-1', '--review', 'review.txt', ...pair],
      ['retry', 'wave', 'app-1', '--revise-suite', sourceHash, '--review', 'review.txt'],
      ['retry', 'wave', 'app-1', 'app-2', ...flags], ['resume', 'wave', ...flags],
      ['start', 'wave', '--config', 'x', '--issue', 'app-1', ...flags],
      ['retry', 'wave', 'app-1', ...flags, '--resume-partial'],
      ['retry', 'wave', 'app-1', ...flags, '--review', 'again'],
      ['retry', 'wave', 'app-1', '--revise-suite', 'A'.repeat(64), '--review', 'x', ...pair],
    ]) assert.ok(P.parseArgs(args).error, JSON.stringify(args));
  });
  const ordinary = P.parseArgs(['retry', 'wave', 'app-1', ...pair]);
  check('ordinary candidate retry remains revision-free', () => {
    assert.equal(ordinary.error, undefined); assert.equal(ordinary.reviseSuite, undefined);
  });
  const admitted = await route();
  check('completed unfrozen suite routes one fresh author-proof without changing brief state', () => {
    assert.equal(admitted.code, 0); assert.equal(admitted.workers.length, 1);
    assert.equal(admitted.ensured, 0); assert.equal(admitted.prepared.length, 1);
    const item = admitted.workers[0]; assert.equal(item.action, 'author-proof');
    assert.equal(item.built.state, 'freeze'); assert.deepEqual(item.revision, revision);
    assert.equal(item.candidateProbe, undefined); assert.equal(item.retainedProbe, undefined);
    assert.deepEqual(admitted.prepared[0].request, { suiteHash: sourceHash, review });
  });
  const proven = await route({ prior: { started: { phase: 'proof', nonce: 'd'.repeat(32) }, result: { outcome: 'proven-at-base' } } });
  check('a completed proven but unfrozen suite is also eligible', () => assert.equal(proven.workers.length, 1));
  for (const [name, change] of [
    ['frozen', { built: { state: 'ready' } }], ['re-gate', { built: { state: 're-gate' } }],
    ['new-author', { built: { state: 'write' } }], ['missing-worktree', { built: { folder: { ...built.folder, exists: false } } }],
    ['missing-prior', { prior: null }],
    ['unsettled-author', { prior: { started: { phase: 'author-proof' }, result: null } }],
    ['incomplete-author', { prior: { started: { phase: 'author-proof' }, result: { outcome: 'agent-incomplete' } } }],
    ['changed-criteria', { built: { criteria: { ...built.criteria, sha256: 'e'.repeat(64) } } }],
    ['changed-updated-at', { built: { issueUpdatedAt: '2026-09-20T02:00:00Z' } }],
    ['missing-design', { design: { ok: false, reasons: ['unparsable'], remedies: [], refs: [] } }],
    ['config-drift', { configHash: 'other' }], ['base-drift', { head: 'e'.repeat(40) }],
  ]) {
    const denied = await route(change);
    check(`${name} refuses before revision inspection, worktree mutation or worker launch`, () => {
      assert.notEqual(denied.code, 0); assert.equal(denied.workers.length, 0);
      assert.equal(denied.ensured, 0); assert.equal(denied.prepared.length, 0);
    });
  }
  const badHash = await route({ prepareError: 'source suite fingerprint changed' });
  check('revision identity refusal starts no worker', () => assert.equal(badHash.workers.length, 0));
  const ordinaryRoute = await route({ opts: { reviseSuite: undefined, review: undefined } });
  check('ordinary candidate reuse still selects proof-only', () => {
    assert.equal(ordinaryRoute.workers[0].action, 'proof');
    assert.deepEqual(ordinaryRoute.workers[0].candidateProbe, candidate);
    assert.equal(ordinaryRoute.workers[0].revision, undefined);
  });
  for (const outcome of ['agent-failed', 'agent-incomplete', 'usage-limit', 'abandoned']) {
    for (const mode of ['resume', 'retry']) {
      const savedSuite = fs.readFileSync(path.join(suite, 'test.js'));
      const blocked = await route({
        prior: { started: { phase: 'author-proof', nonce: 'd'.repeat(32), data: { revision: expectedAudit } },
          result: { outcome, data: { ok: false, outcome, acknowledgedInterrupted: outcome === 'abandoned',
            interruptedPhase: 'author-proof', rateLimit: { resetAt: '2020-01-01T00:00:00.000Z', evidence: 'limit reached' } } } },
        opts: { mode, reviseSuite: undefined, review: undefined, candidateProbe: undefined, resumePartial: mode === 'retry' },
      });
      check(`${mode} cannot discard a ${outcome} correction's explicit intent`, () => {
        assert.equal(blocked.code, P.EXIT_ATTENTION); assert.equal(blocked.workers.length, 0);
        assert.equal(blocked.ensured, 0); assert.equal(blocked.prepared.length, 0);
        assert.ok(blocked.messages.some((s) => s.includes('requires human review and explicit recovery')));
        assert.deepEqual(fs.readFileSync(path.join(suite, 'test.js')), savedSuite);
      });
    }
  }
  const failedGate = await route({
    prior: { started: { phase: 'author-proof', data: { revision: expectedAudit } },
      result: { outcome: 'unproven', data: { ok: false, kind: 'unproven' } } },
    opts: { reviseSuite: undefined, review: undefined },
  });
  check('a completed correction with failed gate can still reuse a candidate for proof-only retry', () => {
    assert.equal(failedGate.code, 0); assert.equal(failedGate.workers.length, 1);
    assert.equal(failedGate.workers[0].action, 'proof');
    assert.deepEqual(failedGate.workers[0].candidateProbe, candidate);
  });
  const job = { action: 'author-proof', built, configPath: 'fixture.json', revision };
  check('worker rejects mismatched phase, state and duplicate selectors', () => {
    assert.equal(W.validateJob(job), null);
    for (const invalid of [{ ...job, action: 'proof' }, { ...job, built: { ...built, state: 'write' } },
      { ...job, built: { ...built, state: 're-gate' } }, { ...job, retainedProbe: 'old' },
      { ...job, candidateProbe: candidate }, { ...job, revision: { ...revision, review: { text: '', hash: review.hash } } }]) {
      assert.ok(W.validateJob(invalid));
    }
  });
  let authors = 0;
  const answer = W.execute(job, {
    authorIssue: (b, _c, _io, seams) => {
      authors++; assert.equal(b.state, 'freeze'); assert.deepEqual(seams.revision, revision);
      assert.deepEqual(seams.probeSeams.candidateProbe, candidate);
      return { ok: true, probe: 'fresh/probe', revision: { ...expectedAudit, authorElapsedMs: 25, resultSuiteHash: 'e'.repeat(64) } };
    },
    runSync: () => ({ status: 0, stdout: 'f'.repeat(40) }),
    validateManagedProbe: () => ({ ok: true, managed: true, marker: { issue: 'app-1', candidateReuse: { version: 1 } } }),
  });
  check('worker hands the unchanged snapshot to author and persists revision proof audit', () => {
    assert.ok(answer.ok); assert.equal(authors, 1); assert.equal(answer.revision.authorElapsedMs, 25);
    assert.deepEqual(answer.proof.revision, answer.revision);
    assert.equal(answer.proof.candidateReuse.version, 1); assert.ok(!JSON.stringify(answer).includes(review.text));
  });
  for (const [name, authorIssue] of [
    ['failure', () => ({ ok: false, outcome: 'agent-incomplete', error: 'unfinished' })],
    ['exception', () => { throw Error('interrupted'); }],
  ]) {
    const refused = W.execute(job, { authorIssue });
    check(`${name} retains compact audit and conservative author evidence`, () => {
      assert.equal(refused.ok, false); assert.deepEqual(refused.revision, expectedAudit);
      assert.equal(Evidence.classify({ suiteFiles: ['test.js'], latest: {
        started: { phase: 'author-proof' }, result: refused } }).state, Evidence.STATES.INTERRUPTED_PARTIAL);
    });
  }
  const stateRoot = path.join(root, 'durable');
  State.createManifest(stateRoot, 'wave', { project: 'fixture', runConfig: 'fixture.json', intent: 'test',
    concurrency: 1, config: {}, issues: [{ id: 'app-1', dependencies: [] }] });
  const nonce = State.createWorkerNonce();
  State.writeWorkerStarted(stateRoot, 'wave', 'app-1', { nonce, pid: process.pid, phase: 'author-proof' });
  State.writeWorkerResult(stateRoot, 'wave', 'app-1', { nonce, outcome: 'unproven', exitCode: 1, data: { ok: false } });
  const priorBytes = JSON.stringify(State.readWorkerRecords(stateRoot, 'wave', 'app-1'));
  const child = new EventEmitter(); child.pid = process.pid; child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  let supplied;
  child.stdin = { end: (text) => { supplied = JSON.parse(text); setImmediate(() => {
    child.stdout.emit('data', Buffer.from(JSON.stringify({ ok: false, outcome: 'agent-incomplete', revision: expectedAudit })));
    child.emit('close', 1);
  }); } };
  await P.runWorker(stateRoot, 'wave', { id: 'app-1', action: 'author-proof', built, revision }, 'fixture.json', State,
    { spawn: () => child, markPreparationUncertain() {}, clearPreparationUncertain() {} });
  const records = State.readWorkerRecords(stateRoot, 'wave', 'app-1');
  check('fresh durable generation preserves old result and stores only compact start audit', () => {
    assert.equal(records.length, 2); assert.equal(JSON.stringify(records.slice(0, 1)), priorBytes);
    assert.equal(records[1].started.generation, records[0].started.generation + 1);
    assert.equal(records[1].started.phase, 'author-proof');
    assert.deepEqual(records[1].started.data.revision, expectedAudit);
    assert.ok(!JSON.stringify(records[1].started).includes(review.text));
    assert.deepEqual(supplied.revision, revision); assert.equal(supplied.candidateProbe, undefined);
    assert.deepEqual(records[1].result.data.revision, expectedAudit);
  });
  console.log(`${passed} author revision routing checks passed`);
}

main().catch((error) => { console.error(error.stack); process.exitCode = 1; }).finally(() => {
  if (path.dirname(root) === path.resolve(os.tmpdir()) && path.basename(root).startsWith('author-revision-routing-')) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
