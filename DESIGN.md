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
move 1, as `scripts/freeze-gate.js`, which runs the target's `verifyCommand` against the new
tests and against a control, and reads the pair, so a broken harness is reported as
*indeterminate* instead of being blessed as red. *Then* (change-log row `repo-uw6`): move 6, as
a second **textual** pass inside the same gate, printing `brittleness findings:` beside
`guards declared:` and touching neither the verdict nor the exit code. *Then* (change-log row
`repo-inj`): the gate's second input, `--green <probe-dir>`, which runs the same suite a second
and third time in a throwaway tree where the criteria are already satisfied — so the gate has
seen the suite **pass** as well as fail, and the two verdicts that needs are added to the table
below. Move 3(b) alone remains declared and unbuilt, the §3.7 declared-then-built sequencing.

**The gate's table, as it now stands.** Red is not one state and neither is the proof:

| fork point | its control | probe | its control | verdict | exit |
|---|---|---|---|---|---|
| green | — | — | — | `green` — the suite cannot detect anything | 1 |
| red | not green | — | — | `indeterminate` — a broken harness, not a red test | 2 |
| red | green | — | — | `half-proven` — legal, and it proceeds | 4 |
| red | green | green | green | `red` — it discriminates, in both directions | 0 |
| red | green | red | green | `unreachable` — no implementation may be able to pass it | 3 |
| red | green | any | not green | `indeterminate` — the **probe** is the broken side | 2 |
| red | green | *(guard subset red)* | — | `stale-guard` — a file declaring itself `[guard]` is red before any work exists: a stale pin, never a pass | 5 |

The load-bearing line is the last one. A broken probe is never `unreachable`: exit 3 is
reachable only behind a green probe control, because otherwise the probe's red says nothing
about the criteria, exactly as the fork point's red says nothing when its own control fails.
`half-proven` proceeds because a probe is real work and a one-line criterion rarely earns it —
but the state is carried into the approval pass the way the guard count is, so a spec proven on
one side only is visible rather than assumed. The probe's copy of the suite is hashed against
the fork point's before any probe run: a missing, edited or added check is an exit-2 refusal,
because a probe that satisfies the criteria by changing the judge would bless the freeze the
gate exists to prevent.

**The planning launcher builds the other half by default** (change-log row
`automatic-green-probe`). After the test author exits, a deterministic audit permits changes
only inside that issue's suite. The host then creates two independent clones at the author's
exact HEAD, overlays the suite into both, and launches a second pinned model only in the green
copy. That model has file tools but no shell. Verifier code is still probe-controlled code, so
the host starts it only in the configured project image with no network, credentials,
capabilities or host mount beyond the disposable clone; it never executes on the host. The
baseline copy, the entire acceptance tree, `pipeline.config.json`, and configured frozen Git
pathspecs form an immutable manifest, including wildcard and ignored matches. Only exit 0 with
that manifest unchanged reports success. Verifier containers have resource limits, an owned
name/CID, and deterministic timeout cleanup; clone ownership is also recorded outside the
model-editable tree. The real author worktree gains no receipt. Both owned clones survive so a
later human-approved freeze can re-gate without touching integration first, then transactionally
promote the exact suite and receipt. Freeze refuses unrelated staged paths, builds the commit from
a private immutable index, and pushes that exact object under a remote lease before the runner's
own readback, only then removing the owned clones.

**The stale guard, and the receipt** (change-log rows `stale-guard-design`, `receipt-design`).
Two more things the gate says, both added after twelve stuck tasks in one fortnight were
traced to frozen suites no implementation could pass. First: a test file that declares
itself a guard — the literal `[guard]` token on a comment line within its first ten lines,
the same word the spec uses — is run **alone** against the fork point and must be green
there. A guard is by definition "existing behaviour still holds", so a red guard before any
work exists can only be a pin that has already moved: four of the twelve were exactly that.
The verdict is `stale-guard`, exit 5, reachable from one row of the table and never a pass;
it beats `half-proven`, `red` and `unreachable`, and it short-circuits the probe. A guard
subset that cannot run (exit above 1, or a failed spawn) is `indeterminate`, naming the
guard side. Second: on a verdict that proceeds — `red` or `half-proven` — the gate writes a
**receipt**, `tests/acceptance/<issue-id>/.freeze-gate.json`: the gate version, the
verdict, whether a probe was supplied, a content hash of the suite, the planning
checkout's HEAD when the gate ran (informational, never compared), the guard count, the
brittleness count and a timestamp. The hash is over **git blob ids** — `git hash-object`
after the clean filter, for every file `git ls-files --cached --others --exclude-standard`
lists in the suite except the receipt itself, taken before the suite is run — never raw
bytes, because the reference host's checkout is CRLF and the committed blob is LF, so a
byte hash would disagree with the branch on every freeze. The formula is one exported
function, `runner/suite-hash.js`, that the gate and the dispatch gate (4.12's third
admission rule) both import, so the two cannot drift. The receipt lives inside the frozen
path, so the verifier already diffs it and a container that edits it is `tampered` with no
new rule. What the receipt buys is that a freeze becomes a **fact the runner can check**
rather than a step the playbook asks for: fourteen planning drafts on the first real
project mentioned the gate zero times, and nothing could tell.

*The stale guard is built* (change-log row `repo-i4b`), and the receipt writer beside it
(change-log row `repo-erq`, below). Four mechanics of the guard subset are decisions rather than details, and each
exists because the other reading is silently wrong. **When it runs:** once, and only from a
fork point red at exactly 1 on a control proven green — the one state in which the
suite-level observation is readable at all, so anywhere else a guard's red would be one
more uninterpretable number rather than a finding. It reuses that tree's control result
rather than taking one of its own, because the control answers a question about the tree
and the command and was answered a moment ago by both. **Where it runs:**
`<parent of --tests>/.freeze-gate-guards-<pid>-<seq>/`, a sibling of the suite at the same
depth, handed to the project's own verify command as a repo-relative POSIX path. Every
frozen suite resolves its own root as `path.resolve(__dirname, '..', '..', '..')`, so a
guard judged from any other depth resolves a different tree and fails for a reason that has
nothing to do with its pin. **What it reports:** `guard files: N` on every run, at zero
too, on the `guards declared:` precedent — a count that appears only on the interesting
branch cannot be told from one that never ran — plus the names, because the exit code says
a guard is stale and not which one, and the subset's own stderr, which is the only place
the failing assertion survives at all once the whole-suite run has drowned it in the
ordinary criteria's failures. **What it does not change:** exits 0–4 keep their exact
meanings, and a guard that is absent, green, or a call made without the argument all
answer identically — otherwise the frozen suites that pinned the five-verdict table would
quietly stop meaning what they meant, and none of them can be edited.
*The writer is built* (change-log row `repo-erq`): `scripts/freeze-gate.js` writes the
receipt on exit 0 and exit 4, refuses a `--repo` that is not a git repository before it runs
anything, and fails the whole invocation at exit 2 if the receipt cannot be written — a
verdict nothing recorded is a freeze the runner would refuse anyway. The formula lives in
`runner/suite-hash.js` and the hash is taken *before* the suite is run, so a fixture that
writes beside itself cannot pin a state only the planning machine has seen. *The reader is
built too* (change-log row `repo-isq`): §4.12's third admission rule below refuses a candidate
whose suite carries no receipt, or one written for a different suite than the branch now holds,
so a freeze that is never committed is now a refusal at dispatch rather than three attempts and
a container. The coverage for both halves is re-runnable (`tests/unit/freeze-gate.test.js`,
`tests/unit/dispatch-gate.test.js`) rather than only frozen: they shipped a task apart, and the
frozen directory that gated each one never runs again.

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

**Below the panel, move 6: a red test can still be the wrong test.** The freeze gate asks
one question — do these tests fail against the fork point? — and an entire class of bad
frozen test answers it correctly. A criterion that pins a list of names, asserts an exact
count, hashes a whole build, or diffs the branch against its own fork point is red at
freeze and discriminating at freeze, and then goes red again for every later task that
legitimately grows the thing it enumerated. It does not merely go stale: one target repo
has lost at least eight frozen files across six suites this way — an eleven-name key list
broken by the task that added a twelfth, "exactly 30 flavour entries" broken by the task
that grew it to 61, and one that diffs its own branch over three source directories and
will therefore fail every code-touching task in that repository from now on. That last
shape **inverts**: it goes red precisely *because* an unrelated later task did its job
correctly, which is the opposite of what a frozen test is for.

Nothing else in this pipeline reads a suite before it freezes, and freeze time is the only
moment anyone is looking at that file with the authority to change it. So the gate gains a
second, **textual** pass over the suite it is about to bless: it names each occurrence of
those shapes with its file, its line and the question a human should answer — *is later
work licensed to change this?* — and it prints the count **even when it is zero**, on the
`guards declared:` precedent, because a discriminator that stays silent when it finds
nothing is indistinguishable from one that never ran.

**The pass cannot change the exit code, and that is the design rather than a limitation.**
The gate's exit codes are a verdict about red, green, indeterminate, unreachable and
half-proven which `PLANNING.md` step 4 branches on; overloading them would break that contract and turn a lint into a gate
on spec *authoring* — the shape hard rule 5 refuses, since the way past a gate that can
fail you is to reword until it passes. Nor can the tool decide these cases: it cannot tell
a catalogue later work will grow from an enumeration of the task's own output, and the
second is exactly what a discriminating test *should* assert. It surfaces candidates; each
finding takes a **disposition** in the planning draft the way a critic's does (step 2), so
"the lint raised four and all four were considered" is a claim anyone can check later
instead of taking on trust (change-log row `freeze-brittleness-lint`).

**Built** (change-log row `repo-uw6`) as `brittleFindings(text, file)` and
`lintSuite(dirOrFile)` inside `scripts/freeze-gate.js`, reported below the verdict for every
invocation — with or without `--spec`, and in all three verdicts. The four shape tokens are
`literal-name-list`, `literal-count`, `literal-digest` and `branch-self-diff`, and what they
key on is the half of the rule a tool can settle: **the expected side of the assertion is a
literal the author typed.** That is what keeps the pass off this repo's own frozen suites,
where six compare two digests **computed in the same run** as the house "writes nothing"
guard and `repo-1cy` runs git against a ref it created itself — a detector keyed on
`createHash` or on `git diff` fires on all seven, and would score full marks on every
"does the shape fire" test while being useless. Whatever it cannot read it **names**:
`binary`, `extension`, `unreadable`, one line per path, because a discriminator that skips
in silence is the failure mode this document already has a rule about.

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
- `regressionPolicy` (optional) — `evidence` by default; `required` makes an exact
  `regressions: pass` a host-side publication precondition. The runner reads this field
  from the fork-point commit, never from the implementation's working tree.
- `defaultBranch` (optional) — the project's integration branch. Real repositories are
  `master` as often as `main`, so the pipeline never assumes: this value wins, else the
  runner asks the remote for its HEAD, else `main`. It is what task branches fork from,
  what the freeze baseline is measured against, and what pull requests target.
- `frozenPaths` (optional) — repo paths beyond `tests/acceptance/` that the verifier's
  tamper diff must also cover (e.g. a test-runner script that `verifyCommand` invokes).
  Anything `verifyCommand` executes from the repo belongs in this list.
- `dependencies` — the declared-dependency manifest: package lists keyed by package
  manager (e.g. `{"apt": [...], "npm": [...]}`), plus an optional `binaries` list for
  tools no package manager carries — each entry declares `name`, `version`, `source`
  URL, a `sha512` the Dockerfile must verify at build time, and `installedAt` (see
  change-log row `binary-dependencies`; the first user is a pinned headless Godot).
  **No arbitrary install commands** — a `binaries` entry is still a declaration, not a
  script: download, verify, unpack to the named path is the entire permitted shape. The
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
tasks, sequenced: the host side could not run in the same batch, since the runner read the
ready queue once before the task loop — which the live queue feed has since changed
(change-log row `live-queue-feed`), though the sequencing argument stands without it. Both
halves have now shipped — the container side
as `repo-1cy`, the host side as change-log row `spec-concern-surfacing`, which the first
real concern prompted by reaching the status file and going no further.


**The channel had no readership, and a channel nobody reads reports to nobody.** Both
halves above shipped, and then the failure they exist to prevent happened anyway, one
level up. Across two consecutive runs against one target, **seven** task agents
independently diagnosed the same host-side fault — correctly, with evidence, naming each
other by issue id — and nothing consumed any of them, so the second run repeated the
first's mistake at eight times the scale and spent 3h11m recording eight `stuck`. Every
one of those concerns was surfaced exactly as specified above: in the attempt log, the
manifest, the report and the PR body, as a section of the task that raised it.

That placement is right for one concern and wrong for seven. The signal that matters is
not a concern but **the same concern arriving n times**, and that fact exists only *across*
tasks and *across* runs, where no artifact looked. So the run report gains a run-level
concern section, above the per-task list:

- an **unconditional headline** — how many concerns, raised by how many of how many tasks.
  It needs no interpretation, cannot fail, and is on its own enough: *"7 of 8 tasks raised
  a spec concern"* at the top of the first run's report is the sentence that stops the
  second run being launched. **Shipped** as `repo-uig`: `runner/report.js` prints
  `Spec concerns: <total> raised by <k> of <n> tasks` between the outcome counts and the
  first task heading, for every manifest — a clean run reads `0 raised by 0 of 6`, because
  a headline that goes silent when there is nothing to report is a headline a reader
  cannot trust when it does speak.
- **grouping by shape** within the run, and, for each group, how many prior runs against
  the same target carry that shape. Deterministic and with no LLM (hard rule 7) —
  normalise, compare token sets, group above a declared threshold, and pin that threshold
  against the real corpus rather than choosing a number that sounds right.
  *Not built yet:* the headline half deliberately reads nothing but the manifest it is
  handed, so nothing about the corpus is a declared input of the report until this half
  ships.

A concern remains **evidence and never a gate** (§3.5): a repeat is louder, not
authoritative, and no count of them may change an outcome, an exit code, a Beads
transition, or whether a branch is published. What changes is only where a human meets it.
The report also stays reproducible — the run corpus becomes one of its declared inputs and
the report names the runs it compared against, so "regeneration from the same inputs is
byte-identical" remains a checkable claim rather than a weaker one (change-log row
`concern-repeat-surfacing`).


### 3.8 Idea threads (state that outlives a session)

§3.6 gives knowledge that outlives a *task* a canonical home. A thought being worked
between sessions had none. `docs/IDEAS.md` holds a parked idea as a paragraph, and
§3.2's planning session produces a `docs/planning-draft-<date>.md` — but everything
between those two points, which is where the design work actually happens, lived in one
interactive session's context. Losing or resetting that session lost the thread, so a
session working an idea was expensive to kill and expensive to resume.

**An idea thread gets a durable identity file from its first exchange**, at
`docs/threads/<slug>.md` in the repo the thread is about. The session becomes the
disposable half: any fresh session picks the thread up by reading one file, which is
what makes many parallel working sessions cheap to run and cheap to abandon.

**Four properties of the location, each forced by something already decided.** *Tracked,
not under `runs/`*: `runs/` is git-ignored host-only run data (§4.12), and a half-thought
that does not survive a machine or a clone has not been made durable — a thread file is
intent about the machinery, the same class as `docs/IDEAS.md`. *In the repo the thread is
about*: the `docs/IDEAS.md` boundary applies unchanged — a thread about a target project
opens in that project's tree, and one opened in this repo names no target
(`scripts/test-sanitize.sh` reads the tracked tree as bytes). *Undated filename*: a date
in a filename reads as immutable and an agent will not rewrite such a file, which is why
`docs/handoff-sweep-trustworthy.md` is deliberately undated; a thread is worked and
amended until it is discharged. *Flat, no subdirectories and no index*: status lives in
the header, so the live list is a grep — a taxonomy and a hand-maintained index are both
things that go stale, which is the argument `docs/IDEAS.md` already makes about headings.

**The slug is the filename and is the change-log ref the thread will use if it is
promoted.** This is change-log row `trace-ledger`'s move applied one layer earlier —
identity assigned when the thing is created, so nothing downstream guesses an edge — and
one string then follows the thought from first exchange to shipped row.
`scripts/test-changelog.sh` already enforces that refs are kebab-case and unique across
the log, so a colliding thread slug is caught by a suite that exists. A thread may
produce several rows or none; the slug is the default ref, never a promise of one.

**Exactly one section is mutable.** The file carries a header block (slug, status, opened
date, origin, related refs), the question the thread has to answer, **Current thinking**,
Decisions, Open questions, a Log, and an Outcome. Only *Current thinking* is rewritten in
place — it is the revival payload. Decisions, the Log and the Outcome append, which is
what the change log (§12's convention, `docs/change-log.md`'s rows), the `docs/IDEAS.md`
Promoted/Dropped tables and the §3.1 attempt log all already do and is why none of them
can quietly lose a fact. **Decisions carries
the most weight**, for PLANNING.md's disposition reason: a decision silently absorbed into
prose is indistinguishable from one never made, so each is dated and marked whose call it
was — hard rule 4 splits that ownership, and which half decided a thing is the fact most
likely to be needed and least likely to survive.

**Five statuses:** `open`, `parked` (with what it waits on), `ready` (has a
decision-shaped answer waiting for a planning session), `promoted`, `dropped`.

**The promotion path does not change; a thread is state alongside it.** A
`docs/IDEAS.md` entry gains an optional `Thread:` extra beside `Blocked on:` and
`Related:`, which is the reconciliation with that file's resist-adding-structure rule —
the inbox entry stays a paragraph and the thread file carries the structure the inbox
refuses to hold. Threads are opened for entries being *worked*, never for all of them.
PLANNING.md step 0 reads `docs/threads/` for `ready` threads alongside the inbox and the
drift report. At promotion the slug is already right: the change-log row takes it (§12's
convention, appended to `docs/change-log.md`), the inbox row moves to **Promoted** citing
the thread, and the thread's status and Outcome record what it became. **A closed thread
file stays** — what stops an idea being re-raised every few months is the recorded reason,
and the reason lives in the thread rather than in a one-line table cell (the change log's
*Why* column exists for the same reason).

**Two boundaries.** A thread is **never a queue item** — `docs/IDEAS.md`'s own rule, that
an inbox which can start a container is not an inbox; threads live in `docs/`, nothing in
`runner/` or `pipeline/` reads them, and no thread file is a Beads issue. And a thread is
**not a sixth channel of unread prose** — the `docs/IDEAS.md` session-reviewer entry makes
that argument against itself and it applies here. The defence is that this adds no channel:
it is a consistent shape for prose that already exists in three inconsistent ones (handoff
documents, the permanent-value sections of planning drafts, and session context that
survives nowhere at all), and it should replace those rather than sit beside them.

**Deliberately no tooling.** No reader script ships with this. A grep over a flat
directory answers every question a reader has today, and a reader written before there
are ten threads would be guessing at what to report — the same restraint §5 applied to
the corpus audit, which was written only after the corpus had been read by hand once.

### 3.9 The batch marker (the handoff from planning to launch)

§3.2's planning session ends at `PLANNING.md` step 8 — tests frozen on the target's
integration branch, issues created with priorities and dependencies, image rebuilt, the
ready queue eyeballed. The run then starts from a **different session**, on the word "go".
Between those two moments *"this batch is ready to run"* exists nowhere but the user's
memory, and three things follow from that: the launch cannot confirm what it is launching,
a batch frozen and not launched is invisible to the next session, and step 8's
reconciliation — "`bd ready` lists exactly the tasks meant to run" — is performed once, in
a session that is then discarded.

**A planning session therefore writes a batch marker as the last act of step 8**, at
`runs/batches/<project>-<YYYY-MM-DD>.json`. It records the `run.config.<project>.json` the
batch is for, `frozenAt`, the target's integration branch and the commit the frozen tests
landed on, the issue ids with titles in the intended priority order, one line of intent in
the user's words, and who approved it (hard rule 4's split).

**`frozenAt` is an instant, not a date, and the filename's date is naming only.** A
`YYYY-MM-DD` cannot be compared with a run's `startedAt`, which is UTC: a run at
`2026-08-19T23:45Z` is 18:45 on the 19th in a US-Eastern session, so a freeze date read as
UTC midnight counts a run that happened *before* the freeze and the batch silently
disappears from `pending` — precisely the failure this exists to prevent. A marker whose
`frozenAt` will not parse is listed and labelled `freeze-time-unknown`, never dropped and
never guessed at.

**Host-only, under `runs/`** — the opposite call to §3.8's thread files, for the reason
that separates them. A marker carries a target project's name and issue ids, so the
`docs/IDEAS.md` boundary and `scripts/test-sanitize.sh` rule out the tracked tree; and a
marker is *state*, a fact about one host's queue at one moment, where a thread is *intent*
about the machinery. A thread that does not survive a clone has failed; a marker that does
not is merely spent. The reader is already there too — the launching session reads `runs/`
and never otherwise opens a target's working copy.

**The marker is immutable, and "still pending" is a join rather than a field.** There is
no `launched` flag to stamp. A batch is pending when **none** of its issue ids has been
worked since `frozenAt`, computed at the moment the question is asked from records the
corpus writes for other reasons — `scripts/verdict.js pending`'s move exactly, and it
inherits that design's best property: nothing to forget to update. It also keeps the
launching session **read-only on shared state**, which is what makes that session
disposable. *Any* id having run answers the question `pending` asks — did this batch ever
get launched — so a half-drained batch leaves the list, and `show`'s per-id breakdown is
what keeps it visible rather than binary.

**`scripts/batch.js` is the reader** — `show` for the confirmation at launch ("batch of 4,
frozen 2026-08-19, one blocked — go?"), `pending` for un-launched batches, newest first.
With no argument `show` names the newest marker by `frozenAt`, **launched or not**: newest
and newest-*pending* diverge the moment a batch runs, and a default that skipped a launched
batch would hide a double-launch, which is the thing worth seeing most. Same contract as
§5's other readers: deterministic scaffolding with no LLM anywhere (hard rule 7), evidence
that edits no existing artifact and exits 0 on findings, `BATCH_RUNS_DIR` re-aiming the
root so the suite can drive the real CLI.

**The reconciliation against the live queue is the point, not the confirmation.** The
marker says four issues; `bd ready` in the target says five are runnable and one of the
four is blocked. That mismatch is invisible everywhere else — the runner has no picker of
its own (§4.12), so a stray unblocked issue simply runs — and it is the check step 8 used
to do by eye and then throw away. This is the one part that needs `bd` on the host, which
`scripts/verdict.js` deliberately does not, so it is bounded rather than absorbed: reading
the marker and computing `pending` stay node built-ins only and spawn nothing, the `bd`
call goes through the existing `PIPELINE_BD_CMD` seam, it **reads and never writes** (hard
rule 1), and where `bd` is absent the output says the batch is unreconciled instead of
quietly printing the marker as if it agreed with the queue — §5's degraded vocabulary, for
§3.6's reason that the dangerous failure writes something plausible and wrong.

**The reconciliation joins three sources, not two.** `run.json` records `targetRepo` as a
git *remote URL* and never the config name (§4.11), so nothing joins a marker to the queue
without reading the `run.config.<project>.json` the marker names — a git-ignored file — for
its `targetRepoPath`. `show` therefore reads marker, run config and queue, and carries a
degraded term for the middle link as well as the last: a marker naming a config absent from
this host is reported as exactly that, never silently unreconciled for the wrong reason.

**Three boundaries.** A marker is **never a queue item** — `docs/IDEAS.md`'s rule that an
inbox which can start a container is not an inbox, applied here because the runner drains
its queue unattended; nothing in `runner/` or `pipeline/` reads `runs/batches/`. It is
**never a gate**: a missing marker does not stop a launch and a disagreeing one does not
refuse it (hard rule 5's shape, `verdict.js`'s contract). And it is **never the source of
truth for what runs** — Beads is. The marker records what was intended, the queue decides
what happens, and when they disagree that *is* the finding.

**Both halves are built** (change-log rows `repo-0b3` and `repo-8v0`). `scripts/batch.js`
reads the marker shape above, and `pending` computes the join against the run corpus —
`node scripts/batch.js pending` for un-launched batches newest freeze first,
`node scripts/batch.js show [<project>-<YYYY-MM-DD>]` for one marker with a per-id
worked/not-worked breakdown, `BATCH_RUNS_DIR` re-aiming the root. `show` also reconciles
against the live queue, and that half is bounded rather than absorbed in the literal sense:
`pending` still spawns nothing at all, and `show` spawns exactly once — the marker's run
config resolved from `BATCH_CONFIG_DIR` (else this repo's root, never the working directory)
by plain JSON parse for `targetRepoPath` alone, then one `-C <targetRepoPath> ready --json`
through the existing `PIPELINE_BD_CMD` seam, killed at `bdTimeoutMs`, with no write verb in
the vector. Each of the batch's ids is reported `ready` or `not-ready` and every entry the
queue offers that the batch never named is a `stray` — after the runner's own `EXCLUDED_TYPES`
filter, **imported from `runner/queue.js` rather than copied**, since the whole value of the
report is that it predicts what the runner will drain and two copies of that rule would
drift. Where a link of the three-source join fails, `unreconciled` is printed with exactly
one reason — `run-config-absent`, `bd-unavailable` or `bd-unreadable` — and no queue state at
all, which is the half of the contract that keeps the other half honest: a reader that always
said `unreconciled` would satisfy every degraded case, and one that never noticed a dead `bd`
would satisfy every reconciled one. Two distinctions inside that vocabulary are deliberate. A
call killed at the bound is `bd-unreadable`, not `bd-unavailable`: `bd` was there and did not
answer, which is a different thing to go and look at. And the capture ceiling is raised past
what a real queue prints and tested for **before** the bound, because an overflow and a
timeout kill the child identically — same null status, same signal — and a reader that
checked the bound first would report a query that answered at once as one that never
answered. Two derivations from the marker half are worth repeating because the cheap answer
is wrong in both. A run's clock is `startedAt` from `run.json` **when there is one**, else
the leading instant on the first line of `run.log` — 74 of the reference host's 272 run
directories have no manifest, so `verdict.js`'s rule of skipping such a directory (correct
for its own purpose) would report an interrupted run's batch as never launched. And a run
datable by neither counts as **having worked** the ids it names, labelled `run-time-unknown`:
a false "pending" invites a double launch, where a false "launched" only sends someone to
look.

## 4. The Implementation Phase (the execution layer)

Carried over from v3, amended over two critic-review rounds; this section is the
architectural source of truth. Stable enumerable runtime policy is owned by
`contracts/control-plane.json`, persisted artifact shapes by `schemas/*.schema.json`, and
project-specific verification policy by the target's `pipeline.config.json`. Runtime
modules consume those machine-readable sources. Prose here explains decisions and
algorithms; it is not a second live copy of their values (change-log row `repo-tg8-10`).

1. **One orchestrator, on the host, outside every container.** A deterministic runner
   script — not an LLM. It enforces timeouts and kill switches; the enforcer cannot live
   inside the thing it may need to kill. **That includes the tools the runner itself
   shells out to:** every runner `bd` call is bounded by the contract's `bdTimeoutMs`
   inside `runner/bd.js`, because `bd` has been observed printing its complete
   output and then never exiting, and two calls over one embedded Dolt database blocking
   on each other indefinitely. A call that exceeds the bound is killed and returns the
   ordinary non-zero status its caller already handles, with an error naming the bound
   that fired — never a silent empty result, which would be the quiet degradation the
   bound exists to prevent. The same mandate covers **every runner Git call**:
   `gitTimeoutMs`, default 60000. Docker probes, network scripts, GitHub CLI publication,
   host-shell calls and the rate-limit probe use `lifecycleTimeoutMs`, default 120000.
   Both produce the same timeout contract: status 124, `timedOut: true`, and a diagnostic
   naming the command, duration and config key. `git fetch` against an unreachable host
   parks indefinitely in exactly the way an unbounded `bd` once parked whole runs; a
   timeout must therefore be a named failure, never an empty answer or policy fallback.
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
   network, a disposable filesystem, and no git credentials) in a fixed sequence driven by the
   entrypoint script: **code → verify → (retry, up to the attempt cap — default 3) →
   implementation commit → docs-only agent → final verify → docs commit**.
   The agent command is read from the `PIPELINE_AGENT_CMD` environment variable,
   defaulting to the headless `claude -p` invocation when unset — this is the deliberate
   test seam that lets the E2E pass substitute deterministic stubs (see section 7). The docs phase is one agent invocation
   that writes the change summary into the status file and updates in-repo docs the change
   affects. Its writable Git delta is limited by deterministic scaffolding to regular
   root-level Markdown files and regular Markdown files beneath `docs/`; a symlink, source,
   config, test or other path rejects the whole docs delta. An allowed delta is judged by a
   second invocation of the same authoritative verifier before scaffolding authors the docs
   commit. If the docs agent errors, crosses the path boundary, fails final verification or
   cannot be committed, its entire delta is reset to the verified implementation commit and
   success stands with `docsPhaseError` as evidence (change-log row `final-verification-boundary`). Phases of
   a task are scaffolding, not an LLM decision. No leader agent inside. **Agent output is a contract artifact, so it is
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
   **That same `modelUsage` table is also the per-task cost record.** Every agent
   invocation of a task — each code attempt and the docs call — contributes its per-model
   token counts (`inputTokens`, `outputTokens`, `cacheReadInputTokens`,
   `cacheCreationInputTokens`) to a `modelTokens` object in the status file, accumulated
   additively across invocations and across a rate-limit relaunch, keys written in sorted
   order so two identical runs produce identical bytes. Extraction is the same structural
   envelope read and happens **before** the log is flattened, since flattening overwrites
   the envelope with its plain result and is what the collected artifact keeps. The
   record is **tokens only**: `costUSD` is not kept, because those are list-price figures
   and a container authenticates with a subscription token, so a dollar column would be
   confidently wrong in the one direction nobody checks — and the scarce resource here is
   the usage window, which tokens measure and dollars do not. It is a **floor, not a
   total**: a rate-limited invocation exits 20 before its envelope is read, so the tokens
   that attempt spent are lost, accepted rather than fixed because the alternative is
   parsing a log that may be truncated mid-envelope, which trades a known under-count for
   an unknown wrong number. Like the model write it is **non-fatal** — a task that cannot
   report its cost has an unknown cost, not a failed outcome — and like `phase` it is
   **never an outcome**: nothing in the runner, the verifier or the report branches on
   it, and it is deliberately outside the report's scrutiny ordering.
4. **The verifier is scaffolding, not an agent.** Mounted read-only (a container-side test
   asserts it cannot be written), it receives the issue id via the `ISSUE_ID` environment
   variable and executes `<verifyCommand> tests/acceptance/<issue-id>/`; its pass/fail is
   authoritative — "the agent says it's done" counts for nothing. It reads
   `pipeline.config.json` **from the fork-point commit, never from the working tree** —
   otherwise the coding agent could simply edit `verifyCommand` — and before every check
   it `git diff`s **all of `tests/acceptance/` plus the config's `frozenPaths`** (every
   frozen test and frozen helper, not just this issue's directory — during a run none of
   them may change, and untracked additions count) against the fork point (3.1); any
   difference is the dedicated "tampered" outcome. When `regressionCommand` is present
   it runs that too. Under the default `regressionPolicy: evidence`, acceptance decides
   the verifier exit code and a passing task with failing regressions is reported as
   "partial," never "done." A project may set `regressionPolicy: required`; the verifier
   still records the same evidence and exit code, but the host refuses publication unless
   `regressions` is exactly `pass` (fail, absent, error or missing all retain the workspace
   and leave Beads in progress). Both fields are read from the fork-point config, so the
   implementation cannot weaken the gate it is running under. The verifier writes
   machine-readable results to
   `/workspace/.run/verify.json` — schema `verify.schema.json`, checked into this repo,
   owned by the verifier task and cited as a frozen input by the runner and report tasks
   (mirroring `status.schema.json`) — and its output is fed into the next coding attempt
   as feedback. The host validates both artifacts at collection time with those checked-in
   schemas and requires their `issueId` to match the claimed task. Invalid raw bytes are
   still copied into the run directory for diagnosis but are never exposed as structured
   values to publication, memory, reporting or the pause scheduler. Exit 0 is only a success
   *claim*: missing, malformed, schema-invalid or cross-task artifacts, or a verification
   artifact whose acceptance verdict is not exactly `pass`, are deterministically relabelled
   `failed` before the outcome contract can close an issue or open a PR. Nonzero execution
   outcomes retain their existing meaning; malformed diagnostic evidence cannot turn stuck,
   tampered, paused or failed into another class (change-log row
   `runtime-artifact-schema-gate`).
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
   Immediately before every push, the credentialed host scans **every Git object introduced
   since the immutable fork point**: commits, trees and blobs, including objects that are no
   longer reachable from the branch tip's file tree. It rejects the exact subscription
   token injected into the container plus high-confidence private-key and provider-token
   shapes. Scanning only `HEAD` would miss a credential committed and deleted later while
   still publishing its historical blob; scanning raw trees also covers tracked filenames.
   A finding reports only its kind, object type and abbreviated object id — never the
   matching bytes — and is a recoverable publication failure: no push, no terminal Beads
   transition, retained workspace. Enumeration, parsing, timeout and size-limit failures
   fail closed (change-log row `credential-disclosure-publication-gate`).
   **Publication, terminal task tracking, and cleanup are one ordered settlement**
   (change-log row `transactional-task-completion`): first the branch push and required PR
   must succeed, then every Beads note and the terminal `close` / `blocked` transition must
   succeed, and only then may the runner discard the host workspace. A publication failure
   never attempts a terminal Beads transition. A Beads failure may follow an already-durable
   branch or PR, but it leaves the issue in progress and keeps the workspace. Either failure
   is a named manifest/report error with `recoveryWorkspace`, and `task.finished` records
   `beads: null`; `pushed: false` therefore never collapses "push rejected" into the valid
   "no commits" no-op. A required regression verdict is checked at the start of this
   settlement, before even a no-commit result is accepted: an unavailable mandatory
   discriminator can never close the issue or publish a branch.
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
   regeneration-idempotent, never hand-edited. Run-level, above the per-task list: the
   outcome counts, and an **unconditional spec-concern headline** — how many concerns,
   raised by how many of how many tasks — printed for every run including one that raised
   none, and evidence only, exactly as 3.7 requires (change-log row `repo-uig`). Per task:
   report status (see the 4.11 contract), branch, what changed,
   verification evidence, attempt notes. Ordered by scrutiny needed:
   **tampered > stuck > partial > failed > done-with-retries > done-first-try**, ties
   broken by attempt count then diff size. Within the partial band, a partial whose
   failing regressions are all the frozen suites of sibling issues in the same run is
   labelled **sibling-batch** and sorts after every genuine partial — the classification
   is a deterministic join between the recorded regression evidence and the run's own
   task list, made by the report generator and nothing upstream of it. The verifier
   never treats any regression failure as expected, sibling or not (change-log row
   `batch-sibling-partials`). "Paused" appears in a final report only if the
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
    Each write result is checked. Notes precede the terminal transition and the first failed
    note stops it; a failed `close` / `update` is a recoverable settlement failure, not a
    successful task completion that happens to have noisy logs (change-log row
    `transactional-task-completion`).
11. **The outcome taxonomy — one machine-readable contract consumed by every component.**
    `contracts/control-plane.json` owns the exit-code-to-task/Beads mapping, the
    regression-failure refinement, the complete task-status vocabulary, and which
    outcomes may open a PR. `runner/queue.js`, `runner/publish.js`, and the other consumers
    import it through `runner/control-plane.js`; `schemas/run.schema.json` is checked
    against it by the mandatory contract suite. The semantics below explain those values
    without maintaining another executable-looking table.

    The outcome mapping describes execution outcomes after a **successful settlement**. Publication
    or Beads failure does not invent a new verifier outcome: the manifest keeps the original
    `done`, `partial`, `stuck`, `tampered`, `failed`, or `paused` judgment, adds `error` and
    `recoveryWorkspace`, leaves the issue in progress, and retains that workspace. This is
    the compensating boundary between two durable systems; it does not pretend a Git remote
    and a local Dolt database can share an atomic commit.

    Under `regressionPolicy: required`, only an exact regression `pass` is
    settlement-eligible. An acceptance pass with fail, absent, error or missing regression
    evidence keeps its `partial` or `done` execution judgment for diagnosis, but publication
    is refused, Beads remains in progress, and the recovery workspace is retained.

    **The last column is decided after the outcome, never with it** (change-log row
    `failure-class-design`). A `failureClass` is written onto every manifest row whose outcome
    is not `done` — required there, forbidden on a `done` row — by a pure host-side module
    (`runner/failure-class.js`) reading artifacts already in hand: the refusal kind, the
    verifier's own `error` verdict, the exit code, and the last two attempts' failing check
    names as `scripts/sweep-assertions.js` extracts them. `identical-failures` means the final
    attempt failed the same set of checks as the one before it; it is **recorded only** and
    changes no outcome, no exit code and no attempt (hard rule 5). An input the rules cannot
    place is `unclassified`, never a guess. The report prints the class beside the outcome
    label; the audit tables that count by class are a later task.

    The runner distinguishes done from partial by reading `verify.json`. The runner sets
    an issue in-progress when its task starts; **blocked** is what takes failed work out
    of the ready queue (it needs a human decision in review — fix the spec, fix the doc,
    or drop it), so the run loop can never re-pick a failed issue. **`undispatchable` is the one row that touches Beads not at all**: the issue is refused before `claim()`, so it is never in-progress, never blocked, and the next run picks it up unchanged the moment its suite is pushed (see 12). Timeout kills treat
    the status file as best-effort (it may be half-written). Alongside the codes, the
    entrypoint maintains `/workspace/.run/status.json` — attempt summaries (number,
    verifier result, timestamp), the docs-phase change summary, the resolved model id
    (4.3), the rate-limit reset time when known, the phase boundary last reached
    (`phase`, one of `code` / `verify` / `docs`, written on *entry* to each phase so a
    live reader sees the phase a task is in rather than the one it finished — optional
    and additive, absent on runs produced before it shipped and on a task killed before
    its first boundary; evidence for a watcher (5), never an outcome, and nothing in the
    pipeline branches on it), the per-task cost record (`modelTokens`, 4.3 — per-model
    token counts summed over every agent invocation of the task, optional and additive,
    absent whenever no envelope reported one; evidence for the report and the run-history
    audit, never an outcome, and carried onto the manifest task row verbatim beside
    `model`), any proposed memory notes
    (`memoryNotes`, 3.6), and any spec concerns the agent raised (`specConcerns`, 3.7 —
    evidence only, like `advisories`). The summary and the model id are the two artifacts the host
    reuses verbatim (PR body, manifest, report), so both are extracted deterministically
    by scaffolding — 4.3's envelope rule — and never by an LLM re-reading agent prose. Its schema is `status.schema.json`, checked into this repo, owned by the
    entrypoint task and cited as a frozen input by the runner and report tasks.
12. **Runner configuration, lifecycle ownership, and logs.** The runner reads
    `run.config.json` in this repo: target repo path and remote, image name, wall-clock
    default, the attempt cap (`maxAttempts`, default 3 — see 4.6), probe interval,
    the bound on every runner `bd` call (`bdTimeoutMs`, default 60000 — see 4.1;
    validated, like the other numeric tunables, as a positive whole number), the bound on
    every runner Git call (`gitTimeoutMs`, default 60000), the bound on short Docker,
    GitHub and host-shell lifecycle calls (`lifecycleTimeoutMs`, default 120000; both
    validated identically), network/proxy identifiers, an optional `agentCommand` override (passed
    into containers as `PIPELINE_AGENT_CMD` — how the E2E pass injects its stubs), and an
    optional `hostShell`. When `hostShell` is absent, startup resolves and verifies one;
    when it is present, startup verifies that exact command rather than silently falling
    back. **The network and proxy names are per project and have no shared
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
    So the runner takes a **host-global** lock on its target repo, under a per-user directory
    outside any pipeline checkout, and a second run against the same repo is refused even
    when it started from another checkout. A matching observer mirror remains under that
    checkout's `runs/locks/` for the dashboard and sweep readers, but exclusion rests only
    on the global authority. The refusal names both the project and the run that holds it,
    and exits non-zero. The
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
    is the courtesy. A clean end removes the authority only when every claim settled. An
    unfinished claim leaves a released ownership record for the next run to take over.

    **The Beads checkout and publication remote are one project, proven before either is
    touched.** `targetRepoPath` is the database side of the runner while
    `targetRepoRemote` is the dispatch, clone, push and PR side. Preflight enumerates every
    fetch remote of the local checkout and compares its credential-free canonical repository
    identity with the configured remote, after Git has expanded `url.*.insteadOf` aliases.
    Equivalent spellings collapse: an absolute path and `file://` URL match, as do GitHub
    HTTPS and SSH locators. A mismatch, a non-repository path or a checkout with no fetch
    remote aborts immediately after locking and before the host-shell probe, Docker,
    networking, Beads recovery/queue reads or workspace creation. The refusal names both
    config sides and the boundary it protected. Comparing only branch contents is not an
    identity proof: two unrelated repositories can share a commit, especially an initial
    scaffold, and then diverge after the runner has already closed the wrong issue.

    **Claims and recovery use the same ownership proof.** Dispatch uses Beads' atomic
    `bd update --claim`, never a status assignment. The claim transaction also sets a unique
    per-run actor plus `pipeline_owner_token` and `pipeline_run_id` metadata, and only after
    it succeeds does the lock's claim list gain the issue id. Takeover carries dead-run
    tokens forward. Recovery may scan in-progress rows, but it reopens one only when status,
    actor and both metadata fields still exactly match a token from a proven-dead owner; the
    reset clears assignee and metadata in the same Beads update. Human work, a later run's
    work and legacy unproven rows are therefore immutable. Failed recovery retains the token
    for the next run instead of widening the reset. Terminal settlement likewise writes the
    final status while clearing assignee and both metadata keys in one transaction; otherwise
    reopening that finished row leaves the old runner actor behind and atomic `--claim`
    correctly refuses every later run.

    **One run, N tasks at once — the bounded worker pool (§7's `concurrency` knob).**
    `concurrency` in `run.config.json` says how many task containers **one** runner process
    holds at a time. Default **1**, which is the sequential loop this pipeline shipped with,
    byte for byte in behaviour; validated like the other numeric tunables (whole number, in
    the field-naming error shape). It shipped capped at a literal **3**, because §7 stated only
    a hedged range and a batch is bounded by its slowest task, not by how many it holds — depth
    4 buys progressively less while multiplying the load on one subscription window; the cap
    was lifted by change-log row `concurrency-uncapped` (any whole number ≥ 1 loads, the
    run-level park of 4.7 is the guard at every depth, and the trade is the operator's). It is
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
    - **Short host calls remain synchronous but are bounded.** Clone, branch inspection,
      push, GitHub publication, Docker probes and shell lifecycle calls all terminate under
      the configured Git/lifecycle deadlines, so they may briefly serialise orchestration
      but cannot park every worker indefinitely. Active container deadlines do **not** share
      that event loop: one worker thread per container owns its clock and bounded `docker
      kill`, so another worker's synchronous clone or Beads write cannot make a task run
      past its active budget (change-log row `bounded-lifecycle-and-independent-deadlines`).
      `bd()` stays synchronous because its serialization is a guarantee (4.10), and keeps
      its separate `bdTimeoutMs`.
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

    **The sweep and a live run are mutually exclusive, and the sweep reclaims every kind
    of thing a suite it killed can leak** (change-log row `sweep-trustworthy`; declared at
    planning time, the implementing tasks add their own rows). The reclaimer's snapshot
    diff genuinely cannot distinguish "this appeared because my suite made it" from "it
    appeared because a live run in another terminal made it" — that is missing
    information, not a classification bug — so the guarantee comes from exclusivity:
    `scripts/test-all.sh` refuses to start while any `runs/locks/*.lock` has a live holder
    (the liveness rule above, exported from `runner/lock.js` and never re-implemented),
    and the runner refuses symmetrically while a sweep lock with a live holder exists — a
    gate that joins, and never displaces, the run lock as the first gate. The sweep's lock
    stays a distinct thing rather than reusing the per-target run lock (legal under
    dogfooding, and rejected deliberately): a target-keyed lock excludes only runs against
    this repo, and the 2026-08-01 incident's sweep and run shared no target — the answer
    that looks right and is wrong. It also stays out of `runs/locks/`, which the dashboard
    reads as its project registry. Three smaller decisions travel with this one. The
    per-suite kill default drops 900s to 300s: the slowest green suite in the corpus is
    1:30, the 2026-08-05 sweeps spent 94 and 52 minutes waiting on suites that were never
    going to finish, `--timeout` still overrides, and the sweep already names the cap in
    its own output, so a legitimately-slow future suite fails self-describingly. The sweep
    reclaims stale run locks left behind by a suite it killed — the same before/after
    ownership rule as containers, **and** the holder must be provably gone by the exported
    liveness check, with both `repo-zje` rules travelling unchanged (no baseline, no
    removal; cleanup is never a verdict). And any reclamation of a container matching the
    anchored `task-` prefix is loud — stderr, never suppressed by quiet mode — because by
    construction such a container is either a real leak worth knowing about or someone's
    live work being destroyed, and neither is a thing to log quietly.

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

    **The host shell is an identity, not a PATH spelling.** On Windows, the first `bash`
    found by the operating system may be the WSL launcher, even though the runner's host
    tools and paths belong to Windows. Startup therefore accepts only a Git Bash-compatible
    shell that can invoke the runner's exact host Node executable. An explicit `hostShell`
    is checked first; otherwise the resolver checks standard Git for Windows locations and
    then PATH candidates, rejecting WSL and shells that cannot run host Node. This happens
    before Docker, network setup, or Beads recovery. Success is retained in the loaded
    configuration and reused for task, probe, pause, and publication subprocesses; failure
    releases the project lock and reports the `hostShell`/Git for Windows remedy without
    launching work. Linux retains the portable `bash` default but must pass the same Node
    capability probe (change-log row `verified-host-shell`).

    **Lifecycle failure has one compensating path.** Any attempted network startup owns a
    bounded teardown before preflight releases its lock, including a script that creates
    half the plumbing and then fails. After successful preflight, the complete queue/report
    body runs inside `try/finally`: `network down` is attempted first and lock release lives
    in its own nested `finally`, so an unexpected exception—or even a teardown exception—
    cannot strand the project lock. A teardown timeout is logged and makes the run nonzero;
    it is never followed by a false `run.finished` event (change-log row
    `bounded-lifecycle-and-independent-deadlines`).

    **The runner owns the rest of the run lifecycle end to end:** at run start it creates
    the internal network and proxy sidecar, invokes the pre-run egress check (aborting on
    failure), and resets only issues whose actor and metadata still prove ownership by a
    dead runner back to open with an attempt-log note; at run end it tears the network
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

    **A task whose frozen suite is not on the fork branch is never dispatched**
    (change-log row `dispatch-gate`). The type filter above was the ready queue's *only*
    admission rule, so the run's answer to "should this go out?" was "`bd ready` returned it
    and it is not an epic" — and `bd ready` cannot know more, because Beads tracks issues and
    not freezes. Any open, unblocked issue is ready to it, which is correct behaviour for
    Beads and the wrong input to trust alone. The gap it leaves is total: the verifier's first
    act is `<verifyCommand> tests/acceptance/<issue-id>/`, which against a missing directory
    prints `FAIL: test dir not found` and exits 1 **before any of the agent's work is
    consulted**, three times, once per attempt. Nothing in the container's diff can change
    that outcome, and the one move that looks like a rescue is strictly worse: 4.4's frozen
    set is `tests/acceptance/` plus `frozenPaths`, diffed against the fork point *and* read
    from the `??` lines of `git status --porcelain`, so an agent that writes the missing suite
    is recorded `tampered`. There is no play available to a task agent, which is by design —
    a frozen test an agent can author is not frozen. The tamper check is correct and stays.
    The dispatch is what was wrong. Two consecutive runs against one target dispatched
    fourteen tasks of which eight could never have passed, the second spending 3h11m to
    record eight `stuck` and nothing else. The repo already had the *concept* —
    `scripts/freeze-gate.js` proves a suite present and red at the fork point — and no file
    under `runner/` referenced it.

    So `readyQueue()` gains a **third population beside `skipped`** — keyed
    `undispatchable`, the outcome's own word, never `refused`, which `runner/run.js` already
    spends on the run-level rate-limit population. One `git fetch <targetRepoRemote>
    <branch>` per run into a throwaway repository, then one `git ls-tree -d --name-only
    FETCH_HEAD -- tests/acceptance/<issue-id>` per candidate: empty output, not
    dispatchable. Five properties are load-bearing, and each names a way of getting it wrong
    that was genuinely available:

    - **The gate fetches the remote by URL and reads `FETCH_HEAD` — never `origin/…`, never
      the working tree, never a local branch.** Five of the seven observed failures had their
      suite present *locally*: in a commit nobody pushed, or untracked in someone's working
      copy. A check against the checkout passes all five and changes nothing at all.
      **Freezing locally is not freezing** — that sentence is the whole lesson and the check
      has to encode it. Going by URL rather than by remote name keeps this gate aligned with
      the containers, which fork from a clone of that URL (2). The separate preflight
      repository-identity gate binds that publication side to `targetRepoPath`, where Beads
      lives; without it a working copy whose origin points elsewhere would still let the
      runner close issues in one project while publishing another. One fetch per run, then one
      `git ls-tree -d --name-only FETCH_HEAD -- tests/acceptance/<issue-id>` per candidate.
      The `-d` is not leniency to be tidied away later: a suite committed as a single *file*
      answers empty and is refused, which matches the verifier, whose `<verifyCommand>
      tests/acceptance/<issue-id>/` would fail on a file too.
    - **Which branch to fetch is resolved without a literal fallback, and failing to resolve
      it aborts.** `pipeline.config.json`'s `defaultBranch` in the target working copy wins;
      otherwise the remote is asked directly (`git ls-remote --symref <targetRepoRemote>
      HEAD`); and if neither answers, or the resolved branch does not exist on the remote,
      the run aborts. This deliberately does **not** reuse
      `runner/workspace.js`'s `detectDefaultBranch`, whose chain ends at the literal `'main'`
      — correct there, because it only ever runs against a fresh clone where `origin/HEAD` is
      always set, and catastrophic here, where guessing `main` for a `master` project makes
      `ls-tree` empty for *every* issue and refuses the whole queue with a confident wrong
      reason. Different input, different last resort, stated rather than inherited.
    - **A fetch that fails, or hangs, aborts the run and names the remote and the branch.**
      The discriminator is unavailable and dispatching blind is the failure being fixed:
      3.2's rule that an unavailable discriminator must announce itself rather than quietly
      weaken the verdict, applied at dispatch instead of at freeze. It forfeits nothing,
      since every task clones from that same remote seconds later and a run that cannot reach
      it has no work it could have done. **Bounded like every other thing the runner shells
      out to** (1): a `gitTimeoutMs`, default 60000, validated as a positive whole number
      like the other numeric tunables — `git fetch` against an unreachable host parks
      indefinitely in exactly the way an unbounded `bd` once parked whole runs. And the abort
      travels in its **own** channel: `run.js` today logs a failed `readyQueue` as "cannot
      read the Beads ready queue", and a fetch failure reported under that cause sends a
      person to the wrong system.
    - **The refusal is per issue and never per run.** A queue holding three frozen tasks and
      one unfrozen one runs the three. That blast radius is why the check lives in
      `queue.js` and not in `preflight()`, which gates the *environment* and is rightly
      all-or-nothing.
    - **It runs before `claim()`, so Beads is untouched.** A refused issue stays `open` with
      no note, no status change and no attempt-log line — the same property the run-level
      rate-limit refusal already has (7). It is not blocked and not failed; it is merely not
      frozen yet, and a freeze session has to be able to pick it straight up. A per-run note
      would also accumulate on an issue that legitimately sits unfrozen for weeks.
    - **It is named in the queue-summary line, with the remedy.** A skip nobody can see is
      the silent-failure family this design keeps paying for, and this one is worse than most
      because the tasks *did* appear in the report — as three-attempt failures indexed under
      the agent's name rather than under the missing freeze. The historic
      `ready queue: N task(s) — …` prefix is **appended to and never rewoven**;
      `scripts/test-runner-queue.sh` greps it at six sites.

    - **It repeals a shipped property, and the repeal is deliberate.** Until now an
      unreachable `targetRepoRemote` was a *task* failure: the clone failed inside
      `prepare()`, the task was reported and the run carried on at exit 0 — asserted as such
      by `scripts/test-runner-workspace.sh`'s clone-failure check. The gate reaches that same
      remote first, so an unreachable remote now aborts the run before anything is claimed.
      That is the better report — every task would have failed at clone seconds later, and
      eight task-level clone failures are a worse artifact than one abort naming the remote —
      but it changes a tested behaviour, so the check is rewritten to assert the new one
      rather than quietly deleted. A tested property that stops being true and takes its own
      test with it is indistinguishable from one that was never tested.

    Two smaller rules keep the gate from failing in the two ways a gate fails. It is **lazy**:
    a queue with no candidates left after the type filter is fetched for nothing and must not
    abort, or a legitimately empty run becomes an exit-1 failure. And the fetch runs in a
    **throwaway repository under the OS temp dir, never in `targetRepoPath`** — `FETCH_HEAD`
    is per-repository state, and writing it into the working copy an operator is using is the
    kind of side effect §5's readers are forbidden from having.

    A refused task **is a manifest row and not a hole.** It never enters `drainQueue` at
    all, so unlike the rate-limit refusal there is no row for `main()`'s `.filter(Boolean)`
    to preserve — the rows are **manufactured** from the third population and concatenated
    into the results before the manifest is written, which is the only place that information
    still exists. The distinction matters because the failure it prevents is the same one
    either way: after exactly the unattended run where nobody watched it happen, a refused
    task that produced no row is indistinguishable from a task nobody queued. The
    construction is a **pure exported function** rather than inline code in `main()`, on the
    precedent `queueSummary` set in the same file and for the same reason — `main()` sits
    behind the token load and the Docker preflight, so anything written there is unreachable
    to every Docker-free test, and a gate that refuses correctly while manufacturing nothing
    would pass a suite that never looked. For the same reason the drain's own closing line
    must name the refusals rather than reading `queue drained: (nothing ran)`, which is true
    and reads like an empty queue. The row carries 4.11's new `undispatchable` outcome and
    enough beside it to be worth reading — the title, and an attempt-log note carrying the
    remedy — because the report renders a row's body from those fields and a minimal row
    produces a section that says "no change summary produced" and tells the reader nothing to
    do, which is the outcome this whole amendment exists to prevent. `undispatchable` ranks
    second in scrutiny order behind `tampered` — a batch that could not run is the first
    thing a person opening the report needs to see — maps to no Beads status at all, and gets
    a label of its own, since the report's fallback prints the bare outcome word. Its rank is
    **fractional, inserted rather than renumbered**: `scrutinyKey`'s fallback for an unknown
    outcome is the literal rank `failed` holds, so renumbering silently re-homes every future
    unknown outcome, and that fallback is not this amendment's to move.

    One consequence is recorded here rather than left to be discovered. `scripts/batch.js
    show` reconciles a batch marker against the live queue and **imports** the type filter
    from `runner/queue.js` rather than copying it, precisely so that its answer tracks the
    runner's admission rules (3.9). This amendment adds a second admission rule and does not
    teach it to the reader, so from the moment it ships an id can read `ready` in the launch
    confirmation and then never dispatch — the false confidence that reader exists to remove,
    arriving through the reader itself. Closing it is a follow-up task sequenced immediately
    after this one and depending on it, not an inbox note; the shape is the same move again,
    importing the check rather than keeping a second copy.

    **A frozen suite without a matching receipt is never dispatched either — the
    third admission rule** (change-log rows `receipt-design`, `repo-isq`). *Built* — the
    receipt is written (§3.2, change-log row `repo-erq`) and `runner/queue.js` now reads it.
    The second rule proves a suite is *present*; this one proves it was *gated*. Before
    claiming, the runner reads
    `tests/acceptance/<issue-id>/.freeze-gate.json` from the fetched integration branch and
    recomputes the suite's hash from that branch's blobs with the same `runner/suite-hash.js`
    the gate used. Four refusals, each with a distinct reason and a `refusal` kind on the
    manifest row: `no-suite` (as before), `no-receipt` (a suite the gate never blessed — or a
    receipt that is unparseable, of an unknown version, or of an unknown verdict),
    `receipt-mismatch` (the suite changed after the gate passed), and `half-proven` (red
    without a probe, refused unless the run config sets `allowHalfProven: true`, whose
    effective value the manifest records). Check order per candidate is suite → receipt →
    hash → verdict; the first refusal wins. The kind travels into the feed's live refusal
    map and into the report's heading, body and remedy, which are keyed by it. Every git
    call this adds is bounded like the fetch already is. Beads is never written: a refused
    issue stays `open` with the remedy named. The decision that `half-proven` does not
    dispatch by default was the user's (2026-08-27): the probe is what catches a fixture no
    implementation can satisfy, and that class was seven of the twelve. Three things the
    build settled that the design above left open. The set of receipt versions the reader
    accepts is the *runner's own* and not an import of the gate's `RECEIPT_VERSION`: a writer
    writes one version, a reader accepts every version it can still interpret, so the two are
    different facts with one element in common today, and the unit suite pins the overlap
    rather than a shared constant hiding it. A receipt whose `suiteHash` is not a digest at
    all is `no-receipt`, not `receipt-mismatch` — junk compares unequal to everything, and the
    lazy reading would send a person to re-gate a suite whose real problem is the file beside
    it. And the queue-summary log line's `NOT DISPATCHABLE` clause is deliberately *unchanged*:
    naming the kind there belongs to the follow-up that teaches `scripts/batch.js show` this
    rule, because two consecutive tasks rewriting one string is how the same six grep sites
    move twice.

    **The run's process exit codes, in one place** (change-log row `refused-exit-design`).
    *Built* (change-log row `freeze-command`).
    Before this row they were scattered: 1 for an unreadable queue or a failed preflight, 2
    for a bad config or a missing token, 0 for everything else — including a run that read
    eight ready issues and dispatched none, which no script could tell from a run with
    nothing to do. Now: **4** when the ready queue was non-empty and nothing was dispatched,
    decided by a pure function of the dispatched and refused counts after the drain and
    recorded in the manifest as `queue: {ready, dispatched, refused}`; 0 for an empty queue,
    which is a legitimate no-op. The exit is set through `process.exitCode`, never
    `process.exit()`, so the manifest, the report, the network teardown and the lock release
    all still happen. The queue-summary line leads with the count that matters — `ready
    queue: <d> of <r> dispatchable — <ids>` — and names refusals by kind in a clause after the
    id slot, which is unchanged so the dashboard's parser and every log already on disk keep
    reading. Five grep sites in `scripts/test-runner-queue.sh` pin the historic prefix, not
    six as earlier rows say.

    **The freeze is a command, and it proves its own work** (change-log row
    `freeze-command`). Every enforcement point around the freeze sat at the *end* of the loop.
    `bd create` is one line, always available, needs no tests, and produces an issue that reads
    `ready` in `bd ready` forever; the gate above is invoked by hand and nothing records whether
    it ever ran; the admission rules refuse minutes into a launch. Between "an issue exists" and
    "a run refuses it" there was no moment at which a missing suite was anyone's problem — so a
    queue of eight dispatched zero, three runs running, and the person who filed them had done
    nothing any tool could complain about at the time. The detection was never the gap: the
    summary line said the right thing in good English. What no one could do was **ask in
    advance**, and what the system did not do was **fail**.

    `scripts/freeze.js` closes both halves with two verbs. `status` answers "what would a run
    dispatch right now?" without launching one, printing the dispatchable and refused
    populations with each refusal's kind and remedy, and exiting 1 when a non-empty queue can
    dispatch nothing. `commit` performs PLANNING.md step 6: it runs the gate over each named
    suite, commits the suites and their receipts to the integration branch under a generated
    message, pushes, and then **asks the runner's own `partitionByFreeze` whether the branch it
    just wrote will be accepted** — so what it reports is the runner's verdict and not its own
    belief. Both verbs import that gate rather than restating it; a second implementation of
    "is this frozen?" would agree on the day it was written, and the entire value of asking in
    advance is that the answer is the one the run will give.

    Four refusals are structural rather than advisory, each because the alternative leaves a
    tree nobody made. A batch is gated **in full before anything is staged**, so a refusal on
    the fourth id cannot leave the first three committed. A target checkout with **anything
    already staged** is refused, because this commits the index and another session's staged
    file would ride into a freeze commit under its message. A checkout **parked on another
    branch** is refused rather than switched: moving a working tree this command does not own
    is the collision the session guard exists to prevent, approached from inside a tool.
    And `--allow-half-proven` **without `allowHalfProven` in the run config** is refused up
    front, because that pair produces a freeze this command calls done and the third admission
    rule refuses at dispatch — the exact outcome it exists to make impossible, reached through
    its own flag.

    **It does not write the tests, and that is not a gap.** The acceptance suite is the spec
    (§2, hard invariant 3); a machine that drafts it decides what "done" means with nobody in
    the room. An issue whose `tests/acceptance/<issue-id>/` does not exist is refused naming
    PLANNING.md step 3, and an existing directory holding no test files is refused separately,
    because that one is the vacuous freeze the gate exists to prevent rather than an absent one.

    A re-freeze of an **unchanged** suite makes no commit. The gate stamps the moment it ran
    into the receipt, so re-running it over a suite nobody touched yields a file differing in
    one timestamp — and an operator re-runs a freeze constantly, after a refusal, after a
    rebase, to check. Equal `suiteHash` and equal verdict means the gate judged the identical
    suite, the committed receipt is restored byte for byte, and there is nothing to stage.

    **The brief that sends an agent to write a spec's tests is generated** (change-log row
    `spec-brief`). PLANNING.md step 3 is the step that gets skipped, and the reason is not that
    it is hard to describe — it is the same eight paragraphs every time. What changes per issue
    and per project is six facts: the integration branch, the verify command, the frozen paths,
    the host environment a headless run needs, which folder the agent works in, and where the
    freeze gate is pointed. Written by hand the first time, four of those six were wrong — a
    binary path that had moved, a `scripts/` directory the target repo does not have, a `--repo`
    aimed at the shared checkout rather than the worktree, and a worktree the brief said to
    create when one already existed. **Three of the four produce a gate result that looks like
    an answer**: a missing binary false-fails every test into a red the control fixture
    certifies as discriminating, and a `--repo` aimed at the wrong tree grades a directory that
    is not there. At one issue that is a wasted morning; at twenty it is why the tests do not
    get written.

    Every one of the six is already recorded where the host can read it — the run config, the
    target's `pipeline.config.json`, git's own worktree registry, Beads — so
    `scripts/spec-brief.js` retypes none of them, and quotes the issue's criteria rather than
    the planning draft, because the issue is canonical from freeze onward. It reads only.
    A nonblank structured `acceptance_criteria` field is authoritative. For older issues whose
    Beads schema left that field blank, the only accepted fallback is the description's exact,
    case-insensitive Markdown `Acceptance criteria` heading section, beginning with a top-level
    `1.` and ending at the next equal-or-higher heading. Unlabelled prose and bullet lists remain
    no criteria rather than becoming a heuristic specification. Markdown-looking headings inside
    backtick or tilde code fences and HTML comments are examples, never section markers; an
    ambiguous or unclosed comment refuses the fallback. The accepted criteria heading remains
    strict ATX, while ordinary ATX and paragraph-shaped Setext peer-or-higher headings end its
    section; list items and thematic dividers are not Setext titles. Rather than embedding a full
    CommonMark HTML parser in this rare compatibility path, any visible raw HTML tag line or
    uppercase `<!…>` declaration block refuses the fallback; an unclosed declaration fails closed.
    A present structured field of any non-string type is malformed and fails closed rather than
    taking the legacy fallback.

    **Three states, three briefs**, decided before a word is written: `write` (no suite
    anywhere), `freeze` (a suite in the working tree the branch has never seen — a session that
    stopped one step short, which no branch-side check can see) and `re-gate` (on the branch,
    refused for its receipt rather than its absence). The last two need no drafting, and a
    report that does not separate them makes a nearly-finished task indistinguishable from an
    untouched one. The state comes from the runner's own `partitionByFreeze`, never a second
    reading of the rule.

    The operator may look an issue up by a short Beads alias, but the `id` returned by `bd show`
    is the canonical filesystem identity. New suite paths and branches use that canonical id.
    One uniquely registered legacy `freeze-<requested-id>` worktree may be reused to preserve
    unfinished local work, but canonical-plus-alias branches or suite directories, duplicate
    aliases, and two batch inputs resolving to the same canonical issue are collisions. A suite
    already published only under an alias must be re-cut under the canonical path because the
    runner dispatches only `tests/acceptance/<canonical-id>/`.

    A suite already committed on the integration branch appears in every worktree that inherited
    that commit, so directory presence alone is not an ownership claim. For `re-gate` only, a
    legacy worktree is ignored when its committed test content has the same receipt-independent
    suite hash as the **exact `FETCH_HEAD` tree the dispatch gate just judged** and its suite path
    is clean of tracked, untracked and ignored changes. The hash is the receipt formula from
    §3.2, so adding only `.freeze-gate.json` cannot manufacture a legacy ownership claim. The
    gate carries both that hash and the diagnostic raw tree object id out of its throwaway
    repository; the brief never resolves a local branch name a second time, because a local ref
    may be ahead of or behind the remote decision. Different test content, any local suite byte,
    a missing identity, or any Git uncertainty remains a collision. `write` and `freeze` keep the
    original conservative rule because there is no remote suite whose inheritance could explain
    the second copy.

    A machine-specific path lives in the run config's optional `hostEnv`, not in the target's
    `pipeline.config.json`: run configs are host-local and git-ignored, and a path true on one
    machine must not be committed to a repository other machines clone. Nothing at run time
    reads it — a container takes its dependencies from the image — so it is validated as
    strings and consumed only by this brief.

    **The skipped handoff is now a bounded planning command** (change-log row
    `test-author-launcher`). `scripts/author-tests.js` consumes the brief builder's structured
    state rather than parsing its prose, creates or reuses only the issue worktree named by
    that builder, and launches `claude -p --model <alias>` there with the brief on stdin. The
    alias comes from the optional planning-only `testAuthorModel`, falling back to `model`, and
    is always explicit so host-global CLI preferences cannot select the author. The session is
    bounded by the run's wall clock and the shared host-process output cap, uses argv spawning
    without a shell, and runs in Claude's restricted mode with `acceptEdits`. Restricted mode
    confines file tools to the issue worktree and protects Git/configuration files; the launcher
    exposes only read/edit/search plus Bash, pre-authorizes only the target's exact verifier, and
    explicitly denies Git mutation, Beads, and freeze commands. Every other Bash command remains
    unapproved in the noninteractive session. Ready, freeze and re-gate states do
    not launch a writer. Success and failure both stop at a report and the mandatory human
    approval step; the command never invokes the freeze/commit/push path.

    **Backlog preparation is one resumable parent with bounded, snapshot-only workers**
    (change-log row `batch-test-preparation`). `scripts/prepare-batch.js` names an immutable
    issue roster and records each issue's Beads dependencies, criteria fingerprint, integration
    HEAD, redacted configuration and exact full-id worktree before it launches anything. Beads
    access and worktree allocation remain serialized in the parent; a default and hard maximum
    of ten child processes receive complete snapshots on stdin and call only the structured author/proof
    cores. The coordinator and the standalone commands share the runner's target-global lock,
    so no preparation worker can overlap a pipeline run or be rediscovered through an ambiguous
    folder. `runs/preparations/<batch>/` holds an immutable manifest, hash-chained events and
    nonce-paired worker start/results. A live or unmatched start is observed, never replayed; it
    blocks all preparation until an operator stops the worker and descendants, then uses the
    separate `acknowledge-interrupted` verb before retry. Config secrets and `hostEnv` values are
    neither persisted nor included in the durable config hash, and their values are scrubbed from
    persisted worker evidence and errors.

    The managed proof's integration-target comparison normalizes two non-test host artifacts;
    retained baseline and probe marker identities keep their original full semantics. A sibling suite's freeze
    receipt is omitted only when the runner's own receipt parser accepts it, Git proves it is
    untracked, and it is a single-link regular non-symlink file; promotion stages only the suite under proof,
    so that sibling metadata is neither copied nor overwritten. A tracked or staged, malformed,
    unreadable, symlinked or current-suite receipt remains protected. The other normalized shape
    is one host-only Godot artifact: a strict generated
    `<script>.gd.uid` sidecar in another suite when Git proves it is ignored and untracked, it is
    a regular non-symlink file, its `.gd` companion remains in the protected manifest, and its
    body is Godot's variable-width generated form: `uid://`, one through thirteen characters
    from the engine's `a`-`y` plus `0`-`8` alphabet, and an optional final newline. The suite
    under proof, tracked or staged sidecars, malformed or orphan sidecars, every source file,
    and every uncertain Git result remain protected and fail closed. Where integration matches
    neither the clean base nor the proven tree, the refusal reports the closer identity's delta,
    so an expected not-yet-promoted suite is not misreported as the cause.

    Protected-tree hashing is bounded by both path count and conservative Windows command-line
    size, but remains Git-native: each batch uses `git hash-object -- <paths...>` so attributes,
    clean filters and line-ending normalization have the same semantics as the former per-path
    calls. The controller requires exactly one valid object id for every input path and has no
    raw-byte or partial-manifest fallback. A timeout, signal, Git error, missing id or malformed id
    therefore refuses the proof. This changes process count from one Git child per protected file
    to a small number of bounded batches without weakening the protected-byte identity. Generated
    Godot sidecar normalization likewise takes one NUL-delimited ignored-path decision and one
    complete tracked-path snapshot instead of two Git children per candidate. Any malformed,
    incomplete or failed snapshot keeps all uncertain sidecars protected.

    Proof execution also emits a fixed, validated stage vocabulary for prepare, probe-agent,
    pre-gate protected check, gate, post-gate protected check and marker write. Batch workers carry
    those events on a prefixed stderr side channel while retaining the one-JSON stdout protocol;
    progress reporting is observational and can neither manufacture success nor suppress a proof
    failure. Operators can now distinguish a live expensive gate from a stalled integrity scan.

    The strongest batch result is deliberately **proven-at-base**. A proof is bound to the exact
    integration HEAD and protected-tree manifest, so freezing one suite makes every other old
    proof stale. Preparation therefore has no freeze, commit, merge, push or Beads-write verb.
    After one human review, proofs sharing one base may be published atomically: the freeze
    command takes one issue-to-managed-probe mapping per suite, validates every marker before a
    write, gates each retained baseline/probe pair, promotes only the disjoint suite union, and
    makes one commit and one leased push. A missing, mixed-base, changed or mismatched member
    refuses the whole publication. Proofs that do not share a base are re-proved and frozen in
    series. Dependency edges are recorded for the handoff, but they do not serialize
    spec-derived test authors; the ordinary Beads-ready feed remains the only authority that
    releases implementation work in dependency order.

    **The ready queue is re-read while the run is in flight** (change-log row
    `live-queue-feed`). Until this, a run's roster was decided once: `readyQueue()` at the
    top of the task loop, then the pool walked that array to its end. An issue made ready a
    minute after the run started waited for the next run — the wrong shape for the way work
    actually arrives, since freezing happens in a working session that is often still going
    while the run drains. `runner/feed.js` replaces the array with a **source** the pool
    pulls from, and `drainQueue` takes either (an array is wrapped in a fixed source, so every
    existing caller keeps its contract). Feeding a task to a live run is then just `bd` in a
    working session: there is no "submit to the pipeline" command and there must not be one,
    for §3.8's reason — an inbox that can start a container is not an inbox.

    - **Off by default, and off is the pre-feed behaviour exactly.** `feedIdleGraceMinutes`
      in `run.config.json` is `0` unless a project asks otherwise, and at `0` the queue is
      read once and never re-read — the poll function is not called at all. Zero is therefore
      a *legal* value where every other numeric field in that config demands a positive one,
      because it is how a config says "off" out loud, and the config most likely to say it is
      the one being switched back after a bad night.
    - **Only a free worker triggers a re-read.** A worker asking the source for work *is* the
      free-slot signal; a run whose workers are all busy never polls. Not tidiness:
      `readyQueue()` is synchronous and reaches both `bd` and `git fetch`, so every poll
      blocks the runner's event loop — including the I/O of every container already running.
      `feedPollSeconds` (default 30) is a **ceiling on frequency, not a delay before the
      first read**: a pool that has just gone idle re-reads at once, because it is idle
      precisely because someone may have queued something a moment ago.
    - **A failed re-poll is never fatal, and this is the load-bearing rule.** The startup read
      answers an unreadable queue with `process.exit(1)`, which is right *there* — nothing has
      started, no container is up, no issue is claimed, and the lock releases cleanly. The
      same reaction mid-run kills every running container and strands its issue `in_progress`,
      and it would fire on a transient `bd` timeout the run could have ignored. So a re-read
      that fails — returning `ok:false` **or throwing**, since a throw reaching the worker loop
      takes the run down exactly as an exit does — is logged, the remainder is kept, and the
      next poll tries again.
    - **An issue is dispatched once.** Ids handed out are remembered for the life of the run,
      and so are the ones still waiting in the remainder. `bd ready` keeps reporting an issue
      until the runner claims it, so between a read and the claim that follows there is a
      window in which a second read hands the same issue to a second worker — both claim it,
      both push a branch for it, which is the failure the per-project run lock exists to
      prevent (change-log row `repo-os9`) reintroduced inside one process.
    - **A refusal becomes a wait rather than a verdict.** A task frozen mid-run is refused by
      the second admission rule above for the minutes before its suite is pushed — and by the
      third for as long as the receipt beside it is unpushed, which is a second way the same
      few minutes look from in here — which is exactly right and exactly temporary. So
      refusals are re-evaluated on every poll, carrying their `refusal` kind, and
      only what is **still** refused when the run closes is manufactured into a manifest row.
      Reporting a task as undispatchable when it later ran and has a PR would be a lie about a
      task the reviewer can see succeeded.
    - **Four ways a run ends, and the manifest says which.** `drained` (the roster was spent —
      always the answer with the feed off), `idle` (the grace window expired with nothing new),
      `stopped` (a `runs/<run-id>/stop` sentinel appeared), `halted` (§7's run-level
      rate-limit cap fired, so nothing further could be launched and a run that kept polling
      would sit idle handing out work nothing can start). The sentinel is what makes a fed run
      stoppable **without killing a process that is holding containers**; it is a feed feature
      only, because a classic run whose remaining tasks stopped being dispatched would leave
      them absent from `run.json` altogether — the silent hole the refusal rows above exist to
      prevent. For the same reason `halted` does not reach a classic drain: when the cap fires
      mid-roster those tasks are still dispatched, refused by `gate.admit()`, and each resolves
      a `paused` row.
    - **The grace window belongs to the pool, not to a worker.** One worker idle while its
      peers work is not an idle run, and starting the clock on the first free worker would
      close a fed run the moment its first task finished.

    Two readers downstream of this were named here before they were fixed, and **both are now
    fixed** (change-log row `feed-readers`).

    `scripts/batch.js pending` decides "has any run since the freeze worked these ids?" by
    comparing the marker's `frozenAt` against a run's clock (§3.9). For a classic run,
    `startedAt` answers that exactly — its roster is fixed at that instant. A fed run works ids
    frozen *after* it started, so `startedAt` reported a launched batch as un-launched, and the
    cost of that wrong answer is a batch launched twice. **A fed run is therefore bounded by
    its END**: `finishedAt` when the manifest carries it, and where it does not — still in
    flight, or killed — the run counts against every freeze, labelled `run-fed-open`.
    Conservative in the same direction as the existing `run-time-unknown` and for the same
    reason: a false "launched" sends someone to look, a false "pending" starts containers. The
    `feed.enabled` read is **strictly `=== true`**, because every manifest written before the
    feed shipped has no `feed` key at all and a truthy test would re-answer the whole historic
    corpus.

    `scripts/dashboard.js` had two problems, both of the silent kind that reader fails by — a
    well-formed picture that is wrong. The feed logs under the trace `<runId>/feed`, a
    **run-level pseudo-task exactly as `preflight` is**, and a reader that does not know that
    renders a phantom task called `feed`, permanently `queued`, in a tool whose whole job is to
    say what is running; `PSEUDO_TASKS` now names both. And a fed run that has finished every
    task it holds looks from outside exactly like one about to exit — empty queue, every row
    finished — when it is actually idling in its grace window and will take anything frozen
    now. So `/state` carries a run-level `feed` block (`enabled`, `open`, `pickedUp`, `ending`,
    `polls`), assembled from the log while the run is in flight and from the manifest once it
    is over, and the page shows an open feed as a banner. Without it a watcher concludes the
    run is finished and starts a second one, which the project lock then refuses — the
    confusing failure rather than the dangerous one, but confusing failures are what that tool
    exists to remove. `run.json`'s `tasks` being in **dispatch order**, with a length not
    knowable from the startup queue-summary line, is the same fact underneath both.

    The Beads database's canonical home is the working copy at the configured
    target-repo path on the host; the runner runs `bd` against it, and in V1 (single
    machine) its state is not pushed anywhere. **The runner writes a per-run manifest**
    — `runs/<run-timestamp>/run.json`, schema `run.schema.json` checked into this repo,
    owned by the runner task — recording per task: issue id, branch, exit code (or
    `killed`), the derived 4.11 outcome, attempt count, and PR URL if any. The report
    generator reads the manifest (plus Beads + git) as a frozen input; Beads alone
    cannot reconstruct report statuses, since stuck/tampered/failed all map to blocked.
    Per-run logs, trace IDs, collected status files, the manifest, and the run report
    live under `runs/<run-timestamp>/` in this repo on the host, git-ignored — and, since
    change-log row `events-ledger-design`, so does `events.jsonl`: one JSON object per
    `run.log` line, appended by the **same function with the same timestamp**, so the two
    cannot disagree. Every object carries `ts`, `level`, `runId`, `issueId`, `trace`,
    `event`, `msg` and a `data` object; the lines the readers already parse by regular
    expression are named events with typed fields, everything else is `event: "log"`, and
    three facts no reader could previously reach — the queue read with every refusal, each
    attempt's verifier result and failing check names, and each spec concern — are
    ledger-only events with `msg: null`. `schemas/events.schema.json` is the contract.
    `run.log` stays byte-identical for humans; the readers move onto the ledger one at a
    time, each keeping its suite green. Append-only, host-only: nothing in a container
    writes an event.

    **The writer is built** (change-log row `repo-qzy`): `runner/log.js` appends both files
    from one clock read, `info()` and `error()` take an optional `{event, data}` third
    argument, and `event()` records a fact with no prose form. Every line the dashboard's
    prefix table parses is a named typed event. `issueId` is the trace's tail,
    and null for the two PSEUDO-tasks — `preflight` and `feed` — because they are run-level
    work borrowing the trace shape rather than Beads issues, and recording them as issue ids
    would invent two issues that do not exist. `scripts/dashboard.js` exports its prefix
    table so a suite can check the two vocabularies against each other rather than keeping a
    second copy; no reader reads the ledger yet. `scripts/test-events.sh` runs the writer's
    suite and, from the same script, the three reader suites — because "`run.log` is
    unchanged" is a claim about files the writer's own suite never opens.

    **The three facts are in** (change-log row `repo-3xw`), which is what makes the ledger
    worth reading rather than a second copy of `run.log`. `queue.read` is the structured twin
    of the `ready queue: ` line and `task.undispatched` the twin of each `not dispatched: `
    line; both come from exported helpers in `runner/queue.js` that `main()` calls, for the
    reason `queueSummary` and `undispatchableRow` were lifted out of `main()` before them —
    everything written inside `main()` sits behind the token load and the Docker preflight,
    unreachable to every Docker-free suite, and an event no test can reach is an event that
    stops being emitted quietly. Both carry **ids, never issue objects**: a `bd` issue holds a
    title, a description and whatever a future `bd` adds, so embedding one would grow every
    line without anyone deciding to and would put issue prose into the artifact whose value is
    that it reads by machine. `task.undispatched` is traced to its ISSUE rather than to
    `preflight`, so `issueId` files it where a reader asking about that issue will look.

    `attempt.finished` and `concern.raised` are LEDGER-ONLY (`msg: null`), emitted once per
    task **after** the relaunch loop from the collected status file — never inside it, because
    a parked task collects its status again on every relaunch and emitting there would make
    the recorded attempt count depend on how the subscription window happened to fall.
    `attempt.finished` carries the attempt's verifier result and the NAMES of the checks that
    failed, from `failingChecks` in `scripts/sweep-assertions.js`: the file that already owns
    this repo's assertion-line vocabulary, so the ledger imports the decision rather than
    keeping a second parser that would drift silently into a name list that is non-empty,
    well-formed and stale. Its answer is a trichotomy and all three values are load-bearing —
    `[]` nothing failed, a list these failed, and `null` *nothing is known*, which is the state
    of an attempt that failed and whose output did not survive (a killed container leaves a
    half-written `verify.json` that artifact collection drops on purpose). Collapsing `null`
    onto `[]` would score two attempts that recorded nothing as having failed identically.
    `concern.raised` carries each `specConcerns` entry verbatim — evidence only, like every
    other surface 3.7's channel reaches, and unable to move an outcome (3.5).

    The container-side isolation assertions (no `git push`, read-only verifier, no
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

**Watching a live run is deterministic reading too** (change-log row `live-dashboard`).
The corpus audit above reads finished runs; the dashboard is its live sibling on the same
read model: `scripts/dashboard.js`, a host-side pure reader with an HTTP face. It binds
`127.0.0.1` only and serves one self-contained page (the `docs/pipeline-map.html`
delivery shape — no external fetches) that polls a `/state` JSON endpoint every few
seconds: a channel-selector strip of projects across the top (the union of the `runs/locks/`
registry, §4.12 — live projects — and the projects the run directories name, since a
lock exists only while a run is in flight and an idle machine would otherwise show an
empty home screen), and one view per project — the queue diagram with the node each
task currently occupies lit, the inside-container diagram per running task with its
current phase lit, attempts, pauses, elapsed wall-clock from the host's own timer, and a
storage row (queue · workspace · `runs/<runId>` · PR) that lights as each is written.
The view is one run per project — the live one when a held lock names it, else the
newest finished one rendered from its manifest; never history across runs, which is the
audit's job. The delivery is two pieces with the JSON as the seam: the *reader* (the
server and the frozen `/state` contract) is a pipeline task, while the *page* is built
interactively against that contract — its look is deliberately unfrozen, so it is
reviewed by looking at it, which is planning-session work, not a three-attempt
container's. Everything it knows comes
from files the pipeline already writes: the lock registry, the newest run's `run.log` —
whose `<ISO> LEVEL [runId/issueId] msg` line shape is the runner's own pinned format, so
parsing it is structural, and the §3.6 ban on scraping *agent* logs stands untouched —
`run.json` once it exists, and each live task's `.run/status.json` on its host-mounted
workspace. Queue state is read from the runner's own log lines, never from Beads: the
dashboard holds no `bd` access, spawns nothing, and touches no Docker. Four properties
are load-bearing, all inherited from the two tools above: **no LLM** (hard rule 7); **a
pure reader** (creates, modifies and deletes nothing — the `repo-73k` contract, checked
the same way); **never a gate** (it has no path by which to reach a run); and
**host-only** (the page names targets, PR URLs and issue titles, so the server binds
localhost and nothing tracked ever carries its output — the tool and its page template
are generic and tracked). One deterministic feed was added for it, because the live
view is otherwise dark exactly where a watcher most wants light: a `phase` field in
`status.json`, set by `pipeline/entrypoint.sh` at each phase boundary through
`pipeline/status.js` (additive in the schema — a status file without it stays valid).
Live workspaces are found through the runner's existing unconditional
`workspace ready: <dir> on <branch> (fork point …)` line — already emitted for every
prepared workspace, so the dashboard works against every run the corpus already holds —
and it degrades by naming what it cannot know (`phase` absent on runs produced before
the feed shipped) rather than requiring it, so neither task depends on the other. Malformed
artifacts render as named degraded states, never crashes — a dashboard that dies on the
tree it watches is a dashboard nobody trusts at 2 AM. The page's *look* is not frozen;
the `/state` JSON is — the same outcomes-not-decisions line every frozen suite here
draws. Declared at planning time; the implementing tasks add their own rows when they
ship (the `run-audit` pattern).

**Both halves are built** — the reader in change-log row `repo-kfg`, the view in
`live-dashboard-page`. `scripts/dashboard.js` serves the frozen `/state` contract and the
live page against it; run it with `node scripts/dashboard.js` and open the address it
announces. What the contract holds, and the derivation behind each field, is that row —
the parts worth repeating here are the three that a later change could break without
noticing. The run a project shows is picked
by **the held lock's `runId`**, not by which directory is newest, because a live run is
routinely not the newest directory on disk. A run directory with no `run.json` is a
`no-manifest` run, never a skipped one — every run *in flight* is manifest-less, so the
`verdict.js` rule of skipping such a directory would hide exactly what this tool exists to
show. And the page it serves is built interactively against that contract, which is the
split this section's delivery paragraph already argued for; it shipped as change-log row
`live-dashboard-page`.

**The dashboard says where a task is, not how it got there** (change-log row
`task-timeline`). Each task row answers *running / finished / stuck, attempt 2 of 3* and
stops, which is the wrong half of the question after an unattended run: a watcher opening
the page at 2 AM wants the sequence — when it started, what the container did, which
attempt failed verification and on what, whether the push or the PR is what actually broke.
Every fact needed is already read on each `/state` request and then thrown away.
`buildTask()` receives every parsed `run.log` event for its issue id and keeps four scalars
from them; it reads `status.json` and keeps only `attempts[].verifierResult`, discarding
each attempt's `timestamp` and its `feedback` — which §4.4 defines as the short
verifier-failure digest, and which is precisely the explanation the row is missing. So each
task in the contract gains an additive **`timeline`**: a time-ordered merge of three sources
the reader already opens — the log events, the per-attempt records, and `stuckState` /
`docsPhaseError` — each entry a timestamp, a term from a closed vocabulary of 34, a short
detail, and, on the four `verify-*` terms alone, the attempt number, which has nowhere else
to live once the detail is spoken for by the failure digest.
`schema` stays `1`; the field is additive and its only consumer ships in the same
file. It is not a `degraded` term, because an overflowing timeline is a fact about a long
task, not a defect.

Two bounds are set against the way each would otherwise fail. The list is capped at 60
entries, but **the first 5 are kept alongside the newest 55**, and the dropped count is
stated as `timelineOmitted` rather than silently truncated. Newest-only is the obvious rule
and it is wrong here: `maxPauseCycles` defaults to 96 (`runner/config.js`) and the probe
path emits two lines a cycle, so a run that parks all night can offer ~192 candidates and a
newest-60 window holds nothing but probe lines — no start, no workspace, no attempt — on
precisely the run whose story is being asked for. And free text is truncated to 200
characters **head-kept everywhere except `feedback`, which is tail-kept**, because
`pipeline/status.js` already writes that field as the last 2000 characters of the verifier's
output: head-keeping the head of a tail returns the test harness's start-up banner, which is
non-empty, well-formed, and carries none of the failure. Control characters are stripped and
a truncation never splits a surrogate pair.

**The vocabulary has to be complete, and completeness has to be enforced by something other
than care.** The reader identifies log lines by literal prefix and drops what it does not
recognise, which is what makes this structural parsing rather than scraping and stays
exactly as it is. But its table declares eleven per-task prefixes — of which it actually
*consumes* nine, `launching container ` and `container ran ` having been declared and never
referenced — against the **43** `runner/` can emit, and the ones it does not know are
disproportionately those that explain a bad ending: `workspace preparation failed`,
`docker run failed to start`, `giving up on the pause`, `push failed for …`,
`PR creation failed for …`, `wall-clock budget exhausted — killing …`. A timeline built on
today's table would be non-empty, well-formed, and silent on exactly the runs it exists for
— the §4.11 artifact rule's failure mode again. Every per-task line the runner can emit
therefore carries a term, in one of two classes: **shown**, or **known-but-not-shown** for
bookkeeping with no watcher value (the `memory:` lines, `integration branch:`,
`workspace kept at`, the probe lines a night-long park repeats, and the restatements the
shown entries already carry). Classifying the noise is what lets completeness be checked
without the timeline degenerating into a log dump: an unclassified line is a defect, a line
classified as noise is a decision on the record.

**"Per-task call site" is a definition the spec pins, not a number an implementer's regex
discovers.** It is a `log.info` / `log.error` in `runner/` whose trace argument is a task
trace id — 16 `tr` plus 29 `traceId`, less the two in `runner/preflight.js` whose parameter
is only ever passed the run pseudo-task, giving 43 across `run.js`, `container.js`,
`workspace.js`, `publish.js` and `pause.js`. `pause.js` is the one a casual count drops, and
it is the last one that should be: eleven of the 43 are its, and they are the lines that
explain a park. Three of the 43 resist a pure prefix table and are decided here rather than
at attempt two. `branch ` heads a line in both `run.js` and `workspace.js`, and since
workspace branches are named `task/<issueId>` the two are identical for far longer than
their prefixes — they collapse to one term classified as noise, the facts being carried
already by `pushed …` and `no commits on the branch`. `run-level park: ` is a strict prefix
of two longer lines and `paused: ` heads two, so **matching is longest-prefix-first**, not
the first-match-wins loops the reader uses today. And `holding: the run-level rate-limit
park is open` is **unreachable as a task row by construction**: `runner/run.js` calls
`gate.admit(issue.id)` with the bare issue id rather than the task trace, so the line is
logged under a trace with no slash and the reader's grouping drops it. It is classified
shown and recorded here as a defect rather than quietly called noise, which would put a
false decision on the record; the one-line trace-id fix is a separate issue, because this
task changes nothing in `runner/`.

The enforcement is **two halves, because either alone passes a broken implementation**.
Behavioural fixtures prove each known line maps to the right term, timestamp and detail —
the house pattern this file already uses for the lock's liveness rule, which the reader
re-implements inline because it may `require` nothing from `runner/` and must work as a copy
from any repo-shaped root. That property is why a shared `runner/log-events.js` imported by
both was considered and **rejected**: the join belongs in the test, not in the code. The
second half is an inventory check that fails when any extracted prefix is unclassified — the
half that fires the day someone adds a log line six months from now. What it asserts is an
**exhaustive partition**, not a count: every `log.*` call site in `runner/` is per-task, or
run-level with a literal message, or run-level with a computed one, and **none is left
over**. A count floor alone fails in both directions — pinned at today's exact number it
reds the sweep for years on unrelated edits, and loosened it invites the cheapest green
available, which is deleting the log line that will not classify rather than classifying it,
since `runner/` is not a frozen path. A partition closes both: the population is defined by
what is *there* rather than by a number, so a future per-task line written under a new trace
identifier leaves a leftover and fails loudly instead of vanishing from a scan keyed on
variable names. A loose floor is kept underneath it only so a regex matching nothing fails
rather than reporting a clean sweep — the same shape as a suite that could not execute its
own stub and called every check a genuine failure. Delivery splits on the `live-dashboard-page` precedent: the contract, the
vocabulary and both guard halves are a pipeline task; rendering the strip on the page is
interactive, because a frozen test can pin that a page is self-contained but not that it is
legible.

**The merge pass gets a reader too** (change-log row `merge-order`). Everything upstream of
the merge has scaffolding — queue, workspace, verifier, report, verdict recorder, corpus
audit — and the merge pass has none, so a human rediscovers the same three things by hand
for every batch: the docs-phase collisions (every task's docs phase edits the target's
`DESIGN.md`, `README.md` and `SPEC.md`, so every merge after the first conflicts in prose
even when the code is disjoint by file-ownership constraints), the sibling-suite noise
(`PLANNING.md` step 8 pushes the whole batch's frozen tests to the integration branch
before the run, so each task's regression run fails on tests for work nobody has done yet —
the recorded cause of a whole batch reading `partial` in the 2026-08-04 hand pass), and the
evidence staleness the first merge creates for every PR that follows it. `scripts/merge-order.js`
is the fourth pure reader on the §5 model: same host-only output, same never-a-gate exit,
same no-LLM (hard rule 7's spirit where hard rule 7 does not reach). Two facts about the
artifact it reads shape it. The PRs are a **fan, not a stack** — `runner/workspace.js`
clones the target fresh per task and branches off `origin/<defaultBranch>`, so they are
siblings whose fork points can differ (concurrency, or a human merging mid-run); there is
no order to read off the git graph and no rebase chain to preserve, which is what makes the
order a free choice worth computing. And **ordering cannot reduce the conflict count** — a
file touched by k PRs conflicts in k−1 of the merges whatever the order — so the report
states that ceiling before it states any benefit, and claims only the four things ordering
does buy: every non-colliding PR merged with zero judgment and first, the remaining
judgment named and clustered and taken once, dependencies never inverted, and staleness and
expected-to-clear failures named per step.

**It computes the merges rather than predicting them**, which is what keeps it deterministic
scaffolding rather than a heuristic that can be non-empty, well-formed and wrong (the STATUS
defect 8 shape). `git merge-tree --write-tree` performs a merge in memory and names every
conflicted path; chaining its tree through `git commit-tree` simulates a whole order, step by
step, so every conflict the report names is one that *happened* in a simulation of the exact
order proposed. Cost is bounded and stated: the true pairwise collision graph is N choose 2
in-memory merges (28 at eight PRs), plus one N-step simulation of the order actually
suggested — never the N! of trying orders. The simulation is exact for a merge commit and for
squash-and-merge and **approximate for rebase-and-merge**, which replays commits individually,
and the report says which it simulated. The `repo-73k` pure-reader contract is kept *literally*
and by measurement rather than assertion: `merge-tree` and `commit-tree` do write objects, so
both run with `GIT_OBJECT_DIRECTORY` pointed at a temporary directory and
`GIT_ALTERNATE_OBJECT_DIRECTORIES` at the repository's real object store, which was measured on
the reference host (git 2.54, 2026-08-19) to put **zero** new objects in the real repository
across a full three-step simulation. Two commitments follow from the same principle, both
because this tool runs *during* a review, against a working copy in use: it **never fetches**
without an explicit `--fetch` — a branch absent locally is named as missing and the order
labelled partial, the dashboard's degrade-by-naming rather than a silent subset — and it
touches no working tree, index or ref. Three scope decisions were taken at declaration
(2026-08-19, user): the input is a **run id**, which joins the corpus for free and is the
common case; dependency order is **inferred from the run record** and labelled as inferred
rather than read from Beads, because unlike the `batch-ready-marker` reconciliation a wrong
order here costs an afternoon rather than hiding a defect; and the **expected-to-clear
regression section ships**, matching sibling issue ids — keys the report already holds, not
log scraping — against each task's stored regression evidence, with its limit printed where it
prints, since `verify.json` keeps only a 2000-character tail so a match is evidence and silence
is not. The boundaries are the ones the inbox entry named: it never merges, pushes, opens or
edits a PR, holds no `gh` and no network, and is never a gate (exit 0 on any finding). The
cautionary tale is an agent platform auto-merging PRs past failing integration tests (a public
field report, 2026-01) — the borrowed part is the queue discipline, and the autonomy is
explicitly not borrowed. One honest consequence is recorded here rather than left to be
discovered: the docs-phase merge strategy still parked in `docs/IDEAS.md` would, if it moves
the docs phase to per-task files, remove most of these collisions and shrink this tool to its
dependency and staleness halves — which is an argument for building it in that order, since
measuring the collisions is what turns that parked entry's three options into an evidence-led
choice. Declared at planning time; the implementing task adds its own row when it ships and
owns the CLAUDE.md "Running things" entry, which until then would describe a tool that does not
exist. Thread: `docs/threads/merge-order.md`.

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
  natively for Beads/Claude output, and can enforce wall-clock timeouts with an independent
  worker clock + bounded `docker kill` without relying on a platform `timeout` command.
  Plain JavaScript, no framework.
- **Image strategy: shared base + thin per-project layer.** The base image (Node, git,
  the Claude Code CLI, `bd` — **no pipeline scaffolding**; the entrypoint and verifier
  are mounted at runtime per 4.10) is maintained in this repo; each target project gets
  a thin hand-written Dockerfile (`FROM` the base, plus its `pipeline.config.json`
  dependencies — see 3.4 for the drift cross-check). Versions of the base OS, Node, and
  the CLI are pinned in the base Dockerfile.

### 6.1 The user profile (how an agent addresses the person)

A per-person, per-machine host input, decided here beside the token and `bd` because it is
the same kind of thing: something each person supplies on their own machine, that no clone
carries and no repo file can substitute for. `docs/user-profile.example.md` is the template;
the live copy belongs at `~/.claude/CLAUDE.md`, which loads into every interactive session
on that machine with nothing to configure. A copy kept in a repo is git-ignored, because a
profile describes a *person* and this repo documents the machinery, never the people or the
work done with it — the same boundary that keeps `runs/` out.

**Scope, stated first because it is narrow.** The profile governs **interactive sessions
only** — planning (3.2), review (5), and the conversation around them. It never reaches a
container: it is not exported beside `.run/memory.md`, no new mount or credential exists for
it, and 4.8's enumerated egress and hard rule 6 are untouched. It also changes nothing about
the prose a docs phase writes into a target repo, or the wording of a PR body. The reason is
ownership rather than caution — code and documentation are read by whoever maintains them
next, so their register belongs to the repo; only the conversation belongs to the person
having it.

**Two axes, not one.** A single "how technical is this reader" scale is the obvious design
and it mis-slots the exact reader this pipeline was built for. *Systems fluency* — reasoning
about failure modes, invariants and trade-offs — and *software vocabulary* — whether
`merge-base`, bind mount or CRLF mean anything — vary independently. A specifier who directs
work they do not personally execute is high on the first and low on the second, and a
one-dimensional ladder places them next to a reader who cannot follow the reasoning at all.
The profile therefore fixes the vocabulary and leaves the reasoning intact: **simplify the
words, never the argument.** Dropping a caveat to shorten an answer is a failure of the
profile, not a success of it.

**Five rungs.** The person picks one; it is the only level the profile sets. The rungs *are*
the sensible pairings of the two axes, so nobody sets two numbers.

| # | Reader | Systems | Vocabulary | What changes |
|---|---|---|---|---|
| 1 | Senior programmer | high | high | Paths, section refs and jargon as shorthand; the mechanism is assumed |
| 2 | Entry-level programmer | medium | medium | Code and git basics assumed; deeper mechanics named and explained |
| 3 | Engineer or specifier, not a programmer | high | low | Full reasoning, each software term defined in a few words as it is used; no analogies needed |
| 4 | Non-technical professional | medium | none | Analogies carry the mechanism; reasoning intact, no jargon |
| 5 | Outsider | low | none | The point and why it matters; mechanism dropped |

**Two modes, the same for everyone.** *Explaining* and *reporting* differ in structure, not
in register, so they are house rules rather than profile settings: explaining leads with the
answer and follows with the mechanism; reporting leads with what it means for the reader,
states risk, names cost, and reaches mechanism only if a decision turns on it. A rung-1
reader gets the same reporting *shape* as a rung-4 one, in different words. The first draft
of this table had six rows, splitting "engineer, not a programmer" from "technical manager /
PM"; running the interview on the reference host showed they are one rung in two modes, not
two rungs, and the row was merged.

**How a person arrives at a rung.** Not by self-assessment, which fails in both directions
and fails *silently* upward: a reader pitched too high does not notice a missed point, they
feel vaguely lost, which is the state this section exists to end. `/profile` therefore
interviews rather than asks, in three steps whose order is deliberate — a vocabulary check
(lines of marker terms, answered as *which can you explain to someone else*, never as where
you stopped, because reporting a deficit biases the instrument upward), two reasoning
questions carrying no software vocabulary at all (which is what separates "doesn't know the
words" from "can't follow the argument", the distinction the single-axis ladder destroys),
and last a read-and-pick pass over worked samples, which outranks the other two because it
is the product rather than a proxy for it. Three constraints on the instrument, each found
by running it on a live subject rather than by review: a marker question asks what a person
*can* do, a reasoning question poses a situation and asks for a judgement rather than
stating a claim and asking whether it was obvious, and **a worked sample defines every term
it uses** — a sample drawn from this pipeline measures familiarity with the pipeline, and a
reader who cannot tell whether they are lost on the writing or on the subject will blame
themselves. The rung is a default, not a contract: any person may override it for one answer
mid-session, and a repeated override in one direction is the signal to edit the profile
rather than keep overriding.

**Fixed for everyone; a profile may not switch these off.** Say explicitly whether anything
is at risk, *including when nothing is*. Lead with the answer. Ask for one decision at a
time. These are safety properties of the review gate (3.3, 5), not taste: the risk line is
what decides whether a human looks harder at a PR, and a profile trimmed for brevity would
remove it first. **Free per person:** the rung, how much mechanism is wanted, whether
analogies help, tolerance for length.

**The profile outranks the repo's own register**, stated because the default resolution goes
the other way. An agent reads this document and `CLAUDE.md` — thousands of lines of dense,
clause-heavy prose — and then writes a reply; demonstrated register beats a stated
preference unless something says otherwise. Nothing did, which is why a correctly-written
profile could sit loaded in every session and change nothing observable. `CLAUDE.md` now
states the precedence, and the template states its preferences as checkable rules rather
than adjectives: "plain language" gives an agent no way to tell whether it complied, and an
instruction that cannot be self-checked loses to one that can be copied.

**What can be checked and what cannot.** That a profile exists, that it is not an unfilled
copy of the template, and that it names a rung are all mechanical, and belong in a
Docker-free host check that reads the person's own home directory and nothing else. That an
answer actually landed at the right rung is not checkable by anything, which places this
work on the same footing as the dashboard's page (change-log row `live-dashboard-page`): a
frozen test can pin that a page is self-contained but not that it is legible, so the writing
half is interactive work and the presence half is the only part a pipeline task can own.

### 6.2 Parallel working sessions (one worktree each)

The other half of the same host input: the person runs several interactive agent sessions at
once, one per idea, and until now every one of them pointed at the same checkout. Three
sessions in one folder are not three workspaces — they are three agents typing into one set
of files with one staging area between them, and git has no concept that could tell their
work apart. **Each interactive session gets its own git worktree**: its own folder, its own
branch, one shared history. `scripts/worktree.js` creates, lists and removes them;
`docs/parallel-sessions.md` is the working guide.

This is host-side working practice, not pipeline machinery, and it is stated here for the
reason §6.1 is: something the person supplies on their own machine, that no clone carries,
and where getting it wrong corrupts the record the rest of this document depends on. It is
also strictly an *interactive*-session concern. A task container already has its workspace to
itself by construction (§4.3) and the runner already clones per task, so nothing below
changes anything about how a run executes.

**Why isolation and not discipline.** The failure is neither hypothetical nor exotic. A
session ran `git add -A` and committed; git stages the *folder*, so four files belonging to
another session went into that commit under a message about something else. Nothing was lost
and the history was still wrong, which is the worse half — a corrupted record is read by
every later session, agents included, as fact. Separately a session ran `git checkout --
<path>` to test a hypothesis against a file another session was editing; uncommitted work has
no copy anywhere, so the only thing between that and permanent loss was timing. Both are the
*correct* behaviour of the commands involved. Rules against them are worth writing (CLAUDE.md,
"Commit hygiene") and they are also the layer that fails at the fourth session at 11pm,
because they ask an agent working at speed to reason about folders it cannot see. A worktree
removes the shared object rather than guarding it: `git add -A` in one folder cannot reach
another's files, because they are not there.

**What is shared and what is not, verified rather than reasoned.** A worktree checks out
*tracked* files only, so every git-ignored path — local config, secrets, build caches — is
absent from a new one. Three consequences settle the design:

* **The Beads database is shared, and that is the load-bearing result.** Beads resolves its
  database through git's *common directory*, so every worktree reads and writes the one
  database in the main checkout: `bd count` agrees across folders, and running `bd` in a
  worktree creates no second database there. Hard rule 1 therefore survives worktrees
  unchanged — the host is still the only writer to *one* queue, and N sessions do not mean N
  queues. Had it gone the other way the queue would fork along the same seam the code does,
  which is precisely what hard rule 1 exists to prevent, and this section would have had to
  mandate a shared database explicitly. It does not, because Beads already does it. The
  concurrent-writer question that follows is not new: it is the one change-log row
  `live-queue-feed` sized and dismissed on evidence, the operator/working split having
  already put two host processes on `bd`.
* **`runs/` must never be duplicated, and the tool refuses it by name.** `runs/locks/` holds
  the local observer mirror of §4.12's host-global lock; a second copy gives local readers a
  false ownership view. It is also where every manifest and
  report lands, so a run launched from a worktree writes its history where `verdict.js`,
  `batch.js`, `audit-runs.js` and the dashboard will never look — it would work, and its
  results would be invisible. Hence the rule: **runs are launched from the main checkout
  only**, which is what the operator/working session split already does in practice.
* **Everything else host-only is declared, not remembered.** `.worktree-carry` at the repo
  root names the git-ignored paths a new worktree should be given, and `new` reports what it
  carried, what was missing and what it refused. The alternative — a session discovering a
  missing `.sanitize-denylist` as a suite that quietly skips its project-specific checks — is
  a silent weakening of a gate, which §4.4's reasoning rules out anywhere it can be ruled out
  cheaply.

**What the tool refuses.** `remove` will not delete a worktree holding uncommitted changes,
*untracked files*, or commits on no remote, and it names what it found. Untracked is not a
detail: an uncommitted new test file is exactly the work the incident swept up, and the
obvious dirtiness check (`git diff`) cannot see it. The branch outlives the folder
deliberately — deleting a branch is a second irreversible act belonging to whoever merged the
PR, and a tidy-up tool that also deletes branches is the original hazard in a new hat.
`--force` exists, does what it says, and is the only path that destroys work.

**Where the folders live, and why that is a design question at all.** They sit inside the
main checkout, under one git-ignored container directory, rather than beside it. Nesting was
refused originally for a specific and correct reason: a worktree inside the repository puts
every one of its files into the parent's `git status` as untracked, which is precisely the
noise that gets `git add -A` typed and so re-creates the incident this section exists to
prevent. Ignoring one directory answers that reason at its root, and the cost of the
alternative grows with the thing being designed for — twenty sibling folders spread through
the person's projects directory, every one of them a copy of this project, is unusable in a
different way. So the allowance is made **conditional on the ignore actually being in place**,
asked of `git check-ignore` rather than inferred from the folder's name: a repository that
stopped ignoring the container directory would otherwise bring the original hazard back
silently, and the tool refuses to create anything there instead. The layout is a default, not
a constraint — an explicit root still places a folder outside the repository, keeping the
repository's name in the folder's, because a folder beside unrelated projects has to say which
project it belongs to.

That choice has one consequence the guard below has to answer for. A session folder is inside
the repository and the repository ignores it, so "would git track this file?" — the question
that decides whether a write in the main checkout is safe — answers *no* for every file in
every session folder, and would wave through exactly the collision the folders exist to
prevent. The guard therefore learns the other folders from git's own worktree registry rather
than from the ignore rule or a naming convention, which is also what makes it correct for the
sibling layout and for any future rename of the container directory.

**Why the folder rule is now enforced at the write.** Everything above makes the collision
impossible *once a session is in its own folder*, and says nothing about how it gets there.
That step was prose — this section, `docs/parallel-sessions.md`, and three lines in
CLAUDE.md — and prose is advice a session weighs against the task in front of it. The
specific way it loses is a session handed a change it judges too small to be worth a frozen
spec and a run: the pipeline is the expensive path, the file is right there, and editing the
shared checkout is locally the reasonable act. At two sessions that is usually survivable. At
twenty it is the ordinary case, and the same three failures return in full — one file
overwritten with no conflict raised, `git add -A` sweeping nineteen sessions' work into one
commit, and one branch per folder so no one change can be reviewed or reverted on its own.
`scripts/session-guard.js` moves the rule from the reader to the write: in the main checkout
it refuses a write to anything git would track, names the one command that fixes it, and
leaves every host-only path — `runs/`, the local configs, everything `.gitignore` covers —
writable, because those are what the operator session legitimately writes and none of them
merge. Inside a worktree it refuses only the reverse reach back into the shared checkout, and
the work-destroying commands, everywhere.

Three properties do the load-bearing work, and each is a consequence of what the thing is
for. It **judges the write, not the tool**: a `sed -i` or a `>` redirect is checked exactly as
the file-editing tool is, because an agent steered towards shell commands reaches for
`sed -i` first, and a guard watching only file tools would enforce nothing in precisely the
configuration it was built for. It **fails open** — an unparseable command, a missing `git`,
its own crash, all allow the write — because a checker that fails closed stops twenty
sessions on its first bad day and is uninstalled that afternoon, after which nothing is
watching at all; the reasoning that makes §4.4's gates fail *closed* inverts here, because
this one guards working practice rather than publication, and its adversary is inattention
rather than a wrong result reaching `main`. And its allowlist **is `.gitignore`**, read
through `git check-ignore` rather than restated, so it cannot drift from the file that
already answers "would this merge?" — the second-source rule applied to a checker.

**Text is not a command, and the distinction is the whole reason this layer replaced
something.** The check it supersedes on the reference host matched its banned commands as
plain substrings, which refused `rm -rf /tmp/scratch` for containing `rm -rf /` and refused
any command line whose *text* merely mentioned one of them — including, on its first
encounter with this work, the act of writing this repository's own pull-request description,
whose body contains a table listing the commands being blocked. That is not a cosmetic
defect. A guard that is confidently wrong on ordinary work is a guard that gets switched off,
and a switched-off guard is indistinguishable from one that was never written. So every rule
here reads parsed words, and here-document bodies are dropped before parsing: a document
being written is data, whatever it says. The introducing line survives that, so a document
redirected *into* a tracked file is still judged on where it lands.

A second consequence of replacing that check: it applied to every project on the machine,
and this one, by design, says nothing in a repository that does not carry it. Retiring the
old one as-is would therefore have removed force-push and delete-your-home protection from
every other project on the host — a regression with no symptom until the day it mattered.
The refusals that are about the *machine* rather than about a project therefore live in the
guard but are evaluated before any repository question, and the installer places a copy of
the guard beside the bridge to answer in folders that carry none. A project's own copy still
wins, so a project can evolve its policy. The off marker exempts the folder rule and nothing
above it; it was never meant to exempt formatting a disk.

It is a guard and not a sandbox: a session determined to route around it can, and that is not
the failure mode it exists for. Its enforcement point is therefore host-side and
harness-specific, which is why the rule itself is a dependency-free script speaking its own
vocabulary, and the small bridge that translates one agent CLI's tool-call hook is installed
rather than committed. Committing that bridge's *configuration* would put it in every task
container, where there is no agent CLI and no network for it to run in — the boundary
`tests/unit/agent-hooks.test.js` holds, and which a checklist step has already lost once.

**Where this meets the dispatch gate.** A spec frozen on a worktree branch is not on the
branch containers fork from, so §4.12's second admission rule refuses that task until the
branch is merged and pushed — correctly, and now more often, since parallel sessions leave
more unmerged freeze branches outstanding at any moment. The remedy is the one already in the
outcome contract (freeze, PR, merge, run), plus feeding for a run already in flight. No gate
changes.

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
burn the usage window; the success scenario may run either a stub or the real model. The
harness refuses a dirty fixture checkout before any mutation, and remote cleanup authority
is limited to branches derived from those three fixture issue IDs (plus numeric retry
suffixes). A repository-wide `task/*` glob is not ownership evidence. Host commands,
configuration fields, fixture identity, the Docker daemon, and both required images are
pre-mutation prerequisites: the harness does not reset, update Beads, or push a receipt
until every one is proven available.

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
`concurrency` in `run.config.json`, default 1 and originally capped at 3 (the cap was lifted
by change-log row `concurrency-uncapped`; any whole number ≥ 1 loads), over a bounded worker pool
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
decided in this doc (the 4.11 contract, `status.schema.json`, `verify.schema.json`,
`run.schema.json`, `events.schema.json` — §4.12, written by the runner and read by tools
built separately from it — the 4.10 input contract incl. the `/pipeline` mount and
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

The rows themselves live in **`docs/change-log.md`**, not in this section: this section is
the convention, that file is the log. Append a new row at the bottom of it.

The split is what makes parallel work cheap. An append-only table can be marked
`merge=union` in the repo-root `.gitattributes`, and two task branches that each add a row
then merge with no conflict — where before, the first merged free and every other one waited
for a person to give the answer that was always going to be *keep both*. The attribute is
safe on that file and on no other: rows are appended and never edited, whereas this
document is amended in place, so pointing union at `DESIGN.md` would silently keep both
copies of an amended paragraph instead of asking. Union merge cannot detect two branches
rewriting one row — it keeps both — but that shows up as a duplicate `Ref`, which
`scripts/test-changelog.sh` fails on.
