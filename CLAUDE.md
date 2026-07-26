# Multi-Agent Pipelines

A pipeline that works through a queue of development tasks autonomously, each in a
locked-down Docker container, and hands back pull requests plus a run report. The user
approves intent before a run and reviews results after; nothing in between is interactive.

This project was created with the Universal AI Harness. The line below automatically
loads the master rules every session — don't remove it.

@C:\Code\New Project Start\Harness_Pipeline\CLAUDE.md

## Read these first, in this order

| File | What it is |
|---|---|
| `DESIGN.md` | **Authoritative.** Every architectural decision and why, the outcome contract, the change log. When reality disagrees with it, amend it — never silently ignore it. |
| `docs/STATUS.md` | Where the build actually is, what's proven, known gotchas, what's next. Start here to pick up the thread. |
| `PLANNING.md` | The playbook for a planning session: how a task spec and its frozen tests get written and approved. |
| `docs/pipeline-diagram.md` | The same design as diagrams. |

`DESIGN.md` is long. Section 4.11 (the outcome table) and section 3.1 (the three levels:
design doc → Beads issue → frozen tests) carry the most weight per line.

## Hard rules — violating these breaks the design, not just the code

These are invariants, not preferences. Each exists because removing it makes the
pipeline unable to be trusted unattended.

1. **The host is the only writer to the task queue.** The container has no `bd` access.
   If it wrote to Beads, those writes would land on a task branch that may never merge,
   and the work queue would fork along with the code.
2. **Never weaken verification.** The verifier is deterministic scaffolding, never an
   LLM. It reads its config from the *fork-point commit*, not the working tree, and it
   diffs every frozen path before trusting any test result. An agent that can edit the
   thing that judges it is not being judged.
3. **Planning is interactive; implementation is autonomous.** Specs and tests are written
   with the user and frozen before a run. Nothing during a run may change what "done"
   means. A task that needs the spec changed is a result to report, not a thing to fix.
4. **The user approves *what*; the AI owns *how it's verified*.** Don't ask the user to
   choose test frameworks or implementation approaches. Do get explicit approval of the
   plain-English "Done means" list before anything is frozen.
5. **A specialist agent is never a gate.** Domain critics run at planning time; run-time
   advisors attach notes as evidence only. An LLM judge that can fail a task voids the
   three-attempt cap and produces unactionable overnight failures. (DESIGN.md §3.5.)
6. **The container gets exactly one credential and no route out** beyond the enumerated
   Anthropic endpoints. Don't add egress to make something convenient — bake
   dependencies into the image at planning time instead.
7. **No LLM in the runner, the verifier, or the report generator.** Control flow,
   timeouts, and outcomes are deterministic. Agents do fuzzy work only.

## Environment (this machine)

- **Windows 11 + Docker Desktop.** Docker Desktop must be running; the runner asserts it
  and fails fast.
- **Use Git Bash, never WSL.** The WSL distro has no Docker Desktop integration.
- **MSYS path conversion will bite you.** Git Bash rewrites container-side paths in
  `docker` arguments (`-w /repo` becomes `C:/Program Files/Git/repo`). Any script that
  invokes docker with container paths needs `MSYS_NO_PATHCONV=1` and `cygpath -m` on
  mount sources. This has broken two scripts already.
- **Node for everything.** `node` is the same command on Windows and Linux; the runner is
  plain JavaScript with zero dependencies.
- **Secrets:** the Claude subscription token lives in `.env.pipeline` at the repo root.
  It is git-ignored and has never been committed — keep it that way. It is passed to
  containers by name at `docker run`, never baked into an image.

## Running things

```bash
# a real run against a target project
node runner/run.js --config run.config.hallertau.json

# prove the whole pipeline end to end (stubs, no model calls, ~5 min)
bash scripts/e2e.sh            # add --keep to leave branches and PRs up for inspection

# individual suites — see docs/STATUS.md for the full list
bash scripts/test-verifier.sh
bash scripts/test-runner-container.sh
```

Suites are slow (real containers) and **share one Docker network** — run them one at a
time, never concurrently, or they tear the network down under each other.

## Changing the design

If something here turns out to be wrong, amend `DESIGN.md` and add a row to its change
log saying what changed and why. Four amendments came out of the first real runs; that
trail is how a later session knows a decision was deliberate rather than accidental.

## Working inside the pipeline container (read this when you are the coding agent in a run)

This repo is onboarded as a target of its own pipeline (dogfooding — see the DESIGN.md
change log). If you are reading this from `/workspace` inside a task container, you are
the pipeline working on the pipeline's own code. The rules:

- This is a locked-down Docker container: the network reaches Anthropic endpoints only.
  No package installs, no web lookups — everything you need is in this repo, the issue
  file, or the memory file.
- Your task is `/workspace/.run/issue.md`; project memory is `/workspace/.run/memory.md`
  (present only when the host had memories to export, and injected into your prompt when
  it is). Both are read-only exports — use them, don't edit them.
- NEVER touch `tests/acceptance/` or any path in `pipeline.config.json`'s `frozenPaths`.
  The verifier diffs them against the fork point; any change — even whitespace — ends
  the task as "tampered".
- The frozen verifier decides pass/fail, not you. Run the acceptance tests while you
  work (`sh tools/run-acceptance.sh tests/acceptance/<issue-id>/`), but the
  authoritative check runs after you exit. You cannot run Docker in here, so the repo's
  `scripts/test-*.sh` suites will not work — do not try; the acceptance tests for your
  task are Docker-free by design.
- You cannot push (no credentials, no git-host network). Commit locally at every
  meaningful boundary; the host pushes your branch after the container exits.
- The `bd` quick-reference below is for interactive host sessions — in here you have no
  Beads database and must not try to create one. Insights worth keeping go in the status
  file instead: `node /pipeline/status.js note "<insight>"` appends one, and the host
  files it after you exit. You propose; the host commits. Notes are advisory — they can
  never change your outcome, and past 20 the call is silently a no-op.


<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:6cd5cc61 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.

## Agent Context Profiles

The managed Beads block is task-tracking guidance, not permission to override repository, user, or orchestrator instructions.

- **Conservative (default)**: Use `bd` for task tracking. Do not run git commits, git pushes, or Dolt remote sync unless explicitly asked. At handoff, report changed files, validation, and suggested next commands.
- **Minimal**: Keep tool instruction files as pointers to `bd prime`; use the same conservative git policy unless active instructions say otherwise.
- **Team-maintainer**: Only when the repository explicitly opts in, agents may close beads, run quality gates, commit, and push as part of session close. A current "do not commit" or "do not push" instruction still wins.

## Session Completion

This protocol applies when ending a Beads implementation workflow. It is subordinate to explicit user, repository, and orchestrator instructions.

1. **File issues for remaining work** - Create beads for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Handle git/sync by active profile**:
   ```bash
   # Conservative/minimal/default: report status and proposed commands; wait for approval.
   git status

   # Team-maintainer opt-in only, unless current instructions forbid it:
   git pull --rebase
   git push
   git status
   ```
5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step

**Critical rules:**
- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.
<!-- END BEADS INTEGRATION -->
