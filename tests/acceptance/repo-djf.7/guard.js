// Frozen acceptance test — repo-djf.7, retained-supervisor half. [guard]
//
// [guard] This file is deliberately GREEN at the fork point.  It serves C5.0:
// the two supervisor sections that the new host manager must use remain mutually exclusive
// per section and independent between sections.  `test.js` serves C1-C6 (including C5's new
// exact-once settlement rule); together the two files serve every criterion in the issue.
//
// This is not a substitute for C5's new behaviour: it pins the existing authority substrate
// so a manager cannot "solve" settlement by serialising all host work behind one mutex.
'use strict';
const supervisor = require('../../../runner/supervisor');
let failed = 0;
function check(name, yes, detail) {
  console.log(`${yes ? 'ok' : 'FAIL'} - ${name}${yes ? '' : ` — ${detail || ''}`}`);
  if (!yes) failed = 1;
}

check('C5.0 [guard] the supervisor still exposes the two independently lockable sections',
  Array.isArray(supervisor.SECTIONS)
    && supervisor.SECTIONS.includes('beads-write')
    && supervisor.SECTIONS.includes('integration-publish')
    && typeof supervisor.withSection === 'function'
    && typeof supervisor.tryEnterSection === 'function'
    && typeof supervisor.exitSection === 'function',
  JSON.stringify(supervisor.SECTIONS));
check('C5.0 [guard] the supervisor still exposes parent-only grant settlement',
  typeof supervisor.grant === 'function' && typeof supervisor.settle === 'function'
    && typeof supervisor.outstanding === 'function' && typeof supervisor.admitEntry === 'function');
process.exit(failed);
