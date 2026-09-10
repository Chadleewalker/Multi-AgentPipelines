# Pipeline base image — DESIGN.md §6 (image strategy), built by T1.
#
# Contains exactly: Node, git, the Claude Code CLI, the Codex CLI, and bd (Beads).
# NO pipeline scaffolding — the entrypoint and verifier are bind-mounted read-only
# at /pipeline by the runner at run time (DESIGN.md §4.10), so scaffolding changes
# never require an image rebuild.
# NO credentials — CLAUDE_CODE_OAUTH_TOKEN and CODEX_API_KEY are passed by NAME only at
# `docker run` (§6, §6.5), so neither value can reach a layer, a history entry or a log.
# NO host authentication either: the host's saved Codex auth.json is never copied or
# mounted in; a container Codex authenticates with CODEX_API_KEY and nothing else.
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

# Prove the image can run the agents it claims to carry, at BUILD time.
# Presence of a package is not the property that matters: an older Codex still answers
# `codex exec` and rejects every capability an autonomous run depends on (Codex 0.58 is
# the concrete example — no --approve-for-me, no --ephemeral, no --ignore-user-config, no
# --ignore-rules, no --strict-config), which would surface as a task that fails or, worse,
# one that runs under the host's personal config with a human expected at the approval
# prompt. So the roster is checked against the CLI's own help text here, where a wrong pin
# fails a build rather than a night of tasks. The runner asks the same question of the
# built image before a run (runner/preflight.js imageSupportsProvider).
# The check needs no network, no credential and no model call.
RUN claude --version \
    && bd --version \
    && codex --version \
    && codex exec --help > /tmp/codex-exec-help.txt \
    && for capability in --approve-for-me --ephemeral --ignore-user-config --ignore-rules --strict-config; do \
         grep -q -- "$capability" /tmp/codex-exec-help.txt \
           || { echo "codex exec does not offer $capability — wrong Codex pin" >&2; exit 1; }; \
       done \
    && rm -f /tmp/codex-exec-help.txt

# Tasks run as the image's non-root "node" user; /workspace is the bind-mounted
# per-task clone (§4.2) and the default working directory.
USER node
WORKDIR /workspace
