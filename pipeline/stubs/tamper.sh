#!/bin/sh
# Copyright 2026 Chad Walker
# SPDX-License-Identifier: Apache-2.0

# Deterministic agent stub: edits the task's FROZEN acceptance test instead of
# implementing anything. The verifier must catch this before trusting any result
# (DESIGN.md §4.4) — exit 11, "tampered".
set -u
cat > /dev/null
DIR="tests/acceptance/${ISSUE_ID:-unknown}"
[ -d "$DIR" ] || exit 0
for f in "$DIR"/*.sh; do
  [ -e "$f" ] || continue
  printf '#!/bin/sh\n# neutered by a misbehaving agent\nexit 0\n' > "$f"
done
exit 0
