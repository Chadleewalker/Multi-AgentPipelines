#!/usr/bin/env bash
# Copyright 2026 Chad Walker
# SPDX-License-Identifier: Apache-2.0

# Acceptance checks for the fork-point red gate (DESIGN.md §3.2, "Below the panel", move 1;
# change-log row `freeze-gate-red`).
#
# Docker-free and network-free: the target's verify command is stubbed through
# FREEZE_GATE_CMD, so nothing here needs an engine, an image or a target repo. The sweep
# discovers it by glob and it is safe to run anywhere, including inside a task container.
#
# Run from Git Bash:  bash scripts/test-freeze-gate.sh
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GATE="$ROOT/scripts/freeze-gate.js"
FAIL=0
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; FAIL=1; }

TMP="$(mktemp -d 2>/dev/null || echo "${TEMP:-/tmp}/freeze-gate-$$")"
mkdir -p "$TMP"
trap 'rm -rf "$TMP"' EXIT

echo "== freeze-gate checks: tests must be red at the fork point =="

OUT="$(node "$ROOT/tests/unit/freeze-gate.test.js" 2>&1)"; RC=$?
echo "$OUT"
if [ "$RC" -eq 0 ]; then pass "freeze-gate checker exits 0"; else fail "freeze-gate checker exited $RC"; fi
# A FLOOR, never an equality — and deliberately so, because an exact count here would be an
# instance of the very shape the brittleness lint below warns about: later work is licensed to
# add checks to that file, and `-eq` would go red for exactly that. The floor moves up when a
# batch of coverage lands (40 -> 90 with change-log row `freeze-brittleness-lint`), which is
# the only way a number like this stays worth asserting.
CHECKS="$(echo "$OUT" | grep -c '^PASS  ')"
if [ "$CHECKS" -ge 90 ]; then pass "checker ran $CHECKS checks"
else fail "checker ran only $CHECKS checks (expected at least 90)"; fi

# The three verdicts are reachable from a real command line, not only through the module.
# A stub `.js` run through node — never a `#!/bin/sh` script, which spawnSync cannot execute
# on the Windows host (CLAUDE.md, the Docker-free suite rule).
cat > "$TMP/stub.js" <<'STUB'
const fs = require('fs');
const mode = process.env.STUB_MODE || 'honest';
if (mode === 'always-green') process.exit(0);
if (mode === 'always-red') process.exit(4);
let n = 0; try { n = fs.readdirSync(process.argv[2]).length; } catch { n = 0; }
process.exit(n > 0 ? 1 : 0);
STUB
mkdir -p "$TMP/repo/tests/acceptance/demo"
echo '// a test' > "$TMP/repo/tests/acceptance/demo/test.js"
printf '{"verifyCommand":"unused"}' > "$TMP/repo/pipeline.config.json"
printf '1. does a thing\n2. [guard] existing behaviour holds\n' > "$TMP/spec.md"

NODE_Q="$(printf '%s' "${TMP}/stub.js")"
export FREEZE_GATE_CMD="node \"$NODE_Q\""

node "$GATE" --repo "$TMP/repo" --tests tests/acceptance/demo/ >/dev/null 2>&1; RC1=$?
if [ "$RC1" -eq 0 ]; then pass "CLI exits 0 on genuinely red tests"; else fail "expected 0, got $RC1"; fi

STUB_MODE=always-green node "$GATE" --repo "$TMP/repo" --tests tests/acceptance/demo/ >/dev/null 2>&1; RC2=$?
if [ "$RC2" -eq 1 ]; then pass "CLI exits 1 when the tests pass at the fork point"; else fail "expected 1, got $RC2"; fi

STUB_MODE=always-red node "$GATE" --repo "$TMP/repo" --tests tests/acceptance/demo/ >/dev/null 2>&1; RC3=$?
if [ "$RC3" -eq 2 ]; then pass "CLI exits 2 when a broken harness cannot be told from red"; else fail "expected 2, got $RC3"; fi

# The report has to say which state it is in and count guards, or the exit code is the only
# output and a human cannot act on it.
REPORT="$(node "$GATE" --repo "$TMP/repo" --tests tests/acceptance/demo/ --spec "$TMP/spec.md" 2>&1)"
echo "$REPORT" | grep -q "RED:" && pass "report names the verdict" || fail "report does not name the verdict"
echo "$REPORT" | grep -q "control run" && pass "report shows the control run" || fail "report hides the control run"
echo "$REPORT" | grep -q "guards declared: 1" && pass "report counts declared guards" || fail "report does not count guards"

# --- the brittleness lint, through a real command line (§3.2, "below the panel", move 6) ---
# The count prints even at zero: a discriminator silent on a clean suite cannot be told from
# one that never ran. `demo/` holds one comment and nothing else.
echo "$REPORT" | grep -q "brittleness findings: 0" \
  && pass "the brittleness count prints even when it is zero" \
  || fail "the brittleness count is silent on a clean suite"

cat > "$TMP/repo/tests/acceptance/demo/brittle.js" <<'BRITTLE'
assert.deepStrictEqual(keys, ['alpha', 'beta', 'gamma']);
assert.strictEqual(rows.length, 30);
assert.strictEqual(sha1(tree), 'd41d8cd98f00b204e9800998ecf8427e');
spawnSync('git', ['merge-base', 'origin/main', 'HEAD']);
BRITTLE
printf '\211PNG' > "$TMP/repo/tests/acceptance/demo/logo.png"
LINT="$(node "$GATE" --repo "$TMP/repo" --tests tests/acceptance/demo/ 2>&1)"; LINT_RC=$?
# The exit code is a verdict about red, green and indeterminate. A lint that can fail a freeze
# is a gate on spec AUTHORING, and the way past a gate that can fail you is to reword until it
# passes (hard rule 5) — so four findings must leave a red run reading exactly 0.
if [ "$LINT_RC" -eq 0 ]; then pass "findings do not move the exit code"
else fail "findings moved the exit code to $LINT_RC"; fi
echo "$LINT" | grep -q "brittleness findings: 4" \
  && pass "all four shapes are counted" || fail "the lint did not report four findings"
echo "$LINT" | grep -q "brittle.js:1  \[literal-name-list\]" \
  && pass "a finding names its file, line and shape" || fail "a finding is not file:line [shape]"
echo "$LINT" | grep -q "skipped: logo.png  (extension)" \
  && pass "a skipped path is named with its pinned reason" || fail "a skipped path is not named"
rm -f "$TMP/repo/tests/acceptance/demo/brittle.js" "$TMP/repo/tests/acceptance/demo/logo.png"

GREEN_REPORT="$(STUB_MODE=always-green node "$GATE" --repo "$TMP/repo" --tests tests/acceptance/demo/ 2>&1)"
echo "$GREEN_REPORT" | grep -qi "guard" && pass "the green verdict names the guard escape" || fail "green verdict does not mention guards"

# Nothing is left in the target tree: this runs against a tree about to be committed and
# frozen, so a stray control directory would land inside the freeze.
if ls -a "$TMP/repo" | grep -q 'freeze-gate-control'; then
  fail "a control directory was left behind in the target repo"
else
  pass "no control directory is left in the target repo"
fi

# The control convention, through the CLI. With no fixture the report must ADMIT the
# discriminator is weak rather than quietly proceeding on it.
WEAK="$(STUB_MODE=always-red node "$GATE" --repo "$TMP/repo" --tests tests/acceptance/demo/ 2>&1)"
echo "$WEAK" | grep -q "NO control fixture" \
  && pass "the report admits when no control fixture exists" \
  || fail "a weak control is not announced in the report"
echo "$WEAK" | grep -q "_control" \
  && pass "the weak-control message names the fixture to add" \
  || fail "the weak-control message does not say how to fix it"

mkdir -p "$TMP/repo/tests/acceptance/_control"
echo 'process.exit(0);' > "$TMP/repo/tests/acceptance/_control/c.js"
WITH="$(node "$GATE" --repo "$TMP/repo" --tests tests/acceptance/demo/ 2>&1)"
echo "$WITH" | grep -q "one passing test" \
  && pass "a present _control fixture is used and named" \
  || fail "the _control fixture was not picked up"

# --- against the REAL verify command, not the stub ---------------------------------------
# The stub proves the decision table; only this proves the gate works with a verify command
# that was not written to accommodate it. The empty-directory control survived every stubbed
# check and died on the first real runner, which is the whole reason this section exists.
unset FREEZE_GATE_CMD
REAL_RC=0
node "$GATE" --repo "$ROOT" --tests tests/acceptance/_control/ >/dev/null 2>&1 || REAL_RC=$?
# _control passes by construction, so the gate must call it GREEN — exit 1.
if [ "$REAL_RC" -eq 1 ]; then pass "real runner: a passing test directory is reported green"
else fail "real runner: expected exit 1 for a green directory, got $REAL_RC"; fi

PROOF="$ROOT/tests/acceptance/_freeze-gate-selftest"
mkdir -p "$PROOF"
printf 'process.exit(1);\n' > "$PROOF/failing.js"
RED_RC=0
node "$GATE" --repo "$ROOT" --tests tests/acceptance/_freeze-gate-selftest/ >/dev/null 2>&1 || RED_RC=$?
rm -rf "$PROOF"
if [ "$RED_RC" -eq 0 ]; then pass "real runner: a failing test directory is reported red"
else fail "real runner: expected exit 0 for genuine red, got $RED_RC"; fi

if [ "$FAIL" -eq 0 ]; then echo "== ALL freeze-gate CHECKS PASSED =="; else echo "== freeze-gate CHECKS FAILED =="; fi
exit $FAIL
