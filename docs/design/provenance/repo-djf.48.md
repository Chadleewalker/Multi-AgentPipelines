# Trusted acceptance supersession and strict PR integration verification

Difficulty: hard. Canonical issue: repo-djf.48.

## Intent

Establish the approved suite-supersession authority and its first strict consumer,
`verify-pr`, so integration validation executes a coherent, explicitly selected acceptance
roster. A dependent task completes the host and hosted consumers. Keep historical suites immutable and
directly runnable. A supersession entry must name its replacement, rationale and exact
replacement-freeze provenance; successful replacement behavior on the actual candidate
must justify retirement. Do not treat a failure as retired merely because it predates
the candidate.

The preserved product candidate at ab691d130f0b0e0c10086adad11c58d374034f45 is reference
evidence, not an approved implementation or a merge prerequisite. It reports a roster
without executing all active suites in the full coordinator, leaves hosted checks outside
that roster, and permits the integration verifier to accept preexisting active failures.
Its second resolver invocation can fail without failing the consumer. A local Git
reproduction also demonstrated that uncommitted implementation bytes can authorize
retirement for an unchanged commit that still lacks the implementation.

## Approved validation boundaries

The user selected these semantics on 2026-09-17:

- Explicit human approval is required to freeze acceptance tests. RED-first acceptance
  freeze publishes only the approved suite and matching receipts; it does not claim the
  implementation or full active roster is GREEN.
- Individual implementation PRs may be published for review under the existing task
  acceptance and immutable fork-point regression gates. A review PR is not evidence that
  integration is ready.
- Full active-acceptance and integration-readiness gates require all selected active
  suites to pass. Preexisting failures remain failures; attribution may be reported
  separately. A PR merge still requires separate human approval.

## Constraints

- Make product changes through the pipeline. Preserve protected policy, canonical shell
  suites and historical acceptance bytes. Use the existing host coordinator around the
  immutable shell sweep rather than bypassing or changing its frozen policy.
- Retire repo-7a0 only for the explicitly approved repo-djf.40 per-launch-disposal
  replacement. No blanket retirement of unrelated historical failures is authorized.
- Preserve the existing contract's invalid-metadata, chain, history, direct-execution,
  Windows identity and observable reporting coverage. Strengthen defective expectations
  with behavioral evidence; source imports or a printed list do not prove execution.
- Distinguish a managed proof's authorized working implementation snapshot from an exact
  committed integration candidate. A dirty green probe is legal; its success cannot
  assert that its unchanged base commit contains the implementation.
- Bound validation and fail closed on unknown results. Keep deterministic local fixture
  validation separate from the broad mandatory/active acceptance integration sweep; do
  not recursively run the whole acceptance tree inside this issue's acceptance suite.
- Preserve evidence and refused candidates. Do not reset historical audit state, merge
  sibling PRs, weaken a verifier, or silently suppress a failing suite.

## Design references

DESIGN.md section 3.2 provides the frozen-test planning process; section 11 is a design
document's readiness bar, not an existing integration-validation contract. This document
defines the new supersession authority and the user's explicit separation of freeze,
review publication and integration readiness. Pipeline publication must create immutable
issue-owned design provenance from the approved text before a new author receives a brief.

## Exact authority and identity definitions

The canonical data location is `contracts/superseded-suites.json`, and the public resolver
is `runner/suite-supersession.js`. Preserve the existing `readContract(root)` and
`resolveSuites(options)` entry points and the active/superseded/pending/report vocabulary;
additional identity and execution evidence may be returned. The top-level document has
exactly `version: 1` and `supersessions`. Each entry has exactly `suite`, `supersededBy`,
`replacementSuite`, `rationale`, `integrationCommit`, and `retiredFreezeCommit`.
`integrationCommit` names the replacement freeze, not an arbitrary containing commit.
The existing `derive:freeze-commit` value remains supported for that field, resolving to
the exact introduction freeze in the identified history; all returned identities are full
commit OIDs. `retiredFreezeCommit` is a full commit OID naming the approved historical
version of the old suite. Unknown fields remain errors.

For this repository the approved old-suite anchor is
`0ac394e6da3b5125add581061002e0c200adc1b8` for repo-7a0, and the replacement anchor is
`b9feb69894c9949790c6d13572740603792d54bb` for repo-djf.40. The former is an intentional
second freeze, not the original introduction: it removed literal host paths from fixtures.
Compare complete suite path sets and Git-normalized content/modes against those anchors,
including committed rewrites; never substitute the candidate HEAD as the historical
baseline. Both anchors must be reachable from an explicitly pinned trusted integration
commit as well as present in the candidate's history. The host resolves the configured
integration ref once before validation, not from candidate-controlled metadata. Fixtures
use their own real local Git freeze commits with the same relationships, not these literal
repository hashes. A later re-freeze changes the approved contract through separate human
review; merely adding a receipt or choosing the latest containing commit is not authority.

Committed mode resolves one candidate OID, reads its metadata and suite roster from that
tree, and executes a clean materialization of that tree or refuses a mismatched executable
working tree. Managed-working mode is explicit and returns both the base OID and a distinct
content identity. Its identity covers all tracked files plus untracked and ignored files
matching the authoritative product, control, configuration or frozen path classes, including
path presence, Git-normalized file content and modes and symlink targets. Git metadata is
not an input. Only the existing precisely validated controller-receipt/generated-sidecar
normalizations may be excluded; arbitrary ignored source files may not. Determine classes
from the trusted baseline's existing write-protection contract, not a candidate-modified
roster. Check this manifest before and after replacement execution and at consumer completion;
an addition, removal or change invalidates the result. Runtime logs outside that input set
do not change a product snapshot. No working result may be labeled committed GREEN.

Each Git subprocess has a 60-second default deadline; each acceptance leaf has a 15-minute
default deadline. Positive-integer millisecond overrides may be accepted for deterministic
fixtures and explicit host configuration; zero, negative and nonnumeric values refuse.
Every child execution is bounded, including an otherwise successful resolver's later calls.
The total work is a finite, single traversal of the identified roster (with at most one
same-snapshot replacement proof credited as its leaf result), not an unbounded retry loop.
Any configured enclosing job deadline is an additional bound, not a replacement for leaf
timeouts. A timeout is indeterminate failure, never an ordinary RED retirement-pending result.

## Review dispositions and delivery sequence

- Ambiguity: historical provenance accepted; the two actual approved freeze anchors and
  the separate approval requirement for later re-freezes are now explicit.
- Ambiguity: working-snapshot population accepted; executable inputs include ignored and
  untracked files in authoritative protected classes, with bounded existing normalizations.
- Ambiguity: canonical interfaces accepted; paths, entry points, fields and derive-token
  handling are now named instead of being left to the implementation.
- Ambiguity: bounds accepted; Git and acceptance-leaf deadlines and refusal semantics are
  explicit, with deterministic override support.
- Scope: split accepted. Deliver the authority and strict `verify-pr` consumer first as
  repo-djf.48, followed by a dependent task for complete-host and hosted integration
  execution. The dependent draft is
  `docs/planning-draft-2026-09-17-active-integration.md`. Preserve every requirement across
  the pair; no conveyor closure is claimed after only the first task.
- Scope: inaccurate design citation accepted and corrected above; publish this new design
  rather than claiming it already exists in DESIGN.md section 11.
- Testability: the six original outcomes were found machine-checkable. The decomposed
  pair subsequently passed fresh independent testability and scope review.
- Pair ambiguity: explicit retired-suite precedence accepted. The active roster controls
  integration readiness even when the CLI's task argument names a retired suite; historical
  diagnostics remain available through the frozen runner, not an accidental second gate.

## Done means

1. One canonical machine-readable contract and resolver determine deterministic active,
   superseded and pending populations under the exact definitions above. Entries record
   both approved historical anchors. Absent metadata produces no retirements. Unknown
   fields, malformed or noncanonical suite identities, duplicate retirements, self-retirement,
   cycles, missing suites, absent or unreachable provenance commits, and later commits
   that merely contain the replacement are refused. This repository declares exactly the
   approved repo-7a0 to repo-djf.40 per-launch-disposal replacement; unrelated suites stay active.
2. Retirement requires successful execution of the terminal replacement on the identified
   candidate and valid provenance for every chain link. Ordinary replacement failure leaves
   retirement pending and its predecessor active, including in RED proof. Unknown,
   interrupted, timed-out, malformed or unexecutable results cause strict validation failure.
   Committed validation binds metadata, population, implementation bytes and results to one
   commit. Managed GREEN proof reports its distinct authorized snapshot identity, detects
   relevant changes, and cannot establish retirement for an unchanged base commit that lacks
   the implementation. Both modes obey the bounded execution rules above.
3. Retired and replacement suites remain present and directly executable through the frozen
   runner. Complete path sets, content and modes match the approved historical anchors,
   not candidate HEAD. Real local Git fixtures reject committed and dirty rewrites, exercise
   chain provenance, Windows path/case identity and direct execution, and use corresponding
   explicit trusted fixture anchors. A later re-freeze needs separate approval, outside this task.
4. `verify-pr` consumes canonical resolution and executes every selected active suite through
   the configured frozen runner on its identified candidate. It excludes effective retirements,
   retains pending predecessors, and reports candidate identity, selected/completed coverage,
   effective replacement/rationale/provenance and pending reasons. A replacement result counts
   only for the same candidate. Behavioral fixtures observe leaf execution through the actual
   consumer, including a supplied task suite when applicable; imports and printed lists do not
   satisfy execution coverage. An explicitly supplied effectively retired suite stays excluded
   from the acceptance readiness gate and is reported with its direct frozen-runner diagnostic
   command; it is not independently required to pass. An explicitly supplied active suite is
   included exactly once; a supplied path outside the identified suite population refuses.
5. `verify-pr` succeeds only after successful resolution and complete passing active coverage,
   retaining its other applicable checks. Active failure, timeout, execution error, missing result,
   candidate drift or incomplete coverage blocks readiness. Identical active failure at base
   and candidate still fails; attribution is diagnostic only. Fixtures prove that negative case,
   an otherwise identical passing case, and propagated failure of any later resolver call.
   Reports cannot equate reached suites with complete coverage after interruption.
6. [guard] Actual freeze and task-publication orchestration with substituted external effects
   preserve human-approved RED-first freeze and individually eligible review PR publication
   despite unrelated active RED suites. Ownership, approval, immutable baseline, transactional
   promotion, task acceptance, fork-point regression and existing refusals remain enforced.
   Neither operation claims integration readiness; `verify-pr` rejects those same candidates
   while selected active suites remain RED. Use bounded local fixtures rather than recursively
   running this repository's acceptance population.

## Review state

Fresh-context criteria drafting and all three independent reviews are complete. The user
approved this split and pipeline author/proof/implementation work on 2026-09-17, using
Opus 4.8. Publish this approved design before authoring. Human approval of the eventual
acceptance suite and separate approval of any PR merge remain required. This draft does
not claim proof or integration readiness. Durable task state and findings remain in Beads.
