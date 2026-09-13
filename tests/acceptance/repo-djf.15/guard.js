// Frozen acceptance [guard] — repo-djf.15 C3: offline schema and report baseline remains green.
// C3 is served by this guard and test.js; C1-C2 are served only by test.js.
'use strict';
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..', '..');
let failed = 0;
function check(name, yes, detail = '') {
  console.log(`${yes ? 'ok' : 'FAIL'} - ${name}${yes ? '' : ` — ${detail}`}`);
  if (!yes) failed = 1;
}
let artifacts = null;
let report = null;
try { artifacts = require(path.join(ROOT, 'runner', 'artifact-schema.js')); } catch (error) { check('C3 artifact schema loads offline', false, error.message); }
try { report = require(path.join(ROOT, 'runner', 'report.js')); } catch (error) { check('C3 report renderer loads offline', false, error.message); }
const status = { issueId: 'repo-djf.15-guard', attempts: [], changeSummary: 'A bounded human summary.' };
const parsed = artifacts && artifacts.parseArtifact('status', JSON.stringify(status), status.issueId);
check('C3 [guard] status artifact accepts a bounded human summary', Boolean(parsed && parsed.ok));
const markdown = report && report.renderReport({
  runId: 'repo-djf.15-guard', startedAt: '2026-09-12T00:00:00Z', finishedAt: '2026-09-12T00:00:01Z',
  tasks: [{ issueId: status.issueId, outcome: 'done', attempts: 1, changeSummary: status.changeSummary }],
});
check('C3 [guard] report renders that summary unchanged',
  typeof markdown === 'string' && markdown.includes(status.changeSummary));
process.exitCode = failed;
