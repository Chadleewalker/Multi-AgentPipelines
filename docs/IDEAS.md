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
- **Make the sweep count passes in both of the repo's vocabularies** — `scripts/test-all.sh`
  counts a suite's checks with `grep -c '^PASS[[:space:]]'`, but the repo announces a passing
  check two ways: wrapper scripts print `PASS `, while several inner Node checkers print
  `ok - <label>`. Those checkers are invisible to the counter. Observed on 2026-07-30: the
  summary reported `2` for `test-bd-shim`, `test-network-names` and `test-runner-memory`,
  which had actually run **10**, **34** and **30** checks.
  **Only the pass side is affected, and nothing unsafe follows.** The verdict comes from the
  suite's exit code, so a red suite still reads red; and the same checkers print `FAIL - `
  on failure, which `^FAIL[[:space:]]` *does* match, so the secondary net beside it — "a suite
  that prints FAIL but exits 0 is itself broken" — keeps working. The asymmetry is the whole
  bug: failures are counted in both vocabularies, successes in only one.
  What breaks is the `ASSERTS` column's actual job, which is to make coverage quietly
  disappearing *visible*. For a third of the suites it cannot do that — one could fall from 34
  real checks to 3 and the number would still read `2`, because it was never reading them.
  Fix is small (count `ok - ` too, or standardise on one vocabulary). Filed rather than fixed
  because which convention should win is a decision, not a patch. 2026-07-30

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
| — | — | — |
