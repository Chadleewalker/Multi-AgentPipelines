// Frozen acceptance test — repo-djf.55: validate specification design references AFTER the
// planner checkout has been cleaned up. This is the RED half of the suite; `guard.js` beside it
// carries the "existing behaviour X still holds" invariants this fix must PRESERVE (they are
// green at the fork point and labelled as guards there). Between the two files every criterion is
// covered in BOTH directions.
//
// WHY THIS FILE IS RED TODAY (the reproduced defect). `scripts/specify-proposal.js` `execute`
// disposes the owned planning checkout in a `finally` (`cleanupCheckout`) and only THEN runs
// `validateDesignReference(ref, integrationCommit)` for a ready proposal. The production adapter
// resolves the reference with `cwd: adapters.checkoutPath` — the directory the `git worktree
// remove --force` just deleted — so `git show A:<path>` spawns against a cwd that no longer
// exists, every reference "fails to resolve", and a genuinely ready proposal whose reference is
// present at the pinned commit A is wrongly REFUSED. The issue moved past that draft: validation
// must be bound to the pinned commit's objects and survive checkout disposal (criterion 2 says
// keeping the checkout alive through validation OR reading pinned objects from a stable
// repository are both valid). Criteria 1 and 4 carry the discriminating weight here.
//
// CRITERION PAIRING — every check names its own criterion, every criterion names ≥1 check here
// or in guard.js:
//   C1  real execute+productionAdapters, model+Beads boundaries only replaced, produces one
//       ready issue and one valid receipt naming that issue and A, no leftover checkout. -> T1
//   C2  validation stays bound to pinned commit A even when the target working tree moves off
//       it.                                                             -> T2 (+ guard G1,G2)
//   C3  malformed/thrown/needs-input outcomes and their no-side-effect contract.  -> guard G3,G4
//   C4  an existing exact-external-reference issue with no receipt is reused (no duplicate) and
//       its matching receipt persisted; re-running a completed kickoff reuses it. -> T3 (+ G5)
//
// THE FROZEN INTERFACE. The issue names behaviour, not a field grammar, so this suite reuses the
// exact surface `scripts/specify-proposal.js` already exports and that the frozen repo-djf.41 /
// repo-6ma suites compose: `execute(options, io, seams)` and `productionAdapters(options[, deps])`
// returning the adapter seams `execute` consumes. It COMPOSES the real production adapters and
// replaces ONLY the model boundary (`launchCodex`) and the Beads boundary (`beadsFind`,
// `beadsCreate`); candidate discovery, integration resolution, checkout creation/removal,
// reference validation and receipt persistence all run production code against a real Git repo.
// `createReadOnlyCheckout` is WRAPPED (delegating to the real one) only to OBSERVE the checkout
// path — the real `git worktree add/remove` still run.
//
// SELF-CONTAINED: Node built-ins and a real local Git repo per case. No provider key, no Beads
// binary, no network, no container engine. Every durable store is re-aimed into a disposable
// temp tree via PIPELINE_STATE_DIR so running this file cannot disturb a live run.
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const specify = require(path.join(ROOT, 'scripts', 'specify-proposal.js'));
const kickoffApi = require(path.join(ROOT, 'scripts', 'kickoff.js'));

// Deterministic and key-free, like the frozen repo-djf.41 / repo-6ma suites this one joins.
for (const name of ['CODEX_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN', 'PIPELINE_BD_CMD']) delete process.env[name];

const temps = [];
const savedStateDir = process.env.PIPELINE_STATE_DIR;
const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'djf55-state-'));
temps.push(stateRoot);
process.env.PIPELINE_STATE_DIR = stateRoot;

// The module's own hash formula, reproduced (it is not exported) so a receipt's validity can be
// asserted the same way `execute` computes it.
const sha256 = (value) => `sha256:${crypto.createHash('sha256')
  .update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')}`;

const tests = [];
function test(name, body) { tests.push({ name, body }); }

function run(cmd, args, options = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', timeout: 120000, windowsHide: true, ...options });
}
const git = (dir, ...args) => run('git', ['-c', 'safe.directory=*', ...args], { cwd: dir });

// The one ready proposal this suite works with — its single design reference is exactly the
// candidate the production discovery derives from README.md#pipeline-fixture at commit A.
const READY = {
  spec: 'Resolve the immutable kickoff intent into one canonical specification for repo-djf.55.',
  acceptanceCriteria: ['the design reference resolves at the pinned integration commit'],
  designReferences: ['README.md#pipeline-fixture'],
  difficulty: 'medium',
  status: 'ready',
};

function writeKickoff(targetRepoPath, tag) {
  const paths = kickoffApi.statePathsFor(targetRepoPath);
  fs.mkdirSync(paths.proposals, { recursive: true, mode: 0o700 });
  const id = `kp-${crypto.createHash('sha256').update(`${tag}:${targetRepoPath}`).digest('hex').slice(0, 16)}`;
  const intentObj = {
    version: 'kickoff-intake/1', title: `repo-djf.55 fixture ${tag}`, description: '',
    constraints: [], examples: [], nonGoals: [], priority: 2, relations: [], origin: null,
  };
  const intent = JSON.stringify(intentObj);
  const record = {
    version: 'kickoff-intake/1', id, target: paths.target, hash: sha256(intent), intent,
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(paths.proposals, `${id}.json`), `${JSON.stringify(record, null, 2)}\n`);
  return { id, hash: record.hash };
}

// A real Git repo whose integration branch `main` has README.md#pipeline-fixture at HEAD (=A),
// a valid run config (codexAuth chatgpt), and a durable kickoff record.
function makeWorld(tag) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `djf55-${tag}-`));
  temps.push(root);
  const target = path.join(root, 'target');
  fs.mkdirSync(target, { recursive: true });
  git(target, 'init', '-q', '-b', 'main');
  git(target, 'config', 'user.email', 'fixture@example.invalid');
  git(target, 'config', 'user.name', 'repo-djf.55 fixture');
  fs.writeFileSync(path.join(target, 'pipeline.config.json'), `${JSON.stringify({
    defaultBranch: 'main', verifyCommand: 'sh tools/run-acceptance.sh', frozenPaths: [],
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(target, 'README.md'),
    '# pipeline-fixture\n\nThe pinned design-reference fixture heading for repo-djf.55.\n');
  git(target, 'add', '-A');
  git(target, 'commit', '-qm', 'integration base');
  const A = String(git(target, 'rev-parse', 'HEAD').stdout || '').trim();
  const configPath = path.join(root, 'run.config.json');
  fs.writeFileSync(configPath, `${JSON.stringify({
    targetRepoPath: target, targetRepoRemote: 'https://example.invalid/repo.git',
    image: 'pipeline-djf55-fixture:local', codexAuth: 'chatgpt',
    gitTimeoutMs: 120000, bdTimeoutMs: 15000, wallClockMinutes: 2,
  }, null, 2)}\n`);
  const k = writeKickoff(target, tag);
  assert(/^[0-9a-f]{40}$/.test(A), `fixture ${tag} did not pin a 40-hex integration commit: ${A}`);
  return { root, target, configPath, A, proposalId: k.id, kickoffHash: k.hash };
}

// Compose the REAL production adapters and replace ONLY the model and Beads boundaries. Wrap
// createReadOnlyCheckout to observe the real checkout path without mocking git.
function makeAdapters(w, overrides = {}) {
  const adapters = specify.productionAdapters({ configPath: w.configPath, proposalId: w.proposalId });
  const created = [];
  const realCreate = adapters.createReadOnlyCheckout;
  adapters.createReadOnlyCheckout = async (commit) => {
    const checkout = await realCreate(commit);
    created.push(checkout.path);
    return checkout;
  };
  adapters._createdCheckouts = created;
  for (const key of Object.keys(overrides)) adapters[key] = overrides[key];
  return adapters;
}

function worktreeCount(target) {
  const out = String(git(target, 'worktree', 'list', '--porcelain').stdout || '');
  return (out.match(/^worktree /gm) || []).length;
}
// "leaves neither the owned planning checkout directory nor its Git worktree registration."
function assertCheckoutFullyDisposed(w, adapters, label) {
  for (const dir of adapters._createdCheckouts || []) {
    assert(!fs.existsSync(dir), `${label}: an owned planning checkout directory outlived execute: ${dir}`);
  }
  assert.strictEqual(worktreeCount(w.target), 1,
    `${label}: a planning-checkout worktree registration outlived execute`);
}

// A local mirror of the module's (unexported) validReceipt, so "one valid receipt" is asserted
// by the same rule execute persists under.
function validReceipt(r, kickoffHash) {
  if (!r || typeof r !== 'object' || r.kickoffHash !== kickoffHash) return false;
  if (!specify.validateProposal(r.proposal) || r.proposal.status !== 'ready') return false;
  if (r.specHash !== sha256(r.proposal)) return false;
  if (!(typeof r.issueId === 'string' && r.issueId.trim().length > 0)) return false;
  if (!/^[0-9a-f]{40}$/.test(r.integrationCommit || '')) return false;
  if (r.receiptHash !== undefined) {
    const body = { ...r }; delete body.receiptHash;
    if (r.receiptHash !== sha256(body)) return false;
  }
  return true;
}
const jsonEq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ── T1 / C1 ──────────────────────────────────────────────────────────────────────────────────
test('T1 C1 real execute+productionAdapters (model+Beads boundaries only) turns a ready proposal whose README.md#pipeline-fixture reference is present at pinned commit A into ready — creating exactly one issue, persisting one valid receipt naming that issue and A, and leaving neither the owned checkout directory nor its worktree registration', async () => {
  const w = makeWorld('c1');
  let creates = 0; let finds = 0;
  const adapters = makeAdapters(w, {
    launchCodex: async () => JSON.stringify(READY),
    beadsFind: async () => { finds += 1; return null; },
    beadsCreate: async () => { creates += 1; return { id: 'bd-djf55-created' }; },
  });

  const result = await specify.execute(
    { configPath: w.configPath, proposalId: w.proposalId }, {}, adapters);

  assert.strictEqual(result.status, 'ready',
    `execute did not return ready for a genuinely ready proposal validated at A: ${JSON.stringify(result)}`);
  assert.strictEqual(finds, 1, 'beadsFind was not consulted exactly once');
  assert.strictEqual(creates, 1, `exactly one issue must be created, saw ${creates}`);
  assert.strictEqual(result.issueId, 'bd-djf55-created', JSON.stringify(result));
  assert(validReceipt(result.receipt, w.kickoffHash), `the returned receipt is not valid: ${JSON.stringify(result.receipt)}`);
  assert.strictEqual(result.receipt.issueId, 'bd-djf55-created', 'the receipt does not name the created issue');
  assert.strictEqual(result.receipt.integrationCommit, w.A, 'the receipt does not name the pinned commit A');

  const persisted = await adapters.readReceipt(w.kickoffHash);
  assert(persisted && jsonEq(persisted, result.receipt), 'the receipt was not durably persisted verbatim');
  assert(validReceipt(persisted, w.kickoffHash), 'the persisted receipt is not valid');

  assertCheckoutFullyDisposed(w, adapters, 'T1');
});

// ── T2 / C2 ──────────────────────────────────────────────────────────────────────────────────
test('T2 C2 validation stays bound to pinned commit A: a reference present at A still resolves through execute even after the target working tree has moved off A (README.md changed to a different heading in the working tree), so the proposal is ready — never refused for content the pinned commit still carries', async () => {
  const w = makeWorld('c2');
  // Move the TARGET working tree off A without moving HEAD: the committed object at A still has
  // README.md#pipeline-fixture; the working-tree copy no longer does. Validation must read A, not
  // the working tree (and a checkout kept alive is itself the detached tree at A).
  fs.writeFileSync(path.join(w.target, 'README.md'),
    '# newer-working-tree-only\n\nUncommitted content that does not carry the pinned heading.\n');
  assert.strictEqual(String(git(w.target, 'rev-parse', 'HEAD').stdout || '').trim(), w.A,
    'the fixture unexpectedly advanced HEAD off the pinned commit');

  let creates = 0;
  const adapters = makeAdapters(w, {
    launchCodex: async () => JSON.stringify(READY),
    beadsFind: async () => null,
    beadsCreate: async () => { creates += 1; return { id: 'bd-djf55-pinned' }; },
  });

  const result = await specify.execute(
    { configPath: w.configPath, proposalId: w.proposalId }, {}, adapters);

  assert.strictEqual(result.status, 'ready',
    `validation was not bound to pinned commit A — a reference present at A was refused: ${JSON.stringify(result)}`);
  assert.strictEqual(creates, 1, `exactly one issue must be created, saw ${creates}`);
  assert.strictEqual(result.issueId, 'bd-djf55-pinned', JSON.stringify(result));
  assert(validReceipt(result.receipt, w.kickoffHash), `the returned receipt is not valid: ${JSON.stringify(result.receipt)}`);
  assert.strictEqual(result.receipt.integrationCommit, w.A, 'the receipt does not name the pinned commit A');
  assertCheckoutFullyDisposed(w, adapters, 'T2');
});

// ── T3 / C4 ──────────────────────────────────────────────────────────────────────────────────
test('T3 C4 an existing exact-external-reference issue with no receipt is reused by a full production-Git lifecycle: the ready proposal validates at A, beadsFind returns the existing issue, no duplicate is created, and the matching receipt naming that issue and A is persisted', async () => {
  const w = makeWorld('c4b');
  let creates = 0; let finds = 0;
  const adapters = makeAdapters(w, {
    launchCodex: async () => JSON.stringify(READY),
    beadsFind: async (externalRef) => { finds += 1; return { id: 'bd-djf55-existing', external_ref: externalRef }; },
    beadsCreate: async () => { creates += 1; return { id: 'bd-djf55-DUPLICATE' }; },
  });

  const result = await specify.execute(
    { configPath: w.configPath, proposalId: w.proposalId }, {}, adapters);

  assert.strictEqual(result.status, 'ready',
    `the existing-issue lifecycle did not complete (validation at A must succeed first): ${JSON.stringify(result)}`);
  assert.strictEqual(finds, 1, 'beadsFind was not consulted exactly once for the exact external reference');
  assert.strictEqual(creates, 0, `a duplicate issue was created for an existing external reference, saw ${creates}`);
  assert.strictEqual(result.issueId, 'bd-djf55-existing', JSON.stringify(result));
  assert(validReceipt(result.receipt, w.kickoffHash), `the returned receipt is not valid: ${JSON.stringify(result.receipt)}`);
  assert.strictEqual(result.receipt.issueId, 'bd-djf55-existing', 'the receipt does not name the reused issue');
  assert.strictEqual(result.receipt.integrationCommit, w.A, 'the receipt does not name the pinned commit A');

  const persisted = await adapters.readReceipt(w.kickoffHash);
  assert(persisted && jsonEq(persisted, result.receipt), 'the matching receipt was not persisted for the reused issue');
  assertCheckoutFullyDisposed(w, adapters, 'T3');
});

(async () => {
  let failed = 0;
  for (const item of tests) {
    try { await item.body(); console.log(`ok - ${item.name}`); }
    catch (error) { failed = 1; console.log(`FAIL - ${item.name} — ${error && error.message ? error.message : error}`); }
  }
  for (const dir of temps.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* disposable */ }
  }
  if (savedStateDir === undefined) delete process.env.PIPELINE_STATE_DIR;
  else process.env.PIPELINE_STATE_DIR = savedStateDir;
  process.exit(failed);
})().catch((error) => {
  console.log(`FAIL - harness — ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
