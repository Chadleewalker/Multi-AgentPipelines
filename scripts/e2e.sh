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

require_commands() {
  local command missing=()
  for command in node git gh docker sed; do
    command -v "$command" >/dev/null 2>&1 || missing+=("$command")
  done
  if [ "${#missing[@]}" -gt 0 ]; then
    echo "FAIL  live e2e host prerequisites are missing: ${missing[*]}"
    echo "      Run this script from a shell whose PATH exposes Node.js, Git, GitHub CLI, Docker, and sed."
    return 1
  fi
}

# Configuration is executable authority: do not derive a fixture path or remote
# until every command used to parse and validate it is known to exist.
require_commands || exit 1

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

if ! FIX=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).targetRepoPath)' "$CFG") \
  || [ -z "$FIX" ]; then
  echo "FAIL  could not read targetRepoPath from $CFG; refusing every mutation"
  exit 1
fi
if ! IMAGE=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).image)' "$CFG") \
  || [ -z "$IMAGE" ]; then
  echo "FAIL  could not read image from $CFG; refusing every mutation"
  exit 1
fi
FIXW="$FIX"; command -v cygpath >/dev/null 2>&1 && FIX="$(cygpath -u "$FIX")"
if ! git -C "$FIX" rev-parse --show-toplevel >/dev/null 2>&1; then
  echo "FAIL  targetRepoPath is not a Git checkout: $FIX"
  exit 1
fi
# Resolve the fixture's GitHub repo from the FIXTURE directory, not this one.
REPO=$(git -C "$FIX" remote get-url origin 2>/dev/null | sed -E 's#.*github\.com[:/]##; s#\.git$##')
[ -n "$REPO" ] || { echo "FAIL  could not resolve the fixture's GitHub repo; refusing every mutation"; exit 1; }
bdq() { MSYS_NO_PATHCONV=1 docker run --rm -v "$FIXW:/fix" -w /fix pipeline-base:local bd "$@" 2>/dev/null | tr -d '\r'; }
status_of() {
  local json
  json=$(bdq show "$1" --json) || return 1
  printf '%s' "$json" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const a=JSON.parse(d||"[]");console.log((a[0]||{}).status||"?")})'
}
issue_json() { bdq show "$1" --json; }

if [ ! -f "$FIX/.fixture-ids" ]; then
  echo "FAIL  fixture issue roster is missing: $FIX/.fixture-ids"
  exit 1
fi
S=$(sed -n 1p "$FIX/.fixture-ids"); B=$(sed -n 2p "$FIX/.fixture-ids"); T=$(sed -n 3p "$FIX/.fixture-ids")
if ! node "$ROOT/scripts/e2e-scope.js" patterns "$S" "$B" "$T" >/dev/null; then
  echo "FAIL  fixture issue roster is invalid; refusing every mutation"
  exit 1
fi
STAMP="e2e-$(date +%Y%m%d-%H%M%S)"

require_clean_fixture() {
  local dirty
  if ! dirty=$(git -C "$FIX" status --porcelain --untracked-files=all 2>&1); then
    echo "FAIL  cannot inspect the fixture working tree; refusing every mutation"
    echo "$dirty"
    return 1
  fi
  if [ -n "$dirty" ]; then
    echo "FAIL  fixture working tree is not clean; refusing every mutation"
    echo "$dirty"
    echo "      Preserve or deliberately discard those changes, then rerun."
    return 1
  fi
}

require_runtime() {
  local image missing=()
  if ! docker info >/dev/null 2>&1; then
    echo "FAIL  Docker daemon is not reachable; refusing fixture reset and remote mutation"
    echo "      Start Docker Desktop, wait for the Linux engine, then rerun."
    return 1
  fi
  for image in pipeline-base:local "$IMAGE"; do
    docker image inspect "$image" >/dev/null 2>&1 || missing+=("$image")
  done
  if [ "${#missing[@]}" -gt 0 ]; then
    echo "FAIL  live e2e Docker images are missing: ${missing[*]}"
    echo "      Build the fixture images before allowing reset or remote mutation."
    return 1
  fi
}

cleanup_remote() {
  local pattern_text branches br PR rc=0
  local patterns=()
  pattern_text=$(node "$ROOT/scripts/e2e-scope.js" patterns "$S" "$B" "$T") || return 1
  while IFS= read -r br; do [ -n "$br" ] && patterns+=("$br"); done <<< "$pattern_text"
  [ "${#patterns[@]}" -gt 0 ] || return 1
  git -C "$FIX" fetch -q origin --prune 2>/dev/null || return 1
  branches=$(git -C "$FIX" ls-remote --heads origin "${patterns[@]}" 2>/dev/null) || return 1
  while IFS= read -r br; do
    br="${br#*refs/heads/}"
    [ -n "$br" ] || continue
    node "$ROOT/scripts/e2e-scope.js" owns "$br" "$S" "$B" "$T" || continue
    if [ -n "$REPO" ]; then
      if ! PR=$(gh pr list --repo "$REPO" --head "$br" --state open --json number -q '.[0].number' 2>/dev/null); then
        rc=1
        continue
      fi
      if [ -n "${PR:-}" ] && ! gh pr close "$PR" --repo "$REPO" >/dev/null 2>&1; then
        rc=1
        continue
      fi
    fi
    git -C "$FIX" push -q origin --delete "$br" >/dev/null 2>&1 || rc=1
  done <<< "$branches"
  return "$rc"
}

restore_fixture_export() {
  if git -C "$FIX" ls-files --error-unmatch .beads/interactions.jsonl >/dev/null 2>&1; then
    git -C "$FIX" restore --source=HEAD --worktree -- .beads/interactions.jsonl
  fi
}

reset_fixture() {
  git -C "$FIX" fetch -q origin --prune || return 1
  (cd "$FIX" && git checkout -q main && git reset -q --hard origin/main) || return 1
  for id in "$S" "$B" "$T"; do
    bdq update "$id" --status open >/dev/null 2>&1 || return 1
  done
  for id in "$S" "$B" "$T"; do
    node "$ROOT/scripts/write-fixture-receipt.js" "$FIX" "$id" >/dev/null || return 1
  done
  (cd "$FIX" && git add tests/acceptance && \
    { git diff --cached --quiet || git commit -qm "planning: refresh fixture freeze receipts"; } && \
    git push -q origin main) || return 1
  cleanup_remote || return 1
}

# Run one scenario: park the other issues, point the agent command at a stub, run.
run_scenario() { # run_scenario <target-issue> <stub-name> <run-id>
  local target="$1" stub="$2" runid="$3" tmpcfg="$ROOT/.e2e.config.json"
  for id in "$S" "$B" "$T"; do
    if [ "$id" = "$target" ]; then
      bdq update "$id" --status open >/dev/null 2>&1 || return 1
    else
      bdq update "$id" --status blocked >/dev/null 2>&1 || return 1
    fi
  done
  node -e '
    const fs = require("fs");
    const cfg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    cfg.agentCommand = "sh /pipeline/stubs/" + process.argv[2];
    fs.writeFileSync(process.argv[3], JSON.stringify(cfg, null, 2));
  ' "$CFG" "$stub" "$tmpcfg"
  # The caller captures this stream for semantic assertions. Avoid /dev/stderr and
  # /dev/tty: neither is guaranteed in non-interactive Git Bash sessions.
  RUN_ID="$runid" node "$ROOT/runner/run.js" --config "$tmpcfg" 2>&1
}

echo "############################################################"
echo "# T21 END-TO-END PASS — $STAMP"
echo "# fixture:   $FIX ($REPO)"
echo "# scenarios: $S success · $B bail · $T tamper"
echo "############################################################"

step "0. reset the fixture to its planning state"
require_clean_fixture || exit 1
require_runtime || exit 1
if ! reset_fixture; then
  fail "could not reset the dedicated fixture safely"
  restore_fixture_export >/dev/null 2>&1 || true
  exit 1
fi
OPEN_OK=1
for id in "$S" "$B" "$T"; do [ "$(status_of "$id")" = "open" ] || OPEN_OK=0; done
[ "$OPEN_OK" = 1 ] && pass "all three issues open, no stale task branches on the remote" \
                   || fail "fixture not in a clean planning state"
# Baseline for step 6. Taken AFTER the reset so it measures the run, and taken as a SHA so
# the check cannot be confused by an out-of-date clone — see the note there.
MAIN_BEFORE="$(git -C "$FIX" rev-parse main)"

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
# Compare main against the SHA recorded at step 0, not against origin/main. The old check
# asserted "local == origin/main", which is a statement about how up to date this clone is,
# not about what the run did: pushing an unrelated commit to the fixture from another
# machine made it fail with "main moved!" while local main had not moved at all. A check
# that fails for a reason it does not name is worse than no check — it trains you to
# dismiss it. This measures exactly what the step claims.
MAIN_AFTER="$(git -C "$FIX" rev-parse main)"
[ "$MAIN_AFTER" = "$MAIN_BEFORE" ] \
  && pass "fixture main unchanged across the run ($MAIN_BEFORE)" \
  || fail "main moved: $MAIN_BEFORE -> $MAIN_AFTER"

step "7. zero interactive input"
grep -rq "read -p\|read -r -p" "$ROOT/runner/" "$ROOT/pipeline/" \
  && fail "pipeline prompts for input" || pass "no interactive prompts anywhere in runner or scaffolding"

rm -f "$ROOT/.e2e.config.json"
if [ "$KEEP" = 1 ]; then
  echo; echo "(--keep: branches and PRs left on $REPO for inspection)"
else
  step "cleanup"
  cleanup_remote || fail "could not remove every e2e-owned remote branch/PR"
  for id in "$S" "$B" "$T"; do
    bdq update "$id" --status open >/dev/null 2>&1 || fail "could not reset fixture issue $id to open"
  done
  [ "$FAIL" -eq 0 ] && pass "e2e-owned remote branches/PRs removed, issues reset to open"
fi
restore_fixture_export || fail "could not restore the passive Beads interaction export"

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
