#!/usr/bin/env bash
# Copyright 2026 Chad Walker
# SPDX-License-Identifier: Apache-2.0

# repo-jur checks — the re-runnable suite for the per-project task network and proxy
# sidecar (DESIGN.md 4.8, 4.12; change-log row `repo-jur`): where the names come from and
# what the runner hands the two shell scripts.
#
# Docker-free and network-free: it computes names and runs a recording stand-in for
# scripts/pipeline-net.sh, so unlike most suites here it needs no base image, no pipeline
# network and no target repo. The sweep discovers it by glob (scripts/test-*.sh) and it is
# safe to run anywhere, including inside a task container.
#
# What it does NOT cover, on purpose: that the two real scripts default to today's names.
# That needs a fake `docker` earlier on PATH than the real one, and a PATH stub that failed
# to intercept would either drive the live daemon or turn every check red for a reason that
# is not the code's — so the scripts stay covered by the Docker suites that run them for
# real (scripts/test-egress.sh, scripts/test-egress-check.sh, and the dozen that name
# pipeline-net in a cleanup trap).
#
# Run from Git Bash:  bash scripts/test-network-names.sh
# POSIX sh only in the body: it must also run as `sh <path>`, which is dash in a container
# and bash on the Windows host — all logic lives in the Node suite so the two shells cannot
# disagree about the result.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FAIL=0
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; FAIL=1; }

# A caller that leaked these would make the runner appear to honour names it was never
# given, or hide a fall back to the shared pair. A suite its own environment can turn green
# is not a regression signal.
unset PIPELINE_NET PIPELINE_PROXY PIPELINE_PROXY_PORT

echo "== repo-jur checks: per-project network + proxy names =="

OUT="$(node "$ROOT/tests/unit/network-names.test.js" 2>&1)"; RC=$?
echo "$OUT"

if [ "$RC" -eq 0 ]; then
  pass "unit suite exits 0"
else
  fail "unit suite exited $RC"
fi

CHECKS="$(echo "$OUT" | grep -c '^ok - ')"
if [ "$CHECKS" -ge 30 ]; then
  pass "unit suite ran $CHECKS checks"
else
  fail "unit suite ran only $CHECKS checks (expected at least 30)"
fi

if [ "$FAIL" -eq 0 ]; then echo "== ALL repo-jur CHECKS PASSED =="; else echo "== repo-jur CHECKS FAILED =="; fi
exit $FAIL
