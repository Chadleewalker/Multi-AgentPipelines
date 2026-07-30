#!/usr/bin/env bash
# Copyright 2026 Chad Walker
# SPDX-License-Identifier: Apache-2.0

# Acceptance checks for the pre-critic spec lint (DESIGN.md §3.2, "Below the panel",
# move 3a; change-log row `spec-lint-frozen-paths`).
#
# Docker-free and network-free: the checker builds its fixtures in memory and reads only
# tracked files, so this needs no base image, no pipeline network and no target repo. The
# sweep discovers it by glob (scripts/test-*.sh) and it is safe to run anywhere, including
# inside a task container.
#
# Two layers, because they fail differently. The Node checker covers the matching rules from
# both sides — a fixture that must fire, and near-misses that must not. This wrapper covers
# the CLI contract the playbook actually tells a person to type: the exit codes, and the
# refusal to run without a target. A rule that works through the module and a command that
# reports it are separate things, and only the second is what anyone uses.
#
# Run from Git Bash:  bash scripts/test-spec-lint.sh
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LINT="$ROOT/scripts/spec-lint.js"
FAIL=0
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; FAIL=1; }

# Fixtures live under the scratch dir, never the repo: a spec fixture that names a frozen
# path is exactly what this repo's own lint would flag if it were tracked.
TMP="$(mktemp -d 2>/dev/null || echo "${TEMP:-/tmp}/spec-lint-$$")"
mkdir -p "$TMP"
trap 'rm -rf "$TMP"' EXIT

echo "== spec-lint checks: criteria naming frozen paths =="

# Layer 1 — the matching rules.
OUT="$(node "$ROOT/tests/unit/spec-lint.test.js" 2>&1)"; RC=$?
echo "$OUT"
if [ "$RC" -eq 0 ]; then pass "spec-lint checker exits 0"; else fail "spec-lint checker exited $RC"; fi
CHECKS="$(echo "$OUT" | grep -c '^PASS  ')"
if [ "$CHECKS" -ge 14 ]; then pass "checker ran $CHECKS checks"
else fail "checker ran only $CHECKS checks (expected at least 14)"; fi

# Layer 2 — the CLI contract.

# A spec that orders an edit to a frozen path: exit 1, and say which path and which line.
printf '## Done means\n\n1. The checker is invoked by `tools/run-acceptance.sh`.\n' > "$TMP/dirty.md"
CLI_OUT="$(node "$LINT" --repo "$ROOT" "$TMP/dirty.md" 2>&1)"; CLI_RC=$?
if [ "$CLI_RC" -eq 1 ]; then pass "CLI exits 1 on a criterion naming a frozen path"
else fail "CLI exited $CLI_RC on a dirty spec (expected 1)"; fi
# Exit code alone would be satisfied by a crash — pin the report's content too.
if echo "$CLI_OUT" | grep -q "tools/run-acceptance.sh"; then pass "CLI names the frozen path it matched"
else fail "CLI output does not name the frozen path"; fi
if echo "$CLI_OUT" | grep -q ":3 "; then pass "CLI reports the offending line number"
else fail "CLI output carries no line number"; fi
if echo "$CLI_OUT" | grep -qi "tamper"; then pass "CLI says why it matters"
else fail "CLI output does not explain the finding"; fi

# A spec that names only the acceptance directory is normal and must pass — this is the
# check that keeps the tool switched on rather than deleted for crying wolf.
printf '## Done means\n\n1. Tests live at `tests/acceptance/repo-abc/`.\n' > "$TMP/clean.md"
if node "$LINT" --repo "$ROOT" "$TMP/clean.md" >/dev/null 2>&1; then
  pass "CLI exits 0 on a spec naming only the acceptance directory"
else fail "CLI flagged a normal spec (it would be turned off within a week)"; fi

# --frozen stands in for a target repo, so the lint works on a spec drafted before the
# target is onboarded.
if node "$LINT" --frozen tools/run-regression.sh "$TMP/clean.md" >/dev/null 2>&1; then
  pass "--frozen accepts an explicit list"
else fail "--frozen rejected a clean spec"; fi

# Could-not-run is exit 2, distinct from found-something (1). A tool that returns the same
# code for "clean" and "never ran" is the presence-standing-in-for-correctness trap in CLI
# form: a typo'd path would read as a passing lint.
node "$LINT" "$TMP/clean.md" >/dev/null 2>&1; RC2=$?
if [ "$RC2" -eq 2 ]; then pass "exit 2 when neither --repo nor --frozen is given"
else fail "expected exit 2 with no target, got $RC2"; fi
node "$LINT" --repo "$TMP" "$TMP/clean.md" >/dev/null 2>&1; RC3=$?
if [ "$RC3" -eq 2 ]; then pass "exit 2 when the target has no pipeline.config.json"
else fail "expected exit 2 for a missing config, got $RC3"; fi
node "$LINT" --repo "$ROOT" "$TMP/does-not-exist.md" >/dev/null 2>&1; RC4=$?
if [ "$RC4" -eq 2 ]; then pass "exit 2 when the spec file is unreadable"
else fail "expected exit 2 for a missing spec file, got $RC4"; fi

if [ "$FAIL" -eq 0 ]; then echo "== ALL spec-lint CHECKS PASSED =="; else echo "== spec-lint CHECKS FAILED =="; fi
exit $FAIL
