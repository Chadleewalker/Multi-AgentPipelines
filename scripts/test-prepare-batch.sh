#!/usr/bin/env bash
# Copyright 2026 Chad Walker
# SPDX-License-Identifier: Apache-2.0
set -eu

SCRIPT_DIR="${BASH_SOURCE[0]%/*}"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
echo "== preparation batch coordinator checks =="
node "$ROOT/tests/unit/prepare-batch.test.js"
