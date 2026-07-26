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

# When we own the invocation, ask for JSON so the RESOLVED model id can be recorded (a
# `--model opus` alias hides which Opus actually ran) and so the docs phase hands back a
# summary with no CLI chatter around it. The human-readable text is extracted back out
# (envelope.js), so agent logs stay readable. A caller-supplied PIPELINE_AGENT_CMD
# (stubs, overrides) owns its own flags and gets none of this; extraction copes either way.
AGENT_FORMAT=""
[ -z "${PIPELINE_AGENT_CMD:-}" ] && AGENT_FORMAT="--output-format json"
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

# The CLI treats an unseen directory as untrusted and prints a warning ahead of its own
# output — noise that used to lead every PR body. Seed the trust + onboarding flags for
# this workspace rather than filtering the symptom downstream. The merge preserves any
# other keys in an existing config, and never touches (or prints) the token. Non-fatal:
# a read-only or unwritable HOME must not fail a task.
node -e '
  const fs = require("fs");
  const p = require("path").join(process.env.HOME || "/root", ".claude.json");
  let j = {};
  try { j = JSON.parse(fs.readFileSync(p, "utf8")); } catch { /* absent or unparsable */ }
  if (!j || typeof j !== "object" || Array.isArray(j)) j = {};
  if (!j.projects || typeof j.projects !== "object") j.projects = {};
  const ws = process.argv[1];
  j.projects[ws] = Object.assign({}, j.projects[ws], {
    hasTrustDialogAccepted: true,
    hasCompletedOnboarding: true,
  });
  fs.writeFileSync(p, JSON.stringify(j, null, 2) + "\n");
' "$WS" 2>/dev/null || true

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
    # Spec-concern out-channel (§3.7): "the spec is wrong" is a first-class result (§3.3),
    # so say the channel exists in the prompt itself — an agent never told cannot use it.
    echo "If you believe the frozen spec or its tests are themselves wrong, say so with:"
    echo "  node $PIPE/status.js concern \"<what is wrong and why>\""
    echo "A concern is evidence for the human reviewing this run; it cannot change the outcome"
    echo "of this task, so still do the best work the spec allows."
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
  if ! sh -c "$AGENT_CMD $AGENT_FORMAT" < "$RUN/prompt-$N.md" > "$RUN/agent-$N.log" 2>&1; then
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

  # Record the resolved model, and flatten the JSON envelope back to plain text so
  # agent-N.log stays readable for debugging. Runs unconditionally: a log with no
  # envelope (a stub, an error page, a caller-supplied command) is left byte-identical
  # and prints no model, so there is nothing to guard on. The rate-limit grep above has
  # already read the raw log.
  #
  # The pinned alias is passed through so the model that actually ran is the one recorded
  # — modelUsage also lists the cheap helper model the CLI bills alongside it (§4.3).
  # `${PIPELINE_MODEL:-}` (not `$PIPELINE_MODEL`) because `set -u` is on and an unpinned
  # run leaves it unset; the empty string means "no alias" and is not an error. stderr is
  # NOT swallowed: an alias that matches nothing is a diagnostic a human must see in the
  # run log, and hiding it is how the wrong model went unnoticed in the first place.
  MODEL=$(node "$PIPE/envelope.js" flatten "$RUN/agent-$N.log" "${PIPELINE_MODEL:-}") || MODEL=""
  [ -n "$MODEL" ] && node "$PIPE/status.js" set model "$MODEL" 2>/dev/null

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
        echo "If the frozen spec or its tests are themselves wrong, report that the same way"
        echo "with: node $PIPE/status.js concern \"<what is wrong and why>\" - it is evidence for"
        echo "the human reviewing this run and cannot change the outcome, and it is not part of"
        echo "the summary either."
        echo
        echo "--- TASK SPEC ---"
        cat "$RUN/issue.md"
      } > "$RUN/prompt-docs.md"
      # stderr goes to its own file, never into docs-out.txt: this output becomes the PR
      # body (§4.5), and CLI warnings on stderr used to lead every one of them. The file
      # is kept for debugging and, like everything under .run/, is never committed.
      if sh -c "$AGENT_CMD $AGENT_FORMAT" < "$RUN/prompt-docs.md" > "$RUN/docs-out.txt" 2> "$RUN/docs-err.txt"; then
        node "$PIPE/status.js" summary "$RUN/docs-out.txt" || true
        git add -A
        git commit -qm "Task $ISSUE_ID: docs" || true
      else
        node "$PIPE/status.js" set docsPhaseError "docs agent failed (see docs-out.txt / docs-err.txt); success stands"
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
