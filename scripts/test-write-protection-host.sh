#!/usr/bin/env bash
# Copyright 2026 Chad Walker
# SPDX-License-Identifier: Apache-2.0
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
node "$ROOT/tests/unit/write-protection-host.test.js"
