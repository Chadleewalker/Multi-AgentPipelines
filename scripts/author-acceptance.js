#!/usr/bin/env node
// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0
'use strict';

// The V1 planning-side acceptance author. This process is the lease controller:
// only its child Claude session may write one issue's acceptance suite, and the
// lease is revoked before this command exits. Freeze and publication are separate.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { loadConfig } = require('../runner/config');
const policy = require('./write-protection-policy');
const { doctor, clientDir } = require('./write-protection');

const ISSUE = /^[A-Za-z][A-Za-z0-9._-]*$/;
const MAX_OUTPUT = 64 * 1024 * 1024;
const AUTHOR_TOOLS = 'Read,Glob,Grep,Write,Edit';

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (['--config', '--worktree', '--prompt-file'].includes(arg)) {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`${arg} needs a value`);
      options[arg.slice(2)] = argv[++i];
    } else if (!arg.startsWith('-') && !options.issue) options.issue = arg;
    else throw new Error(`unexpected argument ${arg}`);
  }
  if (!ISSUE.test(options.issue || '')) throw new Error('one valid issue id is required');
  for (const name of ['config', 'worktree', 'prompt-file']) {
    if (!options[name]) throw new Error(`--${name} is required`);
  }
  return options;
}

function runGit(cwd, args, spawn = spawnSync) {
  const result = spawn('git', args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 30000 });
  if (result.error || result.status !== 0) {
    throw new Error(`git ${args[0]} failed: ${(result.stderr || result.error?.message || result.status).toString().trim()}`);
  }
  return String(result.stdout || '').trim();
}

function sameCommonDir(first, second, spawn = spawnSync) {
  const common = (dir) => {
    const value = runGit(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir'], spawn);
    return path.normalize(fs.realpathSync(value)).toLowerCase();
  };
  return common(first) === common(second);
}

function changedPaths(worktree, spawn = spawnSync) {
  const result = spawn('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching'],
    { cwd: worktree, encoding: 'utf8', windowsHide: true, timeout: 30000 });
  if (result.error || result.status !== 0) throw new Error('cannot audit author worktree');
  const fields = String(result.stdout || '').split('\0');
  const paths = [];
  for (let i = 0; i < fields.length && fields[i]; i += 1) {
    const field = fields[i];
    if (field.length < 4 || field[2] !== ' ') throw new Error('malformed git status record');
    paths.push(field.slice(3).replace(/\\/g, '/'));
    if (/^[RC]/.test(field) || /^[RC]/.test(field[1])) {
      if (!fields[i + 1]) throw new Error('malformed git rename record');
      paths.push(fields[++i].replace(/\\/g, '/'));
    }
  }
  return paths;
}

function auditSuite(worktree, issue, spawn = spawnSync) {
  const prefix = `tests/acceptance/${issue}/`;
  const outside = changedPaths(worktree, spawn).filter((file) => !file.startsWith(prefix));
  return { ok: outside.length === 0, outside };
}

function suiteFingerprint(worktree, issue) {
  const suite = path.join(worktree, 'tests', 'acceptance', issue);
  if (!fs.existsSync(suite)) return '';
  const records = [];
  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error('acceptance suite contains a symlink');
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile()) {
        const relative = path.relative(suite, file).split(path.sep).join('/');
        records.push(`${relative}:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`);
      } else throw new Error('acceptance suite contains an unsupported file');
    }
  }
  visit(suite);
  return records.sort().join('\n');
}

function authorPrompt(issue, text) {
  return [
    `You are writing the V1 pipeline acceptance suite for issue ${issue}.`,
    `Read the target's relevant code and test conventions. Write only under tests/acceptance/${issue}/.`,
    'These tests precede implementation and must fail with collected behavioral assertions at the fork point.',
    'Do not edit implementation, configuration, planning, other suites, or Git metadata.',
    'You have Read, Glob, Grep, Write and Edit only. Do not invoke commands or delegate code execution.',
    'The supplied issue brief and acceptance criteria follow:',
    text.trim(),
  ].join('\n\n') + '\n';
}

function author(options, seams = {}) {
  const spawn = seams.spawn || spawnSync;
  const guard = seams.policy || policy;
  const config = loadConfig(options.config);
  const worktree = fs.realpathSync(path.resolve(options.worktree));
  const target = fs.realpathSync(path.resolve(config.targetRepoPath));
  const issue = options.issue;
  if (!ISSUE.test(issue || '')) throw new Error('invalid issue id');
  if (!sameCommonDir(worktree, target, spawn)) throw new Error('worktree is not part of the configured target repository');
  if (!fs.existsSync(path.join(worktree, 'pipeline.config.json'))) throw new Error('worktree is not a V1 pipeline target');
  if (!/^claude-[A-Za-z0-9.-]+$/.test(config.model)) throw new Error('test author needs a pinned Claude model in run config');
  const promptText = fs.readFileSync(path.resolve(options['prompt-file']), 'utf8');
  if (!promptText.trim()) throw new Error('prompt file is empty');
  const before = auditSuite(worktree, issue, spawn);
  if (!before.ok) throw new Error(`worktree has changes outside tests/acceptance/${issue}/: ${before.outside.join(', ')}`);
  const beforeFingerprint = suiteFingerprint(worktree, issue);

  const diagnosis = (seams.doctor || doctor)();
  if (!diagnosis.ok) throw new Error(`write guard doctor failed: ${diagnosis.reason || 'unknown'}`);
  if (process.env.CLAUDE_CODE_SAFE_MODE || process.env.CLAUDE_CODE_SIMPLE) {
    throw new Error('Claude safe/bare mode disables the required host hook');
  }
  const leaseMinutes = Math.min(Math.ceil(config.wallClockMinutes || 60), 120);
  const sessionId = crypto.randomUUID();
  const lease = guard.createLease({
    target: worktree, role: 'test-author', issueId: issue, sessionId,
    controllerPid: process.pid, minutes: leaseMinutes,
  });
  if (!lease || !lease.leaseId || !lease.token) throw new Error('write guard did not grant a lease');

  let result;
  let after;
  try {
    const args = [
      '-p', '--model', config.model, '--session-id', sessionId,
      // Restricted mode confines file tools to this worktree. Explicit --settings keeps
      // the installed host hook active even though restricted mode ignores user settings.
      '--restricted', '--settings', path.join(clientDir('claude'), 'settings.json'),
      '--tools', AUTHOR_TOOLS, '--allowedTools', AUTHOR_TOOLS,
      '--disallowedTools', 'Bash,PowerShell,Task,NotebookEdit,WebFetch',
      '--permission-mode', 'acceptEdits', '--permission-prompts', 'none',
      '--strict-mcp-config', '--disable-slash-commands', '--no-chrome',
      '--no-session-persistence', '--output-format', 'json',
    ];
    result = spawn('claude', args, {
      cwd: worktree, encoding: 'utf8', windowsHide: true,
      input: authorPrompt(issue, promptText), timeout: leaseMinutes * 60000,
      maxBuffer: MAX_OUTPUT,
      env: {
        ...process.env,
        PIPELINE_WRITE_LEASE_TOKEN: lease.token,
        PIPELINE_WRITE_SESSION_ID: sessionId,
      },
    });
    after = auditSuite(worktree, issue, spawn);
  } finally {
    guard.revokeLease(lease.leaseId);
  }
  if (!after.ok) throw new Error(`author wrote outside tests/acceptance/${issue}/: ${after.outside.join(', ')}`);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Claude test author failed (${result.status}): ${String(result.stderr || result.stdout || '').slice(0, 4000)}`);
  let response;
  try { response = JSON.parse(String(result.stdout || '')); } catch { throw new Error('Claude returned no valid completion record'); }
  if (response.is_error || response.type !== 'result' || response.subtype !== 'success') {
    throw new Error('Claude did not report a completed successful author session');
  }
  const afterFingerprint = suiteFingerprint(worktree, issue);
  if (!afterFingerprint || afterFingerprint === beforeFingerprint) {
    throw new Error(`author completed without changing the issue acceptance suite: ${String(response.result || '').slice(0, 2000)}`);
  }
  return { issue, model: config.model, sessionId, paths: changedPaths(worktree, spawn), response: response.result || '' };
}

function usage() {
  return 'usage: node scripts/author-acceptance.js <issue-id> --config run.config.<project>.json --worktree <target-worktree> --prompt-file <issue-brief.txt>';
}

function main(argv) {
  try {
    const options = parseArgs(argv);
    if (options.help) { console.log(usage()); return 0; }
    const result = author(options);
    console.log(`Acceptance author completed for ${result.issue} with ${result.model}; files: ${result.paths.join(', ') || '(none)'}`);
    if (!result.paths.length) throw new Error('author completed without an acceptance suite change');
    return 0;
  } catch (error) {
    console.error(`author-acceptance: ${error.message}`);
    return 1;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { parseArgs, runGit, sameCommonDir, changedPaths, auditSuite, suiteFingerprint,
  authorPrompt, author, main, usage };
