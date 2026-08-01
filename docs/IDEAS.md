# IDEAS.md — the idea inbox

Somewhere to put *"that's probably a good idea"* the moment you have it, so it survives
without being thought about yet.

This is deliberately the cheapest document in the repo. It is not a design, not a spec,
not a backlog. An entry here makes **no** claim that the idea is good, sized, wanted, or
ever going to happen. That is the whole point: capture has to cost nothing, or it doesn't
happen at the moment the idea shows up — which is the only moment it is free.

## Where this sits

The repo already had four homes for a thought, and none of them accepts an unformed one:

| Home | Holds | Costs |
|---|---|---|
| `DESIGN.md` | a decision, and why | an interview, critics, a change-log row |
| `PLANNING.md` → `docs/planning-draft-*.md` | a spec being made machine-checkable | a planning session |
| a Beads issue | committed work, frozen | approval, frozen tests |
| `docs/STATUS.md` | where the build actually is | it describes reality, not intent |

An idea that isn't ready for any of those had nowhere to go but your head. Filing it as a
Beads issue is the tempting mistake and the wrong one — issues are commitments, they show
up in `bd ready`, and the queue is what the runner drains unattended. **An inbox that can
start a container is not an inbox.**

## The promotion path

An idea is not finished here; it is *parked* here. The way out is the way everything else
in this repo gets built:

```
IDEAS.md  ->  DESIGN.md section (+ change-log row)  ->  spec + frozen tests  ->  Beads issue  ->  a run
  parked        decided, with a reason                    machine-checkable      committed
```

Same two-stage shape as `bd remember` → the promoted conventions in `CLAUDE.md` (§3.6):
**the inbox is a staging area, not a destination.** A note that has earned its place moves
somewhere permanent and cites where it came from; a note that hasn't, sits here or gets
dropped. Nothing is ever implemented straight from this file — an idea that skips the
design and spec layers is exactly the scope creep `design-ref` exists to catch (§3.1).

Planning sessions read this file for candidates (`PLANNING.md`, step 0). That is the only
process obligation attached to it.

## How to write an entry

A title, a sentence or two on **why you'd want it** — not how you'd build it — and the
date. That's it. Resist adding structure; if an entry needs a section of its own it has
stopped being an idea and wants a design doc.

```markdown
- **Short imperative title** — why this would be worth having, in a sentence or two.
  Whatever context future-you will not remember. 2026-07-30
```

Optional extras, only when they're actually true:
- `Blocked on:` — something that has to land first. Name the change-log row or issue id.
- `Related:` — an existing design section this would touch.

**Grouping:** this is one flat list on purpose. Add headings only when the flat list
genuinely stops being skimmable — an inbox with a taxonomy is a filing system, and a
filing system is a thing you avoid using.

## What must not go in here

Two hard boundaries, both inherited:

1. **This file is public, and it is pipeline-only.** This repo documents the machinery,
   never the work done with it. Ideas about a *target* project belong in that project's
   own `docs/IDEAS.md`, not here — naming one here leaks the thing the boundary exists to
   protect, and `scripts/test-sanitize.sh` reads the tracked tree as bytes to catch it.
   Write "the first real project", never its name.
2. **Nothing that is already decided.** If it's in `DESIGN.md` it isn't an idea, it's a
   plan; if it's a known gap in `docs/STATUS.md` it isn't an idea, it's work. Duplicating
   either here is how an inbox becomes noise nobody reads.

---

## Inbox

<!-- Newest at the top. Nothing here is committed to. -->

- **Make the sweep and a live run mutually exclusive** — on 2026-08-01 a sweep running in
  another terminal `docker rm -f`'d a real run's task container twice, and the run reported it
  as exit 137 with an empty log, which reads exactly like an OOM kill. A session was spent on
  Docker Desktop and the WSL2 VM before anyone opened the sweep summary, where it was written
  down plainly. Worth having because the exclusion is cheap and already half-built: §4.12's
  per-project lock lives in `runs/locks/`, and the sweep could take one of its own and refuse to
  start while any is held, with the runner refusing symmetrically. The reason it isn't just a
  bug fix in `sweep-reclaim.js` is that the reclaimer is *correct* — a before/after snapshot diff
  genuinely cannot tell "appeared because my suite made it" from "appeared because something
  else did", so the guarantee has to come from exclusivity rather than from better
  classification. Second-order: a reclamation of anything matching `task-` deserves to be loud
  (stderr, non-quiet), since by construction it is either a real leak or someone's live work.
  Related: `DESIGN.md` §4.12; `docs/STATUS.md` defect 11. 2026-08-01

- **Verify a stated mechanic exists in the code before speccing against it** — a planning session
  on 2026-07-31 spent a full exchange designing around "the ship can pull a tethered astronaut",
  which the owner believed was how the game worked. It is not implemented at all: the suit is
  integrated on gravity and the jetpack, the tether is added mass that only ever slows it, and
  there is no ship-to-astronaut coupling anywhere. Nobody was wrong to believe it — it is in the
  design's spirit and half the supporting parts exist — but the spec would have been written
  against a mechanic with no code behind it. Worth having because the check is thirty seconds of
  grep and the failure mode is a frozen task that cannot pass. Note this is the same disease as the
  four checklist items found already-done the same day: **the map and the territory drift in both
  directions**, and only reading the territory settles it. Candidate PLANNING.md step-1a addition.
  Related: *Reconcile a target's spec against the merged tree at planning step 0*, below, covers
  the **written** half of the same drift — a spec that has fallen behind merged code. This entry is
  the **unwritten** half: a mechanic someone believes in that was never built. Both were found on
  the same day from opposite ends, which is the argument for reading the code at step 0 rather than
  trusting either document. 2026-07-31

- **Ask what else reads the number a new mechanic changes** — the same session found that adding a
  line-gun would silently redefine a shipped, already-ticked spec item. `Astronaut.can_reach()`
  credits the *magnet's* range against the gap home; if a line becomes the thing that saves you,
  the RETURN lamp must credit the *line's* range instead — so the lamp's meaning changes without a
  word of its specification changing, and its box stays ticked either way. Worth having because a
  redefinition is invisible to every gate this project owns: the frozen tests still pass, the
  regression net still passes, and the checklist still reads done. The scope critic asks "is this
  several tasks"; nothing yet asks "what did this quietly re-mean". Cheap version: a spec
  constraint naming every existing caller of any function the task touches. 2026-07-31

- **Have the docs phase tick the box, not just write the note** — four times in one day the
  documentation phase updated a checklist item's prose and left its checkbox unticked, including
  once where the task itself had just built the gate the box was waiting for. The failure is
  consistent and one-directional: notes get updated, the state marker does not. It matters because
  the checklist is what a planning session reads to choose the next task, so a stale box is not a
  cosmetic lag — it is a spec cut against a false picture. It cost a full planning cycle on
  2026-07-31: a task was drafted, criteria written in fresh context, and a critic panel run, before
  anyone noticed both deliverables had shipped days earlier and were already guarded.
  Worth having because it is cheap to attempt — the docs prompt already asks for the notes — and
  because the alternative is auditing the checklist by hand before every planning session, which is
  what had to happen instead. Note the honest difficulty: deciding a box is tickable means judging
  whether a claim is *gated*, not merely true, and an agent that ticks boxes optimistically is worse
  than one that never ticks any. Possibly the right shape is narrower — have the docs phase report
  *candidate* ticks as evidence, the way `note` and `concern` already report, and leave the edit to
  the host. 2026-07-31
- **Tell the docs phase which files it owns, and stop giving living documents dated names** — the
  docs phase's entire file-set instruction is one line in `pipeline/entrypoint.sh` ("Update any
  in-repo documentation affected by the change (README, docs/)"), naming no manifest. It works
  anyway, because the workspace is a full clone and the target's `CLAUDE.md` auto-loads into every
  invocation — so the reading table *is* the manifest, by accident rather than by design. Making
  that explicit is a prompt change plus an assertion against the *generated* prompt file, the way
  change-log row `repo-1cy` established.
  The second half is a convention nobody had written down: **a date in a filename reads as
  immutable.** An agent will not rewrite a document named for a date, and should not — that is a
  record of that date, not a living file. A repo that wants a maintained status document must not
  name it after the day it was started, and the failure looks like forgetfulness rather than like
  the missing mechanism it is. 2026-07-31
  *Found by checking which documents task docs phases have actually touched: nine
  container-authored commits have amended this repo's `docs/STATUS.md`, one adding 41 lines.*

- **Give every onboarded target a living status document, not just this repo** — `docs/STATUS.md`
  here is maintained by the docs phase and cited from `CLAUDE.md`'s reading table; a target project
  gets neither by default, so whatever stands in for one is hand-written and goes stale the next
  time a task lands. Onboarding already creates an issue template, an idea inbox and a control
  fixture; a status file and its reading-table row are the same kind of cheap one-time wiring, and
  they are what make the docs phase maintain it afterwards.
  The pay-off is per-target and repeats: every future adoption inherits a status document a machine
  keeps current, instead of one more file that decays and is caught only when a review happens to
  look. 2026-07-31

- **Reconcile a target's spec against the merged tree at planning step 0** — the entry *Have the
  docs phase tick the box* records the drift; this is the other end of the same failure. A
  planning session reads the spec
  as the statement of what is unbuilt, so a stale box means the session is cut against a false
  picture, and the alternative that actually happened was auditing the checklist by hand before
  every planning session.
  Worth parking separately because the fix sits in a different place and survives the other one
  failing or being judged too risky. Step 0 already reads this inbox, so it is the natural place to
  also diff open spec items against what is merged — and *detecting* that a box's claim is already
  true is mechanical in a way that ticking is not, because it needs no judgment about whether the
  claim is gated. Reporting a candidate list to a human is strictly safer than editing the spec.
  `Related:` *Have the docs phase tick the box* — either alone leaves the other half. 2026-07-31

- **Let a task report progress while it is still running, roughly every 10 minutes** — right now
  a container is opaque from the outside: nothing is visible until it exits and the run report is
  written. A task that has been going for an hour is indistinguishable from a task that is wedged,
  and the only lever is to kill it and lose the work. A periodic line — what it is doing, what it
  has finished, which attempt it is on — would make an overnight run watchable and make the
  kill-or-wait call an informed one.
  The out-channel already exists and is the natural place: `pipeline/status.js` is the sole writer
  of `/workspace/.run/status.json`, the workspace is a host mount, so anything appended there is
  readable live without giving the container a new route out. It would be evidence only, like
  `note` and `concern` — self-reported progress can never touch an outcome (hard rule 5).
  The honest catch is that an LLM cannot keep wall-clock time, so "every 10 minutes" from the
  agent's side is a hope, not an interval; a run that goes quiet would be exactly the run you most
  want a line from. Worth weighing against the deterministic alternative — the host already has the
  agent's log stream and could emit its own heartbeat on a real timer, with no LLM involved
  (hard rule 7), possibly with the agent's self-reported lines folded in when they happen to
  arrive. Which of those is right depends on whether the value is "is it alive" or "what is it
  actually doing". 2026-07-30

- **Give the docs phase a merge strategy, or batched runs will always conflict** — file-ownership
  constraints in a spec keep *code* disjoint across a batch, and on 2026-07-30 three chained tasks
  touched three different code areas with no collision at all. Every one of them also edited the
  target's DESIGN.md, README.md and SPEC.md, because the docs phase always does, so every
  merge after the first conflicted — in documentation only, never in code.
  The change-log half resolved cleanly and is evidence the convention works: both sides appended a
  row carrying its own slug, so keeping both was correct and neither renumbered the other
  (change-log row `repo-006`). The prose sections have no such convention, and that is the gap.
  Options worth weighing: an append-only convention for the doc sections a task may touch; a docs
  phase that writes to a per-task file the host merges; or simply accepting the conflicts and
  saying so in the playbook, since resolving them took one pass and no judgment. Filed rather than
  fixed because which of those is right depends on how large batches get. 2026-07-30

- **Say somewhere that a pure refactor cannot be frozen** — the freeze model assumes a task
  changes observable behaviour, because that is what an acceptance test can witness. A
  refactor's defining property is that observable behaviour does *not* change, so the whole
  class — deduplicate two implementations, collapse one rule into one place, extract a
  helper — has no honest criteria available. Two implementations that agree, and one that
  delegates to the other, are indistinguishable from outside; the only possible assertion
  is on source text, which freezes a decision instead of an outcome and fails on the next
  legitimate refactor.
  `advisors/testability.md` already rejects that criterion shape and did so correctly, but
  rejecting it is all the charter can do: it leaves a task whose entire purpose was
  structural with nothing at all, and no charter is the right place to say "this task
  should not exist." The workaround is known and good — fold the refactor into a later task
  that has a behavioural reason to touch the same code, so the cleanup rides along with
  something witnessable — but it currently lives in one project's planning draft, so every
  other project rediscovers it by spending a session drafting a spec that cannot be frozen
  and a panel pass rejecting it. §3.1 or §3.2 is the natural home. 2026-07-30
  *Found by the critic panel on the first real project, 2026-07-30.*

- **Re-read the ready queue when a worker goes idle, so finishing a task can unblock the
  next one** — `bd ready` is already blocker-aware, but `runner/run.js` reads it **once**,
  before the pool starts, and drains that snapshot. So a dependency chain cannot run in one
  batch: if B is blocked on A and A closes ten minutes in, B waits for a whole second run
  even though the host knows it is ready and a worker is sitting idle. Worth having because
  the queue this project actually accumulates is chain-shaped — `repo-sls` → `repo-teq` →
  `repo-i9y` was three batches on three separate runs, and each handoff cost a human
  starting the next one. It also compounds with the concurrency knob rather than duplicating
  it: the measured 1.28× on a two-task batch was one worker idle for 1464s with nothing to
  pick up, which is precisely the hole an unblocked task would have filled.
  Care lives in the details, not the idea: never re-claim what is already in flight, do not
  spin when the queue is genuinely dry, and bound the re-read so an unblock cascade cannot
  loop forever. Legal under hard rule 1 as-is — the host is the only thing reading Beads,
  and it already reads it exactly this way, just once.
  **Not** the same as the two forms of cross-task waiting that already exist and are fine:
  the pool has no barrier (a free worker takes the next queued item immediately), and the
  seconds that `prepare()` / `publish()` / every `bd` call spend blocking the event loop are
  a priced-in trade, load-bearing in the `bd` case — `spawnSync` is what stops two Beads
  calls interleaving over one embedded Dolt database. Blocked on: nothing; `repo-teq` has
  merged. Related: §4.12 (the runner drains the ready queue), §7. 2026-07-31

---

## Promoted

Ideas that made it out, and what they became. Kept so the trail from a half-thought to a
shipped thing survives — the same reason the `DESIGN.md` change log keeps its rationale.

| Date | Idea | Became |
|---|---|---|
| — | — | — |

## Dropped

Ideas considered and consciously declined, with the reason. Worth as much as the promoted
list: it is what stops the same idea being re-raised every few months.

| Date | Idea | Why not |
|---|---|---|
| 2026-07-31 | A documentation-updater agent owning "all relevant documentation", maintaining its own list of the documents that need writing to | The mechanism was under-used, not missing. The docs phase already maintains every file named in `CLAUDE.md`'s reading table — nine container-authored commits have amended `docs/STATUS.md` — so the fix is to *name the files*, not to add an agent. A second agent would duplicate a phase that exists and put an LLM where hard rule 5 wants evidence only. The half worth keeping became the inbox entry on telling the docs phase which files it owns |
