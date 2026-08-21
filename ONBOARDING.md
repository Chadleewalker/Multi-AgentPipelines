# ONBOARDING.md — Making a Project Pipeline-Ready

This is the once-per-project setup that turns any repo — freshly scaffolded or years
old — into a valid pipeline target. It is the checklist form of DESIGN.md §3.4 and §6;
when those sections change, this file changes with them. If you wrap it in a slash command
or a script, this file stays the source of truth and the wrapper follows it.

Everything here happens interactively on the host, with the user. Run it once per
project; PLANNING.md's per-session prerequisites then just verify it was done.

The wrapper that exists today is the harness plugin's `pipeline-onboard` command, run from
inside the target project: it locates this repo, reads this file, and follows it. That is
the whole contract — everything a wrapper needs to know lives here, which is why the
command has stayed correct through pipeline changes that would have invalidated a copy.
Following this file by hand is equally valid. Keep new material **in this file** rather
than in a wrapper, so every entry point inherits it (change-log row `adoption-assessment`).

## Starting from nothing — the whole path for a brand-new project

Four stages, in order. Each is interactive, each happens once except the last:

1. **Make the empty repo, then write the design doc.** The repo comes first and costs
   nothing to make: a folder and `git init`, no language, no template, no files. **That is
   not a decision, which is why it does not wait for the design** — the design doc has to
   live somewhere, and it is the project's own `DESIGN.md`, in the project's own repo, from
   the first draft. Choosing the *stack* is the decision, and that is what waits (stage 2,
   and change-log rows `design-before-scaffold` and `empty-repo-first`). A GitHub remote can
   wait for stage 3; nothing about the design session needs one.

   Then the doc itself — for a project the pipeline will seriously develop, a
   `DESIGN.md` in its repo: intent, architecture, decisions and why, amendable only via
   its change log. **`docs/DESIGN-GUIDE.md` in this repo is how**: the sections one needs
   and how each fails without it, and the six-question interview — shown to the user in
   full before the first question is asked (change-log row `design-interview-questions`).
   §3.1–3.2 of this pipeline's own DESIGN.md describe the same session from the process
   side: interview, critics, dry-run decomposition as the readiness test. Identify
   each change-log row by a kebab-case slug — the issue id for a row a task produced, a
   short descriptive name for a row a planning session produced — never by a version
   number, which parallel agents cannot assign uniquely (§12). Small
   projects skip this stage and live on the scaffold's `SPEC.md` alone, entering planning
   per-task — the doc layer is for work big enough to decompose. An existing project that
   never had a design doc is a separate case: see "if the verdict calls for a design doc"
   below, and do not reverse-engineer one.
2. **Create the project** — however you normally scaffold one. The language and main
   technologies (framework, data storage, hosting — whatever the project actually has)
   are chosen together — Claude lays out the options with a recommendation, the user
   decides — then Claude writes the project's `CLAUDE.md` and gets a spec approved
   before building anything. Where stage 1 happened, the stack is **chosen against the
   design doc** and its decisions are recorded there, not invented here. If you know at
   this point that the pipeline will work on this project, stage 3 can happen in the same
   sitting. An existing project skips this stage entirely.
3. **Onboard** — the checklist below: GitHub remote, integration branch recorded,
   frozen-test home, config, image, task database, container-aware `CLAUDE.md`. Once,
   ever.
4. **Plan and run, forever** — every feature from here on is a PLANNING.md session and
   an autonomous run. See "the life of an onboarded project" at the end of this file.

**The design doc comes first, and this order is the decided one** (change-log row
`design-before-scaffold`). Scaffolding chooses the language and main technologies, which is
the design interview's question 6 — *what has already been decided, and is each item forced
or preferred* — so scaffolding first answers question 6 before questions 1 to 5 have been
asked. The cost is not that the stack turns out wrong; it usually does not. The cost is that
the design is then built around a stack nobody argued for, and the stack is recorded as a
constraint when it was a preference — which is the one distinction the doc exists to keep
straight, because a constraint is never revisited and a preference is.

Scaffold first only where stage 1 is being skipped anyway: a project small enough to live on
`SPEC.md` and enter planning per task. What still matters in every case is that whatever
exists — design doc or `SPEC.md` — exists before planning tries to decompose anything.

## Stage 0 — read the ground (existing codebases only)

Skip this for a repo scaffolded into shape minutes ago; the answers are all trivially yes.
Do it for anything written before this way of working, because the checklist below assumes
a project someone just created, and on an old codebase the interesting question is not
whether the repo can be *configured* as a target — it always can — but whether it can be
**verified**. The pipeline's only judgment mechanism is a frozen test run in a sealed
container (§4.4), so a repo that cannot produce such a test does not fail loudly. It
produces runs nobody can interpret, which is worse than no runs at all.

Assess read-only, changing nothing, across five dimensions. `docs/readiness-probes.md`
holds the concrete commands; report **evidence, not adjectives** — "the suite takes 6m40s
and 23 of 88 tests open a socket", never "test coverage is weak".

1. **Verifiability — the go/no-go.** For a typical task, can a new test be written that is
   fast, deterministic, and runs with no network, no live database and no shared state?
   Nothing else on this list compensates for a bad answer here.
2. **Coupling versus one-issue-one-PR.** Every task clones fresh from the canonical remote
   (§4.2), so tasks in a batch never see each other's work. A repo whose commits routinely
   touch dozens of files yields a morning of merge conflicts instead of a morning of review.
3. **Closed-network fitness.** Everything the build and tests need must be declarable in
   `dependencies` and baked into the image (§4.8). Install-time network access is the thing
   to hunt for.
4. **Knowledge legibility.** The container agent cannot look anything up. Undocumented
   invariants are what an agent "cleans up"; stale documentation is worse than none, because
   a sealed agent will follow it.
5. **Git and host readiness.** Remote, real integration branch, `.gitattributes`, clean tree.

Write the verdict where it belongs to — a page in the **target** repo, never in this one,
which is public and used on private work. Land on one of three, and say which plainly:

- **Ready** — go to the checklist.
- **Ready for a narrow beachhead** — the usual answer for old code. Still go to the
  checklist. Onboarding is repo-wide and has no partial form; what gets staged is the
  **task queue**, not the onboarding. Name the module with existing seams and the first
  few tasks, and prefer additive work over refactors, because a clean new surface is what
  a clean new test needs.
- **Needs seams first** — onboarding will succeed and the runs will be uninterpretable.
  Characterization tests ("pin the current behavior of X") are legitimate pipeline work
  once onboarded, so this is rarely a reason to stop — but say what would move it.

**The assessment is advice and cannot refuse a repo.** The user reads it and decides. A
judgment that blocks work is the failure mode hard rule 5 exists to prevent, and this one
stays advisory in the same spirit.

If the verdict calls for a design doc the project never had, do **not** reverse-engineer
the architecture — the code describes itself and the container agent can read all of it.
Capture only what code cannot say: invariants and why they exist, decisions and rejected
alternatives, hazards, and intent. Then let it grow one planning session at a time; the
coverage that matters is of the area about to be tasked out, not of the whole system.

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

### 2. The frozen-test home, the idea inbox and the thread directory
- [ ] Create `tests/acceptance/` with a short README stating the freeze rules: tests
      land here during planning (PLANNING.md step 6), are committed to the integration
      branch before a run, and are diffed against the fork point by the verifier —
      any change during a run, by anyone, is the "tampered" outcome (§4.4).
- [ ] Create `tests/acceptance/_control/` holding **one trivially-passing test** in the
      project's own test language (a script that exits 0 and asserts nothing). This is the
      freeze gate's control (§3.2, move 1): before a spec is frozen its tests must be **red**,
      but a suite that cannot load exits non-zero exactly like a real assertion failure, so
      the gate runs the verify command against this directory too and only trusts a red when
      the control is green. **It must not test anything** — anything it asserted could break
      for reasons unrelated to the harness, and a control that can fail for its own reasons is
      not a control. An empty directory cannot do the job: a good runner is *supposed* to fail
      on "no test files found", so the gate would be unable to discriminate on exactly the
      projects it works best for.
- [ ] Create `docs/IDEAS.md` — the project's own idea inbox. Copy the structure from
      this pipeline repo's `docs/IDEAS.md`: a flat list of parked "this should probably
      become a design someday" notes, plus **Promoted** and **Dropped** tables. It costs
      nothing to add to and commits to nothing; PLANNING.md step 0 reads it for
      candidates.
      **Each project keeps its own** — ideas about a target project must never be filed
      in the pipeline repo, which is public and documents the machinery, never the work
      done with it. This is the same boundary that makes `run.config.<project>.json`
      git-ignored there.
- [ ] Create `docs/threads/` with a copy of this pipeline repo's `docs/threads/README.md`
      — the durable identity file an idea thread gets from its first exchange (§3.8). One
      file per thread being worked, `docs/threads/<slug>.md`, undated, with status in its
      header; the session working it becomes disposable, so a fresh session picks the
      thread up by reading one file. Nothing in the runner reads this directory and no
      thread file is a Beads issue. **Each project keeps its own**, for the same boundary
      as the idea inbox above — a thread about this project must never be filed in the
      public pipeline repo.

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
- [ ] **Run this after step 1, never before it.** Beads takes its sync remote from the git
      remote *at init time*: with no `origin` present it initializes without one — silently,
      and permanently as far as any later command will tell you — leaving a task queue that
      cannot sync between machines. The order in this checklist is the fix; the risk is
      running `bd init` early to get it out of the way. Don't.

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
- [ ] **Remove hooks — from the *tracked* tree, not from your machine.** Move the `hooks`
      entry out of `.claude/settings.json` into `.claude/settings.local.json` (git-ignored),
      and untrack `.claude/hooks/` and `.codex/hooks.json` while leaving them on disk.
      Two reasons they cannot ship: scaffolded format hooks call `npx --yes prettier`,
      which tries the npm registry on every edit — blocked by the closed network — and
      `bd`'s own hooks call `bd`, which is not installed in a task container at all.
      Formatting for pipeline projects is a verifier/regression concern or nothing.
      **Expect this one to come back.** `bd` rewrites `.claude/settings.json` whenever it
      re-initialises, and in this repo the deleted SessionStart hook returned in a later
      commit and went unnoticed for weeks. `scripts/test-agent-hooks.sh` is what catches
      the recurrence; a target project that wants the same guard can copy it.

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
      target repo path and remote, image name, wall-clock budget.
      These are **git-ignored** — they name a path on your disk and a remote that may be
      private, so only the example template is committed.
      **Name the file after the project, not `run.config.json`**: the task network and the
      allowlist proxy are per project, and the runner derives both names from that
      `<project>` segment when the config gives none (change-log row `repo-jur`). Two
      projects whose configs are both called `run.config.json` share one network and one
      sidecar, so starting the second run destroys the first run's route to Anthropic.
      Set `network` / `proxyName` explicitly only if you want particular names.
      **One config per target repo.** A run locks its target repo before any other gate,
      so a second config aimed at the same repo is refused by name rather than draining
      the same queue twice (change-log row `repo-os9`). The lock keys on the canonical
      path, so a trailing separator or forward-vs-back slashes do not buy you a second
      identity — and a lock left behind by a killed run is taken over by the next one,
      never cleared by hand.
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

One line ends each review, per PR (DESIGN.md §5, change-log row `repo-1ie`):

```bash
node scripts/verdict.js record <issue-id> <merged|rejected> "<why>"
node scripts/verdict.js pending    # anything still unjudged, newest run first
```

Merge-or-send-back is the one signal the pipeline cannot generate about itself, and it
exists for exactly as long as you are looking at the PR. The record lands beside that
task's other artifacts under the git-ignored `runs/` tree — host-only, like everything
else that names the work — and changes nothing: it is evidence, never a gate.
