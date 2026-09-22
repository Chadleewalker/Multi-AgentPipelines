#!/usr/bin/env bash
# Copyright 2026 Chad Walker
# SPDX-License-Identifier: Apache-2.0

# Docker-free host write-policy checks. The full sweep discovers this wrapper by glob.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
node "$ROOT/tests/unit/write-protection-policy.test.js"
