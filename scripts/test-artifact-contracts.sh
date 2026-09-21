#!/usr/bin/env bash
# Copyright 2026 Chad Walker
# SPDX-License-Identifier: Apache-2.0

# Docker-free runtime checks for status.json and verify.json admission.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
echo "== runtime artifact-contract checks =="
node "$ROOT/tests/unit/artifact-contracts.test.js"
