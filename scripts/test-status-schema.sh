#!/usr/bin/env bash
# Copyright 2026 Chad Walker
# SPDX-License-Identifier: Apache-2.0

# T3 acceptance checks (V1 backlog T3; DESIGN.md s4.11).
# Run from Git Bash:  bash scripts/test-status-schema.sh
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCHEMA="$ROOT/schemas/status.schema.json"
FAIL=0

# -c ajv-formats teaches ajv the "date-time" format the schema uses.
AJV=(npx.cmd --yes -p ajv-formats -p ajv-cli ajv -c ajv-formats)
command -v npx.cmd >/dev/null 2>&1 || AJV=(npx --yes -p ajv-formats -p ajv-cli ajv -c ajv-formats)

echo "== T3 checks against $SCHEMA =="

if "${AJV[@]}" validate --spec=draft2020 -s "$SCHEMA" -d "$ROOT/schemas/examples/status.valid.json" >/dev/null 2>&1; then
  echo "PASS  valid example validates"
else
  echo "FAIL  valid example rejected"; FAIL=1
fi

if "${AJV[@]}" validate --spec=draft2020 -s "$SCHEMA" -d "$ROOT/schemas/examples/status.invalid.json" >/dev/null 2>&1; then
  echo "FAIL  invalid example was accepted"; FAIL=1
else
  echo "PASS  invalid example fails validation"
fi

# Schema covers everything DESIGN.md 4.11 names: attempt summaries (number,
# verifier result, timestamp), the docs-phase change summary, the reset time.
for field in attempts number verifierResult timestamp changeSummary rateLimitResetAt; do
  if grep -q "\"$field\"" "$SCHEMA"; then
    echo "PASS  schema covers '$field'"
  else
    echo "FAIL  schema missing '$field'"; FAIL=1
  fi
done

if [[ $FAIL -eq 0 ]]; then echo "== ALL T3 CHECKS PASSED =="; else echo "== T3 CHECKS FAILED =="; fi
exit $FAIL
