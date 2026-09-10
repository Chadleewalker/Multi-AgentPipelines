// Frozen acceptance test — repo-djf.2, existing canonical profiles [guard].
// [guard] C5: these fingerprints prove the two authoritative profile scripts are not edited.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const REPO = path.resolve(__dirname, '..', '..', '..');
let failed = 0;
function check(name, yes) { console.log(`${yes ? 'ok' : 'FAIL'} - ${name}`); if (!yes) failed = 1; }
function hash(name) { return crypto.createHash('sha256').update(fs.readFileSync(path.join(REPO, 'scripts', name))).digest('hex'); }
try {
  // C5 [guard] intentionally derives the baselines at the fork point; test.js independently
  // rejects a coordinator which embeds either roster instead of asking these commands.
  const ci = hash('test-ci.sh'); const all = hash('test-all.sh');
  check('C5 [guard] canonical test-ci.sh remains byte-identical to the fork point', ci === '41784747fe3f71b053bc10f5752c45f3eb956372a2cd3f3d18c8efc2629c0448');
  check('C5 [guard] canonical test-all.sh remains byte-identical to the fork point', all === '1df1b42f958e1d02b3c7d4ba19b5e552f7833f62e294983c460314fb5bfa95b4');
} catch (e) { check('C5 [guard] canonical profiles are readable', false); }
process.exit(failed);
