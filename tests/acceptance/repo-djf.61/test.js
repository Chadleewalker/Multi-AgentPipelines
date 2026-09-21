// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0
'use strict';

// Independent operator regression for the reviewed repo-djf.61 criteria.
// C1/C2: a CLI answer joins the existing supervisor's canonical question and receipt.
// C3/C4: CLI verdicts are observed for the exact review identity, once, across restart;
//       corrections and conflicts retain the first accepted disposition.
// C5: the shared disposable fixture uses actual production adapters, artifact writers,
//       authority, operation manager, publication gate and supervisor. Only external
//       planner/Beads/child execution is replaced. These tests never call answer/decide
//       on the supervisor and never manufacture an accepted-answer/decision event.
// The helper is shared only to avoid duplicating lifecycle setup; these expectations
// were authored independently from the reviewed .61 acceptance criteria.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { createWorld, ROOT } = require('../repo-djf.62/fixture.cjs');
const specify = require(path.join(ROOT, 'scripts/specify-proposal'));
const verdict = require(path.join(ROOT, 'scripts/verdict'));
const supervisorApi = require(path.join(ROOT, 'runner/proposal-supervisor'));
const report = require(path.join(ROOT, 'runner/report'));

const tests = [];
const test = (name, body) => tests.push({ name, body });
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const serialized = value => JSON.stringify(value);
function journal(w) {
  const file = path.join(w.stateDir, 'events.jsonl');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}
function events(w, type, id) {
  return journal(w).split(/\r?\n/).filter(Boolean).map(JSON.parse)
    .filter(e => e.type === type && (!id || e.proposalId === id));
}
function cli(w, script, args) {
  const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts', script), ...args], {
    cwd: w.root, env: { ...process.env, PIPELINE_STATE_DIR: path.join(w.root, 'state'),
      VERDICT_RUNS_DIR: w.runsRoot }, encoding: 'utf8', timeout: 15000, windowsHide: true,
  });
  assert(!result.error, `operator CLI failed to execute: ${result.error && result.error.message}`);
  return result;
}
function answerCli(w, id, evidenceHash, text = 'Use the conservative option.') {
  return cli(w, 'specify-proposal.js', ['answer', '--config', w.configPath,
    '--proposal', id, '--evidence', evidenceHash, '--answer', text, '--json']);
}
function verdictCli(w, issueId, runId, word, reason) {
  return cli(w, 'verdict.js', ['record', issueId, word, reason, '--run', runId]);
}
function assertExit(result, code) {
  assert.strictEqual(result.status, code, `CLI exit: ${result.stdout}\n${result.stderr}`);
}
let worldNumber = 0;
async function world(options, body) {
  const w = createWorld(`operator-${++worldNumber}`, options);
  try { await body(w); } finally { await w.dispose(); }
}
function questionPlanner(plans) {
  return (adapters) => {
    adapters.launchCodex = async plan => {
      plans.push(plan);
      const proposal = {
        status: plan.answer ? 'ready' : 'needs-input',
        spec: `Implement the requested behavior for ${plan.intent.title}.`,
        acceptanceCriteria: ['The selected product behavior is observable.'],
        designReferences: [plan.designReferenceCandidates[0]], difficulty: 'medium',
      };
      if (!plan.answer) proposal.question = `Which product option applies to ${plan.intent.title}?`;
      return JSON.stringify(proposal);
    };
  };
}
async function startQuestion(w, title) {
  const record = await w.kickoff(title);
  const owned = w.open();
  assert(owned.ok, serialized(owned));
  const supervisor = owned.supervisor;
  await supervisor.tick();
  const waiting = await supervisor.status(record.id);
  assert.strictEqual(waiting.stage, 'needs-input', `healthy question setup: ${serialized(waiting)}`);
  assert(waiting.question && /^sha256:[a-f0-9]{64}$/.test(waiting.question.evidenceHash));
  const adapters = specify.productionAdapters({ configPath: w.configPath, proposalId: record.id });
  const evidence = await adapters.readQuestion(record.hash);
  assert.strictEqual(evidence.kickoffHash, record.hash);
  assert.strictEqual(evidence.evidenceHash, waiting.question.evidenceHash);
  assert.strictEqual(evidence.question, waiting.question.text);
  return { record, supervisor, waiting, adapters };
}
async function atReview(w, title) {
  const { record } = await w.ready(title);
  const supervisor = w.supervisor;
  const implementing = await supervisor.status(record.id);
  assert.strictEqual(implementing.stage, 'implementing', `healthy implementation setup: ${serialized(implementing)}`);
  const task = { issueId: implementing.issueId, outcome: 'done',
    branch: `task/${implementing.issueId}`, prUrl: `https://example.invalid/pull/${implementing.issueId}`,
    attempts: 1, reason: 'Acceptance and regression passed.' };
  w.completeFeed([task]);
  await supervisor.tick();
  const pending = await supervisor.status(record.id);
  assert.strictEqual(pending.stage, 'review', `healthy review setup: ${serialized(pending)}`);
  assert.strictEqual(pending.verdict, 'pending');
  assert.strictEqual(pending.issueId, task.issueId);
  assert.strictEqual(pending.prUrl, task.prUrl);
  const run = verdict.readRuns(w.runsRoot).find(row => row.runId === pending.runId);
  assert(run && run.tasks.some(row => row.issueId === pending.issueId && row.prUrl === pending.prUrl),
    'real run manifest reader must locate the review task');
  return { record, supervisor, pending, task,
    verdictFile: path.join(run.dir, 'tasks', task.issueId, 'verdict.json') };
}
function disposition(row, pending, word, reason) {
  assert.strictEqual(row.stage, word === 'merged' ? 'review' : 'rejected', serialized(row));
  assert.strictEqual(row.verdict, word, 'supervisor must show the canonical operator verdict');
  for (const key of ['proposalId', 'kickoffHash', 'specHash', 'issueId', 'runId', 'branch', 'prUrl', 'reviewItemId']) {
    assert.strictEqual(row[key], pending[key], `operator observation changed ${key}`);
  }
  assert(serialized(row).includes(reason), 'status must retain the canonical review reason');
}

test('C1/C2 CLI clarification resumes the same kickoff and persists one answer and one ready receipt across reconstruction', async () => {
  const plans = [];
  await world({ specificationAdapters: questionPlanner(plans) }, async w => {
    const { record, supervisor, waiting, adapters } = await startQuestion(w, 'operator clarification');
    const beforeAnswer = journal(w);
    await supervisor.status(record.id);
    await w.reconstruct().status(record.id);
    assert.strictEqual(journal(w), beforeAnswer, 'status must not append answer consumption');
    const result = answerCli(w, record.id, waiting.question.evidenceHash);
    assertExit(result, 0);
    assert.strictEqual(JSON.parse(result.stdout).status, 'answered');
    const canonicalAnswer = await adapters.readAnswer(record.hash);
    assert.strictEqual(canonicalAnswer.previousEvidenceHash, waiting.question.evidenceHash);
    assert.strictEqual(canonicalAnswer.answer, 'Use the conservative option.');
    assert.strictEqual(events(w, 'answer.accepted', record.id).length, 0,
      'the operator command writes canonical evidence, not a supervisor journal event');
    const resumed = w.reconstruct();
    await resumed.tick();
    const current = await resumed.status(record.id);
    assert(current.issueId, `CLI answer must resume the supervisor to one canonical issue; got ${current.stage}`);
    assert.notStrictEqual(current.stage, 'needs-input');
    const receipt = await adapters.readReceipt(record.hash);
    assert(receipt && receipt.issueId === current.issueId, 'supervisor issue must come from the real receipt writer');
    assert.strictEqual(receipt.kickoffId, record.id);
    assert.strictEqual(receipt.kickoffHash, record.hash);
    assert.strictEqual(plans.length, 2, 'one question and one answered specification launch');
    assert.strictEqual(plans[1].answer, canonicalAnswer.answer);
    assert.strictEqual(plans[1].questionEvidenceHash, waiting.question.evidenceHash);
    const receiptBytes = serialized(receipt);
    for (let n = 0; n < 3; n++) {
      const rebuilt = w.reconstruct();
      await rebuilt.status(record.id); await rebuilt.tick();
      assert.strictEqual((await rebuilt.status(record.id)).issueId, current.issueId);
    }
    assert.strictEqual(serialized(await adapters.readReceipt(record.hash)), receiptBytes);
    assert.strictEqual(plans.length, 2, 're-observation must reuse the specification receipt');
    assert.strictEqual(events(w, 'answer.accepted', record.id).length, 1);
    assert.strictEqual(events(w, 'specification.completed', record.id).filter(e => e.result.status === 'ready').length, 1);
    assert.strictEqual(events(w, 'proposal.submitted', record.id).length, 1);
  });
});

test('C2 guard: missing answers and CLI stale/wrong-proposal/wrong-question evidence do not resume or mutate history', async () => {
  const plans = [];
  await world({ specificationAdapters: questionPlanner(plans) }, async w => {
    const { record, supervisor, waiting, adapters } = await startQuestion(w, 'negative clarification');
    const other = await w.kickoff('different product question');
    await supervisor.tick();
    const otherStatus = await supervisor.status(other.id);
    assert.strictEqual(otherStatus.stage, 'needs-input');
    assert.notStrictEqual(otherStatus.question.evidenceHash, waiting.question.evidenceHash);
    const before = journal(w);
    for (const [id, hash] of [
      [record.id, `sha256:${'e'.repeat(64)}`],
      ['kp-ffffffffffffffff', waiting.question.evidenceHash],
      [other.id, waiting.question.evidenceHash],
      [record.id, otherStatus.question.evidenceHash],
    ]) assertExit(answerCli(w, id, hash), 4);
    for (let n = 0; n < 3; n++) {
      const rebuilt = w.reconstruct(); await rebuilt.tick();
      assert.strictEqual((await rebuilt.status(record.id)).stage, 'needs-input');
      assert.strictEqual((await rebuilt.status(other.id)).stage, 'needs-input');
    }
    assert.strictEqual(journal(w), before, 'refused/missing answers must not append accepted evidence');
    assert.strictEqual(await adapters.readAnswer(record.hash), null);
    assert.strictEqual(await adapters.readReceipt(record.hash), null);
    assert.strictEqual(plans.length, 2, 'unanswered questions must not relaunch the planner');
  });
});

test('C2 guard: an existing canonical answer file with the wrong question hash cannot authorize consumption', async () => {
  const plans = [];
  await world({ specificationAdapters: questionPlanner(plans) }, async w => {
    const { record, waiting, adapters } = await startQuestion(w, 'stale saved evidence');
    // Corrupted/stale host evidence is produced through the actual canonical artifact writer.
    await adapters.writeAnswer(record.hash, { answer: 'An old question answer.',
      previousEvidenceHash: `sha256:${'f'.repeat(64)}`, createdAt: new Date().toISOString() });
    const before = journal(w);
    for (let n = 0; n < 2; n++) {
      const rebuilt = w.reconstruct(); await rebuilt.tick();
      const row = await rebuilt.status(record.id);
      assert.strictEqual(row.stage, 'needs-input');
      assert.strictEqual(row.question.evidenceHash, waiting.question.evidenceHash);
      assert.strictEqual(row.issueId, null);
    }
    assert.strictEqual(events(w, 'answer.accepted', record.id).length, 0);
    assert.strictEqual(events(w, 'specification.completed', record.id).length, 1);
    assert.strictEqual(plans.length, 1);
    assert(journal(w).startsWith(before), 'negative observation must preserve append-only history');
  });
});

for (const word of ['merged', 'rejected']) {
  test(`C3/C4 CLI pending-to-${word} is visible to current/rebuilt status and accepted exactly once by an owning tick`, async () => {
    await world({}, async w => {
      const { record, supervisor, pending, verdictFile } = await atReview(w, `normal ${word}`);
      const before = journal(w);
      const reason = `Operator accepted ${word}: exact reviewed behavior.`;
      assertExit(verdictCli(w, pending.issueId, pending.runId, word, reason), 0);
      const canonical = readJson(verdictFile);
      assert.deepStrictEqual([canonical.issueId, canonical.runId, canonical.prUrl, canonical.verdict, canonical.reason],
        [pending.issueId, pending.runId, pending.prUrl, word, reason]);
      assert.strictEqual(events(w, 'review.decided', record.id).length, 0);
      disposition(await supervisor.status(record.id), pending, word, reason);
      disposition(await w.reconstruct().status(record.id), pending, word, reason);
      assert.strictEqual(journal(w), before, 'read-only projection must not write decision history');
      const launches = w.children.length;
      for (let n = 0; n < 3; n++) {
        const rebuilt = w.reconstruct(); await rebuilt.tick();
        disposition(await rebuilt.status(record.id), pending, word, reason);
      }
      assert.strictEqual(events(w, 'review.decided', record.id).length, 1);
      assert.strictEqual(events(w, 'stage', record.id).filter(e => e.stage === 'rejected').length, word === 'rejected' ? 1 : 0);
      assert.strictEqual(w.children.length, launches, 'verdict observation cannot retry implementation or publish/merge');
      assert(journal(w).startsWith(before), 'accepted decision preserves the earlier history bytes');
      assert(supervisorApi.formatHumanStatus(await w.reconstruct().status(record.id)).includes(`verdict=${word}`));
    });
  });

  test(`C3/C4 ${word} reason correction and conflicting later verdict preserve the first disposition and terminal history`, async () => {
    await world({}, async w => {
      const { record, pending, verdictFile } = await atReview(w, `conflict after ${word}`);
      assertExit(verdictCli(w, pending.issueId, pending.runId, word, 'First accepted disposition.'), 0);
      await w.reconstruct().tick();
      disposition(await w.reconstruct().status(record.id), pending, word, 'First accepted disposition.');
      const acceptedHistory = events(w, 'stage', record.id);
      const launches = w.children.length;
      const correction = 'Corrected explanation for the same accepted disposition.';
      assertExit(verdictCli(w, pending.issueId, pending.runId, word, correction), 0);
      disposition(await w.reconstruct().status(record.id), pending, word, correction);
      await w.reconstruct().tick();
      assert.strictEqual(events(w, 'review.decided', record.id).length, 1, 'a reason correction is not another decision');
      const opposite = word === 'merged' ? 'rejected' : 'merged';
      const conflictReason = 'The operator later reported a conflicting review disposition.';
      assertExit(verdictCli(w, pending.issueId, pending.runId, opposite, conflictReason), 0);
      assert.strictEqual(readJson(verdictFile).verdict, opposite, 'canonical writer must really record the latest word');
      for (let n = 0; n < 3; n++) {
        const rebuilt = w.reconstruct();
        const row = await rebuilt.status(record.id);
        assert.strictEqual(row.stage, word === 'merged' ? 'review' : 'rejected');
        assert.strictEqual(row.verdict, word, 'first accepted supervisor disposition remains durable');
        const visible = serialized(row);
        assert(visible.includes(conflictReason) && visible.includes(opposite), 'latest conflicting word and reason must be shown');
        assert(/conflict/i.test(visible), 'conflict needs explicit attention');
        const human = supervisorApi.formatHumanStatus(row);
        assert(/conflict/i.test(human), 'human status must also surface conflict attention');
        assert(human.includes(conflictReason), 'human status must show the latest conflicting canonical reason');
        assert(human.includes(opposite), 'human status must show the latest conflicting canonical verdict');
        await rebuilt.tick();
      }
      assert.strictEqual(events(w, 'review.decided', record.id).length, 1);
      assert.deepStrictEqual(events(w, 'stage', record.id), acceptedHistory, 'conflict cannot rewrite terminal history');
      assert.strictEqual(w.children.length, launches, 'conflicting evidence cannot launch recovery or a merge');
    });
  });
}

test('C3/C4 guard: unrelated issue/run/PR verdicts and malformed or missing files cannot fabricate a decision', async () => {
  await world({}, async w => {
    const { record, pending, verdictFile } = await atReview(w, 'wrong review identity');
    const otherRunId = 'unrelated-review-run';
    const otherRun = path.join(w.runsRoot, otherRunId);
    fs.mkdirSync(otherRun, { recursive: true });
    report.writeManifest(otherRun, { runId: otherRunId, startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(), tasks: [
        { issueId: pending.issueId, outcome: 'done', prUrl: 'https://example.invalid/pull/other' },
        { issueId: 'bd-unrelated', outcome: 'done', prUrl: pending.prUrl },
      ] });
    assertExit(verdictCli(w, pending.issueId, otherRunId, 'merged', 'Another run.'), 0);
    assertExit(verdictCli(w, 'bd-unrelated', otherRunId, 'rejected', 'Another issue.'), 0);
    const before = journal(w);
    const cases = [null, '{unreadable JSON',
      fs.readFileSync(path.join(otherRun, 'tasks', pending.issueId, 'verdict.json'), 'utf8'),
      fs.readFileSync(path.join(otherRun, 'tasks', 'bd-unrelated', 'verdict.json'), 'utf8')];
    // Keep the writer-produced record's word/reason but substitute one wrong identity at
    // a time, modelling stale/copied host files at the otherwise correct evidence path.
    assertExit(verdictCli(w, pending.issueId, pending.runId, 'merged', 'Correct path, wrong PR copy.'), 0);
    const original = readJson(verdictFile);
    cases.push(serialized({ ...original, prUrl: 'https://example.invalid/pull/different' }));
    for (const bytes of cases) {
      if (bytes === null) { if (fs.existsSync(verdictFile)) fs.unlinkSync(verdictFile); }
      else { fs.mkdirSync(path.dirname(verdictFile), { recursive: true }); fs.writeFileSync(verdictFile, bytes); }
      const rebuilt = w.reconstruct(); await rebuilt.tick();
      const row = await rebuilt.status(record.id);
      assert.strictEqual(row.stage, 'review');
      assert(!['merged', 'rejected'].includes(row.verdict), `unrelated/unavailable evidence fabricated ${row.verdict}`);
      assert.strictEqual(events(w, 'review.decided', record.id).length, 0);
    }
    assert(journal(w).startsWith(before), 'unavailable evidence preserves durable history');
  });
});

test('C4 valid accepted evidence survives later unavailable files without a duplicate decision or action', async () => {
  await world({}, async w => {
    const { record, pending, verdictFile } = await atReview(w, 'review evidence disappearance');
    const reason = 'Accepted before the evidence became unavailable.';
    assertExit(verdictCli(w, pending.issueId, pending.runId, 'merged', reason), 0);
    await w.reconstruct().tick();
    disposition(await w.reconstruct().status(record.id), pending, 'merged', reason);
    const saved = fs.readFileSync(verdictFile);
    const launches = w.children.length;
    for (const bytes of [null, Buffer.from('unreadable json'), saved]) {
      if (bytes === null) fs.unlinkSync(verdictFile); else fs.writeFileSync(verdictFile, bytes);
      const rebuilt = w.reconstruct(); await rebuilt.tick();
      disposition(await rebuilt.status(record.id), pending, 'merged', reason);
      assert.strictEqual(events(w, 'review.decided', record.id).length, 1);
    }
    assert.strictEqual(w.children.length, launches);
  });
});

test('C4 durable rejected decision recovers its missing terminal stage after a crash even when canonical evidence is unavailable', async () => {
  await world({}, async w => {
    const { record, pending, verdictFile } = await atReview(w, 'rejection stage crash');
    const reason = 'Operator rejected the reviewed implementation before host interruption.';
    assertExit(verdictCli(w, pending.issueId, pending.runId, 'rejected', reason), 0);
    const realWrite = fs.writeSync;
    let interrupted = false;
    // Interrupt the actual journal append at the precise durable boundary. The real
    // verdict CLI and owning tick produce review.decided; no event is manually injected.
    fs.writeSync = function(fd, bytes, ...args) {
      if (typeof bytes === 'string') {
        let event;
        try { event = JSON.parse(bytes); } catch {}
        if (event && event.type === 'stage' && event.proposalId === record.id && event.stage === 'rejected') {
          interrupted = true;
          throw new Error('fixture crash before rejected stage append');
        }
      }
      return realWrite.call(fs, fd, bytes, ...args);
    };
    try { await assert.rejects(w.reconstruct().tick(), /fixture crash before rejected stage append/); }
    finally { fs.writeSync = realWrite; }
    assert(interrupted, 'fault must fire on the real rejected-stage append');
    assert.strictEqual(events(w, 'review.decided', record.id).length, 1);
    assert.strictEqual(events(w, 'stage', record.id).filter(e => e.stage === 'rejected').length, 0);
    const durablePrefix = journal(w);
    fs.writeFileSync(verdictFile, '{unavailable canonical evidence after interruption');
    const launches = w.children.length;
    for (let n = 0; n < 3; n++) {
      const rebuilt = w.reconstruct(); await rebuilt.tick();
      const row = await rebuilt.status(record.id);
      disposition(row, pending, 'rejected', reason);
      assert.match(String(row.reviewAttention), /unavailable|malformed|unreadable|invalid/i);
      assert.strictEqual(events(w, 'review.decided', record.id).length, 1);
      assert.strictEqual(events(w, 'stage', record.id).filter(e => e.stage === 'rejected').length, 1,
        'owning recovery must persist the terminal stage from its durable rejection');
    }
    assert(journal(w).startsWith(durablePrefix));
    assert.strictEqual(w.children.length, launches);
  });
});

(async () => {
  let failed = 0;
  for (const { name, body } of tests) {
    try { await body(); console.log(`ok - ${name}`); }
    catch (error) { failed++; console.error(`FAIL - ${name}\n${error.stack || error}`); }
  }
  console.log(`repo-djf.61: ${tests.length - failed}/${tests.length} passed`);
  process.exitCode = failed ? 1 : 0;
})();
