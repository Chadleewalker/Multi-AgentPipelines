# Planning draft — 2026-08-25

Two tasks, both graduating from `docs/IDEAS.md`, both filed on 2026-08-21 out of the same
pair of runs. Their design decisions are already taken and recorded: change-log rows
`freeze-brittleness-lint` (DESIGN.md §3.2, "below the panel, move 6") and
`concern-repeat-surfacing` (DESIGN.md §3.7, the readership amendment).

They are independent. Neither blocks the other and they touch no common file.

---

## Status of this draft

| Step | A — freeze-gate lint | B1 — headline | B2a/B2b — grouping |
|---|---|---|---|
| 1a intent | done | done | done |
| 1b criteria in fresh context | done | done | **needs a second pass** |
| 2 spec-lint + critic panel | done — 3 critics, all `concerns` | done — 2 critics, both `concerns` | done — 3 critics, 16 findings |
| 3 acceptance tests | ready to write | ready to write | blocked on the pins |
| 4 coverage + freeze gate | pending | pending | blocked |
| 5 user approval | **awaiting yours** | **awaiting yours** | not ready to ask |
| 6 freeze | on approval | on approval | a later session |

---

## Task A — the freeze gate reads what a suite says, not only how it exits

**design-ref:** DESIGN.md §3.2 (below the panel, move 6) · change-log row
`freeze-brittleness-lint`

**Difficulty:** hard — upgraded from medium at step 2 and confirmed by the scope critic.
Four detectors over arbitrary source text with a three-attempt cap is a precision/recall
problem, and this is the first code in the tool to do I/O on a suite at all.

### Description

`scripts/freeze-gate.js` today runs a suite twice and compares two exit codes. That
answers *is this test red at the fork point?* — and an entire class of bad frozen test
answers it correctly, then goes red again for every later task that legitimately grows the
thing it enumerated.

Add a second, textual pass over `tests/acceptance/<issue-id>/`, reported alongside the
existing `guards declared:` block. It names, per finding, the file, the line and the
question the human is being asked — *is later work licensed to change this?*

#### The rule the four shapes are instances of

The panel's central finding was that the shapes had been named after the wrong feature.
Hashing and enumerating are not what makes a guard brittle — this repo's own frozen suites
do both, correctly. **Six** of them (`repo-0b3`, `repo-1ie`, `repo-73k`, `repo-8v0`,
`repo-kfg`, `repo-ybl`) hash a walked tree as the house "writes nothing" guard, and
`repo-1cy` diffs against a merge-base in the way `CLAUDE.md` cites as *correct*. A detector
keyed on "hashes a build" or "diffs a fork point" fires on all seven.

What those seven have in common is what makes them safe: **they compare two values computed
in the same run.** Nothing later work does can change a before/after snapshot.

So the rule is:

> A guard is brittle when the **expected side of the assertion is a literal the author
> typed**, and the population it describes is one **later work is licensed to grow**.

A tool can check the first half exactly. It cannot check the second half at all — that is
the human's question, and it is why every finding is phrased as one.

#### The four shapes, as textual rules

| Shape token | Fires on | Deliberately does not fire on |
|---|---|---|
| `literal-name-list` | an array or object-key literal of **2 or more string elements** on the **expected side** of an equality assertion | a list compared against another computed list; a literal list used as an *input* (`path.join` over fixture names) |
| `literal-count` | a `.length` / `.size()` / `len()` / `count` compared by **strict equality** to an **integer literal ≥ 2** | `> 0`, `>= 1`, `!== 0`; and `=== 0` / `=== 1`, which are almost never a catalogue |
| `literal-digest` | a hash or digest compared against a **string literal** | two computed digests compared to each other — the entire house snapshot pattern |
| `branch-self-diff` | a `git diff` / `git merge-base` invocation naming the **integration branch** (`defaultBranch` from `pipeline.config.json`, or an `origin/` ref) | git against refs the test itself created in a throwaway repository, which is `repo-1cy` |

### Constraints

- **The pass must not change the exit code.** 0 / 1 / 2 are a verdict about red, green and
  indeterminate that `PLANNING.md` step 4 branches on. A lint that can fail a freeze is a
  gate on spec *authoring*, and the way past a gate that can fail you is to reword until it
  passes (hard rule 5).
- **If the pass itself fails, it says so and still does not move the exit code.** An
  exception inside `lintSuite` prints `brittleness findings: unavailable — <reason>` and
  leaves the verdict untouched. It must never print `0`, which would be a silent false
  clean — the exact failure the "name what is skipped" rule exists to prevent — and it must
  never propagate, which would replace the verdict with a stack trace.
- **It decides nothing.** Findings are candidates for a human, phrased as questions.
- **Print the count even when it is zero**, on the `guards declared:` precedent.
- **Findings are per line, per shape.** One line matching two shapes yields two findings,
  one each. No precedence order, no deduplication to a single shape — a precedence rule
  would hide the second reason a line is brittle.
- **Skips are named, with a pinned vocabulary.** `binary` (a NUL byte in the first 8 KiB),
  `extension` (outside the read allowlist), `unreadable` (the read threw). One skip line
  per skipped path, in a pinned format, printed alongside the findings.
- **Paths are printed suite-relative**, matching how `guards declared:` prints the spec
  path it was handed.
- **Only the `--tests` path is linted**, recursively. Never the control directory — for the
  conventional control that is live repo content, and the existing shell suite runs the
  real gate against this repo's real `_control/`.
- **Comments and string literals are linted.** A commented-out brittle assertion is a
  brittle assertion someone will uncomment. Stated so it is a decision, not an oversight.
- **Language scope is stated, not assumed.** The patterns are line-oriented and matched
  against JavaScript, GDScript, Python and shell syntax for each shape. The criteria pin
  JavaScript and one GDScript-shaped fixture; anything else is best-effort and the spec
  says so rather than implying universal coverage.
- No new dependency, no network, no LLM. Node built-ins only.
- `verdictFor` and the existing exit-code table are untouched.

### Deliverables beyond the code

Both were found missing by the scope critic, both are paragraphs rather than tasks, and
both are owned by this task the way `repo-0b3` owned its `PLANNING.md` step 8 line:

1. **`PLANNING.md` step 4 gains the disposition instruction.** The design-ref requires each
   lint finding to take a disposition in the planning draft the way a critic's does. Today
   step 4 documents only the exit-code branch and the guard count, and step 5's disposition
   paragraph names only the panel. Shipping the tool without this gives a gate that prints
   candidates nobody is instructed to dispose of.
2. **Ongoing coverage in the sweep.** A frozen acceptance suite gates this task once and
   never runs again, so on the criteria alone the lint would ship with **zero** regression
   coverage. `tests/unit/freeze-gate.test.js` and `scripts/test-freeze-gate.sh` are
   editable — `frozenPaths` holds only `tools/run-acceptance.sh` — so extending them is
   part of this PR. That includes raising `scripts/test-freeze-gate.sh`'s `CHECKS >= 40`
   floor, which is itself an instance of the shape this task lints for.

This task also adds its own `DESIGN.md` §12 change-log row when it ships, per the
declaration row.

### Not in scope

Anything about *dispatch*. That is change-log row `dispatch-gate`, it shipped as `repo-5yu`,
and it answers a different question — those suites were present and pushed and still could
not pass.

### Acceptance criteria

**Interface** — new exports, nothing existing renamed: `brittleFindings(text, file)`
returning `{ file, line, shape, text, question }` records, and `lintSuite(dirOrFile)`
returning `{ findings, skipped }` where each skip is `{ path, reason }`. `main()` prints a
literal `brittleness findings: <n>` count line, then one `<file>:<line>  [<shape>]` line per
finding with its question, then one skip line per skipped path.

**All fixtures are built at runtime under `os.tmpdir()`**, never committed beside `test.js`.
`tools/run-acceptance.sh` executes every `*.js` and `*.sh` in the acceptance directory as a
test, so a committed fixture would be run as one — and the CRLF fixture must be written with
explicit `\r\n` rather than relying on a checked-in file.

- **C1 — the lint never moves the exit code, and it is proven to have fired in the same
  run.** `main()` returns 0 / 1 / 2 for red / green / broken-harness over a fixture suite
  carrying all four shapes, and returns the identical code for a second fixture directory
  differing **only** in the brittle lines: six calls, two identical triples. Each brittle
  run's stdout carries `brittleness findings:` with n ≥ 4. The verify command is stubbed
  content-blind throughout — the existing suite's stub, which exits on
  `readdirSync(dir).length` — so deleting assertions cannot itself flip a verdict.
  *Discriminating because* the paired "lint fired" assertion stops a lint that is wired in
  but silently returns nothing from passing the exit-code half perfectly. The green and
  indeterminate arms catch an `if (findings.length) return 1`, invisible on the red arm
  since red already exits 0.

- **C2 — each shape fires on a set of variants, not one line, at the right file, 1-indexed
  line and shape token.** Each of the four shapes gets **four variants** differing in
  identifier, literal value, quoting and spacing, with one variant split across two lines,
  and one shape's variants written in GDScript rather than JavaScript. Every variant yields
  a finding at its planted line.
  *Discriminating because* one literal instance per shape is passed with full marks by a
  detector implemented as a **lookup table over the four fixture lines** — and C1's
  deleted-lines run does not catch that, since a text-keyed table fires on the brittle copy
  and not the clean one. Variants generated by transformation cannot be table-matched. Each
  fixture also plants, near line 3, a **comment describing the shape in prose** and a
  **decoy resembling it**: a lint that greps prose reports line 3, one that reports the file
  but not the line reports 1, one that matches the decoy reports the wrong line. One
  fixture is CRLF, which breaks a naive line counter.

- **C3 — the near-miss pairs.** For each of the four shapes, a matched pair differing in
  exactly the feature its rule turns on: `['a','b']` on the expected side of an equality
  assertion **fires**, the same literal passed as an input to `path.join` **does not**;
  `x.length === 4` fires, `x.length === 0` and `x.length > 0` do not; a digest compared to a
  string literal fires, **two computed digests compared to each other do not**; a
  `merge-base` against `origin/main` fires, the same call against a ref the test created in
  a throwaway repo does not. Plus a whole negative fixture drawn from assertions this repo
  actually writes, over which `main()` prints the literal `brittleness findings: 0`.
  *Discriminating because* this is the only criterion separating a useful lint from one
  that flags everything, and the four pairs are the ones the panel proved matter: the
  computed-digest and throwaway-repo cases are **verbatim the house patterns in seven of
  this repo's own frozen suites**, which the pre-panel shapes would have flagged. Any
  detector keyed on `createHash` or on `git diff` fails this criterion, and every such
  detector scores full marks on C2.

- **C4 — the skip vocabulary is exact, and siblings are still linted.** A directory mixing
  a NUL-byte file, a file whose extension is outside the allowlist, a file whose read
  throws, and a readable file carrying a shape: each skip carries its pinned reason token
  (`binary` / `extension` / `unreadable`), each appears in stdout in the pinned skip
  format, and the readable sibling's finding is still present.
  *Discriminating because* `fs.readFileSync(p, 'utf8')` **does not throw on a binary file**
  — it returns replacement characters — so the implementation the old wording invited would
  lint the binary fixture rather than skip it. Asserting the reason token rather than mere
  membership is what forces the three branches to exist separately. The sibling assertion
  separates the two silent failures — swallowing the file, and aborting the pass — which are
  otherwise indistinguishable from "clean suite".

- **C5 — the question is the deliverable, so its value is pinned, not its presence.** The
  four shapes' questions are pairwise **distinct**, each contains a token naming its own
  shape, and each finding's `text` equals the trimmed source line it sits on.
  *Discriminating because* "a question ending in `?`" is satisfied by the literal string
  `?` and by one generic question emitted for all four shapes — presence standing in for
  correctness, which is the failure this repo has a standing rule about. `text` is checkable
  against the fixture independently of the detector.

- **C6 — the existing report survives, in all three verdicts and both invocations.**
  `main()`'s stdout carries `brittleness findings:` in all three `STUB_MODE` arms and with
  and without `--spec`; `guards declared: 1` still appears verbatim; and all six literal
  strings `scripts/test-freeze-gate.sh` greps for (`RED:`, `control run`,
  `guards declared: 1`, `NO control fixture`, `_control`, `one passing test`) still appear.
  One further case: a `--tests` directory containing a path that throws on read, over which
  `main()` still returns the verdict's exit code and prints the `unavailable` form.
  *Discriminating because* `guards declared:` lives inside `if (spec)`, and the obvious
  place to attach an adjacent block is that same branch — where it vanishes for every run
  omitting `--spec`, which is how the shell suite invokes the gate most of the time. The
  three-verdict sweep catches the other obvious placement, after the early return, where an
  indeterminate run prints nothing. The six-string assertion is the only thing standing
  between this change and a red sweep nobody would connect to it.

- **C7 [guard] — the decision table is untouched and the gate writes nothing.**
  `verdictFor` returns the same result for the nine rows the existing suite pins, and a
  sha1 digest over a **purpose-built temp target repo** — paths sorted, path plus content
  bytes only, never mtime — is identical before and after a full `main()` run.
  *Discriminating because* the digest is over a temp repo rather than the live checkout:
  digesting the real tree sweeps `.git`, the git-ignored `runs/`,
  `tools/mapbuild/node_modules` and anything a concurrent sweep is writing, so it would go
  red at random for reasons unrelated to the lint. Sorting the traversal is what makes it
  stable across filesystems; excluding mtime is what lets `withEmptyControlDir`'s
  legitimate create-and-remove pass.

### What the fresh-context read turned up

- **The gate never opens a test file today** — only `fs.existsSync(testPath)`, which is
  true for a *file* as well as a directory, so `--tests` may legally name one. The lint is
  the first code in this tool to do I/O on the suite, and the first place a read can throw.
- **`scripts/test-freeze-gate.sh` greps the gate's output for six literal strings** and
  asserts at least 40 `PASS ` lines. That suite runs the real gate against this repo's real
  `_control/`, so the lint does live I/O during the existing sweep.
- That `CHECKS >= 40` line **is itself an exact-count assertion of the kind this task lints
  for.** It lives in a `scripts/test-*.sh` suite rather than a frozen test, so it is legal —
  a fair warning about how naturally the shape appears.
- **Pinning the four `shape` tokens is deliberately a literal name list.** It enumerates the
  task's own output, which is what a discriminating criterion *should* assert. Expect the
  lint to flag its own frozen suite; that is a finding taking a disposition, not a defeat.
  C7's digest is the same case and takes the same disposition.

---

## Task B — the concern channel gets a readership

**design-ref:** DESIGN.md §3.7 (the readership amendment) · change-log row
`concern-repeat-surfacing`

**Difficulty (proposed):** medium

### Description

§3.7 shipped both halves — the container writes concerns, the host surfaces them — and
then the failure it exists to prevent happened one level up. Across two consecutive runs
against one target, seven task agents independently diagnosed the same host-side fault,
correctly and with evidence, naming each other by issue id. Nothing consumed any of them.
The second run repeated the first's mistake at eight times the scale and spent 3h11m to
record eight `stuck`.

Every one of those concerns was surfaced exactly as specified: as a section of the task
that raised it. That placement is right for one concern and wrong for seven.

`runner/report.js` gains a **run-level concern section above the per-task list**, in two
parts of very different weight:

- **The headline, unconditional.** How many concerns, raised by how many of how many
  tasks, printed with the run's outcome counts where a reader cannot miss it. No
  threshold, no interpretation, cannot fail. *"7 of 8 tasks raised a spec concern"* at the
  top of the first run's report is the sentence that stops the second run being launched.
- **Grouping by shape**, and per group, how many prior runs against the same target carry
  that shape.

### The clustering rule is pinned here, not left to the implementer

`runs/` is git-ignored, so **a task agent in a container cannot see the corpus** and cannot
measure anything. A threshold it chose would be a number that sounds right — the failure
this repo already has a rule about. So it is measured here, in this session, against all
144 concerns in 42 real runs on disk:

- **Normalise:** lowercase; remove every issue id appearing in the run; split on
  non-letters; drop tokens of 2 characters or fewer and a fixed stopword list; take the
  distinct set.
- **Compare** two concerns by **Jaccard overlap** of those sets.
- **Group** by **average-linkage** agglomerative clustering at **≥ 0.25**.

Measured, on the whole corpus:

| Linkage | Threshold | Largest group | Precision | Behaviour |
|---|---|---|---|---|
| single | 0.2–0.3 | 27–33 of 45 | — | over-merges into one blob |
| complete | 0.35 | 6 | 100% | fragments the signal into 6+4+3+2+2+2 |
| **average** | **0.25** | **18** | **100%** | 26 groups, no blob, 1.9s over 144 concerns |
| average | 0.2 | 26 | 100% | better recall, less headroom |

**0.25 rather than the better-scoring 0.2 is deliberate.** At 0.2 the largest group sits one
merge away from touching an unrelated group, and a false merge is the failure that
discredits the whole section — whereas a group that fragments still reads *×18*, and the
headline still reads *8 of 8*. Refusing to bless rather than refusing to notice is the
posture the freeze gate already takes.

### Constraints

- **Evidence, never a gate** (§3.5, hard rule 5). No count of concerns may move an
  outcome, an exit code, a Beads transition, or whether a branch is published. An agent
  must not be able to escape a task by declaring the spec broken n times.
- **No LLM** (hard rule 7). `runner/report.js` is the report generator.
- **The corpus becomes a declared input.** The report names the runs it compared against,
  so `runner/report.js`'s standing claim — regeneration from the same inputs is
  byte-identical — stays checkable rather than quietly weakening.
- A run whose corpus is unreadable still prints the headline. The cross-run count is the
  part that degrades, and it says so rather than printing a silent zero.
- The per-task concern block (currently above "What changed") stays exactly where it is.

### Not in scope

`scripts/batch.js show` — the launch-gate speed bump. It would be a second reader of one
fact and cannot import a shared rule without amending the require contract its own suite
pins. Filed in `docs/IDEAS.md` on 2026-08-25 as a follow-up.

### The fresh-context read split this in two, and the split is accepted

The step-1b drafter recommended splitting, and the line it drew is the right one: **does
this need to read `runs/`?**

- **B1 — the headline.** Pure counting over data the manifest already holds. No threshold,
  no I/O, no new export surface. It is the half that would actually have stopped the
  second run.
- **B2 — the grouping.** Corpus reading, the clustering rule, the degraded vocabulary, the
  declared-input claim.

**They cannot share a batch**, because B2 builds on the section B1 creates. B2 belongs in
the following run. That is the same sequencing constraint §3.7 already recorded for its own
two halves, and the same seam the panel split `repo-0b3` / `repo-8v0` on.

**Pinned contract both halves assume** (open to renaming): `renderReport(manifest, corpus)`
with `corpus` **optional** — absent means degraded — plus two exported pure helpers,
`groupConcerns(concerns, issueIds)` (no I/O) and `readConcernCorpus(runsRoot, {excludeRunId,
targetRepo})` (reads, never throws). `writeReport(runDir, manifest)` keeps its signature and
resolves the runs root itself through a `REPORT_RUNS_DIR` seam.

---

## Task B1 — the run report's unconditional concern headline

**design-ref:** DESIGN.md §3.7 (the readership amendment) · change-log row
`concern-repeat-surfacing`

**Difficulty:** medium. Generous on implementation — it is a count over `manifest.tasks`
and one inserted line — but kept there deliberately: the `## ` heading collision with
`scripts/test-report.sh:72` is a real trap that reddens an unrelated sweep, and a thinner
label buys a thinner review.

**Signature:** `renderReport(manifest)` is **unchanged**. B1 adds no parameter. The
`corpus` argument belongs to the corpus task and is introduced there, which is also where
the compatibility risk lands — `renderReport(manifest)` is called with one argument in
**four** places (`tests/acceptance/repo-5yu/test.js:474`, `repo-iok`, `repo-t3h`,
`tests/unit/dispatch-gate.test.js`), two of them frozen suites.

### The headline's text is pinned here, verbatim

```
spec concerns: <total> raised by <k> of <n> tasks
```

Pinned for two reasons. A frozen test needs a token by which to *find* the line — without
one, "exactly one headline between the counts line and the first task heading" is
uncheckable, since that region already holds blank lines and `Ordered by how much scrutiny
each item needs.` And the corpus task's own frozen tests will assert positions relative to
this text while being authored **before** B1 merges; a guessed literal there is a suite
that goes red for a reason unrelated to its own work.

For a zero-task manifest it reads `spec concerns: 0 raised by 0 of 0 tasks`.

**The heading, if any, is `###` or bold — never `## `.** `scripts/test-report.sh:72` reads
task order with `grep -o '^## [a-z0-9-]*'`, so a `## ` run-level heading injects a phantom
entry into that assertion.

### Acceptance criteria

- **B1.1 — every manifest gets exactly one headline, matching the pinned template, with
  the three integers in their fixed slots.** Asserted case-insensitively against the
  template, for: a six-task manifest with zero concerns; an eight-task manifest where
  **seven** tasks raise **nine** concerns; and a zero-task manifest. Positional anchor:
  after the `**N task(s)**:` line and before the first `## ` heading where one exists,
  otherwise before the report's `---` footer.
  *Discriminating because* the six-task/zero-concern fixture catches the most likely wrong
  build — copying the per-task `if (t.specConcerns && t.specConcerns.length)` guard up to
  run level, which prints nothing on a clean run and passes every fixture that has
  concerns. The 9/7/8 fixture catches conflating the two counts, but **only because the
  template pins which slot each integer fills**: a test asserting merely that 9, 7 and 8
  appear on one line passes an implementation that prints them in the wrong roles. The
  zero-task fixture is why the anchor needs its second branch at all — there is no first
  heading to be before.

- **B1.2 — a malformed `specConcerns` counts as zero, and does not throw.** A fixture whose
  tasks carry `'nope'`, `null` and `{}` alongside one genuine two-entry array yields
  `spec concerns: 2 raised by 1 of 4 tasks`.
  *Discriminating because* the manifest is **not schema-validated at render time**, and a
  run-level sum written as `(t.specConcerns || []).length` counts the string `'nope'` as
  **four** concerns and marks that task as having raised one — non-empty, well-formed and
  false, and passed by every other fixture in B1. `repo-iok` already froze this case at
  *task* level for the same reason; this is its run-level twin.

- **B1.3 [guard] — a concern still changes nothing, and B1 does not read the corpus.**
  Across concern states (0, 1, 5 entries, plus a concern carrying newlines, one carrying a
  `## `-prefixed line, and one at the full 1000-character bound): `run.json` bytes are
  identical except for the `specConcerns` arrays themselves — compared after replacing those
  arrays with a fixed placeholder, since "except for" needs a stated normalisation to be
  checkable — the `^## ` heading sequence equals exactly the per-task headings in manifest
  order with no other entry, each task's concern block still renders after its heading and
  before `**What changed**`, `renderReport` never throws, and `process.exitCode` is
  untouched. Then, from a cwd that is an empty temp directory, render once with **no runs
  root on disk** and once with a **populated** one and assert the two are byte-identical
  and that no prior-run or group wording appears in either.
  *Discriminating because* the original version of this criterion was a gate **no B1
  implementation could fail** — B1 does no corpus I/O, so its four corpus states rendered
  identically by construction, and its named load-bearing fixture described a temptation
  ("hoisting a hot group's task up the report") that cannot exist until groups do. That is
  the `repo-8v0` shape this repo has a standing rule about: checks unreachable by any
  implementation, which cost a whole run. Inverted, the corpus pair *can* fail — it catches
  an implementation that jumps the gun and reads `runs/` in B1. The `## `-prefixed concern
  fixture catches a headline built by string concatenation that lets a concern's own text
  break the heading assertion.

---

## Task B2 — grouping concerns by shape

**Not freezing today.** The panel returned sixteen findings across two critics on this half
alone, and the scope pass recommended splitting it again. What follows is the complete
draft plus the measured constants only this session can produce — but it needs a second
step-1b pass against the pins below before it is honest to freeze. **A and B1 are ready;
this is not, and shipping it half-pinned would freeze an implementer's guess.**

### The split, corrected

The scope critic accepted the B1/B2 line but rejected its stated warrant, and was right.
The draft said the seam was *"does this need to read `runs/`"* — but `groupConcerns` needs
no `runs/` at all, so by that rule the clustering belongs on B1's side. The line actually
drawn is the design's own: **unconditional-and-cannot-fail versus threshold-dependent
judgment** (§3.7: "it is on its own enough"). Naming it after I/O is what let B2 end up
holding both a pure algorithm and the only I/O in the task without anyone noticing.

Fix the warrant and the case for splitting B2 falls out of it:

- **B2a — the clustering, and the within-run `×n` counts.** Pure, no I/O, no seam. Renders
  the groups for a single run, so it is shippable alone rather than a function nothing
  calls. Difficulty **medium**.
- **B2b — the corpus reader.** Directory walk, `run.json` parse, target matching,
  self-exclusion, the degraded vocabulary, the declared-input claim, and the ordering
  determinism rule. Difficulty **hard**.

Sequencing: B1 → B2a → B2b, one per run. The reason is not that each logically requires
the last — a B2-first build would simply create the section itself. It is that all three
edit the same function in the same file from **sibling fork points**, so the second diff is
written blind to the first. B1's headline literal is pinned in its spec precisely so that
B2a's frozen tests can assert positions against real text rather than a guess.

### The measured constants — recorded here because nothing downstream can recover them

`runs/` is git-ignored. A container sees none of it. These came out of this session's pass
over all 144 concerns in 42 runs, and each is measured data exactly as the threshold is.

**Linkage is UPGMA — the mean of all cross-cluster pairs, recomputed at each merge.**
The testability critic's sharpest finding: "average linkage" names two standard algorithms.
UPGMA averages every cross pair; WPGMA averages the two previous linkage values. **They
agree for every merge where one side is a singleton** — which is every merge in every
fixture proposed so far — and diverge as soon as two clusters of size ≥ 2 meet, which is
most of the way to the measured 18-member group. The calibration below holds for UPGMA.
An implementation of WPGMA would pass every proposed fixture and produce a different
report on the real corpus, and the container could never discover it.

**Tokeniser:** lowercase, then `split(/[^a-z]+/)`. Digits are discarded by this, which is
deliberate and must be stated rather than inherited.

**Stopword list — 105 words, verbatim, and part of the measured rule:**

```
a an the and or but if then than that this these those is are was were be been being
to of in on at by for with from as it its not no do does did have has had will would
can could should may might must we you they them us our your their there here what
which who whom how when where why all any both each few more most other some such
only own same so too very just also into out up down over under again further once
because while about against between during before after above below off through
```

**Threshold ≥ 0.25**, on Jaccard of the distinct token sets, with tokens of 2 characters or
fewer dropped and every issue id removed *before* tokenising.

Measured over the full corpus: 26 groups of more than one member, largest 18, 100%
precision against the known dispatch-fault population, 1.9s for 144 concerns.

### What a second step-1b pass must pin before this can freeze

Each is one sentence of decision, and each is a place two engineers ship visibly different
reports from the same text. None is a research question; all of them are choices nobody has
made yet.

1. **The rendered block, verbatim** — heading level (`###` or bold, **never** `## `),
   per-group line format, what identifies a group to a reader, whether singleton groups
   render, and what prints when the run has zero concerns.
2. **The cross-run join.** "One of its concerns joins the group" is the number the whole
   section exists to print, and it is undefined. Mean Jaccard against all members, max
   against any member, or re-clustering the union — three defensible readings, materially
   different counts, and every proposed fixture passes all three.
3. **Merge order and tie-breaks.** Highest-scoring admissible pair per round, or scan in
   index order? Jaccard over small token sets ties constantly (1/4, 1/3), and the choice
   propagates into the final grouping.
4. **The empty token set.** Reachable — a concern of only stopwords, only issue ids, only
   digits, or the empty string, which `run.schema.json` permits. Jaccard of two empty sets
   is 0/0.
5. **Absent `targetRepo`**, which the schema permits and older manifests have. Prior run
   absent, this manifest absent, both absent — and whether "this manifest has none" is a
   fifth degraded state named in words.
6. **The prior-run id list's bound and population.** "Every run id compared against" is
   unbounded — the real tree has 272 directories — and reads three ways: every directory
   scanned, every same-target run, or only contributors.
7. **The run-directory predicate.** The runs root also holds `locks/`, `sweeps/` and
   `batches/`. `scripts/dashboard.js` already answers this; reuse it or spell it out, and
   say whether `batches` is excluded — it is not, in the existing definition.
8. **Both helpers' return shapes**, the way Task A pins `brittleFindings`'s record. B2.3's
   tie-break needs a per-group manifest-task index, which only some shapes can carry.
9. **The degraded vocabulary, as literal tokens**, on the `scripts/batch.js` precedent
   (`run-config-absent`, `bd-unavailable`, `bd-unreadable`) — otherwise the only mechanical
   check available is that four outputs differ, which `state-1`..`state-4` passes.
10. **Member order within a group**, before "first member's text" can mean anything.
11. **The comparator** — code-unit, as `scripts/audit-runs.js` requires, never
    `localeCompare`, which `runner/report.js:34` already uses two lines away.

### Fixtures the panel established, to carry forward

- **The linkage pair, verified in node by the testability critic and confirmed correct.**
  Fixture 1 (A·B 0.5, B·C 0.3, A·C 0.05): single = max(0.3, 0.05) = 0.3 merges all three;
  average = 0.175 does not; complete = 0.05 does not. Fixture 2 (A·B 0.5, A·C 0.4,
  B·C 0.1): average = 0.25 merges; complete = 0.1 does not; single = 0.4 merges. Neither
  fixture separates average from both neighbours alone — **only the pair does**. The pair
  also kills a third variant, "average over all pairs inside the merged cluster", which
  scores 0.283 on fixture 1 and would wrongly merge.
- **A UPGMA-vs-WPGMA fixture is still needed**: a four-concern case whose final merge is
  2-vs-2 with cross pairs on opposite sides of 0.25 — e.g. 0.40 / 0.30 / 0.20 / 0.05, where
  UPGMA's mean of 0.2375 refuses and a WPGMA chain clears it.
- **The issue-id fixture must be near-degenerate or it passes against the bug it exists to
  catch.** Correct behaviour (strip ids, then tokenise) gives Jaccard 0; the bug
  (tokenise first) leaves `repo` shared, giving 1/|A∪B|. For the fixture to go red against
  the bug that must be ≥ 0.25 — so the two concerns together need **at most four** distinct
  surviving tokens. Anything reading like a real concern lands far below and goes green
  against the bug.
- **"Root unreadable" must be produced portably.** A chmod-000 directory is unreadable in
  the container and fully readable on the Windows host, so the check would exercise a
  different branch in each place a frozen suite runs — and the freeze gate's verdict would
  stop meaning what it says. Point the seam at a regular **file** instead: `readdir` throws
  `ENOTDIR` everywhere, for root and non-root alike.
- **A `localeCompare` fixture**: two groups tied on member count and task index whose first
  members' texts sort oppositely under the two comparators — one beginning `Zebra`, one
  beginning `apple`. Both orderings are identical for lowercase ASCII, so without this an
  implementation that copies the neighbouring line passes and the report's determinism
  becomes a function of the host's ICU data.
- **B2 needs a `[guard]` criterion and currently has none**, unlike A7, B1.3 and B1.2 in
  this same draft. Two things need guarding: the `^## ` heading sequence still equals the
  manifest task ids exactly, and — since B2b is the half that introduces filesystem reads
  into a previously pure `renderReport` — that across every corpus state it returns a
  string, leaves `process.exitCode` alone, and leaves `run.json` byte-identical.

---

## Panel dispositions

Every finding the panel returned, with what was done about it. You are approving intent,
not auditing reviews — this is here so that "the panel raised thirty-two things and all
thirty-two were handled" is a claim anyone can check later rather than take on trust
(PLANNING.md step 2).

Six critics ran, each in fresh context with its charter pasted from `advisors/`: the full
panel on Task A, testability on B1, testability and ambiguity on B2, and a scope pass on
the B split itself. **All six returned `concerns`. None returned `ok`.**

### Task A — testability (7 findings)

| # | Finding | Disposition |
|---|---|---|
| 1 | `C4`'s "not read as text" has no mechanical definition, and `readFileSync(p,'utf8')` **does not throw on a binary file** — so the implementation the wording invited would lint the binary fixture rather than skip it | **accepted.** Skip rule stated as three branches with a pinned reason vocabulary (`binary` / `extension` / `unreadable`); C4 now asserts the reason token, not membership |
| 2 | `C2`/`C3` pin sample points but never the decision rule between them — every rule consistent with the three points is a guess, and the freeze would bless whichever one the agent made | **accepted.** This became the rewrite: four textual rules in a table, plus C3's four near-miss pairs differing in exactly the feature each rule turns on |
| 3 | One literal instance per shape is passed with full marks by a **lookup table over the four fixture lines**, and C1's deleted-lines run cannot catch it | **accepted.** C2 now requires four variants per shape, generated by transformation, one split across two lines, one in GDScript |
| 4 | "a question ending in `?`" is presence standing in for correctness — the literal `?` satisfies it, as does one generic question for all four shapes | **accepted.** C5 pins the questions pairwise distinct, each naming its own shape, and `text` equal to the trimmed source line |
| 5 | `C6`'s digest over "the target repo" sweeps `.git`, `runs/`, `node_modules` and any concurrent sweep — red at random — and pins no traversal order | **accepted.** C7 is now a purpose-built temp repo, paths sorted, content bytes only, mtime excluded |
| 6 | Coverage gap: the shell suite greps **six** literal strings and only one is pinned by any criterion; and a read that throws during the live sweep takes the gate's exit code with it | **accepted.** C6 asserts all six, plus the throwing-path case |
| 7 | `tools/run-acceptance.sh` executes every `*.js` in the acceptance directory **as a test**, so a committed fixture would be run as one | **accepted.** Stated in the criteria preamble: all fixtures built at runtime under `os.tmpdir()`, CRLF written explicitly |

### Task A — ambiguity (11 findings)

All eleven **accepted**. Nine are answered by the two structural changes above — the shape
rule table (findings 1, 3, 4, 5) and the new Constraints block (2, 6, 7, 8, 9, 10). Finding
11 (C1's stub must be content-blind, and the pair must be two directories differing only in
the brittle lines) is written into C1.

Finding 4 deserves naming separately, because it is the one that changed the design rather
than the wording: **a detector keyed on `createHash` flags five frozen suites this repo
holds up as correct**, and one keyed on `git diff` flags `repo-1cy`, which `CLAUDE.md` cites
as the right way to do it. Verified independently against the tree — six suites hash a
walked tree, and `repo-1cy` is the only frozen suite touching `merge-base`. That is what
produced the reframe from "hashes or enumerates" to "the expected side is a literal the
author typed".

### Task A — scope (6 findings)

| # | Finding | Disposition |
|---|---|---|
| 1 | No split — and both available cuts are worse than the whole. Cutting by detector forces the first piece to freeze the `shape` token set, which pieces two-to-four then break | **accepted, no change.** Kept as one task |
| 2 | The file says `medium`; the panel was briefed as `hard`, and the label decides review depth | **accepted** — already corrected in the file before this finding arrived; now recorded as confirmed rather than proposed |
| 3 | The design-ref requires each finding to take a disposition, but `PLANNING.md` step 4 documents only the exit branch and the guard count — shipping the tool alone gives a gate nobody is instructed to dispose of | **accepted.** Added as owned deliverable 1 |
| 4 | A frozen suite runs **once**, so on the criteria alone the lint ships with zero regression coverage in the sweep | **accepted.** Added as owned deliverable 2, including raising the `CHECKS >= 40` floor |
| 5 | No undeclared dependencies, no creep, the `dispatch-gate` fence is correct | **no action needed** |
| 6 | Reviewability holds only if fixtures stay small and the negative fixture is visible in the diff | **accepted** as a constraint on the implementer, carried in the criteria preamble |

### Task B1 — testability (5 findings) and the scope pass

| # | Finding | Disposition |
|---|---|---|
| 1 | **`B1.3` is a gate no B1 implementation can fail.** B1 does no corpus I/O, so its four corpus states render identically by construction, and its load-bearing fixture describes a temptation that cannot exist until groups do | **accepted, and this is the most important finding on B1.** It is the `repo-8v0` shape — checks unreachable by any implementation — which cost a whole run once already. The corpus dimension is inverted into a pair that *can* fail: render with and without a runs root and assert byte-identical, catching an implementation that reads `runs/` early |
| 2 | The headline has no pinned literal, so no test can identify the line; and 9/7/8 is only discriminating if the slots are pinned | **accepted.** Template pinned verbatim: `spec concerns: <total> raised by <k> of <n> tasks` |
| 3 | The positional anchor names an endpoint that does not exist for the zero-task fixture | **accepted.** Anchor now has its second branch, and the zero-task text is pinned |
| 4 | No criterion covers a malformed `specConcerns`; `(t.specConcerns \|\| []).length` counts the string `'nope'` as **four** | **accepted.** New criterion B1.2, the run-level twin of a case `repo-iok` already froze at task level |
| 5 | The call shape is not pinned — the preamble declares `renderReport(manifest, corpus)` while B1's scope says no new export surface | **accepted.** B1 ships `renderReport(manifest)` **unchanged**; the parameter is the corpus task's to add |
| S | The corpus parameter in B1 is a half-built interface no B1 code path reads; and the existing one-argument callers number **four**, not three — `repo-5yu` was missed | **accepted**, both. Corrected in the spec |
| S | B1 is small but stands on its own, and should not be absorbed | **accepted, no change.** A container run and a one-screen diff are the right price for the one artifact that would have prevented a 3h11m eight-`stuck` run |

### Task B2 — testability (11) and ambiguity (11), plus the scope pass

**All twenty-two accepted, and together they are why B2 is not freezing today.** Rather
than tabulate twenty-two rows of "accepted, rewritten", the honest summary is that they
partition into three groups:

- **Two changed the design.** The scope critic's finding that B2 is itself two tasks — a
  pure clustering rule and a corpus reader — is accepted and B2 is now B2a/B2b. And the
  testability critic's **UPGMA-vs-WPGMA** finding is the one that could not have been
  caught anywhere else: "average linkage" names two standard algorithms, they agree on
  every merge involving a singleton (so every proposed fixture passes both), and they
  diverge exactly where the measured 18-member group forms. The measurement was UPGMA;
  that is now recorded, along with the stopword list and character class, because the
  container can see none of it.
- **Eleven are pins** — the rendered block, the cross-run join, merge order, the empty
  token set, absent `targetRepo`, the id list's bound, the run-directory predicate, both
  return shapes, the degraded vocabulary, member order within a group, and the comparator.
  They are carried forward as the explicit list a second step-1b pass must resolve.
- **Nine are fixtures**, carried into the draft verbatim — including three that would
  otherwise have produced a suite that passes against the bug it exists to catch: the
  near-degenerate issue-id texts, the portable `ENOTDIR` route to "unreadable", and the
  `Zebra`/`apple` pair for `localeCompare`.

One finding earned a correction to my own work rather than to the spec: the testability
critic re-derived the linkage-pair arithmetic independently in node and **confirmed it
holds**, including that neither fixture separates average linkage from both neighbours
alone. That is the check I would most have wanted a second pair of eyes on, and it is the
only place in this panel where a critic verified a number rather than questioning one.

### Nothing was rejected or deferred

Thirty-two findings, thirty-two accepted. That is unusual enough to be worth stating
plainly rather than presenting as a clean sweep: it reflects that both specs were drafted
against a design amendment written the same morning, which is exactly the condition the
panel exists for. The 9-of-9 rate on the first real backlog is the precedent.
