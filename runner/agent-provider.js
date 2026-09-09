// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// The agent provider adapter — DESIGN.md §4.3, §4.8, §4.12, §6.
//
// ONE place constructs every host agent launch, names every provider credential, and
// answers whether a selected provider is ready. Two backends are supported and the
// vocabulary is CLOSED (`PROVIDERS`): a run config naming anything else is refused by
// field name before a worktree, a Beads read, a container or an agent attempt exists.
//
//   claude  the historical backend. Its argv, stdin, cwd, environment and timeout are
//           unchanged, byte for byte, and a config that names no provider gets exactly it.
//   codex   `codex exec` noninteractive. Prompt on stdin, model and reasoning effort as
//           explicit argv, ephemeral state, and a shell environment policy that excludes
//           the API key from anything the model spawns.
//
// Why an adapter rather than a flag inside each launcher: the two launchers (test author,
// green probe) plus the container entrypoint each build a command line, and a provider
// added to one of them and not the others is a run that silently mixes backends. The
// stage table below is the single roster of launch points, so a third stage cannot be
// wired to a provider without appearing here.
//
// Secrets never enter argv. The credential is named — `CODEX_API_KEY`,
// `CLAUDE_CODE_OAUTH_TOKEN` — and its value travels only in the launched process's own
// environment (§6). The `shell_environment_policy` arguments are what stop it travelling
// any further: Codex hands its own environment to the commands the model runs, so the key
// is excluded by name AND the CLI's default secret-name excludes are left switched on.
'use strict';
const { normalizeOutput } = require('../pipeline/agent-output');

const PROVIDERS = Object.freeze(['claude', 'codex']);
// Codex's own vocabulary. Closed for the same reason the provider list is: an unknown
// value would be handed to `-c model_reasoning_effort=` and rejected by the CLI after the
// host had already built a worktree.
const REASONING_EFFORTS = Object.freeze(['minimal', 'low', 'medium', 'high']);
const DEFAULT_PROVIDER = 'claude';
const DEFAULT_REASONING_EFFORT = 'medium';

const CLAUDE_CREDENTIAL_ENV = 'CLAUDE_CODE_OAUTH_TOKEN';
const CODEX_CREDENTIAL_ENV = 'CODEX_API_KEY';
// The single concrete endpoint a Codex task needs. Named here so the adapter's remedy
// text, the proxy profile and the egress gate cannot drift into naming different hosts.
const CODEX_ENDPOINT = 'api.openai.com';
const CLAUDE_ENDPOINT = 'api.anthropic.com';

// Every launch point, with the config fields that select its provider and effort and the
// test seam that overrides its executable. `implementation` is the container agent: the
// host builds no argv for it (the entrypoint does), but it selects a provider, a
// credential and a proxy profile, so it belongs in the same roster.
const STAGES = Object.freeze({
  'test-author': Object.freeze({
    providerKey: 'testAuthorProvider',
    effortKey: 'testAuthorReasoningEffort',
    commandEnv: 'PIPELINE_TEST_AUTHOR_CMD',
    label: 'test-author session',
  }),
  'green-probe': Object.freeze({
    providerKey: 'testProbeProvider',
    effortKey: 'testProbeReasoningEffort',
    commandEnv: 'PIPELINE_TEST_PROBE_CMD',
    label: 'green-probe session',
  }),
  implementation: Object.freeze({
    providerKey: 'provider',
    effortKey: 'reasoningEffort',
    commandEnv: 'PIPELINE_AGENT_CMD',
    label: 'implementation agent',
  }),
});

function isProvider(value) {
  return typeof value === 'string' && PROVIDERS.includes(value);
}

function isReasoningEffort(value) {
  return typeof value === 'string' && REASONING_EFFORTS.includes(value);
}

// Stage field, else the global field, else the historical default. Applied to a RAW config
// object as well as a loaded one, because the launchers are handed plain snapshots by the
// batch coordinator and by every fixture.
function providerFor(cfg, stage = 'implementation') {
  const key = (STAGES[stage] || STAGES.implementation).providerKey;
  const own = cfg && cfg[key];
  if (isProvider(own)) return own;
  const global = cfg && cfg.provider;
  return isProvider(global) ? global : DEFAULT_PROVIDER;
}

function effortFor(cfg, stage = 'implementation') {
  const key = (STAGES[stage] || STAGES.implementation).effortKey;
  const own = cfg && cfg[key];
  if (isReasoningEffort(own)) return own;
  const global = cfg && cfg.reasoningEffort;
  return isReasoningEffort(global) ? global : DEFAULT_REASONING_EFFORT;
}

function credentialEnvFor(provider) {
  return provider === 'codex' ? CODEX_CREDENTIAL_ENV : CLAUDE_CREDENTIAL_ENV;
}

function endpointFor(provider) {
  return provider === 'codex' ? CODEX_ENDPOINT : CLAUDE_ENDPOINT;
}

function displayName(provider) {
  return provider === 'codex' ? 'Codex' : 'Claude';
}

// The existing restricted Claude argv, unchanged. Kept here so "one adapter constructs
// every host launch" is literally true rather than true for the new backend only; the
// per-stage tool strings stay owned by their launchers, which is where the verifier
// command and the probe's shell-free rule are decided.
function claudeArgs(model, claude = {}) {
  return [
    '-p', '--model', model,
    '--restricted', '--permission-mode', 'acceptEdits',
    '--tools', claude.tools,
    '--allowedTools', claude.allowedTools,
    '--disallowedTools', claude.disallowedTools,
    '--no-session-persistence',
  ];
}

// `codex exec` with the prompt on stdin (`-`), which is what keeps a whole spec brief out
// of argv and off the Windows command-line length limit, exactly as `claude -p` does.
//
//   --model / model_reasoning_effort   the two pinned decisions, explicit rather than
//                                     inherited from whatever the account default is.
//   shell_environment_policy.*         the API key is excluded from the environment handed
//                                     to model-spawned commands BY NAME, and the CLI's own
//                                     default secret-name excludes stay on
//                                     (`ignore_default_excludes=false`). Both, because the
//                                     default list is a moving target and our key name is
//                                     the one thing we know must never leak.
//   --approve-for-me                   automatic review of the model's proposed actions;
//                                     no human is present in a headless launch.
//   --ephemeral                        no session state survives the launch, matching
//                                     `--no-session-persistence` on the Claude side.
//   --ignore-user-config/--ignore-rules  the host operator's own Codex configuration and
//                                     rules files must not change what a pipeline run does.
//   --strict-config                    a `-c` key the CLI does not understand is an error,
//                                     not a silently dropped policy. This is what makes
//                                     the two environment-policy arguments above load-bearing
//                                     rather than decorative.
//   --json                             JSONL, so agent-output.js reads structure and never
//                                     prose (§4.3, hard rule 6).
function codexArgs(model, effort) {
  return [
    'exec',
    '--model', model,
    '-c', `model_reasoning_effort="${effort}"`,
    '-c', 'shell_environment_policy.ignore_default_excludes=false',
    '-c', `shell_environment_policy.filters.${CODEX_CREDENTIAL_ENV}="exclude"`,
    '--approve-for-me',
    '--ephemeral',
    '--ignore-user-config',
    '--ignore-rules',
    '--strict-config',
    '--json',
    '-',
  ];
}

// -> { provider, command, args, label, model, reasoningEffort }
// The caller owns stdin, cwd, environment and the timeout; this owns the executable and
// the argument vector. The test seam is per stage and unchanged: an operator-supplied
// PIPELINE_TEST_AUTHOR_CMD / PIPELINE_TEST_PROBE_CMD still replaces the executable and
// still receives the provider's own arguments.
function hostLaunch(spec = {}) {
  const stage = STAGES[spec.stage] || STAGES.implementation;
  const provider = isProvider(spec.provider) ? spec.provider : DEFAULT_PROVIDER;
  const reasoningEffort = isReasoningEffort(spec.reasoningEffort)
    ? spec.reasoningEffort : DEFAULT_REASONING_EFFORT;
  const env = spec.env || process.env;
  const model = String(spec.model === undefined || spec.model === null ? '' : spec.model);
  const command = (stage.commandEnv && env[stage.commandEnv]) || provider;
  const args = provider === 'codex'
    ? codexArgs(model, reasoningEffort)
    : claudeArgs(model, spec.claude || {});
  return {
    provider,
    command,
    args,
    label: `${displayName(provider)} ${stage.label}`,
    model,
    reasoningEffort,
  };
}

// ---- readiness (§4.12, criterion 6) -------------------------------------------------
// Each prerequisite refuses INDEPENDENTLY and names the remedy for the provider that was
// actually selected. `deps.sideEffect` is the first thing that would mutate anything —
// a worktree, Beads, a Git publication, a Docker task, an agent attempt — and it is
// reached only after every prerequisite the caller supplied has passed.
//
// A prerequisite whose probe the caller did not supply is NOT CHECKED HERE and says so in
// `checked`. That is deliberate rather than fail-open: the prerequisites differ per entry
// point (the host launchers need a local executable; the runner needs the credential, the
// model, an image that carries the CLI and proven egress), and a caller that silently got
// a pass for a probe it never ran would be worse than one that can be asked which gates it
// proved. Callers pass what applies to them; the result says what that was.
const GATES = Object.freeze([
  Object.freeze({
    dep: 'executable',
    remedy: (provider, cfg) => (provider === 'codex'
      ? 'the codex executable is not on PATH — install the pinned Codex CLI'
        + ' (npm install -g @openai/codex) and make sure codex is on this shell\'s PATH'
      : 'the claude executable is not on PATH — install the pinned Claude Code CLI'
        + ' (npm install -g @anthropic-ai/claude-code) and make sure claude is on this shell\'s PATH'),
  }),
  Object.freeze({
    dep: 'authenticated',
    remedy: (provider, cfg) => (provider === 'codex'
      ? `no Codex authentication — run \`codex login\` on this host to reuse saved ChatGPT CLI`
        + ` authentication, or set ${CODEX_CREDENTIAL_ENV} in .env.pipeline (a task container`
        + ` has no saved login and requires ${CODEX_CREDENTIAL_ENV})`
      : `no Claude authentication — set ${CLAUDE_CREDENTIAL_ENV} in .env.pipeline or this environment`),
  }),
  Object.freeze({
    dep: 'modelAvailable',
    remedy: (provider, cfg) => `the selected ${displayName(provider)} model`
      + `${cfg && cfg.model ? ` '${cfg.model}'` : ''} is not available to this account —`
      + ` configure a model this account can use in run.config.json ('model', or the`
      + ` per-stage testAuthorModel / testProbeModel)`,
  }),
  Object.freeze({
    dep: 'imageSupports',
    remedy: (provider, cfg) => (provider === 'codex'
      ? `the task image${cfg && cfg.image ? ` '${cfg.image}'` : ''} carries no codex executable —`
        + ' rebuild docker/base with the pinned Codex CLI, then rebuild the project image (§3.4)'
      : `the task image${cfg && cfg.image ? ` '${cfg.image}'` : ''} carries no claude executable —`
        + ' rebuild docker/base with the pinned Claude Code CLI, then rebuild the project image (§3.4)'),
  }),
  Object.freeze({
    dep: 'egress',
    remedy: (provider) => `egress to ${endpointFor(provider)} is not permitted by the proxy profile`
      + ` in force — bring up the ${provider === 'codex' ? 'docker/proxy-codex' : 'docker/proxy'}`
      + ` profile for this run and re-run the egress gate`,
  }),
]);

function preflightProvider(cfg, deps = {}) {
  const provider = providerFor(cfg, 'implementation');
  const checked = [];
  for (const gate of GATES) {
    const probe = deps[gate.dep];
    if (typeof probe !== 'function') continue;
    checked.push(gate.dep);
    let satisfied = false;
    try { satisfied = probe(cfg) === true; }
    catch (e) {
      // A probe that throws has not proven anything. Treated exactly as a false answer,
      // with the reason carried into the remedy so the operator sees the real cause.
      return {
        ok: false,
        provider,
        missing: gate.dep,
        checked,
        remedy: `${gate.remedy(provider, cfg)} (the check itself failed: ${e && e.message ? e.message : e})`,
      };
    }
    if (!satisfied) {
      return { ok: false, provider, missing: gate.dep, checked, remedy: gate.remedy(provider, cfg) };
    }
  }
  if (typeof deps.sideEffect === 'function') deps.sideEffect();
  return { ok: true, provider, checked };
}

module.exports = {
  PROVIDERS,
  REASONING_EFFORTS,
  DEFAULT_PROVIDER,
  DEFAULT_REASONING_EFFORT,
  STAGES,
  CLAUDE_CREDENTIAL_ENV,
  CODEX_CREDENTIAL_ENV,
  CODEX_ENDPOINT,
  CLAUDE_ENDPOINT,
  isProvider,
  isReasoningEffort,
  providerFor,
  effortFor,
  credentialEnvFor,
  endpointFor,
  displayName,
  hostLaunch,
  normalizeOutput,
  preflightProvider,
};
