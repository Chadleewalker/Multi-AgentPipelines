#!/usr/bin/env bash
# Copyright 2026 Chad Walker
# SPDX-License-Identifier: Apache-2.0

# One-session-one-folder enforcement checks — scripts/session-guard.js and the host bridge
# that wires it to an agent CLI (docs/parallel-sessions.md §8, change-log row
# `session-write-guard`).
#
# Docker-free and network-free: the Node checker builds throwaway git repositories under
# the OS temp directory and drives the real guard against them, so it touches neither this
# repo's history nor its working tree, and it installs nothing on the host — the installer
# cases run against a temporary config directory through SESSION_GUARD_CONFIG_DIR. The
# sweep discovers it by glob (scripts/test-*.sh) and it is safe to run anywhere git and
# node exist, including inside a task container.
#
# The floor below is not decoration. Roughly half of what this suite asserts is that
# ordinary work still goes through — a guard that refused everything would satisfy every
# "it blocks X" case, and a checker quietly reduced to the blocking half would look
# identical in the sweep output.
#
# Run from Git Bash:  bash scripts/test-session-guard.sh
# POSIX sh only in the body: all logic lives in the Node checker so no two shells can
# disagree about the result.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FAIL=0
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; FAIL=1; }

LC_ALL=C
export LC_ALL

echo "== session write-guard checks: scripts/session-guard.js =="

OUT="$(node "$ROOT/tests/unit/session-guard.test.js" 2>&1)"; RC=$?
echo "$OUT"

if [ "$RC" -eq 0 ]; then
  pass "session-guard checker exits 0"
else
  fail "session-guard checker exited $RC"
fi

CHECKS="$(echo "$OUT" | grep -c '^PASS  ')"
if [ "$CHECKS" -ge 70 ]; then
  pass "checker ran $CHECKS checks"
else
  fail "checker ran only $CHECKS checks (expected at least 70)"
fi

# The guard must stay installable by the installer and by nothing else. A tracked hook
# configuration is cloned into task containers that have no agent CLI, which is the
# boundary tests/unit/agent-hooks.test.js exists to hold; this is the same rule aimed at
# the file this task adds, so a later "just commit the hook entry" is caught here too.
if git -C "$ROOT" ls-files --error-unmatch .claude/settings.json >/dev/null 2>&1 &&
   grep -q 'session-guard' "$ROOT/.claude/settings.json" 2>/dev/null; then
  fail "the tracked .claude/settings.json references the guard — it must be installed, never committed"
else
  pass "no tracked agent settings file references the guard"
fi

if [ "$FAIL" -eq 0 ]; then echo "== ALL SESSION-GUARD CHECKS PASSED =="; else echo "== SESSION-GUARD CHECKS FAILED =="; fi
exit $FAIL
