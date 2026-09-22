#!/usr/bin/env node
// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0
'use strict';

// This file is copied into each host client's hook directory by write-protection.js.
// The client is selected by the installed command, never by untrusted hook input.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const CLAUDE_FILES = Object.freeze({
  Write: 'file_path', Edit: 'file_path', MultiEdit: 'file_path', NotebookEdit: 'notebook_path',
});
const DENIAL = 'write-protection: this write could not be authorized; check the host guard and lease.';

function commandOf(value) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value) || value.length === 0) return null;
  const name = String(value[0]).split(/[\\/]/).pop();
  if (/^(sh|bash|dash|zsh|ksh)$/.test(name) && value[1] === '-c') return String(value[2] || '');
  return value.map(String).join(' ');
}

function requestFrom(payload, client, env = process.env) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('invalid hook payload');
  if (typeof payload.cwd !== 'string' || !payload.cwd.trim()) throw new Error('missing hook cwd');
  const cwd = path.resolve(payload.cwd);
  // Both values come from the launcher environment, never from model-controlled JSON.
  const base = {
    cwd,
    sessionId: String(env.PIPELINE_WRITE_SESSION_ID || ''),
    token: String(env.PIPELINE_WRITE_LEASE_TOKEN || ''),
  };
  if (base.token) {
    const presentedSession = payload.session_id || payload.sessionId;
    if (!base.sessionId || typeof presentedSession !== 'string'
        || presentedSession !== base.sessionId) throw new Error('lease session mismatch');
  }
  if (client === 'claude') {
    const tool = payload.tool_name;
    const input = payload.tool_input;
    if (!Object.prototype.hasOwnProperty.call(CLAUDE_FILES, tool)
        && tool !== 'Bash' && tool !== 'PowerShell') return null;
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('missing hook tool_input');
    if (tool === 'Bash' || tool === 'PowerShell') {
      if (typeof input.command !== 'string' || !input.command.trim()) throw new Error('missing shell command');
      // The guard's conservative shell reader never treats PowerShell syntax as Bash.
      // Prefix it as an interpreter invocation so protected repos fail closed.
      return { ...base, action: 'shell', command: tool === 'PowerShell'
        ? `powershell ${input.command}` : input.command };
    }
    const p = input[CLAUDE_FILES[tool]];
    if (typeof p !== 'string' || !p.trim()) throw new Error('missing write path');
    return { ...base, action: 'write', path: p };
  }
  if (client === 'codex') {
    const hook = payload.hook;
    const tool = payload.tool_name;
    if (tool !== 'Bash' && tool !== 'apply_patch' && hook !== 'unified_exec'
        && hook !== 'exec' && hook !== 'shell' && hook !== 'apply_patch') return null;
    const input = payload.tool_input || payload.input;
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('missing hook tool_input');
    if (tool === 'apply_patch' || hook === 'apply_patch') {
      const patch = input.command || input.patch || input.input;
      if (typeof patch !== 'string' || !patch.trim()) throw new Error('missing patch');
      return { ...base, action: 'patch', patch };
    }
    const command = commandOf(input.command || input.argv || input.cmd);
    if (typeof command !== 'string' || !command.trim()) throw new Error('missing shell command');
    return { ...base, action: 'shell', command };
  }
  throw new Error('unknown client');
}

function askGuard(request) {
  const guard = path.join(__dirname, 'write-guard.js');
  if (!fs.existsSync(guard)) throw new Error('host guard is missing');
  const r = spawnSync(process.execPath, [guard], {
    input: JSON.stringify(request), encoding: 'utf8', timeout: 15000, windowsHide: true,
  });
  if (r.error || r.status !== 0 && r.status !== 2) throw new Error('host guard failed');
  let body;
  try { body = JSON.parse(String(r.stdout || '').trim()); } catch { throw new Error('invalid guard response'); }
  if (!body || !['allow', 'deny'].includes(body.decision) || typeof body.reason !== 'string') {
    throw new Error('invalid guard decision');
  }
  if ((r.status === 0) !== (body.decision === 'allow')) throw new Error('inconsistent guard response');
  return body;
}

function respond(client, decision) {
  if (decision.decision === 'allow') return 0;
  const reason = `write-protection: ${decision.reason || DENIAL}`;
  if (client === 'codex') {
    process.stdout.write(`${JSON.stringify({ hookSpecificOutput: {
      hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason,
    } })}\n`);
    return 0;
  }
  process.stderr.write(`${reason}\n`);
  return 2;
}

function main(argv, env = process.env) {
  const at = argv.indexOf('--client');
  const client = at >= 0 ? argv[at + 1] : null;
  if (!['claude', 'codex'].includes(client)) {
    process.stderr.write(`${DENIAL}\n`);
    return 2;
  }
  try {
    const payload = JSON.parse(fs.readFileSync(0, 'utf8'));
    const request = requestFrom(payload, client, env);
    if (!request) return 0;
    return respond(client, askGuard(request));
  } catch {
    return respond(client, { decision: 'deny', reason: 'host guard unavailable or hook request invalid' });
  }
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { requestFrom, askGuard, main };
