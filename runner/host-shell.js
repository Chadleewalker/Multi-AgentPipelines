// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// Shell scripts run on the host, not in the task container. On Windows a bare `bash`
// can resolve to WSL's System32 launcher even when Git for Windows is installed, and
// WSL cannot use the native C:\ paths passed by the runner. Find Bash beside the Git
// executable that the rest of the runner already requires.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

let cachedBash;

function bashExecutable() {
  if (process.platform !== 'win32') return 'bash';
  if (cachedBash) return cachedBash;

  const found = spawnSync('where.exe', ['git'], { encoding: 'utf8', windowsHide: true });
  for (const git of (found.stdout || '').split(/\r?\n/).map((line) => line.trim())) {
    if (!/[/\\]git\.exe$/i.test(git)) continue;
    // Git Bash itself exposes mingw64/bin/git.exe first, while PowerShell commonly
    // exposes cmd/git.exe. Both belong to the same install, at different depths.
    let directory = path.dirname(git);
    for (let depth = 0; depth < 4; depth++) {
      for (const relative of ['bin/bash.exe', 'usr/bin/bash.exe']) {
        const candidate = path.join(directory, relative);
        if (fs.existsSync(candidate)) return (cachedBash = candidate);
      }
      directory = path.dirname(directory);
    }
  }
  throw new Error('Git for Windows Bash not found beside git.exe; install Git for Windows or add its cmd directory to PATH');
}

function scriptArg(script) {
  // Git Bash accepts C:/... directly, including spaces in one argv element. Native
  // path.join emits backslashes, which Bash treats as escape characters.
  return process.platform === 'win32' ? path.resolve(script).replace(/\\/g, '/') : script;
}

function failure(error) {
  return { status: null, stdout: '', stderr: error.message, error };
}

function runScript(script, args = [], opts = {}) {
  try {
    return spawnSync(bashExecutable(), [scriptArg(script), ...args], { encoding: 'utf8', ...opts });
  } catch (error) {
    return failure(error);
  }
}

function spawnScript(script, args = [], opts = {}) {
  return spawn(bashExecutable(), [scriptArg(script), ...args], opts);
}

function runCommand(command, opts = {}) {
  try {
    // Preserve the original POSIX `sh -c` seam; only Windows needs an explicit Git Bash.
    const shell = process.platform === 'win32' ? bashExecutable() : 'sh';
    return spawnSync(shell, ['-c', command], { encoding: 'utf8', ...opts });
  } catch (error) {
    return failure(error);
  }
}

module.exports = { bashExecutable, scriptArg, runScript, spawnScript, runCommand };
