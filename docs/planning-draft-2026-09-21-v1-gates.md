# V1 final build and file-scope gates — draft

## Problem

The Deep End splash task passed V1 acceptance while its production TypeScript build failed. V1 then let its documentation phase commit a file outside the task's explicit allowed-file list and published a successful PR.

## Done means

1. A target may declare a `buildCommand` in the fork-point `pipeline.config.json`. V1 runs it as a required gate after acceptance. A failed build gives the coding agent its output and cannot produce a successful PR. Projects without `buildCommand` retain their current behavior. Worktree edits to the command or its frozen helpers cannot weaken the gate.
2. After the documentation phase, V1 verifies the final branch again. A docs-phase change to source, tests, config, or build inputs cannot inherit an earlier pass.
3. A target may set `scopePolicy: "required"` in its fork-point config. A task then needs one explicit `Allowed implementation files:` list in its Constraints section. Missing, malformed, duplicate, or unsafe paths fail before agent work. The host compares the final branch to its fork commit, including committed, uncommitted, untracked, deleted, and renamed paths. Exact listed files alone may change.
4. An out-of-scope final branch has no Git push and no PR. V1 keeps local evidence, names the offending paths in the run report, and blocks the issue. A target without required scope policy still enforces a valid explicit list when one is present, preserving legacy tasks that contain none.
5. Deep End opts into both gates with `cd frontend && pnpm build` and required file scope. Its build script and TypeScript configuration are frozen at the task fork point. Its current open PR #62 and both repositories' integration branches stay unchanged until separately reviewed.

## Tests

- Verifier fixtures: passing, failing, absent, and worktree-tampered build commands; build failure output reaches the next attempt.
- Entrypoint fixture: docs phase breaks a build after an initial pass; final outcome is failure, with no successful PR.
- Host publication fixtures: exact allowed changes pass; added, modified, deleted, renamed, and untracked disallowed files prevent all remote publication and appear in evidence. Missing or malformed required lists fail before a model call.
- A clean Deep End fork runs its real `pnpm build` in the sealed target image.

## Constraints and risks

- V1's regression command remains evidence only. The new build check is a separate required gate.
- Existing target projects without the new config fields retain their current semantics, except that an explicit file list is enforced.
- Deep End's currently ready queue is empty, so enabling required scope does not strand a queued task. Future issues need a precise file list at planning time.
- Running verification after docs increases per-task time. It is necessary because that phase can change source after the initial pass.
- V1's previous rule pushes WIP branches on failure. A scope violation is a narrow exception: local evidence is retained, but the unauthorized bytes are not pushed to GitHub.

## Review disposition

- Accepted: keep the build command in fork-point target config; do not infer a build from package files.
- Accepted: gate the final branch after docs; an earlier verifier pass cannot certify later edits.
- Accepted: suppress every remote push for a scope violation and retain local evidence.
- Accepted: require a structured, explicitly labeled list where the target opts in; never treat a design reference as edit permission.
