// Frozen acceptance test — repo-djf.55, the [guard] half: the behaviour this fix must NOT change.
//
// [guard] Every check in this file is GREEN at the fork point and must stay green. They pin the
// invariants the "validate design references after checkout cleanup" fix has to PRESERVE while
// the RED checks in test.js turn green for the first time: the candidate-set enforcement that
// refuses an out-of-set reference before any Beads create or receipt write (C2); the pinned-
// commit binding of the production reference validator, where content only newer commits carry
// is invalid at A (C2); the malformed / thrown-model / needs-input outcomes and their
// no-side-effect, checkout-disposed contract (C3); and the completed-kickoff replay that returns
// the stored issue and receipt with no further model launch or Beads create (C4). Nothing red
// belongs here — a [guard] file red at the fork point is a stale pin and refuses the freeze.
//
// SELF-CONTAINED: Node built-ins and a real local Git repo per case, exactly like test.js beside
// it. It composes the REAL productionAdapters and replaces ONLY the model and Beads boundaries.
// It resolves the repository as the tree it sits in (__dirname/../../..), never the cwd, so the
// gate's flat guard-subset run judges exactly the tree the suite saw.
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

for (const name of ['CODEX_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN', 'PIPELINE_BD_CMD']) delete process.env[name];

const temps = [];
const savedStateDir = process.env.PIPELINE_STATE_DIR;
const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'djf55g-state-'));
temps.push(stateRoot);
process.env.PIPELINE_STATE_DIR = stateRoot;

const sha256 = (value) => `sha256:${crypto.createHash('sha256')
  .update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')}`;
const jsonEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const tests = [];
function test(name, body) { tests.push({ name, body }); }

function run(cmd, args, options = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', timeout: 120000, windowsHide: true, ...options });
}
const git = (dir, ...args) => run('git', ['-c', 'safe.directory=*', ...args], { cwd: dir });

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
    version: 'kickoff-intake/1', title: `repo-djf.55 guard ${tag}`, description: '',
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

function makeWorld(tag) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `djf55g-${tag}-`));
  temps.push(root);
  const target = path.join(root, 'target');
  fs.mkdirSync(target, { recursive: true });
  git(target, 'init', '-q', '-b', 'main');
  git(target, 'config', 'user.email', 'fixture@example.invalid');
  git(target, 'config', 'user.name', 'repo-djf.55 guard');
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
  assert(/^[0-9a-f]{40}$/.test(A), `guard fixture ${tag} did not pin a 40-hex commit: ${A}`);
  return { root, target, configPath, A, proposalId: k.id, kickoffHash: k.hash };
}

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
function assertCheckoutFullyDisposed(w, adapters, label) {
  for (const dir of adapters._createdCheckouts || []) {
    assert(!fs.existsSync(dir), `${label}: an owned planning checkout directory outlived execute: ${dir}`);
  }
  assert.strictEqual(worktreeCount(w.target), 1,
    `${label}: a planning-checkout worktree registration outlived execute`);
}

// ── G1 / C2 guard: an out-of-candidate-set reference is refused before any Beads create or
//    receipt write, and the checkout is disposed. ──────────────────────────────────────────────
test('G1 C2 [guard] a design reference outside the production-discovered candidate set at A is refused before any Beads create or receipt write, and the owned checkout is disposed', async () => {
  const w = makeWorld('g1');
  let creates = 0;
  const outside = { ...READY, designReferences: ['README.md#not-a-discovered-anchor'] };
  const adapters = makeAdapters(w, {
    launchCodex: async () => JSON.stringify(outside),
    beadsFind: async () => { throw new Error('beadsFind must not be reached for an out-of-set reference'); },
    beadsCreate: async () => { creates += 1; return { id: 'bd-must-not-create' }; },
  });

  const result = await specify.execute(
    { configPath: w.configPath, proposalId: w.proposalId }, {}, adapters);

  assert.strictEqual(result.status, 'refused', `an out-of-set reference must be refused: ${JSON.stringify(result)}`);
  assert.strictEqual(creates, 0, 'a Beads issue was created for an out-of-set reference');
  assert.strictEqual(await adapters.readReceipt(w.kickoffHash), null, 'a receipt was written for an out-of-set reference');
  assertCheckoutFullyDisposed(w, adapters, 'G1');
});

// ── G2 / C2 guard: the production reference validator is bound to the pinned commit. ───────────
test('G2 C2 [guard] validateDesignReference resolves a reference against the pinned commit\'s objects: an anchor present at A resolves, while an anchor or path that only a newer commit provides is invalid at A', async () => {
  const w = makeWorld('g2');
  const adapters = makeAdapters(w, {});

  const atA = await adapters.validateDesignReference('README.md#pipeline-fixture', w.A);
  assert(atA && atA.ok === true, `a reference present at A did not resolve: ${JSON.stringify(atA)}`);

  // Advance the repo: a newer commit gives README a different heading and adds a new document.
  fs.writeFileSync(path.join(w.target, 'README.md'), '# newer-only\n\nOnly the newer commit has this heading.\n');
  fs.writeFileSync(path.join(w.target, 'NEWDOC.md'), '# somewhere\n\nA document that does not exist at A.\n');
  git(w.target, 'add', '-A');
  git(w.target, 'commit', '-qm', 'advance beyond A');

  const newerAnchor = await adapters.validateDesignReference('README.md#newer-only', w.A);
  assert(newerAnchor && newerAnchor.ok === false,
    `an anchor only a newer commit provides must be invalid at A: ${JSON.stringify(newerAnchor)}`);
  const newerPath = await adapters.validateDesignReference('NEWDOC.md#somewhere', w.A);
  assert(newerPath && newerPath.ok === false,
    `a path absent at A must be invalid at A even when a newer commit adds it: ${JSON.stringify(newerPath)}`);
});

// ── G3 / C3 guard: malformed planner output refuses; a thrown model error propagates unchanged;
//    both leave zero Beads creates, no receipt, and no owned checkout. ─────────────────────────
test('G3 C3 [guard] malformed planner output is refused and a thrown model error propagates unchanged; both leave zero Beads creates, no receipt, and no owned checkout directory or worktree registration', async () => {
  // Malformed model output.
  const wm = makeWorld('g3m');
  let mCreates = 0;
  const mAdapters = makeAdapters(wm, {
    launchCodex: async () => 'this is not a valid proposal {{{',
    beadsFind: async () => { throw new Error('beadsFind must not be reached for malformed output'); },
    beadsCreate: async () => { mCreates += 1; return { id: 'bd-must-not-create' }; },
  });
  const mResult = await specify.execute(
    { configPath: wm.configPath, proposalId: wm.proposalId }, {}, mAdapters);
  assert.strictEqual(mResult.status, 'refused', `malformed planner output must be refused: ${JSON.stringify(mResult)}`);
  assert.strictEqual(mCreates, 0, 'a Beads issue was created for malformed planner output');
  assert.strictEqual(await mAdapters.readReceipt(wm.kickoffHash), null, 'a receipt was written for malformed planner output');
  assertCheckoutFullyDisposed(wm, mAdapters, 'G3-malformed');

  // Thrown model error.
  const wt = makeWorld('g3t');
  let tCreates = 0;
  const thrown = new Error('repo-djf.55 model boundary failure');
  const tAdapters = makeAdapters(wt, {
    launchCodex: async () => { throw thrown; },
    beadsFind: async () => { throw new Error('beadsFind must not be reached when the model throws'); },
    beadsCreate: async () => { tCreates += 1; return { id: 'bd-must-not-create' }; },
  });
  let caught = null;
  try {
    await specify.execute({ configPath: wt.configPath, proposalId: wt.proposalId }, {}, tAdapters);
  } catch (error) { caught = error; }
  assert(caught, 'a thrown model error was swallowed instead of propagating');
  assert.strictEqual(caught, thrown, 'the thrown model error did not propagate unchanged (identity)');
  assert.strictEqual(tCreates, 0, 'a Beads issue was created despite a thrown model error');
  assert.strictEqual(await tAdapters.readReceipt(wt.kickoffHash), null, 'a receipt was written despite a thrown model error');
  assertCheckoutFullyDisposed(wt, tAdapters, 'G3-thrown');
});

// ── G4 / C3 guard: a needs-input proposal returns needs-input, records matching question
//    evidence, writes no issue/receipt, and disposes the checkout. ─────────────────────────────
test('G4 C3 [guard] a schema-valid needs-input proposal returns needs-input, records matching question evidence, performs no Beads create or receipt write, and disposes the owned checkout', async () => {
  const w = makeWorld('g4');
  const needsInput = {
    spec: READY.spec, acceptanceCriteria: READY.acceptanceCriteria,
    designReferences: ['README.md#pipeline-fixture'], difficulty: 'medium',
    status: 'needs-input', question: 'Which retention period should the specification assume?',
  };
  let creates = 0;
  const adapters = makeAdapters(w, {
    launchCodex: async () => JSON.stringify(needsInput),
    beadsFind: async () => { throw new Error('beadsFind must not be reached for a needs-input proposal'); },
    beadsCreate: async () => { creates += 1; return { id: 'bd-must-not-create' }; },
  });

  const result = await specify.execute(
    { configPath: w.configPath, proposalId: w.proposalId }, {}, adapters);

  assert.strictEqual(result.status, 'needs-input', `a needs-input proposal must return needs-input: ${JSON.stringify(result)}`);
  assert.strictEqual(result.question, needsInput.question, 'the returned question was not the planner question');
  assert.strictEqual(result.evidenceHash, sha256(needsInput), 'the returned evidence hash does not match the proposal');
  assert.strictEqual(creates, 0, 'a Beads issue was created for a needs-input proposal');
  assert.strictEqual(await adapters.readReceipt(w.kickoffHash), null, 'a receipt was written for a needs-input proposal');

  const recorded = await adapters.readQuestion(w.kickoffHash);
  assert(recorded && recorded.kickoffHash === w.kickoffHash, 'no question evidence was recorded');
  assert.strictEqual(recorded.question, needsInput.question, 'the recorded question does not match');
  assert.strictEqual(recorded.evidenceHash, sha256(needsInput), 'the recorded evidence hash does not match');
  assert(specify.validateProposal(recorded.proposal) && recorded.proposal.status === 'needs-input',
    'the recorded question evidence does not carry a valid needs-input proposal');
  assertCheckoutFullyDisposed(w, adapters, 'G4');
});

// ── G5 / C4 guard: re-running a completed kickoff returns the stored issue and receipt without a
//    further model launch or Beads create. ────────────────────────────────────────────────────
test('G5 C4 [guard] re-running a completed kickoff returns the same issue and stored receipt without another model launch or Beads create', async () => {
  const w = makeWorld('g5');
  const proposal = READY;
  const receiptBody = {
    version: 'kickoff-spec-receipt/1', kickoffId: w.proposalId, kickoffHash: w.kickoffHash,
    specHash: sha256(proposal), proposal, integrationCommit: w.A,
    externalRef: `kickoff-spec:${w.kickoffHash}`, issueId: 'bd-djf55-completed',
    createdAt: new Date().toISOString(),
  };
  const finalReceipt = { ...receiptBody, receiptHash: sha256(receiptBody) };
  await makeAdapters(w, {}).writeReceipt(w.kickoffHash, finalReceipt);

  let launches = 0; let creates = 0; let finds = 0;
  const adapters = makeAdapters(w, {
    launchCodex: async () => { launches += 1; return JSON.stringify(proposal); },
    beadsFind: async () => { finds += 1; return null; },
    beadsCreate: async () => { creates += 1; return { id: 'bd-djf55-DUPLICATE' }; },
  });

  const result = await specify.execute(
    { configPath: w.configPath, proposalId: w.proposalId }, {}, adapters);

  assert.strictEqual(result.status, 'ready', `a completed kickoff must replay as ready: ${JSON.stringify(result)}`);
  assert.strictEqual(result.issueId, 'bd-djf55-completed', 'the replay did not return the stored issue');
  assert.strictEqual(launches, 0, 'the model was launched again for a completed kickoff');
  assert.strictEqual(finds, 0, 'Beads was consulted again for a completed kickoff');
  assert.strictEqual(creates, 0, 'a Beads issue was created again for a completed kickoff');
  assert(jsonEqual(result.receipt, finalReceipt), `the replay did not return the stored receipt: ${JSON.stringify(result.receipt)}`);
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
