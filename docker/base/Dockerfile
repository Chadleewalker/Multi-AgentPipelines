# Pipeline base image — DESIGN.md §6 (image strategy), built by T1.
#
# Contains exactly: Node, git, both agent CLIs (Claude Code and Codex), and bd (Beads).
# NO pipeline scaffolding — the entrypoint and verifier are bind-mounted read-only
# at /pipeline by the runner at run time (DESIGN.md §4.10), so scaffolding changes
# never require an image rebuild.
# NO credentials — the selected provider's variable (CLAUDE_CODE_OAUTH_TOKEN or
# CODEX_API_KEY) is passed BY NAME only at `docker run`, never baked into a layer (§6).
# No Codex auth.json is copied in either: a container authenticates from that variable,
# and the host's saved ChatGPT CLI login stays on the host.
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
    @openai/codex@0.154.0 \
    @beads/bd@1.1.0

# A version pin alone is not the check. The pipeline's noninteractive contract depends on
# specific `codex exec` capabilities, and an image can carry a pinned-but-incompatible CLI
# (0.58 offers none of these), so the BUILD fails here rather than every task failing
# obscurely later. The same roster is named once in runner/agent-provider.js
# (CODEX_REQUIRED_EXEC_FLAGS) and re-probed by preflight against the built image.
RUN help="$(codex exec --help 2>&1)" \
    && for flag in --approve-for-me --ephemeral --ignore-user-config --ignore-rules --strict-config; do \
         case "$help" in \
           *"$flag"*) ;; \
           *) echo "codex exec is missing required capability $flag" >&2; exit 1 ;; \
         esac; \
       done

# Tasks run as the image's non-root "node" user; /workspace is the bind-mounted
# per-task clone (§4.2) and the default working directory.
USER node
WORKDIR /workspace
