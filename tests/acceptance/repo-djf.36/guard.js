// Frozen acceptance guard — repo-djf.36. [guard]
// Criteria -> tests: C4 -> guard.js + test.js; C1-C3,C5-C6 -> test.js.
// Tests -> criteria: this guard preserves C4's existing POSIX target identity rule.
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..', '..');
const lock = require(path.join(ROOT, 'runner', 'lock.js'));
let failed = 0;
function check(name, yes, detail = '') { console.log(`${yes ? 'ok' : 'FAIL'} - ${name}${yes ? '' : ` — ${detail}`}`); if (!yes) failed = 1; }

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-djf36-guard-'));
try {
  if (process.platform === 'win32') {
    check('C4 [guard] POSIX-only case/symlink identity probe is deferred on Windows', true);
  } else {
  const lower = path.join(root, 'project');
  const upper = path.join(root, 'PROJECT');
  fs.mkdirSync(lower); fs.mkdirSync(upper);
  const linked = path.join(root, 'linked');
  try { fs.symlinkSync(lower, linked, 'junction'); } catch { fs.symlinkSync(lower, linked); }
  check('C4 [guard] real POSIX case-distinct directories remain distinct while a symlink remains its real target',
    lock.canonicalTarget(lower) !== lock.canonicalTarget(upper)
      && lock.canonicalTarget(lower) === lock.canonicalTarget(linked),
    JSON.stringify({ lower: lock.canonicalTarget(lower), upper: lock.canonicalTarget(upper), linked: lock.canonicalTarget(linked) }));
  }
} catch (error) { check('C4 [guard] POSIX identity fixture completes', false, error.stack || String(error)); }
finally { fs.rmSync(root, { recursive: true, force: true }); }
process.exitCode = failed;
