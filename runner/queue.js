// Beads queue integration — DESIGN.md §4.10, §4.11, §4.12 (T12).
// The host runner is the SOLE Beads writer. Task order: the ready queue (open,
// unblocked, dependencies satisfied), ranked by priority (0 = highest), FIFO within
// the same priority. Terminal transitions come from the §4.11 outcome table.
'use strict';
const { bd, bdJson } = require('./bd');

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

// Ready work: bd's own blocker-aware semantics (verified in T2), then our ordering.
function readyQueue(cfg) {
  const res = bdJson(cfg, ['ready']);
  if (!res.ok) return { ok: false, error: res.error };
  const issues = [...res.data].sort((a, b) => {
    const pa = a.priority ?? 2;
    const pb = b.priority ?? 2;
    if (pa !== pb) return pa - pb;                                   // 0 = highest first
    return String(a.created_at || '').localeCompare(String(b.created_at || '')); // FIFO
  });
  return { ok: true, issues };
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
function attemptNotes(runId, outcome, status) {
  const lines = [`run ${runId}: outcome ${outcome.status}`];
  for (const a of (status && status.attempts) || []) {
    lines.push(`  attempt ${a.number}: ${a.verifierResult} at ${a.timestamp}`);
  }
  if (status && status.stuckState) lines.push(`  stuck: ${status.stuckState}`);
  if (status && status.rateLimitResetAt) lines.push(`  paused until ${status.rateLimitResetAt}`);
  if (status && status.docsPhaseError) lines.push(`  docs: ${status.docsPhaseError}`);
  return [lines.join('\n')];
}

module.exports = { readyQueue, claim, exportIssue, finish, outcomeFor, attemptNotes, OUTCOMES };
