// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// The one provider adapter — DESIGN.md §4.3, §4.7, §6.8.
//
// Every host-side agent launch in this repository is constructed here, for exactly two
// providers: the historical Claude CLI and the Codex CLI's `codex exec` noninteractive
// contract. Two rules make that worth a module rather than a branch at each call site:
//
//   * an absent selection has to reproduce the Claude launch BYTE FOR BYTE, so the Claude
//     argv is passed in by its owner (author-tests / prove-tests) and returned untouched;
//   * nothing about an outcome may be decided by model prose. `normalizeOutput` reads the
//     structured Codex JSONL stream and the structured Claude envelope, and answers null
//     when neither carries a final result or a canonical rate-limit record.
//
// Plain JS, Node built-ins only, and deliberately free of `require('./config')` so the
// config loader can validate the provider vocabulary this file owns.
'use strict';

// Closed vocabularies. Anything outside them is refused by name in runner/config.js
// before a worktree, a Beads read, a container or an agent attempt exists.
const PROVIDERS = ['claude', 'codex'];
const REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high'];
const DEFAULT_PROVIDER = 'claude';
const DEFAULT_REASONING_EFFORT = 'medium';

// One credential per provider, and never both in one process. The names are the contract
// between runner/config.js (which selects a value), runner/container.js (which passes the
// NAME to `docker run`) and pipeline/entrypoint.sh (which hands it to the CLI alone).
const CREDENTIAL_NAMES = { claude: 'CLAUDE_CODE_OAUTH_TOKEN', codex: 'CODEX_API_KEY' };

// The `codex exec` capabilities this pipeline depends on. Order is the roster's order and
// is load-bearing twice: it is the argv order below, and `missingCodexCapabilities`
// reports in it. An older CLI that silently lacks one of these would run the agent with a
// different approval, state or configuration posture than the design assumes.
//   --approve-for-me     workspace-write autonomy: edits inside the workspace, no prompts
//   --ephemeral          no session/rollout state persisted outside the invocation
//   --ignore-user-config the host user's ~/.codex config cannot alter a pipeline run
//   --ignore-rules       project rules files cannot alter it either
//   --strict-config      an unknown -c key is an error, never a silently ignored setting
const CODEX_REQUIRED_EXEC_FLAGS = [
  '--approve-for-me', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--strict-config',
];

// Codex's shell-environment policy governs what the MODEL's own child commands inherit.
// The CLI process itself needs the API key; nothing it spawns does. `ignore_default_excludes
// = false` keeps Codex's own default secret-name exclusions in force, and the explicit
// filter adds this pipeline's key to them — belt and braces, because the default list is
// the CLI's business and may change under us.
const CODEX_ENV_POLICY_ARGS = [
  '-c', 'shell_environment_policy.ignore_default_excludes=false',
  '-c', `shell_environment_policy.filters.${CREDENTIAL_NAMES.codex}="exclude"`,
];

const STAGE_PROVIDER_KEYS = {
  'test-author': 'testAuthorProvider',
  'test-probe': 'testProbeProvider',
};
const STAGE_EFFORT_KEYS = {
  'test-author': 'testAuthorReasoningEffort',
  'test-probe': 'testProbeReasoningEffort',
};

function normalizeProvider(value) {
  const v = String(value == null ? '' : value).trim().toLowerCase();
  return PROVIDERS.includes(v) ? v : DEFAULT_PROVIDER;
}

function normalizeReasoningEffort(value) {
  const v = String(value == null ? '' : value).trim().toLowerCase();
  return REASONING_EFFORTS.includes(v) ? v : DEFAULT_REASONING_EFFORT;
}

function validProvider(value) {
  return typeof value === 'string' && PROVIDERS.includes(value.trim().toLowerCase());
}

function validReasoningEffort(value) {
  return typeof value === 'string' && REASONING_EFFORTS.includes(value.trim().toLowerCase());
}

// Stage -> run-wide -> constant. There is no single default value for a stage field, which
// is why these are resolved onto cfg rather than living in the frozen configDefaults
// contract: `testAuthorProvider` absent means "whatever the run selected", not "claude".
function providerFor(cfg, stage) {
  const staged = stage && cfg ? cfg[STAGE_PROVIDER_KEYS[stage]] : null;
  return normalizeProvider(staged || (cfg && cfg.provider) || DEFAULT_PROVIDER);
}

function reasoningEffortFor(cfg, stage) {
  const staged = stage && cfg ? cfg[STAGE_EFFORT_KEYS[stage]] : null;
  return normalizeReasoningEffort(staged || (cfg && cfg.reasoningEffort) || DEFAULT_REASONING_EFFORT);
}

function credentialNameFor(provider) {
  return CREDENTIAL_NAMES[normalizeProvider(provider)];
}

function providerForCredentialName(name) {
  const found = PROVIDERS.find((p) => CREDENTIAL_NAMES[p] === name);
  return found || DEFAULT_PROVIDER;
}

function executableFor(provider) {
  return normalizeProvider(provider) === 'codex' ? 'codex' : 'claude';
}

// The official `codex exec` noninteractive argv. The prompt is `-` (stdin), never argv:
// a spec brief exceeds Windows' command-line limit and would otherwise need a shell.
// `--json` makes the run emit the structured JSONL that `normalizeOutput` reads.
function codexExecArgs(model, reasoningEffort) {
  return [
    'exec', '--model', String(model),
    '-c', `model_reasoning_effort="${normalizeReasoningEffort(reasoningEffort)}"`,
    ...CODEX_ENV_POLICY_ARGS,
    ...CODEX_REQUIRED_EXEC_FLAGS,
    '--json', '-',
  ];
}

// { command, args } for one launch. `claudeArgs` belongs to the calling stage and is
// returned unchanged, so an absent provider selection cannot perturb the legacy argv.
function buildLaunch(spec) {
  const provider = normalizeProvider(spec && spec.provider);
  const command = (spec && spec.command) || executableFor(provider);
  if (provider === 'codex') {
    return { provider, command, args: codexExecArgs(spec.model, spec.reasoningEffort) };
  }
  return { provider, command, args: (spec && spec.claudeArgs) || [] };
}

// The single host launch seam. `run` keeps runner/process.js's bounded contract, and its
// result — including a non-zero or null status — is propagated unchanged.
function launch(spec, run) {
  const built = buildLaunch(spec);
  return run(built.command, built.args, (spec && spec.runOptions) || {});
}

// ---- capability probing -------------------------------------------------------------

function flagPresent(text, flag) {
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`${escaped}(?![A-Za-z0-9-])`).test(text);
}

// Which required capabilities a `codex exec --help` text does NOT advertise, in roster
// order. An empty array is the only acceptable answer for a host or an image.
function missingCodexCapabilities(helpText) {
  const text = String(helpText == null ? '' : helpText);
  return CODEX_REQUIRED_EXEC_FLAGS.filter((flag) => !flagPresent(text, flag));
}

// ---- provider-aware output normalization (§4.3, §4.7) --------------------------------

// A CLI prints chatter around its own structured output, so a log is never one JSON
// document. Take the object lines and ignore everything else (the repo-52m rule, applied
// to a stream rather than a single envelope).
function objectLines(raw) {
  const found = [];
  for (const line of String(raw == null ? '' : raw).split(/\r?\n/)) {
    const text = line.trim();
    if (!text || text[0] !== '{') continue;
    try {
      const value = JSON.parse(text);
      if (value && typeof value === 'object' && !Array.isArray(value)) found.push({ text, value });
    } catch { /* chatter around the envelope, by design */ }
  }
  return found;
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function usageFrom(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const input = finiteNumber(usage.input_tokens !== undefined ? usage.input_tokens : usage.inputTokens);
  const output = finiteNumber(usage.output_tokens !== undefined ? usage.output_tokens : usage.outputTokens);
  const cached = finiteNumber(usage.cached_input_tokens !== undefined
    ? usage.cached_input_tokens : usage.cacheReadInputTokens);
  if (input === null && output === null) return null;
  return { input, output, ...(cached === null ? {} : { cached }) };
}

const RATE_LIMIT_RE = /rate.?limit|usage.?limit|quota.?exceeded/i;

function rateLimitReset(error) {
  for (const key of ['retry_after', 'retryAfter', 'reset_at', 'resetAt', 'resets_at', 'resets_in_seconds']) {
    const value = error[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) {
      // Seconds since the epoch, or a relative number of seconds — both are seconds, and
      // an absolute instant is the only form a runner can park against.
      const ms = value > 1e10 ? value : value * 1000;
      const at = value > 1e6 ? new Date(ms) : new Date(Date.now() + value * 1000);
      return Number.isNaN(at.getTime()) ? null : at.toISOString();
    }
  }
  return null;
}

function codexModelOf(event) {
  if (typeof event.model === 'string' && event.model.trim()) return event.model.trim();
  const nested = [event.item, event.turn, event.thread].find((v) => v && typeof v === 'object'
    && typeof v.model === 'string' && v.model.trim());
  return nested ? nested.model.trim() : null;
}

function normalizeCodex(raw, configuredModel) {
  const events = objectLines(raw);
  if (!events.length) return null;
  let finalText = null;
  let tokenUsage = null;
  let rateLimit = null;
  let model = null;
  for (const { text, value } of events) {
    const resolved = codexModelOf(value);
    if (resolved) model = resolved;
    const item = value.item && typeof value.item === 'object' ? value.item : null;
    if (value.type === 'item.completed' && item && item.type === 'agent_message'
        && typeof item.text === 'string') {
      finalText = item.text;
    }
    const usage = usageFrom(value.usage);
    if (usage) tokenUsage = usage;
    const error = value.error && typeof value.error === 'object' ? value.error : null;
    if (error && RATE_LIMIT_RE.test(`${error.code || ''} ${error.type || ''} ${error.message || ''}`)) {
      // The evidence is the emitted record itself, quoted verbatim. Anything summarized
      // in our own words would be this scaffolding's claim about a limit, not the CLI's.
      rateLimit = { resetAt: rateLimitReset(error), evidence: text };
    }
  }
  // Structured JSONL that carried neither a completed turn nor a limit record decides
  // nothing — and neither does prose that merely talks about rate limits.
  if (!finalText && !rateLimit) return null;
  return {
    provider: 'codex',
    configuredModel: configuredModel || null,
    model: model || configuredModel || null,
    tokenUsage,
    finalText,
    rateLimit,
  };
}

// The Claude CLI's `--output-format json` envelope, plus the ONE canonical limit marker
// the entrypoint has always parsed (`usage limit reached|<epoch seconds>`). Free prose
// mentioning a rate limit is deliberately not enough.
const CLAUDE_LIMIT_RE = /usage limit reached\|(\d+)/i;

function normalizeClaude(raw, configuredModel) {
  const text = String(raw == null ? '' : raw);
  let finalText = null;
  let tokenUsage = null;
  let model = null;
  for (const { value } of objectLines(text)) {
    if (typeof value.result !== 'string') continue;
    finalText = value.result;
    if (typeof value.model === 'string' && value.model.trim()) model = value.model.trim();
    const usage = usageFrom(value.usage);
    if (usage) tokenUsage = usage;
  }
  let rateLimit = null;
  const marker = CLAUDE_LIMIT_RE.exec(text);
  if (marker) {
    const at = new Date(Number(marker[1]) * 1000);
    rateLimit = {
      resetAt: Number.isNaN(at.getTime()) ? null : at.toISOString(),
      evidence: marker[0],
    };
  }
  if (!finalText && !rateLimit) return null;
  return {
    provider: 'claude',
    configuredModel: configuredModel || null,
    model: model || configuredModel || null,
    tokenUsage,
    finalText,
    rateLimit,
  };
}

function normalizeOutput(provider, raw, configuredModel) {
  return normalizeProvider(provider) === 'codex'
    ? normalizeCodex(raw, configuredModel)
    : normalizeClaude(raw, configuredModel);
}

// ---- selected-provider readiness (§4.12) ---------------------------------------------

function remediesFor(provider, cfg) {
  const model = (cfg && cfg.model) || '(none configured)';
  const image = (cfg && cfg.image) || '(none configured)';
  if (provider === 'codex') {
    return {
      executable: 'the selected codex executable was not found — install the pinned Codex CLI'
        + ' and put codex on this host\'s PATH',
      authenticated: 'the selected Codex provider is not authenticated — run `codex login` on the host'
        + ` for a saved ChatGPT CLI session, or set ${CREDENTIAL_NAMES.codex} for container tasks`,
      modelAvailable: `the configured model ${model} is not available to this Codex account`
        + ' — configure a model the account can actually use',
      imageSupports: `the task image ${image} carries no usable Codex CLI`
        + ' — rebuild the pinned base image so codex exec is present with every required capability',
      egress: 'egress to api.openai.com is not permitted — bring the Codex proxy profile up'
        + ' so the selected endpoint is reachable before the run starts',
    };
  }
  return {
    executable: 'the selected claude executable was not found — install the Claude Code CLI'
      + ' and put claude on this host\'s PATH',
    authenticated: `the selected Claude provider is not authenticated — set ${CREDENTIAL_NAMES.claude}`
      + ' in .env.pipeline or the environment',
    modelAvailable: `the configured model ${model} is not available to this Claude account`
      + ' — configure a model the account can actually use',
    imageSupports: `the task image ${image} carries no usable Claude CLI`
      + ' — rebuild the pinned base image',
    egress: 'egress to api.anthropic.com is not permitted — bring the Anthropic proxy profile up'
      + ' so the selected endpoint is reachable before the run starts',
  };
}

const READINESS_GATES = ['executable', 'authenticated', 'modelAvailable', 'imageSupports', 'egress'];

function gatePassed(value) {
  if (value && typeof value === 'object') return value.ok !== false;
  return !!value;
}

// Refuse before anything mutates. `deps.sideEffect` stands for the first irreversible step
// a caller would take — a worktree, a Beads claim, a publication, a Docker task, an agent
// attempt — and is reached only when every prerequisite of the SELECTED provider holds.
function preflightProvider(cfg, deps = {}) {
  const provider = providerFor(cfg);
  const remedies = remediesFor(provider, cfg);
  for (const gate of READINESS_GATES) {
    const probe = deps[gate];
    let ok = false;
    try { ok = typeof probe === 'function' ? gatePassed(probe(provider, cfg)) : true; }
    catch { ok = false; }
    if (!ok) return { ok: false, provider, missing: gate, remedy: remedies[gate] };
  }
  if (typeof deps.sideEffect === 'function') deps.sideEffect(provider, cfg);
  return { ok: true, provider };
}

module.exports = {
  PROVIDERS, REASONING_EFFORTS, DEFAULT_PROVIDER, DEFAULT_REASONING_EFFORT,
  CREDENTIAL_NAMES, CODEX_REQUIRED_EXEC_FLAGS, CODEX_ENV_POLICY_ARGS,
  normalizeProvider, normalizeReasoningEffort, validProvider, validReasoningEffort,
  providerFor, reasoningEffortFor, credentialNameFor, providerForCredentialName, executableFor,
  codexExecArgs, buildLaunch, launch,
  missingCodexCapabilities, normalizeOutput, preflightProvider,
};
