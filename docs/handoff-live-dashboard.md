# Handoff — the live run dashboard

A point-in-time handoff for whoever picks this feature up (2026-08-10, end of the
planning session). Everything normative lives in the files this points at; this doc is
only the thread. Disposable once the feature ships — delete it when the page session
below is done.

## Where this stands

**Both pipeline tasks have shipped and merged (2026-08-11).** Only the page session is
left.

| Issue | What | PR | State |
|---|---|---|---|
| `repo-bmd` | `status.json` gains a `phase` field (`code`/`verify`/`docs`), written by the entrypoint at each phase boundary | #31 → `56c514f` | merged, verdict recorded |
| `repo-kfg` | `scripts/dashboard.js` — a localhost-only pure reader serving the frozen `/state` JSON contract | #32 → `3bf7ed0` | merged, verdict recorded |

Both passed on the first attempt in run `2026-08-11T00-34-10-042Z`, from fork point
`4fa7bbc`. The design decision is `DESIGN.md` §5, change-log row `live-dashboard`; the
shipping rows are `repo-bmd` and `repo-kfg`. `docs/planning-draft-2026-08-10.md` still
carries every critic finding and its disposition.

Review beyond the frozen gates confirmed the reader's key names against the real
writers (`runner/report.js`, `schemas/status.schema.json`) — no phantom-field defect —
and smoke-tested `buildState` against the live 231-run corpus, where it correctly
resolved the in-flight run through the held lock rather than directory recency.

**The visible page is deliberately NOT a pipeline task.** Its look is unfrozen and is
reviewed by looking at it, so it is an interactive session with the user — see "The
page session" below.

## Blocking the page session — read this first

**The `/state` contract's `attempt` is off by one for a live task, and it is a spec
defect, not a code defect.** `attempt` is `status.attempts.length`, and the frozen test
pins that; but `attempts` only gains an entry once the verifier has *judged* one, so a
task actively working its first attempt reports `attempt: 0`. Confirmed against a real
running container, not inferred. Since the page renders "attempt n/3", fix this
**before** building the page: it needs a re-freeze of `repo-kfg`'s contract (a spec
change is legal at planning time and nowhere else), not a patch to shipped code. Parked
in `docs/IDEAS.md` at the top of the Inbox, 2026-08-11, with the proposed shape.

Second thing the page must answer: the reader returns **33 projects, 28 of them named
`target`** — old e2e fixture leftovers among 231 run directories. Fixtures appearing is
correct behaviour (see below), but 28 identical rows burying five real projects is a
view problem to design around, or a reason to prune `runs/`.

## Next steps, in order

1. **The page session** (interactive, with the user): replace the placeholder page
   `GET /` serves with the real view, iterating on look with the user directly. The
   brief is the "What the live view shows" section of the planning draft; the frozen
   `/state` contract is the data interface (already gated by `repo-kfg`'s suite — do
   not add fields without re-opening that spec); the session mock the user approved
   is a claude.ai artifact titled "Live run dashboard — mock" (ask the user to share
   it, or rebuild from the draft's brief: house palette from `docs/pipeline-map.html`
   — teal flow, amber "task is here" lamps, indigo human-side). The HTML stays an
   inline template string in `scripts/dashboard.js` so the self-containment checks
   keep holding. The third animated diagram (issue states) lives here too.

2. **Hand-update `docs/pipeline-map.html`** — the host obligation both shipped tasks
   recorded, and the one file CLAUDE.md exempts from task docs phases, so nothing else
   will do it. Its end-to-end panels draw the run and the post-hoc audit; none of them
   yet shows the live reader hanging off the run in flight, or the `phase` boundary.
   `docs/pipeline-diagram.md`, which docs phases *do* keep current, already has both.

## Decisions already made — do not re-litigate silently

- **The dashboard is a pure reader, forever.** No `bd`, no Docker, no writes, no LLM,
  `127.0.0.1` only, never a gate. If a change needs more, that is a DESIGN.md
  amendment, not an implementation choice.
- **The page's look is unfrozen; the `/state` key set is frozen** (whitelist-compared
  by the acceptance tests). Adding a field = spec change = re-approve + re-freeze.
- **Live workspaces are found via the runner's existing `workspace ready:` log line.**
  That line's wording is now a contract two suites grep — never reword runner log
  lines in passing.
- **`phase` is additive**: never in the schema's `required`, vocabulary exactly
  `code|verify|docs`, writes non-fatal. Old status files must stay valid forever.
- The e2e suite's fixture targets will appear in the dashboard's project list. That
  is correct behaviour, not a bug to special-case.

## Session gotchas worth inheriting

- The frozen acceptance tests run *inside* task containers: they spawn the entrypoint
  with a fully replaced environment precisely because the inherited one points at the
  live run's own workspace. Preserve that if you touch them (you may not — they are
  frozen; a wrong test is a spec-change conversation with the user).
- `DESIGN.md` §12 both-append conflicts are the expected shape when rebasing; keep
  both rows, chronological ascending, run `bash scripts/test-changelog.sh` after.
- Run `bash scripts/test-sanitize.sh` before pushing anything — this repo is public
  and is used on private work; fixtures use `example.invalid` hosts and invented ids
  only.
- If a task agent files a spec concern against either issue, that is a first-class
  result to surface to the user (§3.3), not a thing to fix mid-run.

## Pointers

| What | Where |
|---|---|
| Design decision + rationale | `DESIGN.md` §5, change-log row `live-dashboard` |
| Full specs + critic dispositions | `docs/planning-draft-2026-08-10.md` |
| Canonical specs (post-freeze) | the Beads issues `repo-bmd`, `repo-kfg` (`bd show <id>`) |
| Frozen tests | `tests/acceptance/repo-bmd/`, `tests/acceptance/repo-kfg/` |
| Page brief | draft, "What the live view shows, per project" |
| Idea's history | `docs/IDEAS.md` Promoted table, 2026-08-10 row |
