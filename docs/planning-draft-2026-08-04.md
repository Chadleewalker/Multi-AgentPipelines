# Planning draft — 2026-08-04

One task this session: the review verdict recorder, promoted from `docs/IDEAS.md`
(2026-08-04 entry) via DESIGN.md §5 and change-log row `review-verdict`. This draft is
superseded by the Beads issue at freeze and is disposable after the run (PLANNING.md
step 5).

Fixture ids and URLs in this draft and its tests are invented (`app-001`,
`https://example.invalid/pr/7`) — this file is public and names no target project.

---

## Task: record the reviewer's verdict on every PR-bearing task

**Label:** medium
**Issue:** `repo-1ie` — frozen 2026-08-04; tests at `tests/acceptance/repo-1ie/`
**design-ref:** DESIGN.md §5 (change-log row `review-verdict`)

### Description

A host-side capture step for the review phase. `scripts/verdict.js record <issue-id>
<merged|rejected> "<why>"` writes `runs/<runId>/tasks/<issue-id>/verdict.json` into the
run that produced the PR being judged; `scripts/verdict.js pending` lists every
PR-bearing task that still lacks one, so an unfinished review is visible rather than
remembered. Deterministic, host-only, evidence never a gate. Ships with a Docker-free
suite (`scripts/test-verdict.sh` over `tests/unit/verdict.test.js`) so the sweep covers
it forever.

### Constraints

- No LLM anywhere (hard rule 7). Never a gate (hard rule 5): `record` never edits
  `run.json`, `status.json` or any existing artifact — it only creates or overwrites
  `verdict.json`; `pending` exits 0 whatever it finds. Usage errors (bad verdict word,
  empty reason, unknown issue) exit non-zero **and write nothing** — validate before
  any write.
- No Beads access of any kind — the script must work on a host with no `bd` installed.
- `scripts/verdict.js` is **self-contained**: node built-ins only, no requires of other
  repo files, so a copy of the file works from any repo-shaped root (the tests rely on
  this to prove default-path resolution).
- Everything written stays under the runs root. Nothing tracked ever carries a
  verdict's content; all test fixtures are generic.
- **Pinned decisions** (from the fresh-context read of the real `runs/` tree, sharpened
  by the critic pass):
  - "Most recent run" is ordered by `run.json`'s `startedAt`, never by runId sort
    (three naming shapes exist and sort wrong against each other) and never by
    directory mtime (untrustworthy after a copy). A run whose `run.json` parses but
    lacks a parseable `startedAt` sorts oldest and is never chosen over a dated run.
    `--run <runId>` overrides recency.
  - The default runs root, when `VERDICT_RUNS_DIR` is unset, is **resolved from the
    script's own location** (`<script dir>/../runs`), never from the working
    directory. A missing runs root is treated as empty: `pending` exits 0, `record`
    fails as "unknown issue".
  - Entries under the runs root that are not run directories — a regular file, a
    directory with no `run.json`, a malformed `run.json` — are skipped silently (all
    three shapes exist in the real tree).
  - `prUrl: null` is a real value in real manifests: `pending` counts only a truthy
    non-empty string as PR-bearing; `record` copies `prUrl` only when truthy and
    otherwise writes a `verdict.json` with **no** `prUrl` key.
  - `record` creates `tasks/<issue-id>/` when the chosen run lacks it.
  - Re-recording the same (run, issue) overwrites — the reviewer's latest word wins,
    one `verdict.json`, `recordedAt` says when.
- Test seam: `VERDICT_RUNS_DIR` re-aims the runs root (the `CHANGELOG_FILE` /
  `SANITIZE_FIXTURE_DIR` pattern). Any stub is a `.js` file via `process.execPath`,
  never `#!/bin/sh` (defect 9). Timestamps in fixtures are computed, never hardcoded.
- Purely additive: no changes under `runner/`, `pipeline/`, `schemas/`, or
  `scripts/test-all.sh`. Docs updates ride along per the docs phase's normal rules.

### Done means

1. **`record` picks the newest run carrying the issue, by `startedAt`, and writes a
   complete verdict.** Against a fixture with three runs carrying `app-001` — the
   `startedAt`-newest has a runId that sorts older lexicographically *and* an older
   directory mtime; a third run's `run.json` parses but has no `startedAt` — `record
   app-001 rejected "spec drift"` exits 0 and creates `tasks/app-001/verdict.json` in
   the `startedAt`-newest run only (creating the `tasks/app-001/` directory), with
   `issueId`, `runId`, `verdict`, `reason` exactly as given, `recordedAt` an ISO
   string parsing inside the test's own start/end window, and `prUrl` equal to that
   task row's value. The undated and older runs gain no file.
2. **`--run` overrides recency, overwriting is in place, and a null `prUrl` is
   omitted.** `record app-001 merged "second thoughts" --run <older-runId>` writes
   into the older run, whose task row carries `"prUrl": null` — the written
   `verdict.json` has no `prUrl` key. A second `record` repeating the same `--run`
   leaves exactly one `verdict.json` there with the later call's contents, and the
   `startedAt`-newest run's `tasks/` is asserted unchanged by both calls.
3. **Usage errors refuse loudly and write nothing.** A verdict word outside
   `merged|rejected`, a missing or whitespace-only reason, an issue id in no
   `run.json`, and a `--run` naming a run without that issue — each exits non-zero
   and leaves a recursive **path-plus-content-hash** snapshot of the fixture root
   identical (paths alone would miss a truncated `run.json` or a rolled-back stub).
4. **`record` adds one file and edits none.** With a run pre-seeded with `run.json`,
   `report.md`, `run.log` and `tasks/app-001/{status.json,verify.json}`, a successful
   `record` changes zero bytes of any pre-existing file (content-hash comparison); the
   only new path is `tasks/app-001/verdict.json`.
5. **`pending` reports exactly the PR-bearing, unverdicted pairs, newest run first,
   exits 0, and its default root is script-relative.** Against a fixture holding: a
   truthy-prUrl task with no verdict, a `prUrl: null` task, a task with no `prUrl`
   key, an already-verdicted prUrl task in an older run, a `sweeps/`-style directory,
   an empty directory, a malformed `run.json`, and a **regular file** at the fixture
   root — `pending` exits 0, lists the newest run's pending pair before the older
   run's (runId and issueId both on matchable lines), and lists none of the
   null-prUrl, no-prUrl, or verdicted tasks. After `record`, the recorded pair drops
   out and `pending` still exits 0. The same fixture is then reached with
   `VERDICT_RUNS_DIR` **unset**, through a copy of the script placed at
   `<tempRoot>/scripts/verdict.js` beside `<tempRoot>/runs/`, invoked from an
   unrelated working directory — same output, proving the default is resolved from
   the script's location and not the cwd.
6. **The Docker-free suite exists and counts.** `sh scripts/test-verdict.sh` exits 0
   on the finished tree, drives `tests/unit/verdict.test.js` through node, and prints
   at least 15 `ok - ` lines and zero `FAIL` lines — countable by
   `scripts/sweep-assertions.js`, discoverable by the sweep's `scripts/test-*.sh`
   glob.

### What each criterion kills

1. Pick-oldest, runId-sort, mtime-sort, crash-or-win on a `startedAt`-less run, crash
   on missing `tasks/<id>/`, hardcoded `recordedAt`, dropped `prUrl`.
2. A parsed-but-ignored `--run`; an overwrite that appends, refuses, or lands in the
   recency-chosen run; `"prUrl": null` copied into the verdict.
3. Validate-after-write leaving a stub or truncated file behind (content hash, not
   path listing); an open verdict vocabulary; a reason treated as optional.
4. A recorder that "helpfully" annotates `run.json` — the hard-rule-5 violation.
5. A `pending` that always prints nothing; one that counts `null` as PR-bearing; one
   that crashes on `sweeps/`, a malformed `run.json`, or a plain file (ENOTDIR); one
   that exits non-zero on findings (a gate); a default root read from the cwd.
6. A suite the sweep summary renders as `?`; a wrapper shipped without its checker.

### Critic findings and dispositions

`spec-lint`: clean (no criterion names a frozen path). Testability critic
(fresh-context, charter verbatim): verdict `concerns`, five findings, all **accepted**:

1. *C3's before/after check compared path listings, not bytes — a truncation or
   rolled-back stub passes a name listing.* Accepted: C3 now requires a recursive
   path-plus-content-hash snapshot.
2. *Two pinned decisions traced to no criterion: the `startedAt`-less run and the
   null-`prUrl` `record`.* Accepted: C1's fixture gains the undated run; C2 now
   records against a null-prUrl task row and pins that the key is omitted.
3. *The real runs root contains a regular file (`runs/live-*.log`), which no fixture
   exercised — a readdir-without-stat implementation passes every fixture and crashes
   on the real tree.* Accepted: C5's fixture gains a plain file at the root.
4. *The default runs root (env var unset) was never pinned nor exercised — the seam's
   presence stood in for the default's correctness.* Accepted: pinned as
   script-location-relative in Constraints; C5 gains the copied-script,
   unrelated-cwd, env-unset check; the self-contained constraint makes the copy
   legitimate.
5. *C2 didn't say whether the overwriting call repeats `--run`, and the two readings
   freeze different tests.* Accepted: C2 pins that it repeats `--run` and asserts the
   newest run stayed untouched.

One drafter note not adopted as a criterion: the exit code for usage errors stays an
implementation choice (non-zero is frozen; the specific value is not), matching the
"freeze outcomes, not decisions" rule.
