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
const {
  CLAUDE_CREDENTIAL_ENV, CODEX_CREDENTIAL_ENV, credentialEnvFor, effortFor, providerFor,
} = require('./agent-provider');

// Windows/Git Bash: Docker needs C:/... mount sources, and MSYS must not rewrite
// container-side paths like /workspace into C:\Program Files\Git\workspace.
const DOCKER_ENV = { ...process.env, MSYS_NO_PATHCONV: '1' };
// The kill path needs no credential at all, so neither provider's is left in its
// environment — both names, because a Claude run and a Codex run share this module.
const WATCHDOG_DOCKER_ENV = { ...DOCKER_ENV };
delete WATCHDOG_DOCKER_ENV[CLAUDE_CREDENTIAL_ENV];
delete WATCHDOG_DOCKER_ENV[CODEX_CREDENTIAL_ENV];

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
  // Credential by name only: the value comes from the runner's environment, so it never
  // appears in an argument list, a log line, or an image layer (§6). WHICH name depends on
  // the provider this run selected — a Codex task gets CODEX_API_KEY and no Claude token,
  // and a Claude task is unchanged. Neither ever gets both: an unused credential in a task
  // container is reach the task has no need of.
  //
  // The host's saved Codex login is deliberately NOT involved. `~/.codex/auth.json` is
  // never mounted (§4.10 lists the container's inputs, and that is not one of them);
  // container Codex authenticates with CODEX_API_KEY or not at all.
  const provider = providerFor(cfg, 'implementation');
  if (token) args.push('-e', credentialEnvFor(provider));
  // Only ever pushed for a non-default provider, so a Claude run's argv is byte-identical
  // to what it was before this field existed and the entrypoint's default stays claude.
  if (provider !== 'claude') {
    args.push('-e', `PIPELINE_PROVIDER=${provider}`);
    args.push('-e', `PIPELINE_REASONING_EFFORT=${effortFor(cfg, 'implementation')}`);
  }
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
    // The value crosses here and nowhere else: `docker run` was handed the variable NAME
    // above, and reads it out of this environment.
    const child = spawn('docker', args, {
      env: { ...DOCKER_ENV, [credentialEnvFor(providerFor(cfg, 'implementation'))]: opts.token || '' },
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
