#!/usr/bin/env node
// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// The host-only bridge between an agent CLI's tool-call hook and the pipeline-first write
// guard (change-log row `repo-324`). One file, two clients, chosen by the shape of the
// payload rather than by a flag — the caller is a hook and has nothing to pass.
//
//   Claude   {"session_id":…,"cwd":…,"tool_name":"Write|Edit|MultiEdit|NotebookEdit|Bash",
//             "tool_input":{…}}          (Bash carries a command LINE, a string)
//   Codex    {"session_id":…,"cwd":…,"tool_name":"Bash"|"apply_patch",
//             "tool_input":{"command":[argv]|"<command line>"}}   (Bash carries an argv ARRAY)
//   Codex    {"session_id":…,"cwd":…,"hook":"apply_patch"|"unified_exec",
//    (legacy) "input":{"patch":…}|{"command":[…]}}
//
// Both current clients send the same `tool_name` / `tool_input` envelope. `apply_patch` is a
// Codex-only tool name, so it is always the current Codex dialect; `Bash` is sent by both, and
// is told apart by the SHAPE of `tool_input.command` — an argv array only a shell-out client
// would produce is Codex, a command line string is Claude. The legacy dialect is still
// understood — what the contract's `toolPaths` says is what is INSTALLED, never what is
// UNDERSTOOD, and dropping a payload dialect unguards whatever still speaks it.
//
//   allow                                exit 0, silent, on every dialect
//   deny, Claude / legacy Codex dialect  exit 2, a plain-text reason on stderr
//   deny, current Codex dialect          exit 0 — the exit Codex reads as "the hook ran and
//                                        rendered a decision", never a crash — carrying one
//                                        JSON object on stdout: `hookSpecificOutput
//                                        .hookEventName === "PreToolUse"`, `.permissionDecision
//                                        === "deny"`, and a write-protection-worded reason.
//                                        `hookSpecificOutput` is a Codex-native shape; the exit
//                                        2 that shipped in PR #82 was treated as a HOOK FAILURE
//                                        rather than a deliberate decision and dispatched the
//                                        protected write anyway (change-log row `repo-wwi`).
//
// Why it is a separate file from the guard: the knowledge that a tool call arrives as JSON
// on stdin with `tool_name`, and what an allow or a refusal looks like on the wire, belongs to
// one CLI and is wrong the day that CLI is swapped. Replacing a harness means rewriting this
// file and nothing else — the same boundary `scripts/session-guard-bridge.js` draws, for the
// same reason.
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

// A Codex command arrives as an argv array. `sh -c "<script>"` is the form an agent actually
// sends, and joining it back into one string would lose the quoting the script depends on, so
// the script itself is what gets read. The flag is matched as any single-dash cluster ENDING in
// `c` — `bash -lc` and `sh -ec` are as common as `-c`, and joining one of those back up makes
// the guard answer `unknown-shell-form`, which refuses for the wrong reason and hides whether
// the command was understood at all.
function commandOf(value) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value) || !value.length) return '';
  const first = String(value[0] || '').split(/[\\/]/).pop().replace(/\.(exe|cmd|bat)$/i, '');
  if (value.length >= 3 && /^(sh|bash|dash|zsh|ksh)$/.test(first) && /^-[a-z]*c$/.test(String(value[1]))) {
    return String(value[2]);
  }
  return value.map(String).join(' ');
}

// The `apply_patch` envelope, wherever this client put it: its own key, or — the current
// dialect — an argv array whose first word is the tool and whose second is the patch text.
function patchOf(input) {
  for (const key of ['patch', 'input', 'patch_text']) {
    if (typeof input[key] === 'string' && input[key].trim()) return input[key];
  }
  const command = input.command === undefined ? input.argv : input.command;
  if (typeof command === 'string') return command;
  if (!Array.isArray(command)) return '';
  const parts = command.map(String);
  const envelope = parts.find((p) => /^\s*\*\*\*\s+Begin Patch/im.test(p) || /^\s*(?:---|\+\+\+|@@)/m.test(p));
  if (envelope) return envelope;
  return parts.filter((p) => !/^apply_patch$/i.test(p.trim())).join('\n');
}

// Tool names that carry a command to run rather than a file to write. Claude sends `Bash`;
// Codex sends `Bash` in the current dialect and named its shell tool several other things
// along the way, all of which are still answered.
const SHELL_TOOLS = new Set(['Bash', 'bash', 'unified_exec', 'exec', 'shell', 'local_shell']);

function requestFrom(payload) {
  const cwd = path.resolve(String((payload && payload.cwd) || process.cwd()));
  const sessionId = String((payload && (payload.session_id || payload.sessionId)) || '');
  const base = { cwd, sessionId, currentCodex: false };

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
  const input = (payload && payload.tool_input) || {};
  if (Object.prototype.hasOwnProperty.call(WRITE_TOOLS, tool)) {
    const file = String(input[WRITE_TOOLS[tool]] || '');
    return file ? { ...base, action: 'write', path: file } : null;
  }
  if (tool === 'apply_patch') {
    const patch = patchOf(input);
    return patch.trim() ? { ...base, action: 'patch', patch, currentCodex: true } : null;
  }
  if (SHELL_TOOLS.has(tool)) {
    // `local_shell` nests its argv one level down; every other spelling carries it directly.
    const carried = input.command === undefined ? (input.argv === undefined ? input.cmd : input.argv)
      : input.command;
    const action = (input.action && typeof input.action === 'object') ? input.action : null;
    const rawCommand = carried === undefined && action ? action.command : carried;
    const command = commandOf(rawCommand);
    // `Bash` is the one tool name both clients send; an argv ARRAY is a shell-out client
    // (Codex) and a command-line STRING is Claude's own dialect. Every other spelling in
    // `SHELL_TOOLS` is Codex-only naming, current or legacy, so it is always the current dialect.
    const currentCodex = tool === 'Bash' ? Array.isArray(rawCommand) : true;
    return command.trim() ? { ...base, action: 'shell', command, currentCodex } : null;
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

  if (request.currentCodex) {
    process.stdout.write(`${JSON.stringify(structuredDeny(reason, request))}\n`);
    return 0;
  }
  process.stderr.write(`${explain(reason, request)}\n`);
  return 2;
}

// What a person — or a model that is about to try the same thing a second way — needs next.
// Shared between the legacy plain-text refusal and the current dialect's structured reason,
// because the underlying decision and its rationale are the same; only the transport differs.
const REASON_HEAD = {
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
};

function reasonHead(reason) {
  return REASON_HEAD[reason] || 'this checkout is pipeline-first.';
}

function explain(reason, request) {
  return [
    `write-protection: ${reasonHead(reason)}`,
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

// Codex's own hook-decision shape: a successful hook run (exit 0) that renders `deny` rather
// than crashing (PR #82's exit 2, which Codex counts as a HOOK FAILURE and dispatches through
// anyway). `permissionDecisionReason` is one of several keys this could have used —
// `hookSpecificOutput` is a free-form object, and the reason's own key name is left free the
// same way `command`/`command_windows` was left free in the config profile.
function structuredDeny(reason, request) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `write-protection: ${reasonHead(reason)} Plan the change and freeze `
        + 'its acceptance suite, then let a run make it. Read-only inspection is unaffected. Check '
        + `enforcement with: node scripts/write-protection.js status (cwd ${request.cwd})`,
    },
  };
}

process.exit(main());
