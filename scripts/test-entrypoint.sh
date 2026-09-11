#!/usr/bin/env bash
# Copyright 2026 Chad Walker
# SPDX-License-Identifier: Apache-2.0

# T8 acceptance checks (V1 backlog T8; DESIGN.md 4.3/4.6/4.11).
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

# 4.3 / 6.5: provider selection, defaults, and the command override are one
# structural contract. Keep these assertions beside the in-image behavior check
# so a provider-aware entrypoint cannot drift back to one hard-coded command.
grep -qF 'PROVIDER="${PIPELINE_PROVIDER:-claude}"' "$ROOT/pipeline/entrypoint.sh" \
  && grep -qF 'AGENT_DEFAULT="claude -p --dangerously-skip-permissions${MODEL_ARG}"' "$ROOT/pipeline/entrypoint.sh" \
  && grep -qF 'AGENT_CMD="${PIPELINE_AGENT_CMD:-$AGENT_DEFAULT}"' "$ROOT/pipeline/entrypoint.sh" \
  && echo "PASS  default provider: headless claude, permissions bypassed, seam via env" \
  || { echo "FAIL  default Claude provider contract wrong"; FAIL=1; }
grep -qF 'codex exec${MODEL_ARG}' "$ROOT/pipeline/entrypoint.sh" \
  && grep -qF 'model_reasoning_effort=\"$EFFORT\"' "$ROOT/pipeline/entrypoint.sh" \
  && grep -qF 'shell_environment_policy.ignore_default_excludes=false' "$ROOT/pipeline/entrypoint.sh" \
  && grep -qF 'shell_environment_policy.filters.CODEX_API_KEY=\"exclude\"' "$ROOT/pipeline/entrypoint.sh" \
  && grep -qF -- '--approve-for-me --ephemeral --ignore-user-config' "$ROOT/pipeline/entrypoint.sh" \
  && grep -qF -- '--ignore-rules --strict-config --json -' "$ROOT/pipeline/entrypoint.sh" \
  && echo "PASS  Codex provider: pinned noninteractive security contract" \
  || { echo "FAIL  Codex provider contract wrong"; FAIL=1; }
grep -qE '\bclaude\b' "$ROOT/pipeline/status.js" \
  && { echo "FAIL  status.js invokes claude"; FAIL=1; } \
  || echo "PASS  status helper is scaffolding (no LLM)"

rm -rf "$OUT"
if [[ $FAIL -eq 0 ]]; then echo "== ALL T8 CHECKS PASSED =="; else echo "== T8 CHECKS FAILED =="; fi
exit $FAIL
