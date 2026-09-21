#!/usr/bin/env bash
# Copyright 2026 Chad Walker
# SPDX-License-Identifier: Apache-2.0

# repo-kfg checks — the live run dashboard (scripts/dashboard.js, DESIGN.md §5, change-log
# rows `live-dashboard` and `repo-kfg`).
#
# What the reader answers is a set of JOINS over artifacts four other modules write: the
# lock record, `run.log`'s line wording, `run.json`'s field names and `status.json`'s shape.
# Any of those can be changed by a later task that has no idea this reader exists, and the
# failure is silent — a dashboard that renders a well-formed, empty, wrong picture. That is
# why this is re-runnable rather than left frozen in tests/acceptance/repo-kfg/.
#
# Docker-free, git-free, and network-free beyond loopback: the Node checker builds throwaway
# runs roots under the OS temp directory and drives the real reader against them, both as a
# required module and as a spawned server on an ephemeral port. It touches neither this
# repo's working tree nor the real runs corpus. The sweep discovers it by glob
# (scripts/test-*.sh) and it is safe to run anywhere node exists, including inside a task
# container.
#
# Run from Git Bash:  bash scripts/test-dashboard.sh
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

# The checker owns its fixtures and its ports. A seam inherited from the caller's shell
# would aim the reader at the host's REAL corpus — a tree this suite must never read, whose
# contents are private, and whose contents would make every count below meaningless — or
# park every spawned server on one fixed port and turn a passing suite into a hang.
unset DASHBOARD_RUNS_DIR
unset DASHBOARD_PORT

echo "== repo-kfg checks: the live dashboard reads, serves and changes nothing =="

if [ -f "$ROOT/scripts/dashboard.js" ]; then
  pass "scripts/dashboard.js is present"
else
  fail "scripts/dashboard.js is missing"
fi

# Plain `node`, never `node --test`: this repo's assertion vocabulary is bare `ok - ` lines
# on stdout, and the TAP harness swallows them, so the count below would read zero against a
# fully green suite.
OUT="$(node "$ROOT/tests/unit/dashboard.test.js" 2>&1)"; RC=$?
echo "$OUT"

if [ "$RC" -eq 0 ]; then
  pass "dashboard checker exits 0"
else
  fail "dashboard checker exited $RC"
fi

# The count itself — "assert the artifact is right, not merely present" (CLAUDE.md §3.6)
# applied to a suite: a checker that silently stopped running most of its fixtures would
# still exit 0. This is an honesty floor, not a target.
CHECKS="$(echo "$OUT" | grep -c '^ok - ')"
if [ "$CHECKS" -ge 60 ]; then
  pass "checker ran $CHECKS checks"
else
  fail "checker ran only $CHECKS checks (expected at least 60)"
fi

if [ "$FAIL" -eq 0 ]; then echo "== ALL repo-kfg CHECKS PASSED =="; else echo "== repo-kfg CHECKS FAILED =="; fi
exit $FAIL
