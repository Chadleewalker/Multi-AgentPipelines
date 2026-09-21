// Frozen acceptance test — repo-djf.12: retained operation-manager substrate. [guard]
//
// [guard] This stays green at the fork point and serves C5's requirement that rejected
// transitions retain evidence rather than replacing the authority substrate. `test.js`
// serves C1-C6; together the two files name every criterion in repo-djf.12.
'use strict';
const supervisor = require('../../../runner/supervisor');
let failed = 0;
function check(name, yes, detail = '') {
  console.log(`${yes ? 'ok' : 'FAIL'} - ${name}${yes ? '' : ` — ${detail}`}`);
  if (!yes) failed = 1;
}
check('C5 [guard] parent-only settlement remains an explicit supervisor operation',
  typeof supervisor.grant === 'function' && typeof supervisor.settle === 'function'
    && typeof supervisor.outstanding === 'function', Object.keys(supervisor).join(','));
check('C5 [guard] independently lockable supervisor sections remain available',
  Array.isArray(supervisor.SECTIONS) && typeof supervisor.withSection === 'function'
    && typeof supervisor.tryEnterSection === 'function' && typeof supervisor.exitSection === 'function');
process.exit(failed);
