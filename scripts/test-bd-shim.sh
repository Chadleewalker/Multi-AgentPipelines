#!/usr/bin/env bash
# Copyright 2026 Chad Walker
# SPDX-License-Identifier: Apache-2.0

# Host-`bd` resolution checks for runner/bd.js (DESIGN.md 4.10, 4.12; change-log row
# bd-npm-shim).
#
# Docker-free and network-free, like scripts/test-runner-memory.sh: the shim parsing is
# pure string work and the one host-dependent check is conditional. The sweep discovers
# it by glob (scripts/test-*.sh) and it is safe to run anywhere.
#
# Run from Git Bash:  bash scripts/test-bd-shim.sh
# POSIX sh only in the body, so it can also be invoked as `sh <path>`.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FAIL=0
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; FAIL=1; }

# PIPELINE_BD_CMD takes absolute precedence inside runner/bd.js, so a leaked value from
# a parent suite would route the differential check somewhere else entirely.
unset PIPELINE_BD_CMD BD_ARGS_LOG BD_STUB_OUT BD_STUB_EXIT

echo "== bd-npm-shim checks: host bd resolution =="

OUT="$(node "$ROOT/tests/unit/bd-shim.test.js" 2>&1)"; RC=$?
echo "$OUT"

if [ "$RC" -eq 0 ]; then
  pass "unit suite exits 0"
else
  fail "unit suite exited $RC"
fi

CHECKS="$(echo "$OUT" | grep -c '^ok - ')"
if [ "$CHECKS" -ge 10 ]; then
  pass "unit suite ran $CHECKS checks"
else
  fail "unit suite ran only $CHECKS checks (expected at least 10)"
fi

if [ "$FAIL" -eq 0 ]; then echo "== ALL bd-npm-shim CHECKS PASSED =="; else echo "== bd-npm-shim CHECKS FAILED =="; fi
exit $FAIL
