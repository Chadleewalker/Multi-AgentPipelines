// Frozen acceptance test — repo-djf.32. [guard]
// C6 guards the existing mandatory entrypoint and verifier surfaces while C1-C5
// specify the new isolated-docs publication boundary in test.js.
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..', '..');
let failed = 0;
function check(name, ok) { console.log(`${ok ? 'ok' : 'FAIL'} - ${name}`); if (!ok) failed = 1; }
const entrypoint = path.join(ROOT, 'pipeline', 'entrypoint.sh');
const verifier = path.join(ROOT, 'pipeline', 'verify.js');
const runner = path.join(ROOT, 'tools', 'run-acceptance.sh');
check('C6 [guard] the mandatory entrypoint, deterministic verifier, and acceptance entrypoint remain present',
  [entrypoint, verifier, runner].every(fs.existsSync));
if (fs.existsSync(entrypoint)) {
  const source = fs.readFileSync(entrypoint, 'utf8');
  check('C6 [guard] verified implementation recovery and the docs phase remain explicit entrypoint boundaries',
    /restore_verified/.test(source) && /docs phase/.test(source) && /run_verifier/.test(source));
}
process.exit(failed);
