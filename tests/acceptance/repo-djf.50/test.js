// Frozen acceptance test — repo-djf.50: persist retained-proof identity through preparation retry.
// `guard.js` beside it carries the checks that are already green at the fork point (the existing
// usage-limit resume selection, the worker's existing `retainedProbe` wiring, the existing
// `--resume-partial` interrupted-partial flow, the upstream `prove-tests` retention flags, the
// existing fail-closed handling of an unresolved worker, and the durable channel's existing
// preservation of an authorized worker envelope across process exit) and must stay green;
// between them every criterion is covered in both directions.
//
// SCOPE. `scripts/prove-tests.js` already decides, per proof, whether the container it built was
// retained (`retained: true` plus a durable `status: 'unfinished'` marker, repo-djf.49). Nothing
// downstream carries that decision: `scripts/prepare-batch-worker.js` flattens every non-ok proof
// into `{ outcome: 'unproven', kind, probe }`, so the one field that survives is `probe` — the
// generic "retained for inspection" path that agent failures, tamper refusals and setup faults
// all carry too. The durable worker record therefore cannot tell a resumable proof from an
// inspectable corpse, and `prepare-batch.js retry` consequently rebuilds a baseline (and, from an
// author-proof attempt, a whole author session) that is already sitting on disk. Only the
// usage-limit *resume* path threads a `retainedProbe` back into a relaunched worker today. This
// suite is scoped to exactly that gap: one authorized, validated, durable resumable-proof
// identity, from `worker.execute` to the relaunched worker.
//
// CRITERION PAIRING — every check below also names its own criterion in its label.
//
//   C1  Structured proof and author worker results preserve a dedicated retained/resumable proof
//       path only for ordinary validated unfinished outcomes; generic probe inspection paths and
//       agent, setup, tamper, usage-limit or malformed results do not gain that authority.
//                                                                 -> T1, T2, T3, T4; guard.js G4
//   C2  The durable worker record preserves this distinction across process exit and crash
//       recovery.                                                         -> T5; guard.js G6
//   C3  prepare-batch retry selects the exact recorded retained proof and passes it as
//       retainedProbe to the next proof worker without creating a new baseline or author session.
//                                                                     -> T6; guard.js G1, G2
//   C4  Missing, stale, mismatched-phase, inspection-only or non-resumable records fail closed or
//       take their existing path; retry never fabricates retention from result.probe alone.
//                                                              -> T7, T8, T9, T10; guard.js G5
//       Each of T7-T10 drives the refusal and an AUTHORIZED positive control through the same
//       retry entry point in the same check. The refusal alone is already true at the fork point
//       — nothing threads a retained proof yet — so on its own it would be green without the
//       feature and would stay green if the feature were later removed. The paired control is
//       what makes each check discriminate: it fails unless retry really does select and hand
//       over an authorized retained proof, and the refusal beside it then says that this same
//       working selection declines the missing, stale, mismatched-phase, inspection-only and
//       non-resumable record.
//   C5  A deterministic end-to-end fixture drives proof result through worker.execute, durable
//       state, retry selection and relaunched worker, with regression coverage for usage-limit
//       and interrupted-partial flows.
//         end-to-end fixture         -> T11
//         usage-limit regression     -> guard.js G1
//         interrupted-partial regression -> guard.js G3
//
// ──────────────────────────────────────────────────────────────────────────────────────────────
// THE FROZEN INTERFACE THIS SUITE REQUIRES. No new file and no removed export; three existing
// layers each gain one field.
//
//   1. `scripts/prepare-batch-worker.js` `execute(job, seams)` — for BOTH `proof` and
//      `author-proof` jobs the structured result gains `resumableProbe`, a dedicated path that is
//      published if and only if all of the following hold of the underlying proof result:
//        * `ok === false`, `kind === 'unproven'` (ordinary attempt exhaustion — the outcome
//          `prove-tests` retains), and `retained === true` (an explicit boolean),
//        * `probe` is a non-empty string that still validates on disk as an owned managed probe
//          container for this job's suite id whose marker `status === 'unfinished'`
//          (`prove-tests` already exposes `readManagedProbe`/`validateManagedProbe` for that
//          check; the tests observe only the published path, never how it was validated).
//      In every other case the key is absent or `null` and is never derived from `probe` alone:
//      `kind` of `agent`, `setup`, `tamper`, `config` or `proof-validation`; a canonical
//      usage-limit park (which keeps its existing `probe`-based path untouched); `retained`
//      anything but `true`; a malformed or non-object proof result; and a probe path that no
//      longer validates. The existing `probe` inspection field is unchanged in every case.
//
//   2. `scripts/prepare-batch.js` `runWorker`/`parseWorkerEnvelope` — the durable worker result
//      preserves `resumableProbe` verbatim (readable as `record.result.data.resumableProbe` from
//      a fresh process reading the same preparation root) only when the worker envelope is
//      authorized: `ok === false`, `outcome === 'unproven'`, `kind === 'unproven'` and
//      `resumableProbe` a non-empty string. An unauthorized or malformed claim — wrong type,
//      empty string, a different outcome such as `usage-limit`/`proven-at-base`/`invalid`, a
//      different `kind`, or an unparsable envelope — must not reach durable state as a resumable
//      path (absent or `null` there).
//
//   3. `scripts/prepare-batch.js` `execute({ mode: 'retry', ... })` — for each named issue whose
//      latest durable attempt has a paired result carrying an authorized `resumableProbe` that
//      still exists on disk, and whose next action is `proof`, retry sets `item.retainedProbe` to
//      it. Authorization is re-checked here against the durable record itself (the same
//      `ok`/`outcome`/`kind`/type conditions as item 2), not assumed from the field's presence:
//      a record written before this rule existed, or by any other writer, is judged on its own
//      recorded content. The value is that exact recorded string (`===`, not re-derived and not
//      re-resolved), which `runWorker`
//      already feeds to the worker as the job's `retainedProbe`. The action stays `proof`: no new
//      baseline and no author session. In every other case the worker is launched with no
//      retained proof at all, exactly as retry launches it today.
//
//   Nothing above is required of any audit record. The batch's events, their payload keys and
//   its reporting are the implementation's business: this suite observes the selection where the
//   criteria place it, at the job handed to the next proof worker, and asserts nothing about the
//   shape of `issue.snapshotted` or any other event.
// ──────────────────────────────────────────────────────────────────────────────────────────────
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

// Deterministic and key-free: this suite never spawns a real agent, gate or Beads reader.
for (const name of ['CODEX_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN',
  'PIPELINE_BD_CMD', 'BD_ARGS_LOG', 'BD_STUB_OUT', 'BD_STUB_EXIT']) delete process.env[name];

const ISSUE = 'app-50';
const BATCH = 'djf50-wave';
const NONCE = 'a'.repeat(32);
const HEAD = 'f'.repeat(40);

for (const file of [WORKER_FILE, BATCH_FILE, PROVE_FILE, STATE_FILE]) {
  assert(fs.existsSync(file), `a required module does not exist: ${file}`);
}
// eslint-disable-next-line global-require
const W = require(WORKER_FILE);
// eslint-disable-next-line global-require
const P = require(BATCH_FILE);
// eslint-disable-next-line global-require
const PROOF = require(PROVE_FILE);
// eslint-disable-next-line global-require
const State = require(STATE_FILE);

const tests = [];
function test(name, body) { tests.push({ name, body }); }

const temps = [];
function tmp(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `repo-djf50-${tag}-`));
  temps.push(dir);
  return dir;
}
function cleanupTemps() {
  for (const dir of temps.splice(0)) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
}

function initGitRepo(root) {
  spawnSync('git', ['init', '-q', '--initial-branch', 'main', '.'], { cwd: root });
  spawnSync('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: root });
  spawnSync('git', ['config', 'user.name', 'fixture'], { cwd: root });
  spawnSync('git', ['add', '-A'], { cwd: root });
  spawnSync('git', ['commit', '-qm', 'fixture'], { cwd: root });
}

// One brief shape, used for worker jobs and for batch snapshots alike.
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

// A real owned probe container, left in exactly the state ordinary attempt exhaustion leaves it:
// both trees on disk and a durable `unfinished` marker.
function unfinishedContainer(fx) {
  const prepared = PROOF.prepareProbe(fx.built, 'fixture-probe-model', fakeRun(fx.target), tmp('probes'));
  assert(prepared.ok, `fixture preparation failed: ${prepared.error}`);
  assert.strictEqual(PROOF.retainUnfinished(prepared), true, 'fixture could not durably record the unfinished marker');
  return prepared;
}

// The result `prove-tests` returns for ordinary attempt exhaustion with an intact container.
function exhaustedProof(prepared) {
  return {
    ok: false, kind: 'unproven', attempt: 1, probe: prepared.probe, retained: true,
    error: 'the green probe did not pass after 1 attempt(s)', evidence: 'gate said RED',
  };
}

function resumable(result) {
  return result && typeof result.resumableProbe === 'string' && result.resumableProbe.length
    ? result.resumableProbe : null;
}
function samePath(a, b) {
  return typeof a === 'string' && typeof b === 'string' && path.resolve(a) === path.resolve(b);
}

function proofJob(fx, extra = {}) {
  return { action: 'proof', built: fx.built, configPath: 'run.json', ...extra };
}

// ── durable-state fixtures ───────────────────────────────────────────────────────────────────
function stateFixture(fx) {
  const stateRoot = tmp('state');
  State.createManifest(stateRoot, BATCH, {
    project: 'fixture', runConfig: 'run.json', intent: 'test', concurrency: 1,
    integrationBranch: 'main', integrationHead: HEAD, config: fx.cfg,
    issues: [{ id: ISSUE, dependencies: [] }],
  });
  return stateRoot;
}

function recordAttempt(stateRoot, { phase = 'proof', outcome = 'unproven', data = null, result = true }) {
  State.writeWorkerStarted(stateRoot, BATCH, ISSUE, { nonce: NONCE, phase, pid: process.pid });
  if (result) {
    State.writeWorkerResult(stateRoot, BATCH, ISSUE, {
      nonce: NONCE, outcome, exitCode: 1,
      data: data || { id: ISSUE, ok: false, outcome, kind: 'unproven' },
    });
  }
}

// One fake worker child: it emits exactly the bytes a real worker writes to stdout before it
// exits, so the durable record below is produced by the same protocol a live process uses.
function fakeChild(envelopeText, code = 1) {
  const child = new EventEmitter();
  child.pid = 31337;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  child.stdin = { end: () => setImmediate(() => {
    child.stdout.emit('data', Buffer.from(`${envelopeText}\n`));
    child.emit('close', code);
  }) };
  return child;
}

async function durableRecordFor(fx, stateRoot, envelopeText) {
  await P.runWorker(stateRoot, BATCH, { id: ISSUE, action: 'proof', built: fx.built }, 'run.json', State, {
    spawn: () => fakeChild(envelopeText), ownership: {},
    markPreparationUncertain() {}, clearPreparationUncertain() {},
  });
  const records = State.readWorkerRecords(stateRoot, BATCH, ISSUE);
  const latest = records[records.length - 1];
  assert(latest && latest.result, 'the fixture worker produced no durable result record');
  return latest.result.data || {};
}

// ── retry fixtures ───────────────────────────────────────────────────────────────────────────
function retrySeams(fx, stateRoot, jobs, extra = {}) {
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

async function runRetry(fx, stateRoot, seamsExtra = {}) {
  const jobs = []; const out = []; const err = [];
  const code = await P.execute({ mode: 'retry', batch: BATCH, issues: [ISSUE], concurrency: 1, resumePartial: false },
    { out: (s) => out.push(String(s)), err: (s) => err.push(String(s)) },
    retrySeams(fx, stateRoot, jobs, seamsExtra));
  return { code, jobs, out, err };
}

// The one durable shape C3 authorizes: an ordinary validated unfinished proof attempt.
function authorizedRecord(stateRoot, prepared) {
  recordAttempt(stateRoot, { phase: 'proof', outcome: 'unproven',
    data: { id: ISSUE, ok: false, outcome: 'unproven', kind: 'unproven',
      probe: prepared.probe, resumableProbe: prepared.probe } });
  return stateRoot;
}

// The selection is read where the criteria put it: the job handed to the next proof worker.
function assertNoRetention(retry, why) {
  for (const job of retry.jobs) {
    assert(job.retainedProbe === undefined || job.retainedProbe === null,
      `${why}: ${JSON.stringify(job)}`);
  }
}

// The positive control each C4 refusal is paired with. It runs the same `retry` entry point over
// a separate preparation root holding one authorized record, and fails unless retry really does
// select that record and hand it to the relaunched proof worker. A build that never threads a
// retained proof — the fork point, or a regression that removed the feature — fails here, so the
// refusal it is paired with cannot be satisfied by absence.
async function assertAuthorizedControlRetains(tag) {
  const fx = makeFixture(`${tag}-control`);
  const prepared = unfinishedContainer(fx);
  const retry = await runRetry(fx, authorizedRecord(stateFixture(fx), prepared));
  assert.strictEqual(retry.jobs.length, 1,
    `positive control: retry launched ${retry.jobs.length} workers: ${retry.err.join(' | ')}`);
  assert.strictEqual(retry.jobs[0].action, 'proof',
    `positive control: retry relaunched ${retry.jobs[0].action} instead of the recorded proof phase`);
  assert.strictEqual(retry.jobs[0].retainedProbe, prepared.probe,
    'positive control: retry did not hand an authorized recorded retained proof to the next proof '
    + `worker, so the refusal beside this check demonstrates nothing: ${JSON.stringify(retry.jobs[0])}`);
}

// ── T1 / C1 ──────────────────────────────────────────────────────────────────────────────────
test('T1 C1 a proof worker result for ordinary validated attempt exhaustion publishes a dedicated resumable proof path alongside the unchanged inspection path', () => {
  const fx = makeFixture('t1');
  const prepared = unfinishedContainer(fx);
  const result = W.execute(proofJob(fx), { proveTests: () => exhaustedProof(prepared) });
  assert.strictEqual(result.ok, false, JSON.stringify(result));
  assert.strictEqual(result.outcome, 'unproven', JSON.stringify(result));
  assert(samePath(resumable(result), prepared.probe),
    `an ordinary validated unfinished proof published no dedicated resumable path: ${JSON.stringify(result)}`);
  assert.strictEqual(result.probe, prepared.probe, 'the generic probe inspection path was altered');
});

// ── T2 / C1 ──────────────────────────────────────────────────────────────────────────────────
test('T2 C1 no other proof outcome gains that authority: agent, setup, tamper, usage-limit, malformed and inspection-only results publish no resumable proof path', () => {
  const fx = makeFixture('t2');
  const prepared = unfinishedContainer(fx);
  const probe = prepared.probe;
  const cases = [
    ['an agent failure', { ok: false, kind: 'agent', attempt: 1, probe, retained: false, error: 'agent exited 1' }],
    ['a post-preparation setup interruption', { ok: false, kind: 'setup', probe, retained: true, error: 'host fault mid-check' }],
    ['a tamper refusal', { ok: false, kind: 'tamper', attempt: 1, probe, retained: false, error: 'probe protected path edited' }],
    ['a canonical usage-limit park', { ok: false, outcome: 'usage-limit', kind: 'usage-limit', attempt: 1, probe, retained: true,
      rateLimit: { resetAt: '2026-09-17T18:00:00.000Z', evidence: 'usage limit reached' } }],
    ['an inspection-only unfinished result', { ok: false, kind: 'unproven', attempt: 1, probe, retained: false, error: 'not retained' }],
    ['a result whose retained flag is not the boolean true', { ok: false, kind: 'unproven', attempt: 1, probe, retained: 'yes', error: 'not a boolean' }],
    ['a result with no retained field at all', { ok: false, kind: 'unproven', attempt: 1, probe, error: 'implicit' }],
    ['a result with no kind at all', { ok: false, attempt: 1, probe, retained: true, error: 'no kind' }],
    ['a malformed non-object result', 'not an object at all'],
    ['a null result', null],
  ];
  for (const [label, proof] of cases) {
    let result;
    try { result = W.execute(proofJob(fx), { proveTests: () => proof }); }
    catch (error) { assert.fail(`${label} was not handled at all — the worker threw: ${error.message}`); }
    assert.strictEqual(resumable(result), null,
      `${label} was given resumable-proof authority: ${JSON.stringify(result)}`);
  }
  // The usage-limit park keeps its own existing shape, which the resume path still depends on.
  const parked = W.execute(proofJob(fx), { proveTests: () => ({ ok: false, outcome: 'usage-limit', probe, retained: true,
    rateLimit: { resetAt: '2026-09-17T18:00:00.000Z', evidence: 'usage limit reached' } }) });
  assert.strictEqual(parked.outcome, 'usage-limit', JSON.stringify(parked));
  assert.strictEqual(parked.probe, probe, 'the usage-limit park lost its retained probe path');
});

// ── T3 / C1 ──────────────────────────────────────────────────────────────────────────────────
test('T3 C1 an author-proof worker result carries the same dedicated resumable proof path under the same rule, and tamper inside authoring does not', () => {
  const fx = makeFixture('t3', 'write');
  const prepared = unfinishedContainer(fx);
  const authorSeams = (proof) => ({
    auditAuthorTree: () => ({ ok: true }),
    launchAuthor: () => ({ status: 0, stdout: 'author session finished' }),
    proveTests: () => proof,
  });
  const job = { action: 'author-proof', built: fx.built, configPath: 'run.json' };

  const retainedResult = W.execute(job, authorSeams(exhaustedProof(prepared)));
  assert.strictEqual(retainedResult.outcome, 'unproven', JSON.stringify(retainedResult));
  assert(samePath(resumable(retainedResult), prepared.probe),
    `an author-proof attempt whose authoring completed and whose proof exhausted published no resumable path: ${JSON.stringify(retainedResult)}`);

  const tampered = W.execute(job, authorSeams({ ok: false, kind: 'tamper', attempt: 1,
    probe: prepared.probe, retained: false, error: 'probe protected path edited' }));
  assert.strictEqual(resumable(tampered), null,
    `an author-proof attempt refused for tampering was given resumable-proof authority: ${JSON.stringify(tampered)}`);
});

// ── T4 / C1 ──────────────────────────────────────────────────────────────────────────────────
test('T4 C1 the published path is validated, not echoed: a probe that is not an owned unfinished container for this issue publishes nothing even when the proof result claims retention', () => {
  const fx = makeFixture('t4');

  const gone = unfinishedContainer(fx);
  fs.rmSync(gone.container, { recursive: true, force: true });
  assert.strictEqual(resumable(W.execute(proofJob(fx), { proveTests: () => exhaustedProof(gone) })), null,
    'a retained path whose container no longer exists was published anyway');

  const foreign = unfinishedContainer(fx);
  const foreignMarkerPath = path.join(foreign.container, PROOF.MARKER);
  const foreignMarker = JSON.parse(fs.readFileSync(foreignMarkerPath, 'utf8'));
  foreignMarker.issue = 'app-other';
  fs.writeFileSync(foreignMarkerPath, JSON.stringify(foreignMarker, null, 2));
  assert.strictEqual(resumable(W.execute(proofJob(fx), { proveTests: () => exhaustedProof(foreign) })), null,
    'a retained path belonging to another issue was published anyway');

  const proven = unfinishedContainer(fx);
  const provenMarkerPath = path.join(proven.container, PROOF.MARKER);
  const provenMarker = JSON.parse(fs.readFileSync(provenMarkerPath, 'utf8'));
  provenMarker.status = 'proven';
  fs.writeFileSync(provenMarkerPath, JSON.stringify(provenMarker, null, 2));
  assert.strictEqual(resumable(W.execute(proofJob(fx), { proveTests: () => exhaustedProof(proven) })), null,
    'a container already marked proven was published as an unfinished resumable proof');

  const unmarked = unfinishedContainer(fx);
  fs.rmSync(path.join(unmarked.container, PROOF.MARKER));
  assert.strictEqual(resumable(W.execute(proofJob(fx), { proveTests: () => exhaustedProof(unmarked) })), null,
    'a container with no ownership marker at all was published as a resumable proof');

  // The control: an untouched owned container in the exact state exhaustion leaves it still does
  // get published, so the refusals above are validation and not a blanket absence.
  const intact = unfinishedContainer(fx);
  assert(samePath(resumable(W.execute(proofJob(fx), { proveTests: () => exhaustedProof(intact) })), intact.probe),
    'a validly retained unfinished container was refused along with the invalid ones');
});

// ── T5 / C2 ──────────────────────────────────────────────────────────────────────────────────
// The other half of C2 — that an AUTHORIZED claim is preserved across process exit and crash
// recovery — is already true of the durable channel today and is pinned by guard.js G6.
test('T5 C2 the durable record refuses an unauthorized or malformed resumable-proof claim instead of preserving it', async () => {
  const fx = makeFixture('t5');
  const prepared = unfinishedContainer(fx);
  const probe = prepared.probe;
  const cases = [
    ['a non-string claim', JSON.stringify({ ok: false, outcome: 'unproven', kind: 'unproven', probe, resumableProbe: 12345 })],
    ['an empty-string claim', JSON.stringify({ ok: false, outcome: 'unproven', kind: 'unproven', probe, resumableProbe: '' })],
    ['an object claim', JSON.stringify({ ok: false, outcome: 'unproven', kind: 'unproven', probe, resumableProbe: { path: probe } })],
    ['a tamper result claiming resumability', JSON.stringify({ ok: false, outcome: 'unproven', kind: 'tamper', probe, resumableProbe: probe })],
    ['a usage-limit park claiming resumability', JSON.stringify({ ok: false, outcome: 'usage-limit', probe, resumableProbe: probe,
      rateLimit: { resetAt: '2026-09-17T18:00:00.000Z', evidence: 'usage limit reached' } })],
    ['a success claiming resumability', JSON.stringify({ ok: true, outcome: 'proven-at-base', probe, resumableProbe: probe })],
    ['an unparsable envelope', `{ok:false, resumableProbe:"${probe.replace(/\\/g, '/')}"`],
  ];
  for (const [label, envelope] of cases) {
    const stateRoot = stateFixture(fx);
    const durable = await durableRecordFor(fx, stateRoot, envelope);
    const claimed = durable.resumableProbe;
    assert(claimed === undefined || claimed === null,
      `${label} was preserved in durable state as a resumable proof path: ${JSON.stringify(durable)}`);
  }
});

// ── T6 / C3 ──────────────────────────────────────────────────────────────────────────────────
test('T6 C3 retry selects the exact recorded retained proof and relaunches one proof worker with it as retainedProbe, with no new baseline and no author session', async () => {
  const fx = makeFixture('t6');
  const prepared = unfinishedContainer(fx);
  const retry = await runRetry(fx, authorizedRecord(stateFixture(fx), prepared));
  assert.strictEqual(retry.jobs.length, 1, `retry launched ${retry.jobs.length} workers: ${retry.err.join(' | ')}`);
  assert.strictEqual(retry.jobs[0].action, 'proof',
    `retry relaunched ${retry.jobs[0].action} instead of resuming the recorded proof — that is a new author session`);
  assert.strictEqual(retry.jobs[0].retainedProbe, prepared.probe,
    `retry did not hand the exact recorded retained proof to the next proof worker: ${JSON.stringify(retry.jobs[0])}`);
  assert(fs.existsSync(prepared.baseline), 'retry destroyed the retained red baseline it was supposed to reuse');
  assert(fs.existsSync(prepared.probe), 'retry destroyed the retained probe it was supposed to reuse');
});

// ── T7 / C4 ──────────────────────────────────────────────────────────────────────────────────
test('T7 C4 with no durable worker record at all, retry takes its existing path and passes no retained proof — while a working selection still retains on an authorized record', async () => {
  // Paired: the control proves a live selection exists; the refusal proves it declines this case.
  await assertAuthorizedControlRetains('t7');

  const fx = makeFixture('t7');
  const retry = await runRetry(fx, stateFixture(fx));
  assert.strictEqual(retry.jobs.length, 1,
    `retry no longer takes its existing path for an issue with no durable record: ${retry.err.join(' | ')}`);
  assert.strictEqual(retry.jobs[0].action, 'proof', `retry changed the relaunched phase: ${JSON.stringify(retry.jobs[0])}`);
  assertNoRetention(retry, 'retry invented a retained probe with no record behind it');
});

// ── T8 / C4 ──────────────────────────────────────────────────────────────────────────────────
test('T8 C4 a stale record whose retained proof is no longer on disk is never handed to a worker, while the same selection still retains a live one', async () => {
  // The control differs from the refusal only in whether the recorded container survived, so a
  // pass here is specifically the on-disk check and not a blanket absence of retention.
  await assertAuthorizedControlRetains('t8');

  const fx = makeFixture('t8');
  const prepared = unfinishedContainer(fx);
  const stateRoot = authorizedRecord(stateFixture(fx), prepared);
  fs.rmSync(prepared.container, { recursive: true, force: true });

  const retry = await runRetry(fx, stateRoot);
  assertNoRetention(retry, 'retry handed a dead retained-proof path to a worker');
});

// ── T9 / C4 ──────────────────────────────────────────────────────────────────────────────────
test('T9 C4 a mismatched phase never carries the retained proof: an issue that now classifies as author-proof is relaunched without one, though the identical record retains when the next action is still proof', async () => {
  // The control carries the very same authorized proof-phase record; only the issue's next action
  // differs. A pass therefore isolates the phase check rather than the presence of the feature.
  await assertAuthorizedControlRetains('t9');

  const fx = makeFixture('t9', 'write');
  const prepared = unfinishedContainer(fx);
  const retry = await runRetry(fx, authorizedRecord(stateFixture(fx), prepared));
  assert.strictEqual(retry.jobs.length, 1,
    `retry no longer relaunches the authoring phase it classifies: ${retry.err.join(' | ')}`);
  assert.strictEqual(retry.jobs[0].action, 'author-proof',
    `retry took a different existing path for an issue that needs authoring: ${JSON.stringify(retry.jobs[0])}`);
  assertNoRetention(retry, 'an author-proof relaunch was given a retained proof path');
});

// ── T10 / C4 ─────────────────────────────────────────────────────────────────────────────────
test('T10 C4 retry never fabricates retention from result.probe alone, and a recorded non-resumable kind keeps its existing path — while the authorized record beside them is still selected', async () => {
  // Both refusals below record the same live container as the control; they differ only in what
  // the durable result says about it. The control is what makes that difference measurable.
  await assertAuthorizedControlRetains('t10');

  const fx = makeFixture('t10');
  const prepared = unfinishedContainer(fx);

  const inspectionOnly = stateFixture(fx);
  recordAttempt(inspectionOnly, { phase: 'proof', outcome: 'unproven',
    data: { id: ISSUE, ok: false, outcome: 'unproven', kind: 'unproven', probe: prepared.probe } });
  const first = await runRetry(fx, inspectionOnly);
  assert.strictEqual(first.jobs.length, 1,
    `retry no longer relaunches an inspection-only attempt at all: ${first.err.join(' | ')}`);
  assertNoRetention(first, 'retry handed an inspection-only probe to a worker as a retained proof');

  const nonResumable = stateFixture(fx);
  recordAttempt(nonResumable, { phase: 'proof', outcome: 'unproven',
    data: { id: ISSUE, ok: false, outcome: 'unproven', kind: 'tamper',
      probe: prepared.probe, resumableProbe: prepared.probe } });
  const second = await runRetry(fx, nonResumable);
  assertNoRetention(second, "retry handed a tamper refusal's forged retained proof to a worker");
});

// ── T11 / C5 ─────────────────────────────────────────────────────────────────────────────────
test('T11 C5 end to end: one exhausted proof travels through worker.execute, the durable record, a recovering process, retry selection and a relaunched worker that resumes the same container', async () => {
  const fx = makeFixture('t11');
  const prepared = unfinishedContainer(fx);

  // 1. the worker publishes the dedicated resumable path
  const first = W.execute(proofJob(fx), { proveTests: () => exhaustedProof(prepared) });
  assert(samePath(resumable(first), prepared.probe),
    `stage 1: worker.execute published no resumable proof path: ${JSON.stringify(first)}`);

  // 2. it survives the worker's own stdout protocol and process exit into durable state
  const stateRoot = stateFixture(fx);
  const durable = await durableRecordFor(fx, stateRoot, JSON.stringify(first));
  assert(samePath(durable.resumableProbe, prepared.probe),
    `stage 2: the durable record lost the resumable proof identity: ${JSON.stringify(durable)}`);

  // 3. a separate recovering process reads the same identity back
  const script = 'const S=require(' + JSON.stringify(STATE_FILE) + ');'
    + 'const rows=S.readWorkerRecords(' + JSON.stringify(stateRoot) + ',' + JSON.stringify(BATCH) + ',' + JSON.stringify(ISSUE) + ');'
    + 'process.stdout.write(String((rows[rows.length-1].result.data||{}).resumableProbe||""));';
  const read = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  assert.strictEqual(read.status, 0, `stage 3: the recovering process failed: ${read.stderr}`);
  assert(samePath(read.stdout, prepared.probe), `stage 3: crash recovery lost the identity: ${read.stdout}`);

  // 4. retry selects exactly that path for exactly one proof worker
  const retry = await runRetry(fx, stateRoot);
  assert.strictEqual(retry.jobs.length, 1, `stage 4: retry launched ${retry.jobs.length} workers: ${retry.err.join(' | ')}`);
  assert.strictEqual(retry.jobs[0].action, 'proof', 'stage 4: retry did not relaunch the proof phase');
  assert.strictEqual(retry.jobs[0].retainedProbe, prepared.probe,
    `stage 4: retry selected ${JSON.stringify(retry.jobs[0].retainedProbe)}, not the recorded retained proof`);

  // 5. the relaunched worker resumes that very container: no new baseline, no author session, and
  //    the same identity is published again for the next retry.
  const relaunched = W.execute(proofJob(fx, { retainedProbe: retry.jobs[0].retainedProbe }), {
    runSync: fakeRun(fx.target),
    launchAuthor: () => { throw new Error('a resumed proof must not start an author session'); },
    probeSeams: {
      runSync: fakeRun(fx.target),
      prepareProbe: () => { throw new Error('a resumed proof must not build a new baseline'); },
      launchProbe: () => ({ status: 0, stdout: '' }),
      invariantErrors: () => [],
      runGate: () => ({ status: 3, stdout: 'still red' }),
    },
  });
  assert.strictEqual(relaunched.outcome, 'unproven', `stage 5: ${JSON.stringify(relaunched)}`);
  assert(samePath(relaunched.probe, prepared.probe),
    `stage 5: the relaunched worker did not resume the retained container: ${JSON.stringify(relaunched)}`);
  assert(samePath(resumable(relaunched), prepared.probe),
    `stage 5: the relaunched worker did not persist the retained-proof identity: ${JSON.stringify(relaunched)}`);
});

(async () => {
  let failed = 0;
  for (const item of tests) {
    try { await item.body(); console.log(`[test] PASS ${item.name}`); }
    catch (error) { failed += 1; console.error(`[test] FAIL ${item.name}: ${error.stack || error.message}`); }
  }
  cleanupTemps();
  if (failed) { console.error(`[test] FAIL ${failed}/${tests.length} focused checks`); process.exitCode = 1; }
  else console.log(`[test] PASS ${tests.length}/${tests.length} focused checks`);
})().catch((error) => {
  cleanupTemps();
  console.error(`[test] FAIL harness: ${error.stack || error.message}`);
  process.exitCode = 1;
});
