# Advisor registry

Every specialist the pipeline can call lives here as one markdown file,
`advisors/<name>.md`, called a **charter**. A charter states a specialist's lens, what
it checks, and the structured output it must return. Charters are versioned with this
repo and reusable across every target project — DESIGN.md §3.5, "how specialists plug
in: data, not control flow."

The registry exists so the orchestrator can stay dumb. Nothing here is control flow: a
project's `pipeline.config.json` names the specialists it uses and an issue field names
the ones that apply to that task, so adding a specialist is adding a file plus a name in
a list — never a new phase, a new branch in the runner, or a new exit code.

## The rule that shapes every charter

> **Judgment happens at planning time; run time stays deterministic.**

No specialist is ever a gate (DESIGN.md §3.5). The frozen acceptance tests are the only
authority on pass/fail. A charter that asks its critic to "block" or "reject" anything is
a bug in the charter. Specialists occupy three slots, in descending order of leverage:

| Slot | When it runs | What its output is |
|---|---|---|
| 1. Planning critic | Planning session, step 2 (`PLANNING.md`) | A critique that revises the draft spec before freeze |
| 2. Test author | Planning session, step 3 | Acceptance tests in the specialist's domain — the strongest slot; prefer it whenever the domain admits it |
| 3. Run-time advisor | In a task container, after verify passes | An `advisories` entry in the status file: recorded evidence for the PR body and run report, never a gate |

Slot 1 and 2 charters are read by a human-driven planning session. Slot 3 charters are
read by a `claude -p` call inside the container. The file format is the same for all
three, so a lens can migrate between slots without being rewritten — and it should:
an advisor that keeps flagging the same thing is a signal to convert the check into a
deterministic test, which is judgment migrating leftward into frozen tests.

## Charter file format

A charter is a level-1 title, a short preamble addressed to the reviewer, then exactly
three level-2 sections, in this order, each heading alone on its own line:

| Heading | Contains |
|---|---|
| `## Lens` | The single question this specialist asks. One paragraph. If it takes two paragraphs, it is two specialists. |
| `## Checks` | The concrete things to look for, as a list. Each item is something a reviewer can actually go and look at, not a virtue to have in mind. |
| `## Output` | The response contract: one fenced `json` block showing the exact object to return, plus the rules for filling it in. |

Two further conventions:

- **Address a fresh-context reader.** Whoever runs the charter — a subagent, a fresh
  session, a container `claude -p` call — has no session history and did not watch the
  spec get written. State what it is given, what it is reviewing, and that it should
  report rather than fix. A charter that assumes shared context silently degrades into
  agreement with whatever it is shown.
- **The `advisor` value equals the filename stem.** `advisors/testability.md` returns
  `"advisor": "testability"`. The report and PR assembly key off that name.

## The output contract

Charter output is schema-checked like every other artifact, so PR assembly and the run
report never parse free-form prose. The object in a charter's `## Output` fence is one
item of the `advisories` array in `schemas/status.schema.json` — that schema is
authoritative, and this is its shape:

```json
{
  "advisor": "example",
  "verdict": "concerns",
  "summary": "One sentence a human reads in the run report.",
  "details": [
    "One finding per string: what is wrong, where, and why it matters."
  ]
}
```

- `advisor` — string, required. The registry name (the filename stem).
- `verdict` — required, exactly one of `ok`, `concerns`, `error`.
- `summary` — string, required. One sentence; it is what lands in the run report.
- `details` — optional array of strings. Omit it, or give it an empty array, when the
  verdict is `ok`.

Verdicts mean the same thing in every charter:

- `ok` — reviewed through this lens, nothing found worth acting on.
- `concerns` — findings that deserve a decision. Advisory only: `concerns` never fails a
  task and never blocks a plan. At planning time a human decides what to do about it; at
  run time it is recorded evidence and cannot change the exit code.
- `error` — the review could not be performed: the input was missing, unreadable, or
  outside this lens entirely. Say why in `summary`. An `error` is not a finding about
  the work; it is a finding about the review.

Return the JSON object and nothing else — no prose before it, no fence around it in the
reply, no trailing commentary. Emit exactly one object; a charter never returns an array.

## Adding a charter

1. Copy the shape of an existing charter — `ambiguity.md` is the shortest.
2. Give it one lens. If the `## Checks` list splits into two unrelated halves, it is two
   charters.
3. Ask which slot it really wants. If the check can be made deterministic — a tolerance,
   a ratio, a dimensional analysis, a grep — write a test instead (slot 2). A test steers
   the retry loop; a review does not.
4. Keep the `## Output` fence parseable and its keys a subset of the four above.
5. Add it to the table below and, for a run-time advisor, to the target project's
   `pipeline.config.json`.

## Current registry

| Charter | Slot | Lens |
|---|---|---|
| [`ambiguity.md`](ambiguity.md) | Planning critic | Where would two competent engineers build different things from this spec? |
| [`testability.md`](testability.md) | Planning critic | Which acceptance criteria can a script not actually verify? |
| [`scope.md`](scope.md) | Planning critic | Is this secretly several tasks? |

These three staff the full critic panel that `PLANNING.md` step 2 runs against a spec
labelled **hard** (DESIGN.md §3.2). A **medium** spec gets one light pass — in practice
`testability.md`, since untestable criteria are the failure that survives review most
often. A **trivial** spec gets none. No run-time advisors are registered yet; V1 builds
none, and the shadow trial is the experiment that reveals which are actually wanted.
