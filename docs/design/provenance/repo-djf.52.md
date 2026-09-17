# Complete host and hosted active-acceptance integration

Difficulty: hard. Canonical issue: repo-djf.52. Depends on repo-djf.48.

## Intent

Finish the complete-host and actual hosted integration execution paths using the canonical
supersession authority established by repo-djf.48. An all-active GREEN verdict must mean
every selected suite ran successfully on the identified candidate, not that a resolver
printed a plausible roster. Preserve the existing mandatory and Docker/live validation.

## Design references and boundaries

The authority, historical provenance, candidate identity, working-input population, timeout
and approved freeze/review/integration boundaries are defined in
the approved `docs/planning-draft-2026-09-17-supersession-completion.md`, sections Approved
validation boundaries and Exact authority and identity definitions. Its publication target
is `docs/design/provenance/repo-djf.48.md`; that immutable file, including those definitions,
must exist in the integration commit before this task is authored. Publish the predecessor
first, then this document; do not make an untracked draft the author's only source. DESIGN.md
section 3.2 supplies the planning process, not the new active-integration contract.

The complete host entry point is `scripts/fast-full-sweep.js`; hosted wiring is the actual
`.github/workflows/ci.yml` workflow. Both consume `runner/suite-supersession.js` and the
configured frozen acceptance runner. They may share an execution coordinator, but neither
may maintain a separate retirement roster. Keep canonical shell suites and frozen policy
unchanged. Docker-backed coverage remains sequential. Production code changes must come
through the pipeline. No sibling PR merge, historical-suite rewrite, blanket retirement,
evidence deletion or verifier weakening is authorized.

## Done means

1. The complete host coordinator executes the canonical active acceptance population under
   repo-djf.48's authority and candidate/provenance rules. Behavioral fixtures invoke the
   real coordinator with substituted leaves and observe every selected active execution,
   effective-retirement exclusion, pending-predecessor inclusion and same-candidate
   replacement-result reuse. A consumer-owned list or list-only implementation does not pass.
2. The actual hosted integration workflow invokes a production execution path applying that
   same authority and running every active suite on the workflow's identified candidate.
   Fixtures derive and invoke the path from real workflow wiring, substitute leaf/external
   effects, and observe execution and propagated failures. Exercising verify-pr, importing
   a resolver or adding a disconnected coordinator does not establish hosted coverage.
3. Host and hosted integration succeed only after resolution and complete passing active
   coverage. Both fail on active failure, timeout, missing result, execution error, candidate
   drift, incomplete coverage or failure of any later resolver call. One fixture matrix
   proves an active suite failing at both base and candidate fails all three consumers
   (host, hosted and verify-pr), while otherwise identical all-passing candidates succeed.
   Attribution never converts an active failure into a pass.
4. Both paths report candidate identity, selected/completed active coverage, effective
   replacement/rationale/provenance and pending reasons from the shared authority. They
   reject results for another commit or working snapshot and never claim complete coverage
   after early termination. Deterministic fixtures change the population or relevant bytes
   during execution and prove no readiness result survives.
5. [guard] Existing mandatory and Docker/live coverage remains intact through permissible
   coordinators, without changing frozen shell profiles or protected policy. Host fixtures
   observe execution of the authoritative mandatory profile and remaining required host
   coverage, including existing nested coverage. Hosted fixtures preserve the mandatory
   regression layer alongside active acceptance. Docker-backed execution stays sequential.
6. [guard] Integrated consumers preserve the preceding task's freeze, individual review
   publication, historical-byte and direct-execution boundaries and refused-candidate
   evidence. Approved freeze and eligible review-publication fixtures still succeed with
   unrelated active RED suites, while host and hosted integration of those candidates fail.
   These acceptance fixtures use bounded local Git histories and substituted leaves, never
   recursively executing the repository's acceptance tree. Overall conveyor closure still
   requires GREEN mandatory and active acceptance for the exact integration candidate;
   review publication is insufficient and merge needs separate human approval.

## Review state

The independent scope critic requested this dependent split; fresh-context criteria preserve
all original outcomes across the pair. The pair passed independent ambiguity, scope and
testability review and received user approval on 2026-09-17. Human approval of the eventual
acceptance suite remains separate. Durable issue state belongs in Beads, not this draft.
