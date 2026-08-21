#!/usr/bin/env bash
# Copyright 2026 Chad Walker
# SPDX-License-Identifier: Apache-2.0

# Dispatch-gate checks — the ready queue's second admission rule in `runner/queue.js`
# (DESIGN.md §4.12, §4.11's `undispatchable` outcome; change-log rows `dispatch-gate`,
# `repo-5yu`).
#
# Docker-free and network-free: the Node checker builds throwaway bare remotes and working
# copies under the OS temp directory and drives the real `readyQueue()` against them through
# the existing `PIPELINE_BD_CMD` seam, so no real `bd` runs, no target project is opened and
# this repo's own working tree is never touched. The sweep discovers it by glob
# (scripts/test-*.sh) and it is safe to run anywhere git and node exist, including inside a
# task container.
#
# WHY IT IS RE-RUNNABLE RATHER THAN LEFT FROZEN. This gate decides, on every run for ever,
# whether a batch goes out at all, and both ways it can fail are silent: refuse everything
# on a confident wrong branch, or dispatch an unfrozen task that spends three attempts and
# a container to record `stuck`. It is also DOWNSTREAM of things it does not own — the
# outcome enum in `schemas/run.schema.json`, the scrutiny table in `runner/report.js`, the
# summary line `scripts/dashboard.js` parses, and `runner/config.js`'s validation of
# `gitTimeoutMs` — so run it if you touch any of those, not only `runner/queue.js`.
#
# Run from Git Bash:  bash scripts/test-dispatch-gate.sh
# POSIX sh only in the body: it must also run as `sh <path>`, which is dash in a container
# and bash on the Windows host — all logic lives in the Node checker so no two shells can
# disagree about the result.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FAIL=0
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; FAIL=1; }

# The checker owns its fixtures. A seam inherited from the caller's shell would point the
# stubbed Beads layer — or, through it, the gate itself — at something real.
unset PIPELINE_BD_CMD
unset PIPELINE_IMAGE_BD_CMD

LC_ALL=C
export LC_ALL

echo "== dispatch-gate checks: runner/queue.js =="

if [ -f "$ROOT/runner/queue.js" ]; then
  pass "runner/queue.js is present"
else
  fail "runner/queue.js is missing"
fi

# git is the thing under test here, not an incidental tool: without it every fixture below
# would report a refusal for a reason that has nothing to do with the gate.
if command -v git >/dev/null 2>&1; then
  pass "git is available to build the fixtures"
else
  fail "git is not on PATH — every fixture would fail for an unrelated reason"
fi

OUT="$(node "$ROOT/tests/unit/dispatch-gate.test.js" 2>&1)"; RC=$?
echo "$OUT"

if [ "$RC" -eq 0 ]; then
  pass "dispatch-gate checker exits 0"
else
  fail "dispatch-gate checker exited $RC"
fi

# The count is the guard against a checker that silently stops asserting: a suite whose
# every check vanished still exits 0.
CHECKS="$(echo "$OUT" | grep -c '^ok - ')"
if [ "$CHECKS" -ge 55 ]; then
  pass "checker ran $CHECKS checks"
else
  fail "checker ran only $CHECKS checks (expected at least 55)"
fi

if [ "$FAIL" -eq 0 ]; then echo "== ALL DISPATCH-GATE CHECKS PASSED =="; else echo "== DISPATCH-GATE CHECKS FAILED =="; fi
exit $FAIL
