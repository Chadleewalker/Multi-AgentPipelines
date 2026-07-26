# Per-project image layer for the pipeline (DESIGN.md §6): thin, FROM the shared
# pinned base. This is the pipeline repo onboarded as its own target (dogfooding —
# see the DESIGN.md change log). dependencies in pipeline.config.json is empty:
# the runner and scaffolding are plain Node with zero packages, so the base image
# already has everything a task needs. Cross-check rule (§3.4): if dependencies
# ever gains an entry, it must be installed here in the same change.
FROM pipeline-base:local

USER node
WORKDIR /workspace
