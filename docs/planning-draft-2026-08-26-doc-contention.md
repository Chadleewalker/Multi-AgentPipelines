# Planning draft — the shared-document contention tax (2026-08-26)

**For approval.** The "Done means" lists in §6 are what need a yes; everything above them is
the reasoning that produced them.

**Goal this serves:** N agent sessions working tasks at once, freezing them, and running them
whenever they are ready. Worktrees (change-log row `parallel-sessions`) made the *working
folders* independent. This is about the thing they still collide over: a handful of shared
documents that every task edits by design.

---

## 1. The observation

Four PRs merged on 2026-08-25/26 (#47, #49, #50, #51). **Every one needed a manual
merge-of-main and a hand-resolved conflict**, and three of the four were resolved by making
the identical edit: keep both change-log rows, in date order.

That is not bad luck. It is structural:

| File | Touched by how many of the last 5 merged task PRs |
|---|---|
| `DESIGN.md` | **5 of 5** |
| `docs/STATUS.md` | **5 of 5** |
| `PLANNING.md` | 4 of 5 |
| `docs/pipeline-diagram.md` | 4 of 5 |
| `CLAUDE.md` | 3 of 5 |

A task's docs phase is *supposed* to touch these — that is what keeps the design honest. The
cost only appears in parallel: with N branches open, the first merges free and the other
N−1 need a human. Today that was three in a row, all resolved identically.

Which of them actually conflicted, across today's four merges:

- `DESIGN.md` — **4 of 4.** Always the §12 change-log table, always two branches appending a
  row at the same line.
- `docs/STATUS.md` — **2 of 4.** The `_Last updated:` line, and the hand-maintained
  "All but *N* drive real Docker" count.
- `PLANNING.md`, `CLAUDE.md`, `docs/pipeline-diagram.md` — **0 of 4.** They auto-merged,
  because the edits landed in different regions. They are the *next* contention point, not
  this one.

So the tax is concentrated in two places, and one of them is most of it.

## 2. Why the obvious fixes are wrong

**"Just merge more carefully."** The resolution is mechanical and identical every time —
keep both rows. Work that is always the same answer should not need a person.

**"Serialise the merges."** That is what we did by hand. It does not remove the work, and it
converts a parallelism win back into a queue, which is the opposite of the goal.

**"Mark `DESIGN.md` as `merge=union`."** Union merge keeps both sides instead of
conflicting, which is exactly right for an append-only table. **But it applies to a whole
file**, and `DESIGN.md` is full of prose that is genuinely *edited* in place — §3.2, §4.11
and §4.12 have all been amended. Verified behaviour: when two branches edit the same
existing line, union merge keeps **both versions, silently**. Applied to `DESIGN.md` that
turns every concurrent amendment into a duplicated paragraph nobody is told about. This is
the option that looks cheapest and is the most dangerous.

## 3. What is actually proposed

Union merge is the right mechanism. It can only be pointed at a file that is *purely
append-only*. So make one.

**Move the §12 table into `docs/change-log.md` and mark that file — and only that file —
`merge=union`.**

The table already satisfies the precondition, and not by accident. `CLAUDE.md` and §12 both
say it: rows are appended at the bottom, and **"never renumber a row you did not write."**
The invariant that makes union merge safe is already a stated rule of this repo.

And the one way it can still go wrong is already policed. If two branches *do* edit the same
row, union keeps both — and both carry the same slug, which
`tests/unit/changelog.test.js` already fails on ("refs are unique across the log"). The
mechanism's failure mode and the existing checker line up exactly; no new guard is needed
for it.

Verified on a throwaway repository before proposing it:

| Case | Behaviour |
|---|---|
| Two branches each append a row | Merges clean, both rows kept, order preserved |
| Two branches edit the same existing row | Merges clean, keeps **both** — caught by the uniqueness check |
| Identical row appended on both | De-duplicates to one |

`DESIGN.md` §12 stays, shortened to what it uniquely provides: what a row is, the slug
identity convention, the citation form, and a pointer. The rows themselves move. Every
existing citation (`change-log row \`slug\``) keeps working untouched — the checker already
has a `CHANGELOG_FILE` seam and needs its default re-pointed, nothing more.

**What this does not do:** it does not touch `PLANNING.md`, `CLAUDE.md` or
`docs/pipeline-diagram.md`. Those did not conflict. Speculative work on them would be
paying for a problem that has not happened.

## 4. The second, smaller half — `docs/STATUS.md`

Two lines caused both STATUS conflicts, and **neither carries information worth a conflict**:

- **`_Last updated: <date>`** at the top. Git already knows when the file changed, to the
  second, per line. Every task rewrites this line, so every task collides on it. Delete it.
- **"All but *N* drive real Docker…"** followed by a hand-listed set of suite names. This one
  is worse than contention: it was **already wrong** when found on 2026-08-25 — it read
  "All but eighteen" when there were nineteen, because `test-feed.sh` shipped and nobody
  updated the prose. A hand-maintained count of a globbed set drifts silently by
  construction, and union merge cannot help because the line is *edited*, not appended.

The fix is to stop hand-maintaining a derivable number. The suites are already discovered by
glob (`scripts/test-*.sh`) and the Docker-free ones are already distinguishable. Have the
existing sweep tooling report the count, and let STATUS point at it rather than restate it.

This half is **sequenced after** the first and is worth less. If only one of the two gets
built, build the first.

## 5. What this is not

This does not make N-parallel work by itself. Two other things stand between here and the
goal, both already understood and neither in scope here:

- **The dispatch gate serialises freeze → merge → run** (§4.12). A spec frozen on an
  unmerged branch is invisible to a run. Feeding (change-log row `live-queue-feed`) already
  softens this — push the branch and a live run picks it up at the next free worker.
- **Two tasks editing the same source file still collide at merge**, which §7 already names
  as a planning-time caution. Nothing here changes that, and it gets harder at high N, not
  easier.

Naming them so the draft is not read as claiming more than it does.

---

## 6. Done means — the lists that need approval

### Spec A — the change log becomes its own append-only file

1. The §12 rows live in `docs/change-log.md`; `DESIGN.md` §12 keeps the conventions and
   points at it.
2. `.gitattributes` marks `docs/change-log.md` as `merge=union`, and says in a comment why —
   including that it is safe *only* because rows are append-only and never edited.
3. Two branches that each append a row merge with **no conflict**, and both rows survive in
   order.
4. Every existing `change-log row \`slug\`` citation in the living documents still resolves.
5. `scripts/test-changelog.sh` checks the new location and still fails on: a malformed row, a
   bad slug, a **duplicate slug** (which is now also how an illegally edited row shows up),
   and a citation naming a row that does not exist.
6. The instructions agents actually follow — `CLAUDE.md`'s "Changing the design" and
   `PLANNING.md`'s docs phase — name the new file, so no future task appends to the old place.
7. No row's text changes in the move. The set of rows before and after is identical.

### Spec B — `docs/STATUS.md` stops carrying two contended, derivable lines

1. `_Last updated:` is gone from `docs/STATUS.md`.
2. The Docker-free suite count is no longer hand-written prose in `docs/STATUS.md` — it is
   either derived by tooling or replaced by a pointer, and it cannot silently disagree with
   the suites that actually exist.
3. A new `scripts/test-*.sh` that needs no Docker does not require anyone to edit a number in
   two documents for the repo to stay truthful.

---

## 7. Recommendation

**Approve Spec A and freeze it; hold Spec B until A has been through a run.** A is most of
the tax, its mechanism is verified, and its one failure mode is already policed by an
existing check. B is real but smaller, and it is easier to specify well once A has shown
whether moving a table out of `DESIGN.md` reads as well as it argues.

Both are Docker-free, need no network, and touch no verifier — good pipeline tasks rather
than interactive work.
