// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// Pre-run gates and lifecycle ownership — DESIGN.md §4.12, §4.8, §3.4 (T11).
// The runner owns the run lifecycle end to end: bring the network + sidecar up,
// prove the allowlist holds, assert the image exists, recover stale in-progress
// issues, and tear the network down at run end.
'use strict';
const { spawnSync } = require('child_process');
const path = require('path');
const { bd, bdJson } = require('./bd');
const { deriveNames } = require('./config');
const { acquire, release } = require('./lock');

// The historical shared pair, which is what a config with no project segment gets.
// Asked for by name rather than spelled out again, so the two files cannot drift.
const SHARED = deriveNames('run.config.json');

const sh = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, { encoding: 'utf8', ...opts });

function dockerAvailable() {
  const r = sh('docker', ['info', '--format', 'ok']);
  return r.status === 0;
}

function imageExists(image) {
  return sh('docker', ['image', 'inspect', image]).status === 0;
}

// The network, the proxy sidecar and its port are per project (§4.8 — `config.js`
// derives them when a config names none), and the two shell scripts read them from the
// environment, each falling back to the historical name when unset. Every call that
// creates, probes or destroys plumbing goes through here, so a run can only ever act on
// its own: no code path is left able to reach for a shared default.
function netEnv(cfg) {
  if (!cfg || !cfg.network || !cfg.proxyName || !cfg.proxyPort) {
    throw new Error('internal: run config carries no network/proxy names (loadConfig fills them)');
  }
  return {
    ...process.env,
    PIPELINE_NET: cfg.network,
    PIPELINE_PROXY: cfg.proxyName,
    PIPELINE_PROXY_PORT: String(cfg.proxyPort),
  };
}

function networkUp(repoRoot, cfg, log, traceId) {
  const env = netEnv(cfg);
  // Named before the attempt, not after it: a failure to come up has to say which network
  // and proxy it was trying to create, and this is the line that ties a run in `run.log`
  // to what `docker ps` shows while two projects are in flight. A run that ends up on the
  // shared pair says so — the collision this task removed is only safe while it is
  // visible, and the config file name is the one thing that decides it.
  const shared = cfg.network === SHARED.network || cfg.proxyName === SHARED.proxyName;
  if (log) {
    log.info(traceId, `task network ${cfg.network} + proxy sidecar ${cfg.proxyName} (${cfg.proxyUrl}) coming up`
      + (shared ? ' — the shared default pair (this config names no project segment), so a second run on it would collide' : ''));
  }
  const r = sh('bash', [path.join(repoRoot, 'scripts', 'pipeline-net.sh'), 'up'], { env });
  return { ok: r.status === 0, output: (r.stdout || '') + (r.stderr || '') };
}

function networkDown(repoRoot, cfg) {
  sh('bash', [path.join(repoRoot, 'scripts', 'pipeline-net.sh'), 'down'], { env: netEnv(cfg) });
}

function egressCheck(repoRoot, cfg) {
  // Aimed at the same network, proxy and port the tasks will use — a gate that passes
  // against a different network proves nothing about this run.
  const r = sh('bash', [path.join(repoRoot, 'scripts', 'egress-check.sh')], { env: netEnv(cfg) });
  return { ok: r.status === 0, output: (r.stdout || '') + (r.stderr || '') };
}

// Beads is host-side and the runner is its sole writer (§4.10). An issue left
// in_progress by an abnormal earlier end (operator stop, crash) is stranded —
// the ready queue would never surface it again. Reset it to open with a note.
function recoverStaleIssues(cfg, log, traceId) {
  const res = bdJson(cfg, ['list', '--status', 'in_progress']);
  if (!res.ok) return { recovered: [], error: res.error };
  const recovered = [];
  for (const issue of res.data) {
    bd(cfg, ['update', issue.id, '--status', 'open']);
    bd(cfg, ['note', issue.id, 'runner: reset in_progress -> open at run start (previous run ended abnormally)']);
    recovered.push(issue.id);
    log.info(traceId, `recovered stale in_progress issue ${issue.id} -> open`);
  }
  return { recovered };
}

// Full pre-run sequence. Returns {ok, reason} — ok:false means ABORT THE RUN.
// Every gate after the lock can leave something behind, so each of them releases it on
// the way out: an abort at preflight must leave the project free (§4.12).
function preflight(cfg, repoRoot, log) {
  const t = `${log.runId}/preflight`;
  const abort = (reason) => { release(repoRoot, cfg.targetRepoPath); return { ok: false, reason }; };

  // ---- the project lock: FIRST, ahead of every other gate (§4.12) ----
  // First and not merely early. It is the only purely local check — everything after it
  // probes Docker or writes to Beads, and a refusal that arrives after `bd update` has
  // reset another live run's in_progress issues has not refused anything useful. Being
  // first is also what lets a second run be refused with nothing created to clean up:
  // no network, no sidecar, no container, no Beads write.
  const held = acquire(repoRoot, cfg.targetRepoPath, log.runId);
  if (!held.ok) {
    const h = held.holder;
    return {
      ok: false,
      locked: true,                  // nothing was started — run.js skips teardown
      reason: `${cfg.targetRepoPath} is already being run by run ${h.runId}`
        + ` (pid ${h.pid}${h.since ? `, since ${h.since}` : ''}) — two runners on one Beads queue`
        + ` would claim the same issue twice (§4.10). Wait for that run, or run a different project.`,
    };
  }
  if (held.tookOver) {
    log.info(t, `project lock: took over the lock on ${cfg.targetRepoPath} left by run ${held.previous.runId}`
      + ` (pid ${held.previous.pid}) — that process is gone`,
    { event: 'lock.tookOver', data: { path: cfg.targetRepoPath } });
  }
  log.info(t, `project lock held for ${cfg.targetRepoPath}`,
    { event: 'lock.held', data: { path: cfg.targetRepoPath } });

  if (!dockerAvailable()) return abort('Docker daemon not reachable (is Docker Desktop running?)');
  log.info(t, 'docker daemon reachable');

  if (!imageExists(cfg.image)) {
    return abort(`image '${cfg.image}' not found — build it during planning (§3.4); the runner never builds`);
  }
  log.info(t, `image ${cfg.image} present`);

  const net = networkUp(repoRoot, cfg, log, t);
  if (!net.ok) return abort(`network/sidecar failed to start: ${net.output.trim()}`);
  log.info(t, 'network + proxy sidecar up');

  const eg = egressCheck(repoRoot, cfg);
  if (!eg.ok) return abort(`egress check failed — allowlist not in force: ${eg.output.trim()}`);
  log.info(t, 'egress check passed (allowlist in force)');

  const stale = recoverStaleIssues(cfg, log, t);
  if (stale.error) log.error(t, `stale-issue recovery skipped: ${stale.error}`);

  return { ok: true, recovered: stale.recovered || [] };
}

module.exports = { preflight, networkUp, networkDown, egressCheck, imageExists, dockerAvailable, recoverStaleIssues };
