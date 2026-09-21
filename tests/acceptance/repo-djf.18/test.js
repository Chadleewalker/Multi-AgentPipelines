// Frozen acceptance test — repo-djf.18: one unattended supervisor, rotating feeds.
//
// Pairing (criterion -> tests): C1 -> T1.1-T1.7; C2 -> T2.1-T2.3;
// C3 -> T3.1-T3.7 plus guard.js G3.1-G3.2; C4 -> T4.1-T4.5 plus
// guard.js G4.1. Every assertion below carries its criterion and test id.
//
// Frozen lifecycle interface: createProductionSupervisor(options) retains the repo-djf.5
// submit/tick/resume/stop/status surface and adds run(). run() is the production, long-lived
// promise: it keeps scheduling until a durable stop request has drained owned operations and
// released the one parent lease. Deterministic adapters remain protected by TESTING_SENTINEL;
// with that capability, pollMs/now/wait are the clock seam used here without wall-clock sleep.
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..', '..');
const MODULE = path.join(REPO, 'runner', 'proposal-supervisor.js');
const CLI = path.join(REPO, 'scripts', 'proposal-supervisor.js');
const POLL_MS = 25;
let failed = 0;
function check(name, yes, detail = '') {
  console.log(`${yes ? 'ok' : 'FAIL'} - ${name}${yes ? '' : ` — ${detail}`}`);
  if (!yes) failed = 1;
}
const safeRequire = file => { try { return require(file); } catch { return null; } };
const once = (items, value) => items.filter(item => item === value).length === 1;
const flush = async (turns = 30) => {
  for (let i = 0; i < turns; i += 1) await Promise.resolve();
};

function deterministicClock() {
  let instant = 0;
  const sleepers = [];
  const waits = [];
  return {
    now: () => instant,
    wait(ms) {
      waits.push(ms);
      return new Promise(resolve => sleepers.push({ due: instant + ms, resolve }));
    },
    async advance(ms) {
      instant += ms;
      const due = sleepers.filter(item => item.due <= instant);
      for (const item of due) sleepers.splice(sleepers.indexOf(item), 1);
      due.forEach(item => item.resolve());
      await flush();
    },
    waits: () => waits.slice(),
    pending: () => sleepers.length,
    instant: () => instant,
  };
}

async function drive(clock, predicate, label, steps = 120) {
  for (let i = 0; i < steps; i += 1) {
    await flush();
    if (await predicate()) return true;
    await clock.advance(POLL_MS);
  }
  check(label, false, `condition not reached after ${steps} deterministic polls`);
  return false;
}

function record(project, digit) {
  const id = `kp-${digit.repeat(16)}`;
  const packet = { version: 'kickoff-intake/1', title: `idea ${digit}`,
    description: `intent ${digit}`, constraints: [], examples: [], nonGoals: [],
    priority: 2, relations: [], origin: null };
  const intent = JSON.stringify(packet);
  return Object.freeze({ version: 'kickoff-intake/1', id, target: project, intent,
    hash: `sha256:${crypto.createHash('sha256').update(intent).digest('hex')}`,
    createdAt: '2026-09-13T00:00:00.000Z' });
}

const identity = proposalId => ({
  issueId: `issue-${proposalId}`,
  specHash: `sha256:${crypto.createHash('sha256').update(`spec-${proposalId}`).digest('hex')}`,
  freezeReceipt: `freeze-${proposalId}`,
  branch: `pipeline/${proposalId}`,
  prUrl: `https://example.invalid/pull/${proposalId}`,
  reviewItemId: `review-${proposalId}`,
});

function processFixture(project, options = {}) {
  const calls = [];
  const specificationResolvers = new Map();
  const preparations = new Map();
  const feeds = [];
  const reviewReady = new Set();
  const outstanding = new Map();
  const releases = [];
  const completedFreezeReturns = new Map();
  const completedTaskReturns = new Map();
  const parentLease = Object.freeze({ id: 'fixture-parent', token: 'only-parent-lease' });
  let grantNumber = 0;
  let operationPolls = 0;
  let forbiddenRecoveryCalls = 0;

  const specResult = proposalId => ({ status: 'ready', issueId: identity(proposalId).issueId,
    receipt: { specHash: identity(proposalId).specHash }, model: 'fixture-model',
    tokens: { input: 11, output: 7 } });
  function grantFor(request) {
    grantNumber += 1;
    const nonce = `grant-${grantNumber}-${request.proposalId || `feed-${feeds.length + 1}`}`;
    const value = { authority: { nonce, scope: request.scope, target: project }, parentLease };
    outstanding.set(nonce, { value, state: 'granted' });
    calls.push(`grant:${request.scope}:${request.proposalId || 'feed'}:${nonce}`);
    return value;
  }
  function settleOperation(operation) {
    const nonce = operation && operation.grant && operation.grant.authority.nonce;
    if (nonce) outstanding.delete(nonce);
  }
  const adapters = {
    kickoff: { verify: value => value, list: () => [] },
    specification: {
      execute(value) {
        calls.push(`specification:${value.id}`);
        if (options.holdSpecification === value.id) {
          return new Promise(resolve => specificationResolvers.set(value.id,
            () => resolve(specResult(value.id))));
        }
        return specResult(value.id);
      },
    },
    authority: {
      grant: grantFor,
      settle(request, outcome) {
        const grant = request && request.authority ? request : request && request.grant;
        const resolution = outcome || (request && request.outcome) || 'released';
        calls.push(`settle:${grant && grant.authority && grant.authority.nonce}:${resolution}`);
        if (grant && grant.authority) outstanding.delete(grant.authority.nonce);
        return { ok: true };
      },
      release(value) {
        const lease = value && value.parentLease ? value.parentLease : value;
        releases.push({ lease, outstanding: [...outstanding.keys()] });
        calls.push(`release:${lease && lease.token}`);
        return lease === parentLease && outstanding.size === 0
          ? { ok: true } : { ok: false, error: 'wrong parent lease or unsettled child' };
      },
    },
    operations: {
      startPreparation(request) {
        calls.push(`preparation:${request.proposalId}`);
        const operation = { id: `preparation-${request.proposalId}`, proposalId: request.proposalId,
          state: 'running', grant: request.grant };
        preparations.set(operation.id, operation);
        return { ok: true, operation: { id: operation.id, state: operation.state } };
      },
      startImplementation(request) {
        const generation = feeds.length + 1;
        const feed = { id: request.operationId, runId: `run-${generation}`, state: 'running',
          grant: request.grant, tasks: [] };
        feeds.push(feed);
        calls.push(`implementation:${feed.id}:${feed.runId}`);
        return { ok: true, operation: { id: feed.id, runId: feed.runId, state: feed.state } };
      },
      status(request) {
        operationPolls += 1;
        const preparation = preparations.get(request.id);
        if (preparation) {
          if (preparation.state === 'completed') {
            settleOperation(preparation);
            completedFreezeReturns.set(preparation.proposalId,
              (completedFreezeReturns.get(preparation.proposalId) || 0) + 1);
          }
          return { ok: true, id: preparation.id, state: preparation.state,
            ...(preparation.state === 'completed' ? { preparation: {
              issueId: identity(preparation.proposalId).issueId,
              freezeReceipt: identity(preparation.proposalId).freezeReceipt,
            } } : {}),
            ...(preparation.state === 'attention' ? { attention: 'explicit recovery required' } : {}) };
        }
        const feed = feeds.find(item => item.id === request.id);
        if (!feed) return { ok: false, error: `unknown operation ${request.id}` };
        if (feed.state === 'completed') {
          settleOperation(feed);
          for (const task of feed.tasks) completedTaskReturns.set(task.proposalId,
            (completedTaskReturns.get(task.proposalId) || 0) + 1);
        }
        return { ok: true, id: feed.id, state: feed.state, runId: feed.runId,
          manifest: { runId: feed.runId, tasks: feed.tasks.map(task => ({
            issueId: identity(task.proposalId).issueId, outcome: 'done',
            branch: identity(task.proposalId).branch, prUrl: identity(task.proposalId).prUrl,
            attempts: [{ attempt: 1, acceptance: 'pass', regression: 'pass' }],
          })), feed: { enabled: true, ending: feed.state === 'completed' ? 'drained' : null } } };
      },
      stop(request) {
        calls.push(`stop:${request.id}`);
        const feed = feeds.find(item => item.id === request.id);
        if (feed) feed.stopRequested = true;
        return { ok: true, id: request.id };
      },
      retry() { forbiddenRecoveryCalls += 1; return { ok: false }; },
      recoverLaunch() { forbiddenRecoveryCalls += 1; return { ok: false }; },
      reconcile() { forbiddenRecoveryCalls += 1; return { ok: false }; },
    },
    review: {
      evidence({ proposalId, issueId, runId, task }) {
        calls.push(`review-poll:${proposalId}`);
        if (!reviewReady.has(proposalId)) return null;
        calls.push(`review-ready:${proposalId}`);
        return { reviewItemId: identity(proposalId).reviewItemId, issueId, runId,
          branch: task.branch, prUrl: task.prUrl, verdict: 'pending' };
      },
    },
  };
  return {
    adapters, calls, feeds, releases, parentLease,
    releaseSpecification(id) {
      const resolve = specificationResolvers.get(id);
      if (resolve) { specificationResolvers.delete(id); resolve(); }
    },
    completePreparation(id) {
      const operation = preparations.get(`preparation-${id}`);
      if (operation) operation.state = 'completed';
    },
    attentionPreparation(id) {
      const operation = preparations.get(`preparation-${id}`);
      if (operation) operation.state = 'attention';
    },
    explicitlyRecoverPreparation(id) {
      calls.push(`operator-recover:${id}`);
      const operation = preparations.get(`preparation-${id}`);
      if (operation) operation.state = 'completed';
    },
    finishFeed(index, proposalIds) {
      const feed = feeds[index];
      if (feed) { feed.tasks = proposalIds.map(proposalId => ({ proposalId })); feed.state = 'completed'; }
    },
    allowReview(id) { reviewReady.add(id); },
    preparationStarted: id => preparations.has(`preparation-${id}`),
    operationPolls: () => operationPolls,
    outstanding: () => [...outstanding.keys()],
    forbiddenRecoveryCalls: () => forbiddenRecoveryCalls,
    freezeReturns: id => completedFreezeReturns.get(id) || 0,
    taskReturns: id => completedTaskReturns.get(id) || 0,
  };
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-djf18-'));
const api = safeRequire(MODULE);
const surface = api && typeof api.createProductionSupervisor === 'function';
check('C1.1 T1.1 production supervisor exports the long-lived run lifecycle',
  surface && typeof api.TESTING_SENTINEL !== 'undefined',
  api ? Object.keys(api).join(',') : 'runner/proposal-supervisor.js is missing');

async function main() {
  if (!surface) return;
  const cliSource = (() => { try { return fs.readFileSync(CLI, 'utf8'); } catch { return ''; } })();
  check('C1.1 T1.2 the production CLI run command awaits the unattended run loop instead of one resume/tick',
    /await\s+supervisor\.run\s*\(\s*\)/.test(cliSource), cliSource.slice(0, 1200));

  const real = (() => { try { return api.productionAdapters(REPO, { configPath: 'fixture.json' }); }
    catch { return null; } })();
  check('C3.1 T3.1 production authority adapters can settle a grant and release their exact parent lease',
    real && real.authority && typeof real.authority.grant === 'function'
      && typeof real.authority.settle === 'function' && typeof real.authority.release === 'function',
    real && real.authority ? Object.keys(real.authority).join(',') : 'authority adapter unavailable');

  // C1/C2/C4: one run promise crosses every pending stage and two feed generations.
  const project = path.join(tmp, 'project-conveyor');
  fs.mkdirSync(project, { recursive: true });
  const one = record(project, '1');
  const two = record(project, '2');
  const clock = deterministicClock();
  const fx = processFixture(project, { holdSpecification: one.id });
  const supervisor = api.createProductionSupervisor({ repoRoot: REPO, project,
    stateDir: path.join(tmp, 'state-conveyor'), configPath: 'fixture.json',
    testingSentinel: api.TESTING_SENTINEL, adapters: fx.adapters,
    pollMs: POLL_MS, now: clock.now, wait: clock.wait });
  const lifecycle = ['submit', 'tick', 'resume', 'run', 'stop', 'status'];
  check('C1.1 T1.3 run extends, rather than removes, the frozen repo-djf.5 lifecycle surface',
    lifecycle.every(name => typeof supervisor[name] === 'function'), Object.keys(supervisor).join(','));
  if (typeof supervisor.run !== 'function') return;

  await supervisor.submit(one);
  let runSettled = false;
  const running = supervisor.run().then(value => { runSettled = true; return value; });
  await flush();
  check('C1.2 T1.4 one run remains active while specification is genuinely pending without an operator tick',
    !runSettled && once(fx.calls, `specification:${one.id}`));
  fx.releaseSpecification(one.id);
  await drive(clock, () => fx.preparationStarted(one.id),
    'C1.2 T1.4 fixture reaches pending preparation');

  const pollsBeforeIdle = fx.operationPolls();
  await flush(80);
  const pollsWithoutTime = fx.operationPolls();
  await clock.advance(POLL_MS - 1);
  const pollsBeforeBoundary = fx.operationPolls();
  await clock.advance(1);
  const pollsAtBoundary = fx.operationPolls();
  check('C1.3 T1.5 pending preparation sleeps to the injected poll boundary and never busy-loops',
    !runSettled && pollsWithoutTime === pollsBeforeIdle && pollsBeforeBoundary === pollsBeforeIdle
      && pollsAtBoundary > pollsBeforeBoundary && pollsAtBoundary - pollsBeforeBoundary <= 1,
    JSON.stringify({ pollsBeforeIdle, pollsWithoutTime, pollsBeforeBoundary, pollsAtBoundary,
      waits: clock.waits() }));

  fx.completePreparation(one.id);
  await drive(clock, () => fx.feeds.length === 1,
    'C2.1 T2.1 first implementation feed starts');
  const firstFeed = fx.feeds[0];
  const submittedWhileImplementing = await supervisor.status(one.id);
  await supervisor.submit(two);
  await drive(clock, () => fx.preparationStarted(two.id),
    'C2.1 T2.1 proposal two reaches pending preparation');
  check('C1.4 T1.6 the same run accepts and advances proposal two while proposal one implements',
    !runSettled && submittedWhileImplementing.stage === 'implementing'
      && once(fx.calls, `specification:${two.id}`) && once(fx.calls, `preparation:${two.id}`),
    JSON.stringify({ submittedWhileImplementing, calls: fx.calls }));

  fx.finishFeed(0, [one.id]);
  await drive(clock, async () => (await supervisor.status(one.id)).branch === identity(one.id).branch,
    'C1.4 T1.7 implementation evidence is observed');
  const reviewPolls = fx.calls.filter(call => call === `review-poll:${one.id}`).length;
  await flush(80);
  check('C1.4 T1.7 the run remains active across pending implementation and review evidence',
    !runSettled && firstFeed.state === 'completed' && reviewPolls >= 1
      && !fx.calls.includes(`review-ready:${one.id}`));
  fx.allowReview(one.id);
  await drive(clock, async () => (await supervisor.status(one.id)).stage === 'review',
    'C2.1 T2.1 proposal one reaches review');

  fx.completePreparation(two.id);
  await drive(clock, () => fx.feeds.length === 2,
    'C2.2 T2.2 successor implementation feed starts');
  const secondFeed = fx.feeds[1];
  check('C2.2/C4.2 T2.2/T4.2 a drained feed rotates to one uniquely identified successor for later prepared work',
    firstFeed.id && secondFeed.id && firstFeed.id !== secondFeed.id
      && firstFeed.runId !== secondFeed.runId && !fx.feeds[2],
    JSON.stringify(fx.feeds.map(feed => ({ id: feed.id, runId: feed.runId }))));
  fx.finishFeed(1, [two.id]);
  fx.allowReview(two.id);
  await drive(clock, async () => (await supervisor.status(two.id)).stage === 'review',
    'C2.2 T2.2 proposal two reaches review through the same supervisor');

  const oneStatus = await supervisor.status(one.id);
  const twoStatus = await supervisor.status(two.id);
  const exact = (status, proposal, runId) => {
    const expected = identity(proposal.id);
    return status.issueId === expected.issueId && status.specHash === expected.specHash
      && status.freezeReceipt === expected.freezeReceipt && status.runId === runId
      && status.branch === expected.branch && status.prUrl === expected.prUrl
      && status.reviewItemId === expected.reviewItemId;
  };
  check('C2.3/C4.3 T2.3/T4.3 issue, freeze, feed, branch and PR identities come exactly once from controller evidence',
    exact(oneStatus, one, firstFeed.runId) && exact(twoStatus, two, secondFeed.runId)
      && [one, two].every(proposal => once(fx.calls, `specification:${proposal.id}`)
        && once(fx.calls, `preparation:${proposal.id}`)
        && once(fx.calls, `review-ready:${proposal.id}`)
        && fx.freezeReturns(proposal.id) === 1 && fx.taskReturns(proposal.id) === 1),
    JSON.stringify({ oneStatus, twoStatus, calls: fx.calls,
      freezeReturns: [fx.freezeReturns(one.id), fx.freezeReturns(two.id)],
      taskReturns: [fx.taskReturns(one.id), fx.taskReturns(two.id)] }));
  check('C4.1 T4.1 the deterministic clock bounds every idle wait and feed/process polling',
    clock.waits().length >= 4 && clock.waits().every(ms => Number.isFinite(ms) && ms >= POLL_MS)
      && fx.operationPolls() <= Math.ceil(clock.instant() / POLL_MS) + 12,
    JSON.stringify({ waits: clock.waits(), polls: fx.operationPolls(), now: clock.instant() }));

  const normalStop = supervisor.stop();
  await clock.advance(POLL_MS);
  await normalStop;
  await drive(clock, () => runSettled, 'C3.1 T3.1 normal conveyor stop settles');
  await running;
  check('C3.1 T3.2 a completed conveyor releases its exact parent lease once',
    fx.releases.length === 1 && fx.releases[0].lease === fx.parentLease
      && fx.releases[0].outstanding.length === 0, JSON.stringify(fx.releases));

  // C3: clean stop closes intake immediately, but waits for an already-owned child.
  const stopProject = path.join(tmp, 'project-stop');
  fs.mkdirSync(stopProject, { recursive: true });
  const owned = record(stopProject, '3');
  const late = record(stopProject, '4');
  const stopClock = deterministicClock();
  const stopFx = processFixture(stopProject);
  const stoppingSupervisor = api.createProductionSupervisor({ repoRoot: REPO, project: stopProject,
    stateDir: path.join(tmp, 'state-stop'), configPath: 'fixture.json',
    testingSentinel: api.TESTING_SENTINEL, adapters: stopFx.adapters,
    pollMs: POLL_MS, now: stopClock.now, wait: stopClock.wait });
  await stoppingSupervisor.submit(owned);
  let stopRunSettled = false;
  const stopRun = stoppingSupervisor.run().then(value => { stopRunSettled = true; return value; });
  await drive(stopClock, () => stopFx.preparationStarted(owned.id),
    'C3.1 T3.3 owned preparation starts');
  let stopSettled = false;
  const cleanStop = stoppingSupervisor.stop().then(value => { stopSettled = true; return value; });
  const refused = await stoppingSupervisor.submit(late);
  await flush(80);
  check('C3.1 T3.3 clean stop immediately rejects new intake and retains the lease while a child is owned',
    refused && refused.accepted === false && !stopSettled && !stopRunSettled
      && stopFx.releases.length === 0 && stopFx.outstanding().length === 1,
    JSON.stringify({ refused, releases: stopFx.releases, outstanding: stopFx.outstanding() }));
  stopFx.completePreparation(owned.id);
  await drive(stopClock, () => stopSettled && stopRunSettled,
    'C3.1 T3.3 clean stop drains owned preparation');
  await Promise.all([cleanStop, stopRun]);
  await stoppingSupervisor.stop();
  check('C3.1 T3.4 clean stop starts no successor work and releases exactly the parent lease',
    stopFx.feeds.length === 0 && stopFx.outstanding().length === 0
      && stopFx.releases.length === 1 && stopFx.releases[0].lease === stopFx.parentLease,
    JSON.stringify({ calls: stopFx.calls, releases: stopFx.releases }));

  // C3/C4: a crash after persisting an operation keeps its grant and never invents recovery.
  const crashProject = path.join(tmp, 'project-crash');
  fs.mkdirSync(crashProject, { recursive: true });
  const interrupted = record(crashProject, '5');
  const crashClock = deterministicClock();
  const crashFx = processFixture(crashProject);
  const crashState = path.join(tmp, 'state-crash');
  const first = api.createProductionSupervisor({ repoRoot: REPO, project: crashProject,
    stateDir: crashState, configPath: 'fixture.json', testingSentinel: api.TESTING_SENTINEL,
    adapters: crashFx.adapters, pollMs: POLL_MS, now: crashClock.now, wait: crashClock.wait,
    crashAfter: 'preparation' });
  await first.submit(interrupted);
  let crashError = null;
  first.run().catch(error => { crashError = error; });
  await drive(crashClock, () => !!crashError,
    'C3.2 T3.5 deterministic crash occurs after preparation persistence');
  crashFx.attentionPreparation(interrupted.id);
  const grantsBeforeResume = crashFx.calls.filter(call => call.startsWith('grant:')).slice();
  const startsBeforeResume = crashFx.calls.filter(call => call === `preparation:${interrupted.id}`).length;
  check('C3.2 T3.5 crash leaves the owned grant outstanding and does not release the parent lease',
    crashError && crashFx.outstanding().length === 1 && crashFx.releases.length === 0,
    JSON.stringify({ error: crashError && crashError.message, outstanding: crashFx.outstanding() }));

  const resumed = api.createProductionSupervisor({ repoRoot: REPO, project: crashProject,
    stateDir: crashState, configPath: 'fixture.json', testingSentinel: api.TESTING_SENTINEL,
    adapters: crashFx.adapters, pollMs: POLL_MS, now: crashClock.now, wait: crashClock.wait });
  let resumedSettled = false;
  const resumedRun = resumed.run().then(value => { resumedSettled = true; return value; });
  const pollsBeforeResume = crashFx.operationPolls();
  await drive(crashClock, () => crashFx.operationPolls() > pollsBeforeResume,
    'C3.2 T3.6 resumed supervisor observes the outstanding operation');
  await crashClock.advance(POLL_MS * 2);
  check('C3.2 T3.6 resume is idempotent and never invokes retry/recover/reconcile on the operator\'s behalf',
    !resumedSettled && JSON.stringify(grantsBeforeResume) === JSON.stringify(
      crashFx.calls.filter(call => call.startsWith('grant:')))
      && startsBeforeResume === crashFx.calls.filter(call => call === `preparation:${interrupted.id}`).length
      && crashFx.forbiddenRecoveryCalls() === 0 && crashFx.outstanding().length === 1,
    JSON.stringify({ calls: crashFx.calls, outstanding: crashFx.outstanding() }));

  let resumedStopSettled = false;
  const resumedStop = resumed.stop().then(value => { resumedStopSettled = true; return value; });
  await flush();
  check('C3.3 T3.7 stop cannot erase an attention operation or its grant',
    !resumedStopSettled && crashFx.outstanding().length === 1 && crashFx.releases.length === 0);
  crashFx.explicitlyRecoverPreparation(interrupted.id);
  await drive(crashClock, () => resumedStopSettled && resumedSettled,
    'C3.3 T3.7 explicit external recovery lets clean stop settle');
  await Promise.all([resumedStop, resumedRun]);
  check('C3.2/C4.4 T3.6/T4.4 restart preserves exactly-once grant/operation identity and releases once only after recovery',
    crashFx.calls.filter(call => call.startsWith('grant:')).length === grantsBeforeResume.length
      && crashFx.calls.filter(call => call === `preparation:${interrupted.id}`).length === 1
      && crashFx.calls.filter(call => call === `operator-recover:${interrupted.id}`).length === 1
      && crashFx.releases.length === 1 && crashFx.releases[0].outstanding.length === 0,
    JSON.stringify({ calls: crashFx.calls, releases: crashFx.releases }));
}

const watchdog = setTimeout(() => {
  check('C1-C4 T4.5 deterministic fixture completes', false, 'wall-clock watchdog expired');
  process.exit(1);
}, 15000);
main().catch(error => check('C1-C4 T4.5 deterministic fixture completes', false,
  (error && error.stack) || String(error))).then(() => {
  clearTimeout(watchdog);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  process.exit(failed);
});
