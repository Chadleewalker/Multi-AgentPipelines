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
// FAITHFULLY — a `--shared` clone (for real `.git` metadata and fork-point/merge-base
// semantics) plus `read-tree` + `checkout-index`, which restores 100755 as an executable file,
// 100644 as a plain one, and symlinks as symlinks, without honouring `export-ignore`/
// `export-subst` the way `git archive` would. The tree id is returned so a caller can bind
// verification evidence to the exact content+modes it judged; changed content or modes yield a
// different tree and invalidate it.
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
  const idxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'r3ec-idx-'));
  const tmpIndex = path.join(idxRoot, 'index');
  // The reproduced Windows bind mount presents /workspace (and /workspace/.git) owned by a uid
  // that differs from the container user, so a `git clone` of the candidate is refused as
  // "dubious ownership". `safe.directory` is only honoured from a config FILE (never `-c`/env), so
  // materialization runs under a throwaway global config that trusts the candidate. This is not
  // core.filemode and does not trust worktree bits — the modes still come from the Git tree.
  const safeCfg = path.join(idxRoot, 'safe.gitconfig');
  fs.writeFileSync(safeCfg, '[safe]\n\tdirectory = *\n');
  const env = { ...process.env, ...(opts.env || {}), GIT_CONFIG_GLOBAL: safeCfg };
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
    // Faithful native materialization (repo-3ec correction 3). `git archive | tar` was NOT a
    // byte-for-byte materializer: it honours `export-ignore`/`export-subst`, so a tracked file
    // marked export-ignore was silently omitted from an "ok" tree, and the produced directory
    // carried no `.git` for a Git-dependent verifier. It also masked a failed producer — the
    // pipe's exit status is tar's, so a broken `git archive` upstream could still report success.
    //
    // Instead a `--shared` clone brings real `.git` metadata and every ref (so a verifier's
    // fork-point / merge-base semantics resolve), then `read-tree` + `checkout-index` lay the
    // EXACT candidate tree down with git-authoritative modes and symlinks — export attributes are
    // never consulted, the original workspace and its index are never touched, no file is
    // blanket-chmod'd, and `core.filemode` is left at the fresh clone's native default (never
    // forced true to trust an untrusted worktree bit). Each step's status is checked on its own
    // command, so a failed producer can never hide behind a later successful one.
    const clone = spawnSync('git',
      ['clone', '--quiet', '--shared', '--no-checkout', repoDir, outDir],
      { encoding: 'utf8', env });
    if (clone.status !== 0) return fail(`could not clone candidate tree: ${TRIM(clone.stderr) || 'git clone failed'}`);
    const cgit = (args) => spawnSync('git', ['-C', outDir, ...args], { encoding: 'utf8', env });
    const rt = cgit(['read-tree', tree]);
    if (rt.status !== 0) return fail(`could not load candidate tree: ${TRIM(rt.stderr) || 'git read-tree failed'}`);
    const co = cgit(['checkout-index', '-a', '-f']);
    if (co.status !== 0) return fail(`could not materialize candidate tree: ${TRIM(co.stderr) || 'git checkout-index failed'}`);
    return { ok: true, dir: outDir, tree, cleanup };
  } catch (e) {
    return fail(`materialization failed: ${TRIM(e && e.message ? e.message : e)}`);
  }
}

module.exports = { fileModeUntrusted, materializeCandidate };
