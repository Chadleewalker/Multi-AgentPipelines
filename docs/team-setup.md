# Team Setup — getting a new person running the pipeline

DRAFT for review. This is the once-per-person, once-per-PC checklist. It assumes a
Windows PC and no prior experience with coding agents. ONBOARDING.md is the *project*
checklist; this is the *person* checklist — do this first, once, then ONBOARDING.md
for each project you bring in.

## What you're signing up for (read this first)

The pipeline is a system that works through a queue of development tasks overnight,
each inside a locked-down container, and hands back pull requests for you to review.
Your involvement has exactly two interactive moments:

- **Before a run** — a planning session with Claude Code (an AI assistant that runs in
  your terminal) where you and it agree on what "done" means for each task. That
  definition is frozen before anything runs.
- **After a run** — reviewing the pull requests it produced, like any other code review.

Nothing in between is interactive, and nothing that runs overnight can change what
"done" means. You approve the *what*; the machinery owns the *how*.

Setting a project up in the first place (section 5) is also interactive — a few
one-time sessions where Claude Code drives and you decide. After that, every feature
is just the two moments above.

## 1. Accounts (before touching the PC)

- [ ] **A Claude account with a Pro or Max subscription** ([claude.ai](https://claude.ai)).
      The pipeline authenticates with a personal subscription token — one per person,
      never shared.
- [ ] **A GitHub account with write access to the target repositories.** Results come
      back as pull requests; no repo access means no way to receive work.

## 2. Install, in this order (once per PC)

Each installer is a normal "download, next, next, finish" unless noted.

- [ ] **Git for Windows** ([git-scm.com](https://git-scm.com)). Accept the defaults.
      This also installs **Git Bash** — the terminal you'll use for everything
      pipeline-related. **Never use WSL** (a Linux-inside-Windows terminal some guides
      suggest) — it can't reach Docker Desktop here and things fail confusingly.
- [ ] Tell git who you are (in Git Bash):
      `git config --global user.name "Your Name"` and
      `git config --global user.email "you@example.com"` (your real work email).
- [ ] **Docker Desktop** ([docker.com](https://www.docker.com/products/docker-desktop)).
      This is what runs the locked-down containers. It may install its own WSL plumbing
      during setup — that's fine and expected; the rule above is about which *terminal*
      you type in, not what Docker uses internally. Docker Desktop must be **open and
      running** whenever the pipeline runs — the runner checks and refuses otherwise.
- [ ] **Node.js LTS** ([nodejs.org](https://nodejs.org)). The pipeline's runner is plain
      Node with zero packages to install — this is the whole language setup.
- [ ] **GitHub CLI** ([cli.github.com](https://cli.github.com)), then in Git Bash:
      `gh auth login` (choose GitHub.com → HTTPS → login with a browser).
- [ ] **Claude Code**, in Git Bash: `npm install -g @anthropic-ai/claude-code`, then run
      `claude` once in any folder and sign in with your Claude account when it asks.
      This is the agent you'll do planning sessions with.

You do **not** need to install `bd` (the task-queue tool) — the pipeline falls back to
the copy baked into its container image when the host doesn't have it.

## 3. Set up the pipeline repo (once per PC)

All of this in Git Bash.

- [ ] Clone the pipeline repository and `cd` into it.
- [ ] Mint your pipeline token: run `claude setup-token` and follow the browser prompt.
      Create a file named `.env.pipeline` in the repo root containing one line:
      `CLAUDE_CODE_OAUTH_TOKEN=<the token it printed>`.
      This file is git-ignored — it stays on your machine. Never paste the token into
      chat, a commit, or a config file that gets committed.
- [ ] Build the container base image:
      `docker build -t pipeline-base:local docker/base`
      (first build downloads a lot; later builds are fast).
- [ ] Prove the whole thing works end to end with no AI calls and no cost:
      `bash scripts/e2e.sh` — about 5 minutes. If it passes, your machine is ready.

## 4. Learn the workflow (first week, no installs)

- [ ] Open `docs/pipeline-map.html` in a browser — the whole system on one page,
      written for a reader rather than a maintainer. Start here.
- [ ] Read `CLAUDE.md` (the rules), `PLANNING.md` (how a planning session goes) and
      ONBOARDING.md's "Starting from nothing" section (the four-stage path your own
      projects will follow). In `DESIGN.md`, §4.11 (what outcomes a run can have) and
      §3.1 (how a task gets specified and frozen) carry the most weight — skip the rest
      until you need it.
- [ ] Sit in on one **planning session** and one **onboarding** with someone who has
      done them, before doing your own.

## 5. Bring in your own project (once per project)

You own your projects end to end: creating them, making them pipeline-ready, and
running them. The full path is ONBOARDING.md's four stages — here is the shape of it.
Every stage is an interactive session where **Claude Code does the driving and you make
the decisions**; you never follow these checklists by hand.

- [ ] **Scaffold** (new projects only). Start `claude` in an empty folder and describe
      what you want to build. It lays out language and technology options with a
      recommendation; you decide; it sets the project up and gets a spec approved by
      you before building anything. An existing project skips this.
- [ ] **Write the design doc.** For a project the pipeline will seriously develop, a
      `DESIGN.md` in that project's repo: intent, architecture, decisions and why.
      Claude Code interviews you for it. Small projects can skip this and plan
      per-task; the doc layer is for work big enough to break into batches.
- [ ] **Onboard.** From the project's folder, tell Claude Code to follow the pipeline
      repo's ONBOARDING.md (or run the `pipeline-onboard` command if you have the
      harness plugin installed). It walks the checklist with you: GitHub remote,
      integration branch, the frozen-test home, config, container image, task database.
      Existing codebases get a readiness assessment first — read its verdict; it's
      advice, and the decision to proceed is yours.
- [ ] **Plan and run, forever.** Every feature from here on is a PLANNING.md session
      (tasks specced, "done means" lists approved by you, tests frozen) followed by an
      autonomous run:
      `node runner/run.js --config run.config.<project>.json` from the pipeline repo.
- [ ] Two mechanical bits the sessions will prompt you for, listed here so they're not
      a surprise: a `run.config.<project>.json` in the pipeline repo (copy the example;
      it's git-ignored and per-machine) and `bash scripts/install-hooks.sh` once per
      clone of the project (task-queue syncing).

## Rules of the road (the ones that bite)

- **One run per project at a time.** A second run against the same project refuses to
  start, by design.
- **Never edit anything under `tests/acceptance/`** in a target project — those are the
  frozen tests that judge a run; the verifier treats any change as tampering.
- **Test suites run one at a time**, never in parallel — they share one Docker network.
  `bash scripts/test-all.sh` is the safe way to run several.
- **Git Bash, always.** Not PowerShell, not WSL, for anything that touches Docker.
- **Your token is yours.** `.env.pipeline` never leaves your machine.
