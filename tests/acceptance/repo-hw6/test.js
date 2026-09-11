// Frozen acceptance test — repo-hw6: fail preparation fast when Docker is unavailable.
// This is the RED half. `guard.js` beside it is the whole of C5 plus one C3 check, and carries
// what is already green at the fork point and must stay that way.
//
// WHICH CRITERION EACH SECTION PROVES (every check below names its own in its label):
//
//   C1  `prepare-batch start` checks Docker daemon reachability, required image presence,
//       configured host shell, and required model authentication before launching any author
//       or probe operation.                                    -> checks labelled C1.1 - C1.10
//   C2  an unavailable prerequisite fails within a bounded short interval, names the exact
//       remedy, launches zero model containers, consumes zero per-issue attempts, and records
//       no proven/unproven suite classification.                -> C2.1 - C2.11
//   C3  the same named batch can be retried after the prerequisite is restored without manual
//       cleanup or an uncertain-preparation override.
//                     -> C3.1 - C3.5 here; C3.6, its converse, is a [guard] in `guard.js`
//   C4  deterministic Docker-free tests stub every prerequisite and prove fail-fast ordering
//       before filesystem, Beads, Git publication, or agent launch mutation.
//                                                               -> C4.1 - C4.9
//   C5  a healthy preparation retains current parallel author concurrency, proof semantics,
//       and freeze-marker behavior.        -> proven ENTIRELY by `guard.js`. It is a criterion
//       about what did NOT change, so it is green at the fork point by construction and a red
//       file is the wrong home for it. Nothing in THIS file serves C5.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE FROZEN INTERFACE. The issue names a COMMAND (`prepare-batch start`) and four
// PREREQUISITES, but no module, function or diagnostic surface (see SPEC DEFECTS below), so
// this suite fixes one. Node built-ins only, synchronous probes, no container engine and no
// network — the same shape as `runner/preflight.js`, whose existing probes it reuses.
//
// `runner/prerequisites.js` exports:
//
//   PREREQUISITES = ['docker-daemon', 'required-image', 'host-shell', 'model-auth']
//     Exactly these four ids, in exactly this order. The order IS the contract: it is what
//     "fail fast" means when more than one prerequisite is missing at once, and it puts the
//     cheapest, most commonly broken check first.
//
//   PREREQUISITE_TIMEOUT_MS
//     The module's own ceiling on how long ONE prerequisite probe may take: a whole number of
//     milliseconds, at least 1000 and at most 30000. The "bounded short interval" of C2 lives
//     here, in code, not in an operator's config — which can only LOWER it.
//
//   checkPrerequisites(cfg, repoRoot, deps = {})
//     -> { ok: true,  checked: [...PREREQUISITES] }
//     -> { ok: false, prerequisite, reason, remedy, checked }
//     Runs the four probes in PREREQUISITES order and STOPS AT THE FIRST FAILURE.
//     `checked` lists the ids actually attempted, in order, ending with the failing one, so
//     "it stopped where it says it stopped" is observable rather than inferred from timing.
//     `prerequisite` is the failing id. `reason` says what was observed. `remedy` is the exact
//     thing an operator must do, NAMED — the engine, the configured image, the configured
//     shell, the token variable and the file it is read from — because a refusal a person
//     cannot act on has not helped anybody.
//     The bound applied to every probe is
//         min(PREREQUISITE_TIMEOUT_MS, positive integer cfg.lifecycleTimeoutMs or the ceiling)
//     and it is delivered through the EXISTING probe signatures, so no probe grows a new one:
//       deps.dockerAvailable(probeCfg)                  probeCfg.lifecycleTimeoutMs === bound
//       deps.imageExists(cfg.image, probeCfg)           probeCfg.lifecycleTimeoutMs === bound
//       deps.resolveHostShell(cfg.hostShell, { timeoutMs: bound })
//       deps.loadToken(repoRoot)                        a file read; it needs no bound
//     Each `deps` entry defaults to the production implementation already in this tree —
//     `runner/preflight.js` dockerAvailable/imageExists, `runner/host-shell.js`
//     resolveHostShell, `runner/config.js` loadToken. A probe that reports `timedOut: true`
//     (`runner/process.js`) is a failure of ITS prerequisite, never a pass.
//     'model-auth' fails when `loadToken` yields no non-blank token.
//
// `scripts/prepare-batch.js` calls it, ONCE, as
//
//     (seams.checkPrerequisites || prerequisites.checkPrerequisites)(cfg, ROOT, seams)
//
//   — the seam bag IS the deps bag, so a frozen test stubs every prerequisite through the same
//   channel the rest of this command is already tested through, with no container engine
//   anywhere. It runs for the three modes that can launch a worker (`start`, `resume`,
//   `retry`) and NOT for `status` or `acknowledge-interrupted`, which launch nothing
//   (SPEC DEFECT 3).
//   On refusal `execute` returns `EXIT_REFUSED` (3) and writes to `io.err` the failing
//   prerequisite id, the `reason`, the `remedy` VERBATIM, the batch id, the fact that no author
//   or probe operation was launched, and that the same batch id may be retried once the
//   prerequisite is fixed.
//   POSITION: before the target lock, the batch manifest, any Beads read or write, any
//   worktree creation and any author or probe launch. Its position relative to the pure READS
//   that already precede those (`loadConfig`, child admission, the write-protection backstop)
//   is deliberately NOT pinned here — see SPEC DEFECT 2.
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// SELF-CONTAINED, DETERMINISTIC AND DOCKER-FREE, which is C4's own instruction. Every
// prerequisite is stubbed and every worker process is a fake; nothing here starts a container
// engine, reaches a network, or reads an ambient `.env.pipeline`. It resolves the repository the
// way every suite here does — the tree it sits in, never the cwd.
//
// EVERY HOST-GLOBAL AUTHORITY IT TOUCHES IS RE-AIMED. `PIPELINE_GLOBAL_LOCK_DIR` moves the
// canonical-target lock authority into a disposable temp directory and `PREPARATION_RUNS_DIR`
// does the same for preparation state, so running this file can never disturb a live run on
// the same machine. The lock's observer mirror is redirected by hand for the same reason: a
// frozen suite writes nothing into the checkout it is judging.
//
// TWO LINES ARE LABELLED `HARNESS` AND SERVE NO CRITERION, deliberately and visibly. They are
// fixture preconditions — the fixture checkout is admissible to the write-protection backstop,
// and the disposable authorities start empty — and they exist so that a broken fixture says so
// in one line instead of making a dozen criterion checks lie about why they failed. They are
// green at the fork point and after it; they are not guards, because they pin nothing about the
// product, and they are not criteria, because no criterion is about them.
//
// THE NEGATIVE CHECKS ARE REAL NEGATIVES. "Consumed no attempt", "left no uncertainty marker"
// and "launched nothing" are only worth asserting if the fork point VIOLATES them, so the
// durable-state section stubs `spawn` and lets the REAL `runWorker`, the REAL
// `runner/preparation-state.js` and the REAL `runner/lock.js` do their work. At the fork point
// that writes an attempt record, an uncertainty marker and a proven/unproven event — exactly
// the things C2 says a refusal must not spend — and every one of those checks is red because
// of it, not because a stub declined to act.
//
// SPEC DEFECTS, REPORTED NOT PAPERED OVER.
//
//  1. THE ISSUE NAMES NO SURFACE. Not a module, not a function, not a diagnostic — only four
//     prerequisites and an ordering. A frozen suite cannot assert behaviour without naming the
//     thing that behaves, so THE INTERFACE BLOCK ABOVE IS the missing half of the spec and
//     every check below is written against it. An implementation that satisfies the criteria
//     through a differently-named surface is not wrong about the issue; it is wrong about this
//     suite, and the suite is what freezes.
//
//  2. C4 SAYS "BEFORE FILESYSTEM ... MUTATION", AND READS ARE UNAVOIDABLE. `loadConfig` reads
//     a file; the write-protection backstop (change-log row `repo-324`) reads `git status`;
//     `resolveHostShell` itself stats candidate shells. So every check below measures
//     MUTATION — a byte written under the preparation root or the host-global lock authority, a
//     Beads call, the target repository's HEAD and porcelain state, a created worktree, a
//     spawned worker — and never mere access. The gate's position relative to those reads is
//     left free on purpose: pinning it would freeze an ordering the issue does not state, and
//     `runner/supervisor.js` admission already claims the first position for itself.
//
//  3. "WITHOUT ... AN UNCERTAIN-PREPARATION OVERRIDE" (C3) READS ON RECOVERY TOO. The override
//     it names is `acknowledge-interrupted`, and the only way a prerequisite refusal can avoid
//     needing one is to leave no uncertainty marker and no allocated batch id behind (C3.1-3.3).
//     Its converse is that `acknowledge-interrupted` must NOT be gated on the prerequisites: a
//     recovery verb that needs a running Docker daemon to settle a record a broken Docker
//     daemon left is an override no operator can reach. That converse is EXISTING behaviour
//     which must survive this change, so it is a `[guard]` — C3.6, in `guard.js`. `status` is
//     excluded from the gate for the same reason: it launches nothing.
//
//  4. "CONSUMES ZERO PER-ISSUE ATTEMPTS" (C2) is read as: no attempt is ALLOCATED. In this tree
//     an attempt is a `<nonce>.started.json` / `<nonce>.result.json` pair under the preparation
//     root (`runner/preparation-state.js`), and a batch id is allocated by an O_EXCL manifest
//     write. A refusal that writes either has spent something a retry cannot get back, which is
//     why C2 and C3 are two halves of one observation.
//
//  5. "RECORDS NO PROVEN/UNPROVEN SUITE CLASSIFICATION" (C2) is read as: no event-ledger entry
//     at all for the batch, and no green-probe freeze marker (`scripts/prove-tests.js` MARKER)
//     anywhere the refusal could have put one.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..', '..');
const PREREQUISITES_MODULE = path.join(REPO, 'runner', 'prerequisites.js');
const PREPARE_BATCH = path.join(REPO, 'scripts', 'prepare-batch.js');
const LOCK = path.join(REPO, 'runner', 'lock.js');
const PREP_STATE = path.join(REPO, 'runner', 'preparation-state.js');
const PROVE_TESTS = path.join(REPO, 'scripts', 'prove-tests.js');
const WRITE_PROTECTION = path.join(REPO, 'scripts', 'write-protection-policy.js');

// Fixtures are routinely owned by another uid inside a container, and a frozen test must not
// depend on ambient git config.
const GIT_SAFE = ['-c', 'safe.directory=*'];

let failed = 0;
function check(name, cond, detail) {
  console.log(`${cond ? 'ok' : 'FAIL'} - ${name}${!cond && detail ? ` — ${detail}` : ''}`);
  if (!cond) failed = 1;
}
async function section(label, fn) {
  try { await fn(); }
  catch (e) { check(`${label} ran to completion`, false, `threw ${(e && e.message) || e}`); }
}
function git(cwd, ...args) {
  return spawnSync('git', [...GIT_SAFE, ...args], {
    cwd, encoding: 'utf8', timeout: 60000, maxBuffer: 64 * 1024 * 1024, windowsHide: true,
  });
}
// Temp trees hold lock records created with mode 0o600 and, on Windows, files a rename left
// read-only. Clear the bits before removing, and never let disposal decide a verdict.
function rmrf(target) {
  const walk = (p) => {
    let stat;
    try { stat = fs.lstatSync(p); } catch { return; }
    try { fs.chmodSync(p, 0o700); } catch { /* best effort */ }
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      let names = [];
      try { names = fs.readdirSync(p); } catch { names = []; }
      for (const n of names) walk(path.join(p, n));
    }
  };
  walk(target);
  try { fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  catch { /* disposable */ }
}
const fwd = (p) => String(p).split(path.sep).join('/');
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// A whole-tree fingerprint, so "the filesystem was not mutated" is a statement about bytes
// rather than about one file somebody remembered to look at. An absent tree is its own value:
// the refusal must not so much as create the directory.
function treeDigest(root) {
  if (!fs.existsSync(root)) return 'ABSENT';
  const out = [];
  const walk = (dir, rel) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.slice().sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const abs = path.join(dir, entry.name);
      const key = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { out.push(`d ${key}`); walk(abs, key); continue; }
      let digest = 'unreadable';
      try { digest = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex'); }
      catch { /* recorded as unreadable, which is still a difference */ }
      out.push(`f ${key} ${digest}`);
    }
  };
  walk(root, '');
  return out.join('\n');
}
function filesMatching(root, re) {
  const found = [];
  const walk = (dir, rel) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const key = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), key);
      else if (re.test(key)) found.push(key);
    }
  };
  walk(root, '');
  return found;
}
function gitState(dir) {
  return JSON.stringify({
    head: String(git(dir, 'rev-parse', 'HEAD').stdout || '').trim(),
    porcelain: String(git(dir, 'status', '--porcelain').stdout || '').trim(),
  });
}

// ---- disposable authorities -----------------------------------------------------------------

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-hw6-'));
const savedEnv = {
  PIPELINE_GLOBAL_LOCK_DIR: process.env.PIPELINE_GLOBAL_LOCK_DIR,
  PREPARATION_RUNS_DIR: process.env.PREPARATION_RUNS_DIR,
  PIPELINE_BD_CMD: process.env.PIPELINE_BD_CMD,
  PIPELINE_CHILD_AUTHORITY: process.env.PIPELINE_CHILD_AUTHORITY,
};
const LOCK_ROOT = path.join(tmp, 'lockauth');
const PREP_ROOT = path.join(tmp, 'preparations');
const MIRROR = path.join(tmp, 'observer');
const NO_BD = path.join(tmp, 'no-such-bd-binary');
process.env.PIPELINE_GLOBAL_LOCK_DIR = LOCK_ROOT;
process.env.PREPARATION_RUNS_DIR = PREP_ROOT;
process.env.PIPELINE_BD_CMD = NO_BD;
delete process.env.PIPELINE_CHILD_AUTHORITY;
fs.mkdirSync(MIRROR, { recursive: true });

const prepare = require(PREPARE_BATCH);
const lock = require(LOCK);
const prepState = require(PREP_STATE);
const prove = require(PROVE_TESTS);
const writeProtection = require(WRITE_PROTECTION);

// The one module this task is supposed to add. Loaded defensively so a missing file is ONE
// named failure per criterion instead of a stack trace that says nothing about which surface
// moved — and never a skip: a check that cannot run is a check that failed.
let prereq = null;
let prereqLoadError = null;
try { prereq = require(PREREQUISITES_MODULE); }
catch (e) { prereq = null; prereqLoadError = (e && e.message) || String(e); }

const PREREQ_IDS = ['docker-daemon', 'required-image', 'host-shell', 'model-auth'];
const HEAD = 'f'.repeat(40);
const ISSUE = 'hw6-issue-1';
const BATCH = 'hw6-batch-a';

// ---- fixtures -------------------------------------------------------------------------------

// A real repository, so "no Git publication mutation" is a statement about a HEAD and a
// porcelain listing rather than about a directory nobody could have committed to. Deliberately
// WITHOUT a `pipeline.config.json`: the write-protection backstop then classifies it as
// unprotected and admits it, which keeps every refusal below attributable to the prerequisite
// gate alone.
function repoProject(name) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'README.md'), `# hw6 fixture ${name}\n`);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'fixture@test.local');
  git(dir, 'config', 'user.name', 'fixture');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'fixture');
  return dir;
}

function runCfg(target, overrides = {}) {
  return {
    targetRepoPath: fwd(target),
    targetRepoRemote: 'https://example.invalid/hw6/target.git',
    image: 'pipeline-hw6:latest',
    hostShell: 'C:/no/such/shell.exe',
    network: 'hw6-net',
    proxyName: 'hw6-proxy',
    proxyPort: 18446,
    proxyUrl: 'http://hw6-proxy:18446',
    lifecycleTimeoutMs: 5000,
    bdTimeoutMs: 3000,
    gitTimeoutMs: 3000,
    testProbeAttempts: 1,
    allowHalfProven: false,
    ...overrides,
  };
}

function briefFor(id, cfg, dir) {
  return {
    ok: true, id, canonicalId: id, suiteId: id, state: 'write', branch: 'main',
    text: `brief for ${id}`,
    cfg,
    policy: { verifyCommand: 'sh tools/run-acceptance.sh', frozenPaths: [] },
    folder: { dir: fwd(dir), branch: `freeze-${id}`, exists: true },
    criteria: { source: 'structured', sha256: 'a'.repeat(64), text: '1. it works' },
    issueUpdatedAt: '2026-09-09T00:00:00.000Z',
    issue: { id, title: id, priority: 2, dependencies: [] },
  };
}

// Healthy stubs for all four prerequisites, plus the failure injectors. Every one of them is a
// pure function: this is what C4's "deterministic Docker-free tests stub every prerequisite"
// means, and no check below reaches a container engine to decide anything.
function healthyProbes(record = () => {}) {
  return {
    dockerAvailable: (probeCfg) => { record('docker-daemon', { probeCfg }); return { status: 0, stdout: 'ok', stderr: '' }; },
    imageExists: (image, probeCfg) => { record('required-image', { image, probeCfg }); return { status: 0, stdout: '[]', stderr: '' }; },
    resolveHostShell: (configured, opts) => { record('host-shell', { configured, opts }); return { ok: true, command: 'sh', kind: 'stub', configured: true }; },
    loadToken: (repoRoot) => { record('model-auth', { repoRoot }); return 'hw6-fixture-token'; },
  };
}
const FAILING = {
  'docker-daemon': (record) => ({
    dockerAvailable: (probeCfg) => { record('docker-daemon', { probeCfg }); return { status: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon at npipe:////./pipe/docker_engine.' }; },
  }),
  'required-image': (record) => ({
    imageExists: (image, probeCfg) => { record('required-image', { image, probeCfg }); return { status: 1, stdout: '', stderr: `Error: No such image: ${image}` }; },
  }),
  'host-shell': (record) => ({
    resolveHostShell: (configured, opts) => { record('host-shell', { configured, opts }); return { ok: false, reason: `configured hostShell '${configured}' is incompatible (missing)`, tried: [configured] }; },
  }),
  'model-auth': (record) => ({
    loadToken: (repoRoot) => { record('model-auth', { repoRoot }); return '   '; },
  }),
};
// "Names the exact remedy" is only assertable against named things. These are the named things:
// the engine, the configured image, the configured shell, and the token variable with the file
// it is read from.
const REMEDY_MUST_NAME = {
  'docker-daemon': () => [/docker/i, /daemon|desktop|start/i],
  'required-image': (cfg) => [new RegExp(escapeRe(cfg.image)), /build/i],
  'host-shell': (cfg) => [new RegExp(escapeRe(cfg.hostShell)), /hostshell/i],
  'model-auth': () => [/CLAUDE_CODE_OAUTH_TOKEN/, /\.env\.pipeline/],
};

function probeSet(failingId, record = () => {}) {
  const probes = healthyProbes(record);
  return failingId ? { ...probes, ...FAILING[failingId](record) } : probes;
}

// The gate, called directly, with every prerequisite stubbed and each call recorded in order.
function gateWith(cfg, failingId, repoRoot = REPO) {
  const seen = [];
  const record = (id, detail) => seen.push({ id, ...detail });
  const deps = probeSet(failingId, record);
  if (!prereq || typeof prereq.checkPrerequisites !== 'function') {
    return { seen, answer: null, missing: true };
  }
  return { seen, answer: prereq.checkPrerequisites(cfg, repoRoot, deps), missing: false };
}

// Worker processes that never existed. The parent's whole ownership protocol runs against them
// — nonce, start record, uncertainty marker, result, clearance — with no container, no model and
// no second Node process anywhere.
//
// TWO SHAPES, AND THE DIFFERENCE IS THE POINT. `fakeWorkerProcess` completes the protocol, which
// is what a healthy preparation looks like. `deadWorkerProcess` exits non-zero having produced
// no protocol result at all — which is what a worker launched at a host with no Docker daemon
// actually does, and it is the shape the fork point leaves behind: an allocated batch id, a
// consumed attempt, an event ledger, AND an uncertainty marker no later run can clear without
// the `acknowledge-interrupted` override C3 says must not be needed. Modelling the refusal path
// with the healthy shape would make three of C3's checks pass vacuously.
function worker(emit) {
  const child = new EventEmitter();
  child.pid = process.pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { end: () => {} };
  child.kill = () => {};
  setImmediate(() => emit(child));
  return child;
}
function fakeWorkerProcess(payload) {
  return worker((child) => {
    child.stdout.emit('data', Buffer.from(`${JSON.stringify(payload)}\n`));
    child.emit('close', 0);
  });
}
function deadWorkerProcess() {
  return worker((child) => {
    child.stderr.emit('data', Buffer.from('docker: error during connect: this error may indicate that the docker daemon is not running.\n'));
    child.emit('close', 1);
  });
}

// ---- the two `execute` drivers ---------------------------------------------------------------
// A: fully in memory, so ORDER is observable without a filesystem in the way.
// B: real `runner/preparation-state.js`, real `runner/lock.js` and the real `runWorker`
//    ownership protocol against disposable roots, so "consumed nothing" and "needs no cleanup"
//    are statements about actual bytes on disk.

function memoryDriver(cfg, opts = {}) {
  const calls = [];
  const rec = (name, fn) => (...args) => { calls.push(name); return fn(...args); };
  const record = (id) => calls.push(`prerequisite:${id}`);
  const MEM = path.join(tmp, 'memory-root-that-never-exists');
  const workDir = fs.mkdtempSync(path.join(tmp, 'worktree-'));
  const err = []; const out = [];
  const state = {
    preparationRoot: () => MEM,
    validateBatchId: () => true,
    validateIssueId: () => true,
    canonicalHash: () => 'H',
    redactConfig: (v) => v,
    createManifest: rec('createManifest', (_r, b, input) => ({ batchId: b, ...input })),
    readManifest: rec('readManifest', () => ({
      batchId: opts.batch || BATCH, runConfig: 'run.config.json', concurrency: 2,
      issues: [{ id: ISSUE }], configHash: 'H', config: cfg,
      integrationBranch: 'main', integrationHead: HEAD,
    })),
    appendEvent: rec('appendEvent', () => ({})),
    readEvents: () => [],
    readWorkerRecords: rec('readWorkerRecords', () => []),
    createWorkerNonce: () => 'a'.repeat(32),
    writeWorkerStarted: rec('writeWorkerStarted', () => {}),
    writeWorkerResult: rec('writeWorkerResult', () => {}),
    deriveState: () => ({ ok: true, issues: [] }),
  };
  const seams = {
    state,
    preparationRoot: () => MEM,
    admitEntry: () => ({ ok: true, mode: 'standalone' }),
    loadConfig: () => cfg,
    acquire: rec('acquire', () => ({ ok: true, tookOver: false, ownership: { target: cfg.targetRepoPath } })),
    release: () => {},
    runSync: () => ({ status: 0, stdout: HEAD, stderr: '' }),
    inspectIntegration: () => ({ ok: true, branch: 'main', head: HEAD }),
    readyQueue: rec('readyQueue', () => ({ ok: true, issues: [] })),
    bdJson: rec('bdJson', () => ({ ok: false, error: 'a frozen test never reaches Beads' })),
    buildBrief: rec('buildBrief', ({ id }) => briefFor(id, cfg, workDir)),
    ensureWorktree: rec('ensureWorktree', () => ({ ok: true })),
    markPreparationUncertain: rec('markPreparationUncertain', () => {}),
    clearPreparationUncertain: () => {},
    listPreparationUncertain: () => [],
    onWorkerProgress: () => {},
    spawn: rec('spawn', () => fakeWorkerProcess({ ok: true, outcome: 'proven-at-base' })),
    runWorker: rec('runWorker', (_r, _b, item) => Promise.resolve({ id: item.id, ok: true, outcome: 'proven-at-base' })),
    ...probeSet(opts.failing || null, record),
    ...(opts.seams || {}),
  };
  return { calls, err, out, seams, io: { out: (s) => out.push(String(s)), err: (s) => err.push(String(s)) } };
}

// Anything in this list, called by `execute`, is a MUTATION or an agent launch. SPEC DEFECT 2
// records why pure reads are not in it.
const MUTATIONS = [
  'acquire', 'createManifest', 'appendEvent', 'readWorkerRecords', 'buildBrief', 'bdJson',
  'readyQueue', 'ensureWorktree', 'markPreparationUncertain', 'writeWorkerStarted',
  'writeWorkerResult', 'runWorker', 'spawn',
];

function realDriver(cfg, opts = {}) {
  const calls = [];
  const rec = (name, fn) => (...args) => { calls.push(name); return fn(...args); };
  const record = (id) => calls.push(`prerequisite:${id}`);
  const workDir = fs.mkdtempSync(path.join(tmp, 'worktree-'));
  const err = []; const out = [];
  const seams = {
    // No `state` and no `runWorker` seam: the REAL preparation state and the REAL worker
    // ownership protocol run, aimed at disposable roots. Only the child PROCESS is fake, which
    // is the one thing that would otherwise need a container engine. The lock's observer mirror
    // is redirected by hand — `lock.acquire` writes it under the pipeline repo root it is
    // handed, and a frozen suite writes nothing into the checkout it is judging.
    admitEntry: () => ({ ok: true, mode: 'standalone' }),
    loadConfig: () => cfg,
    acquire: rec('acquire', (_root, targetPath, runId, options) => lock.acquire(MIRROR, targetPath, runId, options)),
    release: rec('release', (_root, targetPath, ownership) => lock.release(MIRROR, targetPath, ownership)),
    runSync: () => ({ status: 0, stdout: HEAD, stderr: '' }),
    inspectIntegration: () => ({ ok: true, branch: 'main', head: HEAD }),
    readyQueue: rec('readyQueue', () => ({ ok: true, issues: [] })),
    bdJson: rec('bdJson', () => ({ ok: false, error: 'a frozen test never reaches Beads' })),
    buildBrief: rec('buildBrief', ({ id }) => briefFor(id, cfg, workDir)),
    ensureWorktree: rec('ensureWorktree', () => ({ ok: true })),
    onWorkerProgress: () => {},
    spawn: rec('spawn', () => (opts.deadWorker
      ? deadWorkerProcess()
      : fakeWorkerProcess({ ok: true, outcome: 'proven-at-base' }))),
    ...probeSet(opts.failing || null, record),
    ...(opts.seams || {}),
  };
  return { calls, err, out, seams, io: { out: (s) => out.push(String(s)), err: (s) => err.push(String(s)) } };
}

// One `execute` call, with its own failure captured rather than allowed to end the section: a
// throw is one named failure, not eleven silent absences.
async function runExecute(opts, driver) {
  try { return { code: await prepare.execute(opts, driver.io, driver.seams) }; }
  catch (e) { return { code: null, error: (e && e.message) || String(e) }; }
}

// ---- the run --------------------------------------------------------------------------------

async function main() {
  const target = repoProject('target');
  const cfg = runCfg(target);

  // The one assumption this suite inherits rather than proves: an integration checkout with no
  // `pipeline.config.json` is unprotected, so the write-protection backstop admits it and every
  // refusal below is attributable to the prerequisite gate alone. Asserted, not assumed
  // silently — if it ever stops holding, this line says so instead of eleven others lying.
  check('HARNESS the fixture integration checkout is admissible to the write-protection backstop',
    writeProtection.admit(target, { issues: [ISSUE] }).admit === true);

  // ── C1 ─────────────────────────────────────────────────────────────────────────────────────
  // "checks Docker daemon reachability, required image presence, configured host shell, and
  // required model authentication before launching any author or probe operation"
  await section('C1', () => {
    check('C1.1 runner/prerequisites.js exists and exports checkPrerequisites, PREREQUISITES and PREREQUISITE_TIMEOUT_MS',
      !!prereq && typeof prereq.checkPrerequisites === 'function'
        && Array.isArray(prereq.PREREQUISITES) && Number.isInteger(prereq.PREREQUISITE_TIMEOUT_MS),
      prereqLoadError ? `module could not be loaded: ${prereqLoadError}` : 'exports missing');
    check('C1.2 the four prerequisites are exactly Docker daemon, required image, configured host shell and model authentication, in that order',
      !!prereq && same(prereq.PREREQUISITES, PREREQ_IDS),
      prereq ? `PREREQUISITES = ${JSON.stringify(prereq.PREREQUISITES)}` : 'no module');

    const healthy = gateWith(cfg, null);
    check('C1.3 a healthy host answers ok and reports having checked all four prerequisites',
      !healthy.missing && !!healthy.answer && healthy.answer.ok === true
        && same(healthy.answer.checked, PREREQ_IDS),
      `answer = ${JSON.stringify(healthy.answer)}`);
    check('C1.4 all four prerequisites are actually probed, in PREREQUISITES order',
      same(healthy.seen.map((s) => s.id), PREREQ_IDS),
      `probed = ${JSON.stringify(healthy.seen.map((s) => s.id))}`);
    check('C1.5 the image probe asks about the CONFIGURED image and the shell probe about the CONFIGURED host shell',
      healthy.seen.some((s) => s.id === 'required-image' && s.image === cfg.image)
        && healthy.seen.some((s) => s.id === 'host-shell' && s.configured === cfg.hostShell),
      `probed = ${JSON.stringify(healthy.seen.map((s) => ({ id: s.id, image: s.image, configured: s.configured })))}`);
    check('C1.6 model authentication is resolved from the pipeline repo root the gate was handed',
      (() => {
        const root = path.join(tmp, 'some-pipeline-root');
        const aimed = gateWith(cfg, null, root);
        return aimed.seen.some((s) => s.id === 'model-auth' && s.repoRoot === root);
      })());

    for (const id of PREREQ_IDS) {
      const refused = gateWith(cfg, id);
      check(`C1.7 an unavailable ${id} is refused and named as the failing prerequisite`,
        !refused.missing && !!refused.answer && refused.answer.ok === false
          && refused.answer.prerequisite === id,
        `answer = ${JSON.stringify(refused.answer)}`);
    }
    check('C1.8 a blank model token is an unavailable prerequisite, not an empty pass',
      (() => {
        const blank = gateWith(cfg, 'model-auth');
        return !!blank.answer && blank.answer.ok === false && blank.answer.prerequisite === 'model-auth';
      })());
    check('C1.9 a probe that exhausted its bound is a failure of its own prerequisite, never a pass',
      (() => {
        if (!prereq || typeof prereq.checkPrerequisites !== 'function') return false;
        const deps = {
          ...healthyProbes(),
          dockerAvailable: () => ({ status: null, timedOut: true, stdout: '', stderr: '' }),
        };
        const answer = prereq.checkPrerequisites(cfg, REPO, deps);
        return !!answer && answer.ok === false && answer.prerequisite === 'docker-daemon'
          && /tim(ed )?out/i.test(String(answer.reason || ''));
      })());
  });

  // ── C2, the parts provable against the gate itself ─────────────────────────────────────────
  // "fails within a bounded short interval, names the exact remedy"
  await section('C2 gate', () => {
    check('C2.1 the module owns a short bound of its own — a whole number of milliseconds between 1000 and 30000',
      !!prereq && Number.isInteger(prereq.PREREQUISITE_TIMEOUT_MS)
        && prereq.PREREQUISITE_TIMEOUT_MS >= 1000 && prereq.PREREQUISITE_TIMEOUT_MS <= 30000,
      `PREREQUISITE_TIMEOUT_MS = ${prereq && prereq.PREREQUISITE_TIMEOUT_MS}`);

    const boundOf = (s) => (s.probeCfg ? s.probeCfg.lifecycleTimeoutMs : (s.opts ? s.opts.timeoutMs : null));
    const ceiling = prereq ? prereq.PREREQUISITE_TIMEOUT_MS : null;
    const unbounded = gateWith(runCfg(target, { lifecycleTimeoutMs: 10 ** 9 }), null);
    check('C2.2 no probe is given more than the module ceiling, whatever the config asks for',
      Number.isInteger(ceiling) && unbounded.seen.length === 4
        && unbounded.seen.filter((s) => s.id !== 'model-auth').every((s) => {
          const bound = boundOf(s);
          return Number.isInteger(bound) && bound > 0 && bound <= ceiling;
        }),
      `bounds = ${JSON.stringify(unbounded.seen.map(boundOf))}`);
    const lowered = gateWith(runCfg(target, { lifecycleTimeoutMs: 1234 }), null);
    check('C2.3 a config may only LOWER the bound, and every bounded probe is handed the lowered one',
      lowered.seen.length === 4
        && lowered.seen.filter((s) => s.id !== 'model-auth').every((s) => boundOf(s) === 1234),
      `bounds = ${JSON.stringify(lowered.seen.map(boundOf))}`);

    for (const id of PREREQ_IDS) {
      const answer = gateWith(cfg, id).answer || {};
      const remedy = String(answer.remedy || '');
      check(`C2.4 the ${id} refusal names an actionable remedy, not just a failure`,
        remedy.length >= 20 && String(answer.reason || '').length > 0
          && REMEDY_MUST_NAME[id](cfg).every((re) => re.test(remedy)),
        `reason = ${JSON.stringify(answer.reason)}, remedy = ${JSON.stringify(answer.remedy)}`);
    }
  });

  // ── C4, the parts provable against the gate itself ─────────────────────────────────────────
  // "stub every prerequisite and prove fail-fast ordering"
  await section('C4 gate', () => {
    let source = null;
    try { source = fs.readFileSync(PREREQUISITES_MODULE, 'utf8'); } catch { source = null; }
    check('C4.1 every prerequisite is delegated to an existing stubbable module, and the gate itself spawns nothing',
      !!source
        && /require\(['"]\.\/preflight['"]\)/.test(source)
        && /require\(['"]\.\/host-shell['"]\)/.test(source)
        && /require\(['"]\.\/config['"]\)/.test(source)
        && !/require\(['"]child_process['"]\)/.test(source),
      source ? 'the module reaches for a container engine of its own, or bypasses an existing probe' : 'no module to read');

    // Fail-fast, stated as a prefix: the ids attempted are exactly those up to and including
    // the failing one, and NOT ONE MORE. Timing proves nothing here; `checked` does.
    for (let i = 0; i < PREREQ_IDS.length; i += 1) {
      const id = PREREQ_IDS[i];
      const refused = gateWith(cfg, id);
      const expected = PREREQ_IDS.slice(0, i + 1);
      check(`C4.2 an unavailable ${id} stops the sequence there — the later prerequisites are never probed`,
        same(refused.seen.map((s) => s.id), expected)
          && !!refused.answer && same(refused.answer.checked, expected),
        `probed = ${JSON.stringify(refused.seen.map((s) => s.id))}, checked = ${JSON.stringify(refused.answer && refused.answer.checked)}`);
    }
  });

  // ── C1/C2/C4: `prepare-batch start` itself, in memory ──────────────────────────────────────
  await section('C1/C2/C4 prepare-batch ordering', async () => {
    const refused = memoryDriver(cfg, { failing: 'docker-daemon' });
    const first = await runExecute(
      { mode: 'start', batch: BATCH, config: 'run.config.json', issues: [ISSUE], concurrency: 2 }, refused);
    const text = refused.err.join('\n');

    check('C1.10 start consults the prerequisites and refuses before launching any author or probe operation',
      first.code === prepare.EXIT_REFUSED
        && !refused.calls.includes('runWorker') && !refused.calls.includes('spawn'),
      `exit ${first.code}${first.error ? ` (threw ${first.error})` : ''}, calls = ${JSON.stringify(refused.calls)}`);
    check('C4.3 the prerequisite probe is the FIRST thing start does that could mutate or launch anything',
      refused.calls[0] === 'prerequisite:docker-daemon',
      `calls = ${JSON.stringify(refused.calls)}`);
    check('C4.4 a refused start performs no filesystem, Beads, worktree or agent-launch operation at all',
      MUTATIONS.every((name) => !refused.calls.includes(name)),
      `mutations = ${JSON.stringify(refused.calls.filter((c) => MUTATIONS.includes(c)))}`);
    check('C2.5 the refusal names the prerequisite, the remedy verbatim, the batch and the retry',
      (() => {
        const answer = gateWith(cfg, 'docker-daemon').answer;
        if (!answer || !answer.remedy) return false;
        return text.includes('docker-daemon') && text.includes(String(answer.remedy))
          && text.includes(BATCH) && /retry/i.test(text)
          && /(author|probe|worker)[^\n]*launch/i.test(text);
      })(),
      `stderr = ${JSON.stringify(text)}`);

    const healthy = memoryDriver(cfg, {});
    const ok = await runExecute(
      { mode: 'start', batch: 'hw6-batch-healthy', config: 'run.config.json', issues: [ISSUE], concurrency: 2 }, healthy);
    const firstMutation = healthy.calls.findIndex((c) => MUTATIONS.includes(c));
    const lastProbe = healthy.calls.reduce((acc, c, i) => (c.startsWith('prerequisite:') ? i : acc), -1);
    check('C4.5 on a healthy host the four prerequisites are still settled before the first mutation',
      ok.code === 0 && lastProbe >= 0 && firstMutation > lastProbe,
      `exit ${ok.code}, calls = ${JSON.stringify(healthy.calls)}`);

    const seamed = memoryDriver(cfg, {
      seams: {
        checkPrerequisites: () => ({
          ok: false, prerequisite: 'docker-daemon', reason: 'stubbed unavailable',
          remedy: 'start Docker Desktop and run the same batch again', checked: ['docker-daemon'],
        }),
      },
    });
    const seamedRun = await runExecute(
      { mode: 'start', batch: 'hw6-batch-seam', config: 'run.config.json', issues: [ISSUE], concurrency: 2 }, seamed);
    check('C4.6 the whole gate is replaceable through one seam, so a Docker-free test can state its answer directly',
      seamedRun.code === prepare.EXIT_REFUSED && MUTATIONS.every((name) => !seamed.calls.includes(name)),
      `exit ${seamedRun.code}, calls = ${JSON.stringify(seamed.calls)}`);

    for (const mode of ['resume', 'retry']) {
      const gated = memoryDriver(cfg, { failing: 'docker-daemon', batch: BATCH });
      const modeRun = await runExecute(
        { mode, batch: BATCH, issues: mode === 'retry' ? [ISSUE] : [], concurrency: 2 }, gated);
      check(`C4.7 ${mode} is gated on the same prerequisites, and refuses before its own mutations`,
        modeRun.code === prepare.EXIT_REFUSED
          && !gated.calls.includes('acquire') && !gated.calls.includes('appendEvent')
          && !gated.calls.includes('runWorker') && !gated.calls.includes('spawn'),
        `exit ${modeRun.code}, calls = ${JSON.stringify(gated.calls)}`);
    }
  });

  // ── C2/C3/C4 against the real preparation state and the real lock authority ────────────────
  await section('C2/C3/C4 durable state', async () => {
    const beforePrep = treeDigest(PREP_ROOT);
    const beforeLocks = treeDigest(LOCK_ROOT);
    const beforeGit = gitState(target);
    check('HARNESS the disposable preparation and lock authorities start empty',
      beforePrep === 'ABSENT' && beforeLocks === 'ABSENT',
      `preparation ${beforePrep}, locks ${beforeLocks}`);

    const refused = realDriver(cfg, { failing: 'docker-daemon', deadWorker: true });
    const startedAt = Date.now();
    const run = await runExecute(
      { mode: 'start', batch: BATCH, config: 'run.config.json', issues: [ISSUE], concurrency: 2 }, refused);
    const elapsed = Date.now() - startedAt;
    const attempts = filesMatching(PREP_ROOT, /\.(started|result)\.json$/);
    const events = filesMatching(PREP_ROOT, /(^|\/)events\//);
    const markers = new RegExp(`${escapeRe(prove.MARKER)}$`);

    check('C2.6 an unavailable prerequisite refuses within a bounded short interval',
      run.code === prepare.EXIT_REFUSED && elapsed < 10000,
      `exit ${run.code}${run.error ? ` (threw ${run.error})` : ''} after ${elapsed}ms`);
    check('C2.7 zero model containers: no worker process was launched and no worktree was created',
      !refused.calls.includes('spawn') && !refused.calls.includes('ensureWorktree'),
      `calls = ${JSON.stringify(refused.calls)}`);
    check('C2.8 zero per-issue attempts: no worker attempt record exists anywhere under the preparation root',
      attempts.length === 0, `records = ${JSON.stringify(attempts)}`);
    check('C2.9 no proven/unproven classification is recorded: no event ledger entry and no green-probe freeze marker',
      events.length === 0 && filesMatching(PREP_ROOT, markers).length === 0
        && filesMatching(target, markers).length === 0,
      `events = ${JSON.stringify(events)}`);
    check('C4.8 the refusal mutates neither the preparation tree nor the host-global lock authority',
      treeDigest(PREP_ROOT) === beforePrep && treeDigest(LOCK_ROOT) === beforeLocks,
      `preparation now ${treeDigest(PREP_ROOT)}; locks now ${treeDigest(LOCK_ROOT)}`);
    check('C4.9 the refusal makes no Beads call and leaves the integration checkout unpublished and unchanged',
      !refused.calls.includes('bdJson') && !refused.calls.includes('readyQueue')
        && !refused.calls.includes('buildBrief') && gitState(target) === beforeGit,
      `calls = ${JSON.stringify(refused.calls)}`);
    check('C3.1 the batch id is still unallocated — no manifest was written for it',
      !fs.existsSync(path.join(PREP_ROOT, BATCH)),
      `batch directory = ${path.join(PREP_ROOT, BATCH)}`);
    check('C3.2 the refusal never took ownership of the target: the lock authority was not even created',
      !fs.existsSync(LOCK_ROOT) && !fs.existsSync(lock.globalLockPath(cfg.targetRepoPath)),
      `lock authority = ${LOCK_ROOT}`);
    check('C3.3 no uncertain-preparation marker was left, so no override is needed to retry',
      lock.listPreparationUncertain(cfg.targetRepoPath).length === 0,
      `markers = ${JSON.stringify(lock.listPreparationUncertain(cfg.targetRepoPath))}`);

    // NOTHING BETWEEN THE TWO RUNS. No cleanup, no acknowledgement, no new batch id — which is
    // the whole of C3. The digests are re-read here so "no manual cleanup" is a fact about the
    // tree rather than about what this test remembered not to do.
    check('C3.4 nothing was cleaned up or acknowledged between the refusal and the retry',
      treeDigest(PREP_ROOT) === beforePrep && treeDigest(LOCK_ROOT) === beforeLocks);

    const restored = realDriver(cfg, {});
    const retry = await runExecute(
      { mode: 'start', batch: BATCH, config: 'run.config.json', issues: [ISSUE], concurrency: 2 }, restored);
    check('C3.5 the SAME batch name starts cleanly once the prerequisite is restored, and really does the work',
      retry.code === 0 && restored.calls.includes('spawn')
        && fs.existsSync(path.join(PREP_ROOT, BATCH, 'manifest.json'))
        && filesMatching(PREP_ROOT, /\.result\.json$/).length === 1,
      `exit ${retry.code}${retry.error ? ` (threw ${retry.error})` : ''}, calls = ${JSON.stringify(restored.calls)}`);
  });

  // ── C2's last half: the refusal is a refusal, not an attention state ────────────────────────
  await section('C2 exit contract', async () => {
    const refused = memoryDriver(cfg, { failing: 'model-auth' });
    const run = await runExecute(
      { mode: 'start', batch: 'hw6-batch-auth', config: 'run.config.json', issues: [ISSUE], concurrency: 2 }, refused);
    check('C2.10 an unavailable prerequisite is a REFUSAL (exit 3), not a state needing inspection',
      run.code === prepare.EXIT_REFUSED && prepare.EXIT_REFUSED === 3,
      `exit ${run.code}${run.error ? ` (threw ${run.error})` : ''}`);
    check('C2.11 a missing model token refuses with its own remedy and launches nothing',
      /CLAUDE_CODE_OAUTH_TOKEN/.test(refused.err.join('\n'))
        && !refused.calls.includes('runWorker') && !refused.calls.includes('spawn'),
      `stderr = ${JSON.stringify(refused.err.join('\n'))}`);
  });
}

main().then(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  rmrf(tmp);
  process.exit(failed);
}).catch((e) => {
  console.log(`FAIL - HARNESS: the suite threw before finishing — ${(e && e.stack) || e}`);
  rmrf(tmp);
  process.exit(1);
});
