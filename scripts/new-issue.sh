#!/usr/bin/env bash
# Create a pipeline task issue with the five mandatory spec fields (DESIGN.md §3.1,
# mapping in beads/issue-template.md). Refuses to create an issue missing any of:
# title, description, acceptance criteria, design-ref.
# Prints the new issue id on success.
set -u

TITLE="" DESC="" CONSTRAINTS="- (none noted)" ACCEPT="" REF="" PRIO="2" DEPS="" DIR="."
usage() {
  echo "usage: new-issue.sh -t <title> -d <description> -a <acceptance> -r <design-ref>" >&2
  echo "                    [-c <constraints>] [-p 0-4] [-D dep,dep] [-C <repo-dir>]" >&2
  exit 2
}
while getopts "t:d:c:a:r:p:D:C:" opt; do
  case "$opt" in
    t) TITLE="$OPTARG" ;; d) DESC="$OPTARG" ;; c) CONSTRAINTS="$OPTARG" ;;
    a) ACCEPT="$OPTARG" ;; r) REF="$OPTARG" ;; p) PRIO="$OPTARG" ;;
    D) DEPS="$OPTARG" ;; C) DIR="$OPTARG" ;; *) usage ;;
  esac
done
[ -n "$TITLE" ] && [ -n "$DESC" ] && [ -n "$ACCEPT" ] && [ -n "$REF" ] || usage

BODY="## Description
$DESC

## Constraints
$CONSTRAINTS"

# bd from the host when available; otherwise via the base image against the repo dir.
# On Git Bash, MSYS rewrites container-side paths (/repo -> C:/Program Files/Git/repo),
# so mount sources go through cygpath and the docker call runs with MSYS_NO_PATHCONV=1.
if command -v bd >/dev/null 2>&1; then
  BD=(bd -C "$DIR")
else
  SRC="$(cd "$DIR" && pwd)"
  command -v cygpath >/dev/null 2>&1 && SRC="$(cygpath -m "$SRC")"
  BD=(env MSYS_NO_PATHCONV=1 docker run --rm -i -v "$SRC:/repo" -w /repo pipeline-base:local bd)
fi

ARGS=(create "$TITLE" --stdin --acceptance "$ACCEPT" --design "design-ref: $REF" -p "$PRIO" --silent)
[ -n "$DEPS" ] && ARGS+=(--deps "$DEPS")
printf '%s' "$BODY" | "${BD[@]}" "${ARGS[@]}"
