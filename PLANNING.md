# PLANNING.md — The Planning Session Playbook (V1)

This is the interactive planning session from DESIGN.md §3.2, as a playbook the user and
Claude follow together before every pipeline run. In V2 this becomes the `/spec` skill;
until then, this document *is* the planning tooling. Its job: turn intent into frozen,
machine-checkable task specs that the autonomous implementation phase can execute without
ever needing to ask anyone anything.

Two rules frame everything below (§2, §3.3):
- **Planning is always interactive.** Specs and tests are written with the user, never
  during a run. Nothing that happens during a run can change what "done" means.
- **The user approves *what*; the AI owns *how it's verified*.** The user reads the
  plain-English intent and confirms it. Claude writes the tests — before any code exists —
  so they encode intent, not whatever the code happens to do.

## Prerequisites (once per target project)

These are done by the onboarding checklist — `ONBOARDING.md` in this repo (or the
`<the ONBOARDING.md checklist>` skill, which follows it). Verify, don't redo:

- The target repo has a GitHub remote and `pipeline.config.json` in its root (§3.4):
  `verifyCommand`, optional `regressionCommand`, optional `defaultBranch` (record it if
  the repo's integration branch isn't `main` — e.g. the shadow-trial project uses `master`), optional
  `frozenPaths`, and `dependencies`.
- A thin per-project Dockerfile sits beside it, `FROM` the pinned base image (§6).
- Beads is initialized in the host working copy (`bd init`; see `beads/issue-template.md`).
- The base image is built (`docker/base/`, checks: `scripts/test-base-image.sh`).

## The Session, Step by Step

### 1. Draft the spec
For each candidate task, draft the five spec fields (§3.1, mapping in
`beads/issue-template.md`):
- **Description** — what this task delivers, plain English.
- **Constraints** — what the implementation must not do or must respect.
- **Acceptance criteria** — the "Done means" list: 3–6 concrete, machine-checkable
  outcomes. Each must be verifiable by a script or test with no human judgment
  ("`verify.sh` exits 0 and the branch exists", never "works well").
- **design-ref** — the design-doc section this task implements. Mandatory: a task that
  cites nothing is scope creep (§3.1).
- **Attempt log** — starts empty; the runner appends to it during runs.

Label the task **trivial / medium / hard**, and split anything bigger than one PR the
user can review in a few minutes (§3.2). Note dependencies between tasks. The label is
a proposal — it appears in the approval pass (step 5) and the user may change it, since
it decides how much critique the spec receives.

### 2. Run the critics, sized to the difficulty label
Critic effort scales with difficulty (§3.2) — in V1 the "critics" are fresh-context
Claude reviews (subagents or a fresh session), not tooling. Each one is run by pasting a
charter from [`advisors/`](advisors/README.md) verbatim as the review prompt, together
with the draft spec; the charters are written for a reader with no session history, so
give each critic its own fresh context and don't summarise the discussion that produced
the spec:
- **trivial** — no critics; go straight to tests.
- **medium** — one light pass, normally [`advisors/testability.md`](advisors/testability.md)
  ("which acceptance criteria are ambiguous or not actually machine-checkable?"), since
  untestable criteria are the failure that most often survives review.
- **hard** — the full panel, each as an independent review:
  [`advisors/ambiguity.md`](advisors/ambiguity.md) (where would two engineers build
  different things?), [`advisors/testability.md`](advisors/testability.md) (which criteria
  can't a script verify?), [`advisors/scope.md`](advisors/scope.md) (is this secretly
  several tasks?).

Each critic returns one JSON object — `advisor` / `verdict` (`ok`, `concerns`, `error`) /
`summary` / `details[]` — the same shape as an `advisories` entry in the status file.
**A critic never gates** (§3.5): `concerns` is a list of decisions for you and the user,
not a veto. Revise the draft against the critiques before showing it to the user.

### 3. Write the acceptance tests
Claude writes the tests **now, before any code exists**, from the spec alone (§2, §4.4):
- They live at `tests/acceptance/<issue-id>/` in the target repo (§3.1) — create the
  issue id first if needed by doing step 6 early, or use a placeholder directory and
  rename after step 6.
- They must run via the project's `verifyCommand`, which the verifier invokes as
  `<verifyCommand> tests/acceptance/<issue-id>/` (§3.4).
- "Tests" means machine-checkable evidence broadly: unit tests, build-succeeds, a command
  producing expected output on sample input, a smoke check hitting an endpoint.

### 4. Coverage check
Pair them up (§3.2): every acceptance criterion names the test that proves it; every test
names the criterion it serves. **An orphan on either side is a spec bug** — fix the spec
or the tests before going further, never during a run.

### 5. The user approves intent
Write the drafted specs to **one reviewable file in the repo** —
`docs/planning-draft-<YYYY-MM-DD>.md` — so the user has a single, findable thing to
read (never a scratchpad or chat-only summary; the file is superseded by the Beads
issues at freeze, like `docs/v1-backlog-draft.md`). The user reads the plain-English
spec — description, constraints, acceptance criteria in "Done means" form, and the
difficulty label — and says whether it matches what they want. Adjust until yes. For a
backlog decomposed from a design doc, this is a single list pass checking the slicing,
not a re-litigation of intent (§3.3).

**Developers may go deeper (§3.3):** the plain-English criteria are the required gate,
but the actual test files from step 3 are open for inspection — a developer who wants
to read or challenge the tests before they freeze should; a user who prefers to approve
the prose alone may. Claude offers, never insists.

**Nothing is frozen and nothing runs until this approval.**

### 6. Freeze
On approval, in the target repo:
1. Commit the acceptance tests **to the project's integration branch** (its
   `defaultBranch` — §3.4; `main` only if none is configured) and push. Frozen means:
   the test paths as they exist at the task branch's fork point from that branch —
   `git merge-base <defaultBranch> <branch>` (§3.1). Since task branches fork from the
   integration branch at run time, tests must be on it before the run; the verifier
   diffs **all of `tests/acceptance/`** plus the config's `frozenPaths` against the
   fork point and treats any difference as tampering (§4.4).
2. Create the issue with all five fields via the wrapper (refuses a missing design-ref):
   `scripts/new-issue.sh -t "<title>" -d "<description>" -c "<constraints>"
   -a "<acceptance>" -r "<design-ref>" [-p 0-4] [-D dep-id,dep-id] -C <target-repo>`
3. Set priority (0 = highest; the runner drains the ready queue priority-first, FIFO
   within ties — §4.12) and dependencies (`-D` — the ready queue is blocker-aware).
   **Priority and dependency order are the user's call** — Claude proposes an order
   with reasons; the user decides. This, plus which issues exist and are unblocked, is
   how the user chooses what a run works on: the runner has no picker of its own, it
   drains the queue the user shaped (verified with `bd ready` in step 8).

### 7. Declare dependencies and rebuild the image
If the task needs a package the image doesn't have (§3.4, §4.8 — containers cannot
install anything at run time):
1. Add it to `dependencies` in `pipeline.config.json` — **package lists keyed by package
   manager** (e.g. `{"apt": [...], "npm": [...]}`), **never arbitrary install commands**.
2. Update the thin per-project Dockerfile to install it, and **cross-check the Dockerfile
   against the manifest** — they must not drift (§3.4).
3. Rebuild the per-project image — **a manual step, done now, in this session** (§3.4).
   The runner only asserts the image exists; it never builds.

### 8. Pre-run checklist
- `bd ready` (in the target repo's working copy) lists exactly the tasks meant to run,
  in the intended priority order. An **epic** may appear in that list and is expected to —
  `bd ready` returns the parent alongside its children — but the runner filters entries
  typed `epic` out and names them in its `ready queue:` log line (§3.1, §4.12). Every
  other type (`bug`, `feature`, `chore`, `decision`) *does* run, so anything in the list
  that is not meant to run this batch must be blocked or closed, not merely retyped.
- Frozen tests are on the integration branch (`defaultBranch`) and pushed;
  `pipeline.config.json` is current.
- The per-project image exists; Docker Desktop is running.
- Anything the task needs to *know* (API details, conventions) is in the repo or attached
  to the issue — the container has no internet beyond the Anthropic endpoints (§4.8).

Then start the runner. From here the implementation phase is autonomous; the next human
touchpoint is the run report (§5).

## Spec Changes After Freeze

A spec change **reopens the approval gate** (§3.3): re-run the relevant steps above,
get fresh user approval, re-freeze the tests on the integration branch. An agent reporting "the spec is
wrong" during a run is a first-class result that lands in review — never a reason for
anything to edit specs or tests mid-run. If the cause is architectural, amend the design
doc (change-log row) so the doc never silently drifts from reality.

A change-log row is identified by a **slug** in its `Ref` column, never a version number:
a row a pipeline task produced takes that task's issue id, and a row a planning session
produced takes a short descriptive kebab-case name. Versions could not survive parallel
work — agents fork from a base where a number is free and two rows arrive claiming it —
so identity moved to a value the host already assigns uniquely. Cite a row by the pinned
phrase change-log row plus the slug in backticks, and run `bash scripts/test-changelog.sh`
after editing the log (Docker-free, seconds).

## What "Done" Is (and Isn't)

This playbook's own acceptance bar is structural — the checks in
`scripts/test-planning-playbook.sh` verify every step and convention above is present.
Whether the playbook is *followable* is proven by the shadow-mode trial (§7), where its
failure notes become the requirements list for the V2 `/spec` skill.
