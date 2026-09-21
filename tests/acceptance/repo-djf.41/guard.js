// Frozen acceptance test — repo-djf.41, the [guard] half: decoupling the specification
// planner lane from the implementation/test-author/test-probe models must not disturb the
// credential-isolation and legacy-routing behaviour this project already has.
//
// [guard] Every check in this file is GREEN at the fork point and must stay green. It is the
// baseline C4 (provider-specific credentials, no fallback) and C5 (legacy all-Claude and
// existing all-Codex routing keep their documented behaviour) already establish before this
// issue adds a fifth lane. The RED checks that prove the NEW behaviour — the decoupled
// `specificationModel` field, the specification-auth prerequisite, and the mixed-routing
// scenario — live in `test.js` beside it.
//
// SELF-CONTAINED ON PURPOSE: Node built-ins only, no Docker, no real Codex/Claude CLI, no
// network. Every credential value used below is an inert fixture string.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const REPO = path.resolve(__dirname, '..', '..', '..');
const CONFIG = path.join(REPO, 'runner', 'config.js');
const AGENT_PROVIDER = path.join(REPO, 'runner', 'agent-provider.js');
const PREREQUISITES = path.join(REPO, 'runner', 'prerequisites.js');
const CONTAINER = path.join(REPO, 'runner', 'container.js');
const SPECIFY_PROPOSAL = path.join(REPO, 'scripts', 'specify-proposal.js');

let failed = 0;
function check(name, cond, detail) {
  console.log(`${cond ? 'ok' : 'FAIL'} - ${name}${!cond && detail ? ` — ${detail}` : ''}`);
  if (!cond) failed = 1;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-djf41-'));

async function body() {
  const config = require(CONFIG);
  const AGENT = require(AGENT_PROVIDER);
  const prerequisites = require(PREREQUISITES);
  const container = require(CONTAINER);
  const specify = require(SPECIFY_PROPOSAL);

  // ---- C4 [guard] credential selection is already provider-specific, with no fallback ----
  const repoRootWithNoEnvFile = path.join(tmp, 'no-env-pipeline-here');
  const bothPresent = { CLAUDE_CODE_OAUTH_TOKEN: 'claude-secret-value', CODEX_API_KEY: 'codex-secret-value' };
  const claudeOnly = config.loadProviderCredential(repoRootWithNoEnvFile, 'claude', bothPresent);
  const codexOnly = config.loadProviderCredential(repoRootWithNoEnvFile, 'codex', bothPresent);
  check('C4 [guard] loadProviderCredential(claude) returns only the Claude-named variable',
    claudeOnly && claudeOnly.name === 'CLAUDE_CODE_OAUTH_TOKEN' && claudeOnly.value === 'claude-secret-value',
    JSON.stringify(claudeOnly));
  check('C4 [guard] loadProviderCredential(codex) returns only the Codex-named variable',
    codexOnly && codexOnly.name === 'CODEX_API_KEY' && codexOnly.value === 'codex-secret-value',
    JSON.stringify(codexOnly));
  const onlyCodexPresent = { CODEX_API_KEY: 'codex-secret-value' };
  check('C4 [guard] ... a Claude request with only a Codex secret present is refused, not backfilled',
    config.loadProviderCredential(repoRootWithNoEnvFile, 'claude', onlyCodexPresent) === null);
  const onlyClaudePresent = { CLAUDE_CODE_OAUTH_TOKEN: 'claude-secret-value' };
  check('C4 [guard] ... a Codex request with only a Claude secret present is refused, not backfilled',
    config.loadProviderCredential(repoRootWithNoEnvFile, 'codex', onlyClaudePresent) === null);

  // ---- C4 [guard] the specification launch already strips both Codex-shaped secrets -------
  // Existing since specify-proposal.js was introduced: the Codex CLI process itself needs no
  // ambient API key when authenticated by saved ChatGPT session, and this strip runs whether
  // or not the ambient host process happens to be carrying one.
  const ledgerRoot = path.join(tmp, 'strip-check-state');
  let captured = null;
  const stripAdapters = specify.productionAdapters({ configPath: 'unused' }, {
    loadConfig: () => ({ targetRepoPath: path.join(tmp, 'target'), codexAuth: 'chatgpt', model: 'opus' }),
    kickoffApi: { statePathsFor: () => ({ state: ledgerRoot }) },
    env: { CODEX_API_KEY: 'ambient-leak-1', OPENAI_API_KEY: 'ambient-leak-2', PATH: 'irrelevant' },
    run: (command, args, callOptions) => {
      captured = { command, args: [...args], env: { ...callOptions.env } };
      return { status: 0, stdout: '{}', stderr: '' };
    },
  });
  await stripAdapters.launchCodex({
    command: 'codex', args: ['exec', '--model', 'gpt-5.6-terra'],
    checkout: { path: path.join(tmp, 'checkout') }, prompt: 'irrelevant',
  });
  check('C4 [guard] the Codex specification launch still strips CODEX_API_KEY from the child env',
    captured && !Object.prototype.hasOwnProperty.call(captured.env, 'CODEX_API_KEY'), JSON.stringify(captured && Object.keys(captured.env)));
  check('C4 [guard] ... and still strips OPENAI_API_KEY from the child env',
    captured && !Object.prototype.hasOwnProperty.call(captured.env, 'OPENAI_API_KEY'));

  // ---- C5 [guard] a legacy all-Claude config (no provider fields at all) is unaffected ----
  const legacyClaudeCfg = { model: 'opus' };
  check('C5 [guard] every stage still resolves to claude when nothing names a provider',
    AGENT.providerFor(legacyClaudeCfg) === 'claude'
    && AGENT.providerFor(legacyClaudeCfg, 'test-author') === 'claude'
    && AGENT.providerFor(legacyClaudeCfg, 'test-probe') === 'claude');
  const legacyLaunch = AGENT.buildLaunch({ provider: 'claude', claudeArgs: ['--model', 'opus', '--flag'] });
  check('C5 [guard] the historical Claude argv passes through buildLaunch byte for byte',
    legacyLaunch.command === 'claude' && legacyLaunch.provider === 'claude'
    && legacyLaunch.args.join(' ') === '--model opus --flag');

  // ---- C5 [guard] an existing all-Codex config's implementation argv is unaffected --------
  const codexArgs = AGENT.codexExecArgs('gpt-codex-impl-model', 'high');
  check('C5 [guard] codexExecArgs still carries the IMPLEMENTATION model verbatim',
    codexArgs.includes('--model') && codexArgs[codexArgs.indexOf('--model') + 1] === 'gpt-codex-impl-model');
  check('C5 [guard] ... and the required exec capability flags are unchanged',
    AGENT.CODEX_REQUIRED_EXEC_FLAGS.every((flag) => codexArgs.includes(flag)));

  // ---- C1 [guard] the implementation lane was already decoupled from the test lanes -------
  // container.js sources PIPELINE_MODEL from cfg.model alone, never from testAuthorModel or
  // testProbeModel. Specification is the ONE lane this issue still has to decouple.
  const implCfg = {
    model: 'claude-opus-guard-model', testAuthorModel: 'claude-sonnet-guard-author',
    testProbeModel: 'claude-sonnet-guard-probe', image: 'guard-image:test',
    network: 'guard-net', proxyUrl: 'http://guard-proxy:3128',
  };
  const implArgs = container.buildArgs(implCfg,
    { containerName: 'guard-c', workspaceDir: '/w', pipelineDir: '/p', issueId: 'guard-i', token: 'tok' });
  check('C1 [guard] PIPELINE_MODEL is sourced from cfg.model alone',
    implArgs.includes('-e') && implArgs.includes('PIPELINE_MODEL=claude-opus-guard-model'));
  check('C1 [guard] ... never from testAuthorModel or testProbeModel',
    !implArgs.some((v) => typeof v === 'string' && v.includes('guard-author'))
    && !implArgs.some((v) => typeof v === 'string' && v.includes('guard-probe')));

  // ---- C3 [guard] the existing prerequisite order still gates before any auth probe --------
  let dockerCalled = false; let authCalled = false;
  const orderCfg = { provider: 'claude', testAuthorProvider: 'claude', testProbeProvider: 'claude', model: 'opus', image: 'guard:img' };
  const orderResult = prerequisites.checkPrerequisites(orderCfg, tmp, {
    dockerAvailable: () => { dockerCalled = true; return { status: 1, stderr: 'daemon down' }; },
    imageExists: () => { throw new Error('must not be reached: docker-daemon already failed'); },
    resolveHostShell: () => { throw new Error('must not be reached: docker-daemon already failed'); },
    loadToken: () => { authCalled = true; return 'x'; },
    loadProviderCredential: () => { authCalled = true; return null; },
    codexAuthStatus: () => { authCalled = true; return { status: 0 }; },
  });
  check('C3 [guard] a down Docker daemon is still refused first, by name',
    orderResult.ok === false && orderResult.prerequisite === 'docker-daemon'
    && orderResult.checked.join(',') === 'docker-daemon', JSON.stringify(orderResult));
  check('C3 [guard] ... and no auth probe of any kind ran before it',
    dockerCalled === true && authCalled === false);

  // The new specification check belongs to supervisor admission, not the generic
  // preparation-only prerequisite roster. A pure Claude author/probe preparation must not
  // suddenly require Codex to be installed or logged in.
  let unrelatedCodexProbe = false;
  const claudeOnlyResult = prerequisites.checkPrerequisites(orderCfg, tmp, {
    dockerAvailable: () => ({ status: 0 }),
    imageExists: () => ({ status: 0 }),
    resolveHostShell: () => ({ ok: true }),
    loadToken: () => 'claude-token-fixture',
    loadProviderCredential: () => null,
    codexAuthStatus: () => { unrelatedCodexProbe = true; return { status: 1 }; },
  });
  check('C5 [guard] a preparation-only all-Claude prerequisite pass stays green without Codex auth',
    claudeOnlyResult.ok === true && unrelatedCodexProbe === false, JSON.stringify(claudeOnlyResult));
}

body()
  .catch((e) => {
    failed = 1;
    console.log(`FAIL - HARNESS BROKEN: unexpected exception: ${e && e.stack ? e.stack : e}`);
  })
  .then(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* disposable */ }
    process.exit(failed);
  });
