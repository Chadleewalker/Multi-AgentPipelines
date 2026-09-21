// Frozen acceptance test — repo-7nc, the [guard] half: the behaviour this consolidation must
// NOT change. Every check in this file is GREEN at the fork point and must stay green; the RED
// checks that prove the new containment-cleanup reporting live in `test.js` beside it.
//
// [guard] These checks pin "existing behaviour X still holds" and are the green-at-the-fork-point
// halves the criteria call for: the unchanged Codex/Claude launch behaviour and author-containment
// env contract (C3), the current authorIssue provider outcomes with no cleanup evidence and the
// authoritative canonical usage-limit reset identity (C4), the batch worker's existing terminal
// invalid-outcome envelope (C5), and the static presence of the behavioural suites and modules the
// candidate must keep green (C6). Nothing red belongs here: a [guard] file red at the fork point is
// a stale pin and refuses the freeze outright (`scripts/freeze-gate.js`, verdict `stale-guard`).
//
// SELF-CONTAINED ON PURPOSE: node built-ins only, key-free, no Beads, no live provider, no network,
// no container engine, and no execution of any generated shim file. It resolves the repository as
// the tree it sits in (`__dirname/../../..`), never the cwd, so the freeze gate's flat guard-subset
// run judges exactly the tree the suite saw.
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const CONTAINMENT_FILE = path.join(ROOT, 'runner', 'author-containment.js');
const AUTHOR = require(path.join(ROOT, 'scripts', 'author-tests.js'));
const CONTAIN = require(CONTAINMENT_FILE);
const WORKER = require(path.join(ROOT, 'scripts', 'prepare-batch-worker.js'));

// Key-free and deterministic, exactly like the frozen repo-djf.40/.43/.44 suites.
for (const name of ['CODEX_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN',
  'PIPELINE_BD_CMD', 'BD_ARGS_LOG', 'BD_STUB_OUT', 'BD_STUB_EXIT',
  'PIPELINE_TEST_AUTHOR_CMD', 'PIPELINE_TEST_PROBE_CMD']) delete process.env[name];

let failed = 0;
function check(name, fn) {
  try { fn(); console.log(`ok - ${name}`); }
  catch (e) { failed = 1; console.log(`FAIL - ${name} — ${e && e.message ? e.message : e}`); }
}

const temps = [];
function tmp(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `repo-7nc-guard-${tag}-`));
  temps.push(dir);
  return dir;
}

const ISSUE = 'repo-7nc';
const USAGE_LIMIT_RESET = '2026-09-18T00:00:00.000Z';
const CODEX_TERMINAL = `${JSON.stringify({ type: 'thread.started', thread_id: 'th-7nc' })}\n`
  + `${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Wrote the suite.' } })}\n`
  + `${JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } })}\n`;
const CODEX_NO_TERMINAL = `${JSON.stringify({ type: 'thread.started', thread_id: 'th-7nc' })}\n`
  + `${JSON.stringify({ type: 'item.started', item: { type: 'agent_message' } })}\n`;
const CODEX_USAGE_LIMIT = `${JSON.stringify({ type: 'error',
  error: { type: 'usage_limit_exceeded', message: 'usage limit reached', resets_at: USAGE_LIMIT_RESET } })}\n`;

function writeBuilt(cfgOverrides = {}) {
  const dir = tmp('worktree');
  return {
    ok: true, state: 'write', id: ISSUE, suiteId: ISSUE, branch: 'main',
    text: `FIXTURE BRIEF for ${ISSUE}`,
    policy: { verifyCommand: 'sh tools/run-acceptance.sh', frozenPaths: ['tools/run-acceptance.sh'] },
    folder: { dir, exists: true, branch: `freeze-${ISSUE}` },
    cfg: {
      targetRepoPath: ROOT, model: 'fixture-model', testAuthorModel: 'fixture-model',
      testProbeModel: 'fixture-model', wallClockMinutes: 2,
      provider: 'codex', testAuthorProvider: 'codex', testProbeProvider: 'codex',
      reasoningEffort: 'high', testAuthorReasoningEffort: 'high', hostEnv: {}, ...cfgOverrides,
    },
  };
}

function runAuthorIssue(built, launched) {
  const out = []; const err = []; const proofs = [];
  const result = AUTHOR.authorIssue(built, path.join(ROOT, 'run.config.fixture.json'), {
    out: (m) => out.push(String(m)), err: (m) => err.push(String(m)),
  }, {
    auditAuthorTree: () => ({ ok: true }),
    launchAuthor: () => launched,
    proveTests: () => { proofs.push(true); return { ok: true, attempt: 1, probe: null, evidence: '', agentOutput: '' }; },
  });
  return { result, out: out.join('\n'), err: err.join('\n'), proofs: proofs.length };
}

function pathKeys(env) { return Object.keys(env).filter((k) => k.toLowerCase() === 'path'); }

// ── G1 / C3 guard: the Claude launch argv and behaviour are unchanged ─────────────────────────
check('C3 [guard] launchAuthor still launches Claude with its exact legacy argv and never adds cleanup metadata for a non-Codex provider', () => {
  const built = writeBuilt({ provider: 'claude', testAuthorProvider: 'claude', testProbeProvider: 'claude' });
  let captured = null;
  const run = (command, args, opts) => { captured = { command, args, opts }; return { status: 0, stdout: 'done\n', stderr: '' }; };
  const result = AUTHOR.launchAuthor(built, 'fixture-model', run);
  assert(captured, 'the run seam was never reached');
  assert.strictEqual(captured.command, 'claude', `Claude launch command changed: ${captured.command}`);
  assert.strictEqual(captured.args[0], '-p', 'the Claude author argv no longer leads with -p');
  assert(captured.args.includes('--no-session-persistence'), 'the Claude author argv dropped --no-session-persistence');
  const di = captured.args.indexOf('--disallowedTools');
  assert(di >= 0 && /Bash\(bd \*\)/.test(String(captured.args[di + 1])), 'Claude no longer closes Beads via --disallowedTools Bash(bd *)');
  assert.strictEqual(result.status, 0, 'the Claude launch result status changed');
  assert.strictEqual(result.stdout, 'done\n', 'the Claude launch result stdout changed');
  assert.strictEqual(result.containmentCleanup, undefined, 'a non-Codex provider was given containment cleanup metadata');
});

// ── G2 / C3 guard: the author-containment env contract still closes Beads ─────────────────────
check('C3 [guard] containEnv still leads PATH with a bd/bd.cmd shim directory and strips the host bd overrides, and applyEnv still exposes only prepared.dir', () => {
  const baseEnv = { PATH: `${path.join('x', 'bin')}${path.delimiter}${path.join('y', 'bin')}`,
    PIPELINE_BD_CMD: '/host/bd', BD_ARGS_LOG: '/tmp/log', HOME: '/tmp/fixture-home' };
  const env = CONTAIN.containEnv(baseEnv, ISSUE);
  assert.deepStrictEqual(pathKeys(env), ['PATH'], `containEnv must leave exactly one PATH key, got ${JSON.stringify(pathKeys(env))}`);
  const first = String(env.PATH).split(path.delimiter)[0];
  for (const n of ['bd', 'bd.cmd']) assert(fs.existsSync(path.join(first, n)), `the leading PATH directory is missing the ${n} shim`);
  for (const name of CONTAIN.BD_OVERRIDE_NAMES) assert(!(name in env), `containEnv left the host bd override ${name} in the child environment`);
  assert.strictEqual(env.HOME, '/tmp/fixture-home', 'containEnv altered an unrelated environment variable');

  const applied = CONTAIN.applyEnv(baseEnv, { dir: first });
  assert.strictEqual(String(applied.PATH).split(path.delimiter)[0], path.resolve(first),
    'applyEnv no longer leads PATH with exactly prepared.dir');
  assert(typeof CONTAIN.refusalText(ISSUE) === 'string' && CONTAIN.refusalText(ISSUE).includes(ISSUE),
    'the containment refusal text no longer names the snapshotted issue');
  assert(Number.isInteger(CONTAIN.REFUSAL_EXIT), 'the containment refusal exit code is no longer an integer');
});

// ── G3 / C4 guard: current authorIssue outcomes and usage-limit identity are preserved ────────
check('C4 [guard] a successful provider (Claude, or Codex with successful cleanup) still proves normally', () => {
  const claude = runAuthorIssue(
    writeBuilt({ provider: 'claude', testAuthorProvider: 'claude', testProbeProvider: 'claude' }),
    { status: 0, stdout: 'Wrote the suite and stopped.\n', stderr: '' });
  assert.strictEqual(claude.result.ok, true, JSON.stringify(claude.result));
  assert.strictEqual(claude.result.outcome, 'proven', JSON.stringify(claude.result));
  assert.strictEqual(claude.proofs, 1, 'a successful Claude session did not reach the green proof');

  const codex = runAuthorIssue(writeBuilt(), { status: 0, stdout: CODEX_TERMINAL, stderr: '', containmentCleanup: { ok: true } });
  assert.strictEqual(codex.result.ok, true, JSON.stringify(codex.result));
  assert.strictEqual(codex.proofs, 1, 'a successful Codex session with successful cleanup did not reach the green proof');
});

check('C4 [guard] a failing or incomplete provider outcome still starts no proof', () => {
  const failed = runAuthorIssue(writeBuilt(), { status: 9, stdout: '', stderr: 'codex died' });
  assert.strictEqual(failed.result.outcome, 'agent-failed', JSON.stringify(failed.result));
  assert.strictEqual(failed.proofs, 0);
  const incomplete = runAuthorIssue(writeBuilt(), { status: 0, stdout: CODEX_NO_TERMINAL, stderr: '' });
  assert.strictEqual(incomplete.result.outcome, 'agent-incomplete', JSON.stringify(incomplete.result));
  assert.strictEqual(incomplete.proofs, 0);
});

check('C4 [guard] a canonical usage-limit still reports its authoritative reset identity, starts no proof, and prints no freeze command', () => {
  const seen = runAuthorIssue(writeBuilt(), { status: 1, stdout: CODEX_USAGE_LIMIT, stderr: '' });
  assert.strictEqual(seen.result.outcome, 'usage-limit', JSON.stringify(seen.result));
  assert(seen.result.rateLimit && seen.result.rateLimit.resetAt === USAGE_LIMIT_RESET,
    `the canonical usage-limit reset identity changed: ${JSON.stringify(seen.result.rateLimit)}`);
  assert.strictEqual(seen.proofs, 0, 'a usage-limit invocation reached the green proof');
  assert(!/freeze\.js commit/.test(seen.out), 'a usage-limit invocation printed a freeze command');
});

// ── G4 / C5 guard: the batch worker's existing terminal invalid-outcome envelope is preserved ──
check('C5 [guard] the batch worker still answers a malformed job with its existing terminal invalid outcome', () => {
  for (const bad of [{}, null, { action: 'author-proof' }, { action: 'nope', built: {} }]) {
    const env = WORKER.execute(bad);
    assert(env && env.ok === false, `execute() did not fail a malformed job: ${JSON.stringify(env)}`);
    assert.strictEqual(env.outcome, 'invalid', `execute() lost the existing invalid outcome for a malformed job: ${JSON.stringify(env)}`);
    assert(typeof env.error === 'string' && env.error.length > 0, `the invalid envelope carries no error text: ${JSON.stringify(env)}`);
  }
});

// ── G5 / C6 guard: the behavioural suites and consumer modules the candidate must keep are present ─
check('C6 [guard] the behavioural suites and consumer-boundary modules this consolidation builds on are still present with their public surface', () => {
  for (const suite of ['repo-djf.40', 'repo-djf.43', 'repo-djf.44', 'repo-7a0', 'repo-45g']) {
    for (const file of ['test.js', 'guard.js']) {
      assert(fs.existsSync(path.join(ROOT, 'tests', 'acceptance', suite, file)),
        `the behavioural suite file tests/acceptance/${suite}/${file} is missing`);
    }
  }
  assert(fs.existsSync(CONTAINMENT_FILE), 'runner/author-containment.js is missing');
  assert.strictEqual(typeof AUTHOR.launchAuthor, 'function', 'scripts/author-tests.js no longer exports launchAuthor');
  assert.strictEqual(typeof AUTHOR.authorIssue, 'function', 'scripts/author-tests.js no longer exports authorIssue');
  assert.strictEqual(typeof WORKER.execute, 'function', 'scripts/prepare-batch-worker.js no longer exports execute');
});

for (const dir of temps.splice(0)) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
process.exit(failed);
