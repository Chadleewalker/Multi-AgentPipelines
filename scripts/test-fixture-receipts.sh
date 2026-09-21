#!/usr/bin/env bash
# Copyright 2026 Chad Walker
# SPDX-License-Identifier: Apache-2.0

# Docker-free regression for integration fixtures that pass the receipt admission gate.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
echo "== fixture receipt checks =="
node "$ROOT/tests/unit/fixture-receipts.test.js"
