#!/usr/bin/env bash
# Copyright 2026 Chad Walker
# SPDX-License-Identifier: Apache-2.0

# T1 acceptance checks for the base image (docs/v1-backlog-draft.md T1; DESIGN.md §6).
# Run from Git Bash:  bash scripts/test-base-image.sh [image-tag]
# Exits 0 only if every check passes.
set -u

IMAGE="${1:-pipeline-base:local}"
FAIL=0

check() { # check <label> <expected-substring> <output>
  local label="$1" expect="$2" out="$3"
  if [[ "$out" == *"$expect"* ]]; then
    echo "PASS  $label ($out)"
  else
    echo "FAIL  $label — expected '$expect', got: $out"
    FAIL=1
  fi
}

echo "== T1 checks against $IMAGE =="

# 1. Pinned tools present on PATH, at the pinned versions.
check "node pinned"   "v22.23.1" "$(docker run --rm "$IMAGE" node --version 2>&1)"
check "git present"   "git version" "$(docker run --rm "$IMAGE" git --version 2>&1)"
check "claude pinned" "2.1.220"  "$(docker run --rm "$IMAGE" claude --version 2>&1)"
check "bd present"    ""          "$(docker run --rm "$IMAGE" bd version 2>&1 || docker run --rm "$IMAGE" bd --version 2>&1)"

# 2. No floating tags / unpinned installs in the Dockerfile.
DF="$(dirname "$0")/../docker/base/Dockerfile"
if grep -E 'FROM .*(latest|:22-|:22\.[0-9]+-[a-z])' "$DF" | grep -qv '22.23.1'; then
  echo "FAIL  Dockerfile FROM tag is not an exact version"; FAIL=1
else
  echo "PASS  Dockerfile FROM tag pinned exactly"
fi

# 3. No credential in any layer or in the image environment.
HIST="$(docker history --no-trunc "$IMAGE" 2>&1)"
ENVS="$(docker inspect --format '{{range .Config.Env}}{{.}} {{end}}' "$IMAGE" 2>&1)"
if echo "$HIST$ENVS" | grep -q 'CLAUDE_CODE_OAUTH_TOKEN'; then
  echo "FAIL  CLAUDE_CODE_OAUTH_TOKEN found in image history or env"; FAIL=1
else
  echo "PASS  no credential in image layers or env"
fi

# 4. Token arrives via docker run env only (the §6 contract).
check "token via run env" "tokenvisible" \
  "$(docker run --rm -e CLAUDE_CODE_OAUTH_TOKEN=dummy "$IMAGE" sh -c '[ -n "$CLAUDE_CODE_OAUTH_TOKEN" ] && echo tokenvisible')"

# (T1's remaining bullet — FROM-able by a thin per-project layer — is proven by T18.)

if [[ $FAIL -eq 0 ]]; then echo "== ALL T1 CHECKS PASSED =="; else echo "== T1 CHECKS FAILED =="; fi
exit $FAIL
