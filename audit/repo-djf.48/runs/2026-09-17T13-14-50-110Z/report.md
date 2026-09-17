# Run report — 2026-09-17T13-14-50-110Z

Started 2026-09-17T13:14:50.111Z · finished 2026-09-17T13:34:05.007Z
Target: `https://github.com/Chadleewalker/Multi-AgentPipelines.git`

**1 task(s)**: 1 partial

**Spec concerns: 1 raised by 1 of 1 tasks.** Evidence only — none of them changed an outcome above (DESIGN.md §3.7); a spec may be changed in a planning session and nowhere else.

Ordered by how much scrutiny each item needs.

## repo-djf.49 — PARTIAL — acceptance passed, regressions failed

**Retain and safely resume an owned failed green proof**

- Branch: `task/repo-djf.49` (not pushed — completion failed)
- Recovery workspace: `<redacted-host-path>`
- Attempts: 1
- Active time: 1138s
- Diff: 185 lines
- Model: claude-opus-5

**⚠ Spec concern raised (1)** — the agent believes the frozen spec or its tests are wrong. This did not affect the outcome above (DESIGN.md §3.7); changing a spec is legal in a planning session and nowhere else.

> repo-djf.49's own frozen suite blocks the mandatory regression profile at scripts/test-sanitize.sh, and no run can fix it. tests/acceptance/repo-djf.49/guard.js:48 and test.js:119 both set git config user.email to 'fixture@repo-djf49.test'; the publication-hygiene checker's real-email rule matches it, so test-ci.sh exits there and the nine suites after it (spec-brief, session-guard, spec-lint, sweep-assertions, sweep-hygiene, trace, verdict, verify-buffer, worktree) never run. Both the suite files and scripts/test-sanitize.sh are frozen paths. Confirmed identical at the fork point (07923b0) with the working tree stashed, so it predates this implementation. Same family as repo-45g-note-7 and repo-djf.41-note-3. I ran those nine suites directly instead: all nine pass. Suggested fix for a future freeze: use an address the checker does not read as real (the existing repo-7a0 precedent builds such fixture values from components), or add the rule's exemption for *.test fixture addresses.

**What changed**

An owned green proof that exhausts its bounded attempts, or is interrupted by a recoverable non-usage-limit fault after preparation, is now retained as resumable instead of swept: `scripts/prove-tests.js` re-reads container ownership out of band at that decision, and only an intact owner record and marker authorize it to rewrite the marker to the distinct state `unfinished` and report an explicit boolean `retained` — missing, mismatched, malformed or symlinked ownership, tamper, and a marker write that cannot be read back all report `retained: false`, rewrite no marker, follow no reparse point and authorize no recursive cleanup, while only a successful gate still writes `proven`. A standalone `--resume-probe <dir>` runs under the same target lock, brief read and exit codes as the plain command and reaches the existing six-dimension identity validation — issue, source worktree, suite bytes, author HEAD, baseline manifest and ownership — before any agent launch or gate, with `--skip-agent` re-gating without a model launch or a rebuilt RED, running protected-tree invariants before and after exactly one two-direction gate. CLI refusal diagnostics are bounded to a single reason line, and `--skip-agent` without `--resume-probe` is refused outright. Documentation follows the code: DESIGN.md §3.2 and change-log row `repo-djf-49-retained-proof` in the implementation commit, plus the operator-facing retention and resume/re-gate paths added here to PLANNING.md and `docs/control-plane.md`.

**Verification evidence**

- Acceptance: **pass**
- Regressions: **fail**

```
dalone command and refuses under a live competing owner before Beads or the retained probe are touched
[test] PASS T10a C3,C5(identity dimension: issue, exact cleanup) --resume-probe refuses an issue mismatch before any agent launch or gate, untouched
[test] PASS T10b C3,C5(identity dimension: source worktree, exact cleanup) --resume-probe refuses a source-worktree mismatch before any agent launch or gate, untouched
[test] PASS T10c C3,C5(identity dimension: suite bytes, exact cleanup) --resume-probe refuses a suite-bytes mismatch before any agent launch or gate, untouched
[test] PASS T10d C3,C5(identity dimension: author HEAD, exact cleanup) --resume-probe refuses an author-HEAD mismatch before any agent launch or gate, untouched
[test] PASS T10e C3,C5(identity dimension: baseline manifest, exact cleanup) --resume-probe refuses a baseline-manifest mismatch before any agent launch or gate, untouched
[test] PASS T10f C3,C5(identity dimension: ownership, exact cleanup) --resume-probe refuses an ownership-loss mismatch before any agent launch or gate, untouched
[test] PASS T11 C3,C5(success) --skip-agent never launches a model and runs invariants before and after exactly one two-direction gate, succeeding directly from a matching retained probe
[test] PASS T12 C5(bounded diagnostics) a resume refusal reported through the CLI is bounded, names the real reason, and leaks no host path or raw OS error text
[test] PASS 17/17 focused checks
PASS: tests/acceptance/repo-djf.49//test.js
```

**Attempt notes**

```
run 2026-09-17T13-14-50-110Z: outcome partial
  attempt 1: pass at 2026-09-17T13:26:59.542Z
  memory notes: 4
  SPEC CONCERNS RAISED: 1 — see the run report
  memory in: 275
completion pending: publication incomplete: required regression gate did not pass (fail); recover from workspace <redacted-host-path>
```

**Error:** publication incomplete: required regression gate did not pass (fail)

---

_Generated from the run manifest and git. Regenerating produces an identical file; never edit by hand._
