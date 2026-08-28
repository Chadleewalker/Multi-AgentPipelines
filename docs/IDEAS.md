# IDEAS.md — the idea inbox

Somewhere to put *"that's probably a good idea"* the moment you have it, so it survives
without being thought about yet.

This is deliberately the cheapest document in the repo. It is not a design, not a spec,
not a backlog. An entry here makes **no** claim that the idea is good, sized, wanted, or
ever going to happen. That is the whole point: capture has to cost nothing, or it doesn't
happen at the moment the idea shows up — which is the only moment it is free.

## Where this sits

The repo already had four homes for a thought, and none of them accepts an unformed one:

| Home | Holds | Costs |
|---|---|---|
| `DESIGN.md` | a decision, and why | an interview, critics, a change-log row |
| `PLANNING.md` → `docs/planning-draft-*.md` | a spec being made machine-checkable | a planning session |
| a Beads issue | committed work, frozen | approval, frozen tests |
| `docs/STATUS.md` | where the build actually is | it describes reality, not intent |

An idea that isn't ready for any of those had nowhere to go but your head. Filing it as a
Beads issue is the tempting mistake and the wrong one — issues are commitments, they show
up in `bd ready`, and the queue is what the runner drains unattended. **An inbox that can
start a container is not an inbox.**

## The promotion path

An idea is not finished here; it is *parked* here. The way out is the way everything else
in this repo gets built:

```
IDEAS.md  ->  DESIGN.md section (+ change-log row)  ->  spec + frozen tests  ->  Beads issue  ->  a run
  parked        decided, with a reason                    machine-checkable      committed
```

Same two-stage shape as `bd remember` → the promoted conventions in `CLAUDE.md` (§3.6):
**the inbox is a staging area, not a destination.** A note that has earned its place moves
somewhere permanent and cites where it came from; a note that hasn't, sits here or gets
dropped. Nothing is ever implemented straight from this file — an idea that skips the
design and spec layers is exactly the scope creep `design-ref` exists to catch (§3.1).

Planning sessions read this file for candidates (`PLANNING.md`, step 0). That is the only
process obligation attached to it.

## How to write an entry

A title, a sentence or two on **why you'd want it** — not how you'd build it — and the
date. That's it. Resist adding structure; if an entry needs a section of its own it has
stopped being an idea and wants a design doc.

```markdown
- **Short imperative title** — why this would be worth having, in a sentence or two.
  Whatever context future-you will not remember. 2026-07-30
```

Optional extras, only when they're actually true:
- `Blocked on:` — something that has to land first. Name the change-log row or issue id.
- `Related:` — an existing design section this would touch.
- `Thread:` — the identity file for this idea, once someone is actually working it:
  `docs/threads/<slug>.md` (DESIGN.md §3.8, change-log row `thread-identity-files`). That
  file carries the structure this one refuses to hold — current thinking, decisions and
  who made them, open questions — which is what lets an entry here stay a paragraph even
  while the idea is being designed. Most entries never get one.

**Grouping:** this is one flat list on purpose. Add headings only when the flat list
genuinely stops being skimmable — an inbox with a taxonomy is a filing system, and a
filing system is a thing you avoid using.

## What must not go in here

Two hard boundaries, both inherited:

1. **This file is public, and it is pipeline-only.** This repo documents the machinery,
   never the work done with it. Ideas about a *target* project belong in that project's
   own `docs/IDEAS.md`, not here — naming one here leaks the thing the boundary exists to
   protect, and `scripts/test-sanitize.sh` reads the tracked tree as bytes to catch it.
   Write "the first real project", never its name.
2. **Nothing that is already decided.** If it's in `DESIGN.md` it isn't an idea, it's a
   plan; if it's a known gap in `docs/STATUS.md` it isn't an idea, it's work. Duplicating
   either here is how an inbox becomes noise nobody reads.

---

## Inbox

<!-- Newest at the top. Nothing here is committed to. -->

- **Decide what happens when two people point the pipeline at one project** — §4.12’s run lock makes “one run per project” true on *one machine*: the record lives under the git-ignored `runs/locks/`, so a second person’s clone has a second lock and cannot see the first. The Beads database is per-clone too, so the two of them do not contend for one queue — they each drain a **copy** of it, claim the same ids, and push branches for the same work, which is hard rule 1 (“the host is the only writer to the task queue”) failing by arithmetic rather than by anyone breaking it: the rule assumes one host and nothing asserts that. §6 says “first target: a single developer workstation” and is silent on a second person, so this is undecided rather than decided-against. The cheap answer is a stated convention — one project has one owner — which is what `SETUP.md` Part F now carries, and it may well be the right one: the expensive answers all involve a lock somewhere both machines can see, which means shared state the design has so far refused. Worth deciding before the second person arrives rather than after, because the failure is silent on both machines and the evidence of it is two PRs for one issue. Related: DESIGN.md §4.12, §6, hard rule 1, change-log row `setup-agent-installs`. 2026-08-27

- **Name the checks that failed in BOTH freeze-gate runs, not just the verdict.** `unreachable`
  now exists (change-log row `repo-inj`) and says *something in this suite cannot be reached by
  any implementation* — but it says it about the whole suite, so the human's next move is to
  read two captures side by side and intersect them by eye. That intersection is mechanical:
  the fork-point run's failing lines minus the probe run's passing ones is exactly the
  candidate set, and both captures are already in hand when the verdict is decided. Held back
  from `repo-inj` deliberately and sequenced after it — the verdict had to exist first, and a
  failure-line parser is a separable deliverable with failure modes of its own (every runner
  formats failures differently, so a parser that reads one project's output and silently
  matches nothing in another is the shape that ships as a feature and does nothing). Worth
  wanting because the two runs it would have named — 11 of 29 checks in one, a `git init -q -c`
  in the other — each cost three container attempts and were found by reading, in a container,
  at attempt three. Related: DESIGN.md §3.2, `PLANNING.md` step 4. 2026-08-27

- **Give `PLANNING.md` step 3 a charter and fresh context, the way step 1b got them.**
  Step 1b already drafts the acceptance criteria in fresh context; step 3 then writes the
  frozen tests back inside the primed session, and states no context requirement at all —
  that undecided half is the idea. Worth wanting because the tests are what judges every
  attempt of a run, and `docs/STATUS.md` ("What this does not prove") already records the
  cost of the primed seat: specs drafted by one context that also wrote and reviewed its own
  criteria, where "the panel's value came precisely from being unprimed". A test-writer
  subagent is already spawned ad hoc, with no charter and no record — the planning-session
  ledger entry in this inbox records one. Against it: a fresh-context author cannot see the
  design discussion, and knows least about the harness it is writing tests for — shadow-01's
  self-nesting `npm test` was a harness-knowledge failure, not a priming one. Not §3.5
  slot 2, which is a *domain* specialist. 2026-08-21
  Related: `PLANNING.md` steps 1b and 3; `DESIGN.md` §3.2 ("Below the panel", move 5).

- **Give the sweep lock the liveness rule the run lock already has, and stop printing
  `rm -rf` as the remedy.** When `scripts/test-all.sh` finds `runs/.test-all.lock` it prints
  the holder's pid and the time, then suggests removing the directory "if that process is
  gone" — leaving the reader to answer the one question the script could answer itself. On
  this host the reader gets it *wrong*: the recorded pid is a Git Bash (MSYS) pid, which
  Windows `tasklist` cannot see, so the obvious check reports a live sweep as dead with
  complete confidence. Checking `docker ps` does not rescue it either — a sweep sits between
  containers for seconds at a time, so an empty listing is not an idle sweep. Doing exactly
  that on 2026-08-20 cleared a live sweep's lock, ran a second sweep on top of the first, and
  produced **7 red suites out of 39** whose signatures were all infrastructure (exit 137 and
  125, `network still up after run`, a reclaimed `pipeline-net`) rather than code — the
  precise disease change-log row `sweep-trustworthy` exists to prevent, arrived at by
  overriding the lock that row installed. A re-run on a quiet host was 39 green.
  The machinery is already built and already exported for exactly this reason:
  `runner/lock.js`'s `isHolderLive` was made an export rather than a second copy
  (`sweep-trustworthy`), and the sweep already reclaims stale *run* locks with it. Its own
  lock is the one place it does not use it. Worth having because a lock a human overrides by
  hand is not a lock, and the failure it lets through is expensive twice: once in the wasted
  ~10 minutes, and once in the far worse outcome where the reds get believed and someone
  hunts a regression that does not exist. Related: `DESIGN.md` §4.12; change-log rows
  `sweep-trustworthy` and `repo-zje`. 2026-08-20

- **A transient upstream error is not a failed task — 529 falls straight through to
  `failed` / blocked** — on 2026-08-19 an agent call came back `API Error 529 Overloaded`
  with zero output tokens and no work attempted. The entrypoint's rate-limit branch greps
  the agent log for `usage limit|rate.?limit` (`pipeline/entrypoint.sh`), which "Overloaded"
  does not match, so the call falls through to `die30` — exit 30, which the §4.11 table maps
  to report status `failed` and Beads `blocked`. `die30` exits on the spot, so the attempt
  cap never engages either: one busy moment upstream ends the task on attempt 1 of 3.
  That is honest at the level the entrypoint can see (the agent command failed) but it
  conflates *this task is wrong* with *the API was busy for a second*, and the two have
  opposite recoveries. Nothing about the spec, the frozen tests or the fork point was
  involved; unblocking the issue and re-running is the entire fix. The cost is that a
  blocked issue leaves `bd ready`, so an overnight run's other tasks are unaffected while
  this one silently drops out of the *next* run's queue until a human touches it — the
  quiet-hole failure mode this repo keeps rediscovering.
  The run-level park (§7, change-log row `repo-i9y`) is the wrong instrument here and should
  not simply be widened to catch 529. A usage limit is a property of the **subscription
  window** — waited out on a reported reset time or a probe, minutes to hours, correctly
  shared across every task in the run. A 529 is a property of the **upstream at that
  instant** — seconds, per-call, retryable in place. Feeding one into the other would park a
  whole run behind a shared wait sized for a rate-limit window because one call got unlucky.
  Options worth weighing, none chosen: a bounded in-container retry with backoff before
  `die30` (cheapest, no contract change, but invisible unless it logs what it swallowed —
  and this repo has been bitten by silent swallowing more than once); a sibling exit code to
  20 meaning *transient upstream*, which the runner relaunches after a short backoff with its
  own small cap and which leaves the issue `in_progress` rather than blocked (reuses the
  relaunch machinery and keeps the record honest, at the price of a new row in the §4.11
  table and in everything downstream that reads it — `runner/queue.js`'s `OUTCOMES`,
  `run.schema.json`, the report, the audit, the dashboard); or leaving classification alone
  and only stopping exit 30 from blocking the issue (cheapest for the queue, worst for the
  record, since a genuinely broken task would then return every run with nothing marking it).
  Two things should settle it before anything is specced. First, whether the CLI already
  retries 529 internally: if it does, a 529 that reaches the log is one that already survived
  the CLI's own backoff, which argues against adding a second retry loop underneath it and
  for the exit-code route. Second, **detection must not become a list of upstream error
  strings** — that is precisely the pattern banned in `CLAUDE.md`'s log-scraping rule
  (change-log row `repo-52m`); check whether the CLI's JSON envelope carries a structural
  error or status field first, and only fall back to prose matching if it does not.
  Related: §4.7, §7, §4.11. 2026-08-19

- **Assert at publish time that no committed entry is a symlink escaping the workspace** — a
  target project's container may legitimately create symlinks *inside* the workspace: baking
  dependencies into the image and linking them into place on first use is the standard way to
  satisfy the no-egress rule (hard rule 6), and a coding agent has no way to tell such a link
  apart from project content. The host currently trusts the target repository's own ignore
  rules to keep those links out of a commit, and a `.gitignore` rule written as `node_modules/`,
  `dist/` or `__pycache__/` matches **directories only** — so a symlink of that name is not
  ignored at all, shows as ordinary untracked content, and a `git add` takes it. On a host the
  same path *is* a real directory, so `git check-ignore` reports it as ignored, which is why
  every human who reads the rule reads it as correct. One target project shipped such an entry
  in a task that verified on attempt 1 with zero concerns and passed a 31-file human review; a
  mode `120000` addition renders as a one-line file in a diff view.
  The damage is downstream and actively misdirecting. On a host that already has the real
  directory, every checkout of the merged commit fails partway *and deletes part of the real
  directory on the way down*, manufacturing the symptom it appears to be reporting — a day was
  lost to a handoff that blamed a damaged dependency install for what the failed checkout had
  caused. On a fresh clone with `core.symlinks=false` (the Windows default, and the reference
  host's) it does not even fail: git writes a plain text file containing the target path, the
  clone reports success, and the dependency install then fails for a reason that mentions
  neither git nor symlinks.
  Cheap and deterministic to check: scan the task branch's diff against the fork point for mode
  `120000` blobs whose content is absolute or escapes the repository root. Host-side, in the
  publish stage, before the push — where the design already puts authority, and where unlike a
  container-side check the agent cannot edit it.
  **What the host then does about it is the question to settle before this is specced**, and it
  is not the gate-versus-evidence question. Both candidates are evidence: failing a task for a
  link it was told to create is exactly the hazard hard rule 5 exists to prevent, and neither
  option touches the outcome. But they do different amounts of work. *Surfacing* it in the run
  report warns about a trap it leaves armed — the branch is still pushed, the PR still carries
  the entry, and the damage lands at merge, which is precisely where review already missed it
  once. *Stripping* it prevents the merge, but the host writing to a task branch is a new
  capability: `runner/publish.js` pushes and opens a PR and creates no commits at all. The
  variant that does not rewrite what the container authored is a separate host-authored hygiene
  commit on top of the branch, visible in the PR and named in the report. Price that against
  surfacing before either is chosen.
  A configuration-only variant is worth considering *in addition* rather than instead: have
  onboarding read a candidate project's ignore rules for trailing-slash patterns a container
  symlink could slip past, at planning time, where a human is present. The two cheaper
  alternatives are both weaker. Appending dependency-directory names to `.git/info/exclude`
  alongside `.run/` reuses a path that already exists (`runner/workspace.js`), but the pipeline
  cannot know those names for an arbitrary target — so it either hard-codes a list that goes
  stale or reads one from `pipeline.config.json`, which is the same trust that failed here.
  Telling the agent in its prompt not to commit symlinks costs nothing and catches nothing
  reliably; a prompt is not scaffolding.
  Reproducible without a run: in any repository whose `.gitignore` says `dir/`, create a symlink
  named `dir` and run `git status` — it is untracked and stageable. Related: §4.4 (the
  verifier's remit is `frozenPaths`, so the committed file *set* has no gate today, only its
  content does), §4.10, hard rules 5 and 6. 2026-08-19

- **Teach the corpus readers what in `runs/` is not reviewable work — the non-run
  subdirectories and the e2e fixture runs.** Two shapes of one problem, parked separately
  and merged because a reader that knows one and not the other still prints a corpus
  nobody trusts.
  *Not runs at all:* `scripts/audit-runs.js` buckets any direct child of the runs root that
  has neither `run.json` nor `run.log` as `other`/`no-artifacts` and prints it by name in
  its totals, so the batch markers at `runs/batches/` (`DESIGN.md` §3.9) will show up in the
  audit report as a stray corpus entry. Cosmetic and honest today — it *is* an entry the
  reader does not recognise — but the session-ledger idea would add `runs/sessions/` and the
  same thing happens again, so the general answer is a named list of non-run subdirectories
  rather than a special case per tool. `scripts/verdict.js` and `scripts/dashboard.js`
  already skip them and need nothing.
  *Runs, but synthetic:* the first full read of the pending list (2026-08-06) found 112
  rows, of which 20 were PRs the e2e suite opens against its own fixture repo — test
  artifacts nobody reviews, so no verdict is ever an honest answer for them. Recording one
  anyway is fake data; leaving them means `verdict.js pending` never empties, and a list
  that cannot reach zero trains the reader to skim past it — the same discount-the-signal
  disease as a sweep that goes red for environmental reasons. These are distinguishable
  mechanically too, by the `e2e-` prefix the harness assigns to the run id, so the shape is
  a filter in `pending`, not a schema change.
  Both halves want the same decision made once — **what counts as the corpus**, declared in
  one place every reader consults, rather than a skip list per tool. The honest question the
  e2e half still carries is whether the exclusion belongs in the readers at all or upstream,
  in whether e2e runs should land under `runs/` in the first place; settle that first,
  because it decides whether a non-run list is the whole answer or only half of it.
  Deliberately excluded from the batch-marker tasks: fixing it there would have doubled that
  PR's blast radius into a second reader with its own frozen suite.
  Related: `DESIGN.md` §5, §3.9; change-log row `repo-1ie`. 2026-08-19 (merged from entries
  parked 2026-08-06 and 2026-08-19)

- **Capture all planning-session info going forward — a session ledger under `runs/`.**
  (User directive, 2026-08-18: "I need to capture all session info going forward.")
  Runs are fully recorded; planning sessions are not — yet a planning session is where
  most of the day's agent work and every load-bearing decision actually happens. What
  the 2026-08-17/18 session against a real target project produced that survives nowhere durable or only as
  disposable draft prose:
  - *Subagent activity*: every survey/drafter/critic/test-writer spawn with its purpose,
    duration, and token usage (~2 hours and ~1.7M tokens, reconstructible tonight only
    from the live session's context).
  - *Review rigor*: critic findings and their dispositions, spec-lint runs, freeze-gate
    verdicts — currently prose in planning drafts, which the playbook calls disposable
    after freeze.
  - *Decisions with owners*: user approvals (slicing, direction model, hardware-faithful
    reversal), and which evidence changed which decision.
  - *Incidents*: preflight refusals, infra outages, session-limit cutoffs and resumes —
    what they cost and how they resolved.
  - *External evidence*: bench findings (packet captures decoded, designer Q&A) — tonight
    these live in a wave-2 planning draft that is formally deletable.
  Shape suggestion: an append-only `runs/sessions/<date>/session.jsonl` the interactive
  session writes as it works (same host-writes-everything discipline as the task ledger),
  plus a place drafts' permanent-value sections (hardware findings, dispositions) get
  promoted to instead of dying with the draft. This is the recording half; the
  build-stats skill below is the reader half. V2's `/spec` skill is the natural home for
  the writing hooks.

- **A build-stats skill: one command that writes the "how much work did we do" summary.**
  After two real task waves against one target project (2026-08-17/18) the user asked for a day's-work record — agent
  time, lines, files, pass rates, review rigor — and it was assembled by hand from three
  sources: git diffstats on the target repo, `Active time`/`Diff` lines grepped out of
  run reports, and subagent durations that existed only in the interactive session's own
  context. Make it a skill (`/build-stats <target-repo> [--since <ref|date>]`) that joins
  git + the `runs/` corpus (the same pure-reader discipline as `audit-runs.js` — print
  markdown, write nothing unless asked) and emits the stats file. Two design notes from
  doing it by hand: (1) container-side model/token usage is not in the run reports today,
  and planning-side subagent time/tokens are recorded nowhere durable at all — the skill
  is only as good as what the corpus keeps, so this idea probably splits into "record
  planning-session agent usage somewhere under `runs/`" plus the reader that summarises
  it; (2) the most persuasive numbers were the rigor ones (findings dispositioned,
  red-with-green-control gates, first-attempt pass rate), which live in planning drafts
  and freeze-gate output, not in any machine-readable place — deciding what of that to
  structure is the real design work.

- **Preflight should validate `proxyPort` against what the proxy image actually listens
  on.** The config accepts any port, squid's `http_port 3128` is hard-coded, and the two
  only meet at the readiness probe — which fails after 15 s with a message that names
  neither. The target project's first real run (2026-08-17) died in preflight because onboarding had
  written `proxyPort: 3129`, presumably for per-project uniqueness the private network
  already provides. Either assert the value in preflight (cheap: grep squid.conf at image
  build is wrong-layer; probe the container's listening port before the loop), have squid
  read the port from the environment, or drop the knob entirely — a config option nothing
  can satisfy but one value is a trap, not an option.

- **Choose the model per phase and per task, not per run** — `model` in
  `run.config.*.json` is one alias for the whole run, and it reaches both agent phases
  through a single `AGENT_CMD` in `pipeline/entrypoint.sh`, so the docs phase runs on the
  same tier as the code phase and an easy task runs on the same tier as a hard one. Why
  you'd want it: the verifier is deterministic, so a cheaper model can only fail
  honestly — three attempts and a `stuck` row, never a weaker gate — which makes
  downshifting a cost question rather than a quality risk. The cheap half is the docs
  phase, which summarises and edits docs. The per-task half is the one with a design
  question in it: "this task is easy" is a planning-time judgment, so the tier would have
  to come off the frozen spec rather than the run config, and that is a new field in the
  contract. The likely split is not the intuitive one: the docs phase (summarise the change,
  edit the files it owns) is Sonnet-tier work, while the code phase is the hardest thing in the
  pipeline and stays on the top tier. Related: `DESIGN.md` §4.3, and §4.11 — the resolved id is
  already recorded per task, so provenance survives either change. 2026-08-17

- **See the usage limit coming, and refuse to start work that cannot finish before it —
  not freeze work that is already running.** §4.7 and §7 already make a usage limit a pause
  that resumes itself: the container exits 20, the run-level gate opens one shared wait on
  the reported reset time, and a fresh container relaunches against the same workspace with
  the attempt counter intact. What is missing is the *predictive* half — every one of those
  parks is discovered by hitting the wall. Worth having because the wasted thing is not the
  interrupted turn (minutes, and no attempt is burned) but the tail of a window: launching a
  40-minute task into 20 minutes of remaining budget spends the rest of the window on work
  that will be interrupted anyway. The shape is therefore **admission control, not process
  freezing** — a fourth condition on `gate.admit()`, which already has exactly three states
  and is already consulted before `claim()`, so a refused task never touches Beads and its
  issue stays `open` for the next run.
  **Freezing the container was the reading to reject, and the reason is worth keeping so
  nobody re-derives it.** `docker pause` is real, works on the reference host, and uses the
  kernel's cgroup freezer to suspend every process in the container — but it preserves
  memory and *not* the open TCP connection to the Anthropic endpoint. A container thawed
  after a multi-hour window resumes into a dead socket, and the entrypoint's detector
  (§4.7) matches on `usage limit|rate.?limit` in the agent log, so a socket error falls
  through to `die30` — exit 30, a genuine failed attempt. Suspend would convert today's free
  pause into a burned one of three. Freezing *between* requests would be safe and is not
  reachable: the request loop lives inside the CLI.
  **The host/container split is not the obstacle it looks like.** Nothing outside a container
  spends meaningfully against the window — the runner clones, launches and waits, and the only
  host-side model call is the minimal probe in `pause.js`. The host needs to sleep, which it
  already does; there is no Windows-side suspend to design.
  **The open question that decides feasibility, and the reason this is parked rather than
  specced:** is remaining subscription budget readable by a machine at all? Counting our own
  spend under-reports, because interactive sessions draw on the same window; and any
  undocumented usage surface would put an unstable third-party output format in the runner's
  control path, which is the same disease as scraping an agent log — the existing exit-20
  detector greps only because it has no alternative. Settle that before designing anything.
  The deterministic first step needs none of it: record per-task cost and size batches from
  the corpus. Related: `DESIGN.md` §4.7, §7; change-log rows `pause-cycle-cap` and `repo-i9y`;
  the *Record what each task cost* entry below, which is the measurement this depends on.
  2026-08-14

- **The dashboard's live `attempt` reads one too low — re-freeze the `/state` contract
  before the page session.** `scripts/dashboard.js` sets a task's `attempt` to
  `status.attempts.length`, and its frozen suite pins exactly that (`tests/acceptance/`
  `repo-kfg/`, check `C1 app-101 attempt 1 of attemptsMax 3`). But `attempts` is
  append-only *on completion* — an attempt appears only once the verifier has judged it —
  so a task actively working its first attempt carries `attempts: []` and the contract
  says `attempt: 0`. Confirmed live, not inferred: a running task's workspace status file
  read `{"issueId": …, "attempts": []}` while its container was ten minutes into the code
  phase. The page renders "attempt n/3", so it would show `0/3` for most of a task's life
  and `1/3` while the task is really on its second try. The implementation is **correct
  against its spec** — this is a spec defect, so the fix is a re-freeze (`attempt` becomes
  the in-flight number, `attempts.length + 1` while a task is running, plain
  `attempts.length` once it has finished), not a patch to shipped code. Worth doing before
  the page session rather than after, because the page is what surfaces the number.
  Notable second-order point for PLANNING.md: the task agent had §3.3's concern channel
  available and did not use it — the spec was internally consistent and its tests passed,
  which is exactly the case a frozen test cannot catch. Related: change-log rows
  `repo-kfg` and `live-dashboard`. 2026-08-11
  **Update, same day (change-log row `live-dashboard-page`):** the page now computes
  `attempt + 1` for an in-flight task itself, so nothing user-visible is wrong today. That
  lowers the urgency but does not close this: the *contract* still reports a number whose
  meaning changes with the task's state, and every future reader of `/state` has to know
  to correct it. Decide deliberately — either re-freeze `attempt` as the in-flight number,
  or keep it as "attempts judged" and **rename it** so the trap is not reset for the next
  reader.

- **Give the freeze-gate control fixture a dependency-exercising test** — the control
  exists to distinguish "tests discriminate" from "harness broken", but a control that
  never touches the target's heavy dependency (a game engine binary resolved through an
  env var, in the session that hit this) stays green while every real test goes red for
  the harness reason — a vacuous RED the gate then certifies as discriminating. Caught
  only because the per-test failure lines were eyeballed; the honest state was exit 2,
  not exit 0. The fix shape: the control should invoke the same runner path the real
  tests do (one trivial engine-invoking test beside the trivially-passing one), so a
  missing dependency turns the control red and the gate says "could not tell".
  Related: PLANNING.md step 4 (§3.2, move 1). 2026-08-09

- **Put the concern speed bump at the launch gate, not only in the report** — the run-level
  concern section (change-log row `concern-repeat-surfacing`) puts the signal where a person
  reads *after* a run — and its headline half has now shipped (change-log row `repo-uig`), so
  the count exists and the only question left is who else reads it. The moment it would have
  bitten hardest is the one *before* the next
  one: `PLANNING.md` step 8 makes `node scripts/batch.js show` the last act before launching,
  and that reader already opens every run's `run.json`, where `specConcerns` now lives. One
  line there — *the newest run for this project raised n concerns across m tasks; read its
  report before launching* — is a pure pointer with no resolution state to invent, and it
  lands at the exact instant the second run was launched into a fault seven agents had
  already named. Not built with the first half deliberately: it would be a second reader of
  one fact, and `batch.js` cannot import a shared rule without amending the require contract
  its own suite pins (check F1, node built-ins plus exactly two runner rules), which is a
  decision worth making once the shape has proven itself rather than blind. Related:
  DESIGN.md §3.7, §3.9, change-log row `concern-repeat-surfacing`. 2026-08-25

- **Teach the batch reader that `ready` is no longer the same as `will dispatch`** — once the
  dispatch gate lands (change-log row `dispatch-gate`), the runner has a second admission rule
  and `scripts/batch.js show` knows only the first. It imports `EXCLUDED_TYPES`/`typeOf` from
  `runner/queue.js` precisely so it *predicts what the runner will actually drain* — that
  sentence is the export comment's own warrant — and after the gate an id can read `ready` in
  the launch confirmation and then never dispatch. That is the exact false confidence the
  marker exists to remove, arriving through the marker itself. The fix is probably the same
  move again: import the dispatchability check rather than keeping a second copy, and report a
  third token beside `ready` / `not-ready`. Deliberately out of scope for the gate task, whose
  design says nothing about `batch.js`. **Amended 2026-08-28 (`repo-isq`):** the gate shipped
  and has since grown a *third* admission rule — the freeze receipt — so the reader now trails
  by two rules rather than one, and the refusal it cannot predict has four kinds rather than
  one shape. Two consequences for whoever picks this up. The check to import is no longer a
  boolean about a directory: it reads `.freeze-gate.json` from the same fetched branch and
  needs the run config's `allowHalfProven` to answer at all, so the third token probably wants
  the refusal kind with it. And the runner's queue-summary `NOT DISPATCHABLE` clause was
  deliberately left naming only the missing suite — that string and its grep sites belong to
  this follow-up, so they move once. Related: DESIGN.md §3.9, §4.12, change-log rows
  `repo-8v0`, `dispatch-gate` and `repo-isq`. 2026-08-21

### Agent ideas

The one heading this file allows itself, and here is the justification the grouping rule
above asks for: *"what agents should this thing have"* is a question that gets asked as a
question, and its answers were scattered across the flat list, the Dropped table and
`DESIGN.md` §3.5 — so answering it meant reading all three. Everything else stays flat.

**The constraint all three inherit, stated once so no entry restates it.** §3.5 already
decided *how* a specialist plugs in: three slots in descending leverage (planning critic →
test author → run-time advisor), a charter in `advisors/`, selection from a project's
`pipeline.config.json`, and hard rule 5 — **never a gate**. So none of these is a proposal
for a new mechanism. Each is a proposal to *staff an existing slot*, and the open question
for each is which slot, not whether the pipeline can hold it. Two of them are close enough
to already-decided that they may be small work items rather than ideas; they are parked here
anyway because *which lens is worth staffing first* is genuinely undecided.

**Why this matters if checker and implementor agents arrive.** No such split exists today —
the phase sequence is fixed scaffolding (code → verify → docs, §4.3) and the only checker is
the deterministic verifier. If one is built, the instinct will be to make security and
accessibility into checkers that can fail a task. That is precisely what hard rules 5 and 7
forbid: an LLM that can fail a task voids the three-attempt cap, destroys the retry loop's
steering signal, and produces unactionable overnight failures. **A checker agent is legal
only if it emits evidence and never an exit code.** Deciding that before anything is built is
free; discovering it afterwards means unpicking a gate someone reasonably added.

- **Staff an accessibility lens — and expect it to end up as frozen tests, not an agent** —
  a target with a user interface can pass every gate this pipeline owns and still be unusable
  with a keyboard or a screen reader: the acceptance tests are green, the feature works, and
  nothing anywhere asks whether it works for everyone. Worth having because accessibility is
  the most deterministic-friendly of any domain yet considered here — contrast ratios, focus
  order, tab order, alt-text presence, ARIA roles and names, semantic heading structure,
  keyboard traps, reduced-motion preferences, hit-target sizes are all machine-checkable
  against published rule sets. §3.5 already names contrast ratios as *its own example* of
  domain judgment reducing to a deterministic check, so slot 2 (test author) is the honest
  home and the charter is cheap: one file in `advisors/`, no new phase, no runner change.
  The honest catch, and the reason this is not simply "write the charter": the deterministic
  subset is real but partial. Automated rule sets catch the mechanical half; whether alt text
  is *meaningful*, whether focus order matches reading order, whether an error is announced —
  is judgment, and lands in slot 1 or slot 3. So this lens will split across slots rather than
  living in one, which is a thing to design for rather than discover.
  Scope note: it only pays for targets that have an interface, and per-task opt-in is already
  how selection works — no blanket application. Related: `DESIGN.md` §3.5,
  `advisors/README.md`. 2026-08-03
  *Surveyed 2026-08-03, and the result argues against staffing this lens **here**: the entire
  accessibility surface of this repo is one file, `docs/pipeline-map.html`. Everything else is
  Node, shell and markdown, where the lens is genuinely N/A. So this repo is close to the worst
  place to prove the charter, and a target project with a real interface is where it would earn
  its keep — write the charter, but do not staff it against this tree.*
  *What that file already has, hand-written and unenforced: **all 112 hex values live inside
  `:root` blocks, none outside** — the exact "no hardcoded colors outside the token file"
  condition §3.5 names, currently holding by discipline rather than by a check; two palettes
  (there is a `prefers-color-scheme: dark` block, so the contrast surface is doubled);
  `role="group"` + `tabindex="0"` + a descriptive `aria-label` on the pan/zoom canvas;
  `aria-label` on the three icon-only zoom buttons, correctly absent on the three text buttons
  whose visible text is already their accessible name; a real `keydown` handler and focus
  styling. **Nothing checks any of it** — no `.sh`, `.js` or `.json` in the tree references the
  file at all, which is the same unguardedness `CLAUDE.md` already warns about for its content,
  showing up on a second axis.*
  *Gaps found, all small and all real: no `<html lang>` (the file opens at `<title>` with no
  doctype or head, so a screen reader guesses pronunciation language); no
  `<meta name="viewport">` despite responsive media queries that mobile browsers will largely
  ignore without it — the responsive work is half-wired; no `prefers-reduced-motion` on a page
  whose whole interaction is pan and zoom. Structure only: **no contrast ratio was computed**,
  so whether either palette passes AA is still unknown.*
  *The one piece worth building here regardless, and the cheapest possible start: a Tier-1
  contrast check over the `:root` pairs in both palettes. Pure arithmetic on the WCAG formula —
  no DOM, no browser, no dependency, no Docker — so it fits `tests/unit/` beside the other
  Docker-free suites and `test-all.sh` discovers it by glob. It would answer the open question
  above and convert the token discipline from luck into a gate.*

- **Staff a security lens — the design named the domain and nothing staffs it** — §3.5's
  title names security among its example domains and "does this touch an auth path" is its
  worked example, but there is no `advisors/security.md`, so a domain the design explicitly
  called out has no charter behind it. Worth having because security is where "never a gate"
  is most uncomfortable and therefore most likely to be quietly violated by a well-meaning
  later change — nobody argues with a physics advisor that cannot block, and everybody wants
  a security one that can.
  The design's answer is the escalation ladder, and this repo already contains one working
  instance of it: `scripts/test-sanitize.sh` is a security-adjacent concern — credentials,
  addresses, private names — that was made a **hard** gate precisely *because* it is
  deterministic and reads bytes, with no LLM anywhere near it. That is the template for what
  a security lens should become, not an exception to it.
  The honest catch: most of what an agent would find in a task-sized diff is either already
  deterministic (secret scanning, dependency audit, obvious injection sinks) or needs
  whole-system context a single diff does not carry, because the interesting vulnerabilities
  are compositional — two individually safe changes that combine badly. That argues the lens
  is worth more at planning time ("this task touches an auth path and the spec says nothing
  about it") than after the code exists. Related: `DESIGN.md` §3.5; hard rule 5. 2026-08-03

- **Have something review a finished session and propose pipeline improvements — filed with
  its own counter-argument attached** — the idea is a reviewer that reads a completed session
  and asks what the *pipeline* should learn from it, as opposed to what the task produced.
  Parked with the case against it in the same entry, because the case against it is strong and
  a future reader deserves both.
  **The precedent is against it.** The documentation-updater agent in the Dropped table below
  was declined for exactly this shape — *the mechanism was under-used, not missing.* There are
  already five channels for "something went wrong": `bd remember`, `status.js note`,
  `status.js concern`, `docs/STATUS.md`'s defect list, and the sweep summaries. Defect 11 is
  the case where the evidence was published, correct, and still cost a session because nobody
  read it. A sixth channel producing more unread prose is the predictable outcome, and the
  fix for an unread channel is aggregation, not another author.
  **It also overlaps the audit-corpus entry below, on the weaker axis.** That one reads every
  finished run as a corpus; this one reads a single session. n=1 generalises badly — which is
  precisely the complaint that entry makes about a human reading one or two runs closely and
  generalising from them.
  **What would make it worth having anyway**, and the reason it is not simply dropped: the
  session is the one artifact the corpus *cannot* see. `runs/` records what the runner wrote —
  it does not record the interactive planning session, the critic rounds, or the human's
  "merged / sent back, and why", which the audit entry itself names as the most valuable field
  the pipeline does not own. A session reviewer is one way to capture that verdict at the only
  moment it exists. If that is the real value, the shape is a cheap capture step, not a
  reviewing agent.
  **Placement is forced, not chosen.** Hard rules 5 and 7 put it entirely outside a run:
  post-hoc, never in the control path, never able to change an outcome. As with the audit
  entry, that weaker position is also what permits it to be an LLM at all.
  Related: the *Audit the pipeline's own history across runs* row in Promoted (same data,
  different time axis — promoted 2026-08-04 as change-log row `run-audit`, and its
  aggregation-not-agent verdict bears on this entry too); the documentation-updater row in
  Dropped; `DESIGN.md` §3.6, §3.7. 2026-08-03

*Also agent-shaped: the **documentation-updater** row in Dropped is the agent idea already
declined, and the **run-corpus audit** row in Promoted is the one that graduated — as
deterministic aggregation, not an agent. Read both before proposing a new agent.*

---

- **Find out why the container path degrades over a long sweep, before the sweep stops
  being believed** — two full sweeps on 2026-08-05 went red six times each, and every one
  was environmental: five of the six re-ran green in 12–101s on an idle Docker minutes
  later. The measurement is stark — `scripts/egress-check.sh` end-to-end takes **0.65s** on
  an idle daemon and took **73s** during the sweep, against its own 60s bound, having
  produced the correct answers (`allowed=404 blocked1=000 blocked2=000 direct=000`) before
  being killed. Ruled out: the code (nothing under `runner/`, `pipeline/` or `scripts/`
  touching Docker changed since the last green sweep), the host network (0.16s to
  api.anthropic.com from inside a container, DNS in 26ms), resources (24 CPUs, 15.35GiB, the
  reference host's unrelated long-lived containers idle at 47MiB each), and the gate's
  margin — the blocked probes are refused in **1ms**, not after their 10s timeout, so the
  60s bound is generous rather than thin. What is left is something that accumulates as 35
  suites churn containers and build and tear down the same network over and over; the
  mechanism is **unproven** and naming a cause here would be a guess.
  Worth having because the sweep's entire job is telling you the suites that merely *touch*
  a changed component are still green, and a sweep that goes red for reasons unrelated to
  the code trains you to discount it — which is worse than not running it, since the day it
  is right it will read like the days it was wrong. The two sweeps cost about 2.5 hours to
  produce six reds of which exactly one was real.
  Cheap half worth doing regardless of the root cause: **the 900s per-suite cap is far too
  generous for a degraded run.** Re-running the six reds with a 300s cap surfaced the same
  information in four minutes; the sweep spent 94 and 52 minutes mostly waiting for suites
  that were never going to finish. A shorter cap loses nothing when suites are healthy —
  the slowest green suite in the corpus is 1:30. Related: `DESIGN.md` §4.8; the *Make the
  sweep and a live run mutually exclusive* entry below, which is the other way the sweep
  produces a red that is not about the code. 2026-08-05
  *The cheap half was promoted 2026-08-12 (change-log row `sweep-trustworthy`, via
  `docs/handoff-sweep-trustworthy.md`): the 300s default ships with the exclusivity task.
  The investigation itself stays parked, deliberately — the mechanism is unproven, a frozen
  test against a guessed cause is a task that cannot honestly pass, and the 300s cap is
  what makes the experiment cheap to repeat. Do it after that batch lands.*

- **Retire and bound the memory channel before it grows without limit** — the note store only
  ever grows (104 notes exported into the first production run, 146 by the fifth, 66 keys in
  this repo's own store today), and every task prompt carries all of it. Nothing expires a
  note: `docs/STATUS.md` already found one that was stale within a day (`52m-note-2`, its
  content absorbed by defect 7's fix) and named the gap — "the promotion rule covers
  graduation, not expiry." Left alone this is a prompt tax that rises every run while
  relevance-per-note falls, and a stale note is worse than none: it steers every future agent
  toward code that no longer exists. Cheap versions, not exclusive: retire a note when its
  content is promoted to `CLAUDE.md`; a periodic host-side pass that flags notes whose cited
  files or functions no longer exist; or cap the export and say so in the file. Related:
  `DESIGN.md` §3.6. 2026-08-04

- **Record what each task cost — per-model tokens, from the envelope already being parsed** —
  `modelUsage` in the CLI envelope carries per-model output tokens (defect 8's fix reads that
  table already; it is how 7897-of-7912 was even knowable), and nothing records it. Every
  scaling statement is currently priced in wall-clock only: "concurrency buys elapsed time,
  not throughput", "N containers exhaust the window N times faster" — true, and numberless. A
  per-task usage field in the status file and manifest would make batch sizing, overnight
  capacity and park prediction measurements instead of folklore, and it is one deterministic
  field added to a record that already exists (hard rule 7 untouched). Related: `DESIGN.md`
  §4.3, §7; the audit-corpus entry above, which would want this column to exist. 2026-08-04

- **Track host obligations to discharge, not just name them** — nearly every merged task
  names things no frozen test can hold ("run the sweep on the reference host", "strip the
  network lines from the git-ignored configs", "fix the stale comment in the queue suite"),
  and nothing records whether they happened. The pattern of defect 11 and the T12 staleness
  is the same one: the obligation was published, correct, and undischarged, because
  discharge depends on a human remembering. Cheap shape: a short ledger the run report
  appends to and the sweep stamps its own row into, so "obligations outstanding" is readable
  in one place instead of scattered across PR bodies. The honest catch: this is itself a
  sixth channel that can go unread — the fix may be surfacing outstanding obligations inside
  a ritual that already happens, such as the sweep summary or planning step 0, rather than a
  new file. 2026-08-04

- **Verify a stated mechanic exists in the code before speccing against it** — a planning session
  on 2026-07-31 spent a full exchange designing around "the ship can pull a tethered astronaut",
  which the owner believed was how the game worked. It is not implemented at all: the suit is
  integrated on gravity and the jetpack, the tether is added mass that only ever slows it, and
  there is no ship-to-astronaut coupling anywhere. Nobody was wrong to believe it — it is in the
  design's spirit and half the supporting parts exist — but the spec would have been written
  against a mechanic with no code behind it. Worth having because the check is thirty seconds of
  grep and the failure mode is a frozen task that cannot pass. Note this is the same disease as the
  four checklist items found already-done the same day: **the map and the territory drift in both
  directions**, and only reading the territory settles it. Candidate PLANNING.md step-1a addition.
  Related: *Reconcile a target's spec against the merged tree at planning step 0*, below, covers
  the **written** half of the same drift — a spec that has fallen behind merged code. This entry is
  the **unwritten** half: a mechanic someone believes in that was never built. Both were found on
  the same day from opposite ends, which is the argument for reading the code at step 0 rather than
  trusting either document. 2026-07-31

- **Ask what else reads the number a new mechanic changes** — the same session found that adding a
  line-gun would silently redefine a shipped, already-ticked spec item. `Astronaut.can_reach()`
  credits the *magnet's* range against the gap home; if a line becomes the thing that saves you,
  the RETURN lamp must credit the *line's* range instead — so the lamp's meaning changes without a
  word of its specification changing, and its box stays ticked either way. Worth having because a
  redefinition is invisible to every gate this project owns: the frozen tests still pass, the
  regression net still passes, and the checklist still reads done. The scope critic asks "is this
  several tasks"; nothing yet asks "what did this quietly re-mean". Cheap version: a spec
  constraint naming every existing caller of any function the task touches. 2026-07-31

- **Have the docs phase tick the box, not just write the note** — four times in one day the
  documentation phase updated a checklist item's prose and left its checkbox unticked, including
  once where the task itself had just built the gate the box was waiting for. The failure is
  consistent and one-directional: notes get updated, the state marker does not. It matters because
  the checklist is what a planning session reads to choose the next task, so a stale box is not a
  cosmetic lag — it is a spec cut against a false picture. It cost a full planning cycle on
  2026-07-31: a task was drafted, criteria written in fresh context, and a critic panel run, before
  anyone noticed both deliverables had shipped days earlier and were already guarded.
  Worth having because it is cheap to attempt — the docs prompt already asks for the notes — and
  because the alternative is auditing the checklist by hand before every planning session, which is
  what had to happen instead. Note the honest difficulty: deciding a box is tickable means judging
  whether a claim is *gated*, not merely true, and an agent that ticks boxes optimistically is worse
  than one that never ticks any. Possibly the right shape is narrower — have the docs phase report
  *candidate* ticks as evidence, the way `note` and `concern` already report, and leave the edit to
  the host. 2026-07-31
  *Sharpened by change-log row `trace-ledger` (2026-08-04): a tick now has a convention to
  follow — the ref of the ticking issue rides on the line — but nothing tells the docs
  phase's prompt about it yet, so a docs-phase tick would land unrefed and surface in the
  step-0 report as a claim with no witness. If this entry is ever built, the ref is part of
  the tick.*
- **Tell the docs phase which files it owns, and stop giving living documents dated names** — the
  docs phase's entire file-set instruction is one line in `pipeline/entrypoint.sh` ("Update any
  in-repo documentation affected by the change (README, docs/)"), naming no manifest. It works
  anyway, because the workspace is a full clone and the target's `CLAUDE.md` auto-loads into every
  invocation — so the reading table *is* the manifest, by accident rather than by design. Making
  that explicit is a prompt change plus an assertion against the *generated* prompt file, the way
  change-log row `repo-1cy` established.
  The second half is a convention nobody had written down: **a date in a filename reads as
  immutable.** An agent will not rewrite a document named for a date, and should not — that is a
  record of that date, not a living file. A repo that wants a maintained status document must not
  name it after the day it was started, and the failure looks like forgetfulness rather than like
  the missing mechanism it is. 2026-07-31
  *Found by checking which documents task docs phases have actually touched: nine
  container-authored commits have amended this repo's `docs/STATUS.md`, one adding 41 lines.*

- **Give every onboarded target a living status document, not just this repo** — `docs/STATUS.md`
  here is maintained by the docs phase and cited from `CLAUDE.md`'s reading table; a target project
  gets neither by default, so whatever stands in for one is hand-written and goes stale the next
  time a task lands. Onboarding already creates an issue template, an idea inbox and a control
  fixture; a status file and its reading-table row are the same kind of cheap one-time wiring, and
  they are what make the docs phase maintain it afterwards.
  The pay-off is per-target and repeats: every future adoption inherits a status document a machine
  keeps current, instead of one more file that decays and is caught only when a review happens to
  look. 2026-07-31

- **Reconcile a target's spec against the merged tree at planning step 0** — the entry *Have the
  docs phase tick the box* records the drift; this is the other end of the same failure. A
  planning session reads the spec
  as the statement of what is unbuilt, so a stale box means the session is cut against a false
  picture, and the alternative that actually happened was auditing the checklist by hand before
  every planning session.
  Worth parking separately because the fix sits in a different place and survives the other one
  failing or being judged too risky. Step 0 already reads this inbox, so it is the natural place to
  also diff open spec items against what is merged — and *detecting* that a box's claim is already
  true is mechanical in a way that ticking is not, because it needs no judgment about whether the
  claim is gated. Reporting a candidate list to a human is strictly safer than editing the spec.
  `Related:` *Have the docs phase tick the box* — either alone leaves the other half. 2026-07-31
  *The id-shaped half shipped as change-log row `trace-ledger` (2026-08-04): planning step 0
  now runs `node scripts/trace.js report`, whose "work no ref points at" list is exactly the
  candidate list this entry asked for — mechanical, report-only, no spec edit. What remains
  parked is the half no ref can see: a claim satisfied by merged work that never carried an
  issue id, which only reading the code detects.*

- **Re-read the ready queue when a worker goes idle, so finishing a task can unblock the
  next one** — `bd ready` is already blocker-aware, but `runner/run.js` reads it **once**,
  before the pool starts, and drains that snapshot. So a dependency chain cannot run in one
  batch: if B is blocked on A and A closes ten minutes in, B waits for a whole second run
  even though the host knows it is ready and a worker is sitting idle. Worth having because
  the queue this project actually accumulates is chain-shaped — `repo-sls` → `repo-teq` →
  `repo-i9y` was three batches on three separate runs, and each handoff cost a human
  starting the next one. It also compounds with the concurrency knob rather than duplicating
  it: the measured 1.28× on a two-task batch was one worker idle for 1464s with nothing to
  pick up, which is precisely the hole an unblocked task would have filled.
  Care lives in the details, not the idea: never re-claim what is already in flight, do not
  spin when the queue is genuinely dry, and bound the re-read so an unblock cascade cannot
  loop forever. Legal under hard rule 1 as-is — the host is the only thing reading Beads,
  and it already reads it exactly this way, just once.
  **Not** the same as the two forms of cross-task waiting that already exist and are fine:
  the pool has no barrier (a free worker takes the next queued item immediately), and the
  seconds that `prepare()` / `publish()` / every `bd` call spend blocking the event loop are
  a priced-in trade, load-bearing in the `bd` case — `spawnSync` is what stops two Beads
  calls interleaving over one embedded Dolt database. Blocked on: nothing; `repo-teq` has
  merged. Related: §4.12 (the runner drains the ready queue), §7. 2026-07-31

- **Let a task report progress while it is still running, roughly every 10 minutes** — right now
  a container is opaque from the outside: nothing is visible until it exits and the run report is
  written. A task that has been going for an hour is indistinguishable from a task that is wedged,
  and the only lever is to kill it and lose the work. A periodic line — what it is doing, what it
  has finished, which attempt it is on — would make an overnight run watchable and make the
  kill-or-wait call an informed one.
  The out-channel already exists and is the natural place: `pipeline/status.js` is the sole writer
  of `/workspace/.run/status.json`, the workspace is a host mount, so anything appended there is
  readable live without giving the container a new route out. It would be evidence only, like
  `note` and `concern` — self-reported progress can never touch an outcome (hard rule 5).
  The honest catch is that an LLM cannot keep wall-clock time, so "every 10 minutes" from the
  agent's side is a hope, not an interval; a run that goes quiet would be exactly the run you most
  want a line from. Worth weighing against the deterministic alternative — the host already has the
  agent's log stream and could emit its own heartbeat on a real timer, with no LLM involved
  (hard rule 7), possibly with the agent's self-reported lines folded in when they happen to
  arrive. Which of those is right depends on whether the value is "is it alive" or "what is it
  actually doing". 2026-07-30

- **Give the docs phase a merge strategy, or batched runs will always conflict** — file-ownership
  constraints in a spec keep *code* disjoint across a batch, and on 2026-07-30 three chained tasks
  touched three different code areas with no collision at all. Every one of them also edited the
  target's DESIGN.md, README.md and SPEC.md, because the docs phase always does, so every
  merge after the first conflicted — in documentation only, never in code.
  The change-log half resolved cleanly and is evidence the convention works: both sides appended a
  row carrying its own slug, so keeping both was correct and neither renumbered the other
  (change-log row `repo-006`). The prose sections have no such convention, and that is the gap.
  Options worth weighing: an append-only convention for the doc sections a task may touch; a docs
  phase that writes to a per-task file the host merges; or simply accepting the conflicts and
  saying so in the playbook, since resolving them took one pass and no judgment. Filed rather than
  fixed because which of those is right depends on how large batches get. 2026-07-30

- **Say somewhere that a pure refactor cannot be frozen** — the freeze model assumes a task
  changes observable behaviour, because that is what an acceptance test can witness. A
  refactor's defining property is that observable behaviour does *not* change, so the whole
  class — deduplicate two implementations, collapse one rule into one place, extract a
  helper — has no honest criteria available. Two implementations that agree, and one that
  delegates to the other, are indistinguishable from outside; the only possible assertion
  is on source text, which freezes a decision instead of an outcome and fails on the next
  legitimate refactor.
  `advisors/testability.md` already rejects that criterion shape and did so correctly, but
  rejecting it is all the charter can do: it leaves a task whose entire purpose was
  structural with nothing at all, and no charter is the right place to say "this task
  should not exist." The workaround is known and good — fold the refactor into a later task
  that has a behavioural reason to touch the same code, so the cleanup rides along with
  something witnessable — but it currently lives in one project's planning draft, so every
  other project rediscovers it by spending a session drafting a spec that cannot be frozen
  and a panel pass rejecting it. §3.1 or §3.2 is the natural home. 2026-07-30
  *Found by the critic panel on the first real project, 2026-07-30.*

---

## Promoted

Ideas that made it out, and what they became. Kept so the trail from a half-thought to a
shipped thing survives — the same reason the `DESIGN.md` change log keeps its rationale.

<!-- Newest at the top, same as the inbox. -->

| Date | Idea | Became |
|---|---|---|
| 2026-08-25 | Lint a frozen test for guards that enumerate what later work may change — parked 2026-08-21 after one target repo lost at least eight frozen files across six suites to the shape, including one that diffs its own branch and will fail every code-touching task in that repository from now on | `DESIGN.md` §3.2 "below the panel, move 6" + change-log row `freeze-brittleness-lint`; drafted for freeze in `docs/planning-draft-2026-08-25-concern-and-freeze-lint.md`, then **shipped** as change-log row `repo-uw6`: `brittleFindings` / `lintSuite` inside `scripts/freeze-gate.js`, four shape tokens, a count printed even at zero, named skips, and no path from a finding to the exit code. The panel's correction is what made it work — the shapes had been named after hashing and enumerating, which this repo's own suites do correctly, so the rule was renamed to *the expected side is a literal the author typed* and the near-miss pairs (two computed digests; git against a self-created ref) became the load-bearing coverage |
| 2026-08-25 | Surface a repeated spec concern louder than a report footnote — parked 2026-08-21 after seven task agents across two runs diagnosed one host-side fault correctly and nothing consumed any of them | `DESIGN.md` §3.7 (the readership amendment) + change-log row `concern-repeat-surfacing`; drafted for freeze in `docs/planning-draft-2026-08-25-concern-and-freeze-lint.md`. The launch-gate half stayed in the inbox rather than being folded in |
| 2026-08-19 | A merge-order helper for the PR stack a run hands back — evidence, never a merge. Parked and promoted the same day. Two corrections came out of working it: the PRs are a **fan**, not a stack (every task clones fresh and branches off the integration branch, so they are siblings whose fork points can differ), and **ordering cannot reduce the conflict count** — a file touched by k PRs conflicts in k−1 merges whatever the order — so the value is landing the clean PRs first with zero judgment, clustering the rest, and naming staleness and expected-to-clear failures | `DESIGN.md` §5 + change-log row `merge-order`: `scripts/merge-order.js`, the fourth pure reader on the §5 model. It **computes** merges rather than predicting them from file overlap — `git merge-tree --write-tree` chained through `git commit-tree` simulates a whole order and names the real conflicted paths — and keeps the `repo-73k` pure-reader contract literally, by running both under a redirected `GIT_OBJECT_DIRECTORY` measured to write zero objects into the real repository. Input is a run id, dependency order is inferred from the run record rather than read from Beads, and the expected-to-clear regression join ships with its 2000-character-tail limit printed where it prints (all three, user, 2026-08-19). Never merges, pushes or touches a PR; never a gate. Thread: [`docs/threads/merge-order.md`](threads/merge-order.md) |
| 2026-08-19 | A "batch ready" marker a planning session files when specs are frozen, so the launch step reads state instead of memory. Parked and promoted the same day. The handoff between freezing and launching was a spoken word: two different sessions, nothing on disk between them, so the launch could not confirm what it was launching and a batch frozen and not launched was invisible to the next session | `DESIGN.md` §3.9 + change-log row `batch-ready-marker`: `runs/batches/<project>-<YYYY-MM-DD>.json`, host-only and immutable (no `launched` flag — "still pending" is a join over the run corpus, `verdict.js pending`'s move), read by `scripts/batch.js` (`show`, `pending`). The reconciliation against `bd ready` is the point rather than the confirmation, and is bounded: built-ins only except a `BATCH_BD_CMD` seam that reads and never writes, and an absent `bd` labels the batch unreconciled rather than printing the marker as if the queue agreed. Never a queue item, never a gate, never the source of truth for what runs. Thread: [`docs/threads/batch-ready-marker.md`](threads/batch-ready-marker.md) |
| 2026-08-19 | Give every idea thread a durable identity file from its first exchange, so the session working it is disposable. Borrowed from the persistent-identity / ephemeral-session split — the discipline, explicitly not the autonomy. Parked and promoted the same day: the thread's state (question, current thinking, decisions and whose they were, open questions) lived in one interactive session's context, so a session working an idea was expensive to kill and expensive to resume | `DESIGN.md` §3.8 + change-log row `thread-identity-files`: `docs/threads/<slug>.md`, tracked, undated, flat, with the slug doubling as the future change-log ref (`trace-ledger`'s identity-at-creation move, one layer earlier) and exactly one mutable section. `docs/threads/README.md` carries the convention and the template; `PLANNING.md` step 0 reads `ready` threads; this file gains the `Thread:` optional extra; `ONBOARDING.md` creates the directory for a new target. No reader tooling, deliberately. First live example, and the thread that produced it: [`docs/threads/thread-identity-files.md`](threads/thread-identity-files.md) |
| 2026-08-12 | Make the sweep and a live run mutually exclusive — parked 2026-08-01 after a sweep `docker rm -f`'d a live run's task container and the run read as an OOM kill. Bundled into `docs/handoff-sweep-trustworthy.md` with its second-order point (loud `task-` reclamation) and the 300s-cap cheap half of the degradation entry | `DESIGN.md` §4.12 + change-log row `sweep-trustworthy`; specced in the 2026-08-12 planning session |
| 2026-08-12 | Have the sweep reclaim stale run locks, not just containers and networks — parked 2026-08-05 after a killed suite's leftover lock failed an unrelated suite three hours later. Its honest catch (live lock vs stale lock look similar from outside) is why it ships after exclusivity, and its `isHolderLive`-not-name-match requirement became the exported-liveness decision | `DESIGN.md` §4.12 + change-log row `sweep-trustworthy`; specced in the 2026-08-12 planning session |
| 2026-08-12 | Declare a `regressionCommand` for this repo, so frozen-suite blast radius stops being held by grep — parked 2026-08-04 after three tasks hand-wrote the same guard criterion | change-log row `self-regression`: `pipeline.config.json` gains the key, naming a Docker-free wrapper over the fast pure suites; specced in the 2026-08-12 planning session |
| 2026-08-12 | Stop batch siblings failing each other's frozen suites — parked 2026-08-05; nine of the corpus's eleven partials were this shape. The design question it deferred was answered by Chad on 2026-08-12: no expected-red in the verifier, ever — the report labels instead | `DESIGN.md` §4 item 9 + change-log row `batch-sibling-partials`: the `sibling-batch` label, sorted after genuine partials within the partial band; specced in the 2026-08-12 planning session |
| 2026-08-10 | A live dashboard that lights up the pipeline diagrams as tasks move through them — parked 2026-08-02 with its own three-way feasibility split (free today / one small deterministic change / not at any sane price), which held up under the planning session's read of the code. One correction from that read: the second deterministic change the entry contemplated finding a workspace was unnecessary — the runner's unconditional `workspace ready:` line already existed | `DESIGN.md` §5 + change-log row `live-dashboard`: the reader `scripts/dashboard.js` with a frozen `/state` contract (issue `repo-kfg`, tests at `tests/acceptance/repo-kfg/`), the `phase` field feed (issue `repo-bmd`, tests at `tests/acceptance/repo-bmd/`), and the page as interactive work against the frozen contract — the look deliberately unfrozen, so it is reviewed by looking at it. The reader **shipped** as change-log row `repo-kfg` (`scripts/dashboard.js`, the Docker-free suite `scripts/test-dashboard.sh` / `tests/unit/dashboard.test.js`); what is left of this entry is the `phase` feed and the page session |
| 2026-08-04 | Audit the pipeline's own history across runs, not one run at a time — the corpus was on disk, structured, and had never been read as one. Parked 2026-08-02 with its own experiment attached: read the runs by hand once, and let that decide aggregation-versus-agent. The hand pass ran 2026-08-04 and aggregation won — every repeated pattern fell out of joining structured fields, none needed judgment | `DESIGN.md` §5 + change-log row `run-audit`: `scripts/audit-runs.js`, deterministic and host-only, joining `run.json`/`status.json`/`verify.json`/`verdict.json`; the LLM reader stays unbuilt, with the reason recorded in §5. Frozen as issue `repo-73k` with tests at `tests/acceptance/repo-73k/`; shipped with `scripts/test-audit-runs.sh` (change-log row `repo-73k`) |
| 2026-08-04 | Capture the reviewer's verdict on every run — merged / sent back, and why — at the only moment it exists. Extracted from the two agent-shaped entries that both named it the most valuable field the pipeline does not own, and both concluded the shape is a cheap capture step, not a reviewing agent. Parked and promoted the same day | `DESIGN.md` §5 + change-log row `review-verdict`; frozen as issue `repo-1ie` with tests at `tests/acceptance/repo-1ie/` (freeze gate RED against a green control, 2026-08-04), then **shipped** as change-log row `repo-1ie`: `scripts/verdict.js` (`record` + `pending`, self-contained, chooses the run by `startedAt`) and the Docker-free suite `scripts/test-verdict.sh` / `tests/unit/verdict.test.js` |
| 2026-08-04 | Record spec-to-code traceability at the moment it is created, instead of inferring it later — a ticked box carries the id of the issue that ticked it, so reconciliation is mechanical and nothing ever guesses an edge. The cheapest honest version of a knowledge graph; parked and promoted the same day because it collapses six drift entries into one convention | change-log row `trace-ledger`: the convention, `scripts/trace.js` (report + deterministic backfill via `git log -L`), the Docker-free suite `scripts/test-trace.sh` / `tests/unit/trace.test.js`, and the PLANNING.md step-0 drift read |

## Dropped

Ideas considered and consciously declined, with the reason. Worth as much as the promoted
list: it is what stops the same idea being re-raised every few months.

| Date | Idea | Why not |
|---|---|---|
| 2026-07-31 | A documentation-updater agent owning "all relevant documentation", maintaining its own list of the documents that need writing to | The mechanism was under-used, not missing. The docs phase already maintains every file named in `CLAUDE.md`'s reading table — nine container-authored commits have amended `docs/STATUS.md` — so the fix is to *name the files*, not to add an agent. A second agent would duplicate a phase that exists and put an LLM where hard rule 5 wants evidence only. The half worth keeping became the inbox entry on telling the docs phase which files it owns |
