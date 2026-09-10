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

## Agent provider selection

The agent backend is a closed selection, not a hard-coded vendor (`runner/agent-provider.js`,
`DESIGN.md` §6.5, change-log row `repo-45g`). `runner/agent-provider.js` owns the vocabularies
and constructs every host launch; do not restate either list here or in an instruction file.

Run-config fields, all optional: `provider` run-wide, `testAuthorProvider` and
`testProbeProvider` per planning stage, each with `reasoningEffort`,
`testAuthorReasoningEffort` and `testProbeReasoningEffort`. Selection resolves as a chain —
stage field, then the run-wide field, then the constant — and `runner/config.js` refuses a
value outside the vocabulary **by field name before a run starts**, then resolves the chain
onto the config so no reader re-implements the fallback. A config naming none of them is the
Claude configuration it was before, byte for byte; neither field can live in
`contracts/control-plane.json`'s `configDefaults`, because a chained field has no single
default value and that object is asserted identical to `runner/config.js`'s `DEFAULTS`.

What follows the selection:

- **Launch.** Codex author and probe stages run `codex exec` with the prompt on stdin, an
  explicit model, reasoning effort, ephemeral state, ignored user config and rules, strict
  config, automatic review under its workspace-write sandbox, and structured output. Claude
  keeps its existing restricted tool arguments unchanged. Secrets stay out of argv.
- **Credential.** One name per container and never both: `CLAUDE_CODE_OAUTH_TOKEN` or
  `CODEX_API_KEY`, passed by environment-variable name only. A host stage may reuse a saved
  `codex login`; a task container may not — no `auth.json` is mounted into one. Codex's shell
  environment policy keeps its default secret-name excludes and names `CODEX_API_KEY`
  explicitly, and the entrypoint strips that key for the repository-controlled verifier
  invocations, so the key reaches the agent CLI and nothing else. The task still receives no
  GitHub or Beads credential.
- **Egress.** One allowlist profile per provider, never widened to cover both:
  `docker/proxy` (Anthropic) and `docker/proxy-codex` (`api.openai.com` only).
  `scripts/pipeline-net.sh` builds the profile the run selected and `scripts/egress-check.sh`
  proves that one — selected endpoint reachable, unrelated hosts and direct egress blocked.
- **Output.** `pipeline/agent-output.js` reads Codex JSONL line-wise as `pipeline/envelope.js`
  reads the Claude envelope, yielding provider, configured and resolved model, token usage
  when the stream carries it, the final agent text, and canonical rate-limit evidence. A
  stream carrying no structured outcome answers null, so model prose never selects an outcome.
- **Readiness.** Executable, authentication, model availability, image support and egress are
  asked in that order, each refusal naming the remedy, and all of them ahead of worktree,
  Beads, Git publication, Docker task and agent-attempt mutation. A pinned CLI is not a
  capability check: the base image build fails without the required `codex exec` capabilities
  and preflight re-probes the built image in an isolated `--network none` container.

`CODEX_LIVE_SMOKE=1 node scripts/codex-live-smoke.js [--config run.config.<project>.json]` is
the one live, read-only check of which GPT model an account actually serves. It is opt-in, in
no suite roster, and read-only by CLI sandbox rather than by prompt.

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
preparation marker and without declaring its child complete. There is no supervisor CLI:
`runner/supervisor.js` is a host-side library, and a supervising process takes the lease and
issues grants through it.

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
- The deterministic verifier decides the result after the agent exits.
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
