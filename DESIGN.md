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
3. **Per-spec pipeline.** Draft → mechanical pre-checks → critics sized to the difficulty
   label (**one testability pass minimum, always**; the full panel — ambiguity, testability,
   scope — for hard) → the pipeline writes the acceptance tests → a coverage check pairs
   every "Done means" item with a test and every test with an item; orphans on either side
   are spec bugs → the freeze gate runs the tests against the fork point and requires each
   to be red. The label decides critic *depth*, never *existence*; see "Below the panel"
   below for why, and for the checks that run before any critic reads the spec.
4. **Approval and freeze.** The user approves intent at the design-doc level once; the
   decomposed backlog is reviewed as a single list pass (checking the slicing, not
   re-litigating intent). On approval: tests committed and frozen, Beads issues created,
   new dependencies declared (see 3.4) for the image rebuild.

Small standalone chores may skip the doc layer and enter at step 3 with just a spec — but
large, doc-first projects are the default path.

**Below the panel.** §3.5's escalation ladder — judgment migrates leftward into frozen
tests as a check proves itself — applies to the panel itself. The first full panel run
against a real backlog returned `concerns` on **every spec in the batch**, and most of what
it found was mechanically detectable: criteria that no implementation could satisfy,
criteria ordering the agent to edit a frozen path, and criteria already true at the fork
point. A panel that catches everything is not a triumph, it is a measurement of how much
work is sitting above the line that could be below it. Five moves, in the order they take
work off the critics:

1. **Every criterion must fail at the fork point.** A frozen test that is green against the
   unmodified integration branch is non-discriminating *by construction*: it cannot detect
   the thing it exists to catch, and passes a correct implementation, a broken one and an
   empty diff alike. The freeze therefore runs the tests against the fork-point commit and
   requires red. Two rules keep the gate honest. **Red is not one state** — a test that
   fails to *load* is a broken harness, not a discriminating test, so the gate separates an
   assertion failure from a load or collection error and treats the latter as its own spec
   bug (the failure mode §4.11's artifact rule already names: plausible, well-formed and
   false). And a criterion may be a **guard** — "existing behaviour X still holds" — which
   is legitimately green; guards stay legal, must be labelled, and their **count is reported
   in the approval pass**, so a spec that is all guards is visible rather than silent.
2. **A minimum of one critic, always.** The old rule exempted `trivial` specs from review
   entirely. That was self-referential: the difficulty label is chosen by whoever drafted
   the spec, *before* any review, and the critic whose charter includes checking whether the
   label fits is the scope critic — precisely the one the label skips. So `trivial` and
   `medium` both take one testability pass, and `hard` takes the full panel.
3. **Two mechanical checks before any critic reads the spec.** Neither needs judgment.
   (a) *Does any criterion name a path in the target's `frozenPaths`?* Such a criterion
   orders the agent to tamper, and the task ends `tampered` on every attempt before a test
   result exists. (b) *Does any criterion cite a configuration key the target does not
   define?* That is the unsatisfiable-criterion class outright. (a) is portable and is built
   first; (b) is not — it needs the target to declare where its configuration lives and how
   keys are spelled, which differs by language and engine, so it comes last and adds a
   `pipeline.config.json` field.
4. **A disposition per finding.** A critic never gates (§3.5), but a finding that is
   silently dropped is indistinguishable from one that was considered and rejected. Every
   `details[]` entry gets one line in the planning draft — accepted, rejected with a reason,
   or deferred. It costs nothing and it is the only thing that makes the panel auditable.
5. **Criteria are drafted against the code, in fresh context.** This one sits *upstream* of
   the panel rather than below it. Every strong finding in that first run came from a critic
   doing archaeology in the implementation — the critics were not smarter than the drafter,
   they were **unprimed and reading the code**, while the drafter was many specs deep in one
   session. So the draft step splits: intent is written in session, where the history is
   needed, and the "Done means" list is written in fresh context after reading the code the
   criteria touch. The panel then reviews criteria that have already met the implementation
   once.

**What is deliberately not changed.** Critics keep fresh context, with no caching and no
summaries passed between them. A critic primed with the drafter's reasoning inherits the
drafter's blind spots, and independence is the active ingredient — the cost is what buys it.
Batching two *closely related* specs into one critic is allowed and roughly halves the cost
where specs share a subject, but it is not free: both are then seen through one lens, so a
blind spot common to both survives. Never batch unrelated specs to save money.

*Built* in the amendment that declared this: moves 2, 4 and 5, all of which are playbook
text. *Then* (change-log row `spec-lint-frozen-paths`): move 3(a), as `scripts/spec-lint.js`
— a rule registry the remaining checks slot into, reporting `file:line` findings that take a
disposition like a critic's rather than gating. *Then* (change-log row `freeze-gate-red`):
move 1, as `scripts/freeze-gate.js`, which runs the target's `verifyCommand` twice — once
against the new tests and once against an empty directory — and reads the pair, so a broken
harness is reported as *indeterminate* instead of being blessed as red. Move 3(b) alone
remains declared and unbuilt, the §3.7 declared-then-built sequencing.

**Upstream of step 1: the idea inbox.** Each repo — this one and every target — carries a
`docs/IDEAS.md`, a flat list of parked notes saying *a design might be wanted here
someday*. It is not part of the pipeline above and has no gate, no owner and no
obligations: an entry is a reminder, never a spec, and nothing is ever built from one
directly. Its only tie to the process is that a planning session opens it first
(`PLANNING.md` step 0), and that an idea which graduates leaves via step 1 like anything
else — a design-doc section and its change-log row — so the `design-ref` rule in §3.1
still catches anything that tried to skip the decision.

The inbox exists because the three levels in §3.1 all demand a *formed* thought, and the
cost of forming one is paid at the moment the idea occurs, which is the moment there is
least appetite for it. The failure mode it prevents is not a lost idea but a **misfiled**
one: the only cheap home available was a Beads issue, and an issue is a commitment that
appears in `bd ready`, which is the queue the runner drains unattended. An inbox that can
start a container is not an inbox. Per-repo rather than central is forced by the
publication boundary (change-log row `publish-sanitize`) — this repo is public and
documents the machinery, never the work done with it, so a target project's ideas cannot
be filed here at all.

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
ready queue once before the task loop. Both halves have now shipped — the container side
as `repo-1cy`, the host side as change-log row `spec-concern-surfacing`, which the first
real concern prompted by reaching the status file and going no further.

## 4. The Implementation Phase (the execution layer)

Carried over from v3, amended over two critic-review rounds; this section is the single
source of truth.

1. **One orchestrator, on the host, outside every container.** A deterministic runner
   script — not an LLM. It enforces timeouts and kill switches; the enforcer cannot live
   inside the thing it may need to kill. **That includes the tools the runner itself
   shells out to:** every runner `bd` call is bounded by `bdTimeoutMs` (4.12, default
   60000ms) inside `runner/bd.js`, because `bd` has been observed printing its complete
   output and then never exiting, and two calls over one embedded Dolt database blocking
   on each other indefinitely. A call that exceeds the bound is killed and returns the
   ordinary non-zero status its caller already handles, with an error naming the bound
   that fired — never a silent empty result, which would be the quiet degradation the
   bound exists to prevent.
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
   runner parks — the pause is an attempt-log note; the issue simply stays
   in-progress — and waits until the reset time or, if none was reported, probes on a fixed
   interval (default 15 minutes) with a minimal `claude -p` call **run directly on the
   host** (the host has the CLI and token; see section 6). It then relaunches a **fresh
   container reusing the same host-side clone and workspace**: `/workspace/.run/` persists
   across the relaunch, so the entrypoint reads the prior attempt count from the status
   file and continues it — the attempt cap is a per-task invariant, never reset by a
   pause. Active time before the pause counts against the wall-clock budget (host-tracked);
   paused time never does. A run may span multiple usage windows. A rate limit is never
   recorded as a task failure, and an interrupted attempt is not a failed attempt.
   **The park is run-level, not per task** (§7, built by change-log row `repo-i9y`): a
   usage limit is a property of the **subscription window**, so the *first* exit 20 of a
   run opens **one shared wait** — on that task's reported reset time — and every later
   reporter joins it rather than sleeping against the same window on its own. Joining
   never *extends* a wait: if the window is still closed when it ends, the relaunched
   tasks exit 20 again and open a fresh one, which is self-correcting and bounded by the
   one run-level counter. **Parking means "admit no new work", never "kill what is
   running"** — see §7 for why.
   **The pause loop is bounded per run**, by a count of wait cycles — `maxPauseCycles` in
   `run.config.json`, default 96 (~24h at the 15-minute probe cadence). The bound is not
   per-wait: a reported reset time makes each wait return after a single
   cycle, so the count must carry across relaunches or it restarts at one on every pause
   and can never fire. Without that carry, a container that keeps reporting an already-
   elapsed reset time relaunches forever — the wall-clock budget cannot catch it, because
   paused time is deliberately excluded from it. A shared wait has no per-task cycle to
   count, so the counter is held once for the run; the per-task relaunch count is a
   *different* quantity and stays per task, since that is what the manifest row's `pauses`
   field reports.
   When the bound is reached the run admits no new work, then finishes normally and
   writes its manifest. **Two populations come out of that and only one of them touches
   the queue:** a task that launched, exited 20, waited and gave up stays `paused` with
   its issue `in_progress`, exactly as before; a task the fired cap **refused** before it
   ever launched never touches Beads at all, so its issue stays `open` for the next run to
   pick up — and it still gets a synthesized `paused` manifest row, because a task
   silently missing from `run.json` after an unattended overnight run is a hole in the
   record. Work is preserved and the operator decides, since a pipeline that cannot get
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
   network task. **The network and the sidecar are per project, never per pipeline** — a
   run acts only on the plumbing it owns, so a second runner process against a different
   project can be in flight without either one creating, restarting or destroying the
   other's (4.12 says where the names come from). The proxy *image* stays shared: the
   allowlist is identical for every project, and the policy above is what may not vary.
   A **pre-run egress check** (throwaway container: allowed endpoint
   reachable, at least two non-allowlisted hosts unreachable, bounded under 60 seconds)
   runs before every run, **against that run's own network and proxy** — a gate that
   passes against different plumbing proves nothing — and **aborts the run** on failure. Dependencies are baked into
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
    them via `bd remember` (3.6). Beads data never rides task branches. Those writes all
    go through `runner/bd.js`, and they are **synchronous** (`spawnSync`, bounded by
    4.1's `bdTimeoutMs` — never an asynchronous spawn): in a single-threaded runner,
    blocking is what makes two `bd` calls unable to interleave over one embedded Dolt
    database, so the sole-writer guarantee survives §7's worker pool unchanged.
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
    the bound on every runner `bd` call (`bdTimeoutMs`, default 60000 — see 4.1;
    validated, like the other numeric tunables, as a positive whole number),
    network/proxy identifiers, and an optional `agentCommand`
    override (passed into containers as `PIPELINE_AGENT_CMD` — how the E2E pass injects
    its stubs). **The network and proxy names are per project and have no shared
    default:** `network` / `proxyName` are used verbatim when a config gives them, and
    otherwise **derived from the project segment of the config's own file name**
    (`run.config.<project>.json`), sanitised to one lower-case DNS label because the proxy
    name is the host part of every container's `HTTPS_PROXY`. A bare `run.config.json` has
    no project segment and keeps the historical `pipeline-net` / `pipeline-proxy`, which is
    what the test suites use; running two projects at once therefore means giving each
    config a project segment. Derivation is a pure function of the file name — never the
    pid, the clock or a random suffix, because setup, every task container and teardown
    must all compute the same name, in one process or in several, across a pause and
    resume.

    **One run per project, enforced by a lock — the first gate there is.** Per-project
    plumbing makes two *different* projects independent; it does nothing about starting
    the *same* project twice, which is then the remaining way to corrupt a run and the
    easy mistake to make, because the second run looks like it starts normally. Two
    runners draining one queue both read Beads' ready list, both can claim the same issue,
    and both push a branch for it: the sole-writer rule (4.10) assumes one writer, not two.
    So the runner takes a lock on its target repo under `runs/` — beside the sweep lock
    `scripts/test-all.sh` already takes — and a second run against the same repo is refused
    by name, naming both the project and the run that holds it, and exits non-zero. The
    lock is acquired **before every other gate**, first and not merely early: it is the
    only purely local check, everything after it probes Docker or writes to Beads, and a
    refusal arriving after the stale-issue sweep has already reset another live run's
    in-progress issues has not refused anything useful. Being first is also what makes a
    refusal free of cleanup — no network, no sidecar, no container, no Beads write — and
    what lets the whole thing be tested without Docker. Two rules make it safe to leave
    unattended. **Identity is the repo, not the string:** the path is canonicalised
    (trailing separators folded, the Windows separator flip and case folded, symlinks
    resolved where they resolve), because configs write `targetRepoPath` with forward
    slashes while `path.join` produces backslashes, and a lock keyed on the raw spelling
    would let a second config reach one repo under two identities. **A dead holder is
    taken over, and says whose lock it seized:** a lock left by a crashed or killed run
    must never block the machine forever, so the next run seizes it and records the run id
    it displaced in `run.log` — "took over" with no id cannot be told apart from an
    implementation that reports one every time. Deciding *dead* takes more than a pid:
    `process.kill(pid, 0)` reports a recycled or foreign pid as alive (EPERM counts as
    alive), so a pid-only record refuses to take over after a reboot, which is the
    block-forever it was supposed to prevent. The record therefore carries falsifiable
    evidence beside the pid — the process start time where the OS exposes one, and the
    host's uptime counter, which only resets at boot — and where a platform can prove
    neither, a pid recycled within one boot reads as still held: a spurious refusal is
    visible and recoverable, a spurious takeover puts two runners on one queue. A run that
    ends, normally or by aborting at preflight, releases its lock, and releases only its
    own: a refused run must not free the lock it was just refused by. An operator stop that
    kills the process outright runs no handler and leaves the lock behind — that case is
    covered by takeover, not by release, which is why takeover is the mechanism and release
    is the courtesy.

    **One run, N tasks at once — the bounded worker pool (§7's `concurrency` knob).**
    `concurrency` in `run.config.json` says how many task containers **one** runner process
    holds at a time. Default **1**, which is the sequential loop this pipeline shipped with,
    byte for byte in behaviour; validated like the other numeric tunables (whole number, in
    the field-naming error shape) and capped at a literal **3**, because §7 states only a
    hedged range and a batch is bounded by its slowest task, not by how many it holds — depth
    4 buys progressively less while multiplying the load on one subscription window. It is
    the *scheduling* half of §7 and nothing else: no verifier, outcome-table, attempt-cap or
    wall-clock behaviour differs at any depth. Four decisions §7 did not state:
    - **The scheduler is an exported function**, `drainQueue(issues, taskFn, concurrency)` in
      `runner/run.js`, and `main()` is guarded behind `require.main === module`. Nothing
      Docker-free could execute the task loop while `run.js` ran on import — `main()` sits
      behind a token load and a Docker preflight that always fail in a task container — so
      five of this task's six criteria could only have become greps of its own source. A
      preflight-bypass environment seam was the rejected alternative: a production flag that
      skips the egress gate is a hard-rule-6 hazard.
    - **Results come back in ready-queue order, never completion order.** N fixed workers
      pull from one shared cursor and write into their own index, so the manifest reads the
      same at depth 3 as at depth 1 and a fast task cannot overtake its neighbours. Append-on-
      completion would have been the natural implementation and is the bug this pins shut.
    - **The clone and the publish stay synchronous** (`spawnSync`: `git clone`, `git push`,
      `gh pr create`), so they serialise across workers. Seconds against container times in
      tens of minutes, against widening the change into four more runner files; the visible
      cost is that a wall-clock kill timer can fire a few seconds late while another worker
      clones. Stated so it is not mistaken for a defect. The same reasoning is why `bd()`
      stays synchronous, where it is a guarantee rather than a rounding error (4.10).
    - **The rate-limit park is still per task.** At depth > 1, N parked tasks each run their
      own pause loop against one shared subscription window: wasteful, not corrupting, and
      unreachable at the default — which is what makes shipping the pool before the run-level
      park safe. Making the park run-level is §7's other half and its own task.
    The manifest records the **configured** setting as a top-level `concurrency`, not the
    observed peak in flight: what a run was *allowed* to do is what a later reader needs in
    order to interpret its wall clock. Optional in `run.schema.json`, since manifests written
    before the knob exist (change-log row `repo-teq`).

    **The same rule binds the test harness: reclaim only what you created.** The suites
    that drive all of the above leak containers and networks when they fail, and
    `scripts/test-all.sh` reclaims after each of them — but cleaning up by *name* is how a
    harness deletes something that was never its business. `docker`'s `--filter name=` is a
    substring match, so `name=task-` reaches `my-task-runner` on a host that runs unrelated
    long-lived containers, and the reference host does. Ownership in the harness is
    therefore the same shape as the runner's: a listing taken **before** a suite diffed
    against one taken after, intersected with an allowlist of what the pipeline creates
    (`pipeline-base:local` / `pipeline-proxy:local` ancestry, the exact name
    `pipeline-proxy`, a `task-` prefix anchored at position 0, the `pipeline-net` network).
    Absent from the before-listing **and** on the allowlist, or it stays. A baseline that
    could not be taken is not "nothing was here" — no baseline, no removal — and reclaiming
    is never a verdict: a suite's exit code is decided before any cleanup runs, and the
    reclaimer always exits 0, so hygiene can neither mask a real failure nor invent one.
    The decision is a pure function in `scripts/sweep-reclaim.js`, which is the only thing
    under `scripts/` that removes anything, and every docker call in the sweep path goes
    through one `${SWEEP_DOCKER:-docker}` seam so the whole of it is testable with no
    daemon (change-log row `repo-zje`).

    **And the sweep's summary is an artifact, so its numbers are held to the artifact
    rule.** The per-suite count is the only signal in that table a human reads suite by
    suite, and its job is to make coverage quietly disappearing *visible*. It counted
    `PASS ` lines only, while half this repo's checkers announce a passing assertion as
    `ok - <label>`, so those suites reported the count of their wrapper's summary lines —
    2 where 34 checks had run. Present, well-formed, measuring a different thing: §3.6's
    "assert the artifact is *right*, not merely present" applied to the harness's own
    reporting. The decision now lives in `scripts/sweep-assertions.js` as a pure function
    over a log body, on the `sweep-reclaim.js` precedent — the sweep renders, it does not
    decide. Three properties are load-bearing. It counts **passes, not attempts**, and the
    column is headed `PASSED` with a legend saying so, because a count whose semantics are
    unstated is how a column comes to measure something nobody meant. A log carrying
    **both** vocabularies — a shell wrapper around a Node checker — reports one honest
    total and never their sum, since the wrapper's `PASS` lines largely *summarise* the
    `ok - ` lines beneath them; the larger of the two counts wins, so no suite's number can
    drop as a side effect. And a log with **no countable assertion line at all** renders
    `?`, not `0`: a suite whose harness broke before it asserted anything and a suite whose
    every assertion failed are different facts. None of this touches a verdict — the
    RESULT column and the exit code still come from the suite's exit code and the `FAIL`
    grep, which already saw both vocabularies (change-log row `repo-0ay`).

    **The runner owns the rest of the run lifecycle end to end:** at run start it creates
    the internal network and proxy sidecar, invokes the pre-run egress check (aborting on
    failure), and resets any issue left in-progress by an abnormal earlier end (operator
    stop, crash) back to open with an attempt-log note; at run end it tears the network
    and sidecar down — its own, and only its own. It names both in `run.log` where it
    brings them up, so a `docker ps` during two concurrent runs can be read against it. Task order: Beads' ready queue (open, unblocked, dependencies
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

**The review's verdict is recorded at the moment it is made** (change-log row
`review-verdict`). Merge-or-send-back is the one signal the pipeline cannot generate about
itself: shadow-01's own record said `done`, green, one attempt, and the human rejected it,
and nothing wrote that down — so any later reading of the run record is blind to exactly
the failure class that has mattered most. The review ritual therefore ends with one line
per PR: `node scripts/verdict.js record <issue-id> <merged|rejected> "<why>"`, which
writes a `verdict.json` beside the task's other artifacts in the run directory that
produced the PR. `verdict.js pending` lists PR-bearing tasks that still lack one, so an
unfinished review is visible rather than remembered. Three properties are load-bearing:
it is **deterministic scaffolding** (hard rule 7 — a recorder, no LLM anywhere); it is
**evidence, never a gate** (hard rule 5's shape applied to scaffolding — it changes no
outcome, edits no existing artifact, and exits 0 on findings); and it is **host-only** —
a verdict names PRs, issue titles and the reason a human gave, so it lives under the
git-ignored `runs/` directory with everything else that names the work, and is never
committed. It exists to be read back: it is the field any future audit of the run corpus
joins on, and the reason that corpus would not be blind.

**Reading the corpus is aggregation, never an agent** (change-log row `run-audit`). The
question the idea inbox parked — is the gap in *collecting* evidence or in *reading* it,
and does reading need an LLM — was settled the way the entry itself prescribed: by reading
the corpus once, by hand, before building anything. That pass (2026-08-04: 134 run
directories, 103 task records) surfaced every repeated pattern that mattered — a batch of
tasks going `partial` because each failed its *siblings'* frozen tests, an
infrastructure-killed task hand-retried three times in five minutes, a window of runs whose
recorded model was missing entirely, and a rate-limit pause counter that has never once
fired across the whole corpus — and none of it took judgment to find. It took the fields
being joined. The hand pass also made the case for freezing the tool that replaces it: its
first draft read a `concerns` key that is really named `specConcerns` and reported a
channel "never used" that has in fact been used 43 times — non-empty, well-formed, and
false, the exact shape of STATUS defect 8. A throwaway script gets that wrong silently; a
frozen suite with a fixture whose expected answer differs from what the misread would
produce cannot. So the audit is
`scripts/audit-runs.js`: a deterministic, host-only, self-contained reader of the
structured run artifacts (`run.json`, `status.json`, `verify.json`, `verdict.json`) that
prints one report and changes nothing. It is **never a gate** (exit 0 whatever it finds —
hard rule 5's shape applied to scaffolding) and holds **no LLM** (hard rule 7 does not
reach outside the run, so here it is a choice, made because a measurement that cannot
hallucinate is the entire value). It joins the verdict record above, which makes "done,
green, merged" and "done, green, rejected" different rows — the blind spot this section
opens with is the first thing the audit can see. It writes nothing at all: the report goes
to stdout, and the human redirects it if they want a copy (change-log row `repo-73k`). That
report names targets, PR URLs and issue ids, so any copy kept is **host-only** output under
the git-ignored `runs/` like everything
else that names the work; only generic findings leave it, promoted by a human into
`docs/IDEAS.md`, `docs/STATUS.md`, a memory note, or a planning session. The LLM reader
both inbox entries contemplated stays unbuilt, and this section is the recorded reason: if
a future pattern genuinely resists deterministic joining, that is a new design decision to
argue here, not a fallback to reach for.

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
  That is a statement about *one project's* queue: several runners, one per project, are
  a different thing and are already supported (change-log row `repo-jur`), because each
  has its own queue, network and proxy.
- **Rate-limit pauses go global**: one task's usage-limit exit parks the *run* rather
  than one task (every task shares the subscription window) — one shared wait and one
  run-level cycle cap, not N uncoordinated ones. **Park means "admit no new work", never
  "kill what is running"**, which is the resolution of the ambiguity this bullet's
  original wording carried: killing a live container discards agent work that may be
  minutes from finishing and spends wall-clock budget for nothing, and a container whose
  window is genuinely closed hits the limit and exits 20 by itself, joining the same
  wait. So the park holds *new launches* while the window is closed, and the parked
  workspaces relaunch when the shared wait ends. Per-task pause mechanics (4.7) are
  reused unchanged, and so is the per-task relaunch count the manifest reports.
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

**Both halves are built.** The scheduling half (change-log row `repo-teq`, 2026-07-31):
`concurrency` in `run.config.json`, default 1 and capped at 3, over a bounded worker pool
in `runner/run.js` that returns results in ready-queue order. 4.12 carries what it decided
that this section did not state. The park half (change-log row `repo-i9y`, 2026-07-31):
`createPauseGate` in `runner/pause.js`, built once per run in `main()` and shared by every
task — one wait, one run-level cycle cap, admission checked before the claim so a refused
task leaves its issue `open`. See 4.7 for the full contract.

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

- ~~One pipeline instance runs at a time on one machine~~; no multi-machine coordination.
  **Amended (change-log row `repo-jur`):** one runner process *per project* may run at a
  time on one machine, several of them at once — the network and the proxy sidecar are per
  project (4.8), and each project's queue is its own Beads database inside its own repo, so
  nothing is shared between them but the subscription window. Two runners against the *same*
  project remains excluded: that would put two writers on one queue (4.10). **No longer an
  assumption (change-log row `repo-os9`):** that exclusion is enforced rather than trusted —
  a run takes a lock on its target repo before any other gate and a second run against the
  same repo is refused by name (4.12). What is still assumed is that all of them are on one
  machine: the lock lives in this repo's `runs/` directory, so it coordinates processes on
  the host and nothing beyond it.
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
| 2026-07-27 | publish-sanitize-followup | publication hygiene becomes deterministic scaffolding instead of a hand pass. New Docker-free suite `scripts/test-sanitize.sh` with `tests/unit/sanitize.test.js` reads every tracked file as bytes — never skipping one for being binary — and fails on absolute user-home paths, absolute paths outside the standard toolchain, real email addresses and credential-shaped strings, with placeholder segments (`path/to`, a literal ellipsis, angle-bracket slots, a generic scratch root) allowed so the rule stays specific enough to leave on. Private *names* live in `.sanitize-denylist`, git-ignored with `.sanitize-denylist.example` committed as the template, because committing the list of things that must not be mentioned would publish exactly what it protects; absent, the generic checks still run and the suite prints a NOTE. `docs/pipeline-map.html`'s Crews worked example is generalised — all three lessons kept, the project name and its identifying specifics dropped. `tests/acceptance/repo-006/test.js` is amended after close: two E5 fingerprints re-taken from the sanitized §12 text, and the row count widened from an exact 27 to at least 27 | The `publish-sanitize` pass missed a private project name in a frozen acceptance test, and so did the first automated sweep that went looking for it: that file carries a literal NUL byte, so git classifies it binary and `git grep` skips it by default. A boundary that eyes have now failed twice — this repo documents the *machinery*, never the *work done with it* — is exactly the kind of rule §7's no-LLM-in-the-scaffolding principle says to make mechanical. Amending a closed task's frozen test is legal here and nowhere else: §3.1's freeze binds a task during its run so the thing being judged cannot edit its judge, and `repo-006` merged long ago; the widened assertion was the spent half of E5 (it proved that task added exactly one row), while the ordered fingerprint check carrying E5's stated meaning — no pre-existing row was lost — is untouched |
| 2026-07-28 | bd-npm-shim | `runner/bd.js` resolves host `bd` through the npm shim instead of giving up on it. `spawnSync('bd')` can execute neither Windows shim npm writes — the extensionless `/bin/sh` script returns ENOENT, the `.cmd` batch file EINVAL — so `haveHostBd()` answered "no host bd" forever and every runner Beads call took the Docker fallback, one container per invocation. The probe now falls back to reading the shim, extracting its `.js` entry point (`shimTarget`, exported and pinned by `scripts/test-bd-shim.sh`), and running it with `process.execPath`, verifying by execution rather than by shape. A shell was rejected as the fix: `bd` carries agent-authored text — attempt notes, memories, spec concerns (§3.6, §3.7) — and `cmd.exe` would mangle any quote or metacharacter in it | Found by the sweep of 2026-07-28: four runner suites were killed at 900s after `bd` was reinstalled as an npm shim that morning. Each drives its own `docker run … bd` against a fixture repo, and the runner's fallback opened a *second* container on the same embedded Dolt database; the two deadlocked with no timeout on either side. Nothing errored — the fallback is fail-safe, so a silent degradation of every Beads call presented as four unrelated hangs. The new suite asserts the differential that was the bug (wherever the shell resolves `bd`, the runner must too), never a flat "host bd exists", which would fail on a machine where the Docker fallback is the supported path |
| 2026-07-29 | push-syncs-beads | `scripts/install-hooks.sh` now installs a `pre-push` block as well, running `bd dolt push` so the issue database leaves the machine with the code. Unlike the `post-merge` auto-pull it **fails** the push when the database does not go; `BD_SKIP_AUTO_PUSH=1 git push` is the single-command override. Task workspaces are unaffected — they are plain clones with no `core.hooksPath`, so publishing a task branch is never gated on the issue database | bd's own `pre-push` hook runs, prints nothing and exits 0 having pushed no database, verified by running it and watching `refs/dolt/data` on the remote not move. So `git push` shipped code while the queue stayed local: the same silent drift the auto-pull block exists to fix, in the other direction, and the second time a hook that was present and healthy-looking did nothing. Failing is right here where it was wrong for `post-merge` — that hook runs after the merge has happened, so refusing would report a fait accompli, while pre-push runs before anything has left the machine, making a blocked push free and the only way code and issues cannot arrive separately |
| 2026-07-29 | agent-hooks-untracked | agent hooks are host-only and it is now enforced. The `hooks` entry moves from `.claude/settings.json` to the git-ignored `.claude/settings.local.json`, `.codex/hooks.json` is untracked and git-ignored while staying on disk, and a new Docker-free suite `scripts/test-agent-hooks.sh` / `tests/unit/agent-hooks.test.js` fails on any tracked file under `.claude/hooks/` or `.codex/hooks/`, any tracked `hooks.json`, or any tracked `settings*.json` carrying a `hooks` property. `AGENT_HOOKS_FIXTURE_DIR` re-aims it so the negative cases are exercisable; `ONBOARDING.md`'s "remove hooks" step now says move rather than delete, and warns that it recurs | The `dogfood-onboarding` row records this hook being removed at onboarding. It came back: `bd` rewrites `.claude/settings.json` when it re-initialises, so the `bd prime` SessionStart entry returned in a later commit and shipped into every task workspace for weeks — a hook calling `bd` inside a container that has neither `bd` nor a network. The general lesson, and the reason this became scaffolding rather than a firmer checklist line: **a one-time removal of something a tool regenerates is not a fix**, it is a countdown. The exemption for `.claude/settings.local.json` is that git ignores it, not that it is spelled `.local`, so the checker still flags it if it is ever committed |
| 2026-07-29 | adoption-assessment | `ONBOARDING.md` gains **stage 0**, a read-only readiness assessment run before the checklist when the target is a codebase that predates this way of working (skipped for a fresh scaffold). Five dimensions — verifiability, coupling versus the one-issue-one-PR fork model of §4.2, closed-network fitness, knowledge legibility, git/host readiness — resolving to one of three verdicts and a beachhead recommendation, with the concrete commands in `docs/readiness-probes.md` so the checklist itself stays short. The verdict is written to the *target* repo, never this one. It is advisory and cannot refuse a repo, in the spirit of hard rule 5. Step 5 also gains the reason its position is load-bearing: Beads takes its sync remote from git at `bd init` time, so initializing before the remote exists yields a queue that cannot sync between machines, silently and permanently | Adopting a pre-agentic codebase is mostly judgment the checklist does not carry, because it assumes a repo someone just scaffolded — and on old code the question is never whether the repo can be *configured* as a target but whether it can be **verified**, since an unverifiable one produces uninterpretable runs rather than failing runs. First built as a slash-command wrapper in this repo; that was wrong twice over — it duplicated the harness plugin's `pipeline-onboard`, and it put the judgment in a wrapper when every wrapper already reads this file top to bottom. Putting it in the checklist means all entry points inherit it and none can drift, which is the rule §12's own header states about wrappers. The distinction it exists to defend: onboarding is repo-wide and has no partial form, so what gets staged for an old codebase is the *task queue*, never the onboarding |
| 2026-07-30 | repo-jur | the task network and the proxy sidecar are **per project**, so several runner processes — one per project, each still a sequential loop over its own queue — can be in flight at once. `scripts/pipeline-net.sh` and `scripts/egress-check.sh` read `PIPELINE_NET` / `PIPELINE_PROXY` / `PIPELINE_PROXY_PORT` from the environment (the idiom `BASE_IMG` already used), each falling back to today's `pipeline-net` / `pipeline-proxy` / `3128` when unset, which is what keeps the dozen Docker suites that hard-code those names green. `runner/preflight.js` grows `networkUp(repoRoot, cfg, log, traceId)` / `networkDown(repoRoot, cfg)` / `egressCheck(repoRoot, cfg)`, the single seam that hands those three variables down; `networkUp` names the network and the sidecar in `run.log`. `run.config.json`'s `network` / `proxyName` lose their DEFAULTS entries and are instead derived from the project segment of the config file's own name, sanitised to one lower-case DNS label (a lossy sanitisation is pinned with an 8-hex digest of the original, so two project names that reduce to the same label still differ); a bare `run.config.json` keeps the historical pair, and `run.config.example.json` no longer pins either. §4.8 and §4.12 amended, and §9's "one pipeline instance runs at a time on one machine" with it — one runner *per project*, several at once, is what that now means. A fifth Docker-free suite, `scripts/test-network-names.sh` / `tests/unit/network-names.test.js`, keeps the runner half covered once the frozen acceptance directory stops being re-run; the scripts' own defaults stay covered by the Docker suites that run them for real, since a fake `docker` on PATH that failed to intercept would either drive the live daemon or report every check as a genuine failure. The proxy *image* tag `pipeline-proxy:local` stays shared, and the allowlist is untouched (hard rule 6: names move, policy does not) | Both names were constants in two scripts, so the `network`/`proxyName` fields already in every config reached the task container and nothing else. Starting a second run ran an unconditional `docker rm -f pipeline-proxy` — destroying the first run's only route to Anthropic — and finishing either run removed the network and sidecar for both. Neither failure announced itself: the surviving run just lost its plumbing and its agent began failing in ways that read as the model's fault. A shared *default* is the same bug one step back, which is why derivation replaced the DEFAULTS entries rather than backing them up, and why it is a pure function of the file name — a pid- or clock-derived name passes every uniqueness check and then orphans the network, because teardown computes a different name than setup did. Not the intra-run parallelism of §7 (change-log row `parallelism-v2`), which stays out of scope |
| 2026-07-30 | idea-inbox | §3.2 gains an **idea inbox** upstream of the spec pipeline: every repo — this one and every onboarded target — carries a `docs/IDEAS.md` holding parked "a design might be wanted here someday" notes, with **Promoted** and **Dropped** tables recording what left and why. It has no gate, no owner and no obligations; nothing is built from an entry directly, and an idea that graduates leaves through step 1 like anything else, so §3.1's `design-ref` rule still catches a skipped decision. `PLANNING.md` gains step 0 (read the inbox for candidates, move graduates to Promoted, move declines to Dropped with the reason) and `ONBOARDING.md` §2 the checklist line that creates one. Inboxes are **per repo, never central** | The three levels in §3.1 each demand a formed thought, and forming one costs an interview or a planning session — paid at the moment the idea occurs, which is the moment there is least appetite for it. The failure this prevents is a *misfiled* idea rather than a lost one: the only cheap home that existed was a Beads issue, and an issue is a commitment that appears in `bd ready` — the queue the runner drains unattended — so the inbox would have been able to start a container. Per-repo is forced rather than preferred (change-log row `publish-sanitize`): this repo is public and documents the machinery, never the work done with it, so a target project's ideas cannot be filed here without leaking the name the boundary protects |
| 2026-07-30 | spec-panel-below-line | §3.2 gains **"Below the panel"** — five moves that take spec-quality work off the critic panel and put it where it is mechanical or upstream, after the first full panel run on a real backlog returned `concerns` on every spec in the batch. **Built here**, all playbook text: (2) the `trivial` no-critics exemption is **deleted** — the label decides critic depth, never existence, so `trivial` and `medium` both take one testability pass; (4) every critic `details[]` finding carries a **disposition** (accepted / rejected-with-reason / deferred) into the planning draft; (5) step 1 **splits in two** — intent drafted in session, the "Done means" list drafted in fresh context after reading the code the criteria touch. **Declared here, built after** in this order: (1) a freeze gate running each frozen test against the fork-point commit and requiring **red**, distinguishing an assertion failure from a load error and exempting explicitly-labelled **guard** criteria whose count is reported in the approval pass; (3a) a check that no criterion names a path in the target's `frozenPaths`; (3b) a check that no criterion cites a configuration key the target does not define, which needs a new `pipeline.config.json` field and comes last. Critics keep fresh context with no caching between them; batching two closely-related specs is allowed with its cost stated. `scripts/test-planning-playbook.sh` gains a `PLAYBOOK_FILE` seam and an anti-regression grep asserting the deleted exemption stays deleted | The panel catching every spec is not a triumph, it is a measurement of how much work sits above the line that could be below it — §3.5's escalation ladder pointed at the panel itself. The `trivial` exemption was **self-referential**: the label is chosen by the drafter before any review, and the critic whose charter checks whether the label fits is the scope critic, exactly the one the label skips. The fork-point gate is the "assert the artifact is right, not merely present" rule turned on specs rather than on artifacts — a criterion green against unmodified `main` passes a correct implementation, a broken one and an empty diff alike — and it needs the load-error carve-out because a suite that cannot execute reports genuine-looking failures, which this repo has already shipped once. Guards are labelled rather than banned because a pure refactor's only honest criteria *are* guards. Move 5 is the one aimed at the cause instead of the filter: every strong finding in that run came from a critic doing archaeology in the implementation, so the critics were not smarter than the drafter, they were unprimed and reading the code |
| 2026-07-30 | spec-lint-frozen-paths | §3.2's move 3(a) is built: `scripts/spec-lint.js` reports any draft-spec line naming a path in the target's `frozenPaths`, with `file:line`, the path matched and why it matters. It reads `pipeline.config.json` from the working tree (planning time has no fork point to read from, and nothing here judges a run), takes `--repo <target>` or an explicit `--frozen a,b`, and exits `0` clean / `1` findings / `2` could not run — the third code distinct so a typo'd path cannot read as a passing lint. **The acceptance directory is deliberately excluded** even when a config lists it: `pipeline/verify.js` freezes `['tests/acceptance/', ...frozenPaths]`, but planning legitimately writes tests into the first half, so including it would fire on every spec ever drafted. `tests/unit/spec-lint.test.js` pins that exclusion against the verifier's own literal so the two cannot drift, and exercises each rule from both sides — the tamper-order fixture that must fire, and near-misses (`run-regression.sh.bak`, `my-tools/run-regression.sh`, `.shim`, a line quoting the config) that must not. `scripts/test-spec-lint.sh` adds the CLI contract on top: the three exit codes, and that the report names the path, the line and the reason. `PLANNING.md` step 2 becomes "run the mechanical checks, then the critics", and findings take a disposition exactly like a critic's rather than gating | Two drafts in the first real panel run ordered the agent to edit a script in `frozenPaths`, which ends the task `tampered` on every attempt before any test result exists — a whole run wasted on a defect a grep finds for free, which is what "below the panel" means. The near-miss half of the suite is the load-bearing half: a lint that also fires on `tests/acceptance/` fires on every spec, and a check that cries wolf is switched off within a week, so the cases that must **not** match are what keep it alive. Verified against the real draft that recorded the original failure — it matched both frozen scripts and exited 1. Reporting rather than gating is deliberate: the same line can name a frozen path to forbid touching it, which is legal, so a human dispositions it — mechanical detection, human judgment, which is the split §3.5's ladder is arguing for |
| 2026-07-30 | freeze-gate-red | §3.2's move 1 is built: `scripts/freeze-gate.js` runs the target's `verifyCommand` against a spec's new acceptance tests before the approval pass and requires **red**. The state it measures needs no reconstruction — tests are committed to the integration branch at freeze and a task branch forks from there, so the fork point is exactly "tests present, implementation absent", which is the planning-time working tree. **Red is not one state**, so the gate takes a second observation rather than trusting an exit code: it runs the same command against a **control** — `tests/acceptance/_control/`, one trivially-passing test committed per project at onboarding, overridable with `--control` — and reads the pair. Real red + control green is genuine red (exit 0); real green is a spec bug (exit 1); real red + control red means the command fails even on a test known to pass, so its exit carries no signal about these tests and the verdict is **indeterminate** (exit 2), never a pass. **The control is a passing test and not an empty directory, and that correction is the load-bearing one**: the first implementation probed with an empty directory to avoid needing a per-project fixture, and a good runner *should* fail on "no test files found" — silently passing on zero tests is the vacuous success this gate exists to prevent — so the empty probe fails on exactly the well-built runners the gate most needs, answering `indeterminate` for every one of them. This repo's own `tools/run-acceptance.sh` does it, which is how it was caught, on the first run against a real verify command rather than a stub. Where no control fixture exists the gate falls back to the empty probe and **says so in the report**, and its indeterminate message names the fixture to add rather than blaming a harness that is fine. **Guards** — criteria asserting existing behaviour still holds — stay legal, are labelled `[guard]` in the spec, and their count is printed for the approval pass. `PLANNING.md` step 4 becomes "Coverage check, then prove the tests can fail", stating all three verdicts; `scripts/test-freeze-gate.sh` / `tests/unit/freeze-gate.test.js` cover the decision table from every side with the verify command stubbed through `FREEZE_GATE_CMD` | Criteria satisfied by an empty diff were the largest category the first real panel run found — one was a tautology that would have passed a correct implementation, a broken one and a submission that never ran the code under test. A test that cannot fail is not a weak test, it is not a test, and whether it can fail is a fact a script can establish rather than a judgment a critic has to make. The control run is the part that keeps it from becoming superstition: a suite that cannot load exits non-zero exactly like a genuine assertion failure, and this repo has already shipped a suite that could not execute its own stub and reported every check as a real failure. Without a second observation the gate would bless precisely that. Reporting indeterminate is the honest third answer — an "it cannot tell" that refuses to round toward the convenient verdict is the difference between scaffolding and a rubber stamp. The empty-directory control was corrected before this row was written rather than after, and the correction is worth recording because the reasoning that produced the bug is attractive: avoiding a per-project fixture looked like portability, and was actually a probe whose failure rate rises with the quality of the runner it is aimed at. The tell was running it once against a real `verifyCommand` instead of only the stub, which is the same lesson as the fixture that passes against the bug — a check exercised only where it was designed to work has not been checked |
| 2026-07-31 | repo-os9 | a run takes a **lock on its target repo** and a second run against the same project is refused by name. `runner/lock.js` exports `acquire(repoRoot, targetRepoPath, runId)` and `release(repoRoot, targetRepoPath)`; the lock file lives under this repo's git-ignored `runs/` directory, beside the sweep lock `scripts/test-all.sh` already takes. `runner/preflight.js` acquires it as its **first** gate, ahead of the Docker probe, and releases it on every one of its own later failures; `runner/run.js` skips its network teardown when the refusal was the lock (nothing of ours was ever created) and registers the release against process exit at the moment the lock becomes ours, so the queue-read abort, an unexpected throw and the normal end all leave the project free. Project identity is the **canonicalised** repo path — trailing separator, Windows separator flip and case folded, symlinks resolved where they resolve — because configs write `targetRepoPath` with forward slashes while `path.join` produces backslashes, and one repo under two spellings is the very mistake the lock exists to catch. A holder that is **gone is taken over**, and the takeover names the run it displaced in `run.log` and in what `acquire` returns. §4.12 amended with all of it, and §9's "two runners against the same project remains excluded" with it — enforced now, not assumed | Per-project plumbing (change-log row `repo-jur`) made different projects independent and did nothing about starting one project twice, which is then the remaining way to corrupt a run and the easy mistake to make, because the second run looks like it starts normally: both runners read the ready queue, both can claim the same issue, both push a branch for it, and §4.10's sole-writer rule assumes one writer. First-and-not-merely-early is the load-bearing ordering — every later gate probes Docker or writes to Beads, and a refusal arriving after the stale-issue sweep has already reset another live run's in-progress issues has not refused anything useful; it is also what makes a refusal free of cleanup and the whole thing testable without Docker. Deciding a holder is dead takes more than a pid: `process.kill(pid, 0)` reports a recycled or foreign pid as alive and EPERM counts as alive, so a pid-only record refuses to take over after a reboot — the block-forever the takeover exists to prevent — which is why the record carries the process start time where the OS exposes one plus the host uptime counter, which only resets at boot. Where a platform can prove neither, a pid recycled inside one boot reads as still held: a spurious refusal is visible and recoverable, a spurious takeover puts two runners on one queue. Release is deliberately not registered inside `acquire`, since a crashed run must leave its lock for the next run to seize, and it removes only a record that says it is ours — a refused run freeing the lock it was just refused by would hand the project to the third run to ask |
| 2026-07-31 | repo-sls | §4.1 extends the runner's timeout mandate to the tools it shells out to itself: **every runner `bd` call is bounded**, via a single `spawnOptions(cfg)` builder exported from `runner/bd.js` that every `spawnSync` in the module is constructed from — the `PIPELINE_BD_CMD` seam, the host-`bd` path, the Docker fallback, and both host-`bd` probes in `hostBdSpec`, since a probe that hangs parks a run exactly as a call that hangs does. The bound is `spawnSync`'s native `timeout` with `killSignal: 'SIGKILL'` (a bound a wedged process can decline to honour is not a bound), read from `bdTimeoutMs` in `run.config.json` — §4.12, default 60000, validated by `loadConfig` as a positive whole number in the existing field-naming error shape, and present in `run.config.example.json`. A call that exceeds it surfaces as status 124 with stderr naming the bound and the field that set it, so `bdJson` returns `ok:false` with that message and is never confusable with a successful empty query, and no caller's behaviour changes: ready-queue failure still aborts the run, claim failure still skips the issue, export failure still fails the task, and finish / note / stale-recovery / memory-filing failures are still logged with the run continuing. §4.10 additionally records that `bd()` stays **synchronous** — that is now a stated invariant, not an accident of the implementation | Observed twice on 2026-07-28: `bd` emitted its complete JSON output and then never exited, and concurrent access to one embedded Dolt database blocked indefinitely. Four sweep suites were killed at 900s by `scripts/test-all.sh`; a real run has no such backstop and would park until a human noticed. The exposure is worst after the container exits, where the `bd remember` / finish pair runs: a hang there strands finished work with the issue still `in_progress` and the outcome unwritten. It ships **before** §7's worker pool (change-log row `parallelism-v2`, issue `repo-teq`) because `spawnSync` blocks the event loop — one hung `bd` call would stall every concurrent task rather than one — and because the load that produced the original hang was concurrent access to a single embedded database, which is exactly what parallelism increases. Keeping the bound synchronous is the same reasoning read the other way: an async rewrite would silently remove the serialisation the sole-writer rule rests on, at exactly the moment tasks start running concurrently. The knob is a config field and not a `PIPELINE_*` variable because that namespace is reserved for test seams — the planning session's first draft demoted it to an environment variable to keep two tasks in one batch, and the scope critic named that as batching convenience bending the configuration contract (`docs/STATUS.md`, the 2026-07-31 parallelism session) |
| 2026-07-31 | repo-zje | the sweep **reclaims only what it created, after every suite**. `scripts/test-all.sh` keeps no removal path of its own: it delegates to a new `scripts/sweep-reclaim.js`, whose `reclaimTargets(before, after)` is a pure decision — a resource is reclaimable only if it was absent from the listing taken before the suite AND matches the pipeline allowlist (`pipeline-base:local` / `pipeline-proxy:local` ancestry, the exact name `pipeline-proxy`, a `task-` prefix anchored at position 0, the `pipeline-net` network), containers before networks. It runs after every suite, gated on nothing; the summary note names what went, by identity, instead of the fixed string it used to print to the console; and no baseline means no removal, since a listing that failed is not evidence that nothing was there. Every docker call in the sweep path, the `docker info` and `docker image inspect` prechecks included, goes through one `${SWEEP_DOCKER:-docker}` seam, which makes the whole of it drivable with no daemon: new Docker-free suite `scripts/test-sweep-hygiene.sh` over `tests/unit/sweep-hygiene.test.js` copies the real sweep into a temp root and runs it against a recording stand-in. The three runner suites that cleaned up with `docker ps -aq --filter name=task- | xargs -r docker rm -f` now snapshot at their top and reclaim against it in their trap, and `test-egress.sh` / `test-egress-check.sh` move their teardown into an `EXIT` trap. §4.12 amended with the ownership rule | The cleanup block was wrong in four compounding ways: gated on `pipeline-net` still existing, so a suite leaking containers but no network got none of it; the stray-container pass gated AGAIN on the suite having timed out, so a suite that exited 1 having orphaned containers was not cleaned at all; filtered on `ancestor=pipeline-base:local`, which cannot match `pipeline-proxy:local` — the one container the sweep itself indirectly creates; and noted a fixed string, so removals were echoed to a console nobody re-reads and never reached the summary table. Worse was live and in the other direction: `--filter name=task-` is a **substring** match, so three suites were force-removing any container on the host whose name merely contains `task-` (`my-task-runner`), and the reference host runs unrelated long-lived containers. A harness that deletes a developer's work to tidy up is worse than one that leaves debris, which is why ownership is a snapshot diff intersected with an allowlist rather than a name filter, and why the guards that matter are negative — `test-all.sh` must contain no removal path, no suite may use an unanchored name filter — so they cannot be satisfied by code that never runs. The stand-in is safe where a PATH stub for `pipeline-net.sh` was rejected (change-log row `repo-jur`): `down` removes the network and proxy by name unconditionally, so a miss would delete the real ones, whereas a missed seam here yields an empty diff and removes nothing |
| 2026-07-31 | repo-teq | **one runner works N tasks of one project at once**, opt-in. `concurrency` in `run.config.json` — default 1, validated as a whole number from 1 to a literal 3 in the existing field-naming error shape, exported from `runner/config.js` as `MAX_CONCURRENCY`, and present in `run.config.example.json` at its default. `runner/run.js` exports `drainQueue(issues, taskFn, concurrency)`: N fixed workers pulling from one shared cursor, each writing into its own index, so the resolved array is index-aligned with the ready queue rather than with completion order; the per-task body moves out of the loop into `runOneTask(cfg, issue, log, token)` and `main()` is guarded behind `require.main === module`, which is what makes any of it reachable from a Docker-free test. The `PIPELINE_EXEC_STUB` branch of `executeTask` becomes asynchronous (`spawn`, not `spawnSync`), keeping its `bash <stub>` invocation, its four environment variables and its 124 -> `killed` mapping. The manifest gains a top-level `concurrency` holding the **configured** setting, admitted by `schemas/run.schema.json` as optional (the root is `additionalProperties:false`, and `scripts/test-report.sh` validates a fixture manifest that predates the field). New Docker-free suite `scripts/test-concurrency.sh` over `tests/unit/concurrency.test.js`, the eighth. §4.12 amended with the four things §7 left unstated — the pool, ready-queue result ordering, the exported scheduler, and the deliberate synchrony of clone and publish — and §7 marked half-built | The scheduling half of change-log row `parallelism-v2`, measured before it was built: `docs/parallelism-findings-2026-07-31.md` clocked 2.75x on three evenly-matched tasks and 1.28x on a batch whose slowest task was 3.6x its sibling, which is why the default stays 1 and the ceiling is small — a batch is bounded by its slowest task, not by how many it holds, and the knob is for daytime batches, not for long unattended runs where budget exhaustion mid-batch leaves everything half-done. Deliberately not included: the rate-limit park stays per task (`repo-i9y`), so at depth > 1 N parked tasks each run their own pause loop against one shared window — wasteful, not corrupting, and unreachable at the default, which is what makes shipping the pool first safe. `workspace.prepare()` and `publish()` stay synchronous and serialise the workers for a few seconds each: a rounding error against container times in tens of minutes, where making them async would widen this into four more runner files, and the one visible consequence — a kill timer firing late while a peer clones — is accepted here rather than discovered later. The restructure had every reason to move `fileMemoryNotes`, `queueSummary`, `shouldFileMemory` and the literal `exitCode !== 20`, which four frozen acceptance suites and one Docker suite assert against `run.js` source; this repo declares no `regressionCommand` and nothing re-runs a frozen directory, so a guard criterion that was green before the change carries them |
| 2026-07-31 | repo-i9y | **the rate-limit park becomes run-level**, which is §7's remaining half. `runner/pause.js` exports `createPauseGate(cfg, log, opts)`; `runner/run.js` builds exactly one gate in `main()` and passes it to every `runOneTask(cfg, issue, log, token, gate)`, and `waitForWindow` is no longer called from `run.js` at all. The gate owns **one shared wait** — the first exit 20 of the run opens it on that task's reported reset time, and a later reporter arriving while it is in flight *joins* it (the join decision is made synchronously on entry, before any await, so N containers hitting the limit in one tick find one wait between them) and never extends it; if the window is still closed when the wait ends, the relaunched tasks exit 20 again and open a fresh one. It owns **one run-level cycle counter**: `waitForWindow`'s `spentCycles`/`maxPauses` are handed in from the gate rather than from a per-task local, the count is read from the result's `pauses` and from nowhere else — a `{resumed:false, reason}` carries no count, so it leaves the counter exactly as it was rather than making it `NaN` or resetting it to zero — and `pause.js`'s duplicate hard-coded 96 now defers to `config.js`'s `DEFAULTS`. `gate.admit()` has exactly three states (pass straight through, hold behind the shared wait, refuse once exhausted), is consulted **before** `claim()`, and never opens a wait of its own. **Park means admit no new work, never kill what is running**, and §7's bullet is amended to say so. §4.7 amended: the bound is per run, the two populations a fired cap produces are stated, and the per-task relaunch count the manifest reports stays per task. New Docker-free suite `scripts/test-pause-gate.sh` over `tests/unit/pause-gate.test.js`, the ninth; `schemas/run.schema.json` needed no edit, since its outcome enum already admits `paused` | A usage limit is a property of the **subscription window**, not of a task, and change-log row `repo-teq` had just made N tasks run at once — so N parked tasks each ran their own pause loop, each with its own cap, against one shared window: N uncoordinated *sleeps* (nothing is probed on the reset-time path) and a cap that N tasks could collectively blow through N times over. The three things §7 left open are resolved here rather than left to the implementation. **Killing live containers was the reading to reject**: it discards agent work that may be minutes from finishing and spends wall-clock budget for nothing, while a container whose window is genuinely closed exits 20 by itself and joins the same wait — so the park holds new launches only. **The refused population needed a decision of its own**: `admit()` sits before `claim()` so a task the cap refuses never touches Beads and its issue stays `open` for the next run, but it still resolves a synthesized `{issueId, outcome:'paused'}` row, because `main()`'s `.filter(Boolean)` would otherwise erase it from `run.json` entirely — a silent hole in the record of an unattended overnight run, which is the failure mode this project keeps finding in artifacts that are non-empty and wrong. The reconnaissance that shaped the frozen tests is worth keeping: `waitForWindow`'s failure branch carries **no** count and `run.js` was papering over that with `waited.pauses || waitCycles`; two different quantities were both called `pauses` (wait cycles in `pause.js`, relaunches in `run.js`, and the manifest reports the latter); and `pause.js`'s comment named stop conditions — deadline exceeded, operator stop — that do not exist. Three runner Docker suites grep log strings out of `run.js` and `pause.js` by name, `scripts/test-runner-pause.sh:136` greps the literal `exitCode !== 20` out of `run.js` **specifically**, and this repo declares no `regressionCommand`, so those strings are held by a guard criterion rather than by anything that re-runs |
| 2026-07-31 | repo-0ay | the sweep summary **counts assertions in both of this repo's vocabularies**. `scripts/test-all.sh` delegates its per-suite count to a new `scripts/sweep-assertions.js`, whose `countAssertions(logText)` is a pure decision over a log body (the `sweep-reclaim.js` precedent: the sweep renders, it does not decide) returning the count, the vocabulary counted, and whether any countable line was found at all. It counts **passes, not attempts** — 7 `ok - ` beside 2 `FAIL - ` reports 7, because `^PASS` counted passes and moving the semantics would silently move every existing suite's number — and the column is renamed `ASSERTS` → `PASSED` with a legend under the table naming both vocabularies, since an unlabelled number is how a column comes to measure something nobody meant. A log carrying **both** vocabularies reports one honest total and never their sum: the larger of the two counts wins, which is the inner checker's where a wrapper summarises it, and which can never render a number below what the old counter produced. A log with **no** countable assertion line renders `?` rather than `0`. New Docker-free suite `scripts/test-sweep-assertions.sh` over `tests/unit/sweep-assertions.test.js` — the tenth — plants logs, drives a copy of the real sweep over stub suites, and pins that the RESULT column and the exit code are untouched, including with the helper absent, where the pre-existing grep still answers. §4.12 amended | The `ASSERTS` column is the only per-suite signal in the summary a human reads, and its actual job is to make coverage quietly disappearing visible. It counted `^PASS[[:space:]]` only, while the Node checkers under `tests/` announce a passing assertion as `ok - <label>`, so a suite in that vocabulary reported the count of its **wrapper's** summary lines: `test-network-names` read 2 against 34 real checks, `test-sweep-hygiene` 3 on the 2026-07-31 sweep. One of those could have fallen from 34 checks to 3 and the number would not have moved. That is the shape of every silent-degradation defect recorded here — a value that is present, well-formed and wrong (§3.6, `docs/STATUS.md` defects 2, 5, 7, 8) — and it was filed in `docs/IDEAS.md` on 2026-07-30 rather than fixed alongside change-log row `repo-zje`, because which vocabulary should win is a decision and bundling it would have put a coverage-reporting change inside a hygiene task. Only the pass side was ever affected: both vocabularies begin a failure line with `FAIL` and whitespace, so the "printed FAIL but exited 0" net already saw both, which is why this could be a pure counting change with no verdict in reach of it |
| 2026-08-01 | spec-concern-surfacing | §3.7's **host side ships**, completing the channel `repo-1cy` built the container half of. `runner/run.js` carries `specConcerns` from the status file onto the manifest row, `schemas/run.schema.json` declares the field with the same bounds as `status.schema.json` (5 × 1000; the manifest is `additionalProperties: false`, so the contract had to admit the field before anything could carry it), `runner/report.js` renders a `⚠ Spec concern(s) raised (n)` block and `runner/publish.js` an identically-worded PR-body section — both **above the change summary**, both quoting every entry verbatim, and both stating that the outcome was unaffected. `runner/queue.js`'s `attemptNotes` adds a count line so the Beads issue points at the report. Ordering is deliberately untouched: `scrutinyKey` never reads the field, and `scripts/test-report.sh` asserts that a first-try `done` carrying two concerns still sorts last | The channel was declared 2026-07-26 and half-built, and the gap was not theoretical for long: the first real concern any run has raised reached the status file and stopped there. The report said nothing, the PR body said nothing, the issue said nothing; it was found only by reading `status.json` by hand. Placement is the whole point rather than a detail: a concern cannot change an outcome, so it rides on whatever the task scored, and `done` sorts LAST — that first concern sat at the bottom of a one-task report under a heading reading DONE. Rendering it above the summary is what makes the channel do the thing §3.3 opened it for. Its content argued the same case twice over: the frozen test required one member name to be answerable both as a method and as a property, which the target language cannot do from a single class, and the agent measured that the method-only reading made the value hang the engine when iterated rather than erroring — so that spec would have timed the runner out instead of reporting red. A freeze-gate hazard in the same family as the load-error carve-out, and unactionable to anyone who never saw it |
| 2026-08-04 | trace-ledger | the **spec-to-code traceability convention** and its report ship, promoted from the `docs/IDEAS.md` 2026-08-04 entry. The convention: a ticked spec checkbox carries the id of the issue that ticked it, as a trailing parenthesised ref — `- [x] the thing shipped (repo-abc)` — written at the moment the edge exists, by whoever ticks the box, so no tool ever has to infer a link after the fact. `scripts/trace.js` reads only two sources — checkbox lines in markdown, issue ids already present in commit messages — and prints three lists: ticked boxes no issue witnesses, refs naming an id git has never seen, and merged work no box records. It is a report, never a gate: exit 0 whatever it finds, because drift is planning evidence, not a verdict (the shape hard rules 5 and 7 demand of scaffolding). Its `backfill` mode recovers missing refs deterministically — `git log -L` finds the commit that introduced the tick, so a later prose edit on the same line cannot be blamed for it — and refuses to guess when the ticking commit names no issue. Docker-free suite `scripts/test-trace.sh` / `tests/unit/trace.test.js` drives the real CLI against throwaway git repositories (CRLF fixtures, since the reference host is CRLF and containers see LF). PLANNING.md step 0 gains the reconciliation read against the target. | six inbox entries were one disease — the map and the territory drift, in both directions — and every drift check was re-deriving, by reading, a link that existed for one moment at merge time and was recorded nowhere. Recording the edge when it is created makes reconciliation mechanical with zero inference; an LLM guessing edges would be non-empty, well-formed and wrong (§3.6). |
| 2026-08-04 | review-verdict | §5 gains the **review verdict record**, promoted from the `docs/IDEAS.md` 2026-08-04 entry: the review ritual ends with `node scripts/verdict.js record <issue-id> <merged\|rejected> "<why>"` per PR, writing a `verdict.json` into the task's directory under the run that produced the PR, and `verdict.js pending` lists PR-bearing tasks still lacking one. Deterministic scaffolding, evidence never a gate, host-only under the git-ignored `runs/` — declared here at planning time; the implementing task adds its own row when it ships | the run record's most valuable field is the one the pipeline does not own: shadow-01 said `done`, green, one attempt, and the human rejected it, and nothing recorded that verdict. Both agent-shaped inbox entries (the run-corpus audit and the session reviewer) independently concluded the missing piece is a cheap capture step, not a reviewing agent — the verdict exists for one moment at review time, and anything that tries to recover it later is inferring what could simply have been written down (the same reasoning as change-log row `trace-ledger`, applied to the review phase) |
| 2026-08-04 | run-audit | §5 gains the **run-history audit**, promoted from the `docs/IDEAS.md` audit-the-corpus entry by doing what that entry prescribed first: a hand pass over the full corpus (134 run directories, 103 task records). The pass answered the entry's own open question — the gap is *reading*, and reading is deterministic joining, not judgment — so the audit is `scripts/audit-runs.js`: deterministic, host-only, self-contained, output under the git-ignored `runs/` only, never a gate (exit 0 on findings), no LLM. It joins `verdict.json` (change-log row `review-verdict`) so a merged and a rejected green run are different rows. Declared here at planning time; the implementing task adds its own row when it ships | the corpus pass found four repeated patterns no single-run reading had surfaced — sibling-frozen-test partials across a batch, an infra-killed task hand-retried three times in five minutes, a run window with no recorded model, and a pause counter that has never fired — and every one fell out of joining structured fields. The pass also mis-keyed `specConcerns` as `concerns` and reported a 43-use channel as never used, which is the argument for freezing the tool: an LLM reader would add hallucination risk to a measurement, and a throwaway script already produced the plausible-and-wrong number defect 8 warns about. The entry's counter-argument (aggregation, not another author) won on the evidence |
| 2026-08-05 | repo-73k | the run-history audit **ships**: `scripts/audit-runs.js` walks the runs root and prints one markdown report — the three-bucket corpus taxonomy (real run, preflight dir, other, each named with its kind, all reconciling against the raw total), preflight reasons grouped from the last ERROR line with its timestamp and tag stripped, per-target outcomes, the attempts/pauses/models tallies, repeated issueIds, partial forensics from `verify.json`, channel usage (`specConcerns`, `memoryNotes`, verdict coverage and the done-but-rejected join) and nearest-rank distributions. Three properties are frozen rather than assumed: it is a **pure reader** (a recursive content-hash snapshot of the runs root, the script directory and a dedicated empty cwd is identical afterwards), it is **never a gate** (exit 0 on any readable tree; non-zero only for a usage error), and its output is **deterministic to the byte**. `AUDIT_RUNS_DIR` re-aims the root, default `<script dir>/../runs`, never the cwd. Covered forever by `scripts/test-audit-runs.sh` over `tests/unit/audit-runs.test.js` — the twelfth Docker-free suite | the row above declared the tool at planning time; this is the shipping half. What the frozen suite adds beyond ‘it runs’ is the discriminating fixture in each place a reader can be plausible and wrong: a decoy `concerns` array beside the real `specConcerns` (the misread that reported a 43-use channel as never used would print a different number), a sample set whose p95 differs between nearest-rank and interpolation (the interpolated figure is one no run ever produced, and float noise is what would break byte-determinism), a CRLF `run.log` that must group with its LF twin, an undated `run.json` that must sort oldest against a runId order and an mtime that both say otherwise, and structural checks that every `require` is a node built-in — the script is meant to be copied, and that property decays with nothing behavioural to see it |
