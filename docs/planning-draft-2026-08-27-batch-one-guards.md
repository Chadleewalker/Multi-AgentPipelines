# Planning draft — batch one: guards that fire at the start, and the ledger's writer

**Status:** planning session in progress. Step 1a (intent) written here; step 1b (the
"Done means" lists) drafted in fresh context against the code; step 2 (lint + critics)
recorded below with a disposition per finding. **Step 5 — Chad's approval of each "Done
means" list — has not happened yet.**
**Date:** 2026-08-27.
**Design source:** `planning-draft-2026-08-27-guards-and-ledger.md` (approved as a
direction, Option A). Decision already taken by Chad: **a suite proven red but never proven
green does not dispatch** — the opt-out knob is built, and off by default.

---

## The tasks, in dependency order

**As drafted (step 1a), five tasks.** The critic panel split two of them; the batch as it
stands for approval is **seven tasks over three runs**, and the authoritative list is the
run plan in step 5. The intent sections below are the step-1a text the drafters and critics
worked from; where step 5 differs (the hash is over git blob ids, not bytes; the wholly-refused
exit is 4, not 2; task 1 is 1a + 1b; task 3 is 3a + 3b), **step 5 wins**.

| # | Slug | Label | Depends on | One line |
|---|---|---|---|---|
| 1 | receipt → 1a receipt-writer, 1b receipt-enforce | medium, hard | —, 1a | The freeze gate leaves a receipt inside the frozen suite; the dispatch gate refuses a suite without a matching one |
| 2 | guard-red | medium | — | A `[guard]` test that is red at the fork point is a stale pin, and the gate says so |
| 3 | events-ledger → 3a ledger-writer, 3b ledger-facts | hard, hard | —, 3a | Every line the runner logs is also a structured event in `runs/<runId>/events.jsonl`, from the same writer |
| 4 | refused-exit | medium | 1b | A run that refuses its whole non-empty queue exits 4, and the summary line leads with the count that matters |
| 5 | failure-class | medium | 1b, 3b | Every non-`done` task carries a deterministic failure class in the manifest and the report |

Nothing here touches `pipeline/verify.js`, the verifier's judgement, or anything a task
container can reach — the verifier is read-only scaffolding and stays so (hard rule 2).

---

## Task 1 — receipt

**Description.** `scripts/freeze-gate.js` writes a receipt when it reaches a verdict that
proceeds — `red` (exit 0) or `half-proven` (exit 4) — at
`tests/acceptance/<issue-id>/.freeze-gate.json`. The receipt records the gate version, the
verdict, whether a probe was supplied, a content hash of the suite (every file under the
suite directory except the receipt itself, hashed as bytes), the fork commit the gate ran
against, the guard count, the brittleness-lint count, and a timestamp. Because the receipt
lives **inside** `tests/acceptance/`, the verifier already diffs it against the fork point:
editing it in a container is `tampered`, with no new rule.

`runner/queue.js`'s dispatch gate then reads the integration branch — through the same
throwaway fetch it already does — and refuses, with a distinct reason each, a candidate whose
suite is absent (as today), whose suite has **no receipt**, whose receipt's content hash
**does not match** the suite as it is on the branch, or whose receipt says **`half-proven`**
while the run config's `allowHalfProven` is not `true`. A refusal is never a Beads write; the
issue stays `open` with the remedy named, as the existing refusal does.

**Constraints.**
- The receipt is written only by the gate, only on a proceeding verdict, and only into the
  `--tests` directory. `indeterminate`, `green` and `unreachable` write nothing and leave any
  existing receipt untouched — a stale receipt is then caught by the hash, never by a
  deletion the gate has to get right.
- The content hash is over **bytes**, with no line-ending normalisation, because §4.4 treats
  any byte difference in a frozen path as tampering and a hash that forgave what the
  verifier does not would disagree with it. Workspaces already clone with `core.autocrlf=false`.
- The dispatch side computes the hash from the fetched branch's tree, not from the working
  copy, and every git call it adds goes through the existing bounded `git()` helper
  (`gitTimeoutMs`) — a hang here parks the run before it starts.
- The receipt file name starts with a dot and ends in `.json` so no project's test runner
  picks it up as a test. This repo's `tools/run-acceptance.sh` runs `*.sh` and `*.js` only.
- `allowHalfProven` is validated like every other knob in `runner/config.js`, defaults to
  `false`, and its effective value is written into the manifest so a later reader can tell a
  run that dispatched a half-proven suite by choice from one that could not.
- The report's `undispatchable` label stops being a single fixed sentence: the row carries
  the refusal's reason, and the label renders it. The label map in `runner/report.js` and
  the dashboard's summary-line parse are downstream and are named in the "Done means" list.
- `PLANNING.md` step 6 and `ONBOARDING.md` say the receipt is committed with the suite.
- **design-ref:** DESIGN.md §3.2 (the gate's table — receipt row) and §4.12 (the ready
  queue's admission rules — the third rule).

**Why hard.** A small code delta that changes what a batch does at all, in both silent
directions: refuse everything on a hash that disagrees with itself across platforms, or
admit everything on a receipt check that vacuously passes.

## Task 2 — guard-red

**Description.** A frozen test whose job is "existing behaviour X still holds" — a guard —
is by definition green before any work is done. Four of the twelve broken-suite tasks in the
corpus were guards that were **red at the fork point**: they pinned numbers, keys or files
that had already moved, so they could only ever fail. The gate today counts `[guard]` labels
in the spec and has no opinion about the tests. It gains one: a test file that declares
itself a guard is run alone against the fork point and must be **green** there; a red guard
is a new verdict, `stale-guard`, exit 5, never a pass, and the gate names the file.

**Constraints.**
- A guard test declares itself with the literal token `[guard]` in a comment within its
  first ten lines — the same word the spec uses — so the gate reads the suite's own text and
  needs no mapping file. A suite with no such file behaves exactly as today.
- The guard subset is run through the project's own `verifyCommand` against a directory
  holding only the guard files, so a guard that depends on a sibling test file is reported
  as `indeterminate` with the reason, not blessed.
- Exit codes 0–4 keep their exact meanings; 5 is new. The pure `verdictFor` table gains the
  row and its unit coverage.
- **design-ref:** DESIGN.md §3.2 (the gate's table — the stale-guard row).

## Task 3 — events-ledger

**Description.** `runner/log.js` gains a structured channel: alongside every `run.log`
line the same writer appends one JSON object to `runs/<runId>/events.jsonl`. Every event
carries `ts`, `level`, `runId`, `issueId` (or null) and `event`; named events carry their
own fields. The events are the facts the readers already extract from `run.log` by regular
expression today — the `P` prefix table in `scripts/dashboard.js` is the list — plus the
ones no reader can currently get at: the queue read with every refusal and its reason,
each attempt's verifier result and failing check names, and each spec concern as it is
collected. A `schemas/events.schema.json` describes the line shape and the named events.
**No reader changes in this task**; the writer lands first, so the ledger exists for every
run from the day it merges.

**Constraints.**
- One writer. Both files are appended by the same function in `runner/log.js`; nothing
  else in the runner opens `events.jsonl`. A prose line and an event cannot disagree because
  the event is the argument and the prose is rendered from it — or, where that inversion
  is too large for one task, the two are written in one call with one timestamp.
- Append-only, one object per line, no rewriting. A crashed run leaves a valid prefix.
- Failing check names come from the verifier's captured output using the same line shapes
  the sweep already counts (`ok - ` / `not ok` / `PASS ` / `FAIL`) — `scripts/sweep-assertions.js`
  is the decision and is reused, never copied.
- `run.log` is unchanged, byte for byte, for every existing line: the dashboard, the batch
  reader and the audit tool keep passing their suites without edits.
- Nothing in a task container writes an event. Host-only, like every artifact under `runs/`.
- **design-ref:** DESIGN.md §4.12 (run artifacts) and §5 (what the readers read).

**Why hard.** It touches every log call site in the runner, and the failure that matters is
silent: an event that is well-formed and wrong, or a prose line that quietly changed and
took three readers down with it.

## Task 4 — refused-exit

**Description.** A run whose ready queue was non-empty and which dispatched nothing exits
**2**. A genuinely empty queue stays exit 0 — that is a legitimate no-op. The queue-summary
line leads with the number that matters:
`ready queue: 0 of 8 dispatchable — 8 refused: 5 no frozen suite, 3 unproven; <ids by reason>`.
Under the live feed, the decision is made when the run ends, from what was actually
dispatched, so a refusal that cleared mid-run counts as dispatched.

**Constraints.**
- The exit code is decided from the drain's result and the source's refusals, never from
  log text, and it is recorded in the manifest (`queue: {ready, dispatched, refused}`) so a
  reader can tell the two exit-0 cases apart from the two exit-2 cases without the log.
- The historic `ready queue:` prefix is grepped by `scripts/test-runner-queue.sh` at six
  sites and by `tests/unit/dispatch-gate.test.js`; those move with the wording in the same
  task, and their check counts go up, not down.
- Refusal kinds are task 1's; this task renders them and adds none.
- **design-ref:** DESIGN.md §4.12 (the run's exit codes and the queue-summary line).

## Task 5 — failure-class

**Description.** Every manifest row whose outcome is not `done` carries a `failureClass`,
decided from artifacts already in hand and never from prose: the refusal reason
(`no-suite`, `unproven-suite`, `suite-changed`, `half-proven`), the verifier's result
(`suite-error` when the verifier itself could not run the suite — a killed or errored run
in `verify-classify.js`'s vocabulary — and `regressions` for `partial`), the attempt history
(`identical-failures` when the last two attempts' failing check sets are equal;
`attempts-exhausted` otherwise), and the outcome word for the rest (`timeout`, `internal`,
`tampered`, `paused`). The report renders the class beside the outcome label. `audit-runs.js`
is untouched here; its tables are batch two.

**Constraints.**
- The enum lives in `schemas/run.schema.json`; the manifest validates against it.
- `identical-failures` is computed from the verifier's captured output per attempt using
  the same line shapes as task 3 — and it is **recorded only**: it changes no outcome and
  stops no attempt (hard rule 5; the early-stop option is parked in the design draft).
- A row the class cannot be decided for carries `unclassified`, never a guess and never a
  missing field.
- **design-ref:** DESIGN.md §4.11 (the outcome table — the class column).

---

## Step 1b — "Done means" lists (fresh context, against the code)

Each list below is the drafter's return, verbatim apart from formatting. Revisions after the
panel are marked **[revised]** in step 5.

### Task 1 — receipt (drafter's return)

1. **The gate writes a receipt on a proceeding verdict and only then.** After the gate exits 0 (`red`) or 4 (`half-proven`), `tests/acceptance/<id>/.freeze-gate.json` exists and parses to an object with exactly these keys: `gateVersion` (integer `1`), `verdict` (`"red"` or `"half-proven"`, equal to the printed verdict), `probeSupplied` (boolean, true iff `--green` was given), `suiteHash` (64 lowercase hex), `forkCommit` (40-hex `git rev-parse HEAD` of `--repo`, or `null` when not a git repo), `guards` (integer when `--spec` given, else `null`), `brittleness` (integer count the lint printed, or `null` when it said `unavailable`), `writtenAt` (ISO-8601). Exits 1, 2 and 3 write nothing and leave a pre-existing receipt byte-identical.
   - verify: on the `tests/unit/freeze-gate.test.js` pattern — temp tree, `FREEZE_GATE_CMD` pointing at a `.js` stub run through `process.execPath`, a probe tree marked `.is-probe`. Run `main()` five times: honest with probe (0), honest without (4), always-green (1), always-red (2), probe-red (3). After the first two, read the receipt: key set is exactly the eight above, `verdict`/`probeSupplied` match the run, `guards` equals the `[guard]` count in the `--spec` fixture (2) and is `null` without `--spec`, `forkCommit` equals `git rev-parse HEAD` of a one-commit fixture repo. Before each failing run overwrite the receipt with a sentinel; after each, the bytes are still the sentinel and the exit code is unchanged.
2. **The suite hash is over what git stores, excludes the receipt, and is reproduced independently.** `suiteHash` = sha256 over the concatenation of `<relative-path>\0<git-blob-id>\n` for every file under the suite directory except `.freeze-gate.json`, relative paths with `/` separators sorted bytewise, blob id as `git hash-object --path <rel> <file>` reports (after git's clean filter). Re-running the gate changes only `writtenAt`; editing one byte of one test file changes the hash; `compareSuites` no longer reports the receipt as `absent` in a probe that lacks it.
   - verify: (a) recompute the hash in the test from the fixture's files and assert equality; (b) run the gate twice, hashes equal (the first receipt is present during the second — proves exclusion); (c) append one byte to `test.js`, hash changes; (d) **the discriminating CRLF pair**: a fixture repo with `core.autocrlf=true` and a test file written `\r\n`, committed — the receipt's hash equals the hash from `git ls-tree -r HEAD` blob ids (raw-byte hashing differs and fails); (e) receipt present on the fork side, absent in the probe → exit 0, not 2.
3. **The dispatch gate refuses four distinct ways, from the fetched branch only, and admits a valid receipt.** On the integration branch of `targetRepoRemote`: (a) suite absent — reason contains `no frozen acceptance suite`; (b) suite with no receipt — `no freeze receipt`; (c) receipt whose `suiteHash` differs from the branch's blobs (same formula, from `git ls-tree -r FETCH_HEAD`) — `receipt does not match`; (d) receipt `verdict: "half-proven"` and `allowHalfProven` not true — `half-proven`. Each refusal object carries `refusal` ∈ {`no-suite`, `no-receipt`, `receipt-mismatch`, `half-proven`}. A matching `red` receipt is dispatched. No `bd` write reaches the seam in any case.
   - verify: on the `tests/unit/dispatch-gate.test.js` pattern — bare remotes, working copies, `readyQueue()` through the `PIPELINE_BD_CMD` stub. Fixtures (a)–(e) as above; four `refusal` values pairwise distinct; no `update|note|close` verb at the seam. **The branch-not-working-copy pair:** (f) working copy has an uncommitted edit to a test file while the pushed branch holds the matching receipt → dispatched; (g) working copy pristine at the receipt's hash while the *pushed* branch has one extra byte → `receipt-mismatch`. A gate hashing `targetRepoPath` passes everything else and fails this pair. With `gitTimeoutMs: 1` the receipt path aborts `cause: 'git'` rather than hanging; the existing scan that every `spawnSync` in `runner/queue.js` is built from `gitSpawnOptions` stays [guard].
4. **`allowHalfProven` is a validated boolean, defaults to false, consulted only for the half-proven refusal.** `loadConfig` rejects a non-boolean by name; absent loads as `false`; `run.config.example.json` carries it; with `true`, fixture (d) dispatches while (b) and (c) are still refused; the manifest carries a top-level `allowHalfProven` boolean and the schema declares it.
   - verify: configs with `"yes"`, `1`, `null` throw naming the key; `true`/`false`/absent load. Re-run (b), (c), (d) with `true`: only (d) moves. Structural (the G9 precedent — `main()` is behind the preflight): `writeManifest` call contains `allowHalfProven: cfg.allowHalfProven`; schema `properties.allowHalfProven.type === "boolean"`.
5. **The refusal kind travels into the manifest row and the feed keeps it.** `undispatchableRow(issue, reason, runId, refusal)` returns a row with `refusal`; the schema declares `tasks.items.properties.refusal` with the four-value enum; every row key is a declared property; `runner/feed.js`'s refusal map carries `refusal` so `source.undispatchable()` returns it for initial and re-polled refusals alike.
   - verify: each kind → `row.refusal`; `Object.keys(row)` ⊆ schema properties; feed source (injected clock) with an initial `no-receipt` refusal and a poll returning `receipt-mismatch` — the kind survives both.
6. **The report heading names the refusal kind, and an old row still renders.** For an `undispatchable` row, `## <id> — UNDISPATCHABLE — <phrase>` with a distinct phrase per kind, and the remedy names the right action: `freeze` for no-suite, `run the freeze gate` for no-receipt / receipt-mismatch, `--green` or `allowHalfProven` for half-proven. A row with no `refusal` renders the historic sentence.
   - verify: render five one-row manifests; four headings pairwise distinct with their remedy regex; the fifth carries the historic sentence; `done` rows gain no refusal paragraph [guard]; scrutiny rank `0.5` unchanged [guard].
7. **The queue-summary line names the kind per refused id and stays parseable by the dashboard.** With refusals of all four kinds the clause after the first `;` reads `NOT DISPATCHABLE <n>: <id> (<kind>), ...`; with no refusals the line is byte-identical to today; `scripts/dashboard.js`'s `readyQueueIds` over the line returns only dispatchable ids.
   - verify: extend G7 accordingly.
8. **The docs say the receipt is part of the freeze.** `PLANNING.md` step 6 and `ONBOARDING.md` each contain `.freeze-gate.json`; `DESIGN.md` §3.2's table has a row containing `receipt` and §4.12 names a third admission rule; a change-log row exists; `test-changelog.sh` and `test-sanitize.sh` pass.

**Design choices made by the drafter.** Hash over git blob ids, not raw bytes (see the CRLF finding); dispatch side reads ids from `ls-tree`, never `cat-file`s a blob, so the cost is one `git show` of the receipt plus one `ls-tree` per candidate. `forkCommit` is informational, never compared (the suite commit is always later than the gate run). A receipt that is unparseable or lacks `suiteHash`/`verdict` is `no-receipt`. Check order per candidate: suite → receipt → hash → verdict; first refusal wins. `guards`/`brittleness` are `null` when unknown, never `0`.

**Spec problems the drafter found, and dispositions.**
- *Raw-byte hashing disagrees with itself across platforms* — the planning checkout is CRLF, the committed blob is LF, so a byte hash would refuse every task frozen from this machine. **Accepted**: the intent's "hash bytes" constraint is withdrawn; the hash is over git blob ids, which is what the verifier compares too, so §4.4 alignment holds.
- *`compareSuites` must exclude the receipt as well* — else every probe run exits 2. **Accepted**, in criterion 2(e).
- *"The label renders it" is not enough* — the manifest is `additionalProperties: false`; it needs a schema field. **Accepted**, criteria 5–6.
- *`feed.js` drops the field* — **accepted**, criterion 5.
- *`batch.js show` still reports `ready` for an id the receipt rule will refuse* — **deferred** to batch two (G4), where it is already the deliverable; an inbox note exists.

### Task 2 — guard-red (drafter's return)

1. **A guard file declares itself, and only a test file can.** A file carrying the literal token `[guard]` (any case) on a comment line within its first ten lines is a guard file; the token on line eleven, inside a string or code, in a file outside the gate's read allowlist (`.md`, `.txt`, `.png`), in a NUL-bearing file, or below the suite's top level, is not.
   - verify: a temp suite of nine files — `a.js` (`// [guard]` line 2), `b.sh` (`# [GUARD]` line 10), `c.js` (token on line 11), `d.js` (token in a string, no comment), `README.md`, `e.png`, `f.js` (NUL in the first ten lines), `nested/g.js`, `h.js` (no token). The exported scanner returns exactly `['a.js', 'b.sh']`, and `[]` (not a throw) with those two removed.
2. **The pure verdict table gains one row.** With a guard run supplied, `verdictFor` answers `stale-guard` / exit 5 only when the fork point is red at exit 1 on a green control and the guard run exited 1; every existing row is unchanged when the guard argument is `null` or the guard run exited 0.
   - verify: drive `verdictFor(real, control, kind, probe, probeControl, guard)`: `(1,0,·,null,null,1)`, `(1,0,·,0,0,1)`, `(1,0,·,1,0,1)` → `stale-guard`/5; `(0,0,·,·,·,1)` still `green`/1; `(1,1,…,1)` and `(2,0,…,1)` still `indeterminate`/2; a guard run at status 2, null, signalled or errored behind `(1,0)` → `indeterminate`/2 with `/guard/i` in the headline (never 5, never 0); the seven existing rows identical with guard `null` and with guard `ok(0)`; no object has `exit === 5` unless `verdict === 'stale-guard'`; `verdictFor(ok(5), ok(0))` is still `indeterminate` (a *suite* exiting 5 is not the *gate* exiting 5).
3. **The guard subset is a real third spawn over a directory holding exactly the guard files.** Through the CLI, a suite with one guard file and one ordinary file is three spawns without a probe and five with one: suite, control, then a guard-subset directory holding the guard files byte-identical and nothing else — a sibling of the suite inside the fork-point tree, removed afterwards.
   - verify: temp repo + byte-identical probe with `.is-probe`; `FREEZE_GATE_CMD` stub appends `{arg, listing, sha256 per file}` per spawn and drops a marker in its cwd. Without `--green`: three lines; with: five; exactly one `arg` matches `/\.freeze-gate-guards-/`, its listing is `['guard.js']`, its digest equals the fork-point file's, its `arg` starts `tests/acceptance/` (sibling, same depth, POSIX, relative), and its marker landed in the repo tree not the probe. Afterwards no `.freeze-gate-guards-*` remains in either tree. With the guard file removed the counts return to two and four.
4. **A red guard is exit 5 and the report names it; a green guard changes nothing.** A guard red alone at the fork point → CLI exit 5, output has `STALE-GUARD:`, a `guard run` line with the subset's exit status, and the file name; green → the verdict is whatever the rest of the table says (0, 3 or 4).
   - verify: `STUB_MODE=guard-red` without `--green` → 5, `/^STALE-GUARD:/m`, `/guard run\s+exit\s+1/`, includes `guard.js`; with `--green` → still 5 (the probe does not rescue a stale guard); default without `--green` → 4 and `/guard run\s+exit\s+0/`; default with → 0; `probe-red` with a green guard → 3. Every run prints `/^guard files:\s*1\b/m`; a suite with no guard file prints `guard files: 0` and no `guard run` line.
5. **The subset never runs when the fork point is not red-on-green-control.** A green suite still exits 1, a broken harness still 2, and the spawn count does not grow; the report says `guard run      not run (<reason>)`.
   - verify: `always-green` → 1, two spawns, `/guard run\s+not run/`; `always-red` → 2, two spawns; suite-only exit 2 → 2, two spawns; none contain `STALE-GUARD`; a missing test directory → 2 and no arguments → 2 with a guard file present.
6. **A guard subset that cannot run is `indeterminate`, names the guard side, and prints its stderr tail.** Exit above 1, killed, or failed to spawn → exit 2, `INDETERMINATE:`, `/guard/i` in the headline, stderr included — never `stale-guard`, never a pass. A `guard-red` run also carries the subset's stderr tail so a sibling-dependency error is readable.
   - verify: `guard-broken` exits 3 on the guard directory after writing `injected guard failure` to stderr → 2, headline matches, text present; `guard-red` writes `guard assertion failed` → present in the report.
7. **With the real runner, not the stub.** A repo-shaped tree with a copy of `tools/run-acceptance.sh`, a `_control`, and `demo/{plain.js (exit 1), guard.js}` where `guard.js` exits 0 only if `path.resolve(__dirname,'..','..','..','pipeline.config.json')` exists → exit 4; rewrite `guard.js` to `process.exit(1)` under the same header → exit 5 and stdout includes `guard.js`. Proves the subset directory sits where `__dirname`-relative resolution still reaches the root.
8. **The documents change.** `DESIGN.md` §3.2's table has the row (`stale-guard` within 2000 chars after `The gate's table, as it now stands`); `PLANNING.md` step 4 has `exit 5 — stale-guard` followed within 500 chars by `never a pass`; `docs/pipeline-diagram.md` and `docs/change-log.md` mention it; `bash scripts/test-planning-playbook.sh` fails on a copy of `PLANNING.md` with the stanza removed (through `PLAYBOOK_FILE`) and passes on the real file.

**Design choices made by the drafter.** Guard granularity is the *file*; the spec-level `[guard]` label and count stay independent. A comment line's first non-whitespace is `//`, `#`, `/*`, `*` or `--`. Top-level entries only, `LINT_EXTENSIONS` allowlist and the lint's NUL sniff reused. Subset dir `<parent of --tests>/.freeze-gate-guards-<pid>-<seq>/`, built and removed by a `withGuardDir` mirror of `withEmptyControlDir`, handed to the runner as a repo-relative POSIX path. Runs in the fork-point tree only, once, reusing that tree's control; nothing guard-related runs in the probe. Table order: broken real → 2; real green → 1; control not green → 2; real > 1 → 2; guard broken or > 1 → 2; guard exit 1 → 5; then the probe rows — a stale guard beats `half-proven`, `red` and `unreachable`. `verdictFor` takes a sixth positional argument defaulting to `null` so the frozen `repo-inj` suite keeps its meaning. Exit 5 is reachable from exactly one row.

**Spec problems the drafter found, and dispositions.**
- *"A guard depending on a sibling file is `indeterminate`" is not mechanically distinguishable from a stale guard* — a failed `require` exits 1 like a red assertion. **Accepted**: exit 1 is `stale-guard`, and the report carries the subset's stderr tail so the cause is readable (criterion 6). The intent's constraint is reworded.
- *The frozen suite for this task writes fixtures containing the token; if its own header mentions it in a comment in the first ten lines the gate treats the suite as a guard.* **Accepted**: the suite's header says "the guard token" and the criterion notes it.
- *Two existing suites carry a `README.md` beside their tests.* **Accepted** — the allowlist restriction in criterion 1.
- *"The gate names the file" (singular) — with several guard files run as one directory, the verdict names all of them.* **Accepted**, wording.
- *`tests/unit/freeze-gate.test.js` asserts exactly five distinct exit codes and `scripts/test-freeze-gate.sh` pins a PASS floor of 110; both must move.* **Accepted** — and the count goes up, not down (the repealed-assertion rule).

### Task 3 — events-ledger (drafter's return)

1. **Every `run.log` line has exactly one ledger twin, written by one function with one clock.** After a Docker-free fixture run, `runs/<runId>/events.jsonl` exists beside `run.log`; the number of events whose `msg` is a string equals the number of `run.log` lines; for every index *i* the *i*-th such event's `ts`, `level`, `msg` and `trace` equal the *i*-th line's.
   - verify: `tests/unit/events.test.js` calls `startRun(tmpRoot, …)` and drives the real `runOneTask` with that log object through the pause-gate fixture pattern — `PIPELINE_BD_CMD` stub with a stand-aside guard, a bare-remote seed, `PIPELINE_EXEC_STUB` writing `status.json` (attempts fail, fail, pass; two `specConcerns`) and `verify.json` (with `FAIL - ` lines), `PIPELINE_GH_CMD` stub. Index-aligned equality including `ts` line by line — fails any implementation that calls `new Date()` twice or writes from a second call site. Also `grep -c "events.jsonl"` over `runner/*.js` names exactly one file, `runner/log.js`.
2. **The envelope is fixed and the schema is load-bearing.** Every line parses as an object with `ts`, `level` (`INFO`|`ERROR`), `runId`, `issueId` (string, or `null` for the `preflight`/`feed` pseudo-tasks), `trace`, `event`, `msg` (string or null); `schemas/events.schema.json` lists them as `required`, `additionalProperties: false` on the envelope, enumerates every `event` name the writer emits, and declares each named event's fields.
   - verify: an inline ~40-line validator over `required`/`enum`/`additionalProperties` (no dependencies): every emitted event name is in the enum; every extra key is declared for that name; a planted line missing `ts` and a planted `"bogus"` event are rejected — a schema of `{}` fails.
3. **The facts the dashboard regex-parses today are named events with structured fields, and their `run.log` prose is unchanged.** The `P` table maps 1:1 onto named events: `run.target`, `lock.held`, `lock.tookOver`, `queue.read`, `task.started {priority,title}`, `workspace.ready {dir,branch,forkPoint}`, `container.launched {name,budgetMinutes}`, `container.ran {seconds,killed,activeSeconds}`, `task.rateLimited {pause}`, `park.opened {cycles,max}`, `park.reopened`, `park.waiting {until}`, `task.finished {exitCode,outcome,beads}`, `run.finished {dir}`, `task.refused`, `task.relaunched`, `feed.on`, `feed.pickedUp {added}`, `feed.closed {polls,ending}`, plus `task.undispatched {reason}` for the closing ERROR line. Everything else is `event: "log"`.
   - verify: the fixture reaches `task.started`, `workspace.ready`, `task.rateLimited`, `task.relaunched`, `task.finished`, `task.refused`, `queue.read`, `task.undispatched`; for each, the event name AND `msg.startsWith(P.<key>)` with the prefix read from `scripts/dashboard.js`'s own `P` (exported). Fields asserted against known fixture values. A one-character prefix rename fails `startsWith`; an event emitted as `"log"` fails the name check.
4. **The three facts no reader can get today are in the ledger, and failing check names come from `scripts/sweep-assertions.js`.** For a task with attempts `[fail, fail, pass]`, exactly three `attempt.finished {issueId, number, verifierResult, failingChecks}` in order, emitted once per task after the relaunch loop; `failingChecks` from that attempt's `feedback` (last attempt: `verify.acceptanceOutput` when `feedback` is absent), or `null` when neither text exists; exactly one `concern.raised {text}` per `specConcerns` entry, verbatim.
   - verify: attempt-1 feedback `"ok - a\nFAIL - b broke\n  FAIL - decoy (indented)\nnot ok 3 - c\nFAIL\tshell style\n"` → `failingChecks` deep-equals `failedAssertions(feedback)` from `sweep-assertions.js` AND equals `['b broke', 'shell style']` — the indented decoy and the `not ok` line excluded, which a hand-copied regex includes. `sweep-assertions.js` gains `failedAssertions(text)` built from the same regex constants `countAssertions` uses; `test-sweep-assertions.sh` still passes. A relaunch fixture (status collected twice) still yields one `attempt.finished` per attempt number.
5. **Append-only, one object per line, crash-safe prefix.** 50 `info` calls → 50 parseable lines, no `\r`, one trailing `\n`, file size only grows (read at 25 and 50); truncating at an arbitrary byte leaves every line before the last newline parseable — a writer that buffers and rewrites fails the size check.
6. **`run.log` is byte-for-byte what it was.** The fixture run's `run.log` messages, timestamps and temp paths masked, equal a literal expectation inside the suite (~20 strings copied from the current runner); and `scripts/test-events.sh` runs the seven existing reader suites and asserts each exits 0 with its check count unchanged, and that `git diff --stat <fork>..HEAD -- tests/unit/{dashboard,batch,audit-runs}.test.js` is empty. The reader suites alone prove nothing (their fixtures hand-write `run.log`); the literal expectation is the load-bearing half.
7. **Nothing in the container writes an event, and the fake-log seam still works.** No file under `pipeline/` references `events.jsonl` or `runner/log.js`; `runOneTask` driven with the existing fake log object still completes. `info`/`error` gain an optional third argument `{event, ...fields}`; absent → `event: "log"`.

**Design choices made by the drafter.** `write(level, traceId, msg, ev)` computes `ts` once; public `info(traceId, msg, ev?)`, `error(traceId, msg, ev?)`, `event(traceId, name, fields)` for ledger-only facts (`msg: null`). Ledger-only events (`attempt.finished`, `concern.raised`) exist rather than new `run.log` lines, so `run.log`'s line count is identical — `audit-runs`'s last-ERROR rule and `batch`'s first-line clock depend on it. `queue.read` pairs with the existing `ready queue:` line and takes `readyQueue()`'s structured result, so `queueSummary` gains no second signature. Suite at `tests/unit/events.test.js` + `scripts/test-events.sh` so the sweep globs it.

**Spec problems the drafter found, and dispositions.**
- *The intent names `not ok`; `sweep-assertions.js` has no such pattern.* **Accepted**: criterion 4 follows the code; per-file `PASS:`/`FAIL:` lines from `run-acceptance.sh` are never names, only inner `FAIL - <name>` lines are.
- *Failing names are only partially recoverable on the host* — `verify.json` holds the last attempt's tail (4000) and `status.json` holds `feedback` (2000) for failed attempts only. **Accepted**: names are a lower bound on a truncated tail; the schema says so and `failingChecks` allows `null`.
- *`container.ran`, `container.launched`, `lock.*` cannot be reached Docker-free.* **Accepted**: pinned by prefix only; `park.*` included via `createPauseGate` with an injected wait if cheap.
- *"The three readers keep passing" is vacuous as written* — their fixtures hand-write `run.log`. **Accepted**: criterion 6's literal expectation is the load-bearing half and is in the frozen test.
- *The intent's stronger "prose rendered from the event" touches ~73 call sites across 7 files.* **Accepted**: the one-call-one-timestamp form is the contract.

### Task 4 — refused-exit (drafter's return)

1. **The exit decision is a pure exported function of counts, and its table is fixed.** `runner/queue.js` exports `queueOutcome(dispatched, refused)` → `{ queue: { ready, dispatched, refused }, exitCode }`, `ready = dispatched + refused`, exit is the refused code exactly when `ready > 0 && dispatched === 0`, else 0. The feed's ending is not an input — under the feed "what was actually dispatched" *is* the dispatched number: `(0,0)→0`, `(3,0)→0`, `(0,8)→refused`, `(2,6)→0`.
   - verify: the function exists, has arity 2, is pure (same answer twice), returns exactly those codes and `ready` values, and the `queue` object has exactly three keys. A build that decides from a log string cannot pass — the function receives no string.
2. **`run.js` derives the manifest block and the process exit from one call, after the manifest is written, never via `process.exit` past the drain.** `dispatched = drained.length` (every issue the source handed out, including one that could not be claimed), `refused = source.undispatchable().length`; the manifest gets `queue`; `process.exitCode` is set after `writeManifest` and `networkDown`.
   - verify: a G9-style source read of `run.js` with comments stripped: `queueOutcome(` called with those two arguments; `writeManifest(` carries `queue:` bound to the same identifier; `process.exitCode` assigned from the same identifier after `writeManifest`'s index; no `process.exit(` between `drainQueue(source` and the end of `main`.
3. **The manifest schema admits the block and only that block.** Optional top-level `queue` (older manifests carry none), `required: [ready, dispatched, refused]`, integers ≥ 0, `additionalProperties: false`; top-level `additionalProperties` stays false.
   - verify: both directions of the G6g pattern — every key the code writes is declared, every declared key is written.
4. **The summary line leads with the dispatchable count and keeps the id slot the dashboard parses.** `queueSummary` returns exactly `ready queue: <d> of <r> dispatchable — <ids|(empty)>[; skipped …][; running … non-task: …][; refused <k>: <n> <label>[, <n> <label>]… — <id> (<label>), …]`, labels from each refusal's kind through a fixed map in a fixed order, zero-count kinds omitted, an unknown or absent kind rendered as its own string or `refused` — never dropped, never thrown on. `task(s)` and the old remedy sentence no longer appear.
   - verify: four pinned strings — `([], [], [])` → `ready queue: 0 of 0 dispatchable — (empty)`; two dispatchable (one a bug) + one epic → the skipped/running clauses in order; eight refusals of two kinds and nothing dispatchable → `ready queue: 0 of 8 dispatchable — (empty); refused 8: 5 <label>, 3 <label> — r-1 (<label>), …`; one refusal `kind: 'weird'` and one with none → `1 weird, 1 refused`, both ids present. G7a–G7f are rewritten, not deleted.
5. **The dashboard's id parser returns the dispatchable ids from the new line, none of the refused, and still reads the historic line.** `readyQueueIds` over `queueSummary(<two dispatchable, one epic, two refusals>)` — built from the live function, not a typed string — equals `['x-one','x-two']`; over the wholly-refused line, `[]`; over the literal historic `ready queue: 3 task(s) — …` line, three ids (runs on disk carry that grammar); refused ids never appear in `line.split(';')[0]`.
6. **The report shows the block when the manifest carries it, byte-identical when it does not.** `**Queue:** <d> of <r> dispatchable, <k> refused` directly after the `**N task(s)**` line when `manifest.queue` is present; absent → output equals a pre-change render captured as a fixture. Never `## ` — `scripts/test-report.sh` reads task order with `grep -o '^## '`.
7. **Every suite that pins the line moves with it, and check counts go up.** `dispatch-gate.test.js` ≥ 70 `ok` (fork point 64); `dashboard.test.js` ≥ 111 (108); the `-ge` floors in both wrappers raised to at least the fork-point actuals (today 55 and 60 sit *below* the real counts and would not trip a deletion); `test-runner-queue.sh` has zero matches of `ready queue: [0-9]* task` and at least five `ready queue: ` occurrences; `feed.test.js` still ≥ 63. The Docker suite cannot run in a container — its host execution is named in the PR body as a post-merge obligation, as `repo-5yu` did.

**Design choices made by the drafter.** Decision lives in `queue.js` beside `queueSummary` because `main()` is unreachable Docker-free. One function returns both block and code so they cannot disagree. `process.exitCode`, never `process.exit()`, so manifest, report, teardown and the lock's exit handler all still run. The id slot stays right after the first ` — ` and ends at the first `;`, so `readyQueueIds` needs no change and logs on disk keep parsing. The remedy sentence leaves the summary line — the per-issue error line and the report row carry it. `queue` is optional in the schema; `feed` set that precedent.

**Spec problems the drafter found, and dispositions.**
- ***Exit 2 is already taken*** — `main()` exits 2 for a bad config and a missing token, so an operator script could not tell "could not start" from "started, refused everything". **Accepted: the wholly-refused exit is 4** (free), and the DESIGN amendment lists all of the run's process exit codes in one place for the first time.
- *The design-ref does not exist yet* — §4.12 has no paragraph on the run's exit codes. **Accepted**: the amendment is written in this session, before freeze (step 0's rule).
- *The intent's literal example line breaks the dashboard* — it puts the refusal clause in the id slot. **Accepted**: the grammar in criterion 4 keeps the id slot; the intent's example is withdrawn.
- *"Six sites" is wrong* — five grep invocations at four assertion sites. **Accepted**: the docs phase corrects the number in DESIGN, STATUS and the row rather than propagating it.
- *"Two exit-2 cases" is undefined.* **Accepted**: there is one refused case; the sentence is withdrawn.
- ***Dependency on task 1's field name*** — this drafter assumed `kind` with `no-suite / unproven-suite / suite-changed / half-proven`; task 1's drafter chose `refusal` with `no-suite / no-receipt / receipt-mismatch / half-proven`. **Resolved in task 1's favour** — task 1 is upstream and its names describe the receipt mechanism precisely. Tasks 4 and 5 use `refusal` and those four values; the label map becomes `no-suite`→`no frozen suite`, `no-receipt`→`no freeze receipt`, `receipt-mismatch`→`suite changed since the gate`, `half-proven`→`half-proven only`.
- *The check-count floors are stale already.* **Accepted**, criterion 7.

### Task 5 — failure-class (drafter's return, with the cross-task names reconciled)

1. **A new pure module exports the decision.** `runner/failure-class.js` exports `failureClassFor({ outcome, exitCode, refusal, verify, attempts })` — spawns nothing, reads nothing from disk — returning exactly one string from `CLASSES = ['no-suite','no-receipt','receipt-mismatch','half-proven','suite-error','regressions','identical-failures','attempts-exhausted','timeout','internal','tampered','paused','unclassified']` for every non-`done` outcome and `null` for `done`, with this precedence, top rule wins: (a) `done` → null; (b) `undispatchable` → the `refusal` kind when it is one of the four, else `unclassified`; (c) `tampered`, `paused`, `partial` → `tampered`, `paused`, `regressions`; (d) `verify.acceptance === 'error'` OR the last attempt's `verifierResult === 'error'` → `suite-error`; (e) `failed` with `exitCode === 'killed'` → `timeout`, other `failed` → `internal`; (f) `stuck` → criterion 2; (g) anything else, including an unknown outcome word → `unclassified`.
   - verify: a Node checker pins every branch with inputs that share an outcome word but must differ in class — three `failed` rows (verifier `error` → `suite-error`; plain exit 30 → `internal`; `'killed'` → `timeout`); `undispatchable` with each of the four kinds, and with `refusal` missing or unknown → `unclassified`; `partial`, `tampered`, `paused`, `done` → null, `'banana'` → `unclassified`. Every return is in `CLASSES`; the module's source contains no `spawn`, `exec`, `readFileSync` or `child_process`. A class computed from the outcome word alone fails the three-`failed` fixture.
2. **`identical-failures` is a set comparison of the last two attempts.** For `stuck`: the sets of failing check names from the **last two** attempts' `feedback` both non-empty and equal as sets → `identical-failures`; both non-empty and different → `attempts-exhausted`; either attempt missing, without `feedback`, or yielding an empty set → `unclassified`. The recording changes no outcome, exit code or Beads write.
   - verify: (i) three attempts with the same two `FAIL - ` lines but different timestamps, `ok` counts, byte lengths, swapped order and one duplicate → `identical-failures` (a whole-string or whole-line comparison fails); (ii) attempts 1 and 3 equal with 2 different → `attempts-exhausted`, and 1 different with 2 and 3 equal → `identical-failures` (pins "last two"); (iii) feedback with only `ok` lines plus failures in a shape neither vocabulary knows (`not ok 3 - x`, `Error: boom`) → `unclassified` (catches empty-equals-empty); (iv) no `feedback` key, and a single-attempt `stuck` → `unclassified`; (v) one attempt in shell vocabulary (`FAIL\tx`) and the next in node vocabulary (`FAIL - x`) → `identical-failures` (the name is the text after the prefix, trimmed). Also: `outcomeFor` and `OUTCOMES` unchanged before and after requiring the module; `failureClassFor` referenced nowhere under `pipeline/`.
3. **Failing check names come from `scripts/sweep-assertions.js`'s exported `failingChecks(logText)`** — sorted, de-duplicated, built from the same `NODE_FAIL` / `SHELL_FAIL` constants `countAssertions` uses plus one new constant for the colon form this repo's own runner prints (`FAIL: <text>`), which is used by `failingChecks` only; `countAssertions` and `cell` are byte-identical on every existing fixture; `runner/failure-class.js` imports `failingChecks` rather than carrying a regex.
   - verify: `sweep-assertions.test.js` gains: a CRLF log with `FAIL - a\r`, `FAIL\tb`, `FAIL: c`, `FAIL - a` again, `ok - d`, `PASS e` → `['a','b','c']`; every pre-existing `countAssertions` fixture unchanged. The failure-class checker asserts the module's source has no regex literal beginning `/^FAIL` or `/^ok`, that its `require` specifiers include `sweep-assertions`, and — the discriminating one — that monkey-patching the exported `failingChecks` to return a canned set changes `failureClassFor`'s answer. A private copy passes the grep and fails this.
4. **Every task row the runner writes carries the class.** `runOneTask`'s row has `failureClass` for every non-`done` outcome and no such key for `done`; `undispatchableRow` carries the class from its `refusal` (task 1's field); the schema lists the field with `enum` equal to `CLASSES` and an `if/then` making it required whenever `outcome` is not `done`.
   - verify: drive `runOneTask` as `pause-gate.test.js`'s `parkedTask` does, with three exec stubs: three `fail` attempts with the same `FAIL - ` set, exit 10 → `stuck` / `identical-failures`; attempt 3's set differing → `attempts-exhausted`; a pass, exit 0 → `'failureClass' in row === false`. `undispatchableRow` with each refusal → that class. Schema enum equals `CLASSES` element-for-element; `additionalProperties: false` still; `if/then` present with `required` containing `failureClass`; every produced row's keys are declared. A merely-optional field fails the `if/then` assertion.
5. **The report renders the class in the heading.** For every task with a `failureClass`: `## <issueId> — <LABEL> · failure class: <class>`; for a `done` row or a row without the field (an older manifest) the heading is byte-identical to today's; nothing else in the body changes.
   - verify: render one row per class plus a `done` row and an old-style `stuck` row; classed headings match `/^## <id> — .+ · failure class: <class>$/m`; the two unclassed match `/^## <id> — [^·]+$/m`; `test-report.sh`'s `grep -o '^## [a-z0-9-]*'` ordering unchanged; rendering twice is byte-identical. A renderer printing `failure class: undefined` on a done row fails.
6. **The design and docs name the column.** `DESIGN.md` §4.11's outcome table gains a "Failure class" column; a change-log row; `docs/pipeline-diagram.md`'s outcome table gains the column; a new Docker-free suite `scripts/test-failure-class.sh` wrapping `tests/unit/failure-class.test.js`, listed in `CLAUDE.md`'s suite block; `test-changelog.sh` and `test-sanitize.sh` exit 0.

**Design choices made by the drafter.** A new module, not a growth of `outcomeFor`: the class is downstream of the outcome and never consulted by anything that writes Beads or an exit code. `suite-error` outranks `internal` because exit 30 is shared and only the verifier artifacts tell them apart. Last two attempts, not first-vs-last: the class asserts the final attempt made no progress on the one before. An empty set never counts as equal. `done` rows carry no field rather than `none`; the schema's `if/then` makes absence on a non-done row a validation failure while older manifests stay valid. Host-only; nothing under `pipeline/` references it.

**Spec problems the drafter found, and dispositions.**
- ***The intent's vocabulary does not match the artifact*** — real feedback carries `FAIL: <text>` (the colon form `tools/run-acceptance.sh` prints) and `sweep-assertions.js` matches only `FAIL - ` and `FAIL<space|tab>`, so a strict "reuse, never copy" leaves today's stuck runs `unclassified` on every attempt. **Accepted, resolved as criterion 3**: one new colon-form constant in `sweep-assertions.js`, consumed by `failingChecks` only, so the sweep's PASSED column is untouched and the names are still extracted by the one file that owns the vocabulary.
- *Task 3 and this task both add an export to `sweep-assertions.js` under different names.* **Resolved**: the export is `failingChecks(logText) → string[]`, sorted and de-duplicated; task 3 (run one) adds it, this task (run two) consumes it. Task 3's criterion 4 is amended to that name and to the colon form.
- *Task 1's refusal field name was open.* **Resolved** as above (`refusal`, four values); the classes `unproven-suite` / `suite-changed` in the intent are renamed `no-receipt` / `receipt-mismatch`. Task 1 owns the `undispatchableRow` signature.
- *`suite-error` reads `verify.json`'s `acceptance: 'error'` and the attempt's `verifierResult`, not `classify()` directly; `regressions: 'error'` deliberately does not trigger it.* **Accepted**.
- *"Otherwise" is ambiguous for a `stuck` row with fewer than two attempts.* **Accepted**: `unclassified`.

## Step 2 — lint and critics

### spec-lint

`node scripts/spec-lint.js --repo . <this file>` — 3 findings, all the frozen path
`tools/run-acceptance.sh`: line 61 (a constraint saying what that runner executes), the task 2
criterion that *copies* it into a throwaway tree, and a disposition line quoting its output
format. **Rejected, all three**: none orders an edit to the file; the criterion reads it and
copies it, which is what the lint's own comment says is normal for the acceptance directory.

### Critics

Labels decide depth: tasks 1 and 3 are `hard` and get the full panel (ambiguity,
testability, scope); tasks 2, 4 and 5 are `medium` and get testability. Nine reviews, each in
fresh context with the charter as its only instruction. Each JSON is recorded verbatim, then a
disposition per `details[]` entry.

#### Task 1 — scope

```json
{
  "advisor": "scope",
  "verdict": "concerns",
  "summary": "This is two tasks — the gate that writes a receipt and the runner that enforces it — spanning the planning tool, the runner, the schema, the report and four documents, with one deliverable that belongs to task 4 and a migration nobody has declared.",
  "details": [
    "Split into (1) the receipt writer — scripts/freeze-gate.js writes .freeze-gate.json on a proceeding verdict, compareSuites excludes it, the blob-id hash formula, tests/unit/freeze-gate.test.js, PLANNING.md step 6, ONBOARDING.md, the DESIGN §3.2 receipt row and its change-log row (criteria 1, 2, and the doc half of 8) — then (2) the enforcement side, depending on it — runner/queue.js's three new refusals with their `refusal` kinds, `allowHalfProven` in runner/config.js and run.config.example.json, the manifest field in runner/run.js and schemas/run.schema.json, the feed map in runner/feed.js, the report label in runner/report.js, the DESIGN §4.12 third admission rule (criteria 3, 4, 5, 6, and the rest of 8). The two halves pass and fail independently, are verified by different suites against different fixtures, and a receipt-writing gate is worth shipping alone because it lets suites start carrying receipts before anything refuses them. A mixed diff of ~15 files across five components hides which half broke.",
    "Undeclared migration. The day the enforcement half merges, every suite already frozen on any target's integration branch has no receipt, so every currently-ready task — including this repo's own dogfood queue — is refused `no-receipt` until someone re-runs the gate on each and pushes. The spec never says who does that or when. Declare it explicitly: either the writer lands first and existing suites are re-gated before the enforcement half is launched, or the enforcement task's PR body names the re-gating as a post-merge obligation. Without that, the first run after merge refuses its whole queue with a correct reason and the batch reads as a pipeline failure.",
    "Criterion 7 is task 4's deliverable arriving early. It rewrites the NOT DISPATCHABLE clause of the queue-summary line and extends the dashboard parse; task 4 then rewrites the same line's grammar again in the next run, and both drafts pin different wordings of one string. Drop criterion 7 from task 1 — the refusal kind already travels in the manifest row via criterion 5 — and let task 4 render it once. Otherwise the same line and the same six grep sites move twice in two consecutive runs.",
    "The spec contradicts itself as an agent would receive it. The Description and Constraints say the hash is over bytes with no line-ending normalisation; the drafter's return (criterion 2) replaces that with a hash over git blob ids after the clean filter, and the disposition says the byte constraint is withdrawn — but the Description and Constraints text was not revised. An agent reading the whole spec gets two incompatible hash definitions. Rewrite the Description and the second Constraint bullet to match criterion 2 before freezing.",
    "The design-ref does not yet exist. DESIGN.md §3.2's table today ends at the `unreachable`/`indeterminate` rows with no receipt row, and §4.12 has two admission rules with no third; the sections this task cites are the amendments criterion 8 has the task itself write. §3.1's design-doc-first rule and the step-0 practice task 4's drafter invoked for the exit-code paragraph apply here too: write the §3.2 row and the §4.12 third rule in this planning session, before freeze, so the container amends nothing it is also measured against.",
    "The Constraints are the real specification. Seven bullets introduce the config knob, the manifest field, the report label change, the dashboard parse and two playbook edits — none of which the Description names. That is the signature of a task larger than its one-paragraph framing, and it is what the split above addresses.",
    "Label fit: `hard` is right for the whole and stays right for the enforcement half (two silent failure directions on the hash, a wrong answer refuses or admits a whole batch). The writer half on its own is `medium` — one file, one suite, pure-function hashing that the test recomputes independently."
  ]
}
```

Dispositions:
1. *Split into writer and enforcer* — **accepted**. Task 1 becomes **1a receipt-writer** (`medium`, criteria 1, 2 and the doc half of 8) and **1b receipt-enforce** (`hard`, criteria 3–6 and the rest of 8, depends on 1a). Six tasks in the batch; the run plan is in step 5.
2. *Undeclared migration* — **accepted**. Declared in step 5: after 1a merges, the planning session re-runs the gate on every suite that will still be dispatched — this batch's own run-two suites first — and pushes the receipts before 1b is launched; 1b's PR body names re-gating of any other target's open suites as a post-merge obligation, the way `repo-5yu` named its host sweep.
3. *Criterion 7 is task 4's* — **accepted**. Dropped from task 1; the kind travels in the row (criterion 5) and task 4 renders the line once.
4. *Description contradicts criterion 2 on the hash* — **accepted**. The Description and the second Constraint are rewritten to the blob-id hash in the revised spec (step 5).
5. *Design-ref does not exist yet* — **accepted**. The §3.2 receipt row, the §4.12 third admission rule, the run's exit-code paragraph, the §4.11 class column and the events artifact are written into `DESIGN.md` in this session, with change-log rows, before anything is frozen.
6. *Constraints are the real specification* — **accepted**, resolved by the split.
7. *Labels* — **accepted**: 1a `medium`, 1b `hard`.

#### Task 1 — ambiguity

```json
{
  "advisor": "ambiguity",
  "verdict": "concerns",
  "summary": "The hash formula the gate and the dispatch gate must both reproduce is under-pinned on path relativity and on what files the walk includes, the spec's own Constraints still say 'bytes' while the criteria say blob ids, and several outputs (per-kind remedy, summary-line kind, unknown verdict values, the design-ref rows) admit more than one build.",
  "details": [
    "Criterion 2 '<relative-path>\\0<git-blob-id>\\n ... relative paths with / separators' and criterion 3 'same formula, from git ls-tree -r FETCH_HEAD' — relative to what? ls-tree -r prints repo-root-relative paths, while criterion 2 reads as suite-relative. One engineer hashes suite-relative on the gate side and root-relative on the dispatch side and refuses every task. Separately, git hash-object --path <rel> <file> looks attributes up for <rel> against the process cwd, so a suite-relative <rel> from a cwd that is not --repo applies the wrong .gitattributes and the CRLF fixture passes or fails by accident.",
    "Constraints still say 'The content hash is over bytes, with no line-ending normalisation' and the Description says 'hashed as bytes', while criterion 2 says blob ids. An engineer who reads the Constraints as binding builds raw-byte hashing and refuses everything frozen from the CRLF checkout.",
    "Criterion 2 'every file under the suite directory except .freeze-gate.json' — every file on disk, or every file git will commit? A git-ignored stray in the suite directory at gate time makes a receipt that can never match the branch, with no message saying why.",
    "Unstated: a parseable receipt whose verdict is any other string, or whose gateVersion is not 1, or whose suiteHash matches. One engineer dispatches it, another calls it no-receipt, a third adds a fifth refusal.",
    "Criterion 6 'the remedy names the right action' — in which text? The undispatchable remedy appears in three places: the report heading, the body paragraph, and the manufactured row's changeSummary / attemptNotes. Criterion 6 pins only the heading.",
    "Criterion 7 'NOT DISPATCHABLE <n>: <id> (<kind>)' — is <kind> the enum value or a human label? Does today's trailing remedy sentence stay, get dropped, or become per-kind? 'the clause after the first ;' also assumes no 'skipped ... by type' clause.",
    "design-ref — neither section exists in DESIGN.md yet. The gate's table is keyed by fork/control/probe results and exit codes, and a receipt is not a verdict — one engineer adds a row, another a column, another a paragraph, and a grep for the word receipt accepts all three.",
    "Criterion 1 — unstated what happens when the receipt write itself fails (read-only tree, --tests naming a single file, disk error). State whether a failed receipt write changes the exit code.",
    "forkCommit null when not a git repo, beside criterion 2's blob-id hash: git hash-object --path needs a repository for attribute lookup. Also an unborn HEAD. Say whether a non-git --repo is refused.",
    "'forkCommit' — DESIGN.md uses 'fork point' for the integration-branch commit a container forks from; the receipt's field is the planning checkout's HEAD at gate time, on whatever branch that worktree has out. The name invites a later reader to compare it."
  ]
}
```

Dispositions (all land in the revised 1a/1b specs in step 5):
1. *Path relativity and `--path` cwd* — **accepted**. Paths in the hash are suite-relative; the gate runs `git hash-object --path <repo-root-relative>` with cwd = `--repo`; the dispatch side strips the suite prefix from `ls-tree` output before hashing.
2. *"bytes" in the Description/Constraints* — **accepted**, rewritten.
3. *On-disk walk vs what git will commit* — **accepted**: the walk is `git ls-files --cached --others --exclude-standard -- <suite>` from `--repo`, so an ignored stray never enters the hash and an unignored one does — and will be committed, so it matches.
4. *Unknown `verdict` or `gateVersion`* — **accepted**: `no-receipt`. A receipt the gate did not write is no receipt.
5. *Which texts carry the per-kind remedy* — **accepted** (1b): the heading, the body paragraph and `undispatchableRow`'s `changeSummary` / `attemptNotes` are all keyed by kind; the criterion pins all three.
6. *Criterion 7's kind/label and trailer* — **moot**: criterion 7 is dropped (scope, above); task 4 owns the line.
7. *Design-ref shape* — **accepted**: §3.2 gains a paragraph headed *The receipt* after the table (a receipt is not a verdict, so not a row) and §4.12 gains the third admission rule as a paragraph; both written this session; criterion 8's grep targets `.freeze-gate.json` in §3.2 and `third admission rule` in §4.12.
8. *Failed receipt write* — **accepted**: exit 2 with a stderr line naming the path — refuse to bless rather than refuse to notice.
9. *Non-git `--repo`* — **accepted**: refused at exit 2 before any run, since the hash needs a repository; an unborn HEAD records `gateHead: null`.
10. *`forkCommit` misnames what it holds* — **accepted**: renamed `gateHead`, described in the schema as "HEAD of the planning checkout when the gate ran; informational, never compared".

#### Task 3 — ambiguity

```json
{
  "advisor": "ambiguity",
  "verdict": "concerns",
  "summary": "The event names, the queue.read payload, the failing-check extractor and the meaning of 'refused' each admit more than one build, and criterion 4 as written conflicts with the task-5 amendment that is declared part of this spec.",
  "details": [
    "Criterion 4 says failedAssertions(feedback) in document order with no colon form; task 5's disposition says failingChecks(logText), sorted and de-duplicated, with a colon-form constant. State the final name, the sort/de-dup rule, and whether the colon form is in scope for this task.",
    "'the queue read with every refusal and its reason' — criterion 3 lists queue.read with no fields. One engineer emits ids, another copies whole issue objects into the ledger, a third emits only counts.",
    "'refused' means two things: P.refused is the rate-limit cap (task.refused), the Description's 'every refusal' is the dispatch gate (task.undispatched).",
    "failingChecks — a passing last attempt has no feedback but does have acceptanceOutput; one engineer emits [] , another null. Say which value an attempt with text but no failures yields.",
    "'exactly one concern.raised per specConcerns entry' — status.json persists across relaunches; nothing says once per task after the loop, as attempt.finished does.",
    "issueId derivation from a trace: today the trace carries preflight/feed in the id slot, and feed.js's fallback means a trace can itself be null.",
    "event(traceId, name, fields) for ledger-only facts — are they echoed to the console, and which level do they carry?",
    "task.finished {exitCode,outcome,beads} — exitCode is a number or 'killed'; beads is absent on one branch; container.ran's killed is a boolean or a substring. One sentence per event with the JSON types settles the schema.",
    "Criterion 6's '~20 strings copied from the current runner' — a subset or the full fixture log? Is stdout ordering part of 'unchanged'?",
    "The envelope is additionalProperties:false but each named event 'declares its fields' with no statement of whether they sit beside event or under a nested key. Two incompatible line shapes both pass a self-written validator.",
    "Criterion 5's 'truncating at an arbitrary byte' — a truncation on a newline boundary proves nothing. Name the byte."
  ]
}
```

Dispositions (all land in the revised task 3 spec in step 5):
1. **Accepted**: the export is `failingChecks(logText) → string[]`, sorted, de-duplicated, and the colon-form constant is in this task's scope; criterion 4's fixture expectation becomes `['b broke','shell style']` sorted, plus a `FAIL: colon` line yielding `colon`.
2. **Accepted**: `queue.read` fields are `{ready: [id], skipped: [{id, type}], refused: [{id, reason, refusal?}]}` — ids, never issue objects; `refusal` optional until 1b lands.
3. **Accepted**: stated in the criterion — `task.refused` is the rate-limit cap, `task.undispatched` is the dispatch gate.
4. **Accepted**: text present with nothing failing → `[]`; `null` only when no text exists.
5. **Accepted**: `concern.raised` is emitted once per task after the relaunch loop, like `attempt.finished`.
6. **Accepted**: `issueId` is the trace's tail after `<runId>/`, mapped to `null` for `preflight` and `feed`; a null trace gives `trace: null, issueId: null`.
7. **Accepted**: ledger-only events are not echoed to the console and carry `level: "INFO"`.
8. **Accepted**: the revised criterion 3 lists each named event's fields *with JSON types*; `exitCode` is `integer | "killed"`, `beads` is `string | null`, `killed` is boolean.
9. **Accepted**: the literal expectation is the *whole* fixture `run.log`, every line; console ordering is not part of the contract.
10. **Accepted**: per-event fields live under a nested `data` object; the envelope stays closed.
11. **Accepted**: truncate at the midpoint of line 30's byte range.

#### Task 3 — scope

```json
{
  "advisor": "scope",
  "verdict": "concerns",
  "summary": "The writer and its envelope are one right-sized task, but the three new ledger-only facts plus the sweep-assertions export are a second deliverable with a different consumer (task 5), and two dependencies the table does not declare would break a shared run.",
  "details": [
    "Split into (1) the structured channel itself — runner/log.js gains the twin writer, the fixed envelope, schemas/events.schema.json, the append-only/crash-safe behaviour and the named events for lines run.log already prints (criteria 1, 2, 3, 5, 6, 7) — and (2) the ledger-only facts — attempt.finished, concern.raised, queue.read, and the failingChecks export plus the new colon-form constant in scripts/sweep-assertions.js (criterion 4). Piece 2 is the only part that touches scripts/ and the sweep's vocabulary, its correctness is judged by a different fixture family, it can pass or fail independently, and it is the part task 5 actually consumes. Order: 1 then 2, with task 5 declared behind 2.",
    "Undeclared dependency in the table: task 5's criterion 3 imports failingChecks, which this task adds, yet the table lists task 5 as depending on task 1 only.",
    "Undeclared coupling with task 1 inside the same run: criterion 6 pins a check count per reader suite, and task 1 adds checks to the dispatch-gate suite in the same run, so whichever branch merges second fails a frozen check for a reason unrelated to its own work. Drop the check-count pin or declare 3 behind 1.",
    "The Description says 'No reader changes in this task', but criterion 3 requires scripts/dashboard.js to export its P table. Say plainly that dashboard.js gains one export and nothing else.",
    "Gap against the design-ref: DESIGN.md's run-artifacts paragraph does not name events.jsonl. Task 5 carries a docs criterion; this task carries none. Add the same docs criterion here.",
    "Blast radius, measured: 72 log call sites across seven runner files; under the one-call-one-timestamp form only the ~20 sites behind the P table need a third argument, plus three new ledger-only emits, one export each in dashboard.js and sweep-assertions.js, a new schema, a new suite and its wrapper. One coherent PR for piece 1 alone.",
    "Label fit: hard is right for either piece as the failure mode is silent. Do not relabel the split pieces down to medium."
  ]
}
```

Dispositions:
1. *Split* — **accepted**. Task 3 becomes **3a ledger-writer** (`hard`: the channel, the envelope, the schema, the named events for lines `run.log` already prints, append-only, `run.log` byte-identical, container untouched) and **3b ledger-facts** (`hard`: `queue.read`, `attempt.finished`, `concern.raised`, and the `failingChecks` export with the colon-form constant), 3b depending on 3a.
2. *Task 5 depends on the export* — **accepted**: 5 depends on 3b (and on 1b for the refusal kinds).
3. *Check-count pin couples 3 to 1 in the same run* — **accepted**: the pinned counts are dropped from the reader-suite check; exit 0 plus the whole-file `run.log` expectation plus the empty diff on the three reader suites carry the load.
4. *"No reader changes" vs the `P` export* — **accepted**: reworded — `scripts/dashboard.js` gains `module.exports.P` and nothing else.
5. *No docs criterion* — **accepted**: 3a gains the same docs criterion task 5 has (DESIGN §4.12 artifacts paragraph names `events.jsonl`, change-log row, pipeline diagram, CLAUDE.md suite listing), and the DESIGN amendment is written this session.
6. *Blast radius* — noted; it is the case for the split.
7. *Labels* — **accepted**: both `hard`.

#### Task 1 — testability

```json
{
  "advisor": "testability",
  "verdict": "concerns",
  "summary": "The receipt's hash is computed by two files that the spec only says use the 'same formula', and the dispatch-side fixtures as drafted can pass while the two drift; the hash also walks the working tree on one side and the committed tree on the other with no fixture that separates them, and the CRLF discriminator collides with the house git helper's own autocrlf override.",
  "details": [
    "Criterion 3's admit fixture and pair (f)/(g) are answered by whatever formula runner/queue.js implements, not by what scripts/freeze-gate.js writes: the test builds the branch itself, so the receipt it commits will be one the TEST computed — and a drift between the two hashes passes every check while refusing every real freeze. Observable evidence: the receipt in the admit fixture is produced by the real gate's exported hash function against the same tree; or the formula is one exported function both files import, and the test asserts both sources require it.",
    "Criterion 2 hashes files on disk, criterion 3 the committed tree. A git-ignored file, an untracked scratch file, or anything the suite writes beside itself while the gate RUNS it (the spec never says whether the hash is taken before or after that run) lands in the receipt and not on the branch. Observable evidence: a fixture with one .gitignored file and one test that creates a file in its own directory when run; the receipt must match the pushed branch's blobs. Pin which population and when.",
    "Criterion 2(d), the CRLF discriminator, depends on git CONFIG the implementation reads from the environment: the host has core.autocrlf=true globally, the container none, and the house git() helper commits with -c core.autocrlf=false on every call. Observable evidence: write core.autocrlf into each fixture's .git/config, commit without a per-call override, assert the committed blob carries no \\r before comparing, and set GIT_CONFIG_GLOBAL to an empty file.",
    "Criterion 3's gitTimeoutMs: 1 check does not reach the receipt path — the first git call aborts before any show or ls-tree of a receipt. Observable evidence: extend the structural scan to every child_process use in runner/queue.js and any module the receipt path requires.",
    "Constraint 'only into the --tests directory' is never asserted for the probe; an implementation that writes the receipt into both trees passes. Observable evidence: after a --green run the probe's suite has no receipt and its digest is unchanged.",
    "Criterion 6's remedy regexes overlap: 'freeze' is a substring of 'run the freeze gate', so a renderer printing the no-receipt remedy for every kind passes. Observable evidence: one negative assertion per kind.",
    "Criterion 8's '§4.12 names a third admission rule' is not pinned: 'third' and 'admission rule' are both already in §4.12's vocabulary. Name the literal phrase.",
    "Criteria 1 and 2 add git-repository fixtures to tests/unit/freeze-gate.test.js, which sets no git identity; in the container the fixture commit fails and everything reports as genuine failures rather than a broken harness. Observable evidence: the fixture builder sets GIT_AUTHOR_*/GIT_COMMITTER_* and -c commit.gpgsign=false, and asserts the fixture commit exists as its own check."
  ]
}
```

Dispositions (1a/1b revised specs, step 5):
1. *Two formulas can drift* — **accepted**: the hash is one exported function in a new host-only module, `runner/suite-hash.js`, that both `scripts/freeze-gate.js` and `runner/queue.js` require; the admit fixture's receipt is produced by calling that function, and the suite asserts both files require the module.
2. *Two populations, and when* — **accepted**: the hash is over `git ls-files --cached --others --exclude-standard -- <suite>` (see ambiguity 3), taken **before** the suite is run; a fixture holds one ignored file and one test that writes beside itself, and the receipt still matches the pushed branch.
3. *CRLF discriminator vs ambient git config* — **accepted**: each fixture's `core.autocrlf` is written into its own `.git/config`, commits carry no per-call override, the committed blob is asserted `\r`-free, and `GIT_CONFIG_GLOBAL` points at an empty file.
4. *`gitTimeoutMs: 1` never reaches the receipt path* — **accepted**: that check is dropped; the structural scan covers every `child_process` use in `runner/queue.js` and `runner/suite-hash.js`.
5. *Probe receipt* — **accepted**: after a `--green` run the probe's suite has no receipt and its digest is unchanged.
6. *Overlapping remedy regexes* — **accepted**: one negative assertion per kind.
7. *Criterion 8 unpinned* — **accepted**: the literal phrase `third admission rule` and `.freeze-gate.json` within the same §4.12 paragraph.
8. *No git identity in the freeze-gate suite* — **accepted**: identity and `commit.gpgsign=false` set by the fixture builder; the commit's existence is its own check.

#### Task 3 — testability

```json
{
  "advisor": "testability",
  "verdict": "concerns",
  "summary": "Criterion 4's fixture cannot tell whether run-acceptance.sh's per-file FAIL: <path> lines become check names once task 5's colon form lands, and criterion 3 asserts two events (queue.read, task.undispatched) that are emitted only inside main(), which no Docker-free fixture can reach; criterion 6's literal run.log expectation also needs its masking pinned for both platforms before it can be frozen.",
  "details": [
    "On a real run feedback IS verify.acceptanceOutput, and that output always carries run-acceptance.sh's per-file lines FAIL: tests/acceptance/<id>/<file>.js. The drafted fixture contains no colon line, so an implementation that reports the file path as a name and one that does not both pass. Decide before the freeze and plant a FAIL: <path> line with the expected answer stated.",
    "queue.read and task.undispatched are written only in main(), behind require.main, loadToken and the Docker preflight — a frozen check on them is unreachable by any implementation in the container (the repo-8v0 shape). Name an exported pure helper that emits them, or demote both to prefix-only.",
    "Criterion 6's literal run.log expectation is under-specified for two platforms: the temp path appears with backslashes on the host and slashes in the container, and the fork-point hash differs per fixture. Pin the masking, compare line count as well as text, and for the ~50 lines the fixture never reaches say plainly that git diff <fork>..HEAD -- runner/ removes no line containing log.info( or log.error(.",
    "Criterion 6's second half is vacuous in the sweep (merge-base is HEAD after merge) unless the fork is computed as pipeline/verify.js does, inlined; and if the frozen test spawns the reader suites it inherits the NODE_OPTIONS --require bd stub unless the env is scrubbed.",
    "Criterion 3 reads prefixes from dashboard.js's own P (exported), but P is not exported today and the Constraints forbid reader changes.",
    "Criterion 1's grep -c over runner/*.js is a source-text assertion a comment can fail; the index-aligned ts/msg/trace equality already proves the single-writer property."
  ]
}
```

Dispositions (3a/3b revised specs, step 5):
1. *The per-file `FAIL: <path>` lines* — **accepted, decided**: the colon form is a name like any other. A file-level failure line is stable across attempts (the same file failing twice yields the same name), so it adds no false difference to task 5's comparison, and the real targets' suites print their assertion failures in exactly that form. The fixture plants `FAIL: tests/acceptance/x/t.js` and the expected set includes it. (3b.)
2. *`queue.read` and `task.undispatched` unreachable Docker-free* — **accepted**: both are emitted by exported helpers in `runner/queue.js` that take a log object — `logQueueRead(log, q)` and `logUndispatched(log, refusal)` — which `main()` calls and the frozen test drives directly. (3b.)
3. *Masking pinned* — **accepted**: the temp path is substituted in both separator forms, `[0-9a-f]{8}` after `fork point ` is masked, line count is compared; and the "no `log.info(`/`log.error(` line removed under `runner/`" diff check is added, with the fork computed as `git merge-base <integration> HEAD` inlined. (3a.)
4. *Vacuous diff and inherited preload* — **accepted**: fork computed inline as above; children spawned with `NODE_OPTIONS` and every `PIPELINE_*` variable removed. (3a.)
5. *`P` export* — **accepted**, already reworded (scope 4).
6. *`grep -c` source assertion* — **accepted**: dropped; the behavioural check carries it.

#### Task 2 — testability

```json
{
  "advisor": "testability",
  "verdict": "concerns",
  "summary": "Criterion 3's 'marker landed in the repo tree' check is satisfied by the suite and control spawns alone, and every stub in the house protocol reads a non-empty directory as red, so the guard subset is exit 5 by default unless the stub is keyed to the subset directory's name — both need pinning before the freeze; everything else is checkable as written.",
  "details": [
    "Criterion 3 'its marker landed in the repo tree not the probe' is presence standing in for correctness: the suite and control runs already drop markers in the repo tree, so the assertion passes with no guard spawn at all. Key the marker to the spawn that wrote it.",
    "Criteria 3–6 rest on a stub whose exit-code protocol the spec never states: every stub in this repo exits 1 for any non-empty non-control directory, so a guard file makes every default run exit 5 until the stub special-cases the subset by NAME. Pin the protocol in the criterion and say the naming is house style (repo-inj did the same for .freeze-gate-control-).",
    "Whether the probe still runs when the guard is already red is unconstrained: 3 spawns with --green under guard-red and 5 both satisfy 'still 5'. Pin the count or state it is deliberately unconstrained.",
    "Criterion 2 'no object has exit === 5 unless verdict === stale-guard' names no population. Restate over the enumerated sweep; and state that guard null and guard ok(0) are identical to the five-argument call, since the frozen repo-inj suite calls verdictFor with five arguments.",
    "Criterion 8 'pipeline-diagram.md and change-log.md mention it' is green today for a loose pattern — both already contain 'guard'. Pin the literal stale-guard, verified absent today.",
    "Criterion 7's first half (guard green → exit 4) passes against the unchanged gate; only the rewrite-to-exit-1 → 5 half discriminates. Keep both in one pair. Set FREEZE_GATE_CMD to the empty string, not deleted. Keep the real-runner case in a temp tree, never at ROOT — a subset directory left in the workspace's tests/acceptance/ by an interrupted run is an untracked addition the verifier counts as tampered.",
    "Criterion 6's 'killed' branch is not deterministically reachable through the CLI; keep it at the verdictFor level and do not add a CLI timeout fixture."
  ]
}
```

Dispositions (task 2 revised spec, step 5):
1. **Accepted**: each marker is named from the argument the stub received; the check reads the marker whose argument is the subset directory.
2. **Accepted**: the stub protocol is written into the criterion — a directory whose name matches `.freeze-gate-guards-` exits 0 unless `STUB_MODE` is `guard-red` (1) or `guard-broken` (3); the name is the seam, as `.freeze-gate-control-` already is.
3. **Accepted, pinned**: a stale guard short-circuits the probe — under `guard-red` with `--green` the spawn count is 3, not 5.
4. **Accepted**: restated over the enumerated sweep; guard `null` and guard `ok(0)` are asserted identical to the five-argument call.
5. **Accepted**: the literal `stale-guard` in both files.
6. **Accepted**: the pair is one criterion; `FREEZE_GATE_CMD=''`; temp tree only, never `ROOT`.
7. **Accepted**: `killed` stays at the `verdictFor` level.

#### Task 4 — testability

```json
{
  "advisor": "testability",
  "verdict": "concerns",
  "summary": "Criterion 2's source-text read passes an implementation whose exit code never takes effect and fails an ordinary refactor, criterion 7 contains a PR-body obligation no frozen test can see and a count floor a padded suite satisfies, and criterion 6's byte-identical fixture is stale the moment task 1 merges ahead of it.",
  "details": [
    "Criterion 2's source read passes process.exitCode assigned inside a branch that never runs, or assigned then overwritten, or queueOutcome called and discarded; and it fails a legitimate refactor. Export the closing block from run.js and drive it through the pause-gate fixture pattern with a fake source, asserting the manifest's queue block and process.exitCode for the four count pairs. Keep at most one structural check — no process.exit( after the drain — labelled a guard.",
    "Criterion 7's 'named in the PR body as a post-merge obligation' is not machine-checkable. Restate as a tracked artifact the test can open, or drop it.",
    "Criterion 7's count floors are overfitted: six check('x', true) lines satisfy them. Keep the discriminating checks load-bearing and add the mirror: the fork-point G7 literal strings appear nowhere in dispatch-gate.test.js as expected values.",
    "Criterion 6's byte-identical fixture goes stale by construction once task 1 rewrites the undispatchable heading. Pin the fixture to a manifest holding only done/failed/stuck rows and prove the frozen test green against the post-task-1 tree before freezing.",
    "Criterion 1's exit number lives only in a disposition; carry the literal 4 into the criterion. Drop the arity check.",
    "Criterion 4's pinned strings use <label> placeholders while the label map is fixed only in a disposition; write the literal strings and the kind order into the criterion, and say the fixtures use refusal.",
    "Criterion 5's historic-line case passes the current implementation and is a guard — label it."
  ]
}
```

Dispositions (task 4 revised spec, step 5):
1. **Accepted**: the closing block becomes an exported `finishRun({ drained, source, cfg, log, startedAt })` in `runner/run.js` that writes the manifest and sets `process.exitCode`; the frozen test drives it with a fake source for the four count pairs. One structural guard remains.
2. **Accepted**: the host obligation is a tracked line in `docs/STATUS.md`'s host-obligations list, which the test greps; the PR-body sentence is a review note.
3. **Accepted**: floors are not load-bearing; the mirror check (old literals absent as expected values) is added.
4. **Accepted**: the fixture manifest holds `done`/`failed`/`stuck` rows only — and, more generally, **task 4's tests are written and frozen in the session before the run that executes it**, against the tree 1b has merged into (see the run plan in step 5).
5. **Accepted**: exit **4** is in the criterion; the arity check is dropped.
6. **Accepted**: the literal labels and the fixed order are in the criterion; fixtures use `refusal`.
7. **Accepted**: labelled `[guard]`.

#### Task 5 — testability

```json
{
  "advisor": "testability",
  "verdict": "concerns",
  "summary": "Criterion 3's monkey-patch check fails a correct implementation that destructures the import, criterion 3 contradicts task 3 on whether the colon-form lines are names, and criterion 4's harness copies a stub with no stand-aside guard; the rest can be frozen with small pins.",
  "details": [
    "The monkey-patch only works if failure-class.js calls through the module object at call time; the house style destructures at load, so the check fails a correct implementation. Make the seam explicit — failureClassFor(input, { failingChecks }) with the default bound — and assert an injected canned function changes the answer.",
    "Criterion 3 vs task 3 on the colon form: decide once before either freeze, and make task 3's fixture include a FAIL: path line with the agreed answer. With file paths as names, two attempts failing different inner checks in the same file share a name — it weakens identical-failures toward false positives.",
    "Criterion 4 copies pause-gate's parkedTask, whose bd stub is preloaded via NODE_OPTIONS with NO stand-aside guard; the exec stubs that run node to write status.json will be killed before writing anything — the repo-8v0 trap. The frozen test must give the stub a stand-aside guard keyed on argv structure, and the spec should say so.",
    "The exec stub is a shell script on purpose (executeTask spawns bash explicitly); say so, and say the stub writes feedback on all three attempts, which matches entrypoint.sh, so the last-two rule is not vacuous in production.",
    "The if/then assertion restates a schema-authoring choice. Validate behaviourally with the inline validator: non-done without the field rejects; non-done with it accepts; done without it accepts; done WITH it — undecided, decide.",
    "scripts/test-report.sh validates a synthetic manifest with ajv whose stuck/failed rows carry no failureClass; it goes red once if/then lands. Add it to the suites that must move.",
    "Criterion 1's attempts parameter is the status file's ARRAY while the row's attempts is a count; name it.",
    "Criterion 5's 'nothing else in the body changes' is not checkable; pin the full rendered section for the done row and the old-style row against a literal capture.",
    "Against the current implementation unchanged, no criterion passes vacuously; the guard-style checks correctly do."
  ]
}
```

Dispositions (task 5 revised spec, step 5):
1. **Accepted**: `failureClassFor(input, deps = { failingChecks })`, default bound from `sweep-assertions.js`; the discriminator injects a canned function.
2. **Resolved** as task 3's disposition: colon lines are names, file paths included; 3b's fixture carries a `FAIL: <path>` line. On the false-positive worry: the inner failing lines are in the set too, so two attempts failing *different* inner checks in one file still differ as sets; only a runner printing *nothing but* file-level lines would collapse them, and that runner classifies `unclassified` anyway when its inner lines are absent — no, it would classify `identical-failures` on the file names alone, which is the honest reading of "the same file failed twice with no finer information". Accepted as stated.
3. **Accepted**: the preload stub carries a stand-aside guard keyed on argv structure as its first statement; the criterion says so.
4. **Accepted**: stated — the exec stub is a bash script on purpose and writes `feedback` on every failed attempt.
5. **Accepted**: behavioural validation through the inline validator; a `done` row **with** the field is rejected (the schema forbids it), so the rule is total.
6. **Accepted**: `scripts/test-report.sh`'s synthetic manifest is in the list of suites that move.
7. **Accepted**: the parameter is `statusAttempts`.
8. **Accepted**: literal captures for the two unclassed rows' full sections.
9. Noted.

## Step 5 — what needs Chad's yes

The panel split two tasks, so the batch is **seven** tasks over **three runs**. Every
criterion below has already absorbed the dispositions above; where a drafter's criterion
was dropped or moved, the disposition says so. The design-doc amendments each task cites
are written in this session (`DESIGN.md` §3.2, §4.11, §4.12; change-log rows
`receipt-design`, `stale-guard-design`, `events-ledger-design`, `failure-class-design`)
so no task amends the section it is measured against.

### The run plan

| Run | Tasks | Tests written | Notes |
|---|---|---|---|
| 1 | 1a receipt-writer · 2 guard-red · 3a ledger-writer | tonight, frozen with probes | independent of each other |
| — | *migration* | — | after run 1 merges: re-run the gate on run 2's suites so they carry receipts, push; any other target's open suites are re-gated before that target's next run (tracked in `docs/STATUS.md`) |
| 2 | 1b receipt-enforce · 3b ledger-facts | in the session before run 2, against run 1's merged tree | 1b ⇐ 1a; 3b ⇐ 3a |
| 3 | 4 refused-exit · 5 failure-class | in the session before run 3 | 4 ⇐ 1b; 5 ⇐ 1b, 3b |

Writing run 2's and run 3's tests later is not deferral: the playbook already says suites
frozen weeks before the run that executes them go stale, and two critics found fixtures in
tasks 4 and 5 that would be stale by construction if frozen tonight.

### 1a — receipt-writer (`medium`, no dependencies)

**Description.** `scripts/freeze-gate.js` writes `tests/acceptance/<issue-id>/.freeze-gate.json`
when — and only when — it reaches a verdict that proceeds (`red`, exit 0; `half-proven`,
exit 4). The receipt records the gate version, the verdict, whether a probe was supplied, a
content hash of the suite, the planning checkout's HEAD when the gate ran, the guard count,
the brittleness-lint count, and a timestamp. The hash is over **git blob ids** — what git
will store, after its clean filter — never raw working-copy bytes, because the planning
checkout is CRLF and the committed blob is LF. The receipt lives inside `tests/acceptance/`,
so the verifier already diffs it against the fork point: editing it in a container is
`tampered` with no new rule. Nothing reads the receipt yet; 1b does.

**Constraints.** Written only by the gate, only into the `--tests` directory of the fork-point
tree (never the probe), only on a proceeding verdict; the other verdicts leave any existing
receipt byte-identical. The hash formula is one exported function in a new host-only
module, `runner/suite-hash.js` (node built-ins only), so 1b cannot drift from it. A `--repo`
that is not a git repository is refused at exit 2 before any run. A receipt write that
fails is exit 2 with a stderr line naming the path. **design-ref:** DESIGN.md §3.2, *The
receipt* (written this session).

**Done means.**
1. After the gate exits 0 or 4, the receipt exists and parses to an object with exactly these keys: `gateVersion` (`1`), `verdict` (`"red"` | `"half-proven"`, equal to the printed verdict), `probeSupplied` (boolean, true iff `--green` was given), `suiteHash` (64 lowercase hex), `gateHead` (40-hex `git rev-parse HEAD` of `--repo`, `null` on an unborn HEAD), `guards` (integer when `--spec` was given, else `null`), `brittleness` (integer, or `null` when the lint said `unavailable`), `writtenAt` (ISO-8601). Exits 1, 2 and 3 write nothing and leave a sentinel receipt byte-identical. A non-git `--repo` exits 2 with no runs. A receipt write into a read-only directory exits 2 and stderr names the path.
2. `suiteHash` equals `require('runner/suite-hash.js').suiteHash(entries)` where entries are `{path, blob}` for every file `git ls-files --cached --others --exclude-standard -- <suite>` lists from `--repo` except `.freeze-gate.json`, `path` suite-relative with `/` separators, `blob` from `git hash-object --path <repo-root-relative> <file>` run with cwd = `--repo`, entries sorted bytewise by path, digest sha256 over `path\0blob\n` concatenated — taken **before** the suite is run. Proven by: the test recomputes it independently; two consecutive runs agree (the first receipt is present during the second); one appended byte changes it; **the CRLF pair** — a fixture with `core.autocrlf=true` written into its own `.git/config`, a `\r\n` test file committed with no per-call override, the committed blob asserted `\r`-free, `GIT_CONFIG_GLOBAL` pointed at an empty file — the receipt's hash equals the hash from the commit's `ls-tree` blob ids (raw-byte hashing differs and fails); a suite holding one ignored file and one test that writes a file beside itself when run still yields a receipt matching the pushed branch; and `scripts/freeze-gate.js` requires `runner/suite-hash.js`.
3. With `--green`, the probe's copy of the suite has no receipt after the run and its digest is unchanged; `compareSuites` no longer reports the receipt as `absent` in a probe that lacks it (exit 0, not 2).
4. `PLANNING.md` step 6 and `ONBOARDING.md` each contain the literal `.freeze-gate.json`; `DESIGN.md` §3.2 contains a paragraph with it [guard — written this session]; a change-log row exists; `test-changelog.sh` and `test-sanitize.sh` exit 0. The fixture builder sets a git identity and `commit.gpgsign=false`, and the fixture commit's existence is its own check.

### 1b — receipt-enforce (`hard`, depends on 1a)

**Description.** `runner/queue.js`'s dispatch gate reads the integration branch through the
same throwaway fetch it already does and refuses, with a distinct reason each, a candidate
whose suite is absent (as today), whose suite has no receipt, whose receipt's hash does not
match the suite as it is on the branch, or whose receipt says `half-proven` while the run
config's `allowHalfProven` is not `true`. The refusal kind travels on the manifest row, into
the feed's live refusal map, and into the report's heading, body and remedy. Nothing here
writes to Beads. This is the third admission rule of §4.12.

**Constraints.** Every git call added goes through the bounded `git()` helper; the hash is
computed by `runner/suite-hash.js` from `git ls-tree -r FETCH_HEAD` with the suite prefix
stripped, never from the working copy. A receipt that is unparseable, lacks `suiteHash` or
`verdict`, has a `verdict` other than `red`/`half-proven`, or a `gateVersion` the runner does
not know is `no-receipt`. Check order per candidate: suite → receipt → hash → verdict; the
first refusal wins. `allowHalfProven` defaults to `false`, is validated like every other
knob, and its effective value is written to the manifest. **design-ref:** DESIGN.md §4.12,
*the third admission rule* (written this session).

**Done means.**
1. On the integration branch of `targetRepoRemote`: (a) suite absent → reason contains `no frozen acceptance suite`, `refusal: "no-suite"`; (b) suite, no receipt → `no freeze receipt`, `no-receipt`; (c) receipt whose hash differs from the branch's blobs → `receipt does not match`, `receipt-mismatch`; (d) `verdict: "half-proven"` with `allowHalfProven` not true → `half-proven`, `half-proven`; (e) a matching `red` receipt → dispatched. No `update|note|close` verb reaches the `bd` seam. Receipts in fixtures are produced by `runner/suite-hash.js`, and both `scripts/freeze-gate.js` and `runner/queue.js` require it. **The branch-not-working-copy pair:** (f) working copy carries an uncommitted edit while the pushed branch holds the matching receipt → dispatched; (g) working copy pristine while the pushed branch has one extra byte → `receipt-mismatch`. Unknown `verdict`, unknown `gateVersion`, and truncated JSON → `no-receipt`. Every `child_process` use in `runner/queue.js` and `runner/suite-hash.js` is built from `gitSpawnOptions` [guard].
2. `loadConfig` rejects a non-boolean `allowHalfProven` by name; absent loads as `false`; `run.config.example.json` carries `"allowHalfProven": false`; with `true`, only fixture (d) moves to dispatched; the manifest carries top-level `allowHalfProven` and `schemas/run.schema.json` declares it as `boolean`; `writeManifest`'s call in `run.js` passes `cfg.allowHalfProven` (structural — `main()` is behind the preflight).
3. `undispatchableRow(issue, reason, runId, refusal)` returns a row with `refusal`; the schema declares `tasks.items.properties.refusal` with the four-value enum; every row key is declared; `runner/feed.js` carries `refusal` through its refusal map for initial and re-polled refusals alike.
4. For an `undispatchable` row the report heading is `## <id> — UNDISPATCHABLE — <phrase>` with a distinct phrase per kind; the remedy is keyed by kind in the heading, the body paragraph, and `undispatchableRow`'s `changeSummary` and `attemptNotes`: `freeze` for `no-suite`; `run the freeze gate` for `no-receipt` and `receipt-mismatch`; `--green` or `allowHalfProven` for `half-proven` — with one negative assertion per kind (the `no-suite` texts contain no `freeze gate`; the `no-receipt` texts contain no `--green`/`allowHalfProven`; and so on). A row with no `refusal` renders the historic sentence. `done` rows gain nothing [guard]; scrutiny rank `0.5` unchanged [guard].
5. `DESIGN.md` §4.12 contains one paragraph holding both the literal `third admission rule` and `.freeze-gate.json` [guard — written this session]; `PLANNING.md` step 8 names the receipt in its pre-run checklist; `docs/STATUS.md`'s host-obligations list contains the re-gating line; a change-log row exists; the four Docker-free suites this touches exit 0.

### 2 — guard-red (`medium`, no dependencies)

**Description.** A test file that declares itself a guard (the literal `[guard]` token, any
case, on a comment line within its first ten lines) is run alone against the fork point
and must be green there; red is a new verdict, `stale-guard`, exit 5, never a pass, and the
report names every guard file in the subset. The subset runs only when the fork point is
red-at-exit-1 on a green control, once, in the fork-point tree, reusing that tree's control.
A stale guard beats `half-proven`, `red` and `unreachable` and short-circuits the probe.

**Constraints.** Only top-level files in the suite within `LINT_EXTENSIONS`, with the lint's
NUL sniff, are scanned; a comment line's first non-whitespace is `//`, `#`, `/*`, `*` or `--`.
The subset directory is `<parent of --tests>/.freeze-gate-guards-<pid>-<seq>/`, created by a
`withGuardDir` mirror of `withEmptyControlDir` and removed afterwards, handed to the runner
as a repo-relative POSIX path. `verdictFor` takes a sixth positional argument defaulting to
`null`; guard `null` and guard `ok(0)` are identical to the five-argument call, so the frozen
`repo-inj` suite keeps its meaning. Exit codes 0–4 keep their exact meanings. Exit 5 is
reachable from exactly one `verdictFor` row and from no refusal path. A guard subset that
exits above 1 or fails to spawn is `indeterminate` (2) naming the guard side; `killed` is
covered at the `verdictFor` level only. This task's own frozen suite keeps the token out of
its first ten comment lines. **design-ref:** DESIGN.md §3.2, the gate's table (the
`stale-guard` row, written this session).

**Done means.**
1. The exported scanner over a nine-file fixture (`a.js` token on line 2; `b.sh` `[GUARD]` on line 10; `c.js` token on line 11; `d.js` token in a string; `README.md`; `e.png`; `f.js` with a NUL; `nested/g.js`; `h.js`) returns exactly `['a.js','b.sh']`, and `[]` — not a throw — with those two removed.
2. Over the enumerated sweep of `verdictFor(real, control, kind, probe, probeControl, guard)`: `(1,0,·,null,null,1)`, `(1,0,·,0,0,1)`, `(1,0,·,1,0,1)` → `stale-guard`/5; `(0,0,…,1)` → `green`/1; `(1,1,…,1)`, `(2,0,…,1)` → `indeterminate`/2; guard at status 2, null, signalled or errored behind `(1,0)` → `indeterminate`/2 with `/guard/i` in the headline; the seven existing rows identical with guard `null` and with guard `ok(0)`, and identical to the five-argument call; within the sweep every `exit === 5` has `verdict === 'stale-guard'` and vice versa; `verdictFor(ok(5), ok(0))` is still `indeterminate`.
3. Through the CLI, with a stub whose protocol is: control → 0; probe tree → 0; a directory matching `.freeze-gate-guards-` → 0 unless `STUB_MODE` is `guard-red` (1) or `guard-broken` (3, after writing `injected guard failure` to stderr); else 1 — a suite of one guard file and one ordinary file is three spawns without a probe and five with one; exactly one spawn's `arg` matches the subset name, its listing is `['guard.js']`, its digest equals the fork-point file's, its `arg` starts `tests/acceptance/` (sibling, same depth, relative, POSIX), and the marker *named from that arg* landed in the repo tree, not the probe; afterwards no `.freeze-gate-guards-*` remains in either tree; with the guard file removed the counts return to two and four.
4. `guard-red` without `--green` → 5, `/^STALE-GUARD:/m`, `/guard run\s+exit\s+1/`, `guard.js` named, and the subset's stderr tail (`guard assertion failed`) printed; `guard-red` **with** `--green` → 5 and **three** spawns (the probe is short-circuited); default without `--green` → 4 with `/guard run\s+exit\s+0/`; default with → 0; `probe-red` with a green guard → 3. Every run prints `/^guard files:\s*1\b/m`; a suite with no guard file prints `guard files: 0` and no `guard run` line.
5. `always-green` → 1, two spawns, `/guard run\s+not run/`; `always-red` → 2, two spawns; suite-only exit 2 → 2, two spawns; none contain `STALE-GUARD`; a missing test directory → 2 and no arguments → 2 with a guard file present.
6. `guard-broken` → 2, `/^INDETERMINATE:/m`, `/guard/i` in the headline, `injected guard failure` present; a `FREEZE_GATE_CMD` naming a command that does not exist behind a red-on-green fork point → 2 naming the guard side.
7. With the real runner (`FREEZE_GATE_CMD=''`), in a temp repo-shaped tree — never `ROOT` — carrying a copy of the acceptance runner, a `_control`, and `demo/{plain.js exits 1, guard.js}` where `guard.js` exits 0 only if `path.resolve(__dirname,'..','..','..','pipeline.config.json')` exists → exit 4; then `guard.js` rewritten to exit 1 under the same header → exit 5 with `guard.js` in stdout. One criterion, never frozen as halves.
8. `DESIGN.md` has `stale-guard` within 2000 characters after `The gate's table, as it now stands` [guard — written this session]; `PLANNING.md` step 4 has `exit 5 — stale-guard` followed within 500 characters by `never a pass`; the literal `stale-guard` appears in `docs/pipeline-diagram.md` and `docs/change-log.md`; `bash scripts/test-planning-playbook.sh` fails through `PLAYBOOK_FILE` on a copy with the stanza removed and passes on the real file; `tests/unit/freeze-gate.test.js`'s exit-code sweep reaches six codes and `scripts/test-freeze-gate.sh`'s floor is raised to the fork-point actual.

### 3a — ledger-writer (`hard`, no dependencies)

**Description.** `runner/log.js` gains a structured channel: the one function that appends a
`run.log` line also appends one JSON object to `runs/<runId>/events.jsonl`, with one
timestamp for both. Every object carries `ts`, `level`, `runId`, `issueId`, `trace`, `event`,
`msg`, and per-event fields under `data`. Every line the dashboard's `P` table parses today
becomes a named event with typed fields; every other line is `event: "log"`. Ledger-only
events (`msg: null`) are possible but this task emits none; 3b does. `schemas/events.schema.json`
describes the envelope and every named event. `run.log` is unchanged byte for byte. The
container writes nothing.

**Constraints.** `info(traceId, msg, ev?)` and `error(traceId, msg, ev?)` gain an optional
third argument `{event, data}`; absent → `event: "log"`. `event(traceId, name, data)` exists
for ledger-only facts, is not echoed to the console, and carries `level: "INFO"`. `issueId`
is the trace's tail after `<runId>/`, `null` for `preflight` and `feed`; a null trace gives
`trace: null, issueId: null`. Append semantics per event; no buffering, no rewriting. The
only reader edit is `scripts/dashboard.js` gaining `module.exports.P`. Nothing under
`pipeline/` references the ledger. **design-ref:** DESIGN.md §4.12, run artifacts (the
`events.jsonl` sentence, written this session) and §5.

**Done means.**
1. After a Docker-free fixture run (`startRun` at a temp root; `runOneTask` driven through the pause-gate pattern — a `PIPELINE_BD_CMD` stub with a stand-aside guard, a bare-remote seed, a bash `PIPELINE_EXEC_STUB` writing `status.json` and `verify.json`, a `PIPELINE_GH_CMD` stub), `events.jsonl` exists beside `run.log`; the count of events whose `msg` is a string equals the `run.log` line count; for every index *i* the *i*-th such event's `ts`, `level`, `msg` and `trace` equal the *i*-th line's — `ts` included, which fails a second clock or a second call site.
2. Every line parses to an object with exactly `ts`, `level` (`INFO`|`ERROR`), `runId`, `issueId` (string|null), `trace` (string|null), `event`, `msg` (string|null), `data` (object); `schemas/events.schema.json` lists those as `required`, `additionalProperties: false` on the envelope, enumerates every `event` name the writer emits, and declares each named event's `data` fields with types; an inline validator (required/enum/additionalProperties, no dependencies) accepts every fixture line and rejects a planted line missing `ts`, a planted `"bogus"` event, and a planted extra envelope key.
3. The named events and their `data` — `run.target {url}`, `lock.held {path}`, `lock.tookOver {path}`, `queue.read` *(reserved; emitted by 3b)*, `task.started {priority: integer, title: string}`, `workspace.ready {dir, branch, forkPoint}`, `container.launched {name, budgetMinutes: integer}`, `container.ran {seconds: integer, killed: boolean, activeSeconds: integer}`, `task.rateLimited {pause: integer}`, `park.opened {cycles: integer, max: integer}`, `park.reopened {}`, `park.waiting {until: string}`, `task.finished {exitCode: integer|"killed", outcome: string, beads: string|null}`, `run.finished {dir}`, `task.refused {}` (the rate-limit cap), `task.relaunched {}`, `feed.on {}`, `feed.pickedUp {added: integer}`, `feed.closed {polls: integer, ending: string}` — each, where the fixture reaches it (`task.started`, `workspace.ready`, `task.rateLimited`, `task.relaunched`, `task.finished`, `task.refused`, `park.*` via an injected wait), has the event name AND `msg.startsWith(P.<key>)` with `P` required from `scripts/dashboard.js`, AND its `data` values asserted against the fixture's known values; the rest are pinned by prefix only.
4. Fifty `info` calls → fifty parseable lines, no `\r`, one trailing `\n`, file size read after 25 and after 50 only grows; truncating at the midpoint of line 30's byte range leaves every line before the last newline parseable.
5. The fixture run's `run.log`, every line, with the temp root substituted in both separator forms and `[0-9a-f]{8}` after `fork point ` masked, equals a literal expectation in the suite, line count included; `git diff <merge-base integration HEAD>..HEAD -- runner/` (the fork computed inline as the verifier does) removes no line containing `log.info(` or `log.error(`; `tests/unit/{dashboard,batch,audit-runs}.test.js` are byte-identical to the fork point; and `scripts/test-events.sh` runs the seven reader suites with `NODE_OPTIONS` and every `PIPELINE_*` variable removed from the child environment and asserts each exits 0.
6. `grep -rl "events.jsonl\|runner/log" pipeline/` is empty; `runOneTask` driven with the existing fake log object still completes.
7. `DESIGN.md`'s run-artifacts paragraph names `events.jsonl` [guard — written this session]; a change-log row; `docs/pipeline-diagram.md` names the file; `CLAUDE.md`'s suite block lists `bash scripts/test-events.sh`, which exists, wraps `tests/unit/events.test.js`, and is swept.

### 3b — ledger-facts (`hard`, depends on 3a)

**Description.** The three facts no reader can get today enter the ledger: the queue read
with every refusal and its reason, each attempt's verifier result and failing check names,
and each spec concern. Failing check names come from a new export in
`scripts/sweep-assertions.js`, the one file that owns the assertion-line vocabulary.

**Constraints.** `failingChecks(logText) → string[]`, sorted and de-duplicated, built from the
same `NODE_FAIL`/`SHELL_FAIL` constants `countAssertions` uses plus one new colon-form
constant (`FAIL: <text>`) used by `failingChecks` only; the name is the text after the
matched prefix, trimmed; a file-level `FAIL: <path>` line is a name like any other.
`countAssertions` and `cell` are byte-identical on every existing fixture. `queue.read` and
`task.undispatched` are emitted by exported helpers in `runner/queue.js` that take a log
object, which `main()` calls. `attempt.finished` and `concern.raised` are emitted once per
task after the relaunch loop, from the collected status file. **design-ref:** DESIGN.md §4.12
run artifacts and §5.

**Done means.**
1. `failingChecks` on `"ok - a\nFAIL - b broke\r\n  FAIL - decoy\nnot ok 3 - c\nFAIL\tshell style\nFAIL: tests/acceptance/x/t.js\nFAIL: colon\nFAIL - b broke\nPASS d\n"` returns exactly `['b broke','colon','shell style','tests/acceptance/x/t.js']`; every pre-existing `countAssertions` fixture's `{count, failed, vocabulary}` is unchanged; `scripts/test-sweep-assertions.sh` exits 0.
2. `logQueueRead(log, q)` emits `queue.read` with `data: {ready: [id], skipped: [{id, type}], refused: [{id, reason, refusal?}]}` — ids only, never issue objects; `logUndispatched(log, u)` emits `task.undispatched {id, reason, refusal?}` paired with the existing `not dispatched:` ERROR line; `main()` in `run.js` calls both (structural guard).
3. For a task whose collected status has attempts `[fail, fail, pass]`, exactly three `attempt.finished {issueId, number, verifierResult, failingChecks}` in order, `failingChecks` from that attempt's `feedback` (`[]` when text is present with nothing failing; `null` when no text exists); a relaunch fixture that collects the status twice still yields one per attempt number.
4. Exactly one `concern.raised {text}` per `specConcerns` entry, verbatim, after the loop.
5. `schemas/events.schema.json` enumerates the four events and their `data`; the validator rejects a `queue.read` whose `ready` holds objects.
6. A change-log row; `docs/pipeline-diagram.md` and the schema's description name the three facts.

### 4 — refused-exit (`medium`, depends on 1b)

**Description.** A run whose ready queue was non-empty and which dispatched nothing exits
**4**; a genuinely empty queue stays 0. The queue-summary line leads with the dispatchable
count and names refusals by kind; the manifest records `queue: {ready, dispatched, refused}`;
the report prints the counts. Refusal kinds are 1b's.

**Constraints.** The decision is `queueOutcome(dispatched, refused)` in `runner/queue.js`,
pure; `run.js`'s closing block becomes an exported `finishRun(...)` that writes the manifest
and sets `process.exitCode` — never `process.exit()` — so teardown and the lock's exit
handler still run. `dispatched` counts every issue the source handed out. The id slot of the
summary line (after the first ` — `, up to the first `;`) is unchanged so `readyQueueIds`
and logs on disk keep parsing. The label map is fixed: `no-suite`→`no frozen suite`,
`no-receipt`→`no freeze receipt`, `receipt-mismatch`→`suite changed since the gate`,
`half-proven`→`half-proven only`, in that order; an unknown or absent kind renders as its
own string or `refused`. **design-ref:** DESIGN.md §4.12, *the run's exit codes* (written
this session).

**Done means.**
1. `queueOutcome` returns `{queue: {ready, dispatched, refused}, exitCode}` with `ready = dispatched + refused`, exit 4 exactly when `ready > 0 && dispatched === 0`, else 0: `(0,0)→0`, `(3,0)→0`, `(0,8)→4`, `(2,6)→0`; pure across two calls.
2. `finishRun` driven with a fake source for the four pairs writes `run.json` with the matching `queue` block and leaves `process.exitCode` at the matching value; no `process.exit(` occurs in `run.js` after the drain [guard].
3. `schemas/run.schema.json` declares optional top-level `queue` with exactly those three required non-negative integers, `additionalProperties: false`; both directions of the key check pass; top-level `additionalProperties` stays false.
4. `queueSummary` returns, exactly: `ready queue: 0 of 0 dispatchable — (empty)`; `ready queue: 2 of 2 dispatchable — x-one, x-two; skipped 1 by type: e-one (epic); running 1 non-task: x-two (bug)`; for eight refusals (5 `no-suite`, 3 `no-receipt`) and nothing dispatchable: `ready queue: 0 of 8 dispatchable — (empty); refused 8: 5 no frozen suite, 3 no freeze receipt — r-1 (no frozen suite), …, r-8 (no freeze receipt)` in input order; one refusal `refusal: 'weird'` and one with none → `refused 2: 1 weird, 1 refused — …`; `task(s)` appears in none. The fork-point G7 literals appear nowhere in the suite as expected values.
5. `readyQueueIds` over the live `queueSummary` output for two dispatchable, one epic and two refusals equals `['x-one','x-two']`; over the wholly-refused line, `[]`; refused ids never appear before the first `;`; over the literal historic `ready queue: 3 task(s) — …` line, three ids [guard].
6. `renderReport` prints `**Queue:** 0 of 8 dispatchable, 8 refused` directly after the `**N task(s)**` line when `manifest.queue` is present, before `Spec concerns`, never as `## `; a manifest of `done`/`failed`/`stuck` rows only, without `queue`, renders byte-identical to a literal capture.
7. `scripts/test-runner-queue.sh` has zero matches of `ready queue: [0-9]* task` and at least five of `ready queue: `; the `-ge` floors in `scripts/test-dispatch-gate.sh` and `scripts/test-dashboard.sh` read at least the fork-point actuals; `docs/STATUS.md`'s host-obligations list names the Docker suite's host run; a change-log row; `DESIGN.md`, `docs/STATUS.md` and the dispatch-gate row say five grep sites, not six.

### 5 — failure-class (`medium`, depends on 1b and 3b)

**Description.** Every manifest row whose outcome is not `done` carries `failureClass`,
decided by a new pure module from artifacts already in hand. The report renders it in the
heading. Nothing consults it; the audit tables are batch two.

**Constraints.** `runner/failure-class.js` exports `CLASSES` and
`failureClassFor({outcome, exitCode, refusal, verify, statusAttempts}, deps = {failingChecks})`
— no spawn, no disk; `failingChecks` is the default bound from `sweep-assertions.js` and
injectable. Precedence: `done` → null; `undispatchable` → its `refusal` kind or
`unclassified`; `tampered`/`paused`/`partial` → `tampered`/`paused`/`regressions`;
`verify.acceptance === 'error'` or last attempt `verifierResult === 'error'` → `suite-error`;
`failed` → `timeout` when `exitCode === 'killed'` else `internal`; `stuck` → the last two
attempts' failing sets both non-empty and equal → `identical-failures`, both non-empty and
different → `attempts-exhausted`, else `unclassified`; anything else → `unclassified`.
The schema makes the field required on every non-`done` row and **forbidden** on a `done`
row. **design-ref:** DESIGN.md §4.11, the outcome table's *Failure class* column (written
this session).

**Done means.**
1. `CLASSES` equals `['no-suite','no-receipt','receipt-mismatch','half-proven','suite-error','regressions','identical-failures','attempts-exhausted','timeout','internal','tampered','paused','unclassified']`; three `failed` rows differing only in artifacts classify `suite-error`, `internal`, `timeout`; `undispatchable` with each kind → that kind, with a missing or unknown kind → `unclassified`; `partial`, `tampered`, `paused` map; `done` → `null`; `'banana'` → `unclassified`; the module's source has no `spawn`, `exec`, `readFileSync` or `child_process`, no regex literal beginning `/^FAIL` or `/^ok`, and requires `sweep-assertions`.
2. On `stuck`: (i) three attempts with the same two failing lines, different timestamps, `ok` counts, byte lengths, swapped order and one duplicate → `identical-failures`; (ii) attempts 1 and 3 equal with 2 different → `attempts-exhausted`, and 1 different with 2 and 3 equal → `identical-failures`; (iii) only `ok` lines plus `not ok 3 - x` and `Error: boom` → `unclassified`; (iv) no `feedback` key, and a single attempt → `unclassified`; (v) `FAIL\tx` then `FAIL - x` → `identical-failures`. Injecting a canned `failingChecks` through `deps` changes the answer. `outcomeFor` and `OUTCOMES` are unchanged; `failureClassFor` is referenced nowhere under `pipeline/`.
3. `runOneTask` driven through the pause-gate pattern — the preload `bd` stub carrying a stand-aside guard keyed on argv structure as its first statement, and a **bash** exec stub (on purpose: `executeTask` spawns bash) that writes `feedback` on every failed attempt as the entrypoint does — yields `stuck`/`identical-failures`, `stuck`/`attempts-exhausted`, and a `done` row with no `failureClass` key; `undispatchableRow` with each refusal → that class.
4. The schema's enum equals `CLASSES`; the inline validator rejects a non-`done` row without the field, accepts one with it, accepts a `done` row without it, and **rejects a `done` row with it**; every produced row's keys are declared.
5. For every classed row the heading is `## <id> — <LABEL> · failure class: <class>`; the `done` row's and an old-style `stuck` row's full rendered sections equal literal captures; `test-report.sh`'s `grep -o '^## [a-z0-9-]*'` ordering is unchanged; rendering twice is byte-identical.
6. `DESIGN.md` §4.11's table has the *Failure class* column [guard — written this session]; a change-log row; `docs/pipeline-diagram.md`'s outcome table has it; `scripts/test-failure-class.sh` exists, wraps `tests/unit/failure-class.test.js`, is listed in `CLAUDE.md`; `scripts/test-report.sh`'s synthetic manifest carries classes on its non-`done` rows; `test-changelog.sh` and `test-sanitize.sh` exit 0.

### What Chad is approving

The seven "Done means" lists above, the labels, and the run plan — including the
migration step between runs 1 and 2. Decision already recorded: `allowHalfProven` defaults
to `false`.
