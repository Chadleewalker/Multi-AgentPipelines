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
# Order matters: Git Bash's npx.cmd launcher breaks absolute paths containing spaces.
# Prefer the quoted-argument Bash npx wrapper (change-log row `repo-34h`).
AJV=(npx --yes -p ajv-formats -p ajv-cli ajv -c ajv-formats)
command -v npx >/dev/null 2>&1 || AJV=(npx.cmd --yes -p ajv-formats -p ajv-cli ajv -c ajv-formats)

echo "== T3 checks against $SCHEMA =="

if "${AJV[@]}" validate --spec=draft2020 -s "$SCHEMA" -d "$ROOT/schemas/examples/status.valid.json"; then
  echo "PASS  valid example validates"
else
  echo "FAIL  valid-example validation failed (see AJV output above)"; FAIL=1
fi

# test --invalid succeeds only when AJV confirms rejection. A launch, schema or read
# error must fail this assertion, rather than impersonate a valid negative result.
if "${AJV[@]}" test --invalid --spec=draft2020 -s "$SCHEMA" -d "$ROOT/schemas/examples/status.invalid.json"; then
  echo "PASS  invalid example fails validation"
else
  echo "FAIL  invalid-example test could not confirm rejection (see AJV output above)"; FAIL=1
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

# Offline coverage for the launchers and diagnostics used by all five schema drivers.
node "$ROOT/tests/unit/ajv-launcher.test.js" || FAIL=1

if [[ $FAIL -eq 0 ]]; then echo "== ALL T3 CHECKS PASSED =="; else echo "== T3 CHECKS FAILED =="; fi
exit $FAIL
