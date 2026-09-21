// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0
'use strict';

// A controller call returning does not mean its preparation child finished. Compose the
// real host lease/grants/admission, operation manager, preparation records and supervisor
// journal across repeated ticks and reconstruction. Substitute planner/intake/publication
// execution and child execution only; no Docker, Git, model or Beads access is required.
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const REPO = path.resolve(__dirname, '../..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'preparation-lifetime-review-'));
const saved = new Map(['PIPELINE_GLOBAL_LOCK_DIR', 'PIPELINE_STATE_DIR', 'PIPELINE_CHILD_AUTHORITY']
  .map(key => [key, process.env[key]]));
process.env.PIPELINE_GLOBAL_LOCK_DIR = path.join(tmp, 'host-locks');
process.env.PIPELINE_STATE_DIR = path.join(tmp, 'host-state');
delete process.env.PIPELINE_CHILD_AUTHORITY;
const SUP = require(path.join(REPO, 'runner/proposal-supervisor'));
const AUTH = require(path.join(REPO, 'runner/supervisor'));
const LOCK = require(path.join(REPO, 'runner/lock'));
const PREP = require(path.join(REPO, 'runner/preparation-state'));
const OPS = require(path.join(REPO, 'runner/operation-manager'));
const project = path.join(tmp, 'project');
const host = path.join(tmp, 'pipeline-host');
const prepRoot = path.join(tmp, 'preparations');
const opsRoot = path.join(tmp, 'operations');
const runsRoot = path.join(tmp, 'runs');
const stateDir = path.join(tmp, 'conveyor');
fs.mkdirSync(project);
fs.mkdirSync(host);
const configPath = path.join(tmp, 'run.config.json');
const launches = [];
const observations = new Map();
let lease;
let manager;
let passed = false;
function complete(entry) {
  if (entry.finished) return;
  PREP.writeWorkerResult(prepRoot, entry.batchId, entry.issueId,
    { nonce: entry.workerNonce, outcome: 'unproven', exitCode: 1, data: { fixture: true } });
  entry.child.emit('exit', 1, null);
  entry.finished = true;
}
function spawn(_command, argv, options) {
  assert.match(String(argv[0]), /prepare-batch\.js$/, 'this regression launches only preparation children');
  const admitted = AUTH.admitEntry('preparation', {
    targetRepoPath: project, repoRoot: host, env: options.env,
  });
  assert.equal(admitted.ok, true, admitted.message);
  assert.equal(admitted.mode, 'supervisor-child');
  const batchId = argv[2];
  const issueId = argv[argv.indexOf('--issue') + 1];
  PREP.createManifest(prepRoot, batchId, {
    project, runConfig: configPath, intent: 'preparation lifetime regression',
    issues: [issueId], config: { targetRepoPath: project },
  });
  const workerNonce = PREP.createWorkerNonce();
  PREP.writeWorkerStarted(prepRoot, batchId, issueId, {
    nonce: workerNonce, phase: 'author-proof', pid: process.pid,
    process: LOCK.livenessFields(process.pid),
  });
  // A controllable child stand-in stays live after this call returns. Its exit event and
  // real terminal preparation record are independent; the manager still decides settlement.
  const child = new EventEmitter();
  child.pid = process.pid;
  launches.push({ child, batchId, issueId, workerNonce, finished: false });
  return child;
}
const hash = value => `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
function record(index) {
  const intent = JSON.stringify({ title: `capacity idea ${index}` });
  return { version: 'kickoff-intake/1', id: `kp-capacity-${index}`, target: project,
    hash: hash(intent), intent, createdAt: '2026-09-19T00:00:00.000Z' };
}
async function ticks(controller, count) {
  for (let n = 0; n < count; n += 1) await controller.tick();
}
async function main() {
  const held = AUTH.acquire(host, project, `preparation-lifetime-review-${process.pid}`);
  assert.equal(held.ok, true, held.reason);
  lease = held.lease;
  const production = SUP.productionAdapters(host, {
    configPath, lease, operationStateRoot: opsRoot, runsRoot,
  });
  manager = OPS.createHostOperationManager({ pipelineRoot: REPO, stateRoot: opsRoot,
    preparationRoot: prepRoot, runsRoot, spawn });
  const adapters = {
    kickoff: { verify: item => item, list: () => [] },
    specification: { model: 'fixture', execute: async item => ({
      status: 'ready', issueId: `issue-${item.id}`,
    }) },
    authority: production.authority,
    operations: {
      startPreparation: input => manager.startPreparation(input),
      status: input => {
        observations.set(input.id, (observations.get(input.id) || 0) + 1);
        return manager.status(input);
      },
      startImplementation: () => { throw new Error('Unproven fixture work must not start implementation'); },
    },
    publication: { observe: () => ({ ok: true, published: false, refusal: 'no-suite' }) },
    review: { evidence: () => null },
  };
  const build = () => SUP.createProductionSupervisor({ repoRoot: host, project, stateDir,
    configPath, adapters, testingSentinel: SUP.TESTING_SENTINEL, globalConcurrency: 3,
    stageConcurrency: { specification: 3, preparation: 2, review: 1 } });
  let controller = build();
  for (let index = 1; index <= 5; index += 1) await controller.submit(record(index));
  await ticks(controller, 4);
  assert.equal(launches.length, 2, 'two live children retain both slots across later ticks');
  assert.equal(AUTH.outstanding(project).filter(row => row.scope === 'preparation').length, 2,
    'waiting proposals do not acquire extra preparation grants');
  assert.equal(launches.filter(entry => !entry.finished).length, 2);
  console.log('ok - two live children occupy both slots after their start calls return');

  const observedBefore = launches.map(entry => observations.get(entry.batchId) || 0);
  controller = build();
  await ticks(controller, 4);
  assert.equal(launches.length, 2, 'reconstruction must not reset child capacity');
  launches.forEach((entry, index) => assert.ok((observations.get(entry.batchId) || 0) > observedBefore[index],
    'zero free admission slots must not block observation'));
  console.log('ok - journal reconstruction retains capacity and continues polling at zero free slots');

  complete(launches[0]);
  await ticks(controller, 3);
  assert.equal(launches.length, 3, 'one settled child admits exactly one waiting proposal');
  assert.equal(launches.filter(entry => !entry.finished).length, 2);
  assert.equal(AUTH.outstanding(project).filter(row => row.scope === 'preparation').length, 2);
  const failed = PREP.deriveState(prepRoot, launches[0].batchId);
  assert.equal(failed.issues[0].state, 'unproven', 'settlement frees capacity without claiming proof success');
  console.log('ok - real operation settlement frees one slot while preserving UNPROVEN');

  // A real grant may survive a crash before preparation.granted reached this journal.
  // Give it no operation or proposal record: the authoritative reader must still count it.
  const orphan = AUTH.grant(lease, { scope: 'preparation', issueId: 'orphan-issue',
    batch: 'orphan-batch', ttlMs: AUTH.MAX_TTL_MS });
  assert.equal(orphan.ok, true, orphan.error);
  complete(launches[1]);
  complete(launches[2]);
  await ticks(controller, 4);
  assert.equal(launches.length, 4, 'one orphan grant leaves room for only one new child');
  assert.equal(launches.filter(entry => !entry.finished).length, 1);
  const stillOutstanding = AUTH.outstanding(project);
  assert.equal(stillOutstanding.length, 2);
  assert.ok(stillOutstanding.some(row => row.nonce === orphan.authority.nonce));
  const journal = fs.readFileSync(path.join(stateDir, 'events.jsonl'), 'utf8');
  assert.equal(journal.includes(orphan.authority.nonce), false, 'orphan authority is absent from the proposal journal');
  console.log('ok - an unknown host grant reserves capacity even without a journal or operation record');

  const released = AUTH.settle(lease, orphan.authority.nonce, { outcome: 'released' });
  assert.equal(released.ok, true, released.error);
  await ticks(controller, 3);
  assert.equal(launches.length, 5, 'explicit release admits exactly one remaining proposal');
  assert.equal(launches.filter(entry => !entry.finished).length, 2);
  assert.equal(AUTH.outstanding(project).filter(row => row.scope === 'preparation').length, 2);
  await ticks(controller, 2);
  assert.equal(launches.length, 5, 'settled observations do not cause duplicate launches');
  console.log('ok - explicit release frees one reserved slot without duplicate launches');
  passed = true;
}
main().catch(error => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}).finally(() => {
  // Every child above is an in-process fixture. Finish its authentic records before
  // releasing the disposable authority; no real worker or external process is stopped.
  if (lease) {
    for (const entry of launches) {
      complete(entry);
      manager.status({ project, id: entry.batchId });
    }
    for (const grant of AUTH.outstanding(project)) {
      AUTH.settle(lease, grant.nonce, { outcome: 'released' });
    }
    AUTH.release(host, project, lease);
  }
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  if (passed) fs.rmSync(tmp, { recursive: true, force: true });
  else console.error(`Fixture evidence retained at ${tmp}`);
});
