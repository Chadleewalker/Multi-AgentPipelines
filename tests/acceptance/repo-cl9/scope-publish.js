#!/usr/bin/env node
// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const root = path.resolve(__dirname, '../../..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'v1-scope-publish-'));
const remote = path.join(temp, 'remote.git');
const target = path.join(temp, 'target');
const runId = `repo-cl9-scope-${require('crypto').randomBytes(16).toString('hex')}`;
const runDir = path.join(root, 'runs', runId);
function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return (r.stdout || '').trim();
}
function put(dir, file, value) {
  const p = path.join(dir, file);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, value);
}
async function main() {
  git(temp, 'init', '-q', '--bare', '-b', 'main', remote);
  git(temp, 'clone', '-q', remote, target);
  git(target, 'config', 'user.email', 'test@example.com');
  git(target, 'config', 'user.name', 'test');
  put(target, 'pipeline.config.json', JSON.stringify({ defaultBranch: 'main',
    verifyCommand: 'true', scopePolicy: 'required', dependencies: {} }));
  put(target, 'src/app.ts', 'initial\n');
  put(target, 'docs/decisions.md', 'initial\n');
  git(target, 'add', '-A');
  git(target, 'commit', '-qm', 'baseline');
  git(target, 'push', '-q', 'origin', 'main');

  // The existing runner has a Node executable seam for Beads. This preload returns a
  // canonical issue and accepts host write-back without a real project database.
  const bdStub = path.join(temp, 'bd-preload.js');
  fs.writeFileSync(bdStub, `const path=require('path');
const cmd=path.basename(process.argv[1]||'');
if(cmd==='show') console.log(JSON.stringify({id:'repo-cl9',title:'scope fixture',
  description:'## Constraints\\nAllowed implementation files: src/app.ts.\\n',
  acceptance_criteria:'done',design:'design-ref: test'}));
else if(cmd==='memories') console.log('{}');
process.exit(0);\n`);
  const stub = path.join(temp, 'task.sh');
  fs.writeFileSync(stub, '#!/bin/sh\nset -e\nmkdir -p "$RUN_DIR"\nprintf "unauthorized\\n" > docs/decisions.md\ngit config user.email test@example.com\ngit config user.name test\ngit add -A\ngit commit -qm "docs changed"\nprintf \'{"issueId":"repo-cl9","attempts":[{"number":1,"verifierResult":"pass","timestamp":"2026-09-21T00:00:00Z"}]}\\n\' > "$RUN_DIR/status.json"\nprintf \'{"issueId":"repo-cl9","timestamp":"2026-09-21T00:00:00Z","acceptance":"pass","regressions":"absent"}\\n\' > "$RUN_DIR/verify.json"\n');
  const old = { ...process.env };
  try {
    process.env.PIPELINE_BD_CMD = process.execPath;
    process.env.NODE_OPTIONS = `${old.NODE_OPTIONS || ''} --require ${bdStub}`.trim();
    process.env.PIPELINE_EXEC_STUB = stub;
    process.env.PIPELINE_GH_CMD = 'echo https://example.invalid/pr/1';
    const { startRun } = require(path.join(root, 'runner/log.js'));
    const { runOneTask } = require(path.join(root, 'runner/run.js'));
    const log = startRun(root, runId);
    const cfg = { targetRepoPath: target, targetRepoRemote: remote,
      image: 'unused', wallClockMinutes: 2, concurrency: 1 };
    const row = await runOneTask(cfg, { id: 'repo-cl9', title: 'scope fixture' }, log,
      'unused', { admit: async () => true });
    assert.notStrictEqual(row.outcome, 'done', JSON.stringify(row));
    assert.strictEqual(row.prUrl, null, JSON.stringify(row));
    assert.strictEqual(row.pushed, false, JSON.stringify(row));
    assert.match(JSON.stringify(row), /docs\/decisions\.md/);
    const heads = git(remote, 'for-each-ref', '--format=%(refname:short)', 'refs/heads');
    assert.strictEqual(heads, 'main', `unauthorized branch was pushed: ${heads}`);
    console.log('ok - final out-of-scope docs edit causes zero push and zero PR');
  } finally {
    process.env = old;
  }
}
main().finally(() => {
  try {
    // A scope block intentionally retains its clone so a real reviewer can inspect
    // it. This fixture has completed that inspection; reclaim only its logged clone.
    const logFile = path.join(runDir, 'run.log');
    if (fs.existsSync(logFile)) {
      const logText = fs.readFileSync(logFile, 'utf8');
      const marker = `[${runId}/repo-cl9] workspace ready: `;
      const line = logText.split(/\r?\n/).find((entry) => entry.includes(marker));
      const match = line && /^(.+?) on task\/repo-cl9\b/.exec(line.slice(line.indexOf(marker) + marker.length));
      if (match) {
        const workspace = path.resolve(match[1]);
        const tempRoot = path.resolve(os.tmpdir());
        assert.strictEqual(path.dirname(workspace), tempRoot, 'unexpected workspace parent');
        assert.ok(path.basename(workspace).startsWith('pipeline-repo-cl9-'),
          'unexpected workspace name');
        fs.rmSync(workspace, { recursive: true, force: true });
      }
    }
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
    fs.rmSync(runDir, { recursive: true, force: true });
  }
}).catch((e) => { console.error(e); process.exitCode = 1; });
