# Task specs v2 — revised against critic findings (planning session 2026-07-25)

Critic findings applied: A (2 blockers fixed), B (2 blockers + 4 minors fixed),
C split into C + D per the scope critic; every frozen test now targets a pinned
module/function; the bd invocations are verified against bd 1.1.0 in the base image
(`bd memories --json` → object of key→text plus `schema_version`; `bd remember
"<text>" --key <key>` stores, updating in place on key collision).

---

## Task A — Advisor registry: charter format + the three planning-critic charters

**Difficulty:** medium · **Priority:** 1 · **Depends on:** nothing

**Description:**
Create the specialist registry DESIGN.md §3.5 defines. Deliver `advisors/README.md`
documenting the charter file format — every charter states its lens, what it checks,
and the structured output it must return, matching the `advisories` item shape in
`schemas/status.schema.json` (advisor / verdict ok|concerns|error / summary /
details[]). Deliver the three planning-critic charters `advisors/ambiguity.md`,
`advisors/testability.md`, `advisors/scope.md`, each usable verbatim as a
fresh-context review prompt in a PLANNING.md step-2 session. The testability charter
encodes the shadow-01 lesson: it must direct the critic to hunt for self-nesting
tests (a test runner invoked from inside a test runner inherits environment such as
NODE_TEST_CONTEXT and fails as a nested subtest), environment inheritance generally,
and acceptance criteria a script cannot verify.

**Constraints:**
- Markdown only: no pipeline code, no schema changes, no edits to
  entrypoint/runner/verifier. *(Review-time constraint — enforced by PR review, not
  by a frozen test; the verifier's frozen-path diff covers the frozen surfaces.)*
- Each charter uses the exact h2 headings `## Lens`, `## Checks`, `## Output`, each
  on its own line.
- Each charter's `## Output` section contains **exactly one** fenced code block
  opened by a line matching `^```json$` and closed by the next line matching `^```$`;
  its content parses via JSON.parse to an object whose keys are a subset of
  {advisor, verdict, summary, details}, with advisor/summary strings, verdict one of
  ok|concerns|error, details (if present) an array of strings.
- Charters address the critic as a fresh-context reviewer with no session history.
  *(Review-time constraint, not machine-checked.)*

**Acceptance criteria ("Done means"):**
- A1. `advisors/README.md` exists and contains the literal strings `## Lens`,
  `## Checks`, `## Output`, `advisories`, `status.schema.json`, and the whole words
  `ok`, `concerns`, `error`.
- A2. `advisors/ambiguity.md`, `advisors/testability.md`, `advisors/scope.md` all
  exist and each contains lines matching `^## Lens\s*$`, `^## Checks\s*$`,
  `^## Output\s*$`.
- A3. `advisors/testability.md` contains the literal `NODE_TEST_CONTEXT`, matches
  case-insensitive `nested test` or `self-nest`, and matches case-insensitive
  `environment inherit`.
- A4. Each of the three charter files (README excluded) contains exactly one
  ```json fence as pinned in the constraints, and its JSON passes the shape checks
  above.

**design-ref:** DESIGN.md §3.5 (slot 1, registry format), §3.2 (the critic panel it staffs)

---

## Task B — Container-side memory contract: memoryNotes + status.js note + prompt injection

**Difficulty:** medium · **Priority:** 2 · **Depends on:** nothing

**Description:**
Implement the container-side half of DESIGN.md §3.6. (1) `schemas/status.schema.json`
gains an optional `memoryNotes` array of short strings — insights the coding or docs
agent wants to persist. (2) `pipeline/status.js` gains a `note <text>` subcommand
appending one entry. (3) The agent prompt assembled by `pipeline/entrypoint.sh` gains
two things: the content of `/workspace/.run/memory.md` when that file exists (the
project's exported memories — the file itself is produced by a separate host-side
task), and one instruction line telling the agent it can persist an insight by
running `node /pipeline/status.js note "<text>"`. (4) `schemas/examples/status.valid.json`
gains a `memoryNotes` example.

**Constraints:**
- `memoryNotes` is declared **inline** under `properties.memoryNotes` (no `$ref`,
  matching how `advisories` is declared) as
  `{type: "array", maxItems: 20, items: {type: "string", maxLength: 500}}`;
  top-level `additionalProperties: false` stays.
- `status.js note` appends only — never rewrites or reorders existing notes. It keeps
  the **first** 500 characters of the text (`slice(0, 500)` semantics — head, not the
  tail convention `append` uses for feedback). When 20 notes already exist, a further
  `note` call silently drops the note and exits 0 (memoryNotes never affects the
  outcome, so over-cap is not an error). With no status.json present it exits
  non-zero and creates no status.json.
- `schemas/examples/status.invalid.json` is left untouched.
- No runner changes (the host-side halves are Tasks C and D). Nothing about
  verification or exit codes changes. Zero new dependencies.

**Acceptance criteria ("Done means"):**
- B1. In the parsed schema: `properties.memoryNotes.type === "array"`,
  `maxItems === 20`, `items.type === "string"`, `items.maxLength === 500`, and
  top-level `additionalProperties === false`.
- B2. In a temp `RUN_DIR`: after `status.js init <id>`, `note "first"` then
  `note "second"` yields `memoryNotes` exactly `["first","second"]`; a note of 300
  `a`s + 300 `b`s is stored as 300 `a`s + 200 `b`s (length 500, head kept); after
  filling to 20 notes, a 21st `note` call exits 0 and the array length is still 20.
- B3. `status.js note "x"` with no status.json present exits non-zero and
  status.json does not exist afterwards.
- B4. `pipeline/entrypoint.sh` contains, on non-comment lines, both the literal
  `status.js note` and the literal `memory.md`.
- B5. `schemas/examples/status.valid.json` parses and its `memoryNotes` is an array
  with ≥1 entry, all strings of length ≤500.

**design-ref:** DESIGN.md §3.6 (the "Out" channel + the "In" channel's container-side
consumer), §4.11 (status file contract)

---

## Task C — Runner memory export: memory.md at workspace prep + PIPELINE_BD_CMD seam

**Difficulty:** medium · **Priority:** 2 · **Depends on:** nothing

**Description:**
Implement the "In" channel of DESIGN.md §3.6 on the host. New module
`runner/memory.js` exports `exportMemory(cfg, runDir)`: it reads the target project's
memories via the runner's bd layer (`bdJson(cfg, ['memories'])` — bd 1.1.0's
`bd memories --json` returns an object whose every key except `schema_version` is a
memory, key → text) and writes `<runDir>/memory.md`. `runner/workspace.js` calls it
during `prepare()` so the file lands beside `issue.md` in `.run/` before container
launch. Also introduce the test seam in `runner/bd.js`: when the env var
`PIPELINE_BD_CMD` is set, `bd()` spawns that executable **directly** with the bd
argument vector (`spawnSync(process.env.PIPELINE_BD_CMD, args)`), inheriting the
process environment — no `-C` prefix, no host-bd probe, no Docker fallback; the seam
takes absolute precedence and applies to every `bd()` call. Production never sets it.

**Constraints:**
- `memory.md` format: with N≥1 memories, first line is exactly `# Project memory`,
  followed by one line per memory of the form `- <key>: <text>`. With zero memories
  **or on any bd error**, the file's content is the single line
  `(no memories recorded)`.
- `exportMemory` never throws and **always writes memory.md**; it returns
  `{ok: true}` on success and `{ok: false, error: <non-empty string>}` on bd
  failure. A failed export is non-fatal to workspace prep: the caller logs the error
  and continues (the container runs without memories rather than the task failing).
- The file is written like `issue.md` — normal permissions; "read-only" is
  contractual (the `.run/` exports convention), not chmod-enforced.
- Memories are read through the bd layer against `cfg.targetRepoPath` (the canonical
  working copy), never the task clone.
- Host remains the sole Beads writer; no new container mounts or env vars. Zero npm
  dependencies.

**Acceptance criteria ("Done means"):**
- C1. With `PIPELINE_BD_CMD` pointing at a stub that prints
  `{"schema_version":1,"k1":"first memory","k2":"second memory"}`,
  `exportMemory(cfg, dir)` writes `dir/memory.md` whose first line is
  `# Project memory` and which contains both `k1: first memory` and
  `k2: second memory`, and returns `{ok: true}`.
- C2. With a stub printing `{"schema_version":1}`, memory.md's content is the single
  line `(no memories recorded)` and the return is `{ok: true}`.
- C3. With a stub that exits 1, `exportMemory` does not throw, still writes
  memory.md containing `(no memories recorded)`, and returns `ok: false` with a
  non-empty `error` string.
- C4. With `PIPELINE_BD_CMD` set, `bd(cfg, ['memories','--json'])` from
  `runner/bd.js` spawns the stub with an argument vector containing `memories` and
  `--json` and containing neither `-C` nor `docker` (stub appends its args to a log
  file named by env `BD_ARGS_LOG`); and `runner/workspace.js` contains the literal
  `exportMemory` (wiring).

**design-ref:** DESIGN.md §3.6 (the "In" channel), §4.10 (sole-writer, container inputs)

---

## Task D — Runner memory filing: memoryNotes → bd remember after container exit

**Difficulty:** medium · **Priority:** 3 · **Depends on:** Task C (the
`runner/memory.js` module and the `PIPELINE_BD_CMD` seam must exist). Not dependent
on Task B: `fileMemoryNotes` is tolerant of the field being absent, which is also its
production behavior until Task B lands. **Operational note: run D in a later batch
than C — both edit `runner/memory.js`, and task branches fork from the integration
branch, so C's PR must be merged before D's container starts.**

**Description:**
Implement the "Out" channel of DESIGN.md §3.6 on the host. `runner/memory.js` gains
`fileMemoryNotes(cfg, issueId, status)`: it reads `status.memoryNotes` and files each
note into project memory via the bd layer — for the n-th note (1-based):
`bd(cfg, ['remember', <text>, '--key', '<issueId>-note-<n>'])` (verified bd 1.1.0
signature; the issue id in the key is the §3.6 audit trail, and in-place key updates
make a re-run of the same issue overwrite rather than duplicate). `runner/run.js`
calls it exactly once per task, after the pause/relaunch loop, only when the task
outcome is done, partial, failed, or stuck — never for tampered (an agent that failed
the trust check does not seed project memory) and never for paused (not terminal).
`runner/queue.js`'s `attemptNotes` gains one line so the filing is visible at review:
when `status.memoryNotes` is non-empty, the attempt log includes
`memory notes: <count>`.

**Constraints:**
- The host re-enforces Task B's bounds on the agent-written file: at most the first
  20 notes are filed, each truncated to its first 500 characters; excess is dropped
  (and the drop logged by the caller).
- `fileMemoryNotes` never throws; returns `{filed: <successCount>,
  errors: [<strings>]}`. Missing or empty `memoryNotes` → `{filed: 0, errors: []}`
  with zero bd invocations. bd failures are non-fatal: recorded in `errors`, never
  changing the task outcome or aborting the run (docsPhaseError posture).
- Host remains the sole Beads writer; no container changes; zero npm dependencies.
- The outcome gate (done|partial|failed|stuck) lives in run.js at the call site.
  *(Gate placement is review-time; the wiring itself is machine-checked by D6.)*

**Acceptance criteria ("Done means"):**
- D1. With a stub bd (via `PIPELINE_BD_CMD`) logging its args: a status with
  `memoryNotes: ["a","b"]` and issue id `repo-abc` produces exactly 2 stub
  invocations; each invocation's args contain `remember` and `--key`; the two `--key`
  values contain `repo-abc-note-1` and `repo-abc-note-2` respectively; the return is
  `{filed: 2, errors: []}`.
- D2. With `memoryNotes` absent, and again with `memoryNotes: []`: zero stub
  invocations and `{filed: 0, errors: []}`.
- D3. With 22 notes of 600 chars each: exactly 20 invocations, and each filed text
  contains the 500-char head but not a 501-char run (truncation applied host-side).
- D4. With a stub that exits 1 and one note: no throw, `filed === 0`, `errors`
  non-empty.
- D5. `queue.attemptNotes(...)` output contains `memory notes: 2` when the status
  has two notes, and does not contain `memory notes:` when the field is absent.
- D6. `runner/run.js` contains the literal `fileMemoryNotes` (wiring).

**design-ref:** DESIGN.md §3.6 (the "Out" channel + audit trail + promotion rule's
review visibility), §4.10 (sole-writer rule), §4.11 (attempt log)
