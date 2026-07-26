# Multi-Agent Pipelines

A pipeline that works through a queue of development tasks autonomously, each in a
locked-down Docker container, and hands back pull requests plus a run report. The user
approves intent before a run and reviews results after; nothing in between is interactive.

This project was created with the <project harness>. The line below automatically
loads the master rules every session — don't remove it.

@<local path>\Harness\CLAUDE.md

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
node runner/run.js --config run.config.example.json

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
