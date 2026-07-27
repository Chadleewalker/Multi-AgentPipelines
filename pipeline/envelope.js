#!/usr/bin/env node
// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// Agent-envelope reader — turns a raw agent log into the contract artifacts
// (DESIGN.md §4.3, §4.11). Deterministic scaffolding, no LLM (hard rule 7).
//
// The Claude CLI writes its `--output-format json` envelope as one line, but may
// print unrelated lines first (e.g. an untrusted-workspace warning), so a whole-file
// JSON.parse silently fails and the model is never recorded. The rule here is exactly:
// scan lines BOTTOM-UP and take the first one that parses to an object with a string
// `result`. No regex over prose, no list of known warning strings — new noise from a
// CLI upgrade needs no change here.
//
// `modelUsage` lists EVERY model the CLI billed, and the cheap internal helper model is
// listed first — ahead of the pinned model that did the work. Taking key[0] therefore
// named the wrong model in the status file, the manifest, the PR footer and the report
// (repo-wxh). Selection is now a deterministic rule; see chooseModel below.
//
//   node envelope.js flatten <file> [expected-alias]
//                                     rewrite <file> to the result text and print the
//                                     resolved model; a file with no envelope is left
//                                     byte-identical and nothing is printed. Exit 0 both.
//                                     A missing or empty alias means "no alias".
'use strict';
const fs = require('fs');

// outputTokens is advisory data from another process: anything missing or non-numeric
// counts as 0 rather than poisoning the comparison with NaN.
function tokens(entry) {
  const n = entry && typeof entry === 'object' ? entry.outputTokens : undefined;
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
}

// The alias is a CLI shorthand ("opus"), the keys are full ids ("claude-opus-5"), and the
// two only ever relate by substring. `canonicalModel` is checked too because the key can
// be an opaque deployment id whose alias only shows up there.
function aliasMatches(key, entry, needle) {
  const canonical = entry && typeof entry === 'object' && typeof entry.canonicalModel === 'string'
    ? entry.canonicalModel : '';
  return String(key).toLowerCase().includes(needle) || canonical.toLowerCase().includes(needle);
}

// -> { model, aliasMiss }  — the selection rule of §4.3, applied in order:
//   1. a non-empty alias matching EXACTLY ONE key (case-insensitive substring of the key
//      or of its canonicalModel) picks that key;
//   2. else a single-key modelUsage picks that key;
//   3. else the greatest outputTokens, ties broken by key name ascending;
//   4. else null.
// aliasMiss is a human-readable diagnostic when an alias was supplied and rule 1 could
// not settle it — the caller decides where to print it. Never fatal: an alias that misses
// still records the rule-3 choice, because a wrong-looking record beats no record.
function chooseModel(modelUsage, alias) {
  if (!modelUsage || typeof modelUsage !== 'object' || Array.isArray(modelUsage)) {
    return { model: null, aliasMiss: null };
  }
  const keys = Object.keys(modelUsage);
  if (keys.length === 0) return { model: null, aliasMiss: null };

  const needle = typeof alias === 'string' ? alias.trim().toLowerCase() : '';
  let aliasMiss = null;
  if (needle) {
    const matched = keys.filter((k) => aliasMatches(k, modelUsage[k], needle));
    if (matched.length === 1) return { model: matched[0], aliasMiss: null };
    // A single-key envelope is unambiguous whatever the alias says (rule 2), so it is not
    // worth a diagnostic — the pinned alias simply is not spelled the way the id is.
    if (keys.length > 1) {
      aliasMiss = matched.length === 0
        ? `envelope.js: expected model alias "${alias}" matched none of the models used: ${keys.join(', ')}`
        : `envelope.js: expected model alias "${alias}" matched more than one model used: ${keys.join(', ')}`;
    }
  }

  if (keys.length === 1) return { model: keys[0], aliasMiss };

  const best = keys.slice().sort((a, b) => {
    const d = tokens(modelUsage[b]) - tokens(modelUsage[a]);
    return d !== 0 ? d : (a < b ? -1 : a > b ? 1 : 0);
  })[0];
  return { model: best, aliasMiss };
}

// -> { result, model, aliasMiss } | null   (model is null when there is no modelUsage)
// `expectedAlias` is optional; absent, empty or whitespace-only all mean "no alias".
function parse(text, expectedAlias) {
  const lines = String(text).split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith('{')) continue;   // cheap reject; JSON.parse decides the rest
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    if (!j || typeof j !== 'object' || Array.isArray(j)) continue;
    if (typeof j.result !== 'string') continue;
    const { model, aliasMiss } = chooseModel(j.modelUsage, expectedAlias);
    return { result: j.result, model, aliasMiss };
  }
  return null;
}

module.exports = { parse, chooseModel };

if (require.main === module) {
  const [, , cmd, file, expectedAlias] = process.argv;
  if (cmd !== 'flatten' || !file) {
    console.error('usage: envelope.js flatten <file> [expected-alias]');
    process.exit(2);
  }
  // Fail-safe by design: an unreadable or envelope-free log is not an error — the
  // caller keeps the log it already has, and no model is recorded.
  let text = null;
  try { text = fs.readFileSync(file, 'utf8'); } catch { process.exit(0); }
  const env = parse(text, expectedAlias);
  if (!env) process.exit(0);
  fs.writeFileSync(file, env.result);
  // stdout is the model id and nothing else — the entrypoint captures it in `$(...)`.
  // The diagnostic goes to stderr so it reaches the run log without corrupting that.
  if (env.aliasMiss) console.error(env.aliasMiss);
  if (env.model) console.log(env.model);
}
