// Frozen acceptance test — the batch marker and `batch.js pending` (DESIGN.md §3.9,
// change-log row `batch-ready-marker`). Written before implementation, from the spec
// alone; criteria C1–C5 map 1:1 to the issue's "Done means" list. Plain Node,
// Docker-free: it builds throwaway runs roots under the OS temp dir and drives
// scripts/batch.js as a child through process.execPath, reaching each fixture via the
// BATCH_RUNS_DIR seam. Every project name and issue id here is invented — nothing names
// a real target project.
//
// This file inlines everything it needs. It imports no repo helper by design (§3.1): a
// frozen test that imports mutable code can change what it gates without its own text
// changing. The one exception is C5(iii), which requires scripts/dashboard.js because
// that module IS part of what the criterion observes.
//
// THE FROZEN INTERFACE:
//   Markers live at <runsRoot>/batches/<project>-<YYYY-MM-DD>.json — one JSON object.
//     Required: runConfig (string), frozenAt (ISO 8601 INSTANT), issues (array of
//     {id, title}). Optional and printed when present: integrationBranch, freezeCommit,
//     intent, approvedBy. The filename's date is naming only; frozenAt is the clock.
//   node scripts/batch.js pending
//     - batches NONE of whose ids any run has worked since frozenAt, newest frozenAt
//       first, ties broken by filename ASCENDING. Exits 0 whatever it finds.
//   node scripts/batch.js show [<stem>]
//     - prints one marker plus a per-id breakdown, each id marked `worked` or
//       `not-worked`. With no argument: the NEWEST marker by frozenAt, LAUNCHED OR NOT.
//     - in THIS task it additionally always prints `unreconciled bd-unavailable`.
//   A run's clock: startedAt from run.json when present; otherwise the leading instant
//     on the first line of run.log. Unparseable by both => the run COUNTS as having
//     worked the ids it names (the conservative direction against a double launch).
//   Degraded terms, literal: unreconciled, bd-unavailable, freeze-time-unknown,
//     run-time-unknown, no-issues. The reconciled tokens ready / not-ready / stray
//     belong to the following task and must NOT appear here.
//   Exit codes: 0 on success and on findings; 2 usage; 3 a well-formed stem naming no
//     marker. Runs root is $BATCH_RUNS_DIR, else <script dir>/../runs — never the cwd.
//
// Deliberately NOT frozen: line wording and column layout, the order of fields within a
// marker's printout, and whether ids are indented. Outcomes freeze; formatting does not.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'batch.js');

let failed = 0;
function check(name, cond) {
  console.log(`${cond ? 'ok' : 'FAIL'} - ${name}`);
  if (!cond) failed = 1;
}

check('C0 scripts/batch.js exists', fs.existsSync(SCRIPT));

// ---- helpers (inlined on purpose) --------------------------------------------------
function mk(d) { fs.mkdirSync(d, { recursive: true }); return d; }
function writeJson(p, o) { mk(path.dirname(p)); fs.writeFileSync(p, JSON.stringify(o, null, 2)); }
function tmpRoot(tag) { return mk(fs.mkdtempSync(path.join(os.tmpdir(), `accept-batch-${tag}-`))); }
function marker(root, stem, obj) { writeJson(path.join(root, 'batches', `${stem}.json`), obj); }
function mkMarker(runConfig, frozenAt, ids) {
  return { runConfig, frozenAt, issues: ids.map((id) => ({ id, title: `title for ${id}` })) };
}
// A run with a manifest: startedAt is its clock.
function manifestRun(root, id, startedAt, issueIds, prUrl) {
  writeJson(path.join(root, id, 'run.json'), {
    schema: 1,
    runId: id,
    startedAt,
    targetRepo: 'https://example.invalid/fixture/repo.git',
    tasks: issueIds.map((i) => ({ issueId: i, outcome: 'done', prUrl: prUrl || null })),
  });
  fs.writeFileSync(path.join(root, id, 'run.log'), `${startedAt} run start\n`);
}
// A run with NO manifest — 74 of 272 real run directories are this shape. Its only
// clock is the leading instant of run.log's first line.
function logOnlyRun(root, id, firstInstant, issueIds) {
  mk(path.join(root, id));
  fs.writeFileSync(path.join(root, id, 'run.log'),
    `${firstInstant} run start\n${firstInstant} workspace ready:\n`);
  for (const i of issueIds) {
    writeJson(path.join(root, id, 'tasks', i, 'status.json'), { issueId: i, attempts: [] });
  }
}
function runBatch(runsRoot, args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, BATCH_RUNS_DIR: runsRoot },
  });
}
function out(r) { return `${(r.stdout || '')}${(r.stderr || '')}`; }
// sha1 over every file under a directory, path and content — the purity snapshot.
function digest(dir) {
  const h = crypto.createHash('sha1');
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(d, e.name);
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) { h.update(`D:${r}\n`); walk(full, r); }
      else { h.update(`F:${r}\n`); h.update(fs.readFileSync(full)); }
    }
  };
  if (fs.existsSync(dir)) walk(dir, '');
  return h.digest('hex');
}
const RECONCILED = /\b(?:ready|not-ready|stray)\b/;

// ---- C1: the filename's date is anchored at the end -------------------------------
// The trap is the project segment. A split on the FIRST hyphen yields 'orbit' for
// 'orbit-lab-2026-08-19'; an unanchored *.json glob admits a file that is only a date.
{
  const t = tmpRoot('c1');
  marker(t, 'orbit-lab-2026-08-19',
    mkMarker('run.config.orbit-lab.json', '2026-08-19T10:00:00.000Z', ['ol-1']));
  marker(t, 'alpha-2026-08-01',
    mkMarker('run.config.alpha.json', '2026-08-01T10:00:00.000Z', ['al-1']));
  // No project segment: a date alone is not a marker name.
  marker(t, '2026-07-04', mkMarker('run.config.nope.json', '2026-07-04T00:00:00.000Z', ['nope-1']));
  fs.writeFileSync(path.join(t, 'batches', 'notes.txt'), 'not a marker\n');
  fs.writeFileSync(path.join(t, 'batches', 'broken-2026-08-02.json'), '{ truncated');

  const p = runBatch(t, ['pending']);
  const po = out(p);
  check('C1 pending exits 0', p.status === 0);
  check('C1 pending lists orbit-lab-2026-08-19', po.includes('orbit-lab-2026-08-19'));
  check('C1 pending lists alpha-2026-08-01', po.includes('alpha-2026-08-01'));
  check('C1 a date-only filename is not a marker (2026-07-04 absent)', !po.includes('2026-07-04'));
  check('C1 a date-only filename is not read at all (nope-1 absent)', !po.includes('nope-1'));
  check('C1 unparseable JSON is skipped, not crashed on',
    p.status === 0 && !po.includes('broken-2026-08-02'));

  const s = runBatch(t, ['show', 'orbit-lab-2026-08-19']);
  const so = out(s);
  check('C1 show exits 0', s.status === 0);
  check('C1 show reports project orbit-lab', /orbit-lab/.test(so));
  check('C1 show does NOT split the project on the first hyphen', !/orbit(?!-lab)/.test(so));
}

// ---- C2: a manifest-less run counts, and is dated from run.log --------------------
// The bug this exists for: a join copied from verdict.js reads run.json only, so a run
// that was interrupted before writing its manifest is invisible and its batch is
// reported as never launched.
{
  const FA = '2026-08-10T00:00:00.000Z';
  const FB = '2026-08-11T00:00:00.000Z';
  const FC = '2026-08-12T00:00:00.000Z';
  const build = (logInstant) => {
    const t = tmpRoot('c2');
    marker(t, 'aaa-2026-08-10', mkMarker('run.config.aaa.json', FA, ['aaa-1']));
    marker(t, 'bbb-2026-08-11', mkMarker('run.config.bbb.json', FB, ['bbb-1']));
    marker(t, 'ccc-2026-08-12', mkMarker('run.config.ccc.json', FC, ['ccc-1']));
    manifestRun(t, 'r1-manifest', '2026-08-15T00:00:00.000Z', ['aaa-1']);
    logOnlyRun(t, 'r2-nomanifest', logInstant, ['bbb-1']);
    return t;
  };

  const after = runBatch(build('2026-08-15T00:00:00.000Z'), ['pending']);
  const ao = out(after);
  check('C2 manifest-less run after the freeze removes its batch from pending',
    after.status === 0 && ao.includes('ccc-2026-08-12')
    && !ao.includes('bbb-2026-08-11') && !ao.includes('aaa-2026-08-10'));

  const before = runBatch(build('2026-08-01T00:00:00.000Z'), ['pending']);
  const bo = out(before);
  check('C2 manifest-less run BEFORE the freeze leaves its batch pending',
    before.status === 0 && bo.includes('ccc-2026-08-12') && bo.includes('bbb-2026-08-11')
    && !bo.includes('aaa-2026-08-10'));
}

// ---- C3: the instant comparison, ordering, and the degraded labels ----------------
{
  const T = '2026-08-10T12:00:00.000Z';
  const one = (runAt) => {
    const t = tmpRoot('c3');
    marker(t, 'edge-2026-08-10', mkMarker('run.config.edge.json', T, ['edge-1']));
    manifestRun(t, 'r-edge', runAt, ['edge-1']);
    return out(runBatch(t, ['pending']));
  };
  check('C3 a run 1ms BEFORE frozenAt leaves the batch pending',
    one('2026-08-10T11:59:59.999Z').includes('edge-2026-08-10'));
  check('C3 a run 1ms AFTER frozenAt takes the batch out of pending',
    !one('2026-08-10T12:00:00.001Z').includes('edge-2026-08-10'));

  const t = tmpRoot('c3lab');
  marker(t, 'undated-2026-08-03', {
    runConfig: 'run.config.undated.json', frozenAt: 'not-an-instant',
    issues: [{ id: 'un-1', title: 'x' }],
  });
  marker(t, 'empty-2026-08-04', mkMarker('run.config.empty.json', '2026-08-04T00:00:00.000Z', []));
  const lab = out(runBatch(t, ['pending']));
  check('C3 an unparseable frozenAt is listed, not dropped, and labelled freeze-time-unknown',
    lab.includes('undated-2026-08-03') && lab.includes('freeze-time-unknown'));
  check('C3 a marker with no issue ids is listed and labelled no-issues',
    lab.includes('empty-2026-08-04') && lab.includes('no-issues'));

  // Ordering: newest frozenAt first; the middle pair SHARES an instant, so only an
  // ascending filename tie-break puts mmm before zzz.
  const o = tmpRoot('c3ord');
  const TIE = '2026-08-06T00:00:00.000Z';
  marker(o, 'newest-2026-08-09', mkMarker('run.config.a.json', '2026-08-09T00:00:00.000Z', ['n-1']));
  marker(o, 'zzz-2026-08-06', mkMarker('run.config.b.json', TIE, ['z-1']));
  marker(o, 'mmm-2026-08-06', mkMarker('run.config.c.json', TIE, ['m-1']));
  marker(o, 'oldest-2026-08-02', mkMarker('run.config.d.json', '2026-08-02T00:00:00.000Z', ['o-1']));
  const r1 = runBatch(o, ['pending']);
  const t1 = r1.stdout || '';
  const at = (s) => t1.indexOf(s);
  check('C3 pending orders newest frozenAt first, ties by filename ascending',
    r1.status === 0
    && at('newest-2026-08-09') >= 0 && at('mmm-2026-08-06') >= 0
    && at('zzz-2026-08-06') >= 0 && at('oldest-2026-08-02') >= 0
    && at('newest-2026-08-09') < at('mmm-2026-08-06')
    && at('mmm-2026-08-06') < at('zzz-2026-08-06')
    && at('zzz-2026-08-06') < at('oldest-2026-08-02'));
  const r2 = runBatch(o, ['pending']);
  check('C3 two invocations over an unchanged fixture produce byte-identical stdout',
    (r2.stdout || '') === t1 && t1.length > 0);
}

// ---- C4: show's default, the per-id breakdown, and the exit-code contract ---------
{
  const t = tmpRoot('c4');
  marker(t, 'older-2026-08-01', mkMarker('run.config.older.json', '2026-08-01T00:00:00.000Z', ['old-1']));
  marker(t, 'newer-2026-08-05', mkMarker('run.config.newer.json', '2026-08-05T00:00:00.000Z', ['new-1']));
  manifestRun(t, 'r-launched', '2026-08-06T00:00:00.000Z', ['new-1']);

  const d = runBatch(t, ['show']);
  const doo = out(d);
  check('C4 show with no argument names the newest marker even though it was launched',
    d.status === 0 && doo.includes('newer-2026-08-05') && !doo.includes('older-2026-08-01'));
  const newLine = doo.split(/\r?\n/).find((l) => l.includes('new-1')) || '';
  check('C4 the per-id breakdown marks a worked id `worked`',
    /\bworked\b/.test(newLine) && !/\bnot-worked\b/.test(newLine));

  const oldShow = `${runBatch(t, ['show', 'older-2026-08-01']).stdout || ''}`;
  const oldLine = oldShow.split(/\r?\n/).find((l) => l.includes('old-1')) || '';
  check('C4 the per-id breakdown marks an unworked id `not-worked`', /\bnot-worked\b/.test(oldLine));

  check('C4 this task never speaks the reconciled vocabulary', !RECONCILED.test(doo));
  check('C4 this task always reports unreconciled bd-unavailable',
    doo.includes('unreconciled') && doo.includes('bd-unavailable'));

  const nf = runBatch(t, ['show', 'nosuch-2026-01-01']);
  check('C4 a well-formed stem naming no marker exits 3', nf.status === 3);
  check('C4 a no-match prints no reconciled token', !RECONCILED.test(out(nf)));
  const usage = runBatch(t, ['show', '--wat']);
  check('C4 an unusable argument exits 2', usage.status === 2);
  check('C4 a usage error prints no reconciled token', !RECONCILED.test(out(usage)));
}

// ---- C5 [guard]: pure reader, self-contained, and it invents no run ---------------
{
  const t = tmpRoot('c5');
  // A real-looking corpus so the three readers have something to say — a comparison of
  // two empty outputs would pass vacuously.
  manifestRun(t, 'r-pr', '2026-08-07T00:00:00.000Z', ['pr-1'], 'https://example.invalid/pr/1');
  manifestRun(t, 'r-nopr', '2026-08-08T00:00:00.000Z', ['np-1']);

  const verdictOf = () => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'verdict.js'), 'pending'],
    { encoding: 'utf8', env: { ...process.env, VERDICT_RUNS_DIR: t } });
  const auditOf = () => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'audit-runs.js')],
    { encoding: 'utf8', env: { ...process.env, AUDIT_RUNS_DIR: t } });
  // audit-runs buckets any unrecognised directory as `other`, so `batches/` legitimately
  // moves its Corpus accounting — `total entries`, `other entries`, and the Other-entries
  // list. What must NOT move is how many RUNS it sees and everything it says about them,
  // which is the whole of the report from `## Runs` onward. Comparing more than that
  // would fail a correct implementation, which is the broken-gate shape this repo has
  // already paid for once.
  const auditRunCount = (r) => ((r.stdout || '').match(/^- real runs:.*$/m) || [''])[0];
  const auditRunBody = (r) => {
    const s = r.stdout || '';
    const i = s.indexOf('## Runs');
    return i < 0 ? '' : s.slice(i);
  };

  const vBefore = verdictOf();
  const aBeforeRaw = auditOf();
  const aBeforeCount = auditRunCount(aBeforeRaw);
  const aBeforeBody = auditRunBody(aBeforeRaw);
  let dashBefore = null;
  let buildState = null;
  try { ({ buildState } = require(path.join(ROOT, 'scripts', 'dashboard.js'))); } catch (e) { buildState = null; }
  check('C5 scripts/dashboard.js still exports buildState (the criterion rests on it)',
    typeof buildState === 'function');
  if (typeof buildState === 'function') dashBefore = JSON.stringify(buildState(t).projects);

  // Now plant markers in the same root.
  marker(t, 'guard-2026-08-09', mkMarker('run.config.guard.json', '2026-08-09T00:00:00.000Z', ['g-1']));
  marker(t, 'guard2-2026-08-10', mkMarker('run.config.guard2.json', '2026-08-10T00:00:00.000Z', ['g-2']));

  check('C5(iii) verdict.js pending is byte-identical with a populated batches/',
    (verdictOf().stdout || '') === (vBefore.stdout || ''));
  const aAfterRaw = auditOf();
  check('C5(iii) audit-runs.js counts the same real runs with a populated batches/',
    auditRunCount(aAfterRaw) === aBeforeCount && /real runs: [1-9]/.test(aBeforeCount));
  check('C5(iii) audit-runs.js says the same things about those runs',
    auditRunBody(aAfterRaw) === aBeforeBody && aBeforeBody.length > 0);
  if (typeof buildState === 'function') {
    check('C5(iii) dashboard buildState().projects is unchanged by a populated batches/',
      JSON.stringify(buildState(t).projects) === dashBefore);
  }

  const before = digest(t);
  runBatch(t, ['pending']);
  runBatch(t, ['show']);
  runBatch(t, ['show', 'guard-2026-08-09']);
  check('C5(i) the runs root is byte-identical after show and pending — nothing is written',
    digest(t) === before);

  const src = fs.existsSync(SCRIPT) ? fs.readFileSync(SCRIPT, 'utf8') : '';
  const requires = [...src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
  const BUILTINS = ['fs', 'path', 'os', 'url', 'util', 'crypto'];
  check('C5(ii) batch.js requires node built-ins only (a copy must work from any repo-shaped root)',
    requires.length > 0 && requires.every((r) => BUILTINS.includes(r)));
  check('C5(ii) batch.js requires no child_process: this task spawns nothing at all',
    !requires.includes('child_process'));
  check('C5(ii) batch.js reads its runs root from the seam or its own location, never the cwd',
    src.length > 0 && !/process\.cwd\(\)/.test(src));
}

console.log(failed ? 'ACCEPTANCE FAILED' : 'ACCEPTANCE PASSED');
process.exit(failed);
