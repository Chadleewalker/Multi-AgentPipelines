// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  parseArtifact,
  successfulArtifactFailure,
  validateValue,
  SCHEMAS,
  MAX_ERRORS,
} = require('../../runner/artifact-schema');
const { collectArtifacts } = require('../../runner/workspace');

let passed = 0;
let failed = 0;
function check(label, condition, detail = '') {
  if (condition) { console.log(`ok - ${label}`); passed += 1; }
  else { console.log(`FAIL - ${label}${detail ? `: ${String(detail).slice(0, 400)}` : ''}`); failed += 1; }
}

const ISSUE = 'artifact-1';
const status = (patch = {}) => ({
  issueId: ISSUE,
  attempts: [{ number: 1, verifierResult: 'pass', timestamp: '2026-08-28T12:00:00.000Z' }],
  phase: 'docs',
  ...patch,
});
const verify = (patch = {}) => ({
  issueId: ISSUE,
  timestamp: '2026-08-28T12:00:01.000Z',
  acceptance: 'pass',
  regressions: 'pass',
  ...patch,
});
const parse = (kind, value, expected = ISSUE) => parseArtifact(kind,
  typeof value === 'string' ? value : JSON.stringify(value), expected);
const contracts = (s, v) => ({ status: s, verify: v });

const goodStatus = parse('status', status());
const goodVerify = parse('verify', verify());
check('a production-shaped status artifact is valid', goodStatus.ok && goodStatus.state === 'valid');
check('a production-shaped verification artifact is valid', goodVerify.ok && goodVerify.state === 'valid');
check('valid artifacts retain their parsed values',
  goodStatus.value.issueId === ISSUE && goodVerify.value.acceptance === 'pass');

for (const kind of ['status', 'verify']) {
  const missing = parseArtifact(kind, null, ISSUE);
  const malformed = parseArtifact(kind, '{"unfinished":', ISSUE);
  check(`${kind}: a missing file is a named invalid state`, !missing.ok && missing.state === 'missing');
  check(`${kind}: malformed JSON is a named invalid state`, !malformed.ok && malformed.state === 'malformed');
  check(`${kind}: malformed input is never returned as a structured value`, malformed.value === null);
}

const badStatus = [
  ['array root', [], '$: must be object'],
  ['missing attempts', { issueId: ISSUE }, '$/attempts: is required'],
  ['unknown root field', status({ invented: true }), '$/invented: is not allowed'],
  ['four attempts', status({ attempts: [1, 2, 3, 4].map((number) => ({
    number, verifierResult: 'pass', timestamp: '2026-08-28T12:00:00Z',
  })) }), '$/attempts: must contain <= 3 item(s)'],
  ['invalid nested enum', status({ attempts: [{
    number: 1, verifierResult: 'maybe', timestamp: '2026-08-28T12:00:00Z',
  }] }), '$/attempts/0/verifierResult: must be an allowed enum value'],
  ['invalid nested date-time', status({ attempts: [{
    number: 1, verifierResult: 'pass', timestamp: 'yesterday',
  }] }), '$/attempts/0/timestamp: must be an RFC3339 date-time'],
];
for (const [label, value, witness] of badStatus) {
  const got = parse('status', value);
  check(`status: ${label} is schema-invalid`, !got.ok && got.state === 'schema-invalid');
  check(`status: ${label} names the enforcing rule`, got.errors.includes(witness), got.errors.join(' | '));
}

const badVerify = [
  ['array root', [], '$: must be object'],
  ['missing acceptance', (() => { const v = verify(); delete v.acceptance; return v; })(), '$/acceptance: is required'],
  ['unknown root field', verify({ invented: true }), '$/invented: is not allowed'],
  ['invalid acceptance enum', verify({ acceptance: 'done' }), '$/acceptance: must be an allowed enum value'],
  ['invalid regression enum', verify({ regressions: 'unknown' }), '$/regressions: must be an allowed enum value'],
  ['invalid date-time', verify({ timestamp: 'now' }), '$/timestamp: must be an RFC3339 date-time'],
  ['impossible calendar date', verify({ timestamp: '2026-02-30T12:00:00Z' }), '$/timestamp: must be an RFC3339 date-time'],
];
for (const [label, value, witness] of badVerify) {
  const got = parse('verify', value);
  check(`verify: ${label} is schema-invalid`, !got.ok && got.state === 'schema-invalid');
  check(`verify: ${label} names the enforcing rule`, got.errors.includes(witness), got.errors.join(' | '));
}

for (const kind of ['status', 'verify']) {
  const value = kind === 'status' ? status({ issueId: 'another-task' }) : verify({ issueId: 'another-task' });
  const got = parse(kind, value);
  check(`${kind}: schema-valid evidence for another task is refused`,
    !got.ok && got.state === 'issue-mismatch' && got.value === null);
}

check('exit 0 plus valid pass evidence remains success-eligible',
  successfulArtifactFailure(0, contracts(goodStatus, goodVerify)) === null);
const partialVerify = parse('verify', verify({ regressions: 'fail' }));
check('exit 0 plus valid failing-regression evidence remains partial-eligible',
  partialVerify.ok && successfulArtifactFailure(0, contracts(goodStatus, partialVerify)) === null);
const regressionError = parse('verify', verify({ regressions: 'error' }));
check('a valid regression harness error preserves the historic acceptance-pass behavior',
  regressionError.ok && successfulArtifactFailure(0, contracts(goodStatus, regressionError)) === null);

const invalidStates = [
  ['missing status', contracts(parseArtifact('status', null, ISSUE), goodVerify)],
  ['malformed status', contracts(parseArtifact('status', '{', ISSUE), goodVerify)],
  ['schema-invalid status', contracts(parse('status', { issueId: ISSUE }), goodVerify)],
  ['mismatched status', contracts(parse('status', status({ issueId: 'other' })), goodVerify)],
  ['missing verification', contracts(goodStatus, parseArtifact('verify', null, ISSUE))],
  ['malformed verification', contracts(goodStatus, parseArtifact('verify', '{', ISSUE))],
  ['schema-invalid verification', contracts(goodStatus, parse('verify', { issueId: ISSUE }))],
  ['mismatched verification', contracts(goodStatus, parse('verify', verify({ issueId: 'other' })))],
];
for (const [label, pair] of invalidStates) {
  const error = successfulArtifactFailure(0, pair);
  check(`${label} can never authorize exit-0 success`, typeof error === 'string' && /artifact contract failure/.test(error));
}
const acceptanceFail = parse('verify', verify({ acceptance: 'fail' }));
check('schema-valid evidence whose authoritative acceptance is not pass cannot authorize success',
  acceptanceFail.ok && /acceptance is not pass/.test(successfulArtifactFailure(0,
    contracts(goodStatus, acceptanceFail)) || ''));
check('nonzero execution outcomes are not relabelled by absent diagnostic artifacts',
  [10, 11, 20, 30, 'killed'].every((exitCode) => successfulArtifactFailure(exitCode, {}) === null));

const direct = validateValue(SCHEMAS.status, status({ memoryNotes: ['x'.repeat(501)] }));
check('the runtime validator enforces nested maxLength from the checked-in schema',
  !direct.ok && direct.errors.includes('$/memoryNotes/0: must have length <= 500'));
const noisy = { issueId: ISSUE, attempts: [] };
for (let i = 0; i < MAX_ERRORS + 10; i++) noisy[`extra-${i}`] = true;
check('validation error collection is bounded on hostile objects',
  validateValue(SCHEMAS.status, noisy).errors.length === MAX_ERRORS);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-contracts-'));
try {
  const workspace = path.join(tmp, 'workspace');
  const taskDir = path.join(tmp, 'task');
  fs.mkdirSync(path.join(workspace, '.run'), { recursive: true });
  fs.mkdirSync(taskDir, { recursive: true });
  const statusRaw = `${JSON.stringify(status(), null, 2)}\n`;
  const verifyRaw = '{"unfinished":';
  fs.writeFileSync(path.join(workspace, '.run', 'status.json'), statusRaw);
  fs.writeFileSync(path.join(workspace, '.run', 'verify.json'), verifyRaw);
  const collected = collectArtifacts(workspace, taskDir, ISSUE);
  check('collection exposes only the schema-valid status object',
    collected.status && collected.status.issueId === ISSUE && collected.contracts.status.ok);
  check('collection withholds malformed verification bytes from structured consumers',
    collected.verify === null && collected.contracts.verify.state === 'malformed');
  check('collection still preserves invalid raw evidence in the run task directory',
    fs.readFileSync(path.join(taskDir, 'verify.json'), 'utf8') === verifyRaw
      && fs.readFileSync(path.join(taskDir, 'status.json'), 'utf8') === statusRaw);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`artifact contracts: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
