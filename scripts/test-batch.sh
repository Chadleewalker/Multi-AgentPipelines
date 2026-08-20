#!/usr/bin/env bash
# Copyright 2026 Chad Walker
# SPDX-License-Identifier: Apache-2.0

# Batch marker checks — scripts/batch.js, the host-side reader for the planning-to-launch
# handoff (DESIGN.md §3.9, change-log row `batch-ready-marker`).
#
# Docker-free and network-free: the Node checker builds throwaway runs roots under the OS
# temp directory and drives the real CLI against them, so it touches neither this repo's
# own `runs/` tree nor its working tree. The sweep discovers it by glob
# (scripts/test-*.sh) and it is safe to run anywhere node exists, including inside a task
# container. The live-queue half (change-log row `repo-8v0`) needs no real `bd` either: the
# checker owns both seams — it stubs `PIPELINE_BD_CMD` where it wants an answer, and points
# `BATCH_CONFIG_DIR` at an empty directory everywhere else, so no check can reach the host's
# own database by accident and no result depends on whether this machine has `bd` installed.
#
# Run from Git Bash:  bash scripts/test-batch.sh
# POSIX sh only in the body: it must also run as `sh <path>`, which is dash in a container
# and bash on the Windows host — all logic lives in the Node checker so no two shells can
# disagree about the result.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FAIL=0
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; FAIL=1; }

# The checker owns its fixtures. A seam inherited from the caller's shell would aim the
# reader at a real runs root — which is a directory this suite must never write into.
unset BATCH_RUNS_DIR

LC_ALL=C
export LC_ALL

echo "== batch marker checks: scripts/batch.js =="

if [ -f "$ROOT/scripts/batch.js" ]; then
  pass "scripts/batch.js is present"
else
  fail "scripts/batch.js is missing"
fi

OUT="$(node "$ROOT/tests/unit/batch.test.js" 2>&1)"; RC=$?
echo "$OUT"

if [ "$RC" -eq 0 ]; then
  pass "batch checker exits 0"
else
  fail "batch checker exited $RC"
fi

# The count is the guard against a checker that silently stops asserting: a suite whose
# every check vanished still exits 0.
CHECKS="$(echo "$OUT" | grep -c '^ok - ')"
if [ "$CHECKS" -ge 40 ]; then
  pass "checker ran $CHECKS checks"
else
  fail "checker ran only $CHECKS checks (expected at least 40)"
fi

if [ "$FAIL" -eq 0 ]; then echo "== ALL BATCH CHECKS PASSED =="; else echo "== BATCH CHECKS FAILED =="; fi
exit $FAIL
