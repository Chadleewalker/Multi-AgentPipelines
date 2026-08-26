#!/usr/bin/env bash
# Copyright 2026 Chad Walker
# SPDX-License-Identifier: Apache-2.0

# One-folder-per-session checks — scripts/worktree.js, the parallel-session isolation tool
# (DESIGN.md §6.2, change-log row `parallel-sessions`).
#
# Docker-free and network-free: the Node checker builds throwaway git repositories under
# the OS temp directory — including their own bare "remotes" — and drives the real CLI
# against them, so it touches neither this repo's history nor its working tree. The sweep
# discovers it by glob (scripts/test-*.sh) and it is safe to run anywhere git and node
# exist, including inside a task container.
#
# Run from Git Bash:  bash scripts/test-worktree.sh
# POSIX sh only in the body: all logic lives in the Node checker so no two shells can
# disagree about the result.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FAIL=0
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; FAIL=1; }

LC_ALL=C
export LC_ALL

echo "== parallel-session checks: scripts/worktree.js =="

OUT="$(node "$ROOT/tests/unit/worktree.test.js" 2>&1)"; RC=$?
echo "$OUT"

if [ "$RC" -eq 0 ]; then
  pass "worktree checker exits 0"
else
  fail "worktree checker exited $RC"
fi

CHECKS="$(echo "$OUT" | grep -c '^PASS  ')"
if [ "$CHECKS" -ge 45 ]; then
  pass "checker ran $CHECKS checks"
else
  fail "checker ran only $CHECKS checks (expected at least 45)"
fi

if [ "$FAIL" -eq 0 ]; then echo "== ALL WORKTREE CHECKS PASSED =="; else echo "== WORKTREE CHECKS FAILED =="; fi
exit $FAIL
