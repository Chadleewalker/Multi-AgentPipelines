#!/usr/bin/env bash
# Copyright 2026 Chad Walker
# SPDX-License-Identifier: Apache-2.0

# Resolve one host-owned, Git-ignored fixture config for every checkout of this repository.
# An isolated worktree shares the main checkout's git common directory, so it can use the
# same configured disposable fixture without copying local authority into each worktree.
# A config beside the invoking checkout always wins. No config is created or rewritten.
fixture_config() {
  local root="$1" local_cfg="$1/run.config.fixture.json" common main
  if [ -f "$local_cfg" ]; then printf '%s\n' "$local_cfg"; return 0; fi
  common=$(git -C "$root" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || return 1
  [ -n "$common" ] || return 1
  main=$(cd "$common/.." 2>/dev/null && pwd) || return 1
  [ -f "$main/run.config.fixture.json" ] || return 1
  printf '%s\n' "$main/run.config.fixture.json"
}
