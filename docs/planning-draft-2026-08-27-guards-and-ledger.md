# Planning draft — guards that fire at the start, and a ledger that says what went wrong

**Status:** design-level draft for Chad's approval. Nothing built. Written 2026-08-27.
**Prompted by:** *"I keep running into issues with the pipeline. I need guards, checks,
whatever else you think of. We should be logging info to see what went wrong."*
**Companion:** `planning-draft-2026-08-27-the-freeze-is-only-enforced-at-the-end.md`, written
the same evening by another session from one incident. This draft starts from the whole
corpus instead, agrees with all three of its proposals, and puts them in a larger frame.

---

## 1. What the corpus says

Every run since 2026-08-10, read from the manifests and status files under `runs/`
(the reader that produced these numbers is in §6 — it does not exist as a tool yet, which
is itself a finding).

| Outcome | Tasks |
|---|---|
| done | 72 |
| **stuck** (three attempts, no PR) | **21** |
| undispatchable (refused before launch) | 22 rows, under-counted — see §2 |
| failed / partial / tampered | 1 / 1 / 1 |

**One in five dispatched tasks ends stuck, and the 21 stuck tasks cost 21.4 hours of
container time for nothing mergeable.** Attempts two and three rescued 5 of the 72
successes; they rescued none of the 21.

Every one of the 21 raised spec concerns — three to five each. Reading the *first* concern
of each, they fall into exactly two classes, and the split is the whole story:

**Class A — dispatched with no frozen suite at all: 9 tasks** (2026-08-20 and -21). The
agent's first line in each is `test dir not found`. **Closed** by the dispatch gate on
2026-08-21 (change-log row `repo-5yu`); a task in this state is now refused before launch.

**Class B — a frozen suite no implementation could pass: 12 tasks.** Open. Four shapes:

| Shape | Tasks | What the agent found |
|---|---|---|
| B1 the suite does not execute | 2 | a parse error the engine rejects; a fixture calling a three-argument function with none — `SCRIPT ERROR` before any assertion |
| B2 red at the fork point for reasons unrelated to the task | 4 | a guard pinning eleven snapshot keys from a build older than the fork; a guard delegating to a sibling suite whose numbers a design change had since moved; a golden table listing files never committed; a build digest that had already changed |
| B3 needs bytes the container cannot have | 1 | nineteen asset digests whose only source is a folder outside the repo |
| B4 internally contradictory, an unreachable check, or a tolerance below physical noise | 5 | two frozen files that contradict each other; a stub that kills the tool under test (11 of 29 checks unreachable); a misplaced `git -c`; a momentum tolerance of one-in-a-million against tidal gravity of four-in-a-million; a conic no correct implementation matches |

In all twelve, **the task agent diagnosed the defect — usually on attempt one — wrote it
into the concern channel, and then spent two more attempts against a suite it had already
proved could not go green.** The concern channel is working exactly as designed (§3.3): it
is evidence, it changes no outcome, and it has been right every time. What is missing is
anything upstream that reads the same evidence *before* a container is spent.

## 2. The guard that would have caught Class B exists, and it was never run

The freeze gate (`scripts/freeze-gate.js`, `PLANNING.md` step 4) is built for precisely
this. Its red check catches "green at the fork point"; its control run catches "the harness
is broken"; and since yesterday its `--green` probe (change-log row `repo-inj`) catches "red
at the fork point *and* red in a tree where the criteria are already satisfied" — which is
B1 and B4 by definition, and B2 wherever a guard is involved.

**Fourteen planning drafts on the first real project, 2026-08-23 through -26, mention the
freeze gate zero times.** Not "ran it and skipped the probe" — no verdict, no exit code, no
mention. The two tasks that went stuck tonight (a fixture arity error; a tolerance below
noise) were frozen this morning, the same day the probe merged, from a draft that does not
name the gate. Both are B-class. Both would have been `unreachable` (exit 3) in under a
minute.

The gate is manual, it is invoked from a playbook step, and **nothing records whether it
ran.** So the dispatch gate — the only guard that fires at the start — has no way to ask.
The companion draft's table is right: every enforcement point sits at the end of the loop,
and the one in the middle leaves no trace.

A second thing this draft corrects in the companion: its §2 says the runner "says exactly
the right thing." That was true of the **log line** and false of the **report and
manifest**, which for three runs read `0 task(s): none` against a queue of eight refusals.
Fixed today (change-log row `refused-rows-lost`, the fix was one missing argument). The
correction matters here because it is the same failure family as everything in this draft:
the detection was right and the *record* was empty.

## 3. Proposal — guards that fire at the start

Ordered by how much of the 21.4 hours each would have saved. None touches the verifier's
judgement, adds an LLM to control flow, or weakens anything (hard rules 2, 5, 7).

### G1. The freeze gate leaves a receipt, and the dispatch gate requires it

The gate writes `tests/acceptance/<issue-id>/.freeze-gate.json` when it passes: gate
version, fork commit, a hash of the suite's tree (excluding the receipt itself), the verdict
(`red` or `half-proven`), whether a probe was used, the guard count, the brittleness-lint
count, and a timestamp. It lives **inside the frozen path**, so the verifier already diffs
it against the fork point and tampering with it is `tampered`.

`runner/queue.js`'s gate then has three answers instead of two, read from the integration
branch through the same git plumbing it already uses:

- suite absent → `undispatchable` — *no frozen suite* (as today)
- suite present, **no receipt** → `undispatchable` — *suite never passed the freeze gate*
- suite present, receipt present, **tree hash differs** → `undispatchable` — *suite changed
  since the gate passed*
- receipt matches → dispatchable

Deterministic, host-side, no new writer to Beads. It closes three things at once: the gate
skipped (14 of 14 drafts), a suite edited after the gate, and the companion draft's
`bd create` shortcut — an issue with no receipt is refused before launch and named with the
remedy, and G4 can say so before the launch.

**Policy call for Chad, the only one in this section:** does `half-proven` (red, control
green, no probe — exit 4) earn a receipt that dispatches? The data says the probe is what
catches B1 and B4, which is 7 of the 12. **Recommendation: a probe is required for
dispatch**, and a config knob (`allowHalfProven: true`) lets a project opt out per run with
the choice recorded in the manifest. Half-proven is still a legal freeze; it is just not a
silent one.

### G2. A guard must be green at the fork point

The gate today fails a check that is *green* at the fork unless it is labelled `[guard]`.
It has no opinion about a guard that is *red* at the fork — and B2's four tasks are exactly
that: "flight unchanged", "keys untouched", "content not code" checks that were red before
anyone wrote a line, because the thing they pinned had already moved. A red guard at the
fork point is a stale pin by definition and can never be anything else. One more verdict in
`freeze-gate.js`, no new inputs.

### G3. The probe runs in the project image, not on the host

B3 (and the sibling "works on the host, not in the container" defect family in
`docs/STATUS.md`) is the host having something the container does not. `--green` gains an
`--in-image <image>` mode that runs the probe pass inside the same image the task will use,
with the same mounts and no network. Mid-sized; the runner already knows how to launch that
container.

### G4. Preflight — "what would a run dispatch right now?" (companion §5.1)

Agreed, with one adjustment: `scripts/batch.js show` already reconciles the marker against
the live queue and is the playbook's last act before launch, and `docs/IDEAS.md` already
holds the note that it should import the dispatchability check rather than keep a second
copy. So the deliverable is **one tool, not two**: `batch.js show` grows a third column
(`dispatchable` / `unproven` / `unfrozen` / `stray`) by importing G1's rule, and
`scripts/preflight.js` is the marker-free entry point to the same code for a session that
has no batch yet. It also prints the newest run's concern count for the project (the
IDEAS note *put the concern speed bump at the launch gate*), which is a pointer, not a gate.

### G5. Exit 2 when nothing dispatched from a non-empty queue (companion §5.2)

Agreed as written. Empty queue stays exit 0.

### G6. Lead the summary line with the number that matters (companion §5.3)

Agreed. Note for the spec: the historic prefix `ready queue:` is grepped by
`scripts/test-runner-queue.sh` at six sites and pinned by `test-dispatch-gate.sh` (G9g);
the wording change has to move those with it, which is why it is a task and not an edit.

### G7 — option, not recommended yet: stop after two identical failures

Of the 21 stuck tasks, none changed its failing set between attempts two and three. A
deterministic rule — *if attempt N's failing check names equal attempt N−1's, skip the
remaining attempts* — would have returned roughly two thirds of the 21.4 hours, decided
by the verifier's own output and nothing an agent writes. It is a change to §4.6's attempt
economics and to the container entrypoint, and the two tasks that *were* rescued on
attempt three are the reason to want the check to be "identical", not "still failing".
Parked here for a separate decision once G1–G3 have had a week to show whether stuck
tasks still happen at all.

## 4. Proposal — a ledger that says what went wrong

The ask was *"logging info to see what went wrong, separately from that md file."* Today's
record is: `run.log` (prose lines), `run.json` (outcomes, no causes), `report.md`
(rendered from `run.json`), and per task `status.json` + `verify.json`. Every question in
§1 had to be answered by writing a script over those, and the dashboard, the batch reader
and the audit tool each parse `run.log`'s **wording** with regular expressions (the
`P.*` prefix table in `scripts/dashboard.js` is the proof). A wording change in the runner
breaks three readers silently.

### L1. A structured event ledger per run

`runs/<runId>/events.jsonl` — one JSON object per line, written by the **same** writer as
`run.log` (`runner/log.js`), so the two cannot disagree. Every event carries `ts`, `level`,
`runId`, `issueId` (or null), `event`, and event-specific fields. The events the readers
already want:

`run.started` · `preflight.passed` / `preflight.failed {reason}` ·
`queue.read {ready[], skipped[], undispatchable[{id, reason}]}` · `task.started` ·
`workspace.ready {path, branch, forkPoint}` · `container.launched {name, attempt}` ·
`attempt.finished {n, verifierResult, failingChecks[]}` · `concern.raised {n, text}` ·
`pause.entered` / `pause.left` · `task.finished {outcome, exitCode, failureClass}` ·
`run.finished {ending}`.

The dashboard, `batch.js`, `audit-runs.js` and `verdict.js` move from regex-over-prose to
reading events, one reader per task, each keeping its existing suite green. `run.log` stays
for humans.

### L2. Every non-`done` task carries a failure class

Decided deterministically from artifacts already in hand, never from prose:

- `no-suite` — the dispatch gate's refusal
- `unproven-suite` — G1's refusal
- `suite-error` — the verifier's own control run is red (the harness cannot report success
  at all; B1's shape at run time)
- `identical-failures` — the same failing set on consecutive attempts (G7's signal,
  recorded even while G7 does not act on it)
- `attempts-exhausted` — genuinely three different tries
- `timeout`, `internal`, `tampered` — as the outcome table already distinguishes

Written into `run.json` and the `task.finished` event; rendered in the report beside the
outcome word.

### L3. The audit reads classes, and the first failing line

`scripts/audit-runs.js` gains a *stuck by class* table and, per stuck task, the first
failing verifier line and the first concern — the two columns this draft's §1 was built
from by hand. "What keeps going wrong" becomes one command.

### L4. The receipt is the first line of the planning-session ledger

`docs/IDEAS.md` already holds the user's directive to capture planning-session information
(*a session ledger under `runs/`*). G1's receipt is that ledger's first durable entry — a
gate verdict that survives the draft it was written in — and the natural place for the
critic panel's dispositions and the approval to accrue next. Not in this batch; named so
the receipt's shape is designed with it in mind.

## 5. Recommended batch and order

**Batch 1 — the start-of-loop guards and the ledger's writer.** Five tasks, each through
`PLANNING.md` 1–8 with the critic panel, and **each frozen with a probe and a receipt** —
the pipeline's own tasks go first through the gate this batch installs.

1. G5 exit 2 + G6 wording — smallest, one task.
2. G1 receipt + dispatch rule — the load-bearing one.
3. G2 guard-red-at-fork.
4. L1 event ledger (writer only; readers untouched).
5. L2 failure class.

**Batch 2** — G4 preflight column, L3 audit tables, G3 probe-in-image, and the readers
moving onto L1.

**Two decisions for Chad, up front:**

- **Is half-proven dispatchable?** (G1.) Recommendation: no, with a per-project opt-out
  that is recorded.
- **Approve the direction and the batch split**, or re-cut. G7 is explicitly not in either
  batch.

## 6. What this draft did not do

- It did not build anything, including the corpus reader that produced §1 — that reader
  is L3, and shipping it as a script tonight would be the thing this repo's rules exist to
  stop: a tool with no spec, no critic and no frozen test.
- It did not edit the companion draft, which another session has open.
- It did not run the critic panel: that is `PLANNING.md` step 2 and belongs to each task's
  spec, not to a design-level draft.
