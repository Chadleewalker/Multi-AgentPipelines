#!/usr/bin/env bash
# Copyright 2026 Chad Walker
# SPDX-License-Identifier: Apache-2.0

# Acceptance checks for the generated spec brief (change-log row `spec-brief`).
#
# Docker-free and network-free: a bare repository stands in for the remote, Beads is stubbed
# through the runner's own PIPELINE_BD_CMD seam, and nothing here needs an engine or an image.
# The sweep discovers it by glob and it is safe to run anywhere.
#
# Run from Git Bash:  bash scripts/test-spec-brief.sh
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FAIL=0
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; FAIL=1; }

echo "== spec-brief checks: the six facts a hand-written brief got wrong =="

OUT="$(node "$ROOT/tests/unit/spec-brief.test.js" 2>&1)"; RC=$?
echo "$OUT"
if [ "$RC" -eq 0 ]; then pass "spec-brief checker exits 0"; else fail "spec-brief checker exited $RC"; fi

# A FLOOR, never an equality: later work may add checks here, and `-eq` would go red for exactly
# that. Raise it only to a number that was already passing before the new work landed.
CHECKS="$(echo "$OUT" | grep -c '^PASS  ')"
if [ "$CHECKS" -ge 40 ]; then pass "checker ran $CHECKS checks"
else fail "checker ran only $CHECKS checks (expected at least 40)"; fi

USAGE="$(node "$ROOT/scripts/spec-brief.js" 2>&1)"; URC=$?
if [ "$URC" -eq 2 ]; then pass "a bare invocation exits 2 and prints usage"; else fail "expected 2, got $URC"; fi
echo "$USAGE" | grep -q -- "--config" && pass "usage names the config it needs" || fail "usage does not name --config"

# The playbook has to send a planner here, or the command exists and nobody is told it does —
# which is the failure this whole change is about, one level up.
grep -q "scripts/spec-brief.js" "$ROOT/PLANNING.md" \
  && pass "PLANNING.md step 3 names the brief generator" \
  || fail "PLANNING.md does not name the brief generator"

if [ "$FAIL" -eq 0 ]; then echo "== ALL spec-brief CHECKS PASSED =="; else echo "== spec-brief CHECKS FAILED =="; fi
exit $FAIL
