# Multi-Agent Pipelines — Design

> **Status: READY v1.0 (2026-07-25)** — this doc has passed its readiness bar (section 11)
> and is approved to drive development. Three critic-review + dry-run-decomposition rounds
> converged ~20 → ~7 → 4 findings; round 3 produced no decision requiring the user, only
> sentence-sized contract fixes (applied in v0.4), and a complete 21-task V1 backlog. The
> user approved intent and the pragmatic readiness rule on 2026-07-25.

This document is the project's constitution: what we're building, the decisions already made
and why, and what's out of scope. Task-level specs are derived from it (as Beads issues) and
cite it — they don't repeat it. When reality disagrees with this doc, the doc gets amended
(see "Change Protocol"), never silently ignored.

This document supersedes an earlier private handoff note, merging the execution
architecture that note defined with the spec-layer design agreed on 2026-07-25.

## 1. Goal

The user queues development tasks whenever it suits them. The pipeline then works through
the queue autonomously — unattended, for hours at a time — using headless Claude Code, each
task in its own locked-down Docker container. When the run finishes, completed work is
waiting as GitHub pull requests plus a run report, ordered by how much scrutiny each item
needs. The user's time goes into two high-leverage moments — approving intent before a run,
reviewing results after — and nothing in between.

The pipeline's own code (runner, image, entrypoint, verifier, playbook, schemas) lives in
**this repository** (`Multi-AgentPipelines`). Target projects are normally separate
repositories the pipeline operates on — with one sanctioned exception: this repository is
itself onboarded as a target (dogfooding), so pipeline development tasks can run through
the pipeline. Safe because each task works on a fresh clone of the remote in a temp
directory, never the live checkout. Constraint: task containers cannot run Docker, so
acceptance tests for self-tasks must be plain Node/shell checks; work only the Docker
suites can verify stays interactive.

## 2. The Three Phases

The system moves through three phases, joined by the Beads work queue:

```
PLANNING (interactive)              IMPLEMENTATION (autonomous)         REVIEW (interactive)
──────────────────────────          ───────────────────────────         ────────────────────
Design doc session                  Runner loops the Beads queue        Run report, ordered
  → decompose into task specs         → fresh container per task        by scrutiny needed
  → critics attack each spec          → code → verify → retry loop      PRs approved, merged,
  → acceptance tests written          → local commit on success         or sent back with
    and frozen                        → host pushes branch, opens PR    notes as new tasks
  → user approves intent            Report generated at run end
  → specs become Beads issues
```

**Planning is always interactive; implementation is always autonomous.** Specs and tests are
written with the user before a run starts; nothing during implementation can change what
"done" means. A run can happen overnight, over a lunch break, or while the user does other
work — the design doesn't care when.

## 3. The Planning Phase (the spec layer)

### 3.1 Three levels, one owner each

| Level | What it holds | Canonical home | Frozen? |
|---|---|---|---|
| Design doc | Project intent, architecture, decisions + why | `DESIGN.md` in the project's repo | Amendable via change protocol |
| Task spec | One bounded task: description, constraints, "Done means" criteria, attempt log | A Beads issue | Frozen at approval |
| Acceptance tests | Machine-checkable proof of each criterion | `tests/acceptance/<issue-id>/` in the repo | Frozen at approval (verifier `git diff`-checks them) |

**Epics group specs; they are never work.** The three levels above are the whole of what
runs. Beads also supports a hierarchical parent (`bd create -t epic`, children carrying
`parent_id`), and the pipeline uses it for exactly one thing: giving a reviewer a place to
see that several specs are one feature. An epic holds a title and a design-ref and nothing
else — **no acceptance criteria, no frozen tests, no container run, no pull request**. The
1:1 rule is untouched: one *spec* is still one issue, one run, one PR.

Two facts make the exclusion mandatory rather than cosmetic, both verified against
`bd 1.1.0` rather than assumed. **`bd ready` returns the epic itself**, ranked among its
children, so an unfiltered runner would clone a workspace for it and hand an agent a spec
with no criteria. And **closing every child does not close the parent** — the epic stays
open and ready, so it would be re-picked on every subsequent run, forever. The runner
therefore skips any ready-queue entry whose `issue_type` is `epic`, and drains every other
type (§4.12 says why it is a deny-list and not an allow-list). That is a deterministic
type check on a field `bd ready --json` already returns (hard rule 7) — never a heuristic
over the title, and never an LLM.

**Who decides what is an epic.** The human does, at planning time, exactly as with
priority and the difficulty label (§3.3): the decomposer proposes, the user approves.
Nothing infers it. The criterion is narrow — an epic is worth creating when two or more
specs implement the same design-ref section and want reviewing together — and if a
would-be epic has acceptance criteria of its own, it is a spec that has not been
decomposed yet, not an epic.

*Built* (`repo-4l8`): `queue.readyQueue()` applies the filter and returns the skipped
entries alongside the survivors, and `queue.queueSummary()` names them in the run log — so
an epic that never runs is still visible in the place a reviewer already reads.

One canonical home per artifact; everything else (PR descriptions, the run report) is a
generated copy, never edited by hand. Each Beads issue carries a `design-ref` naming the
design-doc section it implements — this makes two checks cheap: doc sections with no issue
(coverage gap) and issues citing nothing (scope creep).

**Issue fields.** The five spec fields (description, constraints, acceptance criteria,
`design-ref`, attempt log) are stored as structured markdown sections in the issue
description, using Beads' native fields wherever one exists (status, dependencies,
priority). The exact mapping is finalized by the Beads setup task; the rule that matters at
doc level is: all five fields must round-trip through a `bd` dump so scripts can check them.

**Test freeze mechanism.** "Frozen" means: the acceptance test paths as they exist at the
task branch's fork point from the integration branch (`git merge-base <defaultBranch> <branch>`, see 3.4). The verifier diffs
the test paths against that fork point; any difference is tampering, regardless of test
results.

### 3.2 The pipeline for producing specs

1. **Design doc session.** Bounded interview (3–5 batched questions), draft, then doc-level
   critics simulate the questions development will ask. Unresolved unknowns become explicit
   assumptions the user approves with the doc. The readiness test is a dry-run decomposition.
2. **Decomposition.** An agent slices the approved doc into task-sized specs with a
   dependency order, labeling each task trivial / medium / hard. One spec = one issue = one
   container run = one PR the user can review in a few minutes; the decomposer splits
   anything bigger.
3. **Per-spec pipeline.** Draft → critics sized to the difficulty label (none for trivial,
   light for medium, full panel for hard: ambiguity, testability, scope) → the pipeline
   writes the acceptance tests → a coverage check pairs every "Done means" item with a test
   and every test with an item; orphans on either side are spec bugs.
4. **Approval and freeze.** The user approves intent at the design-doc level once; the
   decomposed backlog is reviewed as a single list pass (checking the slicing, not
   re-litigating intent). On approval: tests committed and frozen, Beads issues created,
   new dependencies declared (see 3.4) for the image rebuild.

Small standalone chores may skip the doc layer and enter at step 3 with just a spec — but
large, doc-first projects are the default path.

**V1 deliverable.** In V1 the planning session is a written playbook — `PLANNING.md` in
this repo — that the user and Claude follow interactively: draft spec + tests, approve
intent, commit/freeze tests, create the issue, declare dependencies, rebuild the image if
needed. No planning tooling is built in V1; V2 packages the playbook as the `/spec` skill.
The playbook's acceptance bar is structural (every step above present, the conventions in
3.1/3.4 stated correctly); whether it is *followable* is proven by the shadow-mode trial,
not by a script.

### 3.3 Approval model and change protocol

- The user is the check on **what** gets built (plain-English intent); the AI owns **how
  it's verified** (it writes better tests). This division is the heart of the design.
- **Developers may open the hood.** The plain-English criteria are the required gate for
  everyone; a developer may additionally inspect the drafted test files before they
  freeze, and challenging a test reopens the draft like any other approval feedback.
  Optional by user, never required — Claude offers, never insists. (Added when the tool's
  audience widened from its original non-programmer owner to senior developers.)
- **The difficulty label and the queue order are the user's decisions**, proposed by
  Claude: the trivial/medium/hard label is part of the approval pass (it sizes the
  critics), and priority + dependencies are set by the user at issue creation — that,
  plus which issues exist, is how a user chooses what a run works on (the runner has no
  picker; it drains the ready queue as shaped).
- The approval gate reopens only when a spec must deviate from the doc.
- Drift flows upward: an agent reporting "the spec is wrong" is a first-class result, not a
  failure. It can trigger a spec fix (re-approve, re-freeze tests) or, when the cause is
  architectural, a doc amendment. Both the doc and each issue keep a change log.

### 3.4 Per-project pipeline config

Each target project carries a `pipeline.config.json` in its repo root, written once
during **onboarding** and read by the scaffolding. Onboarding — the once-per-project
setup that makes any repo a valid target (this config, the frozen-test home, the
per-project image, Beads, a container-aware `CLAUDE.md`) — is specified in
`ONBOARDING.md` in this repo, which also documents the full path from an empty folder
(scaffold → design doc → onboard → plan) and the life of a project afterward. The config
fields:

- `verifyCommand` — the verifier invokes it with the test directory appended as the final
  argument: `<verifyCommand> tests/acceptance/<issue-id>/`.
- `regressionCommand` (optional) — the project's standard test suite. Its *presence* is
  what "a standard suite exists" means; there is no auto-detection. See 4.4 for how its
  result is used.
- `defaultBranch` (optional) — the project's integration branch. Real repositories are
  `master` as often as `main`, so the pipeline never assumes: this value wins, else the
  runner asks the remote for its HEAD, else `main`. It is what task branches fork from,
  what the freeze baseline is measured against, and what pull requests target.
- `frozenPaths` (optional) — repo paths beyond `tests/acceptance/` that the verifier's
  tamper diff must also cover (e.g. a test-runner script that `verifyCommand` invokes).
  Anything `verifyCommand` executes from the repo belongs in this list.
- `dependencies` — the declared-dependency manifest: package lists keyed by package
  manager (e.g. `{"apt": [...], "npm": [...]}`). **No arbitrary install commands.** The
  per-project image layer is a hand-written thin Dockerfile living in the target repo
  beside this config; the playbook (and the E2E pass) cross-check the Dockerfile against
  the manifest so they cannot silently drift. Rebuilding the image is a manual pre-run
  step in the playbook; the runner only asserts the image exists and fails fast otherwise.

### 3.5 Domain specialists (physics, aesthetics, security, …)

Projects need domain judgment the general pipeline doesn't have: is the simulation
physically consistent, is the interface visually coherent, does this touch an auth path.
Specialists supply it. The governing rule:

> **Judgment happens at planning time; run time stays deterministic.** An LLM judge
> cannot be frozen — it may pass a task on one attempt and fail identical code on the
> next. A fuzzy gate would destroy the retry loop's steering signal, void the attempt-cap
> invariant, and produce unactionable failures. Therefore **no specialist is ever a
> gate.** The frozen acceptance tests remain the only authority (4.4).

Specialists occupy three slots, in descending order of leverage:

1. **Planning critic.** A specialist joins the sized critic panel (3.2) and attacks the
   draft spec through its lens: "nothing here checks conservation of momentum," "the
   spacing scale is never pinned." Cheapest slot, no run-time cost, and it improves the
   artifact everything downstream depends on.
2. **Test author.** The specialist writes the acceptance tests for its domain — the
   approval model (3.3) applied to a narrower lens. Most domain judgment reduces to
   deterministic checks: energy conserved within a tolerance, dimensional analysis,
   contrast ratios, spacing-scale adherence, no hardcoded colors outside the token file.
   A test steers the retry loop; a review does not. **Prefer this slot whenever the
   domain admits it.**
3. **Run-time advisor.** Only for judgment that genuinely resists determinism ("does this
   screen feel like the same product?"). After verification passes, a declared advisor
   inspects the change and writes a structured note — carried into the PR body and run
   report as **recorded evidence, never a gate**, exactly like the regression suite
   (4.4). It cannot change the exit code.

**Escalation ladder.** An advisor that keeps flagging the same thing is a signal to
convert that check into a deterministic test or lint rule — the same reflex as 4.9's
"recurring API-ignorance failures mean vendor the docs." Judgment migrates leftward into
frozen tests over time, so the pipeline sharpens instead of accumulating noise.

**How specialists plug in — data, not control flow.** The phase sequence stays fixed
scaffolding (4.3); only a declared list varies, so the orchestrator stays dumb:
- **Registry:** each specialist is a definition file in this repo (`advisors/<name>.md`)
  stating its lens, what it checks, and the structured output it must return. Versioned,
  reusable across projects. **Built** — `advisors/README.md` pins the charter format
  (`## Lens` / `## Checks` / `## Output`, one JSON fence matching the `advisories` item
  shape), and `ambiguity.md`, `testability.md`, `scope.md` staff the slot-1 panel.
- **Selection:** `pipeline.config.json` lists the project's specialists; an issue field
  names the ones that apply to that task. Opt-in per task, never blanket — each advisor
  is another `claude -p` call against the subscription window.
- **Contract:** advisor output is schema-checked like every other artifact (an
  `advisories` array in the status file), so PR assembly and the report never parse
  free-form prose (4.11).
- **Slot:** the entrypoint sequence becomes code → verify → **[declared advisors]** →
  docs → commit. One new fixed slot, populated from data.

**Phasing.** V1 builds none of this — the dumb loop must prove itself first (8), and the
shadow trial is the experiment that reveals which specialists are actually wanted (every
"I wish something had checked X" during PR review is an advisor request with evidence).
The shape is decided here because the advisor slot spans three separately-built
components (entrypoint, PR assembly, report) — §10's dividing line — and because the
frozen schemas would otherwise need a breaking change later. Specialist critics and test
authors (slots 1–2) arrive with the V2 `/spec` skill; run-time advisors (slot 3) follow
only if the trial shows something that genuinely cannot be made deterministic.

The registry itself landed early, in the dogfood queue: the charter format and the three
generic planning critics exist now and are run by hand from `PLANNING.md` step 2. That
does not move V2 forward — no code reads `advisors/`, no phase changed, and a charter is
still a prompt a human pastes. What V2 adds is dispatch, not content.

### 3.6 Memory (knowledge that outlives a task)

Beads is the project's **memory store as well as its task queue** — the upstream
convention, not an invention of this pipeline: `bd remember` stores keyed insights in the
same per-repo database, and `bd prime` injects them at session start (verified against
bd 1.1.0 in the base image). There is **no second database**; what varies between the
phases is only *who holds the pen*, consistent with the sole-writer rule (4.10).

**Knowledge hierarchy — one canonical home per kind:**

| Kind of knowledge | Canonical home | Why there |
|---|---|---|
| Anything a container-side coding agent must know (conventions, gotchas, API specifics) | Repo files (`CLAUDE.md`, `docs/`) | A fresh clone is the only guaranteed container input (4.10); repo files need no export step and are reviewed with the code |
| Project insights and operational notes | Beads memory (`bd remember`) in the target repo's database | Structured, keyed, queryable; primed into every interactive session |
| Per-task history (attempts, stuck-state) | The issue's attempt log | Unchanged (3.1) |
| Machine-specific facts (paths, device names, local ports) | An untracked local note beside the repo | Never syncs, so a shared repo stays portable and free of one machine's details |

**Access rule.** Interactive sessions on the host (planning, review) use `bd remember` /
`bd prime` directly — the standard convention; task issues remain writable only through
the wrapper scripts. Autonomous agents never touch the database (they physically cannot —
4.10). Instead:

- **Out:** the entrypoint accepts a `memoryNotes` array in the status file — short
  insights the coding or docs agent wants to persist ("this API rejects batch calls",
  "tests assume port 3000 free"). After container exit the runner — already the sole
  Beads writer — files each note via `bd remember`, keyed `<issue-id>-note-<n>`: the
  issue id is the audit trail, and because the key updates in place, re-running an issue
  overwrites its notes instead of duplicating them. Agents propose; the host commits.
  Two rules make the channel safe to leave unattended. **Terminal, trusted outcomes
  only** — notes are filed for `done`, `partial`, `failed`, and `stuck`, never for
  `tampered` (an agent that failed the trust check does not get to seed project memory)
  and never for `paused` (not terminal; the task files its notes when it finishes). The
  gate is stated once, as `memory.shouldFileMemory(status)`, which the runner calls and a
  Docker-free suite can reach; it fails closed on any status the runner does not know.
  **The host re-enforces the schema bounds** — the file is agent-written, so the runner
  trusts it to have respected `status.schema.json` no more than the entrypoint does:
  first 20 notes, first 500 characters each, the rest dropped. Like the In channel,
  filing is non-fatal: a `bd` failure is logged and the outcome is untouched.
- **In:** at workspace prep, before container launch, the runner exports current project
  memories to a read-only file at `/workspace/.run/memory.md`, beside `issue.md` — the
  container-side mirror of `bd prime`. The export is a convenience, never a
  precondition: a `bd` failure is logged and the run continues with the file written as
  `(no memories recorded)`, so memory can never cost a task.

**Promotion rule (the 3.5/4.9 escalation ladder, applied to memory).** Memory notes are
an inbox, not a destination. A memory that keeps mattering to coding runs — the same
gotcha proposed twice, the same API misunderstanding — gets promoted at review time into
repo files (a `CLAUDE.md` convention, a vendored doc), where it steers every future agent
with no export step. Knowledge migrates leftward into the repo over time, exactly as
advisor judgment migrates into frozen tests. So the rule has something to act on, the
attempt log (4.11) carries a `memory notes: <count>` line whenever a task proposed any —
review sees that notes were filed without having to query the database.

**Phasing.** The contract (the `memoryNotes` status-file field, the `.run/memory.md`
mount) is decided here because it spans the entrypoint, the runner, and
`status.schema.json` — §10's dividing line. The plumbing ships with the shadow trial;
the V1 E2E fixture pass does not exercise it.

### 3.7 Spec concerns (the "this spec is wrong" channel)

§3.3 states that drift flows upward: an agent reporting "the spec is wrong" is a
first-class result, not a failure. V1 gave that principle no mechanism. An agent that
believed its frozen spec was wrong could only comply — and shadow-01 showed exactly what
that costs: the agent wrote the correct implementation on attempt 1, diagnosed the broken
acceptance gate correctly in its own notes, watched it fail the task anyway, and then
contorted correct code until the broken gate went green. It knew, and had no way to say
so. This section closes the gap without weakening anything.

The status file carries an optional `specConcerns` array of strings. The coding and docs
agents may append to it with `status.js concern "<text>"`; after exit the host reads it
and surfaces the entries where a human reviewing the run already looks — the attempt log,
the run manifest, the run report, and the PR body. Bounds: **at most 5 entries, each
truncated to its first 1000 characters**, using the mechanism `status.js note` already
provides for `memoryNotes` but with different numbers. A spec concern is rarer than an
insight and needs more room to be actionable.

**A concern is evidence and never a gate** (§3.5). It cannot change an outcome, an exit
code, a Beads transition, or whether a branch is published — the same posture as
`advisories`, and what keeps the three-attempt cap meaningful: an agent must not be able
to escape a task it dislikes by declaring the spec broken. What a concern does is reach
the human at review time, where changing a spec is legal. That is §3.3's approval gate
reopened deliberately, rather than a run rewriting its own definition of done.

**Phasing.** Like §3.6, the contract is decided here because it spans the entrypoint, the
runner, and `status.schema.json` — §10's dividing line — and it is declared before either
half is built, so no container has to invent it. The container-side half (the schema
field, the writer, the prompt text) and the host-side half (surfacing) are separate
tasks, sequenced: the host side cannot run in the same batch, since the runner reads the
ready queue once before the task loop.

## 4. The Implementation Phase (the execution layer)

Carried over from v3, amended over two critic-review rounds; this section is the single
source of truth.

1. **One orchestrator, on the host, outside every container.** A deterministic runner
   script — not an LLM. It enforces timeouts and kill switches; the enforcer cannot live
   inside the thing it may need to kill.
2. **One fresh container per task, repo supplied by the host.** For each Beads issue the
   runner clones the target repo fresh **from the GitHub remote** (so every branch forks
   from the canonical `main`) into a per-task temp directory on the host, creates branch
   `task/<issue-id>`, and bind-mounts the clone read-write at `/workspace` in the
   container. If a branch of that name already exists on the remote (the issue was re-run
   after a spec fix), the runner suffixes a run counter — `task/<issue-id>-r2`, `-r3` —
   and **never force-pushes**, so earlier attempts survive. The container never talks to a
   git host (see network policy); its local commits land on the host filesystem and
   therefore survive container teardown. Fresh container + fresh clone every time;
   everything inside the container is disposable, so "kill the container" is always safe.
3. **Inside the container, agents are ephemeral headless invocations** (`claude -p`,
   run with permissions bypassed — acceptable *only* because the container has a closed
   network, a disposable filesystem, and no credentials) in a fixed sequence driven by the
   entrypoint script: **code → verify → (retry, up to the attempt cap — default 3) → docs → commit**.
   The agent command is read from the `PIPELINE_AGENT_CMD` environment variable,
   defaulting to the headless `claude -p` invocation when unset — this is the deliberate
   test seam that lets the E2E pass substitute deterministic stubs (see section 7). The docs phase is one agent invocation
   that writes the change summary into the status file and updates in-repo docs the change
   affects; if the docs phase itself errors after verification has passed, the success
   stands (docs failure is logged, never fatal). Phases of a task are scaffolding, not an
   LLM decision. No leader agent inside. **Agent output is a contract artifact, so it is
   read structurally, never scraped.** When the entrypoint owns the invocation (no
   `PIPELINE_AGENT_CMD`) both agent phases request `--output-format json`, and the
   envelope reader (`pipeline/envelope.js`) takes the last line of the log that parses to
   a JSON object with a string `result` — that result is the change summary, and the
   resolved model id recorded per 4.11 is **selected** from its `modelUsage`, never simply
   taken in listed order: `modelUsage` enumerates every model the CLI billed, and the cheap
   internal helper model is listed *first*, ahead of the pinned model that did the work.
   The selection rule is deterministic and applied in order: (1) the pinned alias, passed
   through from `PIPELINE_MODEL`, matching exactly one key case-insensitively as a
   substring of the key or of that entry's `canonicalModel`; (2) otherwise the only key,
   if there is one; (3) otherwise the key with the greatest `outputTokens`, a missing or
   non-numeric count reading as 0 and ties broken by key name ascending; (4) otherwise
   null. An alias that matches nothing still records the rule-3 choice and emits a
   diagnostic naming the alias and the keys seen — never fatal, and never silenced, since
   the wrong id going unnoticed is exactly the failure this rule exists to end. The rule is
   deliberately structural: a CLI that prints warnings around its own output must never
   require a list of known warning strings to filter, and a log with no envelope (a stub,
   a caller-supplied command, an error page) falls back to its raw text unchanged. The
   docs phase additionally keeps stderr out of the file its summary is read from, and the
   entrypoint seeds this workspace's trust/onboarding flags into the CLI's config before
   the first call so the untrusted-workspace warning is not emitted at all.
4. **The verifier is scaffolding, not an agent.** Mounted read-only (a container-side test
   asserts it cannot be written), it receives the issue id via the `ISSUE_ID` environment
   variable and executes `<verifyCommand> tests/acceptance/<issue-id>/`; its pass/fail is
   authoritative — "the agent says it's done" counts for nothing. It reads
   `pipeline.config.json` **from the fork-point commit, never from the working tree** —
   otherwise the coding agent could simply edit `verifyCommand` — and before every check
   it `git diff`s **all of `tests/acceptance/` plus the config's `frozenPaths`** (every
   frozen test and frozen helper, not just this issue's directory — during a run none of
   them may change, and untracked additions count) against the fork point (3.1); any
   difference is the dedicated "tampered" outcome. When
   `regressionCommand` is present it runs that too, as **recorded evidence, not a gate**:
   acceptance tests decide pass/fail, and a passing task with failing regressions is
   reported as "partial," never "done." The verifier writes machine-readable results to
   `/workspace/.run/verify.json` — schema `verify.schema.json`, checked into this repo,
   owned by the verifier task and cited as a frozen input by the runner and report tasks
   (mirroring `status.schema.json`) — and its output is fed into the next coding attempt
   as feedback.
5. **Git isolation; the host pushes everything that exists, PRs only what passed.** Every
   task gets a fresh branch off `main`; nothing touches `main`. After the container exits,
   the runner pushes the task branch **whenever it has commits — including WIP commits
   from stuck, tampered, or failed tasks** — so no committed work is ever destroyed and
   the review phase can inspect failures. (Uncommitted work in a killed container is
   discarded by design — that is what "kill is always safe" costs, and the entrypoint
   commits at every meaningful boundary to keep the loss window small.) A pull request is
   opened for **every exit-0 task — "done" and "partial" alike** (a partial PR is flagged
   with its failing regression evidence and sorts to the top of the report); stuck,
   tampered, and failed branches are linked from the run report and the issue instead.
   The container holds no git credentials (a test asserts `git push` from inside fails).
   The PR body is assembled by the host from the issue spec, the change summary in the
   status file, and `verify.json` — nothing parses free-form agent prose.
6. **Budgets and hard exits — time and attempts, not money.** Two budgets only: max
   **active** wall-clock per task (host-enforced, default 4 hours, pause time excluded —
   see next item) and a per-task verify-attempt cap — default 3, tunable per run via `maxAttempts` in `run.config.json`, forwarded to the container as `PIPELINE_MAX_ATTEMPTS` (entrypoint-enforced, counted in the
   status file). After the final allowed attempt: write the stuck-state to the status file,
   commit clearly-labeled WIP (message prefix `WIP:`), exit with the "stuck" code. On
   detected tampering the entrypoint likewise commits WIP first (evidence survives) and
   exits with the "tampered" code. One task failing must never block the next. There is
   **no cost ceiling**: consumption is naturally bounded by finite queue × 3 attempts ×
   wall-clock cap, and the subscription window itself is the spending limit — see next
   item.
7. **Rate limits are pauses, not failures — and the only "billing" mechanism.** The
   pipeline runs on a Claude subscription. When a `claude -p` call fails with a
   usage-limit error, the entrypoint exits immediately with the "rate-limited" code,
   recording the window-reset time in the status file when the error reports one. The
   runner parks the task — the pause is an attempt-log note; the issue simply stays
   in-progress — waits until the reset time or, if none was reported, probes on a fixed
   interval (default 15 minutes) with a minimal `claude -p` call **run directly on the
   host** (the host has the CLI and token; see section 6). It then relaunches a **fresh
   container reusing the same host-side clone and workspace**: `/workspace/.run/` persists
   across the relaunch, so the entrypoint reads the prior attempt count from the status
   file and continues it — the attempt cap is a per-task invariant, never reset by a
   pause. Active time before the pause counts against the wall-clock budget (host-tracked);
   paused time never does. A run may span multiple usage windows. A rate limit is never
   recorded as a task failure, and an interrupted attempt is not a failed attempt.
   **The pause loop is bounded per task**, by a count of wait cycles — `maxPauseCycles` in
   `run.config.json`, default 96 (~24h at the 15-minute probe cadence). The bound is
   per-task and not per-wait: a reported reset time makes each wait return after a single
   cycle, so the count must carry across relaunches or it restarts at one on every pause
   and can never fire. Without that carry, a container that keeps reporting an already-
   elapsed reset time relaunches forever — the wall-clock budget cannot catch it, because
   paused time is deliberately excluded from it. When the bound is reached the task stays
   `paused`: work is preserved and the operator decides, since a pipeline that cannot get
   a usage window has nothing useful left to try.
8. **Closed network.** Container egress is allowlisted to **the Anthropic-operated
   endpoints headless Claude Code requires to function** (API plus auth/token refresh),
   enumerated explicitly in the proxy configuration — and nothing else: no git hosts, no
   package registries, no third-party hosts. Mechanism: an internal no-egress Docker
   network plus an HTTP CONNECT proxy sidecar with a domain allowlist (TLS passed through,
   not intercepted), reached by the CLI via standard proxy environment variables. The
   *mechanism* may be revisited at implementation; the *policy* — Anthropic endpoints
   only, each one listed in config — may not. The starting allowlist is
   `api.anthropic.com` plus whatever auth endpoints empirical testing of headless
   `claude -p` shows are required; the enumeration is finalized (within the policy) by the
   network task. A **pre-run egress check** (throwaway container: allowed endpoint
   reachable, at least two non-allowlisted hosts unreachable, bounded under 60 seconds)
   runs before every run and **aborts the run** on failure. Dependencies are baked into
   the image at planning time (see 3.4). Knowledge gaps are mitigated in the repo
   (vendored docs, `CLAUDE.md` conventions, API details attached to the issue at planning
   time). Tasks needing live internet research belong in the interactive queue, not the
   autonomous one.
9. **The run report is a first-class deliverable.** Generated at the end of every run from
   the run manifest + Beads + git (see 4.12) into the run's log folder, as markdown,
   regeneration-idempotent, never hand-edited. Per task: report status (see the 4.11 table), branch, what changed,
   verification evidence, attempt notes. Ordered by scrutiny needed:
   **tampered > stuck > partial > failed > done-with-retries > done-first-try**, ties
   broken by attempt count then diff size. "Paused" appears in a final report only if the
   operator stopped the run before a window reset; otherwise the run ends only when the
   queue is drained. Recurring "didn't know the current API" failures mean vendor those
   docs, not open the network.
10. **Workers are stateless; hierarchy is flat; the host owns all durable state.** The
    container's inputs are exactly: the `/workspace` mount; the pipeline scaffolding
    (entrypoint + verifier) bind-mounted **read-only at `/pipeline` by the runner from
    this repo** — the base image stays scaffolding-free, so scaffolding changes never
    require an image rebuild; the issue exported to a read-only file mounted at
    `/workspace/.run/issue.md`; the project memories exported to a read-only file at
    `/workspace/.run/memory.md` (3.6); and the environment variables `ISSUE_ID`,
    `PIPELINE_AGENT_CMD` (normally unset — see 4.3), `PIPELINE_MAX_ATTEMPTS` (the 4.6
    attempt cap), the OAuth token, and proxy variables. The container command is the entrypoint at its `/pipeline` path. The
    entrypoint composes the coding prompt from the issue file; the runner writes a
    `.git/info/exclude` entry for `.run/` at clone time so contract artifacts never end
    up in commits. Every spec,
    verifier run, and result is logged with trace IDs back to the issue. "I couldn't
    because X" is a result type, not an error. **The host runner is the sole Beads
    writer**: attempt notes travel back via the status file and the runner appends them to
    the issue after exit, and proposed memory notes travel the same way — the runner files
    them via `bd remember` (3.6). Beads data never rides task branches.
11. **The outcome taxonomy — one table, cited by every component.** The contract between
    entrypoint, runner, and report generator:

    | Outcome | Exit code | Report status | Beads status after | Branch pushed? | PR? |
    |---|---|---|---|---|---|
    | Acceptance pass, regressions pass or absent | 0 | done | closed | yes | yes |
    | Acceptance pass, regressions fail | 0 | partial | closed | yes | yes, flagged |
    | Bailed at the attempt cap (default 3) | 10 | stuck | blocked | yes (WIP) | no |
    | Test tampering detected | 11 | tampered | blocked | yes (WIP) | no |
    | Usage limit hit | 20 | paused (transient) | in-progress (runner parks it) | not yet | not yet |
    | Internal error | 30 | failed | blocked | if commits exist | no |
    | Wall-clock kill (host `docker kill`, no exit code) | — | failed, timeout noted | blocked | if commits exist | no |

    The runner distinguishes done from partial by reading `verify.json`. The runner sets
    an issue in-progress when its task starts; **blocked** is what takes failed work out
    of the ready queue (it needs a human decision in review — fix the spec, fix the doc,
    or drop it), so the run loop can never re-pick a failed issue. Timeout kills treat
    the status file as best-effort (it may be half-written). Alongside the codes, the
    entrypoint maintains `/workspace/.run/status.json` — attempt summaries (number,
    verifier result, timestamp), the docs-phase change summary, the resolved model id
    (4.3), the rate-limit reset time when known, any proposed memory notes
    (`memoryNotes`, 3.6), and any spec concerns the agent raised (`specConcerns`, 3.7 —
    evidence only, like `advisories`). The summary and the model id are the two artifacts the host
    reuses verbatim (PR body, manifest, report), so both are extracted deterministically
    by scaffolding — 4.3's envelope rule — and never by an LLM re-reading agent prose. Its schema is `status.schema.json`, checked into this repo, owned by the
    entrypoint task and cited as a frozen input by the runner and report tasks.
12. **Runner configuration, lifecycle ownership, and logs.** The runner reads
    `run.config.json` in this repo: target repo path and remote, image name, wall-clock
    default, the attempt cap (`maxAttempts`, default 3 — see 4.6), probe interval,
    network/proxy identifiers, and an optional `agentCommand`
    override (passed into containers as `PIPELINE_AGENT_CMD` — how the E2E pass injects
    its stubs). **The runner owns the run lifecycle end to end:** at run start it creates
    the internal network and proxy sidecar, invokes the pre-run egress check (aborting on
    failure), and resets any issue left in-progress by an abnormal earlier end (operator
    stop, crash) back to open with an attempt-log note; at run end it tears the network
    and sidecar down. Task order: Beads' ready queue (open, unblocked, dependencies
    satisfied), **with `issue_type: "epic"` excluded**, ranked by Beads priority,
    first-in-first-out within the same priority. The type filter is what keeps an epic out
    of the run (§3.1): `bd ready` returns the parent alongside its children and never
    closes it when they close, so without the filter the runner would attempt an epic on
    every run for the life of the repository. A deterministic check on a field the queue
    already returns — no heuristic, no LLM.

    **Excluded by name, not by allow-list.** `bd` also has `bug`, `feature`, `chore` and
    `decision` types, and the runner drains all of them. Admitting only `task` would be
    stricter and worse: a legitimately-typed issue carrying a full spec would vanish from
    every run with nothing to say why, which is the silent-failure family this design
    keeps paying for. Skipping only the type that is *defined* as not-work fails loudly
    instead — a mistyped issue with no criteria gets a run, bails at the attempt cap, and
    appears in the report where someone can see it. The runner logs the id and type of
    everything it skips, and of anything it runs whose type is not `task`.
    The Beads database's canonical home is the working copy at the configured
    target-repo path on the host; the runner runs `bd` against it, and in V1 (single
    machine) its state is not pushed anywhere. **The runner writes a per-run manifest**
    — `runs/<run-timestamp>/run.json`, schema `run.schema.json` checked into this repo,
    owned by the runner task — recording per task: issue id, branch, exit code (or
    `killed`), the derived 4.11 outcome, attempt count, and PR URL if any. The report
    generator reads the manifest (plus Beads + git) as a frozen input; Beads alone
    cannot reconstruct report statuses, since stuck/tampered/failed all map to blocked.
    Per-run logs, trace IDs, collected status files, the manifest, and the run report
    live under `runs/<run-timestamp>/` in this repo on the host, git-ignored. The
    container-side isolation assertions (no `git push`, read-only verifier, no
    non-allowlisted egress) live in this repo and run as part of the E2E pass and on
    demand.

## 5. The Review Phase

The user reads the run report and works through the PRs it points at, most-scrutiny-first.
Each PR carries everything needed to judge it without archaeology: the spec, the change
summary, and the verification evidence. Outcomes per PR: merge it, or send it back — and
"send it back" means writing feedback that becomes a new task through the normal planning
phase, not editing the branch by hand. Stuck, tampered, and failed tasks arrive as pushed
WIP branches linked from the report, with their full attempt history on the issue and a
**blocked** status that keeps them out of future runs until the review decides: fix the
spec (re-approve, re-freeze, unblock), fix the doc, or drop the task.

## 6. Environment and Constraints

- **First target: a single developer workstation** (Windows 11, Docker Desktop). Other
  environments — a machine whose repos live on a network share, or one already running a
  different container workflow — are a later port (see Phasing); nothing in V1 may
  hard-require one, but nothing is built for one yet either.
- **Host prerequisites:** Docker Desktop, Git Bash, Node, the `gh` CLI (authenticated to
  GitHub), `bd` (the runner is the sole Beads writer and runs it host-side — 4.12; until
  it's installed, scripts fall back to running `bd` in the base image), and the Claude
  Code CLI with `CLAUDE_CODE_OAUTH_TOKEN` available on the host — the host itself makes
  the minimal rate-limit probe calls (4.7).
- **Review happens as GitHub PRs.** Projects fed through the pipeline must have a GitHub
  remote. (An environment with no PR host — repos on a network share, say — would need a
  local-branch review mode. Out of scope for V1.)
- **Docker runs from Git Bash on the reference host**, not WSL (known issue: that machine's
  WSL distro has no Docker Desktop integration). The runner must not assume WSL either way.
- **Auth:** `CLAUDE_CODE_OAUTH_TOKEN` is passed to containers as an environment variable
  at `docker run` — never baked into an image layer. Headless `claude -p` honors it;
  interactive `claude` does not (known issue) — the pipeline is headless-only anyway.
- **Runner implementation: Node.js.** Decision, for cross-platform reasons: `node` is
  the same command on Windows and Linux (no `python` vs `python3` split), handles JSON
  natively for Beads/Claude output, and can enforce wall-clock timeouts with timers +
  `docker kill` without relying on a platform `timeout` command. Plain JavaScript, no
  framework.
- **Image strategy: shared base + thin per-project layer.** The base image (Node, git,
  the Claude Code CLI, `bd` — **no pipeline scaffolding**; the entrypoint and verifier
  are mounted at runtime per 4.10) is maintained in this repo; each target project gets
  a thin hand-written Dockerfile (`FROM` the base, plus its `pipeline.config.json`
  dependencies — see 3.4 for the drift cross-check). Versions of the base OS, Node, and
  the CLI are pinned in the base Dockerfile.

## 7. Phasing

**V1 — the implementation loop** (this project's first autonomous run):
1. Beads set up in the target repo; issue template per 3.1.
2. `PLANNING.md` playbook (see 3.2, "V1 deliverable").
3. Base image + per-project layer, allowlist network + proxy sidecar, pre-run egress check.
4. Runner: config, ready-queue loop, host-side clone + bind-mount per task, timeouts,
   rate-limit pause/resume, push-always/PR-per-table, per-run logs.
5. Entrypoint + verifier scaffolding per sections 4.3–4.4 and the 4.11 contract.
6. Run report generator.

V1 is proven by a scripted end-to-end pass against a **dedicated fixture repository on
GitHub** (created as part of this work): one task that succeeds, one that bails, one that
tampers — ending with the expected PR, WIP branches, and report, with zero interactive
input. **Determinism comes from the 4.3 agent-command seam:** the bail and tamper scenarios
substitute scripted stubs for the coding agent (a stub that never satisfies the tests; a
stub that edits a frozen test file), so the E2E pass does not depend on model behavior or
burn the usage window; the success scenario may run either a stub or the real model.

**Shadow-mode trial:** V1 then runs on tasks from an existing private project the user
would have done anyway; after each run the output is graded against the user's own
judgment. This calibrates the verification gates before the
pipeline gets real responsibility — and its failure notes become the requirements list for
the V2 critics.

**V2 — the spec pipeline:** the design-doc session scaffolding, doc-level critics, dry-run
decomposition, sized per-spec critic panels, and the coverage check — packaged as a
`/spec` slash command sitting beside the planning playbook, informed by shadow-trial
data. Includes the specialist registry and slots 1–2 of 3.5 (domain critics and domain
test authors); run-time advisors (slot 3) only if the trial proves something resists
determinism.

**V2 — the concurrency knob (opt-in parallelism):** a per-run concurrency setting in
`run.config.json` — default **1**, sensible maximum 2–3. Shape decided now so the
implementer inherits the why:
- **One runner juggling N containers, never N runners** — the sole-Beads-writer rule
  (4.10) and claim-based double-pick prevention survive only inside a single process.
- **Rate-limit pauses go global**: one task's usage-limit exit parks *every* running
  task (they share the subscription window); the runner resumes all parked workspaces
  when the window resets. Per-task pause mechanics (4.7) are reused unchanged.
- **Sequential stays the strategy for long unattended runs.** Sequential maximizes *completed* work
  per budget: if the window dies mid-run, finished PRs exist. Parallel spreads the same
  budget across all started tasks — faster when the batch fits the window, but budget
  exhaustion leaves everything half-done and nothing reviewable until the next window.
  The knob exists for **daytime batches of small tasks** ("these three by lunch"),
  where elapsed time matters and the batch is expected to fit; it also competes with
  the user's own interactive subscription use, another reason it is opt-in.
- Planning-time caution: don't queue overlapping-file tasks in the same parallel batch —
  both will pass their own tests and then conflict at merge.
Built only after the shadow trial proves the sequential loop.

**V3 — the second-environment port:** running under a host's existing container workflow,
repos on a network share, and a local-branch review mode for hosts with no PR service.
Machine specifics stay in an untracked local note, never in the repo.

## 8. Out of Scope (agreed)

- Parallel task execution **as a default or in V1** — sequential is fine; resilience
  matters more than throughput. An opt-in, small-N concurrency knob is a decided V2
  item (see §7), built only after the shadow trial.
- An LLM orchestrator, nested orchestrators, or a leader agent inside containers.
  Orchestrator intelligence (re-planning, cross-task learning) waits until the dumb loop
  has proven itself.
- Autonomous planning or autonomous spec changes during a run — ever.
- Opening the container network beyond the enumerated Anthropic endpoints.
- Cost accounting. There is no spend ceiling by design (see 4.6–4.7); real cost tracking
  is a possible V2+ addition if the pipeline ever moves to metered API billing.
- Any host environment other than the reference workstation, until V3.

## 9. Assumptions (approved with this doc)

- One pipeline instance runs at a time on one machine; no multi-machine coordination.
- Target projects are git repos with a GitHub remote; their test framework choices are
  recorded in `pipeline.config.json` at planning time.
- Beads (`bd`) is adopted as the work database from day one, even though V1 barely
  exercises it — it keeps the door open to richer orchestration later. Its native
  status vocabulary is assumed to include (or representably map to) open, in-progress,
  blocked, and closed, with ready = open + unblocked + dependencies satisfied.
- Run capacity is whatever the Claude subscription allows; runs may span multiple usage
  windows, finishing later rather than doing less.
- Headless `claude -p` reports usage-limit errors distinguishably from other failures, and
  honors standard proxy environment variables. (If either proves false at implementation
  time, that's a doc amendment, not a workaround.)
- `bd remember` / `bd prime` provide keyed project memory in the same per-repo database
  (verified against bd 1.1.0 in the base image). Memory state lives with the canonical
  Beads home (the host working copy — 4.12) and, like the rest of the database, is not
  pushed anywhere in V1.

## 10. Open Questions

None currently — both review rounds' questions were resolved into decisions on 2026-07-25
(see Change Log). Details explicitly delegated to implementation tasks, within the rules
this doc sets: the exact Beads field mapping (within the 3.1 round-trip rule); the specific
proxy sidecar software and the empirical completion of the endpoint enumeration (within the
4.8 policy); and pure naming/layout details with no cross-component reach — config key
spellings, timestamp and trace-ID formats, report and Dockerfile file names, fixture-repo
name, probe host choices. Anything touching **two or more separately-built components** is
decided in this doc (the 4.11 table, `status.schema.json`, `verify.schema.json`,
`run.schema.json`, the 4.10 input contract incl. the `/pipeline` mount and
`PIPELINE_AGENT_CMD`, the 3.4 config schema) — that is the dividing line.

## 11. Readiness Bar

This doc is ready to drive development when a review round (critic review + dry-run
decomposition) produces **no blocker findings and no decision requiring the user** — every
remaining finding must be implementer-level, with an obvious default inside rules this doc
already sets. Critics asymptote toward zero but rarely reach it; demanding literal silence
buys diminishing returns, so "no blockers, nothing for the user" is the bar, not "dry."
(Adopted after three rounds converged ~20 → ~7 → 4 findings; the same rule applies to the
V2 spec pipeline's own doc reviews.)

A dry-run decomposition must still succeed in full: every V1 task with a fillable
"Done means" list and a `design-ref`. Gaps found by either check are fixed here first;
development starts only after.

## 12. Change Log

Every amendment to this document gets a row, appended at the bottom (chronological
ascending). A row is identified by the **Ref** column — a stable kebab-case *slug*, never a
version number. For a row produced by a pipeline task the ref **is** that task's issue id
(`repo-dhp`, `repo-52m`): the host assigns it, so it is unique by construction and no agent
invents its own identity. For a row produced by an interactive session the ref is a short
descriptive kebab-case name (`default-branch`, `readiness-bar`). Refs are unique across the
whole log, and `scripts/test-changelog.sh` enforces that.

Version numbers were the previous scheme and could not survive parallel work: agents fork
from a base where a number is free, each numbers its own row, and two rows arrive claiming
the same version — which happened twice, once repaired at merge and recorded in the
`repo-qyd` row. Citations elsewhere in the repo use the pinned form — the literal phrase
change-log row followed by the slug in backticks, e.g. change-log row `repo-52m` — so a
script can tell a citation from ordinary hyphenated prose.

Version tokens that appear *inside* a row's prose are history and stay: they record what
was true when the row was written. Deliberately out of scope of this convention, and still
carrying version numbers: the citations in `runner/memory.js`, `pipeline/verify.js`,
`scripts/test-verifier.sh` and `scripts/test-base-image.sh`, and this document's own header
version (`Status: READY v1.0`). The *document* still has a version; its *rows* no longer do.

| Date | Ref | What changed | Why |
| ---- | --- | ------------ | --- |
| 2026-07-25 | initial-draft | Initial draft, merging v3 handoff + spec-layer design session | — |
| 2026-07-25 | review-round-1 | resolved first review round — host-side clone + bind-mount transport; push-always/PR-on-success; 3-attempt cap (dropped "same error" rule); exit-code + status-file contract; host as sole Beads writer; rate-limit pause mechanics; **no cost ceiling** (user decision: subscription window is the cap; pause and resume across windows); `pipeline.config.json` (verify command + deps); PLANNING.md as V1 planning deliverable; freeze = fork-point diff; branch naming; report location/ordering; allowlist policy wording; base+layer image strategy; permissions-bypass posture; runner config/log locations; regression suite as evidence not gate; fixture-repo E2E for V1 | Critic review + dry-run decomposition round 1 found 2 contradictions and ~20 undecided points |
| 2026-07-25 | review-round-2 | resolved second review round — unified outcome taxonomy table (exit codes ↔ report statuses ↔ Beads transitions ↔ push/PR, incl. "stuck"/"tampered"/timeout); blocked-status loop termination; partial gets a flagged PR; rate-limit resume reuses workspace so the attempt counter and active-time budget carry over; container input contract (issue file mount, `ISSUE_ID`, prompt composition, `.run/` git-exclude); `verifyCommand` invocation convention; optional `regressionCommand`; dependencies manifest schema + hand-written thin Dockerfile with drift cross-check; agent-command env seam for deterministic E2E stubs; branch-collision run suffix, never force-push; clone from remote; canonical Beads home + host probe location; `status.schema.json` ownership; docs-phase failure non-fatal; priority-then-FIFO ordering; scrutiny order incl. tampered; delegation dividing line stated in §10 | Round 2: no contradictions, but ~7 cross-component contracts still undecided |
| 2026-07-25 | review-round-3 | resolved third review round — `verify.schema.json` pinned (owner: verifier task); `PIPELINE_AGENT_CMD` named, added to the 4.10 input list and as `run.config.json`'s `agentCommand` override; scaffolding delivered as a runner-supplied read-only `/pipeline` mount (base image scaffolding-free); per-run manifest `run.json` + `run.schema.json` as the report's outcome source (Beads collapses failure flavors to blocked); tamper diff widened to all of `tests/acceptance/`; runner owns network/sidecar lifecycle + stale in-progress recovery at run start | Round 3: findings narrowed to 4 convergent cross-component contract gaps + 3 minors |
| 2026-07-25 | readiness-bar | readiness bar changed from "critics come up dry" to the pragmatic rule (no blockers, no user-level decision, remainder implementer-level); status flipped to READY under that rule | User decision after 3-round convergence showed critics asymptote but never fully silence |
| 2026-07-25 | bd-host-prereq | added `bd` to §6 host prerequisites (found during T2 — §4.12 already required host-side `bd`) | Build-time drift fix via the change protocol |
| 2026-07-25 | verifier-fork-point | verifier reads `pipeline.config.json` from the fork-point commit, and tamper scope extends to the config's new optional `frozenPaths` (§3.4, §4.4) | Found during T7: worktree config or a repo helper script invoked by `verifyCommand` were agent-editable — a failing task could be made to "pass" |
| 2026-07-25 | default-branch | `defaultBranch` in `pipeline.config.json` (§3.4) — task branches, the freeze baseline, and PR targets all follow the project's integration branch instead of assuming `main` | Shadow-trial finding: the first real project uses `master`; the pipeline hardcoded `main` in three separately-built components |
| 2026-07-25 | domain-specialists | added §3.5 domain specialists — three slots (planning critic / test author / run-time advisor), specialists are never gates, registry + per-task selection + schema'd output, escalation ladder toward determinism; V2 phasing | User goal: pluggable domain agents (physics, aesthetics). Shape decided now because the advisor slot spans three separately-built components and the frozen schemas would otherwise need a breaking change |
| 2026-07-25 | memory-in-beads | added §3.6 memory — Beads is the memory store as well as the task queue (`bd remember`/`bd prime`, verified against bd 1.1.0 in the base image; no second database); knowledge hierarchy with repo files canonical for anything a container needs; container agents propose memories via a `memoryNotes` status-file field and read them via a runner-exported read-only `.run/memory.md`; host runner stays the sole Beads writer; promotion ladder from memory notes into repo files; plumbing ships with the shadow trial, not the V1 E2E pass. Touched §4.10 (input contract + sole-writer rule), §4.11 (status file), §9 (bd assumption) | User decision after the memory-design discussion: follow the upstream Beads convention (one database, memory beside tasks) with the pipeline's stricter access rule layered on top, instead of inventing a second store |
| 2026-07-25 | planning-realign | `PLANNING.md` brought in line with v1.2/v1.0.2 — freeze step, pre-run checklist, and spec-change section now say integration branch (`defaultBranch`) instead of hardcoded `main`, freeze scope mentions `frozenPaths`, and the prerequisites list the full `pipeline.config.json` schema | Drift fix via the change protocol: the playbook still described the pre-v1.2 contract and would have frozen the shadow-trial project's tests against the wrong branch |
| 2026-07-25 | onboarding-checklist | added `ONBOARDING.md` — the once-per-project checklist (git/GitHub + `defaultBranch`, `.gitattributes`, `tests/acceptance/`, `pipeline.config.json`, thin Dockerfile + image build, `bd init`, `CLAUDE.md` rewrite with the container section replacing any other container-workflow guidance, hooks removed, vendored docs, `run.config.<project>.json`, sanity pass). `PLANNING.md` prerequisites now point at it | Onboarding the first shadow-trial project took an evening of hand-work and one outright breakage (`master` vs `main`); the checklist makes it a repeatable step. Convention decided here: pipeline projects drop format hooks (they fight the closed network) and their `CLAUDE.md` must describe the pipeline container, not whatever container workflow the host normally uses |
| 2026-07-25 | dogfood-onboarding | this repository onboarded as its own target (§1 amended — dogfooding sanctioned). Full ONBOARDING.md checklist applied: `pipeline.config.json` (Docker-free `verifyCommand`, empty dependencies), `tests/acceptance/`, thin Dockerfile + `pipeline-multiagentpipelines:local`, `bd init` (prefix `repo`), container section in `CLAUDE.md`, `run.config.multiagentpipelines.json`. Constraint recorded: acceptance tests for self-tasks may not use Docker; `bd init`'s SessionStart hook removed (no host `bd`; pipeline projects carry no hooks) | User decision: the pipeline's own backlog (e.g. the §3.6 memory plumbing) becomes shadow-trial material — real tasks, graded each morning |
| 2026-07-25 | onboarding-cross-ref | §3.4 now names onboarding and points at `ONBOARDING.md` (config is written at onboarding, not "during planning" — wording predated the checklist); ONBOARDING.md gained the from-zero project path and the post-onboarding lifecycle | Doc navigation fix: DESIGN.md's body never referenced onboarding, so a reader of this doc alone could not find the setup path |
| 2026-07-25 | audience-senior-devs | audience widened to senior developers (§3.3) — developers may inspect drafted tests before freeze (optional; prose criteria remain the gate for everyone); difficulty labels join the approval pass; priority/dependency order made explicitly the user's decision. PLANNING.md steps 1, 5, 6 updated to match. No change to run-time autonomy or budgets (subscription window stays the natural limit — §4.6–4.7 unchanged) | User decision: the pipeline is now a tool for senior software devs, not only its original non-programmer owner — high-level decisions belong to the humans, proposals to Claude |
| 2026-07-25 | parallelism-v2 | parallelism moved from out-of-scope to a decided V2 item (§7) — opt-in per-run concurrency knob, default 1, max 2–3; one runner juggling N containers (sole-writer preserved); global park/resume on rate limits; sequential remains the overnight default. §8 bullet narrowed to "as a default or in V1" | User decision after weighing it: parallel compresses elapsed time for daytime batches that fit the window, but budget exhaustion mid-run leaves everything half-done — sequential maximizes completed work per budget, so it stays the default |
| 2026-07-25 | attempt-cap-config | the verify-attempt cap is tunable per run — `maxAttempts` in `run.config.json` (validated positive whole number), forwarded as `PIPELINE_MAX_ATTEMPTS`; the entrypoint falls back to 3 on unset/invalid. §3.5/4.3/4.6/4.7/4.10/4.12 and the 4.11 table reworded from the hardcoded 3 to "the attempt cap (default 3)". Implemented in the same change (config.js, container.js, entrypoint.sh) with two new entrypoint checks (cap=2 honored; invalid value falls back to 3) | User request: tune how many failed attempts feed forward before a task bails; default unchanged at 3 |
| 2026-07-26 | repo-qyd | the §3.5 registry is built (`repo-qyd`) — `advisors/README.md` pins the charter format (`## Lens` / `## Checks` / `## Output`, one JSON fence matching the `advisories` item shape in `status.schema.json`) and `ambiguity.md` / `testability.md` / `scope.md` staff the slot-1 critic panel; `PLANNING.md` step 2 now names the charter to paste per difficulty label. Markdown only — no code reads `advisors/`, no phase changed, so V2's `/spec` skill still owns dispatch. (Renumbered from the PR's v1.7 at merge: the attempt-cap amendment claimed v1.7 on `main` while this task ran) | Dogfood queue task. The critic panel was described in three places and existed in none, so every planning session re-improvised the prompts; the shadow-01 self-nesting lesson had nowhere durable to live |
| 2026-07-26 | repo-eyn | §3.6 In-channel built (`repo-eyn`, container side `repo-zdm`) — export moved to "at workspace prep" and pinned non-fatal: a `bd` failure logs, writes `(no memories recorded)`, and the run continues, so memory can never cost a task. Row added at merge review: the task's PR amended §3.6 wording without logging it | Change-protocol backfill — every DESIGN.md amendment gets a row, including ones made by the pipeline's own agents |
| 2026-07-26 | repo-52m | §4.3 gains the contract-artifact extraction rule and §4.11 names the resolved model id in the status file (`repo-52m`) — both agent phases request `--output-format json` when the entrypoint owns the invocation, and `pipeline/envelope.js` reads the last log line that parses to a JSON object with a string `result` (summary + `modelUsage`'s first key). Recorded as design, not comment: the rule is *structural on purpose* (no list of known CLI warnings to maintain), the docs phase keeps stderr out of the file its summary comes from because that text becomes the PR body (§4.5), and the workspace trust flags are seeded before the first call so the noise is removed at source | The v1.2 model-pinning feature had never actually recorded a resolved id — a CLI warning line broke the whole-file `JSON.parse` — and the same line led every PR body. A defect that silently disabled a shipped contract belongs in the constitution so the next reader knows the extraction rule is load-bearing |
| 2026-07-26 | repo-4gp | §3.6 Out-channel built (`repo-4gp`) — `memory.fileMemoryNotes()` files each proposed note as `bd remember <text> --key <issue-id>-note-<n>`, called once per task from `run.js` after the pause/relaunch loop. Two rules recorded in §3.6 that the design had not stated: filing is gated to the terminal, trusted outcomes (`done|partial|failed|stuck` — never `tampered`, never `paused`), and the host re-enforces the schema bounds (first 20 notes, 500 chars each) on the agent-written file. §3.6's promotion rule now names the `memory notes: <count>` attempt-log line that makes filing visible at review | Dogfood queue task. The gate and the re-enforced bounds are design-level decisions — who may seed project memory, and how far the host trusts a file an agent wrote — so they belong in the constitution, not only in the code comments |
| 2026-07-26 | pause-cycle-cap | §4.7 states that the pause loop is bounded per task, via `maxPauseCycles` in `run.config.json` (validated positive whole number, default 96). The bound is a per-*task* cycle count carried across relaunches, not a per-wait one: `run.js` hands `waitForWindow` the cycles already spent, and `runner/config.js` exposes the cap that was previously hardcoded and unreachable | Found by re-running `scripts/test-runner-queue.sh` after the V1 merges. The stop condition existed but could never fire — the wait was re-entered fresh on every pause, resetting its counter — so a container reporting an already-elapsed reset time relaunched on a 5-second cycle forever, unbounded, because paused time is deliberately excluded from the wall-clock budget. Making the cap configurable is part of the fix: it was untestable while hardcoded, which is why the gap survived |
| 2026-07-26 | spec-concern-channel | §3.7 declares the spec-concern channel — `specConcerns` in the status file (optional, max 5 entries, 1000 chars each), `status.js concern` as the writer, host surfacing in the attempt log / manifest / report / PR body, and evidence-only per §3.5: a concern can never change an outcome, an exit code, a Beads transition, or whether a branch is published. Declared before either half is built, so no container invents a cross-component contract | Warranted by §3.3 (drift flows upward) and by shadow-01, where the agent diagnosed a broken gate correctly, had no channel to report it, and contorted correct code until the gate went green. The scope critic caught that the field appeared nowhere in this doc; §3.6 declared `memoryNotes` before `repo-zdm` built it, and this follows that precedent |
| 2026-07-26 | repo-wxh | §4.3's resolved-model rule is corrected (`repo-wxh`) — the id is *selected* from `modelUsage` by an ordered deterministic rule (pinned-alias match on key or `canonicalModel` → sole key → greatest `outputTokens`, missing/non-numeric as 0, ties by name ascending → null), not read as the first key. `PIPELINE_MODEL` is passed through to `envelope.js flatten` (`${PIPELINE_MODEL:-}`, guarded because `set -u` is on and an unpinned run leaves it unset), and the flatten call's `2>/dev/null` is removed so an alias that matches nothing surfaces in the run log | v1.8.3 codified the first-key rule as a deliberate decision; it was wrong. The CLI lists a cheap internal helper model ahead of the pinned model that did the work, so run 2026-07-26T16-47-15-326Z recorded `claude-haiku-4-5-20251001` for both tasks while `claude-opus-5` did 7897 of the 7912 output tokens. The pin was honoured throughout — only the record lied, in the status file, the manifest, the PR footer and the report. Amending the sentence with the code keeps the constitution from contradicting the implementation |
| 2026-07-26 | repo-1cy | §3.7's container-side half built (`repo-1cy`) — `specConcerns` in `status.schema.json` (optional, `maxItems` 5, `maxLength` 1000) and in `schemas/examples/status.valid.json`, `pipeline/status.js concern` as the writer, and prompt text in both entrypoint phases telling the agent the channel exists *and* that it cannot change the outcome. §4.11's status-file enumeration now names `specConcerns` beside `memoryNotes`, and the container section of `CLAUDE.md` plus `ONBOARDING.md`'s copy-in block carry the guidance. Host-side surfacing remains unbuilt | §4.11 listed every other status-file field but not this one, so a reader of the contract section alone would not have known the field existed. The prompt literals are asserted against the *generated* prompt files rather than `entrypoint.sh`, because a shell comment satisfies the source but leaves the agent never actually told |
| 2026-07-26 | repo-dhp | §3.6's out-channel gate is named — `memory.shouldFileMemory(status)` is the single statement of which outcomes may seed project memory, exported from `runner/memory.js` and called by `run.js`, replacing an inline array literal in the runner; it fails closed on any status the runner does not recognise. No rule changed, only where it lives | `repo-dhp`. The gate was a design decision (recorded v1.8.2) living as a literal buried in a control-flow branch, where no test could reach it without a container; beside the channel it guards it became testable for the first time, in `tests/unit/memory.test.js`. Logged even though it is small — the v1.8.1 lesson is that every §3.6 amendment gets a row |
| 2026-07-26 | repo-006 | §12 change-log rows are identified by a stable kebab-case slug in a new `Ref` column (`| Date | Ref | What changed | Why |`) instead of a version number: a pipeline task's row takes its issue id, an interactive row a short descriptive name. All 26 existing rows keep their date and their "why" verbatim and gain a ref; version tokens inside prose are left as history. Citations in the living docs move to the pinned form (the phrase change-log row plus a backticked slug), and `scripts/test-changelog.sh` / `tests/unit/changelog.test.js` — a Docker-free suite the sweep discovers by glob — enforce the shape, the slug syntax, uniqueness and the no-leading-version rule, reading `CHANGELOG_FILE` when set so the negative cases are exercisable | `repo-006`. Merging three PRs on 2026-07-26, two claimed the same version because each forked from a base where that number was free — a collision that recurs on every batch run touching this doc, and that the `repo-qyd` row already records happening once before. Numbers assigned by parallel agents cannot be unique by construction; an id the host assigns can be, so identity moves to where it is already unique instead of being renumbered by hand at each merge |
| 2026-07-26 | epics-group-never-run | §3.1 admits Beads epics as a **grouping** device and §4.12 filters them out of the run: an epic holds a title and a design-ref, never acceptance criteria, frozen tests, a container run or a PR, and the runner skips ready-queue entries whose `issue_type` is `epic` and drains the rest. The 1:1 rule is untouched — one spec is still one issue, one run, one PR. Who calls something an epic stays a planning-time human decision (§3.3), like priority and the difficulty label; the system only *recognises* the type deterministically. Declared before the filter is implemented, the §3.7 sequencing | Asked during review: can one spec create several beads? No — but Beads offers hierarchy the pipeline was silently ignoring, and ignoring it is unsafe. Verified against bd 1.1.0 in a throwaway database: `bd ready` returns the epic itself ranked among its children, and closing every child leaves the parent open and ready — so an unfiltered runner would clone a workspace for a spec with no criteria, and would do it again on every subsequent run |
| 2026-07-26 | repo-4l8 | §3.1/§4.12's epic filter is built (`repo-4l8`) — `queue.readyQueue()` drops ready entries whose `issue_type` is `epic`, keeps every other type including one that is absent, null or empty (fail-open: failing closed on a missing field would drain nothing at all against an older `bd`), preserves the priority-then-FIFO order of the survivors, and returns the skipped entries beside them. The queue-summary log line moves out of `run.js` into an exported `queue.queueSummary(issues, skipped)`, which appends a skipped-by-type clause and a running-non-task clause after the historic `ready queue: <n> task(s) — ` prefix. No rule changed — the filter is exactly what change-log row `epics-group-never-run` declared | `repo-4l8`. Declared-then-built, the §3.7 sequencing. The line-builder is extracted for the same reason `shouldFileMemory` was (change-log row `repo-dhp`): `run.js` reaches that line only after `loadToken` and the Docker preflight, so no Docker-free test could execute it where it sat, and the skip it announces is the whole point of a filter that removes work silently |
| 2026-07-27 | publish-sanitize | the repository is decoupled from its author's private environment. §6 states a *reference host* rather than "the reference workstation", and §7's V3 is a generic second-environment port rather than one named container workflow; §3.6's machine-specific row points at an untracked local note instead of a named harness file; the predecessor-document line and the `/<setup plugin>:*` skill references are dropped from §3.4 and from `ONBOARDING.md`/`PLANNING.md`, which now describe the checklists as the tooling they are. Per-project runner configs (`run.config.<project>.json`) join `.env.pipeline` as git-ignored host-only files, with `run.config.example.json` the only committed template; `scripts/e2e.sh` and `scripts/test-fixture.sh` fail with a copy-this-file message when theirs is absent. Superseded planning snapshots are deleted and the suites that cited them by path now cite the backlog task number alone | The repo is public. Two kinds of content made that awkward: things a reader cannot use (a private plugin's skills, an absolute import path to one machine's disk) and things a reader should not see (a private fixture repo's URL, another private project's task ids, one workstation's directory layout). Neither was load-bearing — the checklists in this repo were always the source of truth the skills followed, and the runner has always read its target from a config file. Recorded because §6's environment claims and §3.6's knowledge-hierarchy table are design statements, not prose: a later port needs to know the Windows specifics are a *reference*, not a requirement |
