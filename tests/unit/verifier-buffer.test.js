// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const verifier = path.resolve(__dirname, '../../pipeline/verify.js');

for (const failure of ['', 'acceptance', 'build', 'regressions']) {
  test(`2MiB output preserves the ${failure || 'all-pass'} verdict`, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-buffer-'));
    const git = (...args) => {
      const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr || String(r.error));
      return r.stdout.trim();
    };
    try {
      git('init', '-q', '-b', 'main');
      fs.writeFileSync(path.join(dir, 'loud.js'),
        'require("fs").writeSync(1, "x".repeat(2 * 1024 * 1024)); process.exit(process.argv[2] === process.env.FAIL_STAGE ? 1 : 0);\n');
      fs.writeFileSync(path.join(dir, 'pipeline.config.json'), JSON.stringify({
        defaultBranch: 'main', verifyCommand: 'node loud.js acceptance',
        buildCommand: 'node loud.js build', regressionCommand: 'node loud.js regressions',
        frozenPaths: [], dependencies: {},
      }));
      git('add', '.');
      git('-c', 'user.email=fixture@example.invalid', '-c', 'user.name=fixture', 'commit', '-qm', 'frozen baseline');
      const fork = git('rev-parse', 'HEAD');
      const result = spawnSync(process.execPath, [verifier], {
        cwd: dir, encoding: 'utf8', timeout: 30000,
        env: { ...process.env, WORKSPACE: dir, ISSUE_ID: 'fixture-1', PIPELINE_FORK_POINT: fork, FAIL_STAGE: failure },
      });
      assert.equal(result.status, ['acceptance', 'build'].includes(failure) ? 1 : 0, result.stderr || String(result.error));
      const proof = JSON.parse(fs.readFileSync(path.join(dir, '.run/verify.json'), 'utf8'));
      assert.equal(proof.acceptance, failure === 'acceptance' ? 'fail' : 'pass');
      assert.equal(proof.build, failure === 'build' ? 'fail' : 'pass');
      assert.equal(proof.regressions, failure === 'regressions' ? 'fail' : 'pass');
      assert.equal(proof.acceptanceOutput.length, 4000);
      assert.equal(proof.buildOutput.length, 4000);
      assert.equal(proof.regressionOutput.length, 2000);
    } finally {
      // The path is exactly the directory created by this fixture, never caller input.
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
}
