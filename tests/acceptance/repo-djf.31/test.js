// Criteria -> tests: C1 exact inventory; C2 unattended conveyor; C3 auth isolation and Codex summary policy; C4 Windows liveness and worker identity.
// Tests -> criteria: C1 inventory; C2 conveyor; C3 capability gate + framed/legacy summaries; C4 platform override + stable preparation PID.
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const REPAIRS = Object.freeze({
  '#130': Object.freeze({
    commit: '6f1126ea2efcae26fe9663ffd180910dea5dd00f',
    land: Object.freeze({
      'runner/proposal-supervisor.js': 'durable unattended intake, specification, preparation, implementation-feed, review, restart, and stop controller',
      'scripts/proposal-supervisor.js': 'run/resume/tick/stop/status command surface for the controller',
    }),
    documentationOnly: Object.freeze(['DESIGN.md', 'docs/change-log.md', 'docs/control-plane.md']),
  }),
  '#131': Object.freeze({
    commit: 'e6ab18b89fa34f329ca1e068e7027cc7de5c6ef7',
    land: Object.freeze({
      'pipeline/entrypoint.sh': 'explicit-command nested fixtures cannot enter the durable ChatGPT-auth path without the testing capability',
      'pipeline/envelope.js': 'legacy unframed Codex JSONL publishes its final completed agent message',
    }),
    preserveFromCombinedLane: Object.freeze({
      'pipeline/envelope.js': 'framed streams publish only the final agent message of a completed turn and partial framed streams fail closed',
    }),
    documentationOnly: Object.freeze(['DESIGN.md', 'docs/change-log.md']),
  }),
  '#133': Object.freeze({
    commit: 'fd80ab6112d8e5d0b1c76959693b2210edabef52',
    land: Object.freeze({
      'runner/lock.js': 'livenessFields accepts a represented platform and never probes Linux process-start ticks for Windows',
      'scripts/prepare-batch.js': 'runWorker snapshots one PID, passes its platform seam, and records the normalized identity PID everywhere',
    }),
    documentationOnly: Object.freeze([]),
  }),
});

const tests = [];
function test(name, body) { tests.push({ name, body }); }

test('C1 exact repair inventory is classified and present in the isolated tree', () => {
  const exactPaths = {
    '#130': ['DESIGN.md', 'docs/change-log.md', 'docs/control-plane.md',
      'runner/proposal-supervisor.js', 'scripts/proposal-supervisor.js'],
    '#131': ['DESIGN.md', 'docs/change-log.md', 'pipeline/entrypoint.sh', 'pipeline/envelope.js'],
    '#133': ['runner/lock.js', 'scripts/prepare-batch.js'],
  };
  for (const [pr, inventory] of Object.entries(REPAIRS)) {
    const classified = [...Object.keys(inventory.land),
      ...Object.keys(inventory.preserveFromCombinedLane || {}), ...inventory.documentationOnly];
    assert.deepStrictEqual([...new Set(classified)].sort(), exactPaths[pr].sort(),
      `${pr} must classify every touched path exactly once by purpose`);
    for (const file of [...Object.keys(inventory.land),
      ...Object.keys(inventory.preserveFromCombinedLane || {})]) {
      assert(fs.existsSync(path.join(ROOT, file)), `${pr} required product path is absent: ${file}`);
    }
  }

  const entrypoint = fs.readFileSync(path.join(ROOT, 'pipeline', 'entrypoint.sh'), 'utf8');
  const lockSource = fs.readFileSync(path.join(ROOT, 'runner', 'lock.js'), 'utf8');
  const prepareSource = fs.readFileSync(path.join(ROOT, 'scripts', 'prepare-batch.js'), 'utf8');
  assert(entrypoint.includes('PIPELINE_TESTING_NESTED_ENTRYPOINT'),
    '#131 explicit-command isolation is absent from its classified product path');
  assert(lockSource.includes('function livenessFields(pid = process.pid, opts = {})'),
    '#133 represented-platform liveness is absent from its classified product path');
  assert(prepareSource.includes("typeof seams.platform === 'string'"),
    '#133 preparation platform seam is absent from its classified product path');

  delete require.cache[require.resolve(path.join(ROOT, 'pipeline', 'envelope.js'))];
  const envelope = require(path.join(ROOT, 'pipeline', 'envelope.js'));
  const partial = [
    { type: 'turn.started' },
    { type: 'item.completed', item: { type: 'agent_message', text: 'partial-must-not-publish' } },
  ].map(JSON.stringify).join('\n');
  assert.strictEqual(envelope.parse(partial).result, '',
    '#131 compatibility must preserve the accepted combined lane fail-closed framed-stream behavior');
});

test('C2 unattended proposal supervisor composes the full conveyor', async () => {
  const cliPath = path.join(ROOT, 'scripts', 'proposal-supervisor.js');
  assert(fs.existsSync(cliPath), '#130 proposal supervisor CLI is absent');
  const cliSource = fs.readFileSync(cliPath, 'utf8');
  assert.match(cliSource, /require\(['"]\.\.\/runner\/proposal-supervisor['"]\)/,
    'proposal supervisor CLI must import the host runner');
  assert.match(cliSource,
    /\[\s*['"]run['"]\s*,\s*['"]resume['"]\s*,\s*['"]tick['"]\s*,\s*['"]stop['"]\s*,\s*['"]status['"]\s*\]/,
    'proposal supervisor CLI must expose run/resume/tick/stop/status');
  assert.match(cliSource, /await\s+supervisor\.run\s*\(\s*\)/,
    'the run command must await the long-lived unattended loop');
  assert.match(cliSource, /supervisor\.submit\(record\)/,
    'the run command must retain explicit durable proposal submission');
  delete require.cache[require.resolve(cliPath)];
  assert.strictEqual(typeof require(cliPath).main, 'function',
    'proposal supervisor CLI must export its host entry function');

  const proposalPath = path.join(ROOT, 'runner', 'proposal-supervisor.js');
  assert(fs.existsSync(proposalPath), '#130 proposal supervisor is absent');
  delete require.cache[require.resolve(proposalPath)];
  const { createProductionSupervisor, productionAdapters, TESTING_SENTINEL } = require(proposalPath);
  assert.strictEqual(typeof productionAdapters, 'function',
    'the supervisor must retain its production adapter composition surface');
  const productionSource = String(productionAdapters);
  for (const surface of ['specifyProposal.execute', 'createHostOperationManager',
    'supervisor.acquire', 'supervisor.grant', 'supervisor.settle', 'supervisor.release',
    'verdict.readRuns']) {
    assert(productionSource.includes(surface),
      `production adapters do not compose the required ${surface} controller`);
  }
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-djf-31-supervisor-'));
  const project = path.join(stateDir, 'project');
  const record = { id: 'kp-focused', target: project, hash: 'kickoff-hash' };
  const calls = [];
  const adapters = {
    kickoff: {
      verify: async (value) => value,
      list: async () => [],
    },
    specification: {
      execute: async () => ({ status: 'ready', issueId: 'issue-focused', model: 'stub-model',
        receipt: { specHash: 'spec-hash' } }),
    },
    authority: {
      grant: async (request) => {
        calls.push(`grant:${request.scope}`);
        return { authority: { nonce: `nonce-${request.scope}` },
          parentLease: { token: 'parent-token', target: project } };
      },
      settle: async (_grant, outcome) => { calls.push(`settle:${outcome}`); return { ok: true }; },
      release: async () => { calls.push('release'); return { ok: true }; },
    },
    operations: {
      startPreparation: async () => ({ ok: true, operation: { id: 'prep-operation' } }),
      startImplementation: async () => ({ ok: true,
        operation: { id: 'feed-operation', runId: 'run-focused' } }),
      status: async ({ id }) => id === 'prep-operation'
        ? { ok: true, state: 'completed', preparation: { freezeReceipt: 'freeze-focused' } }
        : { ok: true, state: 'completed', manifest: { tasks: [{ issueId: 'issue-focused',
          branch: 'task/focused', prUrl: 'https://example.invalid/pr/1', attempts: [{ verdict: 'pass' }] }],
        feed: { ending: 'complete' } } },
      stop: async () => ({ ok: true }),
    },
    review: {
      evidence: async ({ issueId, runId }) => ({ reviewItemId: 'review-focused', issueId, runId,
        verdict: 'pass' }),
    },
  };
  assert.strictEqual(typeof TESTING_SENTINEL, 'symbol',
    'deterministic adapter substitution requires an opaque host-process capability');
  for (const testingSentinel of [true, 'enabled', Symbol('copied-capability')]) {
    assert.throws(() => createProductionSupervisor({ project,
      stateDir: path.join(stateDir, `refused-${String(testingSentinel)}`), adapters, testingSentinel }),
    /capability/i, 'a manufactured adapter capability must be refused');
  }
  const savedCapability = process.env.PIPELINE_TESTING_SENTINEL;
  process.env.PIPELINE_TESTING_SENTINEL = 'enabled';
  try {
    assert.throws(() => createProductionSupervisor({ project,
      stateDir: path.join(stateDir, 'refused-environment'), adapters }), /capability/i,
    'configuration or environment text must not manufacture the adapter capability');
  } finally {
    if (savedCapability === undefined) delete process.env.PIPELINE_TESTING_SENTINEL;
    else process.env.PIPELINE_TESTING_SENTINEL = savedCapability;
  }
  const supervisor = createProductionSupervisor({ project, stateDir, adapters,
    testingSentinel: TESTING_SENTINEL, pollMs: 1,
    wait: () => new Promise((resolve) => setImmediate(resolve)) });
  for (const method of ['resume', 'run', 'status', 'stop', 'submit', 'tick']) {
    assert.strictEqual(typeof supervisor[method], 'function',
      `the durable repo-djf.18 lifecycle is missing ${method}`);
  }
  const accepted = await supervisor.submit(record);
  assert.deepStrictEqual(accepted, { accepted: true, id: record.id },
    'explicit submission must durably admit the proposal before unattended execution');
  const running = supervisor.run();
  try {
    let status;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      status = await supervisor.status(record.id);
      if (status.verdict === 'pass') break;
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert(status && status.verdict === 'pass', 'unattended loop did not reach review');
    assert.strictEqual(status.freezeReceipt, 'freeze-focused');
    assert.strictEqual(status.runId, 'run-focused');
    assert.strictEqual(status.branch, 'task/focused');
    assert(calls.includes('grant:preparation') && calls.includes('grant:implementation'));
  } finally {
    await supervisor.stop();
    await running;
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
  assert(calls.includes('release'), 'stop must settle and release parent authority');
});

test('C3 explicit-command fixture isolation is capability gated', () => {
  const source = fs.readFileSync(path.join(ROOT, 'pipeline', 'entrypoint.sh'), 'utf8');
  const command = 'AGENT_CMD="${PIPELINE_AGENT_CMD:-$AGENT_DEFAULT}"';
  const gate = 'if [ "${PIPELINE_TESTING_NESTED_ENTRYPOINT:-}" = "1" ] && [ -n "${PIPELINE_AGENT_CMD:-}" ]; then PIPELINE_CHATGPT_AUTH=""; fi';
  const commandAt = source.indexOf(command);
  const gateAt = source.indexOf(gate);
  const authAt = source.indexOf('persist_chatgpt_auth()');
  assert(commandAt >= 0 && gateAt > commandAt && authAt > gateAt,
    '#131 isolation must be after explicit command resolution and before any durable auth handling');
  assert.strictEqual(source.match(/PIPELINE_TESTING_NESTED_ENTRYPOINT/g).length, 1,
    'the test-only capability must have one narrow decision point');
});

test('C3 Codex summaries preserve framed and legacy final-message rules', () => {
  const { parse } = require(path.join(ROOT, 'pipeline', 'envelope.js'));
  const jsonl = (records) => records.map(JSON.stringify).join('\n');
  const legacy = parse(jsonl([
    { type: 'item.completed', item: { type: 'agent_message', text: 'legacy-old' } },
    { type: 'item.completed', item: { type: 'command_execution', text: 'never-summary' } },
    { type: 'item.completed', item: { type: 'agent_message', text: 'legacy-final' } },
  ]));
  assert.strictEqual(legacy.result, 'legacy-final',
    'unframed Codex JSONL must retain #131 final-agent-message compatibility');

  const framed = parse(jsonl([
    { type: 'turn.started', model: 'codex-focused' },
    { type: 'item.completed', item: { type: 'agent_message', text: 'framed-old' } },
    { type: 'item.completed', item: { type: 'agent_message', text: 'framed-final' } },
    { type: 'turn.completed' },
  ]));
  assert.strictEqual(framed.result, 'framed-final');
  assert.strictEqual(framed.model, 'codex-focused');

  const partial = parse(jsonl([
    { type: 'turn.started' },
    { type: 'item.completed', item: { type: 'agent_message', text: 'partial' } },
  ]));
  assert.strictEqual(partial.result, '', 'partial framed streams must fail closed');
});

test('C4 liveness fields honor the represented Windows platform', () => {
  const lock = require(path.join(ROOT, 'runner', 'lock.js'));
  const represented = lock.livenessFields(process.pid, { platform: 'win32' });
  assert.strictEqual(represented.pid, process.pid);
  assert.strictEqual(represented.platform, 'win32');
  assert.strictEqual(represented.procStart, null,
    'Windows identity must not contain Linux process-start ticks');
  const representedLinux = lock.livenessFields(process.pid, { platform: 'linux' });
  assert.strictEqual(representedLinux.platform, 'linux', 'platform override must be honored portably');
});

test('C4 preparation records one stable Windows worker identity', async () => {
  const lock = require(path.join(ROOT, 'runner', 'lock.js'));
  const prepare = require(path.join(ROOT, 'scripts', 'prepare-batch.js'));
  const originalLiveness = lock.livenessFields;
  const observed = { calls: [], started: null, uncertain: null };
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  let pidRead = 0;
  Object.defineProperty(child, 'pid', { get() { pidRead += 1; return 4100 + pidRead; } });
  child.stdin = { end() {
    setImmediate(() => {
      child.stdout.emit('data', Buffer.from(JSON.stringify({ ok: true, outcome: 'prepared' })));
      child.emit('close', 0);
    });
  } };
  lock.livenessFields = (pid, opts) => {
    observed.calls.push({ pid, opts });
    return { pid, platform: opts && opts.platform, host: 'focused', takenAtMs: 1,
      uptimeSeconds: 1, procStart: null };
  };
  const state = {
    createWorkerNonce: () => crypto.randomBytes(16).toString('hex'),
    writeWorkerStarted: (_root, _batch, _id, value) => { observed.started = value; },
    writeWorkerResult: () => {},
    appendEvent: () => {},
  };
  try {
    const result = await prepare.runWorker(ROOT, 'focused-batch',
      { id: 'issue-focused', action: 'acceptance', built: { cfg: {} } }, 'focused-config.json', state,
      { platform: 'win32', spawn: () => child, ownership: {},
        markPreparationUncertain: (_ownership, value) => { observed.uncertain = value; },
        clearPreparationUncertain: () => {} });
    assert.strictEqual(result.outcome, 'prepared');
    assert.deepStrictEqual(observed.calls, [{ pid: 4101, opts: { platform: 'win32' } }],
      'runWorker must snapshot the PID and pass the represented platform once');
    assert.strictEqual(pidRead, 1, 'child.pid must be sampled once');
    assert.strictEqual(observed.started.pid, 4101);
    assert.strictEqual(observed.started.process.pid, 4101);
    assert.strictEqual(observed.uncertain.pid, 4101);
  } finally {
    lock.livenessFields = originalLiveness;
  }
});

(async () => {
  let failed = 0;
  for (const item of tests) {
    try {
      await item.body();
      console.log(`[test] PASS ${item.name}`);
    } catch (error) {
      failed += 1;
      console.error(`[test] FAIL ${item.name}: ${error.message}`);
    }
  }
  if (failed) {
    console.error(`[test] FAIL ${failed}/${tests.length} focused checks`);
    process.exitCode = 1;
  } else {
    console.log(`[test] PASS ${tests.length}/${tests.length} focused checks`);
  }
})().catch((error) => {
  console.error(`[test] FAIL harness: ${error.stack || error.message}`);
  process.exitCode = 1;
});
