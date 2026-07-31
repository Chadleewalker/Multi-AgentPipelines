#!/usr/bin/env bash
# Copyright 2026 Chad Walker
# SPDX-License-Identifier: Apache-2.0

# repo-zje checks — the re-runnable suite for sweep hygiene (DESIGN.md §4.12; change-log
# row `repo-zje`): what scripts/test-all.sh reclaims after a suite, what it must never
# touch, and that reclaiming can never change a verdict.
#
# Docker-free and network-free: it copies the REAL scripts/test-all.sh into a temp fake
# root and drives it with a recording stand-in for docker, reached through the
# ${SWEEP_DOCKER:-docker} seam. Copied, not invoked in place — test-all.sh takes a lock,
# and a suite running inside the sweep would deadlock against the sweep that launched it.
# The sweep discovers this file by glob (scripts/test-*.sh) and it is safe to run
# anywhere, including inside a task container.
#
# The stand-in is safe in a way a PATH stub for pipeline-net.sh would not be: `down`
# removes the network and the proxy BY NAME and unconditionally, so a miss would delete
# the real ones, whereas a missed seam here yields an empty before/after diff and removes
# nothing at all. Ownership is what makes the stand-in safe.
#
# Run from Git Bash:  bash scripts/test-sweep-hygiene.sh
# POSIX sh only in the body: it must also run as `sh <path>`, which is dash in a container
# and bash on the Windows host — all logic lives in the Node suite so the two shells
# cannot disagree about the result.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FAIL=0
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; FAIL=1; }

# A leaked seam would let the suite's own environment decide the result: the Node suite
# sets SWEEP_DOCKER and a preloaded NODE_OPTIONS for its children, and either one arriving
# from outside would follow every process it spawns.
unset SWEEP_DOCKER NODE_OPTIONS FAKE_RECORD FAKE_MARKER FAKE_NETWORK FAKE_LIST_EXIT FAKE_RM_EXIT

echo "== repo-zje checks: sweep hygiene =="

OUT="$(node "$ROOT/tests/unit/sweep-hygiene.test.js" 2>&1)"; RC=$?
echo "$OUT"

if [ "$RC" -eq 0 ]; then
  pass "unit suite exits 0"
else
  fail "unit suite exited $RC"
fi

CHECKS="$(echo "$OUT" | grep -c '^ok - ')"
if [ "$CHECKS" -ge 35 ]; then
  pass "unit suite ran $CHECKS checks"
else
  fail "unit suite ran only $CHECKS checks (expected at least 35)"
fi

# The suite drives a COPY of test-all.sh under a temp root. A sweep directory or a lock
# left in this repo would mean it reached the real one — which, under the sweep, is the
# deadlock this suite exists to avoid.
if [ -e "$ROOT/runs/.test-all.lock/pid" ] && [ "$(cat "$ROOT/runs/.test-all.lock/pid")" = "$$" ]; then
  fail "the suite took this repo's sweep lock"
else
  pass "this repo's sweep lock untouched"
fi

if [ "$FAIL" -eq 0 ]; then echo "== ALL repo-zje CHECKS PASSED =="; else echo "== repo-zje CHECKS FAILED =="; fi
exit $FAIL
