#!/usr/bin/env bash
# Copyright 2026 Chad Walker
# SPDX-License-Identifier: Apache-2.0

# Mandatory, Docker-free control-plane regression layer.
#
# This exact script is run in two places: by GitHub Actions on every change and by the
# pipeline verifier before a self-hosted task can publish. Keep the list explicit: adding a
# Docker dependency or an npm download would make the in-container, closed-network gate
# unavailable. The full Docker/e2e sweep remains scripts/test-all.sh.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

SUITES=(
  test-agent-hooks.sh
  test-artifact-contracts.sh
  test-audit-runs.sh
  test-batch.sh
  test-bd-seams.sh
  test-bd-shim.sh
  test-changelog.sh
  test-concurrency.sh
  test-control-plane-contract.sh
  test-credential-scan.sh
  test-dashboard.sh
  test-dispatch-gate.sh
  test-e2e-safety.sh
  test-events.sh
  test-feed.sh
  test-fixture-receipts.sh
  test-freeze-gate.sh
  test-host-shell.sh
  test-lifecycle-bounds.sh
  test-lock.sh
  test-network-names.sh
  test-ownership.sh
  test-pause-gate.sh
  test-pipeline-map.sh
  test-planning-playbook.sh
  test-repo-identity.sh
  test-runner-memory.sh
  test-sanitize.sh
  test-spec-lint.sh
  test-sweep-assertions.sh
  test-sweep-hygiene.sh
  test-trace.sh
  test-verdict.sh
  test-verify-buffer.sh
  test-worktree.sh
)

if [ "${1:-}" = "--list" ]; then
  printf '%s\n' "${SUITES[@]}"
  exit 0
fi

echo "== mandatory Docker-free regression layer (${#SUITES[@]} suites) =="
for suite in "${SUITES[@]}"; do
  echo
  echo "## $suite"
  if ! bash "$ROOT/scripts/$suite"; then
    echo "FAIL  mandatory regression layer stopped at $suite"
    exit 1
  fi
done
echo
echo "== ALL ${#SUITES[@]} MANDATORY REGRESSION SUITES PASSED =="
