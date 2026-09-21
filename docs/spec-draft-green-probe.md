# Spec draft — the freeze gate proves the green side too

**Label:** hard. **design-ref:** DESIGN.md §3.2 (the freeze gate, move 1).
**Reasoning and evidence:** `docs/planning-draft-2026-08-26-green-probe.md`.
**Revision 3** — rewritten against a fresh-context read and a three-critic panel.
Dispositions in §7.

## 1. Description

`scripts/freeze-gate.js` gains `--green <dir>`: a repo-shaped tree in which the spec's
criteria are already satisfied, by any means however crude. The gate runs the same acceptance
suite there and requires green. Today it proves only that the suite is **red** at the fork
point, and a correctly-discriminating suite and one whose own fixture is broken are the same
observation — non-zero.

This has cost two tasks three attempts each. `repo-8v0`: 11 of 29 checks unreachable because a
preload stub killed the child process. `repo-cfe`: the criterion the task existed for called
`git init -q -c …`, where `-c` must precede the subcommand, so no repository was created — and
its two neighbouring checks passed *vacuously*. Both were diagnosed by task agents through
§3.7, not by the gate.

**Out of scope, sequenced after this and depending on it:** naming the individual checks that
failed in both runs. `unreachable` does not exist until this ships, and that work is a failure
-line parser and an intersection over two captures — a separable deliverable with its own
failure modes.

## 2. What a probe actually is — read this before writing one

**A probe is a repo-shaped tree, not a handful of files.** Every frozen suite resolves its own
root as `path.resolve(__dirname, '..', '..', '..')` — the tree it *sits in*, never the working
directory — and `verifyCommand` is a path relative to `cwd`. So the probe must contain:

- the project's acceptance-test runner script, at the same relative path the repository keeps
  it at, so `verifyCommand` resolves;
- `tests/acceptance/<id>/` — the suite being frozen;
- `tests/acceptance/_control/`, if the project has one, because the gate runs the control
  against the probe too (criterion 4).

A directory holding only the criteria's artifacts yields `FAIL: no test files in …` and a
**false `unreachable`**. The practical recipe is a worktree at the fork point with the criteria
hacked true — `node scripts/worktree.js new probe-<id>` — then deleted.

## 3. Constraints

- **The probe run uses `cwd` = the probe directory and the SAME repo-relative test-directory
  string** as the fork-point run — never an absolute path into the probe. The gate's own
  reasoning at `scripts/freeze-gate.js:120-124` records why: engine runners routinely refuse a
  path outside the project.
- **`verifyCommand` and `defaultBranch` are read from `repoRoot`'s `pipeline.config.json`,
  never the probe's.** A probe-side config would be an editable thing deciding how the probe is
  judged.
- **The probe's control is resolved against the PROBE root**, by the same rule `resolveControl`
  uses at `repoRoot`, and its empty-directory fallback is created **inside the probe**. Both
  functions are hard-rooted at `repoRoot` today and must take the root as an argument. The
  fallback directory name must not collide when both roots are the same tree — today it is
  keyed on the pid alone.
- **The probe's copy of the suite is digested and compared before any probe run.** Because the
  probe runs `<probe>/tests/acceptance/<id>/`, a probe author can make the criteria pass by
  editing the *test* rather than the tree, and the gate would bless the freeze it exists to
  prevent. Hash every file under the suite directory, byte for byte, in name order; a mismatch
  or a missing directory exits **2** naming the difference. **This check precedes the probe
  runs and its message wins** over the broken-probe message when both would apply.
- **`runVerify` gains a `maxBuffer` equal to `pipeline/verify-classify.js`'s exported
  `MAX_BUFFER`**, imported rather than retyped. It has none today, so Node's 1 MiB default
  applies and `spawnSync` kills the child on overflow — and a *passing* probe is verbose by
  definition. This is change-log row `verify-nobuffer` recurring inside the gate; the comment
  at `scripts/freeze-gate.js:78-83` already claims a parity that does not hold.
- **The brittleness lint runs once, over the fork-point suite only** — not over the probe.
  A probe is throwaway and deliberately crude; linting it produces findings nobody will fix.
- **The gate makes no git assertion about the probe.** A malformed probe is caught by its
  control, not by looking for `.git`.
- **Every exit-2 detail names which side is broken** — the fork point, the probe, the probe's
  control, or the arguments. Five branches share exit 2 and a code alone cannot tell them
  apart.
- Failure-line and output matching splits on `/\r?\n/`. The host working copy is CRLF and
  containers are LF.
- Worked output added to `PLANNING.md` uses the literal placeholder `<probe-dir>`, never a real
  local path — `scripts/test-sanitize.sh` reads bytes.
- **The repository's own acceptance-test runner is frozen and is never edited by this task.**
  The probe gets a *copy*, in a throwaway tree outside the repository.

## 4. Acceptance criteria — "Done means"

1. **[criterion] `--green` is parsed, and an unusable probe path is refused naming the path.**
   A non-existent path, a path that is a file, an empty string, and `--green` with no value
   each exit **2**, and the output contains the offending path (or, for a missing value, says
   `--green` was given no value).
   *Why naming the path, not just the code:* today `--green` hits `unexpected argument` and
   **also** exits 2, so an exit-code-only check passes vacuously against the current code.

2. **[criterion] The probe run is invoked exactly as the fork-point run is, against the probe
   tree.** With `--green`, the verify command is spawned **four** times — suite and control at
   `repoRoot`, suite and control at the probe. Without `--green`, twice. **Ordering is not
   asserted.** Exactly two invocations carry the suite's repo-relative string as their test-directory
   argument, byte-identical to each other, and those two ran in different trees.
   *How the tree is identified:* each stubbed invocation writes a marker file into its own
   working directory and the test asserts which tree the marker landed in. String-comparing
   `process.cwd()` is forbidden — on this host a temp path can be an 8.3 short name and Git
   Bash and the child disagree on separators and case, so the comparison passes for the author
   and fails for the verifier.

3. **[criterion] The verdict table, as a pure exported function.**
   `verdictFor(real, control, controlKind, probe, probeControl)` — that exact exported name and
   argument order, with `probe === null` meaning no `--green`. It returns:

   | real | control | probe | probeControl | `verdict` | exit |
   |---|---|---|---|---|---|
   | red | green | green | green | `red` | **0** |
   | red | green | red | green | `unreachable` | **3** |
   | red | green | *any* | not green | `indeterminate` | **2** |
   | red | green | `null` | — | `half-proven` | **4** |
   | green | *any* | *any* | *any* | `green` | 1 |
   | *any* | not green | *any* | *any* | `indeterminate` | 2 |

   **The existing `red` token is kept for exit 0** rather than renamed, because
   `scripts/test-freeze-gate.sh:69` greps the report for `RED:` and a rename silently stops it
   matching. "Discriminating" stays prose in the headline, as "The tests discriminate" already
   is.
   **Keeping the token is necessary but NOT sufficient**, and building the probe is what showed
   this: that suite invokes the gate *without* `--green`, so its red case now prints
   `HALF-PROVEN:` and the grep fails anyway. The grep must accept both. Seven assertions in
   `tests/unit/freeze-gate.test.js` and four in `scripts/test-freeze-gate.sh` fail on the
   repeal — measured by running them against a probe, not counted by reading them.
   *Checked by:* calling the exported function with synthetic run records. No filesystem.

4. **[criterion] A broken probe is `indeterminate`, never `unreachable`.** Exit 3 is reachable
   only when the probe's control comes back green; otherwise exit **2** with a detail naming
   the probe as the broken side.
   *Why it is load-bearing:* without it, a missing runner script, a missing node, or a probe
   pointed at the wrong directory all report exit 3 and tell the planner their criteria are
   unsatisfiable — the gate's "refuse to bless rather than refuse to notice" principle inverted
   into a confident accusation.
   *Its fixture is a pair:* a stub red for every directory when it runs in the probe tree →
   exit 2 naming the probe; and a green-probe-control-plus-red-probe-suite stub → exit 3. A
   naive implementation returns 3 for both, and only the pair separates them.

5. **[criterion] The output ceiling is raised, proven against the real limit.** A probe suite
   that writes **more than 1 MiB synchronously** (`fs.writeSync`, never `process.stdout.write`
   followed by `process.exit`, whose async write can be truncated so nothing ever overflows and
   the check passes against the unchanged implementation) and exits 0 is read as a green probe:
   the run record carries no `error` and no `signal`, and the captured output exceeds 1 MiB.
   The gate's buffer value is the `MAX_BUFFER` **imported** from `pipeline/verify-classify.js`,
   not a retyped literal.

6. **[criterion] It works with the real runner, not only the stub.** With `FREEZE_GATE_CMD`
   unset, against a probe tree built from a copy of the project's runner script plus a
   trivially-passing suite, the gate exits **0**; with the runner script absent from that same
   probe, it exits **2**, not 3.
   *Why this criterion exists at all:* every other criterion runs through the stub, and with the
   command stubbed the probe tree's contents are irrelevant — so §2's whole warning has no
   coverage. This is the miss change-log row `freeze-gate-red` records: the empty-directory
   control survived every stubbed check and died on the first real `verifyCommand`.

7. **[criterion] The playbook says what to do, and its own suite enforces it.**
   `PLANNING.md` step 4 gains the `--green` invocation and two stanzas containing the literal
   strings `exit 3 — unreachable` and `exit 4 — half-proven`. **`half-proven` proceeds**: a
   freeze with no probe stays legal, and the stanza says so, with the half-proven state carried
   into the approval pass the way the guard count already is.
   *Checked behaviourally, not by grepping another script:*
   `PLAYBOOK_FILE=<fixture lacking the new stanzas> bash scripts/test-planning-playbook.sh`
   exits non-zero, and `PLAYBOOK_FILE=PLANNING.md` exits 0.

8. **[criterion] Both suites assert the NEW contract, and neither shrinks.**
   `node tests/unit/freeze-gate.test.js` exits 0 with **at least 115** `PASS` lines (100 today),
   `bash scripts/test-freeze-gate.sh` exits 0, and its floor rises from `-ge 90` to **`-ge 110`**.
   Both suites contain a passing assertion of each new contract state — red with a passing probe
   exits 0, red with no probe exits 4, probe-control-not-green exits 2, probe-red exits 3 —
   verified by *running* them, never by reading their source.
   *Why stated this way:* "rewritten, not deleted" is an intent no script can check, and line
   numbers move the moment the file is edited, which this work requires. The floor plus the
   four new states is the observable that makes deletion insufficient.

9. **[criterion] The documents this changes are changed.** `DESIGN.md` §3.2 and its statement
   that the gate runs the verify command twice; `docs/pipeline-diagram.md`, which states the
   verdict is "red, green or indeterminate" and "the only thing that reaches the exit code";
   and a new row in `docs/change-log.md` recording the amendment and the deliberate repeal.
   *Red before:* all three describe the three-verdict gate.

10. **[guard] Exits 0, 1 and 2 keep their meanings, the lint still cannot move the exit code,
    and neither tree is dirtied.** Green at the fork point → 1; broken harness → 2; missing test
    directory, no arguments, missing `pipeline.config.json` → 2. `brittleness findings:` prints
    in every verdict and moves the exit code in none. After any run that exits non-zero for any
    reason, no `.freeze-gate-control-*` remains in `repoRoot` **or** the probe.

## 5. Known, accepted, out of scope

- **A probe can cheat in the same wrong way the suite is wrong.** It raises the floor; it is not
  a proof of correctness.
- **`tests/acceptance/repo-uw6/test.js` freezes the old table** — `exits 0/1/2` and a guard that
  `verdictFor` answers all nine rows. That suite has already gated its task and never re-runs, so
  nothing breaks mechanically, but the change-log row must record the repeal as deliberate, since
  a frozen test now states the opposite of shipped behaviour.
- **It partially subsumes a parked idea** — `docs/IDEAS.md`'s dependency-exercising control
  fixture, filed after a vacuous RED was certified as discriminating. A probe catches that case
  too but calls it `unreachable` when the truth is a broken harness, so the entry is **narrowed**,
  not closed.
- Nothing here judges whether the criteria are the *right* criteria. That stays the panel's.

## 6. Spec-lint dispositions

4 findings, all the same one: descriptive mentions of the frozen acceptance-test runner.
**Rejected, all four.** Each explains that `verifyCommand` is relative and therefore that a probe
tree must *contain* a copy of that script — the fact whose absence produced the first draft's
wrong cost model. The lint cannot distinguish "must contain a copy of X" from "must edit X", and
is right not to try. Compensating constraint added to §3: the repository's copy is never edited.

## 6b. Freeze-gate lint dispositions

The brittleness lint reports **4 findings**, all `literal-count`, all in C2's section: the
invocation counts (`=== 2`, `=== 4`, `suiteArgs.length === 2`).

**Disposition: rejected, all four.** The lint asks the right question — *is later work licensed
to grow this population?* — and here the answer is no, twice over. The count **is** the
criterion: two spawns without `--green` and four with is the observable that distinguishes an
implementation which runs the probe from one which does not, and `suiteArgs.length === 2` is
what proves exactly one probe run and one fork-point run carried the suite. If later work makes
the gate spawn a fifth time, this suite *should* go red — that is a change to the contract this
criterion pins, not incidental growth. This is the case the lint's own design note describes as
the one it cannot settle: an enumeration of the task's own output rather than a catalogue later
work will extend.

Gate verdict with the suite as frozen: **RED**, control green, 1 guard declared.

## 7. Panel dispositions

Three critics, all `concerns`, 24 findings. Every one accepted except where noted.

| Finding | Disposition |
|---|---|
| **All three:** C2 and C4 disagreed on invocation count — four with `--green`, not two | **accepted.** C2 now states four/two, that ordering is not asserted, and the marker-file identification |
| **Testability:** C8 ("rewritten, not deleted") is an intent no script can check, anchored on line numbers the work itself moves | **accepted.** Restated behaviourally: floor numbers, and each new contract state asserted by *running* the suites |
| **Testability:** the 2 MiB fixture passes against the bug — async stdout write plus `process.exit` truncates, so nothing overflows | **accepted.** `fs.writeSync` pinned, plus assertions on no `error`/`signal` and observed size; buffer value imported, not retyped |
| **Testability:** every criterion was stubbed, so §2's warning had no coverage — the `freeze-gate-red` miss | **accepted.** New criterion 6, real runner, with its discriminating partner |
| **Ambiguity + testability:** the decision function's name and signature were never pinned — shadow-01 shape | **accepted.** Exact name, argument order, and all combinations tabulated |
| **Ambiguity:** whether the `red` token survives; `test-freeze-gate.sh:69` greps `RED:` | **accepted.** `red` kept for exit 0; the new tokens are additive |
| **Ambiguity + scope:** the probe-side control's root and fallback location were unstated; both functions are hard-rooted at `repoRoot` | **accepted.** Resolved against the probe root, fallback created inside the probe, collision named |
| **Ambiguity + scope:** the digest constraint had no criterion and left scope, moment and precedence open | **accepted as a constraint with pinned semantics** — every file byte-for-byte in name order, before any probe run, its message winning. Deliberately not promoted to a criterion: it is one exit-2 branch among five and criterion 10 already pins that exit 2 names its side |
| **Scope:** the documents made wrong were undeclared | **accepted.** New criterion 9 |
| **Scope:** split the intersection report out | **accepted.** Sequenced as a dependent follow-up; named in §1 |
| **Scope + ambiguity:** C8's list of repealed sites was incomplete and read as authoritative | **accepted.** No line list survives; the property is stated instead |
| **Ambiguity:** the `half-proven` stanza never said what the planner does | **accepted, and decided by the user:** it proceeds |
| **Testability:** C6 grepped another script's source | **accepted.** Restated through the existing `PLAYBOOK_FILE` seam |
| **Testability:** `cwd` string comparison is environment-dependent (8.3 short paths, separators, case) | **accepted.** Marker file instead |
| **Ambiguity:** floor number, placeholder token, missing `--green` value all unpinned | **accepted.** 115 / `-ge 110`, `<probe-dir>`, and the missing-value case added to criterion 1 |
| **Testability:** C7's "when a run throws" named no injection point, freezing an internal call | **accepted.** Restated as "any run that exits non-zero for any reason" |
| **Ambiguity:** does the probe run when the real run is green or indeterminate? | **accepted.** Criterion 2 pins the invocation count for `--green` runs; the table makes the verdict independent of the probe in those rows, so short-circuiting is legal and unobservable |
| **Scope:** label `hard` is correct but at the ceiling | **accepted, no change.** The user's call: freeze as one |
