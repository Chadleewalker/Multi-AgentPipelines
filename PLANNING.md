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

These are done by the onboarding checklist — `ONBOARDING.md` in this repo. Verify, don't
redo:

- The target repo has a GitHub remote and `pipeline.config.json` in its root (§3.4):
  `verifyCommand`, optional `regressionCommand`, optional `defaultBranch` (record it if
  the repo's integration branch isn't `main` — e.g. the shadow-trial project uses `master`), optional
  `frozenPaths`, and `dependencies`.
- A thin per-project Dockerfile sits beside it, `FROM` the pinned base image (§6).
- Beads is initialized in the host working copy (`bd init`; see `beads/issue-template.md`).
- The base image is built (`docker/base/`, checks: `scripts/test-base-image.sh`).

## The Session, Step by Step

### 0. Read the idea inbox and the open threads
Open [`docs/IDEAS.md`](docs/IDEAS.md) — in *this* repo when the session is about the
pipeline, in the target project's repo otherwise — and see whether anything parked there
belongs in this session. It is where "that's probably a good idea" gets written down
between sessions, so it is the only place a candidate can be waiting that nobody has
mentioned out loud.

Nothing there is a commitment and nothing there is obliged to be picked; an inbox entry is
a reminder that a design might be wanted, never a spec in waiting. An idea that *is* picked
goes through the whole path like anything else — a `DESIGN.md` section and its change-log
row first, then step 1 below — because an idea implemented straight from the inbox cites no
design section, which is the definition of scope creep (§3.1). When one graduates, move it
to the file's **Promoted** table; when the session concludes one is not wanted, move it to
**Dropped** with the reason, so it doesn't come back every few months.

Then open [`docs/threads/`](docs/threads/README.md) — same repo, same rule — and read any
thread whose header says `status:   ready`. A thread is an idea *being worked*: one file
holding its question, current thinking, the decisions already taken and by whom, and what
is still open (DESIGN.md §3.8). A `ready` thread is a candidate that arrives with its
design decisions already made and its open questions already named, which is strictly more
than an inbox entry offers — and costs this session nothing to skip, since a thread is no
more a commitment than an inbox entry is. `open` and `parked` threads are not this
session's business unless the session is about to work one.

```bash
grep -l "^status:   ready" docs/threads/*.md      # run from the repo the session is about
```

When a thread graduates, its slug is already the change-log ref (§3.8), its status becomes
`promoted`, and its `Outcome` names what it became; a thread the session concludes is not
wanted becomes `dropped` with the reason. Either way the file stays — deleting it throws
away the reason, which is the only thing that stops the idea coming back.

Then run the drift report against the target (change-log row `trace-ledger`):

```bash
node scripts/trace.js report        # run from the target repo's root
```

It lists ticked spec boxes no issue witnesses, refs to issues git has never seen, and
merged work no box records — the checklist audit this step otherwise does by hand, and the
mechanism that catches a session about to be cut against a false picture. A finding is a
candidate for this session, never a verdict; `backfill` (same script) recovers missing
refs from history when the convention was skipped.

### 1. Draft the spec — in two halves, in different contexts
The five spec fields (§3.1, mapping in `beads/issue-template.md`) are **not all drafted the
same way**. Intent needs the session's history; criteria need the code.

- **1a. Intent, here in session.** Description, constraints and `design-ref` come out of the
  discussion, as they always have.
- **1b. The "Done means" list, in fresh context, against the code.** Open a fresh subagent
  or session, have it read the implementation the criteria will touch, and write the
  acceptance criteria there — not from what you remember the code doing.

**Why the split** (§3.2, "Below the panel", move 5): in the first full panel run on a real
backlog, every strong finding came from a critic doing archaeology in the implementation.
The critics were not smarter than the drafter; they were unprimed and reading the code,
while the drafter was many specs deep in one sitting. Doing that reading *before* the
criteria are written moves the same work upstream of the panel, where it is cheaper. The
cost is one context switch per spec and no tooling.

The five fields:
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

#### A pure refactor cannot be frozen

Ask this while you are still sizing the candidate, **before writing a single criterion**:
*name one input whose observable answer differs before and after.* If you cannot — if every
caller, every file on disk and every exit code is unchanged by construction — the task has
no **behavioural signature**, and nothing later in this playbook gives it one.

A pure refactor is the standard case. Two implementations that agree, and one that delegates
to the other, are indistinguishable from outside, so the only criterion available is an
assertion about the source text — which goes red on the next legitimate refactor and is
therefore gating the wrong thing. Such a task cannot be frozen: its criteria are all guards,
they are all green at the fork point, and the freeze gate in step 4 will refuse it at exit 1
— but only after the criteria have been drafted in fresh context and a critic panel has read
them. Asking the question here costs one sentence instead of a planning cycle.

**The answer is not to abandon the work.** Fold the refactor into a later task that has a
behavioural reason to touch the same code: that task carries a criterion that can genuinely
fail, the refactor rides inside its diff, and the frozen tests judge the behaviour both of
them share. Until such a task exists, park it in `docs/IDEAS.md` (step 0) with what it would
improve and which code it touches — an inbox note commits to nothing, and it is where the
next session sizing that area will look.

### 2. Run the mechanical checks, then the critics

**First, the lint — it costs nothing and needs no judgment (§3.2, move 3):**

```bash
node scripts/spec-lint.js --repo <target-repo> <draft-spec-file>
```

It reports any line naming a path in the target's `frozenPaths`. Such a criterion orders
the agent to edit a file the verifier diffs against the fork point, so the task ends
`tampered` on **every** attempt, before any test result exists — two drafts in the first
real panel run did exactly this. Exit codes: `0` clean, `1` findings, `2` could not run
(a `2` is never a pass — it means the lint never looked).

The acceptance directory is deliberately *not* flagged: planning writes tests there, so
naming it is normal. Findings are reported, not enforced — each one takes a disposition
below, the same as a critic's.

**Then the critics — the label decides depth, never existence.**
Critic effort scales with difficulty (§3.2) — in V1 the "critics" are fresh-context
Claude reviews (subagents or a fresh session), not tooling. Each one is run by pasting a
charter from [`advisors/`](advisors/README.md) verbatim as the review prompt, together
with the draft spec; the charters are written for a reader with no session history, so
give each critic its own fresh context and don't summarise the discussion that produced
the spec:
- **trivial and medium** — one pass, normally
  [`advisors/testability.md`](advisors/testability.md) ("which acceptance criteria are
  ambiguous or not actually machine-checkable?"), since untestable criteria are the failure
  that most often survives review.
- **hard** — the full panel, each as an independent review:
  [`advisors/ambiguity.md`](advisors/ambiguity.md) (where would two engineers build
  different things?), [`advisors/testability.md`](advisors/testability.md) (which criteria
  can't a script verify?), [`advisors/scope.md`](advisors/scope.md) (is this secretly
  several tasks?).

**There is no zero-critic tier, and `trivial` does not exempt a spec from review.** The old
rule did exempt it, and the exemption was self-referential: the difficulty label is chosen
by whoever drafted the spec, before any review, and the critic whose charter includes
checking whether the label fits is the scope critic — the one the label skips. A spec
labelled `trivial` by a drafter who misjudged it received exactly no review of that
judgement (§3.2, "Below the panel", move 2).

**Batching:** two *closely related* specs may go to one critic, which roughly halves the
cost where they share a subject. It is not free — both are then seen through one lens, so a
blind spot common to both survives. Never batch unrelated specs to save money.

Each critic returns one JSON object — `advisor` / `verdict` (`ok`, `concerns`, `error`) /
`summary` / `details[]` — the same shape as an `advisories` entry in the status file.
**A critic never gates** (§3.5): `concerns` is a list of decisions for you and the user,
not a veto. Revise the draft against the critiques before showing it to the user.

**Record a disposition for every finding.** One line per `details[]` entry, carried into
the planning draft at step 5: **accepted** (and what changed), **rejected** (and why), or
**deferred** (and until what). A finding that is silently dropped is indistinguishable from
one that was considered and rejected, and the difference matters most at the hour when
specs actually get skipped. This is the only thing that makes the panel auditable — a
critic that never gates leaves no other trace (§3.2, move 4).

### 3. Write the acceptance tests
Claude writes the tests **now, before any code exists**, from the spec alone (§2, §4.4):
- They live at `tests/acceptance/<issue-id>/` in the target repo (§3.1) — create the
  issue id first if needed by doing step 6 early, or use a placeholder directory and
  rename after step 6.

  **If you use a placeholder, the directory is not the only place it leaks.** The
  acceptance criteria you draft alongside the tests will cite the placeholder path too, and
  renaming the directory does not rename the citation — so the issue tells the agent to look
  somewhere that does not exist. Caught by a task agent that read its own criteria, noticed
  the directory they named was absent, and filed a spec concern *specifically so the same
  copy-paste would not reach the next four tasks* — where an agent trusting the criteria line
  could reasonably conclude its tests were missing. Creating the issue first (step 6 early)
  avoids the class entirely; if you do use a placeholder, grep the criteria for it before
  freezing.
- They must run via the project's `verifyCommand`, which the verifier invokes as
  `<verifyCommand> tests/acceptance/<issue-id>/` (§3.4).
- "Tests" means machine-checkable evidence broadly: unit tests, build-succeeds, a command
  producing expected output on sample input, a smoke check hitting an endpoint.

### 4. Coverage check, then prove the tests can fail
Pair them up (§3.2): every acceptance criterion names the test that proves it; every test
names the criterion it serves. **An orphan on either side is a spec bug** — fix the spec
or the tests before going further, never during a run.

Then run the freeze gate (§3.2, move 1) — **before** the approval pass, so a test that
cannot fail is caught before the user signs off on it:

```bash
node scripts/freeze-gate.js --repo <target-repo> \
  --tests tests/acceptance/<issue-id>/ --spec docs/planning-draft-<date>.md
```

The tests exist and the implementation does not, which is exactly the state a task branch
forks from — so **they must be red**. A test green here is satisfied by an empty diff: it
would pass a correct submission, a broken one, and no submission at all.

- **exit 0 — red.** The tests discriminate. Proceed.
- **exit 1 — green.** A spec bug. Either the criterion is not discriminating and needs
  rewriting, or it is a **guard** ("existing behaviour X still holds"), which is legal but
  must be labelled `[guard]` in the spec. The gate counts labelled guards and prints the
  count; that count belongs in the approval pass, so a spec that is all guards is visible
  rather than silent.
- **exit 2 — could not tell.** The command also fails against the **control**
  (`tests/acceptance/_control/`, one trivially-passing test committed at onboarding), so its
  exit code says nothing about *these* tests — the harness is broken independently of the
  spec. Its own bug, and **never** a pass. Fix it and re-run.
  If the project has no control fixture the gate says so in its report and falls back to
  probing with an empty directory, which proves very little: a good runner is *supposed* to
  fail when it finds no tests. Add the fixture rather than reading anything into that.

A pure refactor's only honest criteria are guards, which is why they are labelled rather
than forbidden — and a spec that is *nothing but* guards is the sign that the task has no
behavioural signature at all (see `docs/IDEAS.md`). That is a spec bug of a different kind:
rewriting the criteria does not help, because there is nothing discriminating left to write.
See [**A pure refactor cannot be frozen**](#a-pure-refactor-cannot-be-frozen) in step 1 for
the question that catches it before drafting, and for what to do with the work instead.

### 5. The user approves intent
Write the drafted specs to **one reviewable file in the repo** —
`docs/planning-draft-<YYYY-MM-DD>.md` — so the user has a single, findable thing to
read (never a scratchpad or chat-only summary). The draft is **superseded by the Beads
issues at freeze**: the issue is the canonical spec from then on, so the snapshot is
disposable and can be deleted once the tasks have run. The user reads the plain-English
spec — description, constraints, acceptance criteria in "Done means" form, and the
difficulty label — and says whether it matches what they want. Adjust until yes. For a
backlog decomposed from a design doc, this is a single list pass checking the slicing,
not a re-litigation of intent (§3.3).

**The draft carries the panel's dispositions.** Every critic finding from step 2 appears in
this file with what was done about it — accepted, rejected with a reason, or deferred. The
user is approving intent, not auditing reviews, so this is not something they have to read;
it is there so that "the panel raised nine things and all nine were handled" is a claim
anyone can check later instead of taking on trust.

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
- **Last act: write the batch marker** (§3.9) — one JSON object at
  `runs/batches/<project>-<YYYY-MM-DD>.json` **in this repo** (git-ignored; never in the
  target's tree, since it names a project and its issue ids). Required keys: `runConfig`
  (the `run.config.<project>.json` the launch will type), `frozenAt` (an **instant**, e.g.
  `2026-08-19T21:40:00Z` — a bare date cannot be compared with a run's UTC `startedAt`),
  and `issues` as `[{id, title}]` in the intended priority order. Optional and printed when
  present: `integrationBranch`, `freezeCommit`, `intent` (one line in the user's words) and
  `approvedBy` (hard rule 4's split). Write it here, in this session, while you still know
  the answers — the launch only ever reads. The marker is **immutable and never a queue
  item**: nothing stamps it launched, and nothing in `runner/` or `pipeline/` reads it.
  Confirm it with `node scripts/batch.js show`, which prints the marker and, per id,
  `worked` or `not-worked`. It also prints `unreconciled bd-unavailable`: the check this
  step does by eye — *`bd ready` lists exactly these ids* — is **not yet automated**, so
  keep doing it by hand here.

Then start the runner. From here the implementation phase is autonomous; the next human
touchpoint is the run report (§5).

## Spec Changes After Freeze

A spec change **reopens the approval gate** (§3.3): re-run the relevant steps above,
get fresh user approval, re-freeze the tests on the integration branch.

**Re-freeze the ISSUE too, not just the test file.** Step 5 says the draft is superseded by
the Beads issue at freeze — so the issue is the canonical spec, and a re-freeze that amends
the test and leaves the issue prose alone makes the canonical spec disagree with the thing
that actually gates the run. Two tasks in one batch reported it: their criteria still said
"eight ladders" and "34 live cards" after the tests had been re-frozen at nine and 33. Both
agents inferred that the test was authoritative and were right, but they were guessing
against the playbook rather than following it, and the next one may guess the other way. An agent reporting "the spec is
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
