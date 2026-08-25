# Handoff — the live queue feed, 2026-08-25

**Status: both halves built and pushed. PR #46 is MERGED; PR #47 is OPEN and unreviewed.
The Docker sweep has not been run against either.** Written so a cold session can pick this
up without re-reading the two pull requests.

*Filename note: dated on purpose. This is a record of one moment — what was true on
2026-08-25 — and the `docs/IDEAS.md` entry of 2026-07-31 records why a date on a file that
is meant to be *worked* stops it being maintained. The thing that is meant to be worked here
is `docs/threads/live-queue-feed.md`, and it is already closed.*

## What this was

A run's roster used to be decided once — `readyQueue()` at the top of the task loop, then the
pool walked that array to its end. An issue made ready a minute after the run started waited
for the next run. That is the wrong shape for how the work actually arrives, because freezing
happens in a working session that is usually still going while the run drains.

The feed makes a run re-read the ready queue whenever a worker is free and finds nothing.
Feeding is just `bd` in a working session; there is no submit command and there must not be
one (§3.8: an inbox that can start a container is not an inbox).

## Where the code is

| | |
|---|---|
| Branch | `feed-readers`, on top of merged `main` |
| Worktree | `C:\Code\Projects\MAP-livefeed` — a **git worktree**, not a clone |
| Primary tree | `C:\Code\Projects\Multi-AgentPipelines`, untouched, on `main` |
| PRs | #46 (merged), #47 (open) |
| Thread | `docs/threads/live-queue-feed.md`, status `promoted` |
| Change-log rows | `live-queue-feed` (the runner), `feed-readers` (the two readers) |

**The worktree is why the pipeline stayed runnable throughout.** A `git worktree` is a second
directory checked out to a different branch, sharing one `.git`. Because the runner is
launched as `node runner/run.js` from whatever directory you are in, editing the primary tree
would have put half-finished code into the next real run. When this work is done:

```bash
git -C C:/Code/Projects/Multi-AgentPipelines worktree remove ../MAP-livefeed
```

It refuses if there are uncommitted changes, which is the behaviour you want.

## What shipped

**PR #46 — the runner.** `runner/feed.js` (new) exports `createFeedSource`; `drainQueue`
takes either that or a plain array, so every existing caller keeps its contract. Two knobs in
`run.config.json`, `feedIdleGraceMinutes` (default **0 = off**) and `feedPollSeconds`
(default 30). The manifest gains a `feed` block. New suite `scripts/test-feed.sh`, the
nineteenth Docker-free one.

**PR #47 — the two readers it broke.** `scripts/batch.js`'s pending join now bounds a fed run
by its *end* rather than its start; `scripts/dashboard.js` stops rendering the feed's own log
trace as a phantom task and gains a run-level `feed` block plus an open-feed banner.

## What is left

1. **Merge PR #47.** Until it is in, `scripts/batch.js pending` gives a wrong answer for any
   fed run — it reports a batch that demonstrably ran as un-launched, and the cost of that is
   a batch launched twice. **Do not turn the feed on for any project before this merges.**
2. **Run `bash scripts/test-all.sh`.** This is the outstanding *risk*, not the outstanding
   work. Two PRs have changed `runner/run.js`'s task loop and two readers, and **no Docker
   suite has been run against either.** The Docker-free eighteen are green; that is not the
   same thing, and this repo's own rule says so: changing a component means the suites that
   *cover* it are green, and the sweep is what tells you the suites that merely *touch* it
   still are.
   - Most at risk, in order: `test-runner-queue.sh` (greps the queue-summary prefix at six
     sites), `test-runner-container.sh` and `test-runner-workspace.sh` (both drive the task
     loop end to end), then `scripts/e2e.sh`.
   - **The sweep must not run while a real run is live.** Its ownership rule is a before/after
     container-listing diff intersected with an allowlist, and a live run's
     `task-<id>-<runId>-<n>` containers both appear mid-sweep and match `task-`, so the sweep
     reclaims them. `ls runs/locks` is the one-glance check: empty means nothing is running,
     for any project.
3. **Optional, and only after 1 and 2:** turn the feed on for one project and use it for a
   day before turning it on anywhere else.

## How to actually use it, once it is on

```jsonc
// run.config.<project>.json
"feedIdleGraceMinutes": 30,   // 0 = off, and off is the default
"feedPollSeconds": 30         // a ceiling on frequency, not a delay before the first read
```

- **To feed a task in:** freeze it and **push the suite**, then make the issue ready with
  `bd` exactly as you would for the next run. Nothing else. An unpushed suite is refused by
  the dispatch gate — and under feeding that refusal is a *wait*, so pushing it a few minutes
  later is enough; the task is picked up on a later poll with nothing else to do.
- **To stop a fed run:** `touch runs/<runId>/stop`. Workers finish what they hold, nothing new
  starts, the report is written. This exists so you never have to kill a process that is
  holding containers.
- **To see whether a run is still feeding:** `node scripts/dashboard.js`. An open feed shows
  as a banner. This matters because a fed run that has finished everything looks exactly like
  one about to exit.
- **Four ways a run ends,** recorded in `run.json`'s `feed.ending`: `drained` (roster spent —
  always the answer with the feed off), `idle` (grace window expired), `stopped` (the
  sentinel), `halted` (the §7 rate-limit cap fired).

## The two defects found, and what they teach

Both are worth carrying forward, because neither was visible from the design and neither would
have been found by more careful reading of the module under test.

**A poll floor that was really a first-read delay.** `lastPoll` seeded at `0` meant the first
re-read waited a full `feedPollSeconds` from the epoch. Against a real `Date.now()` that is
always already past, so it worked by accident on the reference host and would have cost a fed
run its first poll interval anywhere the clock started near zero. **Found by mutation
testing** — deliberately breaking the implementation and checking the suite went red. Nine
mutations were run against `test-feed.sh` and all nine were caught; this one was the mutation
that turned out to be describing the real code.

**A phantom task called `feed`.** The feed logs under the trace `<runId>/feed`, and the
dashboard treats any trace id that is not `preflight` as a task. It would have rendered a task
called `feed`, permanently `queued`, in the tool whose entire job is to say what is running.
**Found by reading the consumer**, not by any test of `feed.js` — no amount of testing the
module would have surfaced it, because the module was correct.

The general lesson, which is already CLAUDE.md's "assert the artifact is *right*, not merely
present" one layer out: when you add a producer, read every consumer of the thing it produces.
`run.log`'s trace ids had three consumers and the design named none of them.

## What the thread got wrong

Recorded in `docs/threads/live-queue-feed.md`'s Outcome, and repeated here because it is the
part most likely to be needed again. The opening risk pass named concurrent `bd`/Dolt access
as the main hazard and proposed measuring it before building. That was wrong twice over:
concurrent host `bd` access is already routine under the operator/working-session split, so a
bad measurement would have been a finding about today's pipeline rather than about this
change; and the two defects that would actually have shipped were both scheduling and plumbing
details invisible from the design. **The measurement would have found neither.**

## Deliberately not done

- **No per-task dispatch instant in the manifest.** `batch.js` is bounded by the run's end
  instead, which is conservative and sufficient. A `dispatchedAt` per task would make the join
  exact rather than conservative; it was not worth touching `run.js`, the schema and the report
  for it.
- **The stop sentinel is a feed feature only.** A classic run whose remaining tasks stopped
  being dispatched would leave them absent from `run.json` altogether — the silent hole the
  `undispatchable` rows exist to prevent. If a stop for classic runs is ever wanted, it has to
  manufacture rows for what it skipped.
- **Nothing was done about the sweep reclaiming a live run's containers.** It is pre-existing,
  it is recorded in `docs/handoff-sweep-trustworthy.md`, and it is the reason no Docker suite
  was run here.
