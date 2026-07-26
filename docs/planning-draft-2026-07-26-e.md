# Planning draft — 2026-07-26 (session E): the epic filter

One task. Step-5 approval pass — nothing frozen yet.

## Why

Beads supports hierarchy and the pipeline has been ignoring it. Verified against
`bd 1.1.0` in a throwaway database, not read from documentation:

- **`bd ready` returns the epic itself**, ranked among its children.
- **Closing every child does not close the parent** — it stayed `open` and `ready` after
  both children closed.
- `bd ready --json` returns `issue_type` per entry (and *not* `parent_id` — that appears
  on `show`/`create` only).

So an unfiltered runner would clone a workspace for an issue with no acceptance criteria,
and would do it again on **every subsequent run for the life of the repository**.

`DESIGN.md` §3.1 and §4.12 now declare the filter; this task builds it.

## What the critic changed

| My draft said | Problem |
|---|---|
| G6: `run.js` logs skipped entries | **Unreachable.** The log line needs token + Docker preflight, and `--dry-run` returns *before* the queue loop. No frozen test can execute it. |
| G6, alongside a constraint of "the one log line in run.js" | **Self-contradictory** — G6 demanded two log sites in two places. |
| G2: returns `{ ok, issues, skipped }` | **Shape, not value.** `skipped: []` returned unconditionally passes, while G1/G3/G4/G5 all constrain only `issues`. (This is the "presence standing in for correctness" check added to the charter this afternoon, catching my own spec.) |
| G1/G3 fixtures | **Would pass a wrong fix.** `Array#sort` is stable, so FIFO falls out of input order free unless the fixture is out of order on *both* axes; and an epic at the edge of the list lets a `slice`/`splice` pass the type filter. |
| G7: "the run ends cleanly" | Half unreachable, and `run.js` with an empty task list is untested today — not safe to bake into a criterion. |
| — | **Nothing pinned the surviving log format.** `scripts/test-runner-queue.sh` greps it at six sites; a rewrite breaks a Docker suite the frozen tests cannot see. |

It also caught a **live contradiction in `DESIGN.md` that I introduced**: correcting §4.12
to a deny-list left §3.1 still stating the allow-list. Fixed before this spec was written.

## Task F — The runner skips epics when draining the ready queue

**Difficulty: medium.** **design-ref:** `DESIGN.md` §3.1, §4.12.

### Description
`readyQueue` excludes `issue_type: "epic"` and keeps everything else, returning the
skipped entries so the runner can name them in its queue-summary line. Exclusion is by
name, not an allow-list: admitting only `task` would make a legitimately-typed issue
carrying a full spec vanish from every run with nothing to say why, which is the
silent-failure family this design has paid for three times today.

### Constraints
- `runner/queue.js` and **exactly one** log line in `runner/run.js` (the existing
  `ready queue:` summary at `run.js:121`). Both the skipped-epic clause and the
  ran-a-non-task clause go in that one line. No changes under `pipeline/`, no schema
  change, no new dependency.
- Ordering of survivors unchanged: priority ascending, then `created_at` FIFO.
- **Back-compat, fail-open:** an entry whose `issue_type` is absent, null or empty is
  **kept**. Fail-closed on a missing field would drain nothing at all against an older
  `bd` — the catastrophic direction.
- Docker-free testable through `PIPELINE_BD_CMD`. **The stub must be a `.js` file invoked
  via `process.execPath` with `NODE_OPTIONS=--require "<forward-slash path>"`** — a
  `#!/bin/sh` stub returns `EFTYPE` on the Windows host, which is how `repo-dhp` shipped a
  suite that was green in the container and red in the sweep.
- Do not modify `tests/acceptance/**` or any path in `pipeline.config.json` `frozenPaths`.

### Done means
- **F1.** Given a fixture of four entries where the epic sits **in the middle of sorted
  order and shares a priority with a kept task**, and the input is out of order on both
  priority and `created_at`, `readyQueue` returns exactly the three non-epic entries.
  *(The epic must not be first or last, or a positional `slice` passes.)*
- **F2.** For that fixture, `skipped` has length 1 and its entry carries the epic's `id`
  **and** its `issue_type` — the two fields the log line needs. When `ok` is `false`,
  `skipped` is not required.
- **F3.** Ordering of survivors is priority ascending then `created_at` FIFO, proven on a
  fixture unsorted on **both** axes.
  *(`Array#sort` is stable in Node ≥ 11, so a fixture in FIFO input order passes even if
  the tie-break was dropped.)*
- **F4.** Entries whose `issue_type` is absent, `null` or `""` are kept.
- **F5.** `bug`, `feature`, `chore` and `decision` are kept.
- **F6.** `runner/queue.js` exports a pure line-builder — `queueSummary(issues, skipped)`
  — returning the exact summary string, asserted for three cases: a plain queue, a queue
  with one skipped epic, and a queue containing a kept non-`task` entry. `run.js` calls it
  on a non-comment line.
  **No criterion proves the line is emitted at run time** — that path needs Docker, a
  token, and a git host. The Docker suite `scripts/test-runner-queue.sh` covers it.
- **F7.** The existing format survives, because `scripts/test-runner-queue.sh` greps it at
  six sites: the builder's output still starts `ready queue: <n> task(s) — ` followed by
  comma-joined ids, and renders `(empty)` when there are none. Any skipped/non-task clause
  is **appended** after that prefix.
- **F8.** A queue consisting only of an epic returns `ok: true`, `issues: []`,
  `skipped.length === 1`. *(Nothing about run-level behaviour: `run.js` with an empty task
  list is untested today.)*

## Open question

Approve as revised? One judgement call: F6 pins the builder's name as `queueSummary`. If
you would rather the runner keep composing the string inline, the criterion cannot be
frozen at all — the log line is unreachable from the container, so there would be no
mechanical check on this behaviour whatsoever.

---

# Approved and frozen — 2026-07-26

Approved: `queueSummary` becomes a named exported function so the behaviour is testable
at all. Issue **`repo-4l8`**, priority 1, frozen at `tests/acceptance/repo-4l8/test.js`
(20 checks).

## Step 4 — coverage check

| Criterion | Checks |
|---|---|
| F1 the epic is excluded | 2 (queue read succeeded; epic gone, three tasks survive) |
| F2 skipped carries id + type | 2 |
| F3 ordering survives | 1, on a fixture unsorted on both axes |
| F4 back-compat fail-open | 2 (absent/null/empty kept; nothing skipped) |
| F5 only epic excluded | 1 (bug, feature, chore, decision all kept) |
| F6 queueSummary is a real function | 5 (exported; plain; no false skip mention; epic named with type; non-task called out) + 1 (run.js calls it) |
| F7 the existing format survives | 3 (prefix on plain, on empty, on skipped) |
| F8 epic-only queue | 1 |

No orphan either way.

## Verified red on both platforms

Run in `pipeline-base:local` **and** on the Windows host — identical results, which is the
check `repo-dhp` did not get and paid for. The stub is a `.js` file through
`process.execPath`, so it behaves the same in both places.

The ordering output confirms the fixture discriminates: today's unfiltered queue returns
`["t-a","t-c","e-1","t-b"]`, putting the epic **third of four** in sorted order. An
implementation that dropped an entry by position rather than by type cannot pass F1.
