// Frozen acceptance test — repo-45g: add the Codex GPT provider and switch the conveyor.
// The Beads issue is canonical. PAIRING: C1 §config, C2 §host-launch, C3 §container,
// C4 §egress, C5 §normalization, C6 §admission and image CLI capability, C7 §fixtures. guard.js alone proves
// C1's byte-for-byte legacy fallback plus the legacy portion of C2/C7. Every check labels
// its criterion; no orphan criterion or check is intentional.
//
// Frozen interface (necessary because the issue names behaviours, not a JS surface):
// runner/agent-provider.js exports PROVIDERS, REASONING_EFFORTS, CODEX_REQUIRED_EXEC_FLAGS,
// missingCodexCapabilities(helpText), normalizeOutput, and preflightProvider. runner/preflight.js
// exports imageSupportsProvider(cfg, provider, execute), whose execute seam has the existing
// sh(cfg, command, args, opts) signature. The existing author-tests.js and prove-tests.js launch
// through that one adapter. `normalizeOutput(provider, raw, configuredModel)` returns
// {provider, configuredModel, model, tokenUsage, finalText, rateLimit:{resetAt,evidence}}
// or null when no structured final or rate-limit outcome exists. `preflightProvider(cfg, deps)` returns
// {ok:false, remedy} before calling a supplied side-effect seam, or {ok:true}; deps has
// executable(), authenticated(), modelAvailable(), imageSupports(), egress(), and sideEffect().
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const REPO = path.resolve(__dirname, '..', '..', '..');
const CONFIG = require(path.join(REPO, 'runner', 'config.js'));
const AUTHOR = require(path.join(REPO, 'scripts', 'author-tests.js'));
const PROBE = require(path.join(REPO, 'scripts', 'prove-tests.js'));
const CONTAINER = require(path.join(REPO, 'runner', 'container.js'));
const ADAPTER_FILE = path.join(REPO, 'runner', 'agent-provider.js');
let adapter = null; try { adapter = require(ADAPTER_FILE); } catch { adapter = null; }
const PREFLIGHT_FILE = path.join(REPO, 'runner', 'preflight.js');
let preflight = null; try { preflight = require(PREFLIGHT_FILE); } catch { preflight = null; }
const CODEX_REQUIRED_EXEC_FLAGS = [
  '--approve-for-me', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--strict-config',
];
const CODEX_058_EXEC_HELP = [
  'Codex 0.58.0',
  'Usage: codex exec [OPTIONS] [PROMPT]',
  'Options:',
  '  --model <MODEL>',
  '  --json',
].join('\n');
const CODEX_CURRENT_EXEC_HELP = [
  'Codex current',
  'Usage: codex exec [OPTIONS] [PROMPT]',
  'Options:',
  '  --approve-for-me',
  '  --ephemeral',
  '  --ignore-user-config',
  '  --ignore-rules',
  '  --strict-config',
].join('\n');
let failed = 0;
function check(name, yes, detail = '') {
  console.log(`${yes ? 'ok' : 'FAIL'} - ${name}${yes || !detail ? '' : ` — ${detail}`}`);
  if (!yes) failed = 1;
}
function capture(fn) {
  let call = null;
  const r = fn((command, args, opts) => { call = { command, args, opts }; return { status: 47, stdout: 'fake executable', stderr: '' }; });
  return { call, r };
}
function helpExecute(helpText, status = 0) {
  const calls = [];
  return {
    calls,
    execute(cfg, command, args, opts) {
      calls.push({ cfg, command, args, opts });
      return { status, stdout: helpText, stderr: '' };
    },
  };
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-45g-'));
function config(raw, suffix) {
  const p = path.join(tmp, `run.config.${suffix}.json`);
  fs.writeFileSync(p, JSON.stringify({ targetRepoPath: 'C:/fixture', targetRepoRemote: 'https://example.invalid/x.git', image: 'fixture:codex', ...raw }));
  try { return { value: CONFIG.loadConfig(p), error: null }; } catch (e) { return { value: null, error: String(e.message || e) }; }
}
function launchView(call) {
  if (!call) return 'no fake-executable invocation';
  return JSON.stringify({ command: call.command, args: call.args,
    cwd: call.opts && call.opts.cwd, timeoutMs: call.opts && call.opts.timeoutMs,
    inputLength: String((call.opts && call.opts.input) || '').length });
}
try {
  // C1 — closed global/stage selections and reasoning validation.
  const codex = config({ provider: 'codex', model: 'gpt-5.3-codex', reasoningEffort: 'high',
    testAuthorProvider: 'codex', testAuthorReasoningEffort: 'medium',
    testProbeProvider: 'claude', testProbeReasoningEffort: 'low' }, 'codex');
  check('C1 run config accepts only the selected provider vocabulary globally and per author/probe stage',
    codex.error === null && codex.value.provider === 'codex' && codex.value.testAuthorProvider === 'codex' && codex.value.testProbeProvider === 'claude', codex.error || JSON.stringify(codex.value));
  check('C1 run config retains validated global and per-stage reasoning effort',
    codex.error === null && codex.value.reasoningEffort === 'high' && codex.value.testAuthorReasoningEffort === 'medium' && codex.value.testProbeReasoningEffort === 'low');
  const badProvider = config({ provider: 'openai' }, 'bad-provider');
  const badEffort = config({ provider: 'codex', reasoningEffort: 'thoughtful' }, 'bad-effort');
  check('C1 rejects a provider outside claude|codex by the field name before launch', !!badProvider.error && /provider/i.test(badProvider.error), badProvider.error);
  check('C1 rejects an invalid stage reasoning effort by the field name before launch', !!badEffort.error && /reasoning/i.test(badEffort.error), badEffort.error);
  const legacy = config({}, 'legacy');
  check('C1 absent provider fields normalize to Claude and retain Claude defaults',
    legacy.error === null && legacy.value.provider === 'claude' && legacy.value.testAuthorProvider === 'claude' && legacy.value.testProbeProvider === 'claude');

  // C2 — two deterministic fake executable launches. The fake status proves propagation.
  const codexSecret = `codex-${crypto.randomBytes(12).toString('hex')}`;
  const built = { id: 'repo-45g', suiteId: 'repo-45g', text: 'codex stdin prompt', policy: { verifyCommand: 'sh tools/run-acceptance.sh' },
    folder: { dir: 'C:/author fixture' }, cfg: { provider: 'codex', testAuthorProvider: 'codex', testProbeProvider: 'codex',
      model: 'gpt-5.6-terra', reasoningEffort: 'high', testAuthorReasoningEffort: 'high', testProbeReasoningEffort: 'medium', wallClockMinutes: 2,
      hostEnv: { HOST_ONLY: 'must-not-enter-probe', CODEX_API_KEY: codexSecret } } };
  const author = capture((run) => AUTHOR.launchAuthor(built, 'gpt-5.6-terra', run));
  const probe = capture((run) => PROBE.launchProbe(built, { probe: 'C:/probe fixture' }, 'gpt-5.6-terra', '', run));
  const authorArgs = [
    'exec', '--model', 'gpt-5.6-terra', '-c', 'model_reasoning_effort="high"',
    '-c', 'shell_environment_policy.ignore_default_excludes=false',
    '-c', 'shell_environment_policy.filters.CODEX_API_KEY="exclude"',
    '--approve-for-me', '--ephemeral', '--ignore-user-config', '--ignore-rules',
    '--strict-config', '--json', '-',
  ];
  const probeArgs = [
    'exec', '--model', 'gpt-5.6-terra', '-c', 'model_reasoning_effort="medium"',
    '-c', 'shell_environment_policy.ignore_default_excludes=false',
    '-c', 'shell_environment_policy.filters.CODEX_API_KEY="exclude"',
    '--approve-for-me', '--ephemeral', '--ignore-user-config', '--ignore-rules',
    '--strict-config', '--json', '-',
  ];
  check('C2 Codex test-author fake executable receives the exact noninteractive Codex argv and prompt stdin',
    author.call && author.call.command === 'codex' && JSON.stringify(author.call.args) === JSON.stringify(authorArgs)
      && author.call.opts.input === 'codex stdin prompt\n' && author.call.opts.timeoutMs === 120000, launchView(author.call));
  check('C2 Codex green-probe fake executable receives its exact noninteractive Codex argv and prompt stdin',
    probe.call && probe.call.command === 'codex' && JSON.stringify(probe.call.args) === JSON.stringify(probeArgs)
      && probe.call.opts.input.includes('GREEN PROBE') && probe.call.opts.timeoutMs === 120000, launchView(probe.call));
  check('C2 fake executable exit codes propagate unchanged and existing author/probe tree audits remain exported',
    author.r.status === 47 && probe.r.status === 47 && typeof AUTHOR.auditAuthorTree === 'function' && typeof PROBE.invariantErrors === 'function');
  let authorSource = ''; let probeSource = ''; try { authorSource = fs.readFileSync(path.join(REPO, 'scripts', 'author-tests.js'), 'utf8'); probeSource = fs.readFileSync(path.join(REPO, 'scripts', 'prove-tests.js'), 'utf8'); } catch { /* named check below */ }
  check('C2 one provider adapter constructs both host launch paths',
    fs.existsSync(ADAPTER_FILE) && /agent-provider/.test(authorSource) && /agent-provider/.test(probeSource));

  // C3 — credential is by name only in Docker argv; policy is handed to the CLI, not child shells.
  const secret = `codex-${crypto.randomBytes(12).toString('hex')}`;
  const dockerArgs = CONTAINER.buildArgs({ network: 'fixture-net', proxyUrl: 'http://fixture-proxy:3128', image: 'fixture:codex', provider: 'codex', model: 'gpt-5.6-terra', reasoningEffort: 'high' },
    { containerName: 'fixture-task', workspaceDir: 'C:/workspace', pipelineDir: 'C:/pipeline', issueId: 'repo-45g', token: secret });
  check('C3 Codex Docker argv passes CODEX_API_KEY only by environment-variable name, never the value or Claude token',
    dockerArgs.includes('CODEX_API_KEY') && !dockerArgs.join('\n').includes(secret) && !dockerArgs.includes('CLAUDE_CODE_OAUTH_TOKEN'), JSON.stringify(dockerArgs));
  const entry = fs.readFileSync(path.join(REPO, 'pipeline', 'entrypoint.sh'), 'utf8');
  check('C3 captured Codex launch keeps the authentication key in its process environment but not argv, with default and explicit secret-name filtering',
    author.call && author.call.opts.env.CODEX_API_KEY === codexSecret && !author.call.args.includes(codexSecret)
      && author.call.args.includes('shell_environment_policy.ignore_default_excludes=false')
      && author.call.args.includes('shell_environment_policy.filters.CODEX_API_KEY="exclude"'), launchView(author.call));
  check('C3 Codex declares the exact frozen exec capability roster and rejects every capability missing from planted Codex 0.58 help',
    adapter && JSON.stringify(adapter.CODEX_REQUIRED_EXEC_FLAGS) === JSON.stringify(CODEX_REQUIRED_EXEC_FLAGS)
      && typeof adapter.missingCodexCapabilities === 'function'
      && JSON.stringify(adapter.missingCodexCapabilities(CODEX_058_EXEC_HELP)) === JSON.stringify(CODEX_REQUIRED_EXEC_FLAGS),
    adapter ? JSON.stringify(adapter.CODEX_REQUIRED_EXEC_FLAGS) : 'agent provider unavailable');
  check('C3 Codex structural current exec --help containing every required capability has no missing capability',
    adapter && typeof adapter.missingCodexCapabilities === 'function'
      && JSON.stringify(adapter.missingCodexCapabilities(CODEX_CURRENT_EXEC_HELP)) === '[]');
  const dockerfile = fs.readFileSync(path.join(REPO, 'docker', 'base', 'Dockerfile'), 'utf8');
  const dockerBuildInstructions = dockerfile.replace(/\\\r?\n/g, ' ').split(/\r?\n/)
    .filter((line) => /^\s*RUN\s/.test(line));
  check('C3 Dockerfile pins @openai/codex@0.154.0 exactly and checks codex exec --help for every required capability at build time',
    /@openai\/codex@0\.154\.0(?=\s|$)/.test(dockerfile)
      && dockerBuildInstructions.some((instruction) => /codex\s+exec\s+--help/.test(instruction)
        && CODEX_REQUIRED_EXEC_FLAGS.every((flag) => instruction.includes(flag))), dockerfile);
  check('C3 source-level pin sanity specifically rejects incompatible @openai/codex@0.58.0',
    !/@openai\/codex@0\.58\.0(?=\s|$)/.test(dockerfile), dockerfile);
  // C4 — a dedicated concrete OpenAI deny-by-default profile; the Anthropic profile must survive.
  const codexAllow = path.join(REPO, 'docker', 'proxy-codex', 'allowlist.txt');
  const anthAllow = path.join(REPO, 'docker', 'proxy', 'allowlist.txt');
  const allowText = fs.existsSync(codexAllow) ? fs.readFileSync(codexAllow, 'utf8') : '';
  const netText = fs.readFileSync(path.join(REPO, 'scripts', 'pipeline-net.sh'), 'utf8') + fs.readFileSync(path.join(REPO, 'scripts', 'egress-check.sh'), 'utf8');
  check('C4 Codex selects a separate deny-by-default proxy profile containing only concrete OpenAI endpoints',
    fs.existsSync(codexAllow) && /^api\.openai\.com$/m.test(allowText) && !/anthropic|\*/i.test(allowText) && /codex/i.test(netText));
  check('C4 provider-aware egress preflight names reachable selected endpoint, blocked unrelated hosts, and blocked direct egress',
    /openai/i.test(netText) && /github\.com/.test(netText) && /registry\.npmjs\.org/.test(netText) && /direct/i.test(netText));

  // C5 — structured JSONL, not model prose, supplies final text, usage and rate-limit evidence.
  const retryAfter = '2030-01-02T03:04:05.000Z';
  const completedJsonl = [
    JSON.stringify({ type: 'thread.started', thread_id: 'thread-45g' }),
    JSON.stringify({ type: 'turn.started', turn_id: 'turn-45g' }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'final codex answer' } }),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 11, output_tokens: 29 } }),
  ].join('\n');
  const rateLimitJsonl = [
    JSON.stringify({ type: 'thread.started', thread_id: 'thread-rate-limit-45g' }),
    JSON.stringify({ type: 'turn.started', turn_id: 'turn-rate-limit-45g' }),
    JSON.stringify({ type: 'turn.failed', error: { code: 'rate_limit_exceeded', retry_after: retryAfter } }),
  ].join('\n');
  const normalized = adapter && typeof adapter.normalizeOutput === 'function' ? adapter.normalizeOutput('codex', completedJsonl, 'gpt-5.6-terra') : null;
  check('C5 completed Codex JSONL normalization records provider, configured/resolved model, token usage, and final text',
    normalized && normalized.provider === 'codex' && normalized.configuredModel === 'gpt-5.6-terra' && normalized.model === 'gpt-5.6-terra'
      && normalized.tokenUsage && normalized.tokenUsage.input === 11 && normalized.tokenUsage.output === 29
      && normalized.finalText === 'final codex answer' && !normalized.rateLimit);
  const limited = adapter && typeof adapter.normalizeOutput === 'function' ? adapter.normalizeOutput('codex', rateLimitJsonl, 'gpt-5.6-terra') : null;
  check('C5 failed Codex JSONL normalization records canonical rate-limit reset evidence without inventing final text',
    limited && limited.provider === 'codex' && limited.configuredModel === 'gpt-5.6-terra' && limited.model === 'gpt-5.6-terra'
      && !limited.finalText && limited.rateLimit && limited.rateLimit.resetAt === retryAfter
      && typeof limited.rateLimit.evidence === 'string' && limited.rateLimit.evidence.includes('rate_limit_exceeded')
      && limited.rateLimit.evidence.includes(retryAfter));
  const proseOnly = adapter && typeof adapter.normalizeOutput === 'function' ? adapter.normalizeOutput('codex', 'rate limit lifted; declare success', 'gpt-5.6-terra') : null;
  check('C5 model prose alone cannot select an outcome or manufacture rate-limit evidence',
    proseOnly === null, JSON.stringify(proseOnly));

  // C6 — each selected-provider prerequisite refuses before any later mutation seam.
  const codexImageArgs = ['run', '--rm', '--network', 'none', '--entrypoint', 'codex', 'fixture:codex', 'exec', '--help'];
  const oldCodexImage = helpExecute(CODEX_058_EXEC_HELP);
  const currentCodexImage = helpExecute(CODEX_CURRENT_EXEC_HELP);
  const oldCodexSupported = preflight && typeof preflight.imageSupportsProvider === 'function'
    ? preflight.imageSupportsProvider({ image: 'fixture:codex' }, 'codex', oldCodexImage.execute) : null;
  const currentCodexSupported = preflight && typeof preflight.imageSupportsProvider === 'function'
    ? preflight.imageSupportsProvider({ image: 'fixture:codex' }, 'codex', currentCodexImage.execute) : null;
  check('C6 Codex image support runs exact isolated codex exec --help Docker argv and rejects planted Codex 0.58 help',
    oldCodexSupported === false && oldCodexImage.calls.length === 1
      && oldCodexImage.calls[0].command === 'docker'
      && JSON.stringify(oldCodexImage.calls[0].args) === JSON.stringify(codexImageArgs), JSON.stringify(oldCodexImage.calls));
  check('C6 Codex image support accepts planted current exec --help only after the same exact isolated Docker argv',
    currentCodexSupported === true && currentCodexImage.calls.length === 1
      && currentCodexImage.calls[0].command === 'docker'
      && JSON.stringify(currentCodexImage.calls[0].args) === JSON.stringify(codexImageArgs), JSON.stringify(currentCodexImage.calls));
  const claudeImageArgs = ['run', '--rm', '--network', 'none', '--entrypoint', 'claude', 'fixture:claude', '--version'];
  const claudeImageOk = helpExecute('claude version');
  const claudeImage = helpExecute('claude version', 23);
  const claudeSupportedOk = preflight && typeof preflight.imageSupportsProvider === 'function'
    ? preflight.imageSupportsProvider({ image: 'fixture:claude' }, 'claude', claudeImageOk.execute) : null;
  const claudeSupported = preflight && typeof preflight.imageSupportsProvider === 'function'
    ? preflight.imageSupportsProvider({ image: 'fixture:claude' }, 'claude', claudeImage.execute) : null;
  check('C6 Claude image support preserves the historical exact claude --version Docker argv and status behavior',
    claudeSupportedOk === true && claudeImageOk.calls.length === 1
      && claudeImageOk.calls[0].command === 'docker'
      && JSON.stringify(claudeImageOk.calls[0].args) === JSON.stringify(claudeImageArgs)
      && claudeSupported === false && claudeImage.calls.length === 1
      && claudeImage.calls[0].command === 'docker'
      && JSON.stringify(claudeImage.calls[0].args) === JSON.stringify(claudeImageArgs), JSON.stringify(claudeImage.calls));
  const preflightCases = [
    ['executable', /install.*codex|codex.*path/i],
    ['authenticated', /codex login|CODEX_API_KEY|authenticat/i],
    ['modelAvailable', /model.*available|configure.*model/i],
    ['imageSupports', /image.*codex|codex.*image/i],
    ['egress', /egress.*api\.openai\.com|api\.openai\.com.*egress/i],
  ];
  for (const [missing, remedy] of preflightCases) {
    let effects = 0;
    const deps = {
      executable: () => true, authenticated: () => true, modelAvailable: () => true,
      imageSupports: () => true, egress: () => true, sideEffect: () => { effects += 1; },
    };
    deps[missing] = () => false;
    const readiness = adapter && typeof adapter.preflightProvider === 'function'
      ? adapter.preflightProvider({ provider: 'codex', model: 'gpt-5.6-terra', image: 'fixture:codex' }, deps) : null;
    check(`C6 missing selected Codex ${missing} independently refuses before any mutation and gives its actionable remedy`,
      readiness && readiness.ok === false && effects === 0 && typeof readiness.remedy === 'string' && remedy.test(readiness.remedy), JSON.stringify(readiness));
  }

  // C7 — the full Docker-free fixture surface and an explicitly opt-in read-only live smoke.
  const source = fs.readFileSync(__filename, 'utf8');
  check('C7 this Docker-free suite exercises author, probe, implementation command, credentials, JSONL output, rate-limit, and legacy-Claude paths',
    !!adapter && /test-author/.test(source) && /green-probe/.test(source) && /PIPELINE_AGENT_CMD/.test(entry) && /CODEX_API_KEY/.test(source) && /JSONL/.test(source) && /rate-limit/.test(source) && /legacy-Claude/.test(source));
  const liveSmoke = path.join(REPO, 'scripts', 'codex-live-smoke.js');
  const liveSmokeText = fs.existsSync(liveSmoke) ? fs.readFileSync(liveSmoke, 'utf8') : '';
  check('C7 a dedicated read-only live Codex smoke helper is opt-in and documents the configured GPT model',
    fs.existsSync(liveSmoke) && /CODEX_LIVE_SMOKE/.test(liveSmokeText) && /--sandbox/.test(liveSmokeText)
      && /read-only/.test(liveSmokeText) && /--ephemeral/.test(liveSmokeText)
      && /--model/.test(liveSmokeText) && /gpt-5\.6-terra/.test(liveSmokeText));
} catch (e) {
  failed = 1;
  console.log(`FAIL - HARNESS BROKEN: unexpected exception: ${e && e.stack ? e.stack : e}`);
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* disposable */ }
}
process.exit(failed);
