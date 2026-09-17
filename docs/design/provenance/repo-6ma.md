# Idea conveyor: connect preparation to approved freeze

## Approved intent

On 2026-09-17 the user approved fixing the preparation-to-freeze handoff first:
reproduce the failure using the real preparation-state output, make a completed proof
explicitly await freeze approval, and advance to implementation only after observing a
valid published freeze receipt. The same proposal must survive restart without duplicate
specification, preparation, or implementation launches. Related containment and suite
supersession branches are separate integration work.

The user reconfirmed that human approval before freezing tests is required, resolving
the older epic description that treated kickoff as the final pre-code approval. The user
also authorized independent reviews and pipeline design, frozen-test, and PR publication;
merging implementation PRs remains a separate approval.

Difficulty: hard. Design reference: `DESIGN.md#3.10` and the existing freeze admission
contract in `runner/queue.js`. This document specifies the intended amendment to that
design; it does not claim that the behavior below has shipped.

## Description

Connect the production proposal supervisor to the actual durable preparation records and
the existing published-suite admission check. A completed green proof is ready for a
person to approve and publish its acceptance suite; it is not itself a published freeze.
While waiting, status must explain that action. Once the approved suite and matching
receipt are available on the configured remote integration branch, the same proposal
becomes ready and enters the existing shared implementation feed.

The reproduced defect is a producer/consumer mismatch. `preparation-state.deriveState`
returns `issues[].state`, including `proven-at-base`, but the supervisor reads a top-level
`preparation.stage`. When the operation completes, the supervisor stores completion
evidence without advancing from `criticizing`; stored evidence then excludes that proposal
from further preparation polling. An isolated reproduction using the real state writer
and reader stayed at `criticizing` after six ticks, with one preparation poll and no
implementation start. The existing conveyor fixture supplies a synthetic top-level stage
and freeze receipt, so its successful run does not exercise this boundary.

## Constraints

- Preserve human freeze approval. The supervisor observes publication; it does not approve,
  freeze, commit, push, or manufacture a receipt merely because a proof completed.
- Keep the existing closed stage graph. Represent the approval wait in `freezing`, with an
  explicit next action, rather than introducing another independently maintained stage enum.
- Consume the canonical preparation and dispatch rules. Do not change their meanings or
  duplicate receipt parsing, suite hashing, remote-branch selection, or admission policy.
- Bind all observations to the proposal's canonical target and exact issue identity.
  Another issue's success, an unpublished local receipt, or a preparation artifact claiming
  to contain a receipt cannot authorize implementation.
- Retain append-only history, project ownership, child settlement, scheduling ceilings,
  intake behavior, and the shared implementation feed. Do not change frozen suites or
  unrelated containment, provider, proof-retention, or supersession behavior.
- Tests must run without provider credentials, a live model, Docker inside the verifier,
  or a network service. Local Git fixtures may represent the publication boundary.

## Done means

1. Using `preparation-state.createManifest`, worker writers and `deriveState`, the exact
   proposal issue progresses through `authoring` to `authoring-tests`, `proving` to
   `proving`, and successful `proven-at-base` to `freezing`. Status names the required
   human approval/publication action. An absent issue or a result for another issue never
   advances it. No synthetic top-level preparation stage is required, and no implementation
   starts while publication is absent.
2. Preparation completion, child settlement and published freeze are separately durable.
   A successfully completed operation releases its preparation grant without marking the
   proposal ready. Recreating the supervisor from its journal while waiting preserves
   kickoff, issue, operation and history; subsequent ticks continue publication observation
   with specification and preparation launch counters unchanged at one. An uncertain
   settlement remains attention and is never implicitly retried or reconciled. The existing
   operation manager remains the owner of child settlement; an already settled grant is
   acknowledged idempotently, not settled as a second independent operation. This includes
   existing journals with successful `preparation.completed` evidence stranded at
   `criticizing`: resume derives the missing forward transitions without relaunching or
   rewriting prior history.
3. Production publication observation calls canonical `queue.partitionByFreeze` for the
   exact issue and configured target. Local bare-remote fixtures demonstrate absent suite,
   absent or malformed receipt, mismatched suite hash, forbidden half-proven receipt,
   local-only publication and another issue's receipt cannot authorize readiness. The
   canonical refusal reason appears in status; read failures produce explicit unavailable
   evidence. A valid receipt follows the existing `allowHalfProven` policy.
4. Once valid publication is observed, journal evidence identifies the canonical target,
   exact issue, integration branch, admitted `suiteHash`, receipt `gateVersion` and
   `verdict` from the same canonical admission observation; paths alone are insufficient.
   The proposal passes through
   `ready` and receives one existing shared-feed assignment. Repeated ticks and controller
   reconstruction at durable completion, freeze-observation and assignment boundaries
   produce no duplicate specification, preparation, assignment or feed launch. The
   implementation runner retains independent dispatch admission. This task does not add
   proposal-exclusive runner queue selection.
5. `unproven`, `agent-failed`, `usage-limit`, `interrupted-unknown`, unavailable preparation
   and operation attention cannot advance to readiness. Status exposes the actual condition
   and recovery action; ticks perform no retry, interrupted acknowledgment or recovery
   mutation. These conditions retain the last valid nonterminal proposal stage, rather than
   terminal `failed`, and continue observing the same operation; only successful evidence
   after an externally authorized recovery clears the preparation block. Stopping with only
   successfully completed preparation awaiting human
   publication drains and releases ownership without publication or implementation.
6. At least one behavioral test composes the real preparation reader, supervisor consumption
   and production publication observer with local Git. It fails on today's stuck
   `criticizing` behavior and passes after the fix; expensive launch/provider execution may
   be substituted. Existing explicitly injected testing adapters may retain their legacy
   contract, but production cannot inherit their synthetic receipt trust. Relevant existing
   supervisor, operation-manager, preparation and freeze-admission behavior stays covered;
   mandatory regression validation is a separate stage, not a recursive acceptance runner.

## Review and proof status

The user approved the bounded intent above. Fresh-context implementation review supplied the
six criteria and identified the existing settlement owner and test-only compatibility seam.
The testability and scope critics returned `ok`. The ambiguity critic's three findings were
accepted: adverse preparation remains observable/recoverable rather than terminal; existing
stranded completion journals must advance without a relaunch; and publication evidence must
pin suiteHash, gateVersion and verdict from canonical admission rather than paths alone.
Acceptance authoring and the two-direction freeze proof are not yet complete. There is no
freeze receipt or implementation result for this task yet. The canonical Beads issue will
supersede this draft before acceptance freeze.
