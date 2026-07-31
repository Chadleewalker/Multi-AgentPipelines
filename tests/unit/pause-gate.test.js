// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// The re-runnable suite for the RUN-LEVEL rate-limit park — DESIGN.md §4.7, §7;
// change-log row `repo-i9y`. Docker-free and network-free: it drives
// runner/pause.js's createPauseGate directly and runner/run.js's exported runOneTask
// through its seams (PIPELINE_BD_CMD, PIPELINE_EXEC_STUB, PIPELINE_GH_CMD,
// targetRepoRemote as a local bare repo).
//
// Why this exists alongside tests/acceptance/repo-i9y/: a frozen acceptance directory is
// the artifact of one finished task and nothing ever runs it again, so coverage that must
// survive later changes to the pause layer lives here, where the sweep finds it
// (repo-dhp-note-2). It re-covers the gate's load-bearing invariants and adds five things
// the frozen suite does not:
//
//   * THE PROBE PATH. The frozen suite only ever drives the reset-time branch, so the
//     run-level counter is never proved to advance across real probe cycles — which is the
//     branch a container that reports no reset time actually takes.
//   * A waitFn THAT THROWS. A rejected wait must exhaust the gate, not hang every admit
//     behind a promise that never settles — a park that deadlocks is worse than a park
//     that stops, because the run never writes its manifest.
//   * A RESULT WITH A JUNK COUNT (`pauses: 'soon'`, NaN, negative). The rule is "read the
//     count from `pauses` and nowhere else"; the failure it guards against is a counter
//     that goes NaN, after which `cycles >= cap` is false forever and the cap can never
//     fire again.
//   * NO SECOND COPY OF THE DEFAULT CAP. pause.js used to hard-code 96 next to config.js's
//     DEFAULTS. Two copies of a bound drift silently, and this one is the only thing
//     stopping an unattended run from parking forever.
//   * ADMIT NEVER OPENS A WAIT, at any volume. Only a reported limit does; an admit that
//     opened one would burn run-level cycles for tasks that never hit a limit at all.
//
// Nothing here turns on wall clock. "Has not settled" is judged by draining the event loop
// with setImmediate — one macrotask turn flushes the whole microtask queue — and ordering
// is judged from an events array. A timing margin is a flake waiting for a loaded machine.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
let failed = 0;
function check(name, cond) {
  console.log(`${cond ? 'ok' : 'FAIL'} - ${name}`);
  if (!cond) failed = 1;
}
const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
const drain = async () => { await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r)); };
const noSleep = async () => {};
const LOG = { info() {}, error() {} };
const CFG = { probeIntervalMinutes: 15, maxPauseCycles: 96 };

const { createPauseGate, waitForWindow } = require(path.join(ROOT, 'runner', 'pause.js'));
const { DEFAULTS } = require(path.join(ROOT, 'runner', 'config.js'));
const runmod = require(path.join(ROOT, 'runner', 'run.js'));

const PAUSE_SRC = read(path.join(ROOT, 'runner', 'pause.js')) || '';
const RUN_SRC = read(path.join(ROOT, 'runner', 'run.js')) || '';
const nonComment = (src) => src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));

// A recorder shaped exactly like waitForWindow's contract: it captures the option bag it
// was handed and resolves whatever the case under test wants.
function recorder(resultFor) {
  const seen = [];
  const fn = (cfg, status, log, traceId, opts) => {
    seen.push({ cfg, status, traceId, opts });
    return Promise.resolve(resultFor(seen.length, opts));
  };
  return { fn, seen };
}

// =====================================================================================
// 1 — the shared wait: one opener, N joiners, never extended
// =====================================================================================
async function sharedWait() {
  let release;
  const pending = new Promise((r) => { release = r; });
  const seen = [];
  const gate = createPauseGate(CFG, LOG, {
    waitFn: (cfg, status, log, traceId, opts) => { seen.push({ status, traceId, opts }); return pending; },
    token: 'tok',
  });

  const first = { rateLimitResetAt: '2026-01-01T00:00:00.000Z', who: 'first' };
  const later = { rateLimitResetAt: '2099-01-01T00:00:00.000Z', who: 'later' };
  const a = gate.reportLimit(first, 'a');
  const b = gate.reportLimit(later, 'b');
  const c = gate.reportLimit(later, 'c');
  await drain();

  check('one wait is opened however many report in the same tick', seen.length === 1 && gate.waits === 1);
  check('the FIRST reporter\'s status governs the wait, by object identity', seen[0].status === first);
  check('a later reporter never extends the wait with its own reset time',
    !seen.some((s) => s.status === later));
  check('the opener\'s trace id is the one the wait is logged under', seen[0].traceId === 'a');
  check('the run\'s token reaches the wait', seen[0].opts.token === 'tok');
  check('the wait is told what the RUN has already spent, not what a task has', seen[0].opts.spentCycles === 0);

  release({ resumed: true, pauses: 1 });
  const [ra, rb, rc] = await Promise.all([a, b, c]);
  check('one resolution settles every reporter', ra.resumed === true && rb.resumed === true && rc.resumed === true);
  check('the opener is not marked joined; the joiners are',
    ra.joined === false && rb.joined === true && rc.joined === true);
  check('every reporter sees the same run-level cycle count', ra.cycles === 1 && rb.cycles === 1 && rc.cycles === 1);
  check('the shared wait was opened exactly once', seen.length === 1 && gate.waits === 1);
  check('gate.cycles is the run-level count', gate.cycles === 1);
  check('a resumed wait does not exhaust the gate', gate.exhausted === false);

  // Resolution 3: a limit reported after the wait settled opens a FRESH wait, carrying the
  // count forward. That is what makes a still-closed window self-correcting.
  const again = { rateLimitResetAt: '2027-01-01T00:00:00.000Z', who: 'again' };
  gate.reportLimit(again, 'd');
  await drain();
  check('a limit reported after the wait settled opens a second wait',
    seen.length === 2 && gate.waits === 2 && seen[1].status === again);
  check('the second wait is told the cycles the first one spent', seen[1].opts.spentCycles === 1);
}

// =====================================================================================
// 2 — one run-level counter, and the cap that bounds it
// =====================================================================================
async function counter() {
  const cfg = { probeIntervalMinutes: 15, maxPauseCycles: 3 };
  const r = recorder((n, opts) => ({ resumed: true, pauses: (opts.spentCycles || 0) + 1 }));
  const gate = createPauseGate(cfg, LOG, { waitFn: r.fn });

  const one = await gate.reportLimit({ t: 1 }, 'task-1');
  const two = await gate.reportLimit({ t: 2 }, 'task-2');
  const three = await gate.reportLimit({ t: 3 }, 'task-3');
  check('the count carries across DIFFERENT tasks rather than restarting',
    r.seen.map((s) => s.opts.spentCycles).join(',') === '0,1,2');
  check('three separate tasks resumed', one.resumed && two.resumed && three.resumed);
  check('the configured cap reaches every wait', r.seen.every((s) => s.opts.maxPauses === 3));
  check('gate.cycles reached the cap', gate.cycles === 3);

  const refused = await gate.reportLimit({ t: 4 }, 'task-4');
  check('the fourth report is refused once the run-level cap is spent',
    refused.resumed === false && refused.exhausted === true);
  check('a refusal is not a join', refused.joined === false);
  check('a refusal names a reason (structural, never a phrase match)',
    typeof refused.reason === 'string' && refused.reason.length > 0);
  check('a refusal opens no wait', r.seen.length === 3 && gate.waits === 3);
  check('gate.exhausted latches', gate.exhausted === true);

  const laterRefusal = await gate.reportLimit({ t: 5 }, 'task-5');
  check('every later reporter is refused too, still without a wait',
    laterRefusal.resumed === false && laterRefusal.exhausted === true && gate.waits === 3);
  check('a refusal still reports the run-level count it stopped at', laterRefusal.cycles === 3);
}

// =====================================================================================
// 3 — the count is read from `pauses` and from nowhere else
// =====================================================================================
// The failure this guards: a counter that goes NaN. `NaN >= cap` is false forever, so the
// cap can never fire again and an unattended run parks until someone kills it.
async function countSource() {
  const cases = [
    ['a result carrying no count at all (waitForWindow\'s resumed:false shape)', { resumed: false, reason: 'nope' }, 0],
    ['a result whose count is a string', { resumed: false, reason: 'nope', pauses: 'soon' }, 0],
    ['a result whose count is NaN', { resumed: false, reason: 'nope', pauses: NaN }, 0],
    ['a result whose count is Infinity', { resumed: false, reason: 'nope', pauses: Infinity }, 0],
    ['a result that is not an object at all', null, 0],
    ['an undefined result', undefined, 0],
  ];
  for (const [name, result, expected] of cases) {
    const gate = createPauseGate(CFG, LOG, { waitFn: () => Promise.resolve(result) });
    const out = await gate.reportLimit({ t: 'x' }, 'tr');
    check(`${name} leaves the count unchanged — never NaN, never reset`,
      gate.cycles === expected && Number.isFinite(gate.cycles));
    check(`${name} exhausts the gate rather than resuming`,
      out.resumed === false && gate.exhausted === true && typeof out.reason === 'string' && out.reason.length > 0);
  }

  // A count that IS a number is taken verbatim, including one that jumped by more than one
  // (the probe path returns the cycle it stopped on, not an increment).
  const jumped = createPauseGate(CFG, LOG, { waitFn: () => Promise.resolve({ resumed: true, pauses: 7 }) });
  const ok = await jumped.reportLimit({ t: 'x' }, 'tr');
  check('a numeric count is taken verbatim from `pauses`', jumped.cycles === 7 && ok.cycles === 7);

  // `cycles` on the result is the gate's own field name; the wait's is `pauses`. An
  // implementation that read `result.cycles` would feed spentCycles undefined forever.
  const wrongField = createPauseGate(CFG, LOG, { waitFn: () => Promise.resolve({ resumed: true, cycles: 5 }) });
  await wrongField.reportLimit({ t: 'x' }, 'tr');
  check('a result carrying only `cycles` is not mistaken for a count', wrongField.cycles === 0);
}

// =====================================================================================
// 4 — a wait that THROWS stops the run-level park; it never deadlocks it
// =====================================================================================
async function waitThrows() {
  const gate = createPauseGate(CFG, LOG, { waitFn: () => Promise.reject(new Error('probe host exploded')) });
  let settled = false;
  const reported = gate.reportLimit({ t: 'x' }, 'tr').then((v) => { settled = true; return v; });
  await drain();
  check('a rejected wait settles the reporter rather than hanging it', settled === true);
  const out = await reported;
  check('a rejected wait exhausts the gate', out.resumed === false && gate.exhausted === true);
  check('a rejected wait names a reason', typeof out.reason === 'string' && out.reason.length > 0);
  check('a rejected wait leaves the count finite', Number.isFinite(gate.cycles) && gate.cycles === 0);

  let admitSettled = false;
  const admitted = gate.admit('tr2').then((v) => { admitSettled = true; return v; });
  await drain();
  check('admission after a rejected wait settles rather than deadlocking behind it', admitSettled === true);
  check('admission after a rejected wait refuses', (await admitted) === false);

  // A synchronous throw is the same case and must not escape into the caller's task body.
  const sync = createPauseGate(CFG, LOG, { waitFn: () => { throw new Error('sync boom'); } });
  let threw = null;
  let syncOut = null;
  try { syncOut = await sync.reportLimit({ t: 'x' }, 'tr'); } catch (e) { threw = e; }
  check('a synchronously throwing wait does not escape reportLimit', threw === null);
  check('a synchronously throwing wait exhausts the gate',
    !!syncOut && syncOut.resumed === false && sync.exhausted === true);
}

// =====================================================================================
// 5 — admission has exactly three states, and NEVER opens a wait
// =====================================================================================
async function admission() {
  let release;
  const pending = new Promise((r) => { release = r; });
  let opened = 0;
  const gate = createPauseGate(CFG, LOG, { waitFn: () => { opened += 1; return pending; } });

  // OPEN: admitted at once, no wait.
  const firstTen = await Promise.all(Array.from({ length: 10 }, (_, i) => gate.admit(`open-${i}`)));
  check('an open gate admits every caller', firstTen.every((v) => v === true));
  check('admission never opens a wait, at any volume', opened === 0 && gate.waits === 0);

  // CLOSED: held, then admitted by the same one wait.
  gate.reportLimit({ t: 'x' }, 'reporter');
  await drain();
  const held = [];
  const holds = Array.from({ length: 4 }, (_, i) =>
    gate.admit(`held-${i}`).then((v) => { held.push(i); return v; }));
  await drain();
  check('admission does not settle while the window is closed', held.length === 0);
  check('a held admit joins the wait rather than opening one', opened === 1 && gate.waits === 1);
  release({ resumed: true, pauses: 1 });
  const settledHolds = await Promise.all(holds);
  check('every held admit settles true from that one wait', settledHolds.every((v) => v === true));
  check('still exactly one wait after four admits joined it', opened === 1 && gate.waits === 1);
  check('the gate reopens once the wait resolves', (await gate.admit('after')) === true);

  // EXHAUSTED: refused, for this caller and every later one, forever.
  const spent = createPauseGate({ probeIntervalMinutes: 15, maxPauseCycles: 1 }, LOG, {
    waitFn: () => Promise.resolve({ resumed: false, reason: 'capped' }),
  });
  await spent.reportLimit({ t: 'x' }, 'tr');
  let refusedSettled = false;
  const refused = spent.admit('r1').then((v) => { refusedSettled = true; return v; });
  await drain();
  check('an exhausted gate refuses within one drain', refusedSettled === true && (await refused) === false);
  const laterRefusals = await Promise.all([spent.admit('r2'), spent.admit('r3'), spent.admit('r4')]);
  check('it keeps refusing every later caller', laterRefusals.every((v) => v === false));
  check('refusing opens no wait', spent.waits === 1);
}

// =====================================================================================
// 6 — the DEFAULT wait really is waitForWindow, over BOTH of its branches
// =====================================================================================
// Built with no waitFn at all. No stub can satisfy this, which is what stops a no-op
// default: a gate that never really waits would pass every injected-recorder check above
// while a real run parked for nothing.
async function realWait() {
  // The reset-time branch: one cycle per wait, counted run-level.
  const past = new Date(Date.now() - 60000).toISOString();
  const byReset = createPauseGate(CFG, LOG, { sleepFn: noSleep });
  const one = await byReset.reportLimit({ rateLimitResetAt: past }, 'r1');
  const two = await byReset.reportLimit({ rateLimitResetAt: past }, 'r2');
  check('the default wait is the real waitForWindow (reset-time branch counts a cycle)',
    one.resumed === true && one.cycles === 1);
  check('the run-level count carries INTO the real waitForWindow', two.resumed === true && two.cycles === 2);
  check('each report opened its own wait once the previous had settled', byReset.waits === 2);

  // The probe branch: no reset time reported, so waitForWindow probes on a cadence and the
  // cycle it stops on is the run-level count. The frozen suite never reaches this branch.
  let probes = 0;
  const opensOnSecond = createPauseGate({ probeIntervalMinutes: 15, maxPauseCycles: 5 }, LOG, {
    sleepFn: noSleep,
    probeFn: () => { probes += 1; return { open: probes >= 2 }; },
  });
  const probed = await opensOnSecond.reportLimit({ attempts: [] }, 'p1');
  check('the probe branch is really taken (probeFn is called)', probes === 2);
  check('the run-level count is the probe cycle the window reopened on',
    probed.resumed === true && probed.cycles === 2 && opensOnSecond.cycles === 2);

  // A window that never reopens: the cap is what stops it, and the failure carries no
  // count — so the run-level counter stays where it was rather than becoming undefined.
  let closedProbes = 0;
  const neverOpens = createPauseGate({ probeIntervalMinutes: 15, maxPauseCycles: 3 }, LOG, {
    sleepFn: noSleep,
    probeFn: () => { closedProbes += 1; return { open: false }; },
  });
  const gaveUp = await neverOpens.reportLimit({ attempts: [] }, 'p2');
  check('the cap bounds the probe loop', closedProbes === 3);
  check('a window that never reopens exhausts the gate rather than looping forever',
    gaveUp.resumed === false && neverOpens.exhausted === true && typeof gaveUp.reason === 'string');
  check('the failure branch carries no count, so the counter is left finite',
    Number.isFinite(neverOpens.cycles) && neverOpens.cycles === 0);
  check('an exhausted gate admits nothing more', (await neverOpens.admit('p3')) === false);
}

// =====================================================================================
// 7 — one copy of the default cap, in config.js's DEFAULTS
// =====================================================================================
// pause.js used to hard-code 96 beside config.js's DEFAULTS. Two copies of a bound drift
// silently, and this bound is the only thing stopping an unattended run parking forever.
async function oneDefault() {
  const r = recorder(() => ({ resumed: true, pauses: 1 }));
  const gate = createPauseGate({ probeIntervalMinutes: 15 }, LOG, { waitFn: r.fn });
  await gate.reportLimit({ t: 'x' }, 'tr');
  check('a cfg naming no cap falls back to config.js\'s DEFAULTS',
    r.seen.length === 1 && r.seen[0].opts.maxPauses === DEFAULTS.maxPauseCycles);
  check('that default is a positive whole number', Number.isInteger(DEFAULTS.maxPauseCycles) && DEFAULTS.maxPauseCycles > 0);
  check('runner/pause.js reads the default from DEFAULTS rather than keeping its own',
    /require\(['"]\.\/config['"]\)/.test(PAUSE_SRC) && /DEFAULTS\.maxPauseCycles/.test(PAUSE_SRC));
  check('runner/pause.js keeps no second copy of the cap literal',
    !nonComment(PAUSE_SRC).some((l) => new RegExp(`\\b${DEFAULTS.maxPauseCycles}\\b`).test(l)));
}

// =====================================================================================
// 8 — runner/run.js: one gate per run, admission before claim
// =====================================================================================
function runShape() {
  const code = nonComment(RUN_SRC).join('\n');
  check('runner/run.js exports runOneTask', typeof runmod.runOneTask === 'function');
  check('runner/run.js still exports drainQueue and executeTask',
    typeof runmod.drainQueue === 'function' && typeof runmod.executeTask === 'function');
  check('runner/run.js no longer waits on a usage window itself', !/\bwaitForWindow\b/.test(code));
  const gates = code.split('createPauseGate(').length - 1;
  const mainAt = code.indexOf('async function main(');
  check('runner/run.js builds exactly one gate', gates === 1);
  check('that gate is built per RUN, inside main()', mainAt !== -1 && code.indexOf('createPauseGate(') > mainAt);
  // The strings scripts/test-runner-pause.sh greps out of run.js BY NAME. That suite needs
  // Docker and cannot run in a task container, so nothing else catches this drifting.
  for (const s of ['exitCode !== 20', 'rate limit hit (pause ', 'wall-clock budget exhausted',
    'giving up on the pause', 'relaunching in a fresh container against the same workspace',
    'issue stays in_progress']) {
    check(`runner/run.js still carries \`${s}\` for the Docker pause suite`, code.includes(s));
  }
}

// =====================================================================================
// 9 — a REFUSED task never touches Beads, and still appears in the run report
// =====================================================================================
// The two populations a run-level park produces are only distinguishable here: a PARKED
// task was claimed and stays in_progress, while a REFUSED one never launched and must stay
// `open` for the next run. That difference is one line of ordering — admit() before
// claim() — and nothing else in the repo asserts it.
async function refusedTask() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'unit-pause-gate-'));
  const argvLog = path.join(tmp, 'bd-argv.log');
  const bdStub = path.join(tmp, 'bd-stub.js');
  // A .js stub spawned through process.execPath, never a #!/bin/sh script: runner/bd.js
  // spawns the seam without a shell, and a shell script fails there with EFTYPE on the
  // Windows host — green in a container, red in the host sweep (repo-dhp-note-1).
  fs.writeFileSync(bdStub, [
    "'use strict';",
    "const sfs = require('fs');",
    'try { sfs.appendFileSync(process.env.BD_ARGV_LOG, JSON.stringify(process.argv.slice(1)) + "\\n"); } catch {}',
    "sfs.writeSync(1, '[]');",
    'process.exit(0);',
    '',
  ].join('\n'));
  const saved = { bd: process.env.PIPELINE_BD_CMD, node: process.env.NODE_OPTIONS };
  process.env.PIPELINE_BD_CMD = process.execPath;
  process.env.NODE_OPTIONS = `--require "${bdStub.split(path.sep).join('/')}"`;
  process.env.BD_ARGV_LOG = argvLog;

  const gate = createPauseGate({ probeIntervalMinutes: 15, maxPauseCycles: 1 }, LOG, {
    waitFn: () => Promise.resolve({ resumed: false, reason: 'capped' }),
  });
  await gate.reportLimit({ t: 'x' }, 'tr');

  const log = {
    info() {}, error() {},
    runId: 'unit-pause-gate', trace: (id) => `unit-pause-gate/${id}`, taskDir: () => tmp, dir: tmp,
  };
  const cfg = {
    targetRepoPath: tmp, targetRepoRemote: 'file:///nonexistent-by-design',
    image: 'unused:local', wallClockMinutes: 60, maxAttempts: 3,
    probeIntervalMinutes: 15, maxPauseCycles: 1, concurrency: 1,
  };
  let row = null;
  let threw = null;
  try { row = await runmod.runOneTask(cfg, { id: 'refused-1', title: 'a refused task', priority: 1 }, log, 'tok', gate); }
  catch (e) { threw = e; }

  check('runOneTask returns rather than throwing when the gate refuses', threw === null);
  check('a refused task produces a manifest row, never null (main filters Boolean)',
    !!row && row.issueId === 'refused-1');
  check('the refused row records the paused outcome', !!row && row.outcome === 'paused');
  check('the refused row carries only fields run.schema.json allows',
    !!row && Object.keys(row).every((k) => ['issueId', 'title', 'outcome', 'attemptNotes'].includes(k)));
  check('Beads is never touched, so the issue stays `open` for the next run',
    (read(argvLog) || '').trim() === '');

  if (saved.bd === undefined) delete process.env.PIPELINE_BD_CMD; else process.env.PIPELINE_BD_CMD = saved.bd;
  if (saved.node === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = saved.node;
  delete process.env.BD_ARGV_LOG;
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* disposable */ }
}

// =====================================================================================
// 10 — an exit-20 task routes its park through the gate it was given
// =====================================================================================
// Behavioural, not a grep: runOneTask reaches Beads, git, gh and the container only through
// seams, so the whole per-task body is drivable without Docker.
async function parkedTask() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'unit-pause-gate-parked-'));
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
  // Stands in for the container: exit 20, having reported a reset time the gate must be
  // handed verbatim. Invoked as `bash <stub>` by executeTask, so a shell script is correct
  // here — the .js rule applies to seams spawned without an interpreter.
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
  process.env.BD_ISSUE_ID = 'parked-1';
  process.env.PIPELINE_EXEC_STUB = execStub;
  process.env.PIPELINE_GH_CMD = `${process.execPath} "${ghStub.split(path.sep).join('/')}"`;

  const reported = [];
  const admits = [];
  const gate = {
    waits: 0, cycles: 0, exhausted: false,
    admit: async (id) => { admits.push(id); return true; },
    reportLimit: async (status, traceId) => {
      reported.push({ status, traceId });
      return { resumed: false, cycles: 0, joined: false, exhausted: true, reason: 'stop here' };
    },
  };
  const log = {
    info() {}, error() {},
    runId: 'unit-pause-gate-parked', trace: (id) => `unit-pause-gate-parked/${id}`, taskDir: () => tmp, dir: tmp,
  };
  const cfg = {
    targetRepoPath: seed, targetRepoRemote: remote, image: 'unused:local',
    wallClockMinutes: 60, maxAttempts: 3, probeIntervalMinutes: 15,
    maxPauseCycles: 96, concurrency: 1,
  };
  let threw = null;
  let row = null;
  try { row = await runmod.runOneTask(cfg, { id: 'parked-1', title: 't', priority: 1 }, log, 'tok', gate); }
  catch (e) { threw = e; }

  check('runOneTask runs against an injected gate without throwing', threw === null);
  check('every task asks the run-level gate for admission first', admits.length === 1);
  check('an exit-20 task reports its limit to the gate exactly once', reported.length === 1);
  check('the gate is handed the status the container actually wrote',
    reported.length === 1 && !!reported[0].status
    && reported[0].status.rateLimitResetAt === '2026-01-01T00:00:00.000Z');
  check('a park the gate refuses to extend ends the task as paused',
    !!row && row.outcome === 'paused');
  check('the PER-TASK relaunch count stays per task in the manifest row',
    !!row && row.pauses === 1);
  check('a parked task WAS claimed, so its issue stays in_progress',
    (read(argvLog) || '').includes('update'));

  for (const [k, v] of [['PIPELINE_BD_CMD', saved.bd], ['NODE_OPTIONS', saved.node],
    ['PIPELINE_EXEC_STUB', saved.exec], ['PIPELINE_GH_CMD', saved.gh]]) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  delete process.env.BD_ARGV_LOG;
  delete process.env.BD_ISSUE_ID;
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* disposable */ }
}

// =====================================================================================
// 11 — through the real scheduler: park admits no new work, and kills nothing running
// =====================================================================================
async function throughTheScheduler() {
  let release;
  const pending = new Promise((r) => { release = r; });
  let waits = 0;
  const gate = createPauseGate(CFG, LOG, { waitFn: () => { waits += 1; return pending; } });

  const issues = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, title: id, priority: 1 }));
  const events = [];
  const holds = {};
  const taskFn = async (issue) => {
    await gate.admit(issue.id);
    events.push(`${issue.id}:start`);          // recorded AFTER admission returns
    if (issue.id === 'a') {
      gate.reportLimit({ rateLimitResetAt: '2026-01-01T00:00:00.000Z' }, 'a');
      await pending;
    } else if (holds[issue.id] === undefined && (issue.id === 'b' || issue.id === 'c')) {
      await new Promise((r) => { holds[issue.id] = r; });
    }
    events.push(`${issue.id}:end`);
    return { issueId: issue.id, outcome: `done-${issue.id}` };
  };

  const run = runmod.drainQueue(issues, taskFn, 3);
  await drain();
  check('a park through the real scheduler opens exactly one shared wait', waits === 1);
  check('no task queued behind the park starts while the window is closed',
    !events.includes('d:start') && !events.includes('e:start'));

  holds.b(); holds.c();
  await drain();
  check('a live task is never killed — b finished while the gate was closed', events.includes('b:end'));
  check('a live task is never killed — c finished while the gate was closed', events.includes('c:end'));
  check('their slots are held, not filled, while the window is closed',
    !events.includes('d:start') && !events.includes('e:start'));

  release({ resumed: true, pauses: 1 });
  const results = await run;
  check('the held tasks start once the window reopens',
    events.includes('d:start') && events.includes('e:start'));
  check('one result per queued issue, in READY-QUEUE order',
    results.length === 5 && results.every((r, i) => r && r.outcome === `done-${issues[i].id}`));
  check('the park opened one wait for the whole drain', waits === 1 && gate.waits === 1);
}

// =====================================================================================
(async () => {
  runShape();
  await sharedWait();
  await counter();
  await countSource();
  await waitThrows();
  await admission();
  await realWait();
  await oneDefault();
  await refusedTask();
  await parkedTask();
  await throughTheScheduler();
  console.log(failed ? 'pause-gate: FAILED' : 'pause-gate: all checks passed');
  process.exit(failed);
})().catch((e) => {
  console.log(`FAIL - pause-gate: the suite itself threw — ${e && e.stack ? e.stack : e}`);
  console.log('pause-gate: FAILED');
  process.exit(1);
});
