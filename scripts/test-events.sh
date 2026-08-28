#!/usr/bin/env bash
# Copyright 2026 Chad Walker
# SPDX-License-Identifier: Apache-2.0

# repo-qzy checks — the event ledger, runs/<runId>/events.jsonl (DESIGN.md §4.12, §5;
# change-log rows `events-ledger-design` and `repo-qzy`).
#
# Two halves, and the second is the point of the file.
#
#   1. tests/unit/events.test.js — the writer, the schema, and their agreement with the
#      wording in runner/ and the prefix table in scripts/dashboard.js.
#   2. THE THREE READERS THE LEDGER SITS BESIDE. `scripts/dashboard.js`, `scripts/batch.js`
#      and `scripts/audit-runs.js` all parse `run.log` and `run.json` by hand. The ledger's
#      whole warrant is that it changed neither, and "run.log is unchanged" is a claim about
#      files nothing in the unit suite opens. Running their suites from here is what turns
#      that claim into a check, at the moment someone edits the ledger rather than months
#      later when a sweep finally runs.
#
# Docker-free, network-free and git-light: the Node suite builds throwaway repositories and
# runs roots under the OS temp directory and drives the real runner through its existing
# seams. The sweep discovers it by glob (scripts/test-*.sh) and it is safe to run anywhere
# node and git exist, including inside a task container.
#
# Run from Git Bash:  bash scripts/test-events.sh
# POSIX sh only in the body: it must also run as `sh <path>`, which is dash in a container
# and bash on the Windows host — all logic lives in the Node suites so no two shells can
# disagree about the result.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FAIL=0
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; FAIL=1; }

LC_ALL=C
export LC_ALL

# The child environment is SCRUBBED, and NODE_OPTIONS matters most: a `--require` stub set
# by whoever invoked this script preloads into every node process below, including the
# reader suites' own children, and a stub that exits kills them before their first line
# (CLAUDE.md's promoted rule). The PIPELINE_* family is the same hazard by another route —
# an inherited PIPELINE_BD_CMD or PIPELINE_EXEC_STUB decides what the runner does — and
# BD_* travels with it because the repo's bd stubs read BD_ISSUE_ID.
unset NODE_OPTIONS
for v in $(env | sed -n 's/^\(PIPELINE_[A-Za-z0-9_]*\)=.*/\1/p'); do unset "$v"; done
for v in $(env | sed -n 's/^\(BD_[A-Za-z0-9_]*\)=.*/\1/p'); do unset "$v"; done

echo "== repo-qzy checks: every run.log line has a structured twin =="

for f in runner/log.js schemas/events.schema.json tests/unit/events.test.js; do
  if [ -f "$ROOT/$f" ]; then pass "$f is present"; else fail "$f is missing"; fi
done

# Plain `node`, never `node --test`: this repo's assertion vocabulary is bare `ok - ` lines
# on stdout, and the TAP harness swallows them, so the count below would read zero against a
# fully green suite.
OUT="$(node "$ROOT/tests/unit/events.test.js" 2>&1)"; RC=$?
echo "$OUT"

if [ "$RC" -eq 0 ]; then
  pass "ledger checker exits 0"
else
  fail "ledger checker exited $RC"
fi

# The count itself — "assert the artifact is right, not merely present" applied to a suite:
# a checker that silently stopped running most of its fixtures would still exit 0. An
# honesty floor, not a target.
CHECKS="$(echo "$OUT" | grep -c '^ok - ')"
if [ "$CHECKS" -ge 45 ]; then
  pass "ledger checker ran $CHECKS checks"
else
  fail "ledger checker ran only $CHECKS checks (expected at least 45)"
fi

# The readers. Each is its own wrapper with its own seams and its own floor, so this asks
# them one question only: did you exit 0. What it proves is that adding the ledger moved
# nothing they read.
for reader in dashboard batch audit-runs; do
  W="$ROOT/scripts/test-$reader.sh"
  if [ ! -f "$W" ]; then
    fail "scripts/test-$reader.sh is missing — the ledger cannot show it left this reader alone"
    continue
  fi
  ROUT="$(bash "$W" 2>&1)"; RRC=$?
  if [ "$RRC" -eq 0 ]; then
    pass "reader suite test-$reader.sh still exits 0 ($(echo "$ROUT" | grep -c '^ok - ') checks)"
  else
    fail "reader suite test-$reader.sh exited $RRC"
    echo "$ROUT" | grep -E '^(FAIL|not ok)' | head -5
  fi
done

# The suites work in temp directories and start no run, so none of them may have written a
# run folder into this repo — a stray runs/<id>/ is indistinguishable from a real run.
LEFT="$(ls -d "$ROOT"/runs/unit-events-* 2>/dev/null | wc -l | tr -d ' ')"
if [ "$LEFT" = "0" ]; then
  pass "no run folder left behind in this repo's runs/"
else
  fail "$LEFT run folder(s) left in runs/"
fi

if [ "$FAIL" -eq 0 ]; then echo "== ALL repo-qzy CHECKS PASSED =="; else echo "== repo-qzy CHECKS FAILED =="; fi
exit $FAIL
