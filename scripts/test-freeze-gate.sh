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
# batch of coverage lands (40 -> 90 with change-log row `freeze-brittleness-lint`, 90 -> 110
# with change-log row `repo-inj`), which is the only way a number like this stays worth
# asserting.
CHECKS="$(echo "$OUT" | grep -c '^PASS  ')"
if [ "$CHECKS" -ge 220 ]; then pass "checker ran $CHECKS checks"
else fail "checker ran only $CHECKS checks (expected at least 220)"; fi

# The three verdicts are reachable from a real command line, not only through the module.
# A stub `.js` run through node — never a `#!/bin/sh` script, which spawnSync cannot execute
# on the Windows host (CLAUDE.md, the Docker-free suite rule).
# Which TREE the stub is running in is read from a marker file in its own working directory,
# never from comparing `process.cwd()` to a string: on the reference host a temp path can be an
# 8.3 short name, and Git Bash and the child disagree on separators and case.
cat > "$TMP/stub.js" <<'STUB'
const fs = require('fs'); const path = require('path');
const mode = process.env.STUB_MODE || 'honest';
const inProbe = fs.existsSync(path.join(process.cwd(), '.is-probe'));
const isControl = /_control|freeze-gate-control/.test(process.argv[2] || '');
let n = 0; try { n = fs.readdirSync(process.argv[2]).length; } catch { n = 0; }
if (mode === 'always-green') process.exit(0);
if (mode === 'always-red') process.exit(4);
if (inProbe && mode === 'probe-broken') process.exit(1);
if (inProbe && mode === 'probe-red') process.exit(isControl ? 0 : 1);
if (inProbe) process.exit(0);
process.exit(n > 0 ? 1 : 0);
STUB
mkdir -p "$TMP/repo/tests/acceptance/demo"
echo '// a test' > "$TMP/repo/tests/acceptance/demo/test.js"
printf '{"verifyCommand":"unused"}' > "$TMP/repo/pipeline.config.json"
printf '1. does a thing\n2. [guard] existing behaviour holds\n' > "$TMP/spec.md"

# The target has to be a real git repository since change-log row `repo-erq`: the receipt the
# gate writes hashes the suite over git blob ids and records the checkout's HEAD, so a plain
# directory is refused at exit 2 before anything runs. Identity and `commit.gpgsign` go into
# the fixture's OWN config — a container has neither, and `-c` would have to precede the
# subcommand to work at all (change-log row `repo-cfe`).
git -C "$TMP/repo" init -q --initial-branch main . 2>/dev/null || git -C "$TMP/repo" init -q .
git -C "$TMP/repo" config user.email fixture@test.local
git -C "$TMP/repo" config user.name fixture
git -C "$TMP/repo" config commit.gpgsign false
git -C "$TMP/repo" config core.autocrlf false
git -C "$TMP/repo" config core.eol lf
git -C "$TMP/repo" add -A >/dev/null 2>&1
git -C "$TMP/repo" commit -qm fixture >/dev/null 2>&1
# The fixture's commit is its own check: a `git commit` that silently did nothing would leave
# every receipt assertion below passing or failing for a reason that is not about the gate.
if git -C "$TMP/repo" rev-parse HEAD >/dev/null 2>&1; then pass "the fixture repository has a commit"
else fail "the fixture repository has no commit — every receipt check below is meaningless"; fi

# The probe: a repo-shaped tree carrying the SAME suite, byte for byte, in which the criteria
# are already satisfied. A directory holding only the criteria's artifacts is not a probe.
mkdir -p "$TMP/probe/tests/acceptance/demo"
cp "$TMP/repo/tests/acceptance/demo/test.js" "$TMP/probe/tests/acceptance/demo/test.js"
printf '{"verifyCommand":"a probe-side config is never read"}' > "$TMP/probe/pipeline.config.json"
: > "$TMP/probe/.is-probe"

NODE_Q="$(printf '%s' "${TMP}/stub.js")"
export FREEZE_GATE_CMD="node \"$NODE_Q\""

node "$GATE" --repo "$TMP/repo" --tests tests/acceptance/demo/ --green "$TMP/probe" >/dev/null 2>&1; RC1=$?
if [ "$RC1" -eq 0 ]; then pass "CLI exits 0 on genuinely red tests with a green probe"; else fail "expected 0, got $RC1"; fi

STUB_MODE=always-green node "$GATE" --repo "$TMP/repo" --tests tests/acceptance/demo/ >/dev/null 2>&1; RC2=$?
if [ "$RC2" -eq 1 ]; then pass "CLI exits 1 when the tests pass at the fork point"; else fail "expected 1, got $RC2"; fi

STUB_MODE=always-red node "$GATE" --repo "$TMP/repo" --tests tests/acceptance/demo/ >/dev/null 2>&1; RC3=$?
if [ "$RC3" -eq 2 ]; then pass "CLI exits 2 when a broken harness cannot be told from red"; else fail "expected 2, got $RC3"; fi

# --- the green side, through a real command line (§3.2 move 1; change-log row `repo-inj`) ---
# Red at the fork point and a suite whose own fixture is broken are the SAME observation, so
# each of these states has to be reachable from a command line, not only from the module.
node "$GATE" --repo "$TMP/repo" --tests tests/acceptance/demo/ >/dev/null 2>&1; RC4=$?
if [ "$RC4" -eq 4 ]; then pass "CLI exits 4 — half-proven — when no probe is supplied"
else fail "expected 4 for a red run with no probe, got $RC4"; fi

STUB_MODE=probe-red node "$GATE" --repo "$TMP/repo" --tests tests/acceptance/demo/ --green "$TMP/probe" >/dev/null 2>&1; RC5=$?
if [ "$RC5" -eq 3 ]; then pass "CLI exits 3 — unreachable — when the tests are red in the probe too"
else fail "expected 3 for a red probe behind a green probe control, got $RC5"; fi

# The pair. A naive implementation answers 3 for both, and only running both tells them apart:
# exit 3 is reachable ONLY when the probe's own control comes back green.
STUB_MODE=probe-broken node "$GATE" --repo "$TMP/repo" --tests tests/acceptance/demo/ --green "$TMP/probe" >/dev/null 2>&1; RC6=$?
if [ "$RC6" -eq 2 ]; then pass "CLI exits 2, never 3, when the probe's own control is not green"
else fail "expected 2 for a broken probe, got $RC6"; fi

BROKEN_PROBE="$(STUB_MODE=probe-broken node "$GATE" --repo "$TMP/repo" --tests tests/acceptance/demo/ --green "$TMP/probe" 2>&1)"
echo "$BROKEN_PROBE" | grep -qi "probe" \
  && pass "the broken-probe report names the probe as the broken side" \
  || fail "the broken-probe report does not say which side is broken"

# An unusable probe path is refused NAMING THE PATH. Exit-code-only would pass vacuously: before
# this flag existed, --green hit `unexpected argument` and also exited 2.
MISSING_OUT="$(node "$GATE" --repo "$TMP/repo" --tests tests/acceptance/demo/ --green "$TMP/no-such-probe" 2>&1)"; MRC=$?
if [ "$MRC" -eq 2 ]; then pass "a --green path that does not exist exits 2"; else fail "expected 2, got $MRC"; fi
echo "$MISSING_OUT" | grep -q "no-such-probe" \
  && pass "the refusal names the offending path" || fail "the refusal does not name the path"

NOVAL_OUT="$(node "$GATE" --repo "$TMP/repo" --tests tests/acceptance/demo/ --green 2>&1)"; NRC=$?
if [ "$NRC" -eq 2 ]; then pass "--green with no value exits 2"; else fail "expected 2, got $NRC"; fi
echo "$NOVAL_OUT" | grep -q -- "--green" \
  && pass "and says which flag was given no value" || fail "the no-value refusal does not name --green"

# A probe that is not repo-shaped is the PROBE's bug, caught before any probe run.
mkdir -p "$TMP/shapeless"
SHAPELESS_OUT="$(node "$GATE" --repo "$TMP/repo" --tests tests/acceptance/demo/ --green "$TMP/shapeless" 2>&1)"; SRC=$?
if [ "$SRC" -eq 2 ]; then pass "a probe carrying no copy of the suite exits 2, not 3"
else fail "expected 2 for a probe with no suite, got $SRC"; fi
echo "$SHAPELESS_OUT" | grep -qi "repo-shaped" \
  && pass "and the message says what a probe actually is" || fail "the message does not say what a probe is"

# Nothing is left behind in the PROBE either — it is a throwaway tree, but a scratch directory
# surviving there is the same bug as one surviving in the repo, seen from the other side.
if ls -a "$TMP/probe" | grep -q 'freeze-gate-control'; then
  fail "a control directory was left behind in the probe"
else
  pass "no control directory is left in the probe"
fi

PROBE_REPORT="$(node "$GATE" --repo "$TMP/repo" --tests tests/acceptance/demo/ --green "$TMP/probe" 2>&1)"
echo "$PROBE_REPORT" | grep -q "probe run" \
  && pass "the report shows the probe run" || fail "the report hides the probe run"
echo "$PROBE_REPORT" | grep -q "probe control" \
  && pass "the report shows the probe's own control run" || fail "the report hides the probe control"

# The report has to say which state it is in and count guards, or the exit code is the only
# output and a human cannot act on it.
REPORT="$(node "$GATE" --repo "$TMP/repo" --tests tests/acceptance/demo/ --green "$TMP/probe" --spec "$TMP/spec.md" 2>&1)"
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
# The probe carries the same two files, byte for byte: a probe satisfies the criteria by
# changing the TREE, never by editing or dropping a check.
cp "$TMP/repo/tests/acceptance/demo/brittle.js" "$TMP/probe/tests/acceptance/demo/brittle.js"
cp "$TMP/repo/tests/acceptance/demo/logo.png" "$TMP/probe/tests/acceptance/demo/logo.png"
LINT="$(node "$GATE" --repo "$TMP/repo" --tests tests/acceptance/demo/ --green "$TMP/probe" 2>&1)"; LINT_RC=$?
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
# The lint runs ONCE, over the fork-point suite only. A probe is throwaway and deliberately
# crude; linting it produces findings nobody will ever fix, in a report whose whole value is
# that every finding takes a disposition.
cp "$TMP/repo/tests/acceptance/demo/brittle.js" "$TMP/probe/tests/acceptance/demo/probe-only.js"
LINT_ONCE="$(node "$GATE" --repo "$TMP/repo" --tests tests/acceptance/demo/ --green "$TMP/probe" 2>&1)"
echo "$LINT_ONCE" | grep -q "brittleness findings: 4" \
  && pass "the lint reads the fork-point suite only, not the probe's copy" \
  || fail "the lint count changed when the probe gained a brittle file"
rm -f "$TMP/probe/tests/acceptance/demo/probe-only.js"
rm -f "$TMP/repo/tests/acceptance/demo/brittle.js" "$TMP/repo/tests/acceptance/demo/logo.png"
rm -f "$TMP/probe/tests/acceptance/demo/brittle.js" "$TMP/probe/tests/acceptance/demo/logo.png"

GREEN_REPORT="$(STUB_MODE=always-green node "$GATE" --repo "$TMP/repo" --tests tests/acceptance/demo/ 2>&1)"
echo "$GREEN_REPORT" | grep -qi "guard" && pass "the green verdict names the guard escape" || fail "green verdict does not mention guards"

# Nothing is left in the target tree: this runs against a tree about to be committed and
# frozen, so a stray control directory would land inside the freeze.
if ls -a "$TMP/repo" | grep -q 'freeze-gate-control'; then
  fail "a control directory was left behind in the target repo"
else
  pass "no control directory is left in the target repo"
fi

# --- the freeze receipt, from a real command line -----------------------------------------
# DESIGN.md §3.2; change-log rows `receipt-design` and `repo-erq`. The formula and the field
# values are pinned in tests/unit/freeze-gate.test.js, which can call the module directly;
# what only a command line can show is that the file lands on disk where the playbook tells a
# planner to look for it, and that the report says so.
RECEIPT="$TMP/repo/tests/acceptance/demo/.freeze-gate.json"
rm -f "$RECEIPT"
RCPT_OUT="$(node "$GATE" --repo "$TMP/repo" --tests tests/acceptance/demo/ --green "$TMP/probe" 2>&1)"
if [ -f "$RECEIPT" ]; then pass "a proceeding verdict leaves .freeze-gate.json in the suite"
else fail "no receipt was written on exit 0"; fi
if [ -f "$TMP/probe/tests/acceptance/demo/.freeze-gate.json" ]; then
  fail "the PROBE gained a receipt — only the fork point's suite is gated"
else pass "the probe's copy of the suite gains no receipt"; fi
echo "$RCPT_OUT" | grep -q 'receipt written: tests/acceptance/demo/.freeze-gate.json' \
  && pass "the report names the receipt it wrote" \
  || fail "the report does not name the receipt"
node -e '
  const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const keys = Object.keys(r).sort().join(",");
  const want = "brittleness,gateHead,gateVersion,guards,probeSupplied,suiteHash,verdict,writtenAt";
  if (keys !== want) { console.error("keys: " + keys); process.exit(1); }
  if (r.gateVersion !== 1 || r.verdict !== "red" || r.probeSupplied !== true) process.exit(1);
  if (!/^[0-9a-f]{64}$/.test(r.suiteHash)) process.exit(1);
' "$RECEIPT" \
  && pass "the receipt parses and carries the agreed fields" \
  || fail "the receipt is missing, unparsable or wrong"

# A verdict that does not proceed writes nothing and leaves what is there alone: a stale
# receipt beside a failing verdict is the operator's evidence that the suite has moved.
cp "$RECEIPT" "$TMP/receipt-before.json"
STUB_MODE=always-green node "$GATE" --repo "$TMP/repo" --tests tests/acceptance/demo/ >/dev/null 2>&1
if cmp -s "$RECEIPT" "$TMP/receipt-before.json"; then pass "a green verdict leaves the receipt byte-identical"
else fail "a green verdict rewrote or removed the receipt"; fi
rm -f "$RECEIPT" "$TMP/receipt-before.json"

# A --repo with no git history is refused before anything runs — every value on the receipt
# comes from git, so the alternative is a receipt that hashes nothing.
mkdir -p "$TMP/nogit/tests/acceptance/demo"
echo '// a test' > "$TMP/nogit/tests/acceptance/demo/test.js"
printf '{"verifyCommand":"unused"}' > "$TMP/nogit/pipeline.config.json"
NOGIT_RC=0
NOGIT_OUT="$(node "$GATE" --repo "$TMP/nogit" --tests tests/acceptance/demo/ 2>&1)" || NOGIT_RC=$?
if [ "$NOGIT_RC" -eq 2 ]; then pass "a --repo that is not a git repository exits 2"
else fail "expected 2 for a non-git --repo, got $NOGIT_RC"; fi
echo "$NOGIT_OUT" | grep -qi "not a git repositor" \
  && pass "and the refusal says so in words" \
  || fail "the non-git refusal does not say what is wrong"
if [ -f "$TMP/nogit/tests/acceptance/demo/.freeze-gate.json" ]; then
  fail "a refused run still wrote a receipt"
else pass "a refused run writes no receipt"; fi

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
# A test that fails until something exists in the tree it is run from — the smallest honest
# criterion there is, and the only kind a probe can satisfy without touching the test itself.
printf "process.exit(require('fs').existsSync('PROBE-IMPLEMENTED') ? 0 : 1);\n" > "$PROOF/failing.js"
RED_RC=0
node "$GATE" --repo "$ROOT" --tests tests/acceptance/_freeze-gate-selftest/ >/dev/null 2>&1 || RED_RC=$?
if [ "$RED_RC" -eq 4 ]; then pass "real runner: a failing test directory with no probe is half-proven"
else fail "real runner: expected exit 4 for red with no probe, got $RED_RC"; fi

# The probe, built the way the playbook says to build one: the project's runner at the same
# relative path, a byte-identical copy of the suite, its own control, and the tree change that
# satisfies the criterion. With the command stubbed the probe's CONTENTS are irrelevant, so this
# is the only section here that can catch a probe-side path resolved wrongly — the miss
# change-log row `freeze-gate-red` records, from the other side.
GPROBE="$TMP/real-probe"
mkdir -p "$GPROBE/tools" "$GPROBE/tests/acceptance/_freeze-gate-selftest" "$GPROBE/tests/acceptance/_control"
cp "$ROOT/tools/run-acceptance.sh" "$GPROBE/tools/run-acceptance.sh"
cp "$PROOF/failing.js" "$GPROBE/tests/acceptance/_freeze-gate-selftest/failing.js"
cp "$ROOT/tests/acceptance/_control/"* "$GPROBE/tests/acceptance/_control/" 2>/dev/null
: > "$GPROBE/PROBE-IMPLEMENTED"
GREEN_RC=0
node "$GATE" --repo "$ROOT" --tests tests/acceptance/_freeze-gate-selftest/ --green "$GPROBE" >/dev/null 2>&1 || GREEN_RC=$?
if [ "$GREEN_RC" -eq 0 ]; then pass "real runner: red at the fork point and green in the probe is exit 0"
else fail "real runner: expected exit 0 with a satisfying probe, got $GREEN_RC"; fi

# The same probe with the RUNNER removed: that is the probe's bug, not the spec's, so it must be
# reported as a broken probe (2) and never as unsatisfiable criteria (3).
rm -f "$GPROBE/tools/run-acceptance.sh"
BAD_RC=0
BAD_OUT="$(node "$GATE" --repo "$ROOT" --tests tests/acceptance/_freeze-gate-selftest/ --green "$GPROBE" 2>&1)" || BAD_RC=$?
rm -rf "$PROOF"
if [ "$BAD_RC" -eq 2 ]; then pass "real runner: a probe missing the runner script is exit 2, not 3"
else fail "real runner: expected exit 2 for a probe with no runner, got $BAD_RC"; fi
echo "$BAD_OUT" | grep -qi "probe" \
  && pass "real runner: and the refusal names the probe as the broken side" \
  || fail "real runner: the refusal does not name the probe"

if [ "$FAIL" -eq 0 ]; then echo "== ALL freeze-gate CHECKS PASSED =="; else echo "== freeze-gate CHECKS FAILED =="; fi
exit $FAIL
