# Draft for approval: the ready queue's dispatchability gate, 2026-08-21

**Status:** one spec, drafted, reviewed by a three-critic panel, revised. **Not frozen, not
queued.** Nothing runs until you approve the "Done means" list below.

**Design already amended** (uncommitted, in this working tree): `DESIGN.md` §4.11 gains an
`undispatchable` outcome row, §4.12 gains the ready queue's second admission rule and a
`gitTimeoutMs` config key, and §12 gains change-log row `dispatch-gate`. The change-log row
carries the whole argument in one paragraph; this file is the spec.

---

## The problem, in one paragraph

The runner dispatches any issue `bd ready` returns, checking only that its type is not
`epic`. It never asks whether the issue's frozen acceptance suite exists on the branch its
container will fork from. When it does not, the verifier's first act —
`<verifyCommand> tests/acceptance/<issue-id>/` — prints `FAIL: test dir not found` and exits
1 **before any of the agent's work is consulted**, three times, once per attempt. Nothing in
the container's diff can change that, and the one move that looks like a rescue is worse: the
frozen set is read from `git status --porcelain`'s `??` lines as well as the fork-point diff,
so an agent that writes the missing suite is recorded `tampered`. There is no play available
to a task agent, which is correct and stays. The dispatch is what was wrong.

**The evidence.** Two consecutive runs against one target dispatched fourteen tasks of which
**eight could never have passed** — seven with no suite reachable from the fork point at all.
The second run spent 3h11m to record eight `stuck` and nothing else. Five of the seven had
their suite present *locally*: in a commit nobody pushed, or untracked in a working tree.
**Freezing locally is not freezing** is the whole lesson, and the check has to encode it.

**One shipped property is repealed, deliberately.** Until now an unreachable
`targetRepoRemote` was a *task* failure — the clone failed, the task was reported, the run
carried on at exit 0, and `scripts/test-runner-workspace.sh` asserts exactly that. The gate
reaches the same remote first, so an unreachable remote now aborts the run. That is the
better report (every task would fail at clone seconds later; eight task-level clone failures
is a worse artifact than one abort naming the remote), but it changes tested behaviour, so
the check is **rewritten to assert the new behaviour**, never deleted.

---

## Scope: what is in this task and what is not

**In:** the gate in `runner/queue.js`, `gitTimeoutMs` in `runner/config.js` and
`run.config.example.json`, the abort channel and manufactured rows reaching `runner/run.js`,
`RANK` + `LABEL` in `runner/report.js`, the `outcome` enum in `schemas/run.schema.json`, the
rewrite of `test-runner-workspace.sh`'s clone-failure check, `docs/pipeline-diagram.md`, and
a new Docker-free suite plus its `scripts/test-*.sh` wrapper.

**Out, and done by hand on the host instead:** giving `scripts/test-runner-queue.sh` (seven
`bdq create` sites) and `scripts/test-runner-workspace.sh` (three) a per-issue
`tests/acceptance/<id>` + commit + push. Those two suites break wholesale under the gate —
every issue in them is refused, and ~25 assertions about ordering, transitions and no-replay
fail for reasons unrelated to what they test. This is **not** a pipeline task: the suites
pass before and after, so its only criteria would be assertions about source text and the
freeze gate would rightly refuse it (`PLANNING.md`, "a pure refactor cannot be frozen"). It
is also verifiable only by a Docker sweep, which no container can run. Doing it by hand first
makes that sweep the *control* and the post-gate sweep the *measurement*.

**Out, and specced immediately after this, depending on it:** `scripts/batch.js show`
reconciles a batch marker against the live queue and imports the type filter from
`runner/queue.js` precisely so its answer tracks the runner's admission rules. This change
adds a second rule and does not teach it to the reader, so from merge onward an id can read
`ready` in the launch confirmation and never dispatch — the exact false confidence that
reader exists to remove, arriving through the reader itself. Declared in §4.12 as a
consequence, not parked as an inbox note.

**Out, parked in `docs/IDEAS.md`:** a freeze-time lint for guards that enumerate what later
work is licensed to change, and surfacing a repeated spec concern louder than a report
footnote (seven agents diagnosed this correctly and nothing consumed any of them).

---

## The spec

### Description

Add the ready queue's second admission rule. `readyQueue()` in `runner/queue.js` gains a
third population beside `skipped`, keyed `undispatchable`: for each candidate surviving the
type filter, it asks whether `tests/acceptance/<issue-id>` exists as a directory on the
branch containers fork from, and refuses the issue when it does not. Refused issues are
dropped from `issues`, named in the queue-summary line with the remedy, and never reach
`claim()` — so Beads is untouched and they stay `open` for a freeze session to pick straight
up. Each is manufactured by a pure exported function into a `run.json` task row carrying the
new `undispatchable` outcome, which ranks second in scrutiny order behind `tampered`, so an
unattended run that refused half its queue says so at the top of its report instead of
leaving holes.

### Constraints

- **Fetch `targetRepoRemote` by URL with an explicit refspec, and read `FETCH_HEAD`.** Never
  `origin/…`, never the working tree, never a local branch. `targetRepoPath` and
  `targetRepoRemote` are independent config keys `runner/config.js` never relates, so a
  working copy whose `origin` points elsewhere would answer confidently about a different
  repository. The refspec is not optional: a bare `git fetch <url>` sets `FETCH_HEAD` to the
  remote's *HEAD*, silently discarding the resolved branch. Exactly
  `git fetch <targetRepoRemote> <branch>`, once per run, then
  `git ls-tree -d --name-only FETCH_HEAD -- tests/acceptance/<issue-id>` per candidate.
- **The fetch runs in a throwaway repository under the OS temp dir, never in
  `targetRepoPath`.** `FETCH_HEAD` is per-repository state, and writing it into the working
  copy an operator is using is a side effect this repo's readers are forbidden from having.
- **Lazy.** A queue with no candidates left after the type filter must not fetch and must not
  abort — otherwise a legitimately empty run becomes an exit-1 failure.
- **Resolve the branch without a literal fallback.** `pipeline.config.json`'s `defaultBranch`
  in the target working copy wins; otherwise `git ls-remote --symref <targetRepoRemote> HEAD`;
  otherwise abort. Do **not** reuse `runner/workspace.js`'s `detectDefaultBranch`, whose chain
  ends at the literal `'main'` — correct there, since it only runs against a fresh clone where
  `origin/HEAD` is always set, and catastrophic here, where guessing `main` for a `master`
  project empties `ls-tree` for every issue and refuses the whole queue with a confident wrong
  reason.
- **Keep the `-d`.** A suite committed as a single *file* must answer empty and be refused,
  matching the verifier, whose trailing-slash invocation would fail on a file too. This is not
  leniency to be tidied away later.
- **Bound every new `spawnSync`, and build them all from one place.** `gitTimeoutMs` (default
  60000, validated as a positive whole number exactly as `bdTimeoutMs` is at
  `runner/config.js:110`), exported as an options builder on the `runner/bd.js`
  `spawnOptions(cfg)` precedent — where the value is that *every* spawn in the module is built
  from it. An exported builder that some spawn ignores is scaffolding.
- **Failures are told apart by a field on the return value, not by message wording.**
  `readyQueue()` returns `{ ok: false, cause: 'git' | 'bd', error }`; `run.js` branches on
  `cause` so a fetch failure is not logged as "cannot read the Beads ready queue", which sends
  a person to the wrong system. The wording itself is not the contract — the run's log line
  lives behind `main()`, where no Docker-free test can reach it.
- **Rewrite `scripts/test-runner-workspace.sh`'s clone-failure check** to assert the run-level
  abort rather than the per-task failure. It currently points `targetRepoRemote` at
  `$REMOTE/nope.git` and asserts both a per-task `workspace preparation failed` line and
  rc=0; under the gate neither is reachable by any implementation. Do not delete it.
- **The check runs before `claim()` and writes nothing to Beads.** No note, no status change,
  no attempt-log line. Refused issues stay `open`.
- **Per issue, never per run.** The check stays in `queue.js`, not `runner/preflight.js`,
  whose blast radius is the whole run by design. Three frozen tasks and one unfrozen one runs
  the three.
- **The row construction is a pure exported function**, not inline code in `main()`.
  `main()` sits behind the token load and the Docker preflight, so anything written there is
  unreachable to every Docker-free test — the reason `queueSummary` was lifted out of it in
  the first place.
- **The manufactured row carries enough to be worth reading:** the issue id, the title, the
  `undispatchable` outcome, and an attempt-log note naming the remedy. The report renders a
  row's body from those fields, and a minimal row produces a section reading "no change
  summary produced" that tells the reader nothing to do.
- **`undispatchable`'s scrutiny rank is inserted fractionally, never renumbered.**
  `scrutinyKey`'s fallback for an unknown outcome is the literal rank `failed` holds, so
  renumbering silently re-homes every future unknown outcome. That fallback is not this
  task's to move.
- **The historic queue-summary prefix is appended to, never rewoven.**
  `ready queue: N task(s) — <ids>` is grepped by `scripts/test-runner-queue.sh` at six sites,
  and `scripts/dashboard.js` parses ids from the first ` — ` to the first `;`. The new clause
  goes **after** the existing `; skipped … by type:` and `; running … non-task:` clauses.
- **Do not weaken the tamper check** in `pipeline/verify.js`.
- **Docker-free frozen suite**, in `tests/unit/` with a `scripts/test-*.sh` wrapper the
  sweep's `scripts/test-*.sh` glob discovers, building throwaway bare remotes and working
  copies under the OS temp dir on the `tests/unit/trace.test.js` and `verdict.test.js`
  precedent. No git seam. Every fixture repository must pin `--initial-branch`, set the bare
  remote's `HEAD` symref explicitly (the `ls-remote --symref` path reads it), and set
  `commit.gpgsign=false` plus `GIT_AUTHOR_*` / `GIT_COMMITTER_*` — a container has no git
  identity and commits fail outright without them. The unreachable-remote fixture must be a
  **nonexistent local path, never a URL**: the container has no egress, so a URL fixture
  either fails for a DNS reason unrelated to the criterion or hangs.
- **Any `bd` stub is a `.js` file invoked through `process.execPath`** with a stand-aside
  guard as its first statement.
- **Amend `docs/pipeline-diagram.md` in the same PR.** It draws the runner as "drains the
  ready queue · epics skipped · priority, then FIFO" and names the epic filter as the only
  thing that keeps an entry out. `docs/pipeline-map.html` is hand-maintained and not a
  docs-phase obligation.
- **Nothing in the tracked tree may name the real target project.**

### Acceptance criteria — "Done means"

1. **The gate reads the repository the containers will clone, and reads it as a directory.**
   Five fixtures, all against the same queue:
   (a) `origin` in the target working copy points at a bare repo that **does** hold
   `tests/acceptance/<id>`, while `targetRepoRemote` points at one that does not → **refused**;
   (b) the mirror of (a) → **dispatched**;
   (c) the suite committed on the local default branch and never pushed → **refused**;
   (d) the suite sitting untracked in the working tree → **refused**;
   (e) a regular *file* committed and pushed at `tests/acceptance/<id>` → **refused**.
   *(a) and (b) are the pair that discriminates this design from the one it replaces — every
   other fixture is also refused by the `origin/<branch>` implementation the constraints
   forbid. (e) is the pair for `-d`.*

2. **A mixed queue dispatches the frozen ones, refuses only the rest, and says so in one
   pinned line.** Given four ready issues of which two have their suite on the pushed default
   branch, `readyQueue()` returns exactly those two in `issues` in priority-then-FIFO order
   and the other two in `undispatchable`, each entry carrying the bd issue and a reason; and
   `queueSummary()` returns a string beginning `ready queue: 2 task(s) — ` with the two
   dispatchable ids, and appending the refusal clause **after** the type-skip and non-task
   clauses, naming both refused ids and the remedy.

3. **Unreachable remote, unresolvable branch, and an exceeded bound all abort, dispatching
   nothing.** `readyQueue()` returns `{ ok: false, cause: 'git', error }` with `error` naming
   the remote and the branch, and no dispatchable issues at all — never a partial or fallback
   answer. The existing Beads failure path still returns `cause: 'bd'`. Driven against a
   **working** local bare remote with `gitTimeoutMs: 1`, the same abort fires — which is what
   proves the bound is applied to the spawn rather than merely exported. The exported options
   builder additionally carries a positive integer `timeout` and a kill signal.

4. **A refused issue never touches Beads, and always produces a row.** With the `bd` seam
   pointed at a stub recording its argv, a queue containing a refused issue produces exactly
   one `ready` invocation and zero invocations of `update`, `note` or `close` naming that
   issue. The exported row-construction function returns `issueId`, `title`,
   `outcome: 'undispatchable'` and an `attemptNotes` entry naming the remedy, and the refused
   population feeds it exactly one entry per refusal.

5. **The manifest and the report carry it honestly.** The `outcome` enum at
   `properties.tasks.items.properties.outcome.enum` in `schemas/run.schema.json` contains
   `undispatchable`; a realistic full-width `undispatchable` row is admitted by the frozen
   test's own validator, and an **invented** outcome such as `refused` is *rejected* on the
   same path — the check that proves the validator can say no. A manifest written from rows
   covering **all seven** outcomes plus one invented one comes back in the exact expected
   scrutiny order, with `undispatchable` immediately after `tampered` and the relative order
   of the other six unchanged. The rendered report's heading for the row matches the house
   shape (`UNDISPATCHABLE — …`) and its section names the remedy.

6. **[guard] Existing contracts are unmoved, and the invariant outlives the run.** For a
   summary line carrying refusals, `scripts/dashboard.js`'s ready-queue id parser returns
   exactly the dispatchable ids and none of the refused ones; for a queue with no refusals at
   all, `queueSummary()` is byte-identical to today, including the epic-skip and non-task
   clauses; the gate leaves the target working copy's refs and tree unchanged (a before/after
   snapshot); and a `scripts/test-<name>.sh` wrapper exists, is matched by the sweep's
   `scripts/test-*.sh` glob, exits 0, and prints at least N `ok - ` lines and zero `FAIL`
   lines. *A frozen suite runs once and never again — without the wrapper, this gate has no
   ongoing test at all.*

### design-ref

`DESIGN.md` §4.12 (the ready queue's second admission rule) and §4.11's `undispatchable` row.
Change-log row `dispatch-gate`.

### Difficulty

**Hard.** Five runner/schema files, one Docker suite rewritten, a new Docker-free suite whose
fixtures need bare remotes with an unpushed commit and an untracked tree, plus a diagram. It
also changes the *meaning* of the ready queue and repeals a shipped property. The first draft
was labelled medium; under `PLANNING.md` a medium spec normally gets one critic pass, and the
scope charter — the critic that found the unreachable-assertion blocker — is a hard-tier
critic. The label was wrong in the direction that would have hidden the finding.

---

## Panel dispositions

*(Every finding, acted on or refused with a reason. A finding silently dropped is
indistinguishable from one considered and rejected.)*

### From the fresh-context criteria draft (PLANNING.md step 1b)

| # | Finding | Disposition |
|---|---|---|
| 1 | `test-runner-queue.sh` and `test-runner-workspace.sh` break wholesale | **Accepted** — verified. Now explicitly out of the task, done by hand with a sweep as its verification |
| 2 | `detectDefaultBranch` unexported; its `'main'` fallback would refuse a whole `master` queue | **Accepted** — resolve without a literal fallback, do not reuse that function |
| 3 | Nothing relates `targetRepoPath` to `targetRepoRemote` | **Accepted** — fetch by URL, read `FETCH_HEAD`; criterion 1(a)/(b) is the fixture that proves it |
| 4 | `.filter(Boolean)` is the wrong framing; rows must be manufactured in `main()` | **Accepted** — and superseded by testability's finding that `main()` is untestable: a pure exported function instead |
| 5 | `report.js` needs `RANK` *and* `LABEL` | **Accepted** |
| 6 | The schema edit has a fork-point-image precedent | **Accepted** — and hardened per testability's finding |
| 7 | `scripts/batch.js` will report `ready` for an id that will not dispatch | **Accepted, upgraded** — scope critic was right that an inbox note is too weak for a regression this change introduces. Declared in §4.12 as a follow-up task depending on this one |
| 8 | `dashboard.js` cosmetic gaps; `/state` contract safe | **Deferred** — confirmed independently by the scope critic |
| 9 | `docs/pipeline-diagram.md` must change in the same PR | **Accepted** |
| 10 | `-d` is correct, do not relax it | **Accepted** — and now has criterion 1(e), which it lacked |
| 11 | No bound on the fetch | **Accepted** — `gitTimeoutMs`, and hardened per testability's finding |
| 12 | The handoff document names the real target project | **Accepted** — verified by staging it and running sanitize; it fails. Left untracked |

### Ambiguity critic — `concerns`, 11 findings

| Finding | Disposition |
|---|---|
| Fetch's working directory and refspec unspecified; a bare `git fetch <url>` sets `FETCH_HEAD` to remote HEAD and discards the resolved branch | **Accepted** — the highest-value finding of the three panels. Both pinned |
| The third population's key and `queueSummary`'s signature unnamed | **Accepted** — keyed `undispatchable`, entry shape pinned in criterion 2 |
| `readyQueue`'s two failure causes indistinguishable | **Accepted** — `cause: 'git' \| 'bd'` |
| The manufactured row's field set unpinned; a minimal row renders a useless report section | **Accepted** |
| The `LABEL` text pinned only by a negation | **Accepted** — house shape plus the remedy, criterion 5 |
| `scrutinyKey`'s fallback: three readings, none distinguished | **Accepted** — fractional insert, fallback untouched |
| §4.12's lead sentence still said `origin/<defaultBranch>` while its own bullet forbade it | **Accepted** — a defect introduced in this session's own amendment. Fixed |
| The summary clause's wording and position unpinned | **Accepted** — after the existing two clauses |
| The drain's closing line required by the design and by no criterion | **Accepted** — now a design rule; not a criterion, because it lives behind `main()` |
| Eager vs lazy fetch unstated; an empty queue would abort | **Accepted** — lazy |
| "Refused" already means the rate-limit population in `run.js` | **Accepted** — `undispatchable` throughout |

### Testability critic — `concerns`, 11 findings

| Finding | Disposition |
|---|---|
| Criterion 1 did not discriminate `FETCH_HEAD` from `origin/<branch>` — every fixture passed the forbidden implementation | **Accepted** — the `origin`-holds-it / remote-does-not pair is now criterion 1(a)/(b) |
| The timeout builder was a presence check a dead implementation passes | **Accepted** — paired with a behavioural `gitTimeoutMs: 1` abort against a working remote |
| "the log line is not the Beads-flavoured one" is unreachable Docker-free | **Accepted** — restated as `cause` on the return value |
| No criterion reached the code that manufactures the rows | **Accepted** — pure exported function, asserted directly |
| The schema half passes vacuously with a hand-rolled admitter | **Accepted** — enum located by path, plus an invented outcome that must be *rejected* |
| The return-shape key unpinned | **Accepted** (same as ambiguity's) |
| `-d` had no criterion | **Accepted** — criterion 1(e) |
| The report heading pinned by a negation | **Accepted** |
| The ordering fixture omitted `partial`, `failed`, `paused` | **Accepted** — all seven outcomes plus an invented one |
| Fixture git hygiene: `--initial-branch`, bare `HEAD` symref, `gpgsign`, author identity; unreachable fixture must be a local path not a URL | **Accepted** — all four. The container has no git identity and no egress |
| Uncovered: the working copy left untouched, and a C6-shaped sweep-discoverable wrapper | **Accepted** — both in criterion 6. Without the wrapper this gate has no ongoing test, because a frozen suite runs once |

### Scope critic — `concerns`, 8 findings

| Finding | Disposition |
|---|---|
| **Blocker:** `test-runner-workspace.sh`'s clone-failure check becomes unreachable by any implementation, and the change silently repeals "an unreachable remote is a task failure, not a run failure" | **Accepted** — verified. The repeal is now declared in §4.12 and the check's rewrite is a constraint. This is the finding of the session |
| Split the fixture repair from the gate | **Accepted with a different mechanism** — not two pipeline tasks (the repair has no behavioural signature and the freeze gate would refuse it) but host-side work first, whose sweep is the control |
| Label should be `hard`, not `medium` | **Accepted** — and the reasoning is self-demonstrating: at `medium` this critic would not have run |
| `batch.js` deferral too weak for a regression this change introduces | **Accepted** — declared follow-up, not an inbox note |
| Dashboard deferral correct; data half confirmed safe | **Accepted** |
| The drain's closing line has no criterion | **Accepted** (same as ambiguity's) |
| §4.12's leftover `origin/<defaultBranch>` sentence | **Accepted** (same as ambiguity's) |
| `gitTimeoutMs` missing from `run.config.example.json` and §4.12's key list | **Accepted** — both, in this diff |

---

## What you are approving

The plain-English "Done means" list and the difficulty label. Not the tests — those come
next, and you are welcome to read them, but the prose is the gate.

Once approved: the host-side fixture repair and its sweep, then the tests get written, the
freeze gate proves them red, the tests land on `main` and are pushed, the Beads issue is
created, and a batch marker is written. **Launching the run is yours, in the operator
session.**
