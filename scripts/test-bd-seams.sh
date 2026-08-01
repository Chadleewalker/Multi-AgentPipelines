#!/usr/bin/env bash
# Copyright 2026 Chad Walker
# SPDX-License-Identifier: Apache-2.0
# Docker-free: runner/bd.js's two-sided seam (bdOnHost / bdInImage).
# A thin wrapper over tests/unit/bd-seams.test.js — all logic lives in the Node checker,
# because tools/run-acceptance.sh invokes *.sh through `sh`, which is bash on the Windows
# host and dash in a container, so shell-side logic goes green in one and red in the other.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
node "$ROOT/tests/unit/bd-seams.test.js"
