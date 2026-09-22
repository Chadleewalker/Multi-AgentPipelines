# V1 test fixture alignment — draft for approval

## Intent
Make the two existing regression scripts pass when the runner and report behave as already approved. This is test maintenance only.

## Constraints
- Allowed implementation files: scripts/test-runner-workspace.sh, scripts/test-report.sh.
- Preserve the runner, verifier, report generator, pipeline config, and frozen gate suites.
- Use only local temporary Git remotes and fixtures; do not publish or change either shared main branch.

## Done means
1. T13 commits a valid legacy `pipeline.config.json` with `verifyCommand`, `frozenPaths`, and `dependencies` into its synthetic target before the runner forks it, so the stubbed normal and no-work cases can execute under the fail-closed config gate.
2. T13 captures the clone-failure run without `/dev/stderr`, and its assertions pass on this Windows host.
3. T17 expects `not pushed — file-scope violation` for its scope-blocked synthetic task, and its existing report assertions pass.
4. The frozen repo-cl9, repo-cl10, and repo-cl11 gate suites remain green.

Difficulty: trivial. Design refs: DESIGN.md §§4.2, 4.5, 4.9, 4.12.

Acceptance evidence: the frozen repo-cl12 check detects the stale fixture and assertion; final evidence requires direct host runs of T13, T17, and the repo-cl9, repo-cl10, and repo-cl11 gate suites, with exit codes and results recorded. The test-only candidate stays isolated until review.

Critic dispositions: A1 accepted — require realistic config keys and a direct T13 run. A2 accepted — direct Windows T13 run must check the clone-failure case. A3 accepted — direct T17 run must check the report assertion. A4 accepted — record separate gate-suite results. The frozen check is preliminary; host regression results decide completion.

