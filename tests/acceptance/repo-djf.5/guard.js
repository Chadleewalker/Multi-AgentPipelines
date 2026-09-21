// Frozen acceptance test — repo-djf.5. [guard]
//
// This is the green half of C1: the real controller surfaces the new proposal
// supervisor must compose are already present at this fork point. The red
// composition, recovery, scheduling, stop, and status assertions live in test.js.
// [guard] This file must remain green before and after the implementation.
'use strict';

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..', '..');
let failed = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'ok' : 'FAIL'} - ${name}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) failed = 1;
}

// C1 [guard] proves the pre-existing, real components named by the criterion.
const required = [
  'scripts/kickoff.js', 'scripts/specify-proposal.js', 'runner/supervisor.js',
  'scripts/prepare-batch.js', 'runner/run.js', 'scripts/verdict.js',
];
for (const rel of required) {
  check(`C1 [guard] real controller surface ${rel} exists for production composition`,
    fs.existsSync(path.join(REPO, ...rel.split('/'))));
}
const supervisor = require(path.join(REPO, 'runner', 'supervisor.js'));
const kickoff = require(path.join(REPO, 'scripts', 'kickoff.js'));
const specify = require(path.join(REPO, 'scripts', 'specify-proposal.js'));
const prepare = require(path.join(REPO, 'scripts', 'prepare-batch.js'));
const run = require(path.join(REPO, 'runner', 'run.js'));
const verdict = require(path.join(REPO, 'scripts', 'verdict.js'));
check('C1 [guard] scoped authority, preparation, implementation, and review remain callable surfaces',
  kickoff.VERSION === 'kickoff-intake/1' && typeof kickoff.readAll === 'function'
  && typeof kickoff.verifyRecord === 'function'
  && typeof specify.execute === 'function' && typeof specify.productionAdapters === 'function'
  && typeof supervisor.grant === 'function' && typeof supervisor.settle === 'function'
  && typeof prepare.execute === 'function' && typeof run.drainQueue === 'function'
  && typeof verdict.record === 'function');
process.exit(failed);
