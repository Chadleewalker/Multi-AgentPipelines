#!/usr/bin/env node
// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// Unit suite for the batch marker reader — scripts/batch.js, DESIGN.md §3.9 (change-log
// row `batch-ready-marker`). Re-runnable: the sweep picks it up through
// scripts/test-batch.sh. Its job is the half of tests/acceptance/repo-0b3/ that has to
// outlive that task — a frozen acceptance directory is an artifact of a finished run and
// is never executed again, while this contract keeps holding every time a launching
// session types the command.
//
// Plain Node, no test framework, no Docker, no network, no `bd`: run it as
// `node tests/unit/batch.test.js` from anywhere. One line per check — `ok - <label>` /
// `FAIL - <label>` — and a non-zero exit if any check failed. Fixtures are throwaway
// directories under the OS temp dir, and every project name and issue id is invented
// (scripts/test-sanitize.sh reads bytes).
//
// WHERE THIS GOES BEYOND THE FROZEN SUITE, on purpose:
//
//   * The DEFAULT runs root is computed, not merely proven through the seam. The frozen
//     suite always exports `BATCH_RUNS_DIR`, so a reader that silently resolved its root
//     from the working directory would pass every behavioural check it runs.
//   * A MISSING runs root and a runs root with no `batches/` at all. The first time anyone
//     types this command it is against a host that has never planned a batch, and a reader
//     that throws ENOENT there fails the one person it exists for.
//   * The skip list is exercised at every shape a real `batches/` grows: a subdirectory, a
//     JSON array, a JSON scalar, a marker name whose date is malformed or unanchored, and
//     `.json` in the middle of a name. The frozen suite pins two of these.
//   * `run-time-unknown` is asserted as a LABEL, not just as a join. It is the only term in
//     §3.9's degraded vocabulary that the frozen suite never makes visible, and the whole
//     point of the conservative direction is that a human is told which way it went.
//   * The three id CHANNELS a run names are separated. A run's ids come from its manifest,
//     its `tasks/` directories AND its log's trace ids; the frozen suite covers the first
//     two together, so a reader that dropped the third would stay green while going blind
//     to a run killed before it wrote either.
//   * PENDING MEANS NONE is checked from the other side: a half-drained batch — one id
//     worked, three not — must LEAVE the list, which is the behaviour §3.9 chose
//     deliberately and the one a "some ids outstanding" reading would invert.
//   * Purity is asserted over the whole tree after EVERY subcommand including the failing
//     ones, and self-containment is checked structurally rather than trusted.
//   * THE BOUND ON THE `bd` CALL IS ACTUALLY FIRED, against a stub that really does hang.
//     A stub that merely fails to exit is not enough on its own: node kills it anyway when
//     it cannot resolve the main module, so the fixture passes without the bound existing.
//     Section G's hang stub swallows that error and keeps a timer alive, which is the only
//     shape that can tell a bound apart from a coincidence.
//
// THE STUB GUARD, and why every stub in section G opens with it. The repo's EFTYPE-safe bd
// stub recipe is `PIPELINE_BD_CMD=process.execPath` plus `NODE_OPTIONS=--require <stub.js>`
// (repo-dhp-note-1). That works unchanged where the code under test runs IN-PROCESS and only
// `bd` is spawned — tests/unit/memory.test.js — but scripts/batch.js is itself spawned as a
// child here, and NODE_OPTIONS reaches it too. An unguarded stub therefore preloads into the
// tool under test, and the moment its body calls process.exit it kills the reader before its
// first line: stdout becomes the stub's own answer and the fixture measures nothing. The
// guard is one line — stand aside unless this process IS the bd child — and the tell that it
// is missing is an argv log holding ONE line where a live run logs two.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'batch.js');

// The suite owns its fixtures: a seam inherited from the shell would let the caller's
// environment decide the result — and, worse, aim a reader at the host's real runs root, or
// let a stray PIPELINE_BD_CMD decide what the live queue answers.
delete process.env.BATCH_RUNS_DIR;
delete process.env.BATCH_CONFIG_DIR;
delete process.env.PIPELINE_BD_CMD;
delete process.env.PIPELINE_IMAGE_BD_CMD;

const batchjs = require(SCRIPT);

let failed = 0;
function check(name, cond) {
  console.log(`${cond ? 'ok' : 'FAIL'} - ${name}`);
  if (!cond) failed = 1;
}

const temps = [];
function mktemp(tag) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `batch-unit-${tag}-`));
  temps.push(d);
  return d;
}

// ---- fixture builders -------------------------------------------------------------------
function mk(d) { fs.mkdirSync(d, { recursive: true }); return d; }
function writeJson(p, o) { mk(path.dirname(p)); fs.writeFileSync(p, JSON.stringify(o, null, 2)); }
function marker(root, stem, obj) { writeJson(path.join(root, 'batches', `${stem}.json`), obj); }
function mkMarker(project, frozenAt, ids, extra) {
  return Object.assign({
    runConfig: `run.config.${project}.json`,
    frozenAt,
    issues: ids.map((id) => ({ id, title: `title for ${id}` })),
  }, extra || {});
}
function manifestRun(root, id, startedAt, issueIds) {
  writeJson(path.join(root, id, 'run.json'), {
    schema: 1,
    runId: id,
    startedAt,
    targetRepo: 'https://example.invalid/fixture/repo.git',
    tasks: issueIds.map((i) => ({ issueId: i, outcome: 'done', prUrl: null })),
  });
  fs.writeFileSync(path.join(root, id, 'run.log'), `${startedAt} INFO [${id}/preflight] run start\n`);
}
// A run with no manifest at all — a quarter of the real corpus. Its only clock is the
// leading instant of run.log's first line.
function logOnlyRun(root, id, firstInstant, issueIds) {
  mk(path.join(root, id));
  fs.writeFileSync(path.join(root, id, 'run.log'), `${firstInstant} INFO [${id}/preflight] run start\n`);
  for (const i of issueIds) writeJson(path.join(root, id, 'tasks', i, 'status.json'), { issueId: i });
}

// An empty config directory, so that sections A–F never resolve a run config and therefore
// never spawn anything: the reconciliation is section G's subject, and a suite whose other
// checks quietly consulted the host's real `bd` would answer differently on every machine.
const NO_CONFIGS = mktemp('noconfigs');

function cli(runsRoot, args, env) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: Object.assign({}, process.env,
      { BATCH_RUNS_DIR: runsRoot, BATCH_CONFIG_DIR: NO_CONFIGS }, env || {}),
  });
}
function fwd(p) { return p.replace(/\\/g, '/'); }   // NODE_OPTIONS eats backslashes
const both = (r) => `${r.stdout || ''}${r.stderr || ''}`;

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

// The vocabulary the FOLLOWING task owns. Nothing here may speak it, and the check is
// cheap enough to run over every output this suite produces.
const RECONCILED = /\b(?:ready|not-ready|stray)\b/;
const outputs = [];
function record(r) { outputs.push(both(r)); return r; }

// ---- A. the runs root ---------------------------------------------------------------------
// The seam is how every other check reaches a fixture, which means nothing else in this file
// can see a reader that resolved its root from the working directory instead.
{
  check('A1 with the seam unset the root is <script dir>/../runs',
    batchjs.runsRoot({}) === path.join(ROOT, 'runs'));
  check('A2 a blank seam is treated as unset, not as the empty path',
    batchjs.runsRoot({ BATCH_RUNS_DIR: '   ' }) === path.join(ROOT, 'runs'));
  const aimed = mktemp('seam');
  check('A3 the seam re-aims the root',
    batchjs.runsRoot({ BATCH_RUNS_DIR: aimed }) === path.resolve(aimed));

  // A host that has never planned a batch, and one that has never run the pipeline.
  const empty = mktemp('empty');
  const p1 = record(cli(empty, ['pending']));
  check('A4 a runs root with no batches/ reports nothing and exits 0', p1.status === 0);
  const gone = path.join(mktemp('gone'), 'never-existed');
  const p2 = record(cli(gone, ['pending']));
  check('A5 a runs root that does not exist reports nothing and exits 0', p2.status === 0);
  check('A6 pending on a missing root creates nothing', !fs.existsSync(gone));
  const s1 = record(cli(empty, ['show']));
  check('A7 show with nothing to show exits 3, not 0 and not a crash', s1.status === 3);
}

// ---- B. what is and is not a marker ---------------------------------------------------------
// Everything here lands in a real batches/ directory sooner or later: an editor's leavings, a
// half-written file, a name typed by hand. None of it may crash the reader, and none of it may
// be NAMED in the output either — a skipped file reported as a batch is the failure mode.
{
  const t = mktemp('skip');
  marker(t, 'good-2026-08-19', mkMarker('good', '2026-08-19T00:00:00.000Z', ['g-1']));
  fs.writeFileSync(path.join(t, 'batches', 'plain-2026-08-01.txt'), 'not json\n');
  fs.writeFileSync(path.join(t, 'batches', 'truncated-2026-08-02.json'), '{ "runConfig":');
  fs.writeFileSync(path.join(t, 'batches', 'arrayish-2026-08-03.json'), '[{"runConfig":"x"}]');
  fs.writeFileSync(path.join(t, 'batches', 'scalar-2026-08-04.json'), '"just a string"');
  marker(t, '2026-08-05', mkMarker('dateonly', '2026-08-05T00:00:00.000Z', ['d-1']));
  marker(t, 'baddate-2026-8-6', mkMarker('baddate', '2026-08-06T00:00:00.000Z', ['b-1']));
  marker(t, 'trailing-2026-08-07-x', mkMarker('trailing', '2026-08-07T00:00:00.000Z', ['t-1']));
  marker(t, 'midname-2026-08-08.json.bak', mkMarker('midname', '2026-08-08T00:00:00.000Z', ['x-1']));
  mk(path.join(t, 'batches', 'subdir-2026-08-09.json')); // a DIRECTORY with a marker's name

  const r = record(cli(t, ['pending']));
  const o = r.stdout || '';
  check('B1 a well-formed marker survives a batches/ full of junk',
    r.status === 0 && o.includes('good-2026-08-19'));
  const skipped = ['plain-2026-08-01', 'truncated-2026-08-02', 'arrayish-2026-08-03',
    'scalar-2026-08-04', '2026-08-05', 'baddate-2026-8-6', 'trailing-2026-08-07-x',
    'midname-2026-08-08', 'subdir-2026-08-09'];
  check('B2 every non-marker is skipped silently and never named in the output',
    skipped.every((s) => !o.includes(s)));
  check('B3 a skipped marker is not read either (no issue id of one appears)',
    !/\b[dbtx]-1\b/.test(o));
  check('B4 the count in the header is the count of what is listed',
    /\(1\)/.test(o.split(/\r?\n/)[0] || ''));

  // The greedy project segment, from the other side: a project name that is itself a date
  // must not swallow the naming date.
  const h = mktemp('hyphen');
  marker(h, 'a-b-c-d-2026-08-19', mkMarker('a-b-c-d', '2026-08-19T00:00:00.000Z', ['h-1']));
  const hs = record(cli(h, ['show', 'a-b-c-d-2026-08-19']));
  check('B5 the project segment keeps every hyphen it was written with',
    hs.status === 0 && /\ba-b-c-d\b/.test(hs.stdout || ''));
}

// ---- C. a run's clock, and the three channels it names ids through -----------------------------
{
  const T = '2026-08-10T12:00:00.000Z';
  const withRun = (build) => {
    const t = mktemp('clock');
    marker(t, 'edge-2026-08-10', mkMarker('edge', T, ['edge-1']));
    build(t);
    return record(cli(t, ['pending'])).stdout || '';
  };

  check('C1 a manifest run at the freeze instant EXACTLY counts as having worked it',
    !withRun((t) => manifestRun(t, 'r-exact', T, ['edge-1'])).includes('edge-2026-08-10'));
  check('C2 a manifest run before the freeze leaves the batch pending',
    withRun((t) => manifestRun(t, 'r-old', '2026-08-10T11:59:59.999Z', ['edge-1']))
      .includes('edge-2026-08-10'));
  check('C3 a manifest-less run is dated from run.log, not from its directory name',
    !withRun((t) => logOnlyRun(t, 'r-1999-01-01', '2026-08-11T00:00:00.000Z', ['edge-1']))
      .includes('edge-2026-08-10'));
  check('C4 an unparseable startedAt falls back to the log instant rather than to nothing',
    withRun((t) => {
      writeJson(path.join(t, 'r-junk', 'run.json'), {
        runId: 'r-junk', startedAt: 'whenever', tasks: [{ issueId: 'edge-1' }],
      });
      fs.writeFileSync(path.join(t, 'r-junk', 'run.log'), '2026-08-01T00:00:00.000Z INFO [r-junk/x] go\n');
    }).includes('edge-2026-08-10'));

  // The third id channel: a run killed before it wrote a manifest OR a tasks/ directory
  // still names its ids in the log's trace ids.
  check('C5 a run names ids through its log trace ids as well as its manifest and tasks/',
    !withRun((t) => {
      mk(path.join(t, 'r-trace'));
      fs.writeFileSync(path.join(t, 'r-trace', 'run.log'),
        '2026-08-12T00:00:00.000Z INFO [r-trace/preflight] run start\n'
        + '2026-08-12T00:00:01.000Z INFO [r-trace/edge-1] container up\n');
    }).includes('edge-2026-08-10'));

  // The conservative direction, and its label. A run with no readable clock at all counts
  // as having worked what it names — a false "pending" invites a double launch.
  const u = mktemp('undated');
  marker(u, 'undated-2026-08-10', mkMarker('undated', T, ['u-1', 'u-2']));
  mk(path.join(u, 'r-noclock'));
  writeJson(path.join(u, 'r-noclock', 'tasks', 'u-1', 'status.json'), { issueId: 'u-1' });
  fs.writeFileSync(path.join(u, 'r-noclock', 'run.log'), 'no timestamp here at all\n');
  const up = record(cli(u, ['pending']));
  check('C6 a run with no readable clock counts as having worked the ids it names',
    up.status === 0 && !(up.stdout || '').includes('undated-2026-08-10'));
  const us = record(cli(u, ['show', 'undated-2026-08-10']));
  const uLine = (us.stdout || '').split(/\r?\n/).find((l) => l.includes('u-1')) || '';
  check('C7 and it says so: the id is labelled run-time-unknown, not silently worked',
    /\bworked\b/.test(uLine) && !/\bnot-worked\b/.test(uLine) && uLine.includes('run-time-unknown'));
  const uLine2 = (us.stdout || '').split(/\r?\n/).find((l) => l.includes('u-2')) || '';
  check('C8 an id that run did NOT name is still not-worked',
    /\bnot-worked\b/.test(uLine2) && !uLine2.includes('run-time-unknown'));

  // batches/, locks/ and sweeps/ are not runs. If batches/ were read as one, every marker
  // would count as having worked every id it names.
  const n = mktemp('notruns');
  marker(n, 'safe-2026-08-10', mkMarker('safe', T, ['s-1']));
  writeJson(path.join(n, 'locks', 'tasks', 's-1', 'status.json'), { issueId: 's-1' });
  writeJson(path.join(n, 'sweeps', 'tasks', 's-1', 'status.json'), { issueId: 's-1' });
  const np = record(cli(n, ['pending']));
  check('C9 batches/, locks/ and sweeps/ are never read as run directories',
    np.status === 0 && (np.stdout || '').includes('safe-2026-08-10'));
}

// ---- D. pending means NONE, and the order it prints in ------------------------------------
{
  const t = mktemp('half');
  marker(t, 'half-2026-08-01', mkMarker('half', '2026-08-01T00:00:00.000Z',
    ['h-1', 'h-2', 'h-3', 'h-4']));
  manifestRun(t, 'r-partial', '2026-08-02T00:00:00.000Z', ['h-3']);
  const p = record(cli(t, ['pending']));
  check('D1 a HALF-drained batch leaves pending: any id having run answers the question',
    p.status === 0 && !(p.stdout || '').includes('half-2026-08-01'));
  const s = record(cli(t, ['show', 'half-2026-08-01']));
  const lines = (s.stdout || '').split(/\r?\n/);
  const marked = (id) => lines.find((l) => l.includes(id)) || '';
  check('D2 and show is what keeps it visible rather than binary',
    /\bworked\b/.test(marked('h-3')) && !/\bnot-worked\b/.test(marked('h-3'))
    && ['h-1', 'h-2', 'h-4'].every((id) => /\bnot-worked\b/.test(marked(id))));

  // Ordering, with a tie that only an ascending filename break resolves, and a
  // freeze-time-unknown marker that must sort last rather than first or nowhere.
  const o = mktemp('order');
  const TIE = '2026-08-06T00:00:00.000Z';
  marker(o, 'newest-2026-08-09', mkMarker('newest', '2026-08-09T00:00:00.000Z', ['n-1']));
  marker(o, 'zzz-2026-08-06', mkMarker('zzz', TIE, ['z-1']));
  marker(o, 'mmm-2026-08-06', mkMarker('mmm', TIE, ['m-1']));
  marker(o, 'oldest-2026-08-02', mkMarker('oldest', '2026-08-02T00:00:00.000Z', ['o-1']));
  marker(o, 'undated-2026-08-07', mkMarker('undated', 'not-an-instant', ['u-1']));
  marker(o, 'nothing-2026-08-08', mkMarker('nothing', '2026-08-08T00:00:00.000Z', []));
  const r1 = record(cli(o, ['pending']));
  const text = r1.stdout || '';
  const at = (s2) => text.indexOf(s2);
  check('D3 pending orders newest freeze first, ties by filename ascending, undated last',
    r1.status === 0
    && [ 'newest-2026-08-09', 'nothing-2026-08-08', 'mmm-2026-08-06', 'zzz-2026-08-06',
      'oldest-2026-08-02', 'undated-2026-08-07' ].every((s2) => at(s2) >= 0)
    && at('newest-2026-08-09') < at('nothing-2026-08-08')
    && at('nothing-2026-08-08') < at('mmm-2026-08-06')
    && at('mmm-2026-08-06') < at('zzz-2026-08-06')
    && at('zzz-2026-08-06') < at('oldest-2026-08-02')
    && at('oldest-2026-08-02') < at('undated-2026-08-07'));
  check('D4 the degraded labels ride on the lines they belong to',
    (text.split(/\r?\n/).find((l) => l.includes('undated-2026-08-07')) || '')
      .includes('freeze-time-unknown')
    && (text.split(/\r?\n/).find((l) => l.includes('nothing-2026-08-08')) || '')
      .includes('no-issues'));
  const r2 = record(cli(o, ['pending']));
  check('D5 two invocations over an unchanged tree are byte-identical',
    (r2.stdout || '') === text && text.length > 0);

  // A marker whose freeze time will not parse is never dropped — not even when a run has
  // worked its ids, because the alternative is guessing at the comparison that decides it.
  const f = mktemp('frozenjunk');
  marker(f, 'undated-2026-08-07', mkMarker('undated', 'not-an-instant', ['u-1']));
  manifestRun(f, 'r-any', '2026-08-08T00:00:00.000Z', ['u-1']);
  const fp = record(cli(f, ['pending']));
  check('D6 a freeze-time-unknown marker is listed even when a run has worked its ids',
    fp.status === 0 && (fp.stdout || '').includes('undated-2026-08-07')
    && (fp.stdout || '').includes('freeze-time-unknown'));
}

// ---- E. show: the default, the fields, and the exit-code contract ---------------------------
{
  const t = mktemp('show');
  marker(t, 'older-2026-08-01', mkMarker('older', '2026-08-01T00:00:00.000Z', ['old-1']));
  marker(t, 'newer-2026-08-05', mkMarker('newer', '2026-08-05T00:00:00.000Z', ['new-1'], {
    integrationBranch: 'main',
    freezeCommit: 'abc1234',
    intent: 'the three small reader tasks',
    approvedBy: { name: 'the user', at: '2026-08-05T00:00:00.000Z' }, // nesting is permitted
  }));
  manifestRun(t, 'r-launched', '2026-08-06T00:00:00.000Z', ['new-1']);

  const d = record(cli(t, ['show']));
  const o = d.stdout || '';
  check('E1 show with no argument names the newest marker, LAUNCHED OR NOT',
    d.status === 0 && o.includes('newer-2026-08-05') && !o.includes('older-2026-08-01'));
  check('E2 every optional field present is printed',
    o.includes('main') && o.includes('abc1234') && o.includes('the three small reader tasks'));
  check('E3 a nested optional field is rendered, not concatenated to [object Object]',
    o.includes('the user') && !o.includes('[object Object]'));
  const older = record(cli(t, ['show', 'older-2026-08-01'])).stdout || '';
  check('E4 a marker with no optional fields prints no empty rows for them',
    !/^\s*(branch|freeze commit|intent|approved by):/m.test(older));
  check('E5 show accepts the filename tab completion produces',
    (record(cli(t, ['show', 'older-2026-08-01.json'])).stdout || '') === older);

  // These markers name run configs that this fixture's config directory does not hold, so
  // the join stops at its first half and says which half. `unreconciled` never travels
  // alone, and a degraded show speaks none of the reconciled vocabulary — otherwise "the
  // queue agreed" and "the queue was never asked" read identically at a glance.
  check('E6 a marker whose run config is not on this host says run-config-absent',
    o.includes('unreconciled') && o.includes('run-config-absent'));
  check('E7 a degraded show speaks no reconciled token, here or in any earlier output',
    outputs.every((s) => !RECONCILED.test(s)) && !RECONCILED.test(o));

  const nf = record(cli(t, ['show', 'nosuch-2026-01-01']));
  check('E8 a well-formed name matching no marker exits 3', nf.status === 3);
  check('E9 an unusable argument exits 2', record(cli(t, ['show', '--wat'])).status === 2);
  check('E10 a name that is not <project>-<YYYY-MM-DD> is a usage error, not a miss',
    record(cli(t, ['show', 'nosuch'])).status === 2);
  check('E11 a name reaching outside batches/ is refused',
    record(cli(t, ['show', '../../etc/passwd-2026-01-01'])).status === 2);
  check('E12 show names at most one batch',
    record(cli(t, ['show', 'older-2026-08-01', 'newer-2026-08-05'])).status === 2);
  check('E13 pending takes no arguments',
    record(cli(t, ['pending', 'extra'])).status === 2);
  check('E14 an unknown mode is a usage error', record(cli(t, ['reconcile'])).status === 2);
  check('E15 no mode at all is a usage error', record(cli(t, [])).status === 2);

  // Purity, over the whole tree, after every subcommand including the failing ones.
  const before = digest(t);
  for (const args of [['pending'], ['show'], ['show', 'newer-2026-08-05'], ['show', 'nope-2026-01-01'],
    ['show', '--wat'], ['bogus']]) record(cli(t, args));
  check('E16 the runs root is byte-identical after every subcommand — nothing is written',
    digest(t) === before);
}

// ---- F. self-containment, checked rather than trusted -----------------------------------------
// A copy of this one file has to work from any repo-shaped root. That constraint decays
// silently the first time someone reaches for a convenient helper, and it shows up in no
// behavioural check above. Two imports are permitted and no more, and the reason they are
// permitted is the same reason a THIRD copy of them would be a defect: they are rules the
// runner applies to the same queue, and this reader exists to answer the question the runner
// is about to answer.
{
  const src = fs.readFileSync(SCRIPT, 'utf8');
  const requires = [...src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
  const BUILTINS = ['fs', 'path', 'os', 'url', 'util', 'crypto', 'child_process'];
  const SHARED = ['../runner/bd.js', '../runner/queue.js'];
  check('F1 scripts/batch.js requires node built-ins plus exactly the two shared rules',
    requires.length > 0 && requires.every((r) => BUILTINS.includes(r) || SHARED.includes(r))
    && SHARED.every((s) => requires.includes(s)));

  // Presence is half a check (CLAUDE.md's "plausible and wrong" rule): an import of a name
  // the module stopped exporting is `undefined`, and `undefined.has(...)` would throw at the
  // one moment this tool is used. So the exports are pinned by VALUE, against the runner's
  // own copy rather than against a restatement of it here.
  const runnerBd = require(path.join(ROOT, 'runner', 'bd.js'));
  const runnerQueue = require(path.join(ROOT, 'runner', 'queue.js'));
  check('F2 runner/bd.js still exports the shim probe and the spawn bound this depends on',
    typeof runnerBd.hostBdSpec === 'function' && typeof runnerBd.spawnOptions === 'function'
    && runnerBd.spawnOptions({}).timeout === runnerBd.DEFAULT_BD_TIMEOUT_MS
    && runnerBd.spawnOptions({ bdTimeoutMs: 1500 }).timeout === 1500);
  check('F2b runner/queue.js still exports the epic deny-list, and it still denies epics',
    runnerQueue.EXCLUDED_TYPES instanceof Set && runnerQueue.EXCLUDED_TYPES.has('epic')
    && typeof runnerQueue.typeOf === 'function'
    && runnerQueue.typeOf({ issue_type: ' EPIC ' }) === 'epic'
    && runnerQueue.typeOf({}) === '');
  check('F2c and the reader carries no second copy of either: no type name, no PATH probe',
    !/['"]epic['"]/.test(src) && !/path\.delimiter/.test(src) && !/bd\.cmd/.test(src));

  // The frozen suite pins these two as well (repo-8v0 C8). They are re-asserted here because
  // a frozen directory is never executed again, and both are one careless import from being
  // false: the general helpers in runner/bd.js fall back to running `bd` inside the image
  // when no host bd resolves, and a pure reader may not start a container during a launch.
  check('F2d it starts no container: the source never names one, directly or by helper',
    !/docker/i.test(src) && !/\bbdJson\s*\(/.test(src) && !/[^.\w]bd\s*\(/.test(src));

  check('F3 it reads its runs root from the seam or its own location, never the cwd',
    !/process\.cwd\(\)/.test(src));
  check('F4 it is requirable as a module: main() stays behind require.main === module',
    typeof batchjs.main === 'function' && typeof batchjs.readMarkers === 'function');

  // Nothing in runner/ or pipeline/ may read runs/batches/ — a marker is never a queue
  // item (§3.9). That boundary is invisible to every behavioural check in this file.
  const offenders = [];
  for (const dir of ['runner', 'pipeline']) {
    for (const name of fs.readdirSync(path.join(ROOT, dir))) {
      if (!name.endsWith('.js')) continue;
      const text = fs.readFileSync(path.join(ROOT, dir, name), 'utf8');
      if (/batches/.test(text)) offenders.push(`${dir}/${name}`);
    }
  }
  check(`F5 nothing in runner/ or pipeline/ reads runs/batches/ (a marker is never a queue item)${
    offenders.length ? ` — ${offenders.join(', ')}` : ''}`, offenders.length === 0);
}

// ---- G. the reconciliation against the live queue (§3.9) --------------------------------------
// The check the whole design exists for. The runner has no picker (§4.12) — it drains
// whatever queue it finds — so an issue nobody meant to include simply runs and a blocked one
// silently does not, and nothing else in the pipeline holds the INTENT to compare the queue
// against. Everything here goes through the real CLI as a child, because the argv it builds is
// half of what is being asserted.
{
  const bin = mktemp('bd');
  const argsLog = path.join(bin, 'bd-args.log');

  // See the header. The guard is the load-bearing line: without it this stub preloads into
  // scripts/batch.js as well as into the bd child it spawns, and kills the reader at its
  // first process.exit — after which every check below passes or fails without the
  // implementation having run at all.
  function stub(name, body) {
    const p = path.join(bin, name);
    fs.writeFileSync(p, [
      "'use strict';",
      "const sfs = require('fs');",
      'const argv = process.argv.slice(1);',
      "if (!argv.includes('-C')) return;    // not the bd child — stand aside",
      "if (process.env.BD_ARGS_LOG) sfs.appendFileSync(process.env.BD_ARGS_LOG, JSON.stringify(argv) + '\\n');",
      body,
    ].join('\n') + '\n');
    return p;
  }
  const withStub = (p, extra) => Object.assign(
    { PIPELINE_BD_CMD: process.execPath, NODE_OPTIONS: `--require "${fwd(p)}"` }, extra || {});
  const badPath = (p) => ({ PIPELINE_BD_CMD: p });   // a seam naming something unexecutable

  // Two configs naming DIFFERENT target repos, and two markers carrying the SAME three ids.
  // Only the config a marker names can change its verdict, so an implementation that ignores
  // targetRepoPath answers identically for both and is caught by G4 rather than by luck.
  const cfg = mktemp('cfg');
  const repoA = mk(path.join(mktemp('repoA'), 'alpha'));
  const repoB = mk(path.join(mktemp('repoB'), 'beta'));
  writeJson(path.join(cfg, 'run.config.alpha.json'), { targetRepoPath: repoA, bdTimeoutMs: 20000 });
  writeJson(path.join(cfg, 'run.config.beta.json'), { targetRepoPath: repoB, bdTimeoutMs: 20000 });
  writeJson(path.join(cfg, 'run.config.noteal.json'), { image: 'pipeline-base' }); // no targetRepoPath

  const t = mktemp('queue');
  const IDS = ['q-1', 'q-2', 'q-3'];
  const seed = (stem, runConfig) => marker(t, stem, {
    runConfig, frozenAt: '2026-08-15T00:00:00.000Z',
    issues: IDS.map((id) => ({ id, title: `title for ${id}` })),
  });
  seed('alpha-2026-08-15', 'run.config.alpha.json');
  seed('beta-2026-08-15', 'run.config.beta.json');
  seed('noteal-2026-08-15', 'run.config.noteal.json');
  seed('escape-2026-08-15', '../run.config.alpha.json');
  seed('nameless-2026-08-15', null);
  seed('ghost-2026-08-15', 'run.config.ghost.json');   // a config no host has

  // Answers from the -C argument it was handed. Under repoA: two of the batch's ids, an EPIC
  // parent (bd returns those by design — never a stray), and one unrelated task (the real
  // stray). Under anything else: one id, so the same marker ids reconcile differently.
  const live = stub('live.js', [
    "const target = argv[argv.indexOf('-C') + 1];",
    `const answer = target === ${JSON.stringify(repoA)}`,
    "  ? [{id:'q-1',priority:1,issue_type:'task'}, {id:'q-2',priority:1,issue_type:'task'},",
    "     {id:'q-9',priority:0,issue_type:'epic'}, {id:'wander-1',priority:2,issue_type:'task'}]",
    "  : [{id:'q-1',priority:1,issue_type:'task'}];",
    'process.stdout.write(JSON.stringify(answer));',
    'process.exit(0);',
  ].join('\n'));

  const run = (stem, env) => cli(t, ['show', stem],
    Object.assign({ BATCH_CONFIG_DIR: cfg, BD_ARGS_LOG: argsLog }, env || {}));
  const lineFor = (text, id) => (text.split(/\r?\n/).find((l) => l.includes(id)) || '');
  const counted = (text, re) => text.split(/\r?\n/).filter((l) => re.test(l)).length;

  fs.writeFileSync(argsLog, '');
  const a = run('alpha-2026-08-15', withStub(live));
  const ao = both(a);
  check('G1 an id the live queue holds is ready, and one it does not is not-ready',
    a.status === 0 && /\bready\b/.test(lineFor(ao, 'q-1')) && /\bready\b/.test(lineFor(ao, 'q-2'))
    && /\bnot-ready\b/.test(lineFor(ao, 'q-3')));
  check('G2 an id the run would drain that the batch never named is exactly one stray',
    counted(ao, /\bstray\b/) === 1 && lineFor(ao, 'wander-1').includes('stray'));
  check('G3 an epic parent is filtered before anything is called a stray, and never named',
    !ao.includes('q-9'));
  check('G4 a reconciled show speaks no degraded term at all',
    !/\b(?:unreconciled|bd-unavailable|bd-unreadable|run-config-absent)\b/.test(ao));

  // The argv, and the tell. Exactly one line means the reader ran and the stub stood aside:
  // a stub that hijacked scripts/batch.js logs one line too, but it is batch.js's own argv.
  const logged = fs.readFileSync(argsLog, 'utf8').trim().split(/\r?\n/).filter(Boolean);
  const argv = logged.length === 1 ? JSON.parse(logged[0]) : [];
  check('G5 bd is consulted exactly once, and it is bd that was consulted',
    logged.length === 1 && !argv.some((x) => String(x).endsWith('batch.js')));
  check('G6 the argv names the target repo of the config THIS marker names',
    argv.includes('-C') && argv[argv.indexOf('-C') + 1] === repoA);
  check('G7 the argv asks for the ready queue as JSON',
    argv.includes('ready') && argv.includes('--json'));
  check('G8 the call reads and never writes (hard rule 1)',
    !argv.some((x) => ['update', 'close', 'create', 'import', 'sync', 'dolt', 'note', 'remember']
      .includes(String(x))));

  fs.writeFileSync(argsLog, '');
  const b = run('beta-2026-08-15', withStub(live));
  const bo = both(b);
  check('G9 the same ids under a different run config get a different verdict',
    b.status === 0 && counted(bo, /\bnot-ready\b/) === 2 && counted(bo, /\bstray\b/) === 0);
  check('G10 and the argv proves why: the other config named the other repo',
    JSON.parse(fs.readFileSync(argsLog, 'utf8').trim())[2] === repoB);

  // Every way the join can fail, each naming itself. `unreconciled` never travels without
  // exactly one reason, and none of these may speak the reconciled vocabulary — the half that
  // is load-bearing in the other direction is G1–G4, without which a tool that always says
  // unreconciled would pass this whole block.
  const degraded = (label, stem, env, reason, notReason) => {
    const r = run(stem, env);
    const o = both(r);
    check(`${label} exits 0, lists every id, and says ${reason}`,
      r.status === 0 && IDS.every((id) => o.includes(id))
      && o.includes('unreconciled') && o.includes(reason)
      && (!notReason || !o.includes(notReason)));
    check(`${label} speaks no reconciled token`, !RECONCILED.test(o));
  };
  degraded('G11 a seam naming something unexecutable', 'alpha-2026-08-15',
    badPath(path.join(bin, 'definitely-not-here')), 'bd-unavailable');
  degraded('G12 a bd that exits non-zero', 'alpha-2026-08-15',
    withStub(stub('fail.js', "process.stderr.write('bd exploded'); process.exit(4);")), 'bd-unreadable');
  degraded('G13 a bd printing unparseable output', 'alpha-2026-08-15',
    withStub(stub('junk.js', "process.stdout.write('not json at all'); process.exit(0);")), 'bd-unreadable');
  degraded('G14 a bd answering something that is not the expected array', 'alpha-2026-08-15',
    withStub(stub('object.js', "process.stdout.write('{\"issues\":[]}'); process.exit(0);")), 'bd-unreadable');
  const ok = stub('ok.js', "process.stdout.write('[]'); process.exit(0);");
  degraded('G15 a marker naming a config this host has not got', 'ghost-2026-08-15',
    withStub(ok), 'run-config-absent', 'bd-unavailable');
  degraded('G16 a config carrying no targetRepoPath', 'noteal-2026-08-15',
    withStub(ok), 'run-config-absent', 'bd-unavailable');
  degraded('G17 a runConfig reaching out of the config directory', 'escape-2026-08-15',
    withStub(ok), 'run-config-absent', 'bd-unavailable');
  degraded('G18 a marker naming no run config at all', 'nameless-2026-08-15',
    withStub(ok), 'run-config-absent', 'bd-unavailable');

  // The bound, fired for real. A stub that merely never exits is NOT enough on its own: node
  // kills it anyway the moment it cannot resolve the program slot, so the elapsed time proves
  // nothing. Swallowing that and holding a timer open is the only shape that hangs, and the
  // lower bound below is what separates "killed at the bound" from "died on its own".
  writeJson(path.join(cfg, 'run.config.slow.json'), { targetRepoPath: repoA, bdTimeoutMs: 2000 });
  seed('slow-2026-08-15', 'run.config.slow.json');
  const hang = stub('hang.js', [
    "process.on('uncaughtException', () => {});",
    'setInterval(() => {}, 1000);',
  ].join('\n'));
  const t0 = Date.now();
  const h = run('slow-2026-08-15', withStub(hang));
  const elapsed = Date.now() - t0;
  const ho = both(h);
  check('G19 a bd that never answers is killed at the run config’s bdTimeoutMs',
    h.status === 0 && elapsed >= 1500 && elapsed < 30000);
  check('G20 and a kill at the bound is bd-unreadable, not bd-unavailable — bd DID run',
    ho.includes('unreconciled') && ho.includes('bd-unreadable') && !ho.includes('bd-unavailable'));
  check('G21 it says nothing about the queue it never read', !RECONCILED.test(ho));

  // Still a pure reader on the reconciled path, and `pending` still spawns nothing at all:
  // the queue is `show`'s question, and a listing that woke bd once per marker would make the
  // cheapest command in the tool the most expensive.
  const before = digest(t);
  run('alpha-2026-08-15', withStub(live));
  fs.writeFileSync(argsLog, '');
  const p = cli(t, ['pending'], withStub(live, { BATCH_CONFIG_DIR: cfg, BD_ARGS_LOG: argsLog }));
  check('G22 pending consults no queue: it answers from the run corpus alone',
    p.status === 0 && fs.readFileSync(argsLog, 'utf8').trim() === '');
  check('G23 the runs root is byte-identical after a reconciled show', digest(t) === before);

  // The two seams, computed rather than only exercised: the frozen suite always exports
  // BATCH_CONFIG_DIR, so a reader resolving it from the working directory passes every
  // behavioural check above. And PIPELINE_BD_CMD must win outright — a suite that stubs it
  // and still reached the host's own bd would be answering from the host's real database.
  check('G24 with the seam unset the config directory is the repo root, never the cwd',
    batchjs.configDir({}) === ROOT && batchjs.configDir({ BATCH_CONFIG_DIR: '  ' }) === ROOT
    && batchjs.configDir({ BATCH_CONFIG_DIR: cfg }) === path.resolve(cfg));
  const spec = batchjs.readSpec({ PIPELINE_BD_CMD: '/nowhere/bd' });
  check('G25 the seam takes absolute precedence over the host probe',
    spec !== null && spec.cmd === '/nowhere/bd');
  check('G26 and the argv it builds leads with a program slot, so `-C` survives the parser',
    Array.isArray(spec.pre) && spec.pre.length === 1
    && spec.pre[0] === batchjs.SEAM_PROGRAM_SLOT);

  // The epic filter and the stray rule, driven directly, at the shapes a real queue grows:
  // an entry with no id, an untyped entry (kept — the deny-list is a deny-list), a nested
  // junk entry. A behavioural check cannot reach these without a stub per shape.
  const m = { issues: [{ id: 'q-1' }, { id: 'q-3' }] };
  const rec = batchjs.reconcile(m, [
    { id: 'q-1', issue_type: 'task' }, { id: 'e-1', issue_type: 'EPIC' },
    { id: 'u-1' }, { id: '', issue_type: 'task' }, null, ['nope'], { issue_type: 'task' },
  ]);
  check('G27 the epic filter is case-insensitive and drops the entry before the stray rule',
    rec.excluded === 1 && !rec.strays.some((s) => s.id === 'e-1'));
  check('G28 an untyped entry is KEPT, so a legitimately-typed spec cannot vanish silently',
    rec.strays.some((s) => s.id === 'u-1' && s.type === 'untyped'));
  check('G29 an entry with no usable id is skipped, and junk entries do not throw',
    rec.queued.length === 2 && rec.state('q-1') === 'ready' && rec.state('q-3') === 'not-ready');
}

for (const t of temps) fs.rmSync(t, { recursive: true, force: true, maxRetries: 5 });
process.exit(failed);
