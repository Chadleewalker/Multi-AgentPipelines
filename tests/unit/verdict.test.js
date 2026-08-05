#!/usr/bin/env node
// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// Unit suite for the review verdict recorder — scripts/verdict.js, DESIGN.md §5
// (change-log row `review-verdict`). Re-runnable: the sweep picks it up through
// scripts/test-verdict.sh. Its job is the half of tests/acceptance/repo-1ie/ that has to
// outlive that task — a frozen acceptance directory is an artifact of a finished run and
// is never executed again, while this contract keeps holding every time a reviewer types
// the command.
//
// Plain Node, no test framework, no Docker, no network, no `bd`: run it as
// `node tests/unit/verdict.test.js` from anywhere. One line per check — `ok - <label>` /
// `FAIL - <label>` — and a non-zero exit if any check failed. Fixtures are throwaway
// directories under the OS temp dir; all ids and URLs are invented, and no timestamp is
// hardcoded (they are computed from the clock at run time, so the suite cannot rot into
// a fixture whose dates stopped meaning what they meant).
//
// WHERE THIS GOES BEYOND THE FROZEN SUITE, on purpose:
//
//   * The frozen fixture's non-PR-bearing rows are `prUrl: null` and an absent key. The
//     other three shapes a manifest can carry — `""`, whitespace, and a non-string — are
//     exercised here, because "truthy non-empty string" is the rule and only one third of
//     it was pinned.
//   * A MISSING runs root. The frozen suite always builds one; the reviewer's first ever
//     run of `pending` is against a machine that has never run the pipeline, and a
//     recorder that throws ENOENT there fails the one person it exists for.
//   * The hard-rule-5 property is asserted at the level it is stated: after a successful
//     record, every pre-existing file in the tree — including `run.json`, including in
//     OTHER runs — is byte-identical, and a pre-existing sibling artifact in the same
//     `tasks/<id>/` directory survives.
//   * Self-containment is checked STRUCTURALLY, not trusted: the source is scanned for
//     requires of anything that is not a node built-in, and for `child_process`. That
//     constraint is what makes the default-root proof legitimate (a copy of the file must
//     work from any repo-shaped root) and what keeps the tool usable on a host with no
//     `bd` — and it is exactly the kind of constraint that decays silently the first time
//     someone reaches for a shared helper.
//   * Ordering is checked for DETERMINISM as well as correctness: two runs sharing one
//     `startedAt` must resolve the same way on every call, or the recorder writes into a
//     different run depending on readdir order.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'verdict.js');

// The suite owns its fixtures: a seam inherited from the shell would let the caller's
// environment decide the result.
delete process.env.VERDICT_RUNS_DIR;

const verdictjs = require(SCRIPT);

let failed = 0;
function check(name, cond) {
  console.log(`${cond ? 'ok' : 'FAIL'} - ${name}`);
  if (!cond) failed = 1;
  return !!cond;
}

const NOW = Date.now();
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();
const temps = [];
function mktemp(tag) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `unit-verdict-${tag}-`));
  temps.push(d);
  return d;
}
function writeRun(root, runId, manifest) {
  const dir = path.join(root, runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'run.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return dir;
}
function cli(root, args, opts = {}) {
  const env = { ...process.env, ...(opts.env || {}) };
  if (root === null) delete env.VERDICT_RUNS_DIR; else env.VERDICT_RUNS_DIR = root;
  return spawnSync(process.execPath, [opts.script || SCRIPT, ...args],
    { encoding: 'utf8', env, cwd: opts.cwd || ROOT, timeout: 60000 });
}
function snapshot(root) {
  const map = new Map();
  (function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else map.set(path.relative(root, p), crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex'));
    }
  })(root);
  return map;
}
function identical(before, after) {
  if (before.size !== after.size) return false;
  for (const [p, h] of before) if (after.get(p) !== h) return false;
  return true;
}
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const hasPair = (out, runId, issueId) =>
  String(out).split(/\r?\n/).findIndex((l) => l.includes(runId) && l.includes(issueId));

// ---- A. reading a real-shaped runs tree ---------------------------------------------
// Everything a runs root actually contains besides runs, plus two JSON documents that
// parse but are not manifests. None of it may throw, and none of it may become a run.
{
  const root = path.join(mktemp('read'), 'runs');
  fs.mkdirSync(root, { recursive: true });
  writeRun(root, 'r-dated', { runId: 'r-dated', startedAt: iso(1000), tasks: [] });
  fs.mkdirSync(path.join(root, 'sweeps', '20260101-000000'), { recursive: true });
  fs.mkdirSync(path.join(root, 'locks'), { recursive: true });
  fs.mkdirSync(path.join(root, 'half-run'), { recursive: true });
  fs.writeFileSync(path.join(root, 'half-run', 'run.json'), '{ truncated');
  fs.mkdirSync(path.join(root, 'array-run'), { recursive: true });
  fs.writeFileSync(path.join(root, 'array-run', 'run.json'), '[1,2,3]');
  fs.mkdirSync(path.join(root, 'string-run'), { recursive: true });
  fs.writeFileSync(path.join(root, 'string-run', 'run.json'), '"a run, honest"');
  fs.writeFileSync(path.join(root, 'live-2026.log'), 'not a directory\n');

  let runs = null;
  let threw = false;
  try { runs = verdictjs.readRuns(root); } catch { threw = true; }
  check('A1 a root full of non-run entries does not throw', !threw);
  check('A2 only the real run directory is read as a run',
    !!runs && runs.length === 1 && runs[0].runId === 'r-dated');

  let missing = null;
  threw = false;
  try { missing = verdictjs.readRuns(path.join(root, 'nope', 'never')); } catch { threw = true; }
  check('A3 a missing runs root reads as empty rather than throwing',
    !threw && Array.isArray(missing) && missing.length === 0);
}

// ---- B. recency ordering ------------------------------------------------------------
// The schema (schemas/run.schema.json) says startedAt is a date-time STRING, which is the
// independent witness that string-only parsing is right rather than merely convenient: a
// number, a non-date and an absent key all mean "this manifest does not say when", and
// all three must sort oldest rather than sorting wrong or throwing.
{
  const root = path.join(mktemp('order'), 'runs');
  fs.mkdirSync(root, { recursive: true });
  writeRun(root, 'z-newest', { runId: 'z-newest', startedAt: iso(60 * 1000), tasks: [] });
  writeRun(root, 'a-middle', { runId: 'a-middle', startedAt: iso(60 * 60 * 1000), tasks: [] });
  writeRun(root, 'm-oldest', { runId: 'm-oldest', startedAt: iso(48 * 60 * 60 * 1000), tasks: [] });
  writeRun(root, 'no-date', { runId: 'no-date', tasks: [] });
  writeRun(root, 'garbled-date', { runId: 'garbled-date', startedAt: 'the other day', tasks: [] });
  writeRun(root, 'epoch-date', { runId: 'epoch-date', startedAt: NOW, tasks: [] });
  // Same instant, two runs: the tie-break decides, and must decide identically forever.
  const tieAt = iso(30 * 60 * 1000);
  writeRun(root, 'tie-b', { runId: 'tie-b', startedAt: tieAt, tasks: [] });
  writeRun(root, 'tie-a', { runId: 'tie-a', startedAt: tieAt, tasks: [] });

  const order = verdictjs.readRuns(root).map((r) => r.runId);
  check('B1 dated runs come newest-first',
    order.indexOf('z-newest') < order.indexOf('a-middle')
    && order.indexOf('a-middle') < order.indexOf('m-oldest'));
  const undated = ['no-date', 'garbled-date', 'epoch-date'];
  check('B2 absent, unparseable and non-string startedAt all sort after every dated run',
    undated.every((u) => order.indexOf(u) > order.indexOf('m-oldest')));
  check('B3 a tie on startedAt breaks by runId ascending',
    order.indexOf('tie-a') < order.indexOf('tie-b'));
  const again = verdictjs.readRuns(root).map((r) => r.runId);
  check('B4 the order is identical on a second read (no readdir-order dependency)',
    order.join(',') === again.join(','));
  const fallback = verdictjs.readRuns(root).find((r) => r.dirName === 'z-newest');
  check('B5 every run carries both its directory name and its manifest runId',
    !!fallback && fallback.dirName === 'z-newest' && fallback.runId === 'z-newest');
}

// ---- C. what counts as PR-bearing ---------------------------------------------------
{
  check('C1 a truthy string prUrl is a PR',
    verdictjs.prUrlOf({ prUrl: 'https://example.invalid/pr/1' }) === 'https://example.invalid/pr/1');
  check('C2 null, absent, empty and whitespace prUrl are not PRs',
    verdictjs.prUrlOf({ prUrl: null }) === null
    && verdictjs.prUrlOf({}) === null
    && verdictjs.prUrlOf({ prUrl: '' }) === null
    && verdictjs.prUrlOf({ prUrl: '   ' }) === null);
  check('C3 a non-string prUrl is not a PR',
    verdictjs.prUrlOf({ prUrl: 7 }) === null && verdictjs.prUrlOf({ prUrl: { url: 'x' } }) === null);
}

// ---- D. the main fixture: record, overwrite, and what it must not touch --------------
const MAIN = path.join(mktemp('main'), 'runs');
const PR_NEW = 'https://example.invalid/pr/11';
{
  fs.mkdirSync(MAIN, { recursive: true });
  const newDir = writeRun(MAIN, 'run-new', {
    runId: 'run-new', startedAt: iso(2 * 60 * 1000),
    tasks: [
      { issueId: 'app-100', outcome: 'done', prUrl: PR_NEW },
      { issueId: 'app-blank', outcome: 'done', prUrl: '   ' },
      { issueId: 'app-num', outcome: 'done', prUrl: 42 },
      { issueId: 'app-listy', outcome: 'stuck', prUrl: [] },
      'not a task row',
      { outcome: 'done', prUrl: 'https://example.invalid/pr/12' },
    ],
  });
  writeRun(MAIN, 'run-older', {
    runId: 'run-older', startedAt: iso(72 * 60 * 60 * 1000),
    tasks: [{ issueId: 'app-100', outcome: 'done', prUrl: 'https://example.invalid/pr/4' }],
  });
  writeRun(MAIN, 'run-tasksless', { runId: 'run-tasksless', startedAt: iso(60 * 1000), tasks: 'nope' });
  // A pre-existing sibling artifact in the very directory record writes into.
  fs.mkdirSync(path.join(newDir, 'tasks', 'app-100'), { recursive: true });
  fs.writeFileSync(path.join(newDir, 'tasks', 'app-100', 'status.json'), '{"outcome":"done"}\n');

  const before = snapshot(MAIN);
  const rec = cli(MAIN, ['record', 'app-100', 'merged', 'reviewed and merged']);
  check('D1 record exits 0 against the newest run carrying the issue', rec.status === 0);
  const vPath = path.join(MAIN, 'run-new', 'tasks', 'app-100', 'verdict.json');
  const v = readJson(vPath);
  check('D2 the verdict is valid JSON with every field recorded exactly',
    !!v && v.issueId === 'app-100' && v.runId === 'run-new'
    && v.verdict === 'merged' && v.reason === 'reviewed and merged' && v.prUrl === PR_NEW);
  check('D3 recordedAt is an ISO string at or after the moment the suite started',
    !!v && typeof v.recordedAt === 'string' && Date.parse(v.recordedAt) >= NOW - 2000);
  check('D4 the file ends with a newline (it is read by humans and by `cat`)',
    fs.readFileSync(vPath, 'utf8').endsWith('}\n'));
  check('D5 the older run carrying the same issue gained nothing',
    !fs.existsSync(path.join(MAIN, 'run-older', 'tasks', 'app-100', 'verdict.json')));

  const after = snapshot(MAIN);
  const added = [...after.keys()].filter((p) => !before.has(p));
  const changed = [...before.keys()].filter((p) => after.get(p) !== before.get(p));
  check('D6 exactly one file appeared and it is the verdict', added.length === 1);
  check('D7 no pre-existing byte changed anywhere in the runs tree — run.json included '
    + '(hard rule 5: evidence, never a gate)', changed.length === 0);
  check('D8 the sibling artifact in the same tasks/<id>/ directory survived',
    fs.readFileSync(path.join(MAIN, 'run-new', 'tasks', 'app-100', 'status.json'), 'utf8')
      .includes('"outcome":"done"'));

  // Overwrite in place, with a fresh recordedAt.
  const first = readJson(vPath);
  const rec2 = cli(MAIN, ['record', 'app-100', 'rejected', 'second look: sent back']);
  const second = readJson(vPath);
  const entries = fs.readdirSync(path.join(MAIN, 'run-new', 'tasks', 'app-100')).sort();
  check('D9 re-recording overwrites in place: one verdict.json, the later word wins',
    rec2.status === 0 && entries.join(',') === 'status.json,verdict.json'
    && !!second && second.verdict === 'rejected' && second.reason === 'second look: sent back');
  check('D10 recordedAt is re-stamped rather than hardcoded',
    !!first && !!second && Date.parse(second.recordedAt) >= Date.parse(first.recordedAt));

  // --run overrides recency and reaches the older run.
  const recOld = cli(MAIN, ['record', 'app-100', 'merged', 'the older PR was fine', '--run', 'run-older']);
  const vOld = readJson(path.join(MAIN, 'run-older', 'tasks', 'app-100', 'verdict.json'));
  check('D11 --run overrides recency and creates tasks/<id>/ in the named run',
    recOld.status === 0 && !!vOld && vOld.runId === 'run-older' && vOld.verdict === 'merged');
}

// ---- E. refusals: every one of them writes nothing -----------------------------------
{
  const before = snapshot(MAIN);
  const cases = [
    ['a verdict word outside the vocabulary', ['record', 'app-100', 'approved', 'why']],
    ['a capitalised verdict word (the vocabulary is exact)', ['record', 'app-100', 'Merged', 'why']],
    ['a whitespace-only reason', ['record', 'app-100', 'merged', '  \t ']],
    ['a missing reason', ['record', 'app-100', 'merged']],
    ['a missing verdict word', ['record', 'app-100']],
    ['no issue id at all', ['record']],
    ['an issue id in no run.json', ['record', 'app-999', 'merged', 'ghost']],
    ['--run naming a run that does not exist', ['record', 'app-100', 'merged', 'why', '--run', 'run-ghost']],
    ['--run naming a run without the issue', ['record', 'app-100', 'merged', 'why', '--run', 'run-tasksless']],
    ['--run with no runId after it', ['record', 'app-100', 'merged', 'why', '--run']],
    ['an unknown option', ['record', 'app-100', 'merged', 'why', '--force']],
    ['an unquoted reason arriving as extra positionals', ['record', 'app-100', 'merged', 'sent', 'back']],
    ['an issue id carrying a path separator', ['record', '../escape', 'merged', 'why']],
    ['an unknown mode', ['verdict-please', 'app-100']],
    ['no mode at all', []],
    ['pending with an unexpected argument', ['pending', 'app-100']],
  ];
  let allRefused = true;
  let allSilent = true;
  for (const [label, argv] of cases) {
    const r = cli(MAIN, argv);
    if (r.status === 0 || r.status === null) { allRefused = false; console.log(`   (not refused: ${label})`); }
    if (!identical(before, snapshot(MAIN))) { allSilent = false; console.log(`   (wrote something: ${label})`); }
  }
  check(`E1 all ${cases.length} usage errors exit non-zero`, allRefused);
  check('E2 every refusal left the runs tree byte-identical (validate before any write)', allSilent);
  check('E3 the path-separator issue id escaped nothing: no verdict.json outside a run',
    !fs.existsSync(path.join(MAIN, '..', 'escape')));
}

// ---- F. pending: a report, never a gate ----------------------------------------------
{
  const pend = cli(MAIN, ['pending']);
  check('F1 pending exits 0', pend.status === 0);
  check('F2 the verdicted pairs are gone from the list',
    hasPair(pend.stdout, 'run-new', 'app-100') === -1
    && hasPair(pend.stdout, 'run-older', 'app-100') === -1);
  check('F3 blank, numeric and array prUrl rows are not PR-bearing',
    hasPair(pend.stdout, 'run-new', 'app-blank') === -1
    && hasPair(pend.stdout, 'run-new', 'app-num') === -1
    && hasPair(pend.stdout, 'run-new', 'app-listy') === -1);

  // A fresh root proves the listing itself, ordering included.
  const root = path.join(mktemp('pending'), 'runs');
  fs.mkdirSync(root, { recursive: true });
  writeRun(root, 'p-old', {
    runId: 'p-old', startedAt: iso(24 * 60 * 60 * 1000),
    tasks: [{ issueId: 'app-200', outcome: 'done', prUrl: 'https://example.invalid/pr/20' }],
  });
  writeRun(root, 'p-new', {
    runId: 'p-new', startedAt: iso(5 * 60 * 1000),
    tasks: [{ issueId: 'app-201', outcome: 'done', prUrl: 'https://example.invalid/pr/21' }],
  });
  writeRun(root, 'p-undated', {
    runId: 'p-undated',
    tasks: [{ issueId: 'app-202', outcome: 'done', prUrl: 'https://example.invalid/pr/22' }],
  });
  const listed = cli(root, ['pending']);
  const iNew = hasPair(listed.stdout, 'p-new', 'app-201');
  const iOld = hasPair(listed.stdout, 'p-old', 'app-200');
  const iUnd = hasPair(listed.stdout, 'p-undated', 'app-202');
  check('F4 every PR-bearing unverdicted pair is listed, runId and issueId on one line',
    iNew >= 0 && iOld >= 0 && iUnd >= 0);
  check('F5 newest run first, undated last', iNew < iOld && iOld < iUnd);
  check('F6 the line carries the PR url, so the reviewer can open it from the report',
    String(listed.stdout).split(/\r?\n/)[iNew].includes('https://example.invalid/pr/21'));

  const empty = path.join(mktemp('empty'), 'runs');
  fs.mkdirSync(empty, { recursive: true });
  const pendEmpty = cli(empty, ['pending']);
  check('F7 pending on an empty runs root exits 0 with no findings', pendEmpty.status === 0);

  const gone = path.join(mktemp('gone'), 'never-ran');
  const pendGone = cli(gone, ['pending']);
  check('F8 pending on a runs root that does not exist exits 0 (a machine that has never '
    + 'run the pipeline is not an error)', pendGone.status === 0);
  const recGone = cli(gone, ['record', 'app-100', 'merged', 'why']);
  check('F9 record against a missing runs root fails as an unknown issue and creates nothing',
    recGone.status !== 0 && recGone.status !== null && !fs.existsSync(gone));
}

// ---- G. self-containment, checked rather than trusted ---------------------------------
// The default-root proof rests on a COPY of this file working from any repo-shaped root,
// and the no-`bd` constraint rests on it spawning nothing. Both decay silently the first
// time someone reaches for a shared helper, and neither shows up in any behavioural test.
{
  const src = fs.readFileSync(SCRIPT, 'utf8');
  const requires = [...src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
  const BUILTINS = ['fs', 'path', 'os', 'url', 'util', 'crypto'];
  check('G1 scripts/verdict.js requires node built-ins only (a copy of it must work from '
    + 'any repo-shaped root)', requires.length > 0 && requires.every((r) => BUILTINS.includes(r)));
  check('G2 it requires no child_process: no `bd`, no shelling out, no LLM (hard rules 1 and 7)',
    !requires.includes('child_process'));
  check('G3 it reads its runs root from the seam or its own location, never the cwd',
    !/process\.cwd\(\)/.test(src));

  // The frozen suite proves the default root through a copy; prove the computation too,
  // so a regression is named rather than merely observed.
  const resolved = verdictjs.runsRoot({});
  check('G4 with the seam unset the root is <script dir>/../runs',
    resolved === path.join(ROOT, 'runs'));
  check('G5 a blank seam is treated as unset, not as the empty path',
    verdictjs.runsRoot({ VERDICT_RUNS_DIR: '   ' }) === path.join(ROOT, 'runs'));
  const aimed = mktemp('seam');
  check('G6 the seam re-aims the root', verdictjs.runsRoot({ VERDICT_RUNS_DIR: aimed }) === path.resolve(aimed));
}

for (const t of temps) fs.rmSync(t, { recursive: true, force: true, maxRetries: 5 });
process.exit(failed);
