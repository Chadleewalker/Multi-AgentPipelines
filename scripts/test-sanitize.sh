#!/usr/bin/env bash
# Copyright 2026 Chad Walker
# SPDX-License-Identifier: Apache-2.0

# Publication-hygiene suite — the re-runnable checks that nothing in the tracked tree
# identifies the author's machine, another project, or a credential (DESIGN.md §6,
# change-log row `publish-sanitize-followup`).
#
# Docker-free and network-free: it reads tracked files only, so unlike most suites here it
# needs no base image, no pipeline network and no target repo. The sweep discovers it by
# glob (scripts/test-*.sh) and it is safe to run anywhere, including inside a task
# container.
#
# The negative cases are the point. A hygiene checker that silently matches nothing is
# indistinguishable from a clean repo, and this suite exists precisely because a hand pass
# and then an automated pass BOTH missed a private project name that was sitting in a
# tracked file — it hid inside a file git treats as binary, so `git grep` skipped it. Case 3
# below plants a term in a file containing a NUL byte and fails the suite if the checker
# does not find it. That is the regression test for the bug that created this suite.
#
# Run from Git Bash:  bash scripts/test-sanitize.sh
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FAIL=0
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; FAIL=1; }

# The rules are anchored ASCII; pin the collation so a caller's locale cannot change what
# counts as [A-Za-z0-9] for anything downstream.
LC_ALL=C
export LC_ALL

CHECKER="$ROOT/tests/unit/sanitize.test.js"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "== publication-hygiene checks =="

# ---- case 1: the real repo is clean -------------------------------------------------
OUT="$(node "$CHECKER" 2>&1)"; RC=$?
echo "$OUT"
if [ "$RC" -eq 0 ]; then
  pass "checker exits 0 against the real tracked tree"
else
  fail "checker exited $RC against the real tracked tree"
fi

CHECKS="$(echo "$OUT" | grep -c '^PASS  ')"
if [ "$CHECKS" -ge 5 ]; then
  pass "checker ran $CHECKS checks"
else
  fail "checker ran only $CHECKS checks (expected at least 5)"
fi

# ---- negative cases ------------------------------------------------------------------
# Each builds a fixture directory, runs the checker against it through the
# SANITIZE_FIXTURE_DIR seam, and asserts BOTH a non-zero exit and a printed FAIL line.
# Exit code alone would be satisfied by a checker that crashed on startup.
neg() {
  NAME="$1"; DIR="$2"; TERM_ENV="${3:-}"
  if [ -n "$TERM_ENV" ]; then
    O="$(SANITIZE_FIXTURE_DIR="$DIR" SANITIZE_DENY_TERM="$TERM_ENV" node "$CHECKER" 2>&1)"; R=$?
  else
    O="$(SANITIZE_FIXTURE_DIR="$DIR" node "$CHECKER" 2>&1)"; R=$?
  fi
  if [ "$R" -ne 0 ]; then pass "$NAME: checker exits non-zero"; else fail "$NAME: checker exited 0"; fi
  if echo "$O" | grep -q '^FAIL  '; then
    pass "$NAME: checker prints a FAIL line (proves it ran, not that it is missing)"
  else
    fail "$NAME: no FAIL line — checker may not have run"
  fi
}

# case 2: an absolute user-home path in an ordinary text file.
# Assembled from parts at runtime. This suite scans every *tracked* file and this file is
# one of them, so a literal user path written here would be reported as a finding in the
# suite itself — which is exactly what happened the first time it was committed, because
# until then the file was untracked and `git ls-files` never showed it to the checker.
# Building the string avoids an allow-list escape hatch, which would otherwise be the
# obvious way to silence a real finding.
mkdir -p "$TMP/f2"
DRIVE='C'
HOMEDIR='Users'
printf 'see %s:\\%s\\someone\\Projects\\thing for the layout\n' "$DRIVE" "$HOMEDIR" > "$TMP/f2/notes.md"
if grep -q "$DRIVE:.$HOMEDIR.someone" "$TMP/f2/notes.md"; then
  pass "case 2 fixture really contains the path"
else
  fail "case 2 fixture was not written correctly — the negative case cannot fire"
fi
neg "planted user path" "$TMP/f2"

# case 3: a denylisted project name inside a file git treats as BINARY.
# Written via node because POSIX printf cannot portably emit a NUL byte. This is the
# case that would have caught the real leak.
mkdir -p "$TMP/f3"
node -e "require('fs').writeFileSync(process.argv[1], Buffer.concat([Buffer.from('const mask = \''), Buffer.from([0]), Buffer.from('\';\nconst name = \"SecretProjectName\";\n')]))" "$TMP/f3/frozen.js"
if grep -qa "SecretProjectName" "$TMP/f3/frozen.js"; then
  pass "case 3 fixture really contains the term"
else
  fail "case 3 fixture was not written correctly"
fi
if grep -Iq "SecretProjectName" "$TMP/f3/frozen.js" 2>/dev/null; then
  fail "case 3 fixture is not binary to grep — the regression it guards cannot occur"
else
  pass "case 3 fixture is binary to text tools (grep -I skips it, as git grep did)"
fi
neg "denylisted name in a binary file" "$TMP/f3" "SecretProjectName"

# case 4: a credential-shaped string
mkdir -p "$TMP/f4"
printf 'token = ghp_%s\n' "0123456789abcdefghijklmnopqrstuvwxyz" > "$TMP/f4/config.txt"
neg "planted credential" "$TMP/f4"

# case 5: a clean fixture must NOT fail — otherwise every case above passes vacuously
mkdir -p "$TMP/f5"
printf 'nothing to see here\ncontact t@test.local\n' > "$TMP/f5/readme.md"
O5="$(SANITIZE_FIXTURE_DIR="$TMP/f5" node "$CHECKER" 2>&1)"; R5=$?
if [ "$R5" -eq 0 ]; then
  pass "clean fixture: checker exits 0 (rules are not matching everything)"
else
  echo "$O5"
  fail "clean fixture: checker exited $R5"
fi

if [ "$FAIL" -eq 0 ]; then echo "== ALL PUBLICATION-HYGIENE CHECKS PASSED =="; else echo "== PUBLICATION-HYGIENE CHECKS FAILED =="; fi
exit $FAIL
