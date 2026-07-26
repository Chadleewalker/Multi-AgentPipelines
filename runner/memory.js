// The memory "In" channel — DESIGN.md §3.6. At workspace prep the runner exports the
// target project's Beads memories to `<runDir>/memory.md`, beside `issue.md`, as the
// container-side mirror of `bd prime`. Read through the bd layer against
// cfg.targetRepoPath (the canonical working copy, §4.12) — never the task clone, and
// never by the container, which has no bd at all (§4.10, sole-writer rule).
//
// The "Out" channel is the mirror image: after the container exits the runner files the
// agent's proposed `memoryNotes` via `bd remember`, keyed by issue id (§3.6 audit trail).
// Agents propose; the host commits.
'use strict';
const fs = require('fs');
const path = require('path');
const { bd, bdJson } = require('./bd');

const HEADER = '# Project memory';
const EMPTY = '(no memories recorded)';

// status.schema.json's bounds on memoryNotes, re-enforced here: the file is written by
// the agent, so the host never trusts it to have respected its own schema.
const MAX_NOTES = 20;
const MAX_CHARS = 500;

// bd 1.1.0's `bd memories --json` returns one object whose every key except
// schema_version is a memory: key -> text.
function toLines(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return [];
  return Object.entries(data)
    .filter(([k]) => k !== 'schema_version')
    .map(([k, v]) => `- ${k}: ${String(v).replace(/[\r\n]+/g, ' ').trim()}`);
}

// Always writes memory.md; never throws. A bd failure is non-fatal to workspace prep —
// the caller logs and continues, because a missing memory export must not cost a run.
function exportMemory(cfg, runDir) {
  const file = path.join(runDir, 'memory.md');
  const write = (body) => {
    try {
      fs.writeFileSync(file, `${body}\n`);
      return null;
    } catch (e) {
      return e.message || 'memory.md write failed';
    }
  };

  let res;
  try {
    res = bdJson(cfg, ['memories']);
  } catch (e) {
    res = { ok: false, error: (e && e.message) || 'bd memories failed' };
  }

  if (!res || !res.ok) {
    write(EMPTY);
    return { ok: false, error: ((res && res.error) || 'bd memories failed').trim() || 'bd memories failed' };
  }

  const lines = toLines(res.data);
  const writeErr = write(lines.length ? [HEADER, ...lines].join('\n') : EMPTY);
  if (writeErr) return { ok: false, error: writeErr };
  // `count` is the point of the return value, not decoration: a successful export of
  // ZERO memories is indistinguishable from a healthy one by `ok` alone, and this
  // channel is fail-safe by design — if `bd memories` ever starts returning nothing
  // (schema change, wrong DB path, a bd upgrade), every container silently receives
  // the "(no memories recorded)" marker with no error anywhere. That is precisely how
  // model pinning (v1.2) recorded nothing for months. The caller logs this.
  return { ok: true, count: lines.length };
}

// The "Out" channel (§3.6): file each proposed note into project memory as the sole
// Beads writer (§4.10). Keys are `<issueId>-note-<n>` (1-based) — the issue id is the
// audit trail, and because `bd remember` updates a key in place, re-running the same
// issue overwrites its notes instead of accumulating duplicates.
//
// Never throws and never changes a task's outcome (the docsPhaseError posture): a bd
// failure is recorded in `errors` and the run continues. Missing or empty memoryNotes
// is a silent no-op with zero bd invocations.
function fileMemoryNotes(cfg, issueId, status) {
  const notes = status && Array.isArray(status.memoryNotes) ? status.memoryNotes : [];
  const errors = [];
  let filed = 0;
  if (!notes.length) return { filed, errors };

  const id = String(issueId || (status && status.issueId) || 'unknown');
  notes.slice(0, MAX_NOTES).forEach((note, i) => {
    const text = String(note == null ? '' : note).slice(0, MAX_CHARS);
    if (!text.trim()) return;                        // nothing to remember
    const key = `${id}-note-${i + 1}`;
    let r;
    try {
      r = bd(cfg, ['remember', text, '--key', key]);
    } catch (e) {
      errors.push(`${key}: ${(e && e.message) || 'bd remember failed'}`);
      return;
    }
    if (!r || r.status !== 0) {
      const why = ((r && (r.stderr || r.stdout)) || (r && r.error && r.error.message) || 'bd remember failed');
      errors.push(`${key}: ${String(why).trim() || 'bd remember failed'}`);
      return;
    }
    filed += 1;
  });

  return { filed, errors };
}

module.exports = { exportMemory, fileMemoryNotes };
