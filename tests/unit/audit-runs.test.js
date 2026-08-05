#!/usr/bin/env node
// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// Re-runnable checks for the run-history audit (scripts/audit-runs.js, DESIGN.md §5,
// change-log row `run-audit`). The frozen acceptance suite under tests/acceptance/repo-73k/
// proves the tool once and is never run again; this is the copy the sweep keeps running,
// because what the audit reports is a set of NUMBERS, and a number that quietly stops
// meaning anything goes on being printed. Two of the defects this repo has already paid
// for were exactly that shape: a channel misread as `concerns` and reported unused across
// 43 real uses, and a model id extracted from the wrong end of a map.
//
// Docker-free, network-free, git-free: it builds throwaway runs roots under the OS temp
// directory and drives the real CLI as a child through process.execPath, reaching each
// fixture through the AUDIT_RUNS_DIR seam. Safe anywhere node exists, including inside a
// task container.
//
// Every timestamp is computed from a fixed epoch — the report must be byte-stable and must
// carry no current timestamp, so fixture time lives in 2020 while the suite runs years on.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'audit-runs.js');

let failed = 0;
function ok(name, cond) {
  console.log(`${cond ? 'ok' : 'FAIL'} - ${name}`);
  if (!cond) failed = 1;
}

const T0 = Date.UTC(2020, 0, 1);
const iso = (h) => new Date(T0 + h * 3600 * 1000).toISOString();

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'unit-audit-'));
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'unit-audit-cwd-'));

function writeRun(root, runId, manifest) {
  const dir = path.join(root, runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify(manifest, null, 2));
}
function writeTaskFile(root, runId, issueId, name, body) {
  const dir = path.join(root, runId, 'tasks', issueId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), typeof body === 'string' ? body : JSON.stringify(body, null, 1));
}
function writeLog(root, dirName, body) {
  fs.mkdirSync(path.join(root, dirName), { recursive: true });
  fs.writeFileSync(path.join(root, dirName, 'run.log'), body);
}
function audit(runsDir, opts = {}) {
  const env = { ...process.env };
  delete env.AUDIT_RUNS_DIR;
  if (runsDir !== null) env.AUDIT_RUNS_DIR = runsDir;
  return spawnSync(process.execPath, [opts.script || SCRIPT, ...(opts.args || [])],
    { encoding: 'utf8', env, cwd: opts.cwd || cwd, timeout: 120000 });
}
const rows = (out) => String(out || '').split(/\r?\n/);
const rowWith = (out, ...tokens) => rows(out).findIndex((l) => tokens.every((t) => l.includes(t)));
const anyRow = (out, re) => rows(out).some((l) => re.test(l));
function snapshot(root) {
  const map = new Map();
  if (!fs.existsSync(root)) return map;
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { map.set(`${p}/`, 'dir'); walk(p); }
      else map.set(p, crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex'));
    }
  })(root);
  return map;
}
const same = (a, b) => a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);

// ---- structural: the constraints whose violation is still green ----------------------
// A self-contained CLI meant to be COPIED decays silently — nothing behavioural can see a
// new require of a repo file until someone copies the script somewhere and it explodes.
{
  const src = fs.readFileSync(SCRIPT, 'utf8');
  const required = [...src.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);
  ok('every require target is a node built-in (the script stays copyable)',
    required.length > 0 && required.every((m) => !m.startsWith('.') && !m.startsWith('/')));
  ok('no child_process anywhere (no bd, no shelling out, hard rule 1 stays safe)',
    !required.includes('child_process') && !/child_process/.test(src));
  ok('no writing API is reached for (the pure-reader contract, read structurally)',
    !/\bfs\.(write|append|mkdir|rm|unlink|copy|rename|truncate|chmod|create)/.test(src));
  ok('main() sits behind require.main so the module can be required in a test',
    /require\.main === module/.test(src));
}

// ---- fixture A: the three buckets, reasons, joins ------------------------------------
const A = path.join(tmp, 'A');
const R_UND = 'shadow-02-generic';           // parses, no startedAt -> sorts oldest
const R_MID = '2026-02-02T00-00-00-000Z';    // +48h
const R_NEW = 'e2e-20260202-000000-bail';    // +96h, the newest
const TGT_1 = 'https://example.invalid/repo-one.git';
const TGT_2 = 'https://example.invalid/repo-two.git';
writeRun(A, R_UND, {
  runId: R_UND, targetRepo: TGT_1,
  tasks: [{ issueId: 'app-011', outcome: 'tampered', exitCode: 11, model: 'model-a' }],
});
writeRun(A, R_MID, {
  runId: R_MID, startedAt: iso(48), targetRepo: TGT_2,
  tasks: [
    { issueId: 'app-011', outcome: 'stuck', exitCode: 10, attempts: 3, model: 'model-a' },
    { issueId: 'app-012', outcome: 'done', exitCode: 0, attempts: 1, pauses: 4, model: 'model-a' },
  ],
});
writeRun(A, R_NEW, {
  runId: R_NEW, startedAt: iso(96), targetRepo: TGT_1,
  tasks: [
    { issueId: 'app-011', outcome: 'done', exitCode: 0, attempts: 2, pauses: 7, model: 'model-b' },
    { issueId: 'app-013', outcome: 'failed', exitCode: 137 },
    { issueId: 'app-014', outcome: 'done', exitCode: 0, attempts: 1, model: 'model-b' },
  ],
});
const REASON = "PREFLIGHT FAILED — no tasks launched: image 'ghost:v0' not found";
writeLog(A, 'pf-1', `${iso(1)} INFO [y-1/preflight] token loaded\n${iso(1)} ERROR [y-1/preflight] ${REASON}\n`);
writeLog(A, 'pf-2', `${iso(2)} ERROR [y-2/preflight] ${REASON}\r\n`);
writeLog(A, 'pf-3', `${iso(3)} ERROR [y-3/preflight] ${REASON}\n${iso(3)} ERROR [y-3/queue] queue empty: nothing ready\n`);
writeLog(A, 'pf-4', `${iso(4)} INFO [y-4/preflight] docker daemon reachable\n`);
fs.mkdirSync(path.join(A, 'empty-dir'), { recursive: true });
fs.mkdirSync(path.join(A, 'sweeps', '20260202-000000'), { recursive: true });
fs.writeFileSync(path.join(A, 'sweeps', '20260202-000000', 'summary.txt'), 'sweep\n');
fs.mkdirSync(path.join(A, 'half-written'), { recursive: true });
fs.writeFileSync(path.join(A, 'half-written', 'run.json'), '{"runId": "half-written"');
fs.writeFileSync(path.join(A, 'live-generic.log'), 'a regular file at the root\n');

const snapBefore = snapshot(A);
const a = audit(A);
const outA = a.stdout;

ok('exit 0 on a mixed tree', a.status === 0);
ok('total entries: 11', anyRow(outA, /total entries[^0-9]*11\b/));
ok('real runs: 3 (only a run.json that parses to an object)', anyRow(outA, /real runs[^0-9]*3\b/));
ok('preflight dirs: 4 (no run.json, a readable run.log)', anyRow(outA, /preflight dirs[^0-9]*4\b/));
ok('other entries: 4, so the buckets reconcile against the total',
  anyRow(outA, /other entries[^0-9]*4\b/));
ok('the regular file is named with kind `file`, not crashed on (ENOTDIR)',
  rowWith(outA, 'live-generic.log', 'file') >= 0);
ok('the empty dir is named `no-artifacts`', rowWith(outA, 'empty-dir', 'no-artifacts') >= 0);
ok('the subdirs-only dir is named `no-artifacts`', rowWith(outA, 'sweeps', 'no-artifacts') >= 0);
ok('the unparseable manifest is named `unreadable-manifest`, neither run nor invisible',
  rowWith(outA, 'half-written', 'unreadable-manifest') >= 0);
{
  const i = rowWith(outA, REASON);
  ok('the LF and CRLF logs group as ONE reason with count 2', i >= 0 && /\b2\b/.test(rows(outA)[i]));
  ok('the grouped reason drops the timestamp and the [runId/phase] tag',
    i >= 0 && !/\d{4}-\d{2}-\d{2}T/.test(rows(outA)[i]) && !/\[y-\d\/preflight\]/.test(rows(outA)[i]));
}
ok('the last ERROR wins, even when it is not a PREFLIGHT FAILED line',
  rowWith(outA, 'queue empty: nothing ready') >= 0);
ok('a run.log with no ERROR line is its own pinned group',
  rowWith(outA, '(no ERROR line in run.log)') >= 0);
ok('both targetRepo strings survive into the report', outA.includes(TGT_1) && outA.includes(TGT_2));
ok('the attempts distribution counts done tasks only (1 attempt: 2, not 3)',
  anyRow(outA, /1 attempt\(s\)[^0-9]*2\b/) && anyRow(outA, /2 attempt\(s\)[^0-9]*1\b/));
ok('the pause line carries the SUM (11), never the pause-bearing row count (2)',
  anyRow(outA, /pauses[^0-9]*11\b/));
ok('a task row with no model counts under (none recorded), never as a model name',
  anyRow(outA, /\(none recorded\)[^0-9]*1\b/));
{
  const u = outA.indexOf(`${R_UND}:tampered:11`);
  const m = outA.indexOf(`${R_MID}:stuck:10`);
  const n = outA.indexOf(`${R_NEW}:done:0`);
  ok('the repeated issueId lists every run as runId:outcome:exitCode', u >= 0 && m >= 0 && n >= 0);
  ok('repeat order is startedAt ascending — undated first, against both runId sort and mtime',
    u >= 0 && u < m && m < n);
  ok('an exit code outside the common set survives (open enum)', outA.includes(':failed:137'));
  ok('an issueId in one run only is not reported as a repeat',
    rowWith(outA, 'app-013 in ') === -1);
}

// ---- pure reader, usage, roots ------------------------------------------------------
ok('the runs root is byte-identical after the audit (pure reader)', same(snapBefore, snapshot(A)));
ok('the working directory is untouched — no cache, no index, no report file',
  fs.readdirSync(cwd).length === 0);
{
  const missing = audit(path.join(tmp, 'no-such-root'));
  ok('a missing runs root is an empty corpus: exit 0, zeroed report',
    missing.status === 0 && anyRow(missing.stdout, /total entries[^0-9]*0\b/));
  ok('the empty corpus renders every absence, never a crash or a NaN',
    missing.status === 0 && !/NaN/.test(missing.stdout) && missing.stdout.includes('(no data)'));
}
{
  const bad = audit(A, { args: ['--since', '7d'] });
  ok('any argument is a usage error: non-zero exit', bad.status !== 0 && bad.status !== null);
  ok('a usage error prints no report', !/total entries/.test(bad.stdout || ''));
}
{
  // The default root resolves from the script's own location, not the cwd — green in every
  // seam test and wrong on the first real host invocation is the failure this catches.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'unit-audit-home-'));
  fs.mkdirSync(path.join(home, 'scripts'), { recursive: true });
  const copy = path.join(home, 'scripts', 'audit-runs.js');
  fs.copyFileSync(SCRIPT, copy);
  writeRun(path.join(home, 'runs'), 'lone-run', {
    runId: 'lone-run', startedAt: iso(10), targetRepo: TGT_1,
    tasks: [{ issueId: 'app-021', outcome: 'done', exitCode: 0, attempts: 1, model: 'model-a' }],
  });
  const bySeam = audit(path.join(home, 'runs'));
  const byDefault = audit(null, { script: copy });
  ok('with the seam unset the copied script finds <script dir>/../runs',
    byDefault.status === 0 && byDefault.stdout.includes('lone-run'));
  ok('the default-root read and the seam-directed read agree byte for byte',
    bySeam.status === 0 && bySeam.stdout === byDefault.stdout);
}

// ---- fixture B: forensics, channels, coverage ---------------------------------------
const B = path.join(tmp, 'B');
writeRun(B, 'b1-run', {
  runId: 'b1-run', startedAt: iso(200), targetRepo: TGT_1,
  tasks: [
    { issueId: 'app-111', outcome: 'partial', exitCode: 0, prUrl: 'https://example.invalid/pr/11' },
    { issueId: 'app-112', outcome: 'done', exitCode: 0, attempts: 1, prUrl: 'https://example.invalid/pr/12' },
    { issueId: 'app-113', outcome: 'done', exitCode: 0, attempts: 1, prUrl: 'https://example.invalid/pr/13' },
    { issueId: 'app-114', outcome: 'done', exitCode: 0, attempts: 1, prUrl: null },
  ],
});
writeRun(B, 'b2-run', {
  runId: 'b2-run', startedAt: iso(224), targetRepo: TGT_1,
  tasks: [
    { issueId: 'app-121', outcome: 'partial', exitCode: 0 },
    {
      issueId: 'app-122',
      outcome: 'partial',
      exitCode: 0,
      // The embedded copy of the verification, which is the shape that tempts an
      // implementation away from verify.json — it never carries regressionOutput.
      verification: { acceptance: 'pass', regressions: 'fail' },
    },
  ],
});
writeTaskFile(B, 'b1-run', 'app-111', 'verify.json', {
  issueId: 'app-111', acceptance: 'pass', regressions: 'fail',
  regressionOutput: 'regressions: frozen acceptance tests in tests/acceptance/app-112/ FAIL\n',
});
writeTaskFile(B, 'b2-run', 'app-121', 'verify.json', {
  issueId: 'app-121', acceptance: 'pass', regressions: 'fail',
  regressionOutput: 'regressions: frozen acceptance tests in tests/acceptance/app-112/ FAIL\r\n',
});
// The embedded copy in the task row carries no regressionOutput — an audit reading it
// instead of verify.json is silently empty forever, so one partial has only the embedded one.
writeTaskFile(B, 'b2-run', 'app-122', 'verify.json', {
  issueId: 'app-122', acceptance: 'pass', regressions: 'fail',
});
writeTaskFile(B, 'b1-run', 'app-111', 'status.json', {
  issueId: 'app-111',
  specConcerns: ['criterion 4 cannot fail', 'criterion 6 names a path that does not exist'],
  memoryNotes: ['note one', 'note two', 'note three', 'note four'],
  concerns: ['a decoy under the key the hand pass misread'],
});
writeTaskFile(B, 'b1-run', 'app-112', 'verdict.json',
  { issueId: 'app-112', runId: 'b1-run', verdict: 'merged', reason: 'clean', recordedAt: iso(300) });
writeTaskFile(B, 'b1-run', 'app-113', 'verdict.json',
  { issueId: 'app-113', runId: 'b1-run', verdict: 'rejected', reason: 'green but wrong', recordedAt: iso(301) });
writeTaskFile(B, 'b1-run', 'app-114', 'verdict.json',
  { issueId: 'app-114', runId: 'b1-run', verdict: 'merged', reason: 'stray', recordedAt: iso(302) });

const b = audit(B);
const outB = b.stdout;
ok('exit 0 on the forensics tree', b.status === 0);
ok('a sibling whose owner ran in the same run is tagged same-run',
  rowWith(outB, 'app-111', 'app-112', 'same-run') >= 0);
ok('a sibling whose owner ran elsewhere is tagged other-run',
  rowWith(outB, 'app-121', 'app-112', 'other-run') >= 0);
ok('a CRLF regressionOutput yields the same sibling as its LF twin, no carriage return left',
  rowWith(outB, 'app-121', 'app-112') >= 0 && !outB.includes('\r'));
ok('a verify.json with no regressionOutput is a rendered fact, never a skip or a crash',
  rowWith(outB, 'app-122', '(no regression output recorded)') >= 0);
ok('spec concerns read specConcerns and total 2 — the `concerns` decoy would print 1',
  anyRow(outB, /spec concerns[^0-9]*2\b/));
ok('memory notes read memoryNotes and total 4', anyRow(outB, /memory notes[^0-9]*4\b/));
ok('verdict coverage counts PR-bearing rows: 2 with, 1 without in the run that has both',
  anyRow(outB, /2 with\b/) && anyRow(outB, /1 without\b/));
ok('a prUrl of null is not PR-bearing, so its stray verdict lands in no coverage bucket',
  !anyRow(outB, /3 with\b/) && rowWith(outB, 'awaiting a verdict', 'app-114') === -1);
ok('the done-but-rejected join is listed', rowWith(outB, 'app-113', 'rejected') >= 0);
ok('a merged task never lands on a rejected line', rowWith(outB, 'app-112', 'rejected') === -1);
ok('a corpus with concerns does not print the zero-concern flag',
  !outB.includes('(zero spec concerns recorded anywhere in this corpus)'));

// ---- fixture C: the zero-concern corpus ---------------------------------------------
const C = path.join(tmp, 'C');
writeRun(C, 'c-run', {
  runId: 'c-run', startedAt: iso(400), targetRepo: TGT_1,
  tasks: [{ issueId: 'app-131', outcome: 'done', exitCode: 0, attempts: 1, model: 'model-a' }],
});
{
  const c = audit(C);
  ok('a zero-concern corpus prints the pinned flag line, not just the number',
    c.status === 0 && c.stdout.includes('(zero spec concerns recorded anywhere in this corpus)'));
  ok('a corpus with no partials says so rather than printing an empty section',
    c.stdout.includes('(no partial tasks in this corpus)'));
}

// ---- fixture D: nearest-rank quantiles, determinism ---------------------------------
const D = path.join(tmp, 'D');
writeRun(D, 'd-run', {
  runId: 'd-run', startedAt: iso(500), targetRepo: TGT_1,
  tasks: [
    { issueId: 'app-141', outcome: 'done', exitCode: 0, attempts: 1, activeSeconds: 10, diffLines: 6 },
    { issueId: 'app-142', outcome: 'done', exitCode: 0, attempts: 1, activeSeconds: 20, diffLines: 12 },
    { issueId: 'app-143', outcome: 'done', exitCode: 0, attempts: 1, activeSeconds: 40, diffLines: 24 },
    { issueId: 'app-144', outcome: 'done', exitCode: 0, attempts: 1, activeSeconds: 80, diffLines: 48 },
    { issueId: 'app-145', outcome: 'done', exitCode: 0, attempts: 1, activeSeconds: 1000, diffLines: 3000 },
    { issueId: 'app-146', outcome: 'done', exitCode: 0, attempts: 1, diffLines: 96 },
    { issueId: 'app-147', outcome: 'failed', exitCode: 1, activeSeconds: 99999, diffLines: 99999 },
  ],
});
{
  const d1 = audit(D);
  const d2 = audit(D);
  const l = rows(d1.stdout)[rowWith(d1.stdout, 'activeSeconds')] || '';
  ok('activeSeconds quantiles are nearest-rank samples, p95 the discriminator',
    /min[=:\s]+10\b/.test(l) && /p25[=:\s]+20\b/.test(l) && /med[=:\s]+40\b/.test(l)
    && /p75[=:\s]+80\b/.test(l) && /p95[=:\s]+1000\b/.test(l) && /max[=:\s]+1000\b/.test(l));
  ok('no interpolated p95 anywhere (816 is the type-7 tell)', !d1.stdout.includes('816'));
  ok('a done row missing the metric is excluded and counted, never NaN',
    /excluded[^0-9]*1\b/.test(l) && !/NaN/.test(d1.stdout));
  ok('a row that is not done contributes no sample', !d1.stdout.includes('99999'));
  const m = rows(d1.stdout)[rowWith(d1.stdout, 'diffLines')] || '';
  ok('diffLines gets its own line (6 samples: the median is the 3rd, 24)',
    /min[=:\s]+6\b/.test(m) && /med[=:\s]+24\b/.test(m) && /p95[=:\s]+3000\b/.test(m));
  ok('two invocations over one tree produce byte-identical stdout',
    d1.status === 0 && d2.status === 0 && d1.stdout === d2.stdout);
  ok('the report carries no wall-clock timestamp',
    !d1.stdout.includes(new Date().toISOString().slice(0, 13)));
}

process.exit(failed);
