#!/usr/bin/env bash
# Copyright 2026 Chad Walker
# SPDX-License-Identifier: Apache-2.0

# A failing sibling test requires a fork-point worktree. The verifier must
# remove both of its temporary worktrees before returning to the caller.
# The runner must remove temporary clones after preparation failures and tasks,
# including unexpected errors, while honoring an explicit keep request.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)" || exit 1
trap 'rm -rf "$TMP"' EXIT

git init -q --bare "$TMP/remote.git" || exit 1
git init -q -b main "$TMP/repo" || exit 1
REPO="$TMP/repo"
git -C "$REPO" config user.name 'Verifier Test' || exit 1
git -C "$REPO" config user.email 'verifier@example.com' || exit 1
git -C "$REPO" remote add origin "$TMP/remote.git" || exit 1
mkdir -p "$REPO/tests/acceptance/first" "$REPO/tests/acceptance/second" "$REPO/tools"
printf '{"defaultBranch":"main"}\n' > "$REPO/pipeline.config.json"
printf '#!/bin/sh\nexit 1\n' > "$REPO/tools/run-acceptance.sh"
printf 'first\n' > "$REPO/tests/acceptance/first/test.txt"
printf 'second\n' > "$REPO/tests/acceptance/second/test.txt"
git -C "$REPO" add . || exit 1
git -C "$REPO" commit -qm 'baseline' || exit 1
git -C "$REPO" push -q -u origin main || exit 1
git -C "$REPO" switch -q -c task || exit 1
printf 'task change\n' > "$REPO/feature.txt"
git -C "$REPO" add feature.txt || exit 1
git -C "$REPO" commit -qm 'task' || exit 1
git -C "$REPO" push -q -u origin task || exit 1
git -C "$REPO" switch -q main || exit 1

if bash "$ROOT/scripts/verify-pr.sh" "$REPO" task > "$TMP/output" 2>&1; then
  echo 'PASS  verifier returns clean when sibling tests were already red'
else
  cat "$TMP/output"
  echo 'FAIL  verifier returned nonzero' >&2
  exit 1
fi

ALREADY_RED="$(grep -c 'ALREADY red at the fork point' "$TMP/output")"
if [ "$ALREADY_RED" -eq 2 ]; then
  echo 'PASS  both failing siblings compared with the fork point'
else
  cat "$TMP/output"
  echo "FAIL  expected two fork-point comparisons, got $ALREADY_RED" >&2
  exit 1
fi

WORKTREE_COUNT="$(git -C "$REPO" worktree list --porcelain | grep -c '^worktree ')"
if [ "$WORKTREE_COUNT" -eq 1 ]; then
  echo 'PASS  verifier removed task and fork-point worktrees'
else
  git -C "$REPO" worktree list
  echo "FAIL  expected one registered worktree, got $WORKTREE_COUNT" >&2
  exit 1
fi

if node "$ROOT/tests/unit/workspace-cleanup.test.js"; then
  echo 'PASS  runner clone cleanup checks passed'
else
  echo 'FAIL  runner clone cleanup checks failed' >&2
  exit 1
fi
