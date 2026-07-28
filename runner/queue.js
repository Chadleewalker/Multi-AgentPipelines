// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// Beads queue integration — DESIGN.md §4.10, §4.11, §4.12 (T12).
// The host runner is the SOLE Beads writer. Task order: the ready queue (open,
// unblocked, dependencies satisfied), ranked by priority (0 = highest), FIFO within
// the same priority. Terminal transitions come from the §4.11 outcome table.
'use strict';
const { bd, bdJson } = require('./bd');
const { specConcerns, oneLine } = require('./concerns');

// §4.11 outcome table: exit code -> {report status, Beads status}. 'killed' is the
// host-observed wall-clock kill, which produces no exit code.
const OUTCOMES = {
  0: { status: 'done', beads: 'closed' },          // refined to 'partial' via verify.json
  10: { status: 'stuck', beads: 'blocked' },
  11: { status: 'tampered', beads: 'blocked' },
  20: { status: 'paused', beads: null },           // stays in_progress; runner parks it
  30: { status: 'failed', beads: 'blocked' },
  killed: { status: 'failed', beads: 'blocked' },
};

function outcomeFor(exitCode, verify) {
  const key = exitCode === 'killed' ? 'killed' : Number(exitCode);
  const base = OUTCOMES[key] || OUTCOMES[30];
  // done vs partial is decided by verify.json, not by the exit code (§4.11).
  if (base.status === 'done' && verify && verify.regressions === 'fail') {
    return { status: 'partial', beads: 'closed' };
  }
  return { ...base };
}

// Types the runner never runs (§3.1, §4.12). A DENY-LIST, not an allow-list: bd also
// has bug, feature, chore and decision, and the runner drains all of them. Admitting
// only 'task' would make a legitimately-typed issue carrying a full spec vanish from
// every run with nothing to say why.
const EXCLUDED_TYPES = new Set(['epic']);

// The type as bd reports it, normalised for comparison. Absent, null or empty comes
// back as '' — which no excluded name matches, so such an entry is KEPT (§4.12
// back-compat: failing closed on a missing field would drain nothing at all against an
// older bd, the catastrophic direction).
function typeOf(issue) {
  const t = issue && issue.issue_type;
  return typeof t === 'string' ? t.trim().toLowerCase() : '';
}

// Ready work: bd's own blocker-aware semantics (verified in T2), then our ordering.
// Returns the survivors plus the entries filtered out by type, so the caller can name
// them in the queue-summary line — a skip nobody can see is the silent-failure family
// this design has already paid for.
function readyQueue(cfg) {
  const res = bdJson(cfg, ['ready']);
  if (!res.ok) return { ok: false, error: res.error };
  const entries = Array.isArray(res.data) ? res.data : [];
  const skipped = entries.filter((i) => EXCLUDED_TYPES.has(typeOf(i)));
  const issues = entries.filter((i) => !EXCLUDED_TYPES.has(typeOf(i))).sort((a, b) => {
    const pa = a.priority ?? 2;
    const pb = b.priority ?? 2;
    if (pa !== pb) return pa - pb;                                   // 0 = highest first
    return String(a.created_at || '').localeCompare(String(b.created_at || '')); // FIFO
  });
  return { ok: true, issues, skipped };
}

const describe = (i) => `${i.id} (${typeOf(i) || 'untyped'})`;

// The run's queue-summary line, built here rather than inline in run.js so it can be
// tested at all: run.js only reaches it after loadToken and the Docker preflight, which
// no Docker-free test can execute (same move repo-dhp made with shouldFileMemory).
// The historic prefix is load-bearing — scripts/test-runner-queue.sh greps it at six
// sites — so both clauses are APPENDED, never woven into it.
function queueSummary(issues, skipped) {
  const list = Array.isArray(issues) ? issues : [];
  const out = Array.isArray(skipped) ? skipped : [];
  let line = `ready queue: ${list.length} task(s) — ${list.map((i) => i.id).join(', ') || '(empty)'}`;
  if (out.length) {
    line += `; skipped ${out.length} by type: ${out.map(describe).join(', ')}`;
  }
  // Kept entries that are not plain tasks are named too: the deny-list means the runner
  // will happily run a bug or a chore, and a reviewer should see that it did.
  const nonTask = list.filter((i) => typeOf(i) && typeOf(i) !== 'task');
  if (nonTask.length) {
    line += `; running ${nonTask.length} non-task: ${nonTask.map(describe).join(', ')}`;
  }
  return line;
}

function claim(cfg, issueId) {
  return bd(cfg, ['update', issueId, '--status', 'in_progress']).status === 0;
}

// Export the issue for the container: read-only file mounted at .run/issue.md (§4.10).
// The container never talks to Beads.
function exportIssue(cfg, issueId) {
  const res = bdJson(cfg, ['show', issueId]);
  if (!res.ok) return { ok: false, error: res.error };
  const i = Array.isArray(res.data) ? res.data[0] : res.data;
  if (!i) return { ok: false, error: `issue ${issueId} not found` };
  const md = [
    `# ${i.id}: ${i.title || ''}`,
    '',
    i.description || '',
    '',
    '## Acceptance criteria',
    i.acceptance_criteria || '(none recorded)',
    '',
    '## Design reference',
    i.design || '(none recorded)',
    '',
  ].join('\n');
  return { ok: true, markdown: md, issue: i };
}

// Terminal write-back after a container exits (§4.10: notes travel via the status file).
function finish(cfg, issueId, outcome, notes) {
  for (const n of notes.filter(Boolean)) bd(cfg, ['note', issueId, n]);
  if (!outcome.beads) return;                       // paused: leave in_progress
  if (outcome.beads === 'closed') bd(cfg, ['close', issueId]);
  else bd(cfg, ['update', issueId, '--status', outcome.beads]);
}

// Attempt-log line from the container's status file (§4.11).
// memoryIn is the count exported into the container (§3.6 In channel): a number, or
// null when the export failed. Recorded next to the outgoing notes so both halves of
// the channel are visible on the issue at review time — an In channel that quietly
// stops delivering is otherwise invisible, since an empty export still succeeds.
function attemptNotes(runId, outcome, status, memoryIn) {
  const lines = [`run ${runId}: outcome ${outcome.status}`];
  for (const a of (status && status.attempts) || []) {
    lines.push(`  attempt ${a.number}: ${a.verifierResult} at ${a.timestamp}`);
  }
  if (status && status.stuckState) lines.push(`  stuck: ${status.stuckState}`);
  if (status && status.rateLimitResetAt) lines.push(`  paused until ${status.rateLimitResetAt}`);
  if (status && status.docsPhaseError) lines.push(`  docs: ${status.docsPhaseError}`);
  // Proposed memory notes are visible at review — that is where the §3.6 promotion rule
  // is applied (a note that keeps recurring graduates into repo files).
  if (status && Array.isArray(status.memoryNotes) && status.memoryNotes.length) {
    lines.push(`  memory notes: ${status.memoryNotes.length}`);
  }
  if (memoryIn === null) lines.push('  memory in: export failed');
  else if (typeof memoryIn === 'number') lines.push(`  memory in: ${memoryIn}`);
  // Spec concerns LAST (§3.7): it is the only multi-line entry, so putting it above the
  // compact facts would bury them under a wall of text. Unlike memory notes, which log a
  // count alone, each concern carries its full text — a memory note is an idea, a concern
  // is an accusation about the spec, and for a stuck task (no PR, and `runs/` ages out)
  // the Beads issue is the only artifact a human still has in a month. The bounds are
  // concerns.js's, never re-stated here; evidence only, so this cannot move an outcome.
  const raised = specConcerns(status);
  if (raised.length) {
    lines.push(`  spec concerns: ${raised.length}`);
    for (const c of raised) lines.push(`    - ${oneLine(c)}`);
  }
  return [lines.join('\n')];
}

module.exports = {
  readyQueue, queueSummary, claim, exportIssue, finish, outcomeFor, attemptNotes, OUTCOMES,
};
