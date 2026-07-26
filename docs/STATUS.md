# Status

Where the build actually is. Update this when something changes — it is the file a new
session reads to pick up the thread, and unlike a machine-local memory folder it travels
with the repo.

_Last updated: 2026-07-26_

## Where things stand

**V1 is complete and proven end to end.** All 21 build tasks are done. `scripts/e2e.sh`
drives three scenarios (success, bail, tamper) through the real runner, real containers,
the real closed network, and live GitHub with zero interactive input — 32 assertions,
all passing. It opened a genuine pull request on the fixture repo.

**The shadow-mode trial has begun** on a real project. Three runs so far,
two merged PRs, one rejected. Every problem found traced to spec quality, never to the
executor.

## The three repositories

| Repo | Role |
|---|---|
| `Chadleewalker/Multi-AgentPipelines` (this one, private) | the pipeline itself |
| `<private fixture repo>` (private) | disposable test bed for `scripts/e2e.sh` |
| a separate private project | the shadow-trial target |

## Shadow trial log

| Run | Task | Outcome | Verdict |
|---|---|---|---|
| shadow-01 | `<task id>` npm test script | done, 2 attempts | **Rejected.** Green but wrong — see below. |
| shadow-02 | `<task id>` re-run after fixing the gate | done, 1 attempt, 84s | Merged (PR #2) |
| shadow-03 | `<task id>` in-turn undo feature | done, 1 attempt, 300s | Merged (PR #3) |

**The finding that matters most:** in shadow-01 the acceptance test invoked `npm test`
from inside `node --test`, so `NODE_TEST_CONTEXT` was inherited and the child run failed
as a nested subtest. The agent wrote the correct one-line script on attempt 1, diagnosed
the nesting correctly in its notes, watched it fail the gate anyway, and contorted the
implementation until it passed. **A green run cannot tell you the spec was good**, and V1
gives an agent no channel to report "your spec is wrong" — it can only comply. That
lesson is now encoded in [`advisors/testability.md`](../advisors/testability.md), which
directs the critic to hunt for self-nesting test invocations, inherited environment
(`NODE_TEST_CONTEXT` and friends), and criteria no script can honestly check.

## Defects the trial found in the pipeline itself

All were invisible to three rounds of design review and appeared within minutes of
real use. All are fixed.

1. **`main` was hardcoded** in three separately-built components. the shadow-trial project uses `master`,
   so every run would have failed at workspace preparation. Now `defaultBranch` in
   `pipeline.config.json`, falling back to asking the remote.
2. **The model was unpinned** — every container took whatever the account default was, so
   runs were not reproducible and quality could drift silently. Now `model: "opus"`, an
   alias resolved at call time, with the **resolved** id recorded in the status file,
   manifest, report, and PR footer.
3. **A container artifact leaked into a PR** — the `node_modules` symlink the tools create
   inside the container. `.gitignore` matched the directory but not a symlink.
4. **A self-nesting acceptance test** shaped the implementation badly (see above).
5. **CLI noise contaminated both contract artifacts** (`repo-52m`). The CLI printed an
   untrusted-workspace warning ahead of its own output, so the docs phase — which merged
   stderr into `docs-out.txt` and took a raw `tail -c 2000` — led every PR body with the
   warning, and the code phase's whole-file `JSON.parse` failed silently, meaning defect 2's
   resolved model id was in fact never recorded. Fixed at both ends: `pipeline/envelope.js`
   extracts the envelope bottom-up, and the entrypoint seeds the workspace trust flags so
   the warning is not emitted in the first place.
6. **The pause loop had no working bound** (found 2026-07-26 by the full-suite re-run, not
   by a run). `pause.js` capped wait cycles at 96, but `run.js` re-entered `waitForWindow`
   fresh on every pause, so the counter restarted at 1 each time and the stop condition
   could never fire. A container reporting an already-elapsed reset time relaunched on a
   5-second cycle **forever** — the wall-clock budget cannot catch it, because paused time
   is deliberately excluded from it. Fixed: the cycle count carries across relaunches, and
   the cap is now `maxPauseCycles` in `run.config.json` (default 96). Making it
   configurable was part of the fix — while hardcoded, the stop condition was untestable,
   which is exactly why the gap survived three rounds of review and 21 build tasks.

## Gotchas that cost real time

- **MSYS path conversion.** Git Bash rewrites container-side paths in `docker` arguments
  (`-w /repo` → `C:/Program Files/Git/repo`). Needs `MSYS_NO_PATHCONV=1` plus `cygpath -m`
  on mount sources. Broke `scripts/new-issue.sh`, which had only ever been tested *inside*
  a container and so never exercised the host path.
- **CRLF looks like tampering.** A Windows host clone applies `autocrlf`, so every file
  differs from its blob inside a Linux container — and the verifier correctly reported a
  clean checkout as *tampered*. Workspaces now clone with `core.autocrlf=false`,
  `core.eol=lf`.
- **Bind-mounted workspaces are host-owned**, so git's dubious-ownership guard blocks
  every git call inside the container. The entrypoint marks `$WS` a safe directory.
- **`bd` takes its issue prefix from the working-directory name.** Mounting a repo at
  `/repo` produces `repo-xxx` ids. Mount at a meaningful path (`/fix`, `/hal`) when
  running `bd init`.
- **`node --test <dir>/` is broken on Node 22+** (MODULE_NOT_FOUND). Always pass the file.
- **`PIPELINE_BD_CMD` stubs the whole bd layer.** Set it and `runner/bd.js` spawns that
  executable directly with the bare bd argument vector — no `-C` prefix, no host-`bd`
  probe, no Docker fallback — which is how the Docker-free acceptance tests exercise
  `runner/memory.js`. It takes absolute precedence over every other path in `bd()`, so
  **production must never set it**; it is the sibling of `PIPELINE_AGENT_CMD` (§4.3).
- **The Claude CLI writes chatter around its output**, and a warning line on stdout is
  enough to break a whole-file `JSON.parse`. Never parse an agent log as one document:
  `pipeline/envelope.js` scans lines bottom-up for the first that parses to an object with
  a string `result`. The rule is structural on purpose — no list of known warning strings
  to maintain when a CLI upgrade invents new noise. Untrusted-workspace warnings are also
  removed at source: the entrypoint seeds `hasTrustDialogAccepted` /
  `hasCompletedOnboarding` for `$WS` into `$HOME/.claude.json` before the first agent call.
- **Test suites share one Docker network.** Run them one at a time; concurrent runs tear
  `pipeline-net` down under each other and produce meaningless failures.
- **Never hardcode a timestamp in a fixture.** `test-runner-queue.sh` pinned
  `rateLimitResetAt: "2026-07-26T00:00:00Z"`. It was written at T12, when exit 20 just
  mapped to `paused`; T15 then added the real pause loop and the same constant silently
  became "park for 24 hours", and once the wall clock passed it, "relaunch every 5
  seconds forever". Compute reset times relative to `date +%s`, the way
  `test-runner-pause.sh` always has.
- **Acceptance tests are container-targeted; running them on the Windows host lies.**
  `tests/acceptance/repo-eyn|4gp|52m` drive the `PIPELINE_BD_CMD` / `PIPELINE_AGENT_CMD`
  seams with `#!/bin/sh` stubs, which Windows cannot exec — every seam assertion goes red
  for a reason that has nothing to do with the code. Run them inside `pipeline-base:local`
  (`docker run --rm -v "$(cygpath -m "$PWD"):/w" -w /w pipeline-base:local node
  tests/acceptance/<id>/test.js`), which is where the verifier runs them. Also note
  `node --test` swallows these suites' per-check output — run the file with plain `node`
  to see which assertion failed.
- **`bd ready` empty on the fixture means the last e2e left state behind.** An
  `e2e.sh --keep` run (or one interrupted before teardown) leaves the three scenario
  issues `blocked` and `task/*` branches on the remote, so `test-fixture.sh` fails its
  ready-queue check. `cleanup_remote` + resetting the three issues to `open` restores it.
- **Watch what else is using a port before killing it.** A `node server.js` on :3000 was
  assumed to be a stale server and killed; it was a different app entirely, served over a
  a private network link.

## The dogfood queue (planned 2026-07-25, first full PLANNING.md session)

Four tasks specced, critic-reviewed, approved, and frozen for the pipeline to run on
itself. Specs live in the Beads issues; tests at `tests/acceptance/<id>/` (all red by
design until implemented). Snapshot: `docs/planning-draft-2026-07-25.md`.

| Issue | Task | Prio | Notes |
|---|---|---|---|
| `repo-qyd` | advisor registry + ambiguity/testability/scope charters (§3.5) | 1 | **Done** — `advisors/` (README + 3 planning-critic charters) |
| `repo-zdm` | container-side memory: `memoryNotes` + `status.js note` + prompt (§3.6) | 2 | **Done** — see below |
| `repo-eyn` | runner memory export: `.run/memory.md` + `PIPELINE_BD_CMD` seam (§3.6) | 2 | **Done** — `runner/memory.js`, called from `workspace.prepare()` |
| `repo-4gp` | runner memory filing: `bd remember` after exit (§3.6) | 3 | **Done** — `memory.fileMemoryNotes()`, called from `run.js` after the pause loop |

**`repo-zdm` shipped the container-side half of §3.6.** `status.schema.json` now carries
an optional `memoryNotes` array (max 20 entries, 500 chars each, inline like
`advisories`); `pipeline/status.js note "<text>"` appends one entry, keeping the *head*
of an over-long note and silently dropping notes past the cap so a memory can never
change an outcome; and `pipeline/entrypoint.sh` both injects `.run/memory.md` into the
prompt when the runner has exported one and tells the coding and docs agents how to
propose a note.

**`repo-4gp` closed the loop.** `memory.fileMemoryNotes(cfg, issueId, status)` files each
proposed note through the bd layer as `bd remember <text> --key <issueId>-note-<n>` — the
issue id is the §3.6 audit trail, and because `bd remember` updates a key in place a
re-run of the same issue overwrites its notes instead of duplicating them. The host
re-enforces the schema bounds on the agent-written file (first 20 notes, first 500 chars
each). `run.js` calls it once per task after the pause/relaunch loop, gated to the
terminal outcomes `done|partial|failed|stuck`: never `tampered` (an agent that failed the
trust check does not seed project memory) and never `paused` (not terminal). It never
throws and returns `{filed, errors}`; bd failures are logged and the outcome is untouched,
the same posture as `docsPhaseError`. `queue.attemptNotes` adds a `memory notes: <n>` line
so the §3.6 promotion rule has something to act on at review time. `DESIGN.md` is amended
to v1.8.2: the outcome gate and the host-side re-enforcement of the schema bounds are
decisions about *who may seed project memory* and *how far the host trusts an
agent-written file*, so they now live in §3.6 rather than only in code comments.

## The 2026-07-26 queue (one task, from run artifacts)

Planned from the shadow-run artifacts rather than the backlog. Snapshot:
`docs/planning-draft-2026-07-26.md`.

| Issue | Task | Prio | Notes |
|---|---|---|---|
| `repo-52m` | clean contract artifacts from agent CLI noise (§4.3, §4.11) | 1 | **Done** — `pipeline/envelope.js`, `status.js summary`, entrypoint trust seeding |

**`repo-52m` fixed defect 5 above at both ends.** `pipeline/envelope.js` is the single
reader of the CLI's `--output-format json` envelope: `parse(text)` scans lines bottom-up
and returns `{result, model}` from the first that parses to an object with a string
`result` (`model` = the first key of `modelUsage`, else null), and
`node envelope.js flatten <file>` rewrites a log to just its result text while printing
the resolved model — a log with no envelope is left byte-identical and prints nothing, so
stubs and caller-supplied commands need no special case. `status.js summary <file>` sets
`changeSummary` from the envelope result, falling back to the raw file when there is none
(trimmed, last 2000 chars); it is the only new writer, and `init`/`attempts`/`append`/
`set`/`note` are untouched. The entrypoint now sends both agent phases through the JSON
path, keeps the docs phase's stderr in `.run/docs-err.txt` instead of merging it into the
file the summary is read from (the code phase's log stays merged — the rate-limit grep
reads it), and seeds `hasTrustDialogAccepted` / `hasCompletedOnboarding` for `$WS` into
`$HOME/.claude.json` before the first call, merging into any existing config and never
touching the token. `DESIGN.md` is amended to v1.8.3.

Session learnings: critic panel earned its keep (Task C split in two, unverified `bd`
subcommands caught, an unowned contract — nothing injects memory.md into the prompt —
found and assigned); PLANNING.md step 5 amended — draft specs go to
`docs/planning-draft-<date>.md`, never a scratchpad, so the user has one file to read.

## What's next

**Recommended order:**

1. **The dogfood queue is drained** — all four tasks (`repo-qyd`, `repo-zdm`, `repo-eyn`,
   `repo-4gp`) are implemented. §3.6 is now wired end to end: In (the runner exports
   `.run/memory.md`, the entrypoint injects it into the prompt) and Out (the agent
   proposes notes in the status file, the host files them via `bd remember` after exit).
   What is still unproven is the *round trip on a real run* — a note proposed by one
   container turning up in the next task's `memory.md`. Watch for that on the next
   shadow run, and apply the §3.6 promotion rule to whatever accumulates.
2. **More shadow runs.** Three is a small sample. The numbers that matter for scaling are
   per-task active time, spec-defect rate, and how often tasks collide on shared files.
3. **V2 — the spec pipeline** (`DESIGN.md` §3.2, §3.5): package the critic panel, the
   decomposition agent, and the coverage check as a `/spec` skill, and add the
   "the spec is wrong" channel V1 lacks. The panel's three charters already exist in
   `advisors/` and are run by hand from `PLANNING.md` step 2 — `/spec` automates
   dispatching them, not writing them.

**Known gaps, deliberately deferred:**

- **Batched tasks collide.** Every task forks from the integration branch as the run
  starts, so two tasks touching the same file produce a conflict once the first merges
  (seen with PRs #2 and #3). Options: fork from latest, or partition concurrency by
  declared path ownership. Needed before any large wave.
- **No concurrency at all** — the runner is a sequential `for` loop, by design. Note that
  parallelism does not multiply subscription capacity: N containers exhaust the same usage
  window N times faster, then all park.
- **No review triage.** Hundreds of PRs would exceed human review capacity; an auto-merge
  policy for clean, small, green diffs would be needed.
- **Run-time advisors (slot 3)** are unbuilt. The sockets exist: `advisories` in
  `status.schema.json`, the read-only `/pipeline` mount, per-project selection in
  `pipeline.config.json`, and now the charter format in `advisors/README.md` — a slot-3
  charter is written the same way as the slot-1 ones. Nothing calls one yet; no run-time
  advisor is registered until the trial shows a lens that genuinely resists determinism.

## Test suites

Run individually, never concurrently. Each drives real Docker.

| Script | Covers |
|---|---|
| `scripts/e2e.sh` | the whole pipeline against the fixture repo, live GitHub |
| `scripts/test-base-image.sh` | pinned image contents, no baked credentials |
| `scripts/test-beads-roundtrip.sh` | the five spec fields, ready-queue semantics |
| `scripts/test-status-schema.sh` | the status-file contract |
| `scripts/test-egress.sh` / `test-egress-check.sh` | the allowlist and the pre-run gate |
| `scripts/test-verifier.sh` | tamper detection, frozen config, regression evidence |
| `scripts/test-entrypoint.sh` | the container loop, all exit codes |
| `scripts/test-runner-*.sh` | bootstrap, queue, workspace, container, pause, publish |
| `scripts/test-report.sh` | manifest schema, scrutiny ordering, idempotency |
| `scripts/test-isolation.sh` | no push, read-only scaffolding, no egress, one credential |
| `scripts/test-fixture.sh` | the fixture repo is a valid pipeline target |

**Full re-run 2026-07-26**, after the five dogfood/queue PRs merged to `main`: all 18
suites green, including `e2e.sh` (32 assertions, real PR opened and cleaned up). Two were
red before the fixes above — `test-runner-queue.sh` (hung; defect 6 plus two stale
fixtures: the pinned reset timestamp, and an assertion on `results.json`, which T17 had
renamed to `run.json`) and `test-fixture.sh` (leftover state from an earlier
`e2e.sh --keep`). **`test-entrypoint.sh` was fine** — repo-52m's docs-phase rewrite kept
the stub path compatible, because `status.js summary` falls back to the raw file when
there is no JSON envelope. The lesson generalizes: the suites that break are the ones
nobody re-runs, and T12 had accumulated three separate staleness bugs from T15 and T17.

**Gap worth knowing:** `runner/memory.js` (both §3.6 channels) has no
`scripts/test-runner-*.sh` suite — its coverage lives in the Docker-free acceptance tests
at `tests/acceptance/repo-eyn/` and `tests/acceptance/repo-4gp/`, which drive it through
the `PIPELINE_BD_CMD` stub seam. Fold it into a `test-runner-memory.sh` if the module
grows past the two entry points. The same is true of `pipeline/envelope.js` and
`status.js summary`: their coverage is `tests/acceptance/repo-52m/`, which drives the
whole entrypoint with a `PIPELINE_AGENT_CMD` stub and a stub `verify.js` (never the real
verifier — that would self-nest, the shadow-01 lesson).
