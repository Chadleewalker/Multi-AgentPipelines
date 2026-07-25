#!/usr/bin/env bash
# T2 acceptance checks (docs/v1-backlog-draft.md T2; DESIGN.md §3.1, §4.11, §4.12).
# Host driver: runs the assertions inside the base image, where bd lives.
# Run from Git Bash:  bash scripts/test-beads-roundtrip.sh [image-tag]
set -u
IMAGE="${1:-pipeline-base:local}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ROOTW="$ROOT"; command -v cygpath >/dev/null 2>&1 && ROOTW="$(cygpath -m "$ROOT")"

# --- Host-side smoke check --------------------------------------------------------
# The in-container checks below can't catch host-only breakage: new-issue.sh is run
# BY THE USER from Git Bash during planning, where MSYS rewrites container paths
# (-w /repo -> C:/Program Files/Git/repo). That bug shipped once because every test
# ran the script inside a container. This runs it the way a planning session does.
HOSTTMP="$(mktemp -d)"
(
  cd "$HOSTTMP" && git init -q -b main . && git config user.email t@test.local && git config user.name tester
  echo x > f.txt && git add -A && git commit -qm init
  TMPW="$HOSTTMP"; command -v cygpath >/dev/null 2>&1 && TMPW="$(cygpath -m "$HOSTTMP")"
  MSYS_NO_PATHCONV=1 docker run --rm -v "$TMPW:/fix" -w /fix "$IMAGE" bd init >/dev/null 2>&1
)
HOSTID=$(bash "$ROOT/scripts/new-issue.sh" -C "$HOSTTMP" -t "host smoke" -d "created from the host" \
  -a "round-trips" -r "DESIGN.md 3.1" 2>/dev/null | tr -d '\r' | tail -1)
if [ -n "$HOSTID" ]; then
  echo "PASS  new-issue.sh works from the Windows host ($HOSTID)"
else
  echo "FAIL  new-issue.sh broken when run from the host (MSYS path conversion?)"
  HOST_FAIL=1
fi
rm -rf "$HOSTTMP"
# ----------------------------------------------------------------------------------
# Git Bash rewrites /container/paths into C:\ paths (MSYS path conversion) — disable it
# for the docker call and hand Docker a Windows-style source path explicitly.
command -v cygpath >/dev/null 2>&1 && ROOT="$(cygpath -m "$ROOT")"
MSYS_NO_PATHCONV=1 docker run --rm -v "$ROOT:/pipeline-repo:ro" "$IMAGE" \
  bash /pipeline-repo/scripts/beads-roundtrip-checks.sh
RC=$?
exit $(( RC + ${HOST_FAIL:-0} ))
