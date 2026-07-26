#!/usr/bin/env node
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
//   node envelope.js flatten <file>   rewrite <file> to the result text and print the
//                                     resolved model; a file with no envelope is left
//                                     byte-identical and nothing is printed. Exit 0 both.
'use strict';
const fs = require('fs');

// -> { result, model } | null   (model is null when the envelope carries no modelUsage)
function parse(text) {
  const lines = String(text).split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith('{')) continue;   // cheap reject; JSON.parse decides the rest
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    if (!j || typeof j !== 'object' || Array.isArray(j)) continue;
    if (typeof j.result !== 'string') continue;
    const model = (j.modelUsage && typeof j.modelUsage === 'object')
      ? (Object.keys(j.modelUsage)[0] || null)
      : null;
    return { result: j.result, model };
  }
  return null;
}

module.exports = { parse };

if (require.main === module) {
  const [, , cmd, file] = process.argv;
  if (cmd !== 'flatten' || !file) {
    console.error('usage: envelope.js flatten <file>');
    process.exit(2);
  }
  // Fail-safe by design: an unreadable or envelope-free log is not an error — the
  // caller keeps the log it already has, and no model is recorded.
  let text = null;
  try { text = fs.readFileSync(file, 'utf8'); } catch { process.exit(0); }
  const env = parse(text);
  if (!env) process.exit(0);
  fs.writeFileSync(file, env.result);
  if (env.model) console.log(env.model);
}
