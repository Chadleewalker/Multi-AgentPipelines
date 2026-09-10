#!/usr/bin/env node
// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// Read-only live Codex smoke test — DESIGN.md §4.3, §6.
//
// The one check in this repository that talks to a real model. Everything else about the
// Codex provider is proven by deterministic fake executables, which is the right default:
// a suite whose result depends on a vendor's availability is a suite that goes red for
// reasons nobody in this repo can fix. But a fake executable cannot answer the one
// question an operator actually has before switching a project over — "does this account,
// on this host, actually serve the GPT model the run config names?" — so that question
// gets its own opt-in helper and stays out of every automatic profile.
//
// OPT-IN, TWICE. It refuses unless CODEX_LIVE_SMOKE=1 is set explicitly, and it is not
// in `scripts/test-ci.sh`, `scripts/test-all.sh` or any suite roster. A sweep must never
// reach a live model by accident.
//
// READ-ONLY, and enforced by the CLI rather than by the prompt: `--sandbox read-only` is
// what makes this safe to run in a real checkout. A prompt asking a model to behave is
// not a control (hard rule 4); the sandbox flag is.
//
//   CODEX_LIVE_SMOKE=1 node scripts/codex-live-smoke.js [--config run.config.<project>.json]
//
// It prints the CONFIGURED model, the model Codex reports having resolved, and the token
// usage the turn reported — the actual answer to "which GPT model ran", recorded from
// structured JSONL rather than from the model's own prose.
'use strict';
const fs = require('fs');
const path = require('path');
const { loadConfig } = require('../runner/config');
const { runSync } = require('../runner/process');
const {
  CODEX_REQUIRED_EXEC_FLAGS, CODEX_API_KEY_VAR, normalizeOutput, providerFor,
} = require('../runner/agent-provider');

const EXIT_OK = 0;
const EXIT_USAGE = 2;
const EXIT_REFUSED = 3;
const EXIT_FAILED = 4;
const ROOT = path.resolve(__dirname, '..');
const USAGE = 'usage: CODEX_LIVE_SMOKE=1 node scripts/codex-live-smoke.js'
  + ' [--config run.config.<project>.json]';

// A prompt with no side effect to attempt and nothing to get wrong. The point of the run
// is the ENVELOPE — which model answered — not the answer.
const SMOKE_PROMPT = 'Reply with exactly: pipeline codex smoke ok';
// The documented reference model for this repository's Codex profile. The run config is
// the authority; this is only what the helper falls back to and what its own frozen
// fixture pins, so the file names one concrete GPT model rather than a placeholder.
const REFERENCE_MODEL = 'gpt-5.6-terra';

function parseArgs(argv) {
  const opts = { config: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--config') {
      const value = argv[++i];
      if (value === undefined || value.startsWith('--')) return { error: '--config needs a value' };
      opts.config = value;
    } else if (arg === '-h' || arg === '--help') opts.help = true;
    else return { error: `unknown argument "${arg}"` };
  }
  return opts;
}

// The configured model, from the run config when one is available and from the reference
// constant otherwise. Never from the environment: the point is to document what THIS
// PROJECT asked for, so an ambient variable must not be able to change the answer.
function configuredModel(configPath) {
  if (!configPath) return { model: REFERENCE_MODEL, source: 'built-in reference model' };
  const resolved = path.resolve(configPath);
  if (!fs.existsSync(resolved)) return { error: `run config not found: ${resolved}` };
  let cfg;
  try { cfg = loadConfig(resolved); } catch (e) { return { error: (e && e.message) || String(e) }; }
  if (providerFor(cfg, null) !== 'codex') {
    return { error: `${resolved} selects provider '${providerFor(cfg, null)}', not codex —`
      + ' set "provider": "codex" before smoking the Codex path' };
  }
  return { model: String(cfg.model || REFERENCE_MODEL), source: resolved, cfg };
}

// `codex exec` in its read-only, ephemeral, noninteractive form. It shares the pipeline's
// capability roster so this helper cannot pass against a CLI a real run would reject —
// but it does NOT use the run's launch argv: a run gets a workspace-write sandbox and
// this must not, so the sandbox flag is spelled out here on purpose.
function smokeArgs(model) {
  return [
    'exec',
    '--model', String(model),
    // Spelled out rather than inherited, because these two ARE this helper's posture:
    // `--sandbox read-only` is what makes it safe to run in a real checkout, and
    // `--ephemeral` is what stops a smoke run from leaving session state behind.
    '--sandbox', 'read-only',
    '--ephemeral',
    // Plus the rest of the pipeline's capability roster, asked for from its one source so
    // this helper cannot pass against a CLI that a real run would reject.
    ...CODEX_REQUIRED_EXEC_FLAGS.filter((flag) => flag !== '--ephemeral'),
    '--json',
    '-',
  ];
}

function main(argv, io = {}, seams = {}) {
  const out = io.out || console.log;
  const err = io.err || console.error;
  const env = seams.env || process.env;
  const opts = parseArgs(argv);
  if (opts.help) { out(USAGE); return EXIT_OK; }
  if (opts.error) { err(`codex-live-smoke: ${opts.error}`); err(USAGE); return EXIT_USAGE; }

  // Refused by default, and the refusal explains itself: this is the only thing here that
  // spends real tokens and depends on a vendor being up.
  if (String(env.CODEX_LIVE_SMOKE || '') !== '1') {
    err('codex-live-smoke: refused — this is the only live-model check in the repository and');
    err('  it is opt-in. Re-run with CODEX_LIVE_SMOKE=1 to allow one real read-only codex exec.');
    return EXIT_REFUSED;
  }

  const configured = configuredModel(opts.config);
  if (configured.error) { err(`codex-live-smoke: ${configured.error}`); return EXIT_USAGE; }

  out(`Configured model: ${configured.model}  (from ${configured.source})`);
  out('Mode: read-only sandbox, ephemeral state, no user config, no rule files.');

  const run = seams.runSync || runSync;
  const result = run('codex', smokeArgs(configured.model), {
    cfg: configured.cfg || null,
    kind: 'lifecycle',
    input: `${SMOKE_PROMPT}\n`,
    label: 'live codex exec smoke',
    // Host Codex may reuse a saved ChatGPT CLI login, so an absent key is not an error
    // here — unlike a container, which always requires the variable.
    env: { ...env },
  });

  const raw = `${result.stdout || ''}${result.stderr || ''}`;
  const normalized = normalizeOutput('codex', raw, configured.model);
  if (!normalized) {
    err(`codex-live-smoke: codex produced no structured JSONL outcome (status ${result.status === null ? 'unavailable' : result.status}).`);
    if (!String(env[CODEX_API_KEY_VAR] || '').trim()) {
      err(`  Neither ${CODEX_API_KEY_VAR} nor a usable saved login was found — run \`codex login\` or export ${CODEX_API_KEY_VAR}.`);
    }
    if (raw.trim()) err(raw.trim().slice(-2000));
    return EXIT_FAILED;
  }

  // The documented answer, from the stream rather than from the reply text.
  out(`Resolved model:   ${normalized.model || '(codex reported none)'}`);
  if (normalized.tokenUsage) {
    out(`Token usage:      input ${normalized.tokenUsage.input ?? '-'}, output ${normalized.tokenUsage.output ?? '-'}`);
  }
  if (normalized.rateLimit) {
    err(`codex-live-smoke: rate limited — resets at ${normalized.rateLimit.resetAt || 'an unstated time'}`);
    err(`  evidence: ${normalized.rateLimit.evidence}`);
    return EXIT_FAILED;
  }
  if (normalized.finalText) out(`Agent said:       ${normalized.finalText.trim().slice(0, 200)}`);
  if (result.status !== 0) {
    err(`codex-live-smoke: codex exited ${result.status === null ? 'without a status' : result.status}`);
    return EXIT_FAILED;
  }
  out('Outcome: live codex exec smoke passed; the model above is what this account served.');
  return EXIT_OK;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = {
  main, parseArgs, smokeArgs, configuredModel, SMOKE_PROMPT, REFERENCE_MODEL, ROOT,
  EXIT_USAGE, EXIT_REFUSED, EXIT_FAILED,
};
