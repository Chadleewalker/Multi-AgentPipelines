#!/usr/bin/env bash
# The full sweep: every test suite in this repo, one at a time, with a report.
#
# Why this exists: the suites that break are the ones nobody re-runs. T12 sat unrun
# while T15 and T17 changed the runner underneath it and quietly accumulated three
# separate staleness bugs (docs/STATUS.md, "Full re-run 2026-07-26"). Nothing enforced
# a sweep after a batch of merges — it happened once because someone asked. This is the
# thing to run after merging, before a shadow run, and when picking up a cold branch.
#
#   bash scripts/test-all.sh                  # every suite; keeps going after a red one
#   bash scripts/test-all.sh --fail-fast      # stop at the first red suite
#   bash scripts/test-all.sh --only runner    # comma-separated substring filter
#   bash scripts/test-all.sh --skip e2e,egress
#   bash scripts/test-all.sh --list           # print the plan and exit
#   bash scripts/test-all.sh --timeout 1200   # per-suite kill, seconds (default 900)
#
# Discovery is dynamic — scripts/test-*.sh in sorted order, then e2e.sh last (slowest,
# and the only one that touches live GitHub). A suite added later is swept without
# anyone remembering to edit this file, which is the entire point.
#
# Suites share one Docker network (§4.8) and must never run concurrently: a lock
# directory enforces that, and the network is torn down between suites if one leaks it.
#
# Exits 0 only if every suite exited 0 AND printed no `FAIL` line. This is deterministic
# scaffolding — no LLM, consistent with the hard rules in CLAUDE.md.
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BASE_IMG="${BASE_IMG:-pipeline-base:local}"
TIMEOUT=900
FAIL_FAST=0
ONLY=""
SKIP=""
LIST_ONLY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --fail-fast) FAIL_FAST=1; shift ;;
    --only)      ONLY="${2:-}"; shift 2 ;;
    --skip)      SKIP="${2:-}"; shift 2 ;;
    --timeout)   TIMEOUT="${2:-}"; shift 2 ;;
    --list)      LIST_ONLY=1; shift ;;
    -h|--help)   sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)           echo "unknown argument: $1 (try --help)"; exit 2 ;;
  esac
done

# --- The plan -----------------------------------------------------------------------
# Sorted test-*.sh, then e2e.sh: deterministic order, integration pass last.
PLAN=()
for f in "$ROOT"/scripts/test-*.sh; do
  [ -e "$f" ] || continue
  case "$(basename "$f")" in test-all.sh) continue ;; esac
  PLAN+=("$f")
done
[ -e "$ROOT/scripts/e2e.sh" ] && PLAN+=("$ROOT/scripts/e2e.sh")

matches() { # matches <name> <comma-list>
  local name="$1" list="$2" part
  IFS=',' read -ra part <<< "$list"
  for p in "${part[@]}"; do
    [ -n "$p" ] && case "$name" in *"$p"*) return 0 ;; esac
  done
  return 1
}

SELECTED=()
for f in "${PLAN[@]}"; do
  name="$(basename "$f" .sh)"
  [ -n "$ONLY" ] && ! matches "$name" "$ONLY" && continue
  [ -n "$SKIP" ] &&   matches "$name" "$SKIP" && continue
  SELECTED+=("$f")
done

if [ "${#SELECTED[@]}" -eq 0 ]; then
  echo "no suites selected (--only '$ONLY' --skip '$SKIP')"; exit 2
fi

if [ "$LIST_ONLY" -eq 1 ]; then
  echo "${#SELECTED[@]} suites, in order:"
  for f in "${SELECTED[@]}"; do echo "  $(basename "$f")"; done
  exit 0
fi

# --- Lock: one sweep, one suite, at a time ------------------------------------------
mkdir -p "$ROOT/runs"
LOCK="$ROOT/runs/.test-all.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  echo "another sweep holds the lock: $LOCK"
  [ -f "$LOCK/pid" ] && echo "  started by pid $(cat "$LOCK/pid") at $(cat "$LOCK/at" 2>/dev/null)"
  echo "  suites share one Docker network — never run two at once."
  echo "  if that process is gone: rm -rf '$LOCK'"
  exit 2
fi
echo "$$" > "$LOCK/pid"; date -u +%Y-%m-%dT%H:%M:%SZ > "$LOCK/at"
cleanup() { rm -rf "$LOCK"; }
trap cleanup EXIT INT TERM

STAMP="$(date +%Y%m%d-%H%M%S)"
LOGDIR="$ROOT/runs/sweeps/$STAMP"
mkdir -p "$LOGDIR"

# --- Preflight: fail in seconds, not after forty minutes of guaranteed red ----------
echo "== preflight =="
docker info >/dev/null 2>&1 \
  || { echo "FATAL  Docker is not running — start Docker Desktop and retry."; exit 1; }
echo "ok     docker is running"

docker image inspect "$BASE_IMG" >/dev/null 2>&1 \
  || { echo "FATAL  image $BASE_IMG not found — build it first (docker/base)."; exit 1; }
echo "ok     image $BASE_IMG present"

# Suites expect the subscription token in the ambient env; only test-egress.sh sources
# the file itself. Load it here so every suite sees the same credential (§6).
if [ -f "$ROOT/.env.pipeline" ]; then
  # shellcheck disable=SC1091
  . "$ROOT/.env.pipeline" && export CLAUDE_CODE_OAUTH_TOKEN
fi
if [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
  echo "ok     CLAUDE_CODE_OAUTH_TOKEN loaded"
else
  echo "warn   no CLAUDE_CODE_OAUTH_TOKEN — the live claude -p check in test-egress.sh will skip"
fi

if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  echo "ok     gh authenticated (e2e.sh can reach GitHub)"
else
  echo "warn   gh missing or not authenticated — e2e.sh will fail its live PR assertions"
fi

TIMEOUT_CMD=()
if command -v timeout >/dev/null 2>&1; then
  TIMEOUT_CMD=(timeout -k 30 "$TIMEOUT")
  echo "ok     per-suite timeout ${TIMEOUT}s"
else
  echo "warn   no 'timeout' command — a hung suite will hang the sweep"
fi

echo
echo "sweeping ${#SELECTED[@]} suites; logs in runs/sweeps/$STAMP/"

# --- The sweep ----------------------------------------------------------------------
NAMES=(); RESULTS=(); ASSERTS=(); TIMES=(); NOTES=()
RED=0
SWEEP_START=$(date +%s)

hhmmss() { printf '%d:%02d' $(( $1 / 60 )) $(( $1 % 60 )); }

for f in "${SELECTED[@]}"; do
  name="$(basename "$f" .sh)"
  log="$LOGDIR/$name.log"
  echo
  echo "############################################################"
  echo "# $name"
  echo "############################################################"
  start=$(date +%s)
  # pipefail is load-bearing: without it the pipeline reports tee's status, not the
  # suite's, and every suite would read as green (same reason as the tee'd call sites
  # inside the suites themselves).
  ( set -o pipefail; "${TIMEOUT_CMD[@]}" bash "$f" 2>&1 | tee "$log" )
  rc=$?
  dur=$(( $(date +%s) - start ))

  npass=$(grep -c '^PASS[[:space:]]' "$log" 2>/dev/null || true); npass=${npass:-0}
  nfail=$(grep -c '^FAIL[[:space:]]' "$log" 2>/dev/null || true); nfail=${nfail:-0}
  note=""

  if [ "$rc" = 124 ] || [ "$rc" = 137 ]; then
    result="TIMEOUT"; note="killed after ${TIMEOUT}s"
  elif [ "$rc" != 0 ]; then
    result="FAIL"; note="exit $rc"
  elif [ "$nfail" -gt 0 ]; then
    # A suite that prints FAIL but exits 0 is itself broken — catch it, don't trust it.
    result="FAIL"; note="exit 0 but $nfail FAIL line(s)"
  else
    result="PASS"
  fi

  # Network hygiene: every suite tears pipeline-net down in its own trap. If one didn't,
  # the next suite inherits a half-configured network and fails for the wrong reason.
  if docker network inspect pipeline-net >/dev/null 2>&1; then
    if [ "$result" = "TIMEOUT" ]; then
      for c in $(docker ps -q --filter "ancestor=$BASE_IMG" 2>/dev/null); do
        docker rm -f "$c" >/dev/null 2>&1 && echo "  swept stray container $c"
      done
    fi
    bash "$ROOT/scripts/pipeline-net.sh" down >/dev/null 2>&1
    note="${note:+$note; }left pipeline-net up"
    echo "  note: $name left pipeline-net up — torn down before the next suite"
  fi

  NAMES+=("$name"); RESULTS+=("$result"); ASSERTS+=("$npass"); TIMES+=("$dur"); NOTES+=("$note")
  echo "-- $result  $name  ($npass passed, $nfail failed, $(hhmmss "$dur"))"

  if [ "$result" != "PASS" ]; then
    RED=$(( RED + 1 ))
    if [ "$FAIL_FAST" -eq 1 ]; then
      echo; echo "--fail-fast: stopping after $name"
      break
    fi
  fi
done

# --- Report -------------------------------------------------------------------------
TOTAL=$(( $(date +%s) - SWEEP_START ))
{
  echo
  echo "############################################################"
  echo "# SWEEP SUMMARY   $STAMP"
  echo "############################################################"
  printf '%-8s %-28s %8s %7s  %s\n' RESULT SUITE ASSERTS TIME NOTE
  for i in "${!NAMES[@]}"; do
    printf '%-8s %-28s %8s %7s  %s\n' \
      "${RESULTS[$i]}" "${NAMES[$i]}" "${ASSERTS[$i]}" "$(hhmmss "${TIMES[$i]}")" "${NOTES[$i]}"
  done
  echo
  ran=${#NAMES[@]}
  skipped=$(( ${#SELECTED[@]} - ran ))
  echo "$ran of ${#SELECTED[@]} suites ran in $(hhmmss "$TOTAL"); $(( ran - RED )) green, $RED red$([ "$skipped" -gt 0 ] && echo ", $skipped not reached")"
  if [ "$RED" -gt 0 ]; then
    echo
    echo "red suites — open the log to see which assertion:"
    for i in "${!NAMES[@]}"; do
      [ "${RESULTS[$i]}" = "PASS" ] || echo "  runs/sweeps/$STAMP/${NAMES[$i]}.log"
    done
  fi
} | tee "$LOGDIR/summary.txt"

[ "$RED" -eq 0 ] || exit 1
exit 0
