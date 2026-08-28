// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { writeFixtureReceipt, RECEIPT_KEYS } = require('../../scripts/write-fixture-receipt');
const { suiteHash, workingTreeEntries, treeEntries } = require('../../runner/suite-hash');

const ROOT = path.join(__dirname, '..', '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fixture-receipts-'));
let passed = 0;
let failed = 0;
function check(label, condition, detail = '') {
  if (condition) { console.log(`ok - ${label}`); passed += 1; }
  else { console.log(`FAIL - ${label}${detail ? `: ${detail}` : ''}`); failed += 1; }
}

const git = (cwd, args) => spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], {
  cwd,
  encoding: 'utf8',
  env: {
    ...process.env,
    GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@test.local',
    GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@test.local',
  },
});

try {
  const repo = path.join(TMP, 'repo');
  fs.mkdirSync(path.join(repo, 'tests', 'acceptance', 'demo'), { recursive: true });
  git(TMP, ['init', '-q', '-b', 'main', repo]);
  fs.writeFileSync(path.join(repo, 'tests', 'acceptance', 'demo', 'test.sh'), 'exit 1\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'fixture suite']);

  const expected = suiteHash(workingTreeEntries(repo, 'tests/acceptance/demo'));
  const first = writeFixtureReceipt(repo, 'demo', () => '2026-08-28T00:00:00.000Z');
  check('the helper writes the receipt beside the fixture suite', fs.existsSync(first.file));
  check('the fixture receipt has the production writer\'s exact eight-field shape',
    JSON.stringify(Object.keys(first.receipt)) === JSON.stringify(RECEIPT_KEYS)
    && Object.keys(first.receipt).sort().join(',')
      === 'brittleness,gateHead,gateVersion,guards,probeSupplied,suiteHash,verdict,writtenAt',
    Object.keys(first.receipt).join(','));
  check('the helper imports the shared blob-id hash formula', first.receipt.suiteHash === expected);
  check('the generated fixture is admitted as a fully-proven red receipt',
    first.receipt.verdict === 'red' && first.receipt.probeSupplied === true
    && first.receipt.guards === 0 && first.receipt.brittleness === 0);
  check('the production gate-head and timestamp fields are populated',
    first.receipt.gateHead === git(repo, ['rev-parse', 'HEAD']).stdout.trim()
    && first.receipt.writtenAt === '2026-08-28T00:00:00.000Z');

  const bytes = fs.readFileSync(first.file, 'utf8');
  writeFixtureReceipt(repo, 'demo', () => 'SHOULD-NOT-REPLACE-THE-TIMESTAMP');
  check('regenerating an unchanged fixture is byte-identical', fs.readFileSync(first.file, 'utf8') === bytes);

  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'fixture receipt']);
  const committedHash = suiteHash(treeEntries(repo, 'HEAD', 'tests/acceptance/demo'));
  check('the committed branch recomputes the receipt hash exactly', committedHash === first.receipt.suiteHash);

  fs.writeFileSync(path.join(repo, 'tests', 'acceptance', 'demo', 'test.sh'), 'exit 0\n');
  const second = writeFixtureReceipt(repo, 'demo', () => '2026-08-28T00:01:00.000Z');
  check('editing fixture text regenerates rather than pasting a stale digest',
    second.receipt.suiteHash !== first.receipt.suiteHash
    && second.receipt.suiteHash === suiteHash(workingTreeEntries(repo, 'tests/acceptance/demo')));

  const users = [
    'scripts/test-runner-container.sh',
    'scripts/test-runner-pause.sh',
    'scripts/test-runner-publish.sh',
    'scripts/test-runner-queue.sh',
    'scripts/test-runner-workspace.sh',
    'scripts/e2e.sh',
  ];
  for (const rel of users) {
    const source = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    check(`${rel} generates receipts through the shared helper`, source.includes('write-fixture-receipt.js'));
  }
  const e2e = fs.readFileSync(path.join(ROOT, 'scripts', 'e2e.sh'), 'utf8');
  check('e2e publishes fixture receipts before recording the immutable main baseline',
    e2e.indexOf('write-fixture-receipt.js') >= 0
    && e2e.indexOf('git push -q origin main') > e2e.indexOf('write-fixture-receipt.js')
    && e2e.indexOf('MAIN_BEFORE=') > e2e.indexOf('git push -q origin main'));
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(`fixture receipts: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
