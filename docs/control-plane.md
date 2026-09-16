# Control Plane Guide

This is the current operator and agent entry point. It explains where policy lives and
how to run or change the pipeline without copying volatile lists into prose.

## Authority order

When two sources disagree, use this order:

1. `contracts/control-plane.json` owns stable enumerated policy: run defaults, exit-code
   outcomes, Beads ownership metadata, run pseudo-tasks, PR eligibility, and memory
   eligibility. Runtime modules consume this file through `runner/control-plane.js`.
2. `contracts/write-protection.json` owns the write-protection vocabulary: role roster,
   path classes, class precedence, deny reasons, and the six client states. Guards,
   hook bridges, admission, status and tests all read it and nothing restates it.
3. `schemas/*.schema.json` own persisted artifact shapes. The mandatory contract suite
   checks that shared vocabularies agree with the control-plane contract.
4. A target project's `pipeline.config.json` owns its verifier, regression policy,
   default branch, and frozen paths. The runner reads it from the immutable fork point.
5. Source modules own algorithms and sequencing. `DESIGN.md` owns the rationale for
   those algorithms and the architecture that constrains them.
6. `docs/change-log.md` and `docs/STATUS.md` are historical records. They explain how the
   present design emerged; neither is a live configuration source.

Do not transcribe a mutable roster or enum into an instruction file. Ask the owning
source instead:

```bash
bash scripts/test-ci.sh --list
node -p "JSON.stringify(require('./contracts/control-plane.json'), null, 2)"
```

## Operator path

Create a git-ignored `run.config.<project>.json` from the example, then point its local
path and remote at the same repository. Preflight compares their canonical Git identity
before it touches Beads, creates a workspace, or starts Docker.

```bash
node runner/run.js --config run.config.<project>.json
```

The project lock is host-global. A second run for the same canonical repository is
refused; different repositories may run independently. The host is the sole Beads writer
and the sole holder of Git and GitHub credentials.

Useful read-only controls:

```bash
node scripts/dashboard.js
node scripts/batch.js pending
node scripts/batch.js show
node scripts/audit-runs.js
node scripts/verdict.js pending
```

To stop a fed run cleanly, create `runs/<run-id>/stop`; active workers finish before the
feed closes. Do not launch a run from an auxiliary worktree because `runs/` is host-local
and its observer artifacts belong in the main checkout.

## Kickoff intake

`scripts/kickoff.js` records a kickoff packet against a project and returns; it creates no
Beads issue and starts no child process, so it does not touch Docker, Git, the network or the
target lock.

```bash
node scripts/kickoff.js submit --config run.config.<project>.json --packet idea.json
node scripts/kickoff.js list   --config run.config.<project>.json [--json]
node scripts/kickoff.js show   --config run.config.<project>.json --id kp-… [--json]
```

The `kickoff-intake/1` state is durable user intent: its default root is
`~/.multi-agent-pipelines/`, never the OS-temporary target-lock root. Under that root the
tool partitions records by `runner/lock.js`'s canonical target identity and stores complete
records in `proposals/<id>.json`; equivalent target spellings and separate pipeline checkouts
therefore read one intake. `PIPELINE_STATE_DIR` is the only test seam that re-aims this root.
`PIPELINE_GLOBAL_LOCK_DIR` continues to re-aim locks only and moves no proposal state.

Proposal ids are `kp-` plus 16 lowercase hexadecimal characters. Each record has immutable
canonical `intent` bytes and a `sha256:` hash of those bytes. The packet is a closed JSON
object with `version`, `title`, `description`, `constraints`, `examples`, `nonGoals`,
`priority`, `relations` and `origin`; see `node scripts/kickoff.js --help` for the input bound
and refusal vocabulary.

Turn one intake record into its canonical Beads spec with the subscription-authenticated
specifier. It pins the configured integration commit, gives Codex only an isolated read-only
checkout, and either creates one issue or returns a question without touching Git or Beads:

```bash
node scripts/specify-proposal.js run --config run.config.<project>.json --proposal kp-…
node scripts/specify-proposal.js answer --config run.config.<project>.json --proposal kp-… \
  --evidence sha256:… --answer "the product choice"
node scripts/specify-proposal.js run --config run.config.<project>.json --proposal kp-…
```

Questions, answers and self-verifying receipts live beside the durable intake partition,
outside the target repository. Answers must name the exact question-evidence hash. Restarts
reuse a verified receipt, while recovery after a successful Beads create searches the exact
external kickoff reference so Beads remains the only source of issue identity.

## Model provider selection

A run selects one model provider from a closed vocabulary — `claude` or `codex`
(`runner/agent-provider.js`, `DESIGN.md` §6.5, change-log row `repo-45g`). The run config
carries `provider` run-wide plus `testAuthorProvider` / `testProbeProvider` for the two
host-side planning stages, and `reasoningEffort` (`minimal | low | medium | high`) with the
same two stage twins. Resolution is a chain — stage, then run-wide, then the constant — so
these are resolved in `runner/config.js` rather than in `contracts/control-plane.json`'s
`configDefaults`, whose values are fixed. **With every field absent the resolution is Claude
at every stage and every launch is byte-for-byte what it was before.** An out-of-vocabulary
value is refused by its own field name before a worktree, a Beads read, a network or a
container exists.

The specification planner is a fifth, independently resolved lane. `specificationModel` names
the model `scripts/specify-proposal.js` hands to Codex; it is validated by the same bounded
alias rule, refused by its own name, and defaults to a Codex constant that is **never derived
from `model`** — otherwise a Claude implementation run would pass a Claude alias to
`codex exec --model`. `proposal-supervisor status` reports the resolved value at the top level
and per proposal. The commands that can launch specification (`start`, `run`, `resume`,
`tick`) first run one bounded `codex login status` probe with `CODEX_API_KEY` and
`OPENAI_API_KEY` stripped, before ownership, durable intake, locks, worktrees, Docker or any
model launch; neither key nor a Claude credential is a fallback for the saved ChatGPT session.
`runner/prerequisites.js` is unchanged: a preparation-only all-Claude workflow still passes
without Codex being installed or logged in.

`provider` selects only the vendor. The `model`, `testAuthorModel` and `testProbeModel`
fields still name the model, and a Codex run needs a model id that provider understands —
the example config's Claude aliases are not one. `codexAuth` explicitly selects `chatgpt`
or `api-key` for Codex implementation workers. The checked-in template declares dormant
`chatgpt` while keeping the canonical Claude/opus defaults; an older config with no field
retains its API-key behavior.

Selecting a provider selects three things together, and they are not independently
configurable:

- **The credential.** Claude uses `CLAUDE_CODE_OAUTH_TOKEN`. Codex `api-key` mode uses
  `CODEX_API_KEY`; both are read from the git-ignored `.env.pipeline` or ambient environment,
  passed by environment-variable name only, and have no cross-provider fallback. Codex
  `chatgpt` mode accepts only the managed `auth_mode: "chatgpt"` session created by
  `codex login` with a nonempty refresh token. Preflight seeds a private durable cache only
  when it is absent, then Codex refreshes that cache across tasks; the original host login
  never overwrites refreshed state.
- **The container command.** The runner passes `PIPELINE_PROVIDER`, and
  `pipeline/entrypoint.sh` selects that provider's noninteractive invocation.
- **The egress profile.** `docker/proxy` carries the Anthropic endpoints;
  `docker/proxy-codex` allows exactly `api.openai.com`, `chatgpt.com`, and
  `ab.chatgpt.com`. `PIPELINE_PROXY_PROFILE` picks which sidecar `scripts/pipeline-net.sh`
  builds and which endpoint `scripts/egress-check.sh` proves reachable. One profile per
  provider: widening either to carry the other's endpoints is refused by design, not by a
  check.

A missing executable, credential, model, image capability or route fails before any
mutation and names its remedy. ChatGPT preflight also distinguishes an invalid or missing
login from a busy credential lane before target mutation. For a non-default provider,
preflight additionally proves
the *task image* can run that provider's CLI with every required capability — presence in
`docker image inspect` is not that proof — so rebuild the pinned base image during planning
if it predates the Codex pin. Codex keeps `--approve-for-me` and its inner Codex sandbox.
Because that sandbox creates its own unprivileged namespace, Codex task containers alone add
`seccomp=unconfined` to the outer Docker policy; they do not add privileged mode, a capability,
a host namespace, the Docker socket, or another host path. Before network startup or target
mutation, preflight runs `codex sandbox -- true` without credentials or network as the image's
non-root `node` user under that exact option and refuses a host where the namespace cannot start.
The one live model call in the Codex surface is opt-in and
documentary:

```bash
CODEX_LIVE_SMOKE=1 node scripts/codex-live-smoke.js --image <rebuilt-pinned-task-image>
```

One saved ChatGPT session is one exclusive credential lane. The lane is held from task-cache
staging through every Codex invocation and atomic refresh write-back, so a second worker waits
and never receives a concurrent copy of the refresh token. Parallel subscription workers use
`codexAuthCacheRoots`, a roster of independently authenticated canonical absolute private
directories outside repositories and task workspaces. Preflight validates the whole roster,
quarantines bad saved sessions individually, and refuses only when none remain healthy.
Credential work waits in FIFO order without treating the external lock timeout as a queue
deadline; credential-free stage caps continue independently. Each task gets one unique writable handoff mounted
at `/run/pipeline-auth-host/cache`; the root entrypoint copies it into an internal
`CODEX_HOME=/root/.codex`, then runs Codex as the image's `node` user. Repository
verification runs as `nobody` with `CODEX_API_KEY`, `OPENAI_API_KEY`, and `CODEX_HOME`
unset. Successful cleanup removes only the task copy; failed refresh persistence keeps the
prior durable cache and recoverable task copy. An `agentCommand` override changes the executable,
not this boundary: the managed-auth marker, protected handoff mount, unprivileged agent identity,
and credential-free verifier remain in force. Only a nested entrypoint fixture that supplies both
an explicit command and `PIPELINE_TESTING_NESTED_ENTRYPOINT=1` may suppress inherited managed-auth
setup; that test capability is neither a configuration field nor forwarded by production launch
construction. Repair reacquires that lane's exact lock and
compares its staged durable-source digest before writing; busy or changed lanes remain
untouched while healthy siblings continue. A staging, launch, or refresh rejection settles as
one failed task row and one canonical `task.finished` event while the shared drain awaits every
healthy sibling before report generation and cleanup. The ownership module does not mutate
process I/O or add caller keepalive polling.

## Supervised operation

One live project supervisor may hold that same host-global canonical-target authority and
authorize preparation and implementation children under it, instead of having those commands
contend with it as unrelated coordinators (`runner/supervisor.js`, `DESIGN.md` §3.10,
change-log row `repo-rj7`). The lease *is* the lock, so a second supervisor and every
unrelated standalone coordinator are still refused by owner name before any work is launched.

`PIPELINE_CHILD_AUTHORITY` names a file holding one scoped child authority record, and no
command line changed: `scripts/prepare-batch.js` asks for the `preparation` scope and
`runner/preflight.js` — and so `runner/run.js` — asks for `implementation`, each as the first
thing it does, ahead of the lock and therefore ahead of Docker, the network and every Beads
call. With that variable unset and no supervisor present, admission answers `standalone` and
every command behaves exactly as described above.

Authority is a host record kept beside the lock, outside every model-editable tree; the file
and the environment variable only name it, and neither grants anything on its own. A child is
admitted only when the host record matches the presented authority field for field, names this
canonical target, is unspent and unexpired, and was granted for the requested scope by a parent
that is still the live holder. Forged, replayed, expired, wrong-target, wrong-parent, released
and wrong-scope authority is refused before any Beads, Git, Docker or network mutation, and a
refusal leaves every ownership record untouched. An admitted child takes no target lock of its
own and releases none, and it cannot widen its own scope. Two admitted children may be live at
once, so what the lock used to serialize is now two independent host-global critical sections
keyed on (canonical target, section): `beads-write` and `integration-publish`, one child inside
each at a time.

A grant leaves the outstanding list only when its parent settles it as `complete` or
`released` — never by expiry, a dead parent or a reclaim — so an interrupted supervisor leaves
a readable record of what it had in flight. A live parent is never taken over, and a provably
dead one is reclaimed only when a person asks explicitly, without deleting an uncertain
preparation marker and without declaring its child complete. There is no standalone
lease-management CLI: `runner/supervisor.js` is a host-side library, and the proposal supervisor
below takes the lease and issues grants through it.

That process uses `runner/operation-manager.js` to launch the existing preparation command and
one live-feed implementation runner. Its records and authority copies live under host state,
outside the target tree. Project feed reservation and retry advancement are atomic across
manager processes. Status trusts only durable preparation/run artifacts and authenticated child
identity; an unproven post-spawn identity or uncertain parent settlement remains attention and
forbids retry. `reconcile` asks the parent grant record for deterministic settlement truth and
never launches replacement work. Prior attempts remain immutable evidence, and `stop` uses the
existing run sentinel so active workers drain.

The manager API deliberately separates observation from mutation. `status({ project, id })`
may recover an implementation PID only from the authenticated child artifact; `restart(...)`
never launches recorded work. `retry({ project, id, approved: true, grant })` is the only retry
path and accepts only an attention operation whose child identity and settlement are already
known. A pre-spawn reservation is different: `recoverLaunch({ project, operationId, configPath,
grant, approved: true, reason })` requires a non-empty parent audit reason attesting that no child
remains, preserves the reserved attempt as `not-spawned`, and launches the next attempt. It is
the only mutation path for an orphan slot, a matching pending launch, or a retry slot whose next
operation record was not persisted. Authenticated child evidence forbids this recovery; if the
recovery itself stops after recording `not-spawned`, only another explicitly approved
`recoverLaunch` call may resume it. Use `reconcile({ project, id })` for uncertain settlement;
it settles the original grant or leaves attention in place, but never starts a child.
`stop({ project, id })` applies only to a running implementation feed and writes that run's
normal stop sentinel.

`scripts/proposal-supervisor.js start --config <run.config.json> [--proposal <kp-id>]`
enters the unattended proposal conveyor. `start`, `run`, `resume` and `tick` first admit the
specification lane with one bounded `codex login status`, before the lease, durable intake,
locks, worktrees, Docker or any model launch; `status` and `stop` launch no planner and are
ungated. The process acquires the project supervisor lease,
discovers durable kickoff records, and remains alive across pending specification,
preparation, implementation, and review evidence. It retires a drained implementation feed
before assigning later prepared work to a uniquely named successor. The `stop` command
closes durable intake immediately; the live process then drains and settles children before
releasing its parent lease. If the process crashes, restart only observes recorded
operations—attention and uncertain settlement still require the explicit operation-manager
recovery commands described above.

`supervisorGlobalConcurrency` bounds all controller calls together;
`supervisorStageConcurrency` independently bounds `specification`, `preparation`, and `review`.
Both are positive whole-number host configuration, validated before supervisor authority is
acquired. Ready implementation work is admitted ahead of newly queued specification work.
`status [--proposal <kp-id>] [--json]` reports queue position, current stage, wait and active
time, attempts, selected model, the resolved specification planner model, recorded and
currently available token counts, kickoff/spec,
issue/freeze/run/branch/PR/review identities, history, and the smallest next action. The human
form is a rendering of the same durable facts.

After sibling task PRs publish, a supervisor can use `runner/batch-merge.js` to coordinate the
fan without delaying or rewriting either task's product commit. `plan(...)` and
`renderReport(...)` are read-only and report pairwise merge readiness, shared Markdown paths,
and the required review order. `integrateDocs(...)` creates one separately reviewable docs-only
branch containing every safely reconcilable contribution; `rebaseTask(...)` creates a new review
ref and leaves the published task ref untouched. A supervising caller must hold
`integration-publish` for either mutation and supply the host Beads state adapter. Neither API
merges to the integration branch. Failed reconciliation or rebase attempts create no partial ref,
write recoverable JSON evidence under `runs/merge-batch/`, and keep the named issues open or
blocked.

Launch-capable `prepare-batch` modes check the Docker daemon, configured image, configured
host shell, and authentication for the author/probe providers before write-protection admission,
locking, manifests, Beads, worktrees, attempts or workers. Each probe is bounded and the first
failure names its remedy; because refusal writes no preparation history, the same batch name can
be started or retried immediately after repair. Codex planning stages accept a provider-specific
key or a healthy saved ChatGPT login reported by `codex login status`. `status` and
`acknowledge-interrupted` stay available when those prerequisites are down.

A canonical author or green-probe usage-limit response parks the named preparation batch at the
provider's reset instant. Already-active workers settle normally, untouched issues remain pending,
and authored suite or retained probe paths are preserved. Inspect the reset, paused stage, affected
workers, paths and exact command with `node scripts/prepare-batch.js status <batch>`; the printed
`node scripts/prepare-batch.js resume <batch>` refuses before the reset without launching a model
and afterwards continues only the unfinished limited attempt.

Preparation status derives live `authoring` and `proving` phases from immutable batch-owner and
worker process identities using the target lock's reboot- and PID-recycle-aware liveness rule. It
reports `interrupted-unknown` only when an unmatched worker identity is no longer live; an existing
terminal result remains authoritative even after either process exits. The worker's canonical
top-level `started.process` supplies `started.pid`; platform selection is an explicit host-owned
coordinator input, so portable verification can prove the Windows identity path without changing
global process state, while Windows-host integration exercises the real platform default.

The same durable records, not the presence of suite files, decide whether an acceptance suite may
be offered the human freeze step. `runner/author-evidence.js` reads the newest recorded attempt
for an issue into `absent`, `authoring`, `interrupted-partial`, `authored-unproven`, `proven` or
`frozen`; an `author-proof` attempt that is unresolved with a dead worker, or whose outcome says
its authoring half never completed, is `interrupted-partial` regardless of how complete the
directory looks, and only `authored-unproven`, `proven` and `frozen` may print a freeze command.
Recovery is explicit and additive: `node scripts/author-tests.js <issue-id> --config <path>` rerun
as printed resumes the solo path in its existing worktree, and
`node scripts/prepare-batch.js retry <batch> <id>... --resume-partial` resumes an acknowledged
`author-proof` interruption in the batch path. `--resume-partial` is accepted only by `retry`,
applies only where the durable evidence still says authoring never completed, launches one new
worker generation in the existing worktree, and deletes nothing; a bare `retry` refuses as before,
and human approval remains the sole freeze boundary.

A Codex test-author launch is contained by per-launch directories the host owns and removes:
`runner/author-containment.js` creates a fresh shim root, plus a fallback candidate when that
filesystem cannot carry an executable, and registers each one in its construction handle before
writing that root's ownership marker or shims. A failure anywhere in that initialization removes
every root the launch created and reports a setup failure, so no owned containment directory is
left behind; removal names exact paths only, never enumerating the shared parent, and refuses a
symlink or reparse point, an undeclared parent, or a marker that is not this launch's. Every
containment failure — construction, rollback, or post-session cleanup — is reported as bounded
role text (`shim`, `fallback[0]`) with no host path or provider output. Cleanup that fails after
an otherwise complete session blocks the green proof and prints no freeze command; a nonzero,
usage-limited or incomplete session keeps its own outcome instead.

Preparation also resolves each not-yet-frozen issue's structured `design-ref` from the exact
integration HEAD recorded in its immutable manifest. It never consults an operator-local file
or a newer working-tree copy. Approved text that is not committed is published through the
pipeline-owned path, then verified before acceptance freeze:

```bash
node scripts/design-provenance.js publish <issue-id> --config run.config.<project>.json --source <approved-file> [--anchor <heading>] [--expected-head <sha>]
node scripts/design-provenance.js verify <issue-id> --config run.config.<project>.json [--commit <sha>]
```

Publication owns one immutable `docs/design/provenance/<issue-id>.md` path, commits and pushes
only that path, and updates the issue through the host Beads adapter. The canonical-target lock,
optional expected-HEAD lease and refuse-on-different-bytes rule prevent concurrent planning
sessions from overwriting or silently diverging provenance already referenced by a frozen task.
The exact provenance commit must be reachable from the configured remote integration ref before
Beads is updated; interrupted and ambiguous pushes are recovered by proving that remote fact.
As an import-compatible alternative, the canonical issue may carry a self-contained
`design-snapshot: sha256:<digest>` plus a fenced body; the resolver accepts it without repository
access only when the digest matches the UTF-8 body bytes. Routine planning still uses the
published `design-ref` path so the approved provenance remains reviewable in Git.

## Write protection

A checkout whose selected integration fork point carries `pipeline.config.json` is
pipeline-first by default: an agent session in it may read anything and may not change
product, configuration, control or frozen paths. Absence of that file leaves a checkout
exactly as unprotected as it was before. No tracked or model-editable marker opts out.

```bash
node scripts/write-protection.js install               # both clients' hooks, host-side only
node scripts/write-protection.js review --client codex # record a person's /hooks trust review
node scripts/write-protection.js status                # per-client state, and what is NOT covered
node scripts/write-protection.js recover               # a Git-registered home for refused edits
```

Authority is a host record, never a folder. `lease --grant` binds a role to one canonical
target, its Git common directory, the issue and run identity, the controlling process and
its start identity, the allowed path classes, an expiry and an unguessable token; a lease
a model could write is not one, so nothing inside a repository is consulted. A worktree is
isolation, not permission. The one deliberate exception is
`node scripts/write-protection.js allow-writes --target <dir> --session <id>`, which a
person grants for one repository and one session and revokes with `revoke`; `status` lists
every live grant.

Two enforcement layers, and only one of them is a perimeter. The hook bridges for Claude
and Codex refuse at the moment of the tool call, which is where a refusal is useful, but a
local hook can be disabled, a client can be configured without it, and a specialized tool
path can bypass it entirely — so `status` reports each client as `enforced`, `degraded`,
`disabled`, `unsupported`, `uninstalled` or `untrusted` and never claims complete enforcement
while any of that is true. `untrusted` is Codex-specific: a non-managed hook can be exactly
the right shape and still not be `enforced`, because Codex itself does not treat activation
as trust — a person must run the interactive `/hooks` command and then
`node scripts/write-protection.js review --client codex`, which binds a digest to the two
exact installed hook definitions (including their `--client codex` identity) and stops
honouring it the moment either one changes. Admission is the backstop that is not optional:
`scripts/freeze.js`,
`scripts/prepare-batch.js` and `runner/run.js` all call the same check over the real
integration checkout before they mutate it, and a protected path that is staged, unstaged
or untracked without matching planning or frozen-test provenance refuses the whole
operation, by name, without resetting, cleaning, stashing, overwriting, committing or
moving anything.

Managed client policy: an organization that needs non-disableable local policy must not
rely on either client's own configuration file, because both live on the operator's host
and both are editable there. Deploy the Codex hook block, and the Claude `PreToolUse`
entry, through centrally managed configuration your operators cannot rewrite — a
mandatory-profile MDM payload, a read-only mounted config directory, or your own equivalent
— and set `WRITE_PROTECTION_MANAGED=1` in that same managed environment so `status` is
entitled to report enforcement as complete. Until then it will not, and that is the honest
answer rather than a gap.

## Validation profiles

`scripts/test-ci.sh` is the mandatory Docker-free publication profile. Its `--list`
output is the only maintained roster. GitHub Actions and this repository's frozen
regression command run that same profile.

`scripts/test-all.sh` is the host sweep. It discovers leaf `scripts/test-*.sh` suites,
runs them sequentially, bounds each one, and reclaims only resources created by that
suite. Use it when Docker-backed integration evidence is required. `scripts/e2e.sh`
also exercises external publication seams and must not be treated as an implicit part of
a local documentation or unit change. The live e2e refuses a dirty fixture before any
mutation and may clean up only branches derived from its three dedicated fixture issue
IDs; a repository-wide `task/*` glob is never proof of ownership. Before reading fixture
authority or resetting/pushing anything, it proves the host commands exist, configuration
fields and fixture roster are valid, the Docker daemon is reachable, and both required
images exist. A missing prerequisite is a pre-mutation refusal, not a partially failed run.

For the routine complete host pass, use `node scripts/fast-full-sweep.js --repo .`. It runs
the authoritative mandatory profile once, proves the commit and tracked tree did not move,
then asks both canonical scripts for their current plans and delegates only the remaining
Docker/live suites to `test-all.sh`; e2e's invocation of `test-isolation.sh` supplies that
leaf's single coverage. The summary separates aggregate mandatory, direct extra and nested
coverage. For suite-by-suite diagnosis, use the canonical `bash scripts/test-all.sh`
fallback; it remains the default full sweep and retains every per-suite log and timing.

## Agent path

On the host, use Beads for durable work state and `bd prime` for the current workflow.
Do not commit, push, or synchronize the Dolt database unless the active user or repository
profile authorizes it. Preserve unrelated working-tree changes. In a checkout whose
integration fork point carries `pipeline.config.json`, read anything and change product,
configuration, control and frozen paths through a pipeline run rather than by hand; see
**Write protection** above for what is refused, how to check enforcement honestly, and how
refused edits are recovered.

Inside a task container:

- `/workspace/.run/issue.md` and `/workspace/.run/memory.md` are read-only inputs.
- Never edit `tests/acceptance/` or a path frozen by `pipeline.config.json`.
- The implementation agent works in the task workspace. The later documentation agent works
  only in a detached disposable worktree at the verified implementation commit; scaffolding
  transfers its exact allowed Markdown tree delta back before final verification, never its
  ignored, untracked or process-created runtime files.
- The deterministic verifier decides the result after the agent exits. Final verification runs
  in the publishable task workspace over the transferred docs delta and does not suppress leaks
  created by that verifier itself.
- Docker, Beads, Git credentials, and general network access are unavailable by design.
- Record durable insights with `node /pipeline/status.js note "..."` and suspected spec
  defects with `node /pipeline/status.js concern "..."`; neither changes the outcome.
- Commit meaningful implementation boundaries locally. The host performs disclosure
  scanning and publication after the container exits.

## Changing policy

Change an enumerable policy value once in `contracts/control-plane.json`, then update any
schema whose persisted vocabulary is affected. Change algorithms in their owning module.
For an architectural change, amend `DESIGN.md` and append one uniquely identified row to
`docs/change-log.md`; never edit an existing history row.

Run the focused suite while working, then the mandatory profile:

```bash
bash scripts/test-control-plane-contract.sh
bash scripts/test-ci.sh
```

The control-plane contract and loader are frozen paths. A task implementation therefore
cannot rewrite its own outcome or publication policy.
