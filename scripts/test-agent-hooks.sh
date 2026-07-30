#!/usr/bin/env bash
# Copyright 2026 Chad Walker
# SPDX-License-Identifier: Apache-2.0

# Container-hygiene suite — no tracked file configures an agent hook (DESIGN.md
# change-log row `agent-hooks-untracked`).
#
# Docker-free and network-free: it reads tracked files only, so like test-sanitize.sh and
# test-changelog.sh it needs no base image, no pipeline network and no target repo. The
# sweep discovers it by glob (scripts/test-*.sh) and it is safe to run anywhere, including
# inside a task container.
#
# The negative cases are the point. This suite exists because the rule it enforces was
# already written down in ONBOARDING.md and still lost: `bd` rewrites
# `.claude/settings.json` when it re-initialises, so the SessionStart hook that onboarding
# had deleted came back in a later commit. A checker that matched nothing would be
# indistinguishable from a repo that is clean, which is exactly how the entry survived.
#
# Run from Git Bash:  bash scripts/test-agent-hooks.sh
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FAIL=0
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; FAIL=1; }

CHECKER="$ROOT/tests/unit/agent-hooks.test.js"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "== container-hygiene checks (agent hooks) =="

# ---- case 1: the real repo is clean -------------------------------------------------
OUT="$(node "$CHECKER" 2>&1)"; RC=$?
echo "$OUT"
if [ "$RC" -eq 0 ]; then
  pass "checker exits 0 against the real tracked tree"
else
  fail "checker exited $RC against the real tracked tree"
fi

CHECKS="$(echo "$OUT" | grep -c '^PASS  ')"
if [ "$CHECKS" -ge 3 ]; then
  pass "checker ran $CHECKS checks"
else
  fail "checker ran only $CHECKS checks (expected at least 3)"
fi

# ---- negative cases ------------------------------------------------------------------
# Each builds a fixture, runs the checker through the AGENT_HOOKS_FIXTURE_DIR seam, and
# asserts BOTH a non-zero exit and a printed FAIL line. Exit code alone would be satisfied
# by a checker that crashed on startup.
neg() {
  NAME="$1"; DIR="$2"
  O="$(AGENT_HOOKS_FIXTURE_DIR="$DIR" node "$CHECKER" 2>&1)"; R=$?
  if [ "$R" -ne 0 ]; then pass "$NAME: checker exits non-zero"; else fail "$NAME: checker exited 0"; fi
  if echo "$O" | grep -q '^FAIL  '; then
    pass "$NAME: checker prints a FAIL line (proves it ran, not that it is missing)"
  else
    fail "$NAME: no FAIL line — checker may not have run"
  fi
}

# case 2: the exact regression — a hooks entry in .claude/settings.json. This is the shape
# `bd` writes back, so this fixture is the thing that actually recurs.
mkdir -p "$TMP/f2/.claude"
cat > "$TMP/f2/.claude/settings.json" <<'JSON'
{
  "hooks": {
    "SessionStart": [
      { "matcher": "", "hooks": [ { "type": "command", "command": "bd prime --hook-json" } ] }
    ]
  },
  "permissions": { "allow": ["Bash(ls *)"] }
}
JSON
if grep -q '"hooks"' "$TMP/f2/.claude/settings.json"; then
  pass "case 2 fixture really contains a hooks entry"
else
  fail "case 2 fixture was not written correctly — the negative case cannot fire"
fi
neg "hooks entry in .claude/settings.json" "$TMP/f2"

# case 3: a committed .codex/hooks.json
mkdir -p "$TMP/f3/.codex"
printf '{ "hooks": { "SessionStart": [] } }\n' > "$TMP/f3/.codex/hooks.json"
neg "committed .codex/hooks.json" "$TMP/f3"

# case 4: a committed hook script under .claude/hooks/
mkdir -p "$TMP/f4/.claude/hooks"
printf '#!/bin/sh\nbd prime\n' > "$TMP/f4/.claude/hooks/session-start.sh"
neg "committed .claude/hooks/ script" "$TMP/f4"

# case 5: a hooks key hiding in a settings file that is not valid JSON. A checker that
# only inspects parsed JSON reports "cannot be checked" and exits 0 — silently allowing
# the thing it exists to stop.
mkdir -p "$TMP/f5/.claude"
printf '{ "hooks": { "SessionStart": [] }, }\n' > "$TMP/f5/.claude/settings.json"
neg "hooks key in unparseable settings" "$TMP/f5"

# ---- case 6: a clean fixture must NOT fail ------------------------------------------
# Without this every case above passes vacuously: a checker that failed on everything
# would satisfy all four.
#
# Note what is NOT in here: `.claude/settings.local.json`. That is the sanctioned home for
# hooks, but it earns its exemption by being git-ignored, not by being spelled `.local` —
# so the rule deliberately still flags it if it is ever tracked, and putting one in this
# fixture (which stands in for the tracked tree) would rightly fail.
mkdir -p "$TMP/f6/.claude"
printf '{ "permissions": { "allow": ["Bash(ls *)"] } }\n' > "$TMP/f6/.claude/settings.json"
printf 'ordinary repo content\n' > "$TMP/f6/README.md"
O6="$(AGENT_HOOKS_FIXTURE_DIR="$TMP/f6" node "$CHECKER" 2>&1)"; R6=$?
if [ "$R6" -eq 0 ]; then
  pass "clean fixture: checker exits 0 (rules are not matching everything)"
else
  echo "$O6"
  fail "clean fixture: checker exited $R6"
fi

if [ "$FAIL" -eq 0 ]; then echo "== ALL CONTAINER-HYGIENE CHECKS PASSED =="; else echo "== CONTAINER-HYGIENE CHECKS FAILED =="; fi
exit $FAIL
