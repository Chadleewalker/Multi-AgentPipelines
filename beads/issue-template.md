# Beads Issue Template — the finalized five-field mapping (T2)

DESIGN.md §3.1 requires every task issue to carry five spec fields and delegates the
exact Beads mapping to this task, under one rule: **all five fields must round-trip
through a `bd` dump** (`bd show <id> --json`) so scripts can check them. This file is the
record of that mapping, finalized against `bd` 1.1.0 — which turned out to have native
fields for almost everything:

| Spec field (DESIGN.md §3.1) | Beads home | Set with | Appears in `bd show --json` as |
|---|---|---|---|
| Description | native description, `## Description` markdown section | `bd create -d` / `--body-file` | `description` |
| Constraints | `## Constraints` markdown section in the same description | (composed by `new-issue.sh`) | `description` |
| Acceptance criteria | native field | `bd create --acceptance` | `acceptance_criteria` |
| `design-ref` | native design field, as `design-ref: <section>` | `bd create --design` | `design` |
| Attempt log | native notes, append-only | `bd note <id> "<entry>"` | `notes` |

Native fields also used: `status` (`open / in_progress / blocked / deferred / closed` —
matches the §4.11 table; `blocked` is what removes failed work from the ready queue),
`priority` (`-p 0–4`, 0 highest — the §4.12 ordering key), and dependencies
(`--deps <id>` / `bd link` — `bd ready` is blocker-aware and excludes issues whose
dependencies aren't closed, verified by `scripts/test-beads-roundtrip.sh`).

## Description skeleton

```markdown
## Description
<what this task delivers, plain English>

## Constraints
- <anything the implementation must not do / must respect>
```

## Creating an issue

Always create task issues through the wrapper, which composes the skeleton and refuses
to create an issue without a `design-ref` (§3.1 makes it mandatory):

```
scripts/new-issue.sh -t "<title>" -d "<description>" -a "<acceptance>" -r "<design-ref>" \
                     [-c "<constraints>"] [-p 0-4] [-D dep-id,dep-id] [-C <repo-dir>]
```

Prints the new issue id. Uses host `bd` when installed, otherwise falls back to running
`bd` in the `pipeline-base:local` image against the target repo.
