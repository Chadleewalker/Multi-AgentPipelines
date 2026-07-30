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
| `Chadleewalker/Multi-AgentPipelines` (this one, public) | the pipeline itself |
| a private `pipeline-fixture` repo | disposable test bed for `scripts/e2e.sh` — you create your own; see `scripts/test-fixture.sh` for what makes one valid |
| a separate private project | the shadow-trial target |

## Shadow trial log

| Run | Task | Outcome | Verdict |
|---|---|---|---|
| shadow-01 | task A — an npm test script | done, 2 attempts | **Rejected.** Green but wrong — see below. |
| shadow-02 | task A re-run after fixing the gate | done, 1 attempt, 84s | Merged (PR #2) |
| shadow-03 | task B — an in-turn undo feature | done, 1 attempt, 300s | Merged (PR #3) |

(Task ids are from the trial project's own Beads database and are omitted here — the
project is private.)

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

1. **`main` was hardcoded** in three separately-built components. The shadow-trial project
   uses `master`, so every run would have failed at workspace preparation. Now `defaultBranch` in
   `pipeline.config.json`, falling back to asking the remote.
2. **The model was unpinned** — every container took whatever the account default was, so
   runs were not reproducible and quality could drift silently. Now `model: "opus"`, an
   alias resolved at call time, with the **resolved** id recorded in the status file,
   manifest, report, and PR footer. The pin itself has always held; the *record* took two
   further defects to get right — see 5 (never written at all) and 8 (written, but naming
   the wrong model).
3. **A container artifact leaked into a PR** — the `node_modules` symlink the tools create
   inside the container. `.gitignore` matched the directory but not a symlink.
4. **A self-nesting acceptance test** shaped the implementation badly (see above).
5. **CLI noise contaminated both contract artifacts** (`repo-52m`). The CLI printed an
   untrusted-workspace warning ahead of its own output, so the docs phase — which merged
   stderr into `docs-out.txt` and took a raw `tail -c 2000` — led every PR body with the
   warning, and the code phase's whole-file `JSON.parse` failed silently, meaning defect 2's
   resolved model id was in fact never recorded. Fixed at both ends: `pipeline/envelope.js`
   extracts the envelope bottom-up, and the entrypoint seeds the workspace trust flags so
   the warning is not emitted in the first place. (The id it then started recording was
   still the wrong one — defect 8.)
6. **The pause loop had no working bound** (found 2026-07-26 by the full-suite re-run, not
   by a run). `pause.js` capped wait cycles at 96, but `run.js` re-entered `waitForWindow`
   fresh on every pause, so the counter restarted at 1 each time and the stop condition
   could never fire. A container reporting an already-elapsed reset time relaunched on a
   5-second cycle **forever** — the wall-clock budget cannot catch it, because paused time
   is deliberately excluded from it. Fixed: the cycle count carries across relaunches, and
   the cap is now `maxPauseCycles` in `run.config.json` (default 96). Making it
   configurable was part of the fix — while hardcoded, the stop condition was untestable,
   which is exactly why the gap survived three rounds of review and 21 build tasks.
7. **The §3.6 In channel was unobservable** (found 2026-07-26 while answering "is memory
   actually updating?"). The channel *worked* — but `exportMemory` returns `{ok:true}`
   for a successful export of **zero** memories, and `workspace.js` logged only on
   failure. So a run could not distinguish "the container received 8 notes" from "the
   container received `(no memories recorded)`"; if `bd memories` ever started returning
   empty, every task would silently lose its context with no error anywhere. The same
   shape as defects 2 and 5, and the rule was already written down in this repo's own
   filed memory (`repo-52m-note-4`: *when scaffolding is deliberately fail-safe,
   something must still assert the artifact is non-empty*). Fixed: `exportMemory` returns
   `count`, `workspace.prepare()` logs it either way and passes it out as `memoryCount`,
   and `attemptNotes` records `memory in: <n>` beside the existing `memory notes: <n>` so
   both halves of the channel are visible on the issue at review time. `collectArtifacts`
   now also copies `memory.md` (and `docs-err.txt`, per `repo-52m-note-2`), so a finished
   run still shows what the container was actually told.
8. **The recorded model named the wrong model** (`repo-wxh`, found 2026-07-26 in run
   `2026-07-26T16-47-15-326Z`). `envelope.js` took `Object.keys(modelUsage)[0]`, but
   `modelUsage` enumerates *every* model the CLI billed and lists the cheap internal
   helper first: both tasks of that run recorded `claude-haiku-4-5-20251001` while
   `claude-opus-5` did 7897 of the 7912 output tokens. The pin was honoured throughout —
   defect 2's *feature* worked and only its **record** lied, in the status file, the
   manifest, the PR footer and the report, which is why nothing looked wrong. Worse,
   `DESIGN.md` §4.3 had codified the first-key rule as a deliberate decision (change-log
   row `repo-52m`), so the constitution agreed with the bug. Fixed at both: §4.3 now
   states an ordered selection rule (pinned alias → sole key → greatest `outputTokens`,
   ties by name → null), the entrypoint passes `${PIPELINE_MODEL:-}` through to
   `flatten`, and the `2>/dev/null` on that call is gone so an alias matching nothing is
   visible in the run log instead of silently falling back.

9. **A new suite was green in the container and red on the host** (found 2026-07-26 by
   the sweep's first real use, minutes after `repo-dhp` merged). `tests/unit/memory.test.js`
   set `NODE_OPTIONS=--require "<path>"`, and on Windows that is the one combination Node
   rejects: it strips the quotes and then treats the backslashes as escapes, so the
   preload never loads, `node` exits 1, and `runner/bd.js` reports **every** stubbed `bd`
   call as a bd failure. 11 of 30 checks red. Verified directly — quoted+backslash fails,
   bare+backslash, quoted+forward and bare+forward all work — and fixed by passing the
   stub path with forward slashes.

   Two things make this worth recording. **No acceptance test could have caught it:**
   `repo-dhp`'s criterion C7 did assert the stub runs through `process.execPath`, and it
   does — but acceptance tests are container-targeted by design, and inside the Linux
   container the path has no backslashes to mangle. The sweep is the only thing that runs
   these suites on the host. And the failure was **misleading, not absent**: a suite that
   cannot execute its own stub reports genuine-looking failures rather than announcing a
   broken harness, which is the same "plausible and wrong" family as defect 8.

10. **Two suites accused the wrong component** (found 2026-07-27 by the sweep, after the
    publication-sanitize work). Both were green the day before, both went red for reasons
    that had nothing to do with what they printed, and both cost an investigation that
    started at the wrong end.

    `test-beads-roundtrip` reported **"new-issue.sh broken when run from the host (MSYS
    path conversion?)"**. `new-issue.sh` was fine. It extracts the new issue id with
    `tail -1`, and `bd` had been upgraded on the host from 1.1.0 to 1.1.2, which prints the
    id followed by a **trailing blank line** — so the last line was empty and `HOSTID` came
    back unset. The suite had never exercised that path before, because until that day
    there was no host `bd` at all and `new-issue.sh` silently took its container branch.
    Two things compounded it: the suite discards the command's stderr, so there was no
    diagnostic to read; and its failure message *names a specific cause* it never actually
    tested, which sent the first three hypotheses (schema migration, `-C` path handling,
    working directory) chasing nothing. Fixed by matching the id's **shape** rather than
    its position — the same rule the agent-log envelope already follows.

    `e2e` reported **"main moved!"**. `main` had not moved. The check compared local `main`
    to `origin/main`, which measures how up to date the clone is, not what the run did — an
    unrelated commit pushed to the fixture repo from another machine failed it. Fixed by
    recording `main`'s SHA after the reset and comparing it after the run, and by printing
    both SHAs when it fails.

    The general lesson is about **assertion honesty**, and it is the mirror of defects 8
    and 9. Those were checks that stayed silent when they should have failed; these are
    checks that failed while naming a cause they had not established. A red suite that
    blames the wrong component is not a cheap false alarm — it spends the investigation
    budget the suite exists to save, and it teaches you to distrust the sweep. An assertion
    should measure the thing its label claims and, when it fails, report the values it
    compared rather than a guess at why.

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
  `/repo` produces `repo-xxx` ids. Mount at a meaningful path (`/fix`, or whatever names
  the project) when running `bd init`.
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
  to see which assertion failed. **A new seam-driven test must not copy the `#!/bin/sh`
  stub**: write the stub as a `.js` file and point the seam variable at
  `process.execPath` (`tests/unit/memory.test.js` is the worked example), which is what
  makes a suite that runs on the host sweep as well as in the container.
- **`bd ready` empty on the fixture means the last e2e left state behind.** An
  `e2e.sh --keep` run (or one interrupted before teardown) leaves the three scenario
  issues `blocked` and `task/*` branches on the remote, so `test-fixture.sh` fails its
  ready-queue check. `cleanup_remote` + resetting the three issues to `open` restores it.
- **Watch what else is using a port before killing it.** A `node server.js` on :3000 was
  assumed to be a stale server from this project and killed; it belonged to an unrelated
  app on the same machine. Identify the process, not just the port.

## The dogfood queue (planned 2026-07-25, first full PLANNING.md session)

Four tasks specced, critic-reviewed, approved, and frozen for the pipeline to run on
itself. Specs live in the Beads issues; tests at `tests/acceptance/<id>/` (all red by
design until implemented). Its planning snapshot has since been deleted — superseded by
the issues, per PLANNING.md step 5.

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
in change-log row `repo-4gp`: the outcome gate and the host-side re-enforcement of the
schema bounds are decisions about *who may seed project memory* and *how far the host
trusts an agent-written file*, so they now live in §3.6 rather than only in code comments.

## The 2026-07-26 queue (one task, from run artifacts)

Planned from the shadow-run artifacts rather than the backlog.

| Issue | Task | Prio | Notes |
|---|---|---|---|
| `repo-52m` | clean contract artifacts from agent CLI noise (§4.3, §4.11) | 1 | **Done** — `pipeline/envelope.js`, `status.js summary`, entrypoint trust seeding |

**`repo-52m` fixed defect 5 above at both ends.** `pipeline/envelope.js` is the single
reader of the CLI's `--output-format json` envelope: `parse(text)` scans lines bottom-up
and returns `{result, model}` from the first that parses to an object with a string
`result` (`model` selected from `modelUsage` per §4.3 — see defect 8 below; else null),
and `node envelope.js flatten <file> [expected-alias]` rewrites a log to just its result
text while printing the resolved model — a log with no envelope is left byte-identical and
prints nothing, so stubs and caller-supplied commands need no special case. `status.js summary <file>` sets
`changeSummary` from the envelope result, falling back to the raw file when there is none
(trimmed, last 2000 chars); it is the only new writer, and `init`/`attempts`/`append`/
`set`/`note` are untouched. The entrypoint now sends both agent phases through the JSON
path, keeps the docs phase's stderr in `.run/docs-err.txt` instead of merging it into the
file the summary is read from (the code phase's log stays merged — the rate-limit grep
reads it), and seeds `hasTrustDialogAccepted` / `hasCompletedOnboarding` for `$WS` into
`$HOME/.claude.json` before the first call, merging into any existing config and never
touching the token. `DESIGN.md` is amended in change-log row `repo-52m`.

Session learnings: critic panel earned its keep (Task C split in two, unverified `bd`
subcommands caught, an unowned contract — nothing injects memory.md into the prompt —
found and assigned); PLANNING.md step 5 amended — draft specs go to
`docs/planning-draft-<date>.md`, never a scratchpad, so the user has one file to read.

**`repo-wxh` then fixed defect 8** — the follow-on `repo-52m` left behind. `envelope.js`
gains `chooseModel(modelUsage, alias)`, the ordered rule §4.3 now states, and `parse` takes
an optional second argument (`parse(text)` is unchanged, so `status.js summary` and the
frozen `repo-52m` suite are untouched — the `repo-wxh` suite shells out to that suite and
asserts exit 0, since nothing else re-runs it). The `flatten` CLI takes an optional
`[expected-alias]`; an empty or missing one means "no alias", which is the production
default because `${PIPELINE_MODEL:-}` yields `""` on an unpinned run and `""` is a
substring of every key. A supplied alias matching nothing prints a diagnostic naming the
alias and the keys seen to **stderr** and still records the rule-3 choice — stdout stays
the model id alone, so the entrypoint's `$(...)` capture is unaffected. `DESIGN.md` is
amended in change-log row `repo-wxh`. Nothing under `runner/` changed: the manifest,
report and PR footer all read the status file, so they were corrected by the one fix.

## The spec-concern batch (frozen 2026-07-26)

Two tasks frozen together, splitting §3.7 along §10's dividing line: the container writes
the concern, the host surfaces it. They are sequenced, not batched — the runner reads the
ready queue once before the task loop, so the host side cannot run alongside the container
side.

| Issue | Task | Prio | Notes |
|---|---|---|---|
| `repo-1cy` | spec-concern channel, container side: `specConcerns` + `status.js concern` + prompt (§3.7) | 1 | **Done** — see below |
| `repo-dhp` | runner memory unit suite (`tests/unit/`, `scripts/test-runner-memory.sh`) | 2 | Frozen, not yet implemented — `tests/acceptance/repo-dhp/` is red by design |

**`repo-1cy` shipped the container-side half of §3.7.** `status.schema.json` now carries
an optional `specConcerns` array (max 5 entries, 1000 chars each — deliberately *not* the
`memoryNotes` numbers: a concern is rarer than an insight and needs more room to be
actionable), and `schemas/examples/status.valid.json` carries one so
`scripts/test-status-schema.sh` exercises the field against a real validator on the host.
`pipeline/status.js concern "<text>"` appends one entry with the same mechanism as `note`
— head-truncating, replacing a malformed array, and silently no-opping past the cap so a
concern can never fail a task. Both entrypoint phases now tell the agent the channel
exists *and* that it cannot change the outcome; the frozen test asserts those literals
against the **generated** `.run/prompt-<N>.md` and `.run/prompt-docs.md`, never against
`entrypoint.sh` source, because a shell comment would satisfy the latter while leaving the
agent never actually told. `CLAUDE.md`'s container section carries the same line beside
the `status.js note` guidance. Nothing in the control path moved: the evidence-only
invariant is enforced by an acceptance check that drives a failing run to exit 10 with a
concern recorded, and that diffs `pipeline/verify.js` and all of `runner/` against the
fork point.

**Still open: the host side.** Nothing yet reads `specConcerns` after the container exits,
so a concern raised today reaches only the status file — not the attempt log, the run
manifest, the run report, or the PR body. Until that ships, an agent can say the spec is
wrong and no human sees it where they already look. That is the separate task §3.7 names.

## Change-log rows are identified by a slug (`repo-006`, 2026-07-26)

**The collision that forced it.** Merging PRs #10, #11 and #13 in one sitting, two of the
three claimed the same change-log version. Neither agent did anything wrong: each forked
from a base where that number was free, numbered its own row, and the clash only existed
once both landed — so the rows were renumbered by hand at merge, for the second time (the
`repo-qyd` row records the first). A version number is a *global* identifier assigned by a
*local* actor, which cannot be unique by construction, and the pipeline is built to run
tasks in batches that touch this doc.

**The fix moves identity to where it is already unique.** §12's table gained a `Ref`
column — `| Date | Ref | What changed | Why |` — holding a kebab-case slug. A row written
by a pipeline task takes that task's issue id (`repo-52m`, `repo-dhp`); the host assigned
it before the container started, so no agent invents its own identity and two agents
cannot collide. A row from an interactive session takes a short descriptive name
(`default-branch`, `readiness-bar`). All 26 pre-existing rows kept their date and their
"why" verbatim; only the leading version token moved out of the what-changed cell. Version
numbers *inside* a row's prose stayed — they record what was true when the row was
written, and several rows cross-reference each other by the old numbers.

**Citations are pinned.** The literal phrase change-log row followed by the slug in
backticks — change-log row `repo-52m`. Without a marker phrase nothing can distinguish a
citation from ordinary hyphenated prose or from a Beads memory key like `repo-52m-note-4`;
this file alone holds well over a hundred kebab-case tokens, and a bare date matches a
slug regex too. The four version citations that were here (in defect 8 and in the
`repo-4gp` / `repo-52m` / `repo-wxh` write-ups) now use that form.

**`scripts/test-changelog.sh` keeps it from drifting back**, and it is where the value is:
a convention with nothing enforcing it lasts until the next batch. Deliberately left
alone, and said so in the §12 preamble: the version citations in `runner/memory.js`,
`pipeline/verify.js`, `scripts/test-verifier.sh` and `scripts/test-base-image.sh` (the
task could not touch those trees), and the doc-level version in `DESIGN.md`'s header — the
*document* still has a version, its *rows* no longer do.

## The runner skips epics (`repo-4l8`, 2026-07-26)

Beads hierarchy (`bd create -t epic`) was being ignored, and ignoring it is unsafe. Two
facts verified against `bd 1.1.0` in a throwaway database, not read from documentation:
`bd ready` returns **the epic itself**, ranked among its children, and closing every child
leaves the parent **open and ready**. An unfiltered runner would therefore clone a
workspace for an issue with no acceptance criteria, and would do it again on every
subsequent run for the life of the repository. §3.1 and change-log row
`epics-group-never-run` declared the filter before it existed; this task built it.

`queue.readyQueue()` now partitions the ready list: entries whose `issue_type` is `epic`
go to `skipped`, everything else survives in the unchanged priority-then-FIFO order.
**Excluded by name, never by allow-list** — `bug`, `feature`, `chore` and `decision` all
still run, because admitting only `task` would make a legitimately-typed issue carrying a
full spec vanish from every run with nothing to say why, which is the silent-failure
family defects 7, 8 and 9 are all instances of. And it **fails open**: an entry whose
`issue_type` is absent, null or empty string is kept, since failing closed on a missing
field would drain nothing at all against an older `bd` — the catastrophic direction.
Note `bd ready --json` returns no `parent_id` (that appears on `show`/`create` only), so
the type is the only field the filter can use, and it is the one it wants.

**The queue-summary line is now a function**, `queue.queueSummary(issues, skipped)`, and
this is the reusable part. `run.js` reaches that line only after `loadToken` and the full
Docker preflight, and `--dry-run` returns before the task loop — so a test running inside
a task container could never execute it, and the skip announcement is precisely the thing
a filter that removes work silently must not get wrong. Extracting the string-building
made it testable at all; the same move `repo-dhp` made with `shouldFileMemory`, for the
same reason. The historic prefix is load-bearing (`scripts/test-runner-queue.sh` greps
`ready queue: <n> task(s) — ` at six sites, `(empty)` when there are none), so both new
clauses — `skipped <n> by type:` and `running <n> non-task:` — are **appended** after it,
never woven into it. Each names the id *and* the type, because "skipped 1" tells a
reviewer nothing they can act on.

Coverage splits along the Docker line, deliberately: `tests/acceptance/repo-4l8/` drives
the filter and the builder through the `PIPELINE_BD_CMD` seam with a `.js` stub spawned
via `process.execPath` (never a `#!/bin/sh` one — that is defect 9's EFTYPE trap), and the
Docker suite `scripts/test-runner-queue.sh` remains the only thing that proves the line is
actually emitted at run time.

## What's next

**The queue drained again on 2026-07-26**, after `repo-4l8` (the epic filter, planned and
frozen in the fifth planning session that day) ran and passed on attempt 1.
The only open issue left is `repo-iok` (the §3.7 host side), deliberately **blocked and
deliberately unfrozen** —
it cannot run in the same batch as its dependency (the runner reads the ready queue once,
before the task loop), and freezing tests weeks before the run that executes them is how
suites go stale. Its acceptance tests get written in the planning session immediately
before that run.

**Ten tasks ran on 2026-07-26, all `done`, every one on the first attempt.** `repo-qyd`
5.2, `repo-eyn` 2.6, `repo-zdm` 3.2, `repo-4gp` 4.8, `repo-52m` 6.8, `repo-dhp` 9.1,
`repo-1cy` 4.9, `repo-wxh` 5.5, `repo-006` 9.7, `repo-4l8` 5.1 — **minutes of active
container time each, 56.9 minutes summed**, longest single task 9.7 minutes. "Active" excludes any time parked waiting on a usage window
(§4.6), and the sum is across tasks, not elapsed wall-clock for a run. These are the
per-task numbers the scaling questions need, so quote them per task; a summed figure
invites the reading that one task took that long. Four defects were found and fixed in the same day —
6, 7, 8 and 9 — and three of the four were caught by **deterministic scaffolding** (a
suite re-run, the run artifacts, the sweep) rather than by anyone noticing. That is the
design's central bet, and it is the first day it paid out repeatedly.

**Recommended order:**

1. **The dogfood queue is drained** — all four tasks (`repo-qyd`, `repo-zdm`, `repo-eyn`,
   `repo-4gp`) are implemented. §3.6 is now wired end to end: In (the runner exports
   `.run/memory.md`, the entrypoint injects it into the prompt) and Out (the agent
   proposes notes in the status file, the host files them via `bd remember` after exit).
   **The round trip is now verified** (2026-07-26): eight notes are filed in this repo's
   Beads DB (`repo-4gp-note-1..4`, `repo-52m-note-1..4`), `exportMemory` returns
   `{ok:true,count:8}` against them, `entrypoint.sh` injects the file under
   `--- PROJECT MEMORY (read-only) ---`, and `prepare()` (run.js:144) runs inside the
   task loop *after* the previous task's `fileMemoryNotes()` (run.js:204) — so task N+1
   genuinely sees task N's notes.

   **The promotion rule has now been exercised for the first time** (2026-07-26), on the
   eight notes in the inbox. Three were promoted into `CLAUDE.md` under *Code conventions
   (promoted from memory — §3.6)*, each citing its originating note key: parse agent logs
   structurally (`52m-note-1` and `52m-note-3` — the same rule proposed twice by two
   phases, the textbook trigger); fail-safe scaffolding must assert its artifact is
   non-empty (`52m-note-4` — the strongest case in the set, because it was filed as a
   memory, left in the inbox, and the same defect then shipped again as defect 7 —
   **since widened**, see below); and all
   runner Beads access goes through `runner/bd.js` (`4gp-note-2`). A fourth, change-log
   rows append in ascending order (`4gp-note-3`), folded into the *Changing the design*
   section where it belongs. Notes deliberately left in the inbox: `4gp-note-1` (now
   encoded in code and §3.6 itself), `4gp-note-4` (a docs-phase habit, not yet recurring),
   and `52m-note-2` — which is **stale**: it asks for `collectArtifacts` to copy
   `docs-err.txt`, and defect 7's fix did exactly that. A note whose content has been
   absorbed should be retired, but nothing retires one today; the promotion rule covers
   graduation, not expiry. Worth a §3.6 amendment once a second stale note shows up.

   **The non-empty rule was widened the same day** to *assert the artifact is right, not
   merely present*. Non-emptiness caught defect 7 in advance and would have caught defect
   2, but it says nothing about the harder failure, which struck three times on
   2026-07-26: an artifact that is non-empty, well-formed, and **false** — the model id
   naming the CLI's helper model (defect 8), and a suite reporting genuine-looking
   failures when it could not execute its own stub (defect 9). The rule now requires the
   assertion to pin the *value* against something independent: the alias the runner
   actually pinned, or a fixture whose expected answer differs from what the bug would
   produce. Worth being honest about its standing — this is a **convention, not a
   mechanism**. Nothing enforces it the way the sweep enforces suites or the verifier
   enforces frozen tests, and its record is one hit and one miss: it was in `CLAUDE.md`
   all day and a fixture that could not tell a correct implementation from the bug it was
   fixing still reached a freeze (caught by the testability critic, not by the rule).

   Two different follow-ups, and they are **not** the same thing. Sharpening
   `advisors/testability.md` makes the *judgment* step better — a charter is a prompt read
   by an LLM critic, so it raises the odds a discriminating fixture gets demanded, and
   nothing more. Making it **deterministic** means a script, which here would mean the
   acceptance-test conventions growing a mechanical check (§3.5's ladder: judgment
   migrates leftward into frozen tests). The charter route is cheap and was the thing that
   actually caught this class twice today; the deterministic route is the one that would
   stop depending on a critic noticing. Do the first; reach for the second only if the
   class recurs after it.
2. **More shadow runs.** Three is a small sample. The numbers that matter for scaling are
   per-task active time, spec-defect rate, and how often tasks collide on shared files.
3. **V2 — the spec pipeline** (`DESIGN.md` §3.2, §3.5): package the critic panel, the
   decomposition agent, and the coverage check as a `/spec` skill. (The "the spec is
   wrong" channel is no longer wholly missing — `repo-1cy` shipped its container half;
   what V1 still lacks is the host surfacing.) The panel's three charters already exist in
   `advisors/` and are run by hand from `PLANNING.md` step 2 — `/spec` automates
   dispatching them, not writing them.

**Known gaps, deliberately deferred:**

- **`docs/pipeline-map.html` has no guard, and that is the real difference between the two
  diagram documents.** Both are kept, deliberately (decided 2026-07-26): they serve
  different readers — `docs/pipeline-diagram.md` shows structure to someone about to
  change the code, the HTML map explains the system to someone learning it. What separates
  them is not age but maintenance. **The mermaid one has a working loop**: task docs phases
  amend it unprompted in the same PR that changes what it draws (`repo-eyn` at 02:42,
  `repo-4l8` at 20:13, both on 2026-07-26). The HTML map is hand-written, went stale within
  three hours of being written, and was only caught because a review happened to look. So
  the instinct to delete the humbler file is backwards — it is the one that keeps itself
  honest. `CLAUDE.md`'s reading table now says which is which. If the HTML map should stop
  being a liability, the cheap fix is a suite asserting the handful of claims in it that
  are mechanically checkable (the agent-call count, the advisor names, the status-file
  field list), so stale means a red sweep rather than a lucky catch.
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

All but four drive real Docker and share one network, so they must never run concurrently
(`test-runner-memory.sh`, `test-changelog.sh`, `test-sanitize.sh` and
`test-agent-hooks.sh` are the exceptions — see below; they need neither).
**`scripts/test-all.sh` is the sweep** — it holds a lock, runs every suite sequentially,
kills one that hangs (`--timeout`, default 900s), tears `pipeline-net` down if a suite
leaks it, and writes per-suite logs plus a summary table to `runs/sweeps/<timestamp>/`.
It exits non-zero if any suite exits non-zero *or* prints a `FAIL` line while exiting 0
(a suite that lies about its own result is itself a defect). Discovery is a glob over
`scripts/test-*.sh` plus `e2e.sh` last, so a suite added later is swept without anyone
editing the sweep. Flags: `--list`, `--only <substr>`, `--skip <substr>`, `--fail-fast`.

| Script | Covers |
|---|---|
| `scripts/test-all.sh` | the sweep — every suite below, in order, with a summary |
| `scripts/e2e.sh` | the whole pipeline against the fixture repo, live GitHub |
| `scripts/test-base-image.sh` | pinned image contents, no baked credentials |
| `scripts/test-beads-roundtrip.sh` | the five spec fields, ready-queue semantics |
| `scripts/test-status-schema.sh` | the status-file contract |
| `scripts/test-egress.sh` / `test-egress-check.sh` | the allowlist and the pre-run gate |
| `scripts/test-verifier.sh` | tamper detection, frozen config, regression evidence |
| `scripts/test-entrypoint.sh` | the container loop, all exit codes |
| `scripts/test-runner-*.sh` | bootstrap, queue, workspace, container, pause, publish, memory |
| `scripts/test-report.sh` | manifest schema, scrutiny ordering, idempotency |
| `scripts/test-isolation.sh` | no push, read-only scaffolding, no egress, one credential |
| `scripts/test-fixture.sh` | the fixture repo is a valid pipeline target |
| `scripts/test-changelog.sh` | `DESIGN.md` §12 row identity — slug refs, uniqueness, citations |
| `scripts/test-sanitize.sh` | publication hygiene — no machine paths, emails, credentials or denylisted names in the tracked tree |
| `scripts/test-agent-hooks.sh` | container hygiene — no tracked file configures an agent hook |

**`scripts/test-runner-memory.sh` is one of the four suites that need no Docker**
(repo-dhp): it
drives both §3.6 memory channels plus the `shouldFileMemory` outcome gate through the
`PIPELINE_BD_CMD` seam, so it runs anywhere — including inside a task container, where
`scripts/test-*.sh` otherwise cannot run at all. It exists because that coverage used to
live only inside two frozen per-task acceptance directories (`repo-eyn`, `repo-4gp`),
which are artifacts of finished tasks and are never re-run; `runner/memory.js` was
effectively untested going forward. **Its bd stub is a `.js` file spawned through
`process.execPath`, never a `#!/bin/sh` script.** `runner/bd.js` spawns the seam command
with `spawnSync` and no shell, and on the Windows host a shell script spawned that way
returns status `null` with `EFTYPE` — so the obvious extraction is green in the container
and red in the host sweep. The stub is preloaded into node with
`NODE_OPTIONS=--require "<stub>"` (quoted: repo and temp paths may contain spaces), which
works because node runs preloads before it resolves the main module.

**`scripts/test-changelog.sh` is the second** (repo-006): it reads markdown and nothing
else, so it needs no Docker, no network and no target repo. It checks §12's table shape
(four cells per row, counted *after* masking backtick spans — one row carries
`done|partial|failed|stuck` in a code span and so has three pipes that are not cell
boundaries), that every ref is a unique kebab-case slug and never a bare date, that no
what-changed cell is led by a version token, and that every pinned citation in the five
living documents resolves to a row that exists. Same shape as the memory suite: a thin
`sh` wrapper over `tests/unit/changelog.test.js`, with all parsing in the Node checker —
`tools/run-acceptance.sh` invokes `*.sh` through `sh`, which is bash on the Windows host
and dash in a container, so shell-side parsing is exactly the kind of thing that goes
green in one and red in the other. Set `CHANGELOG_FILE` to aim the checker at a fixture
instead of `DESIGN.md`; that seam is what makes the negative cases falsifiable, since a
duplicate-detector that is a no-op still passes "exits 0 on the good file".

**`scripts/test-sanitize.sh` is the third** (change-log row `publish-sanitize-followup`):
it enumerates the tracked tree with `git ls-files` and reads each file as a Buffer, so
publication hygiene is checked rather than trusted. It fails on absolute user-home paths,
absolute paths outside the standard toolchain, real email addresses and credential-shaped
strings; placeholder segments (`path/to`, a literal ellipsis, angle-bracket slots, a
generic scratch root) are allowed, which is what keeps the rule specific enough to leave
switched on. Private *names* are not in it — they live in `.sanitize-denylist`, git-ignored
with `.sanitize-denylist.example` committed as the template, because a committed list of
things that must not be mentioned publishes exactly what it protects. Absent, the generic
checks still run and the suite prints a `NOTE`, so a fresh clone is green. `SANITIZE_FIXTURE_DIR`
aims it at a directory instead of the tracked tree; that seam is what makes the negative
cases falsifiable.

**`scripts/test-agent-hooks.sh` is the fourth** (change-log row `agent-hooks-untracked`):
it enumerates the tracked tree and fails on any committed agent hook — a file under
`.claude/hooks/` or `.codex/hooks/`, a `hooks.json`, or a `settings*.json` carrying a
`hooks` property. This repo is a target of its own pipeline, so a committed hook is cloned
into a task container that has no `bd` and no network, and fires on every session there.
The rule was already written down — `ONBOARDING.md`'s "remove hooks" step — and it still
lost: `bd` rewrites `.claude/settings.json` when it re-initialises, so the `bd prime`
SessionStart entry that onboarding deleted came back in a later commit and sat there
unnoticed. **A checklist step cannot beat a tool that regenerates the file**, which is the
general lesson: a one-time removal of something a tool re-creates needs scaffolding, not
discipline. Hooks stay welcome on the host in `.claude/settings.local.json`, git-ignored —
the exemption is being untracked, not being spelled `.local`, so the checker still flags
that file if it is ever committed. `AGENT_HOOKS_FIXTURE_DIR` aims it at a directory
instead of the tracked tree. One negative case plants a `hooks` key in a settings file
that is *not* valid JSON, because a checker inspecting only parsed JSON would report
"cannot be checked", exit 0, and allow the thing it exists to stop.

**Why it reads bytes and never skips a "binary" file.** This suite exists because
`publish-sanitize` missed a private project name in `tests/acceptance/repo-006/test.js`,
and so did the first automated sweep that went looking for it: that file masks backtick
spans with a **literal NUL byte**, so git classifies it as binary and `git grep` skips it
by default — it is the only binary file in the repo, and it was the one holding the leak.
A hand pass and a `git grep` pass failed on the same file for the same reason. Negative
case 3 in the wrapper plants a term in a file containing a NUL and fails the suite if the
checker does not find it, so that specific blindness cannot come back. This is the
"assert the artifact is *right*, not merely present" rule (§3.6) applied to an audit: a
scanner reporting zero findings and a scanner that cannot see the file look identical.

**Full re-run 2026-07-26**, after the five dogfood/queue PRs merged to `main`: all 18
suites green, including `e2e.sh` (32 assertions, real PR opened and cleaned up). Two were
red before the fixes above — `test-runner-queue.sh` (hung; defect 6 plus two stale
fixtures: the pinned reset timestamp, and an assertion on `results.json`, which T17 had
renamed to `run.json`) and `test-fixture.sh` (leftover state from an earlier
`e2e.sh --keep`). **`test-entrypoint.sh` was fine** — repo-52m's docs-phase rewrite kept
the stub path compatible, because `status.js summary` falls back to the raw file when
there is no JSON envelope. The lesson generalizes: the suites that break are the ones
nobody re-runs, and T12 had accumulated three separate staleness bugs from T15 and T17.

**That re-run happened only because someone asked** — nothing made it a habit, and the
gap outlived the defects it found. `scripts/test-all.sh` closes it: one command, all
18 suites, a summary you can paste. It is deterministic scaffolding like everything else
in the control path (hard rule 7). `CLAUDE.md` names when to run it — after merging a
batch, before a shadow run, on picking up a cold branch.

**First sweep, 2026-07-26: 17 of 17 green in 9:38** (`--skip e2e`; `e2e.sh` adds ~5 min
and opens a live PR, so it is excluded only when a run is unattended-unsafe, not by
default). The slowest four are `runner-queue` 2:17, `runner-container` 1:28, `publish`
1:20, `workspace` 1:14 — the whole thing is a coffee break, not an overnight job, which
is the number that matters for whether the habit sticks. Note what the sweep does *not*
do: it does not run itself. Automating it (a post-merge hook, a schedule) was considered
and deferred — `e2e.sh` opening a live PR means the trigger needs a policy, not just a
hook, and 10 minutes is cheap enough that a named ritual may be sufficient.

**Second sweep, after merging PRs #10, #11 and #13: 19 suites, 18 green.** The one red was
`test-runner-memory`, added by `repo-dhp` minutes earlier — defect 9. This is the sweep
paying for itself on its first real use, and it is the case for the habit in one line:
**the defect was invisible to every other gate the pipeline has.** The task's own frozen
tests passed, the verifier passed it, the PR review passed it, and it was still broken on
the machine the suite exists to run on.

**Third sweep, after merging #14 and #15: 20 of 20 green in 10:55**, including `e2e`'s 32
assertions and both new suites (`test-changelog` 21 checks, `test-runner-memory` green on
the host this time). That is the whole of 2026-07-26's work verified together rather than
task by task.

**Gap worth knowing:** `runner/memory.js` (both §3.6 channels) has no
`scripts/test-runner-*.sh` suite — its coverage lives in the Docker-free acceptance tests
at `tests/acceptance/repo-eyn/` and `tests/acceptance/repo-4gp/`, which drive it through
the `PIPELINE_BD_CMD` stub seam. Fold it into a `test-runner-memory.sh` if the module
grows past the two entry points. The same is true of `pipeline/envelope.js` and
`status.js summary`: their coverage is `tests/acceptance/repo-52m/` and
`tests/acceptance/repo-wxh/`, which drive the whole entrypoint with a `PIPELINE_AGENT_CMD`
stub and a stub `verify.js` (never the real verifier — that would self-nest, the
shadow-01 lesson). Note the seam between those two: a verifier run covers only the task's
own directory, so `repo-wxh`'s suite shells out to `node tests/acceptance/repo-52m/test.js`
and asserts exit 0. That is the only thing standing between a change to `envelope.js` and
a silent regression in the one-argument `parse(text)` that `status.js summary` depends on
— `scripts/test-entrypoint.sh` needs Docker, which the container cannot run. A later task
touching this module should chain the same way.

**Gap worth knowing:** `pipeline/envelope.js` and `status.js summary` have no
`scripts/test-*.sh` suite — their coverage is `tests/acceptance/repo-52m/`, which drives
the whole entrypoint with a `PIPELINE_AGENT_CMD` stub and a stub `verify.js` (never the
real verifier — that would self-nest, the shadow-01 lesson). That is a frozen artifact of
a finished task, so nothing re-runs it: the modules are untested going forward. The same
gap covered `runner/memory.js` until repo-dhp closed it by extracting
`tests/acceptance/repo-eyn/` + `repo-4gp/`'s coverage into `tests/unit/memory.test.js`
(the frozen directories stayed put — extract, never move). Extracting the entrypoint
coverage the same way is the obvious next one, and the `PIPELINE_AGENT_CMD` stub it needs
must be a `.js` file run through `process.execPath` for the same EFTYPE reason.

**Fourth sweep, after merging #16 (the epic filter): 20 of 20 green in 10:59.**
`test-runner-queue` passed its full 24 assertions — it is the suite whose six greps of the
queue-summary line `repo-4l8` rewrote, confirmed on merged `main` and not only on the task
branch. That gap was known before the task ran: the frozen tests for `repo-4l8` cannot
reach `run.js`'s log line at all (it sits behind `loadToken` and the Docker preflight, and
`--dry-run` returns before the task loop), so the spec named this Docker suite as the
thing that covers it instead of pretending a frozen test could. Checking it before merge —
and again on `main` — is what that admission is for.
