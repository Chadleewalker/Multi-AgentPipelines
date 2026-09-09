// Frozen acceptance test — repo-rj7, the [guard] half: one supervisor authority must be added
// WITHOUT spending the standalone behaviour the pipeline already has.
//
// [guard] Every check in this file is GREEN at the fork point and must stay green. It is the
// whole of criterion C6 — "with no supervisor present, the existing standalone prepare-batch,
// author-tests, prove-tests and runner/run.js lock suites and observable CLI behavior remain
// green" — and nothing else in this suite proves C6. Every red check for C1-C5 lives in
// `test.js` beside it.
//
// Nothing red belongs in this file. A [guard] file that is red at the fork point is a stale pin
// and refuses the freeze outright (`scripts/freeze-gate.js`, verdict `stale-guard`).
//
// SPEC DEFECT, REPORTED NOT PAPERED OVER. C6 names four SUITES: the lock suites of
// prepare-batch, author-tests, prove-tests and runner/run.js. Those are
// `scripts/test-prepare-batch.sh`, `scripts/test-author-tests.sh`, `scripts/test-prove-tests.sh`
// and `scripts/test-lock.sh`, all matching `scripts/test-*.sh` in `pipeline.config.json`
// `frozenPaths`, plus `tests/unit/lock.test.js` under the frozen `tests/unit/`. A frozen
// acceptance suite may never edit those files, and shelling into one asserts through a file it
// cannot adjust; the freeze gate also runs this guard subset ALONE in a flat scratch directory,
// where no sibling helper is reachable. So C6 is proven the way `repo-yk4` proved its own
// frozen-script criterion: as the SUBSTANCE those suites carry, restated directly against
// `runner/lock.js`, `runner/preflight.js`, `runner/run.js`, `scripts/prepare-batch.js`,
// `scripts/author-tests.js` and `scripts/prove-tests.js`, plus the static fact that each named
// suite file is still present. "The configured regression command is green" stays a
// pipeline-level gate; no acceptance suite in this project can honestly claim it.
//
// SELF-CONTAINED ON PURPOSE, and it starts no container engine and reaches no network. It
// resolves the repository the way every suite here does — the tree it sits in, never the cwd.
//
// EVERY LOCK IT TAKES IS RE-AIMED. `PIPELINE_GLOBAL_LOCK_DIR` moves the host-global
// canonical-target authority into a disposable temp directory, so running this file can never
// disturb a live run on the same machine, and `PREPARATION_RUNS_DIR` does the same for
// preparation state.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..', '..');
const LOCK = path.join(REPO, 'runner', 'lock.js');
const PREFLIGHT = path.join(REPO, 'runner', 'preflight.js');
const RUN = path.join(REPO, 'runner', 'run.js');
const PREPARE_BATCH = path.join(REPO, 'scripts', 'prepare-batch.js');
const AUTHOR_TESTS = path.join(REPO, 'scripts', 'author-tests.js');
const PROVE_TESTS = path.join(REPO, 'scripts', 'prove-tests.js');

let failed = 0;
function check(name, cond, detail) {
  console.log(`${cond ? 'ok' : 'FAIL'} - ${name}${!cond && detail ? ` — ${detail}` : ''}`);
  if (!cond) failed = 1;
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-rj7-'));
const savedEnv = {
  lock: process.env.PIPELINE_GLOBAL_LOCK_DIR,
  prep: process.env.PREPARATION_RUNS_DIR,
  bd: process.env.PIPELINE_BD_CMD,
  child: process.env.PIPELINE_CHILD_AUTHORITY,
};

const hex = (n) => 'abcdef0123456789'.repeat(8).slice(0, n);
const NONCE_A = `${hex(30)}aa`;
const NONCE_B = `${hex(30)}bb`;

// `scripts/prepare-batch.js` exports an ASYNC `main`, so the body runs inside one async
// function rather than at module top level: top-level `await` is not available to a CommonJS
// file, and `sh tools/run-acceptance.sh` runs these with plain `node <file>`.
async function body() {
  // ---- C6, the surface every standalone path is reached through ---------------------------
  // Asserted before it is used, so a missing export is one named failure instead of a thrown
  // stack that says nothing about which entry point moved.
  let lock = null; let preflightMod = null; let runMod = null;
  let prepare = null; let author = null; let prove = null;
  try { lock = require(LOCK); } catch { lock = null; }
  try { preflightMod = require(PREFLIGHT); } catch { preflightMod = null; }
  try { runMod = require(RUN); } catch { runMod = null; }
  try { prepare = require(PREPARE_BATCH); } catch { prepare = null; }
  try { author = require(AUTHOR_TESTS); } catch { author = null; }
  try { prove = require(PROVE_TESTS); } catch { prove = null; }

  const has = (mod, ...names) => !!mod && names.every((n) => typeof mod[n] === 'function');
  check('C6 [guard] runner/lock.js still exports the whole ownership surface',
    has(lock, 'acquire', 'release', 'recordClaim', 'completeClaim', 'canonicalTarget',
      'isHolderLive', 'globalLockPath', 'markPreparationUncertain', 'clearPreparationUncertain',
      'listPreparationUncertain'));
  check('C6 [guard] runner/preflight.js still exports preflight', has(preflightMod, 'preflight'));
  check('C6 [guard] runner/run.js still exports cleanupOwnedLifecycle — the lock-release boundary',
    has(runMod, 'cleanupOwnedLifecycle'));
  check('C6 [guard] scripts/prepare-batch.js still exports main and parseArgs',
    has(prepare, 'main', 'parseArgs'));
  check('C6 [guard] scripts/author-tests.js still exports main and parseArgs',
    has(author, 'main', 'parseArgs'));
  check('C6 [guard] scripts/prove-tests.js still exports main and parseArgs',
    has(prove, 'main', 'parseArgs'));
  if (!lock || !preflightMod || !runMod || !prepare || !author || !prove) {
    console.log('FAIL - HARNESS: an entry point could not be loaded; the rest of C6 cannot run');
    process.exit(1);
  }

  // Both authorities re-aimed at the scratch tree from here on.
  const lockRoot = path.join(tmp, 'lockauth');
  process.env.PIPELINE_GLOBAL_LOCK_DIR = lockRoot;
  process.env.PREPARATION_RUNS_DIR = path.join(tmp, 'preparations');
  // A `bd` that cannot exist, so no guard check can ever wait on a real Beads database.
  process.env.PIPELINE_BD_CMD = path.join(tmp, 'no-such-bd-binary');
  delete process.env.PIPELINE_CHILD_AUTHORITY;
  check('C6 [guard] the host-global lock authority follows PIPELINE_GLOBAL_LOCK_DIR',
    path.resolve(lock.globalLockRoot()) === path.resolve(lockRoot));

  const mirror = path.join(tmp, 'pipeline-checkout');
  const mirrorTwo = path.join(tmp, 'pipeline-checkout-two');
  fs.mkdirSync(mirror, { recursive: true });
  fs.mkdirSync(mirrorTwo, { recursive: true });
  const project = (name) => {
    const dir = path.join(tmp, name);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };

  // ---- C6, the runner/run.js lock suite's substance: identity and exclusion ---------------
  const alpha = project('rj7-target-alpha');
  const beta = project('rj7-target-beta');

  const first = lock.acquire(mirror, alpha, 'GUARD-RUN-ONE');
  check('C6 [guard] a free project is still locked by the first standalone run',
    !!first && first.ok === true && first.tookOver === false);
  const second = lock.acquire(mirror, alpha, 'GUARD-RUN-TWO');
  check('C6 [guard] a second standalone run against one project is still refused BY OWNER NAME',
    !!second && second.ok === false && !!second.holder
    && second.holder.runId === 'GUARD-RUN-ONE' && second.holder.pid === process.pid,
    JSON.stringify(second));
  // Identity, not spelling — the property that makes the lock protect a repo rather than a
  // string, and the one a supervisor lease has to inherit rather than replace.
  check('C6 [guard] a trailing separator is still the same project',
    lock.acquire(mirror, `${alpha}${path.sep}`, 'GUARD-RUN-X').ok === false);
  check('C6 [guard] a `..` round trip is still the same project',
    lock.acquire(mirror, path.join(alpha, '..', path.basename(alpha)), 'GUARD-RUN-X').ok === false);
  check('C6 [guard] a forward-slash spelling is still the same project',
    lock.acquire(mirror, alpha.split(path.sep).join('/'), 'GUARD-RUN-X').ok === false);
  // A SECOND pipeline checkout is the case the host-global authority exists for: the exclusion
  // must not depend on which folder launched the runner.
  check('C6 [guard] a run launched from a DIFFERENT pipeline checkout is still refused',
    lock.acquire(mirrorTwo, alpha, 'GUARD-RUN-OTHER-CHECKOUT').ok === false);
  check('C6 [guard] two different projects are still independently lockable',
    lock.acquire(mirror, beta, 'GUARD-RUN-BETA').ok === true);
  lock.release(mirror, beta);
  const reacquired = lock.acquire(mirror, beta, 'GUARD-RUN-BETA-2');
  check('C6 [guard] a released project is still re-acquirable without a takeover',
    !!reacquired && reacquired.ok === true && reacquired.tookOver === false);
  lock.release(mirror, beta, reacquired.ownership);
  check('C6 [guard] releasing a never-locked project still does not throw', (() => {
    try { lock.release(mirror, project('rj7-never-locked')); return true; } catch { return false; }
  })());

  // Cross-process exclusion. A lock only one process can see would satisfy every check above
  // while protecting nothing, since the operations this authority separates are separate
  // `node` processes.
  const rivalEnv = { ...process.env };
  delete rivalEnv.NODE_OPTIONS;
  const rival = spawnSync(process.execPath, ['-e', [
    `const l = require(${JSON.stringify(LOCK.split(path.sep).join('/'))});`,
    `process.stdout.write(JSON.stringify(l.acquire(${JSON.stringify(mirrorTwo.split(path.sep).join('/'))},`,
    `  ${JSON.stringify(alpha.split(path.sep).join('/'))}, 'GUARD-RIVAL-PROCESS')));`,
  ].join('\n')], { encoding: 'utf8', timeout: 120000, env: rivalEnv, windowsHide: true });
  let rivalAnswer = null;
  try { rivalAnswer = JSON.parse(rival.stdout || 'null'); } catch { rivalAnswer = null; }
  check('C6 [guard] harness: the rival process ran and answered', rivalAnswer !== null,
    `exit ${rival.status}: ${String(rival.stderr || '').trim().split('\n').slice(-2).join(' ')}`);
  check('C6 [guard] a SEPARATE process is still refused the lock this process holds, by owner name',
    !!rivalAnswer && rivalAnswer.ok === false && !!rivalAnswer.holder
    && rivalAnswer.holder.runId === 'GUARD-RUN-ONE');

  // A holder that is provably gone is still taken over, and the takeover still says whose lock
  // it seized. This is the liveness half of the record, and C5's "a live parent is never taken
  // over" is only meaningful while a DEAD one still is.
  const orphan = project('rj7-target-orphan');
  const planted = spawnSync(process.execPath, ['-e', [
    `const l = require(${JSON.stringify(LOCK.split(path.sep).join('/'))});`,
    `const r = l.acquire(${JSON.stringify(mirror.split(path.sep).join('/'))},`,
    `  ${JSON.stringify(orphan.split(path.sep).join('/'))}, 'GUARD-RUN-THAT-DIED');`,
    'process.stdout.write(JSON.stringify({ ok: r.ok, pid: process.pid }));',
  ].join('\n')], { encoding: 'utf8', timeout: 120000, env: rivalEnv, windowsHide: true });
  let plantedAnswer = null;
  try { plantedAnswer = JSON.parse(planted.stdout || 'null'); } catch { plantedAnswer = null; }
  check('C6 [guard] harness: a lock was planted by a process that then exited',
    !!plantedAnswer && plantedAnswer.ok === true,
    `exit ${planted.status}: ${String(planted.stderr || '').trim().split('\n').slice(-2).join(' ')}`);
  const seized = lock.acquire(mirror, orphan, 'GUARD-RUN-AFTER-DEATH');
  check('C6 [guard] a dead holder\'s lock is still taken over',
    !!seized && seized.ok === true && seized.tookOver === true);
  check('C6 [guard] the takeover still NAMES the run whose lock it seized',
    !!seized && !!seized.previous && seized.previous.runId === 'GUARD-RUN-THAT-DIED');
  lock.release(mirror, orphan, seized.ownership);

  // ---- C6, the preparation-uncertainty substance ------------------------------------------
  // The marker that outlives its coordinator. C5 says a reclaim may not delete an uncertain
  // marker; that only means something while the marker still blocks an ordinary acquire and
  // still needs the exact nonce to clear.
  const uncertain = project('rj7-target-uncertain');
  const owner = lock.acquire(mirror, uncertain, 'GUARD-PREPARE-PARENT');
  check('C6 [guard] harness: a preparation coordinator holds the uncertain project',
    !!owner && owner.ok === true);
  lock.markPreparationUncertain(owner.ownership, {
    nonce: NONCE_A, batch: 'guardbatch', issueId: 'rj7-demo', phase: 'author-proof', pid: process.pid,
  });
  lock.markPreparationUncertain(owner.ownership, {
    nonce: NONCE_B, batch: 'guardbatch', issueId: 'rj7-demo-two', phase: 'proof', pid: process.pid,
  });
  lock.release(mirror, uncertain, owner.ownership);
  const blocked = lock.acquire(mirror, uncertain, 'GUARD-NORMAL-RUNNER');
  check('C6 [guard] an uncertain preparation marker still refuses an ordinary acquire',
    !!blocked && blocked.ok === false && !!blocked.holder
    && blocked.holder.preparationUncertain === true,
    JSON.stringify(blocked));
  check('C6 [guard] that refusal still names the issue and batch the uncertainty belongs to',
    !!blocked && !!blocked.holder && blocked.holder.issueId === 'rj7-demo'
    && blocked.holder.batch === 'guardbatch' && blocked.holder.nonce === NONCE_A);
  const recovery = lock.acquire(mirror, uncertain, 'GUARD-EXPLICIT-ACK',
    { allowPreparationRecovery: true });
  check('C6 [guard] explicit preparation recovery is still the only way in',
    !!recovery && recovery.ok === true);
  lock.clearPreparationUncertain(recovery.ownership, NONCE_A);
  check('C6 [guard] clearing one nonce still leaves the other marker standing',
    lock.listPreparationUncertain(uncertain).map((m) => m.nonce).join(',') === NONCE_B);
  check('C6 [guard] a tampered marker is still refused rather than believed', (() => {
    const dir = lock.preparationUncertainDir(uncertain);
    const file = path.join(dir, `${NONCE_B}.json`);
    const original = fs.readFileSync(file, 'utf8');
    const record = JSON.parse(original);
    record.issueId = 'rj7-somebody-elses-issue';
    fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
    let threw = false;
    try { lock.listPreparationUncertain(uncertain); } catch { threw = true; }
    fs.writeFileSync(file, original);
    return threw;
  })());
  lock.clearPreparationUncertain(recovery.ownership, NONCE_B);
  lock.release(mirror, uncertain, recovery.ownership);

  // ---- C6, runner/preflight.js: the lock is FIRST, and it is released on every abort ------
  const gate = project('rj7-target-gate');
  const cfgFor = (target) => ({
    targetRepoPath: target,
    targetRepoRemote: 'https://example.invalid/guard/target.git',
    image: 'pipeline-guard:latest',
    network: 'rj7guard-net',
    proxyName: 'rj7guard-proxy',
    proxyPort: 18443,
    proxyUrl: 'http://rj7guard-proxy:18443',
    lifecycleTimeoutMs: 5000,
    bdTimeoutMs: 3000,
    gitTimeoutMs: 3000,
    hostShell: null,
  });
  const logFor = (runId) => ({ runId, info() {}, error() {} });
  function spyDeps(overrides = {}) {
    const calls = [];
    const record = (name, answer) => (...args) => { calls.push(name); return answer(...args); };
    return {
      calls,
      deps: {
        verifyRepoIdentity: record('verifyRepoIdentity',
          () => ({ ok: true, remoteName: 'origin', identity: 'guard/target' })),
        resolveHostShell: record('resolveHostShell', () => ({ ok: true, command: 'sh', kind: 'stub' })),
        dockerAvailable: record('dockerAvailable', () => ({ status: 0 })),
        imageExists: record('imageExists', () => ({ status: 0 })),
        networkUp: record('networkUp', () => ({ ok: true, output: '' })),
        networkDown: record('networkDown', () => ({ ok: true, output: '' })),
        egressCheck: record('egressCheck', () => ({ ok: true, output: '' })),
        recoverStaleIssues: record('recoverStaleIssues', () => ({ recovered: [] })),
        ...overrides,
      },
    };
  }

  const holder = lock.acquire(mirror, gate, 'GUARD-RUN-HOLDING-THE-GATE');
  check('C6 [guard] harness: a live run holds the gate project', !!holder && holder.ok === true);
  const refusedSpy = spyDeps();
  const refusedPre = preflightMod.preflight(cfgFor(gate), mirrorTwo,
    logFor('GUARD-RUN-SECOND'), refusedSpy.deps);
  check('C6 [guard] preflight still refuses a second run and reports `locked`',
    !!refusedPre && refusedPre.ok === false && refusedPre.locked === true, JSON.stringify(refusedPre));
  check('C6 [guard] that preflight refusal still NAMES the run that owns the project',
    !!refusedPre && /GUARD-RUN-HOLDING-THE-GATE/.test(String(refusedPre.reason || '')),
    String(refusedPre && refusedPre.reason));
  // The whole reason the lock is first: everything after it probes Docker or writes to Beads.
  check('C6 [guard] the lock is still the FIRST gate — no identity, shell, Docker, network or Beads call happened',
    refusedSpy.calls.length === 0, `called: ${refusedSpy.calls.join(', ')}`);
  lock.release(mirror, gate, holder.ownership);

  const abortSpy = spyDeps({
    verifyRepoIdentity: () => ({ ok: false, reason: 'guard: identity deliberately refused' }),
  });
  const aborted = preflightMod.preflight(cfgFor(gate), mirror, logFor('GUARD-RUN-ABORT'), abortSpy.deps);
  check('C6 [guard] a preflight gate after the lock still aborts the run',
    !!aborted && aborted.ok === false && aborted.identityMismatch === true);
  const afterAbort = lock.acquire(mirror, gate, 'GUARD-RUN-AFTER-ABORT');
  check('C6 [guard] an aborted preflight still leaves the project FREE, not taken over',
    !!afterAbort && afterAbort.ok === true && afterAbort.tookOver === false, JSON.stringify(afterAbort));
  lock.release(mirror, gate, afterAbort.ownership);

  const passSpy = spyDeps();
  const passed = preflightMod.preflight(cfgFor(gate), mirror, logFor('GUARD-RUN-PASS'), passSpy.deps);
  check('C6 [guard] a standalone run with no supervisor present still passes preflight and owns the lock',
    !!passed && passed.ok === true && passed.lockOwned === true && !!passed.ownership);
  check('C6 [guard] the ordinary gate order after the lock is unchanged',
    passSpy.calls.join(',') === 'verifyRepoIdentity,resolveHostShell,dockerAvailable,imageExists,'
      + 'networkUp,egressCheck,recoverStaleIssues', passSpy.calls.join(','));

  // The ownership boundary: a thrown teardown must never strand the project lock.
  let unlocked = 0;
  const cleaned = runMod.cleanupOwnedLifecycle(cfgFor(gate), mirror, logFor('GUARD-RUN-PASS'), 't', {
    networkDown: () => { throw new Error('guard: teardown deliberately threw'); },
    releaseLock: (root, target, ownership) => { unlocked += 1; lock.release(root, target, ownership); },
    ownership: passed && passed.ownership,
  });
  check('C6 [guard] a thrown network teardown is still reported rather than swallowed',
    !!cleaned && cleaned.ok === false && /teardown threw/.test(String(cleaned.error || '')));
  check('C6 [guard] ... and the project lock is still released anyway', unlocked === 1);
  const afterCleanup = lock.acquire(mirror, gate, 'GUARD-RUN-AFTER-CLEANUP');
  check('C6 [guard] the project is free after the ownership boundary ran',
    !!afterCleanup && afterCleanup.ok === true && afterCleanup.tookOver === false);
  lock.release(mirror, gate, afterCleanup.ownership);

  // ---- C6, observable CLI behaviour of the three standalone coordinators -------------------
  const cli = project('rj7-target-cli');
  const configPath = path.join(tmp, 'run.config.rj7guard.json');
  fs.writeFileSync(configPath, `${JSON.stringify({
    targetRepoPath: cli.split(path.sep).join('/'),
    targetRepoRemote: 'https://example.invalid/guard/target.git',
    image: 'pipeline-guard:latest',
    bdTimeoutMs: 3000,
    gitTimeoutMs: 3000,
    lifecycleTimeoutMs: 5000,
  }, null, 2)}\n`);

  const say = () => {
    const lines = [];
    return { lines, fn: (...a) => lines.push(a.join(' ')) };
  };

  // prepare-batch: the argument grammar an operator types, and the exit codes a script reads.
  check('C6 [guard] prepare-batch still rejects an unknown mode as a usage error',
    prepare.parseArgs(['launch', 'guardbatch']).error !== undefined);
  check('C6 [guard] prepare-batch `start` still requires --config and at least one --issue',
    prepare.parseArgs(['start', 'guardbatch']).error !== undefined
    && prepare.parseArgs(['start', 'guardbatch', '--config', configPath]).error !== undefined);
  check('C6 [guard] prepare-batch still rejects a duplicate --issue',
    prepare.parseArgs(['start', 'guardbatch', '--config', configPath,
      '--issue', 'rj7-demo', '--issue', 'rj7-demo']).error !== undefined);
  check('C6 [guard] prepare-batch still rejects --json outside `status`',
    prepare.parseArgs(['resume', 'guardbatch', '--json']).error !== undefined);
  check('C6 [guard] prepare-batch still rejects an out-of-range --author-concurrency',
    prepare.parseArgs(['start', 'guardbatch', '--config', configPath,
      '--issue', 'rj7-demo', '--author-concurrency', '11']).error !== undefined);
  const wellFormed = prepare.parseArgs(['start', 'guardbatch', '--config', configPath,
    '--issue', 'rj7-demo', '--issue', 'rj7-demo-two', '--author-concurrency', '3']);
  check('C6 [guard] prepare-batch still accepts the documented `start` grammar unchanged',
    !wellFormed.error && wellFormed.mode === 'start' && wellFormed.batch === 'guardbatch'
    && wellFormed.issues.join(',') === 'rj7-demo,rj7-demo-two' && wellFormed.concurrency === 3,
    JSON.stringify(wellFormed));
  check('C6 [guard] prepare-batch still exports the three exit codes a caller branches on',
    prepare.EXIT_USAGE === 2 && prepare.EXIT_REFUSED === 3 && prepare.EXIT_ATTENTION === 4);

  // Ownership refusal, by owner name, from each coordinator's real CLI entry point. This is the
  // behaviour C1 extends to a supervisor lease, and C6 pins it for the no-supervisor case.
  const cliHolder = lock.acquire(mirror, cli, 'GUARD-RUN-OWNS-THE-CLI-TARGET');
  check('C6 [guard] harness: a live run owns the CLI target', !!cliHolder && cliHolder.ok === true);

  const prepIo = say();
  const prepCode = await prepare.main(['start', 'guardbatch', '--config', configPath,
    '--issue', 'rj7-demo'], { out: () => {}, err: prepIo.fn });
  check(`C6 [guard] prepare-batch still refuses an owned target with exit ${prepare.EXIT_REFUSED} — got ${prepCode}`,
    prepCode === prepare.EXIT_REFUSED);
  check('C6 [guard] ... and its refusal still names the owner and says no worker was launched',
    /GUARD-RUN-OWNS-THE-CLI-TARGET/.test(prepIo.lines.join('\n'))
    && /no worker was launched/i.test(prepIo.lines.join('\n')), prepIo.lines.join(' | '));

  const authIo = say();
  const authCode = author.main(['rj7-demo', '--config', configPath],
    { out: () => {}, err: authIo.fn });
  check(`C6 [guard] author-tests still refuses an owned target with exit 3 — got ${authCode}`,
    authCode === 3);
  check('C6 [guard] ... and its refusal still names the owner and says nothing was started',
    /GUARD-RUN-OWNS-THE-CLI-TARGET/.test(authIo.lines.join('\n'))
    && /no worktree or author was started/i.test(authIo.lines.join('\n')), authIo.lines.join(' | '));

  const proveIo = say();
  const proveCode = prove.main(['rj7-demo', '--config', configPath], () => {}, proveIo.fn);
  check(`C6 [guard] prove-tests still refuses an owned target with exit 3 — got ${proveCode}`,
    proveCode === 3);
  check('C6 [guard] ... and its refusal still names the owner and says no probe was created',
    /GUARD-RUN-OWNS-THE-CLI-TARGET/.test(proveIo.lines.join('\n'))
    && /no probe was created/i.test(proveIo.lines.join('\n')), proveIo.lines.join(' | '));
  lock.release(mirror, cli, cliHolder.ownership);

  // Usage surfaces, which an operator reads and a supervisor must not rewrite.
  const helpAuthor = say();
  check('C6 [guard] author-tests --help still exits 0 and prints its own usage',
    author.main(['--help'], { out: helpAuthor.fn, err: () => {} }) === 0
    && /author-tests\.js <issue-id> --config/.test(helpAuthor.lines.join('\n')));
  const badAuthor = say();
  check(`C6 [guard] a bare author-tests invocation still exits ${author.EXIT_USAGE}`,
    author.main([], { out: () => {}, err: badAuthor.fn }) === author.EXIT_USAGE);
  const helpProve = say();
  check('C6 [guard] prove-tests --help still exits 0 and prints its own usage',
    prove.main(['--help'], helpProve.fn, () => {}) === 0
    && /prove-tests\.js <issue-id> --config/.test(helpProve.lines.join('\n')));
  const badProve = say();
  check('C6 [guard] a bare prove-tests invocation still exits 2',
    prove.main([], () => {}, badProve.fn) === 2);

  // ---- C6, the named suites are still present ---------------------------------------------
  // Recorded, never run: see the SPEC DEFECT note at the top of this file. Their presence is
  // what makes "the existing suites remain green" a question about anything at all.
  for (const rel of ['scripts/test-lock.sh', 'scripts/test-prepare-batch.sh',
    'scripts/test-author-tests.sh', 'scripts/test-prove-tests.sh',
    'scripts/test-ownership.sh', 'scripts/test-concurrency.sh', 'tests/unit/lock.test.js']) {
    check(`C6 [guard] the existing suite \`${rel}\` is still present`,
      fs.existsSync(path.join(REPO, ...rel.split('/'))));
  }
}

body()
  .catch((e) => {
    failed = 1;
    console.log(`FAIL - HARNESS BROKEN: unexpected exception: ${e && e.stack ? e.stack : e}`);
  })
  .then(() => {
    for (const [key, name] of [['lock', 'PIPELINE_GLOBAL_LOCK_DIR'], ['prep', 'PREPARATION_RUNS_DIR'],
      ['bd', 'PIPELINE_BD_CMD'], ['child', 'PIPELINE_CHILD_AUTHORITY']]) {
      if (savedEnv[key] === undefined) delete process.env[name];
      else process.env[name] = savedEnv[key];
    }
    rmrf(tmp);
    process.exit(failed);
  });
