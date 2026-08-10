# SETUP.md — Getting a New Person Running the Pipeline

This is the once-per-**person, per-machine** setup. It is the checklist form of DESIGN.md
§6 (environment and host prerequisites); when that section changes, this file changes with
it.

Three setup documents exist and they answer different questions. Read them in this order:

| File | Answers |
|---|---|
| **This file** | *My machine has never seen this pipeline. What do I install and how do I know it works?* — once per person |
| `ONBOARDING.md` | *I want the pipeline to work on project X.* — once per project, ever |
| `PLANNING.md` | *I want it to build a feature.* — every time, forever |

**What you have when you finish this file:** a machine that can run the pipeline, proven
by its own test suites, pointed at nothing yet. Onboarding a project is the next document.

Budget half a day for the first pass, most of it waiting on downloads and test suites.

---

## Part A — Install the tools (once per machine)

Everything below was built and proven on **Windows 11 with Docker Desktop**. Nothing in
the design requires Windows, but nothing else has been tried — if you are on a Mac or
Linux, expect to be the first, and say so before you start so someone can watch.

### A1. Docker Desktop

Install it and **leave it running**. This is what actually isolates each task: every task
gets its own container — a throwaway sealed box holding a fresh copy of the code — that
can reach three Anthropic addresses and nothing else on the internet.

The runner checks Docker is up before it does anything and stops immediately if it isn't.

### A2. Git, and specifically Git Bash

Install Git for Windows. It comes with **Git Bash**, a Unix-style terminal.

**Every command in this project's docs is run from Git Bash, never from WSL.** WSL is
Windows' built-in Linux; on the reference machine its Linux distro has no connection to
Docker Desktop, so Docker commands from there fail in confusing ways. Use Git Bash.
PowerShell is fine for git, but not for anything that runs a `.sh` script.

### A3. Node.js

Install a current LTS release. Node is the language the host-side runner is written in —
plain JavaScript with zero third-party packages, so there is nothing to `npm install`.

(The container's Node is pinned separately at 22.23.1 inside the image. Your host version
does not have to match it.)

### A4. The GitHub CLI (`gh`), authenticated

```bash
gh auth login
```

The pipeline hands work back as **pull requests**, and `gh` is what opens them. Log in as
yourself — the PRs will carry your name, which is correct: you approved the task and you
review the result.

You also need push access to whatever repositories you will point the pipeline at.

### A5. Beads (`bd`) — the task queue

```bash
npm install -g @beads/bd@1.1.0
```

Beads is the issue tracker the pipeline reads its work from. It stores issues in a small
database inside the repo rather than on a website.

**Pin the version to `1.1.0`** — that is what the container image carries, and matching
them keeps host and container behaviour identical. A newer `bd` has broken host scripts
before by changing its output format by one blank line.

### A6. The Claude Code CLI and your own token

Install the Claude Code CLI, then:

```bash
claude setup-token
```

This prints a long-lived token. Keep it — Part B puts it where the runner can find it.

**Each person needs their own Claude subscription and their own token.** The token is not
shareable and should not be. Every task the pipeline runs spends *your* usage allowance:
when you hit your limit, the run parks itself, waits for your window to reopen, and
carries on. Two people cannot run off one subscription without starving each other.

---

## Part B — Get the pipeline itself working (once per clone)

### B1. Clone this repository

```bash
git clone https://github.com/Chadleewalker/Multi-AgentPipelines.git
cd Multi-AgentPipelines
```

### B2. Put your token where the runner looks

```bash
echo 'CLAUDE_CODE_OAUTH_TOKEN=<paste the token from A6>' > .env.pipeline
```

`.env.pipeline` is **git-ignored** — it never gets committed and it must stay that way. The
token is handed to each container by name at launch and is never baked into an image.

### B3. Install the git hooks

```bash
bash scripts/install-hooks.sh
```

**Run this once per clone, on every machine, and don't skip it.** The issue database
travels on a separate git reference that a normal `git pull` does not fetch. Without these
hooks you pull the code, keep a *stale task queue*, and nothing warns you. This repo lost
its issues that way once already.

The hooks are installed on your machine only, never committed.

### B4. Get the task queue itself

```bash
bd ready
```

If that reports no database, initialise and then pull:

```bash
bd init
bd dolt pull
```

**Check what arrived before moving on:**

```bash
bd ready       # should list open issues
bd memories    # should list notes, not nothing
```

An empty `bd memories` is the failure to catch here. Those notes are exported into every
container as project memory; if the list is empty, every task silently runs with no
accumulated context and nothing anywhere reports an error. If it comes back empty, stop
and ask — don't work around it.

### B5. Build the base image

```bash
docker build -t pipeline-base:local docker/base
```

The base image is the sealed box every task runs in: Node, git, the Claude CLI and `bd`,
all at pinned versions, and **no credentials and no pipeline code**. The pipeline's own
scripts are mounted in fresh at run time, so changing them never means rebuilding this.

Then prove it is right:

```bash
bash scripts/test-base-image.sh
```

Expect every line to say `PASS`. This checks the pinned versions are actually the pinned
versions and that no credential ended up inside the image.

The second image — the network gatekeeper that blocks everything except the Anthropic
addresses — builds itself the first time a run needs it. You don't build it by hand.

---

## Part C — Prove it works before you trust it

Do not skip this part. The whole value of the pipeline is that you can leave it alone
overnight, and that is only worth anything if the scaffolding around it is provably
working on *your* machine.

### C1. The fast suites (seconds, no Docker)

```bash
bash scripts/test-changelog.sh
bash scripts/test-sanitize.sh
bash scripts/test-lock.sh
```

These read files and run plain Node. If they fail, something is wrong with the clone
itself, not with your Docker setup.

### C2. The full sweep (slow — allow an hour or two)

```bash
bash scripts/test-all.sh
```

This runs every suite in the repo, one at a time, and prints a summary table. It writes
per-suite logs under `runs/sweeps/<timestamp>/`.

Three things to know about it:

- **Never run it at the same time as anything else that uses Docker for this project.** It
  cleans up after each suite, and a live run's container looks exactly like something it
  should clean up. That collision once cost a session of debugging that blamed Docker.
- **A red suite is not always a broken pipeline.** Read the log before concluding anything.
- **If several `test-runner-*` suites go red at once**, check `.env.pipeline` first. Those
  suites don't call any model, but the runner refuses to start without a token, so a
  missing token makes them fail with realistic-looking but meaningless errors. The tell is
  that they report very few assertions rather than many failures.

### C3. The end-to-end pass — optional, and only if you'll develop the pipeline itself

`bash scripts/e2e.sh` drives three complete scenarios — a success, a failure, and an
attempted tamper — through real containers, the real sealed network, and live GitHub,
using scripted stand-ins instead of a real model so it costs nothing and always gives the
same answer.

It needs a **disposable private GitHub repo of your own** set up as a fixture, which is
real work: `scripts/test-fixture.sh` defines exactly what makes one valid, and
`bash scripts/test-fixture.sh` tells you whether yours qualifies. Then copy
`run.config.example.json` to `run.config.fixture.json` and point it at that repo.

If you are only going to *use* the pipeline on your own projects, skip this. If you are
going to *change* the pipeline, do it — it is the only thing that exercises the whole path
at once.

---

## Part D — Point it at a project

### D1. Onboard the project

Follow `ONBOARDING.md` end to end, from inside the project you want worked on. It covers
the GitHub remote, the frozen-test folder, the project's config file and image, its issue
database, and the rewrite of its instructions file so agents know they are running in a
sealed container.

If the project is older code rather than something scaffolded this month, do its Stage 0
assessment first. The question it asks is not "can this repo be configured?" — any repo
can — but "can a task in this repo be *verified* by a fast, deterministic test with no
network?" A repo that can't produce such a test doesn't fail loudly; it produces runs
nobody can interpret, which is worse.

### D2. Add the runner config, named after the project

```bash
cp run.config.example.json run.config.myproject.json
```

Then edit it: the path to the project on your disk, its remote URL, and its image name.

**Name the file after the project — never plain `run.config.json`.** The runner derives
that run's private network and gatekeeper names from the `<project>` part of the filename.
Two configs both called `run.config.json` share one network, so starting the second run
destroys the first run's route out.

These configs are **git-ignored**: they name a path on your disk and a remote that may be
private.

### D3. If you work on private things, add the publication denylist

```bash
cp .sanitize-denylist.example .sanitize-denylist
```

Then list the client names, project names and hosts that must never appear in this
repository's tracked files.

**This repository is public and is used on private work.** The rule that keeps both true:
it documents the *machinery*, never the *work done with it*. Worked examples say "the first
real project", never its name. `bash scripts/test-sanitize.sh` enforces the generic half
(paths, addresses, credentials) always, and this denylist enforces the naming half. The
denylist itself is git-ignored — committing a list of things you mustn't mention would
publish exactly what it protects — so it does not arrive with a clone. You add it.

Run `bash scripts/test-sanitize.sh` before you push anything to this repo.

### D4. Run a queue

```bash
node runner/run.js --config run.config.myproject.json
```

**One run per project at a time.** A second run against the same project is refused by
name before anything starts. A lock left behind by a run you killed is taken over
automatically by the next one — never delete it by hand.

---

## Part E — The rhythm from here on

Plan → run → review in the morning → merge or send back.

1. **Plan** (with you, interactive): follow `PLANNING.md`. You approve a plain-English
   "Done means" list; the tests get written *before any code exists* and then frozen.
2. **Run** (unattended): the command in D4. Walk away.
3. **Review** (with you): each finished task arrives as a pull request carrying the spec,
   a summary of what changed, and the verification evidence. Failed work arrives as a
   pushed branch with its full attempt history. The run report orders them by how much
   scrutiny each needs.
4. **Record your verdict**, one line per PR:

   ```bash
   node scripts/verdict.js record <issue-id> <merged|rejected> "<why>"
   node scripts/verdict.js pending    # anything still unjudged
   ```

   Merge-or-send-back is the one signal the pipeline cannot generate about itself, and it
   exists only for as long as you are looking at the PR. A green run that you rejected is
   the most valuable row in the record and the easiest one to lose.

Onboarding a project happens once, ever. Everything after that is planning sessions.

---

## Part F — The things that will cost you a day if nobody tells you

1. **Use Git Bash, not WSL.** Docker commands from WSL fail on the reference machine.
2. **A missing token makes six test suites lie to you.** They report plausible assertion
   failures rather than "no token". Check `.env.pipeline` before debugging anything else.
3. **Never run the test sweep while a real run is in flight.** A task container dying with
   no output and no explanation is almost always this, not Docker running out of memory.
   Check `docker ps` and `runs/locks/` before blaming Docker.
4. **A fresh clone does not carry the issue database automatically.** Step B3 and B4 are
   what fetch it. Skipping them gives you a stale queue and no warning.
5. **Test suites go stale silently.** Run `bash scripts/test-all.sh` after merging a batch
   of PRs, before an overnight run, and when picking up a branch you haven't touched in a
   while. One suite that nobody re-ran accumulated three separate bugs before anyone
   looked.
6. **Anything a container needs must be in the repository.** The container has no internet
   beyond Anthropic — no package installs, no documentation lookups. If an agent keeps
   failing because it didn't know an API, the answer is to vendor those docs into the repo,
   never to open the network.

---

## What to ask about rather than work around

Four rules exist because removing them makes the pipeline untrustworthy unattended, not
because they're conventions. If one of them is in your way, that is a conversation, not a
workaround:

- **Nothing during a run may change what "done" means.** A task that needs its spec changed
  is a result to report, not a problem to fix mid-run.
- **The thing that judges the work is a plain script, never an AI.** It reads the tests as
  they were frozen, not as they are now.
- **The container gets one credential and no route out.** Don't add network access to make
  something convenient — bake it into the image at planning time instead.
- **The approval points are the design, not friction.** You approve intent before a run and
  results after. Never route around one to save a step.

`CLAUDE.md` states these as hard rules with the full reasoning; `DESIGN.md` is the
authority behind all of it.
