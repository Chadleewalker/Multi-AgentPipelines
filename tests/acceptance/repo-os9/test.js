// Frozen acceptance test — repo-os9: refuse a second concurrent run against the same
// project (DESIGN.md §4.12). Written before implementation, from the spec alone;
// criteria C1–C5 map 1:1 to the issue's "Done means" list. Plain Node, Docker-free.
//
// Depends on repo-jur. Do not run this file on a host with a live run until repo-jur has
// merged: C5 spawns runner/run.js, whose preflight-failure path calls networkDown, and
// before repo-jur that call tears down the shared pipeline-net. The config C5 writes
// names its own network and proxy explicitly, so once repo-jur is in, the spawned runner
// can only ever remove resources that do not exist.
//
// THE FROZEN INTERFACE:
//   runner/lock.js exports
//     acquire(repoRoot, targetRepoPath, runId)
//       -> { ok: true,  tookOver: <boolean> }        lock is now held by this process
//       -> { ok: false, holder: { runId, pid } }     someone else holds it
//     release(repoRoot, targetRepoPath) -> void
//   and runner/preflight.js acquires it FIRST, before any other gate. First, not merely
//   early: it is the only check that is purely local, and every later gate either probes
//   Docker or writes to Beads. A refusal that arrives after `bd update` has already
//   reset another live run's in_progress issues has not refused anything useful.
//   Where the lock file lives is deliberately NOT frozen — no test here reads it by
//   path. The stale case plants its lock by running a real acquire in a child process
//   that then exits, which is also how the situation arises in life.
//
// WHAT THIS FILE DOES NOT COVER. Criterion 5 says a run ends "success, failure, or
// operator stop". Success and failure are covered below. Operator stop is not: signal
// delivery is not reliably testable on the Windows reference host, and a flaky frozen
// test is worse than an honest gap. That case is caught by the takeover path (C4)
// instead, which is precisely the designed mitigation for a lock whose owner died
// without releasing it.
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
const fwd = (p) => p.split(path.sep).join('/');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-os9-'));
const lockRoot = path.join(tmp, 'lockroot');
fs.mkdirSync(lockRoot, { recursive: true });

// Distinctive basenames: the refusal message has to name the project, and a generic
// name would let a message that names the wrong thing pass.
const projA = path.join(tmp, 'os9-target-alpha');
const projB = path.join(tmp, 'os9-target-beta');
fs.mkdirSync(projA, { recursive: true });
fs.mkdirSync(projB, { recursive: true });

let lock = null;
try { lock = require(path.join(ROOT, 'runner', 'lock.js')); } catch { /* reported next */ }
check('runner/lock.js is requirable', lock !== null);
check('runner/lock.js exports acquire and release',
  !!lock && typeof lock.acquire === 'function' && typeof lock.release === 'function');
if (!lock || typeof lock.acquire !== 'function' || typeof lock.release !== 'function') {
  console.log('FAIL - runner/lock.js missing or incomplete; the remaining checks cannot run');
  process.exit(1);
}
const acquire = (target, runId, root = lockRoot) => {
  try { return lock.acquire(root, target, runId); } catch (e) { return { __error: e.message }; }
};
const release = (target, root = lockRoot) => {
  try { lock.release(root, target); return true; } catch { return false; }
};

// ---- C1: a second run against the same project is refused, and told by whom --------
const first = acquire(projA, 'RUN-ONE');
check('C1 the first run takes the lock', !!first && first.ok === true);
check('C1 the first acquisition is not a takeover', !!first && !first.tookOver);

const second = acquire(projA, 'RUN-TWO');
check('C1 a second run against the same project is refused', !!second && second.ok === false);
check('C1 the refusal names the run that holds the lock',
  !!second && !!second.holder && second.holder.runId === 'RUN-ONE');
check('C1 the refusal names the holding process',
  !!second && !!second.holder && second.holder.pid === process.pid);

// The same project reached by a differently-spelled path is the same project. This is
// the inverse of C3 and the case that actually matters: two runners draining one Beads
// queue is the harm, and nothing stops a second run.config from spelling the same repo
// differently. A lock keyed on the raw string passes every other check here and fails
// this one.
const trailing = acquire(`${projA}/`, 'RUN-THREE');
check('C1 a trailing separator does not create a second identity for one project',
  !!trailing && trailing.ok === false);
if (process.platform === 'win32') {
  // Configs write targetRepoPath with forward slashes (`C:/path/to/Project`) while
  // path.join produces backslashes — so on this host the two spellings genuinely do
  // reach one repo, and an implementation comparing raw strings sees two projects.
  const swapped = acquire(projA.split(path.sep).join('/'), 'RUN-FOUR');
  check('C1 forward and backslash spellings of one path are one project',
    !!swapped && swapped.ok === false);
} else {
  console.log('ok - C1 path-separator spelling check is Windows-only (skipped)');
}

// Cross-process visibility. A lock only a single process can see would satisfy every
// same-process check above while protecting nothing, since the two runners this task
// exists to keep apart are two separate `node runner/run.js` processes.
const rivalCode = [
  `const l = require(${JSON.stringify(fwd(path.join(ROOT, 'runner', 'lock.js')))});`,
  `const r = l.acquire(${JSON.stringify(fwd(lockRoot))}, ${JSON.stringify(fwd(projA))}, 'RIVAL-RUN');`,
  'process.stdout.write(JSON.stringify(r));',
].join('\n');
const rivalEnv = { ...process.env };
delete rivalEnv.NODE_OPTIONS;
const rival = spawnSync(process.execPath, ['-e', rivalCode],
  { encoding: 'utf8', timeout: 60000, env: rivalEnv });
let rivalRes = null;
try { rivalRes = JSON.parse(rival.stdout || 'null'); } catch { /* reported next */ }
check('C1 harness: the rival process ran and answered', rivalRes !== null);
check('C1 a SEPARATE process is refused the lock this process holds',
  !!rivalRes && rivalRes.ok === false);
check('C1 the rival is told which run holds it',
  !!rivalRes && !!rivalRes.holder && rivalRes.holder.runId === 'RUN-ONE');

// ---- C3: different projects are independent ----------------------------------------
const other = acquire(projB, 'RUN-BETA');
check('C3 a run against a different project takes its own lock', !!other && other.ok === true);
check('C3 holding two different projects at once is silent', !!other && !other.tookOver);
const otherAgain = acquire(projB, 'RUN-BETA-2');
check('C3 the second project is still independently locked',
  !!otherAgain && otherAgain.ok === false && otherAgain.holder.runId === 'RUN-BETA');

// ---- C5: releasing frees it, cleanly -----------------------------------------------
release(projB);
const afterRelease = acquire(projB, 'RUN-BETA-3');
check('C5 releasing the lock lets the next run take it',
  !!afterRelease && afterRelease.ok === true);
check('C5 a released lock is not left behind as a stale one to take over',
  !!afterRelease && !afterRelease.tookOver);
release(projB);

// ---- C4: a lock whose owner died is taken over -------------------------------------
// A real acquire in a child process that exits without releasing — the situation a
// killed or crashed run leaves behind. Its pid is dead by the time we look.
const childProj = path.join(tmp, 'os9-target-dead');
fs.mkdirSync(childProj, { recursive: true });
const childCode = [
  `const l = require(${JSON.stringify(fwd(path.join(ROOT, 'runner', 'lock.js')))});`,
  `const r = l.acquire(${JSON.stringify(fwd(lockRoot))}, ${JSON.stringify(fwd(childProj))}, 'DEAD-RUN');`,
  'process.stdout.write(JSON.stringify(r));',
  'process.exit(0);',
].join('\n');
const childEnv = { ...process.env };
delete childEnv.NODE_OPTIONS;                       // no stray preload in the child
const child = spawnSync(process.execPath, ['-e', childCode],
  { encoding: 'utf8', timeout: 60000, env: childEnv });
let childRes = null;
try { childRes = JSON.parse(child.stdout || 'null'); } catch { /* reported next */ }
check('C4 harness: a child process really took the lock and exited',
  !!childRes && childRes.ok === true);

const takeover = acquire(fwd(childProj), 'RUN-AFTER-DEATH');
check('C4 the next run takes over a lock whose owner is gone',
  !!takeover && takeover.ok === true);
check('C4 the takeover is reported, not silent', !!takeover && takeover.tookOver === true);
// Pinned to the value: "tookOver: true" alone is green for an implementation that
// reports a takeover on every acquisition, which would make the flag meaningless in the
// log line criterion 4 asks for. The dead run's id is the independent fact to compare
// against — the test wrote it, so it knows the answer.
check('C4 the takeover names the run whose lock was seized',
  !!takeover && !!takeover.previous && takeover.previous.runId === 'DEAD-RUN');
release(fwd(childProj));

// ---- C1 + C2: preflight refuses, and creates nothing on the way out ----------------
// A fake repo root whose scripts record any invocation, plus the bd seam recording any
// Beads call. Both must stay empty: the refusal has to happen before either is reached.
const fakeRoot = path.join(tmp, 'fakeroot');
fs.mkdirSync(path.join(fakeRoot, 'scripts'), { recursive: true });
const netRecord = path.join(tmp, 'net-record.txt');
for (const name of ['pipeline-net.sh', 'egress-check.sh']) {
  const p = path.join(fakeRoot, 'scripts', name);
  fs.writeFileSync(p, ['#!/bin/sh', `printf '%s %s\\n' '${name}' "$*" >> '${fwd(netRecord)}'`, 'exit 0', ''].join('\n'));
  fs.chmodSync(p, 0o755);
}

// The bd stub: a .js run through process.execPath, never a shell script — runner/bd.js
// spawns PIPELINE_BD_CMD with no shell, and on the Windows host a /bin/sh script
// spawned that way fails with EFTYPE, which would make every bd call look like a bd
// failure instead of like the no-call this test is asserting.
const bdStub = path.join(tmp, 'bd-stub.js');
const bdArgsLog = path.join(tmp, 'bd-args.log');
fs.writeFileSync(bdStub, [
  "'use strict';",
  "const sfs = require('fs');",
  "const spath = require('path');",
  'const argv = process.argv.slice(1);',
  'if (argv.length) argv[0] = spath.basename(argv[0]);',
  'sfs.appendFileSync(process.env.BD_ARGS_LOG, JSON.stringify(argv) + "\\n");',
  'sfs.writeSync(1, "[]");',
  'process.exit(0);',
  '',
].join('\n'));
fs.writeFileSync(bdArgsLog, '');
fs.writeFileSync(netRecord, '');

let pf = null;
try { pf = require(path.join(ROOT, 'runner', 'preflight.js')); } catch { /* reported next */ }
check('runner/preflight.js is requirable', pf !== null && typeof pf.preflight === 'function');

const heldRunId = 'RUN-HOLDING-THE-LOCK';
const lockedProj = path.join(tmp, 'os9-target-locked');
fs.mkdirSync(lockedProj, { recursive: true });

// preflight locks against the pipeline repo root it is given, which is the fake one.
const held = acquire(lockedProj, heldRunId, fakeRoot);
check('C2 harness: the lock is held before preflight is called', !!held && held.ok === true);

const cfgLocked = {
  targetRepoPath: lockedProj,
  targetRepoRemote: 'https://example.invalid/x.git',
  image: 'pipeline-nonexistent-os9:local',
  network: 'os9-net',
  proxyName: 'os9-proxy',
  proxyPort: 3128,
  proxyUrl: 'http://os9-proxy:3128',
};
const logLines = [];
const log = {
  runId: 'RUN-BEING-REFUSED',
  info: (t, m) => logLines.push(String(m)),
  error: (t, m) => logLines.push(String(m)),
};

const savedBd = process.env.PIPELINE_BD_CMD;
const savedOpts = process.env.NODE_OPTIONS;
process.env.PIPELINE_BD_CMD = process.execPath;
process.env.NODE_OPTIONS = `--require "${fwd(bdStub)}"`;
process.env.BD_ARGS_LOG = bdArgsLog;
let refused = null;
try { refused = pf.preflight(cfgLocked, fakeRoot, log); } catch (e) { refused = { __error: e.message }; }
if (savedBd === undefined) delete process.env.PIPELINE_BD_CMD; else process.env.PIPELINE_BD_CMD = savedBd;
if (savedOpts === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = savedOpts;

check('C1 preflight refuses to start while another run holds the project',
  !!refused && refused.ok === false);
const reason = String((refused && refused.reason) || '');
check('C1 the refusal names the project', reason.includes(path.basename(lockedProj)));
check('C1 the refusal names the run that holds the lock', reason.includes(heldRunId));
check('C2 the refusal starts no network and runs no egress check',
  (read(netRecord) || '') === '');
check('C2 the refusal writes nothing to Beads', (read(bdArgsLog) || '') === '');
release(lockedProj, fakeRoot);

// ---- C1 + C2 end to end: the real runner refuses, and leaves the holder alone ------
// Everything above tests the lock module. This tests the thing the criterion actually
// says: starting a run. It is Docker-free only because the lock is taken first — which
// is the point, and if it ever stops being first this check is what notices.
const contended = path.join(tmp, 'os9-target-contended');
fs.mkdirSync(contended, { recursive: true });
const e2eHolder = acquire(contended, 'RUN-HOLDING-E2E', ROOT);
check('C1 harness: the lock is held before the real runner is started',
  !!e2eHolder && e2eHolder.ok === true);

const contendedCfg = path.join(tmp, 'run.config.os9contended.json');
fs.writeFileSync(contendedCfg, JSON.stringify({
  targetRepoPath: contended,
  targetRepoRemote: 'https://example.invalid/x.git',
  image: 'pipeline-nonexistent-os9:local',
  network: 'os9-net',
  proxyName: 'os9-proxy',
  proxyPort: 3128,
}, null, 2));

const runsDir0 = path.join(ROOT, 'runs');
const before0 = new Set(fs.existsSync(runsDir0) ? fs.readdirSync(runsDir0) : []);
const e2eEnv = { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: 'dummy-token-never-used' };
delete e2eEnv.NODE_OPTIONS;
delete e2eEnv.PIPELINE_BD_CMD;
const e2e = spawnSync(process.execPath, [path.join(ROOT, 'runner', 'run.js'), '--config', contendedCfg],
  { encoding: 'utf8', timeout: 300000, cwd: ROOT, env: e2eEnv });
const e2eCreated = (fs.existsSync(runsDir0) ? fs.readdirSync(runsDir0) : []).filter((d) => !before0.has(d));
const e2eLog = e2eCreated.map((d) => read(path.join(runsDir0, d, 'run.log')) || '').join('\n');

check('C1 the runner exits non-zero when the project is already locked', e2e.status !== 0);
check('C1 the runner says which run holds the lock', e2eLog.includes('RUN-HOLDING-E2E'));
check('C1 the runner says which project is locked', e2eLog.includes(path.basename(contended)));
// "Exits immediately" as something a script can check: the gates that come after the
// lock left no trace. An elapsed-time assertion would be flaky under container load.
check('C2 the refusal happens before the Docker gate is reached',
  !/docker daemon reachable/.test(e2eLog) && !/image .* present/.test(e2eLog));

// A refusing run must not damage the lock on its way out — releasing another run's lock
// on exit would hand the project to the third run that asks.
const stillHeld = spawnSync(process.execPath, ['-e', [
  `const l = require(${JSON.stringify(fwd(path.join(ROOT, 'runner', 'lock.js')))});`,
  `process.stdout.write(JSON.stringify(l.acquire(${JSON.stringify(fwd(ROOT))}, ${JSON.stringify(fwd(contended))}, 'RUN-THIRD')));`,
].join('\n')], { encoding: 'utf8', timeout: 60000, env: e2eEnv });
let stillHeldRes = null;
try { stillHeldRes = JSON.parse(stillHeld.stdout || 'null'); } catch { /* reported next */ }
check('C1 the refused run left the holder\'s lock intact',
  !!stillHeldRes && stillHeldRes.ok === false && stillHeldRes.holder &&
  stillHeldRes.holder.runId === 'RUN-HOLDING-E2E');
release(contended, ROOT);
for (const d of e2eCreated) {
  try { fs.rmSync(path.join(runsDir0, d), { recursive: true, force: true }); } catch { /* best effort */ }
}

// ---- C5: a run that ends releases its lock -----------------------------------------
// Drive the real runner far enough to take the lock and then fail: the image named below
// does not exist, so preflight aborts on every platform — with Docker present (the host)
// at the image gate, without it (the container) at the daemon gate. Either way the lock
// must not survive the process.
const realTarget = path.join(tmp, 'os9-target-runner');
fs.mkdirSync(realTarget, { recursive: true });
const cfgFile = path.join(tmp, 'run.config.os9lock.json');
fs.writeFileSync(cfgFile, JSON.stringify({
  targetRepoPath: realTarget,
  targetRepoRemote: 'https://example.invalid/x.git',
  image: 'pipeline-nonexistent-os9:local',
  network: 'os9-net',
  proxyName: 'os9-proxy',
  proxyPort: 3128,
}, null, 2));

const runsDir = path.join(ROOT, 'runs');
const before = new Set(fs.existsSync(runsDir) ? fs.readdirSync(runsDir) : []);
const runnerEnv = { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: 'dummy-token-never-used' };
delete runnerEnv.NODE_OPTIONS;
delete runnerEnv.PIPELINE_BD_CMD;
const runner = spawnSync(process.execPath, [path.join(ROOT, 'runner', 'run.js'), '--config', cfgFile],
  { encoding: 'utf8', timeout: 300000, cwd: ROOT, env: runnerEnv });
const created = (fs.existsSync(runsDir) ? fs.readdirSync(runsDir) : []).filter((d) => !before.has(d));
const runLog = created.map((d) => read(path.join(runsDir, d, 'run.log')) || '').join('\n');

// Prove the runner actually got as far as preflight. Without this, a runner that died
// before ever taking the lock would make the release check below pass vacuously.
check('C5 harness: the runner reached preflight and failed there',
  runner.status !== 0 && /PREFLIGHT FAILED/.test(runLog));
if (!/PREFLIGHT FAILED/.test(runLog)) {
  console.log(`       runner exit=${runner.status}; stderr=${(runner.stderr || '').trim().slice(0, 400)}`);
}
const afterRunner = acquire(realTarget, 'RUN-AFTER-RUNNER', ROOT);
check('C5 a run that ends leaves the project unlocked',
  !!afterRunner && afterRunner.ok === true);
check('C5 the ended run released its lock rather than abandoning it',
  !!afterRunner && !afterRunner.tookOver);
release(realTarget, ROOT);

for (const d of created) {
  try { fs.rmSync(path.join(runsDir, d), { recursive: true, force: true }); } catch { /* best effort */ }
}
release(projA);

process.exit(failed);
