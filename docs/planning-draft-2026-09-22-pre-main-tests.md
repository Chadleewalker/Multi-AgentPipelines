# V1 pre-main test-driver alignment — approved scope

## Intent
Correct the two false-red local host suites found in the pre-main sweep. Preserve the runtime gates and queue semantics.

## Constraints
Allowed implementation files: scripts/test-entrypoint.sh, scripts/test-runner-queue.sh.
Do not change runner, verifier, schemas, entrypoint, pipeline config, or other product files. Use a local-only V1 task and keep shared main unchanged until validation and review.

## Done means
1. T8 validates scenario status files against status.schema.json and the docs-build verifier file against verify.schema.json; the scenario count excludes that verifier file and T8 passes on this host.
2. T12 commits a valid legacy pipeline.config.json into its synthetic target before the initial fork. With that config, its queue, outcome, and pause assertions execute and T12 passes on this host.
3. T12's run capture works on Windows without /dev/stderr while retaining live output and the runner's exit code.
4. The frozen repo-cl9 through repo-cl13 gate suites pass. The existing disposable-fixture check is run with the local config already present on this PC; the live GitHub-mutating e2e suite stays excluded.

Difficulty: trivial. Design refs: DESIGN.md §§4.3, 4.5, 4.10, 4.11, 4.12.

Acceptance evidence: the frozen repo-cl13 check discriminates the stale driver source. Before main changes, run `bash scripts/test-entrypoint.sh` and `bash scripts/test-runner-queue.sh` in the isolated Windows review checkout and require exit 0 with their ALL CHECKS PASSED lines; inspect the T8 schema lines and T12 queue/pause lines. Run `bash scripts/test-fixture.sh` in that checkout after copying the existing git-ignored `run.config.fixture.json` from the primary checkout there, requiring exit 0. Run the configured acceptance command separately for tests/acceptance/repo-cl9/ through repo-cl13/, each exit 0. The user approved this exact two-script expansion in the conversation after the 30/33 pre-main sweep.

Critic dispositions: C1-C4 accepted as host promotion gates. The frozen source check is preliminary because Docker-backed T8/T12 cannot run inside the task verifier. The host scripts and observed outputs decide completion; any new runtime failure stops promotion.
