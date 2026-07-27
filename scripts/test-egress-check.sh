#!/usr/bin/env bash
# Copyright 2026 Chad Walker
# SPDX-License-Identifier: Apache-2.0

# T6 acceptance checks (V1 backlog T6; DESIGN.md 4.8).
# Proves the pre-run gate passes on a healthy network, stays under its 60s bound,
# fails when the allowlist is made PERMISSIVE (the dangerous direction), and fails
# when the sidecar is down. Run from Git Bash: bash scripts/test-egress-check.sh
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FAIL=0
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; FAIL=1; }

echo "== T6 checks =="
bash "$ROOT/scripts/pipeline-net.sh" up >/dev/null || { fail "pipeline-net up"; exit 1; }

# 1+2. Healthy network: gate passes, under 60 seconds.
T0=$(date +%s)
if bash "$ROOT/scripts/egress-check.sh" >/dev/null 2>&1; then
  pass "gate passes on a healthy network"
else
  fail "gate failed on a healthy network"
fi
T1=$(date +%s); ELAPSED=$((T1 - T0))
[ "$ELAPSED" -lt 60 ] && pass "bounded under 60s (${ELAPSED}s)" || fail "took ${ELAPSED}s (>= 60s)"

# 3. Permissive allowlist must be CAUGHT: let github.com through, gate must fail.
docker exec pipeline-proxy sh -c \
  'echo github.com >> /etc/squid/allowlist.txt && squid -k reconfigure' >/dev/null 2>&1
sleep 2
if bash "$ROOT/scripts/egress-check.sh" >/dev/null 2>&1; then
  fail "gate PASSED with a permissive allowlist (github.com allowed)"
else
  pass "gate fails when the allowlist is permissive"
fi
bash "$ROOT/scripts/pipeline-net.sh" up >/dev/null 2>&1   # recreate clean sidecar

# 4. Sidecar down: gate must fail (allowed endpoint unreachable).
docker stop pipeline-proxy >/dev/null 2>&1
if bash "$ROOT/scripts/egress-check.sh" >/dev/null 2>&1; then
  fail "gate PASSED with the sidecar down"
else
  pass "gate fails when the sidecar is down"
fi

bash "$ROOT/scripts/pipeline-net.sh" down >/dev/null 2>&1
pass "teardown clean"

if [[ $FAIL -eq 0 ]]; then echo "== ALL T6 CHECKS PASSED =="; else echo "== T6 CHECKS FAILED =="; fi
exit $FAIL
