#!/usr/bin/env bash
# T8 acceptance checks (docs/v1-backlog-draft.md T8; DESIGN.md 4.3/4.6/4.11).
# Host driver: runs entrypoint-checks.sh inside the base image, then validates the
# scenario status files against status.schema.json and asserts the default agent
# command is headless claude with permissions bypassed (4.3).
# Run from Git Bash:  bash scripts/test-entrypoint.sh [image-tag]
set -u
IMAGE="${1:-pipeline-base:local}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$(mktemp -d)"
FAIL=0

ROOTW="$ROOT"; OUTW="$OUT"
command -v cygpath >/dev/null 2>&1 && { ROOTW="$(cygpath -m "$ROOT")"; OUTW="$(cygpath -m "$OUT")"; }

MSYS_NO_PATHCONV=1 docker run --rm \
  -v "$ROOTW:/pipeline-repo:ro" -v "$OUTW:/out" "$IMAGE" \
  bash /pipeline-repo/scripts/entrypoint-checks.sh || FAIL=1

# Every scenario's status.json conforms to the frozen schema (4.11).
AJV=(npx.cmd --yes -p ajv-formats -p ajv-cli ajv -c ajv-formats)
command -v npx.cmd >/dev/null 2>&1 || AJV=(npx --yes -p ajv-formats -p ajv-cli ajv -c ajv-formats)
N=0
for f in "$OUT"/*.json; do
  [ -e "$f" ] || continue
  N=$((N + 1))
  if "${AJV[@]}" validate --spec=draft2020 -s "$ROOT/schemas/status.schema.json" -d "$f" >/dev/null 2>&1; then
    echo "PASS  schema: $(basename "$f") validates"
  else
    echo "FAIL  schema: $(basename "$f") does not validate"; FAIL=1
  fi
done
[ "$N" -ge 8 ] && echo "PASS  all $N scenario status files schema-checked" \
               || { echo "FAIL  expected >=8 status files, found $N"; FAIL=1; }

# 4.3: default agent command is headless claude with permissions bypassed; the
# override seam is the PIPELINE_AGENT_CMD env var.
grep -q 'PIPELINE_AGENT_CMD:-claude -p --dangerously-skip-permissions' "$ROOT/pipeline/entrypoint.sh" \
  && echo "PASS  default agent cmd: headless claude, permissions bypassed, seam via env" \
  || { echo "FAIL  default agent command wrong"; FAIL=1; }
grep -qE '\bclaude\b' "$ROOT/pipeline/status.js" \
  && { echo "FAIL  status.js invokes claude"; FAIL=1; } \
  || echo "PASS  status helper is scaffolding (no LLM)"

rm -rf "$OUT"
if [[ $FAIL -eq 0 ]]; then echo "== ALL T8 CHECKS PASSED =="; else echo "== T8 CHECKS FAILED =="; fi
exit $FAIL
