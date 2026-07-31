#!/usr/bin/env bash
# Copyright 2026 Chad Walker
# SPDX-License-Identifier: Apache-2.0

# repo-os9 checks — the re-runnable suite for the per-project run lock (DESIGN.md 4.12;
# change-log row `repo-os9`): who is refused, whose lock is taken over, and what preflight
# does with it.
#
# Docker-free and network-free: it locks temp directories under a temp pipeline root and
# calls `preflight` with a fake repo root whose network scripts only record that they ran.
# The sweep discovers it by glob (scripts/test-*.sh) and it is safe to run anywhere,
# including inside a task container — which is the point of the lock being preflight's
# FIRST gate: every later gate needs Docker or Beads, so nothing else about a refused run
# would be reachable from here.
#
# What it does NOT cover, on purpose: that `runner/run.js` releases at the end of a
# successful run. Reaching the end of `main()` needs a live daemon, an image and a Beads
# database. The abort-at-preflight release is covered because it needs none of those, and
# the Docker suites drive the rest by running the real runner.
#
# Run from Git Bash:  bash scripts/test-lock.sh
# POSIX sh only in the body: it must also run as `sh <path>`, which is dash in a container
# and bash on the Windows host — all logic lives in the Node suite so the two shells cannot
# disagree about the result.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FAIL=0
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; FAIL=1; }

# A leaked seam would let the suite's own environment decide the result: PIPELINE_BD_CMD
# is set and restored around the preflight case, and a preloaded NODE_OPTIONS would follow
# every child process the suite spawns.
unset PIPELINE_BD_CMD NODE_OPTIONS BD_ARGS_LOG

echo "== repo-os9 checks: the per-project run lock =="

OUT="$(node "$ROOT/tests/unit/lock.test.js" 2>&1)"; RC=$?
echo "$OUT"

if [ "$RC" -eq 0 ]; then
  pass "unit suite exits 0"
else
  fail "unit suite exited $RC"
fi

CHECKS="$(echo "$OUT" | grep -c '^ok - ')"
if [ "$CHECKS" -ge 45 ]; then
  pass "unit suite ran $CHECKS checks"
else
  fail "unit suite ran only $CHECKS checks (expected at least 45)"
fi

# The suite locks temp directories under a temp root, never this repo's own runs/. A lock
# left here would be a live run's as far as the next run is concerned.
LEFT="$(ls -A "$ROOT/runs/locks" 2>/dev/null | wc -l | tr -d ' ')"
if [ "$LEFT" = "0" ]; then
  pass "no lock left behind in this repo's runs/locks"
else
  fail "$LEFT lock file(s) left in runs/locks"
fi

if [ "$FAIL" -eq 0 ]; then echo "== ALL repo-os9 CHECKS PASSED =="; else echo "== repo-os9 CHECKS FAILED =="; fi
exit $FAIL
