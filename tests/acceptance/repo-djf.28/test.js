// Frozen acceptance test — repo-djf.28: one lane-safe, summary-safe replacement.
// PAIRING (criterion -> tests): C1 -> G7,T1; C2 -> G1,T2,T3,T4,T5,T6;
// C3 -> G2,T2,T3,T4,T5,T6; C4 -> G3,G4,G5,T7,T8,T9;
// C5 -> G1,G2,G6,G7,G8,T1,T2,T3,T4,T5,T6,T7,T8,T9,T10.
// PAIRING (test -> criterion): T1 -> C1,C5; T2,T3,T4 -> C2,C3,C5;
// T5,T6 -> C2,C3,C5; T7,T8,T9 -> C4,C5; T10 -> C5.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..', '..');
const RUN_FILE = path.join(REPO, 'runner', 'run.js');
const STATUS_JS = path.join(REPO, 'pipeline', 'status.js');
const EVENT_SCHEMA = JSON.parse(fs.readFileSync(path.join(REPO, 'schemas', 'events.schema.json'), 'utf8'));
const { resolveHostShell } = require(path.join(REPO, 'runner', 'host-shell.js'));
const LANE_SUITES = ['repo-djf.22', 'repo-djf.23', 'repo-djf.24'];
const PROVIDER_ENV = [
  'CODEX_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CODEX_HOME',
];
const FINAL = 'Implemented deterministic Codex summary extraction. Publication now carries only this concise result.';
const NOISE = {
  chatter: 'CODEX-CLI-CHATTER-djf28',
  tailChatter: 'Codex session finished successfully.',
  command: 'COMMAND-EVENT-djf28',
  path: 'C:/private/customer/djf28-secrets.txt',
  usage: 987654321,
  interim: 'INTERMEDIATE-AGENT-MESSAGE-djf28',
  sensitive: 'sk-djf28-sensitive-field-never-publish',
};
let failed = 0;

function check(name, yes, detail = '') {
  console.log(`${yes ? 'ok' : 'FAIL'} - ${name}${yes || !detail ? '' : ` — ${detail}`}`);
  if (!yes) failed = 1;
}
function scrubbedEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const key of PROVIDER_ENV) delete env[key];
  return env;
}
function failureNames(output) {
  return String(output || '').split(/\r?\n/)
    .filter((line) => /^(?:FAIL|not ok)\b/i.test(line))
    .map((line) => line.replace(/\s+—.*$/, '').slice(0, 180));
}
function read(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}
function parseJson(file) {
  try { return JSON.parse(read(file)); } catch { return null; }
}
function runFrozenUnion() {
  const runs = [];
  const hostShell = resolveHostShell();
  for (let round = 1; round <= 2; round += 1) {
    for (const suite of LANE_SUITES) {
      const rel = `tests/acceptance/${suite}/`;
      const result = hostShell.ok ? spawnSync(hostShell.command, ['tools/run-acceptance.sh', rel], {
        cwd: REPO, encoding: 'utf8', windowsHide: true, timeout: 120000,
        maxBuffer: 64 * 1024 * 1024, env: scrubbedEnv(),
      }) : { status: null, stdout: '', stderr: '', error: new Error(hostShell.reason) };
      runs.push({ round, suite, status: result.status, signal: result.signal,
        error: result.error && result.error.message,
        failures: failureNames(`${result.stdout || ''}\n${result.stderr || ''}`) });
    }
  }
  return runs;
}

// Stringified into a child preload. The real runner entry point remains in charge; only
// host boundaries are deterministic recorders, so this proof needs no Docker, Beads, Git,
// GitHub, network, provider key, or OAuth authority.
function fixturePreload() {
  'use strict';
  const fs = require('fs');
  const path = require('path');
  const repo = path.resolve(path.dirname(process.argv[1]), '..');
  const root = process.env.DJF28_FIXTURE_ROOT;
  const eventsFile = path.join(root, 'events.jsonl');
  const manifestFile = path.join(root, 'manifest.json');
  const mode = process.env.DJF28_FAILURE_MODE;
  const secret = process.env.DJF28_SECRET;
  let sequence = 0;
  let sharedReleased = false;
  let healthySettled = false;
  let networkOwned = false;
  let lockOwned = false;
  const containers = new Set();
  const workspaces = new Set();
  const handoffs = new Set();
  const event = (ev, data = {}) => {
    fs.appendFileSync(eventsFile, `${JSON.stringify({ sequence: sequence += 1, ev, ...data })}\n`);
  };
  const mutation = (ev, issueId, data = {}) => event(ev, {
    ...(issueId ? { issueId } : {}), afterRelease: sharedReleased, ...data,
  });
  const removeTree = (target) => { try { fs.rmSync(target, { recursive: true, force: true }); } catch {} };
  const workspace = (id) => {
    const dir = path.join(root, `workspace-${id}`);
    fs.mkdirSync(path.join(dir, '.run'), { recursive: true });
    workspaces.add(dir);
    return dir;
  };
  const taskDir = (id) => {
    const dir = path.join(root, 'run-artifacts', 'tasks', id);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };
  const laneRoot = path.join(root, 'credential-lane');
  fs.mkdirSync(laneRoot, { recursive: true });
  fs.writeFileSync(path.join(laneRoot, 'auth.json'), JSON.stringify({
    auth_mode: 'chatgpt', tokens: { refresh_token: secret },
  }));
  const failure = (kind) => {
    const error = new Error(`${kind} credential lane failure`);
    error.code = `DJF28_${kind.toUpperCase().replace(/-/g, '_')}`;
    error.credentialEvidence = { refreshToken: secret };
    return error;
  };
  const makeHandle = (id) => {
    const hostPath = path.join(laneRoot, 'tasks', id);
    fs.mkdirSync(hostPath, { recursive: true });
    fs.copyFileSync(path.join(laneRoot, 'auth.json'), path.join(hostPath, 'auth.json'));
    handoffs.add(hostPath);
    mutation('credential.stage', id);
    return { hostPath, cacheRoot: laneRoot, containerPath: '/root/.codex', issueId: id };
  };
  const releaseHandle = async (handle) => {
    if (handle.issueId === 'bad' && mode === 'refresh') {
      mutation('credential.refresh.reject', handle.issueId);
      throw failure('refresh-persistence');
    }
    mutation('credential.refresh.persist', handle.issueId);
    removeTree(handle.hostPath);
    handoffs.delete(handle.hostPath);
  };
  const launchWorker = async (_cfg, options) => {
    const id = options.issueId;
    containers.add(id);
    mutation('container.launch', id);
    try {
      if (id === 'bad' && mode === 'launch') throw failure('worker-launch');
      await new Promise((resolve) => setTimeout(resolve, id === 'healthy' ? 140 : 10));
      return { exitCode: id === 'healthy' ? 0 : 1, durationMs: id === 'healthy' ? 140 : 10 };
    } finally {
      containers.delete(id);
      if (id === 'healthy') healthySettled = true;
      mutation('container.settled', id);
    }
  };
  function createPool() {
    return {
      async run(job, worker) {
        if (job.id === 'bad' && mode === 'staging') {
          mutation('credential.stage.reject', job.id);
          throw failure('staging');
        }
        const handle = makeHandle(job.id);
        let value;
        try { value = await worker({ laneId: `lane-${job.id}`, cacheRoot: laneRoot, authCache: handle }); }
        catch (error) {
          await releaseHandle(handle);
          throw error;
        }
        await releaseHandle(handle);
        return value;
      },
      snapshot() {
        return { healthyLaneCount: 1, quarantined: mode === 'refresh' ? [{ id: 'lane-bad' }] : [],
          retained: [...handoffs] };
      },
    };
  }
  const cfg = {
    configPath: 'fixture', provider: 'codex', codexAuth: 'chatgpt',
    codexAuthCacheRoot: laneRoot,
    codexAuthLanes: [{ id: 'lane-a', cacheRoot: laneRoot, healthy: true },
      { id: 'lane-b', cacheRoot: `${laneRoot}-sibling`, healthy: true }],
    targetRepoPath: path.join(root, 'target'), targetRepoRemote: 'https://example.invalid/target.git',
    image: 'fixture:image', concurrency: 2, wallClockMinutes: 1,
    feedIdleGraceMinutes: 0, feedPollSeconds: 1, allowHalfProven: false,
  };
  cfg.codexLanePool = createPool();
  const runId = 'accept-djf28-run';
  const issueIdOf = (trace) => typeof trace === 'string' && trace.startsWith(`${runId}/`)
    ? trace.slice(runId.length + 1) : null;
  const logLine = (level, trace, message, meta) => {
    const ledger = {
      ts: new Date(1000 + sequence * 1000).toISOString(), level, runId,
      issueId: issueIdOf(trace), trace: trace || null,
      event: meta && meta.event ? meta.event : 'log', msg: String(message),
      data: meta && meta.data ? meta.data : {},
    };
    event(level === 'ERROR' ? 'log.error' : 'log.info', {
      trace, message: String(message), meta, ledger,
    });
  };
  const log = {
    runId, dir: path.join(root, 'run-artifacts'),
    trace(id) { return `${runId}/${id}`; },
    taskDir,
    info(trace, message, meta) { logLine('INFO', trace, message, meta); },
    error(trace, message, meta) { logLine('ERROR', trace, message, meta); },
    event(trace, name, data) { event('log.event', { trace, name, data }); },
  };
  fs.mkdirSync(log.dir, { recursive: true });
  const stub = (rel, exports) => {
    const file = require.resolve(path.join(repo, rel));
    require.cache[file] = { id: file, filename: file, loaded: true, exports };
  };
  stub('runner/config.js', {
    loadConfig() { return cfg; }, loadProviderCredential() { return null; },
    missingCredentialDiagnostic() { return 'fixture credential missing'; },
  });
  stub('runner/agent-provider.js', {
    providerFor() { return 'codex'; }, credentialNameFor() { return 'CODEX_API_KEY'; },
  });
  stub('runner/log.js', { startRun() { return log; } });
  stub('runner/preflight.js', {
    async preflight() {
      networkOwned = true; lockOwned = true;
      mutation('network.up'); mutation('lock.acquire');
      return { ok: true, recovered: [], ownership: { token: 'fixture-owner' }, lockOwned: true };
    },
    networkDown() { mutation('network.down'); networkOwned = false; return { ok: true }; },
  });
  stub('runner/lock.js', {
    release() {
      event('lock.release', { afterRelease: sharedReleased });
      lockOwned = false; sharedReleased = true;
    },
  });
  stub('runner/queue.js', {
    readyQueue() { return { ok: true, issues: [
      { id: 'bad', title: `${mode} lane failure`, priority: 0 },
      { id: 'healthy', title: 'healthy sibling', priority: 1 },
    ], undispatchable: [] }; },
    claim(_cfg, id) { mutation('beads.claim', id); return true; },
    exportIssue(_cfg, id) { mutation('beads.export', id); return { ok: true, markdown: `# ${id}` }; },
    finish(_cfg, id, outcome, notes) {
      mutation('beads.finish', id, { outcome, notes });
      return { ok: true, transition: outcome && outcome.beads || null };
    },
    outcomeFor(exitCode) {
      return exitCode === 0 ? { status: 'done', beads: 'closed' }
        : { status: 'failed', beads: 'blocked' };
    },
    attemptNotes(run, outcome) { return [`run ${run}: outcome ${outcome.status}`]; },
    undispatchableRow() { return null; }, logQueueRead() { event('queue.read'); },
    logUndispatched() {}, queueExitCode() { return 0; },
  });
  stub('runner/workspace.js', {
    prepare(_cfg, id) { mutation('git.workspace.prepare', id); return {
      ok: true, dir: workspace(id), forkPoint: 'fixture-base', branch: `task/${id}`, memoryCount: 0,
    }; },
    collectArtifacts(_dir, _taskDir, id) {
      mutation('verifier.complete', id);
      return { status: { issueId: id, attempts: [{ number: 1, verifierResult: id === 'healthy' ? 'pass' : 'fail' }],
        changeSummary: `${id} summary` },
      verify: id === 'healthy' ? { issueId: id, acceptance: 'pass', regressions: 'pass' } : null,
      contracts: { status: { ok: true }, verify: { ok: true } } };
    },
    hasCommits(dir) {
      const id = path.basename(dir).replace('workspace-', '');
      mutation('git.inspect', id); return true;
    },
    discard(dir) {
      const id = path.basename(dir).replace('workspace-', '');
      mutation('git.workspace.discard', id); removeTree(dir); workspaces.delete(dir);
    },
  });
  stub('runner/container.js', { runTask: launchWorker });
  stub('runner/codex-auth.js', {
    createLanePool: createPool,
    async stageTaskCache(options) {
      if (options.taskId === 'bad' && mode === 'staging') {
        mutation('credential.stage.reject', options.taskId); throw failure('staging');
      }
      return makeHandle(options.taskId);
    },
    releaseTaskCache: releaseHandle,
  });
  stub('runner/pause.js', { createPauseGate() { return {
    waits: 0, cycles: 0, exhausted: false,
    async admit() { return true; }, async reportLimit() { return { resumed: false, reason: 'unused' }; },
  }; } });
  stub('runner/feed.js', {
    ENDINGS: { DRAINED: 'drained' },
    createFeedSource(issues) {
      let index = 0;
      return { fed: false, async next() {
        if (index >= issues.length) return null;
        const item = { issue: issues[index], index }; index += 1; return item;
      }, undispatchable() { return []; }, polls() { return 0; }, ending() { return 'drained'; } };
    },
    fixedSource() { throw new Error('main fixture unexpectedly requested fixedSource'); },
  });
  stub('runner/memory.js', { shouldFileMemory() { return false; }, fileMemoryNotes() { return { filed: 0, errors: [] }; } });
  stub('runner/supervisor.js', { withSection(_authority, _section, fn) { return fn(); } });
  stub('runner/publish.js', { publish(_cfg, options) {
    mutation('git.push', options.issue.id); mutation('github.publish', options.issue.id);
    return { ok: true, pushed: true, branch: options.ws.branch,
      prUrl: `https://example.invalid/pr/${options.issue.id}` };
  } });
  stub('runner/artifact-schema.js', { successfulArtifactFailure() { return null; } });
  stub('runner/host-shell.js', { commandFor() { return 'bash'; } });
  stub('runner/process.js', {
    runSync() { mutation('git.diff.inspect'); return { status: 0, stdout: '', stderr: '' }; },
    timeoutFor() { return 1000; },
  });
  stub('runner/report.js', {
    writeManifest(_dir, manifest) {
      event('manifest.write', { manifest, healthySettled });
      fs.writeFileSync(manifestFile, JSON.stringify(manifest));
      return { file: manifestFile, manifest };
    },
    writeReport() { event('report.write', { healthySettled }); return path.join(root, 'report.md'); },
  });
  stub('scripts/write-protection-policy.js', {
    admit() { return { admit: true, refusals: [], target: cfg.targetRepoPath }; }, admissionRefusal() { return []; },
  });
  process.on('exit', (code) => event('process.exit', {
    code, healthySettled, networkOwned, lockOwned,
    containers: [...containers], workspaces: [...workspaces], handoffs: [...handoffs],
  }));
}

const roots = [];
function readEvents(root) {
  const file = path.join(root, 'events.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}
function fixtureChild(mode) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `accept-djf28-main-${mode}-`));
  roots.push(root);
  const preload = path.join(root, 'preload.js');
  fs.writeFileSync(preload, `(${fixturePreload.toString()})();\n`);
  const secret = `djf28-main-${mode}-credential-bytes`;
  const env = scrubbedEnv({
    DJF28_FIXTURE_ROOT: root,
    DJF28_FAILURE_MODE: mode,
    DJF28_SECRET: secret,
    NODE_OPTIONS: `--require "${preload.split(path.sep).join('/')}"`,
  });
  // scrubbedEnv removes provider variables after merging the fixture-only additions.
  const result = spawnSync(process.execPath, [RUN_FILE, '--config', 'fixture'], {
    cwd: REPO, encoding: 'utf8', windowsHide: true, timeout: 5000,
    maxBuffer: 16 * 1024 * 1024, env,
  });
  let manifest = null;
  try { manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')); } catch {}
  return { root, mode, secret, result, events: readEvents(root), manifest,
    providerEnvPresent: PROVIDER_ENV.filter((key) => Object.prototype.hasOwnProperty.call(env, key)) };
}
function eventIndex(run, name, issueId) {
  return run.events.findIndex((item) => item.ev === name && (!issueId || item.issueId === issueId));
}
function eventList(run, name, issueId) {
  return run.events.filter((item) => item.ev === name && (!issueId || item.issueId === issueId));
}
function row(run, id) {
  return run.manifest && Array.isArray(run.manifest.tasks)
    ? run.manifest.tasks.find((item) => item && item.issueId === id) : null;
}
function safe(run) {
  const exposed = `${run.result.stdout || ''}\n${run.result.stderr || ''}\n${JSON.stringify(run.events)}\n${JSON.stringify(run.manifest)}`;
  return !exposed.includes(run.secret);
}
function taskFinishedRecords(run, id) {
  return run.events.filter((item) => (item.ev === 'log.info' || item.ev === 'log.error')
    && item.ledger && item.ledger.issueId === id && item.ledger.event === 'task.finished');
}
function validTaskFinished(ledger) {
  const envelopeKeys = ['data', 'event', 'issueId', 'level', 'msg', 'runId', 'trace', 'ts'];
  const def = EVENT_SCHEMA.$defs && EVENT_SCHEMA.$defs.events
    && EVENT_SCHEMA.$defs.events['task.finished'];
  const dataKeys = ['beads', 'exitCode', 'outcome'];
  const exit = ledger && ledger.data && ledger.data.exitCode;
  return !!ledger && !!def
    && JSON.stringify(Object.keys(ledger).sort()) === JSON.stringify(envelopeKeys)
    && EVENT_SCHEMA.properties.event.enum.includes(ledger.event)
    && ledger.event === 'task.finished'
    && EVENT_SCHEMA.properties.level.enum.includes(ledger.level)
    && typeof ledger.ts === 'string' && Number.isFinite(Date.parse(ledger.ts))
    && typeof ledger.runId === 'string' && typeof ledger.issueId === 'string'
    && typeof ledger.trace === 'string' && typeof ledger.msg === 'string'
    && ledger.msg.startsWith('task finished:')
    && JSON.stringify(Object.keys(ledger.data).sort()) === JSON.stringify(dataKeys)
    && def.required.every((key) => Object.prototype.hasOwnProperty.call(ledger.data, key))
    && (Number.isInteger(exit) || exit === null || exit === 'killed')
    && ledger.data.outcome === 'failed'
    && (typeof ledger.data.beads === 'string' || ledger.data.beads === null);
}
function boundaryProof(run) {
  const bad = row(run, 'bad');
  const healthy = row(run, 'healthy');
  const finished = taskFinishedRecords(run, 'bad');
  const badFinish = eventList(run, 'beads.finish', 'bad');
  return {
    yes: run.result.status !== 3 && !run.result.signal && !run.result.error
      && run.providerEnvPresent.length === 0
      && !!run.manifest && Array.isArray(run.manifest.tasks) && run.manifest.tasks.length === 2
      && !!bad && bad.outcome === 'failed' && typeof bad.error === 'string'
      && !!healthy && healthy.outcome === 'done'
      && badFinish.length === 1 && badFinish[0].outcome
      && badFinish[0].outcome.status === 'failed'
      && finished.length === 1 && validTaskFinished(finished[0].ledger)
      && safe(run),
    detail: {
      status: run.result.status, signal: run.result.signal,
      error: run.result.error && run.result.error.message,
      stderr: String(run.result.stderr || '').slice(-500),
      manifest: run.manifest, badFinish: badFinish.map((item) => item.outcome),
      finished: finished.map((item) => item.ledger), safe: safe(run),
      providerEnvPresent: run.providerEnvPresent,
    },
  };
}
function runStatus(runDir, ...args) {
  return spawnSync(process.execPath, [STATUS_JS, ...args], {
    cwd: REPO, encoding: 'utf8', env: scrubbedEnv({ RUN_DIR: runDir }),
  });
}
function section(text, start, end) {
  const a = String(text).indexOf(start);
  const b = a < 0 ? -1 : String(text).indexOf(end, a + start.length);
  return a >= 0 && b >= 0 ? String(text).slice(a + start.length, b).trim() : null;
}
function publication(status) {
  const report = require(path.join(REPO, 'runner', 'report.js'));
  const publish = require(path.join(REPO, 'runner', 'publish.js'));
  const manifest = {
    runId: 'accept-djf28-publication',
    startedAt: '2026-09-13T12:00:00.000Z',
    finishedAt: '2026-09-13T12:00:01.000Z',
    targetRepo: 'fixture/repo',
    tasks: [{
      issueId: 'repo-djf.28', title: 'Codex summary fixture', outcome: 'done',
      branch: 'task/repo-djf.28', pushed: true, attempts: 1, diffLines: 4,
      changeSummary: status.changeSummary,
      verification: { acceptance: 'pass', regressions: 'pass', evidence: 'focused fixture' },
    }],
  };
  const prInput = {
    issueMarkdown: '# Fixture spec', status,
    verify: { acceptance: 'pass', regressions: 'pass' },
    outcome: { status: 'done' }, branch: 'task/repo-djf.28', runId: manifest.runId,
  };
  return {
    manifest, prInput,
    reportA: report.renderReport(manifest), reportB: report.renderReport(manifest),
    bodyA: publish.buildPrBody(prInput), bodyB: publish.buildPrBody(prInput),
  };
}

async function main() {
  try {
    const unionRuns = runFrozenUnion();
    check('T1 C1/C5 the complete repo-djf.22, repo-djf.23, and repo-djf.24 lane contracts pass twice on the exact no-key candidate',
      [1, 2].every((round) => LANE_SUITES.every((suite) => unionRuns
        .some((item) => item.round === round && item.suite === suite)))
        && unionRuns.every((item) => item.status === 0 && !item.signal && !item.error),
      JSON.stringify({ platform: process.platform, runs: unionRuns }));

    const scenarios = {};
    for (const mode of ['staging', 'launch', 'refresh']) scenarios[mode] = fixtureChild(mode);
    const staging = boundaryProof(scenarios.staging);
    check('T2 C2/C3/C5 a staging rejection becomes one failed row and one canonical schema-valid task.finished event while its healthy sibling completes',
      staging.yes, JSON.stringify(staging.detail));
    const launch = boundaryProof(scenarios.launch);
    check('T3 C2/C3/C5 a worker-launch rejection becomes one failed row and one canonical schema-valid task.finished event while its healthy sibling completes',
      launch.yes, JSON.stringify(launch.detail));
    const refresh = boundaryProof(scenarios.refresh);
    check('T4 C2/C3/C5 a refresh-persistence rejection becomes one failed row and one canonical schema-valid task.finished event while its healthy sibling completes',
      refresh.yes, JSON.stringify(refresh.detail));

    const mains = Object.values(scenarios);
    const lifecycle = mains.map((run) => {
      const healthySettled = eventIndex(run, 'container.settled', 'healthy');
      const verifier = eventIndex(run, 'verifier.complete', 'healthy');
      const publish = eventIndex(run, 'github.publish', 'healthy');
      const beads = eventIndex(run, 'beads.finish', 'healthy');
      const report = eventIndex(run, 'report.write');
      const down = eventIndex(run, 'network.down');
      const release = eventIndex(run, 'lock.release');
      const exit = eventIndex(run, 'process.exit');
      const healthy = row(run, 'healthy');
      const exitEvent = exit >= 0 ? run.events[exit] : null;
      return { mode: run.mode, healthySettled, verifier, publish, beads, report, down, release, exit,
        status: run.result.status, signal: run.result.signal, healthy, exitEvent,
        unexpected: /runner: unexpected failure/i.test(`${run.result.stdout || ''}\n${run.result.stderr || ''}`),
        yes: healthySettled >= 0 && healthySettled < verifier && verifier < publish && publish < beads
          && beads < report && report < down && down < release && release < exit
          && !!healthy && healthy.outcome === 'done' && healthy.pushed === true && !!healthy.prUrl
          && exitEvent && exitEvent.healthySettled === true && exitEvent.containers.length === 0
          && exitEvent.networkOwned === false && exitEvent.lockOwned === false
          && run.result.status !== 3 && !run.result.signal
          && !/runner: unexpected failure/i.test(`${run.result.stdout || ''}\n${run.result.stderr || ''}`),
      };
    });
    check('T5 C2/C3/C5 every started healthy sibling verifies, publishes, and settles Beads before report, teardown, lock release, and process exit',
      lifecycle.every((item) => item.yes), JSON.stringify(lifecycle));

    const ownership = mains.map((run) => {
      const afterRelease = run.events.filter((item) => item.afterRelease === true
        && item.ev !== 'process.exit');
      return {
        mode: run.mode,
        networkDowns: eventList(run, 'network.down').length,
        lockReleases: eventList(run, 'lock.release').length,
        reports: eventList(run, 'report.write').length,
        afterRelease: afterRelease.map((item) => `${item.ev}:${item.issueId || ''}`),
        safe: safe(run), providerEnvPresent: run.providerEnvPresent,
      };
    });
    const ownedBeforeFixtureCleanup = ownership.every((item) => item.networkDowns === 1
      && item.lockReleases === 1 && item.reports === 1 && item.afterRelease.length === 0
      && item.safe && item.providerEnvPresent.length === 0);
    check('T6 C2/C3/C5 shared cleanup runs once after each full drain with no post-release mutation or credential disclosure',
      ownedBeforeFixtureCleanup, JSON.stringify(ownership));

    const docsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-djf28-docs-'));
    roots.push(docsRoot);
    const runDir = path.join(docsRoot, 'completed-run');
    const docsLog = path.join(docsRoot, 'docs-codex.jsonl');
    const records = [
      NOISE.chatter,
      JSON.stringify({ type: 'thread.started', thread_id: 'thread-djf28', model: 'gpt-5.6-terra' }),
      JSON.stringify({ type: 'turn.started' }),
      JSON.stringify({ type: 'item.started', item: { id: 'cmd-1', type: 'command_execution',
        command: `rg token ${NOISE.path}`, authorization: NOISE.sensitive } }),
      JSON.stringify({ type: 'item.completed', item: { id: 'cmd-1', type: 'command_execution',
        command: `rg token ${NOISE.path}`, aggregated_output: NOISE.command,
        credential: NOISE.sensitive, exit_code: 0 } }),
      JSON.stringify({ type: 'item.completed', item: { id: 'msg-1', type: 'agent_message',
        text: NOISE.interim } }),
      JSON.stringify({ type: 'item.completed', item: { id: 'cmd-2', type: 'command_execution',
        command: 'git status --short', aggregated_output: `${NOISE.path}\n`, exit_code: 0 } }),
      JSON.stringify({ type: 'item.completed', item: { id: 'msg-final', type: 'agent_message', text: FINAL } }),
      JSON.stringify({ type: 'turn.completed', usage: {
        input_tokens: NOISE.usage, cached_input_tokens: 222, output_tokens: 33,
      } }),
      NOISE.tailChatter,
      '',
    ];
    fs.writeFileSync(docsLog, records.join('\n'));
    const init = runStatus(runDir, 'init', 'repo-djf.28');
    const summarized = runStatus(runDir, 'summary', docsLog);
    const statusFile = path.join(runDir, 'status.json');
    const statusBytes = read(statusFile) || '';
    const status = parseJson(statusFile);
    const noiseValues = Object.values(NOISE);
    check('T7 C4/C5 realistic completed Codex JSONL yields only the final completed agent_message with no event, path, usage, chatter, or sensitive field',
      init.status === 0 && summarized.status === 0 && !!status
        && status.changeSummary === FINAL
        && noiseValues.every((value) => !status.changeSummary.includes(String(value)))
        && !status.changeSummary.includes('turn.completed')
        && !status.changeSummary.includes('input_tokens'),
      JSON.stringify({ init: init.status, summary: summarized.status,
        exactFinal: !!status && status.changeSummary === FINAL,
        actualLength: status && typeof status.changeSummary === 'string' ? status.changeSummary.length : null,
        leakedMarkers: status && typeof status.changeSummary === 'string'
          ? noiseValues.filter((value) => status.changeSummary.includes(String(value))) : [] }));

    const pub = status ? publication(status) : null;
    const reportSummary = pub && section(pub.reportA, '**What changed**', '**Verification evidence**');
    const bodySummary = pub && section(pub.bodyA, '## Change summary', '## Verification evidence');
    const surfaces = pub ? [statusBytes, JSON.stringify(pub.prInput), pub.reportA, pub.bodyA] : [];
    check('T8 C4/C5 status, report, and PR input carry the same exact deterministic final summary and no structured-log noise',
      !!pub && status.changeSummary === FINAL && pub.prInput.status.changeSummary === FINAL
        && reportSummary === FINAL && bodySummary === FINAL
        && pub.reportA === pub.reportB && pub.bodyA === pub.bodyB
        && surfaces.every((surface) => noiseValues.every((value) => !surface.includes(String(value))))
        && surfaces.every((surface) => !surface.includes('turn.completed') && !surface.includes('input_tokens')),
      JSON.stringify({ statusExact: !!status && status.changeSummary === FINAL,
        reportExact: reportSummary === FINAL, bodyExact: bodySummary === FINAL,
        deterministicReport: !!pub && pub.reportA === pub.reportB,
        deterministicBody: !!pub && pub.bodyA === pub.bodyB }));

    const invalid = [
      {
        name: 'malformed', secret: 'MALFORMED-SECRET-djf28',
        text: '{"type":"item.completed","item":{"type":"agent_message","text":"MALFORMED-SECRET-djf28"',
      },
      {
        name: 'partial', secret: 'PARTIAL-SECRET-djf28',
        text: [
          JSON.stringify({ type: 'thread.started', thread_id: 'partial-djf28' }),
          JSON.stringify({ type: 'turn.started' }),
          JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'PARTIAL-SECRET-djf28' } }),
        ].join('\n') + '\n',
      },
      { name: 'empty', secret: 'EMPTY-SECRET-djf28', text: '' },
      {
        name: 'rate-limit-only', secret: 'RATE-LIMIT-SECRET-djf28',
        text: [
          JSON.stringify({ type: 'thread.started', thread_id: 'limited-djf28' }),
          JSON.stringify({ type: 'turn.failed', error: { type: 'rate_limit_error',
            message: 'RATE-LIMIT-SECRET-djf28', request_id: 'private-request-djf28', retry_after: 30 } }),
        ].join('\n') + '\n',
      },
    ];
    const invalidResults = [];
    for (const fixture of invalid) {
      const dir = path.join(docsRoot, `invalid-${fixture.name}`);
      const file = path.join(docsRoot, `${fixture.name}.log`);
      fs.writeFileSync(file, fixture.text);
      const initialized = runStatus(dir, 'init', `repo-djf.28-${fixture.name}`);
      const result = runStatus(dir, 'summary', file);
      const bytes = read(path.join(dir, 'status.json')) || '';
      const value = parseJson(path.join(dir, 'status.json'));
      const rendered = value ? publication(value) : null;
      const publicBytes = rendered ? `${JSON.stringify(rendered.prInput)}\n${rendered.reportA}\n${rendered.bodyA}` : '';
      invalidResults.push({
        name: fixture.name,
        ok: initialized.status === 0 && result.status === 0 && !!value
          && !Object.prototype.hasOwnProperty.call(value, 'changeSummary')
          && !bytes.includes(fixture.secret) && !publicBytes.includes(fixture.secret)
          && !bytes.includes('private-request-djf28') && !publicBytes.includes('private-request-djf28'),
        initialized: initialized.status, status: result.status,
        hasSummary: !!value && Object.prototype.hasOwnProperty.call(value, 'changeSummary'),
        leaked: bytes.includes(fixture.secret) || publicBytes.includes(fixture.secret),
      });
    }
    check('T9 C4/C5 malformed, partial, empty, and rate-limit-only structured docs records are excluded without disclosure',
      invalidResults.every((result) => result.ok),
      JSON.stringify(invalidResults));

    for (const root of roots) {
      try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
    }
    const removed = roots.every((root) => !fs.existsSync(root));
    check('T10 C5 all combined focused fixtures remove their containers, locks, workspaces, handoffs, and private trees',
      removed, JSON.stringify({ rootsRemoved: removed, count: roots.length }));
  } catch (error) {
    check('T1-T10 C1-C5 deterministic combined fixture executes', false,
      String(error && error.stack || error).replace(/djf28-[A-Za-z0-9._-]+(?:credential-bytes|sensitive-field-never-publish)/g, '[redacted]'));
  } finally {
    for (const root of roots) {
      try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
    }
  }
  process.exitCode = failed;
}
main().catch((error) => {
  console.error(`FAIL - T1-T10 C1-C5 fixture settles — ${String(error && error.message || error)}`);
  process.exitCode = 1;
});
