# repo-djf.38 design provenance

## Specification-output contract binding

The defect is a producer/consumer contract split. `validateProposal` enforces a closed
durable proposal, but `promptFor` currently tells the planner only the field names. The
real subscription planner therefore invented the plausible difficulty `small` and
anchorless design references; all three valid audit ideas were rejected after the model
call even though their content was otherwise usable.

Keep the existing durable ready and needs-input proposal shapes authoritative. Add a
versioned `schemas/specification-proposal.schema.json` for the planner wire response and
pass it with Codex's native `--output-schema` argument. The schema must use the supported
fixed-object subset rather than top-level `oneOf`: all six wire fields are required,
`question` is string-or-null, status and difficulty are enumerated, arrays and strings are
bounded, references have `path#anchor` syntax, and additional properties are forbidden.
Immediately after extracting the last agent message, normalize only the single wire
compatibility case `status=ready, question=null` by deleting `question`; then apply the
existing closed host validator. A needs-input response still requires a concrete bounded
question. Contradictory combinations, extra fields, invalid enums, and unbounded data
remain refusals. The host validator and downstream receipt format remain the security
boundary; structured output improves production reliability but does not replace either.

The host must derive candidate design references from the same pinned integration commit
used for planning. Use bounded, non-shell Git argv to enumerate Markdown headings, accept
only safe repository-relative Markdown paths, slug headings with the same semantics used
by the resolver, deduplicate in deterministic Git/line order, and cap both count and total
prompt bytes. Put the resulting safe `path#slug` values into the prompt as a JSON data
array. Tell the planner to choose only from that array and to return immediately without
tools; repository content is untrusted data, never instructions. Returned references are
still resolved independently against the pinned commit before Beads creation. If candidate
discovery fails or produces no usable references, fail closed with a concise deterministic
refusal rather than letting the model invent provenance.

The planner prompt must state every semantic rule that is not expressible by the supported
schema subset: ready uses `question:null`, needs-input uses a non-empty question, references
come only from the supplied candidates, and operational identities/commands remain
forbidden. This removes the expensive and unreliable model-side repository discovery that
the live reproduction attempted.

Acceptance tests should use the production plan/adapter seams with no network or Beads
mutation. They must assert the checked-in schema is accepted by the intended fixed-shape
contract, `--output-schema` is present, candidate enumeration is bounded and deterministic,
the prompt contains the exact enum and safe candidates plus no-tool instruction, ready wire
normalization reaches one canonical issue, needs-input semantics remain closed, and the
observed `small`/anchorless response is still refused. Existing no-key ChatGPT auth,
read-only checkout cleanup, receipt idempotency, and the mandatory sweep remain unchanged.
