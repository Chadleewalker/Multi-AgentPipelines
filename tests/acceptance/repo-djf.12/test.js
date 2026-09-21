// Frozen acceptance test — repo-djf.12: race-safe operation launch and settlement recovery.
// C1 settlement uncertainty; C2 post-spawn identity recovery; C3 project feed slot;
// C4 atomic retry; C5 immutable evidence; C6 Docker-free real-process end-to-end proof.
//
// Frozen extension of the repo-djf.7 interface: createHostOperationManager accepts
// `faults.afterSpawnBeforePidPersist` for the deterministic crash seam, exposes reconcile(),
// and durable status exposes immutable prior `attempts` plus settlement/child evidence.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const REPO = path.resolve(__dirname, '..', '..', '..');
let failed = 0;
function check(name, yes, detail = '') {
  console.log(`${yes ? 'ok' : 'FAIL'} - ${name}${yes ? '' : ` — ${detail}`}`);
  if (!yes) failed = 1;
}
const read = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const bytes = file => { try { return fs.readFileSync(file); } catch { return null; } };
const sameBytes = (left, right) => Buffer.isBuffer(left) && Buffer.isBuffer(right) && left.equals(right);
const waitFor = async (fn, ms = 6000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const value = fn();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  return null;
};
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-djf12-'));
const stateRoot = path.join(tmp, 'state');
const pipelineRoot = path.join(tmp, 'pipeline');
const runsRoot = path.join(pipelineRoot, 'runs');
const fixture = path.join(tmp, 'child.js');
for (const dir of [stateRoot, runsRoot]) fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(fixture, `
const fs=require('fs'),path=require('path');
const runId=process.env.RUN_ID, root=path.join(process.env.PIPELINE_RUNS_DIR,runId);
const auth=JSON.parse(fs.readFileSync(process.env.PIPELINE_CHILD_AUTHORITY,'utf8'));
fs.mkdirSync(root,{recursive:true});
fs.writeFileSync(path.join(root,'child-observed.json'),JSON.stringify({kind:'implementation-child',runId,pid:process.pid,startedAt:Date.now(),authorityNonce:auth.nonce,authenticated:true}));
const done=()=>{fs.writeFileSync(path.join(root,'run.json'),JSON.stringify({runId,finishedAt:Date.now(),feed:{ending:'fixture-complete'},tasks:[]}));process.exit(0)};
if(process.env.FIXTURE_HOLD==='1') setTimeout(done,900); else setTimeout(done,40);
`);
let mod = null; let loadError = '';
try { mod = require(path.join(REPO, 'runner', 'operation-manager.js')); }
catch (e) { loadError = (e && e.message) || String(e); }
check('C1-C6 operation manager exports the frozen recovery interface',
  mod && typeof mod.createHostOperationManager === 'function', loadError);

async function main() {
  if (!mod) return;
  const launches = [];
  const settlements = [];
  const settlementKnowledge = new Map();
  const uncertainOnce = new Set();
  const supervisor = {
    settle: (_lease, nonce, result) => {
      settlements.push({ nonce, result });
      if (uncertainOnce.has(nonce)) {
        uncertainOnce.delete(nonce);
        return { ok: false, uncertain: true, error: 'receipt unavailable' };
      }
      return { ok: true };
    },
    settlementState: (_lease, nonce) => ({ ok: true, settled: settlementKnowledge.get(nonce) === true, nonce }),
    withSection: (_admission, _section, fn) => fn(),
  };
  const projectFor = name => {
    const project = path.join(tmp, `project-${name}`);
    fs.mkdirSync(project, { recursive: true });
    return project;
  };
  const authority = (project, nonce, scope = 'implementation') => ({
    nonce, scope, issueId: null, batch: null, target: project,
    parent: { id: 'parent', pid: process.pid }, expiresAt: '2099-01-01T00:00:00.000Z',
  });
  const grant = (project, nonce, scope) => ({ authority: authority(project, nonce, scope), parentLease: { token: 'lease' } });
  const options = (project, extra = {}) => ({
    stateRoot, pipelineRoot, runsRoot, supervisor, lifecycleTimeoutMs: 4000,
    env: { ...process.env, PIPELINE_RUNS_DIR: runsRoot, FIXTURE_HOLD: '1' },
    scripts: { run: fixture },
    spawn: (command, argv, spawnOptions) => {
      launches.push({ project, nonce: read(spawnOptions.env.PIPELINE_CHILD_AUTHORITY)?.nonce });
      return cp.spawn(command, argv, spawnOptions);
    },
    ...extra,
  });
  const start = (manager, project, id, nonce) => manager.startImplementation({
    project, operationId: id, configPath: 'fixture.json', grant: grant(project, nonce),
  });
  const retry = (manager, project, id, nonce, scope) => manager.retry({
    project, id, approved: true, grant: grant(project, nonce, scope),
  });
  const exactObserved = nonce => {
    let ids = [];
    try { ids = fs.readdirSync(runsRoot); } catch {}
    return ids.map(id => read(path.join(runsRoot, id, 'child-observed.json')))
      .find(item => item && item.authenticated === true && item.authorityNonce === nonce) || null;
  };
  const kill = operation => {
    if (!operation || !Number.isInteger(operation.pid)) return;
    try { process.kill(operation.pid, 'SIGKILL'); } catch {}
  };

  // C1a: an uncertain result that the parent proves settled completes the original grant.
  const settledProject = projectFor('settled');
  const settledNonce = '1'.repeat(48);
  uncertainOnce.add(settledNonce);
  const settledManager = mod.createHostOperationManager(options(settledProject));
  const settledStart = start(settledManager, settledProject, 'settled-op', settledNonce);
  const settledTerminal = settledStart.ok && await waitFor(() => read(path.join(runsRoot, settledStart.operation.runId, 'run.json')));
  const settledAttention = await waitFor(() => {
    const status = settledManager.status({ project: settledProject, id: 'settled-op' });
    return status.state === 'attention' && status;
  });
  const beforeSettledLaunches = launches.length;
  const settledRetry = retry(settledManager, settledProject, 'settled-op', '2'.repeat(48));
  settlementKnowledge.set(settledNonce, true);
  const settledReconcile = typeof settledManager.reconcile === 'function'
    ? settledManager.reconcile({ project: settledProject, id: 'settled-op' }) : { ok: false, error: 'reconcile missing' };
  const settledFinal = settledManager.status({ project: settledProject, id: 'settled-op' });
  const settledMarker = `${settledStart.operation.statePath}.settlement`;
  check('C1 settlement uncertainty forbids retry and proved-settled reconciliation completes the original grant without launch',
    settledTerminal && settledAttention.state === 'attention' && settledRetry.ok === false
      && settledReconcile.ok && settledFinal.state === 'completed'
      && launches.length === beforeSettledLaunches
      && settlements.filter(item => item.nonce === settledNonce).map(item => item.nonce).join('|') === settledNonce
      && !fs.existsSync(settledMarker),
    JSON.stringify({ settledAttention, settledRetry, settledReconcile, settledFinal }));

  // C1b: if the parent proves it was not settled, reconciliation retries only settlement.
  const unsettledProject = projectFor('unsettled');
  const unsettledNonce = '3'.repeat(48);
  uncertainOnce.add(unsettledNonce);
  const unsettledManager = mod.createHostOperationManager(options(unsettledProject));
  const unsettledStart = start(unsettledManager, unsettledProject, 'unsettled-op', unsettledNonce);
  const unsettledTerminal = unsettledStart.ok && await waitFor(() => read(path.join(runsRoot, unsettledStart.operation.runId, 'run.json')));
  const unsettledAttention = await waitFor(() => {
    const status = unsettledManager.status({ project: unsettledProject, id: 'unsettled-op' });
    return status.state === 'attention' && status;
  });
  settlementKnowledge.set(unsettledNonce, false);
  const beforeUnsettledLaunches = launches.length;
  const unsettledReconcile = typeof unsettledManager.reconcile === 'function'
    ? unsettledManager.reconcile({ project: unsettledProject, id: 'unsettled-op' }) : { ok: false, error: 'reconcile missing' };
  const unsettledFinal = unsettledManager.status({ project: unsettledProject, id: 'unsettled-op' });
  check('C1 proved-unsettled reconciliation retries the original settlement exactly once and never launches replacement work',
    unsettledTerminal && unsettledAttention.state === 'attention' && unsettledReconcile.ok
      && unsettledFinal.state === 'completed' && launches.length === beforeUnsettledLaunches
      && settlements.filter(item => item.nonce === unsettledNonce).map(item => item.nonce).join('|')
        === `${unsettledNonce}|${unsettledNonce}`,
    JSON.stringify({ unsettledAttention, unsettledReconcile, unsettledFinal }));

  // C2: a plausible live decoy must not be mistaken for the child spawned in the crash seam.
  const crashProject = projectFor('crash');
  const crashNonce = '4'.repeat(48);
  const decoyDir = path.join(runsRoot, 'decoy-run');
  fs.mkdirSync(decoyDir, { recursive: true });
  fs.writeFileSync(path.join(decoyDir, 'child-observed.json'), JSON.stringify({
    kind: 'implementation-child', runId: 'decoy-run', pid: process.pid, startedAt: Date.now(),
    authorityNonce: 'd'.repeat(48), authenticated: true,
  }));
  const crashManager = mod.createHostOperationManager(options(crashProject, { faults: { afterSpawnBeforePidPersist: true } }));
  const beforeCrashLaunches = launches.length;
  let crashed;
  try { crashed = start(crashManager, crashProject, 'crash-op', crashNonce); }
  catch (e) { crashed = { ok: false, error: (e && e.message) || String(e) }; }
  const observed = await waitFor(() => exactObserved(crashNonce));
  const recoveryManager = mod.createHostOperationManager(options(crashProject));
  const recovered = recoveryManager.status({ project: crashProject, id: 'crash-op' });
  const beforeCrashRetry = launches.length;
  const crashRetry = retry(recoveryManager, crashProject, 'crash-op', '5'.repeat(48));
  const recoveredExactChild = observed && recovered.pid === observed.pid && recovered.runId === observed.runId;
  check('C2 crash recovery binds to the exact authenticated nonce/run and never selects a live decoy or duplicates the child',
    observed && launches.length === beforeCrashRetry && crashRetry.ok === false
      && (recoveredExactChild || recovered.state === 'attention')
      && recovered.pid !== process.pid && launches.length === beforeCrashLaunches + 1,
    JSON.stringify({ crashed, observed, recovered, crashRetry }));
  kill(observed);

  // C3: different ids and manager instances contend at the actual spawn boundary.
  const feedProject = projectFor('feed-race');
  let feedContender = null;
  const feedRacer = mod.createHostOperationManager(options(feedProject, {
    spawn: (command, argv, spawnOptions) => {
      if (!feedContender) {
        const contenderManager = mod.createHostOperationManager(options(feedProject));
        feedContender = start(contenderManager, feedProject, 'feed-b', '6'.repeat(48));
      }
      launches.push({ project: feedProject, nonce: read(spawnOptions.env.PIPELINE_CHILD_AUTHORITY)?.nonce });
      return cp.spawn(command, argv, spawnOptions);
    },
  }));
  const beforeFeedRace = launches.length;
  const feedWinner = start(feedRacer, feedProject, 'feed-a', '7'.repeat(48));
  check('C3 independent concurrent starts for one project atomically reserve one feed slot and spawn exactly one child',
    feedWinner.ok && feedContender && feedContender.ok === false && launches.length === beforeFeedRace + 1,
    JSON.stringify({ feedWinner, feedContender }));
  kill(feedWinner.operation);

  // C4/C5: invalid retry is read-only; two valid retries contend on one attempt transition.
  const retryProject = projectFor('retry-race');
  const retryManager = mod.createHostOperationManager(options(retryProject));
  const retryStart = start(retryManager, retryProject, 'retry-op', '8'.repeat(48));
  kill(retryStart.operation);
  const retryAttention = await waitFor(() => {
    const status = retryManager.status({ project: retryProject, id: 'retry-op' });
    return status.state === 'attention' && status;
  });
  const statePath = retryStart.operation.statePath;
  const evidenceBeforeRejection = bytes(statePath);
  const invalidRetry = retry(retryManager, retryProject, 'retry-op', '9'.repeat(48), 'preparation');
  const evidenceAfterRejection = bytes(statePath);
  let retryContender = null;
  const retryRacer = mod.createHostOperationManager(options(retryProject, {
    spawn: (command, argv, spawnOptions) => {
      if (!retryContender) {
        const contenderManager = mod.createHostOperationManager(options(retryProject));
        retryContender = retry(contenderManager, retryProject, 'retry-op', 'a'.repeat(48));
      }
      launches.push({ project: retryProject, nonce: read(spawnOptions.env.PIPELINE_CHILD_AUTHORITY)?.nonce });
      return cp.spawn(command, argv, spawnOptions);
    },
  }));
  const beforeRetryRace = launches.length;
  const retryWinner = retry(retryRacer, retryProject, 'retry-op', 'b'.repeat(48));
  const afterRetry = mod.createHostOperationManager(options(retryProject)).status({ project: retryProject, id: 'retry-op' });
  const prior = afterRetry && Array.isArray(afterRetry.attempts)
    ? afterRetry.attempts.find(item => item.attempt === 1) : null;
  check('C4 concurrent approved retries atomically create one next attempt and spawn exactly one child',
    retryAttention && retryWinner.ok && retryContender && retryContender.ok === false
      && launches.length === beforeRetryRace + 1,
    JSON.stringify({ retryAttention, retryWinner, retryContender }));
  check('C5 rejected transition is byte-identical and the prior attempt retains complete immutable evidence',
    invalidRetry.ok === false && sameBytes(evidenceBeforeRejection, evidenceAfterRejection)
      && prior && prior.state === 'attention' && prior.authority
      && prior.artifactPaths && Object.prototype.hasOwnProperty.call(prior, 'exit')
      && Object.prototype.hasOwnProperty.call(prior, 'settlement') && prior.attention,
    JSON.stringify({ invalidRetry, prior, afterRetry }));
  kill(retryWinner.operation);

  // C6: reconciliation is stable: later observation/retry cannot revive work or settlement.
  const beforeStableLaunches = launches.length;
  const beforeStableSettlements = settlements.length;
  const stableStatus = mod.createHostOperationManager(options(settledProject)).status({ project: settledProject, id: 'settled-op' });
  const stableRetry = retry(mod.createHostOperationManager(options(settledProject)), settledProject, 'settled-op', 'c'.repeat(48));
  check('C6 Docker-free real-process proof leaves reconciled work durably terminal with no duplicate launch or settlement',
    stableStatus.state === 'completed' && stableRetry.ok === false
      && launches.length === beforeStableLaunches && settlements.length === beforeStableSettlements
      && !fs.existsSync(settledMarker),
    JSON.stringify({ stableStatus, stableRetry, launches: launches.length, settlements: settlements.length }));
}
main().then(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  process.exit(failed);
}).catch(e => {
  check('C1-C6 fixture completes', false, (e && e.stack) || String(e));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
