#!/usr/bin/env bash
# Copyright 2026 Chad Walker
# SPDX-License-Identifier: Apache-2.0

# repo-006 acceptance checks — the re-runnable suite for the change-log identity convention
# (slug refs, unique by construction — DESIGN.md §12, §3.1). The rows themselves live in
# docs/change-log.md; §12 still owns the convention that says what a row is.
#
# Docker-free and network-free: it reads markdown only, so unlike most suites here it needs
# no base image, no pipeline network and no target repo. The sweep discovers it by glob
# (scripts/test-*.sh) and it is safe to run anywhere, including inside a task container.
#
# Set CHANGELOG_FILE to point the checker at a fixture instead of <repo>/docs/change-log.md;
# that is the seam the negative cases (duplicate ref, version-numbered row) run through.
#
# Run from Git Bash:  bash scripts/test-changelog.sh
# POSIX sh only in the body: the frozen acceptance test invokes it as `sh <path>`, which is
# dash in the container and bash on the Windows host — all parsing lives in the Node
# checker so the two shells cannot disagree about the result.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FAIL=0
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; FAIL=1; }

# The slug regex is anchored ASCII; pin the collation so a caller's locale cannot change
# what counts as [a-z0-9] for grep-alikes downstream.
LC_ALL=C
export LC_ALL

echo "== repo-006 checks: change-log identity convention (docs/change-log.md) =="

OUT="$(node "$ROOT/tests/unit/changelog.test.js" 2>&1)"; RC=$?
echo "$OUT"

if [ "$RC" -eq 0 ]; then
  pass "change-log checker exits 0"
else
  fail "change-log checker exited $RC"
fi

CHECKS="$(echo "$OUT" | grep -c '^PASS  ')"
if [ "$CHECKS" -ge 6 ]; then
  pass "checker ran $CHECKS checks"
else
  fail "checker ran only $CHECKS checks (expected at least 6)"
fi

if [ "$FAIL" -eq 0 ]; then echo "== ALL repo-006 CHECKS PASSED =="; else echo "== repo-006 CHECKS FAILED =="; fi
exit $FAIL
