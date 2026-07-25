# How the pipeline works — diagrams

Visual companion to `DESIGN.md`. The doc is authoritative; these are views of it.

## End to end

Planning is interactive, implementation is autonomous, review is interactive. The
Beads queue is the join between them.

```mermaid
flowchart TB
  A["Design doc — DESIGN.md"] --> B["Decompose into task-sized specs"]
  B --> C["Critics, sized to difficulty<br/>none · light · full panel"]
  C --> D["Write acceptance tests<br/>before any code exists"]
  D --> E["Coverage check<br/>every criterion has a test"]
  E --> F{"You approve intent"}
  F -->|"needs changes"| B
  F -->|"approved"| G["Freeze — tests committed<br/>to the integration branch"]
  G --> H[("Beads issue = the task spec")]
  H --> I["Runner drains the ready queue<br/>priority, then FIFO"]
  I --> J["One fresh container per task"]
  J --> K["Run report + pull requests<br/>ordered by scrutiny needed"]
  K --> L{"Merge, or send back"}
  L -->|"send back as a new task"| B
```

## Inside one task container

The sequence is scaffolding, not an LLM decision. The verifier is the only authority;
the agent never judges its own work.

```mermaid
flowchart TB
  S(["Container starts — fresh clone on a task branch"]) --> C1["Code phase<br/>headless agent, task spec on stdin"]
  C1 -->|"usage limit"| RL["exit 20 — pause, resume later<br/>no attempt consumed"]
  C1 --> V{"Verifier<br/>tamper diff, then frozen tests"}
  V -->|"frozen paths changed"| TA["exit 11 — tampered"]
  V -->|"fail, attempts &lt; 3"| FB["Commit the attempt<br/>feed failure output forward"]
  FB --> C1
  V -->|"fail on the 3rd attempt"| ST["Commit WIP + stuck state<br/>exit 10 — stuck"]
  V -->|"pass"| DP["Docs phase<br/>writes the change summary"]
  DP --> OK["exit 0 — verified"]
```

## Where the walls are

The container holds exactly one credential and cannot reach a git host. Everything
durable — the queue, the credentials, the push — lives on the host.

```mermaid
flowchart LR
  subgraph HOST["Host — holds every credential"]
    R["Runner<br/>timers, budgets, kill switch"]
    GH["git push + gh pr create"]
    BD[("Beads queue")]
  end
  subgraph NET["pipeline-net — internal, no route out"]
    T["Task container<br/>agent + verifier"]
    PX["Allowlist proxy"]
  end
  R -->|"fresh clone + issue.md"| T
  T -->|"all egress"| PX
  PX -->|"allowed"| AN(("api · console · statsig<br/>.anthropic.com"))
  PX -.->|"refused"| BL["github.com · npm · pypi<br/>everything else"]
  T -->|"commits land on host disk"| R
  R --> GH
  R --> BD
```

## What each outcome does

| Outcome | Exit | Report status | Beads | Branch pushed | PR |
|---|---|---|---|---|---|
| Acceptance pass, regressions pass or absent | 0 | done | closed | yes | yes |
| Acceptance pass, regressions fail | 0 | partial | closed | yes | yes, flagged |
| Bailed after 3 attempts | 10 | stuck | blocked | yes, WIP | no |
| Frozen tests modified | 11 | tampered | blocked | yes, WIP | no |
| Usage limit hit | 20 | paused | stays in progress | not yet | not yet |
| Internal error | 30 | failed | blocked | if commits exist | no |
| Wall-clock kill | — | failed | blocked | if commits exist | no |

`blocked` is what takes failed work out of the ready queue: it needs a human decision
in review, so the loop can never re-pick it.
