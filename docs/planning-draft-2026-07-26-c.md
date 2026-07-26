# Planning draft — 2026-07-26 (session C): the model-id defect

One task, found by the run that session B queued. This is the step-5 approval pass —
nothing is frozen yet.

## The defect

`run.config.multiagentpipelines.json` pins `"model": "opus"`. Run
`2026-07-26T16-47-15-326Z` recorded this in both tasks' status files, and therefore in
the manifest, both PR footers, and the run report:

```
model: claude-haiku-4-5-20251001
```

The envelope's `modelUsage` held two keys, in this order:

| Key | outputTokens | costUSD |
|---|---|---|
| `claude-haiku-4-5-20251001` | 15 | 0.002 |
| `claude-opus-5` | 7897 | 0.97 |

Opus did the work. The pin was honoured. Only the **record** is wrong, because
`pipeline/envelope.js:29` takes `Object.keys(modelUsage)[0]` and the CLI lists its cheap
internal helper model first.

This is the third member of a family already in `docs/STATUS.md`: a deterministic
extraction that succeeds vacuously and records something false, with no error anywhere
(defect 2 — model pinning recorded nothing; defect 5 — CLI noise contaminated both
contract artifacts; defect 7 — the memory In channel was unobservable). The rule
promoted into `CLAUDE.md` this morning from `52m-note-4` says exactly this: *when
scaffolding is deliberately fail-safe, something must still assert the artifact is
non-empty* — and here it is non-empty but wrong, which the rule does not yet cover.

**The design doc codifies the bug.** `DESIGN.md` §4.3 says "the first key of its
`modelUsage` is the resolved model id recorded per 4.11", recorded as a deliberate
decision in change-log row v1.8.3. So this task must amend the doc as well as the code,
or the constitution will contradict the implementation.

## Task D — Record the model that actually ran

**Difficulty: medium** (the scope critic explicitly warns against downgrading: the line
count is small, but it touches a contract artifact three host-side consumers read
verbatim and contradicts a live design-doc sentence).

**design-ref:** `DESIGN.md` §4.3 (contract-artifact extraction), §4.11 (the status file).

### Description
Replace the first-key rule with one that names the model that did the work, and amend
the design sentence that mandates the old behaviour.

Selection rule, deterministic, applied in order:

1. If an expected alias is supplied **and non-empty**, and exactly one `modelUsage` key
   matches it — case-insensitive substring, tested against the key **and** against that
   entry's `canonicalModel` — choose that key.
2. Otherwise, if `modelUsage` has exactly one key, choose it.
3. Otherwise choose the key with the greatest `outputTokens`, treating a missing or
   non-numeric value as 0, breaking ties by key name ascending.
4. Otherwise null.

### Constraints
- Deterministic scaffolding only, no LLM (hard rule 7).
- Files in scope: `pipeline/envelope.js`, `pipeline/entrypoint.sh`, and — **the docs
  phase's job, same PR** — the `§4.3` sentence that states the first-key rule, plus one
  change-log row. Nothing under `runner/`, nothing in `pipeline/verify.js`, no schema
  change.
- **Pinned CLI shape:** `node pipeline/envelope.js flatten <file> [expected-alias]`. A
  missing or empty third argument means "no alias". `parse(text)` and
  `parse(text, alias)` are both supported; an empty-string alias behaves exactly as no
  alias. *(Both critics flagged this: the old draft said "the flatten contract is
  unchanged" while also requiring flatten to learn an alias, leaving an unattended agent
  to guess between a positional argument, a flag, and an environment variable.)*
- **`set -u` is on in the entrypoint** (line 14), and `PIPELINE_MODEL` is unset on any
  unpinned run. The pass-through must be written so an unpinned run does not abort.

### Done means
- **D1 — the discriminating case.** A fixture whose `modelUsage` lists, **in this order**,
  a non-matching key with the LARGER `outputTokens` first and the alias-matching key with
  the SMALLER second: `parse(text, 'opus')` returns the opus key, while `parse(text)`
  returns the larger-token key.
  *(This single fixture is the whole point. In the previous draft D1 and D2 shared a
  fixture where rules 1 and 3 happened to agree, so an implementation that ignored the
  alias entirely passed every criterion — and so did today's buggy `keys[0]`.)*
- **D2 — the `canonicalModel` clause.** A fixture whose key name does not contain the
  alias but whose entry's `canonicalModel` does: that key is chosen.
  *(Otherwise this half of rule 1 ships unverified — in D1 the alias is already a
  substring of the key name.)*
- **D3 — no alias, and the empty alias, behave identically.** Both return the
  greatest-`outputTokens` key, on a fixture where the key that must NOT win is listed
  first, and neither emits a diagnostic. The empty string is the production default:
  `${PIPELINE_MODEL:-}` yields `""`, and `""` is a substring of every key.
- **D4 — a single-key envelope** returns that key with a matching alias, a non-matching
  alias, and no alias — and emits **no** diagnostic in any of the three.
- **D5 — missing `outputTokens` counts as 0.** A two-key fixture where neither entry has
  `outputTokens` (the shape the frozen `repo-52m` fixture uses) resolves to the
  ascending-name winner, with the non-winner listed first.
- **D6 — ties** resolve to ascending name, again with the non-winner listed first.
- **D7 — absent data.** An envelope with no `modelUsage` yields model `null`; a log with
  no envelope yields `null` overall.
- **D8 — the flatten CLI.** Prints the chosen model on stdout, rewrites the file to the
  result text, exits 0. An envelope-free file is left byte-identical, prints nothing,
  exits 0. Works with and without the third argument.
- **D9 — the miss diagnostic.** Alias supplied, two or more keys, none matching: a line
  naming the expected alias and the keys actually seen goes to **stderr**, stdout still
  carries the rule-3 choice, exit 0.
- **D10 — backward compatibility, actually executed.** This task's test directory shells
  out to `node tests/acceptance/repo-52m/test.js` and asserts exit 0.
  *(The old draft leaned on `repo-52m` and `scripts/test-entrypoint.sh` to catch a
  regression in one-argument `parse`. Neither runs at the gate: the verifier runs only
  `sh tools/run-acceptance.sh tests/acceptance/<issue-id>/`, this repo declares no
  `regressionCommand`, and `test-entrypoint.sh` needs Docker the container cannot run.
  Safe to shell out — that file is plain Node, not `node --test`, so there is no
  `NODE_TEST_CONTEXT` self-nesting.)*
- **D11 — end to end, pinned.** A full entrypoint run under a stub agent whose log
  carries a two-key envelope, with `PIPELINE_MODEL` set to an alias matching the
  **smaller**-token key, leaves `model` in the status file set to the matching key. Run
  with an explicit minimal environment, a temp `PIPELINE_DIR`, and a stub `verify.js`.
- **D12 — end to end, unpinned and missed.** Two further runs: one with `PIPELINE_MODEL`
  unset, which must still exit 0 (the `set -u` guard) and record the rule-3 key; and one
  whose alias matches nothing, where the diagnostic must appear in the **entrypoint's own
  stderr** — proving the `2>/dev/null` on the flatten call was removed.
  *(Without this, the stderr change is an orphan: no criterion fails if the redirect
  stays, and the diagnostic would be invisible in exactly the case it exists for.)*

### Proposed §4.3 amendment (the docs phase writes this)
Replace "the first key of its `modelUsage` is the resolved model id" with the selection
rule above, and add a change-log row recording **why**: the first key is the CLI's cheap
helper model, so the field named a model that did not do the work from the moment it
shipped.

## Open question

Approve as revised, or adjust the rule? The one judgement call is rule 3's tiebreak —
"greatest `outputTokens`" is a heuristic, and I chose it only as the fallback for when
no alias is available. Rule 1 (match the pin the runner actually requested) is what
carries the design intent, and it cannot drift.

---

# Approved and frozen — 2026-07-26

Approved as revised. Issue **`repo-wxh`**, priority 1, frozen at
`tests/acceptance/repo-wxh/test.js`.

## Step 4 — coverage check

| Criterion | Checks that prove it |
|---|---|
| D1 discriminating case | 2: alias wins over token count; no-alias falls to token count |
| D2 canonicalModel clause | 1: neither key name contains the alias |
| D3 no alias == empty alias | 4: both pick the greatest-token key, neither emits a diagnostic |
| D4 single key | 4: matching alias, non-matching alias, no alias, no diagnostic |
| D5 missing outputTokens | 2: absent entirely, and non-numeric |
| D6 ties | 1: ascending name, non-winner listed first |
| D7 absent data | 2: no modelUsage, no envelope |
| D8 flatten CLI | 6: exit, stdout, rewrite, third-arg optional, byte-identical, silent |
| D9 miss diagnostic | 4: exit 0, stdout choice, alias named, keys named |
| D10 backward compatibility | 1: the frozen repo-52m suite runs and passes |
| D11 end to end, pinned | 2: exit 0, alias-matching key recorded |
| D12 end to end, unpinned and missed | 5: set -u guard, rule-3 key, exit 0, diagnostic on entrypoint stderr, rule-3 key on miss |

No orphan on either side. Every check carries its criterion id.

## Verified red for the right reason

Run in `pipeline-base:local`. 12 of 35 checks fail, every one of them naming behaviour
that does not exist yet. **D10 passes**, so the frozen `repo-52m` suite is a valid
regression baseline rather than a broken one.

The three checks that specifically falsify today's `Object.keys(modelUsage)[0]` — D3, D5
and D6, each with the non-winner deliberately listed first — all fail as they must. So
does D1's alias case, which no earlier draft of these criteria could distinguish from a
plain max-tokens rule.

Some checks pass against the buggy implementation by coincidence (D1's no-alias case,
D12's unpinned case: today's first key happens to be both first AND biggest). That is
expected and harmless — the discriminating checks are the ones listed above, and they are
red.

## Known collision risk, accepted

PRs #10 and #11 are unmerged, and #10 also edits `pipeline/entrypoint.sh` — the prompt
blocks near lines 94 and 148, where this task edits the `MODEL_ARG` block near line 21
and the flatten call near line 129. Different regions, so git will most likely merge them
cleanly, but this is the known "batched tasks collide" gap in `docs/STATUS.md`: every
task forks from the integration branch as the run starts. Worst case is a conflict at
review time, not a failed run.
