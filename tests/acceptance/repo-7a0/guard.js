// Frozen acceptance guard — repo-7a0. [guard]
// Criteria -> tests: C1 -> test.js T1; C2 -> test.js T2 + G1 here; C3 -> test.js T3;
//                    C4 -> test.js T4 + G2 and G3 here.
// Tests -> criteria: G1 preserves C2's mechanical worktree boundary — the audit that rejects any
// edit outside tests/acceptance/<issue>/ and accepts every edit inside it;
// G2 preserves C4's Claude compatibility — the historical author tool grant and the Bash denial
// that is what already closes Beads on that provider;
// G3 preserves C4's other half — the exact Codex author argv frozen by tests/acceptance/repo-45g,
// which is why containment for C1 has to travel in the environment and never in a flag.
// Every check here is GREEN at the fork point and must stay green.
'use strict';

const assert = require('assert');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');

// Key-free and override-free, exactly as the red half runs.
for (const name of ['CODEX_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN',
  'PIPELINE_BD_CMD', 'PIPELINE_TEST_AUTHOR_CMD', 'PIPELINE_TEST_PROBE_CMD']) delete process.env[name];

const AUTHOR = require(path.join(ROOT, 'scripts', 'author-tests.js'));
const AGENT = require(path.join(ROOT, 'runner', 'agent-provider.js'));

let failed = 0;
function check(name, body) {
  try { body(); console.log(`ok - ${name}`); }
  catch (error) { failed = 1; console.error(`FAIL - ${name} — ${error.stack || error.message}`); }
}

const ISSUE = 'repo-7a0';
const SUITE = `tests/acceptance/${ISSUE}`;

function built(cfg = {}) {
  return {
    id: ISSUE, suiteId: ISSUE, text: 'guard brief',
    policy: { verifyCommand: 'sh tools/run-acceptance.sh' },
    folder: { dir: 'C:/guard worktree', exists: true, branch: `freeze-${ISSUE}` },
    cfg: { targetRepoPath: ROOT, model: 'fixture-model', wallClockMinutes: 2, hostEnv: {}, ...cfg },
  };
}

// A fake `git status --porcelain=v1 -z --untracked-files=all` reply. No repository is created:
// the audit's whole job is classifying the paths git reports, and a fixture keeps this guard
// self-contained enough to run alone in the gate's flat guard directory.
function status(records, exit = 0) {
  return () => ({ status: exit, stdout: records.map((r) => `${r}\0`).join(''), stderr: '' });
}

// G1 / C2 — the mechanical boundary around the one suite the author may create.
check('G1 C2 [guard] the test-author boundary audit accepts every path inside the issue suite', () => {
  const inside = AUTHOR.auditAuthorTree(built(), status([
    `?? ${SUITE}/test.js`,
    ` M ${SUITE}/guard.js`,
    `?? ${SUITE}/.freeze-gate.json`,
    `?? ${SUITE.split('/').join('\\')}\\nested\\fixture.json`,
  ]));
  assert.deepStrictEqual(inside, { ok: true }, JSON.stringify(inside));
});

check('G1 C2 [guard] the test-author boundary audit rejects any edit outside the issue suite, by path', () => {
  for (const outside of ['scripts/author-tests.js', 'tools/run-acceptance.sh',
    'tests/acceptance/repo-djf.38/test.js', 'tests/acceptance/repo-7a0-extra/test.js', 'DESIGN.md']) {
    const r = AUTHOR.auditAuthorTree(built(), status([`?? ${outside}`, `?? ${SUITE}/test.js`]));
    assert.strictEqual(r.ok, false, `${outside} was accepted: ${JSON.stringify(r)}`);
    assert(String(r.error).includes(outside), `${outside} is not named in the refusal: ${r.error}`);
    assert(String(r.error).includes(SUITE), `the refusal does not name the one permitted suite: ${r.error}`);
  }
});

check('G1 C2 [guard] an audit that could not read the tree is a refusal, never a silent pass', () => {
  const r = AUTHOR.auditAuthorTree(built(), status([], 128));
  assert.strictEqual(r.ok, false, JSON.stringify(r));
  assert(typeof r.error === 'string' && r.error.length > 0, JSON.stringify(r));
});

// G2 / C4 — Claude compatibility. The author stage owns this argv and the adapter returns it
// untouched; `Bash(bd *)` / `Bash(bd*)` is what already closes Beads on the Claude provider.
check('G2 C4 [guard] the Claude test-author argv, tool grant and bd denial are unchanged', () => {
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
  assert.strictEqual(AUTHOR.AUTHOR_TOOLS, 'Read,Edit,Write,Glob,Grep,Bash');
  const denied = AUTHOR.DENIED_TOOLS.split(',');
  for (const pattern of ['Bash(bd *)', 'Bash(bd*)', 'Bash(git commit*)', 'Bash(git push*)', 'Bash(node *freeze.js*)']) {
    assert(denied.includes(pattern), `${pattern} is gone from the Claude author denial list: ${AUTHOR.DENIED_TOOLS}`);
  }
});

// G3 / C4 — the Codex author argv is pinned by the already-frozen repo-45g suite. Containment
// for C1 therefore cannot be a flag; the only place left is the launch environment.
check('G3 C4 [guard] the Codex noninteractive author argv is byte-for-byte the frozen contract', () => {
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

process.exitCode = failed;
