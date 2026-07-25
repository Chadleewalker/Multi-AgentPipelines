// Per-run log folder + trace IDs — DESIGN.md §4.12 (T11).
// Everything a run produces lives under runs/<run-timestamp>/ (git-ignored):
// run.log, per-task logs, collected status/verify files, run.json, report.md.
'use strict';
const fs = require('fs');
const path = require('path');

function startRun(repoRoot, stamp) {
  const runId = stamp || new Date().toISOString().replace(/[:.]/g, '-').replace('Z', 'Z');
  const dir = path.join(repoRoot, 'runs', runId);
  fs.mkdirSync(dir, { recursive: true });
  const logFile = path.join(dir, 'run.log');

  const write = (level, traceId, msg) => {
    const line = `${new Date().toISOString()} ${level} [${traceId}] ${msg}`;
    fs.appendFileSync(logFile, line + '\n');
    if (level === 'ERROR') console.error(line); else console.log(line);
  };

  return {
    runId,
    dir,
    logFile,
    // Trace ID links every line and artifact back to its Beads issue (§4.10).
    trace: (issueId) => `${runId}/${issueId}`,
    info: (traceId, msg) => write('INFO', traceId, msg),
    error: (traceId, msg) => write('ERROR', traceId, msg),
    taskDir(issueId) {
      const d = path.join(dir, 'tasks', issueId);
      fs.mkdirSync(d, { recursive: true });
      return d;
    },
  };
}

module.exports = { startRun };
