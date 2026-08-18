# Planning draft — 2026-08-18 — measuring what the pipeline costs and which model earns it

**Status: STEP 0 ONLY — no spec drafted, nothing frozen, nothing runs**
(PLANNING.md steps 0–8). This is the idea-inbox read and a readiness assessment of four
parked entries, written so the next session starts from decisions rather than from
re-reading. **Four candidates, one recommended for this batch.** Nothing below has been
through fresh-context criteria drafting or the critic panel, because neither is worth
spending until the candidates are picked.

All ids and names in examples are invented (`app-001`) — this file is public and names no
target project.

## Step 0 output

**Idea inbox read** (`docs/IDEAS.md`): four entries bear on "understand what is working
better" — per-task cost, per-phase model, the session ledger, the build-stats skill.

**Drift report** (`node scripts/trace.js report`): **clean.** 0 ticked-with-no-witness, 0
broken refs. The 28 merged issues that no spec box points at are historical — the
traceability convention (change-log row `trace-ledger`) postdates them. Not a finding for
this session; `backfill` can recover them whenever someone wants the ledger complete.

## The four candidates

### 1. Record what each task cost — per-model tokens

**Readiness: highest. The feed already exists.** `pipeline/envelope.js` already parses
`modelUsage` out of the CLI envelope — that table is how "7897 of 7912 output tokens" was
knowable when defect 8 was diagnosed. Nothing records it. Every scaling statement the
design makes is currently priced in wall-clock only and is numberless.

Shape, all of it deterministic and additive: `status.json` gains a usage field, the runner
copies it onto the task row in `run.json`, the report prints it, and `audit-runs.js` gains
the column — the per-model cross-tab shipped today (change-log row `model-crosstab`) is
already the right place for it to land.

- **Open questions: nearly none.** One worth asking: does the figure belong in the PR
  footer as well as the report?
- **Blocks:** everything else here. Both remaining ideas are measurement, and this is the
  measurement they are missing.
- **Pipeline-suitable: yes.** Frozen-testable end to end, no interactive judgment.

### 2. Split the model per phase

**Readiness: high, and small.** One `AGENT_CMD` in `pipeline/entrypoint.sh` serves both
agent phases, so the docs phase runs on whatever tier the code phase does. A second
config field and a second command string is the whole mechanical change.

- **Open question for the user, and it decides the size:** per *phase* only, or per *task*
  as well? Per-phase is a config field. Per-task means the tier rides on the frozen spec,
  which is a change to the task contract and a much larger thing.
- **Recommendation: per-phase only.** It captures most of the saving at a fraction of the
  design cost, and per-task can follow once #1 makes it measurable.
- **Pipeline-suitable: yes.**

### 3. The session ledger

**Readiness: lowest — this one still needs a design conversation, not a spec.** The entry
lists five categories worth capturing and calls its own shape a suggestion. Two things
have to be settled before anything is frozen:

- **What is worth keeping.** A ledger that records everything is a transcript, and a
  transcript is not a measurement — the value in the entry's own list is concentrated in
  the rigor numbers (findings and their dispositions, freeze-gate verdicts) and the
  decisions-with-owners, not in raw activity.
- **When it is written.** Append-as-you-go is accurate and intrudes on every session;
  write-at-the-end is unintrusive and is the session reporting on itself from memory,
  which is the same class of problem as an agent grading its own work.

**Not pipeline-suitable in its first form** — it is a convention plus a writer used *by*
interactive sessions, so the first version is interactive work, the way the dashboard page
was (change-log row `live-dashboard-page`).

### 4. The build-stats skill

**Readiness: deliberately last.** The entry says it itself — the skill is only as good as
what the corpus keeps, so it is downstream of #1 and #3. Building the reader before the
recording exists produces a report with holes in exactly the places that motivated it.

## Recommended shape for the next session

**Batch of one: candidate 1.** It is the only entry with no open design question, it is
the dependency under both remaining ones, and it converts the model comparison from an
argument into an arithmetic problem. Candidate 2 is a reasonable second if the session has
room, and its only open question is the per-phase / per-task one below.

## What the session needs from the user

1. **Confirm the batch** — candidate 1 alone, or 1 and 2 together?
2. **Per-phase or per-task model** (candidate 2, if taken). Recommendation: per-phase.
3. **Does per-task cost belong in the PR footer**, or in the run report and the audit only?
4. **The three mis-recorded rows.** Three task rows are attributed to a Haiku id that never
   did the work — the defect 8 misread (change-log row `repo-wxh`), now visible as its own
   block in the cross-tab. Exclude them from per-model comparisons, annotate them, or leave
   them and remember?

## What has *not* been done, and why

- No `DESIGN.md` section or change-log row — PLANNING.md step 0 requires the design
  decision *before* step 1, and the decision is the user's.
- No spec draft, no fresh-context criteria pass, no critic panel. The standing
  authorization (CLAUDE.md) covers steps 1b and 2, and both presuppose a picked candidate.
- No Beads issue. An inbox entry is not work (§3.1), and an issue is a commitment.

---

# Decision taken (2026-08-18): batch of one

The user picked **candidate 1, per-task cost recording**, and deferred candidate 2 (the
per-phase model split) on the sequencing argument: splitting the model before the meter
exists ships a change whose effect cannot be seen, and the same report would have to serve
as both the before and the after. Candidates 3 and 4 stay parked.

Question 2 of the four below was conditional on taking candidate 2 and does not need
answering. Questions 3 and 4 are answered under **Assumptions** rather than held, so the
draft is reviewable in one pass.

## Spec draft — record what each task cost

**Label proposed: medium.** It touches the status schema, the container entrypoint, the
runner's task row and two readers, but every change is additive and none of it is
judgment. The user may relabel at step 5; the label decides how much critique the spec
receives, and `hard` would be defensible on the grounds that the failure mode is silent.

### 1a. Intent — drafted in session

**Description.** Record, per task, how many tokens the work actually cost, broken down by
the model that spent them. The Claude CLI already reports this: its JSON envelope carries a
`modelUsage` table, and `pipeline/envelope.js` already parses that table — reading it is how
the resolved model id is recorded at all, and how "7897 of 7912 output tokens" was knowable
when STATUS defect 8 was diagnosed. Nothing keeps the numbers. This task keeps them, in the
artifacts the pipeline already writes, so the run report and `scripts/audit-runs.js` can
report cost beside outcome.

**Why now, and why this first.** Every scaling statement in the design is currently priced
in wall-clock alone — "concurrency buys elapsed time, not throughput", "N containers exhaust
the window N times faster" — each true and each numberless. Three parked ideas are blocked
behind the same missing column: the per-phase model split cannot be evaluated, the spend
ceiling has nothing to count, and the build-stats skill can only report what the corpus
keeps. The per-model cross-tab shipped today (change-log row `model-crosstab`) is the shape
this lands in: it already cuts outcome and first-attempt rate by model, and cost is the
column it was built to hold.

**Constraints.**

- **Additive only.** `schemas/status.schema.json` sets `additionalProperties: false`, so the
  new field is one `properties` entry with `required` untouched — every `status.json`
  written before this task stays valid. The `phase` feed (change-log row `repo-bmd`) is the
  precedent and the model to copy.
- **Non-fatal, always.** Styled on the existing `model` write: an unrecordable usage figure
  must never turn a task into an internal error. A task that cannot report its cost is a
  task with an unknown cost, not a failed task.
- **Not an outcome.** Nothing in the runner, the verifier or the report may branch on it
  (hard rule 7, and §5's reader-not-gate line). It is evidence.
- **No new LLM anywhere**, and no new dependency: the extraction is the deterministic
  envelope read that already exists.
- **`scripts/audit-runs.js` keeps its contract** — node built-ins only, no `child_process`,
  writes nothing, exit 0 on any readable tree, byte-deterministic output.
- **Frozen paths untouched.** Nothing here goes near `pipeline/verify.js`.

**design-ref.** `DESIGN.md` §4.3 (the agent phases and the envelope extraction rule) and
§4.11 (the artifact contract — what a task records and where). Both need amending; the
proposed change-log row is below and is **not yet written into `DESIGN.md`**, because the
design decision is the user's to approve (hard rule 4).

### Assumptions taken rather than questions held

- **Q3 — where the figure surfaces: the run report and the audit, not the PR footer.**
  The PR footer is read by one human reviewing one change, where a token count is noise; the
  aggregate is what carries meaning, and that lives in the report and the corpus. Reversible
  in a later task if it turns out to be wanted per-PR.
- **Q4 — the three mis-recorded rows are out of scope.** They are an artifact of STATUS
  defect 8 (change-log row `repo-wxh`), already fixed, and interpreting historical rows is a
  reader concern, not a recording one. Left visible rather than filtered, so nothing hides
  them; whoever compares models excludes them knowingly.

### Proposed `DESIGN.md` change-log row — for approval, not yet written

> **`task-cost`** — §4.3 and §4.11 gain the **per-task cost record**: `status.json` gains an
> additive usage field carrying per-model token counts, extracted from the same `modelUsage`
> table §4.3's resolved-model rule already reads, and the runner carries it onto the task row
> in `run.json` so the report and `scripts/audit-runs.js` can price a task beside its
> outcome. Non-fatal and never an outcome, on the `phase`-feed precedent. Declared here at
> planning time; the implementing task adds its own row when it ships.

### Decisions taken on what fresh context left open

Three points the criteria pass surfaced as "defensible either way, but must be decided
rather than discovered":

- **Tokens, not dollars.** The envelope carries `costUSD` per model. It is **not recorded.**
  Those are list-price figures and the container authenticates with a subscription token, so
  a dollar column would be confidently wrong in the one direction nobody checks — and the
  scarce resource here is the usage window, which tokens measure and dollars do not.
- **A rate-limited attempt under-counts, on purpose.** `pipeline/entrypoint.sh` exits 20 on
  a rate limit before the envelope is read, so tokens spent up to that point are not
  recorded. The recorded figure is therefore a **floor**, never an over-count. Accepted
  rather than fixed: the alternative is parsing a log that may be truncated mid-envelope,
  which trades a known under-count for an unknown wrong number. The spec says so, so a later
  reader finds a decision instead of a discrepancy.
- **Model keys are written in sorted order**, so two otherwise-identical runs produce
  identical `run.json` bytes and the report's regeneration-idempotence claim survives.

### 1b. Acceptance criteria — drafted in fresh context against the code

**Label revised: `medium` → `hard`,** on the evidence rather than the size. Scope really is
one reviewable PR (9 files, every change additive). What earns `hard` is the failure
signature: every wrong implementation here produces a well-formed, non-empty, plausible
number — the family `CLAUDE.md` §3.6 and STATUS defects 2, 5, 7 and 8 are about. `hard`
buys the full three-charter panel, which is the right amount of review for that shape.

**C1 — every invocation contributes, and repeated invocations accumulate.** The agent runs
up to four times per task (up to `MAX_ATTEMPTS` code invocations plus the docs invocation).
Drive the entrypoint with envelope-emitting stubs and a verify stub that fails once then
passes, so three invocations happen; the fixture numbers disagree deliberately (100 / 20 / 7
for one model, with a second model appearing **only** in the docs envelope). Done means the
recorded total is exactly 127 for the first model, exactly its own figure for the second,
and the key set is exactly those two.
*Kills:* last-write-wins (prints 7), code-phase-only (prints 120, no second model),
docs-only (prints 7, no first model).

**C2 — capture happens before `flatten` destroys the envelope.** `envelope.js flatten`
overwrites the log with the plain result, in the workspace and therefore in the collected
copy too. Done means: after the run, `agent-1.log` carries the plain text with the string
`modelUsage` nowhere in it — the existing flatten contract, unregressed — **and** that
attempt's recorded usage is non-zero.
*Kills:* any host-side reader of the collected logs. It would find nothing for the code
phase and everything for the docs phase, because `docs-out.txt` is never flattened —
producing a well-formed record holding roughly a tenth of the truth.

**C3 — absence is legal, and the write can never fail a task.** Three drives: a stub
emitting no envelope leaves the key *absent* (not `{}`, not `null`) and the file still
validates; a `status.js` wrapper that fails every usage call still lets the task reach exit
0, with at least one usage call observed; and an envelope carrying missing, string or null
counts yields only finite numbers, with no `null` where a count belongs.
*Kills:* the `NaN` trap — arithmetic over a missing key yields `NaN`, `JSON.stringify`
writes `null`, and the field reads as "not recorded" forever while looking fine.

**C4 — both schema changes are additive, and history still validates.**
`schemas/status.schema.json` **and** `schemas/run.schema.json` each gain exactly one
property with `required` and `additionalProperties` untouched, and a **real historical
artifact** from `runs/` still validates.
*Kills:* editing the status schema and forgetting the run manifest's — invisible until a
Docker suite runs.

**C5 — the manifest and report carry it as evidence, and it moves nothing.** The task row
carries the object verbatim when present and **omits the key entirely** when absent
(matching how `model` is spread today); the report renders a cost fact and regenerates
byte-identically; and `byScrutiny` produces an identical task order with and without every
usage field stripped.
*Kills:* folding cost into `scrutinyKey`, which would make it a gate by the back door.

**C6 — the audit reports it per model, with its own denominator, and stays a pure reader.**
The `### Models` block gains summed tokens per model **and** how many of that model's rows
recorded usage, out of its total. Fixture: one model with 1 usage-bearing row of 2, another
with 2 of 2. Plus the standing contract re-asserted — byte-identical output across two
invocations, no `child_process`, no file created or modified, exit 0 on a corpus where
nothing records usage.
*Kills:* treating a missing record as 0 and folding it into the denominator — the same
denominator rule the cross-tab already carries (change-log row `model-crosstab`).

### Out of scope, stated so its absence is not read as an omission

`runner/publish.js`'s PR body is deliberately untouched, per the Q3 assumption above.

### Found next door — a real defect, not part of this task

`schemas/run.schema.json` allows `verification.regressions` of `pass|fail|absent`, but
`schemas/verify.schema.json` gained a fourth value, `error`, in change-log row
`verify-nobuffer`, and `runner/run.js` copies the value onto the task row verbatim. **A run
whose regression pass is killed by the output cap, the timeout or a signal writes a
`run.json` that fails its own ajv validation** in `scripts/test-report.sh` and
`scripts/e2e.sh`. Latent, Docker-only, and it would present as a schema error rather than as
the harness fault it is. One enum value; it belongs in its own change-log row, not folded
into this task's diff.

---

# Step 2 — panel results and dispositions

Spec lint: **clean** (exit 0). Full three-charter panel run, each critic in fresh context
with no session history, per the standing authorization in `CLAUDE.md`.

| Critic | Verdict | Findings |
|---|---|---|
| `ambiguity` | concerns | 10 |
| `testability` | concerns | 6 |
| `scope` | concerns | 6 |

**Two findings arrived independently from two critics**, which is the strongest signal a
panel gives: the audit cut (old C6) keys by a different *model* than the block it edits.
That alone justified the panel.

## Dispositions

Every finding takes one line. A silently dropped finding is indistinguishable from a
considered one, and the difference matters most at the hour specs actually get skipped.

| # | Critic | Finding | Disposition |
|---|---|---|---|
| 1 | ambiguity, testability | The per-model value's shape is unpinned — `{m: 127}` and `{m: {inputTokens…}}` both pass | **Accepted.** Four named keys pinned in C1; fixture gives each a different value so an `outputTokens`-only implementation fails |
| 2 | ambiguity | Neither field is named, and `usage` already means the rate-limit window here | **Accepted.** Field is `modelTokens` in both artifacts, named literally in the criteria |
| 3 | ambiguity | C3 asserts a `status.js` usage call that does not exist; `set` stores a string | **Accepted.** New verb `status.js tokens <json>`, merge semantics, named in the spec |
| 4 | ambiguity | Extraction point unpinned; `flatten`'s stdout is a contract | **Accepted.** New `envelope.js usage <file>`; the spec states `flatten`'s stdout stays the model id alone |
| 5 | ambiguity | The docs-phase capture point is unnamed but C1 makes it load-bearing | **Accepted.** Explicit entrypoint call on `docs-out.txt`, before `status.js summary` |
| 6 | ambiguity, scope | The audit cut keys by a different model than the block it edits | **Accepted, and it splits the task.** Cost is reported in its own subsection keyed by the record's own model keys — never folded into the resolved-model buckets, which would attribute tokens to a model that did not spend them |
| 7 | ambiguity, testability | "Renders a cost fact" pins no string, position or format | **Accepted.** Literal line and position pinned in C5 |
| 8 | ambiguity | Degenerate envelopes unresolved (`modelUsage: {}`, non-object, attempt recording nothing) | **Accepted.** Covered in C3 |
| 9 | ambiguity | The criteria never say the tests are Docker-free under `tests/acceptance/` | **Accepted.** Stated once, above the criteria, as a constraint on all of them |
| 10 | ambiguity | "Verbatim" and the sorted-key decision conflict | **Accepted.** The container sorts on write; the manifest copies verbatim. Stated |
| 11 | testability, scope | C4 rests on a `runs/` artifact absent from the container and an ajv that cannot be installed there | **Accepted — verified independently before acting.** `runs/` is git-ignored with 0 tracked files; every ajv here is `npx --yes`. Replaced with a checked-in fixture under `schemas/examples/` and an inline admitter (`repo-1cy` / `repo-teq` precedent) |
| 12 | testability | C2's assertion has no referent, and the total is non-zero under the bug it claims to kill | **Accepted.** Rewritten to disjoint model keys per phase, asserting the code-phase model's exact value |
| 13 | testability | Nothing covers accumulation across a rate-limit relaunch | **Accepted, and it enlarges the stated floor.** New C6 drives one workspace twice, the first ending at exit 20 |
| 14 | testability | Sorted-key order is indistinguishable from encounter order by any criterion written | **Accepted.** `z-model` before `a-model` fixture, asserting `Object.keys` order in both artifacts |
| 15 | scope | Split the audit cut out — it passes or fails alone | **Accepted.** Two tasks, one-way order |
| 16 | scope | Constraints miss the one genuinely non-additive change (the `flatten` stdout contract and the new writer verb) | **Accepted.** Both now in Constraints |
| 17 | scope | Confirm the `hard` label rather than relabel, since the draft records `medium` first | **Accepted.** The superseded label is struck through, not deleted |
| 18 | scope | Declare the `run.schema.json` enum defect an explicitly excluded sibling, not a footnote | **Accepted.** Its own section, with the temptation named |
| 19 | ambiguity | `parse()` returns only `{result, model, aliasMiss}` — the Description overstates "already parses" | **Accepted.** Description corrected: the table is parsed and *discarded* |
| 20 | scope | C4 should name which validation precedent it follows | **Accepted.** Folded into 11 |
| 21 | testability | C3's "still validates" needs the same substitution as C4 | **Accepted.** Folded into 11 |
| 22 | scope | C1–C5 must ship together; a field nothing reads is the half-built state | **Accepted.** They are task 1 |

**Rejected: none. Deferred: none.** Every finding was actionable, which is itself worth
recording — it is what a first draft written without reading the implementation looks like.

---

# Revised spec — for approval (PLANNING.md step 5)

**Two tasks, one-way order.** Task 2 reads what task 1 records; task 1 stands alone.

**Label: ~~medium~~ `hard`** (superseded label kept visible, per finding 17). Not for size —
task 1 is one reviewable PR. For failure signature: every wrong implementation here returns
a well-formed, plausible number, the family `CLAUDE.md` §3.6 and STATUS defects 2, 5, 7, 8
are about.

**Constraint on every criterion below:** the frozen tests live under
`tests/acceptance/<issue-id>/`, are **Docker-free**, and every seam stub is a `.js` file
invoked through `process.execPath` — never a `#!/bin/sh` script, which fails with EFTYPE on
the reference host. No criterion may require `ajv`, network, or anything under `runs/`:
the container has none of the three.

## Names, pinned

| Thing | Name | Where |
|---|---|---|
| The record | **`modelTokens`** | `status.json`, and the task row in `run.json` |
| Per-model value | object with exactly `inputTokens`, `outputTokens`, `cacheReadInputTokens`, `cacheCreationInputTokens` | both |
| Container writer | **`node /pipeline/status.js tokens <json>`** — merges additively into the existing record | `pipeline/status.js` |
| Extractor | **`node /pipeline/envelope.js usage <file>`** — prints the `modelUsage` table as JSON to stdout | `pipeline/envelope.js` |

**`usage` is deliberately not the field name.** It is already this repo's word for the
rate-limit window (`rateLimitResetAt`, the report's `PAUSED` label, `runner/pause.js`), and a
field called `usage` on a task row reads as park state.

**`costUSD` is not recorded** (decision above). **`webSearchRequests` is not recorded** — it
is not a token, and the record is named for what it holds.

**`envelope.js flatten`'s stdout stays the model id and nothing else.** `entrypoint.sh`
captures it in a command substitution and hands it straight to `status.js set model`; a
second line silently corrupts the recorded id. The new subcommand exists precisely so that
contract is not touched.

## Task 1 — record the cost and carry it to the report

**Description.** Extract the per-model token counts the CLI envelope already reports,
accumulate them across every agent invocation of a task, and carry the record through
`status.json` and the run manifest to the run report. `pipeline/envelope.js` parses the
`modelUsage` table today and **discards it** — `parse()` returns the result, the model and
the alias diagnostic, and `chooseModel` consumes the table only to pick the resolved id.

**Constraints.** Additive schema changes only, in `schemas/status.schema.json` **and**
`schemas/run.schema.json` (`required` and `additionalProperties` untouched in both). The
write is non-fatal, on the `model`-write precedent — an unrecordable figure never turns a
task into an internal error. Nothing branches on it: not the runner, not the verifier, not
`scrutinyKey`. `flatten`'s stdout contract is unchanged. The new writer is a new verb, not a
new `set` key — `set` assigns a string from argv and cannot carry an object.

**design-ref.** `DESIGN.md` §4.3, §4.11.

### C1 — every invocation contributes, and repeated invocations accumulate

The agent runs up to four times per task (up to `MAX_ATTEMPTS` code invocations plus docs).
Drive the entrypoint with envelope-emitting stubs and a verify stub that fails once then
passes. The fixture pins **each of the four keys to a different value** — `inputTokens` 900,
`outputTokens` 100, `cacheReadInputTokens` 9000, `cacheCreationInputTokens` 30 on the first
invocation, differing on the others — and the code phase and docs phase use **disjoint model
keys**.

**Done means:** `modelTokens` holds the exact per-key sums for the code-phase model, the
docs-phase model's own figures under its own key, and exactly those two keys.

*Kills:* last-write-wins; code-only; docs-only; and — because the keys differ per field —
any implementation recording only `outputTokens`, which is the one field the repo already
reads and therefore the likeliest thing to ship.

### C2 — capture happens before `flatten` destroys the envelope

`envelope.js flatten` overwrites the log with the plain result, in the workspace and so in
the collected copy too.

**Done means:** after the run, `agent-1.log` carries the plain text with `modelUsage`
nowhere in it — the existing flatten contract, unregressed — **and** the **code-phase
model's** key is present with exactly its fixture value.

*Kills:* a host-side reader of the collected logs. It finds nothing for the code phase and
everything for the docs phase, because `docs-out.txt` is never flattened — so asserting the
*total* is non-zero would go green against the bug. The disjoint keys are what make this
criterion discriminating rather than decorative.

### C3 — absence is legal, degenerate input is legal, and the write can never fail a task

Five drives: no envelope, the key is **absent** (not an empty object, not null); an empty
`modelUsage` table, absent; `modelUsage` present but not an object, absent; counts missing,
string or null, every recorded number finite with no null where a count belongs; and a
`status.js` wrapper that fails every `tokens` call, the task still reaching exit 0 with at
least one call observed. An attempt that records nothing leaves the earlier accumulation
**intact**. Schema conformance is checked by an **inline admitter** against a checked-in
fixture, not `ajv` (`repo-1cy` / `repo-teq` precedent).

*Kills:* the `NaN` trap — arithmetic over a missing key yields `NaN`, serialisation writes
null, and the field reads as "not recorded" forever while looking well-formed.

### C4 — both schema changes are additive, checked without ajv and without `runs/`

Each schema gains exactly one property; `required` and `additionalProperties` are unmoved in
both. A **checked-in historical-shaped fixture** under `schemas/examples/` — beside the
existing `status.valid.json` — is admitted by the inline admitter, and a fixture `run.json`
carrying `modelTokens` is admitted too.

*Kills:* editing the status schema and forgetting the manifest's — otherwise invisible until
a Docker suite runs on the host.

### C5 — the manifest and report carry it as evidence, and it moves nothing

The task row carries the object **verbatim** when present and omits the key entirely when
absent, matching the `model` spread in `runner/run.js`. The report renders the literal fact
line **`Tokens: <in> in / <out> out / <cacheRead> cached`** immediately after the existing
`Model:` line, and renders **no such line** when the record is absent. Regeneration from one
manifest is byte-identical, and **`byScrutiny` produces an identical task order** with and
without every `modelTokens` field stripped.

*Kills:* folding cost into `scrutinyKey`, which would make it a gate by the back door.

### C6 — accumulation survives a rate-limit relaunch, and key order is sorted

Drive **one workspace twice**: the first container ends at exit 20 via a rate-limit stub
after recording usage, the second completes.

**Done means** the final record includes the first container's figures — `status.json`
survives a relaunch by design (§4.7), so an implementation that accumulates in memory and
writes once at exit, or writes a fresh object per container, silently discards everything
spent before the pause. Separately, a fixture whose first envelope introduces `z-model`
before `a-model` must yield keys of exactly `a-model`, `z-model` in that order in **both**
`status.json` and the task row — the container sorts on write, the manifest copies verbatim.

*Kills:* the in-memory accumulator, which passes C1 (three invocations, one container) while
losing every pre-pause token; and encounter-ordered keys, which vary run to run because the
CLI lists the helper model first (defect 8) and the docs envelope can add a key the code
phase never saw.

**Note on the stated floor.** The decision above accepts that a rate-limited attempt
under-counts, because the entrypoint exits 20 before the envelope is read. C6 bounds how
large that floor is: everything recorded *before* the pause survives, so the loss is one
attempt's partial spend, not the whole pre-pause history.

## Task 2 — the audit's per-model cost cut

**Depends on task 1.** Reads only what task 1 records; touches only `scripts/audit-runs.js`
and its suite.

### C7 — cost is cut by the record's own model keys, in its own subsection

The `### Models` block gains a **separate cost subsection** keyed by the `modelTokens`
record's own keys — **not** folded into the resolved-model buckets, which key on
`task.model`, one id per row. A task whose record names a model that is never any row's
resolved id (the docs-phase or helper model) must still appear. Denominator: the number of
task rows whose record names that model, out of the rows that recorded any usage at all.

*Kills:* summing a row's whole record into its resolved-model bucket — which attributes
tokens to a model that did not spend them, the defect-8 shape in new clothes — and re-keying
the existing buckets, which leaves "how many of that model's rows" with no denominator.

### C8 — the audit stays a pure reader

Byte-identical stdout across two invocations over one tree; no `child_process`; a
before/after content-hash snapshot showing no file created, modified or deleted; exit 0 on a
corpus where nothing records usage.

## Explicitly excluded sibling — do not fix in these diffs

`schemas/run.schema.json` allows a `verification.regressions` of `pass`, `fail` or `absent`;
`schemas/verify.schema.json` gained `error` in change-log row `verify-nobuffer`, and
`runner/run.js` copies the value verbatim. A run whose regression pass is killed writes a
manifest that fails its own validation. **One enum value, its own change-log row.** Named
here because an agent writing C4's schema checks will meet it and be tempted — and a
verification-adjacent schema change does not belong inside a measurement PR.

## What still needs the user (PLANNING.md step 5)

1. **Approve the "Done means" lists** — C1–C6 for task 1, C7–C8 for task 2. This is the
   hard-rule-4 gate; nothing freezes before it.
2. **Confirm the split** — two tasks in one-way order, or one bigger task?
3. **Confirm `hard`**, which is what bought the full panel.
4. **Confirm the three decisions**: tokens not dollars; the accepted under-count floor;
   `modelTokens` as the field name.

Not yet done, and deliberately: no `DESIGN.md` row written, no frozen tests (step 3), no
freeze-gate run (step 4), no Beads issue. All of it waits on the gate above.

---

# Approved (2026-08-18) — PLANNING.md step 5 gate passed

The user approved the whole thing: **C1–C6 for task 1, C7–C8 for task 2, the two-task
split in one-way order, and the `hard` label.** The three decisions carried with it —
tokens not dollars, the accepted under-count floor, and `modelTokens` as the field name.
The two assumptions taken rather than held (no PR-footer figure; the three
defect-8-misattributed rows left visible rather than filtered) stand unchanged.

Nothing above this line was edited after approval; everything below records what the
approval then unblocked.

## What was done on approval

**1. `DESIGN.md` amended, change-log row `task-cost` appended.** §4.3's envelope rule
gains the cost-record paragraph (four counts, accumulation across invocations and across
a relaunch, capture before flatten, sorted keys, tokens-not-dollars, the stated floor,
non-fatal, never an outcome). §4.11's status-file enumeration gains `modelTokens` beside
`model` and `phase`. `bash scripts/test-changelog.sh` is green (19 checks).

**2. Beads issues created (PLANNING.md step 6, done early so no placeholder path leaks
into the criteria).**

| Issue | Task | Priority | Blocked by |
|---|---|---|---|
| **`repo-t3h`** | Record what each task cost — per-model tokens through `status.json`, the manifest and the report | 1 | — |
| **`repo-ybl`** | The audit's per-model cost cut — tokens keyed by the record's own model ids | 2 | `repo-t3h` |

`bd ready` returns `repo-t3h` alone, which is the one-way order the split asks for.

**3. Frozen tests written (step 3), before any implementation exists.**
`tests/acceptance/repo-t3h/test.js` and `tests/acceptance/repo-ybl/test.js` — plain Node,
Docker-free, no `ajv`, nothing under `runs/`, every stub reached through an explicit
interpreter. Task 1's rig drives the real `pipeline/entrypoint.sh` with runtime copies of
`status.js` and `envelope.js` in a temp `PIPELINE_DIR`, a stub `verify.js`, and a `.js`
agent stub behind the `PIPELINE_AGENT_CMD` seam; the manifest half drives `runOneTask`
through `PIPELINE_EXEC_STUB` / `PIPELINE_BD_CMD` / `PIPELINE_GH_CMD` against a local bare
remote. Task 2's drives the real audit CLI through `AUDIT_RUNS_DIR` over planted corpora.

## Names and line shapes pinned during test-writing

Drafting the tests forced four decisions the prose had left implicit. All four are now in
the issues, which are the canonical spec from here.

- **The report's `Tokens:` line sums across every model in the record**, and shows three
  of the four counts: `Tokens: 925 in / 118 out / 9250 cached`. `cacheCreationInputTokens`
  is carried in `status.json`, the manifest and the audit, but not on that line — the
  report's fact list is a scannable summary, not the artifact.
- **A missing or non-numeric count reads as 0**, the rule `pipeline/envelope.js` already
  applies in its `tokens()` helper. Pinned so C3(d) can assert an exact total rather than
  a range: a good envelope followed by a garbage one totals exactly the good one.
- **The audit's cost subsection is headed by the literal `#### Token cost`**, sits inside
  `### Models`, carries `<N> of <M>` per model (N = rows whose record names it, M = rows
  that recorded any usage), and a coverage line containing `no usage recorded`. On a
  corpus that records nothing it prints the literal `(no task row recorded any token
  usage)` and exits 0.
- **C4 needs no new fixture file.** The historical shape is built inline and the
  checked-in `schemas/examples/status.valid.json` is admitted as-is, so the criterion
  invents no deliverable that the spec did not ask for.

## Guard sub-checks, counted rather than hidden (step 4)

Several sub-checks are **`[guard]`s** — green at the fork point by construction, because
they assert that existing behaviour still holds: C2's flatten contract, C3(a)(b)(c), C4's
`required` / `additionalProperties` halves, C5's absent-record and `byScrutiny` halves,
and C8's determinism and no-`child_process` checks. Every one of them is paired inside a
criterion that is red before implementation, so **no criterion is all guards** and the
task has a real behavioural signature.

## Freeze-gate evidence (step 4)

Both suites run to completion at the fork point and both are **red on the feature and
green on every guard** — the discriminating state the gate exists to prove. Task 1's rig
reaches every drive: exit 0 on the C1/C2/C3 runs, exit 20 then exit 0 across C6's two
containers, and a returned task row from `runOneTask` in both C5 drives. Nothing failed
for a harness reason.

## Found next door — still not fixed here

`schemas/run.schema.json` allows `verification.regressions` of `pass|fail|absent`;
`schemas/verify.schema.json` gained `error` in change-log row `verify-nobuffer`, and
`runner/run.js` copies the value verbatim. A run whose regression pass is killed writes a
manifest that fails its own ajv validation in `scripts/test-report.sh` and
`scripts/e2e.sh`. One enum value, its own change-log row, its own task — deliberately
outside both diffs, and named in `repo-t3h`'s constraints so the agent that meets it while
writing C4's schema checks knows it is out of scope rather than overlooked.

## Still outstanding before a run

- The frozen tests must be committed to `main` and pushed **before** the run — the
  verifier diffs `tests/acceptance/` against the task branch's fork point, so tests that
  are not on the integration branch are not frozen (PLANNING.md step 6.1).
- No new dependencies, so step 7 is a no-op: nothing is added to
  `pipeline.config.json`'s `dependencies` and no image rebuild is needed.
- Step 8's pre-run checklist (ready queue, image present, Docker Desktop up) is a
  run-time check, not a planning one.

---

# Task 3 — the regressions enum drift (approved 2026-08-18, same session)

The sibling defect the `task-cost` panel found and deliberately excluded from both
measurement diffs. Approved as its own task; specced here through the same path.

**Issue: `repo-4d8`** — "Close the regressions enum drift between verify.schema.json and
run.schema.json", priority 1, no dependencies. Independent of `repo-t3h` / `repo-ybl` in
both directions: different files, no shared criterion.

## The defect, verified rather than assumed

`schemas/verify.schema.json` accepts four values for `regressions`; change-log row
`verify-nobuffer` added `error`, meaning the regression run was killed before reaching a
verdict — deliberately distinct from `fail` (which would downgrade a passing task to
`partial` on a harness fault) and from `absent` (which would hide it).
`schemas/run.schema.json` accepts three. `runner/run.js` copies the value onto the
manifest task row **verbatim** — no mapping, no filtering — so a run whose regression pass
is killed writes a `run.json` that fails its own ajv validation in `scripts/test-report.sh`
and `scripts/e2e.sh`.

Checked in the code before drafting, not remembered:

- `runner/queue.js`'s `outcomeFor` downgrades to `partial` on `regressions === 'fail'` and
  on nothing else, so `error` **already** leaves a passing task `done`. That is the
  behaviour `verify-nobuffer` intended and this task must not touch it.
- `runner/report.js` and `runner/publish.js` interpolate the value as a string with no
  enum of their own; `scripts/audit-runs.js` and `scripts/dashboard.js` never read the
  field. The blast radius really is the one schema.
- The only consumers of `run.schema.json` are two `npx --yes ajv` calls. Neither suite's
  fixture carries a row with `regressions: "error"` today, so a schema-only fix would
  widen a contract that nothing ever exercises.

## Panel

Label proposed **`trivial`**, revised to **`medium`** — not for size, but because the
critic showed the deliverable was larger than "one enum value" (finding 1 below). One
critic, per the `trivial`/`medium` tier: `testability`, fresh context, charter verbatim.
Verdict **`concerns`**, six findings, **all six accepted, none rejected or deferred.**

| # | Finding | Disposition |
|---|---|---|
| 1 | **The durability claim had no criterion behind it.** A frozen acceptance test is run by `pipeline/verify.js` during its own task's run and **never again** — `scripts/test-all.sh` discovers suites by the glob `scripts/test-*.sh`, and nothing in `scripts/` ever runs an acceptance directory. So "the two schemas cannot drift apart again" was false as designed: the check would stop executing the moment the task closed | **Accepted, and it grew the task.** New criterion D4 requires a re-runnable `scripts/test-schema-drift.sh` over `tests/unit/schema-drift.test.js`, discovered by the sweep glob, on the `test-audit-runs.sh` / `test-dashboard.sh` precedent. **Verified independently before acting** — the glob is at `scripts/test-all.sh:79` and both precedent suites carry a header saying why they are re-runnable rather than frozen |
| 2 | The cross-schema equality check **passes vacuously** if either lookup misses: the field nests four levels deep in one file and one level deep in the other, so a mis-navigation compares `undefined` to `undefined` and reads as agreement | **Accepted.** Both JSON paths are pinned in the criterion text, and each side is asserted to be a located array of length ≥ 4 **before** the comparison runs |
| 3 | "Otherwise unmoved" checked by four sampled properties would pass an implementation that also widened the `outcome` enum, deleted `concurrency`, flipped `additionalProperties` or dropped a `maxItems` | **Accepted.** D5 deep-equals the parsed file against an image of the fork-point file with the single new member added, and names the first differing path. The baseline cannot go stale — fork-point state is fixed history |
| 4 | The admitter's fidelity to **ajv** is unpinned; if it is permissive where ajv is not, the criterion is green while the real validator still rejects | **Accepted.** The load-bearing assertion is now a direct one on the parsed enum arrays; the admitter is demoted to what it can honestly show — a full row is accepted, an invented value is not. The `repo-bmd` precedent does exactly this |
| 5 | The admitted fixture was a two-key stub; with `additionalProperties: false` on both the row and the `verification` object, that tests **strictly less** than the artifact that fails in the field | **Accepted.** The fixture is now a realistic row of the shape `runner/run.js` writes, including `verification.evidence` and the optional `model` / `changeSummary` / `stuckState` / `specConcerns` keys |
| 6 | Nothing pinned how the schema files are located — a `cwd`-relative read passes in the container and from the repo root and fails silently-differently elsewhere, turning into the empty-set comparison of finding 2 | **Accepted.** Both paths resolve from `__dirname`, and both files are asserted to have parsed before any comparison, with a loud harness-broken exit if either did not |

## Criteria, after the panel

**D1** the manifest admits every value the verifier can emit — paths pinned, each enum
located and non-trivial before comparison, vocabulary read from `verify.schema.json`
rather than written down, realistic row shape. **D2 [guard]** the verifier's vocabulary is
not narrowed and the admitter can in fact reject, on the same path D1 admitted.
**D3 [guard]** `error` still does not downgrade a passing task — `outcomeFor` driven
in-process over four probes. **D4** the drift check keeps running: the new suite is green
against the real schemas and **red against a planted drifted pair** through its
`SCHEMA_DRIFT_DIR` seam. **D5 [guard]** `run.schema.json` is otherwise unmoved.

## Freeze-gate evidence

`tests/acceptance/repo-4d8/test.js` — **red on the feature, green on every guard.** D1
fails on the located-but-short enum and on the `error` row; D4 fails because neither the
suite nor its checker exists yet; D5 fails naming the exact path
(`$.properties.tasks.items.properties.verification.properties.regressions.enum: length 3
vs 4`). D2 and D3 are green, as labelled guards should be. Gate exit 0.

## Two things deliberately not done

- **No `DESIGN.md` change-log row.** This restores a contract §4.11 already implies rather
  than deciding anything new, so the row is the implementing task's to write, keyed on
  `repo-4d8` — the repo's convention for a row a pipeline task produces.
- **No proof that the two Docker suites now accept such a manifest under real ajv.** Both
  need ajv and Docker, which frozen tests may not use. The constraint requiring
  `scripts/test-report.sh`'s fixture to gain a row carrying `regressions: "error"` is what
  puts the widened enum in front of real ajv on the host; that proof belongs to the host
  sweep, and is stated as out of scope rather than left as a silent orphan.
