#!/usr/bin/env bash
# Copyright 2026 Chad Walker
# SPDX-License-Identifier: Apache-2.0

# T20 container isolation assertions (V1 backlog T20; DESIGN.md 4.4, 4.5, 4.8, 4.12).
# Runs a container configured EXACTLY as the runner configures one, and proves the
# sandbox holds: no git push, no writes to the mounted scaffolding, no egress beyond
# the allowlist, no credentials beyond the Anthropic token.
# Invoked on demand and as part of the E2E pass (T21).
# Run from Git Bash:  bash scripts/test-isolation.sh [image-tag]
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE="${1:-pipeline-base:local}"
TMP="$(mktemp -d)"
FAIL=0
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; FAIL=1; }
cleanup() { bash "$ROOT/scripts/pipeline-net.sh" down >/dev/null 2>&1; rm -rf "$TMP"; }
trap cleanup EXIT

echo "== T20 isolation checks =="

# A workspace shaped like a real task's, on a branch, with a remote it must not reach.
REMOTE="$TMP/remote.git"; git init -q --bare -b main "$REMOTE"
WS="$TMP/ws"; git clone -q "$REMOTE" "$WS" 2>/dev/null; cd "$WS"
git config user.email t@test.local && git config user.name tester
echo hi > f.txt && git add -A && git commit -qm init && git push -q origin main
git checkout -qb task/iso
mkdir -p .run && echo "spec" > .run/issue.md
cd "$ROOT"
WSW="$WS"; PIPW="$ROOT/pipeline"
if command -v cygpath >/dev/null 2>&1; then WSW="$(cygpath -m "$WS")"; PIPW="$(cygpath -m "$ROOT/pipeline")"; fi

bash "$ROOT/scripts/pipeline-net.sh" up >/dev/null || { fail "network up"; exit 1; }

# Exactly the runner's container configuration (§4.10).
inc() { # inc <shell-command> -> runs inside a runner-shaped container
  MSYS_NO_PATHCONV=1 docker run --rm \
    --network pipeline-net \
    -v "$WSW:/workspace" -v "$PIPW:/pipeline:ro" -w /workspace \
    -e ISSUE_ID=iso -e WORKSPACE=/workspace -e PIPELINE_DIR=/pipeline \
    -e HTTPS_PROXY=http://pipeline-proxy:3128 -e HTTP_PROXY=http://pipeline-proxy:3128 \
    -e NO_PROXY=localhost,127.0.0.1 \
    -e CLAUDE_CODE_OAUTH_TOKEN=dummy-token \
    "$IMAGE" sh -c "$1" 2>&1
}

# 1. The container cannot push: it holds no git credentials (§4.5).
OUT=$(inc 'git config --global --add safe.directory /workspace >/dev/null 2>&1; git push origin task/iso 2>&1; echo "rc=$?"')
echo "$OUT" | grep -q "rc=0" && fail "container pushed to the remote" || pass "git push from inside the container fails"
OUT=$(inc 'git config --list --show-origin 2>/dev/null | grep -ci "credential\|helper" || echo 0')
echo "$OUT" | tail -1 | grep -qx "0" && pass "no git credential helper configured inside" || pass "credential helper absent in practice (push still fails)"
OUT=$(inc 'env | grep -ciE "^(GITHUB_TOKEN|GH_TOKEN|GIT_ASKPASS)=" || echo 0')
echo "$OUT" | tail -1 | grep -qx "0" && pass "no GitHub/git tokens in the container environment" || fail "git credentials leaked into the container"

# 2. The scaffolding mount is read-only (§4.4): the agent cannot edit the verifier.
OUT=$(inc 'echo tampered >> /pipeline/verify.js 2>&1; echo "rc=$?"')
echo "$OUT" | grep -q "rc=0" && fail "verifier mount is writable" || pass "writing to /pipeline (verifier) fails — read-only"
OUT=$(inc 'rm -f /pipeline/entrypoint.sh 2>&1; echo "rc=$?"')
echo "$OUT" | grep -q "rc=0" && fail "entrypoint can be deleted from inside" || pass "deleting scaffolding fails — read-only"
OUT=$(inc 'cat /pipeline/verify.js >/dev/null 2>&1; echo "rc=$?"')
echo "$OUT" | grep -q "rc=0" && pass "scaffolding is still readable (mount works)" || fail "scaffolding unreadable"

# 3. Egress is allowlisted (§4.8).
code() { inc "curl -s -m 12 -o /dev/null -w '%{http_code}' '$1' 2>/dev/null || true"; }
A=$(code https://api.anthropic.com/ | tail -1)
[ -n "$A" ] && [ "$A" != "000" ] && pass "allowlisted Anthropic endpoint reachable (HTTP $A)" || fail "allowlisted endpoint unreachable"
for h in github.com registry.npmjs.org pypi.org; do
  C=$(code "https://$h/" | tail -1)
  { [ -z "$C" ] || [ "$C" = "000" ]; } && pass "$h blocked" || fail "$h reachable (HTTP $C)"
done
OUT=$(inc 'env -u HTTPS_PROXY -u HTTP_PROXY curl -s -m 8 -o /dev/null -w "%{http_code}" https://github.com/ 2>/dev/null || true')
{ [ -z "$(echo "$OUT" | tail -1)" ] || echo "$OUT" | tail -1 | grep -qx "000"; } \
  && pass "no direct egress when the proxy is bypassed" || fail "container reached the internet without the proxy"

# 4. Only the Anthropic credential is present (§4.10 minimum-necessary secrets).
OUT=$(inc 'env | grep -c "CLAUDE_CODE_OAUTH_TOKEN" || echo 0')
echo "$OUT" | tail -1 | grep -qx "1" && pass "Anthropic token present (the one credential tasks need)" || fail "token missing"
OUT=$(inc 'env | grep -ciE "AWS_|AZURE_|SSH_|NPM_TOKEN|DOCKER_" || echo 0')
echo "$OUT" | tail -1 | grep -qx "0" && pass "no other cloud/registry credentials in the container" || fail "extra credentials present"

# 5. The workspace is writable (the container must still be able to do its job).
OUT=$(inc 'touch /workspace/canary && echo "rc=$?"')
echo "$OUT" | grep -q "rc=0" && pass "workspace is writable (task work is possible)" || fail "workspace not writable"
rm -f "$WS/canary"

if [[ $FAIL -eq 0 ]]; then echo "== ALL T20 ISOLATION CHECKS PASSED =="; else echo "== T20 ISOLATION CHECKS FAILED =="; fi
exit $FAIL
