// Frozen acceptance guard — repo-djf.40. [guard]
// Criteria -> tests: C6 (existing repo-7a0 containment, Claude compatibility, boundary and
// no-key behavior remain green) -> G1, G2, G3, G4 here.
// Tests -> criteria: G1 preserves C6's boundary half — the audit that admits only
// tests/acceptance/<issue>/ and refuses everything else; G2 preserves C6's Claude-compatibility
// half — the historical author tool grant and Bash(bd *) denial that already closes Beads on
// that provider; G3 preserves C6's Codex-argv half — the byte-for-byte contract repo-45g and
// repo-7a0 both already pin, which is why shim disposal has to happen around that argv rather
// than inside it; G4 preserves C6's containment half structurally — the generated shims carry
// the bounded issue-specific refusal and lead a host-override-free PATH. The already-frozen
// repo-7a0 suite remains the runtime execution proof, including on noexec temp mounts.
// Every check here is GREEN at the fork point (repo-7a0 is already merged) and must stay green.
'use strict';

const assert = require('assert');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');

// Key-free and override-free, exactly as the red half runs.
for (const name of ['CODEX_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN',
  'PIPELINE_BD_CMD', 'BD_ARGS_LOG', 'BD_STUB_OUT', 'BD_STUB_EXIT',
  'PIPELINE_TEST_AUTHOR_CMD', 'PIPELINE_TEST_PROBE_CMD']) delete process.env[name];

const AUTHOR = require(path.join(ROOT, 'scripts', 'author-tests.js'));
const AGENT = require(path.join(ROOT, 'runner', 'agent-provider.js'));
const CONTAINMENT = require(path.join(ROOT, 'runner', 'author-containment.js'));

let failed = 0;
function check(name, body) {
  try { body(); console.log(`ok - ${name}`); }
  catch (error) { failed = 1; console.error(`FAIL - ${name} — ${error.stack || error.message}`); }
}

const ISSUE = 'repo-djf.40';
const SUITE = `tests/acceptance/${ISSUE}`;

function built(cfg = {}) {
  return {
    id: ISSUE, suiteId: ISSUE, text: 'guard brief',
    policy: { verifyCommand: 'sh tools/run-acceptance.sh' },
    folder: { dir: 'C:/guard worktree', exists: true, branch: `freeze-${ISSUE}` },
    cfg: { targetRepoPath: ROOT, model: 'fixture-model', wallClockMinutes: 2, hostEnv: {}, ...cfg },
  };
}

function status(records, exit = 0) {
  return () => ({ status: exit, stdout: records.map((r) => `${r}\0`).join(''), stderr: '' });
}

// G1 / C6 — the boundary audit around the one suite an author may create is unmoved by
// disposal work landing anywhere in the launch path.
check('G1 C6 [guard] the test-author boundary audit still accepts every path inside this issue suite and rejects everything else', () => {
  const inside = AUTHOR.auditAuthorTree(built(), status([
    `?? ${SUITE}/test.js`,
    ` M ${SUITE}/guard.js`,
  ]));
  assert.deepStrictEqual(inside, { ok: true }, JSON.stringify(inside));
  const outside = AUTHOR.auditAuthorTree(built(), status([`?? scripts/author-tests.js`, `?? ${SUITE}/test.js`]));
  assert.strictEqual(outside.ok, false, JSON.stringify(outside));
  assert(String(outside.error).includes('scripts/author-tests.js'), outside.error);
});

// G2 / C6 — Claude compatibility: the author stage owns this argv, the adapter returns it
// untouched, and `Bash(bd *)` / `Bash(bd*)` is what already closes Beads on that provider.
check('G2 C6 [guard] the Claude test-author argv, tool grant and bd denial are unchanged', () => {
  let call = null;
  const run = (command, args, opts) => { call = { command, args, opts }; return { status: 0, stdout: '', stderr: '' }; };
  AUTHOR.launchAuthor(built({ provider: 'claude', testAuthorProvider: 'claude' }), 'fixture-model', run);
  assert(call, 'launchAuthor did not reach the host run seam');
  assert.strictEqual(call.command, 'claude');
  assert.deepStrictEqual(call.args, [
    '-p', '--model', 'fixture-model',
    '--restricted', '--permission-mode', 'acceptEdits',
    '--tools', 'Read,Edit,Write,Glob,Grep,Bash',
    '--allowedTools', `Read,Edit,Write,Glob,Grep,Bash(sh tools/run-acceptance.sh ${SUITE}/)`,
    '--disallowedTools', AUTHOR.DENIED_TOOLS,
    '--no-session-persistence',
  ], JSON.stringify(call.args));
  assert.strictEqual(call.opts.input, 'guard brief\n');
  const denied = AUTHOR.DENIED_TOOLS.split(',');
  for (const pattern of ['Bash(bd *)', 'Bash(bd*)']) {
    assert(denied.includes(pattern), `${pattern} is gone from the Claude author denial list: ${AUTHOR.DENIED_TOOLS}`);
  }
});

// G3 / C6 — the Codex author argv is pinned byte for byte by repo-45g and repo-7a0 already;
// disposal has to happen around this argv, never inside it.
check('G3 C6 [guard] the Codex noninteractive author argv is byte-for-byte the frozen contract', () => {
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
  assert.strictEqual(call.opts.input, 'guard brief\n');
});

// G4 / C6 — pin the generated containment contract without executing a temp shim. The verifier's
// temp mount may be noexec; runtime refusal is already covered by the mandatory repo-7a0 suite.
check('G4 C6 [guard] prepared containment stays issue-specific, bounded and free of host bd overrides', () => {
  const fs = require('fs');
  const os = require('os');
  const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-djf40-guard-shim-'));
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
