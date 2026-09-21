#!/usr/bin/env bash
# Copyright 2026 Chad Walker
# SPDX-License-Identifier: Apache-2.0

# Docker-free regression for destructive boundaries in the live fixture e2e.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
echo "== live e2e safety checks =="
node "$ROOT/tests/unit/e2e-safety.test.js"
