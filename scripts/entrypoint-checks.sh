#!/usr/bin/env bash
# T8 assertions — runs INSIDE the base image (invoked by test-entrypoint.sh).
# Exercises pipeline/entrypoint.sh via PIPELINE_AGENT_CMD stubs (the §4.3 seam).
# Copies each scenario's status.json to /out/<name>.json for host-side schema checks.
set -u
FAIL=0
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; FAIL=1; }
export PIPELINE_DIR=/pipeline-repo/pipeline

# --- Source fixture repo: frozen config + one acceptance test wanting out.txt. ---
mkdir -p /tmp/src && cd /tmp/src
git init -q -b main . && git config user.email t@test.local && git config user.name tester
cat > pipeline.config.json <<'EOF'
{"verifyCommand":"sh tools/run-tests.sh","frozenPaths":["tools/run-tests.sh"],"dependencies":{}}
EOF
mkdir -p tools tests/acceptance/T-3
cat > tools/run-tests.sh <<'EOF'
#!/bin/sh
for f in "$1"*.sh; do sh "$f" || exit 1; done
EOF
cat > tests/acceptance/T-3/test.sh <<'EOF'
#!/bin/sh
[ -f out.txt ] || { echo "out.txt missing"; exit 1; }
grep -q done out.txt || { echo "out.txt lacks 'done'"; exit 1; }
EOF
git add -A && git commit -qm "planning: frozen tests + config"

# --- Deterministic agent stubs (each consumes the prompt from stdin). ---
cat > /tmp/stub-ok.sh     <<'EOF'
cat > /tmp/last-prompt.txt
echo done > out.txt
EOF
cat > /tmp/stub-fail.sh   <<'EOF'
cat > /tmp/last-prompt.txt
echo "partial work, tests still red" >> notes.txt
EOF
cat > /tmp/stub-tamper.sh <<'EOF'
cat > /dev/null
echo "exit 0" > tests/acceptance/T-3/test.sh
EOF
cat > /tmp/stub-crash.sh  <<'EOF'
cat > /dev/null
exit 7
EOF

new_ws() { # new_ws <dir> — fresh clone on a task branch with the issue mounted
  rm -rf "$1"; git clone -q /tmp/src "$1"; cd "$1"; git checkout -qb task/T-3
  mkdir -p .run
  printf '## Description\nCreate out.txt containing the word done.\n' > .run/issue.md
}
run_ep() { # run_ep <ws> <stub> ; sets RC
  WORKSPACE="$1" ISSUE_ID=T-3 PIPELINE_AGENT_CMD="sh $2" \
    bash "$PIPELINE_DIR/entrypoint.sh" >/dev/null 2>&1
  RC=$?
}

echo "== T8 checks =="
MAIN_BEFORE=$(cd /tmp/src && git rev-parse main)

# 1. Success: agent satisfies the tests -> exit 0, verified commit, 1 pass attempt.
new_ws /tmp/ws1; run_ep /tmp/ws1 /tmp/stub-ok.sh
cp /tmp/ws1/.run/status.json /out/e1-success.json 2>/dev/null
[ "$RC" = 0 ] && pass "success: exit 0" || fail "success: rc=$RC"
(cd /tmp/ws1 && git log -1 --format=%s | grep -q "verified on attempt 1") \
  && pass "success: verified commit on task branch" || fail "success: commit missing"
(cd /tmp/ws1 && git show --stat HEAD | grep -q "out.txt") \
  && pass "success: work committed" || fail "success: out.txt not committed"
(cd /tmp/ws1 && git show --stat HEAD | grep -q ".run/") \
  && fail "success: .run/ leaked into the commit" || pass "success: .run/ excluded from commit"
grep -q '"verifierResult": "pass"' /out/e1-success.json \
  && pass "success: pass attempt recorded" || fail "success: status wrong"

# 2. Bail: agent never satisfies tests -> exactly 3 attempts, WIP commit, exit 10,
#    feedback from attempt N in attempt N+1's prompt.
new_ws /tmp/ws2; run_ep /tmp/ws2 /tmp/stub-fail.sh
cp /tmp/ws2/.run/status.json /out/e2-bail.json 2>/dev/null
[ "$RC" = 10 ] && pass "bail: exit 10" || fail "bail: rc=$RC"
[ "$(grep -c '"verifierResult": "fail"' /out/e2-bail.json)" = 3 ] \
  && pass "bail: exactly 3 fail attempts" || fail "bail: attempt count wrong"
grep -q '"stuckState"' /out/e2-bail.json && pass "bail: stuckState written" || fail "bail: no stuckState"
(cd /tmp/ws2 && git log -1 --format=%s | grep -q "^WIP: task T-3 bailed") \
  && pass "bail: WIP commit labeled" || fail "bail: WIP commit missing"
(cd /tmp/ws2 && git show --stat HEAD | grep -q notes.txt) \
  && pass "bail: partial work preserved in WIP commit" || fail "bail: partial work lost"
grep -q "out.txt missing" /tmp/last-prompt.txt && grep -q "TASK SPEC" /tmp/last-prompt.txt \
  && pass "bail: verifier feedback fed into next attempt's prompt" \
  || fail "bail: feedback loop broken"
grep -q '"feedback"' /out/e2-bail.json \
  && pass "bail: feedback recorded in attempt entries" || fail "bail: no feedback in status"

# 3. Tamper: agent edits a frozen test -> exit 11, WIP evidence commit.
new_ws /tmp/ws3; run_ep /tmp/ws3 /tmp/stub-tamper.sh
cp /tmp/ws3/.run/status.json /out/e3-tamper.json 2>/dev/null
[ "$RC" = 11 ] && pass "tamper: exit 11" || fail "tamper: rc=$RC"
(cd /tmp/ws3 && git log -1 --format=%s | grep -q "frozen tests were modified") \
  && pass "tamper: WIP evidence commit" || fail "tamper: commit missing"
grep -q '"verifierResult": "tampered"' /out/e3-tamper.json \
  && pass "tamper: recorded in status" || fail "tamper: status wrong"

# 4. Carry-over: 2 prior attempts in status.json (a rate-limit relaunch, §4.7)
#    -> only ONE more attempt runs, then bail. The 3-cap is a per-task invariant.
new_ws /tmp/ws4
cat > /tmp/ws4/.run/status.json <<'EOF'
{
  "issueId": "T-3",
  "attempts": [
    { "number": 1, "verifierResult": "fail", "timestamp": "2026-07-25T01:00:00Z" },
    { "number": 2, "verifierResult": "fail", "timestamp": "2026-07-25T01:10:00Z" }
  ]
}
EOF
run_ep /tmp/ws4 /tmp/stub-fail.sh
cp /tmp/ws4/.run/status.json /out/e4-carryover.json 2>/dev/null
[ "$RC" = 10 ] && pass "carry-over: exit 10" || fail "carry-over: rc=$RC"
[ "$(grep -c '"verifierResult"' /out/e4-carryover.json)" = 3 ] \
  && pass "carry-over: attempt counter continued (3 total, not reset)" \
  || fail "carry-over: counter reset or overran"

# 5. Agent command crashes -> exit 30 (internal error).
new_ws /tmp/ws5; run_ep /tmp/ws5 /tmp/stub-crash.sh
[ "$RC" = 30 ] && pass "crash: exit 30" || fail "crash: rc=$RC"

# 6. main is untouched by every scenario.
MAIN_AFTER=$(cd /tmp/src && git rev-parse main)
[ "$MAIN_BEFORE" = "$MAIN_AFTER" ] && pass "main untouched across all scenarios" \
                                    || fail "main moved!"

if [ "$FAIL" -eq 0 ]; then echo "== ALL IN-CONTAINER T8 CHECKS PASSED =="; else echo "== T8 CHECKS FAILED =="; fi
exit "$FAIL"
