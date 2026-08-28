// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// Per-run log folder + trace IDs — DESIGN.md §4.12 (T11).
// Everything a run produces lives under runs/<run-timestamp>/ (git-ignored):
// run.log, per-task logs, collected status/verify files, run.json, report.md — and, since
// change-log rows `events-ledger-design` and `repo-qzy`, `events.jsonl`.
//
// ---- the ledger (§4.12, §5) ----------------------------------------------------------
// `events.jsonl` is `run.log`'s structured twin: ONE function appends both, from ONE
// timestamp, so the two records cannot disagree about what happened or when. That is the
// whole design. A second writer with its own clock would reintroduce exactly the drift the
// readers already suffer from parsing prose by regular expression.
//
// Three properties the rest of the system rests on:
//
//   * Every `run.log` line has exactly one ledger object with a string `msg`, in the same
//     order, carrying the same `ts`, `level`, `trace` and `msg`. A reader can therefore
//     join the two files by index without parsing either.
//   * A line whose caller named no event is `event: "log"` with empty `data`. Nothing here
//     infers an event from a message prefix: the prefix table is what the ledger exists to
//     replace, and inferring from it would move the fragility rather than remove it.
//   * Ledger-only facts (`event()`) carry `msg: null`, are never echoed to the console and
//     never reach `run.log`. That is what lets a later task record things too structured to
//     be prose without changing a byte of what a human reads.
//
// Appends are unbuffered and never rewrite: `appendFileSync` per event, one object per
// line, `\n` only. A run killed mid-write leaves a truncated last line and a wholly
// parseable prefix — which is the artifact an unattended overnight run most needs to leave.
'use strict';
const fs = require('fs');
const path = require('path');

// The trace is `<runId>/<issueId>` (§4.10), so the issue id is its tail — but only for a
// real task. `preflight` and `feed` are PSEUDO-tasks: run-level work that borrows the trace
// shape so its lines sort with everything else. Recording them as issue ids would invent
// two issues that do not exist in Beads, which is worse than the null they get instead.
const PSEUDO_TASKS = new Set(['preflight', 'feed']);

function issueIdOf(runId, trace) {
  if (typeof trace !== 'string' || !trace) return null;
  const prefix = `${runId}/`;
  if (!trace.startsWith(prefix)) return null;
  const tail = trace.slice(prefix.length);
  if (!tail || PSEUDO_TASKS.has(tail)) return null;
  return tail;
}

function startRun(repoRoot, stamp) {
  const runId = stamp || new Date().toISOString().replace(/[:.]/g, '-').replace('Z', 'Z');
  const dir = path.join(repoRoot, 'runs', runId);
  fs.mkdirSync(dir, { recursive: true });
  const logFile = path.join(dir, 'run.log');
  const eventsFile = path.join(dir, 'events.jsonl');

  // `msg === null` means ledger-only: no run.log line, no console echo. Every other call
  // writes both, from the single `ts` below.
  const write = (level, traceId, msg, ev) => {
    const ts = new Date().toISOString();
    if (msg !== null) {
      const line = `${ts} ${level} [${traceId}] ${msg}`;
      fs.appendFileSync(logFile, line + '\n');
      if (level === 'ERROR') console.error(line); else console.log(line);
    }
    const trace = typeof traceId === 'string' && traceId ? traceId : null;
    // JSON.stringify escapes any CR or LF inside a message, so one event is always one
    // line — a guarantee the truncation-tolerance above depends on.
    fs.appendFileSync(eventsFile, `${JSON.stringify({
      ts,
      level,
      runId,
      issueId: issueIdOf(runId, trace),
      trace,
      event: (ev && typeof ev.event === 'string' && ev.event) || 'log',
      msg: msg === null ? null : String(msg),
      data: (ev && ev.data && typeof ev.data === 'object') ? ev.data : {},
    })}\n`);
  };

  return {
    runId,
    dir,
    logFile,
    eventsFile,
    // Trace ID links every line and artifact back to its Beads issue (§4.10).
    trace: (issueId) => `${runId}/${issueId}`,
    // The third argument is OPTIONAL everywhere and always has been absent-safe: a call
    // site gains `{ event, data }` and nothing else, so the wording — and therefore every
    // existing reader — is untouched by naming a line.
    info: (traceId, msg, ev) => write('INFO', traceId, msg, ev),
    error: (traceId, msg, ev) => write('ERROR', traceId, msg, ev),
    // A fact with no prose form. INFO by construction: `event()` records what happened,
    // never that something went wrong — an error is a thing a human is told in words.
    event: (traceId, name, data) => write('INFO', traceId, null, { event: name, data: data || {} }),
    taskDir(issueId) {
      const d = path.join(dir, 'tasks', issueId);
      fs.mkdirSync(d, { recursive: true });
      return d;
    },
  };
}

module.exports = { startRun, issueIdOf };
