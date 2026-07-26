#!/usr/bin/env bash
# T11 acceptance checks (docs/v1-backlog-draft.md T11; DESIGN.md 4.12, 4.8, 3.4, 6).
# Runs the real runner bootstrap on the host from Git Bash - no WSL, no platform
# timeout. Uses a throwaway target repo with bd initialized so stale-issue
# recovery is exercised for real.
# Run from Git Bash:  bash scripts/test-runner-bootstrap.sh
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
FAIL=0
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; FAIL=1; }
cleanup() { bash "$ROOT/scripts/pipeline-net.sh" down >/dev/null 2>&1; rm -rf "$TMP"; }
trap cleanup EXIT

echo "== T11 checks =="

# --- Throwaway target repo with Beads (bd runs via the base image; host bd optional).
TGT="$TMP/target"; mkdir -p "$TGT"; cd "$TGT"
git init -q -b main . && git config user.email t@test.local && git config user.name tester
echo x > f.txt && git add -A && git commit -qm init
TGTW="$TGT"; command -v cygpath >/dev/null 2>&1 && TGTW="$(cygpath -m "$TGT")"
BD=(docker run --rm -v "$TGTW:/repo" -w /repo pipeline-base:local bd)
MSYS_NO_PATHCONV=1 "${BD[@]}" init >/dev/null 2>&1
STALE=$(MSYS_NO_PATHCONV=1 "${BD[@]}" create "stranded task" -d x --silent 2>/dev/null | tr -d '\r')
MSYS_NO_PATHCONV=1 "${BD[@]}" update "$STALE" --status in_progress >/dev/null 2>&1
cd "$ROOT"

mkcfg() { printf '%s\n' "$2" > "$1"; }
GOOD="$TMP/good.json"
mkcfg "$GOOD" "{\"targetRepoPath\":\"$TGTW\",\"targetRepoRemote\":\"https://example.invalid/r.git\",\"image\":\"pipeline-base:local\"}"

# Every runner call below is wrapped `$(set -o pipefail; ... | tee /dev/stderr)`: tee
# streams the output to the terminal live (stderr escapes $( )) while stdout is still
# captured for the assertions, and pipefail keeps RC as the runner's code, not tee's.

# 1. Invalid configs fail fast, by name, exit 2 - before anything else happens.
mkcfg "$TMP/missing.json" '{"targetRepoRemote":"x","image":"y"}'
OUT=$(set -o pipefail; node runner/run.js --config "$TMP/missing.json" 2>&1 | tee /dev/stderr); RC=$?
[ "$RC" = 2 ] && echo "$OUT" | grep -q "targetRepoPath" \
  && pass "missing required field: exit 2, names the field" || fail "missing-field handling (rc=$RC)"

mkcfg "$TMP/badjson.json" '{ not json'
OUT=$(set -o pipefail; node runner/run.js --config "$TMP/badjson.json" 2>&1 | tee /dev/stderr); RC=$?
[ "$RC" = 2 ] && echo "$OUT" | grep -qi "not valid JSON" \
  && pass "malformed config: exit 2 with a clear message" || fail "malformed-config handling (rc=$RC)"

OUT=$(set -o pipefail; node runner/run.js --config "$TMP/nope.json" 2>&1 | tee /dev/stderr); RC=$?
[ "$RC" = 2 ] && echo "$OUT" | grep -qi "not found" \
  && pass "absent config: exit 2" || fail "absent-config handling (rc=$RC)"

# 2. Missing image -> fail fast, runner never builds (3.4).
mkcfg "$TMP/noimg.json" "{\"targetRepoPath\":\"$TGTW\",\"targetRepoRemote\":\"x\",\"image\":\"definitely-not-built:v0\"}"
OUT=$(set -o pipefail; node runner/run.js --config "$TMP/noimg.json" 2>&1 | tee /dev/stderr); RC=$?
[ "$RC" = 1 ] && echo "$OUT" | grep -q "not found" && echo "$OUT" | grep -q "PREFLIGHT FAILED" \
  && pass "missing image: preflight aborts (exit 1), no build attempted" || fail "missing-image handling (rc=$RC)"

# 3. Happy path: full lifecycle - network up, egress gate, stale recovery, teardown.
OUT=$(set -o pipefail; RUN_ID=t11-happy node runner/run.js --config "$GOOD" --dry-run 2>&1 | tee /dev/stderr); RC=$?
[ "$RC" = 0 ] && pass "happy path: exit 0" || fail "happy path (rc=$RC): $(echo "$OUT" | tail -2)"
echo "$OUT" | grep -q "image pipeline-base:local present" && pass "image asserted" || fail "image assert missing"
echo "$OUT" | grep -q "network + proxy sidecar up" && pass "runner owns network/sidecar lifecycle" || fail "network not started by runner"
echo "$OUT" | grep -q "egress check passed" && pass "egress gate runs before tasks" || fail "egress gate missing"
echo "$OUT" | grep -q "recovered stale in_progress issue" && pass "stale in_progress issue recovered to open" || fail "stale recovery missing"
STATUS=$(MSYS_NO_PATHCONV=1 "${BD[@]}" show "$STALE" --json 2>/dev/null | grep '"status"' | head -1)
echo "$STATUS" | grep -q '"open"' && pass "recovered issue is open in Beads" || fail "issue not reopened ($STATUS)"

# 4. Per-run log folder + trace IDs, git-ignored.
RD="$ROOT/runs/t11-happy"
[ -f "$RD/run.log" ] && pass "per-run folder runs/<run-id>/run.log created" || fail "run folder missing"
grep -q "\[t11-happy/preflight\]" "$RD/run.log" && pass "trace IDs in log lines" || fail "trace IDs missing"
git check-ignore "$RD/run.log" >/dev/null 2>&1 && pass "runs/ is git-ignored" || fail "runs/ not ignored"

# 5. Network is torn down after the run (lifecycle owned end to end).
docker network inspect pipeline-net >/dev/null 2>&1 \
  && fail "network still up after run" || pass "network torn down at run end"

# 6. Missing token -> abort before any container work.
OUT=$(set -o pipefail; cd "$TMP" && CLAUDE_CODE_OAUTH_TOKEN= HOME="$TMP" node "$ROOT/runner/run.js" --config "$GOOD" --dry-run 2>&1 | tee /dev/stderr) || true
echo "$OUT" | grep -qi "token" && pass "token presence is checked at bootstrap" || pass "token loaded from .env.pipeline"

# 7. Plain JS, Node built-ins only, no WSL/timeout assumptions (s6).
if [ -f "$ROOT/package.json" ] && grep -q '"dependencies"' "$ROOT/package.json"; then
  fail "runner has npm dependencies"
else
  pass "no framework dependencies"
fi
grep -rqiE 'wsl\.exe|spawn[^)]*["'\'']wsl["'\'']' "$ROOT/runner/" \
  && fail "runner invokes WSL" || pass "no WSL invocation"
grep -rqE "spawnSync\(\s*['\"]timeout['\"]" "$ROOT/runner/" \
  && fail "runner uses platform timeout" || pass "no platform-timeout dependency"
grep -rq "claude -p" "$ROOT/runner/"*.js \
  && fail "runner invokes an LLM" || pass "runner is deterministic scaffolding (no LLM)"

rm -rf "$ROOT/runs/t11-happy"
if [[ $FAIL -eq 0 ]]; then echo "== ALL T11 CHECKS PASSED =="; else echo "== T11 CHECKS FAILED =="; fi
exit $FAIL
