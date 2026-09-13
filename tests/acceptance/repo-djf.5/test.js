// Frozen acceptance test — repo-djf.5: compose the real idea-to-review controllers.
// C1 real composition; C2 one live feed with overlapping intake; C3 adapter authority;
// C4 crash-idempotent side effects; C5 measured ceilings/fairness; C6 stop/status evidence.
//
// THE FROZEN INTERFACE. runner/proposal-supervisor.js exports:
//   createProductionSupervisor(options) -> { submit, tick, resume, stop, status }
//   productionAdapters(repoRoot, options?) -> { kickoff, specification, authority,
//     operations, review }
//   TESTING_SENTINEL -> an opaque identity capability.
//
// `operations` is one runner/operation-manager.js instance. Preparation uses
// startPreparation/status; implementation uses startImplementation/status/stop. There is one
// project feed operation, not one process per proposal. Its durable run manifest is the only
// source of task, branch, PR and run identities. Adapter replacement is accepted only when
// testingSentinel is the exact in-process TESTING_SENTINEL object.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..', '..');
const MODULE = path.join(REPO, 'runner', 'proposal-supervisor.js');
const CLI = path.join(REPO, 'scripts', 'proposal-supervisor.js');
let failed = 0;
function check(name, yes, detail = '') {
  console.log(`${yes ? 'ok' : 'FAIL'} - ${name}${yes ? '' : ` — ${detail}`}`);
  if (!yes) failed = 1;
}
const safeRequire = file => { try { return require(file); } catch { return null; } };
const waitFor = async (fn, ms = 4000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const value = fn();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return null;
};
const once = (items, value) => items.includes(value) && items.indexOf(value) === items.lastIndexOf(value);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-djf5-'));
const project = path.join(tmp, 'project');
fs.mkdirSync(project, { recursive: true });
const api = safeRequire(MODULE);
check('C1-C6 proposal supervisor exports its production composition surface',
  api && typeof api.createProductionSupervisor === 'function'
    && typeof api.productionAdapters === 'function', api ? Object.keys(api).join(',') : 'module missing');

function kickoff(id) {
  const packet = { version: 'kickoff-intake/1', title: `idea ${id}`, description: `intent ${id}`,
    constraints: [], examples: [], nonGoals: [], priority: 2, relations: [], origin: null };
  const intent = JSON.stringify(packet);
  return Object.freeze({ version: 'kickoff-intake/1', id, target: project,
    hash: `sha256:${crypto.createHash('sha256').update(intent).digest('hex')}`,
    intent, createdAt: '2026-09-12T00:00:00.000Z' });
}
const identity = id => ({
  issueId: `issue-${id}`,
  specHash: `sha256:${crypto.createHash('sha256').update(`spec-${id}`).digest('hex')}`,
  freezeReceipt: `receipt-${id}`,
  branch: `pipeline/${id}`,
  prUrl: `https://example.invalid/pull/${id}`,
  reviewItemId: `review-${id}`,
});

function fixture(options = {}) {
  const calls = [];
  const preparations = new Map();
  const finished = new Map();
  const grants = [];
  const specWaiters = [];
  const preparationWaiters = [];
  let specActive = 0; let specPeak = 0;
  let prepActive = 0; let prepPeak = 0;
  let feed = null;
  let stopped = false;
  const finishSpec = record => ({ status: 'ready', issueId: identity(record.id).issueId,
    receipt: { kickoffHash: record.hash, specHash: identity(record.id).specHash,
      issueId: identity(record.id).issueId }, model: 'gpt-fixture', tokens: { input: 12, output: 7 } });
  const delayed = (queue, end, value) => new Promise(resolve => queue.push(() => { end(); resolve(value); }));
  const adapters = {
    kickoff: {
      verify: record => record,
      list: () => [],
    },
    specification: {
      execute: record => {
        calls.push(`specification:${record.id}`);
        specActive += 1; specPeak = Math.max(specPeak, specActive);
        const value = finishSpec(record);
        if (options.holdSpecification) return delayed(specWaiters, () => { specActive -= 1; }, value);
        specActive -= 1; return value;
      },
    },
    authority: {
      grant: request => {
        const scope = request.scope;
        const proposalId = request.proposalId || 'feed';
        calls.push(`grant:${proposalId}:${scope}`);
        const value = { authority: { nonce: crypto.createHash('sha256').update(`${proposalId}:${scope}`).digest('hex'),
          scope, target: project }, parentLease: { token: 'parent-lease' } };
        grants.push({ proposalId, scope, value });
        return value;
      },
    },
    operations: {
      startPreparation: request => {
        const proposalId = request.proposalId;
        calls.push(`preparation:${proposalId}`);
        prepActive += 1; prepPeak = Math.max(prepPeak, prepActive);
        const operation = { ok: true, operation: { id: `preparation-${proposalId}`,
          batchId: `batch-${proposalId}`, state: options.autoPrepare === false ? 'running' : 'completed' } };
        preparations.set(operation.operation.id, { proposalId, state: operation.operation.state });
        const finish = () => { prepActive -= 1; return operation; };
        return options.holdPreparation ? delayed(preparationWaiters, finish, operation) : finish();
      },
      startImplementation: request => {
        calls.push('implementation-feed:start');
        if (!feed) feed = { id: request.operationId || 'implementation-feed', runId: 'run-shared', state: 'running' };
        return { ok: true, operation: { ...feed } };
      },
      status: request => {
        calls.push(`operation-status:${request.id}`);
        if (preparations.has(request.id)) {
          const prep = preparations.get(request.id);
          return { ok: true, id: request.id, state: prep.state,
            preparation: prep.state === 'completed'
              ? { issueId: identity(prep.proposalId).issueId, freezeReceipt: identity(prep.proposalId).freezeReceipt }
              : null };
        }
        if (feed && request.id === feed.id) {
          const tasks = [...finished.entries()].map(([proposalId, task]) => ({
            issueId: identity(proposalId).issueId, outcome: 'done', branch: task.branch,
            prUrl: task.prUrl, attempts: [{ attempt: 1, acceptance: 'pass', regression: 'pass' }],
          }));
          return { ok: true, id: feed.id, state: stopped ? 'completed' : 'running', runId: feed.runId,
            manifest: { runId: feed.runId, tasks, feed: { enabled: true, ending: stopped ? 'stopped' : null } } };
        }
        return { ok: false, error: `unknown operation ${request.id}` };
      },
      stop: request => {
        calls.push(`implementation-feed:stop:${request.id}`);
        stopped = true;
        return { ok: true, id: request.id, runId: feed && feed.runId };
      },
    },
    review: {
      evidence: ({ proposalId, issueId, runId, task }) => {
        calls.push(`review:${proposalId}`);
        const expected = identity(proposalId);
        return { reviewItemId: expected.reviewItemId, issueId, runId,
          branch: task.branch, prUrl: task.prUrl, verdict: 'pending' };
      },
    },
  };
  return {
    adapters, calls, grants,
    finish(proposalId) { const value = identity(proposalId); finished.set(proposalId, value); },
    completePreparation(proposalId) {
      const prep = preparations.get(`preparation-${proposalId}`);
      if (prep) prep.state = 'completed';
    },
    releaseSpecifications() {
      options.holdSpecification = false;
      while (specWaiters.length) specWaiters.shift()();
    },
    releasePreparations() {
      options.holdPreparation = false;
      while (preparationWaiters.length) preparationWaiters.shift()();
    },
    metrics: () => ({ specActive, specPeak, prepActive, prepPeak }),
    feed: () => feed,
  };
}
function create(fx, name, extra = {}) {
  return api.createProductionSupervisor({ repoRoot: REPO, project,
    stateDir: path.join(tmp, name), configPath: 'fixture.json',
    testingSentinel: api.TESTING_SENTINEL, adapters: fx.adapters,
    globalConcurrency: 2, stageConcurrency: { specification: 2, preparation: 2 }, ...extra });
}
async function pump(supervisor, turns = 8) {
  for (let i = 0; i < turns; i += 1) await supervisor.tick();
}

async function main() {
  if (!api) return;
  const source = fs.readFileSync(MODULE, 'utf8');
  const cliSource = (() => { try { return fs.readFileSync(CLI, 'utf8'); } catch { return ''; } })();

  const real = (() => { try { return api.productionAdapters(REPO, { configPath: 'fixture.json' }); } catch { return null; } })();
  check('C1 production adapters expose kickoff, specification, scoped authority, durable operations and review evidence',
    real && real.kickoff && real.specification && real.authority && real.operations && real.review
      && typeof real.specification.execute === 'function'
      && typeof real.operations.startPreparation === 'function'
      && typeof real.operations.startImplementation === 'function'
      && typeof real.operations.status === 'function' && typeof real.operations.stop === 'function',
    real ? Object.keys(real).join(',') : 'production adapters unavailable');
  check('C1 production composition names the real controller modules and rejects obsolete direct runner shortcuts',
    /kickoff/.test(source) && /specify-proposal/.test(source) && /operation-manager/.test(source)
      && /supervisor/.test(source) && /verdict/.test(source)
      && !/\.prepare\s*\.\s*execute\s*\(/.test(source) && !/\.run\s*\.\s*drainQueue\s*\(/.test(source)
      && !/always[-_ ]pending/i.test(source), source.slice(0, 300));
  check('C1 operator CLI enters the production proposal supervisor',
    /runner[\\/]proposal-supervisor/.test(cliSource) && /createProductionSupervisor/.test(cliSource));

  const fx = fixture();
  const supervisor = create(fx, 'composition');
  const oneRecord = kickoff('kp-1111111111111111');
  const twoRecord = kickoff('kp-2222222222222222');
  await supervisor.submit(oneRecord);
  await pump(supervisor);
  const onePending = await supervisor.status(oneRecord.id);
  await supervisor.submit(twoRecord);
  await pump(supervisor);
  const twoPending = await supervisor.status(twoRecord.id);
  check('C2 proposal two specifies and prepares while proposal one remains on the same live implementation feed',
    onePending.stage === 'implementing' && twoPending.stage === 'implementing'
      && fx.feed() && once(fx.calls, 'implementation-feed:start')
      && once(fx.calls, `specification:${twoRecord.id}`)
      && once(fx.calls, `preparation:${twoRecord.id}`), JSON.stringify({ onePending, twoPending, calls: fx.calls }));
  fx.finish(oneRecord.id); fx.finish(twoRecord.id);
  await pump(supervisor);
  const one = await supervisor.status(oneRecord.id);
  const two = await supervisor.status(twoRecord.id);
  check('C2 both ideas reach review once using identities returned by the composed controllers',
    [one, two].every((status, index) => {
      const proposalId = index ? twoRecord.id : oneRecord.id;
      const expected = identity(proposalId);
      return status.stage === 'review' && status.issueId === expected.issueId
        && status.specHash === expected.specHash && status.freezeReceipt === expected.freezeReceipt
        && status.runId === 'run-shared' && status.branch === expected.branch
        && status.prUrl === expected.prUrl && status.reviewItemId === expected.reviewItemId
        && once(fx.calls, `review:${proposalId}`);
    }), JSON.stringify({ one, two, calls: fx.calls }));
  check('C2 immutable kickoff packets contain intent provenance and no downstream identity',
    Object.isFrozen(oneRecord) && oneRecord.hash.startsWith('sha256:')
      && !['issueId', 'runId', 'branch', 'prUrl', 'verdict'].some(key => key in oneRecord), JSON.stringify(oneRecord));

  check('C3 an opaque test capability exists',
    typeof api.TESTING_SENTINEL === 'symbol' || (api.TESTING_SENTINEL && typeof api.TESTING_SENTINEL === 'object'));
  const testFx = fixture();
  const clone = typeof api.TESTING_SENTINEL === 'symbol' ? Symbol('copy') : { ...api.TESTING_SENTINEL };
  for (const bad of [true, 'enabled', clone]) {
    let refused = false;
    try { api.createProductionSupervisor({ repoRoot: REPO, project, stateDir: path.join(tmp, `bad-${String(bad)}`), adapters: testFx.adapters, testingSentinel: bad }); }
    catch { refused = true; }
    check('C3 deterministic adapters require the exact host-process capability', refused);
  }
  const savedSentinel = process.env.PIPELINE_TESTING_SENTINEL;
  process.env.PIPELINE_TESTING_SENTINEL = 'enabled';
  let envRefused = false;
  try { api.createProductionSupervisor({ repoRoot: REPO, project, stateDir: path.join(tmp, 'bad-env'), adapters: testFx.adapters }); }
  catch { envRefused = true; }
  if (savedSentinel === undefined) delete process.env.PIPELINE_TESTING_SENTINEL;
  else process.env.PIPELINE_TESTING_SENTINEL = savedSentinel;
  check('C3 config, model output and worker environment cannot manufacture the adapter capability', envRefused);

  const effects = ['specification', 'grant-preparation', 'preparation', 'grant-implementation', 'implementation-feed', 'review'];
  for (const effect of effects) {
    const crashFx = fixture();
    const record = kickoff(`kp-${crypto.createHash('sha256').update(effect).digest('hex').slice(0, 16)}`);
    const dir = `recovery-${effect}`;
    const first = create(crashFx, dir, { crashAfter: effect });
    await first.submit(record);
    try { await pump(first); } catch { /* deterministic post-effect crash seam */ }
    const resumed = create(crashFx, dir);
    await resumed.resume();
    crashFx.finish(record.id);
    await pump(resumed);
    const status = await resumed.status(record.id);
    const call = effect === 'specification' ? `specification:${record.id}`
      : effect === 'grant-preparation' ? `grant:${record.id}:preparation`
        : effect === 'preparation' ? `preparation:${record.id}`
          : effect === 'grant-implementation' ? 'grant:feed:implementation'
            : effect === 'implementation-feed' ? 'implementation-feed:start' : `review:${record.id}`;
    check(`C4 recovery after ${effect} reuses durable returned evidence and never repeats the effect`,
      once(crashFx.calls, call), JSON.stringify(crashFx.calls));
    check(`C4 recovery after ${effect} reaches review by polling controller evidence`,
      status.stage === 'review', JSON.stringify(status));
  }

  const delayedSpec = fixture({ holdSpecification: true });
  const specSupervisor = create(delayedSpec, 'limit-spec');
  const specRecords = ['3', '4', '5'].map(digit => kickoff(`kp-${digit.repeat(16)}`));
  for (const record of specRecords) await specSupervisor.submit(record);
  const specTick = specSupervisor.tick();
  const specObserved = await waitFor(() => delayedSpec.metrics().specActive > 1);
  const specCallsBeforeRelease = delayedSpec.calls.filter(call => call.startsWith('specification:'));
  check('C5 global and specification ceilings are measured from overlapping delayed calls',
    specObserved && delayedSpec.metrics().specPeak > 1
      && specCallsBeforeRelease.some(call => call.endsWith(specRecords[0].id))
      && specCallsBeforeRelease.some(call => call.endsWith(specRecords[1].id))
      && !specCallsBeforeRelease.some(call => call.endsWith(specRecords[2].id)),
    JSON.stringify({ metrics: delayedSpec.metrics(), calls: delayedSpec.calls }));
  delayedSpec.releaseSpecifications();
  await specTick;
  await pump(specSupervisor);

  const delayedPrep = fixture({ holdPreparation: true });
  const prepSupervisor = create(delayedPrep, 'limit-preparation');
  const prepRecords = ['6', '7', '8'].map(digit => kickoff(`kp-${digit.repeat(16)}`));
  for (const record of prepRecords) await prepSupervisor.submit(record);
  const prepTick = prepSupervisor.tick();
  const prepObserved = await waitFor(() => delayedPrep.metrics().prepActive > 1);
  const prepCallsBeforeRelease = delayedPrep.calls.filter(call => call.startsWith('preparation:'));
  check('C5 preparation ceiling is measured from overlapping delayed operation starts',
    prepObserved && delayedPrep.metrics().prepPeak > 1
      && !prepCallsBeforeRelease.some(call => call.endsWith(prepRecords[2].id)),
    JSON.stringify({ metrics: delayedPrep.metrics(), calls: delayedPrep.calls }));
  delayedPrep.releasePreparations();
  await prepTick;
  await pump(prepSupervisor);

  const fairFx = fixture({ autoPrepare: false });
  const fairSupervisor = create(fairFx, 'fairness');
  const ready = kickoff('kp-9999999999999999');
  const newcomer = kickoff('kp-aaaaaaaaaaaaaaaa');
  await fairSupervisor.submit(ready); await pump(fairSupervisor, 2);
  fairFx.completePreparation(ready.id);
  await fairSupervisor.submit(newcomer); await fairSupervisor.tick();
  check('C5 a ready implementation feed starts before newly submitted specification work',
    fairFx.calls.indexOf('implementation-feed:start') >= 0
      && fairFx.calls.indexOf('implementation-feed:start') < fairFx.calls.indexOf(`specification:${newcomer.id}`),
    JSON.stringify(fairFx.calls));

  const stopFx = fixture();
  const stopSupervisor = create(stopFx, 'stop');
  const stopRecord = kickoff('kp-bbbbbbbbbbbbbbbb');
  await stopSupervisor.submit(stopRecord); await pump(stopSupervisor);
  await stopSupervisor.stop();
  const late = await stopSupervisor.submit(kickoff('kp-cccccccccccccccc'));
  stopFx.finish(stopRecord.id); await pump(stopSupervisor);
  const stopped = await stopSupervisor.status(stopRecord.id);
  check('C6 stop closes intake, requests feed drain, and lets already granted work reach review',
    late && late.accepted === false && stopFx.calls.some(call => call.startsWith('implementation-feed:stop:'))
      && stopped.stage === 'review', JSON.stringify({ late, stopped, calls: stopFx.calls }));
  const facts = ['queuePosition', 'stage', 'timing', 'attempts', 'model', 'tokens', 'kickoffHash',
    'specHash', 'issueId', 'freezeReceipt', 'runId', 'branch', 'prUrl', 'reviewItemId', 'verdict', 'nextAction'];
  check('C6 status derives every operator fact from durable controller evidence',
    facts.every(key => Object.prototype.hasOwnProperty.call(stopped, key)), JSON.stringify(stopped));
}

const watchdog = setTimeout(() => {
  check('C1-C6 fixture completes', false, 'timed out with an unresolved delayed controller call');
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  process.exit(1);
}, 12000);
main().catch(error => check('C1-C6 fixture completes', false, (error && error.stack) || String(error)))
  .then(() => {
    clearTimeout(watchdog);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    process.exit(failed);
  });
