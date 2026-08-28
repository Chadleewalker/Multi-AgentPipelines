# Status

Where the build actually is. Update this when something changes — it is the file a new
session reads to pick up the thread, and unlike a machine-local memory folder it travels
with the repo.

_Last updated: 2026-08-28_

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
   (The carry now lives on the run-level pause gate rather than in a `run.js` local, and
   the cap counts for the whole run — `repo-i9y`, below. The duplicate hard-coded 96 inside
   `pause.js` went with it: two copies of one default is the same defect waiting.)
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

11. **The sweep reclaimed a live task container out from under a concurrent run** (found
    2026-08-01, in the second real project, after a session had spent its remaining time
    blaming Docker Desktop). A task container died with **exit 137 and zero bytes of log**
    after 6–18 seconds, reproducibly, across four attempts. Preflight passed every time and
    the image ran fine standalone. The diagnosis on the table was the WSL2 VM's memory.

    It was `scripts/test-all.sh`, running at the same time in another terminal. The sweep
    said so itself, in its own summary table, in the column built for exactly this:

    ```
    PASS  test-runner-workspace  20  0:41  reclaimed container 832261f6d5f3 (task-<id>-…-1)
    PASS  test-pause-gate       101  0:01  reclaimed container b15837732930 (<project>-proxy)
    ```

    Nobody read it, because nobody had a reason to open a green sweep's summary while
    debugging something else. The same collision also produced the sweep's one red suite
    (`test-lock`: "1 lock file(s) left in `runs/locks`" — the concurrent run's own lock), so
    the failure was already being reported twice under two unrelated names.

    **`sweep-reclaim.js` is working as designed, and the design is not sufficient.** Its
    header names this case outright — "or a container from a concurrent run" — and claims
    the before/after snapshot diff prevents it. It cannot. The diff proves *absent before my
    suite started*, which a legitimately concurrent run's container also satisfies; combined
    with the `task-` prefix allowlist, that is a `docker rm -f` on live work. Ownership by
    diff answers "did this appear while I was running", not "did I create it", and those are
    the same question only when nothing else is running.

    Three things generalise. **A snapshot diff is not a proof of authorship** — it is one
    only under an exclusivity assumption that nothing enforces. `CLAUDE.md` tells you to run
    suites one at a time and §4.12's lock stops two runs of one project, but nothing stops a
    sweep and a run, which is the pairing that actually happened. **The evidence was
    published and still cost a session**, so "make it visible where a human already looks"
    has a limit: the sweep summary is where a human looks *at the sweep*, and the person
    debugging was looking at a run. A reclamation of something matching `task-` is not
    housekeeping and should be loud on both sides of the collision. And **the symptom named
    no cause at all** — SIGKILL from outside with no log is indistinguishable from an OOM
    kill, which is why the investigation went to the VM and stayed there.

    The durable fix is mutual exclusion between the sweep and any live run, in the same
    place §4.12's lock already lives: the sweep takes a lock the runner respects and refuses
    to start while any `runs/locks/*.lock` is held, and vice versa. Not yet built — see
    `docs/IDEAS.md`. Until it is, **check `docker ps` and `runs/locks/` before blaming
    Docker for a 137.**

12. **The verifier fails a task whose tests all passed, when the suite prints more than
    1 MiB** (found 2026-08-11 by a coding agent on a real target task, and raised
    through the concern channel — §3.3 working exactly as designed, on the one target the
    agent is otherwise forbidden to touch). `pipeline/verify.js` runs both the acceptance
    and the regression command through `spawnSync` **without passing `maxBuffer`**, so
    Node's 1 MiB default applies. On overflow `spawnSync` kills the child and returns
    `status: null` with `error.code === 'ENOBUFS'`; the very next line reads
    `acc.status === 0 ? 'pass' : 'fail'`, so a suite that passed every test is recorded as
    an acceptance **failure**. That task's first attempt emitted 1,058,241 bytes and burned an attempt
    on correct work; the agent reproduced it byte-for-byte against the recorded tail before
    filing.

    This is the "plausible and wrong" family again (defects 2, 5, 7, 8), but it is the
    worst-shaped instance so far, for three reasons.

    - **It is the verifier.** Hard rule 2 says the verifier is the one thing an agent
      cannot influence; the price of that authority is that its verdict has to be about the
      code. A verdict that is really about stdout volume is not a verdict.
    - **The evidence actively misleads.** `acceptanceOutput` keeps only the last 4 KB of a
      *truncated* capture, so the artifact a human reads at 2 AM is a log stopping
      mid-sentence with no `FAIL:` line and nothing naming a cause — the unactionable
      overnight failure §3.5 exists to prevent, arriving through the gate rather than
      through an LLM judge.
    - **It scales with the target, not with the fault.** A chatty suite (Godot prints a
      resource error per missing asset per boot) can cross the ceiling on a task that
      touches none of this, burn all three attempts, and report `stuck`. Nothing in the
      artifacts would say why.

    Note what it did to the *target* repo: the agent's fix was to memoize
    a repeated resource-loading call in the target's own source — a sound change
    on its merits, made for the wrong reason, in a file the task was already editing. A
    harness defect that pressures agents into unrelated target-code changes is buying its
    own invisibility.

    **Fixed 2026-08-11 (change-log row `verify-nobuffer`), at Chad's direction in the same
    session.** Both `spawnSync` calls pass an explicit 64 MiB `maxBuffer`, and the verdict
    rule moved to `pipeline/verify-classify.js` as a pure `classify()` — exit 0 is `pass`,
    any *numeric* nonzero exit is `fail`, and `status === null` is `error` with a `why`
    naming the limit hit. Acceptance `error` exits 4 into the entrypoint's existing
    internal-error path, so a harness fault stops and says so instead of spending the
    attempt cap and landing on `stuck`.

    **What the new suite proves, and why it is the pair rather than the single case.**
    `scripts/test-verify-buffer.sh` (the fifteenth Docker-free suite) builds throwaway
    repositories whose acceptance command prints a chosen number of bytes and exits with a
    chosen code. Two fixtures differ *only* in exit code, both printing 1.2 MiB: the
    passing one must read `pass` — the old code said `fail` — and the failing one must
    still read `fail`. That second case is the one that matters most, because the obvious
    careless fix for this defect (treat a killed run as benign, or stop trusting a nonzero
    exit that came with a big log) would buy the first case by breaking hard rule 2. The
    suite was verified by reverting the fix behind a backup and re-running: it reproduces
    the exact defect signature, `acceptance=fail rc=1` on a suite where every assertion
    passed, plus the truncated-evidence symptom.

    The lesson worth carrying past this defect: **a default is a decision nobody wrote
    down.** Nothing in this file was configured wrongly — 1 MiB was simply what Node picks
    when you say nothing, and it silently became the pipeline's policy on how loud a test
    suite may be. That is why the shell wrapper asserts on the *source* that both calls
    still pass an explicit `maxBuffer`: a behavioural check alone would go quiet again the
    moment a future edit dropped the argument, and stay quiet until some target's suite
    happened to get chatty.

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
  Bounded like every other path since `repo-sls` — a stub that hangs fails the test loudly
  at `bdTimeoutMs` instead of hanging the suite.
- **`bd` can print its whole answer and then never exit**, and two `bd` calls over one
  embedded Dolt database can block on each other forever. Both were seen on 2026-07-28 and
  are why every runner Beads call is now bounded (`repo-sls`, above). If you write a new
  host-side `bd` invocation, put it through `runner/bd.js` — a bare `spawnSync('bd', …)`
  elsewhere is unbounded again, and the failure it produces is a run that parks silently.
- **The Claude CLI writes chatter around its output**, and a warning line on stdout is
  enough to break a whole-file `JSON.parse`. Never parse an agent log as one document:
  `pipeline/envelope.js` scans lines bottom-up for the first that parses to an object with
  a string `result`. The rule is structural on purpose — no list of known warning strings
  to maintain when a CLI upgrade invents new noise. Untrusted-workspace warnings are also
  removed at source: the entrypoint seeds `hasTrustDialogAccepted` /
  `hasCompletedOnboarding` for `$WS` into `$HOME/.claude.json` before the first agent call.
- **Test suites share one Docker network.** Run them one at a time; concurrent runs tear
  `pipeline-net` down under each other and produce meaningless failures. Real runs no
  longer share it (`repo-jur` made the network and sidecar per project), but the suites
  deliberately still use the default pair, so this stays true of them.
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

**The host side shipped** (change-log row `spec-concern-surfacing`, 2026-08-01). A concern
now reaches all four surfaces §3.7 names: a count on the attempt log, the array on the
manifest, and a `⚠ Spec concern(s) raised (n)` block quoting every entry verbatim in both
the run report and the PR body — **above the change summary in each**, because a concern
cannot change an outcome and therefore rides on whatever the task scored, and `done` sorts
last. `scripts/test-report.sh` covers both renderers and pins the invariant that matters:
a first-try `done` carrying two concerns still sorts dead last, so the channel stayed
evidence and did not become a soft gate.

What it cost to find out: the channel was declared 2026-07-26 and half-built, and the
first real concern any run has raised — 2026-08-01, on a private target — landed in the
status file and stopped there. Nothing a reviewer opens carried it. It surfaced only
because someone read `status.json` by hand, and its content was a freeze-gate hazard worth
having: the frozen test required one member name to be answerable as a method *and* as a
property, which the target language cannot do from one class, and the agent measured that
the method-only reading hung the engine when the value was iterated rather than erroring.
That spec would have timed the runner out instead of reporting red.

**And then the channel failed one level up** (change-log row `concern-repeat-surfacing`).
Across two consecutive runs against one target, seven task agents independently diagnosed
the same host-side fault — correctly, with evidence, naming each other by issue id — and
nothing consumed any of them; the second run repeated the first's mistake at eight times
the scale and spent 3h11m recording eight `stuck`. Every one of those concerns was
surfaced exactly as the paragraph above describes, as a section of the task that raised
it, which is right for one concern and wrong for seven.

**The run-level headline shipped** (change-log row `repo-uig`). `runner/report.js` now
prints one line between the outcome counts and the first task heading, for every manifest:
`Spec concerns: <total> raised by <k> of <n> tasks`. Three things about it are load-bearing
and each is pinned by `tests/acceptance/repo-uig/`. It is **unconditional** — a clean run
reads `0 raised by 0 of 6`, and the wrong build everyone reaches for first is the per-task
guard `if (t.specConcerns && t.specConcerns.length)` hoisted to run level, which prints
nothing on a clean run and passes every fixture that has concerns. A malformed
`specConcerns` counts as **zero**, via `Array.isArray` — `(x || []).length` scores the
string `'nope'` as four raised by one, which is non-empty, well-formed and false
(`repo-iok`'s case one level up). And the heading is **bold, never `## `**, because
`scripts/test-report.sh` reads task order with `grep -o '^## [a-z0-9-]*'` and a run-level
`## ` would inject a phantom task into that assertion.

Gap worth knowing: this is the first half only. The grouping-by-shape half — cluster a
run's concerns, and count how many prior runs against the same target carry each shape —
is not built, and nothing in this half reads `runs/`, deliberately: the frozen suite
renders the same manifest from an empty cwd and from one holding a populated `runs/` and
requires the two to be byte-identical, so the reproducibility claim in `runner/report.js`'s
footer stays as strong as it was.

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

## Network and proxy are per project (`repo-jur`, 2026-07-30)

Two runner processes against different projects used to destroy each other's plumbing.
`pipeline-net` and `pipeline-proxy` were constants in `scripts/pipeline-net.sh` and again
in `scripts/egress-check.sh`, so the `network` / `proxyName` fields already sitting in
every `run.config.*.json` reached the task container (`runner/container.js`) and nothing
else. Starting a second run ran an unconditional `docker rm -f pipeline-proxy` — the first
run's only route to Anthropic — and finishing either run removed the network and the
sidecar for both. **Neither failure announced itself**: the surviving run simply lost its
plumbing, and its agent started failing in ways that read as the model's fault.

Both scripts now take `PIPELINE_NET`, `PIPELINE_PROXY` and `PIPELINE_PROXY_PORT` from the
environment — the idiom `BASE_IMG` already used there — each **defaulting to today's
value**, which is what keeps the dozen Docker suites that hard-code those names in their
cleanup traps green without an edit. `runner/preflight.js` is the only seam that sets
them: `networkUp(repoRoot, cfg, log, traceId)`, `networkDown(repoRoot, cfg)` and
`egressCheck(repoRoot, cfg)`. The gate moving with the run matters as much as the
container did — an egress check that passes against another project's network proves
nothing about this one.

Where the names come from is the part worth remembering. A shared *default* is the same
bug one step back, so `network` / `proxyName` were **removed from `DEFAULTS`** rather than
kept as a fallback: when a config names neither, both are derived from the project segment
of the config file's own name (`run.config.<project>.json`), sanitised to one lower-case
DNS label — DNS, not merely Docker, because the proxy name is the host part of every
container's `HTTPS_PROXY`, so an underscore or a capital fails at run time inside the
container where no host-side check is watching. Derivation is a **pure function of the
file name**: a pid-, clock- or random-derived name passes every uniqueness check and then
orphans the network, because teardown computes a different name than setup did. A lossy
sanitisation is pinned with an 8-hex digest of the original, so two project names that
reduce to the same label still get different networks. A bare `run.config.json` — what the
runner's own suites generate — has no project segment and keeps the historical pair, which
is the other half of why the suites stay green; running two projects at once therefore
means naming each config `run.config.<project>.json`, and `run.config.example.json` no
longer pins either field. The proxy **image** tag `pipeline-proxy:local` stays shared
(identical content per project) and the allowlist is untouched: names move, policy does
not (hard rule 6).

This is several independent runner processes, one per project, each still a sequential
loop over its own queue — **not** the intra-run parallelism of §7 (change-log row
`parallelism-v2`), which is still out of scope.

The runner half of it stays covered by `scripts/test-network-names.sh` (Docker-free, see
the test-suite section); the scripts' own defaults are covered where they always were, by
the Docker suites that run them for real. **The host sweep is the obligation this task
cannot discharge from inside a container**: `bash scripts/test-all.sh` is what proves the
dozen suites that hard-code `pipeline-net` in a cleanup trap are still green.

## One run per project, enforced (`repo-os9`, 2026-07-31)

`repo-jur` above made two *different* projects independent. It did nothing about starting
the *same* project twice, which is then the remaining way to corrupt a run — and it is the
easy mistake to make, because **the second run looks like it starts normally**. There is no
clash to notice: both runners read Beads' ready list, both can claim the same issue, both
push a branch for it. The sole-writer rule (DESIGN.md §4.10) assumes one writer, and two
runners on one queue quietly break it.

So a run now takes a lock on its target repo. `runner/lock.js` is `acquire(repoRoot,
targetRepoPath, runId)` and `release(repoRoot, targetRepoPath)`, the file lives under the
git-ignored `runs/` directory beside the sweep lock `scripts/test-all.sh` already takes,
and a second run is refused by name — naming the project and the run holding it, exit
non-zero, nothing created.

**"First gate" is the load-bearing part, not "early gate."** `preflight` takes the lock
ahead of the Docker probe. Every other gate either shells `docker` or writes to Beads, and
the Beads one is the reason: a refusal arriving after the stale-issue sweep has already
reset another *live* run's `in_progress` issues back to `open` has not refused anything
useful — it has corrupted the run it was trying to protect. Being first is also what makes
the refusal free of cleanup (no network, no sidecar, no container, no Beads write) and what
makes the whole thing testable with no Docker at all, which is why the frozen suite can
drive the real `runner/run.js` end to end from inside a task container.

Two details are where the design actually is:

- **Identity is the repo, not the string it was spelled with.** The path is canonicalised —
  trailing separator folded, the Windows separator flip and case folded, symlinks resolved
  where they resolve. Configs write `targetRepoPath` with forward slashes while `path.join`
  produces backslashes, so on the reference host a drive-letter path spelled each way is
  one repo. A lock keyed on the raw string passes every other check and fails the one case
  it exists for: a second config, written by hand, naming the same repo differently.
- **A dead holder is taken over, and the takeover says whose lock it seized.** A lock left
  by a killed run must never block the machine forever. Deciding "dead" takes more than a
  pid: `process.kill(pid, 0)` reports a recycled or foreign pid as **alive** (EPERM counts
  as alive), so a pid-only record refuses to take over after a reboot — which is exactly
  the block-forever it was supposed to prevent. The record carries the process start time
  where the OS exposes one (Linux `/proc/<pid>/stat` field 22 — exact, so a recycled pid is
  decidable rather than merely improbable) plus the host's uptime counter, which only
  resets at boot. Where a platform proves neither, a pid recycled *within* one boot reads
  as still held, deliberately: a spurious refusal is visible and recoverable, a spurious
  takeover puts two runners on one queue. And the log line names the displaced run id,
  because a bare "took over" cannot be told apart from an implementation that reports one
  every time.

Release is **not** registered inside `acquire`, which looks like an omission and is not: a
crashed run has to leave its lock behind for the next run to seize, and that takeover is
the only protection when a process dies without running handlers. `run.js` registers the
release against process exit at the moment the lock becomes ours, so the queue-read abort,
an unexpected throw and the normal end all free the project; `preflight` releases on each
of its own later failures. Operator stop is out of scope by the same reasoning the frozen
suite states: Node on Windows cannot catch a signal delivered to a spawned child, so a
release-on-signal test could never pass in the host sweep — takeover covers that case
instead. `release` removes only a record that says it is ours, so a refused run cannot free
the lock it was just refused by and hand the project to the third run to ask.

**The host obligation this task cannot discharge from a container:** `bash
scripts/test-all.sh`. Every Docker suite that runs `node runner/run.js` now passes through
a new first gate, several of them several times against one target repo, and only the sweep
proves that release-then-reacquire holds for all of them on the reference host.

## The pipeline built real features unattended (2026-07-30/31)

**The first sustained production use, and the thing the whole design was for.** Eight tasks
were specced, frozen and run against one target project across four batches. **Every one
returned `done` on the first attempt** — no `tampered`, no `stuck`, no second attempts. The
target's acceptance suite went from 262 tests to 317, and its own checklist from 12 ticked
items to 20, with every line of implementation written by a container agent against tests it
could not edit.

What that exercised, all of it built the same day: the frozen-path lint before any critic, the
freeze gate proving each suite red before it could judge anything, the mandatory testability
pass, per-project networks, and the memory round trip (104 notes exported into the first run,
146 by the fifth).

**Three defects were found by scaffolding rather than by anyone noticing** — the design's
central bet, paying out again:

1. **The freeze gate blessed a suite that never ran.** A frozen suite carried a parse error; the
   target's runner exited 2, which its own header documents as *broken harness* rather than
   *failed test*. The gate compared only "real non-zero" against "control green" and called it
   RED. **The control cannot catch this by construction** — it proves the harness works on
   *other* tests, so a suite whose own script fails to load leaves the control perfectly green.
   Fixed: a real exit above 1 with a green control is now `indeterminate`. The first fix put the
   check before the control check and preempted the empty-probe guidance; the suite caught that
   too. See the change log.
2. **The empty-directory control was wrong in the worst direction.** It survived every stubbed
   test and died on the first real `verifyCommand`, because a good runner *should* fail on "no
   test files found". The better the target's runner, the more surely the probe fails — so the
   gate would have answered `indeterminate` for every well-built project. The control is now a
   trivially-passing test committed per project.
3. **The frozen-path lint fired on a real spec**, matching a frozen path inside a test comment.
   True positive by the rule, false positive by intent. Dispositioned *rejected, with reason* —
   which is exactly why that check reports rather than gates.

**Batching works, with one caveat that is now measured.** File ownership stated in each spec's
constraints prevented every code collision across four batches. The documentation phase collided
every single time, because every task edits the target's design doc, README and spec file — and
that is the finding parallelism has to answer. `docs/parallelism-findings-2026-07-31.md` records
the measurements, including that the speedup is bounded by the slowest task and the variance
across comparable tasks is 3.6×.

**What this does not prove.** Every task here was drafted by one context that also wrote its own
criteria and reviewed them against the testability charter itself, because no independent
context was available. That is weaker than §3.2 asks for, and the panel's value came precisely
from being unprimed. Eight-for-eight on specs reviewed by their author is a claim about the
execution half of the pipeline, not about the planning half.

## Intra-run parallelism, planned 2026-07-31 (three tasks, three batches)

The §7 concurrency knob was planned against `docs/parallelism-findings-2026-07-31.md`. The
session opened intending to freeze **one** hard parallelism task alongside `repo-sls`. The
critic panel returned `concerns` from all three charters — **30 findings** — and two were
premise-breaking rather than cosmetic, so the shape changed twice mid-session.

| Batch | Issue | Task | State |
|---|---|---|---|
| 1 | `repo-sls` | bound every runner `bd` call | **frozen**, ready |
| 1 | `repo-os9` | refuse a second run against one project | **built** (above), pending the host sweep |
| 1 | `repo-sls` | bound every runner `bd` call | **shipped** 2026-07-31, passed on attempt 1 (below) |
| 1 | `repo-os9` | refuse a second run against one project | already frozen, ready |
| 2 | `repo-teq` | the bounded worker pool (the `concurrency` knob) | **shipped** 2026-07-31, passed on attempt 1 (below) |
| 3 | `repo-i9y` | park the whole run, not each task | **shipped** 2026-07-31, passed on attempt 1 (below) |

**The two findings that changed the plan**, both worth keeping because both are about *how the
batching discipline fails*, not about parallelism:

1. **The claimed file-disjointness was false, and the first draft resolved it in the wrong
   direction.** `repo-sls`'s approved criterion is "the bound is configurable with a documented
   default"; §4.12 puts every production tunable in `run.config.json`, which is
   `runner/config.js` — which the parallelism task also owned. The draft "resolved" the clash by
   demoting `repo-sls`'s knob to an environment variable, and `PIPELINE_*` is reserved for test
   seams. That is batching convenience bending the configuration contract, and the scope critic
   named it as such. The fix was to stop batching them: `repo-sls` runs first, alone, keeping
   its field. **File ownership stated in a spec is only worth something if the statement is
   checked** — this one was asserted by the drafter and was wrong.
2. **The parallelism task was two tasks.** The pool and the run-level park pass and fail
   independently. The argument for keeping them together — "the intermediate state is unsafe,
   because N tasks would each run their own pause loop" — did not survive inspection: the knob
   is opt-in and defaults to 1, so `main` is never in that state unless someone asks for it.

**The finding that mattered most is a testability one, and it generalises.** Five of the six
original criteria described `runner/run.js`'s task loop, and **nothing Docker-free can execute
that loop**: `run.js` calls `main()` at module scope, and `main()` sits behind `loadToken` and a
Docker preflight that always fails in a task container. Frozen as written, those criteria could
only have become greps of `run.js`'s source — which every previous task that touched `run.js`
already conceded in writing (`repo-4l8` F6, `repo-iok` A3-weak). So `repo-teq` now carries an
explicit constraint: **the scheduler is an exported function and `main()` is guarded behind
`require.main === module`.** The critic's alternative — a `PIPELINE_SKIP_PREFLIGHT` seam — was
rejected: a production flag that skips the egress gate is a hard-rule-6 hazard.

Two more that are the "assert the artifact is *right*" rule biting again, in a new place —
**assertions that cannot fail**:

- *"No two `bd` invocations overlap"* was a criterion. It cannot fail: `spawnSync` blocks the
  event loop, so in a single-threaded runner no serialisation and full serialisation both pass.
  It was a property of the *runtime* asserted as a property of the *code*. It moved to
  `repo-sls` as the constraint that actually protects it — **the bound must keep `bd()`
  synchronous**, never an async spawn — because that synchrony is what the sole-writer rule will
  rest on the moment a worker pool exists.
- *"A container already running is not killed"* was a criterion. `PIPELINE_EXEC_STUB` replaces
  the entire function that owns the kill timer, so no Docker-free test has an implementation it
  could contradict. It is a host obligation now, not a check.

**Blast radius nobody had counted.** Three runner Docker suites make **50 literal `grep -q`
assertions** against log strings `run.js` and `pause.js` emit, and four frozen acceptance suites
assert that `fileMemoryNotes`, `queueSummary` and `shouldFileMemory` appear on non-comment lines
of `run.js`. This repo declares no `regressionCommand` and nothing re-runs a frozen directory,
so a loop restructure can invalidate all of it silently. `repo-teq` carries those identifiers as
a constraint *and* as a guard criterion; the log-string repair is a named host obligation.

**`repo-sls` is frozen** at `tests/acceptance/repo-sls/` (28 checks; freeze gate RED against a
green control, 2 guards declared and verified). Two results there were fixed rather than
accepted, both the panel's own lesson applied to the tests themselves: a guard failed because
Node resolves `argv[1]` to an absolute path under `--require`, so the assertion was measuring
the harness rather than the seam; and `an explicit bdTimeoutMs wins` passes *today*, because
`loadConfig` spreads unknown fields straight through — the discriminating half of that criterion
is the **default**, not the override.

**What is not frozen, deliberately.** `repo-teq` and `repo-i9y` have approved intent and no
tests. Neither can run until the batch before it merges, and freezing tests weeks before the run
that executes them is how suites go stale (the T12 failure — three staleness bugs in a suite
nobody re-ran). Their acceptance tests get written in the planning session immediately before
their own run, which is PLANNING.md's rule and the same posture `repo-iok` and `repo-sls` itself
have held since 2026-07-28.

## Every runner `bd` call is bounded (`repo-sls`, 2026-07-31)

Batch 1's first task ran and passed on attempt 1. `runner/bd.js` had called `spawnSync` with
no `timeout`, so a `bd` that never returned parked the run forever — observed twice on
2026-07-28 (complete JSON output printed, process never exited; and two calls over one
embedded Dolt database blocking on each other). The sweep harness killed four suites at 900s;
a real run has no such backstop, and the worst window is *after* the container exits, where
the `bd remember` / finish pair runs — a hang there strands finished work with the issue still
`in_progress` and the outcome unwritten.

- **One builder, every spawn.** `spawnOptions(cfg)` is exported from `runner/bd.js` and every
  `spawnSync` in the module is constructed from it — including both host-`bd` probes in
  `hostBdSpec`, because a probe that hangs parks a run exactly as a call that hangs does, and
  because a Docker-free test can only execute the `PIPELINE_BD_CMD` branch. `killSignal` is
  `SIGKILL`: a bound a wedged process can decline to honour is not a bound.
- **`bdTimeoutMs` in `run.config.json`**, default 60000, validated by `loadConfig` as a
  positive whole number in the same error shape as `maxAttempts` and `maxPauseCycles`, and
  present in `run.config.example.json`. A config field, not a `PIPELINE_*` variable — that
  namespace is test seams only, and the planning session's first draft demoted it to an
  environment variable purely to keep two tasks in one batch (above).
- **Loud, never silent.** A timeout returns status 124 with stderr naming the bound and the
  field that set it, so `bdJson` yields `ok:false` with that text and cannot be mistaken for a
  successful empty query — the distinction this whole change exists to preserve. No caller
  changed: every one of them already handles a non-zero status the way §4.11 requires.
- **`bd()` stays synchronous, and that is now written down** (§4.10, change-log row
  `repo-sls`). `spawnSync` blocking the event loop is what stops two `bd` calls interleaving
  over one embedded database; an async rewrite would delete the sole-writer guarantee silently,
  at exactly the moment `repo-teq`'s worker pool starts running tasks concurrently.

`repo-teq` is what this unblocks — it is also why the bound shipped first: under `spawnSync`
one hung call stalls *every* concurrent task, not one, and concurrent access to a single
embedded Dolt database is precisely the load that produced the original hang.
## Four more tasks, and the first task the panel sent *out* of the pipeline (2026-07-31)

**Four tasks, four `done`, all on attempt 1** — `repo-sls` and `repo-os9` here (PRs #19, #20),
two tasks on the target project (two more PRs). Active times 7, 17, 25 and 26 minutes. No
`tampered`, no `stuck`, no second attempts, and no spec concerns raised.

**The panel is now 12 for 12.** Four critics ran over three draft specs and returned 54 findings,
every one `concerns`. Two were the "gate that cannot fail" family this repo keeps meeting:

- The glint spec's determinism criterion compared **two instances of the same build**, so it could
  only ever catch a perturbation that *depended on being polled*. An unconditional change to the
  flight moves both instances identically and leaves the criterion green. Fixed by capturing golden
  values from the fork point during the planning session and asserting against those — the only
  expected value in the file that does not come from the implementation under test.
- The literal audit's headline criterion was "the checker reports nothing against the tree". The
  same task writes both the checker **and** the allowlist it is measured against, so whatever the
  checker cannot see is not in the allowlist and is therefore not a violation: a `violations()`
  returning `[]` unconditionally passed it in full. Fixed by running the checker with the allowlist
  **taken away** and requiring findings the frozen test names independently.

**A task whose output is data rather than code does not belong in the pipeline.** The pacing-grid
task was withdrawn mid-session and done interactively instead. Both critics reached it
independently: after its scope was cut it wrote no code at all, and its acceptance floors ("at
least 6 rows landed") were *predictions about a grid nobody had flown* — so had reality returned
five, no honest implementation could pass and the cheapest route to green was fabrication in the 52
rows nothing re-checked. Flying it took 8.5 minutes and produced three findings nobody had. The
general rule: **if a spec's criteria can only be checked by re-running the tool that produced the
artifact, the planning session should run the tool.** That is what an earlier measurement task already did, and this
is the second instance.

**A new gotcha, and it can make a suite permanently unfreezable.** A frozen test necessarily names
files the task has not written yet. Calling `load()` on one makes the engine print a resource-load
error, and the target's `run-acceptance.sh` reads that output as **BROKEN HARNESS (exit 2)** rather
than as a failing test — so the suite reports "could not run" forever and the freeze gate refuses
it, with a symptom that looks like a parse error that is not there. Probe with
`FileAccess.file_exists` first. This is the same family as STATUS defect 9: a harness that cannot
run reporting something other than "I could not run". Recorded in that project's
`tests/acceptance/README.md`, where the next test author will look.

**The batch collision was predicted, priced, and happened exactly as written.** The planning draft
said the audit could go red on a correct merge if a sibling introduced a new literal, and named the
fix as three allowlist rows rather than a config change. It did, and it was. Verified by merging
both branches locally and running the **full** tree — 372/372 acceptance, 120/120 regression — which
is the obligation no task's own verifier can discharge.

**Blocked, and it is the only thing blocking:** `gh pr merge` is denied by this environment's
permission classifier, so both of this repo's PRs and both of the target's are open. The four remaining issues here
(`repo-teq`, `repo-i9y`, `repo-diy`, `repo-ixa`) were blocked *and* unfrozen, and `repo-teq` genuinely
builds on `repo-sls`, so nothing further could run until those merged. `repo-teq` and
`repo-i9y` have since been frozen and shipped, in that order (both below); `repo-diy` and
`repo-ixa` are still blocked and unfrozen.

## The bounded worker pool (`repo-teq`, 2026-07-31)

Batch 2's task ran and passed on attempt 1. `run.config.json` now carries **`concurrency`**,
default **1** and capped at a literal **3**, and one runner process works that many task
containers of its project at once instead of a strict `for` loop. Default behaviour is the
sequential loop unchanged; §4.12 carries the full amendment and change-log row `repo-teq` the
reasoning.

- **`drainQueue(issues, taskFn, concurrency)` is exported from `runner/run.js`**, and
  `main()` is now behind `require.main === module`. That guard is the whole reason any of
  this is testable: `main()` sits behind a token load and a Docker preflight that always fail
  in a task container, so before it, five of this task's six criteria could only have become
  greps of `run.js`'s own source — which is what every previous task touching that file
  conceded in writing (`repo-4l8` F6, `repo-iok` A3-weak). The rejected alternative was a
  `PIPELINE_SKIP_PREFLIGHT` seam, i.e. a production flag that skips the egress gate.
- **Results come back in ready-queue order, not completion order.** N fixed workers pull from
  one shared cursor and write into their own index. The frozen suite drives it with inverted
  durations so the last-queued task finishes first — the naive append-on-completion, which is
  what anyone would write, fails that and nothing else would have caught it.
- **The execution seam had to stop blocking the event loop.** `executeTask`'s
  `PIPELINE_EXEC_STUB` path was `spawnSync`, which serialises every stubbed task and makes
  concurrency **unobservable to exactly the Docker-free suites that must prove it**. It is
  `spawn` now, with the `bash <stub>` invocation, the four environment variables and the
  `124 -> killed` mapping all unchanged, because three Docker suites depend on them and none
  of them can run in a container.
- **Concurrency is asserted by rendezvous, never by wall clock.** The fixture cannot complete
  unless N task bodies are genuinely in flight, and the same fixture at concurrency 1 must
  record the give-up marker — which is what makes the check discriminating rather than
  something an unbounded pool also passes. A timing margin would flake on a loaded machine.
- **What it deliberately did not do:** the rate-limit park stayed per task — `repo-i9y`
  (below) has since made it run-level, so at
  depth > 1 N parked tasks each ran their own pause loop against one shared subscription
  window — wasteful, not corrupting, and unreachable at the default, which is what made
  shipping the pool first safe. `prepare()` and `publish()` stay synchronous and serialise
  the workers for their few seconds; the accepted consequence is a wall-clock kill timer
  firing a few seconds late while a peer is cloning.

**The blast radius held.** `fileMemoryNotes`, `queueSummary`, `shouldFileMemory` and the
literal `exitCode !== 20` all survived a restructure that moved the entire task body into a
new function — four frozen acceptance suites and one Docker suite assert them against
`run.js` source, and nothing re-runs a frozen directory, so a guard criterion that was green
*before* the change is what carried them.

**Host obligation, unchanged from what the planning session named:** the three runner Docker
suites make 50 literal `grep -q` assertions against log strings `run.js` and `pause.js` emit,
and no Docker-free suite can see them. Run the sweep on the reference host after this merges.
A real run at concurrency > 1 is also still unproven — that needs a daemon, an image and a
Beads database, and it is the first thing to try on a daytime batch of small tasks.

## The run-level rate-limit park (`repo-i9y`, 2026-07-31)

Batch 3's task ran and passed on attempt 1, and it is the other half of §7. A usage limit
is a property of the **subscription window**, not of a task, so with `repo-teq`'s pool in
place N parked tasks were N uncoordinated sleeps against one window, each with its own cap.
`runner/pause.js` now exports **`createPauseGate(cfg, log, opts)`**; `runner/run.js` builds
exactly one gate in `main()` and hands it to every `runOneTask(cfg, issue, log, token, gate)`,
and `waitForWindow` is no longer called from `run.js` at all. §4.7 and §7 are amended and
change-log row `repo-i9y` carries the reasoning.

- **One shared wait, and joining never extends it.** The first exit 20 of the run opens the
  wait on *that* task's reported reset time; a later reporter joins the one in flight. The
  join decision is made **synchronously on entry, before any await** — that is the whole
  mechanism, because N containers hitting the limit in the same tick must find one wait
  between them, and an `await` before the check gives each of them its own. If the window
  is still closed when the wait ends, the relaunched tasks exit 20 again and open a fresh
  one: self-correcting, and bounded by the run-level cap rather than by N per-task caps.
- **Park means admit no new work, never kill what is running.** §7's original wording read
  as parking live containers. It does not: killing one discards agent work that may be
  minutes from finishing and spends wall-clock budget for nothing, and a container whose
  window is genuinely closed hits the limit and exits 20 by itself, joining the same wait.
  The frozen test judges this from an events array — peers finish with their own results
  while the gate is closed, and the held task records no start until it reopens.
- **The counter is read from `result.pauses` and from nowhere else.** `waitForWindow`
  resolves `{resumed:true, pauses:n}` **or** `{resumed:false, reason}` — and the failure
  branch carries **no count**. `run.js` had been papering over that with
  `waited.pauses || waitCycles`. The gate takes a missing count as "nothing new to report"
  and leaves `gate.cycles` exactly as it was: never `NaN`, never reset to zero. A
  `resumed:false` also exhausts the gate. `pause.js`'s duplicate hard-coded `96` now defers
  to `config.js`'s `DEFAULTS`, and its comment claiming "deadline exceeded / operator stop"
  stop conditions is gone — those never existed; the cycle cap is the only one.
- **Two quantities were both called `pauses`, and they stay separate.** `pause.js`'s means
  *wait cycles* and is now run-level; `run.js`'s local means *relaunches*, stays per task,
  and is what the manifest row reports — `runner/report.js` and `schemas/run.schema.json`
  read that field and neither was this task's to touch. The log line still renders as
  `rate limit hit (pause 1)`, because `scripts/test-runner-pause.sh` greps the **digit** and
  a run-level count logged in the per-task slot would slip past a prefix match.
- **Admission sits before `claim()`, which is what splits the two populations.** *Parked* —
  launched, exited 20, waited, gave up: issue stays `in_progress`, normal `paused` row,
  unchanged. *Refused* — the cap had already fired, so it never launched: no `bd`
  subcommand is invoked **at all**, so the issue stays `open` for the next run. It still
  resolves a synthesized `{issueId, outcome:'paused'}` row, because `main()`'s
  `.filter(Boolean)` would otherwise erase it from `run.json` entirely — a silent hole in
  the record of an unattended overnight run, and no schema edit was needed since the
  outcome enum already admits `paused` and the row is `additionalProperties:false`.

**The blast radius held again**, and it is the same one `repo-teq` navigated. `exitCode !== 20`
had to stay on a non-comment line of `run.js` **specifically** — `scripts/test-runner-pause.sh:136`
greps it out of that file by name and `repo-teq`'s frozen A6 asserts it there — so a
tidier "move the exit-code handling into `pause.js`" would have passed every gate the
implementer can run and broken two suites silently. `wall-clock budget exhausted` is used
by that suite as a **negative** assertion, so drift there goes vacuously green rather than
red. Those strings are held by a guard criterion because nothing re-runs a frozen directory
and this repo declares no `regressionCommand`.

**Host obligations, none of which a frozen test can hold:** run `bash scripts/test-runner-pause.sh`
and `bash scripts/test-runner-queue.sh` on the reference host — criterion 8 keeps the
strings, but only a real run proves the *sequence*; run `bash scripts/test-all.sh`, since
the new suite is swept by glob and has never run there; and fix
`scripts/test-runner-queue.sh`'s now-false "the cap is per-task" **comment** (comment only,
never its assertions) — that file is a frozen-by-constraint suite this task could neither
edit nor execute. A real run at concurrency > 1 against a genuine usage limit stays
unproven until a daytime batch hits one.

## The review verdict is written down (`repo-1ie`, 2026-08-04)

`scripts/verdict.js` ships — the host-side capture step DESIGN.md §5 declared in
change-log row `review-verdict`, and now change-log row `repo-1ie`. Two commands:
`record <issue-id> <merged|rejected> "<why>" [--run <runId>]` writes
`runs/<runId>/tasks/<issue-id>/verdict.json`, and `pending` lists every PR-bearing task
that still lacks one, newest run first. **Run `pending` at the end of a review session** —
it is the difference between an unfinished review being visible and being remembered.

**Why it exists** is the trial line at the top of this file: two merged PRs, one rejected,
and nothing
anywhere recorded which was which. The run record said `done`, green, one attempt for the
rejected one. Merge-or-send-back is the only signal the pipeline cannot generate about
itself, it exists for one moment at review time, and anything that tries to recover it
later is inferring what could simply have been written down.

**What it deliberately is not:** a gate, or anything with an opinion. It creates or
overwrites exactly one file per call and edits no existing artifact — not `run.json`, not
`status.json` — and `pending` exits 0 whatever it finds. Refusals are validated before the
runs tree is even read, so a rejected command leaves it byte-identical. No LLM (hard rule
7), no Beads and in fact no child process at all (it must work where `bd` was never
installed), and node built-ins only — the file is self-contained so a copy of it works from
any repo-shaped root, which is also what makes the default-root behaviour provable.

**The decision worth knowing about is which run a verdict lands in**, because every cheap
answer is wrong on the real tree: the run is chosen by `run.json`'s `startedAt`, never by
runId (three naming shapes exist here and sort wrong against each other) and never by
directory mtime (a copy or a backup rewrites it). A manifest with no parseable `startedAt`
sorts oldest and is never chosen over a dated one; `--run` overrides recency outright.
`prUrl: null` is a real value in real manifests, so only a truthy non-empty string counts
as PR-bearing and the written verdict has *no* `prUrl` key rather than a null one. With
`VERDICT_RUNS_DIR` unset the runs root comes from the script's own location, never the cwd
— a reviewer runs this from wherever they happen to be. Everything malformed under the
runs root is skipped silently, because a report that crashes on `sweeps/` or a half-written
`run.json` is useless exactly when it is most needed.

**Host obligations, two:** run `bash scripts/test-all.sh` on the reference host — the new
suite is swept by glob and has never run there — and hand-update
`docs/pipeline-map.html`, which CLAUDE.md exempts from task docs phases and which nothing
else updates. Three of its panels draw the review decision (the end-to-end flow, the
"Merge, or send back" row of the who-does-what table, and the second end-to-end chart) and
none of them yet shows the verdict being written down; `docs/pipeline-diagram.md`, which
task docs phases *do* keep current, has the node. Nothing else is outstanding: the recorder
needs no Docker, no network and no target repo.

## The status file says which phase a task is in (`repo-bmd`, 2026-08-11)

`status.json` carries a `phase` — `code`, `verify` or `docs` — written by
`pipeline/entrypoint.sh` on *entry* to each boundary through `pipeline/status.js`. It is
the one deterministic feed DESIGN.md §5's live dashboard needed that the pipeline was not
already writing (change-log rows `live-dashboard` and `repo-bmd`); the other half of that
batch is `repo-kfg`, the `/state` reader. The draft's second half — a workspace-path log
line — was dropped in fresh-context review, because `runner/workspace.js` already logs
`workspace ready:` for every prepared workspace. **No `run.log` wording changed and
nothing under `runner/` was touched**, so the Docker suites that grep those lines are
unaffected.

**Three properties are load-bearing, and each has a plausible wrong version.** The write is
on *entry*, not exit: a single write at the end produces a final file that reads `docs`
exactly as a correct implementation does, while leaving the field dark for the whole time a
watcher would be looking at it — defect 8's shape, non-empty and false. It is **non-fatal**,
styled on the `model` write (`2>/dev/null`, never `die30`): an unwritable status file must
not turn a task into an internal error. And it is **not an outcome** — nothing in the
runner, the verifier or the report branches on it, which is what keeps a watcher a reader
(hard rules 5 and 7).

**Two insertion hazards worth carrying forward**, because both are silent. The code- and
docs-phase boundaries sit immediately above `{ … } > "$RUN/prompt-*.md"` blocks, so a write
placed one line low runs *inside* the redirect and becomes part of the agent's prompt
instead of the status file — the frozen suite checks the captured prompt for exactly that.
And nothing may go between `node "$PIPE/verify.js"` and the `VRC=$?` that captures its exit
code, or every outcome below is decided on the wrong number.

**Coverage:** `tests/acceptance/repo-bmd/` (43 assertions, Docker-free) drives the real
entrypoint against stub agents and stub verifiers, observing the phase *from inside* it —
the agent and verify stubs snapshot `status.json` mid-phase — and checks every terminal
path (10, 11, 20, and 0 with a docs-phase error) plus a drive where every `set phase` call
fails outright. It is a frozen artifact of this task, so nothing re-runs it; the schema
addition is additive (`required` and `additionalProperties` untouched), which is what keeps
every status file in the existing corpus valid.

**Host obligation, one:** hand-update `docs/pipeline-map.html` if the phase feed belongs on
a panel — CLAUDE.md exempts it from task docs phases and nothing else updates it.
`docs/pipeline-diagram.md` already names the three phases it draws, and this task changed
no shape there.

## A run can be watched while it happens (`repo-kfg`, 2026-08-11)

`scripts/dashboard.js` ships — the reader half of the live dashboard DESIGN.md §5 declared
in change-log row `live-dashboard`, and now change-log row `repo-kfg`. Run
`node scripts/dashboard.js` and open the one line it prints
(`dashboard: http://127.0.0.1:4770/`); `DASHBOARD_RUNS_DIR` re-aims the runs root and
`DASHBOARD_PORT` moves the port (`0` for an ephemeral one). `GET /state` is the frozen JSON
contract — projects, the run each is showing, its park, its queue and its tasks with phase,
attempt, workspace and PR — assembled per request from `runs/locks/*.lock`, `run.log`,
`run.json` and the status files. `GET /` is a **placeholder page**: the visible view is
interactive work against that contract and is the piece still outstanding.

**Why the reader is the pipeline task and the page is not** is the split the planning
session took on the scope critic's argument: JSON is a thing frozen tests can pin exactly,
and a look is a thing you review by looking at it, which a three-attempt unattended
container cannot do.

**Two derivations are worth knowing, because both cheap answers are wrong.** The run a
project shows is picked by **the held lock's `runId`**, not by which directory under
`runs/` is newest — a live run is routinely not the newest directory, so "newest wins" goes
dark exactly when someone is watching. And a run directory with **no `run.json` is a
`no-manifest` run, never a skipped one**: the manifest is written when a run *ends*, so
`verdict.js`'s rule of skipping such a directory would hide every run in flight. Both are
pinned by fixtures the wrong reading cannot pass (the newest directory in the frozen suite
is a decoy).

**What it deliberately is not:** anything that can touch a run. It writes nothing anywhere,
spawns nothing, holds no `bd` and no Docker, requires only node built-ins, and has no route
by which to reach a container — the audit's contract (change-log row `repo-73k`) applied to
a live tree. It binds `127.0.0.1` and nothing else, because the page names target repos, PR
URLs and issue titles: that bind is the machinery/work boundary this repo is public on
account of. Malformed artifacts render as named terms in a closed `degraded` vocabulary at
their own level rather than as a 500 or a dropped project — a watcher at 2 AM needs the
missing thing named, not a blank screen.

**Host obligations, two.** Run `bash scripts/test-all.sh` on the reference host — the new
suite is swept by glob and has never run there. *(Done 2026-08-11: 36 of 36 suites green in
9:28.)* And hand-update `docs/pipeline-map.html`, which CLAUDE.md exempts from task docs
phases and which nothing else updates: its end-to-end panels draw the run and the post-hoc
audit, and none of them yet shows the live reader hanging off the run in flight.
`docs/pipeline-diagram.md`, which task docs phases *do* keep current, has the node. Nothing
else is outstanding — the reader needs no Docker, no network and no target repo.

## The live view ships, and looking at it found two things (`live-dashboard-page`, 2026-08-11)

`GET /` now serves the real page, which closes the live-dashboard feature declared in
change-log row `live-dashboard`. `node scripts/dashboard.js`, open the one line it prints.
The look is the house palette from `docs/pipeline-map.html` — teal flow, amber "the task is
here" lamps — and the page renders exactly the brief: run header, the queue with each
in-flight task at its node, a code/verify/docs strip per running task with the current phase
lit, elapsed computed browser-side from the server's `now`, the storage row, the queued
strip.

**Why this was an interactive session and not a pipeline task** is settled by what building
it found, because neither defect is reachable from a frozen test. The first: the contract's
`attempt` is `status.attempts.length`, and that array gains an entry only once the verifier
has **judged** an attempt — so a task working its first attempt reports `0`, and the page
would have read "attempt 0/3" for most of a task's life. The implementation matches its
frozen test exactly; the **spec** is what is wrong, so the re-freeze is parked at the top of
`docs/IDEAS.md` and the page computes `attempt + 1` for an in-flight task in the meantime.
The second was invisible until someone looked: the two-second poll rebuilds the whole list,
which threw away the open/closed state of every panel, so an expanded project **snapped shut
within two seconds of being opened**. Open panels are now keyed by project key across
repaints, and an unchanged tree with no live project is not repainted at all.

**One view decision worth knowing.** Idle projects collapse to a single line, expandable.
The corpus on the reference host holds 34 projects, 28 of them historical e2e fixture targets
all named `target`; a full card each buries the run someone opened the page to watch. The
fixtures are **not** special-cased — that would be a lie about what the tree holds, and the
handoff explicitly ruled it out. Live projects sort first and render full; everything else is
one row until asked. Degraded terms follow the same principle: `no-manifest` on a *running*
run and `workspace-missing` on a *finished* one are ordinary states, so they render muted,
and red is kept for what a watcher can actually act on.

**Proven against three trees, because a page that only works on fixtures is not proven:** the
reference host's real 34-project corpus, a synthetic multi-task live fixture (two tasks in
different phases, one queued, park absent), and a genuine live run in flight — the phase lamp,
the container node and `attempt 1/3` all read correctly against a real container.

## The batch marker has a reader (`repo-0b3`, 2026-08-20)

`scripts/batch.js` ships — the first half of DESIGN.md §3.9's planning-to-launch handoff
(change-log row `batch-ready-marker`, now `repo-0b3`). A planning session's last act writes
`runs/batches/<project>-<YYYY-MM-DD>.json`; a later session reads it back with
`node scripts/batch.js show` (the newest marker, **launched or not**, with `worked` /
`not-worked` per id) or `node scripts/batch.js pending` (batches no run has worked since
their freeze, newest freeze first). `BATCH_RUNS_DIR` re-aims the root. The marker shape is
pinned here: `runConfig`, `frozenAt` and `issues[{id,title}]` required, `integrationBranch`,
`freezeCommit`, `intent` and `approvedBy` optional and printed only when present.

**The `bd ready` reconciliation was not wired in this half** — that is `repo-8v0`, below,
split out by the panel because it adds a host dependency, a second join through a git-ignored
run config, and a degraded vocabulary of its own. The split bought a property worth keeping:
this half **spawns nothing at all**, so the suite proving it cannot pass vacuously on a host
where `bd` was never installed — and `pending`, which is all of this half, still spawns
nothing now that the other half has landed.

**Two derivations, both of whose cheap answers are wrong.** A run's clock is `startedAt` from
`run.json` *when there is one*, else the leading instant on the first line of `run.log` — 74
of the reference host's 272 run directories have no manifest, and `verdict.js`'s rule of
skipping such a directory (correct for its own purpose) would report an interrupted run's
batch as never launched. And a run datable by neither **counts as having worked** the ids it
names, labelled `run-time-unknown`: a false "pending" invites a double launch, a false
"launched" only sends someone to look. The frozen fixture that pins this is one manifest-less
run dated once before and once after the same freeze, which a `verdict.js`-shaped join gets
wrong the same way in both halves.

**The filename's date is naming only.** `frozenAt` is the clock; the stem is anchored at both
ends with the project taken greedily, so `orbit-lab-2026-08-19` is the project `orbit-lab`
rather than `orbit`, a file that is only a date is not a marker, and anything else under
`batches/` — a `.txt`, truncated JSON, a JSON array — is skipped silently rather than crashed
on, because a human writes into that directory too.

**One known and accepted consequence:** `scripts/audit-runs.js` counts `batches/` under its
Corpus **other entries**. That is expected — it is not a run directory and the audit says so
correctly — and re-teaching the audit about a directory it has no other reason to know is
parked in `docs/IDEAS.md`. The `repo-0b3` guard excludes exactly that accounting and pins
everything else the audit prints as unchanged, along with byte-identical `verdict.js pending`
output and a deep-equal dashboard `/state`.

**Host obligation, one:** run `bash scripts/test-all.sh` on the reference host — the new
suite is swept by glob and has never run there. Nothing else is outstanding; the reader needs
no Docker, no network, no target repo and, in this half, no `bd`.

## The marker is reconciled against the live queue (`repo-8v0`, 2026-08-20)

The second half ships, closing change-log row `batch-ready-marker`. `node scripts/batch.js
show` now answers the question the marker exists for: **does the queue this run will drain
match what was frozen?** Per id, `ready` or `not-ready`; per queue entry the batch never
named, one `stray` line. That check has no other detector — the runner has no picker (§4.12)
and drains whatever it finds, so an issue nobody meant to include simply runs and a blocked
one silently does not, and nothing else in the pipeline holds the *intent* to compare a queue
against. `PLANNING.md` step 8's first bullet is now automated; the CLAUDE.md entry and the
step 8 line that said otherwise are corrected.

**One spawn, and only under `show`.** The marker's `run.config.<project>.json` is resolved
from `BATCH_CONFIG_DIR` (else this repo's root, never the cwd) and read by plain `JSON.parse`
for `targetRepoPath` alone — deliberately not `runner/config.js`'s loader, which validates a
whole run and would turn an unrelated missing key into an unactionable `unreconciled`. Then
one `-C <targetRepoPath> ready --json` through the **existing `PIPELINE_BD_CMD`** seam,
bounded by that config's `bdTimeoutMs`, read-only (hard rule 1). `pending` still spawns
nothing, which is what keeps this bounded rather than absorbed.

**Two rules are imported, not copied**, and both were exported for this: `EXCLUDED_TYPES`
with `typeOf` from `runner/queue.js`, so an epic parent — which `bd ready` returns by design —
is never called a stray, and `hostBdSpec` from `runner/bd.js`, so npm's shim pair resolves
the one way this host resolves it. The report's whole value is that it predicts what the
runner will drain; a private second copy of either rule predicts a runner that no longer
exists the day one of them changes (the call `sweep-trustworthy` made for `isHolderLive`).

**Three gotchas worth carrying forward.**
- A call killed at the bound is **`bd-unreadable`, not `bd-unavailable`** — `bd` was there
  and did not answer, which sends a person somewhere different from `bd` not being installed.
- `spawnSync` reports a **capture overflow and a timeout identically**: null status, the same
  kill signal, and only `error.code` (`ENOBUFS` vs `ETIMEDOUT`) between them. The ceiling is
  raised to 8 MiB — a real ready queue can exceed the 1 MiB default — and tested for *before*
  the bound, or a query that answered at once is reported as one that never answered.
- The vector handed to the seam **leads with a throwaway program slot** (`bd`), the slot the
  Windows shim path fills with the resolved `bd.js`. Node's own parser owns `-C` as the short
  form of `--conditions` and eats a leading `-C <path>` before a stubbed seam ever sees it —
  which repo was consulted would stop being observable to the only suites that can prove it.

**Both halves of the vocabulary are load-bearing together.** The degraded fixtures alone pass
a tool that always says `unreconciled`; a reconciling fixture alone passes a tool that never
notices `bd` is dead. `tests/unit/batch.test.js` grew section G for exactly this and now runs
67 checks; it drives everything through the seam against a stand-in, so it still needs no
`bd`, no network and no target repo.

**Host obligations, two.** Run `bash scripts/test-all.sh` on the reference host — `runner/bd.js`
and `runner/queue.js` gained exports, and `scripts/test-runner-queue.sh`, `test-bd-seams.sh`
and `test-bd-shim.sh` all drive real Docker and could not run in the container. And this is
the first `scripts/` reader that reaches into `runner/`, so the "node built-ins only" line in
`README.md`'s layout table (if it still reads that way) wants a second look.

## The ready queue refuses an unfrozen task (`repo-5yu`, 2026-08-21)

**Built.** The dispatchability gate ships, closing the declaration in change-log row
`dispatch-gate` (DESIGN.md §4.12's second admission rule, §4.11's `undispatchable` row,
change-log row `repo-5yu`). Until now the type filter was the ready queue's *only* admission
rule, so a run's answer to "should this go out?" was "`bd ready` returned it and it is not an
epic" — and Beads tracks issues, not freezes. Two consecutive runs against one target
dispatched fourteen tasks of which eight could never have passed, the second spending 3h11m
to record eight `stuck`.

`readyQueue()` now returns a third population beside `skipped`, keyed `undispatchable`. After
the type filter, and only when candidates remain, one `git fetch <targetRepoRemote> <branch>`
into a throwaway repository under the OS temp dir, then one
`git ls-tree -d --name-only FETCH_HEAD -- tests/acceptance/<issue-id>` per candidate. Empty
output, not dispatchable: the issue is dropped from `issues` before `claim()`, named in the
queue-summary line with the remedy, and manufactured by the exported pure
`undispatchableRow()` into a `run.json` row. Beads is untouched — no note, no status change,
no attempt-log line — so a refused issue stays `open` for a freeze session to pick straight
up.

**The two fixtures that carry the result**, both in `tests/unit/dispatch-gate.test.js` as well
as the frozen directory, and both chosen so a plausible wrong implementation *fails* rather
than merely being exercised:

- **A target working copy whose `origin` holds the suite while `targetRepoRemote` does not,
  plus its exact mirror.** Every other fixture in either suite is refused by a working-tree
  check too, so only that pair discriminates the shipped design from the one it replaces.
  `targetRepoPath` and `targetRepoRemote` are independent config keys `runner/config.js` never
  relates, and five of the seven observed failures had their suite present *locally* — in an
  unpushed commit, or untracked. Freezing locally is not freezing.
- **A `master` project carrying no `pipeline.config.json`.** The only fixture that catches a
  branch chain ending at the literal `'main'` — which is `runner/workspace.js`'s
  `detectDefaultBranch`, correct there (it only runs against a fresh clone where `origin/HEAD`
  is always set) and catastrophic here, where guessing `main` empties `ls-tree` for *every*
  issue and refuses the whole queue with a confident wrong reason. The chain here is
  `pipeline.config.json`, else `git ls-remote --symref`, else abort. No literal last resort.

Both were proven in both directions before shipping, and so was everything else load-bearing:
mutating the source to drop the `-d`, to spawn without the options builder, to skip cleanup on
the abort path, to fetch without a refspec, to read the working copy instead of `FETCH_HEAD`,
or to end the branch chain at `main` turns the suite red in each case.

**The bound and the channel.** Every `git` spawn in `runner/queue.js` is built from the
exported `gitSpawnOptions(cfg)`, whose `timeout` is a new `gitTimeoutMs` (default 60000,
validated by `loadConfig` exactly as `bdTimeoutMs` is, present in `run.config.example.json`) —
an exported builder some spawn ignores is scaffolding, and that is checked structurally as
well as behaviourally. `readyQueue()` reports failure as `{ ok: false, cause: 'git' | 'bd',
error }` and `run.js` branches on the **field**, never the wording: a fetch failure logged as
"cannot read the Beads ready queue" sends a person to the wrong system, and the run's own log
line lives behind `main()` where no Docker-free test can reach it.

**One shipped property was repealed, and its test rewritten rather than deleted.** An
unreachable `targetRepoRemote` used to be a *task* failure at exit 0 — the clone failed inside
`prepare()`, the task was reported, the run carried on — asserted as such by
`scripts/test-runner-workspace.sh`'s check 11. The gate reaches that remote first, so it is
now a run abort before anything is claimed. That check now asserts the abort, that it names
the remote, that it is not reported in the Beads channel, that no task launched, and that the
issue is still `open`. A tested property that stops being true and takes its own test with it
is indistinguishable from one that was never tested.

**Host obligations, two.** Run `bash scripts/test-all.sh` on the reference host:
`scripts/test-runner-workspace.sh` and `scripts/test-runner-queue.sh` both need Docker and
could not be run from the container, and check 11 above was edited blind — it is the one part
of this task no frozen test could verify. And `docs/pipeline-map.html` is exempt from task
docs phases and nothing else updates it (CLAUDE.md), so its runner panels still draw the type
filter as the only thing keeping an entry out of the loop; `docs/pipeline-diagram.md` was
amended here and the map was not. Editing it means re-running
`node scripts/build-pipeline-map.js`, which needs `tools/mapbuild/node_modules` and therefore
a host.

## One folder per agent session (`parallel-sessions`, 2026-08-25)

**Proven.** `scripts/worktree.js` + `docs/parallel-sessions.md` + a "Commit hygiene" section
in CLAUDE.md. Interactive-session practice only; no run executes differently.

The problem was several agent sessions pointed at one checkout. That is not several
workspaces — it is several agents typing into one set of files with one staging area, and
git cannot tell their work apart. Two failures, both being the correct behaviour of the
command involved: a `git add -A` swept four files belonging to another session into an
unrelated commit (nothing lost, history wrong — the worse half, since later sessions read
it as fact), and a `git checkout -- <path>` was run against a file another session was
editing, where only timing prevented permanent loss. Rules against both are now written and
are also the layer that fails at the fourth session at 11pm; the worktree is what makes the
collision impossible rather than discouraged.

**What the investigation actually found**, since three of the four answers were not the
expected ones:

- **Beads needs nothing done to it.** It resolves its database through git's *common
  directory*, so every worktree reads and writes the ONE database in the main checkout —
  `bd count` agrees across folders, and running `bd` in a worktree creates no second
  database there. So N sessions do not mean N queues and hard rule 1 survives untouched.
  This was the question that could have sunk the design: a forked queue is precisely what
  that rule exists to prevent. `bd worktree info` reports what a folder resolved to.
- **`runs/` is the one thing that must never be duplicated.** `runs/locks/` is what makes
  "one run per project" true (§4.12), so a copy is a second lock and two runners can drain
  one queue. It is also where every manifest and report lands, so a run launched from a
  worktree would *work* and write its history where `verdict.js`, `batch.js`,
  `audit-runs.js` and the dashboard never look — invisible, not broken, which is worse.
  Hence: launch runs from the main checkout only. The tool refuses that carry entry by name.
- **Seven host-only paths are present in the main checkout and absent from a fresh
  worktree** — `.env.pipeline`, `.sanitize-denylist`, `run.config.*.json`, `runs/`,
  `tools/mapbuild/node_modules`, `.claude/settings.local.json`, `.beads/embeddeddolt`. One
  is 388 MB, which is why `.worktree-carry` is a declared list and not a blanket copy. The
  one that matters is `.sanitize-denylist`: absent, `test-sanitize.sh` silently skips its
  project-specific checks and passes a tree it should have failed.
- **Environment variables are a non-issue** — they belong to the shell, not the folder.

**The mutation pass paid for itself twice.** The suite was green on its first run, which is
when to be suspicious. Measuring dirtiness with `git diff` (tracked files only) and dropping
the main checkout from `remove`'s candidate filter BOTH left it green — because `git worktree
remove` has guards of its own, so an exit-code-only assertion is satisfied by a broken
implementation that git happened to catch. Two checks now pin *this tool's* refusal message
rather than the exit code. Six mutations, six kills after the fix.

## The freeze gate reads the suite's text (`repo-uw6`, 2026-08-26)

**Proven.** `scripts/freeze-gate.js` grows `brittleFindings(text, file)` and
`lintSuite(dirOrFile)`; the report gains a `brittleness findings: <n>` block below the
verdict, in every verdict and with or without `--spec`. `PLANNING.md` step 4 gains the
disposition instruction, step 5's disposition paragraph now names the lint beside the panel,
and the coverage is re-runnable: `tests/unit/freeze-gate.test.js` 46 → 100 checks,
`scripts/test-freeze-gate.sh`'s floor 40 → 90. §3.2's move 6, built.

The gate answered one question — are these tests red at the fork point? — and **an entire
class of bad frozen test answers it correctly.** A criterion that pins a list of names,
asserts an exact count, hashes a whole build or diffs the branch against its own fork point
is red *and* discriminating at freeze, and then goes red again for every later task that
legitimately grows the thing it enumerated. One target repo has lost at least eight frozen
files across six suites to it. The worst shape **inverts** — it goes red precisely because
an unrelated later task did its job correctly — and no amount of red at freeze can detect
that, because at freeze it is genuinely red for the right reason.

**The panel renamed the rule, and that is the whole design.** The shapes were first named
after hashing and enumerating, which this repo's own frozen suites do — correctly. Six of
them hash a walked tree as the "writes nothing" guard and `repo-1cy` diffs against a
merge-base in the way CLAUDE.md cites as *correct*. What those seven share is that they
compare two values **computed in the same run**, and nothing later work does can move a
before/after snapshot. So the rule became:

> A guard is brittle when the **expected side of the assertion is a literal the author
> typed**, and the population it describes is one **later work is licensed to grow**.

A tool can check the first half exactly and the second half not at all — which is why every
finding is a question, and why the lint cannot touch the exit code in either direction. A
lint that can fail a freeze is a gate on spec *authoring*, and the way past a gate that can
fail you is to reword until it passes (hard rule 5).

**Why the near-miss pairs are the coverage and the positive cases are not.** A detector
keyed on `createHash` or on `git diff` fires on all seven house patterns — and scores full
marks on every "does the shape fire" check that exists. So the re-runnable suite leads with
the pairs, verbatim from this repo's own suites, before anything that merely exercises the
code. Run against the real `tests/acceptance/` tree the shipped lint returns 59 candidates
and leaves all six digest-snapshot guards and `repo-1cy`'s merge-base clean.

**Nine mutations, nine kills** — dropping the binary sniff, letting findings `return 1`,
keying the digest shape on the digest alone, keying the branch shape on `git diff` alone,
pinning every finding to line 1, disabling continuation joining, admitting counts of 0 and
1, dropping the assertion requirement from the name-list shape, and printing `0` where
`unavailable` belongs. **The last is caught only by the re-runnable suite**, because the
frozen criterion accepts either form — which is the concrete argument for why "extend
`tests/unit/`" was a deliverable of this task and not a nicety.

**Gap worth knowing, found while doing this and deliberately not fixed here.**
`scripts/test-freeze-gate.sh` is missing from the "All but twenty drive real Docker"
exception list below *and* from the suite table, and so are `scripts/test-spec-lint.sh` and
`scripts/test-planning-playbook.sh` — all three were run Docker-free inside a task container
during this task (46/28/42 checks, all green), so the real count is at least twenty-three.
Fixing the number needs the whole list re-derived rather than three names appended, which is
a different piece of work; the count sentence is left alone rather than made confidently
wrong. `test-planning-playbook.sh` additionally needs `bash`, not `sh` — under dash it dies
on `[[` at line 98 and prints `CHECKS FAILED`, a broken harness that reads as a real
regression.

**Host obligation.** `docs/pipeline-diagram.md` gained the freeze-gate node and its dotted
lint branch in this PR. `docs/pipeline-map.html` is exempt from task docs phases (CLAUDE.md)
and nothing else updates it, so its planning panel still shows the approval pass with no
freeze gate at all — one move behind before this task and two behind after it. Redraw with
`node scripts/build-pipeline-map.js` after editing; the builder needs
`tools/mapbuild/node_modules` and cannot run in a container.

## The freeze gate proves the green side too (`repo-inj`, 2026-08-27)

**Proven.** `scripts/freeze-gate.js` gains `--green <probe-dir>`: the same suite is run a
second and third time in a *probe* — a throwaway, repo-shaped tree in which the criteria are
already satisfied, by any means however crude — with cwd inside the probe, the **same**
repo-relative test-directory string as the fork-point run, and a control resolved against the
probe's own root. `verifyCommand` and `defaultBranch` are still read from the target's
`pipeline.config.json` and never the probe's: a probe-side config would be an editable thing
deciding how the probe is judged. The table gains `unreachable` (exit 3) and `half-proven`
(exit 4); 0, 1 and 2 keep their meanings, and the `red` token is deliberately kept for exit 0
because `scripts/test-freeze-gate.sh` greps the report for `RED:`. `tests/unit/freeze-gate.test.js`
100 → 170 checks, `scripts/test-freeze-gate.sh`'s floor 90 → 110.

**Why: red is only half the proof.** A suite that discriminates and a suite whose own fixture
is broken are **the same observation** — non-zero — so the gate had never once seen the thing
it blesses pass. It has cost two tasks three attempts each. `repo-8v0` froze with 11 of 29
checks unreachable by any implementation, because a `NODE_OPTIONS=--require` stub reached the
child the suite spawned and killed it before its first line. `repo-cfe` froze with the
criterion the task existed for calling `git init -q -c …`, where `-c` is a global option that
must precede the subcommand — so no repository was ever created, and its two neighbouring
checks passed *vacuously*, the file appends landing regardless and the control "conflicting"
only because git had errored. Both were diagnosed by the task agent through the concern
channel, in a container, at attempt three.

**A broken probe is `indeterminate`, never `unreachable`.** Exit 3 is reachable only behind a
green probe control, for the same reason the fork point's red means nothing when its own
control fails. That pair is the load-bearing fixture in both suites — a naive implementation
answers 3 for both, and only running both tells them apart — and every exit-2 detail now names
which side is broken: the fork point, the probe, the probe's control, or the arguments.
`half-proven` **proceeds**: a freeze with no probe stays legal, and the state is carried into
the approval pass the way the guard count is.

**Two defects fixed on the way past.** `runVerify` had no `maxBuffer`, so Node's 1 MiB default
applied and `spawnSync` killed the child on overflow — change-log row `verify-nobuffer`
recurring inside the gate that judges the freeze, and a passing probe is verbose by
definition. It now uses the `MAX_BUFFER` **imported** from `pipeline/verify-classify.js`, and
the suite pins both halves: the value, and that no line retypes it. The empty-directory
control's name was keyed on the pid alone, which was one name per process — with two trees in
play, the second call's `finally` deleted the first call's directory out from under it.

**Nine mutations, nine kills** — dropping the `maxBuffer`, swapping the `probe`/`probeControl`
argument order, letting a broken probe read as `unreachable`, handing the probe run an
absolute path into its own tree, resolving the probe's control against the target root,
keying the control directory on the pid alone, linting the probe's suite as well, removing the
suite comparison, and exiting 0 where `half-proven`'s 4 belongs. Two of them are caught by
*paired* fixtures and by nothing else: the probe-control one needs a probe that carries a
`_control` fixture beside a target that does not (with both trees shaped alike the wrong
answer is invisible), and the absolute-path one needs the stub to record which tree it woke up
in by dropping a **marker file**, never by string-comparing `process.cwd()` — on the reference
host a temp path can be an 8.3 short name, and Git Bash and the child disagree on separators
and case.

**The frozen `repo-uw6` suite is now red, by design.** Five of its checks assert the *old*
three-verdict table — `verdictFor` answering "all nine rows", the CLI answering 0/1/2 where a
probe-less red run now answers 4, and `RED:` appearing in output from runs that no longer
produce it (every one of them omits `--green`). The repeal is deliberate and is recorded in
change-log row `repo-inj`; the token itself survives and is pinned by both re-runnable suites.
Nothing re-runs a frozen directory — the verifier runs only the task's own — so this costs
nothing today, and it is the same shape `repo-iok` left behind in `repo-1cy`. It is also the
argument for extracting coverage into `tests/unit/` stated once more.

**Known gap, deliberate.** Constraint 4 asked for the probe's copy of the suite to be
compared byte for byte and any mismatch refused with exit 2. What ships refuses a probe that
does not carry the suite at all and one that **deleted** a file of it, and *names* every file
whose bytes differ in the report without moving the exit code — because criterion 6's frozen
fixture supplies a probe whose copy of the suite deliberately differs from the fork point's
and requires exit 0, so a strict byte-equality gate would make that criterion unsatisfiable.
Raised as a spec concern on the run. The cheapest way to close it later is to fix the fixture,
not the tool.

**Host obligation.** `docs/pipeline-map.html` is exempt from task docs phases (CLAUDE.md) and
nothing else updates it; its planning panel still shows the approval pass with no freeze gate
at all, and is now three moves behind. Redraw with `node scripts/build-pipeline-map.js` after
editing; the builder needs `tools/mapbuild/node_modules` and cannot run in a container.

## A `[guard]` test red at the fork point is a stale pin (`repo-i4b`, 2026-08-28)

**Proven.** `scripts/freeze-gate.js` gains `guardFiles(dir)`, `withGuardDir(...)`, a sixth
`verdictFor` argument and the sixth verdict: `stale-guard`, exit 5. A test file declaring
itself a guard — the literal `[guard]` token, any case, on a comment line within its first
ten lines — is copied into `<parent of --tests>/.freeze-gate-guards-<pid>-<seq>/` and run
**alone** through the project's own verify command. Green there is the only acceptable
answer. Red is exit 5, it beats `red`, `unreachable` and `half-proven`, and it
short-circuits the probe, so a stale guard with `--green` is three invocations rather than
five. The subset runs once, only from a fork point red at exactly 1 on a green control, and
reuses that tree's control result. A subset that could not run — above 1, killed, a failed
spawn, a copy that threw — is `indeterminate` naming the guard side, never 5.
`tests/unit/freeze-gate.test.js` 170 → 243 checks, `scripts/test-freeze-gate.sh` 37 → 47 of
its own and its floor 110 → 170. §3.2's stale guard, built; the receipt writer beside it
landed the same day (`repo-erq`, below).

**Why the whole-suite red cannot see it.** A guard is the one criterion that is *supposed*
to be green before any work exists, which is exactly what makes a red one invisible: one
ordinary criterion failing makes the run non-zero, and the stale guard hides inside that
number. Four of the twelve suites that reached `stuck` in one fortnight were guards pinned
to something that had already moved before the task was frozen — and no amount of
suite-level red could have said so, because the suite was correctly red either way. Running
the guards alone is the only observation that separates "the implementation is missing"
from "there is nothing left for this to be waiting for".

**Two decisions that read as details.** The subset directory is a **sibling** of the suite
at the same depth, not a temp directory: every frozen suite resolves its own root as
`path.resolve(__dirname, '..', '..', '..')`, so a guard judged from anywhere else resolves a
different tree and fails for a reason unrelated to its pin. The acceptance suite's
real-runner criterion is a pair written as one criterion for exactly this — the same guard
file, green then red, in the same tree — and a sibling-depth mistake fails only its green
half. And a guard that is absent, green, or a call made with five arguments all answer
identically, which is what lets the frozen `repo-inj` suite (which pins the five-verdict
table and cannot be edited) go on meaning what it meant. It is still green.

**A criterion this task could not satisfy as written, and why it is not a defect.**
Criterion 6 asks for "a `FREEZE_GATE_CMD` naming a command that does not exist behind a
red-on-green fork point → 2 naming the guard side". One environment variable drives all four
invocations, so a genuinely missing command takes the fork point down with it and the guard
side is never reached — that state is unreachable from a command line by construction. The
frozen suite does not ask for it (its A6 covers the guard-broken shape only). What ships
covers the branch from both sides instead: `verdictFor` is driven with an errored, a
signalled, a null-status and an exit-127 guard run, and the CLI is driven with a stub that
answers the subset exactly as `sh -c` answers a missing command — 127 on stderr. Raised as a
spec concern on the run.

**Host obligation.** `docs/pipeline-map.html` is one further move behind: its planning panel
now omits the guard subset as well as the gate itself.
## The freeze gate leaves a receipt (`repo-erq`, 2026-08-28)

**Proven.** On a verdict that *proceeds* — `red` (0) or `half-proven` (4) — `scripts/freeze-gate.js`
writes `tests/acceptance/<issue-id>/.freeze-gate.json` and names it on the last lines of its
report. Eight fields: `gateVersion` (1), `verdict`, `probeSupplied`, `suiteHash`, `gateHead`,
`guards`, `brittleness`, `writtenAt`. Exits 1, 2 and 3 write nothing and leave an existing
receipt byte-identical — a stale receipt beside a failing verdict is evidence, and it is the
dispatch gate's hash comparison that turns it into a refusal. `tests/unit/freeze-gate.test.js`
170 → 237 checks, `scripts/test-freeze-gate.sh`'s floor 110 → 220.

**The hash is over git blob ids, and the formula lives in one file.** `runner/suite-hash.js`
is new, host-only and node-built-ins-only: `suiteHash(entries)` sorts bytewise by suite-relative
path and hashes `path\0blob\n` with sha256, `workingTreeEntries` reads the planning checkout
(`git ls-files --cached --others --exclude-standard`, then `git hash-object --path`), and
`treeEntries` reads a commit, which is the side §4.12's third admission rule will use. Blob
ids rather than bytes because the reference host's checkout is CRLF and the committed blob is
LF: a byte hash would disagree with the branch on **every** freeze and the dispatch gate would
refuse every task it exists to admit. Both re-runnable suites carry the CRLF pair — the
filtered blob id beside the raw-byte one — because it is the only fixture that tells the two
implementations apart, and every other fixture in the file answers the same way for both.

**Taken before the suite is run.** A suite is entitled to write beside itself while it
executes, and those files are untracked entries inside the suite directory by the time the
runs are over; hashed afterwards, the receipt would pin a state only this machine has ever
seen. The frozen suite proves it with a stub that drops a file into the directory it is
judging, and the unit suite proves the same fact from the other side — that such a file *would*
move the hash.

**Two new refusals, both at exit 2.** A `--repo` that is not a git repository is refused before
a single verify run: every value on the receipt comes from git, so the alternative is a receipt
that hashes nothing — present, well-formed and meaningless. And a receipt that cannot be
written fails the whole invocation rather than warning under a passing verdict, naming the
path, because a verdict nothing recorded is a freeze the runner would refuse anyway.

**`compareSuites` now excludes the receipt.** It is written into the fork point's suite and
never into the probe, so from the second run onwards an unfiltered comparison would call it a
file the probe is *missing* and refuse — turning every re-run of a gated suite into an exit 2.
Excluded on both sides, since a probe copied from a gated tree carries a stale one.

**Nothing reads the receipt yet.** §4.12's third admission rule is the task after this one and
is marked *Not built yet* in `DESIGN.md`. That split is exactly why the coverage is re-runnable:
`tests/acceptance/repo-erq/` gated the writer once and never runs again, and the enforcer lands
a task later against a file this task defined.

**Host obligation.** `docs/pipeline-map.html` is exempt from task docs phases and nothing else
updates it; its planning panel now trails the freeze gate by four moves. Redraw with
`node scripts/build-pipeline-map.js` after editing; the builder needs
`tools/mapbuild/node_modules` and cannot run in a container.

## What's next

**The live queue feed shipped on 2026-08-25** — a run re-reads the ready queue while it is
in flight, so an issue frozen mid-run is picked up by the next free worker (change-log rows
`live-queue-feed`, `feed-readers`; §4.12). OFF by default: `feedIdleGraceMinutes` is 0 unless
a config asks otherwise, and at 0 the queue is read once exactly as before. **Two things a
task could not do for itself follow the merge**, and both are open as of this writing:
merge PR #47 (until it is in, `scripts/batch.js pending` reports a fed run's batch as
un-launched, and the cost of that wrong answer is a batch launched twice — so do not enable
the feed for any project first), and **run `bash scripts/test-all.sh`**, because two PRs
changed `runner/run.js`'s task loop and two readers with no Docker suite run against either.
The full picture, including how to use the feed and the two defects the work turned up, is in
`docs/handoff-2026-08-25-live-queue-feed.md`.

**The queue drained again on 2026-07-26**, after `repo-4l8` (the epic filter, planned and
frozen in the fifth planning session that day) ran and passed on attempt 1.
The only open issue left is `repo-iok` (the §3.7 host side), deliberately **blocked and
deliberately unfrozen** —
it cannot run in the same batch as its dependency (the runner reads the ready queue once,
before the task loop), and freezing tests weeks before the run that executes them is how
suites go stale. Its acceptance tests get written in the planning session immediately
before that run.

**The planning session of 2026-07-29 added two more**, both frozen —
`repo-jur` (per-project network and proxy, above) and `repo-os9` (refuse a second run
against the *same* project, which is the remaining way to corrupt a run once different
projects stop colliding). `repo-jur` ran on 2026-07-30 and passed on attempt 1;
`repo-os9` ran after it on 2026-07-31 and is built (the project lock, above). Two things a task cannot do for itself follow the
merge: run `bash scripts/test-all.sh` (criterion 6 is a promise about the dozen suites
that hard-code `pipeline-net`, and no frozen test can keep it), and **strip the
`"network"` and `"proxyName"` lines from every existing `run.config.*.json`** — they are
git-ignored, so no task can edit them, and until they are stripped they keep explicitly
asking for the shared pair and keep colliding. The log line `networkUp` now writes is how
you confirm the derivation took effect.

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
  **Sharpened 2026-07-31: the docs phase is not neglecting this file, it is obeying.** The reading
  table's own row says the HTML map is "not updated by task docs phases", and that table reaches
  every docs-phase invocation — the workspace is a full clone, so the target's `CLAUDE.md`
  auto-loads, and the prompt in `pipeline/entrypoint.sh` names no manifest of its own. The
  exclusion is doing exactly what it says. So this is a choice between two fixes rather than one:
  flip the label and let the docs phase own the file, or keep the exclusion and add the mechanical
  claim-check above. Doing both would be redundant.
- **Batched tasks collide.** Every task forks from the integration branch as the run
  starts, so two tasks touching the same file produce a conflict once the first merges
  (seen with PRs #2 and #3). Options: fork from latest, or partition concurrency by
  declared path ownership. Needed before any large wave.
  **Partly closed 2026-08-26: the worst offender was the change log.** Every task amends
  `DESIGN.md`, so every task appended a row to the same table at the same place — four of
  four PRs merged on 2026-08-25/26 needed a person, and three of the four were resolved
  identically (*keep both rows*). The rows now live in `docs/change-log.md`, which the
  repo-root `.gitattributes` marks `merge=union`: both sides are kept and nothing conflicts.
  That is safe on an append-only table and on nothing else — union merge on a prose file
  would silently keep both copies of an amended paragraph, which is why the attribute names
  that one path and must never be pointed at `DESIGN.md`. Its one blind spot, two branches
  rewriting the same row, lands as a duplicate `Ref` and `scripts/test-changelog.sh` fails
  on it. Files that are genuinely edited in place still collide, so the options above are
  still open — there is just one less collision per task.
- **Concurrency *within* a run is opt-in and small** — the runner defaults to the
  sequential loop. Since `repo-jur` several runner processes, one per project, can be in
  flight at once (each over its own queue), and since `repo-os9` a second run against the
  *same* project is refused rather than trusted not to happen; since `repo-teq` one runner
  works up to `concurrency` tasks of one project at once (default 1; the ceiling of 3 was
  lifted by change-log row `concurrency-uncapped`); and since
  `repo-i9y` a usage limit parks the whole run rather than each task separately. §7 is
  built. Note that none of it multiplies subscription capacity: N containers exhaust the
  same usage window N times faster, then the run parks as a whole — concurrency buys
  elapsed time, not throughput, which is why the default is 1 and long unattended runs stay
  sequential.
- **No review triage.** Hundreds of PRs would exceed human review capacity; an auto-merge
  policy for clean, small, green diffs would be needed.
- **Run-time advisors (slot 3)** are unbuilt. The sockets exist: `advisories` in
  `status.schema.json`, the read-only `/pipeline` mount, per-project selection in
  `pipeline.config.json`, and now the charter format in `advisors/README.md` — a slot-3
  charter is written the same way as the slot-1 ones. Nothing calls one yet; no run-time
  advisor is registered until the trial shows a lens that genuinely resists determinism.

## Test suites

All but twenty drive real Docker and share one network, so they must never run concurrently
(`test-runner-memory.sh`, `test-changelog.sh`, `test-sanitize.sh`,
`test-agent-hooks.sh`, `test-network-names.sh`, `test-lock.sh`,
`test-sweep-hygiene.sh`, `test-concurrency.sh`, `test-pause-gate.sh`,
`test-sweep-assertions.sh`, `test-trace.sh`, `test-verdict.sh`, `test-audit-runs.sh`,
`test-dashboard.sh`, `test-verify-buffer.sh`, `test-pipeline-map.sh`,
`test-batch.sh`, `test-dispatch-gate.sh`, `test-feed.sh` and `test-worktree.sh` are the
exceptions — see below; they need neither).
**`scripts/test-all.sh` is the sweep** — it holds a lock, runs every suite sequentially,
kills one that hangs (`--timeout`, default 900s), **reclaims what each suite leaked after
every suite** (change-log row `repo-zje`), and writes per-suite logs plus a summary table
to `runs/sweeps/<timestamp>/`.
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
| `scripts/test-changelog.sh` | `docs/change-log.md` row identity — slug refs, uniqueness, citations (the convention they obey is `DESIGN.md` §12) |
| `scripts/test-sanitize.sh` | publication hygiene — no machine paths, emails, credentials or denylisted names in the tracked tree |
| `scripts/test-agent-hooks.sh` | container hygiene — no tracked file configures an agent hook |
| `scripts/test-network-names.sh` | per-project network and proxy names — derivation, and that they reach the scripts |
| `scripts/test-lock.sh` | the per-project run lock — refusal, path identity, takeover, release |
| `scripts/test-sweep-hygiene.sh` | sweep hygiene — what the sweep reclaims after a suite, what it must never touch, and that reclaiming changes no verdict |
| `scripts/test-concurrency.sh` | the §7 `concurrency` knob — the bound, the worker pool, ready-queue result ordering, and the asynchronous execution seam |
| `scripts/test-pause-gate.sh` | the §7 run-level rate-limit park — one shared wait, one run-level cycle cap, the three admission states, and a refused task that never touches Beads |
| `scripts/test-sweep-assertions.sh` | the sweep's `PASSED` column — both assertion vocabularies, one honest total from a log carrying both, and "could not tell" rendered apart from a zero |
| `scripts/test-trace.sh` | the traceability ledger (change-log row `trace-ledger`) — checkbox/ref parsing on both line endings, the three report lists, and backfill that recovers the ticking commit through later prose edits and refuses to guess |
| `scripts/test-verdict.sh` | the review verdict recorder (change-log row `repo-1ie`) — which run a verdict lands in, what counts as PR-bearing, every refusal writing nothing, and the recorder staying self-contained |
| `scripts/test-audit-runs.sh` | the run-history audit (change-log row `repo-73k`) — the three-bucket corpus taxonomy, `startedAt` joins, the `specConcerns` channel keys, nearest-rank quantiles, the per-model cross-tab (change-log row `model-crosstab`) whose two fixture models disagree on first-attempt rate, and the pure-reader contract checked by content hash |
| `scripts/test-dashboard.sh` | the live run dashboard (change-log row `repo-kfg`) — the lock-to-run join, the run pick against its three wrong answers, the closed degraded vocabulary at each level, the loopback server contract, and the pure-reader contract checked by content hash |
| `scripts/test-verify-buffer.sh` | the verifier's capture limit (change-log row `verify-nobuffer`) — a loud passing suite is a pass, a loud failing one is still a fail |
| `scripts/test-pipeline-map.sh` | the reader's map drawn at build time (change-log row `map-prerender`) — a good SVG's stylesheet versus a real error card, neither check meaning anything alone |
| `scripts/test-batch.sh` | the batch marker reader (change-log rows `repo-0b3`, `repo-8v0`) — the marker name anchored at both ends, the manifest-less run dated from `run.log`, the conservative `run-time-unknown` direction, the degraded labels, byte-identical repeat output, the pure-reader contract checked by sha1 snapshot and parsed `require` specifiers, and the live-queue reconciliation driven through the `PIPELINE_BD_CMD` seam: the runner's own epic filter, the `-C` slot, a queue past 1 MiB, and every degraded reason against the reconciled one |
| `scripts/test-freeze-gate.sh` | the fork-point red gate, its GREEN-side probe, its guard subset, its receipt and its brittleness lint (change-log rows `freeze-gate-red`, `repo-uw6`, `repo-inj`, `repo-i4b`) — every verdict from a real command line including `unreachable` 3, `half-proven` 4 and `stale-guard` 5, the broken-probe/red-probe **pair** that separates 2 from 3, a probe refused by name for every unusable path, a probe missing the runner under the REAL verify command, and — the nine-row decision table from every side, the control convention, the empty-probe fallback cleaned up even on a throw, and for the lint the **near-miss pairs first**: two computed digests and git against a self-created ref (the house patterns a `createHash`- or `git diff`-keyed detector flags), `> 0` / `=== 0` / `=== 1` against `=== N`, an input list against an expected one, plus line numbers over CRLF, a split assertion reported where it starts, the three skip reasons, and a lint that throws printing `unavailable` rather than a `0`; and for the guard subset the near-miss pairs again — a token on the tenth line against one on the eleventh, a token on a comment line against the same token inside a STRING (which is what a test *about* guards looks like), a nested file against a top-level one, and a binary file against a readable one — plus the invocation counts that are the only evidence the subset ran at all (three without a probe, five with, three again behind a stale guard) and `guard files: 0` printed for a suite that has none |
| `scripts/test-dispatch-gate.sh` | the ready queue's second admission rule (change-log rows `dispatch-gate`, `repo-5yu`) — the origin-versus-`targetRepoRemote` pair that discriminates this design from a working-tree check, the `ls-remote --symref` link of the branch chain against a `master` project, an unresolvable branch aborting rather than guessing, a sibling id that merely extends another, the `-d`, the throwaway repository removed on the abort path too, `gitTimeoutMs` at the spawn and at config load, and every `spawnSync` in `runner/queue.js` built from one exported builder |

**`scripts/test-runner-memory.sh` is one of the eighteen suites that need no Docker**
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
else, so it needs no Docker, no network and no target repo. The table it reads now lives in
`docs/change-log.md` rather than in DESIGN.md §12, and the checker's section anchor accepts
both headings deliberately — the frozen `tests/acceptance/repo-006` suite writes its
negative-case fixtures with `## 12. Change Log` and drives the checker over them through
`CHANGELOG_FILE`, so narrowing the anchor to the new form alone would turn a frozen sibling
suite red. It checks that table's shape
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

**`scripts/test-network-names.sh` is the fifth** (`repo-jur`): it computes the per-project
network and proxy names from a set of temp config files and drives
`preflight.networkUp` / `networkDown` / `egressCheck` against a recording stand-in for
`scripts/pipeline-net.sh`, so it needs no Docker and no daemon. It asserts the names are
own, hostname-safe and **identical in a separate process**, that a bare `run.config.json`
keeps the historical pair, that an explicit name wins, that `proxyUrl` follows whichever
name won, and that a config carrying no names *throws* rather than falling back. What it
deliberately leaves alone is whether the two real scripts default correctly: that needs a
fake `docker` earlier on PATH than the real one, and a PATH stub that failed to intercept
would either drive the live daemon or report every check as a genuine failure — so the
scripts stay covered by the suites that run them for real. Its coverage was extracted from
`tests/acceptance/repo-jur/`, which like every frozen acceptance directory is never re-run.

**`scripts/test-lock.sh` is the sixth** (`repo-os9`): it locks temp directories under a
temp pipeline root, so it needs no Docker, no daemon and no target repo — which is itself
the design under test, since the lock being preflight's *first* gate is what leaves
anything about a refused run reachable from a task container. Beyond the frozen suite it
covers the case that can only be reached by **planting** a record: a holder whose pid reads
as alive but that cannot be the process that took the lock. Every one of those fixtures is
planted against a genuinely live pid, so an implementation trusting `process.kill(pid, 0)`
alone blocks the machine forever and the suite says which check noticed — a lock from
before a reboot (the uptime counter only resets at boot), a lock older than the host's
uptime, and on Linux a pid whose `/proc` start time no longer matches. It also pins the
two rules that are easy to lose in a refactor: `release` removes only a record that says it
is ours, and an abort at a *later* preflight gate still frees the project. Its coverage was
extracted from `tests/acceptance/repo-os9/`, which like every frozen acceptance directory
is never re-run.

**`scripts/test-sweep-hygiene.sh` is the seventh** (`repo-zje`): it copies the *real*
`scripts/test-all.sh` into a temp fake root and drives it with a recording stand-in for
`docker`, reached through the `${SWEEP_DOCKER:-docker}` seam every docker call in the sweep
now goes through — the `docker info` and `docker image inspect` prechecks included, since a
bare call there aborts the sweep before a stand-in is ever consulted. Copied, never invoked
in place: `test-all.sh` takes a lock, and a suite running inside the sweep would deadlock
against the sweep that launched it.

What it covers is the cleanup block that used to sit at the bottom of each suite's turn,
which was wrong in four compounding ways: it was gated on `pipeline-net` still existing (a
suite that leaked containers but no network got none of it), the stray-container sweep was
gated *again* on the suite having timed out (a suite that exited 1 having orphaned
containers was not cleaned at all), the filter was `ancestor=pipeline-base:local`, which
cannot match `pipeline-proxy:local` — the one container the sweep itself indirectly creates
— and the summary note was a fixed string, so anything removed was echoed to the console
and never reached the table a human reads. Removal now lives in `scripts/sweep-reclaim.js`
and runs after *every* suite; the note names what went, by identity.

**Ownership is a before/after snapshot diff intersected with an allowlist, never a name
match.** That is the half worth defending. Three suites were force-removing containers they
did not create: `docker ps -aq --filter name=task- | xargs -r docker rm -f` looks like a
prefix match and is a substring one, so it took `my-task-runner` — or anything else on the
host whose name merely contains `task-` — with it. The reclaimer removes a resource only if
it was absent from the listing taken before the suite ran *and* matches the pipeline
allowlist (`pipeline-base:local` / `pipeline-proxy:local` ancestry, the exact name
`pipeline-proxy`, a `task-` prefix anchored at position 0, the `pipeline-net` network), and
the three suites take a snapshot at their top and reclaim against it in their trap. A
baseline that could not be taken is *not* treated as "nothing was here": no baseline, no
removal, or the first failed listing would remove every pipeline container on the machine.

That ownership rule is also why a stand-in is safe here when a PATH stub for
`pipeline-net.sh` was rejected as unsafe (see the network-names suite above): `down` removes
the network and the proxy by name and unconditionally, so a stub that failed to intercept
would delete the real ones, whereas a missed seam here yields an empty diff and removes
nothing. The stand-in is stateful on purpose — the stub suite drops a marker and the
recorder reports the leftover only once it exists — because a recorder that answered every
listing identically would put the leftover in the *before* listing too, where a correct
reclaimer rightly ignores it, and the fixture could not then tell a working reclaimer from a
broken one. It is `process.execPath` with the recorder preloaded through
`NODE_OPTIONS=--require "<stub>"` (forward slashes, quoted — defect 9), never a `#!/bin/sh`
file, because `sweep-reclaim.js` reaches the seam with `spawnSync` and no shell.

Two guards in it are negative on purpose, so they cannot be satisfied by code that never
runs: `test-all.sh` must contain no `docker rm`, no `docker network rm` and no
`pipeline-net.sh down` of its own, and no suite in the discovered set may select containers
by an unanchored `--filter name=`. A third checks over the discovered set that every suite
bringing `pipeline-net` up tears it down from an `EXIT` trap — `test-egress.sh` and
`test-egress-check.sh` tore down at the bottom of the script instead, which their own early
`exit 1` paths skipped.

**The host obligation, and it is the whole point of the change:** `bash
scripts/test-all.sh` on the reference host, once, against the real daemon. Everything above
is proven against a recording stand-in, which by construction cannot show that the real
`docker ps` / `network ls` output parses the way the reclaimer expects, nor that a suite's
own `EXIT` trap and the sweep's per-suite reclaim agree about what is already gone. Two
things to read in the summary table: the `NOTES` column should name identities rather than
a fixed phrase, and it should be **empty** for a suite that cleaned up after itself — a note
on every row means the reclaimer is claiming resources the suites already released. Also
expect the trap criterion to go red for a moment when a branch adding a new
`scripts/test-*.sh` merges: the criterion is checked over the *discovered* set, so a new
suite is covered the day it lands, which is correct behaviour and not a regression.

Left alone deliberately, and filed rather than fixed at the time: the `ASSERTS` column
counted only `PASS ` lines and not `ok - ` lines, so several suites under-reported their
check counts (`docs/IDEAS.md`, 2026-07-30). Same script, different decision — which of the
repo's two pass vocabularies should win is a choice, not a patch, and bundling it there
would have put a coverage-reporting change inside a hygiene task. **Fixed since, as its own
task** (change-log row `repo-0ay`): the column is now headed `PASSED`, counts both
vocabularies, and is decided by `scripts/sweep-assertions.js` — see below.

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

**The third leak arrived as an instruction, and the suite never ran** (change-log row
`setup-plugin-name`). `SETUP.md`’s A8 named the private plugin repository in a
`/plugin marketplace add` line. The two earlier leaks came in as *evidence* — a project
named in a change-log row, a side project in a worked example — and that is the shape
§3.6’s rule describes. This one came in as a working command, where naming the repository
is the entire point of the line, so it read as correct to every human who looked at it.
Only the host-only denylist knows the name, so only the checker could have caught it.

**It was green the whole time and nobody ran it.** `test-sanitize.sh` is in the sweep and
the sweep is a manual step; nothing runs it on a pull request. The boundary that lets this
repo be public while the work is private is therefore enforced by whoever remembers. That
is the open gap, and it is a bigger one than any single leak: the two automated halves
(generic patterns, denylisted names) both work, and neither is a gate.

**`scripts/test-concurrency.sh` is the eighth** (`repo-teq`): it requires `runner/run.js` as
a module and drives the exported `drainQueue` directly, plus the `PIPELINE_EXEC_STUB` branch
of `executeTask` with shell stubs of its own — no Docker, no daemon, no target repo. Its
first check is that requiring `run.js` runs *nothing*, in a child process before this suite
requires it in-process: an unguarded `main()` would `process.exit` on the missing config and
the suite would report nothing at all rather than a failure.

Three things live here that the frozen directory cannot cover going forward. **The seam is
asynchronous**, proved by rendezvous between two real child processes — under the old
`spawnSync` the first stub gives up waiting for a peer that cannot start until it returns, so
the check is discriminating and not decorative. **The stub's environment contract**
(`ISSUE_ID`, `TASK_DIR`, `WORKSPACE`, `RUN_DIR`) and its `124 -> killed` mapping are pinned,
because three Docker suites depend on both and none can run in a container. And **the
scheduler's edges**: an empty queue, a bound wider than the queue, a bad bound, and a task
body that throws. Like every suite extracted this way, the frozen `tests/acceptance/repo-teq/`
stayed exactly where it is — extract, never move.

**`scripts/test-pause-gate.sh` is the ninth** (`repo-i9y`): it drives `createPauseGate`
directly and `runner/run.js`'s exported `runOneTask` through its seams (`PIPELINE_BD_CMD`,
`PIPELINE_EXEC_STUB`, `PIPELINE_GH_CMD`, and a local bare repo as `targetRepoRemote`), so
the whole run-level park is provable with no daemon. **Nothing in it turns on wall clock**:
"has not settled yet" is judged by draining the event loop with `setImmediate` and ordering
is judged from an events array, because a park is a thing that *sleeps* and a suite that
measured it by elapsed time would either take a day or flake on a loaded machine. It
asserts its own check count (≥ 90) as well as its exit code, because a park that is never
exercised looks exactly like a park that works. What it deliberately does not cover: a real
run at concurrency > 1 against a genuine usage limit, which needs a closed subscription
window and stays a host obligation.

**`scripts/test-sweep-assertions.sh` is the tenth** (`repo-0ay`): it covers the sweep's own
reporting. `scripts/sweep-assertions.js` decides the summary's per-suite count as a pure
function over a log body — the `sweep-reclaim.js` precedent — and the suite plants logs at it
and then drives a *copy* of the real `scripts/test-all.sh` over stub suites to check that the
decision reaches the rendered table. Three fixtures are built to be discriminating rather
than plausible. **The mixed log** makes the shell count, the node count and their sum three
different numbers (2, 4, never 6), because a counter that adds them is otherwise
indistinguishable from one that does not. **The genuine zero** is planted beside a log with
no assertion lines at all, since `found:false` and `count:0` are only separable if both
exist — the column renders the first `?` and the second `0`. And **the shell-heavy log** (40
`PASS ` lines beside one `ok - `) pins the direction that matters for the guard: this change
may never make a suite's number *drop*, so where the shell count is larger it wins outright.
The suite also runs the sweep with the helper deleted, because
`tests/unit/sweep-hygiene.test.js`'s temp root does not copy it and a missing counter must
degrade to the old grep rather than to an empty column. What it does not cover: the reference host's own vocabularies, if a future
suite invents a third — the counter reports the vocabulary it counted precisely so that
shows up as a number that stops moving, but nothing asserts on the real sweep's output.

**`scripts/test-trace.sh` is the eleventh** (change-log row `trace-ledger`): it covers
`scripts/trace.js`, the spec-to-code traceability report and its deterministic backfill.
It needs git and node only — the end-to-end cases build throwaway git repositories under
the OS temp directory and drive the real CLI against them, so it touches neither this
repo's history nor its tree. The fixture history carries the discriminating trap: a box
ticked by one issue's commit and reworded by a later id-less commit, so a naive-blame
backfill returns "unrecoverable" where the expected answer is the issue id, and the two
implementations cannot both pass. Fixtures are CRLF because the reference host is CRLF and
containers see LF; the write path must preserve what it found, and an assertion pins that.

**`scripts/test-verdict.sh` is the twelfth** (change-log row `repo-1ie`): it covers
`scripts/verdict.js`, the review verdict recorder. It needs node only — every case builds a
throwaway runs root under the OS temp directory and drives the real CLI against it, so it
never reads or writes this machine's own `runs/` tree (the wrapper unsets `VERDICT_RUNS_DIR`
for exactly that reason). The fixtures are shaped against the plausible wrong answers rather
than the happy path: the `startedAt`-newest run is chosen while its runId sorts older and its
mtime is fresher, so runId-sort and mtime-sort each pick a different run; runs whose
`startedAt` is absent, unparseable or a number all have to sort oldest; and the runs root
carries the noise a real one does — a plain file, `sweeps/`, an empty directory, a `run.json`
that does not parse, and two that parse to a JSON array and a JSON string. Sixteen refusals
are asserted twice over — non-zero exit, *and* a recursive content-hash snapshot of the tree
unchanged — because validate-after-write leaves a stub behind that a path listing cannot see.
Two checks are structural rather than behavioural: the source requires node built-ins only
and never `child_process`. Self-containment is what lets a copy of that one file work from
any repo-shaped root, and spawning nothing is what lets it run where `bd` was never
installed; both decay silently the first time someone reaches for a shared helper, and
neither is visible in any behavioural test.

**`scripts/test-audit-runs.sh` is the thirteenth** (change-log row `repo-73k`): it covers
`scripts/audit-runs.js`, the run-history audit of §5. It needs node only — every case
builds a throwaway runs root under the OS temp directory and drives the real CLI against
it through the `AUDIT_RUNS_DIR` seam, so it reads neither this repo's tree nor the real
corpus. Three things it holds that nothing else can. The **pure-reader contract**, checked
by a recursive path-plus-content-hash snapshot of the runs root, the script's own directory
*and* a dedicated empty working directory — a "helpful" cache most plausibly lands in the
cwd, which a narrower snapshot would not see. The **channel keys**: one fixture status file
carries `specConcerns` *and* a decoy `concerns` array of a different length, so the misread
that made the hand pass report a 43-use channel as never used produces a different number
and cannot pass. And the **quantile method**: the sample set `[10, 20, 40, 80, 1000]` is
chosen so p95 is the sole discriminator between nearest-rank (1000, an observed sample) and
type-7 interpolation (816, a number no run ever produced) — interpolation is what would
quietly break byte-determinism. It also pins the structural constraints no behaviour can
see: every `require` target a node built-in, no `child_process`, no `fs` write API, because
the script is meant to be copied and that property decays silently.

**`scripts/test-dashboard.sh` is the fourteenth** (change-log row `repo-kfg`): it covers
`scripts/dashboard.js`, the live run dashboard's reader. It needs node only, builds
throwaway runs roots under the OS temp directory, and drives the real file two ways — as a
required module (`main()` sits behind `require.main === module`, the `repo-teq` shape) and
as a server on an ephemeral loopback port through the `DASHBOARD_RUNS_DIR` /
`DASHBOARD_PORT` seams — so it reads neither this repo's tree nor the real corpus.
**Why it is re-runnable rather than left frozen**: what the reader answers is a set of
JOINS over artifacts four other modules write — the lock record's shape, `run.log`'s line
wording, `run.json`'s field names and `status.json`'s keys — and any of the four can be
changed by a later task that has never heard of the dashboard. The failure is silent: a
well-formed, empty, plausible picture, which is defect 8's shape pointed at a screen
someone watches at 2 AM.
Three fixtures are discriminating rather than merely realistic. The **run pick** has three
plausible wrong answers on a real tree (readdir order, runId sort, directory mtime — the
`repo-1ie` finding), so one project's correct run is the *first* directory name and
another's is the *last*: no single wrong reading passes both. The **lock-to-run join** puts
a newer, manifest-less decoy directory beside the run the held lock names, so an
implementation that picks by recency instead of by `runId` renders the wrong run rather
than no run. And the **degraded vocabulary** is planted one term at a time as unparseable
bytes or a directory where a file belongs — never `chmod`, which is a no-op for root and on
the Windows host — with the untouched project asserted intact in the same response, because
the failure worth catching is the blanket catch that drops a whole project quietly. It also
pins the structural constraints no behaviour can see: every `require` target a node
built-in and no `child_process`, since the file has to work as a copy from any repo-shaped
root and its lock-liveness logic is re-implemented inline rather than required from
`runner/lock.js`.

**A full sweep ran** after the five dogfood/queue PRs merged to `main`: all 18
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
