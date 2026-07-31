// Frozen acceptance test — repo-teq: the bounded worker pool, i.e. the §7 `concurrency`
// knob that lets ONE runner process work N tasks of one project at a time
// (DESIGN.md §7, §4.12, §4.10). Written before implementation, from the spec alone;
// criteria A1–A6. Plain Node, Docker-free — a task container cannot run Docker.
//
// THE CONTRACT THIS FILE PINS, because it does not exist yet and the implementing agent
// cannot guess it:
//
//     runner/run.js exports `drainQueue(issues, taskFn, concurrency) -> Promise<results[]>`
//
//   * `issues` is the ready queue, in ready-queue order.
//   * `taskFn(issue)` returns a Promise; the runner's own task body is passed in here.
//   * `concurrency` is the bound — at most that many taskFn calls in flight at once.
//   * The resolved array is in READY-QUEUE ORDER, index-aligned with `issues`, carrying
//     whatever each taskFn resolved to. Not completion order.
//   * `main()` is guarded behind `require.main === module`, so requiring run.js as a
//     module runs nothing. That guard is what makes any of this reachable Docker-free.
//
// Five things this file gets right on purpose, each from the 2026-07-31 planning panel:
//
//   * REQUIRABILITY IS PROVEN IN A CHILD PROCESS FIRST. If main() still runs at module
//     load it calls process.exit(2) on the missing config — which would kill this test
//     process mid-file and report nothing. So the require is probed out-of-process, and
//     the in-process require happens only once that probe came back clean.
//   * CONCURRENCY IS PROVEN BY RENDEZVOUS, NEVER BY WALL-CLOCK (A4). Three tasks must be
//     genuinely in flight for the fixture to complete at all. The rendezvous is entirely
//     in-process — no spawned processes, no shared file — so it is deterministic rather
//     than load-sensitive, and there are no interleaved partial writes to flake on.
//   * THE BOUNDED HALF IS ASSERTED SEPARATELY (A4). An UNBOUNDED pool satisfies the
//     rendezvous just as green, so max-in-flight ≤ N and "the fourth task starts only
//     after some task ended" are checked too. And the same fixture at concurrency 1 must
//     record the give-up marker — without that, A4 could be vacuous.
//   * ORDERING IS PROVEN AGAINST AN INVERTED FIXTURE (A5). Durations are arranged so the
//     last-queued task finishes first; a naive append-on-completion then fails.
//   * A2 DOES NOT ASSERT run.log. Its lines carry an ISO timestamp and a run id, so a
//     digit match is a false positive and a phrase match freezes the log's prose.
//     ajv is an npx download and there is no network in here, so the schema half is a
//     structural read plus a small root-level admitter that is checked to be
//     discriminating before it is trusted.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
let failed = 0;
function check(name, cond) {
  console.log(`${cond ? 'ok' : 'FAIL'} - ${name}`);
  if (!cond) failed = 1;
}
const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MAX_CONCURRENCY = 3;      // A1: the literal maximum, fixed by the spec
const GIVE_UP_MS = 10000;       // A4: the rendezvous give-up bound, fixed by the spec
const RENDEZVOUS_N = 3;         // A4: how many must be in flight for the fixture to clear

// Join each call to `name(` into one string by balancing parentheses, so a call spread
// over several lines is judged whole. Comment lines are dropped first.
function stripComments(src) {
  return src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
}
function callsTo(src, name) {
  const calls = [];
  let i = 0;
  for (;;) {
    const at = src.indexOf(`${name}(`, i);
    if (at === -1) break;
    let depth = 0;
    let j = at + name.length;
    for (; j < src.length; j++) {
      if (src[j] === '(') depth++;
      else if (src[j] === ')') { depth--; if (depth === 0) { j++; break; } }
    }
    calls.push(src.slice(at, j));
    i = j;
  }
  return calls;
}

const RUN_JS = path.join(ROOT, 'runner', 'run.js');
const runSrc = read(RUN_JS) || '';
const runCode = stripComments(runSrc);

// =====================================================================================
// A1 — the knob exists and is validated at load time
// =====================================================================================
let loadConfig = null;
try { ({ loadConfig } = require(path.join(ROOT, 'runner', 'config.js'))); } catch { /* reported below */ }
check('runner/config.js is requirable', typeof loadConfig === 'function');

const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-teq-cfg-'));
function writeCfg(name, extra) {
  const p = path.join(cfgDir, name);
  fs.writeFileSync(p, JSON.stringify({
    targetRepoPath: 'C:/nonexistent', targetRepoRemote: 'https://example.invalid/r.git',
    image: 'unused:local', ...extra,
  }, null, 2));
  return p;
}
function loaded(p) {
  if (typeof loadConfig !== 'function') return { ok: false, message: 'config.js not loaded' };
  try { return { ok: true, cfg: loadConfig(p) }; } catch (e) { return { ok: false, message: e.message }; }
}

const dflt = loaded(writeCfg('run.config.json', {}));
check('A1 a config naming no concurrency defaults to 1', dflt.ok && dflt.cfg.concurrency === 1);

for (const good of [1, 2, MAX_CONCURRENCY]) {
  const r = loaded(writeCfg(`run.config.ok-${good}.json`, { concurrency: good }));
  check(`A1 concurrency ${good} loads and wins`, r.ok && r.cfg.concurrency === good);
}

for (const [label, bad] of [
  ['zero', 0],
  ['negative', -1],
  ['above the maximum', MAX_CONCURRENCY + 1],
  ['fractional', 1.5],
  ['a string', '2'],
  ['null', null],
]) {
  const r = loaded(writeCfg(`run.config.bad-${label.replace(/\s/g, '-')}.json`, { concurrency: bad }));
  check(`A1 ${label} concurrency is a load-time error naming the field`,
    !r.ok && /concurrency/.test(r.message || ''));
}

// The knob is a production tunable, so it is documented where the other tunables are.
const exampleRaw = read(path.join(ROOT, 'run.config.example.json')) || '';
let exampleJson = null;
try { exampleJson = JSON.parse(exampleRaw); } catch { /* reported by the check */ }
check('A1 run.config.example.json documents the field at its default',
  !!exampleJson && exampleJson.concurrency === 1);

// =====================================================================================
// A2 — the configured value reaches run.json, and run.json still validates
// =====================================================================================
const SCHEMA_PATH = path.join(ROOT, 'schemas', 'run.schema.json');
let schema = null;
try { schema = JSON.parse(read(SCHEMA_PATH)); } catch { /* reported below */ }
check('schemas/run.schema.json is readable JSON', !!schema && typeof schema === 'object');

const cprop = (schema && schema.properties && schema.properties.concurrency) || null;
check('A2 the manifest root declares a top-level concurrency', !!cprop);
check('A2 concurrency is declared as an integer', !!cprop && cprop.type === 'integer');
check('A2 the manifest root is still additionalProperties:false',
  !!schema && schema.additionalProperties === false);
// Not required: scripts/test-report.sh validates a fixture manifest that predates this
// field, and this task cannot run that Docker suite to notice it broke.
check('A2 concurrency is optional (absent from required)',
  !!schema && (!Array.isArray(schema.required) || !schema.required.includes('concurrency')));

// A small root-level admitter, since ajv is an npx download and there is no network here.
// Checked to be discriminating below before anything is concluded from it passing.
function rootAdmits(sch, obj) {
  if (!sch || typeof sch !== 'object') return false;
  const props = sch.properties || {};
  if (sch.additionalProperties === false) {
    for (const k of Object.keys(obj)) if (!(k in props)) return false;
  }
  for (const k of (sch.required || [])) if (!(k in obj)) return false;
  for (const [k, v] of Object.entries(obj)) {
    const s = props[k];
    if (!s || !s.type) continue;
    const types = Array.isArray(s.type) ? s.type : [s.type];
    const actual = Array.isArray(v) ? 'array' : (v === null ? 'null' : typeof v);
    const ok = types.some((t) => (t === 'integer' ? Number.isInteger(v) : t === actual));
    if (!ok) return false;
  }
  return true;
}

const sampleManifest = {
  runId: 'run-teq-fixture',
  startedAt: '2026-07-31T00:00:00.000Z',
  finishedAt: '2026-07-31T00:01:00.000Z',
  targetRepo: 'https://example.invalid/r.git',
  concurrency: MAX_CONCURRENCY,
  tasks: [{ issueId: 'i-1', outcome: 'done' }],
};
check('A2 a manifest carrying concurrency is admitted by the schema root',
  rootAdmits(schema, sampleManifest));
check('A2 the admitter is discriminating (an undeclared root key is rejected)',
  !rootAdmits(schema, { ...sampleManifest, notAField: 1 }));
check('A2 the admitter is discriminating (a wrong-typed concurrency is rejected)',
  !rootAdmits(schema, { ...sampleManifest, concurrency: 'three' }));

// The writer half: report.js is not this task's to edit, so prove the field survives it.
let writeManifest = null;
try { ({ writeManifest } = require(path.join(ROOT, 'runner', 'report.js'))); } catch { /* below */ }
check('runner/report.js is requirable', typeof writeManifest === 'function');
if (typeof writeManifest === 'function') {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-teq-run-'));
  let onDisk = null;
  try {
    writeManifest(outDir, sampleManifest);
    onDisk = JSON.parse(read(path.join(outDir, 'run.json')) || 'null');
  } catch { /* reported by the check */ }
  check('A2 writeManifest carries a top-level concurrency through to run.json',
    !!onDisk && onDisk.concurrency === MAX_CONCURRENCY);
  try { fs.rmSync(outDir, { recursive: true, force: true }); } catch { /* disposable */ }
}

// The supplier half: run.js must actually hand the configured value to the manifest.
// Structural, because main() is unreachable without Docker and a token — the value half
// of A2 is covered above, and A1 pins where the value comes from.
const manifestCalls = callsTo(runCode, 'writeManifest');
check('A2 runner/run.js still writes a manifest', manifestCalls.length >= 1);
check('A2 runner/run.js supplies concurrency to the manifest it writes',
  manifestCalls.some((c) => /\bconcurrency\b/.test(c)));
check('A2 the concurrency it supplies comes from the config, not a literal',
  /\bcfg\.concurrency\b/.test(runCode));

// =====================================================================================
// The scheduler — probed out-of-process first (see the header), then required in-process
// =====================================================================================
const probe = spawnSync(process.execPath, [
  '-e',
  'const m = require(process.argv[1]); process.stdout.write(JSON.stringify(Object.keys(m || {})));',
  RUN_JS,
], { encoding: 'utf8', timeout: 30000 });

check('runner/run.js is requirable without running (main() is guarded)',
  !!probe && probe.status === 0);
let exportedKeys = [];
try { exportedKeys = JSON.parse(probe.stdout || '[]'); } catch { /* reported below */ }
check('runner/run.js exports drainQueue',
  Array.isArray(exportedKeys) && exportedKeys.includes('drainQueue'));

let drainQueue = null;
if (probe && probe.status === 0) {
  try { ({ drainQueue } = require(RUN_JS)); } catch { /* reported below */ }
}
check('drainQueue is a function', typeof drainQueue === 'function');

const issuesOf = (...ids) => ids.map((id, i) => ({ id, title: `fixture ${id}`, priority: i }));

// =====================================================================================
// A3 — at concurrency 1 the drain is strictly sequential and in ready-queue order
// =====================================================================================
async function a3() {
  const issues = issuesOf('a3-1', 'a3-2', 'a3-3');
  const events = [];
  const taskFn = async (issue) => {
    events.push({ id: issue.id, ev: 'start' });
    await sleep(5);
    events.push({ id: issue.id, ev: 'end' });
    return { issueId: issue.id, outcome: 'done' };
  };
  const results = await drainQueue(issues, taskFn, 1);

  check('A3 every queued task ran', Array.isArray(results) && results.length === issues.length);
  let overlapped = false;
  for (const iss of issues) {
    const s = events.findIndex((e) => e.id === iss.id && e.ev === 'start');
    const e = events.findIndex((x) => x.id === iss.id && x.ev === 'end');
    if (s === -1 || e === -1) { overlapped = true; break; }
    if (events.slice(s + 1, e).some((x) => x.ev === 'start')) overlapped = true;
  }
  check('A3 no task starts while another is in flight', !overlapped);
  check('A3 starts occur in ready-queue order',
    events.filter((e) => e.ev === 'start').map((e) => e.id).join(',') === 'a3-1,a3-2,a3-3');
}

// =====================================================================================
// A4 — at concurrency 3, three tasks are genuinely in flight, and the pool is bounded
// =====================================================================================
// The fixture cannot complete unless RENDEZVOUS_N tasks are in flight together: each one
// announces itself and then waits for the barrier, giving up after GIVE_UP_MS.
async function rendezvous(concurrency, tag) {
  const issues = issuesOf(`${tag}-1`, `${tag}-2`, `${tag}-3`, `${tag}-4`);
  const events = [];
  const gaveUp = [];
  let announced = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  let release;
  const barrier = new Promise((r) => { release = r; });

  const taskFn = async (issue) => {
    inFlight += 1;
    if (inFlight > maxInFlight) maxInFlight = inFlight;
    events.push({ id: issue.id, ev: 'start' });
    announced += 1;
    if (announced >= RENDEZVOUS_N) release();

    let timer = null;
    const giveUp = new Promise((r) => { timer = setTimeout(() => r('gave-up'), GIVE_UP_MS); });
    const how = await Promise.race([barrier.then(() => 'rendezvous'), giveUp]);
    if (timer) clearTimeout(timer);
    if (how === 'gave-up') gaveUp.push(issue.id);

    inFlight -= 1;
    events.push({ id: issue.id, ev: 'end' });
    return { issueId: issue.id, outcome: 'done' };
  };

  const results = await drainQueue(issues, taskFn, concurrency);
  return { issues, results, events, gaveUp, maxInFlight };
}

async function a4() {
  const wide = await rendezvous(MAX_CONCURRENCY, 'a4w');
  check(`A4 the drain completes at concurrency ${MAX_CONCURRENCY}`,
    Array.isArray(wide.results) && wide.results.length === wide.issues.length);
  check('A4 no task recorded the give-up marker', wide.gaveUp.length === 0);
  check(`A4 ${RENDEZVOUS_N} tasks were genuinely in flight together`,
    wide.maxInFlight === RENDEZVOUS_N);
  check(`A4 the pool is bounded — in-flight never exceeded ${MAX_CONCURRENCY}`,
    wide.maxInFlight <= MAX_CONCURRENCY);
  const fourthStart = wide.events.findIndex((e) => e.id === 'a4w-4' && e.ev === 'start');
  const firstEnd = wide.events.findIndex((e) => e.ev === 'end');
  check('A4 the fourth task started only after some task had ended',
    fourthStart > -1 && firstEnd > -1 && firstEnd < fourthStart);

  // The discriminating half: the same fixture at 1 must fail to rendezvous.
  const narrow = await rendezvous(1, 'a4n');
  check('A4 the same fixture at concurrency 1 records the give-up marker',
    narrow.gaveUp.length > 0);
  check('A4 concurrency 1 never had two tasks in flight', narrow.maxInFlight === 1);
}

// =====================================================================================
// A5 — results keep ready-queue order and every task's result stays its own
// =====================================================================================
async function a5() {
  const issues = issuesOf('a5-slow', 'a5-mid', 'a5-fast');
  const delayFor = { 'a5-slow': 90, 'a5-mid': 45, 'a5-fast': 5 };
  const completion = [];
  const taskFn = async (issue) => {
    await sleep(delayFor[issue.id]);
    completion.push(issue.id);
    return { issueId: issue.id, outcome: `outcome-of-${issue.id}` };
  };
  const results = await drainQueue(issues, taskFn, MAX_CONCURRENCY);

  check('A5 the fixture really did complete out of ready-queue order',
    completion.join(',') === 'a5-fast,a5-mid,a5-slow');
  check('A5 the returned results are still in ready-queue order',
    Array.isArray(results) && results.map((r) => r && r.issueId).join(',') === 'a5-slow,a5-mid,a5-fast');
  check('A5 each entry carries its own issue\'s result',
    Array.isArray(results) && results.length === issues.length
    && results.every((r, i) => r && r.outcome === `outcome-of-${issues[i].id}`));
}

// =====================================================================================
// A6 [guard] — the identifiers the unrepairable suites depend on survive the restructure
// =====================================================================================
function a6() {
  const lines = runSrc.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));
  for (const ident of ['fileMemoryNotes', 'queueSummary', 'shouldFileMemory', 'exitCode !== 20']) {
    check(`A6 [guard] runner/run.js still carries \`${ident}\` on a non-comment line`,
      lines.some((l) => l.includes(ident)));
  }
}

// =====================================================================================
(async () => {
  a6();
  if (typeof drainQueue !== 'function') {
    check('A3 the scheduler is drivable', false);
    check('A4 the scheduler is drivable', false);
    check('A5 the scheduler is drivable', false);
  } else {
    await a3();
    await a4();
    await a5();
  }
  try { fs.rmSync(cfgDir, { recursive: true, force: true }); } catch { /* disposable */ }
  console.log(failed ? 'repo-teq: FAILED' : 'repo-teq: all checks passed');
  process.exit(failed);
})().catch((e) => {
  console.log(`FAIL - repo-teq: the suite itself threw — ${e && e.stack ? e.stack : e}`);
  console.log('repo-teq: FAILED');
  process.exit(1);
});
