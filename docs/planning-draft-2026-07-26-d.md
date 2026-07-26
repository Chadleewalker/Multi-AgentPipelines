# Planning draft — 2026-07-26 (session D): the change-log version collision

One task. This is the step-5 approval pass — nothing is frozen yet.

## The defect

Merging PRs #10, #11 and #13 on 2026-07-26, **two of the three claimed the same
change-log version, `v1.9.1`**. Each forked from a base where that number was free and
each numbered its own row. They had to be renumbered by hand at merge — which the log
already records happening once before: *"Renumbered from the PR's v1.7 at merge."*

Version numbers assigned by parallel agents cannot be unique by construction, and the
pipeline is built to run tasks in batches. This will recur on every multi-task run that
touches the design doc.

**The fix you chose:** identify a row by a stable slug instead. For a row produced by a
pipeline task the slug **is** the issue id, which the host assigns and which is unique by
construction — two agents cannot collide because neither invents its own identity.

## What the critics changed

My first draft was substantially wrong, in ways that would have cost the run. Verified
against the file, not taken on trust:

| My claim | Reality |
|---|---|
| 25 rows | **26** |
| 5 rows carry an issue id | **8** (one row names *two* tasks) |
| every row has a version | one row has **none** (`Initial draft, merging v3 handoff…`) |
| rows have 4 pipe characters | one has **7** — `done\|partial\|failed\|stuck` sits in a code span |
| "every date survives" proves no row was lost | only **2 distinct dates** exist, so 24 rows could be deleted and it still passes |
| a slug citation is recognisable | `2026-07-25` matches my own slug regex, and STATUS.md holds **125** kebab-case tokens |

Two criteria were outright **unsatisfiable**: E3 demanded no version token remain in the
table while a constraint forbade editing "why" text — and four rows cite versions inside
their why-text as cross-references. An agent would have hit that wall three times and
bailed.

## Task E — Change-log rows are identified by a slug

**Difficulty: medium** (low end — doc-only, no control-path code).
**design-ref:** `DESIGN.md` §12 (Change Log), §3.1 (the design doc is the canonical home).

### Description
Replace the version number with a stable identity slug, in a dedicated column:
`| Date | Ref | What changed | Why |`. For a row produced by a pipeline task the ref is
that task's issue id; for a row produced by an interactive session it is a short
descriptive kebab-case name. A new Docker-free suite keeps the invariant enforced after
this task ships, so the convention cannot drift back.

### Decisions the critics forced (these are the spec, not commentary)
- **Only the leading identity token goes.** Historical version mentions inside prose —
  including inside "why" cells, where rows cross-reference each other — are **preserved
  as history**. They record what was true when written.
- **A row naming several tasks uses the first-named issue id** as its ref
  (`repo-eyn`, for the row that also names `repo-zdm`).
- **Citations use a pinned form**: the literal phrase `change-log row` followed by the
  slug in backticks — ``change-log row `repo-52m` ``. Without a marker, no script can
  tell a citation from ordinary hyphenated prose or from a Beads memory key like
  `repo-52m-note-4`.
- **This task adds its own change-log row**, per §12's own rule, so the log ends at
  **27** rows.
- **Deliberately out of scope, and stated so in the §12 preamble**: version citations in
  `runner/memory.js`, `pipeline/verify.js`, `scripts/test-verifier.sh` and
  `scripts/test-base-image.sh` (the constraints forbid touching those trees), and the
  doc-level version in DESIGN.md's header (`Status: READY v1.0`) — the *document* still
  has a version; its *rows* no longer do.

### Constraints
- Documentation and one new suite only. No changes under `runner/` or `pipeline/`, no
  schema change.
- Do **not** modify `docs/planning-draft-*.md`, `docs/v1-backlog-draft.md`, or anything
  under `runs/` — frozen historical records.
- No existing row may be lost, and no row's date or "why" text may change.
- The suite is a thin `sh` wrapper over a Node checker, matching
  `scripts/test-runner-memory.sh`'s shape. **Not** a shell-logic suite: `tools/run-acceptance.sh`
  invokes `*.sh` via `sh`, which is bash on the Windows host and dash in the container, so
  shell-only parsing would be green in one and red in the other — the split that already
  bit `tests/unit/memory.test.js`.
- The checker reads `CHANGELOG_FILE` if set, defaulting to `<repo>/DESIGN.md`, so its
  negative cases can be exercised against fixtures.
- Do not modify `tests/acceptance/**` or any path in `pipeline.config.json` `frozenPaths`.

### Done means
- **E1.** Every row in §12's table has exactly four cells, counted **after masking
  backtick-delimited spans**, and the ref is the second cell.
  *(One row contains `done|partial|failed|stuck` in a code span — 7 pipe characters. A
  naive split reds a correct implementation.)*
- **E2.** Every ref matches `^[a-z0-9]+(-[a-z0-9]+)*$` under `LC_ALL=C`, no ref is a bare
  date, and all refs are unique across the log.
- **E3.** No row's **what-changed** cell begins with a version token — for every row,
  that cell does not match `^\s*v[0-9]+\.[0-9]+`. Version tokens elsewhere in prose are
  explicitly permitted and must not be removed.
- **E4.** These rows carry these exact refs, each row identified by its date plus a
  distinguishing substring (the full mapping is in the frozen test): the eight
  task-produced rows use `repo-qyd`, `repo-zdm`, `repo-eyn`, `repo-4gp`, `repo-52m`,
  `repo-wxh`, `repo-1cy`, `repo-dhp` — with the two-task row taking `repo-eyn`.
- **E5.** All 26 pre-existing rows survive, verified by **per-row fingerprint**: the
  frozen test embeds the first 60 characters of each row's why-cell and asserts each
  appears exactly once, in the original order. Total row count is exactly 27 (26 + this
  task's own row).
  *(A count floor and a date check cannot do this: only two distinct dates exist.)*
- **E6.** Of the five living documents — `docs/STATUS.md`, `CLAUDE.md`, `PLANNING.md`,
  `ONBOARDING.md`, `README.md` — none cites a DESIGN.md change-log version any more, and
  every citation written in the pinned form ``change-log row `<slug>` `` resolves to a ref
  that exists in the log.
- **E7.** `CLAUDE.md`'s "Changing the design" section contains both the literal words
  `slug` and `issue id`; `DESIGN.md`'s §12 preamble contains `slug` and `unique`.
  *(Literal tokens, not "states the rule" — a script cannot judge whether prose explains
  anything. Whether it explains it *well* is a review note, not a criterion.)*
- **E8.** `scripts/test-changelog.sh` exists, is named to match the sweep's
  `scripts/test-*.sh` glob, prints `PASS  ` / `FAIL  ` lines, and exits 0 against the real
  `DESIGN.md`.
- **E9.** The negative cases work, through the `CHANGELOG_FILE` seam: given a fixture with
  a duplicate ref the suite exits non-zero; given a fixture with a version-numbered row it
  exits non-zero.
  *(Without the seam this is unfalsifiable — a suite whose duplicate detection is a no-op
  passes "exits 0 on the good file".)*
- **E10.** `bash scripts/test-all.sh --list` includes `test-changelog.sh`.
  *(`--list` returns before the lock and before the Docker preflight, so this is
  Docker-free. It must be invoked with `bash`: the sweep uses bash arrays.)*

## Open question

Approve as revised? The one judgement call left is the citation form —
``change-log row `repo-52m` `` reads naturally in prose and is unambiguous to a script,
but it is wordier than `v1.8.3` was. The alternative is a bracket form like
`[changelog: repo-52m]`, which is uglier to read but trivially greppable.

---

# Approved and frozen — 2026-07-26

Citation form: ``change-log row `<slug>` ``. Issue **`repo-006`**, priority 1, frozen at
`tests/acceptance/repo-006/test.js` (42 checks).

## Step 4 — coverage check

| Criterion | Checks |
|---|---|
| E1 four cells after masking | 1 |
| E2 slug refs, no bare date, unique | 3 |
| E3 no leading version token, history preserved | 3 (including 2 that fail if history is scrubbed) |
| E4 the seven task rows and their refs | 8 (7 rows + repo-zdm is not its own ref) |
| E5 27 rows, 26 preserved in order by fingerprint | 2 |
| E6 living docs cite slugs, not versions | 11 (2 per document + 1 that the form is actually used) |
| E7 the convention is written down | 4 literal-token checks |
| E8 the suite exists and passes | 4 |
| E9 the suite rejects bad input | 4 |
| E10 the sweep discovers it | 1 |

No orphan either way.

## Two flaws found in my own test before freezing

1. **E9 passed vacuously.** `sh` on a missing script exits non-zero, so "a duplicate ref
   makes the suite exit non-zero" was satisfied by the suite *not existing*. Each negative
   case now also requires a `FAIL` line, which proves the checker ran and detected the
   defect rather than being absent. Confirmed: that half is red today.
2. **E2's failure message was unbounded** — a ref cell holds a whole paragraph before this
   task runs, so the FAIL line dumped ~1000 characters into what would become the PR body
   and the run report. Truncated to three samples of 40 characters.

## Verified red for the right reason

Run in `pipeline-base:local`. The E3 and E5 counts read oddly in the pre-state — the table
still has three columns, so cell index 2 is "why" rather than "what changed" — which is
exactly what the task changes. Every failure names behaviour that does not exist yet.
