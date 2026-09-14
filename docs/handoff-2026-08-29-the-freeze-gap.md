# Handoff — 2026-08-29 — the freeze gap, what was built, and what is still open

**Written for:** the next session in this repo, and for Chad.
**Status:** a record of a day's work. Nothing here is a spec awaiting approval.

---

## 1. Where we ended up

Chad opened the day with a recurring complaint: he reaches the point of launching a run,
has a batch he believes is frozen and queued, and the run does nothing because there are no
frozen tests.

That turned out to be exactly true, and worse than he thought. Against the backlog of the
target project this session was working:

- **Twenty issues were ready in Beads. None of them could be dispatched.**
- Seventeen had **no acceptance tests anywhere** — not on the branch, not on disk.
- Three had complete test suites already on the integration branch and were refused only
  for a missing freeze receipt.
- One of the seventeen had an empty placeholder directory rather than tests, which is worse
  than nothing: the verifier exits on "no test files" for all three attempts.

The specs themselves were not the problem. Seven planning sessions ran that day and each
produced a substantial draft and a Beads issue carrying numbered, genuinely machine-checkable
acceptance criteria. The thinking was done and written down. **The transcription of that
thinking into runnable checks — the playbook's step 3 — was skipped in every one of them.**

By the end of the day:

- Two of the three near-complete suites were proven ready to freeze.
- The third cannot be frozen on this host at all, for a reason described in §5.
- The seventeen still need their tests written, and there is now a command that sets an
  agent up to do it correctly.

---

## 2. What was built

Two commands, both on `main` as of this document.

**The freeze became a command.** `scripts/freeze.js` has two verbs. `status` answers "what
would a run dispatch right now?" without launching one, printing the dispatchable and
refused populations with each refusal's kind and remedy, and exiting non-zero when a
non-empty queue can dispatch none of it. `commit` performs the freeze — gate the suite,
commit it and its receipt to the integration branch, push — and then asks the **runner's own
dispatch gate** whether the branch it just wrote will be accepted. That last step is the
whole point: what it reports is the runner's verdict, not the command's belief.

**A run that dispatches nothing from a non-empty queue now exits 4.** It used to exit 0,
which no script could distinguish from a run with nothing to do. A genuinely empty queue is
still a legitimate no-op at 0. The queue summary line also stopped calling a wholly-refused
queue "empty", which was the first word a skimming operator read.

**The brief that sends an agent to write a spec's tests is generated.**
`scripts/spec-brief.js` fills in the six facts that change per issue and per project —
integration branch, verify command, frozen paths, host environment, which folder the agent
works in, and where the freeze gate is pointed — reading them from the run config, the
target's own config, git's worktree registry and Beads. It classifies each issue into one of
three states first, because the instructions genuinely differ: write the tests, freeze a
suite the working tree already holds, or re-gate one that is on the branch without a
readable receipt.

A new optional `hostEnv` map in the host-local run config records a binary that is not on
`PATH`. It is read by nothing at run time; a container takes its dependencies from the image.

---

## 3. Why I think we ended up here

Four causes, in the order they matter.

### 3.1 The expensive step had no tooling and no enforcement; the cheap step had both

Filing an issue is one command. It needs no tests, is always available, and produces
something that reads `ready` in the queue forever. Writing the acceptance tests is the
expensive step — it needs a fresh context and the code in front of you — and until today
nothing in the process either helped with it or noticed it had been skipped.

Seven sessions in one day each stopped at the same place. That is not seven mistakes. It is
one process shape, applied seven times, behaving exactly as its incentives dictate.

### 3.2 Every enforcement point sat at the end of the loop

The detection was never missing. The runner's refusal message was correct, specific and
carried its remedy — and the comment above the code that builds it had *anticipated the
exact confusion it would cause*. What was missing was a question anyone could ask **before**
launching, and a failure a script could **see**. A planning draft written two days earlier
had already named both and built neither.

### 3.3 The freeze was a manual sequence with three ways to be half-done

Committed but unpushed. Pushed without the receipt. A receipt describing a suite that was
edited after the gate blessed it. All three are indistinguishable from success until a
launch minutes or hours later, and each costs that task its slot in the batch.

### 3.4 The same failure recurred twice more inside this session, which is the useful part

I hand-wrote a brief to send an agent to write one issue's tests. **Four of its six
project-specific facts were wrong** — a binary path that had moved, a `scripts/` directory
the target repo does not have, a gate pointed at the shared checkout rather than the
worktree, and a worktree it told the agent to create when one already existed. The agent
that received it caught all four before acting, which is the only reason they are in this
document rather than in a wasted afternoon.

Later, my local test sweep passed and CI failed. The publication-hygiene check scans the
*tracked* tree, and I had run the sweep before staging the new file.

Both are the same shape as the thing being fixed: **facts retyped instead of derived, and a
check reporting success on something it never examined.**

That second phrase is the family this whole day belongs to:

- a run that refused eight of eight candidates and exited 0;
- a freeze gate that certifies a "discriminating red" when every test actually failed
  because a binary was not on `PATH`;
- a hygiene check that passes because the file it should have read was not staged;
- a `--repo` aimed at a tree that does not hold the tests, answering *indeterminate* —
  which reads like an answer and is not.

None of these is a broken check. Each is a correct check whose scope quietly failed to
include the thing being asked about. The defence is not more checks; it is making each check
say what it actually looked at.

---

## 4. What is verified, and what is assumed

**Verified by running it:**

- All 38 mandatory Docker-free suites pass on `main`.
- Against the live queue, `freeze.js status` reports 0 of 20 dispatchable and exits
  non-zero, separating the seventeen with no suite from the three refused for their receipt.
- `spec-brief.js` classified all twenty correctly.
- Two of the three near-complete suites gate cleanly — tests red at the fork point, control
  green, guard green, no brittleness findings. Their receipts are sitting untracked in the
  target project's working tree from a dry run; the freeze command will commit them.

**Assumed, and worth someone checking:**

- That the seventeen specs are *complete enough* to write tests from. Three were sampled and
  were excellent. The other fourteen were not read.
- That the planning drafts and the issues still agree. Two tasks in an earlier batch were
  built against a draft the issue had moved past, so this is a known failure mode. The brief
  quotes the issue rather than the draft, which contains the damage but does not detect it.

---

## 5. Open items

**The freeze command does not apply `hostEnv` when it runs the gate.** It spawns the gate in
a child process without the run config's host environment, so on a project needing a binary
that is not on `PATH` the export must be set in the shell by hand. Get it wrong and every
test false-fails into a red that looks discriminating. This is a gap in what was built today
and it is the first thing to close — the command should apply `hostEnv` itself.

**One suite cannot be gated on this host, and it is not that suite's fault.** The
campaign-continue task's guard calls two sibling suites, one of which has two cases that are
red on Windows for reasons unrelated to the task: one forces a file-rename failure Windows
does not permit, and one audits the player profile for save files, which goes red on any
machine where somebody has actually played the game. Both are green in the container. The
guard's own comments document both, and the narrowing fix is already filed as a separate
issue — which makes it a real dependency, not a footnote.

This exposes a design tension worth a decision rather than a workaround: **the freeze gate
runs on the host, but some guards can only be honestly evaluated in the container.** Today
that is one blocked task. It will not stay at one.

**Two spec defects in the reel task, found before anyone wrote a line.** One criterion
quietly requires extending a measurement instrument, which is a second task's worth of work
riding inside a fifteen-criterion spec — recommend splitting it out. Another says "report
whether that suite comes back green", which is an instruction to a human and not
machine-checkable — recommend folding it into the neighbouring criterion that already counts
and names superseded assertions. Note that labelling it a guard, which was the first
proposal, would refuse the freeze outright: a guard must be green at the fork point and that
suite is red. Both are spec changes and reopen the approval gate.

**Beads does not record the blocker.** The campaign-continue task depends on the
profile-audit narrowing task. The queue will keep offering the blocked task until that is
recorded. Not done, because writing issue state is a mutation and this session's profile
requires explicit authorisation.

**The re-gate brief points at a worktree it does not need.** For a suite already on the
integration branch the freeze happens in the checkout that is on that branch, so sending the
reader to a worktree is ceremony. Cosmetic next to the `hostEnv` gap.

---

## 6. What I would do next, in order

1. Close the `hostEnv` gap in the freeze command. It is small, and it removes the one trap
   that turns a correct command into a vacuous freeze.
2. Take the two suites that are ready. One command.
3. Amend the reel's two criteria, then generate its brief and hand it to a session.
4. Record the blocker in Beads so the queue stops offering work that cannot proceed.
5. Work the seventeen in groups by the planning draft that produced them — one agent per
   draft gets the shared context for free and writes a more coherent set than seventeen
   independent sessions would.
6. Decide what to do about host-only guard failures before the second one arrives.

---

## 7. The one thing worth remembering

The specs were good. The thinking was done. Twenty issues sat unrunnable because the
transcription step between "we know what done means" and "a machine can check it" had no
tooling, no enforcement and no way to notice it had been skipped — and because every signal
that would have caught it arrived after the point where it was cheap to act on.

That is a process shape, not a discipline failure, and it responds to tooling rather than to
resolve.
