# Deterministic agent stubs

Scripted stand-ins for the coding agent, substituted through the `PIPELINE_AGENT_CMD`
seam (DESIGN.md §4.3) — set as `agentCommand` in a run config, or exported directly.

They live under `pipeline/` because that directory is the scaffolding the runner
bind-mounts read-only at `/pipeline` in every task container (§4.10). That is the only
way a stub can be reachable from inside without inventing a new mount and widening the
container's input contract. They are inert: nothing runs them unless the agent command
explicitly points at one.

They exist because the end-to-end pass (§7) must be **deterministic**: a real model
cannot be relied upon to fail three times in a row, or to tamper with a frozen test on
cue, and burning subscription window to find out is wasteful. Each stub makes **zero
model calls**.

Every stub reads the prompt on stdin (the entrypoint pipes it there) and acts inside
`/workspace`. The docs phase reuses the same command, so stubs that need to behave
differently there branch on the prompt text (`"change summary"` appears only in the
docs prompt).

| Stub | Behaviour | Proves |
|---|---|---|
| `success.sh` | Implements the fixture's shout mode; prints a change summary in the docs phase | exit 0 → `done`, PR opened |
| `bail.sh` | Writes scratch notes, never satisfies the tests | 3 attempts → exit 10 → `stuck`, WIP pushed, no PR |
| `tamper.sh` | Edits the task's frozen acceptance test instead of implementing | verifier catches it → exit 11 → `tampered` |
| `ratelimit.sh` | Emits a usage-limit line with a reset epoch, then succeeds after resume | exit 20 → pause → relaunch → attempt counter carries over |

Usage:

```bash
# in a run config
"agentCommand": "sh /pipeline/stubs/success.sh"

# or ad hoc
PIPELINE_AGENT_CMD="sh stubs/bail.sh" node runner/run.js --config run.config.fixture.json
```

`ISSUE_ID` is available to every stub, which is how `tamper.sh` locates the frozen test
it is supposed to (wrongly) edit.
