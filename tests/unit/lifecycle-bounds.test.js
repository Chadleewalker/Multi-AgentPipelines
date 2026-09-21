// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  runSync,
  timeoutFor,
  normalizeSpawnResult,
  TIMEOUT_STATUS,
  DEFAULT_GIT_TIMEOUT_MS,
  DEFAULT_LIFECYCLE_TIMEOUT_MS,
} = require('../../runner/process');
const { createDeadlineWatchdog } = require('../../runner/deadline-watchdog');
const { loadConfig, DEFAULTS } = require('../../runner/config');
const { preflight } = require('../../runner/preflight');
const { cleanupOwnedLifecycle } = require('../../runner/run');

const ROOT = path.resolve(__dirname, '..', '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-bounds-'));
let passed = 0;
let failed = 0;
function check(label, condition, detail = '') {
  if (condition) { console.log(`ok - ${label}`); passed += 1; }
  else { console.log(`FAIL - ${label}${detail ? `: ${String(detail).slice(0, 600)}` : ''}`); failed += 1; }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function writeConfig(name, extra = {}) {
  const file = path.join(TMP, name);
  fs.writeFileSync(file, `${JSON.stringify({
    targetRepoPath: path.join(TMP, 'target'),
    targetRepoRemote: 'https://example.invalid/repo.git',
    image: 'fixture:local',
    ...extra,
  }, null, 2)}\n`);
  return file;
}

function logStub(runId = 'lifecycle-unit') {
  const lines = [];
  return {
    runId,
    lines,
    info(_trace, message) { lines.push(`INFO ${message}`); },
    error(_trace, message) { lines.push(`ERROR ${message}`); },
  };
}

async function main() {
  try {
    check('Git and lifecycle commands have distinct named defaults',
      DEFAULT_GIT_TIMEOUT_MS === 60000 && DEFAULT_LIFECYCLE_TIMEOUT_MS === 120000
      && DEFAULTS.gitTimeoutMs === DEFAULT_GIT_TIMEOUT_MS
      && DEFAULTS.lifecycleTimeoutMs === DEFAULT_LIFECYCLE_TIMEOUT_MS);
    check('timeoutFor reads the configured Git bound',
      timeoutFor({ gitTimeoutMs: 41, lifecycleTimeoutMs: 82 }, 'git') === 41);
    check('timeoutFor reads the configured lifecycle bound',
      timeoutFor({ gitTimeoutMs: 41, lifecycleTimeoutMs: 82 }, 'lifecycle') === 82);
    check('invalid runtime values fall back rather than disabling a bound',
      [0, -1, 1.5, '82', null, NaN, Infinity].every((value) =>
        timeoutFor({ lifecycleTimeoutMs: value }) === DEFAULT_LIFECYCLE_TIMEOUT_MS));

    let captured = null;
    const timed = runSync('fixture-command', ['x'], {
      cfg: { lifecycleTimeoutMs: 321 },
      label: 'fixture lifecycle call',
      spawnSync(_command, _args, options) {
        captured = options;
        return { status: null, signal: 'SIGKILL', stdout: '', stderr: '', error: { code: 'ETIMEDOUT' } };
      },
    });
    check('the shared runner applies the configured timeout and force-kill signal',
      captured.timeout === 321 && captured.killSignal === 'SIGKILL');
    check('a kernel timeout is normalized to status 124',
      timed.status === TIMEOUT_STATUS && timed.timedOut === true, JSON.stringify(timed));
    check('the normalized timeout names the command, duration, and config key',
      /fixture lifecycle call timed out after 321ms/.test(timed.stderr)
      && /lifecycleTimeoutMs/.test(timed.stderr));
    check('existing stderr survives before the normalized timeout diagnostic',
      /first line\nfixture/.test(normalizeSpawnResult({
        status: null, stderr: 'first line', error: { code: 'ETIMEDOUT' },
      }, { timeoutMs: 7, label: 'fixture', configKey: 'gitTimeoutMs' }).stderr));
    const ordinary = { status: 9, stdout: 'x', stderr: 'ordinary failure' };
    check('ordinary nonzero results are not relabelled as timeouts',
      normalizeSpawnResult(ordinary, { timeoutMs: 7 }) === ordinary);

    let loaded = null;
    try { loaded = loadConfig(writeConfig('valid.json', { lifecycleTimeoutMs: 4567 })); } catch { /* checked */ }
    check('run config accepts a positive whole lifecycleTimeoutMs',
      loaded && loaded.lifecycleTimeoutMs === 4567);
    for (const [name, value] of [['zero', 0], ['negative', -1], ['fraction', 1.2], ['string', '120000']]) {
      let message = '';
      try { loadConfig(writeConfig(`${name}.json`, { lifecycleTimeoutMs: value })); }
      catch (error) { message = error.message; }
      check(`run config rejects ${name} lifecycleTimeoutMs by field name`, /lifecycleTimeoutMs/.test(message), message);
    }
    const example = JSON.parse(fs.readFileSync(path.join(ROOT, 'run.config.example.json'), 'utf8'));
    check('the example config publishes the effective lifecycle bound',
      example.lifecycleTimeoutMs === DEFAULTS.lifecycleTimeoutMs);

    // A real worker-clock discriminator. While this thread is blocked in spawnSync for
    // 400ms, the independent watchdog must launch its action and write the marker.
    const marker = path.join(TMP, 'watchdog-fired.txt');
    const started = Date.now();
    const watchdog = createDeadlineWatchdog({
      delayMs: 50,
      command: process.execPath,
      args: ['-e', 'require("fs").writeFileSync(process.argv[process.argv.length - 1], String(Date.now()))', marker],
      timeoutMs: 1000,
      label: 'watchdog marker',
      env: process.env,
    });
    spawnSync(process.execPath, ['-e', 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400)']);
    const existedWhileMainWasBlocked = fs.existsSync(marker);
    const firedAt = existedWhileMainWasBlocked ? Number(fs.readFileSync(marker, 'utf8')) : Infinity;
    check('the independent deadline action fires while the orchestrator thread is blocked',
      existedWhileMainWasBlocked && firedAt - started < 350,
      JSON.stringify({ existedWhileMainWasBlocked, elapsed: firedAt - started }));
    await watchdog.cancel();

    const cancelledMarker = path.join(TMP, 'watchdog-cancelled.txt');
    const cancelled = createDeadlineWatchdog({
      delayMs: 150,
      command: process.execPath,
      args: ['-e', 'require("fs").writeFileSync(process.argv[process.argv.length - 1], "late")', cancelledMarker],
      timeoutMs: 1000,
      label: 'cancelled watchdog',
      env: process.env,
    });
    await cancelled.cancel();
    await sleep(250);
    check('cancelling a completed container prevents the deadline action', !fs.existsSync(cancelledMarker));

    let timeoutResultResolve;
    const timeoutResult = new Promise((resolve) => { timeoutResultResolve = resolve; });
    const wedgedAction = createDeadlineWatchdog({
      delayMs: 0,
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      timeoutMs: 75,
      label: 'wedged deadline action',
      env: process.env,
      onResult: timeoutResultResolve,
    });
    const watchdogResult = await Promise.race([timeoutResult, sleep(2000).then(() => null)]);
    check('the watchdog action is itself bounded and normalized',
      watchdogResult && watchdogResult.status === 124 && watchdogResult.timedOut === true,
      JSON.stringify(watchdogResult));
    await wedgedAction.cancel();

    // Preflight owns compensation for a partial startup even when the next gate throws.
    const preRoot = path.join(TMP, 'preflight-root');
    const target = path.join(TMP, 'preflight-target');
    fs.mkdirSync(preRoot, { recursive: true });
    fs.mkdirSync(target, { recursive: true });
    const preLog = logStub('preflight-finally');
    let downs = 0;
    const pre = preflight({
      targetRepoPath: target,
      image: 'fixture:local',
      hostShell: null,
      lifecycleTimeoutMs: 100,
    }, preRoot, preLog, {
      verifyRepoIdentity: () => ({ ok: true, remoteName: 'fixture', identity: 'repo:fixture/project' }),
      resolveHostShell: () => ({ ok: true, command: '/fixture/bash', kind: 'fixture' }),
      dockerAvailable: () => ({ status: 0 }),
      imageExists: () => ({ status: 0 }),
      networkUp: () => ({ ok: true, output: '' }),
      egressCheck: () => { throw new Error('planted egress exception'); },
      networkDown: () => { downs += 1; throw new Error('planted preflight-down exception'); },
    });
    check('an unexpected post-network preflight exception becomes a named failure',
      !pre.ok && pre.unexpected === true && /planted egress exception/.test(pre.reason), JSON.stringify(pre));
    check('partial preflight startup is compensated exactly once even when teardown throws',
      downs === 1 && preLog.lines.some((line) => /planted preflight-down exception/.test(line)),
      JSON.stringify({ downs, lines: preLog.lines }));
    const lockDir = path.join(preRoot, 'runs', 'locks');
    check('the preflight finally releases the project lock after that exception',
      !fs.existsSync(lockDir) || fs.readdirSync(lockDir).length === 0);

    const cleanLog = logStub('owned-finally');
    const cleanupCalls = [];
    const cleanup = cleanupOwnedLifecycle({ targetRepoPath: target }, preRoot, cleanLog, 'owned-finally/preflight', {
      networkDown() { cleanupCalls.push('network'); throw new Error('planted down exception'); },
      releaseLock() { cleanupCalls.push('lock'); },
    });
    check('lock release is in the teardown finally even when network teardown throws',
      cleanupCalls.join('|') === 'network|lock', cleanupCalls.join('|'));
    check('cleanup reports the teardown exception without throwing over the original failure',
      !cleanup.ok && /planted down exception/.test(cleanup.error)
      && cleanLog.lines.some((line) => /planted down exception/.test(line)));

    const sources = {
      workspace: fs.readFileSync(path.join(ROOT, 'runner', 'workspace.js'), 'utf8'),
      publish: fs.readFileSync(path.join(ROOT, 'runner', 'publish.js'), 'utf8'),
      preflight: fs.readFileSync(path.join(ROOT, 'runner', 'preflight.js'), 'utf8'),
      pause: fs.readFileSync(path.join(ROOT, 'runner', 'pause.js'), 'utf8'),
      container: fs.readFileSync(path.join(ROOT, 'runner', 'container.js'), 'utf8'),
      run: fs.readFileSync(path.join(ROOT, 'runner', 'run.js'), 'utf8'),
    };
    check('workspace clone and Git queries use the shared bounded process contract',
      /runSync\('git'/.test(sources.workspace) && !/require\('child_process'\)/.test(sources.workspace));
    check('push and GitHub publication use the shared bounded process contract',
      /runSync\('git'/.test(sources.publish) && /runSync\('gh'/.test(sources.publish)
      && !/spawnSync/.test(sources.publish));
    check('Docker and shell lifecycle probes use the shared bounded process contract',
      /runSync\(cmd/.test(sources.preflight) && /runSync\('claude'/.test(sources.pause));
    check('active containers use the independent deadline watchdog, not a main-thread kill timer',
      /createDeadlineWatchdog/.test(sources.container)
      && !/setTimeout[\s\S]{0,300}docker[^\n]*kill/.test(sources.container));
    check('normal run ownership is cleaned from a finally block',
      /finally\s*\{[\s\S]{0,200}cleanupOwnedLifecycle/.test(sources.run));
    check('preflight failure no longer asks main to tear down unowned plumbing',
      !/if \(!pre\.locked[\s\S]{0,100}networkDown/.test(sources.run));

    console.log(`lifecycle bounds: ${passed} passed, ${failed} failed`);
    if (failed) process.exitCode = 1;
  } catch (error) {
    check('the lifecycle-bounds suite completed without throwing', false, error && error.stack);
    console.log(`lifecycle bounds: ${passed} passed, ${failed} failed`);
    process.exitCode = 1;
  } finally {
    fs.rmSync(TMP, { recursive: true, force: true });
  }
}

main();
