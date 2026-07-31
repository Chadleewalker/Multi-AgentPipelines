// Frozen acceptance test — repo-i9y: the rate-limit park becomes RUN-LEVEL. One shared
// wait for the whole run, a pool that admits no new work while the window is closed, and
// one cycle counter instead of one per task (DESIGN.md §4.7, §7, §4.11).
// Written before implementation, from the spec alone; criteria 1–8. Plain Node,
// Docker-free — a task container cannot run Docker.
//
// THE CONTRACT THIS FILE PINS, because it does not exist yet:
//
//   runner/pause.js exports createPauseGate(cfg, log, opts = {}) -> gate
//     opts.waitFn   DEFAULTS TO THIS MODULE'S OWN waitForWindow, called as
//                     waitFn(cfg, status, log, traceId,
//                            { token, spentCycles, maxPauses, sleepFn, probeFn })
//                   and resolving waitForWindow's REAL shapes:
//                     { resumed: true,  pauses: <number> }
//                     { resumed: false, reason: <string> }   // NO count field
//     opts.token / opts.sleepFn / opts.probeFn  forwarded unchanged
//     gate.reportLimit(status, traceId) -> Promise<{resumed, cycles, joined,
//                                                   exhausted?, reason?}>
//     gate.admit(traceId)               -> Promise<boolean>
//     gate.cycles / gate.exhausted / gate.waits
//
//   runner/run.js exports runOneTask(cfg, issue, log, token, gate)
//
//   PINNED SEMANTICS: the gate reads its count from result.pauses; a result carrying no
//   count leaves gate.cycles UNCHANGED; a resumed:false EXHAUSTS the gate; reportLimit's
//   join decision is synchronous on entry, before any await; admit() is consulted inside
//   runOneTask BEFORE claim().
//
// FIVE THINGS THIS FILE GETS RIGHT ON PURPOSE, each from the 2026-07-31 panel (30
// findings across three charters, all three `concerns`):
//
//   * C1 DRIVES THE REAL waitForWindow — NO STUB. The first draft let every criterion
//     inject its own recorder, so a gate whose default waitFn was a no-op would have
//     passed the whole spec while a real run never waited at all; and it described the
//     stub as resolving `{cycles}` when waitForWindow resolves `{pauses}`, so an
//     implementation reading `.cycles` would feed `spentCycles: undefined` forever and
//     the run-level cap could never fire — green test, dead feature. C1 closes both by
//     asserting cycles 1 then 2 THROUGH the real function.
//   * C8 PINS `exitCode !== 20` TO run.js SPECIFICALLY, not to a run.js-or-pause.js union.
//     scripts/test-runner-pause.sh:136 greps it out of the FILE BY NAME, and repo-teq's
//     frozen A6 asserts it in run.js. This repo declares no regressionCommand, so moving
//     it to pause.js would pass every gate the implementer can run and break both.
//   * C8 PINS THE DIGIT. That suite greps `rate limit hit (pause 1)`, not the prefix. A
//     run-level counter logged where the per-task relaunch counter belongs would slip past
//     a prefix match. It also pins `wall-clock budget exhausted`, which the suite uses as a
//     NEGATIVE assertion — drift there goes vacuously green, never red.
//   * C7 IS BEHAVIOURAL, NOT A GREP. runOneTask reaches Beads, git and gh only through
//     seams (PIPELINE_BD_CMD, targetRepoRemote, PIPELINE_GH_CMD, PIPELINE_EXEC_STUB), so
//     "not drivable without Docker" was false. It is driven for real here.
//   * NOTHING TURNS ON WALL-CLOCK. "Has not settled yet" is judged by draining the event
//     loop twice with setImmediate — one macrotask turn flushes the whole microtask queue —
//     and ordering is judged from an events array.
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
const drain = async () => { await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r)); };
const noSleep = async () => {};

function stripComments(src) {
  return src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
}
function callsTo(src, name) {
  const out = [];
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
    out.push({ at, text: src.slice(at, j) });
    i = j;
  }
  return out;
}

const RUN_JS = path.join(ROOT, 'runner', 'run.js');
const PAUSE_JS = path.join(ROOT, 'runner', 'pause.js');
const runSrc = read(RUN_JS) || '';
const pauseSrc = read(PAUSE_JS) || '';

let pausemod = null;
try { pausemod = require(PAUSE_JS); } catch { /* reported below */ }
check('runner/pause.js is requirable', pausemod !== null);
const createPauseGate = pausemod && pausemod.createPauseGate;
check('runner/pause.js exports createPauseGate', typeof createPauseGate === 'function');

// runner/run.js must stay requirable without running (repo-teq's guard); probe it out of
// process first, because if main() runs at load it exits and kills this file mid-way.
const probe = spawnSync(process.execPath, [
  '-e', 'const m = require(process.argv[1]); process.stdout.write(JSON.stringify(Object.keys(m||{})));', RUN_JS,
], { encoding: 'utf8', timeout: 30000 });
let runKeys = [];
try { runKeys = JSON.parse(probe.stdout || '[]'); } catch { /* reported below */ }
check('runner/run.js is still requirable without running', !!probe && probe.status === 0);
check('runner/run.js exports runOneTask', Array.isArray(runKeys) && runKeys.includes('runOneTask'));
let runmod = null;
if (probe && probe.status === 0) { try { runmod = require(RUN_JS); } catch { /* below */ } }

const gateOr = (g) => (g && typeof g.reportLimit === 'function' ? g : null);
const LOG = { info() {}, error() {} };
const CFG = { probeIntervalMinutes: 15, maxPauseCycles: 96 };

// =====================================================================================
// C1 — the gate exists, and its DEFAULT wait really is waitForWindow
// =====================================================================================
// Built with NO waitFn. sleepFn is injected so nothing really sleeps; the status carries a
// reset time in the past, which is waitForWindow's reset-time path. That path returns
// {resumed:true, pauses: spent+1} — so cycles must read 1 then 2. No stub can fake this:
// a gate reading `.cycles` off the result gets undefined, and a no-op default never
// advances at all.
async function c1() {
  if (typeof createPauseGate !== 'function') { check('C1 the gate is constructible', false); return; }
  const past = new Date(Date.now() - 60000).toISOString();
  const gate = createPauseGate(CFG, LOG, { sleepFn: noSleep });
  const first = await gate.reportLimit({ rateLimitResetAt: past }, 'c1-a');
  check('C1 the default waitFn is the real waitForWindow (first cycle is 1)',
    !!first && first.resumed === true && first.cycles === 1);
  check('C1 gate.cycles tracks it', gate.cycles === 1);
  const second = await gate.reportLimit({ rateLimitResetAt: past }, 'c1-b');
  check('C1 the run-level count carries into the real waitForWindow (second cycle is 2)',
    !!second && second.resumed === true && second.cycles === 2);
  check('C1 two separate waits were opened', gate.waits === 2);
}

// =====================================================================================
// C2 — one shared wait: opened by the first, joined by later ones, never extended
// =====================================================================================
async function c2() {
  if (typeof createPauseGate !== 'function') { check('C2 the gate is constructible', false); return; }
  const calls = [];
  let release;
  const pending = new Promise((r) => { release = r; });
  const waitFn = (...args) => { calls.push(args); return pending; };
  const gate = createPauseGate(CFG, LOG, { waitFn, token: 'tok-c2' });

  const statusA = { rateLimitResetAt: '2026-01-01T00:00:00.000Z', tag: 'A' };
  const statusB = { rateLimitResetAt: '2027-01-01T00:00:00.000Z', tag: 'B' };
  const statusC = { tag: 'C' };
  // All three in ONE synchronous tick — the join decision is made on entry, before any await.
  const p1 = gate.reportLimit(statusA, 'tr-a');
  const p2 = gate.reportLimit(statusB, 'tr-b');
  const p3 = gate.reportLimit(statusC, 'tr-c');
  await drain();

  check('C2 three reports in one tick open exactly one wait', calls.length === 1 && gate.waits === 1);
  check('C2 the first reporter\'s status governs, by object identity',
    calls.length === 1 && calls[0][1] === statusA);
  check('C2 the later reporters\' statuses are never passed to a wait',
    !calls.some((c) => c[1] === statusB || c[1] === statusC));
  check('C2 the token reaches the wait', calls.length === 1 && calls[0][4] && calls[0][4].token === 'tok-c2');

  release({ resumed: true, pauses: 1 });
  const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
  check('C2 one resolution settles all three reporters',
    !!r1 && !!r2 && !!r3 && r1.resumed === true && r2.resumed === true && r3.resumed === true);
  check('C2 the opener is not marked joined, the other two are',
    r1.joined === false && r2.joined === true && r3.joined === true);
  check('C2 the wait was never re-opened while it was in flight', calls.length === 1);

  // A report AFTER the wait settled opens a fresh one — resolution 3's self-correction.
  const statusD = { rateLimitResetAt: '2028-01-01T00:00:00.000Z', tag: 'D' };
  let release2;
  const pending2 = new Promise((r) => { release2 = r; });
  calls.length = 1;
  const gate2Wait = gate;
  void gate2Wait;
  const p4 = gate.reportLimit(statusD, 'tr-d');
  await drain();
  check('C2 a report after the wait settled opens a second wait',
    calls.length === 2 && gate.waits === 2 && calls[1][1] === statusD);
  release2({ resumed: true, pauses: 2 });
  // resolve whatever promise the gate is actually holding
  release({ resumed: true, pauses: 2 });
  await Promise.race([p4, new Promise((r) => setTimeout(r, 50))]);
}

// =====================================================================================
// C3 — one run-level counter, carried across tasks; a failed wait exhausts without
//      losing the count
// =====================================================================================
async function c3() {
  if (typeof createPauseGate !== 'function') { check('C3 the gate is constructible', false); return; }
  const cfg = { probeIntervalMinutes: 15, maxPauseCycles: 2 };
  const seen = [];
  const waitFn = (c, s, l, t, o) => {
    seen.push(o);
    return Promise.resolve({ resumed: true, pauses: (o.spentCycles || 0) + 1 });
  };
  const gate = createPauseGate(cfg, LOG, { waitFn, token: 'tok-c3' });

  const a = await gate.reportLimit({ tag: 'a' }, 'tr-a');
  const b = await gate.reportLimit({ tag: 'b' }, 'tr-b');
  const c = await gate.reportLimit({ tag: 'c' }, 'tr-c');

  check('C3 the first wait starts at zero spent cycles', seen.length >= 1 && seen[0].spentCycles === 0);
  check('C3 the cap handed to the wait is the configured one, not pause.js\'s 96',
    seen.length >= 1 && seen[0].maxPauses === 2);
  check('C3 the count carries across DIFFERENT tasks', seen.length >= 2 && seen[1].spentCycles === 1);
  check('C3 the first two reports resumed', !!a && a.resumed === true && !!b && b.resumed === true);
  check('C3 the third report is refused once the run-level cap is spent',
    !!c && c.resumed === false && c.exhausted === true);
  check('C3 the refusal names a reason, asserted structurally not by phrase',
    !!c && typeof c.reason === 'string' && c.reason.length > 0);
  check('C3 the cap short-circuits — no third wait was opened', seen.length === 2);
  check('C3 gate.exhausted latches', gate.exhausted === true);
  check('C3 the token reaches every wait', seen.every((o) => o.token === 'tok-c3'));

  // A waitFn that FAILS carries no count at all (waitForWindow's resumed:false shape).
  const gate2 = createPauseGate(CFG, LOG, {
    waitFn: () => Promise.resolve({ resumed: true, pauses: 4 }),
  });
  await gate2.reportLimit({ tag: 'x' }, 'tr-x');
  check('C3 a successful wait sets the run-level count from `pauses`', gate2.cycles === 4);
  const gate3 = createPauseGate(CFG, LOG, {
    waitFn: () => Promise.resolve({ resumed: false, reason: 'x' }),
  });
  const failed3 = await gate3.reportLimit({ tag: 'y' }, 'tr-y');
  check('C3 a failed wait exhausts the gate', gate3.exhausted === true && failed3.resumed === false);
  check('C3 a failed wait leaves the count unchanged — never NaN, never reset',
    gate3.cycles === 0);
}

// =====================================================================================
// C4 — admission has exactly three states
// =====================================================================================
async function c4() {
  if (typeof createPauseGate !== 'function') { check('C4 the gate is constructible', false); return; }
  const calls = [];
  let release;
  const pending = new Promise((r) => { release = r; });
  const gate = createPauseGate(CFG, LOG, { waitFn: (...a) => { calls.push(a); return pending; } });

  let openSettled = false;
  const openAdmit = gate.admit('tr-x').then((v) => { openSettled = true; return v; });
  await drain();
  check('C4 a fresh gate admits immediately', openSettled === true && (await openAdmit) === true);
  check('C4 admitting on an open gate opens no wait', calls.length === 0 && gate.waits === 0);

  gate.reportLimit({ tag: 'a' }, 'tr-a');
  await drain();
  let joinedA = false; let joinedB = false;
  const admitA = gate.admit('tr-y').then((v) => { joinedA = true; return v; });
  const admitB = gate.admit('tr-y2').then((v) => { joinedB = true; return v; });
  await drain();
  check('C4 admission does not settle while the window is closed', joinedA === false && joinedB === false);
  check('C4 an admit joins the wait, it never opens one', calls.length === 1 && gate.waits === 1);
  release({ resumed: true, pauses: 1 });
  check('C4 both waiting admits settle true from that one wait',
    (await admitA) === true && (await admitB) === true && calls.length === 1);

  const spent = createPauseGate({ probeIntervalMinutes: 15, maxPauseCycles: 1 }, LOG, {
    waitFn: () => Promise.resolve({ resumed: false, reason: 'capped' }),
  });
  await spent.reportLimit({ tag: 'z' }, 'tr-z');
  let refusedSettled = false;
  const refused = spent.admit('tr-z2').then((v) => { refusedSettled = true; return v; });
  await drain();
  check('C4 an exhausted gate refuses immediately', refusedSettled === true && (await refused) === false);
  check('C4 it keeps refusing, for every later caller', (await spent.admit('tr-z3')) === false);
}

// =====================================================================================
// C5 — park admits no new work; it never kills what is running
// =====================================================================================
async function c5() {
  const drainQueue = runmod && runmod.drainQueue;
  if (typeof createPauseGate !== 'function' || typeof drainQueue !== 'function') {
    check('C5 the scheduler and the gate are both drivable', false);
    return;
  }
  let release;
  const pending = new Promise((r) => { release = r; });
  let waits = 0;
  const gate = createPauseGate(CFG, LOG, { waitFn: () => { waits += 1; return pending; } });

  const issues = ['p1', 'p2', 'p3', 'p4'].map((id) => ({ id, title: id, priority: 1 }));
  const events = [];
  const holds = {};
  const taskFn = async (issue) => {
    const admitted = await gate.admit(issue.id);
    events.push({ id: issue.id, ev: 'start', admitted });   // recorded AFTER admit returns
    if (issue.id === 'p1') {
      gate.reportLimit({ rateLimitResetAt: '2026-01-01T00:00:00.000Z' }, 'p1');
      await pending;
    } else if (issue.id === 'p2' || issue.id === 'p3') {
      await new Promise((r) => { holds[issue.id] = r; });
    }
    events.push({ id: issue.id, ev: 'end' });
    return { issueId: issue.id, outcome: `finished-${issue.id}` };
  };

  const run = drainQueue(issues, taskFn, 3);
  await drain();
  const started = (id) => events.some((e) => e.id === id && e.ev === 'start');
  check('C5 the park opened exactly one shared wait', waits === 1);
  check('C5 p4 has not started while the window is closed', !started('p4'));

  // The two live tasks are not killed: they finish on their own while the gate is closed.
  holds.p2(); holds.p3();
  await drain();
  check('C5 a live task is never killed — p2 finished while the gate was closed',
    events.some((e) => e.id === 'p2' && e.ev === 'end'));
  check('C5 a live task is never killed — p3 finished while the gate was closed',
    events.some((e) => e.id === 'p3' && e.ev === 'end'));
  check('C5 p4 still has not started', !started('p4'));

  release({ resumed: true, pauses: 1 });
  const results = await run;
  check('C5 p4 starts once the window reopens', started('p4'));
  check('C5 every task produced its own result',
    Array.isArray(results) && results.length === 4
    && results.every((r, i) => r && r.outcome === `finished-${issues[i].id}`));
}

// =====================================================================================
// C6 — a refused task leaves Beads untouched and still appears in the run report
// =====================================================================================
// runOneTask with an exhausted gate must return BEFORE claim(), so no bd subcommand runs
// at all and the issue stays `open` for the next run — and it must still resolve a row,
// because main()'s .filter(Boolean) would erase a null from run.json entirely.
async function c6() {
  const runOneTask = runmod && runmod.runOneTask;
  if (typeof createPauseGate !== 'function' || typeof runOneTask !== 'function') {
    check('C6 runOneTask is drivable with a gate', false);
    return;
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-i9y-c6-'));
  const argvLog = path.join(tmp, 'bd-argv.log');
  const bdStub = path.join(tmp, 'bd-stub.js');
  fs.writeFileSync(bdStub, [
    "'use strict';",
    "const sfs = require('fs');",
    'try { sfs.appendFileSync(process.env.BD_ARGV_LOG, JSON.stringify(process.argv.slice(1)) + "\\n"); } catch {}',
    "sfs.writeSync(1, '[]');",
    'process.exit(0);',
    '',
  ].join('\n'));
  const prevBd = process.env.PIPELINE_BD_CMD;
  const prevNode = process.env.NODE_OPTIONS;
  process.env.PIPELINE_BD_CMD = process.execPath;
  process.env.NODE_OPTIONS = `--require "${bdStub.split(path.sep).join('/')}"`;
  process.env.BD_ARGV_LOG = argvLog;

  const spent = createPauseGate({ probeIntervalMinutes: 15, maxPauseCycles: 1 }, LOG, {
    waitFn: () => Promise.resolve({ resumed: false, reason: 'capped' }),
  });
  await spent.reportLimit({ tag: 'z' }, 'tr-z');

  const log = {
    info() {}, error() {},
    runId: 'run-i9y-c6',
    trace: (id) => `run-i9y-c6/${id}`,
    taskDir: () => tmp,
    dir: tmp,
  };
  const cfg = {
    targetRepoPath: tmp, targetRepoRemote: 'file:///nonexistent-by-design',
    image: 'unused:local', wallClockMinutes: 60, maxAttempts: 3,
    probeIntervalMinutes: 15, maxPauseCycles: 1, concurrency: 1,
  };
  let row = null;
  let threw = null;
  try { row = await runOneTask(cfg, { id: 'i9y-refused', title: 't', priority: 1 }, log, 'tok', spent); }
  catch (e) { threw = e; }

  check('C6 runOneTask returns rather than throwing when the gate refuses', threw === null);
  check('C6 a refused task still produces a manifest row (never null)',
    !!row && row.issueId === 'i9y-refused');
  check('C6 the row records the paused outcome', !!row && row.outcome === 'paused');
  const bdCalls = (read(argvLog) || '').trim();
  check('C6 Beads is never touched — the issue stays `open` for the next run', bdCalls === '');

  if (prevBd === undefined) delete process.env.PIPELINE_BD_CMD; else process.env.PIPELINE_BD_CMD = prevBd;
  if (prevNode === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = prevNode;
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* disposable */ }
}

// =====================================================================================
// C7 — run.js routes every park through the gate it is given (behavioural + structural)
// =====================================================================================
function c7structural() {
  const code = stripComments(runSrc);
  check('C7 runner/pause.js still exports waitForWindow for the gate to default to',
    /module\.exports\s*=\s*{[^}]*waitForWindow/.test(stripComments(pauseSrc)));
  check('C7 runner/run.js no longer calls waitForWindow directly',
    !/\bwaitForWindow\b/.test(code));
  const gates = callsTo(code, 'createPauseGate');
  const mainAt = code.indexOf('async function main(');
  check('C7 runner/run.js constructs exactly one gate', gates.length === 1);
  check('C7 the gate is built once per RUN, inside main()',
    gates.length === 1 && mainAt !== -1 && gates[0].at > mainAt);
}

async function c7behavioural() {
  const runOneTask = runmod && runmod.runOneTask;
  if (typeof runOneTask !== 'function') { check('C7 runOneTask is drivable', false); return; }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-i9y-c7-'));
  const remote = path.join(tmp, 'remote.git');
  const seed = path.join(tmp, 'seed');
  const g = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8' });
  fs.mkdirSync(seed, { recursive: true });
  spawnSync('git', ['init', '-q', '--bare', '-b', 'main', remote], { encoding: 'utf8' });
  g(null, ['init', '-q', '-b', 'main', seed]);
  fs.writeFileSync(path.join(seed, 'README.md'), 'seed\n');
  fs.writeFileSync(path.join(seed, 'pipeline.config.json'), JSON.stringify({
    verifyCommand: 'sh tools/run-acceptance.sh', defaultBranch: 'main', frozenPaths: [], dependencies: {},
  }, null, 2));
  g(seed, ['add', '-A']);
  g(seed, ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-q', '-m', 'seed']);
  g(seed, ['remote', 'add', 'origin', remote]);
  g(seed, ['push', '-q', 'origin', 'main']);

  const argvLog = path.join(tmp, 'bd-argv.log');
  const bdStub = path.join(tmp, 'bd-stub.js');
  fs.writeFileSync(bdStub, [
    "'use strict';",
    "const sfs = require('fs');",
    'const a = process.argv.slice(1).map(String);',
    'try { sfs.appendFileSync(process.env.BD_ARGV_LOG, JSON.stringify(a) + "\\n"); } catch {}',
    "const sub = a.map((s) => s.replace(/\\\\/g, '/').split('/').pop());",
    "if (sub.includes('show')) {",
    '  sfs.writeSync(1, JSON.stringify([{ id: process.env.BD_ISSUE_ID, title: "t",',
    '    description: "d", acceptance_criteria: "a", design: "DESIGN.md 4.7" }]));',
    "} else { sfs.writeSync(1, '[]'); }",
    'process.exit(0);',
    '',
  ].join('\n'));

  // The exec stub stands in for the container: exit 20, having reported a reset time.
  const execStub = path.join(tmp, 'exec-stub.sh');
  fs.writeFileSync(execStub, [
    '#!/bin/sh',
    'mkdir -p "$RUN_DIR"',
    'printf \'{"issueId":"%s","attempts":[],"rateLimitResetAt":"2026-01-01T00:00:00.000Z"}\\n\' "$ISSUE_ID" > "$RUN_DIR/status.json"',
    'exit 20',
    '',
  ].join('\n'));
  const ghStub = path.join(tmp, 'gh-stub.js');
  fs.writeFileSync(ghStub, "'use strict';process.exit(0);\n");

  const saved = {
    bd: process.env.PIPELINE_BD_CMD, node: process.env.NODE_OPTIONS,
    exec: process.env.PIPELINE_EXEC_STUB, gh: process.env.PIPELINE_GH_CMD,
  };
  process.env.PIPELINE_BD_CMD = process.execPath;
  process.env.NODE_OPTIONS = `--require "${bdStub.split(path.sep).join('/')}"`;
  process.env.BD_ARGV_LOG = argvLog;
  process.env.BD_ISSUE_ID = 'i9y-parked';
  process.env.PIPELINE_EXEC_STUB = execStub;
  process.env.PIPELINE_GH_CMD = `${process.execPath} "${ghStub.split(path.sep).join('/')}"`;

  const reported = [];
  const gate = {
    waits: 0, cycles: 0, exhausted: false,
    admit: async () => true,
    reportLimit: async (status, traceId) => {
      reported.push({ status, traceId });
      return { resumed: false, cycles: 0, joined: false, exhausted: true, reason: 'stop here' };
    },
  };
  const log = {
    info() {}, error() {},
    runId: 'run-i9y-c7', trace: (id) => `run-i9y-c7/${id}`, taskDir: () => tmp, dir: tmp,
  };
  const cfg = {
    targetRepoPath: seed, targetRepoRemote: remote, image: 'unused:local',
    wallClockMinutes: 60, maxAttempts: 3, probeIntervalMinutes: 15,
    maxPauseCycles: 96, concurrency: 1,
  };
  let threw = null;
  try {
    await runOneTask(cfg, { id: 'i9y-parked', title: 't', priority: 1 }, log, 'tok', gate);
  } catch (e) { threw = e; }

  check('C7 runOneTask ran against the injected gate without throwing', threw === null);
  check('C7 an exit-20 task reports its limit to the gate exactly once', reported.length === 1);
  check('C7 the gate is handed the status the container actually wrote',
    reported.length === 1 && !!reported[0].status
    && reported[0].status.rateLimitResetAt === '2026-01-01T00:00:00.000Z');

  for (const [k, v] of [['PIPELINE_BD_CMD', saved.bd], ['NODE_OPTIONS', saved.node],
    ['PIPELINE_EXEC_STUB', saved.exec], ['PIPELINE_GH_CMD', saved.gh]]) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* disposable */ }
}

// =====================================================================================
// C8 [guard] — the strings the unrepairable Docker suites assert still exist
// =====================================================================================
function c8() {
  const runLines = runSrc.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));
  const pauseLines = pauseSrc.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));
  const inEither = (s) => runLines.some((l) => l.includes(s)) || pauseLines.some((l) => l.includes(s));

  // Pinned to run.js SPECIFICALLY: test-runner-pause.sh greps this out of the file by
  // name, and repo-teq's frozen A6 asserts it there. A union would let it move silently.
  check('C8 [guard] `exitCode !== 20` is still on a non-comment line of runner/run.js',
    runLines.some((l) => l.includes('exitCode !== 20')));

  // The suite greps the DIGIT, not the prefix: a run-level counter logged where the
  // per-task relaunch counter belongs would slip past a prefix match.
  check('C8 [guard] the per-task relaunch counter still renders as `(pause 1)` for the first pause',
    runLines.some((l) => l.includes('rate limit hit (pause ')) &&
    runLines.some((l) => /\bpauses\s*\+=\s*1|\bpauses\s*=\s*pauses\s*\+\s*1|\+\+pauses|pauses\+\+/.test(l)));

  // A NEGATIVE assertion in that suite: if this string drifts the check goes vacuously
  // green rather than red, which is the failure CLAUDE.md names by shape.
  check('C8 [guard] `wall-clock budget exhausted` survives the restructure',
    runLines.some((l) => l.includes('wall-clock budget exhausted')));

  for (const s of ['issue stays in_progress', 'active total', 'starting task']) {
    check(`C8 [guard] runner/run.js still carries \`${s}\``, runLines.some((l) => l.includes(s)));
  }
  check('C8 [guard] runner/run.js still renders `exit 0 -> done` from its outcome line',
    runLines.some((l) => l.includes('task finished: exit ') && l.includes('->')));
  for (const s of ['relaunching in a fresh container against the same workspace',
    'giving up on the pause']) {
    check(`C8 [guard] \`${s}\` survives in run.js or pause.js`, inEither(s));
  }
  for (const s of ['paused: waiting until reported reset', 'reset time reached — resuming',
    'no reset time reported; probing every', 'probe still rate-limited', 'probe succeeded']) {
    check(`C8 [guard] runner/pause.js still carries \`${s}\``, pauseLines.some((l) => l.includes(s)));
  }
  // The relaunch count stays PER TASK: report.js and run.schema.json read it and neither
  // is this task's to edit. (fileMemoryNotes/queueSummary/shouldFileMemory are deliberately
  // not repeated here — repo-teq's frozen A6 already guards them.)
  check('C8 [guard] `pauses` is still a manifest row field in runner/run.js',
    runLines.some((l) => /^\s*pauses,\s*$/.test(l) || /\bpauses:\s*pauses\b/.test(l)));
}

// =====================================================================================
(async () => {
  c8();
  c7structural();
  await c1();
  await c2();
  await c3();
  await c4();
  await c5();
  await c6();
  await c7behavioural();
  console.log(failed ? 'repo-i9y: FAILED' : 'repo-i9y: all checks passed');
  process.exit(failed);
})().catch((e) => {
  console.log(`FAIL - repo-i9y: the suite itself threw — ${e && e.stack ? e.stack : e}`);
  console.log('repo-i9y: FAILED');
  process.exit(1);
});
