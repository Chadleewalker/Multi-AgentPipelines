#!/usr/bin/env bash
# T2 assertions — runs INSIDE the base image (invoked by test-beads-roundtrip.sh).
# Proves the beads/issue-template.md mapping: five-field round-trip, mandatory
# design-ref, attempt-log appends, status vocabulary, and blocker-aware ready queue.
set -u
FAIL=0
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; FAIL=1; }
NEW=/pipeline-repo/scripts/new-issue.sh

echo "== T2 checks (bd $(bd version 2>/dev/null | head -1)) =="

# Fresh repo + bd init (T2 bullet 1, validated here; the real target repo is T18's).
mkdir -p /tmp/rt && cd /tmp/rt
git init -q . && git config user.email t@test.local && git config user.name tester
bd init >/dev/null 2>&1 && pass "bd init in a fresh git repo" || { fail "bd init"; exit 1; }

# Five-field round-trip through bd show --json (T2 bullets 2+3).
ID=$(bash "$NEW" -t "Round-trip test" -d "Rename the widget." \
      -c "- No new dependencies" -a "verify.sh exits 0" -r "DESIGN.md 4.2" -p 1)
[ -n "$ID" ] && pass "issue created via new-issue.sh ($ID)" || fail "new-issue.sh produced no id"
bd note "$ID" "attempt 1: verifier failed (2 tests red)" >/dev/null 2>&1
J=$(bd show "$ID" --json 2>/dev/null)
echo "$J" | grep -q '## Description'            && echo "$J" | grep -q 'Rename the widget.' \
  && pass "description section round-trips"     || fail "description missing from dump"
echo "$J" | grep -q '## Constraints'            && echo "$J" | grep -q 'No new dependencies' \
  && pass "constraints section round-trips"     || fail "constraints missing from dump"
echo "$J" | grep -q '"acceptance_criteria": "verify.sh exits 0"' \
  && pass "acceptance criteria round-trips"     || fail "acceptance_criteria missing"
echo "$J" | grep -q '"design": "design-ref: DESIGN.md 4.2"' \
  && pass "design-ref round-trips"              || fail "design-ref missing"
echo "$J" | grep -q '"notes": "attempt 1: verifier failed' \
  && pass "attempt log (notes) round-trips"     || fail "attempt log missing"
echo "$J" | grep -q '"priority": 1' \
  && pass "priority round-trips"                || fail "priority missing"

# Mandatory design-ref: creation without -r must fail (§3.1).
if bash "$NEW" -t "no ref" -d x -a y >/dev/null 2>&1; then
  fail "new-issue.sh accepted an issue without design-ref"
else
  pass "new-issue.sh refuses a missing design-ref"
fi

# Status vocabulary + blocker-aware ready queue (T2 bullet 4; §4.11/§4.12 semantics).
A=$(bd create "dep A" -d x --silent); B=$(bd create "dep B" -d y --deps "$A" --silent)
r() { bd ready --json 2>/dev/null | grep -c "\"id\": \"$1\""; }
[ "$(r "$A")" = 1 ] && [ "$(r "$B")" = 0 ] \
  && pass "dependency gates ready (B waits on A)"      || fail "dependency gating broken"
bd update "$A" --status in_progress >/dev/null 2>&1
[ "$(r "$A")" = 0 ] && pass "in_progress leaves ready" || fail "in_progress still ready"
bd close "$A" >/dev/null 2>&1
[ "$(r "$B")" = 1 ] && pass "closing the dep unlocks B" || fail "close did not unlock"
bd update "$B" --status blocked >/dev/null 2>&1
[ "$(r "$B")" = 0 ] && pass "blocked leaves ready (loop-termination status)" \
                     || fail "blocked still in ready queue"
bd update "$B" --status open >/dev/null 2>&1 \
  && pass "full status vocabulary accepted (open/in_progress/blocked/closed)" \
  || fail "status transition rejected"

if [ "$FAIL" -eq 0 ]; then echo "== ALL T2 CHECKS PASSED =="; else echo "== T2 CHECKS FAILED =="; fi
exit "$FAIL"
