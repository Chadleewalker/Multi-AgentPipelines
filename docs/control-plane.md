# Control Plane Guide

This is the current operator and agent entry point. It explains where policy lives and
how to run or change the pipeline without copying volatile lists into prose.

## Authority order

When two sources disagree, use this order:

1. `contracts/control-plane.json` owns stable enumerated policy: run defaults, exit-code
   outcomes, Beads ownership metadata, run pseudo-tasks, PR eligibility, and memory
   eligibility. Runtime modules consume this file through `runner/control-plane.js`.
2. `contracts/write-protection.json` owns the write-protection vocabulary: role roster,
   path classes, class precedence, deny reasons, and the client states. Guards,
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

## Write protection

A checkout whose selected integration fork point carries `pipeline.config.json` is
pipeline-first by default: an agent session in it may read anything and may not change
product, configuration, control or frozen paths. Absence of that file leaves a checkout
exactly as unprotected as it was before. No tracked or model-editable marker opts out.

```bash
node scripts/write-protection.js install     # both clients' hooks, host-side only
node scripts/write-protection.js status      # per-client state, and what is NOT covered
node scripts/write-protection.js recover     # a Git-registered home for refused edits
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
`disabled`, `unsupported` or `uninstalled` and never claims complete enforcement while any
of that is true. Admission is the backstop that is not optional: `scripts/freeze.js`,
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

**Codex denial is structured JSON, and non-managed trust is a separate human gate
(corrects `repo-gy3` and its closed PR #82).** For the current Codex `PreToolUse` dialect
(`tool_name: "Bash"|"apply_patch"`), a protected write is refused with exit 0 — the exit
Codex reads as "the hook ran and rendered a decision" — carrying one JSON object on stdout:
`hookSpecificOutput.hookEventName = "PreToolUse"`, `hookSpecificOutput.permissionDecision =
"deny"`, and a write-protection reason. PR #82 shipped the official nested
`[[hooks.PreToolUse]]` TOML-string form with both hooks reviewed and trusted through Codex
`/hooks`, and still failed open: a normal trusted Codex 0.151.0-alpha.7.1 session ran the
hook, treated its exit 2 as a HOOK FAILURE rather than a deliberate deny, logged "Failed",
and completed the protected `apply_patch` anyway. The structured, exit-0 denial above is
the fix. Project-level trust also proved insufficient on its own, because Codex's `/hooks`
trust binds to the exact hook *definition*, not to the repository — so a non-managed
installation that merely has the right shape is reported `unreviewed`, never `enforced`,
until a person runs the recipe below.

**The human-review recipe** (validated and documented here; the deterministic suite never
executes it and never claims it occurred):
1. Install the hooks: `node scripts/write-protection.js install`.
2. Open an interactive Codex session in the target checkout and run `/hooks`. TRUST both
   installed entries — the `^Bash$` and `^apply_patch$` matcher groups — by their exact,
   currently-installed definitions.
3. Record the review, bound to a digest of those exact definitions:
   `node scripts/write-protection.js review --client codex`. `status` will not call the
   Codex client `enforced` without a matching record, and the record stops being honoured
   the instant either definition changes.
4. From a SEPARATE, normal trusted Codex session — no bypass flag — attempt an `apply_patch`
   write to a protected path. The denial should surface as a rendered decision, never as a
   "Hook Failed" crash, and the protected file's hash and `git status` should remain
   unchanged. Managed installations (`WRITE_PROTECTION_MANAGED`) are trusted by policy and
   skip steps 2–3 entirely; `enforced`/`enforcementComplete` do not require personal review.

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
