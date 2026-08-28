// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// Container launch + wall-clock enforcement — DESIGN.md §4.1, §4.2, §4.6, §4.10 (T14).
// One fresh container per task. The host holds every credential and every timer; the
// enforcer never lives inside the thing it may need to kill.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { toMountPath } = require('./bd');
const { createDeadlineWatchdog } = require('./deadline-watchdog');
const { timeoutFor } = require('./process');

// Windows/Git Bash: Docker needs C:/... mount sources, and MSYS must not rewrite
// container-side paths like /workspace into C:\Program Files\Git\workspace.
const DOCKER_ENV = { ...process.env, MSYS_NO_PATHCONV: '1' };
const WATCHDOG_DOCKER_ENV = { ...DOCKER_ENV };
delete WATCHDOG_DOCKER_ENV.CLAUDE_CODE_OAUTH_TOKEN;

// The container's inputs are exactly these (§4.10) — nothing else crosses the boundary.
function buildArgs(cfg, opts) {
  const { containerName, workspaceDir, pipelineDir, issueId, token } = opts;
  const args = [
    'run', '--rm',
    '--name', containerName,
    '--network', cfg.network,
    '-v', `${toMountPath(workspaceDir)}:/workspace`,
    '-v', `${toMountPath(pipelineDir)}:/pipeline:ro`,   // scaffolding, read-only
    '-w', '/workspace',
    '-e', `ISSUE_ID=${issueId}`,
    '-e', 'WORKSPACE=/workspace',
    '-e', 'PIPELINE_DIR=/pipeline',
    '-e', `HTTPS_PROXY=${cfg.proxyUrl}`,
    '-e', `HTTP_PROXY=${cfg.proxyUrl}`,
    '-e', 'NO_PROXY=localhost,127.0.0.1',
  ];
  // Token by name only: the value comes from the runner's environment, so it never
  // appears in an argument list, a log line, or an image layer (§6).
  if (token) args.push('-e', 'CLAUDE_CODE_OAUTH_TOKEN');
  if (cfg.agentCommand) args.push('-e', `PIPELINE_AGENT_CMD=${cfg.agentCommand}`);
  // The entrypoint appends --model to its default headless invocation; an explicit
  // agentCommand (stubs, overrides) owns its own flags and ignores this.
  if (cfg.model) args.push('-e', `PIPELINE_MODEL=${cfg.model}`);
  if (cfg.maxAttempts) args.push('-e', `PIPELINE_MAX_ATTEMPTS=${cfg.maxAttempts}`);
  args.push(cfg.image, 'bash', '/pipeline/entrypoint.sh');
  return args;
}

// Run one task container. Resolves {exitCode, killed, timedOut, durationMs}, where
// exitCode is 'killed' when the host wall-clock timer fired (§4.11: no exit code).
function runTask(cfg, opts, log, traceId) {
  return new Promise((resolve) => {
    const args = buildArgs(cfg, opts);
    const budgetMs = (opts.wallClockMinutes || cfg.wallClockMinutes) * 60 * 1000;
    const logStream = fs.createWriteStream(path.join(opts.taskDir, 'container.log'));
    const started = Date.now();

    log.info(traceId, `launching container ${opts.containerName} (budget ${Math.round(budgetMs / 60000)}m active)`, {
      event: 'container.launched',
      data: { name: opts.containerName, budgetMinutes: Math.round(budgetMs / 60000) },
    });
    const child = spawn('docker', args, {
      env: { ...DOCKER_ENV, CLAUDE_CODE_OAUTH_TOKEN: opts.token || '' },
    });
    child.stdout.pipe(logStream);
    child.stderr.pipe(logStream);

    let timedOut = false;
    let settled = false;
    const deadlineAt = started + budgetMs;
    const watchdogFactory = opts.watchdogFactory || createDeadlineWatchdog;
    // The wall clock and kill live in a worker thread. A synchronous clone/push/Beads
    // operation in another runner worker can block this thread's callbacks, but it cannot
    // delay the independent deadline or its bounded Docker kill.
    const watchdog = watchdogFactory({
      delayMs: budgetMs,
      command: 'docker',
      args: ['kill', opts.containerName],
      timeoutMs: timeoutFor(cfg, 'lifecycle'),
      label: `docker kill ${opts.containerName}`,
      env: WATCHDOG_DOCKER_ENV,
      onDeadline() {
        timedOut = true;
        log.error(traceId, `wall-clock budget exhausted — killing ${opts.containerName}`);
      },
      onResult(result) {
        if (!result.ok) log.error(traceId, `container kill did not complete: ${result.error}`);
      },
    });

    async function finish(result) {
      if (settled) return;
      settled = true;
      try { await watchdog.cancel(); }
      catch (e) { log.error(traceId, `container deadline watchdog cleanup failed: ${e && e.message ? e.message : e}`); }
      resolve(result);
    }

    child.on('close', (code) => {
      const durationMs = Date.now() - started;
      const deadlineHit = timedOut || watchdog.fired || Date.now() >= deadlineAt;
      finish({
        exitCode: deadlineHit ? 'killed' : code,
        killed: deadlineHit,
        durationMs,
      });
    });
    child.on('error', (err) => {
      log.error(traceId, `docker run failed to start: ${err.message}`);
      finish({ exitCode: 30, killed: false, durationMs: Date.now() - started });
    });
  });
}

module.exports = { runTask, buildArgs };
