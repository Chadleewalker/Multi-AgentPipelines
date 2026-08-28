// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// Unit suite for the per-project run lock — DESIGN.md §4.12 (change-log row `repo-os9`).
// Re-runnable: the sweep picks it up through scripts/test-lock.sh. Its coverage is the
// half of tests/acceptance/repo-os9/ that has to outlive that task — a frozen acceptance
// directory is an artifact of a finished run and is never executed again, but this
// contract has to keep holding, and the failure it prevents is silent: two runners
// draining one Beads queue both claim the same issue and both push a branch for it, with
// nothing anywhere saying so.
//
// Plain Node, no test framework, no Docker, no network: run it as
// `node tests/unit/lock.test.js` from the repo root. One line per check —
// `ok - <label>` / `FAIL - <label>` — and a non-zero exit if any check failed, matching
// tests/acceptance/README.md.
//
// WHERE THIS GOES BEYOND THE FROZEN SUITE, on purpose. The frozen tests reach "a dead
// holder is taken over" by running a real acquire in a child that then exits, which is how
// the situation arises in life — and which a pid-only implementation passes, because the
// dead pid is usually still dead. The interesting failure is the other one: a record whose
// pid reads as ALIVE but cannot be the process that took the lock (recycled after a
// reboot). That is the case the constraint about falsifiable evidence exists for, and it
// is only reachable by planting a record, so it is planted here — against a pid that is
// genuinely alive, so an implementation that trusts `process.kill(pid, 0)` blocks forever
// and this suite says so.
//
// WHAT IT DELIBERATELY DOES NOT COVER. That `runner/run.js` releases at the end of a
// SUCCESSFUL run: reaching the end of `main()` needs a live Docker daemon, an image and a
// Beads database. The abort-at-preflight release is covered below because it needs none of
// those, and the frozen suite drives the real runner for the rest.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const lock = require(path.join(ROOT, 'runner', 'lock.js'));
const { preflight } = require(path.join(ROOT, 'runner', 'preflight.js'));

let failed = 0;
function check(name, cond) {
  console.log(`${cond ? 'ok' : 'FAIL'} - ${name}`);
  if (!cond) failed = 1;
}
const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
const fwd = (p) => p.split(path.sep).join('/');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'unit-lock-'));
const root = path.join(tmp, 'lockroot');
fs.mkdirSync(root, { recursive: true });
const mk = (name) => { const p = path.join(tmp, name); fs.mkdirSync(p, { recursive: true }); return p; };

// A process that is genuinely alive and is not this one. Every "reads as alive" fixture
// below is planted against its pid, so none of them can pass by accident on a pid that
// happens to be free.
const alive = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore' });
const done = (code) => { try { alive.kill(); } catch { /* already gone */ } process.exit(code); };

// ---- identity: one repo, however it was spelled ------------------------------------
const projA = mk('alpha');
const projB = mk('beta');

const first = lock.acquire(root, projA, 'RUN-ONE');
check('a free project is locked', first.ok === true);
check('a first acquisition is not a takeover', first.tookOver === false);

const second = lock.acquire(root, projA, 'RUN-TWO');
check('a second run against the same project is refused', second.ok === false);
check('the refusal names the holding run', !!second.holder && second.holder.runId === 'RUN-ONE');
check('the refusal names the holding pid', !!second.holder && second.holder.pid === process.pid);

check('a trailing separator is the same project',
  lock.acquire(root, `${projA}${path.sep}`, 'RUN-X').ok === false);
// Assembled by hand rather than with path.join, which would normalise it here and leave
// the check unable to fail against an implementation that keys on the raw string.
check('a redundant path segment is the same project',
  lock.acquire(root, `${projA}${path.sep}..${path.sep}${path.basename(projA)}`, 'RUN-X').ok === false);
check('a forward-slash spelling is the same project', lock.acquire(root, fwd(projA), 'RUN-X').ok === false);
if (process.platform === 'win32') {
  // The reference host: configs write `targetRepoPath` with forward slashes while
  // `path.join` produces backslashes, so both spellings genuinely reach one repo.
  check('a backslash spelling is the same project',
    lock.acquire(root, projA.split(path.sep).join('\\'), 'RUN-X').ok === false);
  check('case is not an identity on a case-insensitive filesystem',
    lock.acquire(root, projA.toUpperCase(), 'RUN-X').ok === false);
} else {
  console.log('ok - backslash/case spellings are a Windows-only identity (skipped)');
  console.log('ok - case-insensitive identity is Windows-only (skipped)');
  // The inverse, and the reason the fold is guarded by platform: a backslash is a legal
  // character in a POSIX file name, so folding it there would merge two real repos.
  const oddA = mk('odd-a');
  const oddB = path.join(tmp, 'odd-a\\odd-b');
  fs.mkdirSync(oddB, { recursive: true });
  const odd = lock.acquire(root, oddB, 'RUN-ODD');
  check('a backslash in a POSIX path is a character, not a separator', odd.ok === true);
  lock.release(root, oddB);
  fs.rmSync(oddA, { recursive: true, force: true });
}

// ---- different projects are independent ---------------------------------------------
const other = lock.acquire(root, projB, 'RUN-BETA');
check('a different project takes its own lock', other.ok === true);
check('holding two projects at once is silent', other.tookOver === false);
check('the second project is independently locked', lock.acquire(root, projB, 'RUN-BETA-2').ok === false);
lock.release(root, projB);
const reacquired = lock.acquire(root, projB, 'RUN-BETA-3');
check('releasing frees the project for the next run', reacquired.ok === true);
check('a released lock is not left behind as a stale one', reacquired.tookOver === false);
lock.release(root, projB);

// ---- liveness: what counts as a holder that is gone ---------------------------------
// Each fixture plants a record and asserts what acquire does with it. The pid is the live
// child's in every case, so `process.kill(pid, 0)` alone answers "alive" for all of them.
const plant = (target, rec) => {
  const file = lock.lockPath(root, target);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(rec, null, 2) + '\n');
  return file;
};
const liveRecord = (runId, extra) => ({
  runId,
  pid: alive.pid,
  host: os.hostname(),
  platform: process.platform,
  startedAt: new Date().toISOString(),
  takenAtMs: Date.now(),
  uptimeSeconds: Math.floor(os.uptime()),
  // Null on purpose: an absent start time is what a platform that cannot report one
  // writes, so this fixture is the "pid is all we have" case on EVERY host.
  procStart: null,
  ...extra,
});

const liveProj = mk('live-holder');
plant(liveProj, liveRecord('LIVE-RUN'));
const vsLive = lock.acquire(root, liveProj, 'RUN-CHALLENGER');
check('a holder whose process is alive is not taken over', vsLive.ok === false);
check('the live holder is named', !!vsLive.holder && vsLive.holder.runId === 'LIVE-RUN');

// Reboot, seen from the uptime counter: it only ever resets at boot, so a recorded value
// larger than the current one means this host has restarted since. Without a falsifier
// beside the pid this lock blocks the machine forever — the pid is alive.
const rebootProj = mk('rebooted');
plant(rebootProj, liveRecord('PRE-REBOOT-RUN', { uptimeSeconds: Math.floor(os.uptime()) + 10 * 86400 }));
const vsReboot = lock.acquire(root, rebootProj, 'RUN-AFTER-REBOOT');
check('a lock from before a reboot is taken over even though its pid reads alive',
  vsReboot.ok === true && vsReboot.tookOver === true);
check('the reboot takeover names the run it displaced',
  !!vsReboot.previous && vsReboot.previous.runId === 'PRE-REBOOT-RUN');
lock.release(root, rebootProj);

// The same conclusion from the other direction: a lock that claims to have existed for
// longer than the host has been up was taken before this boot.
const preBootProj = mk('pre-boot');
plant(preBootProj, liveRecord('OLDER-THAN-THE-BOOT', {
  takenAtMs: Date.now() - (os.uptime() * 1000) - (24 * 60 * 60 * 1000),
  uptimeSeconds: 1,
}));
const vsPreBoot = lock.acquire(root, preBootProj, 'RUN-AFTER-BOOT');
check('a lock older than the host uptime is taken over', vsPreBoot.ok === true && vsPreBoot.tookOver === true);
check('that takeover names the run it displaced',
  !!vsPreBoot.previous && vsPreBoot.previous.runId === 'OLDER-THAN-THE-BOOT');
lock.release(root, preBootProj);

// A sleeping host must not read as a rebooted one: mistaking a LIVE holder for a dead one
// is the expensive direction, so the pre-boot test carries a grace period. A lock a minute
// older than the uptime counter is inside it.
const nearProj = mk('near-boot');
plant(nearProj, liveRecord('RECENT-RUN', {
  takenAtMs: Date.now() - (os.uptime() * 1000) - 60000,
  uptimeSeconds: 1,
}));
check('a small uptime discrepancy does not seize a live lock',
  lock.acquire(root, nearProj, 'RUN-IMPATIENT').ok === false);
fs.rmSync(lock.lockPath(root, nearProj), { force: true });

// Linux reports a pid's start time exactly (/proc/<pid>/stat field 22), which is what
// makes a recycled pid decidable rather than merely improbable.
if (process.platform === 'linux') {
  const recycledProj = mk('recycled-pid');
  plant(recycledProj, liveRecord('DIED-LONG-AGO', { procStart: '1' }));
  const vsRecycled = lock.acquire(root, recycledProj, 'RUN-AFTER-RECYCLE');
  check('a pid recycled since the lock was taken is not the holder',
    vsRecycled.ok === true && vsRecycled.tookOver === true);
  check('the recycled-pid takeover names the run it displaced',
    !!vsRecycled.previous && vsRecycled.previous.runId === 'DIED-LONG-AGO');
  lock.release(root, recycledProj);
  const matchProj = mk('matching-start');
  const ticks = /^\d+ \(.*\) (.*)$/.exec(read(`/proc/${alive.pid}/stat`).trim());
  plant(matchProj, liveRecord('STILL-RUNNING', { procStart: ticks[1].trim().split(/\s+/)[19] }));
  check('a pid whose start time still matches is still the holder',
    lock.acquire(root, matchProj, 'RUN-CHALLENGER').ok === false);
  fs.rmSync(lock.lockPath(root, matchProj), { force: true });
} else {
  console.log('ok - exact process start times are a Linux fixture (skipped)');
  console.log('ok - matching process start time is a Linux fixture (skipped)');
}

// A run killed mid-acquire can leave a file nobody can read. Nobody can be shown to hold
// it, so it must not hold the machine either.
const corruptProj = mk('corrupt');
plant(corruptProj, {});
fs.writeFileSync(lock.lockPath(root, corruptProj), '{ not json');
const vsCorrupt = lock.acquire(root, corruptProj, 'RUN-AFTER-CORRUPTION');
check('an unreadable lock record is taken over rather than blocking forever',
  vsCorrupt.ok === true && vsCorrupt.tookOver === true);
lock.release(root, corruptProj);

// ---- release takes only our own ------------------------------------------------------
const foreignProj = mk('foreign');
const foreignFile = plant(foreignProj, liveRecord('SOMEONE-ELSES-RUN'));
lock.release(root, foreignProj);
check('release leaves a lock this process does not hold alone', read(foreignFile) !== null);
check('the untouched foreign lock still refuses the next run',
  lock.acquire(root, foreignProj, 'RUN-THIRD').ok === false);
fs.rmSync(foreignFile, { force: true });
check('releasing a project that is not locked is a no-op, not an error', (() => {
  try { lock.release(root, mk('never-locked')); return true; } catch { return false; }
})());

// ---- across processes ------------------------------------------------------------------
// A lock only one process can see satisfies every check above and protects nothing: the
// two runners this exists to keep apart are two separate `node runner/run.js` processes.
const childEnv = { ...process.env };
delete childEnv.NODE_OPTIONS;                       // no stray preload in the child
const inChild = (target, runId) => {
  const r = spawnSync(process.execPath, ['-e', [
    `const l = require(${JSON.stringify(fwd(path.join(ROOT, 'runner', 'lock.js')))});`,
    `process.stdout.write(JSON.stringify(l.acquire(${JSON.stringify(fwd(root))},`
      + ` ${JSON.stringify(fwd(target))}, ${JSON.stringify(runId)})));`,
  ].join('\n')], { encoding: 'utf8', timeout: 60000, env: childEnv });
  try { return JSON.parse(r.stdout || 'null'); } catch { return null; }
};
const rival = inChild(projA, 'RIVAL-RUN');
check('harness: the rival process answered', rival !== null);
check('a separate process is refused the lock this one holds', !!rival && rival.ok === false);
check('the rival is told which run holds it', !!rival && !!rival.holder && rival.holder.runId === 'RUN-ONE');

const deadProj = mk('dead-owner');
const bequeathed = inChild(deadProj, 'DEAD-RUN');       // takes the lock, then exits
check('harness: the child really took the lock', !!bequeathed && bequeathed.ok === true);
const seized = lock.acquire(root, deadProj, 'RUN-AFTER-DEATH');
check('a lock whose owner exited is taken over', seized.ok === true && seized.tookOver === true);
check('the takeover names the run whose lock was seized',
  !!seized.previous && seized.previous.runId === 'DEAD-RUN');
lock.release(root, deadProj);

// ---- preflight: first gate, and it releases what it took -------------------------------
// A fake repo root whose network scripts record any invocation, and the Beads seam pointed
// at a recorder. Both stay empty: the refusal happens before either is reached.
const fakeRoot = path.join(tmp, 'fakeroot');
fs.mkdirSync(path.join(fakeRoot, 'scripts'), { recursive: true });
const netRecord = path.join(tmp, 'net-record.txt');
fs.writeFileSync(netRecord, '');
for (const name of ['pipeline-net.sh', 'egress-check.sh']) {
  const p = path.join(fakeRoot, 'scripts', name);
  fs.writeFileSync(p, ['#!/bin/sh', `printf '%s %s\\n' '${name}' "$*" >> '${fwd(netRecord)}'`, 'exit 0', ''].join('\n'));
  fs.chmodSync(p, 0o755);
}
// The bd stub is a .js file run through process.execPath, never a `#!/bin/sh` script:
// runner/bd.js spawns PIPELINE_BD_CMD with no shell, and on the Windows host a shell
// script spawned that way fails with EFTYPE — every bd call would then look like a bd
// failure instead of like the no-call being asserted (tests/unit/memory.test.js says the
// same thing at more length).
const bdStub = path.join(tmp, 'bd-stub.js');
const bdArgsLog = path.join(tmp, 'bd-args.log');
fs.writeFileSync(bdArgsLog, '');
fs.writeFileSync(bdStub, [
  "'use strict';",
  "const sfs = require('fs');",
  'sfs.appendFileSync(process.env.BD_ARGS_LOG, JSON.stringify(process.argv.slice(1)) + "\\n");',
  'sfs.writeSync(1, "[]");',
  'process.exit(0);',
  '',
].join('\n'));

const logLines = [];
const mkLog = (runId) => ({
  runId,
  info: (t, m) => logLines.push(String(m)),
  error: (t, m) => logLines.push(String(m)),
});
const cfgFor = (target) => ({
  targetRepoPath: target,
  targetRepoRemote: 'https://example.invalid/x.git',
  image: 'pipeline-nonexistent-lock-suite:local',
  network: 'lock-suite-net',
  proxyName: 'lock-suite-proxy',
  proxyPort: 3128,
  proxyUrl: 'http://lock-suite-proxy:3128',
});

const heldProj = mk('preflight-held');
check('harness: the lock is held before preflight runs',
  lock.acquire(fakeRoot, heldProj, 'RUN-HOLDING-THE-LOCK').ok === true);

const savedBd = process.env.PIPELINE_BD_CMD;
const savedOpts = process.env.NODE_OPTIONS;
process.env.PIPELINE_BD_CMD = process.execPath;
process.env.NODE_OPTIONS = `--require "${fwd(bdStub)}"`;
process.env.BD_ARGS_LOG = bdArgsLog;
let refused;
try { refused = preflight(cfgFor(heldProj), fakeRoot, mkLog('RUN-BEING-REFUSED')); }
catch (e) { refused = { __error: e.message }; }
if (savedBd === undefined) delete process.env.PIPELINE_BD_CMD; else process.env.PIPELINE_BD_CMD = savedBd;
if (savedOpts === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = savedOpts;

check('preflight refuses while another run holds the project', !!refused && refused.ok === false);
const reason = String((refused && refused.reason) || '');
check('the refusal names the project', reason.includes(path.basename(heldProj)));
check('the refusal names the run holding the lock', reason.includes('RUN-HOLDING-THE-LOCK'));
// The flag run.js reads to skip its network teardown: a run refused before anything
// existed must not act on plumbing that belongs to the run that holds the lock.
check('the refusal is marked as a lock refusal, so no teardown follows',
  !!refused && refused.locked === true);
check('the refusal starts no network and runs no egress check', read(netRecord) === '');
check('the refusal writes nothing to Beads', read(bdArgsLog) === '');
// Ordering, without a timer: where Docker is absent — every task container — a lock gate
// that ran second would report the daemon, not the holder. Where Docker is present the
// check is merely consistent, and the frozen suite's end-to-end run covers it there.
check('the lock is reached before the Docker gate', !/Docker daemon/.test(reason));
lock.release(fakeRoot, heldProj);

// An abort at a LATER gate must still leave the project free: the image below cannot
// exist, so preflight fails on every platform — at the image gate where Docker is present,
// at the daemon gate where it is not — after it has already taken the lock.
const abortProj = mk('preflight-abort');
let aborted;
try {
  aborted = preflight(cfgFor(abortProj), fakeRoot, mkLog('RUN-THAT-ABORTS'), {
    verifyRepoIdentity: () => ({ ok: true, remoteName: 'fixture', identity: 'repo:fixture/project' }),
  });
}
catch (e) { aborted = { __error: e.message }; }
check('harness: preflight aborted at a gate after the lock', !!aborted && aborted.ok === false
  && !/is already being run/.test(String(aborted.reason || '')));
const afterAbort = lock.acquire(root === fakeRoot ? root : fakeRoot, abortProj, 'RUN-AFTER-ABORT');
check('a run that aborts at preflight releases its lock', afterAbort.ok === true);
check('the aborted run released rather than abandoning its lock', afterAbort.tookOver === false);
lock.release(fakeRoot, abortProj);

// ---- where the lock file lives -----------------------------------------------------
// Not a frozen part of the interface, but it is the part an operator has to find, and
// `runs/` is git-ignored — a lock written anywhere else would be a committable artifact.
const sample = lock.lockPath(root, projA);
check('the lock lives under the pipeline repo runs/ directory',
  fwd(path.relative(root, sample)).startsWith('runs/'));
check('two projects do not share a lock file', lock.lockPath(root, projA) !== lock.lockPath(root, projB));
check('one project has one lock file whatever the spelling',
  lock.lockPath(root, `${projA}${path.sep}`) === sample);

lock.release(root, projA);
check('the suite left no lock behind', read(sample) === null);

fs.rmSync(tmp, { recursive: true, force: true });
done(failed);
