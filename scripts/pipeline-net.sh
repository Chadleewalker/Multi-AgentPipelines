#!/usr/bin/env bash
# Copyright 2026 Chad Walker
# SPDX-License-Identifier: Apache-2.0

# Closed task network + allowlist proxy sidecar lifecycle (DESIGN.md 4.8, 4.12).
# V1 manual tool; the runner (T11) owns this lifecycle in real runs by shelling here.
#
#   bash scripts/pipeline-net.sh up      # build sidecar, create net, start, wait ready
#   bash scripts/pipeline-net.sh down    # tear both down
#
# The network and the sidecar are PER PROJECT, so two runner processes against different
# projects cannot tear each other's plumbing down (DESIGN.md 4.8; change-log row
# `repo-jur`). The runner passes its own names in; unset falls back to the historical
# shared pair, which is what every test suite here uses.
#   PIPELINE_NET=<network>  PIPELINE_PROXY=<sidecar>  PIPELINE_PROXY_PORT=<port>
#   defaults:  pipeline-net (internal)      pipeline-proxy            3128
# Task containers join with:
#   --network "$PIPELINE_NET" -e HTTPS_PROXY=http://$PIPELINE_PROXY:$PIPELINE_PROXY_PORT \
#   -e HTTP_PROXY=... -e NO_PROXY=localhost,127.0.0.1
set -u
NET="${PIPELINE_NET:-pipeline-net}"
PROXY="${PIPELINE_PROXY:-pipeline-proxy}"
PROXY_PORT="${PIPELINE_PROXY_PORT:-3128}"
# The IMAGE stays shared: identical content for every project, so per-projecting the tag
# would rebuild the same squid image once per project for nothing.
IMG=pipeline-proxy:local
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BASE_IMG="${BASE_IMG:-pipeline-base:local}"

up() {
  # The build is the one shared step: same tag, same context, so two projects coming up at
  # once either hit the cache or produce the same image. Nothing below touches a name this
  # run was not given.
  docker build -q -t "$IMG" "$ROOT/docker/proxy" >/dev/null || { echo "proxy image build failed"; exit 1; }
  docker network inspect "$NET" >/dev/null 2>&1 || docker network create --internal "$NET" >/dev/null
  docker rm -f "$PROXY" >/dev/null 2>&1 || true
  docker run -d --name "$PROXY" "$IMG" >/dev/null            # default bridge: egress side
  docker network connect "$NET" "$PROXY"                     # internal side: tasks reach it by this name
  # Ready when squid answers HTTP on the internal side (any response counts). The probe
  # must use this run's own proxy name and port — it is the same URL the tasks get.
  for i in $(seq 1 15); do
    if docker run --rm --network "$NET" "$BASE_IMG" \
         sh -c "curl -s -m 2 -o /dev/null http://$PROXY:$PROXY_PORT" 2>/dev/null; then
      echo "$NET up (proxy $PROXY ready)"; return 0
    fi
    sleep 1
  done
  echo "proxy $PROXY did not become ready"; exit 1
}

down() {
  docker rm -f "$PROXY" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  echo "$NET down"
}

case "${1:-}" in
  up) up ;;
  down) down ;;
  *) echo "usage: pipeline-net.sh up|down" >&2; exit 2 ;;
esac
