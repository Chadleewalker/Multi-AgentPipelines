# Interrupted specification recovery

## Specifying-recovery

The append-only `specification.completed` event is the durable completion boundary for
proposal specification. A proposal whose valid history ends at `stage=specifying` without
that event records an interrupted controller attempt, not completed or permanently active
work. On restart, the supervisor must schedule specification again from the proposal's
original immutable kickoff record. The specification entry point is responsible for
idempotently returning the one canonical specification and Beads issue identity if an
earlier process created them before the supervisor recorded its result.

Recovery must not append a second `stage=specifying` transition, because the closed stage
graph does not permit a self-transition. Once `specification.completed` is durable, restart
must never invoke the controller again. Recovered calls consume the same global and
specification concurrency limits as first-time calls, retain FIFO proposal identity and
order, and leave queued, answered-needs-input, invalid-history, and later-stage behavior
unchanged.
