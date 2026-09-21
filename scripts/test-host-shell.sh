#!/usr/bin/env bash
# Copyright 2026 Chad Walker
# SPDX-License-Identifier: Apache-2.0

# Docker-free host-shell identity and startup-gate checks.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
echo "== supported host-shell checks =="
node "$ROOT/tests/unit/host-shell.test.js"
