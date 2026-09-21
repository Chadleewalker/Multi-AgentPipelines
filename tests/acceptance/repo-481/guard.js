// [guard] repo-481: existing authority/gates and positive/negative fixture controls.
// C1 -> R1/R5/R6, G1; C2 -> R2/R3/R4, G2; C3 -> G3/G6/R4;
// C4 -> R3/R5/R7, G1/G2; C5 -> R1/R6/R7, G1; C6 -> G1/G4/G5.
// These helpers reuse the tested production lifecycle world; importing runs no tests.
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const ROOT = path.resolve(__dirname, '../../..');
const H = require(path.join(ROOT, 'tests/acceptance/repo-djf.62/fixture.cjs'));
const { createWorld, P, AUTH, LOCK, json, delay } = H;
const tests = [];
const test = (name, body) => tests.push({ name, body });
async function run(list = tests) {
  let failures = 0;
  for (const { name, body } of list) {
    try { await body(); console.log(`ok - ${name}`); }
    catch (error) { failures++; console.log(`FAIL - ${name}: ${error.stack || error}`); }
  }
  console.log(`${list.length - failures}/${list.length} repo-481 checks passed`);
  process.exitCode = failures ? 1 : 0;
}
async function world(tag, body, options) {
  const w = createWorld(`repo481-${tag}`, options);
  try { await body(w); }
  finally {
    assert(path.resolve(w.root).startsWith(path.resolve(require('os').tmpdir()) + path.sep)
      && path.basename(w.root).startsWith('conveyor62-repo481-'), 'unsafe fixture disposal');
    await w.dispose();
  }
}
function git(w, ...args) {
  const r = cp.spawnSync('git', ['-c', 'safe.directory=*', ...args], {
    cwd: w.target, env: process.env, encoding: 'utf8', timeout: 15000, windowsHide: true,
  });
  assert.strictEqual(r.status, 0, `HARNESS git ${args[0]}: ${r.stderr || r.error}`);
  return r.stdout.trim();
}
function snapshot(dir) {
  const out = {};
  function visit(at) {
    if (!fs.existsSync(at)) return;
    for (const ent of fs.readdirSync(at, { withFileTypes: true })) {
      const file = path.join(at, ent.name);
      assert(!ent.isSymbolicLink(), 'HARNESS unexpected fixture symlink');
      if (ent.isDirectory()) visit(file);
      else out[path.relative(dir, file)] = fs.readFileSync(file).toString('base64');
    }
  }
  visit(dir); return out;
}
function grant(w, extra = {}) {
  const result = AUTH.grant(w.currentOwner.lease,
    { scope: 'implementation', issueId: 'repo-481', ttlMs: 60000, ...extra });
  assert(result.ok, `HARNESS grant: ${JSON.stringify(result)}`); return result.authority;
}

// Actual processes acquire and exit without release. No lock/grant hash is fabricated,
// PID changed, or journal preseeded. The next process must prove the prior owner dead.
function ownerProcess() {
  const fs = require('fs');
  const x = JSON.parse(process.env.REPO481_OWNER);
  const a = require(x.module);
  const held = a.acquire(x.root, x.target, x.id, { reclaim: x.reclaim });
  if (!held.ok) throw new Error(JSON.stringify(held));
  const grants = [];
  if (!x.reclaim) {
    for (const redeem of [false, true]) {
      const g = a.grant(held.lease, { scope: 'implementation', issueId: 'repo-481', ttlMs: 60000 });
      if (!g.ok) throw new Error(JSON.stringify(g));
      if (redeem) {
        const r = a.admit(g.authority, { targetRepoPath: x.target, scope: 'implementation' });
        if (!r.ok) throw new Error(JSON.stringify(r));
      }
      grants.push(g.authority);
    }
  }
  fs.writeFileSync(x.output, JSON.stringify({ lease: held.lease, grants }));
  if (x.release) a.release(x.root, x.target, held.lease);
}
function deadOwner(w, index, reclaim, release = false) {
  const output = path.join(w.root, `owner-${index}.json`);
  const r = cp.spawnSync(process.execPath, ['-e', `(${ownerProcess.toString()})()`], {
    env: { ...process.env, REPO481_OWNER: JSON.stringify({ root: w.root, target: w.target,
      id: `repo481-owner-${index}`, reclaim, release, output, module: path.join(ROOT, 'runner/supervisor') }) },
    encoding: 'utf8', timeout: 15000, windowsHide: true,
  });
  assert.strictEqual(r.status, 0, `HARNESS owner process: ${r.stderr || r.error}`);
  const result = JSON.parse(fs.readFileSync(output, 'utf8'));
  const holder = AUTH.leaseHolder(w.target);
  assert(!holder || holder.live === false, 'HARNESS exited owner still live');
  return result;
}
function recover(w, count = 2) {
  const original = deadOwner(w, 0, false);
  for (let i = 1; i < count; i++) deadOwner(w, i, true);
  const current = w.open({ reclaim: true });
  assert(current.ok, `HARNESS reclaim: ${JSON.stringify(current)}`);
  assert.strictEqual(AUTH.outstanding(w.target).length, 2, 'HARNESS lost grants before assertion');
  return { original, current };
}

// Real preflight and admission; every later boundary is inert and counted. A valid grant
// reaches the identity sentinel. A denial must return before even that first later gate.
// Reload preflight to observe its destructured lock import; restore cache and exports.
async function admission(w, authority) {
  const authorityFile = path.join(w.root, 'presented-authority.json');
  json(authorityFile, authority);
  const events = [];
  const file = require.resolve(path.join(ROOT, 'runner/preflight'));
  const saved = require.cache[file], acquire = LOCK.acquire;
  LOCK.acquire = () => { events.push('target-lock'); throw new Error('HARNESS forbidden target lock'); };
  delete require.cache[file];
  const before = snapshot(process.env.PIPELINE_GLOBAL_LOCK_DIR);
  const targetBefore = snapshot(w.target);
  try {
    const preflight = require(file).preflight;
    const stop = name => () => { events.push(name); throw new Error(`HARNESS forbidden ${name}`); };
    const result = await Promise.resolve(preflight({ targetRepoPath: w.target,
      targetRepoRemote: w.target, provider: 'claude' }, w.root,
    { runId: 'repo481-entry', info() {}, warn() {}, error() {} }, {
      env: { ...process.env, PIPELINE_CHILD_AUTHORITY: authorityFile },
      verifyRepoIdentity: () => { events.push('identity'); return { ok: false, reason: 'fixture boundary reached' }; },
      dockerAvailable: stop('container'), imageExists: stop('image'),
      networkUp: stop('network'), networkDown: stop('network-cleanup'),
      egressCheck: stop('egress'), recoverStaleIssues: stop('tracker'),
      resolveHostShell: stop('shell'),
    }));
    return { result, events, before, after: snapshot(process.env.PIPELINE_GLOBAL_LOCK_DIR),
      targetBefore, targetAfter: snapshot(w.target) };
  } finally {
    LOCK.acquire = acquire; delete require.cache[file]; if (saved) require.cache[file] = saved;
  }
}
function refused(r, label) {
  assert(r.result.childAuthorityRefused && !r.result.ok,
    `${label}: expected authority refusal, got ${JSON.stringify(r.result)}`);
  assert.deepStrictEqual(r.events, [], `${label}: crossed side-effect boundary`);
  assert.deepStrictEqual(r.after, r.before, `${label}: changed host authority`);
  assert.deepStrictEqual(r.targetAfter, r.targetBefore, `${label}: changed target/workspace`);
}
async function failedFeed(w) {
  const p = await w.ready();
  const child = w.feed(); child.ended = true; child.child.emit('exit', 1, null);
  await w.supervisor.tick();
  const row = await w.supervisor.status(p.proposalId);
  assert(row.implementation && row.implementation.operationState === 'attention',
    `HARNESS failed child did not reach attention: ${JSON.stringify(row)}`);
  return { p, child, row, id: row.implementation.operationId };
}
function retryRequest(f) {
  return { proposalId: f.p.proposalId, operationId: f.id, approved: true,
    reason: 'Operator confirms failed predecessor ended; retry this implementation.' };
}
async function retry(w, f, extra = {}) {
  assert.strictEqual(typeof w.supervisor.retry, 'function',
    'MISSING BEHAVIOR: proposal supervisor has no explicit retry entry point (see suite interface defect)');
  const result = await w.supervisor.retry({ ...retryRequest(f), ...extra });
  assert(result && result.ok, `retry refused: ${JSON.stringify(result)}`);
  return result;
}

test('C1 C4 C5 C6 G1 [guard] production lifecycle fixture distinguishes live and successful children', () => world('lifecycle', async w => {
  const p = await w.ready();
  const live = await w.supervisor.status(p.proposalId);
  assert.strictEqual(live.implementation.operationState, 'running');
  const child = w.feed();
  w.completeFeed([{ issueId: p.issueId, outcome: 'done', branch: `task/${p.issueId}`,
    prUrl: 'https://github.com/fixture/lifecycle/pull/481' }]);
  await w.supervisor.tick();
  const row = await w.supervisor.status(p.proposalId);
  assert.strictEqual(row.stage, 'review'); assert.strictEqual(row.verdict, 'pending');
  assert.strictEqual(row.runId, child.runId);
  assert.strictEqual(AUTH.settlementState(w.currentOwner.lease, child.authority.nonce).settled, true);
  w.reconstruct(); await w.supervisor.tick();
  assert.strictEqual(w.children.filter(c => c.kind === 'implementation').length, 1);
  assert.strictEqual(w.settlements.filter(s => s.nonce === child.authority.nonce).length, 1);
}));
test('C2 C4 G2 [guard] real exited-owner fixture permits one reclaim and one terminal settlement', () => world('single-recovery', async w => {
  const { original, current } = recover(w, 1);
  const nonce = original.grants[1].nonce;
  assert(AUTH.settlementState(current.lease, nonce).ok);
  assert(AUTH.settle(current.lease, nonce, { outcome: 'complete' }).ok);
  const before = snapshot(process.env.PIPELINE_GLOBAL_LOCK_DIR);
  assert.strictEqual(AUTH.settle(current.lease, nonce, { outcome: 'complete' }).ok, false);
  assert(AUTH.settlementState(current.lease, nonce).settled);
  assert.deepStrictEqual(snapshot(process.env.PIPELINE_GLOBAL_LOCK_DIR), before);
}));
test('C3 G3 [guard] invalid grants refuse before lock, workspace, container, network and tracker boundaries', () => world('denials', async w => {
  assert(w.open().ok);
  const good = grant(w);
  const positive = await admission(w, good);
  assert.deepStrictEqual(positive.events, ['identity'], 'HARNESS positive admission must reach sentinel');
  assert(!positive.result.childAuthorityRefused, 'HARNESS valid grant was refused');
  await refused(await admission(w, good), 'replayed');
  const fresh = grant(w);
  const cases = [
    ['foreign', { ...fresh, target: path.join(w.root, 'foreign') }],
    ['mismatched-issue', { ...fresh, issueId: 'another-issue' }],
    ['predecessor-parent', { ...fresh, parent: { ...fresh.parent, id: 'previous-owner' } }],
    ['forged', { ...fresh, nonce: 'f'.repeat(48) }],
  ];
  for (const [label, value] of cases) refused(await admission(w, value), label);
  const stale = grant(w, { ttlMs: 1 }); await delay(10);
  refused(await admission(w, stale), 'stale');
  const superseded = grant(w);
  assert(AUTH.settle(w.currentOwner.lease, superseded.nonce, { outcome: 'released' }).ok);
  refused(await admission(w, superseded), 'superseded/released');
  // Negative control for failure setup used by every retry regression.
  const f = await failedFeed(w);
  assert.strictEqual(f.row.runId, f.child.runId);
}));
test('C6 G4 [guard] coordinator exclusion, approval and publication/immutable-suite gates remain enforced', () => world('gates', async w => {
  const p = await w.ready();
  assert.strictEqual(w.open({ reclaim: true }).ok, false, 'live supervisor was displaced');
  assert.strictEqual(LOCK.acquire(w.root, w.target, 'intruder').ok, false);
  assert.strictEqual(w.manager.retry({ project: w.target, id: p.implementation.operationId }).ok, false);
  const child = w.feed();
  w.completeFeed([{ issueId: p.issueId, outcome: 'done', branch: 'task/approved',
    prUrl: 'https://github.com/fixture/lifecycle/pull/482' }]);
  await w.supervisor.tick();
  assert.strictEqual((await w.supervisor.status(p.proposalId)).verdict, 'pending');
  const noApproval = await w.supervisor.decide(p.proposalId, 'merged', '');
  assert.strictEqual(noApproval.ok, false);
  assert(/reason/i.test(noApproval.error));
  const Q = require(path.join(ROOT, 'runner/queue'));
  const cfg = require(path.join(ROOT, 'runner/config')).loadConfig(w.configPath);
  const partition = () => Q.partitionByFreeze(cfg, [{ id: p.issueId }]);
  assert.strictEqual(partition().issues.length, 1, 'HARNESS published receipt positive control');
  const suite = path.join(w.target, 'tests/acceptance', p.issueId, 'test.js');
  fs.appendFileSync(suite, '// tampered fixture suite\n');
  git(w, 'add', '.'); git(w, 'commit', '-qm', 'negative fixture: changed frozen suite');
  const denied = partition();
  assert.strictEqual(denied.issues.length, 0);
  assert.strictEqual(denied.undispatchable[0].refusal, Q.REFUSAL.MISMATCH);
}));
test('C6 G5 [guard] proof without published freeze waits for a person and launches no implementation', () => world('freeze-approval', async w => {
  const record = await w.kickoff(); assert(w.open().ok);
  // Stop publication at its genuine external boundary. Preparation still produces real proof.
  const Q = require(path.join(ROOT, 'runner/queue'));
  const original = Q.partitionByFreeze;
  Q.partitionByFreeze = (_cfg, rows) => ({ ok: true, branch: 'main', issues: [],
    undispatchable: rows.map(issue => ({ issue, refusal: Q.REFUSAL.NO_RECEIPT, reason: 'await human freeze' })) });
  try {
    await w.supervisor.tick(); await w.supervisor.tick();
    const row = await w.supervisor.status(record.id);
    assert.strictEqual(row.stage, 'freezing');
    assert(/person|approv/i.test(row.nextAction));
    assert.strictEqual(w.children.filter(c => c.kind === 'implementation').length, 0);
  } finally { Q.partitionByFreeze = original; }
  await w.supervisor.tick();
  assert.strictEqual((await w.supervisor.status(record.id)).stage, 'implementing');
}));
test('C3 G6 [guard] genuine predecessor grant without a recovery lineage is refused; current grant is admitted',
  () => world('unlinked-parent', async w => {
    const predecessor = deadOwner(w, 0, false, true);
    assert(w.open().ok, 'HARNESS new supervisor could not open released target');
    refused(await admission(w, predecessor.grants[0]), 'unlinked predecessor parent');
    const positive = await admission(w, grant(w));
    assert.deepStrictEqual(positive.events, ['identity']);
    assert(!positive.result.childAuthorityRefused);
  }));
module.exports = { ...H, assert, fs, path, test, run, world, snapshot, grant, recover,
  admission, refused, failedFeed, retryRequest, retry };
if (require.main === module) run();
