#!/usr/bin/env node
// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// Codex JSONL reader — the Codex twin of pipeline/envelope.js (DESIGN.md §4.3, §4.11).
// Deterministic scaffolding, no LLM (hard rule 6): the outcome is read from the CLI's
// own structured events, never from anything the model wrote in prose.
//
// `codex exec --json` emits ONE JSON object PER LINE (thread.started, turn.started,
// item.completed, turn.completed, turn.failed), interleaved with whatever the CLI prints
// around them. So the rule is the same as envelope.js's: parse line by line, ignore every
// line that is not a JSON object, and take the facts only from recognised event types.
// A log that carries no such event yields null — the caller keeps what it already had.
//
//   node agent-output.js flatten <file> [alias]   rewrite <file> to the final agent text
//                                                 and print the resolved model id; a file
//                                                 with no final text is left byte-identical
//                                                 and nothing is printed. Exit 0 both ways.
//   node agent-output.js ratelimit <file>         print the canonical rate-limit reset
//                                                 instant (ISO 8601) when the run ended in
//                                                 one; print nothing otherwise. Exit 0.
'use strict';
const fs = require('fs');

// Every event that can carry the final assistant text. `item.completed` is the current
// shape; the aliases cost nothing and keep one CLI rename from silently emptying a PR body.
const MESSAGE_ITEM_TYPES = ['agent_message', 'assistant_message'];
const RATE_LIMIT_RE = /rate.?limit|usage.?limit|too.?many.?requests/i;

function events(text) {
  const out = [];
  for (const raw of String(text == null ? '' : text).split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('{')) continue;      // cheap reject; JSON.parse decides the rest
    let parsed;
    try { parsed = JSON.parse(line); } catch { continue; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    out.push({ line, event: parsed });
  }
  return out;
}

function numberOr(value, fallback = null) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

// The CLI has renamed these fields before. Read both spellings rather than recording a
// usage block of nulls, which reads in the manifest exactly like "the model was free".
function usageOf(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const input = numberOr(raw.input_tokens, numberOr(raw.inputTokens, numberOr(raw.input)));
  const output = numberOr(raw.output_tokens, numberOr(raw.outputTokens, numberOr(raw.output)));
  const cachedInput = numberOr(raw.cached_input_tokens, numberOr(raw.cachedInputTokens));
  if (input === null && output === null) return null;
  const usage = { input, output };
  if (cachedInput !== null) usage.cachedInput = cachedInput;
  const total = numberOr(raw.total_tokens, numberOr(raw.totalTokens));
  usage.total = total !== null ? total : (input || 0) + (output || 0);
  return usage;
}

function errorOf(event) {
  const raw = event && event.error;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw === 'string') return { message: raw };
  return null;
}

// A reset instant is only ever taken from a field the CLI put there. A bare number is a
// delay in seconds (the HTTP Retry-After convention); anything unparseable yields null,
// because a manufactured instant is worse than none — the runner would park until it.
function resetInstant(error, now) {
  const candidates = [error.retry_after, error.retryAfter, error.reset_at, error.resetAt,
    error.retry_after_seconds, error.resets_at];
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim()) {
      const parsed = Date.parse(value);
      return Number.isNaN(parsed) ? null : value.trim();
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      // Seconds of delay, or (for a large value) a Unix epoch in seconds.
      const ms = value > 1e9 ? value * 1000 : now + value * 1000;
      return new Date(ms).toISOString();
    }
  }
  return null;
}

function rateLimitOf(record, now) {
  const error = errorOf(record.event);
  if (!error) return null;
  const code = String(error.code || error.type || '');
  const message = String(error.message || '');
  if (!RATE_LIMIT_RE.test(code) && !RATE_LIMIT_RE.test(message)) return null;
  // The evidence is the CLI's own line, verbatim: the canonical artifact a human reads
  // when asking why a task parked, and the only thing a prose-writing model cannot forge.
  return { resetAt: resetInstant(error, now), evidence: record.line };
}

// -> { finalText, model, tokenUsage, rateLimit } | null
// null means "this log carries no structured final answer and no rate-limit outcome",
// which is exactly the case where a caller must not overwrite what it already has.
function parse(text, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  let finalText = null;
  let model = null;
  let tokenUsage = null;
  let rateLimit = null;
  for (const record of events(text)) {
    const event = record.event;
    if (typeof event.model === 'string' && event.model.trim()) model = event.model.trim();
    const item = event.item && typeof event.item === 'object' ? event.item : null;
    if (item) {
      if (typeof item.model === 'string' && item.model.trim()) model = item.model.trim();
      if (MESSAGE_ITEM_TYPES.includes(item.type) && typeof item.text === 'string') {
        finalText = item.text;
      }
    }
    const usage = usageOf(event.usage);
    if (usage) tokenUsage = usage;
    const limited = rateLimitOf(record, now);
    if (limited) rateLimit = limited;
  }
  if (finalText === null && !rateLimit) return null;
  return { finalText, model, tokenUsage, rateLimit };
}

module.exports = { parse, events };

if (require.main === module) {
  const [, , cmd, file] = process.argv;
  if ((cmd !== 'flatten' && cmd !== 'ratelimit') || !file) {
    console.error('usage: agent-output.js flatten|ratelimit <file>');
    process.exit(2);
  }
  // Fail-safe by design, exactly like envelope.js: an unreadable or event-free log is not
  // an error. The caller keeps the log it already has and records nothing.
  let text = null;
  try { text = fs.readFileSync(file, 'utf8'); } catch { process.exit(0); }
  const parsed = parse(text);
  if (!parsed) process.exit(0);
  if (cmd === 'ratelimit') {
    if (parsed.rateLimit && parsed.rateLimit.resetAt) console.log(parsed.rateLimit.resetAt);
    process.exit(0);
  }
  if (parsed.finalText !== null) fs.writeFileSync(file, parsed.finalText);
  // stdout is the model id and nothing else — the entrypoint captures it in `$(...)`.
  if (parsed.model) console.log(parsed.model);
}
