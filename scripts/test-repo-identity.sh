#!/usr/bin/env bash
# Copyright 2026 Chad Walker
# SPDX-License-Identifier: Apache-2.0

# Docker-free local-Beads/publication-remote identity checks.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
echo "== repository identity checks =="
node "$ROOT/tests/unit/repo-identity.test.js"
