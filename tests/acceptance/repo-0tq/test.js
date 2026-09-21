// Frozen acceptance test — repo-0tq: the proposal-to-review conveyor.
//
// This suite extends, rather than replaces, repo-djf.5's production composition:
// runner/proposal-supervisor.js still owns createProductionSupervisor(options),
// productionAdapters(repoRoot, options), and the opaque TESTING_SENTINEL. The final
// supervisor adds durable append-only history, answer/review decisions, crash-safe
// identity observation, fair bounded scheduling, and equivalent JSON/human status.
//
// CRITERION PAIRING
// C1: two live ideas share one implementation feed and reach review once.
// C2: closed transition vocabulary, append-only history, failed/rejected terminals.
// C3: immutable intent provenance plus needs-input/answer resume.
// C4: restart at issue/freeze/branch/PR boundaries reuses durable evidence.
// C5: measured global/stage caps, implementation-first fairness, graceful stop.
// C6: complete status facts and equivalent human output.
'use strict';

const crypto = require('crypto');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..', '..');
const MODULE = path.join(REPO, 'runner', 'proposal-supervisor.js');
const CLI = path.join(REPO, 'scripts', 'proposal-supervisor.js');
const CONFIG = path.join(REPO, 'runner', 'config.js');
const AUTHORITY = path.join(REPO, 'runner', 'supervisor.js');
const LOCK = path.join(REPO, 'runner', 'lock.js');
const REQUIRED_STAGES = ['queued', 'specifying', 'criticizing', 'authoring-tests', 'proving',
  'freezing', 'ready', 'implementing', 'publishing', 'review', 'needs-input', 'failed', 'rejected'];
const MAINLINE = REQUIRED_STAGES.slice(0, 10);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-0tq-'));
const project = path.join(tmp, 'project');
fs.mkdirSync(project, { recursive: true });
const previousLockRoot = process.env.PIPELINE_GLOBAL_LOCK_DIR;
process.env.PIPELINE_GLOBAL_LOCK_DIR = path.join(tmp, 'host-locks');
let failed = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'ok' : 'FAIL'} - ${name}${ok || !detail ? '' : ` — ${detail}`}`);
  if (!ok) failed = 1;
}
function safeRequire(file) { try { return require(file); } catch { return null; } }
function sha(value) { return `sha256:${crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')}`; }
function once(items, value) { return items.filter(item => item === value).length === 1; }
function historyStages(status) { return (status && Array.isArray(status.history) ? status.history : []).filter(event => event.type === 'stage').map(event => event.stage); }
function prefix(before, after) { return JSON.stringify(after.slice(0, before.length)) === JSON.stringify(before); }
function waitFor(read, timeoutMs = 3000) {
  const until = Date.now() + timeoutMs;
  return new Promise(resolve => {
    const poll = () => {
      const value = read();
      if (value) return resolve(value);
      if (Date.now() >= until) return resolve(null);
      setTimeout(poll, 5);
    };
    poll();
  });
}

const api = safeRequire(MODULE);
const cliApi = safeRequire(CLI);
const configApi = safeRequire(CONFIG);
const authorityApi = safeRequire(AUTHORITY);
const lockApi = safeRequire(LOCK);
check('C1-C6 production supervisor exposes the final conveyor surface',
  api && typeof api.createProductionSupervisor === 'function'
    && typeof api.openProjectSupervisor === 'function'
    && typeof api.productionAdapters === 'function'
    && typeof api.formatHumanStatus === 'function'
    && typeof api.supervisorStateDirFor === 'function', api ? Object.keys(api).join(',') : 'module missing');

function kickoff(id, description = `intent for ${id}`) {
  const packet = { version: 'kickoff-intake/1', title: `idea ${id}`, description,
    constraints: ['preserve intent'], examples: [], nonGoals: [], priority: 2,
    relations: [], origin: null };
  const intent = JSON.stringify(packet);
  return Object.freeze({ version: 'kickoff-intake/1', id, target: project,
    hash: sha(intent), intent, createdAt: '2026-09-12T00:00:00.000Z' });
}
function ids(id) {
  return { issueId: `issue-${id}`, freezeReceipt: `freeze-${id}`,
    branch: `codex/${id}`, prUrl: `https://example.invalid/pull/${id}`,
    runId: 'run-shared', reviewItemId: `run-shared:${id}` };
}

function fixture(options = {}) {
  const calls = [];
  const specs = new Map();
  const answered = new Map();
  const preparations = new Map();
  const feedTasks = new Map();
  const decisions = new Map();
  const held = new Map();
  const active = { specification: 0, preparation: 0, review: 0 };
  const peaks = { specification: 0, preparation: 0, review: 0, global: 0 };
  let feed = null;
  let stopped = false;
  let stopRequested = false;
  const count = () => Object.values(active).reduce((sum, value) => sum + value, 0);
  const begin = stage => { active[stage] += 1; peaks[stage] = Math.max(peaks[stage], active[stage]); peaks.global = Math.max(peaks.global, count()); };
  const end = stage => { active[stage] -= 1; };
  const maybeHold = async stage => {
    if (!options.hold || !options.hold.has(stage)) return;
    await new Promise(resolve => {
      if (!held.has(stage)) held.set(stage, []);
      held.get(stage).push(resolve);
    });
  };
  const readySpec = record => {
    const identity = ids(record.id);
    const proposal = { status: 'ready', title: `spec ${record.id}`, spec: `build ${record.id}`,
      acceptanceCriteria: ['works'], designReferences: ['DESIGN.md#the-three-phases'],
      difficulty: 'hard', fieldIntentRefs: { title: `${record.hash}#/title`,
        spec: `${record.hash}#/description`, acceptanceCriteria: `${record.hash}#/constraints` } };
    return { status: 'ready', issueId: identity.issueId, model: 'gpt-fixture',
      tokens: { input: 21, output: 13 }, receipt: { kickoffHash: record.hash,
        specHash: sha(proposal), issueId: identity.issueId, proposal } };
  };
  const adapters = {
    kickoff: { verify: record => record, list: () => [] },
    specification: {
      async execute(record) {
        calls.push(`specification:${record.id}`); begin('specification');
        await maybeHold('specification');
        let result;
        if (options.needsInput === record.id && !answered.has(record.id)) {
          result = { status: 'needs-input', question: 'Which retention period should users receive?', evidenceHash: sha(`question:${record.id}`) };
        } else if (options.failSpecification === record.id) {
          result = { status: 'failed', error: 'fixture specification failure' };
        } else result = readySpec(record);
        specs.set(record.id, result); end('specification'); return result;
      },
      async answer(request) {
        calls.push(`answer:${request.proposalId}`);
        if (!request.text || request.evidenceHash !== sha(`question:${request.proposalId}`)) return { status: 'refused' };
        answered.set(request.proposalId, request); return { status: 'answered', proposalId: request.proposalId };
      },
    },
    authority: {
      grant(request) {
        const owner = request.proposalId || 'feed';
        calls.push(`grant:${owner}:${request.scope}`);
        return { ok: true, authority: { nonce: sha(`${owner}:${request.scope}`).slice(7, 55), scope: request.scope,
          target: project, batch: request.batch || null }, parentLease: { token: 'fixture-parent' } };
      },
      settle(nonce, result) { calls.push(`settle:${nonce}:${result}`); return { ok: true }; },
    },
    operations: {
      async startPreparation(request) {
        calls.push(`preparation:${request.proposalId}`); begin('preparation');
        await maybeHold('preparation'); end('preparation');
        if (!preparations.has(request.proposalId)) preparations.set(request.proposalId, { stage: 'criticizing' });
        return { ok: true, operation: { id: `preparation-${request.proposalId}`,
          batchId: `batch-${request.proposalId}`, state: 'running' } };
      },
      startImplementation(request) {
        calls.push('implementation-feed:start');
        if (!feed) feed = { id: request.operationId || 'implementation-feed', runId: 'run-shared' };
        return { ok: true, operation: { ...feed, state: 'running' } };
      },
      status(request) {
        if (request.id.startsWith('preparation-')) {
          const proposalId = request.id.slice('preparation-'.length);
          const state = preparations.get(proposalId) || { stage: 'criticizing' };
          const completed = state.stage === 'freezing' && state.complete === true;
          const spec = specs.get(proposalId);
          return { ok: true, id: request.id, state: completed ? 'completed' : 'running',
            preparation: { stage: state.stage, issueId: ids(proposalId).issueId,
              kickoffHash: spec && spec.receipt.kickoffHash,
              testBrief: { kickoffHash: spec && spec.receipt.kickoffHash,
                fieldIntentRefs: spec && spec.receipt.proposal.fieldIntentRefs },
              freezeReceipt: completed ? ids(proposalId).freezeReceipt : null } };
        }
        const tasks = [...feedTasks.entries()].map(([proposalId, task]) => ({
          issueId: ids(proposalId).issueId, state: task.state, outcome: task.state === 'done' ? 'done' : null,
          branch: task.branch || null, prUrl: task.prUrl || null,
          attempts: [{ attempt: 1, acceptance: task.state === 'done' ? 'pass' : null,
            regression: task.state === 'done' ? 'pass' : null }],
        }));
        return { ok: true, id: feed && feed.id, state: stopped ? 'completed' : 'running',
          runId: 'run-shared', manifest: { runId: 'run-shared', tasks,
            feed: { enabled: true, ending: stopped ? 'stopped' : null } } };
      },
      stop(request) {
        calls.push(`implementation-feed:stop:${request.id}`); stopRequested = true;
        if (!options.delayedStop) stopped = true;
        return { ok: true };
      },
    },
    review: {
      evidence({ proposalId, issueId, runId, task }) {
        calls.push(`review:${proposalId}`);
        if (!task.prUrl) return null;
        return { proposalId, issueId, runId, branch: task.branch, prUrl: task.prUrl,
          reviewItemId: ids(proposalId).reviewItemId, verdict: decisions.get(proposalId) || 'pending' };
      },
      decide({ proposalId, verdict, reason }) {
        calls.push(`decision:${proposalId}:${verdict}`);
        decisions.set(proposalId, verdict); return { ok: true, verdict, reason };
      },
    },
  };
  return {
    adapters, calls, active, peaks,
    setPreparation(id, stage, complete = false) { preparations.set(id, { stage, complete }); },
    setTask(id, state, evidence = {}) { feedTasks.set(id, { state, ...evidence }); },
    release(stage) { for (const resolve of held.get(stage) || []) resolve(); held.delete(stage); },
    feed: () => feed,
    stopRequested: () => stopRequested,
    completeStop() { stopped = true; },
  };
}

function create(fx, name, extra = {}) {
  return api.createProductionSupervisor({ repoRoot: REPO, project,
    stateDir: path.join(tmp, name), configPath: 'fixture.json',
    testingSentinel: api.TESTING_SENTINEL, adapters: fx.adapters,
    globalConcurrency: 2, stageConcurrency: { specification: 2, preparation: 2, review: 1 },
    availableTokens: () => ({ input: 1000, output: 500 }), ...extra });
}
async function tick(supervisor, turns = 1) { for (let i = 0; i < turns; i += 1) await supervisor.tick(); }
async function advancePreparation(supervisor, fx, record) {
  for (const stage of ['criticizing', 'authoring-tests', 'proving']) {
    fx.setPreparation(record.id, stage); await tick(supervisor);
  }
  fx.setPreparation(record.id, 'freezing', true); await tick(supervisor, 2);
}
async function advanceImplementation(supervisor, fx, record) {
  fx.setTask(record.id, 'implementing', { branch: ids(record.id).branch }); await tick(supervisor);
  fx.setTask(record.id, 'publishing', { branch: ids(record.id).branch }); await tick(supervisor);
  fx.setTask(record.id, 'done', { branch: ids(record.id).branch, prUrl: ids(record.id).prUrl }); await tick(supervisor, 2);
}

async function main() {
  if (!api) return;
  const source = fs.readFileSync(MODULE, 'utf8');
  const cliSource = fs.existsSync(CLI) ? fs.readFileSync(CLI, 'utf8') : '';
  const production = (() => { try { return api.productionAdapters(REPO, { project, configPath: 'fixture.json' }); } catch { return null; } })();
  check('C1 production composition reuses kickoff, specification, authority, one operation manager, and verdict evidence',
    production && production.kickoff && production.specification && production.authority
      && production.operations && production.review
      && typeof production.specification.answer === 'function'
      && typeof production.review.decide === 'function'
      && typeof production.operations.startImplementation === 'function',
    production ? Object.keys(production).join(',') : 'production adapters unavailable');
  check('C1 operator CLI runs the production supervisor continuously and leaves intake, answers, and verdicts to their canonical CLIs',
    /\bstart\b/.test(cliSource) && /\bresume\b/.test(cliSource) && /\bstop\b/.test(cliSource)
      && /\bstatus\b/.test(cliSource) && /openProjectSupervisor/.test(cliSource)
      && cliApi && typeof cliApi.runOwnedLoop === 'function'
      && /formatHumanStatus/.test(cliSource)
      && /kickoff\.js/.test(cliSource) && /specify-proposal\.js/.test(cliSource) && /verdict\.js/.test(cliSource));

  const configTemplate = JSON.parse(fs.readFileSync(path.join(REPO, 'run.config.example.json'), 'utf8'));
  const configDir = path.join(tmp, 'config');
  fs.mkdirSync(configDir, { recursive: true });
  const configPath = path.join(configDir, 'run.config.fixture.json');
  const validConfig = { ...configTemplate, targetRepoPath: project,
    targetRepoRemote: 'https://example.invalid/project.git', image: 'pipeline-fixture:local',
    supervisorGlobalConcurrency: 3,
    supervisorStageConcurrency: { specification: 2, preparation: 1, review: 1 } };
  fs.writeFileSync(configPath, `${JSON.stringify(validConfig, null, 2)}\n`);
  let loadedConfig = null;
  try { loadedConfig = configApi && configApi.loadConfig(configPath); } catch {}
  check('C5 run config validates and preserves the global and per-stage supervisor ceilings',
    loadedConfig && loadedConfig.supervisorGlobalConcurrency === 3
      && loadedConfig.supervisorStageConcurrency.specification === 2
      && loadedConfig.supervisorStageConcurrency.preparation === 1
      && loadedConfig.supervisorStageConcurrency.review === 1
      && /supervisorGlobalConcurrency/.test(cliSource) && /supervisorStageConcurrency/.test(cliSource));
  const invalidConfigs = [
    ['supervisorGlobalConcurrency', 0],
    ['supervisorGlobalConcurrency', 1.5],
    ['supervisorStageConcurrency', []],
    ['supervisorStageConcurrency', { specification: 0 }],
    ['supervisorStageConcurrency', { publishing: 1 }],
  ];
  check('C5 invalid supervisor ceilings are refused by field name before a supervisor starts',
    configApi && invalidConfigs.every(([field, value], index) => {
      const candidate = { ...validConfig, [field]: value };
      const file = path.join(configDir, `invalid-${index}.json`);
      fs.writeFileSync(file, `${JSON.stringify(candidate)}\n`);
      try { configApi.loadConfig(file); return false; }
      catch (error) { return String(error && error.message).includes(field); }
    }));

  const leaseFx = fixture();
  const opened = api.openProjectSupervisor({ repoRoot: REPO, project,
    stateDir: path.join(tmp, 'lease-owner'), configPath: 'fixture.json',
    supervisorId: 'proposal-supervisor-acceptance', testingSentinel: api.TESTING_SENTINEL,
    adapters: leaseFx.adapters });
  const competing = api.openProjectSupervisor({ repoRoot: REPO, project,
    stateDir: path.join(tmp, 'lease-competitor'), configPath: 'fixture.json',
    supervisorId: 'proposal-supervisor-competitor', testingSentinel: api.TESTING_SENTINEL,
    adapters: fixture().adapters });
  const realAdapters = opened && opened.ok
    ? api.productionAdapters(REPO, { project, configPath: 'fixture.json', lease: opened.lease }) : null;
  const realGrant = realAdapters && realAdapters.authority.grant({ scope: 'preparation',
    issueId: 'issue-lease-proof', batch: 'batch-lease-proof' });
  const realSettlement = realGrant && realGrant.ok
    ? realAdapters.authority.settle(realGrant.authority.nonce, { outcome: 'complete' }) : null;
  const settlementState = realGrant && realGrant.ok
    ? realAdapters.authority.settlementState(realGrant.authority.nonce) : null;
  const closedLease = opened && opened.ok ? await opened.close() : null;
  check('C1/C4 the production host acquires one real project lease and refuses a competing supervisor before work',
    opened && opened.ok && competing && competing.ok === false
      && competing.holder && competing.holder.id === 'proposal-supervisor-acceptance');
  check('C1/C4 real child grants carry batch, TTL, and the parent lease, can prove settlement, and release cleanly',
    realGrant && realGrant.ok && realGrant.authority.batch === 'batch-lease-proof'
      && Date.parse(realGrant.authority.expiresAt) > Date.now()
      && realGrant.parentLease && realGrant.parentLease.token === opened.lease.token
      && realSettlement && realSettlement.ok && settlementState && settlementState.ok
      && settlementState.settled === true && closedLease && closedLease.ok
      && authorityApi && authorityApi.leaseHolder(project) === null
      && authorityApi.outstanding(project).length === 0,
    JSON.stringify({ realGrant, realSettlement, settlementState, closedLease }));
  let closeAfterFailure = 0;
  let ownedLoopFailed = false;
  try {
    await cliApi.runOwnedLoop({
      supervisor: { resume() { throw new Error('planted resume failure'); } },
      close() { closeAfterFailure += 1; return { ok: true }; },
    }, false, 10);
  } catch { ownedLoopFailed = true; }
  check('C4 an operator-loop failure still releases its acquired project lease exactly once',
    ownedLoopFailed && closeAfterFailure === 1);

  const orphanScript = `const sup=require(${JSON.stringify(AUTHORITY)});`
    + `const held=sup.acquire(${JSON.stringify(REPO)},${JSON.stringify(project)},'dead-proposal-supervisor');`
    + `const grant=held.ok&&sup.grant(held.lease,{scope:'implementation',ttlMs:60000});`
    + `process.stdout.write(JSON.stringify({acquired:held.ok,granted:!!(grant&&grant.ok),nonce:grant&&grant.authority&&grant.authority.nonce}));`;
  const orphanChild = cp.spawnSync(process.execPath, ['-e', orphanScript], {
    encoding: 'utf8', env: { ...process.env, PIPELINE_GLOBAL_LOCK_DIR: path.join(tmp, 'host-locks') } });
  let orphan = null;
  try { orphan = JSON.parse(orphanChild.stdout); } catch {}
  const recovered = api.openProjectSupervisor({ repoRoot: REPO, project,
    stateDir: path.join(tmp, 'lease-recovery'), configPath: 'fixture.json',
    supervisorId: 'recovered-proposal-supervisor', reclaim: true,
    testingSentinel: api.TESTING_SENTINEL, adapters: fixture().adapters });
  const recoveredAdapters = recovered && recovered.ok
    ? api.productionAdapters(REPO, { project, configPath: 'fixture.json', lease: recovered.lease, reclaim: true }) : null;
  const beforeRecoveredSettlement = recoveredAdapters && orphan
    ? recoveredAdapters.authority.settlementState(orphan.nonce) : null;
  const recoveredSettlement = recoveredAdapters && orphan
    ? recoveredAdapters.authority.settle(orphan.nonce, { outcome: 'released' }) : null;
  const recoveredClose = recovered && recovered.ok ? await recovered.close() : null;
  check('C4 explicit resume reclaims a dead parent, preserves its grant evidence, and can settle only that observed grant',
    orphanChild.status === 0 && orphan && orphan.acquired && orphan.granted
      && recovered && recovered.ok && recovered.tookOver
      && recovered.previous && recovered.previous.outstanding.some(item => item.nonce === orphan.nonce)
      && beforeRecoveredSettlement && beforeRecoveredSettlement.ok
      && beforeRecoveredSettlement.settled === false
      && recoveredSettlement && recoveredSettlement.ok && recoveredClose && recoveredClose.ok
      && authorityApi.outstanding(project).length === 0
      && lockApi && !fs.existsSync(lockApi.lockPath(REPO, project)),
    JSON.stringify({ child: { status: orphanChild.status, stderr: orphanChild.stderr }, orphan,
      recovered, beforeRecoveredSettlement, recoveredSettlement, recoveredClose }));
  const hostStateRoot = path.join(tmp, 'host-state');
  const derivedState = api.supervisorStateDirFor(project, { PIPELINE_STATE_DIR: hostStateRoot });
  check('C4 supervisor recovery state is host-owned and the operator CLI uses that canonical resolver',
    path.resolve(derivedState).startsWith(path.resolve(hostStateRoot) + path.sep)
      && !path.resolve(derivedState).startsWith(path.resolve(project) + path.sep)
      && /supervisorStateDirFor/.test(cliSource)
      && !/path\.join\(cfg\.targetRepoPath\s*,\s*['\"]\.pipeline-supervisor/.test(cliSource));
  const unsafeFx = fixture();
  let unsafeStateRefused = false;
  try {
    api.createProductionSupervisor({ repoRoot: REPO, project,
      stateDir: path.join(project, '.pipeline-supervisor'), testingSentinel: api.TESTING_SENTINEL,
      adapters: unsafeFx.adapters });
  } catch { unsafeStateRefused = true; }
  check('C4 model-editable project paths are refused before any supervisor adapter can run',
    unsafeStateRefused && unsafeFx.calls.length === 0);
  check('C1 composition has one shared operation-manager feed rather than a proposal-local runner',
    /operation-manager/.test(source) && !/drainQueue\s*\(/.test(source)
      && !/startImplementation\s*\(\s*\{[^}]*proposalId/s.test(source));

  // C1: P2 arrives while P1 is implementing; one supervisor and one feed settle both.
  const fx = fixture();
  const supervisor = create(fx, 'e2e');
  const one = kickoff('kp-1111111111111111');
  const two = kickoff('kp-2222222222222222');
  await supervisor.submit(one); await tick(supervisor, 3); await advancePreparation(supervisor, fx, one);
  fx.setTask(one.id, 'implementing', { branch: ids(one.id).branch }); await tick(supervisor);
  const oneWhile = await supervisor.status(one.id);
  await supervisor.submit(two); await tick(supervisor, 3); await advancePreparation(supervisor, fx, two);
  const twoWhile = await supervisor.status(two.id);
  await advanceImplementation(supervisor, fx, one);
  await advanceImplementation(supervisor, fx, two);
  const oneReview = await supervisor.status(one.id);
  const twoReview = await supervisor.status(two.id);
  check('C1 proposal two enters the running conveyor while proposal one implements without supervisor restart',
    oneWhile.stage === 'implementing' && twoWhile && twoWhile.proposalId === two.id
      && twoWhile.kickoffHash === two.hash && twoWhile.stage !== 'review'
      && once(fx.calls, 'implementation-feed:start'), JSON.stringify({ oneWhile, twoWhile, calls: fx.calls }));
  check('C1 both ideas reach review with one controller-derived issue, freeze, branch, and PR identity each',
    oneReview.stage === 'review' && twoReview.stage === 'review'
      && oneReview.issueId === ids(one.id).issueId && twoReview.issueId === ids(two.id).issueId
      && oneReview.freezeReceipt === ids(one.id).freezeReceipt && twoReview.freezeReceipt === ids(two.id).freezeReceipt
      && oneReview.branch === ids(one.id).branch && twoReview.branch === ids(two.id).branch
      && oneReview.prUrl === ids(one.id).prUrl && twoReview.prUrl === ids(two.id).prUrl
      && once(fx.calls, `review:${one.id}`) && once(fx.calls, `review:${two.id}`),
    JSON.stringify({ oneReview, twoReview, calls: fx.calls }));

  // C2: mainline history is exact; rejected/failed are valid terminals; a planted invalid
  // transition in durable state is rejected before an adapter can run.
  check('C2 mainline history is append-only, complete, ordered, and timestamped',
    [oneReview, twoReview].every(status => JSON.stringify(historyStages(status)) === JSON.stringify(MAINLINE)
      && status.history.every(event => typeof event.at === 'string' && event.at.length > 0)),
    JSON.stringify({ one: historyStages(oneReview), two: historyStages(twoReview) }));
  const beforeReject = [...twoReview.history];
  const rejected = await supervisor.decide(two.id, 'rejected', 'does not meet the product bar');
  const afterReject = await supervisor.status(two.id);
  check('C2 review rejection appends one terminal event and records the decision once',
    rejected && rejected.ok && afterReject.stage === 'rejected'
      && prefix(beforeReject, afterReject.history) && historyStages(afterReject).at(-1) === 'rejected'
      && once(fx.calls, `decision:${two.id}:rejected`));
  const failFx = fixture({ failSpecification: 'kp-ffffffffffffffff' });
  const failSupervisor = create(failFx, 'failed');
  const doomed = kickoff('kp-ffffffffffffffff');
  await failSupervisor.submit(doomed); await tick(failSupervisor);
  const failedStatus = await failSupervisor.status(doomed.id);
  check('C2 controller failure appends the declared failed terminal without downstream effects',
    failedStatus.stage === 'failed' && historyStages(failedStatus).at(-1) === 'failed'
      && !failFx.calls.some(call => call.startsWith('preparation:') || call === 'implementation-feed:start'));
  const invalidDir = path.join(tmp, 'invalid');
  fs.mkdirSync(invalidDir, { recursive: true });
  fs.writeFileSync(path.join(invalidDir, 'proposal-supervisor.json'), JSON.stringify({ schema: 2,
    project, closed: false, feed: null, proposals: { [doomed.id]: { proposalId: doomed.id,
      kickoff: doomed, kickoffHash: doomed.hash, state: 'review', stage: 'review', submittedAt: new Date().toISOString(),
      history: [{ type: 'stage', stage: 'queued', at: new Date().toISOString() },
        { type: 'stage', stage: 'review', at: new Date().toISOString() }] } } }));
  const invalidFx = fixture();
  let invalidRefused = false;
  try { await create(invalidFx, 'invalid').resume(); } catch { invalidRefused = true; }
  check('C2 invalid durable transitions fail before any model, Beads, operation, or publication side effect',
    invalidRefused && invalidFx.calls.length === 0, JSON.stringify(invalidFx.calls));
  check('C2 the transition vocabulary is closed over every required observable state',
    REQUIRED_STAGES.every(stage => source.includes(`'${stage}'`) || source.includes(`\"${stage}\"`)));

  // C3: needs-input is evidence linked and the answer adds history rather than rewriting it.
  const ambiguous = kickoff('kp-aaaaaaaaaaaaaaaa', 'choose a retention policy');
  const inputFx = fixture({ needsInput: ambiguous.id });
  const inputSupervisor = create(inputFx, 'needs-input');
  await inputSupervisor.submit(ambiguous); await tick(inputSupervisor);
  const waiting = await inputSupervisor.status(ambiguous.id);
  const beforeAnswer = [...waiting.history];
  const callsBeforeAnswer = [...inputFx.calls];
  const answer = await inputSupervisor.answer(ambiguous.id, { evidenceHash: sha(`question:${ambiguous.id}`), text: 'Retain for 30 days.' });
  await tick(inputSupervisor, 3); await advancePreparation(inputSupervisor, inputFx, ambiguous);
  await advanceImplementation(inputSupervisor, inputFx, ambiguous);
  const resumed = await inputSupervisor.status(ambiguous.id);
  check('C3 unmade product choice asks one concrete question and starts no implementation',
    waiting.stage === 'needs-input' && waiting.question && /\?$/.test(waiting.question.text)
      && waiting.question.evidenceHash === sha(`question:${ambiguous.id}`)
      && !callsBeforeAnswer.some(call => call.startsWith('preparation:') || call === 'implementation-feed:start'));
  check('C3 evidence-linked answer preserves prior history and resumes the same proposal through review',
    answer && answer.ok && prefix(beforeAnswer, resumed.history) && resumed.stage === 'review'
      && once(inputFx.calls, `answer:${ambiguous.id}`) && once(inputFx.calls, `specification:${ambiguous.id}`) === false,
    JSON.stringify({ calls: inputFx.calls, stages: historyStages(resumed) }));
  check('C3 spec receipt and preparation test brief retain kickoff hash and field-level intent references',
    resumed.spec && resumed.testBrief && resumed.spec.kickoffHash === ambiguous.hash
      && resumed.testBrief.kickoffHash === ambiguous.hash
      && Object.keys(resumed.spec.fieldIntentRefs || {}).length >= 3
      && JSON.stringify(resumed.spec.fieldIntentRefs) === JSON.stringify(resumed.testBrief.fieldIntentRefs),
    JSON.stringify({ spec: resumed.spec, testBrief: resumed.testBrief }));

  // C4: crash after each externally-created identity has been durably observed. The restarted
  // supervisor reuses that evidence and reaches review without a second creation call.
  for (const boundary of ['beads-issue', 'freeze', 'branch', 'pr']) {
    const id = `kp-${sha(boundary).slice(7, 23)}`;
    const record = kickoff(id);
    const crashFx = fixture();
    const first = create(crashFx, `crash-${boundary}`, { crashAfter: boundary });
    await first.submit(record);
    let crashed = false;
    try {
      await tick(first, 3);
      if (boundary !== 'beads-issue') await advancePreparation(first, crashFx, record);
      if (boundary === 'branch' || boundary === 'pr') {
        crashFx.setTask(record.id, boundary === 'branch' ? 'implementing' : 'publishing',
          { branch: ids(record.id).branch, ...(boundary === 'pr' ? { prUrl: ids(record.id).prUrl } : {}) });
        await tick(first, 2);
      }
    } catch { crashed = true; }
    const restarted = create(crashFx, `crash-${boundary}`);
    await restarted.resume();
    crashFx.setPreparation(record.id, 'freezing', true);
    crashFx.setTask(record.id, 'done', { branch: ids(record.id).branch, prUrl: ids(record.id).prUrl });
    await tick(restarted, 6);
    const status = await restarted.status(record.id);
    const call = boundary === 'beads-issue' ? `specification:${record.id}`
      : boundary === 'freeze' ? `preparation:${record.id}`
        : 'implementation-feed:start';
    const identityKey = boundary === 'beads-issue' ? 'issueId'
      : boundary === 'freeze' ? 'freezeReceipt' : boundary === 'pr' ? 'prUrl' : 'branch';
    check(`C4 restart after ${boundary} preserves one identity and reaches review`,
      crashed && status.stage === 'review' && status[identityKey] === ids(record.id)[identityKey]
        && once(crashFx.calls, call), JSON.stringify({ status, calls: crashFx.calls }));
  }

  // C5: use unresolved operations to measure real overlap. No configured peak may be clamped.
  const limitFx = fixture({ hold: new Set(['specification']) });
  const limitSupervisor = create(limitFx, 'limits', { globalConcurrency: 2,
    stageConcurrency: { specification: 2, preparation: 1, review: 1 } });
  for (const digit of ['3', '4', '5']) await limitSupervisor.submit(kickoff(`kp-${digit.repeat(16)}`));
  const limitTick = limitSupervisor.tick();
  const overlap = await waitFor(() => limitFx.active.specification === 2);
  const limitCalls = limitFx.calls.filter(call => call.startsWith('specification:'));
  check('C5 delayed calls measure the configured global and specification peaks without starting a third worker',
    overlap && limitFx.peaks.global === 2 && limitFx.peaks.specification === 2
      && limitCalls.some(call => call.endsWith('kp-3333333333333333'))
      && limitCalls.some(call => call.endsWith('kp-4444444444444444'))
      && !limitCalls.some(call => call.endsWith('kp-5555555555555555')),
    JSON.stringify({ active: limitFx.active, peaks: limitFx.peaks, calls: limitFx.calls }));
  limitFx.release('specification'); await limitTick;

  const prepFx = fixture({ hold: new Set(['specification', 'preparation']) });
  const prepSupervisor = create(prepFx, 'prep-limit', { globalConcurrency: 3,
    stageConcurrency: { specification: 3, preparation: 1, review: 1 } });
  for (const digit of ['6', '7', '8']) await prepSupervisor.submit(kickoff(`kp-${digit.repeat(16)}`));
  const prepTick = prepSupervisor.tick();
  await waitFor(() => prepFx.active.specification === 3);
  prepFx.release('specification');
  const prepOverlap = await waitFor(() => prepFx.active.preparation === 1);
  check('C5 delayed preparation proves its independent per-stage cap',
    prepOverlap && prepFx.peaks.preparation === 1
      && prepFx.calls.filter(call => call.startsWith('preparation:')).length === 1,
    JSON.stringify({ active: prepFx.active, peaks: prepFx.peaks, calls: prepFx.calls }));
  prepFx.release('preparation'); await prepTick;

  const fairFx = fixture();
  const fairSupervisor = create(fairFx, 'fair');
  const ready = kickoff('kp-9999999999999999');
  const newcomer = kickoff('kp-bbbbbbbbbbbbbbbb');
  await fairSupervisor.submit(ready); await tick(fairSupervisor, 2);
  fairFx.setPreparation(ready.id, 'freezing', true); await tick(fairSupervisor);
  await fairSupervisor.submit(newcomer); await tick(fairSupervisor);
  check('C5 ready implementation work starts before newly admitted specification work',
    fairFx.calls.indexOf('implementation-feed:start') >= 0
      && fairFx.calls.indexOf('implementation-feed:start') < fairFx.calls.indexOf(`specification:${newcomer.id}`),
    JSON.stringify(fairFx.calls));

  const stopFx = fixture({ hold: new Set(['specification']) });
  const stopSupervisor = create(stopFx, 'stop');
  await stopSupervisor.submit(kickoff('kp-cccccccccccccccc'));
  const ownedTick = stopSupervisor.tick();
  await waitFor(() => stopFx.active.specification === 1);
  const stopping = stopSupervisor.stop();
  const late = await stopSupervisor.submit(kickoff('kp-dddddddddddddddd'));
  check('C5 stop closes admission immediately while already-owned controller calls settle',
    late && late.accepted === false && stopFx.active.specification === 1);
  stopFx.release('specification'); await ownedTick; await stopping;
  const stopped = await stopSupervisor.status();
  check('C5 graceful stop leaves no owned work and drains the shared feed when present',
    stopped.closed === true && stopped.scheduler.active.global === 0
      && (!stopFx.feed() || stopFx.calls.some(call => call.startsWith('implementation-feed:stop:'))),
    JSON.stringify({ stopped, calls: stopFx.calls }));

  const drainFx = fixture({ delayedStop: true });
  const drainSupervisor = create(drainFx, 'drain');
  const draining = kickoff('kp-eeeeeeeeeeeeeeee');
  await drainSupervisor.submit(draining); await tick(drainSupervisor, 2);
  drainFx.setPreparation(draining.id, 'freezing', true); await tick(drainSupervisor, 2);
  const stopResult = await drainSupervisor.stop();
  let loopDone = false;
  const loop = cliApi && cliApi.runLoop(drainSupervisor, false, 10).then(() => { loopDone = true; });
  await new Promise(resolve => setTimeout(resolve, 30));
  const waitingForDrain = await drainSupervisor.status();
  drainFx.completeStop();
  if (loop) await loop;
  const drained = await drainSupervisor.status();
  check('C5 the operator loop keeps the lease alive after stop until the real shared feed drains',
    stopResult && stopResult.ok && drainFx.stopRequested()
      && waitingForDrain.closed === true && waitingForDrain.drained === false && loopDone === true
      && drained.drained === true,
    JSON.stringify({ waitingForDrain, drained, calls: drainFx.calls }));

  // C6: status comes from persisted controller evidence; formatting cannot omit a fact.
  const status = await supervisor.status();
  const facts = ['queuePosition', 'stage', 'waitTimeMs', 'activeTimeMs', 'attempts', 'model',
    'tokens', 'availableTokens', 'kickoffHash', 'specHash', 'issueId', 'freezeReceipt',
    'runId', 'branch', 'prUrl', 'reviewItemId', 'verdict', 'nextAction', 'history'];
  check('C6 JSON status reports every required operational fact for every proposal',
    status && Array.isArray(status.proposals)
      && [one.id, two.id].every(id => status.proposals.some(item => item.proposalId === id
        && facts.every(key => Object.prototype.hasOwnProperty.call(item, key)))),
    JSON.stringify(status));
  const human = api.formatHumanStatus(status);
  check('C6 human status exposes the same identities, state, timing, model, tokens, and smallest next action',
    typeof human === 'string' && status.proposals.every(item => [item.proposalId, item.stage,
      item.waitTimeMs, item.activeTimeMs, item.model, item.issueId, item.prUrl, item.nextAction,
      item.availableTokens.input, item.availableTokens.output].every(value => human.includes(String(value)))), human);

  const merged = await supervisor.decide(one.id, 'merged', 'approved by reviewer');
  const mergedStatus = await supervisor.status(one.id);
  check('C1/C2 review approval records the canonical merged verdict exactly once without fabricating a new identity',
    merged && merged.ok && mergedStatus.verdict === 'merged' && mergedStatus.stage === 'review'
      && mergedStatus.prUrl === oneReview.prUrl && once(fx.calls, `decision:${one.id}:merged`));
}

const watchdog = setTimeout(() => {
  check('C1-C6 fixture completes', false, 'timed out with an unresolved controller operation');
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  process.exit(1);
}, 15000);
main().catch(error => check('C1-C6 fixture completes', false, error && error.stack || String(error)))
  .then(() => {
    clearTimeout(watchdog);
    if (previousLockRoot === undefined) delete process.env.PIPELINE_GLOBAL_LOCK_DIR;
    else process.env.PIPELINE_GLOBAL_LOCK_DIR = previousLockRoot;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    process.exit(failed);
  });
