# What batching taught us, before parallelism is built

Evidence gathered on 2026-07-30/31 running **eight tasks through the pipeline in four batches**
against one project. Written as input to the intra-run parallelism work that change-log row
`parallelism-v2` put out of scope — so that work starts from measurements rather than from
guesses. Nothing here is a design decision; §3.2's amendment process still owns those.

## 1. The sequential drain is sound. Do not replace what works.

Eight tasks, **eight `done` outcomes, zero second attempts**, no `tampered`, no `stuck`. The
queue-drain model — read the ready queue once, loop, one container per task, push a branch and
open a PR each time — did not fail once. Whatever parallelism does, it should be a change to
*how many containers run at once*, not to the outcome contract, the verifier, or the retry cap.

## 2. File ownership stated in the spec is what prevented every code collision

Every task in a batch forks from the **same** integration commit, so no task can see any
sibling's work. That is true of batching today and will be equally true of parallelism — it is
not a new problem, it is the same one running concurrently.

What made it survivable: each spec's Constraints section named the files that task owned **and
the files its siblings owned**, in as many words. Across four batches and eight tasks there was
**not one collision in code**. Six different code areas across `scenes/`, `sim/` and `tests/regression/` stayed disjoint
because the specs said so.

**This is the mechanism parallelism should keep and formalise.** It is currently a convention a
human applies while drafting; nothing checks it. A pre-run check that two ready tasks declare
overlapping ownership would turn the convention into scaffolding — the §3.5 ladder move.

## 3. The documentation phase collides every single time, and it is the real blocker

Every task edits the target's `DESIGN.md`, `README.md` and `SPEC.md`, because the docs phase
always does. Result: **every merge after the first conflicted, in all four batches, 100% of the
time.** Never in code — only in prose.

Sequential merging made this survivable: one resolution pass per merge, no judgment required,
because both sides were additive. Parallelism does not make it worse *in kind*, but it removes
the natural serialisation that made it cheap, and it multiplies the number of simultaneous
conflicting edits to the same three files.

One half already works and is worth copying: **`DESIGN.md`'s change log resolved cleanly every
time**, because rows are appended at the bottom and identified by a slug that no other agent
invents (change-log row `repo-006`). Two tasks appending rows produce a conflict git cannot
auto-resolve, but keeping both is *always* correct and neither renumbers the other. The prose
sections have no equivalent convention. That asymmetry is the whole finding.

Options, in the order they look cheapest:
1. Accept it, and say so in the playbook — resolution is mechanical and took one pass per merge.
2. Give the doc sections a task may touch an append-only convention, like §12's.
3. Have the docs phase write a per-task file the host merges, so tasks never touch shared prose.

## 4. The speedup is bounded by the slowest task, and the variance is large

Measured container times, this project (seconds):

| Task | Time | | Task | Time |
|---|---:|---|---|---:|
| Task A | 556 | | Task E | 919 |
| Task B | 668 | | Task F | 1036 |
| Task C | 797 | | Task G | 1788 |
| Task D | 900 | | Task H | 2020 |

Median ~910s, but the range is **3.6×** across tasks of comparable scope. Applying that to the
batches actually run:

- Batch of three (900 + 1036 + 919): sequential **2855s**, parallel **1036s** — a **2.75×** win.
- Batch of two (2020 + 556): sequential **2576s**, parallel **2020s** — a **1.28×** win.

**So the payoff depends almost entirely on how evenly matched a batch is**, not on how many
tasks it holds. A batch containing one long task gets very little. That argues for pairing
parallelism with some notion of batch composition, and it argues against assuming N tasks means
an N× speedup when sizing the work.

Worth noting for scale: the longest run recorded here is a task from an earlier batch at **12,026s** — a task that
bailed after three failed attempts. Parallelism does not help a task that retries; it helps a
batch of tasks that each pass first time, which is what good specs produce.

## 5. What is already safe, and what is not

**Already solved** (change-log row `repo-jur`): the task network and proxy sidecar are per
project, so several runner processes — one per project — are already safe concurrently. That
work is done and proven in anger: four runs today used per-project network and proxy names without touching the shared defaults.

**Not solved, and what parallelism must answer:**
- Two containers in the *same* project sharing one network and one proxy sidecar. Names are
  per project, not per task.
- Two tasks writing the same file, which nothing currently detects before the run.
- The docs collision above, at higher concurrency.
- Beads: the host is the sole writer (hard rule 1), and `bd` calls are currently serialised by
  the sequential loop. Concurrent `fileMemoryNotes` and issue closes need checking against the
  embedded Dolt database — `bd-npm-shim` records two containers deadlocking on it once already.

That last one is the sharpest. It is the failure that will not announce itself.

## 6. What must not change

- **The verifier stays deterministic and frozen-test-driven.** Concurrency changes scheduling,
  never judgment (hard rules 2 and 7).
- **The host stays the only writer to the queue** (hard rule 1). If anything, concurrency makes
  this more important, not less.
- **Planning stays interactive and specs stay frozen before a run** (hard rule 3). Parallelism is
  an execution change; it grants no licence to generate specs unattended.
- **The three-attempt cap and the outcome table** (§4.11) are per task and should survive
  untouched.
