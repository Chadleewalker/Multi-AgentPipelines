// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// The live queue feed — DESIGN.md §4.12, change-log row `live-queue-feed`.
//
// Until this existed, a run's roster was decided once: `run.js` called `readyQueue(cfg)`,
// handed the resulting array to `drainQueue`, and the pool walked it to the end. An issue
// made ready one minute after the run started waited for the next run.
//
// This module replaces that array with a SOURCE the pool pulls from, which re-reads the
// ready queue while the run is in flight. Feeding a task to a live run is then just `bd` in
// a working session — there is no "submit to the pipeline" command and there must not be
// one, for §3.8's reason: an inbox that can start a container is not an inbox.
//
// Four properties do the work.
//
//   ONLY POLL WHEN A SLOT IS FREE. A worker asks the source for work; that ask is the
//   signal. When every worker is busy there is nothing a poll could act on, so none
//   happens. This matters more than it looks: `readyQueue` is SYNCHRONOUS and reaches both
//   `bd` and `git fetch`, so every poll blocks the runner's event loop for as long as those
//   take. Polling on a timer regardless of demand would tax a busy run for no benefit.
//
//   A FAILED RE-POLL IS NEVER FATAL. `run.js` reacts to an unreadable ready queue at STARTUP
//   with `process.exit(1)`, which is right there — nothing has started, no container is up,
//   no issue is claimed, and the lock releases cleanly. Mid-run the same reaction would kill
//   every running container and strand its issue `in_progress`, and it would fire on a
//   transient `bd` timeout the run could simply have ignored. So a re-poll that fails is
//   logged, the remainder is kept, and the next poll tries again. The run ends only the ways
//   below say it ends.
//
//   AN ISSUE IS DISPATCHED ONCE. Ids handed out are remembered for the life of the run. The
//   queue is re-read, not re-run: `bd ready` keeps reporting an issue until the runner marks
//   it `in_progress`, and between the read and the claim there is a window in which a second
//   read would hand the same issue to a second worker. Both would claim it, both would push
//   a branch for it, and that is the failure the per-project run lock exists to prevent —
//   reintroduced inside one process.
//
//   REFUSALS ARE LIVE, NOT VERDICTS. §4.12's second admission rule refuses a task whose
//   frozen suite is not on the fork branch (change-log rows `dispatch-gate`, `repo-5yu`).
//   That is exactly what a task frozen mid-run looks like for the minutes before its suite
//   is pushed. So refusals are re-evaluated on every poll and only what is STILL refused
//   when the run closes is reported. The gate becomes a wait rather than a verdict.
//
// Node built-ins only, and no wall clock of its own: `now` and `wait` are injected so the
// suite can drive a grace window without sleeping through it (the discipline
// `tests/unit/pause-gate.test.js` already applies to the run-level park).
'use strict';
const fs = require('fs');

const DEFAULT_POLL_MS = 30000;

// How the run ended, for the closing log line and the manifest. Named rather than boolean
// because "the queue ran dry" and "someone asked it to stop" are different facts about an
// unattended run, and the report is where a person finds out which.
const ENDINGS = {
  DRAINED: 'drained',       // classic mode: the roster read at startup is exhausted
  IDLE: 'idle',             // fed mode: nothing new for the whole grace window
  STOPPED: 'stopped',       // the stop sentinel appeared
  HALTED: 'halted',         // an external condition closed the feed (the §7 park's cap)
};

// A source over a FIXED array — today's behaviour, preserved exactly. `drainQueue` wraps a
// plain array in this, so every existing caller and every existing suite keeps its contract:
// the cursor hands items out in ready-queue order and the run ends when the array is spent.
function fixedSource(issues) {
  const queue = Array.from(issues || []);
  let cursor = 0;
  return {
    fed: false,
    async next() {
      if (cursor >= queue.length) return null;
      const index = cursor++;
      return { issue: queue[index], index };
    },
    ending: () => ENDINGS.DRAINED,
    undispatchable: () => [],
    polls: () => 0,
  };
}

// The live source.
//
//   poll()        — re-reads the ready queue. `run.js` passes `() => readyQueue(cfg)`, so the
//                   type filter, the priority-then-FIFO ordering and the dispatch gate all
//                   apply to fed work exactly as they apply to the startup roster. Returns
//                   the same shape: { ok, issues, undispatchable } or { ok:false, error }.
//   concurrency   — how many workers exist, so the source can tell "this worker is idle"
//                   from "the whole run is idle". Only the second starts the grace window.
//   idleGraceMs   — how long the run stays up with nothing to do. 0 is classic mode.
//   pollMs        — the floor between two re-reads, so N idle workers cause one poll, not N.
//   stopFile      — a path whose existence ends the feed.
//   shouldStop()  — an external veto, consulted like the stop file. `run.js` passes the §7
//                   park's `exhausted` flag: once the run-level rate-limit cap has fired,
//                   every further task would be refused and stay `open`, so a run that kept
//                   polling would sit idle handing out work nothing can launch.
function createFeedSource(initial, opts = {}) {
  const {
    poll,
    concurrency = 1,
    idleGraceMs = 0,
    pollMs = DEFAULT_POLL_MS,
    stopFile = null,
    shouldStop = () => false,
    log = null,
    now = () => Date.now(),
    wait = (ms) => new Promise((r) => setTimeout(r, ms)),
  } = opts;

  const remainder = Array.from(initial || []);
  // Every id this run has HANDED OUT, plus every id currently in the remainder. The second
  // half is what stops a poll from re-queueing an issue that is waiting to be dispatched:
  // `bd ready` still reports it, because nothing has claimed it yet.
  const dispatched = new Set();
  // id -> reason, replaced wholesale by each poll. A refusal that clears simply stops being
  // in the map, which is the whole of "refusals are live".
  let refused = new Map(initialRefusals(opts.undispatchable));
  let index = 0;
  let idle = 0;            // workers currently parked in next()
  let idleSince = null;    // when the WHOLE pool went idle; null while anyone is working
  // NEGATIVE INFINITY, not 0. The floor is "not more often than pollMs", not "not for the
  // first pollMs": a pool that goes idle must re-read at once, because the whole reason it is
  // idle is that the user may have just queued something. Seeding this to 0 works by accident
  // against a real `Date.now()` — any wall clock is already past the floor — and silently
  // costs a fed run its first poll interval anywhere the clock starts near zero.
  let lastPoll = -Infinity;
  let polling = false;     // one poll at a time; the others read what it left behind
  let polls = 0;
  let ending = null;
  let stopped = false;

  function initialRefusals(list) {
    return (Array.isArray(list) ? list : [])
      .filter((u) => u && u.issue && u.issue.id)
      .map((u) => [u.issue.id, { issue: u.issue, reason: u.reason }]);
  }

  const note = (msg) => { if (log && typeof log.info === 'function') log.info(log.trace ? log.trace('feed') : null, msg); };
  const warn = (msg) => { if (log && typeof log.error === 'function') log.error(log.trace ? log.trace('feed') : null, msg); };

  function stopRequested() {
    if (stopFile) {
      // A missing file is the normal case and must not be an error: `existsSync` never
      // throws, which is why it is used here rather than a stat in a try.
      try { if (fs.existsSync(stopFile)) return ENDINGS.STOPPED; } catch { /* unreadable = not stopped */ }
    }
    try { if (shouldStop()) return ENDINGS.HALTED; } catch { /* a throwing veto is not a stop */ }
    return null;
  }

  // Re-read the queue and merge what is new. Returns how many issues it added.
  function refill() {
    polls += 1;
    lastPoll = now();
    let res;
    try {
      res = poll();
    } catch (e) {
      // A poll that THROWS is the same class of event as one that returns ok:false, and is
      // treated identically. Letting it propagate would reach the worker loop and take the
      // run down — the fatal re-poll this design exists to avoid.
      res = { ok: false, error: (e && e.message) || String(e) };
    }
    if (!res || !res.ok) {
      warn(`feed: could not re-read the ready queue (${(res && res.error) || 'no reason given'}); `
        + 'keeping what is queued and trying again next poll — the run is not affected');
      return 0;
    }
    refused = new Map(initialRefusals(res.undispatchable));
    const added = [];
    for (const issue of res.issues || []) {
      if (!issue || !issue.id) continue;
      if (dispatched.has(issue.id)) continue;
      remainder.push(issue);
      dispatched.add(issue.id);
      added.push(issue.id);
    }
    if (added.length) note(`feed: picked up ${added.length} new task(s) — ${added.join(', ')}`);
    return added.length;
  }

  // Seed the dispatched set from the startup roster, for the same reason a poll consults it:
  // the first re-poll must not re-queue the issues already waiting in the remainder.
  for (const issue of remainder) if (issue && issue.id) dispatched.add(issue.id);

  const feedOn = idleGraceMs > 0;

  return {
    fed: feedOn,

    async next() {
      for (;;) {
        if (stopped) return null;
        if (remainder.length) {
          // Leaving the idle population is what re-opens the grace window: the run is doing
          // something again, so "nothing has happened for N minutes" starts over.
          if (idleSince !== null) idleSince = null;
          return { issue: remainder.shift(), index: index++ };
        }

        // CLASSIC MODE, and it is checked before every stop condition on purpose. With no
        // grace window the run ends the moment the roster is spent, which is byte-for-byte
        // what `drainQueue` did before this module existed — and, more to the point, the
        // stop conditions below must not reach it. When the §7 park's cap fires mid-drain,
        // a classic run still dispatches its remaining tasks so each one is REFUSED by
        // `gate.admit()` and resolves a `paused` row; a source that stopped handing them out
        // instead would leave them absent from `run.json` altogether, which is the silent
        // hole after an unattended run that `runOneTask`'s refusal branch exists to prevent.
        if (!feedOn) { stopped = true; ending = ENDINGS.DRAINED; return null; }

        const stop = stopRequested();
        if (stop) { stopped = true; ending = stop; return null; }

        idle += 1;
        if (idle >= concurrency && idleSince === null) idleSince = now();
        try {
          // One poll at a time, and never more often than `pollMs`. N idle workers waking
          // together must produce one `bd` call, not N — each of them is a synchronous
          // spawn that blocks the loop for every OTHER worker's container too.
          if (!polling && now() - lastPoll >= pollMs) {
            polling = true;
            try { refill(); } finally { polling = false; }
            if (remainder.length) continue;
          }
          // The grace window is measured from when the WHOLE pool went idle. A worker that
          // finds nothing while its peers are still working simply waits — its peers'
          // tasks may yet queue follow-up work, and more to the point the user may still
          // be freezing the thing they meant to feed in.
          if (idleSince !== null && now() - idleSince >= idleGraceMs) {
            stopped = true;
            ending = ENDINGS.IDLE;
            return null;
          }
          await wait(Math.max(1, Math.min(pollMs, 1000)));
        } finally {
          idle -= 1;
        }
      }
    },

    // What the run should say about how it ended. Null until it has.
    ending: () => ending,
    // Only what is STILL refused. A task refused at 14:05 and frozen at 14:20 ran, and
    // reporting it as undispatchable would be a lie about a task with a PR.
    undispatchable: () => Array.from(refused.values()),
    polls: () => polls,
  };
}

module.exports = { createFeedSource, fixedSource, ENDINGS, DEFAULT_POLL_MS };
