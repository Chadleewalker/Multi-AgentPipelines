// Frozen acceptance guard — repo-djf.42. [guard]
// Criteria -> tests: C1 -> test.js T1 + G1 here (classifyBuilt's legacy 2-arg contract);
//                    C2 -> test.js T2 + G2 here (bare `retry` keeps refusing a reclassified
//                    acknowledged suite exactly as it does today — tests/unit/prepare-batch.test.js
//                    "M4" pins the identical fixture and must stay green forever, so the new
//                    explicit resume path in T2 has to be strictly additive, never a replacement);
//                    C3 -> test.js T3; C4 -> test.js T4 + G3 here (the repo-7a0 terminal-result
//                    vocabulary this suite's classifier reads is pinned, not re-derived); C5 ->
//                    test.js T5.
// Tests -> criteria: G1 preserves C1's existing classifyBuilt behaviour for every caller that
// does not yet know about author-generation evidence; G2 preserves C2's existing bare-`retry`
// refusal (the exact scenario tests/unit/prepare-batch.test.js calls "M4"), which a correct
// implementation of C2 must not touch since tests/unit/ is frozen and outside this suite's or
// any implementation's reach; G3 preserves C4's foundation — the Codex/Claude terminal-result
// rule and author argv repo-7a0 already froze, which this suite's evidence classifier must read
// rather than redefine.
// Every check here is GREEN at the fork point (repo-7a0 is merged; prepare-batch.js's classifyBuilt
// and retry-mismatch behaviour already exist) and must stay green.
'use strict';

const assert = require('assert');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');

for (const name of ['CODEX_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']) {
  delete process.env[name];
}

const P = require(path.join(ROOT, 'scripts', 'prepare-batch.js'));
const AGENT = require(path.join(ROOT, 'runner', 'agent-provider.js'));
const AUTHOR = require(path.join(ROOT, 'scripts', 'author-tests.js'));

let failed = 0;
async function check(name, body) {
  try { await body(); console.log(`ok - ${name}`); }
  catch (error) { failed = 1; console.error(`FAIL - ${name} — ${error.stack || error.message}`); }
}

function built(id = 'app-1', state = 'write', extra = {}) {
  const folder = extra.folder || { dir: path.join(os.tmpdir(), `freeze-${id}`), branch: `freeze-${id}`, exists: true };
  return {
    ok: true, id, state, branch: 'main', text: `brief for ${id}`,
    cfg: { targetRepoPath: os.tmpdir(), model: 'opus', wallClockMinutes: 1 },
    policy: { verifyCommand: 'sh tools/run-acceptance.sh', frozenPaths: [] },
    folder, criteria: { source: 'structured', sha256: 'a'.repeat(64), text: '1. works' },
    issue: { id, title: id, priority: 2, dependencies: [] },
    ...extra,
  };
}

// G1 / C1 — classifyBuilt called the way every existing caller already calls it (two arguments,
// no evidence) must keep selecting exactly what it selects today.
(async () => {

await check('G1 C1 [guard] classifyBuilt(id, built) with no evidence argument is unchanged', () => {
  assert.strictEqual(P.classifyBuilt('app-1', built('app-1', 'ready')).outcome, 'already-frozen');
  const missing = built(); missing.criteria = { source: 'none', sha256: '', text: '' };
  const needsCriteria = P.classifyBuilt('app-1', missing);
  assert.strictEqual(needsCriteria.outcome, 'needs-criteria');
  assert.strictEqual(needsCriteria.action, undefined);
  assert.strictEqual(P.classifyBuilt('app-1', { ok: false, kind: 'collision', error: 'two trees' }).outcome, 'collision');
  assert.strictEqual(P.classifyBuilt('app-1', built('app-1', 'write')).action, 'author-proof');
  assert.strictEqual(P.classifyBuilt('app-1', built('app-1', 're-gate')).action, 'proof');
  assert.strictEqual(P.classifyBuilt('app-1', built('app-1', 'freeze')).action, 'proof');
});

// G2 / C2 — the exact scenario tests/unit/prepare-batch.test.js pins as "M4": a bare `retry`
// (no new flag) on an acknowledged author-proof interruption whose suite now naively reclassifies
// as proof-only must still refuse with zero workers launched. tests/unit/ is a frozen path this
// suite may not touch and no implementation may edit either, so C2's new explicit resume path
// must be additive, never a replacement of this refusal.
await check('G2 C2 [guard] bare `retry` still refuses an acknowledged author-proof mismatch and launches nothing', async () => {
  const State = require(path.join(ROOT, 'runner', 'preparation-state.js'));
  const Lock = require(path.join(ROOT, 'runner', 'lock.js'));
  const fs = require('fs');
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-djf42-guard-state-'));
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-djf42-guard-target-'));
  const cfg = { targetRepoPath: target, allowHalfProven: false, model: 'opus' };
  State.createManifest(stateRoot, 'guard-wave', {
    project: 'fixture', runConfig: 'run.json', intent: 'test', concurrency: 1,
    integrationBranch: 'main', integrationHead: 'f'.repeat(40),
    config: cfg, issues: [{ id: 'guard-app', dependencies: [] }],
  });
  State.writeWorkerStarted(stateRoot, 'guard-wave', 'guard-app', {
    nonce: 'd'.repeat(32), phase: 'author-proof', pid: 2147483000,
  });
  const ackOwner = Lock.acquire(ROOT, target, 'guard-ack-owner', { allowPreparationRecovery: true });
  P.acknowledgeInterrupted(stateRoot, 'guard-wave', ['guard-app'], State, cfg, { out() {}, err() {} },
    { ownership: ackOwner.ownership });
  Lock.release(ROOT, target, ackOwner.ownership);

  let launched = 0;
  const lines = [];
  const partial = built('guard-app', 'freeze', { cfg, folder: { dir: target, branch: 'freeze-guard-app', exists: true } });
  const code = await P.execute({ mode: 'retry', batch: 'guard-wave', issues: ['guard-app'], concurrency: 2 },
    { out() {}, err: (l) => lines.push(l) }, {
      state: State, preparationRoot: () => stateRoot, loadConfig: () => cfg,
      acquire: () => ({ ok: true, tookOver: false, ownership: {} }), release() {},
      inspectIntegration: () => ({ ok: true, branch: 'main', head: 'f'.repeat(40) }),
      readyQueue: () => ({ ok: true, issues: [] }),
      runSync: () => ({ status: 0, stdout: 'f'.repeat(40), stderr: '' }),
      buildBrief: () => partial, runWorker: () => { launched += 1; },
    });
  assert.strictEqual(code, P.EXIT_ATTENTION, `expected EXIT_ATTENTION, got ${code}: ${lines.join('\n')}`);
  assert.strictEqual(launched, 0, 'bare retry must not launch a worker on a reclassified mismatch');
});

// G3 / C4 — the repo-7a0 terminal-result rule and author argv this suite's evidence classifier
// must read, unchanged.
await check('G3 C4 [guard] repo-7a0 terminal-result vocabulary and author argv are unchanged', () => {
  assert.strictEqual(AGENT.terminalResult('codex',
    `${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'done' } })}\n`
    + `${JSON.stringify({ type: 'turn.completed' })}\n`), true);
  assert.strictEqual(AGENT.terminalResult('codex',
    `${JSON.stringify({ type: 'item.started', item: { type: 'agent_message' } })}\n`
    + `${JSON.stringify({ type: 'turn.failed' })}\n`), false);
  assert.strictEqual(AGENT.terminalResult('claude', 'plain prose, no envelope\n'), true);
  assert.strictEqual(AGENT.terminalResult('claude',
    `${JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true })}\n`), false);
  assert.strictEqual(AUTHOR.EXIT_AGENT, 4);
  assert(AUTHOR.DENIED_TOOLS.split(',').includes('Bash(bd *)'));
  assert(AUTHOR.DENIED_TOOLS.split(',').includes('Bash(node *freeze.js*)'));
});

process.exitCode = failed;
})().catch((error) => {
  console.error(`FAIL - guard harness — ${error.stack || error.message}`);
  process.exitCode = 1;
});
