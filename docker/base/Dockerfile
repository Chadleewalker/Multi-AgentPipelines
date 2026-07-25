# Pipeline base image — DESIGN.md §6 (image strategy), built by T1.
#
# Contains exactly: Node, git, the Claude Code CLI, and bd (Beads).
# NO pipeline scaffolding — the entrypoint and verifier are bind-mounted read-only
# at /pipeline by the runner at run time (DESIGN.md §4.10), so scaffolding changes
# never require an image rebuild.
# NO credentials — CLAUDE_CODE_OAUTH_TOKEN is passed only at `docker run` (§6).
#
# All versions pinned exactly (§6). To upgrade, change the pins here and rebuild.

FROM node:22.23.1-bookworm-slim

# git: workspace operations inside the container (commits stay local; no push — §4.5).
# ca-certificates: TLS through the allowlist proxy sidecar (§4.8).
# curl: in-container probes for the egress checks and isolation assertions (§4.8, §4.12).
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g --no-fund --no-audit \
    @anthropic-ai/claude-code@2.1.220 \
    @beads/bd@1.1.0

# Tasks run as the image's non-root "node" user; /workspace is the bind-mounted
# per-task clone (§4.2) and the default working directory.
USER node
WORKDIR /workspace
