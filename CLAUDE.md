# Multi-Agent Pipelines

A pipeline that works through a queue of development tasks autonomously, each in a
locked-down Docker container, and hands back pull requests plus a run report. The user
approves intent before a run and reviews results after; nothing in between is interactive.

## Read these first, in this order

| File | What it is |
|---|---|
| `DESIGN.md` | **Authoritative.** Every architectural decision and why, the outcome contract, the change log. When reality disagrees with it, amend it — never silently ignore it. |
| `docs/STATUS.md` | Where the build actually is, what's proven, known gotchas, what's next. Start here to pick up the thread. |
| `PLANNING.md` | The playbook for a planning session: how a task spec and its frozen tests get written and approved. |
| `docs/IDEAS.md` | The idea inbox — parked "this should probably become a design someday" notes. Costs nothing to add to, commits to nothing, and is where a planning session looks for candidates. Not a backlog: an entry here is not work. |
| `docs/pipeline-diagram.md` | The same design as diagrams — compact mermaid, for someone about to change the code. **Task docs phases keep it current**, so amend it in the same PR that changes the shape it draws. |
| `docs/pipeline-map.html` | The whole system explained for a reader rather than a maintainer: one page, nine diagrams, pan/zoom. Hand-maintained and **not** updated by task docs phases — check it against `DESIGN.md` when you touch it, because nothing else will. |

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

## Environment (the reference host)

Everything below was built and proven on Windows 11 with Docker Desktop. Nothing in the
design requires Windows — the runner is portable Node — but these are the constraints the
code actually encodes, so a port should read them as the list of things to re-check.

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
# a real run against a target project (run.config.*.json is git-ignored — copy the example)
# One run per project: a second one against the same target repo is refused by name before
# anything starts, and a lock left by a killed run is taken over automatically (§4.12).
node runner/run.js --config run.config.<project>.json

# reviewing what a run produced: one line per PR, at the moment the call is made (§5).
# Evidence, never a gate — it edits no existing artifact and exits 0 on findings.
node scripts/verdict.js record <issue-id> <merged|rejected> "<why>"  # [--run <runId>] to override recency
node scripts/verdict.js pending    # PR-bearing tasks with no verdict yet, newest run first

# watching a run happen: a localhost-only pure reader over runs/ (§5, change-log row `repo-kfg`).
# GET /state is the frozen JSON contract, re-read per request; GET / is a placeholder page
# until the view ships. DASHBOARD_RUNS_DIR re-aims the root, DASHBOARD_PORT the port (0 = ephemeral).
node scripts/dashboard.js          # prints one line: dashboard: http://127.0.0.1:4770/

# the full sweep — every suite, one at a time, with a summary table
bash scripts/test-all.sh

# prove the whole pipeline end to end (stubs, no model calls, ~5 min)
bash scripts/e2e.sh            # add --keep to leave branches and PRs up for inspection

# individual suites — see docs/STATUS.md for the full list
bash scripts/test-verifier.sh
bash scripts/test-runner-container.sh

# the fourteen suites that need no Docker — seconds, safe to run anywhere, even in a container
bash scripts/test-runner-memory.sh
bash scripts/test-changelog.sh     # DESIGN.md §12 row identity (CHANGELOG_FILE re-aims it)
bash scripts/test-sanitize.sh      # publication hygiene (SANITIZE_FIXTURE_DIR re-aims it)
bash scripts/test-agent-hooks.sh   # no tracked agent hooks (AGENT_HOOKS_FIXTURE_DIR re-aims it)
bash scripts/test-network-names.sh # per-project network + proxy names (§4.8) reach the scripts
bash scripts/test-lock.sh          # the per-project run lock (§4.12) — refuse, take over, release
bash scripts/test-sweep-hygiene.sh # what the sweep reclaims after a suite, and what it must not touch
bash scripts/test-concurrency.sh   # the §7 concurrency knob — the bound, the worker pool, result order
bash scripts/test-pause-gate.sh    # the §7 run-level rate-limit park — one shared wait, one cap, admission
bash scripts/test-sweep-assertions.sh # the sweep's PASSED column — both vocabularies, one honest total
bash scripts/test-trace.sh         # the traceability ledger — spec-to-code refs, report and backfill (change-log row `trace-ledger`)
bash scripts/test-verdict.sh       # the review verdict recorder — which run a verdict lands in, and what refuses (change-log row `repo-1ie`)
bash scripts/test-audit-runs.sh    # the run-history audit — buckets, joins, channels, quantiles, and that it writes nothing (change-log row `repo-73k`)
bash scripts/test-dashboard.sh     # the live dashboard's /state joins, its degraded vocabulary, and that it writes nothing (change-log row `repo-kfg`)
```

Reading the corpus itself is `node scripts/audit-runs.js` — a pure reader that prints one
markdown report to stdout and changes nothing (DESIGN.md §5). Redirect it if you want a
copy; the report names targets, PR URLs and issue ids, so the copy belongs under the
git-ignored `runs/`, never in the tracked tree.

Suites are slow (real containers) and **share one Docker network** — run them one at a
time, never concurrently, or they tear the network down under each other.
`scripts/test-all.sh` is the safe way to run more than one: it holds a lock, sweeps them
sequentially, kills any suite that hangs (default 900s), and writes per-suite logs plus a
summary to `runs/sweeps/<timestamp>/`. It discovers suites by glob, so a new
`scripts/test-*.sh` is swept without anyone editing anything.

After every suite the sweep reclaims what that suite leaked — and only what it leaked:
`scripts/sweep-reclaim.js` diffs a listing taken before the suite against one taken after
and removes what appeared *and* matches the pipeline allowlist, naming it in the summary
table. Every docker call in `scripts/test-all.sh` goes through `${SWEEP_DOCKER:-docker}`,
which is what lets `test-sweep-hygiene.sh` drive the real sweep with no daemon.

The summary's `PASSED` column counts assertions that *passed*, in both of this repo's
vocabularies — the shell wrappers print `PASS `, the Node checkers under `tests/` print
`ok - `. A log carrying both reports one honest total and never their sum, and a cell
reading `?` means the log carried no countable assertion line at all, which is not a zero.
The decision is `scripts/sweep-assertions.js`; the sweep renders it and nothing more, so no
part of it can reach a verdict (change-log row `repo-0ay`).

**Run the sweep after merging a batch of PRs, before a shadow run, and when picking up a
cold branch.** Suites go stale silently: T12 was never re-run after T15 and T17 changed
the runner underneath it, and had quietly accumulated three separate staleness bugs by
the time anyone looked. Changing a component means the suites that *cover* it are green;
the sweep is what tells you the suites that merely *touch* it still are.

## Code conventions (promoted from memory — §3.6)

Memory notes are an inbox, not a destination. These started as `bd remember` notes
proposed by task agents; each one recurred, or cost a shipped feature, so it has been
promoted here where it steers every future agent with no export step. The originating
note keys are cited so the trail back to the run survives.

- **Never scrape an agent log; parse it structurally.** The Claude CLI prints chatter
  around its own output (untrusted-workspace warnings and whatever a future version
  invents), so a whole-file `JSON.parse` fails and a raw `tail` leaks noise into a PR
  body. `pipeline/envelope.js` scans lines bottom-up for the first that parses to an
  object with a string `result`; reuse it. Never maintain a list of known warning
  strings. (`repo-52m-note-1`, `repo-52m-note-3`; STATUS defect 5.)
- **Assert the artifact is *right*, not merely present.** Anything that swallows an error
  to protect a run — model-id extraction, the memory export, artifact collection — can
  succeed vacuously and disable a shipped feature for months with no error anywhere. Log
  the count, and make it visible where a human already looks. But a non-empty artifact is
  only half the check, because **the harder failures write something plausible and
  wrong**: the resolved model id named the CLI's cheap helper model for every run between
  `repo-52m` and `repo-wxh` (defect 8), and a suite that could not execute its own stub on
  Windows reported every check as a genuine failure rather than as a broken harness. Both
  were non-empty, well-formed, and false. So the assertion has to pin the *value* against
  something independent — the alias the runner actually pinned, a fixture whose expected
  answer differs from what the bug would produce — not just its presence.
  The non-empty half of this rule was itself *filed as a memory and not promoted*, and the
  same defect shipped again two tasks later; the "plausible and wrong" half was added after
  three more instances in one day. (`repo-52m-note-4`; STATUS defects 2, 5, 7, 8.)
- **All runner Beads access goes through `runner/bd.js`** (`bd()` / `bdJson()`). That is
  the seam `PIPELINE_BD_CMD` stubs, and it is the only reason the Docker-free acceptance
  tests can exercise runner code at all. New runner code that shells `bd` directly is
  untestable by construction — and, since change-log row `repo-sls`, unbounded: every
  `spawnSync` in `bd.js` is built from the exported `spawnOptions(cfg)`, whose `timeout` is
  `bdTimeoutMs` (default 60000), so a `bd` that never returns fails loudly instead of parking
  the run. Keep that true in both directions: a new spawn inside `bd.js` uses the builder, and
  `bd()` stays **synchronous** — `spawnSync` blocking the event loop is what stops two Beads
  calls interleaving over one embedded Dolt database, which is what hard rule 1 will rest on
  once tasks run concurrently. (`repo-4gp-note-2`.)
- **Guard line endings at the point of parsing — and nowhere else.** The working copy on
  this machine is CRLF while every container sees LF, so anything that splits lines,
  anchors a regex at `$`, or compares file content has to say so explicitly. The existing
  code already does, and new code must match it: `trim()` each cell or line
  (`runner/workspace.js`, the change-log checker's `cells()`), `\s*$` inside the pattern
  (`runner/config.js`'s token regex — that `\s*` is this defence, not decoration), or
  normalise both sides before comparing (`tests/acceptance/repo-1cy` compares blob to
  worktree with `\r\n` → `\n`, because `git diff --name-only` reports *every* file as
  changed on a CRLF checkout and `--ignore-cr-at-eol` does not help — it affects hunks,
  not name listing).

  **Two places this must never be done.** Not in `pipeline/verify.js`: §4.4 treats any
  difference in a frozen path — whitespace included — as tampering, so normalising there
  would weaken verification (hard rule 2). And not as a shared helper imported by frozen
  acceptance tests: a frozen test that imports mutable code can change what it gates
  without its own frozen text changing, which is exactly what the freeze prevents (§3.1).
  Frozen tests inline what they need. The systemic fix already in place is upstream of
  all of this — workspaces clone with `core.autocrlf=false` and `core.eol=lf`, so the
  container never sees CRLF at all.

- **Never remove a Docker resource you cannot prove you created.** The reference host runs
  unrelated long-lived containers, and `docker`'s `--filter name=` is a **substring** match,
  not a prefix one: `--filter name=task-` force-removed `my-task-runner` and anything else
  whose name merely contains `task-`. Ownership in the harness is a **before/after snapshot
  diff intersected with an allowlist** — absent from the listing taken before the suite AND
  matching a pipeline image, the exact name `pipeline-proxy`, a `task-` prefix anchored at
  position 0, or the `pipeline-net` network. The decision lives in `scripts/sweep-reclaim.js`
  and nothing else in `scripts/` keeps a removal path of its own; a suite that creates
  containers takes a snapshot at its top and reclaims against it in its `EXIT` trap. Two
  rules travel with it: **no baseline, no removal** (a listing that failed is not "nothing
  was here", or the first failed call removes every pipeline container on the machine), and
  **cleanup is never a verdict** — the suite's exit code is captured before any of this runs
  and the reclaimer always exits 0. (change-log row `repo-zje`.)
- **This repo documents the machinery, never the work done with it.** It is public and it
  is used on private work; that one boundary is what lets both stay true. Worked examples,
  findings and fixtures are either generic or name something you are happy to publish —
  "the first real project", never its name. The leaks so far came in as *evidence*, not as
  code: a shadow-trial project named in a change-log row, a side project named in a worked
  example. Don't rely on reading for this — `scripts/test-sanitize.sh` enforces the generic
  half (paths, addresses, credentials) and the host-only `.sanitize-denylist` the naming
  half, and it reads bytes so a file git calls binary cannot hide in it again. Run it
  before you publish anything. (change-log row `publish-sanitize-followup`; STATUS
  "Why it reads bytes".)

## Changing the design

If something here turns out to be wrong, amend `DESIGN.md` and add a row to its change
log saying what changed and why. Four amendments came out of the first real runs; that
trail is how a later session knows a decision was deliberate rather than accidental.
Change-log rows are **chronological ascending** — append a new row at the bottom of the
§12 table, after the newest existing one (`repo-4gp-note-3`).

**A row is identified by a slug in the `Ref` column, never by a version number.** If the
row comes from a pipeline task, the ref *is* that task's issue id (`repo-dhp`) — the host
assigned it, so parallel agents cannot collide because none of them invents its own
identity. If it comes from an interactive session, the ref is a short descriptive
kebab-case name (`default-branch`). Never renumber a row you did not write. Version
numbers already inside a row's prose are history and stay there.

**Cite a row in the pinned form**: the literal phrase change-log row followed by the slug
in backticks — change-log row `repo-52m`. Anything looser is indistinguishable from
ordinary hyphenated prose or from a Beads memory key. `scripts/test-changelog.sh` checks
the table's shape, the slug syntax, uniqueness and every citation in the living docs; run
it after any change-log edit.

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
  task are Docker-free by design. The exceptions are
  `sh scripts/test-runner-memory.sh` (`tests/unit/memory.test.js`), which stubs the whole
  `bd` layer through `PIPELINE_BD_CMD` and needs no Docker — run it if you touch
  `runner/memory.js` — `sh scripts/test-changelog.sh`
  (`tests/unit/changelog.test.js`), which reads markdown only: run it if you add a
  `DESIGN.md` change-log row — `sh scripts/test-sanitize.sh`
  (`tests/unit/sanitize.test.js`), which reads the tracked tree only: run it if you add a
  path, an address or an example naming anything outside this repo —
  `sh scripts/test-agent-hooks.sh` (`tests/unit/agent-hooks.test.js`), also tracked-tree
  only: run it if you touch `.claude/` or `.codex/`, because a committed agent hook runs
  inside this container, where there is no `bd` — and
  `sh scripts/test-network-names.sh` (`tests/unit/network-names.test.js`), which computes
  names and runs a recording stand-in for `scripts/pipeline-net.sh`: run it if you touch
  `runner/config.js`, `runner/preflight.js` or either network script, because a run that
  falls back to the shared network destroys a concurrent run's route out — and
  `sh scripts/test-lock.sh` (`tests/unit/lock.test.js`), which locks temp directories under
  a temp pipeline root: run it if you touch `runner/lock.js`, `runner/preflight.js`'s gate
  order or `runner/run.js`'s exit path, because a lock that stops being the *first* gate,
  or stops being released, either lets two runners drain one queue or blocks the project
  until someone deletes a file — and
  `sh scripts/test-sweep-hygiene.sh` (`tests/unit/sweep-hygiene.test.js`), which drives a
  copy of the real `scripts/test-all.sh` against a recording stand-in for `docker`: run it
  if you touch `scripts/test-all.sh`, `scripts/sweep-reclaim.js` or any suite's cleanup,
  because a sweep that removes what it did not create takes an unrelated container on the
  developer's machine with it and says nothing — and
  `sh scripts/test-concurrency.sh` (`tests/unit/concurrency.test.js`), which requires
  `runner/run.js` as a module and drives its exported `drainQueue` plus the
  `PIPELINE_EXEC_STUB` seam: run it if you touch `runner/run.js` or `runner/config.js`,
  because `main()` must stay behind `require.main === module` (without it nothing in that
  file is reachable from in here at all) and the stub path must stay asynchronous — a
  `spawnSync` there serialises every stubbed task and makes concurrency unobservable to the
  only suites that can prove it — and
  `sh scripts/test-pause-gate.sh` (`tests/unit/pause-gate.test.js`), which drives
  `runner/pause.js`'s `createPauseGate` directly and `runner/run.js`'s exported `runOneTask`
  through its seams: run it if you touch `runner/pause.js` or `runner/run.js`, because the
  rate-limit park is RUN-level (§7) and every way of getting it wrong is invisible at
  concurrency 1 — a second wait opened per task, a cycle counter that resets or goes `NaN`
  on the failure branch that carries no count, or an `admit()` consulted after `claim()`,
  which would claim an issue the fired cap refuses to launch and strand it `in_progress`.
  Nothing in it turns on wall clock: it drains the event loop with `setImmediate` and judges
  ordering from an events array, because a park is a thing that SLEEPS — and
  `sh scripts/test-sweep-assertions.sh` (`tests/unit/sweep-assertions.test.js`), which counts
  lines in planted logs and drives a copy of `scripts/test-all.sh` over stub suites: run it if
  you touch `scripts/test-all.sh` or `scripts/sweep-assertions.js`, because the sweep's
  `PASSED` column is a number, and a number that stops meaning anything goes on being printed —
  and `sh scripts/test-trace.sh` (`tests/unit/trace.test.js`), which needs git and node
  only and builds its own throwaway repositories under the OS temp dir: run it if you touch
  `scripts/trace.js`, because backfill's whole warrant is that it recovers the *ticking*
  commit rather than blaming the last edit, and only the suite's reword trap proves that —
  and `sh scripts/test-verdict.sh` (`tests/unit/verdict.test.js`), which needs node only and
  builds throwaway runs roots under the OS temp dir: run it if you touch `scripts/verdict.js`,
  because the recorder must keep spawning nothing and requiring nothing outside node's
  built-ins — a copy of that one file has to work from any repo-shaped root, and on a host
  where `bd` was never installed —
  and `sh scripts/test-audit-runs.sh` (`tests/unit/audit-runs.test.js`), which builds
  throwaway runs roots under the OS temp dir and drives the real CLI through the
  `AUDIT_RUNS_DIR` seam: run it if you touch `scripts/audit-runs.js`, because what that
  tool prints is a set of NUMBERS about the corpus, and the way it fails is the way its
  hand-written ancestor failed — reading a `concerns` key that is really `specConcerns` and
  calling a 43-use channel unused, which is non-empty, well-formed and false —
  and `sh scripts/test-dashboard.sh` (`tests/unit/dashboard.test.js`), which builds
  throwaway runs roots under the OS temp dir and drives `scripts/dashboard.js` both as a
  required module and as a server on an ephemeral loopback port: run it if you touch
  `scripts/dashboard.js`, and equally if you touch anything the reader JOINS — a `run.log`
  line's wording in `runner/`, a `run.json` field name, the lock record's shape, or
  `status.json`'s keys — because the dashboard is downstream of all four and the way it
  breaks is silent, a well-formed empty picture rather than an error.
  Any new Docker-free suite belongs beside them in
  `tests/unit/`, and its seam stub must be a `.js` file invoked through
  `process.execPath`, never a `#!/bin/sh` script: `spawnSync` without a shell fails such a
  script with EFTYPE on the Windows host, so the suite would pass in here and fail in the
  host sweep.
- You cannot push (no credentials, no git-host network). Commit locally at every
  meaningful boundary; the host pushes your branch after the container exits.
- The `bd` quick-reference below is for interactive host sessions — in here you have no
  Beads database and must not try to create one. Insights worth keeping go in the status
  file instead: `node /pipeline/status.js note "<insight>"` appends one, and the host
  files it after you exit. You propose; the host commits. Notes are advisory — they can
  never change your outcome, and past 20 the call is silently a no-op.
- If you conclude the frozen spec or its tests are themselves wrong, say so:
  `node /pipeline/status.js concern "<what is wrong and why>"`. That is a first-class
  result (§3.3), not a failure — the host surfaces it where a human reviewing the run
  will see it, and changing a spec is legal there and nowhere else. It is evidence only:
  it cannot change your outcome, so keep doing the best work the spec allows rather than
  contorting correct code to satisfy a gate you believe is broken. Head-truncated at 1000
  characters, and past 5 the call is silently a no-op.


<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:970c3bf2 -->
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
   bd dolt push
   git push
   git status
   ```
5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step

**Critical rules:**
- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.
<!-- END BEADS INTEGRATION -->

