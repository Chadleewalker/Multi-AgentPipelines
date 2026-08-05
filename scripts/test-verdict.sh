#!/usr/bin/env bash
# Copyright 2026 Chad Walker
# SPDX-License-Identifier: Apache-2.0

# Review-verdict checks — scripts/verdict.js, the host-side capture step for the review
# phase (DESIGN.md §5, change-log row `review-verdict`).
#
# Docker-free and network-free: the Node checker builds throwaway runs roots under the OS
# temp directory and drives the real CLI against them, so it touches neither this repo's
# own `runs/` tree nor its working tree. The sweep discovers it by glob
# (scripts/test-*.sh) and it is safe to run anywhere node exists, including inside a task
# container — the recorder itself needs no Docker, no network and no `bd`, which is the
# whole point of it being deterministic host-side scaffolding.
#
# Run from Git Bash:  bash scripts/test-verdict.sh
# POSIX sh only in the body: it must also run as `sh <path>`, which is dash in a container
# and bash on the Windows host — all logic lives in the Node checker so no two shells can
# disagree about the result.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FAIL=0
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; FAIL=1; }

# The checker owns its fixtures. A seam inherited from the caller's shell would aim the
# recorder at a real runs root — which is a directory this suite must never write into.
unset VERDICT_RUNS_DIR

LC_ALL=C
export LC_ALL

echo "== review-verdict checks: scripts/verdict.js =="

if [ -f "$ROOT/scripts/verdict.js" ]; then
  pass "scripts/verdict.js is present"
else
  fail "scripts/verdict.js is missing"
fi

OUT="$(node "$ROOT/tests/unit/verdict.test.js" 2>&1)"; RC=$?
echo "$OUT"

if [ "$RC" -eq 0 ]; then
  pass "verdict checker exits 0"
else
  fail "verdict checker exited $RC"
fi

# The count is the guard against a checker that silently stops asserting: a suite whose
# every check vanished still exits 0.
CHECKS="$(echo "$OUT" | grep -c '^ok - ')"
if [ "$CHECKS" -ge 25 ]; then
  pass "checker ran $CHECKS checks"
else
  fail "checker ran only $CHECKS checks (expected at least 25)"
fi

if [ "$FAIL" -eq 0 ]; then echo "== ALL VERDICT CHECKS PASSED =="; else echo "== VERDICT CHECKS FAILED =="; fi
exit $FAIL
