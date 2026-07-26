// Container launch + wall-clock enforcement — DESIGN.md §4.1, §4.2, §4.6, §4.10 (T14).
// One fresh container per task. The host holds every credential and every timer; the
// enforcer never lives inside the thing it may need to kill.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { toMountPath } = require('./bd');

// Windows/Git Bash: Docker needs C:/... mount sources, and MSYS must not rewrite
// container-side paths like /workspace into C:\Program Files\Git\workspace.
const DOCKER_ENV = { ...process.env, MSYS_NO_PATHCONV: '1' };

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

    log.info(traceId, `launching container ${opts.containerName} (budget ${Math.round(budgetMs / 60000)}m active)`);
    const child = spawn('docker', args, {
      env: { ...DOCKER_ENV, CLAUDE_CODE_OAUTH_TOKEN: opts.token || '' },
    });
    child.stdout.pipe(logStream);
    child.stderr.pipe(logStream);

    let timedOut = false;
    // Wall clock is a Node timer + `docker kill` — never a platform `timeout` (§6).
    const timer = setTimeout(() => {
      timedOut = true;
      log.error(traceId, `wall-clock budget exhausted — killing ${opts.containerName}`);
      spawnSync('docker', ['kill', opts.containerName], { env: DOCKER_ENV });
    }, budgetMs);

    child.on('close', (code) => {
      clearTimeout(timer);
      const durationMs = Date.now() - started;
      resolve({
        exitCode: timedOut ? 'killed' : code,
        killed: timedOut,
        durationMs,
      });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      log.error(traceId, `docker run failed to start: ${err.message}`);
      resolve({ exitCode: 30, killed: false, durationMs: Date.now() - started });
    });
  });
}

module.exports = { runTask, buildArgs };
