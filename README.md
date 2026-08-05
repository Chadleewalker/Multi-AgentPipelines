# Multi-Agent Pipelines

Queue up development tasks. The pipeline works through them unattended — each task in its
own locked-down container — and hands back pull requests plus a report, ordered by how
much scrutiny each one needs.

Your time goes into two moments: approving what gets built before a run, and reviewing
what came back after. Nothing in between is interactive.

**Status:** V1 complete and proven end to end. Shadow-mode trial underway on a real
project. See [`docs/STATUS.md`](docs/STATUS.md).

## How it works, briefly

Three phases joined by a task queue:

1. **Planning** (with you) — a design doc is decomposed into task-sized specs. Critics
   attack each spec, acceptance tests are written *before any code exists*, you approve
   the plain-English "Done means" list, and then the tests are frozen.
2. **Implementation** (autonomous) — a plain script on your PC works through the queue.
   Each task gets a fresh container that can reach nothing except three Anthropic
   endpoints, holds no git credentials, and cannot edit its own tests. It writes code,
   the verifier runs the frozen tests, and it retries at most three times.
3. **Review** (with you) — verified work arrives as a pull request carrying the spec, a
   change summary, and the verification evidence. Failed work arrives as a pushed branch
   with its full attempt history.

The design's central bet: **an agent never judges its own work.** Verification is a
deterministic script running tests that were frozen before the code was written.

[`docs/pipeline-map.html`](docs/pipeline-map.html) and
[`docs/pipeline-diagram.md`](docs/pipeline-diagram.md) show this visually.

## Quick start

Requires Docker Desktop running, Git Bash (not WSL), Node, and `gh` authenticated.

```bash
# 1. put your Claude subscription token where the runner can find it
#    (git-ignored; get one with `claude setup-token`)
echo 'CLAUDE_CODE_OAUTH_TOKEN=...' > .env.pipeline

# 2. prove the whole thing works, using scripted stubs — no model calls
bash scripts/e2e.sh

# 3. point a config at a project of your own, then run its queue
#    (run.config.*.json is git-ignored — it names a local path and your remote;
#     the <project> segment also names that run's own network and proxy, so two
#     projects can be in flight at once without disturbing each other. Two runs
#     against the *same* project cannot: the second is refused by name before
#     anything starts, and a lock left by a killed run is taken over. Within one
#     project the runner works one task at a time; set `concurrency` (up to 3) to
#     put that many containers in flight at once for a daytime batch. A usage
#     limit parks the whole run, not each task: one shared wait, and no new task
#     launches while the window is closed.)
cp run.config.example.json run.config.myproject.json
node runner/run.js --config run.config.myproject.json
```

Adding a project of your own means giving it a `pipeline.config.json`, a thin Dockerfile
on the shared base image, and `bd init` — [`PLANNING.md`](PLANNING.md) walks through it.

## Layout

| Path | What's in it |
|---|---|
| `DESIGN.md` | the authoritative design — decisions, contracts, change log |
| `PLANNING.md` | how a spec and its frozen tests get written and approved |
| `docs/STATUS.md` | current state, gotchas, what's next |
| `advisors/` | the specialist registry — one charter per critic/advisor lens |
| `runner/` | the host-side orchestrator — plain JavaScript, no dependencies, no LLM |
| `pipeline/` | what runs *inside* a container: entrypoint, verifier, agent stubs |
| `schemas/` | the three frozen contracts between separately-built components |
| `docker/` | the pinned base image and the allowlist proxy sidecar |
| `scripts/` | one test suite per build task, the end-to-end pass, and the host-side readers — `audit-runs.js` joins every past run and prints one report, changing nothing |
| `tests/` | `acceptance/` — per-task tests, frozen at approval; `unit/` — Docker-free suites |
| `beads/` | the task-queue issue template |

## Design constraints worth knowing before changing anything

- The host is the only writer to the task queue.
- The verifier is a script, never an LLM, and reads its config from the commit the branch
  forked at — not from the working tree an agent can edit.
- Specs and tests are frozen before a run; nothing during a run can change what "done"
  means.
- A specialist agent may advise, never gate.
- The container gets one credential and no route out beyond the Anthropic endpoints.

`CLAUDE.md` states these as hard rules with the reasoning behind each.

## License

Copyright 2026 Chad Walker

Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE) and
[NOTICE](NOTICE) for details.
