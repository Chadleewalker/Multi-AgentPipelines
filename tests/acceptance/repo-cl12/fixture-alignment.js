'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '../../..');
const workspaceTest = fs.readFileSync(path.join(root, 'scripts/test-runner-workspace.sh'), 'utf8');
const reportTest = fs.readFileSync(path.join(root, 'scripts/test-report.sh'), 'utf8');
const fixture = workspaceTest.slice(workspaceTest.indexOf('TGT="$TMP/target"'), workspaceTest.indexOf('TGTW="$TGT"'));
const configMatch = fixture.match(/printf '([^']+)'\s*>\s*pipeline\.config\.json/);
assert.ok(configMatch, 'T13 fixture must write pipeline.config.json before its initial commit');
const configText = configMatch[1].replace(/\\n$/, '');
const config = JSON.parse(configText);
assert.ok(config && typeof config === 'object' && !Array.isArray(config), 'T13 fork config must be an object');
assert.strictEqual(typeof config.verifyCommand, 'string', 'T13 fixture needs a verifier command');
assert.ok(Array.isArray(config.frozenPaths), 'T13 fixture needs frozen paths');
assert.ok(config.dependencies && typeof config.dependencies === 'object', 'T13 fixture needs dependencies');
assert.ok(fixture.indexOf('pipeline.config.json') < fixture.indexOf('git add -A && git commit'), 'T13 config must be committed at the fork point');
assert.ok(!workspaceTest.includes('tee /dev/stderr'), 'T13 must capture the clone-failure result without a nonportable stderr device');
assert.ok(reportTest.includes('grep -q "not pushed — file-scope violation"'), 'T17 must check the scope-blocked branch reason');
assert.ok(!reportTest.includes('grep -q "not pushed — no commits"'), 'T17 must not mislabel its scope-blocked fixture');
const { renderReport } = require(path.join(root, 'runner/report'));
const report = renderReport({ runId: 'fixture-check', startedAt: '2026-09-22', finishedAt: '2026-09-22', tasks: [
  { issueId: 'i-fail', outcome: 'failed', branch: 'task/i-fail', pushed: false,
    scope: { ok: false, disallowedPaths: ['docs/secret.md'], reason: 'changed path(s) outside the allowed list' } }
] });
assert.ok(report.includes('not pushed — file-scope violation'), 'report fixture must actually render the expected branch reason');
console.log('PASS: T13 and T17 fixture alignment');

