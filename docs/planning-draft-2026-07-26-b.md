# Planning draft — 2026-07-26 (session B)

The second planning session of the day. Session A's snapshot is
`docs/planning-draft-2026-07-26.md`; this one is separate because it plans different
work and the earlier file is the frozen record of `repo-52m`.

This began as the step-5 approval pass. **It was approved and frozen on 2026-07-26** —
see "Approved and frozen" at the bottom for what was decided, the issue ids, and the
coverage check. The body below is preserved as written for approval, so the record shows
what was agreed rather than what it became.

---

## Why this slate, and what got cut

The Beads queue was empty on both the pipeline and the shadow-trial project. That
project had already finished its current milestone, and its remaining items need
physical inputs a container with no internet and no camera cannot produce. Its next
milestone is a direction decision, not a task, so it is out of this round.

That leaves the pipeline's own queue, and the highest-value gap in it: **V1 gives an
agent no way to say "the spec is wrong."** Shadow-01 is the proof — the agent wrote the
correct implementation on attempt 1, diagnosed the broken gate correctly in its own
notes, watched it fail anyway, and then contorted correct code until the broken gate
went green. It knew, and could only comply.

---

## Step 0 — A design amendment has to come first (this is a change to the plan)

**Plain English:** before we send an agent to build the "spec is wrong" channel, the
design doc has to say the channel exists and what shape it takes. Otherwise the agent
either invents the contract itself, or edits the constitution while nobody is watching.

The scope critic caught this and it is right. `specConcerns` appears **nowhere** in
`DESIGN.md` — verified by grep across the doc, `docs/`, and `schemas/`. The precedent
cuts the same way: §3.6 declared `memoryNotes` in the doc *before* `repo-zdm` built it,
because a status-file field spanning the entrypoint, the runner, and the report is a
cross-component contract, and §10's dividing line puts those in the doc.

So the sequence is:

1. **Amend `DESIGN.md` here, in this session** (host-side, interactive, with your
   approval) — declare the channel, its bounds, and the rule that it can never gate.
2. **Task A** — a container builds the container-side half.
3. **Task B** — a later run builds the host-side half.

### The proposed amendment (new §3.7, plus a change-log row)

> **3.7 Spec concerns (the "this spec is wrong" channel).**
> §3.3 states that drift flows upward: an agent reporting "the spec is wrong" is a
> first-class result, not a failure. V1 gave that principle no mechanism — an agent that
> believed its frozen spec was wrong could only comply, and shadow-01 showed exactly what
> that costs. The channel closes the gap without weakening anything.
>
> The status file carries an optional `specConcerns` array of strings. The coding and
> docs agents may append to it with `status.js concern "<text>"`; the host reads it after
> exit and surfaces it in the attempt log, the run manifest, the run report, and the PR
> body. Bounds: at most 5 entries, each truncated to its first 1000 characters, the
> mechanism `status.js note` already uses for `memoryNotes` but with different numbers —
> a spec concern is rarer than an insight and needs more room to be actionable.
>
> **A concern is evidence and never a gate** (§3.5). It cannot change an outcome, an
> exit code, a Beads transition, or whether a branch is published. This is the same
> posture as `advisories`, and it is what keeps the three-attempt cap meaningful: an
> agent cannot escape a task it dislikes by declaring the spec broken. What a concern
> does is reach the human at review time, where changing a spec is legal — §3.3's
> approval gate, reopened deliberately, rather than a run rewriting its own definition
> of done.

Change-log row (appended at the bottom of the §12 table, ascending order):

> | 2026-07-26 | v1.9: §3.7 declares the spec-concern channel — `specConcerns` in the status file, `status.js concern` as the writer, host surfacing at review time, evidence-only per §3.5. Warranted by §3.3 (drift flows upward) and by shadow-01, where the agent diagnosed a broken gate correctly and had no channel to say so. | Container-side and host-side halves are separate tasks, sequenced. |

**Your call:** approve, change the bounds, or reject the whole channel. If you reject it,
Task A and Task B both disappear and the slate is Task C alone.

---

## Task A — Spec-concern channel, container side

**Difficulty: medium** (I labelled it hard; the scope critic argued medium, because the
implementation is a mechanical clone of `repo-zdm` in three files. Over-labelling only
costs a full critic panel, which we already ran, so this is recorded rather than acted on.)

**design-ref:** `DESIGN.md` §3.7 (the new section above), §3.3, §3.5, §4.11.
*(My first draft cited §3.2. That was wrong — §3.2 is about how specs get produced. The
line that actually warrants this task is §3.3:127, "Drift flows upward.")*

### Description
Give the coding and docs agents a channel to report that the frozen spec is itself the
problem. Adds an optional `specConcerns` array to `schemas/status.schema.json`, a
`pipeline/status.js concern "<text>"` subcommand that appends to it, prompt text in both
entrypoint phases telling the agents the channel exists, and a line in this repo's
`CLAUDE.md` container section beside the existing `status.js note` guidance. The host
side — surfacing concerns in the attempt log, manifest, report, and PR body — is Task B
and is explicitly not part of this.

### Constraints
- **Evidence only.** Raising a concern must not change any outcome, exit code, or
  control-flow branch in `pipeline/entrypoint.sh`, and must not modify `pipeline/verify.js`
  or anything under `runner/`.
- Container-side only; no Beads access.
- Bounds: **at most 5 entries, each truncated to its first 1000 characters** (head kept),
  and the 6th and later calls are silent no-ops that exit 0. Same mechanism as
  `status.js note`, different numbers — `note` is 20/500 and this is 5/1000.
  *(My first draft said "exactly as `note` does" AND "5/1000". Those contradict; an agent
  copying `note` verbatim would have failed its own acceptance tests.)*
- **Usage errors behave exactly as `status.js note` does**: missing or whitespace-only
  text exits 2 and changes nothing; a missing status file exits 2 and creates nothing.
  *(This is the one place the "never change an exit code" constraint does not apply —
  it governs the entrypoint's outcome, not the helper's own usage errors.)*
- If `specConcerns` exists but is not an array, replace it with a fresh array — the same
  thing `note` does with a malformed `memoryNotes`. If it already holds 5 or more
  entries, append nothing and exit 0.
- Do not modify `tests/acceptance/**` or any path in `pipeline.config.json`'s `frozenPaths`.

### Done means
- **A1.** `schemas/status.schema.json` declares `specConcerns` as an optional array of
  strings, `maxItems` 5, `items.maxLength` 1000, absent from the root `required` list,
  with root `additionalProperties` still false.
  *(Checked structurally, by reading the schema's keywords. **Not** by running a
  validator: every ajv use in this repo goes through `npx --yes`, which needs the npm
  registry, and the container has no route there. This is what `repo-zdm` did for
  `memoryNotes`.)*
- **A2.** `schemas/examples/status.valid.json` carries a `specConcerns` entry, so
  `scripts/test-status-schema.sh` exercises the new field on the host with a real
  validator.
- **A3.** `node pipeline/status.js concern "<text>"` appends one entry, creating the
  array when absent, preserving every other field. Two calls leave two entries in order.
- **A4.** A 6th call against a file holding 5 entries exits 0 and leaves exactly 5.
- **A5.** Text longer than 1000 characters is stored as exactly its first 1000
  characters, and the 1001st character is absent.
- **A6.** Both generated prompts — `.run/prompt-$N.md` (code phase) and
  `.run/prompt-docs.md` (docs phase) — contain the literal string `status.js concern`
  and a statement that a concern cannot change the outcome.
  *(Asserted against the **generated prompt files**, not against `entrypoint.sh`'s source.
  My first draft said "entrypoint.sh contains prompt text", which a shell comment
  satisfies — the agent would never have been told anything.)*
- **A7.** **The evidence-only invariant, checked on the failure path:** a run under a
  stub agent that records a concern, with a stub verifier that fails and
  `PIPELINE_MAX_ATTEMPTS=1`, still exits 10 and still writes `stuckState`. Plus:
  `pipeline/verify.js` and everything under `runner/` are byte-identical to the fork
  point.
  *(New. My first draft exercised only the success path, so an implementation that
  branched the entrypoint on a non-empty `specConcerns` would have passed every
  criterion — the exact defect this task exists to prevent.)*
- **A8.** A full entrypoint run under a stub agent and a **stub verifier**, in a temp
  `PIPELINE_DIR` with an explicit minimal environment, exits 0 and leaves a status file
  containing `issueId`, one `attempts` entry with `verifierResult` `pass`,
  `changeSummary`, and the concern text present in `specConcerns`.
  *(Membership check, never an array length: the docs phase invokes the agent a **second**
  time, so a stub that records a concern on each call leaves two entries. A test pinning
  length 1 would fail correct code — the mirror image of shadow-01. And the stub verifier
  matters: the real `verify.js` re-runs `sh tools/run-acceptance.sh`, so a test that used
  it would invoke the acceptance runner from inside the acceptance runner and recurse
  until the 15-minute timeout — while inherited `WORKSPACE`/`RUN_DIR` let it overwrite the
  live task's own status file and fire a real model call through the inherited
  `PIPELINE_AGENT_CMD`.)*

---

## Task B — Spec-concern channel, host side

**Difficulty: medium. Specced but NOT frozen today, and not queued.**

### Description
Surface `specConcerns` where a human reviewing a run already looks: the Beads attempt
log, the per-run manifest, the run report, and the PR body. Host re-enforces the schema
bounds on the agent-written file (first 5 entries, first 1000 characters each) exactly
as `fileMemoryNotes` does. Never changes an outcome; a malformed or absent array is
logged and ignored.

### Why it is not being frozen now
Two independent reasons:

1. **It cannot run in the same batch as Task A.** The runner reads the ready queue once,
   before the task loop (`runner/run.js:124`), so a dependency cannot unblock mid-run.
2. **Freezing tests for a task that runs weeks from now is how tests go stale.** That is
   the failure we spent this morning fixing — T12 sat unrun while T15 and T17 changed the
   runner underneath it and accumulated three staleness bugs.

**Proposal:** file it as a blocked Beads issue carrying the description, and write its
tests in the planning session that precedes the run that executes it — after Task A's
PR has merged.

---

## Task C — A re-runnable, Docker-free suite for `runner/memory.js`

**Difficulty: medium.** **design-ref:** `DESIGN.md` §3.6, §4.4.

### Description
Both §3.6 memory channels live in `runner/memory.js`, and its only coverage sits inside
two per-task acceptance directories (`tests/acceptance/repo-eyn/`, `repo-4gp/`). Those
are frozen artifacts of finished tasks, not a regression suite — nothing ever runs them
again. This extracts that coverage into a standalone Docker-free test file plus a
`scripts/test-runner-memory.sh` wrapper, which the sweep picks up by glob.

### The finding that reshaped this task
The critic claimed, and I verified on this machine, that **the `PIPELINE_BD_CMD` seam
does not work on Windows**:

```
#!/bin/sh stub via spawnSync → status: null, error: EFTYPE
```

Both frozen tests write a `#!/bin/sh` stub and `runner/bd.js:28` spawns it with no
shell. Fine in the Linux container; on your host every stubbed `bd` call reports failure,
so `exportMemory` would write `(no memories recorded)` and `fileMemoryNotes` would file
nothing. A suite extracted the obvious way would be **green in the container and red in
the sweep** — and the sweep is the thing I just told you to run after every merge. The
seam has only ever run inside a container, so nothing caught this.

So the suite must use a **stub invoked through `process.execPath`** (a `.js` stub run by
node) rather than a shebang script. That works identically on both platforms.

### Constraints
- The existing frozen acceptance directories must not be modified, moved, or deleted —
  the verifier diffs all of `tests/acceptance/` and any change ends the task as tampered.
- Docker-free: drive `runner/memory.js` only through the `PIPELINE_BD_CMD` seam. No
  Docker, no network, no real `bd`.
- No `node --test` in the new test file or the wrapper — plain Node with asserts,
  exit 0/1, matching `tests/acceptance/README.md`.
- The stub must be a `.js` file invoked via `process.execPath`, never a shebang script.
- The wrapper follows suite conventions: `PASS  <check>` / `FAIL  <check>` lines,
  non-zero exit on any failure.
- Do not modify `scripts/test-all.sh`.

### Done means
- **C1.** `tests/unit/memory.test.js` runs under plain `node` with no arguments, exits 0
  when every check passes, and — verified via a `MEMORY_TEST_EXTRA` override pointing at
  a fixture that fails — exits non-zero when any check fails.
  *(The override is new. Without an injectable failure, "exits non-zero when it fails"
  is unfalsifiable: a file with zero assertions satisfies the green half.)*
- **C2.** Covers `exportMemory`: the count returned for N memories; the zero-memory case
  writing `(no memories recorded)` with `count: 0`; a `bd` failure being non-fatal.
- **C3.** Covers `fileMemoryNotes`: more than 20 notes truncated to exactly 20; a note
  longer than 500 characters stored as exactly its first 500 with the 501st absent; the
  `<issueId>-note-<n>` key format; and absent-or-empty `memoryNotes` producing **zero**
  `bd` invocations.
  *(The outcome-gating clause is **cut**. The gate is an inline array literal at
  `runner/run.js:203` — `fileMemoryNotes` never sees the outcome, so a unit test of
  `memory.js` cannot observe it. Testing it would mean grepping `run.js` source text,
  which restates the implementation and passes on code where the call is dead. See the
  open question below.)*
- **C4.** Covers the seam contract itself: exactly one spawn, the argv carries
  `memories --json`, no `-C` prefix, no `docker` in the argv. This is what would catch a
  regression in `runner/bd.js` re-introducing the host probe or the Docker fallback.
- **C5.** `sh scripts/test-runner-memory.sh` runs the file and propagates its exit
  status — 0 when it passes, non-zero when the `MEMORY_TEST_EXTRA` fixture fails it —
  and is spawned with a scrubbed environment so the parent's own stub cannot leak in.
- **C6.** Neither file runs docker and neither passes `--test` to node, checked against
  **executed commands with comment lines stripped** — not any occurrence of the words.
  *(A header comment reading "Plain Node, Docker-free" contains "Docker", and a file
  documenting the constraint contains "node --test". The naive grep would fail correct
  code and push an agent to delete accurate comments to turn the gate green — shadow-01,
  exactly.)*
- **C7.** The suite is named `scripts/test-runner-memory.sh` and lives in `scripts/`, so
  it matches the sweep's `scripts/test-*.sh` glob.
  *(Restated. My first draft asserted `test-all.sh --list` includes it — but
  `test-all.sh` exists only on the unmerged branch `chore/full-suite-sweep`. A task
  branching off `main` would have gone red on all three attempts against a missing file
  it was forbidden to create. **PR #9 should merge before this run regardless**, but the
  criterion no longer depends on it.)*

---

## Open questions for you

1. **Approve the §3.7 amendment?** Everything in Task A and B depends on it. Bounds are
   5 entries / 1000 characters — say if you want different numbers.
2. **Task C's outcome gate.** The rule "memory is filed for done/partial/failed/stuck,
   never tampered or paused" is a real §3.6 design rule with **no re-runnable test**, and
   it cannot get one while it is an inline array in `run.js`. Options: (a) leave it —
   Task C covers `memory.js` only; (b) widen Task C slightly to export the gate from
   `memory.js` as a predicate that the suite can test. (b) is a small change to `run.js`,
   which the constraints currently forbid.
3. **Priority and order** — my proposal: Task A at priority 1, Task C at priority 2, both
   in the same run (they touch different files: A is `pipeline/` + `schemas/`, C is
   `tests/unit/` + `scripts/`, so they cannot collide). Task B filed blocked. Yours to
   decide.
4. **Merge PR #9 first?** Not strictly required any more, but the sweep should be on
   `main` before a run that adds a suite to it.

---

# Approved and frozen — 2026-07-26

All four open questions were decided: §3.7 approved as drafted; Task C widened to export
the outcome gate; A and C queued together with B blocked; PR #9 merged first.

| Issue | Task | Priority | Status |
|---|---|---|---|
| `repo-1cy` | Spec-concern channel, container side | 1 | open — frozen, queued |
| `repo-dhp` | Docker-free suite for `runner/memory.js` | 2 | open — frozen, queued |
| `repo-iok` | Spec-concern channel, host side | 3 | **blocked** on `repo-1cy`; no frozen tests by design |

`DESIGN.md` amended to **v1.9** (§3.7 + change-log row) before anything was frozen, so
neither task has to invent a cross-component contract.

## Step 4 — coverage check

Every criterion names the checks that prove it; every check names the criterion it
serves. No orphan on either side.

### `repo-1cy` → `tests/acceptance/repo-1cy/test.js`

| Criterion | Checks that prove it |
|---|---|
| A1 schema keywords | 7 checks: declared, type, maxItems 5, items type, maxLength 1000, optional, additionalProperties |
| A2 valid example | 1 check on `schemas/examples/status.valid.json` |
| A3 append + preserve + usage errors | 7 checks: exit 0, order, fields preserved, whitespace-only rejected + no-op, missing file rejected + creates nothing |
| A4 the cap | 3 checks: filled to 5, 6th exits 0, 6th dropped |
| A5 truncation | 2 checks: exactly 1000 chars, head kept |
| A6 both generated prompts | 6 checks: both prompts generated, both name the command, both carry the literal phrase |
| A7 evidence-only invariant | 7 checks: exit 10 on failure, stuckState written, concern recorded anyway, fork point resolved + listed, verifier/runner unchanged, nothing added under `runner/` |
| A8 success path | 5 checks: exit 0, issueId, one attempt with `pass`, changeSummary, concern present by membership |

### `repo-dhp` → `tests/acceptance/repo-dhp/test.js`

| Criterion | Checks that prove it |
|---|---|
| C1 suite runs, and fails when it should | 7 checks: file exists, exit 0, no FAIL lines, ≥12 checks, injected failure turns it red, injected pass leaves it green |
| C2 exportMemory covered | 1 label check |
| C3 fileMemoryNotes covered | 1 label check |
| C4 seam contract covered | 1 label check |
| C5 the outcome predicate | 11 checks: requirable, exported, 4 true cases, 2 false cases, unknown, undefined, `run.js` calls it, `run.js` no longer inlines the list |
| C6 wrapper propagates + scrubs | 5 checks: exit 0, PASS line, non-zero propagated, FAIL line, poisoned environment still green |
| C7 no docker, no `--test`, stub via execPath | 6 checks across both files, comment lines stripped |
| C8 discoverable by the sweep glob | 2 checks: exists, name matches |

## Both suites verified red for the right reason

Run in `pipeline-base:local`, which is where the verifier runs them — running acceptance
tests on the Windows host lies. Every failure traces to unimplemented behaviour; nothing
fails because a test is broken.

Two findings came out of writing them, both now fixed in the frozen tests:

1. **`git` needs `-c safe.directory=*`.** The workspace is a host-owned bind mount, so
   git's dubious-ownership guard blocks every call unless ambient config happens to be
   set. A frozen test must not depend on ambient config.
2. **`git diff --name-only` cannot be used for the A7 fork-point check.** A
   Windows-origin clone stores CRLF, so inside a Linux container every file differs from
   its blob and the diff reports the entire runner as changed — the same false positive
   that once made the verifier call a clean checkout tampered. `--ignore-cr-at-eol` does
   not help; it affects hunk generation, not name listing. A7 now compares file contents
   with line endings normalised, against the **working tree** — not `base..HEAD`, because
   the entrypoint runs the verifier *before* it commits, so a committed-state comparison
   would pass no matter what the agent changed. Verified both ways: green on a clean
   tree, and it names `runner/queue.js` when a line is appended to it.
