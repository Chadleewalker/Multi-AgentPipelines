# Frozen acceptance tests

Tests land here during planning (PLANNING.md step 6), one directory per Beads issue
(`tests/acceptance/<issue-id>/`), and are committed to `main` **before** the run. The
verifier diffs this whole tree — plus everything in `pipeline.config.json`'s
`frozenPaths` — against the task branch's fork point; any change during a run, by
anyone, is the "tampered" outcome (DESIGN.md §4.4).

Self-hosting constraint: task containers cannot run Docker, so tests here must be
plain Node or shell checks (run a script, validate a schema, inspect a file) — never
`docker run`. Pipeline work that only the Docker suites can verify stays interactive.

Each test file is executed by `tools/run-acceptance.sh`: `*.sh` via `sh`, `*.js` via
`node`, in name order; any non-zero exit fails the task.
