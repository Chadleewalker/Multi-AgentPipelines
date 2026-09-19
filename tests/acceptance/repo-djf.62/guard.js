'use strict';
// Healthy controls for the same production fixture. No supervisor journal is preseeded.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createWorld, AUTH } = require('./fixture.cjs');
const tests = [];
const test = (name, body) => tests.push({ name, body });
async function world(name, body) {
  const w = createWorld(`guard-${name}`);
  try { await body(w); } finally { await w.dispose(); }
}

test('G1 complete done with exact PR reaches review through real operation/artifact producers', () => world('done', async w => {
  const p = await w.ready();
  const child = w.feed();
  w.completeFeed([{ issueId: p.issueId, outcome: 'done', branch: `task/${p.issueId}`,
    prUrl: 'https://github.com/fixture/lifecycle/pull/11' }]);
  await w.supervisor.tick();
  const row = await w.supervisor.status(p.proposalId);
  assert.strictEqual(row.stage, 'review');
  assert.strictEqual(row.runId, p.runId);
  assert.strictEqual(row.verdict, 'pending');
  assert.strictEqual(row.prUrl, 'https://github.com/fixture/lifecycle/pull/11');
  assert.strictEqual(AUTH.settlementState(w.currentOwner.lease, child.authority.nonce).settled, true);
  w.reconstruct(); await w.supervisor.tick();
  assert.strictEqual(w.issues.size, 1);
  assert.strictEqual(w.events().filter(e => e.type === 'proposal.assigned').length, 1);
  assert.strictEqual(w.children.filter(c => c.kind === 'implementation').length, 1);
}));

test('G2 authenticated live pause remains nonterminal and does not settle or launch replacement work', () => world('pause', async w => {
  const p = await w.ready();
  const child = w.feed();
  w.writeFeed([{ issueId: p.issueId, outcome: 'paused', reason: 'usage window still closed' }], { finishedAt: null });
  const before = w.children.length;
  await w.supervisor.tick(); w.reconstruct(); await w.supervisor.tick();
  const row = await w.supervisor.status(p.proposalId);
  assert.strictEqual(row.stage, 'implementing');
  assert.strictEqual(w.settlements.filter(e => e.nonce === child.authority.nonce).length, 0);
  assert.strictEqual(w.children.length, before);
  assert.strictEqual(AUTH.settlementState(w.currentOwner.lease, child.authority.nonce).settled, false);
}));

test('G3 live owner and unfinished drain refuse explicit start and resume, while ordinary polling keeps intake closed', () => world('drain', async w => {
  const p = await w.ready();
  const child = w.feed();
  await w.command('stop');
  assert(fs.existsSync(path.join(w.runsRoot, child.runId, 'stop')));
  const prior = w.events();
  for (const name of ['start', 'resume']) await assert.rejects(w.command(name), /held|supervisor/i);
  const later = await w.kickoff('later-during-drain');
  assert.strictEqual((await w.supervisor.submit(later)).accepted, false);
  await w.command('status'); await w.supervisor.tick();
  const status = await w.supervisor.status();
  assert.strictEqual(status.closed, true);
  assert.strictEqual(status.drained, false);
  assert.strictEqual(status.proposals.length, 1);
  assert.strictEqual(status.proposals[0].proposalId, p.proposalId);
  assert.deepStrictEqual(w.events().slice(0, prior.length), prior);
  assert.strictEqual(w.children.filter(c => c.kind === 'implementation').length, 1);
}));

test('G4 an unsettled real grant blocks reopening even after the original host ownership is released', () => world('unsettled', async w => {
  const owned = w.open(); assert(owned.ok);
  const made = AUTH.grant(owned.lease, { scope: 'implementation', ttlMs: 60000 });
  assert(made.ok, JSON.stringify(made));
  await w.command('stop');
  assert.strictEqual((await owned.close()).ok, false, 'normal close must refuse the outstanding child');
  // Negative recovery setup only: remove ownership through its real host API, preserving
  // the grant exactly as an interrupted host can. This is not proof of a successful stop.
  AUTH.release(w.root, w.target, owned.lease);
  const before = w.events();
  const next = w.open({ reclaim: true, reopen: true }); assert(next.ok);
  assert.strictEqual((await next.supervisor.status()).closed, true,
    'new ownership must not treat retained unsettled authority as a clean prior stop');
  assert.strictEqual(AUTH.outstanding(w.target).length, 1);
  assert.strictEqual(AUTH.outstanding(w.target)[0].nonce, made.authority.nonce);
  assert.strictEqual((await next.close()).ok, false);
  assert.deepStrictEqual(w.events(), before, 'failed reopening must retain the complete prior history');
  assert.strictEqual(w.children.length, 0);
}));

(async () => {
  let failed = 0;
  for (const { name, body } of tests) {
    try { await body(); console.log(`ok - ${name}`); }
    catch (error) { failed += 1; console.log(`FAIL - ${name}: ${error.stack || error}`); }
  }
  console.log(`${tests.length - failed}/${tests.length} repo-djf.62 healthy controls passed`);
  process.exitCode = failed ? 1 : 0;
})();
