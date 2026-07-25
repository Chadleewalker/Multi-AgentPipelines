#!/usr/bin/env bash
# Container entrypoint — the per-task coding loop (DESIGN.md §4.3, §4.6, §4.11; T8).
# Runs inside the task container from the read-only /pipeline mount (§4.10).
#
# Fixed sequence, scaffolding-driven (no LLM decides phases):
#   code → verify → (retry, max 3 attempts TOTAL, carried across relaunches) → commit
#   [T9 inserts the docs phase before the final commit; T10 inserts rate-limit exit 20]
#
# Inputs (§4.10): /workspace mount (repo on task branch), /workspace/.run/issue.md,
#   ISSUE_ID, PIPELINE_AGENT_CMD (test seam; defaults to headless claude), token+proxy env.
# Outputs (§4.11): exit 0 verified / 10 stuck / 11 tampered / 30 internal error,
#   plus /workspace/.run/status.json (schema: schemas/status.schema.json).
set -u
WS="${WORKSPACE:-/workspace}"
RUN="$WS/.run"
PIPE="${PIPELINE_DIR:-/pipeline}"
AGENT_CMD="${PIPELINE_AGENT_CMD:-claude -p --dangerously-skip-permissions}"
MAX_ATTEMPTS=3

die30() { echo "entrypoint: $1" >&2; exit 30; }

[ -n "${ISSUE_ID:-}" ] || die30 "ISSUE_ID not set"
cd "$WS" 2>/dev/null || die30 "workspace $WS missing"
[ -f "$RUN/issue.md" ] || die30 "issue file $RUN/issue.md missing"
mkdir -p "$RUN"

# Contract artifacts never enter commits (defense in depth; the runner also excludes).
grep -qxF '.run/' .git/info/exclude 2>/dev/null || echo '.run/' >> .git/info/exclude
# The container has no identity of its own; commits are the pipeline's.
git config user.email >/dev/null 2>&1 || { git config user.email pipeline@localhost; git config user.name pipeline; }

node "$PIPE/status.js" init "$ISSUE_ID" || die30 "status init failed"

while :; do
  DONE=$(node "$PIPE/status.js" attempts) || die30 "status read failed"
  [ "$DONE" -lt "$MAX_ATTEMPTS" ] || break
  N=$((DONE + 1))
  [ "$DONE" -eq 0 ] && rm -f "$RUN/feedback.txt"

  # ---- code phase: one headless agent invocation, prompt on stdin ----
  {
    echo "You are implementing one task inside an autonomous pipeline (attempt $N of $MAX_ATTEMPTS)."
    echo "Work in the current directory: a git checkout on a task branch."
    echo "NEVER modify tests/acceptance/ or any frozen path - the verifier fails the task if you do."
    echo "Do not run git commit; the scaffolding commits for you."
    echo "Done means: the frozen acceptance tests under tests/acceptance/$ISSUE_ID/ pass."
    echo
    echo "--- TASK SPEC ---"
    cat "$RUN/issue.md"
    if [ -f "$RUN/feedback.txt" ]; then
      echo
      echo "--- VERIFIER FEEDBACK FROM PREVIOUS ATTEMPT ---"
      cat "$RUN/feedback.txt"
    fi
  } > "$RUN/prompt-$N.md"
  if ! sh -c "$AGENT_CMD" < "$RUN/prompt-$N.md" > "$RUN/agent-$N.log" 2>&1; then
    die30 "agent command failed on attempt $N (see agent-$N.log)"   # T10: rate-limit detect goes here
  fi

  # ---- verify phase: the authoritative gate (§4.4) ----
  node "$PIPE/verify.js"
  VRC=$?
  case "$VRC" in
    0)
      node "$PIPE/status.js" append pass
      git add -A
      git commit -qm "Task $ISSUE_ID: implementation (verified on attempt $N)" || true
      exit 0 ;;
    1)
      node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('$RUN/verify.json','utf8')).acceptanceOutput||'')" > "$RUN/feedback.txt"
      node "$PIPE/status.js" append fail "$RUN/feedback.txt" ;;
    3)
      node "$PIPE/status.js" append tampered
      git add -A
      git commit -qm "WIP: task $ISSUE_ID failed - frozen tests were modified" || true
      exit 11 ;;
    *)
      node "$PIPE/status.js" append error 2>/dev/null || true
      die30 "verifier internal error (rc=$VRC)" ;;
  esac
done

# ---- bail: three failed attempts (§4.6) ----
node "$PIPE/status.js" set stuckState "bailed after $MAX_ATTEMPTS failed verification attempts; per-attempt feedback in attempts[]"
git add -A
git commit -qm "WIP: task $ISSUE_ID bailed after $MAX_ATTEMPTS failed verification attempts" || true
exit 10
