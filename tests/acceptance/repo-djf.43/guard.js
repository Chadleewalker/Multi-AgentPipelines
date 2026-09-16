// Frozen acceptance guard — repo-djf.43. [guard]
// Criteria -> tests: C4's stay-green half (existing repo-djf.40 coverage, no-key behavior, Claude
// compatibility, and the full mandatory regression profile) -> G1, G2, G3 here.
// Tests -> criteria: G1 preserves C4's Claude-compatibility half — construction-time rollback is
// scoped entirely to `runner/author-containment.js`'s Codex-only `prepare()`, so the Claude
// test-author argv, tool grant and `Bash(bd *)` denial that already close Beads on that provider
// must not move by so much as a byte. G2 preserves C4's Codex-argv half — the byte-for-byte
// contract repo-45g and repo-7a0 both already pin, which rollback work happens entirely beneath,
// never inside. G3 preserves the foundation every rollback check in test.js extends: the legacy,
// no-`fallbackParents` `prepare()`/`applyEnv()` shape repo-djf.40 itself guarded — a real,
// non-symlinked, issue-specific, bounded-refusal shim pair that leads PATH and strips the host's
// own bd overrides. Ownership-initialization rollback must be additive to this, never a
// replacement of it.
// Every check here is GREEN at the fork point (repo-7a0 is merged; repo-djf.40 is not yet, so
// this guard deliberately stays on the interface repo-7a0 already fixed) and must stay green.
'use strict';

const assert = require('assert');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');

for (const name of ['CODEX_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN',
  'PIPELINE_BD_CMD', 'BD_ARGS_LOG', 'BD_STUB_OUT', 'BD_STUB_EXIT']) delete process.env[name];

const AUTHOR = require(path.join(ROOT, 'scripts', 'author-tests.js'));
const AGENT = require(path.join(ROOT, 'runner', 'agent-provider.js'));
const CONTAINMENT = require(path.join(ROOT, 'runner', 'author-containment.js'));

let failed = 0;
function check(name, body) {
  try { body(); console.log(`ok - ${name}`); }
  catch (error) { failed = 1; console.error(`FAIL - ${name} — ${error.stack || error.message}`); }
}

const ISSUE = 'repo-djf.43';

function built(cfg = {}) {
  return {
    id: ISSUE, suiteId: ISSUE, text: 'guard brief',
    policy: { verifyCommand: 'sh tools/run-acceptance.sh' },
    folder: { dir: 'C:/guard worktree', exists: true, branch: `freeze-${ISSUE}` },
    cfg: { targetRepoPath: ROOT, model: 'fixture-model', wallClockMinutes: 2, hostEnv: {}, ...cfg },
  };
}

// G1 / C4 — Claude compatibility: rollback work lives entirely inside the Codex-only prepare()
// path, so the Claude author argv, tool grant and bd denial must be exactly what they are today.
check('G1 C4 [guard] the Claude test-author argv, tool grant and bd denial are unchanged', () => {
  let call = null;
  const run = (command, args, opts) => { call = { command, args, opts }; return { status: 0, stdout: '', stderr: '' }; };
  AUTHOR.launchAuthor(built({ provider: 'claude', testAuthorProvider: 'claude' }), 'fixture-model', run);
  assert(call, 'launchAuthor did not reach the host run seam');
  assert.strictEqual(call.command, 'claude');
  assert.deepStrictEqual(call.args, [
    '-p', '--model', 'fixture-model',
    '--restricted', '--permission-mode', 'acceptEdits',
    '--tools', 'Read,Edit,Write,Glob,Grep,Bash',
    '--allowedTools', `Read,Edit,Write,Glob,Grep,Bash(sh tools/run-acceptance.sh tests/acceptance/${ISSUE}/)`,
    '--disallowedTools', AUTHOR.DENIED_TOOLS,
    '--no-session-persistence',
  ], JSON.stringify(call.args));
  const denied = AUTHOR.DENIED_TOOLS.split(',');
  for (const pattern of ['Bash(bd *)', 'Bash(bd*)']) {
    assert(denied.includes(pattern), `${pattern} is gone from the Claude author denial list: ${AUTHOR.DENIED_TOOLS}`);
  }
});

// G2 / C4 — the Codex noninteractive author argv is pinned byte for byte by repo-45g and
// repo-7a0 already; rollback happens beneath this argv, never inside it.
check('G2 C4 [guard] the Codex noninteractive author argv is byte-for-byte the frozen contract', () => {
  assert.deepStrictEqual(AGENT.codexExecArgs('fixture-model', 'high'), [
    'exec', '--model', 'fixture-model', '-c', 'model_reasoning_effort="high"',
    '-c', 'shell_environment_policy.ignore_default_excludes=false',
    '-c', 'shell_environment_policy.filters.CODEX_API_KEY="exclude"',
    '--approve-for-me', '--ephemeral', '--ignore-user-config', '--ignore-rules',
    '--strict-config', '--json', '-',
  ]);
  let call = null;
  const run = (command, args, opts) => { call = { command, args, opts }; return { status: 0, stdout: '', stderr: '' }; };
  AUTHOR.launchAuthor(built({ provider: 'codex', testAuthorProvider: 'codex', reasoningEffort: 'high' }), 'fixture-model', run);
  assert(call, 'launchAuthor did not reach the host run seam');
  assert.strictEqual(call.command, 'codex');
  assert.deepStrictEqual(call.args, AGENT.codexExecArgs('fixture-model', 'high'), JSON.stringify(call.args));
});

// G3 / C4 — the legacy, no-`fallbackParents` prepare()/applyEnv() shape repo-djf.40 itself
// guarded: a real, issue-specific, bounded-refusal shim pair that leads PATH and strips the
// host's own bd overrides. Ownership-initialization rollback must extend this, not replace it.
check('G3 C4 [guard] the legacy no-fallback prepare()/applyEnv() containment shape stays issue-specific, bounded and free of host bd overrides', () => {
  const fs = require('fs');
  const os = require('os');
  const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-djf43-guard-shim-'));
  try {
    const prepared = CONTAINMENT.prepare(shimDir, { issueId: ISSUE });
    assert.strictEqual(prepared.ok, true, JSON.stringify(prepared));
    for (const name of ['bd', 'bd.cmd']) {
      assert(fs.existsSync(path.join(prepared.dir, name)), `missing ${name} in ${prepared.dir}`);
    }
    const refusal = CONTAINMENT.refusalText(ISSUE);
    assert(refusal.length <= CONTAINMENT.REFUSAL_MAX_CHARS,
      `refusal exceeded the frozen bound: ${refusal.length}`);
    assert(refusal.includes(ISSUE), `refusal does not name the issue: ${refusal}`);
    for (const name of ['bd', 'bd.cmd']) {
      const body = fs.readFileSync(path.join(prepared.dir, name), 'utf8');
      assert(body.includes(ISSUE), `${name} does not carry the issue-specific refusal`);
    }
    const base = { PATH: process.env.PATH || process.env.Path || '', SENTINEL: 'survives' };
    for (const name of CONTAINMENT.BD_OVERRIDE_NAMES) base[name] = 'must-not-survive';
    const env = CONTAINMENT.applyEnv(base, prepared);
    assert(env.PATH.startsWith(prepared.dir), `containment does not lead PATH: ${env.PATH}`);
    assert.strictEqual(env.SENTINEL, 'survives', 'containment dropped an unrelated environment value');
    for (const name of CONTAINMENT.BD_OVERRIDE_NAMES) {
      assert.strictEqual(env[name], undefined, `${name} survived containment`);
    }
  } finally {
    fs.rmSync(shimDir, { recursive: true, force: true });
  }
});

process.exitCode = failed;
