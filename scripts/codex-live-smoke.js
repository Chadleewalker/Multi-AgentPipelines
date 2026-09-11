#!/usr/bin/env node
// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0
'use strict';

// Read-only live Codex smoke test — DESIGN.md §6.8.
//
// Everything else that covers the Codex provider is deterministic and offline: fake
// executables, planted `codex exec --help` text, planted JSONL. That proves the pipeline's
// side of the contract and nothing about the account, the network or the model actually
// answering. This helper is the one place a real call happens, and it exists to DOCUMENT
// the configured GPT model rather than to gate anything.
//
// It is OPT-IN and never runs in a sweep: without CODEX_LIVE_SMOKE=1 it prints why it
// skipped and exits 0. It is also read-only by construction —
//   --sandbox read-only   the model cannot write a file or run a mutating command
//   --ephemeral           no session or rollout state is persisted anywhere
//   --ignore-user-config  the host user's ~/.codex settings cannot alter this probe
//   --ignore-rules        nor can any project rules file
//   --strict-config       an unknown -c key is an error, not a silent no-op
// so it can be pointed at a real repository checkout without changing a byte of it.
//
//   CODEX_LIVE_SMOKE=1 node scripts/codex-live-smoke.js [--model <alias>]
//
// Authentication: on the HOST, Codex may reuse a saved ChatGPT CLI session (`codex login`)
// and no key is needed. Inside a task container there is no saved session, so CODEX_API_KEY
// is required there — this helper accepts either and says which one it used.

const path = require('path');
const { runSync } = require('../runner/process');
const {
  CODEX_REQUIRED_EXEC_FLAGS, CREDENTIAL_NAMES, REASONING_EFFORTS,
  normalizeReasoningEffort, missingCodexCapabilities, normalizeOutput,
} = require('../runner/agent-provider');

// The model this pipeline is configured to reach when a run selects Codex. Written down
// here because the point of the smoke test is to report the model that actually answered
// next to the one that was asked for.
const DEFAULT_MODEL = 'gpt-5.6-terra';
const PROMPT = 'Reply with exactly one short line naming the model answering this request.';
const TIMEOUT_MS = 120000;

function parseArgs(argv) {
  const opts = { model: DEFAULT_MODEL, reasoningEffort: 'low' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--model') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) return { error: '--model needs a value' };
      opts.model = value;
    } else if (arg === '--reasoning-effort') {
      const value = argv[++i];
      if (!value || !REASONING_EFFORTS.includes(value)) {
        return { error: `--reasoning-effort must be one of ${REASONING_EFFORTS.join(' | ')}` };
      }
      opts.reasoningEffort = value;
    } else if (arg === '-h' || arg === '--help') {
      opts.help = true;
    } else {
      return { error: `unknown option "${arg}"` };
    }
  }
  return opts;
}

// The read-only argv. It shares the pipeline's required capability roster so a future
// change to that roster reaches this probe too, and adds the posture flags that make this
// helper safe to point at a live checkout. `--sandbox read-only` is this helper's own
// posture and is deliberately NOT part of the roster an implementation run uses.
function smokeArgs(opts) {
  return [
    'exec',
    '--model', opts.model,
    '-c', `model_reasoning_effort="${normalizeReasoningEffort(opts.reasoningEffort)}"`,
    '-c', 'shell_environment_policy.ignore_default_excludes=false',
    '-c', `shell_environment_policy.filters.${CREDENTIAL_NAMES.codex}="exclude"`,
    '--sandbox', 'read-only',
    ...CODEX_REQUIRED_EXEC_FLAGS.filter((flag) => flag !== '--approve-for-me'),
    '--json', '-',
  ];
}

function main(argv, io = {}) {
  const out = io.out || console.log;
  const err = io.err || console.error;
  const env = io.env || process.env;
  const run = io.runSync || runSync;
  const opts = parseArgs(argv);
  if (opts.error) { err(`codex-live-smoke: ${opts.error}`); return 2; }
  if (opts.help) {
    out('usage: CODEX_LIVE_SMOKE=1 node scripts/codex-live-smoke.js [--model <alias>]'
      + ' [--reasoning-effort minimal|low|medium|high]');
    return 0;
  }
  if (env.CODEX_LIVE_SMOKE !== '1') {
    out('SKIP codex live smoke — set CODEX_LIVE_SMOKE=1 to make one real, read-only call.');
    out(`     it would ask ${opts.model} to name itself; nothing else in the suite calls a model.`);
    return 0;
  }

  const capabilities = run('codex', ['exec', '--help'], {
    label: 'codex exec capability probe', timeoutMs: TIMEOUT_MS,
  });
  if (capabilities.status !== 0) {
    err('codex-live-smoke: no usable codex executable — install the pinned Codex CLI and put'
      + ' codex on this host\'s PATH.');
    return 1;
  }
  const missing = missingCodexCapabilities(`${capabilities.stdout || ''}${capabilities.stderr || ''}`);
  if (missing.length) {
    err(`codex-live-smoke: the codex on PATH is missing ${missing.join(', ')} — upgrade to the pinned CLI.`);
    return 1;
  }

  const authenticated = typeof env[CREDENTIAL_NAMES.codex] === 'string'
    && env[CREDENTIAL_NAMES.codex].trim() !== '';
  out(`Authentication: ${authenticated
    ? `${CREDENTIAL_NAMES.codex} from the environment`
    : `no ${CREDENTIAL_NAMES.codex} — relying on a saved ChatGPT CLI session (codex login)`}`);
  out(`Configured model: ${opts.model} (reasoning effort ${opts.reasoningEffort}, sandbox read-only)`);

  const result = run('codex', smokeArgs(opts), {
    cwd: path.resolve(__dirname, '..'),
    input: `${PROMPT}\n`,
    timeoutMs: TIMEOUT_MS,
    label: 'codex live smoke',
    env: { ...env },
  });
  const raw = `${result.stdout || ''}\n${result.stderr || ''}`;
  const normalized = normalizeOutput('codex', raw, opts.model);
  if (!normalized) {
    err(`codex-live-smoke: no structured Codex result (exit ${result.status}).`);
    if (result.stderr) err(String(result.stderr).trimEnd());
    return 1;
  }
  if (normalized.rateLimit) {
    err(`codex-live-smoke: rate limited${normalized.rateLimit.resetAt
      ? ` until ${normalized.rateLimit.resetAt}` : ''} — ${normalized.rateLimit.evidence}`);
    return 1;
  }
  out(`Model that answered: ${normalized.model}`);
  if (normalized.tokenUsage) {
    out(`Token usage: input ${normalized.tokenUsage.input}, output ${normalized.tokenUsage.output}`);
  }
  out(`Final agent text: ${String(normalized.finalText || '').trim()}`);
  out(result.status === 0 ? 'PASS codex live smoke' : `FAIL codex live smoke (exit ${result.status})`);
  return result.status === 0 ? 0 : 1;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { main, parseArgs, smokeArgs, runChatgptContainerSmoke, DEFAULT_MODEL };

function runChatgptContainerSmoke(opts) {
  const run = opts.run || runSync; const env = { ...(opts.env || process.env) };
  delete env.CODEX_API_KEY; delete env.CODEX_HOME;
  const args = ["run", "--rm", "-v", opts.authCache.mount, "-e", "CODEX_HOME=/root/.codex", opts.image, "codex", ...smokeArgs({ model: opts.model || DEFAULT_MODEL, reasoningEffort: opts.reasoningEffort || "low" })];
  (opts.out || console.log)("Authentication: ChatGPT managed session");
  return run("docker", args, { env, label: "Codex ChatGPT live smoke" });
}

async function liveMain(argv, io = {}) {
  const out = io.out || console.log; const err = io.err || console.error; const env = io.env || process.env; const run = io.runSync || runSync;
  if (env.CODEX_LIVE_SMOKE !== "1") { out("SKIP codex live smoke — set CODEX_LIVE_SMOKE=1 to make one real, read-only call."); return 0; }
  const opts = parseArgs(argv.filter((v, i, a) => v !== "--image" && a[i - 1] !== "--image"));
  const imageAt = argv.indexOf("--image"); const image = imageAt >= 0 ? argv[imageAt + 1] : null;
  if (opts.error || !image) { err(`codex-live-smoke: ${opts.error || "--image needs a value"}`); return 2; }
  const auth = io.codexAuth || require("../runner/codex-auth"); const cacheRoot = env.PIPELINE_CODEX_CACHE || path.resolve("pipeline-codex-chatgpt");
  const pre = await Promise.resolve(auth.preflight({ mode: "chatgpt", codexHome: env.CODEX_HOME, cacheRoot })); if (!pre || !pre.ok) { err(`codex-live-smoke: ${(pre && pre.reason) || "ChatGPT authentication unavailable"}`); return 1; }
  const handle = await Promise.resolve(auth.stageTaskCache({ cacheRoot: pre.cacheRoot, taskId: "smoke", wait: true }));
  try {
    const childEnv = { ...env }; delete childEnv.CODEX_API_KEY; delete childEnv.CODEX_HOME;
    const proxy = env.PIPELINE_PROXY_URL || `http://${env.PIPELINE_PROXY || "pipeline-proxy"}:${env.PIPELINE_PROXY_PORT || "3128"}`;
    const result = run("docker", ["run", "--rm", "--network", env.PIPELINE_NET || "pipeline-net", "-v", handle.mount, "-e", "CODEX_HOME=/root/.codex", "-e", `HTTPS_PROXY=${proxy}`, "-e", `HTTP_PROXY=${proxy}`, "-e", "NO_PROXY=localhost,127.0.0.1", image, "codex", ...smokeArgs(opts)], { env: childEnv, input: `${PROMPT}\n`, label: "Codex ChatGPT live smoke" });
    const normalized = normalizeOutput("codex", `${result.stdout || ""}\n${result.stderr || ""}`, opts.model); if (!normalized || result.status !== 0) { err("codex-live-smoke: no structured Codex result."); return 1; }
    out("Authentication: ChatGPT managed session"); out(`Model that answered: ${normalized.model}`); out("PASS codex live smoke"); return 0;
  } finally { await Promise.resolve(auth.releaseTaskCache(handle)); }
}
module.exports = { main: liveMain, parseArgs, smokeArgs, runChatgptContainerSmoke, DEFAULT_MODEL };
