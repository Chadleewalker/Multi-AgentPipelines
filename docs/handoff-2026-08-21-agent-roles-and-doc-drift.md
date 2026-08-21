# Handoff — the agent-role census, one parked idea, and the docs catching up to reality

Written 2026-08-21, interactive session, no runs launched. **Nothing is broken and no code
changed.** Two pull requests merged, both documentation. The session started as a question —
*how many agent roles does this pipeline define?* — and the answer turned up two pieces of
drift worth recording: a test-writing role that exists in the diagrams and in practice but
nowhere as a definition, and three documents describing a shipped feature as unbuilt.

The one open item is at the bottom: **the sweep has not been run** since 17 commits of real
code landed on `main` today.

---

## 1. State at a glance

| | Status |
|---|---|
| PR #43 — park the test-author idea, drop a stale critic tier | **merged**, `dcf218e` |
| PR #44 — docs catch up to shipped features, `SETUP.md` Part 0 | **merged**, `b116037` |
| Code changed | **none** — six documents in total |
| Suites run | `test-changelog.sh`, `test-sanitize.sh` only (both green) |
| Full sweep | **not run** — see §6 |
| Beads queue | pulled from the remote mid-session; local was behind |
| Local `main` | current with the remote at `b116037` |

---

## 2. The agent-role census

Nothing in the repo states this in one place, which is why the question was worth asking.
**Five roles run today. Three are files; two are prompts. Two further slots are designed and
unstaffed.**

**Defined as files** — charters in `advisors/`, all slot 1 (planning critic), each run by
pasting the charter into a fresh subagent at `PLANNING.md` step 2:

| Charter | Lens |
|---|---|
| `advisors/ambiguity.md` | Where would two competent engineers build different things? |
| `advisors/testability.md` | Which criteria can a script not verify — or would verify wrongly? |
| `advisors/scope.md` | Is this secretly several tasks, or a fragment that cannot stand alone? |

**Defined as prompts** — both in `pipeline/entrypoint.sh`, both one-shot `claude -p` calls:
the **code agent** (frozen spec, exported memory, prior verifier feedback; two evidence-only
out-channels, `status.js note` and `status.js concern`) and the **docs agent** (runs once
after verify passes; updates in-repo docs and emits the PR body; its failure is non-fatal).

**Designed and unstaffed:** §3.5 slot 2 (domain test author) has zero charters; slot 3
(run-time advisor) has zero charters and needs a build.

**Described in prose only, no charter:** the design-doc interviewer, the doc-level critics,
the decomposer, the criteria drafter (step 1b) and the test author (step 3).

**Not agents, deliberately** (hard rule 7): the runner, the verifier, the report generator.
The one other `claude -p` call in the tree, `runner/pause.js`, is a rate-limit probe.

---

## 3. What the census found: test-writing has no definition

`docs/pipeline-diagram.md` draws two things that read like a test-writing agent, and neither
is a defined role:

- the solid node **"Write acceptance tests before any code exists"** — a step of the
  interactive planning session (`PLANNING.md` step 3), performed by whichever context is in
  the session;
- the dashed amber **`SP2` — "SLOT 2 — domain test author"** — a specialist slot with no
  charter behind it.

The gap that matters is the first. Criteria drafting was pulled out of the primed session into
a fresh-context subagent (§3.2 "Below the panel" move 5, `PLANNING.md` step 1b) on measured
evidence. Test writing sits in the same seat, immediately after, and never got the same
treatment — even though `advisors/README.md` calls slot 2 the strongest slot precisely because
a frozen test steers the retry loop on every attempt while a review is considered once.
Meanwhile `docs/IDEAS.md`'s planning-session ledger entry records test-writer subagents
already being spawned ad hoc: no charter, no fresh-context requirement, no record.

Parked as an inbox entry, **not** promoted: *"Give `PLANNING.md` step 3 a charter and fresh
context, the way step 1b got them."* Its counter-argument is parked with it — a fresh-context
author cannot see the design discussion, and knows least about the harness it is writing tests
for.

---

## 4. A citation error caught on review, and why it is worth recording

The entry's first version cited **shadow-01** as evidence *for* fresh context. That is wrong,
and the error is instructive rather than embarrassing.

`docs/STATUS.md` records shadow-01 as a **mechanical** defect: the acceptance test invoked
`npm test` from inside `node --test`, so `NODE_TEST_CONTEXT` was inherited and the child run
failed as a nested subtest. Fresh context would not have prevented it and plausibly makes it
likelier, since a fresh author knows least about the harness. The citation came from reading
`advisors/testability.md`'s summary of the incident rather than the incident itself — a
second-hand reading that was plausible, well-formed and false, which is the failure class
`CLAUDE.md`'s conventions already name.

The right evidence was already in the repo, in `docs/STATUS.md` under **"What this does not
prove"**: specs drafted by one context that also wrote and reviewed its own criteria, where
*"the panel's value came precisely from being unprimed"*. The entry now cites that, and keeps
shadow-01 on the other side of the argument where it belongs.

---

## 5. The documentation drift, and that `main` was half-corrected

Three documents described the live dashboard's `GET /` as a placeholder awaiting a view. It
shipped on 2026-08-11 as change-log row `live-dashboard-page`.

Worth knowing for next time: **`DESIGN.md` §5 had been half-corrected already.** Its closing
sentence said the page shipped; its opening sentence, four lines above, still called it a
placeholder. A partial fix reads as a finished one, and the half that was missed is the half a
reader meets first.

Also corrected: `README.md` and `SETUP.md` now point at `docs/pipeline-map.built.html` rather
than the source page, which carries its diagrams as un-drawn text and opens from disk as ten
empty frames (change-log row `map-prerender`).

`SETUP.md` gained **Part 0 — what whoever is bringing you in has to supply**: the six things a
newcomer cannot self-serve, each of which fails late and two of which fail quietly.

And one figure was corrected while it was being cited: the sweep runs **39 suites, not 37** —
38 `scripts/test-*.sh` plus `e2e.sh`. Counted from `scripts/test-all.sh:79-81`, which globs,
skips itself, and appends `e2e.sh` last, rather than from a file listing.

---

## 6. Open item: the sweep

`CLAUDE.md` says to run the sweep after merging a batch of PRs. Two merged today, and while
both were documentation, `main` also picked up **17 commits of real code** — `scripts/batch.js`
(new, ~670 lines), `runner/queue.js`, `runner/bd.js`, three new frozen acceptance suites, and
`scripts/test-batch.sh`. None of that has been exercised on this machine.

```bash
bash scripts/test-all.sh     # 39 suites, sequential, ~8-12 min healthy
```

Read the result against a known-good summary rather than against the 2026-08-03 figure. If a
lock is held, do **not** clear it by hand — the parked inbox entry on the sweep lock's missing
liveness check exists because doing exactly that on 2026-08-20 produced 7 red suites whose
signatures were all infrastructure rather than code.

---

## 7. Friction encountered, for whoever hits it next

1. **The pre-push hook blocked the first push**, correctly. It runs `bd dolt push` so the issue
   queue cannot fall behind the code, and the remote's issue data was **ahead** of local.
   `bd dolt pull` fixed it; the local Beads database now includes what another machine had
   pushed, so `bd ready` may read differently than before this session.
2. **The active `gh` account flipped mid-session, twice.** This machine has two GitHub logins,
   and a push to a remote owned by one of them failed with `403 — Permission denied` naming the
   other. A switch does not hold; check `gh auth status` immediately before a push or a run
   against a private target, because on a *private* repository the same mismatch surfaces as
   `Repository not found` instead, which is indistinguishable from a typo.
3. **`git merge` refuses when uncommitted files would be overwritten**, even where the hunks
   would not actually collide — it needs to *checkout* those files, which is enough to stop it.
   Merging in a throwaway clone is a clean way to avoid touching a working tree that holds
   someone else's unfinished edits.
4. **Reordering `docs/IDEAS.md` breaks directional references.** Both sides of a merge added an
   entry at the top of the inbox; resolving it newest-first moved an entry that another entry
   referred to as "above" several places below it. References between inbox entries should name
   the entry, not its position.
5. **`scripts/test-sanitize.sh` caught a denylisted account name in the first draft of this
   document**, in the friction note directly above. The leak came in as *evidence* — naming the
   accounts made the failure concrete — which is exactly the pattern the change-log row
   `publish-sanitize-followup` records: the leaks so far arrived as worked examples, not as
   code. Two things follow. Run the suite before publishing anything, and **stage the file
   first** — the checker reads the *tracked* tree, so an untracked new document passes
   vacuously.

---

## 8. Decisions taken, and by whom

Chad approved each step: parking the idea rather than promoting it; bundling the one-word
diagram fix with it; fixing the citation after review rather than merging as-was; keeping all
four uncommitted documentation edits as one commit on a branch off current `main`; and both
merges. No approval point was routed around, and no run was launched.
