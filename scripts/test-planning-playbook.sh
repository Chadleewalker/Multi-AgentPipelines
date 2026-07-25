#!/usr/bin/env bash
# T4 acceptance checks (docs/v1-backlog-draft.md T4; DESIGN.md s3.2 "V1 deliverable").
# Structural bar only: every s3.2 step and every load-bearing convention is stated.
# Followability is proven by the shadow-mode trial, not by this script.
# Run from Git Bash:  bash scripts/test-planning-playbook.sh
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PB="$ROOT/PLANNING.md"
FAIL=0

ck() { # ck <label> <grep-pattern>
  if grep -qiE "$2" "$PB"; then echo "PASS  $1"; else echo "FAIL  $1"; FAIL=1; fi
}

echo "== T4 checks against PLANNING.md =="
[ -f "$PB" ] && echo "PASS  PLANNING.md exists at repo root" || { echo "FAIL  missing"; exit 1; }

# Every s3.2 session step is present.
ck "step: draft the spec"            "Draft the spec"
ck "step: sized critics"             "critics, sized to the difficulty"
ck "critic sizing: trivial/med/hard" "trivial.*no critics"
if grep -qi "ambiguity" "$PB" && grep -qi "testability" "$PB" && grep -qi "scope.*(is this secretly" "$PB"; then
  echo "PASS  critic panel for hard tasks"
else
  echo "FAIL  critic panel for hard tasks"; FAIL=1
fi
ck "step: tests before code"         "before any code exists"
ck "step: coverage check"            "orphan on either side is a spec bug"
ck "step: user approves intent"      "user approves intent"
ck "step: freeze on approval"        "Nothing is frozen and nothing runs until this"
ck "step: create the issue"          "new-issue.sh"
ck "step: declare dependencies"      "Declare dependencies"
ck "step: manual image rebuild"      "manual step"

# s3.1 conventions stated correctly.
ck "five fields listed"              "Attempt log"
ck "design-ref mandatory"            "design-ref.*[Mm]andatory"
ck "acceptance test home"            "tests/acceptance/<issue-id>/"
ck "freeze = fork-point diff"        "git merge-base main"
ck "tamper scope: whole tree"        "all of .tests/acceptance/"

# s3.4 conventions stated correctly.
ck "manifest keyed by pkg manager"   "keyed by package"
ck "no arbitrary install commands"   "never arbitrary install commands"
ck "Dockerfile cross-check"          "cross-check the Dockerfile"
ck "runner never builds images"      "runner only asserts the image exists"

# Change protocol + acceptance bar.
ck "spec change reopens approval"    "reopens the approval gate"
ck "structural bar stated"           "acceptance bar is structural"

if [[ $FAIL -eq 0 ]]; then echo "== ALL T4 CHECKS PASSED =="; else echo "== T4 CHECKS FAILED =="; fi
exit $FAIL
