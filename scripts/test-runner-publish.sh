#!/usr/bin/env bash
# T16 acceptance checks (docs/v1-backlog-draft.md T16; DESIGN.md 4.5, 4.11).
# Real containers, real pushes to a LOCAL BARE REMOTE (no live GitHub). PR creation is
# captured through the PIPELINE_GH_CMD seam, so the assembled body is inspected exactly
# as `gh pr create` would receive it.
# Run from Git Bash:  bash scripts/test-runner-publish.sh
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
FAIL=0
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; FAIL=1; }
cleanup() {
  docker ps -aq --filter "name=task-" | xargs -r docker rm -f >/dev/null 2>&1
  bash "$ROOT/scripts/pipeline-net.sh" down >/dev/null 2>&1
  rm -rf "$TMP" "$ROOT/runs/t16-"*
}
trap cleanup EXIT

echo "== T16 checks =="

# --- Fixture: local bare remote stands in for GitHub ---
REMOTE="$TMP/remote.git"; git init -q --bare -b main "$REMOTE"
TGT="$TMP/target"; git clone -q "$REMOTE" "$TGT"; cd "$TGT"
git config user.email t@test.local && git config user.name tester
printf '{"verifyCommand":"sh tools/run-tests.sh","regressionCommand":"sh tools/regress.sh","frozenPaths":["tools/run-tests.sh"],"dependencies":{}}\n' > pipeline.config.json
mkdir -p tools tests/acceptance
printf '#!/bin/sh\nfor f in "$1"*.sh; do sh "$f" || exit 1; done\n' > tools/run-tests.sh
printf '#!/bin/sh\nexit ${REGRESS_RC:-0}\n' > tools/regress.sh
git add -A && git commit -qm "planning: config" >/dev/null
TGTW="$TGT"; REMOTEW="$REMOTE"
if command -v cygpath >/dev/null 2>&1; then TGTW="$(cygpath -m "$TGT")"; REMOTEW="$(cygpath -m "$REMOTE")"; fi
BD=(docker run --rm -v "$TGTW:/repo" -w /repo pipeline-base:local bd)
bdq() { MSYS_NO_PATHCONV=1 "${BD[@]}" "$@" 2>/dev/null | tr -d '\r'; }
bdq init >/dev/null

add_issue() { # add_issue <title> <regression-rc>
  local id; id=$(bdq create "$1" -d "Deliver the widget for $1" --acceptance "out.txt exists" \
                  --design "design-ref: 4.5" -p 0 --silent)
  mkdir -p "$TGT/tests/acceptance/$id"
  printf '#!/bin/sh\n[ -f out.txt ] || { echo "out.txt missing"; exit 1; }\nREGRESS_RC=%s; export REGRESS_RC\n' "$2" \
    > "$TGT/tests/acceptance/$id/test.sh"
  (cd "$TGT" && git add -A && git commit -qm "planning: frozen tests for $id" >/dev/null)
  echo "$id"
}
DONE_ID=$(add_issue "done task" 0)
STUCK_ID=$(add_issue "stuck task" 0)
(cd "$TGT" && git push -q origin main)
cd "$ROOT"

# gh seam: record what `gh pr create` would have received, then emit a URL.
GHLOG="$TMP/gh"; mkdir -p "$GHLOG"
# Branch names contain "/", so flatten them before using them as filenames.
export PIPELINE_GH_CMD='B=$(echo "$PR_BRANCH" | tr / -); printf "%s" "$PR_BODY" > '"$GHLOG"'/body-$B.md; printf "%s" "$PR_TITLE" > '"$GHLOG"'/title-$B.txt; echo "https://example.test/pr/1"'

mkcfg() { node -e '
  const [f,a,t,r]=process.argv.slice(1);
  require("fs").writeFileSync(f, JSON.stringify({targetRepoPath:t,targetRepoRemote:r,image:"pipeline-base:local",agentCommand:a,wallClockMinutes:2},null,2));
' "$1" "$2" "$TGTW" "$REMOTEW"; }
AGENT_OK='sh -c "cat >/dev/null; echo done > out.txt; echo Implemented the widget and refreshed the README."'
AGENT_BAD='sh -c "cat >/dev/null; echo scratch >> notes.txt"'
mkcfg "$TMP/ok.json"  "$AGENT_OK"
mkcfg "$TMP/bad.json" "$AGENT_BAD"

# ---- Scenario 1: verified success -> pushed AND PR opened ----
bdq update "$STUCK_ID" --status blocked >/dev/null
# tee to stderr streams the run live to the terminal; stdout is still captured for the
# assertions, and pipefail keeps the runner's exit code from being masked by tee's.
OUT=$(set -o pipefail; RUN_ID=t16-done node runner/run.js --config "$TMP/ok.json" 2>&1 | tee /dev/stderr)
echo "$OUT" | grep -q "exit 0 -> done" && pass "task verified (exit 0 -> done)" || fail "success path: $(echo "$OUT" | grep -E 'exit ' | tail -2)"
echo "$OUT" | grep -q "pushed task/$DONE_ID" && pass "branch pushed to the remote" || fail "push missing"
git -C "$REMOTE" rev-parse "task/$DONE_ID" >/dev/null 2>&1 && pass "branch exists on the remote" || fail "branch not on remote"
echo "$OUT" | grep -q "opened PR: https://example.test/pr/1" && pass "PR opened for verified success" || fail "no PR"

BODY="$GHLOG/body-task-$DONE_ID.md"
[ -f "$BODY" ] && pass "PR body captured through the gh seam" || fail "no PR body"
grep -q "## Spec" "$BODY" && grep -q "Deliver the widget" "$BODY" && pass "PR body contains the issue spec" || fail "spec missing from PR body"
grep -q "## Change summary" "$BODY" && grep -q "Implemented the widget" "$BODY" && pass "PR body contains the docs-phase change summary" || fail "summary missing"
grep -q "## Verification evidence" "$BODY" && grep -q "Acceptance tests: \*\*pass\*\*" "$BODY" && pass "PR body contains verifier evidence" || fail "evidence missing"
grep -q "generated, do not edit" "$BODY" && pass "PR body marked generated" || fail "generated marker missing"
grep -q "$DONE_ID" "$GHLOG/title-task-$DONE_ID.txt" && pass "PR title carries the issue id" || fail "title wrong"
bdq show "$DONE_ID" --json | grep -q "example.test/pr/1" && pass "PR URL recorded on the issue" || fail "PR URL not written back"

# ---- Scenario 2: stuck -> branch pushed, but NO PR ----
bdq update "$STUCK_ID" --status open >/dev/null
bdq update "$DONE_ID" --status blocked >/dev/null 2>&1 || true
rm -f "$GHLOG"/*
OUT=$(set -o pipefail; RUN_ID=t16-stuck node runner/run.js --config "$TMP/bad.json" 2>&1 | tee /dev/stderr)
echo "$OUT" | grep -q "exit 10 -> stuck" && pass "unsatisfiable task -> stuck" || fail "stuck path wrong"
echo "$OUT" | grep -q "pushed task/$STUCK_ID" && pass "stuck branch pushed (work survives for review)" || fail "stuck branch not pushed"
git -C "$REMOTE" rev-parse "task/$STUCK_ID" >/dev/null 2>&1 && pass "stuck branch exists on the remote" || fail "stuck branch missing"
echo "$OUT" | grep -q "no PR opened" && pass "no PR for a stuck task" || fail "PR discipline broken"
ls "$GHLOG"/body-* >/dev/null 2>&1 && fail "gh was invoked for a stuck task" || pass "gh never invoked on failure paths"
git -C "$REMOTE" log --format=%s "task/$STUCK_ID" | grep -q "^WIP:" && pass "pushed stuck branch carries the WIP marker" || fail "WIP commit missing on remote"
bdq show "$STUCK_ID" --json | grep -q "branch pushed for review" && pass "branch link recorded on the stuck issue" || fail "no branch link"

# ---- Scenario 3: partial (acceptance pass, regressions fail) -> PR, flagged ----
PART_ID=$(bdq create "partial task" -d "Widget with a broken neighbour" --acceptance "out.txt exists" --design "design-ref: 4.4" -p 0 --silent)
mkdir -p "$TGT/tests/acceptance/$PART_ID"
printf '#!/bin/sh\n[ -f out.txt ] || exit 1\n' > "$TGT/tests/acceptance/$PART_ID/test.sh"
printf '#!/bin/sh\nexit 1\n' > "$TGT/tools/regress.sh"      # regressions now fail
(cd "$TGT" && git add -A && git commit -qm "planning: partial fixture" >/dev/null && git push -q origin main)
bdq update "$STUCK_ID" --status blocked >/dev/null
rm -f "$GHLOG"/*
OUT=$(set -o pipefail; RUN_ID=t16-partial node runner/run.js --config "$TMP/ok.json" 2>&1 | tee /dev/stderr)
echo "$OUT" | grep -q "exit 0 -> partial" && pass "regressions fail -> partial" || fail "partial not derived"
echo "$OUT" | grep -q "opened PR" && pass "partial still gets a PR (acceptance is the gate)" || fail "partial PR missing"
PBODY=$(ls "$GHLOG"/body-*.md 2>/dev/null | head -1)
grep -q "PARTIAL — needs scrutiny" "$PBODY" 2>/dev/null && pass "partial PR body flags the failing regressions" || fail "partial flag missing"
grep -q "Regression suite: \*\*fail\*\*" "$PBODY" 2>/dev/null && pass "partial PR shows the regression verdict" || fail "regression verdict missing"
grep -q "PARTIAL" "$GHLOG"/title-*.txt 2>/dev/null && pass "partial PR title marked" || fail "partial title not marked"

# ---- Static guarantees ----
grep -rqE "push[^\n]*(--force|-f\b)|force-with-lease" "$ROOT/runner/" \
  && fail "runner can force-push" || pass "runner never force-pushes"
grep -q "outcome.status !== 'done' && outcome.status !== 'partial'" "$ROOT/runner/publish.js" \
  && pass "PR gate is exactly done|partial" || fail "PR gate wrong"
grep -rqE '(^|[;&|(`"'"'"'[:space:]])gh[[:space:]]+(pr|repo|api|auth)\b' "$ROOT/pipeline/" \
  && fail "container-side code invokes gh" || pass "container holds no git/GitHub credentials"

if [[ $FAIL -eq 0 ]]; then echo "== ALL T16 CHECKS PASSED =="; else echo "== T16 CHECKS FAILED =="; fi
exit $FAIL
