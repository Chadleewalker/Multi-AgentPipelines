# Planning draft — 2026-08-10 — the live run dashboard

**Status: DRAFT — for approval. Nothing here is frozen and nothing runs until then**
(PLANNING.md step 5). Promotes the *live dashboard* entry in `docs/IDEAS.md`
(2026-08-02). The design decision is recorded in `DESIGN.md` §5 as change-log row
`live-dashboard`; the tasks below have been through criteria-in-fresh-context and the
critic pass, and freeze on approval.

All ids and names in examples are invented (`app-001`, "my-game") — this file is public
and names no target project.

## Decisions taken in session (2026-08-10)

- **Layout: the live diagram.** The pipeline diagrams `docs/pipeline-diagram.md` already
  draws, re-rendered with the node each task currently occupies lit up, plus a storage
  row (Beads queue · workspace · `runs/` · PR) that lights when written. Chosen over a
  task board and a timeline.
- **Scope: one run per project.** Live when a held lock names it, else the newest
  finished one. Never history across runs — that stays with `scripts/audit-runs.js` (§5).
- **Delivery: a browser page served by a small read-only Node script on the host.**
  One page; a channel-selector strip lists every project; clicking one switches the view.
  Each project also has its own URL, so two can be opened side by side.
- **Split (scope critic, accepted): the reader is the pipeline task; the page is
  interactive work.** `scripts/dashboard.js` with the frozen `/state` contract runs
  through the pipeline (task 2). The visible page — the lit diagrams, the storage row —
  is built interactively against that contract afterwards, because its look is
  deliberately unfrozen and is reviewed by looking at it, which a three-attempt
  unattended container cannot do. The mock from this session is its starting point.
- **Diagrams that animate** (page-side, recorded for the page session): the queue
  diagram, the inside-one-container diagram, and the issue state diagram. *End to end*
  and *Where the walls are* are static context.

## The design in one paragraph

`scripts/dashboard.js` is a host-side pure reader with an HTTP face: it binds
`127.0.0.1` only and answers `/state`, a frozen JSON contract assembled by reading only
files the pipeline already writes: `runs/locks/*.lock`, each run's `run.log` (the
runner's own pinned `<ISO> LEVEL [runId/issueId] msg` format — structural parsing, not
log-scraping), `run.json` once written, live workspaces' `.run/status.json` (found via
the runner's existing `workspace ready:` line), and collected
`runs/<runId>/tasks/<id>/status.json`. It holds no LLM (hard rule 7), never touches
Beads or Docker, writes nothing anywhere (the `audit-runs.js` pure-reader contract),
and cannot gate anything. Because the data names target repos, PR URLs and issue
titles, the server is localhost-only and nothing tracked ever carries its output; the
tool is generic and tracked.

## One small deterministic write makes the live view honest

**A `phase` field in `status.json`.** Today the status file is written *after* each
phase, so "where inside the container is this task right now" is invisible — the most
interesting box on the screen would be dark. `pipeline/entrypoint.sh` sets `phase` at
each boundary (`code` → `verify` → `docs`) through `pipeline/status.js`, whose `set`
allowlist and `schemas/status.schema.json` gain the key. Scaffolding-only, no LLM
anywhere near it.

*(The draft originally added a second write — a workspace-path log line. Fresh-context
review found the runner already logs an unconditional `workspace ready: <dir> on
<branch> (fork point …)` line for every prepared workspace, so the dashboard reads
that and no second change exists.)*

The alternative — grepping the streamed `container.log` — is the log-scraping this repo
already banned (§3.6, `pipeline/envelope.js`), and stays banned.

## What the live view shows, per project (the page session's brief)

- Run header: run id, started, concurrency, park state (one shared wait when the
  rate-limit gate fires).
- The queue diagram with each in-flight task at its current node: admit → claim →
  container → collect → finish, refused/parked rows named.
- Per running task: the inside-container diagram with the current phase lit, attempt
  `n/3`, elapsed time (host clock — "alive, 14 minutes in"), pauses, branch.
- The storage row: queue (last claim/close event), workspace (live · last status
  write), `runs/<runId>` (artifacts collected), PR (URL once `run.json` has it).
- Queued and finished tasks in a strip; idle projects show their newest finished run
  in the same view.

Everything above is a rendering of `/state` fields; the page adds no data source.

## Task slicing — two independent pipeline tasks, then an interactive page session

Neither task depends on the other: the dashboard degrades by naming what it cannot
know (`phase` absent on runs produced before task 1 ships) rather than requiring it,
and task 1's field is useful to the collected artifacts even with no dashboard reading
it live. They can run in the same batch. The page session follows once task 2's PR is
merged, replacing the placeholder page against the frozen contract.

### Task 1: the `phase` field — label: medium

**design-ref:** `DESIGN.md` §5 (change-log row `live-dashboard`).

**Description.** `status.json` gains a `phase` key — exactly one of `code`, `verify`,
`docs` — set by `pipeline/entrypoint.sh` at each phase boundary through
`pipeline/status.js` (`set` allowlist gains the key; `schemas/status.schema.json`
gains it as an enum, additively). Purely additive; no behaviour of any existing
outcome changes. *(The draft originally also added a workspace-path log line; dropped
in fresh-context review — `runner/workspace.js` already logs an unconditional
`workspace ready: <dir> on <branch> (fork point …)` line for every prepared
workspace, and the dashboard reads that. `run.log` line wording is untouched by this
task; Docker suites grep the existing lines.)*

**Constraints.**
- The diff touches exactly three files: `pipeline/entrypoint.sh`,
  `pipeline/status.js`, `schemas/status.schema.json` (plus docs and its own tests).
  Nothing under `runner/` changes; no `run.log` line wording changes anywhere.
- `status.js` stays the sole writer of the status file; no new writer of
  `status.json` is introduced.
- Schema change is additive: one new `properties` entry with
  `enum ["code","verify","docs"]`; `required` and `additionalProperties` untouched —
  a status file without `phase` stays valid.
- Phase writes are non-fatal, matching the existing `model` write's style
  (`2>/dev/null`, never `|| die30`): an unwritable status file must not fail a task.
- Two insertion hazards, named because each is silent: the code- and docs-phase
  boundaries sit immediately above `{ … } > file` prompt-building blocks — a write
  placed one line low runs inside the redirect; and nothing may be inserted between
  the verifier invocation and the `VRC=$?` that captures its exit code.
- No change to `pipeline/verify.js` or any frozen path. The Docker-free suites
  covering the touched files run in-container per `CLAUDE.md`.

**The rig all entrypoint criteria share** (pinned because the acceptance test runs
inside a live task container): the entrypoint child is spawned as `bash
pipeline/entrypoint.sh` with a **replaced** environment of exactly `PATH`, `HOME`,
`WORKSPACE` (the rig's temp workspace), `PIPELINE_DIR` (a temp dir holding copies of
the real `status.js` and `envelope.js` plus a stub `verify.js`), `ISSUE_ID`,
`PIPELINE_AGENT_CMD`, and `PIPELINE_MAX_ATTEMPTS` — never the inherited environment,
which inside a container names the live run's own `/workspace`. The rig probes for
`bash` first and aborts loudly if absent (the `repo-jur` harness-gate shape), because
the exec path fails silently without it.

**Done means:**
1. **The phase is written at each boundary, observed from inside the phase.** In the
   rig, the agent stub snapshots `status.json` during the code and docs invocations
   and the verify stub snapshots it before exiting: the run exits 0 and the three
   snapshots read `phase` = `code`, `verify`, `docs` respectively; the final file
   reads `docs`; and the captured code-phase prompt's first line still begins with
   the pinned `You are implementing one task` header with the phase write nowhere in
   it. *(Kills: a single write at exit — plausible, well-formed, and dark exactly
   where the dashboard looks; a write that lands inside the prompt redirect.)*
2. **Every exit path carries the last phase reached; the vocabulary is closed.** Four
   drives of the same rig: fail-stub with `PIPELINE_MAX_ATTEMPTS=1` → exit 10,
   `phase` = `verify`; tamper (verify stub exits 3) → exit 11, `verify`; rate-limit
   stub → exit 20, `code`; docs-fail stub → exit 0 with `docsPhaseError` set and
   `phase` = `docs`. Every observed value is one of exactly `code|verify|docs`.
   *(Kills: invented terminal values; a docs write placed after the docs
   invocation; a clobbered `VRC`.)*
3. **A relaunch overwrites a stale phase.** The same workspace driven twice (the §4.7
   resume shape — fresh entrypoint process, same `.run/`): run 1 fail-stub with
   `PIPELINE_MAX_ATTEMPTS=1` ends `phase` = `verify` with `attempts.length` = 1;
   run 2 rate-limit stub with `PIPELINE_MAX_ATTEMPTS=3` ends `phase` = `code` with
   `attempts.length` still = 1. *(Discriminating because the two runs end on
   different values and the caps are pinned — a cap of 1 on run 2 would break the
   loop before any phase write and mark a correct implementation red.)*
4. **The key is allowlisted and the schema stays additive.** Against a temp
   `RUN_DIR`: `node pipeline/status.js init x`, then `set phase code` exits 0 and the
   file then parses with `.phase === "code"`; `set phaze code` exits 2. Read as JSON,
   the schema has `properties.phase` with enum exactly `["code","verify","docs"]`,
   `required` still exactly `["issueId","attempts"]`, and `additionalProperties`
   still `false`. The test's inline admitter must survive four enumerated probes:
   admits an old-shaped file without `phase`; admits the same file with
   `phase: "docs"`; **rejects** it with `phase: "review"`; rejects it with an unknown
   key. *(Kills: `phase` in `required` — every old artifact goes red; an admitter
   that ignores the enum and can never fail.)*
5. **Phase writes cannot fail a task.** One drive where the rig's `status.js` is a
   wrapper that exits non-zero for `set phase …` and delegates everything else to the
   real script: the task still runs to its normal exit code. *(Kills: `|| die30` on a
   phase write — an unwritable status file turning into exit 30 in production. A
   chmod-based fixture is not a substitute: it is a no-op when the container runs as
   root.)*

### Task 2: `scripts/dashboard.js` — the reader and the frozen `/state` contract — label: hard

**design-ref:** `DESIGN.md` §5 (change-log row `live-dashboard`).

**The page is not in this task** (scope critic, accepted). `GET /` serves a minimal
placeholder — an inline template string in `dashboard.js`, no second file — that names
the tool and says the page ships separately. The real view is built interactively
against the frozen `/state` contract after this task merges. **No dependency on
task 1 either**: a `status.json` without `phase` (or with an out-of-vocabulary value)
renders `phase: null` plus `phase-unknown`, and the dashboard never schema-validates
`status.json` — under today's schema `phase` is *invalid*, so a validating reader
would red-line the very artifact task 1 creates.

**Description.** `scripts/dashboard.js`, a self-contained HTTP server binding
`127.0.0.1` only: `GET /` the placeholder page, `GET /state` the frozen JSON, anything
else 404 with the exact body `not found\n`. State is assembled by reading files only.
Seams: `DASHBOARD_RUNS_DIR` (blank = unset; default resolved from the script's own
location, never the cwd) and `DASHBOARD_PORT` (default 4770; `0` = ephemeral;
the chosen port announced as exactly one stdout line
`dashboard: http://127.0.0.1:<port>/`). Ships with the Docker-free suite
`scripts/test-dashboard.sh` over `tests/unit/dashboard.test.js`, its own `DESIGN.md`
§12 change-log row (ref = this task's issue id) and the `CLAUDE.md` suite-roster line,
per the `run-audit` pattern.

**Discovery and derivation rules (each pinned because two readings existed):**
- **Run dir predicate:** a direct child directory of the runs root, excluding `locks`
  and `sweeps` by name, containing `run.log` or `run.json`. Plain files are skipped.
  No recency cutoff or count cap — every project the corpus names appears.
- **Projects** = the union of live locks and run dirs' projects. A missing
  `runs/locks/` directory is the ordinary empty case (a host that has never run),
  not degraded. **Project identity:** `key` = the canonical local target path (the
  lock's rule, re-applied inline: resolve, realpath, lowercase on win32 only) when
  any lock or `run.log` `target:` line supplies one; else the manifest's `targetRepo`
  remote URL; else `unknown:<runDirName>`, one project per orphan run dir. `name` =
  the last non-empty path segment of `key` with a trailing `.git` stripped; `path` =
  the local path when known, else null; `remote` = the manifest URL when known, else
  null.
- **Run choice per project:** the lock's `runId` when the lock's holder is live; else
  newest by `startedAt` — the manifest's when parseable, else the timestamp of
  `run.log`'s first line when it parses as the pinned line shape; a run with neither
  sorts oldest; ties break by `runId` ascending. All sorts everywhere are byte-wise
  code-unit, never locale collation.
- **`run.state`:** `running` iff a held live lock names the run; else `finished` iff
  `run.json` parses to an object; else `unknown`.
- **`tasks[].state`:** a manifest row means `finished`. Otherwise the task's last
  matching `run.log` event wins: `starting task (priority ` or `relaunching in a
  fresh container` → `running`; `rate limit hit (pause ` → `parked`; `task finished:
  exit ` → `finished`; the ERROR line `refused: the run-level rate-limit pause cap `
  → `refused`; named in the `ready queue: ` list with no `starting task` line →
  `queued`.
- **`park`:** `open: true` with `cycles` from the `(n/m cycles spent)` suffix on
  `rate limit: opening the run-level wait (`; `open: false` again after
  `run-level park: the window reopened`; `until` = the ISO on the latest
  `paused: waiting until reported reset `; the end-of-run summary line is ignored
  (it reads 0 during exactly the runs this tool exists for).
- **The parsed line vocabulary, as literal prefixes** (everything else in `run.log`
  is ignored): `target: `, `project lock held for `, `project lock: took over the
  lock on `, `ready queue: `, `starting task (priority `, `workspace ready: `,
  `launching container `, `container ran `, `rate limit hit (pause `, `rate limit:
  opening the run-level wait (`, `run-level park: the window reopened`, `paused:
  waiting until reported reset `, `task finished: exit `, `run finished; artifacts
  in `, `refused: the run-level rate-limit pause cap`, `relaunching in a fresh
  container`. The em-dash rule: prefixes *identify* lines; after matching
  `ready queue: `, the tail is split at the first ` — `, ids end at the first `;`,
  and split on `, `. Em dashes in payloads (an issue title) must not affect parsing.
- **Field sources:** `attempt` = live `attempts.length`, else the manifest's count;
  `attemptsMax` = the constant 3 (§4.6's cap — a contract constant, not read from
  anywhere); `attemptResults` = `attempts[].verifierResult`
  (`pass|fail|tampered|error`) from the live workspace's or the collected
  `runs/<runId>/tasks/<id>/status.json`; `concurrency` = the manifest's, else
  **null** — never defaulted; `title` = the manifest's, else the `starting task`
  line's; `prUrl` and `branch` = manifest only; `phase` = the status file's, only
  when in-vocabulary; `lastWrite` = the status file's mtime as an ISO string with
  milliseconds; `outcome` = the manifest row's, else null. `tasks[]` sorts by
  `issueId`; queue order lives in `run.queued`.

**Constraints.**
- A pure reader: creates, modifies and deletes nothing anywhere; spawns nothing;
  never calls `bd` or `docker`; every `require`, after stripping a `node:` prefix,
  is a node built-in; no `child_process` anywhere (`process.kill(pid, 0)` is
  permitted — the permission probe the lock's own liveness rule uses; it spawns and
  writes nothing). Lock-liveness and path-canonicalisation logic is re-implemented
  inline, never required from `runner/`; its fidelity is pinned behaviourally by the
  fixtures below.
- `/state` reflects the tree as of the request — re-read per request, no startup
  cache. The server emits no per-poll-varying field except `now`.
- The placeholder page's served bytes contain no `://`, no `src=`, no `@import`, and
  no `href=` whose value does not start with `#`. `/state` is served
  `Cache-Control: no-store`.
- `run.log` is read as UTF-8, split on `/\r?\n/`, parsed against the pinned
  `<ISO> LEVEL [runId/issueId] msg` shape; the traceId splits at its first `/`;
  `preflight` is the run pseudo-task, never a task row.
- On a taken port: exit code 1, one line on stderr starting `dashboard: `, and no
  line matching `/^\s+at /` (no stack trace).
- Tracked fixtures: every host is `example.invalid`, every path lives under the
  test's own temp root. (Real-corpus counts in this draft are rationale, never
  assertions — the container's `runs/` is not the author's.)

**The frozen `/state` shape** (key names and nesting; `|` marks a closed string
vocabulary, `null` marks present-but-null when unknown; `concurrency` and every
`null`-marked field are nullable):

```json
{ "schema": 1,
  "now": "<ISO>",
  "projects": [{
    "key": "<canonical target path | remote URL | unknown:<runDirName>>",
    "name": "my-game",
    "path": null,
    "remote": null,
    "live": true,
    "degraded": ["lock-stale"],
    "lock": { "state": "held|stale|unreadable|none", "runId": "", "pid": 0, "since": "<ISO>" },
    "run": {
      "runId": "", "state": "running|finished|unknown",
      "startedAt": "<ISO>", "finishedAt": null, "concurrency": null,
      "park": { "open": false, "cycles": 0, "until": null },
      "queued": ["app-002"],
      "degraded": ["no-manifest"],
      "tasks": [{
        "issueId": "app-001", "title": "",
        "state": "queued|running|parked|finished|refused",
        "phase": null,
        "attempt": 1, "attemptsMax": 3,
        "attemptResults": ["pass"],
        "outcome": null,
        "prUrl": null, "branch": null, "pauses": 0,
        "startedAt": "<ISO>", "activeSeconds": null,
        "lastWrite": "2026-08-10T09:55:03.120Z",
        "workspace": { "state": "live|missing|unknown", "path": null },
        "degraded": ["phase-unknown"]
      }]
    }}]}
```

`run` is always the full object with null fields, never null itself. The
degraded-state vocabulary is closed, and each term has one home: project-level
`lock-unreadable`, `lock-stale`, `target-unknown`; run-level `no-manifest`,
`manifest-unreadable`, `run-missing`; task-level `status-unreadable`,
`status-missing`, `workspace-missing`, `workspace-unknown`, `phase-unknown` (which
also covers an out-of-vocabulary `phase` value).

**Done means:**
1. **The two-project fixture answers `/state` with the right joins and every
   Description feature has an asserted value.** Project A (live): a held lock minted
   at test time (this test's pid, fresh `takenAtMs`/`uptimeSeconds`, no `procStart`)
   naming a manifest-less run whose `run.log` carries the pinned lines for: a running
   task whose invented title contains an em dash (asserted verbatim in `title`), with
   a live workspace whose `status.json` reads `phase: "verify"` and one `fail`
   attempt (`attempt` 1, `attemptResults ["fail"]`, `lastWrite` = that file's mtime
   ISO); a parked task (`rate limit hit (pause 1)` line → state `parked`, `pauses`
   1); a refused task (the ERROR refused line → `refused`); a park cycle (`park.open`
   true, `cycles` 1, `until` = the pinned reset line's ISO); and a queued id in
   `run.queued`. Project B (idle): no lock, a finished run whose `run.json` says
   `concurrency: 4` (asserted — never the default), a `done` task with `prUrl`,
   `branch`, `attempts: 2`, `pauses: 0`, `activeSeconds`, `finishedAt`, and a
   collected `tasks/<id>/status.json` whose two attempts yield
   `attemptResults ["fail","pass"]`; `name` and `remote` asserted from the key rules.
   Two lock/log target spellings that differ only by a trailing separator and a `./`
   segment fold to one project key. *(Kills: a global newest-run pick; skipping
   manifest-less dirs — the `verdict.js` behaviour that would hide every live run; a
   lock→run join that never goes through `runId`; hardcoded `concurrency`/`park`/
   `attemptResults` constants; a canonicalisation copy that drifts.)*
2. **The shape is frozen, deterministic, and fresh.** Two `/state` calls on an
   unchanged fixture are byte-identical except the value of `now`; the key set at
   every level equals the frozen contract exactly (whitelist compare — an added key
   fails loudly); rewriting the same `run.log` in place from LF to CRLF (no other
   file touched) leaves `/state` byte-identical with `now` held out; and after
   appending a `task finished` line to the live run's `run.log`, the next `/state`
   reflects it. *(Kills: server-side elapsed fields; silent contract drift; the CRLF
   class; a startup-cache server that is dead by construction.)*
3. **Every malformed shape is a named degraded state at its pinned level, never a
   500.** Planted one at a time, each built as unparseable bytes or a directory where
   a file belongs — never chmod, which is a no-op for root and on the Windows host:
   log-but-no-manifest, manifest of unparseable bytes, manifest that parses to an
   array, status file of unparseable bytes, status file missing, workspace directory
   gone, no `workspace ready:` line, lock of unparseable bytes, stale lock (the
   pre-reboot `takenAtMs` falsifier), lock naming a runId with no directory, status
   without `phase`, `phase: "review"` (folds to `phase-unknown`), no target identity
   anywhere (project keyed `unknown:<runDirName>`), and a missing `runs/locks/`
   directory (ordinary, no degraded marker). In each: HTTP 200, the named string in
   the pinned level's `degraded` array, surrounding fields null rather than absent, a
   stale lock rendering `live: false`, and the other project rendering completely.
   Where `/proc/<pid>/stat` exists, one more: a lock with this test's live pid, fresh
   times, and a deliberately wrong `procStart` renders `stale` (elsewhere a named
   non-`ok - ` skip line). *(Kills: the crash-on-first-bad-artifact reader; the
   blanket catch that drops a whole project; a liveness copy that ignores
   `procStart`.)*
4. **The server contract holds.** Children are spawned with a scrubbed environment
   (no `NODE_OPTIONS`, `NODE_DEBUG`, or inherited `DASHBOARD_*`). With
   `DASHBOARD_PORT=0`: exactly one stdout line
   `dashboard: http://127.0.0.1:<port>/`; `GET /` is 200 `text/html` passing the
   scheme-level self-containment checks; `GET /state` is `application/json` with
   `Cache-Control: no-store`; `/nope`, `/state/x`, `/%2e%2e/DESIGN.md` and
   `/state/../../pipeline.config.json` each return 404 with the exact body
   `not found\n`. Loopback, two legs: where `/proc/net/tcp*` exists (the container),
   the listening socket's local address is loopback and not `0.0.0.0`/`::`; and a
   TCP connect to each non-loopback interface and `[::1]` does not succeed — any
   error is a pass, success is the failure — with a named non-`ok - ` skip where no
   such interface exists. Taken-port drive: the test binds an ephemeral port itself,
   passes it via `DASHBOARD_PORT`, and the tool exits 1 with one stderr line starting
   `dashboard: ` and no `/^\s+at /` line. *(Kills: `listen()` without a host on a
   page that names private work; a cached `/state`; a static-file route; a
   stack-trace exit; NODE_OPTIONS noise breaking the ready-line count.)*
5. **A pure reader, proved both ways, from anywhere.** The child runs with `HOME`,
   `TMPDIR`, `TEMP` and `TMP` pointed at dedicated empty directories; a recursive
   path+content-hash snapshot of the fixture root, `scripts/`, those directories,
   and the dedicated empty cwd — taken before start and compared after the child
   exits (having served `GET /`, three `/state`, one 404) — is identical, every
   dedicated directory still empty. The source scan shows every `require` (with
   `node:` stripped) in the node built-in set and no `child_process` token. Run from
   two different cwds against the same fixture, `/state` is identical with `now`
   held out. *(Kills: the cache written at startup before a snapshot; the transitive
   `runner/lock.js` require; a default root or canonicalisation that reads the
   cwd.)*
6. **The suite exists, counts, and is swept.** `sh scripts/test-dashboard.sh` runs
   plain `node tests/unit/dashboard.test.js` — never `node --test`, whose harness
   swallows this repo's `ok - ` shape — unsets `DASHBOARD_RUNS_DIR` and
   `DASHBOARD_PORT` first (and still exits 0 when the caller exports
   `DASHBOARD_RUNS_DIR=/nonexistent` and `DASHBOARD_PORT=1`), and passes only on
   exit 0 with at least 35 lines matching `^ok - ` and zero `FAIL` lines, counted by
   the frozen test itself; the wrapper's filename matches the sweep's
   `scripts/test-*.sh` glob. *(Kills: a TAP runner inverting the count; a suite that
   reads the host's real corpus through a leaked seam; a checker that stops
   asserting — the floor is an honesty floor, per the `repo-73k` precedent.)*

### The page — interactive follow-up, not a pipeline task

Built with the user against the frozen `/state` contract once task 2 merges,
replacing the placeholder served by `GET /`: the channel strip, the three animated
diagrams (queue, inside-container, issue state), the storage row, the event strip —
per the brief above and the session mock. Its look is reviewed by looking at it; the
contract it consumes is already gated by task 2's frozen suite. The HTML stays an
inline template string in `dashboard.js` so the self-containment checks keep holding.

## Open points for approval

1. The reader freezes now; the page you react to visually comes right after task 2
   merges, iterated live with you. The mock is the starting point.
2. Name and port: `scripts/dashboard.js` on `127.0.0.1:4770` (`DASHBOARD_PORT`
   overrides).
3. Task 1 touches `pipeline/entrypoint.sh`, which the e2e and entrypoint suites cover —
   the post-merge sweep on the reference host is the usual obligation.

## Critic findings and dispositions

`spec-lint`: clean (no criterion names a frozen path).

**Task 1 — testability critic** (fresh context, charter verbatim): verdict
`concerns`, eleven findings. The critic reviewed the pre-revision draft that still
contained the workspace-line criterion; four findings target it and are overtaken by
its removal.

1. *Workspace-line criterion pinned content but never timing.* **Overtaken**: the
   criterion and the change were dropped; the dashboard pins the existing
   `workspace ready:` line instead.
2. *The relaunch drive's second cap was unnamed — a correct implementation marked
   red.* **Accepted**: C3 pins `PIPELINE_MAX_ATTEMPTS` per drive and asserts the
   attempt count independently.
3. *`set phase` before `init` throws — the probe as written fails correct code.*
   **Accepted**: C4 runs `init` first and asserts the parsed value.
4. *The "existing log lines unchanged" constraint had no criterion; the KEEP-unset
   assertion was vacuous.* **Overtaken/accepted**: the task no longer touches
   `runner/` — pinned as a constraint on the diff.
5. *"Non-fatal" had no criterion — `|| die30` passes every drive.* **Accepted**: new
   C5, a wrapper `status.js` failing `set phase` while the task still exits normally.
6. *The prompt-redirect hazard was untestable as listed.* **Partially accepted**: C1
   asserts the captured prompt's pinned first line; a full byte-compare was judged
   not worth freezing (`set` prints nothing on success, so the header check is the
   honest observable).
7. *`bash` is a silent precondition.* **Accepted**: the rig pins a loud bash probe.
8. *The rig never pinned the child environment — inherited vars inside a live
   container would drive the real run's status file.* **Accepted**: exact replaced
   environment pinned.
9. *The collection criterion was a regression guard passing against current code,
   bought with the heaviest rig, its target unreachable Docker-free.* **Accepted**:
   dropped; old-file validity is C4's job.
10. *The "proven discriminating" admitter could never fail.* **Accepted**: four
    probes enumerated, including rejecting `phase: "review"`.
11. *Workspace-line path comparison under-pinned across the shell boundary.*
    **Overtaken**: criterion dropped.

**Task 2 — scope critic**: verdict `concerns`, eleven findings.

1. *Split reader from page.* **Accepted**: the page is out; `GET /` serves a pinned
   placeholder; the page is an interactive session against the frozen contract.
2. *The page was the unspecified half.* **Accepted** via the split; the page brief
   stays in this draft for the interactive session.
3. *The page is harder than one line admits (no mermaid runtime under
   self-containment).* **Accepted**: recorded in the page section; hand-authored SVG
   is the page session's problem, reviewed by eye.
4. *Six-plus deliverables in one Description.* **Accepted** via the split; the
   reader's deliverables are now enumerated as pinned rules.
5. *Criteria didn't share a subject.* **Accepted** via the split.
6. *"Page template" untracked/unnamed; change-log row and CLAUDE.md roster line
   owed.* **Accepted**: HTML pinned as an inline template string; the row and the
   roster line are in the Description.
7. *Three inline re-implementations can drift with nothing pinning them.*
   **Accepted behaviourally**: the fold fixture (C1), the stale falsifier and
   `procStart` probe (C3) pin each copy's discriminating behaviour; source-level
   pins were rejected as freezing decisions rather than outcomes.
8. *Union-of-sources and idle-project rendering were creep against the design
   text.* **Accepted as design amendment**: the §5 passage (uncommitted, written
   this session) now says union-with-run-dirs and one-run-per-project; the third
   animating diagram is recorded in the page section.
9. *No vocabulary term for a missing `runs/locks/`.* **Accepted**: pinned as the
   ordinary empty case, planted in C3.
10. *Constraints doing the work of criteria.* **Accepted** via the pinned-rules
    restructure; the rules are now the spec's normative body, and C1 asserts them.
11. *Label fit: hard is right for the reader alone.* **Accepted**: the label stays
    `hard` on the reader.

**Task 2 — ambiguity critic**: verdict `concerns`, thirteen findings, all
**accepted** as pins now in the spec: page scope settled by the split (1); the
run-dir predicate and no-cap project list (2); per-level `degraded` homes, a
project-level `degraded` array added, `run` never null (3); evidence→state mappings
for both vocabularies including the crashed-run `unknown` and the `refused` line (4);
`park`'s three exact source prefixes and `until`'s source, end-of-run summary ignored
(5); the vocabulary restated as literal prefixes (6); the em-dash rule scoped to line
identification with the split delimiters pinned (7); `attemptsMax` a contract
constant, `attemptResults`' closed vocabulary and the collected task artifacts added
to the read set (8); `concurrency` nullable, never defaulted (9); `key`/`name`/`path`
defined, `unknown:<runDirName>` for orphans (10); the `startedAt` fallback restated
as an explicit ordered rule (11); re-read-per-request pinned with a freshness
criterion, the poll interval left to the page session (12); anchors-vs-`href` settled
scheme-level, port-conflict exit and stream pinned, byte-wise collation pinned,
out-of-vocabulary `phase` folded to `phase-unknown` (13).

**Task 2 — testability critic**: verdict `concerns`, fifteen findings.

1. *C6's gate delegates to the unfrozen suite; a fake 35-line printer passes.*
   **Partially accepted**: runner, anchoring and the poisoned-seam probe pinned; the
   floor stays per the `repo-73k` precedent, acknowledged as an honesty floor — any
   count is fakeable, and the real gates are C1–C5.
2. *`node --test` inverts the count; wrapper must run via `sh`.* **Accepted**: both
   pinned in C6.
3. *The source-scan denylist was unenumerable and froze the import list.*
   **Accepted**: scan reduced to built-ins-only (with `node:` stripped) plus the
   `child_process` ban; the write-token grep replaced by behavioural evidence (the
   snapshot and two-cwd checks).
4. *The snapshot missed `os.tmpdir()`/`$HOME`.* **Accepted**: C5 redirects and
   snapshots them.
5. *The loopback proof skips in exactly the container it exists for; `[::1]` errno
   varies.* **Accepted**: `/proc/net/tcp*` primary leg; any-error-is-a-pass on
   connects; named non-counted skips.
6. *Ready-line count, default-port collision, seam inheritance.* **Accepted**:
   scrubbed child env pinned; the taken-port drive binds `:0` itself.
7. *`concurrency`/`attemptsMax`/`title` satisfiable by constants.* **Accepted**:
   `concurrency: 4` fixture and verbatim em-dash title in C1; `attemptsMax` declared
   a contract constant (untestable by construction, so pinned as a decision instead).
8. *`park`/`pauses`/`branch`/`attemptResults`/`parked`/`refused` never asserted.*
   **Accepted**: all asserted in C1.
9. *A frozen `takenAtMs` renders the held lock stale; `procStart` never driven.*
   **Accepted**: lock minted at test time; the wrong-`procStart` probe added where
   `/proc` exists.
10. *chmod-based unreadability is a no-op for root and on Windows.* **Accepted**:
    unparseable bytes / directory-where-file-belongs pinned.
11. *The CRLF twin breaks on `lastWrite` mtimes unless built in place; `lastWrite`
    serialisation unpinned.* **Accepted**: in-place rewrite pinned; ISO-with-ms
    pinned in the shape.
12. *The em-dash ban contradicted `run.queued`; payload em dashes untested.*
    **Accepted**: rule scoped to identification; payload em-dash fixture in C1.
13. *Canonical-path keys make ordering host-dependent; the target-less key was
    undefined.* **Accepted**: fixtures pinned to platform-safe folds under the temp
    root; byte-wise collation; `unknown:<runDirName>` defined.
14. *The self-containment grep over- and under-fired; "only network call" is
    unobservable.* **Accepted**: scheme-level checks pinned; the unobservable phrase
    removed from criteria (kept as the page session's rule).
15. *Traversal input and "no filesystem content" unpinned; "invented values" not
    mechanically decidable.* **Accepted**: the four 404 paths and exact body pinned;
    the checkable stand-in (`example.invalid` hosts, temp-root paths) pinned; corpus
    counts demoted to rationale.
