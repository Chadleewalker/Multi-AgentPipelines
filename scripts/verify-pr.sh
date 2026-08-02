#!/usr/bin/env bash
# Copyright 2026 Chad Walker
# SPDX-License-Identifier: Apache-2.0
#
# verify-pr.sh — the host-side gate a task PR must clear before it is merged.
#
# WHY THIS EXISTS. The verifier runs inside the container and decides pass/fail for the
# TASK. It does not decide whether the result is safe to put on the integration branch.
# hal-cow made the difference concrete: it passed every in-container gate — five acceptance
# files, 51 engine tests, the verifier, a run report reading "done" — and shipped a module
# git classified as binary, i.e. 160 lines of new engine code no reviewer could read. That
# was caught by a human reading a diff stat, which does not scale.
#
# This re-runs the task's own tests ON THE HOST rather than trusting the container's word,
# re-checks the things a container cannot be trusted to self-report (did it touch the frozen
# paths?), and surfaces the shape of the diff. It is deliberately weaker than a human
# reading the code, and it is not a substitute for one on anything unusual.
#
# Usage:  bash scripts/verify-pr.sh <repo-dir> <branch> [<acceptance-dir>]
# Exit:   0 = clean, safe to merge · 1 = a check failed · 2 = could not run
#         (a 2 is never a pass — it means a check never looked)

set -u

REPO="${1:?usage: verify-pr.sh <repo-dir> <branch> [<acceptance-dir>]}"
BRANCH="${2:?usage: verify-pr.sh <repo-dir> <branch> [<acceptance-dir>]}"
ACCEPT="${3:-}"

cd "$REPO" 2>/dev/null || { echo "verify-pr: cannot cd to $REPO" >&2; exit 2; }

DEFAULT_BRANCH="$(node -e "
  try { const c = require('./pipeline.config.json'); process.stdout.write(c.defaultBranch || 'main'); }
  catch { process.stdout.write('main'); }
" 2>/dev/null)" || { echo "verify-pr: cannot read pipeline.config.json" >&2; exit 2; }

echo "verify-pr: $BRANCH -> $DEFAULT_BRANCH  (in $REPO)"
git fetch -q origin "$BRANCH" || { echo "verify-pr: cannot fetch $BRANCH" >&2; exit 2; }

WT="$(mktemp -d 2>/dev/null || echo "${TMPDIR:-/tmp}/verify-pr-$$")"
rm -rf "$WT"
git worktree add -q --detach "$WT" "origin/$BRANCH" || { echo "verify-pr: cannot create worktree" >&2; exit 2; }

STATUS=0
fail() { echo "  FAIL  $1"; STATUS=1; }
pass() { echo "  ok    $1"; }

# --- 1. Frozen paths. The container must not have edited what judges it. The verifier
#        already checks this, but it is the one claim we least want to take on trust.
CHANGED_FROZEN="$(git diff --name-only "origin/$DEFAULT_BRANCH...origin/$BRANCH" -- \
  tests/acceptance/ tools/run-acceptance.sh 2>/dev/null | wc -l | tr -d ' ')"
if [ "$CHANGED_FROZEN" = "0" ]; then
  pass "frozen paths untouched"
else
  fail "frozen paths modified ($CHANGED_FROZEN file(s)) — this is tampering, do not merge"
  git diff --name-only "origin/$DEFAULT_BRANCH...origin/$BRANCH" -- tests/acceptance/ tools/run-acceptance.sh | sed 's/^/        /'
fi

# --- 2. Nothing unreviewable. A file git calls binary shows as "Bin N -> M bytes" and
#        cannot be read in review.
BINARY="$(git diff --numstat "origin/$DEFAULT_BRANCH...origin/$BRANCH" | awk '$1 == "-" && $2 == "-" { print $3 }')"
if [ -z "$BINARY" ]; then
  pass "no binary-classified files in the diff"
else
  fail "binary-classified file(s) in the diff — unreviewable:"
  echo "$BINARY" | sed 's/^/        /'
fi

# --- 3. The task's own acceptance tests, re-run on the host.
cd "$WT" || { echo "verify-pr: cannot enter worktree" >&2; exit 2; }
[ -d node_modules ] || [ ! -d "$REPO/node_modules" ] || ln -sfn "$REPO/node_modules" node_modules

if [ -n "$ACCEPT" ]; then
  if sh tools/run-acceptance.sh "$ACCEPT" >/tmp/vp-accept.$$ 2>&1; then
    pass "acceptance ($ACCEPT) passes on the host"
  else
    fail "acceptance ($ACCEPT) FAILS on the host — the container's pass did not reproduce"
    tail -20 /tmp/vp-accept.$$ | sed 's/^/        /'
  fi
  rm -f /tmp/vp-accept.$$
else
  echo "  --    no acceptance dir given; skipping (pass one to check it)"
fi

# --- 3b. EVERY OTHER task's frozen tests. The in-container verifier runs only the
#         current task's directory, so a task that breaks a SIBLING's frozen test is
#         invisible to it — which is exactly what happened: hal-1wz reordered an options
#         array, moved the playthrough hal-cow's guard pins, and landed on master green.
#         Three gates missed it because all three were scoped to the task.
#
#         A FAILING SIBLING IS NOT AUTOMATICALLY A REGRESSION. Acceptance tests are frozen
#         BEFORE their implementation exists, so a directory can be red at the fork point
#         and stay red through no fault of this branch — which is the normal state whenever
#         more than one task's tests are frozen ahead of a batch. The first version of this
#         check assumed every sibling was green and reported "BROKEN by this branch" for all
#         of them, which is a check failing while naming a cause it never established (the
#         `docs/STATUS.md` defect-10 family). So when a sibling fails, we re-run it at the
#         FORK POINT and only call it a regression if it passed there.
BASE="$(git merge-base "origin/$DEFAULT_BRANCH" "origin/$BRANCH" 2>/dev/null)"
BASE_WT=""
base_worktree() {
  [ -n "$BASE_WT" ] && { echo "$BASE_WT"; return 0; }
  [ -n "$BASE" ] || return 1
  BASE_WT="$(mktemp -d 2>/dev/null || echo "${TMPDIR:-/tmp}/verify-pr-base-$$")"
  rm -rf "$BASE_WT"
  git -C "$REPO" worktree add -q --detach "$BASE_WT" "$BASE" 2>/dev/null || { BASE_WT=""; return 1; }
  [ -d "$BASE_WT/node_modules" ] || [ ! -d "$REPO/node_modules" ] \
    || ln -sfn "$REPO/node_modules" "$BASE_WT/node_modules"
  echo "$BASE_WT"
}

for d in tests/acceptance/*/; do
  case "$d" in
    "$ACCEPT"|"${ACCEPT%/}/") continue ;;   # already run above
    */_control/) continue ;;                # harness check, run by the freeze gate
  esac
  [ -d "$d" ] || continue
  if sh tools/run-acceptance.sh "$d" >/tmp/vp-sib.$$ 2>&1; then
    pass "sibling acceptance $d still passes"
  else
    BW="$(base_worktree)" || BW=""
    if [ -z "$BW" ]; then
      # No baseline means we cannot tell a regression from a pre-existing failure. Say so,
      # and fail — an unknown is never a pass.
      fail "sibling acceptance $d fails, and the fork point could not be checked out to compare"
      tail -15 /tmp/vp-sib.$$ | sed 's/^/        /'
    elif ( cd "$BW" && sh tools/run-acceptance.sh "$d" >/dev/null 2>&1 ); then
      fail "sibling acceptance $d BROKEN by this branch — it passed at the fork point ($BASE)"
      tail -15 /tmp/vp-sib.$$ | sed 's/^/        /'
    else
      pass "sibling acceptance $d was ALREADY red at the fork point — not this branch's doing"
    fi
  fi
  rm -f /tmp/vp-sib.$$
done

# --- 4. Regressions: the standing suite plus whatever hygiene checks it carries.
#        Same rule as the sibling loop: the standing suite typically runs every acceptance
#        directory, so it is red at the fork point whenever any task's tests are frozen
#        ahead of their implementation. Compare before blaming the branch.
if [ -f tools/run-regressions.sh ]; then
  if sh tools/run-regressions.sh >/tmp/vp-reg.$$ 2>&1; then
    pass "regressions pass"
  else
    BW="$(base_worktree)" || BW=""
    if [ -z "$BW" ]; then
      fail "regressions FAIL, and the fork point could not be checked out to compare"
      tail -20 /tmp/vp-reg.$$ | sed 's/^/        /'
    elif ( cd "$BW" && sh tools/run-regressions.sh >/dev/null 2>&1 ); then
      fail "regressions FAIL — they passed at the fork point ($BASE)"
      tail -20 /tmp/vp-reg.$$ | sed 's/^/        /'
    else
      pass "regressions were ALREADY failing at the fork point — not this branch's doing"
      echo "        (still worth reading; shown so it is not silently swallowed)"
      tail -6 /tmp/vp-reg.$$ | sed 's/^/        /'
    fi
  fi
  rm -f /tmp/vp-reg.$$
fi

# The fork-point worktree, if one was created for the comparisons above.
[ -n "$BASE_WT" ] && { git -C "$REPO" worktree remove --force "$BASE_WT" >/dev/null 2>&1; git -C "$REPO" worktree prune >/dev/null 2>&1; }

# --- 5. Diff shape, reported not judged. A human should look at anything surprising.
cd "$REPO" || true
echo "  --    diff shape:"
git diff --stat "origin/$DEFAULT_BRANCH...origin/$BRANCH" | tail -12 | sed 's/^/        /'

git worktree remove --force "$WT" >/dev/null 2>&1
git worktree prune >/dev/null 2>&1

if [ "$STATUS" = "0" ]; then
  echo "verify-pr: CLEAN — safe to merge"
else
  echo "verify-pr: BLOCKED — do not merge until the failures above are understood"
fi
exit "$STATUS"
