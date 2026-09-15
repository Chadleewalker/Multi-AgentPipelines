// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0
'use strict';

// Deterministic host controller for kickoff -> specification -> preparation -> the shared
// implementation feed -> review. Models supply prose only; this module owns transitions,
// limits, identities, durable observation, and publication order.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const LOCK = require('./lock');

const TESTING_SENTINEL = Symbol('proposal-supervisor-test-capability');
const STAGES = ['queued', 'specifying', 'criticizing', 'authoring-tests', 'proving',
  'freezing', 'ready', 'implementing', 'publishing', 'review', 'needs-input', 'failed',
  'rejected'];
const NEXT = {
  queued: new Set(['specifying', 'rejected']),
  specifying: new Set(['criticizing', 'needs-input', 'failed', 'rejected']),
  'needs-input': new Set(['specifying', 'rejected']),
  criticizing: new Set(['authoring-tests', 'failed', 'rejected']),
  'authoring-tests': new Set(['proving', 'failed', 'rejected']),
  proving: new Set(['freezing', 'failed', 'rejected']),
  freezing: new Set(['ready', 'failed', 'rejected']),
  ready: new Set(['implementing', 'failed', 'rejected']),
  implementing: new Set(['publishing', 'failed', 'rejected']),
  publishing: new Set(['review', 'failed', 'rejected']),
  review: new Set(['rejected']), failed: new Set(), rejected: new Set(),
};
const CRASH_BOUNDARIES = new Set(['beads-issue', 'freeze', 'branch', 'pr']);

const digest = value => crypto.createHash('sha256').update(String(value)).digest('hex');
function inside(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}
function supervisorStateDirFor(project, env = process.env, canonicalTarget = LOCK.canonicalTarget) {
  const root = path.resolve(env.PIPELINE_STATE_DIR
    || path.join(os.homedir(), '.multi-agent-pipelines'));
  return path.join(root, 'proposal-supervisor', digest(canonicalTarget(project)));
}
function atomicAppend(file, event) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const fd = fs.openSync(file, 'a', 0o600);
  try { fs.writeSync(fd, `${JSON.stringify(event)}\n`); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}
function readJournal(file) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const events = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    try { events.push(JSON.parse(line)); } catch { break; }
  }
  return events;
}
function assertTransition(from, to) {
  if (!STAGES.includes(to) || (from === null ? to !== 'queued' : !(NEXT[from] || new Set()).has(to))) {
    throw new Error(`proposal supervisor: invalid transition ${from || '(none)'} -> ${to}`);
  }
}
function validateSnapshot(file) {
  if (!fs.existsSync(file)) return;
  let snapshot;
  try { snapshot = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw new Error('proposal supervisor: durable state is malformed'); }
  for (const proposal of Object.values(snapshot.proposals || {})) {
    let stage = null;
    for (const event of proposal.history || []) {
      if (event.type !== 'stage') continue;
      assertTransition(stage, event.stage); stage = event.stage;
    }
    if (stage !== proposal.stage || (proposal.state && proposal.state !== stage)) {
      throw new Error('proposal supervisor: durable stage does not match append-only history');
    }
  }
}
function fold(events) {
  const result = { closed: false, parentLease: null, parentReleased: false,
    feedGrant: null, feed: null, feeds: [], proposals: new Map(), order: [] };
  for (const event of events) {
    if (!event || typeof event !== 'object') throw new Error('proposal supervisor: invalid journal event');
    if (event.type === 'intake.closed') { result.closed = true; continue; }
    if (event.type === 'parent.acquired') { result.parentLease = event.lease; continue; }
    if (event.type === 'parent.released') { result.parentReleased = true; continue; }
    if (event.type === 'feed.granted') { result.feedGrant = event.grant; continue; }
    if (event.type === 'feed.started') {
      result.feed = { ...event.operation, generation: event.generation, stopRequested: false };
      result.feeds.push(result.feed); continue;
    }
    if (event.type === 'feed.stop-requested' && result.feed) {
      result.feed.stopRequested = true; continue;
    }
    if (event.type === 'feed.completed' && result.feed) { result.feed.completed = true; continue; }
    if (event.type === 'feed.settled') { result.feed = null; result.feedGrant = null; continue; }
    if (event.type === 'proposal.submitted') {
      if (!result.proposals.has(event.proposalId)) {
        result.order.push(event.proposalId);
        result.proposals.set(event.proposalId, { record: event.record, history: [] });
      }
      continue;
    }
    const p = result.proposals.get(event.proposalId);
    if (!p) throw new Error('proposal supervisor: journal event precedes proposal intake');
    if (event.type === 'stage') {
      assertTransition(p.stage || null, event.stage);
      p.stage = event.stage; p.history.push(event);
    } else if (event.type === 'answer.accepted') {
      p.answer = event.answer; p.history.push(event); p.specification = null;
      p.specificationCompleted = false;
    } else if (event.type === 'specification.completed') {
      p.specification = event.result; p.specificationCompleted = true;
    }
    else if (event.type === 'preparation.granted') p.preparationGrant = event.grant;
    else if (event.type === 'preparation.started') p.preparationOperation = event.operation;
    else if (event.type === 'preparation.observed') p.preparationObserved = event.evidence;
    else if (event.type === 'preparation.completed') p.preparationEvidence = event.evidence;
    else if (event.type === 'preparation.settled') p.preparationSettled = true;
    else if (event.type === 'proposal.assigned') {
      p.feedId = event.feedId; p.runId = event.runId || null;
    } else if (event.type === 'implementation.observed') p.task = event.task;
    else if (event.type === 'review.observed') p.review = event.evidence;
    else if (event.type === 'review.decided') {
      p.verdict = event.verdict; p.verdictReason = event.reason;
    }
  }
  return result;
}

function freezeReceiptOf(evidence, issueId) {
  if (!evidence || typeof evidence !== 'object') return null;
  if (evidence.freezeReceipt) return evidence.freezeReceipt;
  const issue = Array.isArray(evidence.issues)
    ? evidence.issues.find(row => row && row.id === issueId) : null;
  if (!issue) return null;
  if (issue.freezeReceipt) return issue.freezeReceipt;
  for (const worker of (issue.workers || []).slice().reverse()) {
    const data = worker && worker.result && worker.result.data;
    if (data && data.freezeReceipt) return data.freezeReceipt;
    if (data && data.data && data.data.freezeReceipt) return data.data.freezeReceipt;
  }
  return null;
}
function operationValue(answer, label) {
  if (!answer || answer.ok === false || !answer.operation) {
    throw new Error(`proposal supervisor: ${label} failed${answer && answer.error ? `: ${answer.error}` : ''}`);
  }
  return answer.operation;
}

// Which model the specification lane would actually launch for this run config (§6.5).
// Resolved from the SAME loader the launch itself uses, so `status` reports the planner
// lane rather than the implementation model it is now independent of. A config this
// process cannot read is reported as the constant default rather than thrown: status must
// stay answerable on a broken config, and the launch still refuses on the real error.
function specificationModelFor(configPath) {
  const { loadConfig, DEFAULT_SPECIFICATION_MODEL } = require('./config');
  if (!configPath) return DEFAULT_SPECIFICATION_MODEL;
  try { return loadConfig(configPath).specificationModel || DEFAULT_SPECIFICATION_MODEL; }
  catch { return DEFAULT_SPECIFICATION_MODEL; }
}

function productionAdapters(repoRoot, options = {}) {
  const kickoff = require('../scripts/kickoff');
  const specify = require('../scripts/specify-proposal');
  const authorityApi = require('./supervisor');
  const { createHostOperationManager } = require('./operation-manager');
  const verdict = require('../scripts/verdict');
  const root = path.resolve(repoRoot);
  const configPath = options.configPath;
  let lease = options.lease || null;
  function parent(project) {
    if (lease) return lease;
    const acquired = authorityApi.acquire(root, project,
      options.supervisorId || `proposal-supervisor-${process.pid}`, { reclaim: options.reclaim === true });
    if (!acquired.ok) throw new Error(acquired.reason || 'proposal supervisor authority is held');
    lease = acquired.lease; return lease;
  }
  const operations = createHostOperationManager({ pipelineRoot: root,
    stateRoot: options.operationStateRoot, runsRoot: options.runsRoot });
  return {
    kickoff: {
      verify(record) { return kickoff.verifyRecord(record, record && record.id, record && record.target); },
      list({ project }) { return kickoff.readAll(kickoff.statePathsFor(project)); },
    },
    specification: {
      model: specificationModelFor(configPath),
      async execute(record) {
        const adapters = specify.productionAdapters({ configPath, proposalId: record.id });
        return specify.execute({ configPath, proposalId: record.id }, {}, adapters);
      },
      async answer(request) {
        const adapters = specify.productionAdapters({ configPath, proposalId: request.proposalId });
        return specify.recordAnswer({ configPath, proposalId: request.proposalId,
          previousEvidenceHash: request.evidenceHash, answer: request.text }, adapters);
      },
    },
    authority: {
      acquire({ project }) { return parent(project); },
      grant(request) {
        const parentLease = parent(request.project);
        const made = authorityApi.grant(parentLease, { scope: request.scope,
          issueId: request.issueId || null, batch: request.batch || request.batchId || null,
          ttlMs: request.ttlMs || authorityApi.MAX_TTL_MS });
        return made.ok ? { ok: true, authority: made.authority, parentLease } : made;
      },
      settle(grant, outcome = 'complete') {
        const nonce = typeof grant === 'string' ? grant
          : grant && grant.authority ? grant.authority.nonce : grant && grant.nonce;
        const parentLease = grant && grant.parentLease || lease;
        const made = authorityApi.settle(parentLease, nonce,
          typeof outcome === 'object' ? outcome : { outcome });
        if (!made.ok) {
          const known = authorityApi.settlementState(parentLease, nonce);
          if (known && known.ok && known.settled) return { ok: true, existing: true };
        }
        return made;
      },
      settlementState(grant) {
        const nonce = typeof grant === 'string' ? grant
          : grant && grant.authority ? grant.authority.nonce : grant && grant.nonce;
        return authorityApi.settlementState(lease, nonce);
      },
      release(parentLease) {
        const owned = parentLease || lease;
        if (!owned) return { ok: true, existing: true };
        const remaining = authorityApi.outstanding(owned.target);
        if (remaining.length) return { ok: false, error: `${remaining.length} child grant(s) remain outstanding` };
        authorityApi.release(root, owned.target, owned); lease = null; return { ok: true };
      },
    },
    operations,
    review: {
      evidence({ proposalId, issueId, runId, task }) {
        if (!task || !task.prUrl) return null;
        const runsRoot = options.runsRoot || path.join(root, 'runs');
        const run = verdict.readRuns(runsRoot).find(row => row.runId === runId);
        if (!run) return null;
        const file = path.join(run.dir, 'tasks', issueId, 'verdict.json');
        let recorded = null;
        try { recorded = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
        return { proposalId, issueId, runId, branch: task.branch || null,
          prUrl: task.prUrl, reviewItemId: file,
          verdict: recorded && recorded.verdict || 'pending', evidence: recorded };
      },
      decide({ issueId, runId, verdict: word, reason }) {
        const old = process.env.VERDICT_RUNS_DIR;
        process.env.VERDICT_RUNS_DIR = options.runsRoot || path.join(root, 'runs');
        try {
          const code = verdict.record([issueId, word, reason, '--run', runId], () => {}, () => {});
          return code === 0 ? { ok: true, verdict: word } : { ok: false, error: `verdict exited ${code}` };
        } finally {
          if (old === undefined) delete process.env.VERDICT_RUNS_DIR;
          else process.env.VERDICT_RUNS_DIR = old;
        }
      },
    },
  };
}

function createProductionSupervisor(options = {}) {
  if (!options.project) throw new Error('proposal supervisor: project is required');
  if ((options.adapters || options.canonicalTarget !== undefined)
      && options.testingSentinel !== TESTING_SENTINEL) {
    throw new Error('proposal supervisor: test substitution requires the host testing capability');
  }
  const repoRoot = path.resolve(options.repoRoot || path.join(__dirname, '..'));
  const canonicalTarget = typeof options.canonicalTarget === 'function'
    ? options.canonicalTarget : LOCK.canonicalTarget;
  const project = canonicalTarget(options.project);
  const stateDir = path.resolve(options.stateDir
    || supervisorStateDirFor(project, process.env, canonicalTarget));
  if (inside(project, stateDir)) throw new Error('proposal supervisor: state must be outside the model-editable project');
  validateSnapshot(path.join(stateDir, 'proposal-supervisor.json'));
  const journal = path.join(stateDir, 'events.jsonl');
  fold(readJournal(journal));
  const adapters = options.adapters || productionAdapters(repoRoot, {
    configPath: options.configPath, supervisorId: options.supervisorId,
    operationStateRoot: path.join(stateDir, 'operations'), runsRoot: options.runsRoot,
    lease: options.lease, reclaim: options.reclaim,
  });
  const globalLimit = Number.isInteger(options.globalConcurrency) ? options.globalConcurrency : 2;
  const stageLimits = { specification: 1, preparation: 1, review: 1,
    ...(options.stageConcurrency || {}) };
  const pollMs = Math.max(1, Number(options.pollMs) || 1000);
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const wait = typeof options.wait === 'function' ? options.wait
    : ms => new Promise(resolve => setTimeout(resolve, ms));
  const availableTokens = typeof options.availableTokens === 'function'
    ? options.availableTokens : () => ({ input: null, output: null });
  const active = { global: 0, specification: 0, preparation: 0, review: 0 };
  let activeTick = null;
  let runPromise = null;
  let crashed = false;
  const state = () => fold(readJournal(journal));
  const append = (type, body = {}) => atomicAppend(journal, {
    sequence: readJournal(journal).length + 1, type,
    at: new Date(now()).toISOString(), ...body,
  });
  function stage(id, target) {
    const p = state().proposals.get(id);
    assertTransition(p && p.stage || null, target);
    append('stage', { proposalId: id, stage: target });
  }
  function advancePreparationStage(id, target) {
    const ordered = ['criticizing', 'authoring-tests', 'proving', 'freezing'];
    const current = state().proposals.get(id).stage;
    const from = ordered.indexOf(current);
    const to = ordered.indexOf(target);
    if (to < 0 || to <= from) return false;
    for (let index = from + 1; index <= to; index += 1) stage(id, ordered[index]);
    return true;
  }
  function crashAfter(name) {
    if (!crashed && options.crashAfter === name && CRASH_BOUNDARIES.has(name)) {
      crashed = true; throw new Error(`proposal supervisor: injected crash after ${name}`);
    }
  }
  // The planner lane an operator is actually being served by. Read from the adapter that
  // owns the launch, so a status line cannot claim a model the launch would not use.
  const specificationModel = () =>
    (adapters.specification && adapters.specification.model) || null;
  const batchId = id => `proposal-${id}`;
  const feedId = generation => `proposal-feed-${digest(project).slice(0, 20)}-${String(generation).padStart(6, '0')}`;

  async function submit(record) {
    if (state().closed) return { accepted: false, reason: 'intake is closed' };
    const verified = await adapters.kickoff.verify(record);
    let verifiedTarget = null;
    try { verifiedTarget = canonicalTarget(String(verified && verified.target || '')); } catch {}
    if (!verified || verified.id !== record.id || verified.hash !== record.hash
        || verifiedTarget !== project) {
      throw new Error('proposal supervisor: kickoff verification failed');
    }
    const current = state();
    if (current.closed) return { accepted: false, reason: 'intake is closed' };
    const prior = current.proposals.get(record.id);
    if (prior) return { accepted: prior.record.hash === record.hash, id: record.id, existing: true };
    append('proposal.submitted', { proposalId: record.id, record }); stage(record.id, 'queued');
    return { accepted: true, id: record.id };
  }

  function actionStage(kind) {
    if (kind === 'specify') return 'specification';
    if (kind.includes('preparation')) return 'preparation';
    if (kind === 'review') return 'review';
    return null;
  }
  function actions(current, attempted) {
    const rows = current.order.map(id => [id, current.proposals.get(id)]);
    const choose = (items, stageName) => items.filter(a => !attempted.has(a.key)).slice(0,
      Math.min(globalLimit, stageName ? stageLimits[stageName] : globalLimit));
    let found = rows.filter(([, p]) => p.stage === 'freezing' && p.preparationEvidence
      && !p.preparationSettled).map(([id]) => ({ kind: 'settle-preparation', id, key: `settle:${id}` }));
    if (found.length) return choose(found, 'preparation');
    // A terminal feed can never accept another proposal. Retire its grant first; the next
    // ready proposal will then receive the deterministic successor generation.
    if (current.feed && current.feed.completed) return [{ kind: 'settle-feed', key: 'settle-feed' }];
    found = rows.filter(([, p]) => p.stage === 'ready' && !p.feedId);
    if (!current.closed && found.length && !current.feedGrant) return [{ kind: 'grant-feed', key: 'grant-feed' }];
    if (!current.closed && found.length && current.feedGrant && !current.feed) return [{ kind: 'start-feed', key: 'start-feed' }];
    if (!current.closed && found.length && current.feed) return found.map(([id]) => ({ kind: 'assign', id, key: `assign:${id}` }));
    found = rows.filter(([, p]) => p.stage === 'publishing' && p.task && p.task.prUrl
      && (p.task.state === 'done' || p.task.outcome === 'done') && !p.review)
      .map(([id]) => ({ kind: 'review', id, key: `review:${id}` }));
    if (found.length) return choose(found, 'review');
    found = rows.filter(([, p]) => !current.closed
      && (p.stage === 'queued' || p.stage === 'specifying'
        || (p.stage === 'needs-input' && p.answer)))
      .map(([id]) => ({ kind: 'specify', id, key: 'specification-launch' }));
    if (found.length) return choose(found, 'specification');
    found = rows.filter(([, p]) => adapters.authority
      && typeof adapters.authority.grant === 'function'
      && !current.closed && p.stage === 'criticizing'
      && !p.preparationGrant).map(([id]) => ({ kind: 'grant-preparation', id, key: `prep-grant:${id}` }));
    if (found.length) return choose(found, 'preparation');
    found = rows.filter(([, p]) => !current.closed && p.stage === 'criticizing'
      && p.preparationGrant && !p.preparationOperation)
      .map(([id]) => ({ kind: 'start-preparation', id, key: 'preparation-launch' }));
    if (found.length) return choose(found, 'preparation');
    found = rows.filter(([, p]) => p.preparationOperation && !p.preparationEvidence
      && !['needs-input', 'failed', 'rejected'].includes(p.stage))
      .map(([id]) => ({ kind: 'poll-preparation', id, key: `prep-poll:${id}` }));
    if (found.length) return choose(found, 'preparation');
    if (current.closed) {
      found = rows.filter(([, p]) => p.preparationGrant && !p.preparationOperation
        && !p.preparationSettled).map(([id]) => ({ kind: 'release-preparation', id, key: `prep-release:${id}` }));
      if (found.length) return choose(found, 'preparation');
    }
    if (current.feed) return [{ kind: 'poll-feed', key: `poll-feed:${current.feed.id}` }];
    return [];
  }

  async function perform(action) {
    const current = state();
    const p = action.id ? current.proposals.get(action.id) : null;
    if (action.kind === 'specify') {
      if (p.stage !== 'specifying') stage(action.id, 'specifying');
      let result = p.specification;
      if (!p.specificationCompleted) {
        result = await adapters.specification.execute(p.record);
        append('specification.completed', { proposalId: action.id, result });
      }
      if (result && result.status === 'ready') { stage(action.id, 'criticizing'); crashAfter('beads-issue'); }
      else if (result && result.status === 'needs-input') stage(action.id, 'needs-input');
      else stage(action.id, 'failed');
      return true;
    }
    if (action.kind === 'grant-preparation') {
      const grant = await adapters.authority.grant({ scope: 'preparation', project,
        proposalId: action.id, issueId: p.specification.issueId, batchId: batchId(action.id) });
      if (!grant || grant.ok === false) throw new Error(grant && grant.error || 'preparation grant failed');
      append('preparation.granted', { proposalId: action.id, grant }); return true;
    }
    if (action.kind === 'start-preparation') {
      const answer = await adapters.operations.startPreparation({ project, proposalId: action.id,
        batchId: batchId(action.id), configPath: options.configPath,
        issues: [p.specification.issueId], grant: p.preparationGrant });
      append('preparation.started', { proposalId: action.id,
        operation: operationValue(answer, 'preparation') }); return true;
    }
    if (action.kind === 'poll-preparation') {
      const answer = await adapters.operations.status({ project, id: p.preparationOperation.id });
      if (!answer || !answer.ok || !answer.preparation) return false;
      const observed = answer.preparation;
      const projected = observed.stage;
      const advanced = advancePreparationStage(action.id, projected);
      append('preparation.observed', { proposalId: action.id, evidence: observed });
      if (answer.state === 'completed') {
        append('preparation.completed', { proposalId: action.id, evidence: observed });
        crashAfter('freeze');
      }
      return answer.state === 'completed' || advanced;
    }
    if (action.kind === 'settle-preparation' || action.kind === 'release-preparation') {
      const outcome = action.kind === 'release-preparation' ? 'released' : 'complete';
      const answer = await adapters.authority.settle(p.preparationGrant, outcome);
      if (!answer || answer.ok === false) throw new Error(answer && answer.error || 'preparation settlement failed');
      append('preparation.settled', { proposalId: action.id, outcome });
      if (outcome === 'complete') stage(action.id, 'ready');
      return true;
    }
    if (action.kind === 'grant-feed') {
      const grant = await adapters.authority.grant({ scope: 'implementation', project });
      if (!grant || grant.ok === false) throw new Error(grant && grant.error || 'implementation grant failed');
      const generation = current.feeds.length + 1;
      append('feed.granted', { grant, generation, operationId: feedId(generation) }); return true;
    }
    if (action.kind === 'start-feed') {
      const grantEvent = readJournal(journal).filter(event => event.type === 'feed.granted').at(-1);
      const answer = await adapters.operations.startImplementation({ project,
        operationId: grantEvent.operationId, configPath: options.configPath, grant: current.feedGrant });
      append('feed.started', { generation: grantEvent.generation,
        operation: operationValue(answer, 'implementation feed') }); return true;
    }
    if (action.kind === 'assign') {
      append('proposal.assigned', { proposalId: action.id, feedId: current.feed.id,
        runId: current.feed.runId || null }); stage(action.id, 'implementing'); return true;
    }
    if (action.kind === 'poll-feed') {
      const answer = await adapters.operations.status({ project, id: current.feed.id });
      if (!answer || !answer.ok || !answer.manifest || !Array.isArray(answer.manifest.tasks)) return false;
      let changed = false;
      for (const id of current.order) {
        const proposal = state().proposals.get(id);
        if (!proposal || proposal.feedId !== current.feed.id || !proposal.specification) continue;
        const task = answer.manifest.tasks.find(row => row && row.issueId === proposal.specification.issueId);
        if (!task || JSON.stringify(task) === JSON.stringify(proposal.task)) continue;
        if ((task.state === 'publishing' || task.state === 'done' || task.prUrl)
            && proposal.stage === 'implementing') stage(id, 'publishing');
        append('implementation.observed', { proposalId: id, task }); changed = true;
        if (task.prUrl) crashAfter('pr');
        if (task.branch) crashAfter('branch');
      }
      if (answer.state === 'completed') {
        append('feed.completed', { operationId: current.feed.id }); changed = true;
      }
      return changed;
    }
    if (action.kind === 'review') {
      const evidence = await adapters.review.evidence({ proposalId: action.id,
        issueId: p.specification.issueId, runId: p.runId, task: p.task });
      if (!evidence) return false;
      append('review.observed', { proposalId: action.id, evidence }); stage(action.id, 'review'); return true;
    }
    if (action.kind === 'settle-feed') {
      const answer = await adapters.authority.settle(current.feedGrant, 'complete');
      if (!answer || answer.ok === false) throw new Error(answer && answer.error || 'feed settlement failed');
      append('feed.settled', { operationId: current.feed.id }); return true;
    }
    return false;
  }
  async function runAction(action) {
    const bucket = actionStage(action.kind);
    active.global += 1; if (bucket) active[bucket] += 1;
    try { return await perform(action); }
    finally { active.global -= 1; if (bucket) active[bucket] -= 1; }
  }
  async function doTick() {
    await ingest();
    const attempted = new Set();
    for (let round = 0; round < 128; round += 1) {
      const batch = actions(state(), attempted).slice(0, globalLimit);
      if (!batch.length) break;
      const results = await Promise.all(batch.map(runAction));
      batch.forEach((action, i) => { if (!results[i]) attempted.add(action.key); });
      // A tick is one admission turn. Completing a delayed preparation worker does not
      // immediately consume the next queued slot in that same turn; this makes stage caps
      // observable and prevents a newly unblocked loop from draining the whole queue.
      if (batch.some(action => action.kind === 'start-preparation')) {
        attempted.add('preparation-launch');
      }
      if (batch.some(action => action.kind === 'specify')) {
        attempted.add('specification-launch');
      }
      if (!results.some(Boolean)) break;
    }
    return { ok: true };
  }
  function tick() {
    if (!activeTick) activeTick = doTick().finally(() => { activeTick = null; });
    return activeTick;
  }
  async function resume() { await tick(); return { ok: true, proposals: state().order.length }; }
  async function answer(id, response) {
    const p = state().proposals.get(id);
    if (!p || p.stage !== 'needs-input' || p.answer) return { ok: false, error: 'proposal is not awaiting input' };
    const result = await adapters.specification.answer({ proposalId: id,
      evidenceHash: response && response.evidenceHash, text: response && response.text });
    if (!result || !['answered', 'ready'].includes(result.status)) return { ok: false, error: 'answer was refused' };
    append('answer.accepted', { proposalId: id, answer: { evidenceHash: response.evidenceHash,
      text: response.text } }); return { ok: true };
  }
  async function decide(id, verdict, reason) {
    const p = state().proposals.get(id);
    if (!p || p.stage !== 'review' || !['merged', 'rejected'].includes(verdict) || !String(reason || '').trim()) {
      return { ok: false, error: 'a review proposal, merged|rejected verdict, and reason are required' };
    }
    if (p.verdict === verdict) return { ok: true, existing: true };
    const result = await adapters.review.decide({ proposalId: id,
      issueId: p.specification.issueId, runId: p.runId, verdict, reason });
    if (!result || result.ok === false) return result || { ok: false };
    append('review.decided', { proposalId: id, verdict, reason });
    if (verdict === 'rejected') stage(id, 'rejected');
    return { ok: true, verdict };
  }
  async function stop() {
    if (!state().closed) append('intake.closed');
    if (activeTick) await activeTick;
    const current = state();
    if (current.feed && !current.feed.stopRequested) {
      const result = await adapters.operations.stop({ project, id: current.feed.id });
      if (!result || result.ok === false) throw new Error(result && result.error || 'could not stop feed');
      append('feed.stop-requested', { evidence: result });
    }
    return { ok: true };
  }
  function drained(current) {
    return current.closed && !current.feed && active.global === 0
      && current.order.every(id => {
        const p = current.proposals.get(id);
        return !p.preparationGrant || p.preparationSettled;
      });
  }
  async function ingest() {
    if (state().closed || !adapters.kickoff.list) return;
    const records = await adapters.kickoff.list({ project });
    if (Array.isArray(records)) {
      for (const record of records) {
        if (!options.proposalId || record.id === options.proposalId) await submit(record);
      }
    }
  }
  function run() {
    if (runPromise) return runPromise;
    runPromise = (async () => {
      for (;;) {
        await ingest(); await tick();
        if (drained(state())) return { ok: true };
        await wait(pollMs);
      }
    })();
    return runPromise;
  }

  function proposalStatus(id, current) {
    const p = current.proposals.get(id);
    if (!p) return { found: false, proposalId: id };
    const result = p.specification || {};
    const receipt = result.receipt || {};
    const proposal = receipt.proposal || {};
    const fieldIntentRefs = proposal.fieldIntentRefs || receipt.fieldIntentRefs || {
      title: `${p.record.hash}#/title`, spec: `${receipt.specHash || ''}#/spec`,
      acceptanceCriteria: `${receipt.specHash || ''}#/acceptanceCriteria`,
    };
    const prep = p.preparationEvidence || p.preparationObserved || {};
    const task = p.task || {};
    const review = p.review || {};
    const firstActive = p.history.find(event => event.stage === 'specifying');
    const last = p.history.at(-1);
    const currentTime = now();
    const submitted = Date.parse(p.record.createdAt) || Date.parse(p.history[0] && p.history[0].at) || currentTime;
    const activeStart = firstActive ? Date.parse(firstActive.at) : null;
    const terminal = ['review', 'failed', 'rejected', 'needs-input'].includes(p.stage);
    const activeEnd = terminal && last ? Date.parse(last.at) : currentTime;
    const unfinished = current.order.filter(proposalId => {
      const row = current.proposals.get(proposalId);
      return row && !['review', 'failed', 'rejected'].includes(row.stage);
    });
    const queueIndex = unfinished.indexOf(id);
    const verdictValue = p.verdict || review.verdict || null;
    const question = result.status === 'needs-input'
      ? { text: result.question, evidenceHash: result.evidenceHash } : null;
    const nextAction = p.stage === 'needs-input' ? 'answer the concrete question'
      : p.stage === 'review' && verdictValue === 'pending' ? 'record review verdict'
        : ['failed', 'rejected'].includes(p.stage) ? 'inspect terminal evidence'
          : current.closed ? 'wait for owned work to settle' : `advance ${p.stage}`;
    return {
      proposalId: id, queuePosition: queueIndex < 0 ? null : queueIndex + 1,
      stage: p.stage, waitTimeMs: Math.max(0, (activeStart || currentTime) - submitted),
      activeTimeMs: activeStart ? Math.max(0, activeEnd - activeStart) : 0,
      attempts: Array.isArray(task.attempts) ? task.attempts : [],
      model: result.model || null, specificationModel: specificationModel(),
      tokens: result.tokens || null,
      availableTokens: availableTokens(), kickoffHash: p.record.hash,
      specHash: receipt.specHash || result.specHash || null,
      spec: result.status === 'ready' ? { ...proposal, kickoffHash: receipt.kickoffHash || p.record.hash,
        specHash: receipt.specHash || null, fieldIntentRefs } : null,
      question, issueId: result.issueId || receipt.issueId || null,
      testBrief: prep.testBrief || null,
      freezeReceipt: freezeReceiptOf(prep, result.issueId || receipt.issueId) || null,
      runId: p.runId || null, branch: task.branch || review.branch || null,
      prUrl: task.prUrl || review.prUrl || null,
      reviewItemId: review.reviewItemId || null, verdict: verdictValue,
      nextAction, history: p.history.slice(),
    };
  }
  async function status(id) {
    const current = state();
    if (id) return proposalStatus(id, current);
    return { project, closed: current.closed, drained: drained(current),
      specificationModel: specificationModel(),
      scheduler: { active: { ...active }, limits: { global: globalLimit, ...stageLimits } },
      proposals: current.order.map(proposalId => proposalStatus(proposalId, current)) };
  }
  return { submit, tick, resume, run, stop, answer, decide, status };
}

function openProjectSupervisor(options = {}) {
  const repoRoot = path.resolve(options.repoRoot || path.join(__dirname, '..'));
  const project = path.resolve(options.project || '');
  const authority = require('./supervisor');
  const acquired = authority.acquire(repoRoot, project,
    options.supervisorId || `proposal-supervisor-${process.pid}`, { reclaim: options.reclaim === true });
  if (!acquired.ok) return acquired;
  let closed = false;
  try {
    const supervisor = createProductionSupervisor({ ...options, repoRoot, project,
      stateDir: options.stateDir || supervisorStateDirFor(project), lease: acquired.lease });
    return { ...acquired, supervisor, async close() {
      if (closed) return { ok: true, existing: true };
      const remaining = authority.outstanding(project);
      if (remaining.length) return { ok: false, error: `${remaining.length} child grant(s) remain outstanding` };
      authority.release(repoRoot, project, acquired.lease); closed = true; return { ok: true };
    } };
  } catch (error) {
    authority.release(repoRoot, project, acquired.lease); throw error;
  }
}

function formatHumanStatus(status) {
  const rows = status && Array.isArray(status.proposals) ? status.proposals : [status];
  return rows.filter(Boolean).map(row => [
    `${row.proposalId} stage=${row.stage} queue=${row.queuePosition}`,
    `waitTimeMs=${row.waitTimeMs} activeTimeMs=${row.activeTimeMs}`,
    `attempts=${JSON.stringify(row.attempts)} model=${row.model} specificationModel=${row.specificationModel} tokens=${JSON.stringify(row.tokens)}`,
    `availableTokens=${JSON.stringify(row.availableTokens)} kickoffHash=${row.kickoffHash} specHash=${row.specHash}`,
    `issueId=${row.issueId} freezeReceipt=${row.freezeReceipt} runId=${row.runId}`,
    `branch=${row.branch} prUrl=${row.prUrl} reviewItemId=${row.reviewItemId} verdict=${row.verdict}`,
    `nextAction=${row.nextAction}`,
  ].join(' | ')).join('\n');
}

module.exports = { createProductionSupervisor, openProjectSupervisor, productionAdapters,
  formatHumanStatus, supervisorStateDirFor, TESTING_SENTINEL, STAGES };
