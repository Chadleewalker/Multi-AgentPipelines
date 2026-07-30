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
set -u
BASE_IMG="${BASE_IMG:-pipeline-base:local}"
BOUND=60
NET="${PIPELINE_NET:-pipeline-net}"
PROXY_NAME="${PIPELINE_PROXY:-pipeline-proxy}"
PROXY_PORT="${PIPELINE_PROXY_PORT:-3128}"
PROXY="http://$PROXY_NAME:$PROXY_PORT"

PROBE_CMD='
  code() { curl -s -m 10 -o /dev/null -w "%{http_code}" "$1" 2>/dev/null || true; }
  A=$(code https://api.anthropic.com/)
  B=$(code https://github.com/)
  C=$(code https://registry.npmjs.org/)
  D=$(env -u HTTPS_PROXY -u HTTP_PROXY sh -c \
      "curl -s -m 8 -o /dev/null -w \"%{http_code}\" https://github.com/ 2>/dev/null" || true)
  echo "allowed=${A:-000} blocked1=${B:-000} blocked2=${C:-000} direct=${D:-000}"
  [ -n "$A" ] && [ "$A" != 000 ] || exit 1     # allowed endpoint must be reachable
  [ -z "$B" ] || [ "$B" = 000 ] || exit 1      # github.com must be blocked
  [ -z "$C" ] || [ "$C" = 000 ] || exit 1      # registry.npmjs.org must be blocked
  [ -z "$D" ] || [ "$D" = 000 ] || exit 1      # no direct egress without the proxy
  exit 0
'

run_probes() {
  docker run --rm --network "$NET" \
    -e HTTPS_PROXY="$PROXY" -e HTTP_PROXY="$PROXY" -e NO_PROXY=localhost,127.0.0.1 \
    "$BASE_IMG" sh -c "$PROBE_CMD"
}

# Self-enforced wall bound: prefer coreutils timeout (present in Git Bash); the
# per-curl -m limits keep the worst case under the bound even without it.
if command -v timeout >/dev/null 2>&1; then
  timeout "$BOUND" docker run --rm --network "$NET" \
    -e HTTPS_PROXY="$PROXY" -e HTTP_PROXY="$PROXY" -e NO_PROXY=localhost,127.0.0.1 \
    "$BASE_IMG" sh -c "$PROBE_CMD"
else
  run_probes
fi
RC=$?
if [ "$RC" -eq 0 ]; then
  echo "EGRESS CHECK PASSED - allowlist in force"
else
  echo "EGRESS CHECK FAILED (rc=$RC) - DO NOT LAUNCH TASKS" >&2
fi
exit "$RC"
