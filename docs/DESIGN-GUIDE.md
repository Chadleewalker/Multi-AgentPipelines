# DESIGN-GUIDE.md — writing a design document that stays authoritative

How to produce a design document that can act as a project's constitution: the thing task
specs are derived from, the thing a disagreement is settled against, and the thing that is
*amended* rather than ignored when reality turns out differently.

Scope: a new project, or a new area of an existing one large enough that the decisions need
to exist before the code does. Small standalone chores skip the doc layer entirely and enter
at the spec level (`DESIGN.md` §3.2, step 3) — the guide below is for the doc-first path,
which is the default for anything else.

This is written from one worked example. `DESIGN.md` in this repository has absorbed roughly
forty amendments without ever being rewritten, and the sections that made that possible are
not the ones that describe the system.

## The one test

**Every line is a decision, a contract, or an exclusion.** Anything else is description, and
description is the part that rots — it is a snapshot of an implementation that changes
underneath it, so within two months the doc is confidently wrong and nobody trusts the rest
of it either.

A decision with its reason never goes stale, because it is a record of a moment: *this was
chosen, over that, because of this.* Even when the decision is later reversed, the record
stays true and the reversal has something to argue against. That asymmetry is the whole
reason a design doc can outlive the code it describes.

Length is not the enemy. A long document where every line carries a decision is cheap to
read, because a reader looking for one answer finds it and leaves. A short document of
aspirational prose is expensive, because nothing in it can be relied on and every line has
to be re-checked against the code.

## The sections, in order

Order matters less than presence, but this order front-loads what a reader needs in order to
decide whether to keep reading.

### Status line

One line at the top: is this a draft, or is it approved to build from, and as of when.

*How it fails without one:* a reader cannot tell whether they are looking at a proposal or a
constitution, so they treat every section as negotiable — which is exactly what the document
exists to prevent.

### Goal — one paragraph

What changes for the person using the system, in prose, with no component named. If the goal
cannot be written without naming a component, the goal is not yet understood: what has been
written down is a design sketch wearing a goal's clothes.

Include the boundary of the artefact here too — what lives in this repository versus what it
operates on — because it is the question every later section implicitly answers.

### The shape — one diagram

Boxes, arrows, phases, and the seams between them. This is the one place a *description* pays
for itself, because it is the map every later section hangs off, and it is stable: the shape
of a system changes far more slowly than its implementation.

Keep it in plain text, or in a diagram format that lives in the repository, so that it is
amended in the same change as the decision it draws.

### Invariants — the "hard rules"

The handful of properties that, if removed, break the **design** rather than merely the code.
Each one gets its reason stated in the same breath.

This is the highest-value section in the document. It is what stops a later contributor —
or a later agent, or you at eleven at night — from simplifying away something load-bearing,
because the reason travels with the rule and can be weighed instead of guessed at.

Two tests for whether something belongs here. *Would removing it produce a system that still
works but can no longer be trusted?* Then it is an invariant. *Would removing it produce a
system that is merely worse?* Then it is a decision, and belongs in the decisions section.

Keep the list short. A document with thirty invariants has none, because nobody holds thirty
rules in mind, and a rule nobody holds is a rule that is quietly broken.

### Decisions, each with the rejected alternative named

The bulk of the document. One subsection per decision, or per cluster of decisions about one
concern.

A decision recorded without its discarded alternative gets re-litigated. The next reader sees
only the choice, cannot see what it was chosen over, and has no way to tell a deliberate
trade-off from an accident — so they re-open it, at full cost, and often reach the same
answer. Naming the alternative is one sentence and it closes the question permanently.

Where a decision was made *because* something else failed, say what failed. Those are the
lines a later reader finds most useful, and the ones nobody thinks to write.

### Contracts between separately-built parts

Exact interfaces: field names, schema shapes, exit codes, file locations, the vocabulary of
statuses. Written precisely enough that two people — or two agents — building either side,
with no contact between them, produce parts that fit.

State the dividing line explicitly: **anything touching two or more independently-built
components is decided here; anything confined inside one component is delegated to whoever
builds it.** Without that sentence a design doc either drowns in naming trivia or leaves a
seam undefined, and only one of those two failures is visible before integration.

### An exhaustive outcome table

Every end state the system can reach, enumerated, with what each one means and what happens
next. Not a description of the happy path with error handling appended.

This is typically the densest and most reused section in the whole document, because it is
what converts "handle failures sensibly" into something checkable. It is also the section
that catches missing design: an outcome nobody can name is an outcome nobody has designed,
and it will be reached anyway.

### Out of scope — agreed

Each exclusion with two things: the reason it is excluded, and the condition that would
reopen it.

The reopening condition is the part usually missed, and its absence is why exclusions get
violated instead of revisited. An exclusion that reads as permanent gets quietly worked
around by whoever needs it; an exclusion that says *"not until X"* gets brought back as a
proposal, which is the outcome wanted.

### Assumptions

Everything the design rests on that has not been verified. Written as falsifiable statements
rather than as background — the point is that a later reader can check one and find it false.

State the protocol in the section itself: **an assumption proven false is an amendment, not a
workaround.** And when one is amended, strike it through rather than deleting it. The trail of
what was believed, and when it stopped being true, is the most useful thing the section
accumulates.

### Open questions

Say "None" explicitly when there are none. A missing section is ambiguous — it might mean
resolved, or forgotten, or never asked. An empty one is a claim, and a claim can be wrong in
a way a silence cannot.

Where a question was resolved by *delegating* it, say so and name the boundary the delegate
must stay inside. That is a different thing from an open question and should not look like one.

### Readiness bar

The test for "this document is finished enough to build from," written before the reviews
start.

This section is rare and worth having. Review rounds have no natural end — critics asymptote
toward zero findings but essentially never reach silence — so without a stated bar the doc is
reviewed until someone loses patience, which is a schedule decision masquerading as a quality
one. A workable bar is *no blocker findings and no finding that requires a decision from the
user*; every remaining finding must have an obvious default inside rules the doc already sets.

Pair it with a constructive check, not only a negative one. Here that is a dry-run
decomposition: slice the document into task-sized specs and confirm every one of them has a
fillable "done means" list and a citation back to a section. A document that cannot be
decomposed is not ready, however clean its review came back.

### Change log

Append-only, oldest at the top, one row per amendment: date, reference, what changed, why.

Identify rows by a stable text label — a short hyphenated name — never by a version number.
Version numbers cannot survive parallel work: two contributors fork from a base where a
number is free, each takes it, and two rows arrive claiming the same version. In this
repository that happened twice before the convention changed (change-log row `repo-qyd`).
Where a row comes from a tracked piece of work, use that work's own identifier, so the label
is unique by construction and nobody has to invent one.

The "why" column is what makes the log worth keeping. A log of *what changed* is a diff, and
git already has it. A log of *why it changed* is the only record of which decisions were
deliberate rather than drifted into.

## The rules that make it hold

Four process rules. Without them the sections above decay into documentation.

**Derived documents cite it; they never repeat it.** A task spec says "see §4.4" and does not
restate §4.4. A restatement is a second source of truth, and the copy is reliably the one
that is wrong — it was correct when written and nothing updates it.

**When reality disagrees with the doc, amend the doc.** Not "ignore it this once." This single
rule is the difference between a constitution and a wish list, and the change log is the proof
that it was followed.

**Progress lives somewhere else.** Where the build actually is, what is proven, what is next —
a separate status document. Mixed in, the design doc rots at the speed of the work, and once a
reader finds one stale progress note they discount the decisions too.

**Amendments are cheap; rewrites are not.** A design doc that is rewritten has lost its
history, and its history was the asset. Add a section, strike a sentence, append a row.

## What to leave out

- **Code.** A snippet that must stay in sync with an implementation will not.
- **Detail confined inside one component.** Delegate it, and say in the doc that it is
  delegated, so a reader does not go looking for it.
- **Anything the code already states plainly.** The doc explains the decisions the code cannot.
- **Progress, status, and task lists.** Separate documents, different lifetimes.
- **Unformed ideas.** They need a cheaper home — an idea inbox that commits to nothing — or
  they arrive dressed as design decisions nobody actually decided. See `docs/IDEAS.md`.

## Producing one

The process, as `DESIGN.md` §3.2 step 1 defines it:

1. **The interview — the six named questions below,** shown to the person in full before the
   first one is asked. The bound is the *list*, not a count: an unbounded interview produces a
   transcript, and a transcript is not a design, but a count with no questions attached is
   worse — it licenses a different improvised set every session under the same name. Show the
   list first for a plain reason: someone who cannot see what will be wanted later cannot tell
   whether their answer to question 1 belongs in question 1 (change-log row
   `design-interview-questions`).
2. **Draft it.** The sections above, in that order.
3. **Doc-level critics, in fresh context.** Independent reviews that simulate the questions
   development will ask. Fresh context is the mechanism, not a convenience — a reviewer primed
   with the drafter's reasoning inherits the drafter's blind spots, and independence is the
   active ingredient being bought.
4. **Turn unresolved unknowns into explicit assumptions,** and get those approved with the doc
   rather than resolved before it. An unknown named as an assumption is tracked; an unknown
   left implicit is a surprise later.
5. **Test it against the readiness bar,** including the dry-run decomposition.
6. **Then, and only then, decompose into work.**

Expect several rounds, and expect them to converge rather than terminate. In this repository
three rounds went from roughly twenty findings to seven to four, and round three produced
nothing requiring a decision from the user — which was the bar, and was the signal to stop.

### The six questions

Each one fills a section the drafter cannot fill alone. Nothing else in the document needs the
person at all — the rest is derived and brought back to them as decisions with reasons.

| # | Question | Fills |
|---|---|---|
| 1 | **What is it, and what changes for whom?** What the thing does, who uses it, and what is different for them once it exists. Including the boundary: what this thing *is*, versus what it merely operates on. | Goal; the shape |
| 2 | **What must never happen?** The failure that would make it worse than not having the thing at all — the one that, having happened once, ends trust in it. | Invariants; the outcome table |
| 3 | **What is deliberately not in it — and what would reopen each exclusion?** | Out of scope |
| 4 | **What does the first usable version do, and what waits?** Where the line sits for "worth using even though it is incomplete." | Phasing; readiness bar |
| 5 | **What is fixed and outside their control?** Environment, systems it must obey, things it must run on — plus anything being *assumed* true but not checked. | Constraints; assumptions |
| 6 | **What have they already decided to use** — architecture, layout, libraries, tooling — and for each, is it **forced or preferred**? | Decisions |

**Questions 5 and 6 are separate on purpose,** and collapsing them is the mistake this split
was made to prevent. A *forced* constraint is designed around and never revisited, because
nothing about it changed. A *preferred* one is a decision whose recorded reason is the person
who asked for it, and it is revisited if that reason stops holding. Recorded as the same
thing, a document ends up carrying a constraint nobody can trace beside a preference nobody
dares question, and no reader can tell which is which.

**What the interview does not ask.** Architecture, file layouts, libraries, test frameworks,
build approach — never as a *question*. Asking makes the choice the person's to guess at, and
in this repository the division of labour is explicit: the user approves **what**, the AI owns
**how** (`CLAUDE.md` hard rule 4). Question 6 is not a breach of that rule but its complement:
hard rule 4 stops someone being asked to pick an implementation, it does not discard a choice
they already hold. A direction that arrives unprompted is input, and it is recorded — the only
question about it is *forced or preferred*.

If the drafter catches itself asking one of the excluded questions anyway, that is a defect in
the process, not a gap in the answers. Note it and derive the answer instead.

**Follow-ups are legal and bounded.** Expect two or three after the draft, where it hit
something the six did not reach — shown as a list, the same way, not dripped one at a time. If
it takes more than three, the six are wrong and the fix belongs here rather than in the
conversation.

## Skeleton

```markdown
# <Project> — Design

> Status: DRAFT | READY v1.0 (<date>) — <one line on how it got here>

<What this document is: the decisions made and why, and what is out of scope. Derived specs
cite it and do not repeat it. When reality disagrees with it, it gets amended.>

## 1. Goal
## 2. The shape            <- one diagram
## 3. <Concern>            <- decisions, each with the alternative it beat
## 4. <Concern>
##    ... Contracts        <- schemas, vocabularies, exit codes
##    ... Outcomes         <- the exhaustive table
## N. Invariants           <- or up front, if they are the point of the design
## N+1. Phasing            <- what is V1, what is deliberately later
## N+2. Out of scope (agreed)
## N+3. Assumptions (approved with this doc)
## N+4. Open questions
## N+5. Readiness bar
## N+6. Change log
```

Invariants can sit early or late. Early if the design exists *because* of them — a safety or
security boundary, say. Late is fine when they are consequences of decisions made above them.

## Failure modes, observed

- **The descriptive doc.** Reads as an architecture tour. Nothing in it can be argued with,
  because nothing in it was decided. Symptom: no section names an alternative.
- **The doc with no exclusions.** Everything is in scope, so scope creep is undetectable, and
  every new idea appears to be consistent with the design.
- **The doc that was ignored once.** The first silent divergence is the expensive one: after
  it, the doc is known to be unreliable, and the next contributor checks the code instead.
  Nothing in the document announces that this has happened.
- **The unnamed interview.** A process that specifies *how many* questions and not *which*
  runs a different improvised set every session under one name, and the person answering
  cannot tell whether what they are about to say belongs in this answer or a later one. This
  guide shipped with that defect and it was caught on first use (change-log row
  `design-interview-questions`).
- **The version-numbered change log.** Works until two people work in parallel, then collides.
- **Invariants without reasons.** They read as arbitrary, so they get optimised away by
  somebody being helpful.
- **The doc that decided the naming and skipped the seam.** Pages of field spellings inside
  one component, nothing on the interface between two. The delegation dividing line prevents
  this, which is why it is worth stating rather than assuming.
