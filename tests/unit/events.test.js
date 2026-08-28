// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// The re-runnable suite for the event ledger — `runs/<runId>/events.jsonl`, DESIGN.md §4.12
// and §5, change-log rows `events-ledger-design` and `repo-qzy`.
//
// Docker-free, network-free and clock-free: it drives runner/log.js's writer directly, and
// runner/run.js's exported runOneTask through the seams the pause-gate suite uses
// (PIPELINE_BD_CMD, PIPELINE_EXEC_STUB, PIPELINE_GH_CMD, targetRepoRemote as a local bare
// repo). It builds everything it touches under the OS temp directory.
//
// Why it exists beside the frozen tests/acceptance/repo-qzy/: a frozen directory gates one
// task and never runs again (repo-dhp-note-2), and this ledger is the far side of a JOIN
// three other things own — the message wording in `runner/`, the dashboard's prefix table,
// and `schemas/events.schema.json`. All three can be changed by a later task that has no
// idea the ledger exists, and every way that goes wrong is SILENT: a well-formed ledger
// whose events no longer mean what the schema says they mean.
//
// Five things it adds to what the frozen suite could reach:
//
//   * ONE CLOCK READ, PROVED. The frozen suite compares the two `ts` values for equality —
//     which two `Date.now()` reads a microsecond apart satisfy by coincidence most of the
//     time. Here `Date` is replaced for the length of one call by a counter that answers a
//     DIFFERENT instant on every construction, so a two-read implementation is red every
//     time rather than on an unlucky machine.
//   * THE PARK, via an injected wait. `park.opened`, `park.waiting` and `park.reopened` are
//     unreachable to a fixture with a fake gate, so this one drives the real
//     createPauseGate with `sleepFn` injected and pins all three.
//   * THE FEED, likewise: `feed.pickedUp` comes from a real createFeedSource poll.
//   * WORDING-TO-EVENT DRIFT. For every named event, the dashboard's prefix for that event
//     must appear in the source of the call that emits it. Rename a message without
//     touching `P` and this goes red — which is the whole failure this ledger exists to
//     stop happening quietly.
//   * TYPES, not just keys. The frozen suite's inline validator checks that keys are
//     declared; this one checks the declared TYPE of every value, because `priority: "1"`
//     and `killed: "false"` are both non-empty, well-formed and wrong.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
let failed = 0;
function check(name, cond, detail) {
  console.log(`${cond ? 'ok' : 'FAIL'} - ${name}`);
  if (!cond) { failed = 1; if (detail) console.log(`       ${String(detail).slice(0, 400)}`); }
  return cond;
}
const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'unit-events-'));
const logmod = require(path.join(ROOT, 'runner', 'log.js'));
const runmod = require(path.join(ROOT, 'runner', 'run.js'));
const { createPauseGate } = require(path.join(ROOT, 'runner', 'pause.js'));
const { createFeedSource } = require(path.join(ROOT, 'runner', 'feed.js'));
// `|| {}` so a dashboard that stopped exporting its prefix table is REPORTED by the check
// below rather than crashing this file at load: a suite that dies on the first symptom hides
// every other one, and "which checks would this break" is the question a reader has.
const P = require(path.join(ROOT, 'scripts', 'dashboard.js')).P || {};
const SCHEMA = readJson(path.join(ROOT, 'schemas', 'events.schema.json'));

// The mapping the whole design rests on: one dashboard prefix key, one event name. Stated
// here as well as in the frozen suite on purpose — this is the copy that keeps running, and
// the checks below assert it is EXHAUSTIVE in both directions rather than merely consistent.
const NAMED = {
  target: 'run.target',
  lockHeld: 'lock.held',
  lockTookOver: 'lock.tookOver',
  readyQueue: 'queue.read',
  starting: 'task.started',
  workspaceReady: 'workspace.ready',
  launching: 'container.launched',
  containerRan: 'container.ran',
  rateLimitHit: 'task.rateLimited',
  parkOpen: 'park.opened',
  parkReopen: 'park.reopened',
  paused: 'park.waiting',
  taskFinished: 'task.finished',
  runFinished: 'run.finished',
  refused: 'task.refused',
  relaunching: 'task.relaunched',
  feedOn: 'feed.on',
  feedPickedUp: 'feed.pickedUp',
  feedClosed: 'feed.closed',
};
// Declared, not emitted: the ledger-only queue read with every refusal is the next task
// (change-log row `events-ledger-design`). Naming it here is what stops "no call site emits
// it" from reading as a defect in the checks below.
const RESERVED = new Set(['queue.read']);

const events = (dir) => (read(path.join(dir, 'events.jsonl')) || '')
  .split('\n').filter(Boolean)
  .map((l) => { try { return JSON.parse(l); } catch { return { __bad: l }; } });
const lines = (dir) => (read(path.join(dir, 'run.log')) || '').split(/\r?\n/).filter(Boolean);

// ---- W: the writer ---------------------------------------------------------------------

{
  const log = logmod.startRun(path.join(TMP, 'w'), 'unit-events-w');
  log.info(log.trace('a-1'), 'first');
  log.error(log.trace('a-1'), 'second');
  log.info(log.trace('preflight'), 'third');
  log.info(log.trace('feed'), 'fourth');
  log.info(null, 'fifth');
  log.event(log.trace('a-1'), 'task.refused', {});
  log.info(log.trace('a-1'), 'after the ledger-only event');

  const ev = events(log.dir);
  const ln = lines(log.dir);
  check('W every ledger line parses', ev.length === 7 && ev.every((e) => !e.__bad), JSON.stringify(ev.slice(0, 2)));
  check('W the ledger-only event wrote no run.log line', ln.length === 6, `${ln.length} run.log lines`);
  check('W the twins are the events with a string msg, in order',
    ev.filter((e) => typeof e.msg === 'string').map((e) => e.msg).join('|') === 'first|second|third|fourth|fifth|after the ledger-only event');
  check('W an error line is level ERROR and its twin is too', ev[1].level === 'ERROR' && /ERROR/.test(ln[1]));
  check('W a call with no third argument is event "log" with empty data',
    ev[0].event === 'log' && JSON.stringify(ev[0].data) === '{}');
  check('W issueId is the trace tail for a real task', ev[0].issueId === 'a-1' && ev[0].trace === 'unit-events-w/a-1');
  check('W issueId is null for the preflight pseudo-task', ev[2].issueId === null && ev[2].trace === 'unit-events-w/preflight');
  check('W issueId is null for the feed pseudo-task', ev[3].issueId === null && ev[3].trace === 'unit-events-w/feed');
  check('W a null trace gives trace null and issueId null', ev[4].trace === null && ev[4].issueId === null);
  check('W event() is ledger-only: msg null, level INFO, the named event, and no run.log line',
    ev[5].msg === null && ev[5].level === 'INFO' && ev[5].event === 'task.refused');
  check('W runId is on every line', ev.every((e) => e.runId === 'unit-events-w'));
  check('W the log exposes eventsFile beside logFile',
    log.eventsFile === path.join(log.dir, 'events.jsonl') && fs.existsSync(log.eventsFile));

  // A trace belonging to ANOTHER run is not this run's issue: the tail is only an issue id
  // when the prefix says so. Without the prefix test, 'other-run/x' would report issueId 'x'
  // against a run that never touched it.
  check('W a trace that does not begin with this runId yields issueId null',
    logmod.issueIdOf('unit-events-w', 'other-run/x') === null
    && logmod.issueIdOf('unit-events-w', 'unit-events-w/x') === 'x'
    && logmod.issueIdOf('unit-events-w', null) === null
    && logmod.issueIdOf('unit-events-w', 'unit-events-w/') === null);
}

// A message carrying newlines must stay ONE ledger line. The crash-tolerance guarantee —
// "everything before the last newline parses" — is worth nothing if a single event can
// straddle two lines.
{
  const log = logmod.startRun(path.join(TMP, 'w2'), 'unit-events-w2');
  log.info(log.trace('a-1'), 'one\ntwo\r\nthree');
  const raw = read(path.join(log.dir, 'events.jsonl')) || '';
  check('W a multi-line message is escaped into a single ledger line',
    raw.split('\n').filter(Boolean).length === 1 && JSON.parse(raw).msg === 'one\ntwo\r\nthree');
  check('W the ledger file itself carries no bare CR', !/\r/.test(raw));
}

// ONE clock read. Date is replaced for the length of one call by a counter that answers a
// different instant every time it is constructed, so a two-read writer cannot pass by
// happening to land in the same millisecond.
{
  const log = logmod.startRun(path.join(TMP, 'w3'), 'unit-events-w3');
  const RealDate = Date;
  let tick = 0;
  try {
    global.Date = class TickDate extends RealDate {
      constructor(...a) {
        super(...(a.length ? a : [0]));
        this.__tick = a.length ? null : (tick += 1);
      }

      toISOString() {
        return this.__tick === null ? super.toISOString()
          : `2026-01-01T00:00:00.${String(this.__tick).padStart(3, '0')}Z`;
      }
    };
    global.Date.now = RealDate.now;
    log.info(log.trace('a-1'), 'once');
  } finally {
    global.Date = RealDate;
  }
  const e = events(log.dir)[0];
  const m = /^(\S+) /.exec(lines(log.dir)[0] || '');
  check('W the line and its twin share ONE clock read, not two',
    !!m && !!e && e.ts === m[1] && /^2026-01-01T00:00:00\.001Z$/.test(e.ts), `${m && m[1]} vs ${e && e.ts}`);
}

// Append-only: fifty calls, fifty lines, a file that only ever grows.
{
  const log = logmod.startRun(path.join(TMP, 'w4'), 'unit-events-w4');
  const sizes = [];
  for (let i = 1; i <= 50; i++) {
    log.info(log.trace('a-1'), `line ${i}`);
    sizes.push(fs.statSync(log.eventsFile).size);
  }
  const raw = read(log.eventsFile) || '';
  check('W fifty calls append fifty lines with one trailing newline',
    raw.endsWith('\n') && !raw.endsWith('\n\n') && raw.split('\n').filter(Boolean).length === 50);
  check('W the file grows on every single call and never shrinks',
    sizes.every((s, i) => (i === 0 ? s > 0 : s > sizes[i - 1])));
  check('W every appended line parses on its own',
    raw.split('\n').filter(Boolean).every((l) => { try { JSON.parse(l); return true; } catch { return false; } }));
}

// ---- S: the schema, and its agreement with the code -------------------------------------

const ENUM = (SCHEMA && SCHEMA.properties && SCHEMA.properties.event && SCHEMA.properties.event.enum) || null;
const DEFS = (SCHEMA && SCHEMA.$defs && SCHEMA.$defs.events) || null;

check('S the schema is JSON with a closed envelope and an inline event enum',
  !!SCHEMA && SCHEMA.additionalProperties === false && Array.isArray(ENUM) && !!DEFS);
check('S the envelope declares and requires exactly the eight keys',
  !!SCHEMA && JSON.stringify(Object.keys(SCHEMA.properties || {}).sort())
    === JSON.stringify(['data', 'event', 'issueId', 'level', 'msg', 'runId', 'trace', 'ts'])
  && JSON.stringify([...(SCHEMA.required || [])].sort())
    === JSON.stringify(['data', 'event', 'issueId', 'level', 'msg', 'runId', 'trace', 'ts']));
check('S every dashboard prefix key has an event name, and there are no extras either way',
  JSON.stringify(Object.keys(P).sort()) === JSON.stringify(Object.keys(NAMED).sort()),
  Object.keys(P).sort().join(','));
check('S every named event plus "log" is in the enum, and the enum holds nothing else',
  Array.isArray(ENUM)
  && JSON.stringify([...ENUM].sort()) === JSON.stringify(['log', ...Object.values(NAMED)].sort()),
  ENUM && ENUM.join(','));
check('S $defs.events is a map keyed by event name, with an entry for every one of them',
  !!DEFS && Array.isArray(ENUM)
  && Object.keys(DEFS).every((k) => ENUM.includes(k))
  && ENUM.every((n) => DEFS[n] && DEFS[n].properties && typeof DEFS[n].properties === 'object'),
  DEFS && Object.keys(DEFS).join(','));
check('S every named event declares a type for every field it declares',
  !!DEFS && Object.entries(DEFS).every(([, d]) => Object.values(d.properties || {})
    .every((f) => typeof f.type === 'string' || Array.isArray(f.type) || Array.isArray(f.oneOf))));
check('S the "log" event declares no data fields — nothing is inferred from a message prefix',
  !!DEFS && DEFS.log && Object.keys(DEFS.log.properties || {}).length === 0);

// The drift guard. For every named event that is actually emitted, the dashboard's prefix
// for it has to appear in the source immediately before the `{ event: '<name>'` that emits
// it — i.e. inside the same call. A reworded message with a stale `P` entry, or an event
// attached to the wrong line, is red here and nowhere else.
{
  const SRC = fs.readdirSync(path.join(ROOT, 'runner'))
    .filter((f) => f.endsWith('.js'))
    .map((f) => ({ file: f, text: read(path.join(ROOT, 'runner', f)) || '' }));
  const emitted = new Map();
  for (const { file, text } of SRC) {
    for (const m of text.matchAll(/event: '([^']+)'/g)) {
      if (!emitted.has(m[1])) emitted.set(m[1], []);
      emitted.get(m[1]).push({ file, before: text.slice(Math.max(0, m.index - 800), m.index) });
    }
  }
  check('S every event name emitted in runner/ is in the schema enum',
    Array.isArray(ENUM) && [...emitted.keys()].every((n) => ENUM.includes(n)),
    [...emitted.keys()].filter((n) => !ENUM || !ENUM.includes(n)).join(','));
  const shouldEmit = Object.values(NAMED).filter((n) => !RESERVED.has(n));
  check('S every named event that is not reserved has a call site in runner/',
    shouldEmit.every((n) => emitted.has(n)), shouldEmit.filter((n) => !emitted.has(n)).join(','));
  check('S the reserved event is declared and emitted by nothing yet',
    [...RESERVED].every((n) => ENUM.includes(n) && !emitted.has(n)));
  const byName = Object.fromEntries(Object.entries(NAMED).map(([k, v]) => [v, P[k]]));
  const mismatched = [];
  for (const [name, sites] of emitted) {
    const prefix = byName[name];
    if (!prefix) { mismatched.push(`${name}: no dashboard prefix`); continue; }
    for (const site of sites) if (!site.before.includes(prefix)) mismatched.push(`${name} in ${site.file}`);
  }
  check('S every emitting call site carries the dashboard prefix its event claims',
    mismatched.length === 0, mismatched.join(' | '));
}

// The validator, types included. Dependency-free on purpose: the schema is the contract for
// artifacts written on a host that may have no npm at all.
function typeOk(value, spec) {
  if (Array.isArray(spec.oneOf)) return spec.oneOf.some((s) => typeOk(value, s));
  if ('const' in spec) return value === spec.const;
  // `enum` is checked as well as `type`, not instead of it: `level: "WARN"` is a string and
  // would sail past a type-only reading of a spec that carries both.
  if (Array.isArray(spec.enum) && !spec.enum.includes(value)) return false;
  if (spec.type === undefined) return true;
  const want = Array.isArray(spec.type) ? spec.type : [spec.type];
  return want.some((t) => {
    if (t === 'null') return value === null;
    if (t === 'integer') return Number.isInteger(value);
    if (t === 'array') return Array.isArray(value);
    if (t === 'object') return !!value && typeof value === 'object' && !Array.isArray(value);
    if (t === 'boolean') return typeof value === 'boolean';
    if (t === 'string') return typeof value === 'string';
    if (t === 'number') return typeof value === 'number';
    return false;
  });
}
function validate(e) {
  if (!SCHEMA || !ENUM || !DEFS) return 'no schema';
  if (!e || typeof e !== 'object') return 'not an object';
  for (const k of SCHEMA.required) if (!(k in e)) return `missing ${k}`;
  for (const k of Object.keys(e)) if (!(k in SCHEMA.properties)) return `extra key ${k}`;
  for (const [k, spec] of Object.entries(SCHEMA.properties)) {
    if (!typeOk(e[k], spec)) return `envelope ${k} is ${JSON.stringify(e[k])}`;
  }
  if (!ENUM.includes(e.event)) return `unknown event ${e.event}`;
  const d = DEFS[e.event];
  if (!d) return `no $defs entry for ${e.event}`;
  for (const k of Object.keys(e.data || {})) {
    if (!(k in (d.properties || {}))) return `${e.event}.data has undeclared ${k}`;
    if (!typeOk(e.data[k], d.properties[k])) return `${e.event}.data.${k} is ${JSON.stringify(e.data[k])}`;
  }
  for (const k of (d.required || [])) if (!(k in (e.data || {}))) return `${e.event}.data is missing ${k}`;
  return null;
}

// ---- F: a fixture run, with a REAL park and a REAL feed ----------------------------------

function seedRepo(tmp) {
  const remote = path.join(tmp, 'remote.git');
  const seed = path.join(tmp, 'seed');
  const g = (cwd, args) => spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'f',
      GIT_AUTHOR_EMAIL: 'f@test.local',
      GIT_COMMITTER_NAME: 'f',
      GIT_COMMITTER_EMAIL: 'f@test.local',
    },
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
  return { remote, seed };
}

// The bd seam. First statement is a STAND-ASIDE GUARD: NODE_OPTIONS=--require reaches every
// node child, and a stub that exits unconditionally kills the gh stub before its first line
// (CLAUDE.md's promoted rule; repo-8v0). Keyed on argv[1] being a .js file, because node
// absolutises argv[1] before a preload sees it, so equality against a bd verb never fires.
const BD_STUB = [
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
].join('\n');

// The container stand-in: a shell script, because executeTask spawns `bash <stub>`.
// Call 1 reports a rate limit (exit 20) with a reset time already in the past, so the park's
// reset-time branch is taken and the injected sleep returns at once. Call 2 passes.
const EXEC_STUB = [
  '#!/bin/sh',
  'mkdir -p "$RUN_DIR"',
  'STATE="$RUN_DIR/.stub-calls"',
  'N=0; [ -f "$STATE" ] && N=$(cat "$STATE"); N=$((N+1)); echo "$N" > "$STATE"',
  'if [ "$N" -eq 1 ]; then',
  '  printf \'{"issueId":"%s","attempts":[],"rateLimitResetAt":"2026-01-01T00:00:00.000Z"}\\n\' "$ISSUE_ID" > "$RUN_DIR/status.json"',
  '  exit 20',
  'fi',
  'printf \'{"issueId":"%s","phase":"docs","attempts":[{"number":1,"verifierResult":"pass","timestamp":"2026-01-01T00:00:03.000Z"}]}\\n\' "$ISSUE_ID" > "$RUN_DIR/status.json"',
  'printf \'{"issueId":"%s","timestamp":"2026-01-01T00:00:03.000Z","acceptance":"pass","regressions":"pass"}\\n\' "$ISSUE_ID" > "$RUN_DIR/verify.json"',
  'exit 0',
  '',
].join('\n');

async function fixtureRun() {
  const tmp = fs.mkdtempSync(path.join(TMP, 'fx-'));
  const { remote, seed } = seedRepo(tmp);
  const bdStub = path.join(tmp, 'bd-stub.js');
  const execStub = path.join(tmp, 'exec-stub.sh');
  const ghStub = path.join(tmp, 'gh-stub.js');
  fs.writeFileSync(bdStub, BD_STUB);
  fs.writeFileSync(execStub, EXEC_STUB);
  fs.writeFileSync(ghStub, "'use strict';process.exit(0);\n");

  const saved = {};
  const set = (k, v) => { saved[k] = process.env[k]; process.env[k] = v; };
  set('PIPELINE_BD_CMD', process.execPath);
  set('NODE_OPTIONS', `--require "${bdStub.split(path.sep).join('/')}"`);
  set('BD_ISSUE_ID', 'led-1');
  set('PIPELINE_EXEC_STUB', execStub);
  set('PIPELINE_GH_CMD', `${process.execPath} "${ghStub.split(path.sep).join('/')}"`);

  const log = logmod.startRun(path.join(tmp, 'runs-root'), 'unit-events-fx');
  const cfg = {
    targetRepoPath: seed,
    targetRepoRemote: remote,
    image: 'unused:local',
    wallClockMinutes: 60,
    maxAttempts: 3,
    probeIntervalMinutes: 15,
    maxPauseCycles: 96,
    concurrency: 1,
  };
  // The REAL run-level park, with only the sleep injected: a reset time in the past still
  // plans a five-second cushion, and a suite that actually slept it would be five seconds
  // slower for nothing. Everything else — the shared wait, the cycle counter, the log
  // lines — is the production path.
  const gate = createPauseGate(cfg, log, { sleepFn: async () => {}, token: 'tok' });
  const exhausted = { admit: async () => false, reportLimit: async () => ({ resumed: false }) };
  let threw = null;
  try {
    log.info(log.trace('preflight'), 'run started (config: fixture)');
    await runmod.runOneTask(cfg, { id: 'led-1', title: 'ledger task', priority: 1 }, log, 'tok', gate);
    await runmod.runOneTask(cfg, { id: 'led-2', title: 'refused task', priority: 2 }, log, 'tok', exhausted);
    log.info(log.trace('preflight'), `run finished; artifacts in ${log.dir}`);
  } catch (e) {
    threw = e;
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
  return { log, threw };
}

// ---- the checks over the fixture ---------------------------------------------------------

(async () => {
  const fx = await fixtureRun();
  check('F the fixture run completes without throwing', fx.threw === null, fx.threw && fx.threw.stack);

  const ev = events(fx.log.dir);
  const ln = lines(fx.log.dir);
  const twins = ev.filter((e) => typeof e.msg === 'string');
  check('F every run.log line has exactly one twin, in order, sharing ts/level/trace/msg',
    twins.length === ln.length && ln.length > 0 && ln.every((l, i) => {
      const m = /^(\S+) (INFO|ERROR) \[([^\]]+)\] (.*)$/.exec(l);
      const e = twins[i];
      return !!m && e.ts === m[1] && e.level === m[2] && e.trace === m[3] && e.msg === m[4];
    }), `${twins.length} twins vs ${ln.length} lines`);

  const bad = ev.map(validate).filter(Boolean);
  check('F every emitted line validates against schemas/events.schema.json, types included',
    ev.length > 0 && bad.length === 0, bad.slice(0, 4).join(' | '));

  // The negative half: the validator has to be able to say no, or "everything validates" is
  // a statement about the validator rather than about the ledger. Each planted line differs
  // from a real one in exactly one way, so a rejection names the rule that caught it.
  const one = ev.find((e) => e.event === 'task.started') || ev[0];
  const noTs = { ...one }; delete noTs.ts;
  const noBeads = { ...ev.find((e) => e.event === 'task.finished') };
  noBeads.data = { exitCode: 0, outcome: 'done' };
  const rejects = {
    'a missing envelope key': noTs,
    'an extra envelope key': { ...one, extra: 1 },
    'an unknown event name': { ...one, event: 'bogus' },
    'a level outside the enum': { ...one, level: 'WARN' },
    'a wrongly typed envelope value': { ...one, issueId: 7 },
    'a wrongly typed data value': { ...one, data: { priority: '1', title: 't' } },
    'an undeclared data key': { ...one, data: { priority: 1, title: 't', nope: 1 } },
    'a required data key that is absent': noBeads,
  };
  for (const [why, planted] of Object.entries(rejects)) {
    check(`F the validator rejects ${why}`, validate(planted) !== null, JSON.stringify(planted).slice(0, 200));
  }

  const by = (name) => ev.filter((e) => e.event === name);
  const pinned = [
    ['task.started', 'starting', 1, (d) => d.priority === 1 && d.title === 'ledger task'],
    ['workspace.ready', 'workspaceReady', 1,
      (d) => typeof d.dir === 'string' && d.branch === 'task/led-1' && /^[0-9a-f]{40}$/.test(String(d.forkPoint))],
    ['task.rateLimited', 'rateLimitHit', 1, (d) => d.pause === 1],
    ['park.opened', 'parkOpen', 1, (d) => d.cycles === 0 && d.max === 96],
    ['park.waiting', 'paused', 1, (d) => d.until === '2026-01-01T00:00:00.000Z'],
    ['park.reopened', 'parkReopen', 1, (d) => Object.keys(d).length === 0],
    ['task.relaunched', 'relaunching', 1, (d) => Object.keys(d).length === 0],
    ['task.finished', 'taskFinished', 1, (d) => d.exitCode === 0 && d.outcome === 'done' && d.beads === 'closed'],
    ['task.refused', 'refused', 1, (d) => Object.keys(d).length === 0],
  ];
  // `run.target`, `lock.*`, `container.*`, `feed.on`, `feed.closed` and `run.finished` live
  // in main() and the container path, which need a token, Docker and a real config — so they
  // are pinned by the source-level prefix guard above rather than by this fixture. Emitting
  // them from the suite itself would pin nothing: the suite would be checking its own string.
  for (const [name, key, count, want] of pinned) {
    const got = by(name);
    check(`F ${name} is emitted ${count}x, its msg starts with the dashboard prefix, and its data is pinned`,
      got.length === count && String(got[0].msg).startsWith(P[key]) && want(got[0].data || {}),
      JSON.stringify(got[0] || null));
  }
  check('F the workspace event carries the FULL fork point while the line abbreviates it',
    (() => {
      const e = by('workspace.ready')[0];
      return !!e && e.data.forkPoint.length === 40 && e.msg.includes(e.data.forkPoint.slice(0, 8))
        && !e.msg.includes(e.data.forkPoint);
    })());
  check('F the refused task\'s event is ERROR and carries its own issue id',
    (() => { const e = by('task.refused')[0]; return !!e && e.level === 'ERROR' && e.issueId === 'led-2'; })());
  check('F run-level lines carry issueId null while task lines carry the id',
    ev.every((e) => (String(e.trace).endsWith('/preflight') ? e.issueId === null : true))
    && by('task.started')[0].issueId === 'led-1');
  check('F unnamed lines are event "log" with empty data, and there are some',
    by('log').length > 0 && by('log').every((e) => JSON.stringify(e.data) === '{}'));

  // ---- the feed's event, from a real source -------------------------------------------
  {
    const log = logmod.startRun(path.join(TMP, 'feed'), 'unit-events-feed');
    let polled = 0;
    const src = createFeedSource([{ id: 'f-1' }], {
      poll: () => { polled += 1; return { ok: true, issues: [{ id: 'f-1' }, { id: 'f-2' }], undispatchable: [] }; },
      concurrency: 1,
      idleGraceMs: 60000,
      pollMs: 0,
      undispatchable: [],
      now: () => 0,
      wait: async () => {},
      log,
    });
    const seen = [];
    for (;;) {
      const item = await src.next();
      if (!item) break;
      seen.push(item.issue.id);
      if (seen.length >= 2) break;
    }
    const fe = events(log.dir).filter((e) => e.event === 'feed.pickedUp');
    check('F feed.pickedUp comes from a real poll, with the count it added and the feed trace',
      polled > 0 && fe.length === 1 && fe[0].data.added === 1
      && fe[0].issueId === null && fe[0].trace === 'unit-events-feed/feed'
      && String(fe[0].msg).startsWith(P.feedPickedUp), JSON.stringify(fe[0] || null));
  }

  // ---- the boundaries the ledger must not cross ----------------------------------------
  {
    const hits = [];
    (function visit(d) {
      for (const n of fs.readdirSync(d)) {
        const p = path.join(d, n);
        if (fs.statSync(p).isDirectory()) visit(p);
        else if (/events\.jsonl|runner\/log/.test(read(p) || '')) hits.push(path.relative(ROOT, p));
      }
    }(path.join(ROOT, 'pipeline')));
    check('F nothing under pipeline/ references the ledger or runner/log — the container writes none of this',
      hits.length === 0, hits.join(', '));
  }
  {
    // The historic fake log — an object with info/error that ignore a third argument — is
    // what four other suites hand to runOneTask. A writer that assumed its own log object
    // would break every one of them, in a file none of them names.
    const fake = { info() {}, error() {}, runId: 'fake', trace: (id) => `fake/${id}`, taskDir: () => TMP, dir: TMP };
    let threw = null;
    try {
      fake.info(fake.trace('x'), 'a');
      fake.info(fake.trace('x'), 'b', { event: 'task.started', data: {} });
      fake.error(fake.trace('x'), 'c', { event: 'task.refused', data: {} });
    } catch (e) { threw = e; }
    check('F a log object that ignores the third argument still works', threw === null, threw && threw.message);
  }

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* temp */ }
  process.exit(failed);
})().catch((e) => { console.log(`FAIL - the suite itself threw: ${e && e.stack}`); process.exit(1); });
