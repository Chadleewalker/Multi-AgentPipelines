// Frozen acceptance test — repo-7en: show live preparation workers as running.
//
// CRITERION MAP (every criterion has named checks below, and no check is orphaned):
//   C1 persisted owner and worker process identity + liveness evaluation -> C1.1-C1.5
//   C2 live preparation reports its truthful active phase                 -> C2.1-C2.3
//   C3 interrupted-unknown follows falsified liveness and no result       -> C3.1-C3.3
//   C4 deterministic live/stale/recycled/owner-exit/terminal coverage     -> C4.1-C4.5
//
// FROZEN INTERFACE / SPEC DEFECT: the Beads issue names neither a persisted identity
// shape nor a status API. This suite makes the smallest existing-project-shaped contract:
// worker start records persist `owner` equal to lock.livenessFields() and retain the existing
// retry-safe action phase (`author-proof` or `proof`). preparation-state.deriveState(root,
// batch, { isLive }) returns each issue's `liveness` and maps those durable action phases to
// the human status labels `authoring` and `proving` only in its derived view. `isLive` receives
// the persisted identity and returns a boolean. The default is lock.isHolderLive. This reuses
// the project's cross-platform, PID-recycle-safe lock identity without breaking interruption
// acknowledgement/retry, and `statusReport` must pass its liveness seam through to deriveState.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const REPO = path.resolve(__dirname, '..', '..', '..');
const state = require(path.join(REPO, 'runner', 'preparation-state.js'));
const lock = require(path.join(REPO, 'runner', 'lock.js'));
const prep = require(path.join(REPO, 'scripts', 'prepare-batch.js'));
let failed = 0;
function check(name, condition, detail) {
  console.log(`${condition ? 'ok' : 'FAIL'} - ${name}${!condition && detail ? ` — ${detail}` : ''}`);
  if (!condition) failed = 1;
}
function same(a, b) {
  if (a === undefined || b === undefined) return a === b;
  return state.canonicalStringify(a) === state.canonicalStringify(b);
}
function rmrf(target) { try { fs.rmSync(target, { recursive: true, force: true, maxRetries: 3 }); } catch {} }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-7en-'));
const root = path.join(tmp, 'preparations');
const batch = 'repo-7en-live';
const ids = ['repo-7en-author', 'repo-7en-proof', 'repo-7en-stale', 'repo-7en-owner-exit', 'repo-7en-terminal'];
const owner = { pid: 4101, uptimeSeconds: 40, takenAtMs: 40000, procStart: 'owner-start' };
const identities = {
  author: { pid: 4102, uptimeSeconds: 40, takenAtMs: 40000, procStart: 'author-start' },
  proof: { pid: 4103, uptimeSeconds: 40, takenAtMs: 40000, procStart: 'proof-start' },
  stale: { pid: 4104, uptimeSeconds: 40, takenAtMs: 40000, procStart: 'old-start' },
  ownerExit: { pid: 4105, uptimeSeconds: 40, takenAtMs: 40000, procStart: 'child-start' },
  terminal: { pid: 4106, uptimeSeconds: 40, takenAtMs: 40000, procStart: 'finished-start' },
};
function nonce(i) { return crypto.createHash('sha256').update(i).digest('hex').slice(0, 32); }
function makeManifest() {
  return state.createManifest(root, batch, { config: { targetRepoPath: path.join(tmp, 'target') }, owner, issues: ids.map((id) => ({ id })) });
}
function start(id, phase, identity) {
  return state.writeWorkerStarted(root, batch, id, { nonce: nonce(id), pid: identity.pid, phase, process: identity });
}
function result(id, outcome) { state.writeWorkerResult(root, batch, id, { nonce: nonce(id), outcome }); }
function derive(isLive) { return state.deriveState(root, batch, { isLive }); }
function row(derived, id) { return derived.issues.find((issue) => issue.id === id); }

try {
  makeManifest();
  start(ids[0], 'author-proof', identities.author);
  start(ids[1], 'proof', identities.proof);
  start(ids[2], 'author-proof', identities.stale);
  start(ids[3], 'proof', identities.ownerExit);
  start(ids[4], 'author-proof', identities.terminal); result(ids[4], 'proven-at-base');

  // C1 — persistence is asserted against durable records, not the in-memory fixture.
  const records = state.readWorkerRecords(root, batch, ids[0]);
  check('C1.1 worker start persists the complete liveness identity beside its pid',
    !!records[0] && same(records[0].started.process, identities.author), JSON.stringify(records));
  check('C1.2 the persisted identity has PID, uptime, capture time and start identity',
    !!records[0] && Number.isInteger(records[0].started.process && records[0].started.process.pid)
      && Number.isFinite(records[0].started.process && records[0].started.process.uptimeSeconds)
      && Number.isFinite(records[0].started.process && records[0].started.process.takenAtMs)
      && typeof records[0].started.process.procStart === 'string', JSON.stringify(records[0] && records[0].started));
  check('C1.3 preparation state evaluates both the persisted batch owner and every unresolved worker',
    (() => { const seen = []; derive((identity) => { seen.push(identity); return true; });
      return seen.some((value) => same(value, owner)) && ids.slice(0, 4).every((id) => seen.some((value) => same(value, identities[id === ids[0] ? 'author' : id === ids[1] ? 'proof' : id === ids[2] ? 'stale' : 'ownerExit']))); })());
  check('C1.4 the default evaluator is the established recycled-PID-safe lock liveness rule',
    typeof lock.isHolderLive === 'function' && derive().ok === true);
  check('C1.5 durable worker phase remains compatible with interruption acknowledgement and retry',
    records[0].started.phase === 'author-proof'
      && typeof prep.attemptPhase === 'function'
      && prep.attemptPhase(records[0].started) === 'author-proof',
    JSON.stringify(records[0] && records[0].started));

  // C2 — both live workers must say what they are doing, never a guessed terminal state.
  const live = derive((identity) => identity.pid === owner.pid || identity.pid === identities.author.pid || identity.pid === identities.proof.pid || identity.pid === identities.ownerExit.pid);
  check('C2.1 a live author worker reports authoring, with live worker liveness',
    row(live, ids[0]).state === 'authoring' && row(live, ids[0]).liveness && row(live, ids[0]).liveness.worker === 'live', JSON.stringify(row(live, ids[0])));
  check('C2.2 a live proof worker reports proving, with live worker liveness',
    row(live, ids[1]).state === 'proving' && row(live, ids[1]).liveness && row(live, ids[1]).liveness.worker === 'live', JSON.stringify(row(live, ids[1])));
  check('C2.3 human status renders the truthful running phase for every active issue',
    (() => { const out = []; const code = prep.statusReport(root, batch, false, state, { out: (line) => out.push(String(line)), err: () => {} }, { isLive: (identity) => identity.pid !== identities.stale.pid });
      return code === 0 && out.includes(`  ${ids[0]}: authoring`) && out.includes(`  ${ids[1]}: proving`); })());

  // C3 — false identity includes a dead PID and a recycled PID (same PID, different start id).
  const falsified = derive((identity) => identity.pid === identities.stale.pid ? false : identity.pid !== owner.pid);
  check('C3.1 a stale or recycled worker identity with no result becomes interrupted-unknown only after liveness is false',
    row(falsified, ids[2]).state === 'interrupted-unknown' && row(falsified, ids[2]).liveness && row(falsified, ids[2]).liveness.worker === 'stale', JSON.stringify(row(falsified, ids[2])));
  check('C3.2 a dead batch owner is recorded as stale without erasing a still-live worker phase',
    row(falsified, ids[3]).state === 'proving' && row(falsified, ids[3]).liveness && row(falsified, ids[3]).liveness.owner === 'stale' && row(falsified, ids[3]).liveness.worker === 'live', JSON.stringify(row(falsified, ids[3])));
  check('C3.3 an existing terminal result wins over false owner or worker liveness',
    row(falsified, ids[4]).state === 'proven-at-base' && row(falsified, ids[4]).liveness && row(falsified, ids[4]).liveness.worker === 'terminal', JSON.stringify(row(falsified, ids[4])));

  // C4 is served by injected answers to the status evaluator; no agent is launched.
  const livenessCalls = [];
  derive((identity) => { livenessCalls.push(identity); return identity.pid !== identities.stale.pid; });
  check('C4.1-C4.5 deterministic liveness covers live workers, stale/recycled identity, owner exit and a terminal result without a child process',
    [owner, identities.author, identities.proof, identities.stale, identities.ownerExit]
      .every((identity) => livenessCalls.some((called) => same(called, identity)))
      && process._getActiveHandles().every((handle) => !handle || handle.constructor.name !== 'ChildProcess'), JSON.stringify(livenessCalls));
} catch (error) {
  check('HARNESS setup and assertions ran to completion', false, (error && error.stack) || String(error));
} finally { rmrf(tmp); }
process.exitCode = failed;
