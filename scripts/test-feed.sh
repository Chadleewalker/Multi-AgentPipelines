#!/usr/bin/env bash
# Copyright 2026 Chad Walker
# SPDX-License-Identifier: Apache-2.0

# live-queue-feed checks — the source that lets ONE run pick up work frozen after it started
# (DESIGN.md §4.12, change-log row `live-queue-feed`).
#
# Docker-free, network-free and CLOCK-free: it drives runner/feed.js's createFeedSource
# directly and runner/run.js's exported drainQueue over it, with `now` and `wait` injected so
# a grace window measured in minutes is exercised in milliseconds. The sweep discovers it by
# glob (scripts/test-*.sh) and it is safe to run anywhere, including inside a task container.
#
# Run it if you touch runner/feed.js, runner/run.js's drainQueue or task loop, or
# runner/config.js's feed knobs — and equally if you touch schemas/run.schema.json, because
# the manifest's `feed` block is written by one file and validated by another and the suite
# is what keeps the two enums in step.
#
# What it does NOT cover, on purpose: a real fed run against a live Beads database. That
# needs a daemon, an image and `bd`, and it is the Docker suites' job. What lives here is
# every part of the feed that can be judged without them — which is all of the scheduling.
#
# Run from Git Bash:  bash scripts/test-feed.sh
# POSIX sh only in the body: it must also run as `sh <path>`, which is dash in a container
# and bash on the Windows host — all logic lives in the Node suite so the two shells cannot
# disagree about the result.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FAIL=0
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; FAIL=1; }

# A leaked seam would let the suite's own environment decide the result. NODE_OPTIONS above
# all: a preloaded stub follows every child process this suite spawns, and the requirability
# probe below is a child.
unset PIPELINE_EXEC_STUB PIPELINE_BD_CMD PIPELINE_KEEP_WORKSPACE NODE_OPTIONS

echo "== live-queue-feed checks: the live queue feed =="

OUT="$(node "$ROOT/tests/unit/feed.test.js" 2>&1)"; RC=$?
echo "$OUT"

if [ "$RC" -eq 0 ]; then
  pass "unit suite exits 0"
else
  fail "unit suite exited $RC"
fi

CHECKS="$(echo "$OUT" | grep -c '^ok - ')"
if [ "$CHECKS" -ge 40 ]; then
  pass "unit suite ran $CHECKS checks"
else
  fail "unit suite ran only $CHECKS checks (expected at least 40)"
fi

# The suite works in a temp directory and starts no run, so it must not have written a run
# folder into this repo — a stray runs/<id>/ is indistinguishable from a real run's output.
LEFT="$(ls -d "$ROOT"/runs/unit-feed-* 2>/dev/null | wc -l | tr -d ' ')"
if [ "$LEFT" = "0" ]; then
  pass "no run folder left behind in this repo's runs/"
else
  fail "$LEFT run folder(s) left in runs/"
fi

if [ "$FAIL" -eq 0 ]; then echo "== ALL live-queue-feed CHECKS PASSED =="; else echo "== live-queue-feed CHECKS FAILED =="; fi
exit $FAIL
