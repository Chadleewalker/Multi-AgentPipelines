#!/usr/bin/env node
// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const P = require('../../scripts/prepare-batch');
const W = require('../../scripts/prepare-batch-worker');
const State = require('../../runner/preparation-state');
const Lock = require('../../runner/lock');
const REPO_ROOT = path.resolve(__dirname, '..', '..');

let passed = 0; let failed = 0;
function check(name, condition) {
  if (condition) { passed += 1; console.log(`PASS ${name}`); }
  else { failed += 1; console.error(`FAIL ${name}`); }
}

function built(id = 'app-1', state = 'write', extra = {}) {
  const folder = extra.folder || { dir: path.join(os.tmpdir(), `freeze-${id}`), branch: `freeze-${id}`, exists: true };
  return {
    ok: true, id, state, branch: 'main', text: `brief for ${id}`,
    cfg: { targetRepoPath: os.tmpdir(), model: 'opus', wallClockMinutes: 1 },
    policy: { verifyCommand: 'sh tools/run-acceptance.sh', frozenPaths: [] },
    folder, criteria: { source: 'structured', sha256: 'a'.repeat(64), text: '1. works' },
    issue: { id, title: id, priority: 2, dependencies: [] },
    ...extra,
  };
}

// A. CLI is intentionally small and portable.
check('A1 start accepts repeated issue ids and defaults preparation concurrency to two', (() => {
  const v = P.parseArgs(['start', 'night-wave', '--config', 'run.json', '--issue', 'app-1', '--issue', 'app-2']);
  return !v.error && v.issues.length === 2 && v.concurrency === 2;
})());
check('A2 concurrency has a hard preparation ceiling of three',
  /1 to 3/.test(P.parseArgs(['start', 'wave', '--config', 'x', '--issue', 'app-1', '--author-concurrency', '4']).error || ''));
check('A3 duplicate ids are rejected before snapshotting',
  /duplicate/.test(P.parseArgs(['start', 'wave', '--config', 'x', '--issue', 'app-1', '--issue', 'app-1']).error || ''));
check('A4 portable reserved ids are rejected without throwing',
  /unsafe/.test(P.parseArgs(['start', 'wave', '--config', 'x', '--issue', 'CON']).error || ''));
check('A5 no publication-like mode exists',
  /unknown mode/.test(P.parseArgs(['publish', 'wave']).error || ''));
check('A6 retry accepts positional issue ids while resume does not',
  !P.parseArgs(['retry', 'wave', 'app-1']).error && /unexpected/.test(P.parseArgs(['resume', 'wave', 'app-1']).error || ''));
check('A7 resume/status cannot smuggle a new issue outside the immutable roster',
  /only by start/.test(P.parseArgs(['resume', 'wave', '--issue', 'app-1']).error || ''));
check('A8 interrupted acknowledgement is a separate explicit verb with named issues',
  !P.parseArgs(['acknowledge-interrupted', 'wave', 'app-1']).error
    && /needs at least one/.test(P.parseArgs(['acknowledge-interrupted', 'wave']).error || ''));

// B. Classification preserves blockers as blockers.
check('B1 a dispatchable suite is already-frozen and gets no worker action',
  P.classifyBuilt('app-1', built('app-1', 'ready')).outcome === 'already-frozen');
check('B2 missing criteria stop before authoring', (() => {
  const v = built(); v.criteria = { source: 'none', sha256: '', text: '' };
  const c = P.classifyBuilt('app-1', v); return c.outcome === 'needs-criteria' && !c.action;
})());
check('B3 a resolution collision remains human attention',
  P.classifyBuilt('app-1', { ok: false, kind: 'collision', error: 'two trees' }).outcome === 'collision');
check('B4 write and existing-suite states select only author-proof and proof',
  P.classifyBuilt('app-1', built()).action === 'author-proof'
    && P.classifyBuilt('app-1', built('app-1', 're-gate')).action === 'proof');

// C. Snapshotting is serial, includes dependencies, and finds worktree aliasing before launch.
{
  let active = 0; let max = 0; const order = [];
  const same = { dir: path.join(os.tmpdir(), 'same-tree'), branch: 'freeze-same', exists: true };
  const fixtureCfg = built().cfg;
  const snapshots = P.snapshotBatch(fixtureCfg, ['app-1', 'app-2'], 'run.json', {
    buildBrief: ({ id }) => {
      active += 1; max = Math.max(max, active); order.push(id); active -= 1;
      return built(id, 'write', { folder: same,
        issue: { id, title: id, priority: 1, dependencies: [{ id: id === 'app-2' ? 'app-1' : 'outside-1' }] } });
    },
  });
  check('C1 all canonical issue reads happen serially and in input order', max === 1 && order.join(',') === 'app-1,app-2');
  check('C2 dependency ids are captured in the manifest summary', snapshots[1].summary.dependencies[0] === 'app-1');
  check('C3 two issues resolving to one worktree both become collisions',
    snapshots.every((v) => v.outcome === 'collision' && !v.action));
}

{
  const absent = built('app-3', 'write', { folder: { dir: path.join(os.tmpdir(), 'new-tree'), branch: 'freeze-app-3', exists: false } });
  let ensured = 0; let rebuilt = 0;
  const items = [{ id: 'app-3', action: 'author-proof', outcome: 'author-proof', built: absent }];
  P.prepareWorktrees(items, 'run.json', {
    ensureWorktree: () => { ensured += 1; return { ok: true, created: true }; },
    buildBrief: () => { rebuilt += 1; return built('app-3'); },
  });
  check('C4 worktree creation is parent-owned and followed by a fresh immutable brief',
    ensured === 1 && rebuilt === 1 && items[0].built.folder.exists);
}
{
  const absent = built('app-7', 're-gate', {
    folder: { dir: path.join(os.tmpdir(), 'freeze-app-7'), branch: 'freeze-app-7', exists: false },
  });
  const exact = built('app-7', 're-gate'); let ensured = 0;
  const items = [{ id: 'app-7', action: 'proof', outcome: 'proof', built: absent }];
  P.prepareWorktrees(items, 'run.json', {
    ensureWorktree: () => { ensured += 1; return { ok: true, created: true }; },
    buildBrief: () => exact,
    runSync: () => ({ status: 0, stdout: 'f'.repeat(40), stderr: '' }),
  }, 'f'.repeat(40));
  check('C5 proof-only work also creates and uses the exact issue worktree, never shared main',
    ensured === 1 && items[0].action === 'proof' && items[0].built.folder.dir === exact.folder.dir);
}
{
  const expected = { targetRepoPath: path.join(os.tmpdir(), 'expected-target'), model: 'opus' };
  const wrong = built('app-retarget', 'write', {
    cfg: { ...expected, targetRepoPath: path.join(os.tmpdir(), 'other-target') },
  });
  const snapshots = P.snapshotBatch(expected, ['app-retarget'], 'run.json', { buildBrief: () => wrong });
  check('C6 a buildBrief retarget or config drift is refused before worktree/worker use',
    snapshots[0].outcome === 'attention' && !snapshots[0].action && /config identity/.test(snapshots[0].error));
}
{
  const expected = { targetRepoPath: path.join(os.tmpdir(), 'refresh-target'), model: 'opus' };
  const absent = built('app-refresh', 'write', {
    cfg: expected,
    folder: { dir: path.join(os.tmpdir(), 'refresh-tree'), branch: 'freeze-app-refresh', exists: false },
  });
  const item = { id: 'app-refresh', action: 'author-proof', outcome: 'author-proof', built: absent };
  P.prepareWorktrees([item], 'run.json', {
    ensureWorktree: () => ({ ok: true, created: true }),
    buildBrief: () => built('app-refresh', 'write', {
      cfg: { ...expected, targetRepoPath: path.join(os.tmpdir(), 'retargeted-during-refresh') },
    }),
  }, null, expected);
  check('C7 a refreshed brief cannot retarget after worktree creation',
    item.outcome === 'collision' && !item.action && /config identity/.test(item.error));
}

// D. The pool is bounded even when completion order differs.
(async () => {
  let active = 0; let max = 0;
  const results = await P.runPool([1, 2, 3, 4, 5], 2, async (value) => {
    active += 1; max = Math.max(max, active);
    await new Promise((resolve) => setTimeout(resolve, value % 2 ? 4 : 1));
    active -= 1; return value * 2;
  });
  check('D1 bounded pool never exceeds author concurrency', max === 2);
  check('D2 bounded pool preserves manifest order in its result', results.join(',') === '2,4,6,8,10');

  // E. A worker accepts only a complete immutable job and revalidates managed proof evidence.
  let proved = 0;
  const success = W.execute({ action: 'proof', built: built('app-4', 're-gate') }, {
    proveTests: () => { proved += 1; return { ok: true, probe: 'X/probe', attempt: 1, evidence: 'red then green' }; },
    runSync: () => ({ status: 0, stdout: 'f'.repeat(40), stderr: '' }),
    validateManagedProbe: () => ({ ok: true, managed: true, marker: {
      issue: 'app-4', head: 'f'.repeat(40), manifestHash: 'a'.repeat(64), evidenceHash: 'b'.repeat(64), attempts: 1,
    } }),
  });
  check('E1 proof worker returns proven-at-base only after managed marker validation',
    success.ok && success.outcome === 'proven-at-base' && success.proof.issue === 'app-4' && proved === 1);
  const forged = W.execute({ action: 'proof', built: built('app-4', 're-gate') }, {
    proveTests: () => ({ ok: true, probe: 'X/probe', attempt: 1 }),
    runSync: () => ({ status: 0, stdout: 'f'.repeat(40), stderr: '' }),
    validateManagedProbe: () => ({ ok: false, managed: true, error: 'wrong hash' }),
  });
  check('E2 a forged or stale proof is downgraded to unproven',
    !forged.ok && forged.kind === 'proof-validation');
  let invoked = false;
  const invalid = W.execute({ action: 'proof', built: { id: '../bad' } }, {
    proveTests: () => { invoked = true; return { ok: true }; },
  });
  check('E3 malformed immutable input invokes no author or probe', !invalid.ok && !invoked);
  check('E4 worker output is explicitly bounded', W.limited('x'.repeat(W.MAX_TEXT + 5)).includes('[truncated 5 characters]'));

  // F. Start owns the target lock and refuses the permissive half-proven posture.
  function fakeState() {
    const calls = [];
    return {
      calls,
      preparationRoot: () => 'R', validateBatchId: () => true, validateIssueId: () => true,
      createManifest: (_r, _b, input) => { calls.push(['manifest', input]); return { ...input }; },
      appendEvent: (_r, _b, type, payload) => { calls.push([type, payload]); },
      readWorkerRecords: () => [], readEvents: () => [], createWorkerNonce: () => 'a'.repeat(32),
      writeWorkerStarted: () => {}, writeWorkerResult: () => {},
      deriveState: () => ({ ok: true, issues: [] }),
    };
  }
  const state = fakeState(); let acquired = 0; let released = 0;
  const startCfg = { ...built('app-5').cfg, allowHalfProven: false };
  const out = [];
  const code = await P.execute({ mode: 'start', batch: 'wave', config: 'run.json', issues: ['app-5'], concurrency: 2 },
    { out: (s) => out.push(s), err: (s) => out.push(s) }, {
      state, preparationRoot: () => 'R',
      loadConfig: () => startCfg,
      acquire: () => { acquired += 1; return { ok: true, tookOver: false, ownership: {} }; },
      release: () => { released += 1; },
      runSync: () => ({ status: 0, stdout: 'f'.repeat(40), stderr: '' }),
      inspectIntegration: () => ({ ok: true, branch: 'main', head: 'f'.repeat(40) }),
      readyQueue: () => ({ ok: true, issues: [] }),
      buildBrief: () => built('app-5', 'ready', { cfg: startCfg }),
    });
  check('F1 start holds and releases one target-global lock around the full snapshot', code === 0 && acquired === 1 && released === 1);
  check('F2 already-frozen issue records durable state without spawning a worker',
    state.calls.some((c) => c[0] === 'issue.snapshotted' && c[1].state === 'already-frozen'));
  let lockTouched = false;
  const refused = await P.execute({ mode: 'start', batch: 'wave2', config: 'run.json', issues: ['app-6'], concurrency: 2 },
    { out() {}, err() {} }, {
      state: fakeState(), preparationRoot: () => 'R',
      loadConfig: () => ({ targetRepoPath: os.tmpdir(), allowHalfProven: true }),
      acquire: () => { lockTouched = true; return { ok: true }; },
    });
  check('F3 all-proven posture refuses allowHalfProven before lock or worker activity',
    refused === P.EXIT_REFUSED && !lockTouched);
  check('F4 unsynchronized local and remote integration heads are refused', (() => {
    const calls = [];
    const inspected = P.inspectIntegration({ targetRepoPath: 'X', targetRepoRemote: 'remote' }, 'main', {
      runSync: (_cmd, args) => {
        calls.push(args.join(' '));
        if (args.includes('--abbrev-ref')) return { status: 0, stdout: 'main\n' };
        if (args[0] === 'ls-remote') return { status: 0, stdout: `${'e'.repeat(40)}\trefs/heads/main\n` };
        return { status: 0, stdout: `${'f'.repeat(40)}\n` };
      },
    });
    return !inspected.ok && /differs from remote/.test(inspected.error) && calls.some((v) => v.startsWith('ls-remote'));
  })());

  // G. Static capability boundary. These scripts have no queue writer or publication module.
  const coordinator = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'prepare-batch.js'), 'utf8');
  const worker = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'prepare-batch-worker.js'), 'utf8');
  check('G1 worker imports neither buildBrief nor the Beads adapter',
    !/require\(['"]\.\/spec-brief/.test(worker) && !/require\(['"]\.\.\/runner\/bd/.test(worker));
  check('G2 neither component imports a publication command',
    !/require\(['"]\.\/freeze(?:-gate)?['"]\)/.test(coordinator + worker)
      && !/require\(['"]\.\.\/runner\/publish['"]\)/.test(coordinator + worker));
  check('G3 coordinator spawns workers by executable and argv with shell disabled',
    /spawn\)\(process\.execPath, \[WORKER\]/.test(coordinator) && /shell: false/.test(coordinator));
  check('G4 Beads access in the parent is a literal show-only argv',
    /bdJson\)\(cfg, \['show', id\]\)/.test(coordinator)
      && !/bdJson\)[^\n]*\['(?:update|close|create|set)/.test(coordinator));

  // H. Ambient test seams cannot replace production executables.
  const sanitized = P.workerEnv({
    PATH: 'safe', PIPELINE_TEST_AUTHOR_CMD: 'evil', PIPELINE_TEST_PROBE_CMD: 'evil',
    PIPELINE_BD_CMD: 'evil', FREEZE_GATE_CMD: 'evil',
  });
  check('H1 production worker environment strips executable/gate test seams',
    sanitized.PATH === 'safe' && sanitized.PIPELINE_TEST_AUTHOR_CMD === undefined
      && sanitized.PIPELINE_TEST_PROBE_CMD === undefined && sanitized.PIPELINE_BD_CMD === undefined
      && sanitized.FREEZE_GATE_CMD === undefined);
  const testEnv = P.workerEnv({ PIPELINE_TESTING_PREPARE_BATCH_SEAMS: '1', PIPELINE_TEST_AUTHOR_CMD: 'stub' });
  check('H2 one explicit preparation test sentinel preserves test seams', testEnv.PIPELINE_TEST_AUTHOR_CMD === 'stub');

  // I. Resume never duplicates a started worker; an interrupted attempt needs explicit retry.
  {
    const events = []; let workers = 0;
    const resumeState = {
      preparationRoot: () => 'R',
      readManifest: () => ({ runConfig: 'run.json', concurrency: 2, issues: [{ id: 'app-8' }],
        configHash: 'H', integrationHead: 'f'.repeat(40) }),
      canonicalHash: () => 'H', redactConfig: (v) => v,
      readEvents: () => [{ type: 'issue.snapshotted', payload: {
        issueId: 'app-8', criteriaHash: 'a'.repeat(64), issueUpdatedAt: undefined,
      } }],
      readWorkerRecords: () => [{ started: { pid: process.pid }, result: null }],
      appendEvent: (_r, _b, type, payload) => events.push([type, payload]),
      createWorkerNonce: () => 'b'.repeat(32), writeWorkerStarted() {}, writeWorkerResult() {},
    };
    const code = await P.execute({ mode: 'resume', batch: 'wave', issues: [], concurrency: 2 },
      { out() {}, err() {} }, {
        state: resumeState, preparationRoot: () => 'R',
        loadConfig: () => ({ targetRepoPath: os.tmpdir(), allowHalfProven: false }),
        acquire: () => ({ ok: true, tookOver: false, ownership: {} }), release() {},
        runSync: () => ({ status: 0, stdout: 'f'.repeat(40), stderr: '' }),
        inspectIntegration: () => ({ ok: true, branch: 'main', head: 'f'.repeat(40) }),
        readyQueue: () => ({ ok: true, issues: [] }),
        buildBrief: () => built('app-8'), runWorker: () => { workers += 1; },
      });
    check('I1 resume marks an incomplete start for attention and launches no duplicate',
      code === P.EXIT_ATTENTION && workers === 0
        && events.some((e) => e[1].state === 'attention'));
  }
  check('I2 dispatchable issues outside the immutable roster are reported as strays', (() => {
    const found = P.strayIssues({}, ['app-1'], { readyQueue: () => ({ ok: true, issues: [{ id: 'app-1' }, { id: 'app-9' }] }) });
    return found.ok && found.ids.join(',') === 'app-9';
  })());
  check('I3 every stale ownership takeover fails closed, even when its claim list is empty', (() => {
    const ownership = { recoveryOwners: [{ token: 'old' }] };
    let cleared = false;
    const settled = P.settleEmptyTakeover({ tookOver: true, ownership,
      previous: { runId: 'prepare-wave', ownerToken: 'old', claims: [] } }, {
      clearRecoveryOwner: (mine, token) => { cleared = token === 'old'; mine.recoveryOwners = []; },
    });
    return !settled.ok && !cleared && /normal pipeline recovery/.test(settled.error);
  })());
  check('I4 stale implementation ownership with claims is never cleared by preparation', (() => {
    let cleared = false;
    const settled = P.settleEmptyTakeover({ tookOver: true, ownership: {},
      previous: { runId: 'run-1', ownerToken: 'old', claims: ['app-1'] } }, {
      clearRecoveryOwner: () => { cleared = true; },
    });
    return !settled.ok && !cleared;
  })());

  // J. The real parent/worker protocol publishes a paired durable result, even for refusal.
  {
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'prepare-batch-protocol-'));
    State.createManifest(stateRoot, 'protocol', {
      project: 'fixture', runConfig: 'run.json', intent: 'test', concurrency: 1,
      config: {}, issues: [{ id: 'app-10', dependencies: [] }],
    });
    const result = await P.runWorker(stateRoot, 'protocol', {
      id: 'app-10', action: 'author-proof', built: { id: 'app-10' },
    }, 'run.json', State, {
      ownership: {}, markPreparationUncertain() {}, clearPreparationUncertain() {},
    });
    const records = State.readWorkerRecords(stateRoot, 'protocol', 'app-10');
    check('J1 real worker refusal is paired with its immutable started record',
      !result.ok && records.length === 1 && records[0].started && records[0].result
        && records[0].started.nonce === records[0].result.nonce);
    check('J2 parent result event makes the refusal visible in derived status',
      State.deriveState(stateRoot, 'protocol').issues[0].state === 'invalid');
  }
  {
    const fakeChild = new EventEmitter(); const progress = [];
    fakeChild.pid = 11223;
    fakeChild.stdout = new EventEmitter(); fakeChild.stderr = new EventEmitter();
    fakeChild.kill = () => {};
    fakeChild.stdin = { end: () => setImmediate(() => {
      const first = `${P.STAGE_PREFIX}${JSON.stringify({ stage: 'gate', phase: 'start', attempt: 1 })}\n`;
      const second = `${P.STAGE_PREFIX}${JSON.stringify({ stage: 'gate', phase: 'done', attempt: 1, elapsedMs: 25 })}\n`;
      fakeChild.stderr.emit('data', Buffer.from(first.slice(0, 13)));
      fakeChild.stderr.emit('data', Buffer.from(`${first.slice(13)}ordinary stderr\n${second}`));
      fakeChild.stdout.emit('data', Buffer.from(`${JSON.stringify({ ok: true, outcome: 'proven-at-base' })}\n`));
      fakeChild.emit('close', 0);
    }) };
    await P.runWorker('R', 'wave', {
      id: 'app-progress', action: 'proof', built: built('app-progress', 'freeze'),
    }, 'run.json', {
      createWorkerNonce: () => 'd'.repeat(32), writeWorkerStarted() {}, writeWorkerResult() {}, appendEvent() {},
    }, {
      spawn: () => fakeChild, ownership: {}, markPreparationUncertain() {}, clearPreparationUncertain() {},
      onWorkerProgress: (id, event) => progress.push({ id, event }),
    });
    check('J3 fixed proof stages cross worker stderr live without corrupting its one-JSON stdout protocol',
      progress.length === 2 && progress.every((row) => row.id === 'app-progress')
        && progress[0].event.phase === 'start' && progress[1].event.elapsedMs === 25);
  }

  // K. Machine consumers cannot get a successful status for invalid/tampered durable state.
  {
    const lines = []; const errors = [];
    const code = P.statusReport('R', 'broken', true, {
      deriveState: () => ({ ok: false, error: 'tampered event chain', issues: [] }),
    }, { out: (line) => lines.push(line), err: (line) => errors.push(line) });
    check('K1 status --json emits the structured failure but returns nonzero',
      code === P.EXIT_REFUSED && /"ok": false/.test(lines.join('\n'))
        && /tampered event chain/.test(errors.join('\n')));
  }

  // L. No configured host-environment value may survive in a durable result or event.
  {
    const secret = 'SENTINEL-host-env-value-7f9d'; const writes = []; const events = [];
    const fakeChild = new EventEmitter();
    fakeChild.pid = 24680;
    fakeChild.stdout = new EventEmitter(); fakeChild.stderr = new EventEmitter();
    fakeChild.kill = () => {};
    fakeChild.stdin = { end: () => setImmediate(() => {
      fakeChild.stdout.emit('data', Buffer.from(JSON.stringify({
        ok: false, outcome: 'unproven', error: `agent printed ${secret}`,
        evidence: { nested: [`proof also printed ${secret}`] },
      })));
      fakeChild.stderr.emit('data', Buffer.from(`stderr ${secret}`));
      fakeChild.emit('close', 1);
    }) };
    const secretBuilt = built('app-secret', 'write', {
      cfg: { targetRepoPath: os.tmpdir(), model: 'opus', hostEnv: { PRIVATE_VALUE: secret } },
    });
    const result = await P.runWorker('R', 'wave', {
      id: 'app-secret', action: 'author-proof', built: secretBuilt,
    }, 'run.json', {
      createWorkerNonce: () => 'c'.repeat(32), writeWorkerStarted() {},
      writeWorkerResult: (...args) => writes.push(args),
      appendEvent: (...args) => events.push(args),
    }, {
      spawn: () => fakeChild, ownership: {},
      markPreparationUncertain() {}, clearPreparationUncertain() {},
    });
    const durable = JSON.stringify({ writes, events, result });
    check('L1 worker results are deeply scrubbed before durable state sees them',
      !durable.includes(secret) && durable.includes(P.SECRET_MARKER));
    const direct = P.scrubSecrets({ [secret]: [secret, { message: `x${secret}y` }] }, secretBuilt.cfg);
    check('L2 scrubber covers nested values and JSON object keys',
      !JSON.stringify(direct).includes(secret));
  }

  // M. An unmatched wrapper owns an unknown descendant tree on Windows. It blocks every batch
  // until a separate human acknowledgement pairs that exact nonce; retry itself is not enough.
  {
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'prepare-batch-interrupted-'));
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'prepare-batch-target-'));
    const cfg = { targetRepoPath: target, allowHalfProven: false, model: 'opus' };
    State.createManifest(stateRoot, 'old-wave', {
      project: 'fixture', runConfig: 'run.json', intent: 'test', concurrency: 1,
      integrationBranch: 'main', integrationHead: 'f'.repeat(40),
      config: cfg, issues: [{ id: 'app-11', dependencies: [] }],
    });
    State.writeWorkerStarted(stateRoot, 'old-wave', 'app-11', {
      nonce: 'd'.repeat(32), phase: 'author-proof', pid: 2147483000,
    });
    const markerOwner = Lock.acquire(REPO_ROOT, target, 'test-marker-owner');
    Lock.markPreparationUncertain(markerOwner.ownership, {
      nonce: 'd'.repeat(32), batch: 'old-wave', issueId: 'app-11', phase: 'author-proof', pid: 2147483000,
    });
    Lock.release(REPO_ROOT, target, markerOwner.ownership);
    const unresolved = P.unresolvedWorkers(stateRoot, State);
    check('M1 global audit preserves the unmatched author phase and refuses cross-batch duplication',
      unresolved.ok && unresolved.workers.length === 1
        && unresolved.workers[0].phase === 'author-proof');
    const unrelated = P.unresolvedWorkers(stateRoot, State, path.join(os.tmpdir(), 'another-target'));
    check('M1b an interrupted target does not block preparation for an unrelated project',
      unrelated.ok && unrelated.workers.length === 0);
    const retryLines = []; let launched = 0;
    const retryCode = await P.execute({ mode: 'retry', batch: 'old-wave', issues: ['app-11'], concurrency: 2 },
      { out() {}, err: (line) => retryLines.push(line) }, {
        state: State, preparationRoot: () => stateRoot, loadConfig: () => cfg,
        acquire: () => ({ ok: true, tookOver: false, ownership: {} }), release() {},
        inspectIntegration: () => ({ ok: true, branch: 'main', head: 'f'.repeat(40) }),
        runWorker: () => { launched += 1; },
      });
    check('M2 retry cannot silently turn an unmatched author into proof-only',
      retryCode === P.EXIT_ATTENTION && launched === 0
        && /interrupted author-proof/.test(retryLines.join('\n')));
    const ackOwner = Lock.acquire(REPO_ROOT, target, 'test-ack-owner', { allowPreparationRecovery: true });
    const firstAck = P.acknowledgeInterrupted(stateRoot, 'old-wave', ['app-11'], State, cfg,
      { out() {}, err() {} }, {
        ownership: ackOwner.ownership,
        clearPreparationUncertain: () => { throw new Error('simulated crash before marker clear'); },
      });
    const acknowledged = P.acknowledgeInterrupted(stateRoot, 'old-wave', ['app-11'], State, cfg,
      { out() {}, err() {} }, { ownership: ackOwner.ownership });
    const paired = State.readWorkerRecords(stateRoot, 'old-wave', 'app-11')[0];
    check('M3 acknowledgement is crash-idempotent: pair first, then clear the exact marker on rerun',
      firstAck === P.EXIT_ATTENTION && acknowledged === 0 && paired.result
        && paired.result.nonce === paired.started.nonce && paired.result.outcome === 'abandoned'
        && Lock.listPreparationUncertain(target).length === 0
        && P.unresolvedWorkers(stateRoot, State, target).workers.length === 0);
    Lock.release(REPO_ROOT, target, ackOwner.ownership);

    let postAckWorkers = 0;
    const postAckLines = [];
    const partial = built('app-11', 'freeze', {
      cfg, folder: { dir: target, branch: 'freeze-app-11', exists: true },
    });
    const postAck = await P.execute({ mode: 'retry', batch: 'old-wave', issues: ['app-11'], concurrency: 2 },
      { out() {}, err: (line) => postAckLines.push(line) }, {
        state: State, preparationRoot: () => stateRoot, loadConfig: () => cfg,
        acquire: () => ({ ok: true, tookOver: false, ownership: {} }), release() {},
        inspectIntegration: () => ({ ok: true, branch: 'main', head: 'f'.repeat(40) }),
        readyQueue: () => ({ ok: true, issues: [] }),
        runSync: () => ({ status: 0, stdout: 'f'.repeat(40), stderr: '' }),
        buildBrief: () => partial, runWorker: () => { postAckWorkers += 1; },
      });
    check('M4 acknowledged author-proof cannot silently retry as proof-only after partial output',
      postAck === P.EXIT_ATTENTION && postAckWorkers === 0);
  }

  // N. A matched interrupted/overflow result is still target-global uncertainty until a human
  // acknowledgement; only a verified normal protocol close clears its nonce.
  {
    const fakeChild = new EventEmitter(); let marked = 0; let cleared = 0;
    fakeChild.pid = 13579;
    fakeChild.stdout = new EventEmitter(); fakeChild.stderr = new EventEmitter();
    fakeChild.kill = () => setImmediate(() => fakeChild.emit('close', null));
    fakeChild.stdin = { end: () => setImmediate(() => {
      fakeChild.stdout.emit('data', Buffer.alloc(P.MAX_WORKER_OUTPUT + 1, 120));
    }) };
    const results = [];
    const overflow = await P.runWorker('R', 'wave', {
      id: 'app-overflow', action: 'author-proof', built: built('app-overflow'),
    }, 'run.json', {
      createWorkerNonce: () => 'e'.repeat(32), writeWorkerStarted() {},
      writeWorkerResult: (...args) => results.push(args), appendEvent() {},
    }, {
      spawn: () => fakeChild, ownership: {},
      markPreparationUncertain: () => { marked += 1; },
      clearPreparationUncertain: () => { cleared += 1; },
    });
    check('N1 marker exists before feed and overflow leaves matched interruption uncertain',
      marked === 1 && cleared === 0 && overflow.outcome === 'interrupted' && results.length === 1);
  }

  check('N2 repeated refused snapshots cannot replace the first immutable fingerprint', (() => {
    const first = { type: 'issue.snapshotted', payload: { issueId: 'app-fp', criteriaHash: 'first' } };
    const later = { type: 'issue.snapshotted', payload: { issueId: 'app-fp', criteriaHash: 'later' } };
    return P.snapshotFingerprints({ readEvents: () => [first, later] }, 'R', 'wave').get('app-fp').criteriaHash === 'first';
  })());

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
})().catch((e) => { console.error(e.stack || e); process.exitCode = 1; });
