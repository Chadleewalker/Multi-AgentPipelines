#!/usr/bin/env bash
# Copyright 2026 Chad Walker
# SPDX-License-Identifier: Apache-2.0

# T4 acceptance checks (V1 backlog T4; DESIGN.md s3.2 "V1 deliverable").
# Structural bar only: every s3.2 step and every load-bearing convention is stated.
# Followability is proven by the shadow-mode trial, not by this script.
# Run from Git Bash:  bash scripts/test-planning-playbook.sh
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# PLAYBOOK_FILE re-aims the checker at a fixture so the negative cases are exercisable —
# the same seam CHANGELOG_FILE and SANITIZE_FIXTURE_DIR provide for their suites. Without
# it a check can only ever be observed passing, which is the "presence standing in for
# correctness" trap this repo already has a rule about.
PB="${PLAYBOOK_FILE:-$ROOT/PLANNING.md}"
FAIL=0

ck() { # ck <label> <grep-pattern>
  if grep -qiE "$2" "$PB"; then echo "PASS  $1"; else echo "FAIL  $1"; FAIL=1; fi
}

echo "== T4 checks against PLANNING.md =="
[ -f "$PB" ] && echo "PASS  PLANNING.md exists at repo root" || { echo "FAIL  missing"; exit 1; }

# Every s3.2 session step is present.
ck "step: draft the spec"            "Draft the spec"
ck "step: sized critics"             "label decides depth, never existence"
ck "critic sizing: trivial+med/hard" "trivial and medium.*one pass"

# The trivial exemption is deleted, not softened (change-log row `spec-panel-below-line`).
# A grep for its absence is the only way this stays deleted: the sentence is easy to
# reintroduce by someone restoring "cheap tasks skip review" from memory of the old rule.
if grep -qiE "trivial[^.]*no critics|no critics[^.]*trivial" "$PB"; then
  echo "FAIL  the trivial no-critics exemption is back"; FAIL=1
else
  echo "PASS  no zero-critic tier (trivial exemption stays deleted)"
fi
ck "minimum one critic stated"       "no zero-critic tier"
ck "label decides depth not existence" "decides depth, never existence"

# The mechanical lint runs before the critics (move 3a), and the playbook names the
# command and the exit codes — an instruction a reader cannot execute is not an instruction.
ck "lint runs before the critics"    "Run the mechanical checks, then the critics"
ck "lint command is given"           "scripts/spec-lint.js"
ck "lint exit codes stated"          "could not run"

# Criteria drafted against the code, in fresh context (move 5).
ck "draft splits intent from criteria" "in two halves, in different contexts"
ck "criteria drafted in fresh context" "fresh context, against the code"

# A disposition per critic finding (move 4).
ck "disposition per finding"         "Record a disposition for every finding"
ck "disposition vocabulary"          "accepted.*rejected.*deferred"
ck "dispositions reach the draft"    "carries the panel's dispositions"

# Batching is allowed but its cost is stated.
ck "batching cost named"             "seen through one lens"
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
ck "freeze = fork-point diff"        "git merge-base <defaultBranch>"
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
