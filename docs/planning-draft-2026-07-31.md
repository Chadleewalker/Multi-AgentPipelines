# Planning draft — 2026-07-31: intra-run parallelism, and the batch that has to land first

Input to this session: `DESIGN.md` §7 (the concurrency knob, decided in change-log row
`parallelism-v2`), `docs/parallelism-findings-2026-07-31.md`, and `docs/STATUS.md`'s
"No concurrency *within* a run" gap.

The session opened intending to freeze one hard parallelism task alongside `repo-sls`. The
critic panel returned `concerns` from all three charters — 30 findings — and two of them
were premise-breaking rather than cosmetic:

- **The claimed file-disjointness between parallelism and `repo-sls` was false.**
  `repo-sls`'s approved criterion is *"the bound is configurable with a documented default"*,
  and §4.12 puts every production tunable in `run.config.json` — which is `runner/config.js`,
  which parallelism also owns. The first draft "resolved" this by demoting `repo-sls`'s knob
  to an environment variable; `PIPELINE_*` is reserved for test seams, so that was bending
  the configuration contract to suit batching convenience.
- **The parallelism task was two tasks.** The bounded worker pool and the run-level
  rate-limit park pass and fail independently, and the park is a state machine in its own
  right.

So the plan is now **three tasks over three batches**, not two tasks in one.

| Batch | Issue | Title | Prio | Difficulty | State after this session |
|---|---|---|---:|---|---|
| **1** | `repo-sls` | Bound every runner `bd` call | 1 | medium | **frozen and ready** |
| **1** | `repo-os9` | Refuse a second concurrent run against the same project | 2 | medium | already frozen, unchanged |
| **2** | `repo-teq` | The bounded worker pool (the §7 `concurrency` knob) | 1 | hard | approved intent, blocked, **unfrozen** |
| **3** | `repo-i9y` | Park the whole run on a usage limit, not each task separately | 1 | hard | approved intent, blocked, **unfrozen** |

**Why batches 2 and 3 are not frozen today.** PLANNING.md's rule: acceptance tests are
written in the planning session immediately before the run that executes them, because
freezing weeks early is how suites go stale (the T12 failure — three staleness bugs
accumulated in a suite nobody re-ran). `repo-teq` cannot run until batch 1 merges, and
`repo-i9y` cannot run until `repo-teq` does. Their specs below are approved *intent*, which
is what the user signs off; their tests get written when their run is next.

**Why `repo-os9` joins batch 1.** It is already frozen and in the ready queue, it owns
`runner/preflight.js` and `runs/`, and `repo-sls` owns `runner/bd.js` — genuinely disjoint,
unlike the pairing this session started with. Batch 1 is therefore also a live test of the
ownership discipline that `docs/parallelism-findings-2026-07-31.md` §2 credits with
preventing every code collision across four batches.

---

## Batch 1, task 1 — `repo-sls`: bound every runner `bd` call

Drafted and approved on **2026-07-28**; the approved text lives in the **`repo-sls` Beads
issue**, not in a planning draft (`docs/planning-draft-2026-07-28.md` is `repo-iok`'s and
mentions `repo-sls` nowhere — the first version of this draft cited it wrongly). Held blocked
and unfrozen since. This session writes its acceptance tests and freezes it, with the
description and constraints unchanged and the criteria sharpened by the panel.

### Description (unchanged)

`runner/bd.js` calls `spawnSync` with no timeout, so a `bd` invocation that never returns
hangs the run forever. Observed twice on 2026-07-28: a container-side `bd` emitted its
complete JSON output and then never exited, and concurrent access to one embedded Dolt
database blocked indefinitely. Four sweep suites were killed at 900s by the harness; a real
run has no such backstop and would park until someone noticed.

Every runner Beads call is exposed — `claim`, `finish`, `note`, `remember` — and the
`remember`/`finish` pair runs **after** the container exits, so a hang there strands finished
work with the issue still `in_progress` and the outcome unwritten.

The fix is a bounded wait that fails loudly rather than silently, in the one place all runner
Beads access already goes through. §4.1's principle applies directly: the runner enforces
timeouts, and the enforcer cannot live inside the thing it may need to kill.

**Why it goes first.** `spawnSync` blocks the Node event loop. Once `repo-teq` adds a worker
pool, one hung `bd` call stalls *every* concurrent task rather than one — and the load that
produced the original hang was concurrent access to a single embedded Dolt database, which is
exactly what parallelism increases.

### Constraints

- `runner/bd.js` and `runner/config.js` (for the new field) only. No change to the seam
  contract: `PIPELINE_BD_CMD` keeps absolute precedence and the `-C <targetRepoPath>` prefix
  is unchanged.
- **The bound must keep `bd()` synchronous.** Use `spawnSync`'s native `timeout` option, never
  an asynchronous spawn. The runner is the sole Beads writer (hard rule 1) and, in a
  single-threaded process, `spawnSync` is what makes two `bd` calls unable to interleave over
  one embedded Dolt database. An async rewrite would silently remove that guarantee at
  exactly the moment `repo-teq` starts running tasks concurrently.
- A timeout is a loud failure, never a silent empty result — a timed-out `bdJson` must be
  distinguishable from a successful empty query, or this becomes the same silent degradation
  it exists to prevent.
- **No caller's behaviour changes.** A timeout surfaces as the non-zero-status result those
  callers already handle: `readyQueue` failure still aborts the run, `claim` failure still
  skips the issue, `exportIssue` failure still fails the task, `finish` / `note` /
  `recoverStaleIssues` / `fileMemoryNotes` failures are still logged with the run continuing
  and the outcome untouched.
- Docker-free testable through the `PIPELINE_BD_CMD` seam. The sleeping stub must be a `.js`
  file run through `process.execPath` and must genuinely block (`Atomics.wait`), because
  `bd()` spawns the seam command with no shell.

### Acceptance criteria — "Done means"

1. **A `bd` call that exceeds the bound returns a visible failure naming the timeout.** Against
   a stub that sleeps well past a small configured bound, `bd()` returns a non-zero status and
   an error text containing the timeout value; against a fast stub it returns normally and the
   bound never fires.
2. **A timed-out `bdJson` is distinguishable from a successful empty query.** `bdJson` against
   the sleeping stub returns `{ok:false}` with an error naming the timeout; against a stub
   printing `[]` it returns `{ok:true, data:[]}`. The two must not be confusable — this is the
   silent-degradation failure the task exists to prevent.
3. **The bound is a documented `run.config.json` field with a default.** `bdTimeoutMs`, default
   **60000**, validated by `loadConfig` as a positive whole number with the existing
   `run.config.json: '<field>' must be a positive whole number` error shape, present in
   `run.config.example.json`, and applied when a config names none.
4. **The bound reaches all three of `bd()`'s branches, not just the stub one.** `PIPELINE_BD_CMD`
   takes absolute precedence and returns early, so a Docker-free test can only *execute* that
   branch — an implementation that bounds it alone would pass a naive suite while production
   `bd` stayed unbounded. So the timeout must come from a **single shared spawn-options
   builder** — `spawnOptions(cfg)`, exported from `runner/bd.js`, returning an object whose
   `timeout` is `cfg.bdTimeoutMs` or the default — and **every** `spawnSync` call in
   `runner/bd.js` must be built from it, including the two host-`bd` probes in `hostBdSpec`
   (a hung probe hangs the run exactly as a hung call does).
5. **`bd()` stays synchronous.** `runner/bd.js` contains no asynchronous spawn of the bd
   command (`spawn(`, `execFile(` without `Sync`), asserted structurally on non-comment lines.
   This is the invariant the sole-writer rule rests on once `repo-teq` lands.
6. **[guard] The seam contract is unchanged.** `PIPELINE_BD_CMD` still takes absolute
   precedence over the host and Docker branches, still receives the bare bd argument vector
   with no `-C` prefix, and `haveHostBd` / `toMountPath` / `shimTarget` still behave as they do
   today. Green before the change and must stay green after it.

### Design references

`DESIGN.md` §4.1 (the runner enforces timeouts), §4.10 (host is the sole Beads writer),
§4.12 (runner lifecycle and configuration).

---

## Batch 2 — `repo-teq`: the bounded worker pool

### Description

Give the runner an opt-in `concurrency` setting so **one** runner process works N tasks of one
project at the same time, each in its own container, instead of a strict sequential `for`
loop. Default **1**, which behaves exactly as today.

`DESIGN.md` §7 decided the shape before this task existed; this builds the scheduling half of
it. **One runner juggling N containers, never N runners** — the sole-Beads-writer rule (§4.10)
and claim-based double-pick prevention survive only inside a single process. Several runners,
one per project, are a different thing and already shipped (change-log row `repo-jur`).

Measured payoff, from the findings doc: a batch of three evenly-matched tasks was **2.75×**; a
batch of two where one task was 3.6× the other was **1.28×**. The win is bounded by the
slowest task in the batch, not by how many tasks it holds — which is why the default stays 1
and the knob is for daytime batches of small tasks, not for long unattended runs.

### What this task deliberately does not do

- **The rate-limit park stays per task.** `repo-i9y` (batch 3) makes it run-level. Until then,
  N concurrent tasks each run their own pause loop against one shared subscription window.
  That is wasteful, not corrupting, and it is unreachable at the default of 1 — which is what
  makes shipping the pool first safe.
- **`workspace.prepare()` and `publish()` stay synchronous.** Both use `spawnSync` (`git
  clone`, `git push`, `gh pr create`), so they block the event loop and serialise across
  workers. Deliberate: they cost seconds against container times measured in tens of minutes,
  and making them async would widen this task into four more runner files for a rounding
  error. The visible consequence — a wall-clock kill timer can fire a few seconds late while
  another worker is cloning — is accepted and stated here so it is not mistaken for a defect.
- **The docs-phase merge collision stays open.** Every task edits the target's design doc,
  README and spec file, so every merge after the first conflicts — 100% of the time across
  four batches. Resolution is mechanical and additive (one pass per merge, no judgment) and
  the mitigation options are parked in `docs/IDEAS.md`.
- **No pre-run check that two ready tasks declare overlapping file ownership.** That is the
  §3.5-ladder move the findings doc §2 proposes, and it is its own task.

### Constraints

- **Files this task may edit:** `runner/run.js`, `runner/config.js`,
  `schemas/run.schema.json`, `run.config.example.json`, `tests/acceptance/repo-teq/`, and one
  new Docker-free suite (`tests/unit/*.test.js` plus its `scripts/test-*.sh` wrapper).
- **Files this task must not edit:** every other file under `runner/` — `bd.js`, `pause.js`,
  `container.js`, `queue.js`, `workspace.js`, `publish.js`, `memory.js`, `preflight.js`,
  `log.js`, `report.js` — everything under `pipeline/`, every existing
  `tests/acceptance/*/` directory, and every existing `scripts/test-*.sh`.
- **The prose documentation is shared, and conflicts are expected.** `DESIGN.md`,
  `docs/STATUS.md`, `docs/pipeline-diagram.md` and `CLAUDE.md` are not owned by this task —
  the docs phase of every task in every batch edits them. Resolution is additive. The §12
  change-log row is the half that resolves cleanly, because each row carries its own
  host-assigned slug and keeping both sides is always correct (change-log row `repo-006`).
- **The task loop stays in `runner/run.js`.** `scripts/test-runner-pause.sh` asserts the
  literal `exitCode !== 20` appears in that file, and the container cannot run that Docker
  suite to notice a break.
- **`runner/run.js` must become requirable without running.** Today it calls `main()`
  unconditionally at module load, and `main()` is unreachable in a task container — it sits
  behind `loadToken` and a Docker preflight that always fails there. So the scheduler must be
  an **exported function** and `main()` guarded behind `require.main === module`. Nothing in
  the repo requires `run.js` as a module today and every caller invokes it as
  `node runner/run.js`, so the guard is safe. **A preflight-bypass environment seam is
  explicitly not the answer** — a production flag that skips the egress gate is a hard-rule-6
  hazard, and a fake `docker` earlier on PATH fails with `EFTYPE` on the Windows host and
  falls through to the real daemon, tearing down live networks mid-sweep.
- **These identifiers must survive the restructure on non-comment lines of `runner/run.js`:**
  `fileMemoryNotes`, `queueSummary`, `shouldFileMemory`, `exitCode !== 20`. Four frozen
  acceptance suites (`repo-4gp` D6, `repo-4l8` F6, `repo-dhp` C5) and one Docker suite assert
  them, this repo declares no `regressionCommand`, and nothing re-runs a frozen directory — so
  breaking them is silent.
- **The execution seam must stop blocking the event loop.** `executeTask`'s
  `PIPELINE_EXEC_STUB` path uses `spawnSync`, which serialises every stubbed task and makes
  concurrency unobservable to exactly the Docker-free suites that must prove it. The stub path
  becomes asynchronous; its invocation stays `bash <stub>` (an explicit interpreter, so no
  `EFTYPE` on the Windows host) and its environment contract is unchanged, because the
  existing Docker suites depend on both.
- **Concurrency changes scheduling, never judgment.** No change to the verifier, the §4.11
  outcome table, the three-attempt cap, or the per-task wall-clock budget (hard rules 2, 5, 7).
- **The host stays the sole Beads writer** (hard rule 1); all runner Beads access keeps going
  through `runner/bd.js`, which this task may not touch.
- **The network and the proxy sidecar stay per project, brought up once per run** (§4.8,
  change-log row `repo-jur`). Not per task: N containers share one network and one sidecar by
  design.
- **No new dependencies.** Node built-ins and POSIX shell only.
- Acceptance tests must be Docker-free; any new stub spawned without a shell must be a `.js`
  file invoked through `process.execPath`, never `#!/bin/sh` (STATUS defect 9).

### Acceptance criteria — "Done means"

1. **The knob exists and is validated at load time.** A config naming no `concurrency` loads as
   `1`. A value that is not a whole number, is below 1, or is **above 3** is a `loadConfig`
   error naming the field, in the existing `run.config.json: '<field>' must be …` shape — so a
   typo aborts before any container starts instead of silently running sequentially. The
   maximum is **3**, fixed here as a literal because §7 states only a hedged range
   ("sensible maximum 2–3"); the criteria below drive the pool at 3, so a maximum of 2 would
   make a correct implementation fail.

2. **The configured value is recorded in `run.json`, and `run.json` still validates.** A
   top-level `concurrency` field carries **the configured or defaulted setting** — not the
   observed peak in-flight count, which would read `1` for a three-wide run with one queued
   task. `schemas/run.schema.json` is amended to admit it (the manifest root is
   `additionalProperties: false`), and a manifest carrying the field validates against that
   schema. `run.log` is deliberately not the artifact asserted: its lines carry an ISO
   timestamp and a run id, so a digit match is a false positive and a phrase match freezes the
   log's prose.

3. **At `concurrency: 1` the drain is strictly sequential and in ready-queue order.** Driving
   the exported scheduler with three queued issues and a task function that records a start
   and an end, no task's start falls between another task's start and its end, and starts
   occur in ready-queue order.

4. **At `concurrency: 3` three tasks are genuinely in flight, and the pool is bounded.** Proven
   by rendezvous, never by wall-clock: with four queued issues and a task function that
   announces itself and waits until three have announced before resolving, the drain completes
   and no task records the give-up marker (**give-up bound: 10 seconds**, an in-process
   rendezvous with no spawned processes, so it is deterministic rather than load-sensitive).
   Additionally, **maximum simultaneous in-flight never exceeds 3**, and the fourth task's
   start follows at least one other task's end — without which an unbounded pool passes the
   rendezvous just as green. The same fixture at `concurrency: 1` must record the marker,
   which is what makes the check discriminating rather than vacuous.

5. **Results keep ready-queue order and every task's artifacts stay its own.** With a task
   function whose durations are inverted so the last-queued finishes first, the scheduler's
   returned results are still in ready-queue order and each entry's outcome matches that
   issue's own result. A naive append-on-completion fails this.

6. **[guard] The identifiers the unrepairable suites depend on survive.** `fileMemoryNotes`,
   `queueSummary`, `shouldFileMemory` and the literal `exitCode !== 20` each appear on a
   non-comment line of `runner/run.js`. Green before the change; the whole point is that it is
   still green after a restructure that has every reason to move them.

### Design references

`DESIGN.md` §7 (V2 — the concurrency knob), §4.12 (runner lifecycle and configuration),
§4.10 (host as sole Beads writer). The docs phase amends §4.12 with what this task decides
that §7 did not state — the bounded worker pool, ready-queue result ordering, the exported
scheduler, and the deliberate synchrony of clone and publish — and appends a §12 change-log
row under this issue id.

### Difficulty

**hard** — full panel, already run against this text.

---

## Batch 3 — `repo-i9y`: park the whole run, not each task

### Description

A usage limit is a property of the **subscription window**, not of a task. Once `repo-teq`
lets N tasks run at once, N parked tasks each running their own pause loop probe the same
window N times and relaunch independently. This task makes the park run-level: one shared
wait, and a pool that admits no new work while the window is closed.

§7 decided this ("rate-limit pauses go global"); this builds it, and resolves the two things
§7 left open.

### The two resolutions, stated before freeze because the frozen tests encode them

- **Park means "admit no new work", never "kill what is running".** §7's wording — *"one
  task's usage-limit exit parks every running task"* — reads as parking live containers. It
  does not: killing a container discards agent work that may be minutes from finishing and
  spends wall-clock budget for nothing, and a container whose window is genuinely closed will
  hit the limit and exit 20 by itself. The docs phase amends §7 to say so.
- **The pause cap becomes run-level.** §4.7 defines `maxPauseCycles` as per task, counted in
  wait cycles carried across relaunches. A shared wait has no per-task cycle to count, so the
  gate holds one counter for the run. When it fires, the run **admits no new work** and every
  parked task ends `paused` — its existing §4.11 outcome, issue left `in_progress`, nothing
  terminal written. The run then finishes normally and writes its manifest. The docs phase
  amends §4.7.
- **The gate opens on the first exit 20 and uses that task's reported reset time.** A second
  exit 20 arriving during an in-flight wait **joins** it and never extends it. If the window
  is still closed when the wait ends, the relaunched tasks exit 20 again and open a fresh
  gate — self-correcting, and bounded by the run-level cap above.

### Constraints

- **Files this task may edit:** `runner/pause.js`, `runner/run.js` (the pool's admission gate
  only), `tests/acceptance/repo-i9y/`, and its own Docker-free suite. Everything `repo-teq`
  excluded stays excluded, plus `runner/config.js` and `schemas/run.schema.json` unless a
  criterion below requires them.
- **The gate must take an injectable wait function**, the way `waitForWindow` already accepts
  `opts.sleepFn` / `opts.probeFn` / `opts.now`. That injection is the only honest observable
  for "one shared wait rather than N": counting log lines would freeze `pause.js`'s prose into
  a frozen test, and `PIPELINE_PROBE_CMD` is never called on the reset-time path.
- **Per-task pause mechanics are reused unchanged** (§4.7): a relaunch is a fresh container
  against the same workspace, `.run/status.json` survives, and the attempt counter carries
  over.
- `scripts/test-runner-pause.sh` makes 18 literal `grep -q` assertions against log strings
  emitted by `runner/run.js` and `runner/pause.js` — including `rate limit hit (pause 1)`,
  `issue stays in_progress`, `relaunching in a fresh container against the same workspace`,
  `active total`, and a count of exactly two `launching container` lines. This task owns
  neither that suite nor a way to run it. Those strings must survive, or their repair is a
  named host obligation for the merge.

### Acceptance criteria — "Done means"

Written in the planning session immediately before batch 3, per PLANNING.md step 3. The
approved intent above is what is being signed off now; the machine-checkable list is drafted
against the code as it exists after `repo-teq` merges, because a criterion written against
today's `run.js` would be describing a file that no longer exists.

### Design references

`DESIGN.md` §4.7 (rate-limit pause/resume), §7 (the concurrency knob). Depends on `repo-teq`.

### Difficulty

**hard** — full panel, run in the session that freezes it.

---

## Mechanical checks

| Check | Result |
|---|---|
| `node scripts/spec-lint.js --repo . docs/planning-draft-2026-07-31.md` | **clean** — no criterion names any of the 1 frozen path |
| `node scripts/freeze-gate.js --repo . --tests tests/acceptance/repo-sls/ --spec …` | **RED** (exit 0) — real run exit 1 against a green control, so the tests discriminate. **2 guards declared** (A5's synchrony pair and A6's seam contract), both verified green today |
| `node scripts/freeze-gate.js` (`repo-teq`, `repo-i9y`) | not applicable — not frozen this session |

`tests/acceptance/repo-sls/test.js` is 28 checks. Two results were fixed rather than accepted
while writing it, both instances of the panel's own lesson: an A6 guard failed because Node
resolves `argv[1]` to an absolute path under `--require`, so the assertion was measuring the
harness rather than the seam; and `A3 an explicit bdTimeoutMs wins` passes *today*, because
`loadConfig` spreads unknown fields straight through — it is kept as a regression check on the
field being dropped, but the discriminating half of A3 is the **default**, not the override.

## Critic panel — findings and dispositions

Three charters, three independent fresh contexts, **30 findings, all three `concerns`**.
Every finding is dispositioned. Two were premise-breaking and went back to the user as
decisions; two mechanisms proposed by a critic were rejected in favour of a different one
while accepting the finding itself.

### Ambiguity (11 findings)

| # | Finding | Disposition |
|---|---|---|
| AM1 | Which reset time governs a shared wait, and what a second exit-20 does, is unstated | **Accepted** — `repo-i9y` resolutions: gate opens on the first exit 20 and uses that task's reset time; later exits join, never extend |
| AM2 | P2's criteria cited `docs/planning-draft-2026-07-28.md`, which is `repo-iok`'s and names `repo-sls` nowhere | **Accepted** — verified true. Cites the Beads issue now, and the criteria are restated as a numbered list |
| AM3 | "No two `bd` calls overlap" is vacuous under `spawnSync`, and the only file that could break it belongs to the other task | **Accepted** — dropped as a parallelism criterion; became `repo-sls` constraint + criterion 5 (`bd()` stays synchronous) |
| AM4 | The concurrency maximum is a hedged range in §7, and a maximum of 2 would fail a criterion that drives 3 | **Accepted** — fixed at **3** as a literal in criterion 1 |
| AM5 | "The concurrency actually used" vs "equals the configured one" disagree; the `run.json` field has no name or level | **Accepted** — criterion 2 pins top-level `concurrency` = the configured/defaulted value, not the observed peak |
| AM6 | The file lists claimed neither `workspace.js` nor `publish.js`, both of which block the event loop | **Accepted** — every runner file is now enumerated, and the blocking clone/publish paths are declared out of scope with the reason and the visible consequence |
| AM7 | `maxPauseCycles` is per task; a shared wait has no per-task cycle | **Accepted** — `repo-i9y` makes the counter run-level and states what happens when it fires |
| AM8 | §7 says a usage limit parks every running task; the criterion said don't kill | **Accepted** — user decision: never kill; the docs phase amends §7 |
| AM9 | `repo-sls`'s "documented default" had no name, value or home | **Accepted** — `bdTimeoutMs`, default 60000, in `run.config.json`; possible only because `repo-sls` now runs alone and owns `config.js` |
| AM10 | Which `bd` callers are non-fatal was never enumerated | **Accepted** — all six enumerated, and the constraint is now that **no** caller's behaviour changes |
| AM11 | The rendezvous give-up timeout was unnamed — 5s flakes, 120s hangs the sweep | **Accepted** — 10 seconds, and the rendezvous is in-process so it is deterministic |

### Testability (10 findings)

| # | Finding | Disposition |
|---|---|---|
| TE1 | Five of six criteria describe `run.js`'s task loop, which nothing Docker-free can execute; frozen as written they degrade to greps of source | **Accepted, one proposed mechanism rejected.** The scheduler is exported and `main()` guarded. The critic's alternative — a `PIPELINE_SKIP_PREFLIGHT` seam — is **rejected**: a production flag that skips the egress gate is a hard-rule-6 hazard |
| TE2 | "No two `bd` calls overlap" cannot fail — a property of the runtime asserted as a property of the code | **Accepted** — see AM3 |
| TE3 | "A live container is not killed" is vacuous: `PIPELINE_EXEC_STUB` replaces the function that owns the kill timer | **Accepted** — removed from the criteria; it is a host obligation, listed below |
| TE4 | "One shared wait per window" names no observable; log-line counting freezes prose and `PIPELINE_PROBE_CMD` is silent on the reset-time path | **Accepted** — `repo-i9y` constraint: the gate takes an injectable wait function |
| TE5 | The rendezvous passes just as green on an **unbounded** pool; the bounded half had no observable | **Accepted, different mechanism.** Max-in-flight ≤ N and "the fourth start follows an end" are now asserted. The critic's shared rendezvous *file* written by concurrent processes is **rejected** — the exported scheduler is driven in-process, so there are no interleaved partial writes to flake on |
| TE6 | The maximum must be a literal or a frozen test has to invent it | **Accepted** — see AM4 |
| TE7 | A `run.log` digit match is a false positive; the schema root is `additionalProperties: false` and no criterion said run.json must still validate | **Accepted** — criterion 2 drops `run.log` and adds the schema-validation check |
| TE8 | `repo-sls`'s knob cannot be frozen until it is named, and a bare constant cannot be shrunk by a test | **Accepted** — see AM9 |
| TE9 | A Docker-free test reaches only the `PIPELINE_BD_CMD` branch, so bounding that one alone passes the suite while production stays unbounded | **Accepted** — `repo-sls` criterion 4: one shared, exported spawn-options value, asserted to reach all three call sites |
| TE10 | (a) the `exitCode !== 20` grep had no criterion; (b) the per-project network claim has no Docker-free observable; (c) the guard label on the sequential-drain criterion was wrong, because the scheduler it drives does not exist at the fork point | **Accepted** — (a) promoted into `repo-teq` criterion 6 with the other three fragile identifiers; (b) moved to host obligations; (c) label removed, criterion 3 is a normal red criterion |

### Scope (9 findings)

| # | Finding | Disposition |
|---|---|---|
| SC1 | The parallelism task is two tasks — pool and park pass and fail independently | **Accepted** — user decision: split into `repo-teq` then `repo-i9y` |
| SC2 | The `bd`-overlap criterion belongs to `repo-sls`, not to parallelism | **Accepted** — see AM3 |
| SC3 | Claiming `DESIGN.md`/`STATUS.md`/`CLAUDE.md` as owned contradicts admitting the docs collision stays open | **Accepted** — prose docs are declared shared and conflict-expected, and removed from the exclusive list |
| SC4 | Demoting `repo-sls`'s knob to an env var bends the configuration contract for batching convenience | **Accepted** — user decision: `repo-sls` runs first, alone, keeping its `run.config.json` field |
| SC5 | The maximum names a number that exists nowhere | **Accepted** — see AM4 |
| SC6 | A6 silently changes a documented per-task invariant without saying which way | **Accepted** — see AM7 |
| SC7 | Blast radius is wider than the one grep anticipated: 50 literal `grep -q` assertions across three Docker suites, plus four frozen suites asserting identifiers in `run.js` | **Accepted** — verified (18 + 20 + 12 greps; `fileMemoryNotes`, `queueSummary`, `shouldFileMemory`). Now a constraint and a criterion, with suite repair named as a host obligation |
| SC8 | `repo-sls`'s provenance citation is wrong | **Accepted** — see AM2 |
| SC9 | Labels fit: `hard` and `medium` are both correct; the problem is size, not labelling | **No action** — confirmation rather than a finding |

## Obligations no task in these batches can discharge from inside a container

- **`bash scripts/test-all.sh` after every merge in batches 2 and 3.** `repo-teq` changes the
  runner's task loop, which `test-runner-queue`, `test-runner-pause`, `test-runner-bootstrap`
  and `test-runner-container` all drive for real, and no frozen acceptance test in this repo
  can reach them.
- **Repair of the Docker suites' literal log-string assertions** if `repo-i9y`'s park moves
  them. Named here because the task that breaks them cannot run them.
- **A real two-task run at `concurrency: 2` against a live project.** Nothing Docker-free
  proves that two containers actually share one network and one proxy sidecar, or that a live
  container is not killed when another task parks — `PIPELINE_EXEC_STUB` replaces the function
  that owns the kill timer, so that check is a proxy at best inside a container.
- **Strip any `"network"` / `"proxyName"` lines still in local `run.config.*.json` files.**
  Carried over from `repo-jur`; they are git-ignored, so no task can edit them.
