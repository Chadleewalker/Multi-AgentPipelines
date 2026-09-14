// [guard] Criterion -> checks: C5 -> G1,G2,G3.
// Checks -> criterion: G1,G2,G3 -> C5.
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..', '..');
const envelopeFile = path.join(root, 'pipeline', 'envelope.js');
assert(fs.existsSync(envelopeFile), 'G1 C5 pipeline/envelope.js exists');

const { parse } = require(envelopeFile);
const frame = (...events) => events.map((event) => JSON.stringify(event)).join('\n');
const started = { type: 'turn.started' };
const draft = {
  type: 'item.completed',
  item: { type: 'agent_message', text: 'draft agent message' },
};
const final = {
  type: 'item.completed',
  item: { type: 'agent_message', text: 'final agent message' },
};

assert.strictEqual(parse(frame(started, draft)).result, '',
  'G2 C5 an incomplete Codex turn parses to an empty result');
assert.strictEqual(parse(frame(started, draft, final, { type: 'turn.completed' })).result,
  'final agent message',
  'G3 C5 a complete Codex turn returns only its final agent message');

console.log('[guard] PASS C5 preserves framed Codex completion behavior');
