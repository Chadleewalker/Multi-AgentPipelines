// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0
'use strict';

// The three races fixed by repo-tg8.4, kept in one Docker-free discriminator:
//   1. two pipeline checkouts naming one target contend on one host-global authority;
//   2. two workers acting on the same stale ready snapshot cannot both claim an issue;
//   3. recovery cannot reopen human work or work carrying a different run token.
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const lock = require(path.join(ROOT, 'runner', 'lock.js'));
const queue = require(path.join(ROOT, 'runner', 'queue.js'));
const { recoverStaleIssues, ownedBy } = require(path.join(ROOT, 'runner', 'preflight.js'));

let failed = 0;
let passed = 0;
function check(name, cond, detail = '') {
  console.log(`${cond ? 'ok' : 'FAIL'} - ${name}${!cond && detail ? ` (${detail})` : ''}`);
  if (cond) passed += 1;
  else failed += 1;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'unit-ownership-'));
const savedGlobal = process.env.PIPELINE_GLOBAL_LOCK_DIR;
process.env.PIPELINE_GLOBAL_LOCK_DIR = path.join(tmp, 'host-global');

try {
  // ---- one authority across distinct pipeline checkouts -----------------------------
  const pipelineA = path.join(tmp, 'pipeline-a');
  const pipelineB = path.join(tmp, 'pipeline-b');
  const target = path.join(tmp, 'target');
  for (const p of [pipelineA, pipelineB, target]) fs.mkdirSync(p, { recursive: true });

  const first = lock.acquire(pipelineA, target, 'run-a');
  const rival = lock.acquire(pipelineB, `${target}${path.sep}`, 'run-b');
  check('checkout A acquires the target authority', first.ok === true);
  check('checkout B is refused by the same global authority', rival.ok === false);
  check('the cross-checkout refusal names checkout A run', rival.holder && rival.holder.runId === 'run-a');
  check('the authority path is independent of either pipeline checkout',
    !lock.globalLockPath(target).startsWith(pipelineA) && !lock.globalLockPath(target).startsWith(pipelineB));
  check('the observer mirror remains local to checkout A', fs.existsSync(lock.lockPath(pipelineA, target)));
  check('a refused checkout creates no false ownership mirror', !fs.existsSync(lock.lockPath(pipelineB, target)));

  // An unfinished claim makes clean release preserve a dead-run proof. The next checkout
  // takes over that proof, rather than mass-recovering every in-progress issue it can see.
  lock.recordClaim(first.ownership, 'issue-owned');
  lock.release(pipelineA, target, first.ownership);
  const retained = JSON.parse(fs.readFileSync(lock.globalLockPath(target), 'utf8'));
  check('clean release retains authority while one claim is unfinished', !!retained.releasedAt);
  check('the retained proof names only the issue this run claimed',
    JSON.stringify(retained.claims) === JSON.stringify(['issue-owned']));
  const takeover = lock.acquire(pipelineB, target, 'run-c');
  check('the next checkout takes over the released ownership record', takeover.ok && takeover.tookOver);
  check('takeover carries the exact dead-run token into recovery',
    takeover.ownership.recoveryOwners.some((o) => o.token === first.ownership.token && o.runId === 'run-a'));
  lock.clearRecoveryOwner(takeover.ownership, first.ownership.token);
  lock.release(pipelineB, target, takeover.ownership);
  check('settling the dead owner lets release remove the global authority', !fs.existsSync(lock.globalLockPath(target)));
  check('takeover removes the prior checkout observer mirror', !fs.existsSync(lock.lockPath(pipelineA, target)));

  // ---- stale ready snapshot: compare-and-set claim ----------------------------------
  let claimedActor = null;
  const calls = [];
  const remembered = [];
  const fakeBd = (_cfg, args) => {
    calls.push([...args]);
    const actor = args[args.indexOf('--actor') + 1];
    if (!args.includes('--claim')) return { status: 0 };
    if (claimedActor && claimedActor !== actor) return { status: 1, stderr: 'already claimed' };
    claimedActor = actor;
    return { status: 0 };
  };
  const ownA = { runId: 'race-a', token: 'token-a', actor: 'pipeline-run-a' };
  const ownB = { runId: 'race-b', token: 'token-b', actor: 'pipeline-run-b' };
  const io = { bd: fakeBd, recordClaim: (owner, issueId) => remembered.push([owner.runId, issueId]) };
  const wonA = queue.claim({}, 'same-issue', ownA, io);
  const wonB = queue.claim({}, 'same-issue', ownB, io);
  check('the first contender atomically claims the stale ready row', wonA === true);
  check('the second contender loses instead of idempotently entering in_progress', wonB === false);
  check('both contenders use Beads --claim', calls.length === 2 && calls.every((args) => args.includes('--claim')));
  check('no contender uses the non-atomic status assignment', calls.every((args) => !args.includes('--status')));
  check('the winner writes its unique actor in the claim transaction',
    calls[0].includes('--actor') && calls[0].includes(ownA.actor));
  check('the winner writes owner token metadata in the claim transaction',
    calls[0].includes(`${lock.OWNER_TOKEN_KEY}=${ownA.token}`));
  check('the winner writes run id metadata in the claim transaction',
    calls[0].includes(`${lock.OWNER_RUN_KEY}=${ownA.runId}`));
  check('only the successful contender is recorded in the lock',
    JSON.stringify(remembered) === JSON.stringify([['race-a', 'same-issue']]));

  // A terminal issue may legitimately be reopened after a spec change. Its terminal write
  // must clear the old unique actor/token in the same transaction or a later atomic --claim
  // sees an already-assigned row and refuses it forever.
  const terminalCalls = [];
  const terminalSettled = [];
  const terminal = queue.finish({}, 'rerunnable', { status: 'done', beads: 'closed' }, [], ownA, {
    bd: (_cfg, args) => { terminalCalls.push([...args]); return { status: 0 }; },
    completeClaim: (owner, issueId) => terminalSettled.push([owner.runId, issueId]),
  });
  const terminalArgs = terminalCalls[0] || [];
  check('terminal status and ownership cleanup share one Beads update',
    terminal.ok && terminalCalls.length === 1 && terminalArgs[0] === 'update'
      && terminalArgs.includes('--status') && terminalArgs.includes('closed')
      && terminalArgs.includes('--assignee') && terminalArgs.filter((v) => v === '--unset-metadata').length === 2);
  check('terminal ownership cleanup uses the finishing run actor',
    terminalArgs.includes('--actor') && terminalArgs.includes(ownA.actor));
  check('lock-side ownership settles only after the terminal transaction succeeds',
    JSON.stringify(terminalSettled) === JSON.stringify([['race-a', 'rerunnable']]));

  // ---- exact-token recovery ----------------------------------------------------------
  const dead = { runId: 'dead-run', token: 'dead-token', actor: 'pipeline-run-dead' };
  const metadata = (owner) => ({
    [lock.OWNER_TOKEN_KEY]: owner.token,
    [lock.OWNER_RUN_KEY]: owner.runId,
  });
  const issues = {
    owned: { id: 'owned', status: 'in_progress', assignee: dead.actor, metadata: metadata(dead) },
    human: { id: 'human', status: 'in_progress', assignee: 'Chad Walker', metadata: {} },
    newer: {
      id: 'newer', status: 'in_progress', assignee: 'pipeline-run-new',
      metadata: metadata({ runId: 'new-run', token: 'new-token' }),
    },
    actorMismatch: { id: 'actorMismatch', status: 'in_progress', assignee: 'Chad Walker', metadata: metadata(dead) },
  };
  const writes = [];
  const cleared = [];
  const readJson = (_cfg, args) => {
    if (args[0] === 'list') return { ok: true, data: Object.values(issues).map((i) => ({ id: i.id })) };
    if (args[0] === 'show') return { ok: true, data: [issues[args[1]]] };
    return { ok: false, error: 'unexpected read' };
  };
  const recovered = recoverStaleIssues({}, { info() {} }, 'trace', {
    actor: 'pipeline-run-current',
    recoveryOwners: [dead],
  }, {
    bdJson: readJson,
    bd: (_cfg, args) => { writes.push([...args]); return { status: 0 }; },
    clearRecoveryOwner: (_owner, token) => cleared.push(token),
  });
  check('recovery reopens exactly the issue carrying the dead-run proof',
    JSON.stringify(recovered.recovered) === JSON.stringify(['owned']));
  check('human in-progress work is never reopened', !writes.some((args) => args[1] === 'human'));
  check('a newer run token is never reopened', !writes.some((args) => args[1] === 'newer'));
  check('matching metadata without the unique run actor is insufficient proof',
    !writes.some((args) => args[1] === 'actorMismatch'));
  check('recovery clears status, assignee and both metadata keys in one update',
    writes.length === 1 && writes[0].includes('--status') && writes[0].includes('--assignee')
      && writes[0].filter((v) => v === '--unset-metadata').length === 2);
  check('the dead-run proof is cleared only after all recovery writes succeed',
    JSON.stringify(cleared) === JSON.stringify(['dead-token']));
  check('ownedBy also accepts Beads metadata encoded as JSON text', ownedBy({
    ...issues.owned, metadata: JSON.stringify(issues.owned.metadata),
  }, dead));

  const noClear = [];
  const unreadable = recoverStaleIssues({}, { info() {} }, 'trace', {
    actor: 'pipeline-run-current', recoveryOwners: [dead],
  }, {
    bdJson: () => ({ ok: false, error: 'database unavailable' }),
    clearRecoveryOwner: (_owner, token) => noClear.push(token),
  });
  check('an unreadable queue reports recovery incomplete', unreadable.error === 'database unavailable');
  check('an unreadable queue retains the dead-run proof for retry', noClear.length === 0);
} finally {
  if (savedGlobal === undefined) delete process.env.PIPELINE_GLOBAL_LOCK_DIR;
  else process.env.PIPELINE_GLOBAL_LOCK_DIR = savedGlobal;
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`ownership: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
