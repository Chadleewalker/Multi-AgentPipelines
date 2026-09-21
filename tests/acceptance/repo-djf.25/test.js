// Frozen acceptance test — repo-djf.25: credential-lane failures stop at one task.
// PAIRING (criterion -> tests): C1 -> G3,T1; C2 -> T2,T3,T4,T6;
// C3 -> T2,T3,T4,T5; C4 -> G1,T5,T6; C5 -> G1,G2,G3,T1,T6.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const REPO = path.resolve(__dirname, '..', '..', '..');
const RUN_FILE = path.join(REPO, 'runner', 'run.js');
const { resolveHostShell } = require(path.join(REPO, 'runner', 'host-shell.js'));
let failed = 0;
function check(name, yes, detail = '') {
  console.log(`${yes ? 'ok' : 'FAIL'} - ${name}${yes || !detail ? '' : ` — ${detail}`}`);
  if (!yes) failed = 1;
}
function scrubbedEnv() {
  const env = { ...process.env };
  for (const key of ['CODEX_API_KEY', 'OPENAI_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CODEX_HOME']) {
    delete env[key];
  }
  return env;
}
function failureNames(output) {
  return String(output || '').split(/\r?\n/)
    .filter((line) => /^(?:FAIL|not ok)\b/i.test(line))
    .map((line) => line.replace(/\s+—.*$/, '').slice(0, 180));
}
function runFrozenUnion() {
  const runs = [];
  const hostShell = resolveHostShell();
  for (let round = 1; round <= 2; round += 1) {
    for (const suite of ['repo-djf.22', 'repo-djf.23', 'repo-djf.24']) {
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

// Stringified into a child preload. The real runner entry point remains in charge; only its
// host boundaries are replaced with deterministic recorders so no Docker, Beads, Git or
// GitHub authority is needed by this focused test.
function fixturePreload() {
  'use strict';
  const fs = require('fs');
  const path = require('path');
  const repo = path.resolve(path.dirname(process.argv[1]), '..');
  const root = process.env.DJF25_FIXTURE_ROOT;
  const eventsFile = path.join(root, 'events.jsonl');
  const manifestFile = path.join(root, 'manifest.json');
  const mode = process.env.DJF25_FAILURE_MODE;
  const secret = process.env.DJF25_SECRET;
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
    error.code = `DJF25_${kind.toUpperCase().replace(/-/g, '_')}`;
    // A careless JSON copy of the rejection would disclose this. A boundary that records
    // only its safe diagnostic will not.
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
  const log = {
    runId: 'accept-djf25-run', dir: path.join(root, 'run-artifacts'),
    trace(id) { return `accept-djf25-run/${id}`; },
    taskDir,
    info(trace, message, meta) { event('log.info', { trace, message: String(message), meta }); },
    error(trace, message, meta) { event('log.error', { trace, message: String(message), meta }); },
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
    attemptNotes(runId, outcome) { return [`run ${runId}: outcome ${outcome.status}`]; },
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
    hasCommits(dir) { const id = path.basename(dir).replace('workspace-', ''); mutation('git.inspect', id); return true; },
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
  global.__DJF25 = { cfg, log, event, workspace, taskDir };
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
function childEnv(root, mode, secret, preload) {
  const env = scrubbedEnv();
  env.DJF25_FIXTURE_ROOT = root;
  env.DJF25_FAILURE_MODE = mode;
  env.DJF25_SECRET = secret;
  env.NODE_OPTIONS = `--require "${preload.split(path.sep).join('/')}"`;
  return env;
}
function fixtureChild(mode, kind) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `accept-djf25-${kind}-${mode}-`));
  roots.push(root);
  const preload = path.join(root, 'preload.js');
  fs.writeFileSync(preload, `(${fixturePreload.toString()})();\n`);
  const secret = `djf25-${kind}-${mode}-credential-bytes`;
  const direct = [
    "'use strict';",
    '(async()=>{',
    ' const f=global.__DJF25; const run=require(process.argv[1]);',
    " const issue={id:'bad',title:'direct lane failure',priority:0};",
    " try { const value=await run.executeTask(f.cfg,issue,f.taskDir('bad'),f.log,'direct/bad',",
    "   {dir:f.workspace('bad')},'',1); f.event('direct.resolve',{value}); }",
    " catch(error){ f.event('direct.reject',{message:String(error&&error.message||error),error}); }",
    '})().catch(error=>{global.__DJF25.event(\'direct.harness.reject\',{message:String(error&&error.stack||error)});});',
  ].join('');
  const args = kind === 'direct' ? ['-e', direct, RUN_FILE] : [RUN_FILE, '--config', 'fixture'];
  const result = spawnSync(process.execPath, args, {
    cwd: REPO, encoding: 'utf8', windowsHide: true, timeout: 5000,
    maxBuffer: 16 * 1024 * 1024, env: childEnv(root, mode, secret, preload),
  });
  let manifest = null;
  try { manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')); } catch {}
  return { root, mode, kind, secret, result, events: readEvents(root), manifest };
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
function boundaryProof(direct, main, mode) {
  const resolved = eventList(direct, 'direct.resolve')[0];
  const directValue = resolved && resolved.value;
  const bad = row(main, 'bad');
  const finished = eventList(main, 'beads.finish', 'bad');
  const badWorkspace = path.join(main.root, 'workspace-bad');
  const healthyWorkspace = path.join(main.root, 'workspace-healthy');
  const handoffRoot = path.join(main.root, 'credential-lane', 'tasks');
  const handoffs = fs.existsSync(handoffRoot) ? fs.readdirSync(handoffRoot) : [];
  const wantedHandoffs = mode === 'refresh' ? 1 : 0;
  return {
    yes: !!resolved && eventList(direct, 'direct.reject').length === 0
      && directValue && ((directValue.exitCode !== undefined && directValue.exitCode !== 0)
        || directValue.ok === false)
      && !!bad && bad.outcome === 'failed' && typeof bad.error === 'string'
      && bad.recoveryWorkspace === badWorkspace
      && finished.length === 1 && finished[0].outcome
      && finished[0].outcome.status === 'failed' && finished[0].outcome.beads === null
      && fs.existsSync(badWorkspace) && !fs.existsSync(healthyWorkspace)
      && eventList(main, 'verifier.complete', 'bad').length === 0
      && eventList(main, 'github.publish', 'bad').length === 0
      && eventList(main, 'git.workspace.discard', 'bad').length === 0
      && handoffs.length === wantedHandoffs && safe(direct) && safe(main),
    detail: {
      directResolved: !!resolved, directRejected: eventList(direct, 'direct.reject').length,
      directStatus: direct.result.status,
      directError: direct.result.error && direct.result.error.message,
      directStderr: String(direct.result.stderr || '').slice(-500),
      mainError: main.result.error && main.result.error.message,
      mainStderr: String(main.result.stderr || '').slice(-500),
      directValue, status: main.result.status, bad,
      badFinish: finished.map((item) => item.outcome),
      badWorkspace: fs.existsSync(badWorkspace), healthyWorkspace: fs.existsSync(healthyWorkspace),
      badVerifier: eventList(main, 'verifier.complete', 'bad').length,
      badPublish: eventList(main, 'github.publish', 'bad').length,
      badDiscard: eventList(main, 'git.workspace.discard', 'bad').length,
      handoffs: handoffs.length, wantedHandoffs, safe: safe(direct) && safe(main),
    },
  };
}

async function main() {
  try {
    const unionRuns = runFrozenUnion();
    check('T1 C1/C5 the complete repo-djf.22, repo-djf.23, and repo-djf.24 suites pass twice on the exact candidate',
      unionRuns.length > 0
        && unionRuns.every((item) => item.status === 0 && !item.signal && !item.error),
      JSON.stringify({ platform: process.platform, runs: unionRuns }));

    const scenarios = {};
    for (const mode of ['staging', 'launch', 'refresh']) {
      scenarios[mode] = { direct: fixtureChild(mode, 'direct'), main: fixtureChild(mode, 'main') };
    }
    const staging = boundaryProof(scenarios.staging.direct, scenarios.staging.main, 'staging');
    check('T2 C2/C3 a staging rejection resolves executeTask and the runner drain as one failed recoverable task while its healthy sibling completes',
      staging.yes, JSON.stringify(staging.detail));
    const launch = boundaryProof(scenarios.launch.direct, scenarios.launch.main, 'launch');
    check('T3 C2/C3 a worker-launch rejection resolves executeTask and the runner drain as one failed recoverable task while its healthy sibling completes',
      launch.yes, JSON.stringify(launch.detail));
    const refresh = boundaryProof(scenarios.refresh.direct, scenarios.refresh.main, 'refresh');
    check('T4 C2/C3 a refresh-persistence rejection resolves executeTask and the runner drain while retaining exactly its private recovery handoff',
      refresh.yes, JSON.stringify(refresh.detail));

    const mains = Object.values(scenarios).map((item) => item.main);
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
        status: run.result.status, signal: run.result.signal,
        unexpected: /runner: unexpected failure/i.test(`${run.result.stdout || ''}\n${run.result.stderr || ''}`),
        healthy, exitEvent,
        yes: healthySettled >= 0 && healthySettled < verifier && verifier < publish && publish < beads
          && beads < report && report < down && down < release && release < exit
          && !!healthy && healthy.outcome === 'done' && healthy.pushed === true && !!healthy.prUrl
          && exitEvent && exitEvent.healthySettled === true && exitEvent.containers.length === 0
          && exitEvent.networkOwned === false && exitEvent.lockOwned === false
          && run.result.status !== 3 && !run.result.signal
          && !/runner: unexpected failure/i.test(`${run.result.stdout || ''}\n${run.result.stderr || ''}`),
      };
    });
    check('T5 C3/C4 every started sibling settles and the healthy verifier, publication, and Beads close finish before report, teardown, lock release, and process exit',
      lifecycle.every((item) => item.yes), JSON.stringify(lifecycle));

    const ownership = mains.map((run) => {
      const exit = eventList(run, 'process.exit')[0];
      const afterRelease = run.events.filter((item) => item.afterRelease === true
        && item.ev !== 'process.exit');
      return {
        mode: run.mode,
        networkDowns: eventList(run, 'network.down').length,
        lockReleases: eventList(run, 'lock.release').length,
        reports: eventList(run, 'report.write').length,
        afterRelease: afterRelease.map((item) => `${item.ev}:${item.issueId || ''}`),
        exitHandoffs: exit && exit.handoffs.length,
        exitWorkspaces: exit && exit.workspaces.map((item) => path.basename(item)).sort(),
        safe: safe(run),
      };
    });
    const expectedExitHandoffs = { staging: 0, launch: 0, refresh: 1 };
    const ownedBeforeFixtureCleanup = ownership.every((item) => item.networkDowns === 1
      && item.lockReleases === 1 && item.reports === 1 && item.afterRelease.length === 0
      && item.exitHandoffs === expectedExitHandoffs[item.mode]
      && JSON.stringify(item.exitWorkspaces) === JSON.stringify(['workspace-bad']) && item.safe);
    for (const root of roots) {
      try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
    }
    const removed = roots.every((root) => !fs.existsSync(root));
    check('T6 C2/C4/C5 cleanup runs once after the drain, no mutation follows ownership release, no credential is disclosed, and the focused fixture removes every owned artifact',
      ownedBeforeFixtureCleanup && removed,
      JSON.stringify({ ownership, rootsRemoved: removed }));
  } catch (error) {
    check('T1-T6 C1-C5 deterministic runner-boundary fixture executes', false,
      String(error && error.stack || error).replace(/djf25-[A-Za-z0-9._-]+-credential-bytes/g, '[redacted]'));
  } finally {
    for (const root of roots) {
      try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
    }
  }
  process.exitCode = failed;
}
main().catch((error) => {
  console.error(`FAIL - T1-T6 C1-C5 fixture settles — ${String(error && error.message || error)}`);
  process.exitCode = 1;
});
