// Rate-limit pause/resume — DESIGN.md §4.7 (T15).
// A usage limit is a pause, never a failure. The runner parks the task, waits for the
// window (reset time when the container reported one, otherwise a probe on a fixed
// interval), then relaunches a FRESH container against the SAME workspace so
// /workspace/.run/status.json survives and the 3-attempt counter carries over.
'use strict';
const { spawnSync } = require('child_process');

const MINUTE = 60 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The probe runs on the HOST (§4.7): the host has the CLI and the token, and a probe
// needs no sandbox — it does nothing but ask whether the window has reopened.
function probeHost(token) {
  // PIPELINE_PROBE_CMD is a test seam (same idea as PIPELINE_AGENT_CMD): it replaces
  // the real CLI call so suites can exercise the probe path without burning the window.
  const stub = process.env.PIPELINE_PROBE_CMD;
  const r = stub
    ? spawnSync('sh', ['-c', stub], { encoding: 'utf8', timeout: 2 * MINUTE })
    : spawnSync('claude', ['-p', 'ok', '--max-turns', '1'], {
      encoding: 'utf8',
      timeout: 2 * MINUTE,
      env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: token || process.env.CLAUDE_CODE_OAUTH_TOKEN || '' },
    });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  if (r.status === 0) return { open: true };
  if (/usage limit|rate.?limit/i.test(out)) return { open: false };
  // Anything else (CLI missing, network hiccup) must not spin forever: treat as open
  // and let the relaunched container discover the truth.
  return { open: true, note: (out.split('\n')[0] || 'probe inconclusive').trim() };
}

// How long to wait before the next relaunch attempt.
function waitPlan(status, cfg, now) {
  const resetAt = status && status.rateLimitResetAt ? Date.parse(status.rateLimitResetAt) : NaN;
  if (!Number.isNaN(resetAt)) {
    const ms = Math.max(0, resetAt - now) + 5000; // small cushion past the boundary
    return { kind: 'reset-time', ms, until: new Date(resetAt).toISOString() };
  }
  return { kind: 'probe', ms: cfg.probeIntervalMinutes * MINUTE };
}

// Park until the window reopens. Returns {resumed:true, pauses} or {resumed:false, reason}
// when a stop condition fires (deadline exceeded / operator stop).
//
// The cap counts wait cycles for the WHOLE task, not for one call: on the reset-time path
// this returns after a single cycle, so the caller re-enters it once per relaunch and must
// hand back the cycles already spent via opts.spentCycles. Without that the counter
// restarts at 1 every pause and the stop condition can never fire — a container that keeps
// reporting a stale or already-elapsed reset time would relaunch forever.
async function waitForWindow(cfg, status, log, traceId, opts = {}) {
  const token = opts.token;
  const sleepFn = opts.sleepFn || sleep;
  const probe = opts.probeFn || probeHost;
  const now = opts.now || Date.now;
  const maxPauses = opts.maxPauses === undefined ? 96 : opts.maxPauses; // ~24h at 15m
  const spent = opts.spentCycles || 0;

  if (spent >= maxPauses) return { resumed: false, reason: `still rate-limited after ${spent} pause cycles` };

  for (let i = spent + 1; i <= maxPauses; i++) {
    const plan = waitPlan(status, cfg, now());
    if (plan.kind === 'reset-time') {
      log.info(traceId, `paused: waiting until reported reset ${plan.until} (${Math.round(plan.ms / MINUTE)}m)`);
    } else {
      log.info(traceId, `paused: no reset time reported; probing every ${cfg.probeIntervalMinutes}m (attempt ${i})`);
    }
    await sleepFn(plan.ms);

    if (plan.kind === 'reset-time') {
      log.info(traceId, 'reset time reached — resuming');
      return { resumed: true, pauses: i };
    }
    const p = probe(token);
    if (p.open) {
      log.info(traceId, `probe succeeded${p.note ? ` (${p.note})` : ''} — resuming`);
      return { resumed: true, pauses: i };
    }
    log.info(traceId, 'probe still rate-limited — continuing to wait');
  }
  return { resumed: false, reason: `still rate-limited after ${maxPauses} pause cycles` };
}

module.exports = { waitForWindow, waitPlan, probeHost };
