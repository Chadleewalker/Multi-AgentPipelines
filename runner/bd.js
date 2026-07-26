// Beads access for the runner — the host is the SOLE Beads writer (DESIGN.md §4.10).
// Uses host `bd` when installed (§6 prerequisite); otherwise falls back to running
// `bd` inside the base image against the target repo, so a machine without bd
// installed still works. Either way the canonical database is the working copy at
// cfg.targetRepoPath (§4.12) — never a task branch.
'use strict';
const { spawnSync } = require('child_process');

let hostBd = null; // memoized probe
function haveHostBd() {
  if (hostBd === null) hostBd = spawnSync('bd', ['version'], { encoding: 'utf8' }).status === 0;
  return hostBd;
}

// Docker Desktop on Windows needs a Windows-style mount source; Git Bash's MSYS
// path conversion must also be disabled for container-side paths.
function toMountPath(p) {
  const m = /^\/([a-z])\/(.*)$/i.exec(p);            // /c/Code/... -> C:/Code/...
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
  if (haveHostBd()) {
    return spawnSync('bd', ['-C', cfg.targetRepoPath, ...args], { encoding: 'utf8', ...opts });
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

module.exports = { bd, bdJson, haveHostBd, toMountPath };
