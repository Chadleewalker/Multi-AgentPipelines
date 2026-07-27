#!/usr/bin/env bash
# Copyright 2026 Chad Walker
# SPDX-License-Identifier: Apache-2.0

# T21 — the V1 end-to-end pass (V1 backlog T21; DESIGN.md §7).
#
# Drives all three fixture scenarios through the REAL pipeline (real runner, real
# containers, real closed network, real GitHub) with ZERO interactive input, then
# asserts the expected PR, WIP branches, Beads transitions, and run report.
#
# Determinism comes from the §4.3 agent seam: each scenario substitutes a stub from
# pipeline/stubs/ (reachable inside containers via the /pipeline scaffolding mount),
# so the proof never depends on model behaviour or consumes usage window.
#
#   bash scripts/e2e.sh          # full pass, cleans up remote branches/PRs afterwards
#   bash scripts/e2e.sh --keep   # leave branches and PRs on the remote for inspection
#
# Exits 0 only if every assertion holds.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CFG="$ROOT/run.config.fixture.json"
# Git-ignored: it names a path on your disk and a repo that is probably private.
if [ ! -f "$CFG" ]; then
  echo "FAIL  $CFG not found."
  echo "      This pass needs a disposable fixture repo of your own (see scripts/test-fixture.sh"
  echo "      for what makes one valid). Then: cp run.config.example.json run.config.fixture.json"
  echo "      and point targetRepoPath / targetRepoRemote / image at it."
  exit 1
fi
KEEP=0; [ "${1:-}" = "--keep" ] && KEEP=1
FAIL=0
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; FAIL=1; }
step() { echo; echo "=== $1"; }

FIX=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).targetRepoPath)' "$CFG")
IMAGE=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).image)' "$CFG")
FIXW="$FIX"; command -v cygpath >/dev/null 2>&1 && FIX="$(cygpath -u "$FIX")"
# Resolve the fixture's GitHub repo from the FIXTURE directory, not this one.
REPO=$(git -C "$FIX" remote get-url origin 2>/dev/null | sed -E 's#.*github\.com[:/]##; s#\.git$##')
[ -n "$REPO" ] || fail "could not resolve the fixture's GitHub repo (live PR checks would be skipped)"
bdq() { MSYS_NO_PATHCONV=1 docker run --rm -v "$FIXW:/fix" -w /fix pipeline-base:local bd "$@" 2>/dev/null | tr -d '\r'; }
status_of() { bdq show "$1" --json | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const a=JSON.parse(d||"[]");console.log((a[0]||{}).status||"?")})'; }
issue_json() { bdq show "$1" --json; }

S=$(sed -n 1p "$FIX/.fixture-ids"); B=$(sed -n 2p "$FIX/.fixture-ids"); T=$(sed -n 3p "$FIX/.fixture-ids")
STAMP="e2e-$(date +%Y%m%d-%H%M%S)"

cleanup_remote() {
  cd "$FIX" || return
  git fetch -q origin --prune 2>/dev/null
  for br in $(git ls-remote --heads origin 'task/*' 2>/dev/null | sed 's|.*refs/heads/||'); do
    if [ -n "$REPO" ]; then
      PR=$(gh pr list --repo "$REPO" --head "$br" --state all --json number -q '.[0].number' 2>/dev/null || true)
      [ -n "${PR:-}" ] && gh pr close "$PR" --repo "$REPO" >/dev/null 2>&1
    fi
    git push -q origin --delete "$br" >/dev/null 2>&1
  done
  cd "$ROOT"
}

reset_fixture() {
  for id in "$S" "$B" "$T"; do bdq update "$id" --status open >/dev/null 2>&1; done
  (cd "$FIX" && git checkout -q main && git reset -q --hard origin/main)
  cleanup_remote
}

# Run one scenario: park the other issues, point the agent command at a stub, run.
run_scenario() { # run_scenario <target-issue> <stub-name> <run-id>
  local target="$1" stub="$2" runid="$3" tmpcfg="$ROOT/.e2e.config.json"
  for id in "$S" "$B" "$T"; do
    [ "$id" = "$target" ] && bdq update "$id" --status open >/dev/null 2>&1 \
                          || bdq update "$id" --status blocked >/dev/null 2>&1
  done
  node -e '
    const fs = require("fs");
    const cfg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    cfg.agentCommand = "sh /pipeline/stubs/" + process.argv[2];
    fs.writeFileSync(process.argv[3], JSON.stringify(cfg, null, 2));
  ' "$CFG" "$stub" "$tmpcfg"
  # tee to stderr: streams live to the terminal, stdout still captured by the caller's $( ).
  ( set -o pipefail; RUN_ID="$runid" node "$ROOT/runner/run.js" --config "$tmpcfg" 2>&1 | tee /dev/stderr )
}

echo "############################################################"
echo "# T21 END-TO-END PASS — $STAMP"
echo "# fixture:   $FIX ($REPO)"
echo "# scenarios: $S success · $B bail · $T tamper"
echo "############################################################"

step "0. reset the fixture to its planning state"
reset_fixture
OPEN_OK=1
for id in "$S" "$B" "$T"; do [ "$(status_of "$id")" = "open" ] || OPEN_OK=0; done
[ "$OPEN_OK" = 1 ] && pass "all three issues open, no stale task branches on the remote" \
                   || fail "fixture not in a clean planning state"

step "1. container isolation assertions (T20) run as part of the pass"
if bash "$ROOT/scripts/test-isolation.sh" "$IMAGE" >/dev/null 2>&1; then
  pass "isolation assertions passed"
else
  fail "isolation assertions failed"
fi

step "2. SUCCESS scenario ($S) — expect exit 0, done, branch pushed, PR opened"
OUT=$(run_scenario "$S" success.sh "$STAMP-success")
echo "$OUT" | grep -q "exit 0 -> done" && pass "exit 0 -> done" || fail "success outcome wrong: $(echo "$OUT" | grep -E 'exit ' | tail -2)"
echo "$OUT" | grep -q "pushed task/$S" && pass "branch pushed to GitHub" || fail "branch not pushed"
PRURL=$(echo "$OUT" | grep -o "opened PR: .*" | head -1 | sed 's/opened PR: //')
[ -n "$PRURL" ] && pass "PR opened: $PRURL" || fail "no PR opened"
[ "$(status_of "$S")" = "closed" ] && pass "issue closed in Beads" || fail "issue not closed (got $(status_of "$S"))"
if [ -n "$REPO" ] && [ -n "$PRURL" ]; then
  PRNUM=$(basename "$PRURL")
  BODY=$(gh pr view "$PRNUM" --repo "$REPO" --json body -q .body 2>/dev/null)
  echo "$BODY" | grep -q "## Spec" && pass "live PR body carries the spec" || fail "PR body missing spec"
  echo "$BODY" | grep -q "## Change summary" && pass "live PR body carries the change summary" || fail "PR body missing summary"
  echo "$BODY" | grep -q "Acceptance tests: \*\*pass\*\*" && pass "live PR body carries verifier evidence" || fail "PR body missing evidence"
  DIFF=$(gh pr diff "$PRNUM" --repo "$REPO" 2>/dev/null)
  echo "$DIFF" | grep -q "shout" && pass "PR diff contains the real implementation" || fail "PR diff lacks the change"
  echo "$DIFF" | grep -q "tests/acceptance/" && fail "PR diff touches frozen tests" || pass "PR diff leaves frozen tests untouched"
  echo "$DIFF" | grep -q "\.run/" && fail "PR diff leaks .run/ artifacts" || pass "PR diff free of .run/ artifacts"
fi
issue_json "$S" | grep -q "outcome done" && pass "attempt notes written back to the issue" || fail "no attempt notes"

step "3. BAIL scenario ($B) — expect 3 attempts, exit 10, stuck, WIP pushed, no PR"
OUT=$(run_scenario "$B" bail.sh "$STAMP-bail")
echo "$OUT" | grep -q "exit 10 -> stuck" && pass "exit 10 -> stuck" || fail "bail outcome wrong: $(echo "$OUT" | grep -E 'exit ' | tail -2)"
SJ="$ROOT/runs/$STAMP-bail/tasks/$B/status.json"
[ "$(grep -c '"verifierResult": "fail"' "$SJ" 2>/dev/null)" = 3 ] && pass "exactly 3 attempts made" || fail "attempt count wrong"
echo "$OUT" | grep -q "pushed task/$B" && pass "WIP branch pushed (work survives review)" || fail "WIP branch not pushed"
git -C "$FIX" fetch -q origin && git -C "$FIX" log --format=%s "origin/task/$B" 2>/dev/null | grep -q "^WIP:" \
  && pass "pushed branch tip carries the WIP marker" || fail "no WIP marker on the remote branch"
echo "$OUT" | grep -q "no PR opened" && pass "no PR for a stuck task" || fail "PR discipline broken"
[ "$(status_of "$B")" = "blocked" ] && pass "issue blocked in Beads (leaves the ready queue)" || fail "issue not blocked"
issue_json "$B" | grep -q "bailed after 3" && pass "stuck state recorded on the issue" || fail "stuck state missing"

step "4. TAMPER scenario ($T) — expect verifier to catch it, exit 11, tampered, no PR"
OUT=$(run_scenario "$T" tamper.sh "$STAMP-tamper")
echo "$OUT" | grep -q "exit 11 -> tampered" && pass "exit 11 -> tampered" || fail "tamper outcome wrong: $(echo "$OUT" | grep -E 'exit ' | tail -2)"
VJ="$ROOT/runs/$STAMP-tamper/tasks/$T/verify.json"
grep -q '"acceptance": "tampered"' "$VJ" 2>/dev/null && pass "verifier reported tampering" || fail "verifier verdict wrong"
grep -q "tests/acceptance/$T" "$VJ" 2>/dev/null && pass "verifier named the modified frozen path" || fail "tampered path not identified"
echo "$OUT" | grep -q "no PR opened" && pass "no PR for a tampered task" || fail "PR opened for tampering"
[ "$(status_of "$T")" = "blocked" ] && pass "issue blocked in Beads" || fail "issue not blocked"

step "5. run report"
REPORT="$ROOT/runs/$STAMP-tamper/report.md"
[ -f "$REPORT" ] && pass "report.md generated" || fail "no report"
[ -f "$ROOT/runs/$STAMP-tamper/run.json" ] && pass "run.json manifest generated" || fail "no manifest"
AJV=(npx.cmd --yes -p ajv-formats -p ajv-cli ajv -c ajv-formats)
command -v npx.cmd >/dev/null 2>&1 || AJV=(npx --yes -p ajv-formats -p ajv-cli ajv -c ajv-formats)
if "${AJV[@]}" validate --spec=draft2020 -s "$ROOT/schemas/run.schema.json" -d "$ROOT/runs/$STAMP-tamper/run.json" >/dev/null 2>&1; then
  pass "manifest validates against run.schema.json"
else
  fail "manifest fails its schema"
fi
grep -q "TAMPERED" "$REPORT" 2>/dev/null && pass "report labels the tampered outcome" || fail "report label missing"

step "6. main was never touched"
[ "$(git -C "$FIX" rev-parse main)" = "$(git -C "$FIX" rev-parse origin/main)" ] \
  && pass "fixture main unchanged (local == origin)" || fail "main moved!"

step "7. zero interactive input"
grep -rq "read -p\|read -r -p" "$ROOT/runner/" "$ROOT/pipeline/" \
  && fail "pipeline prompts for input" || pass "no interactive prompts anywhere in runner or scaffolding"

rm -f "$ROOT/.e2e.config.json"
if [ "$KEEP" = 1 ]; then
  echo; echo "(--keep: branches and PRs left on $REPO for inspection)"
else
  step "cleanup"
  cleanup_remote
  for id in "$S" "$B" "$T"; do bdq update "$id" --status open >/dev/null 2>&1; done
  pass "remote branches/PRs removed, issues reset to open"
fi

echo
if [ "$FAIL" -eq 0 ]; then
  echo "############################################################"
  echo "# T21 PASSED — V1 pipeline proven end to end"
  echo "############################################################"
else
  echo "############################################################"
  echo "# T21 FAILED"
  echo "############################################################"
fi
exit $FAIL
