# Pipeline base image — DESIGN.md §6 (image strategy), built by T1.
#
# Contains exactly: Node, git, both agent CLIs (Claude Code and Codex), and bd (Beads).
# NO pipeline scaffolding — the entrypoint and verifier are bind-mounted read-only
# at /pipeline by the runner at run time (DESIGN.md §4.10), so scaffolding changes
# never require an image rebuild.
# NO credentials — the selected provider's credential (CLAUDE_CODE_OAUTH_TOKEN or
# CODEX_API_KEY) is passed BY NAME only at `docker run` (§6), and never both. The host's
# saved Codex login (~/.codex/auth.json) is NEVER mounted: a container Codex authenticates
# with CODEX_API_KEY or not at all (change-log row `repo-45g`).
#
# Both CLIs are present in one image because the image is per project, not per provider,
# and a config may select Codex for a task while the same image serves a Claude run. The
# credential decides which one can actually talk to anything.
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
    @openai/codex@0.58.0 \
    @beads/bd@1.1.0

# Fail the BUILD, not the first Codex run, if the pin above stopped providing a `codex`
# executable. An image that is missing the CLI the run config selects is the failure mode
# runner/agent-provider.js's imageSupports gate reports; catching it here means the
# operator sees it while building rather than at the first dispatched task.
RUN claude --version && codex --version && bd --version

# Tasks run as the image's non-root "node" user; /workspace is the bind-mounted
# per-task clone (§4.2) and the default working directory.
USER node
WORKDIR /workspace
