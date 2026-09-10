#!/usr/bin/env node
// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// Read-only live Codex smoke test — DESIGN.md §6.5, acceptance criterion 7.
//
// Everything else that proves the Codex provider is deterministic and offline: fake
// executables, planted help text, planted JSONL. That is what a regression suite should
// be, and it is also exactly what cannot tell you whether the configured GPT model is a
// model this account can actually run today. This one helper answers that single
// question, against the real CLI, and nothing else:
//
//   * OPT-IN ONLY. It refuses unless CODEX_LIVE_SMOKE=1 is set, so no sweep, no CI
//     profile and no task container can spend an account's quota by accident.
//   * READ-ONLY. `--sandbox read-only` plus `--ephemeral`: the model cannot write a file,
//     cannot leave session state, and is asked for one word. This is deliberately NOT the
//     autonomous `--approve-for-me` shape the pipeline uses for real work.
//   * It DOCUMENTS the model. What it prints is the model the run actually reported
//     through the CLI's own JSONL, beside the model that was configured — the point of
//     the exercise is to catch the two disagreeing.
//
//   CODEX_LIVE_SMOKE=1 node scripts/codex-live-smoke.js [--model <alias>] [--effort <e>]
//
// Exit 0 = the configured model answered. 2 = usage/opt-in. 3 = the CLI or the model
// could not be reached (the message names which).
'use strict';
const path = require('path');
const { runSync, failureText } = require('../runner/process');
const provider = require('../runner/agent-provider');
const codexOutput = require('../pipeline/agent-output.js');

// The GPT model this repository is configured to use for Codex work. It is written down
// here — not discovered — so that a smoke run has something to disagree WITH: the report
// below prints the configured alias and the model id the live run reported, and a human
// reading it can see at a glance which model actually served the request.
const CONFIGURED_MODEL = 'gpt-5.6-terra';
const DEFAULT_EFFORT = 'low';           // the cheapest setting that still exercises the path
const PROMPT = 'Reply with exactly the word: ready. Do not use any tool.';
const TIMEOUT_MS = 120000;
const USAGE = 'usage: CODEX_LIVE_SMOKE=1 node scripts/codex-live-smoke.js [--model <alias>] [--effort minimal|low|medium|high]';

function parseArgs(argv) {
  const opts = { model: CONFIGURED_MODEL, effort: DEFAULT_EFFORT };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--model' || arg === '--effort') {
      const value = argv[++i];
      if (value === undefined || value.startsWith('--')) return { error: `${arg} needs a value` };
      opts[arg === '--model' ? 'model' : 'effort'] = value;
    } else if (arg === '-h' || arg === '--help') opts.help = true;
    else return { error: `unknown option "${arg}"` };
  }
  if (!provider.REASONING_EFFORTS.includes(opts.effort)) {
    return { error: `--effort must be one of ${provider.REASONING_EFFORTS.join(' | ')}` };
  }
  return opts;
}

// The read-only argv, built by the one adapter that builds every other launch: same model,
// reasoning effort and stdin prompt as real work, and deliberately differing in exactly one
// respect — `--sandbox read-only` in place of `--approve-for-me`. Nothing here may edit a
// workspace, and the shape cannot drift away from the launches it is meant to smoke-test.
function smokeArgs(model, effort) {
  return provider.codexReadOnlyArgs(model, effort);
}

function main(argv, io = {}, run = runSync) {
  const out = io.out || console.log;
  const err = io.err || console.error;
  const opts = parseArgs(argv);
  if (opts.help) { out(USAGE); return 0; }
  if (opts.error) { err(`codex-live-smoke: ${opts.error}`); err(USAGE); return 2; }
  if (process.env.CODEX_LIVE_SMOKE !== '1') {
    err('codex-live-smoke: refusing to spend a live model call without CODEX_LIVE_SMOKE=1.');
    err(USAGE);
    return 2;
  }
  // Host Codex may reuse saved ChatGPT CLI authentication, so an absent CODEX_API_KEY is
  // reported and not refused: only the CLI can say whether this host is signed in.
  if (!process.env[provider.CODEX_API_KEY_ENV]) {
    err(`codex-live-smoke: no ${provider.CODEX_API_KEY_ENV} in this environment — relying on saved \`codex login\` authentication.`);
  }
  out(`Configured GPT model: ${opts.model} (reasoning effort ${opts.effort}, read-only sandbox)`);
  const r = run('codex', smokeArgs(opts.model, opts.effort), {
    input: `${PROMPT}\n`,
    timeoutMs: TIMEOUT_MS,
    cwd: path.resolve(__dirname, '..'),
    label: 'read-only live codex smoke',
  });
  const raw = `${r.stdout || ''}\n${r.stderr || ''}`;
  const normalized = provider.normalizeOutput('codex', raw, opts.model);
  if (r.status !== 0 || !normalized) {
    err(`codex-live-smoke: no structured answer from the live CLI — ${failureText(r, 'codex exec failed')}`);
    return 3;
  }
  if (normalized.rateLimit) {
    err(`codex-live-smoke: the account is rate limited${normalized.rateLimit.resetAt ? ` until ${normalized.rateLimit.resetAt}` : ''}.`);
    err(`Evidence: ${normalized.rateLimit.evidence}`);
    return 3;
  }
  // What the live run actually reported, which is the whole point of running it.
  out(`Model reported by the live run: ${normalized.model}`);
  out(`Token usage: ${normalized.tokenUsage ? JSON.stringify(normalized.tokenUsage) : 'not reported'}`);
  out(`Final agent text: ${String(normalized.finalText || '').trim() || '(empty)'}`);
  if (normalized.model && normalized.model !== opts.model) {
    out(`NOTE: the configured alias '${opts.model}' resolved to '${normalized.model}'.`);
  }
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { main, parseArgs, smokeArgs, CONFIGURED_MODEL };
