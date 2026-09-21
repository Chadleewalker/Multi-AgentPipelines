// Frozen acceptance test — repo-djf.20: portable proof of Windows preparation liveness.
// CRITERION MAP: C1 explicit host-owned platform seam                 -> C1.1-C1.2.
// CRITERION MAP: C2 exact canonical identity + live preparation phase -> C2.1-C2.3.
// CRITERION MAP: C3 dead/stale/recycled shared liveness decisions     -> C3.1-C3.4.
// CRITERION MAP: C4 Windows integration and regression coverage       -> guard.js C4.1-C4.5.
// Every check names its criterion; no check in this file is a guard.
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

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

// The first three reads identify the live wrapper. A later read returns a different PID,
// making a second read distinguishable from projecting the PID out of the one canonical
// process identity. This is deterministic on Linux and never rewrites process.platform.
function changingPidWrapper() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  child.kill = () => {};
  let reads = 0;
  Object.defineProperty(child, 'pid', { enumerable: true, get: () => {
    reads += 1;
    return reads <= 3 ? process.pid : 2147483000;
  } });
  child.stdin = { end: () => setImmediate(() => {
    child.stdout.emit('data', Buffer.from(JSON.stringify({ ok: false, outcome: 'unproven' })));
    child.emit('close', 1);
  }) };
  return { child, reads: () => reads };
}

async function main() {
  const originalPlatform = process.platform;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-djf20-'));
  const root = path.join(tmp, 'preparations');
  const batch = 'repo-djf20-portable-windows';
  const ids = ['repo-djf20-live', 'repo-djf20-dead', 'repo-djf20-stale', 'repo-djf20-recycled'];
  try {
    state.createManifest(root, batch, { issues: ids.map((id) => ({ id })) });

    let platformReads = 0; let startedInput = null; let persisted = null; let whileLive = null;
    const wrapper = changingPidWrapper();
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
    const seams = {
      get platform() { platformReads += 1; return 'win32'; },
      spawn: () => wrapper.child,
      ownership: {}, markPreparationUncertain() {}, clearPreparationUncertain() {},
    };
    const result = await coordinator.runWorker(root, batch, {
      id: ids[0], action: 'author-proof', built: { cfg: {} },
    }, 'fixture.json', recordingState, seams);

    check('C1.1 coordinator consumes the explicit host-owned platform seam as win32',
      platformReads > 0, JSON.stringify({ platformReads, result }));
    check('C1.2 portable Windows proof leaves global process.platform untouched',
      process.platform === originalPlatform,
      JSON.stringify({ before: originalPlatform, after: process.platform }));
    check('C2.1 exact canonical wrapper process object is persisted only at top-level started.process',
      startedInput && startedInput.process && persisted
        && same(persisted.process, startedInput.process)
        && persisted.data.process === undefined,
      JSON.stringify({ pidReads: wrapper.reads(), startedInput, persisted, result }));
    check('C2.2 canonical started.process.pid is the single source for started.pid',
      persisted && persisted.process && persisted.pid === persisted.process.pid
        && persisted.pid === process.pid,
      JSON.stringify({ pidReads: wrapper.reads(), persisted, hostPid: process.pid }));
    check('C2.3 matching live wrapper reports its active authoring phase, not interrupted-unknown',
      whileLive && whileLive.ok && row(whileLive, ids[0]).state === 'authoring'
        && row(whileLive, ids[0]).liveness.worker === 'live',
      JSON.stringify(whileLive && row(whileLive, ids[0])));

    const dead = lock.livenessFields(2147483000);
    const stale = { ...lock.livenessFields(process.pid), releasedAt: new Date().toISOString() };
    const recycled = { ...lock.livenessFields(process.pid), uptimeSeconds: Math.floor(os.uptime()) + 60 };
    const identities = new Map([
      [ids[1], dead], [ids[2], stale], [ids[3], recycled],
    ]);
    for (const [id, identity] of identities) state.writeWorkerStarted(root, batch, id, {
      nonce: nonce(id), pid: identity.pid, phase: id === ids[1] ? 'author-proof' : 'proof', process: identity,
    });
    const decisions = [];
    const derived = state.deriveState(root, batch, { isLive: (identity) => {
      const live = lock.isHolderLive(identity);
      decisions.push({ identity, live });
      return live;
    } });
    check('C3.1 deriveState sends each exact dead, stale, and recycled identity through shared lock.isHolderLive',
      [...identities.values()].every((identity) => decisions.some((seen) => same(seen.identity, identity) && !seen.live)),
      JSON.stringify(decisions));
    check('C3.2 dead identity reports interrupted-unknown on this verifier host',
      row(derived, ids[1]).state === 'interrupted-unknown'
        && same(row(derived, ids[1]).workers[0].started.process, dead),
      JSON.stringify(row(derived, ids[1])));
    check('C3.3 stale identity reports interrupted-unknown on this verifier host',
      row(derived, ids[2]).state === 'interrupted-unknown'
        && same(row(derived, ids[2]).workers[0].started.process, stale),
      JSON.stringify(row(derived, ids[2])));
    check('C3.4 recycled identity reports interrupted-unknown on this verifier host',
      row(derived, ids[3]).state === 'interrupted-unknown'
        && same(row(derived, ids[3]).workers[0].started.process, recycled),
      JSON.stringify(row(derived, ids[3])));
  } finally {
    rmrf(tmp);
  }
}

main().then(() => { process.exitCode = failed; }).catch((error) => {
  check('C1-C3 portable fixture completes', false, error.stack || String(error));
  process.exitCode = 1;
});
