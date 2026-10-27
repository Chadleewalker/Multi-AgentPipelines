#!/usr/bin/env bash
# Copyright 2026 Chad Walker
# SPDX-License-Identifier: Apache-2.0

# PR-body handoff checks — how runner/publish.js's openPr hands a PR body to gh
# (DESIGN.md §4.5; change-log row `pr-body-file`; STATUS defect 14).
#
# Docker-free and network-free: the Node checker calls openPr in-process against a
# stand-in gh (a .js run through process.execPath) in a throwaway directory under the OS
# temp directory. No real gh runs. The sweep discovers it by glob (scripts/test-*.sh) and
# it is safe to run anywhere node exists, including inside a task container.
#
# Run from Git Bash:  bash scripts/test-pr-body.sh
# POSIX sh only in the body; all logic lives in the Node checker.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FAIL=0
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; FAIL=1; }

# The checker sets its own seam per check; one inherited from the caller's shell would aim
# the real-gh checks at something else.
unset PIPELINE_GH_CMD

LC_ALL=C
export LC_ALL

echo "== PR-body handoff checks: runner/publish.js openPr =="

OUT="$(node "$ROOT/tests/unit/pr-body.test.js" 2>&1)"; RC=$?
echo "$OUT"

if [ "$RC" -eq 0 ]; then
  pass "pr-body checker exits 0"
else
  fail "pr-body checker exited $RC"
fi

# The count guards against a checker that silently stops asserting.
CHECKS="$(echo "$OUT" | grep -c '^ok - ')"
if [ "$CHECKS" -ge 18 ]; then
  pass "checker ran $CHECKS checks"
else
  fail "checker ran only $CHECKS checks (expected at least 18)"
fi

if [ "$FAIL" -eq 0 ]; then echo "== ALL PR-BODY CHECKS PASSED =="; else echo "== PR-BODY CHECKS FAILED =="; fi
exit $FAIL
