# Planning draft — 2026-07-28: the spec-concern channel, host side

One task (`repo-iok`). Step-5 approval pass — **nothing frozen yet**, the issue is still
blocked and still carries placeholder criteria.

## Why now

`repo-1cy` built and merged the container side of DESIGN.md §3.7 on 2026-07-26: the
`specConcerns` field in `status.schema.json`, `pipeline/status.js concern` as the writer,
and prompt text in both entrypoint phases telling the agent the channel exists *and* that
it cannot change the outcome. So an agent can now say "this frozen spec is wrong" —
**and nothing on the host reads it.** A channel nobody reads is not a channel.

`repo-iok` was deliberately left blocked and deliberately unfrozen for two reasons that
are now spent:

1. It could not run in the same batch as its dependency — the runner reads the ready
   queue once, before the task loop (`runner/run.js:120`), so a dependency cannot unblock
   mid-run. `repo-1cy` has merged; that constraint is discharged.
2. Freezing tests weeks before the run that executes them is how suites go stale (the T12
   failure). This session is that planning session — the tests are written now,
   immediately before the run, against the code as it stands today.

## What the testability critic changed

Step 2, `advisors/testability.md` pasted verbatim into a fresh context. Nine findings;
all nine are reflected below. The four that mattered:

| My draft said | Problem |
|---|---|
| A3: "`writeManifest()` records a task's concerns verbatim, and a task with none carries no key" | **Cannot fail.** `writeManifest` spreads whatever task objects it is handed and computes nothing, so the check passes against a build where *nothing populates the field at all*. Whether the key exists is decided in `run.js`, which the criterion never reaches. Fixed by extracting `concerns.manifestFields(status)` — the record fragment `run.js` spreads — and asserting *that*. |
| A6: the §4.11 table "with a concern-carrying status passed alongside" | **Meaningless as written**, because `outcomeFor(exitCode, verify)` takes no status — the extra argument is discarded and the check degrades to re-asserting a table that passes today. Fixed by adding a differential: drive `queue.finish()` through the `PIPELINE_BD_CMD` seam and require the non-`note` bd argv to be **byte-identical** with and without concerns, for all six outcomes. The table survives as an honest regression pin, labelled as one. |
| A4/A5: the section "states that it is evidence only" | **Freezes prose the spec never chose.** A frozen test must invent the wording, and after freeze that invented sentence *is* "done" — any rewording fails a correct implementation, while asserting nothing lets the disclaimer be dropped. Fixed by pinning one literal substring (`evidence only`, case-insensitive) and declaring the rest free. |
| The constraint "bounds re-enforced exactly once" | **Had no criterion at all**, and the only source-level check would restate the implementation. Worse: `pipeline/status.js` already caps at 5/1000 on the way in, so *any fixture built from plausible agent output passes against a host that does no bounding whatsoever.* Fixed by one hostile fixture driven through all four surfaces. |

Also adopted: A2's position is now pinned (it was the only surface left unpinned); A4's
"regeneration is byte-identical" is dropped as near-unfalsifiable — `renderReport` is a
pure function, so it passes trivially and passes identically on an implementation that
renders no concerns at all — replaced by an input-order assertion on a deliberately
non-alphabetical fixture; the schema criterion now says `maxLength` sits on the **items**,
not the array; the git fixtures are required to inherit nothing; "never has a PR body
assembled" is restated as the observable "the `gh` stub is never invoked"; and the
deferred `scripts/test-report.sh` proof is now itself gated (see A3).

Two findings I checked and the drafted tests already satisfied — the ajv/network trap
(the test JSON-parses the schema rather than shelling `npx ajv`) and git identity
inheritance — are now stated in the criteria so a later rewrite cannot lose them.

## Task — Surface `specConcerns` in the review artifacts

**Difficulty: medium.** **design-ref:** `DESIGN.md` §3.7 (spec concerns), §3.5 (a
specialist is never a gate), §4.9 (report), §4.11 (outcome taxonomy), §4.12 (manifest).

### Description

When a task's status file carries `specConcerns`, the host surfaces the entries at the
four places a human reviewing the run already looks: the Beads attempt log, the per-run
manifest, the run report, and the PR body. The bounds the container is supposed to
respect — at most 5 entries, each at most 1000 characters — are re-enforced host-side,
because the file is written by the agent and the host never trusts it to have obeyed its
own schema. A concern is evidence: it changes no outcome, no Beads transition, and
nothing about whether a branch or PR is published.

### Constraints

- **Never changes an outcome.** Not the derived §4.11 outcome, not the exit code, not the
  Beads transition, not whether a branch is pushed or a PR is opened. Same posture as
  `advisories`. This is what keeps the three-attempt cap meaningful — an agent must not be
  able to escape a task it dislikes by declaring the spec broken.
- **Non-fatal, like memory filing.** A malformed, absent, or wrong-typed `specConcerns`
  is ignored; it never throws and never fails a task (the `docsPhaseError` posture).
- **The bounds are re-enforced exactly once**, in `runner/concerns.js`, which all four
  surfaces go through. Four independent copies of "first 5, first 1000 chars" is four
  chances to drift.
- No changes under `pipeline/` (the container side is built and frozen), no changes to
  `status.schema.json`, no new dependency.
- Do not modify `tests/acceptance/**` or any path in `pipeline.config.json` `frozenPaths`.
- The host sweep must stay green.
- Docs phase: a `DESIGN.md` §12 change-log row with ref `repo-iok`, and
  `docs/pipeline-diagram.md` amended in the same PR if the shape it draws changes.

### Done means

- **A1 — One bounded normaliser, where a test can reach it.** `runner/concerns.js`
  exports `specConcerns(status)` → an array of strings, and `manifestFields(status)` →
  either `{}` or `{ specConcerns: [...] }` (the fragment `run.js` spreads onto the task
  record). Entries that are not strings, or blank after trimming, are dropped **without
  consuming one of the five slots**; survivors are truncated to their first 1000
  characters, head kept; the first five survivors are returned, in input order. An absent,
  `null`, string, number or object `specConcerns` — or a `null`/`undefined` status —
  returns `[]`. Neither function ever throws.
- **A2 — The Beads attempt log.** `queue.attemptNotes()` emits a `spec concerns: <n>`
  line followed by one indented line per concern carrying its **full text**, internal
  newlines collapsed to spaces so the note's block structure survives. The block is
  **last, after every existing single-line fact**, and `<n>` is the bounded count. No line
  of any kind when the field is absent, empty or malformed. The header line and every
  existing line — attempts, stuck, docs, memory notes, memory in — are unchanged.
- **A3 — The run manifest.** `run.schema.json` declares `tasks[].specConcerns` as an
  optional array of strings, `maxItems` 5 on the array and `maxLength` 1000 on its
  **items**, with the task item still `additionalProperties: false` — asserted by parsing
  the schema, never by shelling a validator (`npx ajv` needs the npm registry, which the
  container cannot reach). `manifestFields()` returns the five bounded values for a
  hostile status and **no key at all** for none/empty/malformed, and `writeManifest()`
  carries them to `run.json`.
  **`run.js` itself is not reachable** — `loadToken` and the Docker preflight sit in front
  of it — so its wiring is asserted on non-comment source and is labelled a weak check
  that cannot tell a live call from a discarded one. The behavioural proof is deferred to
  `scripts/test-report.sh`, and **that deferral is itself gated**: the frozen test fails
  unless the host suite carries a spec-concerns case. Otherwise the carve-out is a hole —
  the verifier runs only this directory, so a deferred assertion nobody wrote is never
  noticed.
- **A4 — The run report.** `report.renderReport()` renders a `**Spec concerns**` section
  inside the task's section, **above `**What changed**`**, containing every surviving
  concern's text in input order and the literal substring `evidence only`
  (case-insensitive; the rest of the wording is free). Absent when the task has no
  concerns, an empty array, or a malformed value — and malformed never throws. Existing
  sections, labels and scrutiny ordering are untouched.
- **A5 — The PR body.** `publish.buildPrBody()` includes a `## Spec concerns` section
  after `## Change summary`, same content rules and same `evidence only` literal. Absent
  when there are none; malformed yields no section and no throw. `## Spec`,
  `## Change summary`, `## Verification evidence`, the PARTIAL call-out and the
  generated-run footer are untouched.
- **A6 — Evidence only, proven three ways.**
  1. The §4.11 table still holds for exit 0 (done, and partial when regressions fail), 10,
     11, 20, 30 and a wall-clock kill. *(A regression pin: it passes today and fails only
     if a concerns clause is woven into `outcomeFor` itself.)*
  2. **The differential.** Driving `queue.finish()` through the `PIPELINE_BD_CMD` seam,
     the bd invocations other than `note` are byte-identical with and without a
     concern-carrying status, for all six outcomes. *(`note` is excluded because its text
     differs by design — that is A2. The transition must not.)* The seam stub is a `.js`
     preloaded via `process.execPath`, never a `/bin/sh` script.
  3. **Publication.** Against a real git repo and bare remote with a `gh` stub, and with
     the fixtures inheriting nothing (explicit `HOME`, `GIT_CONFIG_NOSYSTEM`, explicit
     identity, `core.autocrlf=false`, explicit branch name): a **stuck** task carrying the
     hostile fixture is still pushed, still gets no PR, and the `gh` stub is never
     invoked; a **done** task carrying it is still pushed, still gets its PR, and the body
     the runner actually handed to `gh` carries the bounded concerns.

## Judgement calls I made (say if you want any different)

| Call | Why | The alternative |
|---|---|---|
| The attempt log carries the **full concern text**, not just a count | `memoryNotes` logs only a count, but a memory note is an idea and a concern is an accusation about the spec. A stuck task has no PR, and the run report ages out of `runs/`; the Beads issue is what a human still has in a month. | Count only, matching the `memory notes:` precedent exactly. |
| Concerns render **above** "What changed" in the report | Scrutiny order is the report's organising principle (§4.9). "The agent thinks this spec is wrong" outranks "here is what it built". | Below the verification evidence, as a footnote. |
| The attempt-log block goes **last** in the note | It is the only multi-line entry; putting it first would push the compact facts below a wall of text. | First, directly under the outcome header. |
| Blanks and non-strings dropped **before** the cap of five | A stray empty string must not silently displace a real concern. Deliberately diverges from `fileMemoryNotes`, which slices to 20 first and skips blanks after. | Match `memoryNotes` exactly, wart included. |
| A **new `runner/concerns.js`** rather than folding into `queue.js` | All four surfaces need it, and `report.js`/`publish.js` have no business importing the Beads integration module. Extracting host logic so a Docker-free test can reach it is the precedent of change-log rows `repo-dhp` and `repo-4l8`. | Inline the bounds at each of the four sites — four chances to drift, and the malformed cases become untestable in one place. |

## Step 4 — coverage check

Tests drafted at `tests/acceptance/repo-iok/test.js` (**92 checks**, plain Node,
Docker-free). Every criterion has checks; every check serves a criterion.

| Criterion | Checks | Notes |
|---|---|---|
| A1 normaliser + bounds + malformed | 12 | 8 malformed/absent shapes; the hostile fixture deep-equals the five expected values |
| A2 attempt log | 16 | 4 shared surface checks, 3 historic lines, 3 position, count, newline collapsing, absent/empty/malformed silence |
| A3 manifest, schema, wiring | 15 | 6 schema keywords, 4 `manifestFields`, 1 `run.json`, 2 weak source-wiring, 1 deferred-proof gate, 1 requirable |
| A4 report | 11 | 4 shared surface checks, heading, `evidence only`, placement, absent/empty/malformed, existing sections |
| A5 PR body | 11 | 4 shared surface checks, heading, `evidence only`, placement, absent/malformed, existing sections |
| A6 evidence only | 27 | 8 table rows, 1 seam liveness, 6 transition differentials, 12 across the two publish legs |

The four **shared surface checks** are the same fixture and the same four assertions
applied to the attempt log, the report, the PR body, and the bytes `gh` actually received:
all five survivors present, all three dropped entries absent, the cut at exactly 1000
characters (the 1001st is a distinctive `Z` that must appear nowhere), and input order
preserved. That is the behavioural gate on "the bounds live in exactly one place".

No orphan on either side.

## Verified red on the host

**92 checks: 47 fail, 45 pass, exit 1** — and the split is the point. Everything that
depends on unbuilt code fails; every invariant that already holds passes, including all 8
outcome-table rows, all 6 transition differentials, and 7 of the 8 publish checks. The bd
seam is proven live by its own check (the stub records the `close` for a done task), so a
green differential means the transitions really were compared, not that the harness was
silently broken.

**Not yet verified in the container image** — Docker Desktop is not running on this
machine. A6 builds real git repos, pushes to a bare remote, and preloads a Node stub
through `NODE_OPTIONS`; that is exactly the platform-sensitive shape that made `repo-dhp`
green in the container and red in the host sweep. **Run
`sh tools/run-acceptance.sh tests/acceptance/repo-iok/` inside `pipeline-base:local`
before freezing**, and expect the same 47/45 split.

## What freeze would do (not done yet)

1. Commit `tests/acceptance/repo-iok/test.js` to `main` and push — frozen means the paths
   as they exist at the task branch's fork point.
2. Replace the placeholder acceptance criteria on `repo-iok` with A1–A6, and set the
   priority (it is P3 today).
3. Unblock it — `repo-1cy` is closed, so the dependency is already satisfied; the block is
   the deliberate hold described above.
4. Pre-run checklist: `bd ready` lists exactly `repo-iok`; Docker Desktop up; the
   per-project image exists. No new dependency, so no image rebuild.
