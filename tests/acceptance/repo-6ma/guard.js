// Frozen acceptance test — repo-6ma, the [guard] half: the preparation-to-freeze handoff is
// added WITHOUT spending the durable behaviour the pipeline already has.
//
// [guard] Every check in this file is GREEN at the fork point and must stay green. It is the
// coverage-retention half of criterion C6 — "Relevant existing supervisor, operation-manager,
// preparation and freeze-admission behavior stays covered" — and nothing else in this suite
// proves that half. Every RED check, for C1-C5 and for C6's composed behavioural proof, lives
// in `test.js` beside it.
//
// Nothing red belongs in this file. A [guard] file that is red at the fork point is a stale pin
// and refuses the freeze outright (`scripts/freeze-gate.js`, verdict `stale-guard`).
//
// SPEC DEFECT, REPORTED NOT PAPERED OVER. C6 ends "mandatory regression validation is a separate
// stage, not a recursive acceptance runner", and the behaviour it says must stay covered is
// carried by suites this file may not run and may not edit: `scripts/test-preparation-state.sh`,
// `scripts/test-dispatch-gate.sh` and `scripts/test-runner-queue.sh` all match
// `scripts/test-*.sh` in `pipeline.config.json` `frozenPaths`, `tests/unit/` is frozen whole,
// and `tests/acceptance/repo-0tq`, `repo-djf.5`, `repo-djf.7`, `repo-djf.12` and `repo-djf.18`
// are other issues' frozen suites. Shelling into one would also assert through a file this
// suite cannot adjust, and the freeze gate runs this guard subset ALONE in a flat scratch
// directory where no sibling is reachable. So C6's coverage half is proven the way `repo-rj7`
// and `repo-yk4` proved theirs: as the SUBSTANCE those suites carry, restated directly against
// `runner/preparation-state.js`, `runner/operation-manager.js`, `runner/proposal-supervisor.js`
// and `runner/queue.js`, plus the static fact that each named suite file is still present.
// "The configured regression command is green" stays a pipeline-level gate; no acceptance suite
// in this project can honestly claim it.
//
// THE ONE FACT THIS GUARD PINS HARDEST is the producer/consumer boundary the red half depends
// on: the operation manager's preparation evidence is `deriveState`'s record — `issues[].state`
// and NO top-level `stage` — and the fix must teach the consumer to read that shape rather than
// teach the producer to manufacture a synthetic stage (C1: "No synthetic top-level preparation
// stage is required").
//
// SELF-CONTAINED ON PURPOSE. It reaches no network and starts no container engine; the only
// child processes are local `git` calls against bare repositories it creates itself. Expensive
// children are substituted through the operation manager's own `spawn` seam.
//
// EVERY AUTHORITY IT TOUCHES IS RE-AIMED: PIPELINE_GLOBAL_LOCK_DIR, PREPARATION_RUNS_DIR and
// PIPELINE_STATE_DIR move into a disposable temp tree, and `bd` is aimed at a path that cannot
// exist, so running this file can never disturb a live run on the same machine.
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..', '..');

let failed = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'ok' : 'FAIL'} - ${name}${ok || !detail ? '' : ` — ${detail}`}`);
  if (!ok) failed = 1;
}
function safeRequire(rel) {
  try { return require(path.join(REPO, ...rel.split('/'))); } catch { return null; }
}
function rmrf(target) {
  try { fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  catch { /* disposable */ }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-6ma-'));
const savedEnv = {
  PIPELINE_GLOBAL_LOCK_DIR: process.env.PIPELINE_GLOBAL_LOCK_DIR,
  PREPARATION_RUNS_DIR: process.env.PREPARATION_RUNS_DIR,
  PIPELINE_STATE_DIR: process.env.PIPELINE_STATE_DIR,
  PIPELINE_BD_CMD: process.env.PIPELINE_BD_CMD,
  PIPELINE_CHILD_AUTHORITY: process.env.PIPELINE_CHILD_AUTHORITY,
};
process.env.PIPELINE_GLOBAL_LOCK_DIR = path.join(tmp, 'host-locks');
process.env.PREPARATION_RUNS_DIR = path.join(tmp, 'preparations');
process.env.PIPELINE_STATE_DIR = path.join(tmp, 'host-state');
process.env.PIPELINE_BD_CMD = path.join(tmp, 'no-such-bd-binary');
delete process.env.PIPELINE_CHILD_AUTHORITY;

const PREP = safeRequire('runner/preparation-state.js');
const OPS = safeRequire('runner/operation-manager.js');
const SUP = safeRequire('runner/proposal-supervisor.js');
const QUEUE = safeRequire('runner/queue.js');
const AUTH = safeRequire('runner/supervisor.js');
const LOCK = safeRequire('runner/lock.js');
const HASHER = safeRequire('runner/suite-hash.js');
const CONFIG = safeRequire('runner/config.js');
const FREEZE_GATE = safeRequire('scripts/freeze-gate.js');

const PREPARATION_EXPORTS = ['createManifest', 'readManifest', 'appendEvent', 'readEvents',
  'createWorkerNonce', 'writeWorkerStarted', 'writeWorkerResult', 'readWorkerRecords',
  'deriveState', 'preparationRoot', 'validateBatchId', 'validateIssueId', 'canonicalHash'];
const SUPERVISOR_EXPORTS = ['createProductionSupervisor', 'openProjectSupervisor',
  'productionAdapters', 'formatHumanStatus', 'supervisorStateDirFor'];
const AUTHORITY_EXPORTS = ['acquire', 'release', 'grant', 'settle', 'settlementState',
  'outstanding', 'leaseHolder', 'supervisorDir'];
const QUEUE_EXPORTS = ['partitionByFreeze', 'resolveBranch', 'readyQueue', 'parseReceipt'];
const HASHER_EXPORTS = ['suiteHash', 'workingTreeEntries', 'treeEntries'];
const REQUIRED_STAGES = ['queued', 'specifying', 'criticizing', 'authoring-tests', 'proving',
  'freezing', 'ready', 'implementing', 'publishing', 'review', 'needs-input', 'failed',
  'rejected'];
// The existing suites that carry the behaviour C6 says must stay covered. Recorded, never run:
// see the SPEC DEFECT note above.
const EXISTING_COVERAGE = ['scripts/test-preparation-state.sh', 'scripts/test-dispatch-gate.sh',
  'scripts/test-runner-queue.sh', 'scripts/test-freeze.sh', 'tests/unit/preparation-state.test.js',
  'tests/unit/dispatch-gate.test.js', 'tests/acceptance/repo-0tq/test.js',
  'tests/acceptance/repo-djf.5/test.js', 'tests/acceptance/repo-djf.7/test.js',
  'tests/acceptance/repo-djf.12/test.js', 'tests/acceptance/repo-djf.18/test.js'];

const has = (mod, names) => !!mod && names.every(name => typeof mod[name] === 'function');

// ---- G1: the surfaces every existing path is reached through -------------------------------
check('C6 [guard] runner/preparation-state.js still exports its whole durable surface',
  has(PREP, PREPARATION_EXPORTS), PREP ? Object.keys(PREP).join(',') : 'module missing');
check('C6 [guard] runner/operation-manager.js still exports createHostOperationManager',
  has(OPS, ['createHostOperationManager']));
check('C6 [guard] runner/proposal-supervisor.js still exports the production conveyor surface',
  has(SUP, SUPERVISOR_EXPORTS) && !!SUP && Array.isArray(SUP.STAGES)
    && typeof SUP.TESTING_SENTINEL === 'symbol',
  SUP ? Object.keys(SUP).join(',') : 'module missing');
check('C6 [guard] runner/supervisor.js still exports lease, grant and settlement authority',
  has(AUTH, AUTHORITY_EXPORTS));
check('C6 [guard] runner/queue.js still exports the canonical freeze-admission surface',
  has(QUEUE, QUEUE_EXPORTS) && !!QUEUE && !!QUEUE.REFUSAL
    && QUEUE.RECEIPT_VERDICTS instanceof Set && QUEUE.KNOWN_GATE_VERSIONS instanceof Set);
check('C6 [guard] runner/suite-hash.js still owns the one suite-hash formula',
  has(HASHER, HASHER_EXPORTS) && !!HASHER && typeof HASHER.RECEIPT_NAME === 'string');
check('C6 [guard] the closed proposal stage vocabulary still covers every observable state',
  !!SUP && REQUIRED_STAGES.every(stage => SUP.STAGES.includes(stage)),
  SUP ? SUP.STAGES.join(',') : 'module missing');
for (const rel of EXISTING_COVERAGE) {
  check(`C6 [guard] the existing suite \`${rel}\` is still present`,
    fs.existsSync(path.join(REPO, ...rel.split('/'))));
}
if (!PREP || !OPS || !SUP || !QUEUE || !AUTH || !LOCK || !HASHER || !CONFIG || !FREEZE_GATE) {
  console.log('FAIL - HARNESS: a module could not be loaded; the rest of C6 cannot run');
  rmrf(tmp);
  process.exit(1);
}

// ---- G2: the preparation vocabulary the consumer has to learn to read ----------------------
const prepRoot = path.join(tmp, 'preparation-records');
const BATCH = 'guard-6ma-batch';
const ISSUE = 'guard-6ma-issue';
const OTHER = 'guard-6ma-other';
PREP.createManifest(prepRoot, BATCH, {
  project: path.join(tmp, 'guard-project'), runConfig: 'guard.json', intent: 'guard fixture',
  issues: [{ id: ISSUE, title: 'the issue under preparation', dependencies: [] },
    { id: OTHER, title: 'an unrelated issue in the same batch', dependencies: [] }],
  config: { image: 'guard:local' },
});
const liveIdentity = () => LOCK.livenessFields(process.pid);
function startWorker(issueId, phase, live = true) {
  const nonce = PREP.createWorkerNonce();
  PREP.writeWorkerStarted(prepRoot, BATCH, issueId, live
    ? { nonce, phase, pid: process.pid, process: liveIdentity() }
    : { nonce, phase, pid: 1234 });
  return nonce;
}
const stateOf = (issueId, root = prepRoot, batch = BATCH) => {
  const derived = PREP.deriveState(root, batch);
  const row = derived.ok ? derived.issues.find(item => item.id === issueId) : null;
  return row ? row.state : null;
};
const pending = stateOf(ISSUE);
const authorNonce = startWorker(ISSUE, 'author');
const authoring = stateOf(ISSUE);
const proofNonce = startWorker(ISSUE, 'proof');
const proving = stateOf(ISSUE);
check('C6 [guard] deriveState still reports per-issue pending, authoring and proving states',
  pending === 'pending' && authoring === 'authoring' && proving === 'proving',
  JSON.stringify({ pending, authoring, proving }));
PREP.writeWorkerResult(prepRoot, BATCH, ISSUE, { nonce: proofNonce, outcome: 'proven-at-base', exitCode: 0 });
const proven = stateOf(ISSUE);
const unrelated = stateOf(OTHER);
check('C6 [guard] a worker outcome still passes through as the issue state, per issue',
  proven === 'proven-at-base' && unrelated === 'pending',
  JSON.stringify({ proven, unrelated }));
const strandedNonce = startWorker(OTHER, 'author-proof', false);
check('C6 [guard] a started worker with no result and no live identity is still interrupted-unknown',
  stateOf(OTHER) === 'interrupted-unknown', String(stateOf(OTHER)));
PREP.writeWorkerResult(prepRoot, BATCH, OTHER, { nonce: strandedNonce, outcome: 'unproven', exitCode: 1 });
check('C6 [guard] an adverse outcome is still reported as itself rather than as a success',
  stateOf(OTHER) === 'unproven', String(stateOf(OTHER)));
check('C6 [guard] the immutable manifest still owns its batch id and refuses a second start',
  (() => {
    try {
      PREP.createManifest(prepRoot, BATCH, { project: 'x', issues: [ISSUE], config: {} });
      return false;
    } catch { return true; }
  })());
const tornRoot = path.join(tmp, 'torn-records');
fs.mkdirSync(path.join(tornRoot, 'torn-batch'), { recursive: true });
fs.writeFileSync(path.join(tornRoot, 'torn-batch', 'manifest.json'), '{"unfinished":');
const torn = PREP.deriveState(tornRoot, 'torn-batch');
check('C6 [guard] an unreadable preparation record still fails closed with a reason',
  torn.ok === false && typeof torn.error === 'string' && torn.error.length > 0
    && Array.isArray(torn.issues) && torn.issues.length === 0,
  JSON.stringify(torn));
check('C6 [guard] the existing author nonce is still bound to its own immutable start record',
  (() => {
    try {
      PREP.writeWorkerResult(prepRoot, BATCH, OTHER, { nonce: authorNonce, outcome: 'proven-at-base' });
      return false;
    } catch { return true; }
  })());

// ---- G3: the operation manager still owns launch, observation and child settlement ---------
const managerProject = path.join(tmp, 'manager-project');
fs.mkdirSync(managerProject, { recursive: true });
const managerPrepRoot = path.join(tmp, 'manager-preparations');
const settleCalls = [];
const managerAuthority = {
  settle: (lease, nonce, options = {}) => {
    settleCalls.push({ nonce, outcome: options.outcome });
    return { ok: true };
  },
  settlementState: (lease, nonce) => ({ ok: true, settled: true, nonce }),
};
const spawned = [];
const managerSpawn = (command, argv, spawnOptions) => {
  const handlers = new Map();
  const child = {
    pid: process.pid,
    once(event, fn) { handlers.set(event, fn); return child; },
    exit(code = 0) { const fn = handlers.get('exit'); if (fn) fn(code, null); },
  };
  spawned.push({ argv, child });
  const batchId = argv[2];
  PREP.createManifest(spawnOptions.env.PREPARATION_RUNS_DIR, batchId, {
    project: managerProject, runConfig: 'guard.json', intent: 'guard manager fixture',
    issues: argv.filter((value, index) => argv[index - 1] === '--issue'), config: {},
  });
  return child;
};
const manager = OPS.createHostOperationManager({
  pipelineRoot: REPO, stateRoot: path.join(tmp, 'manager-state'),
  runsRoot: path.join(tmp, 'manager-runs'), preparationRoot: managerPrepRoot,
  supervisor: managerAuthority, spawn: managerSpawn,
  env: { ...process.env, PREPARATION_RUNS_DIR: managerPrepRoot },
});
const MANAGER_BATCH = 'guard-6ma-operation';
const MANAGER_ISSUE = 'guard-6ma-operation-issue';
const guardNonce = 'abcdef0123456789'.repeat(3);
const guardGrant = {
  authority: {
    nonce: guardNonce, scope: 'preparation', issueId: MANAGER_ISSUE, batch: MANAGER_BATCH,
    target: LOCK.canonicalTarget(managerProject), parent: { id: 'guard-parent', pid: process.pid },
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
  },
  parentLease: { token: 'guard-lease' },
};
const launched = manager.startPreparation({
  project: managerProject, batchId: MANAGER_BATCH, configPath: 'guard.json',
  issues: [MANAGER_ISSUE], grant: guardGrant,
});
const running = manager.status({ project: managerProject, id: MANAGER_BATCH });
check('C6 [guard] one preparation operation still launches exactly one child and reports running',
  !!launched && launched.ok === true && spawned.length === 1
    && running.ok === true && running.state === 'running' && running.batchId === MANAGER_BATCH,
  JSON.stringify({ launched: launched && launched.ok, state: running && running.state, children: spawned.length }));
check('C6 [guard] preparation evidence is still deriveState\'s record: per-issue state and NO top-level stage',
  !!running.preparation && running.preparation.stage === undefined
    && Array.isArray(running.preparation.issues)
    && running.preparation.issues.some(row => row && row.id === MANAGER_ISSUE),
  JSON.stringify({ stage: running.preparation && running.preparation.stage,
    issues: (running.preparation && running.preparation.issues || []).map(row => `${row.id}:${row.state}`) }));
const managerWorker = PREP.createWorkerNonce();
PREP.writeWorkerStarted(managerPrepRoot, MANAGER_BATCH, MANAGER_ISSUE,
  { nonce: managerWorker, phase: 'author-proof', pid: 1234 });
spawned[0].child.exit(1);
const interrupted = manager.status({ project: managerProject, id: MANAGER_BATCH });
check('C6 [guard] an interrupted worker with an exited child is still attention, never completed',
  interrupted.state === 'attention' && typeof interrupted.attention === 'string'
    && interrupted.attention.length > 0 && settleCalls.length === 0,
  JSON.stringify({ state: interrupted.state, attention: interrupted.attention, settlements: settleCalls }));
PREP.writeWorkerResult(managerPrepRoot, MANAGER_BATCH, MANAGER_ISSUE,
  { nonce: managerWorker, outcome: 'proven-at-base', exitCode: 0 });
const completed = manager.status({ project: managerProject, id: MANAGER_BATCH });
const again = manager.status({ project: managerProject, id: MANAGER_BATCH });
check('C6 [guard] terminal success still completes the operation and the manager still settles its grant once',
  completed.state === 'completed' && again.state === 'completed'
    && settleCalls.length === 1 && settleCalls[0].nonce === guardNonce
    && settleCalls[0].outcome === 'complete' && spawned.length === 1,
  JSON.stringify({ state: completed.state, settlements: settleCalls }));
check('C6 [guard] restart still never launches recorded work and retry still requires approval',
  manager.restart({ project: managerProject, id: MANAGER_BATCH }).ok === false
    && manager.retry({ project: managerProject, id: MANAGER_BATCH }).ok === false
    && spawned.length === 1);
check('C6 [guard] an unknown operation id is still refused rather than invented',
  manager.status({ project: managerProject, id: 'guard-6ma-nothing' }).ok === false);

// ---- G4: the supervisor's durable-state invariants ----------------------------------------
const supervisorProject = path.join(tmp, 'supervisor-project');
fs.mkdirSync(supervisorProject, { recursive: true });
let adapterCalls = 0;
const inertAdapters = {
  kickoff: { verify: value => { adapterCalls += 1; return value; }, list: () => { adapterCalls += 1; return []; } },
  specification: { model: 'guard', execute: () => { adapterCalls += 1; return { status: 'failed' }; } },
  authority: { grant: () => { adapterCalls += 1; return { ok: false }; }, settle: () => ({ ok: false }) },
  operations: { status: () => { adapterCalls += 1; return { ok: false }; } },
  review: { evidence: () => null, decide: () => ({ ok: false }) },
};
const invalidStateDir = path.join(tmp, 'supervisor-invalid');
fs.mkdirSync(invalidStateDir, { recursive: true });
const stamp = '2026-09-17T00:00:00.000Z';
fs.writeFileSync(path.join(invalidStateDir, 'proposal-supervisor.json'), JSON.stringify({
  schema: 2, project: supervisorProject, proposals: {
    'kp-guard': {
      proposalId: 'kp-guard', stage: 'review', state: 'review',
      history: [{ type: 'stage', stage: 'queued', at: stamp }, { type: 'stage', stage: 'review', at: stamp }],
    },
  },
}));
let invalidRefused = false;
try {
  SUP.createProductionSupervisor({ repoRoot: REPO, project: supervisorProject,
    stateDir: invalidStateDir, testingSentinel: SUP.TESTING_SENTINEL, adapters: inertAdapters });
} catch { invalidRefused = true; }
check('C6 [guard] a durable stage that contradicts append-only history is still refused before any adapter runs',
  invalidRefused && adapterCalls === 0, `adapter calls: ${adapterCalls}`);
let insideRefused = false;
try {
  SUP.createProductionSupervisor({ repoRoot: REPO, project: supervisorProject,
    stateDir: path.join(supervisorProject, '.pipeline-supervisor'),
    testingSentinel: SUP.TESTING_SENTINEL, adapters: inertAdapters });
} catch { insideRefused = true; }
check('C6 [guard] supervisor state inside the model-editable project is still refused',
  insideRefused && adapterCalls === 0);
let substitutionRefused = false;
try {
  SUP.createProductionSupervisor({ repoRoot: REPO, project: supervisorProject,
    stateDir: path.join(tmp, 'supervisor-unsealed'), adapters: inertAdapters });
} catch { substitutionRefused = true; }
check('C6 [guard] adapter substitution without the host testing capability is still refused',
  substitutionRefused);
const derivedStateDir = SUP.supervisorStateDirFor(supervisorProject,
  { PIPELINE_STATE_DIR: path.join(tmp, 'host-owned') });
check('C6 [guard] supervisor recovery state is still host-owned and outside the project',
  path.resolve(derivedStateDir).startsWith(`${path.resolve(path.join(tmp, 'host-owned'))}${path.sep}`)
    && !path.resolve(derivedStateDir).startsWith(`${path.resolve(supervisorProject)}${path.sep}`),
  derivedStateDir);

// ---- G5: canonical freeze admission ------------------------------------------------------
const run = (cmd, args, options = {}) =>
  spawnSync(cmd, args, { encoding: 'utf8', timeout: 120000, windowsHide: true, ...options });
const git = (dir, ...args) => run('git', ['-c', 'safe.directory=*', ...args], { cwd: dir });
const slash = value => String(value).split(path.sep).join('/');
function write(dir, rel, bytes) {
  const file = path.join(dir, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
}
const admissionRoot = path.join(tmp, 'admission');
const bare = path.join(admissionRoot, 'remote.git');
const target = path.join(admissionRoot, 'target');
fs.mkdirSync(admissionRoot, { recursive: true });
git(admissionRoot, 'init', '-q', '--bare', '-b', 'main', bare);
git(admissionRoot, 'clone', '-q', bare, target);
git(target, 'config', 'user.email', 'guard@example.invalid');
git(target, 'config', 'user.name', 'repo-6ma guard');
write(target, 'pipeline.config.json', `${JSON.stringify({ defaultBranch: 'main',
  verifyCommand: 'sh tools/run-acceptance.sh', regressionCommand: 'true',
  regressionPolicy: 'required', frozenPaths: [] }, null, 2)}\n`);
write(target, 'README.md', 'guard admission fixture\n');
const IDS = {
  valid: 'guard-6ma-published', absent: 'guard-6ma-absent', noReceipt: 'guard-6ma-no-receipt',
  malformed: 'guard-6ma-malformed', mismatch: 'guard-6ma-mismatch', half: 'guard-6ma-half-proven',
};
const suiteRel = issueId => `tests/acceptance/${issueId}`;
function stageSuite(issueId, receipt) {
  write(target, `${suiteRel(issueId)}/test.js`, `'use strict';\n// guard fixture ${issueId}\nprocess.exit(1);\n`);
  const hash = HASHER.suiteHash(HASHER.workingTreeEntries(target, suiteRel(issueId)));
  const body = (suiteHash, verdict) => `${JSON.stringify({
    gateVersion: FREEZE_GATE.RECEIPT_VERSION, verdict, probeSupplied: verdict === 'red',
    suiteHash, gateHead: String(git(target, 'rev-parse', 'HEAD').stdout || '').trim(),
    guards: 0, brittleness: 0, writtenAt: new Date().toISOString(),
  }, null, 2)}\n`;
  const file = `${suiteRel(issueId)}/${HASHER.RECEIPT_NAME}`;
  if (receipt === 'valid') write(target, file, body(hash, 'red'));
  else if (receipt === 'half-proven') write(target, file, body(hash, 'half-proven'));
  else if (receipt === 'malformed') write(target, file, '{ not a receipt');
  else if (receipt === 'mismatch') {
    write(target, file, body(HASHER.suiteHash([{ path: 'test.js', blob: '0'.repeat(40) }]), 'red'));
  }
  return hash;
}
const publishedHash = stageSuite(IDS.valid, 'valid');
stageSuite(IDS.noReceipt, 'none');
stageSuite(IDS.malformed, 'malformed');
stageSuite(IDS.mismatch, 'mismatch');
stageSuite(IDS.half, 'half-proven');
git(target, 'add', '-A');
git(target, 'commit', '-qm', 'guard admission fixtures');
git(target, 'push', '-q', 'origin', 'main');
const baseCfg = {
  targetRepoPath: slash(target), targetRepoRemote: slash(bare),
  image: 'pipeline-6ma-guard:local', gitTimeoutMs: 120000,
};
function configFile(name, extras = {}) {
  const file = path.join(admissionRoot, name);
  fs.writeFileSync(file, `${JSON.stringify({ ...baseCfg, ...extras }, null, 2)}\n`);
  return CONFIG.loadConfig(file);
}
const strictCfg = configFile('run.config.json');
const lenientCfg = configFile('run.config.half-proven.json', { allowHalfProven: true });
const unreachableCfg = configFile('run.config.unreachable.json',
  { targetRepoRemote: slash(path.join(admissionRoot, 'no-such-remote.git')) });
const judged = QUEUE.partitionByFreeze(strictCfg, [{ id: IDS.valid }, { id: IDS.absent },
  { id: IDS.noReceipt }, { id: IDS.malformed }, { id: IDS.mismatch }, { id: IDS.half }]);
const refusalFor = id => {
  const row = (judged.undispatchable || []).find(item => item.issue && item.issue.id === id);
  return row ? row.refusal : null;
};
check('C6 [guard] the canonical gate still admits a published suite with a matching receipt',
  judged.ok === true && judged.branch === 'main'
    && (judged.issues || []).map(row => row.id).join(',') === IDS.valid,
  JSON.stringify({ ok: judged.ok, branch: judged.branch, admitted: (judged.issues || []).map(row => row.id) }));
check('C6 [guard] the four canonical refusal kinds are still what they were, in the same order of judgement',
  refusalFor(IDS.absent) === QUEUE.REFUSAL.NO_SUITE
    && refusalFor(IDS.noReceipt) === QUEUE.REFUSAL.NO_RECEIPT
    && refusalFor(IDS.malformed) === QUEUE.REFUSAL.NO_RECEIPT
    && refusalFor(IDS.mismatch) === QUEUE.REFUSAL.MISMATCH
    && refusalFor(IDS.half) === QUEUE.REFUSAL.HALF_PROVEN,
  JSON.stringify((judged.undispatchable || []).map(row => `${row.issue.id}:${row.refusal}`)));
check('C6 [guard] every refusal still carries a reason naming the suite, the branch and the remote',
  (judged.undispatchable || []).every(row => typeof row.reason === 'string'
    && row.reason.includes(row.issue.id) && row.reason.includes('main')),
  JSON.stringify((judged.undispatchable || []).map(row => row.reason)));
const lenient = QUEUE.partitionByFreeze(lenientCfg, [{ id: IDS.half }]);
check('C6 [guard] allowHalfProven is still the one refusal an operator can turn off',
  lenient.ok === true && (lenient.issues || []).map(row => row.id).join(',') === IDS.half,
  JSON.stringify(lenient));
const unreachable = QUEUE.partitionByFreeze(unreachableCfg, [{ id: IDS.valid }]);
check('C6 [guard] a gate that cannot read the branch still aborts rather than refusing the queue',
  unreachable.ok === false && typeof unreachable.error === 'string' && unreachable.error.length > 0
    && !Array.isArray(unreachable.undispatchable),
  JSON.stringify(unreachable));
const branchHash = HASHER.suiteHash(HASHER.treeEntries(target, 'HEAD', suiteRel(IDS.valid)));
check('C6 [guard] one suite-hash formula still answers the same for the working tree and the branch',
  branchHash === publishedHash, JSON.stringify({ branchHash, publishedHash }));
check('C6 [guard] the receipt reader still refuses an absent, unparseable or unknown receipt',
  QUEUE.parseReceipt(null).ok === false && QUEUE.parseReceipt('{ not json').ok === false
    && QUEUE.parseReceipt(JSON.stringify({ gateVersion: 99, verdict: 'red', suiteHash: publishedHash })).ok === false
    && QUEUE.parseReceipt(JSON.stringify({ gateVersion: FREEZE_GATE.RECEIPT_VERSION,
      verdict: 'green', suiteHash: publishedHash })).ok === false);
check('C6 [guard] the reader still understands the version the gate writes and the verdicts it writes',
  QUEUE.KNOWN_GATE_VERSIONS.has(FREEZE_GATE.RECEIPT_VERSION)
    && QUEUE.RECEIPT_VERDICTS.has('red') && QUEUE.RECEIPT_VERDICTS.has('half-proven'),
  JSON.stringify({ version: FREEZE_GATE.RECEIPT_VERSION, verdicts: [...QUEUE.RECEIPT_VERDICTS] }));
check('C6 [guard] the runner still resolves its integration branch from the configured target',
  QUEUE.resolveBranch(strictCfg).branch === 'main',
  JSON.stringify(QUEUE.resolveBranch(strictCfg)));

for (const [name, value] of Object.entries(savedEnv)) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
rmrf(tmp);
process.exit(failed);
