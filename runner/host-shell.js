// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// Resolve the host shell used for host-side scripts and test seams.
//
// `bash` is not an identity on Windows: the same command can name Git for Windows or
// C:\Windows\System32\bash.exe (WSL). The runner operates on Windows paths and Windows
// Node/Git/Docker executables, so WSL is not a compatible substitute. A candidate is usable
// only when it proves both its environment and its ability to launch this exact Node binary.
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { runSync } = require('./process');

const PROBE_MARKER = 'PIPELINE_HOST_NODE_OK';
const PROBE_TIMEOUT_MS = 10000;

function probeScript(windows) {
  const lines = [
    'test -n "$BASH_VERSION" || exit 40',
  ];
  if (windows) lines.push('case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) ;; *) exit 41 ;; esac');
  lines.push('"$1" -e \'process.stdout.write("PIPELINE_HOST_NODE_OK")\' || exit 42');
  return lines.join('; ');
}

function probeHostShell(command, opts = {}) {
  const platform = opts.platform || process.platform;
  const run = opts.spawnSync || spawnSync;
  const node = opts.execPath || process.execPath;
  const timeoutMs = opts.timeoutMs || PROBE_TIMEOUT_MS;
  const r = runSync(command, [
    '--noprofile', '--norc', '-c', probeScript(platform === 'win32'),
    'pipeline-host-shell-probe', node,
  ], {
    spawnSync: run,
    timeoutMs,
    label: 'host shell probe',
    maxBuffer: 64 * 1024,
  });
  if (r && r.error) {
    const state = r.timedOut || r.error.code === 'ETIMEDOUT' ? 'timed-out' : 'unavailable';
    return { ok: false, state };
  }
  if (!r || r.status !== 0) {
    const state = r && r.status === 41 ? 'not-git-bash'
      : (r && r.status === 42 ? 'cannot-run-host-node' : 'probe-failed');
    return { ok: false, state };
  }
  if (String(r.stdout || '').trim() !== PROBE_MARKER) return { ok: false, state: 'bad-probe-output' };
  return { ok: true, state: platform === 'win32' ? 'git-bash' : 'posix-bash' };
}

function windowsCandidates(env, run, exists, timeoutMs) {
  const found = [];
  const add = (candidate) => {
    if (candidate && !found.some((item) => item.toLowerCase() === candidate.toLowerCase())) found.push(candidate);
  };
  const roots = [env.ProgramFiles, env['ProgramFiles(x86)']];
  if (env.LOCALAPPDATA) roots.push(path.join(env.LOCALAPPDATA, 'Programs'));
  for (const root of roots.filter(Boolean)) {
    for (const rel of [path.join('Git', 'bin', 'bash.exe'), path.join('Git', 'usr', 'bin', 'bash.exe')]) {
      const candidate = path.join(root, rel);
      if (exists(candidate)) add(candidate);
    }
  }
  const where = runSync('where.exe', ['bash.exe'], {
    spawnSync: run, timeoutMs, label: 'host shell discovery', maxBuffer: 64 * 1024,
  });
  if (where && where.status === 0 && !where.error) {
    for (const line of String(where.stdout || '').split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) add(line);
  }
  return found;
}

function remedy(node) {
  return 'Install Git for Windows or set "hostShell" in the run config to its bin/bash.exe; '
    + `the shell must be able to launch the host Node toolchain (${node}). WSL bash is not supported for Windows-host runs.`;
}

function resolveHostShell(configured, opts = {}) {
  const platform = opts.platform || process.platform;
  const run = opts.spawnSync || spawnSync;
  const exists = opts.existsSync || fs.existsSync;
  const env = opts.env || process.env;
  const node = opts.execPath || process.execPath;
  const timeoutMs = opts.timeoutMs || PROBE_TIMEOUT_MS;
  const probe = (candidate) => probeHostShell(candidate, {
    platform, spawnSync: run, execPath: node, timeoutMs,
  });

  if (configured !== null && configured !== undefined) {
    const checked = probe(configured);
    if (checked.ok) return { ok: true, command: configured, kind: checked.state, configured: true };
    return {
      ok: false,
      reason: `configured hostShell '${configured}' is incompatible (${checked.state}). ${remedy(node)}`,
      tried: [configured],
    };
  }

  const candidates = platform === 'win32'
    ? windowsCandidates(env, run, exists, timeoutMs)
    : ['bash'];
  const failures = [];
  for (const candidate of candidates) {
    const checked = probe(candidate);
    if (checked.ok) return { ok: true, command: candidate, kind: checked.state, configured: false };
    failures.push(`${candidate} (${checked.state})`);
  }
  const tried = failures.length ? failures.join(', ') : '(no Git Bash candidates found)';
  return { ok: false, reason: `no compatible host shell; tried ${tried}. ${remedy(node)}`, tried: candidates };
}

function commandFor(cfg, fallback = 'bash') {
  return cfg && typeof cfg.hostShell === 'string' && cfg.hostShell ? cfg.hostShell : fallback;
}

module.exports = {
  resolveHostShell,
  probeHostShell,
  commandFor,
  probeScript,
  PROBE_MARKER,
  PROBE_TIMEOUT_MS,
};
