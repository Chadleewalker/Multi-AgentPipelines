// Frozen acceptance guard — repo-djf.50. [guard]
// Criteria -> guards. Each check here pins behaviour that already exists and is already GREEN at
// the fork point; none of it depends on repo-djf.50's own unbuilt resumable-proof identity.
//
//   G1 / C3, C5(usage-limit regression)  the existing usage-limit `resume` selection already
//        threads the recorded probe into a relaunched worker as `retainedProbe`. C5 names
//        usage-limit explicitly as regression coverage, and C3's "passes it as retainedProbe to
//        the next proof worker" is the same wiring the new retry selection must reuse.
//   G2 / C3  a job that carries `retainedProbe` already reaches `proveTests` as
//        `probeSeams.retainedProbe`, and `proveTests` already resumes that container instead of
//        building a new baseline. C3's "without creating a new baseline" rests on this.
//   G3 / C5(interrupted-partial regression)  the existing `--resume-partial` retry path for an
//        acknowledged interrupted AUTHOR-PROOF attempt, and its refusal without that flag.
//   G4 / C1  the upstream distinction the new dedicated field is filtered from: `prove-tests`
//        already reports `retained: true` plus a durable `unfinished` marker for ordinary attempt
//        exhaustion, and `retained: false` for agent and tamper refusals — while usage-limit and
//        post-preparation setup interruptions ALSO report `retained: true`, which is exactly why
//        C1 requires the worker-level filter to be narrower than this flag.
//   G5 / C4  an interrupted attempt with no durable result already fails retry closed with
//        nothing launched — the "existing path" C4 preserves for a record that cannot be trusted.
//   G6 / C2  the durable worker channel already preserves an authorized worker envelope's own
//        fields — including `resumableProbe` — across process exit and crash recovery. C2's
//        refusal half is red and lives in test.js T5; this preservation half must not be narrowed
//        away while implementing it.
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { EventEmitter } = require('events');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const WORKER_FILE = path.join(ROOT, 'scripts', 'prepare-batch-worker.js');
const BATCH_FILE = path.join(ROOT, 'scripts', 'prepare-batch.js');
const PROVE_FILE = path.join(ROOT, 'scripts', 'prove-tests.js');
const STATE_FILE = path.join(ROOT, 'runner', 'preparation-state.js');

for (const name of ['CODEX_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN',
  'PIPELINE_BD_CMD', 'BD_ARGS_LOG', 'BD_STUB_OUT', 'BD_STUB_EXIT']) delete process.env[name];

for (const file of [WORKER_FILE, BATCH_FILE, PROVE_FILE, STATE_FILE]) {
  assert(fs.existsSync(file), `a required module does not exist: ${file}`);
}
const W = require(WORKER_FILE);
const P = require(BATCH_FILE);
const PROOF = require(PROVE_FILE);
const State = require(STATE_FILE);

const ISSUE = 'app-50';
const BATCH = 'djf50-guard-wave';
const NONCE = 'b'.repeat(32);
const HEAD = 'f'.repeat(40);
const RESET_AT = '2026-09-17T18:00:00.000Z';

const checks = [];
function check(name, body) { checks.push({ name, body }); }

const temps = [];
function tmp(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `repo-djf50-guard-${tag}-`));
  temps.push(dir);
  return dir;
}

function initGitRepo(root) {
  spawnSync('git', ['init', '-q', '--initial-branch', 'main', '.'], { cwd: root });
  spawnSync('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: root });
  spawnSync('git', ['config', 'user.name', 'fixture'], { cwd: root });
  spawnSync('git', ['add', '-A'], { cwd: root });
  spawnSync('git', ['commit', '-qm', 'fixture'], { cwd: root });
}

function makeFixture(tag, state = 'freeze') {
  const root = tmp(`${tag}-root`);
  const target = path.join(root, 'target');
  const author = path.join(root, 'author');
  for (const dir of [target, author]) {
    fs.mkdirSync(path.join(dir, 'tests', 'acceptance', ISSUE), { recursive: true });
    fs.mkdirSync(path.join(dir, 'tools'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'pipeline.config.json'),
      `${JSON.stringify({ verifyCommand: 'sh tools/run-acceptance.sh', frozenPaths: ['tools/run-acceptance.sh'] })}\n`);
    fs.writeFileSync(path.join(dir, 'tools', 'run-acceptance.sh'), '# fixture runner\n');
    fs.writeFileSync(path.join(dir, 'tests', 'acceptance', ISSUE, 'test.js'), '// fixture judge\n');
  }
  initGitRepo(target);
  const cfg = {
    targetRepoPath: target, wallClockMinutes: 2, testProbeAttempts: 1,
    testProbeModel: 'fixture-probe-model', testAuthorModel: 'fixture-author-model',
    model: 'fixture-model', allowHalfProven: false,
  };
  const built = {
    ok: true, id: ISSUE, suiteId: ISSUE, canonicalId: ISSUE, state, branch: 'main',
    text: `brief for ${ISSUE}`,
    folder: { dir: author, branch: `freeze-${ISSUE}`, exists: true },
    cfg,
    policy: { verifyCommand: 'sh tools/run-acceptance.sh', frozenPaths: ['tools/run-acceptance.sh'] },
    criteria: { source: 'structured', sha256: 'a'.repeat(64), text: '1. works' },
    issue: { id: ISSUE, title: ISSUE, priority: 2, dependencies: [] },
  };
  return { root, target, author, cfg, built };
}

function fakeRun(target) {
  return (cmd, args) => {
    if (args[0] === 'rev-parse') return { status: 0, stdout: `${'a'.repeat(40)}\n` };
    if (args[0] === 'clone') {
      fs.cpSync(target, args[args.length - 1], { recursive: true });
      return { status: 0 };
    }
    return { status: 0 };
  };
}

function preparedContainer(fx) {
  const prepared = PROOF.prepareProbe(fx.built, 'fixture-probe-model', fakeRun(fx.target), tmp('probes'));
  assert(prepared.ok, `fixture preparation failed: ${prepared.error}`);
  return prepared;
}

function stateFixture(fx, batch = BATCH) {
  const stateRoot = tmp('state');
  State.createManifest(stateRoot, batch, {
    project: 'fixture', runConfig: 'run.json', intent: 'test', concurrency: 1,
    integrationBranch: 'main', integrationHead: HEAD, config: fx.cfg,
    issues: [{ id: ISSUE, dependencies: [] }],
  });
  return stateRoot;
}

function batchSeams(fx, stateRoot, jobs, extra = {}) {
  return {
    state: State, preparationRoot: () => stateRoot,
    loadConfig: () => fx.cfg,
    acquire: () => ({ ok: true, tookOver: false, ownership: {} }), release() {},
    inspectIntegration: () => ({ ok: true, branch: 'main', head: HEAD }),
    readyQueue: () => ({ ok: true, issues: [] }),
    runSync: () => ({ status: 0, stdout: HEAD, stderr: '' }),
    resolveDesign: () => ({ ok: true, reasons: [], commit: HEAD }),
    buildBrief: () => fx.built,
    runWorker: (root, batch, item) => {
      jobs.push({ id: item.id, action: item.action, retainedProbe: item.retainedProbe });
      return { id: item.id, ok: false, outcome: 'unproven' };
    },
    ...extra,
  };
}

// ── G1 / C3, C5(usage-limit regression) [guard] ──────────────────────────────────────────────
check('G1 C3,C5(usage-limit regression) [guard] resume already hands the recorded usage-limit probe to the relaunched worker as retainedProbe', async () => {
  const fx = makeFixture('g1');
  const prepared = preparedContainer(fx);
  const stateRoot = stateFixture(fx);
  State.writeWorkerStarted(stateRoot, BATCH, ISSUE, { nonce: NONCE, phase: 'proof', pid: process.pid });
  State.writeWorkerResult(stateRoot, BATCH, ISSUE, {
    nonce: NONCE, outcome: 'usage-limit', exitCode: 1,
    data: { id: ISSUE, ok: false, outcome: 'usage-limit', probe: prepared.probe,
      rateLimit: { resetAt: RESET_AT, evidence: 'usage limit reached' } },
  });
  State.appendEvent(stateRoot, BATCH, 'batch.usage-limit-paused', {
    state: 'paused', resetAt: RESET_AT, stage: 'proof', activeWorkers: [ISSUE], issueId: ISSUE,
    preservedPaths: [prepared.probe], resumeCommand: `node scripts/prepare-batch.js resume ${BATCH}`,
  });

  const jobs = []; const err = [];
  await P.execute({ mode: 'resume', batch: BATCH, issues: [], concurrency: 1 },
    { out() {}, err: (s) => err.push(String(s)) },
    batchSeams(fx, stateRoot, jobs, { now: () => '2026-09-18T00:00:00.000Z' }));
  assert.strictEqual(jobs.length, 1, `resume launched ${jobs.length} workers: ${err.join(' | ')}`);
  assert.strictEqual(jobs[0].action, 'proof', `resume relaunched ${jobs[0].action}, not the recorded phase`);
  assert.strictEqual(jobs[0].retainedProbe, prepared.probe,
    `resume no longer hands the recorded usage-limit probe to the relaunched worker: ${JSON.stringify(jobs[0])}`);
});

// ── G2 / C3 [guard] ──────────────────────────────────────────────────────────────────────────
check('G2 C3 [guard] a job carrying retainedProbe already reaches proveTests as probeSeams.retainedProbe and resumes that container instead of building a new baseline', () => {
  const fx = makeFixture('g2');
  const prepared = preparedContainer(fx);

  const seen = [];
  W.execute({ action: 'proof', built: fx.built, configPath: 'run.json', retainedProbe: prepared.probe },
    { proveTests: (built, model, probeSeams) => { seen.push(probeSeams); return { ok: false, kind: 'unproven', probe: prepared.probe, retained: true, error: 'fixture' }; } });
  assert.strictEqual(seen.length, 1, 'the worker did not reach proveTests at all');
  assert.strictEqual(seen[0].retainedProbe, prepared.probe,
    `the worker no longer wires job.retainedProbe into probeSeams: ${JSON.stringify(seen[0])}`);

  let prepares = 0; let resumes = 0;
  const result = PROOF.proveTests(fx.built, 'fixture-probe-model', {
    runSync: fakeRun(fx.target),
    retainedProbe: prepared.probe,
    prepareProbe: () => { prepares += 1; throw new Error('a resumed proof must not build a new baseline'); },
    resumeProbe: (...args) => { resumes += 1; return PROOF.resumeProbe(...args); },
    launchProbe: () => ({ status: 0, stdout: '' }),
    invariantErrors: () => [],
    runGate: () => ({ status: 3, stdout: 'still red' }),
  });
  assert.strictEqual(prepares, 0, 'a retained probe no longer suppresses fresh baseline preparation');
  assert.strictEqual(resumes, 1, 'a retained probe is no longer resumed through resumeProbe');
  assert.strictEqual(result.kind, 'unproven', JSON.stringify(result));
  assert.strictEqual(path.resolve(result.probe), path.resolve(prepared.probe),
    'the resumed proof no longer reports the retained container it resumed');
});

// ── G3 / C5(interrupted-partial regression) [guard] ──────────────────────────────────────────
check('G3 C5(interrupted-partial regression) [guard] --resume-partial still relaunches exactly one author-proof for an acknowledged interrupted-partial attempt, and plain retry still refuses', async () => {
  const fx = makeFixture('g3');
  const stateRoot = stateFixture(fx);
  State.writeWorkerStarted(stateRoot, BATCH, ISSUE, { nonce: NONCE, phase: 'author-proof', pid: process.pid });
  State.writeWorkerResult(stateRoot, BATCH, ISSUE, {
    nonce: NONCE, outcome: 'abandoned', exitCode: 1,
    data: { id: ISSUE, ok: false, outcome: 'abandoned',
      acknowledgedInterrupted: true, interruptedPhase: 'author-proof' },
  });

  const refusedJobs = []; const refusedErr = [];
  const refused = await P.execute({ mode: 'retry', batch: BATCH, issues: [ISSUE], concurrency: 1, resumePartial: false },
    { out() {}, err: (s) => refusedErr.push(String(s)) }, batchSeams(fx, stateRoot, refusedJobs));
  assert.strictEqual(refused, P.EXIT_ATTENTION, `plain retry of an acknowledged interruption no longer needs attention (exit ${refused})`);
  assert.strictEqual(refusedJobs.length, 0, 'plain retry launched a worker for an acknowledged interruption');

  const jobs = []; const err = [];
  await P.execute({ mode: 'retry', batch: BATCH, issues: [ISSUE], concurrency: 1, resumePartial: true },
    { out() {}, err: (s) => err.push(String(s)) }, batchSeams(fx, stateRoot, jobs));
  assert.strictEqual(jobs.length, 1, `--resume-partial launched ${jobs.length} workers: ${err.join(' | ')}`);
  assert.strictEqual(jobs[0].action, 'author-proof',
    `--resume-partial no longer resumes the interrupted author-proof phase: ${JSON.stringify(jobs[0])}`);
});

// ── G4 / C1 [guard] ──────────────────────────────────────────────────────────────────────────
check('G4 C1 [guard] prove-tests already reports retained true with a durable unfinished marker for ordinary exhaustion, false for agent and tamper refusals, and true for usage-limit and post-preparation interruptions alike', () => {
  const fx = makeFixture('g4');
  const proof = (extra) => PROOF.proveTests(fx.built, 'fixture-probe-model', {
    runSync: fakeRun(fx.target),
    prepareProbe: () => preparedContainer(fx),
    launchProbe: () => ({ status: 0, stdout: '' }),
    invariantErrors: () => [],
    runGate: () => ({ status: 3, stdout: 'still red' }),
    ...extra,
  });

  const exhausted = proof({});
  assert.strictEqual(exhausted.kind, 'unproven', JSON.stringify(exhausted));
  assert.strictEqual(exhausted.retained, true, 'ordinary exhaustion no longer reports retained: true');
  const marker = JSON.parse(fs.readFileSync(path.join(path.dirname(exhausted.probe), PROOF.MARKER), 'utf8'));
  assert.strictEqual(marker.status, 'unfinished', `ordinary exhaustion no longer records the unfinished marker: ${JSON.stringify(marker)}`);

  const agent = proof({ launchProbe: () => ({ status: 7, stdout: 'boom', stderr: '' }) });
  assert.strictEqual(agent.kind, 'agent', JSON.stringify(agent));
  assert.strictEqual(agent.retained, false, 'an agent failure no longer reports retained: false');

  const tamper = proof({ invariantErrors: () => ['probe protected path edited tools/run-acceptance.sh'] });
  assert.strictEqual(tamper.kind, 'tamper', JSON.stringify(tamper));
  assert.strictEqual(tamper.retained, false, 'a tamper refusal no longer reports retained: false');

  // The two outcomes that share the `retained: true` flag with ordinary exhaustion without being
  // ordinary validated unfinished proofs. C1's filter exists because of exactly these.
  const interrupted = proof({ invariantErrors: () => { throw new Error('fixture host fault'); } });
  assert.strictEqual(interrupted.kind, 'setup', JSON.stringify(interrupted));
  assert.strictEqual(interrupted.retained, true, 'a post-preparation interruption no longer reports retained: true');

  const parked = proof({ launchProbe: () => ({ status: 1, stdout: 'usage limit reached|9999999999' }) });
  assert.strictEqual(parked.kind, 'usage-limit', JSON.stringify(parked));
  assert.strictEqual(parked.retained, true, 'a usage-limit park no longer reports retained: true');
});

// ── G5 / C4 [guard] ──────────────────────────────────────────────────────────────────────────
check('G5 C4 [guard] an attempt with no durable result still fails retry closed with nothing launched', async () => {
  const fx = makeFixture('g5');
  const stateRoot = stateFixture(fx);
  State.writeWorkerStarted(stateRoot, BATCH, ISSUE, { nonce: NONCE, phase: 'proof', pid: 2147483000 });

  const jobs = []; const err = [];
  const code = await P.execute({ mode: 'retry', batch: BATCH, issues: [ISSUE], concurrency: 1, resumePartial: false },
    { out() {}, err: (s) => err.push(String(s)) }, batchSeams(fx, stateRoot, jobs));
  assert.strictEqual(code, P.EXIT_ATTENTION, `an unresolved worker no longer needs attention (exit ${code})`);
  assert.strictEqual(jobs.length, 0, 'a retry with an unresolved worker record launched a worker anyway');
});

// ── G6 / C2 [guard] ──────────────────────────────────────────────────────────────────────────
check('G6 C2 [guard] the durable worker channel already preserves an authorized envelope field across process exit and crash recovery', async () => {
  const fx = makeFixture('g6');
  const prepared = preparedContainer(fx);
  const stateRoot = stateFixture(fx);
  const envelope = JSON.stringify({ id: ISSUE, ok: false, outcome: 'unproven', kind: 'unproven',
    probe: prepared.probe, resumableProbe: prepared.probe, error: 'the green probe did not pass' });

  const child = new EventEmitter();
  child.pid = 31337;
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  child.kill = () => {};
  child.stdin = { end: () => setImmediate(() => {
    child.stdout.emit('data', Buffer.from(`${envelope}\n`));
    child.emit('close', 1);
  }) };

  await P.runWorker(stateRoot, BATCH, { id: ISSUE, action: 'proof', built: fx.built }, 'run.json', State, {
    spawn: () => child, ownership: {}, markPreparationUncertain() {}, clearPreparationUncertain() {},
  });

  // A fresh process with no inherited memory reads the same preparation root back.
  const script = 'const S=require(' + JSON.stringify(STATE_FILE) + ');'
    + 'const rows=S.readWorkerRecords(' + JSON.stringify(stateRoot) + ',' + JSON.stringify(BATCH) + ',' + JSON.stringify(ISSUE) + ');'
    + 'const last=rows[rows.length-1];'
    + 'process.stdout.write(JSON.stringify(last && last.result ? last.result.data : null));';
  const read = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  assert.strictEqual(read.status, 0, `the recovering process could not read durable state: ${read.stderr}`);
  const recovered = JSON.parse(read.stdout || 'null');
  assert(recovered, 'crash recovery found no durable worker result at all');
  assert.strictEqual(recovered.probe, prepared.probe, 'the durable record no longer preserves the worker probe path');
  assert.strictEqual(recovered.resumableProbe, prepared.probe,
    `the durable record no longer preserves an authorized worker envelope field: ${read.stdout}`);
});

(async () => {
  let failed = 0;
  for (const item of checks) {
    try { await item.body(); console.log(`ok - ${item.name}`); }
    catch (error) { failed = 1; console.error(`FAIL - ${item.name} — ${error.stack || error.message}`); }
  }
  for (const dir of temps.splice(0)) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
  process.exitCode = failed;
})().catch((error) => {
  console.error(`FAIL - guard harness — ${error.stack || error.message}`);
  process.exitCode = 1;
});
