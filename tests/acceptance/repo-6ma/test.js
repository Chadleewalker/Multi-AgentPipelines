// Frozen acceptance test — repo-6ma: connect real preparation to human-approved freeze and
// conveyor dispatch. This is the RED half of the suite. The file beside it, `guard.js`, is the
// only one that declares itself a pinned-green file, and it carries the "relevant existing
// behaviour stays covered" half of C6. Nothing in THIS file is pinned green; this file must be
// red at the fork point, and the literal marker `guard.js` carries is deliberately absent here.
//
// PAIRING, BOTH DIRECTIONS. Every check below is labelled with the criterion it serves, and
// every criterion is named by at least one check here or in `guard.js`:
//
//   C1  real preparation states drive the proposal stage   -> A1-A10, A13, A14
//   C2  completion, child settlement and published freeze
//       are separately durable; a stranded `criticizing`
//       journal resumes forward                            -> B1-B4, B6-B12, R1, R4
//   C3  production publication observation is canonical    -> P1-P6, A11, B5
//   C4  admission evidence, one shared-feed assignment,
//       no duplicate work across restarts                  -> D1-D8, R2, R3
//   C5  adverse preparation and operation attention        -> E1-E10
//   C6  the composed behavioural proof, and no synthetic
//       receipt trust in production                        -> section A is that composition,
//                                                             plus A12; coverage -> guard.js
//
// WHY THIS FILE IS RED TODAY (the reproduced defect, C6's "fails on today's stuck
// `criticizing`"). `preparation-state.deriveState` answers with `issues[].state`; the
// supervisor's `poll-preparation` reads a TOP-LEVEL `preparation.stage` that the real operation
// manager never produces. `advancePreparationStage(id, undefined)` advances nothing, the
// completion event is journalled anyway, and the proposal is stranded at `criticizing` for
// good. Section A composes the real writers, the real reader, the real operation manager and
// the production publication observer and watches that happen.
//
// THE CONTRACT THIS SUITE FREEZES. Additions on modules this task owns, and nothing else:
//
//   productionAdapters(repoRoot, options).publication.observe({ project, issueId })
//     — the production publication observer. It asks canonical `queue.partitionByFreeze`
//       (runner/queue.js) about the EXACT issue against the configured target, and never
//       parses a receipt, hashes a suite or resolves a branch a second time. It may answer
//       synchronously or with a promise; every caller here awaits it. It answers:
//         admitted    { ok: true,  published: true,  target, issueId, branch,
//                       suiteHash, gateVersion, verdict }
//         refused     { ok: true,  published: false, refusal, reason, target, issueId, branch }
//         unavailable { ok: false, published: false, available: false, error }
//       `target` is `lock.canonicalTarget(project)`; `refusal` and `reason` are the canonical
//       kind and sentence `partitionByFreeze` produced, copied, not re-worded.
//
//   status(id).preparation — null until a preparation operation exists, then
//       { operationId, batchId, issueId, state, operationState, attention }
//     `state` is the EXACT `deriveState` issue state for this proposal's own issue
//     ('pending' | 'authoring' | 'proving' | a worker outcome such as 'proven-at-base' |
//     'interrupted-unknown'), or 'unavailable' when the preparation record cannot be read, or
//     'absent' when the batch manifest does not carry this proposal's issue at all.
//     `operationState` is the operation manager's own state; `attention` its sentence or null.
//   status(id).publication — null until the first observation, then that evidence verbatim.
//
//   THE JOURNAL. The existing append-only event names stay what they are — `stage`,
//   `preparation.granted|started|observed|completed|settled`, `proposal.assigned` — and the
//   publication evidence is journalled VERBATIM, so the line that persists an admitted
//   observation carries `"published":true`. Section R interrupts immediately after the
//   selected append is fsynced, before later authority or operation side effects can occur.
//
// EXPENSIVE EXECUTION IS SUBSTITUTED, NOTHING ELSE IS (C6). The preparation child and the feed
// child are not spawned: `createHostOperationManager`'s existing `spawn` seam stands in for
// them, and the fake preparation child does what the real one does first — allocate its
// immutable manifest. The specification lane is substituted for the same reason (no provider
// credentials, no model). Everything that decides anything is real: `runner/preparation-state.js`
// writers and `deriveState`, `runner/operation-manager.js`, `runner/proposal-supervisor.js`,
// `runner/supervisor.js` grants and settlement, `runner/queue.js` admission, and local Git bare
// remotes for publication.
//
// EVERY AUTHORITY IS RE-AIMED at a disposable temp tree — PIPELINE_GLOBAL_LOCK_DIR,
// PREPARATION_RUNS_DIR, PIPELINE_STATE_DIR and a `bd` that cannot exist — so running this file
// can never disturb a live run on the same machine. No network, no container engine.
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..', '..');
const PREP = require(path.join(REPO, 'runner', 'preparation-state.js'));
const LOCK = require(path.join(REPO, 'runner', 'lock.js'));
const AUTH = require(path.join(REPO, 'runner', 'supervisor.js'));
const QUEUE = require(path.join(REPO, 'runner', 'queue.js'));
const HASHER = require(path.join(REPO, 'runner', 'suite-hash.js'));
const CONFIG = require(path.join(REPO, 'runner', 'config.js'));
const FREEZE_GATE = require(path.join(REPO, 'scripts', 'freeze-gate.js'));
const OPS = require(path.join(REPO, 'runner', 'operation-manager.js'));

let failed = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'ok' : 'FAIL'} - ${name}${ok || !detail ? '' : ` — ${detail}`}`);
  if (!ok) failed = 1;
}

// ---- the canonical seams this suite watches, wrapped before the module under test loads -----
// `partitionByFreeze` is wrapped on the module object rather than inspected as source, so
// "production observation CALLS the canonical gate" is a fact about the run instead of a fact
// about spelling. The wrapper delegates, so every answer below is the real gate's answer.
// `afterPartition` fires the instant a canonical admission has returned and before its caller
// can look at anything else — that is how C3/P6 tells identity captured IN the admission apart
// from a separate later metadata read.
const gateCalls = [];
let afterPartition = null;
const canonicalPartition = QUEUE.partitionByFreeze;
QUEUE.partitionByFreeze = function watched(cfg, candidates) {
  const answer = canonicalPartition.call(this, cfg, candidates);
  gateCalls.push({
    targetRepoPath: cfg && cfg.targetRepoPath,
    targetRepoRemote: cfg && cfg.targetRepoRemote,
    ids: (Array.isArray(candidates) ? candidates : []).map(row => row && row.id),
  });
  if (afterPartition) { const fire = afterPartition; afterPartition = null; fire(answer); }
  return answer;
};
// Child settlement is the operation manager's, and a second independent settlement of one grant
// is what C2 forbids. EVERY attempt is counted — accepted, rejected and uncertain alike.
const settlements = [];
const canonicalSettle = AUTH.settle;
AUTH.settle = function counted(lease, nonce, options = {}) {
  let answer;
  try { answer = canonicalSettle.call(this, lease, nonce, options); }
  catch (error) {
    settlements.push({ nonce: String(nonce), outcome: options.outcome, ok: false, threw: true });
    throw error;
  }
  settlements.push({ nonce: String(nonce), outcome: options.outcome, ok: !!(answer && answer.ok) });
  return answer;
};
const SUP = require(path.join(REPO, 'runner', 'proposal-supervisor.js'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-6ma-'));
const savedEnv = {
  PIPELINE_GLOBAL_LOCK_DIR: process.env.PIPELINE_GLOBAL_LOCK_DIR,
  PREPARATION_RUNS_DIR: process.env.PREPARATION_RUNS_DIR,
  PIPELINE_STATE_DIR: process.env.PIPELINE_STATE_DIR,
  PIPELINE_BD_CMD: process.env.PIPELINE_BD_CMD,
  PIPELINE_CHILD_AUTHORITY: process.env.PIPELINE_CHILD_AUTHORITY,
  NODE_OPTIONS: process.env.NODE_OPTIONS,
  ACCEPT_6MA_BD_ROWS: process.env.ACCEPT_6MA_BD_ROWS,
};
const NO_BD = path.join(tmp, 'no-such-bd-binary');
process.env.PIPELINE_GLOBAL_LOCK_DIR = path.join(tmp, 'host-locks');
process.env.PREPARATION_RUNS_DIR = path.join(tmp, 'preparations');
process.env.PIPELINE_STATE_DIR = path.join(tmp, 'host-state');
process.env.PIPELINE_BD_CMD = NO_BD;
delete process.env.PIPELINE_CHILD_AUTHORITY;

// ---- small helpers -------------------------------------------------------------------------
const sha = value => `sha256:${crypto.createHash('sha256')
  .update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')}`;
const slash = value => String(value).split(path.sep).join('/');
function run(cmd, args, options = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', timeout: 120000, windowsHide: true, ...options });
}
const git = (dir, ...args) => run('git', ['-c', 'safe.directory=*', ...args], { cwd: dir });
function write(dir, rel, bytes) {
  const file = path.join(dir, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
}
function rmrf(target) {
  try { fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  catch { /* disposable */ }
}
function journalFile(stateDir) { return path.join(stateDir, 'events.jsonl'); }
function journalLines(stateDir) {
  let text = '';
  try { text = fs.readFileSync(journalFile(stateDir), 'utf8'); }
  catch { return []; }
  return text.split(/\r?\n/).filter(Boolean);
}
function journal(stateDir) {
  return journalLines(stateDir).map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}
// Interrupt the actual append, not a later completed tick. All other durable stores remain
// exactly as they stood at this boundary: no journal truncation can orphan a later grant.
async function interruptAfterAppend(stateDir, predicate, action) {
  const target = path.resolve(journalFile(stateDir));
  const originalOpen = fs.openSync;
  const originalClose = fs.closeSync;
  const originalFsync = fs.fsyncSync;
  const journalDescriptors = new Set();
  const interruption = new Error('fixture: interrupted after durable journal append');
  let interrupted = false;
  fs.openSync = function watchedOpen(file, ...args) {
    const fd = originalOpen.call(this, file, ...args);
    if (typeof file === 'string' && path.resolve(file) === target) journalDescriptors.add(fd);
    return fd;
  };
  fs.closeSync = function watchedClose(fd) {
    try { return originalClose.call(this, fd); }
    finally { journalDescriptors.delete(fd); }
  };
  fs.fsyncSync = function watchedFsync(fd) {
    const result = originalFsync.call(this, fd);
    if (!interrupted && journalDescriptors.has(fd)) {
      const line = journalLines(stateDir).at(-1);
      const event = line ? JSON.parse(line) : null;
      if (event && predicate(event, line)) {
        interrupted = true;
        throw interruption;
      }
    }
    return result;
  };
  try { await action(); }
  catch (error) { if (error !== interruption) throw error; }
  finally {
    fs.openSync = originalOpen;
    fs.closeSync = originalClose;
    fs.fsyncSync = originalFsync;
  }
  return interrupted;
}
// Any object anywhere inside the journal that satisfies the predicate. Name-agnostic on
// purpose: C4 is about the FACTS the evidence carries, not about the event label chosen for it.
function deepFind(value, predicate) {
  const stack = [value];
  while (stack.length) {
    const item = stack.pop();
    if (!item || typeof item !== 'object') continue;
    if (!Array.isArray(item) && predicate(item)) return item;
    for (const child of Object.values(item)) stack.push(child);
  }
  return null;
}
const stagesOf = status => (status && Array.isArray(status.history) ? status.history : [])
  .filter(event => event.type === 'stage').map(event => event.stage);
const countStage = (status, stage) => stagesOf(status).filter(value => value === stage).length;
const isPrefix = (before, after) => JSON.stringify(after.slice(0, before.length)) === JSON.stringify(before);
const settledOk = nonce => settlements.filter(row => row.nonce === nonce && row.ok).length;
const settleAttempts = nonce => settlements.filter(row => row.nonce === nonce).length;
const NO_MUTATION = JSON.stringify({ retry: 0, reconcile: 0, recoverLaunch: 0, restart: 0, stop: 0 });
// Counted so the C5 ownership check can state, as a fact and not as a promise, that no cleanup
// in this file released the lease the production owner is supposed to release itself.
let suiteLeaseReleases = 0;
const fixtureMirrors = [];

// ---- local Git publication fixtures --------------------------------------------------------
// A bare remote is the integration branch; the working clone is the operator's desk. Nothing
// here talks to a network: `targetRepoRemote` is a local bare repository path, which is exactly
// what `partitionByFreeze` fetches from.
function remoteFixture(name, configExtras = {}) {
  const root = path.join(tmp, `git-${name}`);
  const bare = path.join(root, 'remote.git');
  const target = path.join(root, 'target');
  fs.mkdirSync(root, { recursive: true });
  git(root, 'init', '-q', '--bare', '-b', 'main', bare);
  git(root, 'clone', '-q', bare, target);
  git(target, 'config', 'user.email', 'fixture@example.invalid');
  git(target, 'config', 'user.name', 'repo-6ma fixture');
  write(target, 'pipeline.config.json', `${JSON.stringify({
    defaultBranch: 'main', verifyCommand: 'sh tools/run-acceptance.sh',
    regressionCommand: 'true', regressionPolicy: 'required', frozenPaths: [],
  }, null, 2)}\n`);
  write(target, 'README.md', `repo-6ma fixture ${name}\n`);
  git(target, 'add', '-A'); git(target, 'commit', '-qm', 'integration base');
  git(target, 'push', '-q', 'origin', 'main');
  const cfgFile = path.join(root, 'run.config.json');
  const cfg = {
    targetRepoPath: slash(target), targetRepoRemote: slash(bare),
    image: 'pipeline-6ma-fixture:local', gitTimeoutMs: 120000, bdTimeoutMs: 15000,
    ...configExtras,
  };
  fs.writeFileSync(cfgFile, `${JSON.stringify(cfg, null, 2)}\n`);
  return { root, bare, target, cfgFile };
}
const suiteRel = issueId => `tests/acceptance/${issueId}`;
// The suite hash as the branch will hold it — the shared formula, from the same module the
// gate and the runner both use, never a literal typed here.
const hashSuiteInTree = (fx, issueId) =>
  HASHER.suiteHash(HASHER.workingTreeEntries(fx.target, suiteRel(issueId)));
function receiptBody(fx, hash, verdict = 'red') {
  return {
    gateVersion: FREEZE_GATE.RECEIPT_VERSION, verdict, probeSupplied: verdict === 'red',
    suiteHash: hash, gateHead: String(git(fx.target, 'rev-parse', 'HEAD').stdout || '').trim(),
    guards: 0, brittleness: 0, writtenAt: new Date().toISOString(),
  };
}
// Stage one issue's suite into the working clone. `receipt` selects which admission rule the
// fixture is exercising; `salt` changes the suite bytes, and so its hash, for the identity
// discrimination in C3/P6. The caller commits and pushes when the branch should hold it.
function stageSuite(fx, issueId, receipt = 'valid', salt = '') {
  write(fx.target, `${suiteRel(issueId)}/test.js`,
    `'use strict';\n// frozen fixture suite for ${issueId}${salt}\nprocess.exit(1);\n`);
  const hash = hashSuiteInTree(fx, issueId);
  const file = `${suiteRel(issueId)}/${HASHER.RECEIPT_NAME}`;
  if (receipt === 'malformed') write(fx.target, file, '{ this is not a receipt');
  else if (receipt === 'mismatch') write(fx.target, file, `${JSON.stringify(receiptBody(fx, HASHER.suiteHash([{ path: 'test.js', blob: '0'.repeat(40) }])), null, 2)}\n`);
  else if (receipt === 'half-proven') write(fx.target, file, `${JSON.stringify(receiptBody(fx, hash, 'half-proven'), null, 2)}\n`);
  else if (receipt === 'valid') write(fx.target, file, `${JSON.stringify(receiptBody(fx, hash), null, 2)}\n`);
  return hash;
}
function commitAndPush(fx, message, push = true) {
  git(fx.target, 'add', '-A');
  git(fx.target, 'commit', '-qm', message);
  if (push) git(fx.target, 'push', '-q', 'origin', 'main');
  return String(git(fx.target, 'rev-parse', 'HEAD').stdout || '').trim();
}
const remoteHead = fx => String(git(fx.root, 'ls-remote', fx.bare, 'refs/heads/main').stdout || '').trim();
// The canonical answer, straight from `runner/queue.js`, for comparison with what the
// production observer reports. This is the sentence and the kind the runner itself uses.
function canonicalAdmission(cfgFile, issueId) {
  const answer = canonicalPartition(CONFIG.loadConfig(cfgFile), [{ id: issueId }]);
  if (!answer.ok) return { ok: false, error: answer.error };
  const refused = (answer.undispatchable || [])[0];
  return {
    ok: true, branch: answer.branch, dispatchable: !refused,
    refusal: refused ? refused.refusal : null, reason: refused ? refused.reason : null,
    suiteHash: refused ? refused.suiteHash : null,
  };
}

// ---- one composed world: preparation records, operation manager, supervisor, publication ----
function world(name, options = {}) {
  const fx = remoteFixture(name, options.config);
  const fixtureHostRoot = path.join(tmp, 'pipeline-host');
  const prepRoot = path.join(tmp, `prep-${name}`);
  const opsRoot = path.join(tmp, `ops-${name}`);
  const runsRoot = path.join(tmp, `runs-${name}`);
  const stateDir = path.join(tmp, `state-${name}`);
  const count = Math.max(1, options.proposals || 1);
  const proposalIds = [];
  const issueIds = [];
  const records = [];
  for (let n = 1; n <= count; n += 1) {
    const proposalId = count === 1 ? `kp-6ma-${name}` : `kp-6ma-${name}-${n}`;
    const issueId = count === 1 ? `issue-6ma-${name}` : `issue-6ma-${name}-${n}`;
    proposalIds.push(proposalId);
    issueIds.push(issueId);
    records.push(Object.freeze({
      version: 'kickoff-intake/1', id: proposalId, target: fx.target,
      hash: sha(`intent for ${proposalId}`), intent: JSON.stringify({ title: `idea ${name} ${n}` }),
      createdAt: '2026-09-17T00:00:00.000Z',
    }));
  }
  const issueOfProposal = new Map(proposalIds.map((id, index) => [id, issueIds[index]]));
  const decoyId = `decoy-6ma-${name}`;
  const spawns = [];
  const calls = { specification: 0 };
  const mutations = { retry: 0, reconcile: 0, recoverLaunch: 0, restart: 0, stop: 0 };
  let blockFeed = options.blockFirstFeed === true;

  // The seam that stands in for the expensive child. The preparation child's first durable act
  // is its immutable manifest, so the stand-in performs exactly that and nothing else.
  const spawn = (command, argv, spawnOptions) => {
    const handlers = new Map();
    const child = {
      pid: process.pid,
      once(event, fn) { handlers.set(event, fn); return child; },
      exit(code = 0) { const fn = handlers.get('exit'); if (fn) fn(code, null); },
    };
    const kind = String(argv[0]).includes('prepare-batch') ? 'preparation' : 'implementation';
    const entry = { kind, argv, child };
    if (kind === 'preparation') {
      entry.batchId = argv[2];
      const named = argv.filter((value, index) => argv[index - 1] === '--issue');
      PREP.createManifest(spawnOptions.env.PREPARATION_RUNS_DIR, entry.batchId, {
        project: fx.target, runConfig: fx.cfgFile, intent: 'repo-6ma fixture batch',
        issues: options.manifestIssues
          ? options.manifestIssues({ issueId: issueIds[0], decoyId }) : named,
        config: {},
      });
    }
    spawns.push(entry);
    return child;
  };
  // The uncertain-settlement fixture answers as a parent whose result could not be learned. It
  // records its own attempt, so "every settlement attempt is counted" stays true of it too.
  const managerAuthority = options.uncertainSettlement
    ? {
      ...AUTH,
      settle(lease, nonce, settleOptions = {}) {
        settlements.push({ nonce: String(nonce), outcome: settleOptions.outcome, ok: false, uncertain: true });
        return { ok: false, uncertain: true, error: 'fixture: the settlement result is uncertain' };
      },
    }
    : AUTH;
  const manager = OPS.createHostOperationManager({
    pipelineRoot: REPO, stateRoot: opsRoot, runsRoot, preparationRoot: prepRoot,
    supervisor: managerAuthority, spawn,
    env: { ...process.env, PREPARATION_RUNS_DIR: prepRoot },
  });
  // Every recovery verb the criteria forbid a tick from using, counted rather than removed: a
  // missing method would be an error the supervisor could blame, a counted one cannot hide.
  const operations = {
    startPreparation: input => manager.startPreparation(input),
    startImplementation: input => {
      if (blockFeed) {
        blockFeed = false;
        throw new Error('fixture: the controller was interrupted before the feed launched');
      }
      return manager.startImplementation(input);
    },
    status: input => manager.status(input),
    stop: input => { mutations.stop += 1; return manager.stop(input); },
    retry: input => { mutations.retry += 1; return manager.retry(input); },
    reconcile: input => { mutations.reconcile += 1; return manager.reconcile(input); },
    recoverLaunch: input => { mutations.recoverLaunch += 1; return manager.recoverLaunch(input); },
    restart: input => { mutations.restart += 1; return manager.restart(input); },
  };
  // The production adapters are built from whichever lease owns this project. An owner world
  // leaves that to `openProjectSupervisor`, which is the production acquire/close path C5 asks
  // for; every other world takes the lease itself, because it drives `createProductionSupervisor`
  // directly. Either way `authority` and `publication` below are the PRODUCTION ones.
  let lease = null;
  let production = null;
  function recordMirror() {
    const disposable = LOCK.lockPath(fixtureHostRoot, fx.target);
    const realCheckout = LOCK.lockPath(REPO, fx.target);
    fixtureMirrors.push({ disposable, realCheckout });
    check(`C6 fixture ${name} keeps its observer mirror inside disposable host state`,
      lease && lease.ownership && lease.ownership.observerFile === disposable
        && fs.existsSync(disposable) && !fs.existsSync(realCheckout));
  }
  if (options.owner !== true) {
    const held = AUTH.acquire(fixtureHostRoot, fx.target, `accept-6ma-${name}`);
    if (!held.ok) throw new Error(`fixture could not lease ${fx.target}: ${held.reason || 'held'}`);
    lease = held.lease;
    recordMirror();
  }
  function base() {
    if (!production) {
      if (!lease) throw new Error('fixture: the production adapters have no lease yet');
      production = SUP.productionAdapters(fixtureHostRoot, {
        configPath: fx.cfgFile, lease, runsRoot,
        operationStateRoot: path.join(opsRoot, 'adapters'),
      });
    }
    return production;
  }
  const specification = {
    model: 'accept-6ma-planner',
    async execute(kickoffRecord) {
      calls.specification += 1;
      const issueId = issueOfProposal.get(kickoffRecord.id) || issueIds[0];
      const proposal = {
        status: 'ready', title: `spec ${kickoffRecord.id}`, spec: `build ${kickoffRecord.id}`,
        acceptanceCriteria: ['the conveyor waits for a published freeze'],
        designReferences: ['DESIGN.md#3.10'], difficulty: 'hard',
        fieldIntentRefs: {
          title: `${kickoffRecord.hash}#/title`, spec: `${kickoffRecord.hash}#/description`,
          acceptanceCriteria: `${kickoffRecord.hash}#/constraints`,
        },
      };
      return {
        status: 'ready', issueId, model: 'accept-6ma-planner', tokens: { input: 1, output: 1 },
        receipt: { kickoffHash: kickoffRecord.hash, specHash: sha(proposal), issueId, proposal },
      };
    },
    async answer() { return { status: 'refused' }; },
  };
  const adapters = {
    kickoff: { verify: value => value, list: () => records.slice() },
    specification,
    operations,
    review: { evidence: () => null, decide: () => ({ ok: false, error: 'not part of repo-6ma' }) },
    get authority() { return base().authority; },
    get publication() { return base().publication; },
  };
  const common = extra => ({
    repoRoot: fixtureHostRoot, project: fx.target, stateDir, configPath: fx.cfgFile,
    testingSentinel: SUP.TESTING_SENTINEL, adapters, globalConcurrency: 2, runsRoot,
    availableTokens: () => ({ input: 1000, output: 500 }), ...extra,
  });
  return {
    fx, prepRoot, stateDir, spawns, calls, mutations, manager, adapters,
    decoyId, records, proposalIds, issueIds,
    record: records[0], proposalId: proposalIds[0], issueId: issueIds[0],
    batchId: `proposal-${proposalIds[0]}`,
    batchOf(index = 0) { return `proposal-${proposalIds[index]}`; },
    get lease() { return lease; },
    build: extra => SUP.createProductionSupervisor(common(extra)),
    open(extra) {
      const opened = SUP.openProjectSupervisor(common({
        supervisorId: `accept-6ma-owner-${name}`, ...extra,
      }));
      if (opened && opened.lease) { lease = opened.lease; recordMirror(); }
      return opened;
    },
    releaseFeedBlock() { blockFeed = false; },
    prepared: kind => spawns.filter(entry => entry.kind === kind),
    grantNonce(index = 0) {
      const granted = journal(stateDir).find(event => event.type === 'preparation.granted'
        && event.proposalId === proposalIds[index]);
      return granted && granted.grant && granted.grant.authority
        ? granted.grant.authority.nonce : null;
    },
    startWorker(phase, id = issueIds[0], live = true, batch = `proposal-${proposalIds[0]}`) {
      const nonce = PREP.createWorkerNonce();
      PREP.writeWorkerStarted(prepRoot, batch, id, live
        ? { nonce, phase, pid: process.pid, process: LOCK.livenessFields(process.pid) }
        : { nonce, phase, pid: 1234 });
      return nonce;
    },
    finishWorker(nonce, outcome, id = issueIds[0], data = {}, batch = `proposal-${proposalIds[0]}`) {
      return PREP.writeWorkerResult(prepRoot, batch, id, {
        nonce, outcome, exitCode: outcome === 'proven-at-base' ? 0 : 1, data,
      });
    },
    exitChild(kind = 'preparation', code = 0, batch = null) {
      const pool = spawns.filter(entry => entry.kind === kind
        && (batch === null || entry.batchId === batch));
      const entry = pool.at(-1);
      if (entry) entry.child.exit(code);
    },
    observedPreparation(index = 0) {
      const answer = this.manager.status({ project: fx.target, id: this.batchOf(index) });
      return answer && answer.preparation ? answer.preparation : null;
    },
  };
}

async function ticks(supervisor, turns = 1) {
  for (let index = 0; index < turns; index += 1) await supervisor.tick();
}
// Ticking across a modelled interruption: a tick that throws is the interruption, not a suite
// failure, so it is recorded and the loop stops.
async function tickSafely(supervisor, turns = 1) {
  const errors = [];
  for (let index = 0; index < turns; index += 1) {
    try { await supervisor.tick(); }
    catch (error) { errors.push((error && error.message) || String(error)); break; }
  }
  return errors;
}
async function tickUntil(supervisor, id, predicate, turns = 8) {
  let status = await supervisor.status(id);
  for (let index = 0; index < turns && !predicate(status); index += 1) {
    await supervisor.tick();
    status = await supervisor.status(id);
  }
  return status;
}
async function tickUntilSafely(supervisor, predicate, turns = 8) {
  for (let index = 0; index < turns; index += 1) {
    if (predicate()) return true;
    try { await supervisor.tick(); }
    catch { return predicate(); }
  }
  return predicate();
}
const issueStateOf = status => (status && status.preparation ? status.preparation.state : null);
const publicationOf = status => (status && status.publication ? status.publication : null);
const namesPublication = text => typeof text === 'string'
  && /publi/i.test(text) && /(approv|human|freeze)/i.test(text);
const namesRecovery = text => typeof text === 'string'
  && /(recover|authoriz|acknowledg|inspect|attention|reconcil|re-?prove|re-?run)/i.test(text);
const hasPublishedLine = stateDir => journalLines(stateDir).some(line => /"published"\s*:\s*true/.test(line));

// The six facts C4 requires to travel together. `paths alone are insufficient` is stated here
// as VALUES: a digest that is really a digest, a gate version that is really the number the
// gate writes, and a verdict word — never a file path standing in for any of them.
function admissionEvidenceIn(stateDir, facts) {
  return deepFind(journal(stateDir), row => row.target === facts.target
    && row.issueId === facts.issueId && row.branch === facts.branch
    && typeof row.suiteHash === 'string' && /^[0-9a-f]{40,128}$/.test(row.suiteHash)
    && row.suiteHash === facts.suiteHash
    && row.gateVersion === FREEZE_GATE.RECEIPT_VERSION && row.verdict === facts.verdict);
}

async function main() {
  // =========================================================================================
  // SECTION A — C1, and the composed behavioural proof C6 asks for. Real preparation writers,
  // the real `deriveState` reader, the real operation manager, the production publication
  // observer and a local bare remote. This is the section stuck at `criticizing` today.
  // =========================================================================================
  const a = world('happy', { manifestIssues: ids => [ids.issueId, ids.decoyId] });
  const supervisor = a.build();
  await supervisor.submit(a.record);
  await ticks(supervisor, 1);
  let status = await supervisor.status(a.proposalId);
  check('C1/A1 the production composition exposes a publication observer on productionAdapters',
    a.adapters.publication && typeof a.adapters.publication.observe === 'function',
    `publication: ${JSON.stringify(a.adapters.publication || null)}`);
  check('C1/A2 one specification launch reaches criticizing and starts exactly one preparation operation',
    status.stage === 'criticizing' && a.calls.specification === 1
      && a.prepared('preparation').length === 1 && a.prepared('implementation').length === 0
      && issueStateOf(status) === 'pending',
    JSON.stringify({ stage: status.stage, calls: a.calls, spawns: a.spawns.length,
      preparation: status.preparation }));
  check('C1/A3 status reports the real preparation operation and its exact issue',
    status.preparation && status.preparation.issueId === a.issueId
      && status.preparation.batchId === a.batchId
      && typeof status.preparation.operationId === 'string'
      && status.preparation.operationState === 'running',
    JSON.stringify(status.preparation || null));

  // A live authoring worker, written by the real writer, is what `authoring` means.
  const authorNonce = a.startWorker('author');
  const decoyNonce = a.startWorker('author-proof', a.decoyId);
  a.finishWorker(decoyNonce, 'proven-at-base', a.decoyId);
  status = await tickUntil(supervisor, a.proposalId, row => row.stage === 'authoring-tests');
  check('C1/A4 a live authoring worker advances the proposal to authoring-tests',
    status.stage === 'authoring-tests' && issueStateOf(status) === 'authoring'
      && typeof authorNonce === 'string',
    JSON.stringify({ stage: status.stage, preparation: status.preparation }));
  check('C1/A5 another issue\'s successful result never advances this proposal',
    status.stage === 'authoring-tests' && countStage(status, 'proving') === 0
      && countStage(status, 'freezing') === 0,
    JSON.stringify(stagesOf(status)));

  const proofNonce = a.startWorker('proof');
  status = await tickUntil(supervisor, a.proposalId, row => row.stage === 'proving');
  check('C1/A6 a live proof worker advances the proposal to proving',
    status.stage === 'proving' && issueStateOf(status) === 'proving',
    JSON.stringify({ stage: status.stage, preparation: status.preparation }));

  // Success. The worker result deliberately CLAIMS a freeze receipt in its own payload: a
  // preparation artifact saying "freeze receipt" is not a published freeze (C6).
  a.finishWorker(proofNonce, 'proven-at-base', a.issueId, { freezeReceipt: 'forged-6ma-receipt' });
  a.exitChild('preparation');
  status = await tickUntil(supervisor, a.proposalId, row => row.stage === 'freezing');
  const observed = a.observedPreparation();
  check('C1/A7 a successful proven-at-base result advances the proposal to freezing',
    status.stage === 'freezing' && issueStateOf(status) === 'proven-at-base'
      && JSON.stringify(stagesOf(status)).includes('authoring-tests'),
    JSON.stringify({ stage: status.stage, stages: stagesOf(status), preparation: status.preparation }));
  check('C1/A8 the stage is read from the per-issue record, with no synthetic top-level stage',
    !!observed && observed.stage === undefined && Array.isArray(observed.issues)
      && observed.issues.some(row => row && row.id === a.issueId && row.state === 'proven-at-base')
      && issueStateOf(status) === (observed.issues.find(row => row.id === a.issueId) || {}).state,
    JSON.stringify({ topLevelStage: observed && observed.stage, reported: issueStateOf(status),
      states: ((observed && observed.issues) || []).map(row => `${row.id}:${row.state}`) }));
  check('C1/A9 status names the human approval and publication action that is now required',
    namesPublication(status.nextAction) && !/^advance /i.test(String(status.nextAction || '')),
    String(status.nextAction));
  check('C1/A10 no implementation starts while publication is absent',
    status.stage === 'freezing' && a.prepared('implementation').length === 0
      && countStage(status, 'ready') === 0 && countStage(status, 'implementing') === 0,
    JSON.stringify({ stage: status.stage, spawns: a.spawns.map(entry => entry.kind) }));
  const absentSuite = canonicalAdmission(a.fx.cfgFile, a.issueId);
  check('C3/A11 the canonical refusal for the unpublished suite is what status reports',
    !!publicationOf(status) && publicationOf(status).published === false
      && publicationOf(status).refusal === absentSuite.refusal
      && publicationOf(status).reason === absentSuite.reason
      && publicationOf(status).issueId === a.issueId,
    JSON.stringify({ observedPublication: publicationOf(status), canonical: absentSuite }));
  check('C6/A12 a preparation payload that claims a freeze receipt neither becomes the freeze receipt nor authorizes readiness',
    status.freezeReceipt !== 'forged-6ma-receipt' && status.stage === 'freezing'
      && !hasPublishedLine(a.stateDir),
    JSON.stringify({ freezeReceipt: status.freezeReceipt, stage: status.stage }));

  // =========================================================================================
  // SECTION B — C2: completion, child settlement and published freeze are separately durable.
  // =========================================================================================
  const prepNonce = a.grantNonce();
  const grantPath = prepNonce
    ? path.join(AUTH.supervisorDir(LOCK.canonicalTarget(a.fx.target)), 'grants', `${prepNonce}.json`)
    : null;
  const readGrant = () => {
    try { return JSON.parse(fs.readFileSync(grantPath, 'utf8')); } catch { return null; }
  };
  const grantRecord = readGrant();
  check('C2/B1 a successfully completed operation releases its preparation grant without marking the proposal ready',
    !!grantRecord && ['complete', 'released'].includes(grantRecord.state)
      && AUTH.outstanding(a.fx.target).every(row => row.scope !== 'preparation')
      && status.stage === 'freezing' && countStage(status, 'ready') === 0,
    JSON.stringify({ state: grantRecord && grantRecord.state, outstanding: AUTH.outstanding(a.fx.target), stage: status.stage }));
  check('C2/B2 the released grant is settled once, by the operation manager, not twice',
    settledOk(prepNonce) === 1 && status.stage === 'freezing',
    JSON.stringify({ stage: status.stage,
      settlements: settlements.filter(row => row.nonce === prepNonce) }));

  const beforeRebuild = journalLines(a.stateDir);
  const rebuilt = a.build();
  const resumed = await rebuilt.resume();
  await ticks(rebuilt, 2);
  const afterRebuild = journalLines(a.stateDir);
  let rebuiltStatus = await rebuilt.status(a.proposalId);
  check('C2/B3 recreating the supervisor from its journal while waiting preserves kickoff, issue, operation and history',
    !!resumed && resumed.ok === true && rebuiltStatus.kickoffHash === a.record.hash
      && rebuiltStatus.issueId === a.issueId
      && rebuiltStatus.preparation && rebuiltStatus.preparation.batchId === a.batchId
      && isPrefix(stagesOf(status), stagesOf(rebuiltStatus))
      && isPrefix(beforeRebuild, afterRebuild),
    JSON.stringify({ kickoffHash: rebuiltStatus.kickoffHash, issueId: rebuiltStatus.issueId, preparation: rebuiltStatus.preparation }));
  check('C2/B4 subsequent ticks keep observing publication with the launch counters unchanged at one',
    a.calls.specification === 1 && a.prepared('preparation').length === 1
      && rebuiltStatus.stage === 'freezing' && !!publicationOf(rebuiltStatus)
      && publicationOf(rebuiltStatus).published === false,
    JSON.stringify({ calls: a.calls, spawns: a.spawns.map(entry => entry.kind), stage: rebuiltStatus.stage }));

  // A suite on the branch with no receipt: the canonical reason CHANGES, and status must follow
  // the gate rather than remember its first answer.
  stageSuite(a.fx, a.issueId, 'none');
  commitAndPush(a.fx, 'publish the suite without a receipt');
  const noReceipt = canonicalAdmission(a.fx.cfgFile, a.issueId);
  rebuiltStatus = await tickUntil(rebuilt, a.proposalId,
    row => publicationOf(row) && publicationOf(row).refusal === noReceipt.refusal, 3);
  check('C3/B5 the canonical no-receipt refusal replaces the earlier reason in status',
    !!publicationOf(rebuiltStatus) && publicationOf(rebuiltStatus).refusal === noReceipt.refusal
      && publicationOf(rebuiltStatus).reason === noReceipt.reason
      && rebuiltStatus.stage === 'freezing' && a.prepared('implementation').length === 0,
    JSON.stringify({ observedPublication: publicationOf(rebuiltStatus), canonical: noReceipt }));

  // B6-B12: the stranded journal. An existing supervisor journal that carries successful
  // `preparation.completed` evidence but never left `criticizing` — the exact shape today's
  // defect leaves behind. Resume must derive the missing forward transitions.
  const b = world('stranded');
  const strandedGrant = b.adapters.authority.grant({
    scope: 'preparation', project: b.fx.target, proposalId: b.proposalId,
    issueId: b.issueId, batchId: b.batchId,
  });
  const strandedLaunch = b.manager.startPreparation({
    project: b.fx.target, proposalId: b.proposalId, batchId: b.batchId,
    configPath: b.fx.cfgFile, issues: [b.issueId], grant: strandedGrant,
  });
  const strandedProof = b.startWorker('proof');
  b.finishWorker(strandedProof, 'proven-at-base');
  b.exitChild('preparation');
  const strandedEvidence = b.manager.status({ project: b.fx.target, id: b.batchId });
  const specResult = {
    status: 'ready', issueId: b.issueId, model: 'accept-6ma-planner',
    receipt: { kickoffHash: b.record.hash, specHash: sha(b.issueId), issueId: b.issueId, proposal: { status: 'ready' } },
  };
  const strandedEvents = [
    { type: 'proposal.submitted', proposalId: b.proposalId, record: b.record },
    { type: 'stage', proposalId: b.proposalId, stage: 'queued' },
    { type: 'stage', proposalId: b.proposalId, stage: 'specifying' },
    { type: 'specification.completed', proposalId: b.proposalId, result: specResult },
    { type: 'stage', proposalId: b.proposalId, stage: 'criticizing' },
    { type: 'preparation.granted', proposalId: b.proposalId, grant: strandedGrant },
    { type: 'preparation.started', proposalId: b.proposalId, operation: strandedLaunch.operation },
    { type: 'preparation.observed', proposalId: b.proposalId, evidence: strandedEvidence.preparation },
    { type: 'preparation.completed', proposalId: b.proposalId, evidence: strandedEvidence.preparation },
  ];
  fs.mkdirSync(b.stateDir, { recursive: true });
  fs.writeFileSync(journalFile(b.stateDir), `${strandedEvents.map((event, index) =>
    JSON.stringify({ sequence: index + 1, at: '2026-09-17T01:00:00.000Z', ...event })).join('\n')}\n`);
  const strandedBefore = journalLines(b.stateDir);
  const strandedSpawnsBefore = b.spawns.length;
  const strandedSettlesBefore = settleAttempts(strandedGrant.authority.nonce);
  const strandedSupervisor = b.build();
  const strandedResume = await strandedSupervisor.resume();
  const strandedStatus = await tickUntil(strandedSupervisor, b.proposalId, row => row.stage === 'freezing', 4);
  check('C2/B6 a journal stranded at criticizing with successful completion evidence resumes to freezing',
    !!strandedResume && strandedResume.ok === true && strandedStatus.stage === 'freezing',
    JSON.stringify({ resume: strandedResume, stage: strandedStatus.stage, stages: stagesOf(strandedStatus) }));
  check('C2/B7 resume derives every missing forward transition in order',
    JSON.stringify(stagesOf(strandedStatus).slice(0, 6))
      === JSON.stringify(['queued', 'specifying', 'criticizing', 'authoring-tests', 'proving', 'freezing']),
    JSON.stringify(stagesOf(strandedStatus)));
  check('C2/B8 resume rewrites no prior history and relaunches nothing',
    strandedStatus.stage === 'freezing'
      && isPrefix(strandedBefore, journalLines(b.stateDir))
      && b.spawns.length === strandedSpawnsBefore && b.calls.specification === 0
      && b.prepared('implementation').length === 0,
    JSON.stringify({ stage: strandedStatus.stage, spawns: b.spawns.length,
      before: strandedSpawnsBefore, calls: b.calls }));
  const strandedNonce = strandedGrant.authority.nonce;
  check('C2/B9 an already settled grant is acknowledged idempotently rather than settled a second time',
    strandedStatus.stage === 'freezing' && settledOk(strandedNonce) === 1
      && settleAttempts(strandedNonce) >= strandedSettlesBefore
      && AUTH.outstanding(b.fx.target).every(row => row.nonce !== strandedNonce),
    JSON.stringify({ stage: strandedStatus.stage,
      settlements: settlements.filter(row => row.nonce === strandedNonce),
      outstanding: AUTH.outstanding(b.fx.target) }));
  check('C2/B10 the resumed proposal still waits for publication rather than becoming ready',
    strandedStatus.stage === 'freezing' && namesPublication(strandedStatus.nextAction)
      && !!publicationOf(strandedStatus) && publicationOf(strandedStatus).published === false,
    JSON.stringify({ nextAction: strandedStatus.nextAction, publication: publicationOf(strandedStatus) }));
  check('C2/B11 the resumed proposal keeps naming the same preparation operation',
    strandedStatus.preparation && strandedStatus.preparation.batchId === b.batchId
      && strandedStatus.preparation.issueId === b.issueId
      && issueStateOf(strandedStatus) === 'proven-at-base',
    JSON.stringify(strandedStatus.preparation || null));
  check('C2/B12 the resume that derived those transitions performed no retry, reconcile, launch recovery or restart',
    strandedStatus.stage === 'freezing' && JSON.stringify(b.mutations) === NO_MUTATION,
    JSON.stringify({ stage: strandedStatus.stage, mutations: b.mutations }));

  // =========================================================================================
  // SECTION C — C3: the production publication observer against local bare-remote fixtures.
  // =========================================================================================
  const c = remoteFixture('admission');
  const cHalf = path.join(c.root, 'run.config.half-proven.json');
  fs.writeFileSync(cHalf, `${JSON.stringify({
    ...JSON.parse(fs.readFileSync(c.cfgFile, 'utf8')), allowHalfProven: true,
  }, null, 2)}\n`);
  const cBroken = path.join(c.root, 'run.config.unreachable.json');
  fs.writeFileSync(cBroken, `${JSON.stringify({
    ...JSON.parse(fs.readFileSync(c.cfgFile, 'utf8')),
    targetRepoRemote: slash(path.join(c.root, 'no-such-remote.git')),
  }, null, 2)}\n`);
  const ids = {
    valid: 'issue-6ma-published', absent: 'issue-6ma-absent', noReceipt: 'issue-6ma-no-receipt',
    malformed: 'issue-6ma-malformed', mismatch: 'issue-6ma-mismatch',
    half: 'issue-6ma-half-proven', foreign: 'issue-6ma-foreign', local: 'issue-6ma-local-only',
  };
  const validHash = stageSuite(c, ids.valid, 'valid');
  stageSuite(c, ids.noReceipt, 'none');
  stageSuite(c, ids.malformed, 'malformed');
  stageSuite(c, ids.mismatch, 'mismatch');
  stageSuite(c, ids.half, 'half-proven');
  // Another issue's receipt, byte for byte, beside a suite it does not describe.
  stageSuite(c, ids.foreign, 'none');
  fs.copyFileSync(path.join(c.target, ...`${suiteRel(ids.valid)}/${HASHER.RECEIPT_NAME}`.split('/')),
    path.join(c.target, ...`${suiteRel(ids.foreign)}/${HASHER.RECEIPT_NAME}`.split('/')));
  commitAndPush(c, 'publish the admission fixtures');
  // Local only: committed on the operator's desk, never pushed to the integration remote.
  stageSuite(c, ids.local, 'valid');
  commitAndPush(c, 'a freeze that was never pushed', false);

  const observer = SUP.productionAdapters(REPO, { configPath: c.cfgFile }).publication;
  const halfObserver = SUP.productionAdapters(REPO, { configPath: cHalf }).publication;
  const brokenObserver = SUP.productionAdapters(REPO, { configPath: cBroken }).publication;
  // Synchronous or asynchronous production observation is equally permitted: every call site
  // in this suite awaits the answer.
  const observe = async (api, issueId, project = c.target) => {
    if (!api || typeof api.observe !== 'function') return { ok: false, error: 'no publication observer' };
    try { return await api.observe({ project, issueId }); }
    catch (error) { return { ok: false, error: `observer threw: ${(error && error.message) || error}` }; }
  };
  const canonicalTargetC = LOCK.canonicalTarget(c.target);
  const good = await observe(observer, ids.valid);
  const canonicalGood = canonicalAdmission(c.cfgFile, ids.valid);
  check('C3/P1 a valid published suite and receipt authorize readiness with the canonical facts',
    !!good && good.ok === true && good.published === true && good.issueId === ids.valid
      && good.target === canonicalTargetC && good.branch === canonicalGood.branch
      && good.suiteHash === validHash && good.gateVersion === FREEZE_GATE.RECEIPT_VERSION
      && good.verdict === 'red' && canonicalGood.dispatchable === true,
    JSON.stringify({ observed: good, canonical: canonicalGood, expectedHash: validHash }));
  const gateSaw = gateCalls.filter(row => (row.ids || []).includes(ids.valid));
  check('C3/P2 observation calls canonical partitionByFreeze for the exact issue and configured target',
    gateSaw.length > 0 && gateSaw.every(row => row.ids.length === 1
      && LOCK.canonicalTarget(row.targetRepoPath) === canonicalTargetC
      && LOCK.canonicalTarget(row.targetRepoRemote) === LOCK.canonicalTarget(c.bare)),
    JSON.stringify(gateSaw));
  for (const [label, issueId] of [['absent suite', ids.absent], ['absent receipt', ids.noReceipt],
    ['malformed receipt', ids.malformed], ['mismatched suite hash', ids.mismatch],
    ['forbidden half-proven receipt', ids.half], ['another issue\'s receipt', ids.foreign],
    ['local-only publication', ids.local]]) {
    const answer = await observe(observer, issueId);
    const expected = canonicalAdmission(c.cfgFile, issueId);
    check(`C3/P3 ${label} cannot authorize readiness, and the canonical refusal is what is reported`,
      !!answer && answer.ok === true && answer.published === false
        && answer.refusal === expected.refusal && answer.reason === expected.reason
        && answer.issueId === issueId && answer.target === canonicalTargetC
        && answer.branch === expected.branch,
      JSON.stringify({ observed: answer, canonical: expected }));
  }
  const halfAdmitted = await observe(halfObserver, ids.half);
  check('C3/P4 a half-proven receipt follows the existing allowHalfProven policy',
    !!halfAdmitted && halfAdmitted.published === true && halfAdmitted.verdict === 'half-proven'
      && canonicalAdmission(cHalf, ids.half).dispatchable === true,
    JSON.stringify(halfAdmitted));
  const unavailable = await observe(brokenObserver, ids.valid);
  check('C3/P5 a read failure produces explicit unavailable evidence rather than a refusal',
    !!unavailable && unavailable.ok === false && unavailable.available === false
      && unavailable.published !== true && typeof unavailable.error === 'string'
      && unavailable.error.length > 0 && canonicalAdmission(cBroken, ids.valid).ok === false,
    JSON.stringify(unavailable));

  // C6: identity captured IN the admission, not re-read afterwards. The local remote changes
  // the instant the canonical gate answers; a second, later metadata read would see the new
  // suite, and the journalled evidence would carry the wrong digest.
  const ident = world('identity');
  const identSupervisor = ident.build();
  await identSupervisor.submit(ident.record);
  await ticks(identSupervisor, 1);
  const identProof = ident.startWorker('proof');
  ident.finishWorker(identProof, 'proven-at-base');
  ident.exitChild('preparation');
  await tickUntil(identSupervisor, ident.proposalId, row => row.stage === 'freezing', 4);
  const admittedHash = stageSuite(ident.fx, ident.issueId, 'valid');
  commitAndPush(ident.fx, 'publish the approved frozen suite');
  const identHeadAtAdmission = remoteHead(ident.fx);
  let supersededHash = null;
  afterPartition = () => {
    supersededHash = stageSuite(ident.fx, ident.issueId, 'valid', ' — superseded immediately');
    commitAndPush(ident.fx, 'a different frozen suite, pushed the instant admission answered');
  };
  const identStatus = await tickUntil(identSupervisor, ident.proposalId,
    row => row.stage === 'implementing', 8);
  afterPartition = null;
  const identBranch = canonicalAdmission(ident.fx.cfgFile, ident.issueId).branch;
  const identEvidence = admissionEvidenceIn(ident.stateDir, {
    target: LOCK.canonicalTarget(ident.fx.target), issueId: ident.issueId,
    branch: identBranch, suiteHash: admittedHash, verdict: 'red',
  });
  // The discriminator is `identEvidence` itself: it demands the digest the canonical admission
  // observed. An implementation that re-read the branch afterwards would have journalled the
  // superseded digest instead and could not produce this object at all.
  check('C3/P6 the admitted identity is the one the canonical observation captured, not a later metadata read',
    !!supersededHash && supersededHash !== admittedHash
      && remoteHead(ident.fx) !== identHeadAtAdmission
      && hashSuiteInTree(ident.fx, ident.issueId) === supersededHash
      && !!identEvidence && identStatus.stage === 'implementing',
    JSON.stringify({ admittedHash, supersededHash, evidence: identEvidence,
      stage: identStatus.stage, headMoved: remoteHead(ident.fx) !== identHeadAtAdmission }));

  // =========================================================================================
  // SECTION D — C4: admission evidence, one shared-feed assignment, and no duplicate work.
  // =========================================================================================
  const publishedHash = stageSuite(a.fx, a.issueId, 'valid');
  commitAndPush(a.fx, 'publish the approved frozen suite and its receipt');
  const admission = canonicalAdmission(a.fx.cfgFile, a.issueId);
  const dispatched = await tickUntil(rebuilt, a.proposalId, row => row.stage === 'implementing', 8);
  check('C4/D1 an observed valid publication passes the proposal through ready into implementing',
    dispatched.stage === 'implementing' && countStage(dispatched, 'ready') === 1
      && countStage(dispatched, 'implementing') === 1,
    JSON.stringify({ stage: dispatched.stage, stages: stagesOf(dispatched) }));
  const evidence = admissionEvidenceIn(a.stateDir, {
    target: LOCK.canonicalTarget(a.fx.target), issueId: a.issueId, branch: admission.branch,
    suiteHash: publishedHash, verdict: 'red',
  });
  check('C4/D2 journal evidence identifies target, issue, branch, suiteHash, gateVersion and verdict together',
    !!evidence, JSON.stringify({ publishedHash, branch: admission.branch,
      publication: publicationOf(dispatched) }));
  check('C4/D3 the admitted facts come from the same canonical admission observation',
    !!publicationOf(dispatched) && publicationOf(dispatched).published === true
      && publicationOf(dispatched).suiteHash === publishedHash
      && publicationOf(dispatched).branch === admission.branch
      && publicationOf(dispatched).gateVersion === FREEZE_GATE.RECEIPT_VERSION
      && admission.dispatchable === true,
    JSON.stringify({ publication: publicationOf(dispatched), canonical: admission }));
  const assignments = (stateDir = a.stateDir) =>
    journal(stateDir).filter(event => event.type === 'proposal.assigned');
  check('C4/D4 the proposal receives exactly one shared-feed assignment and one feed launch',
    assignments().length === 1 && a.prepared('implementation').length === 1,
    JSON.stringify({ assignments: assignments().length, spawns: a.spawns.map(entry => entry.kind) }));
  await ticks(rebuilt, 3);
  const repeated = await rebuilt.status(a.proposalId);
  check('C4/D5 repeated ticks produce no duplicate specification, preparation, assignment or feed launch',
    a.calls.specification === 1 && a.prepared('preparation').length === 1
      && a.prepared('implementation').length === 1 && assignments().length === 1
      && countStage(repeated, 'ready') === 1,
    JSON.stringify({ calls: a.calls, spawns: a.spawns.map(entry => entry.kind), assignments: assignments().length }));

  // Two proposals, one shared feed: the witness C4 asks for, stated as behaviour rather than
  // as the absence of a word in a source file.
  const shared = world('shared-feed', { proposals: 2 });
  const sharedSupervisor = shared.build();
  for (const record of shared.records) await sharedSupervisor.submit(record);
  const sharedHashes = [];
  await tickUntilSafely(sharedSupervisor,
    () => shared.prepared('preparation').length === 2, 8);
  for (let index = 0; index < 2; index += 1) {
    const nonce = shared.startWorker('proof', shared.issueIds[index], true, shared.batchOf(index));
    shared.finishWorker(nonce, 'proven-at-base', shared.issueIds[index], {}, shared.batchOf(index));
    shared.exitChild('preparation', 0, shared.batchOf(index));
    sharedHashes.push(stageSuite(shared.fx, shared.issueIds[index], 'valid'));
  }
  commitAndPush(shared.fx, 'publish both approved frozen suites');
  await tickUntilSafely(sharedSupervisor,
    () => assignments(shared.stateDir).length === 2, 12);
  const sharedAssigned = assignments(shared.stateDir);
  const sharedStatuses = await Promise.all(shared.proposalIds.map(id => sharedSupervisor.status(id)));
  check('C4/D6 two proposals receive one assignment each on ONE shared implementation feed',
    sharedAssigned.length === 2
      && new Set(sharedAssigned.map(row => row.proposalId)).size === 2
      && new Set(sharedAssigned.map(row => row.feedId)).size === 1
      && shared.prepared('implementation').length === 1
      && sharedStatuses.every(row => row.stage === 'implementing'
        && countStage(row, 'ready') === 1 && countStage(row, 'implementing') === 1),
    JSON.stringify({ assigned: sharedAssigned.map(row => ({ proposalId: row.proposalId, feedId: row.feedId })),
      feeds: shared.prepared('implementation').length,
      stages: sharedStatuses.map(row => row.stage), hashes: sharedHashes }));

  // The runner's OWN admission, driven through its own entry point with a stubbed Beads read:
  // it admits and refuses on published-freeze evidence alone, for issues no supervisor has ever
  // heard of as well as for this proposal's issue.
  const strangerId = 'issue-6ma-stranger';
  const unfrozenId = 'issue-6ma-unfrozen';
  stageSuite(a.fx, strangerId, 'valid');
  commitAndPush(a.fx, 'publish a frozen suite for an issue no proposal owns');
  const bdStub = path.join(tmp, 'bd-stub.js');
  fs.writeFileSync(bdStub, `'use strict';\n`
    + `require('fs').writeSync(1, process.env.ACCEPT_6MA_BD_ROWS || '[]');\n`
    + 'process.exit(0);\n');
  process.env.ACCEPT_6MA_BD_ROWS = JSON.stringify([{ id: a.issueId }, { id: strangerId }, { id: unfrozenId }]);
  process.env.PIPELINE_BD_CMD = process.execPath;
  process.env.NODE_OPTIONS = `--require "${slash(bdStub)}"`;
  let runnerQueue;
  try { runnerQueue = QUEUE.readyQueue(CONFIG.loadConfig(a.fx.cfgFile)); }
  catch (error) { runnerQueue = { ok: false, error: (error && error.message) || String(error) }; }
  finally {
    process.env.PIPELINE_BD_CMD = NO_BD;
    if (savedEnv.NODE_OPTIONS === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = savedEnv.NODE_OPTIONS;
    delete process.env.ACCEPT_6MA_BD_ROWS;
  }
  const admittedIds = runnerQueue && runnerQueue.ok ? runnerQueue.issues.map(row => row.id) : [];
  const refusedIds = runnerQueue && runnerQueue.ok
    ? (runnerQueue.undispatchable || []).map(row => row.issue && row.issue.id) : [];
  check('C4/D7 the implementation runner retains its own independent dispatch admission',
    !!runnerQueue && runnerQueue.ok === true && admittedIds.includes(a.issueId)
      && refusedIds.includes(unfrozenId) && !admittedIds.includes(unfrozenId)
      && dispatched.stage === 'implementing',
    JSON.stringify({ admitted: admittedIds, refused: refusedIds, stage: dispatched.stage,
      error: runnerQueue && runnerQueue.error }));
  check('C4/D8 runner queue selection stays proposal-agnostic: an issue no proposal owns is admitted on its freeze alone',
    admittedIds.includes(strangerId) && !refusedIds.includes(strangerId)
      && assignments().length === 1 && a.prepared('implementation').length === 1,
    JSON.stringify({ admitted: admittedIds, refused: refusedIds }));

  // =========================================================================================
  // SECTION R — C2 and C4: a controller destroyed AT a durable boundary, before the transition
  // that boundary implies. The append is interrupted after fsync and before returning to the
  // controller; a fresh controller reuses every durable store without rewriting any of them.
  // =========================================================================================
  // R1 — after completion is persisted, before the settlement and readiness it implies.
  const r1 = world('restart-completion');
  const r1First = r1.build();
  await r1First.submit(r1.record);
  await ticks(r1First, 1);
  const r1Proof = r1.startWorker('proof');
  r1.finishWorker(r1Proof, 'proven-at-base');
  r1.exitChild('preparation');
  const r1Hash = stageSuite(r1.fx, r1.issueId, 'valid');
  commitAndPush(r1.fx, 'publish the approved frozen suite');
  const r1Cut = await interruptAfterAppend(r1.stateDir,
    event => event.type === 'preparation.completed', () => ticks(r1First, 6));
  const r1CutLines = journalLines(r1.stateDir);
  const r1FeedLaunchesAtCrash = r1.prepared('implementation').length;
  const r1GrantsAtCrash = AUTH.outstanding(r1.fx.target).length;
  const r1Nonce = r1.grantNonce();
  const r1SettledBefore = settledOk(r1Nonce);
  const r1Second = r1.build();
  await r1Second.resume();
  const r1Status = await tickUntil(r1Second, r1.proposalId, row => row.stage === 'implementing', 8);
  check('C2/R1 a controller destroyed after completion persisted resumes forward with one settlement and unchanged launches',
    r1Cut === true && r1FeedLaunchesAtCrash === 0 && r1GrantsAtCrash === 0
      && !r1CutLines.some(line => /"stage"\s*:\s*"ready"/.test(line))
      && r1Status.stage === 'implementing' && settledOk(r1Nonce) === 1 && r1SettledBefore === 1
      && r1.calls.specification === 1 && r1.prepared('preparation').length === 1
      && r1.prepared('implementation').length === 1 && assignments(r1.stateDir).length === 1
      && isPrefix(r1CutLines, journalLines(r1.stateDir))
      && !!publicationOf(r1Status) && publicationOf(r1Status).suiteHash === r1Hash,
    JSON.stringify({ cut: r1Cut, stage: r1Status.stage, settled: settledOk(r1Nonce),
      calls: r1.calls, spawns: r1.spawns.map(entry => entry.kind) }));

  // R2 — after the published freeze is persisted, before readiness, a feed grant or launch.
  const r2 = world('restart-publication');
  const r2First = r2.build();
  await r2First.submit(r2.record);
  await ticks(r2First, 1);
  const r2Proof = r2.startWorker('proof');
  r2.finishWorker(r2Proof, 'proven-at-base');
  r2.exitChild('preparation');
  await tickUntilSafely(r2First, () => false, 3);
  const r2Hash = stageSuite(r2.fx, r2.issueId, 'valid');
  commitAndPush(r2.fx, 'publish the approved frozen suite');
  const r2Cut = await interruptAfterAppend(r2.stateDir,
    (event, line) => /"published"\s*:\s*true/.test(line), () => ticks(r2First, 6));
  const r2CutLines = journalLines(r2.stateDir);
  const r2FeedLaunchesAtCrash = r2.prepared('implementation').length;
  const r2GrantsAtCrash = AUTH.outstanding(r2.fx.target).length;
  const r2Second = r2.build();
  await r2Second.resume();
  const r2Status = await tickUntil(r2Second, r2.proposalId, row => row.stage === 'implementing', 8);
  check('C4/R2 a controller destroyed after the published freeze persisted resumes to one assignment and one feed launch',
    r2Cut === true && r2FeedLaunchesAtCrash === 0 && r2GrantsAtCrash === 0
      && r2.prepared('implementation').length === 1
      && !r2CutLines.some(line => /"proposal\.assigned"/.test(line))
      && r2Status.stage === 'implementing' && assignments(r2.stateDir).length === 1
      && countStage(r2Status, 'ready') === 1 && countStage(r2Status, 'implementing') === 1
      && r2.calls.specification === 1 && r2.prepared('preparation').length === 1
      && isPrefix(r2CutLines, journalLines(r2.stateDir))
      && !!publicationOf(r2Status) && publicationOf(r2Status).suiteHash === r2Hash,
    JSON.stringify({ cut: r2Cut, stage: r2Status.stage, assignments: assignments(r2.stateDir).length,
      spawns: r2.spawns.map(entry => entry.kind) }));

  // A durable publication is not permission to reuse stale preparation after a crash.
  for (const condition of ['api-unavailable', 'operation-attention']) {
    const changed = world(`restart-publication-${condition}`);
    const first = changed.build();
    await first.submit(changed.record);
    await ticks(first, 1);
    const proof = changed.startWorker('proof');
    changed.finishWorker(proof, 'proven-at-base');
    changed.exitChild('preparation');
    await ticks(first, 4);
    const hash = stageSuite(changed.fx, changed.issueId, 'valid');
    commitAndPush(changed.fx, 'publish before interrupted admission');
    const cut = await interruptAfterAppend(changed.stateDir,
      (event, line) => /"published"\s*:\s*true/.test(line), () => ticks(first, 6));
    const prefix = journalLines(changed.stateDir);
    const atCrash = await first.status(changed.proposalId);
    const grant = changed.grantNonce();
    const settledBefore = settleAttempts(grant);
    check(`C4/R5 ${condition} fixture interrupts after publication but before readiness or assignment`,
      cut === true && atCrash.stage === 'freezing' && countStage(atCrash, 'ready') === 0
        && publicationOf(atCrash) && publicationOf(atCrash).published === true
        && assignments(changed.stateDir).length === 0
        && changed.prepared('implementation').length === 0 && settledOk(grant) === 1,
      JSON.stringify({ cut, atCrash }));
    const originalStatus = changed.adapters.operations.status;
    let preparationReads = 0;
    changed.adapters.operations.status = async input => {
      if (input.id !== changed.batchId) return originalStatus(input);
      preparationReads += 1;
      if (condition === 'api-unavailable') return { ok: false, error: 'fixture: status unavailable after crash' };
      const answer = await originalStatus(input);
      return { ...answer, state: 'attention', attention: 'fixture: operation requires recovery after crash' };
    };
    const second = changed.build();
    await second.resume();
    await ticks(second, 4);
    const blocked = await second.status(changed.proposalId);
    check(`C5/R6 restart refreshes ${condition} before any readiness or implementation side effect`,
      preparationReads > 0 && blocked.stage === 'freezing'
        && issueStateOf(blocked) === (condition === 'api-unavailable' ? 'unavailable' : 'proven-at-base')
        && (condition !== 'operation-attention' || blocked.preparation.operationState === 'attention')
        && namesRecovery(blocked.nextAction) && countStage(blocked, 'ready') === 0
        && assignments(changed.stateDir).length === 0 && changed.prepared('implementation').length === 0
        && AUTH.outstanding(changed.fx.target).length === 0
        && changed.calls.specification === 1 && changed.prepared('preparation').length === 1
        && settleAttempts(grant) === settledBefore && isPrefix(prefix, journalLines(changed.stateDir))
        && JSON.stringify(changed.mutations) === NO_MUTATION,
      JSON.stringify({ preparationReads, blocked, assignments: assignments(changed.stateDir),
        spawns: changed.spawns.map(row => row.kind) }));
    changed.adapters.operations.status = originalStatus;
    const recovered = await tickUntil(second, changed.proposalId, row => row.stage === 'implementing', 8);
    await ticks(second, 2);
    check(`C4/R7 ${condition} recovery admits the original publication exactly once`,
      recovered.stage === 'implementing' && issueStateOf(recovered) === 'proven-at-base'
        && publicationOf(recovered) && publicationOf(recovered).suiteHash === hash
        && assignments(changed.stateDir).length === 1 && changed.prepared('implementation').length === 1
        && changed.calls.specification === 1 && changed.prepared('preparation').length === 1
        && settleAttempts(grant) === settledBefore && isPrefix(prefix, journalLines(changed.stateDir))
        && JSON.stringify(changed.mutations) === NO_MUTATION,
      JSON.stringify({ recovered, assignments: assignments(changed.stateDir) }));
  }

  // R3 — after the assignment is persisted, before the `implementing` transition it implies.
  const r3 = world('restart-assignment');
  const r3First = r3.build();
  await r3First.submit(r3.record);
  await ticks(r3First, 1);
  const r3Proof = r3.startWorker('proof');
  r3.finishWorker(r3Proof, 'proven-at-base');
  r3.exitChild('preparation');
  stageSuite(r3.fx, r3.issueId, 'valid');
  commitAndPush(r3.fx, 'publish the approved frozen suite');
  const r3Cut = await interruptAfterAppend(r3.stateDir,
    event => event.type === 'proposal.assigned', () => ticks(r3First, 8));
  const r3CutLines = journalLines(r3.stateDir);
  const r3FeedLaunchesAtCrash = r3.prepared('implementation').length;
  const r3GrantsAtCrash = AUTH.outstanding(r3.fx.target).length;
  const r3Second = r3.build();
  await r3Second.resume();
  const r3Status = await tickUntil(r3Second, r3.proposalId, row => row.stage === 'implementing', 6);
  check('C4/R3 a controller destroyed after the assignment persisted resumes to implementing without a second assignment or feed',
    r3Cut === true && r3FeedLaunchesAtCrash === 1 && r3GrantsAtCrash === 1
      && !r3CutLines.some(line => /"stage"\s*:\s*"implementing"/.test(line))
      && r3Status.stage === 'implementing' && assignments(r3.stateDir).length === 1
      && r3.prepared('implementation').length === 1 && r3.prepared('preparation').length === 1
      && r3.calls.specification === 1 && isPrefix(r3CutLines, journalLines(r3.stateDir)),
    JSON.stringify({ cut: r3Cut, stage: r3Status.stage, assignments: assignments(r3.stateDir).length,
      spawns: r3.spawns.map(entry => entry.kind) }));
  check('C2/R4 no interrupted restart reached for a retry, reconcile, launch recovery or restart verb',
    r1Status.stage === 'implementing' && r2Status.stage === 'implementing'
      && r3Status.stage === 'implementing'
      && JSON.stringify(r1.mutations) === NO_MUTATION && JSON.stringify(r2.mutations) === NO_MUTATION
      && JSON.stringify(r3.mutations) === NO_MUTATION,
    JSON.stringify({ stages: [r1Status.stage, r2Status.stage, r3Status.stage],
      r1: r1.mutations, r2: r2.mutations, r3: r3.mutations }));

  // =========================================================================================
  // SECTION E — C5: adverse preparation and operation attention never reach readiness.
  // =========================================================================================
  for (const outcome of ['unproven', 'agent-failed', 'usage-limit']) {
    const e = world(`adverse-${outcome}`);
    const adverse = e.build();
    await adverse.submit(e.record);
    await ticks(adverse, 1);
    const nonce = e.startWorker('proof');
    await tickUntil(adverse, e.proposalId, row => row.stage === 'proving', 3);
    e.finishWorker(nonce, outcome);
    e.exitChild('preparation');
    // Publication is fully available: only the preparation evidence is adverse.
    const hash = stageSuite(e.fx, e.issueId, 'valid');
    commitAndPush(e.fx, 'publish the approved frozen suite');
    await ticks(adverse, 3);
    const adverseStatus = await adverse.status(e.proposalId);
    check(`C5/E1 ${outcome} preparation cannot advance to readiness and retains its last valid nonterminal stage`,
      adverseStatus.stage === 'proving' && issueStateOf(adverseStatus) === outcome
        && countStage(adverseStatus, 'ready') === 0 && countStage(adverseStatus, 'failed') === 0
        && e.prepared('implementation').length === 0,
      JSON.stringify({ stage: adverseStatus.stage, stages: stagesOf(adverseStatus), preparation: adverseStatus.preparation }));
    check(`C5/E2 ${outcome} status exposes the actual condition and a recovery action, and ticks mutate nothing`,
      namesRecovery(adverseStatus.nextAction)
        && JSON.stringify(e.mutations) === NO_MUTATION
        && e.prepared('preparation').length === 1
        && adverseStatus.preparation && adverseStatus.preparation.issueId === e.issueId,
      JSON.stringify({ nextAction: adverseStatus.nextAction, mutations: e.mutations }));
    if (outcome === 'unproven') {
      // The externally authorized recovery: a new worker generation proves the suite at base.
      const recovered = e.startWorker('proof');
      e.finishWorker(recovered, 'proven-at-base');
      const cleared = await tickUntil(adverse, e.proposalId, row => row.stage === 'implementing', 8);
      check('C5/E3 only successful evidence after an externally authorized recovery clears the preparation block',
        cleared.stage === 'implementing' && issueStateOf(cleared) === 'proven-at-base'
          && !!publicationOf(cleared) && publicationOf(cleared).suiteHash === hash
          && e.prepared('preparation').length === 1,
        JSON.stringify({ stage: cleared.stage, preparation: cleared.preparation, publication: publicationOf(cleared) }));
    }
  }

  const f = world('interrupted');
  const interrupted = f.build();
  await interrupted.submit(f.record);
  await ticks(interrupted, 1);
  f.startWorker('author', f.issueId, false);
  f.exitChild('preparation');
  stageSuite(f.fx, f.issueId, 'valid');
  commitAndPush(f.fx, 'publish the approved frozen suite');
  await ticks(interrupted, 3);
  const interruptedStatus = await interrupted.status(f.proposalId);
  check('C5/E4 an interrupted-unknown worker keeps the proposal nonterminal and never reaches readiness',
    interruptedStatus.stage === 'criticizing' && issueStateOf(interruptedStatus) === 'interrupted-unknown'
      && countStage(interruptedStatus, 'failed') === 0 && countStage(interruptedStatus, 'ready') === 0
      && f.prepared('implementation').length === 0,
    JSON.stringify({ stage: interruptedStatus.stage, preparation: interruptedStatus.preparation }));
  check('C5/E5 interrupted preparation is reported as operation attention with a recovery action and no acknowledgment',
    interruptedStatus.preparation && interruptedStatus.preparation.operationState === 'attention'
      && typeof interruptedStatus.preparation.attention === 'string'
      && interruptedStatus.preparation.attention.length > 0
      && namesRecovery(interruptedStatus.nextAction)
      && JSON.stringify(f.mutations) === NO_MUTATION,
    JSON.stringify({ preparation: interruptedStatus.preparation, nextAction: interruptedStatus.nextAction, mutations: f.mutations }));

  const g = world('unavailable');
  const unreadable = g.build();
  await unreadable.submit(g.record);
  await ticks(unreadable, 1);
  fs.writeFileSync(path.join(g.prepRoot, g.batchId, 'manifest.json'), '{"torn":');
  await ticks(unreadable, 2);
  const unreadableStatus = await unreadable.status(g.proposalId);
  check('C5/E6 unavailable preparation evidence is reported as unavailable and advances nothing',
    issueStateOf(unreadableStatus) === 'unavailable'
      && unreadableStatus.stage === 'criticizing'
      && countStage(unreadableStatus, 'failed') === 0
      && namesRecovery(unreadableStatus.nextAction)
      && g.prepared('implementation').length === 0
      && JSON.stringify(g.mutations) === NO_MUTATION,
    JSON.stringify({ preparation: unreadableStatus.preparation, stage: unreadableStatus.stage, nextAction: unreadableStatus.nextAction }));

  const h = world('uncertain', { uncertainSettlement: true });
  const uncertain = h.build();
  await uncertain.submit(h.record);
  await ticks(uncertain, 1);
  const uncertainNonce = h.startWorker('proof');
  h.finishWorker(uncertainNonce, 'proven-at-base');
  h.exitChild('preparation');
  stageSuite(h.fx, h.issueId, 'valid');
  commitAndPush(h.fx, 'publish the approved frozen suite');
  await ticks(uncertain, 4);
  const uncertainStatus = await uncertain.status(h.proposalId);
  const uncertainGrant = h.grantNonce();
  const uncertainAttempts = settleAttempts(uncertainGrant);
  check('C5/E7 an uncertain settlement remains attention and never reaches readiness even with a valid publication',
    uncertainStatus.stage !== 'ready' && uncertainStatus.stage !== 'implementing'
      && countStage(uncertainStatus, 'ready') === 0
      && uncertainStatus.preparation && uncertainStatus.preparation.operationState === 'attention'
      && typeof uncertainStatus.preparation.attention === 'string'
      && namesRecovery(uncertainStatus.nextAction)
      && h.prepared('implementation').length === 0,
    JSON.stringify({ stage: uncertainStatus.stage, preparation: uncertainStatus.preparation, nextAction: uncertainStatus.nextAction }));
  // Every settlement attempt is counted, uncertain ones included: later ticks and a fresh
  // controller over the same journal must add none, and must never reconcile behind the
  // operation manager that owns the settlement.
  const uncertainRebuilt = h.build();
  await uncertainRebuilt.resume();
  await ticks(uncertainRebuilt, 3);
  const uncertainAfter = await uncertainRebuilt.status(h.proposalId);
  check('C5/E8 no further settlement attempt, reconciliation or readiness follows an uncertain settlement',
    settledOk(uncertainGrant) === 0 && settleAttempts(uncertainGrant) === uncertainAttempts
      && uncertainAttempts >= 1
      && uncertainAfter.preparation && uncertainAfter.preparation.operationState === 'attention'
      && AUTH.outstanding(h.fx.target).some(row => row.nonce === uncertainGrant)
      && uncertainAfter.stage !== 'ready' && uncertainAfter.stage !== 'implementing'
      && h.prepared('implementation').length === 0
      && JSON.stringify(h.mutations) === NO_MUTATION,
    JSON.stringify({ attempts: settlements.filter(row => row.nonce === uncertainGrant),
      outstanding: AUTH.outstanding(h.fx.target), stage: uncertainAfter.stage, mutations: h.mutations }));

  // The production owner path: acquire, drain, close. The lease must be gone because the owner
  // released it, and nothing in this file releases it — `suiteLeaseReleases` says so.
  const i = world('draining', { owner: true });
  const opened = i.open();
  const draining = opened && opened.supervisor;
  if (!draining) {
    check('C5/E9 the production owner opens the project for the drain path', false,
      JSON.stringify(opened || null));
    check('C5/E10 the production owner releases project ownership itself', false, 'owner never opened');
  } else {
    await draining.submit(i.record);
    await ticks(draining, 1);
    const drainNonce = i.startWorker('proof');
    i.finishWorker(drainNonce, 'proven-at-base');
    i.exitChild('preparation');
    const drainStatus = await tickUntil(draining, i.proposalId, row => row.stage === 'freezing', 4);
    const headBeforeStop = remoteHead(i.fx);
    const stopped = await draining.stop();
    await ticks(draining, 3);
    const overall = await draining.status();
    check('C5/E9 stopping while only successful preparation awaits publication drains without publishing or implementing',
      !!stopped && stopped.ok === true && drainStatus.stage === 'freezing'
        && overall.closed === true && overall.drained === true
        && i.prepared('implementation').length === 0
        && remoteHead(i.fx) === headBeforeStop,
      JSON.stringify({ stopped, drained: overall.drained, closed: overall.closed, spawns: i.spawns.map(entry => entry.kind) }));
    const closed = await opened.close();
    const holderAfterClose = AUTH.leaseHolder(i.fx.target);
    check('C5/E10 the production owner releases project ownership itself, before any cleanup in this suite',
      !!closed && closed.ok === true && holderAfterClose === null
        && AUTH.outstanding(i.fx.target).length === 0 && suiteLeaseReleases === 0
        && overall.drained === true,
      JSON.stringify({ closed, holder: holderAfterClose, outstanding: AUTH.outstanding(i.fx.target),
        suiteLeaseReleases }));
  }

  // A world whose batch manifest never names this proposal's issue at all.
  const j = world('absent-issue', { manifestIssues: idsFor => [idsFor.decoyId] });
  const absentWorld = j.build();
  await absentWorld.submit(j.record);
  await ticks(absentWorld, 1);
  const decoyOnly = j.startWorker('proof', j.decoyId);
  j.finishWorker(decoyOnly, 'proven-at-base', j.decoyId);
  j.exitChild('preparation');
  stageSuite(j.fx, j.issueId, 'valid');
  commitAndPush(j.fx, 'publish the approved frozen suite');
  await ticks(absentWorld, 3);
  const absentStatus = await absentWorld.status(j.proposalId);
  check('C1/A13 an absent issue in the preparation manifest never advances the proposal',
    absentStatus.stage === 'criticizing' && issueStateOf(absentStatus) === 'absent'
      && countStage(absentStatus, 'ready') === 0 && countStage(absentStatus, 'failed') === 0
      && j.prepared('implementation').length === 0,
    JSON.stringify({ stage: absentStatus.stage, preparation: absentStatus.preparation }));
  check('C1/A14 that proposal still reports its own issue and the publication it is not using',
    absentStatus.issueId === j.issueId && namesRecovery(String(absentStatus.nextAction))
      && !!publicationOf(absentStatus) && publicationOf(absentStatus).issueId === j.issueId,
    JSON.stringify({ issueId: absentStatus.issueId, nextAction: absentStatus.nextAction,
      publication: publicationOf(absentStatus) }));

  // Late evidence is not the earlier adverse-from-proving case: completion and settlement
  // already exist, but publication is still absent when the new condition appears.
  for (const condition of ['unproven', 'agent-failed', 'usage-limit',
    'interrupted-unknown', 'artifact-unavailable', 'api-unavailable', 'operation-attention']) {
    const late = world(`late-${condition}`);
    let controller = late.build();
    await controller.submit(late.record);
    await ticks(controller, 1);
    const proof = late.startWorker('proof');
    late.finishWorker(proof, 'proven-at-base');
    late.exitChild('preparation');
    await ticks(controller, 4);
    const before = await controller.status(late.proposalId);
    const grant = late.grantNonce();
    const settleCount = settleAttempts(grant);
    check(`C5/L1 ${condition} starts after proven completion and one acknowledged settlement`,
      before.stage === 'freezing' && issueStateOf(before) === 'proven-at-base'
        && before.preparation.operationState === 'completed' && settledOk(grant) === 1
        && journal(late.stateDir).filter(row => row.type === 'preparation.settled').length === 1
        && publicationOf(before) && publicationOf(before).published === false
        && late.prepared('implementation').length === 0,
      JSON.stringify({ before, settleCount }));
    const manifest = path.join(late.prepRoot, late.batchId, 'manifest.json');
    const manifestBytes = fs.readFileSync(manifest);
    const originalStatus = late.adapters.operations.status;
    if (condition === 'artifact-unavailable') fs.writeFileSync(manifest, '{"torn":');
    else if (condition === 'api-unavailable') {
      late.adapters.operations.status = input => input.id === late.batchId
        ? { ok: false, error: 'fixture: status unavailable' } : originalStatus(input);
    } else if (condition === 'operation-attention') {
      late.adapters.operations.status = async input => {
        const answer = await originalStatus(input);
        return input.id === late.batchId
          ? { ...answer, state: 'attention', attention: 'fixture: operation requires recovery' }
          : answer;
      };
    } else {
      const worker = late.startWorker('proof', late.issueId, condition !== 'interrupted-unknown');
      if (condition !== 'interrupted-unknown') late.finishWorker(worker, condition);
    }
    const hash = stageSuite(late.fx, late.issueId, 'valid');
    commitAndPush(late.fx, 'publish after preparation condition changed');
    await ticks(controller, 3);
    controller = late.build();
    await ticks(controller, 3);
    const blocked = await controller.status(late.proposalId);
    const expectedState = condition.endsWith('unavailable') ? 'unavailable'
      : condition === 'operation-attention' ? 'proven-at-base' : condition;
    check(`C5/L2 late ${condition} blocks readiness and reports current evidence across restart`,
      blocked.stage === 'freezing' && issueStateOf(blocked) === expectedState
        && (condition !== 'operation-attention'
          || blocked.preparation.operationState === 'attention')
        && namesRecovery(blocked.nextAction) && countStage(blocked, 'ready') === 0
        && countStage(blocked, 'failed') === 0 && assignments(late.stateDir).length === 0
        && late.prepared('implementation').length === 0
        && late.calls.specification === 1 && late.prepared('preparation').length === 1
        && settleAttempts(grant) === settleCount && JSON.stringify(late.mutations) === NO_MUTATION,
      JSON.stringify({ blocked, assignments: assignments(late.stateDir), spawns: late.spawns.map(row => row.kind) }));
    // Model only externally authorized recovery; the controller must invoke no recovery verb.
    if (condition === 'artifact-unavailable') fs.writeFileSync(manifest, manifestBytes);
    else if (condition === 'api-unavailable' || condition === 'operation-attention')
      late.adapters.operations.status = originalStatus;
    else {
      const recovered = late.startWorker('proof');
      late.finishWorker(recovered, 'proven-at-base');
    }
    const recovered = await tickUntil(controller, late.proposalId, row => row.stage === 'implementing', 8);
    await ticks(controller, 2);
    check(`C5/L3 late ${condition} clears only with recovered evidence and launches exactly once`,
      recovered.stage === 'implementing' && issueStateOf(recovered) === 'proven-at-base'
        && publicationOf(recovered) && publicationOf(recovered).suiteHash === hash
        && assignments(late.stateDir).length === 1 && late.prepared('implementation').length === 1
        && late.calls.specification === 1 && late.prepared('preparation').length === 1
        && settleAttempts(grant) === settleCount && JSON.stringify(late.mutations) === NO_MUTATION,
      JSON.stringify({ recovered, settleCount: settleAttempts(grant) }));
  }

  // Observation fairness and concurrency are separate fixtures: a cap cannot be bypassed
  // merely to reach a later proposal, and unchanged earlier observations cannot starve it.
  const fair = world('observation-fairness', { proposals: 3 });
  let fairController = fair.build({ globalConcurrency: 3, stageConcurrency: { preparation: 3 } });
  for (const record of fair.records) await fairController.submit(record);
  await tickUntilSafely(fairController, () => fair.prepared('preparation').length === fair.records.length, 12);
  for (let index = 0; index < fair.records.length; index += 1) {
    const proof = fair.startWorker('proof', fair.issueIds[index], true, fair.batchOf(index));
    fair.finishWorker(proof, 'proven-at-base', fair.issueIds[index], {}, fair.batchOf(index));
    fair.exitChild('preparation', 0, fair.batchOf(index));
  }
  await ticks(fairController, 5);
  const primed = await Promise.all(fair.proposalIds.map(id => fairController.status(id)));
  check('C1/F1 fairness fixture starts with every proposal settled and waiting for publication',
    primed.every((row, index) => row.stage === 'freezing' && issueStateOf(row) === 'proven-at-base'
      && publicationOf(row) && publicationOf(row).published === false
      && settledOk(fair.grantNonce(index)) === 1));
  fairController = fair.build({ globalConcurrency: 2, stageConcurrency: { preparation: 2 } });
  const statusReads = new Set(), publicationReads = new Set();
  const fairStatus = fair.adapters.operations.status;
  fair.adapters.operations.status = input => { statusReads.add(input.id); return fairStatus(input); };
  const fairPublication = fair.adapters.publication;
  if (fairPublication && typeof fairPublication.observe === 'function') {
    const observe = fairPublication.observe.bind(fairPublication);
    fairPublication.observe = input => { publicationReads.add(input.issueId); return observe(input); };
  }
  const last = fair.records.length - 1;
  stageSuite(fair.fx, fair.issueIds[last], 'valid');
  commitAndPush(fair.fx, 'publish only the last waiting proposal');
  const admittedLast = canonicalAdmission(fair.fx.cfgFile, fair.issueIds[last]);
  await ticks(fairController, 6);
  const fairAfter = await Promise.all(fair.proposalIds.map(id => fairController.status(id)));
  check('C1/F2 unchanged earlier observations cannot starve a later published proposal',
    admittedLast.dispatchable === true && statusReads.has(fair.batchOf(last))
      && publicationReads.has(fair.issueIds[last]) && fairAfter[last].stage === 'implementing'
      && fairAfter.slice(0, last).every(row => row.stage === 'freezing')
      && assignments(fair.stateDir).filter(row => row.proposalId === fair.proposalIds[last]).length === 1
      && fair.prepared('implementation').length === 1,
    JSON.stringify({ statusReads: [...statusReads], publicationReads: [...publicationReads], stages: fairAfter.map(row => row.stage) }));
  stageSuite(fair.fx, fair.issueIds[0], 'valid');
  commitAndPush(fair.fx, 'publish an earlier proposal afterward');
  await ticks(fairController, 6);
  const fairAssignments = assignments(fair.stateDir);
  check('C4/F3 later publication joins the existing feed without duplicating either assignment',
    fairAssignments.filter(row => row.proposalId === fair.proposalIds[0]).length === 1
      && fairAssignments.filter(row => row.proposalId === fair.proposalIds[last]).length === 1
      && new Set(fairAssignments.map(row => row.feedId)).size === 1
      && fair.prepared('implementation').length === 1);

  // More waiting proposals than the current tick's processing budget must still make
  // progress. Other sections cover real Git publication; here a counted unavailable
  // observer isolates scheduling without issuing hundreds of identical Git fetches.
  // Preparation writers, records, reader and child settlement remain real.
  const large = world('large-observation-queue', { proposals: 129 });
  const largePreparationReads = new Set();
  const largePublicationReads = new Set();
  const largeStatus = large.adapters.operations.status;
  const largeStatusSnapshots = new Map();
  let largePendingSetup = true;
  large.adapters.operations.status = async input => {
    largePreparationReads.add(input.id);
    // No fixture record changes within either phase. Capture each real reader's answer
    // once, then reuse that unchanged snapshot; invalidate all pending snapshots when
    // the real workers complete below. Count EVERY controller call, including cache hits.
    if (largeStatusSnapshots.has(input.id)) return largeStatusSnapshots.get(input.id);
    const answer = await largeStatus(input);
    if (largePendingSetup || (answer && answer.state === 'completed')) {
      largeStatusSnapshots.set(input.id, answer);
    }
    return answer;
  };
  const largePublication = large.adapters.publication;
  if (largePublication && typeof largePublication.observe === 'function') {
    largePublication.observe = input => {
      largePublicationReads.add(input.issueId);
      return { ok: false, published: false, available: false,
        issueId: input.issueId, target: LOCK.canonicalTarget(input.project),
        error: 'fixture: publication remains unavailable' };
    };
  }
  let largeController = large.build({ globalConcurrency: large.records.length,
    stageConcurrency: { preparation: large.records.length } });
  for (const record of large.records) await largeController.submit(record);
  await tickUntilSafely(largeController,
    () => large.prepared('preparation').length === large.records.length,
    large.records.length + 4);
  for (let index = 0; index < large.records.length; index += 1) {
    const proof = large.startWorker('proof', large.issueIds[index], true, large.batchOf(index));
    large.finishWorker(proof, 'proven-at-base', large.issueIds[index], {}, large.batchOf(index));
    large.exitChild('preparation', 0, large.batchOf(index));
  }
  largePendingSetup = false;
  largeStatusSnapshots.clear();
  await ticks(largeController, 5);
  const largePrimed = await Promise.all(large.proposalIds.map(id => largeController.status(id)));
  check('C1/F6 large-queue fixture has successful real preparation for every waiting proposal',
    largePrimed.every((row, index) => row.stage === 'freezing'
      && row.preparation && row.preparation.state === 'proven-at-base'
      && settledOk(large.grantNonce(index)) === 1));
  largeController = large.build({ globalConcurrency: 2, stageConcurrency: { preparation: 1 } });
  largePreparationReads.clear(); largePublicationReads.clear();
  await ticks(largeController, 6);
  check('C6/F7 bounded turns observe preparation and publication beyond one tick budget',
    large.proposalIds.every((id, index) => largePreparationReads.has(large.batchOf(index))
      && largePublicationReads.has(large.issueIds[index]))
      && assignments(large.stateDir).length === 0 && large.prepared('implementation').length === 0,
    JSON.stringify({ waiting: large.records.length, preparationReads: largePreparationReads.size,
      publicationReads: largePublicationReads.size }));

  const capped = world('observation-cap', { proposals: 2 });
  let cappedController = capped.build({ globalConcurrency: 2, stageConcurrency: { preparation: 2 } });
  for (const record of capped.records) await cappedController.submit(record);
  await tickUntilSafely(cappedController, () => capped.prepared('preparation').length === capped.records.length, 8);
  for (let index = 0; index < capped.records.length; index += 1)
    capped.startWorker('proof', capped.issueIds[index], true, capped.batchOf(index));
  await ticks(cappedController, 3);
  const cappedStatus = capped.adapters.operations.status;
  let activeReads = 0, peakReads = 0;
  const seenReads = new Set();
  capped.adapters.operations.status = async input => {
    activeReads += 1; peakReads = Math.max(peakReads, activeReads); seenReads.add(input.id);
    try { await new Promise(setImmediate); return cappedStatus(input); }
    finally { activeReads -= 1; }
  };
  await Promise.all(capped.records.map((_, index) => capped.adapters.operations.status({
    project: capped.fx.target, id: capped.batchOf(index),
  })));
  check('C1/F4 instrumentation detects overlapping preparation reads in its positive control',
    peakReads === 2 && capped.records.every((_, index) => seenReads.has(capped.batchOf(index))),
    JSON.stringify({ peakReads, seenReads: [...seenReads] }));
  activeReads = 0; peakReads = 0; seenReads.clear();
  await ticks(cappedController, 3);
  check('C1/F4 wider capacity bounds observations without requiring saturation',
    peakReads >= 1 && peakReads <= 2
      && capped.records.every((_, index) => seenReads.has(capped.batchOf(index))),
    JSON.stringify({ peakReads, seenReads: [...seenReads] }));
  cappedController = capped.build({ globalConcurrency: 2, stageConcurrency: { preparation: 1 } });
  activeReads = 0; peakReads = 0; seenReads.clear();
  await ticks(cappedController, 3);
  check('C1/F5 preparation observations obey the configured stage ceiling while remaining live',
    peakReads === 1 && capped.records.every((_, index) => seenReads.has(capped.batchOf(index))),
    JSON.stringify({ peakReads, seenReads: [...seenReads] }));

  // Freezing uses mixed preparation/publication observations; measure that path separately
  // from the proving path above, with global capacity wider than the preparation ceiling.
  const waitingCap = world('freezing-observation-cap', { proposals: 2 });
  let waitingController = waitingCap.build({ globalConcurrency: 3, stageConcurrency: { preparation: 2 } });
  for (const record of waitingCap.records) await waitingController.submit(record);
  await tickUntilSafely(waitingController,
    () => waitingCap.prepared('preparation').length === waitingCap.records.length, 8);
  for (let index = 0; index < waitingCap.records.length; index += 1) {
    const proof = waitingCap.startWorker('proof', waitingCap.issueIds[index], true, waitingCap.batchOf(index));
    waitingCap.finishWorker(proof, 'proven-at-base', waitingCap.issueIds[index], {}, waitingCap.batchOf(index));
    waitingCap.exitChild('preparation', 0, waitingCap.batchOf(index));
  }
  await ticks(waitingController, 4);
  const waitingPrimed = await Promise.all(waitingCap.proposalIds.map(id => waitingController.status(id)));
  check('C1/F8 mixed-observation fixture starts with every proposal settled and freezing',
    waitingPrimed.every((row, index) => row.stage === 'freezing'
      && issueStateOf(row) === 'proven-at-base' && settledOk(waitingCap.grantNonce(index)) === 1
      && publicationOf(row) && publicationOf(row).published === false));
  const waitingStatus = waitingCap.adapters.operations.status;
  let waitingActive = 0, waitingPeak = 0;
  const waitingReads = new Set(), waitingPublications = new Set();
  waitingCap.adapters.operations.status = async input => {
    waitingActive += 1; waitingPeak = Math.max(waitingPeak, waitingActive); waitingReads.add(input.id);
    try { await new Promise(setImmediate); return await waitingStatus(input); }
    finally { waitingActive -= 1; }
  };
  const waitingObserve = waitingCap.adapters.publication.observe.bind(waitingCap.adapters.publication);
  waitingCap.adapters.publication.observe = input => {
    waitingPublications.add(input.issueId); return waitingObserve(input);
  };
  await Promise.all(waitingCap.records.map((_, index) => waitingCap.adapters.operations.status({
    project: waitingCap.fx.target, id: waitingCap.batchOf(index),
  })));
  check('C1/F9 freezing instrumentation detects overlap in its positive control',
    waitingPeak === waitingCap.records.length
      && waitingCap.records.every((_, index) => waitingReads.has(waitingCap.batchOf(index))));
  waitingController = waitingCap.build({ globalConcurrency: 3, stageConcurrency: { preparation: 1 } });
  waitingActive = 0; waitingPeak = 0; waitingReads.clear(); waitingPublications.clear();
  await ticks(waitingController, 4);
  const waitingAfter = await Promise.all(waitingCap.proposalIds.map(id => waitingController.status(id)));
  check('C1/F10 mixed freezing observations obey the preparation ceiling and visit every waiting proposal',
    waitingPeak === 1 && waitingActive === 0
      && waitingCap.records.every((_, index) => waitingReads.has(waitingCap.batchOf(index))
        && waitingPublications.has(waitingCap.issueIds[index]))
      && waitingAfter.every(row => row.stage === 'freezing')
      && assignments(waitingCap.stateDir).length === 0 && waitingCap.prepared('implementation').length === 0,
    JSON.stringify({ waitingPeak, waitingReads: [...waitingReads], waitingPublications: [...waitingPublications] }));

  // A reloaded configuration must not let repository B's receipt masquerade as A's.
  const swapped = world('target-swap');
  const swapController = swapped.build();
  await swapController.submit(swapped.record);
  await ticks(swapController, 1);
  const swapProof = swapped.startWorker('proof');
  swapped.finishWorker(swapProof, 'proven-at-base'); swapped.exitChild('preparation');
  await ticks(swapController, 4);
  const otherTarget = remoteFixture('other-target');
  const otherHash = stageSuite(otherTarget, swapped.issueId, 'valid', '-B');
  commitAndPush(otherTarget, 'publish valid same-issue receipt only in B');
  const originalConfig = fs.readFileSync(swapped.fx.cfgFile);
  const originalPublication = swapped.adapters.publication;
  // A restart creates fresh production adapters; retaining an old adapter can conceal
  // a target swap by continuing to read its cached original configuration.
  const rebuildSwapController = () => {
    const fresh = SUP.productionAdapters(path.join(tmp, 'pipeline-host'), {
      configPath: swapped.fx.cfgFile, lease: swapped.lease,
    });
    return {
      publication: fresh.publication,
      controller: swapped.build({ adapters: { ...swapped.adapters, publication: fresh.publication } }),
    };
  };
  check('C3/T1 target-swap fixture has successful preparation, absent A and valid B publication',
    (await swapController.status(swapped.proposalId)).stage === 'freezing'
      && canonicalAdmission(swapped.fx.cfgFile, swapped.issueId).dispatchable === false
      && canonicalAdmission(otherTarget.cfgFile, swapped.issueId).dispatchable === true);
  // Path and fetch remote are independent configuration inputs. Retaining A's path
  // while changing only the remote to B must not label B's admitted receipt as A's.
  const originalSettings = JSON.parse(originalConfig.toString('utf8'));
  const foreignSettings = JSON.parse(fs.readFileSync(otherTarget.cfgFile, 'utf8'));
  const remoteOnlySettings = { ...originalSettings, targetRepoRemote: foreignSettings.targetRepoRemote };
  fs.writeFileSync(swapped.fx.cfgFile, JSON.stringify(remoteOnlySettings));
  const wrongRemote = originalPublication && typeof originalPublication.observe === 'function'
    ? await originalPublication.observe({ project: swapped.fx.target, issueId: swapped.issueId }) : null;
  await ticks(swapController, 3);
  const remoteBlocked = await swapController.status(swapped.proposalId);
  check('C3/T1r a remote-only swap cannot admit B receipt as evidence for A',
    remoteOnlySettings.targetRepoPath === originalSettings.targetRepoPath
      && wrongRemote && wrongRemote.published === false
      && (wrongRemote.ok === false || typeof wrongRemote.refusal === 'string')
      && remoteBlocked.stage === 'freezing' && countStage(remoteBlocked, 'ready') === 0
      && assignments(swapped.stateDir).length === 0 && swapped.prepared('implementation').length === 0,
    JSON.stringify({ wrongRemote, stage: remoteBlocked.stage }));
  const remoteRestart = rebuildSwapController();
  const restartedRemote = remoteRestart.publication && typeof remoteRestart.publication.observe === 'function'
    ? await remoteRestart.publication.observe({ project: swapped.fx.target, issueId: swapped.issueId }) : null;
  await ticks(remoteRestart.controller, 3);
  const remoteRestartBlocked = await remoteRestart.controller.status(swapped.proposalId);
  check('C3/T1rr reconstructed adapters refuse a remote-only swap for the existing proposal',
    restartedRemote && restartedRemote.published === false
      && (restartedRemote.ok === false || typeof restartedRemote.refusal === 'string')
      && remoteRestartBlocked.stage === 'freezing' && countStage(remoteRestartBlocked, 'ready') === 0
      && assignments(swapped.stateDir).length === 0 && swapped.prepared('implementation').length === 0
      && swapped.calls.specification === 1 && swapped.prepared('preparation').length === 1,
    JSON.stringify({ restartedRemote, stage: remoteRestartBlocked.stage }));
  fs.writeFileSync(swapped.fx.cfgFile, originalConfig);
  fs.writeFileSync(swapped.fx.cfgFile, fs.readFileSync(otherTarget.cfgFile));
  const wrongTarget = originalPublication && typeof originalPublication.observe === 'function'
    ? await originalPublication.observe({ project: swapped.fx.target, issueId: swapped.issueId }) : null;
  await ticks(swapController, 3);
  const swapBlocked = await swapController.status(swapped.proposalId);
  check('C3/T2 the existing production observer refuses a changed configured target identity',
    wrongTarget && wrongTarget.published === false
      && (wrongTarget.ok === false || typeof wrongTarget.refusal === 'string')
      && swapBlocked.stage === 'freezing' && countStage(swapBlocked, 'ready') === 0
      && assignments(swapped.stateDir).length === 0 && swapped.prepared('implementation').length === 0,
    JSON.stringify({ wrongTarget, stage: swapBlocked.stage }));
  const targetRestart = rebuildSwapController();
  const restartedTarget = targetRestart.publication && typeof targetRestart.publication.observe === 'function'
    ? await targetRestart.publication.observe({ project: swapped.fx.target, issueId: swapped.issueId }) : null;
  await ticks(targetRestart.controller, 3);
  const targetRestartBlocked = await targetRestart.controller.status(swapped.proposalId);
  check('C3/T2r reconstructed adapters refuse a different configured target for the existing proposal',
    restartedTarget && restartedTarget.published === false
      && (restartedTarget.ok === false || typeof restartedTarget.refusal === 'string')
      && targetRestartBlocked.stage === 'freezing' && countStage(targetRestartBlocked, 'ready') === 0
      && assignments(swapped.stateDir).length === 0 && swapped.prepared('implementation').length === 0
      && swapped.calls.specification === 1 && swapped.prepared('preparation').length === 1,
    JSON.stringify({ restartedTarget, stage: targetRestartBlocked.stage }));
  fs.writeFileSync(swapped.fx.cfgFile, originalConfig);
  const ownHash = stageSuite(swapped.fx, swapped.issueId, 'valid', '-A');
  commitAndPush(swapped.fx, 'publish the same issue in its own target');
  const restored = rebuildSwapController();
  const swapRecovered = await tickUntil(restored.controller, swapped.proposalId, row => row.stage === 'implementing', 8);
  const ownPublication = publicationOf(swapRecovered);
  check('C4/T3 restoring A admits only its own distinctly hashed suite exactly once',
    ownHash !== otherHash && swapRecovered.stage === 'implementing'
      && ownPublication && ownPublication.target === LOCK.canonicalTarget(swapped.fx.target)
      && ownPublication.suiteHash === ownHash && assignments(swapped.stateDir).length === 1
      && swapped.prepared('implementation').length === 1
      && swapped.calls.specification === 1 && swapped.prepared('preparation').length === 1);
}

const watchdog = setTimeout(() => {
  check('C1-C6 the composed fixture completes', false, 'timed out with unresolved work');
  rmrf(tmp);
  process.exit(1);
}, 420000);

main()
  .catch(error => check('C1-C6 the composed fixture completes', false,
    (error && error.stack) || String(error)))
  .then(() => {
    clearTimeout(watchdog);
    QUEUE.partitionByFreeze = canonicalPartition;
    AUTH.settle = canonicalSettle;
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    check('C6 fixture targets leave no observer mirrors in the real checkout',
      fixtureMirrors.length > 0 && fixtureMirrors.every(row => !fs.existsSync(row.realCheckout)));
    rmrf(tmp);
    check('C6 disposable observer mirrors are removed after all ownership assertions',
      fixtureMirrors.every(row => !fs.existsSync(row.disposable)));
    process.exit(failed);
  });
