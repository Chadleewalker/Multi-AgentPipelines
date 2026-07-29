---
name: onboard
description: Assess a codebase for pipeline fitness, then walk it through ONBOARDING.md's checklist to become a pipeline target. Tuned for existing, pre-agentic repos — greenfield projects pass the assessment quickly and go straight to the checklist. Use when adopting any repo as a target, or when asked whether a repo is ready to be one.
---

# Onboard a codebase as a pipeline target

Run this from the pipeline repo, with the user, against a target repo elsewhere on disk:

```
/onboard C:/path/to/SomeProject
```

If no path was given, ask for one before doing anything else.

## What this skill is, and is not

`ONBOARDING.md` in this repo is the **source of truth** for what onboarding does — it says
so in its own opening, and it is the checklist form of DESIGN.md §3.4 and §6. This skill
does not restate that checklist. It **reads it and executes it**, so the two can never
drift.

What this skill adds is the part the checklist doesn't cover: a **read-only assessment**
of whether the codebase is ready to be worked on autonomously, and what to queue first if
it is. The checklist makes a repo *mechanically* valid. The assessment asks whether it is
*practically* workable — a distinction that barely matters for a repo scaffolded last week
and matters enormously for one written in 2014.

## Rules this session is bound by

- **Interactive throughout** (hard rule 3). Onboarding happens on the host with the user.
  Never proceed past an approval gate on your own judgment.
- **The assessment is advice, never a gate.** It cannot refuse to onboard a repo. The user
  reads the verdict and decides. An LLM judgment that blocks work is the failure mode
  hard rule 5 exists to prevent; keep this one advisory in the same spirit.
- **Two steps ask permission first**, per ONBOARDING.md: `gh repo create` (step 1) and
  `docker build` (step 4). Never run either unprompted.
- **Never write the target's name into this repo's tracked tree.** This repo is public and
  is used on private work (CLAUDE.md). The readiness report is *evidence*, and evidence is
  exactly how the past leaks got in. The report goes in the **target** repo or the
  scratchpad — never here. The only file this skill creates in this repo is
  `run.config.<project>.json`, which is git-ignored.
- **Never modify the pipeline's own verification** to accommodate a target. If a repo
  can't be verified, that is a finding to report, not a config to loosen (hard rule 2).

## Phase 1 — Read the ground (read-only)

Work through `references/probes.md`, which holds the concrete commands per dimension. Run
everything read-only; change nothing in this phase. Report findings per dimension as
**evidence, not adjectives** — "the suite takes 6m40s and 23 of 88 tests open a socket",
never "test coverage is weak".

Five dimensions, in the order they decide the outcome:

1. **Verifiability — the go/no-go.** Can a typical task for this repo get a test that is
   fast, deterministic, and runs with no network, no live database, and no shared state?
   The pipeline's only judgment mechanism is a frozen test run inside a sealed container
   (§4.4), so nothing else on this list can compensate for a bad answer here.
2. **Coupling versus one-issue-one-PR.** Every task clones fresh from the canonical remote
   (§4.2), so tasks in a batch never see each other's work. Measure the real change
   footprint of past commits and find the hotspot files everything routes through. A repo
   where the median commit touches 30 files will produce a morning of merge conflicts
   rather than a morning of review.
3. **Dependency and closed-network fitness.** The container reaches Anthropic endpoints and
   nothing else (hard rule 6). Everything the build or test needs must be declarable in
   `dependencies` and baked into the image. Hunt for install-time network access.
4. **Knowledge legibility.** The container agent cannot look anything up. Undocumented
   invariants are the things an agent "cleans up". Stale documentation is worse than
   absent documentation here, because a sealed agent will follow it.
5. **Git and host readiness.** Remote, real integration branch (ask git — never assume),
   `.gitattributes`, working tree state. Cheap to check, cheap to fix, blocks everything.

## Phase 2 — The verdict conversation

Write the report to `<target>/docs/pipeline-readiness.md` — propose it, and if the user
declines, use the scratchpad. Keep it to one page:

```markdown
# Pipeline readiness — <project>
Assessed <date> against ONBOARDING.md and DESIGN.md §3.4/§4.4.

## Verdict
<Ready | Ready for a narrow beachhead | Needs seams first> — one paragraph of why.

## Findings
| Dimension | Evidence | Consequence |
|---|---|---|
| Verifiability | ... | ... |
(one row per dimension; evidence is a number or a command's output, not an impression)

## Blockers
Things that must change before the first run, each with the fix.

## Beachhead
The module to start in, and why it is the one with seams.

## First three task candidates
Additive work with clean test surfaces — not refactors. One line each.

## Deferred
What this repo is not ready to have tasked out yet, and what would change that.
```

Then say plainly which of the three verdicts it is, and recommend accordingly:

- **Ready** — proceed to Phase 3.
- **Ready for a narrow beachhead** — the common answer for old code. Proceed to Phase 3;
  onboarding is repo-wide and cheap, and what gets staged is the *task queue*, not the
  onboarding. Be explicit about that distinction, because it is easy to hear "start
  narrow" as "onboard part of the repo", which is not a thing that exists.
- **Needs seams first** — onboarding will succeed and the runs will be uninterpretable.
  Recommend characterization-test work first (which is itself legitimate pipeline work
  once the repo is onboarded, so this is rarely a reason to stop). Say what specifically
  would move it out of this bucket.

Get an explicit decision before touching anything.

## Phase 3 — Execute the onboarding checklist

**Read `ONBOARDING.md` now and follow its checklist, steps 1–9, in order.** It is the
authority; this section only flags where existing repos diverge from the greenfield path
it assumes. Stage 1 (create the project) does not apply — the code exists.

- **Step 1 (git/GitHub).** Get the integration branch from `git remote show origin`, never
  from assumption — a target on `master` broke three components before that rule existed.
  Old repos often lack `.gitattributes`; adding `*.sh text eol=lf` may show up as a large
  diff on first checkout, which is expected and worth warning the user about.
- **Step 2 (`tests/acceptance/`).** The repo probably already has a `tests/` tree. The
  acceptance directory is *additional* and separate — never retrofit existing tests into
  it. Existing tests are candidates for `regressionCommand` in step 3, not for the freeze.
- **Step 3 (`pipeline.config.json`).** `verifyCommand` must run **one task's** acceptance
  directory, invoked as `<verifyCommand> tests/acceptance/<issue-id>/`. An existing test
  runner usually needs a thin wrapper script to accept a path that way; put the wrapper in
  `frozenPaths`, since the verifier executes it. Point `regressionCommand` at the repo's
  existing suite if it is fast and green — if it is neither, leave it out and say why.
- **Step 4 (image).** Cross-check the `dependencies` manifest against the Dockerfile; they
  must not drift. Legacy dependency sprawl is where this step actually costs time. Ask
  before building.
- **Step 5 (Beads).** `bd init` in the target working copy. This is the target's **own**
  queue — the pipeline repo never holds another project's issues (`runner/bd.js` runs
  every command as `bd -C <targetRepoPath>`).
- **Step 6 (the target's `CLAUDE.md`).** The highest-risk step on an old repo, because it
  may already carry a rival container or CI workflow — especially one that pushes straight
  to the integration branch, the exact opposite of the pipeline's git isolation. Replace
  it; do not let two workflows coexist. Remove `.claude/hooks/` and the `hooks` entry from
  the target's `.claude/settings.json` (registry-fetching format hooks hang on the closed
  network).
- **Step 7 (vendor knowledge).** Underrated on greenfield, close to load-bearing here. An
  agent in a sealed container has only the repo. Vendor docs for the dependencies tasks
  will actually touch, and flag any existing documentation the assessment found stale —
  either verify it or mark it historical, because a confidently wrong document gets
  followed.
- **Step 8 (pipeline-side wiring).** Copy `run.config.example.json` to
  `run.config.<project>.json` here (git-ignored). If the target is private, add its name
  to `.sanitize-denylist` — this is the moment that matters, and it is easy to skip
  because nothing fails without it. Run `bash scripts/install-hooks.sh` **in the target
  repo**: issues live in `refs/dolt/data`, which `git pull` does not fetch, so a second
  machine silently keeps a stale queue.
- **Step 9 (sanity pass).** Run every check in it. Add one the checklist cannot know
  about: `bash scripts/test-sanitize.sh` **here**, because the target's name may have
  reached this repo through a config path or an example.

## Phase 4 — The design doc, if it earns its place (optional)

Offer this; do not impose it. DESIGN.md §3.2 permits entering planning with just a spec,
so a doc-less adoption is legal — what it costs is `design-ref` on each issue, and with it
the two cheap checks in §3.1 (doc sections with no issue; issues citing nothing).

If the user wants one, **do not reverse-engineer the architecture**. The code already
describes itself and the container agent can read all of it; transcribing module layout is
archaeology that is stale on arrival. Capture only what the code cannot say:

- **Invariants and why they exist** — the things that look arbitrary and will get "fixed".
- **Decisions and rejected alternatives.**
- **Hazards** — the module everyone fears, the code that looks dead and is not.
- **Intent** — where this is going. This is the part decomposition actually consumes.
- **A change log**, so the doc is amendable rather than rewritten (§3.3).

Then let it grow one planning session at a time. Coverage is needed for the area about to
be tasked out, not for the whole system.

## Phase 5 — Hand off

Report, in this order: the verdict; what was created in the target and what in this repo;
which checklist steps the user must still do themselves (anything needing credentials or a
build they declined); and the first task candidates as a suggested planning agenda.

State plainly that onboarding is **once, ever** — everything after this is a PLANNING.md
session per feature, and the next step is planning the beachhead task, not re-onboarding.
