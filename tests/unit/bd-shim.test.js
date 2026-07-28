// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// Unit suite for host-`bd` resolution in runner/bd.js (DESIGN.md §4.10, §4.12).
// Docker-free and network-free: the shim parsing is pure string work, and the one
// environment-dependent check is conditional on what the shell can already do.
//
// The defect this exists to catch: an npm-installed `bd` on Windows is a pair of shims
// (an extensionless /bin/sh script and a .cmd batch file) and spawnSync can execute
// neither — ENOENT and EINVAL respectively. The probe therefore answered "no host bd"
// forever, every runner Beads call took the Docker fallback one container at a time, and
// four suites that drive their own `docker run … bd` against the same fixture deadlocked
// against it and were killed at 900s. Nothing errored: the fallback is fail-safe, so it
// degraded silently for every run after `bd` was reinstalled.
//
// Note what the last check does NOT do: it never asserts "haveHostBd() is true" flatly,
// which would fail on a machine with no bd at all — a legitimate configuration, and the
// whole reason the Docker fallback exists. It asserts the DIFFERENTIAL that was the bug:
// wherever the shell can run bd, the runner must be able to run it too.
'use strict';
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const { shimTarget, haveHostBd } = require(path.join(ROOT, 'runner', 'bd.js'));

let failed = 0;
function check(name, cond) {
  console.log(`${cond ? 'ok' : 'FAIL'} - ${name}`);
  if (!cond) failed = 1;
}

// The two shim flavours npm writes, verbatim in the shape that matters.
const SH_SHIM = [
  '#!/bin/sh',
  'basedir=$(dirname "$(echo "$0" | sed -e \'s,\\\\,/,g\')")',
  'if [ -x "$basedir/node" ]; then',
  '  exec "$basedir/node"  "$basedir/node_modules/@beads/bd/bin/bd.js" "$@"',
  'else',
  '  exec node  "$basedir/node_modules/@beads/bd/bin/bd.js" "$@"',
  'fi',
].join('\n');

const CMD_SHIM = [
  '@ECHO off',
  'SET dp0=%~dp0',
  'IF EXIST "%dp0%\\node.exe" ( SET "_prog=%dp0%\\node.exe" ) ELSE ( SET "_prog=node" )',
  '"%_prog%"  "%dp0%\\node_modules\\@beads\\bd\\bin\\bd.js" %*',
].join('\n');

const DIR = path.join('C:', 'Users', 'someone', 'AppData', 'Roaming', 'npm');
const WANT = path.join(DIR, 'node_modules', '@beads', 'bd', 'bin', 'bd.js');

// The value is pinned against an independently computed path, not merely "truthy" or
// "ends with .js" — a parse that returns a plausible-but-wrong path is exactly the
// failure mode that would send the runner back to the Docker fallback in silence.
check('sh shim resolves to the package entry point', shimTarget(SH_SHIM, DIR) === WANT);
check('cmd shim resolves to the same entry point', shimTarget(CMD_SHIM, DIR) === WANT);
check('the two flavours agree', shimTarget(SH_SHIM, DIR) === shimTarget(CMD_SHIM, DIR));

check('a shim in a path containing spaces still resolves',
  shimTarget(CMD_SHIM, path.join('C:', 'Program Files', 'npm'))
  === path.join('C:', 'Program Files', 'npm', 'node_modules', '@beads', 'bd', 'bin', 'bd.js'));

check('unrelated text yields null', shimTarget('#!/bin/sh\nexec bd "$@"\n', DIR) === null);
check('empty text yields null', shimTarget('', DIR) === null);
check('null text yields null', shimTarget(null, DIR) === null);
check('undefined text yields null', shimTarget(undefined, DIR) === null);
check('a shim naming no .js target yields null',
  shimTarget('exec "$basedir/node" "$basedir/node_modules/@beads/bd/bin/bd" "$@"', DIR) === null);

// The differential. `where`/`which` is what the SHELL can resolve; haveHostBd() is what
// NODE can resolve. The defect was precisely that the first succeeded and the second
// did not, so the runner fell back to Docker for every Beads call with no error anywhere.
const finder = process.platform === 'win32' ? 'where' : 'which';
const shellFinds = spawnSync(finder, ['bd'], { encoding: 'utf8' }).status === 0;
if (shellFinds) {
  check('bd is resolvable by the runner wherever the shell can resolve it', haveHostBd() === true);
} else {
  console.log('ok - (skipped: no bd on PATH — the Docker fallback is the supported path here)');
}

process.exit(failed);
