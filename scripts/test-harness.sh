#!/usr/bin/env bash
# Copyright 2026 Chad Walker
# SPDX-License-Identifier: Apache-2.0

# Offline regressions for portable e2e progress and owned proxy images.
# The Node suite installs a shell function recorder; it cannot reach real Docker.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
node "$ROOT/tests/unit/harness.test.js"
