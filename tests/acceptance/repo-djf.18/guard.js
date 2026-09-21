// Frozen acceptance [guard] — repo-djf.18: recovery and regression foundations stay green.
//
// Pairing: C3.3 -> G3.1-G3.2 (explicit operation recovery); C4.5 -> G4.1
// (the mandatory regression profile remains selected). The red lifecycle, rotation,
// ownership, clock and identity proofs for C1-C4 are in test.js.
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..', '..');
let failed = 0;
function check(name, yes, detail = '') {
  console.log(`${yes ? 'ok' : 'FAIL'} - ${name}${yes ? '' : ` — ${detail}`}`);
  if (!yes) failed = 1;
}

const recovery = spawnSync(process.execPath,
  [path.join(REPO, 'tests', 'acceptance', 'repo-djf.13', 'test.js')], {
    cwd: REPO,
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...process.env,
      PIPELINE_GLOBAL_LOCK_DIR: undefined,
      PIPELINE_STATE_DIR: undefined,
      PIPELINE_CHILD_AUTHORITY: undefined,
    },
  });
check('C3.3 G3.1 [guard] pre-spawn loss still requires explicitly approved recoverLaunch',
  recovery.status === 0,
  String(recovery.stderr || recovery.stdout || `exit ${recovery.status}`).slice(-1800));

let manager = null;
try { manager = require(path.join(REPO, 'runner', 'operation-manager.js')); } catch {}
const managerSource = fs.readFileSync(path.join(REPO, 'runner', 'operation-manager.js'), 'utf8');
check('C3.3 G3.2 [guard] retry, recoverLaunch and reconcile remain separate explicit recovery operations',
  manager && typeof manager.createHostOperationManager === 'function'
    && /function\s+retry\s*\(/.test(managerSource)
    && /function\s+recoverLaunch\s*\(/.test(managerSource)
    && /function\s+reconcile\s*\(/.test(managerSource));

let config = null;
try { config = JSON.parse(fs.readFileSync(path.join(REPO, 'pipeline.config.json'), 'utf8')); } catch {}
check('C4.5 G4.1 [guard] the separate mandatory regression profile remains required and present',
  config && config.regressionPolicy === 'required'
    && config.regressionCommand === 'bash scripts/test-ci.sh'
    && fs.existsSync(path.join(REPO, 'scripts', 'test-ci.sh')),
  JSON.stringify(config));

process.exit(failed);
