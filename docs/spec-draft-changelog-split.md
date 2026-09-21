# Spec draft — the change log becomes its own append-only file

**Label:** hard. **design-ref:** DESIGN.md §12 (and CLAUDE.md, "Changing the design").
**Reasoning and evidence:** `docs/planning-draft-2026-08-26-doc-contention.md`.
**Revision 2** — rewritten against the three-critic panel; dispositions in §7 below.

## 1. Description

Move the change-log rows out of `DESIGN.md` §12 into `docs/change-log.md`, and mark that
file — and only that file — `merge=union` in the repo-root `.gitattributes`, so that N task
branches each appending a row merge without conflict.

Every one of the four PRs merged on 2026-08-25/26 needed a hand-resolved conflict, and three
of the four were resolved identically: keep both change-log rows. With N branches open the
first merges free and the other N−1 need a person, for an answer that is always the same.
`DESIGN.md` conflicted 4 times out of 4.

Union merge keeps both sides instead of conflicting, which is right for an append-only table.
It applies per file, and `DESIGN.md` contains prose that is genuinely edited in place — so
pointing it at `DESIGN.md` would silently duplicate amended paragraphs. Hence the extraction.
`DESIGN.md` §12 stays, holding what it uniquely provides: what a row is, the slug identity
convention, the chronological rule, the citation form, and a pointer to the new file.

The precondition union merge needs is already a written rule here — rows are appended and
"never renumber a row you did not write" — and its one failure mode (two branches editing the
same row, both copies silently kept) surfaces as a duplicate slug, which
`tests/unit/changelog.test.js` already fails on.

## 2. Prerequisite, done in the planning session and NOT by this task

`tests/acceptance/repo-006/test.js` is a frozen acceptance suite that reads `DESIGN.md` and
parses `## 12. Change Log` out of it (`:21`, `:47`, `:177`). The move turns it red, and the
implementing task **must not** repair it: `tests/acceptance/` is diffed against the fork
point, so any edit there ends the task `tampered` on every attempt, and
`scripts/verify-pr.sh` (`:111`, `:127`) runs every sibling suite and would blame this branch.

**The freeze commit must contain that amendment.** Precedent: change-log row
`publish-sanitize-followup` amended this same file after its task closed and recorded why.

*Instruction to the implementing agent:* if you observe `tests/acceptance/repo-006/test.js`
still reading `DESIGN.md` for its change-log rows, **do not edit it** — that is a spec defect.
Raise it with `node /pipeline/status.js concern "..."` and continue with the rest of the task.

## 3. Constraints

- **This task adds NO change-log row of its own.** `CLAUDE.md`'s "Changing the design" and
  `PLANNING.md` both say every design amendment gets one, and every recent task has shipped
  one — so this constraint is a deliberate exception to the house rule, and criterion 1 fails
  if you add a row. The planning session adds this task's row after the freeze, the way
  `publish-sanitize-followup` did.
- **`docs/change-log.md` begins with exactly this line**, and nothing above it:
  `# Change Log`
  followed by a blank line, the preamble sentence of your choosing, a blank line, then the
  table header verbatim:
  `| Date | Ref | What changed | Why |`
  `|---|---|---|---|`
  The header and separator **move**; they do not stay in `DESIGN.md` and are not duplicated.
- **Move the row lines byte-for-byte.** One row carries `done|partial|failed|stuck` inside a
  code span and therefore has 7 pipes where every other row has 5; the checker masks backtick
  spans before splitting cells. Any reflow, prettifier or regex rewrite corrupts that row.
- **The `merge=union` rule goes in the repo-root `.gitattributes`**, not `docs/.gitattributes`,
  and carries a comment saying *why* it is safe: only because rows are appended and never
  edited, which is why it must never be pointed at `DESIGN.md`.
- **Do not edit anything under `tests/acceptance/`.** It is frozen (§4.4). The `repo-006`
  suite has already been amended in the freeze commit.
- **Do not edit any path listed in `pipeline.config.json`'s `frozenPaths`.**
- `DESIGN.md` §12 keeps its heading and preamble — the slug convention, the
  chronological-ascending rule and the citation form — and gains the pointer. Only the rows,
  the table header and the separator move.
- The checker keeps its `CHANGELOG_FILE` seam working; it is the only way its negative cases
  can be driven.
- **The checker must keep accepting `## 12. Change Log` as a section heading as well as the
  new file's `# Change Log`.** The frozen `tests/acceptance/repo-006/test.js` writes its
  negative-case fixtures with the old heading (`:193`) and drives the checker over them
  through `CHANGELOG_FILE`; an anchor that accepts only the new form turns that frozen
  sibling suite red, and you may not edit it. An anchor of the shape
  `/^#{1,2}\s*(?:12\.\s*)?Change Log\s*$/` satisfies both — verified in a simulation of this
  task before the freeze.

## 4. Acceptance criteria — "Done means"

1. **[criterion] `docs/change-log.md` holds every row; `DESIGN.md` holds none.**
   Extract rows (`^\|\s*20\d\d-`) from the fork-point `DESIGN.md` and from the working-tree
   `docs/change-log.md` with the masked-pipe splitter, and assert the two ordered lists of
   `(Date, Ref, What, Why)` tuples are identical, and that the working-tree `DESIGN.md`
   contains zero such lines.
   **The fork-point read must be pinned before comparing**: assert the `git show` exited 0
   *and* that it yielded **at least 80 rows**, then compare. Two empty lists are identical,
   so without that floor the criterion passes having compared nothing — which is also its
   permanent state once this branch merges, since `scripts/verify-pr.sh` re-runs sibling
   suites on later branches whose fork point already has no rows.
   *Red before:* `docs/change-log.md` does not exist and `DESIGN.md` holds 84 rows.

2. **[criterion] `merge=union` resolves for `docs/change-log.md` and for no other tracked
   file.** Ask git, never grep the file — that also proves the pattern matches the path:
   `git -c core.attributesFile=/dev/null check-attr merge -- docs/change-log.md` prints
   `merge: union`; and `git ls-files -z | git -c core.attributesFile=/dev/null check-attr
   --stdin -z merge` names no other path with `merge: union`. Assert `.git/info/attributes`
   is absent or empty first, since it cannot be suppressed and would otherwise decide the
   answer per machine.
   *Red before:* it returns `unspecified`.

3. **[criterion] Two branches that each append a row to `docs/change-log.md` merge with
   `git merge` exiting 0, and both rows survive.** Build a throwaway repo under the OS temp
   dir, copy in the repo-root `.gitattributes` bytes and `docs/change-log.md`, branch twice
   appending a distinct row on each, merge, assert exit 0 and both refs present.
   **The fixture supplies its own git identity and config and inherits none** —
   `GIT_AUTHOR_NAME/EMAIL`, `GIT_COMMITTER_NAME/EMAIL`, `GIT_CONFIG_NOSYSTEM=1`, and explicit
   `-c init.defaultBranch=…`, `-c commit.gpgsign=false`, `-c core.autocrlf=false`,
   `-c core.eol=lf`, following `tests/unit/dispatch-gate.test.js:83`. Without this the test
   passes on a developer host and **fails in the container**: `pipeline/entrypoint.sh:57`
   sets the identity repo-locally in `/workspace`, not globally, and the base image sets none,
   so `git commit` under `/tmp` exits "Author identity unknown".
   *Red before:* the fixture cannot be built; and with the file but no attribute the merge
   conflicts — verified.
   **This is the criterion the task exists for.**

4. **[guard] The checker reads the new file by default and keeps every check.**
   `node tests/unit/changelog.test.js`, spawned with `CHANGELOG_FILE` **explicitly deleted
   from the child environment**, exits 0 and its output contains **all eleven**
   citation-gated check lines: one `<doc> cites no change-log version` and one
   `<doc>: every cited slug resolves to a row` for each of `docs/STATUS.md`, `CLAUDE.md`,
   `PLANNING.md`, `ONBOARDING.md`, `README.md`, plus the pinned-citation-form line.
   *Why the named lines and not a count:* `IS_REAL_DESIGN` (`:28`) gates those eleven checks
   by comparing `FILE` against `DEFAULT_FILE`. An edit that moves one but not the other
   **silently disables all eleven** and still exits 0 — non-empty, well-formed and false. A
   raw count cannot distinguish that from a legitimate change; the named lines can.
   *Red before:* the checker anchors on `/^##\s*12\.\s*Change Log/` in `DESIGN.md` and exits 1
   once the table moves.

5. **[guard] The `CHANGELOG_FILE` seam still discriminates.** Pointed at fixtures the
   test writes at runtime under the OS temp dir — using the heading pinned in §3 — the checker
   exits 1 on a duplicate ref and on a row whose what-changed cell begins with a version
   token, and exits 0 on a well-formed fixture.

6. **[criterion] `DESIGN.md` §12 survives the move.** It still contains a `## 12.` change-log
   heading; its section text still carries the slug convention and the
   chronological-ascending rule; and it contains the literal string `docs/change-log.md`.
   *Why:* without this, an implementation that **deletes §12 outright** — heading, preamble,
   convention and all — passes every other criterion. That is an obviously wrong
   implementation the gate would not see.
   *Red before:* §12 contains no such pointer today.

7. **[criterion] The four documents that state where the change log lives name the new
   location.** The literal string `docs/change-log.md` appears in: `CLAUDE.md`'s
   read-these-first table; `CLAUDE.md`'s "Changing the design" section; `README.md`'s Layout
   table row for `DESIGN.md`; `docs/STATUS.md`'s suite-table row for `test-changelog.sh`; and
   in `PLANNING.md` within the `## Spec Changes After Freeze` section.
   *Red before:* all five name `DESIGN.md` §12 today.

8. **[guard] Every pinned citation still resolves.** Every `` change-log row `slug` `` in the
   five living documents resolves to a ref in `docs/change-log.md`.
   True today and here so the move cannot break it. Criteria 1, 2, 3, 6 and 7 carry the
   freeze gate; 4, 5 and 8 are guards, all three green at the fork point and required to stay
   green — relabelled after the gate run showed 4 and 5 passing there.

## 5. Known, accepted, out of scope

- **Union merge does not preserve chronological order.** It concatenates ours-then-theirs, so
  two branches appending out of date order merge clean and land out of order, which §12's own
  "chronological ascending" rule then quietly violates with nothing red — the checker enforces
  uniqueness, not ordering. Criterion 3 is deliberately scoped to what the mechanism actually
  guarantees (exit 0, both rows present). Ordering stays a human convention.
- **`.gitattributes` is read from the branch being merged into**, so task branches that forked
  *before* this lands do not get union merge when main is merged into them. The first batch
  after this ships still conflicts.
- **GitHub's server-side merge button is not proven to honour `merge=union`.** Not
  script-checkable, so deliberately not a criterion. If the button still reports a conflict,
  the fallback is the workflow already in use — merge main into the branch locally, where
  union does apply (verified), and push. Worth one real check on the first PR after this lands.
- `scripts/trace.js` scans all tracked `*.md`, so the new file enters its corpus.
  Net-neutral; worth a `node scripts/trace.js report` afterwards rather than a criterion.

## 6. Panel dispositions

Three critics, all `concerns`. 24 findings.

| # | Finding | Disposition |
|---|---|---|
| 1 | **All three:** criterion 4's "at least 21 PASS lines" is unreachable — the checker emits **19**; 21 is the wrapper's total (and matches a stale `docs/STATUS.md` line) | **accepted.** Count removed entirely. Criterion 4 now names the eleven citation-gated check lines, which discriminates the `IS_REAL_DESIGN` silent-disable that the count was a proxy for |
| 2 | **Scope + testability:** criterion 1 forbids the change-log row that `CLAUDE.md` orders every agent to add — an agent obeying the house rule fails all three attempts, and the cheap route to green is deleting its own row (shadow-01's exact shape) | **accepted.** Now an explicit Constraint in words the agent reads, with the precedent cited and who adds the row instead |
| 3 | **Testability:** criterion 3 fails in the container — no git identity outside `/workspace`; passes on a developer host | **accepted.** Verified `pipeline/entrypoint.sh:57` and the base image. Criterion 3 now requires the fixture to supply its own identity and config, per `dispatch-gate.test.js:83` |
| 4 | **All three:** the new file's heading is load-bearing in three frozen places and never pinned | **accepted.** `# Change Log` pinned verbatim in Constraints, with the table header and separator |
| 5 | **Testability:** criterion 1 passes vacuously on two empty lists — and is permanently in that state after merge, via `verify-pr.sh`'s sibling loop | **accepted.** Fork-point read must exit 0 and yield ≥ 80 rows before comparing |
| 6 | **Testability:** an implementation deleting §12 outright passes every criterion | **accepted.** New criterion 6 |
| 7 | **Ambiguity:** the table header and separator rows match neither "row" nor the regex — stay, move, or duplicate? | **accepted.** Constraint says they move |
| 8 | **Scope:** `README.md` missing from the location-update list; its Layout table says `DESIGN.md` carries the change log | **accepted.** Added to criterion 7 |
| 9 | **Ambiguity + testability:** `PLANNING.md` has no section called "docs phase" | **accepted.** Criterion 7 names `## Spec Changes After Freeze` and the literal string |
| 10 | **Ambiguity + scope:** the draft's requirement that `.gitattributes` carry a *why* comment was dropped | **accepted.** Restored as a Constraint |
| 11 | **Ambiguity + testability:** the §12 pointer was unpinned and unchecked | **accepted.** Criterion 6 |
| 12 | **Testability:** criteria 2 and 3 disagree on where `.gitattributes` lives | **accepted.** Constraint pins repo-root |
| 13 | **Testability:** `check-attr` is decided by ambient `core.attributesFile` / `.git/info/attributes`; `$(git ls-files)` word-splits | **accepted.** Criterion 2 now pins both and uses `ls-files -z \| check-attr --stdin -z` |
| 14 | **Testability:** criterion 4 assumes `CHANGELOG_FILE` unset while criterion 5 sets it in the same file | **accepted.** Criterion 4 deletes it from the child env explicitly |
| 15 | **Testability:** criterion 6 was half guard, half red — breaks the gate's guard count | **accepted.** Split into criterion 7 and guard 8 |
| 16 | **Ambiguity:** `git show <merge-base>:DESIGN.md` — which ref, by what name, in a container with no local `main` | **accepted.** Criterion 1 says "fork-point"; the test resolves it the way the repo already does rather than hard-coding a branch name |
| 17 | **Ambiguity:** should the new `.gitattributes` line carry `text eol=lf`? | **rejected.** 1b verified index blobs are already LF under this host's `core.autocrlf=true`, and that both the CRLF-worktree and missing-final-newline cases merge clean. Adding it would be harmless but is not the mechanism, and pinning an unnecessary attribute invites a later reader to think it is load-bearing |
| 18 | **Scope:** criterion 5 narrows the draft's "malformed row, bad slug, dangling citation" to two cases | **accepted as stated.** The narrowing matches what the `CHANGELOG_FILE` seam actually exercises; now explicit rather than inferred |
| 19 | **Scope:** union does not preserve chronological order, which the Description implies | **accepted.** Moved to §5 |
| 20 | **Ambiguity + testability:** the prerequisite says `repo-006` "has already been amended" — it has not yet | **accepted.** §2 now states the freeze commit must contain it, and tells the agent to raise a concern rather than edit it |
| 21 | **Scope:** no split; seven files, one concern, one PR; `hard` is right | **accepted, no change.** |

Remaining findings were duplicates of the above across critics.
