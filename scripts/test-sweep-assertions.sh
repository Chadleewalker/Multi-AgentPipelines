#!/usr/bin/env bash
# Copyright 2026 Chad Walker
# SPDX-License-Identifier: Apache-2.0

# repo-0ay checks — the re-runnable suite for the sweep's assertion counter
# (scripts/sweep-assertions.js) and the `PASSED` column it feeds in scripts/test-all.sh
# (DESIGN.md 4.12; change-log row `repo-0ay`).
#
# Why it has to be re-runnable rather than left in the frozen acceptance directory: what it
# guards is a NUMBER, and a number that stops meaning anything goes on being printed. Before
# this counter existed, every suite wrapping a Node checker reported its wrapper's two summary
# lines — 2 for test-network-names, which had actually run 34 checks — and nothing anywhere
# said so. That is the failure mode the column exists to make visible, so it is the one thing
# the column itself must stay covered against.
#
# Docker-free and network-free: it counts lines in planted logs and drives a COPY of the real
# scripts/test-all.sh over stub suites, with a recording stand-in for docker. Safe to run
# anywhere, including inside a task container. Copied and never invoked in place, because
# test-all.sh takes a lock and would deadlock against the sweep running this.
#
# Run from Git Bash:  bash scripts/test-sweep-assertions.sh
# POSIX sh only in the body: it must also run as `sh <path>`, which is dash in a container and
# bash on the Windows host — all logic lives in the Node suite so the two shells cannot
# disagree about the result.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FAIL=0
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; FAIL=1; }

echo "== repo-0ay checks: the sweep counts both assertion vocabularies =="

OUT="$(node "$ROOT/tests/unit/sweep-assertions.test.js" 2>&1)"; RC=$?
echo "$OUT"

if [ "$RC" -eq 0 ]; then
  pass "unit suite exits 0"
else
  fail "unit suite exited $RC"
fi

# The count itself, which is the "assert the artifact is right, not merely present" rule (§3.6)
# applied to a suite that reports counts: a checker that silently stopped running most of its
# fixtures would still exit 0.
CHECKS="$(echo "$OUT" | grep -c '^ok - ')"
if [ "$CHECKS" -ge 34 ]; then
  pass "unit suite ran $CHECKS checks"
else
  fail "unit suite ran only $CHECKS checks (expected at least 34)"
fi

# And the counter can answer about this very log, which carries both vocabularies at once —
# the wrapper's PASS lines above and the unit suite's `ok - ` lines echoed through it. Through a
# real file, never `/dev/stdin`: node is a native binary on the Windows host and MSYS rewrites
# such a path on the way to it, which would fail there and pass in here.
TMP="$(mktemp -d 2>/dev/null || echo "${TEMP:-/tmp}/sweep-assertions-$$")"
mkdir -p "$TMP"
trap 'rm -rf "$TMP"' EXIT
printf '%s\n' "$OUT" > "$TMP/self.log"
SELF="$(node "$ROOT/scripts/sweep-assertions.js" count "$TMP/self.log" 2>/dev/null)"
if [ "$SELF" = "$CHECKS" ]; then
  pass "the counter reads this suite's own mixed log as $SELF, not its wrapper's summary"
else
  fail "the counter read this suite's own log as '$SELF', expected $CHECKS"
fi

if [ "$FAIL" -eq 0 ]; then echo "== ALL repo-0ay CHECKS PASSED =="; else echo "== repo-0ay CHECKS FAILED =="; fi
exit $FAIL
