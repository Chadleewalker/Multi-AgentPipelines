#!/usr/bin/env node
// Status-file helper — sole writer of /workspace/.run/status.json inside the
// container (schema: schemas/status.schema.json, DESIGN.md §4.11). Used by
// entrypoint.sh so schema conformance lives in exactly one place.
//
//   node status.js init <issueId>          create if missing (survives relaunch — §4.7)
//   node status.js attempts                print current attempt count
//   node status.js append <result> [file]  add attempt (number auto, timestamp now,
//                                          optional feedback from file, tail 2000)
//   node status.js set <key> <value>       changeSummary | stuckState |
//                                          rateLimitResetAt | docsPhaseError
//   node status.js note <text>             propose one memory note (§3.6 out-channel;
//                                          append-only, head 500, silently capped at 20)
'use strict';
const fs = require('fs');
const path = require('path');
const RUN = process.env.RUN_DIR || path.join(process.env.WORKSPACE || '/workspace', '.run');
const FILE = path.join(RUN, 'status.json');
const load = () => JSON.parse(fs.readFileSync(FILE, 'utf8'));
const save = (o) => { fs.mkdirSync(RUN, { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(o, null, 2) + '\n'); };

const [, , cmd, ...args] = process.argv;
switch (cmd) {
  case 'init':
    if (!fs.existsSync(FILE)) save({ issueId: args[0] || '', attempts: [] });
    break;
  case 'attempts':
    console.log(load().attempts.length);
    break;
  case 'append': {
    const o = load();
    const entry = {
      number: o.attempts.length + 1,
      verifierResult: args[0],
      timestamp: new Date().toISOString(),
    };
    if (args[1] && fs.existsSync(args[1])) {
      const fb = fs.readFileSync(args[1], 'utf8').slice(-2000);
      if (fb) entry.feedback = fb;
    }
    o.attempts.push(entry);
    save(o);
    break;
  }
  case 'set': {
    const allowed = ['changeSummary', 'stuckState', 'rateLimitResetAt', 'docsPhaseError', 'model'];
    if (!allowed.includes(args[0])) { console.error(`status.js: key '${args[0]}' not in schema`); process.exit(2); }
    const o = load();
    o[args[0]] = args[1];
    save(o);
    break;
  }
  case 'note': {
    // Agents propose memories; the host files them after exit (§3.6). Append-only and
    // silently capped, so a chatty agent can never grow the status file without bound
    // or disturb notes already proposed. A note is advisory — it must not be able to
    // fail the task, hence the cap drops quietly rather than erroring.
    const text = (args[0] || '').trim();
    if (!text) { console.error('usage: status.js note <text>'); process.exit(2); }
    if (!fs.existsSync(FILE)) { console.error(`status.js: ${FILE} missing (init first)`); process.exit(2); }
    const o = load();
    if (!Array.isArray(o.memoryNotes)) o.memoryNotes = [];
    // Head, not tail: an insight leads with its point, unlike verifier feedback where
    // the last lines carry the failure.
    if (o.memoryNotes.length < 20) { o.memoryNotes.push(text.slice(0, 500)); save(o); }
    break;
  }
  default:
    console.error('usage: status.js init|attempts|append|set|note');
    process.exit(2);
}
