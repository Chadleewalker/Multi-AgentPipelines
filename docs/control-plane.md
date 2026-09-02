# Control Plane Guide

This is the current operator and agent entry point. It explains where policy lives and
how to run or change the pipeline without copying volatile lists into prose.

## Authority order

When two sources disagree, use this order:

1. `contracts/control-plane.json` owns stable enumerated policy: run defaults, exit-code
   outcomes, Beads ownership metadata, run pseudo-tasks, PR eligibility, and memory
   eligibility. Runtime modules consume this file through `runner/control-plane.js`.
2. `contracts/write-protection.json` owns the write-protection vocabulary: role roster,
   path classes, class precedence, deny reasons, and the five client states. Guards,
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

### Black-box check: proving the Codex hook actually fires

A hook block that parses is not a hook that runs, and this project has written that mistake
twice. The flat `[[hooks.apply_patch]]` tables of change-log row `repo-324` and the
matcher-group `command` key drafted for issue `repo-l2w` were both accepted by Codex without
complaint and dispatched by nothing; the second was reported `enforced` while an ordinary
session rewrote `runner/run.js` in front of it. `status` now reads the nested
`[[hooks.PreToolUse.hooks]]` handler, its `type` and the exact installed bridge path rather
than the presence of our marker block — but nothing this repository can assert proves the
*client* agrees. Only a live session does. Run this recipe whenever the emitted block or the
bridge changes, and run it nowhere near a checkout you care about:

1. **Take a disposable clone.** `git clone <this-repo> /tmp/codex-hook-smoke`, or any
   throwaway copy of a checkout carrying `pipeline.config.json`. Expect to delete it
   afterwards either way: if the wiring is broken this is the checkout that gets written to,
   and that is the evidence.
2. **Install and read the status.** `node scripts/write-protection.js install`, then
   `node scripts/write-protection.js status`. Codex must read `enforced`. Anything else
   names what is missing, and the session below would prove nothing until it is fixed.
3. **Mark the disposable checkout trusted**, exactly the way you would trust an ordinary
   project — the `[projects."…"]` entry in `config.toml`, or answering the client's own
   prompt on first use. Codex runs no hook at all in a project it does not trust, so a
   refusal from an untrusted checkout is not evidence about hooks.
4. **Start an ordinary session in it.** No flag that bypasses hook trust — in particular no
   `dangerously-bypass-hook-trust` and no dangerously-bypass-approvals variant. What is being
   measured is what a normal session can do, so a session run any other way answers a
   different question.
5. **Ask it to change a protected file with `apply_patch`** — replacing the contents of
   `runner/run.js` is the case that failed before. Ask for `apply_patch` by name so the
   attempt lands on the tool path under test rather than on the shell one.
6. **Read the two answers.** The session must be refused with the `write-protection:` text on
   its stderr, and `git status` in the disposable checkout must be clean afterwards. A clean
   tree with no refusal text is not a pass: it usually means the model chose a different tool
   path, so try again and name `apply_patch`. A modified `runner/run.js` is the failure this
   recipe exists to catch, whatever `status` said in step 2.
7. **Check the shell path too**, in the same session: a `Bash` write to `runner/run.js` must
   be refused, and read-only inspection such as `git status` or `cat runner/run.js` must
   still work. A guard that refuses everything is as unusable as one that refuses nothing.

Where no Codex client is available — a container, CI, a machine that has only Claude — the
deterministic half still holds: `tests/acceptance/repo-ak5/` executes the command the emitted
configuration names, against a disposable fixture checkout, and asserts both verdicts on both
tool paths. It skips the live session explicitly rather than passing quietly.

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
