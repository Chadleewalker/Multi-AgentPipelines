// Frozen acceptance test — repo-djf.41: decouple the specification planner lane from the
// implementation, test-author and test-probe models. This is the RED half; `guard.js` beside
// it carries the existing behaviour (C4's no-fallback baseline, C5's legacy routing) that must
// stay green while this file's checks turn green for the first time.
//
// WHICH CRITERION EACH SECTION PROVES (every check below names its own in its label):
//
//   C1  config AND status expose a bounded, explicit specification planner model,
//       independent of the implementation/test-author/test-probe models — a Claude
//       implementation run cannot pass a Claude model alias to Codex specification.
//   C2  mixed routing: Codex specification through saved ChatGPT auth with NO OpenAI API
//       key, Claude Opus Docker implementation, Claude Sonnet author/probe routing.
//   C3  prerequisite admission checks every actually-selected model lane — including Codex
//       saved-login readiness for specification — before Docker, locks or worktrees matter.
//   C4  (red half) the new specification-auth admission accepts no fallback credential.
//   C5  existing all-Codex/all-Claude configurations are unaffected (see guard.js), and this
//       file supplies the five named deterministic tests: config rejection, status truth,
//       argv/model selection, no-key auth, and early refusal.
//
// ───────────────────────────────────────────────────────────────────────────────────────────
// THE FROZEN INTERFACE this suite fixes, since the issue names no module or field grammar:
//
//   runner/config.js
//     - a new `specificationModel` run-config field, validated by the SAME model-alias rule
//       as `model` / `testAuthorModel` / `testProbeModel` (bounded, closed character set).
//     - a new export `DEFAULT_SPECIFICATION_MODEL`, the Codex-appropriate default used when
//       the field is absent — NEVER derived from `cfg.model`.
//     - `cfg.specificationModel` resolves to `raw.specificationModel || DEFAULT_SPECIFICATION_MODEL`,
//       independent of `cfg.model` in every case, explicit or defaulted.
//
//   scripts/specify-proposal.js
//     - `productionAdapters(...).planningModel` is sourced from `cfg.specificationModel`,
//       never from `cfg.model`.
//
//   scripts/proposal-supervisor.js
//     - every command that can launch specification (`start`, `run`, `resume`, `tick`) performs
//       a bounded saved-ChatGPT readiness check before opening supervisor ownership or durable
//       state. This is supervisor-specific: preparation-only Claude workflows do not acquire a
//       Codex dependency merely because the same config can also drive the conveyor.
//     - the check invokes `codex login status` with CODEX_API_KEY and OPENAI_API_KEY absent;
//       neither key nor a Claude credential is a fallback for the saved-login requirement.
//
//   runner/proposal-supervisor.js
//     - `productionAdapters(repoRoot, options).specification` gains a `model` property: the
//       resolved `cfg.specificationModel` for `options.configPath`.
//     - `status()` (both the top-level result and each per-proposal row) gains a
//       `specificationModel` field sourced from `adapters.specification.model`.
//     - `formatHumanStatus` includes `specificationModel=<value>` per row.
//
// SPEC DEFECT, REPORTED NOT PAPERED OVER. C1 says "status" must expose the specification
// model. This project has exactly one frozen file named `status.schema.json`
// (`schemas/status.schema.json`, listed in `pipeline.config.json`'s `frozenPaths`) — the
// per-TASK `/workspace/.run/status.json` written by the container entrypoint, which has
// nothing to do with the planner lane and which no acceptance suite may touch or depend on
// without ending the attempt as tampered. The only other "status" surface in this codebase is
// the operator-facing `proposal-supervisor.js status` command this suite pins above. The
// issue does not say which one it means; a suite naming the frozen schema would refuse the
// freeze outright by construction, so this is the only interpretation an implementation can
// satisfy at all, and this suite tests that one.
//
// SELF-CONTAINED ON PURPOSE: Node built-ins only. No Docker, no real Codex/Claude CLI, no
// network. Every `codex`/`git` invocation below is a synchronous in-process fake.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const REPO = path.resolve(__dirname, '..', '..', '..');
const CONFIG = path.join(REPO, 'runner', 'config.js');
const AGENT_PROVIDER = path.join(REPO, 'runner', 'agent-provider.js');
const CONTAINER = path.join(REPO, 'runner', 'container.js');
const SPECIFY_PROPOSAL = path.join(REPO, 'scripts', 'specify-proposal.js');
const PROPOSAL_SUPERVISOR = path.join(REPO, 'runner', 'proposal-supervisor.js');
const PROPOSAL_SUPERVISOR_CLI = path.join(REPO, 'scripts', 'proposal-supervisor.js');

let failed = 0;
function check(name, cond, detail) {
  console.log(`${cond ? 'ok' : 'FAIL'} - ${name}${!cond && detail ? ` — ${detail}` : ''}`);
  if (!cond) failed = 1;
}
const sha256 = (v) => `sha256:${crypto.createHash('sha256').update(v).digest('hex')}`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'test-djf41-'));
function scratch(name) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function body() {
  const config = require(CONFIG);
  const AGENT = require(AGENT_PROVIDER);
  const container = require(CONTAINER);
  const specify = require(SPECIFY_PROPOSAL);
  const proposalSupervisor = require(PROPOSAL_SUPERVISOR);
  const proposalSupervisorCli = require(PROPOSAL_SUPERVISOR_CLI);

  // =========================================================================================
  // C1 + C5 (config rejection, argv/model selection) — runner/config.js
  // =========================================================================================
  function writeConfig(dir, body) {
    const file = path.join(dir, 'run.config.json');
    fs.writeFileSync(file, JSON.stringify(body));
    return file;
  }
  const baseFields = {
    targetRepoPath: path.join(tmp, 'nonexistent-target'),
    targetRepoRemote: 'https://example.invalid/repo.git',
    image: 'pipeline-image:test',
  };

  // ---- C1/C5 config rejection: specificationModel is bounded like its siblings -----------
  const badDir = scratch('config-bad');
  const badFile = writeConfig(badDir, { ...baseFields, specificationModel: 'not a safe alias!' });
  let badError = null;
  try { config.loadConfig(badFile); } catch (e) { badError = e; }
  check("C1/C5 config rejection: a malformed 'specificationModel' is refused by name",
    !!badError && /specificationModel/.test(badError.message), badError && badError.message);

  // ---- C1: specificationModel is independent of model/testAuthorModel/testProbeModel -----
  check("C1: runner/config.js exports a DEFAULT_SPECIFICATION_MODEL distinct from the implementation default",
    typeof config.DEFAULT_SPECIFICATION_MODEL === 'string' && config.DEFAULT_SPECIFICATION_MODEL.length > 0
    && config.DEFAULT_SPECIFICATION_MODEL !== config.DEFAULTS.model,
    JSON.stringify({ spec: config.DEFAULT_SPECIFICATION_MODEL, impl: config.DEFAULTS && config.DEFAULTS.model }));

  const defaultDir = scratch('config-default');
  const defaultFile = writeConfig(defaultDir, { ...baseFields }); // model, specificationModel both absent
  const defaultCfg = config.loadConfig(defaultFile);
  check('C1: with nothing configured, cfg.model still defaults to the historical Claude alias',
    defaultCfg.model === 'opus', defaultCfg.model);
  check('C1: ... and cfg.specificationModel defaults independently, to DEFAULT_SPECIFICATION_MODEL',
    typeof defaultCfg.specificationModel === 'string'
    && defaultCfg.specificationModel.length > 0
    && defaultCfg.specificationModel === config.DEFAULT_SPECIFICATION_MODEL
    && defaultCfg.specificationModel !== defaultCfg.model,
    JSON.stringify({ specificationModel: defaultCfg.specificationModel, model: defaultCfg.model }));

  const explicitDir = scratch('config-explicit');
  const explicitFile = writeConfig(explicitDir,
    { ...baseFields, model: 'sonnet', specificationModel: 'gpt-5.7-explicit-echo' });
  const explicitCfg = config.loadConfig(explicitFile);
  check('C1: an explicit specificationModel is taken verbatim and is untouched by a changed model',
    explicitCfg.specificationModel === 'gpt-5.7-explicit-echo' && explicitCfg.model === 'sonnet');

  // ---- C1/C5: specify-proposal sources its Codex model from specificationModel, not model -
  const noSpecCfg = {
    targetRepoPath: path.join(tmp, 'noSpecTarget'), codexAuth: 'chatgpt',
    model: 'claude-opus-4-1-20250805', // a real Claude implementation model alias
    // specificationModel deliberately absent
  };
  const noSpecAdapters = specify.productionAdapters({ configPath: 'unused' }, {
    loadConfig: () => noSpecCfg,
    kickoffApi: { statePathsFor: () => ({ state: scratch('nospec-state') }) },
  });
  check('C1: a Claude implementation run cannot pass its Claude model alias to Codex specification',
    noSpecAdapters.planningModel !== noSpecCfg.model
    && typeof noSpecAdapters.planningModel === 'string' && noSpecAdapters.planningModel.length > 0,
    `planningModel resolved to ${JSON.stringify(noSpecAdapters.planningModel)}, cfg.model was ${JSON.stringify(noSpecCfg.model)}`);

  const withSpecCfg = { ...noSpecCfg, specificationModel: 'gpt-5.6-terra' };
  const withSpecAdapters = specify.productionAdapters({ configPath: 'unused' }, {
    loadConfig: () => withSpecCfg,
    kickoffApi: { statePathsFor: () => ({ state: scratch('withspec-state') }) },
  });
  check('C5 argv/model selection: an explicit specificationModel is exactly what specify-proposal launches Codex with',
    withSpecAdapters.planningModel === 'gpt-5.6-terra');

  // =========================================================================================
  // C1 + C5 (status truth) — runner/proposal-supervisor.js
  // =========================================================================================
  const { createProductionSupervisor, formatHumanStatus, TESTING_SENTINEL } = proposalSupervisor;
  const statusProject = path.join(tmp, 'status-project');
  fs.mkdirSync(statusProject, { recursive: true });
  const fakeAdapters = {
    kickoff: {
      async verify(record) { return { id: record.id, hash: record.hash, target: record.target }; },
    },
    specification: {
      model: 'gpt-5.6-terra-status-probe',
      async execute() { return { status: 'needs-input', question: 'q', evidenceHash: sha256('q') }; },
      async answer() { return { status: 'answered' }; },
    },
    authority: { async grant() { return { ok: false, error: 'not exercised' }; } },
    operations: {},
    review: {},
  };
  const statusSupervisor = createProductionSupervisor({
    project: statusProject, adapters: fakeAdapters, testingSentinel: TESTING_SENTINEL,
    canonicalTarget: (p) => p, stateDir: scratch('status-state'),
  });
  const topStatus = await statusSupervisor.status();
  check('C1/C5 status truth: the top-level status object exposes specificationModel',
    topStatus.specificationModel === 'gpt-5.6-terra-status-probe', JSON.stringify(topStatus.specificationModel));

  const kpId = `kp-${'1'.repeat(16)}`;
  const submitted = await statusSupervisor.submit({
    id: kpId, hash: sha256('intent-text'), target: statusProject,
    intent: 'intent-text', createdAt: new Date().toISOString(),
  });
  check('C1/C5 status truth: fixture submission was accepted (test harness sanity)', submitted.accepted === true);
  const row = await statusSupervisor.status(kpId);
  check('C1/C5 status truth: a per-proposal status row exposes specificationModel too',
    row && row.specificationModel === 'gpt-5.6-terra-status-probe', JSON.stringify(row && row.specificationModel));
  const humanLine = formatHumanStatus(row);
  check('C5 status truth: the human-readable status line names the field and its value',
    /specificationModel=gpt-5\.6-terra-status-probe/.test(humanLine), humanLine);

  // =========================================================================================
  // C2 + C4 (no-key auth): mixed routing — Codex specification (chatgpt, no OpenAI key),
  // Claude Opus Docker implementation, Claude Sonnet author/probe.
  // =========================================================================================
  const mixedCfg = {
    provider: 'claude', model: 'claude-opus-4-1-20250805',
    testAuthorProvider: 'claude', testAuthorModel: 'claude-sonnet-4-5-20250929',
    testProbeProvider: 'claude', testProbeModel: 'claude-sonnet-4-5-20250929',
    specificationModel: 'gpt-5.6-terra', codexAuth: 'chatgpt',
    targetRepoPath: path.join(tmp, 'mixed-target'), image: 'pipeline-image:test',
    network: 'mixed-net', proxyUrl: 'http://mixed-proxy:3128', reasoningEffort: 'medium',
    wallClockMinutes: 10, gitTimeoutMs: 5000,
  };

  // ---- (a) specification: Codex via saved ChatGPT auth, with NO OpenAI API key anywhere ---
  const kickoffHash = sha256(JSON.stringify({
    version: 'kickoff-intake/1', title: 'mixed routing fixture', description: '', constraints: [],
    examples: [], nonGoals: [], priority: 1, relations: [], origin: null,
  }));
  const intentText = JSON.stringify({
    version: 'kickoff-intake/1', title: 'mixed routing fixture', description: '', constraints: [],
    examples: [], nonGoals: [], priority: 1, relations: [], origin: null,
  });
  const kickoffRecord = {
    version: 'kickoff-intake/1', id: 'kp-2222222222222222', target: mixedCfg.targetRepoPath,
    hash: sha256(intentText), intent: intentText, createdAt: new Date().toISOString(),
  };
  let capturedCodex = null;
  const mixedRun = (command, args, callOptions) => {
    if (command === 'git') {
      if (args[0] === 'rev-parse') return { status: 0, stdout: 'f'.repeat(40), stderr: '' };
      if (args[0] === 'ls-tree') return { status: 0, stdout: 'DESIGN.md\0', stderr: '' };
      if (args[0] === 'show') return { status: 0, stdout: '# Mixed routing\n', stderr: '' };
      return { status: 0, stdout: '', stderr: '' }; // worktree add/remove
    }
    if (command === 'codex') {
      capturedCodex = { args: [...args], env: { ...callOptions.env } };
      const proposal = {
        status: 'ready', spec: 'the resolved spec text', acceptanceCriteria: ['a criterion'],
        designReferences: ['DESIGN.md#mixed-routing'], difficulty: 'trivial',
      };
      return { status: 0, stdout: JSON.stringify(proposal), stderr: '' };
    }
    throw new Error(`unexpected command in mixed-routing fixture: ${command}`);
  };
  const mixedAdapters = specify.productionAdapters({ configPath: 'unused' }, {
    loadConfig: () => mixedCfg,
    kickoffApi: { statePathsFor: () => ({ state: scratch('mixed-state') }), readAll: () => [kickoffRecord] },
    resolveBranch: () => ({ ok: true, branch: 'main' }),
    bdJson: (cfg, args) => (args[0] === 'search' ? { ok: true, data: [] } : { ok: true, data: [{ id: 'bd-mixed-999' }] }),
    newCheckoutPath: () => path.join(scratch('mixed-checkout-parent'), 'checkout'),
    resolveDesignReference: () => ({ ok: true }),
    // Ambient env carries a leaked Codex/OpenAI key on purpose: the specification launch
    // must succeed and route through chatgpt WITHOUT ever handing either key to the child.
    env: { CODEX_API_KEY: 'ambient-leaked-codex-key', OPENAI_API_KEY: 'ambient-leaked-openai-key', PATH: 'irrelevant' },
    run: mixedRun,
  });
  const mixedResult = await specify.execute(
    { configPath: 'unused', proposalId: kickoffRecord.id }, {}, mixedAdapters);
  check('C2 mixed routing: the specification attempt reached Codex and produced a ready issue',
    mixedResult.status === 'ready' && mixedResult.issueId === 'bd-mixed-999', JSON.stringify(mixedResult));
  check('C2 mixed routing: Codex specification was launched with the SPECIFICATION model, not the Claude implementation alias',
    !!capturedCodex && capturedCodex.args.includes('--model')
    && capturedCodex.args[capturedCodex.args.indexOf('--model') + 1] === mixedCfg.specificationModel
    && capturedCodex.args[capturedCodex.args.indexOf('--model') + 1] !== mixedCfg.model,
    JSON.stringify(capturedCodex && capturedCodex.args));
  check('C2/C4 no-key auth: no OpenAI/Codex API key reached the Codex child process',
    !!capturedCodex
    && !Object.prototype.hasOwnProperty.call(capturedCodex.env, 'CODEX_API_KEY')
    && !Object.prototype.hasOwnProperty.call(capturedCodex.env, 'OPENAI_API_KEY'),
    JSON.stringify(capturedCodex && Object.keys(capturedCodex.env)));

  // ---- (b) implementation: Claude Opus, Docker ---------------------------------------------
  const implArgs = container.buildArgs(mixedCfg,
    { containerName: 'mixed-c', workspaceDir: '/workspace', pipelineDir: '/pipeline', issueId: 'mixed-i', token: 'claude-oauth-fixture' });
  check('C2 mixed routing: the Docker implementation launch carries the Claude Opus model',
    implArgs.includes('PIPELINE_MODEL=claude-opus-4-1-20250805'));
  check('C2 mixed routing: ... and requests the Claude credential by name, never the Codex one',
    implArgs.includes('CLAUDE_CODE_OAUTH_TOKEN') && !implArgs.includes('CODEX_API_KEY'));

  // ---- (c) test-author/test-probe: Claude Sonnet routing ------------------------------------
  const authorProvider = AGENT.providerFor(mixedCfg, 'test-author');
  const probeProvider = AGENT.providerFor(mixedCfg, 'test-probe');
  const authorModel = String(mixedCfg.testAuthorModel || mixedCfg.model || '').trim();
  const probeModel = String(mixedCfg.testProbeModel || mixedCfg.testAuthorModel || mixedCfg.model || '').trim();
  check('C2 mixed routing: test-author and test-probe both resolve to claude',
    authorProvider === 'claude' && probeProvider === 'claude');
  check('C2 mixed routing: test-author and test-probe both resolve to the Sonnet alias, not Opus',
    authorModel === 'claude-sonnet-4-5-20250929' && probeModel === 'claude-sonnet-4-5-20250929');
  const authorLaunch = AGENT.buildLaunch({ provider: authorProvider, claudeArgs: ['--model', authorModel] });
  check('C2 mixed routing: the author launch is the claude executable with the sonnet alias',
    authorLaunch.command === 'claude' && authorLaunch.args.includes(authorModel));

  // =========================================================================================
  // C3 (+ C4 no-fallback): the real supervisor CLI checks its implicit Codex lane before
  // ownership or durable state, without imposing that lane on unrelated preparation commands.
  // =========================================================================================
  // First prove the exact command and no-key environment through the controller's process seam.
  let capturedAuth = null;
  let directAuthError = null;
  if (typeof proposalSupervisorCli.checkSpecificationAuth === 'function') {
    try {
      proposalSupervisorCli.checkSpecificationAuth(
        { lifecycleTimeoutMs: 5000 },
        {
          env: {
            CODEX_API_KEY: 'must-not-reach-saved-login-probe',
            OPENAI_API_KEY: 'must-not-reach-saved-login-probe',
            CLAUDE_CODE_OAUTH_TOKEN: 'unrelated-claude-subscription-fixture',
            PIPELINE_UNRELATED: 'survives',
          },
          spawnSync(command, args, options) {
            capturedAuth = { command, args: [...args], options };
            return { status: 1, stdout: '', stderr: 'not logged in' };
          },
        });
    } catch (error) { directAuthError = error; }
  }
  check('C3: the specification-auth controller obeys the bounded Codex saved-login command contract',
    capturedAuth && capturedAuth.command === 'codex'
    && capturedAuth.args.join('\0') === 'login\0status'
    && capturedAuth.options.timeout === 5000 && capturedAuth.options.shell === false,
    JSON.stringify(capturedAuth));
  check('C4 no-key auth: API-key variables are stripped from the saved-login probe, never accepted as fallback',
    capturedAuth
    && !Object.prototype.hasOwnProperty.call(capturedAuth.options.env, 'CODEX_API_KEY')
    && !Object.prototype.hasOwnProperty.call(capturedAuth.options.env, 'OPENAI_API_KEY')
    && capturedAuth.options.env.PIPELINE_UNRELATED === 'survives'
    && capturedAuth.options.env.CLAUDE_CODE_OAUTH_TOKEN === 'unrelated-claude-subscription-fixture'
    && directAuthError && /saved|ChatGPT|login/i.test(directAuthError.message),
    JSON.stringify({ capturedAuth, directAuthError: directAuthError && directAuthError.message }));

  // Then exercise the production CLI entry function in-process. Its ordinary executable path
  // calls this same function with default dependencies; injected seams make the ordering
  // observable without spawning a real Codex, taking a lock, or writing a journal.
  const cliTrace = [];
  const cliCfg = {
    targetRepoPath: path.join(tmp, 'cli-target'), specificationModel: 'gpt-5.6-terra',
    supervisorGlobalConcurrency: 3,
    supervisorStageConcurrency: { specification: 3, preparation: 2, review: 2 },
  };
  let cliError = null;
  try {
    await proposalSupervisorCli.main(
      ['tick', '--config', path.join(tmp, 'unused-config.json'), '--json'],
      { out() {}, err() {} },
      {
        loadConfig() { cliTrace.push('config'); return cliCfg; },
        checkSpecificationAuth(seen) {
          cliTrace.push(`spec-auth:${seen.specificationModel}`);
          throw new Error('saved ChatGPT specification auth unavailable');
        },
        openProjectSupervisor() {
          cliTrace.push('ownership-opened');
          throw new Error('ownership must not be reached');
        },
      });
  } catch (error) { cliError = error; }
  check('C3/C5 early refusal: the production supervisor entry checks saved ChatGPT specification auth after config and before ownership',
    cliTrace.join('\0') === 'config\0spec-auth:gpt-5.6-terra'
    && cliError && /saved ChatGPT specification auth unavailable/.test(cliError.message),
    JSON.stringify({ cliTrace, cliError: cliError && cliError.message }));
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
