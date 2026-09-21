// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0
'use strict';

const fs = require('fs');
const path = require('path');
const { fixtureIds, patternsFor, ownsBranch, main: scopeMain } = require('../../scripts/e2e-scope');

const ROOT = path.resolve(__dirname, '..', '..');
let passed = 0;
let failed = 0;
function check(label, condition, detail = '') {
  if (condition) { console.log(`ok - ${label}`); passed += 1; }
  else { console.log(`FAIL - ${label}${detail ? `: ${detail}` : ''}`); failed += 1; }
}

function functionBody(source, name) {
  const match = source.match(new RegExp(`^${name}\\(\\) \\{\\r?\\n([\\s\\S]*?)^\\}`, 'm'));
  return match ? match[1] : '';
}

const ids = ['fix-success', 'fix-bail', 'fix-tamper'];
check('fixture ids are de-duplicated without changing order',
  JSON.stringify(fixtureIds([ids[0], ids[0], ids[1]])) === JSON.stringify(ids.slice(0, 2)));
check('remote query patterns name only exact fixture branches and retry families',
  JSON.stringify(patternsFor(ids)) === JSON.stringify([
    'refs/heads/task/fix-success', 'refs/heads/task/fix-success-r*',
    'refs/heads/task/fix-bail', 'refs/heads/task/fix-bail-r*',
    'refs/heads/task/fix-tamper', 'refs/heads/task/fix-tamper-r*',
  ]));
check('the exact task branch is owned', ownsBranch('task/fix-success', ids));
check('a numeric runner retry branch is owned', ownsBranch('task/fix-success-r2', ids));
check('another task branch is never owned', !ownsBranch('task/unrelated', ids));
check('an issue-id prefix collision is never owned', !ownsBranch('task/fix-successor', ids));
check('a non-runner retry suffix is never owned', !ownsBranch('task/fix-success-rdraft', ids));
check('a nested branch is never owned', !ownsBranch('task/fix-success/extra', ids));
check('an issue id that could inject a ref pattern is refused', (() => {
  try { patternsFor(['fix-ok', '../task/*']); return false; } catch { return true; }
})());

check('the CLI applies the same ownership decision',
  scopeMain(['owns', 'task/fix-bail-r12', ...ids]) === 0);
check('the CLI refuses an unrelated branch without an execution error',
  scopeMain(['owns', 'task/someone-else', ...ids]) === 1);

const source = fs.readFileSync(path.join(ROOT, 'scripts', 'e2e.sh'), 'utf8');
const prerequisites = functionBody(source, 'require_commands');
const clean = functionBody(source, 'require_clean_fixture');
const runtime = functionBody(source, 'require_runtime');
const cleanup = functionBody(source, 'cleanup_remote');
const reset = functionBody(source, 'reset_fixture');
const scenario = functionBody(source, 'run_scenario');
const status = functionBody(source, 'status_of');
const main = source.slice(source.indexOf('step "0.'));
check('e2e declares every non-shell host prerequisite before configuration derivation',
  ['node', 'git', 'gh', 'docker', 'sed'].every(command => prerequisites.includes(command))
    && source.indexOf('require_commands || exit 1') >= 0
    && source.indexOf('require_commands || exit 1') < source.indexOf('FIX=$(node'));
check('the prerequisite gate performs no fixture or remote mutation',
  !/bdq update|git (?:reset|push)|gh pr/.test(prerequisites));
check('configuration reads fail closed instead of producing empty fixture authority',
  source.includes('could not read targetRepoPath')
    && source.includes('could not read image')
    && source.includes('fixture issue roster is invalid'));
check('e2e has a named clean-worktree precondition', clean.includes('status --porcelain'));
check('the clean-worktree precondition performs no mutation',
  !/bdq update|git (?:reset|push)|gh pr/.test(clean));
check('the clean-worktree precondition runs before fixture reset',
  main.indexOf('require_clean_fixture') >= 0
    && main.indexOf('require_clean_fixture') < main.indexOf('reset_fixture'));
check('Docker daemon and image preflight runs before fixture reset',
  runtime.includes('docker info')
    && runtime.includes('docker image inspect')
    && main.indexOf('require_runtime') >= 0
    && main.indexOf('require_runtime') < main.indexOf('reset_fixture'));
check('the runtime preflight performs no fixture or remote mutation',
  !/bdq update|git (?:reset|push)|gh pr/.test(runtime));
check('the destructive reset occurs only before e2e starts writing Beads state',
  reset.indexOf('git reset -q --hard origin/main') >= 0
    && reset.indexOf('git reset -q --hard origin/main') < reset.indexOf('bdq update'));
check('fixture reset propagates Beads update failures',
  reset.includes('bdq update "$id" --status open >/dev/null 2>&1 || return 1'));
check('status probes preserve Docker or Beads command failure',
  status.includes('json=$(bdq show "$1" --json) || return 1'));
check('scenario capture has no interactive-device dependency',
  !scenario.includes('/dev/stderr') && !scenario.includes('/dev/tty'));
check('remote cleanup derives its query through the ownership helper',
  cleanup.includes('e2e-scope.js" patterns'));
check('remote cleanup re-checks every returned branch through the ownership helper',
  cleanup.includes('e2e-scope.js" owns'));
check('remote cleanup contains no repository-wide task-branch glob',
  !cleanup.includes("'task/*'") && !cleanup.includes('"task/*"'));
check('ordinary cleanup restores the passive Beads interaction export',
  main.includes('restore_fixture_export'));

console.log(`e2e safety: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
