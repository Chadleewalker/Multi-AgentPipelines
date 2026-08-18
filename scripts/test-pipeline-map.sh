#!/usr/bin/env bash
# Copyright 2026 Chad Walker
# SPDX-License-Identifier: Apache-2.0

# Pipeline-map build checks — scripts/build-pipeline-map.js, the host-only dev tool that
# pre-renders docs/pipeline-map.html's mermaid blocks to inline SVG (DESIGN.md §12,
# change-log row `map-prerender`).
#
# Docker-free, network-free, and — deliberately — mermaid-free. The real renderer lives
# in tools/mapbuild/node_modules, which is git-ignored and absent from a fresh clone and
# from every task container; the Node checker drives the builder through its MAP_MMDC
# seam against a stand-in it writes into a throwaway temp directory, so this suite is
# safe to run anywhere node exists. The sweep discovers it by glob (scripts/test-*.sh).
#
# Run from Git Bash:  bash scripts/test-pipeline-map.sh
# POSIX sh only in the body: it must also run as `sh <path>`, which is dash in a
# container and bash on the Windows host — all logic lives in the Node checker so no two
# shells can disagree about the result.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FAIL=0
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; FAIL=1; }

# The checker owns its fixtures. A seam inherited from the caller's shell would aim the
# builder at the real docs/ tree — and MAP_OUT in particular would aim a WRITE there.
unset MAP_SRC
unset MAP_OUT
unset MAP_MMDC

LC_ALL=C
export LC_ALL

echo "== pipeline-map build checks: scripts/build-pipeline-map.js =="

if [ -f "$ROOT/scripts/build-pipeline-map.js" ]; then
  pass "scripts/build-pipeline-map.js is present"
else
  fail "scripts/build-pipeline-map.js is missing"
fi

if [ -f "$ROOT/docs/pipeline-map.html" ]; then
  pass "the authored page docs/pipeline-map.html is present"
else
  fail "docs/pipeline-map.html is missing — the builder has no input"
fi

# The built page is committed so a reader without npm still gets the diagrams. If it
# ever falls behind the source the fix is a rebuild, not an edit — the banner says so.
if [ -f "$ROOT/docs/pipeline-map.built.html" ]; then
  pass "the built page docs/pipeline-map.built.html is committed"
  if head -n 4 "$ROOT/docs/pipeline-map.built.html" | grep -q "GENERATED FILE"; then
    pass "the built page is marked as generated"
  else
    fail "the built page is missing its generated-file banner"
  fi
  if grep -q '<pre class="mermaid">' "$ROOT/docs/pipeline-map.built.html"; then
    fail "the built page still carries an unrendered mermaid block"
  else
    pass "the built page carries no unrendered mermaid blocks"
  fi
else
  fail "docs/pipeline-map.built.html is missing — run: node scripts/build-pipeline-map.js"
fi

OUT="$(node "$ROOT/tests/unit/pipeline-map-build.test.js" 2>&1)"; RC=$?
echo "$OUT"

if [ "$RC" -eq 0 ]; then
  pass "pipeline-map build checker exits 0"
else
  fail "pipeline-map build checker exits $RC"
fi

if [ "$FAIL" -eq 0 ]; then
  echo "== all pipeline-map build checks passed =="
else
  echo "== pipeline-map build checks FAILED =="
fi
exit "$FAIL"
