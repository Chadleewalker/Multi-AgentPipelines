#!/bin/sh
# Acceptance-test runner: invoked by the pipeline verifier as
#   sh tools/run-acceptance.sh tests/acceptance/<issue-id>/
# Runs every *.sh (via sh) and *.js (via node) in the given directory, name order.
# Frozen path: listed in pipeline.config.json frozenPaths — never edited during a run.
set -u
DIR="${1:?usage: run-acceptance.sh <test-dir>}"
[ -d "$DIR" ] || { echo "FAIL: test dir not found: $DIR"; exit 1; }

FOUND=0 FAILED=0
for f in "$DIR"/*; do
  case "$f" in
    *.sh) FOUND=1; sh "$f" ;;
    *.js) FOUND=1; node "$f" ;;
    *) continue ;;
  esac
  if [ $? -ne 0 ]; then echo "FAIL: $f"; FAILED=1; else echo "PASS: $f"; fi
done

[ "$FOUND" -eq 1 ] || { echo "FAIL: no test files in $DIR"; exit 1; }
exit "$FAILED"
