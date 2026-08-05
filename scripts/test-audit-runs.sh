#!/usr/bin/env bash
# Copyright 2026 Chad Walker
# SPDX-License-Identifier: Apache-2.0

# repo-73k checks — the run-history audit (scripts/audit-runs.js, DESIGN.md §5, change-log
# row `run-audit`).
#
# Why it is re-runnable rather than left frozen in tests/acceptance/repo-73k/: what the
# audit prints is a set of numbers about the corpus, and a number that quietly stops
# meaning anything goes on being printed. The hand pass this tool replaces read a
# `concerns` key that is really named `specConcerns` and called a 43-use channel unused —
# non-empty, well-formed and false. The suite's fixtures are built so that misread, and
# every other silent-wrong reading the spec names, cannot pass.
#
# Docker-free, network-free and git-free: the Node checker builds throwaway runs roots
# under the OS temp directory and drives the real CLI against them through the
# AUDIT_RUNS_DIR seam, so it touches neither this repo's working tree nor the real runs
# corpus. The sweep discovers it by glob (scripts/test-*.sh) and it is safe to run
# anywhere node exists, including inside a task container.
#
# Run from Git Bash:  bash scripts/test-audit-runs.sh
# POSIX sh only in the body: it must also run as `sh <path>`, which is dash in a container
# and bash on the Windows host — all logic lives in the Node checker so no two shells can
# disagree about the result.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FAIL=0
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; FAIL=1; }

LC_ALL=C
export LC_ALL

# The checker owns its fixtures; inherit nothing, or a host that happens to export the
# seam audits its own real corpus and the numbers below stop being about the fixtures.
unset AUDIT_RUNS_DIR

echo "== repo-73k checks: the run-history audit reads and changes nothing =="

OUT="$(node "$ROOT/tests/unit/audit-runs.test.js" 2>&1)"; RC=$?
echo "$OUT"

if [ "$RC" -eq 0 ]; then
  pass "audit checker exits 0"
else
  fail "audit checker exited $RC"
fi

# The count itself — "assert the artifact is right, not merely present" (CLAUDE.md §3.6)
# applied to a suite: a checker that silently stopped running most of its fixtures would
# still exit 0.
CHECKS="$(echo "$OUT" | grep -c '^ok - ')"
if [ "$CHECKS" -ge 30 ]; then
  pass "checker ran $CHECKS checks"
else
  fail "checker ran only $CHECKS checks (expected at least 30)"
fi

if [ "$FAIL" -eq 0 ]; then echo "== ALL repo-73k CHECKS PASSED =="; else echo "== repo-73k CHECKS FAILED =="; fi
exit $FAIL
