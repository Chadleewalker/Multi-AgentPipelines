// Frozen acceptance test — repo-0tq. [guard]
//
// The end-to-end conveyor may add orchestration, history, scheduling, and operator
// reporting, but it must compose the already-shipped controller boundaries. This
// converse proof is green before implementation and remains green afterwards.
'use strict';

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..', '..');
let failed = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'ok' : 'FAIL'} - ${name}${ok || !detail ? '' : ` — ${detail}`}`);
  if (!ok) failed = 1;
}
function load(rel) {
  const file = path.join(REPO, ...rel.split('/'));
  try { return { file, api: require(file), error: null }; }
  catch (error) { return { file, api: null, error: error.message }; }
}

const surfaces = {
  kickoff: load('scripts/kickoff.js'),
  specify: load('scripts/specify-proposal.js'),
  authority: load('runner/supervisor.js'),
  prepare: load('scripts/prepare-batch.js'),
  run: load('runner/run.js'),
  verdict: load('scripts/verdict.js'),
};

check('C1 [guard] durable kickoff intake remains the only proposal identity source',
  surfaces.kickoff.api && surfaces.kickoff.api.VERSION === 'kickoff-intake/1'
    && typeof surfaces.kickoff.api.readAll === 'function'
    && typeof surfaces.kickoff.api.verifyRecord === 'function', surfaces.kickoff.error);
check('C1 [guard] the real specification and preparation controllers remain callable',
  surfaces.specify.api && typeof surfaces.specify.api.execute === 'function'
    && typeof surfaces.specify.api.recordAnswer === 'function'
    && surfaces.prepare.api && typeof surfaces.prepare.api.execute === 'function',
  surfaces.specify.error || surfaces.prepare.error);
check('C4 [guard] scoped authority and the live implementation feed remain callable',
  surfaces.authority.api && typeof surfaces.authority.api.grant === 'function'
    && typeof surfaces.authority.api.settle === 'function'
    && surfaces.run.api && typeof surfaces.run.api.drainQueue === 'function',
  surfaces.authority.error || surfaces.run.error);
check('C1-C6 [guard] review evidence and machine-readable status remain authoritative',
  surfaces.verdict.api && typeof surfaces.verdict.api.record === 'function'
    && typeof surfaces.verdict.api.readRuns === 'function'
    && fs.existsSync(path.join(REPO, 'schemas', 'status.schema.json')), surfaces.verdict.error);

process.exit(failed);
