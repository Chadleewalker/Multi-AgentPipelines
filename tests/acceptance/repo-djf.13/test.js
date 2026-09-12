// Frozen acceptance test — repo-djf.13: recover pre-spawn implementation reservations.
//
// C1: each pre-spawn durability boundary can be interrupted and explicitly recovered.
// C2: ordinary start/retry never guesses that an uncertain launch is safe.
// C3: recovery preserves the abandoned attempt and launches exactly one replacement.
// C4: guard.js preserves repo-djf.12; this file also checks credential stripping.
//
// Frozen interface: createHostOperationManager accepts three deterministic fault seams:
//   afterFeedReservation, afterOperationIntent, afterAuthorityPersist.
// It exposes recoverLaunch({ project, operationId, configPath, grant, approved, reason }).
// Recovery requires approved === true and a non-empty reason. That explicit parent decision is
// the authority for a pre-spawn record whose child absence cannot otherwise be inferred. It
// retains the abandoned reservation as immutable attempt evidence and starts one next attempt.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const REPO = path.resolve(__dirname, '..', '..', '..');
const PROVIDER_CREDENTIAL_NAMES = 'CODEX_API_KEY OPENAI_API_KEY ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN'.split(' ');
let failed = 0;
function check(name, yes, detail = '') {
  console.log(`${yes ? 'ok' : 'FAIL'} - ${name}${yes ? '' : ` — ${detail}`}`);
  if (!yes) failed = 1;
}
const read = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
function filesBelow(dir, name, found = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return found; }
  for (const entry of entries) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) filesBelow(file, name, found);
    else if (entry.name === name) found.push(file);
  }
  return found;
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(fn, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = fn();
    if (value) return value;
    await delay(20);
  }
  return null;
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-djf13-'));
const stateRoot = path.join(tmp, 'state');
const pipelineRoot = path.join(tmp, 'pipeline');
const runsRoot = path.join(pipelineRoot, 'runs');
const fixture = path.join(tmp, 'child.js');
for (const dir of [stateRoot, runsRoot]) fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(fixture, `
const fs=require('fs'),path=require('path');
const runId=process.env.RUN_ID,root=path.join(process.env.PIPELINE_RUNS_DIR,runId);
const auth=JSON.parse(fs.readFileSync(process.env.PIPELINE_CHILD_AUTHORITY,'utf8'));
fs.mkdirSync(root,{recursive:true});
fs.writeFileSync(path.join(root,'child-observed.json'),JSON.stringify({kind:'implementation-child',runId,pid:process.pid,authorityNonce:auth.nonce,authenticated:true}));
setTimeout(()=>process.exit(0),5000);
`);
let moduleUnderTest = null;
try { moduleUnderTest = require(path.join(REPO, 'runner', 'operation-manager.js')); } catch {}
check('C1-C4 operation manager exports the recovery constructor',
  moduleUnderTest && typeof moduleUnderTest.createHostOperationManager === 'function');

async function main() {
  if (!moduleUnderTest) return;
  const launches = [];
  const supervisor = {
    settle: () => ({ ok: true }), settlementState: () => ({ ok: true, settled: false }),
    withSection: (_admission, _section, fn) => fn(),
  };
  const grant = (project, nonce) => ({
    authority: {
      nonce, scope: 'implementation', issueId: null, batch: null, target: project,
      parent: { id: 'parent', pid: process.pid }, expiresAt: '2099-01-01T00:00:00.000Z',
    },
    parentLease: { token: 'parent-lease' },
  });
  const options = (project, faults = {}) => ({
    stateRoot, pipelineRoot, runsRoot, supervisor, faults, lifecycleTimeoutMs: 10000,
    env: {
      ...process.env, PIPELINE_RUNS_DIR: runsRoot,
      CODEX_API_KEY: 'must-not-cross', OPENAI_API_KEY: 'must-not-cross',
      ANTHROPIC_API_KEY: 'must-not-cross', CLAUDE_CODE_OAUTH_TOKEN: 'must-not-cross',
    },
    scripts: { run: fixture },
    spawn: (command, argv, opts) => {
      launches.push({ project, env: opts.env });
      return cp.spawn(command, argv, opts);
    },
  });
  const windows = [
    ['afterFeedReservation', 'feed-reserved'],
    ['afterOperationIntent', 'operation-intent'],
    ['afterAuthorityPersist', 'authority-persisted'],
  ];
  for (let index = 0; index < windows.length; index += 1) {
    const [fault, stage] = windows[index];
    const project = path.join(tmp, `project-${index}`);
    fs.mkdirSync(project, { recursive: true });
    const operationId = `pre-spawn-${index}`;
    const originalGrant = grant(project, String(index + 1).repeat(48));
    const input = { project, operationId, configPath: 'fixture.json', grant: originalGrant };
    const manager = moduleUnderTest.createHostOperationManager(options(project, { [fault]: true }));
    const beforeFault = launches.length;
    let interrupted = null;
    try { interrupted = manager.startImplementation(input); }
    catch (error) { interrupted = { threw: true, error: error.message }; }
    const faultLaunches = launches.length - beforeFault;
    if (interrupted && interrupted.operation && interrupted.operation.pid) {
      try { process.kill(interrupted.operation.pid, 'SIGKILL'); } catch {}
    }
    const slotFile = filesBelow(stateRoot, 'implementation-feed.slot')
      .find((file) => { const value = read(file); return value && value.id === operationId; });
    const slot = slotFile && read(slotFile);

    const plainStart = moduleUnderTest.createHostOperationManager(options(project)).startImplementation(input);
    const plainRetry = moduleUnderTest.createHostOperationManager(options(project)).retry({
      project, id: operationId, approved: true, grant: originalGrant,
    });
    const recoveryManager = moduleUnderTest.createHostOperationManager(options(project));
    const refusedRecovery = typeof recoveryManager.recoverLaunch === 'function'
      ? recoveryManager.recoverLaunch({ ...input, approved: false, reason: 'operator did not approve' })
      : { ok: false, error: 'recoverLaunch missing' };
    const beforeRecovery = launches.length;
    const recovered = typeof recoveryManager.recoverLaunch === 'function'
      ? recoveryManager.recoverLaunch({ ...input, approved: true, reason: `verified no child remains at ${stage}` })
      : { ok: false, error: 'recoverLaunch missing' };
    const recoveryLaunches = launches.length - beforeRecovery;
    const operation = recovered && recovered.operation;
    const prior = operation && Array.isArray(operation.attempts) && operation.attempts[0];

    check(`C1 ${stage} interruption is durable before any child launch`,
      interrupted && interrupted.threw === true && faultLaunches === 0 && slot && slot.id === operationId,
      JSON.stringify({ interrupted, faultLaunches, slot }));
    check(`C2 ${stage} ordinary start/retry and unapproved recovery remain fail-closed`,
      plainStart && plainStart.ok === false && plainRetry && plainRetry.ok === false
        && refusedRecovery && refusedRecovery.ok === false,
      JSON.stringify({ plainStart, plainRetry, refusedRecovery }));
    check(`C3 ${stage} approved recovery launches exactly one next attempt and retains the first`,
      recovered && recovered.ok === true && recoveryLaunches === 1
        && operation && operation.attempt === 2 && prior && prior.attempt === 1
        && prior.childIdentity === 'not-spawned' && prior.attention.includes('reconciled'),
      JSON.stringify({ recovered, recoveryLaunches }));
    check(`C4 ${stage} recovered child receives no provider credential`,
      recoveryLaunches === 1
        && PROVIDER_CREDENTIAL_NAMES.every((key) => launches[launches.length - 1].env[key] === undefined));
    if (operation && operation.pid) try { process.kill(operation.pid, 'SIGKILL'); } catch {}
  }

  const project = path.join(tmp, 'project-retry');
  fs.mkdirSync(project, { recursive: true });
  const operationId = 'pre-spawn-retry';
  const originalGrant = grant(project, '4'.repeat(48));
  const input = { project, operationId, configPath: 'fixture.json', grant: originalGrant };
  const firstManager = moduleUnderTest.createHostOperationManager(options(project));
  const first = firstManager.startImplementation(input);
  if (first && first.operation && first.operation.pid) {
    try { process.kill(first.operation.pid, 'SIGKILL'); } catch {}
  }
  await waitFor(() => {
    const current = firstManager.status({ project, id: operationId });
    return current.ok && current.state === 'attention' ? current : null;
  });
  const retryManager = moduleUnderTest.createHostOperationManager(options(project, { afterFeedReservation: true }));
  const beforeFault = launches.length;
  let interrupted = null;
  try {
    interrupted = retryManager.retry({ project, id: operationId, approved: true, grant: originalGrant });
  } catch (error) { interrupted = { threw: true, error: error.message }; }
  const faultLaunches = launches.length - beforeFault;
  if (interrupted && interrupted.operation && interrupted.operation.pid) {
    try { process.kill(interrupted.operation.pid, 'SIGKILL'); } catch {}
  }
  const slotFile = filesBelow(stateRoot, 'implementation-feed.slot')
    .find((file) => { const value = read(file); return value && value.id === operationId; });
  const slot = slotFile && read(slotFile);
  const plainRetry = moduleUnderTest.createHostOperationManager(options(project)).retry({
    project, id: operationId, approved: true, grant: originalGrant,
  });
  const recoveryManager = moduleUnderTest.createHostOperationManager(options(project));
  const beforeRecovery = launches.length;
  const recovered = typeof recoveryManager.recoverLaunch === 'function'
    ? recoveryManager.recoverLaunch({ ...input, approved: true, reason: 'verified retry child was never spawned' })
    : { ok: false, error: 'recoverLaunch missing' };
  const recoveryLaunches = launches.length - beforeRecovery;
  const operation = recovered && recovered.operation;
  const abandoned = operation && Array.isArray(operation.attempts)
    && operation.attempts.find((attempt) => attempt.attempt === 2);
  const priorNumbers = new Set(operation && Array.isArray(operation.attempts)
    ? operation.attempts.map((attempt) => attempt.attempt) : []);
  check('C1 retry reservation interruption is durable before a replacement child launch',
    first && first.ok === true && interrupted && interrupted.threw === true
      && faultLaunches === 0 && slot && slot.attempt === 2,
    JSON.stringify({ first, interrupted, faultLaunches, slot }));
  check('C2 ordinary retry cannot bypass an interrupted retry reservation',
    plainRetry && plainRetry.ok === false, JSON.stringify(plainRetry));
  check('C3 approved recovery preserves attempts 1 and 2, then launches attempt 3 exactly once',
    recovered && recovered.ok === true && recoveryLaunches === 1
      && operation && operation.attempt === 3 && priorNumbers.size === operation.attempt - 1
      && priorNumbers.has(1) && priorNumbers.has(2)
      && abandoned && abandoned.childIdentity === 'not-spawned'
      && abandoned.attention.includes('reconciled'),
    JSON.stringify({ recovered, recoveryLaunches }));
  check('C4 retry recovery strips every provider credential',
    recoveryLaunches === 1
      && PROVIDER_CREDENTIAL_NAMES.every((key) => launches[launches.length - 1].env[key] === undefined));
  if (operation && operation.pid) try { process.kill(operation.pid, 'SIGKILL'); } catch {}
}

main().then(() => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  process.exitCode = failed;
}).catch((error) => {
  check('C1-C4 fixture completes', false, error.stack || String(error));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  process.exitCode = 1;
});
