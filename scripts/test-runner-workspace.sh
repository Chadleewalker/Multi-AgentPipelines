#!/usr/bin/env bash
# Copyright 2026 Chad Walker
# SPDX-License-Identifier: Apache-2.0

# T13 acceptance checks (docs/v1-backlog-draft.md T13; DESIGN.md 4.2, 4.10).
# Real clones from a real (local bare) "remote", real branches, real collision
# handling. Container execution is still stubbed (T14).
# Run from Git Bash:  bash scripts/test-runner-workspace.sh
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
FAIL=0
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; FAIL=1; }
cleanup() { bash "$ROOT/scripts/pipeline-net.sh" down >/dev/null 2>&1; rm -rf "$TMP" "$ROOT/runs/t13-"*; }
trap cleanup EXIT

echo "== T13 checks =="

# --- A bare repo stands in for GitHub; a working copy holds Beads. ---
REMOTE="$TMP/remote.git"; git init -q --bare -b main "$REMOTE"
TGT="$TMP/target"; git clone -q "$REMOTE" "$TGT"; cd "$TGT"
git config user.email t@test.local && git config user.name tester
mkdir -p tests/acceptance/x && echo "frozen" > tests/acceptance/x/t.sh
echo "orig" > file.txt && git add -A && git commit -qm "planning: frozen tests" && git push -q origin main
TGTW="$TGT"; REMOTEW="$REMOTE"
if command -v cygpath >/dev/null 2>&1; then TGTW="$(cygpath -m "$TGT")"; REMOTEW="$(cygpath -m "$REMOTE")"; fi
BD=(docker run --rm -v "$TGTW:/repo" -w /repo pipeline-base:local bd)
bdq() { MSYS_NO_PATHCONV=1 "${BD[@]}" "$@" 2>/dev/null | tr -d '\r'; }
bdq init >/dev/null
cd "$ROOT"

CFG="$TMP/run.config.json"
printf '{"targetRepoPath":"%s","targetRepoRemote":"%s","image":"pipeline-base:local"}\n' "$TGTW" "$REMOTEW" > "$CFG"

# Stub container: commits work inside the real workspace and writes contract artifacts.
cat > "$TMP/stub-work.sh" <<'EOF'
echo "agent output" > new-file.txt
mkdir -p "$RUN_DIR"
printf '{"issueId":"%s","attempts":[{"number":1,"verifierResult":"pass","timestamp":"2026-07-25T12:00:00Z"}],"changeSummary":"added new-file"}\n' "$ISSUE_ID" > "$RUN_DIR/status.json"
printf '{"issueId":"%s","timestamp":"2026-07-25T12:00:00Z","acceptance":"pass","regressions":"absent"}\n' "$ISSUE_ID" > "$RUN_DIR/verify.json"
git add -A && git commit -qm "Task $ISSUE_ID: implementation (verified on attempt 1)"
exit 0
EOF
cat > "$TMP/stub-nowork.sh" <<'EOF'
mkdir -p "$RUN_DIR"
printf '{"issueId":"%s","attempts":[]}\n' "$ISSUE_ID" > "$RUN_DIR/status.json"
exit 30
EOF

I1=$(bdq create "first task" -d x --acceptance ok --design "design-ref: 4.2" -p 0 --silent)
run() { PIPELINE_EXEC_STUB="$1" RUN_ID="$2" PIPELINE_KEEP_WORKSPACE=1 node runner/run.js --config "$CFG" 2>&1; }

# 1. Fresh clone from the remote, branch task/<id> off canonical main.
OUT=$(run "$TMP/stub-work.sh" t13-basic)
echo "$OUT" | grep -q "workspace ready:" && pass "workspace prepared per task" || fail "no workspace: $(echo "$OUT" | tail -3)"
echo "$OUT" | grep -q "on task/$I1 " && pass "branch named task/<issue-id>" || fail "branch naming wrong"
WS=$(echo "$OUT" | grep -o "workspace kept at .*" | head -1 | sed 's/workspace kept at //')
[ -d "$WS/.git" ] && pass "real git clone created" || fail "clone missing"
(cd "$WS" && git rev-parse --abbrev-ref HEAD | grep -q "task/$I1") && pass "checked out on the task branch" || fail "wrong branch checked out"
FORK=$(cd "$WS" && git merge-base origin/main HEAD)
MAIN=$(cd "$WS" && git rev-parse origin/main)
[ "$FORK" = "$MAIN" ] && pass "branch forks from canonical remote main" || fail "fork point is not remote main"

# 2. Frozen tests present from main (the verifier's baseline exists).
[ -f "$WS/tests/acceptance/x/t.sh" ] && pass "frozen tests present in the workspace" || fail "frozen tests missing"

# 3. Issue exported into the workspace for the container.
grep -q "Acceptance criteria" "$WS/.run/issue.md" && pass "issue.md mounted in .run/ for the container" || fail "issue.md missing"

# 4. .run/ excluded from commits (belt and braces with the entrypoint).
grep -q "^\.run/$" "$WS/.git/info/exclude" && pass ".run/ added to git exclude" || fail "exclude entry missing"
(cd "$WS" && git show --stat HEAD | grep -q "\.run/") && fail ".run/ leaked into the commit" || pass ".run/ never committed"

# 5. Commits detected for the push decision (T16).
echo "$OUT" | grep -q "has commits (push candidate)" && pass "commits detected on the branch" || fail "commit detection failed"

# 6. Artifacts collected into the run folder before discard.
TD="$ROOT/runs/t13-basic/tasks/$I1"
[ -f "$TD/status.json" ] && [ -f "$TD/verify.json" ] \
  && pass "status.json + verify.json collected into the run folder" || fail "artifacts not collected"
grep -q '"acceptance": "pass"' "$TD/verify.json" 2>/dev/null || grep -q '"acceptance":"pass"' "$TD/verify.json" \
  && pass "collected verify.json is intact" || fail "verify.json corrupt"

# 7. Outcome derived from the collected artifacts (not from the stub's guesswork).
echo "$OUT" | grep -q "exit 0 -> done" && pass "outcome derived from collected verify.json" || fail "outcome wrong"

# 8. No-commit task: nothing to push.
I2=$(bdq create "no-work task" -d x --acceptance ok --design "design-ref: 4.6" -p 0 --silent)
OUT=$(run "$TMP/stub-nowork.sh" t13-nowork)
echo "$OUT" | grep -q "no commits (nothing to push)" && pass "empty branch reported as nothing to push" || fail "empty-branch detection failed"

# 9. Branch collision: an existing remote branch forces -r2, never a force-push.
git -C "$TMP" clone -q "$REMOTE" "$TMP/pusher" 2>/dev/null
(cd "$TMP/pusher" && git checkout -q -b "task/$I2" origin/main && git commit -q --allow-empty -m "earlier attempt" && git push -q origin "task/$I2")
I2B=$(bdq update "$I2" --status open >/dev/null; echo "$I2")
OUT=$(run "$TMP/stub-work.sh" t13-collision)
echo "$OUT" | grep -q "using task/$I2-r2" && pass "remote branch collision -> -r2 suffix" || fail "collision handling failed"
grep -rqE "push[^\n]*(--force|-f\b)|force-with-lease" "$ROOT/runner/" \
  && fail "runner can force-push" || pass "runner never force-pushes (earlier attempts preserved)"
git -C "$REMOTE" rev-parse "task/$I2" >/dev/null 2>&1 && pass "earlier remote branch still intact" || fail "earlier branch lost"

# 10. Fresh clone per task: no cross-task contamination.
WS1=$(echo "$OUT" | grep -o "workspace kept at .*" | head -1 | sed 's/workspace kept at //')
[ ! -f "$WS1/new-file.txt.bak" ] && [ -f "$WS1/file.txt" ] && pass "each task gets a clean checkout" || fail "workspace contamination"

# 11. Clone failure is a task failure, not a run failure.
BADCFG="$TMP/bad.json"
printf '{"targetRepoPath":"%s","targetRepoRemote":"%s/nope.git","image":"pipeline-base:local"}\n' "$TGTW" "$REMOTEW" > "$BADCFG"
I3=$(bdq create "unclonable" -d x --acceptance ok --design "design-ref: 4.2" -p 0 --silent)
# tee to stderr streams the run live; stdout still captured, pipefail preserves RC.
OUT=$(set -o pipefail; PIPELINE_EXEC_STUB="$TMP/stub-work.sh" RUN_ID=t13-badremote node runner/run.js --config "$BADCFG" 2>&1 | tee /dev/stderr); RC=$?
echo "$OUT" | grep -q "workspace preparation failed" && pass "clone failure reported per task" || fail "clone failure not handled"
[ "$RC" = 0 ] && pass "run continues after a task-level clone failure" || fail "run aborted on task failure (rc=$RC)"

if [[ $FAIL -eq 0 ]]; then echo "== ALL T13 CHECKS PASSED =="; else echo "== T13 CHECKS FAILED =="; fi
exit $FAIL
