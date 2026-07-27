#!/bin/sh
# Copyright 2026 Chad Walker
# SPDX-License-Identifier: Apache-2.0

# Deterministic agent stub: implements the fixture's shout mode (DESIGN.md §7).
# Code phase -> satisfy the frozen acceptance test. Docs phase -> print a summary.
set -u
PROMPT=$(cat)

case "$PROMPT" in
  *"change summary"*)
    # Docs phase: the entrypoint captures stdout as changeSummary (§4.3).
    printf 'Added an optional "shout" argument to src/greet.sh that uppercases the greeting, leaving the default output unchanged.'
    exit 0
    ;;
esac

# Code phase: POSIX sh only, per the issue constraints.
cat > src/greet.sh <<'IMPL'
#!/bin/sh
set -u
NAME="${1:-there}"
MODE="${2:-plain}"
GREETING="hello, $NAME"
if [ "$MODE" = "shout" ]; then
  GREETING=$(printf '%s' "$GREETING" | tr '[:lower:]' '[:upper:]')
fi
echo "$GREETING"
IMPL
exit 0
