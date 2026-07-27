#!/usr/bin/env bash
# Copyright 2026 Chad Walker
# SPDX-License-Identifier: Apache-2.0

# Closed task network + allowlist proxy sidecar lifecycle (DESIGN.md 4.8, 4.12).
# V1 manual tool; the runner (T11) owns this lifecycle in real runs by shelling here.
#
#   bash scripts/pipeline-net.sh up      # build sidecar, create net, start, wait ready
#   bash scripts/pipeline-net.sh down    # tear both down
#
# Constants (the runner's run.config.json must agree):
#   network: pipeline-net (internal)   sidecar: pipeline-proxy   port: 3128
# Task containers join with:
#   --network pipeline-net -e HTTPS_PROXY=http://pipeline-proxy:3128 \
#   -e HTTP_PROXY=http://pipeline-proxy:3128 -e NO_PROXY=localhost,127.0.0.1
set -u
NET=pipeline-net; PROXY=pipeline-proxy; IMG=pipeline-proxy:local
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BASE_IMG="${BASE_IMG:-pipeline-base:local}"

up() {
  docker build -q -t "$IMG" "$ROOT/docker/proxy" >/dev/null || { echo "proxy image build failed"; exit 1; }
  docker network inspect "$NET" >/dev/null 2>&1 || docker network create --internal "$NET" >/dev/null
  docker rm -f "$PROXY" >/dev/null 2>&1 || true
  docker run -d --name "$PROXY" "$IMG" >/dev/null            # default bridge: egress side
  docker network connect "$NET" "$PROXY"                     # internal side: tasks reach it here
  # Ready when squid answers HTTP on the internal side (any response counts).
  for i in $(seq 1 15); do
    if docker run --rm --network "$NET" "$BASE_IMG" \
         sh -c 'curl -s -m 2 -o /dev/null http://pipeline-proxy:3128' 2>/dev/null; then
      echo "pipeline-net up (proxy ready)"; return 0
    fi
    sleep 1
  done
  echo "proxy did not become ready"; exit 1
}

down() {
  docker rm -f "$PROXY" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  echo "pipeline-net down"
}

case "${1:-}" in
  up) up ;;
  down) down ;;
  *) echo "usage: pipeline-net.sh up|down" >&2; exit 2 ;;
esac
