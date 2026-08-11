#!/usr/bin/env bash
# Copyright 2026 Chad Walker
# SPDX-License-Identifier: Apache-2.0

# The verifier's capture limit and its no-verdict rule — pipeline/verify.js and
# pipeline/verify-classify.js (change-log row `verify-nobuffer`, STATUS defect 12).
#
# Docker-free and network-free: the Node checker builds throwaway git repositories under
# the OS temp directory and drives the real verifier against them, so it touches neither
# this repo's history nor its working tree. The sweep discovers it by glob
# (scripts/test-*.sh) and it is safe to run anywhere git and node exist, including inside
# a task container.
#
# Run from Git Bash:  bash scripts/test-verify-buffer.sh
# POSIX sh only in the body: all logic lives in the Node checker so no two shells can
# disagree about the result.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FAIL=0
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; FAIL=1; }

LC_ALL=C
export LC_ALL

echo "== verifier capture-limit checks: pipeline/verify.js =="

OUT="$(node "$ROOT/tests/unit/verify-buffer.test.js" 2>&1)"; RC=$?
echo "$OUT"

if [ "$RC" -eq 0 ]; then
  pass "verify-buffer checker exits 0"
else
  fail "verify-buffer checker exited $RC"
fi

CHECKS="$(echo "$OUT" | grep -c '^PASS  ')"
if [ "$CHECKS" -ge 20 ]; then
  pass "checker ran $CHECKS checks"
else
  fail "checker ran only $CHECKS checks (expected at least 20)"
fi

# The defect was a DEFAULT quietly applying, so the absence of an explicit limit is the
# thing worth asserting about the source itself: a future edit that drops maxBuffer from
# either spawnSync call restores it in full, and no behavioural check above would notice
# until a suite happened to get loud again.
CALLS="$(grep -c 'maxBuffer: MAX_BUFFER' "$ROOT/pipeline/verify.js")"
if [ "$CALLS" -eq 2 ]; then
  pass "both spawnSync calls in verify.js pass an explicit maxBuffer"
else
  fail "expected 2 explicit maxBuffer arguments in verify.js, found $CALLS"
fi

if [ "$FAIL" -eq 0 ]; then
  echo "== ALL VERIFY-BUFFER CHECKS PASSED =="
else
  echo "== VERIFY-BUFFER CHECKS FAILED =="
fi
exit $FAIL
