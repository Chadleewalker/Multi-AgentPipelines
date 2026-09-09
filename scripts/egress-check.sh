#!/usr/bin/env bash
# Copyright 2026 Chad Walker
# SPDX-License-Identifier: Apache-2.0

# Pre-run egress gate (DESIGN.md 4.8, built by T6).
# Proves the allowlist is actually in force before any task container launches:
# one throwaway container asserts (1) an allowed endpoint is reachable through the
# proxy, (2) two non-allowlisted hosts are NOT, (3) there is no direct egress at all.
# Bounded under 60 seconds. Exit 0 = policy holds; non-zero = ABORT THE RUN.
# The runner (T11) invokes this after `pipeline-net.sh up` and before the first task.
#
# The network, proxy and port are per project and come from the environment, defaulting to
# the historical shared pair when unset (change-log row `repo-jur`). The gate has to probe
# the SAME plumbing the run's tasks will use — passing against another project's network
# proves nothing about this one.
#
# The SELECTED endpoint is per provider (change-log row `repo-45g`): the gate proves that
# the one endpoint this run's agent actually needs is reachable, and that the unrelated
# hosts plus direct egress are still blocked. PIPELINE_PROVIDER unset means claude, so the
# default probe is exactly the historical one — api.anthropic.com allowed, github.com and
# registry.npmjs.org blocked, no direct egress — and scripts/test-egress-check.sh, which
# passes no provider, exercises unchanged behaviour.
set -u
BASE_IMG="${BASE_IMG:-pipeline-base:local}"
BOUND=60
NET="${PIPELINE_NET:-pipeline-net}"
PROXY_NAME="${PIPELINE_PROXY:-pipeline-proxy}"
PROXY_PORT="${PIPELINE_PROXY_PORT:-3128}"
PROXY="http://$PROXY_NAME:$PROXY_PORT"
PROVIDER="${PIPELINE_PROVIDER:-claude}"
case "$PROVIDER" in
  codex)  ALLOWED_URL=https://api.openai.com/ ;;
  claude) ALLOWED_URL=https://api.anthropic.com/ ;;
  *) echo "egress-check.sh: unknown PIPELINE_PROVIDER '$PROVIDER' (expected claude or codex)" >&2; exit 2 ;;
esac

# Single-quoted on purpose: $ALLOWED_URL is expanded INSIDE the container, from the
# variable passed with -e below, so the probe script itself stays one fixed string and no
# host-side quoting can reshape it.
PROBE_CMD='
  code() { curl -s -m 10 -o /dev/null -w "%{http_code}" "$1" 2>/dev/null || true; }
  A=$(code "$ALLOWED_URL")
  B=$(code https://github.com/)
  C=$(code https://registry.npmjs.org/)
  D=$(env -u HTTPS_PROXY -u HTTP_PROXY sh -c \
      "curl -s -m 8 -o /dev/null -w \"%{http_code}\" https://github.com/ 2>/dev/null" || true)
  echo "provider=$PIPELINE_PROVIDER allowed=$ALLOWED_URL:${A:-000} blocked1=${B:-000} blocked2=${C:-000} direct=${D:-000}"
  [ -n "$A" ] && [ "$A" != 000 ] || exit 1     # selected endpoint must be reachable
  [ -z "$B" ] || [ "$B" = 000 ] || exit 1      # github.com must be blocked
  [ -z "$C" ] || [ "$C" = 000 ] || exit 1      # registry.npmjs.org must be blocked
  [ -z "$D" ] || [ "$D" = 000 ] || exit 1      # no direct egress without the proxy
  exit 0
'

run_probes() {
  docker run --rm --network "$NET" \
    -e HTTPS_PROXY="$PROXY" -e HTTP_PROXY="$PROXY" -e NO_PROXY=localhost,127.0.0.1 \
    -e ALLOWED_URL="$ALLOWED_URL" -e PIPELINE_PROVIDER="$PROVIDER" \
    "$BASE_IMG" sh -c "$PROBE_CMD"
}

# Self-enforced wall bound: prefer coreutils timeout (present in Git Bash); the
# per-curl -m limits keep the worst case under the bound even without it.
if command -v timeout >/dev/null 2>&1; then
  timeout "$BOUND" docker run --rm --network "$NET" \
    -e HTTPS_PROXY="$PROXY" -e HTTP_PROXY="$PROXY" -e NO_PROXY=localhost,127.0.0.1 \
    -e ALLOWED_URL="$ALLOWED_URL" -e PIPELINE_PROVIDER="$PROVIDER" \
    "$BASE_IMG" sh -c "$PROBE_CMD"
else
  run_probes
fi
RC=$?
if [ "$RC" -eq 0 ]; then
  echo "EGRESS CHECK PASSED - allowlist in force ($PROVIDER profile, $ALLOWED_URL reachable)"
else
  echo "EGRESS CHECK FAILED (rc=$RC) - DO NOT LAUNCH TASKS" >&2
fi
exit "$RC"
