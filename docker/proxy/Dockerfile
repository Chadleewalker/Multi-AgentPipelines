# Allowlist proxy sidecar — DESIGN.md §4.8, built by T5.
#
# An HTTP CONNECT proxy that permits TLS tunnels to the enumerated Anthropic
# endpoints ONLY. TLS is passed through, never intercepted: this config contains
# no ssl_bump and installs no CA certificate.
# The sidecar is dual-homed by scripts/pipeline-net.sh: default bridge (egress)
# plus the internal pipeline-net where task containers live.

FROM ubuntu/squid:6.6-24.04_edge

COPY squid.conf /etc/squid/squid.conf
COPY allowlist.txt /etc/squid/allowlist.txt
