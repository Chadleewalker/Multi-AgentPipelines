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
const { providerFor, CODEX_API_KEY_VAR } = require('./agent-provider');

// The credential variable each provider's container CLI authenticates with (§6). One
// name per provider and never both: a Codex task must not be handed an Anthropic token
// it has no use for, and vice versa. The value never appears here — only the name.
const CLAUDE_TOKEN_VAR = 'CLAUDE_CODE_OAUTH_TOKEN';
const CREDENTIAL_VAR = { claude: CLAUDE_TOKEN_VAR, codex: CODEX_API_KEY_VAR };

// Windows/Git Bash: Docker needs C:/... mount sources, and MSYS must not rewrite
// container-side paths like /workspace into C:\Program Files\Git\workspace.
const DOCKER_ENV = { ...process.env, MSYS_NO_PATHCONV: '1' };
// The watchdog only ever runs `docker kill`. It is given neither provider's credential,
// so a kill that outlives the run cannot carry one — and BOTH names are stripped, because
// this process inherits whichever the operator exported.
const WATCHDOG_DOCKER_ENV = { ...DOCKER_ENV };
for (const name of Object.values(CREDENTIAL_VAR)) delete WATCHDOG_DOCKER_ENV[name];

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
  // Credential by NAME only, and only the selected provider's: the value comes from the
  // runner's environment, so it never appears in an argument list, a log line, or an
  // image layer (§6). A Codex task therefore gets CODEX_API_KEY and no Anthropic token.
  const provider = providerFor(cfg, null);
  if (token) args.push('-e', CREDENTIAL_VAR[provider] || CLAUDE_TOKEN_VAR);
  // Which noninteractive command the entrypoint builds. Passed even for claude so the
  // container never has to infer a provider from which credential it happens to hold.
  args.push('-e', `PIPELINE_PROVIDER=${provider}`);
  if (cfg.agentCommand) args.push('-e', `PIPELINE_AGENT_CMD=${cfg.agentCommand}`);
  // The entrypoint appends the model (and, for Codex, the reasoning effort) to its default
  // headless invocation; an explicit agentCommand (stubs, overrides) owns its own flags
  // and ignores both.
  if (cfg.model) args.push('-e', `PIPELINE_MODEL=${cfg.model}`);
  if (provider === 'codex' && cfg.reasoningEffort) {
    args.push('-e', `PIPELINE_REASONING_EFFORT=${cfg.reasoningEffort}`);
  }
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
    // The value crosses here and nowhere else: `docker run` reads it from this process's
    // environment because buildArgs passed only the NAME. Exactly one provider's variable
    // is set, so a Codex container cannot see an Anthropic token or the reverse.
    const credentialVar = CREDENTIAL_VAR[providerFor(cfg, null)] || CLAUDE_TOKEN_VAR;
    const childEnv = { ...DOCKER_ENV };
    for (const name of Object.values(CREDENTIAL_VAR)) delete childEnv[name];
    childEnv[credentialVar] = opts.token || '';
    const child = spawn('docker', args, { env: childEnv });
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
