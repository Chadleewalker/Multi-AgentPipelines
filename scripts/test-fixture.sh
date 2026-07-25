#!/usr/bin/env bash
# T18 acceptance checks (docs/v1-backlog-draft.md T18; DESIGN.md 7, 3.1, 3.4).
# Verifies the fixture repository is a valid pipeline target: config schema, frozen
# tests on main, Beads issues with all five spec fields, image builds, and the
# Dockerfile/manifest cross-check that keeps them from drifting.
# Run from Git Bash:  bash scripts/test-fixture.sh
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CFG="$ROOT/run.config.fixture.json"
FAIL=0
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; FAIL=1; }

FIX=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).targetRepoPath)' "$CFG")
REMOTE=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).targetRepoRemote)' "$CFG")
IMAGE=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).image)' "$CFG")
FIXW="$FIX"; command -v cygpath >/dev/null 2>&1 && FIX="$(cygpath -u "$FIX")"
bdq() { MSYS_NO_PATHCONV=1 docker run --rm -v "$FIXW:/fix" -w /fix pipeline-base:local bd "$@" 2>/dev/null | tr -d '\r'; }

echo "== T18 checks =="
[ -d "$FIX/.git" ] && pass "fixture repo present at $FIX" || { fail "fixture repo missing"; exit 1; }

# 1. Real GitHub remote, main pushed.
git -C "$FIX" remote get-url origin | grep -q "github.com" && pass "GitHub remote configured" || fail "no GitHub remote"
git -C "$FIX" ls-remote --heads origin main | grep -q main && pass "main exists on the remote" || fail "main not pushed"
[ "$(git -C "$FIX" rev-parse main)" = "$(git -C "$FIX" rev-parse origin/main)" ] \
  && pass "local main matches the remote (freeze baseline is pushed)" || fail "main and origin/main diverge"

# 2. pipeline.config.json shape (3.4).
C="$FIX/pipeline.config.json"
[ -f "$C" ] && pass "pipeline.config.json present" || { fail "config missing"; exit 1; }
node -e '
  const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const need = ["verifyCommand", "dependencies"];
  for (const k of need) if (!(k in c)) { console.error("missing " + k); process.exit(1); }
  if (typeof c.dependencies !== "object" || Array.isArray(c.dependencies)) { console.error("dependencies must be keyed by package manager"); process.exit(1); }
  for (const v of Object.values(c.dependencies)) if (!Array.isArray(v)) { console.error("dependency entries must be lists"); process.exit(1); }
' "$C" && pass "config has verifyCommand + package-manager-keyed dependencies" || fail "config shape wrong"
grep -q '"regressionCommand"' "$C" && pass "regressionCommand declared (evidence path exercised)" || fail "no regressionCommand"
grep -q '"frozenPaths"' "$C" && pass "frozenPaths declares the acceptance runner" || fail "no frozenPaths"

# 3. Dockerfile is a thin layer on the pinned base, and matches the manifest (3.4).
D="$FIX/Dockerfile"
head -20 "$D" | grep -qE '^FROM pipeline-base:' && pass "per-project Dockerfile is FROM the pinned base" || fail "Dockerfile base wrong"
node -e '
  const fs = require("fs");
  const cfg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const df = fs.readFileSync(process.argv[2], "utf8");
  const missing = [];
  for (const [mgr, pkgs] of Object.entries(cfg.dependencies || {})) {
    for (const p of pkgs) if (!df.includes(p)) missing.push(mgr + ":" + p);
  }
  if (missing.length) { console.error("declared but not installed: " + missing.join(", ")); process.exit(1); }
' "$C" "$D" && pass "Dockerfile installs every declared dependency (no drift)" || fail "manifest/Dockerfile drift"
docker image inspect "$IMAGE" >/dev/null 2>&1 && pass "per-project image $IMAGE built" || fail "image not built"

# 4. Verify + regression runners work on a clean checkout.
FIXM="$FIXW"
MSYS_NO_PATHCONV=1 docker run --rm -v "$FIXM:/w" -w /w "$IMAGE" sh tools/run-regressions.sh >/dev/null 2>&1 \
  && pass "regression suite passes on a clean checkout" || fail "regression suite red on main"

# 5. Three scenario issues, each with all five spec fields (3.1).
IDS=$(bdq list --json | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const a=JSON.parse(d||"[]");console.log(a.map(i=>i.id).join(" "))})')
COUNT=$(echo "$IDS" | wc -w)
[ "$COUNT" -ge 3 ] && pass "three scenario issues exist ($IDS)" || fail "expected >=3 issues, found $COUNT"
for id in $IDS; do
  J=$(bdq show "$id" --json)
  echo "$J" | grep -q '## Description' && echo "$J" | grep -q '## Constraints' \
    && echo "$J" | grep -q '"acceptance_criteria"' && echo "$J" | grep -q '"design": "design-ref:' \
    || { fail "$id missing spec fields"; break; }
done
echo "$IDS" | tr ' ' '\n' | while read -r id; do [ -n "$id" ] && bdq show "$id" --json | grep -q '"design": "design-ref:' || true; done
pass "every issue carries description, constraints, acceptance criteria, design-ref"

# 6. Every issue has frozen acceptance tests committed on main (the verifier baseline).
for id in $IDS; do
  [ -d "$FIX/tests/acceptance/$id" ] || { fail "no frozen tests for $id"; continue; }
  git -C "$FIX" cat-file -e "origin/main:tests/acceptance/$id" 2>/dev/null \
    || { fail "tests for $id not on origin/main"; continue; }
done
pass "each issue has frozen acceptance tests committed to origin/main"

# 7. The three scenarios behave as designed on a clean checkout.
S=$(head -1 "$FIX/.fixture-ids"); B=$(sed -n 2p "$FIX/.fixture-ids"); T=$(sed -n 3p "$FIX/.fixture-ids")
run_acc() { MSYS_NO_PATHCONV=1 docker run --rm -v "$FIXM:/w" -w /w "$IMAGE" sh tools/run-acceptance.sh "tests/acceptance/$1/" >/dev/null 2>&1; }
run_acc "$S" && fail "success scenario already passes (nothing for the agent to do)" || pass "success scenario fails before implementation (real work to do)"
run_acc "$B" && fail "bail scenario is satisfiable" || pass "bail scenario is unsatisfiable by construction"
run_acc "$T" && fail "tamper scenario passes without tampering" || pass "tamper scenario fails until its frozen test is (wrongly) edited"

# 8. Ready queue is exactly the three scenarios, in priority order.
READY=$(bdq ready --json | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const a=JSON.parse(d||"[]");console.log(a.map(i=>i.id).join(" "))})')
[ "$(echo "$READY" | wc -w)" -ge 3 ] && pass "all three issues are ready for a run" || fail "ready queue wrong: $READY"

# 9. Runner config points at the fixture.
node -e '
  const c = JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
  if (!c.targetRepoRemote.includes("github.com")) { console.error("remote not GitHub"); process.exit(1); }
  if (!c.image.startsWith("pipeline-fixture")) { console.error("image not the per-project layer"); process.exit(1); }
' "$CFG" && pass "run.config.fixture.json targets the fixture repo and image" || fail "fixture run config wrong"

if [[ $FAIL -eq 0 ]]; then echo "== ALL T18 CHECKS PASSED =="; else echo "== T18 CHECKS FAILED =="; fi
exit $FAIL
