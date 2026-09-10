# Codex allowlist proxy sidecar — DESIGN.md §4.8.
#
# An HTTP CONNECT proxy that permits TLS tunnels to the enumerated OpenAI endpoints ONLY.
# TLS is passed through, never intercepted: this config contains no ssl_bump and installs
# no CA certificate.
#
# A SEPARATE image from docker/proxy, deliberately. Adding these endpoints to that profile
# would give every Claude task reach it does not need, and every Codex task reach into the
# other vendor — the deny-by-default posture only means something while each profile
# carries exactly the roster its own provider requires.
# The sidecar is dual-homed by scripts/pipeline-net.sh: default bridge (egress) plus the
# run's own internal network, where its task containers live.

FROM ubuntu/squid:6.6-24.04_edge

COPY squid.conf /etc/squid/squid.conf
COPY allowlist.txt /etc/squid/allowlist.txt
