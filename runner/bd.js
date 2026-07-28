// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// Beads access for the runner — the host is the SOLE Beads writer (DESIGN.md §4.10).
// Uses host `bd` when installed (§6 prerequisite); otherwise falls back to running
// `bd` inside the base image against the target repo, so a machine without bd
// installed still works. Either way the canonical database is the working copy at
// cfg.targetRepoPath (§4.12) — never a task branch.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// An npm-installed `bd` on Windows is a pair of shims — an extensionless /bin/sh script
// and a `.cmd` batch file — and spawnSync can execute NEITHER: the first returns ENOENT,
// the second EINVAL (Node refuses to run a batch file without a shell). The probe then
// answered "no host bd" forever and every call silently took the Docker fallback, one
// container per bd invocation; suites that drive their own `docker run … bd` against the
// same fixture deadlocked against it and were killed at 900s. Nothing errored anywhere —
// the fallback is fail-safe, so it degraded quietly for every run after bd was reinstalled.
//
// A shell is NOT the fix. bd carries agent-authored text — attempt notes, memories, spec
// concerns — and cmd.exe would mangle any quote or metacharacter in it. Instead resolve
// the shim's JS entry point and run it with process.execPath, the same move the unit
// suites' bd stub makes and for the same reason: the node binary behaves identically on
// both platforms.

// Both shim flavours name their target relative to the shim's own directory:
//   sh   ->  exec node  "$basedir/node_modules/@beads/bd/bin/bd.js" "$@"
//   cmd  ->  "%_prog%"  "%dp0%\node_modules\@beads\bd\bin\bd.js" %*
// Exported for tests/unit/bd-shim.test.js — the probe itself depends on the host, but
// this parsing does not, so it is the part that can be pinned.
function shimTarget(text, dir) {
  const m = /(?:\$basedir|%dp0%)[\\/]([^"'\s]+\.js)/.exec(String(text || ''));
  if (!m) return null;
  return path.join(dir, m[1].replace(/\\/g, '/'));
}

// { cmd, pre } — how to invoke host bd, or null when there is none. Memoized: the probe
// costs a process spawn and the answer cannot change inside one run.
let hostBd; // undefined = not probed yet, null = no host bd
function hostBdSpec() {
  if (hostBd !== undefined) return hostBd;
  hostBd = null;
  // A real executable on PATH (every POSIX host, and a native bd.exe on Windows).
  if (spawnSync('bd', ['version'], { encoding: 'utf8' }).status === 0) {
    hostBd = { cmd: 'bd', pre: [] };
    return hostBd;
  }
  for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const name of ['bd', 'bd.cmd']) {
      let text;
      try { text = fs.readFileSync(path.join(dir, name), 'utf8'); } catch { continue; }
      const js = shimTarget(text, dir);
      // Verify by running it: a shim that names a target which was uninstalled, or a
      // parse that produced a plausible-but-wrong path, must not be trusted on shape.
      if (js && spawnSync(process.execPath, [js, 'version'], { encoding: 'utf8' }).status === 0) {
        hostBd = { cmd: process.execPath, pre: [js] };
        return hostBd;
      }
    }
  }
  return hostBd;
}

function haveHostBd() {
  return hostBdSpec() !== null;
}

// Docker Desktop on Windows needs a Windows-style mount source; Git Bash's MSYS
// path conversion must also be disabled for container-side paths.
function toMountPath(p) {
  const m = /^\/([a-z])\/(.*)$/i.exec(p);            // /c/projects/... -> C:/projects/...
  if (m) return `${m[1].toUpperCase()}:/${m[2]}`;
  return p.replace(/\\/g, '/');
}

function bd(cfg, args, opts = {}) {
  // Test seam (never set in production): spawn the named executable directly with the
  // bare bd argument vector — no `-C` prefix, no host probe, no Docker fallback — so
  // Docker-free suites can stub the whole bd layer. Takes absolute precedence.
  if (process.env.PIPELINE_BD_CMD) {
    return spawnSync(process.env.PIPELINE_BD_CMD, args, {
      encoding: 'utf8',
      env: process.env,
      ...opts,
    });
  }
  const host = hostBdSpec();
  if (host) {
    return spawnSync(host.cmd, [...host.pre, '-C', cfg.targetRepoPath, ...args],
      { encoding: 'utf8', ...opts });
  }
  const mount = `${toMountPath(cfg.targetRepoPath)}:/repo`;
  return spawnSync(
    'docker',
    ['run', '--rm', '-v', mount, '-w', '/repo', cfg.image, 'bd', ...args],
    { encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' }, ...opts }
  );
}

function bdJson(cfg, args) {
  const r = bd(cfg, [...args, '--json']);
  if (r.status !== 0) return { ok: false, error: (r.stderr || r.stdout || 'bd failed').trim() };
  try {
    return { ok: true, data: JSON.parse(r.stdout || '[]') };
  } catch {
    return { ok: false, error: 'bd --json returned unparseable output' };
  }
}

module.exports = { bd, bdJson, haveHostBd, toMountPath, shimTarget };
