// Frozen acceptance test — repo-djf.16: report live preparation workers truthfully on Windows.
//
// CRITERION MAP (every criterion has named checks, and every check names its criterion):
//   C1 live Windows wrapper + canonical top-level started.process -> C1.1-C1.4
//   C2 dead/stale/recycled identity + shared lock decision        -> C2.1-C2.4
//   C3 focused guards + separate mandatory regression sweep       -> guard.js C3.1-C3.5
// No check in this file is a guard: at least one must be red at the fork point.
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..', '..');
const lock = require(path.join(REPO, 'runner', 'lock.js'));
const state = require(path.join(REPO, 'runner', 'preparation-state.js'));
const coordinator = require(path.join(REPO, 'scripts', 'prepare-batch.js'));
let failed = 0;
function check(name, yes, detail = '') {
  console.log(`${yes ? 'ok' : 'FAIL'} - ${name}${yes || !detail ? '' : ` — ${detail}`}`);
  if (!yes) failed = 1;
}
function same(left, right) {
  return state.canonicalStringify(left) === state.canonicalStringify(right);
}
function nonce(label) {
  return crypto.createHash('sha256').update(label).digest('hex').slice(0, 32);
}
function row(derived, id) {
  return derived.issues.find((issue) => issue.id === id);
}
function rmrf(target) {
  try { fs.rmSync(target, { recursive: true, force: true, maxRetries: 3 }); } catch {}
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-djf16-'));
  const root = path.join(tmp, 'preparations');
  const batch = 'repo-djf16-windows';
  const ids = ['repo-djf16-live', 'repo-djf16-dead', 'repo-djf16-stale', 'repo-djf16-recycled'];
  let wrapper = null;
  try {
    state.createManifest(root, batch, { issues: ids.map((id) => ({ id })) });

    // Exercise the coordinator boundary that creates the identity, the durable writer that
    // stores it, and the default preparation-state/lock decision while the wrapper is alive.
    let startedInput = null; let persisted = null; let whileLive = null;
    const recordingState = {
      ...state,
      createWorkerNonce: () => nonce(ids[0]),
      writeWorkerStarted: (...args) => {
        startedInput = args[3];
        persisted = state.writeWorkerStarted(...args);
        whileLive = state.deriveState(root, batch);
        return persisted;
      },
    };
    const running = coordinator.runWorker(root, batch, {
      id: ids[0], action: 'author-proof', built: { cfg: {} },
    }, 'fixture.json', recordingState, {
      spawn: () => {
        wrapper = spawn(process.execPath, ['-e', 'process.stdin.resume();setInterval(() => {}, 1000)'], {
          stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false,
        });
        return wrapper;
      },
      ownership: {}, markPreparationUncertain() {}, clearPreparationUncertain() {},
    });
    check('C1.1 live Windows coordinator wrapper persists the exact identity at top-level started.process',
      process.platform === 'win32' && persisted && startedInput
        && same(persisted.process, startedInput.process)
        && persisted.data.process === undefined,
      JSON.stringify({ platform: process.platform, startedInput, persisted }));
    check('C1.2 canonical started.process.pid matches started.pid',
      persisted && persisted.process && persisted.process.pid === persisted.pid
        && persisted.pid === wrapper.pid,
      JSON.stringify(persisted));
    check('C1.3 the matching live wrapper reports its active author phase, not interrupted-unknown',
      whileLive && whileLive.ok && row(whileLive, ids[0]).state === 'authoring'
        && row(whileLive, ids[0]).liveness.worker === 'live',
      JSON.stringify(whileLive && row(whileLive, ids[0])));
    let mismatchRejected = false;
    try {
      state.writeWorkerStarted(root, batch, ids[1], {
        nonce: nonce('mismatch'), pid: process.pid, phase: 'proof',
        process: { ...lock.livenessFields(process.pid), pid: process.pid + 1 },
      });
    } catch (error) { mismatchRejected = /match.*pid/i.test(error.message); }
    check('C1.4 writeWorkerStarted refuses a process identity whose pid differs from started.pid',
      mismatchRejected);

    try { wrapper.kill('SIGKILL'); } catch {}
    await running;
    wrapper = null;

    const dead = lock.livenessFields(2147483000);
    const stale = { ...lock.livenessFields(process.pid), releasedAt: new Date().toISOString() };
    // A still-occupied PID paired with a pre-reboot identity is a recycled identity: the PID
    // alone looks alive, but the shared lock decision must reject the recorded generation.
    const recycled = { ...lock.livenessFields(process.pid), uptimeSeconds: Math.floor(os.uptime()) + 60 };
    for (const [id, phase, identity] of [
      [ids[1], 'author-proof', dead],
      [ids[2], 'proof', stale],
      [ids[3], 'proof', recycled],
    ]) state.writeWorkerStarted(root, batch, id, {
      nonce: nonce(id), pid: identity.pid, phase, process: identity,
    });
    const derived = state.deriveState(root, batch);
    check('C2.1 shared lock.isHolderLive rejects each dead, stale, or recycled canonical identity',
      !lock.isHolderLive(dead) && !lock.isHolderLive(stale) && !lock.isHolderLive(recycled),
      JSON.stringify({ dead: lock.isHolderLive(dead), stale: lock.isHolderLive(stale), recycled: lock.isHolderLive(recycled) }));
    check('C2.2 dead PID with no result reports interrupted-unknown from started.process',
      row(derived, ids[1]).state === 'interrupted-unknown'
        && same(row(derived, ids[1]).workers[0].started.process, dead),
      JSON.stringify(row(derived, ids[1])));
    check('C2.3 stale identity with no result reports interrupted-unknown from started.process',
      row(derived, ids[2]).state === 'interrupted-unknown'
        && same(row(derived, ids[2]).workers[0].started.process, stale),
      JSON.stringify(row(derived, ids[2])));
    check('C2.4 recycled PID with no result reports interrupted-unknown from started.process',
      row(derived, ids[3]).state === 'interrupted-unknown'
        && same(row(derived, ids[3]).workers[0].started.process, recycled),
      JSON.stringify(row(derived, ids[3])));
  } finally {
    if (wrapper) try { wrapper.kill('SIGKILL'); } catch {}
    rmrf(tmp);
  }
}

main().then(() => { process.exitCode = failed; }).catch((error) => {
  check('C1-C2 fixture completes', false, error && (error.stack || error.message) || String(error));
});
