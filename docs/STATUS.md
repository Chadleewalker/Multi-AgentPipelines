# Status

Where the build actually is. Update this when something changes — it is the file a new
session reads to pick up the thread, and unlike a machine-local memory folder it travels
with the repo.

_Last updated: 2026-07-25_

## Where things stand

**V1 is complete and proven end to end.** All 21 build tasks are done. `scripts/e2e.sh`
drives three scenarios (success, bail, tamper) through the real runner, real containers,
the real closed network, and live GitHub with zero interactive input — 32 assertions,
all passing. It opened a genuine pull request on the fixture repo.

**The shadow-mode trial has begun** on a real project (Hallertau). Three runs so far,
two merged PRs, one rejected. Every problem found traced to spec quality, never to the
executor.

## The three repositories

| Repo | Role |
|---|---|
| `Chadleewalker/Multi-AgentPipelines` (this one, private) | the pipeline itself |
| `Chadleewalker/pipeline-fixture` (private) | disposable test bed for `scripts/e2e.sh` |
| `Chadleewalker/Hallertau` | the shadow-trial target, a real project |

## Shadow trial log

| Run | Task | Outcome | Verdict |
|---|---|---|---|
| shadow-01 | `hal-a25` npm test script | done, 2 attempts | **Rejected.** Green but wrong — see below. |
| shadow-02 | `hal-a25` re-run after fixing the gate | done, 1 attempt, 84s | Merged (PR #2) |
| shadow-03 | `hal-917` in-turn undo feature | done, 1 attempt, 300s | Merged (PR #3) |

**The finding that matters most:** in shadow-01 the acceptance test invoked `npm test`
from inside `node --test`, so `NODE_TEST_CONTEXT` was inherited and the child run failed
as a nested subtest. The agent wrote the correct one-line script on attempt 1, diagnosed
the nesting correctly in its notes, watched it fail the gate anyway, and contorted the
implementation until it passed. **A green run cannot tell you the spec was good**, and V1
gives an agent no channel to report "your spec is wrong" — it can only comply.

## Defects the trial found in the pipeline itself

All four were invisible to three rounds of design review and appeared within minutes of
real use. All are fixed.

1. **`main` was hardcoded** in three separately-built components. Hallertau uses `master`,
   so every run would have failed at workspace preparation. Now `defaultBranch` in
   `pipeline.config.json`, falling back to asking the remote.
2. **The model was unpinned** — every container took whatever the account default was, so
   runs were not reproducible and quality could drift silently. Now `model: "opus"`, an
   alias resolved at call time, with the **resolved** id recorded in the status file,
   manifest, report, and PR footer.
3. **A container artifact leaked into a PR** — the `node_modules` symlink the tools create
   inside the container. `.gitignore` matched the directory but not a symlink.
4. **A self-nesting acceptance test** shaped the implementation badly (see above).

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
- **Test suites share one Docker network.** Run them one at a time; concurrent runs tear
  `pipeline-net` down under each other and produce meaningless failures.
- **Watch what else is using a port before killing it.** A `node server.js` on :3000 was
  assumed to be a stale server and killed; it was a different app entirely, served over a
  Tailscale link.

## What's next

**Recommended order:**

1. **Write the critic and specialist charters** (`advisors/*.md`) — a testability critic
   that would have caught the self-nesting test, plus ambiguity, scope, and any domain
   ones. These are planning-session prompts and need **zero pipeline code**.
2. **More shadow runs.** Three is a small sample. The numbers that matter for scaling are
   per-task active time, spec-defect rate, and how often tasks collide on shared files.
3. **V2 — the spec pipeline** (`DESIGN.md` §3.2, §3.5): package the critic panel, the
   decomposition agent, and the coverage check as a `/spec` skill, and add the
   "the spec is wrong" channel V1 lacks.

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
  `pipeline.config.json`.

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
