#!/usr/bin/env bash
# T15 acceptance checks (docs/v1-backlog-draft.md T15; DESIGN.md 4.7, 4.11).
# REAL containers, REAL pause/resume. The in-container agent stub is a state machine
# (counter in .run/) that fails once, then reports a usage limit, then succeeds - which
# proves the attempt counter survives the relaunch. Waits are seconds, not windows.
# Run from Git Bash:  bash scripts/test-runner-pause.sh
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
FAIL=0
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; FAIL=1; }
cleanup() {
  docker ps -aq --filter "name=task-" | xargs -r docker rm -f >/dev/null 2>&1
  bash "$ROOT/scripts/pipeline-net.sh" down >/dev/null 2>&1
  rm -rf "$TMP" "$ROOT/runs/t15-"*
}
trap cleanup EXIT

echo "== T15 checks =="

# --- Fixture project (same shape as T14) ---
REMOTE="$TMP/remote.git"; git init -q --bare -b main "$REMOTE"
TGT="$TMP/target"; git clone -q "$REMOTE" "$TGT"; cd "$TGT"
git config user.email t@test.local && git config user.name tester
printf '{"verifyCommand":"sh tools/run-tests.sh","frozenPaths":["tools/run-tests.sh"],"dependencies":{}}\n' > pipeline.config.json
mkdir -p tools tests/acceptance
printf '#!/bin/sh\nfor f in "$1"*.sh; do sh "$f" || exit 1; done\n' > tools/run-tests.sh
git add -A && git commit -qm "planning: config" >/dev/null
TGTW="$TGT"; REMOTEW="$REMOTE"
if command -v cygpath >/dev/null 2>&1; then TGTW="$(cygpath -m "$TGT")"; REMOTEW="$(cygpath -m "$REMOTE")"; fi
BD=(docker run --rm -v "$TGTW:/repo" -w /repo pipeline-base:local bd)
bdq() { MSYS_NO_PATHCONV=1 "${BD[@]}" "$@" 2>/dev/null | tr -d '\r'; }
bdq init >/dev/null

add_issue() {
  local id; id=$(bdq create "$1" -d "$1" --acceptance "tests pass" --design "design-ref: 4.7" -p 0 --silent)
  mkdir -p "$TGT/tests/acceptance/$id"
  printf '#!/bin/sh\n[ -f out.txt ] || { echo "out.txt missing"; exit 1; }\n' > "$TGT/tests/acceptance/$id/test.sh"
  (cd "$TGT" && git add -A && git commit -qm "planning: frozen tests for $id" >/dev/null)
  echo "$id"
}
RESET_ID=$(add_issue "reset-time pause task")
PROBE_ID=$(add_issue "probe pause task")
(cd "$TGT" && git push -q origin main)
cd "$ROOT"

# In-container agent: call 1 does nothing (verify fails -> attempt 1), call 2 reports a
# usage limit (exit 20, no attempt consumed), call 3+ satisfies the test.
mkagent() { # mkagent <epoch-or-empty>
  local marker="Claude AI usage limit reached"
  [ -n "$1" ] && marker="$marker|$1"
  printf 'sh -c \x27cat >/dev/null; N=$(cat /workspace/.run/n 2>/dev/null || echo 0); N=$((N+1)); echo $N > /workspace/.run/n; case $N in 1) exit 0;; 2) echo "%s"; exit 1;; *) echo done > /workspace/out.txt;; esac\x27' "$marker"
}
mkcfg() { # mkcfg <file> <agentCmd> <wallClockMinutes> <probeIntervalMinutes>
  node -e '
    const [f,a,w,p,t,r]=process.argv.slice(1);
    require("fs").writeFileSync(f, JSON.stringify({targetRepoPath:t,targetRepoRemote:r,image:"pipeline-base:local",agentCommand:a,wallClockMinutes:+w,probeIntervalMinutes:+p},null,2));
  ' "$1" "$2" "$3" "$4" "$TGTW" "$REMOTEW"
}

# ---- Scenario 1: reset time reported -> runner waits until it, then resumes ----
bdq update "$PROBE_ID" --status blocked >/dev/null
# Budget 0.3m (18s) with a ~14s pause: total elapsed must EXCEED the budget while
# active time stays under it — that is what proves pause time is excluded (4.6).
EPOCH=$(( $(date +%s) + 14 ))
mkcfg "$TMP/reset.json" "$(mkagent "$EPOCH")" 0.3 15
T0=$(date +%s)
OUT=$(RUN_ID=t15-reset node runner/run.js --config "$TMP/reset.json" 2>&1)
T1=$(date +%s)

echo "$OUT" | grep -q "rate limit hit (pause 1)" && pass "rate limit detected as a pause, not a failure" || fail "pause not detected"
echo "$OUT" | grep -q "issue stays in_progress" && pass "issue parked (stays in_progress during the pause)" || fail "issue not parked"
echo "$OUT" | grep -q "waiting until reported reset" && pass "waits until the container-reported reset time" || fail "reset time not used"
echo "$OUT" | grep -q "reset time reached — resuming" && pass "resumes when the window reopens" || fail "no resume"
echo "$OUT" | grep -q "relaunching in a fresh container against the same workspace" && pass "relaunch reuses the same workspace" || fail "relaunch wrong"
echo "$OUT" | grep -q "exit 0 -> done" && pass "task completes after the pause (exit 0 -> done)" \
  || fail "post-resume outcome wrong: $(echo "$OUT" | grep -E 'exit ' | tail -2)"

SJ="$ROOT/runs/t15-reset/tasks/$RESET_ID/status.json"
[ "$(grep -c '"verifierResult"' "$SJ" 2>/dev/null)" = 2 ] \
  && pass "attempt counter carried across the relaunch (2 attempts total, not reset)" \
  || fail "attempt carry-over wrong: $(grep -c '"verifierResult"' "$SJ" 2>/dev/null) attempts"
grep -q '"number": 1' "$SJ" && grep -q '"number": 2' "$SJ" \
  && pass "attempts numbered continuously across containers" || fail "attempt numbering broken"
grep -q '"verifierResult": "fail"' "$SJ" && grep -q '"verifierResult": "pass"' "$SJ" \
  && pass "pre-pause failure and post-resume pass both recorded" || fail "attempt history incomplete"
grep -c "launching container" <<<"$OUT" | grep -q 2 && pass "exactly two containers (one per window)" \
  || fail "container count wrong: $(grep -c 'launching container' <<<"$OUT")"

# Paused time is excluded from the budget (4.6): the wall clock was 0.5m = 30s, and the
# run took longer than that in total, yet the task was never killed.
ELAPSED=$((T1 - T0))
if echo "$OUT" | grep -q "wall-clock budget exhausted"; then
  fail "pause counted against the wall clock (task killed)"
elif [ "$ELAPSED" -gt 18 ]; then
  pass "paused time excluded: run outlived the 18s budget (${ELAPSED}s elapsed) and still succeeded"
else
  fail "test too fast to prove exclusion (elapsed ${ELAPSED}s, budget 18s)"
fi
ACTIVE=$(echo "$OUT" | grep -o "active total [0-9]*s" | tail -1)
echo "$OUT" | grep -q "active total" && pass "active time tracked across relaunches ($ACTIVE)" || fail "no active-time accounting"
bdq show "$RESET_ID" --json | grep -q '"closed"' && pass "resumed task closed in Beads" || fail "final Beads state wrong"

# ---- Scenario 2: no reset time -> probe on the configured interval ----
bdq update "$PROBE_ID" --status open >/dev/null
bdq update "$RESET_ID" --status blocked >/dev/null 2>&1 || true
mkcfg "$TMP/probe.json" "$(mkagent '')" 0.5 0.03
PROBEDIR="$TMP/probe-state"; mkdir -p "$PROBEDIR"
# Probe stub: rate-limited on the first call, open on the second.
export PIPELINE_PROBE_CMD="N=\$(cat $PROBEDIR/n 2>/dev/null || echo 0); N=\$((N+1)); echo \$N > $PROBEDIR/n; if [ \$N -le 1 ]; then echo 'usage limit reached'; exit 1; fi; echo ok"
OUT=$(RUN_ID=t15-probe node runner/run.js --config "$TMP/probe.json" 2>&1)
unset PIPELINE_PROBE_CMD

echo "$OUT" | grep -q "no reset time reported; probing every" && pass "probes when no reset time is reported" || fail "probe path not taken"
echo "$OUT" | grep -q "probe still rate-limited" && pass "keeps waiting while the probe says rate-limited" || fail "did not re-probe"
echo "$OUT" | grep -q "probe succeeded" && pass "resumes when the probe succeeds" || fail "probe resume missing"
echo "$OUT" | grep -q "exit 0 -> done" && pass "probe-path task completes" || fail "probe-path outcome wrong"
[ "$(grep -c '"verifierResult"' "$ROOT/runs/t15-probe/tasks/$PROBE_ID/status.json" 2>/dev/null)" = 2 ] \
  && pass "probe path also carries the attempt counter" || fail "probe-path carry-over wrong"

# ---- Static guarantees ----
grep -q "exitCode !== 20" "$ROOT/runner/run.js" && pass "exit 20 is the only pause trigger" || fail "pause trigger wrong"
grep -q "20: { status: 'paused', beads: null }" "$ROOT/runner/queue.js" \
  && pass "paused never writes a terminal Beads status" || fail "paused transition wrong"

if [[ $FAIL -eq 0 ]]; then echo "== ALL T15 CHECKS PASSED =="; else echo "== T15 CHECKS FAILED =="; fi
exit $FAIL
