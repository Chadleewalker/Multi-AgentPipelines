# Idea threads

An **idea thread** is a thought being worked between sessions. Each one gets a durable
identity file here, `docs/threads/<slug>.md`, from its first exchange — DESIGN.md §3.8,
change-log row `thread-identity-files`.

The point is that the *session* becomes the disposable half. Everything a thread knows —
the question, the current proposal, the decisions taken and by whom, what is still open —
lives in one file, so any fresh session picks the thread up by reading it, and the session
that was working it can be killed without losing anything. That is what makes many
parallel working sessions cheap to run and cheap to abandon.

**A thread is not a commitment.** Like `docs/IDEAS.md`, an entry here claims nothing about
whether the idea is good, sized, wanted, or ever going to happen. Nothing in `runner/` or
`pipeline/` reads this directory and no thread file is a Beads issue — an inbox that can
start a container is not an inbox, and neither is a thread.

## Where a thread sits

```
docs/IDEAS.md entry  ──(overflow, when the idea is being worked)──►  docs/threads/<slug>.md
        │                                                                    │
        └──────────────►  DESIGN.md section (+ change-log row `<slug>`)  ──►  spec + frozen
                                                                              tests ──► issue
```

The inbox entry stays a paragraph forever. The thread file carries the structure the inbox
deliberately refuses to hold, which is why `docs/IDEAS.md` can keep its "resist adding
structure" rule intact. Threads are opened for the entries being worked; most inbox
entries never get one.

Not every thread starts in the inbox — a user directive, a run finding or a review can
open one directly. The `origin:` line says which.

## The rules

- **One repo, one boundary.** A thread lives in the repo it is about. A thread about a
  target project opens in *that* project's `docs/threads/`; a thread opened here names no
  target. Same rule as `docs/IDEAS.md`, and `scripts/test-sanitize.sh` reads the tracked
  tree as bytes to enforce it.
- **The slug is the filename, and it is the change-log ref this thread will use if it is
  ever promoted.** `docs/threads/thread-identity-files.md` reserves change-log row
  `thread-identity-files`. Kebab-case; `scripts/test-changelog.sh` already enforces that
  refs are unique across the log, so a collision is caught by a suite that exists.
- **Never date a filename.** A date reads as immutable and an agent will not rewrite such
  a file — correctly, because a dated file is a record of that date. A thread is worked and
  amended until it is discharged.
- **Exactly one section is mutable.** *Current thinking* is rewritten in place; Decisions,
  Log and Outcome append. That asymmetry is the whole discipline, and it is what the
  DESIGN.md change log, the `docs/IDEAS.md` Promoted/Dropped tables and the attempt log all
  already do.
- **Date every decision and mark whose call it was** — `(user)` or `(drafter)`. Hard rule 4
  splits that ownership, and which half decided a thing is the fact most likely to be needed
  later and least likely to survive a session.
- **Opening a thread costs a header and one log line.** If it costs a form it will not
  happen at the moment it is free, which is the doctrine `docs/IDEAS.md` was written around.
- **Flat directory.** No subdirectories, no index file. Status lives in the header, so the
  live list is a grep.

## Statuses

| Status | Means |
|---|---|
| `open` | being worked |
| `parked` | deliberately not being worked — say until what |
| `ready` | has a decision-shaped answer waiting for a planning session; PLANNING.md step 0 reads for these |
| `promoted` | became a design section, a spec, or a change-log row — `Outcome` says which |
| `dropped` | consciously declined — `Outcome` says why |

`grep -l "^status:   open" docs/threads/*.md` lists the live ones.

**Closed threads stay.** A promoted or dropped thread file is not deleted and is not
edited further. What stops an idea being re-raised every few months is the recorded
reason, and the reason lives here rather than in a one-line table cell — the same warrant
as the DESIGN.md change log's *Why* column and the `docs/IDEAS.md` Dropped table.

## Template

Copy this, fill the header, write one log line, and stop. Everything else accretes.

````markdown
# Thread — <one-line title>

```
slug:     <kebab-case, = filename, = future change-log ref>
status:   open
opened:   <YYYY-MM-DD>
origin:   <docs/IDEAS.md entry / user directive / run finding / review>
related:  <design sections, change-log rows, other threads>
```

**The question this thread has to answer:** <one or two sentences — what would have to be
true for this thread to close>

## Current thinking

<the live proposal; rewritten in place each session, not appended to>

## Decisions

- <YYYY-MM-DD> — <what was decided, and the reason in a clause> (user / drafter)

## Open questions

- <what is undecided, and what would settle it>

## Log

- <YYYY-MM-DD> — <what happened this session, what changed in the repo>

## Outcome

*(empty until the thread closes — then: promoted to what, or dropped and why)*
````

## No tooling, deliberately

There is no `scripts/threads.js`. A grep over a flat directory answers every question a
reader has today, and a reader written before there are ten threads would be guessing at
what to report — the same restraint DESIGN.md §5 applied to the run-corpus audit, which
was written only after the corpus had been read by hand once.
