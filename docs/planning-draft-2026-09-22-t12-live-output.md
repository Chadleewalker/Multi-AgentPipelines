# V1 T12 live-output follow-up — approved-scope correction

## Intent
Restore T12's visible progress stream while retaining captured output and the runner's exit status. The previous isolated implementation c1ccb81 made the queue assertions pass but swallowed live terminal output inside command substitution.

## Constraints
Allowed implementation files: scripts/test-runner-queue.sh.
Do not change runtime code, schemas, other tests, or the already frozen acceptance suites. Keep shared main and GitHub unchanged until host validation and review.

## Done means
1. A stubbed runq emits a distinct line to the terminal stream while returning the same line in captured output.
2. A stubbed runner exit 7 remains exit 7 after the output-capture pipeline.
3. The complete T12 host suite still passes its queue, outcome, and pause assertions on Windows.

Difficulty: trivial. Design refs: DESIGN.md §§4.5, 4.10, 4.11. The user approved retaining live output in the two-script plan; this follow-up corrects that same criterion after independent review found c1ccb81 did not satisfy it.

Critic dispositions: accepted — the frozen check now uses a release handshake, so the stub exits 7 only after the parent observes the progress line on stderr. The full Windows T12 suite remains a separate host gate. The one-line function extraction is retained for this narrow existing function; a future formatting refactor may adapt the harness.
