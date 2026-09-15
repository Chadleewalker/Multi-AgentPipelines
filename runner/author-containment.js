// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// Setup containment for the test-author stage — DESIGN.md §4.3.
//
// The coordinator has already read Beads once and embedded the issue in an immutable brief.
// A Codex author session, however, reaches its own shell freely: one `bd prime` reloads the
// target project's entire memory corpus into a context that was deliberately bounded. Two
// author attempts consumed 231 memories each and exited zero having written no suite.
//
// Containment is mechanical rather than advisory, and it travels in the ENVIRONMENT: the
// Codex author argv is pinned byte for byte by tests/acceptance/repo-45g, so a flag is not
// available even if one existed. A `bd` shim leads the author's PATH, every invocation of it
// is refused within a hard character bound, and the host's own `bd` overrides are removed so
// there is no second door onto the same corpus. Claude closes Beads a different way — its
// `--disallowedTools` already carries `Bash(bd *)` — and keeps doing so unchanged.
//
// Node built-ins only, synchronous, and free of any repository require, so the author stage
// can build a launch environment without loading config, Beads or a container engine.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// The hard ceiling on EVERYTHING one contained `bd` invocation may emit across both streams.
// This is what makes a corpus dump impossible rather than merely discouraged: a truncation
// bound large enough to carry memories would satisfy "concise" and still leak the corpus.
const REFUSAL_MAX_CHARS = 240;

// Distinct from 1 (a bd query that legitimately found nothing) and from 127 (bd absent), so a
// refusal is legible in a transcript rather than looking like a broken host.
const REFUSAL_EXIT = 78;

// The host-side doors onto the same corpus. runner/bd.js honours PIPELINE_BD_CMD, and the
// stub seams the Docker-free suites use answer on the other three; a contained session that
// inherited any of them would route around the shim entirely.
const BD_OVERRIDE_NAMES = Object.freeze(['PIPELINE_BD_CMD', 'BD_ARGS_LOG', 'BD_STUB_OUT', 'BD_STUB_EXIT']);

// What the author is told in the brief, so containment is an explained boundary rather than a
// tool that mysteriously fails. The module owns this wording; scripts/spec-brief.js emits it.
const BRIEF_NOTICE = Object.freeze([
  'BEADS IS CLOSED FOR THIS SESSION. The issue above is already snapshotted into this brief,',
  'criteria and all, so `bd` is intercepted on your PATH and every invocation — prime, show,',
  'memories — is refused in one line. Reloading the whole project memory corpus is what left',
  'two earlier author sessions with no suite written at all. Work from the criteria here.',
]);

// The same shape runner/queue.js and scripts/spec-brief.js accept. An id is interpolated into
// two shell scripts below, so it is validated rather than quoted.
const SAFE_ISSUE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function safeIssueId(value) {
  const id = String(value == null ? '' : value).trim();
  return SAFE_ISSUE_ID.test(id) && id.length <= 80 ? id : null;
}

// One line, naming the snapshotted issue and why the tool is closed. Deliberately free of
// quotes, `%`, and cmd.exe's metacharacters so it survives both shim dialects verbatim.
function refusalText(issueId) {
  return `bd is closed for this author session: ${issueId} is already snapshotted in your brief.`
    + ' Work from the criteria there.';
}

// A real directory, never a symlink someone else can aim elsewhere: the shim is executable and
// leads the author's PATH, so the path it resolves through is a trust boundary.
function realDir(target, mode) {
  let stat = null;
  try { stat = fs.lstatSync(target); } catch { /* absent, created below */ }
  if (stat && stat.isSymbolicLink()) {
    throw new Error(`author containment path is a symlink: ${target}`);
  }
  if (stat && !stat.isDirectory()) {
    throw new Error(`author containment path is not a directory: ${target}`);
  }
  if (!stat) fs.mkdirSync(target, { recursive: true, mode });
}

// Outside the author's worktree by construction: anything written inside it would show up in
// the boundary audit as an edit the author may not make.
function containmentDir(issueId) {
  const id = safeIssueId(issueId);
  if (!id) throw new Error(`author containment needs a safe issue id, got ${JSON.stringify(issueId)}`);
  const root = path.join(os.tmpdir(), 'multi-agent-author-containment');
  realDir(root, 0o700);
  const dir = path.join(root, id);
  realDir(dir, 0o700);
  return dir;
}

// Write the interception shim into `dir` under both names, so it wins PATH lookup from a POSIX
// shell (`bd`, mode 0755) and from cmd.exe (`bd.cmd`, found through PATHEXT) alike. Every
// invocation — with any subcommand or none — exits non-zero and says the same bounded thing.
function prepare(dir, options = {}) {
  const id = safeIssueId(options && options.issueId);
  if (!id) throw new Error(`author containment needs a safe issue id, got ${JSON.stringify(options && options.issueId)}`);
  if (typeof dir !== 'string' || !dir.trim()) throw new Error('author containment needs a directory');
  const target = path.resolve(dir);
  realDir(target, 0o700);

  const message = refusalText(id);
  const posix = path.join(target, 'bd');
  const windows = path.join(target, 'bd.cmd');
  // printf with a literal format and the message as an argument: no expansion of anything the
  // issue id could carry, and exactly one trailing newline on stderr.
  fs.writeFileSync(posix, [
    '#!/bin/sh',
    '# Beads interception for one contained test-author session. Written by',
    '# runner/author-containment.js; every subcommand is refused, bounded, and corpus-free.',
    `printf '%s\\n' '${message}' >&2`,
    `exit ${REFUSAL_EXIT}`,
    '',
  ].join('\n'));
  try { fs.chmodSync(posix, 0o755); } catch { /* Windows carries no mode bits */ }
  fs.writeFileSync(windows, [
    '@echo off',
    'rem Beads interception for one contained test-author session.',
    `>&2 echo ${message}`,
    `exit /b ${REFUSAL_EXIT}`,
    '',
  ].join('\r\n'));

  return { ok: true, dir: target, issueId: id, names: ['bd', 'bd.cmd'] };
}

// A NEW environment in which the shim leads PATH and the host bd overrides are gone. Everything
// else survives untouched: containment closes Beads, not the stage's own environment, which
// still carries licence paths and off-PATH binaries the author legitimately needs.
function applyEnv(baseEnv, prepared) {
  const source = baseEnv && typeof baseEnv === 'object' ? baseEnv : {};
  if (!prepared || typeof prepared.dir !== 'string' || !prepared.dir) {
    throw new Error('applyEnv needs a prepared containment directory');
  }
  const dir = path.resolve(prepared.dir);
  const env = {};
  // Windows spells it `Path`, a caller may have added `PATH`, and a child reads whichever it
  // happens to look for — so they collapse into one key here, spelled PATH.
  let explicit = null;
  let other = null;
  for (const [key, value] of Object.entries(source)) {
    if (key.toLowerCase() === 'path') {
      if (key === 'PATH') explicit = value;
      else if (other === null) other = value;
      continue;
    }
    if (BD_OVERRIDE_NAMES.includes(key)) continue;
    env[key] = value;
  }
  const inherited = explicit === null ? other : explicit;
  const rest = typeof inherited === 'string' && inherited ? `${path.delimiter}${inherited}` : '';
  env.PATH = `${dir}${rest}`;
  return env;
}

// The one call the author stage makes: prepare the shim for this issue and return the launch
// environment that closes Beads around it.
function containEnv(baseEnv, issueId) {
  return applyEnv(baseEnv, prepare(containmentDir(issueId), { issueId }));
}

module.exports = {
  REFUSAL_MAX_CHARS, REFUSAL_EXIT, BRIEF_NOTICE, BD_OVERRIDE_NAMES,
  refusalText, containmentDir, prepare, applyEnv, containEnv,
};
