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
//   CODEX_LIVE_SMOKE=1 node scripts/codex-live-smoke.js --image <pinned-image> [--model <alias>]
//
// Authentication is ChatGPT-managed only: a saved host session is copied to a pipeline-owned
// cache, then that cache alone is mounted into the trusted task image. The operator's home
// and API-key environment never reach Docker.

const { runSync } = require('../runner/process');
const codexAuth0 = require('../runner/codex-auth');
const {
  CODEX_REQUIRED_EXEC_FLAGS, CREDENTIAL_NAMES, REASONING_EFFORTS,
  normalizeReasoningEffort, normalizeOutput,
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
    } else if (arg === '--image') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) return { error: '--image needs a value' };
      opts.image = value;
    } else if (arg === '-h' || arg === '--help') {
      opts.help = true;
    } else {
      return { error: `unknown option "${arg}"` };
    }
  }
  return opts;
}

function dockerEnv(env) {
  const clean = { ...env, MSYS_NO_PATHCONV: '1' };
  delete clean.CODEX_API_KEY; delete clean.CODEX_HOME; delete clean.CLAUDE_CODE_OAUTH_TOKEN;
  return clean;
}

function runChatgptContainerSmoke(options = {}) {
  const out = options.out || console.log; const run = options.run || runSync; const cache = options.authCache;
  if (!cache || !cache.mount || !cache.containerPath) throw new Error('missing private ChatGPT credential cache');
  const opts = { model: options.model || DEFAULT_MODEL, reasoningEffort: options.reasoningEffort || 'low' };
  out('Authentication: ChatGPT-managed Codex session in a private pipeline cache.');
  return run('docker', ['run', '--rm', '-v', cache.mount, '-e', 'CODEX_HOME=' + cache.containerPath, '-w', '/workspace', options.image, 'codex', ...smokeArgs(opts)], {
    input: PROMPT + '\n', timeoutMs: TIMEOUT_MS, label: 'codex live smoke', env: dockerEnv(options.env || process.env),
  });
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

async function main(argv, io = {}) {
  const out = io.out || console.log;
  const err = io.err || console.error;
  const env = io.env || process.env;
  const run = io.runSync || runSync;
  const opts = parseArgs(argv);
  if (opts.error) { err(`codex-live-smoke: ${opts.error}`); return 2; }
  if (opts.help) {
    out('usage: CODEX_LIVE_SMOKE=1 node scripts/codex-live-smoke.js --image <pinned-image> [--model <alias>]'
      + ' [--reasoning-effort minimal|low|medium|high]');
    return 0;
  }
  if (env.CODEX_LIVE_SMOKE !== '1') {
    out('SKIP codex live smoke — set CODEX_LIVE_SMOKE=1 to make one real, read-only call.');
    out(`     it would ask ${opts.model} to name itself; nothing else in the suite calls a model.`);
    return 0;
  }

  if (!opts.image) { err('codex-live-smoke: --image must name the pinned task image'); return 2; }
  const codexAuth = io.codexAuth || codexAuth0;
  const preflight = codexAuth.preflight({ mode: 'chatgpt', env, codexHome: env.CODEX_HOME });
  if (!preflight || !preflight.ok) {
    err('codex-live-smoke: ' + ((preflight && preflight.reason) || 'codex login/device authentication is required')); return 1;
  }
  out('Configured model: ' + opts.model + ' (reasoning effort ' + opts.reasoningEffort + ', sandbox read-only)');
  let cache; let result;
  try {
    cache = codexAuth.stageTaskCache({ cacheRoot: preflight.cacheRoot, taskId: 'smoke' });
    result = runChatgptContainerSmoke({ image: opts.image, authCache: cache, model: opts.model, reasoningEffort: opts.reasoningEffort, env, run, out, err });
  } catch (error) {
    err('codex-live-smoke: ' + (error && error.message ? error.message : error)); return 1;
  } finally { if (cache) await codexAuth.releaseTaskCache(cache); }
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

if (require.main === module) main(process.argv.slice(2)).then(process.exit);

module.exports = { main, parseArgs, smokeArgs, runChatgptContainerSmoke, DEFAULT_MODEL };
