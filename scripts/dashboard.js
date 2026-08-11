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
  body { font: 16px/1.6 system-ui, sans-serif; margin: 0; padding: 3rem 1.5rem;
         background: #10131a; color: #d7dce5; }
  main { max-width: 46rem; margin: 0 auto; }
  h1 { font-size: 1.4rem; margin: 0 0 1rem; letter-spacing: .02em; }
  code { background: #1b202b; border-radius: 4px; padding: .1em .4em; color: #9fd0ff; }
  p { margin: 0 0 1rem; }
  .dim { color: #7a8496; font-size: .9rem; }
</style>
<main>
  <h1>pipeline dashboard</h1>
  <p>This is the placeholder page. The live view &mdash; the lit pipeline diagrams, the
     per-project channel strip and the storage row &mdash; ships separately, built against
     the frozen state contract this server already serves.</p>
  <p>The contract is live now at <code>/state</code>: one JSON document, re-read from the
     run tree on every request, <code>schema</code> 1.</p>
  <p class="dim">A pure reader. It binds loopback only, writes nothing anywhere, and can
     never gate a run.</p>
</main>
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
