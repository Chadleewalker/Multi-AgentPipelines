#!/usr/bin/env node
// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// The live dashboard's re-runnable suite — scripts/dashboard.js (DESIGN.md §5, change-log
// rows `live-dashboard` and `repo-kfg`).
//
// Why this exists beside the frozen tests/acceptance/repo-kfg/: a frozen directory is an
// artifact of a finished task and is never run again (repo-dhp-note-2). What the dashboard
// answers is a set of JOINS over artifacts several other modules write — the lock record,
// `run.log`'s line wording, `run.json`'s field names, `status.json`'s shape — and every one
// of those can be changed by a later task that has no idea this reader exists. This suite is
// what notices.
//
// Docker-free, network-free beyond loopback, and git-free: it builds throwaway runs roots
// under the OS temp directory and drives the real reader against them, so it touches
// neither this repo's working tree nor the real runs corpus. Two halves:
//
//   * the module, required directly — `main()` sits behind `require.main === module`, which
//     is the only reason the pure functions are reachable at all (repo-teq-note-1's shape);
//   * the server, spawned as a child through the DASHBOARD_RUNS_DIR / DASHBOARD_PORT seams.
//
// Fixtures are DISCRIMINATING on purpose. The run pick has three plausible wrong answers on
// a real tree — readdir order, runId sort, and directory mtime (repo-1ie-note-2) — so the
// two run-choice projects below are built so the correct answer is the FIRST name in one and
// the LAST in the other. A fixture that any of those readings would also pass proves nothing.
//
// Run from Git Bash:  node tests/unit/dashboard.test.js
'use strict';
const fs = require('fs');
const os = require('os');
const net = require('net');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'dashboard.js');
const D = require(SCRIPT);

let failed = 0;
function check(name, cond) {
  console.log(`${cond ? 'ok' : 'FAIL'} - ${name}`);
  if (!cond) failed = 1;
  return !!cond;
}
function skip(name) { console.log(`skip - ${name}`); }
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'unit-dashboard-'));
const kids = [];
const watchdog = setTimeout(() => {
  console.log('FAIL - watchdog: the suite exceeded 300s (a server or request hung)');
  for (const k of kids) { try { k.kill(); } catch { /* gone */ } }
  process.exit(1);
}, 300000);

const NOW = Date.now();
const isoAt = (ms) => new Date(ms).toISOString();
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const writeJson = (file, obj) => write(file, `${JSON.stringify(obj, null, 2)}\n`);

// A recursive path+content-hash snapshot — the purity proof, sorted byte-wise.
function snapshot(root) {
  const map = new Map();
  if (!fs.existsSync(root)) return map;
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = path.join(dir, e.name);
      const rel = path.relative(root, p).split(path.sep).join('/');
      if (e.isDirectory()) { map.set(`${rel}/`, 'dir'); walk(p); }
      else if (e.isFile()) map.set(rel, sha1(fs.readFileSync(p)));
    }
  }(root));
  return map;
}
const sameSnapshot = (a, b) => a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);

// ---- 1. project identity ---------------------------------------------------------------
{
  const base = path.join(tmp, 'targets', 'ident-app');
  fs.mkdirSync(base, { recursive: true });
  const plain = D.canonicalTarget(base);
  check('canonicalTarget folds a trailing separator to the same key', D.canonicalTarget(base + path.sep) === plain);
  check('canonicalTarget folds a ./ segment to the same key',
    D.canonicalTarget(`${path.join(tmp, 'targets')}${path.sep}.${path.sep}ident-app`) === plain);
  check('canonicalTarget folds a .. segment to the same key',
    D.canonicalTarget(path.join(base, '..', 'ident-app')) === plain);
  check('canonicalTarget folds surrounding whitespace', D.canonicalTarget(`  ${base}  `) === plain);
  check('canonicalTarget answers null for a blank or absent target',
    D.canonicalTarget('') === null && D.canonicalTarget('   ') === null && D.canonicalTarget(null) === null);
  check('displayName strips a trailing .git from a remote URL',
    D.displayName('https://example.invalid/beta-game.git') === 'beta-game');
  check('displayName takes the last segment of a local path, .git-less',
    D.displayName('/srv/work/my-game') === 'my-game');
  check('displayName tolerates a trailing separator', D.displayName('/srv/work/my-game/') === 'my-game');
}

// ---- 2. lock liveness ------------------------------------------------------------------
// The rule is re-implemented inline in the reader rather than required from runner/lock.js
// (the reader must stay copyable and require-free of repo files), so its FIDELITY is what
// this block pins: same falsifiers, same directions.
{
  const self = () => ({
    runId: 'r', pid: process.pid, target: '/x', host: 'example.invalid', platform: process.platform,
    startedAt: new Date().toISOString(), takenAtMs: Date.now(), uptimeSeconds: Math.floor(os.uptime()),
    procStart: null,
  });
  check('isHolderLive: a record minted now by this live process is held', D.isHolderLive(self()) === true);
  check('isHolderLive: a takenAtMs predating the host uptime is stale (the pre-reboot falsifier)',
    D.isHolderLive({ ...self(), takenAtMs: Date.now() - (os.uptime() * 1000 + 30 * 60 * 1000) }) === false);
  check('isHolderLive: an uptime counter that went backwards is stale (it only resets at boot)',
    D.isHolderLive({ ...self(), uptimeSeconds: Math.floor(os.uptime()) + 3600 }) === false);
  check('isHolderLive: a pid that cannot exist is not live', D.isHolderLive({ ...self(), pid: 0 }) === false);
  check('isHolderLive: a non-integer pid is not live', D.isHolderLive({ ...self(), pid: '123' }) === false);
  check('isHolderLive: a null record is not live', D.isHolderLive(null) === false);
  // The 15-minute grace: a laptop whose uptime counter stopped during sleep must not have its
  // LIVE holder mistaken for a dead one — the expensive direction of this error.
  check('isHolderLive: a lock slightly older than uptime is still held (the sleep grace)',
    D.isHolderLive({ ...self(), takenAtMs: Date.now() - (os.uptime() * 1000 + 60 * 1000) }) === true);
  if (process.platform === 'linux' && fs.existsSync('/proc/self/stat')) {
    const raw = fs.readFileSync('/proc/self/stat', 'utf8');
    const ticks = raw.slice(raw.lastIndexOf(')') + 1).trim().split(/\s+/)[19];
    check('isHolderLive: our own procStart matches, so the record is held',
      D.isHolderLive({ ...self(), procStart: ticks }) === true);
    check('isHolderLive: a wrong procStart is stale even on a live pid (the pid was recycled)',
      D.isHolderLive({ ...self(), procStart: `${ticks}9` }) === false);
  } else {
    skip('isHolderLive procStart falsifier (no /proc/self/stat on this host)');
  }
}

// ---- 3. run.log parsing ----------------------------------------------------------------
{
  const logDir = path.join(tmp, 'logs');
  const t0 = isoAt(NOW - 600000);
  const body = [
    `${t0} INFO [run-p/preflight] target: /srv/work/thing -> https://example.invalid/thing.git`,
    'this line does not match the pinned shape and must be dropped',
    `${isoAt(NOW - 590000)} INFO [run-p/app-1] starting task (priority 2): A title — with an em dash: and a colon`,
    `${isoAt(NOW - 580000)} ERROR [run-p/app-2] refused: the run-level rate-limit pause cap has fired`,
  ].join('\n');
  const lf = path.join(logDir, 'lf.log');
  const crlf = path.join(logDir, 'crlf.log');
  write(lf, `${body}\n`);
  write(crlf, `${body.split('\n').join('\r\n')}\r\n`);
  const a = D.readLog(lf);
  const b = D.readLog(crlf);
  check('readLog drops lines that do not match the pinned <ISO> LEVEL [trace] msg shape', a.events.length === 3);
  check('readLog reads a CRLF file identically to an LF one (the working copy is CRLF)', eq(a, b));
  check('readLog splits the trace id at its FIRST slash', a.events[0].runId === 'run-p' && a.events[0].issueId === 'preflight');
  check('readLog keeps the level so an ERROR line can be told from an INFO one', a.events[2].level === 'ERROR');
  check('readLog takes startedAt from the FIRST line only', a.firstTs === t0);
  check('readLog answers null for a file that is not there', D.readLog(path.join(logDir, 'absent.log')) === null);
  const junk = path.join(logDir, 'junk.log');
  write(junk, 'nothing here parses\nnor here\n');
  check('readLog on an unparseable log is empty rather than a throw',
    D.readLog(junk).events.length === 0 && D.readLog(junk).firstTs === null);
}

// ---- 4. the ready-queue and park payloads ----------------------------------------------
{
  const ev = (msg, level) => ({ ts: isoAt(NOW), level: level || 'INFO', runId: 'r', issueId: '', msg });
  check('readyQueueIds splits after the first em dash, stops at the first ";", and splits on ", "',
    eq(D.readyQueueIds([ev('ready queue: 3 task(s) — app-1, app-2, app-3; skipped 1 by type: app-9 (epic)')]),
      ['app-1', 'app-2', 'app-3']));
  check('readyQueueIds is unmoved by an em dash inside the skipped tail',
    eq(D.readyQueueIds([ev('ready queue: 1 task(s) — app-1; skipped 1 — by type: app-9 (epic)')]), ['app-1']));
  check('readyQueueIds reads an empty queue as no ids, never as one id called "(empty)"',
    eq(D.readyQueueIds([ev('ready queue: 0 task(s) — (empty)')]), []));
  check('readyQueueIds takes the LAST queue line when a run logged more than one',
    eq(D.readyQueueIds([ev('ready queue: 1 task(s) — app-1'), ev('ready queue: 2 task(s) — app-7, app-8')]),
      ['app-7', 'app-8']));
  check('readyQueueIds ignores every other line', eq(D.readyQueueIds([ev('starting task (priority 2): x')]), []));

  const openLine = 'rate limit: opening the run-level wait (2/96 cycles spent)';
  const reopen = 'run-level park: the window reopened (2/96 wait cycles spent)';
  const until = isoAt(NOW + 1800000);
  check('readPark defaults closed, zero cycles, no until', eq(D.readPark([]), { open: false, cycles: 0, until: null }));
  check('readPark opens with the cycle count from the (n/m cycles spent) suffix',
    eq(D.readPark([ev(openLine)]), { open: true, cycles: 2, until: null }));
  check('readPark closes again on the window-reopened line, keeping the cycles spent',
    eq(D.readPark([ev(openLine), ev(reopen)]), { open: false, cycles: 2, until: null }));
  check('readPark takes until from the latest reported-reset line',
    D.readPark([ev(`paused: waiting until reported reset ${isoAt(NOW)} (5m)`),
      ev(`paused: waiting until reported reset ${until} (30m)`)]).until === until);
  check('readPark ignores the end-of-run summary shape (it reads 0 during exactly these runs)',
    eq(D.readPark([ev(openLine), ev('run finished; artifacts in /x (0 pause cycles spent)')]),
      { open: true, cycles: 2, until: null }));
}

// ---- 5. the seams ------------------------------------------------------------------------
{
  const saveRoot = process.env.DASHBOARD_RUNS_DIR;
  const savePort = process.env.DASHBOARD_PORT;
  delete process.env.DASHBOARD_RUNS_DIR;
  check('resolveRoot defaults to <script dir>/../runs, resolved from the script, never the cwd',
    D.resolveRoot() === path.join(ROOT, 'runs'));
  process.env.DASHBOARD_RUNS_DIR = '   ';
  check('resolveRoot treats a blank seam as unset, not as the cwd', D.resolveRoot() === path.join(ROOT, 'runs'));
  process.env.DASHBOARD_RUNS_DIR = tmp;
  check('resolveRoot honours the seam when it names a root', D.resolveRoot() === path.resolve(tmp));

  delete process.env.DASHBOARD_PORT;
  check('resolvePort defaults to 4770', D.resolvePort() === 4770);
  process.env.DASHBOARD_PORT = '';
  check('resolvePort treats a blank port as unset', D.resolvePort() === 4770);
  process.env.DASHBOARD_PORT = '0';
  check('resolvePort keeps 0 — an ephemeral port is a real request, not a falsy default', D.resolvePort() === 0);
  process.env.DASHBOARD_PORT = 'not-a-port';
  check('resolvePort falls back on junk rather than binding NaN', D.resolvePort() === 4770);
  process.env.DASHBOARD_PORT = '70000';
  check('resolvePort falls back on an out-of-range port', D.resolvePort() === 4770);

  if (saveRoot === undefined) delete process.env.DASHBOARD_RUNS_DIR; else process.env.DASHBOARD_RUNS_DIR = saveRoot;
  if (savePort === undefined) delete process.env.DASHBOARD_PORT; else process.env.DASHBOARD_PORT = savePort;
}

// ---- 6. the corpus fixture ----------------------------------------------------------------
// One root, five projects, built so that every plausible wrong reading of "which run" is a
// different answer from the right one.
const runsRoot = path.join(tmp, 'corpus', 'runs');
fs.mkdirSync(path.join(runsRoot, 'locks'), { recursive: true });

const targets = path.join(tmp, 'corpus', 'targets');
const tgtLive = path.join(targets, 'live-app');
const tgtX = path.join(targets, 'pick-x');
const tgtY = path.join(targets, 'pick-y');
const tgtTie = path.join(targets, 'pick-tie');
for (const d of [tgtLive, tgtX, tgtY, tgtTie]) fs.mkdirSync(d, { recursive: true });

// Project LIVE: a held lock naming an OLDER run dir than the newest one on disk. Every
// "newest wins" reading picks the decoy; only the lock's runId picks the live run.
const wsLive = path.join(tmp, 'corpus', 'ws', 'app-1');
writeJson(path.join(wsLive, '.run', 'status.json'), {
  issueId: 'app-1', phase: 'code', attempts: [{ number: 1, verifierResult: 'error' }],
});
write(path.join(runsRoot, 'run-live-held', 'run.log'), [
  `${isoAt(NOW - 3600000)} INFO [run-live-held/preflight] target: ${tgtLive} -> https://example.invalid/live-app.git`,
  `${isoAt(NOW - 3599000)} INFO [run-live-held/preflight] ready queue: 3 task(s) — app-1, app-2, app-3`,
  `${isoAt(NOW - 3598000)} INFO [run-live-held/app-1] starting task (priority 2): Live work`,
  `${isoAt(NOW - 3597000)} INFO [run-live-held/app-1] workspace ready: ${wsLive} on task/app-1 (fork point deadbeef)`,
  `${isoAt(NOW - 3596000)} INFO [run-live-held/app-2] starting task (priority 2): Second`,
  `${isoAt(NOW - 3595000)} INFO [run-live-held/app-2] rate limit hit (pause 2) — parking the task`,
  `${isoAt(NOW - 3594000)} INFO [run-live-held/app-2] relaunching in a fresh container against the same workspace`,
  '',
].join('\n'));
write(path.join(runsRoot, 'run-live-newer', 'run.log'),
  `${isoAt(NOW - 60000)} INFO [run-live-newer/preflight] target: ${tgtLive} -> https://example.invalid/live-app.git\n`);
writeJson(path.join(runsRoot, 'locks', 'live-app-000000000001.lock'), {
  runId: 'run-live-held', pid: process.pid, target: tgtLive + path.sep, host: 'example.invalid',
  platform: process.platform, startedAt: isoAt(NOW - 3600000), takenAtMs: Date.now(),
  uptimeSeconds: Math.floor(os.uptime()), procStart: null,
});

// Project X: three runs, the newest is the FIRST name. Project Y: three runs, the newest is
// the LAST name. Neither readdir order nor a runId sort can be right in both.
const mkFinished = (dir, target, startedAt, extra) => writeJson(path.join(runsRoot, dir, 'run.json'), {
  runId: dir, startedAt, finishedAt: startedAt, targetRepo: null, concurrency: 2,
  tasks: [{ issueId: 'app-1', title: dir, outcome: 'done', exitCode: 0, attempts: 1, pauses: 0 }],
  ...extra,
});
for (const [dir, started] of [['run-x-aaa', NOW - 600000], ['run-x-mmm', NOW - 1800000], ['run-x-zzz', NOW - 3600000]]) {
  write(path.join(runsRoot, dir, 'run.log'), `${isoAt(started)} INFO [${dir}/preflight] target: ${tgtX} -> https://example.invalid/x.git\n`);
  mkFinished(dir, tgtX, isoAt(started));
}
for (const [dir, started] of [['run-y-aaa', NOW - 3600000], ['run-y-mmm', NOW - 1800000], ['run-y-zzz', NOW - 600000]]) {
  write(path.join(runsRoot, dir, 'run.log'), `${isoAt(started)} INFO [${dir}/preflight] target: ${tgtY} -> https://example.invalid/y.git\n`);
  mkFinished(dir, tgtY, isoAt(started));
}
// A run with no readable startedAt at all must sort OLDEST, never win by being unknown.
write(path.join(runsRoot, 'run-y-nnn', 'run.log'), `garbage first line\n`);
writeJson(path.join(runsRoot, 'run-y-nnn', 'run.json'), {
  runId: 'run-y-nnn', startedAt: 'not-a-date', targetRepo: null, concurrency: 9, tasks: [],
});
write(path.join(runsRoot, 'run-y-nnn', 'run.log'), [
  'garbage first line',
  `${isoAt(NOW - 1000)} INFO [run-y-nnn/preflight] target: ${tgtY} -> https://example.invalid/y.git`,
  '',
].join('\n'));

// Project TIE: two runs at the same instant — the tie breaks by runId ascending, so two
// calls on one tree can never disagree about which run is shown.
for (const dir of ['run-tie-002', 'run-tie-001']) {
  write(path.join(runsRoot, dir, 'run.log'), `${isoAt(NOW - 900000)} INFO [${dir}/preflight] target: ${tgtTie} -> https://example.invalid/tie.git\n`);
  mkFinished(dir, tgtTie, isoAt(NOW - 900000));
}

// Project REMOTE: identity from the manifest URL alone, plus a collected task status.
writeJson(path.join(runsRoot, 'run-remote-001', 'run.json'), {
  runId: 'run-remote-001', startedAt: isoAt(NOW - 7200000), finishedAt: isoAt(NOW - 7000000),
  targetRepo: 'https://example.invalid/remote-thing.git', concurrency: 3,
  tasks: [{
    issueId: 'app-7', title: 'Collected', outcome: 'partial', exitCode: 10, attempts: 3, pauses: 1,
    activeSeconds: 900, branch: 'task/app-7', prUrl: 'https://example.invalid/pr/1',
  }],
});
writeJson(path.join(runsRoot, 'run-remote-001', 'tasks', 'app-7', 'status.json'), {
  issueId: 'app-7', phase: 'docs',
  attempts: [{ verifierResult: 'fail' }, { verifierResult: 'tampered' }, { verifierResult: 'pass' }],
});

// Noise the run-dir predicate must skip.
write(path.join(runsRoot, 'loose-file.txt'), 'not a run\n');
fs.mkdirSync(path.join(runsRoot, 'empty-dir'), { recursive: true });
write(path.join(runsRoot, 'sweeps', '20260101-000000', 'summary.md'), '# sweep\n');

const byKey = (st, key) => st.projects.find((p) => p.key === key);
const taskOf = (p, id) => p.run.tasks.find((t) => t.issueId === id);

{
  const before = snapshot(path.join(tmp, 'corpus'));
  const st = D.buildState(runsRoot);
  check('buildState answers schema 1 with a projects array', st.schema === 1 && Array.isArray(st.projects));
  check('buildState reads the tree without writing to it', sameSnapshot(before, snapshot(path.join(tmp, 'corpus'))));
  check('the run-dir predicate skips plain files, dirs holding neither artifact, locks and sweeps',
    st.projects.length === 5);
  const keys = st.projects.map((p) => p.key);
  check('projects sort byte-wise by key', eq(keys, [...keys].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))));

  const live = byKey(st, D.canonicalTarget(tgtLive));
  check('a held lock spelled with a trailing separator folds onto the log line\'s spelling',
    !!live && live.lock.state === 'held' && live.live === true);
  check('the lock\'s runId picks the run — the newer decoy directory loses',
    !!live && live.run.runId === 'run-live-held' && live.run.state === 'running');
  check('a live run with no manifest is degraded no-manifest, never dropped',
    !!live && eq(live.run.degraded, ['no-manifest']) && live.run.concurrency === null);
  const a1 = live && taskOf(live, 'app-1');
  check('a started task with a live workspace reads phase, attempt and attemptResults from it',
    !!a1 && a1.phase === 'code' && a1.attempt === 1 && eq(a1.attemptResults, ['error'])
    && a1.workspace.state === 'live');
  check('attemptsMax is the contract constant 3 on every row', !!live && live.run.tasks.every((t) => t.attemptsMax === 3));
  const a2 = live && taskOf(live, 'app-2');
  check('a relaunch after a park puts the task back on running (the LAST event wins)',
    !!a2 && a2.state === 'running' && a2.pauses === 2);
  check('a started task with no workspace-ready line is workspace-unknown, not workspace-missing',
    !!a2 && a2.workspace.state === 'unknown' && a2.workspace.path === null
    && a2.degraded.includes('workspace-unknown') && !a2.degraded.includes('workspace-missing'));
  const a3 = live && taskOf(live, 'app-3');
  check('a ready-queue id that never started is queued, with no degraded terms of its own',
    !!a3 && a3.state === 'queued' && eq(a3.degraded, []) && a3.title === '');
  check('run.queued holds the never-started ids in QUEUE order, not task order',
    !!live && eq(live.run.queued, ['app-3']));

  const px = byKey(st, D.canonicalTarget(tgtX));
  const py = byKey(st, D.canonicalTarget(tgtY));
  check('with no live lock the newest startedAt wins even when it is the FIRST name on disk',
    !!px && px.run.runId === 'run-x-aaa');
  check('... and when it is the LAST name on disk (neither readdir order nor a runId sort is right in both)',
    !!py && py.run.runId === 'run-y-zzz');
  check('a run whose startedAt does not parse sorts oldest — it can never win the pick',
    !!py && py.run.runId !== 'run-y-nnn');
  const tie = byKey(st, D.canonicalTarget(tgtTie));
  check('two runs at the same instant break by runId ascending, so the pick is stable',
    !!tie && tie.run.runId === 'run-tie-001');
  check('a project with no lock reads lock state none and live false',
    !!px && px.lock.state === 'none' && px.live === false && eq(px.degraded, []));
  check('a finished manifest run reads state finished with the manifest\'s concurrency',
    !!px && px.run.state === 'finished' && px.run.concurrency === 2);

  const rem = byKey(st, 'https://example.invalid/remote-thing.git');
  check('a run whose only identity is the manifest URL is keyed by it, with path null',
    !!rem && rem.path === null && rem.remote === 'https://example.invalid/remote-thing.git');
  check('the project name strips .git from the URL\'s last segment', !!rem && rem.name === 'remote-thing');
  const a7 = rem && taskOf(rem, 'app-7');
  check('a manifest row supplies outcome, prUrl, branch, pauses and activeSeconds',
    !!a7 && a7.outcome === 'partial' && a7.prUrl === 'https://example.invalid/pr/1'
    && a7.branch === 'task/app-7' && a7.pauses === 1 && a7.activeSeconds === 900);
  check('attemptResults come from the collected status file, in attempt order',
    !!a7 && eq(a7.attemptResults, ['fail', 'tampered', 'pass']) && a7.phase === 'docs');
  check('a finished row with no live workspace is not degraded for lacking one', !!a7 && eq(a7.degraded, []));

  const st2 = D.buildState(runsRoot);
  const hold = (s) => JSON.stringify({ ...s, now: 'NOW' });
  check('two reads of one unchanged tree differ in nothing but now', hold(st) === hold(st2));
  check('now is a parseable ISO timestamp', typeof st.now === 'string' && !Number.isNaN(Date.parse(st.now)));
}

// ---- 7. degraded states, planted one at a time -------------------------------------------
{
  const root = path.join(tmp, 'degraded', 'runs');
  const tgt = path.join(tmp, 'degraded', 'target');
  fs.mkdirSync(tgt, { recursive: true });
  fs.mkdirSync(path.join(root, 'locks'), { recursive: true });
  const ws = path.join(tmp, 'degraded', 'ws', 'app-1');
  write(path.join(root, 'run-d-001', 'run.log'), [
    `${isoAt(NOW - 600000)} INFO [run-d-001/preflight] target: ${tgt} -> https://example.invalid/d.git`,
    `${isoAt(NOW - 599000)} INFO [run-d-001/app-1] starting task (priority 2): Degrading`,
    `${isoAt(NOW - 598000)} INFO [run-d-001/app-1] workspace ready: ${ws} on task/app-1 (fork point cafe1234)`,
    '',
  ].join('\n'));

  const key = D.canonicalTarget(tgt);
  const one = () => byKey(D.buildState(root), key);

  check('a workspace path that does not exist reads missing, with workspace-missing named',
    one().run.tasks[0].workspace.state === 'missing' && one().run.tasks[0].degraded.includes('workspace-missing'));
  fs.mkdirSync(path.join(ws, '.run'), { recursive: true });
  check('an in-flight task with no status file is status-missing, lastWrite null',
    one().run.tasks[0].degraded.includes('status-missing') && one().run.tasks[0].lastWrite === null);
  write(path.join(ws, '.run', 'status.json'), 'not json at all {{{');
  check('a status file of unparseable bytes is status-unreadable, phase present-but-null',
    one().run.tasks[0].degraded.includes('status-unreadable') && one().run.tasks[0].phase === null);
  writeJson(path.join(ws, '.run', 'status.json'), { issueId: 'app-1', attempts: [] });
  check('a status file with no phase is phase-unknown', one().run.tasks[0].degraded.includes('phase-unknown'));
  writeJson(path.join(ws, '.run', 'status.json'), { issueId: 'app-1', phase: 'review', attempts: [{ verifierResult: 'pass' }] });
  const t = one().run.tasks[0];
  check('an out-of-vocabulary phase folds to phase-unknown while the rest of the file is still read',
    t.phase === null && t.degraded.includes('phase-unknown') && eq(t.attemptResults, ['pass']));
  writeJson(path.join(ws, '.run', 'status.json'), { issueId: 'app-1', phase: 'verify', attempts: [{ verifierResult: 'pass' }] });
  check('a healthy in-flight task carries no degraded terms at all', eq(one().run.tasks[0].degraded, []));
  check('lastWrite is the status file\'s mtime as an ISO string with milliseconds',
    one().run.tasks[0].lastWrite === fs.statSync(path.join(ws, '.run', 'status.json')).mtime.toISOString());

  write(path.join(root, 'run-d-001', 'run.json'), '{ not json');
  check('a manifest of unparseable bytes is manifest-unreadable and never state finished',
    eq(one().run.degraded, ['manifest-unreadable']) && one().run.state !== 'finished');
  write(path.join(root, 'run-d-001', 'run.json'), '[1,2,3]\n');
  check('a manifest that parses to an ARRAY is unreadable too — well-formed and the wrong shape',
    eq(one().run.degraded, ['manifest-unreadable']));
  fs.rmSync(path.join(root, 'run-d-001', 'run.json'));

  write(path.join(root, 'locks', 'broken-000000000002.lock'), 'runId=?? \x00 not json');
  const withBad = D.buildState(root);
  check('an unreadable lock is reported as lock-unreadable and does not take the tree down',
    withBad.projects.some((p) => p.degraded.includes('lock-unreadable')) && !!byKey(withBad, key));
  fs.rmSync(path.join(root, 'locks', 'broken-000000000002.lock'));

  writeJson(path.join(root, 'locks', 'stale-000000000003.lock'), {
    runId: 'run-d-001', pid: process.pid, target: tgt, startedAt: isoAt(NOW - 600000),
    takenAtMs: Date.now() - (os.uptime() * 1000 + 3600000), uptimeSeconds: Math.floor(os.uptime()), procStart: null,
  });
  check('a stale lock renders state stale, live false, and lock-stale at project level',
    one().lock.state === 'stale' && one().live === false && one().degraded.includes('lock-stale'));
  fs.rmSync(path.join(root, 'locks', 'stale-000000000003.lock'));

  writeJson(path.join(root, 'locks', 'ghost-000000000004.lock'), {
    runId: 'run-does-not-exist', pid: process.pid, target: tgt, startedAt: isoAt(NOW),
    takenAtMs: Date.now(), uptimeSeconds: Math.floor(os.uptime()), procStart: null,
  });
  const ghost = one();
  check('a live lock naming a runId with no directory is run-missing, with run still a full object',
    eq(ghost.run.degraded, ['run-missing']) && ghost.run.runId === 'run-does-not-exist'
    && eq(ghost.run.tasks, []) && ghost.run.startedAt === null && ghost.run.concurrency === null);
  fs.rmSync(path.join(root, 'locks', 'ghost-000000000004.lock'));

  // An orphan run dir: one project per orphan, keyed unknown:<runDirName>, never one bucket.
  write(path.join(root, 'run-orphan-a', 'run.log'), `${isoAt(NOW)} INFO [run-orphan-a/app-9] starting task (priority 2): Orphan A\n`);
  write(path.join(root, 'run-orphan-b', 'run.log'), `${isoAt(NOW)} INFO [run-orphan-b/app-9] starting task (priority 2): Orphan B\n`);
  const orph = D.buildState(root);
  check('each orphan run dir is its own project keyed unknown:<runDirName> with target-unknown',
    !!byKey(orph, 'unknown:run-orphan-a') && !!byKey(orph, 'unknown:run-orphan-b')
    && byKey(orph, 'unknown:run-orphan-a').degraded.includes('target-unknown')
    && byKey(orph, 'unknown:run-orphan-a').path === null && byKey(orph, 'unknown:run-orphan-a').remote === null);
  fs.rmSync(path.join(root, 'run-orphan-a'), { recursive: true, force: true });
  fs.rmSync(path.join(root, 'run-orphan-b'), { recursive: true, force: true });

  // A missing locks/ directory is the ordinary empty case, not a degraded one.
  fs.rmSync(path.join(root, 'locks'), { recursive: true, force: true });
  check('a root with no locks/ directory is ordinary — lock none, nothing degraded',
    one().lock.state === 'none' && eq(one().degraded, []));
  check('a runs root that does not exist at all is an empty corpus, not a throw',
    eq(D.buildState(path.join(tmp, 'no-such-root')).projects, []));
}

// ---- 8. the server ---------------------------------------------------------------------
function childEnv(extra) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k === 'NODE_OPTIONS' || k === 'NODE_DEBUG' || /^DASHBOARD_/i.test(k)) continue;
    env[k] = v;
  }
  return Object.assign(env, extra);
}
function start(env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT], { env, cwd: tmp, stdio: ['ignore', 'pipe', 'pipe'] });
    kids.push(child);
    let out = '';
    let err = '';
    let done = false;
    const finish = (r) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } finish({ ok: false, child, out: () => out, err: () => err }); }, 15000);
    child.stdout.on('data', (d) => {
      out += d;
      const m = out.match(/^dashboard: http:\/\/127\.0\.0\.1:(\d+)\/$/m);
      if (m) finish({ ok: true, port: Number(m[1]), child, out: () => out, err: () => err });
    });
    child.stderr.on('data', (d) => { err += d; });
    child.on('exit', () => finish({ ok: false, child, out: () => out, err: () => err }));
  });
}
function stop(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return resolve();
    child.on('exit', () => resolve());
    try { child.kill(); } catch { resolve(); }
  });
}
function get(port, p) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method: 'GET' }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.setTimeout(15000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

async function serverChecks() {
  const srv = await start(childEnv({ DASHBOARD_RUNS_DIR: runsRoot, DASHBOARD_PORT: '0' }));
  if (!check('the server starts on an ephemeral port and announces one ready line', srv.ok)) return;

  const page = await get(srv.port, '/');
  check('GET / is 200 text/html', page.status === 200 && String(page.headers['content-type'] || '').startsWith('text/html'));
  check('the placeholder page is scheme-level self-contained (no "://", no src=, no @import)',
    !page.body.includes('://') && !/src=/i.test(page.body) && !page.body.includes('@import'));
  check('the placeholder page carries no href that leaves the document',
    [...page.body.matchAll(/href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+))/gi)]
      .map((m) => m[1] ?? m[2] ?? m[3]).every((h) => h.startsWith('#')));

  const s1 = await get(srv.port, '/state');
  check('GET /state is 200 application/json with Cache-Control: no-store',
    s1.status === 200 && String(s1.headers['content-type'] || '').startsWith('application/json')
    && s1.headers['cache-control'] === 'no-store');
  check('the served /state parses and names the fixture\'s projects',
    JSON.parse(s1.body).projects.length === 5);

  for (const p of ['/nope', '/state/x', '/State', '/%2e%2e/DESIGN.md']) {
    const r = await get(srv.port, p);
    check(`${p} is 404 with the exact body "not found\\n" — there is no static-file route`,
      r.status === 404 && r.body === 'not found\n');
  }

  // Freshness: the tree changes under a RUNNING server and the next request must see it.
  const fresh = path.join(runsRoot, 'run-live-held', 'run.log');
  fs.appendFileSync(fresh, `${new Date().toISOString()} INFO [run-live-held/app-3] starting task (priority 2): Late arrival\n`);
  const s2 = JSON.parse((await get(srv.port, '/state')).body);
  const late = byKey(s2, D.canonicalTarget(tgtLive));
  check('a line appended to run.log under a running server is visible on the very next request',
    late.run.tasks.find((t) => t.issueId === 'app-3').state === 'running');
  check('... and run.queued shrinks with it (nothing is cached at startup)', eq(late.run.queued, []));

  const hold = (b) => b.replace(/("now":)"[^"]*"/, '$1"NOW"');
  const s3 = await get(srv.port, '/state');
  const s4 = await get(srv.port, '/state');
  // Held out rather than asserted different: two requests can land inside one millisecond,
  // so "now moved" is a clock race, not a property. What is pinned is that NOTHING ELSE moved.
  check('two /state responses on an unchanged tree are byte-identical but for now',
    hold(s3.body) === hold(s4.body) && /"now":"[^"]+"/.test(s3.body));

  await stop(srv.child);
  check('the announcement is exactly ONE stdout line over the server\'s whole life',
    srv.out().trim() === `dashboard: http://127.0.0.1:${srv.port}/`);
  check('the server writes nothing to stderr in normal operation', srv.err() === '');

  // The taken port: exit 1, one named stderr line, no stack trace.
  const blocker = await new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  const busy = blocker.address().port;
  const bumped = await new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT],
      { env: childEnv({ DASHBOARD_RUNS_DIR: runsRoot, DASHBOARD_PORT: String(busy) }), cwd: tmp, stdio: ['ignore', 'pipe', 'pipe'] });
    kids.push(child);
    let out = '';
    let err = '';
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } resolve({ code: null, out, err }); }, 15000);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
  });
  await new Promise((resolve) => blocker.close(resolve));
  const lines = bumped.err.split(/\r?\n/).filter((l) => l.trim() !== '');
  check('a taken port exits 1 with one stderr line starting "dashboard: " and nothing on stdout',
    bumped.code === 1 && lines.length === 1 && lines[0].startsWith('dashboard: ') && bumped.out === '');
  check('the taken-port failure carries no stack-trace line (it reads as a crash, not a collision)',
    !/^\s+at /m.test(bumped.err));
}

serverChecks().then(() => {
  clearTimeout(watchdog);
  for (const k of kids) { try { k.kill(); } catch { /* gone */ } }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  process.exit(failed);
}, (e) => {
  console.log(`FAIL - the suite threw: ${e && e.stack ? e.stack.split('\n')[0] : e}`);
  clearTimeout(watchdog);
  for (const k of kids) { try { k.kill(); } catch { /* gone */ } }
  process.exit(1);
});
