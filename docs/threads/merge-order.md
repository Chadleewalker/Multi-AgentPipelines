# Thread — a merge-order helper for the PR fan a run hands back

```
slug:     merge-order
status:   promoted (2026-08-19)
opened:   2026-08-19
origin:   docs/IDEAS.md, top entry, 2026-08-19 ("A merge-order helper for PR stacks —
          evidence, never a merge")
related:  DESIGN.md §5 (the review phase and its pure readers), §4.2 (fresh clone per
          task), §4.4 (verification), §4.11 (the outcome table), §4.12 (runs/); hard
          rule 5 (never a gate) and hard rule 7 (no LLM in the scaffolding);
          scripts/verdict.js and scripts/audit-runs.js (the reader precedents);
          docs/threads/batch-ready-marker.md (the bd-seam resolution this reuses); the
          docs/IDEAS.md entry "Give the docs phase a merge strategy" (2026-07-30), which
          this measures rather than fixes
```

**The question this thread has to answer:** what a human needs to know before merging a
batch of sibling PRs, where that knowledge comes from, and how a tool can produce it
without ever merging, pushing, fetching or gating — such that the merge pass gets faster
and the boundary the outcome contract draws around merging stays exactly where it is.

---

## Current thinking (the proposal — rewritten in place, never appended to)

### 1. The gap, stated precisely

A run hands back N pull requests and a report. Everything upstream of that has
scaffolding — the queue, the workspace, the verifier, the report, the verdict recorder,
the corpus audit. The merge pass has none. It is the one part of the loop where a human
does unassisted archaeology, and it gets worse linearly in batch size.

Three costs, all of them already observed rather than imagined:

- **Docs-phase collisions.** Every task's docs phase edits the target's `DESIGN.md`,
  `README.md` and `SPEC.md`, because that is what the docs phase is for. Code stays
  disjoint by file-ownership constraints in the specs — on 2026-07-30 three chained tasks
  collided in no code at all — and every merge after the first conflicted anyway, in
  documentation only. The change-log half resolves itself (both sides append a row
  carrying its own slug, so keeping both is correct — change-log row `repo-006`); the
  prose sections have no such convention.
- **Sibling-suite noise.** `PLANNING.md` step 8 pushes *every* frozen test in the batch to
  the integration branch before the run. So each task's clone contains its siblings'
  acceptance tests, and its regression run fails on tests for work nobody has done yet.
  That is the recorded cause of a whole batch reading `partial` in the corpus (DESIGN.md
  §5, the 2026-08-04 hand pass). At review time the human has to decide, per PR, whether a
  red regression line is a real defect or a sibling that has not merged yet.
- **Evidence staleness.** Every PR's green describes the tree it was verified against. The
  first merge moves the integration branch, and from that moment every remaining PR's
  evidence describes a tree that no longer exists. Nothing says which ones are affected.

None of this is hard. All of it is rediscovered by hand, per batch, from scratch.

### 2. It is a fan, not a stack — and that changes the problem

The inbox entry says "PR stacks". It is not one, and the correction matters.

`runner/workspace.js` clones the target fresh for each task and branches off
`origin/<defaultBranch>`. The PRs are therefore **siblings off one integration branch**,
not a chain — and because each clone happens when that task starts, two tasks in the same
run can have **different fork points** (concurrency, or a human merging something
mid-run).

Two consequences:

- There is no order to read off the git graph and no rebase chain to preserve. The order
  is a free choice, which is exactly why choosing it well is worth tooling.
- Fork points must be **read, not assumed**. `run.json`'s task rows carry `branch`,
  `prUrl` and `diffLines` but no fork point; `run.log`'s unconditional
  `workspace ready: … (fork point ########)` line carries an abbreviated one. Neither is
  needed: `git merge-base <branch> <integration>` recovers it exactly, from the same
  repository the merge will happen in, which is the only source that cannot go stale.

### 3. The ceiling: order does not change how many conflicts there are

A file touched by k of the PRs conflicts in k−1 of the merges, whichever order they go in.
Ordering does not reduce the work, and a helper that implies otherwise is lying.

What ordering actually buys, in the order the value falls:

1. **Every non-colliding PR merges with zero judgment**, first, in any order — a batch
   where two of five collide becomes three free merges and one decision.
2. **The remaining judgment is named, clustered and taken once**, with the human holding
   the context for all of it, instead of discovered one conflicted merge at a time.
3. **Dependencies are respected** — a dependent PR never merges into a tree missing its
   dependency, which is the one ordering error that produces a broken integration branch
   rather than merely an annoying afternoon.
4. **Staleness and expected-to-clear failures are named per step**, so the human knows
   which greens stopped meaning anything and which reds are about to fix themselves.

The report states this ceiling in its own first lines. A tool whose headline claim is
"fewer conflicts" would be measured against something it cannot deliver.

### 4. It computes the merges; it does not predict them

The obvious implementation — intersect the changed-file sets and guess — is a heuristic,
and heuristics in this repo's scaffolding are how a tool ends up non-empty, well-formed
and wrong.

`git merge-tree --write-tree` performs a real merge in memory: it prints the resulting
tree, names every conflicted path, and exits 1 on conflict, 0 on clean. Feeding its tree
to `git commit-tree` and merging the next branch onto *that* simulates an entire merge
order, step by step.

Proven on the reference host, 2026-08-19, git 2.54: three sibling branches, one end-to-end
simulated order, exact conflicted filenames at each step, correct clean/dirty verdicts
throughout. So every conflict the report names is one that *happened*, in a simulation of
the exact order it proposes — deterministic scaffolding with nothing left to be wrong
about (hard rule 7's spirit, applied where hard rule 7 does not reach).

The simulation is exact for a merge commit and for squash-and-merge, and **approximate for
rebase-and-merge**, which replays commits individually and can conflict where a single
combined merge does not. The report says which strategy it simulated.

### 5. Staying a literal pure reader while doing it

`merge-tree` and `commit-tree` write objects, and `scripts/audit-runs.js`'s contract
(change-log row `repo-73k`) is that a reader creates, modifies and deletes nothing.

The resolution is measured, not asserted: run both with `GIT_OBJECT_DIRECTORY` pointed at
a temporary directory and `GIT_ALTERNATE_OBJECT_DIRECTORIES` pointed at the repository's
real object store. Every object the simulation produces lands in the temporary directory
and is deleted with it; the same test on 2026-08-19 measured **zero** new objects in the
real repository across a full three-step simulation.

Two more read-only commitments follow from the same principle:

- **It never fetches.** It reads the working copy at `targetRepoPath` as it finds it. A
  branch that is not present locally is *named as missing*, and the report says the order
  it computed is partial — the dashboard's degrade-by-naming, never a silent subset. A
  `--fetch` flag exists so the human can say "yes, update my refs", and that is the only
  path by which the tool writes anything anywhere.
- **It never touches a working tree, an index, or a ref.** No checkout, no stash, no
  temporary branch. The user's target working copy is safe to have dirty while this runs,
  which matters because it will usually be run *during* the review.

### 6. What it costs to run

Not N! — a five-PR batch has 120 orders and an eight-PR batch has 40 320.

- **Exact pairwise collision graph**: N choose 2 simulations (10 at N=5, 28 at N=8), each
  an in-memory merge. That is the true graph, not an approximation of it.
- **One end-to-end verification**: N simulations of the order actually proposed, which is
  what licenses the report to say "at step 3, `DESIGN.md` conflicts" as a fact.

Everything reported is simulated. Nothing is inferred.

### 7. What it prints

One markdown report to stdout, exit 0 whatever it finds, the `audit-runs.js` shape:

- **The PR set** for the run — issue id, title, branch, PR url, outcome, diff size.
- **The ceiling**, in two lines, before anything that could be mistaken for a promise.
- **The clean set** — PRs that collide with nothing; merge in any order, no judgment.
- **The collision clusters** — which PRs, which files, from the merges that were run.
- **The suggested order** — with one clause of reason per position, and the conflicts the
  simulation hit at each step, named by file.
- **Expected-to-clear regressions** — PRs whose stored regression evidence names a
  *sibling's* frozen test directory. This is a join on issue ids the report already holds,
  not log scraping (§3.6's ban is about parsing *agent* logs structurally, and an issue id
  is a key, not a guess). The honest limit: `verify.json` keeps only the last 2000
  characters of regression output, so a match is evidence and **silence is not**. The
  report says so where it prints the section, not in a footnote.
- **Staleness** — after each step, which remaining PRs were verified against a fork point
  the integration branch has moved past, and which of those have diffs overlapping what has
  just been merged. The second list is the one worth re-running before merging.

### 8. The boundaries

- **Never merges.** No merge, no push, no branch, no `gh`, no network. The outcome
  contract makes merging the human's act (§5); the whole value here is that it stays that
  way while the human gets faster at it.
- **Never a gate.** Exit 0 on any finding, no `--strict`, no CI mode. Hard rule 5's shape
  applied to scaffolding, the same as `verdict.js` and `audit-runs.js`.
- **Never a queue item.** Nothing in `runner/` or `pipeline/` reads it or is read by it.
- **Host-only output.** The report names targets, PR urls, issue ids and branch names, so
  any kept copy goes under the git-ignored `runs/` with everything else that names the
  work. The tool itself is generic and tracked.

The cautionary tale the inbox entry cites belongs here rather than in the prose above: an
agent platform auto-merging PRs past failing integration tests (a public field report,
2026-01). The borrowed part is the **queue discipline** — knowing what order work should
land in, and saying so. The autonomy is explicitly not borrowed, and this section is the
recorded reason.

### 9. Where the dependency edges come from

Ordering constraint (3) needs to know which PR depends on which. Two sources:

- **Beads holds the real edges.** Reading them needs `bd` on the host, which puts this in
  the position `docs/threads/batch-ready-marker.md` already resolved: read through a named
  seam, **read-only** (hard rule 1 — the host is the only writer, and this is not the host
  writing), and where `bd` is absent, label the order *dependency-unconstrained* rather
  than print it as though the constraint had been checked.
- **The run's own order is a free approximation.** The runner drains a dependency-ordered
  ready queue, so the sequence in `run.json` mostly encodes the edges already. It is only
  an approximation — above concurrency 1 the rows record completion order, not claim
  order — so it is the fallback, and the report labels it as inferred when it is used.

### 10. What this does *not* fix, and what would shrink it

The 2026-07-30 inbox entry "Give the docs phase a merge strategy" wants to *remove* the
docs collisions; this thread *measures* them. That order is deliberate — the entry parks
three options (an append-only convention, a per-task file the host merges, or accepting the
conflicts and saying so) and says explicitly that which is right depends on how large
batches get. Numbers from a tool that computes real merges over real batches is what turns
that into an evidence-led choice rather than a taste one.

The honest consequence, named now rather than discovered later: **if the docs phase moves
to per-task files, most of the collisions disappear and this helper shrinks to its
dependency and staleness halves.** Those are still worth having, and they are the halves
nothing else can produce — but it would be a smaller tool than it looks like today, and
anyone weighing the build cost should weigh that.

---

## Decisions

- 2026-08-19 — **It computes merges with `git merge-tree`; it never predicts them from
  file-set overlap.** A heuristic here fails the way STATUS defect 8 failed — plausibly.
  (drafter)
- 2026-08-19 — **The pure-reader contract is kept literally, via a redirected object
  directory, and measured rather than asserted.** (drafter)
- 2026-08-19 — **It never fetches without `--fetch`, and names what it cannot see.** The
  tool runs during review, against a working copy that is in use. (drafter)
- 2026-08-19 — **The report states the invariance ceiling before it states any benefit.**
  Ordering does not reduce conflict count, and a tool that lets a reader believe otherwise
  is mis-sold. (drafter)
- 2026-08-19 — **Host-only output under `runs/`; the tool is tracked, its output never
  is.** Forced by the publication boundary, not chosen. (drafter)
- 2026-08-19 — **Dependency order is inferred from the run record, not read from Beads,
  and labelled as inferred.** The equivalent question in `batch-ready-marker` went the
  other way because the mismatch there had no other detector; here a wrong order costs an
  afternoon rather than hiding a defect, and the `bd` dependency is not worth that.
  (user)
- 2026-08-19 — **The input is a run id.** It joins the corpus for free and covers the
  common case: one batch, one run, reviewed the next morning. A branch-set mode is not
  ruled out later; it is not the first thing. (user)
- 2026-08-19 — **The expected-to-clear regression section ships, with its limit stated
  where it prints.** It is the section a human reading a `partial` batch most needs, and
  the fragility is bounded and sayable: a match is evidence, silence is not. (user)

## Open questions

*(none blocking — all three were settled above. Two left for the planning session that
specs this:)*

- **Which merge strategy does the target actually use?** The simulation is exact for merge
  and squash and approximate for rebase-and-merge. Whether that is read from somewhere,
  passed as a flag, or simply declared in the report is a spec-level call.
- **Does the report name a single order, or the clean set plus the clusters and let the
  human sequence the rest?** A single order is easier to follow and slightly overclaims,
  since orders within a cluster are usually equivalent.

## Log

- 2026-08-19 — Thread opened from the top `docs/IDEAS.md` entry, same day it was filed.
  Established that the PR set is a fan rather than a stack (`runner/workspace.js` branches
  every task off `origin/<defaultBranch>` from a fresh clone), that ordering cannot reduce
  conflict count, and that `git merge-tree` + `commit-tree` can simulate a whole merge
  order exactly. Measured on the reference host that redirecting `GIT_OBJECT_DIRECTORY`
  keeps the simulation from writing a single object into the real repository. The inbox
  entry gained a `Thread:` line.
- 2026-08-19 — User settled all three open questions (run id in, `bd` out, regression join
  in). Promoted: the `DESIGN.md` §5 block written and change-log row `merge-order`
  appended, the inbox entry moved to the **Promoted** table citing this thread.
  `scripts/test-changelog.sh` and `scripts/test-sanitize.sh` green.

## Outcome

**Promoted 2026-08-19 to a `DESIGN.md` §5 block and change-log row `merge-order`.**

What is left is the implementing task, which a planning session specs and freezes:
`scripts/merge-order.js` (run-id input, the `merge-tree`/`commit-tree` simulation under a
redirected object directory, the pairwise collision graph, the suggested order, the
expected-to-clear regression join, `--fetch` as the only write path), a Docker-free suite
beside the others in `tests/unit/`, and the CLAUDE.md "Running things" entry — which
belongs to that task's docs phase, since until it ships it would document a tool that does
not exist.
