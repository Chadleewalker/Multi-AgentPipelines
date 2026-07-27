#!/usr/bin/env bash
# Copyright 2026 Chad Walker
# SPDX-License-Identifier: Apache-2.0

# T14 acceptance checks (V1 backlog T14; DESIGN.md 4.1, 4.2, 4.6, 4.10, 4.11).
# REAL containers running the REAL entrypoint on the closed network. Agent behavior is
# stubbed inside the container via PIPELINE_AGENT_CMD (config agentCommand), so nothing
# here burns the subscription window.
# Run from Git Bash:  bash scripts/test-runner-container.sh
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
FAIL=0
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; FAIL=1; }
cleanup() {
  docker ps -aq --filter "name=task-" | xargs -r docker rm -f >/dev/null 2>&1
  bash "$ROOT/scripts/pipeline-net.sh" down >/dev/null 2>&1
  rm -rf "$TMP" "$ROOT/runs/t14-"*
}
trap cleanup EXIT

echo "== T14 checks =="

# --- Fixture project: bare remote + working copy with frozen tests and config ---
REMOTE="$TMP/remote.git"; git init -q --bare -b main "$REMOTE"
TGT="$TMP/target"; git clone -q "$REMOTE" "$TGT"; cd "$TGT"
git config user.email t@test.local && git config user.name tester
cat > pipeline.config.json <<'EOF'
{"verifyCommand":"sh tools/run-tests.sh","frozenPaths":["tools/run-tests.sh"],"dependencies":{}}
EOF
mkdir -p tools tests/acceptance
cat > tools/run-tests.sh <<'EOF'
#!/bin/sh
for f in "$1"*.sh; do sh "$f" || exit 1; done
EOF
git add -A && git commit -qm "planning: config + runner" >/dev/null
TGTW="$TGT"; REMOTEW="$REMOTE"
if command -v cygpath >/dev/null 2>&1; then TGTW="$(cygpath -m "$TGT")"; REMOTEW="$(cygpath -m "$REMOTE")"; fi
BD=(docker run --rm -v "$TGTW:/repo" -w /repo pipeline-base:local bd)
bdq() { MSYS_NO_PATHCONV=1 "${BD[@]}" "$@" 2>/dev/null | tr -d '\r'; }
bdq init >/dev/null

# One acceptance test per issue, committed to main and pushed (the freeze baseline).
add_issue() { # add_issue <title> <test-body>
  local id; id=$(bdq create "$1" -d "$1" --acceptance "acceptance tests pass" --design "design-ref: 4.3" -p 0 --silent)
  mkdir -p "$TGT/tests/acceptance/$id"
  printf '%s\n' "$2" > "$TGT/tests/acceptance/$id/test.sh"
  (cd "$TGT" && git add -A && git commit -qm "planning: frozen tests for $id" >/dev/null)
  echo "$id"
}
OK_ID=$(add_issue "achievable task" '#!/bin/sh
[ -f out.txt ] || { echo "out.txt missing"; exit 1; }')
BAIL_ID=$(add_issue "impossible task" '#!/bin/sh
echo "this can never pass"; exit 1')
(cd "$TGT" && git push -q origin main)
cd "$ROOT"

mkcfg() { # mkcfg <file> <agentCommand-json-string> [wallClockMinutes]
  printf '{"targetRepoPath":"%s","targetRepoRemote":"%s","image":"pipeline-base:local","agentCommand":%s%s}\n' \
    "$TGTW" "$REMOTEW" "$2" "${3:+,\"wallClockMinutes\":$3}" > "$1"
}
# In-container agent stubs (the 4.3 seam). The success stub satisfies the test;
# the sleep stub hangs so the host wall-clock timer must kill it.
CFG_OK="$TMP/ok.json";    mkcfg "$CFG_OK"   '"sh -c \"cat >/dev/null; echo done > out.txt\""'
CFG_FAIL="$TMP/fail.json"; mkcfg "$CFG_FAIL" '"sh -c \"cat >/dev/null; echo nope >> notes.txt\""'
CFG_HANG="$TMP/hang.json"; mkcfg "$CFG_HANG" '"sh -c \"cat >/dev/null; sleep 600\""' 0.15

# tee to stderr so the run streams to the terminal live while stdout is still captured
# for the assertions ($( ) takes stdout only). Without it these suites look hung for
# minutes. pipefail keeps the runner's exit code from being masked by tee's.
run() { ( set -o pipefail; RUN_ID="$1" node runner/run.js --config "$2" 2>&1 | tee /dev/stderr ); }

# 1. Real container, real entrypoint, verified success.
bdq update "$BAIL_ID" --status blocked >/dev/null   # isolate the success task
OUT=$(run t14-success "$CFG_OK")
echo "$OUT" | grep -q "launching container task-$OK_ID" && pass "container launched per task" || fail "no container launch"
echo "$OUT" | grep -q "exit 0 -> done" && pass "real entrypoint verified the task (exit 0 -> done)" \
  || fail "success path failed: $(echo "$OUT" | grep -E 'exit|error' | tail -3)"
TD="$ROOT/runs/t14-success/tasks/$OK_ID"
[ -f "$TD/container.log" ] && pass "container output captured to the run folder" || fail "container.log missing"
grep -q '"verifierResult": "pass"' "$TD/status.json" 2>/dev/null \
  && pass "container wrote a schema-shaped status.json" || fail "status.json missing/wrong"
grep -q '"acceptance": "pass"' "$TD/verify.json" 2>/dev/null \
  && pass "verifier ran inside the container" || fail "verify.json missing/wrong"
echo "$OUT" | grep -q "has commits (push candidate)" && pass "verified work committed on the task branch" || fail "no commits"

# 2. Input contract (4.10): mounts, network, env — asserted from the launch itself.
CID=$(grep -o "task-$OK_ID-t14-success" <<<"$OUT" | head -1)
[ -n "$CID" ] && pass "container named task-<issue>-<runId>" || fail "container naming wrong"
grep -q "workspace" "$TD/container.log" 2>/dev/null || true   # entrypoint ran in /workspace
bdq show "$OK_ID" --json | grep -q "outcome done" && pass "attempt notes written back host-side" || fail "no write-back"

# 3. Bail: three real attempts inside the container, exit 10 -> stuck/blocked.
bdq update "$BAIL_ID" --status open >/dev/null
bdq update "$OK_ID" --status blocked >/dev/null 2>&1 || true
OUT=$(run t14-bail "$CFG_FAIL")
echo "$OUT" | grep -q "exit 10 -> stuck" && pass "unsatisfiable task bails (exit 10 -> stuck)" \
  || fail "bail path wrong: $(echo "$OUT" | grep -E 'exit' | tail -2)"
TDB="$ROOT/runs/t14-bail/tasks/$BAIL_ID"
[ "$(grep -c '"verifierResult": "fail"' "$TDB/status.json" 2>/dev/null)" = 3 ] \
  && pass "exactly 3 attempts inside the real container" || fail "attempt count wrong"
grep -q '"stuckState"' "$TDB/status.json" 2>/dev/null && pass "stuck state recorded" || fail "no stuck state"
bdq show "$BAIL_ID" --json | grep -q '"blocked"' && pass "stuck task blocked in Beads" || fail "not blocked"

# 4. Wall-clock kill: host timer fires, container dies, outcome failed (4.11).
HANG_ID=$(add_issue "hanging task" '#!/bin/sh
exit 0')
(cd "$TGT" && git push -q origin main)
bdq update "$BAIL_ID" --status blocked >/dev/null
OUT=$(run t14-kill "$CFG_HANG")
echo "$OUT" | grep -q "wall-clock budget exhausted" && pass "host wall-clock timer fired" || fail "timer did not fire"
echo "$OUT" | grep -q "exit killed -> failed" && pass "killed container -> failed outcome" \
  || fail "kill outcome wrong: $(echo "$OUT" | grep -E 'exit' | tail -2)"
bdq show "$HANG_ID" --json | grep -q '"blocked"' && pass "killed task blocked in Beads" || fail "kill transition wrong"
docker ps -q --filter "name=task-$HANG_ID" | grep -q . && fail "container still running after kill" || pass "container actually stopped"

# 5. Credentials and isolation.
grep -rqE 'CLAUDE_CODE_OAUTH_TOKEN=[A-Za-z0-9]' "$ROOT/runs/t14-success/" 2>/dev/null \
  && fail "token value leaked into run logs" || pass "token never written to logs (passed by name)"
grep -q "\-e', 'CLAUDE_CODE_OAUTH_TOKEN'" "$ROOT/runner/container.js" \
  || grep -q "'CLAUDE_CODE_OAUTH_TOKEN'" "$ROOT/runner/container.js" \
  && pass "token passed by name at docker run (never baked)" || fail "token passing wrong"
grep -q "'--network', cfg.network" "$ROOT/runner/container.js" && pass "container joins the closed network" || fail "network arg missing"
grep -q ":/pipeline:ro" "$ROOT/runner/container.js" && pass "scaffolding mounted read-only at /pipeline" || fail "pipeline mount wrong"
grep -qE "spawnSync\(\s*['\"]timeout['\"]" "$ROOT/runner/" -r \
  && fail "platform timeout used" || pass "wall clock is a Node timer + docker kill (no platform timeout)"

if [[ $FAIL -eq 0 ]]; then echo "== ALL T14 CHECKS PASSED =="; else echo "== T14 CHECKS FAILED =="; fi
exit $FAIL
