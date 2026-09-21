# Integrate completed-unproven re-author recovery

Difficulty: hard.

## Intent

Complete the already-approved repo-djf.17 recovery workflow on current main without
discarding the later partial-author and retained-proof recovery protections. A person can
explicitly re-author a completed, unproven, unpublished acceptance draft through the
pipeline, preserving its prior evidence before a new author receives write access.

Current main rejects the re-author command. Open PR 128 at
2bfdeca919f87af65fb8bf698428e8e7a41385e5 contains an earlier implementation, but it has
product conflicts with main. Its product commit
796bb648779c133cbc8c0c5b8ec0b70a75dce40e is a reference, not a merge prerequisite.
Independent inspection also found that its historical-attempt scan accepts an old
unproven attempt even after newer success, and archive reuse checks identity without
checking current content. Importing those files would remove later recovery protections.

## Constraints

- Implement through the pipeline against the pinned current integration fork. No manual
  product cherry-pick, conflict edit, old-PR merge, or synthetic brief state is required.
- Preserve frozen acceptance and policy files. New acceptance supplements the existing
  repo-djf.17 suite rather than changing its immutable assertions.
- Preserve canonical ownership, admission, prerequisite, design-provenance, criteria,
  interrupted-author, usage-limit and retained-proof policies. Re-author is an explicit
  human recovery action, not an automatic retry or an approval to freeze tests.
- Archive only the selected issue's evidence under host-owned preparation state outside
  the target and model-editable worktree. Do not delete historical archives or unrelated
  suites, enumerate shared parents for cleanup, or widen author access.
- Use deterministic local fixtures; provider execution may be substituted. Mandatory
  regressions remain a separate validation stage.

## Done means

1. `prepare-batch re-author <batch> <issue>` accepts exactly one issue from the immutable
   batch and reuses its unpublished issue worktree. The brief retains its real freeze
   state; the ordinary worker and author entry points accept an explicit, authorized
   re-author transition rather than pretending the suite does not exist.
2. Current recorded evidence, not any historical failure, decides eligibility. The latest
   applicable attempt must be a completed author-proof attempt with terminal outcome
   unproven. Missing, unresolved, interrupted, incomplete, usage-limited, proof-only,
   proven, or frozen evidence cannot qualify. An older unproven generation followed by
   newer proven evidence refuses before archive creation, suite mutation or launch.
   A newer attempt for the same canonical target and issue cannot be bypassed merely by
   naming an older batch.
   Within a batch, the immutable generation order is authoritative even after clock
   rollback. Compare each batch's latest generation across batches by its recorded start
   instant; missing, tied or internally contradictory chronology that prevents a unique
   latest selection refuses rather than using directory order or unrelated generation
   numbers. This stricter recovery decision need not change ordinary status readers.
3. Before author write access, the host durably archives the exact current suite bytes,
   selected immutable result and relevant diagnostics outside the target/model-editable
   tree. Archive identity binds the selected attempt. Existing archive reuse verifies
   content against the current evidence; changed, missing, corrupted or unsafe contents
   cannot authorize launch. Archive failure starts no worker and preserves original
   evidence and suite bytes.
   Use the existing preparation root when it is outside the target and author worktree;
   otherwise place archives in a canonical-target partition under
   `<durable-user-state>/preparation-archives`, using the existing `PIPELINE_STATE_DIR`
   or user-home `.multi-agent-pipelines` root convention. Keep existing batch records in
   place; do not require a batch migration. An unsafe external archive root refuses.
   Required diagnostics are the complete selected start/result records and their inline
   evidence, plus files explicitly named by `result.data.diagnostics` (one path or an
   array of paths), resolved against the issue worktree. Referenced diagnostic files must
   be regular non-linked files inside that worktree; missing, unsafe or unreadable files
   refuse before launch. Probe paths remain recorded references, not permission to copy
   whole probe trees or arbitrary paths found in prose. Preserve the existing secret
   redaction policy for diagnostic records. Archive copying is bounded to 4096 files and
   64 MiB total; exceeding either bound refuses without altering the source evidence.
4. One successful request launches exactly one ordinary author-proof worker; runWorker
   alone records its PID-bearing generation. The operation requires no new batch,
   additional worktree, manual suite deletion or integration-checkout edit. Recovery
   evidence remains durable and attributable to the selected prior attempt.
5. Existing admission, ownership, live-worker, config, design-provenance, criteria-fingerprint
   and frozen/published-state refusals remain effective. The re-author decision cannot
   restore a runnable action after another gate disqualifies the issue. Tests plant each
   relevant prior refusal and demonstrate no archive, mutation, or launch occurs.
6. Current acknowledged partial-author retry, validated retained-proof retry, usage-limit
   resume, author containment, terminal-result validation and human freeze approval stay
   intact. Deterministic tests cover success, latest-attempt supersession across generations
   and batches, stale archive reuse, archive failure and refusal preservation. The unchanged
   repo-djf.17, repo-djf.42 and repo-djf.50 suites, applicable compatibility guards, and the
   mandatory regression profile remain covered and pass on the candidate.

## Provenance and review

Criteria were drafted in fresh context against current source, the frozen repo-djf.17
contract and the historical reference candidate. DESIGN.md section 3.2 and the current
control-plane guide's author-evidence and retained-proof sections supply the design
context. The draft distinguishes incomplete implementation from obsolete historical
assertions; it does not declare the old PR merged or safe to merge.

Mechanical pre-check: `spec-lint` is clean. Full independent fresh-context panel:

- Scope: no findings; this is one hard recovery workflow rather than independent features.
- Testability: no findings; local seams can discriminate the missing command and the
  historical candidate's latest-attempt and stale-archive defects. Mandatory regressions
  run separately from the new acceptance suite.
- Ambiguity A1 — accepted: criterion 2 now states generation order within a batch and
  strict start-instant ordering across batches, with uncertain ordering refused.
- Ambiguity A2 — accepted: criterion 3 now specifies an external durable archive fallback
  for self-hosted preparation without moving or recreating existing batch history.
- Ambiguity A3 — accepted: criterion 3 enumerates preserved records, inline evidence and
  explicitly referenced diagnostic files, distinguishes probe references from file-copy
  authority, and specifies missing/unsafe-file refusal and bounded copying.

This document does not approve an acceptance suite, claim proof, or authorize a PR merge.
