#!/usr/bin/env node
// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// Frozen acceptance test — [guard] pipeline/verify.js is not changed by this task
// (criterion C5; hard rule 2). Green at the fork point by construction: it exists so a
// change to the verifier fails the task instead of riding in unnoticed.
//
// Content comparison against the fork-point blob, with CRLF normalised on both sides: a
// Windows-origin checkout stores CRLF on disk, so `git diff --name-only` would report the
// file changed when it is not (the same reasoning as tests/acceptance/repo-1cy A7).
// Compared against the WORKING TREE, because the verifier runs before the entrypoint
// commits, so an uncommitted edit is exactly what must be caught.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const GIT_SAFE = ['-c', `safe.directory=${ROOT.replace(/\\/g, '/')}`];
let failed = 0;
function check(label, ok) {
  if (ok) console.log(`ok - ${label}`);
  else { failed += 1; console.log(`FAIL - ${label}`); }
}
const git = (...args) => spawnSync('git', [...GIT_SAFE, ...args], { cwd: ROOT, encoding: 'utf8' });

// The host pins the trusted fork SHA (repo-cl10); fall back to merge-base with the
// integration branch, then with origin's, when run outside the pipeline.
function forkPoint() {
  const pinned = (process.env.PIPELINE_FORK_POINT || '').trim();
  if (/^[0-9a-f]{40}$/.test(pinned)) return pinned;
  for (const ref of ['main', 'origin/main']) {
    const r = git('merge-base', ref, 'HEAD');
    if (r.status === 0 && (r.stdout || '').trim()) return r.stdout.trim();
  }
  return null;
}

const base = forkPoint();
check('a fork point could be resolved', base !== null);
if (base) {
  const norm = (t) => t.replace(/\r\n/g, '\n');
  const shown = git('show', `${base}:pipeline/verify.js`);
  check('the fork point holds pipeline/verify.js', shown.status === 0);
  let disk = null;
  try { disk = fs.readFileSync(path.join(ROOT, 'pipeline', 'verify.js'), 'utf8'); } catch { disk = null; }
  check('[guard] pipeline/verify.js is byte-identical (CRLF-normalised) to the fork point',
    shown.status === 0 && disk !== null && norm(disk) === norm(shown.stdout));
}
process.exit(failed ? 1 : 0);
