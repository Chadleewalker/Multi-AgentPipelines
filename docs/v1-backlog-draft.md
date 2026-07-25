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
Config, image assert, egress gate, per-run logs. design-ref: §4.12, §4.8, §3.4, §6
- [ ] Plain-JS Node runner reads `run.config.json` (repo path/remote, image, wall-clock default, probe interval, network/proxy ids, optional `agentCommand`)
- [ ] Asserts image exists (fail fast); runs egress check and aborts run on failure
- [ ] Creates git-ignored `runs/<run-timestamp>/` with logs + trace IDs linking to issues
- [ ] Owns network/sidecar lifecycle: up at run start, down at run end; resets stale in-progress issues to open with an attempt-log note
- [ ] Works from Git Bash on Windows; no WSL, no platform `timeout`

## T12: Runner ↔ Beads queue integration — medium — depends: T2, T11
design-ref: §4.10, §4.11, §4.12
- [ ] Picks from the ready queue, priority-ranked, FIFO within ties, via `bd` against the host working copy
- [ ] Sets in-progress at start; applies §4.11 transitions after exit (closed / blocked / stays in-progress)
- [ ] Sole Beads writer; attempt notes appended from the status file; Beads data never on task branches
- [ ] Blocked issues never re-picked; loop ends when queue drains

## T13: Runner per-task clone/branch/workspace — medium — depends: T11
design-ref: §4.2, §4.10
- [ ] Fresh clone from the GitHub remote per task; branch `task/<issue-id>` off canonical `main`
- [ ] Remote-collision → `-r2`, `-r3` suffix; never force-push
- [ ] `.git/info/exclude` entry for `.run/` at clone time
- [ ] Issue exported read-only to `/workspace/.run/issue.md`

## T14: Runner container launch + wall-clock kill — hard — depends: T13, T5, T8
design-ref: §4.1, §4.6, §4.10, §4.11, §6
- [ ] One container per task: `/workspace` rw mount, scaffolding ro at `/pipeline` (container command = entrypoint there), closed-network attach, env per §4.10 (`ISSUE_ID`, `PIPELINE_AGENT_CMD`, token, proxy vars)
- [ ] Token only at `docker run`; no git credentials inside
- [ ] Active-time budget (default 4h) tracked host-side; breach → `docker kill`, outcome failed + timeout note, status file best-effort
- [ ] Exit code mapped via the §4.11 table; writes the per-task record into `runs/<ts>/run.json` (schema `run.schema.json`, owned by the runner)

## T15: Rate-limit pause/resume — hard — depends: T14, T10
design-ref: §4.7, §4.11
- [ ] Exit 20 → issue stays in-progress, pause logged, no push/PR yet
- [ ] Waits for reset time, or probes host-side `claude -p` on the configured interval
- [ ] Relaunch = fresh container, same host clone; `.run/` persists so attempt count carries over
- [ ] Pre-pause active time counts against wall-clock; paused time never; never recorded as failure

## T16: Runner outcome handling — hard — depends: T14, T12, T7
Push-always, PR-per-table, Beads transitions. design-ref: §4.5, §4.11
- [ ] Branch pushed whenever it has commits — incl. WIP from 10/11/30/timeout
- [ ] Exit 0 → PR via `gh`; done vs partial from `verify.json`; partial PR flagged with regression evidence
- [ ] Beads transitions exactly per §4.11
- [ ] PR body assembled from issue spec + status-file summary + `verify.json`; no free-form prose parsed

## T17: Run report generator — medium — depends: T16, T3
design-ref: §4.9, §4.11, §4.12
- [ ] Markdown report into `runs/<ts>/` from **run manifest** + Beads + git; byte-identical on regeneration
- [ ] Per task: §4.11 report status, branch, what changed, verification evidence, attempt notes; failed branches linked
- [ ] Order: tampered > stuck > partial > failed > done-with-retries > done-first-try; ties by attempt count then diff size
- [ ] "Paused" only when the operator stopped the run early

## T18: Fixture repository on GitHub — medium — depends: T1, T2, T4
design-ref: §7, §3.4, §3.1
- [ ] Dedicated repo: `main`, `pipeline.config.json` (verifyCommand + manifest), thin Dockerfile `FROM` base; manifest↔Dockerfile cross-check passes
- [ ] Per-project image builds
- [ ] Three issues (success / bail / tamper) with frozen acceptance tests on `main`

## T19: Deterministic agent stubs — trivial — depends: T8
design-ref: §7, §4.3
- [ ] Bail stub never satisfies tests; tamper stub edits a frozen test; optional success stub passes
- [ ] Substitutable via `PIPELINE_AGENT_CMD` (through `run.config.json` `agentCommand`); zero model calls

## T20: Container-side isolation assertions — medium — depends: T5, T7, T14
design-ref: §4.12, §4.4, §4.5, §4.8
- [ ] Live in this repo; on demand + invoked by the E2E pass
- [ ] `git push` from inside fails; verifier mount unwritable; non-allowlisted egress fails

## T21: Scripted end-to-end pass — hard — depends: T9, T15, T16, T17, T18, T19, T20
design-ref: §7, §4.11, §4.12
- [ ] Zero-interaction run against the fixture repo; stubs for bail/tamper (no model dependence)
- [ ] Success: exit 0, branch pushed, PR opened, issue closed, report "done"
- [ ] Bail: exit 10, `WIP:` commit pushed, no PR, blocked, report "stuck"
- [ ] Tamper: exit 11, WIP evidence pushed, no PR, blocked, report "tampered"
- [ ] Report in `runs/<ts>/` ordered tampered > stuck > done; T20 assertions pass during the run
