#!/usr/bin/env node
// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// The host-only bridge between an agent CLI's tool-call hook and the pipeline-first write
// guard (change-log rows `repo-324` and `repo-l2w`). One file, two clients, chosen by the
// shape of the payload rather than by a flag — the caller is a hook and has nothing to pass.
//
//   Claude   {"session_id":…,"cwd":…,"tool_name":"Write|Edit|MultiEdit|NotebookEdit|Bash",
//             "tool_input":{…}}
//   Codex    {"session_id":…,"cwd":…,"tool_name":"apply_patch"|"unified_exec"|"Bash",
//             "tool_input":{"patch":…}|{"command":[argv]|"<command line>"}}
//   Codex    {"session_id":…,"cwd":…,"hook":"apply_patch"|"unified_exec",
//   (legacy)  "input":{"patch":…}|{"command":[…]}}
//
// The two clients now share the `tool_name` / `tool_input` envelope, so the tool NAME is what
// selects the reading and the two dialects differ only in what `command` holds: Claude sends
// one command line as a string, Codex sends an argv array. Both are read here, and the legacy
// Codex envelope is still read as well — a host mid-upgrade runs whichever the installed
// client sends, and dropping the older shape would silently unguard it.
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

// The tool names that carry a shell command, on either client. `Bash` is on both: Claude
// spells the shell tool path that way, and so does Codex when it runs one through its own
// Bash tool, which is why the guard's Codex matcher covers all three names.
const SHELL_TOOLS = new Set(['unified_exec', 'exec', 'shell', 'local_shell', 'Bash']);
const PATCH_TOOLS = new Set(['apply_patch']);

const SHELLS = /^(sh|bash|dash|zsh|ksh|ash|busybox)$/;

// A shell operand — one argv element — put back into a command line without losing the word
// boundary it arrived with. Single quotes, because the guard's tokeniser reads them and they
// suppress every expansion inside.
function shellQuote(word) {
  return /[^A-Za-z0-9_@%+=:,./-]/.test(word) ? `'${word.split("'").join("'\\''")}'` : word;
}

// A Codex `unified_exec` (or `Bash`) command arrives as an argv array; Claude's `Bash` sends
// one string. `<shell> -c "<script>"` is the form an agent actually sends, and re-joining that
// would lose the quoting the script depends on, so the script itself is what gets read — from
// any single-dash flag cluster ending the option list with `c`, because `bash -lc` and
// `sh -ec` are as common as the bare `-c` and joining them reads as an unknown command rather
// than as the write they carry.
function commandOf(value) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value) || !value.length) return '';
  const argv = value.map(String);
  const first = argv[0].split(/[\\/]/).pop().replace(/\.exe$/i, '');
  if (SHELLS.test(first)) {
    for (let i = 1; i < argv.length; i += 1) {
      const word = argv[i];
      if (!word.startsWith('-') || word === '--') break;
      if (/^-[A-Za-z]*$/.test(word) && word.includes('c')) {
        return i + 1 < argv.length ? argv[i + 1] : '';
      }
    }
  }
  return argv.map(shellQuote).join(' ');
}

// One payload, one request, whichever envelope it arrived in. The legacy Codex envelope names
// its tool in `hook` and its arguments in `input`; the current one — Claude's too — names them
// in `tool_name` and `tool_input`.
function requestFrom(payload) {
  const body = payload && typeof payload === 'object' ? payload : {};
  const cwd = path.resolve(String(body.cwd || process.cwd()));
  const sessionId = String(body.session_id || body.sessionId || '');
  const base = { cwd, sessionId };

  const legacy = String(body.hook || '');
  const tool = legacy || String(body.tool_name || body.toolName || '');
  if (!tool) return null;
  const raw = legacy ? body.input : (body.tool_input || body.toolInput || body.input);
  const input = raw && typeof raw === 'object' ? raw : {};

  if (PATCH_TOOLS.has(tool)) {
    const patch = String(input.patch || input.diff || input.input || '');
    return patch.trim() ? { ...base, action: 'patch', patch } : null;
  }
  if (SHELL_TOOLS.has(tool)) {
    const value = input.command !== undefined ? input.command
      : (input.argv !== undefined ? input.argv : input.cmd);
    const command = commandOf(value);
    return command.trim() ? { ...base, action: 'shell', command } : null;
  }
  if (Object.prototype.hasOwnProperty.call(WRITE_TOOLS, tool)) {
    const file = String(input[WRITE_TOOLS[tool]] || '');
    return file ? { ...base, action: 'write', path: file } : null;
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
