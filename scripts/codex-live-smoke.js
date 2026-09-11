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
const codexAuthDefault = require('../runner/codex-auth');
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
  const opts = { model: DEFAULT_MODEL, reasoningEffort: 'low', image: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--image') {
      const value = argv[++i]; if (!value || value.startsWith('--')) return { error: '--image needs a value' }; opts.image = value;
    } else if (arg === '--model') {
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

function runChatgptContainerSmoke(opts) {
  const run = opts.run || runSync; const env = { ...(opts.env || {}) };
  delete env.CODEX_API_KEY; delete env.OPENAI_API_KEY; delete env.CODEX_HOME;
  const args = ['run', '--rm', '--network', env.PIPELINE_NET, '-v', opts.authCache.mount,
    '-w', '/workspace', '-e', 'CODEX_HOME=/root/.codex', '-e', 'HTTPS_PROXY=' + env.PIPELINE_PROXY_URL,
    '-e', 'HTTP_PROXY=' + env.PIPELINE_PROXY_URL, '-e', 'NO_PROXY=localhost,127.0.0.1', opts.image,
    'codex', ...smokeArgs({ model: opts.model, reasoningEffort: opts.reasoningEffort })];
  if (opts.out) opts.out("Authentication: ChatGPT managed session");
  const result = run('docker', args, { env, input: PROMPT + '\n', timeoutMs: TIMEOUT_MS, label: 'ChatGPT pinned-image live smoke' });
  const normalized = normalizeOutput('codex', String(result.stdout || '') + '\n' + String(result.stderr || ''), opts.model);
  if (!normalized || result.status !== 0) return { ok: false, result, normalized };
  return { ok: true, result, normalized };
}
async function main(argv, io = {}) {
  const out = io.out || console.log; const err = io.err || console.error; const env = io.env || process.env;
  const opts = parseArgs(argv); if (opts.error) { err('codex-live-smoke: ' + opts.error); return 2; }
  if (opts.help) { out('usage: CODEX_LIVE_SMOKE=1 node scripts/codex-live-smoke.js --image <pinned-image> [--model <alias>]'); return 0; }
  if (env.CODEX_LIVE_SMOKE !== '1') { out('SKIP codex live smoke — set CODEX_LIVE_SMOKE=1 to make one real, read-only call.'); return 0; }
  if (!opts.image) { err('codex-live-smoke: --image is required for the pinned task image'); return 2; }
  const auth = io.codexAuth || codexAuthDefault;
  const pre = await Promise.resolve(auth.preflight({ mode: 'chatgpt', codexHome: env.CODEX_HOME, cacheRoot: env.PIPELINE_CODEX_CACHE }));
  if (!pre.ok) { err('codex-live-smoke: ' + pre.reason); return 1; }
  let handle;
  try {
    handle = await Promise.resolve(auth.stageTaskCache({ cacheRoot: pre.cacheRoot, taskId: 'smoke', wait: true }));
    out('Authentication: ChatGPT managed session (private serialized cache)');
    const smoke = runChatgptContainerSmoke({ image: opts.image, authCache: handle, model: opts.model, reasoningEffort: opts.reasoningEffort, env, run: io.runSync || runSync });
    if (!smoke.ok) { err('codex-live-smoke: no structured Codex result (exit ' + smoke.result.status + ').'); return 1; }
    out('Model that answered: ' + smoke.normalized.model); out('PASS codex live smoke'); return 0;
  } finally { if (handle) await Promise.resolve(auth.releaseTaskCache(handle)); }
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { main, parseArgs, smokeArgs, runChatgptContainerSmoke, DEFAULT_MODEL };
