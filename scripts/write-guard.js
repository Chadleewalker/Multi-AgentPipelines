#!/usr/bin/env node
// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// The pipeline-first write guard, as a decision function
// (DESIGN.md §3.2, §3.4, §4.12, §6.2; change-log row `repo-324`).
//
// Harness-neutral by construction, for the reason `scripts/session-guard.js` is: the rule
// belongs to the project and outlives any particular agent CLI, so this reads one JSON
// object on stdin and answers with one JSON object plus an exit code. Translating a
// client's hook payload into this vocabulary is `scripts/write-guard-bridge.js` and nothing
// else.
//
//   stdin   {"cwd":"<folder>","sessionId":"<id>","token":"<lease token>",
//            "action":"write"|"shell"|"patch"|"read",
//            "path":"<file>","command":"<command line>","patch":"<patch text>"}
//   stdout  {"decision":"allow"|"deny","reason":"<code>","protected":<boolean>}
//   exit 0  allowed
//   exit 2  refused; every deny reason is a member of the contract's `denyReasons`
//
// It reads its policy from `contracts/write-protection.json` IN ITS OWN INSTALLATION —
// never from the checkout it is judging. A guard that took its policy from the tree in
// front of it would let a session widen its own permissions with one edit, and the whole
// point of the marker is that a model cannot move it.
//
// WHERE IT FAILS OPEN, AND WHY THAT IS NOT THE WHOLE STORY. A crash, an unreadable request
// or a checkout it cannot make sense of allows the write: hooks are prevention, not the
// perimeter, and a guard that bricks every session the first time it is wrong gets switched
// off. What makes that acceptable is that it is not the last line — freeze, preparation and
// dispatch all run the same admission check over the real checkout before they mutate it
// (`node scripts/write-protection.js admit`), and that one refuses.
//
// Checks: `node tests/acceptance/repo-324/test.js`.
'use strict';

const fs = require('fs');
const policy = require('./write-protection-policy');

function emit(result, code) {
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(code);
}

function main() {
  let request;
  try { request = JSON.parse(fs.readFileSync(0, 'utf8')); }
  catch { emit({ decision: 'allow', reason: 'unreadable-request', protected: false }, 0); return; }

  let result;
  try { result = policy.decide(request); }
  catch (e) {
    // Fail open, and say so in the answer rather than in silence: a verdict that says it
    // could not be reached is the thing a person can act on.
    emit({ decision: 'allow', reason: 'guard-error', protected: false, error: String(e && e.message) }, 0);
    return;
  }
  emit(result, result.decision === 'deny' ? 2 : 0);
}

main();
