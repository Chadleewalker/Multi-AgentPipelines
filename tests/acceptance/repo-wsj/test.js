// Frozen acceptance test — repo-wsj.  No check here is a guard: every criterion below is RED
// at the fork point.  It uses no Docker, network, Beads, or real clock.
//
// CRITERION ↔ TEST PAIRING
// C1: first canonical usage-limit response parks one batch and closes admission.
// C2: status identifies reset, stage, active workers, retained paths, and exact resume command.
// C3: early resume launches nothing; eligible resume retains evidence and launches only unfinished work.
// C4: settling workers, interruption, and repeated resume are exactly-once and lossless.
// C5: the green companion guard.js protects non-limit failure and healthy behaviour.
// C6: this file supplies the fake clock/launcher and asserts attempts, ledger, liveness, idempotence.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const prepare = require('../../../scripts/prepare-batch');
let failed = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'ok' : 'FAIL'} - ${name}${ok || !detail ? '' : ` — ${detail}`}`);
  if (!ok) failed = 1;
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// This is deliberately the closed launcher protocol already normalised by agent-provider:
// unstructured prose such as "rate limited" must never choose a reset or park a batch.
const RESET = '2026-09-11T15:30:00.000Z';
const LIMIT = { ok: false, outcome: 'usage-limit', rateLimit: { resetAt: RESET, evidence: 'usage limit reached|1789140600' } };

function harness() {
  let now = Date.parse('2026-09-11T15:00:00.000Z');
  const ledger = [];
  const launches = [];
  const retained = { 'wsj-author': '/retained/wsj-author', 'wsj-proof': '/retained/wsj-proof' };
  const initiallyRunnable = Object.keys(retained);
  // The implementation-facing controller is intentionally small: it receives only canonical
  // launcher results, a clock, and durable append/read functions.  A model cannot provide any
  // of these authorities through prose.
  const api = prepare.createUsageLimitPreparation({
    now: () => new Date(now).toISOString(),
    appendEvent: (type, payload) => ledger.push({ type, payload }),
    readEvents: () => ledger.slice(),
    launch: (issue, stage) => { launches.push({ issue, stage }); return issue === 'wsj-author' ? LIMIT : { ok: true, outcome: 'proven', retained: retained[issue] }; },
  });
  return { api, ledger, launches, retained, initiallyRunnable, advance: () => { now = Date.parse(RESET); } };
}

function built(id, cfg) {
  return {
    ok: true, id, state: 'write', branch: 'main', text: `brief for ${id}`, cfg,
    policy: { verifyCommand: 'sh tools/run-acceptance.sh', frozenPaths: [] },
    folder: { dir: path.join(os.tmpdir(), `freeze-${id}`), branch: `freeze-${id}`, exists: true },
    criteria: { source: 'structured', sha256: 'a'.repeat(64), text: '1. works' },
    issue: { id, title: id, priority: 1, dependencies: [] },
  };
}

async function realCoordinatorIntegration() {
  const calls = [];
  const launches = [];
  const ids = ['wsj-live-limit', 'wsj-live-settle', 'wsj-live-waiting'];
  const cfg = { targetRepoPath: os.tmpdir(), model: 'fixture', wallClockMinutes: 1, allowHalfProven: false };
  const state = {
    preparationRoot: () => path.join(os.tmpdir(), 'repo-wsj-no-state'),
    createManifest: (_root, _batch, input) => ({ value: input }),
    appendEvent: (_root, _batch, type, payload) => calls.push({ type, payload }),
    readWorkerRecords: () => [],
    readEvents: () => calls.slice(),
    createWorkerNonce: () => 'a'.repeat(32),
    writeWorkerStarted() {},
    writeWorkerResult() {},
    deriveState: () => ({ ok: true, issues: [] }),
  };
  const output = [];
  await prepare.execute({ mode: 'start', batch: 'repo-wsj-wired', config: 'fixture.json', issues: ids, concurrency: 2 },
    { out: (line) => output.push(line), err: (line) => output.push(line) }, {
      state,
      preparationRoot: state.preparationRoot,
      loadConfig: () => cfg,
      admitEntry: () => ({ ok: true, mode: 'standalone' }),
      acquire: () => ({ ok: true, tookOver: false, ownership: {} }),
      release() {},
      inspectIntegration: () => ({ ok: true, branch: 'main', head: 'f'.repeat(40) }),
      readyQueue: () => ({ ok: true, issues: [] }),
      buildBrief: ({ id }) => built(id, cfg),
      // A later integration gate resolves approved design provenance before admission. This
      // fixture is about shared usage-limit parking, so give it an already-resolved immutable
      // design result instead of letting an unrelated missing-design refusal mask the worker.
      resolveDesign: () => ({ ok: true, refs: [], reasons: [], remedies: [] }),
      runWorker: async (_root, _batch, item) => {
        launches.push(item.id);
        if (item.id === ids[0]) return { id: item.id, ...LIMIT };
        await new Promise((resolve) => setImmediate(resolve));
        return { id: item.id, ok: true, outcome: 'proven-at-base', proof: { probe: `/retained/${item.id}` } };
      },
    });
  const pauseEvents = calls.filter((event) => event.type === 'batch.usage-limit-paused');
  const launched = new Set(launches);
  const noFalseClassification = !calls.some((event) => event.payload && event.payload.issueId === ids[2]
    && ['agent-failed', 'unproven'].includes(event.payload.state));
  check('C1/C4/C6 the real preparation coordinator wires the shared park into worker admission and settles active work',
    launched.has(ids[0]) && launched.has(ids[1]) && !launched.has(ids[2])
      && pauseEvents.some((event) => event.payload && event.payload.resetAt === RESET),
    JSON.stringify({ launches, pauseEvents, output }));
  check('C1/C5/C6 the real coordinator leaves never-launched work pending without a false failure classification',
    noFalseClassification, JSON.stringify(calls));
}

// Drive the persisted execute path through the exact crash window the in-memory helper cannot
// represent. The first eligible resume dies during snapshotting. A durable "resumed" event
// written before that point would deactivate the pause and make the second invocation skip the
// unfinished usage-limit result. Recovery is lossless only when the pause remains active until
// the replacement attempt has actually run and settled.
async function persistedResumeRecovery() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-wsj-resume-'));
  const batch = 'repo-wsj-resume';
  const id = 'wsj-resume-worker';
  const cfg = {
    targetRepoPath: root,
    targetRepoRemote: 'https://example.invalid/repo.git',
    model: 'fixture', wallClockMinutes: 1, allowHalfProven: false,
  };
  const manifest = { value: {
    project: 'fixture', runConfig: 'fixture.json', concurrency: 1,
    integrationBranch: 'main', integrationHead: 'f'.repeat(40),
    config: cfg, configHash: 'fixture-config-hash',
    issues: [{ id, title: id, priority: 1, dependencies: [] }],
  } };
  const events = [{
    type: 'batch.usage-limit-paused',
    payload: {
      state: 'paused', resetAt: RESET, stage: 'author-proof',
      activeWorkers: [id], issueId: id,
      resumeCommand: `node scripts/prepare-batch.js resume ${batch}`,
    },
  }];
  const timeline = [];
  const prior = {
    started: { nonce: 'b'.repeat(32), pid: 987654321, phase: 'author-proof', data: { action: 'author-proof' } },
    result: { outcome: 'usage-limit', data: { id, ...LIMIT } },
  };
  const state = {
    preparationRoot: () => root,
    readManifest: () => manifest,
    canonicalHash: () => 'fixture-config-hash',
    redactConfig: (value) => value,
    appendEvent: (_root, _batch, type, payload) => { events.push({ type, payload }); timeline.push(type); },
    readEvents: () => events.slice(),
    readWorkerRecords: (_root, _batch, issueId) => issueId === id ? prior : null,
  };
  let snapshots = 0;
  let launches = 0;
  const seams = {
    state,
    preparationRoot: () => root,
    now: () => RESET,
    loadConfig: () => cfg,
    admitEntry: () => ({ ok: true, mode: 'standalone' }),
    acquire: () => ({ ok: true, tookOver: false, ownership: {} }),
    release() {},
    inspectIntegration: () => ({ ok: true, branch: 'main', head: 'f'.repeat(40) }),
    readyQueue: () => ({ ok: true, issues: [] }),
    buildBrief: ({ id: issueId }) => {
      snapshots += 1;
      if (snapshots === 1) throw new Error('injected crash after resume admission');
      return built(issueId, cfg);
    },
    resolveDesign: () => ({ ok: true, refs: [], reasons: [], remedies: [] }),
    runWorker: async (_root, _batch, item) => {
      launches += 1;
      timeline.push('worker.launch');
      return { id: item.id, ok: true, outcome: 'proven-at-base', proof: { probe: `/retained/${item.id}` } };
    },
  };
  const opts = { mode: 'resume', batch, config: null, issues: [], concurrency: 1 };
  let interrupted = false;
  try { await prepare.execute(opts, {}, seams); }
  catch (error) { interrupted = /injected crash/.test(String(error && error.message)); }
  const resumedBeforeRecovery = events.filter((event) => event.type === 'batch.usage-limit-resumed').length;
  const exit = await prepare.execute(opts, {}, seams);
  const resumedEvents = events.filter((event) => event.type === 'batch.usage-limit-resumed');
  check('C4/C6 persisted execute interruption leaves the usage-limit pause active for recovery',
    interrupted && resumedBeforeRecovery === 0,
    JSON.stringify({ interrupted, resumedBeforeRecovery, events }));
  check('C3/C4/C6 repeated persisted resume launches the unfinished attempt exactly once',
    exit === 0 && launches === 1,
    JSON.stringify({ exit, launches, events }));
  check('C4/C6 persisted resume is recorded only after the replacement attempt settles',
    resumedEvents.length === 1
      && timeline.indexOf('worker.launch') >= 0
      && timeline.indexOf('batch.usage-limit-resumed') > timeline.indexOf('worker.launch'),
    JSON.stringify({ timeline, resumedEvents }));
  fs.rmSync(root, { recursive: true, force: true });
}

async function main() {
  check('C1/C2/C3/C4/C6 preparation exports the deterministic batch usage-limit controller this suite drives',
    typeof prepare.createUsageLimitPreparation === 'function',
    'missing createUsageLimitPreparation({ now, appendEvent, readEvents, launch })');
  if (typeof prepare.createUsageLimitPreparation !== 'function') return;
  // C1/C6 — two workers may already be active, but the detected response prevents a third
  // launch and leaves untouched work pending rather than inventing agent-failed/unproven state.
  const h = harness();
  const parked = h.api.start({ batch: 'repo-wsj-park', issues: ['wsj-author', 'wsj-proof', 'wsj-untouched'], concurrency: 2 });
  check('C1/C6 deterministic canonical usage-limit result records exactly one batch-level pause',
    parked.paused === true && h.ledger.filter((e) => e.type === 'batch.usage-limit-paused').length === 1,
    JSON.stringify({ parked, ledger: h.ledger }));
  check('C1/C6 first detection closes admission: no additional model attempt starts',
    same(h.launches.map((x) => x.issue), h.initiallyRunnable), JSON.stringify(h.launches));
  check('C1/C6 untouched and retained-suite issues are pending/retained, never agent-failed or unproven',
    !same(parked.issues['wsj-untouched'].outcome, 'agent-failed')
      && !same(parked.issues['wsj-untouched'].outcome, 'unproven')
      && parked.issues['wsj-proof'].retained === h.retained['wsj-proof'], JSON.stringify(parked.issues));

  // C2 — this is operator output, not merely an event shape.
  const status = h.api.status('repo-wsj-park');
  check('C2 status reports reset, paused stage, active workers, preserved paths, and the exact resume command',
    status.resetAt === RESET && status.stage === 'author-proof'
      && same(status.activeWorkers, h.initiallyRunnable)
      && status.preservedPaths.includes(h.retained['wsj-proof'])
      && status.resumeCommand === 'node scripts/prepare-batch.js resume repo-wsj-park', JSON.stringify(status));

  // C3/C6 — no launch before reset; after reset only the unfinished author side resumes and
  // every already-authored suite/probe path is passed through unchanged.
  const beforeEarlyResume = h.launches.map((launch) => launch.issue);
  const early = h.api.resume('repo-wsj-park');
  check('C3/C6 resume before reset refuses without a model launch',
    early.refused === true && same(h.launches.map((launch) => launch.issue), beforeEarlyResume), JSON.stringify(early));
  h.advance();
  const resumeOffset = h.launches.length;
  const resumed = h.api.resume('repo-wsj-park');
  const resumedAttempts = h.launches.slice(resumeOffset);
  check('C3/C6 eligible resume reuses retained authored suite/probe and launches only unfinished proof',
    resumed.resumed === true && resumedAttempts.length === 1 && resumedAttempts[0].issue === 'wsj-author'
      && resumed.preservedPaths.includes(h.retained['wsj-proof']), JSON.stringify({ resumed, launches: h.launches }));

  // C4/C6 — concurrent settlement is idempotent.  An interruption reports liveness but does
  // not turn a paused worker into a fresh attempt; repeated resume is a read-only no-op.
  const once = h.api.settleWorker('wsj-proof', { ok: true, outcome: 'proven', retained: h.retained['wsj-proof'] });
  const twice = h.api.settleWorker('wsj-proof', { ok: true, outcome: 'proven', retained: h.retained['wsj-proof'] });
  const interrupted = h.api.interrupt('repo-wsj-park');
  const launchesAfterResume = h.launches.map((launch) => launch.issue);
  const again = h.api.resume('repo-wsj-park');
  check('C4/C6 concurrent completion is settled once and interruption preserves liveness',
    once.recorded === true && twice.recorded === false && interrupted.liveWorkers.includes('wsj-author'),
    JSON.stringify({ once, twice, interrupted }));
  check('C4/C6 repeated resume neither duplicates attempts nor loses a settled result or ledger history',
    again.idempotent === true && same(h.launches.map((launch) => launch.issue), launchesAfterResume)
      && h.ledger.filter((e) => e.type === 'issue.worker-result' && e.payload.issueId === 'wsj-proof').length === 1,
    JSON.stringify({ again, launches: h.launches, ledger: h.ledger }));

  await realCoordinatorIntegration();
  await persistedResumeRecovery();
}

main()
  .then(() => { process.exitCode = failed; })
  .catch((error) => { console.log(`FAIL - HARNESS: ${error.stack || error}`); process.exitCode = 1; });
