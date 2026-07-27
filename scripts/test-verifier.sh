#!/usr/bin/env bash
# Copyright 2026 Chad Walker
# SPDX-License-Identifier: Apache-2.0

# T7 acceptance checks (V1 backlog T7; DESIGN.md 4.4, v1.0.2).
# Host driver: runs verifier-checks.sh inside the base image, then validates every
# scenario's verify.json against schemas/verify.schema.json with ajv, and asserts
# the verifier is scaffolding (no LLM invocation).
# Run from Git Bash:  bash scripts/test-verifier.sh [image-tag]
set -u
IMAGE="${1:-pipeline-base:local}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$(mktemp -d)"
FAIL=0

ROOTW="$ROOT"; OUTW="$OUT"
command -v cygpath >/dev/null 2>&1 && { ROOTW="$(cygpath -m "$ROOT")"; OUTW="$(cygpath -m "$OUT")"; }

MSYS_NO_PATHCONV=1 docker run --rm \
  -v "$ROOTW:/pipeline-repo:ro" -v "$OUTW:/out" "$IMAGE" \
  bash /pipeline-repo/scripts/verifier-checks.sh || FAIL=1

# Schema validation of every scenario result (schema owned by this task - 4.11/4.4).
AJV=(npx.cmd --yes -p ajv-formats -p ajv-cli ajv -c ajv-formats)
command -v npx.cmd >/dev/null 2>&1 || AJV=(npx --yes -p ajv-formats -p ajv-cli ajv -c ajv-formats)
N=0
for f in "$OUT"/*.json; do
  [ -e "$f" ] || continue
  N=$((N + 1))
  if "${AJV[@]}" validate --spec=draft2020 -s "$ROOT/schemas/verify.schema.json" -d "$f" >/dev/null 2>&1; then
    echo "PASS  schema: $(basename "$f") validates"
  else
    echo "FAIL  schema: $(basename "$f") does not validate"; FAIL=1
  fi
done
[ "$N" -ge 8 ] && echo "PASS  all $N scenario results schema-checked" \
               || { echo "FAIL  expected >=8 scenario results, found $N"; FAIL=1; }

# The verifier is deterministic scaffolding - no LLM call in it.
grep -qE '\bclaude\b' "$ROOT/pipeline/verify.js" \
  && { echo "FAIL  verify.js invokes claude"; FAIL=1; } \
  || echo "PASS  verifier is scaffolding (no LLM invocation)"

rm -rf "$OUT"
if [[ $FAIL -eq 0 ]]; then echo "== ALL T7 CHECKS PASSED =="; else echo "== T7 CHECKS FAILED =="; fi
exit $FAIL
