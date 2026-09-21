#!/usr/bin/env bash
# Copyright 2026 Chad Walker
# SPDX-License-Identifier: Apache-2.0

# Docker-free regression for the host-side pre-push credential disclosure boundary.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
echo "== credential disclosure publication-gate checks =="
node "$ROOT/tests/unit/credential-scan.test.js"
