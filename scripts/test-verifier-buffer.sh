#!/usr/bin/env bash
# Copyright 2026 Chad Walker
# SPDX-License-Identifier: Apache-2.0
# Synthetic Git fixtures; no Docker, credentials, real Beads or forge calls.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
node --test "$ROOT/tests/unit/verifier-buffer.test.js"
