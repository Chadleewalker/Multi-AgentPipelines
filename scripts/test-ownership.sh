#!/usr/bin/env bash
# Copyright 2026 Chad Walker
# SPDX-License-Identifier: Apache-2.0

# Docker-free global lock, atomic claim, and exact dead-owner recovery checks.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
echo "== runner ownership checks =="
node "$ROOT/tests/unit/ownership.test.js"
