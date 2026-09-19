// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// Native POSIX materialization of a publishable candidate — DESIGN.md §4.4 (repo-3ec).
//
// On a Windows-hosted conveyor run the workspace is a Docker bind mount with
// core.filemode=false: git does not trust the worktree executable bit, so a filesystem-only
// `test -x` assertion reads a bind-mount/shebang bit that has nothing to do with the mode the
// tree will actually publish. Git INDEX modes are authoritative for executable semantics
// (explicit `git update-index --chmod=+x/-x`), and where the worktree cannot represent them
// faithfully the only honest way to judge them is to lay the candidate down on a real POSIX
// filesystem and let the acceptance command run there.
//
// The candidate is exactly what `git add -A` would commit: the WORKTREE content with
// GIT-AUTHORITATIVE modes. Under core.filemode=false git takes a tracked path's mode from the
// index (so an explicit `--chmod=+x` survives) and stages a new file as 100644 unless an
// explicit chmod established intent — never from the worktree bit, an extension or a shebang.
// We stage into a THROWAWAY index (seeded from the real one so staged `--chmod` intent is
// preserved) so the caller's real index is untouched, write that as a tree, and lay it down
// with `git archive | tar -x` — which restores 100755 as an executable file and 100644 as a
// plain one. The tree id is returned so a caller can bind verification evidence to the exact
// content+modes it judged; changed content or modes yield a different tree and invalidate it.
'use strict';
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TRIM = (s) => String(s || '').replace(/\s+/g, ' ').trim();

// core.filemode=false is the reproduced Windows bind-mount condition and the ONLY case that
// needs materialization: everywhere else the worktree mode is faithful and running in place is
// both correct and unchanged behaviour. Read from the repo, never from the running platform.
function fileModeUntrusted(dir, env = process.env) {
  const r = spawnSync('git', ['-C', dir, 'config', '--get', 'core.filemode'],
    { encoding: 'utf8', env });
  return r.status === 0 && String(r.stdout || '').trim() === 'false';
}

function rmrf(dir) {
  if (!dir) return;
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* disposable temp */ }
}

// Materialize the git-authoritative candidate of `repoDir` into a fresh native POSIX tree.
// Returns { ok:true, dir, tree, cleanup } or { ok:false, error, cleanup }. Fails closed: any
// git/tar failure is reported as a bounded reason rather than a partial tree. `cleanup()` is
// always safe to call and removes every temp path this created.
function materializeCandidate(repoDir, opts = {}) {
  const env = { ...process.env, ...(opts.env || {}) };
  const idxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'r3ec-idx-'));
  const tmpIndex = path.join(idxRoot, 'index');
  let outDir = null;
  const cleanup = () => { rmrf(idxRoot); rmrf(outDir); };
  const git = (args, extra = {}) => spawnSync('git', ['-C', repoDir, ...args],
    { encoding: 'utf8', env: { ...env, GIT_INDEX_FILE: tmpIndex }, ...extra });
  const fail = (why) => ({ ok: false, error: why, cleanup });
  try {
    // Seed the throwaway index from the real one so an explicit `git update-index --chmod`
    // that is staged but not yet committed is preserved. If the real index cannot be copied
    // (a fresh repo), fall back to HEAD's tree. The real index path is resolved WITHOUT
    // GIT_INDEX_FILE in the environment — otherwise `--git-path index` reports the throwaway
    // path we are about to seed, the copy is a no-op, and every staged `--chmod` is lost.
    let seeded = false;
    const realIndexRel = TRIM(spawnSync('git', ['-C', repoDir, 'rev-parse', '--git-path', 'index'],
      { encoding: 'utf8', env }).stdout);
    if (realIndexRel) {
      const realIndex = path.isAbsolute(realIndexRel) ? realIndexRel : path.join(repoDir, realIndexRel);
      try { fs.copyFileSync(realIndex, tmpIndex); seeded = true; } catch { /* fall through */ }
    }
    if (!seeded) {
      const read = git(['read-tree', 'HEAD']);
      if (read.status !== 0) return fail(`could not seed candidate index: ${TRIM(read.stderr) || 'git read-tree failed'}`);
    }
    const add = git(['add', '-A']);
    if (add.status !== 0) return fail(`could not stage candidate worktree: ${TRIM(add.stderr) || 'git add failed'}`);
    const wt = git(['write-tree']);
    if (wt.status !== 0) return fail(`could not write candidate tree: ${TRIM(wt.stderr) || 'git write-tree failed'}`);
    const tree = TRIM(wt.stdout);
    if (!/^[0-9a-f]{40,64}$/.test(tree)) return fail(`candidate tree id is malformed: ${tree || 'empty'}`);
    outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r3ec-mat-'));
    // Pipe through tar so the Git tree's modes land as real filesystem modes (100755 -> exec).
    // `git archive` writes a well-formed tar even for a bare tree; tar restores it natively.
    const posixRepo = repoDir.split(path.sep).join('/');
    const posixOut = outDir.split(path.sep).join('/');
    const ar = spawnSync('sh', ['-c',
      `git -C "${posixRepo}" archive --format=tar "${tree}" | tar -x -C "${posixOut}"`],
    { encoding: 'utf8', env: { ...env, GIT_INDEX_FILE: tmpIndex } });
    if (ar.status !== 0) return fail(`could not materialize candidate tree: ${TRIM(ar.stderr) || 'git archive/tar failed'}`);
    return { ok: true, dir: outDir, tree, cleanup };
  } catch (e) {
    return fail(`materialization failed: ${TRIM(e && e.message ? e.message : e)}`);
  }
}

module.exports = { fileModeUntrusted, materializeCandidate };
