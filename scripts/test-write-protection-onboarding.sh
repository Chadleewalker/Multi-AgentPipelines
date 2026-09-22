#!/usr/bin/env bash
# Copyright 2026 Chad Walker
# SPDX-License-Identifier: Apache-2.0
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
node "$ROOT/tests/integration/write-protection-onboarding.test.js"
