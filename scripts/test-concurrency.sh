#!/usr/bin/env bash
# Copyright 2026 Chad Walker
# SPDX-License-Identifier: Apache-2.0

# repo-teq checks — the re-runnable suite for the §7 concurrency knob: the bounded worker
# pool that lets ONE runner process work N tasks of one project at once (DESIGN.md §7,
# §4.12; change-log row `repo-teq`).
#
# Docker-free and network-free: it drives the scheduler exported by runner/run.js directly,
# and exercises the execution seam through PIPELINE_EXEC_STUB with shell stubs of its own.
# The sweep discovers it by glob (scripts/test-*.sh) and it is safe to run anywhere,
# including inside a task container — which is the point of main() being guarded behind
# `require.main === module`: without that, none of runner/run.js is reachable from here,
# because main() sits behind a token load and a Docker preflight that always fail in a
# container.
#
# Concurrency is proved by RENDEZVOUS, never by wall clock: the in-process fixture cannot
# complete unless N task bodies are genuinely in flight, and the two-child fixture cannot
# exit 0 unless both stubs overlap. A timing margin would flake on a loaded machine; a
# rendezvous either happens or it does not.
#
# What it does NOT cover, on purpose: a real run at concurrency > 1. That needs a daemon, an
# image and a Beads database, and it is the Docker suites' job. What lives here is
# everything about the pool that can be judged without them.
#
# Run from Git Bash:  bash scripts/test-concurrency.sh
# POSIX sh only in the body: it must also run as `sh <path>`, which is dash in a container
# and bash on the Windows host — all logic lives in the Node suite so the two shells cannot
# disagree about the result.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FAIL=0
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; FAIL=1; }

# A leaked seam would let the suite's own environment decide the result: PIPELINE_EXEC_STUB
# is the very seam under test, and a preloaded NODE_OPTIONS would follow every child process
# the suite spawns.
unset PIPELINE_EXEC_STUB PIPELINE_BD_CMD PIPELINE_KEEP_WORKSPACE NODE_OPTIONS RV_DIR

echo "== repo-teq checks: the bounded worker pool =="

OUT="$(node "$ROOT/tests/unit/concurrency.test.js" 2>&1)"; RC=$?
echo "$OUT"

if [ "$RC" -eq 0 ]; then
  pass "unit suite exits 0"
else
  fail "unit suite exited $RC"
fi

CHECKS="$(echo "$OUT" | grep -c '^ok - ')"
if [ "$CHECKS" -ge 50 ]; then
  pass "unit suite ran $CHECKS checks"
else
  fail "unit suite ran only $CHECKS checks (expected at least 50)"
fi

# The suite works in a temp directory and starts no run, so it must not have written a run
# folder into this repo — a stray runs/<id>/ is indistinguishable from a real run's output.
LEFT="$(ls -d "$ROOT"/runs/unit-concurrency-* 2>/dev/null | wc -l | tr -d ' ')"
if [ "$LEFT" = "0" ]; then
  pass "no run folder left behind in this repo's runs/"
else
  fail "$LEFT run folder(s) left in runs/"
fi

if [ "$FAIL" -eq 0 ]; then echo "== ALL repo-teq CHECKS PASSED =="; else echo "== repo-teq CHECKS FAILED =="; fi
exit $FAIL
