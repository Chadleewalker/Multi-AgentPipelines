#!/usr/bin/env node
// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// The batch marker reader — DESIGN.md §3.9 (change-log row `batch-ready-marker`).
//
// A planning session's last act (PLANNING.md step 8) is to write a batch marker at
// `runs/batches/<project>-<YYYY-MM-DD>.json`: the run config the batch is for, the instant
// its tests were frozen, the issue ids with titles in the intended priority order, and —
// optionally — the integration branch, the freeze commit, one line of intent and who
// approved it. The run then starts from a *different* session, on the word "go". This file
// is what that second session reads:
//
//   node scripts/batch.js pending          batches no run has touched since the freeze
//   node scripts/batch.js show [<stem>]    one marker, with a per-id worked breakdown
//
// FOUR PROPERTIES ARE LOAD-BEARING, and every decision below follows from one of them:
//
//   1. Deterministic scaffolding (hard rule 7). No LLM, and at most ONE subprocess in the
//      whole tool: marker reading and the pending join are node built-ins only, and §3.9's
//      reconciliation against the live queue spawns `bd … ready --json` exactly once, under
//      a bound, reading and never writing (hard rule 1). Where that one call cannot be made
//      or cannot be read, `show` says which half failed rather than printing a marker as if
//      the queue had agreed with it.
//   2. Pure reader (§5, hard rule 5's shape). It creates no file, edits no artifact and
//      mutates no marker; `pending` exits 0 whatever it finds, because it is a report.
//      A marker is immutable and there is no `launched` flag to stamp — "still pending" is
//      a JOIN computed from the run corpus at the moment the question is asked, which is
//      `scripts/verdict.js pending`'s move and inherits its best property: nothing to
//      forget to update.
//   3. Never a queue item. Nothing in `runner/` or `pipeline/` reads `runs/batches/`; the
//      marker records what was *intended*, Beads decides what runs, and when the two
//      disagree that is the finding rather than an error.
//   4. Host-only, and self-contained apart from two SHARED RULES it may not copy. The runs
//      root comes from `BATCH_RUNS_DIR` or from THIS FILE's location — never from the
//      working directory, since the launching session runs this from wherever it happens to
//      be — and the run config from `BATCH_CONFIG_DIR`, defaulting to the repo root the
//      same way. The two imports are `runner/bd.js`'s host-bd probe (`hostBdSpec`) with its
//      spawn bound (`spawnOptions`), and `runner/queue.js`'s epic deny-list
//      (`EXCLUDED_TYPES`, `typeOf`). Both are rules the RUNNER applies to the same queue,
//      and this reader's entire value is answering the question the runner is about to
//      answer — a second copy of either would drift from the original in silence.
//      Everything else is node built-ins, and nothing here reads `runner/config.js`:
//      `loadConfig` throws on unrelated missing keys, and a report must not die because a
//      config it only wanted one field from is incomplete for some other purpose.
//
// PINNED DECISIONS a future reader would otherwise re-litigate:
//
//   * The filename's date is NAMING ONLY; `frozenAt` is the clock (§3.9). A `YYYY-MM-DD`
//     compared against a UTC `startedAt` counts a run that happened before the freeze and
//     silently drops the batch from `pending` — precisely what this exists to prevent. The
//     stem pattern is therefore anchored at BOTH ends, `<project>-<YYYY-MM-DD>`, with the
//     project taken greedily: `orbit-lab-2026-08-19` is the project `orbit-lab`, not
//     `orbit`, and a file that is only a date is not a marker at all.
//   * A RUN'S CLOCK is `startedAt` from `run.json` when it parses, else the leading instant
//     on the first line of `run.log`. The second half is not a nicety: 74 of 272 run
//     directories in the real corpus have no `run.json` at all, so a join copied from
//     `verdict.js` — which skips a directory without a manifest, correctly, for its own
//     purpose — would report an interrupted run's batch as never launched.
//   * A run unreadable by BOTH counts as having worked the ids it names, labelled
//     `run-time-unknown`. That is the conservative direction: a false "pending" invites a
//     double launch, where a false "launched" merely sends someone to look.
//   * PENDING MEANS *NONE* of the batch's ids has been worked since the freeze, so a
//     half-drained batch leaves the list — *any* id having run answers the question
//     `pending` asks, which is "did this batch ever get launched". `show`'s per-id
//     breakdown is what keeps that visible rather than binary.
//   * `show` with NO ARGUMENT is the newest marker by `frozenAt`, LAUNCHED OR NOT. Newest
//     and newest-*pending* diverge the moment a batch runs, and a default that skipped a
//     launched batch would hide a double launch, which is the thing worth seeing most.
//   * A marker whose `frozenAt` will not parse is listed and labelled
//     `freeze-time-unknown`, never dropped and never guessed at, and it sorts last among
//     the pending — the same shape as `verdict.js`'s undated runs.
//   * Anything under `batches/` that is not a marker — a plain file, a name with no
//     project segment, truncated JSON, a JSON array — is skipped silently and never named
//     in the output. This is a report over a directory a human also writes into.
//   * THE RECONCILIATION IS THE POINT, not the confirmation (§3.9). The runner has no
//     picker: it drains whatever queue it finds, so an issue nobody meant to include simply
//     runs and a blocked one silently does not, and nothing else in the pipeline holds the
//     INTENT to compare the queue against. `show` therefore reports each of the marker's
//     ids as `ready` or `not-ready` and each queue entry the batch never named as a
//     `stray` — three literal tokens, one per line, no summary line repeating them.
//   * THE QUEUE IS READ AGAINST THE MARKER'S OWN RUN CONFIG. `run.json` records a git
//     remote and never a config name, so the `run.config.<project>.json` the marker names
//     is what has to be opened, for `targetRepoPath` and `bdTimeoutMs` alone, by plain
//     JSON parse. `-C <targetRepoPath>` is always in the argv, so which repo was consulted
//     is observable rather than assumed.
//   * EPIC PARENTS ARE FILTERED BEFORE ANYTHING IS CALLED A STRAY. `bd ready` returns them
//     by design and the runner drops them (`EXCLUDED_TYPES`), so reporting one would be a
//     false alarm at exactly the moment someone is deciding whether to launch.
//   * A BROKEN JOIN NAMES ITSELF. `unreconciled` never appears without exactly one reason:
//     `bd-unavailable` (no bd could be spawned at all — no host bd resolved, or the seam
//     names something unexecutable), `bd-unreadable` (bd ran and exited non-zero, printed
//     something that is not the expected array, or was killed at the bound), and
//     `run-config-absent` (the marker names a config this host does not have, or one with
//     no `targetRepoPath`). A degraded `show` prints no reconciled token and a reconciled
//     one prints no degraded term, because "which half failed" is the whole answer.
//   * BD'S OWN OUTPUT IS NEVER ECHOED. The reason and a short fixed detail are all that is
//     printed: a reader whose vocabulary can be forged by the text of an error message
//     cannot be read at a glance, which is the one thing this tool is for.
//
// Covered by tests/unit/batch.test.js through scripts/test-batch.sh (no containers, no
// network, no real `bd` — the sweep discovers it by glob). `BATCH_RUNS_DIR` re-aims the
// runs root and `BATCH_CONFIG_DIR` the config directory, the same shape as
// `VERDICT_RUNS_DIR` and `AUDIT_RUNS_DIR`.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
// The two shared rules (property 4). Nothing else in this repo is reached from here, and
// neither of these two modules is asked to RUN anything: `hostBdSpec` answers how host bd
// would be invoked, `spawnOptions` answers with what bound, and the queue pair answers
// which entries the runner would refuse to drain. The general helpers next to them are
// deliberately not used — their fallback when no host bd resolves starts a container per
// call, and a pure reader may not do that during a launch ritual.
const { hostBdSpec, spawnOptions } = require('../runner/bd.js');
const { EXCLUDED_TYPES, typeOf } = require('../runner/queue.js');

// The marker name, anchored at both ends. Greedy `.+` is what keeps a hyphenated project
// whole; the date group is fixed-width so a file that is *only* a date cannot match.
const MARKER_STEM = /^(.+)-(\d{4}-\d{2}-\d{2})$/;

// Direct children of the runs root that are never a run directory. `batches/` is this
// tool's own input, and the other two are the sweep's and the lock's.
const NOT_A_RUN = new Set(['batches', 'locks', 'sweeps']);

// The optional marker fields, in the order a human reads them. Present ones are printed;
// absent ones say nothing at all rather than printing an empty row.
const OPTIONAL_FIELDS = [
  ['integrationBranch', 'branch'],
  ['freezeCommit', 'freeze commit'],
  ['intent', 'intent'],
  ['approvedBy', 'approved by'],
];

const USAGE = [
  'usage:',
  '  node scripts/batch.js pending',
  '  node scripts/batch.js show [<project>-<YYYY-MM-DD>]',
  '',
  'The runs root is $BATCH_RUNS_DIR, else <script dir>/../runs; markers live in its',
  'batches/ subdirectory. show also reconciles the marker against the live queue of the',
  'run config it names, resolved from $BATCH_CONFIG_DIR, else the repo root.',
].join('\n');

// Exit codes, following scripts/verdict.js. Non-zero is the contract; which non-zero is an
// implementation choice, so the two readers agree rather than each inventing its own.
const EXIT_OK = 0;
const EXIT_USAGE = 2;     // the command as typed cannot mean anything
const EXIT_NOT_FOUND = 3; // well-formed, but names nothing under batches/

// ---- the runs root --------------------------------------------------------------------
// An empty or whitespace-only seam is treated as unset rather than as "the root is the
// empty path": an exported-but-blank variable is a shell accident, not a request.
function runsRoot(env = process.env) {
  const seam = env.BATCH_RUNS_DIR;
  if (typeof seam === 'string' && seam.trim()) return path.resolve(seam.trim());
  return path.resolve(__dirname, '..', 'runs');
}

const batchesDir = (root) => path.join(root, 'batches');

// ---- small readers --------------------------------------------------------------------
// Every one of these answers "absent" rather than throwing. All of these shapes exist in a
// real tree, and a crash here would make the report useless exactly when it matters.
function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

function readJsonObject(file) {
  const raw = readText(file);
  if (raw === null) return null;
  let value;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value;
}

function dirNames(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));
  } catch { return []; }
}

const nonEmptyString = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

// A marker may carry a nested object in an optional field (§3.9 permits it), so anything
// that is not a plain string is rendered rather than concatenated into `[object Object]`.
function render(value) {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

// ---- markers --------------------------------------------------------------------------
function issueRows(value) {
  if (!Array.isArray(value.issues)) return [];
  const rows = [];
  for (const issue of value.issues) {
    if (!issue || typeof issue !== 'object' || Array.isArray(issue)) continue;
    const id = nonEmptyString(issue.id);
    if (!id) continue;
    rows.push({ id, title: nonEmptyString(issue.title) || '' });
  }
  return rows;
}

// Newest freeze first; a marker whose freeze time will not parse sorts LAST and is never
// chosen over a dated one. The filename tie-break is ascending and is what makes two
// invocations over an unchanged tree produce identical output — `verdict.js`'s `byRecency`
// exactly, over a different clock.
function byFreeze(a, b) {
  if (a.frozenMs === null && b.frozenMs === null) return a.stem.localeCompare(b.stem);
  if (a.frozenMs === null) return 1;
  if (b.frozenMs === null) return -1;
  if (a.frozenMs !== b.frozenMs) return b.frozenMs - a.frozenMs;
  return a.stem.localeCompare(b.stem);
}

function readMarkers(root) {
  let entries;
  try {
    entries = fs.readdirSync(batchesDir(root), { withFileTypes: true });
  } catch {
    return []; // no batches/ yet — a host that has never planned a batch is not an error
  }
  const markers = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const stem = entry.name.slice(0, -'.json'.length);
    const named = MARKER_STEM.exec(stem);
    if (!named) continue; // `2026-07-04.json` has no project segment: not a marker name
    const value = readJsonObject(path.join(batchesDir(root), entry.name));
    if (!value) continue; // truncated, or not a JSON object — skipped, never named
    const frozenAt = nonEmptyString(value.frozenAt);
    const parsed = frozenAt === null ? NaN : Date.parse(frozenAt);
    markers.push({
      stem,
      project: named[1],
      fileDate: named[2],
      file: path.join(batchesDir(root), entry.name),
      runConfig: nonEmptyString(value.runConfig),
      frozenAt,
      frozenMs: Number.isNaN(parsed) ? null : parsed,
      issues: issueRows(value),
      optional: OPTIONAL_FIELDS
        .filter(([key]) => value[key] !== undefined && value[key] !== null)
        .map(([key, label]) => [label, render(value[key])]),
    });
  }
  markers.sort(byFreeze);
  return markers;
}

// ---- runs -----------------------------------------------------------------------------
// A run directory is any direct child that carries a manifest, a log or a tasks/ tree. The
// last two are what a run interrupted before it wrote `run.json` leaves behind, and that
// population is a quarter of the real corpus.
const TRACE_LINE = /^\S+ \S+ \[([^\]]*)\]/gm;

function leadingInstant(text) {
  if (text === null) return null;
  const firstLine = text.split(/\r?\n/, 1)[0] || '';
  const lead = /^\s*(\S+)/.exec(firstLine);
  if (!lead) return null;
  const parsed = Date.parse(lead[1]);
  return Number.isNaN(parsed) ? null : parsed;
}

// Every id the run names: its manifest's rows, its per-task directories, and every trace id
// in its log that is not the `preflight` pseudo-task.
function runIds(manifest, log, taskDirs) {
  const ids = new Set();
  if (manifest && Array.isArray(manifest.tasks)) {
    for (const task of manifest.tasks) {
      if (!task || typeof task !== 'object' || Array.isArray(task)) continue;
      const id = nonEmptyString(task.issueId);
      if (id) ids.add(id);
    }
  }
  for (const name of taskDirs) ids.add(name);
  if (log !== null) {
    TRACE_LINE.lastIndex = 0;
    for (const m of log.matchAll(TRACE_LINE)) {
      const trace = m[1];
      const slash = trace.indexOf('/');
      if (slash < 0) continue;
      const id = trace.slice(slash + 1).trim();
      if (id && id !== 'preflight') ids.add(id);
    }
  }
  return ids;
}

function readRuns(root) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return []; // a missing (or unreadable) root reads as empty
  }
  const runs = [];
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || NOT_A_RUN.has(entry.name)) continue;
    const dir = path.join(root, entry.name);
    const manifest = readJsonObject(path.join(dir, 'run.json'));
    const log = readText(path.join(dir, 'run.log'));
    const taskDirs = dirNames(path.join(dir, 'tasks'));
    if (!manifest && log === null && !taskDirs.length) continue;

    // The manifest's instant when it parses, else the log's opening one. Neither means the
    // run has no clock at all, which is handled where the join is computed, not here.
    let startedMs = null;
    if (manifest) {
      const parsed = Date.parse(nonEmptyString(manifest.startedAt) || '');
      if (!Number.isNaN(parsed)) startedMs = parsed;
    }
    if (startedMs === null) startedMs = leadingInstant(log);

    runs.push({
      runId: (manifest && nonEmptyString(manifest.runId)) || entry.name,
      dirName: entry.name,
      dir,
      startedMs,
      timeKnown: startedMs !== null,
      ids: runIds(manifest, log, taskDirs),
    });
  }
  return runs;
}

// ---- the join -------------------------------------------------------------------------
// A run counts against a freeze when it started at or after it — or when its clock cannot
// be read at all, which counts CONSERVATIVELY as having worked the ids it names. A dated
// run is preferred as the witness so `run-time-unknown` is reported only when it is the
// only thing that can be said.
function workedSince(runs, frozenMs) {
  const worked = new Map();
  for (const run of runs) {
    const counts = !run.timeKnown || frozenMs === null || run.startedMs >= frozenMs;
    if (!counts) continue;
    for (const id of run.ids) {
      const seen = worked.get(id);
      if (!seen || (!seen.timeKnown && run.timeKnown)) worked.set(id, run);
    }
  }
  return worked;
}

// Pending means NONE of the ids has been worked since the freeze. Two markers are pending
// without consulting a single run: one with no readable freeze time (listed and labelled,
// never dropped and never guessed at) and one naming no issues at all.
function isPending(marker, runs) {
  if (marker.frozenMs === null) return true;
  if (!marker.issues.length) return true;
  const worked = workedSince(runs, marker.frozenMs);
  return !marker.issues.some((issue) => worked.has(issue.id));
}

function markerLabels(marker) {
  const labels = [];
  if (marker.frozenMs === null) labels.push('freeze-time-unknown');
  if (!marker.issues.length) labels.push('no-issues');
  return labels;
}

// ---- the live queue (§3.9's reconciliation) ---------------------------------------------
// The config directory, resolved exactly like the runs root and for the same reason: the
// launching session types this command from wherever it happens to be, so the working
// directory is never consulted. A blank seam is a shell accident, not a request.
function configDir(env = process.env) {
  const seam = env.BATCH_CONFIG_DIR;
  if (typeof seam === 'string' && seam.trim()) return path.resolve(seam.trim());
  return path.resolve(__dirname, '..');
}

// The marker names a run config file; this reads it for TWO FIELDS and nothing else. Not
// `runner/config.js`'s loadConfig: that validates a whole run's worth of keys and throws on
// any missing one, which would turn a report into a crash over a field this tool never
// looks at. A name carrying a path separator is refused rather than resolved — a marker is
// a file a human writes, and `batches/` is not a place to reach out of.
function readRunConfig(marker, env = process.env) {
  const name = marker.runConfig;
  if (!name || name.includes('/') || name.includes('\\')) return null;
  const file = path.join(configDir(env), name);
  const value = readJsonObject(file);
  if (!value) return null;
  const targetRepoPath = nonEmptyString(value.targetRepoPath);
  if (!targetRepoPath) return null;
  return { file, targetRepoPath, bdTimeoutMs: value.bdTimeoutMs };
}

// The argv's leading element on the SEAM path, and why it exists. Seam stubs in this repo
// are .js files preloaded into `process.execPath` (a `#!/bin/sh` stub fails with EFTYPE on
// the Windows host), so the command spawned here is the node binary — and node's own CLI
// parser owns `-C`, which is the short form of `--conditions`. A bare `-C <path>` at the
// head of the argv is therefore eaten by node before the stub ever sees it, and the suite
// cannot observe which repo was consulted. Filling the program slot the way the host shim
// path fills it (with the resolved bd.js) puts `-C` past the first non-option argument,
// where every parser leaves it alone. The stub exits from its preload, so this slot is
// never opened.
const SEAM_PROGRAM_SLOT = 'bd';

// How to invoke bd for one read. The seam takes ABSOLUTE precedence over the host probe,
// matching every entry point in runner/bd.js — a suite that stubs it must not be able to
// reach the host's real database by accident. Null means nothing could be spawned at all.
function readSpec(env = process.env) {
  const seam = env.PIPELINE_BD_CMD;
  if (seam) return { cmd: seam, pre: [SEAM_PROGRAM_SLOT] };
  return hostBdSpec();
}

// How much of bd's answer this reader is willing to hold. `spawnSync`'s own default is 1 MiB,
// which a real backlog's `ready --json` — whole issue records, descriptions included — can
// exceed, and the failure it produces is the shape change-log row `verify-nobuffer` was about:
// the call SUCCEEDED and the ceiling turned it into a failure. Generous rather than absent,
// because a pure reader run during a launch ritual must not be able to exhaust memory over a
// wedged `bd` that never stops writing.
const CAPTURE_LIMIT_BYTES = 8 * 1024 * 1024;

// One bounded, read-only call. Every failure is classified into exactly one reason, and the
// two that look alike are kept apart on purpose: NOT SPAWNED AT ALL is `bd-unavailable`
// (there is no queue to compare against on this host), while SPAWNED AND UNUSABLE — a
// non-zero exit, output that is not the expected array, or a kill at the bound — is
// `bd-unreadable` (there is a queue and this reader could not read it). The first sends
// someone to install bd; the second sends them to look at the database.
function readReadyQueue(cfg, env = process.env) {
  const spec = readSpec(env);
  if (!spec) return { ok: false, reason: 'bd-unavailable', detail: 'no host bd resolved' };
  const opts = spawnOptions(cfg, { env: process.env, maxBuffer: CAPTURE_LIMIT_BYTES });
  const argv = [...spec.pre, '-C', cfg.targetRepoPath, 'ready', '--json'];
  const r = spawnSync(spec.cmd, argv, opts);

  // An answer past the ceiling, checked BEFORE the timeout test below and not after it: an
  // overflow is killed with the SAME `killSignal` and leaves the SAME `status: null` shape,
  // so the later test would claim `bd` never answered when it answered at once and this
  // reader stopped listening. Same reason either way, and the reason is only half the
  // message — the detail is what sends someone to the right thing to look at.
  if (r.error && r.error.code === 'ENOBUFS') {
    return { ok: false, reason: 'bd-unreadable', detail: `answer exceeded ${CAPTURE_LIMIT_BYTES} bytes` };
  }

  // spawnSync does not report a timeout as a failure a caller can read: it returns status
  // null with the kill signal, and error.code ETIMEDOUT. Checked FIRST, because that same
  // shape would otherwise be mistaken for "could not be spawned".
  const timedOut = !!(r.error && (r.error.code === 'ETIMEDOUT' || /ETIMEDOUT/.test(r.error.message || '')))
    || (r.status === null && r.signal === opts.killSignal);
  if (timedOut) return { ok: false, reason: 'bd-unreadable', detail: `no answer within ${opts.timeout}ms` };
  if (r.error) return { ok: false, reason: 'bd-unavailable', detail: r.error.code || 'could not be spawned' };
  if (r.status === null) return { ok: false, reason: 'bd-unreadable', detail: `killed by ${r.signal}` };
  if (r.status !== 0) return { ok: false, reason: 'bd-unreadable', detail: `exit ${r.status}` };
  let data;
  try { data = JSON.parse(r.stdout || ''); } catch {
    return { ok: false, reason: 'bd-unreadable', detail: 'output is not JSON' };
  }
  // `bd ready --json` answers with a bare array. Anything else is a bd this reader does not
  // understand, and guessing at an empty queue would report every id as absent from it.
  if (!Array.isArray(data)) return { ok: false, reason: 'bd-unreadable', detail: 'output is not a JSON array' };
  return { ok: true, entries: data };
}

// Batch against queue. `queued` is what the runner would actually drain — epic parents are
// dropped first, because bd returns them by design and calling one a stray is the false
// alarm PLANNING.md step 8 warns about — and a stray is a queued id the marker never named.
function reconcile(marker, entries) {
  const named = new Set(marker.issues.map((issue) => issue.id));
  const queued = [];
  let excluded = 0;
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    if (EXCLUDED_TYPES.has(typeOf(entry))) { excluded += 1; continue; }
    const id = nonEmptyString(entry.id);
    if (!id) continue;                       // an entry with no id cannot be compared at all
    queued.push({ id, type: typeOf(entry) || 'untyped' });
  }
  const queuedIds = new Set(queued.map((q) => q.id));
  return {
    queued,
    excluded,
    state: (id) => (queuedIds.has(id) ? 'ready' : 'not-ready'),
    strays: queued.filter((q) => !named.has(q.id)),
  };
}

// The whole join, in the order the two halves can fail: the config first (no target repo
// means there is nothing to ask), then the one call, then the comparison.
function queueReport(marker, env = process.env) {
  const cfg = readRunConfig(marker, env);
  if (!cfg) {
    return {
      ok: false,
      reason: 'run-config-absent',
      detail: marker.runConfig
        ? `no usable ${marker.runConfig} under ${configDir(env)}`
        : `the marker names no run config`,
    };
  }
  const queue = readReadyQueue(cfg, env);
  if (!queue.ok) return { ...queue, cfg };
  return { ok: true, cfg, ...reconcile(marker, queue.entries) };
}

// ---- pending ----------------------------------------------------------------------------
// A report, never a gate: exit 0 whatever it finds, including nothing and including a runs
// root that does not exist.
function pending(argv, out, err) {
  if (argv.length) {
    err(`batch: pending takes no arguments (got "${argv[0]}")`);
    err(USAGE);
    return EXIT_USAGE;
  }
  const root = runsRoot();
  const runs = readRuns(root);
  const listed = readMarkers(root).filter((marker) => isPending(marker, runs));

  out(`== batches no run has worked since the freeze (${listed.length}) ==`);
  for (const marker of listed) {
    const labels = markerLabels(marker);
    out([
      `  ${marker.stem}`,
      `frozen ${marker.frozenAt === null ? '(absent)' : marker.frozenAt}`,
      `${marker.issues.length} issue(s)`,
      marker.runConfig || '(no runConfig)',
      ...labels,
    ].join('  '));
  }
  if (!listed.length) out('  none — every batch marker names an id some run has worked since it was frozen');
  out('confirm one with: node scripts/batch.js show <project>-<YYYY-MM-DD>');
  return EXIT_OK;
}

// ---- show -------------------------------------------------------------------------------
function parseShowArgs(argv) {
  const positional = [];
  for (const arg of argv) {
    if (arg.startsWith('--')) return { error: `unknown option "${arg}"` };
    positional.push(arg);
  }
  if (positional.length > 1) {
    return { error: `show names at most one batch (got "${positional[1]}")` };
  }
  if (!positional.length) return { stem: null };

  // `batch.js show foo-2026-08-19.json` is what tab completion produces; accept it.
  const stem = positional[0].trim().replace(/\.json$/, '');
  if (!stem) return { error: 'show needs a batch name' };
  if (stem.includes('/') || stem.includes('\\') || !MARKER_STEM.test(stem)) {
    return { error: `"${positional[0]}" is not a batch name — expected <project>-<YYYY-MM-DD>` };
  }
  return { stem };
}

const pad = (label) => `  ${label}:${' '.repeat(Math.max(1, 14 - label.length))}`;

function show(argv, out, err) {
  const opts = parseShowArgs(argv);
  if (opts.error) {
    err(`batch: ${opts.error}`);
    err(USAGE);
    return EXIT_USAGE;
  }

  const root = runsRoot();
  const markers = readMarkers(root); // newest freeze first
  let marker;
  if (opts.stem) {
    marker = markers.find((m) => m.stem === opts.stem);
    if (!marker) {
      err(`batch: no marker "${opts.stem}.json" under ${batchesDir(root)}`);
      return EXIT_NOT_FOUND;
    }
  } else {
    // The newest marker, LAUNCHED OR NOT: a default that skipped a launched batch would
    // hide the double launch it is most important to see.
    marker = markers[0];
    if (!marker) {
      err(`batch: no batch markers under ${batchesDir(root)}`);
      return EXIT_NOT_FOUND;
    }
  }

  const worked = workedSince(readRuns(root), marker.frozenMs);
  const labels = markerLabels(marker);
  const queue = queueReport(marker);

  out(`== batch ${marker.stem} ==`);
  out(`${pad('project')}${marker.project}`);
  out(`${pad('run config')}${marker.runConfig || '(absent)'}`);
  out(`${pad('frozen at')}${marker.frozenAt === null ? '(absent)' : marker.frozenAt}`
    + `${marker.frozenMs === null ? '  freeze-time-unknown' : ''}`);
  for (const [label, value] of marker.optional) out(`${pad(label)}${value}`);

  out(`${pad('issues')}${marker.issues.length}${marker.issues.length ? '' : '  no-issues'}`);
  for (const issue of marker.issues) {
    const witness = worked.get(issue.id);
    out([
      `    ${issue.id}`,
      witness ? 'worked' : 'not-worked',
      ...(witness ? [`by ${witness.runId}`] : []),
      ...(witness && !witness.timeKnown ? ['run-time-unknown'] : []),
      // The reconciled token rides on the id's own line, and only when there IS a
      // reconciliation: a degraded run must not speak this vocabulary at all, or "the queue
      // agreed" and "the queue was never asked" read the same at a glance.
      ...(queue.ok ? [queue.state(issue.id)] : []),
      ...(issue.title ? [issue.title] : []),
    ].join('  '));
  }

  if (queue.ok) {
    out(`${pad('queue')}${queue.queued.length} entries at ${queue.cfg.targetRepoPath}`
      + `${queue.excluded ? `  (${queue.excluded} epic parent${queue.excluded === 1 ? '' : 's'} excluded)` : ''}`);
    // Strays only when there are any: a "none" placeholder would put the word on a line of
    // its own, and the whole point of the token is that seeing it means something.
    for (const stray of queue.strays) out(`    ${stray.id}  stray  ${stray.type}`);
  } else {
    out(`${pad('queue')}unreconciled ${queue.reason} — ${queue.detail}`);
  }
  if (labels.length) out(`${pad('degraded')}${labels.join(' ')}`);
  return EXIT_OK;
}

// ---- CLI --------------------------------------------------------------------------------
function main(argv, out = console.log, err = console.error) {
  const args = argv.slice();
  const mode = args.shift();
  if (mode === 'pending') return pending(args, out, err);
  if (mode === 'show') return show(args, out, err);
  err(mode ? `batch: unknown mode "${mode}"` : 'batch: no mode given');
  err(USAGE);
  return EXIT_USAGE;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = {
  main, pending, show, runsRoot, readMarkers, readRuns, workedSince, isPending, byFreeze,
  leadingInstant, configDir, readRunConfig, readSpec, readReadyQueue, reconcile, queueReport,
  MARKER_STEM, SEAM_PROGRAM_SLOT, USAGE, EXIT_OK, EXIT_USAGE, EXIT_NOT_FOUND,
};
