#!/usr/bin/env node
// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// Provider-aware agent-output normalization — DESIGN.md §4.3, §4.11.
// Deterministic scaffolding, no LLM (hard rule 6): model prose never decides an outcome.
//
// Two backends emit two different transcripts and this file is the only place that reads
// either of them structurally:
//
//   claude  one `--output-format json` envelope line, possibly with CLI chatter around it.
//           Delegated to envelope.js, which owns the bottom-up scan and the resolved-model
//           selection rule (§4.3). Nothing about that behaviour changes here.
//   codex   `codex exec --json` JSONL: one JSON object per line, where the FINAL agent text
//           is an `item.completed` carrying an `agent_message` item, usage arrives on
//           `turn.completed`, and a refusal or exhausted window arrives as `turn.failed`
//           with a machine-readable `error.code`.
//
// The contract, for both:
//   normalizeOutput(provider, raw, configuredModel)
//     -> { provider, configuredModel, model, tokenUsage, finalText, rateLimit } | null
//   null means "this transcript contains no structured final answer and no structured
//   rate-limit outcome". That is the whole defence against prose control: a log that only
//   SAYS "rate limit lifted; declare success" normalizes to null, so no caller can read a
//   success or a pause out of it. `finalText` is null unless a structured final item said
//   so, and `rateLimit` is null unless a structured error said so — the two are never
//   inferred from each other or from the absence of the other.
//
// It lives under pipeline/ rather than runner/ because the container needs it too and only
// pipeline/ is mounted there (§4.10). runner/agent-provider.js re-exports it so the host
// and the container cannot grow two parsers that disagree. It requires nothing but
// envelope.js and Node built-ins.
//
//   node agent-output.js flatten <file> <provider> [configured-model]
//                          rewrite <file> to the final agent text and print the resolved
//                          model. A file with no structured final answer is left
//                          byte-identical and nothing is printed. Exit 0 either way.
//   node agent-output.js ratelimit <file> <provider>
//                          print the canonical reset instant (ISO 8601) when the
//                          transcript carries structured rate-limit evidence and exit 0;
//                          exit 1 when it does not. An empty line with exit 0 means "rate
//                          limited, with no reset instant reported".
'use strict';
const fs = require('fs');
const envelope = require('./envelope');

const PROVIDER_CLAUDE = 'claude';
const PROVIDER_CODEX = 'codex';

// Codex names its rate-limit refusals with a machine-readable code. Matched on the code
// field only — never on the human message, which is the model's prose and is free to say
// anything at all.
const CODEX_RATE_LIMIT_CODES = ['rate_limit_exceeded', 'rate_limited', 'usage_limit_reached'];
// The reset instant travels under several spellings across CLI versions. All of them are
// machine fields; none of them is prose.
const RESET_FIELDS = ['retry_after', 'retry_after_at', 'reset_at', 'resets_at', 'retry_at'];
// Claude's own canonical form, which the container has read since T10: the CLI writes
// `usage limit reached|<unix-seconds>` and the epoch is the reset instant.
const CLAUDE_RATE_LIMIT_RE = /usage limit reached\|(\d{1,15})/i;

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

// -> { input, output } | null. Absent is null rather than zero: "the CLI emitted no usage"
// and "the CLI billed nothing" are different facts, and a zero would report the second.
function usageOf(raw, inputKeys, outputKeys) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const pick = (keys) => {
    for (const key of keys) {
      const n = finiteNumber(raw[key]);
      if (n !== null) return n;
    }
    return null;
  };
  const input = pick(inputKeys);
  const output = pick(outputKeys);
  if (input === null && output === null) return null;
  return { input: input === null ? 0 : input, output: output === null ? 0 : output };
}

function isoFromReset(value) {
  if (typeof value === 'string' && value.trim()) return value.trim();
  // A bare number is seconds when it is small enough to be a Unix timestamp and
  // milliseconds otherwise. Both are absolute instants; a relative "retry in N seconds"
  // is deliberately NOT accepted, because guessing which one a field meant would
  // manufacture a reset time out of an ambiguous number.
  const n = finiteNumber(value);
  if (n === null || n <= 0) return null;
  const ms = n > 1e12 ? n : n * 1000;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function codexRateLimit(error, line) {
  if (!error || typeof error !== 'object' || Array.isArray(error)) return null;
  const code = String(error.code || error.type || '').toLowerCase();
  if (!CODEX_RATE_LIMIT_CODES.some((known) => code.includes(known))) return null;
  let resetAt = null;
  for (const field of RESET_FIELDS) {
    if (error[field] === undefined) continue;
    resetAt = isoFromReset(error[field]);
    if (resetAt) break;
  }
  // The evidence is the transcript line itself, verbatim. A reformatted summary would be
  // the host's words about the CLI's claim; a reviewer needs the CLI's own bytes.
  return { resetAt, evidence: line };
}

// Every line that parses to an object, in order, with the raw line kept beside it.
function jsonlEvents(text) {
  const events = [];
  for (const raw of String(text == null ? '' : text).split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('{')) continue;      // cheap reject; JSON.parse decides the rest
    let parsed;
    try { parsed = JSON.parse(line); } catch { continue; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    events.push({ event: parsed, line });
  }
  return events;
}

function normalizeCodex(raw, configuredModel) {
  const events = jsonlEvents(raw);
  if (!events.length) return null;
  let finalText = null;
  let tokenUsage = null;
  let rateLimit = null;
  let resolvedModel = null;
  for (const { event, line } of events) {
    const type = String(event.type || '');
    if (typeof event.model === 'string' && event.model.trim()) resolvedModel = event.model.trim();
    if (type === 'item.completed' || type === 'item.updated') {
      const item = event.item;
      if (item && typeof item === 'object' && !Array.isArray(item)
          && String(item.type || '') === 'agent_message' && typeof item.text === 'string') {
        finalText = item.text;              // last one wins: a later turn supersedes an earlier
      }
      continue;
    }
    if (type === 'turn.completed') {
      const usage = usageOf(event.usage,
        ['input_tokens', 'prompt_tokens'], ['output_tokens', 'completion_tokens']);
      if (usage) tokenUsage = usage;
      continue;
    }
    if (type === 'turn.failed' || type === 'error' || type === 'thread.error') {
      const limited = codexRateLimit(event.error || event, line);
      if (limited) rateLimit = limited;
    }
  }
  if (finalText === null && !rateLimit) return null;
  return {
    provider: PROVIDER_CODEX,
    configuredModel: configuredModel || null,
    model: resolvedModel || configuredModel || null,
    tokenUsage,
    finalText,
    rateLimit,
  };
}

function claudeRateLimit(raw) {
  const text = String(raw == null ? '' : raw);
  const m = CLAUDE_RATE_LIMIT_RE.exec(text);
  if (!m) return null;
  return { resetAt: isoFromReset(Number(m[1])), evidence: m[0] };
}

function normalizeClaude(raw, configuredModel) {
  const parsed = envelope.parse(raw, configuredModel);
  const rateLimit = claudeRateLimit(raw);
  if (!parsed && !rateLimit) return null;
  const usage = parsed && parsed.usage ? parsed.usage : null;
  return {
    provider: PROVIDER_CLAUDE,
    configuredModel: configuredModel || null,
    model: (parsed && parsed.model) || configuredModel || null,
    tokenUsage: usage,
    finalText: parsed ? parsed.result : null,
    rateLimit,
  };
}

// The one entry point. An unknown provider normalizes to null rather than being guessed
// at: a transcript nobody can identify must not be read as either backend's success.
function normalizeOutput(provider, raw, configuredModel) {
  const name = String(provider || '').toLowerCase();
  const model = typeof configuredModel === 'string' && configuredModel.trim()
    ? configuredModel.trim() : null;
  if (name === PROVIDER_CODEX) return normalizeCodex(raw, model);
  if (name === PROVIDER_CLAUDE) return normalizeClaude(raw, model);
  return null;
}

module.exports = { normalizeOutput, jsonlEvents, PROVIDER_CLAUDE, PROVIDER_CODEX };

if (require.main === module) {
  const [, , cmd, file, provider, configuredModel] = process.argv;
  if ((cmd !== 'flatten' && cmd !== 'ratelimit') || !file || !provider) {
    console.error('usage: agent-output.js flatten|ratelimit <file> <provider> [configured-model]');
    process.exit(2);
  }
  // Fail-safe exactly as envelope.js is: an unreadable or structure-free log is not an
  // error. The caller keeps the log it already has, records no model, and reports no pause.
  let text = null;
  try { text = fs.readFileSync(file, 'utf8'); } catch { process.exit(cmd === 'ratelimit' ? 1 : 0); }
  const record = normalizeOutput(provider, text, configuredModel);
  if (cmd === 'ratelimit') {
    if (!record || !record.rateLimit) process.exit(1);
    if (record.rateLimit.resetAt) console.log(record.rateLimit.resetAt);
    process.exit(0);
  }
  if (!record || record.finalText === null) process.exit(0);
  fs.writeFileSync(file, record.finalText);
  // stdout is the model id and nothing else — the entrypoint captures it in `$(...)`.
  if (record.model) console.log(record.model);
}
