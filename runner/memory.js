// The memory "In" channel — DESIGN.md §3.6. At workspace prep the runner exports the
// target project's Beads memories to `<runDir>/memory.md`, beside `issue.md`, as the
// container-side mirror of `bd prime`. Read through the bd layer against
// cfg.targetRepoPath (the canonical working copy, §4.12) — never the task clone, and
// never by the container, which has no bd at all (§4.10, sole-writer rule).
'use strict';
const fs = require('fs');
const path = require('path');
const { bdJson } = require('./bd');

const HEADER = '# Project memory';
const EMPTY = '(no memories recorded)';

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
  return { ok: true };
}

module.exports = { exportMemory };
