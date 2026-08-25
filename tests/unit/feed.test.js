// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// The re-runnable suite for the LIVE QUEUE FEED — the source that lets one run pick up work
// frozen after it started (DESIGN.md §4.12, change-log row `live-queue-feed`). Docker-free,
// network-free and clock-free: it drives `runner/feed.js`'s `createFeedSource` directly and
// `runner/run.js`'s exported `drainQueue` over it.
//
// NOTHING HERE TURNS ON WALL CLOCK. A grace window is a thing that WAITS, so a suite that
// really slept would take minutes and would flake on a loaded machine; `now` and `wait` are
// injected and time is a number this file advances, the discipline
// `tests/unit/pause-gate.test.js` already applies to the run-level park.
//
// The fixtures are chosen so a PLAUSIBLE WRONG IMPLEMENTATION FAILS, not merely so the code
// is exercised. Four carry the weight:
//
//   * A poll that keeps reporting an issue already dispatched. This is not a contrived
//     input — it is what `bd ready` really does in the window between a read and the claim
//     that follows it. An implementation that merges every poll's results dispatches the
//     same issue twice, and two workers then claim one issue and push two branches for it:
//     the exact failure the per-project run lock exists to prevent, reintroduced inside one
//     process. Nothing else in this file catches it.
//   * ONE worker idle while another works, at concurrency 2. Every other timing fixture is
//     answered the same way by an implementation that starts the grace clock on the first
//     idle worker; only this one tells that apart from starting it when the POOL is idle,
//     and getting it wrong closes a fed run the moment its first task finishes.
//   * A poll that returns ok:false, and a poll that THROWS. The startup read aborts the run
//     with `process.exit(1)` and is right to; the same reaction mid-run kills every live
//     container and strands its issue `in_progress`. Both failure shapes must be survivable,
//     because a throw reaching the worker loop takes the run down just as an exit does.
//   * The feed OFF. It is the default and it is what every existing project runs, so the
//     check that matters most is that the poll function is never called at all — an
//     implementation that polls once "just to be safe" has changed every run in the estate.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
let failed = 0;
function check(name, cond) {
  console.log(`${cond ? 'ok' : 'FAIL'} - ${name}`);
  if (!cond) failed = 1;
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'unit-feed-'));

// =====================================================================================
// Requirability — the same guard `tests/unit/concurrency.test.js` pins, for the same
// reason: main() must stay behind `require.main === module` or none of this is reachable.
// =====================================================================================
const RUN_JS = path.join(ROOT, 'runner', 'run.js');
const probe = spawnSync(process.execPath, [
  '-e',
  'const m = require(process.argv[1]); process.stdout.write(JSON.stringify(Object.keys(m || {})));',
  RUN_JS,
], { encoding: 'utf8', timeout: 30000 });
check('runner/run.js is still requirable with the feed wired in (main() is guarded)', probe.status === 0);

const { createFeedSource, fixedSource, ENDINGS } = require(path.join(ROOT, 'runner', 'feed.js'));
const { drainQueue } = require(RUN_JS);
const { loadConfig, DEFAULTS } = require(path.join(ROOT, 'runner', 'config.js'));

check('runner/feed.js exports createFeedSource', typeof createFeedSource === 'function');
check('runner/feed.js exports fixedSource', typeof fixedSource === 'function');

// ---- fixtures -----------------------------------------------------------------------

const issue = (id, priority = 2) => ({ id, title: `task ${id}`, issue_type: 'task', priority });
const ready = (...ids) => ({ ok: true, issues: ids.map((i) => (typeof i === 'string' ? issue(i) : i)), undispatchable: [] });

// A virtual clock. `wait` is the only thing that advances it, which is what makes every
// timing assertion below deterministic: the source's own wait loop drives time forward, so
// the sequence of events is fixed no matter how loaded the machine is.
function clock(limit = 2000) {
  let t = 1000;
  let waits = 0;
  return {
    now: () => t,
    waits: () => waits,
    wait: async (ms) => {
      waits += 1;
      // A loud failure instead of a hang. A source that never reaches a stop condition would
      // otherwise spin until the sweep's 900s killer noticed, and report nothing at all.
      if (waits > limit) throw new Error(`feed source did not stop after ${limit} waits — it is not converging`);
      t += ms;
      await new Promise((r) => setImmediate(r));
    },
  };
}

// Runs a source to exhaustion through the real drainQueue and records dispatch order.
async function drain(source, concurrency, body = async () => {}) {
  const dispatched = [];
  const rows = await drainQueue(source, async (iss, i) => {
    dispatched.push(`${iss.id}@${i}`);
    await body(iss, i);
    return { issueId: iss.id, outcome: 'done' };
  }, concurrency);
  return { dispatched, rows };
}

(async () => {
  // ===================================================================================
  // THE FEED OFF — the default, and what every existing project runs
  // ===================================================================================
  {
    let polled = 0;
    const c = clock();
    const source = createFeedSource([issue('a-1'), issue('a-2')], {
      poll: () => { polled += 1; return ready('a-3'); },
      concurrency: 2,
      idleGraceMs: 0,
      now: c.now,
      wait: c.wait,
    });
    const { dispatched, rows } = await drain(source, 2);
    check('feed off: reports itself off (source.fed is false)', source.fed === false);
    check('feed off: THE QUEUE IS NEVER RE-READ (poll called zero times)', polled === 0);
    check('feed off: polls() is 0', source.polls() === 0);
    check('feed off: dispatches exactly the startup roster', dispatched.length === 2
      && dispatched.includes('a-1@0') && dispatched.includes('a-2@1'));
    check('feed off: never dispatches what a poll would have returned', !dispatched.some((d) => d.startsWith('a-3')));
    check('feed off: the run ends "drained"', source.ending() === ENDINGS.DRAINED);
    check('feed off: one row per dispatched task', rows.filter(Boolean).length === 2);
  }

  // A fixed source is what an ARRAY becomes inside drainQueue, and the historic contract
  // it has to keep is index alignment with ready-queue order.
  {
    const { dispatched } = await drain([issue('f-1'), issue('f-2'), issue('f-3')], 1);
    check('drainQueue still accepts a plain array (the historic contract)',
      dispatched.join(',') === 'f-1@0,f-2@1,f-3@2');
    const empty = await drainQueue([], async () => { throw new Error('must not run'); }, 4);
    check('drainQueue over an empty array still runs nothing', Array.isArray(empty) && empty.length === 0);
  }

  // ===================================================================================
  // THE CORE — work that arrives after the pool has gone idle
  // ===================================================================================
  {
    const c = clock();
    const polls = [ready(), ready('b-2'), ready(), ready()];
    let n = 0;
    const source = createFeedSource([issue('b-1')], {
      poll: () => polls[Math.min(n++, polls.length - 1)],
      concurrency: 1,
      idleGraceMs: 60000,
      pollMs: 1000,
      now: c.now,
      wait: c.wait,
    });
    const { dispatched } = await drain(source, 1);
    check('feed on: reports itself on (source.fed is true)', source.fed === true);
    check('feed on: PICKS UP WORK QUEUED AFTER THE POOL WENT IDLE', dispatched.join(',') === 'b-1@0,b-2@1');
    check('feed on: dispatch indices stay dense and sequential', dispatched[1].endsWith('@1'));
    check('feed on: the run ends "idle" once the grace window expires', source.ending() === ENDINGS.IDLE);
    check('feed on: it really re-read the queue', source.polls() >= 2);
  }

  // ===================================================================================
  // AN ISSUE IS DISPATCHED ONCE — the check nothing else in this file makes
  // ===================================================================================
  {
    const c = clock();
    // Exactly what `bd ready` does: c-1 is still open, and still reported, until the runner
    // claims it. Every poll sees it again.
    const source = createFeedSource([issue('c-1')], {
      poll: () => ready('c-1'),
      concurrency: 2,
      idleGraceMs: 5000,
      pollMs: 1000,
      now: c.now,
      wait: c.wait,
    });
    const { dispatched } = await drain(source, 2);
    const times = dispatched.filter((d) => d.startsWith('c-1@')).length;
    check('a re-poll that still reports a dispatched issue does NOT dispatch it twice', times === 1);
    check('and nothing else was invented', dispatched.length === 1);
  }

  // The same guard against the STARTUP roster: the first re-poll must not re-queue an issue
  // that is sitting in the remainder waiting for a free worker.
  {
    const c = clock();
    const source = createFeedSource([issue('d-1'), issue('d-2'), issue('d-3')], {
      poll: () => ready('d-1', 'd-2', 'd-3'),
      concurrency: 1,
      idleGraceMs: 5000,
      pollMs: 1000,
      now: c.now,
      wait: c.wait,
    });
    const { dispatched } = await drain(source, 1);
    check('the startup roster is not re-queued by the first poll', dispatched.length === 3);
  }

  // ===================================================================================
  // A FAILED RE-POLL IS NEVER FATAL
  // ===================================================================================
  {
    const c = clock();
    let n = 0;
    const source = createFeedSource([issue('e-1')], {
      poll: () => {
        n += 1;
        if (n === 1) return { ok: false, error: 'bd timed out after 60000ms (run.config.json bdTimeoutMs) and was killed' };
        if (n === 2) throw new Error('spawnSync ENOENT');
        return ready('e-2');
      },
      concurrency: 1,
      idleGraceMs: 20000,
      pollMs: 1000,
      now: c.now,
      wait: c.wait,
    });
    let threw = null;
    let dispatched = [];
    try { ({ dispatched } = await drain(source, 1)); } catch (err) { threw = err; }
    check('a re-poll returning ok:false does not take the run down', threw === null);
    check('a re-poll that THROWS does not take the run down either', threw === null);
    check('the task that did run is still dispatched', dispatched.includes('e-1@0'));
    check('and the run recovers: work from a later, successful poll is picked up',
      dispatched.includes('e-2@1'));
  }

  // ===================================================================================
  // REFUSALS ARE LIVE, NOT VERDICTS (§4.12's second admission rule)
  // ===================================================================================
  {
    const c = clock();
    let n = 0;
    const refusedOnce = {
      ok: true,
      issues: [],
      undispatchable: [{ issue: issue('g-1'), reason: 'no frozen acceptance suite at tests/acceptance/g-1/ on main' }],
    };
    const source = createFeedSource([], {
      poll: () => (++n <= 1 ? refusedOnce : ready('g-1')),
      concurrency: 1,
      idleGraceMs: 20000,
      pollMs: 1000,
      now: c.now,
      wait: c.wait,
    });
    const { dispatched } = await drain(source, 1);
    check('a task refused for a missing suite is dispatched once the suite is pushed',
      dispatched.includes('g-1@0'));
    check('and it is NOT also reported undispatchable — it has a PR', source.undispatchable().length === 0);
  }
  {
    const c = clock();
    const stillRefused = {
      ok: true,
      issues: [],
      undispatchable: [{ issue: issue('h-1'), reason: 'no frozen acceptance suite at tests/acceptance/h-1/ on main' }],
    };
    const source = createFeedSource([], {
      poll: () => stillRefused,
      concurrency: 1,
      idleGraceMs: 5000,
      pollMs: 1000,
      now: c.now,
      wait: c.wait,
    });
    const { dispatched } = await drain(source, 1);
    check('a task still refused when the run closes is never dispatched', dispatched.length === 0);
    const left = source.undispatchable();
    check('and it IS reported, with its reason, so the report can name the remedy',
      left.length === 1 && left[0].issue.id === 'h-1' && /frozen acceptance suite/.test(left[0].reason));
  }

  // ===================================================================================
  // THE GRACE WINDOW IS THE POOL'S, NOT A WORKER'S
  // ===================================================================================
  {
    const c = clock();
    let release = null;
    const held = new Promise((r) => { release = r; });
    let polls = 0;
    const source = createFeedSource([issue('i-1')], {
      poll: () => { polls += 1; return ready(); },
      concurrency: 2,
      idleGraceMs: 10000,     // ten virtual seconds
      pollMs: 1000,
      now: c.now,
      wait: c.wait,
    });
    // i-1 is held open, so worker A is busy for the whole grace window while worker B idles.
    // An implementation that starts the clock on B alone ends the run here and never
    // dispatches i-2; the correct one waits, because the POOL is not idle.
    const drained = drain(source, 2, async (iss) => { if (iss.id === 'i-1') await held; });
    // Let B spin well past the grace window with A still working.
    for (let k = 0; k < 40; k++) await new Promise((r) => setImmediate(r));
    check('one idle worker does not start the grace clock while another is working',
      source.ending() === null);
    check('and the idle worker did poll while it waited', polls >= 1);
    release();
    const { dispatched } = await drained;
    check('once the whole pool is idle the grace window runs and the run closes',
      source.ending() === ENDINGS.IDLE);
    check('the held task still completed normally', dispatched.includes('i-1@0'));
  }

  // ===================================================================================
  // THE POLL FLOOR — N idle workers make one `bd` call, not N
  // ===================================================================================
  {
    const c = clock();
    let polls = 0;
    // The wait step is capped at 1000, so an idle pool takes ~20 passes to spend this grace
    // window. With the floor honoured that is ~4 re-reads; without it, one per pass per
    // worker. The gap between those two numbers is the whole check, which is why the floor
    // is set well above the wait step rather than equal to it.
    const source = createFeedSource([], {
      poll: () => { polls += 1; return ready(); },
      concurrency: 4,
      idleGraceMs: 20000,
      pollMs: 5000,
      now: c.now,
      wait: c.wait,
    });
    await drain(source, 4);
    check('four idle workers do not each re-read the queue on every pass',
      polls > 0 && polls <= 8);
    check('polls() reports what actually happened', source.polls() === polls);
  }

  // The floor is a CEILING ON FREQUENCY, not a delay before the first read. A pool that has
  // just gone idle re-reads immediately — it is idle precisely because the user may have
  // queued something a moment ago, and making them wait out a poll interval to find out is
  // the difference between a feed that feels live and one that feels broken.
  {
    const c = clock();
    let polls = 0;
    const source = createFeedSource([], {
      poll: () => { polls += 1; return polls === 1 ? ready('m-1') : ready(); },
      concurrency: 1,
      idleGraceMs: 5000,
      pollMs: 600000,          // ten minutes: nothing may wait for this
      now: c.now,
      wait: c.wait,
    });
    const { dispatched } = await drain(source, 1);
    check('an idle pool re-reads AT ONCE, it does not sit out a poll interval first',
      dispatched.includes('m-1@0'));
    check('and then honours the floor', polls === 1);
  }

  // ===================================================================================
  // STOPPING A FED RUN
  // ===================================================================================
  {
    const c = clock();
    const stopFile = path.join(TMP, 'stop');
    fs.writeFileSync(stopFile, '');
    const source = createFeedSource([issue('j-1')], {
      poll: () => ready('j-2'),
      concurrency: 1,
      idleGraceMs: 60000,
      pollMs: 1000,
      stopFile,
      now: c.now,
      wait: c.wait,
    });
    const { dispatched } = await drain(source, 1);
    check('the stop sentinel ends the feed', source.ending() === ENDINGS.STOPPED);
    check('work already queued still runs', dispatched.includes('j-1@0'));
    check('nothing new is taken on after the sentinel appears', dispatched.length === 1);
    fs.unlinkSync(stopFile);
  }
  {
    const c = clock();
    const source = createFeedSource([], {
      poll: () => ready('k-1'),
      concurrency: 1,
      idleGraceMs: 60000,
      pollMs: 1000,
      stopFile: path.join(TMP, 'absent-sentinel'),
      now: c.now,
      wait: c.wait,
    });
    const { dispatched } = await drain(source, 1);
    check('a sentinel that does not exist is not an error', dispatched.includes('k-1@0'));
  }
  {
    const c = clock();
    let exhausted = false;
    const source = createFeedSource([issue('l-1')], {
      poll: () => ready(),
      concurrency: 1,
      idleGraceMs: 60000,
      pollMs: 1000,
      // The §7 park's cap, which run.js wires to `gate.exhausted`.
      shouldStop: () => exhausted,
      now: c.now,
      wait: c.wait,
    });
    const drained = drain(source, 1, async () => { exhausted = true; });
    const { dispatched } = await drained;
    check('a fired run-level rate-limit cap closes the feed instead of idling',
      source.ending() === ENDINGS.HALTED);
    check('the task that ran before the cap fired is unaffected', dispatched.includes('l-1@0'));
  }
  {
    const c = clock();
    const source = createFeedSource([], {
      poll: () => ready(),
      concurrency: 1,
      idleGraceMs: 5000,
      pollMs: 1000,
      shouldStop: () => { throw new Error('a veto that explodes'); },
      now: c.now,
      wait: c.wait,
    });
    let threw = null;
    try { await drain(source, 1); } catch (e) { threw = e; }
    check('a shouldStop that throws is not a stop and is not fatal', threw === null);
  }

  // ===================================================================================
  // THE KNOBS — loaded, defaulted and validated by name (§4.12)
  // ===================================================================================
  // Duplicate the SHIPPED example and override per key, never hand-build a complete literal:
  // the next required field added to the config would break a literal and nothing else.
  const example = JSON.parse(fs.readFileSync(path.join(ROOT, 'run.config.example.json'), 'utf8'));
  const writeCfg = (name, over) => {
    const p = path.join(TMP, name);
    fs.writeFileSync(p, JSON.stringify({ ...example, ...over }, null, 2));
    return p;
  };
  const loads = (name, over) => { try { return { ok: true, cfg: loadConfig(writeCfg(name, over)) }; } catch (e) { return { ok: false, error: e.message }; } };

  check('feedIdleGraceMinutes defaults to 0 — the feed is OFF unless a config asks for it',
    DEFAULTS.feedIdleGraceMinutes === 0);
  check('feedPollSeconds has a sane default', DEFAULTS.feedPollSeconds === 30);

  const base = loads('run.config.base.json', {});
  check('a config that names neither knob still loads', base.ok === true);
  check('and gets the feed off', base.ok && base.cfg.feedIdleGraceMinutes === 0);

  const zero = loads('run.config.zero.json', { feedIdleGraceMinutes: 0 });
  check('ZERO IS LEGAL — it is how a config says "off" out loud', zero.ok === true);

  const on = loads('run.config.on.json', { feedIdleGraceMinutes: 30, feedPollSeconds: 15 });
  check('a positive grace window loads', on.ok === true && on.cfg.feedIdleGraceMinutes === 30);
  check('and so does a poll floor', on.ok && on.cfg.feedPollSeconds === 15);

  const neg = loads('run.config.neg.json', { feedIdleGraceMinutes: -1 });
  check('a negative grace window is refused BY NAME', neg.ok === false && /feedIdleGraceMinutes/.test(neg.error));
  const frac = loads('run.config.frac.json', { feedIdleGraceMinutes: 1.5 });
  check('a fractional grace window is refused by name', frac.ok === false && /feedIdleGraceMinutes/.test(frac.error));
  const zeroPoll = loads('run.config.zeropoll.json', { feedPollSeconds: 0 });
  check('a zero poll floor is refused by name — it would busy-wait against bd and git',
    zeroPoll.ok === false && /feedPollSeconds/.test(zeroPoll.error));

  // ===================================================================================
  // THE MANIFEST CONTRACT — the schema admits what run.js writes
  // ===================================================================================
  {
    const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'schemas', 'run.schema.json'), 'utf8'));
    const feed = schema.properties && schema.properties.feed;
    check('run.schema.json describes the feed block', !!feed);
    check('the schema still forbids unknown top-level keys', schema.additionalProperties === false);
    const endings = (feed && feed.properties && feed.properties.ending && feed.properties.ending.enum) || [];
    check('every ending runner/feed.js can produce is in the schema enum',
      Object.values(ENDINGS).every((e) => endings.includes(e)));
    check('and the schema invents none the code cannot produce',
      endings.every((e) => Object.values(ENDINGS).includes(e)));
  }

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* temp */ }
  process.exit(failed);
})().catch((e) => {
  console.log(`FAIL - the suite itself threw: ${e && e.stack ? e.stack : e}`);
  process.exit(1);
});
