#!/usr/bin/env bash
# repo-dhp acceptance checks — the re-runnable suite for runner/memory.js
# (DESIGN.md 3.6, both memory channels; 4.4 verification).
#
# Docker-free and network-free: the whole bd layer is stubbed through the
# PIPELINE_BD_CMD seam, so unlike every other suite here this one needs no base image,
# no pipeline network and no target repo. The sweep discovers it by glob
# (scripts/test-*.sh) and it is safe to run anywhere, including alongside nothing.
#
# Run from Git Bash:  bash scripts/test-runner-memory.sh
# POSIX sh only in the body: the frozen acceptance test invokes it as `sh <path>`.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FAIL=0
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; FAIL=1; }

# Scrub the stub variables out of the child environment. A parent that leaked
# BD_STUB_EXIT=1 or a stale PIPELINE_BD_CMD would otherwise fail every check for an
# unrelated reason (runner/bd.js gives PIPELINE_BD_CMD absolute precedence), and a
# suite that can be turned red by its caller's environment is not a regression signal.
unset PIPELINE_BD_CMD BD_ARGS_LOG BD_STUB_OUT BD_STUB_EXIT

echo "== repo-dhp checks: runner/memory.js unit suite =="

OUT="$(node "$ROOT/tests/unit/memory.test.js" 2>&1)"; RC=$?
echo "$OUT"

if [ "$RC" -eq 0 ]; then
  pass "unit suite exits 0"
else
  fail "unit suite exited $RC"
fi

CHECKS="$(echo "$OUT" | grep -c '^ok - ')"
if [ "$CHECKS" -ge 12 ]; then
  pass "unit suite ran $CHECKS checks"
else
  fail "unit suite ran only $CHECKS checks (expected at least 12)"
fi

if [ "$FAIL" -eq 0 ]; then echo "== ALL repo-dhp CHECKS PASSED =="; else echo "== repo-dhp CHECKS FAILED =="; fi
exit $FAIL
