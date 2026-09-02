#!/usr/bin/env node
// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// The host-only bridge between an agent CLI's tool-call hook and the pipeline-first write
// guard (change-log row `repo-324`). One file, two clients, chosen by the shape of the
// payload rather than by a flag — the caller is a hook and has nothing to pass.
//
//   Claude   {"session_id":…,"cwd":…,"tool_name":"Write|Edit|MultiEdit|NotebookEdit|Bash",
//             "tool_input":{…}}
//   Codex    {"session_id":…,"cwd":…,"tool_name":"Bash"|"apply_patch",
//             "tool_input":{"command":[argv]|"<line>"}}
//   Codex    {"session_id":…,"cwd":…,"hook":"apply_patch"|"unified_exec",
//   (legacy)  "input":{"patch":…}|{"command":[…]}}
//
// The current Codex PreToolUse envelope puts the request in the SAME place on both tool
// paths: `tool_input.command`. On `Bash` that is a shell argv or command line; on
// `apply_patch` it is the patch itself, usually as one element of an argv whose first word
// is the tool's own name. The legacy `hook` / `input` dialect is still read, because a host
// may be running an older client and dropping it would silently unguard that host
// (change-log row `repo-ak5`).
//
//   exit 0   allow, silent
//   exit 2   refuse, reason on stderr where the model will read it
//
// Why it is a separate file from the guard: the knowledge that a tool call arrives as JSON
// on stdin with `tool_name`, and that exit 2 means "refuse and show this to the model",
// belongs to one CLI and is wrong the day that CLI is swapped. Replacing a harness means
// rewriting this file and nothing else — the same boundary `scripts/session-guard-bridge.js`
// draws, for the same reason.
//
// Why it is INSTALLED rather than committed into place: this repo is a target of its own
// pipeline, so every tracked file is cloned into a task container that has no agent CLI. A
// tracked hook CONFIGURATION would fire in there and fail on every session, which
// `tests/unit/agent-hooks.test.js` refuses outright. Nothing tracked references this file,
// so nothing tracked makes it run; `node scripts/write-protection.js install` copies it to
// the host's client-config directory, where the container never sees it.
//
// Fails open at every step it cannot complete, for the reason the guard does — see the
// header there, and note that admission is the backstop that does not.
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// Which Claude tool inputs name a file this guard should judge. Anything not listed — a
// read, a search, a web fetch — is none of its business and exits 0 before spawning.
const WRITE_TOOLS = {
  Write: 'file_path',
  Edit: 'file_path',
  MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path',
};

// The Codex shell tool paths, current name first. `Bash` is what the current client sends;
// the rest are the names older and neighbouring clients use for the same thing.
const SHELL_TOOLS = new Set(['Bash', 'unified_exec', 'exec', 'shell', 'local_shell']);
const PATCH_TOOLS = new Set(['apply_patch']);

const baseName = (token) => String(token || '').split(/[\\/]/).pop().replace(/\.(exe|cmd|bat)$/i, '');
const asText = (v) => String(v === undefined || v === null ? '' : v);

// `sh -c "<script>"` is the form an agent actually sends, and joining the argv back into one
// line would hand the guard `bash` — a command it has no opinion about — instead of the script
// it was given. The flags arrive clustered as often as not (`bash -lc`, `sh -ec`), so the
// cluster is matched rather than a literal `-c`.
function shellScriptOf(parts) {
  if (!/^(sh|bash|dash|zsh|ksh)$/.test(baseName(parts[0]))) return null;
  for (let i = 1; i < parts.length; i += 1) {
    if (/^-[A-Za-z]*c$/.test(parts[i])) return i + 1 < parts.length ? parts[i + 1] : null;
    if (!parts[i].startsWith('-')) return null;
  }
  return null;
}

// A shell command arrives as an argv array or as one command line, depending on the client.
function commandOf(value) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value) || !value.length) return '';
  const parts = value.map(asText);
  const script = shellScriptOf(parts);
  return script === null ? parts.join(' ') : script;
}

// Both patch dialects the guard can read, and the two argv shapes they arrive in. Where an
// element carries patch syntax that element IS the patch; otherwise the leading element is the
// tool's own name and everything after it is the body. A patch this cannot find is not a patch
// this refuses blindly — an empty answer means there is nothing to judge, and the guard's own
// `unknown-patch-form` covers the case where something arrived and could not be read.
const PATCH_SYNTAX = /^\*\*\*\s+(?:Begin Patch|End Patch|Add|Update|Delete|Move)\b|^(?:---|\+\+\+|@@|diff --git)/m;

function patchOf(value) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value) || !value.length) return '';
  const parts = value.map(asText);
  const carriers = parts.filter((p) => PATCH_SYNTAX.test(p));
  return carriers.length ? carriers.join('\n') : parts.slice(1).join('\n');
}

function requestFrom(payload) {
  const cwd = path.resolve(String((payload && payload.cwd) || process.cwd()));
  const sessionId = String((payload && (payload.session_id || payload.sessionId)) || '');
  const base = { cwd, sessionId };

  const hook = String((payload && payload.hook) || '');
  if (hook) {
    const input = (payload && payload.input) || {};
    if (hook === 'apply_patch') {
      const patch = patchOf(input.patch !== undefined ? input.patch : input.input);
      return patch ? { ...base, action: 'patch', patch } : null;
    }
    if (hook === 'unified_exec' || hook === 'exec' || hook === 'shell') {
      const command = commandOf(input.command || input.argv || input.cmd);
      return command.trim() ? { ...base, action: 'shell', command } : null;
    }
    return null;
  }

  const tool = String((payload && payload.tool_name) || '');
  const input = (payload && payload.tool_input) || {};
  if (Object.prototype.hasOwnProperty.call(WRITE_TOOLS, tool)) {
    const file = String(input[WRITE_TOOLS[tool]] || '');
    return file ? { ...base, action: 'write', path: file } : null;
  }
  if (PATCH_TOOLS.has(tool)) {
    const carried = input.command !== undefined ? input.command
      : (input.patch !== undefined ? input.patch : input.input);
    const patch = patchOf(carried);
    return patch.trim() ? { ...base, action: 'patch', patch } : null;
  }
  if (SHELL_TOOLS.has(tool)) {
    const command = commandOf(input.command !== undefined ? input.command : (input.argv || input.cmd));
    return command.trim() ? { ...base, action: 'shell', command } : null;
  }
  return null;
}

// The guard beside this bridge is the one that decides, because it carries the contract this
// installation was built from. Only if the installation is incomplete does this fall back to
// a guard found above the working directory.
function locateGuard(cwd) {
  const beside = path.join(__dirname, 'write-guard.js');
  if (fs.existsSync(beside)) return beside;
  let dir = cwd;
  for (;;) {
    const candidate = path.join(dir, 'scripts', 'write-guard.js');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function main() {
  let payload;
  try { payload = JSON.parse(fs.readFileSync(0, 'utf8')); } catch { return 0; }

  const request = requestFrom(payload);
  if (!request) return 0;

  const guard = locateGuard(request.cwd);
  if (!guard) return 0;

  const r = spawnSync(process.execPath, [guard], {
    input: JSON.stringify(request), encoding: 'utf8', timeout: 30000, windowsHide: true,
  });
  if (r.error || typeof r.status !== 'number') return 0;
  if (r.status !== 2) return 0;

  let reason = '';
  try { reason = String((JSON.parse(String(r.stdout || '').trim()) || {}).reason || ''); }
  catch { reason = ''; }
  process.stderr.write(`${explain(reason, request)}\n`);
  return 2;
}

// What a person — or a model that is about to try the same thing a second way — needs next.
// Kept here rather than in the guard because it is client-facing text, not policy.
function explain(reason, request) {
  const head = {
    'pipeline-first': 'this checkout is run by Multi-Agent Pipelines, so changes to it are made by a '
      + 'pipeline run and not by hand.',
    'role-path': 'that path is outside what this session was granted authority over.',
    'lease-invalid': 'the authority this session presented is missing, expired, or issued for '
      + 'another checkout.',
    'unknown-shell-form': 'that command could not be read well enough to tell whether it writes, '
      + 'so it is refused rather than guessed at.',
    'unknown-patch-form': 'that patch names no files this guard can read, so it is refused rather '
      + 'than guessed at.',
    'interpreter-write': 'that runs an inline program, which can write anything.',
    'destructive-git': 'that Git command discards or rewrites work that may not be yours.',
  }[reason] || 'this checkout is pipeline-first.';
  return [
    `write-protection: ${head}`,
    '',
    'Plan the change and freeze its acceptance suite, then let a run make it. Read-only',
    'inspection is unaffected.',
    '',
    '    node scripts/write-protection.js status     what is enforced, honestly',
    '    node scripts/write-protection.js recover    move edits you already made somewhere safe',
    '',
    `(cwd ${request.cwd})`,
  ].join('\n');
}

process.exit(main());
