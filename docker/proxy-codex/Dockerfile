# Codex allowlist proxy sidecar — DESIGN.md §4.8.
#
# An HTTP CONNECT proxy that permits TLS tunnels to the enumerated OpenAI endpoints
# ONLY. TLS is passed through, never intercepted: this config contains no ssl_bump and
# installs no CA certificate.
#
# A SEPARATE image from docker/proxy, which stays Anthropic-only and unchanged. Neither
# profile is ever widened to cover both providers: `scripts/pipeline-net.sh` selects one
# by PIPELINE_PROVIDER, so a run's tasks can reach exactly the vendor they were
# configured for and nothing else.
# The sidecar is dual-homed by scripts/pipeline-net.sh: default bridge (egress) plus the
# run's own internal network, where its task containers live (the network and the container
# are per project; this image is shared, since the allowlist is identical for all of them).

FROM ubuntu/squid:6.6-24.04_edge

COPY squid.conf /etc/squid/squid.conf
COPY allowlist.txt /etc/squid/allowlist.txt
