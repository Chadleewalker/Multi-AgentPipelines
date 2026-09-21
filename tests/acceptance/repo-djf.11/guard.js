// [guard] Frozen acceptance guard — repo-djf.11 preserves the repo-zxc publication contract.
'use strict';

// Criterion 7 is entirely green: this repair must compose with the already-frozen repo-zxc
// suite and must not weaken the project's mandatory verification policy.
const fs = require('fs');
const path = require('path');
const REPO = path.resolve(__dirname, '..', '..', '..');
let failed = 0;
function check(name, yes, detail = '') {
  console.log(`${yes ? 'ok' : 'FAIL'} - ${name}${yes || !detail ? '' : ` — ${detail}`}`);
  if (!yes) failed = 1;
}

const config = JSON.parse(fs.readFileSync(path.join(REPO, 'pipeline.config.json'), 'utf8'));
const state = require(path.join(REPO, 'runner', 'preparation-state.js'));
check('C7 [guard] repo-zxc acceptance and guard remain present',
  ['guard.js', 'test.js'].every((name) => fs.existsSync(path.join(REPO, 'tests', 'acceptance', 'repo-zxc', name))));
check('C7 [guard] canonical issue-id validation still accepts the dotted issue being repaired',
  state.validateIssueId('repo-djf.11') === 'repo-djf.11');
check('C7 [guard] canonical issue-id validation still refuses traversal, reserved and trailing names',
  ['../escape', 'con', 'repo.', 'repo '].every((id) => {
    try { state.validateIssueId(id); return false; } catch { return true; }
  }));
check('C7 [guard] mandatory regression and verifier policy remain authoritative',
  config.verifyCommand === 'sh tools/run-acceptance.sh'
    && config.regressionCommand === 'bash scripts/test-ci.sh' && config.regressionPolicy === 'required');
check('C7 [guard] frozen verifier, regression and unit-test paths remain protected',
  ['tools/run-acceptance.sh', 'scripts/test-ci.sh', 'scripts/test-*.sh', 'tests/unit/']
    .every((item) => config.frozenPaths.includes(item)));
process.exitCode = failed;
