# Planning draft — 2026-08-04

Two tasks this session, both promoted from `docs/IDEAS.md` via DESIGN.md §5: the review
verdict recorder (change-log row `review-verdict`, frozen as `repo-1ie`) and the
run-history audit (change-log row `run-audit`, below). This draft is superseded by the
Beads issues at freeze and is disposable after the runs (PLANNING.md step 5).

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

---

## Task: the run-history audit — read the corpus, print one report, change nothing

**Label:** medium
**Issue:** `repo-73k` — frozen 2026-08-04; tests at `tests/acceptance/repo-73k/`
(freeze gate RED against a green control, zero guards)
**design-ref:** DESIGN.md §5 (change-log row `run-audit`)

### Description

A deterministic, host-only reader of the pipeline's run corpus. `node
scripts/audit-runs.js` walks the runs root, joins the structured artifacts (`run.json`,
per-task `status.json`, `verify.json`, `verdict.json`), and prints one markdown report to
stdout: corpus summary (with preflight-failure dirs bucketed and their reasons grouped),
outcomes and models per target, repeated issueIds across runs, partial forensics (which
sibling frozen suites failed, same-run or not), channel usage (spec concerns, memory
notes, verdict coverage and the done-but-rejected join), and nearest-rank distributions
for `activeSeconds` and `diffLines`. A pure reader: it writes nothing, gates nothing, and
holds no LLM. Ships with a Docker-free suite (`scripts/test-audit-runs.sh` over
`tests/unit/audit-runs.test.js`) so the sweep covers it forever.

### Constraints

- No LLM anywhere (§5's recorded decision — a measurement that cannot hallucinate is the
  point). Never a gate (hard rule 5's shape): exit 0 on any readable tree whatever it
  finds; non-zero only for a usage error (the script takes no arguments — any argument is
  one), which prints a usage line and no report.
- **A pure reader.** It creates, modifies and deletes nothing, anywhere — no cache, no
  index, no report file. Stdout only; the human redirects if they want a file kept, and
  anything kept lands under the git-ignored `runs/` because the report names targets, PR
  URLs and issue titles. Nothing tracked ever carries report content; all test fixtures
  are generic.
- No Beads access of any kind — works on a host with no `bd` installed.
- `scripts/audit-runs.js` is **self-contained**: node built-ins only, no requires of
  other repo files (the tests rely on this to prove default-path resolution through a
  copied script).
- Test seam: `AUDIT_RUNS_DIR` re-aims the runs root (the `VERDICT_RUNS_DIR` pattern,
  pinned identically so the two tools cannot drift). Default when unset: resolved from
  the script's own location (`<script dir>/../runs`), never the cwd. A missing runs root
  is an empty corpus: full report with zeroed sections, exit 0.
- Any suite stub is a `.js` file via `process.execPath`, never `#!/bin/sh` (defect 9).
  Timestamps in fixtures are computed, never hardcoded.
- Purely additive: no changes under `runner/`, `pipeline/`, `schemas/`, or
  `scripts/test-all.sh`. Docs updates ride along per the docs phase's normal rules.
- **Pinned decisions** (from the fresh-context read of the real `runs/` tree):
  - **Three top-level buckets, and every readdir entry lands in exactly one.** (1) real
    runs: directories whose `run.json` parses to an object; (2) preflight-failure dirs:
    no `run.json` but a readable `run.log`; (3) other entries: plain files, directories
    with neither artifact, and directories whose `run.json` exists but does not parse —
    each listed by name with its kind (`file`, `no-artifacts`, `unreadable-manifest`).
    All three counts plus the raw total appear in the summary and must reconcile (the
    real tree holds every one of these shapes).
  - **Preflight reason** = the last line of `run.log` carrying the ` ERROR ` level
    token, with the timestamp and `[<runId>/<phase>]` tag stripped; group by the exact
    remainder. It is not always a `PREFLIGHT FAILED` line — group whatever it says. A
    `run.log` with no ERROR line at all is its own pinned group,
    `(no ERROR line in run.log)` — 28 of the 60 real preflight dirs are this shape.
    Reason groups sort by count descending, then reason ascending.
  - **Split every parsed text on `/\r?\n/`** and strip a trailing `\r` before comparing
    (the promoted line-endings convention: guard at the point of parsing).
  - **Runs order by `run.json`'s `startedAt`, ascending, everywhere a sequence
    appears** — never runId sort (three naming shapes interleave wrongly), never mtime.
    A parseable `run.json` without a parseable `startedAt` sorts oldest (the `repo-1ie`
    pin, reused).
  - **The `run.json` task row is the join spine; per-task files refine it.** Targets
    key by the exact `targetRepo` string (missing → `(no targetRepo)`), sections sort
    by key ascending. The outcome vocabulary is open — count whatever string appears.
    `model` missing or empty counts under `(none recorded)`. `pauses` missing is 0.
    PR-bearing means a truthy non-empty `prUrl` string — `null` is a real value and is
    not PR-bearing (the `repo-1ie` pin, reused).
  - **Repeats:** an issueId in more than one real run; rows sort by issueId ascending;
    each sequence is `runId:outcome:exitCode` in `startedAt` order.
  - **Partial forensics reads `verify.json`, never the task row's embedded
    `verification`** (the embedded copy lacks `regressionOutput`). Sibling line shape,
    verbatim: `regressions: frozen acceptance tests in tests/acceptance/<id>/ FAIL`.
    Each sibling tags **same-run** or **other-run** by whether its id is a task row in
    the same `run.json`. A partial with no `verify.json`, or no `regressionOutput` key
    (38 real files), renders `(no regression output recorded)` — reported, never
    skipped, never a crash.
  - **Channels read per-task `status.json`**: the keys are `specConcerns` and
    `memoryNotes` — the first draft of the corpus pass misread `concerns` and reported
    a 43-use channel as never used, which is why the fixture's expected totals must
    differ from what that misread would produce. A missing or unparseable
    `status.json` contributes zero. A corpus-wide concern total of 0 prints the
    pinned flag line `(zero spec concerns recorded anywhere in this corpus)`, not
    just the number. Verdict coverage counts PR-bearing tasks
    with vs without a parseable `verdict.json` (unparseable counts as absent); the
    blind-spot list is row outcome `done` joined to verdict `rejected`. Zero verdicts
    exist in the real tree today, so the zero-coverage render is the launch path.
  - **Distributions are nearest-rank quantiles** (sort ascending, element `ceil(p·n)`,
    1-indexed): always an actual sample, never an interpolation — that is what makes
    the output byte-stable. Done tasks only. A done row missing the metric is excluded
    and the exclusion count printed. An empty sample set renders `(no data)`, never
    `NaN`.
  - **Output is deterministic to the byte**: fixed section order, all row orders pinned
    above, no wall-clock timestamp anywhere — two invocations on one tree produce
    identical bytes.

### Done means

1. **The corpus summary counts every root entry into exactly one bucket and groups
   preflight reasons from real ERROR-line shapes.** Against a fixture root holding:
   three parseable runs (one per runId naming shape — ISO-timestamp, `e2e-…-bail`,
   `shadow-01-…`), two preflight dirs whose `run.log`s end in the same
   `… ERROR [x-1/preflight] PREFLIGHT FAILED — no tasks launched: image 'ghost:v0' not
   found` line — one LF, one CRLF — one preflight dir whose last ERROR differs, one
   whose `run.log` has no ERROR line, an empty directory, a directory holding only
   subdirectories (the `sweeps/` shape), a directory with an unparseable `run.json`,
   and a **regular file** at the root — exit 0, and the report states: total entries
   11, real runs 3, preflight dirs 4, other entries 4 each named with its kind; the
   identical-reason pair groups as one reason with count 2 (CRLF and LF parse to the
   same string), the odd reason counts 1, `(no ERROR line in run.log)` counts 1.
2. **Outcomes, models and repeats join across runs by `startedAt`, never by name.**
   The three runs carry two distinct `targetRepo` strings; task rows cover outcomes
   `done`, `partial`, `stuck` and `tampered`, exit codes 0, 10, 11 and 137, one row
   with `model` absent, two rows with `pauses: 2` and `pauses: 3`, done rows carrying
   `attempts` 1, 1 and 2, and one issueId `app-001` in all three runs — with
   `startedAt` order contradicting both lexicographic runId order and directory
   mtime, and one run's `run.json` parseable but `startedAt`-less. The report shows
   per-target outcome counts, the done-task attempts distribution reading exactly
   two 1-attempt tasks and one 2-attempt task, a pause total of exactly **5** (the
   sum — a row-count would print 2, nonzero-but-wrong), a model distribution with
   `(none recorded)` = 1, and a repeats section listing `app-001`'s three
   `runId:outcome:exitCode` entries in `startedAt` order, the undated run first.
3. **Partial forensics and channels read the per-task files, and every absence is a
   rendered fact.** Fixture partials: one whose `verify.json` blames
   `tests/acceptance/app-002/ FAIL` where `app-002` is a task row in the *same* run
   (tagged same-run), one blaming an id that ran in a *different* run (tagged
   other-run), one whose `verify.json` lacks `regressionOutput` — rendered
   `(no regression output recorded)`. Channels: one task's `status.json` carries 2
   `specConcerns` and 3 `memoryNotes`, another task has no `status.json`; two
   PR-bearing tasks carry a `verdict.json` (one `merged`, one `rejected` on a row
   whose outcome is `done`), one PR-bearing task has none, and a `prUrl: null` task
   with a verdict-shaped file lands in no coverage bucket. The report totals concerns
   and notes, shows coverage 2-with/1-without, and lists exactly the done-but-rejected
   task on the blind-spot line. A second fixture with zero concerns everywhere prints
   exactly the pinned flag line `(zero spec concerns recorded anywhere in this
   corpus)`.
4. **Distributions are nearest-rank, exclusions are counted, and the report is
   byte-deterministic.** Done tasks carry `activeSeconds` whose **p95 is the sole
   discriminator** between nearest-rank and linear interpolation (5 samples
   `[10, 20, 40, 80, 1000]` → nearest-rank p95 = 1000 where interpolation gives
   ~816; p25 = 20 and median = 40 agree under both and pin the rank arithmetic
   only); one done row lacks `activeSeconds` — the stats
   match the nearest-rank answers exactly, the exclusion count of 1 is printed, and
   `diffLines` gets its own line. Two invocations over the same fixture yield
   byte-identical stdout, and no report line parses as a current timestamp.
5. **A pure reader with a script-relative default root, never a gate.** The full run
   is invoked from a **dedicated empty temp working directory**, and a recursive
   **path-plus-content-hash** snapshot of the fixture tree (runs root, the script's
   directory, *and* that cwd — the cwd is where a "helpful" cache lands) before and
   after is identical, with the cwd still empty — nothing created, modified or
   deleted. `AUDIT_RUNS_DIR` at a nonexistent path exits 0 with the
   empty-corpus report; the C1 broken-manifest fixture also exits 0. An unrecognised
   argument exits non-zero and prints no report. The same fixture is then reached with
   `AUDIT_RUNS_DIR` **unset**, through a copy of the script at
   `<tempRoot>/scripts/audit-runs.js` beside `<tempRoot>/runs/`, invoked from an
   unrelated working directory — same report, proving the default resolves from the
   script's location, not the cwd (legitimate because the script is self-contained).
6. **The Docker-free suite exists and counts.** `sh scripts/test-audit-runs.sh` exits
   0 on the finished tree, drives `tests/unit/audit-runs.test.js` through node, and
   prints at least 20 `ok - ` lines and zero `FAIL` lines — counted by the frozen
   test itself (the `ok - ` shape is what `scripts/sweep-assertions.js` counts, but
   the frozen test never executes that mutable script), with the wrapper's filename
   matching the sweep's `scripts/test-*.sh` glob.

### What each criterion kills

1. A readdir-without-stat that crashes on the plain file (ENOTDIR); a counter that
   silently drops empty or `sweeps/`-shaped dirs so the buckets stop reconciling; a
   reason extractor that pattern-matches only `PREFLIGHT FAILED` and crashes or
   mislabels the other real shapes; a CRLF log whose reason keeps a trailing `\r` and
   refuses to group with its LF twin; an unparseable `run.json` treated as a real run
   (crash downstream) or made invisible.
2. A join keyed or ordered by runId sort or mtime; crash-or-win on the
   `startedAt`-less run; a closed outcome/exit-code enum dropping 11 or 137; a model
   column conflating "missing" with a model name; a pause column vacuously zero
   forever (the whole real corpus has zero pauses — only a fixture proves the sum is
   wired).
3. Reading the embedded `verification` instead of `verify.json` (forensics silently
   empty forever); a crash on the absent-`regressionOutput` shape; a same-run tag
   computed from nothing; `null` prUrl counted as PR-bearing; the `concerns` key
   misspelling reporting zero forever — the fixture's expected totals differ from
   what the misread would produce, so it cannot pass; a coverage section that hides
   the done-but-rejected join.
4. Linear-interpolation quantiles (float noise breaks byte-determinism); a missing
   metric entering as `NaN` and poisoning every stat; an excluded row vanishing
   without a count; a generated-at timestamp making every report diff dirty.
5. An auditor that "helpfully" writes a cache, an index, or the report to disk (the
   pure-reader contract, checked by bytes); a gate exiting non-zero on a broken
   corpus; a default root read from the cwd — green in every env-var test, wrong on
   the first real host invocation; a flag handler that swallows typos and audits the
   wrong tree silently.
6. A suite the sweep summary renders as `?`; a wrapper shipped without its checker; a
   `#!/bin/sh` stub that passes in a container and EFTYPEs on the Windows host
   (defect 9).

### Critic findings and dispositions

`spec-lint`: clean (no criterion names a frozen path). Testability critic
(fresh-context, charter verbatim): verdict `concerns`, seven findings, all **accepted**:

1. *C1's pinned counts contradicted its own fixture enumeration — 3 + 4 + 4 entries
   described, "total 10, other 3" asserted; the frozen test would be impossible or
   would drop a discriminating entry.* Accepted: re-pinned to 11 total, 4 other.
2. *C2's "attempts distribution" traced to no fixture values and no expected render —
   presence standing in for correctness.* Accepted: done rows now carry attempts
   1, 1, 2 and the expected distribution is pinned exactly.
3. *C5's snapshot scoped the runs root and script dir, but a "helpful" cache most
   plausibly lands in the cwd, which was outside the snapshot.* Accepted: the run now
   starts from a dedicated empty temp cwd that is inside the snapshot and asserted
   still empty.
4. *C2's "nonzero pause total" passed a count-of-rows implementation as well as a
   sum.* Accepted: two pause-bearing rows (2 and 3), total pinned as exactly 5.
5. *C3's zero-usage flag line pinned no text, unlike every sibling absence shape.*
   Accepted: pinned as `(zero spec concerns recorded anywhere in this corpus)`.
6. *C4's rationale claimed p25 discriminates nearest-rank from interpolation; for the
   common type-7 method it does not — only p95 does, and a wrong rationale invites a
   later weakening.* Accepted: restated with p95 as the sole discriminator.
7. *C6's "countable by `scripts/sweep-assertions.js`" invited a frozen test that
   executes mutable repo code.* Accepted: the frozen test counts `ok - ` lines
   itself; the sweep-assertions mention is rationale only.
