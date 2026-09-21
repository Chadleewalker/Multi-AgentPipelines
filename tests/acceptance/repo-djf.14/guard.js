// Frozen acceptance test — repo-djf.14.  [guard]
// C4 is wholly proved here: the existing managed-proof, atomic-freeze, dispatch-receipt and
// mandatory-regression surfaces remain available.  C1-C3 are the red checks in test.js.
'use strict';
const fs = require('fs');
const path = require('path');
const REPO = path.resolve(__dirname, '..', '..', '..');
let failed = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'ok' : 'FAIL'} - ${name}${ok || !detail ? '' : ` — ${detail}`}`);
  if (!ok) failed = 1;
}
function load(file) { try { return require(file); } catch { return null; } }
const prove = load(path.join(REPO, 'scripts', 'prove-tests.js'));
const freeze = load(path.join(REPO, 'scripts', 'freeze.js'));
const queue = load(path.join(REPO, 'runner', 'queue.js'));
const hash = load(path.join(REPO, 'runner', 'suite-hash.js'));
check('C4 [guard] the managed-proof API still exposes preparation and validation',
  !!prove && typeof prove.prepareProbe === 'function' && typeof prove.validateManagedProbe === 'function'
    && typeof prove.protectedManifest === 'function' && typeof prove.manifestHash === 'function');
check('C4 [guard] the atomic freeze command still exposes its CLI boundary', !!freeze && typeof freeze.main === 'function');
check('C4 [guard] dispatch still reads freeze receipts through the shared queue boundary',
  !!queue && typeof queue.partitionByFreeze === 'function' && queue.RECEIPT_VERDICTS instanceof Set);
check('C4 [guard] receipt identity still comes from the shared suite-hash implementation',
  !!hash && typeof hash.suiteHash === 'function' && typeof hash.treeEntries === 'function' && typeof hash.RECEIPT_NAME === 'string');
check('C4 [guard] the configured mandatory regression command remains the project command', (() => {
  try { const c = JSON.parse(fs.readFileSync(path.join(REPO, 'pipeline.config.json'), 'utf8'));
    return c.regressionPolicy === 'required' && c.regressionCommand === 'bash scripts/test-ci.sh'; } catch { return false; }
})());
process.exit(failed);
