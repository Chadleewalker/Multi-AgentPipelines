#!/bin/sh
# Deterministic agent stub: never satisfies the tests, so the task burns all three
# attempts and bails (DESIGN.md §4.6). Writes something each attempt so the WIP commit
# has real content to preserve.
set -u
cat > /dev/null
N=$(cat .run/attempt-notes 2>/dev/null | wc -l)
echo "attempt $((N + 1)): tried an approach, tests still red" >> notes.txt
echo "x" >> .run/attempt-notes
exit 0
