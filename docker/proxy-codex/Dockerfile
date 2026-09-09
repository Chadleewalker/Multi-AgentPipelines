# Codex allowlist proxy sidecar — DESIGN.md §4.8 (change-log row `repo-45g`).
#
# An HTTP CONNECT proxy that permits TLS tunnels to the enumerated OpenAI endpoint ONLY.
# TLS is passed through, never intercepted: this config contains no ssl_bump and installs
# no CA certificate.
#
# A second image rather than a second mode of the first one. `scripts/pipeline-net.sh`
# selects the profile from PIPELINE_PROVIDER and tags it separately
# (pipeline-proxy-codex:local), so a Claude run and a Codex run cannot end up sharing a
# cached layer whose allowlist belongs to the other provider — and the Anthropic-only
# profile in docker/proxy, along with its regression in scripts/test-egress-check.sh, is
# untouched by any of this.
# The sidecar is dual-homed by scripts/pipeline-net.sh: default bridge (egress) plus the
# run's own internal network, where its task containers live.

FROM ubuntu/squid:6.6-24.04_edge

COPY squid.conf /etc/squid/squid.conf
COPY allowlist.txt /etc/squid/allowlist.txt
