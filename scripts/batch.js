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
//   node scripts/batch.js show [<stem>]    one marker, reconciled against the live queue
//
// FOUR PROPERTIES ARE LOAD-BEARING, and every decision below follows from one of them:
//
//   1. Deterministic scaffolding (hard rule 7). No LLM anywhere, and exactly ONE subprocess
//      in the whole file: marker reading and the pending join are node built-ins only, and
//      §3.9's reconciliation against the live queue — the one part that needs `bd` — is
//      BOUNDED rather than absorbed. It runs only under `show`, spawns once, is killed at
//      `bdTimeoutMs`, and READS AND NEVER WRITES (hard rule 1). Where any link of the join
//      cannot be made, `show` says which one and stays silent about the queue rather than
//      printing a marker as if the queue had agreed with it.
//   2. Pure reader (§5, hard rule 5's shape). It creates no file, edits no artifact and
//      mutates no marker; `pending` exits 0 whatever it finds, because it is a report.
//      A marker is immutable and there is no `launched` flag to stamp — "still pending" is
//      a JOIN computed from the run corpus at the moment the question is asked, which is
//      `scripts/verdict.js pending`'s move and inherits its best property: nothing to
//      forget to update.
//   3. Never a queue item. Nothing in `runner/` or `pipeline/` reads `runs/batches/`; the
//      marker records what was *intended*, Beads decides what runs, and when the two
//      disagree that is the finding rather than an error.
//   4. Host-only, and self-contained apart from TWO deliberate imports. The runs root comes
//      from `BATCH_RUNS_DIR` or from THIS FILE's location — never from the working
//      directory, since the launching session runs this from wherever it happens to be. The
//      only repo code it reaches for is the pair of rules it must not own a second copy of:
//      `hostBdSpec` (how this host invokes `bd`, npm's shims included) and
//      `EXCLUDED_TYPES`/`typeOf` (the runner's epic filter). Both are rules about what the
//      RUNNER will do, and a reconciliation that predicts the runner from its own private
//      copy of them predicts the wrong runner the day one of them changes.
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
//   * THE JOIN HAS THREE SOURCES, not two (§3.9). `run.json` records the target as a git
//     remote URL and never the config name, so nothing joins a marker to a queue without
//     reading the `run.config.<project>.json` the marker names — a git-ignored file,
//     resolved from `BATCH_CONFIG_DIR` or from this repo's root, never the cwd — for its
//     `targetRepoPath`. It is read by plain JSON parse for that one key (plus an optional
//     `bdTimeoutMs`), NOT through `runner/config.js`, which validates a whole run and
//     throws over keys this reader has no opinion about.
//   * THE MIDDLE LINK GETS ITS OWN DEGRADED TERM. `unreconciled` never travels alone: it
//     carries `run-config-absent` (this host has no such config), `bd-unavailable` (no
//     `bd` could be spawned at all) or `bd-unreadable` (one ran and answered with a
//     non-zero status, unparseable output, or nothing before the bound killed it). A
//     reconciled report prints no degraded term and a degraded one names no queue state —
//     the dangerous failure here is the plausible-and-wrong one, a confident verdict
//     computed from a queue nobody read.
//   * A TIMED-OUT CALL IS `bd-unreadable`, NOT `bd-unavailable`. `bd` was there and did
//     not answer, which is a different thing to look at from `bd` not being installed.
//     The same care in reverse for the capture ceiling: an overflow and a timeout are
//     indistinguishable by SHAPE (both kill the child, both leave a null status and a
//     signal) and differ only in `error.code`, so the ceiling is tested first and raised
//     well past what a real ready queue prints.
//   * EPIC PARENTS ARE NEVER AN EXTRA. `bd ready` returns them by design and the runner
//     drops them, so the same deny-list runs here before anything is called a stray —
//     imported from `runner/queue.js` rather than copied, because the value of this
//     report is that it predicts what the runner will drain.
//
// Covered by tests/unit/batch.test.js through scripts/test-batch.sh (no container engine,
// no network; the sweep discovers it by glob). `BATCH_RUNS_DIR` re-aims the runs root and
// `BATCH_CONFIG_DIR` the directory run configs are resolved from; the `bd` seam is the
// EXISTING `PIPELINE_BD_CMD`, which every entry point in `runner/bd.js` honours ahead of
// the host probe — a second seam name would leave a host that has `bd` installed with a
// suite that passes vacuously.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
// The two rules this reader must not own a second copy of (property 4 above). Neither
// import reaches a helper that can start a container: `hostBdSpec` only ANSWERS which
// command invokes `bd` on this host, and the argument vector below is assembled and
// spawned here.
const { hostBdSpec, spawnOptions } = require('../runner/bd');
const { EXCLUDED_TYPES, typeOf } = require('../runner/queue');

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

// No line of this may speak a reconciled term: `show`'s degraded output prints the usage
// string on a bad argument, and a queue state named there would be a queue state nobody
// read (§3.9's plausible-and-wrong failure, in the one place it costs nothing to avoid).
const USAGE = [
  'usage:',
  '  node scripts/batch.js pending',
  '  node scripts/batch.js show [<project>-<YYYY-MM-DD>]',
  '',
  'The runs root is $BATCH_RUNS_DIR, else <script dir>/../runs; markers live in its',
  'batches/ subdirectory. show also consults the live queue of the target named by the',
  'run config the marker points at, resolved from $BATCH_CONFIG_DIR, else this repo root.',
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

// Where `run.config.<project>.json` is looked up. Same seam shape as the runs root, and the
// same default rule: this file's own location, never the working directory — the launching
// session types it from wherever it happens to be standing, and a run config resolved
// against that would name a different target on the same host from one shell to the next.
function configDir(env = process.env) {
  const seam = env.BATCH_CONFIG_DIR;
  if (typeof seam === 'string' && seam.trim()) return path.resolve(seam.trim());
  return path.resolve(__dirname, '..');
}

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
// THIS is what the marker exists for. The runner has no picker (§4.12): it drains whatever
// queue it finds, so an issue nobody meant to include in this batch simply runs, and a
// blocked one silently does not. No other part of the pipeline can see that mismatch,
// because no other part holds the INTENT to compare a queue against.
//
// The reconciled vocabulary, one token per id, literal because a launching session greps it
// and a frozen suite pins it. Every one of them is a statement about the LIVE queue; none of
// them may be printed when the queue was not read.
const READY = 'ready';          // the batch names it and a run started now would take it
const NOT_READY = 'not-ready';  // the batch names it and the queue does not offer it
const STRAY = 'stray';          // the queue offers it and the batch never named it

// The three ways the join breaks, each naming its own broken link. `unreconciled` is never
// printed alone: a report that says only "unreconciled" sends someone to look at `bd` when
// the missing thing was a run config, which is the cheapest possible way to waste the one
// person this tool exists for.
const RUN_CONFIG_ABSENT = 'run-config-absent';
const BD_UNAVAILABLE = 'bd-unavailable';
const BD_UNREADABLE = 'bd-unreadable';

// The read-only query. No verb here writes: no create, update, close, note, import, sync or
// dolt reaches a target's database from this file, because the host runner is the sole
// Beads writer (hard rule 1) and this is a reader a human runs before that runner exists.
const QUERY = ['ready', '--json'];

// The capture ceiling. spawnSync's default is 1 MiB and a real ready queue can print more
// than that; the overflow is INDISTINGUISHABLE from a timeout by shape — the child is
// killed, the status is null, a signal is set — and separable only by `error.code`. So the
// ceiling is raised well past a plausible answer AND tested for before the bound, or a
// query that answered instantly gets reported as one that never answered.
const READY_MAX_BUFFER = 8 * 1024 * 1024;

// A throwaway program slot at the head of the seam's argument vector. The seam is stubbed as
// `process.execPath` plus a preload, and node's own parser owns `-C` (the short form of
// `--conditions`): a leading `-C <path>` is swallowed before any stub sees it and WHICH REPO
// WAS CONSULTED stops being observable to a suite that stubs the seam. This is the slot the shim
// path fills with the resolved bd.js, so both paths put `-C` past the first non-option
// argument, where every parser leaves it alone.
const SEAM_PROGRAM_SLOT = 'bd';

// The middle link of the three-source join (§3.9). `run.json` records the target as a git
// remote URL and never the config name, so the marker's `run.config.<project>.json` is the
// only thing that names a working copy to ask. Read by plain JSON parse for the one key that
// matters — `runner/config.js`'s loader validates a whole run and throws over keys a reader
// has no opinion about, which would turn "your config is missing a token path" into
// "unreconciled" for a reason nobody could act on.
function readRunConfig(marker, env = process.env) {
  const dir = configDir(env);
  const absent = (detail) => ({ ok: false, reason: RUN_CONFIG_ABSENT, detail });
  const name = marker.runConfig;
  if (!name) return absent(`the marker names no run config to resolve under ${dir}`);
  // A marker names a file that sits beside the others on this host, never a path. Anything
  // carrying a separator is a name this host cannot resolve, which is the same answer.
  if (name.includes('/') || name.includes('\\')) return absent(`"${name}" is not a run config name`);
  const value = readJsonObject(path.join(dir, name));
  if (!value) return absent(`no readable ${name} under ${dir}`);
  const targetRepoPath = nonEmptyString(value.targetRepoPath);
  if (!targetRepoPath) return absent(`${name} under ${dir} names no targetRepoPath`);
  return { ok: true, name, dir, targetRepoPath, bdTimeoutMs: value.bdTimeoutMs };
}

// ONE spawn, bounded by the config's `bdTimeoutMs` through the runner's own `spawnOptions`
// (default 60000, SIGKILL, never unbounded). The vector is assembled here rather than handed
// to the runner's `bd`/`bdJson` helpers on purpose: their last resort runs the query inside
// the per-project image, and a pure reader may not start a container — nor may a stubbed
// "nothing could be spawned" fixture depend on whether a container engine happens to be
// running on the host. Returns null when there is nothing to spawn at all.
function spawnReady(cfg) {
  const args = ['-C', cfg.targetRepoPath, ...QUERY];
  const opts = spawnOptions(cfg, { maxBuffer: READY_MAX_BUFFER });
  // The EXISTING seam, with the absolute precedence every entry point in `runner/bd.js`
  // gives it. A seam name invented for this reader alone would pass vacuously on a host
  // that has the real thing installed, which is every reference host.
  const seam = process.env.PIPELINE_BD_CMD;
  if (seam) return spawnSync(seam, [SEAM_PROGRAM_SLOT, ...args], { ...opts, env: process.env });
  const host = hostBdSpec();
  if (!host) return null;
  return spawnSync(host.cmd, [...host.pre, ...args], opts);
}

// What the target's queue offers right now, or which link failed. Nothing the child printed
// is quoted back: a failing `bd` writes prose, that prose can contain the reconciled words,
// and a degraded report that speaks them is exactly the plausible-and-wrong output this
// vocabulary exists to prevent. The CAUSE is named instead, which is what a human acts on.
function liveQueue(cfg) {
  const bound = spawnOptions(cfg).timeout;
  const r = spawnReady(cfg);
  if (r === null) {
    return { ok: false, reason: BD_UNAVAILABLE, detail: 'no bd on this host, and no PIPELINE_BD_CMD seam' };
  }
  const code = r.error ? String(r.error.code || '') : '';
  const message = r.error ? String(r.error.message || '') : '';
  const test = (needle) => code === needle || new RegExp(needle).test(message);
  // Ceiling first, bound second, and only then "it never started": the first two both kill
  // the child and leave the same null status and signal behind.
  if (test('ENOBUFS')) {
    return { ok: false, reason: BD_UNREADABLE, detail: `the answer exceeded ${READY_MAX_BUFFER} bytes` };
  }
  if (test('ETIMEDOUT') || (r.status === null && r.signal)) {
    return { ok: false, reason: BD_UNREADABLE, detail: `no answer within ${bound}ms (bdTimeoutMs); killed` };
  }
  if (r.error || r.status === null) {
    return { ok: false, reason: BD_UNAVAILABLE, detail: `bd could not be spawned${code ? ` (${code})` : ''}` };
  }
  if (r.status !== 0) return { ok: false, reason: BD_UNREADABLE, detail: `bd exited ${r.status}` };
  let data;
  try { data = JSON.parse(r.stdout || ''); } catch { data = undefined; }
  // `bd ready --json` answers with a BARE ARRAY. Anything else is a version of the tool this
  // reader does not understand, which is unreadable rather than an empty queue — reporting a
  // shape it cannot parse as "nothing is runnable" is the quiet, confident wrong answer.
  if (!Array.isArray(data)) return { ok: false, reason: BD_UNREADABLE, detail: 'bd printed no queue array' };

  const entries = data.filter((e) => e && typeof e === 'object' && !Array.isArray(e));
  // The runner's own deny-list, imported rather than copied (`runner/queue.js`): `bd ready`
  // returns epic parents by design and the runner drops them, so calling one a stray would
  // raise the false alarm PLANNING.md step 8 warns about, every single time.
  const kept = entries.filter((e) => !EXCLUDED_TYPES.has(typeOf(e)));
  const order = [];
  const ids = new Set();
  for (const entry of kept) {
    const id = nonEmptyString(entry.id);
    if (!id || ids.has(id)) continue;
    ids.add(id);
    order.push(id);
  }
  return { ok: true, ids, order, excluded: entries.length - kept.length, total: entries.length };
}

// Marker versus queue. Returns the same shape either way, so `show` renders one of two
// things and can never render half of each.
function reconcile(marker, env = process.env) {
  const cfg = readRunConfig(marker, env);
  if (!cfg.ok) return cfg;
  const queue = liveQueue(cfg);
  if (!queue.ok) return { ...queue, cfg };
  const named = new Set(marker.issues.map((issue) => issue.id));
  return {
    ok: true,
    cfg,
    ready: queue.ids,
    strays: queue.order.filter((id) => !named.has(id)),   // queue order: bd's own ranking
    excluded: queue.excluded,
    total: queue.total,
  };
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
  // The one subprocess in this file, and only under `show`. `pending` answers a question
  // about the run corpus alone and must stay spawn-free: it is the command a session runs
  // over every marker on the host.
  const rec = reconcile(marker);

  out(`== batch ${marker.stem} ==`);
  out(`${pad('project')}${marker.project}`);
  out(`${pad('run config')}${marker.runConfig || '(absent)'}`
    + `${rec.ok ? `  ->  ${rec.cfg.targetRepoPath}` : ''}`);
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
      // The queue state rides on the id's own line, and only when a queue was actually
      // read. One token per id: a line saying both would be a line saying neither.
      ...(rec.ok ? [rec.ready.has(issue.id) ? READY : NOT_READY] : []),
      ...(issue.title ? [issue.title] : []),
    ].join('  '));
  }

  if (rec.ok) {
    // The summary counts, deliberately WITHOUT the tokens in it: the per-id lines below and
    // above are what a reader greps, and a total that repeated the words would make every
    // count of them wrong by one. Excluded entries are counted and never named — an epic
    // parent is not a finding, it is the queue behaving as designed.
    out(`${pad('queue')}${rec.total} entr${rec.total === 1 ? 'y' : 'ies'}`
      + `${rec.excluded ? `; ${rec.excluded} excluded by type (epic parents)` : ''}`
      + `; ${rec.strays.length} not named by this batch`);
    for (const id of rec.strays) {
      out(`    ${id}  ${STRAY}  offered by the queue; a run started now would drain it too`);
    }
  } else {
    // A broken link names itself, and says nothing whatever about the queue. §3.9's
    // vocabulary, for §3.6's reason: the dangerous failure writes something plausible.
    out(`${pad('queue')}unreconciled ${rec.reason} — ${rec.detail}`);
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
  main, pending, show, runsRoot, configDir, readMarkers, readRuns, workedSince, isPending,
  byFreeze, leadingInstant, readRunConfig, liveQueue, reconcile, MARKER_STEM, USAGE,
  READY, NOT_READY, STRAY, RUN_CONFIG_ABSENT, BD_UNAVAILABLE, BD_UNREADABLE,
  READY_MAX_BUFFER, EXIT_OK, EXIT_USAGE, EXIT_NOT_FOUND,
};
