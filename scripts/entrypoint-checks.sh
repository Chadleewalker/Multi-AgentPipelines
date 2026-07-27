#!/usr/bin/env bash
# Copyright 2026 Chad Walker
# SPDX-License-Identifier: Apache-2.0

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
# Smart stub: code phase satisfies the tests; docs phase updates README and
# prints the change summary (distinguished by the docs prompt's wording).
cat > /tmp/stub-smart.sh  <<'EOF'
PROMPT=$(cat)
case "$PROMPT" in
  *"change summary"*) echo "docs updated" >> README.md
                      printf 'Created out.txt with the done marker; README updated.' ;;
  *)                  echo done > out.txt ;;
esac
EOF
# Docs-fail stub: code phase succeeds, docs phase errors.
cat > /tmp/stub-docsfail.sh <<'EOF'
PROMPT=$(cat)
case "$PROMPT" in
  *"change summary"*) exit 1 ;;
  *)                  echo done > out.txt ;;
esac
EOF
cat > /tmp/stub-ratelimit.sh <<'EOF'
cat > /dev/null
echo "Claude AI usage limit reached|1753500000"
exit 1
EOF
cat > /tmp/stub-ratelimit-noreset.sh <<'EOF'
cat > /dev/null
echo "Error: usage limit reached - try again later"
exit 1
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
(cd /tmp/ws2 && git log --stat | grep -q notes.txt) \
  && pass "bail: partial work preserved in boundary commits" || fail "bail: partial work lost"
[ "$(cd /tmp/ws2 && git log --format=%s | grep -c 'verification failed')" = 3 ] \
  && pass "bail: per-attempt boundary commits (kill-loss window = one attempt)" \
  || fail "bail: boundary commits missing"
grep -q '"changeSummary"' /out/e2-bail.json \
  && fail "bail: docs phase ran on a failed path" || pass "bail: no docs phase on failure"
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

# 7. Docs phase (T9): summary into status.json, docs committed, success stands.
new_ws /tmp/ws7; run_ep /tmp/ws7 /tmp/stub-smart.sh
cp /tmp/ws7/.run/status.json /out/e7-docs.json 2>/dev/null
[ "$RC" = 0 ] && pass "docs: exit 0" || fail "docs: rc=$RC"
grep -q '"changeSummary": "Created out.txt' /out/e7-docs.json \
  && pass "docs: change summary in status.json" || fail "docs: summary missing"
(cd /tmp/ws7 && git log --format=%s | grep -q "^Task T-3: docs$") \
  && pass "docs: docs commit after implementation commit" || fail "docs: commit missing"
(cd /tmp/ws7 && git show --stat HEAD | grep -q README.md) \
  && pass "docs: README update committed" || fail "docs: README not committed"

# 8. Docs phase errors after verified success (T9): non-fatal, exit stays 0.
new_ws /tmp/ws8; run_ep /tmp/ws8 /tmp/stub-docsfail.sh
cp /tmp/ws8/.run/status.json /out/e8-docsfail.json 2>/dev/null
[ "$RC" = 0 ] && pass "docs-fail: exit still 0 (success stands)" || fail "docs-fail: rc=$RC"
grep -q '"docsPhaseError"' /out/e8-docsfail.json \
  && pass "docs-fail: docsPhaseError recorded" || fail "docs-fail: error not recorded"

# 9. Rate limit with reset time (T10): exit 20, reset recorded, zero attempts consumed.
new_ws /tmp/ws9; run_ep /tmp/ws9 /tmp/stub-ratelimit.sh
cp /tmp/ws9/.run/status.json /out/e9-ratelimit.json 2>/dev/null
[ "$RC" = 20 ] && pass "rate-limit: exit 20" || fail "rate-limit: rc=$RC"
grep -q '"rateLimitResetAt": "2025-07-26T' /out/e9-ratelimit.json \
  && pass "rate-limit: reset time recorded (epoch converted)" || fail "rate-limit: reset missing"
grep -q '"attempts": \[\]' /out/e9-ratelimit.json \
  && pass "rate-limit: no attempt consumed" || fail "rate-limit: attempt wrongly consumed"

# 10. Rate limit without a reset time (T10): exit 20, no reset field, still schema-valid.
new_ws /tmp/ws10; run_ep /tmp/ws10 /tmp/stub-ratelimit-noreset.sh
cp /tmp/ws10/.run/status.json /out/e10-ratelimit-noreset.json 2>/dev/null
[ "$RC" = 20 ] && pass "rate-limit-noreset: exit 20" || fail "rate-limit-noreset: rc=$RC"
grep -q '"rateLimitResetAt"' /out/e10-ratelimit-noreset.json \
  && fail "rate-limit-noreset: spurious reset time" || pass "rate-limit-noreset: no reset field"

# 11. Tunable attempt cap (§4.6): PIPELINE_MAX_ATTEMPTS=2 -> exactly 2 attempts, bail.
new_ws /tmp/ws11
WORKSPACE=/tmp/ws11 ISSUE_ID=T-3 PIPELINE_AGENT_CMD="sh /tmp/stub-fail.sh" \
  PIPELINE_MAX_ATTEMPTS=2 bash "$PIPELINE_DIR/entrypoint.sh" >/dev/null 2>&1
RC=$?
cp /tmp/ws11/.run/status.json /out/e11-maxattempts.json 2>/dev/null
[ "$RC" = 10 ] && pass "max-attempts: exit 10 at the tuned cap" || fail "max-attempts: rc=$RC"
[ "$(grep -c '"verifierResult": "fail"' /out/e11-maxattempts.json)" = 2 ] \
  && pass "max-attempts: exactly 2 attempts when cap=2" || fail "max-attempts: attempt count wrong"

# 12. Invalid cap falls back to the default of 3.
new_ws /tmp/ws12
WORKSPACE=/tmp/ws12 ISSUE_ID=T-3 PIPELINE_AGENT_CMD="sh /tmp/stub-fail.sh" \
  PIPELINE_MAX_ATTEMPTS=banana bash "$PIPELINE_DIR/entrypoint.sh" >/dev/null 2>&1
RC=$?
cp /tmp/ws12/.run/status.json /out/e12-badcap.json 2>/dev/null
[ "$RC" = 10 ] && [ "$(grep -c '"verifierResult": "fail"' /out/e12-badcap.json)" = 3 ] \
  && pass "max-attempts: invalid value falls back to 3" || fail "max-attempts: fallback broken (rc=$RC)"

# 6. main is untouched by every scenario.
MAIN_AFTER=$(cd /tmp/src && git rev-parse main)
[ "$MAIN_BEFORE" = "$MAIN_AFTER" ] && pass "main untouched across all scenarios" \
                                    || fail "main moved!"

if [ "$FAIL" -eq 0 ]; then echo "== ALL IN-CONTAINER T8 CHECKS PASSED =="; else echo "== T8 CHECKS FAILED =="; fi
exit "$FAIL"
