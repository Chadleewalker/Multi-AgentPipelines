// Frozen acceptance test — repo-djf.38: bind the specification planner to its wire contract.
//
// CRITERION PAIRING
// C1: T1 fixes Codex native structured output to the closed planner wire schema.
// C2: T2 normalizes nullable wire questions without weakening durable proposal variants.
// C3: T3 pins deterministic design-reference candidates in the no-tool planner prompt.
// C4: T4 replays small/anchorless output through production-shaped JSONL wiring to one issue.
// C5: T5 makes empty and overlarge discovery stop safely before invented provenance.
// C6: guard.js G1 preserves saved ChatGPT auth and immutable receipt/idempotency behavior.
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..', '..', '..');
const api = require(path.join(ROOT, 'scripts', 'specify-proposal.js'));
const tests = [];
function test(name, body) { tests.push({ name, body }); }
const sha = value => `sha256:${crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')}`;
const COMMIT = 'b'.repeat(40);
function kickoff(id = 'kp-contract') {
  const intent = JSON.stringify({ version: 'kickoff-intake/1', title: 'Planner contract', description: 'Fixture', constraints: [], examples: [], nonGoals: [], priority: 3, relations: [], origin: null });
  return { version: 'kickoff-intake/1', id, target: ROOT, hash: sha(intent), intent, createdAt: '2026-09-15T00:00:00.000Z' };
}
const readyWire = { spec: 'Use the planned contract.', acceptanceCriteria: ['The issue is created once.'], designReferences: ['DESIGN.md#architecture'], difficulty: 'medium', status: 'ready', question: null };
function seams(record, overrides = {}) {
  return { sha256: sha, now: () => '2026-09-15T00:00:00.000Z', crash: async () => {},
    readKickoff: async () => record, readReceipt: async () => null, readQuestion: async () => null, readAnswer: async () => null,
    resolveIntegration: async () => ({ commit: COMMIT }), createReadOnlyCheckout: async commit => ({ path: ROOT, commit, readOnly: true }), cleanupCheckout: async () => {},
    deriveDesignReferenceCandidates: async () => ['DESIGN.md#architecture'],
    validateDesignReference: async (ref, commit) => ({ ok: ref === 'DESIGN.md#architecture' && commit === COMMIT }),
    appendQuestion: async () => {}, beadsFind: async () => null, beadsCreate: async () => ({ id: 'repo-created' }), writeReceipt: async () => {},
    launchCodex: async () => JSON.stringify(readyWire), ...overrides };
}

test('T1 C1 planner uses Codex native output-schema with a fixed closed nullable-question wire shape', async () => {
  const record = kickoff('kp-schema'); let plan = null;
  await api.execute({ proposalId: record.id }, {}, seams(record, { launchCodex: async value => { plan = value; return JSON.stringify(readyWire); } }));
  const schemaFlag = plan.args.indexOf('--output-schema');
  assert(schemaFlag >= 0, JSON.stringify(plan.args));
  const schemaPath = plan.args[schemaFlag + 1];
  assert.strictEqual(path.resolve(schemaPath), path.join(ROOT, 'schemas', 'specification-proposal.schema.json'));
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(schemaPath, 'utf8')), plan.outputSchema);
  assert(plan.outputSchema && plan.outputSchema.type === 'object', JSON.stringify(plan.outputSchema));
  assert.deepStrictEqual(Object.keys(plan.outputSchema.properties).sort(), ['acceptanceCriteria', 'designReferences', 'difficulty', 'question', 'spec', 'status']);
  assert.deepStrictEqual(plan.outputSchema.required.slice().sort(), ['acceptanceCriteria', 'designReferences', 'difficulty', 'question', 'spec', 'status']);
  assert.strictEqual(plan.outputSchema.additionalProperties, false);
  assert.deepStrictEqual(plan.outputSchema.properties.difficulty.enum, ['trivial', 'medium', 'hard']);
  assert.deepStrictEqual(plan.outputSchema.properties.status.enum, ['ready', 'needs-input']);
  assert.deepStrictEqual(plan.outputSchema.properties.question.type, ['string', 'null']);
  assert(plan.outputSchema.properties.question.maxLength > 0 && plan.outputSchema.properties.question.maxLength <= 4096);
  assert(/#/.test(plan.outputSchema.properties.designReferences.items.pattern), JSON.stringify(plan.outputSchema.properties.designReferences));
});

test('T2 C2 ready null is normalized to exactly five durable keys; needs-input requires one bounded question and rejects semantic/operational extras', async () => {
  const record = kickoff('kp-normalize'); let created = 0, receipt = null;
  const result = await api.execute({ proposalId: record.id }, {}, seams(record, { beadsCreate: async request => { created += 1; assert.deepStrictEqual(Object.keys(request).sort(), ['acceptanceCriteria', 'description', 'designReferences', 'difficulty', 'externalRef', 'kickoffHash', 'metadata', 'priority', 'specHash', 'title']); return { id: 'repo-normalized' }; }, writeReceipt: async (_key, value) => { receipt = value; } }));
  assert.strictEqual(result.status, 'ready'); assert.strictEqual(created, 1);
  assert.deepStrictEqual(Object.keys(receipt.proposal).sort(), ['acceptanceCriteria', 'designReferences', 'difficulty', 'spec', 'status']);
  assert.strictEqual(receipt.proposal.question, undefined);
  const needs = { ...readyWire, status: 'needs-input', question: 'Which one bounded product choice is intended?' };
  const invalid = [{ ...readyWire, status: 'ready', question: 'not permitted' }, { ...needs, question: '' }, { ...needs, question: 'x'.repeat(4097) }, { ...needs, issueId: 'operational' }];
  for (const value of invalid) {
    let calls = 0;
    const refused = await api.execute({ proposalId: 'kp-invalid' }, {}, seams(kickoff('kp-invalid'), { launchCodex: async () => JSON.stringify(value), beadsCreate: async () => { calls += 1; return { id: 'must-not-create' }; } }));
    assert.strictEqual(refused.status, 'refused', JSON.stringify(value)); assert.strictEqual(calls, 0);
  }
  const paused = await api.execute({ proposalId: 'kp-question' }, {}, seams(kickoff('kp-question'), { launchCodex: async () => JSON.stringify(needs) }));
  assert.strictEqual(paused.status, 'needs-input'); assert.strictEqual(paused.question, needs.question);
});

test('T3 C3 derives bounded deterministic path#anchor candidates at the pinned commit and makes them explicit in a no-tool prompt', async () => {
  const record = kickoff('kp-candidates'); const calls = []; let plan = null;
  await api.execute({ proposalId: record.id }, {}, seams(record, {
    deriveDesignReferenceCandidates: async commit => { calls.push(commit); return ['docs/one.md#alpha', 'DESIGN.md#architecture']; },
    launchCodex: async value => { plan = value; return JSON.stringify(readyWire); },
  }));
  assert.deepStrictEqual(calls, [COMMIT]); assert.strictEqual(plan.commit, COMMIT);
  assert.match(plan.prompt, /do not .*tools|no tools/i); assert.match(plan.prompt, /docs\/one\.md#alpha/); assert.match(plan.prompt, /DESIGN\.md#architecture/);
  assert.match(plan.prompt, /trivial.*medium.*hard/i);
  assert.match(plan.prompt, /ready[^\r\n]*question[^\r\n]*null|question[^\r\n]*null[^\r\n]*ready/i);
  assert.match(plan.prompt, /needs-input[^\r\n]*question[^\r\n]*(?:non-empty|bounded)|needs-input[^\r\n]*(?:non-empty|bounded)[^\r\n]*question/i);
  assert.match(plan.prompt, /untrusted data/i); assert.match(plan.prompt, /never instructions/i);
  assert.deepStrictEqual(plan.designReferenceCandidates, ['docs/one.md#alpha', 'DESIGN.md#architecture']);
  assert(plan.prompt.includes(JSON.stringify(plan.designReferenceCandidates)), plan.prompt);

  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-djf-38-candidates-'));
  try {
    const git = args => {
      const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8', shell: false });
      assert.strictEqual(result.status, 0, result.stderr || `${args.join(' ')} failed`);
      return String(result.stdout || '').trim();
    };
    git(['init', '-q']); git(['config', 'user.email', 'pipeline@example.invalid']); git(['config', 'user.name', 'Pipeline Test']);
    fs.mkdirSync(path.join(repo, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'DESIGN.md'), '# Architecture\n');
    fs.writeFileSync(path.join(repo, 'docs', 'one.md'), '# Zeta\n## Alpha!\n# Zeta\n');
    fs.writeFileSync(path.join(repo, 'docs', 'unsafe name.md'), '# Must not enter the prompt\n');
    git(['add', 'DESIGN.md', 'docs/one.md', 'docs/unsafe name.md']); git(['commit', '-qm', 'pinned design']);
    const pinned = git(['rev-parse', 'HEAD']);
    fs.appendFileSync(path.join(repo, 'docs', 'one.md'), '\n# Uncommitted\n');
    fs.writeFileSync(path.join(repo, 'docs', 'untracked.md'), '# Must not leak\n');
    const adapters = api.productionAdapters({ configPath: 'fixture.json' }, {
      loadConfig: () => ({ codexAuth: 'chatgpt', targetRepoPath: repo, model: 'gpt-fixture', reasoningEffort: 'medium' }),
      kickoffApi: { statePathsFor: () => ({ state: path.join(repo, '.state') }) },
      bdJson: () => ({ ok: true, data: [] }), resolveBranch: () => ({ ok: true, branch: 'HEAD' }),
    });
    assert.deepStrictEqual(await adapters.deriveDesignReferenceCandidates(pinned), [
      'DESIGN.md#architecture', 'docs/one.md#zeta', 'docs/one.md#alpha',
    ]);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('T4 C4 production-shaped JSONL rejects observed small/anchorless vocabulary, then schema-guided compliant JSONL creates one canonical Beads issue without API keys', async () => {
  const record = kickoff('kp-wiring'); const plans = [], creates = [], refs = [];
  const launch = async plan => { plans.push(plan); return api.normalizeCodexOutput(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(readyWire) } })); };
  const bad = await api.execute({ proposalId: record.id }, {}, seams(record, { launchCodex: async () => JSON.stringify({ ...readyWire, difficulty: 'small', designReferences: ['DESIGN.md'], question: null }) }));
  assert.strictEqual(bad.status, 'refused');
  const invented = await api.execute({ proposalId: record.id }, {}, seams(record, {
    launchCodex: async () => JSON.stringify({ ...readyWire, designReferences: ['DESIGN.md#invented'] }),
    validateDesignReference: async () => ({ ok: true }),
  }));
  assert.strictEqual(invented.status, 'refused');
  let questions = 0;
  const inventedQuestion = await api.execute({ proposalId: record.id }, {}, seams(record, {
    launchCodex: async () => JSON.stringify({ ...readyWire, status: 'needs-input', question: 'Choose?', designReferences: ['DESIGN.md#invented'] }),
    appendQuestion: async () => { questions += 1; },
  }));
  assert.strictEqual(inventedQuestion.status, 'refused'); assert.strictEqual(questions, 0);
  const good = await api.execute({ proposalId: record.id }, {}, seams(record, { launchCodex: launch, beadsCreate: async request => { creates.push(request); return { id: 'repo-canonical' }; }, validateDesignReference: async (ref, commit) => { refs.push([ref, commit]); return { ok: true }; } }));
  assert.strictEqual(good.status, 'ready'); assert.strictEqual(good.issueId, 'repo-canonical'); assert.strictEqual(creates.length, 1);
  assert.deepStrictEqual(refs, [['DESIGN.md#architecture', COMMIT]]); assert.strictEqual(plans.length, 1);
  assert(plans[0].args.includes('--output-schema'));
  assert(['CODEX_API_KEY', 'OPENAI_API_KEY'].every(name => plans[0].removeEnv.includes(name)), JSON.stringify(plans[0].removeEnv));
});

test('T5 C5 empty or oversized discovery safely pauses/refuses before planner launch and cannot invent unresolvable provenance', async () => {
  const huge = Array.from({ length: 128 }, (_, i) => `docs/${String(i).padStart(3, '0')}-${'x'.repeat(700)}.md#anchor`);
  const cases = [[], ['README.md'], Array.from({ length: 129 }, (_, i) => `docs/${i}.md#anchor`), huge];
  for (const [index, candidates] of cases.entries()) {
    const record = kickoff(`kp-bound-${index}`); let checkouts = 0, launches = 0, creates = 0;
    const result = await api.execute({ proposalId: record.id }, {}, seams(record, { deriveDesignReferenceCandidates: async () => candidates, createReadOnlyCheckout: async () => { checkouts += 1; return { path: ROOT, commit: COMMIT, readOnly: true }; }, launchCodex: async () => { launches += 1; return JSON.stringify(readyWire); }, beadsCreate: async () => { creates += 1; return { id: 'must-not-create' }; } }));
    assert.strictEqual(result.status, 'refused', JSON.stringify(result)); assert.strictEqual(checkouts, 0); assert.strictEqual(launches, 0); assert.strictEqual(creates, 0);
  }
  const record = kickoff('kp-discovery-error'); let launches = 0;
  const failed = await api.execute({ proposalId: record.id }, {}, seams(record, {
    deriveDesignReferenceCandidates: async () => { throw new Error('git read failed'); },
    launchCodex: async () => { launches += 1; return JSON.stringify(readyWire); },
  }));
  assert.strictEqual(failed.status, 'refused'); assert.match(failed.reason, /candidate|design.reference/i); assert.strictEqual(launches, 0);
});

(async () => {
  let failed = 0;
  for (const item of tests) { try { await item.body(); console.log(`[test] PASS ${item.name}`); } catch (error) { failed += 1; console.error(`[test] FAIL ${item.name}: ${error.stack || error.message}`); } }
  if (failed) { console.error(`[test] FAIL ${failed}/${tests.length} focused checks`); process.exitCode = 1; }
  else console.log(`[test] PASS ${tests.length}/${tests.length} focused checks`);
})().catch(error => { console.error(`[test] FAIL harness: ${error.stack || error.message}`); process.exitCode = 1; });
