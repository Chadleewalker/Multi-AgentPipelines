# Thread — a batch-ready marker the launch step reads instead of someone's memory

```
slug:     batch-ready-marker
status:   promoted (2026-08-19)
opened:   2026-08-19
origin:   docs/IDEAS.md, top entry, 2026-08-19 ("A 'batch ready' marker a planning session
          files when specs are frozen, so the launch step reads state instead of memory")
related:  PLANNING.md steps 6 and 8 (freeze, then the pre-run checklist); DESIGN.md §3.2
          (planning is interactive), §4.12 (runs/, the per-project lock), §5 (the run
          corpus and its pure readers), hard rule 1 (the host is the only writer to the
          queue) and hard rule 5 (evidence, never a gate); scripts/verdict.js (the
          pending-list precedent this copies); the operator/working session split
```

**The question this thread has to answer:** what a planning session writes down when it
finishes freezing a batch, where that lands, and who reads it — such that the launch step
can confirm *what it is about to launch* from disk, and an un-launched batch is visible to
the next session, without the marker becoming a queue item, a gate, or a fifth thing
nobody reads.

---

## Current thinking (the proposal — rewritten in place, never appended to)

### 1. The gap, stated precisely

The handoff between the two halves of the process is currently a spoken word.

A planning session ends at `PLANNING.md` step 8: tests frozen and pushed to the target's
integration branch, issues created with priorities and dependencies, image rebuilt,
`bd ready` eyeballed. Then the user moves to a **separate operator session** and says
"go", and the operator launches `node runner/run.js --config run.config.<project>.json`.

Between those two moments, **"this batch is ready to run" exists only in the user's
head.** Three consequences, all of which have a cost today:

- The operator cannot confirm what it is launching. "go" starts the standard run for a
  project; whether the queue it drains is the batch that was frozen, or that batch plus
  two strays, or a batch someone re-prioritised yesterday, is unverifiable at launch.
- A batch frozen and not launched is invisible. If the working session ends on a Tuesday
  and the user comes back Thursday, nothing on disk says four specs are sitting frozen.
- The reconciliation that step 8 does by eye — "`bd ready` lists exactly the tasks meant
  to run" — is done once, in a session that is then discarded, and never again.

### 2. Where the marker lives — `runs/batches/`, host-only

**`runs/batches/<project>-<YYYY-MM-DD>.json`, in this repo, git-ignored.**

Four reasons, in the order they bind:

- **It names a target project, so it cannot be tracked here.** A marker carries the run
  config's project name and the target's issue ids. `docs/IDEAS.md` rule 1 and
  `scripts/test-sanitize.sh` make that a hard stop for the tracked tree. `runs/` is
  already the host-only side of exactly this boundary.
- **It is state, not intent.** The thread-identity-files thread drew this line and it
  applies in the other direction here: `docs/threads/` holds what a thought *thinks* and
  must survive a clone; `runs/` holds what a machine *did* and must not leave the host. A
  batch marker is a fact about one host's queue at one moment — the same class as a run
  manifest or the lock record, not the same class as a design note.
- **The reader is already there.** The operator session runs from this repo and reads
  `runs/`. Putting the marker in the target repo's tree would make the operator go
  reading a working copy it otherwise never touches, and would push pipeline ritual into
  every onboarded project.
- **It does not need to survive a clone.** A marker that outlives its launch is history,
  and the run corpus already records history better than the marker could.

### 3. What it holds

Enough to confirm a launch and to reconcile it later, and nothing that duplicates the
queue:

- the **project** — specifically the `run.config.<project>.json` this batch is for, since
  that is what the operator will actually type;
- the **frozen date** and the target's **integration branch and freeze commit** (the
  commit the acceptance tests landed on — the thing the verifier will diff against);
- the **issue ids, with titles**, in the intended priority order;
- **one line of intent** — what this batch is for, in the user's words;
- **who approved it**, per hard rule 4's split.

### 4. Written once; "launched" is computed, never stored

The marker is **immutable**. No `launched: true`, no status field, no consumed flag.

That is not tidiness — it is what keeps the operator session read-only on shared state,
which is the property that makes it disposable. A marker the operator has to stamp is a
marker that goes stale the first time a run is launched some other way.

**Whether a batch is still pending is a join, not a field.** The run corpus under `runs/`
already records which issue ids each run worked; a batch is pending if no run since its
freeze date touched its ids. This is exactly `scripts/verdict.js pending`'s move — the
list is computed at the moment it is asked for, from records that were written for other
reasons — and it inherits that design's best property: nothing to forget to update.

### 5. The reconciliation is the actual value

Confirming "batch of 4, frozen 2026-08-19 — go?" is worth having. The **diff** is worth
more:

> the marker says four issues; `bd ready` in the target says five are runnable and one of
> the four is blocked.

That is the check step 8 does by eye and then throws away, and it is the failure the
pipeline cannot catch downstream — the runner has no picker, it drains whatever queue it
finds, so a stray unblocked issue simply runs. Reading the marker against the live queue
at launch is the only place that mismatch is visible.

The reconciliation needs `bd` on the host, which the `verdict.js` discipline deliberately
avoids depending on. The resolution is the dashboard's: **reconcile when `bd` is there,
and say plainly when it isn't** — print the marker alone and label it unreconciled, never
silently print a subset.

### 6. Three boundaries this must not cross

- **Never a queue item.** `docs/IDEAS.md`'s own rule — the runner drains the queue
  unattended, so anything that can start a container is not a marker. Nothing in
  `runner/` or `pipeline/` reads `runs/batches/`.
- **Never a gate.** A missing marker must not stop a launch, and a marker that disagrees
  with the queue must not refuse one. It is evidence for a human at the moment of the
  human's decision — hard rule 5's shape, and `verdict.js`'s (exits 0 on findings).
- **Never the source of truth for what runs.** Beads is. The marker records what was
  *intended*; the queue decides what *happens*. When they disagree, that is the finding.

### 7. Who writes it, and where the ritual is documented

The **working session writes it, as the last line of `PLANNING.md` step 8** — the same
session that just did the eyeballing, while it still knows the answer. The operator only
ever reads.

One boundary worth naming now: the launch ritual currently lives in a user-global agent
skill, not in this repo. Anything this thread adds to the *process* belongs in
`PLANNING.md` and `CLAUDE.md`'s "Running things", with the skill pointing at the repo —
process documentation uses repo-owned mechanisms, so it survives a change of agent CLI.

---

## Decisions

- 2026-08-19 — **Host-only under `runs/`, not tracked in `docs/`.** Forced, not chosen: a
  marker names a target project and this repo is public. (drafter)
- 2026-08-19 — **The marker is immutable and "pending" is computed from the run corpus.**
  Keeps the operator session read-only on shared state, which is what makes it
  disposable. (drafter)
- 2026-08-19 — **The `bd ready` reconciliation is in v1.** Without it the marker is a
  confirmation prompt; with it, it is a check, and the mismatch it catches has no other
  detector. (user)
- 2026-08-19 — **A reader script ships with it — `scripts/batch.js`, `show` and
  `pending`.** The "no tooling until it has been done by hand once" instinct was weighed
  and set aside: this is a join across three sources, which is the same warrant that
  justified `verdict.js` and `audit-runs.js`, not a taxonomy over a flat directory. (user)

## Open questions

*(none blocking — both v1 questions were settled above. Two left for the planning
session that specs this:)*

- **What writes the marker in practice — the user, or Claude at the end of step 8?** If
  Claude, the format has to be one an interactive session produces reliably with no new
  tooling, which argues for small flat JSON and against anything requiring a writer.
- **Per run config, or per planning session?** Assumed one marker per run config until
  someone freezes work for two targets in one sitting.

## Log

- 2026-08-19 — Thread opened from the top `docs/IDEAS.md` entry, same day it was filed.
  Proposal drafted against `PLANNING.md` steps 6–8 and the operator/working split; the
  inbox entry gained a `Thread:` line.
- 2026-08-19 — User approved both v1 questions (reconciliation in, reader script in).
  Promoted: `DESIGN.md` §3.9 written, change-log row `batch-ready-marker` appended, the
  inbox entry moved to the **Promoted** table citing this thread.
  `scripts/test-changelog.sh` and `scripts/test-sanitize.sh` green.

- 2026-08-19 — Planning session run end to end. Fresh-context criteria (step 1b), spec-lint
  clean, full panel returning `concerns` three times (25 findings, 24 accepted, 1 partially
  rejected). Split into two tasks on the panel's reading: `repo-0b3` (marker + `pending`) and
  `repo-8v0` (the reconciliation). §3.9 amended with four user-approved decisions and the
  change-log row given a same-day amendment clause. Frozen tests committed on the
  `thread-identity-files` branch (PR #39); the freeze gate is RED on both against a green
  control, and was re-run against a deliberately wrong build to prove the tests discriminate
  rather than merely detecting a missing file — which caught a broken guard in criterion
  5(iii) that a correct implementation would have failed. Both issues left DEFERRED: task
  branches fork from `main`, so the freeze is only real once #39 merges. The first real
  marker was written to `runs/batches/` — this batch's own.

- 2026-08-20 — **`repo-0b3` ran and passed on attempt 1**: the marker shape, `pending` and
  `show` ship as `scripts/batch.js`, with `scripts/test-batch.sh` over
  `tests/unit/batch.test.js` as the seventeenth Docker-free suite (change-log row
  `repo-0b3`). Its docs phase wrote the `PLANNING.md` step 8 line and the CLAUDE.md
  "Running things" entry this thread parked, both saying plainly that the reconciliation is
  not there yet. `repo-8v0` — the `bd ready` half, and with it the reconciled vocabulary —
  is still open.

## Outcome

**Promoted 2026-08-19 to `DESIGN.md` §3.9 and change-log row `batch-ready-marker`.
Half-built 2026-08-20** — `scripts/batch.js` reads the marker and computes `pending`
(change-log row `repo-0b3`), and `show` labels every batch `unreconciled bd-unavailable`
until the queue half lands.

What is left is `repo-8v0`, the reconciliation against `bd ready`: the seam is the
**existing `PIPELINE_BD_CMD`** and not the `BATCH_BD_CMD` this thread first imagined —
`runner/bd.js` gives `PIPELINE_BD_CMD` absolute precedence at every entry point, so a
second seam name would leave the reference host with a suite that passes vacuously. It
reads and never writes (hard rule 1), and it joins three sources rather than two, since
`run.json` records a git remote URL and never the config name.
