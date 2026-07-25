# V1 Backlog — Draft Snapshot

> **This is a generated draft, not a canonical home.** It is the dry-run decomposition of
> `DESIGN.md` v0.4/v1.0 (third review round, 2026-07-25), preserved so the backlog survives
> until Beads is set up. Per DESIGN.md §3.1, task specs' canonical home is a Beads issue —
> once T2 is done and issues are created from this list, **this file is superseded and
> should be deleted.** The two gaps the decomposer recorded (verify.json schema; the
> agent-command seam) were resolved in DESIGN.md v0.4 (`verify.schema.json`,
> `PIPELINE_AGENT_CMD`) and are edited out below.

Order is by dependency. Difficulty labels size the (V2) critic panel; in V1 they just set
expectations. T1–T4 have no dependencies and can start in any order.

## T1: Base Docker image — medium — depends: — — **DONE 2026-07-25**
Built at `docker/base/Dockerfile`, image `pipeline-base:local`; checks in
`scripts/test-base-image.sh` (all passing). design-ref: §6, §7 item 3
- [x] Base Dockerfile in this repo builds; `node`, `git`, `claude`, `bd` on PATH inside
- [x] Base OS, Node, CLI versions pinned exactly (node:22.23.1-bookworm-slim, claude-code 2.1.220, @beads/bd 1.1.0)
- [ ] `FROM`-able by a thin per-project layer (proven by T18 — still pending)
- [x] No credential in any layer (`CLAUDE_CODE_OAUTH_TOKEN` absent from history and env)

## T2: Beads setup + issue template — medium — depends: — — **DONE 2026-07-25**
Mapping finalized in `beads/issue-template.md`; creation wrapper `scripts/new-issue.sh`
(design-ref mandatory); checks `scripts/test-beads-roundtrip.sh` (14/14 pass).
design-ref: §3.1, §4.12, §7 item 1, §9
- [x] `bd init` proven in a fresh repo (the real target-repo init lands with T18's fixture)
- [x] Five spec fields mapped: description + constraints as `## sections` in the native description; acceptance → `--acceptance`; design-ref → `--design`; attempt log → `bd note` (native notes)
- [x] Check script proves all five round-trip through `bd show --json`, and that a missing design-ref is refused
- [x] Status vocabulary verified (open/in_progress/blocked/deferred/closed); `bd ready` is blocker-aware: deps gate it, in_progress/blocked excluded, closing a dep unlocks

## T3: `status.schema.json` — trivial — depends: — — **DONE 2026-07-25**
At `schemas/status.schema.json` (draft 2020-12, additionalProperties: false) with
examples in `schemas/examples/`; checks `scripts/test-status-schema.sh` (8/8 pass).
design-ref: §4.11
- [x] `status.schema.json` exists in this repo
- [x] Covers attempt summaries (number 1–3, verifierResult pass/fail/tampered/error, timestamp, optional feedback), changeSummary, optional rateLimitResetAt — plus stuckState (§4.6) and docsPhaseError (§4.3)
- [x] Valid example validates; invalid example fails (via npx ajv-cli + ajv-formats)

## T4: `PLANNING.md` playbook — medium — depends: T2 (soft) — **DONE 2026-07-25**
At repo root; checks `scripts/test-planning-playbook.sh` (23/23 pass).
design-ref: §3.2, §3.1, §3.4
- [x] Contains every §3.2 step: draft spec (five fields + difficulty label), sized critics (none/light/full panel), tests-before-code, coverage check, approve intent, freeze, create issue via new-issue.sh, declare deps, manual rebuild, pre-run checklist
- [x] States §3.1 conventions: five fields, `tests/acceptance/<issue-id>/`, freeze = `git merge-base` fork-point (tests must be on `main` pre-run), tamper scope = whole acceptance tree
- [x] States §3.4: manifest keyed by package manager, no arbitrary commands, Dockerfile cross-check, manual rebuild, runner-only-asserts
- [x] Acceptance bar stated as structural; followability deferred to the shadow trial

## T5: No-egress network + proxy sidecar — hard — depends: T1 — **DONE 2026-07-25 (all checks, incl. live)**
Squid 6.6 sidecar (`docker/proxy/`, pinned ubuntu/squid:6.6-24.04_edge), lifecycle
`scripts/pipeline-net.sh up|down` (net `pipeline-net`, proxy `pipeline-proxy:3128`),
checks `scripts/test-egress.sh` (12/12 pass). design-ref: §4.8, §7 item 3
- [x] Internal (`--internal`) network + dual-homed CONNECT-only sidecar; TLS passthrough (no ssl_bump, no CA); deny-by-default
- [x] Allowlist enumerated concretely: api/console/statsig.anthropic.com, nothing else — empirically confirmed sufficient
- [x] Live headless `claude -p` completed through the proxy on subscription auth (token read from git-ignored `.env.pipeline`)
- [x] github.com + registry.npmjs.org blocked via proxy; zero direct egress without proxy vars

## T6: Pre-run egress check — medium — depends: T5 — **DONE 2026-07-25**
`scripts/egress-check.sh` (the runner's per-run gate; ~0.75s in practice); checks
`scripts/test-egress-check.sh` (5/5 pass, incl. permissive-allowlist tamper case).
design-ref: §4.8
- [x] One throwaway container: allowed endpoint reachable via proxy + github.com and registry.npmjs.org blocked + zero direct egress
- [x] Bounded under 60 seconds (coreutils `timeout` + per-curl `-m` limits; measured <1s)
- [x] Non-zero exit on any failure — proven for both failure directions: sidecar down AND allowlist made permissive (the dangerous one)

## T7: Verifier scaffolding — medium — depends: T1 — **DONE 2026-07-25**
`pipeline/verify.js` (Node, no LLM; exit 0 pass / 1 fail / 3 tampered / 4 error) +
`schemas/verify.schema.json`; checks `scripts/test-verifier.sh` (19/19 pass: 9
scenarios + 8 schema validations + no-LLM grep). design-ref: §4.4, §3.1, §3.4, v1.0.2
- [x] Reads `ISSUE_ID`; executes `<verifyCommand> tests/acceptance/<issue-id>/` — with the config read **from the fork-point commit** (v1.0.2: worktree config edits are ignored — proven by the config-edit scenario)
- [x] Tamper diff covers all of `tests/acceptance/` **plus config `frozenPaths`** vs `git merge-base main HEAD`, untracked additions included — proven for modify, untracked-add, and helper-script-edit scenarios; tests never run on tamper
- [x] `regressionCommand` runs as evidence only (acceptance pass + regression fail → exit 0 with the partial signal recorded; absent → "absent")
- [x] Writes `/workspace/.run/verify.json`; all 8 scenario outputs validate against `verify.schema.json`

## T8: Entrypoint core loop — hard — depends: T3, T7 — **DONE 2026-07-25**
`pipeline/entrypoint.sh` + `pipeline/status.js` (sole in-container status.json writer);
checks `scripts/test-entrypoint.sh` (26 assertions pass: scenarios + schema validation
of every status file + host greps). design-ref: §4.3, §4.6, §4.10, §4.11
- [x] Max 3 verify attempts total in `status.json`; carry-over proven (pre-seeded 2 attempts → exactly 1 more, then bail)
- [x] Prompt = header + `.run/issue.md` + prior feedback, piped on stdin to `PIPELINE_AGENT_CMD` (default `claude -p --dangerously-skip-permissions`); `.run/` git-excluded; pipeline git identity
- [x] `verify.json` acceptanceOutput fed into attempt N+1's prompt (proven: failure text appears in next prompt) and recorded per-attempt
- [x] Bail: stuckState + `WIP:` commit preserving partial work, exit 10 (decided: no empty WIP commit when the agent produced nothing)
- [x] Tamper → WIP evidence commit, exit 11; agent crash → exit 30; success → verified commit excl. `.run/`, exit 0; `main` untouched across all scenarios

## T9: Entrypoint docs phase + commit discipline — medium — depends: T8 — **DONE 2026-07-25**
In `pipeline/entrypoint.sh`; scenarios 7–8 in `scripts/entrypoint-checks.sh`. design-ref: §4.3
- [x] On verify pass: implementation commit first, then one docs invocation → changeSummary into `status.json` + README/docs updates committed separately; never runs on fail/tamper/rate-limit paths (checked)
- [x] Docs-phase error after a passed verify is non-fatal: `docsPhaseError` recorded, exit stays 0
- [x] Boundary commits: each failed attempt's state committed (`attempt N (verification failed)`) — kill-loss window is one attempt; bail tip is an allow-empty `WIP:` marker

## T10: Entrypoint rate-limit exit — medium — depends: T8 — **DONE 2026-07-25**
In `pipeline/entrypoint.sh` (detection on agent non-zero exit + log signature);
scenarios 9–10 in `scripts/entrypoint-checks.sh`. design-ref: §4.7, §4.11
- [x] Usage-limit signature in the agent log → immediate exit 20, no retry, no WIP-as-failure
- [x] `usage limit reached|<epoch>` parsed → ISO `rateLimitResetAt` in `status.json`; absent when not reported (both schema-valid)
- [x] `attempts` array untouched — an interrupted attempt is never a failed attempt

## T11: Runner bootstrap — medium — depends: T6
**DONE 2026-07-25** — `runner/` (run.js, config.js, log.js, preflight.js, bd.js) +
`run.config.example.json`; checks `scripts/test-runner-bootstrap.sh` (19/19 pass,
against real Docker and real Beads). design-ref: §4.12, §4.8, §3.4, §6
- [x] Plain-JS Node runner (zero deps) reads `run.config.json`; required fields validated by name; malformed/absent config → exit 2 before any side effect; defaults for network/proxy/wall-clock/probe/agentCommand
- [x] Asserts image exists (fail fast, never builds); egress gate runs before any task and aborts the run on failure
- [x] Creates git-ignored `runs/<run-id>/run.log`; every line carries a `<runId>/<issueId>` trace ID
- [x] Owns lifecycle end to end: network+sidecar up at start, down at end; stale `in_progress` issues reset to open with an attempt-log note (proven against real Beads)
- [x] Runs from Git Bash on Windows; no WSL invocation, no platform `timeout`, no LLM; token from git-ignored `.env.pipeline`
- [x] `runner/bd.js`: host `bd` when installed, else containerized `bd` fallback — the host stays the sole Beads writer either way

## T12: Runner ↔ Beads queue integration — medium — depends: T2, T11 — **DONE 2026-07-25**
`runner/queue.js` + task loop in `runner/run.js`; checks `scripts/test-runner-queue.sh`
(22/22 pass against real Beads). Task execution stubbed via `PIPELINE_EXEC_STUB` until
T13/T14. design-ref: §4.10, §4.11, §4.12
- [x] Ready queue via `bd ready` (blocker-aware), sorted priority-first then FIFO by creation — proven with a mixed-priority, dependency-gated queue (blocked task excluded; unlocked once its dependency closed)
- [x] Claims each issue `in_progress` at start; applies the §4.11 table after exit — verified for done (closed), partial (closed, derived from `verify.json` regressions), stuck (blocked), paused (stays in_progress)
- [x] Sole Beads writer: attempt notes composed from the container's status file and appended host-side; issue exported to `issue.md` for the container; `pipeline/` provably never invokes `bd`
- [x] Blocked issues never re-picked (loop-termination proven); `results.json` per run records every task outcome

## T13: Runner per-task clone/branch/workspace — medium — depends: T11 — **DONE 2026-07-25**
`runner/workspace.js` (prepare, chooseBranch, hasCommits, collectArtifacts, discard),
wired into the task loop; checks `scripts/test-runner-workspace.sh` (20/20 pass against
a real bare remote). design-ref: §4.2, §4.10
- [x] Fresh clone from the remote per task into a host temp dir; branch `task/<issue-id>` off `origin/main` — fork point proven identical to remote main
- [x] Remote-collision → `-r2` suffix (proven with a pre-existing remote branch, which stayed intact); runner provably contains no force-push
- [x] `.git/info/exclude` entry for `.run/` at clone time; commits proven free of `.run/`
- [x] Issue exported to the workspace's `.run/issue.md`; frozen tests present from main (verifier baseline exists)
- [x] Artifacts (`status.json`, `verify.json`, agent logs) collected into `runs/<runId>/tasks/<issue>/` before the workspace is discarded; outcome derived from the collected `verify.json`; `hasCommits` computed for T16's push decision; clone failure fails the task, not the run

## T14: Runner container launch + wall-clock kill — hard — depends: T13, T5, T8 — **DONE 2026-07-25**
`runner/container.js` + async task loop; checks `scripts/test-runner-container.sh`
(21/21 pass with REAL containers running the REAL entrypoint on the closed network;
agent behavior stubbed in-container via `agentCommand`, so no subscription burn).
design-ref: §4.1, §4.6, §4.10, §4.11, §6
- [x] One container per task, named `task-<issue>-<runId>`: `/workspace` rw, `/pipeline` **ro**, command `bash /pipeline/entrypoint.sh`, `--network` closed net, env exactly per §4.10 (`ISSUE_ID`, `WORKSPACE`, `PIPELINE_DIR`, proxy vars, optional `PIPELINE_AGENT_CMD`)
- [x] Token passed **by name** at `docker run` (value from the runner's env, never in an arg list, log, or image layer — log-scan check confirms); no git credentials inside
- [x] Active-time budget tracked host-side by a Node timer + `docker kill` (no platform `timeout`); breach → outcome `failed`, container confirmed stopped, status file treated as best-effort
- [x] Full round trip proven end to end: real verify pass → done + committed work; unsatisfiable task → exactly 3 in-container attempts → stuck/blocked with stuck state; every outcome mapped via the §4.11 table
- [ ] `run.json` manifest (schema `run.schema.json`) — moved to T16/T17, where PR URLs and final statuses exist

**Two real bugs this task caught** (both would have broken every production run):
1. Bind-mounted workspaces are owned by the host user → git's dubious-ownership guard blocked every git call → verifier `error`. Fixed: entrypoint marks `$WS` a safe directory.
2. Host clone on Windows wrote CRLF → the Linux container's git saw every file as modified → verifier reported **tampered** on clean checkouts. Fixed: workspace clones with `core.autocrlf=false`, `core.eol=lf`.

## T15: Rate-limit pause/resume — hard — depends: T14, T10 — **DONE 2026-07-25**
`runner/pause.js` + pause loop in the task loop; checks `scripts/test-runner-pause.sh`
(21/21 pass with REAL containers across REAL pause/resume cycles; in-container agent is
a state machine that fails once, then reports a usage limit, then succeeds — which is
what proves carry-over). design-ref: §4.7, §4.11
- [x] Exit 20 → pause logged, issue parked in_progress (never a terminal status), no push/PR
- [x] Waits until the container-reported reset time when present; otherwise probes on the configured interval and keeps waiting while the probe reports a limit (`PIPELINE_PROBE_CMD` test seam mirrors `PIPELINE_AGENT_CMD`)
- [x] Relaunch is a fresh container against the **same workspace**, so `.run/status.json` survives: proven by attempts `[1: fail, 2: pass]` spanning two containers, numbered continuously
- [x] **Paused time excluded from the budget — proven**: a run outlived its 18s wall clock (25s elapsed) and still succeeded, because only 4s was active container time; active time accumulates across relaunches and a genuine active-budget breach still kills
- [x] Give-up guard: after `maxPauses` cycles the task stays `paused` rather than looping forever

## T16: Runner outcome handling — hard — depends: T14, T12, T7 — **DONE 2026-07-25**
`runner/publish.js` + publish step in the task loop; checks
`scripts/test-runner-publish.sh` (26/26 pass — real containers, real pushes to a local
bare remote, `gh` captured through the `PIPELINE_GH_CMD` seam). design-ref: §4.5, §4.11
- [x] Branch pushed whenever it has commits — proven for stuck (WIP marker present on the remote branch); nothing pushed when there are no commits; no force-push anywhere
- [x] PR opened only for `done`/`partial` (gate asserted in code and behaviour); `gh` provably never invoked on stuck/tampered/failed paths
- [x] `partial` (acceptance pass + regressions fail) still gets a PR, with a **PARTIAL — needs scrutiny** callout, the regression verdict, and a `[PARTIAL]` title marker
- [x] PR body assembled host-side from structured artifacts only — issue spec + `status.json` change summary + `verify.json` evidence (collapsible output), marked generated; no free-form agent prose parsed
- [x] Write-back: PR URL recorded on the issue for PR'd tasks, branch link recorded for pushed-but-unPR'd ones; per-task `results.json` gains branch, pushed, prUrl, attempts, pauses, active seconds

## T17: Run report generator — medium — depends: T16, T3 — **DONE 2026-07-25**
`runner/report.js` + `schemas/run.schema.json` (the third contract schema, owned by the
runner); checks `scripts/test-report.sh` (21/21 pass). design-ref: §4.9, §4.11, §4.12
- [x] `runs/<runId>/run.json` manifest (schema-validated) + `report.md` rendered from it — Beads can't reconstruct statuses (stuck/tampered/failed all map to blocked), so the manifest is the frozen source
- [x] Regeneration byte-identical for both manifest and report; report marked "never edit by hand"; no LLM in the generator
- [x] Per task: outcome label spelling out its meaning, branch, PR link (or "review the branch directly" / "not pushed — no commits"), attempts, rate-limit pauses, active time, diff size, change summary, verification evidence, stuck state, attempt notes
- [x] Order: tampered > stuck > partial > failed > done-with-retries > done-first-try, ties by attempt count then diff size — verified end to end, and the manifest is stored in the same order

## T18: Fixture repository on GitHub — medium — depends: T1, T2, T4 — **DONE 2026-07-25**
**`github.com/<private fixture repo>` (private)**, working copy at
`<projects dir>\pipeline-fixture`; runner config `run.config.fixture.json`; checks
`scripts/test-fixture.sh` (20/20 pass). design-ref: §7, §3.4, §3.1
- [x] Real GitHub repo with `main` pushed and local==origin (so the freeze baseline is the remote's); `.gitattributes` forces LF so Windows checkouts can't commit CRLF blobs into a Linux-container project
- [x] `pipeline.config.json`: `verifyCommand`, `regressionCommand` (exercises the evidence path), `frozenPaths` (the acceptance runner itself), package-manager-keyed `dependencies`
- [x] Thin `Dockerfile` FROM the pinned base; image `pipeline-fixture:local` builds; manifest↔Dockerfile cross-check passes (no drift)
- [x] Three Beads issues with all five spec fields — **fix-a2z** (success: add shout mode), **fix-znz** (bail: unsatisfiable), **fix-djl** (tamper) — each with frozen acceptance tests committed to `origin/main`
- [x] Scenario behaviour verified on a clean checkout: success fails until implemented (real work), bail is unsatisfiable by construction, tamper fails until its frozen test is wrongly edited; regression suite green; all three issues ready

**Bug found:** `scripts/new-issue.sh` was broken on the Windows host — its container
fallback didn't guard against MSYS path conversion (`-w /repo` → `C:/Program Files/Git/repo`).
It had only ever run *inside* a container before. Fixed with `cygpath` + `MSYS_NO_PATHCONV`.

## T19: Deterministic agent stubs — trivial — depends: T8 — **DONE 2026-07-25**
`stubs/` (`success.sh`, `bail.sh`, `tamper.sh`, `ratelimit.sh`) + `stubs/README.md`,
extracted from the inline stubs the T8–T16 suites had grown. design-ref: §7, §4.3
- [x] `bail.sh` never satisfies the tests (writes notes each attempt so the WIP commit has content); `tamper.sh` neuters the task's frozen test using `ISSUE_ID`; `success.sh` implements the fixture's shout mode and branches on the docs prompt to emit a change summary; `ratelimit.sh` reports a usage limit once (with a reset epoch) then succeeds
- [x] Substitutable via `PIPELINE_AGENT_CMD` / `agentCommand`; zero model calls
- [x] Verified live against the fixture: `success.sh` makes `fix-a2z`'s frozen acceptance test pass and produces a real change summary

## T20: Container-side isolation assertions — medium — depends: T5, T7, T14 — **DONE 2026-07-25**
`scripts/test-isolation.sh` — runs a container configured **exactly** as the runner
configures one (14/14 pass). design-ref: §4.12, §4.4, §4.5, §4.8
- [x] Lives in this repo; runnable on demand and wired into the E2E pass (T21)
- [x] `git push` from inside fails; no credential helper, no GitHub/git tokens in the container env
- [x] `/pipeline` mount is read-only: writing to `verify.js` and deleting `entrypoint.sh` both fail, while reads still work
- [x] Allowlisted Anthropic endpoint reachable; `github.com`, `registry.npmjs.org`, `pypi.org` all blocked; zero direct egress when the proxy is bypassed
- [x] Minimum-necessary secrets: exactly one credential (the Anthropic token), no AWS/Azure/SSH/npm/Docker credentials; workspace still writable so tasks can work

## T21: Scripted end-to-end pass — hard — **DONE 2026-07-25 — V1 PROVEN**
`scripts/e2e.sh` (`--keep` to leave branches/PRs for inspection). **32/32 assertions
pass against live GitHub.** design-ref: §7, §4.11, §4.12
- [x] Zero-interaction run against `<private fixture repo>`; all three scenarios driven by `pipeline/stubs/` through the `agentCommand` seam — no model dependence, no usage burn
- [x] **Success**: exit 0 → done, branch pushed, **real PR opened** (`pull/2`), issue closed; live PR body verified to carry spec + change summary + verifier evidence; diff contains the implementation, leaves frozen tests untouched, and leaks no `.run/` artifacts
- [x] **Bail**: exactly 3 attempts → exit 10 → stuck; WIP branch pushed with the `WIP:` marker on the remote; no PR; issue blocked; stuck state on the issue
- [x] **Tamper**: exit 11 → tampered; verifier named the modified frozen path; no PR; issue blocked
- [x] Report + schema-valid manifest generated, tampered outcome labelled; T20 isolation assertions run as part of the pass; fixture `main` never moved; no interactive prompts anywhere
- [x] Self-cleaning: resets the fixture to its planning state before each pass and removes remote branches/PRs afterwards (unless `--keep`)
