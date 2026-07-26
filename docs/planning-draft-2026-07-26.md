# Planning draft — 2026-07-26 (changeSummary noise defect)

> **Approved and frozen 2026-07-26.** Canonical spec now lives in Beads issue
> `repo-52m`; frozen tests at `tests/acceptance/repo-52m/`. Superseded planning
> snapshot.

One task. Root cause, established from run artifacts: the Claude CLI prints a
warning line ("Ignoring 18 permissions.allow entries … workspace has not been
trusted") ahead of its output. The docs phase merges stderr into `docs-out.txt`
(`2>&1`) and takes a raw `tail -c 2000` as `changeSummary`, so the warning leads
every PR body. Worse: the same leading line makes the code phase's whole-file
`JSON.parse` fail silently, so the **resolved model has never been recorded** in any
run's status file — the v1.2 reproducibility feature has been broken since the first
dogfood run.

---

## Task — Clean contract artifacts from agent CLI noise

**Difficulty:** medium (proposed) · **Priority:** 1 · **Depends on:** nothing

**Description:**
Make the entrypoint's contract artifacts (changeSummary, resolved model, flattened
agent log) robust to CLI noise, and remove this noise class at its source.

1. New `pipeline/envelope.js`: a deterministic parser for the Claude CLI JSON
   envelope. Library: `parse(text)` scans the file's lines **bottom-up** and returns,
   from the first line that `JSON.parse`s to an object with a string `result` field:
   `{result, model}` — `model` being the first key of `modelUsage` when present,
   else null. Returns `null` when no such line exists. CLI: `node envelope.js
   flatten <file>` rewrites the file to exactly the `result` text and prints the
   model (if any) to stdout; when the file has no envelope it leaves the file
   untouched and prints nothing; exit 0 in both cases.
2. `pipeline/status.js` gains `summary <file>`: sets `changeSummary` from the file —
   the envelope `result` when `envelope.parse` finds one, otherwise the raw file
   content; either way trimmed, keeping the **last** 2000 characters (the current
   `tail -c 2000` cap). An empty extraction exits 0 without setting anything.
   Missing status.json exits non-zero (same as `note`).
3. `pipeline/entrypoint.sh` docs phase: stderr goes to `.run/docs-err.txt` instead of
   merging into `docs-out.txt` (kept for debugging, never part of the summary); the
   summary is set via `status.js summary`.
4. `pipeline/entrypoint.sh` code phase: the inline JSON-flatten snippet is replaced
   by `envelope.js flatten`, so the resolved model is recorded even with leading
   noise. The code-phase log **stays merged** (`2>&1`) — the rate-limit grep reads
   it and error text may arrive on either stream.
5. `pipeline/entrypoint.sh`, before the first agent call: seed the container-local
   Claude config so the workspace is trusted — merge
   `projects["$WS"].hasTrustDialogAccepted: true` (and
   `hasCompletedOnboarding: true`) into `$HOME/.claude.json` with a node one-liner,
   preserving any existing content, `|| true` (non-fatal). This removes the warning
   at source; deliverables 1–4 keep the artifacts correct for whatever the CLI
   prints next.

**Constraints:**
- No LLM anywhere in this path — extraction is deterministic scaffolding (hard rule 7).
- Envelope detection is exactly the bottom-up first-JSON-object-line-with-string-result
  rule; no regex heuristics over prose, no filtering of "known warning" strings.
- `status.js` remains the sole status writer; `summary` sets `changeSummary` only,
  and existing subcommands (`init`, `attempts`, `append`, `set`, `note`) keep their
  behavior.
- Stub compatibility: a plain-text `docs-out.txt` (what `pipeline/stubs/*` produce)
  still becomes the summary via the raw-text path.
- The trust seeding never prints, logs, or reads the token; node only (no jq); it
  must not clobber other keys in an existing `$HOME/.claude.json`.
- *Review-time constraint (not machine-checked):* when the entrypoint owns the
  invocation (no `PIPELINE_AGENT_CMD`), the docs phase also requests
  `--output-format json` so the summary is exactly the agent's result string —
  the extraction handles both forms either way.
- No runner, verifier, or schema changes; zero new dependencies. `.run/docs-err.txt`
  is never committed (`.run/` is already excluded).

**Acceptance criteria ("Done means"):**
- E1. `envelope.parse`: a file of `<warning line>\n<envelope line>` where the
  envelope is `{"result":"the summary","modelUsage":{"claude-opus-5":{}}}` returns
  `{result: "the summary", model: "claude-opus-5"}`; the envelope line alone returns
  the same; a file with no JSON line returns null; a JSON line whose `result` is not
  a string returns null.
- E2. `node pipeline/envelope.js flatten <file>` on warning+envelope rewrites the
  file to exactly `the summary`, prints `claude-opus-5` to stdout, exits 0; on a
  plain-text file it exits 0, prints nothing, and the file is byte-identical.
- E3. `status.js summary <file>` (every spawned `status.js` in the tests sets
  `RUN_DIR` explicitly to a temp dir — never inherited, so a live run's status file
  can never be touched) after `init`: envelope file → `changeSummary === "the
  summary"`; plain-text file → changeSummary equals the trimmed text; a 3000-char
  text file → the last 2000 characters; an empty file → exit 0 and no
  `changeSummary` key; no status.json → exit non-zero.
- E4. **Behavioral:** running `pipeline/entrypoint.sh` end to end with temp
  `WORKSPACE` (a fresh git repo), temp `HOME` whose `.claude.json` pre-contains
  `{"existingKey": true}`, a dummy `CLAUDE_CODE_OAUTH_TOKEN`, `PIPELINE_AGENT_CMD`
  pointing at a stub that prints a warning line then the JSON envelope on stdout
  and a marker line on stderr, and `PIPELINE_DIR` pointing at a temp copy of the
  real `status.js` + `envelope.js` beside a **stub `verify.js` that exits 0**
  (never the real verifier — it would re-invoke the acceptance runner and
  self-nest), asserts: exit 0; `changeSummary` in the workspace status.json equals
  exactly the envelope's `result` (no warning text); `.run/docs-err.txt` exists and
  contains the stub's stderr marker while `docs-out.txt` does not; `$HOME/.claude.json`
  still has `existingKey: true`, has the workspace marked `hasTrustDialogAccepted:
  true`, and nowhere contains the dummy token string.
- E5. Source-line assertions on `pipeline/entrypoint.sh`: the line invoking the
  docs-phase agent (the non-comment line containing `docs-out.txt` and `sh -c`)
  does **not** contain `2>&1`; the line invoking the code-phase agent (containing
  `agent-$N.log` and `sh -c`) still **does** (the rate-limit grep reads a merged
  log).
- E6. After `summary` sets changeSummary (explicit temp `RUN_DIR`), `status.js
  note "x"` still appends to `memoryNotes` and the changeSummary is unchanged
  (fields coexist; no regression in the writer).

**design-ref:** DESIGN.md §4.3 (agent invocations, model pinning, docs phase),
§4.11 (changeSummary / model in the status contract), §4.5 (PR body assembly)
