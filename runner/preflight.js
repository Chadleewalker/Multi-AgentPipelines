// Pre-run gates and lifecycle ownership — DESIGN.md §4.12, §4.8, §3.4 (T11).
// The runner owns the run lifecycle end to end: bring the network + sidecar up,
// prove the allowlist holds, assert the image exists, recover stale in-progress
// issues, and tear the network down at run end.
'use strict';
const { spawnSync } = require('child_process');
const path = require('path');
const { bd, bdJson } = require('./bd');

const sh = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, { encoding: 'utf8', ...opts });

function dockerAvailable() {
  const r = sh('docker', ['info', '--format', 'ok']);
  return r.status === 0;
}

function imageExists(image) {
  return sh('docker', ['image', 'inspect', image]).status === 0;
}

function networkUp(repoRoot) {
  const r = sh('bash', [path.join(repoRoot, 'scripts', 'pipeline-net.sh'), 'up']);
  return { ok: r.status === 0, output: (r.stdout || '') + (r.stderr || '') };
}

function networkDown(repoRoot) {
  sh('bash', [path.join(repoRoot, 'scripts', 'pipeline-net.sh'), 'down']);
}

function egressCheck(repoRoot) {
  const r = sh('bash', [path.join(repoRoot, 'scripts', 'egress-check.sh')]);
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
function preflight(cfg, repoRoot, log) {
  const t = `${log.runId}/preflight`;
  if (!dockerAvailable()) return { ok: false, reason: 'Docker daemon not reachable (is Docker Desktop running?)' };
  log.info(t, 'docker daemon reachable');

  if (!imageExists(cfg.image)) {
    return { ok: false, reason: `image '${cfg.image}' not found — build it during planning (§3.4); the runner never builds` };
  }
  log.info(t, `image ${cfg.image} present`);

  const net = networkUp(repoRoot);
  if (!net.ok) return { ok: false, reason: `network/sidecar failed to start: ${net.output.trim()}` };
  log.info(t, 'network + proxy sidecar up');

  const eg = egressCheck(repoRoot);
  if (!eg.ok) return { ok: false, reason: `egress check failed — allowlist not in force: ${eg.output.trim()}` };
  log.info(t, 'egress check passed (allowlist in force)');

  const stale = recoverStaleIssues(cfg, log, t);
  if (stale.error) log.error(t, `stale-issue recovery skipped: ${stale.error}`);

  return { ok: true, recovered: stale.recovered || [] };
}

module.exports = { preflight, networkUp, networkDown, egressCheck, imageExists, dockerAvailable, recoverStaleIssues };
