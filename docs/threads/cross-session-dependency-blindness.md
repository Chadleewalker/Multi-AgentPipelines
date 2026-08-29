# Thread — a planning session cannot see the tasks its siblings are filing

```
slug:     cross-session-dependency-blindness
status:   open
opened:   2026-08-29
origin:   user directive, 2026-08-29 — "I find myself spawning new agents and adding tasks
          that might be dependent on the other task, but the agent might not know about it
          at planning time"
related:  PLANNING.md §1 (sizing, where dependencies are first noticed), §6 (filing, where
          they become real), §8 (the pre-run checklist);
          docs/planning-draft-2026-08-27-queue-admission.md (Option A, approved
          2026-08-27 — the admission moment this thread wants to hang a check on);
          docs/parallelism-findings-2026-07-31.md §2 (file ownership is what prevented
          every code collision, and nothing checks it);
          docs/parallelism-graph-2026-07-31.md (write-set disjointness decides what may
          run concurrently);
          docs/threads/merge-order.md (the same question asked after the PRs exist);
          docs/parallel-sessions.md (one worktree per session — the structure that
          creates the blindness)
```

**The question this thread has to answer:** where a dependency between two tasks filed by
two mutually invisible planning sessions is supposed to be discovered, given that neither
session can see the other's work, and what it costs to discover it there.

---

## Current thinking

### 1. The gap

Sessions are deliberately isolated — one worktree, one branch, one idea, and the working
assumption that at least one sibling is running right now in a folder this one cannot see.
That isolation is what makes parallel sessions cheap, and it is exactly what makes a
dependency invisible: a session sizing a task in §1 and filing it in §6 knows its own
design section and nothing about the task another session froze twenty minutes ago.

So a dependency edge that ought to exist is never declared. Nothing catches it afterwards,
because everything downstream trusts the declaration:

- `bd ready` returns both tasks as unblocked, since the edge was never entered.
- The runner has no picker — it drains the queue the user shaped, priority-first. Two
  tasks that should have been ordered are dispatched in whatever order priority and FIFO
  produce, or concurrently.
- Each task clones fresh and branches off the integration branch, so neither can see the
  other's work even while both are running.

Two distinct failure shapes come out of that, and they want different answers:

- **Ordering.** Task B needed A's code to exist. B runs first, its agent finds no such
  code, and either fails, stalls, or — worse — builds its own version of A's work, which
  then arrives as a second pull request touching the same surface.
- **Collision.** Two tasks write the same file from the same fork point. Both may pass
  their own frozen tests and both pull requests are individually green; they cannot both
  merge. Measured on this project: across four batches and eight tasks, **zero** code
  collisions, and the whole reason was that each spec's Constraints named the files that
  task owned and the files its siblings owned. That is a convention a human applied while
  drafting. Nothing reads it.

### 2. The wrong fix: make each planning session omniscient

The tempting answer is to have every planning session read the whole open queue before
filing and reason about what else might be in flight. It fails on three counts, worth
writing down so the option is not re-proposed:

- A session cannot see work that is **not yet filed**. The sibling session drafting a spec
  right now has nothing in Beads to read. The window where both tasks are invisible to
  each other is precisely the window in which both are being written.
- It puts a cross-cutting judgment inside the one artifact the playbook works hardest to
  keep narrow. A spec cites one design section; asking it to also reason about the global
  backlog is scope creep with a different name.
- It scales as N², paid by every session, to catch a case that arises in a handful of
  pairs.

### 3. The proposal: discover it where both tasks are visible, once

There is exactly one moment when every candidate for a run is on the table at the same
time: the pre-run pass over the ready queue, on the main checkout, before anything is
dispatched. That is where the cross-check belongs — not because it is convenient, but
because it is the **only** place the information exists.

The approved queue-admission change (Option A, 2026-08-27) already puts a deliberate human
moment there: an issue enters the queue only when someone marks it ready to run. This
thread proposes that the same moment gain a reader that looks at the admitted set as a set:

- **Overlapping write sets.** For each pair of admitted tasks, do their declared owned
  files intersect? An intersection with no dependency edge between them is a finding — the
  user either declares the edge, blocks one, or accepts the collision knowingly.
- **Undeclared ordering.** Pairs whose design refs point at the same design section, or
  whose owned files sit in the same area, surfaced as *worth a look* rather than as a
  verdict. This half is a prompt for judgment, not a check.
- **Degrade by naming.** A task that declares no write set is reported as undeclared, not
  silently treated as disjoint. Silence must never read as clearance.

The reader is a pure reader on the established model — it computes nothing about merges,
touches no working tree, opens no pull request, and is never a gate. Exit 0 whatever it
finds. The user decides; the tool only removes the archaeology.

### 4. What has to change for that check to be possible

One thing, and it is the load-bearing part of this thread: **file ownership has to move
from prose in the Constraints field to a machine-readable list on the issue.**

Today ownership is stated in as many words, in a sentence written for the implementing
agent to read. That is the right place for it to *also* live — the constraint has to reach
the container — but it is not readable by a script without exactly the kind of guessing
this repo bans in scaffolding. A structured field alongside it costs a planning session one
line and makes every check above a join instead of a parse.

The declaration is also checkable after the fact, which is what turns it from paperwork
into evidence: a run's actual diff can be compared against what the task declared it owned.
A task that wrote outside its declared set is a finding worth having, and it is the
escalation-ladder move this repo already uses — a convention becomes a declaration, the
declaration becomes checkable, and only what proves fragile becomes a test.

### 5. What this does not fix

- It does nothing for two tasks **being drafted simultaneously** in two sessions. Nothing
  can, short of a claim registry, and that is a heavier mechanism than the problem has so
  far earned. The admission pass catches the pair before either runs, which is early
  enough — the cost of catching it there is a conversation, not a wasted container.
- It does not reduce merge conflicts. Ordering never can — a file touched by k pull
  requests conflicts in k−1 merges whatever the order. The merge-order thread owns the
  after-the-run half of this question and states that ceiling; this thread is its
  before-the-run counterpart and inherits the same honesty.
- It says nothing about the docs phase, which collides every time for reasons unrelated to
  what any spec declares.

## Decisions

*(none yet — this thread was opened from the observation and has not been reviewed)*

## Open questions

- **Where does the structured write set live?** A dedicated issue field, or a parsed
  convention inside Constraints. The field is cleaner and costs a Beads mapping change; the
  convention is free and is the kind of parse this repo distrusts.
- **Does the check run at admission, at the pre-run checklist, or both?** Admission catches
  it earliest but sees one task at a time unless it re-reads the whole admitted set; the
  pre-run pass sees the whole set by construction but fires later.
- **Is glob-level declaration enough**, or does it need exact paths? Globs are what a
  planning session can honestly promise before the code is written; exact paths are what
  makes the after-the-fact diff check sharp.
- **Should an undeclared write set block admission** once the field exists, or only be
  named? Blocking makes the field real; naming keeps the freeze gate the only hard stop.

## Log

- 2026-08-29 — Thread opened from a user observation about spawning parallel planning
  sessions whose tasks may depend on each other. Established that the failure has two
  shapes (ordering and write-set collision), that per-session omniscience cannot work
  because the sibling's task may not be filed yet, and that the admitted queue is the only
  place both tasks are simultaneously visible. Identified the one prerequisite: file
  ownership has to become machine-readable, which it is not today despite being the
  mechanism that has prevented every code collision measured so far.

## Outcome

*(empty until the thread closes — then: promoted to what, or dropped and why)*
