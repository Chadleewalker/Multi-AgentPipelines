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
const CONTROL = require('./control-plane');
const PR_OUTCOMES = new Set(CONTROL.publication.prEligibleOutcomes);
const TASK_OUTCOMES = new Set(CONTROL.outcomes.taskStatuses);

function hasPr(task) {
  if (!task || typeof task.prUrl !== 'string' || !task.prUrl.trim()) return false;
  try { return ['http:', 'https:'].includes(new URL(task.prUrl).protocol); }
  catch { return false; }
}

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

// The consumer of `preparation-state.deriveState`: a proposal's stage follows its OWN issue's
// per-issue state, never a synthetic top-level `preparation.stage` the operation manager does
// not produce (§3.10). Only these three states move the proposal forward; every other state —
// pending, an adverse worker outcome, interrupted, absent or unavailable — holds the last valid
// nonterminal stage and is surfaced for recovery instead.
const STATE_TO_STAGE = {
  authoring: 'authoring-tests',
  proving: 'proving',
  'proven-at-base': 'freezing',
};
// Issue states that mean preparation is still working. Publication is observed only once the
// issue has left this set, so an in-flight proof does not trigger integration fetches.
const IN_PROGRESS = new Set(['pending', 'authoring', 'proving']);
// The per-issue state of THIS proposal's own issue, or the two out-of-band answers a supervisor
// must be able to give: `unavailable` when the durable record cannot be read, `absent` when the
// batch manifest never carried this issue at all.
function issueStateFrom(evidence, issueId) {
  if (!evidence || evidence.ok === false || !Array.isArray(evidence.issues)) return 'unavailable';
  const row = evidence.issues.find(item => item && item.id === issueId);
  return row ? row.state : 'absent';
}

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
    if (event.type === 'intake.opened') { result.closed = false; continue; }
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
    else if (event.type === 'preparation.observed') {
      p.preparationObserved = { evidence: event.evidence,
        operationState: event.operationState === undefined ? null : event.operationState,
        attention: event.attention === undefined ? null : event.attention };
    }
    else if (event.type === 'preparation.completed') p.preparationEvidence = event.evidence;
    else if (event.type === 'preparation.settled') p.preparationSettled = true;
    else if (event.type === 'publication.observed') p.publication = event.evidence;
    else if (event.type === 'proposal.assigned') {
      p.feedId = event.feedId; p.runId = event.runId || null;
    } else if (event.type === 'implementation.observed') {
      if (event.task) p.task = event.task;
      if (event.implementation) p.implementation = event.implementation;
    }
    else if (event.type === 'review.observed') p.review = event.evidence;
    else if (event.type === 'review.attention') p.reviewAttention = event.attention;
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

// The production publication observer (§3.10). It asks the canonical freeze-admission gate —
// `runner/queue.js` `partitionByFreeze` — about ONE issue against the configured target, and
// reports its answer verbatim. It never parses a receipt, hashes a suite or resolves a branch
// a second time; the gate already did all three. Bound to the proposal's canonical target: a
// config whose path names a different repository, or whose fetch remote is not that path's own
// origin, is refused as unavailable rather than allowed to admit another repository's receipt.
function observePublication(configPath, request = {}) {
  const QUEUE = require('./queue');
  const CONFIG = require('./config');
  const IDENTITY = require('./repo-identity');
  const issueId = request.issueId;
  let target;
  try { target = LOCK.canonicalTarget(request.project); }
  catch (e) { return { ok: false, published: false, available: false, issueId,
    error: `publication observer: ${(e && e.message) || e}` }; }
  let cfg;
  try { cfg = CONFIG.loadConfig(configPath); }
  catch (e) { return { ok: false, published: false, available: false, target, issueId,
    error: `publication observer: cannot read the run config: ${(e && e.message) || e}` }; }
  // The configured target must be the proposal's own target — path and remote are independent
  // config keys the runner never relates, so binding the proposal to its canonical target path
  // is what keeps a target swap from letting repository B's receipt authorize A (§4.12).
  let configTarget = null;
  try { configTarget = LOCK.canonicalTarget(cfg.targetRepoPath); } catch { configTarget = null; }
  if (configTarget !== target) {
    return { ok: false, published: false, available: false, target, issueId,
      error: `publication observer: configured target ${configTarget || '(none)'} is not the proposal target ${target}` };
  }
  // The configured fetch remote must identify the same repository the target path fetches from.
  // Reuse the canonical repository-identity verifier rather than duplicating a stricter rule of
  // our own: it expands equivalent SSH/HTTPS locators to one identity and matches any named fetch
  // remote, exactly as the runner does when it admits this same configuration for dispatch. A
  // remote-only swap to a different repository still mismatches and is refused as unavailable.
  const identity = IDENTITY.verifyRepoIdentity(cfg);
  if (!identity.ok) {
    return { ok: false, published: false, available: false, target, issueId,
      error: `publication observer: ${identity.reason}` };
  }
  let answer;
  try { answer = QUEUE.partitionByFreeze(cfg, [{ id: issueId }]); }
  catch (e) { return { ok: false, published: false, available: false, target, issueId,
    error: `publication observer: ${(e && e.message) || e}` }; }
  if (!answer || answer.ok === false) {
    return { ok: false, published: false, available: false, target, issueId,
      error: (answer && answer.error) || 'publication observer: the freeze gate could not read the branch' };
  }
  const branch = answer.branch;
  const refused = (answer.undispatchable || []).find(row => row && row.issue && row.issue.id === issueId);
  if (refused) {
    return { ok: true, published: false, refusal: refused.refusal, reason: refused.reason,
      target, issueId, branch };
  }
  const row = (answer.admitted || []).find(entry => entry && entry.id === issueId);
  if (!row) {
    return { ok: false, published: false, available: false, target, issueId, branch,
      error: 'publication observer: the freeze gate neither admitted nor refused the issue' };
  }
  return { ok: true, published: true, target, issueId, branch,
    suiteHash: row.suiteHash, gateVersion: row.gateVersion, verdict: row.verdict };
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
      async observeAnswer(request) {
        const adapters = specify.productionAdapters({ configPath, proposalId: request.proposalId });
        return specify.observeAnswer(request, adapters);
      },
    },
    authority: {
      acquire({ project }) { return parent(project); },
      canReopen({ project }) {
        const holder = authorityApi.leaseHolder(project);
        if (!lease || !holder || !holder.live || holder.pid !== process.pid || holder.id !== lease.id) {
          return { ok: false, error: 'reopening requires the current owning supervisor' };
        }
        if (authorityApi.outstanding(project).length) {
          return { ok: false, error: 'unsettled child authority prevents reopening' };
        }
        return { ok: true };
      },
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
    publication: {
      observe(request) { return observePublication(configPath, request); },
    },
    review: {
      evidence({ proposalId, issueId, runId, task }) {
        if (!task || !task.prUrl) return null;
        const runsRoot = options.runsRoot || path.join(root, 'runs');
        const runs = verdict.readRuns(runsRoot).filter(row => row.runId === runId);
        const run = runs.length === 1 ? runs[0] : null;
        if (!run || !run.tasks.some(row => row.issueId === issueId && row.prUrl === task.prUrl)) {
          return { ok: false, error: 'review run/issue/PR evidence is unavailable or mismatched' };
        }
        const file = path.join(run.dir, 'tasks', issueId, 'verdict.json');
        let recorded = null;
        try { recorded = JSON.parse(fs.readFileSync(file, 'utf8')); }
        catch (error) {
          if (error.code !== 'ENOENT') return { ok: false, error: 'review verdict evidence is unreadable' };
        }
        if (recorded && (recorded.issueId !== issueId || recorded.runId !== runId
            || recorded.prUrl !== task.prUrl || !['merged', 'rejected'].includes(recorded.verdict)
            || typeof recorded.reason !== 'string' || !recorded.reason.trim())) {
          return { ok: false, error: 'review verdict evidence is malformed or mismatched' };
        }
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
    if (kind === 'specify' || kind === 'poll-answer') return 'specification';
    if (kind.includes('preparation')) return 'preparation';
    if (kind === 'review') return 'review';
    return null;
  }
  function actions(current, attempted) {
    const rows = current.order.map(id => [id, current.proposals.get(id)]);
    // Every category is chosen only from its un-attempted candidates, capped by its stage
    // ceiling. A category that has candidates but they are all attempted this tick FALLS THROUGH
    // to the next category rather than ending the tick — so a small preparation cap cannot stop
    // an implementation feed from being polled, and vice versa.
    const pick = (items, stageName) => items.filter(a => !attempted.has(a.key)).slice(0,
      Math.min(globalLimit, stageName ? stageLimits[stageName] : globalLimit));
    // A terminal feed can never accept another proposal. Retire its grant first; the next
    // ready proposal will then receive the deterministic successor generation.
    if (current.feed && current.feed.completed && !attempted.has('settle-feed')) {
      return [{ kind: 'settle-feed', key: 'settle-feed' }];
    }
    // A proposal assigned to the feed but not yet transitioned (a crash between the durable
    // assignment and the `implementing` stage) only needs its stage completed, once.
    let chosen = pick(rows.filter(([, p]) => p.stage === 'ready' && p.feedId)
      .map(([id]) => ({ kind: 'mark-implementing', id, key: `impl:${id}` })));
    if (chosen.length) return chosen;
    const ready = rows.filter(([, p]) => p.stage === 'ready' && !p.feedId);
    if (!current.closed && ready.length && !current.feedGrant && !attempted.has('grant-feed')) {
      return [{ kind: 'grant-feed', key: 'grant-feed' }];
    }
    if (!current.closed && ready.length && current.feedGrant && !current.feed && !attempted.has('start-feed')) {
      return [{ kind: 'start-feed', key: 'start-feed' }];
    }
    if (!current.closed && ready.length && current.feed) {
      chosen = pick(ready.map(([id]) => ({ kind: 'assign', id, key: `assign:${id}` })));
      if (chosen.length) return chosen;
    }
    chosen = pick(rows.filter(([, p]) => p.task && p.task.prUrl
      && ((p.stage === 'publishing' && PR_OUTCOMES.has(p.task.outcome) && hasPr(p.task))
        || ['review', 'rejected'].includes(p.stage)))
      .map(([id]) => ({ kind: 'review', id, key: `review:${id}` })), 'review');
    if (chosen.length) return chosen;
    chosen = pick(rows.filter(([, p]) => !current.closed && p.stage === 'needs-input' && !p.answer
      && adapters.specification && typeof adapters.specification.observeAnswer === 'function')
      .map(([id]) => ({ kind: 'poll-answer', id, key: `answer:${id}` })), 'specification');
    if (chosen.length) return chosen;
    chosen = pick(rows.filter(([, p]) => !current.closed
      && (p.stage === 'queued' || p.stage === 'specifying'
        || (p.stage === 'needs-input' && p.answer)))
      .map(([id]) => ({ kind: 'specify', id, key: 'specification-launch' })), 'specification');
    if (chosen.length) return chosen;
    chosen = pick(rows.filter(([, p]) => adapters.authority
      && typeof adapters.authority.grant === 'function'
      && !current.closed && p.stage === 'criticizing'
      && !p.preparationGrant).map(([id]) => ({ kind: 'grant-preparation', id, key: `prep-grant:${id}` })), 'preparation');
    if (chosen.length) return chosen;
    chosen = pick(rows.filter(([, p]) => !current.closed && p.stage === 'criticizing'
      && p.preparationGrant && !p.preparationOperation)
      .map(([id]) => ({ kind: 'start-preparation', id, key: 'preparation-launch' })), 'preparation');
    if (chosen.length) return chosen;
    // Observe the real preparation record and the published freeze while the proposal is being
    // prepared or is waiting at `freezing`. The consumer reads the per-issue state, never a
    // synthetic top-level stage, so a completion event advances the proposal instead of
    // stranding it at `criticizing`.
    chosen = pick(rows.filter(([, p]) => p.preparationOperation
      && ['criticizing', 'authoring-tests', 'proving', 'freezing'].includes(p.stage))
      .map(([id]) => ({ kind: 'poll-preparation', id, key: `prep-poll:${id}` })), 'preparation');
    if (chosen.length) return chosen;
    if (current.closed) {
      chosen = pick(rows.filter(([, p]) => p.preparationGrant && !p.preparationOperation
        && !p.preparationSettled).map(([id]) => ({ kind: 'release-preparation', id, key: `prep-release:${id}` })), 'preparation');
      if (chosen.length) return chosen;
    }
    if (current.feed && !attempted.has(`poll-feed:${current.feed.id}`)) {
      return [{ kind: 'poll-feed', key: `poll-feed:${current.feed.id}` }];
    }
    return [];
  }

  async function perform(action) {
    const current = state();
    const p = action.id ? current.proposals.get(action.id) : null;
    if (action.kind === 'poll-answer') {
      let observed;
      try {
        observed = await adapters.specification.observeAnswer({ proposalId: action.id,
          evidenceHash: p.specification && p.specification.evidenceHash });
      } catch { return false; }
      if (!observed || observed.status !== 'answered' || observed.proposalId !== action.id
          || observed.kickoffHash !== p.record.hash || !observed.answer
          || observed.answer.evidenceHash !== p.specification.evidenceHash) return false;
      append('answer.accepted', { proposalId: action.id, answer: observed.answer });
      return true;
    }
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
      const issueId = p.specification && p.specification.issueId;
      const answer = await adapters.operations.status({ project, id: p.preparationOperation.id });
      let evidence = null;
      let operationState = null;
      let attention = null;
      let issueState;
      if (!answer || answer.ok === false || !answer.preparation) {
        operationState = 'unavailable';
        attention = (answer && answer.error) || 'preparation status is unavailable';
        issueState = 'unavailable';
      } else {
        evidence = answer.preparation;
        operationState = answer.state || null;
        attention = answer.attention || null;
        issueState = issueStateFrom(evidence, issueId);
      }
      let changed = false;
      // Record the observation only when the evidence actually moved, so a settled proposal
      // waiting for publication does not append an identical line every tick.
      const prior = state().proposals.get(action.id).preparationObserved;
      const seen = { evidence, operationState, attention };
      const priorSeen = prior
        ? { evidence: prior.evidence, operationState: prior.operationState, attention: prior.attention }
        : null;
      if (!priorSeen || JSON.stringify(priorSeen) !== JSON.stringify(seen)) {
        append('preparation.observed', { proposalId: action.id, ...seen });
        changed = true;
      }
      // The proposal's stage follows its own issue's per-issue state (§3.10). Adverse and
      // interrupted states are not in the forward map and hold the last valid nonterminal stage.
      const targetStage = STATE_TO_STAGE[issueState];
      if (targetStage && advancePreparationStage(action.id, targetStage)) changed = true;
      // A successfully completed operation is settled by the operation manager itself during the
      // status read above; the supervisor records completion and acknowledges the settlement once.
      if (operationState === 'completed') {
        if (!state().proposals.get(action.id).preparationEvidence) {
          append('preparation.completed', { proposalId: action.id, evidence });
          crashAfter('freeze'); changed = true;
        }
        if (!state().proposals.get(action.id).preparationSettled) {
          append('preparation.settled', { proposalId: action.id, outcome: 'complete' });
          changed = true;
        }
      }
      // Observe the published freeze once the issue has left preparation — including when it is
      // stuck absent, unavailable or adverse, so status can report the publication it is not using.
      if (!IN_PROGRESS.has(issueState) && adapters.publication
          && typeof adapters.publication.observe === 'function') {
        const publication = await adapters.publication.observe({ project, issueId });
        const priorPub = state().proposals.get(action.id).publication;
        if (!priorPub || JSON.stringify(priorPub) !== JSON.stringify(publication)) {
          append('publication.observed', { proposalId: action.id, evidence: publication });
          changed = true;
        }
        // Only a valid published freeze, over a genuinely proven and settled preparation, admits
        // the proposal into the shared implementation feed. The publication line is fsynced before
        // the readiness it implies, so a crash between them leaves the freeze durable and readiness
        // to be re-derived, never a half-made assignment.
        const after = state().proposals.get(action.id);
        if (after.stage === 'freezing' && publication && publication.published === true
            && operationState === 'completed' && issueState === 'proven-at-base'
            && after.preparationSettled) {
          stage(action.id, 'ready'); changed = true;
        }
      }
      return changed;
    }
    if (action.kind === 'release-preparation') {
      const answer = await adapters.authority.settle(p.preparationGrant, 'released');
      if (!answer || answer.ok === false) throw new Error(answer && answer.error || 'preparation settlement failed');
      append('preparation.settled', { proposalId: action.id, outcome: 'released' });
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
    if (action.kind === 'mark-implementing') {
      // The durable assignment already exists (a crash interrupted the pair). Complete only the
      // stage transition it implies; never a second assignment or feed.
      if (p.stage === 'ready') stage(action.id, 'implementing');
      return true;
    }
    if (action.kind === 'poll-feed' || action.kind === 'assign') {
      // Assignment needs a fresh operation read of its own. An earlier healthy poll
      // can become stale while specification/preparation advances another proposal.
      // Observe a completed predecessor before binding any newly ready work to it.
      let answer;
      try { answer = await adapters.operations.status({ project, id: current.feed.id }); }
      catch (error) { answer = { ok: false, error: error.message }; }
      const identity = answer && answer.ok && answer.id === current.feed.id
        && answer.project === project && answer.runId === current.feed.runId;
      const manifest = identity && answer.manifest;
      const validManifest = manifest && manifest.runId === current.feed.runId
        && Array.isArray(manifest.tasks) && (manifest.finishedAt == null
          || (typeof manifest.finishedAt === 'string' && Number.isFinite(Date.parse(manifest.finishedAt))));
      const finished = validManifest && typeof manifest.finishedAt === 'string';
      const settled = identity && answer.state === 'completed'
        && answer.settlement && answer.settlement.state === 'complete';
      const completed = settled && finished;
      let feedAttention = null;
      if (!identity) feedAttention = answer && answer.error || 'implementation operation identity is unavailable or mismatched';
      else if (answer.state === 'attention') feedAttention = answer.attention || 'implementation operation requires explicit recovery';
      else if (!['running', 'completed'].includes(answer.state)) feedAttention = 'implementation operation state is unavailable';
      else if (manifest && !validManifest) feedAttention = 'implementation manifest is malformed or mismatched';
      else if (answer.state === 'completed' && !finished) feedAttention = 'completed implementation manifest is unavailable or unfinished';
      else if (answer.state === 'completed' && !settled) feedAttention = 'implementation authority is not settled; inspect the operation before recovery';
      let changed = false;
      // The child consumes the canonical ready queue independently of this journal.
      // It may finish while the parent is delayed before assignment. Bind its exact
      // issue rows before retirement, preserving even ambiguous rows for inspection.
      // Ready issues absent from that manifest remain eligible for a successor.
      if (completed) {
        for (const id of current.order) {
          const proposal = state().proposals.get(id);
          if (proposal.stage !== 'ready' || proposal.feedId || !proposal.specification
              || !manifest.tasks.some(row => row && row.issueId === proposal.specification.issueId)) continue;
          append('proposal.assigned', { proposalId: id, feedId: current.feed.id, runId: current.feed.runId });
          stage(id, 'implementing'); changed = true;
        }
      }
      for (const id of current.order) {
        const proposal = state().proposals.get(id);
        if (!proposal || proposal.feedId !== current.feed.id || !proposal.specification) continue;
        const matches = validManifest ? manifest.tasks.filter(row => row
          && row.issueId === proposal.specification.issueId) : [];
        const task = matches.length === 1 ? matches[0] : null;
        const outcome = completed && task && TASK_OUTCOMES.has(task.outcome) ? task.outcome : null;
        let attention = feedAttention;
        if (completed && matches.length !== 1) attention = matches.length
          ? 'completed implementation has duplicate issue rows; inspect the retained manifest'
          : 'completed implementation has no row for this assigned issue; inspect the retained manifest';
        else if (completed && !outcome) attention = 'completed implementation outcome is unavailable or unknown';
        else if (outcome && PR_OUTCOMES.has(outcome) && !hasPr(task)) {
          attention = 'completed implementation has no valid PR evidence; inspect publication evidence';
        }
        const implementation = {
          operationId: current.feed.id, runId: current.feed.runId, issueId: proposal.specification.issueId,
          operationState: identity ? answer.state : 'unavailable', settled: !!settled,
          outcome, reason: task && (task.reason || task.error || task.refusal || task.stuckState
            || (Array.isArray(task.attemptNotes)
              ? task.attemptNotes.filter(note => typeof note === 'string' && note.trim()).join('\n') : null)) || null,
          attention, task: completed && task ? task : null,
        };
        if (JSON.stringify(implementation) !== JSON.stringify(proposal.implementation)) {
          append('implementation.observed', { proposalId: id, implementation,
            task: completed && task ? task : null }); changed = true;
        }
        // Observe first, then derive the transition on every tick. A crash between these
        // writes cannot leave a permanently stranded proposal with unchanged task bytes.
        if (outcome && PR_OUTCOMES.has(outcome) && hasPr(task) && proposal.stage === 'implementing') {
          stage(id, 'publishing'); changed = true;
        } else if (outcome && !PR_OUTCOMES.has(outcome)
            && ['implementing', 'publishing'].includes(proposal.stage)) {
          stage(id, 'failed'); changed = true;
        }
        if (completed && task && task.prUrl) crashAfter('pr');
        if (completed && task && task.branch) crashAfter('branch');
      }
      if (completed && !state().feed.completed) {
        append('feed.completed', { operationId: current.feed.id }); changed = true;
      }
      if (action.kind === 'assign' && identity && answer.state === 'running'
          && !feedAttention && !finished && !state().feed.completed
          && !state().proposals.get(action.id).feedId) {
        append('proposal.assigned', { proposalId: action.id, feedId: current.feed.id,
          runId: current.feed.runId });
        stage(action.id, 'implementing'); changed = true;
      }
      return changed;
    }
    if (action.kind === 'review') {
      const observed = await reviewObservation(action.id, p);
      let changed = false;
      if (observed.attention !== (p.reviewAttention || null)) {
        append('review.attention', { proposalId: action.id, attention: observed.attention }); changed = true;
      }
      if (observed.evidence && JSON.stringify(observed.evidence) !== JSON.stringify(p.review)) {
        append('review.observed', { proposalId: action.id, evidence: observed.evidence }); changed = true;
      }
      if (observed.evidence) {
        if (p.stage === 'publishing') { stage(action.id, 'review'); changed = true; }
        if (!p.verdict && ['merged', 'rejected'].includes(observed.evidence.verdict)) {
          append('review.decided', { proposalId: action.id, verdict: observed.evidence.verdict,
            reason: observed.evidence.evidence.reason }); changed = true;
        }
      }
      // Recover a crash after a durable decision even if its source is now unavailable.
      const decided = state().proposals.get(action.id);
      if (decided.verdict === 'rejected' && decided.stage === 'review') {
        stage(action.id, 'rejected'); changed = true;
      }
      return changed;
    }
    if (action.kind === 'settle-feed') {
      // The operation manager alone settles a launched child's grant. Completed was
      // recorded only after its exact operation reported successful settlement.
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
    // Bounded generously by the number of proposals: every candidate is either progressed or
    // marked attempted, so the loop terminates when `actions` runs dry. The cap is only a
    // backstop against a logic error, never the normal exit — a no-progress round does NOT end
    // the tick, so a stage cap smaller than the queue still visits every waiting proposal
    // across rounds rather than starving the ones past the cap.
    const maxRounds = Math.max(256, state().order.length * 8);
    for (let round = 0; round < maxRounds; round += 1) {
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
    if (p.verdict) return { ok: false, error: 'a different review disposition is already accepted' };
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
    return current.closed && !current.feed && !current.feedGrant && active.global === 0
      && current.order.every(id => {
        const p = current.proposals.get(id);
        return !p.preparationGrant || p.preparationSettled;
      });
  }
  function reopen() {
    const current = state();
    if (!current.closed) return { ok: true, existing: true };
    if (!drained(current)) return { ok: false, error: 'the previous stop is still draining' };
    if (!adapters.authority || typeof adapters.authority.canReopen !== 'function') {
      return { ok: false, error: 'current owning authority is unavailable' };
    }
    const admission = adapters.authority.canReopen({ project });
    if (!admission || !admission.ok) return admission || { ok: false };
    append('intake.opened');
    return { ok: true };
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

  async function reviewObservation(id, p) {
    let evidence;
    try {
      evidence = await adapters.review.evidence({ proposalId: id,
        issueId: p.specification.issueId, runId: p.runId, task: p.task });
    } catch (error) {
      return { evidence: null, attention: `review evidence unavailable: ${error.message}` };
    }
    if (!evidence || evidence.ok === false) {
      return { evidence: null, attention: evidence && evidence.error || 'review evidence unavailable' };
    }
    // A disappearing record cannot erase an already witnessed decision. Keep the last
    // valid evidence and report that its canonical source is currently unavailable.
    if (p.verdict && evidence.verdict === 'pending') {
      return { evidence: null, attention: 'accepted review evidence is currently unavailable' };
    }
    const conflict = p.verdict && evidence.verdict !== p.verdict;
    return { evidence, attention: conflict
      ? `review evidence conflict: accepted ${p.verdict}; canonical record now says ${evidence.verdict}` : null };
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
    const obs = p.preparationObserved || null;
    const prepEvidence = p.preparationEvidence
      || (obs && obs.evidence) || {};
    const issueId = result.issueId || receipt.issueId
      || (p.specification && p.specification.issueId) || null;
    const publication = p.publication || null;
    // The preparation summary a person and the scheduler both read: the operation's own id and
    // batch, this proposal's exact issue, that issue's per-issue `deriveState` state, the
    // operation manager's own state and its attention sentence.
    let preparation = null;
    if (p.preparationOperation) {
      const prepIssueState = obs
        ? issueStateFrom(obs.evidence, issueId)
        : (p.preparationEvidence ? issueStateFrom(p.preparationEvidence, issueId) : 'pending');
      preparation = {
        operationId: p.preparationOperation.id,
        batchId: p.preparationOperation.batchId || p.preparationOperation.id,
        issueId: issueId || null,
        state: prepIssueState,
        operationState: obs ? obs.operationState
          : (p.preparationEvidence ? 'completed' : 'running'),
        attention: obs ? (obs.attention || null) : null,
      };
    }
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
    const ADVERSE_PREPARATION = new Set(['unproven', 'agent-failed', 'usage-limit',
      'interrupted-unknown', 'unavailable', 'absent']);
    let nextAction;
    if (p.stage === 'needs-input') nextAction = 'answer the concrete question';
    else if (p.reviewAttention) nextAction = `inspect ${p.reviewAttention}`;
    else if (p.implementation && p.implementation.attention) nextAction = `inspect ${p.implementation.attention}`;
    else if (p.stage === 'review' && verdictValue === 'pending') nextAction = 'record review verdict';
    else if (p.stage === 'failed' && p.implementation && p.implementation.outcome) {
      nextAction = `inspect ${p.implementation.outcome} evidence and explicitly authorize any recovery`;
    } else if (['failed', 'rejected'].includes(p.stage)) nextAction = 'inspect terminal evidence';
    else if (p.implementation && p.implementation.operationState === 'running') nextAction = 'wait for the owned implementation child to finish';
    else if (preparation && preparation.operationState === 'attention') {
      nextAction = 'inspect the preparation operation attention and recover it before the conveyor can proceed';
    } else if (preparation && ADVERSE_PREPARATION.has(preparation.state)) {
      nextAction = `inspect the ${preparation.state} preparation evidence and re-prove the suite after an authorized recovery`;
    } else if (p.stage === 'freezing') {
      nextAction = 'have a person approve and publish the frozen acceptance suite and its receipt to the integration branch';
    } else if (current.closed) nextAction = 'wait for owned work to settle';
    else nextAction = `advance ${p.stage}`;
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
      question, issueId,
      testBrief: prepEvidence.testBrief || null,
      // A published freeze is the only receipt production trusts; a preparation payload that
      // merely claims one never becomes the freeze (§3.10, criterion 6). Null until publication.
      freezeReceipt: publication && publication.published === true ? publication.suiteHash : null,
      preparation, publication, implementation: p.implementation || null,
      runId: p.runId || null, branch: task.branch || review.branch || null,
      prUrl: task.prUrl || review.prUrl || null,
      reviewItemId: review.reviewItemId || null, verdict: verdictValue,
      verdictReason: review.evidence && review.verdict === verdictValue
        ? review.evidence.reason : p.verdictReason || null,
      reviewEvidence: review.evidence || null, reviewAttention: p.reviewAttention || null,
      nextAction, history: p.history.slice(),
    };
  }
  async function status(id) {
    const current = state();
    // Status is a read-only projection. Only the owning tick appends decisions, but a
    // separate operator session can immediately see the canonical command's result.
    for (const proposalId of (id ? [id] : current.order)) {
      const p = current.proposals.get(proposalId);
      if (!p || !p.review || !['review', 'rejected'].includes(p.stage)) continue;
      const observed = await reviewObservation(proposalId, p);
      p.reviewAttention = observed.attention;
      if (observed.evidence) {
        p.review = observed.evidence;
        if (!p.verdict && ['merged', 'rejected'].includes(observed.evidence.verdict)) {
          p.verdict = observed.evidence.verdict;
          p.verdictReason = observed.evidence.evidence.reason;
        }
      }
      if (p.verdict === 'rejected') p.stage = 'rejected';
    }
    if (id) return proposalStatus(id, current);
    return { project, closed: current.closed, drained: drained(current),
      specificationModel: specificationModel(),
      scheduler: { active: { ...active }, limits: { global: globalLimit, ...stageLimits } },
      proposals: current.order.map(proposalId => proposalStatus(proposalId, current)) };
  }
  return { submit, tick, resume, run, stop, answer, decide, status, reopen };
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
    // Only explicit operator starts may reopen a completed stop. A resume of an
    // interrupted drain still observes/settles its existing children with intake closed.
    if (options.reopen === true) supervisor.reopen();
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
    row.implementation ? `outcome=${row.implementation.outcome || '(not terminal)'} operationState=${row.implementation.operationState}`
      + ` reason=${JSON.stringify(row.implementation.reason)} attention=${row.implementation.attention || ''}` : '',
    `verdictReason=${row.verdictReason || ''} reviewAttention=${row.reviewAttention || ''}`,
    row.reviewEvidence ? `canonicalVerdict=${row.reviewEvidence.verdict} canonicalReason=${row.reviewEvidence.reason}` : '',
    `nextAction=${row.nextAction}`,
  ].join(' | ')).join('\n');
}

module.exports = { createProductionSupervisor, openProjectSupervisor, productionAdapters,
  formatHumanStatus, supervisorStateDirFor, TESTING_SENTINEL, STAGES };
