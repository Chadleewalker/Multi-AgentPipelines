// Frozen acceptance test — repo-hw6, the [guard] half: a fail-fast prerequisite gate must be
// added WITHOUT spending the healthy preparation the pipeline already has.
//
// [guard] Every check in this file is GREEN at the fork point and must stay green. It is the
// whole of criterion C5 — "a healthy preparation retains current parallel author concurrency,
// proof semantics, and freeze-marker behavior" — plus ONE check for C3, whose converse is also
// a statement about behaviour that must survive. Every red check for C1-C4 lives in `test.js`.
//
// Nothing red belongs in this file. A [guard] file that is red at the fork point is a stale pin
// and refuses the freeze outright (`scripts/freeze-gate.js`, verdict `stale-guard`).
//
// WHICH CRITERION EACH CHECK PROVES:
//   C5.1  the preparation surface C5 is a statement about still exists
//   C5.2  parallel author concurrency: the 1..10 contract and its per-mode immutability
//   C5.3  parallel author concurrency: the pool really runs `concurrency` lanes at once
//   C5.4  parallel author concurrency: a healthy `start` still fans out at the configured width
//   C5.5  proof semantics: the six proof stages and their progress grammar
//   C5.6  freeze-marker behavior: what `markProven` writes and what it preserves
//   C5.7  proof semantics at the coordinator: a healthy `start` still classifies every issue
//   C3.6  C3's converse: `acknowledge-interrupted` — the "uncertain-preparation override" C3
//         names — stays reachable while a prerequisite is unavailable. A recovery verb that
//         needed a healthy Docker daemon to settle a record a broken one left would be an
//         override no operator could reach, and C3 would be unsatisfiable in the one case it
//         is about. This is existing behaviour, green today, so it is a guard and not a red
//         check; `test.js` SPEC DEFECT 3 records the reasoning in full.
//
// WRITTEN TO SURVIVE THE IMPLEMENTATION, which is the one thing a guard must do that an
// ordinary check need not. The healthy-path checks below supply a satisfied answer for EVERY
// prerequisite this task is about — the whole-gate seam, the four individual probes, and an
// ambient model token — so they are green before the gate exists (unknown seams are ignored)
// and green after it does. A guard that only passes on one side of the change is not a guard.
//
// SPEC DEFECT, REPORTED NOT PAPERED OVER. C5 says "retains CURRENT ... proof semantics", and
// the fullest statement of the current semantics lives in `scripts/test-prepare-batch.sh`,
// `scripts/test-prove-tests.sh` and `tests/unit/`, every one of them frozen by
// `pipeline.config.json` `frozenPaths`. A frozen acceptance suite may never edit those files,
// and shelling into one asserts through a file it cannot adjust; the freeze gate also runs this
// guard subset ALONE in a flat scratch directory, where no sibling helper is reachable. So C5
// is proven the way `repo-rj7` proved its own frozen-script criterion: as the SUBSTANCE those
// suites carry, restated directly against `scripts/prepare-batch.js` and
// `scripts/prove-tests.js`. "The configured regression command is green" stays a pipeline-level
// gate; no acceptance suite in this project can honestly claim it.
//
// SELF-CONTAINED ON PURPOSE, and it starts no container engine and reaches no network. It
// resolves the repository the way every suite here does — the tree it sits in, never the cwd.
// `PIPELINE_GLOBAL_LOCK_DIR` and `PREPARATION_RUNS_DIR` are re-aimed at a disposable temp tree
// so running this file can never disturb a live run on the same machine.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..', '..');
const PREPARE_BATCH = path.join(REPO, 'scripts', 'prepare-batch.js');
const PROVE_TESTS = path.join(REPO, 'scripts', 'prove-tests.js');

let failed = 0;
function check(name, cond, detail) {
  console.log(`${cond ? 'ok' : 'FAIL'} - ${name}${!cond && detail ? ` — ${detail}` : ''}`);
  if (!cond) failed = 1;
}
async function section(label, fn) {
  try { await fn(); }
  catch (e) { check(`${label} ran to completion`, false, `threw ${(e && e.message) || e}`); }
}
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
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-hw6-'));
const savedEnv = {
  PIPELINE_GLOBAL_LOCK_DIR: process.env.PIPELINE_GLOBAL_LOCK_DIR,
  PREPARATION_RUNS_DIR: process.env.PREPARATION_RUNS_DIR,
  PIPELINE_CHILD_AUTHORITY: process.env.PIPELINE_CHILD_AUTHORITY,
  CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
};
process.env.PIPELINE_GLOBAL_LOCK_DIR = path.join(tmp, 'lockauth');
process.env.PREPARATION_RUNS_DIR = path.join(tmp, 'preparations');
delete process.env.PIPELINE_CHILD_AUTHORITY;
// Present so a healthy preparation stays healthy once model authentication is a prerequisite,
// whichever channel the gate reads it through. It is a fixture value and authenticates nothing.
process.env.CLAUDE_CODE_OAUTH_TOKEN = 'hw6-guard-fixture-token';

const prepare = require(PREPARE_BATCH);
const prove = require(PROVE_TESTS);

const HEAD = 'f'.repeat(40);
const PROOF_STAGE_NAMES = [
  'prepare', 'probe-agent', 'protected-check-before', 'gate', 'protected-check-after',
  'marker-write',
];

// ---- the healthy-preparation fixture --------------------------------------------------------
// `scripts/prepare-batch.js` reads Beads serially, snapshots immutable briefs and then runs a
// bounded pool of workers. Everything outside the pool is stubbed; the pool itself is the thing
// under observation, so it is real.

function runCfg(target) {
  return {
    targetRepoPath: fwd(target),
    targetRepoRemote: 'https://example.invalid/hw6/target.git',
    image: 'pipeline-hw6:latest',
    hostShell: null,
    network: 'hw6-net',
    proxyName: 'hw6-proxy',
    proxyPort: 18447,
    proxyUrl: 'http://hw6-proxy:18447',
    lifecycleTimeoutMs: 5000,
    bdTimeoutMs: 3000,
    gitTimeoutMs: 3000,
    testProbeAttempts: 1,
    allowHalfProven: false,
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

// Every prerequisite this task introduces, answered as satisfied — both as one whole-gate seam
// and as the four individual probes, because a guard must not care which of the two the
// implementation ends up consulting.
function satisfiedPrerequisites() {
  return {
    checkPrerequisites: () => ({
      ok: true,
      checked: ['docker-daemon', 'required-image', 'host-shell', 'model-auth'],
    }),
    dockerAvailable: () => ({ status: 0, stdout: 'ok', stderr: '' }),
    imageExists: () => ({ status: 0, stdout: '[]', stderr: '' }),
    resolveHostShell: () => ({ ok: true, command: 'sh', kind: 'stub' }),
    loadToken: () => 'hw6-guard-fixture-token',
  };
}

function healthyStart(ids, concurrency) {
  const events = [];
  const out = []; const err = [];
  const flight = { now: 0, peak: 0, ran: [] };
  const target = fs.mkdtempSync(path.join(tmp, 'target-'));
  const cfg = runCfg(target);
  const dirs = new Map(ids.map((id) => [id, fs.mkdtempSync(path.join(tmp, `worktree-${id}-`))]));
  const state = {
    preparationRoot: () => path.join(tmp, 'no-such-preparation-root'),
    validateBatchId: () => true,
    validateIssueId: () => true,
    canonicalHash: () => 'H',
    redactConfig: (v) => v,
    createManifest: (_r, b, input) => ({ batchId: b, ...input }),
    appendEvent: (_r, _b, type, payload) => { events.push({ type, payload }); return {}; },
    readEvents: () => [],
    readWorkerRecords: () => [],
    createWorkerNonce: () => 'a'.repeat(32),
    writeWorkerStarted: () => {},
    writeWorkerResult: () => {},
    deriveState: () => ({ ok: true, issues: [] }),
  };
  const seams = {
    state,
    preparationRoot: () => path.join(tmp, 'no-such-preparation-root'),
    admitEntry: () => ({ ok: true, mode: 'standalone' }),
    loadConfig: () => cfg,
    acquire: () => ({ ok: true, tookOver: false, ownership: { target: cfg.targetRepoPath } }),
    release: () => {},
    runSync: () => ({ status: 0, stdout: HEAD, stderr: '' }),
    inspectIntegration: () => ({ ok: true, branch: 'main', head: HEAD }),
    readyQueue: () => ({ ok: true, issues: [] }),
    bdJson: () => ({ ok: false, error: 'a frozen test never reaches Beads' }),
    buildBrief: ({ id }) => briefFor(id, cfg, dirs.get(id)),
    ensureWorktree: () => ({ ok: true }),
    markPreparationUncertain: () => {},
    clearPreparationUncertain: () => {},
    listPreparationUncertain: () => [],
    onWorkerProgress: () => {},
    runWorker: (_r, _b, item) => new Promise((resolve) => {
      flight.now += 1;
      flight.peak = Math.max(flight.peak, flight.now);
      flight.ran.push(item.id);
      setImmediate(() => {
        flight.now -= 1;
        resolve({ id: item.id, ok: true, outcome: 'proven-at-base', attempt: 1 });
      });
    }),
    ...satisfiedPrerequisites(),
  };
  return {
    events, out, err, flight, cfg,
    io: { out: (s) => out.push(String(s)), err: (s) => err.push(String(s)) },
    seams,
    opts: { mode: 'start', batch: 'hw6-guard-wave', config: 'run.config.json', issues: ids, concurrency },
  };
}

// ---- the run --------------------------------------------------------------------------------

async function main() {
  // ---- C5.1 the surface C5 is a statement about ---------------------------------------------
  // Asserted before it is used, so a moved export is one named failure instead of a thrown
  // stack that says nothing about which entry point changed.
  const isFn = (mod, ...names) => !!mod && names.every((n) => typeof mod[n] === 'function');
  check('C5.1 [guard] scripts/prepare-batch.js still exports the whole preparation surface',
    isFn(prepare, 'main', 'execute', 'parseArgs', 'runPool', 'runWorker')
      && prepare.EXIT_USAGE === 2 && prepare.EXIT_REFUSED === 3 && prepare.EXIT_ATTENTION === 4);
  check('C5.1 [guard] scripts/prove-tests.js still exports the proof and freeze-marker surface',
    isFn(prove, 'markProven', 'validStageEvent', 'proofStageLine', 'proveTests')
      && typeof prove.MARKER === 'string' && prove.PROOF_STAGES instanceof Set);

  // ---- C5.2 the parallel author concurrency contract ----------------------------------------
  await section('C5.2', () => {
    check('C5.2 [guard] preparation still defaults to ten parallel authors with a hard ceiling of ten',
      prepare.DEFAULT_CONCURRENCY === 10 && prepare.MAX_CONCURRENCY === 10,
      `default ${prepare.DEFAULT_CONCURRENCY}, max ${prepare.MAX_CONCURRENCY}`);
    const startArgs = (value) => ['start', 'wave', '--config', 'run.config.json', '--issue', 'a-1',
      ...(value === undefined ? [] : ['--author-concurrency', value])];
    check('C5.2 [guard] --author-concurrency still accepts the whole 1..10 range and defaults to ten',
      prepare.parseArgs(startArgs()).concurrency === 10
        && prepare.parseArgs(startArgs('1')).concurrency === 1
        && prepare.parseArgs(startArgs('10')).concurrency === 10
        && !prepare.parseArgs(startArgs('1')).error
        && !prepare.parseArgs(startArgs('10')).error);
    check('C5.2 [guard] --author-concurrency still refuses zero, eleven and a non-number by name',
      /1 to 10/.test(prepare.parseArgs(startArgs('0')).error || '')
        && /1 to 10/.test(prepare.parseArgs(startArgs('11')).error || '')
        && /1 to 10/.test(prepare.parseArgs(startArgs('two')).error || ''));
    check('C5.2 [guard] resume and retry still take their width from the immutable manifest, never the command line',
      /fixed by the manifest/.test(prepare.parseArgs(['resume', 'wave', '--author-concurrency', '2']).error || '')
        && /fixed by the manifest/.test(prepare.parseArgs(['retry', 'wave', 'a-1', '--author-concurrency', '2']).error || ''));
  });

  // ---- C5.3 the pool itself -----------------------------------------------------------------
  await section('C5.3', async () => {
    const flight = { now: 0, peak: 0 };
    const items = Array.from({ length: 7 }, (_, i) => ({ id: `a-${i}` }));
    const results = await prepare.runPool(items, 3, (item) => new Promise((resolve) => {
      flight.now += 1;
      flight.peak = Math.max(flight.peak, flight.now);
      setImmediate(() => { flight.now -= 1; resolve(item.id); });
    }));
    check('C5.3 [guard] runPool still runs exactly `concurrency` lanes at once and completes every item in order',
      flight.peak === 3 && results.length === 7 && same(results, items.map((i) => i.id)),
      `peak ${flight.peak}, results ${JSON.stringify(results)}`);
    const narrow = { now: 0, peak: 0 };
    await prepare.runPool([{ id: 'x' }, { id: 'y' }], 9, () => new Promise((resolve) => {
      narrow.now += 1;
      narrow.peak = Math.max(narrow.peak, narrow.now);
      setImmediate(() => { narrow.now -= 1; resolve(null); });
    }));
    check('C5.3 [guard] runPool still opens no more lanes than there are items',
      narrow.peak === 2, `peak ${narrow.peak}`);
  });

  // ---- C5.4 and C5.7: one healthy start, observed ------------------------------------------
  await section('C5.4/C5.7', async () => {
    const ids = ['hw6-g-1', 'hw6-g-2', 'hw6-g-3', 'hw6-g-4'];
    const run = healthyStart(ids, 2);
    const code = await prepare.execute(run.opts, run.io, run.seams);
    check('C5.4 [guard] a healthy start still fans out at the configured author concurrency and runs every issue',
      code === 0 && run.flight.peak === 2 && run.flight.ran.length === 4
        && same(run.flight.ran.slice().sort(), ids.slice().sort()),
      `exit ${code}, peak ${run.flight.peak}, ran ${JSON.stringify(run.flight.ran)}`);
    check('C5.7 [guard] a healthy start still classifies every issue and reports its proof outcome',
      ids.every((id) => run.out.some((line) => line === `${id}: proven-at-base`))
        && ids.every((id) => run.events.some((e) => e.type === 'issue.snapshotted'
          && e.payload && e.payload.issueId === id && e.payload.action === 'author-proof')),
      `out = ${JSON.stringify(run.out)}, events = ${JSON.stringify(run.events.map((e) => e.type))}`);
  });

  // ---- C5.5 proof semantics -----------------------------------------------------------------
  await section('C5.5', () => {
    check('C5.5 [guard] the six proof stages are unchanged',
      prove.PROOF_STAGES.size === PROOF_STAGE_NAMES.length
        && PROOF_STAGE_NAMES.every((stage) => prove.PROOF_STAGES.has(stage)),
      `stages = ${JSON.stringify([...prove.PROOF_STAGES])}`);
    check('C5.5 [guard] a well-formed proof progress event is still accepted',
      prove.validStageEvent({ stage: 'gate', phase: 'start', attempt: 1 })
        && prove.validStageEvent({ stage: 'marker-write', phase: 'done', attempt: 2, elapsedMs: 0 }));
    check('C5.5 [guard] an unknown stage, an unknown phase and a zero attempt are still refused',
      !prove.validStageEvent({ stage: 'not-a-stage', phase: 'start', attempt: 1 })
        && !prove.validStageEvent({ stage: 'gate', phase: 'middle', attempt: 1 })
        && !prove.validStageEvent({ stage: 'gate', phase: 'start', attempt: 0 })
        && !prove.validStageEvent(null));
    check('C5.5 [guard] the proof progress line still names the attempt and the elapsed time',
      prove.proofStageLine({ stage: 'gate', phase: 'done', attempt: 2, elapsedMs: 5 })
          === 'proof attempt 2: gate finished in 5ms'
        && prove.proofStageLine({ stage: 'prepare', phase: 'start', attempt: 1 })
          === 'proof attempt 1: prepare started'
        && prove.proofStageLine({ stage: 'nope', phase: 'start' }) === null,
      JSON.stringify(prove.proofStageLine({ stage: 'gate', phase: 'done', attempt: 2, elapsedMs: 5 })));
  });

  // ---- C5.6 freeze-marker behaviour ---------------------------------------------------------
  await section('C5.6', () => {
    check('C5.6 [guard] the green-probe freeze marker still has its established name',
      prove.MARKER === '.pipeline-green-probe.json', prove.MARKER);
    const container = fs.mkdtempSync(path.join(tmp, 'probe-container-'));
    const markerPath = path.join(container, prove.MARKER);
    fs.writeFileSync(markerPath, `${JSON.stringify({
      kind: 'multi-agent-green-probe', version: 1, issue: 'hw6-g-1', model: 'stub',
      head: HEAD, createdAt: '2026-09-09T00:00:00.000Z',
    }, null, 2)}\n`);
    prove.markProven({ container }, 3, 'evidence-text');
    let marker = null;
    try { marker = JSON.parse(fs.readFileSync(markerPath, 'utf8')); } catch { marker = null; }
    const digest = crypto.createHash('sha256').update(Buffer.from('evidence-text')).digest('hex');
    check('C5.6 [guard] markProven still stamps status, attempt count, evidence hash and proof time into the marker',
      !!marker && marker.status === 'proven' && marker.attempts === 3
        && marker.evidenceHash === digest
        && typeof marker.provenAt === 'string' && Number.isFinite(Date.parse(marker.provenAt)),
      JSON.stringify(marker));
    check('C5.6 [guard] markProven still preserves the identity the marker already carried',
      !!marker && marker.kind === 'multi-agent-green-probe' && marker.version === 1
        && marker.issue === 'hw6-g-1' && marker.head === HEAD
        && marker.createdAt === '2026-09-09T00:00:00.000Z',
      JSON.stringify(marker));
  });

  // ---- C3.6 the recovery verb stays reachable ------------------------------------------------
  // The whole prerequisite set is answered UNAVAILABLE here, and `acknowledge-interrupted` must
  // still reach its own decision: it launches nothing, so gating it would make C3's own
  // "without an uncertain-preparation override" impossible to satisfy in the one situation the
  // criterion exists for. Green today because no gate exists yet; it must stay green once one
  // does, which is exactly what a guard is for.
  await section('C3.6', async () => {
    const probes = [];
    const target = fs.mkdtempSync(path.join(tmp, 'ack-target-'));
    const cfg = runCfg(target);
    const out = []; const err = [];
    const unavailable = {
      dockerAvailable: () => { probes.push('docker-daemon'); return { status: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon.' }; },
      imageExists: () => { probes.push('required-image'); return { status: 1, stdout: '', stderr: 'No such image' }; },
      resolveHostShell: () => { probes.push('host-shell'); return { ok: false, reason: 'no shell' }; },
      loadToken: () => { probes.push('model-auth'); return ''; },
      checkPrerequisites: () => {
        probes.push('whole-gate');
        return { ok: false, prerequisite: 'docker-daemon', reason: 'stubbed unavailable', remedy: 'start Docker Desktop', checked: ['docker-daemon'] };
      },
    };
    const state = {
      preparationRoot: () => path.join(tmp, 'no-such-preparation-root'),
      readManifest: () => ({
        batchId: 'hw6-guard-ack', runConfig: 'run.config.json', concurrency: 2,
        issues: [{ id: 'hw6-g-1' }], configHash: 'H', config: cfg,
        integrationBranch: 'main', integrationHead: HEAD,
      }),
      canonicalHash: () => 'H',
      redactConfig: (v) => v,
      readWorkerRecords: () => [],
      readEvents: () => [],
      appendEvent: () => ({}),
      writeWorkerResult: () => {},
    };
    const code = await prepare.execute(
      { mode: 'acknowledge-interrupted', batch: 'hw6-guard-ack', issues: ['hw6-g-1'], concurrency: 2 },
      { out: (s) => out.push(String(s)), err: (s) => err.push(String(s)) },
      {
        state,
        preparationRoot: () => path.join(tmp, 'no-such-preparation-root'),
        admitEntry: () => ({ ok: true, mode: 'standalone' }),
        loadConfig: () => cfg,
        acquire: () => ({ ok: true, tookOver: false, ownership: { target: cfg.targetRepoPath } }),
        release: () => {},
        listPreparationUncertain: () => [],
        clearPreparationUncertain: () => {},
        ...unavailable,
      });
    check('C3.6 [guard] acknowledge-interrupted stays reachable with every prerequisite unavailable, and consults none of them',
      code === prepare.EXIT_ATTENTION && probes.length === 0
        && /no interrupted worker/i.test(err.join('\n')),
      `exit ${code}, probes = ${JSON.stringify(probes)}, stderr = ${JSON.stringify(err.join('\n'))}`);
  });
}

main().then(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  rmrf(tmp);
  process.exit(failed);
}).catch((e) => {
  console.log(`FAIL - HARNESS: the guard threw before finishing — ${(e && e.stack) || e}`);
  rmrf(tmp);
  process.exit(1);
});
