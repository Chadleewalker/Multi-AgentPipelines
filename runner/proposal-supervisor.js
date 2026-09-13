// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0
'use strict';

// The proposal conveyor composes controllers; it does not replace them.  Its journal records
// immutable intake and the exact values returned by specify-proposal, supervisor authority,
// operation-manager and verdict evidence.  Stage names below are projections of that evidence,
// never commands accepted from a model or from configuration.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TESTING_SENTINEL = Symbol('proposal-supervisor-test-capability');
const EFFECTS = new Set(['specification', 'grant-preparation', 'preparation',
  'grant-implementation', 'implementation-feed', 'review']);

function atomicAppend(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const fd = fs.openSync(file, 'a', 0o600);
  try { fs.writeSync(fd, `${JSON.stringify(value)}\n`); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}

function readJournal(file) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const events = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    try { events.push(JSON.parse(line)); } catch { break; } // a killed final append is no event
  }
  return events;
}

function fold(events) {
  const state = { closed: false, proposals: new Map(), order: [], feedGrant: null,
    feed: null, stopped: false };
  for (const event of events) {
    if (!event || typeof event !== 'object') continue;
    if (event.type === 'intake.closed') state.closed = true;
    if (event.type === 'feed.granted') state.feedGrant = event.grant;
    if (event.type === 'feed.started') state.feed = event.operation;
    if (event.type === 'feed.stopped') state.stopped = true;
    if (event.type === 'proposal.submitted' && event.record && !state.proposals.has(event.record.id)) {
      state.order.push(event.record.id);
      state.proposals.set(event.record.id, { record: event.record, submittedAt: event.at });
      continue;
    }
    const proposal = event.proposalId && state.proposals.get(event.proposalId);
    if (!proposal) continue;
    if (event.type === 'specification.completed') {
      proposal.specification = event.result; proposal.specificationAt = event.at;
    }
    if (event.type === 'preparation.granted') {
      proposal.preparationGrant = event.grant; proposal.preparationGrantedAt = event.at;
    }
    if (event.type === 'preparation.started') {
      proposal.preparationOperation = event.operation; proposal.preparationStartedAt = event.at;
    }
    if (event.type === 'preparation.completed') {
      proposal.preparationEvidence = event.evidence; proposal.preparationCompletedAt = event.at;
    }
    if (event.type === 'proposal.implementing') proposal.implementingAt = event.at;
    if (event.type === 'implementation.observed') {
      proposal.task = event.task; proposal.implementationObservedAt = event.at;
    }
    if (event.type === 'review.observed') {
      proposal.review = event.evidence; proposal.reviewedAt = event.at;
    }
  }
  return state;
}

function operationValue(answer, name) {
  if (!answer || answer.ok === false || !answer.operation) {
    throw new Error(`proposal supervisor: ${name} failed${answer && answer.error ? `: ${answer.error}` : ''}`);
  }
  return answer.operation;
}

function freezeReceiptOf(evidence, issueId) {
  if (!evidence || typeof evidence !== 'object') return null;
  if (evidence.freezeReceipt) return evidence.freezeReceipt;
  const issue = Array.isArray(evidence.issues)
    ? evidence.issues.find(row => row && row.id === issueId) : null;
  if (!issue) return null;
  if (issue.freezeReceipt) return issue.freezeReceipt;
  const workers = Array.isArray(issue.workers) ? issue.workers : [];
  for (let i = workers.length - 1; i >= 0; i -= 1) {
    const data = workers[i] && workers[i].result && workers[i].result.data;
    const nested = data && data.data;
    if (data && data.freezeReceipt) return data.freezeReceipt;
    if (nested && nested.freezeReceipt) return nested.freezeReceipt;
  }
  return null;
}

function productionAdapters(repoRoot, options = {}) {
  const kickoff = require('../scripts/kickoff');
  const specifyProposal = require('../scripts/specify-proposal');
  const supervisor = require('./supervisor');
  const { createHostOperationManager } = require('./operation-manager');
  const verdict = require('../scripts/verdict');
  const root = path.resolve(repoRoot);
  const configPath = options.configPath;
  let lease = null;

  function parent(project) {
    if (lease) return lease;
    const id = options.supervisorId || `proposal-supervisor-${process.pid}`;
    const acquired = supervisor.acquire(root, project, id);
    if (!acquired.ok) throw new Error(acquired.reason || 'proposal supervisor authority is held');
    lease = acquired.lease;
    return lease;
  }

  const operations = createHostOperationManager({ pipelineRoot: root,
    stateRoot: options.operationStateRoot, runsRoot: options.runsRoot });
  return {
    kickoff: {
      verify(record) { return kickoff.verifyRecord(record, record && record.id,
        record && record.target); },
      list({ project }) { return kickoff.readAll(kickoff.statePathsFor(project)); },
    },
    specification: {
      async execute(record) {
        const specAdapters = specifyProposal.productionAdapters({ configPath });
        return specifyProposal.execute({ configPath, proposalId: record.id }, {}, specAdapters);
      },
    },
    authority: {
      grant(request) {
        const parentLease = parent(request.project);
        const result = supervisor.grant(parentLease, { scope: request.scope,
          issueId: request.issueId || null, batch: request.batchId || null,
          ttlMs: request.ttlMs || supervisor.MAX_TTL_MS });
        if (!result.ok) throw new Error(result.error);
        return { authority: result.authority, parentLease };
      },
    },
    operations,
    review: {
      evidence({ issueId, runId, task }) {
        const rootRuns = options.runsRoot || path.join(root, 'runs');
        const run = verdict.readRuns(rootRuns).find(row => row.runId === runId);
        if (!run) return null;
        const verdictFile = path.join(run.dir, 'tasks', issueId, 'verdict.json');
        let recorded = null;
        try { recorded = JSON.parse(fs.readFileSync(verdictFile, 'utf8')); } catch {}
        return { reviewItemId: verdictFile, issueId, runId, branch: task.branch || null,
          prUrl: task.prUrl || null, verdict: recorded && recorded.verdict || 'pending',
          evidence: recorded };
      },
    },
  };
}

function createProductionSupervisor(options = {}) {
  const repoRoot = path.resolve(options.repoRoot || path.join(__dirname, '..'));
  const project = path.resolve(options.project || '');
  if (!options.project) throw new Error('proposal supervisor: project is required');
  if (options.adapters && options.testingSentinel !== TESTING_SENTINEL) {
    throw new Error('proposal supervisor: adapter substitution requires the host testing capability');
  }
  const stateDir = path.resolve(options.stateDir || path.join(
    process.env.PIPELINE_STATE_DIR || path.join(os.homedir(), '.multi-agent-pipelines'),
    'proposal-supervisor', crypto.createHash('sha256').update(project).digest('hex')));
  const journal = path.join(stateDir, 'events.jsonl');
  const adapters = options.adapters || productionAdapters(repoRoot, {
    configPath: options.configPath, supervisorId: options.supervisorId,
    operationStateRoot: path.join(stateDir, 'operations'), runsRoot: options.runsRoot,
  });
  const globalConcurrency = Math.max(1, Number(options.globalConcurrency) || 2);
  const stageConcurrency = { specification: 1, preparation: 1,
    ...(options.stageConcurrency || {}) };
  let activeTick = null;
  let crashed = false;

  const state = () => fold(readJournal(journal));
  const append = (type, body = {}) => atomicAppend(journal,
    { sequence: readJournal(journal).length + 1, type, at: new Date().toISOString(), ...body });
  function crashAfter(effect) {
    if (!crashed && options.crashAfter === effect && EFFECTS.has(effect)) {
      crashed = true;
      throw new Error(`proposal supervisor: injected crash after ${effect}`);
    }
  }

  async function submit(record) {
    const current = state();
    if (current.closed) return { accepted: false, reason: 'intake is closed' };
    const verified = await adapters.kickoff.verify(record);
    if (!verified || verified.id !== record.id || verified.hash !== record.hash) {
      throw new Error('proposal supervisor: kickoff verification failed');
    }
    if (path.resolve(String(verified.target || '')) !== project) {
      throw new Error('proposal supervisor: kickoff belongs to another project');
    }
    if (state().closed) return { accepted: false, reason: 'intake is closed' };
    const latest = state();
    const prior = latest.proposals.get(record.id);
    if (prior) return { accepted: prior.record.hash === record.hash, id: record.id, existing: true };
    append('proposal.submitted', { proposalId: record.id, record });
    return { accepted: true, id: record.id };
  }

  const batchId = id => `proposal-${id}`;
  const feedId = () => `proposal-feed-${crypto.createHash('sha256').update(project).digest('hex').slice(0, 20)}`;

  function actions(current, attempted) {
    const rows = current.order.map(id => [id, current.proposals.get(id)]);
    const pick = (kind, candidates, limit = globalConcurrency) => candidates
      .filter(action => !attempted.has(action.key)).slice(0, Math.min(globalConcurrency, limit));

    let candidates = rows.filter(([, p]) => p.preparationOperation && !p.preparationEvidence)
      .map(([id, p]) => ({ kind: 'poll-preparation', key: `poll-preparation:${id}`, id, p }));
    if (candidates.length) return pick('poll-preparation', candidates,
      Number(stageConcurrency.preparation) || 1);

    const prepared = rows.filter(([, p]) => p.preparationEvidence && !p.implementingAt);
    if (prepared.length && !current.feedGrant) return [{ kind: 'grant-feed', key: 'grant-feed' }];
    if (prepared.length && current.feedGrant && !current.feed) return [{ kind: 'start-feed', key: 'start-feed' }];
    if (prepared.length && current.feed) return prepared.map(([id, p]) =>
      ({ kind: 'mark-implementing', key: `mark-implementing:${id}`, id, p }));

    candidates = rows.filter(([, p]) => p.task && !p.review)
      .map(([id, p]) => ({ kind: 'review', key: `review:${id}`, id, p }));
    if (candidates.length) return pick('review', candidates);

    candidates = rows.filter(([, p]) => !p.specification)
      .map(([id, p]) => ({ kind: 'specification', key: `specification:${id}`, id, p }));
    if (candidates.length) return pick('specification', candidates,
      Number(stageConcurrency.specification) || 1);

    candidates = rows.filter(([, p]) => p.specification && p.specification.status === 'ready'
        && !p.preparationGrant)
      .map(([id, p]) => ({ kind: 'grant-preparation', key: `grant-preparation:${id}`, id, p }));
    if (candidates.length) return pick('grant-preparation', candidates,
      Number(stageConcurrency.preparation) || 1);

    candidates = rows.filter(([, p]) => p.preparationGrant && !p.preparationOperation)
      .map(([id, p]) => ({ kind: 'start-preparation', key: `start-preparation:${id}`, id, p }));
    if (candidates.length) return pick('start-preparation', candidates,
      Number(stageConcurrency.preparation) || 1);

    if (current.feed) return pick('poll-feed', [{ kind: 'poll-feed', key: 'poll-feed' }], 1);
    return [];
  }

  async function runAction(action) {
    const current = state();
    const p = action.id && current.proposals.get(action.id);
    if (action.kind === 'poll-preparation') {
      const answer = await adapters.operations.status({ project, id: p.preparationOperation.id });
      if (answer && answer.ok && answer.state === 'completed' && answer.preparation) {
        append('preparation.completed', { proposalId: action.id, evidence: answer.preparation });
        return true;
      }
      return false;
    }
    if (action.kind === 'grant-feed') {
      const grant = await adapters.authority.grant({ scope: 'implementation', project });
      append('feed.granted', { grant }); crashAfter('grant-implementation'); return true;
    }
    if (action.kind === 'start-feed') {
      const answer = await adapters.operations.startImplementation({ project,
        operationId: feedId(), configPath: options.configPath, grant: current.feedGrant });
      append('feed.started', { operation: operationValue(answer, 'implementation feed') });
      crashAfter('implementation-feed'); return true;
    }
    if (action.kind === 'mark-implementing') {
      append('proposal.implementing', { proposalId: action.id }); return true;
    }
    if (action.kind === 'review') {
      const evidence = await adapters.review.evidence({ proposalId: action.id,
        issueId: p.specification.issueId, runId: current.feed.runId, task: p.task });
      if (!evidence) return false;
      append('review.observed', { proposalId: action.id, evidence });
      crashAfter('review'); return true;
    }
    if (action.kind === 'specification') {
      const result = await adapters.specification.execute(p.record);
      append('specification.completed', { proposalId: action.id, result });
      crashAfter('specification'); return true;
    }
    if (action.kind === 'grant-preparation') {
      const grant = await adapters.authority.grant({ scope: 'preparation', project,
        proposalId: action.id, issueId: p.specification.issueId, batchId: batchId(action.id) });
      append('preparation.granted', { proposalId: action.id, grant });
      crashAfter('grant-preparation'); return true;
    }
    if (action.kind === 'start-preparation') {
      const answer = await adapters.operations.startPreparation({ project,
        proposalId: action.id, batchId: batchId(action.id), configPath: options.configPath,
        issues: [p.specification.issueId], grant: p.preparationGrant });
      append('preparation.started', { proposalId: action.id,
        operation: operationValue(answer, 'preparation') });
      crashAfter('preparation'); return true;
    }
    if (action.kind === 'poll-feed') {
      const answer = await adapters.operations.status({ project, id: current.feed.id });
      if (!answer || !answer.ok || !answer.manifest || !Array.isArray(answer.manifest.tasks)) return false;
      let changed = false;
      for (const id of current.order) {
        const proposal = current.proposals.get(id);
        if (!proposal || proposal.task || !proposal.specification) continue;
        const task = answer.manifest.tasks.find(row => row && row.issueId === proposal.specification.issueId
          && row.prUrl && row.branch);
        if (task) { append('implementation.observed', { proposalId: id, task }); changed = true; }
      }
      return changed;
    }
    return false;
  }

  async function doTick() {
    const attempted = new Set();
    for (let rounds = 0; rounds < 128; rounds += 1) {
      const batch = actions(state(), attempted);
      if (!batch.length) break;
      const results = await Promise.all(batch.map(runAction));
      batch.forEach((action, index) => { if (!results[index]) attempted.add(action.key); });
      if (!results.some(Boolean) && actions(state(), attempted).length === 0) break;
    }
    return { ok: true };
  }

  function tick() {
    if (!activeTick) activeTick = doTick().finally(() => { activeTick = null; });
    return activeTick;
  }

  async function resume() {
    await tick();
    return { ok: true, proposals: state().order.length };
  }

  async function stop() {
    let current = state();
    if (!current.closed) append('intake.closed');
    if (activeTick) await activeTick;
    current = state();
    if (current.feed && !current.stopped) {
      const answer = await adapters.operations.stop({ project, id: current.feed.id });
      if (!answer || answer.ok === false) throw new Error(answer && answer.error || 'could not stop feed');
      append('feed.stopped', { evidence: answer });
    }
    return { ok: true };
  }

  async function status(id) {
    const current = state();
    const p = current.proposals.get(id);
    if (!p) return { found: false, id };
    const spec = p.specification || {};
    const prep = p.preparationEvidence || {};
    const task = p.task || {};
    const review = p.review || {};
    let stage = 'queued';
    if (p.specification) stage = spec.status === 'ready' ? 'specified' : spec.status;
    if (p.preparationGrant) stage = 'preparing';
    if (p.preparationEvidence) stage = 'prepared';
    if (p.implementingAt) stage = 'implementing';
    if (p.review) stage = 'review';
    const unfinished = current.order.filter(proposalId => {
      const row = current.proposals.get(proposalId); return row && !row.review;
    });
    const queueIndex = unfinished.indexOf(id);
    return {
      id, queuePosition: queueIndex < 0 ? null : queueIndex + 1, stage,
      timing: { submittedAt: p.submittedAt, specificationAt: p.specificationAt || null,
        preparationGrantedAt: p.preparationGrantedAt || null,
        preparationStartedAt: p.preparationStartedAt || null,
        preparationCompletedAt: p.preparationCompletedAt || null,
        implementingAt: p.implementingAt || null,
        implementationObservedAt: p.implementationObservedAt || null,
        reviewedAt: p.reviewedAt || null },
      attempts: Array.isArray(task.attempts) ? task.attempts : [],
      model: spec.model || null, tokens: spec.tokens || null,
      kickoffHash: p.record.hash, specHash: spec.receipt && spec.receipt.specHash || spec.specHash || null,
      issueId: spec.issueId || null, freezeReceipt: freezeReceiptOf(prep, spec.issueId) || null,
      runId: current.feed && current.feed.runId || null,
      branch: task.branch || review.branch || null, prUrl: task.prUrl || review.prUrl || null,
      reviewItemId: review.reviewItemId || null, verdict: review.verdict || null,
      nextAction: stage === 'review' ? (review.verdict === 'pending' ? 'record review verdict' : 'complete')
        : current.closed ? 'wait for granted work to settle' : `advance ${stage}`,
    };
  }

  return { submit, tick, resume, stop, status };
}

module.exports = { createProductionSupervisor, productionAdapters, TESTING_SENTINEL };
