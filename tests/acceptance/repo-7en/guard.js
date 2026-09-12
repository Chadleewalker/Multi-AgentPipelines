// Frozen acceptance test — repo-7en: existing terminal preparation results remain terminal.
//
// [guard] This is green at the fork point. It serves C3's terminal-result half; all new
// liveness requirements (C1-C4) are red checks in test.js.
//
// CRITERION MAP: C3.4 terminal worker results retain their recorded outcome in status.
'use strict';

const path = require('path');
const prep = require(path.resolve(__dirname, '..', '..', '..', 'scripts', 'prepare-batch.js'));
let failed = 0;
function check(name, condition, detail) {
  console.log(`${condition ? 'ok' : 'FAIL'} - ${name}${!condition && detail ? ` — ${detail}` : ''}`);
  if (!condition) failed = 1;
}

const out = [];
const terminal = {
  ok: true,
  issues: [{ id: 'repo-7en-terminal', state: 'proven-at-base', workers: [{
    started: { pid: 8181, phase: 'authoring' }, result: { outcome: 'proven-at-base' },
  }] }],
};
const code = prep.statusReport('/not-used', 'repo-7en-guard', false, {
  deriveState: () => terminal,
}, { out: (line) => out.push(String(line)), err: () => {} });
check('C3.4 [guard] status preserves an existing terminal worker outcome',
  code === 0 && out.includes('  repo-7en-terminal: proven-at-base'), JSON.stringify(out));
process.exitCode = failed;
