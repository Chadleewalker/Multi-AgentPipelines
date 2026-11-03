// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// Container launch + wall-clock enforcement — DESIGN.md §4.1, §4.2, §4.6, §4.10 (T14).
// One fresh container per task. The host holds every credential and every timer; the
// enforcer never lives inside the thing it may need to kill.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { toMountPath } = require('./bd');
const { runCommand } = require('./host-shell');

// Windows/Git Bash: Docker needs C:/... mount sources, and MSYS must not rewrite
// container-side paths like /workspace into C:\Program Files\Git\workspace.
const DOCKER_ENV = { ...process.env, MSYS_NO_PATHCONV: '1' };

// ---- the image a launch actually ran (§4.12, repo-xwx) -------------------------------
// Recorded on the manifest row so a target's own host-side check can tell whether a tree
// the verifier already proved was proved against THIS image. Evidence only: every failure
// here leaves the field off the row and changes nothing about the task.
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;

// `docker image inspect --format {{.Id}} <image>`. PIPELINE_DOCKER_CMD is a test seam,
// run through the host shell exactly as PIPELINE_GH_CMD is (runner/publish.js); production
// never sets it and spawns docker directly with MSYS_NO_PATHCONV, like every other runner
// docker call. The env is built here rather than from the module-level DOCKER_ENV, which
// snapshots process.env at require time and so cannot see a PATH a caller set afterwards.
//
// The answer is pinned by VALUE, not by presence: `docker image inspect` exits 0 while
// printing prose for a missing object, and a CLI warning line ahead of a real id is
// non-empty, well-formed and not an image id. Only a trimmed output that is exactly one
// sha256 digest is recorded.
function inspectImageId(cfg, log, traceId) {
  const image = cfg && cfg.image;
  if (!image) return null;
  const seam = process.env.PIPELINE_DOCKER_CMD;
  const r = seam
    ? runCommand(`${seam} image inspect --format '{{.Id}}' ${image}`, { encoding: 'utf8' })
    : (() => {
      try {
        return spawnSync('docker', ['image', 'inspect', '--format', '{{.Id}}', image],
          { encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
      } catch (error) {
        return { status: null, stdout: '', stderr: error.message, error };
      }
    })();
  const out = String((r && r.stdout) || '').trim();
  if (!r || r.status !== 0) {
    const why = (((r && r.error && r.error.message) || String((r && r.stderr) || '').trim())
      || `exit ${r ? r.status : 'none'} with no output`).trim();
    log.error(traceId, `could not read the image id for ${image}: ${why} — the run record carries no imageId`);
    return null;
  }
  if (!IMAGE_ID.test(out)) {
    log.error(traceId, `\`docker image inspect\` did not answer with exactly one image id for ${image} `
      + `(got ${JSON.stringify(out.slice(0, 200))}) — the run record carries no imageId`);
    return null;
  }
  return out;
}

// The container's inputs are exactly these (§4.10) — nothing else crosses the boundary.
function buildArgs(cfg, opts) {
  const { containerName, workspaceDir, pipelineDir, issueId, token, forkPoint } = opts;
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
  // The HOST-PINNED trusted fork SHA (repo-cl10). The verifier reads its config from this
  // commit; passing it in stops a task redirecting the fork with a mutable defaultBranch,
  // config edit, or an agent-created ref inside its own workspace (DESIGN.md §4.4).
  if (forkPoint) args.push('-e', `PIPELINE_FORK_POINT=${forkPoint}`);
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

module.exports = { runTask, buildArgs, inspectImageId };
