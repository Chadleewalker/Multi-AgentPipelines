# Planning draft 2026-11-03: skip the final re-verification when the docs phase changed nothing

**Status:** the direction and the seven-point "Done means" list are both approved. The user was
asked "Do you approve the seven-point Done-means list for the pipeline speed-up?" and answered
"yes, approved" (2026-11-03, about 15:05).
- Before the approval he was shown the safety plan: going live only when no run is in progress,
  and a GitHub account switch kept to the publish step.
- The freeze, the run and the merge are each still a separate approval.

This draft is kept in the git-ignored `runs/` folder for now. The session guard refuses this
session's writes into a new worktree. At freeze it moves into a worktree, which a session opened in
that folder commits. Nothing is built while a run against any target is in progress.

## The direction, in the user's words

The user was asked: "For the pipeline saving, do you approve the safe version: skip the second
verification only when the documentation step changed nothing, built after the overnight batch?"
He answered: "yes, approved" (2026-11-02).

He also approved recording what a target's host-side check needs in order to skip work the
verifier already proved: "let's do both of those time savings" (2026-11-02).

## Why

`pipeline/entrypoint.sh` always runs `verify.js` a second time after the docs phase (lines
206–235, change-log row `repo-cl9`). That second run exists because the docs phase can change
source, tests, config or build inputs after the passing verification.

On five consecutive real tasks (2026-11-03), the docs phase changed no file. Even so, the stretch
from the first pass to the end of the run took 8, 8, 8, 12 and 17 minutes. Most of that is the
second verification. A task whose "Allowed implementation files" list names no documentation file
is told to make no edits in the docs phase, so "changed nothing" is the usual case.

## The rule

The final re-verification is skipped only when the tree after the docs phase is byte for byte the
tree the passing verification certified. Both of these must hold:
- `git rev-parse HEAD^{tree}` after the docs phase equals the tree of the commit made straight
  after the passing verification;
- `git status --porcelain` is empty.

Anything else re-verifies exactly as today, including a change to documentation only. Some tests
read documentation files (this repo's change-log checks do), so a documentation-only edit can still
break a test.

This does not weaken verification (hard rule 2). The skip happens only when there is nothing new to
verify. The verifier itself, its fork-point config and its frozen-path diff are unchanged.

## Proposed "Done means" (plain English, for the user's approval)

1. **When the docs phase changes nothing, there is no second verification.** The task's outcome is
   the first verification's pass. The run log and the status file say the re-verification was
   skipped because the tree was unchanged.
2. **When the docs phase changes anything at all, the final re-verification runs exactly as today,**
   with today's outcomes: pass, tampered, failed or internal error. "Anything" covers a committed
   file, an uncommitted file, and a new or deleted file, documentation files included.
3. **A failed docs phase behaves as today.** The existing "success stands" behaviour is unchanged.
   - If the docs phase left the tree unchanged, there is no re-verification.
   - Otherwise there is a re-verification, as today.
4. **The decision compares trees, and never trusts the docs agent's own report.**
5. **`verify.js` is not changed.**
6. **A finished task's records carry two new facts,** where a target's host-side check can read
   them. They are evidence only and change no outcome.
   - `verifiedCommit`: the full sha of the commit the final passing verification ran on. When the
     re-verification is skipped, that is the first verification's commit, which is the PR head.
   - `imageId`: the id (`docker image inspect --format {{.Id}}`) of the image the task container
     ran.

   The entrypoint or the runner writes them, never `verify.js`.
7. **Every existing suite that covers the entrypoint still passes,** plus one new check that proves
   both branches: an unchanged tree skips, and any change re-verifies.
   - The suites are `scripts/test-entrypoint.sh` (driving `scripts/entrypoint-checks.sh`,
     stub-driven scenarios including the docs-build one) and the runner container suites.
   - The new check is stub-driven like the existing scenarios, and makes no model call.

## Answered while planning

- **No image rebuild for any target.** `runner/container.js` mounts the host's `pipeline/` folder
  into every task container read-only (`-v …:/pipeline:ro`). So a merged change reaches every
  target on its next run, with no image rebuild and no per-target step.
- **Where the change lives:** `pipeline/entrypoint.sh` for the skip, plus whichever of the
  entrypoint or the runner writes the two facts. This is decided at the freeze.
- **Records:** a `DESIGN.md` change-log row amending `repo-cl9`, and `docs/pipeline-diagram.md` if
  the drawn docs-phase path changes.

## Not in this task

- Any change to how a target's host-side check uses the two facts. A target's own rule decides
  that. It skips nothing until the facts exist, and it stays the target's responsibility.
- Skipping the first verification, or the docs phase itself.
