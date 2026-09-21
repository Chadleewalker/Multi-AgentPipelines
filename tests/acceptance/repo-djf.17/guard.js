// Frozen acceptance [guard] — repo-djf.17: established preparation recovery remains intact.
//
// C3 is wholly served here: retry, interruption acknowledgement, proof-only routing and
// write-protection remain green.  C1-C2 are deliberately red in test.js until re-author exists.
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');
const REPO = path.resolve(__dirname, '..', '..', '..');
const suites = [
  ['C3 [guard] retry recovery', 'repo-djf.13'],
  ['C3 [guard] design/proof-only routing and write-protection', 'repo-zxc'],
];
let failed = 0;
for (const [criterion, id] of suites) {
  const file = path.join(REPO, 'tests', 'acceptance', id, 'guard.js');
  const result = spawnSync(process.execPath, [file], { encoding: 'utf8', timeout: 120000,
    env: { ...process.env, PIPELINE_GLOBAL_LOCK_DIR: undefined, PREPARATION_RUNS_DIR: undefined } });
  const ok = result.status === 0;
  console.log(`${ok ? 'ok' : 'FAIL'} - ${criterion}${ok ? '' : ` — ${String(result.stderr || result.stdout || '').slice(-1200)}`}`);
  if (!ok) failed = 1;
}
let prepare = null; let protection = null; let config = null;
try { prepare = require(path.join(REPO, 'scripts', 'prepare-batch.js')); } catch {}
try { protection = require(path.join(REPO, 'scripts', 'write-protection-policy.js')); } catch {}
try { config = JSON.parse(fs.readFileSync(path.join(REPO, 'pipeline.config.json'), 'utf8')); } catch {}
const acknowledged = prepare && prepare.parseArgs(['acknowledge-interrupted', 'djf17guard', 'repo-djf.17']);
console.log(`${acknowledged && !acknowledged.error && acknowledged.issues[0] === 'repo-djf.17' ? 'ok' : 'FAIL'} - C3 [guard] interruption acknowledgement remains an explicit single-issue command`);
if (!acknowledged || acknowledged.error || acknowledged.issues[0] !== 'repo-djf.17') failed = 1;
const proofOnly = prepare && prepare.classifyBuilt('repo-djf.17', {
  ok: true, state: 'freeze', folder: { dir: path.join(os.tmpdir(), 'djf17-guard-worktree') },
});
console.log(`${proofOnly && proofOnly.action === 'proof' ? 'ok' : 'FAIL'} - C3 [guard] an existing frozen-suite brief remains proof-only, never author-proof`);
if (!proofOnly || proofOnly.action !== 'proof') failed = 1;
const admitted = protection && protection.admit(path.join(os.tmpdir(), 'djf17-guard-unprotected'), { issues: ['repo-djf.17'] });
console.log(`${admitted && admitted.admit === true ? 'ok' : 'FAIL'} - C3 [guard] write-protection admission remains callable before preparation`);
if (!admitted || admitted.admit !== true) failed = 1;
const mandatory = config && config.regressionPolicy === 'required' && typeof config.regressionCommand === 'string'
  && fs.existsSync(path.join(REPO, 'scripts', 'test-ci.sh'));
console.log(`${mandatory ? 'ok' : 'FAIL'} - C3 [guard] the separately-run mandatory regression remains required and present`);
if (!mandatory) failed = 1;
process.exitCode = failed;
