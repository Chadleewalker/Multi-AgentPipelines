#!/usr/bin/env node
// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// Read-only live Codex smoke test — the one check in this repository that talks to a real
// model (change-log row `repo-45g`).
//
// EVERY other Codex check is deterministic: fake executables, planted JSONL, a fixed argv.
// That proves what we send and what we do with what comes back, and it cannot prove that
// the configured GPT model exists, answers, and is the model the account actually serves.
// This helper does exactly that and nothing else, so the deterministic suites stay
// deterministic and this one stays explicitly opt-in.
//
//   CODEX_LIVE_SMOKE=1 node scripts/codex-live-smoke.js [--model <alias>] [--config <path>]
//
// Without CODEX_LIVE_SMOKE=1 it refuses and exits 0: a live network call must never happen
// as a side effect of a sweep. `bash scripts/test-ci.sh` therefore never reaches the model,
// and nothing in the mandatory profile depends on a network, an account or a quota.
//
// Read-only means read-only, in three independent ways:
//   --sandbox read-only         the CLI is told it may not write, so a model that decides
//                               to be helpful cannot touch the checkout it is run in;
//   --ephemeral                 no session state is left behind;
//   --ignore-user-config
//   --ignore-rules              the operator's own Codex configuration and rules files
//                               cannot turn any of that off.
// The prompt asks the model to name itself. The point of the run is the model id, which is
// printed as evidence — a documented answer from the real endpoint rather than a claim in
// a design document.
'use strict';
const fs = require('fs');
const path = require('path');
const { runSync, failureText } = require('../runner/process');
const {
  CODEX_CREDENTIAL_ENV, CODEX_ENDPOINT, effortFor, normalizeOutput,
} = require('../runner/agent-provider');

const ROOT = path.resolve(__dirname, '..');
// The configured GPT model this repository selects for its Codex stages. It is the value
// carried by run.config.example.json and by the acceptance fixtures, and the smoke run
// documents whether the account actually serves it.
const CONFIGURED_MODEL = 'gpt-5.6-terra';
const SENTINEL = 'CODEX_LIVE_SMOKE';
const TIMEOUT_MS = 120000;
const PROMPT = 'Reply with one short line naming the exact model id you are running as.'
  + ' Do not read, write, or run anything.';

function parseArgs(argv) {
  const opts = { model: null, config: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--model' || arg === '--config') {
      const value = argv[++i];
      if (value === undefined || value.startsWith('--')) return { error: `${arg} needs a value` };
      opts[arg === '--model' ? 'model' : 'config'] = value;
    } else if (arg === '-h' || arg === '--help') opts.help = true;
    else return { error: `unknown argument "${arg}"` };
  }
  return opts;
}

// The model comes from the run config when one is named, so the smoke test documents what
// a real run would use rather than what this file happens to say. CONFIGURED_MODEL is the
// fallback and the recorded default.
function selectedModel(opts) {
  if (opts.model) return { model: opts.model, source: '--model' };
  if (!opts.config) return { model: CONFIGURED_MODEL, source: 'this helper\'s recorded default' };
  try {
    const raw = JSON.parse(fs.readFileSync(path.resolve(opts.config), 'utf8'));
    const named = String(raw.testAuthorModel || raw.model || '').trim();
    if (named) return { model: named, source: path.resolve(opts.config), cfg: raw };
  } catch (e) {
    return { model: CONFIGURED_MODEL, source: `unreadable config (${e.message}); recorded default`, };
  }
  return { model: CONFIGURED_MODEL, source: `${path.resolve(opts.config)} names no model; recorded default` };
}

function smokeArgs(model, effort) {
  return [
    'exec',
    '--model', model,
    '-c', `model_reasoning_effort="${effort}"`,
    '-c', 'shell_environment_policy.ignore_default_excludes=false',
    '-c', `shell_environment_policy.filters.${CODEX_CREDENTIAL_ENV}="exclude"`,
    '--sandbox', 'read-only',
    '--ephemeral',
    '--ignore-user-config',
    '--ignore-rules',
    '--strict-config',
    '--json',
    '-',
  ];
}

function main(argv, io = {}, run = runSync) {
  const out = io.out || console.log;
  const err = io.err || console.error;
  const env = io.env || process.env;
  const opts = parseArgs(argv);
  if (opts.help) {
    out(`usage: ${SENTINEL}=1 node scripts/codex-live-smoke.js [--model <alias>] [--config <path>]`);
    return 0;
  }
  if (opts.error) { err(`codex-live-smoke: ${opts.error}`); return 2; }
  // Opt-in, and exit 0 when it was not taken: a skipped live check is not a failure, and
  // making it one would put a network, an account and a quota inside every sweep.
  if (env[SENTINEL] !== '1') {
    out(`codex-live-smoke: skipped — set ${SENTINEL}=1 to make one read-only live`
      + ` \`codex exec\` call to ${CODEX_ENDPOINT}. Nothing was sent.`);
    return 0;
  }
  const chosen = selectedModel(opts);
  const effort = effortFor(chosen.cfg || {}, 'test-author');
  out(`codex-live-smoke: configured GPT model ${chosen.model} (from ${chosen.source}),`
    + ` reasoning effort ${effort}, read-only sandbox, ephemeral state.`);
  const result = run(env.PIPELINE_CODEX_SMOKE_CMD || 'codex', smokeArgs(chosen.model, effort), {
    cwd: ROOT,
    input: `${PROMPT}\n`,
    timeoutMs: TIMEOUT_MS,
    label: 'Codex live smoke test',
    // The credential travels in this process's environment and never in argv (§6).
    env: { ...env },
  });
  if (result.status !== 0) {
    err(`codex-live-smoke: FAILED — ${failureText(result, 'codex exec failed')}`);
    err(`codex-live-smoke: the configured model ${chosen.model} was not confirmed.`);
    return 1;
  }
  const record = normalizeOutput('codex', result.stdout, chosen.model);
  if (!record || record.finalText === null) {
    err('codex-live-smoke: FAILED — the transcript carried no structured final answer,'
      + ' so nothing about the model is documented. Raw transcript follows.');
    err(String(result.stdout || '').trimEnd());
    return 1;
  }
  out(`codex-live-smoke: configured model ${record.configuredModel}; transcript reported`
    + ` model ${record.model || 'none'}`
    + `${record.tokenUsage ? `; usage ${record.tokenUsage.input} in / ${record.tokenUsage.output} out` : ''}`);
  out(`codex-live-smoke: model said: ${String(record.finalText).trim().split('\n')[0]}`);
  out('codex-live-smoke: PASSED — one read-only live call, nothing written.');
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { main, parseArgs, selectedModel, smokeArgs, CONFIGURED_MODEL, SENTINEL };
