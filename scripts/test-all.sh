#!/usr/bin/env bash
# Copyright 2026 Chad Walker
# SPDX-License-Identifier: Apache-2.0

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
# directory enforces that. After EVERY suite — not only a timed-out one, and whether or
# not the network survived — the sweep reclaims what that suite leaked, and only what it
# leaked: scripts/sweep-reclaim.js diffs a before-listing against an after-listing and
# removes what BOTH appeared during the suite and matches the pipeline allowlist. It never
# matches a bare name substring, because the host runs unrelated containers.
#
# Every docker call below goes through ${SWEEP_DOCKER:-docker} — the prechecks included.
# That one seam is what lets scripts/test-sweep-hygiene.sh drive this file with no daemon
# at all, and it is safe because a missed seam yields an empty diff and removes nothing.
#
# The PASSED column counts assertions that PASSED, in both of this repo's vocabularies: the
# shell wrappers print `PASS `, the Node checkers under tests/ print `ok - `. A log carrying
# both reports one honest total rather than their sum, and a log carrying neither prints `?`
# rather than 0 — "could not tell" and "everything failed" are different facts. The decision
# is scripts/sweep-assertions.js, a pure function tested over planted logs; this file only
# renders it. The FAIL grep below is untouched: both vocabularies start a failure line with
# `FAIL` and whitespace, so it already saw both.
#
# Exits 0 only if every suite exited 0 AND printed no `FAIL` line. Reclamation can never
# change that: each suite's exit code is captured before any cleanup runs, and the
# reclaimer always exits 0. This is deterministic scaffolding — no LLM, consistent with
# the hard rules in CLAUDE.md.
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BASE_IMG="${BASE_IMG:-pipeline-base:local}"
# The single docker seam (see the header). Exported so the reclaimer, which is the only
# thing here that removes anything, acts through the same stand-in the sweep was given.
SWEEP_DOCKER="${SWEEP_DOCKER:-docker}"; export SWEEP_DOCKER
RECLAIM="$ROOT/scripts/sweep-reclaim.js"
# The assertion counter (see the header). Consulted per suite log; absent only in a stripped
# down harness root, where the pre-repo-0ay grep below still answers.
ASSERTS_JS="$ROOT/scripts/sweep-assertions.js"
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
    -h|--help)   sed -n '2,46p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
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
"$SWEEP_DOCKER" info >/dev/null 2>&1 \
  || { echo "FATAL  Docker is not running — start Docker Desktop and retry."; exit 1; }
echo "ok     Docker is running"

"$SWEEP_DOCKER" image inspect "$BASE_IMG" >/dev/null 2>&1 \
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
NAMES=(); RESULTS=(); PASSED=(); TIMES=(); NOTES=()
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
  # The before-listing, taken per suite: whatever is here now, this suite cannot have
  # created. Kept in the sweep directory as evidence. If it fails the reclaimer refuses to
  # remove anything at all — the sweep never removes what it cannot prove it created.
  before="$LOGDIR/$name.before.json"
  node "$RECLAIM" snapshot > "$before" || true

  start=$(date +%s)
  # pipefail is load-bearing: without it the pipeline reports tee's status, not the
  # suite's, and every suite would read as green (same reason as the tee'd call sites
  # inside the suites themselves).
  ( set -o pipefail; "${TIMEOUT_CMD[@]}" bash "$f" 2>&1 | tee "$log" )
  rc=$?
  dur=$(( $(date +%s) - start ))

  # The count, in whichever of the two vocabularies this suite speaks. It is a COUNT and
  # never a verdict — `result` below is decided by `rc` and `nfail` alone, as it always was.
  npass=""
  if [ -f "$ASSERTS_JS" ]; then
    npass="$(node "$ASSERTS_JS" count "$log" 2>/dev/null)" || npass=""
  fi
  if [ -z "$npass" ]; then
    # The pre-repo-0ay counter: one vocabulary, and blind to `ok - `. Reached only when the
    # helper is missing or could not read the log — a number from the wrong vocabulary still
    # beats an empty column, and it can never change the verdict.
    npass=$(grep -c '^PASS[[:space:]]' "$log" 2>/dev/null || true); npass=${npass:-0}
  fi
  # Untouched, and load-bearing: this feeds the verdict, and BOTH vocabularies begin a failure
  # line with `FAIL` plus whitespace, so it already sees `FAIL - ` as well as `FAIL  `.
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

  # Hygiene: every suite tears its own containers and network down in an EXIT trap. When
  # one didn't, the next suite inherits a half-configured network or a stray container and
  # fails for the wrong reason. This runs after EVERY suite — a suite that exits 1 orphans
  # containers just as readily as one that times out, and a leak is no less real for
  # having taken the network down on the way out.
  #
  # `rc` is already captured and `result` already decided, which is what keeps cleanup out
  # of the verdict — reclaiming must never mask a real failure, nor invent one. Keep that
  # ordering: this block must never move above the one that sets `result`.
  reclaimed="$(node "$RECLAIM" reclaim --before "$before")" || reclaimed=""
  if [ -n "$reclaimed" ]; then
    note="${note:+$note; }$reclaimed"
    echo "  $name: $reclaimed"
  fi

  NAMES+=("$name"); RESULTS+=("$result"); PASSED+=("$npass"); TIMES+=("$dur"); NOTES+=("$note")
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
  printf '%-8s %-28s %8s %7s  %s\n' RESULT SUITE PASSED TIME NOTE
  for i in "${!NAMES[@]}"; do
    printf '%-8s %-28s %8s %7s  %s\n' \
      "${RESULTS[$i]}" "${NAMES[$i]}" "${PASSED[$i]}" "$(hhmmss "${TIMES[$i]}")" "${NOTES[$i]}"
  done
  echo
  # The header says PASSED rather than ASSERTS because the semantics are a choice, and an
  # unlabelled number is how a column ends up measuring something nobody meant.
  echo 'PASSED = assertions that passed, counted in whichever of the two vocabularies the log'
  echo '  speaks: PASS lines (the shell wrappers) or "ok - " lines (the Node checkers). A log'
  echo '  carrying both reports one honest total, never their sum. A cell reading ? means the'
  echo '  log carried no countable assertion line at all — unknown, which is not zero.'
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
