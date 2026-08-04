# IDEAS.md — the idea inbox

Somewhere to put *"that's probably a good idea"* the moment you have it, so it survives
without being thought about yet.

This is deliberately the cheapest document in the repo. It is not a design, not a spec,
not a backlog. An entry here makes **no** claim that the idea is good, sized, wanted, or
ever going to happen. That is the whole point: capture has to cost nothing, or it doesn't
happen at the moment the idea shows up — which is the only moment it is free.

## Where this sits

The repo already had four homes for a thought, and none of them accepts an unformed one:

| Home | Holds | Costs |
|---|---|---|
| `DESIGN.md` | a decision, and why | an interview, critics, a change-log row |
| `PLANNING.md` → `docs/planning-draft-*.md` | a spec being made machine-checkable | a planning session |
| a Beads issue | committed work, frozen | approval, frozen tests |
| `docs/STATUS.md` | where the build actually is | it describes reality, not intent |

An idea that isn't ready for any of those had nowhere to go but your head. Filing it as a
Beads issue is the tempting mistake and the wrong one — issues are commitments, they show
up in `bd ready`, and the queue is what the runner drains unattended. **An inbox that can
start a container is not an inbox.**

## The promotion path

An idea is not finished here; it is *parked* here. The way out is the way everything else
in this repo gets built:

```
IDEAS.md  ->  DESIGN.md section (+ change-log row)  ->  spec + frozen tests  ->  Beads issue  ->  a run
  parked        decided, with a reason                    machine-checkable      committed
```

Same two-stage shape as `bd remember` → the promoted conventions in `CLAUDE.md` (§3.6):
**the inbox is a staging area, not a destination.** A note that has earned its place moves
somewhere permanent and cites where it came from; a note that hasn't, sits here or gets
dropped. Nothing is ever implemented straight from this file — an idea that skips the
design and spec layers is exactly the scope creep `design-ref` exists to catch (§3.1).

Planning sessions read this file for candidates (`PLANNING.md`, step 0). That is the only
process obligation attached to it.

## How to write an entry

A title, a sentence or two on **why you'd want it** — not how you'd build it — and the
date. That's it. Resist adding structure; if an entry needs a section of its own it has
stopped being an idea and wants a design doc.

```markdown
- **Short imperative title** — why this would be worth having, in a sentence or two.
  Whatever context future-you will not remember. 2026-07-30
```

Optional extras, only when they're actually true:
- `Blocked on:` — something that has to land first. Name the change-log row or issue id.
- `Related:` — an existing design section this would touch.

**Grouping:** this is one flat list on purpose. Add headings only when the flat list
genuinely stops being skimmable — an inbox with a taxonomy is a filing system, and a
filing system is a thing you avoid using.

## What must not go in here

Two hard boundaries, both inherited:

1. **This file is public, and it is pipeline-only.** This repo documents the machinery,
   never the work done with it. Ideas about a *target* project belong in that project's
   own `docs/IDEAS.md`, not here — naming one here leaks the thing the boundary exists to
   protect, and `scripts/test-sanitize.sh` reads the tracked tree as bytes to catch it.
   Write "the first real project", never its name.
2. **Nothing that is already decided.** If it's in `DESIGN.md` it isn't an idea, it's a
   plan; if it's a known gap in `docs/STATUS.md` it isn't an idea, it's work. Duplicating
   either here is how an inbox becomes noise nobody reads.

---

## Inbox

<!-- Newest at the top. Nothing here is committed to. -->

### Agent ideas

The one heading this file allows itself, and here is the justification the grouping rule
above asks for: *"what agents should this thing have"* is a question that gets asked as a
question, and its answers were scattered across the flat list, the Dropped table and
`DESIGN.md` §3.5 — so answering it meant reading all three. Everything else stays flat.

**The constraint all three inherit, stated once so no entry restates it.** §3.5 already
decided *how* a specialist plugs in: three slots in descending leverage (planning critic →
test author → run-time advisor), a charter in `advisors/`, selection from a project's
`pipeline.config.json`, and hard rule 5 — **never a gate**. So none of these is a proposal
for a new mechanism. Each is a proposal to *staff an existing slot*, and the open question
for each is which slot, not whether the pipeline can hold it. Two of them are close enough
to already-decided that they may be small work items rather than ideas; they are parked here
anyway because *which lens is worth staffing first* is genuinely undecided.

**Why this matters if checker and implementor agents arrive.** No such split exists today —
the phase sequence is fixed scaffolding (code → verify → docs, §4.3) and the only checker is
the deterministic verifier. If one is built, the instinct will be to make security and
accessibility into checkers that can fail a task. That is precisely what hard rules 5 and 7
forbid: an LLM that can fail a task voids the three-attempt cap, destroys the retry loop's
steering signal, and produces unactionable overnight failures. **A checker agent is legal
only if it emits evidence and never an exit code.** Deciding that before anything is built is
free; discovering it afterwards means unpicking a gate someone reasonably added.

- **Staff an accessibility lens — and expect it to end up as frozen tests, not an agent** —
  a target with a user interface can pass every gate this pipeline owns and still be unusable
  with a keyboard or a screen reader: the acceptance tests are green, the feature works, and
  nothing anywhere asks whether it works for everyone. Worth having because accessibility is
  the most deterministic-friendly of any domain yet considered here — contrast ratios, focus
  order, tab order, alt-text presence, ARIA roles and names, semantic heading structure,
  keyboard traps, reduced-motion preferences, hit-target sizes are all machine-checkable
  against published rule sets. §3.5 already names contrast ratios as *its own example* of
  domain judgment reducing to a deterministic check, so slot 2 (test author) is the honest
  home and the charter is cheap: one file in `advisors/`, no new phase, no runner change.
  The honest catch, and the reason this is not simply "write the charter": the deterministic
  subset is real but partial. Automated rule sets catch the mechanical half; whether alt text
  is *meaningful*, whether focus order matches reading order, whether an error is announced —
  is judgment, and lands in slot 1 or slot 3. So this lens will split across slots rather than
  living in one, which is a thing to design for rather than discover.
  Scope note: it only pays for targets that have an interface, and per-task opt-in is already
  how selection works — no blanket application. Related: `DESIGN.md` §3.5,
  `advisors/README.md`. 2026-08-03
  *Surveyed 2026-08-03, and the result argues against staffing this lens **here**: the entire
  accessibility surface of this repo is one file, `docs/pipeline-map.html`. Everything else is
  Node, shell and markdown, where the lens is genuinely N/A. So this repo is close to the worst
  place to prove the charter, and a target project with a real interface is where it would earn
  its keep — write the charter, but do not staff it against this tree.*
  *What that file already has, hand-written and unenforced: **all 112 hex values live inside
  `:root` blocks, none outside** — the exact "no hardcoded colors outside the token file"
  condition §3.5 names, currently holding by discipline rather than by a check; two palettes
  (there is a `prefers-color-scheme: dark` block, so the contrast surface is doubled);
  `role="group"` + `tabindex="0"` + a descriptive `aria-label` on the pan/zoom canvas;
  `aria-label` on the three icon-only zoom buttons, correctly absent on the three text buttons
  whose visible text is already their accessible name; a real `keydown` handler and focus
  styling. **Nothing checks any of it** — no `.sh`, `.js` or `.json` in the tree references the
  file at all, which is the same unguardedness `CLAUDE.md` already warns about for its content,
  showing up on a second axis.*
  *Gaps found, all small and all real: no `<html lang>` (the file opens at `<title>` with no
  doctype or head, so a screen reader guesses pronunciation language); no
  `<meta name="viewport">` despite responsive media queries that mobile browsers will largely
  ignore without it — the responsive work is half-wired; no `prefers-reduced-motion` on a page
  whose whole interaction is pan and zoom. Structure only: **no contrast ratio was computed**,
  so whether either palette passes AA is still unknown.*
  *The one piece worth building here regardless, and the cheapest possible start: a Tier-1
  contrast check over the `:root` pairs in both palettes. Pure arithmetic on the WCAG formula —
  no DOM, no browser, no dependency, no Docker — so it fits `tests/unit/` beside the other
  Docker-free suites and `test-all.sh` discovers it by glob. It would answer the open question
  above and convert the token discipline from luck into a gate.*

- **Staff a security lens — the design named the domain and nothing staffs it** — §3.5's
  title names security among its example domains and "does this touch an auth path" is its
  worked example, but there is no `advisors/security.md`, so a domain the design explicitly
  called out has no charter behind it. Worth having because security is where "never a gate"
  is most uncomfortable and therefore most likely to be quietly violated by a well-meaning
  later change — nobody argues with a physics advisor that cannot block, and everybody wants
  a security one that can.
  The design's answer is the escalation ladder, and this repo already contains one working
  instance of it: `scripts/test-sanitize.sh` is a security-adjacent concern — credentials,
  addresses, private names — that was made a **hard** gate precisely *because* it is
  deterministic and reads bytes, with no LLM anywhere near it. That is the template for what
  a security lens should become, not an exception to it.
  The honest catch: most of what an agent would find in a task-sized diff is either already
  deterministic (secret scanning, dependency audit, obvious injection sinks) or needs
  whole-system context a single diff does not carry, because the interesting vulnerabilities
  are compositional — two individually safe changes that combine badly. That argues the lens
  is worth more at planning time ("this task touches an auth path and the spec says nothing
  about it") than after the code exists. Related: `DESIGN.md` §3.5; hard rule 5. 2026-08-03

- **Have something review a finished session and propose pipeline improvements — filed with
  its own counter-argument attached** — the idea is a reviewer that reads a completed session
  and asks what the *pipeline* should learn from it, as opposed to what the task produced.
  Parked with the case against it in the same entry, because the case against it is strong and
  a future reader deserves both.
  **The precedent is against it.** The documentation-updater agent in the Dropped table below
  was declined for exactly this shape — *the mechanism was under-used, not missing.* There are
  already five channels for "something went wrong": `bd remember`, `status.js note`,
  `status.js concern`, `docs/STATUS.md`'s defect list, and the sweep summaries. Defect 11 is
  the case where the evidence was published, correct, and still cost a session because nobody
  read it. A sixth channel producing more unread prose is the predictable outcome, and the
  fix for an unread channel is aggregation, not another author.
  **It also overlaps the audit-corpus entry below, on the weaker axis.** That one reads every
  finished run as a corpus; this one reads a single session. n=1 generalises badly — which is
  precisely the complaint that entry makes about a human reading one or two runs closely and
  generalising from them.
  **What would make it worth having anyway**, and the reason it is not simply dropped: the
  session is the one artifact the corpus *cannot* see. `runs/` records what the runner wrote —
  it does not record the interactive planning session, the critic rounds, or the human's
  "merged / sent back, and why", which the audit entry itself names as the most valuable field
  the pipeline does not own. A session reviewer is one way to capture that verdict at the only
  moment it exists. If that is the real value, the shape is a cheap capture step, not a
  reviewing agent.
  **Placement is forced, not chosen.** Hard rules 5 and 7 put it entirely outside a run:
  post-hoc, never in the control path, never able to change an outcome. As with the audit
  entry, that weaker position is also what permits it to be an LLM at all.
  Related: *Audit the pipeline's own history across runs* below (same data, different time
  axis); the documentation-updater row in Dropped; `DESIGN.md` §3.6, §3.7. 2026-08-03

*Also agent-shaped, left in the flat list rather than moved: **Audit the pipeline's own
history across runs** (below) is the strongest agent idea currently parked, and the
**documentation-updater** row in Dropped is the one already declined — read both before
proposing a new agent.*

---

- **A live dashboard that lights up the pipeline diagrams as tasks move through them** — an
  unattended run is currently watched by tailing `run.log` in a terminal, and a batch at
  `concurrency` 3 interleaves three tasks' lines into one stream with only the trace id to tell
  them apart. `docs/pipeline-diagram.md` already draws the exact state a reader wants to know,
  and `docs/pipeline-map.html` already proves the delivery shape works here — one
  self-contained page, no external fetches, pan/zoom. The idea is its live sibling: the same
  mermaid, re-rendered with the node each task currently occupies highlighted, and the
  diagrams already carry `classDef` styling to hang that on.
  **How detailed it can be, honestly, split three ways** — this is the part worth writing down,
  because two thirds of it needs no new plumbing:
  *Free today.* Which projects are running at all, from the `runs/locks/*.lock` registry keyed
  by canonical target repo (change-log row `repo-os9`). The whole host-side queue diagram —
  admit, claim, collect, finish — from `run.log`, which `runner/log.js` appends live as
  `<ISO> LEVEL [runId/issueId] msg`, so it is already a timestamped per-task event stream on
  disk. Attempt number and each attempt's verdict, pauses and the reported reset time, branch
  and commit status, final outcome — all of it from the workspace's `.run/status.json`, which
  the entrypoint updates at every boundary (`init`, `append pass|fail|tampered|error`,
  `set rateLimitResetAt`, `summary`) and which lives on a host bind mount, so it can be read
  live without giving the container a route out. The `open → in_progress → closed|blocked`
  state diagram falls straight out of that.
  *One small deterministic change.* Where *inside* the container a task is right now — code
  phase, verifier, docs phase — is the one thing the inner diagram needs and the one thing
  nothing records, because `status.json` is written *after* each phase rather than on entry to
  it. A `phase` field set by `pipeline/entrypoint.sh` at each boundary would light that diagram
  up; it is a scaffolding write with no LLM anywhere near it (hard rule 7). The alternative —
  grepping `container.log`, which *is* streamed to the host live — is the log-scraping this
  repo has already banned once for good reasons (§3.6).
  *Not available at any sane price.* Progress *within* the code phase. That is the existing
  entry below on periodic self-reported progress, and its catch stands: an LLM cannot keep
  wall-clock time. A dashboard makes the deterministic half of that entry more attractive than
  the agent-reported half — "alive, 14 minutes in, log still growing" is a host-side timer, and
  it answers the question a watcher actually has.
  **Two of the five diagrams animate; the rest are context.** *Inside one task container* and
  *how a task moves through the queue* carry live per-task state, and the state diagram does
  too. *End to end* and *where the walls are* have no runtime state — the planning half is
  interactive and long finished by the time a run starts. Worth deciding that up front rather
  than discovering it after building a renderer for all five.
  **Constraints, all inherited.** Read-only and host-side: a dashboard that can write is a
  route around hard rule 1. And the page would name target repos, PR URLs and issue titles, so
  it is git-ignored output like everything else under `runs/` — the same boundary the audit
  idea above runs into, and for the same reason. Related: the audit-corpus entry above is the
  same data on the other time axis (that one reads finished runs, this one reads the live one),
  which is an argument for whatever shape gets built first defining the read model once.
  Related: `docs/pipeline-diagram.md`, `docs/pipeline-map.html`, `DESIGN.md` §4.7, §4.12, §7.
  2026-08-02

- **Audit the pipeline's own history across runs, not one run at a time** — every run already
  writes a rich, schema'd record (`runs/<run-id>/run.json` plus per-task `status.json`,
  `verify.json`, `issue.md`, the agent logs and the docs output), and there are 194 of them on
  this host. **Nothing has ever read them as a corpus.** Every finding this project has about
  its own weaknesses — "problems trace to spec quality, never to the executor", the freeze gate
  blessing a suite that never ran, the criteria that cannot fail, the docs phase colliding on
  every batch — came from a human reading one or two runs closely and generalising. That is
  expensive and it only finds what someone happened to look at. Worth having because the data to
  answer "what does this pipeline get wrong, and how often" is already on disk, already
  structured, and already carries the quantitative fields (`attempts`, `pauses`,
  `activeSeconds`, `diffLines`, `outcome`, `model`, the verification evidence) that would make a
  claim like the 3.6× variance across comparable tasks a measurement instead of an anecdote.
  Three things it has to get right, all of them constraints this repo already pays for:
  **Where it may sit.** Hard rules 5 and 7 put it entirely outside a run — post-hoc, offline,
  over finished runs, never in the control path, never able to change an outcome. That is a
  weaker position than it sounds: it is also what lets it be an LLM at all.
  **The corpus is host-only and stays that way.** `runs/` is git-ignored precisely because a
  manifest names the target repo, its PR URLs and its issue text; the two leaks this repo has
  had both came in as *evidence* rather than as code. So an audit artifact that gets committed
  is a new leak surface with a new shape, and only generic findings can be promoted out of it —
  "the docs phase collides on every batch", never which project it collided on.
  **The most valuable field is the one the pipeline does not own.** Its own signals said `done`,
  green, one attempt for shadow-01, and the human rejected it. Nothing records that verdict, so
  a corpus built only from what the runner writes would be non-empty, well-formed, and blind to
  the failure class that has mattered most — the artifact rule (§3.6) applied to the audit
  itself. Whatever this becomes probably needs a cheap way to attach "merged / sent back, and
  why" to a run after review.
  **The honest counter-argument**, and the reason this is parked rather than specced: the
  documentation-updater agent below was dropped because *the mechanism was under-used, not
  missing*, and the same charge fits here — memory notes, spec concerns, `docs/STATUS.md`'s
  defect list and the sweep summaries are already five channels for "something went wrong", and
  defect 11 is the case where the evidence was published, correct, and still cost a session
  because nobody read it. If the gap is reading rather than collecting, the answer is aggregation
  and not an agent. Deciding which it is means looking at the 194 runs once by hand first — which
  is itself the cheapest possible version of this idea.
  Related: `DESIGN.md` §4.11 (the outcome table), §5 (the review phase), §3.6, §3.7;
  `docs/STATUS.md` defects 8 and 11. 2026-08-02

- **Make the sweep and a live run mutually exclusive** — on 2026-08-01 a sweep running in
  another terminal `docker rm -f`'d a real run's task container twice, and the run reported it
  as exit 137 with an empty log, which reads exactly like an OOM kill. A session was spent on
  Docker Desktop and the WSL2 VM before anyone opened the sweep summary, where it was written
  down plainly. Worth having because the exclusion is cheap and already half-built: §4.12's
  per-project lock lives in `runs/locks/`, and the sweep could take one of its own and refuse to
  start while any is held, with the runner refusing symmetrically. The reason it isn't just a
  bug fix in `sweep-reclaim.js` is that the reclaimer is *correct* — a before/after snapshot diff
  genuinely cannot tell "appeared because my suite made it" from "appeared because something
  else did", so the guarantee has to come from exclusivity rather than from better
  classification. Second-order: a reclamation of anything matching `task-` deserves to be loud
  (stderr, non-quiet), since by construction it is either a real leak or someone's live work.
  Related: `DESIGN.md` §4.12; `docs/STATUS.md` defect 11. 2026-08-01

- **Verify a stated mechanic exists in the code before speccing against it** — a planning session
  on 2026-07-31 spent a full exchange designing around "the ship can pull a tethered astronaut",
  which the owner believed was how the game worked. It is not implemented at all: the suit is
  integrated on gravity and the jetpack, the tether is added mass that only ever slows it, and
  there is no ship-to-astronaut coupling anywhere. Nobody was wrong to believe it — it is in the
  design's spirit and half the supporting parts exist — but the spec would have been written
  against a mechanic with no code behind it. Worth having because the check is thirty seconds of
  grep and the failure mode is a frozen task that cannot pass. Note this is the same disease as the
  four checklist items found already-done the same day: **the map and the territory drift in both
  directions**, and only reading the territory settles it. Candidate PLANNING.md step-1a addition.
  Related: *Reconcile a target's spec against the merged tree at planning step 0*, below, covers
  the **written** half of the same drift — a spec that has fallen behind merged code. This entry is
  the **unwritten** half: a mechanic someone believes in that was never built. Both were found on
  the same day from opposite ends, which is the argument for reading the code at step 0 rather than
  trusting either document. 2026-07-31

- **Ask what else reads the number a new mechanic changes** — the same session found that adding a
  line-gun would silently redefine a shipped, already-ticked spec item. `Astronaut.can_reach()`
  credits the *magnet's* range against the gap home; if a line becomes the thing that saves you,
  the RETURN lamp must credit the *line's* range instead — so the lamp's meaning changes without a
  word of its specification changing, and its box stays ticked either way. Worth having because a
  redefinition is invisible to every gate this project owns: the frozen tests still pass, the
  regression net still passes, and the checklist still reads done. The scope critic asks "is this
  several tasks"; nothing yet asks "what did this quietly re-mean". Cheap version: a spec
  constraint naming every existing caller of any function the task touches. 2026-07-31

- **Have the docs phase tick the box, not just write the note** — four times in one day the
  documentation phase updated a checklist item's prose and left its checkbox unticked, including
  once where the task itself had just built the gate the box was waiting for. The failure is
  consistent and one-directional: notes get updated, the state marker does not. It matters because
  the checklist is what a planning session reads to choose the next task, so a stale box is not a
  cosmetic lag — it is a spec cut against a false picture. It cost a full planning cycle on
  2026-07-31: a task was drafted, criteria written in fresh context, and a critic panel run, before
  anyone noticed both deliverables had shipped days earlier and were already guarded.
  Worth having because it is cheap to attempt — the docs prompt already asks for the notes — and
  because the alternative is auditing the checklist by hand before every planning session, which is
  what had to happen instead. Note the honest difficulty: deciding a box is tickable means judging
  whether a claim is *gated*, not merely true, and an agent that ticks boxes optimistically is worse
  than one that never ticks any. Possibly the right shape is narrower — have the docs phase report
  *candidate* ticks as evidence, the way `note` and `concern` already report, and leave the edit to
  the host. 2026-07-31
  *Sharpened by change-log row `trace-ledger` (2026-08-04): a tick now has a convention to
  follow — the ref of the ticking issue rides on the line — but nothing tells the docs
  phase's prompt about it yet, so a docs-phase tick would land unrefed and surface in the
  step-0 report as a claim with no witness. If this entry is ever built, the ref is part of
  the tick.*
- **Tell the docs phase which files it owns, and stop giving living documents dated names** — the
  docs phase's entire file-set instruction is one line in `pipeline/entrypoint.sh` ("Update any
  in-repo documentation affected by the change (README, docs/)"), naming no manifest. It works
  anyway, because the workspace is a full clone and the target's `CLAUDE.md` auto-loads into every
  invocation — so the reading table *is* the manifest, by accident rather than by design. Making
  that explicit is a prompt change plus an assertion against the *generated* prompt file, the way
  change-log row `repo-1cy` established.
  The second half is a convention nobody had written down: **a date in a filename reads as
  immutable.** An agent will not rewrite a document named for a date, and should not — that is a
  record of that date, not a living file. A repo that wants a maintained status document must not
  name it after the day it was started, and the failure looks like forgetfulness rather than like
  the missing mechanism it is. 2026-07-31
  *Found by checking which documents task docs phases have actually touched: nine
  container-authored commits have amended this repo's `docs/STATUS.md`, one adding 41 lines.*

- **Give every onboarded target a living status document, not just this repo** — `docs/STATUS.md`
  here is maintained by the docs phase and cited from `CLAUDE.md`'s reading table; a target project
  gets neither by default, so whatever stands in for one is hand-written and goes stale the next
  time a task lands. Onboarding already creates an issue template, an idea inbox and a control
  fixture; a status file and its reading-table row are the same kind of cheap one-time wiring, and
  they are what make the docs phase maintain it afterwards.
  The pay-off is per-target and repeats: every future adoption inherits a status document a machine
  keeps current, instead of one more file that decays and is caught only when a review happens to
  look. 2026-07-31

- **Reconcile a target's spec against the merged tree at planning step 0** — the entry *Have the
  docs phase tick the box* records the drift; this is the other end of the same failure. A
  planning session reads the spec
  as the statement of what is unbuilt, so a stale box means the session is cut against a false
  picture, and the alternative that actually happened was auditing the checklist by hand before
  every planning session.
  Worth parking separately because the fix sits in a different place and survives the other one
  failing or being judged too risky. Step 0 already reads this inbox, so it is the natural place to
  also diff open spec items against what is merged — and *detecting* that a box's claim is already
  true is mechanical in a way that ticking is not, because it needs no judgment about whether the
  claim is gated. Reporting a candidate list to a human is strictly safer than editing the spec.
  `Related:` *Have the docs phase tick the box* — either alone leaves the other half. 2026-07-31
  *The id-shaped half shipped as change-log row `trace-ledger` (2026-08-04): planning step 0
  now runs `node scripts/trace.js report`, whose "work no ref points at" list is exactly the
  candidate list this entry asked for — mechanical, report-only, no spec edit. What remains
  parked is the half no ref can see: a claim satisfied by merged work that never carried an
  issue id, which only reading the code detects.*

- **Let a task report progress while it is still running, roughly every 10 minutes** — right now
  a container is opaque from the outside: nothing is visible until it exits and the run report is
  written. A task that has been going for an hour is indistinguishable from a task that is wedged,
  and the only lever is to kill it and lose the work. A periodic line — what it is doing, what it
  has finished, which attempt it is on — would make an overnight run watchable and make the
  kill-or-wait call an informed one.
  The out-channel already exists and is the natural place: `pipeline/status.js` is the sole writer
  of `/workspace/.run/status.json`, the workspace is a host mount, so anything appended there is
  readable live without giving the container a new route out. It would be evidence only, like
  `note` and `concern` — self-reported progress can never touch an outcome (hard rule 5).
  The honest catch is that an LLM cannot keep wall-clock time, so "every 10 minutes" from the
  agent's side is a hope, not an interval; a run that goes quiet would be exactly the run you most
  want a line from. Worth weighing against the deterministic alternative — the host already has the
  agent's log stream and could emit its own heartbeat on a real timer, with no LLM involved
  (hard rule 7), possibly with the agent's self-reported lines folded in when they happen to
  arrive. Which of those is right depends on whether the value is "is it alive" or "what is it
  actually doing". 2026-07-30

- **Give the docs phase a merge strategy, or batched runs will always conflict** — file-ownership
  constraints in a spec keep *code* disjoint across a batch, and on 2026-07-30 three chained tasks
  touched three different code areas with no collision at all. Every one of them also edited the
  target's DESIGN.md, README.md and SPEC.md, because the docs phase always does, so every
  merge after the first conflicted — in documentation only, never in code.
  The change-log half resolved cleanly and is evidence the convention works: both sides appended a
  row carrying its own slug, so keeping both was correct and neither renumbered the other
  (change-log row `repo-006`). The prose sections have no such convention, and that is the gap.
  Options worth weighing: an append-only convention for the doc sections a task may touch; a docs
  phase that writes to a per-task file the host merges; or simply accepting the conflicts and
  saying so in the playbook, since resolving them took one pass and no judgment. Filed rather than
  fixed because which of those is right depends on how large batches get. 2026-07-30

- **Say somewhere that a pure refactor cannot be frozen** — the freeze model assumes a task
  changes observable behaviour, because that is what an acceptance test can witness. A
  refactor's defining property is that observable behaviour does *not* change, so the whole
  class — deduplicate two implementations, collapse one rule into one place, extract a
  helper — has no honest criteria available. Two implementations that agree, and one that
  delegates to the other, are indistinguishable from outside; the only possible assertion
  is on source text, which freezes a decision instead of an outcome and fails on the next
  legitimate refactor.
  `advisors/testability.md` already rejects that criterion shape and did so correctly, but
  rejecting it is all the charter can do: it leaves a task whose entire purpose was
  structural with nothing at all, and no charter is the right place to say "this task
  should not exist." The workaround is known and good — fold the refactor into a later task
  that has a behavioural reason to touch the same code, so the cleanup rides along with
  something witnessable — but it currently lives in one project's planning draft, so every
  other project rediscovers it by spending a session drafting a spec that cannot be frozen
  and a panel pass rejecting it. §3.1 or §3.2 is the natural home. 2026-07-30
  *Found by the critic panel on the first real project, 2026-07-30.*

- **Re-read the ready queue when a worker goes idle, so finishing a task can unblock the
  next one** — `bd ready` is already blocker-aware, but `runner/run.js` reads it **once**,
  before the pool starts, and drains that snapshot. So a dependency chain cannot run in one
  batch: if B is blocked on A and A closes ten minutes in, B waits for a whole second run
  even though the host knows it is ready and a worker is sitting idle. Worth having because
  the queue this project actually accumulates is chain-shaped — `repo-sls` → `repo-teq` →
  `repo-i9y` was three batches on three separate runs, and each handoff cost a human
  starting the next one. It also compounds with the concurrency knob rather than duplicating
  it: the measured 1.28× on a two-task batch was one worker idle for 1464s with nothing to
  pick up, which is precisely the hole an unblocked task would have filled.
  Care lives in the details, not the idea: never re-claim what is already in flight, do not
  spin when the queue is genuinely dry, and bound the re-read so an unblock cascade cannot
  loop forever. Legal under hard rule 1 as-is — the host is the only thing reading Beads,
  and it already reads it exactly this way, just once.
  **Not** the same as the two forms of cross-task waiting that already exist and are fine:
  the pool has no barrier (a free worker takes the next queued item immediately), and the
  seconds that `prepare()` / `publish()` / every `bd` call spend blocking the event loop are
  a priced-in trade, load-bearing in the `bd` case — `spawnSync` is what stops two Beads
  calls interleaving over one embedded Dolt database. Blocked on: nothing; `repo-teq` has
  merged. Related: §4.12 (the runner drains the ready queue), §7. 2026-07-31

---

## Promoted

Ideas that made it out, and what they became. Kept so the trail from a half-thought to a
shipped thing survives — the same reason the `DESIGN.md` change log keeps its rationale.

| Date | Idea | Became |
|---|---|---|
| 2026-08-04 | Record spec-to-code traceability at the moment it is created, instead of inferring it later — a ticked box carries the id of the issue that ticked it, so reconciliation is mechanical and nothing ever guesses an edge. The cheapest honest version of a knowledge graph; parked and promoted the same day because it collapses six drift entries into one convention | change-log row `trace-ledger`: the convention, `scripts/trace.js` (report + deterministic backfill via `git log -L`), the Docker-free suite `scripts/test-trace.sh` / `tests/unit/trace.test.js`, and the PLANNING.md step-0 drift read |

## Dropped

Ideas considered and consciously declined, with the reason. Worth as much as the promoted
list: it is what stops the same idea being re-raised every few months.

| Date | Idea | Why not |
|---|---|---|
| 2026-07-31 | A documentation-updater agent owning "all relevant documentation", maintaining its own list of the documents that need writing to | The mechanism was under-used, not missing. The docs phase already maintains every file named in `CLAUDE.md`'s reading table — nine container-authored commits have amended `docs/STATUS.md` — so the fix is to *name the files*, not to add an agent. A second agent would duplicate a phase that exists and put an LLM where hard rule 5 wants evidence only. The half worth keeping became the inbox entry on telling the docs phase which files it owns |
