#!/usr/bin/env bash
# Copyright 2026 Chad Walker
# SPDX-License-Identifier: Apache-2.0

# T5 acceptance checks (V1 backlog T5; DESIGN.md 4.8).
# Brings the closed network + proxy sidecar up, proves the allowlist policy holds
# in both directions, then tears down. Run from Git Bash:
#   bash scripts/test-egress.sh
# The live headless-claude check runs only when CLAUDE_CODE_OAUTH_TOKEN is set.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BASE_IMG="${BASE_IMG:-pipeline-base:local}"
# Local secrets file (git-ignored): holds CLAUDE_CODE_OAUTH_TOKEN=... on one line.
# The token is passed into containers as an env var only - never into images (s6).
[ -f "$ROOT/.env.pipeline" ] && . "$ROOT/.env.pipeline" && export CLAUDE_CODE_OAUTH_TOKEN
PROXY_ENV=(-e HTTPS_PROXY=http://pipeline-proxy:3128 -e HTTP_PROXY=http://pipeline-proxy:3128 -e NO_PROXY=localhost,127.0.0.1)
FAIL=0
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; FAIL=1; }
# Teardown belongs in an EXIT trap, not at the bottom of the script: the `pipeline-net up`
# guard below exits 1 on its own, and anything that aborts between it and the last line
# used to leave the network and the proxy up for the next suite to trip over
# (change-log row `repo-zje`).
cleanup() { bash "$ROOT/scripts/pipeline-net.sh" down >/dev/null 2>&1; }
trap cleanup EXIT

probe() { # probe <extra docker args...> -- <url> ; prints curl http_code, 000 on failure
  local args=() u out
  while [ "$1" != "--" ]; do args+=("$1"); shift; done; shift; u="$1"
  out=$(docker run --rm --network pipeline-net "${args[@]}" "$BASE_IMG" \
    sh -c "curl -s -m 15 -o /dev/null -w '%{http_code}' '$u'" 2>/dev/null) || true
  echo -n "${out:-000}"
}

echo "== T5 checks =="

# Static config checks: concrete domains only, TLS passthrough, no CA injection.
if grep -vE '^\s*(#|$)' "$ROOT/docker/proxy/allowlist.txt" | grep -qvE '^[a-z0-9][a-z0-9.-]+\.[a-z]+$'; then
  fail "allowlist has a non-concrete entry (wildcard or malformed)"
else
  pass "allowlist entries are concrete domains only"
fi
grep -vE '^\s*#' "$ROOT/docker/proxy/allowlist.txt" | grep -qE 'anthropic\.com' \
  && ! grep -vE '^\s*(#|$)' "$ROOT/docker/proxy/allowlist.txt" | grep -qvE 'anthropic\.com$' \
  && pass "allowlist is Anthropic-only" || fail "non-Anthropic domain in allowlist"
grep -vE '^\s*#' "$ROOT/docker/proxy/squid.conf" | grep -q ssl_bump \
  && fail "squid.conf contains ssl_bump (TLS interception)" || pass "TLS passthrough (no ssl_bump)"
grep -qiE 'COPY.*\.(crt|pem)|update-ca-cert' "$ROOT/docker/proxy/Dockerfile" "$ROOT/docker/base/Dockerfile" \
  && fail "custom CA injected into an image" || pass "no custom CA in any image"

# Bring the network + sidecar up.
bash "$ROOT/scripts/pipeline-net.sh" up || { fail "pipeline-net up"; exit 1; }
pass "network + proxy sidecar up"

# Allowed endpoint through the proxy: any HTTP status proves the tunnel (auth not needed).
CODE=$(probe "${PROXY_ENV[@]}" -- https://api.anthropic.com/)
[ "$CODE" != "000" ] && pass "api.anthropic.com reachable via proxy (HTTP $CODE)" \
                     || fail "api.anthropic.com unreachable via proxy"

# Blocked hosts through the proxy.
for h in github.com registry.npmjs.org; do
  CODE=$(probe "${PROXY_ENV[@]}" -- "https://$h/")
  [ "$CODE" = "000" ] && pass "$h blocked via proxy" || fail "$h reachable via proxy (HTTP $CODE)"
done

# No proxy vars -> nothing is reachable at all (the network is truly internal).
CODE=$(probe -- https://api.anthropic.com/)
[ "$CODE" = "000" ] && pass "no direct egress without the proxy" \
                    || fail "container reached the internet without the proxy"

# Live headless claude through the proxy (empirical endpoint confirmation).
if [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  # tee to stderr: a live model call is the slowest step here — stream it instead of
  # going silent. stdout is still captured for the assertion below. pipefail is not
  # needed by the assertion (it greps the text) but is kept uniform across every tee'd
  # call: without it the pipeline reports tee's status, so anyone who later adds an
  # exit-code check here would silently always read 0.
  OUT=$(set -o pipefail; MSYS_NO_PATHCONV=1 docker run --rm --network pipeline-net "${PROXY_ENV[@]}" \
        -e CLAUDE_CODE_OAUTH_TOKEN "$BASE_IMG" \
        sh -c 'claude -p "Reply with exactly: ok" --max-turns 1 2>&1' | tee /dev/stderr )
  echo "$OUT" | grep -qi "ok" && pass "headless claude -p works through the proxy" \
                              || fail "claude -p failed through proxy: $(echo "$OUT" | head -2)"
else
  echo "SKIP  live claude -p check (set CLAUDE_CODE_OAUTH_TOKEN to run it)"
fi

cleanup
pass "teardown clean"

if [[ $FAIL -eq 0 ]]; then echo "== ALL T5 CHECKS PASSED =="; else echo "== T5 CHECKS FAILED =="; fi
exit $FAIL
