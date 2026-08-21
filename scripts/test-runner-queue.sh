#!/usr/bin/env bash
# Copyright 2026 Chad Walker
# SPDX-License-Identifier: Apache-2.0

# T12 acceptance checks (V1 backlog T12; DESIGN.md 4.10, 4.11, 4.12).
# Real Beads, real ordering, real transitions. Task execution is stubbed via
# PIPELINE_EXEC_STUB (T13/T14 replace it with the container).
# Run from Git Bash:  bash scripts/test-runner-queue.sh
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
FAIL=0
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; FAIL=1; }
cleanup() { bash "$ROOT/scripts/pipeline-net.sh" down >/dev/null 2>&1; rm -rf "$TMP" "$ROOT/runs/t12-"*; }
trap cleanup EXIT

echo "== T12 checks =="

# --- Bare remote + target working copy with Beads, mixed-priority gated queue ---
REMOTE="$TMP/remote.git"; git init -q --bare -b main "$REMOTE"
TGT="$TMP/target"; git clone -q "$REMOTE" "$TGT"; cd "$TGT"
git config user.email t@test.local && git config user.name tester
echo x > f.txt && git add -A && git commit -qm init && git push -q origin main
TGTW="$TGT"; REMOTEW="$REMOTE"
if command -v cygpath >/dev/null 2>&1; then TGTW="$(cygpath -m "$TGT")"; REMOTEW="$(cygpath -m "$REMOTE")"; fi
BD=(docker run --rm -v "$TGTW:/repo" -w /repo pipeline-base:local bd)
bdq() { MSYS_NO_PATHCONV=1 "${BD[@]}" "$@" 2>/dev/null | tr -d '\r'; }
bdq init >/dev/null

# Every issue the runner may dispatch needs a frozen suite ON THE INTEGRATION BRANCH
# (DESIGN.md 4.12, change-log row `dispatch-gate`): the ready queue refuses an issue whose
# tests/acceptance/<id> is absent from the branch task containers fork from, and a refused
# issue never reaches a container — so without this every check below would fail for a
# reason unrelated to what it tests. PUSHED, not merely committed: freezing locally is not
# freezing, and the gate reads the remote.
freeze() {
  mkdir -p "$TGT/tests/acceptance/$1"
  echo "exit 0" > "$TGT/tests/acceptance/$1/t.sh"
  git -C "$TGT" add -A >/dev/null 2>&1
  git -C "$TGT" commit -qm "planning: freeze $1" >/dev/null 2>&1
  git -C "$TGT" push -q origin main >/dev/null 2>&1
}

# Created out of priority order on purpose; B blocks C.
A=$(bdq create "low prio task"  -d "third" --acceptance ok --design "design-ref: 4.1" -p 3 --silent)
freeze "$A"
B=$(bdq create "high prio task" -d "first"  --acceptance ok --design "design-ref: 4.2" -p 0 --silent)
freeze "$B"
C=$(bdq create "blocked task"   -d "gated"  --acceptance ok --design "design-ref: 4.3" -p 0 --deps "$B" --silent)
freeze "$C"
D=$(bdq create "mid prio task"  -d "second" --acceptance ok --design "design-ref: 4.4" -p 1 --silent)
freeze "$D"
cd "$ROOT"

CFG="$TMP/run.config.json"
# maxPauseCycles 2 keeps the pause scenario to ~14s AND makes it a regression test for the
# cap itself: the cap is per-task, so it can only fire on the 3rd pause if the count
# carried across the two relaunches. No other scenario here ever pauses.
printf '{"targetRepoPath":"%s","targetRepoRemote":"%s","image":"pipeline-base:local","maxPauseCycles":2}\n' "$TGTW" "$REMOTEW" > "$CFG"

# --- Stubs standing in for the container (T13/T14 will make these real) ---
# Artifacts go where the container writes them: the workspace's .run/ (T13 collects).
cat > "$TMP/stub-success.sh" <<'EOF'
mkdir -p "$RUN_DIR"
printf '{"issueId":"%s","attempts":[{"number":1,"verifierResult":"pass","timestamp":"2026-07-25T12:00:00Z"}],"changeSummary":"did the thing"}\n' "$ISSUE_ID" > "$RUN_DIR/status.json"
printf '{"issueId":"%s","timestamp":"2026-07-25T12:00:00Z","acceptance":"pass","regressions":"pass"}\n' "$ISSUE_ID" > "$RUN_DIR/verify.json"
exit 0
EOF
cat > "$TMP/stub-partial.sh" <<'EOF'
mkdir -p "$RUN_DIR"
printf '{"issueId":"%s","attempts":[{"number":1,"verifierResult":"pass","timestamp":"2026-07-25T12:00:00Z"}]}\n' "$ISSUE_ID" > "$RUN_DIR/status.json"
printf '{"issueId":"%s","timestamp":"2026-07-25T12:00:00Z","acceptance":"pass","regressions":"fail"}\n' "$ISSUE_ID" > "$RUN_DIR/verify.json"
exit 0
EOF
cat > "$TMP/stub-stuck.sh" <<'EOF'
mkdir -p "$RUN_DIR"
printf '{"issueId":"%s","attempts":[{"number":1,"verifierResult":"fail","timestamp":"2026-07-25T12:00:00Z"},{"number":2,"verifierResult":"fail","timestamp":"2026-07-25T12:05:00Z"},{"number":3,"verifierResult":"fail","timestamp":"2026-07-25T12:10:00Z"}],"stuckState":"bailed after 3"}\n' "$ISSUE_ID" > "$RUN_DIR/status.json"
exit 10
EOF
# Always rate-limited. The reset time is computed at RUN time, never hardcoded: a fixed
# timestamp silently changes meaning as the wall clock passes it (a far-future date parks
# the runner for hours; a past one makes it relaunch on a 5s cycle), and either way the
# suite stops testing what it claims to. maxPauseCycles below bounds the loop.
cat > "$TMP/stub-paused.sh" <<'EOF'
mkdir -p "$RUN_DIR"
RESET=$(date -u -d "@$(( $(date +%s) + 2 ))" +%Y-%m-%dT%H:%M:%SZ)
printf '{"issueId":"%s","attempts":[],"rateLimitResetAt":"%s"}\n' "$ISSUE_ID" "$RESET" > "$RUN_DIR/status.json"
exit 20
EOF

# tee to stderr streams the run live to the terminal; stdout is still captured for the
# assertions, and pipefail keeps the runner's exit code from being masked by tee's.
# This suite in particular must never run silent: when its pause scenario regressed it
# looped forever, and with no streamed output the only symptom was a suite that appeared
# to hang — the relaunch spam was visible solely in a run log recovered afterwards.
runq() { ( set -o pipefail; PIPELINE_EXEC_STUB="$1" RUN_ID="$2" node runner/run.js --config "$CFG" 2>&1 | tee /dev/stderr ); }
st() { bdq show "$1" --json | grep '"status"' | head -1; }

# 1. Ordering: priority first (0,1,3), FIFO within ties; blocked task excluded.
OUT=$(runq "$TMP/stub-success.sh" t12-order)
ORDER=$(echo "$OUT" | grep -o "ready queue: .*" | head -1)
echo "$ORDER" | grep -q "$B, $D, $A" && pass "ready queue ordered by priority (0,1,3)" \
  || fail "ordering wrong: $ORDER"
echo "$ORDER" | grep -q "$C" && fail "blocked task appeared in the ready queue" \
  || pass "dependency-gated task excluded from ready queue"
echo "$OUT" | grep -q "ready queue: 3 task" && pass "queue size correct (3 of 4)" || fail "queue size wrong"

# 2. Sequential execution: one task at a time, in order, all three ran.
[ "$(echo "$OUT" | grep -c 'starting task')" = 3 ] && pass "all ready tasks ran sequentially" || fail "task count wrong"
FIRST=$(echo "$OUT" | grep 'starting task' | head -1)
echo "$FIRST" | grep -q "$B" && pass "highest-priority task ran first" || fail "wrong first task"

# 3. Success transition: issue closed, outcome done.
st "$B" | grep -q closed && pass "success -> issue closed" || fail "success transition wrong: $(st "$B")"
echo "$OUT" | grep -q "exit 0 -> done" && pass "success -> report status done" || fail "done status missing"

# 4. Attempt notes written back by the runner (sole Beads writer).
bdq show "$B" --json | grep -q "outcome done" && pass "attempt notes appended to the issue" || fail "no attempt notes"

# 5. Drained queue is empty next run (closed issues leave ready).
OUT2=$(runq "$TMP/stub-success.sh" t12-empty)
echo "$OUT2" | grep -q "ready queue: 1 task" && pass "unblocked dependent task now ready (C after B closed)" \
  || fail "dependency did not unlock: $(echo "$OUT2" | grep -o 'ready queue: .*')"

# 6. Partial: acceptance pass + regressions fail -> partial, still closed.
E=$(bdq create "partial task" -d x --acceptance ok --design "design-ref: 4.4" -p 0 --silent)
freeze "$E"
OUT=$(runq "$TMP/stub-partial.sh" t12-partial)
echo "$OUT" | grep -q "exit 0 -> partial" && pass "regressions fail -> partial (verify.json decides)" || fail "partial not derived"
st "$E" | grep -q closed && pass "partial -> issue closed" || fail "partial transition wrong"

# 7. Stuck: exit 10 -> blocked, and blocked never returns to the ready queue.
F=$(bdq create "stuck task" -d x --acceptance ok --design "design-ref: 4.6" -p 0 --silent)
freeze "$F"
OUT=$(runq "$TMP/stub-stuck.sh" t12-stuck)
echo "$OUT" | grep -q "exit 10 -> stuck" && pass "exit 10 -> stuck" || fail "stuck status wrong"
st "$F" | grep -q blocked && pass "stuck -> issue blocked" || fail "stuck transition wrong: $(st "$F")"
bdq show "$F" --json | grep -q "bailed after 3" && pass "stuck state recorded on the issue" || fail "stuck state missing"
OUT=$(runq "$TMP/stub-success.sh" t12-noreplay)
echo "$OUT" | grep -o "ready queue: .*" | grep -q "$F" \
  && fail "blocked issue re-picked (loop would never terminate)" || pass "blocked issue never re-picked"

# 8. Paused: exit 20 -> stays in_progress, not closed, not blocked.
G=$(bdq create "paused task" -d x --acceptance ok --design "design-ref: 4.7" -p 0 --silent)
freeze "$G"
OUT=$(runq "$TMP/stub-paused.sh" t12-paused)
echo "$OUT" | grep -q "exit 20 -> paused" && pass "exit 20 -> paused" || fail "paused status wrong"
echo "$OUT" | grep -q "issue stays in_progress" && pass "paused issue left in_progress (runner parks it)" || fail "paused transition wrong"
st "$G" | grep -q in_progress && pass "paused issue is in_progress in Beads" || fail "paused issue state wrong: $(st "$G")"
# The stop condition must actually fire. A permanently rate-limited task has to end the
# run, not relaunch forever: the cap counts cycles for the whole task, so re-entering the
# wait on each pause must not reset it.
echo "$OUT" | grep -q "giving up on the pause" \
  && pass "pause cap fires across relaunches (loop is bounded)" || fail "pause cap never fired"
[ "$(echo "$OUT" | grep -c 'rate limit hit (pause')" = 3 ] \
  && pass "exactly 3 pauses at maxPauseCycles=2 (count carried, not reset)" \
  || fail "pause count wrong: $(echo "$OUT" | grep -c 'rate limit hit (pause')"

# 9. One failure never blocks the next; the run manifest records every outcome.
# (T17 renamed this artifact results.json -> run.json; the field name is unchanged.)
[ -f "$ROOT/runs/t12-stuck/run.json" ] && pass "run manifest written per run" || fail "run.json missing"
grep -q '"outcome"' "$ROOT/runs/t12-stuck/run.json" && pass "per-task outcomes recorded" || fail "outcomes missing"

# 10. Issue exported for the container as .run/issue.md content (4.10).
ISSUE_MD=$(find "$ROOT/runs/t12-order/tasks" -name issue.md | head -1)
[ -n "$ISSUE_MD" ] && grep -q "Acceptance criteria" "$ISSUE_MD" && grep -q "Design reference" "$ISSUE_MD" \
  && pass "issue exported with spec fields for the container" || fail "issue export missing/incomplete"

# 11. The container never touches Beads: no bd invocation outside the runner.
grep -rq "bd " "$ROOT/pipeline/" && fail "container-side code invokes bd" || pass "container never writes Beads"

if [[ $FAIL -eq 0 ]]; then echo "== ALL T12 CHECKS PASSED =="; else echo "== T12 CHECKS FAILED =="; fi
exit $FAIL
