'use strict';

// Shared disposable integration world. This contains no conveyor state machine and writes
// no supervisor journal events. Real CLI parsing, specification receipts, preparation
// records, authority grants/admission/settlement, operation metadata, publication admission
// and report manifests produce all successful state. Only model, Beads and child execution
// are substituted. Fixture freeze receipts use the repository's dedicated fixture producer.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { EventEmitter } = require('events');
const ROOT = path.resolve(__dirname, '../../..');
const P = require(path.join(ROOT, 'runner/proposal-supervisor'));
const CLI = require(path.join(ROOT, 'scripts/proposal-supervisor'));
const SPEC = require(path.join(ROOT, 'scripts/specify-proposal'));
const KICKOFF = require(path.join(ROOT, 'scripts/kickoff'));
const AUTH = require(path.join(ROOT, 'runner/supervisor'));
const LOCK = require(path.join(ROOT, 'runner/lock'));
const PREP = require(path.join(ROOT, 'runner/preparation-state'));
const REPORT = require(path.join(ROOT, 'runner/report'));
const { createHostOperationManager } = require(path.join(ROOT, 'runner/operation-manager'));
const { writeFixtureReceipt } = require(path.join(ROOT, 'scripts/write-fixture-receipt'));

function git(dir, ...args) {
  const result = cp.spawnSync('git', ['-c', 'safe.directory=*', ...args], {
    cwd: dir, encoding: 'utf8', timeout: 15000, windowsHide: true,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: path.join(path.dirname(dir), 'unused-global-git-config'),
      GIT_TERMINAL_PROMPT: '0' },
  });
  assert.strictEqual(result.status, 0, `fixture git ${args[0]}: ${result.stderr || result.error}`);
  return result.stdout.trim();
}
function json(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function createWorld(tag, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `conveyor62-${tag}-`));
  const target = path.join(root, 'target');
  const runsRoot = path.join(root, 'runs');
  const preparationRoot = path.join(root, 'preparation');
  const envNames = ['PIPELINE_STATE_DIR', 'PIPELINE_GLOBAL_LOCK_DIR', 'PREPARATION_RUNS_DIR',
    'PIPELINE_CHILD_AUTHORITY', 'VERDICT_RUNS_DIR', 'CODEX_API_KEY', 'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'PIPELINE_BD_CMD',
    'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM',
    'GIT_CONFIG_NOSYSTEM', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE',
    'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'NODE_OPTIONS', 'NODE_TEST_CONTEXT',
    ...Object.keys(process.env).filter(name => /^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(name))];
  const saved = Object.fromEntries(envNames.map(name => [name, process.env[name]]));
  for (const name of envNames) delete process.env[name];
  process.env.PIPELINE_STATE_DIR = path.join(root, 'state');
  process.env.PIPELINE_GLOBAL_LOCK_DIR = path.join(root, 'locks');
  process.env.PREPARATION_RUNS_DIR = preparationRoot;
  process.env.VERDICT_RUNS_DIR = runsRoot;
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  process.env.GIT_CONFIG_GLOBAL = path.join(root, 'unused-global-git-config');
  process.env.GIT_CONFIG_SYSTEM = path.join(root, 'unused-system-git-config');
  fs.mkdirSync(target, { recursive: true });
  fs.mkdirSync(runsRoot, { recursive: true });
  git(target, 'init', '-q', '-b', 'main');
  git(target, 'config', 'user.email', 'acceptance@example.invalid');
  git(target, 'config', 'user.name', 'conveyor lifecycle fixture');
  git(target, 'config', 'core.autocrlf', 'false');
  git(target, 'remote', 'add', 'origin', target);
  json(path.join(target, 'pipeline.config.json'), {
    defaultBranch: 'main', verifyCommand: 'node -e "process.exit(0)"', frozenPaths: [],
  });
  fs.writeFileSync(path.join(target, 'DESIGN.md'), '# Lifecycle fixture\n');
  git(target, 'add', '.'); git(target, 'commit', '-qm', 'disposable integration fixture');
  const configPath = path.join(root, 'run.config.json');
  json(configPath, { targetRepoPath: target, targetRepoRemote: target,
    image: 'never-launched:fixture', codexAuth: 'chatgpt', feed: true,
    gitTimeoutMs: 15000, bdTimeoutMs: 1000, wallClockMinutes: 1 });
  const stateDir = P.supervisorStateDirFor(target);
  const children = [];
  const settlements = [];
  const issues = new Map();
  const opened = [];
  let supervisor = null;
  let manager = null;
  let restoring = false;

  function publishFixtureSuite(issueId) {
    const suite = path.join(target, 'tests/acceptance', issueId);
    if (fs.existsSync(suite)) return;
    fs.mkdirSync(suite, { recursive: true });
    fs.writeFileSync(path.join(suite, 'test.js'), 'process.exit(0);\n');
    writeFixtureReceipt(target, issueId);
    git(target, 'add', '.'); git(target, 'commit', '-qm', `fixture acceptance ${issueId}`);
  }

  // Keep the production specification.execute adapter: substitution is at the actual
  // model/Beads calls beneath it, so successful receipts are produced and re-read normally.
  const originalSpecFactory = SPEC.productionAdapters;
  SPEC.productionAdapters = function(opts, deps) {
    const adapters = originalSpecFactory(opts, deps);
    adapters.launchCodex = async () => JSON.stringify({
      spec: 'Implement the disposable lifecycle fixture.',
      acceptanceCriteria: ['The exact implementation result is visible to its operator.'],
      designReferences: ['DESIGN.md#lifecycle-fixture'], difficulty: 'medium', status: 'ready',
    });
    adapters.beadsFind = async externalRef => issues.get(typeof externalRef === 'string'
      ? externalRef : externalRef.externalRef) || null;
    adapters.beadsCreate = async request => {
      const id = `fixture-${require('crypto').createHash('sha256').update(request.externalRef).digest('hex').slice(0, 12)}`;
      assert(!issues.has(request.externalRef), 'duplicate external Beads issue creation');
      const issue = { id };
      issues.set(request.externalRef, issue);
      publishFixtureSuite(id);
      return issue;
    };
    if (options.specificationAdapters) options.specificationAdapters(adapters, opts);
    return adapters;
  };

  function spawn(_executable, argv, spawnOptions) {
    // The external child boundary supplies a deterministic process object; it redeems the
    // actual host grant and writes through the actual artifact producers, never the consumer.
    const child = new EventEmitter(); child.pid = process.pid;
    const authority = JSON.parse(fs.readFileSync(spawnOptions.env.PIPELINE_CHILD_AUTHORITY, 'utf8'));
    const kind = spawnOptions.env.RUN_ID ? 'implementation' : 'preparation';
    const admitted = AUTH.admit(authority, { targetRepoPath: target, scope: kind });
    assert.strictEqual(admitted.ok, true, JSON.stringify(admitted));
    const row = { child, kind, argv, env: spawnOptions.env, authority, ended: false,
      runId: spawnOptions.env.RUN_ID || null };
    children.push(row);
    if (kind === 'preparation') {
      const batch = argv[2];
      const ids = argv.flatMap((arg, index) => arg === '--issue' ? [argv[index + 1]] : []);
      PREP.createManifest(preparationRoot, batch, { project: target, runConfig: configPath,
        issues: ids.map(id => ({ id })), config: {} });
      for (const issueId of ids) {
        const started = PREP.writeWorkerStarted(preparationRoot, batch, issueId,
          { phase: 'proof', pid: process.pid, process: LOCK.livenessFields() });
        PREP.writeWorkerResult(preparationRoot, batch, issueId,
          { nonce: started.nonce, outcome: 'proven-at-base', exitCode: 0 });
      }
      queueMicrotask(() => { row.ended = true; child.emit('exit', 0, null); });
    } else {
      fs.mkdirSync(path.join(runsRoot, row.runId), { recursive: true });
    }
    return child;
  }

  function adaptersFor(lease) {
    const adapters = P.productionAdapters(ROOT, { configPath, lease, runsRoot,
      operationStateRoot: path.join(stateDir, 'operations') });
    const authority = { ...AUTH, settle(...args) {
      settlements.push({ owner: 'operation-manager', nonce: args[1] });
      return AUTH.settle(...args);
    } };
    const realSettle = adapters.authority.settle;
    adapters.authority.settle = (...args) => {
      settlements.push({ owner: 'proposal-supervisor', nonce: args[0]?.authority?.nonce });
      return realSettle(...args);
    };
    manager = createHostOperationManager({ pipelineRoot: ROOT, runsRoot, preparationRoot,
      stateRoot: path.join(stateDir, 'operations'), spawn, supervisor: authority,
      lifecycleTimeoutMs: 10000 });
    adapters.operations = manager;
    return adapters;
  }

  function open(common = {}) {
    // Observe real acquisition only to configure external execution with its exact lease.
    // The actual operator owner decides admission/reclaim and performs its own close.
    const configured = {};
    const acquire = AUTH.acquire;
    AUTH.acquire = (...args) => {
      const acquired = acquire(...args);
      if (acquired.ok) Object.assign(configured, adaptersFor(acquired.lease));
      return acquired;
    };
    try {
      const owned = P.openProjectSupervisor({ ...common, repoRoot: root, project: target,
        configPath, stateDir, runsRoot, supervisorId: `fixture-${tag}-${opened.length + 1}`,
        adapters: configured, testingSentinel: P.TESTING_SENTINEL });
      if (owned.ok) { opened.push(owned); supervisor = owned.supervisor; }
      return owned;
    } finally { AUTH.acquire = acquire; }
  }

  function reconstruct() {
    const active = opened.at(-1);
    supervisor = P.createProductionSupervisor({ repoRoot: root, project: target, configPath,
      stateDir, runsRoot, lease: active?.lease, adapters: adaptersFor(active?.lease),
      testingSentinel: P.TESTING_SENTINEL });
    return supervisor;
  }
  async function kickoff(title = tag) {
    const packet = path.join(root, `packet-${require('crypto').randomBytes(4).toString('hex')}.json`);
    json(packet, { version: 'kickoff-intake/1', title });
    assert.strictEqual(KICKOFF.main(['submit', '--config', configPath, '--packet', packet]), 0);
    return KICKOFF.readAll(KICKOFF.statePathsFor(target)).find(row => row.packet.title === title);
  }
  async function command(name, extra = []) {
    let output = '';
    const result = await CLI.main([name, '--config', configPath, ...extra],
      { out: text => { output += text; } }, {
        checkSpecificationAuth: () => ({ ok: true }),
        openProjectSupervisor: common => open(common),
        createProductionSupervisor: () => reconstruct(),
      });
    return { result, output };
  }
  function events() {
    const file = path.join(stateDir, 'events.jsonl');
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  }
  const feed = () => [...children].reverse().find(row => row.kind === 'implementation');
  function writeFeed(tasks, manifest = {}, row = feed()) {
    assert(row, 'fixture needs a launched implementation feed');
    return REPORT.writeManifest(path.join(runsRoot, row.runId), {
      runId: row.runId, targetRepo: target, startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(), tasks, ...manifest,
    }).manifest;
  }
  function completeFeed(tasks, manifest = {}, row = feed()) {
    writeFeed(tasks, manifest, row);
    if (!row.ended) { row.ended = true; row.child.emit('exit', 0, null); }
    return row;
  }
  async function until(predicate, label, max = 12) {
    for (let i = 0; i < max; i += 1) {
      if (await predicate()) return;
      await supervisor.tick();
    }
    throw new Error(`fixture setup failed to reach ${label}: ${JSON.stringify(await supervisor.status())}`);
  }
  async function ready(title = tag) {
    const record = await kickoff(title);
    if (!supervisor) { const owned = open(); assert(owned.ok, JSON.stringify(owned)); }
    await until(async () => (await supervisor.status(record.id)).stage === 'implementing', 'implementing');
    return { record, ...(await supervisor.status(record.id)) };
  }
  async function dispose() {
    if (restoring) return; restoring = true;
    // Cleanup only owns this mkdtemp tree and the test's process standins. No live worker is
    // killed, and no host authority outside the redirected lock root is touched.
    SPEC.productionAdapters = originalSpecFactory;
    for (const child of children) if (!child.ended) { child.ended = true; child.child.emit('exit', 0, null); }
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
  return { root, target, configPath, runsRoot, preparationRoot, stateDir, children,
    settlements, issues, publishFixtureSuite, open, reconstruct, kickoff, command, events,
    feed, writeFeed, completeFeed, ready, until, dispose,
    get supervisor() { return supervisor; }, get manager() { return manager; },
    get currentOwner() { return opened.at(-1); } };
}

module.exports = { createWorld, ROOT, P, CLI, SPEC, AUTH, LOCK, REPORT, json, delay };
