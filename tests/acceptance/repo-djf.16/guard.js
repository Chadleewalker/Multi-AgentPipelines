// Frozen acceptance [guard] — repo-djf.16: focused offline liveness guards remain green.
// CRITERION MAP: C3 -> C3.1-C3.5 below; C1-C2 are served only by test.js.
// The mandatory profile is checked as a separate configured command, never executed here.
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..', '..');
const focused = [
  ['C3.1 [guard] shared lock liveness remains green offline', 'tests/unit/lock.test.js'],
  ['C3.2 [guard] preparation-state records remain green offline', 'tests/unit/preparation-state.test.js'],
  ['C3.3 [guard] preparation coordinator remains green offline', 'tests/unit/prepare-batch.test.js'],
];
let failed = 0;
function check(name, yes, detail = '') {
  console.log(`${yes ? 'ok' : 'FAIL'} - ${name}${yes || !detail ? '' : ` — ${detail}`}`);
  if (!yes) failed = 1;
}
for (const [name, relative] of focused) {
  const result = spawnSync(process.execPath, [path.join(REPO, relative)], {
    encoding: 'utf8', timeout: 90000, windowsHide: true,
  });
  check(name, result.status === 0 && !result.error,
    String(result.stderr || result.stdout || result.error || '').slice(-1600));
}
const mandatoryScript = ['scripts', 'test-ci.sh'].join('/');
check('C3.4 [guard] the freeze guard invokes only focused offline checks',
  focused.every((entry) => entry[1] !== mandatoryScript));
check('C3.5 [guard] the mandatory regression sweep remains separately configured', (() => {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(REPO, 'pipeline.config.json'), 'utf8'));
    return cfg.regressionPolicy === 'required'
      && cfg.regressionCommand === ['bash', mandatoryScript].join(' ');
  } catch { return false; }
})());
process.exitCode = failed;
