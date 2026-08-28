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
//     declared; this one checks the declared TYPE of every value — and, since change-log row
//     `repo-3xw`, the declared type of every ARRAY ITEM, because `queue.read`'s whole
//     contract is that `ready` holds ids and never issue objects, and a reader that stops at
//     "it is an array" makes the schema's `items` decoration rather than a rule.
//
// Change-log row `repo-3xw` added the three facts no other artifact carries, and with them
// three shapes of coverage a fixture run cannot reach on its own:
//
//   * THE QUEUE READ AND ITS REFUSALS, through `runner/queue.js`'s exported emitters. `main()`
//     writes them and `main()` sits behind the token load and the Docker preflight, so the
//     helpers are the only reachable form — which is why they are helpers.
//   * THE ATTEMPT TRICHOTOMY, driven directly. `[]`, a list and `null` are three facts, and a
//     container writes ONE status file per task, so the shapes are planted rather than run.
//     The expensive confusion is the third read as the first: an attempt that failed and whose
//     output did not survive is not an attempt that failed nothing.
//   * THE COLON FORM'S ONE-SIDEDNESS. `failingChecks` recognises `FAIL: <text>` and
//     `countAssertions` must not, or every sweep number that has been stable since change-log
//     row `repo-0ay` moves as a side effect.
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
  undispatched: 'task.undispatched',
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
// LEDGER-ONLY events (change-log row `repo-3xw`): facts with no prose form, emitted through
// `log.event()` with `msg: null` and never echoed. They are in the schema enum and they are
// deliberately NOT in `NAMED` above, because `NAMED` is the prose-line map — a dashboard
// prefix for an event that writes no line would be a prefix that matches nothing forever.
// The two structures are asserted exhaustive together further down, so an event cannot fall
// between them.
const LEDGER_ONLY = ['attempt.finished', 'concern.raised'];

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
check('S every named and ledger-only event plus "log" is in the enum, and the enum holds nothing else',
  Array.isArray(ENUM)
  && JSON.stringify([...ENUM].sort())
    === JSON.stringify(['log', ...Object.values(NAMED), ...LEDGER_ONLY].sort()),
  ENUM && ENUM.join(','));
check('S no event is both prose-paired and ledger-only — the two maps do not overlap',
  LEDGER_ONLY.every((n) => !Object.values(NAMED).includes(n)));
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
  // Ledger-only facts are emitted the OTHER way — `log.event(trace, '<name>', data)` — so the
  // `event: '<name>'` scan above cannot see them, and they carry no message for a prefix to
  // match. Scanned separately, and held to the one rule that still applies: the name is in
  // the enum, and every declared ledger-only event actually has a call site.
  const ledgerSites = new Map();
  for (const { file, text } of SRC) {
    for (const m of text.matchAll(/\.event\(\s*[^,]+,\s*'([^']+)'/g)) {
      if (!ledgerSites.has(m[1])) ledgerSites.set(m[1], []);
      ledgerSites.get(m[1]).push(file);
    }
  }
  check('S every event name emitted in runner/ is in the schema enum, both call forms',
    Array.isArray(ENUM) && [...emitted.keys(), ...ledgerSites.keys()].every((n) => ENUM.includes(n)),
    [...emitted.keys(), ...ledgerSites.keys()].filter((n) => !ENUM || !ENUM.includes(n)).join(','));
  const shouldEmit = Object.values(NAMED);
  check('S every prose-paired event has a call site in runner/ — nothing is declared and unwritten',
    shouldEmit.every((n) => emitted.has(n)), shouldEmit.filter((n) => !emitted.has(n)).join(','));
  check('S every ledger-only event has a log.event() call site, and emits no prose event',
    LEDGER_ONLY.every((n) => ledgerSites.has(n) && !emitted.has(n)),
    LEDGER_ONLY.filter((n) => !ledgerSites.has(n)).join(','));
  // `queue.read` was declared by the writer task and emitted by nothing (change-log row
  // `repo-qzy`). It is emitted now, from the queue module, and this is the check that would
  // have gone red had the declaration been left standing empty a second time.
  check('S queue.read is no longer reserved: it has a call site, and it is in runner/queue.js',
    emitted.has('queue.read') && emitted.get('queue.read').some((s) => s.file === 'queue.js'),
    [...(emitted.get('queue.read') || [])].map((s) => s.file).join(','));
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

// ---- V: the failing-check vocabulary the ledger imports ---------------------------------
// `failingChecks` lives in scripts/sweep-assertions.js — the one file that owns this repo's
// assertion-line constants — and `attempt.finished` is its only consumer (change-log row
// `repo-3xw`). Covered from here as well as from that file's own suite because the JOIN is
// what breaks: a name list that silently stops recognising a form is non-empty, well-formed
// and stale, and only the ledger would carry the consequence.
{
  const sweep = require(path.join(ROOT, 'scripts', 'sweep-assertions.js'));
  const fc = typeof sweep.failingChecks === 'function' ? sweep.failingChecks : null;
  check('V scripts/sweep-assertions.js exports failingChecks', !!fc);
  if (fc) {
    check('V all three failure forms are recognised: node, shell and the colon form',
      JSON.stringify(fc('FAIL - dash form\nFAIL\tshell form\nFAIL: colon form\n'))
        === JSON.stringify(['colon form', 'dash form', 'shell form']));
    // `FAIL - x` also satisfies `^FAIL[ \t]`, so the ORDER the forms are tried in is the whole
    // difference between naming the check and naming `- x`. This is the check that catches it.
    check('V the dash form is read as the dash form, never as the shell form with a stray dash',
      JSON.stringify(fc('FAIL - b broke\n')) === JSON.stringify(['b broke']));
    check('V a file-level FAIL: <path> is a name like any other — the path IS what failed',
      JSON.stringify(fc('FAIL: tests/acceptance/x/t.js\n')) === JSON.stringify(['tests/acceptance/x/t.js']));
    check('V sorted and de-duplicated: two attempts that failed the same set match as sets',
      JSON.stringify(fc('FAIL - z\nFAIL - a\nFAIL - z\n')) === JSON.stringify(['a', 'z']));
    check('V anchored at column 0 and CRLF-tolerant, exactly like countAssertions',
      JSON.stringify(fc('  FAIL - indented decoy\nFAIL - real\r\n')) === JSON.stringify(['real']));
    check('V a log with no failures is [] and junk input does not throw',
      JSON.stringify(fc('ok - a\nPASS b\n')) === '[]'
      && [undefined, null, 42, '', {}].every((j) => JSON.stringify(fc(j)) === '[]'));
    // The constraint that keeps every existing sweep number where it is: the colon form is
    // `failingChecks`' alone. A shared constant would move `failed` on logs that have been
    // reporting the same number since change-log row `repo-0ay`.
    const ca = sweep.countAssertions('ok - a\nFAIL: colon\nPASS b\n');
    check('V the colon form is invisible to countAssertions, so no suite\'s number moved',
      ca.count === 1 && ca.failed === 0 && JSON.stringify(ca.counts) === JSON.stringify({ node: 1, shell: 1 }),
      JSON.stringify(ca));
  }
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
    // ITEMS, not just `array`. `queue.read`'s whole contract is that `ready` holds ids and
    // never issue objects, and a reader that stops at "it is an array" cannot say so — which
    // makes the schema's `items` declaration decoration rather than a rule.
    if (t === 'array') {
      return Array.isArray(value) && (!spec.items || value.every((x) => typeOk(x, spec.items)));
    }
    if (t === 'object') {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
      if (spec.additionalProperties === false && spec.properties) {
        for (const k of Object.keys(value)) if (!(k in spec.properties)) return false;
      }
      for (const k of (spec.required || [])) if (!(k in value)) return false;
      for (const [k, s] of Object.entries(spec.properties || {})) {
        if (k in value && !typeOk(value[k], s)) return false;
      }
      return true;
    }
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
  "  if (process.env.BD_CALLS) sfs.appendFileSync(process.env.BD_CALLS, a.join(' ') + '\\n');",
  "  if (a.includes('show')) {",
  '    sfs.writeSync(1, JSON.stringify([{ id: process.env.BD_ISSUE_ID, title: "t", description: "d", acceptance_criteria: "a", design: "DESIGN.md 4.7" }]));',
  "  } else if (process.env.BD_FAIL_TERMINAL && a[0] === 'update' && a.includes('--status') && (a.includes('closed') || a.includes('blocked'))) {",
  "    sfs.writeSync(2, 'planted bd failure for terminal update'); process.exit(7);",
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

// A completed implementation must cross TWO durable boundaries before its workspace can be
// discarded: publication, then the terminal Beads transition. These fixtures differ in one
// switch each. They drive the real runOneTask body, local Git remote and process seams; a
// pure decision-function test would stay green if the caller ignored its answer.
const DELIVERY_STUB = [
  '#!/bin/sh',
  'mkdir -p "$RUN_DIR"',
  'REGRESSION="${FIXTURE_REGRESSION:-pass}"',
  'printf \'{"issueId":"%s","phase":"docs","attempts":[{"number":1,"verifierResult":"pass","timestamp":"2026-01-01T00:00:03.000Z"}]}\\n\' "$ISSUE_ID" > "$RUN_DIR/status.json"',
  'if [ "${FIXTURE_ARTIFACT_MODE:-}" != "missing-verify" ]; then',
  '  printf \'{"issueId":"%s","timestamp":"2026-01-01T00:00:03.000Z","acceptance":"pass","regressions":"%s"}\\n\' "$ISSUE_ID" "$REGRESSION" > "$RUN_DIR/verify.json"',
  'fi',
  'git config user.email fixture@test.local',
  'git config user.name fixture',
  'echo durable-work > delivered.txt',
  'if [ -n "${FIXTURE_DISCLOSURE:-}" ]; then printf \'%s\\n\' "$FIXTURE_DISCLOSURE" > exposed.txt; fi',
  'git add -A',
  'git commit -qm "verified fixture work"',
  'exit 0',
  '',
].join('\n');

async function completionFailureFixture(kind) {
  const tmp = fs.mkdtempSync(path.join(TMP, `settle-${kind}-`));
  const { remote, seed } = seedRepo(tmp);
  if (kind === 'regression') {
    const projectCfg = JSON.parse(fs.readFileSync(path.join(seed, 'pipeline.config.json'), 'utf8'));
    projectCfg.regressionCommand = 'bash scripts/test-ci.sh';
    projectCfg.regressionPolicy = 'required';
    fs.writeFileSync(path.join(seed, 'pipeline.config.json'), `${JSON.stringify(projectCfg, null, 2)}\n`);
    spawnSync('git', ['-C', seed, '-c', 'user.name=fixture', '-c', 'user.email=fixture@test.local',
      'commit', '-qam', 'require regression gate'], { encoding: 'utf8' });
    spawnSync('git', ['-C', seed, 'push', '-q', 'origin', 'main'], { encoding: 'utf8' });
  }
  if (kind === 'push') {
    const hook = path.join(remote, 'hooks', 'pre-receive');
    fs.writeFileSync(hook, '#!/bin/sh\necho planted push rejection >&2\nexit 1\n');
    fs.chmodSync(hook, 0o755);
  }
  const bdStub = path.join(tmp, 'bd-stub.js');
  const execStub = path.join(tmp, 'delivery-stub.sh');
  const calls = path.join(tmp, 'bd-calls.txt').split(path.sep).join('/');
  fs.writeFileSync(bdStub, BD_STUB);
  fs.writeFileSync(execStub, DELIVERY_STUB);

  const saved = {};
  const set = (k, v) => { saved[k] = process.env[k]; process.env[k] = v; };
  const issueId = `settle-${kind}`;
  set('PIPELINE_BD_CMD', process.execPath);
  set('NODE_OPTIONS', `--require "${bdStub.split(path.sep).join('/')}"`);
  set('BD_ISSUE_ID', issueId);
  set('BD_CALLS', calls);
  if (kind === 'tracking') set('BD_FAIL_TERMINAL', '1');
  else { saved.BD_FAIL_TERMINAL = process.env.BD_FAIL_TERMINAL; delete process.env.BD_FAIL_TERMINAL; }
  if (kind === 'regression') set('FIXTURE_REGRESSION', 'fail');
  else { saved.FIXTURE_REGRESSION = process.env.FIXTURE_REGRESSION; delete process.env.FIXTURE_REGRESSION; }
  const injected = ['settlement', '-', 'fixture', '-', 'S'.repeat(32)].join('');
  if (kind === 'credential') set('FIXTURE_DISCLOSURE', injected);
  else { saved.FIXTURE_DISCLOSURE = process.env.FIXTURE_DISCLOSURE; delete process.env.FIXTURE_DISCLOSURE; }
  if (kind === 'artifact') set('FIXTURE_ARTIFACT_MODE', 'missing-verify');
  else { saved.FIXTURE_ARTIFACT_MODE = process.env.FIXTURE_ARTIFACT_MODE; delete process.env.FIXTURE_ARTIFACT_MODE; }
  set('PIPELINE_EXEC_STUB', execStub);
  set('PIPELINE_GH_CMD', "printf 'https://example.test/pr/9\\n'");
  saved.PIPELINE_KEEP_WORKSPACE = process.env.PIPELINE_KEEP_WORKSPACE;
  delete process.env.PIPELINE_KEEP_WORKSPACE;

  const log = logmod.startRun(path.join(tmp, 'runs-root'), `unit-settle-${kind}`);
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
  const gate = { admit: async () => true, reportLimit: async () => ({ resumed: false }) };
  let row = null;
  let threw = null;
  try {
    row = await runmod.runOneTask(cfg, { id: issueId, title: `${kind} fixture`, priority: 1 },
      log, kind === 'credential' ? injected : 'tok', gate);
  } catch (e) {
    threw = e;
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
  return { tmp, remote, issueId, row, threw, calls: read(calls) || '', log, injected };
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
  // The ledger-only facts from the REAL task body, which is the only thing that proves
  // `runOneTask` emits them at all — and emits them ONCE. This fixture pauses and relaunches,
  // so it collects its status file twice; an implementation that emitted inside the loop
  // writes attempt 1 twice here and nowhere else.
  check('F the paused-and-relaunched task emits ONE attempt.finished per attempt, not one per collection',
    by('attempt.finished').length === 1 && by('attempt.finished')[0].data.number === 1
    && by('attempt.finished')[0].data.issueId === 'led-1'
    && by('attempt.finished')[0].msg === null, JSON.stringify(by('attempt.finished').map((e) => e.data)));
  check('F ...after the relaunch, never before it',
    ev.findIndex((e) => e.event === 'attempt.finished') > ev.findIndex((e) => e.event === 'task.relaunched'));
  check('F the refused task reaches neither ledger-only fact — nothing ran, so nothing is known',
    by('attempt.finished').every((e) => e.issueId !== 'led-2') && by('concern.raised').length === 0);

  // ---- S: completion is durable publication + durable task tracking -------------------
  {
    const pushFx = await completionFailureFixture('push');
    const p = pushFx.row || {};
    const pev = events(pushFx.log.dir).filter((e) => e.event === 'task.finished');
    check('S a rejected push does not throw away the task result',
      pushFx.threw === null && p.outcome === 'done', pushFx.threw && pushFx.threw.stack);
    check('S a rejected push leaves the issue in_progress — no terminal transition was attempted',
      /update settle-push --claim/.test(pushFx.calls)
      && !/update settle-push --status (closed|blocked)/.test(pushFx.calls), pushFx.calls);
    check('S a rejected push is a named manifest error, never a silent pushed:false',
      p.pushed === false && typeof p.error === 'string' && /push|publication/i.test(p.error), JSON.stringify(p));
    check('S the only recoverable workspace survives and is named on the row',
      typeof p.recoveryWorkspace === 'string' && fs.existsSync(p.recoveryWorkspace)
      && fs.existsSync(path.join(p.recoveryWorkspace, 'delivered.txt')), p.recoveryWorkspace);
    check('S the task.finished ledger says no Beads transition happened',
      pev.length === 1 && pev[0].level === 'ERROR' && pev[0].data.beads === null
      && /workspace kept/i.test(pev[0].msg), JSON.stringify(pev[0] || null));
    const pushedRef = spawnSync('git', ['--git-dir', pushFx.remote, 'rev-parse', '--verify', 'refs/heads/task/settle-push'], { encoding: 'utf8' });
    check('S the rejected branch really is absent from the remote', pushedRef.status !== 0);
    if (p.recoveryWorkspace) try { fs.rmSync(p.recoveryWorkspace, { recursive: true, force: true }); } catch { /* temp */ }

    const trackingFx = await completionFailureFixture('tracking');
    const t = trackingFx.row || {};
    const tev = events(trackingFx.log.dir).filter((e) => e.event === 'task.finished');
    check('S a failed terminal Beads write happens only after the branch and PR are durable',
      trackingFx.threw === null && t.pushed === true && t.prUrl === 'https://example.test/pr/9'
      && /update settle-tracking --status closed/.test(trackingFx.calls), JSON.stringify(t));
    check('S a failed terminal Beads write is reported and retains the workspace for recovery',
      typeof t.error === 'string' && /Beads|tracking|closed/i.test(t.error)
      && typeof t.recoveryWorkspace === 'string' && fs.existsSync(t.recoveryWorkspace), JSON.stringify(t));
    check('S a failed terminal Beads write is not logged as a successful transition',
      tev.length === 1 && tev[0].level === 'ERROR' && tev[0].data.beads === null
      && /workspace kept/i.test(tev[0].msg), JSON.stringify(tev[0] || null));
    const trackedRef = spawnSync('git', ['--git-dir', trackingFx.remote, 'rev-parse', '--verify', 'refs/heads/task/settle-tracking'], { encoding: 'utf8' });
    check('S the branch remains durable when only task tracking failed', trackedRef.status === 0);
    if (t.recoveryWorkspace) try { fs.rmSync(t.recoveryWorkspace, { recursive: true, force: true }); } catch { /* temp */ }

    const regressionFx = await completionFailureFixture('regression');
    const g = regressionFx.row || {};
    const gev = events(regressionFx.log.dir).filter((e) => e.event === 'task.finished');
    check('S a required regression failure blocks publication and terminal Beads completion',
      regressionFx.threw === null && g.outcome === 'partial' && g.pushed === false
      && /required regression gate/i.test(g.error || '')
      && !/update settle-regression --status (closed|blocked)/.test(regressionFx.calls), JSON.stringify(g));
    check('S the required-regression failure retains and names the recoverable workspace',
      typeof g.recoveryWorkspace === 'string' && fs.existsSync(g.recoveryWorkspace)
      && gev.length === 1 && gev[0].level === 'ERROR' && gev[0].data.beads === null,
      JSON.stringify(gev[0] || null));
    const regressionRef = spawnSync('git', ['--git-dir', regressionFx.remote, 'rev-parse', '--verify',
      'refs/heads/task/settle-regression'], { encoding: 'utf8' });
    check('S a red mandatory regression never reaches the remote', regressionRef.status !== 0);
    if (g.recoveryWorkspace) try { fs.rmSync(g.recoveryWorkspace, { recursive: true, force: true }); } catch { /* temp */ }

    const credentialFx = await completionFailureFixture('credential');
    const c = credentialFx.row || {};
    const cev = events(credentialFx.log.dir).filter((e) => e.event === 'task.finished');
    check('S credential disclosure is a recoverable security failure through the real task body',
      credentialFx.threw === null && c.outcome === 'done' && c.pushed === false
      && /credential disclosure scan rejected/i.test(c.error || '')
      && typeof c.recoveryWorkspace === 'string' && fs.existsSync(c.recoveryWorkspace), JSON.stringify(c));
    check('S credential refusal attempts no terminal Beads transition',
      !/update settle-credential --status (closed|blocked)/.test(credentialFx.calls)
      && /update settle-credential --claim/.test(credentialFx.calls), credentialFx.calls);
    check('S credential refusal retains the evidence-bearing local commit and names no secret',
      fs.existsSync(path.join(c.recoveryWorkspace || '', 'exposed.txt'))
      && !JSON.stringify(c).includes(credentialFx.injected)
      && !(read(credentialFx.log.logFile) || '').includes(credentialFx.injected), JSON.stringify(c));
    check('S credential refusal records an ERROR settlement event with no Beads transition',
      cev.length === 1 && cev[0].level === 'ERROR' && cev[0].data.beads === null,
      JSON.stringify(cev[0] || null));
    const credentialRef = spawnSync('git', ['--git-dir', credentialFx.remote, 'rev-parse', '--verify',
      'refs/heads/task/settle-credential'], { encoding: 'utf8' });
    check('S a secret-bearing branch never reaches the remote', credentialRef.status !== 0);
    if (c.recoveryWorkspace) try { fs.rmSync(c.recoveryWorkspace, { recursive: true, force: true }); } catch { /* temp */ }

    const artifactFx = await completionFailureFixture('artifact');
    const a = artifactFx.row || {};
    const aev = events(artifactFx.log.dir).filter((e) => e.event === 'task.finished');
    check('S exit 0 with missing verification evidence is relabelled failed, never done',
      artifactFx.threw === null && a.outcome === 'failed'
      && /verification artifact missing/.test(a.error || ''), JSON.stringify(a));
    check('S missing verification evidence blocks rather than closes the issue',
      /update settle-artifact --status blocked/.test(artifactFx.calls)
      && !/update settle-artifact --status closed/.test(artifactFx.calls), artifactFx.calls);
    check('S the invalid success claim opens no PR but preserves its branch on the remote',
      a.pushed === true && a.prUrl === null
      && spawnSync('git', ['--git-dir', artifactFx.remote, 'rev-parse', '--verify',
        'refs/heads/task/settle-artifact'], { encoding: 'utf8' }).status === 0, JSON.stringify(a));
    check('S the settlement event records failed/blocked rather than done/closed',
      aev.length === 1 && aev[0].data.outcome === 'failed' && aev[0].data.beads === 'blocked',
      JSON.stringify(aev[0] || null));
  }

  // ---- Q: the queue read and its refusals, through the exported helpers -----------------
  // The two events `main()` writes. `main()` sits behind the token load and the Docker
  // preflight, so the helpers in runner/queue.js are the only reachable form of them — which
  // is precisely why they are helpers (change-log row `repo-3xw`).
  {
    const queue = require(path.join(ROOT, 'runner', 'queue.js'));
    const log = logmod.startRun(path.join(TMP, 'queue'), 'unit-events-q');
    const q = {
      ok: true,
      issues: [{ id: 'q-1', title: 'one', issue_type: 'task' }, { id: 'q-2', title: 'two', issue_type: 'bug' }],
      skipped: [{ id: 'e-1', title: 'epic', issue_type: 'EPIC ' }],
      undispatchable: [
        { issue: { id: 'u-1', title: 'u' }, reason: 'no frozen acceptance suite at tests/acceptance/u-1/ on main' },
        { issue: { id: 'u-2', title: 'v' }, reason: 'the suite changed since the gate ran', refusal: 'receipt-mismatch' },
      ],
    };
    queue.logQueueRead(log, q);
    for (const u of q.undispatchable) queue.logUndispatched(log, u);

    const qev = events(log.dir);
    const qln = lines(log.dir);
    const qr = qev.filter((e) => e.event === 'queue.read');
    check('Q queue.read is written once, as the TWIN of the ready-queue line: one ts, one call',
      qr.length === 1 && String(qr[0].msg).startsWith(P.readyQueue)
      && qln[0].startsWith(`${qr[0].ts} INFO `) && qln[0].endsWith(qr[0].msg),
      JSON.stringify(qr[0] || null));
    check('Q ...traced to preflight, so its issueId is null — a queue read belongs to no issue',
      qr.length === 1 && qr[0].trace === 'unit-events-q/preflight' && qr[0].issueId === null);
    check('Q ready is a list of IDS, never issue objects — a bd issue carries prose the ledger must not',
      qr.length === 1 && JSON.stringify(qr[0].data.ready) === JSON.stringify(['q-1', 'q-2']));
    check('Q skipped carries the id and the NORMALISED type that removed it, not the raw field',
      qr.length === 1 && JSON.stringify(qr[0].data.skipped) === JSON.stringify([{ id: 'e-1', type: 'epic' }]),
      JSON.stringify(qr.length && qr[0].data.skipped));
    // `refusal` is a KIND and the gate names none today: carried when present, ABSENT when
    // not. A `refusal: null` on every line would be a field a later reader has to learn to
    // ignore, and defaulting it to a string would fix a vocabulary this task does not own.
    check('Q refused carries id and reason always, and the refusal kind only where one was given',
      qr.length === 1 && JSON.stringify(qr[0].data.refused) === JSON.stringify([
        { id: 'u-1', reason: 'no frozen acceptance suite at tests/acceptance/u-1/ on main' },
        { id: 'u-2', reason: 'the suite changed since the gate ran', refusal: 'receipt-mismatch' },
      ]), JSON.stringify(qr.length && qr[0].data.refused));

    const ud = qev.filter((e) => e.event === 'task.undispatched');
    check('Q task.undispatched is one ERROR twin per refused issue, prefixed as the table says',
      ud.length === 2 && ud.every((e) => e.level === 'ERROR' && String(e.msg).startsWith(P.undispatched)),
      JSON.stringify(ud.map((e) => e.msg)));
    // The whole reason it is traced to the issue: `issueId` is the trace's tail, so a
    // run-level trace would file every refusal under nothing and the reader asking "what
    // happened to u-2" would find an empty answer rather than the reason.
    check('Q ...each traced to ITS OWN issue, so issueId files it where a reader will look',
      ud.length === 2 && ud[0].issueId === 'u-1' && ud[1].issueId === 'u-2'
      && ud[0].data.id === 'u-1' && ud[1].data.refusal === 'receipt-mismatch'
      && !('refusal' in ud[0].data));
    const qbad = qev.map(validate).filter(Boolean);
    check('Q every queue event validates against the schema, types included', qbad.length === 0, qbad.join(' | '));
    // The negative side of the ids-only rule, which is the one the schema is there to hold.
    // The negatives, one rule per planted line, so a rejection names what caught it. Without
    // these "everything validates" is a statement about the validator, not about the ledger.
    const qrejects = {
      'a ready list holding issue objects rather than ids': { ready: [{ id: 'q-1' }], skipped: [], refused: [] },
      'a skipped entry with no type — the id alone does not say what removed it': { ready: [], skipped: [{ id: 'e-1' }], refused: [] },
      'a refused entry carrying a whole issue alongside the reason': { ready: [], skipped: [], refused: [{ id: 'u-1', reason: 'r', issue: { id: 'u-1' } }] },
      'a refused entry with no reason': { ready: [], skipped: [], refused: [{ id: 'u-1' }] },
      'a ready list that is a count rather than a list': { ready: 2, skipped: [], refused: [] },
    };
    for (const [why, data] of Object.entries(qrejects)) {
      check(`Q the validator rejects ${why}`, validate({ ...qr[0], data }) !== null, JSON.stringify(data));
    }
    check('Q an empty queue is still a queue read: three empty lists, not a missing event',
      (() => {
        const l2 = logmod.startRun(path.join(TMP, 'queue2'), 'unit-events-q2');
        queue.logQueueRead(l2, { ok: true, issues: [], skipped: [], undispatchable: [] });
        const e = events(l2.dir)[0];
        return !!e && e.event === 'queue.read' && validate(e) === null
          && JSON.stringify(e.data) === JSON.stringify({ ready: [], skipped: [], refused: [] });
      })());
  }

  // ---- A: the attempt trichotomy, driven directly -------------------------------------
  // `[]`, a list, and `null` are THREE facts, and the expensive confusion is the third read
  // as the first: a reader asking "did the last two attempts fail the same checks?" would
  // score two attempts that recorded nothing as identical. A fixture run writes one status
  // file, so the shapes are planted here instead.
  {
    const log = logmod.startRun(path.join(TMP, 'att'), 'unit-events-att');
    const tr = log.trace('a-9');
    runmod.logAttempts(log, tr, 'a-9', {
      attempts: [
        { number: 1, verifierResult: 'fail', feedback: 'ok - a\nFAIL - alpha\nFAIL: tests/acceptance/z/t.js\n' },
        { number: 2, verifierResult: 'fail', feedback: 'ok - a\nok - b\n' },
        { number: 3, verifierResult: 'fail' },
      ],
    }, { acceptanceOutput: 'ok - a\nFAIL - from the verifier output\n' });
    const at = events(log.dir).filter((e) => e.event === 'attempt.finished');
    check('A one attempt.finished per attempt, ledger-only: msg null, INFO, no run.log line',
      at.length === 3 && lines(log.dir).length === 0
      && at.every((e) => e.msg === null && e.level === 'INFO' && e.issueId === 'a-9' && e.data.issueId === 'a-9'),
      JSON.stringify(at.map((e) => e.data)));
    check('A a failing attempt\'s names come from its own feedback, sorted, the colon form included',
      at.length === 3 && JSON.stringify(at[0].data.failingChecks)
        === JSON.stringify(['alpha', 'tests/acceptance/z/t.js']), JSON.stringify(at[0] && at[0].data));
    check('A feedback present with nothing failing is [] — text was read and named nothing',
      at.length === 3 && JSON.stringify(at[1].data.failingChecks) === '[]');
    // The path the frozen suite could not reach: its own fixture's verify.json is written by
    // a printf that turns `\n` into a real newline, so the document does not parse and
    // `collectArtifacts` drops it. Here verify is handed in as an object, and the output
    // CARRIES a failure — so an implementation that skipped the fallback answers null and a
    // wrong one that reported [] is caught too. Neither is possible to tell apart with a
    // passing verifier's output.
    check('A the FINAL attempt with no feedback falls back to verify.acceptanceOutput',
      at.length === 3 && JSON.stringify(at[2].data.failingChecks)
        === JSON.stringify(['from the verifier output']), JSON.stringify(at[2] && at[2].data));
    check('A every attempt event validates, and number/verifierResult are typed as declared',
      at.length === 3 && at.map(validate).filter(Boolean).length === 0
      && at.map((e) => e.data.number).join(',') === '1,2,3');
    check('A the validator rejects a failingChecks list holding anything but check names',
      at.length === 3 && validate({ ...at[0], data: { ...at[0].data, failingChecks: [{ name: 'x' }] } }) !== null);
    check('A ...and an attempt event missing a required field',
      at.length === 3 && validate({ ...at[0], data: { issueId: 'a-9', number: 1, verifierResult: 'fail' } }) !== null);
  }
  {
    const log = logmod.startRun(path.join(TMP, 'att2'), 'unit-events-att2');
    runmod.logAttempts(log, log.trace('a-9'), 'a-9', {
      attempts: [
        { number: 1, verifierResult: 'fail' },
        { number: 2, verifierResult: 'pass' },
      ],
    }, null);
    const at = events(log.dir).filter((e) => e.event === 'attempt.finished');
    // The two answers a lazy implementation collapses onto each other. A killed container
    // leaves a half-written verify.json that collectArtifacts drops on purpose, so "it
    // failed and the output is gone" is a real state — and it is NOT "nothing failed".
    check('A a FAILING attempt whose output did not survive is null: unknown, never []',
      at.length === 2 && at[0].data.failingChecks === null, JSON.stringify(at[0] && at[0].data));
    check('A a PASSING attempt with no text is [] : the suite ran and every check in it passed',
      at.length === 2 && JSON.stringify(at[1].data.failingChecks) === '[]');
    check('A ...and the two are distinguishable, which is the whole point of the third answer',
      at.length === 2 && at[0].data.failingChecks !== at[1].data.failingChecks);
    check('A the null answer still validates — the schema declares array|null, not array',
      at.map(validate).filter(Boolean).length === 0, at.map(validate).filter(Boolean).join(' | '));
    check('A no attempts, no events — an empty list is not an attempt',
      (() => {
        const l2 = logmod.startRun(path.join(TMP, 'att3'), 'unit-events-att3');
        runmod.logAttempts(l2, l2.trace('a-9'), 'a-9', { attempts: [] }, null);
        runmod.logAttempts(l2, l2.trace('a-9'), 'a-9', null, null);
        return events(l2.dir).length === 0;
      })());
  }

  // ---- C: the spec-concern channel (§3.7) ----------------------------------------------
  {
    const log = logmod.startRun(path.join(TMP, 'con'), 'unit-events-con');
    runmod.logConcerns(log, log.trace('a-9'), {
      // Hostile and INTERLEAVED, per repo-iok's lesson: junk at the head passes an
      // implementation that stops at the first bad entry, so it is scattered among real ones.
      specConcerns: ['the spec is wrong because X', 42, 'a second one\nwith a newline', null, { no: 1 }],
    });
    const co = events(log.dir).filter((e) => e.event === 'concern.raised');
    check('C one concern.raised per string entry, VERBATIM — never summarised, never counted',
      co.length === 2 && co[0].data.text === 'the spec is wrong because X'
      && co[1].data.text === 'a second one\nwith a newline', JSON.stringify(co.map((e) => e.data)));
    check('C ...ledger-only and traced to the issue, with no run.log line',
      co.every((e) => e.msg === null && e.level === 'INFO' && e.issueId === 'a-9') && lines(log.dir).length === 0);
    // `String(x)` on a stray object would file `[object Object]` as a concern a human then has
    // to go and disprove: a non-empty, well-formed, false entry in the channel whose whole
    // value is that a person reads it.
    check('C non-string entries are skipped, never coerced into a concern nobody raised',
      co.length === 2 && !co.some((e) => /object Object|^42$/.test(e.data.text)));
    check('C a multi-line concern is still ONE ledger line, and it validates',
      co.length === 2 && co.map(validate).filter(Boolean).length === 0
      && (read(path.join(log.dir, 'events.jsonl')) || '').split('\n').filter(Boolean).length === 2);
    check('C no concerns, no events', (() => {
      const l2 = logmod.startRun(path.join(TMP, 'con2'), 'unit-events-con2');
      runmod.logConcerns(l2, l2.trace('a-9'), { specConcerns: [] });
      runmod.logConcerns(l2, l2.trace('a-9'), { specConcerns: 'nope' });
      runmod.logConcerns(l2, l2.trace('a-9'), null);
      return events(l2.dir).length === 0;
    })());
  }

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
    // And the harder half, which the third argument's absent-safety does NOT cover: that
    // stand-in has no `event()` AT ALL, and calling a method that is not there throws — from
    // inside the task body, after the container has run and before the outcome is written.
    // Four other suites hand `runOneTask` exactly this object, so the ledger-only emitters ask
    // for the writer before using it. Both emitters, because guarding one is the likely bug.
    let ledgerThrew = null;
    try {
      runmod.logAttempts(fake, fake.trace('x'), 'x',
        { attempts: [{ number: 1, verifierResult: 'fail', feedback: 'FAIL - a\n' }] }, null);
      runmod.logConcerns(fake, fake.trace('x'), { specConcerns: ['a concern'] });
    } catch (e) { ledgerThrew = e; }
    check('F ...and a log object with NO event() at all is survivable, not a mid-task throw',
      ledgerThrew === null, ledgerThrew && ledgerThrew.message);
  }

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* temp */ }
  process.exit(failed);
})().catch((e) => { console.log(`FAIL - the suite itself threw: ${e && e.stack}`); process.exit(1); });
