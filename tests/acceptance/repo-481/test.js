// Frozen acceptance draft, repo-481. Canonical criteria are the supplied Beads snapshot.
// Kickoff sha256:4082f56698323854cfaa08150258d80fe7cc570b14b81f4c93be17b2290aa21b.
// Bidirectional map (every assertion group below also names its criterion):
// C1 durable replacement before dispatch, later attribution/settlement -> R1/R5/R6; G1.
// C2 original-grant lineage through >=2 recoveries -> R2(two/three)/R3/R4; control G2.
// C3 stale/foreign/issue/superseded/predecessor refusal before effects -> guard G3/G6;
//    R2 admits only the authenticated original; R4 refuses obsolete owner settlement.
// C4 replay neither duplicates dispatch/settlement nor loses identity -> R3/R5/R7; G1/G2.
// C5 actionable replacement, predecessor, dispatch, active/terminal/settlement -> R1/R6/R7; G1.
// C6 coordinator, freeze/merge approval, immutable suite, publication -> guard G1/G4/G5.
// C6 delivery constraint: only this new two-file suite; author verifies Git diff.
//
// SPEC DEFECT / proposed acceptance interface: the issue specifies explicit supervisor
// retry but names no entry point. Today only the lower operation manager has retry.
// This suite proposes supervisor.retry({proposalId, operationId, approved, reason})
// -> {ok,...}; it must own the grant and durable replacement. This is an explicit
// test-author interface choice, NOT text found in Beads. Host review must resolve it
// before freeze. No test invokes a lower-level implementation launch/retry command.
// operationId may remain stable across attempts; the actionable (operationId, runId)
// must change. No new journal event names or lineage storage format are prescribed.
// Status retains existing implementation.operationId/runId/operationState/settled fields.
// R1 observes a new read-only supervisor at the actual child's grant admission boundary.
// Helpers use real production receipts, operation state, report manifests and host grants;
// external model, tracker and child execution are the tested repo-djf.62 fixture seams.
// No live Docker/network/Beads; G3 counts the first reachable post-authority boundary.
'use strict';
const { assert, fs, path, ROOT, P, AUTH, world, snapshot, recover, admission, refused,
  failedFeed, retryRequest, retry, run } = require('./guard');
const tests = [];
const test = (name, body) => tests.push({ name, body });
const implementationChildren = w => w.children.filter(c => c.kind === 'implementation');
const task = f => ({ issueId: f.p.issueId, outcome: 'done', branch: `task/${f.p.issueId}`,
  prUrl: 'https://github.com/fixture/lifecycle/pull/481' });
function assertReplacement(row, f, child) {
  assert.notStrictEqual(child.runId, f.child.runId, 'retry reused predecessor run identity');
  assert.strictEqual(row.runId, child.runId, 'proposal still attributes the failed predecessor');
  assert(row.implementation && row.implementation.operationId, 'actionable operation missing');
  assert.strictEqual(row.implementation.runId, child.runId, 'implementation still names predecessor');
}

test('C1 C5 R1 explicit retry durably selects replacement before child admission/dispatch', () => world('retry-before-dispatch', async w => {
  const f = await failedFeed(w);
  const before = w.events();
  const admit = AUTH.admit; const dispatchViews = [];
  AUTH.admit = (authority, opts) => {
    if (opts.scope === 'implementation') {
      // Construction replays bytes already on disk; the in-memory retry caller cannot
      // manufacture this observation. No journal events are written by the fixture.
      const observer = P.createProductionSupervisor({ project: w.target, repoRoot: w.root,
        configPath: w.configPath, stateDir: w.stateDir, runsRoot: w.runsRoot });
      dispatchViews.push(observer.status(f.p.proposalId));
    }
    return admit(authority, opts);
  };
  try { await retry(w, f); } finally { AUTH.admit = admit; }
  assert.strictEqual(dispatchViews.length, 1, 'retry must reach one implementation dispatch');
  const child = w.feed();
  const atDispatch = await dispatchViews[0];
  assertReplacement(atDispatch, f, child);
  assert(/dispatch|launch|replac|retry/i.test(JSON.stringify(atDispatch)),
    'durable pre-dispatch status does not distinguish replacement dispatch');
  assert.deepStrictEqual(w.events().slice(0, before.length), before, 'predecessor history was rewritten');
  w.reconstruct(); await w.supervisor.tick();
  assertReplacement(await w.supervisor.status(f.p.proposalId), f, child);
}));

for (const count of [2, 3]) test(`C2 R2-${count} authorized original grant admitted after ${count} real supervisor recoveries`,
  () => world(`admit-${count}`, async w => {
    const { original } = recover(w, count);
    const authority = original.grants[0];
    const result = await admission(w, authority);
    assert(!result.result.childAuthorityRefused,
      `preserved original grant rejected: ${JSON.stringify(result.result)}`);
    assert.deepStrictEqual(result.events, ['identity'], 'authorized child did not reach ordinary preflight');
    refused(await admission(w, authority), 'admitted original grant replay');
  }));

test('C2 C4 R3 current owner validates and settles original redeemed child once after repeated recovery',
  () => world('settle-lineage', async w => {
    const { original, current } = recover(w, 2);
    const nonce = original.grants[1].nonce;
    const known = AUTH.settlementState(current.lease, nonce);
    const adapters = P.productionAdapters(w.root, { configPath: w.configPath, lease: current.lease });
    const first = adapters.authority.settle({ authority: original.grants[1] });
    const afterFirst = snapshot(process.env.PIPELINE_GLOBAL_LOCK_DIR);
    const second = adapters.authority.settle({ authority: original.grants[1] });
    const afterSecond = snapshot(process.env.PIPELINE_GLOBAL_LOCK_DIR);
    const terminal = AUTH.settlementState(current.lease, nonce);
    assert(known.ok && known.settled === false && first.ok && second.ok && terminal.settled,
      `original lineage lost: ${JSON.stringify({ known, first, second, terminal })}`);
    assert.deepStrictEqual(afterSecond, afterFirst, 'replayed terminal handoff rewrote settlement');
    assert(!AUTH.outstanding(w.target).some(g => g.nonce === nonce));
  }));

test('C2 C3 R4 restored grant envelope uses current owner; predecessor lease retains no settlement authority',
  () => world('restored-envelope', async w => {
    const { original, current } = recover(w, 2);
    const authority = original.grants[1];
    const before = snapshot(process.env.PIPELINE_GLOBAL_LOCK_DIR);
    const obsolete = AUTH.settle(original.lease, authority.nonce, { outcome: 'complete' });
    assert.strictEqual(obsolete.ok, false, 'obsolete parent acquired current authority');
    assert.deepStrictEqual(snapshot(process.env.PIPELINE_GLOBAL_LOCK_DIR), before);
    const adapters = P.productionAdapters(w.root, { configPath: w.configPath, lease: current.lease });
    // This exact envelope is what the journal persisted before its original owner died.
    const result = adapters.authority.settle({ authority, parentLease: original.lease });
    assert(result.ok, `current supervisor trusted obsolete envelope lease: ${JSON.stringify(result)}`);
    assert(AUTH.settlementState(current.lease, authority.nonce).settled);
  }));

test('C1 C4 R5 retry and handoff replay preserve replacement identity with one dispatch and settlement',
  () => world('retry-replay', async w => {
    const f = await failedFeed(w);
    await retry(w, f);
    const replacement = w.feed();
    // Replay the same explicit request; a benign refusal is allowed, another child is not.
    await w.supervisor.retry(retryRequest(f));
    for (let i = 0; i < 3; i++) {
      w.reconstruct(); await w.supervisor.resume(); await w.supervisor.tick();
      assertReplacement(await w.supervisor.status(f.p.proposalId), f, replacement);
    }
    assert.strictEqual(implementationChildren(w).length, 2, 'duplicate retry dispatch');
    w.completeFeed([task(f)], {}, replacement);
    for (let i = 0; i < 3; i++) { w.reconstruct(); await w.supervisor.resume(); }
    const row = await w.supervisor.status(f.p.proposalId);
    assertReplacement(row, f, replacement);
    assert.strictEqual(row.stage, 'review');
    assert.strictEqual(w.settlements.filter(s => s.nonce === replacement.authority.nonce).length, 1,
      'replacement settled more than once');
    assert.strictEqual(implementationChildren(w).length, 2, 'completed replay dispatched another child');
  }));

test('C1 C5 R6 JSON and human status distinguish predecessor failure, active replacement and terminal replacement',
  () => world('retry-status', async w => {
    const f = await failedFeed(w);
    const failedText = P.formatHumanStatus(f.row);
    assert(/attention|fail|exit/i.test(failedText), 'predecessor failure lacks attention');
    await retry(w, f); await w.supervisor.tick();
    const replacement = w.feed();
    const active = await w.supervisor.status(f.p.proposalId);
    assertReplacement(active, f, replacement);
    assert.strictEqual(active.implementation.operationState, 'running');
    const activeText = P.formatHumanStatus(active);
    assert(activeText.includes(replacement.runId) && activeText.includes(active.implementation.operationId),
      'human status omits actionable replacement operation/run');
    assert(/wait|active|running/i.test(active.nextAction));
    assert.notStrictEqual(activeText, failedText);
    w.completeFeed([task(f)], {}, replacement); await w.supervisor.tick();
    const terminal = await w.supervisor.status(f.p.proposalId);
    assertReplacement(terminal, f, replacement);
    assert.strictEqual(terminal.implementation.operationState, 'completed');
    assert.strictEqual(terminal.implementation.settled, true);
    assert.strictEqual(terminal.implementation.outcome, 'done');
    assert.strictEqual(terminal.verdict, 'pending', 'retry bypassed review approval');
    const terminalText = P.formatHumanStatus(terminal);
    assert(terminalText.includes(replacement.runId) && /done|complet/i.test(terminalText));
  }));

test('C4 C5 R7 replacement settlement failure remains actionable and cannot cause automatic redispatch',
  () => world('settlement-failure', async w => {
    const f = await failedFeed(w); await retry(w, f);
    const replacement = w.feed();
    w.completeFeed([task(f)], {}, replacement);
    const settle = AUTH.settle;
    AUTH.settle = (lease, nonce, options) => nonce === replacement.authority.nonce
      ? { ok: false, error: 'fixture: replacement settlement refused' } : settle(lease, nonce, options);
    let row;
    try {
      await w.supervisor.tick(); w.reconstruct(); await w.supervisor.tick();
      row = await w.supervisor.status(f.p.proposalId);
    } finally { AUTH.settle = settle; }
    assertReplacement(row, f, replacement);
    assert.strictEqual(row.implementation.settled, false);
    assert.notStrictEqual(row.stage, 'review', 'unsettled replacement reached review');
    assert(/settl/i.test(`${row.implementation.attention} ${row.nextAction}`), 'settlement failure hidden');
    const text = P.formatHumanStatus(row);
    assert(text.includes(replacement.runId) && text.includes(row.implementation.operationId) && /settl/i.test(text),
      'attention names predecessor or omits replacement settlement failure');
    assert.strictEqual(implementationChildren(w).length, 2, 'settlement failure dispatched another run');
    await w.supervisor.tick();
    const recovered = await w.supervisor.status(f.p.proposalId);
    assert.strictEqual(recovered.stage, 'review');
    assertReplacement(recovered, f, replacement);
  }));
run(tests);
