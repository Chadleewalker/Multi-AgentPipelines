# Planning draft — 2026-08-12 — the sweep-trustworthy batch

**Status: DRAFT — awaiting critic dispositions, freeze-gate results, and user approval.
Nothing here is frozen and nothing runs until the user approves.** Superseded by the Beads
issues at freeze (PLANNING.md step 5); disposable once the tasks have run.

Source of intent: `docs/handoff-sweep-trustworthy.md` (approved 2026-08-12), declared as
change-log rows `sweep-trustworthy`, `self-regression`, and `batch-sibling-partials`.
Criteria below were drafted in fresh context against the code (PLANNING.md step 1b), by
four independent readers; the reconciliation decisions that merged them are recorded in
each spec's "Settled in reconciliation" block so they are visible to the critics.

Batch shape: four tasks. A and D share one additive evidence contract (the per-suite
regression sidecar) and are co-designed; B and C share the `isHolderLive` export, which
both state idempotently so neither ordering breaks either freeze. No Beads dependencies:
every task is self-sufficient on a branch forked from today's `main`. Recommended merge
order: B before C (exclusivity establishes the guarantee C's reclamation reasons from).

---

## Task A — declare this repo's `regressionCommand`

**Difficulty label (proposal): trivial.** The verifier side is fully built and tested; the
deliverable is a ~40-line POSIX wrapper, one JSON key, and tests in an established house
pattern. (Per PLANNING.md there is no zero-critic tier: this spec still gets a
testability pass.)

**design-ref:** change-log row `self-regression`; DESIGN.md §3.4, §4.4.

**Description.** This repo is a target of its own pipeline but declares no
`regressionCommand`, so nothing ever re-runs a frozen directory's extracted coverage and a
restructure can invalidate 50+ frozen assertions silently. Add `scripts/regression.sh` — a
POSIX-sh, Docker-free wrapper that runs the fifteen Docker-free unit suites and fails if
any fails — and declare it in `pipeline.config.json` as
`"regressionCommand": "sh scripts/regression.sh"`. The verifier then runs it from the fork
point on every attempt as recorded evidence; an acceptance-passing task that breaks one
lands `partial` instead of `done`. The wrapper is also the first writer of the per-suite
regression sidecar (`.run/regressions.json`) that Task D's report classification consumes.

**Settled in reconciliation** (so critics see the reasoning, not just the answer):
- **Enumerate the fifteen explicitly; never discover.** 21 of the 36 sweep suites are
  Docker-bound. A missed future sixteenth suite fails narrowly and silently (the status
  quo); a wrongly-discovered Docker suite dies in every container and turns every task
  `partial` — the sweep-distrust disease relocated into the verifier. CLAUDE.md's
  in-container list is the existing mitigation and gains "and `scripts/regression.sh`".
- **The wrapper does not join `frozenPaths`.** It is evidence, never a gate; the suites it
  runs stay mutable regardless; the declared command string is already fork-point-pinned;
  and the stated scope is growing the list, which a freeze would push interactive-only.
  A neutered wrapper is visible in the PR diff and in `regressionOutput`.
- **No per-suite timeout in the wrapper.** Suites run 0.2–10.5s; the verifier's 15-minute
  cap bounds a hang and classifies it `error`, never `fail` (change-log row
  `verify-nobuffer`).
- **Sidecar format pinned identically here and in Task D** (inline in both frozen suites;
  neither requires the other's files): `{"suites":[{"path":"<what the harness ran>",
  "verdict":"pass"|"fail"}, ...]}` — the complete list of what the harness ran, written to
  `./.run/regressions.json` only when `./.run/` already exists (it does in a workspace;
  it does not on a bare host checkout). A sidecar write failure never changes the
  wrapper's exit code — evidence, not a gate.
- Measured on the reference host: the fifteen take ~33s and ~44 KB total, need no token,
  no Docker, no network, and leave `git status` clean. The binding output constraint is
  the 2,000-character `regressionOutput` tail, not the 64 MiB capture cap — hence the
  summary-last contract below.

**Constraints.**
- Must not touch `pipeline/verify.js`, `pipeline/verify-classify.js`,
  `schemas/verify.schema.json`, `tools/run-acceptance.sh`, anything under
  `tests/acceptance/`, or any current `frozenPaths` entry.
- Must not modify any of the fifteen suites or their `tests/unit/` checkers. A suite red
  on the branch is a `status.js concern`, never a patch.
- Wrapper must not be named `scripts/test-*.sh` (the sweep glob would ingest it).
- Wrapper body is POSIX sh (dash in the container), resolves paths from its own location,
  and its exit code derives only from suite exit codes — no output parsing reaches the
  verdict.
- Wrapper sets/exports no seam variables (`CHANGELOG_FILE`, `VERDICT_RUNS_DIR`,
  `PIPELINE_BD_CMD`, …) and invokes each suite as `sh scripts/test-<name>.sh`.
- Acceptance tests spawn the wrapper as a child, never `require()` repo code; planted
  stubs a Node harness spawns directly are `.js` via `process.execPath`.

**Done means** (each criterion names its test; tests live in
`tests/acceptance/<issue-id>/`, Docker-free):
1. **Declared, and nothing else moved.** `pipeline.config.json` parses and contains
   exactly `"regressionCommand": "sh scripts/regression.sh"`; `verifyCommand`,
   `defaultBranch`, `frozenPaths` (still containing `tools/run-acceptance.sh`), and
   `dependencies` keep their current values. *(Test: parse + deep-compare against values
   inlined in the frozen test.)*
2. **The declared string runs green, the verifier's way, and names exactly the fifteen.**
   Executing the string read from the config via `spawnSync('sh', ['-c', str], {cwd:
   root})` exits 0; output ends with a `== regression summary ==` block containing exactly
   one `PASS scripts/test-<name>.sh` line per suite in the inlined fifteen-name list, no
   other PASS/FAIL summary lines, marker-to-end ≤ 2,000 characters; the script's basename
   is `regression.sh` and does not match `test-*.sh`. *(Test: run it; slice after last
   marker; compare against the inlined list.)*
3. **One red suite makes the run red, loudly, without stopping the others.** A copy of the
   wrapper in a temp root over fifteen planted stubs (fourteen green, one red) exits
   nonzero with `FAIL scripts/test-<planted>.sh` inside the last 2,000 characters and PASS
   lines for stubs sorting after the red one; the same copy all-green exits 0. *(Test:
   copy-to-temp-root; run twice.)*
4. **Container-safe by construction.** The wrapper's non-comment lines invoke no `docker`,
   `bd`, `curl`, `wget`, or `npm`; each of the fifteen appears in the
   `sh scripts/test-<name>.sh` form on a non-comment line. *(Test: read, strip comments,
   word-boundary grep.)*
5. **The sidecar is written where a workspace exists, and only there.** Running the
   wrapper copy in a temp root with `./.run/` present writes `./.run/regressions.json`
   matching the pinned format with one entry per suite and the red stub's entry
   `"verdict":"fail"`; with `./.run/` absent, no file is created and the exit code is
   unchanged; a sidecar write failure (`.run` unwritable) leaves the exit code unchanged.
   *(Test: same temp-root rig, three configurations.)*
6. **The paper trail.** `DESIGN.md` §12 has a row whose Ref is this task's issue id, and
   `sh scripts/test-changelog.sh` exits 0 on the branch. *(Test: grep + spawn.)*

---

## Task B — the sweep and a live run refuse to overlap; 300s per-suite default

**Difficulty label (proposal): hard.** Spans a bash/node boundary where a record is
written in one language and judged in another; most failure modes are silent-fail-open;
two frozen suites' fixture assumptions must survive. Gets the full three-critic panel.

**design-ref:** change-log row `sweep-trustworthy`, decisions (1) and (2); DESIGN.md §4.12.

**Description.** A sweep in one terminal has twice force-removed a live run's task
container (STATUS defect 11) — the reclaimer cannot be taught to distinguish "my suite
made this" from "a live run made this", so the guarantee must be exclusivity.
`scripts/test-all.sh` refuses to start while any `runs/locks/*.lock` has a live holder;
the runner refuses symmetrically while `runs/.test-all.lock` has a live holder. Liveness
is `runner/lock.js`'s existing `isHolderLive` rule, newly exported and never
re-implemented. The sweep's per-suite kill default drops 900s→300s (`--timeout` still
overrides; the cap stays named in the sweep's output).

**Settled in reconciliation:**
- **Two-stage sweep gate.** Bash globs `runs/locks/*.lock`; no files → proceed with no
  node invocation (existence is a glob, not a liveness judgment). Files present → node
  consults the exported `isHolderLive`; exit 0 = proceed, 2 = refuse naming the holder,
  anything else = indeterminate = refuse. This shape is what keeps the frozen `repo-zje`
  copy-pattern fixtures (which carry no locks and no `runner/lock.js`) green unmodified.
- **The sweep lock keeps its mkdir shape and gains `record.json`**, selfRecord-compatible,
  written by bash: `pid` is the sweep shell's `$$` (never a transient node child's),
  `takenAtMs`, `uptimeSeconds` from `/proc/uptime` when readable (omitted otherwise —
  `isHolderLive` tolerates every omission), `startedAt`. If the record cannot be written
  after taking the lock, the sweep releases and refuses — an unjudgeable sweep lock is
  exactly what would let a runner start beside a live sweep.
- **Failure directions are asymmetric, deliberately.** Sweep side: indeterminate
  (check could not run) refuses — proceeding is the destructive direction; note an
  unreadable lock *record* is not indeterminate, `isHolderLive(null) === false` is the
  rule's own determinate "nobody holds this" and the sweep proceeds. Runner side: a sweep
  record that is absent or unreadable reads as not-live and the runner proceeds — the
  block-forever protection for a leftover pre-upgrade lock directory; the runner never
  deletes a sweep lock. The mixed-version window (a live old-format sweep is invisible to
  a new runner) is accepted and named, not defended against.
- **Acquire-your-own-lock first, then check the other's — on both sides.** Mutual proceed
  is then provably impossible; the worst race outcome is mutual refusal, which is safe and
  self-resolving. Check-before-lock leaves exactly the window this task closes.
- **A stale rival sweep lock keeps refuse-with-instructions** (no takeover): the sweep is
  always interactive, and takeover would add a removal path the constraints forbid. The
  refusal now says whether the holder looks live or gone when determinable.
- Whether `runner/lock.js` also exports a sweep-lock path/reader helper for preflight is
  implementation freedom; the requirement is one spelling of the path in one place.

**Constraints.**
- The run lock stays the **first** runner gate; the sweep-lock check joins immediately
  after it and never displaces it. All frozen `repo-os9` behaviors keep holding (refusal
  wording, `locked: true` teardown-skip, release-on-later-abort).
- `acquire`/`release`/`lockPath`/`canonicalTarget` keep their signatures; `isHolderLive`
  is additive.
- Nothing new under `runs/locks/`, nothing removed from it, by either side. The sweep's
  lock stays at `runs/.test-all.lock` with its `pid` file intact
  (`scripts/test-sweep-hygiene.sh` checks that literal path).
- `scripts/sweep-reclaim.js` untouched; no new removal path in `test-all.sh`; the runner
  never deletes a sweep lock, the sweep never deletes a run lock.
- Sweep exit vocabulary unchanged (0 green / 1 red suites / 2 refusal-or-usage); RESULT
  and PASSED columns, `summary.txt`, and the FAIL grep untouched; `--list`/`--help` keep
  exiting before any lock (watch the `sed -n '2,46p'` help range when the header comment
  changes).
- `scripts/dashboard.js`'s inline liveness copy stays — it is a recorded deliberate
  re-implementation (change-log row `repo-kfg`); "never re-implemented" binds the sweep
  and the runner.
- Docs in the same PR: CLAUDE.md's "default 900s" line, `test-all.sh`'s header,
  `docs/pipeline-diagram.md` if it draws the sweep.

**Done means:**
1. **The sweep refuses a live run before touching anything, and only a live one.** Fixture
   root mirroring the repo (`test-all.sh`, `sweep-reclaim.js`, `runner/lock.js`, stub
   suite, docker recorder): with a `runs/locks/*.lock` record carrying a genuinely-alive
   pid (spawned sleeper child), the sweep exits 2, names the held project and holder,
   records **zero** docker calls, runs no suite, leaves no `.test-all.lock` behind. Same
   fixture with the record forged stale (`uptimeSeconds` inflated past uptime — the reboot
   falsifier, which a pid-only re-implementation gets wrong) sweeps green, exits 0, and
   leaves the stale lock file byte-identical on disk. *(Test: copy-pattern rig, two
   passes.)*
2. **The runner refuses a live sweep symmetrically, after the run lock, with nothing
   started.** Driving `preflight()` directly with the lock-suite rig: a planted
   `runs/.test-all.lock/record.json` with a live-child pid → `ok: false`, reason names the
   sweep and pid, teardown-skip flag set (no `networkDown` — a shared-name config's
   teardown would remove the network a live sweep has up), net/bd recorders empty, and the
   run lock just taken is released (immediate re-acquire succeeds, `tookOver: false`).
   With both a held run lock and a live sweep lock, the refusal names the run-lock holder
   (gate order pinned). With a stale sweep record, preflight passes the gate, aborts at a
   later gate as the rig arranges, and the sweep-lock files are still present — the runner
   removed nothing. *(Test: require preflight directly, three plants.)*
3. **Liveness is the exported rule, and the bash-written record satisfies it.**
   `isHolderLive` is exported: true for a fresh record with the test's own pid, false for
   the uptime-forged record, false for `pid: 0`, false for `null`. End-to-end: a copied
   `test-all.sh` run in the background over a sleeping stub writes `record.json` which,
   read mid-sweep, has `pid` equal to the spawned bash process's pid and
   `isHolderLive(record) === true`; after exit the lock directory is gone. *(This is the
   criterion that catches bash→JS field-name drift and the `$$`-vs-node-child pid bug —
   both silent fail-open.)*
4. **Indeterminate refuses; the empty case needs no machinery.** A minimal root with
   exactly the frozen `repo-zje` inventory (no `runner/lock.js`, no locks) sweeps green,
   exit 0 — the gate invokes nothing when there is nothing to judge. The same root plus
   one planted `runs/locks/x.lock` exits non-zero, runs no suite, records no docker call,
   and prints that the liveness check could not run. *(Test: two minimal roots.)*
5. **300s default; `--timeout` overrides; the cap stays named.** `TIMEOUT=300` on a
   non-comment line and no non-comment `TIMEOUT=900`; a stub sweep's log contains
   `ok     per-suite timeout 300s` (skip-with-ok when no `timeout` binary, mirroring the
   sweep's own warn branch); `--timeout 3` over a 30s-sleeping stub reports `TIMEOUT` in
   RESULT with note `killed after 3s`, exits 1, and the test itself finishes in well under
   30s. *(Test: source pin + two stub runs.)*

---

## Task C — the sweep reclaims stale run locks; `task-` reclamation is loud

**Difficulty label (proposal): medium.** Every needed pattern exists in the tree, but the
task spans two modules with a purity boundary, and the two subtle spots (the
missing-`locks`-key baseline, keeping the decision function I/O-free) are exactly what a
careless implementation gets plausibly wrong.

**design-ref:** change-log row `sweep-trustworthy`, decisions (3) and (4); DESIGN.md §4.12.

**Description.** A suite killed at its timeout leaves `runs/locks/*.lock` behind, and the
next sweep's `test-lock` goes red on the leftover — deterministic, pointing at the wrong
component, surviving across days. Extend `scripts/sweep-reclaim.js`: a lock file may be
removed only when it **appeared since the before-suite baseline** AND its **holder is
provably gone** by `runner/lock.js`'s exported `isHolderLive` (required, never
re-implemented — stated idempotently with Task B: whichever lands first ships the export,
the other's freeze still holds because it pins semantics, not authorship). Separately, any
reclamation of a container matching the anchored `task-` prefix becomes loud: stderr,
gated on nothing.

**Settled in reconciliation:**
- **The baseline extends the existing `snapshot`/`census` pair** — no new command, no
  `test-all.sh` call-site change. `snapshot` gains a `locks` identity list (basenames of
  direct children of `runs/locks/`); `census` gains lock entries carrying
  `{name, holderLive, runId, pid}` with `holderLive` computed via the required
  `isHolderLive`. Liveness probing is I/O, so it lives in `census`; `reclaimTargets` stays
  pure and sees data only (removes iff absent-from-baseline AND `holderLive === false`;
  missing or non-boolean `holderLive` means keep).
- **A baseline without a `locks` key authorizes no lock removal** (whatever it says about
  containers). Pre-this-task before-files exist; treating key-absent as empty-list would
  make the first post-merge sweep remove every stale lock on the machine against a
  baseline that never listed them.
- **A failed locks listing (non-ENOENT) sets `ok:false`**, which through the existing
  `readBefore` gate also blocks container reclamation for that suite — one baseline, one
  trust decision; a deliberate widening, stated.
- **Corrupt records are removable** — `isHolderLive(null) === false` is consistent with
  `acquire`'s takeover of corrupt records; the summary label degrades to
  `lock <basename>` with no runId rather than throwing.
- **Loud fires on selection** — whenever a `task-` container is among the selected reclaim
  targets, dry-run and failed-`rm` included: the diagnostic value is knowing selection
  happened. There is no quiet mode today, so "not suppressed" is pinned as an
  unconditional write: an extra `--quiet` argument (ignored today) must leave the line
  byte-identical.
- **The same-name blind spot is accepted**: a lock released and re-taken during a suite
  carries a filename the baseline lists and is never removed; the runner's own takeover
  path recovers that case. Identity-by-content risks the expensive direction.
- Removing a stale lock removes a dead project's channel from the dashboard registry —
  intended (the record was false), stated so a reviewer doesn't read it as data loss.
- The reclaimer deliberately requires `runner/lock.js` (contrast: `scripts/dashboard.js`
  re-implements inline because it must work as a lone copied file). Fixture roots must
  therefore be repo-shaped (copy `runner/lock.js` alongside).

**Constraints.**
- `scripts/sweep-reclaim.js` remains the only removal path in `scripts/`; `test-all.sh`
  gains no `rm`/`unlink` of lock files.
- `reclaim` always exits 0; the suite's exit code and verdict are decided before cleanup
  (existing ordering untouched).
- `reclaimTargets` stays pure: no I/O, no docker, no environment, no `process.kill`.
- A lock with a live holder is never removed, even when it appeared during the suite.
- Scope is direct children of `runs/locks/` matching `*.lock` only: never
  `runs/.test-all.lock`, never `runs/sweeps/`, never a subdirectory.
- `pidAlive`'s EPERM-is-alive rule and the 15-minute pre-boot grace belong to
  `runner/lock.js`; this task must not tune them.
- Existing exports of `runner/lock.js` and all current container/network decision behavior
  stay compatible (every current sweep-hygiene check keeps passing).

**Done means:**
1. **`isHolderLive` is exported and means what §4.12 says.** Exported as a function beside
   the four existing exports; `isHolderLive(null) === false`; true for a live-child record
   with sane fields; false when `uptimeSeconds` exceeds current uptime by days; false for
   an exited child's pid. *(Test: direct require, live/dead/forged records inlined.)*
2. **Reclamation is the AND of both gates, decided purely, exit 0 always.** Driving the
   real CLI from a repo-shaped temp root with the docker seam stubbed empty: (a) a lock
   absent from the baseline with a dead holder is removed and the stdout note names the
   lock and its runId; (b) absent-from-baseline with an alive-pid-but-pre-reboot record is
   removed (proves the real rule is consulted, not a pid check); (c) absent-from-baseline
   with a live holder stays; (d) present-in-baseline with a dead holder stays; (e) a
   before-file that is missing, `ok:false`, or `ok:true` without a `locks` key removes no
   lock. Exit 0 in every case. *(Test: five plants against the copied CLI.)*
3. **The liveness rule has exactly one home.** Non-comment source of `sweep-reclaim.js`
   requires `runner/lock.js` and contains no `process.kill`, `os.uptime`, or `/proc`.
   *(Test: structural grep, the house pattern.)*
4. **`task-` reclamation is loud, unconditionally.** A selected `task-` container produces
   a stderr line naming id and name; byte-identical with `--quiet` appended; no such line
   for a reclaimed `pipeline-proxy`; stdout note and exit 0 unchanged. *(Test: recorder
   stub reporting appeared containers; capture stderr, run twice.)*
5. **Both `repo-zje` rules travel, observed through the real sweep.** The copied
   `test-all.sh` over a stub suite that plants a dead-holder lock mid-suite: a suite
   exiting 1 still reports FAIL with the lock named in NOTE; a suite exiting 0 still
   reports PASS; the summary names the reclaimed lock; `test-all.sh`'s non-comment source
   still removes nothing under `runs/locks/` itself. *(Test: hygiene-pattern
   end-to-end.)*

---

## Task D — the report labels sibling-batch partials, on evidence that can carry the claim

**Difficulty label (proposal): medium.** The report-side join, label, and sort are pure
functions; what makes it medium is that the evidence the label needs does not exist yet —
the task ships a small additive evidence contract across harness → collection → manifest →
schema, plus the anti-mislabel edge cases.

**design-ref:** change-log row `batch-sibling-partials`; DESIGN.md §4 item 9.

**Description.** Nine of the corpus's eleven partials are batch siblings failing each
other's frozen suites — structural noise burying the one flag that means a real regression
slipped through. The user's decision (recorded): the verifier never treats these as
expected-red; the **report** labels them. The fresh-context feasibility read found today's
evidence cannot carry the claim: `verify.json` records one word for the whole regression
step plus a 2,000-character tail — enough to show siblings appeared, never that nothing
else failed, and a non-sibling failure scrolled past the tail would mislabel a **genuine**
partial as noise, the worst direction. So the task ships the label *and* the minimal
additive evidence it stands on: a per-suite results sidecar
(`/workspace/.run/regressions.json`, format pinned with Task A, whose wrapper is its first
writer), a new `schemas/regressions.schema.json`, carriage through `collectArtifacts` and
the manifest (evidence only — nothing upstream of the report reads its *content*), and the
classification, label, and sort in `runner/report.js` alone.

**Settled in reconciliation:**
- **The manifest carries the evidence; the report stays a pure function of `run.json`.**
  The report's contract is byte-identical regeneration from the manifest alone
  (`test-report.sh` regenerates in a directory with no `tasks/`); classification reading
  task dirs would silently drop labels on regeneration.
- **The audit's tail-regex precedent is deliberately not ported into the report** — it
  answers "which siblings appear", not "all failures are siblings", and cannot meet the
  exhaustiveness bar. `audit-runs.js` stays the forensics tool for the pre-existing
  corpus, which remains unlabelled forever (accepted).
- **Forged or contradictory evidence degrades to unlabelled.** The sidecar is written in
  an agent-writable workspace (same trust class as `changeSummary`); carriage drops a
  sidecar that contradicts `verify.json` (`regressions: "fail"` but sidecar all-pass → no
  key carried). The stronger mitigation (verifier deletes a stale sidecar before running
  the regression command) touches the verifier and is **not** taken: this task changes
  nothing under `pipeline/`.
- **`regressions: "error"` never labels** (a killed run has no opinion). While amending
  `run.schema.json`: its `verification.regressions` enum is already missing `"error"`
  (drift since change-log row `verify-nobuffer` — the first manifest carrying it would
  fail its own schema); fixed here as a named criterion, never silently.
- **Paused/refused siblings count as siblings** — their ids are deliberately in the task
  list, and their frozen suites sit on the integration branch whether or not they ran.
- **The PR body does not change** (`runner/publish.js` byte-untouched): publish runs per
  task during the drain, before sibling rows exist; the end-of-run report is the only
  artifact where the full task list and all evidence coexist.
- Path matching: trim, `\r`-tolerant, trailing-slash-insensitive, and the sibling test is
  an exact position-0 `tests/acceptance/` prefix — never substring (the `repo-zje`
  lesson). Task A's wrapper writes `scripts/test-*.sh` paths, which by design never match
  the sibling pattern — this repo's own batches stay honestly unlabelled.

**Constraints.**
- `pipeline/verify.js`, `pipeline/verify-classify.js`, `pipeline/entrypoint.sh`, and
  `runner/publish.js` byte-untouched; `outcomeFor`/queue logic untouched.
- The verifier receives no run-state input of any kind — it cannot know who its siblings
  are; that contamination is what the design decision rejected.
- Band order (tampered > stuck > partial > failed > done-with-retries > done-first-try)
  untouched; every existing outcome label string untouched; existing `test-report.sh`
  expectations for unlabelled rows stay green unedited.
- A partial with ANY non-sibling failing regression is never labelled; absent, ambiguous,
  or contradictory evidence is never labelled. The safe failure direction is always
  "unlabelled".
- Nothing upstream of the report branches on the label; nothing downstream gates on it
  (not `verdict.js`, not the dashboard vocabulary, not memory filing).
- Schema changes additive only; old manifests stay valid.
- `run.json`'s `outcome` stays `"partial"` — the label is presentation, never a new
  outcome enum value (the §4.11 table is closed).

**Done means:**
1. **The classifier is a pure exported function in `runner/report.js`.** Given a task row
   and the run's task-id set, it returns sibling-batch iff `outcome === 'partial'` AND
   `verification.regressions === 'fail'` AND per-suite evidence is present with a
   non-empty failing subset AND every failing path normalizes to
   `tests/acceptance/<id>/` for an id in the run's task list other than the row's own.
   Anything else — absent evidence, empty failing set, own suite, other-run id,
   non-acceptance path, hostile shapes — returns genuine, without throwing. *(Test:
   truth-table over the exported function, no fs.)*
2. **Label text pinned.** A labelled row's heading carries the literal token
   `sibling-batch`; an unlabelled partial's heading is byte-identical to today's;
   `run.json` still says `"outcome": "partial"`; the summary count line counts it under
   partial. *(Test: render two-partial manifest, assert headings and counts.)*
3. **Sort position.** Genuine partials before sibling-batch partials before `failed`, in
   both `run.json` order and rendered headings; all other band boundaries and tie-breaks
   unchanged. *(Test: shuffled seven-outcome manifest, assert exact id sequence.)*
4. **Mixed is genuine.** One sibling path plus one non-sibling path in the failing set →
   unlabelled, genuine-partial sort position. *(Test: one manifest, one row.)*
5. **Degrades on the past.** A manifest with no per-suite field renders byte-identically
   to today's generator; `regressions` of `pass`/`absent`/`error` never labels regardless
   of evidence present; hostile per-suite values never throw. *(Test: field-free manifest
   byte-compare; hostile-value table.)*
6. **Carriage exists, is inert, and the schema admits reality.** `collectArtifacts`
   copies/parses `.run/regressions.json` (absent → no key; malformed → no key;
   contradicts `verify.json` → no key; no throw); `run.js` carries it onto the row; the
   amended `run.schema.json` admits the field, admits `"error"` in
   `verification.regressions`, and still admits old manifests; structurally, no file under
   `runner/` or `pipeline/` other than `report.js` reads the field's content. *(Test:
   planted workspaces; hand-rolled schema admitter — no ajv in the container; structural
   grep.)*

---

## Critic findings and dispositions

*Pending — filled in after the panel runs (PLANNING.md step 2). Every finding will appear
here as accepted (and what changed), rejected (and why), or deferred (and until what).*

## Freeze-gate results

*Pending — run before the approval pass (PLANNING.md step 4). Guard counts will be
reported here.*

## Host obligations this batch leaves behind (no frozen test can hold these)

- One real sweep on the reference host after B and C merge, by hand, reported in the run's
  review.
- CLAUDE.md's in-container list gains `scripts/regression.sh` (Task A's docs phase);
  CLAUDE.md's "default 900s" line changes (Task B's docs phase) — both checked at review.
- After the batch merges: the next planning session should consider declaring the
  now-existing sixteenth suite (none today) — the enumerate-don't-discover decision makes
  this a standing review item.
