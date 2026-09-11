// Frozen acceptance test — repo-djf.3 runner-owned credential lease cleanup.
// A task failure must not strand a lock whose owner is the still-live runner process.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..', '..');
const AUTH_FILE = path.join(REPO, 'runner', 'codex-auth.js');
const RUN_FILE = path.join(REPO, 'runner', 'run.js');
let failed = 0;
function check(name, yes, detail = '') {
  console.log(`${yes ? 'ok' : 'FAIL'} - ${name}${yes || !detail ? '' : ` — ${detail}`}`);
  if (!yes) failed = 1;
}

async function main() {
  if (!fs.existsSync(AUTH_FILE)) {
    check('C3 runner releases its ChatGPT credential lane when task execution throws', false,
      'runner/codex-auth.js is absent');
    return;
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-djf3-runner-release-'));
  const taskDir = path.join(root, 'task');
  const workspaceDir = path.join(root, 'workspace');
  fs.mkdirSync(taskDir, { recursive: true });
  fs.mkdirSync(path.join(workspaceDir, '.run'), { recursive: true });

  const handle = {
    hostPath: path.join(root, 'private', 'tasks', 'fixture'),
    containerPath: '/root/.codex',
    cacheRoot: path.join(root, 'private'),
    mount: `${path.join(root, 'private', 'tasks', 'fixture')}:/root/.codex:rw`,
  };
  const calls = [];
  const launches = [];
  let failurePoint = 'launch';
  const fakeAuth = {
    stageTaskCache(options) { calls.push(['stage', options]); return Promise.resolve(handle); },
    releaseTaskCache(value) { calls.push(['release', value]); return Promise.resolve(); },
  };
  require.cache[AUTH_FILE] = {
    id: AUTH_FILE, filename: AUTH_FILE, loaded: true, exports: fakeAuth,
  };

  const queueFile = require.resolve(path.join(REPO, 'runner', 'queue.js'));
  require.cache[queueFile] = {
    id: queueFile, filename: queueFile, loaded: true,
    exports: {
      readyQueue() { return []; },
      claim() { return true; },
      exportIssue() { return { ok: true, markdown: '# fixture' }; },
      finish() { return { ok: true }; },
      outcomeFor() { return { status: 'failed', beads: 'blocked' }; },
      attemptNotes() { return []; },
      undispatchableRow() { return null; },
      logQueueRead() {},
      logUndispatched() {},
      queueExitCode() { return 0; },
    },
  };
  const workspaceFile = require.resolve(path.join(REPO, 'runner', 'workspace.js'));
  require.cache[workspaceFile] = {
    id: workspaceFile, filename: workspaceFile, loaded: true,
    exports: {
      prepare() {
        return { ok: true, dir: workspaceDir, forkPoint: 'fixture-base', branch: 'fixture-branch', memoryCount: 0 };
      },
      collectArtifacts() {
        if (failurePoint === 'collect') throw new Error('injected artifact-collection failure');
        return { status: { issueId: 'lane-throw', attempts: [], rateLimitResetAt: '2026-01-01T00:00:00.000Z' }, verify: null, contracts: {} };
      },
      hasCommits() { return false; },
      discard() {},
    },
  };
  const containerFile = require.resolve(path.join(REPO, 'runner', 'container.js'));
  require.cache[containerFile] = {
    id: containerFile, filename: containerFile, loaded: true,
    exports: {
      runTask(_cfg, opts) {
        launches.push(opts);
        if (failurePoint === 'launch') throw new Error('injected container-launch failure');
        if (failurePoint === 'rate-limit') return Promise.resolve({ exitCode: 20, durationMs: 1 });
        return Promise.resolve({ exitCode: 0, durationMs: 1 });
      },
    },
  };

  let thrown = null;
  try {
    delete require.cache[RUN_FILE];
    const { runOneTask } = require(RUN_FILE);
    const log = {
      runId: 'accept-djf3-release', dir: root,
      trace(id) { return `accept-djf3-release/${id}`; },
      taskDir() { return taskDir; },
      info() {}, error() {}, event() {},
    };
    const gate = {
      admit: async () => true,
      reportLimit: async () => ({ resumed: false }),
    };
    await runOneTask({
      provider: 'codex', codexAuth: 'chatgpt', codexAuthCacheRoot: handle.cacheRoot,
      hostShell: 'bash', targetRepoPath: root, targetRepoRemote: root,
      wallClockMinutes: 1, lifecycleTimeoutMs: 2000, maxAttempts: 1,
    }, { id: 'lane-throw', title: 'lane cleanup fixture', priority: 1 }, log, '', gate);
  } catch (error) { thrown = error; }

  check('C3 runner releases its ChatGPT credential lane when task execution throws',
    !!thrown
      && /injected container-launch failure/.test(thrown.message || String(thrown))
      && calls.map(call => call[0]).join(',') === 'stage,release'
      && calls[1] && calls[1][1] === handle,
    JSON.stringify({ thrown: thrown && thrown.message, calls: calls.map(call => call[0]) }));

  calls.length = 0;
  failurePoint = 'collect';
  thrown = null;
  try {
    const { runOneTask } = require(RUN_FILE);
    const log = {
      runId: 'accept-djf3-release-collect', dir: root,
      trace(id) { return `accept-djf3-release-collect/${id}`; },
      taskDir() { return taskDir; },
      info() {}, error() {}, event() {},
    };
    const gate = { admit: async () => true, reportLimit: async () => ({ resumed: false }) };
    await runOneTask({
      provider: 'codex', codexAuth: 'chatgpt', codexAuthCacheRoot: handle.cacheRoot,
      hostShell: 'bash', targetRepoPath: root, targetRepoRemote: root,
      wallClockMinutes: 1, lifecycleTimeoutMs: 2000, maxAttempts: 1,
    }, { id: 'lane-collect-throw', title: 'lane cleanup after collection failure', priority: 1 },
    log, '', gate);
  } catch (error) { thrown = error; }

  check('C3 runner releases its ChatGPT credential lane when post-container artifact collection throws',
    !!thrown
      && /injected artifact-collection failure/.test(thrown.message || String(thrown))
      && calls.map(call => call[0]).join(',') === 'stage,release'
      && calls[1] && calls[1][1] === handle,
    JSON.stringify({ thrown: thrown && thrown.message, calls: calls.map(call => call[0]) }));

  calls.length = 0;
  launches.length = 0;
  failurePoint = 'rate-limit';
  const pauseGate = {
    admit: async () => true,
    reportLimit: async () => { calls.push(['pause']); return { resumed: false, reason: 'fixture stop' }; },
  };
  await require(RUN_FILE).runOneTask({
    provider: 'codex', codexAuth: 'chatgpt', codexAuthCacheRoot: handle.cacheRoot,
    hostShell: 'bash', targetRepoPath: root, targetRepoRemote: root,
    wallClockMinutes: 1, lifecycleTimeoutMs: 2000, maxAttempts: 1,
  }, { id: 'lane-rate-limit', title: 'release the lane while usage is parked', priority: 1 },
  {
    runId: 'accept-djf3-rate-limit', dir: root,
    trace(id) { return `accept-djf3-rate-limit/${id}`; }, taskDir() { return taskDir; },
    info() {}, error() {}, event() {},
  }, '', pauseGate);
  check('C3 a stopped rate-limited container writes back and releases the credential lane before the run waits, so another queued idea can use the subscription',
    calls.map(call => call[0]).join(',') === 'stage,release,pause',
    JSON.stringify({ calls: calls.map(call => call[0]) }));

  calls.length = 0;
  launches.length = 0;
  failurePoint = 'launch';
  thrown = null;
  try {
    const { runOneTask } = require(RUN_FILE);
    const log = {
      runId: 'accept-djf3-dormant-claude', dir: root,
      trace(id) { return `accept-djf3-dormant-claude/${id}`; },
      taskDir() { return taskDir; },
      info() {}, error() {}, event() {},
    };
    const gate = { admit: async () => true, reportLimit: async () => ({ resumed: false }) };
    await runOneTask({
      provider: 'claude', codexAuth: 'chatgpt', hostShell: 'bash',
      targetRepoPath: root, targetRepoRemote: root,
      wallClockMinutes: 1, lifecycleTimeoutMs: 2000, maxAttempts: 1,
    }, { id: 'dormant-claude', title: 'dormant Codex auth must not alter Claude', priority: 1 },
    log, 'fixture-claude-token', gate);
  } catch (error) { thrown = error; }

  check('C1 dormant ChatGPT configuration never stages a Codex cache or suppresses the selected Claude credential in the task runner',
    !!thrown && /injected container-launch failure/.test(thrown.message || String(thrown))
      && calls.length === 0 && launches.length === 1
      && launches[0].credential && launches[0].credential.name === 'CLAUDE_CODE_OAUTH_TOKEN'
      && launches[0].credential.value === 'fixture-claude-token' && !launches[0].authCache,
    JSON.stringify({ thrown: thrown && thrown.message, authCalls: calls.map(call => call[0]),
      launches: launches.map(opts => ({ credentialName: opts.credential && opts.credential.name,
        hasAuthCache: !!opts.authCache })) }));

  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
}

main().catch(error => {
  check('C3 runner credential-lane cleanup harness completes', false,
    error && (error.stack || error.message) || String(error));
}).finally(() => { process.exitCode = failed; });
