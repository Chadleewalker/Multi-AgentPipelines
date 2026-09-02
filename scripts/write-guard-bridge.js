#!/usr/bin/env node
// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// The host-only bridge between an agent CLI's tool-call hook and the pipeline-first write
// guard (change-log row `repo-324`). One file, two clients, chosen by the shape of the
// payload rather than by a flag — the caller is a hook and has nothing to pass.
//
//   Claude   {"session_id":…,"cwd":…,"tool_name":"Write|Edit|MultiEdit|NotebookEdit|Bash",
//             "tool_input":{…}}
//   Codex    {"session_id":…,"cwd":…,"hook":"apply_patch"|"unified_exec",
//             "input":{"patch":…}|{"command":[…]}}
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

// A `unified_exec` command arrives as an argv array. `sh -c "<script>"` is the form an agent
// actually sends, and joining it back into one string would lose the quoting the script
// depends on, so the script itself is what gets read.
function commandOf(value) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value) || !value.length) return '';
  const first = String(value[0] || '').split(/[\\/]/).pop();
  if (value.length >= 3 && /^(sh|bash|dash|zsh|ksh)$/.test(first) && String(value[1]) === '-c') {
    return String(value[2]);
  }
  return value.map(String).join(' ');
}

function requestFrom(payload) {
  const cwd = path.resolve(String((payload && payload.cwd) || process.cwd()));
  const sessionId = String((payload && (payload.session_id || payload.sessionId)) || '');
  const base = { cwd, sessionId };

  const hook = String((payload && payload.hook) || '');
  if (hook) {
    const input = (payload && payload.input) || {};
    if (hook === 'apply_patch') {
      const patch = String(input.patch || input.input || '');
      return patch ? { ...base, action: 'patch', patch } : null;
    }
    if (hook === 'unified_exec' || hook === 'exec' || hook === 'shell') {
      const command = commandOf(input.command || input.argv || input.cmd);
      return command.trim() ? { ...base, action: 'shell', command } : null;
    }
    return null;
  }

  const tool = String((payload && payload.tool_name) || '');
  if (Object.prototype.hasOwnProperty.call(WRITE_TOOLS, tool)) {
    const file = String(((payload && payload.tool_input) || {})[WRITE_TOOLS[tool]] || '');
    return file ? { ...base, action: 'write', path: file } : null;
  }
  if (tool === 'Bash') {
    const command = String(((payload && payload.tool_input) || {}).command || '');
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
