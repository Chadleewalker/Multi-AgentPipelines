#!/usr/bin/env bash
# Copyright 2026 Chad Walker
# SPDX-License-Identifier: Apache-2.0

# T17 acceptance checks (V1 backlog T17; DESIGN.md 4.9, 4.12).
# Ordering, schema conformance, content, and byte-identical regeneration are checked
# against a synthetic multi-outcome manifest (fast, deterministic); a real end-to-end
# run is T21's job.
# Run from Git Bash:  bash scripts/test-report.sh
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
FAIL=0
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; FAIL=1; }
trap 'rm -rf "$TMP"' EXIT

echo "== T17 checks =="

# --- Synthetic run covering every outcome, deliberately out of scrutiny order ---
node -e '
const { writeManifest, writeReport } = require(process.argv[1] + "/runner/report");
const dir = process.argv[2];
const tasks = [
  { issueId: "i-done1", title: "clean pass", outcome: "done", exitCode: 0, branch: "task/i-done1",
    pushed: true, prUrl: "https://example.test/pr/1", attempts: 1, pauses: 0, activeSeconds: 12,
    diffLines: 4, changeSummary: "Added the widget.",
    // §3.7 on a FIRST-TRY DONE on purpose: that outcome sorts last, so this is the place a
    // concern is most likely to go unread. The first one ever raised in a real run was here.
    specConcerns: ["the frozen test asks for two contradictory things", "the fixture path is wrong"],
    verification: { acceptance: "pass", regressions: "pass" }, attemptNotes: ["run x: outcome done"] },
  { issueId: "i-retry", title: "passed on retry", outcome: "done", exitCode: 0, branch: "task/i-retry",
    pushed: true, prUrl: "https://example.test/pr/2", attempts: 3, pauses: 1, activeSeconds: 90,
    diffLines: 40, changeSummary: "Fixed it eventually.",
    verification: { acceptance: "pass", regressions: "absent" }, attemptNotes: ["run x: outcome done"] },
  { issueId: "i-fail", title: "internal error", outcome: "failed", exitCode: 30, branch: "task/i-fail",
    pushed: false, prUrl: null, attempts: 0, pauses: 0, activeSeconds: 3, diffLines: 0,
    error: "container died", attemptNotes: ["run x: outcome failed"] },
  { issueId: "i-part", title: "regressions broke", outcome: "partial", exitCode: 0, branch: "task/i-part",
    pushed: true, prUrl: "https://example.test/pr/3", attempts: 1, pauses: 0, activeSeconds: 20,
    diffLines: 9, changeSummary: "Shipped it.",
    verification: { acceptance: "pass", regressions: "fail", evidence: "2 regression tests red" },
    attemptNotes: ["run x: outcome partial"] },
  { issueId: "i-stuck", title: "never converged", outcome: "stuck", exitCode: 10, branch: "task/i-stuck",
    pushed: true, prUrl: null, attempts: 3, pauses: 0, activeSeconds: 300, diffLines: 15,
    stuckState: "bailed after 3 failed verification attempts",
    verification: { acceptance: "fail", regressions: "absent", evidence: "assertion failed: out.txt missing" },
    attemptNotes: ["run x: outcome stuck"] },
  { issueId: "i-tamp", title: "edited frozen tests", outcome: "tampered", exitCode: 11, branch: "task/i-tamp",
    pushed: true, prUrl: null, attempts: 1, pauses: 0, activeSeconds: 8, diffLines: 2,
    verification: { acceptance: "tampered", regressions: "absent" }, attemptNotes: ["run x: outcome tampered"] },
  { issueId: "i-recover", title: "push rejected", outcome: "done", exitCode: 0, branch: "task/i-recover",
    pushed: false, prUrl: null, attempts: 1, pauses: 0, activeSeconds: 10, diffLines: 5,
    recoveryWorkspace: "C:/tmp/pipeline-i-recover", error: "publication incomplete: push rejected",
    verification: { acceptance: "pass", regressions: "pass" }, attemptNotes: ["run x: outcome done"] },
];
const { manifest } = writeManifest(dir, { runId: "t17-synth", startedAt: "2026-07-25T20:00:00Z",
  finishedAt: "2026-07-25T21:00:00Z", targetRepo: "https://example.test/repo.git", tasks });
writeReport(dir, manifest);
' "$ROOT" "$TMP"

MAN="$TMP/run.json"; REP="$TMP/report.md"
[ -f "$MAN" ] && pass "run.json manifest written" || { fail "no manifest"; exit 1; }
[ -f "$REP" ] && pass "report.md written" || { fail "no report"; exit 1; }

# 1. Manifest conforms to its schema (the frozen contract the report reads).
AJV=(npx.cmd --yes -p ajv-formats -p ajv-cli ajv -c ajv-formats)
command -v npx.cmd >/dev/null 2>&1 || AJV=(npx --yes -p ajv-formats -p ajv-cli ajv -c ajv-formats)
if "${AJV[@]}" validate --spec=draft2020 -s "$ROOT/schemas/run.schema.json" -d "$MAN" >/dev/null 2>&1; then
  pass "manifest validates against run.schema.json"
else
  fail "manifest fails its own schema"
fi

# 2. Scrutiny ordering: tampered > stuck > partial > failed > done-with-retries > done-first-try.
ORDER=$(grep -o '^## [a-z0-9-]*' "$REP" | sed 's/## //' | tr '\n' ' ')
[ "$ORDER" = "i-tamp i-stuck i-part i-fail i-retry i-recover i-done1 " ] \
  && pass "report ordered by scrutiny needed" || fail "ordering wrong: $ORDER"
MORDER=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).tasks.map(t=>t.issueId).join(" "))' "$MAN")
[ "$MORDER" = "i-tamp i-stuck i-part i-fail i-retry i-recover i-done1" ] \
  && pass "manifest itself is stored in scrutiny order" || fail "manifest order wrong: $MORDER"

# 3. done-with-retries outranks done-first-try (the tie-break inside 'done').
awk '/^## i-retry/{r=NR} /^## i-done1/{d=NR} END{exit !(r<d)}' "$REP" \
  && pass "done-with-retries sorts above done-first-try" || fail "done tie-break wrong"

# 4. Every task carries the five report fields (4.9).
for id in i-done1 i-stuck i-part i-tamp; do
  SEC=$(awk "/^## $id /,/^## [a-z-]*\$/" "$REP")
  echo "$SEC" | grep -q "Branch:" && echo "$SEC" | grep -q "What changed" \
    && echo "$SEC" | grep -q "Verification evidence" && echo "$SEC" | grep -q "Attempt notes" \
    || { fail "$id missing report fields"; break; }
done
grep -q "Branch:" "$REP" && grep -q "What changed" "$REP" && grep -q "Verification evidence" "$REP" \
  && grep -q "Attempt notes" "$REP" && pass "status/branch/changes/evidence/notes present per task" || fail "report fields missing"

# 5. Outcome labels are self-explanatory, and links behave per outcome.
grep -q "PARTIAL — acceptance passed, regressions failed" "$REP" && pass "partial labelled with its meaning" || fail "partial label missing"
grep -q "TAMPERED — frozen tests were modified" "$REP" && pass "tampered labelled" || fail "tampered label missing"
grep -q "STUCK — bailed after 3 attempts" "$REP" && pass "stuck labelled" || fail "stuck label missing"
grep -q "PR: https://example.test/pr/3" "$REP" && pass "PR links shown where a PR exists" || fail "PR link missing"
grep -q "PR: none — review the branch directly" "$REP" && pass "pushed-but-unPR'd branches flagged for direct review" || fail "branch-only review note missing"
grep -q "not pushed — no commits" "$REP" && pass "empty branch marked not pushed" || fail "no-commit note missing"
grep -q "bailed after 3 failed verification attempts" "$REP" && pass "stuck state surfaced" || fail "stuck state missing"
grep -q "Rate-limit pauses: 1" "$REP" && pass "rate-limit pauses reported" || fail "pause count missing"
grep -q "7 task(s)" "$REP" && pass "summary counts tasks" || fail "summary missing"

# A publication/Beads settlement failure is not an empty branch. The report must name both
# the failure and the retained recovery source so an unattended run can be resumed safely.
node -e '
const { renderReport } = require(process.argv[1] + "/runner/report");
process.stdout.write(renderReport({ runId: "recover", startedAt: "2026-08-28T00:00:00Z",
  finishedAt: "2026-08-28T00:01:00Z", targetRepo: "https://example.test/repo.git", tasks: [{
    issueId: "i-recover", outcome: "done", branch: "task/i-recover", pushed: false,
    prUrl: null, recoveryWorkspace: "C:/tmp/pipeline-i-recover", error: "publication incomplete: push rejected"
  }] }));
' "$ROOT" > "$TMP/recovery-report.md"
grep -q "not pushed — completion failed" "$TMP/recovery-report.md" \
  && grep -q 'Recovery workspace: `C:/tmp/pipeline-i-recover`' "$TMP/recovery-report.md" \
  && grep -q "publication incomplete: push rejected" "$TMP/recovery-report.md" \
  && pass "recoverable completion failure names its cause and retained workspace" \
  || fail "recoverable completion failure is not actionable in the report"

# 5b. Spec concerns reach the report (§3.7). Until this existed the host-side half of the
# channel was unbuilt and a concern reached only the status file — the agent could say "this
# spec is wrong" and no artifact a reviewer opens would carry it.
grep -q "Spec concerns raised (2)" "$REP" \
  && pass "spec concerns surfaced with their count" || fail "spec concerns missing from report"
grep -q "the frozen test asks for two contradictory things" "$REP" \
  && grep -q "the fixture path is wrong" "$REP" \
  && pass "every concern's full text is in the report" || fail "concern text truncated or dropped"
# Above the change summary, not below it: the reason for the section is that it is READ.
awk '/^## i-done1/{s=1} s&&/Spec concerns raised/{c=NR} s&&/^\*\*What changed/{w=NR; exit} END{exit !(c&&w&&c<w)}' "$REP" \
  && pass "concerns render above the change summary" || fail "concerns buried below the summary"
# EVIDENCE, NEVER A GATE (§3.5). The task carrying two concerns is a first-try `done`, and it
# must still sort dead last — a concern that could reorder the report would be a soft gate.
[ "$(grep -o '^## [a-z0-9-]*' "$REP" | tail -1)" = "## i-done1" ] \
  && pass "a concern does not change scrutiny order" || fail "concerns leaked into ordering"
grep -q "did not affect the outcome above" "$REP" \
  && pass "report states a concern changed nothing" || fail "concern disclaimer missing"

# 5c. And the PR body (§3.7), the artifact the person merging actually opens.
node -e '
const { buildPrBody } = require(process.argv[1] + "/runner/publish");
const body = buildPrBody({ issueMarkdown: "# spec", branch: "task/i-done1", runId: "t17-synth",
  outcome: { status: "done" }, verify: { acceptance: "pass", regressions: "pass" },
  status: { changeSummary: "Added the widget.", specConcerns: ["the frozen test is self-contradictory"] } });
const clean = buildPrBody({ issueMarkdown: "# spec", branch: "task/i-two", runId: "t17-synth",
  outcome: { status: "done" }, verify: { acceptance: "pass", regressions: "pass" },
  status: { changeSummary: "Added the widget." } });
const fail = (m) => { console.log("FAIL  " + m); process.exitCode = 1; };
if (!/Spec concern \(1\)/.test(body)) fail("PR body omits the concern heading");
else console.log("PASS  PR body carries the concern heading and count");
if (!body.includes("the frozen test is self-contradictory")) fail("PR body omits the concern text");
else console.log("PASS  PR body carries the concern text verbatim");
if (body.indexOf("Spec concern") > body.indexOf("## Change summary")) fail("PR body buries the concern below the summary");
else console.log("PASS  PR body puts the concern above the change summary");
if (/Spec concern/.test(clean)) fail("PR body invents a concern section when there are none");
else console.log("PASS  no concern section when none were raised");
' "$ROOT" || FAIL=1

# 5d. A task with no concerns gains no section at all (the common case stays unchanged).
awk '/^## i-part/,/^## i-fail/' "$REP" | grep -q "Spec concern" \
  && fail "concern section rendered for a task that raised none" \
  || pass "tasks without concerns are untouched"

# 6. Regeneration is byte-identical (4.9: generated, never hand-edited).
cp "$REP" "$TMP/first.md"; cp "$MAN" "$TMP/first.json"
node -e '
const { writeManifest, writeReport } = require(process.argv[1] + "/runner/report");
const m = JSON.parse(require("fs").readFileSync(process.argv[2] + "/first.json","utf8"));
const { manifest } = writeManifest(process.argv[2], m);
writeReport(process.argv[2], manifest);
' "$ROOT" "$TMP"
cmp -s "$TMP/first.md" "$REP" && pass "report regeneration is byte-identical" || fail "report not idempotent"
cmp -s "$TMP/first.json" "$MAN" && pass "manifest regeneration is byte-identical" || fail "manifest not idempotent"

# 7. Generated-not-edited marker, and no LLM involved.
grep -q "never edit by hand" "$REP" && pass "report marked generated" || fail "generated marker missing"
grep -q "claude" "$ROOT/runner/report.js" && fail "report generator invokes an LLM" || pass "report is deterministic scaffolding"

if [[ $FAIL -eq 0 ]]; then echo "== ALL T17 CHECKS PASSED =="; else echo "== T17 CHECKS FAILED =="; fi
exit $FAIL
