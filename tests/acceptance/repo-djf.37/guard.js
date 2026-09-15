// Frozen acceptance guard — repo-djf.37. [guard]
// Criteria -> tests: C3 -> guard.js; C1, C2, C4-C6 -> test.js.
// Tests -> criteria: G1 preserves C3.
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..', '..');
const api = require(path.join(ROOT, 'runner', 'proposal-supervisor.js'));
let failed = 0;
function check(name, body) { try { body(); console.log(`ok - ${name}`); } catch (error) { failed = 1; console.error(`FAIL - ${name} — ${error.stack || error.message}`); } }
function record(id, target) {
  const intent = JSON.stringify({ version: 'kickoff-intake/1', title: id, description: 'fixture', constraints: [], examples: [], nonGoals: [], priority: 3, relations: [], origin: null });
  return { version: 'kickoff-intake/1', id, target, intent,
    hash: `sha256:${crypto.createHash('sha256').update(intent).digest('hex')}`, createdAt: '2026-09-15T00:00:00.000Z' };
}
function event(sequence, type, body = {}) { return { sequence, type, at: '2026-09-15T00:00:00.000Z', ...body }; }
function journal(dir, events) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'events.jsonl'), `${events.map(JSON.stringify).join('\n')}\n`); }
function supervisor(dir, project, adapters) { return api.createProductionSupervisor({ project, stateDir: dir, adapters, testingSentinel: api.TESTING_SENTINEL }); }

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-djf37-guard-'));
  try {
    const project = path.join(root, 'project');
    // G1 / C3: completed specification is the durable no-reinvoke boundary.
    await (async () => {
      const r = record('kp-complete', project), dir = path.join(root, 'complete'); let calls = 0;
      journal(dir, [event(1, 'proposal.submitted', { proposalId: r.id, record: r }), event(2, 'stage', { proposalId: r.id, stage: 'queued' }), event(3, 'stage', { proposalId: r.id, stage: 'specifying' }), event(4, 'specification.completed', { proposalId: r.id, result: { status: 'needs-input', question: 'q' } }), event(5, 'stage', { proposalId: r.id, stage: 'needs-input' })]);
      const s = supervisor(dir, project, { kickoff: { verify: async x => x, list: async () => [] }, specification: { execute: async () => { calls += 1; return { status: 'needs-input' }; } } });
      await s.resume(); assert.strictEqual(calls, 0); assert.strictEqual((await s.status(r.id)).stage, 'needs-input');
    })();
    check('G1 C3 completed specification remains a no-reinvoke boundary', () => {});

  } catch (error) { failed = 1; console.error(`FAIL - guard harness — ${error.stack || error.message}`); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
  process.exitCode = failed;
})();
