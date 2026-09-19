# Git-authoritative executable modes for conveyor publication

## Approved scope

This is the normal-conveyor fix from immutable kickoff `kp-83f64cf5f52bbe16`,
hash `sha256:0177f253863f5e6af3e42abcdffcb3d824816abe24ae746818412e438bd0f55d`,
implemented by canonical task `repo-3ec` and tracked diagnostically by `repo-djf.58`.
Difficulty: hard. This document extends the existing verifier and staging design;
it does not import supersession or historical-validation work.

The real three-idea demonstration produced executable-required shell scripts whose
Git modes were 100644. A Windows Docker bind mount reported them executable, so a
filesystem-only assertion passed although the published tree was wrong. Git index
modes must determine publishable executable semantics. Explicit executable intent
uses `git update-index --chmod=+x` or `--chmod=-x`; extensions, shebangs and apparent
Windows permissions do not establish intent. Do not blanket-chmod files or enable
`core.filemode=true` to trust bind-mount bits.

## Required behavior

Canonical proof and implementation verification must judge the candidate's contents
and Git-authoritative modes together. Where workspace permissions do not faithfully
represent modes, use a native POSIX materialization of that candidate.
Mechanism details are implementation choices; the
verified contents and modes must be bound to the tree ultimately published.

Explicit 100755 intent must survive normal staging, implementation commit, docs
processing and publication. Ordinary files stay 100644, existing executable files
stay 100755 unless explicitly changed, and explicit executable removal yields
100644. Preserve symlinks, frozen contents and modes, fork-point configuration,
regression policy, credential scanning and ownership boundaries. Refuse index-only
frozen mode changes; do not silently repair them.

Changing publishable content or modes invalidates earlier verification evidence.
Materialization and verifier errors fail closed with bounded, actionable evidence.
For negative executable-mode and stale-evidence cases, no verified-success outcome
or implementation PR may be reported. Existing recovery-only pushes of failed or
stuck branches remain permitted by current publication policy; this task does not
ban those evidence-preserving pushes.

## Verification boundary

Use deterministic real Git fixtures through the canonical proof, verifier,
implementation entrypoint, staging/commit, docs-processing and publication paths.
A fixture with `core.filemode=false`, executable-looking workspace content and
index mode 100644 must fail an unchanged executable assertion and produce zero PR
creation calls. The otherwise equivalent explicit-100755 fixture must pass in a
native POSIX tree and publish that mode. Include ordinary files, existing
executables, executable removal, index-only frozen mode tampering, stale content
and mode evidence, and materialization-error negative controls.

Only new issue-owned acceptance tests may be added. Existing frozen tests and
publication policy remain unchanged. Run focused acceptance and the mandatory
profile as outer validation; do not recursively run the historical acceptance
population. Product changes are pipeline-written with Claude Opus 4.8. Documentation
of the explicit Git-mode workflow is allowed. Human test-freeze and PR-merge approvals are
separate.

## Non-goals

No historical-validation, supersession or failed-draft-recovery implementation;
no general filesystem virtualization system. Preserve fixture demo PRs 47, 48 and
49 and their frozen suites without editing, merging, replacing or deleting them.
