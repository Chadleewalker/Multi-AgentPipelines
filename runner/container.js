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
  CREDENTIAL_NAMES, credentialNameFor, providerFor, providerForCredentialName,
} = require('./agent-provider');

// Every provider credential name this pipeline knows. The Claude one is also spelled out
// literally because `scripts/test-runner-container.sh` greps THIS file for it.
const CREDENTIAL_ENV_NAMES = [...new Set([
  'CLAUDE_CODE_OAUTH_TOKEN', ...Object.values(CREDENTIAL_NAMES),
])];

// Windows/Git Bash: Docker needs C:/... mount sources, and MSYS must not rewrite
// container-side paths like /workspace into C:\Program Files\Git\workspace.
const DOCKER_ENV = { ...process.env, MSYS_NO_PATHCONV: '1' };
const WATCHDOG_DOCKER_ENV = { ...DOCKER_ENV };
for (const name of CREDENTIAL_ENV_NAMES) delete WATCHDOG_DOCKER_ENV[name];

// Which credential this container gets, and under which environment-variable name.
// `opts.credential` is the provider-aware form the runner selects (config.js owns the
// selection); `opts.token` is the historical Claude-shaped argument, kept working so an
// older caller behaves exactly as before. A task NEVER gets both, and never gets the one
// belonging to the provider it was not launched for.
function credentialFor(cfg, opts) {
  const chosen = opts && opts.credential;
  if (chosen && chosen.name) return { name: chosen.name, value: chosen.value || '' };
  if (opts && opts.token) return { name: credentialNameFor(providerFor(cfg)), value: opts.token };
  return null;
}

function providerOf(cfg, credential) {
  return credential ? providerForCredentialName(credential.name) : providerFor(cfg);
}

// The container's inputs are exactly these (§4.10) — nothing else crosses the boundary.
function buildArgs(cfg, opts) {
  const { containerName, workspaceDir, pipelineDir, issueId } = opts;
  const credential = credentialFor(cfg, opts);
  const provider = providerOf(cfg, credential);
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
  // Credential by NAME only: the value is placed in the docker client's own environment
  // below, so it never appears in an argument list, a log line, or an image layer (§6).
  if (credential) args.push('-e', credential.name);
  if (opts.authCache) { args.push('-v', opts.authCache.mount); args.push('-e', `CODEX_HOME=${opts.authCache.containerPath}`); }
  // The entrypoint selects its noninteractive command from this, so a Codex task cannot be
  // started by a Claude image invocation or the reverse.
  args.push('-e', `PIPELINE_PROVIDER=${provider}`);
  if (cfg.reasoningEffort) args.push('-e', `PIPELINE_REASONING_EFFORT=${cfg.reasoningEffort}`);
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
    // Exactly one provider credential crosses this boundary. Every other one is removed
    // from the docker client's environment first, so a host that holds both cannot leak
    // the unselected provider's key into a task through `-e NAME` inheritance.
    const credential = credentialFor(cfg, opts);
    const childEnv = { ...DOCKER_ENV };
    for (const name of CREDENTIAL_ENV_NAMES) delete childEnv[name];
    delete childEnv.CODEX_HOME;
    if (credential) childEnv[credential.name] = credential.value;
    const child = (opts.spawn || spawn)("docker", args, { env: childEnv });
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
