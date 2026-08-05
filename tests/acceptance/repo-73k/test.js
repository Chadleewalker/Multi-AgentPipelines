// Frozen acceptance test — the run-history audit (DESIGN.md §5, change-log row
// `run-audit`). Written before implementation, from the spec alone; criteria C1–C6 map
// 1:1 to the issue's "Done means" list. Plain Node, Docker-free: it builds throwaway
// runs roots under the OS temp dir and drives scripts/audit-runs.js as a child through
// process.execPath, reaching each fixture via the AUDIT_RUNS_DIR seam. All ids, URLs
// and reasons are invented — nothing here names a real target project.
//
// THE FROZEN INTERFACE:
//   node scripts/audit-runs.js            (no arguments; any argument is a usage error)
//     - reads the runs root ($AUDIT_RUNS_DIR, else <script dir>/../runs — never the
//       cwd; a missing root is an empty corpus) and prints ONE markdown report to
//       stdout. A pure reader: creates, modifies and deletes nothing, anywhere.
//     - exit 0 on any readable tree, whatever it finds; non-zero ONLY for a usage
//       error, which prints usage and no report.
//     - every root entry lands in exactly one bucket: real run (run.json parses to an
//       object), preflight dir (no run.json, readable run.log), or other — named with
//       its kind: `file`, `no-artifacts`, `unreadable-manifest`.
//     - the report carries these assertable line shapes (pinned so a test can exist;
//       prose around them is free):
//         total entries: <n>       real runs: <n>
//         preflight dirs: <n>      other entries: <n>
//         a preflight reason line: the reason text (timestamp and [runId/phase] tag
//           stripped, trailing \r stripped) and its count on one line
//         an attempts line per bucket: `<n> attempt(s): <count>`
//         a pause line: `pauses` and the SUM on one line
//         a model line per model, `(none recorded)` for rows without one
//         a repeats entry per repeated issueId: its `runId:outcome:exitCode` items in
//           startedAt order (undated runs sort oldest), on one line per repeat or one
//           line per item — order observable either way
//         partial forensics: the partial's issueId, each blamed sibling id with tag
//           `same-run` or `other-run`, or `(no regression output recorded)`
//         channels: `spec concerns` + total, `memory notes` + total, verdict coverage
//           `<n> with` / `<n> without`, and each done-but-rejected issueId on a line
//           containing `rejected`; a zero-concern corpus prints exactly
//           `(zero spec concerns recorded anywhere in this corpus)`
//         distributions: per metric one line with the metric name and
//           `min= p25= med= p75= p95= max=` values (nearest-rank: sorted ascending,
//           element ceil(p*n), 1-indexed), plus `excluded: <n>` when rows lacked the
//           metric; an empty sample set renders `(no data)`
//     - deterministic to the byte: same tree, same bytes; no wall-clock timestamp.
//
// Deliberately NOT frozen: section prose and ordering beyond the shapes above, the
// specific non-zero usage exit code, and stdout wording for the usage message —
// outcomes freeze, formatting decisions do not.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'audit-runs.js');

let failed = 0;
function check(name, cond) {
  console.log(`${cond ? 'ok' : 'FAIL'} - ${name}`);
  if (!cond) failed = 1;
}

check('scripts/audit-runs.js exists', fs.existsSync(SCRIPT));

// Timestamps are computed from a fixed epoch, never hardcoded strings and never the
// wall clock — the report must be byte-stable and must contain no CURRENT timestamp,
// so fixture time lives in 2020 while the test runs years later.
const T0 = Date.UTC(2020, 0, 1);
const iso = (hoursAfterT0) => new Date(T0 + hoursAfterT0 * 3600 * 1000).toISOString();

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-audit-'));

function writeRun(root, runId, manifest) {
  const d = path.join(root, runId);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'run.json'), JSON.stringify(manifest, null, 2));
  return d;
}
function writeTaskFile(root, runId, issueId, name, obj) {
  const d = path.join(root, runId, 'tasks', issueId);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, name), typeof obj === 'string' ? obj : JSON.stringify(obj, null, 1));
}
function snapshot(root) {
  const map = new Map();
  if (!fs.existsSync(root)) return map;
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { map.set(path.relative(root, p).split(path.sep).join('/') + '/', 'dir'); walk(p); }
      else map.set(path.relative(root, p).split(path.sep).join('/'),
        crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex'));
    }
  })(root);
  return map;
}
function sameSnapshot(a, b) {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}
function runAudit(runsDir, opts = {}) {
  const env = { ...process.env };
  delete env.AUDIT_RUNS_DIR;
  if (runsDir !== null) env.AUDIT_RUNS_DIR = runsDir;
  return spawnSync(process.execPath, [opts.script || SCRIPT, ...(opts.args || [])],
    { encoding: 'utf8', env, cwd: opts.cwd || tmp, timeout: 120000 });
}
const lines = (out) => String(out || '').split(/\r?\n/);
const lineWith = (out, ...tokens) =>
  lines(out).findIndex((l) => tokens.every((t) => l.includes(t)));
const hasRe = (out, re) => lines(out).some((l) => re.test(l));

// ==== fixture A (C1, C2, C5): 11 root entries ======================================
// Three real runs, one per runId naming shape. startedAt order (undated oldest, then
// MID at +48h, then NEW at +96h) contradicts lexicographic order (MID < NEW < UND)
// and, below, mtime (NEW is forced to look oldest on disk).
const A = path.join(tmp, 'rootA');
const RUN_UND = 'shadow-01-generic';            // run.json parses, NO startedAt
const RUN_MID = '2026-01-03T00-00-00-000Z';     // startedAt +48h
const RUN_NEW = 'e2e-20260101-000000-bail';     // startedAt +96h — the newest
const TGT_X = 'https://example.invalid/repo-x.git';
const TGT_Y = 'https://example.invalid/repo-y.git';

writeRun(A, RUN_UND, {
  runId: RUN_UND, targetRepo: TGT_X,
  tasks: [{ issueId: 'app-001', outcome: 'tampered', exitCode: 11, model: 'model-a' }],
});
writeRun(A, RUN_MID, {
  runId: RUN_MID, startedAt: iso(48), targetRepo: TGT_Y,
  tasks: [
    { issueId: 'app-001', outcome: 'stuck', exitCode: 10, attempts: 3, model: 'model-a' },
    { issueId: 'app-002', outcome: 'done', exitCode: 0, attempts: 1, pauses: 2, model: 'model-a' },
  ],
});
writeRun(A, RUN_NEW, {
  runId: RUN_NEW, startedAt: iso(96), targetRepo: TGT_X,
  tasks: [
    { issueId: 'app-001', outcome: 'done', exitCode: 0, attempts: 2, pauses: 3, model: 'model-b' },
    { issueId: 'app-003', outcome: 'partial', exitCode: 0, attempts: 1 },   // model absent — the one (none recorded)
    { issueId: 'app-004', outcome: 'done', exitCode: 0, attempts: 1, model: 'model-b' },
    { issueId: 'app-005', outcome: 'failed', exitCode: 137, model: 'model-b' },
  ],
});
// Four preflight dirs: two identical reasons (one LF, one CRLF, different timestamps),
// one different last-ERROR, one with no ERROR line at all.
const REASON_GHOST = "PREFLIGHT FAILED — no tasks launched: image 'ghost:v0' not found";
const REASON_ODD = 'stale-issue recovery skipped: probe failed';
function writePreflight(runId, body) {
  const d = path.join(A, runId);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'run.log'), body);
}
writePreflight('pf-a', `${iso(1)} INFO [x-1/preflight] token loaded\n${iso(1)} ERROR [x-1/preflight] ${REASON_GHOST}\n`);
writePreflight('pf-b', `${iso(2)} INFO [x-1/preflight] token loaded\r\n${iso(2)} ERROR [x-1/preflight] ${REASON_GHOST}\r\n`);
writePreflight('pf-c', `${iso(3)} ERROR [x-2/preflight] ${REASON_GHOST}\n${iso(3)} ERROR [x-2/queue] ${REASON_ODD}\n`);
writePreflight('pf-d', `${iso(4)} INFO [x-3/preflight] token loaded\n${iso(4)} INFO [x-3/preflight] docker daemon reachable\n`);
// Four "other" entries: an empty dir, a subdirs-only dir, an unparseable run.json, a file.
fs.mkdirSync(path.join(A, 'locks'), { recursive: true });
fs.mkdirSync(path.join(A, 'sweeps', '20260101-000000'), { recursive: true });
fs.writeFileSync(path.join(A, 'sweeps', '20260101-000000', 'summary.txt'), 'sweep\n');
fs.mkdirSync(path.join(A, 'broken-run'), { recursive: true });
fs.writeFileSync(path.join(A, 'broken-run', 'run.json'), '{ this is not json');
fs.writeFileSync(path.join(A, 'campaign.out'), 'not a directory\n');
// Force mtimes against startedAt: the newest run looks oldest on disk.
const oldDate = new Date(T0 - 90 * 24 * 3600 * 1000);
fs.utimesSync(path.join(A, RUN_NEW, 'run.json'), oldDate, oldDate);
fs.utimesSync(path.join(A, RUN_NEW), oldDate, oldDate);

// ---- C5 setup: run the full audit from a dedicated empty cwd, snapshot everything --
const emptyCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-audit-cwd-'));
const scriptDir = path.dirname(SCRIPT);
const snapA1 = snapshot(A);
const snapS1 = snapshot(scriptDir);

const repA = runAudit(A, { cwd: emptyCwd });
const outA = repA.stdout;

// ---- C1: corpus summary ------------------------------------------------------------
check('C1 the audit exits 0 on the 11-entry root', repA.status === 0);
check('C1 total entries: 11', hasRe(outA, /total entries[^0-9]*11\b/i));
check('C1 real runs: 3', hasRe(outA, /real runs[^0-9]*3\b/i));
check('C1 preflight dirs: 4', hasRe(outA, /preflight dirs[^0-9]*4\b/i));
check('C1 other entries: 4', hasRe(outA, /other entries[^0-9]*4\b/i));
{
  const i = lineWith(outA, REASON_GHOST);
  check('C1 the LF and CRLF twins group as ONE reason (tag and \\r stripped)',
    i >= 0 && /\b2\b/.test(lines(outA)[i]));
  check('C1 the grouped reason line carries no timestamp and no [runId/phase] tag',
    i >= 0 && !/\d{4}-\d{2}-\d{2}T/.test(lines(outA)[i]) && !/\[x-1\/preflight\]/.test(lines(outA)[i]));
}
{
  const i = lineWith(outA, REASON_ODD);
  check('C1 the odd reason (a non-PREFLIGHT last ERROR) groups alone with count 1',
    i >= 0 && /\b1\b/.test(lines(outA)[i]));
}
{
  const i = lineWith(outA, '(no ERROR line in run.log)');
  check('C1 the no-ERROR log is its own pinned group with count 1',
    i >= 0 && /\b1\b/.test(lines(outA)[i]));
}
check('C1 the regular file is named with kind `file`', lineWith(outA, 'campaign.out', 'file') >= 0);
check('C1 the empty dir is named with kind `no-artifacts`', lineWith(outA, 'locks', 'no-artifacts') >= 0);
check('C1 the subdirs-only dir is named with kind `no-artifacts`', lineWith(outA, 'sweeps', 'no-artifacts') >= 0);
check('C1 the unparseable run.json is named with kind `unreadable-manifest`',
  lineWith(outA, 'broken-run', 'unreadable-manifest') >= 0);

// ---- C2: joins by startedAt, never by name -----------------------------------------
check('C2 both targetRepo strings appear', outA.includes(TGT_X) && outA.includes(TGT_Y));
check('C2 attempts distribution: two 1-attempt done tasks', hasRe(outA, /1 attempt\(s\)[^0-9]*2\b/));
check('C2 attempts distribution: one 2-attempt done task', hasRe(outA, /2 attempt\(s\)[^0-9]*1\b/));
check('C2 the pause line carries the SUM (5), not the pause-bearing row count (2)',
  hasRe(outA, /pause[^0-9]*5\b/i) && !hasRe(outA, /pause[^0-9]*2\b/i) && !hasRe(outA, /pause[^0-9]*3\b/i));
check('C2 exactly one model reads (none recorded)', hasRe(outA, /\(none recorded\)[^0-9]*1\b/));
{
  const sUnd = `${RUN_UND}:tampered:11`;
  const sMid = `${RUN_MID}:stuck:10`;
  const sNew = `${RUN_NEW}:done:0`;
  const iU = outA.indexOf(sUnd), iM = outA.indexOf(sMid), iN = outA.indexOf(sNew);
  check('C2 repeats: app-001 in three runs as runId:outcome:exitCode', iU >= 0 && iM >= 0 && iN >= 0);
  check('C2 repeats order is startedAt ascending — undated first, despite runId sort and mtime saying otherwise',
    iU >= 0 && iM >= 0 && iN >= 0 && iU < iM && iM < iN);
  check('C2 exit codes 11 and 137 both survive into the report (open enum)',
    iU >= 0 && outA.includes(':failed:137'));
}

// ---- C5: pure reader, empty-corpus root, usage error, script-relative default ------
check('C5 the runs root is byte-identical after the audit', sameSnapshot(snapA1, snapshot(A)));
check('C5 the script directory is byte-identical after the audit', sameSnapshot(snapS1, snapshot(scriptDir)));
check('C5 the dedicated cwd is still empty (no cache, no report file)',
  fs.readdirSync(emptyCwd).length === 0);
{
  const ghost = runAudit(path.join(tmp, 'no-such-root'), { cwd: emptyCwd });
  check('C5 a nonexistent runs root is an empty corpus: exit 0 with a report',
    ghost.status === 0 && hasRe(ghost.stdout, /total entries[^0-9]*0\b/i));
}
{
  const bad = runAudit(A, { cwd: emptyCwd, args: ['--verbose'] });
  check('C5 any argument is a usage error: non-zero exit', bad.status !== 0 && bad.status !== null);
  check('C5 a usage error prints no report (no summary line on stdout)',
    !/total entries/i.test(bad.stdout || ''));
}
{
  // The copied, self-contained script must find <root2>/runs with the seam unset,
  // from an unrelated cwd — same bytes as the seam-directed read of the same tree.
  const root2 = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-audit-default-'));
  fs.mkdirSync(path.join(root2, 'scripts'), { recursive: true });
  const script2 = path.join(root2, 'scripts', 'audit-runs.js');
  if (fs.existsSync(SCRIPT)) fs.copyFileSync(SCRIPT, script2);
  const runs2 = path.join(root2, 'runs');
  writeRun(runs2, 'solo-run', {
    runId: 'solo-run', startedAt: iso(10), targetRepo: TGT_X,
    tasks: [{ issueId: 'app-777', outcome: 'done', exitCode: 0, attempts: 1, model: 'model-a' }],
  });
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-audit-elsewhere-'));
  const viaSeam = runAudit(runs2, { cwd: elsewhere });
  const viaDefault = runAudit(null, { script: script2, cwd: elsewhere });
  check('C5 with the seam unset, the root resolves from the script location, not the cwd',
    viaDefault.status === 0 && viaDefault.stdout.includes('solo-run'));
  check('C5 the default-root read and the seam-directed read of one tree agree byte-for-byte',
    viaSeam.status === 0 && viaDefault.status === 0 && viaSeam.stdout === viaDefault.stdout);
}

// ==== fixture B (C3): partial forensics, channels, verdict coverage =================
const B = path.join(tmp, 'rootB');
const RUN_P1 = 'p1-run';
const RUN_P2 = 'p2-run';
writeRun(B, RUN_P1, {
  runId: RUN_P1, startedAt: iso(200), targetRepo: TGT_X,
  tasks: [
    { issueId: 'app-101', outcome: 'partial', exitCode: 0, prUrl: 'https://example.invalid/pr/1' },
    { issueId: 'app-002', outcome: 'done', exitCode: 0, attempts: 1, model: 'model-a', prUrl: 'https://example.invalid/pr/2' },
    { issueId: 'app-102', outcome: 'done', exitCode: 0, attempts: 1, model: 'model-a', prUrl: 'https://example.invalid/pr/4' },
    { issueId: 'app-103', outcome: 'done', exitCode: 0, attempts: 1, model: 'model-a', prUrl: null },
  ],
});
writeRun(B, RUN_P2, {
  runId: RUN_P2, startedAt: iso(224), targetRepo: TGT_X,
  tasks: [
    { issueId: 'app-201', outcome: 'partial', exitCode: 0, prUrl: 'https://example.invalid/pr/3' },
    { issueId: 'app-301', outcome: 'partial', exitCode: 0 },
  ],
});
// app-101's regressions blame app-002, which IS a row in RUN_P1 -> same-run.
writeTaskFile(B, RUN_P1, 'app-101', 'verify.json', {
  issueId: 'app-101', acceptance: 'pass', regressions: 'fail',
  regressionOutput: 'ok 1 - something\nregressions: frozen acceptance tests in tests/acceptance/app-002/ FAIL\n',
});
// app-201's regressions blame app-002 too, which is NOT a row in RUN_P2 -> other-run.
writeTaskFile(B, RUN_P2, 'app-201', 'verify.json', {
  issueId: 'app-201', acceptance: 'pass', regressions: 'fail',
  regressionOutput: 'regressions: frozen acceptance tests in tests/acceptance/app-002/ FAIL\n',
});
// app-301: partial with a verify.json that has NO regressionOutput key.
writeTaskFile(B, RUN_P2, 'app-301', 'verify.json', {
  issueId: 'app-301', acceptance: 'pass', regressions: 'absent',
});
// Channels: app-101 carries 2 specConcerns + 3 memoryNotes; app-201 has NO status.json.
writeTaskFile(B, RUN_P1, 'app-101', 'status.json', {
  issueId: 'app-101',
  specConcerns: ['criterion 3 names a directory that does not exist', 'criterion 5 cannot fail'],
  memoryNotes: ['note one', 'note two', 'note three'],
});
// Verdicts: app-002 merged; app-102 REJECTED on a done row (the blind-spot join);
// app-201 is PR-bearing with no verdict; app-103 (null prUrl) has a verdict-shaped
// file that must land in NO coverage bucket.
writeTaskFile(B, RUN_P1, 'app-002', 'verdict.json',
  { issueId: 'app-002', runId: RUN_P1, verdict: 'merged', reason: 'fine', recordedAt: iso(300) });
writeTaskFile(B, RUN_P1, 'app-102', 'verdict.json',
  { issueId: 'app-102', runId: RUN_P1, verdict: 'rejected', reason: 'green but wrong', recordedAt: iso(301) });
writeTaskFile(B, RUN_P1, 'app-103', 'verdict.json',
  { issueId: 'app-103', runId: RUN_P1, verdict: 'merged', reason: 'stray', recordedAt: iso(302) });

const repB = runAudit(B, { cwd: emptyCwd });
const outB = repB.stdout;
check('C3 the audit exits 0 on the forensics root', repB.status === 0);
check('C3 the same-run sibling is tagged same-run', lineWith(outB, 'app-101', 'app-002', 'same-run') >= 0);
check('C3 the other-run sibling is tagged other-run', lineWith(outB, 'app-201', 'app-002', 'other-run') >= 0);
check('C3 a partial with no regressionOutput renders (no regression output recorded)',
  lineWith(outB, 'app-301', '(no regression output recorded)') >= 0);
check('C3 spec concerns total 2 (the key is specConcerns, not concerns)',
  hasRe(outB, /spec concerns[^0-9]*2\b/i));
check('C3 memory notes total 3', hasRe(outB, /memory notes[^0-9]*3\b/i));
check('C3 verdict coverage: 2 with', hasRe(outB, /2 with\b/));
check('C3 verdict coverage: 1 without', hasRe(outB, /1 without\b/));
check('C3 the done-but-rejected task is listed on the blind-spot line',
  lineWith(outB, 'app-102', 'rejected') >= 0);
check('C3 the merged task is not on a rejected line', lineWith(outB, 'app-002', 'rejected') === -1);
check('C3 a non-zero-concern corpus does not print the zero-concern flag',
  !outB.includes('(zero spec concerns recorded anywhere in this corpus)'));

// ==== fixture C (C3): the zero-concern corpus =======================================
const C = path.join(tmp, 'rootC');
writeRun(C, 'c-run', {
  runId: 'c-run', startedAt: iso(400), targetRepo: TGT_X,
  tasks: [{ issueId: 'app-901', outcome: 'done', exitCode: 0, attempts: 1, model: 'model-a' }],
});
{
  const repC = runAudit(C, { cwd: emptyCwd });
  check('C3 a zero-concern corpus prints exactly the pinned flag line',
    repC.status === 0 && repC.stdout.includes('(zero spec concerns recorded anywhere in this corpus)'));
}

// ==== fixture D (C4): nearest-rank distributions, byte determinism ==================
// Six done rows: activeSeconds [10, 20, 40, 80, 1000] plus one row lacking it (the
// exclusion); diffLines on all six. p95 is the sole nearest-rank/interpolation
// discriminator for the 5-sample set: nearest-rank 1000, type-7 interpolation 816.
const D = path.join(tmp, 'rootD');
writeRun(D, 'd-run', {
  runId: 'd-run', startedAt: iso(500), targetRepo: TGT_X,
  tasks: [
    { issueId: 'app-d1', outcome: 'done', exitCode: 0, attempts: 1, model: 'm', activeSeconds: 10, diffLines: 6 },
    { issueId: 'app-d2', outcome: 'done', exitCode: 0, attempts: 1, model: 'm', activeSeconds: 20, diffLines: 12 },
    { issueId: 'app-d3', outcome: 'done', exitCode: 0, attempts: 1, model: 'm', activeSeconds: 40, diffLines: 24 },
    { issueId: 'app-d4', outcome: 'done', exitCode: 0, attempts: 1, model: 'm', activeSeconds: 80, diffLines: 48 },
    { issueId: 'app-d5', outcome: 'done', exitCode: 0, attempts: 1, model: 'm', activeSeconds: 1000, diffLines: 3000 },
    { issueId: 'app-d6', outcome: 'done', exitCode: 0, attempts: 1, model: 'm', diffLines: 96 },
  ],
});
{
  const rep1 = runAudit(D, { cwd: emptyCwd });
  const rep2 = runAudit(D, { cwd: emptyCwd });
  const out = rep1.stdout;
  check('C4 the audit exits 0 on the distributions root', rep1.status === 0);
  const i = lineWith(out, 'activeSeconds');
  const l = i >= 0 ? lines(out)[i] : '';
  check('C4 activeSeconds line exists with nearest-rank stats',
    /min[=:\s]+10\b/.test(l) && /p25[=:\s]+20\b/.test(l) && /med(?:ian)?[=:\s]+40\b/.test(l)
    && /p75[=:\s]+80\b/.test(l) && /p95[=:\s]+1000\b/.test(l) && /max[=:\s]+1000\b/.test(l));
  check('C4 no interpolated p95 anywhere (816 is the type-7 tell)', !out.includes('816'));
  check('C4 the excluded row is counted, not silently dropped',
    i >= 0 && /excluded[^0-9]*1\b/i.test(l));
  const j = lineWith(out, 'diffLines');
  const m = j >= 0 ? lines(out)[j] : '';
  check('C4 diffLines gets its own nearest-rank line (6 samples: med is the 3rd, 24)',
    /min[=:\s]+6\b/.test(m) && /med(?:ian)?[=:\s]+24\b/.test(m) && /p95[=:\s]+3000\b/.test(m));
  check('C4 two invocations produce byte-identical stdout',
    rep2.status === 0 && rep1.stdout === rep2.stdout);
  const nowHour = new Date().toISOString().slice(0, 13);
  check('C4 the report carries no wall-clock timestamp (fixture time is 2020; today is not)',
    !out.includes(nowHour));
}

// ==== C6: the Docker-free suite exists, passes, and is countable ====================
check('C6 scripts/test-audit-runs.sh exists', fs.existsSync(path.join(ROOT, 'scripts', 'test-audit-runs.sh')));
check('C6 tests/unit/audit-runs.test.js exists', fs.existsSync(path.join(ROOT, 'tests', 'unit', 'audit-runs.test.js')));
{
  const env = { ...process.env };
  delete env.AUDIT_RUNS_DIR; // the suite owns its own fixtures; inherit nothing
  const suite = spawnSync('sh', [path.join('scripts', 'test-audit-runs.sh')],
    { cwd: ROOT, encoding: 'utf8', env, timeout: 300000 });
  const out = `${suite.stdout || ''}\n${suite.stderr || ''}`;
  const oks = (out.match(/^ok - /gm) || []).length;
  const fails = (out.match(/^FAIL/gm) || []).length;
  check('C6 sh scripts/test-audit-runs.sh exits 0', suite.status === 0);
  check('C6 the suite prints at least 20 "ok - " lines (the sweep-countable shape)', oks >= 20);
  check('C6 the suite prints zero FAIL lines', fails === 0);
}

process.exit(failed);
