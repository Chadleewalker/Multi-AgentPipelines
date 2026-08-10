# First-sweep prompt — hand this to someone with a new clone

Copy the fenced block below and paste it into a Claude Code session started **from inside
the fresh clone, in Git Bash**. It proves the installation by running the repo's own test
sweep, and it ends with a report rather than a fix.

Everything it does is read-only or works in throwaway containers and temp directories. It
changes no tracked file.

---

```
I have just cloned this repository and I want to prove the installation works on this
machine before trusting it. Do not fix anything you find — I want a report, not repairs.

Read SETUP.md Part C first, then work through these steps in order and stop at the first
one that fails.

STEP 1 — Preconditions. Confirm all four, and tell me which one is missing if any is:
  - Docker Desktop is running (`docker info` succeeds)
  - You are in Git Bash, not WSL and not PowerShell
  - `node --version` works
  - A file named `.env.pipeline` exists at the repo root containing a line
    CLAUDE_CODE_OAUTH_TOKEN=... (do NOT print the token itself, just confirm the line
    exists)

  The token one matters most. The sweep will start without it and only print a warning,
  then several suites go red with realistic-looking assertion failures that have nothing
  to do with the real problem. If it is missing, stop and tell me.

STEP 2 — Build the base image. This is the slow part, roughly 5-15 minutes on a first run,
and everything after it is fast:

    docker build -t pipeline-base:local docker/base

  Then prove it is right:

    bash scripts/test-base-image.sh

  Every line should read PASS. If any does not, stop and show me the output.

STEP 3 — The sweep. This runs every test suite in the repo, one at a time:

    bash scripts/test-all.sh --skip e2e --timeout 300

  Expect roughly 8-12 minutes. Notes on what you are looking at:
  - `--skip e2e` leaves out the one suite that needs a disposable GitHub repo set up as a
    fixture, which I do not have yet.
  - `--timeout 300` kills any single suite that hangs after five minutes. The slowest
    healthy suite on record takes 1 minute 32 seconds, so a suite hitting that cap has
    hung rather than been slow. Report it as TIMEOUT, not as a failure of the thing it
    tests.
  - Do not run anything else that uses Docker for this project at the same time. The sweep
    cleans up after each suite, and a live container looks exactly like something it
    should clean up.

STEP 4 — Report back. Give me:
  - the summary table the sweep prints at the end (it is also saved to
    runs/sweeps/<timestamp>/summary.txt)
  - the totals line: how many suites ran, how many green, how many red
  - for each red or timed-out suite: its name, and the first FAIL line from its log in
    runs/sweeps/<timestamp>/<suite>.log

Do not change any file, do not commit anything, and do not try to fix a red suite. Some
reds may already exist in the repository and not be caused by my machine at all —
distinguishing mine from pre-existing ones is the whole point of the report.

If a step fails in a way the notes above do not cover, stop and tell me what happened
rather than working around it.
```

---

## What "good" looks like

A healthy sweep is **all green in about 8 minutes**. For reference, the 2026-08-03 sweep on
the reference host ran 32 suites green in 8:09. Sweeps that take an hour are not doing more
work — they are suites hanging and hitting the per-suite kill.

## If it comes back red

Check in this order:

1. **Was `.env.pipeline` present?** A missing token is the single most common cause of a
   cluster of red `test-runner-*` suites. The tell is very few assertions reported rather
   than many failures.
2. **Was anything else using Docker for this project?** A task container dying with no
   output is almost always a collision with the sweep, not Docker running out of memory.
3. **Compare against the current baseline on the reference host.** A suite that is red
   there too is not their installation.
