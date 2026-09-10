// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// The provider adapter — DESIGN.md §4.3, §6.5. ONE place constructs every agent launch
// this repository makes, for either backend, so a stage cannot grow its own dialect of
// "how we call the model".
//
// Two backends, deliberately not translated into each other:
//   claude  the historical restricted-tool session (`claude -p ...`), unchanged.
//   codex   the official `codex exec` noninteractive contract: prompt on stdin, model and
//           reasoning effort explicit, ephemeral state, structured JSONL out.
//
// Three rules travel with the Codex half and are the reason this file exists at all:
//   1. Secrets never enter argv. CODEX_API_KEY is handed to the CLI in its process
//      environment and named — never valued — in Docker argv (runner/container.js).
//   2. The CLI's own shell-environment policy keeps that key, and the default secret-name
//      excludes, out of every command the model spawns: `ignore_default_excludes=false`
//      keeps the built-in exclusions on, and one explicit filter names our key.
//   3. Outcomes come from the CLI's structured output, never from model prose
//      (`normalizeOutput` below, hard rule 6).
'use strict';
const codexOutput = require('../pipeline/agent-output.js');
const envelope = require('../pipeline/envelope.js');

// Closed vocabularies. A value outside them is refused by name in runner/config.js before
// a run starts, rather than reaching a CLI that would reject it after a worktree exists.
const PROVIDERS = Object.freeze(['claude', 'codex']);
const REASONING_EFFORTS = Object.freeze(['minimal', 'low', 'medium', 'high']);
const DEFAULT_PROVIDER = 'claude';
const DEFAULT_REASONING_EFFORT = 'medium';

const CODEX_COMMAND = 'codex';
const CLAUDE_COMMAND = 'claude';
const CODEX_API_KEY_ENV = 'CODEX_API_KEY';
const CLAUDE_TOKEN_ENV = 'CLAUDE_CODE_OAUTH_TOKEN';
const CODEX_ENDPOINT = 'api.openai.com';
const CLAUDE_ENDPOINT = 'api.anthropic.com';
const CODEX_PIN = '@openai/codex@0.154.0';

// The exec capabilities this pipeline depends on. Older Codex builds (0.58 and its
// contemporaries) accept `codex exec` and reject every one of these, which is a silently
// different agent: user config would be read, rules applied, state persisted, and every
// edit would stop for an approval nobody is there to give. So the roster is checked
// against `codex exec --help` at image build time AND before a run (see
// missingCodexCapabilities / imageProbe), rather than discovered from a failed task.
//   --approve-for-me    review and approve the agent's own actions (workspace-write,
//                       no human in the loop) — the only noninteractive shape there is
//   --ephemeral         no session/thread state survives the invocation
//   --ignore-user-config, --ignore-rules   the host's personal Codex config and rule
//                       files must not reach an autonomous run
//   --strict-config     an unknown or malformed -c is an error, never a silent default
const CODEX_REQUIRED_EXEC_FLAGS = Object.freeze([
  '--approve-for-me', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--strict-config',
]);

function providerOf(value) {
  const p = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return PROVIDERS.includes(p) ? p : DEFAULT_PROVIDER;
}

function reasoningEffortOf(value) {
  const e = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return REASONING_EFFORTS.includes(e) ? e : DEFAULT_REASONING_EFFORT;
}

// Which environment variable carries this provider's credential. The NAME is public and
// travels through argv; the value never does.
function credentialEnvFor(provider) {
  return providerOf(provider) === 'codex' ? CODEX_API_KEY_ENV : CLAUDE_TOKEN_ENV;
}

function endpointFor(provider) {
  return providerOf(provider) === 'codex' ? CODEX_ENDPOINT : CLAUDE_ENDPOINT;
}

function executableFor(provider) {
  return providerOf(provider) === 'codex' ? CODEX_COMMAND : CLAUDE_COMMAND;
}

// Every required capability the given `codex exec --help` text does NOT offer, in roster
// order. A structural check on the CLI's own help output: it needs no network, no
// credential and no model call, so it can gate a build and a preflight alike.
function missingCodexCapabilities(helpText) {
  const text = String(helpText == null ? '' : helpText);
  return CODEX_REQUIRED_EXEC_FLAGS.filter((flag) => !text.includes(flag));
}

// The exec argv. Order is fixed and deliberate: model and reasoning effort first (what
// ran), then the environment policy (what the model may see), then the capability roster
// (how autonomous it is), then the output contract, then `-` — the prompt on stdin, which
// is what keeps a spec of any size out of argv and off Windows' command-line limit.
function codexExecArgs(model, reasoningEffort) {
  return [
    'exec',
    '--model', String(model),
    '-c', `model_reasoning_effort="${reasoningEffortOf(reasoningEffort)}"`,
    // Keep Codex's built-in secret-name exclusions ON, then name our key explicitly: the
    // agent's own shell commands must not inherit the credential that authenticates it.
    '-c', 'shell_environment_policy.ignore_default_excludes=false',
    '-c', `shell_environment_policy.filters.${CODEX_API_KEY_ENV}="exclude"`,
    ...CODEX_REQUIRED_EXEC_FLAGS,
    '--json',
    '-',
  ];
}

// A READ-ONLY exec argv, for the two things that ask Codex a question rather than giving
// it work: the host rate-limit probe (§4.7) and the opt-in live smoke. Same model, effort
// and stdin prompt as a real launch; deliberately NOT autonomous — `--sandbox read-only`
// in place of `--approve-for-me`, so a probe cannot edit the tree it happens to run in.
function codexReadOnlyArgs(model, reasoningEffort) {
  return [
    'exec',
    '--model', String(model),
    '-c', `model_reasoning_effort="${reasoningEffortOf(reasoningEffort)}"`,
    '-c', 'shell_environment_policy.ignore_default_excludes=false',
    '-c', `shell_environment_policy.filters.${CODEX_API_KEY_ENV}="exclude"`,
    '--sandbox', 'read-only',
    '--ephemeral', '--ignore-user-config', '--ignore-rules', '--strict-config',
    '--json',
    '-',
  ];
}

// The historical Claude session argv, unchanged and still spelled out here so both host
// stages read it from one place. Restricted mode, explicit tool rosters, no session state.
function claudeSessionArgs(model, claude = {}) {
  return [
    '-p', '--model', String(model),
    '--restricted', '--permission-mode', 'acceptEdits',
    '--tools', claude.tools,
    '--allowedTools', claude.allowedTools,
    '--disallowedTools', claude.disallowedTools,
    '--no-session-persistence',
  ];
}

// -> { provider, command, args }. The single construction point named by criterion 2:
// scripts/author-tests.js and scripts/prove-tests.js both come through here, so neither
// can drift into provider-specific flag handling of its own.
// `commandOverride` is the existing per-stage test seam (PIPELINE_TEST_AUTHOR_CMD /
// PIPELINE_TEST_PROBE_CMD): it replaces the executable, never the contract.
function hostLaunch(spec = {}) {
  const provider = providerOf(spec.provider);
  const command = (spec.commandOverride && String(spec.commandOverride).trim())
    || executableFor(provider);
  const args = provider === 'codex'
    ? codexExecArgs(spec.model, spec.reasoningEffort)
    : claudeSessionArgs(spec.model, spec.claude || {});
  return { provider, command, args };
}

// The isolated capability probe for a task image: no network, no credential, no workspace.
// Codex is asked for its exec help (the roster above decides); Claude is asked the same
// `--version` question it has always been asked, so the historical behaviour is preserved.
function imageProbe(provider, image) {
  const base = ['run', '--rm', '--network', 'none'];
  return providerOf(provider) === 'codex'
    ? { command: 'docker', args: [...base, '--entrypoint', CODEX_COMMAND, image, 'exec', '--help'] }
    : { command: 'docker', args: [...base, '--entrypoint', CLAUDE_COMMAND, image, '--version'] };
}

// ---- output normalization (criterion 5) --------------------------------------------
// One record shape for both backends:
//   { provider, configuredModel, model, tokenUsage, finalText, rateLimit }
// or null when the raw output carries neither a structured final answer nor a structured
// rate-limit outcome. Model prose can therefore never select an outcome: a log that only
// SAYS it succeeded, or only says it was rate limited, normalizes to null.
function claudeRateLimit(text) {
  const raw = String(text == null ? '' : text);
  const line = raw.split('\n').map((l) => l.trim())
    .filter((l) => /usage limit reached\|[0-9]+/i.test(l)).pop();
  if (!line) return null;
  const epoch = (line.match(/usage limit reached\|([0-9]+)/i) || [])[1];
  return {
    resetAt: epoch ? new Date(Number(epoch) * 1000).toISOString() : null,
    evidence: line,
  };
}

function claudeUsage(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const input = num(raw.input_tokens);
  const output = num(raw.output_tokens);
  if (input === null && output === null) return null;
  return { input, output, total: (input || 0) + (output || 0) };
}

function normalizeOutput(provider, raw, configuredModel) {
  const p = providerOf(provider);
  const configured = typeof configuredModel === 'string' && configuredModel.trim()
    ? configuredModel.trim() : null;
  const text = String(raw == null ? '' : raw);
  if (p === 'codex') {
    const parsed = codexOutput.parse(text);
    if (!parsed) return null;
    return {
      provider: p,
      configuredModel: configured,
      model: parsed.model || configured,
      tokenUsage: parsed.tokenUsage || null,
      finalText: parsed.finalText,
      rateLimit: parsed.rateLimit || null,
    };
  }
  const parsed = envelope.parse(text, configured || undefined);
  const rateLimit = claudeRateLimit(text);
  if (!parsed && !rateLimit) return null;
  return {
    provider: p,
    configuredModel: configured,
    model: (parsed && parsed.model) || configured,
    tokenUsage: parsed ? claudeUsage(parsed.usage) : null,
    finalText: parsed ? parsed.result : null,
    rateLimit: rateLimit || null,
  };
}

// ---- selected-provider readiness (criterion 6) --------------------------------------
// Every prerequisite of the SELECTED provider is asked before the caller's one mutating
// step — a worktree, a Beads claim, a publication, a Docker task, an agent attempt — and
// each refusal names the remedy rather than the symptom. The mutation is the `sideEffect`
// seam, so "it refused before doing anything" is observable rather than asserted.
//
// A caller supplies only the probes that apply to it: the host launchers own executable,
// authentication and model; the runner owns authentication, image support and egress.
// An unsupplied probe is not a refusal — it is a question this caller does not ask.
function providerGates(provider, cfg) {
  const p = providerOf(provider);
  const model = (cfg && cfg.model) || '(none configured)';
  const image = (cfg && cfg.image) || '(none configured)';
  if (p === 'codex') {
    return [
      { name: 'executable',
        remedy: `the codex executable is not on this host's PATH — install the pinned CLI (npm install -g ${CODEX_PIN}) or put codex on PATH, then retry` },
      { name: 'authenticated',
        remedy: `codex is not authenticated — run \`codex login\` on this host (a host run may reuse saved ChatGPT CLI authentication), or set ${CODEX_API_KEY_ENV} in .env.pipeline for container runs` },
      { name: 'modelAvailable',
        remedy: `the configured model '${model}' is not available to this Codex account — configure a model this account can use in the run config, then retry` },
      { name: 'imageSupports',
        remedy: `the task image '${image}' does not provide a Codex CLI with the required exec capabilities (${CODEX_REQUIRED_EXEC_FLAGS.join(' ')}) — rebuild the base image from docker/base with ${CODEX_PIN} pinned` },
      { name: 'egress',
        remedy: `egress to ${CODEX_ENDPOINT} is blocked for this run — bring up the codex proxy profile (docker/proxy-codex) so the allowlist permits ${CODEX_ENDPOINT}, then retry` },
    ];
  }
  return [
    { name: 'executable',
      remedy: 'the claude executable is not on this host\'s PATH — install the Claude Code CLI or put claude on PATH, then retry' },
    { name: 'authenticated',
      remedy: `no ${CLAUDE_TOKEN_ENV} is available — put it in .env.pipeline or the environment, then retry` },
    { name: 'modelAvailable',
      remedy: `the configured model '${model}' is not available to this account — configure a model this account can use in the run config, then retry` },
    { name: 'imageSupports',
      remedy: `the task image '${image}' does not provide the Claude CLI — rebuild the base image from docker/base` },
    { name: 'egress',
      remedy: `egress to ${CLAUDE_ENDPOINT} is blocked for this run — check the proxy sidecar and its allowlist, then retry` },
  ];
}

function preflightProvider(cfg, deps = {}) {
  const provider = providerOf(cfg && cfg.provider);
  for (const gate of providerGates(provider, cfg)) {
    const probe = deps[gate.name];
    if (typeof probe !== 'function') continue;
    let ok = false;
    let detail = '';
    // A probe that throws is a probe that could not prove its prerequisite. It refuses
    // with the same remedy plus what went wrong, because an exception escaping here would
    // abort ahead of the caller's own compensation rather than refusing cleanly.
    try { ok = !!probe(); }
    catch (e) { ok = false; detail = e && e.message ? e.message : String(e); }
    if (!ok) {
      return {
        ok: false,
        provider,
        missing: gate.name,
        remedy: detail ? `${gate.remedy} (probe failed: ${detail})` : gate.remedy,
      };
    }
  }
  const value = typeof deps.sideEffect === 'function' ? deps.sideEffect() : undefined;
  return { ok: true, provider, value };
}

module.exports = {
  PROVIDERS, REASONING_EFFORTS, DEFAULT_PROVIDER, DEFAULT_REASONING_EFFORT,
  CODEX_REQUIRED_EXEC_FLAGS, CODEX_API_KEY_ENV, CLAUDE_TOKEN_ENV, CODEX_ENDPOINT,
  CLAUDE_ENDPOINT, CODEX_PIN,
  providerOf, reasoningEffortOf, credentialEnvFor, endpointFor, executableFor,
  missingCodexCapabilities, codexExecArgs, codexReadOnlyArgs, claudeSessionArgs,
  hostLaunch, imageProbe,
  normalizeOutput, preflightProvider, providerGates,
};
