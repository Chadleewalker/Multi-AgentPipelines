#!/usr/bin/env bash
# Copyright 2026 Chad Walker
# SPDX-License-Identifier: Apache-2.0

# repo-4d8 checks — the two schemas that have to agree: the verifier's result file
# (schemas/verify.schema.json, DESIGN.md §4.4) and the per-run manifest
# (schemas/run.schema.json, §4.12).
#
# Why it is re-runnable rather than left frozen in tests/acceptance/repo-4d8/: the frozen
# suite is executed by pipeline/verify.js during its own task's run and never again —
# scripts/test-all.sh discovers suites by the glob scripts/test-*.sh and nothing in
# scripts/ ever runs an acceptance directory. The gap it closes reopens the moment someone
# adds a value to one schema and not the other, which is exactly what change-log row
# `verify-nobuffer` did: `runner/run.js` copies the verifier's verdicts onto the manifest
# task row VERBATIM, so the two enums are one vocabulary written down twice, and the drift
# stays invisible until a run emits the new value and its own run.json fails ajv.
#
# Docker-free, network-free, git-free and ajv-free: the Node checker reads two JSON files
# and compares them, in both directions, on both copied fields. The sweep discovers it by
# glob and it is safe to run anywhere node exists, including inside a task container.
#
# Run from Git Bash:  bash scripts/test-schema-drift.sh
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

# SCHEMA_DRIFT_DIR is deliberately NOT unset here, unlike the runs-corpus seams in
# scripts/test-audit-runs.sh and scripts/test-dashboard.sh. It names a directory holding
# two schema files — there is no private corpus to protect and no port to collide on — and
# passing it through is the whole point: it is how tests/acceptance/repo-4d8/ drives this
# suite against a PLANTED DRIFTED PAIR and observes it go red. A guard that has never been
# seen to fail is not a guard. Unset, the checker reads the repo's real schemas/.
if [ -n "${SCHEMA_DRIFT_DIR:-}" ]; then
  echo "== repo-4d8 checks: schema drift, against SCHEMA_DRIFT_DIR=$SCHEMA_DRIFT_DIR =="
else
  echo "== repo-4d8 checks: the verifier's vocabulary and the manifest's still agree =="
fi

# Presence is checked against the directory the checker will actually read, not against
# the repo's, or the seam drive would report on files it never opened.
DIR="${SCHEMA_DRIFT_DIR:-$ROOT/schemas}"
for f in run.schema.json verify.schema.json; do
  if [ -f "$DIR/$f" ]; then pass "$f is present"; else fail "$f is missing from $DIR"; fi
done

# Plain `node`, never `node --test`: this repo's assertion vocabulary is bare `ok - ` lines
# on stdout, and the TAP harness swallows them, so the count below would read zero against
# a fully green suite.
OUT="$(node "$ROOT/tests/unit/schema-drift.test.js" 2>&1)"; RC=$?
echo "$OUT"

if [ "$RC" -eq 0 ]; then
  pass "schema-drift checker exits 0"
else
  fail "schema-drift checker exited $RC"
fi

# The count itself — "assert the artifact is right, not merely present" (CLAUDE.md §3.6)
# applied to a suite: a checker that silently stopped comparing most of its enums would
# still exit 0. This is an honesty floor, not a target.
CHECKS="$(echo "$OUT" | grep -c '^ok - ')"
if [ "$CHECKS" -ge 12 ]; then
  pass "checker ran $CHECKS checks"
else
  fail "checker ran only $CHECKS checks (expected at least 12)"
fi

if [ "$FAIL" -eq 0 ]; then echo "== ALL repo-4d8 CHECKS PASSED =="; else echo "== repo-4d8 CHECKS FAILED =="; fi
exit $FAIL
