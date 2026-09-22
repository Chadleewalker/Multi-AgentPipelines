#!/usr/bin/env bash
# Copyright 2026 Chad Walker
# SPDX-License-Identifier: Apache-2.0

# Final file-scope gate checks — runner/scope.js, the host-side gate that decides whether
# a finished branch may leave the machine (DESIGN.md §4.5, change-log row `repo-cl9`).
#
# Docker-free and network-free: the Node checker builds throwaway git repositories under
# the OS temp directory and drives the real gate against them, so it touches neither this
# repo's own tree nor a live remote. The sweep discovers it by glob (scripts/test-*.sh)
# and it is safe to run anywhere node and git exist, including inside a task container —
# the gate itself needs no Docker, no network and no `bd`, which is the whole point of it
# being deterministic host-side scaffolding (hard rule 7).
#
# Run from Git Bash:  bash scripts/test-scope-gate.sh
# POSIX sh only in the body: it must also run as `sh <path>`, which is dash in a container
# and bash on the Windows host — all logic lives in the Node checker so no two shells can
# disagree about the result.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FAIL=0
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; FAIL=1; }

LC_ALL=C
export LC_ALL

echo "== file-scope gate checks: runner/scope.js =="

if [ -f "$ROOT/runner/scope.js" ]; then
  pass "runner/scope.js is present"
else
  fail "runner/scope.js is missing"
fi

OUT="$(node "$ROOT/tests/unit/scope.test.js" 2>&1)"; RC=$?
echo "$OUT"

if [ "$RC" -eq 0 ]; then
  pass "scope checker exits 0"
else
  fail "scope checker exited $RC"
fi

# The count is the guard against a checker that silently stops asserting: a suite whose
# every check vanished still exits 0.
CHECKS="$(echo "$OUT" | grep -c '^ok - ')"
if [ "$CHECKS" -ge 14 ]; then
  pass "checker ran $CHECKS checks"
else
  fail "checker ran only $CHECKS checks (expected at least 14)"
fi

if [ "$FAIL" -eq 0 ]; then echo "== ALL SCOPE-GATE CHECKS PASSED =="; else echo "== SCOPE-GATE CHECKS FAILED =="; fi
exit $FAIL
