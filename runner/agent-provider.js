// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// The one agent-provider adapter — DESIGN.md §4.3 (execution layer), §6 (environment
// and constraints). Every HOST-side agent launch is constructed here: the planning
// test author, the green probe and the rate-limit probe. The container-side launch is
// the entrypoint's business; this file owns the host.
//
// Why one file rather than a branch in each launcher: the two host launchers already
// disagreed about hostEnv and about which flags they passed, and a second provider
// multiplies that by two. With one adapter there is exactly one place where "what does
// provider X's noninteractive invocation look like" is answered, and the launchers keep
// owning only what is genuinely theirs (which tools a stage may use, which tree it runs in).
//
// Nothing here is provider PROSE. A model's own text never selects an outcome: the
// normalizer below reads structured Codex JSONL events and the existing Claude envelope,
// and returns null when neither carries a structured result (hard rule 4/6).
'use strict';
const ENVELOPE = require('../pipeline/envelope');
const CODEX_OUTPUT = require('../pipeline/agent-output');

// ---- the closed vocabularies (§4.12: enumerated policy is validated by name) --------
// A closed set, not an allowlist that grows by accident: an unknown provider must be
// refused by `loadConfig` before a run creates a worktree, writes to Beads or launches
// anything, because a typo that silently fell back to Claude would bill the wrong
// subscription and record the wrong provider in the evidence.
const PROVIDERS = ['claude', 'codex'];
const DEFAULT_PROVIDER = 'claude';
// Codex's own `model_reasoning_effort` vocabulary. Claude ignores it: the field is
// accepted and validated for both providers so a config can be switched between them
// without becoming invalid, but only the Codex invocation carries it into argv.
const REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high'];
const DEFAULT_REASONING_EFFORT = 'medium';

// ---- Codex exec capability roster ---------------------------------------------------
// The exact flags this pipeline's noninteractive contract depends on. They are listed
// once and asked for three times: the image build fails without them, the preflight
// image probe refuses an image without them, and `missingCodexCapabilities` names the
// ones a given `codex exec --help` does not offer. Codex 0.58 has none of them, which is
// why a version pin alone is not the check — an image can carry a pinned-but-wrong CLI.
const CODEX_REQUIRED_EXEC_FLAGS = [
  '--approve-for-me',      // automatic review/approval: no interactive prompt, no TTY
  '--ephemeral',           // no persisted session or rollout state between invocations
  '--ignore-user-config',  // the host operator's ~/.codex must not alter a pipeline run
  '--ignore-rules',        // project AGENTS-style rule files must not alter it either
  '--strict-config',       // an unknown `-c` key fails loudly instead of being dropped
];

// The authentication variable a container Codex requires (§6). Named here because three
// places need the same spelling: the Docker `-e` name, the Codex shell-environment
// filter that keeps it out of model-spawned commands, and the preflight remedy text.
const CODEX_API_KEY_VAR = 'CODEX_API_KEY';
const CODEX_COMMAND = 'codex';
const CLAUDE_COMMAND = 'claude';
// The one endpoint a Codex task actually needs. The Codex proxy profile allows exactly
// this host and the preflight remedy names it, so "which endpoint" has one source.
const OPENAI_API_HOST = 'api.openai.com';

// ---- per-stage selection ------------------------------------------------------------
// Selection is a CHAIN — stage field, then the run-wide field, then the constant — which
// is why neither of these can live in `contracts/control-plane.json`'s configDefaults:
// a chained field has no single default value, and that contract object is asserted
// identical to `runner/config.js`'s DEFAULTS by a frozen suite.
const STAGE_FIELDS = {
  'test-author': { provider: 'testAuthorProvider', reasoningEffort: 'testAuthorReasoningEffort' },
  'test-probe': { provider: 'testProbeProvider', reasoningEffort: 'testProbeReasoningEffort' },
};

function pick(cfg, stage, kind, allowed, fallback) {
  const source = cfg && typeof cfg === 'object' ? cfg : {};
  const stageField = (STAGE_FIELDS[stage] || {})[kind];
  const candidates = [stageField ? source[stageField] : undefined, source[kind]];
  for (const value of candidates) {
    if (typeof value === 'string' && allowed.includes(value)) return value;
  }
  return fallback;
}

// Which provider runs this stage. Absent fields answer `claude` at every link of the
// chain, which is what makes an untouched config byte-for-byte its former self.
function providerFor(cfg, stage) {
  return pick(cfg, stage, 'provider', PROVIDERS, DEFAULT_PROVIDER);
}

function reasoningEffortFor(cfg, stage) {
  return pick(cfg, stage, 'reasoningEffort', REASONING_EFFORTS, DEFAULT_REASONING_EFFORT);
}

// ---- argv construction --------------------------------------------------------------
// Codex reads `-c key=value` as TOML, so a string value must arrive quoted and a boolean
// must not. Getting that backwards is not a soft failure under `--strict-config`: the
// whole invocation is rejected, which is the loud behaviour we want rather than a run
// that quietly kept the operator's own sandbox policy.
const codexOverride = (key, value) => ['-c', `${key}=${value}`];
const tomlString = (value) => `"${String(value)}"`;

// `codex exec` with the prompt on stdin. The trailing `-` is what asks for stdin rather
// than an argv prompt: that keeps a long brief off a command line (Windows' length limit)
// and keeps every byte of it out of `ps` output and any shell history.
//
// The shell-environment policy is the substantive half of §6's credential rule. Codex
// hands an environment to every command the MODEL spawns, and by default that inherits
// the CLI's own. `ignore_default_excludes=false` keeps Codex's built-in secret-name
// excludes in force (the *KEY*/*TOKEN*/*SECRET* family), and the explicit
// `filters.CODEX_API_KEY="exclude"` names ours rather than trusting a pattern to cover
// it. So the CLI authenticates and nothing it spawns can read the key.
//
// `--approve-for-me` is the automatic-review contract: Codex applies its workspace-write
// sandbox and reviews its own actions instead of waiting for a human on a TTY that does
// not exist here. `--json` makes the output structured JSONL, which is what
// `normalizeOutput` reads — the alternative is scraping prose, which hard rule 4 forbids.
function codexExecArgs({ model, reasoningEffort }) {
  return [
    'exec',
    '--model', String(model),
    ...codexOverride('model_reasoning_effort', tomlString(reasoningEffort)),
    ...codexOverride('shell_environment_policy.ignore_default_excludes', 'false'),
    ...codexOverride(`shell_environment_policy.filters.${CODEX_API_KEY_VAR}`, tomlString('exclude')),
    ...CODEX_REQUIRED_EXEC_FLAGS,
    '--json',
    '-',
  ];
}

// The historical Claude argv, unchanged and moved rather than rewritten. `-p` with no
// prompt argv reads stdin. Permissions stay at the host user's normal policy: a HOST
// session is not a sandboxed container and must not bypass them.
function claudeArgs({ model, tools, allowedTools, disallowedTools }) {
  return [
    '-p', '--model', String(model),
    '--restricted', '--permission-mode', 'acceptEdits',
    '--tools', tools,
    '--allowedTools', allowedTools,
    '--disallowedTools', disallowedTools,
    '--no-session-persistence',
  ];
}

// The executable a stage launches, honouring the existing per-stage override seams so
// the Docker-free suites keep their fake executables.
function commandFor(provider, commandOverride) {
  if (typeof commandOverride === 'string' && commandOverride.trim()) return commandOverride;
  return provider === 'codex' ? CODEX_COMMAND : CLAUDE_COMMAND;
}

// The single construction point for a host agent launch.
//
//   spec.cfg           the run config (raw or loaded — selection tolerates both)
//   spec.stage         'test-author' | 'test-probe'
//   spec.model         the pinned alias/id, already resolved by the caller
//   spec.claude        { tools, allowedTools, disallowedTools } — the stage's Claude policy
//   spec.commandOverride  the stage's env seam value, when set
//   spec.opts          cwd/input/timeoutMs/env/maxBuffer/cfg — owned by the caller
//
// Returns whatever the injected `run` returns, unchanged: an exit status is evidence and
// this adapter never reinterprets one.
function launchAgent(run, spec) {
  const provider = providerFor(spec.cfg, spec.stage);
  const args = provider === 'codex'
    ? codexExecArgs({ model: spec.model, reasoningEffort: reasoningEffortFor(spec.cfg, spec.stage) })
    : claudeArgs({ model: spec.model, ...(spec.claude || {}) });
  return run(commandFor(provider, spec.commandOverride), args, {
    ...spec.opts,
    label: `${provider} ${spec.stage} session`,
  });
}

// ---- image / CLI capability ---------------------------------------------------------
// Which required flags a given `codex exec --help` does NOT advertise. Returned in the
// roster's own order so a remedy reads the same way every time, and a text that offers
// all of them answers [] rather than "probably fine".
function missingCodexCapabilities(helpText) {
  const text = String(helpText == null ? '' : helpText);
  return CODEX_REQUIRED_EXEC_FLAGS.filter((flag) => !text.includes(flag));
}

// ---- output normalization (§4.11 evidence, hard rules 4 and 6) ----------------------
// The Codex JSONL reader itself lives in `pipeline/agent-output.js`, beside the Claude
// envelope reader and for the same reason: the container writes its own summary from that
// stream too, and two parsers would let the evidence the host records disagree with the
// summary the task produced.
//
// Claude's rate-limit signal has never been structured the way Codex's is: the CLI says
// it in the text of a failed turn, in one fixed machine-readable shape
// (`usage limit reached|<epoch>`) that the container entrypoint has matched since §4.7.
// Matching that ONE anchored shape is not prose-scraping — an arbitrary sentence about
// rate limits still yields nothing.
const CLAUDE_RATE_LIMIT_RE = /usage limit reached\|(\d+)/i;

function claudeRateLimit(raw) {
  const text = String(raw == null ? '' : raw);
  const m = CLAUDE_RATE_LIMIT_RE.exec(text);
  if (!m) return null;
  const epochSeconds = Number(m[1]);
  if (!Number.isFinite(epochSeconds) || epochSeconds <= 0) return null;
  const reset = new Date(epochSeconds * 1000);
  if (Number.isNaN(reset.getTime())) return null;
  return { resetAt: reset.toISOString(), evidence: m[0] };
}

// -> { provider, configuredModel, model, tokenUsage, finalText, rateLimit } | null
//
// null means "this output carries no structured outcome at all", and it is the answer
// that matters most: it is what stops a model's own prose from selecting an outcome or
// manufacturing a rate-limit reset. A caller that gets null has learned nothing from the
// agent and must fall back to the deterministic gate, never to the text.
function normalizeOutput(provider, raw, configuredModel) {
  const selected = PROVIDERS.includes(provider) ? provider : DEFAULT_PROVIDER;
  const configured = typeof configuredModel === 'string' && configuredModel.trim()
    ? configuredModel : null;

  if (selected === 'codex') {
    const parsed = CODEX_OUTPUT.parse(raw, configured || undefined);
    if (!parsed) return null;
    const record = {
      provider: selected,
      configuredModel: configured,
      model: parsed.model,
      tokenUsage: parsed.tokenUsage,
      finalText: parsed.finalText,
    };
    if (parsed.rateLimit) record.rateLimit = parsed.rateLimit;
    return record;
  }

  // Claude keeps its existing envelope reader — one parser, still bottom-up, still
  // tolerant of CLI chatter around the envelope (repo-52m).
  const envelope = ENVELOPE.parse(raw, configured || undefined);
  const rateLimit = claudeRateLimit(raw);
  if (!envelope && !rateLimit) return null;
  const record = {
    provider: selected,
    configuredModel: configured,
    model: (envelope && envelope.model) || configured || null,
    tokenUsage: null,
    finalText: envelope && typeof envelope.result === 'string' && envelope.result.trim()
      ? envelope.result : null,
  };
  if (rateLimit) record.rateLimit = rateLimit;
  return record;
}

// ---- provider readiness (§4.12 gate ordering) ---------------------------------------
// Every prerequisite of the SELECTED provider is asked BEFORE the supplied side-effect
// seam is called even once. That ordering is the whole point: a run that discovers a
// missing Codex CLI after it has created a worktree, claimed a Beads issue, published a
// branch or started a container has already mutated four things it now has to unwind,
// and the operator reads the failure in the morning with a half-built state on disk.
//
// Each remedy NAMES THE ACTION, not the condition. "codex not found" tells an operator
// what is broken; "install the Codex CLI ... or set its path" tells them what to do.
const REMEDIES = {
  codex: {
    executable: () => `the selected provider is codex but the codex executable is not on PATH —`
      + ` install the Codex CLI (npm i -g @openai/codex) or put codex on this host's path`,
    authenticated: () => `codex is not authenticated — run \`codex login\` to reuse saved ChatGPT`
      + ` CLI authentication on this host, or export ${CODEX_API_KEY_VAR} for it`,
    modelAvailable: (cfg) => `the configured model '${cfg.model || '(unset)'}' is not available to this`
      + ` codex account — configure a model this account can reach in the run config's model field`,
    imageSupports: (cfg) => `image '${cfg.image || '(unset)'}' has no usable codex CLI — rebuild the`
      + ` task image so the image carries a codex with ${CODEX_REQUIRED_EXEC_FLAGS.join(' ')}`,
    egress: () => `egress to ${OPENAI_API_HOST} is not permitted by this run's proxy profile —`
      + ` bring up the codex proxy profile (docker/proxy-codex) so ${OPENAI_API_HOST} is reachable`,
  },
  claude: {
    executable: () => 'the selected provider is claude but the claude executable is not on PATH —'
      + " install the Claude Code CLI or put claude on this host's path",
    authenticated: () => 'claude is not authenticated — set CLAUDE_CODE_OAUTH_TOKEN in .env.pipeline'
      + ' or in this shell before starting a run',
    modelAvailable: (cfg) => `the configured model '${cfg.model || '(unset)'}' is not available to this`
      + ' claude account — configure a model this account can reach in the run config',
    imageSupports: (cfg) => `image '${cfg.image || '(unset)'}' has no usable claude CLI — rebuild the`
      + ' task image so the image carries the pinned Claude Code CLI',
    egress: () => "egress to api.anthropic.com is not permitted by this run's proxy profile —"
      + ' bring up the anthropic proxy profile (docker/proxy) so api.anthropic.com is reachable',
  },
};

// The order the prerequisites are asked in. Cheapest and most local first, so the
// common misconfiguration is reported without having spun a container up.
const READINESS_ORDER = ['executable', 'authenticated', 'modelAvailable', 'imageSupports', 'egress'];

// -> { ok: false, missing, remedy } | { ok: true }
// A dep that is absent counts as SATISFIED, so a caller can gate on the subset it can
// actually answer. A dep that THROWS counts as failed: a probe that cannot complete has
// not proved anything, and treating "unknown" as ready is how a run gets to the mutation
// it was supposed to be stopped before.
function preflightProvider(cfg, deps = {}) {
  const config = cfg && typeof cfg === 'object' ? cfg : {};
  const provider = providerFor(config, null);
  const remedies = REMEDIES[provider] || REMEDIES[DEFAULT_PROVIDER];
  for (const name of READINESS_ORDER) {
    const probe = deps[name];
    if (typeof probe !== 'function') continue;
    let ready;
    try { ready = probe(config, provider); }
    catch { ready = false; }
    if (!ready) return { ok: false, missing: name, remedy: remedies[name](config) };
  }
  if (typeof deps.sideEffect === 'function') deps.sideEffect(config, provider);
  return { ok: true };
}

module.exports = {
  PROVIDERS, DEFAULT_PROVIDER, REASONING_EFFORTS, DEFAULT_REASONING_EFFORT,
  CODEX_REQUIRED_EXEC_FLAGS, CODEX_API_KEY_VAR, CODEX_COMMAND, CLAUDE_COMMAND, OPENAI_API_HOST,
  providerFor, reasoningEffortFor, codexExecArgs, claudeArgs, commandFor, launchAgent,
  missingCodexCapabilities, normalizeOutput, preflightProvider,
};
