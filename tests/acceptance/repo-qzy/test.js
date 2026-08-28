#!/usr/bin/env node
// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// FROZEN acceptance suite for repo-qzy — every run.log line gets a structured twin in
// runs/<runId>/events.jsonl, written by the same function with the same timestamp.
//
// Written before any implementation exists, from the spec alone. Do not edit during a run —
// everything under tests/acceptance/ is diffed against the fork point and any difference ends
// the task `tampered` (DESIGN.md §4.4).
//
// The fixture drives the REAL runOneTask with a REAL startRun log through the Docker-free
// seams (PIPELINE_BD_CMD, PIPELINE_EXEC_STUB, PIPELINE_GH_CMD), the way the pause-gate suite
// does. Three things it is careful about:
//   * The preloaded bd stub has a STAND-ASIDE GUARD as its first statement: a NODE_OPTIONS
//     --require reaches every node child, and a stub that exits unconditionally kills the gh
//     stub — and any suite this file spawns — before its first line.
//   * The run.log expectation is the WHOLE fixture log, every line, masked only where a temp
//     path or a commit hash is; a sample would let unlisted lines drift.
//   * Children this suite spawns get NODE_OPTIONS and every PIPELINE_* variable removed.
//
// Section headers name the criterion they serve; every criterion in the issue has one.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
let failed = 0;
function check(name, cond, detail) {
  console.log(`${cond ? 'ok' : 'FAIL'} - ${name}`);
  if (!cond) { failed = 1; if (detail) console.log(`       ${String(detail).slice(0, 300)}`); }
  return cond;
}
function read(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } }
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
const scrubbedEnv = () => {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  for (const k of Object.keys(env)) if (/^PIPELINE_/.test(k) || /^BD_/.test(k)) delete env[k];
  return env;
};

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-qzy-'));

let runmod = null; let logmod = null;
try { runmod = require(path.join(ROOT, 'runner', 'run.js')); } catch { runmod = null; }
try { logmod = require(path.join(ROOT, 'runner', 'log.js')); } catch { logmod = null; }
check('runner/run.js and runner/log.js are requirable', !!runmod && !!logmod && typeof logmod.startRun === 'function');

// ---- the fixture run ------------------------------------------------------------------------

const EXPECTED_LOG = [
  'INFO [unit-events/preflight] run started (config: fixture)',
  'INFO [unit-events/led-1] starting task (priority 1): ledger task',
  'INFO [unit-events/led-1] integration branch: main',
  'INFO [unit-events/led-1] memory: no notes recorded yet — container gets the empty marker',
  'INFO [unit-events/led-1] workspace ready: <WS> on task/led-1 (fork point <SHA>)',
  'INFO [unit-events/led-1] exec stub exited 20',
  'INFO [unit-events/led-1] rate limit hit (pause 1) — parking the task; issue stays in_progress',
  'INFO [unit-events/led-1] relaunching in a fresh container against the same workspace (attempt counter carries over)',
  'INFO [unit-events/led-1] exec stub exited 0',
  'INFO [unit-events/led-1] task resumed across 1 usage-window pause(s)',
  'INFO [unit-events/led-1] branch task/led-1: no commits (nothing to push)',
  'INFO [unit-events/led-1] no commits on the branch — nothing to push, no PR',
  'INFO [unit-events/led-1] task finished: exit 0 -> done (issue closed)',
  'ERROR [unit-events/led-2] refused: the run-level rate-limit pause cap has fired; nothing launched, issue stays open',
  'INFO [unit-events/preflight] run finished; artifacts in <DIR>',
];
const LINE = /^(\S+) (INFO|ERROR) \[([^\]]+)\] (.*)$/;
function mask(msg) {
  return msg
    .replace(/workspace ready: .* on task\//, 'workspace ready: <WS> on task/')
    .replace(/\(fork point [0-9a-f]{8}\)/, '(fork point <SHA>)')
    .replace(/artifacts in .*$/, 'artifacts in <DIR>');
}

let fixture = null;
async function runFixture() {
  const tmp = fs.mkdtempSync(path.join(TMP, 'fx-'));
  const remote = path.join(tmp, 'remote.git');
  const seed = path.join(tmp, 'seed');
  const g = (cwd, args) => spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd, encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 'f', GIT_AUTHOR_EMAIL: 'f@test.local', GIT_COMMITTER_NAME: 'f', GIT_COMMITTER_EMAIL: 'f@test.local' },
  });
  fs.mkdirSync(seed, { recursive: true });
  g(tmp, ['init', '-q', '--bare', '-b', 'main', remote]);
  g(tmp, ['init', '-q', '-b', 'main', seed]);
  fs.writeFileSync(path.join(seed, 'README.md'), 'seed\n');
  fs.writeFileSync(path.join(seed, 'pipeline.config.json'), JSON.stringify({
    verifyCommand: 'sh tools/run-acceptance.sh', defaultBranch: 'main', frozenPaths: [], dependencies: {},
  }, null, 2));
  g(seed, ['add', '-A']);
  g(seed, ['commit', '-q', '-m', 'seed']);
  g(seed, ['remote', 'add', 'origin', remote]);
  g(seed, ['push', '-q', 'origin', 'main']);

  // The bd seam: PIPELINE_BD_CMD is node itself and this file is preloaded into EVERY node
  // child. First statement: stand aside when argv[1]'s basename is a .js script — node
  // absolutises argv[1] even when it is a bd subcommand like `update`, so the basename is the
  // only structural test that survives; a real script child always ends in .js.
  const bdStub = path.join(tmp, 'bd-stub.js');
  fs.writeFileSync(bdStub, [
    "'use strict';",
    "if (/\\.js$/i.test(String(process.argv[1] || '').replace(/\\\\/g, '/').split('/').pop())) { /* stand aside */ } else {",
    "  const sfs = require('fs');",
    "  const a = process.argv.slice(1).map((s) => String(s).replace(/\\\\/g, '/').split('/').pop());",
    "  if (a.includes('show')) {",
    '    sfs.writeSync(1, JSON.stringify([{ id: process.env.BD_ISSUE_ID, title: "t", description: "d", acceptance_criteria: "a", design: "DESIGN.md 4.7" }]));',
    "  } else { sfs.writeSync(1, '[]'); }",
    '  process.exit(0);',
    '}',
    '',
  ].join('\n'));
  // The container stand-in: a shell script on purpose (executeTask spawns bash explicitly).
  // First call: rate-limited (exit 20). Second: three attempts, two concerns, a passing verify.
  const execStub = path.join(tmp, 'exec-stub.sh');
  fs.writeFileSync(execStub, [
    '#!/bin/sh',
    'mkdir -p "$RUN_DIR"',
    'STATE="$RUN_DIR/.stub-calls"',
    'N=0; [ -f "$STATE" ] && N=$(cat "$STATE"); N=$((N+1)); echo "$N" > "$STATE"',
    'if [ "$N" -eq 1 ]; then',
    '  printf \'{"issueId":"%s","attempts":[],"rateLimitResetAt":"2026-01-01T00:00:00.000Z"}\\n\' "$ISSUE_ID" > "$RUN_DIR/status.json"',
    '  exit 20',
    'fi',
    'cat > "$RUN_DIR/status.json" <<EOF',
    '{"issueId":"$ISSUE_ID","phase":"docs","attempts":[',
    ' {"number":1,"verifierResult":"fail","timestamp":"2026-01-01T00:00:01.000Z","feedback":"ok - a\\nFAIL - b broke\\n"},',
    ' {"number":2,"verifierResult":"fail","timestamp":"2026-01-01T00:00:02.000Z","feedback":"FAIL - b broke\\n"},',
    ' {"number":3,"verifierResult":"pass","timestamp":"2026-01-01T00:00:03.000Z"}',
    '],"specConcerns":["first concern","second concern"],"changeSummary":"did the thing"}',
    'EOF',
    'printf \'{"issueId":"%s","timestamp":"2026-01-01T00:00:03.000Z","acceptance":"pass","regressions":"pass","acceptanceOutput":"ok - a\\nok - b\\n"}\\n\' "$ISSUE_ID" > "$RUN_DIR/verify.json"',
    'exit 0',
    '',
  ].join('\n'));
  const ghStub = path.join(tmp, 'gh-stub.js');
  fs.writeFileSync(ghStub, "'use strict';process.exit(0);\n");

  const saved = {};
  const set = (k, v) => { saved[k] = process.env[k]; process.env[k] = v; };
  set('PIPELINE_BD_CMD', process.execPath);
  set('NODE_OPTIONS', `--require "${bdStub.split(path.sep).join('/')}"`);
  set('BD_ISSUE_ID', 'led-1');
  set('PIPELINE_EXEC_STUB', execStub);
  set('PIPELINE_GH_CMD', `${process.execPath} "${ghStub.split(path.sep).join('/')}"`);

  const runsRoot = path.join(tmp, 'runs-root');
  const log = logmod.startRun(runsRoot, 'unit-events');
  const gate = {
    waits: 0, cycles: 0, exhausted: false,
    admit: async (id) => id !== 'led-2',
    reportLimit: async () => ({ resumed: true, cycles: 1, joined: false, exhausted: false }),
  };
  const cfg = {
    targetRepoPath: seed, targetRepoRemote: remote, image: 'unused:local',
    wallClockMinutes: 60, maxAttempts: 3, probeIntervalMinutes: 15, maxPauseCycles: 96, concurrency: 1,
  };
  let threw = null;
  let fakeLogThrew = null;
  try {
    log.info(log.trace('preflight'), 'run started (config: fixture)');
    await runmod.runOneTask(cfg, { id: 'led-1', title: 'ledger task', priority: 1 }, log, 'tok', gate);
    await runmod.runOneTask(cfg, { id: 'led-2', title: 'refused task', priority: 2 }, log, 'tok', gate);
    log.info(log.trace('preflight'), `run finished; artifacts in ${log.dir}`);
    // A6's second half: the existing fake-log seam still works.
    const fake = { info() {}, error() {}, runId: 'fake', trace: (id) => `fake/${id}`, taskDir: () => tmp, dir: tmp };
    try { await runmod.runOneTask(cfg, { id: 'led-3', title: 'fake log', priority: 2 }, fake, 'tok', gate); } catch (e) { fakeLogThrew = e; }
  } catch (e) { threw = e; } finally {
    for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
  return { log, threw, fakeLogThrew, dir: log.dir };
}

(async () => {
  if (runmod && logmod) fixture = await runFixture();
  check('the fixture run completes without throwing', !!fixture && fixture.threw === null, fixture && fixture.threw && fixture.threw.stack);

  const runLog = fixture ? (read(path.join(fixture.dir, 'run.log')) || '') : '';
  const logLines = runLog.split(/\r?\n/).filter(Boolean);
  const eventsFile = fixture ? path.join(fixture.dir, 'events.jsonl') : '';
  const eventsRaw = read(eventsFile);
  const events = (eventsRaw || '').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return { __bad: l }; } });

  // ---- A1: one twin per line, same writer, same clock ----------------------------------------
  check('A1 events.jsonl exists beside run.log', eventsRaw !== null);
  check('A1 every ledger line parses as JSON', events.length > 0 && events.every((e) => !e.__bad));
  const twins = events.filter((e) => typeof e.msg === 'string');
  check('A1 the number of events with a string msg equals the run.log line count',
    twins.length === logLines.length && logLines.length === EXPECTED_LOG.length, `${twins.length} vs ${logLines.length} (expected ${EXPECTED_LOG.length})`);
  let aligned = twins.length === logLines.length && twins.length > 0;
  for (let i = 0; aligned && i < twins.length; i++) {
    const m = LINE.exec(logLines[i]);
    const e = twins[i];
    aligned = !!m && e.ts === m[1] && e.level === m[2] && e.trace === m[3] && e.msg === m[4];
    if (!aligned) console.log(`       line ${i + 1}: ${JSON.stringify({ line: logLines[i], event: e })}`.slice(0, 400));
  }
  check('A1 for every index the event\'s ts, level, trace and msg equal the run.log line\'s — ts included', aligned);
  check('A1 a line logged with no third argument is event "log", not inferred from its prefix',
    twins.length > 0 && twins[0].event === 'log' && twins[twins.length - 1].event === 'log');

  // ---- A2: the envelope and the schema ------------------------------------------------------
  const ENVELOPE = ['data', 'event', 'issueId', 'level', 'msg', 'runId', 'trace', 'ts'];
  check('A2 every line carries exactly the eight envelope keys',
    events.length > 0 && events.every((e) => JSON.stringify(Object.keys(e).sort()) === JSON.stringify(ENVELOPE)),
    events[0] && Object.keys(events[0]).sort().join(','));
  check('A2 level is INFO or ERROR, data is an object, runId is the run id',
    events.length > 0 && events.every((e) => ['INFO', 'ERROR'].includes(e.level) && e.data && typeof e.data === 'object' && e.runId === 'unit-events'));
  check('A2 issueId is the trace tail, null for the preflight pseudo-task',
    events.length > 0 && events.every((e) => (e.trace === 'unit-events/preflight' ? e.issueId === null : e.issueId === String(e.trace).split('/').pop())));
  const schema = readJson(path.join(ROOT, 'schemas', 'events.schema.json'));
  check('A2 schemas/events.schema.json exists and is JSON', schema !== null);
  const enumOf = (schema && schema.properties && schema.properties.event && schema.properties.event.enum) || null;
  const defs = (schema && schema.$defs && schema.$defs.events) || null;
  check('A2 the schema requires the envelope keys and closes the envelope',
    !!schema && Array.isArray(schema.required) && ENVELOPE.every((k) => schema.required.includes(k)) && schema.additionalProperties === false);
  check('A2 the schema enumerates event names and describes each named event\'s data under $defs.events',
    Array.isArray(enumOf) && defs !== null && typeof defs === 'object');
  // The inline validator: required, enum, closed envelope, and data keys declared per event.
  function validate(e) {
    if (!schema || !Array.isArray(enumOf) || !defs) return false;
    if (!e || typeof e !== 'object') return false;
    for (const k of schema.required) if (!(k in e)) return false;
    for (const k of Object.keys(e)) if (!(k in schema.properties)) return false;
    if (!enumOf.includes(e.event)) return false;
    if (e.event === 'log') return Object.keys(e.data || {}).length === 0;
    const d = defs[e.event];
    if (!d || !d.properties) return false;
    for (const k of Object.keys(e.data || {})) if (!(k in d.properties)) return false;
    for (const k of (d.required || [])) if (!(k in (e.data || {}))) return false;
    return true;
  }
  check('A2 the validator accepts every fixture line', events.length > 0 && events.every(validate));
  const sample = events[1] || {};
  const noTs = { ...sample }; delete noTs.ts;
  check('A2 ...rejects a line missing ts', !validate(noTs));
  check('A2 ...rejects an unknown event name', !validate({ ...sample, event: 'bogus' }));
  check('A2 ...rejects an extra envelope key', !validate({ ...sample, extra: 1 }));

  // ---- A3: the named events, their prefixes, and their data -----------------------------------
  let P = null;
  try { P = require(path.join(ROOT, 'scripts', 'dashboard.js')).P; } catch { P = null; }
  check('A3 scripts/dashboard.js exports P', !!P && typeof P === 'object' && typeof P.starting === 'string');
  const NAMED = {
    target: 'run.target', lockHeld: 'lock.held', lockTookOver: 'lock.tookOver', readyQueue: 'queue.read',
    starting: 'task.started', workspaceReady: 'workspace.ready', launching: 'container.launched',
    containerRan: 'container.ran', rateLimitHit: 'task.rateLimited', parkOpen: 'park.opened',
    parkReopen: 'park.reopened', paused: 'park.waiting', taskFinished: 'task.finished',
    runFinished: 'run.finished', refused: 'task.refused', relaunching: 'task.relaunched',
    feedOn: 'feed.on', feedPickedUp: 'feed.pickedUp', feedClosed: 'feed.closed',
  };
  check('A3 every named event is in the schema\'s enum', Array.isArray(enumOf) && Object.values(NAMED).every((n) => enumOf.includes(n)) && enumOf.includes('log'));
  const byEvent = (name) => events.filter((e) => e.event === name);
  const reached = [
    ['starting', (d) => d.priority === 1 && d.title === 'ledger task'],
    ['workspaceReady', (d) => typeof d.dir === 'string' && d.branch === 'task/led-1' && /^[0-9a-f]{8,40}$/.test(String(d.forkPoint))],
    ['rateLimitHit', (d) => d.pause === 1],
    ['relaunching', (d) => Object.keys(d).length === 0],
    ['taskFinished', (d) => d.exitCode === 0 && d.outcome === 'done' && d.beads === 'closed'],
    ['refused', (d) => Object.keys(d).length === 0],
  ];
  for (const [key, want] of reached) {
    const name = NAMED[key];
    const got = byEvent(name);
    check(`A3 ${name} is emitted once, with msg starting with the dashboard's prefix, and its data pinned`,
      got.length === 1 && !!P && typeof P[key] === 'string' && String(got[0].msg).startsWith(P[key]) && want(got[0].data || {}),
      JSON.stringify(got[0] || null));
  }

  // ---- A4: append-only, one object per line, crash-safe prefix --------------------------------
  {
    const root = path.join(TMP, 'a4');
    const log = logmod ? logmod.startRun(root, 'unit-events-a4') : null;
    let size25 = 0; let size50 = 0;
    const sizeOf = (p) => { try { return fs.statSync(p).size; } catch { return 0; } };
    if (log) {
      for (let i = 1; i <= 50; i++) {
        log.info(log.trace('t'), `line ${i}`);
        if (i === 25) size25 = sizeOf(path.join(log.dir, 'events.jsonl'));
      }
      size50 = sizeOf(path.join(log.dir, 'events.jsonl'));
    }
    const raw = log ? (read(path.join(log.dir, 'events.jsonl')) || '') : '';
    const lines = raw.split('\n');
    check('A4 fifty calls produce fifty lines, each JSON, with one trailing newline and no \\r',
      raw.endsWith('\n') && !raw.endsWith('\n\n') && !/\r/.test(raw) && lines.filter(Boolean).length === 50 && lines.filter(Boolean).every((l) => { try { JSON.parse(l); return true; } catch { return false; } }));
    check('A4 the file only grows between calls (no rewrite)', size25 > 0 && size50 > size25);
    // Truncate at the midpoint of line 30's byte range; every line before the last newline parses.
    if (log) {
      const buf = Buffer.from(raw, 'utf8');
      let offset = 0;
      for (let i = 0; i < 29; i++) offset += Buffer.byteLength(lines[i] + '\n', 'utf8');
      const cut = offset + Math.floor(Buffer.byteLength(lines[29] + '\n', 'utf8') / 2);
      const truncated = buf.slice(0, cut).toString('utf8');
      const complete = truncated.slice(0, truncated.lastIndexOf('\n') + 1).split('\n').filter(Boolean);
      check('A4 a file cut mid-line leaves a parseable prefix of 29 lines',
        complete.length === 29 && complete.every((l) => { try { JSON.parse(l); return true; } catch { return false; } }));
    } else check('A4 startRun is available', false);
  }

  // ---- A5: run.log is byte-for-byte what it was ------------------------------------------------
  const masked = logLines.map((l) => { const m = LINE.exec(l); return m ? `${m[2]} [${m[3]}] ${mask(m[4])}` : l; });
  let sameLog = masked.length === EXPECTED_LOG.length;
  for (let i = 0; sameLog && i < masked.length; i++) { sameLog = masked[i] === EXPECTED_LOG[i]; if (!sameLog) console.log(`       line ${i + 1}: got ${JSON.stringify(masked[i])}\n       expected ${JSON.stringify(EXPECTED_LOG[i])}`); }
  check('A5 the fixture run\'s run.log equals the recorded expectation, every line, line count included', sameLog);
  {
    const cfgFile = readJson(path.join(ROOT, 'pipeline.config.json')) || {};
    const integration = cfgFile.defaultBranch || 'main';
    const base = (spawnSync('git', ['merge-base', integration, 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout || '').trim();
    const diff = base ? (spawnSync('git', ['diff', `${base}..HEAD`, '--', 'runner/'], { cwd: ROOT, encoding: 'utf8' }).stdout || '') : null;
    const removed = diff === null ? null : diff.split('\n').filter((l) => /^-(?!--)/.test(l) && /log\.(info|error)\(/.test(l));
    check('A5 no log.info( or log.error( line under runner/ is removed since the fork point', removed !== null && removed.length === 0, removed && removed.slice(0, 3).join(' | '));
    const readers = base ? (spawnSync('git', ['diff', '--name-only', `${base}..HEAD`, '--', 'tests/unit/dashboard.test.js', 'tests/unit/batch.test.js', 'tests/unit/audit-runs.test.js'], { cwd: ROOT, encoding: 'utf8' }).stdout || '').trim() : 'unknown';
    check('A5 the three reader suites are byte-identical to the fork point', readers === '');
  }
  {
    const wrapper = path.join(ROOT, 'scripts', 'test-events.sh');
    check('A5 scripts/test-events.sh exists', fs.existsSync(wrapper));
    const r = fs.existsSync(wrapper) ? spawnSync('bash', [wrapper], { cwd: ROOT, encoding: 'utf8', env: scrubbedEnv() }) : { status: -1, stdout: '' };
    check('A5 scripts/test-events.sh exits 0 (it runs the unit suite and the reader suites with a scrubbed environment)', r.status === 0,
      (r.stdout || '').split('\n').filter((l) => /FAIL/.test(l)).slice(0, 3).join(' | '));
  }

  // ---- A6: the container never writes an event; the fake-log seam still works --------------------
  {
    const hits = [];
    (function visit(d) {
      for (const n of fs.readdirSync(d)) {
        const p = path.join(d, n);
        if (fs.statSync(p).isDirectory()) visit(p);
        else if (/events\.jsonl|runner\/log/.test(read(p) || '')) hits.push(path.relative(ROOT, p));
      }
    }(path.join(ROOT, 'pipeline')));
    check('A6 nothing under pipeline/ references the ledger or runner/log', hits.length === 0, hits.join(', '));
    check('A6 runOneTask driven with the existing fake log object still completes', !!fixture && fixture.fakeLogThrew === null, fixture && fixture.fakeLogThrew && fixture.fakeLogThrew.message);
  }

  // ---- A7: the documents ---------------------------------------------------------------------
  check('A7 DESIGN.md names events.jsonl', (read(path.join(ROOT, 'DESIGN.md')) || '').includes('events.jsonl'));
  check('A7 docs/change-log.md has a row for repo-qzy', /\|\s*repo-qzy\s*\|/.test(read(path.join(ROOT, 'docs', 'change-log.md')) || ''));
  check('A7 docs/pipeline-diagram.md names events.jsonl', (read(path.join(ROOT, 'docs', 'pipeline-diagram.md')) || '').includes('events.jsonl'));
  check('A7 CLAUDE.md lists bash scripts/test-events.sh', (read(path.join(ROOT, 'CLAUDE.md')) || '').includes('bash scripts/test-events.sh'));
  check('A7 tests/unit/events.test.js exists', fs.existsSync(path.join(ROOT, 'tests', 'unit', 'events.test.js')));

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* temp */ }
  process.exit(failed);
})().catch((e) => { console.log(`FAIL - the suite itself threw: ${e && e.stack}`); process.exit(1); });
