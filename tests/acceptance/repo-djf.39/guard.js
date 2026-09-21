// Frozen acceptance [guard] — repo-djf.39.
'use strict';

const cp = require('child_process');
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..', '..');
let failed = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'ok' : 'FAIL'} - ${name}${ok || !detail ? '' : ` — ${detail}`}`);
  if (!ok) failed = 1;
}

// These focused frozen contracts cover the surfaces this repair must not weaken.
if (process.platform === 'win32') {
  // The managed Windows host denies nested child creation with EPERM. The freeze gate's
  // hardened Linux container runs these exact commands; direct checks below still run here.
  console.log('ok - G1 nested legacy guards deferred to the Docker freeze gate on Windows');
} else {
  for (const rel of [
    'tests/acceptance/repo-djf.32/test.js',
    'tests/acceptance/repo-djf.33/test.js',
    'tests/acceptance/repo-djf.19/test.js',
    'tests/acceptance/repo-djf.15/guard.js',
  ]) {
    const r = cp.spawnSync(process.execPath, [path.join(ROOT, rel)], {
      cwd: ROOT, encoding: 'utf8', timeout: 120000, env: { ...process.env },
    });
    check(`G1 existing ${rel} contract remains green`, r.status === 0,
      `${r.error ? r.error.message : ''}\n${String(r.stdout || '').slice(-600)}\n${String(r.stderr || '').slice(-400)}`);
  }
}

const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'schemas', 'run.schema.json'), 'utf8'));
const outcomes = schema.properties.tasks.items.properties.outcome.enum;
const control = require(path.join(ROOT, 'runner', 'control-plane.js'));
const contracted = new Set(Object.values(control.outcomes.exitCodes).map(value => value.status));
check('G2 every machine-readable exit outcome remains admitted by the run manifest',
  [...contracted].every(value => outcomes.includes(value)),
  JSON.stringify({ contracted: [...contracted], outcomes }));

const { buildPrBody } = require(path.join(ROOT, 'runner', 'publish.js'));
const cleanBody = buildPrBody({
  issueMarkdown: '# fixture', status: { changeSummary: 'clean summary', attempts: [] },
  verify: { acceptance: 'pass', regressions: 'pass' }, outcome: { status: 'done' },
  branch: 'task/clean', runId: 'clean-run',
});
check('G3 a clean docs result does not gain a false documentation-failure warning',
  cleanBody.includes('clean summary') && !/docsPhaseError|documentation (?:failed|error)/i.test(cleanBody),
  cleanBody.slice(0, 500));

process.exit(failed);
