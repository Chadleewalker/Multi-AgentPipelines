# Multi-Agent Pipelines

This repository runs approved development tasks autonomously in locked-down containers
and returns reviewable branches, pull requests, and evidence.

## Read first

Read `docs/control-plane.md` first. It defines source authority and the current operator
and agent paths without copying mutable runtime policy into prose.

- `contracts/control-plane.json` owns stable enumerated control-plane policy.
- `schemas/*.schema.json` own persisted artifact shapes.
- A target's `pipeline.config.json` owns its verifier, regression policy, and frozen paths.
- `DESIGN.md` owns architectural rationale and the change-log convention.
- `PLANNING.md` owns interactive planning and freeze workflow.
- `docs/change-log.md` and `docs/STATUS.md` are historical records, not live config.

## Hard invariants

1. The host is the only Beads writer and the only holder of Git publication credentials.
2. Verification is deterministic and reads policy from the immutable fork point. Never
   weaken frozen-path checks or let an implementation edit what judges it.
3. Planning is interactive; implementation is autonomous. A bad frozen spec is reported,
   not rewritten during a run.
4. Specialists provide evidence and critique; an LLM is never a runtime gate.
5. Containers receive one model credential and reach only allowlisted model endpoints.
6. The runner, verifier, and report generator contain no LLM decision-making.
7. Repository identity, ownership, and publication gates fail before external mutation.

## Working-tree safety

Assume other work exists. Use one worktree per interactive session. Stage named paths;
never use `git add -A`, `git add .`, or `git commit -a`. Never discard, stash, clean, or
rewrite work you did not create. If unrelated changes overlap the task, stop and report
them. Launch pipeline runs only from the main checkout so the host-local `runs/` corpus
and lock observer mirror remain coherent.

Fresh-context subagents are pre-authorized only for the independent spec draft and critic
panel steps explicitly required by `PLANNING.md`. This is not authorization to fan out
ordinary implementation work.

## Reference host

The proven host is Windows with Docker Desktop. Use verified Git Bash, not WSL. Docker
commands that carry container paths need `MSYS_NO_PATHCONV=1`; mount sources use
`cygpath -m`. Runner code is dependency-free Node. The subscription token remains in the
git-ignored `.env.pipeline` and is passed by name, never baked into an image.

## Commands

```bash
# mandatory Docker-free publication profile; the executable owns the roster
bash scripts/test-ci.sh
bash scripts/test-ci.sh --list

# sequential host sweep and stubbed end-to-end exercise
bash scripts/test-all.sh
bash scripts/e2e.sh

# run and observe
node runner/run.js --config run.config.<project>.json
node scripts/dashboard.js
node scripts/audit-runs.js
node scripts/batch.js pending
node scripts/batch.js show
node scripts/verdict.js pending

# isolate interactive sessions
node scripts/worktree.js new <idea-name>
node scripts/worktree.js list
node scripts/worktree.js remove <idea-name>
```

Do not maintain an individual test list here. Select a focused wrapper from
`bash scripts/test-ci.sh --list`, then run the complete mandatory profile. Docker-backed
suites run sequentially through `scripts/test-all.sh`; do not run them concurrently.

## Code conventions

- Parse agent output structurally with `pipeline/envelope.js`; never scrape known chatter.
- Assert artifact values, not merely file presence. Plausible but wrong evidence is the
  dangerous failure mode.
- Route every runner Beads call through `runner/bd.js`; keep it synchronous and bounded.
- Handle CRLF at parser boundaries, never by normalizing frozen verifier inputs.
- Invoke executable test seams through `process.execPath` so they behave on Windows.
- Frozen tests inspect the working tree, not commits the host has not created yet.
- Never remove a Docker resource without a before/after ownership proof and an allowlist.
- Public repository fixtures and evidence never name private work or credentials.
- Stable enum-like policy belongs in `contracts/control-plane.json`, not a second source
  literal or a prose table.

## Design changes

Amend `DESIGN.md` when architecture changes and append one new row to
`docs/change-log.md`. Never edit or renumber an existing row. Use the task issue id as the
row's `Ref` when one exists. Cite a row with the literal words `change-log row` followed
by its Ref in backticks. Run `scripts/test-changelog.sh` after either document changes.

## Inside a task container

- Read `/workspace/.run/issue.md` and `/workspace/.run/memory.md`; do not edit them.
- Never touch `tests/acceptance/` or a path frozen by `pipeline.config.json`.
- Run the task's frozen acceptance command while working. The host runs the authoritative
  verifier after exit.
- Docker, Beads, Git credentials, and general network access are unavailable by design.
- Record insights with `node /pipeline/status.js note "..."`.
- Record suspected frozen-spec defects with `node /pipeline/status.js concern "..."` and
  continue with the best implementation the approved spec permits.
- Commit meaningful boundaries locally. The host scans and publishes after exit.

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal -->
## Beads Issue Tracker

Host sessions use Beads for durable task state. Read `.agents/skills/beads/SKILL.md` and
run `bd prime` for the current workflow. Do not create markdown task lists or memory files.
Inside a task container there is no Beads database; use the status note and concern
channels above.

The active profile is conservative/minimal: do not commit, push Git, or synchronize Dolt
unless explicitly authorized. At handoff, report changes, validation, issue state, and any
proposed next commands.
<!-- END BEADS INTEGRATION -->
