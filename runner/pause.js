// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// Rate-limit pause/resume — DESIGN.md §4.7, §7.
// A usage limit is a pause, never a failure. The runner parks the task, waits for the
// window (reset time when the container reported one, otherwise a probe on a fixed
// interval), then relaunches a FRESH container against the SAME workspace so
// /workspace/.run/status.json survives and the 3-attempt counter carries over.
//
// Two layers: waitForWindow is ONE wait, and createPauseGate (§7) is the run-level park
// that owns the single shared wait and the single cycle counter for the whole run.
'use strict';
const { DEFAULTS } = require('./config');
const { commandFor } = require('./host-shell');
const { runSync } = require('./process');

const MINUTE = 60 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The probe runs on the HOST (§4.7): the host has the CLI and the token, and a probe
// needs no sandbox — it does nothing but ask whether the window has reopened.
function probeHost(token, hostShell, cfg) {
  // PIPELINE_PROBE_CMD is a test seam (same idea as PIPELINE_AGENT_CMD): it replaces
  // the real CLI call so suites can exercise the probe path without burning the window.
  const stub = process.env.PIPELINE_PROBE_CMD;
  const r = stub
    ? runSync(hostShell || 'sh', ['-c', stub], { cfg, label: 'rate-limit probe seam' })
    : runSync('claude', ['-p', 'ok', '--max-turns', '1'], {
      cfg,
      label: 'rate-limit probe',
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

// Park until the window reopens. Resolves one of exactly two shapes:
//
//   { resumed: true,  pauses: <the cycle count reached> }
//   { resumed: false, reason: <string> }        // NO count field — deliberately
//
// The cycle cap is the ONLY stop condition here: there is no deadline and no operator
// stop, whatever an earlier comment claimed. The failure branch carries no count because
// there is nothing new to report — the caller keeps whatever it already had rather than
// reading a field that is not there (which is how a run-level counter becomes NaN).
//
// The cap counts wait cycles for the WHOLE RUN, not for one call: on the reset-time path
// this returns after a single cycle, so the caller re-enters it once per pause and must
// hand back the cycles already spent via opts.spentCycles. Without that the counter
// restarts at 1 every pause and the stop condition can never fire — a container that keeps
// reporting a stale or already-elapsed reset time would relaunch forever. createPauseGate
// below is what holds that count now, once for the run rather than once per task.
async function waitForWindow(cfg, status, log, traceId, opts = {}) {
  const token = opts.token;
  const sleepFn = opts.sleepFn || sleep;
  const probe = opts.probeFn || ((value) => probeHost(value, commandFor(cfg, 'sh'), cfg));
  const now = opts.now || Date.now;
  // The default lives in config.js's DEFAULTS and nowhere else: a second copy here drifts
  // silently, and the cap is the only thing bounding the loop.
  const maxPauses = opts.maxPauses === undefined ? DEFAULTS.maxPauseCycles : opts.maxPauses;
  const spent = opts.spentCycles || 0;

  if (spent >= maxPauses) return { resumed: false, reason: `still rate-limited after ${spent} pause cycles` };

  for (let i = spent + 1; i <= maxPauses; i++) {
    const plan = waitPlan(status, cfg, now());
    if (plan.kind === 'reset-time') {
      log.info(traceId, `paused: waiting until reported reset ${plan.until} (${Math.round(plan.ms / MINUTE)}m)`,
        { event: 'park.waiting', data: { until: String(plan.until) } });
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

// ---- the run-level park (§7) --------------------------------------------------------
// A usage limit is a property of the SUBSCRIPTION WINDOW, not of a task. At concurrency
// > 1, N parked tasks each running their own pause loop are N uncoordinated sleeps against
// one shared window, each with its own cap. The gate makes the park RUN-LEVEL: one shared
// wait, one cycle counter for the whole run, and a pool that admits no NEW work while the
// window is closed.
//
// Four things it deliberately does NOT do:
//
//   * It never kills a live container. Park means "admit no new work", never "stop what is
//     running": killing a container discards agent work that may be minutes from finishing
//     and spends wall-clock budget for nothing, and a container whose window is genuinely
//     closed hits the limit and exits 20 by itself.
//   * It never extends a wait. A second exit 20 arriving while a wait is in flight JOINS
//     it, on the FIRST reporter's reset time. If the window is still closed when that wait
//     ends, the relaunched tasks exit 20 again and open a fresh wait — self-correcting,
//     and bounded by the run-level cap.
//   * It never opens a wait from admit(). Only a reported limit opens one; admission only
//     ever joins, refuses, or passes straight through.
//   * It never invents a cycle count. The count is read from `pauses` on a waitFn result
//     and from nowhere else, so a result carrying none (every resumed:false) leaves the
//     counter exactly as it was — not NaN, and not reset to zero.
//
// createPauseGate(cfg, log, opts) -> gate
//   opts.waitFn  defaults to waitForWindow above, called as
//                waitFn(cfg, status, log, traceId,
//                       { token, spentCycles, maxPauses, sleepFn, probeFn })
//   opts.token / opts.sleepFn / opts.probeFn are forwarded unchanged.
//   gate.reportLimit(status, traceId) -> {resumed, cycles, joined, exhausted?, reason?}
//   gate.admit(traceId)               -> boolean
//   gate.cycles / gate.exhausted / gate.waits
function createPauseGate(cfg, log, opts = {}) {
  const waitFn = opts.waitFn || waitForWindow;
  const maxPauses = (cfg && cfg.maxPauseCycles) || DEFAULTS.maxPauseCycles;

  // The ONE shared wait, while it is in flight. `token` identifies it so a wait that has
  // already been superseded cannot clear its successor's slot.
  let waitPromise = null;
  let waitToken = null;

  const gate = { cycles: 0, exhausted: false, waits: 0, reportLimit, admit };

  function openWait(status, traceId) {
    gate.waits += 1;
    const mine = {};
    waitToken = mine;
    const p = (async () => {
      let result;
      try {
        result = await waitFn(cfg, status, log, traceId, {
          token: opts.token,
          spentCycles: gate.cycles,
          maxPauses,
          sleepFn: opts.sleepFn,
          probeFn: opts.probeFn,
        });
      } catch (e) {
        // A wait that throws is a closed window we can no longer measure. Treat it as a
        // stop rather than as a resume: relaunching into an unknown window would burn the
        // attempt counter of every parked task at once.
        result = { resumed: false, reason: `the run-level pause wait threw — ${e && e.message ? e.message : e}` };
      }
      // Reopen the gate BEFORE settling, so a joiner that re-checks on resumption sees the
      // window open rather than the wait it just left.
      if (waitToken === mine) { waitToken = null; waitPromise = null; }
      if (result && Number.isFinite(result.pauses)) gate.cycles = result.pauses;
      if (!result || result.resumed !== true) {
        gate.exhausted = true;
        const reason = (result && typeof result.reason === 'string' && result.reason)
          || `the run-level pause wait did not resume after ${gate.cycles} cycle(s)`;
        log.error(traceId, `run-level park: no more waits this run — ${reason}`);
        return { resumed: false, cycles: gate.cycles, exhausted: true, reason };
      }
      log.info(traceId, `run-level park: the window reopened (${gate.cycles}/${maxPauses} wait cycles spent)`,
        { event: 'park.reopened', data: {} });
      return { resumed: true, cycles: gate.cycles };
    })();
    waitPromise = p;
    return p;
  }

  // The join decision is made SYNCHRONOUSLY on entry, before any await: N containers that
  // hit the limit in the same tick must find one wait between them, not N.
  function reportLimit(status, traceId) {
    if (gate.exhausted) {
      return Promise.resolve({
        resumed: false,
        cycles: gate.cycles,
        joined: false,
        exhausted: true,
        reason: `the run-level pause cap (${maxPauses} cycles) has already fired`,
      });
    }
    if (waitPromise) {
      log.info(traceId, 'rate limit: joining the run-level wait already in flight');
      return waitPromise.then((r) => ({ ...r, joined: true }));
    }
    if (gate.cycles >= maxPauses) {
      gate.exhausted = true;
      const reason = `still rate-limited after ${gate.cycles} run-level pause cycles (cap ${maxPauses})`;
      log.error(traceId, `run-level park: ${reason}`);
      return Promise.resolve({ resumed: false, cycles: gate.cycles, joined: false, exhausted: true, reason });
    }
    log.info(traceId, `rate limit: opening the run-level wait (${gate.cycles}/${maxPauses} cycles spent)`,
      { event: 'park.opened', data: { cycles: gate.cycles, max: maxPauses } });
    return openWait(status, traceId).then((r) => ({ ...r, joined: false }));
  }

  // Exactly three states: open (admit at once), closed (hold until the shared wait ends,
  // then re-check), exhausted (refuse, for this caller and every later one).
  async function admit(traceId) {
    for (;;) {
      if (gate.exhausted) return false;
      const held = waitPromise;
      if (!held) return true;
      log.info(traceId, 'holding: the run-level rate-limit park is open — no new task launches');
      await held;
    }
  }

  return gate;
}

module.exports = { waitForWindow, waitPlan, probeHost, createPauseGate };
