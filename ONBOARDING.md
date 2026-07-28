# ONBOARDING.md — Making a Project Pipeline-Ready

This is the once-per-project setup that turns any repo — freshly scaffolded or years
old — into a valid pipeline target. It is the checklist form of DESIGN.md §3.4 and §6;
when those sections change, this file changes with them. If you wrap it in a slash command
or a script, this file stays the source of truth and the wrapper follows it.

Everything here happens interactively on the host, with the user. Run it once per
project; PLANNING.md's per-session prerequisites then just verify it was done.

## Starting from nothing — the whole path for a brand-new project

Four stages, in order. Each is interactive, each happens once except the last:

1. **Create the project** — however you normally scaffold one. The language and main
   technologies (framework, data storage, hosting — whatever the project actually has)
   are chosen together — Claude lays out the options with a recommendation, the user
   decides — then Claude writes the project's `CLAUDE.md` and gets a spec approved
   before building anything. If you know at that point that the pipeline will work on
   this project, stage 3 can happen in the same sitting. An existing project skips this
   stage entirely.
2. **Write the design doc** — for a project the pipeline will seriously develop, a
   `DESIGN.md` in its repo: intent, architecture, decisions and why, amendable only via
   its change log (§3.1–3.2 of this pipeline's own DESIGN.md describe the session:
   bounded interview, critics, dry-run decomposition as the readiness test). Identify
   each change-log row by a kebab-case slug — the issue id for a row a task produced, a
   short descriptive name for a row a planning session produced — never by a version
   number, which parallel agents cannot assign uniquely (§12). Small
   projects can live on the scaffold's `SPEC.md` alone and enter planning per-task —
   the doc layer is for work big enough to decompose.
3. **Onboard** — the checklist below: GitHub remote, integration branch recorded,
   frozen-test home, config, image, task database, container-aware `CLAUDE.md`. Once,
   ever.
4. **Plan and run, forever** — every feature from here on is a PLANNING.md session and
   an autonomous run. See "the life of an onboarded project" at the end of this file.

Stages 1–2 can also run in the other order (design first, scaffold after) — what
matters is that both exist before planning tries to decompose anything.

## Before starting

- The pipeline's base image is built (`docker/base/`; check `scripts/test-base-image.sh`).
- Docker Desktop is running; `gh` is authenticated; Git Bash is the shell for anything
  Docker (never WSL — known issue).

## The Checklist

### 1. Git and GitHub
- [ ] The project is a git repo with a **GitHub remote** (§6 — review happens as PRs).
      If there is no remote, create one with `gh repo create` — **ask the user first**.
- [ ] Determine the project's real **integration branch** — ask git
      (`git remote show origin` → HEAD branch), never assume. If it isn't `main`,
      it MUST be recorded as `defaultBranch` in step 3 (§3.4 — the shadow-trial project's `master`
      broke three components before this rule existed).
- [ ] The repo has a `.gitattributes` containing at least `*.sh text eol=lf`
      (shell scripts run inside Linux containers; a CRLF checkout on Windows breaks
      them and can read as tampering).

### 2. The frozen-test home
- [ ] Create `tests/acceptance/` with a short README stating the freeze rules: tests
      land here during planning (PLANNING.md step 6), are committed to the integration
      branch before a run, and are diffed against the fork point by the verifier —
      any change during a run, by anyone, is the "tampered" outcome (§4.4).

### 3. `pipeline.config.json` (§3.4)
- [ ] Write it in the repo root:
      - `verifyCommand` — how the verifier runs one task's acceptance tests (invoked
        as `<verifyCommand> tests/acceptance/<issue-id>/`).
      - `regressionCommand` (optional) — the project's standard suite, if one exists.
      - `defaultBranch` (required whenever it isn't `main`).
      - `frozenPaths` (optional) — anything `verifyCommand` executes from the repo
        (helper scripts, runner configs) beyond `tests/acceptance/`.
      - `dependencies` — package lists keyed by package manager
        (e.g. `{"npm": ["express@^4.19.2"]}`). Never install commands.

### 4. The per-project image (§6)
- [ ] Write the thin `Dockerfile` beside the config: `FROM` the pinned base image,
      plus exactly what the `dependencies` manifest declares — **cross-check them;
      they must not drift** (§3.4).
- [ ] Build it (`pipeline-<project>:local`) — **ask the user before building**, then
      confirm the image exists. The runner never builds; it only asserts (§3.4).

### 5. Beads
- [ ] `bd init` in the host working copy (no host `bd`? use the base-image fallback,
      as `runner/bd.js` does). The host runner is the sole Beads writer during runs
      (§4.10); interactive sessions use `bd remember` / `bd prime` for memory (§3.6).

### 6. The project's `CLAUDE.md` — rewrite for the pipeline
The project's instructions ride into every container (fresh clone), so they must tell
the truth about where the agent is running:
- [ ] **Keep any `@`-import of shared house rules pointing at a host-local path** — it
      resolves on the host and silently no-ops in containers, which is expected. Note
      that anything the container genuinely needs must live *in the repo*: a fresh clone
      is the only guaranteed container input (§4.10).
- [ ] **Spec authority:** if the project was scaffolded, its `CLAUDE.md` points at
      `SPEC.md`. For a pipeline project, task specs are Beads issues and the frozen
      tests are the proof — say so. Keep `SPEC.md`/design docs for intent if the
      project has them, but the pipeline verifies against `tests/acceptance/`, and
      the instructions must not send agents hunting for the wrong file.
- [ ] **Replace** any section describing a different container workflow with the one
      below. This matters most when the old one says agents push straight to the
      integration branch — the exact opposite of the pipeline's git isolation.
- [ ] **Remove hooks:** delete the `hooks` entry from `.claude/settings.json` and the
      `.claude/hooks/` folder. Scaffolded format hooks call `npx --yes prettier`,
      which tries the npm registry on every edit — blocked by the closed network.
      Formatting for pipeline projects is a verifier/regression concern or nothing.

Copy this section in (adjust nothing but the project name):

```markdown
### Working inside the pipeline container (read this when you are the coding agent in a run)
- This is a locked-down Docker container: the network reaches Anthropic endpoints only.
  No package installs, no web lookups — everything you need is in this repo, the issue
  file, or the memory file.
- Your task is `/workspace/.run/issue.md`; project memory is `/workspace/.run/memory.md`.
  Both are read-only exports — use them, don't edit them.
- NEVER touch `tests/acceptance/` or any path in `pipeline.config.json`'s `frozenPaths`.
  The verifier diffs them against the fork point; any change — even whitespace — ends
  the task as "tampered".
- The frozen verifier decides pass/fail, not you. Run tests while you work, but the
  authoritative check runs after you exit.
- You cannot push (no credentials, no git-host network). Commit locally at every
  meaningful boundary; the host pushes your branch after the container exits.
- Insights worth keeping across tasks go in the status file's memory notes as the run
  scaffolding instructs — never in ad-hoc memory files.
- If you conclude the frozen spec or its tests are themselves wrong, say so with
  `node /pipeline/status.js concern "<what is wrong and why>"` (§3.7). That is a
  first-class result, not a failure — but it is evidence only: it cannot change your
  outcome, so keep doing the best work the spec allows rather than contorting correct
  code to satisfy a gate you believe is broken.
```

### 7. Knowledge the container will need (§4.8)
- [ ] Vendor docs for critical dependencies into `docs/` — the container cannot look
      anything up. Recurring "didn't know the API" failures later mean more vendoring,
      not opening the network.

### 8. Pipeline-side wiring
- [ ] Add `run.config.<project>.json` in this repo (copy `run.config.example.json`):
      target repo path and remote, image name, network/proxy names, wall-clock budget.
      These are **git-ignored** — they name a path on your disk and a remote that may be
      private, so only the example template is committed.
- [ ] If this pipeline repo is public, add `.sanitize-denylist` (copy
      `.sanitize-denylist.example`): the private project names, hosts and clients that must
      never appear in the tracked tree. Also **git-ignored**, because committing the list of
      things you must not mention would publish exactly what it protects — so it does not
      travel with a clone. Put it on the machines that actually host the private work, since
      those are the only ones where such a name can get written into the repo; a machine
      that has never seen a project cannot leak it. `bash scripts/test-sanitize.sh` enforces
      it, and where the file is absent it still runs every generic path, address and
      credential check and prints a `NOTE` saying the name checks were skipped.
- [ ] `bash scripts/install-hooks.sh` — once per clone, on every machine. Issues live in
      `refs/dolt/data`, which `git pull` does **not** fetch, so without this a second
      machine pulls the code and keeps a stale task queue with nothing to warn it. The
      script installs bd's hooks host-only (`.beads/hooks/`, git-ignored, reached by a
      local `core.hooksPath` that is never committed) and appends the `bd dolt pull` that
      bd's own `post-merge` does not do — bd's handles JSONL import only, and skips even
      that once `sync.remote` is set. Hooks are deliberately **not** committed: this repo
      is a target of its own pipeline, and committed hooks would land in a task container
      that has neither `bd` nor network. Set `BD_SKIP_AUTO_PULL=1` to skip a pull once.

### 9. Final sanity pass
- [ ] `pipeline.config.json` present and complete; `defaultBranch` correct.
- [ ] `tests/acceptance/` committed and pushed on the integration branch.
- [ ] Per-project image exists (`docker images`).
- [ ] `bd ready` runs against the working copy.
- [ ] `CLAUDE.md` carries the container section; no rival container-workflow section,
      no hooks.
- [ ] Everything committed and pushed — the container clones from the **remote**
      (§4.2); anything only on the local disk does not exist as far as a run is
      concerned.

## After onboarding — the life of an onboarded project

Onboarding is once, ever, per project — like wiring a house: run the electricity once,
then just plug things in. Nothing above is about *what* gets built; it only makes the
repo a place the pipeline can operate. You never redo it.

**Adding features later is a planning session, not a re-onboarding.** Every time you
want something new — next week, next year — open Claude in the project and follow
PLANNING.md: describe it, approve the "Done means" list, tests are written and frozen
for that task, the task joins the queue, the runner does it. Each session adds new
frozen tests in a new `tests/acceptance/<issue-id>/` subfolder; old ones stay put as
the permanent record of past promises.

**The one case that touches the plumbing again:** a new feature needing a new
ingredient (a package the project has never used). Containers can't download anything
mid-run, so that planning session also updates the `dependencies` manifest and the
Dockerfile and rebuilds the image — steps 3–4 above, reached through PLANNING.md
step 7. Minutes of work, and only when the ingredient list actually changes.

The steady rhythm is: **plan → run → review PRs in the morning → merge or send back** —
and "send back" is itself just the next planning session.
