#!/usr/bin/env bash
# Copyright 2026 Chad Walker
# SPDX-License-Identifier: Apache-2.0

# Acceptance checks for the freeze command (change-log row `freeze-command`).
#
# Docker-free and network-free. The fixture builds a bare repository as its "remote" and a
# working clone beside it, so the commit and the push are real git against real trees on this
# disk; only the target's verify command is stubbed, through the freeze gate's existing
# FREEZE_GATE_CMD seam, and Beads through the runner's own PIPELINE_BD_CMD. The sweep discovers
# this by glob and it is safe to run anywhere.
#
# Run from Git Bash:  bash scripts/test-freeze.sh
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FAIL=0
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; FAIL=1; }

echo "== freeze command checks: gate, commit, push, and prove the runner accepts it =="

OUT="$(node "$ROOT/tests/unit/freeze-cmd.test.js" 2>&1)"; RC=$?
echo "$OUT"
if [ "$RC" -eq 0 ]; then pass "freeze-command checker exits 0"; else fail "freeze-command checker exited $RC"; fi

# A FLOOR, never an equality: later work is licensed to add checks here, and `-eq` would go red
# for exactly that. Raise it only to a number that was already passing before the new work landed.
CHECKS="$(echo "$OUT" | grep -c '^PASS  ')"
if [ "$CHECKS" -ge 60 ]; then pass "checker ran $CHECKS checks"
else fail "checker ran only $CHECKS checks (expected at least 60)"; fi

# The command has to be reachable and self-describing from a real command line, not only through
# the module — a usage screen that only the test harness has ever rendered is not a usage screen.
USAGE="$(node "$ROOT/scripts/freeze.js" 2>&1)"; URC=$?
if [ "$URC" -eq 2 ]; then pass "a bare invocation exits 2 and prints usage"; else fail "expected 2 for no verb, got $URC"; fi
echo "$USAGE" | grep -q "freeze.js status" && pass "usage names the status verb" || fail "usage does not name status"
echo "$USAGE" | grep -q "freeze.js commit" && pass "usage names the commit verb" || fail "usage does not name commit"

HELP="$(node "$ROOT/scripts/freeze.js" --help 2>&1)"; HRC=$?
if [ "$HRC" -eq 0 ]; then pass "--help exits 0"; else fail "--help exited $HRC"; fi

# The playbook must name the command, or the automation exists and nobody is told to use it —
# which is the failure this whole change is about, one level up.
grep -q "scripts/freeze.js commit" "$ROOT/PLANNING.md" \
  && pass "PLANNING.md step 6 names the freeze command" \
  || fail "PLANNING.md does not name the freeze command"
grep -q "scripts/freeze.js status" "$ROOT/PLANNING.md" \
  && pass "PLANNING.md step 8 names the pre-launch question" \
  || fail "PLANNING.md does not name the pre-launch question"

if [ "$FAIL" -eq 0 ]; then echo "== ALL freeze COMMAND CHECKS PASSED =="; else echo "== freeze COMMAND CHECKS FAILED =="; fi
exit $FAIL
