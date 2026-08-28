#!/usr/bin/env bash
# Copyright 2026 Chad Walker
# SPDX-License-Identifier: Apache-2.0

# Docker-free checks for canonical policy ownership and instruction-file drift.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
echo "== control-plane contract checks =="
node "$ROOT/tests/unit/control-plane-contract.test.js"
