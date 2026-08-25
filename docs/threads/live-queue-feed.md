# Thread — feeding tasks into a run that is already in flight

```
slug:     live-queue-feed
status:   open   (spec 1 shipped; spec 2 — the downstream readers — is the remaining work)
opened:   2026-08-24
origin:   user directive
related:  DESIGN.md §4.12 (the task loop, the run lock, the dispatch gate), §7 (concurrency,
          the run-level park), §3.9 (the batch marker); change-log rows `repo-os9`,
          `repo-jur`, `parallelism-v2`, `concurrency-uncapped`, `repo-sls`, `dispatch-gate`,
          `repo-5yu`, `batch-ready-marker`
```

**The question this thread has to answer:** what has to change so that an issue made ready
*while a run is going* is picked up by that run's next free worker slot — and what closes
such a run, given that "the queue is empty" stops being the end of the work.

## Current thinking

### What is actually in the way today

Three separate things get conflated as "the pipeline won't run two things at once". Only
the third is this thread's subject.

1. **The per-project run lock** (`runner/lock.js`, change-log row `repo-os9`) refuses a
   second `run.js` against the same target repo. That stays. Two runners on one Beads
   queue both claim the same issue and both push a branch for it; hard rule 1 assumes one
   writer. Nothing here proposes touching it.
2. **Concurrency within a run** is already built and already uncapped — `concurrency` in
   `run.config.<project>.json`, an N-worker pool in `drainQueue` (change-log rows
   `parallelism-v2`, `concurrency-uncapped`). Not a limitation, just a default of 1.
3. **The roster is fixed at launch.** `runner/run.js` calls `readyQueue(cfg)` once, then
   `drainQueue` walks that array to its end and the run closes out. An issue that becomes
   ready one minute after the run started waits for the next run. *This* is the thing.

### The proposal in one line

Replace the fixed array with a **cursor over a queue that is re-read**, and give the run an
**idle grace window** so it does not close the instant it runs dry.

### The shape

- `drainQueue(issues, taskFn, concurrency)` becomes `drainQueue(source, taskFn, concurrency)`,
  where `source.next()` hands a worker the next issue to dispatch or `null`. The N-fixed-workers-
  pulling-a-shared-cursor structure is unchanged; only where the cursor reads from changes.
- The source keeps a **pending remainder** and re-reads `readyQueue(cfg)` when (a) the
  remainder is empty and a worker asks, or (b) `feedPollSeconds` has elapsed since the last
  read. New ready issues are merged into the remainder in priority-then-FIFO order; issues
  already dispatched or in flight this run are excluded by id.
- **Idle grace.** When every worker is idle and a re-read returns nothing, the run waits
  `feedIdleGraceMinutes` and re-reads once more before closing out. `0` is today's behaviour
  exactly, and is the default — feeding is opt-in per project, and a config that says
  nothing gets the run it has always got.
- **A stop sentinel.** A file at `runs/<runId>/stop` ends the feed: workers finish what they
  hold, nothing new is dispatched, the report is written. Without it, ending a fed run early
  means killing the process, which strands in-flight tasks `in_progress` and leaves the lock
  to be taken over. Cheap to build, and it is the only way an operator session can close a
  run it did not start in the foreground.

### The interface for feeding is `bd`, and nothing new

The working session creates or unblocks an issue exactly as it does now. There is no
"submit to the running pipeline" command, and there must not be — an inbox that can start a
container is not an inbox (§3.8's own boundary, and `docs/IDEAS.md`'s). The run notices
because it is asking, not because anything told it.

### Why the dangerous version of this is already guarded

The obvious way to get hurt is to freeze a task mid-run, forget to push its frozen suite to
the integration branch, and have the runner dispatch it — three attempts and three
containers spent recording `stuck` against a suite that is not there. **§4.12's second
admission rule already refuses exactly that** (change-log rows `dispatch-gate`, `repo-5yu`),
and it checks the fork branch rather than the working tree, which is what makes it correct
for a task frozen after the run began.

One thing must change about it, though: today a refusal is computed once and reported once.
Under feeding a task refused at 14:05 for a missing suite should be **re-evaluated on every
poll** and dispatched normally once the suite is pushed. So the refused set is live, and
only what is *still* refused when the run closes gets a manufactured row in the manifest.
That is a strict improvement — it turns the gate from a verdict into a wait.

### The Dolt-collision risk, sized honestly

Hard rule 1 is satisfied — still one runner, still the host writing. Feeding means the
working session runs `bd update` **while** the runner runs `bd ready` / `bd update --claim` /
`bd close`. Concurrent access to one embedded Dolt database is the exact load that produced
the 2026-07-28 hang, where `bd` emitted its complete JSON and then never exited (change-log
row `repo-sls`).

**But that pairing is already routine, and this design does not introduce it.** The
operator/working session split means a working session plans, freezes and updates issues
while a run drains in another terminal — every batch is prepared that way. What feeding adds
on top is a periodic `bd ready`, which is the *idempotent* half of the exposure. The writes
that hurt when they time out — `claim`, `finish` — do not become more frequent because the
queue is re-read; they scale with tasks dispatched, which is unchanged for a given amount of
work. So the delta is a small number of extra reads per hour, not a new class of access.

What already protects us: every runner `bd` call is bounded by `bdTimeoutMs`, so a hang
fails loudly as status 124 rather than parking the run. What that failure *costs* differs by
caller, and this is the ranking that matters — a timed-out `readyQueue` aborts the run, a
timed-out `claim` skips one issue, a timed-out `finish` strands finished work with the issue
`in_progress` and the outcome unwritten. Raising the collision rate raises all three.

Three mitigations, all cheap, and the third is the load-bearing one:

- **Poll cheaply and rarely.** `feedPollSeconds` default of 30, and only poll when a worker
  is actually free or the pool is idle — against container times measured in tens of minutes,
  a run at concurrency 4 reads the queue a handful of times an hour.
- **Retry the read, never the write.** `readyQueue` is idempotent and safe to retry once on
  a 124; `claim` and `finish` are not, and must keep failing loudly the way they do now.
  `runner/bd.js` has no retry path today and does not grow a general one — the retry belongs
  to the feed source, at the one call site that can prove it is safe.
- **A failed re-poll is never fatal.** This is the sharp edge of the whole design and it is
  invisible until it bites. `run.js` today reacts to an unreadable ready queue with
  `process.exit(1)`, which is correct *because nothing has started yet* — no container is up,
  no issue is claimed, the lock releases on exit and the project is free. Mid-run that same
  reaction kills N running containers and strands N issues `in_progress`, and it would fire
  on a transient `bd` timeout the run could simply have ignored. So: the initial read keeps
  its abort, and every re-read logs the failure, keeps whatever remainder it has, and tries
  again next poll. The run only ends the ways the design says it ends.

### Reversibility is the strongest thing this design has

`feedIdleGraceMinutes: 0` is today's runner, exactly: the source is read once, the pool
drains it, the run closes out. Nothing about the container, the freeze, the verifier or the
lock is touched by any of this — the blast radius is scheduling and reporting, and the escape
hatch is one config field rather than a revert.

The honest alternative, if the collision rate turns out to be real rather than theoretical,
is that feeding writes go through the runner rather than around it — which would be a much
bigger design change and is explicitly not proposed here.

### What else moves

- **`run.json` / `schemas/run.schema.json`.** The manifest is currently one row per queued
  issue in ready-queue order, and "ready-queue order" stops existing. Rows become
  **dispatch order**, and each carries the instant it was dispatched. `finishedAt` already
  exists and becomes load-bearing for the next point.
- **`scripts/batch.js`.** Its pending join asks "has any run since the freeze worked these
  ids?" and compares `frozenAt` against the run's `startedAt` — which was the right call when
  a run's roster was fixed at launch (change-log row `batch-ready-marker`). A fed run works
  ids frozen *after* it started, so that comparison would report a batch as un-launched when
  it has already run. The fix is to bound with the run's end rather than its start, or to
  match on ids in the manifest and use dates only for ordering. This is the one downstream
  reader that gives a **wrong answer** rather than a degraded one, and the wrong answer gets
  a batch launched twice.
- **`scripts/dashboard.js`.** It parses ids out of the queue-summary line and joins run state.
  A queue that grows means the summary line is no longer a total, and "3 of 7 done" becomes
  a lie by omission. Needs a live count rather than a fraction of a fixed roster.
- **The run-level park (§7).** When the rate-limit cap has fired, every subsequent task is
  refused and stays `open`. A fed run must **stop polling and close out** at that point
  rather than idling while refusing everything it is handed.
- **The report and `docs/pipeline-diagram.md`.** The loop's shape changes, so the diagram
  changes in the same PR.

### Sizing

Two specs, in this order, and the first is useful alone:

1. **The re-read loop** — `drainQueue` over a source, the two knobs, the live refused set,
   the stop sentinel, the manifest becoming dispatch-ordered. Docker-free coverage extends
   `tests/unit/concurrency.test.js`, which already drives `drainQueue` through the
   `PIPELINE_EXEC_STUB` seam; the new fixtures are a source that yields more work after the
   pool has gone idle, and one that yields a task refused on poll 1 and dispatchable on poll 3.
2. **The downstream readers** — `batch.js`'s join, the dashboard's count, the schema row.
   These are what stop a fed run from quietly corrupting the answers other tools give.

## Decisions

- 2026-08-24 — Ship the idle grace window plus a `runs/<runId>/stop` sentinel as the way a
  fed run closes, and let a newly-fed high-priority issue be dispatched ahead of
  not-yet-started lower-priority ones. Both were the drafter's proposals in Open questions
  and were built on the standing assumption rather than blocking on an answer; either is
  cheap to change, and the grace window at its default of 0 makes the whole feature inert
  until a config asks for it (drafter, on the user's "start building it").
- 2026-08-24 — Do NOT measure the Dolt collision rate first. Concurrent host `bd` access is
  already routine under the operator/working session split, so a bad result would be a
  finding about today's pipeline rather than about this change, and should not gate it
  (drafter).


- 2026-08-24 — Build it: an issue made ready during a run should be picked up by that run's
  next free slot, rather than waiting for the next run (user).
- 2026-08-24 — The run lock and one-runner-per-project are not in scope and do not change;
  feeding happens inside the single runner (drafter, following hard rule 1).

## Open questions

- **What closes a fed run?** Proposed: an idle grace window (`feedIdleGraceMinutes`, default
  0 = today) plus a `runs/<runId>/stop` sentinel. The alternative shapes are a wall-clock
  deadline, or a run that only ever ends on the sentinel. Settled by deciding whether a fed
  run is a *long batch* or a *shift* — the first wants a grace window, the second wants a
  deadline.
- **Does a newly-fed high-priority issue jump the queue?** It cannot preempt a running
  container, but it can be dispatched ahead of lower-priority issues not yet started.
  Proposed yes, since that is what priority means everywhere else in the queue. The cost is
  that the manifest is dispatch-ordered rather than priority-ordered, and that has to be said
  out loud in the report.
- **Is the Dolt collision rate real?** Measurable before anything is built: drive `bd ready`
  in a loop against a working session doing ordinary `bd update` calls and count 124s. Worth
  doing first, because a bad answer changes the design rather than the knobs — but note that
  a bad answer would be a fact about *today's* pipeline too, not about this change.

## Log

- 2026-08-24 — **Spec 1 built** on branch `live-queue-feed`, in a separate git worktree so the
  primary working copy stayed on `main` and runnable throughout. New `runner/feed.js`;
  `drainQueue` takes a source or an array; two config knobs defaulting to off; the manifest
  gains a `feed` block; new suite `scripts/test-feed.sh` (57 checks). DESIGN.md §4.12 amended
  and change-log row `live-queue-feed` added. All 18 Docker-free suites green. **Nine
  mutations of the implementation were run against the suite and all nine were caught** —
  and one of them found a real bug rather than confirming a check: `lastPoll` seeded at 0
  made the poll floor a delay before the FIRST read, which works by accident against a real
  `Date.now()` and would have cost a fed run its first poll interval on any clock starting
  near zero. Not run: the Docker suites, because the user was running the pipeline against
  other projects at the time.


- 2026-08-24 — Risk pass. Reframed the Dolt-collision concern: concurrent host `bd` access is
  already routine under the operator/working session split, and feeding adds reads rather than
  writes, so the delta is smaller than the first draft implied. Added the rule that a failed
  re-poll must never be fatal — today's `process.exit(1)` on an unreadable queue is safe only
  because it fires before anything has started — and the reversibility argument. *Current
  thinking* rewritten in place.
- 2026-08-24 — Opened from a working-session question about why a second run is refused while
  one is in flight. Established that the lock (`repo-os9`) and the fixed roster are separate
  limits and only the second is wanted; wrote the proposal above against `runner/run.js`'s
  current single `readyQueue` call and `drainQueue`'s fixed array. Nothing built.

## Outcome

*(empty until the thread closes)*
