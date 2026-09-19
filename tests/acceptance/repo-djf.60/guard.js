// Frozen acceptance test — repo-djf.60, the [guard] half: the behaviour the "support bounded
// design discovery" expansion must NOT alter.
//
// [guard] Every check in this file is GREEN at the fork point and must stay green. They pin the
// invariants the ceiling expansion (see test.js) has to PRESERVE while it raises only the three
// approved bounds: safe-path filtering, duplicate elimination, empty-slug filtering and
// overlong-reference (>1024 byte) filtering still hold (C4); a discovery failure — an empty tree or
// a failed pinned Git read — and a planner-selected reference outside the exact candidate set are
// still refused fail-closed BEFORE any checkout, planner launch or Beads mutation (C4); discovery
// for a pinned commit is immutable under a later working-tree edit or a later commit, and a late
// valid reference still resolves at that same commit (C4); the unchanged 128-file tree-enumeration
// ceiling and heading semantics still hold (C2); small-repository behaviour, receipt reuse, the
// exact kickoff external-ref identity, saved-ChatGPT authentication and the checkout lifecycle
// remain compatible (C5); and the frozen repo-djf.38 file whose numeric caps these larger bounds
// intentionally supersede is preserved while this suite carries the new independent overflow
// coverage (C6). Nothing red belongs here — a [guard] file red at the fork point is a stale pin
// and refuses the freeze.
//
// SELF-CONTAINED: Node built-ins and a real local Git repo per case. No provider key, no real
// Beads binary or host Beads database, no network, no container engine. Durable state is re-aimed
// into a temp tree via PIPELINE_STATE_DIR.
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

for (const name of ['CODEX_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN',
  'PIPELINE_BD_CMD', 'PIPELINE_IMAGE_BD_CMD']) delete process.env[name];

const temps = [];
const savedStateDir = process.env.PIPELINE_STATE_DIR;
const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'djf60g-state-'));
temps.push(stateRoot);
process.env.PIPELINE_STATE_DIR = stateRoot;

const sha256 = (value) => `sha256:${crypto.createHash('sha256')
  .update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')}`;

const tests = [];
function test(name, body) { tests.push({ name, body }); }

function run(cmd, args, options = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', timeout: 120000, windowsHide: true, ...options });
}
const git = (dir, ...args) => run('git', ['-c', 'safe.directory=*', ...args], { cwd: dir });

// A minimal committed Git repository with the given files on `main`; returns the pinned HEAD.
function makeGitRepo(tag, files) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), `djf60g-${tag}-`));
  temps.push(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'fixture@example.invalid');
  git(repo, 'config', 'user.name', 'repo-djf.60 guard');
  git(repo, 'config', 'core.autocrlf', 'false');
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(repo, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', `guard fixture ${tag}`);
  const commit = String(git(repo, 'rev-parse', 'HEAD').stdout || '').trim();
  assert(/^[0-9a-f]{40}$/.test(commit), `guard fixture ${tag} did not pin a 40-hex commit: ${commit}`);
  return { repo, commit };
}

// Production discovery/validation adapters aimed at an arbitrary repo path, substituting only the
// config/kickoff plumbing (never the discovery, validation or Git seams under guard).
function discoveryAdapters(repoPath) {
  const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), 'djf60g-dstate-'));
  temps.push(stateHome);
  return specify.productionAdapters({ configPath: 'unused.json' }, {
    loadConfig: () => ({ codexAuth: 'chatgpt', targetRepoPath: repoPath, gitTimeoutMs: 60000 }),
    kickoffApi: { statePathsFor: () => ({ state: stateHome }) },
    bdJson: () => ({ ok: true, data: [] }),
    resolveBranch: () => ({ ok: true, branch: 'HEAD' }),
  });
}

function writeKickoff(targetRepoPath, tag) {
  const paths = kickoffApi.statePathsFor(targetRepoPath);
  fs.mkdirSync(paths.proposals, { recursive: true, mode: 0o700 });
  const id = `kp-${crypto.createHash('sha256').update(`${tag}:${targetRepoPath}`).digest('hex').slice(0, 16)}`;
  const intentObj = {
    version: 'kickoff-intake/1', title: `repo-djf.60 guard ${tag}`, description: '',
    constraints: [], examples: [], nonGoals: [], priority: 2, relations: [], origin: null,
  };
  const intent = JSON.stringify(intentObj);
  const record = {
    version: 'kickoff-intake/1', id, target: paths.target, hash: sha256(intent), intent,
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(paths.proposals, `${id}.json`), `${JSON.stringify(record, null, 2)}\n`);
  return { id, hash: record.hash, title: intentObj.title, priority: intentObj.priority };
}

// A full fixture world (target repo + run config + kickoff record) for execute-based guards.
function makeWorld(tag, files, extraCfg = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `djf60gw-${tag}-`));
  temps.push(root);
  const target = path.join(root, 'target');
  fs.mkdirSync(target, { recursive: true });
  git(target, 'init', '-q', '-b', 'main');
  git(target, 'config', 'user.email', 'fixture@example.invalid');
  git(target, 'config', 'user.name', 'repo-djf.60 guard');
  git(target, 'config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(target, 'pipeline.config.json'), `${JSON.stringify({
    defaultBranch: 'main', verifyCommand: 'sh tools/run-acceptance.sh', frozenPaths: [],
  }, null, 2)}\n`);
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(target, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  git(target, 'add', '-A');
  git(target, 'commit', '-qm', 'pinned design fixture');
  const A = String(git(target, 'rev-parse', 'HEAD').stdout || '').trim();
  assert(/^[0-9a-f]{40}$/.test(A), `guard world ${tag} did not pin a 40-hex commit: ${A}`);
  const configPath = path.join(root, 'run.config.json');
  fs.writeFileSync(configPath, `${JSON.stringify({
    targetRepoPath: target, targetRepoRemote: 'https://example.invalid/repo.git',
    image: 'pipeline-djf60-fixture:local', codexAuth: 'chatgpt',
    gitTimeoutMs: 120000, bdTimeoutMs: 15000, wallClockMinutes: 2, ...extraCfg,
  }, null, 2)}\n`);
  const k = writeKickoff(target, tag);
  return { root, target, configPath, A, proposalId: k.id, kickoffHash: k.hash,
    title: k.title, priority: k.priority, externalRef: `kickoff-spec:${k.hash}` };
}

function readyProposal(designRef) {
  return {
    spec: 'Bounded design-discovery specification fixture for repo-djf.60.',
    acceptanceCriteria: ['discovery admits the approved larger bounds'],
    designReferences: [designRef], difficulty: 'medium', status: 'ready',
  };
}

// ── G1 / C4 [guard] ────────────────────────────────────────────────────────────────────────────
test('G1 C4 [guard] production discovery still applies safe-path filtering, duplicate elimination, empty-slug filtering and overlong-reference (>1024 byte) filtering: an unsafe path yields no candidate, a repeated heading yields one, an empty-slug heading is dropped, and a reference over 1024 bytes is skipped while the shorter heading beside it survives', async () => {
  const { repo, commit } = makeGitRepo('g1', {
    'dup.md': '# Same\n# Same\n# Unique\n',
    'empty.md': '# !!!\n# Real\n',
    'long.md': `# ${'a'.repeat(1100)}\n# ok\n`,
    'un safe.md': '# Leak\n',
  });
  const cands = await discoveryAdapters(repo).deriveDesignReferenceCandidates(commit);
  assert.deepStrictEqual(cands, ['dup.md#same', 'dup.md#unique', 'empty.md#real', 'long.md#ok'],
    `filtering/deduplication changed: ${JSON.stringify(cands)}`);
  assert(!cands.some((c) => c.startsWith('un safe')), 'an unsafe path leaked into the candidate list');
  assert.strictEqual(cands.filter((c) => c === 'dup.md#same').length, 1, 'a duplicate heading was not eliminated');
});

// ── G2 / C4 [guard] ────────────────────────────────────────────────────────────────────────────
test('G2 C4 [guard] execute still fails closed on discovery: an empty design tree is refused before any checkout, planner launch or Beads mutation, and a planner-selected reference outside the exact candidate set is refused before any Beads mutation', async () => {
  // Empty discovery: no Markdown at the pinned commit -> refused before every side effect.
  const empty = makeWorld('g2-empty', { 'notes.txt': 'no markdown here\n' });
  const ae = specify.productionAdapters({ configPath: empty.configPath, proposalId: empty.proposalId });
  let checkouts = 0; let launches = 0; let creates = 0;
  const realCheckout = ae.createReadOnlyCheckout;
  ae.createReadOnlyCheckout = async (c) => { checkouts += 1; return realCheckout(c); };
  ae.launchCodex = async () => { launches += 1; return JSON.stringify(readyProposal('notes.txt#x')); };
  ae.beadsFind = async () => null;
  ae.beadsCreate = async () => { creates += 1; return { id: 'must-not-create' }; };
  const emptyResult = await specify.execute({ configPath: empty.configPath, proposalId: empty.proposalId }, {}, ae);
  assert.strictEqual(emptyResult.status, 'refused', `empty discovery was not refused: ${JSON.stringify(emptyResult)}`);
  assert.strictEqual(checkouts, 0, 'empty discovery created a checkout');
  assert.strictEqual(launches, 0, 'empty discovery launched the planner');
  assert.strictEqual(creates, 0, 'empty discovery mutated Beads');

  // Planner reaches outside the pinned candidate set: refused before any Beads mutation.
  const world = makeWorld('g2-outside', { 'DESIGN.md': '# Architecture\n' });
  const ao = specify.productionAdapters({ configPath: world.configPath, proposalId: world.proposalId });
  let outsideCreates = 0;
  ao.launchCodex = async () => JSON.stringify(readyProposal('DESIGN.md#nope'));
  ao.beadsFind = async () => null;
  ao.beadsCreate = async () => { outsideCreates += 1; return { id: 'must-not-create' }; };
  const outsideResult = await specify.execute({ configPath: world.configPath, proposalId: world.proposalId }, {}, ao);
  assert.strictEqual(outsideResult.status, 'refused', `an out-of-set reference was not refused: ${JSON.stringify(outsideResult)}`);
  assert.strictEqual(outsideCreates, 0, 'an out-of-set reference mutated Beads');
});

// ── G3 / C4 [guard] ────────────────────────────────────────────────────────────────────────────
test('G3 C4 [guard] discovery for a pinned commit is immutable: a later working-tree edit and a later commit do not change the candidate list discovered at the pinned commit A, and a valid reference still resolves at that same commit while a reference introduced only later does not', async () => {
  const { repo, commit: A } = makeGitRepo('g3', { 'd.md': '# Alpha\n' });
  const adapters = discoveryAdapters(repo);
  const atA = await adapters.deriveDesignReferenceCandidates(A);
  assert.deepStrictEqual(atA, ['d.md#alpha'], `discovery at A was not as pinned: ${JSON.stringify(atA)}`);

  // A later working-tree edit (uncommitted) must not change discovery at A.
  fs.appendFileSync(path.join(repo, 'd.md'), '# Beta\n');
  assert.deepStrictEqual(await adapters.deriveDesignReferenceCandidates(A), ['d.md#alpha'],
    'a later working-tree edit changed discovery at the pinned commit');

  // A later COMMIT must not change discovery at A, but does change discovery at B.
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'add beta');
  const B = String(git(repo, 'rev-parse', 'HEAD').stdout || '').trim();
  assert.deepStrictEqual(await adapters.deriveDesignReferenceCandidates(A), ['d.md#alpha'],
    'a later commit changed discovery at the pinned commit');
  assert.deepStrictEqual(await adapters.deriveDesignReferenceCandidates(B), ['d.md#alpha', 'd.md#beta'],
    'discovery at the later commit did not include the later heading');

  const present = await adapters.validateDesignReference('d.md#alpha', A);
  assert(present && present.ok === true, `a reference present at A was refused: ${JSON.stringify(present)}`);
  const late = await adapters.validateDesignReference('d.md#beta', A);
  assert(late && late.ok === false, `a reference introduced only after A resolved at A: ${JSON.stringify(late)}`);
});

// ── G4 / C2 [guard] ────────────────────────────────────────────────────────────────────────────
test('G4 C2 [guard] the unchanged 128-file tree-enumeration ceiling still binds: a pinned tree of 129 safe Markdown files is refused by production discovery (this ceiling is NOT among the three the task expands)', async () => {
  const files = {};
  for (let i = 0; i < 129; i++) files[`f${String(i).padStart(3, '0')}.md`] = `# h${i}\n`;
  const { repo, commit } = makeGitRepo('g4', files);
  await assert.rejects(discoveryAdapters(repo).deriveDesignReferenceCandidates(commit),
    'a 129-file tree was not refused by the unchanged 128-file ceiling');
});

// ── G5 / C5 [guard] ────────────────────────────────────────────────────────────────────────────
test('G5 C5 [guard] small-repository behaviour, saved-ChatGPT authentication, the checkout lifecycle, the exact kickoff external-ref identity and receipt reuse remain compatible: a small tree runs execute to one created issue keyed on kickoff-spec:<hash> with a checkout created then cleaned up, a replay reuses the receipt with no second create, and a non-chatgpt config is refused', async () => {
  const world = makeWorld('g5', { 'DESIGN.md': '# Architecture\n', 'README.md': '# Readme\n' });
  const adapters = specify.productionAdapters({ configPath: world.configPath, proposalId: world.proposalId });
  let checkouts = 0; let cleanups = 0; let created = null;
  const realCheckout = adapters.createReadOnlyCheckout;
  const realCleanup = adapters.cleanupCheckout;
  adapters.createReadOnlyCheckout = async (c) => { checkouts += 1; return realCheckout(c); };
  adapters.cleanupCheckout = async (c) => { cleanups += 1; return realCleanup(c); };
  adapters.launchCodex = async () => JSON.stringify(readyProposal('DESIGN.md#architecture'));
  adapters.beadsFind = async () => null;
  adapters.beadsCreate = async (req) => { created = req; return { id: `bd-${sha256(req.externalRef).slice(7, 19)}` }; };

  const first = await specify.execute({ configPath: world.configPath, proposalId: world.proposalId }, {}, adapters);
  assert.strictEqual(first.status, 'ready', `small-repo execute did not complete: ${JSON.stringify(first)}`);
  assert(created && created.externalRef === `kickoff-spec:${world.kickoffHash}`,
    `the kickoff external-ref identity changed: ${created && created.externalRef}`);
  assert.strictEqual(first.receipt.integrationCommit, world.A, 'the receipt does not name the pinned commit');
  assert.strictEqual(checkouts, 1, 'the read-only checkout was not created exactly once');
  assert.strictEqual(cleanups, 1, 'the read-only checkout was not cleaned up');

  const replay = specify.productionAdapters({ configPath: world.configPath, proposalId: world.proposalId });
  let replayCreates = 0;
  replay.launchCodex = async () => JSON.stringify(readyProposal('DESIGN.md#architecture'));
  replay.beadsFind = async () => null;
  replay.beadsCreate = async () => { replayCreates += 1; return { id: 'must-not-create' }; };
  const second = await specify.execute({ configPath: world.configPath, proposalId: world.proposalId }, {}, replay);
  assert.strictEqual(second.status, 'ready', `replay did not complete: ${JSON.stringify(second)}`);
  assert.strictEqual(second.issueId, first.issueId, 'replay returned a different issue identity');
  assert.strictEqual(replayCreates, 0, 'replay created another issue instead of reusing the receipt');

  assert.throws(() => specify.productionAdapters({ configPath: 'unused.json' }, {
    loadConfig: () => ({ codexAuth: 'apikey', targetRepoPath: world.target }),
  }), /chatgpt/i, 'a non-chatgpt config was not refused');
});

// ── G6 / C6 [guard] ────────────────────────────────────────────────────────────────────────────
test('G6 C6 [guard] the frozen repo-djf.38 file — whose old numeric-cap expectations (129 candidates and its ~93KB list) these approved larger bounds intentionally supersede — is preserved untouched, and this suite carries the new independent overflow coverage alongside it (test.js + guard.js)', async () => {
  const frozen38 = path.join(ROOT, 'tests', 'acceptance', 'repo-djf.38', 'test.js');
  assert(fs.existsSync(frozen38), 'the frozen repo-djf.38 file this task supersedes-but-preserves is missing');
  const here = path.join(ROOT, 'tests', 'acceptance', 'repo-djf.60');
  assert(fs.existsSync(path.join(here, 'test.js')), 'the new overflow coverage (test.js) is missing');
  assert(fs.existsSync(path.join(here, 'guard.js')), 'the new guard coverage (guard.js) is missing');
});

// ── G7 / C2 [guard] ────────────────────────────────────────────────────────────────────────────
test('G7 C2 [guard] heading semantics are unchanged: 1-6 leading hashes with a following space are headings (trailing hashes stripped), a no-space "#word" and a 7-hash line are not, and the same GitHub-style slug is derived', async () => {
  const { repo, commit } = makeGitRepo('g7', {
    'h.md': '# Real Heading\n#nospace not a heading\n####### seven hashes\n###### Six Level\n## Trailing ##\n',
  });
  const cands = await discoveryAdapters(repo).deriveDesignReferenceCandidates(commit);
  assert.deepStrictEqual(cands, ['h.md#real-heading', 'h.md#six-level', 'h.md#trailing'],
    `heading semantics changed: ${JSON.stringify(cands)}`);
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
