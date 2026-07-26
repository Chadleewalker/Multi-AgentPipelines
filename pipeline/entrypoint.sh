#!/usr/bin/env bash
# Container entrypoint — the per-task coding loop (DESIGN.md §4.3, §4.6, §4.11; T8).
# Runs inside the task container from the read-only /pipeline mount (§4.10).
#
# Fixed sequence, scaffolding-driven (no LLM decides phases):
#   code → verify → (retry, max PIPELINE_MAX_ATTEMPTS total — default 3 — carried
#   across relaunches) → commit
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
# The model is pinned by the runner (§4.3) so runs are reproducible and quality cannot
# drift when the account default changes. An explicit PIPELINE_AGENT_CMD owns its flags.
MODEL_ARG=""
[ -n "${PIPELINE_MODEL:-}" ] && MODEL_ARG=" --model ${PIPELINE_MODEL}"
AGENT_CMD="${PIPELINE_AGENT_CMD:-claude -p --dangerously-skip-permissions${MODEL_ARG}}"

# When we own the invocation, ask the code phase for JSON so the RESOLVED model id can
# be recorded (a `--model opus` alias hides which Opus actually ran). The human-readable
# text is extracted back out below, so agent logs stay readable. A caller-supplied
# PIPELINE_AGENT_CMD (stubs, overrides) owns its own flags and gets none of this.
CODE_FORMAT=""
[ -z "${PIPELINE_AGENT_CMD:-}" ] && CODE_FORMAT="--output-format json"
# Attempt cap (§4.6): tunable per run via run.config.json maxAttempts, which the
# runner forwards as PIPELINE_MAX_ATTEMPTS. Anything unset or non-numeric falls back
# to 3 — the cap must always be a positive integer or the retry loop breaks.
MAX_ATTEMPTS="${PIPELINE_MAX_ATTEMPTS:-3}"
case "$MAX_ATTEMPTS" in
  ''|*[!0-9]*|0) MAX_ATTEMPTS=3 ;;
esac

die30() { echo "entrypoint: $1" >&2; exit 30; }

[ -n "${ISSUE_ID:-}" ] || die30 "ISSUE_ID not set"
cd "$WS" 2>/dev/null || die30 "workspace $WS missing"
[ -f "$RUN/issue.md" ] || die30 "issue file $RUN/issue.md missing"
mkdir -p "$RUN"

# The workspace is a bind mount owned by the host user, so git's dubious-ownership
# guard would block every git call (and thus the verifier). The container is
# disposable and single-purpose, so trusting this one path is safe.
git config --global --add safe.directory "$WS" 2>/dev/null || true

# Contract artifacts never enter commits (defense in depth; the runner also excludes).
grep -qxF '.run/' .git/info/exclude 2>/dev/null || echo '.run/' >> .git/info/exclude
# The container has no identity of its own; commits are the pipeline's.
git config user.email >/dev/null 2>&1 || { git config user.email pipeline@localhost; git config user.name pipeline; }

node "$PIPE/status.js" init "$ISSUE_ID" || die30 "status init failed"
# (resolved model is recorded after the first agent call, below)

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
    # Memory out-channel (§3.6): the agent proposes, the host files it after exit.
    echo "If you learn something worth keeping for future tasks in this project, record it with:"
    echo "  node $PIPE/status.js note \"<insight>\""
    echo
    echo "--- TASK SPEC ---"
    cat "$RUN/issue.md"
    # Memory in-channel (§3.6): project memories exported read-only by the runner.
    # Absent whenever the host has none to export, so the prompt simply omits the block.
    if [ -f "$RUN/memory.md" ]; then
      echo
      echo "--- PROJECT MEMORY (read-only) ---"
      cat "$RUN/memory.md"
    fi
    if [ -f "$RUN/feedback.txt" ]; then
      echo
      echo "--- VERIFIER FEEDBACK FROM PREVIOUS ATTEMPT ---"
      cat "$RUN/feedback.txt"
    fi
  } > "$RUN/prompt-$N.md"
  if ! sh -c "$AGENT_CMD $CODE_FORMAT" < "$RUN/prompt-$N.md" > "$RUN/agent-$N.log" 2>&1; then
    # ---- rate-limit detection (§4.7, T10): a pause, never a failed attempt ----
    if grep -qiE 'usage limit|rate.?limit' "$RUN/agent-$N.log"; then
      EPOCH=$(grep -oiE 'usage limit reached\|[0-9]+' "$RUN/agent-$N.log" | grep -oE '[0-9]+$' | head -1)
      if [ -n "${EPOCH:-}" ]; then
        RESET=$(node -e "console.log(new Date($EPOCH*1000).toISOString())")
        node "$PIPE/status.js" set rateLimitResetAt "$RESET"
      fi
      exit 20   # runner parks the task; attempts[] untouched — interrupted ≠ failed
    fi
    die30 "agent command failed on attempt $N (see agent-$N.log)"
  fi

  # Record the resolved model once, and flatten the JSON envelope back to plain text
  # so agent-N.log stays readable for debugging. Fail-safe: if the shape ever changes,
  # the log is left as-is and no model is recorded.
  if [ -n "$CODE_FORMAT" ]; then
    node -e '
      const fs = require("fs");
      const f = process.argv[1];
      try {
        const j = JSON.parse(fs.readFileSync(f, "utf8"));
        const resolved = Object.keys(j.modelUsage || {})[0];
        if (resolved) fs.writeFileSync(f + ".model", resolved);
        if (typeof j.result === "string") fs.writeFileSync(f, j.result);
      } catch { /* not JSON (e.g. an error page) — leave the log untouched */ }
    ' "$RUN/agent-$N.log" 2>/dev/null || true
    if [ -f "$RUN/agent-$N.log.model" ]; then
      node "$PIPE/status.js" set model "$(cat "$RUN/agent-$N.log.model")" 2>/dev/null || true
      rm -f "$RUN/agent-$N.log.model"
    fi
  fi

  # ---- verify phase: the authoritative gate (§4.4) ----
  node "$PIPE/verify.js"
  VRC=$?
  case "$VRC" in
    0)
      node "$PIPE/status.js" append pass
      git add -A
      git commit -qm "Task $ISSUE_ID: implementation (verified on attempt $N)" || true
      # ---- docs phase (§4.3, T9): one agent invocation, non-fatal after success ----
      {
        echo "Verification for task $ISSUE_ID just passed. Two jobs:"
        echo "1. Update any in-repo documentation affected by the change (README, docs/)."
        echo "   NEVER touch tests/acceptance/ or any frozen path."
        echo "2. Your final output must be ONLY a concise change summary (2-4 sentences)"
        echo "   of what the implementation changed - it becomes the PR body."
        echo "Before that summary you may record any insight worth keeping for future tasks"
        echo "with: node $PIPE/status.js note \"<insight>\" - it does not go in the summary."
        echo
        echo "--- TASK SPEC ---"
        cat "$RUN/issue.md"
      } > "$RUN/prompt-docs.md"
      if sh -c "$AGENT_CMD" < "$RUN/prompt-docs.md" > "$RUN/docs-out.txt" 2>&1; then
        SUMMARY=$(tail -c 2000 "$RUN/docs-out.txt")
        [ -n "$SUMMARY" ] && node "$PIPE/status.js" set changeSummary "$SUMMARY"
        git add -A
        git commit -qm "Task $ISSUE_ID: docs" || true
      else
        node "$PIPE/status.js" set docsPhaseError "docs agent failed (see docs-out.txt); success stands"
      fi
      exit 0 ;;
    1)
      node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('$RUN/verify.json','utf8')).acceptanceOutput||'')" > "$RUN/feedback.txt"
      node "$PIPE/status.js" append fail "$RUN/feedback.txt"
      # Boundary commit (§4.3, T9): each attempt's state survives a later kill.
      git add -A
      git commit -qm "Task $ISSUE_ID: attempt $N (verification failed)" || true ;;
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

# ---- bail: attempt cap reached (§4.6) ----
# Attempt work is already committed at each boundary; this marker (allow-empty)
# labels the outcome at the branch tip.
node "$PIPE/status.js" set stuckState "bailed after $MAX_ATTEMPTS failed verification attempts; per-attempt feedback in attempts[]"
git add -A
git commit --allow-empty -qm "WIP: task $ISSUE_ID bailed after $MAX_ATTEMPTS failed verification attempts"
exit 10
