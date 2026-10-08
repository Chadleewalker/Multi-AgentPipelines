#!/usr/bin/env bash
# Copyright 2026 Chad Walker
# SPDX-License-Identifier: Apache-2.0

# Review-request forge checks — runner/publish.js's prCommand / extractPrUrl / openPr and
# runner/config.js's `forge` key (DESIGN.md §6, change-log row `gitlab-forge`).
#
# Docker-free and network-free: the Node checker pins each forge's argv through the pure
# prCommand, and drives publish() against a throwaway bare remote under the OS temp dir
# with the PIPELINE_GH_CMD seam standing in for `gh` / `glab`, so neither CLI need be
# installed. The sweep discovers it by glob (scripts/test-*.sh), and it is safe to run
# anywhere node and git exist, including inside a task container.
#
# Run from Git Bash:  bash scripts/test-forge.sh
# POSIX sh only in the body: it must also run as `sh <path>`, which is dash in a container
# and bash on the Windows host — all logic lives in the Node checker so no two shells can
# disagree about the result.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FAIL=0
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; FAIL=1; }

# The checker sets its own seam per check. One inherited from the caller's shell would
# answer for the CLI the suite is trying to observe.
unset PIPELINE_GH_CMD

echo "== forge checks: runner/publish.js + runner/config.js =="

OUT="$(node "$ROOT/tests/unit/forge.test.js" 2>&1)"; RC=$?
echo "$OUT"

if [ "$RC" -eq 0 ]; then
  pass "forge checker exits 0"
else
  fail "forge checker exited $RC"
fi

# The count is the guard against a checker that silently stops asserting: a suite whose
# every check vanished still exits 0.
CHECKS="$(echo "$OUT" | grep -c '^ok - ')"
if [ "$CHECKS" -ge 30 ]; then
  pass "checker ran $CHECKS checks"
else
  fail "checker ran only $CHECKS checks (expected at least 30)"
fi

if [ "$FAIL" -eq 0 ]; then echo "== ALL FORGE CHECKS PASSED =="; else echo "== FORGE CHECKS FAILED =="; fi
exit $FAIL
