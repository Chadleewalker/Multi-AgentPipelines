'use strict';
// Independently authored behavioral regressions for the reviewed repo-djf.62 specification.
// Durable successful state comes solely from production commands/producers. Deliberately
// corrupted evidence below exercises refusals; it never establishes a successful round trip.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createWorld, AUTH, delay, json } = require('./fixture.cjs');
const watchdog = setTimeout(() => { console.error('FAIL - bounded lifecycle suite timed out'); process.exit(1); }, 120000);
watchdog.unref();
const tests = [];
const test = (name, body) => tests.push({ name, body });
const terminal = row => ['review', 'failed', 'rejected'].includes(row.stage);
const implementation = row => row.implementation || row.task || {};
const outcome = row => implementation(row).outcome || row.outcome || row.sourceOutcome;
const attention = row => implementation(row).attention || row.attention;
const task = (issueId, word, extra = {}) => ({ issueId, outcome: word,
  branch: `task/${issueId}`, reason: `diagnostic for ${word}`, ...extra });
const pr = issueId => `https://github.com/fixture/lifecycle/pull/${parseInt(issueId.slice(-5), 16)}`;
async function world(name, body, options = {}) {
  const w = createWorld(name, options);
  try { await body(w); } finally { await w.dispose(); }
}

test('C3 fast completion before first assignment retains the matching canonical result without a replacement feed', () => world('fast-completion', async w => {
  const record = await w.kickoff('fast-child-before-assignment');
  const owned = w.open(); assert(owned.ok);
  const realStatus = w.manager.status;
  let originalRunId = null;
  let completedBeforeAssignment = false;
  w.manager.status = request => {
    const child = w.feed();
    const feedEvent = w.events().find(event => event.type === 'feed.started');
    if (!completedBeforeAssignment && child && feedEvent && request.id === feedEvent.operation.id) {
      assert.strictEqual(w.events().filter(event => event.type === 'proposal.assigned').length, 0,
        'fast-child completion must precede the first durable supervisor assignment');
      const specification = w.events().find(event => event.type === 'specification.completed'
        && event.proposalId === record.id);
      assert(specification && specification.result.issueId, 'the row must name the actual canonical issue');
      originalRunId = child.runId;
      w.completeFeed([task(specification.result.issueId, 'done', { prUrl: pr(specification.result.issueId) })]);
      completedBeforeAssignment = true;
    }
    // No read result is forged: actual completion, manifest and authority settlement are
    // observed by the operation manager before the supervisor receives this answer.
    return realStatus(request);
  };
  await w.supervisor.tick();
  assert(completedBeforeAssignment, 'fixture did not reach the first assignment boundary');
  const row = await w.supervisor.status(record.id);
  assert.strictEqual(row.stage, 'review', 'matching fast-child result was discarded during feed retirement');
  assert.strictEqual(row.runId, originalRunId);
  assert.strictEqual(w.children.filter(child => child.kind === 'implementation').length, 1,
    'an already completed exact issue must not launch replacement work');
  w.reconstruct(); await w.supervisor.tick(); await w.supervisor.tick();
  assert.strictEqual((await w.supervisor.status(record.id)).runId, originalRunId);
  assert.strictEqual(w.events().filter(event => event.type === 'proposal.assigned' && event.proposalId === record.id).length, 1);
  assert.strictEqual(w.children.filter(child => child.kind === 'implementation').length, 1);
}));

test('C3 late kickoff arriving before completed-feed observation is assigned only to a launched successor', () => world('late-before-retirement', async w => {
  const first = await w.ready('original-feed-idea');
  const predecessor = w.feed();
  w.completeFeed([task(first.issueId, 'done', { prUrl: pr(first.issueId) })]);
  // Deliberately submit before ANY tick can observe/retire the completed predecessor.
  // Readiness is reached through real specification/preparation/publication consumers.
  const later = await w.ready('late-idea-before-retirement');
  assert.notStrictEqual(later.runId, predecessor.runId,
    'later ready work was assigned to the completed, unobserved predecessor');
  assert.strictEqual(w.children.filter(row => row.kind === 'implementation').length, 2,
    'a real successor child must launch before the later assignment is durable');
  const assignments = w.events().filter(e => e.type === 'proposal.assigned' && e.proposalId === later.proposalId);
  assert.strictEqual(assignments.length, 1);
  assert.strictEqual(assignments[0].runId, w.feed().runId);
  assert.notStrictEqual(assignments[0].runId, predecessor.runId);
  w.reconstruct(); await w.supervisor.tick();
  assert.strictEqual((await w.supervisor.status(later.proposalId)).runId, later.runId);
  assert.strictEqual(w.children.filter(row => row.kind === 'implementation').length, 2);
  assert.strictEqual(w.events().filter(e => e.type === 'proposal.assigned' && e.proposalId === later.proposalId).length, 1);
}));

test('C3 a feed completing after an earlier healthy poll in the same tick cannot receive a later assignment', async () => {
  let activeWorld; let first; let later; let healthyPoll = false; let completedDuringPlanning = false;
  await world('completion-after-healthy-poll', async w => {
    activeWorld = w;
    first = await w.ready('first-before-poll');
    const predecessor = w.feed();
    const status = w.manager.status;
    w.manager.status = async request => {
      // Preserve the exact real reader result. The pending observation gives a concurrent
      // operator a deterministic point to submit a new kickoff while this tick is active.
      const observed = status(request);
      if (!healthyPoll && observed.kind === 'implementation' && observed.state === 'running') {
        healthyPoll = true;
        later = await w.kickoff('arrives-after-healthy-poll');
        assert.strictEqual((await w.supervisor.submit(later)).accepted, true);
      }
      return observed;
    };
    await w.supervisor.tick();
    assert(healthyPoll && completedDuringPlanning,
      'fixture must observe running before the external child finishes during later specification');
    for (let n = 0; n < 4 && (await w.supervisor.status(later.id)).stage !== 'implementing'; n++) {
      await w.supervisor.tick();
    }
    const row = await w.supervisor.status(later.id);
    assert.strictEqual(row.stage, 'implementing');
    assert.notStrictEqual(row.runId, predecessor.runId,
      'assignment trusted the earlier running snapshot after the child completed');
    assert.strictEqual(w.children.filter(child => child.kind === 'implementation').length, 2);
    assert.strictEqual(w.events().filter(event => event.type === 'proposal.assigned' && event.proposalId === later.id).length, 1);
  }, { specificationAdapters(adapters) {
    const launch = adapters.launchCodex;
    adapters.launchCodex = async plan => {
      if (plan.intent.title === 'arrives-after-healthy-poll') {
        assert(healthyPoll, 'external completion must follow the healthy poll');
        activeWorld.completeFeed([task(first.issueId, 'done', { prUrl: pr(first.issueId) })]);
        completedDuringPlanning = true;
      }
      return launch(plan);
    };
  } });
});

test('C1 real paused-at-cap row exposes its attemptNotes diagnostic in structured and human status', () => world('producer-pause-notes', async w => {
  const p = await w.ready();
  const { runOneTask } = require('../../../runner/run');
  const { startRun } = require('../../../runner/log');
  const { createPauseGate } = require('../../../runner/pause');
  const cfg = { probeIntervalMinutes: 0, maxPauseCycles: 1 };
  const log = startRun(w.root, p.runId);
  // The real pause gate reaches its cap; only sleeping and the external quota probe are
  // replaced. runOneTask itself must create the exact row, before any task/Beads launch.
  const gate = createPauseGate(cfg, log, { sleepFn: async () => {}, probeFn: () => ({ open: false }) });
  await gate.reportLimit({}, log.trace(p.issueId));
  assert.strictEqual(gate.exhausted, true);
  const source = await runOneTask(cfg, { id: p.issueId, title: 'Waiting for usage window' }, log, null, gate, null);
  assert.strictEqual(source.outcome, 'paused');
  assert.strictEqual(source.reason, undefined, 'producer must not gain a fixture-only reason');
  assert(source.attemptNotes.some(note => /run-level rate-limit pause cap/.test(note)));
  w.completeFeed([source]);
  await w.supervisor.tick();
  const row = await w.supervisor.status(p.proposalId);
  assert.strictEqual(row.stage, 'failed');
  assert.strictEqual(outcome(row), 'paused');
  assert.match(String(implementation(row).reason), /run-level rate-limit pause cap/,
    'the operator diagnostic must come from the actual producer attemptNotes');
  const human = await w.command('status', ['--proposal', p.proposalId]);
  assert(human.output.includes(source.attemptNotes[0]), 'human status lost the real pause-cap diagnostic');
  const machine = await w.command('status', ['--proposal', p.proposalId, '--json']);
  assert.match(String(implementation(JSON.parse(machine.output)).reason), /issue stays open for the next run/);
}));

test('C2 active paused manifest without finishedAt is a healthy running wait', () => world('active-paused-manifest', async w => {
  const p = await w.ready();
  const child = w.feed();
  w.writeFeed([task(p.issueId, 'paused', { reason: 'usage window remains closed' })], { finishedAt: null });
  await w.supervisor.tick(); w.reconstruct(); await w.supervisor.tick();
  const row = await w.supervisor.status(p.proposalId);
  assert.strictEqual(row.stage, 'implementing');
  assert.match(row.nextAction, /wait|running|active/i,
    'a legitimately unfinished manifest must not be reported as malformed terminal evidence');
  assert(!attention(row), 'a healthy authenticated live pause must not acquire corruption attention');
  assert.strictEqual(w.settlements.filter(e => e.nonce === child.authority.nonce).length, 0);
}));

test('C1 partial with matching PR reaches review and remains explicitly partial in JSON and human status', () => world('partial', async w => {
  const p = await w.ready();
  const source = task(p.issueId, 'partial', { prUrl: pr(p.issueId) });
  w.completeFeed([source]);
  await w.supervisor.tick();
  const status = await w.supervisor.status(p.proposalId);
  assert.strictEqual(status.stage, 'review', 'completed partial with PR must reach review');
  assert.strictEqual(outcome(status), 'partial', 'partial must retain its exact source outcome');
  assert.strictEqual(status.prUrl, source.prUrl);
  assert.strictEqual(status.runId, p.runId);
  const human = await w.command('status', ['--proposal', p.proposalId]);
  assert.match(human.output, /partial/i, 'human status must qualify partial results');
  assert.match(human.output, /review/i);
  const machine = await w.command('status', ['--proposal', p.proposalId, '--json']);
  assert.strictEqual(outcome(JSON.parse(machine.output)), 'partial');
}));

for (const word of ['stuck', 'tampered', 'failed', 'paused', 'undispatchable']) {
  test(`C1 completed ${word} is failed with exact source outcome and diagnostic`, () => world(word, async w => {
    const p = await w.ready();
    const source = task(p.issueId, word, word === 'undispatchable' ? { refusal: 'no-receipt' } : {});
    w.completeFeed([source]);
    await w.supervisor.tick();
    const status = await w.supervisor.status(p.proposalId);
    assert.strictEqual(status.stage, 'failed', `completed ${word} must not remain implementing`);
    assert.strictEqual(outcome(status), word);
    assert.match(JSON.stringify(status), new RegExp(source.reason));
    assert.match(status.nextAction, /inspect|recover|retry|freeze/i, 'terminal result needs an actionable reason');
    const human = await w.command('status', ['--proposal', p.proposalId]);
    assert.match(human.output, new RegExp(word));
    assert.match(human.output, new RegExp(source.reason));
  }));
}

test('C3 operation manager alone settles a completed feed, and reconstruction never settles or assigns twice', () => world('settlement', async w => {
  const p = await w.ready();
  const child = w.feed();
  w.completeFeed([task(p.issueId, 'done', { prUrl: pr(p.issueId) })]);
  await w.supervisor.tick();
  assert.strictEqual((await w.supervisor.status(p.proposalId)).stage, 'review');
  w.reconstruct(); await w.supervisor.tick(); await w.supervisor.tick();
  const settlements = w.settlements.filter(row => row.nonce === child.authority.nonce);
  assert.deepStrictEqual(settlements.map(row => row.owner), ['operation-manager'],
    'the manager already settled this exact grant; conveyor retirement must only acknowledge it');
  assert.strictEqual(w.events().filter(e => e.type === 'proposal.assigned' && e.proposalId === p.proposalId).length, 1);
  assert.strictEqual(w.children.filter(row => row.kind === 'implementation').length, 1);
}));

for (const word of ['done', 'partial']) {
  test(`C1 completed ${word} without PR remains nonterminal with publication attention`, () => world(`no-pr-${word}`, async w => {
    const p = await w.ready();
    w.completeFeed([task(p.issueId, word)]);
    await w.supervisor.tick(); w.reconstruct(); await w.supervisor.tick();
    const row = await w.supervisor.status(p.proposalId);
    assert(!terminal(row), 'a PR-eligible outcome without PR cannot establish review or failure');
    assert.strictEqual(outcome(row), word);
    assert(attention(row), 'missing PR evidence must produce explicit attention');
    assert.match(`${attention(row)} ${row.nextAction}`, /PR|publication|publish|pull request/i);
    assert.strictEqual(w.children.filter(c => c.kind === 'implementation').length, 1);
  }));
}

test('C1 ineligible failed row with a PR remains failed, never review', () => world('failed-pr', async w => {
  const p = await w.ready();
  w.completeFeed([task(p.issueId, 'failed', { prUrl: pr(p.issueId) })]);
  await w.supervisor.tick();
  const row = await w.supervisor.status(p.proposalId);
  assert.strictEqual(row.stage, 'failed');
  assert.strictEqual(outcome(row), 'failed');
  assert.strictEqual(row.verdict, null);
}));

for (const fault of ['wrong-run', 'missing-manifest', 'unreadable-manifest', 'missing-operation', 'uncertain-settlement']) {
  test(`C2 ${fault} evidence cannot fabricate a terminal outcome and reports actionable attention`, () => world(fault, async w => {
    const p = await w.ready();
    const operation = w.events().find(e => e.type === 'feed.started').operation;
    const source = task(p.issueId, 'done', { prUrl: pr(p.issueId) });
    w.completeFeed([source], fault === 'wrong-run' ? { runId: 'unrelated-run' } : {});
    const manifest = path.join(w.runsRoot, p.runId, 'run.json');
    if (fault === 'missing-manifest') fs.unlinkSync(manifest);
    if (fault === 'unreadable-manifest') fs.writeFileSync(manifest, '{torn');
    if (fault === 'missing-operation') fs.unlinkSync(operation.statePath);
    if (fault === 'uncertain-settlement') json(`${operation.statePath}.settlement`, {
      operation: operation.id, attempt: operation.attempt, grantNonce: operation.grantNonce,
      startedAt: new Date().toISOString(),
    });
    await w.supervisor.tick(); w.reconstruct(); await w.supervisor.tick();
    const row = await w.supervisor.status(p.proposalId);
    assert(!terminal(row), `${fault} fabricated ${row.stage}`);
    assert(attention(row), `${fault} was silently treated as ordinary progress`);
    assert.match(row.nextAction, /inspect|recover|reconcile|attention|unavailable/i);
    assert.strictEqual(w.settlements.filter(e => e.nonce === operation.grantNonce).length, 0,
      'observation implicitly settled uncertain/missing evidence');
    assert.strictEqual(w.children.filter(c => c.kind === 'implementation').length, 1);
    assert.strictEqual(w.events().filter(e => e.type === 'proposal.assigned').length, 1);
    if (fault === 'uncertain-settlement') assert(fs.existsSync(`${operation.statePath}.settlement`),
      'observation implicitly reconciled uncertain settlement');
  }));
}

for (const word of ['done', 'paused']) {
  test(`C2 authenticated running child with ${word} row stays waiting until real completion`, () => world(`live-${word}`, async w => {
    const p = await w.ready();
    const child = w.feed();
    // Even a prematurely written finishedAt cannot override authenticated process liveness.
    w.writeFeed([task(p.issueId, word, word === 'done' ? { prUrl: pr(p.issueId) } : {})]);
    await w.supervisor.tick(); w.reconstruct(); await w.supervisor.tick();
    const row = await w.supervisor.status(p.proposalId);
    assert(!terminal(row), `live ${word} row fabricated terminal ${row.stage}`);
    assert.match(row.nextAction, /wait|running|active/i, 'a live feed must report a wait');
    assert.strictEqual(w.settlements.filter(e => e.nonce === child.authority.nonce).length, 0);
    assert.strictEqual(w.children.filter(c => c.kind === 'implementation').length, 1);
  }));
}

test('C3 completed feed retains omitted assignment with attention and admits unrelated work only to one successor', () => world('omitted-row', async w => {
  const first = await w.ready('first-assignment');
  const omitted = await w.ready('omitted-assignment');
  assert.strictEqual(first.runId, omitted.runId);
  const child = w.feed();
  w.completeFeed([task(first.issueId, 'done', { prUrl: pr(first.issueId) })]);
  await w.supervisor.tick(); w.reconstruct(); await w.supervisor.tick();
  const missing = await w.supervisor.status(omitted.proposalId);
  assert(!terminal(missing), 'an omitted task cannot be declared failed or successful');
  assert(attention(missing), 'an omitted task needs explicit missing-row attention before feed retirement');
  assert.match(String(attention(missing)), /missing|absent|omitted|no.*row/i);
  assert.strictEqual(missing.runId, omitted.runId);
  const next = await w.ready('successor-assignment');
  assert.notStrictEqual(next.runId, first.runId);
  w.reconstruct(); await w.supervisor.tick(); await w.supervisor.tick();
  assert.strictEqual(w.children.filter(c => c.kind === 'implementation').length, 2);
  assert.strictEqual(w.events().filter(e => e.type === 'proposal.assigned' && e.proposalId === omitted.proposalId).length, 1);
  assert.deepStrictEqual(w.settlements.filter(e => e.nonce === child.authority.nonce).map(e => e.owner), ['operation-manager']);
  assert(attention(await w.supervisor.status(omitted.proposalId)), 'retirement erased missing-row evidence');
}));

for (const evidence of ['duplicate-issue', 'unknown-outcome', 'invalid-pr']) {
  test(`C2 completed ${evidence} evidence stays nonterminal with retained attention`, () => world(evidence, async w => {
    const p = await w.ready();
    const good = task(p.issueId, 'done', { prUrl: pr(p.issueId) });
    const tasks = evidence === 'duplicate-issue'
      ? [good, task(p.issueId, 'failed')]
      : [evidence === 'unknown-outcome' ? { ...good, outcome: 'invented-success' }
        : { ...good, prUrl: 'javascript:alert(1)' }];
    w.completeFeed(tasks);
    await w.supervisor.tick(); w.reconstruct(); await w.supervisor.tick();
    const row = await w.supervisor.status(p.proposalId);
    assert(!terminal(row), `${evidence} fabricated a terminal result`);
    assert(attention(row));
    assert.match(row.nextAction, /inspect|attention|publication/i);
    assert.strictEqual(w.events().filter(e => e.type === 'proposal.assigned').length, 1);
    assert.strictEqual(w.children.filter(c => c.kind === 'implementation').length, 1);
  }));
}

for (const command of ['start', 'run', 'resume']) {
  test(`C4 explicit ${command} reopens a drained released conveyor and accepts a later kickoff`, () => world(`reopen-${command}`, async w => {
    // Establish the previous session through the real operator ownership entrypoint, then
    // its real stop and run loop release. No successful journal/snapshot state is injected.
    const first = await w.kickoff(`first-${command}`);
    let finished = false;
    const initial = w.command('start').then(value => { finished = true; return value; });
    for (let i = 0; i < 40 && !w.feed(); i += 1) await delay(50);
    const previous = await w.supervisor.status(first.id);
    assert.strictEqual(previous.stage, 'implementing');
    await w.command('stop');
    w.completeFeed([task(previous.issueId, 'done', { prUrl: pr(previous.issueId) })]);
    await initial;
    assert(finished);
    assert.strictEqual((await w.command('status', ['--json'])).result.closed, true);
    assert.strictEqual(AUTH.supervisorPresence(w.target), null);
    const prior = w.events();
    const later = await w.kickoff(`later-${command}`);
    await w.command('status');
    await w.command('tick');
    assert.strictEqual((await w.supervisor.status()).closed, true, 'status/submission cannot reopen intake');
    let restartedDone = false;
    const restarted = w.command(command).then(value => { restartedDone = true; return value; });
    try {
      // Current baseline returns immediately with intake still closed; corrected code owns
      // one bounded external feed and waits until the documented stop closes it below.
      for (let i = 0; i < 40 && !restartedDone
          && w.children.filter(row => row.kind === 'implementation').length < 2; i += 1) await delay(50);
      const status = await w.supervisor.status();
      assert.strictEqual(status.closed, false, `${command} left intake.closed permanent`);
      const proposal = status.proposals.find(row => row.proposalId === later.id);
      assert(proposal, `${command} did not ingest the later canonical kickoff`);
      assert.strictEqual(proposal.stage, 'implementing');
      const preserved = status.proposals.find(row => row.proposalId === first.id);
      assert.strictEqual(preserved.issueId, previous.issueId);
      assert.strictEqual(preserved.runId, previous.runId);
      assert.strictEqual(preserved.stage, 'review');
      const feed = w.feed();
      assert(feed, 'reopening must launch the successor feed');
      assert.deepStrictEqual(w.events().slice(0, prior.length), prior, 'history was rewritten on reopen');
      for (const repeat of ['start', 'resume']) await assert.rejects(w.command(repeat), /held|supervisor/i);
      w.reconstruct(); await w.supervisor.tick();
      assert.strictEqual(w.events().filter(e => e.type === 'proposal.assigned' && e.proposalId === later.id).length, 1);
      await w.command('stop');
      assert(fs.existsSync(path.join(w.runsRoot, feed.runId, 'stop')));
      w.completeFeed([task(proposal.issueId, 'done', { prUrl: pr(proposal.issueId) })]);
      await restarted;
      assert.strictEqual((await w.supervisor.status()).drained, true);
      assert.strictEqual(AUTH.outstanding(w.target).length, 0);
      assert.strictEqual(w.children.filter(row => row.kind === 'implementation').length, 2);
    } finally {
      if (!restartedDone) {
        await w.command('stop');
        if (w.feed() && !w.feed().ended) w.completeFeed([]);
        await restarted;
      }
    }
  }));
}

(async () => {
  // Explicit local author/reviewer selector; the canonical acceptance runner passes no
  // arguments and always executes every case. Refuse an empty or misspelled selection.
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--case' || !args[1])) {
    throw new Error('usage: node test.js [--case <test-name substring>]');
  }
  const selected = args.length ? tests.filter(item => item.name.includes(args[1])) : tests;
  if (!selected.length) throw new Error('no regression matched --case');
  let failed = 0;
  for (const { name, body } of selected) {
    try { await body(); console.log(`ok - ${name}`); }
    catch (error) { failed += 1; console.log(`FAIL - ${name}: ${error.stack || error}`); }
  }
  console.log(`${selected.length - failed}/${selected.length} repo-djf.62 regressions passed`);
  clearTimeout(watchdog);
  process.exitCode = failed ? 1 : 0;
})();
