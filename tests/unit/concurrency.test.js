// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// The re-runnable suite for the §7 concurrency knob — the bounded worker pool that lets
// ONE runner process work N tasks of one project at once (DESIGN.md §7, §4.12; change-log
// row `repo-teq`). Docker-free and network-free: it drives the exported scheduler directly
// and exercises the execution seam through PIPELINE_EXEC_STUB.
//
// Why this exists alongside tests/acceptance/repo-teq/: a frozen acceptance directory is
// the artifact of one finished task and nothing ever runs it again, so coverage that must
// survive later changes to runner/run.js lives here, where the sweep finds it
// (repo-dhp-note-2). It covers three things the frozen suite does not:
//
//   * THE SEAM IS ASYNCHRONOUS, proved by rendezvous between two real child processes.
//     Under the old spawnSync the first stub gives up waiting for a peer that cannot start
//     until it returns, so the check is discriminating rather than decorative — and it is
//     the whole reason concurrency is observable to a Docker-free test at all.
//   * THE STUB'S ENVIRONMENT CONTRACT is unchanged (ISSUE_ID, TASK_DIR, WORKSPACE,
//     RUN_DIR) and so is the exit-code mapping (124 -> 'killed'). Three Docker suites
//     depend on both and none of them can run in a task container.
//   * THE SCHEDULER'S EDGES: an empty queue, a bound wider than the queue, a bad bound,
//     and a task body that throws.
//
// Concurrency is asserted by rendezvous, never by wall clock: a fixture that cannot
// complete unless N tasks are genuinely in flight is deterministic, where a timing margin
// is a flake waiting for a loaded machine.
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'unit-concurrency-'));
const GIVE_UP_MS = 10000;

// =====================================================================================
// Requirability — main() stays behind `require.main === module`
// =====================================================================================
const RUN_JS = path.join(ROOT, 'runner', 'run.js');
const probe = spawnSync(process.execPath, [
  '-e',
  'const m = require(process.argv[1]); process.stdout.write(JSON.stringify(Object.keys(m || {})));',
  RUN_JS,
], { encoding: 'utf8', timeout: 30000 });
check('runner/run.js is requirable without running (main() is guarded)', probe.status === 0);
let keys = [];
try { keys = JSON.parse(probe.stdout || '[]'); } catch { /* reported by the checks */ }
check('runner/run.js exports drainQueue', keys.includes('drainQueue'));
check('runner/run.js exports executeTask', keys.includes('executeTask'));

// Requiring in-process is only safe once the probe came back clean: an unguarded main()
// would call process.exit(2) on the missing config and this file would report nothing.
let drainQueue = null;
let executeTask = null;
if (probe.status === 0) ({ drainQueue, executeTask } = require(RUN_JS));
check('drainQueue is a function', typeof drainQueue === 'function');
check('executeTask is a function', typeof executeTask === 'function');

// =====================================================================================
// The knob — loaded, defaulted and bounded by name (§7, §4.12)
// =====================================================================================
const { loadConfig, MAX_CONCURRENCY } = require(path.join(ROOT, 'runner', 'config.js'));
check('runner/config.js exports the concurrency ceiling', MAX_CONCURRENCY === 3);

function cfgFile(name, extra) {
  const p = path.join(TMP, name);
  fs.writeFileSync(p, JSON.stringify({
    targetRepoPath: 'C:/nonexistent', targetRepoRemote: 'https://example.invalid/r.git',
    image: 'unused:local', ...extra,
  }, null, 2));
  return p;
}
function loaded(name, extra) {
  try { return { ok: true, cfg: loadConfig(cfgFile(name, extra)) }; }
  catch (e) { return { ok: false, message: e.message }; }
}

const dflt = loaded('run.config.json', {});
check('an unset concurrency defaults to 1', dflt.ok && dflt.cfg.concurrency === 1);
for (const good of [1, 2, MAX_CONCURRENCY]) {
  const r = loaded(`run.config.ok-${good}.json`, { concurrency: good });
  check(`concurrency ${good} loads and wins`, r.ok && r.cfg.concurrency === good);
}
// Every rejection has to NAME the field: the runner's contract with its operator is that
// a bad config fails before anything starts and says which line is wrong.
for (const [label, bad] of [
  ['zero', 0], ['negative', -1], ['above the ceiling', MAX_CONCURRENCY + 1],
  ['fractional', 1.5], ['a string', '2'], ['null', null], ['true', true],
  ['NaN', Number.NaN], ['Infinity', Number.POSITIVE_INFINITY], ['an array', [2]],
]) {
  const r = loaded(`run.config.bad-${label.replace(/\W/g, '-')}.json`, { concurrency: bad });
  check(`${label} concurrency is refused at load time, by name`,
    !r.ok && /concurrency/.test(r.message || ''));
}
// A production tunable is documented where the other tunables are, at its default.
let example = null;
try { example = JSON.parse(read(path.join(ROOT, 'run.config.example.json'))); } catch { /* below */ }
check('run.config.example.json documents concurrency at its default',
  !!example && example.concurrency === 1);

// The manifest field (§7): declared, integer, and NOT required — scripts/test-report.sh
// validates a fixture manifest written before the knob existed.
let schema = null;
try { schema = JSON.parse(read(path.join(ROOT, 'schemas', 'run.schema.json'))); } catch { /* below */ }
const cprop = (schema && schema.properties && schema.properties.concurrency) || null;
check('run.schema.json declares a top-level integer concurrency', !!cprop && cprop.type === 'integer');
check('run.schema.json keeps the manifest root closed', !!schema && schema.additionalProperties === false);
check('run.schema.json does not require concurrency',
  !!schema && (!Array.isArray(schema.required) || !schema.required.includes('concurrency')));
// The supplier half: the value in the manifest comes from the config, not a literal.
const runSrc = read(RUN_JS) || '';
check('runner/run.js supplies cfg.concurrency to the manifest', /\bconcurrency: cfg\.concurrency\b/.test(runSrc));

// =====================================================================================
// The scheduler
// =====================================================================================
const issuesOf = (...ids) => ids.map((id, i) => ({ id, title: `fixture ${id}`, priority: i }));

// A fixture that cannot complete unless RENDEZVOUS_N tasks are in flight together. Returns
// what happened, so both halves — "N really did overlap" and "never more than N" — are
// judged from one run.
async function rendezvous(concurrency, tag, want) {
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
    if ((announced += 1) >= want) release();
    let timer = null;
    const giveUp = new Promise((r) => { timer = setTimeout(() => r('gave-up'), GIVE_UP_MS); });
    const how = await Promise.race([barrier.then(() => 'met'), giveUp]);
    clearTimeout(timer);
    if (how === 'gave-up') gaveUp.push(issue.id);
    inFlight -= 1;
    events.push({ id: issue.id, ev: 'end' });
    return { issueId: issue.id, outcome: 'done' };
  };
  const results = await drainQueue(issues, taskFn, concurrency);
  return { issues, results, events, gaveUp, maxInFlight };
}

async function scheduler() {
  // --- sequential at the default ---
  const seq = await rendezvous(1, 'seq', 2);
  check('at concurrency 1 the drain still completes', seq.results.length === seq.issues.length);
  check('at concurrency 1 nothing overlaps', seq.maxInFlight === 1);
  check('at concurrency 1 the rendezvous fixture gives up (the check discriminates)',
    seq.gaveUp.length > 0);
  check('starts occur in ready-queue order',
    seq.events.filter((e) => e.ev === 'start').map((e) => e.id).join(',')
      === 'seq-1,seq-2,seq-3,seq-4');

  // --- genuinely concurrent, and bounded ---
  const wide = await rendezvous(MAX_CONCURRENCY, 'wide', MAX_CONCURRENCY);
  check(`at concurrency ${MAX_CONCURRENCY} the drain completes`, wide.results.length === wide.issues.length);
  check(`at concurrency ${MAX_CONCURRENCY} no task gave up — they really were in flight together`,
    wide.gaveUp.length === 0);
  check(`the pool is bounded: in-flight peaked at exactly ${MAX_CONCURRENCY}`,
    wide.maxInFlight === MAX_CONCURRENCY);
  const fourth = wide.events.findIndex((e) => e.id === 'wide-4' && e.ev === 'start');
  const firstEnd = wide.events.findIndex((e) => e.ev === 'end');
  check('the queued surplus waits for a slot, not for the drain',
    fourth > -1 && firstEnd > -1 && firstEnd < fourth);

  // --- ready-queue ordering against an inverted fixture ---
  const issues = issuesOf('slow', 'mid', 'fast');
  const delay = { slow: 90, mid: 45, fast: 5 };
  const completion = [];
  const results = await drainQueue(issues, async (issue) => {
    await sleep(delay[issue.id]);
    completion.push(issue.id);
    return { issueId: issue.id, outcome: `outcome-of-${issue.id}` };
  }, MAX_CONCURRENCY);
  check('the inverted fixture really did complete out of order',
    completion.join(',') === 'fast,mid,slow');
  check('results stay in ready-queue order, index-aligned with the queue',
    results.map((r) => r && r.issueId).join(',') === 'slow,mid,fast');
  check('every entry carries its own issue\'s result',
    results.every((r, i) => r && r.outcome === `outcome-of-${issues[i].id}`));

  // --- the task body is told which issue and which slot ---
  const seenArgs = [];
  await drainQueue(issuesOf('x-1', 'x-2'), async (issue, i) => { seenArgs.push(`${issue.id}@${i}`); }, 2);
  check('taskFn receives its issue and its ready-queue index',
    seenArgs.sort().join(',') === 'x-1@0,x-2@1');

  // --- edges ---
  const empty = await drainQueue([], async () => { throw new Error('must not run'); }, MAX_CONCURRENCY);
  check('an empty queue drains to an empty array without calling taskFn',
    Array.isArray(empty) && empty.length === 0);

  let starts = 0;
  const shortQ = await drainQueue(issuesOf('s-1'), async (issue) => { starts += 1; return issue.id; }, MAX_CONCURRENCY);
  check('a bound wider than the queue starts one task per issue and no more',
    starts === 1 && shortQ.join(',') === 's-1');

  // A bad bound cannot reach here through loadConfig, but the scheduler is exported and a
  // future caller could pass anything: fall back to sequential rather than to zero
  // workers, which would hang the run forever.
  for (const bad of [0, -1, undefined, null, 1.5, 'three']) {
    const out = await drainQueue(issuesOf('b-1', 'b-2'), async (issue) => issue.id, bad);
    check(`a bound of ${JSON.stringify(bad)} still drains the queue sequentially`,
      out.join(',') === 'b-1,b-2');
  }

  // A throwing task body propagates, exactly as the sequential loop did — the runner's
  // top-level catch turns it into exit 3. Swallowing it here would report a run as drained
  // when it was not.
  let threw = false;
  try {
    await drainQueue(issuesOf('t-1'), async () => { throw new Error('task body exploded'); }, 1);
  } catch (e) { threw = /task body exploded/.test(e.message); }
  check('a throwing task body propagates out of the drain', threw);
}

// =====================================================================================
// The execution seam — asynchronous, with its environment contract unchanged
// =====================================================================================
// The stub is a POSIX shell script invoked as `bash <stub>`: an EXPLICIT interpreter, so it
// cannot fail with EFTYPE on the Windows host the way a bare `#!/bin/sh` spawn does
// (STATUS defect 9). That invocation is also what three Docker suites already pass.
function writeStub(name, body) {
  const p = path.join(TMP, name);
  fs.writeFileSync(p, `#!/bin/sh\n${body}\n`);
  return p;
}

const fakeLog = { lines: [], info(t, m) { this.lines.push(m); }, error(t, m) { this.lines.push(m); } };

async function execOnce(stub, id, wsDir) {
  const prev = process.env.PIPELINE_EXEC_STUB;
  process.env.PIPELINE_EXEC_STUB = stub;
  try {
    return await executeTask({}, { id }, path.join(TMP, `taskdir-${id}`), fakeLog,
      'trace', { dir: wsDir }, 'token', 1);
  } finally {
    if (prev === undefined) delete process.env.PIPELINE_EXEC_STUB;
    else process.env.PIPELINE_EXEC_STUB = prev;
  }
}

async function seam() {
  const wsDir = path.join(TMP, 'ws');
  fs.mkdirSync(wsDir, { recursive: true });
  fs.mkdirSync(path.join(TMP, 'taskdir-e-1'), { recursive: true });
  fs.mkdirSync(path.join(TMP, 'taskdir-e-2'), { recursive: true });
  fs.mkdirSync(path.join(TMP, 'taskdir-env'), { recursive: true });
  fs.mkdirSync(path.join(TMP, 'taskdir-code'), { recursive: true });
  fs.mkdirSync(path.join(TMP, 'taskdir-kill'), { recursive: true });

  // Two stubs must overlap for either to exit 0. Under spawnSync the first one waits alone
  // for a peer that cannot start until it returns, gives up, and exits 7.
  const meet = path.join(TMP, 'meet');
  fs.mkdirSync(meet, { recursive: true });
  const peerStub = writeStub('peer.sh', [
    ': > "$RV_DIR/$ISSUE_ID"',
    'i=0',
    'while [ "$(ls "$RV_DIR" | wc -l)" -lt 2 ] && [ "$i" -lt 50 ]; do sleep 0.2; i=$((i+1)); done',
    '[ "$(ls "$RV_DIR" | wc -l)" -ge 2 ] || exit 7',
    'exit 0',
  ].join('\n'));
  process.env.RV_DIR = meet;
  const both = await Promise.all([
    execOnce(peerStub, 'e-1', wsDir),
    execOnce(peerStub, 'e-2', wsDir),
  ]);
  delete process.env.RV_DIR;
  check('two stubbed tasks run at the same time — the seam does not block the event loop',
    both.every((r) => r.exitCode === 0));

  // The environment contract three Docker suites depend on, and cannot check from here.
  const envDump = path.join(TMP, 'env.txt');
  const envStub = writeStub('env.sh', [
    `printf 'ISSUE_ID=%s\\nTASK_DIR=%s\\nWORKSPACE=%s\\nRUN_DIR=%s\\nCWD=%s\\n' \\`,
    `  "$ISSUE_ID" "$TASK_DIR" "$WORKSPACE" "$RUN_DIR" "$(pwd)" > "${envDump.replace(/\\/g, '/')}"`,
  ].join('\n'));
  const envRun = await execOnce(envStub, 'env', wsDir);
  const dumped = read(envDump) || '';
  const field = (k) => (new RegExp(`^${k}=(.*)$`, 'm').exec(dumped) || [])[1] || '';
  check('the stub exits 0 and is reported', envRun.exitCode === 0);
  check('the stub is told its ISSUE_ID', field('ISSUE_ID') === 'env');
  check('the stub is told its TASK_DIR', field('TASK_DIR').endsWith('taskdir-env'));
  check('the stub is told its WORKSPACE', field('WORKSPACE').replace(/\\/g, '/').endsWith('/ws'));
  check('the stub is told its RUN_DIR (the workspace .run)', /[\\/]\.run$/.test(field('RUN_DIR')));
  check('the stub runs in the workspace', field('CWD').replace(/\\/g, '/').endsWith('/ws'));

  // The exit-code mapping is the §4.11 input: 124 is the wall-clock kill, everything else
  // is the container's own code and must arrive unchanged (20 is the rate-limit park).
  const twenty = await execOnce(writeStub('twenty.sh', 'exit 20'), 'code', wsDir);
  check('a stub exit code arrives unchanged (20 stays 20, so the pause loop still sees it)',
    twenty.exitCode === 20);
  const killed = await execOnce(writeStub('kill.sh', 'exit 124'), 'kill', wsDir);
  check('exit 124 is still reported as a wall-clock kill', killed.exitCode === 'killed');
}

// =====================================================================================
(async () => {
  if (typeof drainQueue !== 'function' || typeof executeTask !== 'function') {
    check('the runner exports are drivable', false);
  } else {
    await scheduler();
    await seam();
  }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* disposable */ }
  console.log(failed ? 'concurrency: FAILED' : 'concurrency: all checks passed');
  process.exit(failed);
})().catch((e) => {
  console.log(`FAIL - concurrency: the suite itself threw — ${e && e.stack ? e.stack : e}`);
  console.log('concurrency: FAILED');
  process.exit(1);
});
