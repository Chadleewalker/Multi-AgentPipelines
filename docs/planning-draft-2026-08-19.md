# Planning draft — 2026-08-19 — the batch marker reader

**Status: DRAFT — awaiting freeze-gate results and user approval. Nothing here is frozen
and nothing runs until the user approves.** Superseded by the Beads issues at freeze
(PLANNING.md step 5); disposable once the tasks have run.

Source of intent: `DESIGN.md` §3.9, declared as change-log row `batch-ready-marker` and
approved 2026-08-19. The thread is
[`docs/threads/batch-ready-marker.md`](threads/batch-ready-marker.md).

Criteria were drafted in fresh context against the code (step 1b) by a reader with no
session history; `scripts/spec-lint.js` is clean; the full panel (testability, scope,
ambiguity) reviewed this draft and returned `concerns` three times. Every finding carries a
disposition below. The panel's load-bearing factual claims were verified against the source
before being accepted — `hostBdSpec` is indeed private, `bd()` does fall through to
`bdInImage`'s `docker run`, `/state` does carry a `now` stamp, and `audit-runs.js` does
bucket unknown directories.

**Batch shape: two tasks, A then B.** The scope critic confirmed the split and proposed no
further cutting. B depends on A. Both fork from today's `main`.

---

## Proposed design amendments to §3.9 (user's call — hard rule 4)

Each changes what the artifact *is*. On approval, §3.9 is amended and change-log row
`batch-ready-marker` gains a dated same-day amendment clause.

**D1. The marker carries a freeze *instant*, not a freeze date.** A `YYYY-MM-DD` cannot be
compared to a run's `startedAt`, which is a UTC instant: a run at `2026-08-19T23:45Z` is
18:45 on the 19th in a US-Eastern session, so a freeze date read as UTC midnight counts a
run that happened *before* the freeze and the batch silently disappears from `pending` —
precisely the failure the tool exists to prevent. **Amendment:** the marker carries
`frozenAt`, an ISO 8601 instant; the filename's date is naming only. An unparseable or
missing `frozenAt` is listed and labelled `freeze-time-unknown`, never dropped or guessed.

**D2. "Pending" means *none* of the batch's ids has been worked.** §3.9 is silent on the
partial case. **Amendment:** a batch leaves `pending` when **any** of its ids has been
worked since `frozenAt`; `show` prints the per-id breakdown so a half-drained batch stays
visible. The question `pending` answers is "did this batch ever get launched", and one id
having run answers it.

**D3. `show` with no argument means the newest marker by `frozenAt`, launched or not.**
"Newest" and "newest pending" diverge the moment a batch is launched, and a default that
skipped a launched batch would hide a double-launch — the thing worth seeing most.

**D4. The reconciliation joins three sources, not two.** `run.json` records `targetRepo` as
a git *remote URL* (`runner/run.js:380`), not the `run.config.<project>.json` a marker
names, so nothing joins a marker to a run without reading that config — which is
git-ignored — for its `targetRepoPath`. `show` therefore reads marker + run config + queue,
and needs a degraded term for "the run config this marker names is not on this host".

*(A fifth amendment was drafted and withdrawn on the scope critic's finding: §3.9 scopes
"built-ins only, spawn nothing" to marker reading and the pending join and puts the `bd`
call behind a seam, so `batch.js` requiring runner code for the reconciliation half needs
no amendment — it was already permitted. What does change is the seam's **name**: §3.9 says
`BATCH_BD_CMD`, and the seam that actually exists and takes absolute precedence throughout
`runner/bd.js` is `PIPELINE_BD_CMD`. Inventing a second one would give the reference host a
suite that passes vacuously. Treated as a correction, not a decision.)*

---

## Why two tasks

The fresh-context read turned one medium task into more than one reviewable PR. The split
follows the `live-dashboard` precedent, where the reader shipped separately from the feeds.

- **Task A — the marker and `pending`.** Pins the marker shape, reads it, computes the
  corpus join. `show` exists and prints the marker, always labelled `unreconciled`. Node
  built-ins only; spawns nothing. Useful the day it lands.
- **Task B — the reconciliation.** Adds the run-config join and the `bd ready` read, making
  `unreconciled` conditional instead of unconditional.

---

## Pinned vocabulary and shapes (both tasks)

Named here once because a criterion asserting "prints the reconciled tokens" is not
writable twice the same way, and because a human hand-writes these files.

**Marker shape** — one JSON object. Required: `runConfig` (string, the
`run.config.<project>.json` filename), `frozenAt` (ISO 8601 instant), `issues` (array of
`{id, title}`). Optional and printed when present: `integrationBranch`, `freezeCommit`,
`intent`, `approvedBy`. Nested objects are permitted — "flat" in §3.9 means one file with
no schema machinery, not one level.

**Reconciled tokens:** `ready`, `not-ready`, `stray` (Task B only).
**Per-id breakdown tokens:** `worked`, `not-worked` (Task A).
**Degraded terms:** `unreconciled` (the umbrella, always printed with one reason beside
it), and the reasons `bd-unavailable`, `bd-unreadable`, `run-config-absent`,
`freeze-time-unknown`, `run-time-unknown`, `no-issues`. `bd-unavailable` means no `bd` could be spawned **at all** — including a seam naming something unexecutable, which is how the frozen test reaches that state deterministically on a host that does have `bd`. `bd-unreadable` means `bd` ran but exited non-zero, printed unparseable output, or was killed at the timeout.

**Exit codes**, on the `verdict.js` precedent (`scripts/verdict.js:76-78`): `0` on success
*and on findings*; `2` usage; `3` a well-formed argument naming no marker.

**`show`'s argument** is the marker's filename stem (`orbit-lab-2026-08-19`) or nothing.
Project-only, date-only and path forms are not accepted — `2` for those, `3` for a
well-formed stem that matches nothing.

**Output is human-readable lines.** No `--json` mode in either task; if one is ever wanted
it is a separate task, so nothing here is frozen against it.

**Ordering:** newest `frozenAt` first; ties broken by filename **ascending**
(`localeCompare`), matching `verdict.js`'s `byRecency`.

**A run's clock:** `startedAt` from `run.json` when present; otherwise the leading instant
on the first line of `run.log`. A run whose instant is unparseable by both routes **counts
as having worked** the ids it names, and `show` labels that evidence `run-time-unknown` —
the conservative direction, because a false "pending" invites a double launch while a false
"launched" leaves the marker on disk and `show` still working.

---

## Task A — the batch marker and `batch.js pending`

**Difficulty label (proposal): medium.** One new `scripts/batch.js` plus one Docker-free
suite, in the `verdict.js` house pattern. The corpus join is the non-mechanical part.

**design-ref:** `DESIGN.md` §3.9; change-log row `batch-ready-marker`.

**Description.** A planning session's last act (PLANNING.md step 8) is to write a batch
marker at `runs/batches/<project>-<YYYY-MM-DD>.json` recording what was just frozen. This
task pins that shape (above) and builds the reader's two subcommands: `show`, which prints
one marker and — in this task, unconditionally — labels it `unreconciled bd-unavailable`;
and `pending`, which lists batches none of whose ids any run has worked since `frozenAt`.

**Constraints.**
- Pure reader: creates no file, edits no artifact, mutates no marker, exits 0 on findings.
- Node built-ins only; **spawns nothing at all**. A copy works from any repo-shaped root,
  on a host where `bd` was never installed — the `verdict.js` rule.
- Reads its runs root from `BATCH_RUNS_DIR` or from its own location, **never**
  `process.cwd()` (`tests/unit/verdict.test.js:352`).
- Nothing in `runner/` or `pipeline/` reads `runs/batches/`.
- Fixtures live under the OS temp dir; every project name in the suite is invented.
- `tests/acceptance/` and `pipeline.config.json`'s frozen path are untouchable.
- The docs phase owns the `PLANNING.md` step 8 line and the `CLAUDE.md` "Running things"
  entry, and must state that reconciliation is not yet wired.

**Acceptance criteria.**

1. **The filename's date is anchored at the end, and a non-marker is skipped, not crashed
   on.** In a `batches/` holding `orbit-lab-2026-08-19.json`, `alpha-2026-08-01.json`,
   `2026-08-19.json`, `notes.txt` and `broken-2026-08-02.json` containing `{ truncated`:
   `pending` exits 0 and lists exactly the two well-formed markers, and
   `show orbit-lab-2026-08-19` reports project `orbit-lab`. Discriminates against splitting
   on the first hyphen (project `orbit`) and against an unanchored `.json` glob (which
   admits `2026-08-19.json` as a third batch).
2. **A run that worked a batch's ids counts even with no manifest, and a manifest-less run
   is dated from `run.log`.** Three markers; run `R1` has a `run.json` whose `tasks[]`
   carries marker A's ids; run `R2` has **no `run.json`** but has `tasks/<id>/status.json`
   for marker B's ids and a `run.log` whose first instant is **after** marker B's
   `frozenAt`; marker C's ids appear in neither. `pending` lists exactly marker C. A second
   fixture, identical except that `R2`'s `run.log` instant is **before** marker B's
   `frozenAt`, lists markers B and C. Discriminates against a manifest-only join copied
   from `verdict.js` (lists B and C in both), against dating a manifest-less run by
   directory name, and against treating an undated run as always-counting.
3. **The instant comparison, the order, and the degraded labels.** One marker with
   `frozenAt: T`; two fixtures, a run at `T − 1ms` and one at `T + 1ms`, each carrying that
   marker's only id: the earlier leaves it pending, the later does not. A marker with no
   parseable `frozenAt` still appears in `pending` carrying `freeze-time-unknown`; a marker
   with an empty `issues` array appears carrying `no-issues`. Four markers with distinct
   instants print newest-first, ties by filename ascending, and two consecutive invocations
   over an unchanged fixture produce **byte-identical stdout**.
4. **`show` with no argument resolves to the newest marker by `frozenAt`, launched or not,
   and prints the per-id breakdown.** Two markers, the newer already worked by a run:
   `show` with no argument names the newer and marks that id worked. An implementation
   defaulting to newest *pending* names the older and fails. `show nosuch-2026-01-01` exits
   **3**; `show --wat` exits **2**; neither prints a reconciled token.
5. **[guard] Pure reader, self-contained, and it invents no run.** (i) A sha1 snapshot of
   the whole `BATCH_RUNS_DIR` is identical before and after `show` and `pending`. (ii) The
   **parsed** require specifiers of `scripts/batch.js` are all node built-ins and do not
   include `child_process` — extracted the way `tests/unit/verdict.test.js:344-350` does it,
   never a substring scan of the source. (iii) Against a fixture root with a populated
   `batches/`, `verdict.js pending` stdout is byte-identical to the same root without it;
   `dashboard.js`'s `/state.projects` is deep-equal after deleting `now`; and
   `audit-runs.js`'s `- real runs:` line and everything from `## Runs` onward are
   unchanged. Its whole Corpus accounting — `total entries`, `other entries` and the
   Other-entries list — is **expected to change** and is excluded: comparing more than
   this fails a correct implementation, which is the broken-gate shape the panel caught
   in the first draft of this very criterion.

---

## Task B — the `bd ready` reconciliation

**Difficulty label (proposal): medium**, contingent on the interface being pinned before
freeze, which it is below. Depends on A.

**design-ref:** `DESIGN.md` §3.9; change-log row `batch-ready-marker`.

**Description.** Make `unreconciled` conditional: resolve the run config the marker names
for its `targetRepoPath`, read the live ready queue, and report how batch and queue differ
— which of the batch's issues are `ready`, which are `not-ready`, and which `stray` issues
the run would also drain. The runner has no picker (§4.12): it drains whatever queue it
finds, so an issue nobody meant to include simply runs.

**Constraints — the interface, pinned.**
- **`batch.js` assembles the `bd` argv itself and spawns it once.** It does **not** call
  `bd()` or `bdJson()`: both fall back to `bdInImage`'s `docker run` when no host `bd`
  resolves (`runner/bd.js:137,157`), which would make a pure reader start a container
  during a launch ritual and would make the Docker-free suite's "no `bd`" fixture
  indistinguishable from "no docker".
- **B's runner-side deliverable is two exports, not new logic:** `hostBdSpec` from
  `runner/bd.js` (the shim probe — npm's `bd` is a `/bin/sh` script plus a `.cmd` that
  `spawnSync` cannot execute directly, `runner/bd.js:14-25`) and `EXCLUDED_TYPES` with
  `typeOf` from `runner/queue.js`. Re-implementing either is forbidden: change-log row
  `sweep-trustworthy` exported `isHolderLive` rather than allow a second copy, "because two
  copies of a liveness rule drift".
- **The seam is `PIPELINE_BD_CMD`**, with absolute precedence over the host probe, matching
  every entry point in `runner/bd.js`. `BATCH_BD_CMD` is not introduced.
- **`-C <targetRepoPath>` is always in the argv `batch.js` builds**, on the seam path as
  well as the host path, so what repo was consulted is observable to the suite.
- Bounded by `spawnOptions(cfg)`'s `bdTimeoutMs` (default 60 s); never unbounded.
- The `bd` call **reads and never writes** (hard rule 1): no `create`, `update`, `close`,
  `note`, `import`, `sync`, `dolt`.
- The run config is resolved from `BATCH_CONFIG_DIR`, defaulting to the repo root and never
  `process.cwd()`, and is read with `JSON.parse` for `targetRepoPath` alone — **not**
  `runner/config.js`'s `loadConfig`, which throws on unrelated missing keys.
- Apply `EXCLUDED_TYPES` before calling anything a `stray`: `bd ready` returns epic parents
  by design and PLANNING.md:301-305 says so.
- Still a pure reader: exits 0 on findings, edits nothing.
- **The docs phase revises what A's docs phase wrote** — the `PLANNING.md` step 8 line and
  the `CLAUDE.md` entry both describe a tool that always prints `unreconciled`.
- Suites covering what B edits are Docker-bearing and cannot run in the container —
  `scripts/test-runner-queue.sh`, `scripts/test-bd-seams.sh`, `scripts/test-bd-shim.sh`
  belong to the post-run sweep, not to this task's own verification.

**Acceptance criteria.**

6. **The queue is read against the marker's own run config, the `epic` filter is applied,
   and the call is read-only and made once.** Two planted run configs naming different
   `targetRepoPath` values; a `PIPELINE_BD_CMD` stub (a `.js` file run through
   `process.execPath`) that answers from the `-C` argument it receives and records argv. For
   a marker naming config X, the stub returns a bare array holding 2 of the marker's 3 ids,
   one entry typed `epic`, and one unrelated `task`: `show` reports exactly **one** `stray`
   (the task, not the epic) and exactly **one** `not-ready`. The same marker under config Y
   gets a different verdict. Discriminates against comparing the raw array (two strays — the
   false alarm PLANNING.md step 8 warns is expected) and against ignoring `targetRepoPath`
   (identical verdicts under X and Y). The argv log holds exactly one line, containing `-C`,
   the expected path, `ready` and `--json`, and none of `update`, `close`, `create`,
   `import`, `sync`, `dolt`.
7. **Where a join cannot be made, the output names which one failed and never speaks the
   reconciled vocabulary.** Four fixtures over one marker: (a) no `bd` resolvable and no
   seam set, (b) a stub exiting non-zero, (c) a stub printing unparseable text, (d) the
   marker naming a run config absent from `BATCH_CONFIG_DIR`. Each exits 0, prints every
   marker issue id, prints `unreconciled` with its own reason
   (`bd-unavailable` / `bd-unreadable` / `bd-unreadable` / `run-config-absent`), and prints
   none of `ready`, `not-ready`, `stray`. Fixture (a) additionally spawns **no** `docker`.
   The same marker with a working stub and a planted config prints the reconciled tokens and
   no degraded term. Both halves are load-bearing: checking only (a)–(d) passes a tool that
   always says unreconciled.
8. **The call is bounded, and A's contract still holds.** A stub that never exits, with
   `bdTimeoutMs` lowered through the planted run config: `show` exits 0 within the bound and
   prints `unreconciled bd-unreadable` rather than hanging. And A's criteria 1–4 are
   re-asserted verbatim against the post-B tree — the same fixtures, the same expected
   marker lists and ordering — rather than compared against uncaptured bytes from A.

---

## Critic dispositions

**Testability** (`concerns`, 8 findings) — 8 accepted, 0 rejected.
1. A5(iii) would fail a correct implementation (`/state` stamps `now`; `audit-runs` counts
   unknown directories) — **accepted**, criterion 5(iii) rewritten to compare `/state`
   minus `now`, `audit-runs`' run tables only, and `verdict.js` bytes.
2. B8 compared against bytes no frozen test can hold — **accepted**, rewritten to re-assert
   A's criteria explicitly against the post-B tree.
3. B6/B7 could not prove the queue was read against the marker's config — **accepted**,
   criterion 6 now plants two configs and a `-C`-answering stub.
4. `BATCH_BD_CMD` unreachable; `bd()` falls back to `docker run` — **accepted**, the whole
   interface pinned in B's constraints; seam is `PIPELINE_BD_CMD`; fixture (a) asserts no
   docker is spawned.
5. Manifest-less run dating untested — **accepted**, criterion 2 now carries the
   before/after `run.log` pair and the clock is pinned.
6. No seam for the run-config lookup — **accepted**, `BATCH_CONFIG_DIR` added.
7. `child_process` substring scan would fail a documented file — **accepted**, pinned to
   parsed require specifiers.
8. The 60 s bound untested — **accepted**, criterion 8.

**Ambiguity** (`concerns`, 10 findings) — 10 accepted, 0 rejected. Marker key names, the
degraded and reconciled vocabulary, the `bd` entry point and Docker fallback, the
run-config lookup and its reader, the manifest-less clock, the `/state` subset, whether
`runner/queue.js` may be required, `show`'s argument grammar and exit codes, flat-vs-nested
and the id-less marker, and the tie-break direction and output shape — **all pinned** in
*Pinned vocabulary and shapes* and in B's constraints.

**Scope** (`concerns`, 7 findings) — 6 accepted, 1 partially rejected.
1. No further split proposed; A/B confirmed — **noted**, no change.
2. A5(iii) would silently double A's blast radius into `audit-runs.js` — **accepted**, the
   criterion is narrowed instead; A does **not** edit `audit-runs.js`. Its `other entries`
   count will include `batches/`, which is cosmetic and honest; filed to `docs/IDEAS.md`
   rather than absorbed here.
3. `hostBdSpec` / `EXCLUDED_TYPES` unexported — **accepted**, declared as B's runner-side
   deliverable; call `bdOnHost`-style host resolution, never `bd()`.
4. Seam collision — **accepted**, `PIPELINE_BD_CMD` only.
5. D4's second half is not an amendment §3.9 needs — **accepted**, withdrawn; only the
   seam **name** correction survives, which shrinks the user's approval surface to four.
6. Docs ownership never revisited for B — **accepted**, B's docs phase revises A's lines.
7. B's label contingent, and the Docker-bearing suites belong to the sweep — **accepted**,
   both stated in B's constraints.

## Freeze gate

*(pending — step 4; must be red, exit 0, against the `_control` fixture.)*

---

## Appendix — what the code actually does

Findings from the fresh-context read that a drafter working from memory would have got
wrong, kept because they are why the criteria are shaped as they are.

- **A run's manifest is not the only evidence a task ran.** `runner/run.js:376` writes
  `run.json` only after the queue drains; every earlier exit path leaves `run.log` and
  `tasks/<issueId>/` with no manifest. **74 of 272 run directories in the live tree have no
  `run.json`**, and 4 of those have populated `tasks/`. `scripts/verdict.js:136-141` skips
  them by design; `scripts/dashboard.js:299` sets the wider precedent — a directory counts
  if it has `run.log` **or** `run.json`.
- **The per-task issue-id field is `issueId`**, a flat string on `manifest.tasks[]`
  (`runner/run.js:262`, `schemas/run.schema.json:30`), and the manifest sets
  `additionalProperties: false`.
- **`run.json` records no project or config name** — only `targetRepo`, a git remote URL
  (`runner/run.js:380`). This is amendment D4.
- **`startedAt` is a date-time string and the only reliable manifest clock**
  (`verdict.js:36-40`, `audit-runs.js:159-163`): never order by runId (three naming shapes
  interleave wrongly) and never by mtime.
- **`bd ready` legitimately returns epics and the runner drops them**
  (`runner/queue.js:36,55`; PLANNING.md:301-305).
- **`bd ready --json` returns a bare array** of `{id, priority, issue_type, created_at}`
  (`runner/queue.js:52-63`) — not an object with an `issues` key.
- **Spawning `bd` directly does not work on the reference host** (`runner/bd.js:14-25`):
  npm's `bd` is a `/bin/sh` shim plus a `.cmd`; `spawnSync` returns ENOENT and EINVAL.
- **`bd()` and `bdJson()` fall back to `bdInImage`'s `docker run`** (`runner/bd.js:137`,
  `:157-174`) — which is why B assembles its own argv.
- **The seam stub must be a `.js` file preloaded through `process.execPath`**
  (`tests/unit/memory.test.js:15-24`, `:71-78`), with the path forward-slashed in
  `NODE_OPTIONS` and `env: process.env` passed explicitly (`runner/bd.js:128-133`).
- **`runs/` and `run.config.*.json` are git-ignored wholesale** (`.gitignore:2`, `:11`), so
  every fixture is built under the OS temp dir and every project name is invented.
- **`pipeline.config.json` freezes exactly one path beyond `tests/acceptance/`**, under
  neither `scripts/` nor `tests/unit/`.

**One risk deliberately not resolved here:** two batches for one project on one day collide
on the filename, and the failure would be a silent overwrite of an immutable artifact. The
reader treats every file independently and is unaffected; refusing the overwrite belongs to
the writer, which does not exist yet.

---

## Re-freeze — 2026-08-20 (Task B only)

`repo-8v0` ran and came back **stuck** at three attempts with no PR. The cause was a defect
in the frozen test, not in the work: `runShow` sets `NODE_OPTIONS=--require <stub>` to fake
`bd`, but `NODE_OPTIONS` reaches **every** node process — including the
`node scripts/batch.js` child the suite spawns. Each stub therefore preloaded into the
reader itself and its `process.exit()` killed it before its first line, so the suite was
measuring the stub. **11 of 29 checks were unreachable by any implementation.**

The tell is the part worth keeping: `C6 bd is consulted exactly once` **passed only while
`batch.js` was dead** — a live run logs two argv lines, the reader's own preload and the
child's. A check that passes *because* the thing under test is broken is the worst kind of
green, and it was in a criterion the panel had already made me rewrite once for being a
broken gate.

**How it surfaced.** The task agent used §3.3's concern channel — four concerns, with a
diagnosis, a one-line repair, and a proof obtained by patching a copy under `/tmp` and
getting all 29 green against its own unchanged implementation. It never touched the frozen
file. This is the channel working exactly as designed: the agent could not change the spec,
so it did the best work the spec allowed and filed the evidence.

**The repair**, in `writeStub` and nowhere else: a stand-aside guard as the stub's first
statement, above the argv log — below it, the reader's own preload writes a line and
"consulted exactly once" fails for the wrong reason. The guard keys on the reader's own
script path rather than on any flag, so it makes no demand on the argv an implementation
chooses to send its `bd` child.

**Verified both ways, which the first freeze could not claim.** Against the fork point the
suite is RED with a green control; against the complete `task/repo-8v0` change — its
`scripts/batch.js` *and* its `runner/queue.js` / `runner/bd.js` exports, which have to be
taken together — all 29 pass. Red without the work, green with it.

**No criterion changed.** The "Done means" list is untouched; only the harness that was
preventing it being met. A second host fact the agent surfaced and the implementation had
already handled: node owns `-C` as the short form of `--conditions`, so a bare `-C <path>`
at the head of a seam argv is eaten before any stub sees it — which is why the seam fills a
program slot first.
