// Frozen acceptance test — the review verdict recorder (DESIGN.md §5, change-log row
// `review-verdict`). Written before implementation, from the spec alone; criteria C1–C6
// map 1:1 to the issue's "Done means" list. Plain Node, Docker-free: it builds a
// throwaway runs root under the OS temp dir and drives scripts/verdict.js as a child
// through process.execPath, reaching the fixture via the VERDICT_RUNS_DIR seam. All ids
// and URLs are invented — nothing here names a real target project.
//
// THE FROZEN INTERFACE:
//   node scripts/verdict.js record <issue-id> <merged|rejected> "<why>" [--run <runId>]
//     - chooses the run by run.json's startedAt (newest wins; a run whose run.json
//       parses but has no parseable startedAt sorts oldest); --run overrides.
//     - writes runs/<runId>/tasks/<issue-id>/verdict.json (creating tasks/<issue-id>/)
//       with issueId, runId, verdict, reason, recordedAt (ISO), and prUrl copied from
//       the task row only when it is a truthy non-empty string (never a null key).
//     - usage errors (bad verdict word, empty/whitespace reason, unknown issue, --run
//       naming a run without the issue) exit non-zero and write NOTHING.
//     - re-recording the same (run, issue) overwrites in place: one verdict.json.
//   node scripts/verdict.js pending
//     - lists every (run, task) pair with a truthy prUrl and no verdict.json, newest
//       run first by startedAt; runId and issueId share a line. Exits 0 whatever it
//       finds — a report, never a gate.
//   Both: the runs root is $VERDICT_RUNS_DIR, else <script dir>/../runs — never the
//   cwd. Entries that are not run directories (a plain file, a directory with no
//   run.json, a malformed run.json) are skipped silently. Missing root reads as empty.
//
// Deliberately NOT frozen: the specific non-zero exit code for usage errors, record's
// stdout wording, and pending's exact line format beyond "runId and issueId appear on
// the same line" — outcomes freeze, formatting decisions do not.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'verdict.js');

let failed = 0;
function check(name, cond) {
  console.log(`${cond ? 'ok' : 'FAIL'} - ${name}`);
  if (!cond) failed = 1;
}

check('scripts/verdict.js exists', fs.existsSync(SCRIPT));

// ---- fixture: a runs root with three runs carrying app-001, plus noise -------------
// Naming is the trap. The startedAt-newest run is 'm-run-live': neither first nor last
// in readdir order (so take-first and take-last both lose), lexicographically smaller
// than 'z-run-old' (so max-runId loses), and its mtimes are forced oldest below (so
// mtime-sort loses). Only startedAt names it newest.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-verdict-'));
const RUNS = path.join(tmp, 'runsroot');
const NOW = Date.now();
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();

const RUN_LIVE = 'm-run-live';      // startedAt newest — the correct recency choice
const RUN_OLD = 'z-run-old';        // startedAt 48h ago; its app-001 row has prUrl: null
const RUN_UNDATED = 'a-run-undated'; // run.json parses, no startedAt — sorts oldest

const PR_LIVE = 'https://example.invalid/pr/7';
const PR_OLD4 = 'https://example.invalid/pr/3';
const PR_UND = 'https://example.invalid/pr/9';

function writeRun(runId, manifest) {
  const d = path.join(RUNS, runId);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'run.json'), JSON.stringify(manifest, null, 2));
  return d;
}

writeRun(RUN_LIVE, {
  runId: RUN_LIVE, startedAt: iso(60 * 60 * 1000),
  tasks: [
    { issueId: 'app-001', outcome: 'done', prUrl: PR_LIVE },
    { issueId: 'app-null', outcome: 'done', prUrl: null },
    { issueId: 'app-nokey', outcome: 'failed' },
  ],
});
// Pre-seeded artifacts C4 must prove untouched; note RUN_LIVE has no tasks/app-001/.
fs.writeFileSync(path.join(RUNS, RUN_LIVE, 'report.md'), '# report\n');
fs.writeFileSync(path.join(RUNS, RUN_LIVE, 'run.log'), '2026-01-01T00:00:00Z INFO x\n');
fs.mkdirSync(path.join(RUNS, RUN_LIVE, 'tasks', 'app-null'), { recursive: true });
fs.writeFileSync(path.join(RUNS, RUN_LIVE, 'tasks', 'app-null', 'status.json'), '{"ok":true}\n');
fs.writeFileSync(path.join(RUNS, RUN_LIVE, 'tasks', 'app-null', 'verify.json'), '{"pass":true}\n');

const oldDir = writeRun(RUN_OLD, {
  runId: RUN_OLD, startedAt: iso(48 * 60 * 60 * 1000),
  tasks: [
    { issueId: 'app-001', outcome: 'done', prUrl: null },
    { issueId: 'app-003', outcome: 'done', prUrl: 'https://example.invalid/pr/2' },
    { issueId: 'app-004', outcome: 'done', prUrl: PR_OLD4 },
  ],
});
// app-003 is already verdicted — pending must not list it.
fs.mkdirSync(path.join(oldDir, 'tasks', 'app-003'), { recursive: true });
fs.writeFileSync(path.join(oldDir, 'tasks', 'app-003', 'verdict.json'),
  JSON.stringify({ issueId: 'app-003', runId: RUN_OLD, verdict: 'merged', reason: 'fine', recordedAt: iso(1000) }));

writeRun(RUN_UNDATED, { runId: RUN_UNDATED, tasks: [{ issueId: 'app-001', outcome: 'done', prUrl: PR_UND }] });

// Noise the real runs root really contains: a sweeps-style directory, an empty
// directory, a directory whose run.json is malformed, and a regular file at the root.
fs.mkdirSync(path.join(RUNS, 'sweeps', '20260101-000000'), { recursive: true });
fs.writeFileSync(path.join(RUNS, 'sweeps', '20260101-000000', 'summary.txt'), 'sweep\n');
fs.mkdirSync(path.join(RUNS, 'locks'), { recursive: true });
fs.mkdirSync(path.join(RUNS, 'broken-run'), { recursive: true });
fs.writeFileSync(path.join(RUNS, 'broken-run', 'run.json'), '{ this is not json');
fs.writeFileSync(path.join(RUNS, 'live-2026.log'), 'not a directory\n');

// Force mtimes against the correct answer: the startedAt-newest run looks oldest on
// disk, and the startedAt-oldest looks freshest.
const old3d = new Date(NOW - 3 * 24 * 60 * 60 * 1000);
fs.utimesSync(path.join(RUNS, RUN_LIVE, 'run.json'), old3d, old3d);
fs.utimesSync(path.join(RUNS, RUN_LIVE), old3d, old3d);

// ---- helpers -----------------------------------------------------------------------
function snapshot(root) {
  const map = new Map();
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else map.set(path.relative(root, p).split(path.sep).join('/'),
        crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex'));
    }
  })(root);
  return map;
}
function diffSnapshots(before, after) {
  const added = [], changed = [], removed = [];
  for (const [p, h] of after) {
    if (!before.has(p)) added.push(p);
    else if (before.get(p) !== h) changed.push(p);
  }
  for (const p of before.keys()) if (!after.has(p)) removed.push(p);
  return { added, changed, removed };
}
function run(args, opts = {}) {
  const env = { ...process.env, VERDICT_RUNS_DIR: RUNS, ...(opts.env || {}) };
  if (opts.unsetSeam) delete env.VERDICT_RUNS_DIR;
  return spawnSync(process.execPath, [opts.script || SCRIPT, ...args],
    { encoding: 'utf8', env, cwd: opts.cwd || tmp, timeout: 60000 });
}
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const pairLine = (out, runId, issueId) => {
  const lines = String(out).split(/\r?\n/);
  return lines.findIndex((l) => l.includes(runId) && l.includes(issueId));
};

const initial = snapshot(RUNS);

// ---- C3: usage errors refuse loudly and write nothing (checked before any success,
// so a validate-after-write stub cannot hide behind a later legitimate file) ---------
const badWord = run(['record', 'app-001', 'approved', 'looks good']);
check('C3 a verdict word outside merged|rejected exits non-zero',
  badWord.status !== 0 && badWord.status !== null);
const noReason = run(['record', 'app-001', 'rejected', '   ']);
check('C3 a whitespace-only reason exits non-zero', noReason.status !== 0 && noReason.status !== null);
const missingReason = run(['record', 'app-001', 'rejected']);
check('C3 a missing reason exits non-zero', missingReason.status !== 0 && missingReason.status !== null);
const unknownIssue = run(['record', 'app-zzz', 'merged', 'ghost']);
check('C3 an issue id in no run.json exits non-zero', unknownIssue.status !== 0 && unknownIssue.status !== null);
const wrongRun = run(['record', 'app-004', 'merged', 'wrong home', '--run', RUN_LIVE]);
check('C3 --run naming a run without the issue exits non-zero', wrongRun.status !== 0 && wrongRun.status !== null);
{
  const d = diffSnapshots(initial, snapshot(RUNS));
  check('C3 no error case wrote, changed or removed anything (content hash, not names)',
    d.added.length === 0 && d.changed.length === 0 && d.removed.length === 0);
}

// ---- C5 (first half): pending before any verdict is recorded -----------------------
const pend1 = run(['pending']);
check('C5 pending exits 0 on a root with findings', pend1.status === 0);
const iLive1 = pairLine(pend1.stdout, RUN_LIVE, 'app-001');
const iOld1 = pairLine(pend1.stdout, RUN_OLD, 'app-004');
check('C5 pending lists the newest run\'s pair (runId and issueId on one line)', iLive1 >= 0);
check('C5 pending lists the older run\'s unverdicted pair', iOld1 >= 0);
check('C5 newest run\'s pair comes before the older run\'s', iLive1 >= 0 && iOld1 >= 0 && iLive1 < iOld1);
check('C5 pending lists the undated run\'s pair', pairLine(pend1.stdout, RUN_UNDATED, 'app-001') >= 0);
check('C5 pending does not list the prUrl:null task', pairLine(pend1.stdout, RUN_LIVE, 'app-null') === -1);
check('C5 pending does not list the task with no prUrl key', pairLine(pend1.stdout, RUN_LIVE, 'app-nokey') === -1);
check('C5 pending does not list the already-verdicted task', pairLine(pend1.stdout, RUN_OLD, 'app-003') === -1);

// ---- C1: record picks the startedAt-newest run and writes a complete verdict -------
const beforeMs = Date.now();
const rec1 = run(['record', 'app-001', 'rejected', 'spec drift']);
const afterMs = Date.now();
check('C1 record exits 0', rec1.status === 0);
const vLivePath = path.join(RUNS, RUN_LIVE, 'tasks', 'app-001', 'verdict.json');
const vLive = readJson(vLivePath);
check('C1 verdict.json lands in the startedAt-newest run (tasks/app-001/ created)', vLive !== null);
check('C1 the lexicographically-larger, mtime-fresher run gained no verdict',
  !fs.existsSync(path.join(RUNS, RUN_OLD, 'tasks', 'app-001', 'verdict.json')));
check('C1 the undated run gained no verdict (undated sorts oldest, never newest)',
  !fs.existsSync(path.join(RUNS, RUN_UNDATED, 'tasks', 'app-001', 'verdict.json')));
check('C1 issueId recorded exactly', !!vLive && vLive.issueId === 'app-001');
check('C1 runId names the chosen run', !!vLive && vLive.runId === RUN_LIVE);
check('C1 verdict recorded exactly', !!vLive && vLive.verdict === 'rejected');
check('C1 reason recorded exactly', !!vLive && vLive.reason === 'spec drift');
check('C1 prUrl copied from the task row', !!vLive && vLive.prUrl === PR_LIVE);
const t1 = vLive ? Date.parse(vLive.recordedAt) : NaN;
check('C1 recordedAt is an ISO string inside the test\'s own clock window',
  !!vLive && typeof vLive.recordedAt === 'string'
  && /^\d{4}-\d{2}-\d{2}T/.test(vLive.recordedAt)
  && !Number.isNaN(t1) && t1 >= beforeMs - 2000 && t1 <= afterMs + 2000);

// ---- C4: a successful record added exactly one file and edited none ----------------
{
  const d = diffSnapshots(initial, snapshot(RUNS));
  check('C4 the only new path is the one verdict.json',
    d.added.length === 1 && d.added[0] === `${RUN_LIVE}/tasks/app-001/verdict.json`);
  check('C4 zero pre-existing bytes changed, zero files removed',
    d.changed.length === 0 && d.removed.length === 0);
}

// ---- C2: --run overrides recency; null prUrl is omitted; overwrite is in place -----
const readBytes = (p) => { try { return fs.readFileSync(p); } catch { return null; } };
const listDir = (p) => { try { return fs.readdirSync(p); } catch { return null; } };
const liveBytes1 = readBytes(vLivePath);
const rec2 = run(['record', 'app-001', 'merged', 'second thoughts', '--run', RUN_OLD]);
check('C2 record --run exits 0', rec2.status === 0);
const vOldPath = path.join(RUNS, RUN_OLD, 'tasks', 'app-001', 'verdict.json');
let vOld = readJson(vOldPath);
check('C2 --run wrote into the named (older) run, not the recency choice', vOld !== null);
check('C2 a null prUrl task row yields a verdict.json with NO prUrl key',
  !!vOld && !('prUrl' in vOld));
check('C2 --run verdict fields recorded exactly',
  !!vOld && vOld.runId === RUN_OLD && vOld.verdict === 'merged' && vOld.reason === 'second thoughts');
const rec3 = run(['record', 'app-001', 'rejected', 'final word', '--run', RUN_OLD]);
check('C2 re-recording the same (run, issue) exits 0', rec3.status === 0);
vOld = readJson(vOldPath);
const oldTaskDir = listDir(path.join(RUNS, RUN_OLD, 'tasks', 'app-001'));
check('C2 overwrite leaves exactly one verdict.json with the later call\'s contents',
  !!oldTaskDir && oldTaskDir.length === 1 && oldTaskDir[0] === 'verdict.json'
  && !!vOld && vOld.verdict === 'rejected' && vOld.reason === 'final word');
const liveBytes2 = readBytes(vLivePath);
check('C2 the newest run\'s verdict.json is byte-identical after both --run calls',
  liveBytes1 !== null && liveBytes2 !== null && liveBytes2.equals(liveBytes1));

// ---- C5 (second half): the recorded pair drops out; still exit 0 -------------------
const pend2 = run(['pending']);
check('C5 pending still exits 0 after records', pend2.status === 0);
check('C5 the recorded pair dropped out', pairLine(pend2.stdout, RUN_LIVE, 'app-001') === -1);
check('C5 the untouched pending pair remains', pairLine(pend2.stdout, RUN_OLD, 'app-004') >= 0);

// ---- C5 (default root): script-location-relative, never the cwd --------------------
// A copy of the (self-contained) script at <tempRoot2>/scripts/verdict.js must find
// <tempRoot2>/runs with the seam unset, from an unrelated working directory.
{
  const root2 = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-verdict-default-'));
  fs.mkdirSync(path.join(root2, 'scripts'), { recursive: true });
  const script2 = path.join(root2, 'scripts', 'verdict.js');
  if (fs.existsSync(SCRIPT)) fs.copyFileSync(SCRIPT, script2);
  const r2runs = path.join(root2, 'runs');
  const d2 = path.join(r2runs, 'solo-run');
  fs.mkdirSync(d2, { recursive: true });
  fs.writeFileSync(path.join(d2, 'run.json'), JSON.stringify({
    runId: 'solo-run', startedAt: iso(5000),
    tasks: [{ issueId: 'app-777', outcome: 'done', prUrl: 'https://example.invalid/pr/77' }],
  }));
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-verdict-cwd-'));
  const pendDef = run(['pending'], { script: script2, cwd: elsewhere, unsetSeam: true });
  check('C5 with the seam unset, the root resolves from the script location, not the cwd',
    pendDef.status === 0 && pairLine(pendDef.stdout, 'solo-run', 'app-777') >= 0);
}

// ---- C6: the Docker-free suite exists, passes, and is countable --------------------
check('C6 scripts/test-verdict.sh exists', fs.existsSync(path.join(ROOT, 'scripts', 'test-verdict.sh')));
check('C6 tests/unit/verdict.test.js exists', fs.existsSync(path.join(ROOT, 'tests', 'unit', 'verdict.test.js')));
{
  const env = { ...process.env };
  delete env.VERDICT_RUNS_DIR; // the suite owns its own fixtures; inherit nothing
  const suite = spawnSync('sh', [path.join('scripts', 'test-verdict.sh')],
    { cwd: ROOT, encoding: 'utf8', env, timeout: 300000 });
  const out = `${suite.stdout || ''}\n${suite.stderr || ''}`;
  const oks = (out.match(/^ok - /gm) || []).length;
  const fails = (out.match(/^FAIL/gm) || []).length;
  check('C6 sh scripts/test-verdict.sh exits 0', suite.status === 0);
  check('C6 the suite prints at least 15 "ok - " lines (sweep-countable)', oks >= 15);
  check('C6 the suite prints zero FAIL lines', fails === 0);
}

process.exit(failed);
