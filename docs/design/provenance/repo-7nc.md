# Complete acceptance-author containment on current main

Difficulty: hard.

## Intent and evidence

Complete the already-approved Idea conveyor containment work against the current
integration branch through the pipeline. Preserve the ownership, lifetime, construction
rollback, and refusal behavior specified by repo-djf.40, repo-djf.43, and repo-djf.44.
Also close the reporting gap where unsuccessful provider outcomes discard simultaneous
cleanup failure evidence.

PR 153 at 71f6b81163ff235a8191db394b2ee67c1ceedf2d contains the earlier containment
implementation. Its product commit 8907f8d502622f10242490209c2992c36a048011 is supporting
implementation evidence, not a required integration base. The current main fork lacks
that implementation. The earlier product commits are sibling implementations; blindly
stacking them is not the intended integration strategy.

Independent exact-head review found that launchAuthor attaches containmentCleanup, but
authorIssue returns provider-failed, usage-limit, and incomplete outcomes before reading
it. A mocked read-only reproduction confirmed lost cleanup diagnostics on provider
failure. Existing repo-djf.40 reporting intent covers this condition, but its tests do not
assert the diagnostic on these paths. The complete PR also conflicts with current main
in docs/control-plane.md; import neither its old documentation nor its whole tree over
newer work.

## Constraints

- Implement and publish through the pipeline; no manual product cherry-pick or PR merge
  is a prerequisite. Merging remains subject to separate human approval.
- Preserve all existing frozen suites and policy files byte-for-byte. Do not weaken a
  verifier or regression command to pass this task.
- Keep containment ownership and cleanup local to the launch. Do not widen filesystem
  authority, enumerate shared parents, or introduce cleanup sweeps.
- Keep diagnostics within the existing bounded role-only disclosure contract. Primary
  provider output handling is separate and unchanged.
- Preserve current author-generation evidence, explicit recovery, provider selection,
  rate-limit parking, and preparation behavior outside this change.
- The historical repo-7a0 post-return persistence requirement conflicts with the approved
  repo-djf.40 disposal requirement. Selection and activation of its explicit supersession
  belong exclusively to repo-djf.48. Do not silently skip it or demand both incompatible
  post-return states. If a publication gate selects that historical suite, applicable
  supersession must be activated before publication, not waived by this task.
- Use deterministic local fixtures. No credentials, live provider, network service, or
  nested Docker are required by the acceptance suite. Mandatory regression validation
  remains a separate pipeline stage.

## Done means

1. Each Codex author launch owns fresh containment roots and records every created
   fallback candidate in a host-owned handle with per-launch ownership evidence. The
   handle never enters the prompt or child environment. Disposal removes only recorded,
   validated roots, attempts all roots despite an individual failure, is idempotent, and
   leaves shared parents, sibling launches, foreign roots, and substituted symlinks or
   reparse points untouched. Preserve the repo-djf.40 ownership/disposal behavior.
2. Every created candidate is registered before ownership initialization can fail.
   Thrown self-test errors, marker-write faults, and shim-write faults trigger exact-root
   rollback. A self-test returning false instead denotes an unusable filesystem: retain
   that registered candidate for eventual disposal and permit fallback, as repo-djf.40
   requires. After a thrown or initialization fault, another candidate may be tried only
   after required rollback succeeds. Any refused or failed
   rollback makes preparation fail, preserves the primary construction error with
   additive bounded role-only rollback evidence, attempts cleanup of other owned roots,
   and prevents provider launch. Preserve the repo-djf.43 and repo-djf.44 behavior.
3. Containment remains usable throughout the Codex provider invocation and is disposed
   exactly once after settlement or throw. Preserve provider status, output, error/cause,
   and existing launch evidence, adding cleanup evidence without replacing them. Frozen
   or nonextensible thrown errors retain their original message and primary cause.
   Existing Codex invocation arguments and Claude launch behavior remain unchanged.
   Exception evidence must survive the public consumer boundary, not merely exist on an
   internal launch error: authorIssue preserves the thrown primary exception while
   reporting failed cleanup, and the batch worker's terminal exception envelope retains
   its existing invalid outcome and primary error message with additive cleanup evidence
   and a bounded cleanup diagnostic. Do not serialize arbitrary exception causes into
   new public fields; in-process cause preservation and durable cleanup evidence are
   separate requirements.
4. Failed cleanup remains explicit in diagnostics and additive structured result evidence
   for provider failure, canonical usage-limit, incomplete provider completion, and
   successful provider completion. Unsuccessful primary outcomes, statuses, errors,
   provider/model identity, and usage-limit reset/evidence remain authoritative; cleanup
   does not change parking or retry timing. Completed-provider cleanup failure retains
   the distinct cleanup-failure outcome. Preserve a simultaneous post-launch boundary
   failure as primary. These failing invocations start no proof and print no freeze command;
   successful completion with successful cleanup continues to proof normally.
   This restriction describes the failing invocation, not a new durable recovery state:
   retain the failed cleanup evidence for human review and do not alter author-evidence
   classification or invent automatic cleanup recovery in this task.
5. Cleanup and rollback diagnostics obey the established bounded disclosure contract:
   failed roles are visible, but host paths, ownership nonce, OS error text, credentials,
   and copied provider output are absent. Deterministic acceptance checks cover
   construction/disposal faults and provider-outcome by cleanup-result combinations,
   including canonical usage-limit reset identity and launch exceptions. Existing frozen
   suites remain byte-identical.
   The reporting matrix must discriminate against the reference containment implementation
   itself, not fail only because current main lacks its ownership APIs. A batch-envelope
   fixture must exercise exception serialization through the real worker consumer.
6. The consolidated candidate preserves current author-evidence, recovery, and preparation
   behavior outside this task, reconciles architecture and operator documentation with
   the resulting implementation, and appends a new change-log entry. The unchanged
   repo-djf.40, repo-djf.43, and repo-djf.44 behavioral suites, the new suite, applicable
   compatibility guards, and the authorized publication profile pass on the candidate.
   Historical-suite activation follows the separate constraint above, never an implicit
   exception to a selected gate.

## Provenance and review

The criteria were drafted in fresh context against current main and the exact reference
candidate. Canonical design publication should reference this document and DESIGN.md
section 3.2; candidate-only prose must not be represented as already present on main.
The full independent critic panel completed. Findings have these dispositions:

- Testability 1 and ambiguity 1 accepted: distinguish false usability results from thrown
  self-test faults, preserving the existing frozen fallback lifecycle.
- Testability 2 and ambiguity 2 accepted: require cleanup reporting and structured evidence
  at the real batch exception envelope, preserving its existing primary invalid outcome.
- Testability 3 accepted: isolate the reporting matrix against the prior implementation
  and verify exact usage-limit identity as well as no proof/freeze on failing invocations.
- Testability 4 accepted: preserve frozen files and record the selected publication profile
  and any supersession prerequisite before publication.
- Ambiguity 3 accepted with explicit bounded scope: no-freeze applies to the failing
  invocation; durable cleanup recovery and author-evidence policy changes are not added.
- Scope 1 accepted: hard difficulty, one bounded containment lifecycle consolidation.
- Scope 2 accepted: existing cumulative behavioral suites define the consolidation without
  requiring sibling product commits to be stacked.
- Scope 3 accepted: reporting is additive and preserves preparation/provider policy.
- Scope 4 accepted: historical supersession is a conditional publication dependency.
- Scope 5 accepted: no frozen-policy changes or unrelated feature expansion.

Acceptance authoring is still pending. This draft does not assert approval of a particular
suite, a proof result, or merge readiness.
