#!/usr/bin/env node
// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// The host-only bridge between an agent CLI's tool-call hook and the pipeline-first write
// guard (change-log row `repo-324`, corrected by `repo-wwi`). One file, three dialects.
//
//   legacy Codex   {"session_id":…,"cwd":…,"hook":"apply_patch"|"unified_exec",
//                   "input":{"patch":…}|{"command":[…]}}
//   Claude         {"session_id":…,"cwd":…,"tool_name":"Write|Edit|MultiEdit|NotebookEdit|Bash",
//                   "tool_input":{…}}
//   current Codex  {"session_id":…,"cwd":…,"tool_name":"Bash"|"apply_patch",
//                   "tool_input":{"command":"<string>"}}
//
// `repo-gy3` (PR #82) and rejected PR #83 both tried to tell the last two apart by the SHAPE
// of `tool_input.command` — an argv array meant Codex, a string meant Claude. Real Codex
// 0.151.0-alpha.7.1 sends a STRING for both `Bash` and `apply_patch`, the same shape Claude's
// own `Bash` calls already use, so that discriminator cannot work: after both hooks were
// interactively trusted, `apply_patch` denied correctly but `Bash` fell through to the
// Claude branch's `exit 2`, which Codex logs as `PreToolUse Failed` and then runs the
// protected write anyway. The discriminator is now the INSTALLED INVOCATION, never the
// payload: `install` writes `--client codex` into the Codex-installed command and
// `--client claude` into the Claude-installed one, and this file trusts that flag over
// anything it can infer from `tool_input.command`'s type. No branch below may classify a
// current-dialect request by assuming that value is an array.
//
//   `--client codex`   exit 0 always; a refusal is one JSON object on stdout carrying
//                       `hookSpecificOutput.hookEventName`/`permissionDecision`/
//                       `permissionDecisionReason` — the exit code Codex reads as "the hook
//                       ran and rendered a decision", never a crash. A read-only payload
//                       continues silently (exit 0, no body).
//   everything else     (`--client claude`, or no `--client` at all — every already-deployed
//                       legacy hook) keeps the historical `exit 2` plus a plain-text reason
//                       on stderr, unchanged.
//
// Why it is a separate file from the guard: the knowledge that a tool call arrives as JSON
// on stdin with `tool_name`, and what exit code and body a given client reads as a decision,
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

// The current Codex dialect: `tool_input.command` is a STRING for both `Bash` and
// `apply_patch` — never assume an array here, that assumption is exactly what made rejected
// PR #83 dispatch nothing useful for `Bash`.
function requestFromCurrentCodex(payload) {
  const cwd = path.resolve(String((payload && payload.cwd) || process.cwd()));
  const sessionId = String((payload && (payload.session_id || payload.sessionId)) || '');
  const base = { cwd, sessionId };
  const tool = String((payload && payload.tool_name) || '');
  const command = String(((payload && payload.tool_input) || {}).command || '');
  if (!command.trim()) return null;
  if (tool === 'apply_patch') return { ...base, action: 'patch', patch: command };
  if (tool === 'Bash') return { ...base, action: 'shell', command };
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

function askGuard(request) {
  const guard = locateGuard(request.cwd);
  if (!guard) return null;
  const r = spawnSync(process.execPath, [guard], {
    input: JSON.stringify(request), encoding: 'utf8', timeout: 30000, windowsHide: true,
  });
  if (r.error || typeof r.status !== 'number') return null;
  return r;
}

function reasonFrom(stdout) {
  try { return String((JSON.parse(String(stdout || '').trim()) || {}).reason || ''); }
  catch { return ''; }
}

function clientFromArgv(argv) {
  const i = argv.indexOf('--client');
  if (i === -1 || i + 1 >= argv.length) return null;
  return String(argv[i + 1]);
}

// The current Codex client: structured JSON on stdout, exit 0 either way — the exit code
// Codex reads as "the hook ran and rendered a decision", never a crash.
function mainCurrentCodex(payload) {
  const request = requestFromCurrentCodex(payload);
  if (!request) return 0;
  const r = askGuard(request);
  if (!r || r.status !== 2) return 0;
  const reason = reasonFrom(r.stdout);
  const body = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reasonText(reason),
    },
  };
  process.stdout.write(`${JSON.stringify(body)}\n`);
  return 0;
}

// Legacy dialect: the `hook`/`input` Codex shape and Claude's own tools, both on the
// historical exit 2 plus a plain-text reason on stderr — unchanged by this issue.
function mainLegacy(payload) {
  const request = requestFrom(payload);
  if (!request) return 0;
  const r = askGuard(request);
  if (!r || r.status !== 2) return 0;
  const reason = reasonFrom(r.stdout);
  process.stderr.write(`${explain(reason, request)}\n`);
  return 2;
}

function main(argv) {
  let payload;
  try { payload = JSON.parse(fs.readFileSync(0, 'utf8')); } catch { return 0; }

  const client = clientFromArgv(argv);
  if (client === 'codex') return mainCurrentCodex(payload);
  return mainLegacy(payload);
}

// What a person — or a model that is about to try the same thing a second way — needs next.
// Kept here rather than in the guard because it is client-facing text, not policy. Shared by
// both the exit-2 stderr explanation and the exit-0 structured `permissionDecisionReason`.
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

function reasonText(reason) {
  return `write-protection: ${REASON_HEAD[reason] || 'this checkout is pipeline-first.'}`;
}

function explain(reason, request) {
  const head = REASON_HEAD[reason] || 'this checkout is pipeline-first.';
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

process.exit(main(process.argv.slice(2)));
