#!/usr/bin/env bash
# Copyright 2026 Chad Walker
# SPDX-License-Identifier: Apache-2.0

# Install the per-machine git hooks that keep the code and the issue database in step.
# Idempotent — safe to re-run, and re-running is how you pick up a change to this script.
#
# Why this is a script and not committed hooks. Issues live in `refs/dolt/data`, which
# `git pull` does not fetch, so a second machine pulls the code and silently keeps a stale
# task queue — this repo lost its beads that way once already. The fix is a `post-merge`
# hook, but hooks must NOT be committed here: DESIGN.md's `dogfood-onboarding` row records
# that pipeline projects carry no committed hooks, because this repo is a target of its own
# pipeline and anything committed lands in a task container that has no `bd` and no
# network. So the hooks stay host-only (`.beads/hooks/`, git-ignored, activated by a local
# `core.hooksPath` that is never committed) and the *installer* is what travels.
#
# Run once per clone, from Git Bash:  bash scripts/install-hooks.sh
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 1

MARK='# --- BEGIN AUTO-PULL (scripts/install-hooks.sh) ---'
HOOK="$ROOT/.beads/hooks/post-merge"

if ! command -v bd >/dev/null 2>&1; then
  echo "FAIL  bd is not on PATH — install beads first (https://github.com/steveyegge/beads)"
  exit 1
fi

# --chain preserves any hooks already present; bd rewrites only between its own markers.
echo "== installing bd git hooks =="
bd hooks install --beads --chain || exit 1

[ -f "$HOOK" ] || { echo "FAIL  $HOOK was not created by 'bd hooks install'"; exit 1; }

# Drop any block a previous run of this script appended, so the version below always wins.
if grep -qF "$MARK" "$HOOK"; then
  TMP="$HOOK.tmp.$$"
  sed "/$(printf '%s' "$MARK" | sed 's/[].[^$*\/]/\\&/g')/,\$d" "$HOOK" > "$TMP" || { rm -f "$TMP"; exit 1; }
  mv "$TMP" "$HOOK" || exit 1
fi

# bd's own post-merge does NOT pull the database: it handles JSONL import only, and skips
# even that when sync.remote is set. Verified against bd 1.1.2 — `bd hooks run post-merge`
# prints "skipping JSONL import because sync.remote is configured" and exits 0 having done
# nothing. This block is the part that actually syncs issues.
cat >> "$HOOK" <<'BLOCK'
# --- BEGIN AUTO-PULL (scripts/install-hooks.sh) ---
# Appended outside bd's markers, so `bd hooks install` upgrades preserve it.
# Re-run scripts/install-hooks.sh to update this block; do not hand-edit.
if command -v bd >/dev/null 2>&1 && [ -z "${BD_SKIP_AUTO_PULL:-}" ]; then
  # Only when a remote is configured; a fresh clone without one would otherwise print an
  # error on every merge.
  if bd dolt remote list 2>/dev/null | grep -q .; then
    echo "beads: pulling issue database…"
    # Never fail the hook. post-merge runs *after* the merge has happened, so a network
    # blip must not look like a broken pull. Bounded so an unreachable remote cannot hang
    # the terminal. Set BD_SKIP_AUTO_PULL=1 to opt out for one command.
    if command -v timeout >/dev/null 2>&1; then
      timeout "${BEADS_PULL_TIMEOUT:-120}" bd dolt pull || echo >&2 "beads: dolt pull failed or timed out — run 'bd dolt pull' by hand"
    else
      bd dolt pull || echo >&2 "beads: dolt pull failed — run 'bd dolt pull' by hand"
    fi
  fi
fi
exit 0
BLOCK

chmod +x "$HOOK" 2>/dev/null

# Assert the artifact is *right*, not merely present (§3.6): a hook file that exists but
# never pulls is the failure this whole script is here to prevent, and it looks identical
# to a working one from the outside.
if grep -qF "$MARK" "$HOOK" && grep -q "bd dolt pull" "$HOOK"; then
  echo "PASS  post-merge will run 'bd dolt pull' after every git pull/merge"
else
  echo "FAIL  the auto-pull block is missing from $HOOK"
  exit 1
fi

if [ -x "$HOOK" ]; then
  echo "PASS  hook is executable"
else
  echo "FAIL  hook is not executable — git will silently skip it"
  exit 1
fi

HP="$(git config --local core.hooksPath || true)"
if [ -n "$HP" ]; then
  echo "PASS  core.hooksPath = $HP (local config, never committed)"
else
  echo "FAIL  core.hooksPath is unset — git will not find these hooks"
  exit 1
fi

if bd dolt remote list 2>/dev/null | grep -q .; then
  echo "PASS  a Dolt remote is configured, so the pull has somewhere to pull from"
else
  echo "NOTE  no Dolt remote configured — the hook will no-op until you add one:"
  echo "      bd dolt remote add origin <git remote url>"
fi

echo "== hooks installed =="
