// Frozen acceptance guard — repo-djf.38. [guard]
// Criteria -> tests: C6 -> guard.js; C1-C5 -> test.js.
// Tests -> criteria: G1 preserves C6's saved-ChatGPT receipt/idempotency boundary;
// G2 preserves the complete already-frozen repo-djf.6 specification-engine contract.
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const path = require('path');
const { spawnSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..', '..', '..');
const api = require(path.join(ROOT, 'scripts', 'specify-proposal.js'));
let failed = 0;
function check(name, body) { try { body(); console.log(`ok - ${name}`); } catch (error) { failed = 1; console.error(`FAIL - ${name} — ${error.stack || error.message}`); } }
const sha = value => `sha256:${crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')}`;

// G1 / C6: a verified receipt stops before the planner, so saved ChatGPT credentials and
// immutable issue identity are not re-consumed on restart.
(async () => {
  const intent = JSON.stringify({ version: 'kickoff-intake/1', title: 'guard', description: '', constraints: [], examples: [], nonGoals: [], priority: 3, relations: [], origin: null });
  const kickoff = { version: 'kickoff-intake/1', id: 'kp-guard', target: ROOT, hash: sha(intent), intent, createdAt: '2026-09-15T00:00:00.000Z' };
  const proposal = { spec: 'Keep receipt restart behavior.', acceptanceCriteria: ['A restart reuses the receipt.'], designReferences: ['DESIGN.md#architecture'], difficulty: 'medium', status: 'ready' };
  const receipt = { kickoffHash: kickoff.hash, proposal, specHash: sha(proposal), issueId: 'repo-existing', integrationCommit: 'a'.repeat(40) };
  let launches = 0;
  const result = await api.execute({ proposalId: kickoff.id }, {}, {
    sha256: sha, readKickoff: async () => kickoff, readReceipt: async () => receipt,
    readQuestion: async () => null, readAnswer: async () => null,
    resolveIntegration: async () => { throw new Error('receipt path must not resolve integration'); },
    createReadOnlyCheckout: async () => { throw new Error('receipt path must not checkout'); },
    cleanupCheckout: async () => {}, launchCodex: async () => { launches += 1; return null; },
  });
  check('G1 C6 [guard] verified immutable receipt returns its canonical issue without planner launch', () => {
    assert.strictEqual(result.status, 'ready'); assert.strictEqual(result.issueId, 'repo-existing'); assert.strictEqual(launches, 0);
  });
  const env = { ...process.env };
  delete env.CODEX_API_KEY; delete env.OPENAI_API_KEY; delete env.ANTHROPIC_API_KEY; delete env.CLAUDE_CODE_OAUTH_TOKEN;
  const legacy = spawnSync(process.execPath, [path.join(ROOT, 'tests', 'acceptance', 'repo-djf.6', 'test.js')], {
    cwd: ROOT, encoding: 'utf8', shell: false, env,
  });
  check('G2 C6 [guard] the already-frozen repo-djf.6 specification-engine contract remains green', () => {
    assert.strictEqual(legacy.status, 0, `${legacy.stdout || ''}\n${legacy.stderr || ''}`);
  });
  process.exitCode = failed;
})().catch(error => { failed = 1; console.error(`FAIL - guard harness — ${error.stack || error.message}`); process.exitCode = failed; });
