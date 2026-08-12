# Handoff — goal: make the sweep trustworthy

**Status: APPROVED 2026-08-12 — items 1–5 approved as a block; item 6 decided (answer: no,
the verifier stays exception-free — the report labels sibling-batch partials instead,
change-log row `batch-sibling-partials`). Nothing is yet specced, frozen, or run.** This is
a goal statement plus the evidence behind it, written so a later session can pick it up
cold. It promotes six entries from `docs/IDEAS.md` (2026-08-01 through 2026-08-05) as one
bundle; each still owes a planning session before it becomes a task. The promotion path is
unchanged:

```
IDEAS.md -> DESIGN.md section (+ change-log row) -> spec + frozen tests -> Beads issue -> a run
```

*Filename note: deliberately undated. `docs/planning-draft-<date>.md` files are records of a
session and are immutable by design; this document is meant to be worked and amended until
the goal is discharged, and the `IDEAS.md` entry on dated names (2026-07-31) records why a
date on a living file stops it being maintained.*

## The goal in one paragraph

The sweep (`scripts/test-all.sh`) is the instrument every other change in this repo is
checked with — it is what tells you that the suites which merely *touch* a component you
changed are still green. Six recorded incidents have made it produce reds that were not
about the code: a sweep force-removing a live run's container, a killed suite's leftover
lock failing an unrelated suite three hours later, and a whole afternoon of environmental
timeouts. A sweep you have learned to discount is worse than no sweep, because the day it is
right it will read like the days it was wrong. This goal makes a red mean the code is wrong.

## The evidence, with numbers

All of this is already recorded in `docs/IDEAS.md` and `docs/STATUS.md`; it is collected here
so the case can be read without opening either.

| Date | What happened | Cost |
|---|---|---|
| 2026-08-01 | A sweep in another terminal `docker rm -f`'d a live run's task container twice. The run reported exit 137 with an empty log, which reads exactly like an out-of-memory kill | A session spent on Docker Desktop and the WSL2 VM before anyone opened the sweep summary, where it was written down plainly (`docs/STATUS.md` defect 11) |
| 2026-08-05 | A suite killed at its timeout left `runs/locks/*.lock` behind; the afternoon sweep three hours later reported `test-lock` red — a suite with no relationship to the one that was killed. Deleting the file fixed it with no other change | The most misleading class of red there is: deterministic, so it looks like a real defect, and it points at the wrong component |
| 2026-08-05 | Two full sweeps went red six times each. Five of the six re-ran green in 12–101s on an idle Docker minutes later. `scripts/egress-check.sh` end to end takes **0.65s** idle and took **73s** during the sweep, against its own 60s bound, having produced the correct answers before being killed | ~2.5 hours of sweeping to produce six reds, of which exactly one was real. The two sweeps spent 94 and 52 minutes mostly waiting for suites that were never going to finish |

Ruled out for the third row, so a later session does not re-run the same eliminations: the
code (nothing under `runner/`, `pipeline/` or `scripts/` touching Docker had changed since
the last green sweep), the host network (0.16s to the API from inside a container, DNS in
26ms), resources (24 CPUs, 15.35GiB, the host's unrelated long-lived containers idle at 47MiB
each), and the gate's own margin (blocked probes are refused in 1ms, not after their 10s
timeout, so 60s is generous rather than thin). What is left is something that accumulates as
35 suites churn containers and build and tear down the same network repeatedly. **The
mechanism is unproven and naming a cause here would be a guess.**

## The six items, in dependency order

Each names what it is, where the code already is, whether it is a pipeline task or work that
needs a human, and the honest catch. Facts marked *(verified 2026-08-12)* were read out of
the tree during the session that wrote this, not recalled.

### 1. Cut the per-suite timeout from 900s to 300s

**What.** Change the sweep's default kill time.

**Where.** `scripts/test-all.sh:58` (`TIMEOUT=900`). A `--timeout` flag already exists
(`scripts/test-all.sh:69`), so this is a change to one default and its documented comment at
line 18, not new plumbing. *(Verified 2026-08-12.)*

**Why first.** It costs nothing when suites are healthy — the slowest green suite in the
corpus is 1:30 — and it is what makes every later item, and the investigation at the end,
cheap to test. Re-running the six reds of 2026-08-05 under a 300s cap surfaced the same
information in four minutes against 94 and 52.

**Catch.** A suite that legitimately grows past 300s later becomes a false TIMEOUT. The
mitigation is that the flag exists and the sweep already names the cap in its own output
(`ok per-suite timeout <n>s`), so the failure is self-describing rather than mysterious.

**Shape.** Small enough that it may not deserve a task of its own; the natural home is as the
first criterion of whichever task ships item 2.

### 2. Make the sweep and a live run mutually exclusive

**What.** The sweep takes a lock and refuses to start while a run holds one; the runner
refuses symmetrically.

**Where.** `runner/lock.js` already implements acquire/release, liveness and takeover for the
per-project run lock (§4.12), and `runs/locks/` already exists.

**Why this and not a fix in the reclaimer.** `scripts/sweep-reclaim.js` is *correct*. A
before/after snapshot diff genuinely cannot distinguish "this container appeared because my
suite made it" from "it appeared because something else did" — that is not a classification
bug to be fixed with a better filter, it is missing information. The guarantee therefore has
to come from exclusivity. This is the same reasoning that produced change-log row `repo-zje`.

**The design question this raises, which must be settled before a spec is written.** The
existing lock is keyed by *canonical target repo path* — it exists to stop two runners
draining one project's queue. A sweep is not a run against a target, so it does not have a
key of that shape. Two candidate answers, and they are not equivalent:

- **A distinct global sweep lock** that runners check in addition to their own. Honest about
  what it is; adds a second lock concept and a second thing that can be left behind.
- **The sweep takes the ordinary lock on this repo as a target** — legal, since this repo is
  onboarded as a target of its own pipeline (dogfooding). Reuses everything. But it only
  excludes a run *against this repo*, and the 2026-08-01 incident involved a sweep and a run
  that had no target in common. That makes this answer look right and be wrong, which is the
  worse failure of the two.

The second option is recorded here specifically so it is rejected deliberately rather than
adopted for looking cheaper.

**Second-order, from the original entry.** A reclamation of anything matching `task-`
deserves to be loud — stderr, non-quiet — since by construction it is either a real leak or
someone's live work. Carried as item 4 below.

### 3. Have the sweep reclaim stale run locks

**What.** Extend the sweep's reclamation to `runs/locks/*.lock` left behind by a suite the
sweep itself killed.

**Where.** `scripts/sweep-reclaim.js` already owns the before/after snapshot diff and is the
only removal path in `scripts/` (per `CLAUDE.md`). A lock record carries its own `runId`,
`pid` and `startedAt`, and §4.12 already knows how to decide a holder is gone.

**Ordering matters: this comes after item 2, not before.** A lock left by a killed suite and
a lock held by a live run in another terminal look similar from the outside — the same hazard
change-log row `repo-zje` exists for. Exclusivity removes the ambiguity outright, so building
item 3 first means building it against a distinction that does not yet reliably hold.

**Catch, and a concrete blocker.** This wants the liveness check §4.12 already implements,
never a name match. `isHolderLive` exists at `runner/lock.js:134` but is **not exported** —
the module exports `acquire`, `release`, `lockPath` and `canonicalTarget` only
(`runner/lock.js:252`). *(Verified 2026-08-12.)* So the task either exports it or
re-implements it, and re-implementing a liveness rule in a second place is exactly how two
copies drift until one of them removes a live run's lock. Export it.

**The two rules that travel unchanged from change-log row `repo-zje`.** No baseline, no
removal — a listing that failed is not "nothing was here". And cleanup is never a verdict —
the suite's exit code is captured before any of this runs, and the reclaimer always exits 0.

### 4. Make reclamation of a `task-` container loud

**What.** Any removal of a container matching the `task-` prefix goes to stderr and is not
suppressed by quiet mode.

**Why.** By construction such a container is either a real leak worth knowing about or
someone's live work being destroyed. Neither is a thing to log quietly. This is the cheapest
item in the set and is the diagnostic that would have shortened the 2026-08-01 session from a
day to minutes.

**Catch.** None material. It is additive output.

### 5. Declare a `regressionCommand` for this repo

**What.** Name this repo's fast, pure, Docker-free suites as its regression command, so the
verifier runs them from the fork point on every task attempt.

**Where.** `pipeline.config.json` currently declares `verifyCommand`, `defaultBranch`,
`frozenPaths` and `dependencies` — **no `regressionCommand` key at all**. *(Verified
2026-08-12.)*

**Why it belongs in this goal rather than the observability one.** It is the same problem
stated one layer down: frozen acceptance directories assert literal strings against runner
source, nothing ever re-runs a frozen directory, and so a restructure can invalidate 50+
assertions silently. Three tasks have now navigated that hazard by hand-writing a guard
criterion each time. That is discipline standing where scaffolding was designed to stand —
the same complaint this whole goal makes about the sweep.

**Catch.** It lengthens every attempt's verify step, and a suite that goes stale then blocks
unrelated tasks. That is an argument for starting with the fast, pure ones and growing the
list, not for declaring all of them at once.

### 6. Decide the batch-sibling question — DECIDED 2026-08-12: no

**The decision, so this section reads as history.** Chad answered no: the regression pass
never treats a sibling suite as expected-red, however narrowly the exception is scoped. The
verifier stays untouched. The fix is downstream — the run report labels a partial whose
failing regressions are all sibling frozen suites as `sibling-batch` and sorts it after
every genuine partial, so the flag that means "a real regression slipped through" is read
first again. Recorded as change-log row `batch-sibling-partials`; the labelling itself is
now an ordinary additive item for the same planning session as items 1–5, with no hard-rule
tension. The original question is kept below unchanged, as the record of what was asked.

**What.** When a batch of tasks is frozen in one planning session, every task branch forks
from an integration branch carrying all the siblings' frozen acceptance tests and none of
their implementations. So each task's regression pass fails on its siblings' suites and lands
`partial` with a flagged PR.

**Scale.** Not an edge case: the first corpus read (change-log row `run-audit`) found that
**nine of the corpus's eleven partials are this shape**, including one batch of three tasks
all blaming each other.

**Why it matters here.** A structural partial buries the genuine ones. §4.11 puts partials
above every clean `done` in scrutiny order, so a reviewer who learns "partial usually means
batch noise" stops reading the one flag that exists to say a real regression slipped through.
Same disease as a sweep that goes red for environmental reasons, one level up.

**The question to answer:** may the regression pass treat a sibling suite whose issue is open
in the same run as expected-red, and how is that said without weakening hard rule 2?

**This is the only item in the set that touches a hard rule**, and it is a decision plus a
change-log row before it is an implementation. It must not be settled inside a task.

## And one thing that is explicitly not a task

**Find out what actually degrades the container path over a long sweep.** Do it after item 1,
because a 300s cap is what makes the experiment cheap to repeat. The mechanism is unproven,
and a frozen acceptance test written against a guessed cause is a task that cannot honestly
pass — see the `IDEAS.md` entry of 2026-07-31 on speccing against a mechanic nobody has
verified exists. This is an investigation whose output is evidence and, if it finds
something, a *later* spec.

## Sizing: why six, and what the ceiling is

Six is ambitious; three or four would be comfortable. The constraint is not the runner — ten
tasks ran in one day, every one `done` on the first attempt, 56.9 minutes of container time
summed, longest single task 9.7 minutes. What costs is the planning session (a spec, frozen
tests and a critic pass each, all interactive) and two batching defects that are themselves
open ideas: sibling suites failing each other (item 6 above) and the documentation merge
conflict every batch produces after the first merge. Both scale worse than linearly with
batch size, which is what puts the practical ceiling near six rather than near ten.

Note the mild circularity, deliberately accepted: item 6 is one of the two things that makes
large batches expensive, and it is inside this batch. If it is settled first, the rest of the
bundle is cheaper to run than the sizing above assumes.

## Hard-rule check

| Item | Rule tension | Verdict |
|---|---|---|
| 1, 2, 3, 4 | None. Deterministic host scaffolding, no LLM anywhere near it (rule 7 untouched) | Additive |
| 5 | Rule 2 — but in the strengthening direction: it makes drift red automatically where a hand-written criterion holds it today | Additive |
| 6 | **Rule 2 directly.** Changing what counts as an acceptable regression failure points away from "never weaken verification" | Decided 2026-08-12: no exception in the verifier; the report labels sibling-batch partials instead (change-log row `batch-sibling-partials`). What remains to build is additive |

## What has to happen next

1. ~~Chad approves or reshapes the bundle.~~ **Done 2026-08-12: approved as a block.**
2. ~~Item 6 is decided in an interactive session, and a `DESIGN.md` change-log row records
   it.~~ **Done 2026-08-12: change-log row `batch-sibling-partials`.**
3. A planning session (`PLANNING.md`) turns items 1–5, plus item 6's sibling-batch report
   label, into specs with frozen tests, with the freeze gate run against a green control.
   Items 1–4 are one coherent area of code and may collapse into fewer tasks than they are
   entries; item 5 is separable and could go first.
4. Issues are filed, frozen, and drained by a run.
5. The sweep runs on the reference host afterwards — no frozen test can hold a promise about
   the sweep's own behaviour, so that obligation is discharged by hand and belongs in the
   run's report.

## Open question for Chad

Answered 2026-08-12 — see item 6 above and change-log row `batch-sibling-partials`. Nothing
in this document still waits on a human decision; the next step is the planning session.
