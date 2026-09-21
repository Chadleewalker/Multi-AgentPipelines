# Trust isolated Codex docs worktrees

## Observed failure

The no-key ChatGPT-subscription implementation run `repo-0tq-implementation-r2-20260914`
successfully verified its implementation, created the disposable documentation worktree added by
`repo-djf.32`, and then the real Codex CLI refused before reading the documentation prompt:

> Not inside a trusted directory and --skip-git-repo-check was not specified.

The docs phase is deliberately nonfatal, so PR #142 was safely published, but it carried no
docs-agent change summary. Stubbed docs-agent coverage did not exercise this real CLI trust gate.

## Decision

Keep the docs agent in the disposable detached Git worktree. For the Codex provider only, append
the CLI's supported `--skip-git-repo-check` flag to that docs invocation after deterministic
entrypoint scaffolding has changed the process working directory to the exact `DOCS_WORKTREE`.
The flag is invocation-local: do not write Codex or Git trust configuration, persist wildcard
trust, mutate the host login, add a model-editable config field, or grant permission to run the
docs agent in the publishable task workspace. The implementation invocation, Claude, and explicit
test-agent command behavior remain unchanged.

The managed ChatGPT credential boundary stays intact: no OpenAI API key, no host `CODEX_HOME`
mount, one private staged cache, the unprivileged Codex user, the provider-specific egress
allowlist, and credential-free verification. Only the allowed Markdown tree delta may cross from
the disposable worktree into the publishable workspace. Final verification still judges that
exact transferred tree and cleanup still removes only the owned disposable worktree.

## Failure and recovery

If the docs invocation, trust setup, Markdown boundary, transfer, or final verifier fails, the
verified implementation and its original verification evidence remain authoritative and the docs
phase records a named nonfatal error. No failure path broad-cleans the task workspace, modifies
host authentication state, exposes credentials, or admits files outside the established Markdown
surface.

## Proof obligations

The acceptance suite must reproduce the real Codex repository-trust refusal at the fork point and
pass only when a production-shaped managed-auth docs invocation succeeds in the exact disposable
worktree. It must prove that another path, the publishable workspace, and wildcard trust are not
authorized; that a successful docs call supplies the PR summary and transfers only allowed
Markdown; and that all existing rejection, rollback, verifier, cleanup, credential, and
provider-isolation behavior remains intact. Mandatory runner regressions and the `repo-djf.32`
publication-isolation suite remain green.
