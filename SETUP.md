# SETUP.md — Getting a New Person Running the Pipeline

Once per **person, per machine**. Budget half a day, most of it waiting on downloads and
test suites; under an hour of it is you typing.

Three setup documents, in order:

| File | Answers |
|---|---|
| **This file** | *My machine has never seen this pipeline.* — once per person |
| `ONBOARDING.md` | *I want the pipeline to work on project X.* — once per project, ever |
| `PLANNING.md` | *I want it to build a feature.* — every time, forever |

The reasoning behind any decision here lives in `DESIGN.md` (§6 for the environment) and
`docs/change-log.md`. This file is the checklist only.

**What you are signing up for:** the pipeline works through a queue of tasks unattended,
each in a locked-down container, and hands back pull requests. Your involvement is two
moments — a planning session before a run where you approve what "done" means, and a PR
review after. Nothing in between is interactive, and nothing that runs unattended can
change what "done" means.

---

## Part 0 — What whoever is bringing you in must supply

None of these can be self-served, and each fails late:

1. **Your own Claude Pro or Max subscription** — not a shared login. Every task spends the
   allowance of whoever's token is in `.env.pipeline`; two people on one subscription starve
   each other.
2. **Which GitHub account to use**, and write access to the target repos.
3. **The contents of `.sanitize-denylist`** — the private names that must never appear in
   this public repo. Git-ignored, so it cannot arrive with a clone. Without it the sanitize
   suite prints a `NOTE` and looks like a pass.
4. **Which projects are already onboarded, and which is yours.** Onboarding is once per
   project *ever* — redoing it is wasted work.
5. **A recent green sweep summary from a working machine**, to compare yours against.
6. **A seat at one planning session and one PR review** before running your own.

---

## Part A — Install the tools

Proven on **Windows 11 + Docker Desktop** only. Mac or Linux: you are the first, say so.

**You install three things by hand; Claude Code installs the rest.** Order is not
negotiable: **accounts → Node → Claude Code → everything else.**

### A1. Accounts

A Claude account with Pro or Max ([claude.ai](https://claude.ai)), and a GitHub account with
write access to your targets.

### A2. Node.js — by hand, because Claude Code is written in it

```powershell
winget install --id OpenJS.NodeJS.LTS --exact
```

Then **close and reopen the terminal**, or the next command reports "not recognised".

### A3. Claude Code — by hand, for the same reason

```powershell
npm install -g @anthropic-ai/claude-code
```

Run `claude` in any folder and sign in with the A1 account.

### A4. Let Claude Code install the rest

Start `claude` anywhere — you do not need the clone yet — and give it this:

> Install the tools I need, checking first what is already present, and tell me if any is
> already installed at a different version:
>
> - Git for Windows, including Git Bash
> - the GitHub CLI (gh)
> - Docker Desktop
> - Beads, pinned to exactly 1.1.0: npm install -g @beads/bd@1.1.0
>
> Use winget for the first three. Do not use WSL. Do not attempt any browser sign-in — list
> those for me to do myself.

Package ids, verified against `winget` 1.29: `Git.Git`, `GitHub.cli`, `Docker.DockerDesktop`.

Four rules:

1. **Approve installs one at a time.** You are letting a program install software; read each
   command. Some raise a Windows elevation prompt only you can click.
2. **Never paste a credential into a session.** Everything you type is sent to the model. The
   token goes in a file, by your hand, at B2.
3. **`bd` must be exactly 1.1.0.** Asked to "install beads" any agent fetches the newest, and
   a newer one has broken host scripts by changing its output by one blank line.
4. **Git Bash, never WSL** — say it in the prompt. This machine's WSL has no Docker Desktop
   integration, and Claude Code cannot know that unless told.

When it hands a command back to you, type `!` followed by the command to run it inside the
session, so it can read the error with you.

Three things it will not think to tell you:

- **Docker Desktop must be left running.** It is what isolates each task: a throwaway
  container that reaches three Anthropic addresses and nothing else. The runner checks it is
  up and stops if not. Its installer wants a reboot and may add its own WSL plumbing — both
  fine; rule 4 is about the terminal *you* type in.
- **Every `.sh` script in this project runs from Git Bash.** PowerShell is fine for `git` and
  the `winget` lines above, nothing else.
- **Do not rely on the `bd` inside the container image.** That fallback starts a container per
  call, deadlocks against the test suites, and gets killed at 900 seconds while erroring
  nowhere.

### A5. Tell git who you are

```bash
git config --global user.name "Your Name"
git config --global user.email "you@example.com"
```

This lands on every commit the pipeline makes for you.

### A6. Sign in to `gh` — yours, in a browser

```bash
gh auth login          # GitHub.com → HTTPS → browser
```

**If this machine has two GitHub logins, find out now which one you need.** A private repo
the active account cannot see reports **"Repository not found"**, identical to a typo.
`gh auth status` names it; `gh auth switch` changes it.

### A7. Your pipeline token — yours, and never shared

```bash
claude setup-token
```

A long-lived token, separate from the A3 sign-in. Keep it to copy once at B2. Do not paste it
into a session. One subscription per person: at your limit a run parks itself, waits for the
window to reopen, and carries on.

### A8. The harness plugin — optional, and not a clone

A companion Claude Code plugin adds `/pipeline-onboard`, `/scaffold`, `/design`, `/review`
and `/harness-check`. It lives in a **separate, private repository**, so it is not named
here — this document is public and the plugin repository is not. If you have access, ask
the person who gave you this repo for the one marketplace line, then, inside `claude`:

```
/plugin marketplace add <the line you were given>
/plugin install harness-pipeline
```

Claude Code fetches and updates it; it lives under `~/.claude/plugins`, not your projects
folder. **Nothing in this document requires it** — if you have no access, skip A8 and
carry on at A9; every instruction here works without it. It carries its own version, and
if a plugin command and this document disagree, this document and `DESIGN.md` win.

### A9. `/profile` — after the clone, and do not skip it

Start `claude` inside the clone and run `/profile`. It interviews you and writes
`~/.claude/CLAUDE.md`, which tells every agent on this machine how to pitch things to you.
Skipping it breaks nothing loudly — you just get months of explanations at the wrong level.
Per person, not per project.

---

## Part B — Get the pipeline working (once per clone)

Claude Code can drive all of this except B2, and is worth using for B4, whose failure mode is
a command that succeeds and produces nothing.

### B1. Clone, then restart `claude` inside it

```bash
git clone https://github.com/Chadleewalker/Multi-AgentPipelines.git
cd Multi-AgentPipelines
```

Restart the session in the clone so it picks up this repo's `CLAUDE.md`.

### B2. Your token — by hand, not through Claude Code

```bash
echo 'CLAUDE_CODE_OAUTH_TOKEN=<token from A7>' > .env.pipeline
```

Git-ignored, and must stay that way. Passed to containers by name at launch, never baked into
an image.

### B3. Install the git hooks

```bash
bash scripts/install-hooks.sh
```

**Do not skip this.** The issue database travels on a git reference `git pull` does not fetch,
so without the hooks you pull code and keep a stale task queue with no warning. This repo lost
its issues that way once. Host-only, never committed. If you ever update the code by some
route other than `git pull`, run `bd dolt pull` by hand.

### B4. Get the task queue

```bash
bd ready       # if it reports no database:  bd init && bd dolt pull
bd stats       # how much is open, blocked, closed
bd memories    # must list notes, not nothing
```

**An empty `bd memories` is the failure to catch.** Those notes are exported into every
container as project memory; empty means every task runs with no context and nothing reports
it. Stop and ask. (`bd ready` returning nothing is different and may be correct — `bd stats`
tells you which.)

### B5. Build the base image

```bash
docker build -t pipeline-base:local docker/base
bash scripts/test-base-image.sh      # expect every line PASS
```

Node, git, the Claude CLI and `bd` at pinned versions, with no credentials and no pipeline
code. The network gatekeeper image builds itself on first run.

### B6. `cp .worktree-carry.example .worktree-carry`

Thirty seconds now; **ignore the rest of this until you run two agent sessions at once.** Then:
each session gets its own git worktree — its own folder, its own branch, one shared history
(`node scripts/worktree.js new <name>`, `list`, `remove`). Three sessions in one folder are
three agents typing into one set of files. `.worktree-carry` names which git-ignored files a
new worktree is given.

---

## Part C — Prove it works before you trust it

The value of the pipeline is leaving it alone overnight, which is worth nothing unless the
scaffolding is provably working on *your* machine.

```bash
bash scripts/test-changelog.sh      # seconds, no Docker
bash scripts/test-sanitize.sh
bash scripts/test-lock.sh

bash scripts/test-all.sh --skip e2e --timeout 300     # the full sweep
```

A healthy sweep is green in roughly eight to twelve minutes and writes per-suite logs under
`runs/sweeps/<timestamp>/`. There are 43 suites (`ls scripts/test-*.sh | wc -l` — the sweep
finds them by glob, so the number grows on its own). A sweep taking an hour is suites
*hanging* and being killed, not doing more work; `--timeout 300` caps that loss and
`--skip e2e` drops the one suite needing a fixture repo.

- **Never run the sweep while a real run is in flight.** It cleans up after each suite, and a
  live run's container looks exactly like something to clean up.
- **If several `test-runner-*` suites go red at once, check `.env.pipeline` first.** They call
  no model, but the runner refuses to start without a token, so a missing one produces
  realistic-looking nonsense. The tell is few assertions, not many failures.
- **`TIMEOUT` and `FAIL` are different facts.** A timed-out suite judged nothing.
- **Compare against the known-good summary from Part 0** before concluding anything is yours.
- **Hand a red suite's log to Claude Code** — reading 900 lines for the one assertion that
  matters is what it is good at. It does not get to *decide*: the exit code is the verdict, and
  "probably environmental" is not evidence.

`bash scripts/e2e.sh` drives three full scenarios through real containers with scripted
stand-ins instead of a model. It needs a disposable private fixture repo
(`bash scripts/test-fixture.sh` says whether yours qualifies). Skip it unless you are going to
change the pipeline itself.

---

## Part D — Point it at a project

1. **Onboard it** — do not work the checklist by hand. Start `claude` in the project and tell
   it to follow this repo's `ONBOARDING.md`, or run `/pipeline-onboard`. Once per project,
   ever. Existing codebases do its Stage 0 assessment first: the question is not "can this be
   configured" but "can a task here be verified by a fast, deterministic test with no
   network?"
2. **Add the runner config**: `cp run.config.example.json run.config.myproject.json`, then set
   the project's path, remote and image name. **Name it after the project, never plain
   `run.config.json`** — the private network name comes from that segment, so two configs
   sharing a name means the second run destroys the first one's route out. Git-ignored.
   Three fields worth knowing: **`proxyPort` is not tunable** (the gatekeeper hard-codes 3128
   and nothing validates your file against it — changing it kills preflight with no hint);
   `feedIdleGraceMinutes: 0` means the live queue feed is off; `concurrency` has no ceiling,
   so start at 1. A fourth if you ever hit it: `allowHalfProven: false` is the default and
   means the runner refuses a suite the freeze gate found red with no probe supplied — set it
   to `true` only if you accept dispatching suites whose green side has never been seen
   (§4.12's third admission rule).
3. **`cp .sanitize-denylist.example .sanitize-denylist`** if you touch private work, then list
   the names that must never appear here. This repo is public and is used on private work; it
   documents the machinery, never the work. Run `bash scripts/test-sanitize.sh` before you push.
4. **Run it**: `node runner/run.js --config run.config.myproject.json`. One run per project at
   a time; a second is refused by name, and a lock left by a killed run is taken over
   automatically — never delete it by hand.

---

## Part E — The rhythm from here on

Before your first planning session: run `/profile`, open
[`docs/pipeline-map.built.html`](docs/pipeline-map.built.html) (the whole system on one page —
**the `.built.html` copy**, not `pipeline-map.html`, which draws no diagrams by itself), and
read `CLAUDE.md`, `PLANNING.md`, and `DESIGN.md` §4.11 and §3.1. The change log is
`docs/change-log.md`, not `DESIGN.md`.

**This is the whole method and it has not changed.** You open `claude` in this repo, say which
project to work on, plan with it, and it launches the run. There is no newer front end: the
live queue feed, concurrency above 1, and worktrees are all off or irrelevant by default.

Then: **plan → run → review in the morning → merge or send back.**

1. **Plan** (interactive): follow `PLANNING.md`. You approve a plain-English "Done means"
   list; tests are written before any code exists, then frozen. **Then push the branch.** A
   frozen suite that exists only on your disk is never dispatched — the task comes back
   `undispatchable`, which looks like nothing happened.
2. **Run** (unattended): the command above. Walk away. `node scripts/dashboard.js` in a second
   terminal serves a read-only view on `127.0.0.1`.
3. **Review**: each finished task is a PR carrying the spec, a summary and the verification
   evidence; failed work is a pushed branch with its full attempt history. The PRs are
   siblings, not a stack.
4. **Record your verdict**, one line per PR:

   ```bash
   node scripts/verdict.js record <issue-id> <merged|rejected> "<why>"
   node scripts/verdict.js pending
   ```

   Merge-or-send-back is the one signal the pipeline cannot generate about itself, and it
   exists only while you are looking at the PR.

Adding a feature later is a planning session, not a re-onboarding.

---

## Part F — The things that will cost you a day

1. **Git Bash, not WSL.** Docker commands from WSL fail on the reference machine.
2. **A missing token makes six suites lie to you.** Check `.env.pipeline` before debugging
   anything else.
3. **Never sweep while a run is in flight.** A container dying with no output is almost always
   this, not Docker running out of memory. Check `docker ps` and `runs/locks/`.
4. **A fresh clone does not carry the issue database.** B3 and B4 are what fetch it.
5. **Suites go stale silently.** Sweep after merging a batch of PRs, before an overnight run,
   and when picking up a cold branch. One suite nobody re-ran accumulated three bugs.
6. **Anything a container needs must be in the repository.** No internet beyond Anthropic. If
   an agent keeps failing for want of an API reference, vendor the docs in — never open the
   network.
7. **"Repository not found" usually means the wrong GitHub account is active**, not a typo.
8. **Read `docs/pipeline-map.built.html`**, not `pipeline-map.html`.
9. **A frozen suite you committed but did not push does not run.** Confirm it is on the remote:

   ```bash
   git ls-tree -d --name-only origin/<default-branch> -- tests/acceptance/<issue-id>
   ```

   Silence means it is not there. **Do not use `scripts/batch.js show` for this** — it predicts
   the queue from the type filter only, does not know about the dispatch gate, and reports an
   unpushed task as `ready`.
10. **`proxyPort` is not tunable.** See Part D2.
11. **Launch runs from the main checkout, never a worktree.** A worktree gets its own
    git-ignored `runs/`, so its own lock — and the lock is the only thing stopping two runners
    draining one queue.
12. **The run lock is per machine, not per project.** It cannot see another person's computer.
    Two people pointing the pipeline at one project each drain their own copy of the queue and
    both push branches for the same work, with nothing reporting it. **One project has one
    owner** — settle that before you start.
13. **Claude Code can install your tools; it must not hold your credentials.**

---

## What to ask about rather than work around

Four rules exist because removing them makes the pipeline untrustworthy unattended. If one is
in your way, that is a conversation, not a workaround:

- **Nothing during a run may change what "done" means.** A task needing its spec changed is a
  result to report, not a problem to fix mid-run.
- **The thing that judges the work is a plain script, never an AI.** It reads the tests as
  frozen, not as they are now.
- **The container gets one credential and no route out.** Bake dependencies into the image at
  planning time instead.
- **The approval points are the design, not friction.** You approve intent before a run and
  results after. Never route around one.

`CLAUDE.md` states these as hard rules with full reasoning; `DESIGN.md` is the authority.
