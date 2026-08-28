# Draft for approval — the idea inbox and the run queue are the same list

**Status:** proposal, not approved. Written 2026-08-27 after investigating why three
consecutive runs against the first real project dispatched nothing and said nothing.

---

## The observation that started it

Five issues in that project have been refused by the dispatch gate on every run since
2026-08-25, because no frozen acceptance suite exists for them anywhere — not on the
integration branch, not unpushed in the working copy, not written at all.

The initial reading was that a planning session had skipped step 6. It had not. **None of
the five ever entered a planning session.** They were filed as ordinary issues — three
bugs, two chores, one feature — during working sessions on 2026-08-25 and 2026-08-27, as
follow-up work someone noticed while doing something else. The last batch marker for that
project is dated 2026-08-23 and names three unrelated ids, all of which were frozen, ran,
and came back `done`.

So the freeze discipline is holding wherever the playbook actually runs. The gap is
upstream of it.

## The mechanism

`bd ready` returns every open, unblocked issue. `runner/queue.js` treats that list as the
run queue, minus entries typed `epic`. `PLANNING.md` step 8 is where a person is supposed
to reconcile the two — *"anything in the list that is not meant to run this batch must be
blocked or closed, not merely retyped."*

That checklist item only fires during a planning session. An issue filed **after** the last
planning session never passes through it. It simply appears in the queue, and stays there.

Filing a bug is meant to cost nothing. Today it silently enlists that bug for the next
unattended run.

## What already works, and what it cost

The dispatch gate (§4.12's second admission rule) catches every one of these before
anything is claimed. Nothing was dispatched that should not have been, no container was
spent, no issue was touched in Beads. **The safety property held throughout.**

What failed was the *reporting* of it, and for an unrelated reason: `runner/run.js` built
its feed source without passing the startup roster's refusals, so `source.undispatchable()`
returned nothing and the manufactured rows §4.12 exists to produce were never produced.
Three runs wrote `"tasks": []` and reports reading `**0 task(s)**: none`. A queue the gate
had wholly refused was indistinguishable from a queue nobody had filled.

Fixed and merged separately — change-log row `refused-rows-lost`. From now on every refusal
appears in the manifest, the report and the run log, with the remedy attached.

**That fix is sufficient to make the problem visible. It is not sufficient to make it stop
happening**, which is what this draft is about.

## Why visibility alone is not the answer

The five refusals will now appear in every report of every run against that project, for as
long as the issues stay open. Two of them are eight days old. A report whose most prominent
section is five entries the reader has already decided to ignore is a report that trains
its reader to skim — and the section it trains them to skim is the one reserved for
`tampered` and `undispatchable`, the two outcomes ranked above everything else precisely
because they must never be skimmed.

The gate is a backstop. Backstops should be quiet in normal operation. This one is now
load-bearing for routine housekeeping, which is the wrong job for it.

## Proposal

**Make entry to the run queue an explicit act, and keep filing an issue free.**

Concretely, one of two shapes — the first is preferred:

### Option A — the queue is opt-in (recommended)

`runner/queue.js` admits only issues carrying an explicit marker applied at freeze time.
The marker is set in `PLANNING.md` step 6, in the same breath as pushing the suite, so
there is one moment where a person says *this is ready to run* and it is recorded.

- Filing a bug or a chore enqueues nothing, ever. The inbox and the queue separate.
- The dispatch gate stays exactly as it is, and goes back to being a backstop: it now only
  fires when someone marked an issue ready and the push genuinely did not land, which is a
  real defect worth a loud report row.
- `batch.js show`'s live-queue reconciliation gets sharper — a `stray` becomes an anomaly
  rather than the normal state of a project with an active inbox.
- Cost: one more step in the playbook, and a migration pass to mark whatever is genuinely
  ready today.

### Option B — the queue stays as it is, and the report learns to age

Keep admission unchanged; teach the report to distinguish a refusal it has never reported
before from one it has reported on every run for a week, and rank the stale ones below the
fold.

- Cheaper, changes no contract, needs no migration.
- But it treats a design mismatch as a presentation problem, and the queue still means two
  different things depending on who last touched it.

## Recommendation

**Option A.** The pipeline's whole warrant is that nothing during a run may change what
"done" means, and that the user approves *what* before a run starts. An issue that reaches
the queue without anyone approving it is outside that contract — it is caught today only
because a second, independent mechanism happens to notice the missing tests. Two
independent mechanisms disagreeing about what the queue means is the thing worth removing.

## What is not proposed

- No change to the dispatch gate itself. It works, and it is the reason this cost nothing
  but three quiet reports.
- No change to the verifier, to `frozenPaths`, or to anything a task container can reach.
- No LLM anywhere in the admission path.

## Open questions for the approval conversation

1. **What is the marker?** A Beads label, a dedicated status, or a distinct issue type.
   This decides how much of `runner/queue.js` and `scripts/batch.js` moves, and whether
   `bd ready` stays the right query at all.
2. **What happens to the five open issues** in the first real project — mark them ready and
   spec them, or leave them as inbox items and let the queue forget them.
3. **Does the same marker gate the live queue feed?** Under feeding, an unmarked issue
   filed mid-run would currently become eligible the moment a worker frees up.
