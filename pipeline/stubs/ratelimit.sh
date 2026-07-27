#!/bin/sh
# Copyright 2026 Chad Walker
# SPDX-License-Identifier: Apache-2.0

# Deterministic agent stub: reports a usage limit on the first call, then succeeds.
# Proves the pause/resume path (DESIGN.md §4.7): exit 20, park, relaunch, and the
# attempt counter carries over because .run/ survives in the reused workspace.
# PIPELINE_STUB_RESET_DELAY (seconds, default 5) tunes the reported reset time.
set -u
cat > /dev/null
N=$(cat .run/stub-calls 2>/dev/null || echo 0)
N=$((N + 1))
mkdir -p .run && echo "$N" > .run/stub-calls

if [ "$N" -eq 1 ]; then
  DELAY="${PIPELINE_STUB_RESET_DELAY:-5}"
  echo "Claude AI usage limit reached|$(( $(date +%s) + DELAY ))"
  exit 1
fi

case "$(cat .run/last-prompt 2>/dev/null)" in *) : ;; esac
echo done > out.txt
exit 0
