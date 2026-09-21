# Thread — give every idea thread a durable identity file

```
slug:     thread-identity-files
status:   promoted (2026-08-19)
opened:   2026-08-19
origin:   docs/IDEAS.md, top entry, 2026-08-19 ("Give every idea thread a durable
          identity file from its first exchange, so the session working it is disposable")
related:  DESIGN.md §3.8 and change-log row `thread-identity-files` (what this became);
          docs/IDEAS.md session-ledger entry (same information, for the record rather than
          for revival); docs/handoff-sweep-trustworthy.md (the undated living-document
          precedent); PLANNING.md steps 0 and 5; DESIGN.md §3.6 (the promotion rule this
          copies); change-log row `trace-ledger` (identity assigned at creation)
```

**The question this thread has to answer:** where a thread's state lives, what it holds,
and how the existing promotion path finds it — such that any fresh session can pick up a
half-thought idea at zero cost, and the session that was working it can be killed without
losing anything.

**This file is both the proposal and the first thread file.** Read §Current thinking as the
proposal that was approved; the Decisions, Open questions, Log and Outcome sections below
are the file doing its actual job. The convention and its template live in
[`README.md`](README.md); this file is the worked example, not the spec.

---

## Current thinking (the proposal — rewritten in place, never appended to)

### 1. Where they live

**`docs/threads/<slug>.md` in the repo the thread belongs to. Tracked, flat, undated.**

Four properties, each forced by something already decided here:

- **Tracked, not under `runs/`.** `runs/` is git-ignored host-only run data (`.gitignore`,
  DESIGN.md §4.12). A thread file is intent about the machinery, which is the same class as
  `docs/IDEAS.md` and `docs/handoff-*.md` — both tracked. Host-only would mean a thread does
  not survive a machine, is never reviewed, and cannot be cited by a change-log row. The
  session-ledger idea's `runs/sessions/` is a different artifact and stays where it is: that
  records what a session *did*, this holds what a thread *thinks*.
- **In the repo the thread is about.** Same boundary as `docs/IDEAS.md`'s rule 1: this repo
  documents the machinery, never the work done with it. A thread about a target project's
  design opens in that project's `docs/threads/`, and a thread opened here names no target.
  `scripts/test-sanitize.sh` reads the tracked tree as bytes and will catch a slip.
- **Undated filename.** A date in a filename reads as immutable — an agent will not rewrite
  a file named for a day, and should not. That is already recorded as an IDEAS.md entry
  (2026-07-31) and is why `docs/handoff-sweep-trustworthy.md` is deliberately undated. A
  thread file is worked and amended until it is discharged, so it must not carry a date.
- **Flat, no subdirectories, no index file.** Status lives in the header, so a grep is the
  live list. A directory taxonomy and a hand-maintained index are both things that go stale
  and that people avoid using — `docs/IDEAS.md`'s grouping rule makes the same argument
  about headings.

### 2. What the slug is

**The slug is the filename, and it is the change-log ref the thread will use if it is ever
promoted.** `docs/threads/thread-identity-files.md` reserves change-log row
`thread-identity-files`.

This is change-log row `trace-ledger`'s move applied one layer earlier: identity is assigned
at the moment the thing is created, so nothing downstream has to guess an edge. One string
follows the thought from first exchange to shipped row, and `scripts/test-changelog.sh`
already enforces that slugs are kebab-case and unique across the log — so a thread file
whose slug collides with an existing row is caught by a suite that exists.

A thread may produce several change-log rows or none. The slug is the *default* ref, not a
promise of one row.

### 3. What they contain

Six sections. Exactly one is mutable; the rest append. That asymmetry is the whole
discipline — it is what the DESIGN.md change log, the IDEAS.md Promoted/Dropped tables and
the attempt log all already do, and it is why none of them can quietly lose a fact.

| Section | Mutability | Holds |
|---|---|---|
| Header block | rewritten (status only) | slug, status, opened date, origin, related refs |
| The question | fixed at open | what would have to be true for this thread to close |
| Current thinking | **rewritten in place** | the live proposal — the revival payload |
| Decisions | append-only | dated, one line each, marked whose call it was |
| Open questions | rewritten | what is undecided and what would settle it |
| Log | append-only | one line per session that touched this |
| Outcome | written once, at close | promoted to what, or dropped and why |

**Decisions is the load-bearing section**, and the reason is the same one behind
PLANNING.md's disposition rule: a decision that is silently absorbed into prose is
indistinguishable from one that was never made. "The user approved slicing", "hardware-
faithful was reversed and why" — that is exactly the class of fact the session-ledger IDEAS
entry names as surviving nowhere durable today. Marking whose call it was matters because
hard rule 4 splits ownership: the user approves *what*, Claude owns *how it is verified*.

**Statuses**, and there are only five: `open` (being worked), `parked` (deliberately not
being worked, and the note says until what), `ready` (has a decision-shaped answer waiting
for a planning session), `promoted`, `dropped`.

**Opening cost is a header and one log line.** If opening a thread costs a form, it will not
happen at the moment it is free, which is the entire doctrine `docs/IDEAS.md` was written
around. Everything below the header accretes.

### 4. Template

Held in [`README.md`](README.md), so there is one copy and it cannot drift from the
convention stated beside it. Copy it, fill the header, write one log line, and stop.

### 5. How the promotion path picks them up

The path itself does not change. A thread is state *alongside* the path, not a new stage in
it:

```
docs/IDEAS.md entry  ──(overflow)──►  docs/threads/<slug>.md
        │                                      │
        └──────────────►  DESIGN.md section (+ change-log row `<slug>`)  ──►  spec + frozen
                                                                              tests ──► issue
```

Three touch points, all small:

- **`docs/IDEAS.md` gains one optional extra**, beside `Blocked on:` and `Related:` —
  a `Thread:` line naming the file. This is the reconciliation with that file's "resist
  adding structure" rule: the inbox entry stays a paragraph forever, and the thread file
  carries the structure the inbox refuses to hold. Threads are opened for the entries that
  are being *worked*, never for all of them; most inbox entries never get one.
- **`PLANNING.md` step 0 gains a paragraph.** It already reads the inbox and runs the drift
  report; it also reads `docs/threads/` for `status: ready` threads. A ready thread is a
  candidate that arrives with its decisions already made and its open questions already
  named — which is strictly more than an inbox entry offers, and costs the session nothing
  to skip.
- **At promotion, the slug is already right.** The `DESIGN.md` change-log row takes the
  thread's slug; the IDEAS.md row moves to **Promoted** citing the thread file; the thread's
  status flips to `promoted` and its `Outcome` names what it became. A dropped thread does
  the same into **Dropped**.

**A promoted or dropped thread file stays.** Same reason the change log keeps its *Why*
column and the Dropped table exists at all: what stops an idea being re-raised every few
months is the recorded reason, and the reason lives in the thread, not in the one-line
table cell. Threads stop being edited at close; they do not get deleted.

### 6. What this must not become

- **Not a queue item, ever.** `docs/IDEAS.md`'s own rule — an inbox that can start a
  container is not an inbox. Threads live in `docs/`, nothing in `runner/` or `pipeline/`
  reads them, and no thread file is a Beads issue.
- **Not a sixth unread channel.** The IDEAS.md session-reviewer entry makes this argument
  against itself and it applies here: the fix for an unread channel is aggregation, not
  another author. The defence is that this is not a new channel — it is a *consistent shape*
  for prose that already exists in three inconsistent ones (handoff documents, planning
  drafts' permanent-value sections, and session context that survives nowhere). Threads
  should replace those, not sit beside them.
- **Not tooling, yet.** No `scripts/threads.js`. `grep` over a flat directory answers every
  question a reader has today, and a reader written before there are ten threads would be
  guessing at what to report.

---

## Decisions

- 2026-08-19 — Thread files are **tracked in `docs/`**, not host-only under `runs/`. A
  half-thought that does not survive a machine or a clone has not been made durable.
  (drafter; approved by user)
- 2026-08-19 — Filenames are **undated**; the slug *is* the future change-log ref.
  (drafter; approved by user)
- 2026-08-19 — A thread file has **exactly one mutable section**. (drafter; approved by user)
- 2026-08-19 — Promoted and dropped threads are **kept**, not deleted. (drafter; approved by
  user)
- 2026-08-19 — **No reader tool** in this change. (drafter; approved by user)
- 2026-08-19 — **The whole proposal approved as a block**, all five follow-ups authorized in
  one line ("approved — do the five follow-ups"). (user)
- 2026-08-19 — Because the design landed the same day, the `docs/IDEAS.md` entry moved
  straight to **Promoted** rather than gaining the `Thread:` line the approved follow-up list
  named. An entry cannot be in the inbox and in Promoted at once, and leaving a promoted idea
  in the inbox would contradict §3.8 on the day it shipped. The `Thread:` optional extra
  itself was added as approved. (drafter — the one deviation from the approved list, recorded
  here rather than absorbed silently)
- 2026-08-19 — The template lives **only** in `README.md`, not duplicated into this file.
  Two copies of a template drift, and this file is the worked example rather than the spec.
  (drafter)

## Open questions

- **Does `docs/threads/` conflict with the session-ledger idea's `runs/sessions/`?** My read:
  no, they are different artifacts on the same subject — the ledger records what a session
  did (host-only, append-only, machine-written), the thread holds what a thread thinks
  (tracked, human/agent-written, revivable). If the ledger is ever built, the honest wiring
  is that a session's ledger entry names the threads it touched. Needs confirming when that
  entry is worked, not now.
- **Does a thread ever hold private material?** In this repo, no — same boundary as
  `docs/IDEAS.md`, enforced by `scripts/test-sanitize.sh`. In a target repo the question is
  that repo's to answer. Worth naming so nobody assumes a thread file is a safe place for a
  name it should not carry.
- **What closes a stale thread?** Nothing yet. A thread with no log entry for a long time is
  either parked with a reason or should be dropped, and the only mechanism shipped is that
  step 0 reads the statuses. Deliberately left thin — a staleness rule invented before there
  is a corpus of threads is a guess.
- **Nothing has yet proved a thread is revivable**, which is the claim the whole convention
  rests on. The test is a cold session picking a thread up from the file alone and getting
  somewhere; it has not happened, because this thread was written and closed in one sitting.
  The next thread opened is the first real evidence.

## Log

- 2026-08-19 — Opened. User asked for the top `docs/IDEAS.md` entry to be fleshed out: where
  the files live, what they contain, how promotion picks them up — and for this thread to
  keep its own file as the first live example. Read `docs/IDEAS.md`, `PLANNING.md`,
  `DESIGN.md` §3.6/§3.7/§12 and `docs/handoff-sweep-trustworthy.md` (the
  undated-living-document precedent). Wrote the proposal above; nothing else in the repo
  changed. Awaiting approval.
- 2026-08-19 — **Approved as a block.** Shipped all five follow-ups: `DESIGN.md` §3.8 and
  change-log row `thread-identity-files`; `docs/threads/README.md` (convention + template);
  `PLANNING.md` step 0 (heading widened, `ready`-thread paragraph and its grep added);
  `docs/IDEAS.md` (`Thread:` optional extra, and this entry moved to **Promoted**);
  `ONBOARDING.md` step 2 (heading widened, `docs/threads/` bullet added). Docs-only change —
  no code, and no suite was run beyond the three seconds-long Docker-free doc checkers
  (`test-changelog.sh`, `test-sanitize.sh`, `test-planning-playbook.sh`), all green. Thread
  closed.

## Outcome

**Promoted, 2026-08-19.** Became `DESIGN.md` §3.8 (*Idea threads — state that outlives a
session*) and change-log row `thread-identity-files`, with `docs/threads/README.md` as the
registry and template, `PLANNING.md` step 0 as the read point, the `Thread:` optional extra
in `docs/IDEAS.md`, and an `ONBOARDING.md` bullet creating the directory for every new
target. No code, no tooling, no runner change — the convention is documentation and a
directory.

What this thread did **not** settle is listed under Open questions above and stays open on
purpose: the relationship to a future session ledger, what closes a stale thread, and the
fact that no thread has yet actually been revived by a cold session.
