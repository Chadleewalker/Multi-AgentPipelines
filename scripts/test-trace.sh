#!/usr/bin/env bash
# Copyright 2026 Chad Walker
# SPDX-License-Identifier: Apache-2.0

# Traceability-ledger checks — scripts/trace.js, the spec-to-code drift report
# (docs/IDEAS.md, the 2026-08-04 entry; convention: a ticked box carries the issue id
# that ticked it).
#
# Docker-free and network-free: the Node checker builds throwaway git repositories under
# the OS temp directory and drives the real CLI against them, so it touches neither this
# repo's history nor its working tree. The sweep discovers it by glob (scripts/test-*.sh)
# and it is safe to run anywhere git and node exist, including inside a task container.
#
# Run from Git Bash:  bash scripts/test-trace.sh
# POSIX sh only in the body: all logic lives in the Node checker so no two shells can
# disagree about the result.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FAIL=0
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; FAIL=1; }

LC_ALL=C
export LC_ALL

echo "== traceability-ledger checks: scripts/trace.js =="

OUT="$(node "$ROOT/tests/unit/trace.test.js" 2>&1)"; RC=$?
echo "$OUT"

if [ "$RC" -eq 0 ]; then
  pass "trace checker exits 0"
else
  fail "trace checker exited $RC"
fi

CHECKS="$(echo "$OUT" | grep -c '^PASS  ')"
if [ "$CHECKS" -ge 20 ]; then
  pass "checker ran $CHECKS checks"
else
  fail "checker ran only $CHECKS checks (expected at least 20)"
fi

if [ "$FAIL" -eq 0 ]; then echo "== ALL TRACE CHECKS PASSED =="; else echo "== TRACE CHECKS FAILED =="; fi
exit $FAIL
