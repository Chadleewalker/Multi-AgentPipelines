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
# container. `show` does consult the live queue (DESIGN.md §3.9), but every check drives it
# through the existing `PIPELINE_BD_CMD` seam against a stand-in, so no real `bd` runs and
# no target repo is opened — which is the whole point of it being deterministic host-side
# scaffolding.
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
# reader at a real runs root — which is a directory this suite must never write into — or,
# worse, at a real run config plus the host's own `bd`, which would have this suite query a
# target project's database.
unset BATCH_RUNS_DIR
unset BATCH_CONFIG_DIR
unset PIPELINE_BD_CMD

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
if [ "$CHECKS" -ge 60 ]; then
  pass "checker ran $CHECKS checks"
else
  fail "checker ran only $CHECKS checks (expected at least 60)"
fi

if [ "$FAIL" -eq 0 ]; then echo "== ALL BATCH CHECKS PASSED =="; else echo "== BATCH CHECKS FAILED =="; fi
exit $FAIL
