// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  scanIntroducedObjects,
  findingIn,
} = require('../../runner/credential-scan');
const { publish } = require('../../runner/publish');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'credential-scan-'));
let passed = 0;
let failed = 0;
function check(label, condition, detail = '') {
  if (condition) { console.log(`ok - ${label}`); passed += 1; }
  else { console.log(`FAIL - ${label}${detail ? `: ${String(detail).slice(0, 400)}` : ''}`); failed += 1; }
}

function git(cwd, args, allowFailure = false) {
  const r = spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'credential fixture',
      GIT_AUTHOR_EMAIL: 'credential@test.local',
      GIT_COMMITTER_NAME: 'credential fixture',
      GIT_COMMITTER_EMAIL: 'credential@test.local',
    },
  });
  if (!allowFailure && (r.status !== 0 || r.error)) {
    throw new Error(`git ${args.join(' ')} failed: ${(r.stderr || r.error || '').toString()}`);
  }
  return r;
}

const TOKEN = ['injected', '-', 'oauth', '-', 'Z'.repeat(30)].join('');
const remote = path.join(TMP, 'remote.git');
const repo = path.join(TMP, 'work');

function checkoutTask(name) {
  git(repo, ['checkout', '-q', 'main']);
  git(repo, ['checkout', '-q', '-b', name]);
}

function logCapture() {
  const lines = [];
  return {
    lines,
    log: {
      info(_trace, message) { lines.push(String(message)); },
      error(_trace, message) { lines.push(String(message)); },
    },
  };
}

function publicationContext(branch, forkPoint, secrets) {
  return {
    ws: {
      dir: repo,
      branch,
      forkPoint,
      defaultBranch: 'main',
      regressionPolicy: 'evidence',
    },
    outcome: { status: 'stuck' },
    hasCommits: true,
    issueMarkdown: '# Fixture',
    status: { changeSummary: 'fixture' },
    verify: { acceptance: 'fail', regressions: 'pass' },
    issue: { id: 'fixture', title: 'credential scan' },
    runId: 'credential-scan-test',
    secrets,
  };
}

try {
  git(TMP, ['init', '--bare', '-q', remote]);
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(repo, 'README.md'), 'clean baseline\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'baseline']);
  git(repo, ['remote', 'add', 'origin', remote]);
  git(repo, ['push', '-q', '-u', 'origin', 'main']);
  const forkPoint = git(repo, ['rev-parse', 'HEAD']).stdout.trim();

  checkoutTask('task/deleted-secret');
  fs.writeFileSync(path.join(repo, 'temporary.txt'), `prefix ${TOKEN} suffix\n`);
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'temporary credential']);
  fs.rmSync(path.join(repo, 'temporary.txt'));
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'remove temporary credential']);

  const deleted = scanIntroducedObjects(repo, forkPoint, [TOKEN]);
  check('a secret committed and deleted before HEAD is still rejected',
    deleted.ok === false && deleted.finding === 'exact-injected-secret'
      && deleted.objectType === 'blob', JSON.stringify(deleted));
  check('scanner findings identify an object without returning the matching secret',
    /^[0-9a-f]{12}$/.test(deleted.objectId || '')
      && !JSON.stringify(deleted).includes(TOKEN), JSON.stringify(deleted));

  const captured = logCapture();
  const refused = publish({ gitTimeoutMs: 60000 },
    publicationContext('task/deleted-secret', forkPoint, [TOKEN]), captured.log, 'trace/secret');
  check('the real publication path refuses the branch before push',
    refused.ok === false && refused.pushed === false
      && /credential disclosure scan rejected/.test(refused.error || ''), JSON.stringify(refused));
  check('the refused branch never reached its remote ref',
    git(remote, ['show-ref', '--verify', '--quiet', 'refs/heads/task/deleted-secret'], true).status !== 0);
  check('neither publication results nor logs disclose the exact injected secret',
    !JSON.stringify({ refused, logs: captured.lines }).includes(TOKEN),
    JSON.stringify({ refused, logs: captured.lines }));

  checkoutTask('task/secret-filename');
  fs.writeFileSync(path.join(repo, TOKEN), 'ordinary contents\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'credential in tracked filename']);
  const filename = scanIntroducedObjects(repo, forkPoint, [TOKEN]);
  check('raw tree objects prevent a tracked filename from hiding a secret',
    filename.ok === false && filename.finding === 'exact-injected-secret'
      && filename.objectType === 'tree', JSON.stringify(filename));

  checkoutTask('task/secret-message');
  git(repo, ['commit', '-q', '--allow-empty', '-m', TOKEN]);
  const message = scanIntroducedObjects(repo, forkPoint, [TOKEN]);
  check('commit messages are part of the introduced object scan',
    message.ok === false && message.finding === 'exact-injected-secret'
      && message.objectType === 'commit', JSON.stringify(message));

  const shapes = [
    ['private-key', ['-----BEGIN ', 'PRIVATE KEY-----'].join('')],
    ['github-token', ['ghp', '_', 'A'.repeat(24)].join('')],
    ['aws-access-key', ['AKIA', 'B'.repeat(16)].join('')],
    ['anthropic-api-key', ['sk', '-ant-', 'C'.repeat(24)].join('')],
    ['openai-api-key', ['sk', '-proj-', 'D'.repeat(24)].join('')],
    ['bearer-token', ['Bearer ', 'E'.repeat(30)].join('')],
  ];
  for (const [kind, value] of shapes) {
    check(`the high-confidence ${kind} shape is rejected`,
      findingIn(Buffer.from(`before ${value} after`), []) === kind);
  }
  check('credential vocabulary without a credential is not a finding',
    findingIn(Buffer.from('password apiKey token authorization credential scanner'), []) === null);

  checkoutTask('task/untracked-secret');
  fs.writeFileSync(path.join(repo, 'clean.txt'), 'publishable source\n');
  git(repo, ['add', 'clean.txt']);
  git(repo, ['commit', '-q', '-m', 'clean implementation']);
  fs.writeFileSync(path.join(repo, 'untracked-local.txt'), TOKEN);
  const untracked = scanIntroducedObjects(repo, forkPoint, [TOKEN]);
  check('an untracked local secret is outside the object graph that a push can publish',
    untracked.ok === true && untracked.scannedObjects > 0, JSON.stringify(untracked));

  const cleanLog = logCapture();
  const clean = publish({ gitTimeoutMs: 60000 },
    publicationContext('task/untracked-secret', forkPoint, [TOKEN]), cleanLog.log, 'trace/clean');
  check('a clean introduced history still publishes normally',
    clean.ok === true && clean.pushed === true, JSON.stringify(clean));
  check('the clean publication created the expected remote ref',
    git(remote, ['show-ref', '--verify', '--quiet', 'refs/heads/task/untracked-secret'], true).status === 0);
  check('the clean path reports a completed scan without logging the injected secret',
    cleanLog.lines.some((line) => /credential disclosure scan passed/.test(line))
      && !JSON.stringify(cleanLog.lines).includes(TOKEN), JSON.stringify(cleanLog.lines));

  const invalid = scanIntroducedObjects(repo, 'not-a-commit', [TOKEN]);
  check('a missing or malformed immutable fork point fails closed',
    invalid.ok === false && /no valid fork point/.test(invalid.reason || ''), JSON.stringify(invalid));
} catch (error) {
  check('the credential scan fixture completed without throwing', false, error && error.stack);
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(`credential scan: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
