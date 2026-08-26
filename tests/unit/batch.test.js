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
//   * The reconciliation (section G) is driven past the frozen fixtures: `pending` must
//     spawn NOTHING, the epic filter must be the RUNNER'S rule rather than a private copy
//     that agrees today, an answer that is well-formed JSON of the wrong SHAPE is
//     unreadable rather than an empty queue, and a queue larger than spawnSync's 1 MiB
//     default still reconciles — an overflow and a timeout kill the child identically, so
//     a reader that never raised the ceiling reports a query that answered at once as one
//     that never answered.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'batch.js');

// The suite owns its fixtures: a seam inherited from the shell would let the caller's
// environment decide the result — and, worse, aim a reader at the host's real runs root.
// `BATCH_CONFIG_DIR` and `PIPELINE_BD_CMD` matter twice over now that `show` reconciles: an
// inherited pair could point this suite at a real `run.config.<project>.json` and then run
// the host's real `bd` against the working copy it names.
delete process.env.BATCH_RUNS_DIR;
delete process.env.BATCH_CONFIG_DIR;
delete process.env.PIPELINE_BD_CMD;

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

// Every invocation is aimed at a run-config directory this suite owns, and by default at an
// EMPTY one: a `show` that resolved a config from the repo root would consult whatever
// target the developer happens to have onboarded, with the host's real `bd`. Section G is
// where a config and a stubbed queue are supplied on purpose.
const EMPTY_CONFIG_DIR = mktemp('noconfig');

function cli(runsRoot, args, env) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    env: Object.assign({}, process.env,
      { BATCH_RUNS_DIR: runsRoot, BATCH_CONFIG_DIR: EMPTY_CONFIG_DIR }, env || {}),
  });
}
const fwd = (p) => p.replace(/\\/g, '/');   // NODE_OPTIONS eats backslashes

// The `bd` stand-in: a .js file preloaded through `process.execPath`, never a `#!/bin/sh`
// script (spawnSync fails one with EFTYPE on the Windows host, so a shell stub would pass in
// a container and fail in the host sweep).
//
// THE STAND-ASIDE GUARD IS LOAD-BEARING AND MUST COME FIRST. `NODE_OPTIONS=--require` reaches
// every node process that inherits the environment, including the `node scripts/batch.js`
// child this suite spawns — unguarded, the stub preloads into the reader itself and its
// `process.exit()` kills it before its first line, leaving the fixture measuring the stub and
// calling that a pass. Above the log, too: below it the reader's own preload writes a line
// and "the queue is consulted exactly once" fails for the wrong reason.
function writeStub(dir, name, body) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, `'use strict';\nconst fs = require('fs');\nconst argv = process.argv.slice(1);\n`
    + `if (argv.some((a) => /batch\\.js$/.test(String(a)))) return;\n`
    + `if (process.env.STUB_LOG) fs.appendFileSync(process.env.STUB_LOG, JSON.stringify(argv) + '\\n');\n`
    + `${body}\n`);
  return p;
}
function cliWithQueue(runsRoot, cfgDir, stub, log, args) {
  const env = {
    BATCH_CONFIG_DIR: cfgDir,
    PIPELINE_BD_CMD: process.execPath,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require "${fwd(stub)}"`.trim(),
  };
  if (log) env.STUB_LOG = log;
  return cli(runsRoot, args, env);
}
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
  //
  // ---- the live queue feed's effect on this join (§4.12, change-log row `live-queue-feed`)
  // A FED run re-reads the ready queue while it is in flight, so it can work an id frozen
  // after it started. Bounding it by `startedAt` — correct for every classic run, and what
  // this tool did before the feed shipped — reports a batch it demonstrably worked as
  // pending, and a false pending is what gets a batch launched twice.
  //
  // The fixture that discriminates is a PAIR: the same run, same clock, same ids, differing
  // only in whether `feed.enabled` is true. Every other fixture in this file is answered
  // identically by the old implementation and the new one; only the pair tells them apart.
  const fedRun = (root, id, startedAt, finishedAt, issueIds, feed) => {
    writeJson(path.join(root, id, 'run.json'), {
      schema: 1,
      runId: id,
      startedAt,
      ...(finishedAt === undefined ? {} : { finishedAt }),
      targetRepo: 'https://example.invalid/fixture/repo.git',
      ...(feed === undefined ? {} : { feed }),
      tasks: issueIds.map((i) => ({ issueId: i, outcome: 'done', prUrl: null })),
    });
    fs.writeFileSync(path.join(root, id, 'run.log'), `${startedAt} INFO [${id}/preflight] run start\n`);
  };
  const BEFORE = '2026-08-10T11:00:00.000Z';   // an hour before the freeze
  const AFTER = '2026-08-10T13:00:00.000Z';    // an hour after it
  const feedRoot = (feed, finishedAt) => {
    const t = mktemp('fed');
    marker(t, 'fed-2026-08-10', mkMarker('fed', T, ['fed-1']));
    fedRun(t, 'r-fed', BEFORE, finishedAt, ['fed-1'], feed);
    return (record(cli(t, ['pending'])).stdout || '');
  };

  check('C10 a CLASSIC run that started before the freeze still leaves the batch pending',
    feedRoot({ enabled: false, ending: 'drained' }, AFTER).includes('fed-2026-08-10'));
  check('C11 a FED run that started before the freeze and ended after it has WORKED the batch',
    !feedRoot({ enabled: true, ending: 'idle' }, AFTER).includes('fed-2026-08-10'));
  check('C12 a fed run that also ENDED before the freeze leaves the batch pending',
    feedRoot({ enabled: true, ending: 'idle' }, '2026-08-10T11:30:00.000Z')
      .includes('fed-2026-08-10'));
  check('C13 a manifest with no feed block at all is read as classic, not as fed',
    feedRoot(undefined, AFTER).includes('fed-2026-08-10'));
  // Strictly `=== true`. A truthy test over a missing or oddly-shaped block would re-answer
  // the entire historic corpus, every manifest of which predates the feed.
  check('C14 a feed block that is not an object, or whose enabled is not true, is classic',
    feedRoot({ enabled: 'yes' }, AFTER).includes('fed-2026-08-10')
    && feedRoot([], AFTER).includes('fed-2026-08-10'));

  // A fed run still in flight has no finishedAt. It could have taken the work at any point,
  // so it counts — the conservative direction, and it says why rather than looking certain.
  {
    const t = mktemp('fedopen');
    marker(t, 'open-2026-08-10', mkMarker('open', T, ['o-1']));
    fedRun(t, 'r-open', BEFORE, undefined, ['o-1'], { enabled: true });
    const op = record(cli(t, ['pending']));
    check('C15 a fed run with no readable finish counts against every freeze',
      op.status === 0 && !(op.stdout || '').includes('open-2026-08-10'));
    const oShow = record(cli(t, ['show', 'open-2026-08-10']));
    const oLine = (oShow.stdout || '').split(/\r?\n/).find((l) => l.includes('o-1')) || '';
    check('C16 and it is labelled run-fed-open — the witness may still be RUNNING',
      /\bworked\b/.test(oLine) && !/\bnot-worked\b/.test(oLine) && oLine.includes('run-fed-open'));
  }
  // A definite witness must beat a provisional one, or a certain answer reads as provisional.
  {
    const t = mktemp('fedwitness');
    marker(t, 'wit-2026-08-10', mkMarker('wit', T, ['w-1']));
    fedRun(t, 'r-a-open', BEFORE, undefined, ['w-1'], { enabled: true });
    fedRun(t, 'r-b-done', AFTER, AFTER, ['w-1'], { enabled: false });
    const wShow = record(cli(t, ['show', 'wit-2026-08-10']));
    const wLine = (wShow.stdout || '').split(/\r?\n/).find((l) => l.includes('w-1')) || '';
    check('C17 a finished witness is preferred over a fed run still open',
      wLine.includes('r-b-done') && !wLine.includes('run-fed-open'));
  }

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

  // The middle link of the three-source join, named for what it is. Every fixture above
  // runs against a config directory this suite owns and left empty, so every one of them
  // takes this path — which is exactly why the token must be `run-config-absent` and not
  // `bd-unavailable`: it sends someone to look at the right missing thing.
  check('E6 a marker whose run config this host lacks says unreconciled run-config-absent',
    o.includes('unreconciled') && o.includes('run-config-absent') && !o.includes('bd-unavailable'));
  check('E7 a degraded show speaks no reconciled token — everywhere, including usage errors',
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
// What this reader may import is a short, closed list, and it decays silently the first time
// someone reaches for a shared helper: node built-ins, plus the two rules it must not own a
// second copy of (`hostBdSpec` — how this host invokes `bd`, npm's shims included — and the
// runner's epic filter). Nothing else, and in particular nothing that can start a container:
// the runner's `bd`/`bdJson` helpers fall back to running the query inside the per-project
// image, which would make a pure reader launch one. No behavioural check above can see any
// of this, and the frozen acceptance directory that pins some of it is never run again.
{
  const src = fs.readFileSync(SCRIPT, 'utf8');
  const requires = [...src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
  const BUILTINS = ['fs', 'path', 'os', 'url', 'util', 'crypto', 'child_process'];
  const ALLOWED_REPO = ['../runner/bd', '../runner/queue'];
  check('F1 scripts/batch.js requires node built-ins plus the two runner rules, and nothing else',
    requires.length > 0
    && requires.every((r) => BUILTINS.includes(r) || ALLOWED_REPO.includes(r)));
  check('F1b it imports the runner\'s rules rather than re-implementing them',
    ALLOWED_REPO.every((r) => requires.includes(r))
    && /hostBdSpec/.test(src) && /EXCLUDED_TYPES/.test(src) && /typeOf/.test(src));
  check('F2 it never starts a container: no mention of the engine, and no call to bd() or bdJson()',
    !/docker/i.test(src) && !/\bbdJson\s*\(/.test(src) && !/[^.\w]bd\s*\(/.test(src));
  check('F2b the queue seam is the existing PIPELINE_BD_CMD, never a BATCH_BD_CMD of its own',
    /PIPELINE_BD_CMD/.test(src) && !/BATCH_BD_CMD/.test(src));
  check('F3 it reads its roots from the seams or its own location, never the cwd',
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

// ---- G. the reconciliation against the live queue (§3.9) ----------------------------------------
// The check the whole design exists for: the runner has no picker (§4.12) and drains whatever
// queue it finds, so an issue nobody meant to include simply runs and a blocked one silently
// does not. Everything here is driven through the EXISTING `PIPELINE_BD_CMD` seam against a
// stand-in — no `bd`, no network, no container engine, and never a real target repo.
{
  const { EXCLUDED_TYPES } = require(path.join(ROOT, 'runner', 'queue'));
  const runs = mktemp('rec-runs');
  const cfgDir = mktemp('rec-cfg');
  const bin = mktemp('rec-bin');
  const repo = mk(path.join(mktemp('rec-repo'), 'target'));
  writeJson(path.join(cfgDir, 'run.config.rec.json'), { targetRepoPath: repo, bdTimeoutMs: 20000 });
  marker(runs, 'rec-2026-08-19', mkMarker('rec', '2026-08-19T00:00:00.000Z', ['q-1', 'q-2']));

  // The queue: one of the batch's two ids, one entry of every type the RUNNER excludes
  // (upper-cased and space-padded, because `typeOf` normalises and a private copy of the
  // rule would not), and one entry with no `issue_type` at all — which the deny-list KEEPS,
  // so it is a genuine stray rather than something quietly dropped.
  const excluded = [...EXCLUDED_TYPES];
  const answer = [
    { id: 'q-1', priority: 1, issue_type: 'task' },
    ...excluded.map((t, n) => ({ id: `parent-${n}`, priority: 1, issue_type: ` ${String(t).toUpperCase()} ` })),
    { id: 'untyped-1', priority: 2 },
  ];
  const log = path.join(bin, 'argv.log');
  const live = writeStub(bin, 'live.js',
    `process.stdout.write(${JSON.stringify(JSON.stringify(answer))}); process.exit(0);`);

  fs.writeFileSync(log, '');
  const pendingRun = record(cliWithQueue(runs, cfgDir, live, log, ['pending']));
  check('G1 pending consults no queue at all: the bounded call belongs to show alone',
    pendingRun.status === 0 && fs.readFileSync(log, 'utf8').trim() === '');

  fs.writeFileSync(log, '');
  const r = record(cliWithQueue(runs, cfgDir, live, log, ['show', 'rec-2026-08-19']));
  const o = r.stdout || '';
  const at = (id) => (o.split(/\r?\n/).find((l) => l.includes(id)) || '');
  check('G2 an id the queue offers is ready and one it does not is not-ready, and findings exit 0',
    r.status === 0 && /\bready\b/.test(at('q-1')) && !/\bnot-ready\b/.test(at('q-1'))
    && /\bnot-ready\b/.test(at('q-2')));
  check('G3 an entry of an EXCLUDED type is never a stray, whatever case or padding bd sent',
    excluded.length > 0 && excluded.every((t, n) => !o.includes(`parent-${n}`)));
  check('G4 an entry with no issue_type at all is KEPT, and is a stray',
    /\bstray\b/.test(at('untyped-1')));
  check('G5 a reconciled show speaks no degraded term',
    !/\b(?:unreconciled|bd-unavailable|bd-unreadable|run-config-absent)\b/.test(o));

  const logged = fs.readFileSync(log, 'utf8').trim().split(/\r?\n/).filter(Boolean);
  check('G6 the queue is consulted exactly once', logged.length === 1);
  const argv = logged.length === 1 ? JSON.parse(logged[0]) : [];
  check('G7 the vector is read-only and names the repo the marker\'s run config points at',
    argv.includes('-C') && argv.includes(repo) && argv.includes('ready') && argv.includes('--json')
    && !argv.some((a) => ['update', 'close', 'create', 'import', 'sync', 'dolt', 'note'].includes(String(a))));
  // node's own parser owns `-C` (the short form of `--conditions`) and eats a leading
  // `-C <path>` before any preload sees it, so which repo was consulted stops being
  // observable. A throwaway program slot in front of the vector is what prevents that.
  check('G8 -C sits past the first argument, where no argv parser can claim it',
    argv.indexOf('-C') > 0);

  const before = digest(runs);
  record(cliWithQueue(runs, cfgDir, live, null, ['show', 'rec-2026-08-19']));
  check('G9 a reconciled show writes nothing — still a pure reader', digest(runs) === before);

  // Every way the join breaks, each naming its own broken link. The frozen acceptance
  // directory pins these once and is never executed again; this is the copy that keeps
  // holding, and the reconciled half above is what stops "always unreconciled" passing it.
  const cases = [
    ['an unspawnable bd', path.join(bin, 'not-a-real-program'), 'bd-unavailable'],
    ['a bd that exits non-zero',
      writeStub(bin, 'boom.js', `process.stderr.write('no ready queue here'); process.exit(4);`),
      'bd-unreadable'],
    ['unparseable output', writeStub(bin, 'junk.js', `process.stdout.write('<html>'); process.exit(0);`),
      'bd-unreadable'],
    // Well-formed JSON of the WRONG SHAPE. `bd ready --json` answers with a bare array;
    // reading an object as an empty queue would report every id not-ready and every batch
    // clean — the confident wrong answer, from a version of the tool this cannot parse.
    ['a JSON object where the queue array belongs',
      writeStub(bin, 'object.js', `process.stdout.write('{"issues":[]}'); process.exit(0);`),
      'bd-unreadable'],
  ];
  for (const [label, stub, reason] of cases) {
    const env = {
      BATCH_CONFIG_DIR: cfgDir,
      PIPELINE_BD_CMD: stub,
      NODE_OPTIONS: stub.endsWith('.js')
        ? `${process.env.NODE_OPTIONS || ''} --require "${fwd(stub)}"`.trim() : '',
    };
    if (stub.endsWith('.js')) env.PIPELINE_BD_CMD = process.execPath;
    const d = record(cli(runs, ['show', 'rec-2026-08-19'], env));
    const t = both(d);
    check(`G10 ${label} exits 0, names its own reason (${reason}), and states no queue`,
      d.status === 0 && t.includes('unreconciled') && t.includes(reason) && !RECONCILED.test(t)
      && ['q-1', 'q-2'].every((id) => t.includes(id)));
  }

  // The bound, and the reason the ceiling below is tested before it: a child killed at the
  // timeout and a child killed for overflowing the capture buffer are the SAME SHAPE.
  writeJson(path.join(cfgDir, 'run.config.slow.json'), { targetRepoPath: repo, bdTimeoutMs: 1200 });
  marker(runs, 'slow-2026-08-18', Object.assign(
    mkMarker('slow', '2026-08-18T00:00:00.000Z', ['s-1']), { runConfig: 'run.config.slow.json' }));
  const hang = writeStub(bin, 'hang.js', `setInterval(() => {}, 1000);`);
  const t0 = Date.now();
  const timedOut = record(cliWithQueue(runs, cfgDir, hang, null, ['show', 'slow-2026-08-18']));
  check('G11 a queue that never answers is killed at bdTimeoutMs and read as bd-unreadable',
    timedOut.status === 0 && Date.now() - t0 < 30000
    && both(timedOut).includes('unreconciled') && both(timedOut).includes('bd-unreadable'));

  // The ceiling itself. spawnSync's default is 1 MiB and a real ready queue can print more;
  // the flood must go out through fs.writeSync rather than process.stdout.write, or
  // process.exit truncates the pending pipe write and the fixture proves nothing — the short
  // answer fails as unparseable JSON and the check passes with the ceiling never reached.
  const flood = writeStub(bin, 'flood.js', `
const many = [];
for (let i = 0; i < 20000; i++) many.push({ id: 'pad-' + i, priority: 2, issue_type: 'epic', title: 'x'.repeat(80) });
many.push({ id: 'big-1', priority: 1, issue_type: 'task' });
const buf = Buffer.from(JSON.stringify(many));
if (buf.length < 1024 * 1024) { process.stdout.write('[]'); process.exit(0); }
let off = 0;
while (off < buf.length) off += fs.writeSync(1, buf, off, Math.min(65536, buf.length - off));
process.exit(0);`);
  marker(runs, 'big-2026-08-17', Object.assign(
    mkMarker('big', '2026-08-17T00:00:00.000Z', ['big-1']), { runConfig: 'run.config.rec.json' }));
  const big = record(cliWithQueue(runs, cfgDir, flood, null, ['show', 'big-2026-08-17']));
  const bigOut = big.stdout || '';
  check('G12 a queue larger than spawnSync\'s 1 MiB default still reconciles, and is not a timeout',
    big.status === 0 && /\bready\b/.test(bigOut.split(/\r?\n/).find((l) => l.includes('big-1')) || '')
    && !/\b(?:unreconciled|bd-unreadable)\b/.test(bigOut));

  // The middle link of the three-source join: a config that IS present but says nothing this
  // reader can use is still `run-config-absent`, never a `bd` term — a marker sent to the
  // wrong missing thing costs the one person this tool exists for an afternoon.
  writeJson(path.join(cfgDir, 'run.config.hollow.json'), { image: 'pipeline-fixture:latest' });
  marker(runs, 'hollow-2026-08-16', Object.assign(
    mkMarker('hollow', '2026-08-16T00:00:00.000Z', ['h-1']), { runConfig: 'run.config.hollow.json' }));
  const hollow = record(cliWithQueue(runs, cfgDir, live, null, ['show', 'hollow-2026-08-16']));
  check('G13 a run config carrying no targetRepoPath is run-config-absent, not a bd failure',
    hollow.status === 0 && both(hollow).includes('run-config-absent')
    && !/\bbd-(?:unavailable|unreadable)\b/.test(both(hollow)));

  // And the config directory itself resolves the way the runs root does: from the seam, else
  // from this file's own location. The seam is how every check above reaches its fixture,
  // which means none of them can see a reader that fell back to the working directory.
  check('G14 with the seam unset the run config directory is the repo root, never the cwd',
    batchjs.configDir({}) === ROOT && batchjs.configDir({ BATCH_CONFIG_DIR: '  ' }) === ROOT
    && batchjs.configDir({ BATCH_CONFIG_DIR: cfgDir }) === path.resolve(cfgDir));
}

for (const t of temps) fs.rmSync(t, { recursive: true, force: true, maxRetries: 5 });
process.exit(failed);
