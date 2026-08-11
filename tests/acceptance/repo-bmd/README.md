# repo-bmd — frozen acceptance tests: the `phase` field in `status.json`

Spec: `docs/planning-draft-2026-08-10.md`, Task 1 (design-ref `DESIGN.md` §5,
change-log row `live-dashboard`). One file, `test.js`, runs via
`sh tools/run-acceptance.sh tests/acceptance/repo-bmd/`. Docker-free; every fixture
value is invented and every temp dir lives under the OS temp dir.

Criterion → checks (names as printed, prefixes):

| Done means | Checks |
|---|---|
| 1. Written at each boundary, observed from inside the phase | `C1 rig run exits 0`, `C1 rig: all three in-phase snapshots`, `C1 snapshot ... code/verify/docs`, `C1 final status.json reads phase "docs"`, `C1 ... prompt` (header intact, phase write nowhere in it) |
| 2. Every exit path carries the last phase; closed vocabulary | `C2 fail drive (cap 1)` 10/verify, `C2 tamper drive` 11/verify, `C2 rate-limit drive` 20/code, `C2 docs-fail drive` 0 + `docsPhaseError` + docs, `C2 every observed phase value ...` |
| 3. A relaunch overwrites a stale phase | `C3 run 1` (10, 1 attempt, verify), `C3 run 2` (20, code, attempts still 1) |
| 4. Allowlisted key; schema stays additive | `C4 'set phase code' exits 0`, `.phase === "code"`, `'set phaze code' still exits 2`, schema enum / `required` / `additionalProperties`, four admitter probes |
| 5. Phase writes cannot fail a task | `C5 task still reaches its normal exit 0 while every 'set phase' write fails` AND `C5 at least one 'set phase' invocation was observed` (wrapper `status.js` records calls and fails `set phase`) |

The rig is the spec's pinned one: `bash pipeline/entrypoint.sh` spawned with a
replaced environment of exactly `PATH`, `HOME`, `WORKSPACE`, `PIPELINE_DIR`,
`ISSUE_ID`, `PIPELINE_AGENT_CMD`, `PIPELINE_MAX_ATTEMPTS`; a loud bash probe first;
temp `PIPELINE_DIR` holding copies of the real `status.js` + `envelope.js` and a stub
`verify.js`; shell agent stubs through the `PIPELINE_AGENT_CMD` seam.

Written red-first: before implementation the suite fails on exactly the
feature-shaped checks (phase missing from snapshots, `set phase` exiting 2, schema
lacking the key, zero `set phase` calls observed).
