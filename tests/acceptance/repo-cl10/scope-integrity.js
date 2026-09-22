#!/usr/bin/env node
// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { checkScope } = require('../../../runner/scope');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'v1-scope-integrity-'));
function git(...args) {
  const r = spawnSync('git', args, { cwd: temp, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return (r.stdout || '').trim();
}
const desc = (body) => `## Constraints\n${body}\n`;
const check = (forkPoint, description) => checkScope({ dir: temp, forkPoint,
  issue: { description }, policy: 'required' });
try {
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  fs.writeFileSync(path.join(temp, 'pipeline.config.json'), '{"scopePolicy":"required"}\n');
  fs.mkdirSync(path.join(temp, 'src'));
  fs.writeFileSync(path.join(temp, 'src/app.ts'), 'original\n');
  git('add', '-A');
  git('commit', '-qm', 'trusted fork');
  const fork = git('rev-parse', 'HEAD');
  git('checkout', '-qb', 'task/repo-cl10');

  const outside = check(fork, '## Summary\nAllowed implementation files: src/app.ts.\n\n## Constraints\nNo list here.\n');
  assert.strictEqual(outside.ok, false, 'a list outside Constraints was accepted');
  console.log('ok - the allowed list must be inside Constraints');

  const duplicate = check(fork, desc('Allowed implementation files: src/app.ts.\nAllowed implementation files: src/app.ts.'));
  assert.strictEqual(duplicate.ok, false, 'two allowed-list lines were accepted');
  console.log('ok - duplicate allowed-list lines are rejected');

  const malformed = check(fork, desc('Allowed implementation files: src/app.ts, .'));
  assert.strictEqual(malformed.ok, false, 'an empty comma-list item was accepted');
  console.log('ok - malformed comma lists are rejected');

  const failedGit = check('not-a-commit', desc('Allowed implementation files: src/app.ts.'));
  assert.strictEqual(failedGit.ok, false, 'Git diff failure became an empty change set');
  assert.match(String(failedGit.reason || ''), /git|fork|diff|commit/i);
  console.log('ok - Git errors fail closed with a reason');

  const unusual = 'notes/caf\u00e9 Ω.md';
  fs.mkdirSync(path.join(temp, 'notes'));
  fs.writeFileSync(path.join(temp, unusual), 'untracked\n');
  const named = check(fork, desc('Allowed implementation files: src/app.ts.'));
  assert.strictEqual(named.ok, false);
  assert.ok(named.disallowedPaths.includes(unusual),
    `scope report did not preserve the exact filename: ${JSON.stringify(named)}`);
  console.log('ok - unusual filenames are reported exactly');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
