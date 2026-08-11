// Frozen acceptance test — the live-dashboard reader and its frozen /state contract
// (DESIGN.md §5, change-log row `live-dashboard`; planning draft 2026-08-10, Task 2,
// issue repo-kfg). Written before implementation, from the spec alone; criteria C1–C6
// map 1:1 to the task's "Done means" list — see README.md beside this file for the map.
//
// Plain Node, Docker-free: it builds a throwaway two-project runs root under the OS
// temp dir and drives the future scripts/dashboard.js as a child through
// process.execPath, reaching the fixture via the DASHBOARD_RUNS_DIR seam and an
// ephemeral port via DASHBOARD_PORT=0. All ids, titles, paths and URLs are invented;
// every host is example.invalid; every fixture path lives under this test's temp root.
// Nothing here is required from repo code: the lock-record shape, the canonical-path
// fold and the run.log line shape are inlined, because a frozen test that imports
// mutable code can change what it gates without its own text changing (CLAUDE.md §3.1).
//
// THE FROZEN INTERFACE (from the approved draft, pinned here so the test can exist):
//   node scripts/dashboard.js
//     - binds 127.0.0.1 only; DASHBOARD_PORT (default 4770, 0 = ephemeral, blank has
//       no pin here); announces exactly one stdout line `dashboard: http://127.0.0.1:<port>/`.
//     - DASHBOARD_RUNS_DIR selects the runs root (blank = unset; default resolves from
//       the script's own location, never the cwd).
//     - GET /       -> placeholder page, 200 text/html, self-contained scheme-level
//                      (no `://`, no `src=`, no `@import`, every href starts with `#`).
//     - GET /state  -> the frozen JSON contract, application/json, Cache-Control:
//                      no-store, re-read from the tree per request; the only
//                      per-poll-varying field is `now`.
//     - anything else -> 404 with the exact body `not found\n`.
//     - a taken port: exit 1, one stderr line starting `dashboard: `, no stack trace.
//     - a pure reader: writes nothing anywhere, spawns nothing, node built-ins only,
//       no child_process anywhere.
//   Held lock records are minted at TEST time (fresh takenAtMs/uptimeSeconds, this
//   test's own pid) so the liveness copy inside the dashboard sees a live holder; the
//   stale fixture is the pre-boot takenAtMs falsifier. Timestamps are computed from the
//   clock at run time, never hardcoded.
'use strict';
const fs = require('fs');
const os = require('os');
const net = require('net');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'dashboard.js');
const WRAPPER = path.join(ROOT, 'scripts', 'test-dashboard.sh');
const UNIT = path.join(ROOT, 'tests', 'unit', 'dashboard.test.js');

let failed = 0;
function check(name, cond) {
  console.log(`${cond ? 'ok' : 'FAIL'} - ${name}`);
  if (!cond) failed = 1;
  return !!cond;
}
function skipLine(name) { console.log(`skip - ${name}`); }
function note(msg) { console.log(`# ${msg}`); }
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const has = (arr, term) => Array.isArray(arr) && arr.includes(term);
const byteSort = (arr) => [...arr].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex');

// The lock's canonical-target rule, re-implemented inline (resolve, realpath,
// lowercase on win32 only) — the same fold the dashboard must re-apply.
function canon(p) {
  let s = String(p).trim();
  if (process.platform === 'win32') s = s.replace(/\//g, '\\');
  s = path.resolve(s);
  try { s = fs.realpathSync.native ? fs.realpathSync.native(s) : fs.realpathSync(s); } catch { /* not created yet */ }
  if (process.platform === 'win32') s = s.toLowerCase();
  return s;
}

// Recursive path + content-hash snapshot, byte-wise sorted (never locale collation).
function snapshot(root) {
  const map = new Map();
  if (!fs.existsSync(root)) return map;
  (function walk(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      const p = path.join(dir, e.name);
      const rel = path.relative(root, p).split(path.sep).join('/');
      if (e.isDirectory()) { map.set(`${rel}/`, 'dir'); walk(p); }
      else if (e.isFile()) map.set(rel, sha1(fs.readFileSync(p)));
    }
  }(root));
  return map;
}
function sameSnapshot(a, b) {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

// ---- C6 runs on both the red and the green path ---------------------------------------
function runC6() {
  check('C6 scripts/test-dashboard.sh exists', fs.existsSync(WRAPPER));
  check('C6 tests/unit/dashboard.test.js exists', fs.existsSync(UNIT));
  if (!fs.existsSync(WRAPPER)) {
    console.log('FAIL - C6 wrapper drive: not testable, scripts/test-dashboard.sh does not exist');
    failed = 1;
    return;
  }
  // Poisoned seams: the wrapper must unset both before running the suite, so a caller's
  // exported junk cannot aim the suite at a real corpus or a dead port.
  const env = { ...process.env, DASHBOARD_RUNS_DIR: '/nonexistent', DASHBOARD_PORT: '1' };
  delete env.NODE_OPTIONS;
  delete env.NODE_DEBUG;
  const suite = spawnSync('sh', [path.join('scripts', 'test-dashboard.sh')],
    { cwd: ROOT, encoding: 'utf8', env, timeout: 300000 });
  const out = `${suite.stdout || ''}\n${suite.stderr || ''}`;
  const oks = (out.match(/^ok - /gm) || []).length;
  const fails = (out.match(/^FAIL/gm) || []).length;
  check('C6 sh scripts/test-dashboard.sh exits 0 with the seams poisoned', suite.status === 0);
  check('C6 the suite prints at least 35 "ok - " lines, counted here (a `node --test` harness would print none)', oks >= 35);
  check('C6 the suite prints zero FAIL lines', fails === 0);
}

// ---- red today: the script this suite gates does not exist yet ------------------------
if (!fs.existsSync(SCRIPT)) {
  console.log('FAIL - scripts/dashboard.js does not exist (this frozen suite gates its future implementation)');
  console.log('FAIL - C1 two-project /state joins: not testable, scripts/dashboard.js does not exist');
  console.log('FAIL - C2 frozen shape, determinism, freshness: not testable, scripts/dashboard.js does not exist');
  console.log('FAIL - C3 degraded vocabulary at pinned levels: not testable, scripts/dashboard.js does not exist');
  console.log('FAIL - C4 server contract: not testable, scripts/dashboard.js does not exist');
  console.log('FAIL - C5 pure reader proved both ways: not testable, scripts/dashboard.js does not exist');
  failed = 1;
  runC6();
  process.exit(1);
}
check('scripts/dashboard.js exists', true);

// ---- fixture: two projects under one runs root ----------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-kfg-'));
const fixRoot = path.join(tmp, 'fix');
const runsRoot = path.join(fixRoot, 'runs');
const locksDir = path.join(runsRoot, 'locks');
const targetsDir = path.join(fixRoot, 'targets');
for (const d of [runsRoot, locksDir, targetsDir]) fs.mkdirSync(d, { recursive: true });

const NOW = Date.now();
const isoAt = (ms) => new Date(ms).toISOString();

// Project A: a live run, held lock minted at test time, manifest-less.
const RUN_A = 'run-alpha-001';
const RUN_A2 = 'run-alpha-002';                        // newer decoy — the lock must win
const tgtA = path.join(targetsDir, 'alpha-app');
fs.mkdirSync(tgtA, { recursive: true });
const KEY_A = canon(tgtA);
// Two spellings of one repo, platform-safe: a trailing separator and a `./` segment.
const tgtASpellLock = tgtA + path.sep;
const tgtASpellLog = `${targetsDir}${path.sep}.${path.sep}alpha-app`;

const wsA101 = path.join(fixRoot, 'ws', 'app-101');
const wsA101Status = path.join(wsA101, '.run', 'status.json');
fs.mkdirSync(path.dirname(wsA101Status), { recursive: true });

const tA = (s) => isoAt(NOW - 2 * 3600 * 1000 + s * 1000);
const RESET_ISO = isoAt(NOW + 30 * 60 * 1000);
const TITLE_A101 = 'Fix the loader — align the em dash path';

const runALog = path.join(runsRoot, RUN_A, 'run.log');
fs.mkdirSync(path.dirname(runALog), { recursive: true });
const runALogLines = [
  `${tA(0)} INFO [${RUN_A}/preflight] target: ${tgtASpellLog} -> https://example.invalid/alpha-app.git`,
  `${tA(1)} INFO [${RUN_A}/preflight] project lock held for ${tgtA}`,
  `${tA(2)} INFO [${RUN_A}/preflight] token loaded from the env file (never logged)`,
  `${tA(3)} INFO [${RUN_A}/preflight] ready queue: 4 task(s) — app-101, app-102, app-103, app-104; skipped 1 by type: app-900 (epic)`,
  `${tA(4)} INFO [${RUN_A}/app-101] starting task (priority 2): ${TITLE_A101}`,
  `${tA(5)} INFO [${RUN_A}/app-101] workspace ready: ${wsA101} on task/app-101 (fork point 0a1b2c3d)`,
  `${tA(6)} INFO [${RUN_A}/app-101] launching container task-app-101 (budget 45m active)`,
  `${tA(7)} INFO [${RUN_A}/app-102] starting task (priority 2): Tidy the manifest writer`,
  `${tA(8)} INFO [${RUN_A}/app-102] rate limit hit (pause 1) — parking the task; issue stays in_progress`,
  `${tA(9)} INFO [${RUN_A}/app-102] rate limit: opening the run-level wait (1/6 cycles spent)`,
  `${tA(10)} INFO [${RUN_A}/app-102] paused: waiting until reported reset ${RESET_ISO} (30m)`,
  `${tA(11)} ERROR [${RUN_A}/app-103] refused: the run-level rate-limit pause cap has fired; nothing launched, issue stays open`,
];
const runALogText = `${runALogLines.join('\n')}\n`;
fs.writeFileSync(runALog, runALogText);

// The decoy: a newer manifest-less dir for the same project. The live lock names RUN_A,
// so the join must go through the lock's runId, never "newest wins".
const tA2 = (s) => isoAt(NOW - 30 * 60 * 1000 + s * 1000);
fs.mkdirSync(path.join(runsRoot, RUN_A2), { recursive: true });
fs.writeFileSync(path.join(runsRoot, RUN_A2, 'run.log'),
  `${tA2(0)} INFO [${RUN_A2}/preflight] target: ${tgtA} -> https://example.invalid/alpha-app.git\n`
  + `${tA2(1)} INFO [${RUN_A2}/preflight] token loaded from the env file (never logged)\n`);

// app-101's live workspace status: phase verify, one failed attempt.
const statusA101 = {
  issueId: 'app-101',
  phase: 'verify',
  attempts: [{ number: 1, verifierResult: 'fail', timestamp: tA(60) }],
};
fs.writeFileSync(wsA101Status, `${JSON.stringify(statusA101, null, 2)}\n`);
const LASTWRITE_A101 = fs.statSync(wsA101Status).mtime.toISOString();

// The held lock, minted NOW: this process's pid, fresh takenAtMs/uptimeSeconds.
function lockRecord(runId, target, overrides) {
  return {
    runId,
    pid: process.pid,
    target,
    host: 'example.invalid',
    platform: process.platform,
    startedAt: new Date().toISOString(),
    takenAtMs: Date.now(),
    uptimeSeconds: Math.floor(os.uptime()),
    procStart: null,
    ...overrides,
  };
}
function writeLock(name, rec) {
  const file = path.join(locksDir, `${name}-${sha1(rec.target || name).slice(0, 12)}.lock`);
  fs.writeFileSync(file, `${JSON.stringify(rec, null, 2)}\n`);
  return file;
}
const lockARec = lockRecord(RUN_A, tgtASpellLock);
writeLock('alpha-app', lockARec);

// Project B: idle — no lock, a finished run, identity from the manifest URL only.
const RUN_B = 'run-beta-001';
const KEY_B = 'https://example.invalid/beta-game.git';
const B_STARTED = isoAt(NOW - 90 * 60 * 1000);
const B_FINISHED = isoAt(NOW - 40 * 60 * 1000);
const manifestB = {
  runId: RUN_B,
  startedAt: B_STARTED,
  finishedAt: B_FINISHED,
  targetRepo: KEY_B,
  concurrency: 4,
  tasks: [{
    issueId: 'app-201', title: 'Ship the collector', outcome: 'done', exitCode: 0,
    branch: 'task/app-201', pushed: true, prUrl: 'https://example.invalid/pr/9',
    attempts: 2, pauses: 0, activeSeconds: 321, diffLines: 44,
  }],
};
fs.mkdirSync(path.join(runsRoot, RUN_B), { recursive: true });
fs.writeFileSync(path.join(runsRoot, RUN_B, 'run.json'), `${JSON.stringify(manifestB, null, 2)}\n`);
const collectedB = path.join(runsRoot, RUN_B, 'tasks', 'app-201', 'status.json');
fs.mkdirSync(path.dirname(collectedB), { recursive: true });
fs.writeFileSync(collectedB, `${JSON.stringify({
  issueId: 'app-201',
  phase: 'docs',
  attempts: [
    { number: 1, verifierResult: 'fail', timestamp: isoAt(NOW - 80 * 60 * 1000) },
    { number: 2, verifierResult: 'pass', timestamp: isoAt(NOW - 50 * 60 * 1000) },
  ],
}, null, 2)}\n`);
const LASTWRITE_B201 = fs.statSync(collectedB).mtime.toISOString();

// Root noise the run-dir predicate must skip: a plain file, and a directory holding
// neither run.log nor run.json. `locks` and `sweeps` are excluded by name.
fs.writeFileSync(path.join(runsRoot, 'stray.txt'), 'not a run directory\n');
fs.mkdirSync(path.join(runsRoot, 'hollow'), { recursive: true });
fs.mkdirSync(path.join(runsRoot, 'sweeps', '20260101-000000'), { recursive: true });
fs.writeFileSync(path.join(runsRoot, 'sweeps', '20260101-000000', 'summary.txt'), 'sweep\n');

// ---- dedicated child directories (criterion 4/5: scrubbed, redirected env) ------------
function mkdirs(...names) {
  return names.map((n) => { const d = path.join(tmp, n); fs.mkdirSync(d, { recursive: true }); return d; });
}
const [homeMain, tmpMain, cwdMain, homeC5, tmpC5, cwdC5, homeAux, tmpAux, cwdX, cwdY, cwdZ] =
  mkdirs('home-main', 'tmp-main', 'cwd-main', 'home-c5', 'tmp-c5', 'cwd-c5',
    'home-aux', 'tmp-aux', 'cwd-x', 'cwd-y', 'cwd-z');

function childEnv(overrides, home, tmpdir) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k === 'NODE_OPTIONS' || k === 'NODE_DEBUG') continue;
    if (/^DASHBOARD_/i.test(k)) continue;
    env[k] = v;
  }
  env.HOME = home;
  env.TMPDIR = tmpdir;
  env.TEMP = tmpdir;
  env.TMP = tmpdir;
  return Object.assign(env, overrides);
}

// ---- child plumbing -------------------------------------------------------------------
const kids = [];
const READY_RE = /^dashboard: http:\/\/127\.0\.0\.1:(\d+)\/$/m;

function startDashboard(opts) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [opts.script || SCRIPT],
      { env: opts.env, cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    kids.push(child);
    let out = '';
    let err = '';
    let done = false;
    const finish = (r) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
    // A ready line that never comes must FAIL, never hang the sweep.
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      finish({ ok: false, why: 'no ready line within 10s', child, out: () => out, err: () => err });
    }, 10000);
    child.stdout.on('data', (d) => {
      out += d;
      const m = out.match(READY_RE);
      if (m) finish({ ok: true, port: Number(m[1]), child, out: () => out, err: () => err });
    });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => finish({ ok: false, why: `spawn failed: ${e.message}`, child, out: () => out, err: () => err }));
    child.on('exit', (code) => finish({ ok: false, why: `exited ${code} before the ready line`, child, out: () => out, err: () => err }));
  });
}
function stop(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return resolve();
    child.on('exit', () => resolve());
    try { child.kill(); } catch { resolve(); }
  });
}
function runToExit(env, cwd) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT], { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    kids.push(child);
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      resolve({ timedOut: true, code: null, out, err });
    }, 10000);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('exit', (code) => { clearTimeout(timer); resolve({ timedOut: false, code, out, err }); });
  });
}
function get(port, reqPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: reqPath, method: 'GET' }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.setTimeout(10000, () => req.destroy(new Error(`request timeout: ${reqPath}`)));
    req.on('error', reject);
    req.end();
  });
}
async function getState(port) {
  const res = await get(port, '/state');
  let st = null;
  try { st = JSON.parse(res.body); } catch { /* asserted by callers */ }
  return { res, st };
}
const noNow = (body) => String(body).replace(/("now"\s*:\s*)"[^"]*"/, '$1"NOW"');
const proj = (st, key) => ((st && Array.isArray(st.projects)) ? st.projects.find((p) => p && p.key === key) : undefined);
const task = (p, id) => ((p && p.run && Array.isArray(p.run.tasks)) ? p.run.tasks.find((t) => t && t.issueId === id) : undefined);
function connectFails(host, port) {
  return new Promise((resolve) => {
    let s;
    try { s = net.connect({ host, port }); } catch { return resolve(true); }
    const done = (v) => { try { s.destroy(); } catch { /* gone */ } resolve(v); };
    s.setTimeout(3000, () => done(true));   // no answer is not a success
    s.on('connect', () => done(false));     // success is the failure
    s.on('error', () => done(true));        // any error is a pass
  });
}
function ownProcStart() {
  try {
    const raw = fs.readFileSync('/proc/self/stat', 'utf8');
    const close = raw.lastIndexOf(')');
    if (close < 0) return null;
    const fields = raw.slice(close + 1).trim().split(/\s+/);
    return fields.length > 19 ? fields[19] : null;
  } catch { return null; }
}

// The frozen /state key sets — a whitelist compare at every level, so an added key
// fails loudly instead of drifting in silently.
const SHAPE = {
  top: ['schema', 'now', 'projects'],
  project: ['key', 'name', 'path', 'remote', 'live', 'degraded', 'lock', 'run'],
  lock: ['state', 'runId', 'pid', 'since'],
  run: ['runId', 'state', 'startedAt', 'finishedAt', 'concurrency', 'park', 'queued', 'degraded', 'tasks'],
  park: ['open', 'cycles', 'until'],
  task: ['issueId', 'title', 'state', 'phase', 'attempt', 'attemptsMax', 'attemptResults', 'outcome',
    'prUrl', 'branch', 'pauses', 'startedAt', 'activeSeconds', 'lastWrite', 'workspace', 'degraded'],
  workspace: ['state', 'path'],
};
function shapeProblems(st) {
  const probs = [];
  const need = (obj, keys, where) => {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) { probs.push(`${where}: not an object`); return false; }
    const have = byteSort(Object.keys(obj));
    const want = byteSort(keys);
    if (!eq(have, want)) probs.push(`${where}: keys [${have.join(',')}] != frozen [${want.join(',')}]`);
    return true;
  };
  if (!need(st, SHAPE.top, '$')) return probs;
  if (!Array.isArray(st.projects)) { probs.push('$.projects: not an array'); return probs; }
  st.projects.forEach((p, i) => {
    const w = `$.projects[${i}]`;
    if (!need(p, SHAPE.project, w)) return;
    need(p.lock, SHAPE.lock, `${w}.lock`);
    if (need(p.run, SHAPE.run, `${w}.run`)) {
      need(p.run.park, SHAPE.park, `${w}.run.park`);
      if (!Array.isArray(p.run.tasks)) probs.push(`${w}.run.tasks: not an array`);
      else p.run.tasks.forEach((t, j) => {
        const tw = `${w}.run.tasks[${j}]`;
        if (need(t, SHAPE.task, tw)) need(t.workspace, SHAPE.workspace, `${tw}.workspace`);
      });
    }
  });
  return probs;
}

// ---- the drives -----------------------------------------------------------------------
const watchdog = setTimeout(() => {
  console.log('FAIL - global watchdog: the suite exceeded 540s (a server or request hung)');
  for (const k of kids) { try { k.kill(); } catch { /* gone */ } }
  process.exit(1);
}, 540000);

async function main() {
  const main1 = await startDashboard({
    env: childEnv({ DASHBOARD_RUNS_DIR: runsRoot, DASHBOARD_PORT: '0' }, homeMain, tmpMain),
    cwd: cwdMain,
  });
  if (!check(`C4 the dashboard starts and announces its port on one stdout line (${main1.ok ? 'ready' : main1.why})`, main1.ok)) {
    console.log('FAIL - C1 two-project /state joins: not testable, the dashboard did not start');
    console.log('FAIL - C2 frozen shape, determinism, freshness: not testable, the dashboard did not start');
    console.log('FAIL - C3 degraded vocabulary: not testable, the dashboard did not start');
    console.log('FAIL - C5 pure reader: not testable, the dashboard did not start');
    failed = 1;
    runC6();
    return;
  }
  const port = main1.port;

  // ==== C1: the two-project fixture answers /state with the right joins ================
  {
    const { res, st } = await getState(port);
    check('C1 GET /state answers 200 with parseable JSON', res.status === 200 && !!st);
    check('C1 schema is the number 1', !!st && st.schema === 1);
    check('C1 now is a parseable ISO timestamp', !!st && typeof st.now === 'string' && !Number.isNaN(Date.parse(st.now)));
    check('C1 exactly two projects (the plain file, the hollow dir, locks and sweeps produce none)',
      !!st && Array.isArray(st.projects) && st.projects.length === 2);
    if (st && Array.isArray(st.projects)) {
      const keys = st.projects.map((p) => p && p.key);
      check('C1 projects sort byte-wise by key', eq(keys, byteSort(keys)));
    }
    const A = proj(st, KEY_A);
    check('C1 the trailing-separator lock spelling and the ./-segment log spelling fold to ONE project keyed canonically',
      !!A);
    check('C1 project A name is the key\'s last segment', !!A && A.name === 'alpha-app');
    check('C1 project A path is the local target (canon-equal to the key)',
      !!A && typeof A.path === 'string' && canon(A.path) === KEY_A);
    check('C1 project A remote is null (no manifest names one)', !!A && A.remote === null);
    check('C1 project A is live behind its held lock', !!A && A.live === true);
    check('C1 project A lock reads held with this test\'s pid and the minted runId',
      !!A && !!A.lock && A.lock.state === 'held' && A.lock.pid === process.pid && A.lock.runId === RUN_A);
    check('C1 project A lock.since tracks the minted record (within 120s)',
      !!A && !!A.lock && Math.abs(Date.parse(A.lock.since) - lockARec.takenAtMs) < 120000);
    check('C1 project A degraded is empty', !!A && eq(A.degraded, []));
    const runA = A && A.run;
    check('C1 the live lock\'s runId picks the run — the NEWER manifest-less decoy dir loses',
      !!runA && runA.runId === RUN_A);
    check('C1 run A state is running', !!runA && runA.state === 'running');
    check('C1 run A startedAt is the first run.log line\'s timestamp (no manifest to read)',
      !!runA && runA.startedAt === tA(0));
    check('C1 run A finishedAt is null and concurrency is null — never defaulted',
      !!runA && runA.finishedAt === null && runA.concurrency === null);
    check('C1 run A degraded names no-manifest', !!runA && has(runA.degraded, 'no-manifest'));
    check('C1 park is open with 1 cycle (from the opening line\'s (1/6 cycles spent) suffix)',
      !!runA && !!runA.park && runA.park.open === true && runA.park.cycles === 1);
    check('C1 park.until is the pinned reset line\'s ISO', !!runA && !!runA.park && runA.park.until === RESET_ISO);
    check('C1 run.queued is exactly the never-started ready id', !!runA && eq(runA.queued, ['app-104']));
    const ids = (runA && Array.isArray(runA.tasks)) ? runA.tasks.map((t) => t && t.issueId) : [];
    check('C1 tasks are the four queue ids byte-sorted — no preflight row, no type-skipped app-900',
      eq(ids, ['app-101', 'app-102', 'app-103', 'app-104']));
    const t101 = task(A, 'app-101');
    check('C1 app-101 is running', !!t101 && t101.state === 'running');
    check('C1 app-101 title is the starting-task line\'s payload, em dash intact, verbatim',
      !!t101 && t101.title === TITLE_A101);
    check('C1 app-101 phase is verify (from the live workspace status)', !!t101 && t101.phase === 'verify');
    check('C1 app-101 attempt 1 of attemptsMax 3 (the contract constant)',
      !!t101 && t101.attempt === 1 && t101.attemptsMax === 3);
    check('C1 app-101 attemptResults is ["fail"]', !!t101 && eq(t101.attemptResults, ['fail']));
    check('C1 app-101 lastWrite is the status file\'s mtime as ISO with milliseconds',
      !!t101 && t101.lastWrite === LASTWRITE_A101);
    check('C1 app-101 workspace is live at the workspace-ready line\'s path',
      !!t101 && !!t101.workspace && t101.workspace.state === 'live'
      && typeof t101.workspace.path === 'string' && canon(t101.workspace.path) === canon(wsA101));
    check('C1 app-101 prUrl, branch and outcome are null (manifest-only fields, no manifest), pauses 0',
      !!t101 && t101.prUrl === null && t101.branch === null && t101.outcome === null && t101.pauses === 0);
    check('C1 app-101 degraded is empty', !!t101 && eq(t101.degraded, []));
    const t102 = task(A, 'app-102');
    check('C1 app-102 is parked with pauses 1 (the rate-limit-hit line)',
      !!t102 && t102.state === 'parked' && t102.pauses === 1);
    const t103 = task(A, 'app-103');
    check('C1 app-103 is refused (the ERROR refused line beats its ready-queue mention)',
      !!t103 && t103.state === 'refused');
    const t104 = task(A, 'app-104');
    check('C1 app-104 is queued with an empty title (no manifest, no starting line)',
      !!t104 && t104.state === 'queued' && t104.title === '');

    const B = proj(st, KEY_B);
    check('C1 project B is keyed by the manifest remote URL', !!B);
    check('C1 project B name strips the trailing .git from the last segment', !!B && B.name === 'beta-game');
    check('C1 project B path is null and remote is the manifest URL',
      !!B && B.path === null && B.remote === KEY_B);
    check('C1 project B is idle: live false, lock state none',
      !!B && B.live === false && !!B.lock && B.lock.state === 'none');
    check('C1 project B and run B degraded are empty',
      !!B && eq(B.degraded, []) && !!B.run && eq(B.run.degraded, []));
    const runB = B && B.run;
    check('C1 run B is the finished manifest run', !!runB && runB.runId === RUN_B && runB.state === 'finished');
    check('C1 run B concurrency is the manifest\'s 4 — asserted against the fixture, not the default',
      !!runB && runB.concurrency === 4);
    check('C1 run B startedAt/finishedAt come from the manifest',
      !!runB && runB.startedAt === B_STARTED && runB.finishedAt === B_FINISHED);
    check('C1 run B park is the closed default and queued is empty',
      !!runB && eq(runB.park, { open: false, cycles: 0, until: null }) && eq(runB.queued, []));
    const t201 = task(B, 'app-201');
    check('C1 app-201 is finished with outcome done', !!t201 && t201.state === 'finished' && t201.outcome === 'done');
    check('C1 app-201 prUrl and branch come from the manifest',
      !!t201 && t201.prUrl === 'https://example.invalid/pr/9' && t201.branch === 'task/app-201');
    check('C1 app-201 attempt 2, pauses 0, activeSeconds 321 (manifest fields)',
      !!t201 && t201.attempt === 2 && t201.pauses === 0 && t201.activeSeconds === 321);
    check('C1 app-201 attemptResults ["fail","pass"] from the collected tasks/<id>/status.json',
      !!t201 && eq(t201.attemptResults, ['fail', 'pass']));
    check('C1 app-201 phase docs and lastWrite = the collected status file\'s mtime ISO',
      !!t201 && t201.phase === 'docs' && t201.lastWrite === LASTWRITE_B201);
  }

  // ==== C2: frozen shape, deterministic, fresh =========================================
  {
    const a = await get(port, '/state');
    const b = await get(port, '/state');
    check('C2 two /state calls on an unchanged tree are byte-identical except the value of now',
      noNow(a.body) === noNow(b.body));
    let st = null;
    try { st = JSON.parse(b.body); } catch { /* fails below */ }
    const probs = st ? shapeProblems(st) : ['response did not parse as JSON'];
    for (const p of probs) note(p);
    check('C2 the key set at every level equals the frozen contract exactly (whitelist compare)',
      probs.length === 0);
    // In-place CRLF rewrite of the SAME run.log — no other file touched.
    fs.writeFileSync(runALog, runALogText.split('\n').join('\r\n'));
    const c = await get(port, '/state');
    check('C2 rewriting run.log from LF to CRLF in place leaves /state byte-identical with now held out',
      noNow(b.body) === noNow(c.body));
    // Freshness: an appended task-finished line is visible on the very next request.
    fs.appendFileSync(runALog, `${new Date().toISOString()} INFO [${RUN_A}/app-101] task finished: exit 0 -> done (issue closed)\r\n`);
    const { st: st2 } = await getState(port);
    const t101 = task(proj(st2, KEY_A), 'app-101');
    check('C2 the next /state reflects an appended task-finished line (re-read per request, no startup cache)',
      !!t101 && t101.state === 'finished');
    fs.writeFileSync(runALog, runALogText);       // restore the base fixture
  }

  // ==== C3: every malformed shape is a named degraded state at its pinned level ========
  {
    // The base fixture already carries two planted shapes:
    const { res, st } = await getState(port);
    const A0 = proj(st, KEY_A);
    check('C3 log-but-no-manifest: 200, run-level no-manifest, concurrency and finishedAt present-but-null',
      res.status === 200 && !!A0 && !!A0.run && has(A0.run.degraded, 'no-manifest')
      && 'concurrency' in A0.run && A0.run.concurrency === null
      && 'finishedAt' in A0.run && A0.run.finishedAt === null);
    const t102 = task(A0, 'app-102');
    check('C3 a started task with no workspace-ready line: workspace unknown, task-level workspace-unknown',
      !!t102 && !!t102.workspace && t102.workspace.state === 'unknown'
      && has(t102.degraded, 'workspace-unknown'));

    const intactB = (st2) => {
      const B = proj(st2, KEY_B);
      return !!B && !!B.run && B.run.state === 'finished' && !!task(B, 'app-201');
    };

    // Unreadable manifest, then a manifest that parses to an array (project C).
    const tgtC = path.join(targetsDir, 'gamma-app');
    fs.mkdirSync(tgtC, { recursive: true });
    const runCDir = path.join(runsRoot, 'run-gamma-001');
    fs.mkdirSync(runCDir, { recursive: true });
    fs.writeFileSync(path.join(runCDir, 'run.log'),
      `${isoAt(NOW - 10 * 60 * 1000)} INFO [run-gamma-001/preflight] target: ${tgtC} -> https://example.invalid/gamma-app.git\n`);
    fs.writeFileSync(path.join(runCDir, 'run.json'), '{ this is not json');
    {
      const { res: r, st: s } = await getState(port);
      const C = proj(s, canon(tgtC));
      check('C3 a manifest of unparseable bytes: 200, run-level manifest-unreadable, run state unknown',
        r.status === 200 && !!C && !!C.run && has(C.run.degraded, 'manifest-unreadable') && C.run.state === 'unknown');
      check('C3 ... and the other project still renders completely (unreadable manifest)', intactB(s));
    }
    fs.writeFileSync(path.join(runCDir, 'run.json'), '[1, 2, 3]\n');
    {
      const { res: r, st: s } = await getState(port);
      const C = proj(s, canon(tgtC));
      check('C3 a manifest that parses to an array: manifest-unreadable, never state finished',
        r.status === 200 && !!C && !!C.run && has(C.run.degraded, 'manifest-unreadable') && C.run.state !== 'finished');
    }
    fs.rmSync(runCDir, { recursive: true, force: true });

    // Status file of unparseable bytes (app-101's live workspace).
    fs.writeFileSync(wsA101Status, 'not json {{{ \x01\x02');
    {
      const { res: r, st: s } = await getState(port);
      const t = task(proj(s, KEY_A), 'app-101');
      check('C3 a status file of unparseable bytes: task-level status-unreadable, phase present-but-null',
        r.status === 200 && !!t && has(t.degraded, 'status-unreadable') && 'phase' in t && t.phase === null);
      check('C3 ... and the other project still renders completely (unreadable status)', intactB(s));
    }
    // Status.json as a directory where a file belongs — the same named state.
    fs.rmSync(wsA101Status, { force: true });
    fs.mkdirSync(wsA101Status);
    {
      const { res: r, st: s } = await getState(port);
      const t = task(proj(s, KEY_A), 'app-101');
      check('C3 a directory where status.json belongs: still status-unreadable, still 200',
        r.status === 200 && !!t && has(t.degraded, 'status-unreadable'));
    }
    fs.rmdirSync(wsA101Status);
    {
      const { res: r, st: s } = await getState(port);
      const t = task(proj(s, KEY_A), 'app-101');
      check('C3 a missing status file: task-level status-missing, lastWrite present-but-null',
        r.status === 200 && !!t && has(t.degraded, 'status-missing') && 'lastWrite' in t && t.lastWrite === null);
    }
    // Workspace directory gone.
    fs.renameSync(wsA101, `${wsA101}.away`);
    {
      const { res: r, st: s } = await getState(port);
      const t = task(proj(s, KEY_A), 'app-101');
      check('C3 a vanished workspace directory: workspace state missing, task-level workspace-missing',
        r.status === 200 && !!t && !!t.workspace && t.workspace.state === 'missing' && has(t.degraded, 'workspace-missing'));
    }
    fs.renameSync(`${wsA101}.away`, wsA101);
    // Status without phase, then an out-of-vocabulary phase — both fold to phase-unknown.
    fs.writeFileSync(wsA101Status, `${JSON.stringify({ issueId: 'app-101', attempts: statusA101.attempts }, null, 2)}\n`);
    {
      const { st: s } = await getState(port);
      const t = task(proj(s, KEY_A), 'app-101');
      check('C3 a status file without phase: phase null plus task-level phase-unknown',
        !!t && t.phase === null && has(t.degraded, 'phase-unknown'));
    }
    fs.writeFileSync(wsA101Status, `${JSON.stringify({ ...statusA101, phase: 'review' }, null, 2)}\n`);
    {
      const { st: s } = await getState(port);
      const t = task(proj(s, KEY_A), 'app-101');
      check('C3 an out-of-vocabulary phase ("review") folds to phase-unknown with phase null',
        !!t && t.phase === null && has(t.degraded, 'phase-unknown'));
      check('C3 ... while the rest of the same file is still read (attemptResults survive the fold)',
        !!t && eq(t.attemptResults, ['fail']));
    }
    fs.writeFileSync(wsA101Status, `${JSON.stringify(statusA101, null, 2)}\n`);   // restore

    // A lock of unparseable bytes.
    const badLock = path.join(locksDir, 'zeta-badbytes.lock');
    fs.writeFileSync(badLock, 'runId=?? not json \x00\x01');
    {
      const { res: r, st: s } = await getState(port);
      const carrier = (s && Array.isArray(s.projects))
        ? s.projects.find((p) => p && has(p.degraded, 'lock-unreadable')) : undefined;
      check('C3 a lock of unparseable bytes: 200 and some project carries project-level lock-unreadable',
        r.status === 200 && !!carrier);
      check('C3 ... and both real projects still render (unreadable lock)',
        !!proj(s, KEY_A) && intactB(s));
    }
    fs.rmSync(badLock, { force: true });

    // The stale lock: the pre-reboot takenAtMs falsifier, everything else fresh.
    const tgtD = path.join(targetsDir, 'delta-app');
    fs.mkdirSync(tgtD, { recursive: true });
    const runDDir = path.join(runsRoot, 'run-delta-001');
    fs.mkdirSync(runDDir, { recursive: true });
    fs.writeFileSync(path.join(runDDir, 'run.log'),
      `${isoAt(NOW - 20 * 60 * 1000)} INFO [run-delta-001/preflight] target: ${tgtD} -> https://example.invalid/delta-app.git\n`);
    const staleTaken = Date.now() - (os.uptime() * 1000 + 30 * 60 * 1000);
    const lockD = writeLock('delta-app', lockRecord('run-delta-001', tgtD, {
      takenAtMs: staleTaken, startedAt: isoAt(staleTaken),
    }));
    {
      const { res: r, st: s } = await getState(port);
      const D = proj(s, canon(tgtD));
      check('C3 a pre-boot takenAtMs renders the lock stale and the project live: false',
        r.status === 200 && !!D && !!D.lock && D.lock.state === 'stale' && D.live === false);
      check('C3 ... with project-level lock-stale named', !!D && has(D.degraded, 'lock-stale'));
    }
    fs.rmSync(lockD, { force: true });
    fs.rmSync(runDDir, { recursive: true, force: true });

    // A held live lock naming a runId with no run directory.
    const tgtE = path.join(targetsDir, 'echo-app');
    fs.mkdirSync(tgtE, { recursive: true });
    const lockE = writeLock('echo-app', lockRecord('run-echo-001', tgtE));
    {
      const { res: r, st: s } = await getState(port);
      const E = proj(s, canon(tgtE));
      check('C3 a live lock naming a runId with no directory: run-level run-missing, still 200',
        r.status === 200 && !!E && !!E.run && has(E.run.degraded, 'run-missing'));
      check('C3 ... and the other project still renders completely (missing run dir)', intactB(s));
    }
    fs.rmSync(lockE, { force: true });

    // No target identity anywhere: one project per orphan run dir, keyed unknown:<name>.
    const runFDir = path.join(runsRoot, 'run-foxtrot-001');
    fs.mkdirSync(runFDir, { recursive: true });
    fs.writeFileSync(path.join(runFDir, 'run.log'),
      `${isoAt(NOW - 5 * 60 * 1000)} INFO [run-foxtrot-001/preflight] token loaded from the env file (never logged)\n`
      + `${isoAt(NOW - 5 * 60 * 1000 + 1000)} INFO [run-foxtrot-001/app-301] starting task (priority 2): Orphan work\n`);
    {
      const { res: r, st: s } = await getState(port);
      const F = proj(s, 'unknown:run-foxtrot-001');
      check('C3 no target identity anywhere: project keyed unknown:<runDirName> with target-unknown',
        r.status === 200 && !!F && has(F.degraded, 'target-unknown'));
    }
    fs.rmSync(runFDir, { recursive: true, force: true });

    // The wrong-procStart falsifier — only where /proc/<pid>/stat exists.
    const ticks = ownProcStart();
    if (fs.existsSync('/proc/self/stat') && ticks !== null) {
      const tgtG = path.join(targetsDir, 'golf-app');
      fs.mkdirSync(tgtG, { recursive: true });
      const runGDir = path.join(runsRoot, 'run-golf-001');
      fs.mkdirSync(runGDir, { recursive: true });
      fs.writeFileSync(path.join(runGDir, 'run.log'),
        `${isoAt(NOW - 15 * 60 * 1000)} INFO [run-golf-001/preflight] target: ${tgtG} -> https://example.invalid/golf-app.git\n`);
      const lockG = writeLock('golf-app', lockRecord('run-golf-001', tgtG, { procStart: `${ticks}9` }));
      const { res: r, st: s } = await getState(port);
      const G = proj(s, canon(tgtG));
      check('C3 a live pid with a deliberately wrong procStart renders stale (the pid was recycled)',
        r.status === 200 && !!G && !!G.lock && G.lock.state === 'stale' && G.live === false);
      fs.rmSync(lockG, { force: true });
      fs.rmSync(runGDir, { recursive: true, force: true });
    } else {
      skipLine('C3 wrong-procStart lock renders stale (no /proc/self/stat on this host)');
    }

    // A missing runs/locks/ directory is the ordinary empty case — its own root+server.
    const runsRoot2 = path.join(tmp, 'fix2', 'runs');
    fs.mkdirSync(path.join(runsRoot2, 'run-omega-001'), { recursive: true });
    fs.writeFileSync(path.join(runsRoot2, 'run-omega-001', 'run.json'), `${JSON.stringify({
      runId: 'run-omega-001', startedAt: isoAt(NOW - 3600 * 1000), finishedAt: isoAt(NOW - 3500 * 1000),
      targetRepo: 'https://example.invalid/omega.git', concurrency: 2,
      tasks: [{ issueId: 'app-401', title: 'Only task', outcome: 'done', exitCode: 0, attempts: 1, pauses: 0 }],
    }, null, 2)}\n`);
    const aux = await startDashboard({
      env: childEnv({ DASHBOARD_RUNS_DIR: runsRoot2, DASHBOARD_PORT: '0' }, homeAux, tmpAux),
      cwd: cwdMain,
    });
    if (check('C3 a root with no locks/ directory still serves (a host that has never run)', aux.ok)) {
      const { res: r, st: s } = await getState(aux.port);
      const O = proj(s, 'https://example.invalid/omega.git');
      check('C3 the lockless root is ordinary: 200, lock state none, NO degraded marker anywhere on the project',
        r.status === 200 && !!O && !!O.lock && O.lock.state === 'none'
        && eq(O.degraded, []) && !!O.run && eq(O.run.degraded, []));
      await stop(aux.child);
    } else { failed = 1; }
  }

  // ==== C4: the server contract ========================================================
  {
    const page = await get(port, '/');
    check('C4 GET / is 200 text/html', page.status === 200
      && String(page.headers['content-type'] || '').startsWith('text/html'));
    check('C4 the page carries no "://"', !page.body.includes('://'));
    check('C4 the page carries no "src="', !/src=/i.test(page.body));
    check('C4 the page carries no "@import"', !page.body.includes('@import'));
    const hrefs = [...page.body.matchAll(/href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+))/gi)]
      .map((m) => m[1] ?? m[2] ?? m[3]);
    check('C4 every href value starts with "#"', hrefs.every((h) => typeof h === 'string' && h.startsWith('#')));
    const stateRes = await get(port, '/state');
    check('C4 /state is application/json',
      String(stateRes.headers['content-type'] || '').startsWith('application/json'));
    check('C4 /state is served Cache-Control: no-store',
      String(stateRes.headers['cache-control'] || '') === 'no-store');
    for (const p of ['/nope', '/state/x', '/%2e%2e/DESIGN.md', '/state/../../pipeline.config.json']) {
      const r = await get(port, p);
      check(`C4 ${p} is 404 with the exact body "not found\\n"`, r.status === 404 && r.body === 'not found\n');
    }

    // Loopback, leg one: /proc/net/tcp* says the listener is loopback, never 0.0.0.0/::.
    if (fs.existsSync('/proc/net/tcp')) {
      const hex = port.toString(16).toUpperCase().padStart(4, '0');
      const LOOPBACK = new Set([
        '0100007F',                                   // 127.0.0.1
        '00000000000000000000000001000000',           // ::1
        '0000000000000000FFFF00000100007F',           // ::ffff:127.0.0.1
      ]);
      const listeners = [];
      for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) {
        let raw = '';
        try { raw = fs.readFileSync(f, 'utf8'); } catch { continue; }
        for (const line of raw.split('\n').slice(1)) {
          const cols = line.trim().split(/\s+/);
          if (cols.length < 4) continue;
          const [addr, p] = String(cols[1]).split(':');
          if (p === hex && cols[3] === '0A') listeners.push(addr.toUpperCase());
        }
      }
      check('C4 /proc/net/tcp*: the listening socket is on a loopback address, not 0.0.0.0/::',
        listeners.length >= 1 && listeners.every((a) => LOOPBACK.has(a)));
    } else {
      skipLine('C4 /proc listening-address loopback proof (no /proc/net/tcp on this host)');
    }
    // Leg two: connecting from anywhere that is not loopback must not succeed.
    const external = [];
    for (const list of Object.values(os.networkInterfaces())) {
      for (const a of list || []) if (!a.internal && a.address) external.push(a.address);
    }
    if (external.length) {
      let allFail = true;
      for (const addr of external) {
        if (!(await connectFails(addr, port))) { allFail = false; note(`connect SUCCEEDED via ${addr}`); }
      }
      check('C4 a TCP connect to every non-loopback interface does not succeed (any error is a pass)', allFail);
    } else {
      skipLine('C4 non-loopback connect refusal (host has no non-loopback interface)');
    }
    check('C4 a TCP connect to [::1] does not succeed (the bind is 127.0.0.1 only)',
      await connectFails('::1', port));

    // The taken-port drive: this test binds :0 itself and hands the number over.
    const blocker = await new Promise((resolve, reject) => {
      const srv = net.createServer();
      srv.once('error', reject);
      srv.listen(0, '127.0.0.1', () => resolve(srv));
    });
    const busyPort = blocker.address().port;
    const bumped = await runToExit(
      childEnv({ DASHBOARD_RUNS_DIR: runsRoot, DASHBOARD_PORT: String(busyPort) }, homeAux, tmpAux), cwdMain);
    check('C4 a taken port exits with code 1 (and exits at all)', !bumped.timedOut && bumped.code === 1);
    const errLines = String(bumped.err).split(/\r?\n/).filter((l) => l.trim() !== '');
    check('C4 the taken-port failure is one stderr line starting "dashboard: "',
      errLines.length >= 1 && errLines.filter((l) => l.startsWith('dashboard: ')).length === 1);
    check('C4 the taken-port failure carries no stack-trace line', !/^\s+at /m.test(String(bumped.err)));
    await new Promise((resolve) => blocker.close(resolve));
  }

  // ==== C5: a pure reader, proved both ways, from anywhere =============================
  {
    const src = fs.readFileSync(SCRIPT, 'utf8');
    const builtins = new Set(require('module').builtinModules);
    const required = [...src.matchAll(/require\s*\(\s*(['"])([^'"]+)\1\s*\)/g)].map((m) => m[2]);
    const offenders = required.filter((r) => !builtins.has(r.replace(/^node:/, '')));
    for (const o of offenders) note(`non-builtin require: ${o}`);
    check('C5 every require (node: stripped) is a node built-in — nothing from runner/ or npm',
      required.length > 0 && offenders.length === 0);
    check('C5 the source contains no child_process token anywhere', !src.includes('child_process'));

    // The pinned drive: snapshots bracket a dedicated child that serves GET /, three
    // /state and one 404, with HOME/TMPDIR/TEMP/TMP pointed at dedicated empty dirs.
    const scriptsDir = path.join(ROOT, 'scripts');
    const before = {
      fix: snapshot(fixRoot),
      scripts: snapshot(scriptsDir),
      home: snapshot(homeC5),
      tmp: snapshot(tmpC5),
      cwd: snapshot(cwdC5),
    };
    const c5 = await startDashboard({
      env: childEnv({ DASHBOARD_RUNS_DIR: runsRoot, DASHBOARD_PORT: '0' }, homeC5, tmpC5),
      cwd: cwdC5,
    });
    if (check('C5 the dedicated child starts', c5.ok)) {
      const served = [];
      served.push((await get(c5.port, '/')).status === 200);
      for (let i = 0; i < 3; i += 1) served.push((await get(c5.port, '/state')).status === 200);
      served.push((await get(c5.port, '/nope')).status === 404);
      check('C5 the child served GET /, three /state and one 404', served.every(Boolean));
      await stop(c5.child);                       // the child has EXITED before we look
      check('C5 the fixture root is byte-identical after the child exits', sameSnapshot(before.fix, snapshot(fixRoot)));
      check('C5 scripts/ is byte-identical after the child exits', sameSnapshot(before.scripts, snapshot(scriptsDir)));
      check('C5 the dedicated HOME is untouched and still empty',
        sameSnapshot(before.home, snapshot(homeC5)) && fs.readdirSync(homeC5).length === 0);
      check('C5 the dedicated TMPDIR/TEMP/TMP target is untouched and still empty',
        sameSnapshot(before.tmp, snapshot(tmpC5)) && fs.readdirSync(tmpC5).length === 0);
      check('C5 the dedicated empty cwd is untouched and still empty',
        sameSnapshot(before.cwd, snapshot(cwdC5)) && fs.readdirSync(cwdC5).length === 0);
    } else { failed = 1; }

    // Two different cwds against one fixture: /state identical with now held out.
    const envAux = () => childEnv({ DASHBOARD_RUNS_DIR: runsRoot, DASHBOARD_PORT: '0' }, homeAux, tmpAux);
    const sx = await startDashboard({ env: envAux(), cwd: cwdX });
    const sy = await startDashboard({ env: envAux(), cwd: cwdY });
    if (check('C5 both cwd-probe children start', sx.ok && sy.ok)) {
      const bx = (await get(sx.port, '/state')).body;
      const by = (await get(sy.port, '/state')).body;
      check('C5 /state is identical from two different cwds with now held out', noNow(bx) === noNow(by));
    } else { failed = 1; }
    await stop(sx.child);
    await stop(sy.child);

    // The default root resolves from the script's own location, never the cwd; a blank
    // seam is unset. Proved with a copied script over its own repo-shaped root — which
    // also proves the file works detached from this repo (self-contained).
    const defRoot = path.join(tmp, 'defroot');
    fs.mkdirSync(path.join(defRoot, 'scripts'), { recursive: true });
    const script2 = path.join(defRoot, 'scripts', 'dashboard.js');
    fs.copyFileSync(SCRIPT, script2);
    fs.mkdirSync(path.join(defRoot, 'runs', 'solo-default-run'), { recursive: true });
    fs.writeFileSync(path.join(defRoot, 'runs', 'solo-default-run', 'run.json'), `${JSON.stringify({
      runId: 'solo-default-run', startedAt: isoAt(NOW - 7200 * 1000), finishedAt: isoAt(NOW - 7100 * 1000),
      targetRepo: 'https://example.invalid/solo.git', concurrency: 1,
      tasks: [{ issueId: 'app-501', title: 'Solo', outcome: 'done', exitCode: 0, attempts: 1, pauses: 0 }],
    }, null, 2)}\n`);
    const d1 = await startDashboard({
      env: childEnv({ DASHBOARD_PORT: '0' }, homeAux, tmpAux), cwd: cwdZ, script: script2,
    });
    const d2 = await startDashboard({
      env: childEnv({ DASHBOARD_PORT: '0', DASHBOARD_RUNS_DIR: '' }, homeAux, tmpAux), cwd: cwdZ, script: script2,
    });
    if (check('C5 the copied-script default-root children start', d1.ok && d2.ok)) {
      const b1 = (await get(d1.port, '/state')).body;
      const b2 = (await get(d2.port, '/state')).body;
      check('C5 with the seam unset, the root resolves from the script location, not the cwd',
        b1.includes('solo-default-run') && b1.includes('https://example.invalid/solo.git'));
      check('C5 a blank DASHBOARD_RUNS_DIR means unset — same tree, same bytes with now held out',
        b2.includes('solo-default-run') && noNow(b1) === noNow(b2));
    } else { failed = 1; }
    await stop(d1.child);
    await stop(d2.child);
  }

  // The announcement contract, judged over the main server's whole life.
  await stop(main1.child);
  check('C4 the chosen port was announced as exactly ONE stdout line over the server\'s whole life',
    main1.out().trim() === `dashboard: http://127.0.0.1:${port}/`);

  // ==== C6: the suite exists, counts, and is swept =====================================
  runC6();
}

process.on('unhandledRejection', (e) => {
  console.log(`FAIL - unhandled rejection: ${e && e.message ? e.message : e}`);
  for (const k of kids) { try { k.kill(); } catch { /* gone */ } }
  process.exit(1);
});

main().then(() => {
  clearTimeout(watchdog);
  for (const k of kids) { try { k.kill(); } catch { /* gone */ } }
  process.exit(failed);
}, (e) => {
  console.log(`FAIL - the suite threw: ${e && e.stack ? e.stack.split('\n')[0] : e}`);
  clearTimeout(watchdog);
  for (const k of kids) { try { k.kill(); } catch { /* gone */ } }
  process.exit(1);
});
