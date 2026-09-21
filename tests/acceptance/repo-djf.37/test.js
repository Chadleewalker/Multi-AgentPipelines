// Frozen acceptance test — repo-djf.37: resume interrupted specification work.
//
// CRITERION PAIRING
// C1: T1 resumes an interrupted production supervisor from its immutable kickoff record.
// C2: T2 proves repeated restarts converge without duplicate stage/completion/identity.
// C3: guard.js G1 preserves the completed-controller no-reinvoke boundary.
// C4: T3 resumes three interrupted proposals under FIFO global/specification limits.
// C5: T4 retains queued and answered-needs-input transitions while refusing invalid history.
// C6: T1-T3 use the production supervisor with deterministic in-process controller seams only.
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..', '..');
const api = require(path.join(ROOT, 'runner', 'proposal-supervisor.js'));
const tests = [];
function test(name, body) { tests.push({ name, body }); }
function record(id, target) {
  const intent = JSON.stringify({ version: 'kickoff-intake/1', title: id, description: 'immutable fixture', constraints: [], examples: [], nonGoals: [], priority: 3, relations: [], origin: null });
  return { version: 'kickoff-intake/1', id, target, intent,
    hash: `sha256:${crypto.createHash('sha256').update(intent).digest('hex')}`, createdAt: '2026-09-15T00:00:00.000Z' };
}
function event(sequence, type, body = {}) { return { sequence, type, at: '2026-09-15T00:00:00.000Z', ...body }; }
function interrupted(dir, r, sequence = 1) { fs.mkdirSync(dir, { recursive: true }); fs.appendFileSync(path.join(dir, 'events.jsonl'), `${JSON.stringify(event(sequence, 'proposal.submitted', { proposalId: r.id, record: r }))}\n${JSON.stringify(event(sequence + 1, 'stage', { proposalId: r.id, stage: 'queued' }))}\n${JSON.stringify(event(sequence + 2, 'stage', { proposalId: r.id, stage: 'specifying' }))}\n`); }
function events(dir) { return fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse); }
function create(dir, project, adapters, options = {}) { return api.createProductionSupervisor({ project, stateDir: dir, adapters, testingSentinel: api.TESTING_SENTINEL, ...options }); }
function quietKickoff() { return { verify: async value => value, list: async () => [] }; }

test('T1 C1+C6 production resume re-invokes specification from the original immutable kickoff record without external calls', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-djf37-c1-'));
  try {
    const project = path.join(root, 'project'), dir = path.join(root, 'state'), r = record('kp-resume', project); interrupted(dir, r);
    const calls = [];
    const s = create(dir, project, { kickoff: quietKickoff(), specification: { execute: async value => { calls.push(value); return { status: 'needs-input', question: 'deterministic question', evidenceHash: 'fixture' }; } } });
    await s.resume();
    assert.strictEqual(calls.length, 1, 'the interrupted controller must be invoked once');
    assert.deepStrictEqual(calls[0], r, 'recovery must use the original immutable kickoff record');
    assert.strictEqual((await s.status(r.id)).stage, 'needs-input');
    assert.strictEqual(events(dir).filter(x => x.type === 'specification.completed').length, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('T2 C2 repeated restart converges on one proposal, canonical issue identity, and one durable completion', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-djf37-c2-'));
  try {
    const project = path.join(root, 'project'), dir = path.join(root, 'state'), r = record('kp-once', project); interrupted(dir, r); let calls = 0;
    const adapters = { kickoff: quietKickoff(), specification: { execute: async () => { calls += 1; return { status: 'ready', issueId: 'repo-canonical', receipt: { issueId: 'repo-canonical', specHash: 'sha256:spec' } }; } } };
    await create(dir, project, adapters).resume();
    const restarted = create(dir, project, adapters); await restarted.resume();
    const history = events(dir), status = await restarted.status(r.id);
    assert.strictEqual(calls, 1); assert.strictEqual(status.issueId, 'repo-canonical');
    assert.deepStrictEqual(history.filter(x => x.type === 'proposal.submitted').map(x => x.proposalId), [r.id]);
    assert.strictEqual(history.filter(x => x.type === 'stage' && x.stage === 'specifying').length, 1);
    assert.strictEqual(history.filter(x => x.type === 'specification.completed').length, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('T3 C4+C6 three independently interrupted proposals resume FIFO within global and specification ceilings', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-djf37-c4-'));
  try {
    const project = path.join(root, 'project'), dir = path.join(root, 'state');
    const records = ['kp-first', 'kp-second', 'kp-third'].map(id => record(id, project));
    records.forEach((r, index) => interrupted(dir, r, index * 3 + 1));
    const started = [], releases = []; let active = 0, peak = 0;
    const s = create(dir, project, { kickoff: quietKickoff(), specification: { execute: async r => {
      started.push(r.id); active += 1; peak = Math.max(peak, active);
      return new Promise(resolve => releases.push(() => { active -= 1; resolve({ status: 'needs-input', question: r.id }); }));
    } } }, { globalConcurrency: 2, stageConcurrency: { specification: 2 } });
    const firstTurn = s.resume(); await new Promise(resolve => setImmediate(resolve));
    assert.deepStrictEqual(started, records.slice(0, 2).map(r => r.id)); assert(peak <= 2 && active <= 2, JSON.stringify({ peak, active }));
    releases.splice(0).forEach(release => release()); await firstTurn;
    const secondTurn = s.resume(); await new Promise(resolve => setImmediate(resolve));
    assert.deepStrictEqual(started, records.map(r => r.id)); assert(peak <= 2 && active <= 2, JSON.stringify({ peak, active }));
    releases.splice(0).forEach(release => release()); await secondTurn;
    assert.deepStrictEqual((await s.status()).proposals.map(row => row.proposalId), records.map(r => r.id));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('T4 C5 queued and answered-needs-input transitions remain valid while invalid durable history is refused', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-djf37-c5-'));
  try {
    const project = path.join(root, 'project'), r = record('kp-queued', project); let calls = 0;
    const adapters = { kickoff: quietKickoff(), specification: {
      execute: async () => { calls += 1; return { status: 'needs-input', question: 'fixture question' }; },
      answer: async () => ({ status: 'answered' }),
    } };
    const s = create(path.join(root, 'valid'), project, adapters);
    await s.submit(r); await s.resume(); assert.strictEqual((await s.status(r.id)).stage, 'needs-input');
    assert.deepStrictEqual(await s.answer(r.id, { evidenceHash: 'fixture', text: 'answer' }), { ok: true });
    await s.resume(); assert.strictEqual(calls, 2);
    const invalid = record('kp-invalid', project), invalidDir = path.join(root, 'invalid');
    fs.mkdirSync(invalidDir); fs.writeFileSync(path.join(invalidDir, 'events.jsonl'), `${JSON.stringify(event(1, 'proposal.submitted', { proposalId: invalid.id, record: invalid }))}\n${JSON.stringify(event(2, 'stage', { proposalId: invalid.id, stage: 'criticizing' }))}\n`);
    assert.throws(() => create(invalidDir, project, { kickoff: quietKickoff() }), /invalid transition/i);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

(async () => {
  let failed = 0;
  for (const item of tests) { try { await item.body(); console.log(`[test] PASS ${item.name}`); } catch (error) { failed += 1; console.error(`[test] FAIL ${item.name}: ${error.stack || error.message}`); } }
  if (failed) { console.error(`[test] FAIL ${failed}/${tests.length} focused checks`); process.exitCode = 1; }
  else console.log(`[test] PASS ${tests.length}/${tests.length} focused checks`);
})().catch(error => { console.error(`[test] FAIL harness: ${error.stack || error.message}`); process.exitCode = 1; });
