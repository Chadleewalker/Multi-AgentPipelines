#!/usr/bin/env bash
# T2 acceptance checks (docs/v1-backlog-draft.md T2; DESIGN.md §3.1, §4.11, §4.12).
# Host driver: runs the assertions inside the base image, where bd lives.
# Run from Git Bash:  bash scripts/test-beads-roundtrip.sh [image-tag]
set -u
IMAGE="${1:-pipeline-base:local}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# Git Bash rewrites /container/paths into C:\ paths (MSYS path conversion) — disable it
# for the docker call and hand Docker a Windows-style source path explicitly.
command -v cygpath >/dev/null 2>&1 && ROOT="$(cygpath -m "$ROOT")"
MSYS_NO_PATHCONV=1 docker run --rm -v "$ROOT:/pipeline-repo:ro" "$IMAGE" \
  bash /pipeline-repo/scripts/beads-roundtrip-checks.sh
