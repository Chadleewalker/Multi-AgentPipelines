#!/usr/bin/env node
// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// Codex JSONL reader — the structured counterpart to `pipeline/envelope.js`
// (DESIGN.md §4.3, §4.11). Deterministic scaffolding, no LLM (hard rules 4 and 6):
// nothing here reads a model's prose, and a stream that carries no structured outcome
// answers null rather than guessing one.
//
// `codex exec --json` emits ONE JSON OBJECT PER LINE, and — exactly like the Claude
// envelope — it may print unrelated chatter around its own stream. So the rule is
// line-wise structural parsing, never a whole-file JSON.parse, which fails silently and
// records nothing (repo-52m).
//
// It lives in pipeline/ and is required by BOTH sides: the host adapter
// (runner/agent-provider.js) and the container's status helper. One parser means the
// evidence the host records and the summary the container writes cannot disagree.
//
// DEPENDENCY-FREE ON PURPOSE. Frozen container fixtures build a throwaway /pipeline
// holding only status.js and envelope.js, so nothing in pipeline/ may require this file
// eagerly, and this file may require nothing from pipeline/ either.
//
//   node agent-output.js flatten <file> [alias]  rewrite <file> to the final agent text
//                                                and print the resolved model; a file
//                                                with no structured final text is left
//                                                byte-identical and nothing is printed.
//   node agent-output.js ratelimit <file>        print the canonical reset instant when
//                                                the stream carries rate-limit evidence;
//                                                exit 1 when it does not.
'use strict';
const fs = require('fs');

// Every line that parses to a JSON object, with the line kept beside it: canonical
// rate-limit evidence is the provider's OWN line, verbatim, not a sentence composed here.
function events(raw) {
  const found = [];
  for (const line of String(raw == null ? '' : raw).split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;    // cheap reject; JSON.parse decides the rest
    let parsed;
    try { parsed = JSON.parse(trimmed); } catch { continue; }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      found.push({ event: parsed, line: trimmed });
    }
  }
  return found;
}

const finite = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

// The agent's answer, from the LAST completed agent_message item. Codex interleaves
// reasoning and command items in the same stream, so "the last line that has text in it"
// is the wrong rule — the ITEM TYPE is what separates an answer from a thought.
function finalText(found) {
  for (let i = found.length - 1; i >= 0; i -= 1) {
    const item = found[i].event.item;
    if (!item || typeof item !== 'object' || item.type !== 'agent_message') continue;
    if (typeof item.text !== 'string' || !item.text.trim()) continue;
    return item.text;
  }
  return null;
}

// Recorded only when the stream actually carries it. A zeroed-out usage object is
// indistinguishable from a real zero-token turn, and downstream accounting would believe it.
function usage(found) {
  for (let i = found.length - 1; i >= 0; i -= 1) {
    const raw = found[i].event.usage;
    if (!raw || typeof raw !== 'object') continue;
    const input = finite(raw.input_tokens);
    const output = finite(raw.output_tokens);
    if (input === null && output === null) continue;
    const record = {};
    if (input !== null) record.input = input;
    if (output !== null) record.output = output;
    const cached = finite(raw.cached_input_tokens);
    if (cached !== null) record.cachedInput = cached;
    return record;
  }
  return null;
}

// A rate limit is an INTERRUPTION, not a failed attempt (§4.7), so it has to be
// recognised from the provider's own error code rather than from any wording. A stream
// that merely mentions a rate limit in prose yields nothing here, which is the point.
const RATE_LIMIT_CODES = ['rate_limit_exceeded', 'rate_limited', 'usage_limit_reached'];

function rateLimit(found) {
  for (let i = found.length - 1; i >= 0; i -= 1) {
    const { event, line } = found[i];
    const error = event.error && typeof event.error === 'object' ? event.error : null;
    if (!error || typeof error.code !== 'string') continue;
    if (!RATE_LIMIT_CODES.includes(error.code)) continue;
    const resetAt = [error.retry_after, error.reset_at, error.resets_at]
      .find((value) => typeof value === 'string' && value.trim()) || null;
    return { resetAt, evidence: line };
  }
  return null;
}

// The resolved model, when the stream names one. Absent that, the CONFIGURED value is
// the honest answer: it is the one the invocation actually pinned, and inventing a
// resolved id we were never told is how a wrong model id goes unnoticed (repo-wxh).
function model(found, configuredModel) {
  for (const { event } of found) {
    const direct = typeof event.model === 'string' ? event.model : '';
    const nested = event.thread && typeof event.thread === 'object'
      && typeof event.thread.model === 'string' ? event.thread.model : '';
    const candidate = direct.trim() || nested.trim();
    if (candidate) return candidate;
  }
  return (typeof configuredModel === 'string' && configuredModel.trim()) ? configuredModel : null;
}

// -> { model, finalText, tokenUsage, rateLimit } | null
// null means the stream carried NO structured outcome at all. That answer is the one
// that matters most: it is what stops model prose from selecting an outcome or
// manufacturing a rate-limit reset. A caller that gets null has learned nothing from the
// agent and must fall back to the deterministic gate, never to the text.
function parse(raw, configuredModel) {
  const found = events(raw);
  if (!found.length) return null;
  const text = finalText(found);
  const limited = rateLimit(found);
  if (!text && !limited) return null;
  return {
    model: model(found, configuredModel),
    finalText: text,
    tokenUsage: usage(found),
    rateLimit: limited,
  };
}

module.exports = { parse, events, finalText, usage, rateLimit, model };

if (require.main === module) {
  const [, , cmd, file, alias] = process.argv;
  if ((cmd !== 'flatten' && cmd !== 'ratelimit') || !file) {
    console.error('usage: agent-output.js flatten|ratelimit <file> [alias]');
    process.exit(2);
  }
  // Fail-safe, exactly like envelope.js: an unreadable or structure-free log is not an
  // error. The caller keeps the log it already has and records nothing.
  let text = null;
  try { text = fs.readFileSync(file, 'utf8'); } catch { process.exit(cmd === 'flatten' ? 0 : 1); }
  const out = parse(text, alias);
  if (cmd === 'ratelimit') {
    if (!out || !out.rateLimit || !out.rateLimit.resetAt) process.exit(1);
    console.log(out.rateLimit.resetAt);
    process.exit(0);
  }
  if (!out) process.exit(0);
  // Only a real final text replaces the log. A rate-limited stream has no answer in it,
  // and overwriting the raw JSONL with an empty string would destroy the only evidence.
  if (out.finalText) fs.writeFileSync(file, out.finalText);
  // stdout is the model id and nothing else — the entrypoint captures it in `$(...)`.
  if (out.model) console.log(out.model);
}
