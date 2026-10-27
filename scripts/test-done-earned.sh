#!/usr/bin/env bash
# Copyright 2026 Chad Walker
# SPDX-License-Identifier: Apache-2.0

# Earned-success checks — runner/queue.js's missingSuccessEvidence, where runner/run.js
# applies it, and where runner/workspace.js puts task workspaces (DESIGN.md §4.11, §4.2;
# change-log row `done-earned`; STATUS defect 15).
#
# Docker-free and network-free: the Node checker drives the real runOneTask through the
# PIPELINE_BD_CMD, PIPELINE_EXEC_STUB and PIPELINE_GH_CMD seams against throwaway
# repositories under the OS temp directory, with PIPELINE_WORKSPACE_ROOT aimed there too.
# The sweep discovers it by glob (scripts/test-*.sh) and it is safe to run anywhere node,
# git and bash exist, including inside a task container.
#
# Run from Git Bash:  bash scripts/test-done-earned.sh
# POSIX sh only in the body; all logic lives in the Node checker.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FAIL=0
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; FAIL=1; }

# The checker owns its seams. One inherited from the caller's shell would aim the runner
# at a real bd, a real gh, or a real workspace root.
unset PIPELINE_BD_CMD PIPELINE_EXEC_STUB PIPELINE_GH_CMD PIPELINE_WORKSPACE_ROOT PIPELINE_KEEP_WORKSPACE

LC_ALL=C
export LC_ALL

echo "== earned-success checks: runner/queue.js + runner/run.js + runner/workspace.js =="

OUT="$(node "$ROOT/tests/unit/done-earned.test.js" 2>&1)"; RC=$?
echo "$OUT"

if [ "$RC" -eq 0 ]; then
  pass "done-earned checker exits 0"
else
  fail "done-earned checker exited $RC"
fi

# The count guards against a checker that silently stops asserting.
CHECKS="$(echo "$OUT" | grep -c '^ok - ')"
if [ "$CHECKS" -ge 34 ]; then
  pass "checker ran $CHECKS checks"
else
  fail "checker ran only $CHECKS checks (expected at least 34)"
fi

if [ "$FAIL" -eq 0 ]; then echo "== ALL DONE-EARNED CHECKS PASSED =="; else echo "== DONE-EARNED CHECKS FAILED =="; fi
exit $FAIL
