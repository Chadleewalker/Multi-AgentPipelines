# Planning draft 2026-11-03 — skip the final re-verification when the docs phase changed nothing

**Status:** frozen as Beads issue **`repo-xwx`**. The approvals so far, each by the user on
2026-11-03:
- **The seven-point "Done means" list:** "yes, approved". That note is copied unchanged to
  [`docs/skip-unchanged-reverify-2026-11-03.md`](skip-unchanged-reverify-2026-11-03.md).
- **The ignored-file residual risk:** "yes, approved".
- **Locking (freezing) and running this task**, with the account switch for its push:
  "yes, approved".

Merging and going live are still a separate approval.

This file is the PLANNING.md step 5 snapshot. Issue `repo-xwx` is now the canonical spec, and
this file is disposable once the task has run.

**Tests:** `tests/acceptance/repo-xwx/`. Until the issue existed they sat in a placeholder
directory, which was renamed at freeze; every citation below now names the real directory.

---

## The spec (the five fields)

**Title:** Skip the final re-verification when the docs phase left the tree unchanged

**Difficulty:** medium — one shell branch in the entrypoint, two status keys, two manifest
fields and one runner seam; no change to the verifier.

**design-ref:** DESIGN.md §4.3 (the docs phase and its final re-verification, change-log row
`repo-cl9`), §4.11 (the status file), §4.12 (the run manifest).

### Description

`pipeline/entrypoint.sh` always runs `verify.js` a second time after the docs phase. That
second run exists because the docs phase can change source, tests, config or build inputs
after the passing verification (change-log row `repo-cl9`). When the docs phase changed
nothing, the second run re-checks a tree that was already certified, and on recent real tasks
that cost 8 to 17 minutes per task.

After this task, the entrypoint skips the final re-verification **only** when the tree after
the docs phase is provably the tree the passing verification certified. In every other case,
including a documentation-only edit, it re-verifies exactly as today.

The task also records two facts on each finished task's manifest row (`runs/<run-id>/run.json`),
so that a target's own host-side check can later decide to skip work the verifier already
proved:
- `verifiedCommit` is the commit the final passing verification ran on.
- `imageId` is the image the task container ran.

Both facts are evidence only. Neither changes any outcome.

### Constraints

Allowed implementation files: pipeline/entrypoint.sh, pipeline/status.js, schemas/status.schema.json, schemas/run.schema.json, runner/run.js, runner/container.js, DESIGN.md, docs/pipeline-diagram.md, docs/STATUS.md.

- **The skip rule.** Record the passing commit straight after the commit that follows the
  passing verification: `HEAD` and `HEAD^{tree}`. After the docs phase, skip the final
  re-verification only when all three of these hold:
  - `HEAD` is unchanged;
  - `HEAD^{tree}` is unchanged;
  - `git status --porcelain` prints nothing.

  Anything else runs the final re-verification exactly as today.
- **Fail closed.** If any git command in that decision fails, or returns an empty value, the
  re-verification runs. An error must never read as "unchanged". (Criterion C8.)
- **Shell.** The entrypoint runs under `bash`, exactly as `runner/container.js` launches it,
  and the tests launch it the same way.
- **Clear before deciding.** `status.json` sits in the agent-writable workspace. So before
  the decision, remove any `verifiedCommit` or `finalVerification` already in it. A value the
  agent planted must never survive a path that records none.
- **Never trust the docs agent's report.** The decision reads git only. The docs agent's
  output, exit code and summary play no part in it.
- **`pipeline/verify.js` is not changed** (hard rule 2). Neither is anything it reads.
- **No new file under `pipeline/`.** Existing frozen tests build a `PIPELINE_DIR` holding only
  `status.js`, `envelope.js` and a stub `verify.js`. An entrypoint that calls a new helper
  file through `$PIPE` would break them. Use git and `status.js` only.
- **Status file (`status.json`, written only through `status.js`).** Two new keys, both added
  to `schemas/status.schema.json`:
  - `finalVerification` is `"skipped-unchanged"` when the re-verification was skipped, and
    `"ran"` when it ran, whatever its result was. Write it before exiting on every path that
    reached the docs phase.
  - `verifiedCommit` is a full 40-character lowercase sha.
    - When skipped, it is the passing commit.
    - When the re-verification ran and passed, it is `HEAD` — but only if
      `git status --porcelain` is empty at that moment. If the tree is dirty, the
      verification ran on uncommitted files, no commit corresponds to it, and the key is
      absent.
    - On every other exit the key is absent.
- **Entrypoint output.** On a skip, print one line containing the exact text
  `final re-verification skipped` (it lands in the task's `container.log`). Never print that
  text on any other path.
- **Runner (`runner/run.js`; a helper may live in `runner/container.js`).**
  - **The skip line.** When the collected `status.json` has `finalVerification:
    "skipped-unchanged"`, log one `log.info` line containing `final re-verification skipped`
    to the run log.
  - **`verifiedCommit` on the row.** Copy `status.json`'s `verifiedCommit` onto the task's
    manifest row only when all of these hold:
    - the task's final outcome is `done` or `partial`;
    - the value is a 40-hex sha;
    - it equals `git rev-parse HEAD` of the task workspace (the branch that is pushed and
      reviewed).

    Otherwise omit it. This never changes the outcome, the push or the PR.
  - **`imageId` on the row.** Before each container launch in `runOneTask`, read the image id
    by spawning `docker` with the arguments `image inspect --format {{.Id}} <cfg.image>`. Do this on the
    `PIPELINE_EXEC_STUB` path too, so the stubbed suites can see it. The row's `imageId` is
    the id read before the **last** launch. Record it only if the trimmed output matches
    `^sha256:[0-9a-f]{64}$`.

    A failed or malformed read is logged and leaves `imageId` off the row. It never fails or
    changes the task.
  - **Test seam `PIPELINE_DOCKER_CMD`.** When set, the inspect runs as
    `<PIPELINE_DOCKER_CMD> image inspect --format '{{.Id}}' <image>` through the host shell,
    exactly as `PIPELINE_GH_CMD` is run (`runner/host-shell.js` `runCommand`). Production
    never sets it. When it is unset, `docker` is spawned directly with `MSYS_NO_PATHCONV=1`,
    like every other runner docker call.
  - **Run manifest schema.** Add both fields to the task row in `schemas/run.schema.json`:
    - `verifiedCommit`, pattern `^[0-9a-f]{40}$`;
    - `imageId`, pattern `^sha256:[0-9a-f]{64}$`.
- **Records.**
  - Add a `DESIGN.md` §12 change-log row that amends `repo-cl9`, appended at the bottom, with
    the ref set to this issue's id. Update the §4.3 and §4.11 text it touches.
  - The row and the §4.3 text must state the accepted residual risk. A file git ignores, if
    the docs phase creates or edits it, is not seen by the skip rule. The user accepted this
    on 2026-11-03 with no extra check.
  - Amend `docs/pipeline-diagram.md` where it draws the docs phase → re-verify path.
  - Run `sh scripts/test-changelog.sh` after the change-log edit.
- **Out of scope.** Any target's use of the two facts. Skipping the first verification or the
  docs phase.

### Acceptance criteria ("Done means")

C1–C7 are the seven approved points, made machine-checkable. C8 makes the "fail closed"
constraint checkable; the critic found it had no test. The tests are under
`tests/acceptance/repo-xwx/`. They are Docker-free and stub-driven, and make no model
call.

1. **C1 — Unchanged tree, no second verification.** The real entrypoint and verifier run
   with a stub agent. In five scenarios the docs phase leaves `HEAD`, the tree and the
   working copy unchanged:
   - it does nothing;
   - it claims edits it did not make;
   - it edits a file and restores it byte for byte;
   - it fails having touched nothing;
   - the pass came on attempt 2.

   In every one of them, the entrypoint:
   - exits 0;
   - calls the verifier exactly once per code attempt, and never again after the docs phase;
   - records `finalVerification: "skipped-unchanged"`;
   - prints `final re-verification skipped`.

   The runner logs the same text in the run log.
   (`entrypoint-skip.js`, `runner-facts.js`.)
2. **C2 — Any change re-verifies, with today's outcomes.** In each of the following cases the
   verifier runs a second time and `finalVerification` is `"ran"`. No skip line is printed.

   | The docs phase… | Exit code |
   |---|---|
   | edits a tracked file and commits it | 0 |
   | adds a file | 0 |
   | deletes a file | 0 |
   | commits by itself | 0 |
   | makes an empty commit | 0 |
   | fails, leaving an unstaged edit | 0 |
   | fails, leaving an untracked new file | 0 |
   | fails, leaving a staged but uncommitted edit | 0 |
   | breaks the acceptance test | 30, with `docsPhaseError` set |
   | edits a frozen test | 11 |

   The three "fails, leaving…" rows matter most: the entrypoint commits nothing after a
   failed docs phase, so `HEAD` does not move and only the working-copy check can see them.
   (`entrypoint-skip.js`.)
3. **C3 — A failed docs phase behaves as today.** If it failed with the tree unchanged, there
   is no re-verification: exit 0, and `docsPhaseError` is recorded. If it failed leaving
   anything uncommitted, the re-verification runs: exit 0, and `docsPhaseError` is recorded.
   (`entrypoint-skip.js`.)
4. **C4 — The decision reads the tree, not the agent.** If the agent claims it edited docs and
   did not, the step is skipped. If the agent says "No files were changed" while editing,
   adding or deleting a file, the step re-verifies. (`entrypoint-skip.js`.)
5. **C5 — `[guard]` `pipeline/verify.js` is unchanged.** It is byte-identical
   (CRLF-normalised) to its fork-point blob. (`verifier-unchanged.js`.)
6. **C6 — Two facts on the record, evidence only.**
   - **C6a** (`entrypoint-skip.js`):
     - `status.json`'s `verifiedCommit` is the branch head, and on a skip it is the
       `implementation (verified on attempt N)` commit.
     - After a passing re-verification on a clean tree, it equals the commit the final
       verification ran on. It is absent after a dirty-tree pass, a failed re-verification or
       a tampered one — including when the docs agent planted a plausible value in
       `status.json` first.
     - Every `status.json` key the entrypoint writes is declared in `status.schema.json`.
       The schema is also probed with fixed strings: `verifiedCommit` accepts 40 lowercase
       hex and rejects 39 hex, uppercase and `HEAD`; `finalVerification` is exactly
       `skipped-unchanged` / `ran`.
   - **C6b** (`runner-facts.js`), driving the real `runOneTask`:
     - The row's `verifiedCommit` equals the branch head as pushed to the remote, for both a
       `done` and a `partial` task.
     - It is omitted when the claimed value is not the head, and when the final outcome is
       not a success. That covers a stuck task, and an exit 0 that the earned-success check
       turns into `failed`. Outcome and PR are unchanged.
     - The row's `imageId` is the value `docker image inspect --format {{.Id}} <cfg.image>`
       returned through `PIPELINE_DOCKER_CMD`. After a rate-limit relaunch the image is read
       once per launch, and the row carries the id read before the **last** launch.
     - It is omitted, with the outcome still `done`, when the read fails or returns anything
       other than exactly one id: an error line, `sha256:abc`, or a warning line before a
       valid id.
     - **Linux only:** with the seam unset, the runner spawns `docker` itself, and an
       executable stub first on `PATH` sees exactly that argument list. The Windows host
       cannot spawn a script without a shell, so there the test prints a `NOTE` instead. The
       authoritative run is in the Linux task container.
     - Both fields are declared on the row in `run.schema.json` and probed with fixed
       strings.
7. **C7 — Existing coverage stays green.**
   - **In the run:** the new check that proves both branches is `entrypoint-skip.js` itself.
     It is stub-driven like the existing scenarios and makes no model call.
   - **At review, before merge, as a named review step.** This needs Docker, so it cannot run
     inside a task container, and it needs an operator Docker slot.
     1. In a Linux container from the pipeline base image, against the task branch, run the
        Docker-free tests that drive the changed code:
        - `tests/acceptance/repo-cl9/post-doc.js`, `repo-52m`, `repo-wxh` and `repo-1cy`.
          **Expected:** `repo-1cy`'s single check "A7 verifier and runner unchanged since the
          fork point" fails for **any** change to `runner/`. That check belonged to its own
          task, and is the one allowed failure.
        - `tests/unit/done-earned.test.js`, `concurrency.test.js` and `pause-gate.test.js`.
     2. On the host, run `bash scripts/test-entrypoint.sh` and the runner container suites
        (`scripts/test-runner-*.sh`), or the whole sweep, `bash scripts/test-all.sh`.
        `CLAUDE_CODE_OAUTH_TOKEN` must be set, or the runner suites go red with misleading
        failures.
     3. After the first real run on the merged change, confirm that one manifest row's
        `imageId` equals `docker image inspect --format {{.Id}} <image>` for that run's
        image. This is the one end-to-end check of the production path.
8. **C8 — Fail closed.** Nothing changed, but the decision's first `git status` — or, in a
   second scenario, its first `git rev-parse` — fails with no output. The test does this with
   a `git` shim first on `PATH` that fails exactly one call. Expected: the re-verification
   runs, `finalVerification` is `"ran"`, no skip line is printed, and the shim's failure was
   actually used up by the run. (`entrypoint-skip.js`.)

### Coverage (PLANNING.md step 4)

| Criterion | Proved by |
|---|---|
| C1 | `entrypoint-skip.js` — scenarios unchanged, claims-change, edit-reverted, docs-fail-clean, pass-on-attempt-2; `runner-facts.js` — "skipped: the run log says…" |
| C2 | `entrypoint-skip.js` — edit-claims-none, new-file, deleted-file, agent-commit, empty-commit, docs-fail-dirty, docs-fail-untracked, docs-fail-staged, docs-broke-tests, docs-tampered |
| C3 | `entrypoint-skip.js` — docs-fail-clean, docs-fail-dirty, docs-fail-untracked, docs-fail-staged |
| C4 | `entrypoint-skip.js` — claims-change (skips), edit-claims-none / new-file / deleted-file (re-verify, agent says nothing changed) |
| C5 | `verifier-unchanged.js` `[guard]` |
| C6 | `entrypoint-skip.js` (C6a: verifiedCommit per scenario, planted-then-dirty, planted-then-broke, status-schema probes and conformance); `runner-facts.js` (C6b: skipped, ran, partial, unearned, not-head, stuck, relaunch, docker-fails / junk / short / noisy, docker-on-path, run-schema probes and conformance) |
| C7 | `entrypoint-skip.js` (in-run half); the three-step review procedure (Docker half) |
| C8 | `entrypoint-skip.js` — git-status-fails, git-rev-parse-fails |

Every test file serves at least one criterion, and every criterion has a test.

---

## Decisions made while writing the tests

The approved list left these open, or open to two readings. Each one is the conservative
reading. None widens what the pipeline trusts.

1. **An empty docs-phase commit re-verifies.** The approved rule compares trees, and an empty
   commit leaves the tree identical. Even so, `HEAD` unchanged is added as a third
   condition. Without it, `verifiedCommit` would name a commit that is not the PR head,
   which contradicts approved point 6. Cost: one extra verification in a case that should
   almost never happen.
2. **A pass on an uncommitted tree records no `verifiedCommit`.** This happens only when the
   docs phase fails and leaves an edit behind. That edit is not committed today either. The
   final verification then ran on files no commit contains, so naming a commit would be
   plausible and wrong.
3. **Where the facts live.**
   - The entrypoint writes `verifiedCommit` into `status.json`, because only it knows which
     commit passed.
   - The runner copies it to the `run.json` row after checking it against the branch head
     (`status.json` sits in the agent-writable workspace).
   - The runner records `imageId`, because the container cannot see its own image.
4. **"Run log"** means both:
   - the runner's `run.log` line;
   - the entrypoint's own line, in that task's `container.log`.
5. **A git error during the decision re-verifies** (fail closed).

## Residual risk — accepted by the user, 2026-11-03

**Status: accepted, no extra check.**

The question put to the user was: "Do you accept that the skip can't see files git ignores,
with no extra check added?" Before answering, they were told three things:
- today's second verification would catch such a file;
- it is unlikely, because the docs step may only edit listed documentation files;
- if it did happen, the cost is one task merged without its second check.

The user answered: "yes, approved" (2026-11-03, relayed by the operator session).

**A file git ignores is invisible to the skip rule.** `git status --porcelain` does not list
ignored files, and `verify.js` runs tests in the working tree. So a docs phase that creates or
edits an **ignored** file that a test or build then reads would previously have been caught
by the re-verification, and now would not be.

Likelihood is low:
- the docs agent is told to edit only listed documentation paths;
- ignored files are usually build output, and the verifier regenerates or reuses those
  itself.

But it is a real narrowing compared with today. The approved rule names exactly these two
git checks, and the user accepted the narrowing, so this spec adds no ignored-file check. If
one is ever wanted, it is a later spec change. One possible form: compare
`git status --porcelain --ignored` before and after the docs phase. That catches new or
removed ignored paths, but not edits inside an existing ignored file.

## Evidence

- **Red at the fork point** (`node scripts/freeze-gate.js`, below): the tests fail against
  today's code, and only for the new behaviour. The re-verify scenarios already reproduce
  today's exit codes 0, 30 and 11.
- **Green is reachable — on the Windows host.** A throwaway prototype of the implementation
  (about 40 lines across the entrypoint, status helper, two schemas and the runner) turned
  the revised tests fully green: `entrypoint-skip.js` 176/176, `runner-facts.js` 35/35. It
  was removed afterwards and is not part of this change.
- **Also shown in Linux, where the verifier will actually run the tests.**
  - **The run.** One container from `pipeline-base:local` (`--network none`, `--rm`),
    2026-11-03, with node 22.23.1, git 2.39.5, and `/bin/sh` being dash. The tests ran through
    the project's own `verifyCommand`, exactly as the verifier invokes it, against clean clones with Linux
    line endings.
  - **Fork point:** exit 1. `entrypoint-skip.js` 90/147, `runner-facts.js` 24/37,
    `verifier-unchanged.js` passes.
  - **With the prototype:** exit 0. 176/176 and 37/37, including the production-`docker`
    fixture that can only run on Linux.
  - **One check differs from Windows** (90 vs 89 at the fork point). In Linux, the verifier's
    own `git status` also goes through the test's `git` shim. At the fork point the entrypoint
    makes no decision call, so the verifier takes the injected failure and the task ends 30 —
    still red, honestly. With the change in place, the decision takes it first.
- **Pre-existing host failures, unrelated.** On this Windows host, the older frozen tests that
  drive the entrypoint under `bash` (`repo-1cy`, `repo-52m`, `repo-wxh`) fail identically on
  the clean committed code. They are written for the Linux task container, so they have not
  been run against the prototype anywhere yet. That is review step C7.1.
  `repo-cl9/post-doc.js`, `repo-zdm`, and the unit suites `done-earned`, `concurrency` and
  `pause-gate` stayed green with the prototype applied.


Freeze gate, last run 2026-11-03 at freeze, after the rename, against this worktree (fork
point = `main` at `e080e09`):

```
freeze-gate: tests/acceptance/repo-xwx/
  real run     exit 1
  control run  exit 0   (tests/acceptance/_control/ — one passing test)

RED: the tests FAIL against the fork point, and the harness reports green on the control
The tests discriminate: they can detect the thing they exist to catch.

guards declared: 2   (both lines are criterion C5 — its statement and its coverage row)
```

The same RED result came from the first run, from the re-run after the critic revisions, and
from this run at freeze. At the fork point:
- `entrypoint-skip.js` passed 89 of 147 checks;
- `runner-facts.js` passed 24 of 35;
- `verifier-unchanged.js` passed 3 of 3 (the guard).

Every failing check is a new-behaviour check. Passing at the fork point and expected to keep
passing:
- the re-verify scenarios' exit codes and verifier counts (today's behaviour, C2);
- the "not carried" checks for stuck, not-head and unearned rows;
- the "outcome unchanged" checks.

These are guards inside discriminating files; each file as a whole is red.

## Critic pass (PLANNING.md step 2) and dispositions

**Label:** medium, so one critic: [`advisors/testability.md`](../advisors/testability.md),
run in fresh context with the drafted tests available to read. Verdict: `concerns`, with ten
findings. All ten were accepted and resolved.

1. **The tests ran the entrypoint under `sh` (dash in the container), while production uses
   `bash`, and printed no entrypoint output on failure.** **Accepted.**
   - The test now launches it with `bash`, and prints the entrypoint's output and
     `status.json` for any failing scenario.
   - "Shell is bash" is now a constraint.
   - It is now proven in a Linux container: red at the fork point and green with the
     prototype (see Evidence).
2. **The "fail closed" constraint had no test.** A `$(git status 2>/dev/null)` that fails
   prints nothing and reads as clean. **Accepted.**
   - New criterion C8.
   - A `git` shim fails exactly one `status` or `rev-parse` call; the test expects a
     re-verification, and checks that the failure was actually used up.
3. **The porcelain check was never isolated.** Every "changed" fixture also moved `HEAD`, so
   `git diff --quiet HEAD` would have passed. **Accepted.** Added failed-docs-phase fixtures
   that leave an untracked file and a staged-but-uncommitted edit (C2, C3).
4. **The done/partial gate had no discriminating fixture.** **Accepted.**
   - A `partial` row must carry `verifiedCommit`.
   - An exit 0 that the earned-success check turns into `failed` must not.
5. **The production `docker` path (seam unset) was never exercised, and fails silently by
   design.** **Accepted.**
   - A Linux-only fixture puts an executable `docker` stub on `PATH`. It prints a `NOTE` on
     Windows, where the stub cannot be spawned.
   - Review step C7.3 checks one real row after the first real run.
6. **The in-run half of C7 checked nothing about existing coverage.** **Accepted.**
   - C7 is restated as a named three-step review procedure. It lists the Docker-free tests
     that drive the changed code, to be run in Linux.
   - It names `repo-1cy`'s "runner unchanged" check as the one expected failure, and the token
     the runner suites need.
7. **"Before each launch" and "last launch" were not discriminated, and the junk output had
   no `sha256:` prefix.** **Accepted.**
   - A relaunch fixture: exit 20 on the first launch, then 0, with a different id per read.
     The test expects two reads and the second id.
   - Added `sha256:abc` and a warning-line-then-id output.
8. **The child processes inherited the whole environment.** `RUN_DIR` or `GIT_*` would
   redirect writes into an outer task. **Accepted.** Both tests strip `GIT_*`, `RUN_DIR`,
   `PIPELINE_*`, `WORKSPACE`, `ISSUE_ID` and `NODE_OPTIONS`, and set what they need
   explicitly.
9. **The status-schema check compared values against the schema the implementation itself
   writes.** **Accepted.** It now probes with fixed strings, the same way the run-schema check
   already did.
10. **"Absent on every other path" was proven only as "never written".** **Accepted.**
    - Two fixtures plant a plausible `verifiedCommit` in `status.json`, then fail dirty or
      break the tests. The test expects the key gone.
    - "Clear before deciding" is now a constraint.

## DESIGN.md change-log row (draft — the task agent writes the real one)

> | 2026-11-0x | `repo-xwx` | **the final re-verification is skipped when the docs phase left the tree unchanged** (§4.3, §4.11, §4.12; amends `repo-cl9`). `pipeline/entrypoint.sh` records the passing commit's `HEAD` and tree; after the docs phase it skips the second `verify.js` run only when `HEAD`, `HEAD^{tree}` and an empty `git status --porcelain` all show nothing changed. Any git error, and any change at all (documentation included), re-verifies exactly as before. `status.json` gains `finalVerification` (`skipped-unchanged`/`ran`) and `verifiedCommit`. The runner copies `verifiedCommit` onto the `run.json` row only for a done/partial task whose branch head it equals, and records `imageId` from `docker image inspect` before each launch (seam `PIPELINE_DOCKER_CMD`). Both are evidence only. `verify.js` is unchanged. Frozen suite `tests/acceptance/repo-xwx/` | On five consecutive real tasks the docs phase changed nothing, yet the second verification cost 8–17 minutes each. The re-verification exists to stop a docs-phase edit inheriting an earlier pass. When the tree is byte-identical there is nothing for it to see, so skipping it weakens nothing (hard rule 2). The tree and `HEAD` are compared, never the docs agent's own report, because the agent is the party being checked. `HEAD` is compared as well as the tree so that `verifiedCommit` is always the commit under review. The two facts let a target's own pre-merge check skip work the verifier already proved, without that check having to trust anything the container wrote. **Accepted residual risk:** a file git ignores, if the docs phase creates or edits it, is not seen by the skip rule, though the old re-verification would have caught it. Asked "Do you accept that the skip can't see files git ignores, with no extra check added?", the user answered "yes, approved" (2026-11-03). They were told it is unlikely, because the docs step may only edit listed documentation files, and that the cost if it happened is one task merged without its second check |
