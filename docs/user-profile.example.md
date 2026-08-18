# user-profile.example.md — how an agent should talk to *you*

Every person using this pipeline needs a **user profile**: a short file saying how an agent
should pitch what it writes to you. It is a once-per-person, once-per-machine setup step,
listed in `SETUP.md` Part A beside installing `bd` and getting a token, and decided in
`DESIGN.md` §6.1 (change-log row `user-profile`).

**The easy way is `/profile`.** Run it in this repo and it interviews you, then writes your
profile for you. This file is what that command follows — and the reference for anyone who
would rather write theirs by hand.

## Where the live copy goes

**`~/.claude/CLAUDE.md`.** That path loads into every session in every project on the
machine, with nothing to configure and nothing to wire up.

Resist the tempting alternative of keeping the real file in a repo and pulling it in with an
`@import`. An import is a mechanism that can silently stop resolving, and you get no error
when it does — you get months of an agent pitching explanations at the wrong level and no
way to notice. A profile is exactly the kind of file whose *absence* is invisible, so it
belongs somewhere that cannot fail to load. Keeping a copy in a repo as a backup is fine if
something **copies** it into place (a copy that fails leaves the last good file; a link that
breaks leaves nothing) — just make sure only one of them is live, or they will drift and you
will not be able to tell which is being obeyed.

A filled-in profile describes a person, so it never belongs in this repository:
`docs/user-profile.md` is git-ignored, on the same boundary that keeps `runs/` out.

## What the profile sets, and what it doesn't

**Scope is interactive sessions only** — planning, review, and the conversation around them.
Your profile never reaches a task container, and it changes nothing about the code or
documentation the pipeline writes. Those are read by whoever maintains them next, so their
register belongs to the repo. Only the conversation belongs to you.

### One setting: your rung

Two things vary independently, and a single "how technical are you" scale collapses them:

- **Systems fluency** — reasoning about failure modes, invariants and trade-offs.
- **Software vocabulary** — whether `merge-base`, bind mount or CRLF mean anything.

Someone who directs work they do not personally build is high on the first and low on the
second. A one-dimensional ladder seats them next to a reader who follows neither, and the
answers they get drop caveats to be shorter — failing the profile in the course of obeying
it. So the rule is **simplify the words, never the argument.**

The five rungs are the sensible pairings. You pick one; that is the only level you set.

| # | Reader | Systems | Vocabulary | What changes |
|---|---|---|---|---|
| 1 | Senior programmer | high | high | Paths, refs and jargon as shorthand; the mechanism is assumed |
| 2 | Entry-level programmer | medium | medium | Code and git basics assumed; deeper mechanics named and explained |
| 3 | Engineer or specifier, not a programmer | high | low | Full reasoning, each software term defined in a few words as it is used; no analogies needed |
| 4 | Non-technical professional | medium | none | Analogies carry the mechanism; reasoning intact, no jargon |
| 5 | Outsider | low | none | The point and why it matters; mechanism dropped |

### Two modes, the same for everyone

Not settings — house rules that apply at every rung, in that rung's words.

- **Explaining** — lead with the answer, then the mechanism.
- **Reporting** — lead with what it means for you; say whether anything is at risk; name
  what it costs; give mechanism only where a decision turns on it.

### Three things a profile may not switch off

State whether anything is at risk, *including when nothing is*. Lead with the answer. Ask
for one decision at a time. These are safety properties of the review gate, not taste — the
risk line is what decides whether a human looks harder at a pull request, and a profile
trimmed for brevity would cut it first.

**Free per person:** the rung, how much mechanism you want, whether analogies help, how long
an answer you will read.

---

# The interview

What `/profile` runs. Three steps, in this order. Anyone writing a profile by hand can work
through it alone; anyone conducting it for someone else should follow it verbatim.

## Step 1 — marker terms (vocabulary)

Ask, in exactly this shape:

> Read down these lines. A term "lands" if you could explain it to someone else, not just
> recognise it as a word you have seen. **Which lines can you explain?**
>
> - **Line A** — repository · commit · branch · pull request
> - **Line B** — merge · test suite · environment variable · exit code
> - **Line C** — rebase · stdout · container image · dependency pin
> - **Line D** — fork point · bind mount · CRLF · ephemeral port
> - **Line E** — `spawnSync` buffer limit · ENOBUFS · a custom git ref
>
> Any subset is a fine answer, including none. Partial lines are more useful than a single
> number — say which terms.

Reading: A only → rung 4 or 5. A and B → rung 3. Through C → rung 2. D or E → rung 1.

**Never ask "which line stopped you".** That asks a person to report a deficit, and people
round that in the flattering direction, which biases the whole instrument *upward* — the one
direction that fails without anybody noticing.

## Step 2 — two reasoning questions (systems fluency)

Deliberately free of software vocabulary, so they separate "does not know the words" from
"cannot follow the argument". Ask both:

> 1. You finish a job, then write the pass/fail criteria for it by looking at what you
>    produced. What have you proved?
> 2. If the thing being measured can edit the measuring device, what is the measurement
>    worth?

Good answers, in substance: (1) only that the work matches its own description — nothing
about whether the description was what anyone needed. (2) Nothing.

Answering both without help means high systems fluency. **Take rung 3 regardless of where
step 1 landed**, unless step 1 reached line C or beyond. That combination — reasons fine,
does not know the words — is exactly the one a single "how technical" scale gets wrong.

**Each question must pose a situation and ask for a judgement.** A statement followed by
"is that obvious to you?" is not a question, it reads as a trick, and its answer measures
nothing. An earlier draft of question 1 was written that way and confused a subject whose
systems fluency turned out to be high.

## Step 3 — read and pick (the one that actually decides it)

Show the samples below at the rung steps 1 and 2 suggest, plus the rung either side. Ask
which one lands. **This outranks the other two steps**, because it is the product rather
than a proxy for it.

**Every sample defines every term it uses.** A sample that assumes knowledge of this
pipeline measures familiarity with the pipeline, not reading level — and a reader who cannot
tell whether they are lost on the writing or on the subject will blame themselves.

The topic below is one project's run lock. Any topic works; these are calibrated.

**Rung 1**

> One run per project, enforced by a lock file written under `runs/locks/` before the queue
> is drained; a second run against the same canonical target path is refused by name at
> preflight. The lock carries `runId`, `pid` and `startedAt`, and a holder that is not live
> is taken over rather than refused, so a killed run cannot wedge the project. Never remove
> one by hand — against a live holder it is the only way to get two runners draining one
> queue.

**Rung 2**

> A "run" is one session of the pipeline working through the task queue — many tasks per
> run, several at once if concurrency is set. The runner takes a lock before it starts: a
> small file under `runs/locks/` named for the project. If one is already there, the second
> run refuses to start rather than colliding with the first.
>
> The file records the process that wrote it. If that process is gone — you killed the run —
> the next run sees the holder is dead and takes the lock over instead of refusing. A
> crashed run never wedges the project, and you never delete the file yourself.

**Rung 3**

> A "run" is one session of the pipeline working through your task queue. One run does many
> tasks — it takes them off the queue one after another, and if you have turned on
> concurrency it works on several at the same time. What you cannot have is two *runs*
> pointed at the same project at once.
>
> So before anything starts, the runner writes a small file that says "this project is
> taken," and refuses to start if one is already there. When the run finishes it deletes the
> file.
>
> The awkward case is a run you killed halfway — the file survives, and the project looks
> permanently taken. So the file also records which process wrote it. If that process is
> gone, the next run takes the lock over instead of refusing. That is why you never delete
> one by hand: doing it while a run is genuinely live removes the only thing stopping two
> runs from working on the same code.

**Rung 4**

> Think of a meeting room with a sign-in sheet on the door. Before the pipeline starts work
> on a project it signs the sheet, and it will not start if another name is already there.
> That is what stops two sessions editing the same code at once. When it finishes, it signs
> out. (One session works through a whole list of jobs, not one job — many jobs, one
> session.)
>
> If a session is interrupted the name stays on the sheet, and the room looks occupied
> forever. So the sheet also records *who* signed in, and the next session checks whether
> that person is still in the building. If they have gone, it takes the room. That is why
> you should never rub a name off yourself — do it while someone really is in there and you
> get two sessions in one room.

**Rung 5**

> Only one job at a time can work on a project, so two of them cannot overwrite each other.
> The system handles that itself, including when a job is interrupted. There is nothing for
> you to do.

## Closing the interview

**Start one rung lower than the interview suggests, if it is close.** The costs are not
symmetric: one rung too low costs a slightly longer answer you would have understood
anyway; one rung too high costs a decision made on something you did not quite follow, and
you will not know it happened.

Show the person the file before writing it, then write `~/.claude/CLAUDE.md`.

---

# The template

Everything below the line is meant to be copied and edited. It is written in the first
person, so it reads as your own standing instruction rather than a description of you —
which also means it never has to refer to you in the third person.

**Write nothing you cannot support.** A guess in a profile is worse than a gap, because the
agent cannot see that it is a guess and will act on it confidently for a long time. Start
short and add lines as you catch yourself giving the same correction twice.

---

# Working with me

## Who I am

<!-- One or two sentences: what you own, what you delegate. State whether a direction from
     you is settled or an opening position. -->

**What to assume I know:** <!-- the domain, the architecture, the product -->

**What to explain rather than assume:** <!-- Be specific and honest. "Not fluent in git and
     container mechanics" is far more useful than "non-technical", and it stops an agent
     over-explaining the things you are strong at. -->

## How to talk to me

**My level — rung N of 5.** <!-- Name the rung and then describe it, so the line still works
     if someone reads it without the table. Say where your vocabulary stops, using terms
     from the marker lines: "I stop knowing the words at around `rebase` and `stdout`;
     repository, commit, branch and exit code are fine." Say what follows from it: full
     reasoning, terms defined as used, analogies or not. -->

**This profile outranks the writing style of whatever repo you are in.** Project
documentation is often dense and clause-heavy. That is the register for documents, not the
register for talking to me. Where they disagree, this wins.

**Two modes — pick the right one:**

- **Explaining** — lead with the answer, then the mechanism.
- **Reporting** — lead with what it means for me; say whether anything is at risk; name what
  it costs; give mechanism only where a decision turns on it.

Then, in both modes:

- **Simplify the words, never the argument.** Don't drop a caveat, round off a trade-off, or
  skip the thing that makes a decision hard. Shortening an answer by cutting reasoning is
  failing this instruction, not obeying it.
- **Use the real term, then define it in a few words.** <!-- Cut this if you would rather
  not learn the vocabulary; keep it if you would. -->
- **One thing at a time.** Ask one question, wait, then ask the next.
- **Give me a recommendation, not a survey of options.**
- **Say explicitly whether anything is at risk.** If nothing is, say so. Not optional and
  never trimmed for brevity.
- **No flattery and no preamble.**
- **When something has gone wrong:** <!-- how you want an error reported, and how much
  post-mortem you actually want -->

**I can override the rung mid-conversation** — "give me that at rung 2" — and you re-pitch
on the spot. This file sets the default, not the session. If I override in the same
direction more than once or twice, say so: the rung line is wrong and should be edited
rather than worked around.

## How much to do before checking in

<!-- The most consequential section after the rung. Say where the line is between "just do
     it" and "ask me first", and keep the ask-list short and concrete — a vague one gets
     applied to everything. Destructive, irreversible and outward-facing are the usual
     three. -->

## Standing defaults

<!-- Decisions you have already made and do not want re-litigated each session. -->

- **Commits and pushes:** <!-- who initiates them -->
- **Where the handoff boundary is:** <!-- e.g. open the PR and stop; merging is mine -->
- **Where work for my approval goes:** <!-- a repo file, not a scratchpad or chat -->

## Pronouns

<!-- Only needed if the agent will write *about* you — PR descriptions, reports, handoffs to
     other agents. The template above is first-person, so ordinary conversation never needs
     them. Omit this section entirely if you would rather not say; a neutral default is used
     when it is absent. -->
