# user-profile.example.md — a template for how an agent should work with *you*

Copy this, fill it in, and put the live copy where your agent actually reads it. Your
filled-in copy is host-only: `docs/user-profile.md` is git-ignored, because a profile
describes a person and this repo documents the machinery, never the people or the work
done with it.

## Where the live copy goes

**Put it at `~/.claude/CLAUDE.md`.** That path is loaded into every session in every
project on the machine, with no configuration and nothing to wire up.

Resist the tempting alternative of keeping the real file in a repo and pulling it in with
an `@import`. An import is a mechanism that can silently stop resolving, and you get no
error when it does — you get months of an agent pitching explanations at the wrong level
and no way to notice. A profile is exactly the kind of file whose *absence* is invisible,
so it belongs somewhere that cannot fail to load.

Keeping a copy in a repo is fine as a backup or a draft; just make sure only one of them
is the one that's live, or they will drift and you will not be able to tell which one is
being obeyed.

## What actually earns its place

The instinct is to write a personality brief. Don't. The sections below are the ones that
change an agent's *output*; anything that doesn't change output is decoration that costs
context on every single turn.

The highest-value section by a wide margin is the fluency map. An agent will otherwise
infer your expertise from the sophistication of what you're asking for — which is
backwards for anyone who directs work they don't personally execute.

**Write nothing you can't support.** A guess in a profile is worse than a gap, because
the agent can't see that it's a guess and will act on it confidently for a long time.
Start short and add lines as you catch yourself giving the same correction twice.

---

## The template

Everything below the line is meant to be copied and edited. It's written in the first
person, so it reads as your own standing instruction rather than a description of you —
which also means it never has to refer to you in the third person.

---

# Working with me

## Who I am

<!-- One or two sentences: what you own, what you delegate. State whether a direction
     from you is settled or an opening position. -->

**What to assume I know:** <!-- e.g. the domain, the architecture, the product -->

**What to explain rather than assume:** <!-- Be specific and be honest. "Not fluent in
     git and container mechanics" is far more useful than "non-technical", and it stops
     an agent from over-explaining the things you're strong at. Add the guard if you need
     it: don't infer my fluency from the sophistication of what I'm directing. -->

<!-- Optional and often useful: whether you run several projects at once, and whether
     you're typically mid-task elsewhere when you ask something. -->

## How to talk to me

<!-- Keep these as imperatives. Suggested starting set — cut what doesn't apply: -->

- **Lead with what it means for me, then name the mechanism.**
- **Say explicitly whether anything is at risk.** If nothing is, say so.
- **Give me a recommendation, not a survey of options.**
- **Answer length:** <!-- e.g. the answer in two sentences, detail below -->
- **No flattery and no preamble.**
- **When something has gone wrong:** <!-- how you want an error reported and how much
     post-mortem you actually want -->

## How much to do before checking in

<!-- The single most consequential section after the fluency map. Say where the line is
     between "just do it" and "ask me first", and make the ask-list short and concrete —
     a vague one gets applied to everything. Destructive, irreversible, and outward-facing
     actions are the usual three. -->

<!-- Worth adding if it's true of you: how this changes when you're busy elsewhere. -->

## Standing defaults

<!-- Decisions you've already made and don't want re-litigated each session. Common ones: -->

- **Commits and pushes:** <!-- who initiates them -->
- **Where the handoff boundary is:** <!-- e.g. open the PR and stop; merging is mine -->
- **Where work for my approval goes:** <!-- a repo file, not a scratchpad or chat -->

## Pronouns

<!-- Only needed if the agent will write *about* you — PR descriptions, reports, handoffs
     to other agents. The template above is first-person, so ordinary conversation never
     needs them. Omit this section entirely if you'd rather not say; a neutral default is
     used when it's absent. -->
