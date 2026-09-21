// Acceptance regression — repo-wjl: exact adoption of a pre-repo-481 successor attempt.
'use strict';
const {
  assert, fs, path, world, AUTH, json,
} = require('../repo-481/guard');

async function legacySuccessor(w) {
  // The historical production attempt died before redeeming its grant, so the old manager
  // could reuse that exact sealed authority. Reproduce that boundary once, then use the real
  // operation-manager retry, child admission and exit for the successor.
  const admit = AUTH.admit;
  let firstImplementationSkipped = false;
  AUTH.admit = (authority, options) => {
    if (options && options.scope === 'implementation' && !firstImplementationSkipped) {
      firstImplementationSkipped = true;
      return { ok: true, fixture: 'child died before preflight admission' };
    }
    return admit(authority, options);
  };
  let p;
  try { p = await w.ready(); } finally { AUTH.admit = admit; }
  assert(firstImplementationSkipped, 'fixture did not exercise the pre-admission failure');
  const firstChild = w.feed();
  firstChild.ended = true; firstChild.child.emit('exit', 1, null);
  await w.supervisor.tick();
  const failedRow = await w.supervisor.status(p.proposalId);
  assert.strictEqual(failedRow.implementation.operationState, 'attention');
  const failed = { p, child: firstChild, row: failedRow,
    id: failedRow.implementation.operationId };
  const first = w.manager.status({ project: w.target, id: failed.id });
  assert.strictEqual(first.attempt, 1);
  const retried = w.manager.retry({ project: w.target, id: failed.id, approved: true,
    grant: { authority: firstChild.authority, parentLease: w.currentOwner.lease } });
  assert(retried.ok, JSON.stringify(retried));
  const secondChild = w.feed();
  assert.notStrictEqual(secondChild.runId, firstChild.runId);
  secondChild.ended = true; secondChild.child.emit('exit', 1, null);
  const observed = w.manager.status({ project: w.target, id: failed.id });
  assert.strictEqual(observed.state, 'attention');
  assert.notStrictEqual(observed.runId, failed.child.runId);
  assert.strictEqual(observed.attempt, 2);
  assert.strictEqual(observed.previousAttempts.at(-1).operation.runId, firstChild.runId);
  return { failed, child: secondChild, observed };
}

async function check(name, body) {
  try { await body(); console.log(`ok - ${name}`); return true; }
  catch (error) { console.log(`FAIL - ${name}: ${error.stack || error}`); return false; }
}

(async () => {
  const results = [];
  results.push(await check('C1 C2 C3 exact direct legacy successor is adopted before one replacement',
    () => world('repo-wjl-adopt', async w => {
      const legacy = await legacySuccessor(w);
      const before = w.children.filter(row => row.kind === 'implementation').length;
      const result = await w.supervisor.retry({ proposalId: legacy.failed.p.proposalId,
        operationId: legacy.failed.id, approved: true,
        id: 'a'.repeat(64), expectedRunId: legacy.failed.child.runId,
        reason: 'adopt the exact durable successor and retry it' });
      assert(result.ok, JSON.stringify(result));
      assert.strictEqual(w.children.filter(row => row.kind === 'implementation').length, before + 1);
      const row = await w.supervisor.status(legacy.failed.p.proposalId);
      assert(row.implementation.legacyAdoption, JSON.stringify(row));
      assert.strictEqual(row.implementation.legacyAdoption.predecessor.runId,
        legacy.failed.child.runId);
      assert.strictEqual(row.implementation.legacyAdoption.successor.runId, legacy.child.runId);
      assert.strictEqual(row.implementation.predecessor.runId, legacy.child.runId);
      await w.supervisor.tick(); w.reconstruct(); await w.supervisor.tick();
      const reconstructed = await w.supervisor.status(legacy.failed.p.proposalId);
      assert.strictEqual(reconstructed.implementation.legacyAdoption.predecessor.runId,
        legacy.failed.child.runId);
      assert.strictEqual(reconstructed.implementation.legacyAdoption.successor.runId,
        legacy.child.runId);
      const human = require('../../../runner/proposal-supervisor').formatHumanStatus(reconstructed);
      assert(human.includes(legacy.failed.child.runId) && human.includes(legacy.child.runId), human);
      const replacement = w.feed();
      replacement.ended = true; replacement.child.emit('exit', 1, null);
      await w.supervisor.tick();
      const replay = await w.supervisor.retry({ proposalId: legacy.failed.p.proposalId,
        operationId: legacy.failed.id, approved: true,
        id: 'a'.repeat(64), expectedRunId: legacy.failed.child.runId,
        reason: 'adopt the exact durable successor and retry it' });
      assert(replay.ok && replay.existing, JSON.stringify(replay));
      assert.strictEqual(w.children.filter(row => row.kind === 'implementation').length, before + 1);
    })));

  results.push(await check('C4 C5 mismatched direct-predecessor evidence refuses without settlement or dispatch',
    async () => {
      const cases = [
        ['direct-grant', record => { record.previousAttempts.at(-1).grantNonce = 'f'.repeat(48); }],
        ['wrong-kind', record => { record.kind = 'preparation'; }],
        ['wrong-authority-path', record => { record.authorityPath = record.previousAttempts.at(-1).authorityPath; }],
        ['unknown-child', record => { record.childIdentity = 'pending'; }],
        ['missing-process', record => { record.processIdentity = null; }],
      ];
      for (const [name, corrupt] of cases) await world(`repo-wjl-refuse-${name}`, async w => {
        const legacy = await legacySuccessor(w);
        const file = legacy.observed.statePath;
        const record = JSON.parse(fs.readFileSync(file, 'utf8'));
        corrupt(record); record.attempts = record.previousAttempts;
        json(file, record);
        const children = w.children.length;
        const outstanding = AUTH.outstanding(w.target).map(row => row.nonce).sort();
        const journalPath = path.join(w.stateDir, 'events.jsonl');
        const journal = fs.readFileSync(journalPath, 'utf8');
        const result = await w.supervisor.retry({ proposalId: legacy.failed.p.proposalId,
          operationId: legacy.failed.id, approved: true, reason: 'must refuse mismatch' });
        assert.strictEqual(result.ok, false, name);
        assert.match(result.error, /no exact direct legacy successor/i, name);
        assert.strictEqual(w.children.length, children, name);
        assert.deepStrictEqual(AUTH.outstanding(w.target).map(row => row.nonce).sort(), outstanding, name);
        assert.strictEqual(fs.readFileSync(journalPath, 'utf8'), journal, name);
      });
    }));

  results.push(await check('C3 C4 durable request replay and identical CLI text cannot authorize a later run',
    () => world('repo-wjl-durable-request', async w => {
      const legacy = await legacySuccessor(w);
      const args = ['--proposal', legacy.failed.p.proposalId,
        '--operation', legacy.failed.id, '--expected-run', legacy.failed.child.runId,
        '--reason', 'durably adopt this exact failed run', '--approved'];
      const queued = await w.command('retry', args);
      assert(queued.result.ok && queued.result.queued, JSON.stringify(queued));
      await w.supervisor.tick();
      assert(fs.existsSync(queued.result.resultPath), 'owning supervisor did not acknowledge request');
      const before = w.children.filter(row => row.kind === 'implementation').length;
      const replacement = w.feed();
      assert.notStrictEqual(replacement.runId, legacy.child.runId);

      // Model a controller loss after durable replacement publication but before the request
      // acknowledgement reached disk. The request remains the only recovery input.
      fs.unlinkSync(queued.result.resultPath);
      replacement.ended = true; replacement.child.emit('exit', 1, null);
      w.reconstruct(); await w.supervisor.tick();
      assert(fs.existsSync(queued.result.resultPath), 'replayed request was not acknowledged');
      assert.strictEqual(w.children.filter(row => row.kind === 'implementation').length, before,
        'request replay launched another replacement');

      const requestDir = path.dirname(queued.result.requestPath);
      const requestsBefore = fs.readdirSync(requestDir).filter(name => name.endsWith('.request.json')).sort();
      await assert.rejects(() => w.command('retry', args), /does not match an observable implementation run/);
      const requestsAfter = fs.readdirSync(requestDir).filter(name => name.endsWith('.request.json')).sort();
      assert.deepStrictEqual(requestsAfter, requestsBefore, 'identical CLI text authorized a later run');
    })));

  const passed = results.filter(Boolean).length;
  console.log(`${passed}/${results.length} repo-wjl checks passed`);
  if (passed !== results.length) process.exitCode = 1;
})();
