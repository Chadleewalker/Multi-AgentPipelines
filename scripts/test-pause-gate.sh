#!/usr/bin/env bash
# Copyright 2026 Chad Walker
# SPDX-License-Identifier: Apache-2.0

# repo-i9y checks — the re-runnable suite for the RUN-LEVEL rate-limit park: one shared
# wait for the whole run, one run-level cycle cap, and a pool that admits no NEW work while
# the subscription window is closed (DESIGN.md §4.7, §7; change-log row `repo-i9y`).
#
# Docker-free and network-free: it drives runner/pause.js's createPauseGate directly, and
# runner/run.js's exported runOneTask through its seams (PIPELINE_BD_CMD, PIPELINE_EXEC_STUB,
# PIPELINE_GH_CMD, and a local bare repo as targetRepoRemote). The sweep discovers it by
# glob (scripts/test-*.sh) and it is safe to run anywhere, including inside a task
# container — which is the point of main() sitting behind `require.main === module`.
#
# Nothing here turns on wall clock. "Has not settled yet" is judged by draining the event
# loop with setImmediate and ordering is judged from an events array, because a park is a
# thing that SLEEPS and a suite that measured it by elapsed time would either take a day or
# flake on a loaded machine.
#
# What it does NOT cover, on purpose: a real run at concurrency > 1 against a genuine usage
# limit. That needs a daemon, an image, a Beads database and a closed subscription window,
# and it stays unproven until a daytime batch hits one.
#
# Run from Git Bash:  bash scripts/test-pause-gate.sh
# POSIX sh only in the body: it must also run as `sh <path>`, which is dash in a container
# and bash on the Windows host — all logic lives in the Node suite so the two shells cannot
# disagree about the result.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FAIL=0
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; FAIL=1; }

# A leaked seam would let the suite's own environment decide the result: PIPELINE_BD_CMD and
# PIPELINE_EXEC_STUB are seams the suite sets itself, and a preloaded NODE_OPTIONS would
# follow every child process it spawns.
unset PIPELINE_EXEC_STUB PIPELINE_BD_CMD PIPELINE_GH_CMD PIPELINE_PROBE_CMD NODE_OPTIONS
unset PIPELINE_KEEP_WORKSPACE BD_ARGV_LOG BD_ISSUE_ID

echo "== repo-i9y checks: the run-level rate-limit park =="

OUT="$(node "$ROOT/tests/unit/pause-gate.test.js" 2>&1)"; RC=$?
echo "$OUT"

if [ "$RC" -eq 0 ]; then
  pass "unit suite exits 0"
else
  fail "unit suite exited $RC"
fi

# A suite that silently stopped running most of its cases still exits 0. Assert the count,
# not just the verdict — the failure mode CLAUDE.md names by shape is the vacuously green
# one, and a park that is never exercised looks exactly like a park that works.
CHECKS="$(echo "$OUT" | grep -c '^ok - ')"
if [ "$CHECKS" -ge 90 ]; then
  pass "unit suite ran $CHECKS checks"
else
  fail "unit suite ran only $CHECKS checks (expected at least 90)"
fi

# The suite works entirely in temp directories and starts no run, so it must not have
# written a run folder into this repo — a stray runs/<id>/ is indistinguishable from a real
# run's output when someone reads the artifacts later.
LEFT="$(ls -d "$ROOT"/runs/unit-pause-gate* 2>/dev/null | wc -l | tr -d ' ')"
if [ "$LEFT" = "0" ]; then
  pass "no run folder left behind in this repo's runs/"
else
  fail "$LEFT run folder(s) left in runs/"
fi

if [ "$FAIL" -eq 0 ]; then echo "== ALL repo-i9y CHECKS PASSED =="; else echo "== repo-i9y CHECKS FAILED =="; fi
exit $FAIL
