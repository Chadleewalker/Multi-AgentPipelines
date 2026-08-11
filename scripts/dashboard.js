#!/usr/bin/env node
// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// The live run dashboard — read the tree, serve one frozen JSON contract, change nothing
// (DESIGN.md §5, change-log rows `live-dashboard` and `repo-kfg`).
//
//   node scripts/dashboard.js            then open the announced address
//
// An unattended run is watched today by tailing `run.log`, which interleaves a batch's
// lines into one stream with only the trace id to tell tasks apart. This is the reader
// that turns those artifacts back into structure: one HTTP face with two routes.
//
//   GET /        a placeholder page. The real view is built interactively against the
//                contract below; this file deliberately ships no second file and no
//                asset — the page's look is reviewed by looking at it, which a
//                three-attempt unattended container cannot do.
//   GET /state   the frozen contract (`schema: 1`), assembled per request by reading
//                `runs/locks/*.lock`, each run's `run.log` and `run.json`, the live
//                workspaces' `.run/status.json` (found through the runner's
//                unconditional `workspace ready:` line) and the collected
//                `runs/<runId>/tasks/<id>/status.json`.
//   anything else  404 with the exact body `not found\n`. There is no static-file route:
//                a reader that can serve a path out of the repo is a file server.
//
// Four properties are load-bearing, and each has a frozen test:
//   * It is a PURE READER. It creates, modifies and deletes nothing, anywhere — no cache,
//     no index, no log file. It spawns nothing and never touches `bd` or Docker
//     (hard rules 1 and 7). `process.kill(pid, 0)` is the one exception the lock's own
//     liveness rule already uses: a permission probe that spawns and writes nothing.
//   * It is LOCALHOST ONLY. The data names target repos, PR URLs and issue titles, so the
//     socket binds 127.0.0.1 and nothing else. `listen()` without a host would publish
//     private work on every interface of the developer's machine.
//   * It NEVER GATES and never 500s. Every malformed artifact is a named term in a
//     `degraded` array at its own level, next to the fields it could not fill. A reader
//     that dies on the first half-written status file is dark exactly during the runs it
//     exists for.
//   * It holds NO STARTUP CACHE. `/state` is re-read from the tree per request, and the
//     only field that varies between two polls of an unchanged tree is `now`. Elapsed
//     times are the page's job, computed browser-side from `now` and the timestamps here.
//
// Self-contained on purpose: node built-ins only, no requires of other repo files, so a
// copy of this file works from any repo-shaped root (the tests rely on that to prove the
// default root resolves from the script's own location and not the cwd). That is also why
// the lock's liveness rule and its canonical-target fold are re-implemented inline below
// rather than required from `runner/lock.js` — their fidelity is pinned behaviourally by
// the suite's fixtures, not by sharing code with the runner.
//
// Docker-free by construction; covered forever by scripts/test-dashboard.sh over
// tests/unit/dashboard.test.js.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const HOST = '127.0.0.1';
const DEFAULT_PORT = 4770;

// §4.6's three-attempt cap is a contract constant, not a number read from a config that a
// run could have been launched with — the page renders "attempt n/3" and the 3 is what the
// design says, so a config drift must show up as n > 3 rather than silently rescale.
const ATTEMPTS_MAX = 3;

// The closed phase vocabulary (schemas/status.schema.json). Anything else — including a
// status file written before the field existed — is `phase: null` plus `phase-unknown`.
// This reader never schema-validates `status.json`: a validating reader red-lines every
// artifact written by a version of the schema it does not know.
const PHASES = ['code', 'verify', 'docs'];

// Not runs: the lock directory and the test sweep's own output tree.
const NOT_A_RUN = new Set(['locks', 'sweeps']);

// The parsed line vocabulary, as literal prefixes. Everything else in `run.log` is
// ignored. Prefixes IDENTIFY lines; payloads are then split on their own pinned
// separators, so an em dash inside an issue title cannot reach the parser.
const P = {
  target: 'target: ',
  lockHeld: 'project lock held for ',
  lockTookOver: 'project lock: took over the lock on ',
  readyQueue: 'ready queue: ',
  starting: 'starting task (priority ',
  workspaceReady: 'workspace ready: ',
  launching: 'launching container ',
  containerRan: 'container ran ',
  rateLimitHit: 'rate limit hit (pause ',
  parkOpen: 'rate limit: opening the run-level wait (',
  parkReopen: 'run-level park: the window reopened',
  paused: 'paused: waiting until reported reset ',
  taskFinished: 'task finished: exit ',
  runFinished: 'run finished; artifacts in ',
  refused: 'refused: the run-level rate-limit pause cap',
  relaunching: 'relaunching in a fresh container',
};

// The runner's pinned log line: `<ISO> LEVEL [runId/issueId] msg` (runner/log.js).
const LINE_RE = /^(\S+) (\S+) \[([^\]]*)\] ([\s\S]*)$/;

// Every sort in this file is byte-wise on code units. Locale collation would reorder rows
// between two machines reading one tree, and the contract is compared byte for byte.
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---- the seams -------------------------------------------------------------------------
// A blank value means unset, not "the empty path": an exported-but-empty variable is what a
// shell leaves behind, and resolving it would aim the reader at the cwd. The default is
// resolved from THIS FILE's location so the answer cannot depend on where it was launched.
function resolveRoot() {
  const raw = process.env.DASHBOARD_RUNS_DIR;
  if (typeof raw === 'string' && raw.trim()) return path.resolve(raw.trim());
  return path.resolve(__dirname, '..', 'runs');
}

function resolvePort() {
  const raw = process.env.DASHBOARD_PORT;
  if (typeof raw !== 'string' || !raw.trim()) return DEFAULT_PORT;
  const n = Number(raw.trim());
  if (!Number.isInteger(n) || n < 0 || n > 65535) return DEFAULT_PORT;
  return n;                               // 0 is meaningful: an ephemeral port
}

// ---- reading -----------------------------------------------------------------------------
// Everything here answers null rather than throwing. An unreadable artifact is a fact to
// report at its own level, never a reason to stop assembling the rest of the tree.

function statOf(p) {
  try { return fs.statSync(p); } catch { return null; }
}
function isDir(p) {
  const st = statOf(p);
  return !!st && st.isDirectory();
}
function exists(p) {
  return statOf(p) !== null;
}

// A JSON file that must hold a plain object. An array is `unreadable` too: `run.json` is a
// manifest, and something that parses but is the wrong shape is exactly the plausible-and-
// wrong artifact this repo has been bitten by (CLAUDE.md §3.6).
function readObject(file) {
  if (!exists(file)) return { state: 'absent', value: null };
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return { state: 'unreadable', value: null }; }
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return { state: 'unreadable', value: null }; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { state: 'unreadable', value: null };
  return { state: 'ok', value: parsed };
}

// ---- project identity ---------------------------------------------------------------------
// The lock's rule, re-applied inline: one repo, one key, however the path was spelled.
// `path.resolve` folds `.`, `..` and a trailing separator; `realpath` is best effort and is
// what makes a symlinked spelling agree with the real one. Only on Windows is a backslash a
// separator and the filesystem case-insensitive — doing either elsewhere would merge two
// genuinely different repos into one project.
function canonicalTarget(target) {
  if (!target || typeof target !== 'string' || !target.trim()) return null;
  let p = target.trim();
  if (process.platform === 'win32') p = p.replace(/\//g, '\\');
  p = path.resolve(p);
  try { p = fs.realpathSync.native ? fs.realpathSync.native(p) : fs.realpathSync(p); } catch { /* not created yet */ }
  if (process.platform === 'win32') p = p.toLowerCase();
  return p;
}

// The last non-empty segment of the key, with a trailing `.git` stripped — a local path and
// a remote URL both end in the thing a human calls the project.
function displayName(key) {
  const segs = String(key).split(/[\\/]+/).filter(Boolean);
  const last = segs.length ? segs[segs.length - 1] : String(key);
  return last.replace(/\.git$/, '');
}

// ---- lock liveness ------------------------------------------------------------------------
// Re-implemented inline from runner/lock.js §4.12, and the reasoning travels with it:
// `process.kill(pid, 0)` alone reports a recycled or foreign pid as alive (EPERM counts as
// alive), so a record carrying only a pid reads as held forever after a reboot. The record
// carries falsifiable evidence beside the pid, and anything we can DISPROVE counts as gone.

const UPTIME_SLACK_MS = 5000;
const PRE_BOOT_GRACE_MS = 15 * 60 * 1000;

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);                 // signal 0: a permission probe, nothing is sent
    return true;
  } catch (e) {
    return e.code === 'EPERM';            // exists, owned by someone else
  }
}

// Linux: field 22 of /proc/<pid>/stat is the process start time in clock ticks since boot —
// an exact identity for a pid, which makes a recycled pid decidable rather than merely
// improbable. The comm field can contain spaces and parentheses, so the parse starts after
// its closing paren.
function procStartTicks(pid) {
  if (process.platform !== 'linux') return null;
  let raw;
  try { raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); } catch { return null; }
  const close = raw.lastIndexOf(')');
  if (close < 0) return null;
  const fields = raw.slice(close + 1).trim().split(/\s+/);
  return fields.length > 19 ? fields[19] : null;
}

// Both tests use the uptime counter rather than a stored boot timestamp: a boot timestamp
// computed as `now - uptime` drifts between two processes. The grace is generous on
// purpose — on a host whose uptime counter stops during sleep, a suspended-and-resumed
// machine looks briefly like a rebooted one.
function rebootedSince(rec) {
  const up = os.uptime();
  if (typeof up !== 'number' || !Number.isFinite(up)) return false;
  if (typeof rec.uptimeSeconds === 'number' && up * 1000 + UPTIME_SLACK_MS < rec.uptimeSeconds * 1000) return true;
  if (typeof rec.takenAtMs === 'number' && Date.now() - rec.takenAtMs > up * 1000 + PRE_BOOT_GRACE_MS) return true;
  return false;
}

function isHolderLive(rec) {
  if (!rec || !Number.isInteger(rec.pid)) return false;
  if (rebootedSince(rec)) return false;
  if (!pidAlive(rec.pid)) return false;
  const ticks = procStartTicks(rec.pid);
  if (ticks !== null && rec.procStart !== null && rec.procStart !== undefined && ticks !== rec.procStart) return false;
  return true;
}

// ---- the lock directory ---------------------------------------------------------------------
// A missing `runs/locks/` is the ordinary empty case — a host that has never run — not a
// degraded state. An unreadable record is degraded, and it still produces a project so the
// term has somewhere to be reported.
function readLocks(runsRoot) {
  let names;
  try { names = fs.readdirSync(path.join(runsRoot, 'locks')); } catch { return []; }
  const out = [];
  for (const name of [...names].sort(cmp)) {
    if (!name.endsWith('.lock')) continue;
    const file = path.join(runsRoot, 'locks', name);
    const { state, value } = readObject(file);
    if (state !== 'ok') {
      out.push({ name, state: 'unreadable', runId: null, pid: null, since: null, target: null });
      continue;
    }
    out.push({
      name,
      state: isHolderLive(value) ? 'held' : 'stale',
      runId: typeof value.runId === 'string' && value.runId ? value.runId : null,
      pid: Number.isInteger(value.pid) ? value.pid : null,
      since: typeof value.startedAt === 'string' ? value.startedAt : null,
      target: canonicalTarget(value.target),
    });
  }
  return out;
}

// ---- run.log ---------------------------------------------------------------------------------
// Read as UTF-8 and split on /\r?\n/, because the working copy on the reference host is CRLF
// while every container sees LF (CLAUDE.md §3.6). Lines that do not match the pinned shape
// are dropped rather than guessed at — this is structural parsing, never log scraping.
function readLog(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const lines = raw.split(/\r?\n/);
  const events = [];
  for (const line of lines) {
    if (!line) continue;
    const m = LINE_RE.exec(line);
    if (!m) continue;
    const trace = m[3];
    const slash = trace.indexOf('/');            // the trace id splits at its FIRST slash
    events.push({
      ts: m[1],
      level: m[2],
      runId: slash < 0 ? trace : trace.slice(0, slash),
      // `preflight` is the run pseudo-task and is never a task row.
      issueId: slash < 0 ? '' : trace.slice(slash + 1),
      msg: m[4],
    });
  }
  // The FIRST line specifically: it is the run's opening `target:` line, and it is the only
  // startedAt a manifest-less run has.
  let firstTs = null;
  const first = lines.length ? LINE_RE.exec(lines[0]) : null;
  if (first && !Number.isNaN(Date.parse(first[1]))) firstTs = first[1];
  return { events, firstTs };
}

// ---- run directories ---------------------------------------------------------------------------
// A run dir is a direct child DIRECTORY of the runs root, not named `locks` or `sweeps`, that
// holds `run.log` or `run.json`. No recency cutoff and no count cap: every project the corpus
// names has to appear, or the strip silently loses a channel. Plain files are skipped —
// `runs/` also holds the sweep's own leavings.
function discoverRuns(runsRoot) {
  let entries;
  try { entries = fs.readdirSync(runsRoot, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of [...entries].sort((a, b) => cmp(a.name, b.name))) {
    if (!e.isDirectory() || NOT_A_RUN.has(e.name)) continue;
    const dir = path.join(runsRoot, e.name);
    if (!exists(path.join(dir, 'run.log')) && !exists(path.join(dir, 'run.json'))) continue;
    out.push(readRunDir(dir, e.name));
  }
  return out;
}

function readRunDir(dir, runId) {
  const manifest = readObject(path.join(dir, 'run.json'));
  const log = readLog(path.join(dir, 'run.log'));

  // Local identity comes from the run's own opening line; the remote it names is NOT the
  // project's remote — that is a manifest field, so a run that never wrote one reports null
  // rather than inventing one from a log line.
  let localTarget = null;
  if (log) {
    for (const ev of log.events) {
      if (!ev.msg.startsWith(P.target)) continue;
      const tail = ev.msg.slice(P.target.length);
      const arrow = tail.indexOf(' -> ');
      const c = canonicalTarget(arrow < 0 ? tail : tail.slice(0, arrow));
      if (c) { localTarget = c; break; }
    }
  }
  const m = manifest.value;
  const remoteUrl = m && typeof m.targetRepo === 'string' && m.targetRepo.trim() ? m.targetRepo.trim() : null;

  // The manifest's `startedAt` when it parses, else the first log line's timestamp. A run
  // with neither sorts oldest rather than newest: an unreadable run must not win the pick and
  // hide a run that can actually be shown.
  let startedAt = null;
  let startedMs = -Infinity;
  if (m && typeof m.startedAt === 'string' && !Number.isNaN(Date.parse(m.startedAt))) {
    startedAt = m.startedAt;
    startedMs = Date.parse(m.startedAt);
  } else if (log && log.firstTs) {
    startedAt = log.firstTs;
    startedMs = Date.parse(log.firstTs);
  }

  return { runId, dir, manifest, log, localTarget, remoteUrl, startedAt, startedMs };
}

// ---- log payloads ---------------------------------------------------------------------------
// After a prefix matches, each payload is split on its own pinned separator. The ready-queue
// line is the one that has to be said out loud: `ready queue: 4 task(s) — a, b; skipped 1 by
// type: c (epic)`. The tail starts after the first ` — `, the ids end at the first `;`, and
// they split on `, `. Em dashes elsewhere in the line are payload, not structure.
const QUEUE_SPLIT = ' — ';

function readyQueueIds(events) {
  let ids = [];
  for (const ev of events) {
    if (!ev.msg.startsWith(P.readyQueue)) continue;
    const tail = ev.msg.slice(P.readyQueue.length);
    const dash = tail.indexOf(QUEUE_SPLIT);
    let body = dash < 0 ? tail : tail.slice(dash + QUEUE_SPLIT.length);
    const semi = body.indexOf(';');
    if (semi >= 0) body = body.slice(0, semi);
    ids = body.split(',').map((s) => s.trim()).filter((s) => s && s !== '(empty)');
  }
  return ids;                                    // the LAST queue line wins
}

// `park` is a RUN-level fact (§7): one shared wait, one cycle counter. The end-of-run summary
// line is deliberately not in the vocabulary — it reads 0 during exactly the runs this tool
// exists for.
function readPark(events) {
  const park = { open: false, cycles: 0, until: null };
  for (const ev of events) {
    if (ev.msg.startsWith(P.parkOpen)) {
      park.open = true;
      const m = /\((\d+)\/(\d+) cycles spent\)/.exec(ev.msg);
      if (m) park.cycles = Number(m[1]);
    } else if (ev.msg.startsWith(P.parkReopen)) {
      park.open = false;
    } else if (ev.msg.startsWith(P.paused)) {
      const iso = ev.msg.slice(P.paused.length).trim().split(/\s+/)[0];
      if (iso) park.until = iso;
    }
  }
  return park;
}

// `workspace ready: <dir> on <branch> (fork point <sha>)`. A temp workspace path can contain
// spaces, so the path is everything before the LAST ` on ` — greedy on purpose.
function workspacePath(msg) {
  const tail = msg.slice(P.workspaceReady.length);
  const m = /^(.*) on .* \(fork point [^)]*\)$/.exec(tail);
  if (m) return m[1];
  const at = tail.lastIndexOf(' on ');
  return at > 0 ? tail.slice(0, at) : tail;
}

// `starting task (priority 2): <title>` — the title is everything after the first `): `, so a
// colon or an em dash inside it survives verbatim.
function startingTitle(msg) {
  const tail = msg.slice(P.starting.length);
  const at = tail.indexOf('): ');
  return at < 0 ? '' : tail.slice(at + 3);
}

// ---- assembling one task row -------------------------------------------------------------
function buildTask(issueId, ctx) {
  const { events, row, run } = ctx;
  const evs = events || [];

  // A manifest row means the run reached its end for this task. Otherwise the LAST matching
  // event wins — a relaunch after a park puts a task back on `running`, and a refused task's
  // ERROR line beats its earlier appearance in the ready queue.
  let state = null;
  if (row) state = 'finished';
  else {
    for (const ev of evs) {
      if (ev.msg.startsWith(P.starting) || ev.msg.startsWith(P.relaunching)) state = 'running';
      else if (ev.msg.startsWith(P.rateLimitHit)) state = 'parked';
      else if (ev.msg.startsWith(P.taskFinished)) state = 'finished';
      else if (ev.level === 'ERROR' && ev.msg.startsWith(P.refused)) state = 'refused';
    }
    if (!state) state = 'queued';
  }
  const inFlight = state === 'running' || state === 'parked';

  let title = row && typeof row.title === 'string' ? row.title : '';
  let startedAt = null;
  let wsPath = null;
  let pausesFromLog = 0;
  for (const ev of evs) {
    if (ev.msg.startsWith(P.starting)) {
      startedAt = ev.ts;
      if (!(row && typeof row.title === 'string')) title = startingTitle(ev.msg);
    } else if (ev.msg.startsWith(P.workspaceReady)) {
      wsPath = workspacePath(ev.msg);
    } else if (ev.msg.startsWith(P.rateLimitHit)) {
      const m = /^rate limit hit \(pause (\d+)\)/.exec(ev.msg);
      pausesFromLog = m ? Number(m[1]) : pausesFromLog + 1;
    }
  }

  let wsState = 'unknown';
  if (wsPath) wsState = isDir(wsPath) ? 'live' : 'missing';

  // The live workspace's status file first, then the collected copy. A running task's truth
  // is in its workspace; a finished one's was collected under the run directory.
  const candidates = [];
  if (wsPath) candidates.push(path.join(wsPath, '.run', 'status.json'));
  if (run) candidates.push(path.join(run.dir, 'tasks', issueId, 'status.json'));
  let statusFile = null;
  for (const c of candidates) { if (exists(c)) { statusFile = c; break; } }
  const fromWorkspace = !!statusFile && !!wsPath && statusFile === path.join(wsPath, '.run', 'status.json');

  let statusState = 'missing';
  let status = null;
  let lastWrite = null;
  if (statusFile) {
    const st = statOf(statusFile);
    if (st) lastWrite = st.mtime.toISOString();      // ISO with milliseconds
    const read = readObject(statusFile);
    statusState = read.state === 'ok' ? 'ok' : 'unreadable';
    status = read.value;
  }

  let phase = null;
  let phaseKnown = false;
  let attemptResults = [];
  let liveAttempts = null;
  if (status) {
    if (Array.isArray(status.attempts)) {
      liveAttempts = status.attempts.length;
      attemptResults = status.attempts
        .map((a) => (a && typeof a.verifierResult === 'string' ? a.verifierResult : null))
        .filter((v) => v !== null);
    }
    if (typeof status.phase === 'string' && PHASES.includes(status.phase)) {
      phase = status.phase;
      phaseKnown = true;
    }
  }

  let attempt = 0;
  if (fromWorkspace && liveAttempts !== null) attempt = liveAttempts;
  else if (row && Number.isFinite(row.attempts)) attempt = row.attempts;
  else if (liveAttempts !== null) attempt = liveAttempts;

  const degraded = [];
  if (statusState === 'unreadable') degraded.push('status-unreadable');
  // A queued task legitimately has no status file and no workspace: only a task we believe
  // is in flight is degraded by their absence, or every idle row would carry two terms and
  // the array would stop meaning anything.
  if (statusState === 'missing' && inFlight) degraded.push('status-missing');
  if (wsState === 'missing') degraded.push('workspace-missing');
  if (wsState === 'unknown' && inFlight) degraded.push('workspace-unknown');
  if (status && !phaseKnown) degraded.push('phase-unknown');

  return {
    issueId,
    title,
    state,
    phase,
    attempt,
    attemptsMax: ATTEMPTS_MAX,
    attemptResults,
    outcome: row && typeof row.outcome === 'string' ? row.outcome : null,
    prUrl: row && typeof row.prUrl === 'string' ? row.prUrl : null,
    branch: row && typeof row.branch === 'string' ? row.branch : null,
    pauses: row && Number.isFinite(row.pauses) ? row.pauses : pausesFromLog,
    startedAt,
    activeSeconds: row && Number.isFinite(row.activeSeconds) ? row.activeSeconds : null,
    lastWrite,
    workspace: { state: wsState, path: wsPath },
    degraded,
  };
}

// ---- assembling one run --------------------------------------------------------------------
// `run` is ALWAYS the full object with null fields, never null itself: a page that has to
// test for the absence of the object before every field read is a page that crashes on the
// one project whose run went missing.
function buildRun(run, lock, degraded) {
  const events = run && run.log ? run.log.events : [];
  const manifest = run ? run.manifest : { state: 'absent', value: null };
  const m = manifest.value;

  const runId = run ? run.runId : (lock && lock.runId ? lock.runId : null);
  let state = 'unknown';
  if (lock && lock.state === 'held' && lock.runId && lock.runId === runId) state = 'running';
  else if (manifest.state === 'ok') state = 'finished';

  const queueIds = readyQueueIds(events);

  // Every id the run names: the manifest's rows, every trace id in the log that is not the
  // `preflight` pseudo-task, and everything the ready queue listed.
  const rows = new Map();
  if (m && Array.isArray(m.tasks)) {
    for (const t of m.tasks) {
      if (t && typeof t === 'object' && !Array.isArray(t) && typeof t.issueId === 'string' && t.issueId) rows.set(t.issueId, t);
    }
  }
  const perTask = new Map();
  for (const ev of events) {
    if (!ev.issueId || ev.issueId === 'preflight') continue;
    if (!perTask.has(ev.issueId)) perTask.set(ev.issueId, []);
    perTask.get(ev.issueId).push(ev);
  }
  const ids = new Set([...rows.keys(), ...perTask.keys(), ...queueIds]);
  ids.delete('preflight');

  const tasks = [...ids].sort(cmp)
    .map((id) => buildTask(id, { events: perTask.get(id), row: rows.get(id), run }));

  // Queue ORDER is the run's, not the task table's: `tasks[]` sorts by issueId so a page can
  // join against it, and the order the runner will actually work through lives here. Only the
  // ids that never started are still queued — a refused id is a result, not a wait.
  const byId = new Map(tasks.map((t) => [t.issueId, t]));
  const queued = queueIds.filter((id) => { const t = byId.get(id); return t && t.state === 'queued'; });

  return {
    runId,
    state,
    startedAt: run ? run.startedAt : null,
    finishedAt: m && typeof m.finishedAt === 'string' ? m.finishedAt : null,
    concurrency: m && Number.isFinite(m.concurrency) ? m.concurrency : null,
    park: readPark(events),
    queued,
    degraded,
    tasks,
  };
}

// ---- the state ---------------------------------------------------------------------------
function buildState(runsRoot) {
  const locks = readLocks(runsRoot);
  const runs = discoverRuns(runsRoot);

  // Projects are the union of what the locks name and what the run directories name. A
  // project's key is its canonical local path when anything supplies one, else the manifest's
  // remote URL, else `unknown:<runDirName>` — one project per orphan run dir, never one
  // bucket collecting all of them.
  const groups = new Map();
  const ensure = (key) => {
    if (!groups.has(key)) groups.set(key, { key, local: null, locks: [], runs: [] });
    return groups.get(key);
  };
  for (const l of locks) {
    const g = ensure(l.target || `unknown:${l.name}`);
    if (l.target) g.local = l.target;
    g.locks.push(l);
  }
  for (const r of runs) {
    const g = ensure(r.localTarget || r.remoteUrl || `unknown:${r.runId}`);
    if (r.localTarget) g.local = r.localTarget;
    g.runs.push(r);
  }

  const projects = [...groups.values()].sort((a, b) => cmp(a.key, b.key)).map((g) => {
    const lock = g.locks.find((l) => l.state === 'held')
      || g.locks.find((l) => l.state === 'stale')
      || g.locks.find((l) => l.state === 'unreadable')
      || null;

    // The lock's runId picks the run whenever the holder is live — a live run is not
    // necessarily the newest directory on disk, and "newest wins" hides it the moment a
    // later run starts for another project or a copied tree reorders the names.
    let chosen = null;
    if (lock && lock.state === 'held' && lock.runId) {
      chosen = g.runs.find((r) => r.runId === lock.runId) || null;
    } else {
      chosen = [...g.runs].sort((a, b) => (b.startedMs - a.startedMs) || cmp(a.runId, b.runId))[0] || null;
    }

    const runDegraded = [];
    if (!chosen) runDegraded.push('run-missing');
    else if (chosen.manifest.state === 'absent') runDegraded.push('no-manifest');
    else if (chosen.manifest.state === 'unreadable') runDegraded.push('manifest-unreadable');

    const degraded = [];
    if (g.locks.some((l) => l.state === 'unreadable')) degraded.push('lock-unreadable');
    if (lock && lock.state === 'stale') degraded.push('lock-stale');
    if (String(g.key).startsWith('unknown:')) degraded.push('target-unknown');

    const remote = (chosen && chosen.remoteUrl)
      || g.runs.map((r) => r.remoteUrl).find((u) => !!u)
      || (g.local ? null : (String(g.key).startsWith('unknown:') ? null : g.key));

    return {
      key: g.key,
      name: displayName(g.key),
      path: g.local,
      remote: remote || null,
      live: !!lock && lock.state === 'held',
      degraded,
      lock: lock
        ? { state: lock.state, runId: lock.runId, pid: lock.pid, since: lock.since }
        : { state: 'none', runId: null, pid: null, since: null },
      run: buildRun(chosen, lock, runDegraded),
    };
  });

  return { schema: 1, now: new Date().toISOString(), projects };
}

// ---- the placeholder page --------------------------------------------------------------
// Deliberately one inline template string and no second file: the real view is interactive
// work against the contract above. Scheme-level self-contained — no `://`, no external
// reference of any kind, and no link that leaves this document. A page that names private
// work must not be able to reach out, and the frozen suite asserts the bytes.
const PAGE = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>pipeline dashboard</title>
<style>
  :root {
    --ink: #14181d; --paper: #f2f4f5; --surface: #ffffff; --rule: #e3e8e9;
    --muted: #59626c; --flow: #2c7a6f; --gate: #a86c17; --refuse: #9d3a2f;
    --node-fill: #eef2f1; --node-stroke: #2c7a6f; --node-text: #14181d;
    --cluster-fill: #f6f8f8; --line: #6b7480;
    --human-fill: #dfe2f4; --human-stroke: #4a55a0;
    --store-fill: #eef0f1; --store-stroke: #8a939b;
    --blocked-fill: #f7e2df; --idle-fill: #f4f5f6; --idle-stroke: #9aa3aa;
    --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
    --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --ink: #e6eaec; --paper: #101417; --surface: #161b1f; --rule: #262d32;
      --muted: #949ea6; --flow: #5fb3a5; --gate: #d39a3f; --refuse: #d0705f;
      --node-fill: #1d262b; --node-stroke: #5fb3a5; --node-text: #eaeef0;
      --cluster-fill: #171e22; --line: #8a95a0;
      --human-fill: #1f2440; --human-stroke: #8b95d8;
      --store-fill: #191f23; --store-stroke: #6d767e;
      --blocked-fill: #33201d; --idle-fill: #171c20; --idle-stroke: #6d767e;
    }
  }
  :root[data-theme="dark"] {
    --ink: #e6eaec; --paper: #101417; --surface: #161b1f; --rule: #262d32;
    --muted: #949ea6; --flow: #5fb3a5; --gate: #d39a3f; --refuse: #d0705f;
    --node-fill: #1d262b; --node-stroke: #5fb3a5; --node-text: #eaeef0;
    --cluster-fill: #171e22; --line: #8a95a0;
    --human-fill: #1f2440; --human-stroke: #8b95d8;
    --store-fill: #191f23; --store-stroke: #6d767e;
    --blocked-fill: #33201d; --idle-fill: #171c20; --idle-stroke: #6d767e;
  }

  * { box-sizing: border-box; }
  body { margin: 0; padding: 1.5rem 1.25rem 4rem; background: var(--paper); color: var(--ink);
         font: 15px/1.55 var(--sans); }
  main { max-width: 78rem; margin: 0 auto; }

  .top { display: flex; flex-wrap: wrap; align-items: baseline; gap: .75rem 1.25rem;
         padding-bottom: .85rem; border-bottom: 1px solid var(--rule); margin-bottom: 1.5rem; }
  h1 { font-size: 1.15rem; margin: 0; letter-spacing: .01em; font-weight: 650; }
  .top .sp { flex: 1 1 auto; }
  .tick { font: 12px/1 var(--mono); color: var(--muted); }
  .count { font-size: .85rem; color: var(--muted); }

  .proj { background: var(--surface); border: 1px solid var(--rule); border-radius: 10px;
          margin-bottom: 1.1rem; overflow: hidden; }
  .proj.islive { border-color: var(--flow); box-shadow: 0 0 0 1px var(--flow); }
  .phead { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem .8rem;
           padding: .8rem 1rem; border-bottom: 1px solid var(--rule); background: var(--cluster-fill); }
  .pname { font-weight: 650; font-size: 1rem; }
  .ppath { font: 12px/1.4 var(--mono); color: var(--muted); word-break: break-all; flex: 1 1 14rem; }

  .lamp { display: inline-flex; align-items: center; gap: .4rem; font-size: .72rem;
          text-transform: uppercase; letter-spacing: .07em; font-weight: 650; }
  .lamp b { width: .55rem; height: .55rem; border-radius: 50%; background: var(--idle-stroke); }
  .lamp.on { color: var(--gate); }
  .lamp.on b { background: var(--gate); animation: pulse 1.6s ease-in-out infinite; }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: .25; } }
  @media (prefers-reduced-motion: reduce) { .lamp.on b { animation: none; } }

  .runbar { display: flex; flex-wrap: wrap; gap: .35rem 1.1rem; padding: .6rem 1rem;
            font: 12px/1.5 var(--mono); color: var(--muted); border-bottom: 1px solid var(--rule); }
  .runbar s { text-decoration: none; color: var(--ink); }

  .park { margin: 0; padding: .55rem 1rem; background: var(--blocked-fill);
          border-bottom: 1px solid var(--rule); font-size: .82rem; color: var(--ink); }

  .body { padding: .95rem 1rem 1.1rem; }
  .lbl { font-size: .68rem; text-transform: uppercase; letter-spacing: .09em;
         color: var(--muted); font-weight: 650; margin: 0 0 .5rem; }

  .flow { display: flex; flex-wrap: wrap; align-items: stretch; gap: .3rem; margin-bottom: 1rem; }
  .step { flex: 1 1 6.5rem; min-width: 6rem; border: 1px solid var(--idle-stroke);
          background: var(--idle-fill); border-radius: 7px; padding: .45rem .55rem; }
  .step.hot { border-color: var(--gate); background: var(--node-fill); box-shadow: inset 0 0 0 1px var(--gate); }
  .step.done { border-color: var(--node-stroke); background: var(--node-fill); }
  .step .sn { font-size: .72rem; text-transform: uppercase; letter-spacing: .06em;
              color: var(--muted); font-weight: 650; }
  .step.hot .sn { color: var(--gate); }
  .step .occ { display: block; font: 11px/1.5 var(--mono); color: var(--ink);
               margin-top: .2rem; word-break: break-all; }
  .step .occ:empty { display: none; }

  .task { border: 1px solid var(--rule); border-radius: 8px; padding: .7rem .8rem;
          margin-bottom: .6rem; background: var(--paper); }
  .task.run { border-color: var(--gate); }
  .thead { display: flex; flex-wrap: wrap; align-items: baseline; gap: .4rem .7rem; }
  .tid { font: 12px/1.4 var(--mono); font-weight: 650; }
  .ttl { flex: 1 1 12rem; font-size: .88rem; color: var(--muted); }
  .att { font: 11px/1 var(--mono); padding: .2rem .4rem; border-radius: 4px;
         background: var(--node-fill); border: 1px solid var(--node-stroke); }
  .facts { font: 11px/1.6 var(--mono); color: var(--muted); margin-top: .35rem; }

  .store { display: flex; flex-wrap: wrap; gap: .3rem; margin-top: .5rem; }
  .cell { flex: 1 1 9rem; border: 1px solid var(--store-stroke); background: var(--store-fill);
          border-radius: 6px; padding: .35rem .5rem; }
  .cell i { display: block; font-style: normal; font-size: .64rem; text-transform: uppercase;
            letter-spacing: .07em; color: var(--muted); font-weight: 650; }
  .cell u { display: block; text-decoration: none; font: 11px/1.45 var(--mono);
            word-break: break-all; margin-top: .1rem; }

  .strip { display: flex; flex-wrap: wrap; gap: .3rem; margin-top: .55rem; }
  .pill { font: 11px/1 var(--mono); padding: .3rem .45rem; border-radius: 5px;
          border: 1px solid var(--idle-stroke); background: var(--idle-fill); color: var(--muted); }
  .pill.ok { border-color: var(--node-stroke); color: var(--flow); }
  .pill.bad { border-color: var(--refuse); color: var(--refuse); background: var(--blocked-fill); }
  .pill.wait { border-color: var(--human-stroke); color: var(--human-stroke); background: var(--human-fill); }

  /* Degraded terms alarm only where a watcher can still act. On a finished run,
     workspace-missing and phase-unknown are the ordinary state of the archive - a
     cleaned-up workspace and a run older than the phase field - and painting those red
     trains the eye to ignore the colour that matters. */
  .deg { display: flex; flex-wrap: wrap; gap: .25rem; margin-top: .4rem; }
  .deg span { font: 10px/1 var(--mono); padding: .25rem .4rem; border-radius: 4px;
              background: var(--blocked-fill); color: var(--refuse); border: 1px solid var(--refuse); }
  .deg.calm span { background: var(--idle-fill); color: var(--muted); border-color: var(--idle-stroke); }

  details.proj > summary { cursor: pointer; list-style: none; }
  details.proj > summary::-webkit-details-marker { display: none; }
  /* Literal glyphs, not CSS escapes: a backslash cannot survive the template literal
     this page is embedded in. */
  details.proj > summary::before { content: "▸"; color: var(--muted); font-size: .7rem;
                                   margin-right: .1rem; }
  details.proj[open] > summary::before { content: "▾"; }
  .sumbits { display: flex; flex-wrap: wrap; gap: .25rem; align-items: center; }

  .empty { color: var(--muted); font-size: .85rem; padding: 2rem 0; text-align: center; }
  .fail { border: 1px solid var(--refuse); background: var(--blocked-fill); color: var(--refuse);
          border-radius: 8px; padding: .7rem .9rem; margin-bottom: 1rem; font-size: .85rem; }
  .foot { margin-top: 1.6rem; padding-top: .8rem; border-top: 1px solid var(--rule);
          color: var(--muted); font-size: .78rem; }
  .idleproj .phead { opacity: .82; }
</style>
<main>
  <div class="top">
    <h1>pipeline dashboard</h1>
    <span class="count" id="count"></span>
    <span class="sp"></span>
    <span class="tick" id="tick">connecting</span>
  </div>
  <div id="err"></div>
  <div id="list"><p class="empty">reading the run tree</p></div>
  <p class="foot">A pure reader, loopback only. Every field is a rendering of
     <code>/state</code>; elapsed times are computed in the browser from the server's
     <code>now</code>. Nothing here can touch a run.</p>
</main>
<script>
'use strict';

var PHASES = ['code', 'verify', 'docs'];
var STEPS = ['admit', 'claim', 'container', 'collect', 'finish'];

// Which idle projects the reader has opened. The page rebuilds its whole list on every
// poll, which throws away the DOM and with it the open/closed state of every panel; a
// panel that snaps shut every two seconds cannot be read. Keyed by project key, which is
// stable across polls in a way DOM order is not.
var OPEN = {};

// The last painted state, minus "now". Repainting an unchanged tree makes the page flicker
// and fights the reader; repainting is skipped when nothing but the clock moved. A live
// project is the exception - its elapsed counters are derived from "now", so they have to
// be redrawn even when no field on disk changed.
var lastSig = null;

function el(tag, cls, txt) {
  var n = document.createElement(tag);
  if (cls) n.className = cls;
  if (txt !== undefined && txt !== null) n.textContent = String(txt);
  return n;
}

function pad(n) { return (n < 10 ? '0' : '') + n; }

// Strip the scheme from a URL for display. Written with indexOf rather than a regex
// because this whole page is embedded in a template literal in scripts/dashboard.js: a
// backslash escape there collapses on the way in, and the escaped slashes of a
// scheme-matching regex would arrive as the very substring the self-containment check
// forbids. No backslash appears anywhere in this document, on purpose.
function bare(u) {
  var cut = u.indexOf('//');
  return cut < 0 ? u : u.slice(cut + 2);
}

function clock(iso) {
  if (!iso) return '--';
  var d = new Date(iso);
  if (isNaN(d.getTime())) return '--';
  return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}

// Elapsed is computed against the server's own "now", never the browser clock: the two
// can differ, and the contract deliberately ships one timestamp so this stays honest.
function since(iso, nowIso) {
  if (!iso) return null;
  var a = Date.parse(iso), b = Date.parse(nowIso);
  if (isNaN(a) || isNaN(b)) return null;
  return Math.max(0, Math.round((b - a) / 1000));
}

function dur(secs) {
  if (secs === null || secs === undefined) return '--';
  if (secs < 60) return secs + 's';
  var m = Math.floor(secs / 60);
  if (m < 60) return m + 'm';
  return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
}

// The one derivation the page does on its own, and it is deliberate. "attempt" in the
// contract counts attempts the verifier has JUDGED, so a task working its first attempt
// reports 0. A watcher wants the attempt now in progress, so an in-flight task shows
// attempt + 1. Capped, because a fourth attempt cannot exist (DESIGN.md 4.6).
function liveAttempt(t) {
  var inFlight = t.state === 'running' || t.state === 'parked';
  if (!inFlight) return t.attempt;
  return Math.min(t.attempt + 1, t.attemptsMax);
}

// Which node of admit -> claim -> container -> collect -> finish a task sits at.
function nodeOf(t) {
  if (t.state === 'queued') return 0;
  if (t.state === 'refused') return 0;
  if (t.state === 'parked') return 1;
  if (t.state === 'running') return t.workspace && t.workspace.state === 'live' ? 2 : 1;
  if (t.state === 'finished') return t.prUrl || t.outcome ? 4 : 3;
  return 0;
}

function degChips(list, calm) {
  var box = el('div', calm ? 'deg calm' : 'deg');
  (list || []).forEach(function (d) { box.appendChild(el('span', null, d)); });
  return box;
}

function outcomeClass(o) {
  if (o === 'done') return 'pill ok';
  if (o === 'tampered' || o === 'stuck' || o === 'failed') return 'pill bad';
  if (o === 'paused' || o === 'partial') return 'pill wait';
  return 'pill';
}

function renderFlow(run) {
  var wrap = el('div', 'flow');
  var here = {};
  (run.tasks || []).forEach(function (t) {
    var i = nodeOf(t);
    if (!here[i]) here[i] = [];
    if (t.state === 'running' || t.state === 'parked' || t.state === 'queued') here[i].push(t.issueId);
  });
  STEPS.forEach(function (name, i) {
    var s = el('div', 'step');
    var occupants = here[i] || [];
    if (occupants.length) s.className = 'step hot';
    else if (run.state === 'finished' && i === 4) s.className = 'step done';
    s.appendChild(el('span', 'sn', name));
    s.appendChild(el('span', 'occ', occupants.join(' ')));
    wrap.appendChild(s);
  });
  return wrap;
}

function renderPhases(t) {
  var wrap = el('div', 'flow');
  PHASES.forEach(function (name) {
    var s = el('div', 'step');
    if (t.phase === name) s.className = 'step hot';
    else if (t.phase && PHASES.indexOf(t.phase) > PHASES.indexOf(name)) s.className = 'step done';
    s.appendChild(el('span', 'sn', name));
    wrap.appendChild(s);
  });
  return wrap;
}

function renderTask(t, run, now, live) {
  var inFlight = t.state === 'running' || t.state === 'parked';
  var box = el('div', inFlight ? 'task run' : 'task');

  var head = el('div', 'thead');
  head.appendChild(el('span', 'tid', t.issueId));
  head.appendChild(el('span', 'ttl', t.title || ''));
  if (t.outcome) head.appendChild(el('span', outcomeClass(t.outcome), t.outcome));
  else head.appendChild(el('span', 'pill', t.state));
  // A task that has not started has no attempt to report; "attempt 0/3" reads as a
  // counter that failed rather than as a task waiting its turn.
  if (t.state !== 'queued') {
    head.appendChild(el('span', 'att', 'attempt ' + liveAttempt(t) + '/' + t.attemptsMax));
  }
  box.appendChild(head);

  if (inFlight) box.appendChild(renderPhases(t));

  var bits = [];
  if (inFlight) {
    var age = since(t.startedAt, now);
    bits.push(age === null ? 'alive' : 'alive, ' + dur(age) + ' in');
  } else if (t.activeSeconds !== null && t.activeSeconds !== undefined) {
    bits.push('active ' + dur(t.activeSeconds));
  }
  if (t.pauses) bits.push(t.pauses + ' pause' + (t.pauses === 1 ? '' : 's'));
  if (t.branch) bits.push(t.branch);
  if (t.attemptResults && t.attemptResults.length) bits.push(t.attemptResults.join(' -> '));
  if (bits.length) box.appendChild(el('div', 'facts', bits.join('  |  ')));

  // The storage row answers "where is this task's stuff". A queued task has none of it
  // yet, and four cells reading unknown/never/none is worse than saying nothing.
  if (t.state === 'queued') {
    if (t.degraded && t.degraded.length) box.appendChild(degChips(t.degraded, !live));
    return box;
  }

  var store = el('div', 'store');
  var ws = el('div', 'cell');
  ws.appendChild(el('i', null, 'workspace'));
  ws.appendChild(el('u', null, t.workspace && t.workspace.state ? t.workspace.state : 'unknown'));
  store.appendChild(ws);

  var st = el('div', 'cell');
  st.appendChild(el('i', null, 'status written'));
  st.appendChild(el('u', null, t.lastWrite ? clock(t.lastWrite) : 'never'));
  store.appendChild(st);

  var ar = el('div', 'cell');
  ar.appendChild(el('i', null, 'artifacts'));
  ar.appendChild(el('u', null, run.runId ? 'runs/' + run.runId : 'not collected'));
  store.appendChild(ar);

  var pr = el('div', 'cell');
  pr.appendChild(el('i', null, 'pull request'));
  // Deliberately text, never a link: every href on this page starts with '#', because a
  // page naming private work must not be able to reach out. Copy the id and open it.
  pr.appendChild(el('u', null, t.prUrl ? bare(t.prUrl) : 'none yet'));
  store.appendChild(pr);
  box.appendChild(store);

  if (t.degraded && t.degraded.length) box.appendChild(degChips(t.degraded, !live));
  return box;
}

// The head of a live project: the full identity row.
function liveHead(p) {
  var head = el('div', 'phead');
  head.appendChild(el('span', 'pname', p.name || p.key));
  head.appendChild(el('span', 'ppath', p.path || p.remote || p.key));
  var lamp = el('span', 'lamp on');
  lamp.appendChild(el('b'));
  lamp.appendChild(el('span', null, 'live'));
  head.appendChild(lamp);
  return head;
}

// The head of an idle project: one line that answers "anything to see here?" without
// opening it. The corpus holds one project per historical fixture target, so a host with
// a long history has dozens of these; a full card each buries the run someone opened the
// page to watch. Collapsed by default, and native details/summary so no href is needed.
function idleSummary(p, run) {
  var s = el('summary', 'phead');
  s.appendChild(el('span', 'pname', p.name || p.key));
  var bits = el('span', 'sumbits');
  var outcomes = {};
  (run.tasks || []).forEach(function (t) {
    if (t.outcome) outcomes[t.outcome] = (outcomes[t.outcome] || 0) + 1;
  });
  var names = Object.keys(outcomes).sort();
  if (names.length) {
    names.forEach(function (o) {
      bits.appendChild(el('span', outcomeClass(o), outcomes[o] + ' ' + o));
    });
  } else {
    bits.appendChild(el('span', 'pill', run.runId ? 'no task rows' : 'no run'));
  }
  s.appendChild(bits);
  s.appendChild(el('span', 'ppath', run.finishedAt
    ? 'last run finished ' + clock(run.finishedAt)
    : (run.startedAt ? 'last run started ' + clock(run.startedAt) : '')));
  var lamp = el('span', 'lamp');
  lamp.appendChild(el('b'));
  lamp.appendChild(el('span', null, 'idle'));
  s.appendChild(lamp);
  return s;
}

function renderProject(p, now) {
  var run = p.run || {};
  var card = p.live ? el('div', 'proj islive') : el('details', 'proj idleproj');
  card.appendChild(p.live ? liveHead(p) : idleSummary(p, run));
  if (!p.live) {
    if (OPEN[p.key]) card.open = true;
    card.addEventListener('toggle', function () {
      if (card.open) OPEN[p.key] = true; else delete OPEN[p.key];
    });
  }

  var bar = el('div', 'runbar');
  var add = function (label, value) {
    var w = el('span');
    w.appendChild(document.createTextNode(label + ' '));
    w.appendChild(el('s', null, value));
    bar.appendChild(w);
  };
  if (!p.live) add('path', p.path || p.remote || p.key);
  add('run', run.runId || 'none');
  add('started', run.startedAt ? clock(run.startedAt) : '--');
  if (p.live) add('elapsed', dur(since(run.startedAt, now)));
  else if (run.finishedAt) add('finished', clock(run.finishedAt));
  add('concurrency', run.concurrency === null || run.concurrency === undefined ? 'unstated' : run.concurrency);
  add('state', run.state || 'unknown');
  card.appendChild(bar);

  var park = run.park || {};
  if (park.open) {
    var msg = 'Rate-limit park is OPEN for this run - no new task is admitted until the '
      + 'window reopens. ' + (park.cycles || 0) + ' wait cycle(s) spent'
      + (park.until ? ', reported reset ' + clock(park.until) : ', reset time unknown') + '.';
    card.appendChild(el('p', 'park', msg));
  }

  var body = el('div', 'body');
  body.appendChild(el('p', 'lbl', 'queue'));
  body.appendChild(renderFlow(run));

  var tasks = (run.tasks || []).slice().sort(function (a, b) {
    var rank = function (t) {
      if (t.state === 'running' || t.state === 'parked') return 0;
      if (t.state === 'queued') return 1;
      return 2;
    };
    return rank(a) - rank(b) || (a.issueId < b.issueId ? -1 : a.issueId > b.issueId ? 1 : 0);
  });

  if (tasks.length) {
    body.appendChild(el('p', 'lbl', 'tasks'));
    tasks.forEach(function (t) { body.appendChild(renderTask(t, run, now, p.live)); });
  } else {
    body.appendChild(el('p', 'facts', 'no task rows in this run'));
  }

  if (run.queued && run.queued.length) {
    var strip = el('div', 'strip');
    strip.appendChild(el('span', 'pill wait', 'queued in order'));
    run.queued.forEach(function (id) { strip.appendChild(el('span', 'pill', id)); });
    body.appendChild(strip);
  }

  // A run in flight has not written its manifest yet - that file is written when a run
  // ENDS. So no-manifest is the ordinary state of exactly the run this page exists to
  // watch, and alarming on it would mean the live card is always red.
  var pdeg = (p.degraded || []).concat(run.degraded || []);
  var hot = [], calm = [];
  pdeg.forEach(function (d) {
    if (!p.live || (run.state === 'running' && d === 'no-manifest')) calm.push(d);
    else hot.push(d);
  });
  if (hot.length) body.appendChild(degChips(hot, false));
  if (calm.length) body.appendChild(degChips(calm, true));

  card.appendChild(body);
  return card;
}

function paint(state) {
  var list = document.getElementById('list');
  var live = state.projects.filter(function (p) { return p.live; }).length;
  document.getElementById('count').textContent =
    state.projects.length + ' project' + (state.projects.length === 1 ? '' : 's')
    + ' - ' + live + ' live';
  document.getElementById('tick').textContent = 'updated ' + clock(state.now);

  var sig = JSON.stringify(state.projects);
  if (sig === lastSig && !live) return;
  lastSig = sig;

  var next = document.createDocumentFragment();
  if (!state.projects.length) {
    next.appendChild(el('p', 'empty', 'no runs on this host yet'));
  } else {
    // Live projects first, then the rest by name: the reason to have the page open is
    // always at the top, however many idle fixture targets the corpus holds.
    state.projects.slice().sort(function (a, b) {
      if (a.live !== b.live) return a.live ? -1 : 1;
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    }).forEach(function (p) { next.appendChild(renderProject(p, state.now)); });
  }
  list.textContent = '';
  list.appendChild(next);
}

function fail(msg) {
  var box = document.getElementById('err');
  box.textContent = '';
  box.appendChild(el('div', 'fail', msg));
  document.getElementById('tick').textContent = 'stalled';
}

function poll() {
  fetch('/state', { cache: 'no-store' })
    .then(function (r) { return r.json(); })
    .then(function (s) {
      document.getElementById('err').textContent = '';
      paint(s);
    })
    .catch(function () {
      fail('Cannot reach /state. The dashboard process is not running, or it was stopped.');
    });
}

poll();
setInterval(poll, 2000);
</script>
</html>
`;

// ---- the server ---------------------------------------------------------------------------
function send(res, status, type, body) {
  const buf = Buffer.from(body, 'utf8');
  res.writeHead(status, {
    'Content-Type': type,
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
  });
  res.end(buf);
}

function handle(req, res, runsRoot) {
  const url = String(req.url || '');
  const q = url.indexOf('?');
  const route = q < 0 ? url : url.slice(0, q);

  if (route === '/') return send(res, 200, 'text/html; charset=utf-8', PAGE);
  if (route === '/state') {
    let body;
    try {
      body = JSON.stringify(buildState(runsRoot));
    } catch (e) {
      // Never a 500: a tree this reader cannot walk at all is still an answer with a shape
      // the page can render. The alternative is a blank screen with no explanation.
      body = JSON.stringify({ schema: 1, now: new Date().toISOString(), projects: [] });
    }
    return send(res, 200, 'application/json; charset=utf-8', body);
  }
  // There is no static-file route, so no path traversal exists to defend against.
  return send(res, 404, 'text/plain; charset=utf-8', 'not found\n');
}

function main() {
  const runsRoot = resolveRoot();
  const port = resolvePort();
  const server = http.createServer((req, res) => handle(req, res, runsRoot));

  // A taken port is the expected collision (the default is fixed, and a second dashboard is
  // an easy thing to start). One line naming it, exit 1, and no stack trace: a trace here
  // reads as a crash in a tool whose whole promise is that it cannot break anything.
  server.on('error', (e) => {
    const why = e && e.code === 'EADDRINUSE' ? `${HOST}:${port} is already in use` : `cannot listen on ${HOST}:${port}`;
    fs.writeSync(2, `dashboard: ${why}\n`);
    process.exit(1);
  });

  // 127.0.0.1 explicitly. `listen(port)` alone binds every interface, which would publish a
  // page naming target repos, PR URLs and issue titles on the local network.
  server.listen(port, HOST, () => {
    // fs.writeSync, not process.stdout.write: an explicit exit truncates a pending async
    // write to a pipe, and this line is how a caller learns the ephemeral port.
    fs.writeSync(1, `dashboard: http://${HOST}:${server.address().port}/\n`);
  });
}

if (require.main === module) main();

module.exports = {
  buildState, canonicalTarget, isHolderLive, readLog, readyQueueIds, readPark,
  resolveRoot, resolvePort, displayName, PAGE,
};
