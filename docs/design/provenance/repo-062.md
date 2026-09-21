# Preserved kickoff intent and explicit documentation scope

## Approved scope

This is the normal-conveyor fix from immutable kickoff `kp-d33cb6ab778c4299`,
hash `sha256:621fcfd9917cde0cdd25c6d15df3973db707098984246f33c33475a35ff7a9f1`,
implemented by canonical task `repo-062` and tracked diagnostically by `repo-djf.59`.
Difficulty: hard. This adds one explicit exception to the normal post-implementation
documentation phase and a host publication check; it does not change unrelated
publication or frozen policies.

Original kickoff constraints, nonGoals and their immutable kickoff hash must
survive canonical Beads serialization and task export exactly, independent of
planner paraphrasing or omission. Verify their binding rather than merely copying
a hash. A planner cannot weaken deterministically derived documentation scope.

## Exact directive semantics

Documentation preservation activates only if an entire element of the original
`constraints` or `nonGoals` array equals either `pipeline:docs=preserve` or
`Do not add documentation or package-management files.`. No other field activates
it: examples, title, description, substrings, casing variants and unrelated prose
are not directives. The second exact string is a compatibility alias for the
existing demo's restriction. This mechanism deterministically enforces only the
documentation surface, not package-management or arbitrary natural-language rules.

The protected surface is the existing docs-agent surface: root-level Markdown and
Markdown anywhere beneath `docs/`, with case-insensitive Markdown extensions and
robust Git handling of whitespace-bearing names. Implementation choices may vary
internally, but the two exact directives and this surface are fixed.

## Host authority and execution

Read original intent and derived scope from canonical issue data on the host and
retain a host-owned snapshot for publication. New malformed or tampered intent,
hash or scope metadata fails closed, including altered intent retaining its old
hash or an altered derived scope. Legacy tasks without the new metadata preserve
existing behavior. Container-editable issue files or environment artifacts cannot
relax the host snapshot.

A documentation-prohibited task still executes implementation and its verifier,
but launches no docs model and creates no docs worktree. Preserve its implementation
summary and successful verification. Record intentional omission as a bounded
explicit line in the existing run log and an explicit note in the host-generated
PR body, not as `docsPhaseError`. Existing status and verifier schemas stay unchanged.

Before any Git push or PR creation, inspect the final candidate against its pinned
integration baseline. Refuse additions, modifications, deletions, mode changes and
renames into or out of the protected Markdown surface. Refusal means zero push and
zero PR creation calls, with recoverable workspace and evidence retained through
the existing failure path. Scoped product-only changes remain publishable.
Unrestricted tasks keep normal docs invocation, isolation and final verification.

## Verification boundary

Use deterministic real Git fixtures through production specification, Beads
serialization/export, host/container scope propagation, docs skipping and host
publication. Substitute only external model/CLI boundaries. Include a planner
that omits or contradicts original intent, exact-array-item versus substring and
example controls, canonical intent/hash/scope tampering, container-side tampering,
zero docs-model/worktree calls, preserved summaries, explicit omission evidence,
every forbidden Git delta kind, and unrestricted/product-only positive controls.

Keep fork-point policies, frozen bytes and modes, credential scanning, ownership,
status/verifier schemas and unrelated publication rules unchanged. Add only the
new task-owned acceptance suite. Focused acceptance and mandatory validation run
outside the acceptance fixture, not recursively through historical suites.
Product changes remain pipeline-written with Claude Opus 4.8; this task may update
relevant documentation. Human freeze and merge approvals stay separate.

## Non-goals

No natural-language policy parser or general path-permissions system, no broader
documentation surface, and no historical-validation work. Preserve fixture demo
PRs 47, 48 and 49 and their frozen suites without editing, merging, replacing or
deleting them.
