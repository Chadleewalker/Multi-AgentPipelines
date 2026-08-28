#!/usr/bin/env bash
# Copyright 2026 Chad Walker
# SPDX-License-Identifier: Apache-2.0

# Docker-free subprocess bounds, independent deadline, and finally-teardown checks.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
echo "== runner lifecycle-bound checks =="
node "$ROOT/tests/unit/lifecycle-bounds.test.js"
