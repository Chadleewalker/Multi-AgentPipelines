#!/usr/bin/env node
// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// The host-only bridge between one agent CLI's tool-call hook and this repo's
// harness-neutral write guard (change-log row `session-write-guard`).
//
// Why it is a separate file from the guard. The rule being enforced — one session, one
// folder — belongs to the project and outlives any particular agent CLI. The knowledge
// that a tool call arrives as JSON on stdin with `tool_name` and `tool_input`, and that
// exit code 2 means "refuse and show this to the model", belongs to one CLI and would be
// wrong the day that CLI is swapped. So the guard speaks its own vocabulary and this
// forty-line file does the translation. Replacing the harness means rewriting this file
// and nothing else.
//
// Why it is INSTALLED rather than committed into place. This repo is a target of its own
// pipeline, so every tracked file is cloned into a task container that has no agent CLI
// and no network. A tracked hook CONFIGURATION would fire in there and fail on every
// session — `tests/unit/agent-hooks.test.js` refuses exactly that, and it exists because
// the same entry crept back once already. This file is inert: nothing tracked references
// it, so nothing tracked makes it run. `scripts/install-session-guard.js` copies it to
// the host's agent-config directory and adds the hook entry there, where the config is
// git-ignored and the container never sees it.
//
// It answers for EVERY repository the host opens, so its first job is to have no opinion
// about repositories that do not carry the guard: no `scripts/session-guard.js` above the
// working directory means exit 0, immediately, with nothing spawned.
//
// Fails open at every step, for the reason the guard does — see the header there.
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// Which tool inputs name a file this guard should judge. Anything not listed here — a
// read, a search, a web fetch — is none of its business.
const WRITE_TOOLS = {
  Write: 'file_path',
  Edit: 'file_path',
  MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path',
};

function main() {
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    return 0;
  }

  const tool = String((payload && payload.tool_name) || '');
  const input = (payload && payload.tool_input) || {};
  const cwd = path.resolve(String((payload && payload.cwd) || process.cwd()));

  let action = null;
  const arg = {};
  if (Object.prototype.hasOwnProperty.call(WRITE_TOOLS, tool)) {
    action = 'write';
    arg.path = String(input[WRITE_TOOLS[tool]] || '');
    if (!arg.path) return 0;
  } else if (tool === 'Bash') {
    action = 'shell';
    arg.command = String(input.command || '');
    if (!arg.command.trim()) return 0;
  } else {
    return 0;
  }

  // Nearest guard at or above the working directory. A worktree carries its own copy of
  // the tracked tree, so this resolves to the guard on the branch that folder is on —
  // which is the right one: a session testing a change to the guard tests it on itself.
  let dir = cwd;
  let guard = null;
  for (;;) {
    const candidate = path.join(dir, 'scripts', 'session-guard.js');
    if (fs.existsSync(candidate)) {
      guard = candidate;
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (!guard) return 0;

  const r = spawnSync(process.execPath, [guard], {
    input: JSON.stringify({ cwd, action, ...arg }),
    encoding: 'utf8',
    timeout: 20000,
    windowsHide: true,
  });
  if (r.error || typeof r.status !== 'number') return 0;
  if (r.status === 2) {
    process.stderr.write(r.stderr || 'session-guard: refused\n');
    return 2;
  }
  return 0;
}

process.exit(main());
