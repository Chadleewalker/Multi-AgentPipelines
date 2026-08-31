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

**Launch the test author from the generated brief.** The planning command computes the same
deterministic brief, creates or reuses the issue's dedicated worktree, and opens one headless
Claude session there with an explicit model alias:

```bash
node scripts/author-tests.js <issue-id> --config run.config.<project>.json
```

Every one of those six is already recorded — in the run config, the target's
`pipeline.config.json`, git's worktree registry and Beads — so none of them is retyped, and the
brief quotes the issue's own criteria rather than the planning draft that produced them. Set
the optional `testAuthorModel` in the run config when the test author should differ from the
implementation `model`; otherwise the launcher uses `model`. `testProbeModel` may pin the
separate green-probe agent and falls back through `testAuthorModel` to `model`; all aliases are
explicit argv values, never a global CLI selection. `testProbeAttempts` bounds the host-feedback
loop at three by default. `scripts/spec-brief.js` remains the read-only command for inspecting or
saving the brief without opening a session.

It works out which of three states the issue is in first, because the instructions differ:
write the tests, freeze a suite the working tree already holds, or re-gate one that is on the
branch without a readable receipt. The last two need no drafting at all, and a report that does
not separate them makes a nearly-finished task look like an untouched one.

The launcher does not treat a successful test-author exit as completion. It first refuses any
worktree change outside that issue's suite, then creates two independent disposable clones at
the author's exact HEAD and overlays the suite byte-for-byte into both. One remains the red
baseline. A separately pinned probe agent may edit product code in the other, with file tools
only — no shell, Git, Beads or freeze capability. After every attempt the host starts the gate's
verifier inside the project's configured image with no network, credentials, capabilities or
host mount other than that disposable clone, then feeds its evidence into the next bounded
 attempt. The whole acceptance tree, `pipeline.config.json` and every configured frozen Git
 pathspec are hashed before the agent and checked after both the agent and gate. Wildcard matches,
 ignored additions and file modes count, except two strict non-test shapes in another suite:
 a valid single-link regular untracked `.freeze-gate.json` receipt in the integration-target
 comparison only, and an ignored-and-untracked Godot `.gd.uid`
 sidecar beside its unchanged `.gd` companion. The receipt is parsed by the runner's own rule;
 staged, tracked, malformed, unreadable and symlinked receipts remain protected. The generated UID body is
 variable-width (one through thirteen engine-alphabet characters), not fixed-width. The suite
 under proof, malformed, orphan or tracked sidecars, and any uncertain Git query remain protected.
 Any changed protected byte is a refusal. A refusal is diffed against whichever of the clean base
 or proven tree is closer, so an expected suite awaiting promotion is not named as the concurrent change.

Only a gate exit 0 is a launcher success. The ownership-marked baseline and probe are retained,
and the reported human command includes `--probe <dir>` so the approved freeze re-runs the same
containerized two-direction proof without first changing the integration checkout. After that
gate passes and the protected bytes are rechecked, freeze transactionally promotes the exact
suite and receipt from the baseline; any pre-commit refusal restores the previous integration
tree. It rejects unrelated staged paths, builds the candidate commit from a private immutable
index, and pushes that exact object under a remote lease so concurrent work cannot ride along or
be overwritten. The launcher itself never calls `freeze.js`, commits, merges or pushes. Verifier containers
have resource limits and deterministic cleanup by an owned name/CID; clone ownership is recorded
outside the model-editable tree. Managed clones are removed only after freeze has pushed and the
runner has read the result back as dispatchable.

**Prepare a dependency-shaped backlog as one resumable planning batch.** Repeating the
single-issue launcher by hand is unnecessary when several approved specs are waiting. Name the
batch and its complete issue set once:

```bash
node scripts/prepare-batch.js start <batch> --config run.config.<project>.json \
  --issue <id> --issue <id> [--author-concurrency 1..10]
node scripts/prepare-batch.js status <batch>
```

The coordinator snapshots every issue, its dependencies, criteria, integration HEAD and
host-local run policy before it starts a worker. It reads Beads serially and uses the canonical
id returned by `bd show` for new suite and worktree paths. One unique exact legacy alias worktree
may be reused to preserve unfinished work; dual or ambiguous carriers fail closed, and a
published alias suite must be re-cut under the canonical path the runner dispatches. It then runs
at most ten test authors, both by default and at the hard maximum. Workers receive the immutable
snapshot on stdin; they cannot re-read Beads or choose another worktree. The same target-global
lock excludes a normal pipeline run and either standalone author/proof command while preparation
owns the target.

State is durable under `runs/preparations/<batch>/`. `resume <batch>` reports or continues work
whose ownership is unambiguous; a worker that may still be alive is never duplicated, and a
crash with no matching result becomes `interrupted-unknown` and blocks new preparation. Stop the
recorded worker and any descendants, then record that human check with
`acknowledge-interrupted <batch> <id>...`; only after that may `retry <batch> <id>...` start a new
attempt. A successful item means **proven at the recorded integration base**. The coordinator
never freezes, commits, merges, pushes, changes Beads, or turns blocked
implementation dependencies into test-author dependencies: specs may be prepared together, then
the ordinary Beads-ready runner releases their implementation waves in dependency order.

While a proof is running, the coordinator reports the current fixed stage (`prepare`, probe
agent, protected check, gate, final protected check, or marker write) and the elapsed time of each
completed stage. These messages are progress only; the durable worker result remains the sole
success record. Protected-tree scans use bounded multi-path Git hashing, preserving repository
attributes and clean filters while avoiding one Windows process launch per protected file.
Generated Godot sidecars are classified from one NUL-delimited ignore query and one complete
tracked-path snapshot rather than two Git children per candidate. Any incomplete, malformed or
failed bulk result keeps the uncertain paths protected rather than producing a partial manifest.

`allowHalfProven: true` is incompatible with this all-proven preparation posture and is refused;
change that run policy explicitly rather than asking the coordinator to weaken it. Human review
still follows. Because a freeze advances the integration HEAD, approved publication re-proves
each retained suite at the then-current HEAD and freezes it immediately, one at a time; an older
`proven-at-base` record is evidence, not permission to publish from a stale base.

A machine-specific path — a binary that is not on `PATH` — belongs in the run config's optional
`hostEnv`, never in the target's `pipeline.config.json`: run configs are host-local and
git-ignored, which is exactly where a path that is true on one machine should live. The brief
emits it as an `export` line. Nothing at run time reads it; a container gets its dependencies
from the image.
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
  --tests tests/acceptance/<issue-id>/ --green <probe-dir> \
  --spec docs/planning-draft-<date>.md
```

The tests exist and the implementation does not, which is exactly the state a task branch
forks from — so **they must be red**. A test green here is satisfied by an empty diff: it
would pass a correct submission, a broken one, and no submission at all.

**Red is only half the proof, and `--green` is the other half.** A suite that discriminates
and a suite whose own fixture is broken are *the same observation* — non-zero — so everything
in the paragraph above is satisfied by a suite no implementation could ever turn green. That
has cost two tasks three attempts each: one froze with 11 of 29 checks unreachable because a
preload stub killed the child process before its first line, and one froze with the criterion
the task existed for calling `git init -q -c …`, where `-c` must precede the subcommand, so no
repository was ever created and the two neighbouring checks passed *vacuously*. Both were
diagnosed by the task agent through the spec-concern channel, in a container, at attempt three.

So build a **probe**: a throwaway tree in which the criteria are *already satisfied*, by any
means however crude, and hand it to `--green`. It is not an implementation and nobody keeps it.

- **A probe is a REPO-SHAPED TREE, not a handful of files.** Every frozen suite resolves its
  own root as the tree it sits in, never the working directory, and `verifyCommand` is a path
  relative to cwd. So a probe carries the project's test runner at the same relative path,
  `tests/acceptance/<issue-id>/`, and `tests/acceptance/_control/` if the project has one. A
  directory holding only the criteria's artifacts yields "no test files" and a false *unreachable*.
- **A probe satisfies the criteria by changing the tree, never by editing a check.** The probe
  runs its own copy of the suite, so the gate hashes both copies first: a copy with a file
  *missing*, edited or added is named and refused before the probe runs. A probe that edits its
  judge would otherwise bless exactly the freeze this gate exists to prevent.
- **Crude is the point.** Hard-code the return value, write the file the test looks for, stub
  the command. If a criterion cannot be satisfied even by cheating, that is the finding.

- **exit 0 — red.** The tests discriminate. Proceed.
- **exit 1 — green.** A spec bug. Either the criterion is not discriminating and needs
  rewriting, or it is a **guard** ("existing behaviour X still holds"), which is legal but
  must be labelled `[guard]` in the spec. The gate counts labelled guards and prints the
  count; that count belongs in the approval pass, so a spec that is all guards is visible
  rather than silent — and a spec that is *nothing but* guards is a **pure refactor**, which
  is a spec bug of a different kind and cannot be fixed by rewriting the criteria. See
  [**A pure refactor cannot be frozen**](#a-pure-refactor-cannot-be-frozen) in step 1.
- **exit 2 — could not tell.** The command also fails against the **control**
  (`tests/acceptance/_control/`, one trivially-passing test committed at onboarding), so its
  exit code says nothing about *these* tests — the harness is broken independently of the
  spec. Its own bug, and **never** a pass. Fix it and re-run.
  If the project has no control fixture the gate says so in its report and falls back to
  probing with an empty directory, which proves very little: a good runner is *supposed* to
  fail when it finds no tests. Add the fixture rather than reading anything into that.
  **A malformed probe lands here too, not on exit 3** — a probe whose own control is not green,
  or that does not carry the suite at all, is the *probe's* bug and is reported as one. Every
  exit-2 detail names which side is broken: the fork point, the probe, the probe's control, or
  the arguments.
- **exit 3 — unreachable.** The tests are red at the fork point *and* red in the probe, on a
  probe whose own control is green. So the harness works and the criteria still did not pass in
  a tree where they are supposed to be satisfied already: either the probe does not really
  satisfy them, or one or more checks cannot be reached by any implementation. **Never a pass.**
  Find out which before freezing — read the probe's failing lines, and if the probe is honest,
  the criterion is the thing to fix. This is the verdict that would have saved the two runs
  above, and it is worth the cost of building the probe on its own.
- **exit 4 — half-proven.** Red at the fork point, on a green control, with no probe supplied.
  The tests can fail; nothing has ever seen them pass. **This is legal and it proceeds** — a
  freeze with no probe stays a freeze, and building a probe for a one-line criterion is often
  not worth the minutes. What it is not is silent: carry the half-proven state into the approval
  pass the way the guard count is carried, so the user is approving a spec they know is proven
  on one side only. Prefer a probe for anything hard, anything whose tests build fixtures of
  their own, and anything where a criterion's *setup* could fail without the check noticing.
  The planning launcher does not choose this escape hatch automatically: it reports failure and
  offers no freeze command. Half-proven remains available only through an explicit manual gate
  and approval.
- **exit 5 — stale-guard. Never a pass.** A test file that declares itself a guard — the
  literal `[guard]` token on a comment line within its first ten lines, the same word the spec
  uses — is run *alone* against the fork point, and this one came back red. A guard says
  "existing behaviour X still holds", so it is the one kind of criterion that is *supposed* to
  be green before any work exists: red here cannot mean the implementation is missing, because
  there is nothing for it to be waiting for. It means the pin has already moved — the number,
  the key or the file it names changed before you got here. It beats exits 0, 3 and 4 and
  short-circuits the probe, and the report names the file. Re-read that guard against the tree
  as it stands now, re-pin it or drop the criterion, and re-run the gate. A guard subset that
  could not *run* is exit 2 naming the guard side, on the same reasoning that puts a malformed
  probe on 2 rather than 3. The count of guard files is printed on every run, at zero too, and
  belongs in the approval pass beside the count of `[guard]` labels in the spec.

**Then read what the gate says, not only how it exited.** Below the verdict the same run
prints a second, textual pass over the suite it is about to bless (§3.2, move 6; change-log
row `freeze-brittleness-lint`):

```
brittleness findings: 2
  test.js:118  [literal-name-list]  literal-name-list: the expected side is a list of names
      assert.deepStrictEqual(Object.keys(cfg), ['alpha', 'beta', 'gamma']);
  skipped: logo.png  (extension)
```

A red test can still be the wrong test. A criterion that pins a list of names, asserts an
exact count, hashes a whole build, or diffs the branch against its own fork point is red at
freeze *and discriminating at freeze*, and then goes red again for every later task that
legitimately grows the thing it enumerated — the last shape **inverts**, going red precisely
*because* an unrelated later task did its job correctly. No amount of red can detect that,
which is why the gate reads the text as well.

- **The count prints even when it is zero**, so a clean suite can be told from a pass that
  never ran. `unavailable - <reason>` means the pass itself failed; that is not a zero.
- **The lint cannot change the exit code**, in either direction. Findings never fail a
  freeze — a gate on spec *authoring* is one you get past by rewording until it passes
  (hard rule 5) — and a clean pass never rescues a green verdict.
- **Every finding takes a disposition, the way a critic's does.** Write each one into the
  planning draft with what was done about it — accepted and the test rewritten, or rejected
  with the reason it is correct here — so "the lint raised four and all four were
  considered" is a claim anyone can check later instead of taking on trust. It decides
  nothing: no tool can tell a catalogue later work will grow from an enumeration of *this
  task's own output*, and the second is exactly what a discriminating criterion should
  assert. **Rejecting a finding is the common answer and needs no apology; leaving one
  unmentioned is the failure.**
- **Skips are findings too.** Each skipped path is named with a reason — `binary`,
  `extension`, `unreadable`. A suite whose real assertions all sit in a file the pass could
  not read has been blessed by a discriminator that never looked at it.

**A verdict that proceeds leaves a receipt** (§3.2; change-log rows `receipt-design` and
`repo-erq`). On exit 0 and on exit 4 the gate writes `.freeze-gate.json` into the suite
directory it just judged and says so on the last line of its report. It records the gate
version, the verdict, whether a probe was supplied, a content hash of the suite, the
checkout's HEAD, the guard and brittleness counts, and the moment it ran. Three things follow
for a planning session:

- **`--repo` must be a git repository.** The hash is over the blob ids git will store, not
  the bytes on disk — this machine's checkout is CRLF and the committed blob is LF, so a byte
  hash would disagree with the branch on every freeze. A `--repo` with no history is refused
  at exit 2 before anything runs.
- **The receipt is part of the freeze**, not a by-product: it goes to the integration branch
  in the same commit as the tests (step 6), and it is inside `tests/acceptance/`, so the
  verifier already diffs it and a container that edits it ends the task `tampered`.
- **Re-run the gate after touching a test.** The hash is of the suite as it stood when the
  gate ran, so an edit after the fact leaves a receipt that describes a suite nobody gated.

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

**The draft carries the panel's dispositions — and the freeze gate's.** Every critic finding
from step 2 appears in this file with what was done about it — accepted, rejected with a reason, or deferred —
and so does every brittleness finding the freeze gate printed in step 4, on the same terms.
The user is approving intent, not auditing reviews, so this is not
something they have to read; it is there so that "the panel raised nine things and the lint
raised four, and all thirteen were handled" is a claim anyone can check later instead of
taking on trust.

**And the gate's own state travels with them**, one line each: the count of declared guards,
and — when step 4 exited 4 — that the spec is **half-proven**, red at the fork point with no
probe ever run against it. Both are recorded for the same reason, which is that an exemption
nobody sees is an exemption nobody weighed.

**Developers may go deeper (§3.3):** the plain-English criteria are the required gate,
but the actual test files from step 3 are open for inspection — a developer who wants
to read or challenge the tests before they freeze should; a user who prefers to approve
the prose alone may. Claude offers, never insists.

**Nothing is frozen and nothing runs until this approval.**

### 6. Freeze
On approval, in the target repo:

**One command does all of this, and the last thing it does is check its own work:**

```bash
node scripts/freeze.js commit <issue-id> [<issue-id>...] --config run.config.<project>.json
```

It gates the suite, commits it and its receipt to the integration branch under a generated
message, pushes, and then asks the **runner's own dispatch gate** whether the branch it just
wrote will be accepted — so a freeze it reports as done is one a launch will take, rather than
one this session believes it made. Add `--probe <dir>` to hand the gate the tree from step 4,
`--dry-run` to gate and report without writing anything, and pass several ids to freeze a batch
in one commit. It refuses before touching anything if any suite in the batch fails its gate, if
the target checkout has staged work, or if that checkout is parked on another branch: a
half-done freeze is worse than none, because the operator then has a tree they did not make.

When several automatically managed proofs were prepared against the same integration HEAD,
pass one absolute mapping per full suite id:

```bash
node scripts/freeze.js commit <id-a> <id-b> --config run.config.<project>.json \
  --managed-probe <id-a>=<probe-a> --managed-probe <id-b>=<probe-b>
```

The command validates every marker and the common base before running any gate, gates each
suite against its own retained baseline and green probe, promotes the exact suite union as one
transaction, and makes one commit and one leased push. Missing, duplicate, extra, mixed-base or
changed proofs refuse the whole batch before publication. This is the publication counterpart
to `prepare-batch`: freezing one proof first would advance the integration base and stale every
other proof from the same preparation wave.

**It will not write the tests.** The suite is the spec (§2, hard invariant 3), and an issue whose
`tests/acceptance/<issue-id>/` does not exist is refused naming step 3. That refusal is the tool
working.

The manual sequence it replaces, which is what it does and the reason each part matters:
1. Commit the acceptance tests **to the project's integration branch** (its
   `defaultBranch` — §3.4; `main` only if none is configured) and push. Frozen means:
   the test paths as they exist at the task branch's fork point from that branch —
   `git merge-base <defaultBranch> <branch>` (§3.1). Since task branches fork from the
   integration branch at run time, tests must be on it before the run; the verifier
   diffs **all of `tests/acceptance/`** plus the config's `frozenPaths` against the
   fork point and treats any difference as tampering (§4.4).
   **The push is now enforced, not merely expected** (§4.12's second admission rule,
   change-log rows `dispatch-gate` and `repo-5yu`): before claiming anything the runner
   fetches the integration branch from `targetRepoRemote` and refuses any candidate whose
   `tests/acceptance/<issue-id>/` is not a directory there. Committed locally and unpushed
   is the same as absent. A refused issue is never dispatched, never touched in Beads and
   stays `open` — it appears in the report as `undispatchable` with the remedy, rather than
   burning three attempts and a container on a verifier that could only ever exit 1.
   **Commit `.freeze-gate.json` with the tests.** The gate wrote it into the suite directory
   on the verdict that let you get this far (step 4; §3.2), it records the hash of the suite
   as gated, and it is what turns "the gate was run" from a step the playbook asks for into a
   fact the runner can check. If the suite changed after the gate ran, re-run the gate first
   — the receipt would otherwise describe a suite nobody gated.
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

**Ask what a run would actually do, before launching one:**

```bash
node scripts/freeze.js status --config run.config.<project>.json
```

It prints the two populations a launch would produce — dispatchable and refused, each refusal
with its reason and its remedy — using the runner's own gate against the same branch, and
writes nothing anywhere. It exits **1 when the queue has candidates and none of them can be
dispatched**, which is the state a run reports as success while doing no work at all.

This is the first two bullets below, automated and answered in seconds. Run it; then read the
bullets for the halves it cannot check — the **priority order**, the image, and whether the task
has everything it needs to know.
- `bd ready` (in the target repo's working copy) lists exactly the tasks meant to run,
  in the intended priority order. An **epic** may appear in that list and is expected to —
  `bd ready` returns the parent alongside its children — but the runner filters entries
  typed `epic` out and names them in its `ready queue:` log line (§3.1, §4.12). Every
  other type (`bug`, `feature`, `chore`, `decision`) is *eligible* to run — subject to the
  next two bullets, which are the queue's second and third admission rules — so anything in the list
  that is not meant to run this batch must be blocked or closed, not merely retyped.
  The *membership* half of this bullet is automated by the marker's own reader — see the
  last act below — which leaves you the half it cannot check: the **priority order**.
- Frozen tests are on the integration branch (`defaultBranch`) **and pushed**;
  `pipeline.config.json` is current. The runner checks the pushed half itself now and
  refuses what it cannot find (§4.12, change-log row `repo-5yu`), which turns the old
  silent three-attempt failure into an `undispatchable` row naming the remedy — but it
  refuses *per issue*, so an unpushed freeze still costs you that task's slot in the batch.
  **A run that dispatches nothing from a non-empty queue now exits 2**, where it used to exit 0
  and read as a quiet day. That is the signal for anything scripting the loop; a genuinely empty
  queue is still a legitimate no-op at exit 0.
  Two things the gate does *not* soften. An unreachable `targetRepoRemote`, or a default
  branch it cannot resolve, **aborts the whole run before anything is claimed** rather
  than failing one task. And `node scripts/batch.js show`'s `ready` verdict, below, is
  still Beads-only: it does not yet know this rule, so an id can read `ready` there and
  be refused at dispatch (a follow-up task; §4.12 records the gap).
- **Every frozen suite carries its `.freeze-gate.json`, and it is pushed with the suite**
  (§4.12's third admission rule, change-log row `repo-isq`). The freeze gate writes that
  receipt beside the suite on a verdict that proceeds — `red` (exit 0) or `half-proven`
  (exit 4) — and the runner now recomputes the suite's hash from the integration branch and
  refuses anything that does not match: `no-receipt` for a suite the gate never blessed,
  `receipt-mismatch` for one edited after the gate blessed it, and `half-proven` for a red
  freeze no probe was ever run against, unless the run config sets `allowHalfProven: true`.
  So: re-run the gate after *any* edit to a frozen suite, however small — a comment reflow
  moves the hash — and commit the receipt in the same commit as the suite. The refusal names
  the remedy in the run report, but it still costs that task its slot in the batch.
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
  `worked` or `not-worked` against the run corpus **and** `ready` or `not-ready` against the
  live queue — plus one `stray` line for anything the queue offers that this batch never
  named. That is the first bullet of this checklist, automated: it reads the
  `run.config.<project>.json` the marker points at for its `targetRepoPath`, asks that
  working copy, and applies the runner's own `epic` filter, so a parent in the list is not
  reported as a stray. It is **evidence, never a gate** — it exits 0 on findings and changes
  nothing. Where a link of that join cannot be made it prints `unreconciled` with the reason
  (`run-config-absent`, `bd-unavailable` or `bd-unreadable`) and says nothing at all about
  the queue; in that case, do the first bullet by eye.

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

The rows live in **`docs/change-log.md`**, not in `DESIGN.md`; section 12 of the design doc
holds the convention and points at the file. Append at the bottom. That file — and only that
file — is marked `merge=union` in the repo-root `.gitattributes`, which is what lets the
task branches of one batch each append a row and merge without a person hand-resolving the
same conflict N-1 times. It is safe there because rows are appended and never edited, so
never extend the attribute to `DESIGN.md` or another prose file.

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
