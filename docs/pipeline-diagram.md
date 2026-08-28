# How the pipeline works — diagrams

Visual companion to `DESIGN.md`. The doc is authoritative; these are views of it.

**Dashed amber nodes are the domain-specialist slots from §3.5.** Two of them work today
with no code (they are planning-session moves); the third needs a build. Nothing dashed
is a gate — a specialist can never fail a task.

## End to end

Planning is interactive, implementation is autonomous, review is interactive. The
Beads queue is the join between them.

```mermaid
flowchart TB
  A["Design doc — DESIGN.md"] --> B["Decompose into task-sized specs"]
  B --> C["Critics, sized to difficulty<br/>light · full panel"]
  SP1["SLOT 1 — domain critic<br/>physics · aesthetic · security<br/>attacks the spec, finds the holes"] -.-> C
  C --> D["Write acceptance tests<br/>before any code exists"]
  SP2["SLOT 2 — domain test author<br/>writes the domain's own checks<br/>energy conserved · contrast ratio"] -.-> D
  D --> E["Coverage check<br/>every criterion has a test"]
  E --> FG["Freeze gate — the tests must FAIL at the fork point and PASS in a probe<br/>red 0 · green 1 · indeterminate 2 · unreachable 3 · half-proven 4 · deterministic, never an LLM"]
  FG -.-> BL["Brittleness lint — the same run reads the suite's TEXT<br/>literal-name-list · literal-count · literal-digest · branch-self-diff<br/>count printed even at zero · skips named · never the exit code"]
  BL -.-> F
  FG --> F{"You approve intent"}
  F -->|"needs changes"| B
  F -->|"approved"| G["Freeze — tests committed<br/>to the integration branch"]
  G --> H[("Beads issue = the task spec")]
  G -.-> BM["Batch marker, written at freeze — runs/batches/&lt;project&gt;-&lt;date&gt;.json<br/>read back with node scripts/batch.js show · pending · never a queue item"]
  H --> I["Runner drains the ready queue<br/>epics skipped · unfrozen refused · priority, then FIFO"]
  I -.-> UD["Refused before claim — no suite on the fork branch<br/>one git fetch of targetRepoRemote per run · ls-tree -d per candidate<br/>run.json row, outcome undispatchable · Beads untouched, issue stays open"]
  UD -.-> G
  I -->|"a worker is free and the queue is empty"| FEED["Live queue feed — re-read the ready queue<br/>OFF unless feedIdleGraceMinutes &gt; 0 · a failed re-poll is never fatal<br/>ends: drained · idle · stopped (runs/&lt;runId&gt;/stop) · halted"]
  FEED -->|"new work, or a refusal that has cleared"| I
  G -.->|"frozen mid-run, suite pushed"| FEED
  I --> J["One fresh container per task<br/>1 at a time by default · N with the concurrency knob"]
  J --> K["Run report + pull requests<br/>ordered by scrutiny needed"]
  K --> L{"Merge, or send back"}
  L -->|"send back as a new task"| B
  L -->|"either way, one line per PR"| VD["Record the verdict — merged or rejected, and why<br/>runs/&lt;runId&gt;/tasks/&lt;id&gt;/verdict.json · evidence, never a gate"]
  K -.-> AUD["Across ALL past runs — node scripts/audit-runs.js<br/>joins the corpus, prints one report, changes nothing"]
  AUD -.-> B
  J -.-> DASH["While THIS run is in flight — node scripts/dashboard.js<br/>localhost only · serves /state from runs/ · changes nothing"]
  J -.-> LED["Every run.log line, structured — runs/&lt;runId&gt;/events.jsonl<br/>one writer, one timestamp · named typed events · schemas/events.schema.json<br/>host-only · append-only · no reader reads it yet"]

  classDef specialist fill:#fdf4e3,stroke:#a86c17,stroke-width:1.5px,stroke-dasharray:5 3,color:#14181d
  class SP1,SP2 specialist
```

The dotted branch off the run report is the only reader that spans runs (§5, change-log
row `repo-73k`). It is post-hoc and host-only: nothing in a run waits on it, it gates
nothing, and what it finds reaches the pipeline the same way any other observation does —
through a human, into a planning session.

The dotted branch off the run itself is its live sibling (§5, change-log row `repo-kfg`):
`node scripts/dashboard.js` reads the same `runs/` tree while a run is still in flight and
serves it as `/state` on loopback. Both arrows are dotted for the same reason and no arrow
leaves either node — a watcher that could reach a run would be a route around hard rule 1,
and one that could gate would violate hard rule 5. The dashboard's own page is not built
yet; the frozen JSON contract it serves is.

The third dotted branch off the run is `events.jsonl` (§4.12, change-log rows
`events-ledger-design` and `repo-qzy`). It is drawn as a *sibling* of the two readers rather
than as something either of them consumes, because no arrow reaches it yet: `runner/log.js`
writes one JSON object per `run.log` line — from the same call and the same clock read, so the
two cannot disagree — and every existing reader still parses the prose. That is deliberate.
The lines those readers match by prefix are now also named events with typed fields, so each
reader can move across on its own, in its own task, keeping its own suite green; a flag day
would have put three readers and the writer in one change nobody could review. The container
side of the diagram is untouched: nothing in a task container writes an event, and nothing
in `pipeline/` knows the file exists.

The dotted branch off the freeze gate is its second, textual pass (§3.2 "below the panel",
moves 1 and 6; change-log rows `freeze-gate-red` and `repo-uw6`). The solid path is the
verdict — `red` 0, `green` 1, `indeterminate` 2, `unreachable` 3, `half-proven` 4 — and it is
the only thing that reaches the exit code. The last two arrive with `--green <probe-dir>`
(change-log row `repo-inj`): the same suite is run a second time in a throwaway tree where the
criteria are already satisfied, because a suite that discriminates and a suite whose own
fixture is broken are the same observation from the fork point alone. `unreachable` is red
there too and is never a pass; `half-proven` is red with no probe supplied, which is legal and
proceeds, carried into the approval pass beside the guard count. A **broken** probe is
`indeterminate`, never `unreachable` — exit 3 is reachable only behind a green probe control.
The lint hangs off it dotted because it decides nothing: a red test can still be the wrong
test, so the same run names the assertions whose *expected side is a literal the author
typed*, and each finding takes a disposition in the planning draft the way a critic's does.
It arrives at the approval pass as evidence, never as a gate — findings cannot fail a
freeze, and a clean pass cannot rescue a green verdict.

The dotted branch off the freeze is the handoff between the two halves of the process (§3.9,
change-log rows `batch-ready-marker`, `repo-0b3` and `repo-8v0`). A planning session's last act
writes the marker; a later, different session reads it back — `node scripts/batch.js show` to
confirm what it is about to launch, `pending` to see a batch frozen days ago and never run.
**No arrow leaves it**: nothing in `runner/` or `pipeline/` reads `runs/batches/`, a missing
marker does not stop a launch and a disagreeing one does not refuse it. The marker is what was
*intended*; the Beads queue on the solid path is what actually runs — and `show` now reads
that queue too, through the run config the marker names, reporting each id `ready` or
`not-ready` and each entry the batch never named a `stray` (or `unreconciled` with one reason,
where a link of that join cannot be made). It reads the queue the runner will drain; it never
changes it.

Slots 1 and 2 need **no pipeline code**: they are prompts you run during a planning
session, before anything is frozen. Slot 2 is the higher-leverage of the two — a domain
check that becomes a frozen test steers the retry loop on every attempt, whereas a
review only complains once.

The verdict node is `node scripts/verdict.js record <issue-id> <merged|rejected> "<why>"`
(§5, change-log row `repo-1ie`) — deterministic scaffolding that writes down the one
signal the pipeline cannot generate about itself. It hangs off the decision rather than
sitting in the path back to planning, because it records *either* outcome and gates
neither: no arrow leaves it.

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
  V -->|"pass"| ADV["SLOT 3 — declared advisors<br/>inspect the finished change<br/>notes only, cannot fail the task"]
  ADV --> DP["Docs phase<br/>writes the change summary"]
  DP --> OK["exit 0 — verified"]

  classDef specialist fill:#fdf4e3,stroke:#a86c17,stroke-width:1.5px,stroke-dasharray:5 3,color:#14181d
  class ADV specialist
```

**Each of the three boundaries above also writes itself down.** On *entry* to the code,
verify and docs phases the entrypoint sets `status.json`'s `phase` — `code` / `verify` /
`docs`, the only values there are — through `pipeline/status.js`, which stays the sole
writer of that file (change-log row `repo-bmd`). It is the live feed §5's dashboard reads
to tell a task that is working from one that is being judged; the write is non-fatal and
nothing in the diagram branches on it, so the arrows are unchanged by it.

Slot 3 is the one that needs building, and the sockets are already in place: the
`advisories` array exists in `status.schema.json` (typed, and documented as evidence
that can never change the exit code), advisor definitions would ride in the existing
read-only `/pipeline` mount, and `pipeline.config.json` already is the per-project
selection file. What is missing is the loop itself plus rendering in the report and PR.

**Why it sits after the verifier, not before:** an LLM judge cannot be frozen, so making
one a gate would void the three-attempt cap and produce unactionable 2 AM failures. By
the time an advisor runs, the task has already passed or failed on deterministic
grounds; the advisor only annotates.

## How a task moves through the queue

Nothing is ever deleted. A task is claimed, then closed or blocked, and every run
appends to its notes — so a stuck task arrives in review carrying its own history.

**The host is the only writer.** The container has no queue access at all: it reports
outcomes purely through its exit code and `status.json`. If the container wrote to the
queue, those writes would land on a task branch that might never merge, and the work
queue would fork along with the code.

```mermaid
flowchart LR
  subgraph HOST["Host — the only writer"]
    G{"0 · Admit<br/>run-level pause gate"}
    A["1 · Claim<br/>status → in progress"]
    C["2 · Collect<br/>exit code + status.json"]
    D["3 · Finish<br/>append notes,<br/>then close or block"]
    R["Refused — never launched<br/>paused row, issue untouched"]
    Q[("Task list")]
  end
  subgraph CONT["Container — no queue access"]
    B["code · verify · docs"]
  end
  G -->|"window open"| A
  G -->|"run-level cap fired"| R
  A --> B
  B --> C
  C -->|"exit 20 — park the run"| G
  G -->|"window reopened — relaunch"| B
  C --> D
  A -.->|"write"| Q
  D -.->|"write"| Q
```

Step 0 is the **run-level rate-limit park** (§4.7, §7 — change-log row `repo-i9y`): one
gate for the whole run, built once and shared by every task in flight. The first exit 20
opens one shared wait on that task's reported reset time; later reporters join it and never
extend it. Park means **admit no new work**, never kill what is running — a live container
whose window is genuinely closed exits 20 by itself and joins the same wait. It sits
*before* the claim on purpose: when the run-level cycle cap has fired, the task never
launches and the queue is never touched, so its issue stays `open` for the next run rather
than stranded `in_progress`. It still gets a `paused` row in the manifest, because a task
missing from `run.json` after an unattended overnight run is a hole in the record.

The claim in step 1 is what stops a task being picked twice, and it is why a crashed run
leaves issues stranded `in progress` — the next run's preflight sweeps those back to
`open`. The claim only holds while there is one writer, so preflight's **first** gate is a
lock on the target repo: a second run against the same project is refused by name before
it can read the queue, and a lock whose owning process is gone is taken over (change-log
row `repo-os9`).

The same drawing holds at `concurrency` > 1: **one** runner process holds up to N task
containers of its project at once (default 1, ceiling 3 — change-log row `repo-teq`), and the
host box is still the single writer. Never N runner processes against one queue — the claim
in step 1 and the lock above it both assume one. Tasks in flight together share this diagram;
the runner hands their results back in ready-queue order, so the manifest reads the same at
any depth.

Every arrow into the task list is a bounded, synchronous `bd` call — `bdTimeoutMs` in the
run config, default 60s, applied by `runner/bd.js` to every spawn it makes (change-log row
`repo-sls`). Step 3 is the reason: it runs *after* the container exits, so a `bd` that hangs
there would leave finished work claimed and its outcome unwritten, with no timer anywhere to
end the wait. A call that exceeds the bound is killed and reported as an ordinary failure,
which the steps above already know how to handle.

```mermaid
stateDiagram-v2
  [*] --> open: planning creates the task
  open --> in_progress: runner claims it
  in_progress --> closed: done or partial
  in_progress --> blocked: stuck · tampered · failed
  in_progress --> in_progress: rate limit — parked, then resumed
  open --> open: refused — the run-level pause cap had already fired
  open --> open: not dispatched — no frozen suite on the fork branch
  blocked --> open: you fix the spec and unblock it
  closed --> [*]
```

`blocked` is doing quiet but critical work: it removes failed work from the ready queue.
Without it a task that cannot pass would be picked up again on every run, forever.

Both `open → open` self-loops are populations that never enter the diagram's `in_progress`
half, because both gates are consulted **before the claim**. The first is the run-level
park's refusal: the pause cap had already fired, so nothing launched. The second is the
ready queue's dispatchability gate (§4.12, change-log row `dispatch-gate`) — the issue's
frozen acceptance suite is not on the branch its container would fork from, so the verifier
could only ever have exited 1 three times over. Neither is blocked and neither is failed;
one is waiting for a usage window and the other for a freeze session, and both are picked
up untouched by the next run.

An **epic** never enters this diagram at all. `bd ready` returns it alongside its children
and never closes it when they close, so the runner filters ready entries typed `epic` out
before the loop and names them in its queue-summary line — skipped, but never silently
(§3.1, §4.12).

The type filter is no longer the only thing that keeps a ready entry out of the loop. The
**dispatchability gate** is the second admission rule, and it asks a question Beads cannot
answer, because Beads tracks issues and not freezes: *is this task's frozen acceptance suite
on the branch its container will fork from?* Once per run, `git fetch <targetRepoRemote>
<branch>` into a throwaway repository under the OS temp dir; then, per candidate,
`git ls-tree -d --name-only FETCH_HEAD -- tests/acceptance/<issue-id>`. Empty output, not
dispatchable. The gate goes to the **remote by URL and reads `FETCH_HEAD`** — never
`origin/…`, never the working tree, never a local branch — because freezing locally is not
freezing, and because `targetRepoPath` and `targetRepoRemote` are independent config keys
nothing relates. It is **lazy** (a queue with no candidates neither fetches nor aborts), it
is **per issue** (three frozen tasks and one unfrozen one runs the three), and a fetch that
fails, hangs past `gitTimeoutMs`, or resolves no branch **aborts the run in its own channel**
rather than dispatching blind. Like the type skip, refusals are named in the queue-summary
line — with the remedy, because until this shipped they appeared in the report as
three-attempt failures indexed under the agent's name rather than under the missing freeze.

## Where the walls are

The container holds exactly one credential and cannot reach a git host. Everything
durable — the queue, the credentials, the push — lives on the host.

Arrow styles carry meaning: a solid arrow is an allowed path, **an ✕ arrowhead is a
refusal**, and a dotted arrow is a permitted but read-only path. (These were previously
both dotted, which made a wall look like a doorway.)

```mermaid
flowchart LR
  subgraph HOST["Your PC"]
    direction TB
    R["Runner — timers, budgets, kill switch"]
    GH["git push + gh pr create"]
    BD[("Task list")]
  end
  subgraph NET["Sandbox — no route out"]
    direction TB
    T["Task container — agent + verifier"]
    PX["Allowlist proxy"]
    REG["SLOT 3 registry, read-only"]
  end
  R -->|"fresh clone + issue.md + memory.md"| T
  T -->|"commits land on your disk"| R
  T -->|"every request"| PX
  PX -->|"allowed"| AN["The three anthropic.com endpoints"]
  PX --x BL["Refused — github.com, npm, everything else"]
  REG -.-> T
  R --> GH
  R --> BD

  classDef specialist fill:#fdf4e3,stroke:#a86c17,stroke-width:1.5px,stroke-dasharray:5 3,color:#14181d
  classDef blocked fill:#f7e2df,stroke:#9d3a2f,stroke-width:2px,color:#14181d
  class REG specialist
  class BL blocked
```

The sandbox is **per project**. The network and the proxy take their names from the run
config — derived from the project segment of `run.config.<project>.json` when it names
neither — so two runner processes against two projects draw two copies of this diagram
side by side, and neither one's `up` or `down` touches the other's plumbing (change-log
row `repo-jur`). The proxy *image* is shared; only the running container and the network
are per project.

A specialist that needs a different model or a different tool changes nothing structural:
the coding agent is already swappable through `agentCommand` → `PIPELINE_AGENT_CMD`, and
the contract is only "a shell command that reads a prompt on stdin and edits files." A
non-Anthropic tool would additionally need its domain added to the allowlist — the one
place the closed-network policy would have to be revisited deliberately.

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
| Not dispatched: no frozen suite on the fork branch | — never launched | undispatchable | untouched, stays `open` | no | no |

`undispatchable` is the one row here that touches Beads **not at all** (§4.11, §4.12,
change-log row `dispatch-gate`). The ready queue's second admission rule refuses the issue
before `claim()`, so it is never in progress, never blocked, and the next run picks it up
unchanged the moment its suite is pushed. It is a row in the manifest and not a hole — a
refused task that produced no row is, after the unattended run where nobody watched it
happen, indistinguishable from a task nobody queued — and it ranks second in scrutiny order
behind `tampered`, because a batch that could not run is the first thing a person opening
the report needs to see. Unlike the park's refusal below, it is a distinct outcome rather
than a reuse of an existing one: parking is scheduling, and this is a statement about the
work itself.

The table is unchanged by the run-level park, deliberately — parking is *scheduling*, never
*judgment*. A task the fired pause cap refused adds no outcome: it reports the existing
`paused` status, and the only difference from the row above is that it never launched, so
Beads is untouched and its issue stays `open` rather than in progress (§4.7).

`blocked` is what takes failed work out of the ready queue: it needs a human decision
in review, so the loop can never re-pick it. **No advisor verdict appears in this table** —
that is the point. Advisory notes ride along in the PR body and the run report as
evidence for you, and change none of these outcomes.
