#!/usr/bin/env bash
# Copyright 2026 Chad Walker
# SPDX-License-Identifier: Apache-2.0

# T7 assertions — runs INSIDE the base image (invoked by test-verifier.sh).
# Builds fixture repos and exercises pipeline/verify.js through every scenario.
# Copies each scenario's verify.json to /out/<name>.json for host-side schema checks.
set -u
FAIL=0
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; FAIL=1; }
V="node /pipeline-repo/pipeline/verify.js"

# Fixture repo: main has config, runner script, regression script, two acceptance dirs.
mk_repo() { # mk_repo <dir> <config-json>
  mkdir -p "$1" && cd "$1"
  git init -q -b main . && git config user.email t@test.local && git config user.name tester
  printf '%s\n' "$2" > pipeline.config.json
  mkdir -p tools "tests/acceptance/T-1" "tests/acceptance/T-2"
  cat > tools/run-tests.sh <<'EOF'
#!/bin/sh
for f in "$1"*.sh; do sh "$f" || exit 1; done
EOF
  printf '#!/bin/sh\nexit "${REGRESS_RC:-0}"\n' > tools/regress.sh
  printf '#!/bin/sh\nexit 0\n' > tests/acceptance/T-1/test.sh
  printf '#!/bin/sh\necho "assertion failed: widget not renamed" >&2\nexit 1\n' > tests/acceptance/T-2/test.sh
  git add -A && git commit -qm "planning: frozen tests + config"
  git checkout -qb task/test
}
run() { # run <issue-id> <workspace> ; sets RC and copies verify.json
  ISSUE_ID="$1" WORKSPACE="$2" node /pipeline-repo/pipeline/verify.js >/dev/null 2>&1
  RC=$?
  cp "$2/.run/verify.json" "/out/$3.json" 2>/dev/null || true
}

echo "== T7 checks =="
CFG='{"verifyCommand":"sh tools/run-tests.sh","regressionCommand":"sh tools/regress.sh","frozenPaths":["tools/run-tests.sh"],"dependencies":{}}'
mk_repo /tmp/fx "$CFG"

# 1. Passing acceptance + passing regressions -> exit 0.
run T-1 /tmp/fx s1-pass
[ "$RC" = 0 ] && grep -q '"acceptance": "pass"' /out/s1-pass.json \
              && grep -q '"regressions": "pass"' /out/s1-pass.json \
  && pass "pass: exit 0, acceptance+regressions pass" || fail "pass scenario (rc=$RC)"

# 2. Failing acceptance -> exit 1, failure output captured as feedback.
run T-2 /tmp/fx s2-fail
[ "$RC" = 1 ] && grep -q '"acceptance": "fail"' /out/s2-fail.json \
              && grep -q 'widget not renamed' /out/s2-fail.json \
  && pass "fail: exit 1, output captured for next attempt" || fail "fail scenario (rc=$RC)"

# 3. Modified frozen test -> tampered, exit 3, tests NOT run.
echo "exit 0" > /tmp/fx/tests/acceptance/T-2/test.sh
run T-2 /tmp/fx s3-tamper
[ "$RC" = 3 ] && grep -q '"acceptance": "tampered"' /out/s3-tamper.json \
              && grep -q 'tests/acceptance/T-2/test.sh' /out/s3-tamper.json \
  && pass "tamper-modify: caught, tests not run" || fail "tamper-modify (rc=$RC)"
(cd /tmp/fx && git checkout -q -- tests/)

# 4. Untracked file added under the acceptance tree -> tampered.
echo "exit 0" > /tmp/fx/tests/acceptance/T-1/sneaky.sh
run T-1 /tmp/fx s4-untracked
[ "$RC" = 3 ] && grep -q 'sneaky.sh' /out/s4-untracked.json \
  && pass "tamper-untracked: new file caught" || fail "tamper-untracked (rc=$RC)"
rm /tmp/fx/tests/acceptance/T-1/sneaky.sh

# 5. frozenPaths helper edited (the script verifyCommand runs) -> tampered.
printf '#!/bin/sh\nexit 0\n' > /tmp/fx/tools/run-tests.sh
run T-2 /tmp/fx s5-frozen
[ "$RC" = 3 ] && grep -q 'tools/run-tests.sh' /out/s5-frozen.json \
  && pass "tamper-frozenPath: runner-script edit caught" || fail "tamper-frozenPath (rc=$RC)"
(cd /tmp/fx && git checkout -q -- tools/)

# 6. Worktree config edited to a trivial verifyCommand -> IGNORED (fork-point config
#    governs); failing task still fails.
printf '{"verifyCommand":"true","dependencies":{}}\n' > /tmp/fx/pipeline.config.json
run T-2 /tmp/fx s6-cfgedit
[ "$RC" = 1 ] && grep -q '"acceptance": "fail"' /out/s6-cfgedit.json \
  && pass "config-edit: fork-point config governs, task still fails" || fail "config-edit (rc=$RC)"
(cd /tmp/fx && git checkout -q -- pipeline.config.json)

# 7. Failing regressions never change the gate: acceptance pass -> exit 0, partial signal recorded.
REGRESS_RC=1 ISSUE_ID=T-1 WORKSPACE=/tmp/fx node /pipeline-repo/pipeline/verify.js >/dev/null 2>&1
RC=$?; cp /tmp/fx/.run/verify.json /out/s7-regfail.json
[ "$RC" = 0 ] && grep -q '"acceptance": "pass"' /out/s7-regfail.json \
              && grep -q '"regressions": "fail"' /out/s7-regfail.json \
  && pass "regression-fail: evidence only, exit still 0 (partial)" || fail "regression-fail (rc=$RC)"

# 8. No regressionCommand in frozen config -> regressions: absent.
mk_repo /tmp/fx2 '{"verifyCommand":"sh tools/run-tests.sh","dependencies":{}}'
run T-1 /tmp/fx2 s8-noreg
[ "$RC" = 0 ] && grep -q '"regressions": "absent"' /out/s8-noreg.json \
  && pass "no regressionCommand: recorded as absent" || fail "no-regression (rc=$RC)"

# 9. Missing ISSUE_ID -> error, exit 4.
WORKSPACE=/tmp/fx node /pipeline-repo/pipeline/verify.js >/dev/null 2>&1
[ $? = 4 ] && pass "missing ISSUE_ID: exit 4 (error)" || fail "missing ISSUE_ID"

# 9b. No buildCommand in the frozen config -> build: absent (legacy targets unchanged).
#     (s1-pass.json is fixture /tmp/fx, which declares no buildCommand — repo-cl9.)
grep -q '"build": "absent"' /out/s1-pass.json \
  && pass "no buildCommand: recorded as absent" || fail "build-absent (legacy target changed)"

# --- Build gate (repo-cl9): buildCommand in the FROZEN config is a REQUIRED gate. A
#     passing acceptance suite can sit atop a broken production build (Deep End PR #62),
#     so a build failure must force exit 1, and neither a worktree edit to the command nor
#     to a frozen helper it runs can weaken it. tools/build.sh passes iff compile.ok exists.
mkbuild() {
  rm -rf /tmp/fxb; mkdir -p /tmp/fxb; cd /tmp/fxb
  git init -q -b main . && git config user.email t@test.local && git config user.name tester
  printf '%s\n' '{"verifyCommand":"sh tools/run-tests.sh","buildCommand":"sh tools/build.sh","frozenPaths":["tools/run-tests.sh","tools/build.sh"],"dependencies":{}}' > pipeline.config.json
  mkdir -p tools tests/acceptance/T-1
  printf '#!/bin/sh\nfor f in "$1"*.sh; do sh "$f" || exit 1; done\n' > tools/run-tests.sh
  printf '#!/bin/sh\ntest -f compile.ok\n' > tools/build.sh
  printf '#!/bin/sh\nexit 0\n' > tests/acceptance/T-1/test.sh
  git add -A && git commit -qm "planning: frozen tests + build" >/dev/null
  git checkout -qb task/test
}
mkbuild

# 10. Acceptance passes but the build fails -> exit 1, build fail (cannot mask).
run T-1 /tmp/fxb s10-buildfail
[ "$RC" = 1 ] && grep -q '"acceptance": "pass"' /out/s10-buildfail.json \
              && grep -q '"build": "fail"' /out/s10-buildfail.json \
  && pass "build-gate: passing acceptance cannot mask a failing build" || fail "build-fail (rc=$RC)"

# 11. A clean build -> exit 0, build pass.
echo ok > /tmp/fxb/compile.ok
run T-1 /tmp/fxb s11-buildpass
[ "$RC" = 0 ] && grep -q '"build": "pass"' /out/s11-buildpass.json \
  && pass "build-gate: a clean build permits success" || fail "build-pass (rc=$RC)"

# 12. Worktree config edited to a trivial buildCommand -> IGNORED (fork-point governs).
rm /tmp/fxb/compile.ok
printf '%s\n' '{"verifyCommand":"sh tools/run-tests.sh","buildCommand":"true","frozenPaths":["tools/run-tests.sh","tools/build.sh"],"dependencies":{}}' > /tmp/fxb/pipeline.config.json
run T-1 /tmp/fxb s12-buildcfg
[ "$RC" = 1 ] && grep -q '"build": "fail"' /out/s12-buildcfg.json \
  && pass "build-gate: worktree config cannot weaken the frozen build command" || fail "build-cfg (rc=$RC)"
(cd /tmp/fxb && git checkout -q -- pipeline.config.json)

# 13. frozenPaths build helper edited -> tampered, build never run.
printf '#!/bin/sh\nexit 0\n' > /tmp/fxb/tools/build.sh
run T-1 /tmp/fxb s13-buildtamper
[ "$RC" = 3 ] && grep -q 'tools/build.sh' /out/s13-buildtamper.json \
  && pass "build-gate: editing a frozen build helper is tampering" || fail "build-tamper (rc=$RC)"
(cd /tmp/fxb && git checkout -q -- tools/)

if [ "$FAIL" -eq 0 ]; then echo "== ALL IN-CONTAINER T7 CHECKS PASSED =="; else echo "== T7 CHECKS FAILED =="; fi
exit "$FAIL"
