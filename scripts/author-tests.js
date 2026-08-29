#!/usr/bin/env node
// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0
'use strict';

// Planning-side bridge from the deterministic spec brief to one pinned Claude session.
// It writes only by creating the issue worktree and by letting the test author work there.
// Freezing, committing and pushing remain explicit human-approved operations.

const fs = require('fs');
const path = require('path');
const { runSync, failureText } = require('../runner/process');
const { buildBrief } = require('./spec-brief');

const EXIT_OK = 0;
const EXIT_USAGE = 2;
const EXIT_SETUP = 3;
const EXIT_AGENT = 4;
const MAX_BUFFER = 64 * 1024 * 1024;
const USAGE = 'usage: node scripts/author-tests.js <issue-id> --config run.config.<project>.json';

function parseArgs(argv) {
  const opts = { id: null, config: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--config') {
      const value = argv[++i];
      if (value === undefined || value.startsWith('--')) return { error: '--config needs a value' };
      opts.config = value;
    } else if (arg === '-h' || arg === '--help') opts.help = true;
    else if (arg.startsWith('--')) return { error: `unknown option "${arg}"` };
    else if (opts.id) return { error: `only one issue id at a time (got "${arg}" after "${opts.id}")` };
    else opts.id = arg;
  }
  return opts;
}

function branchExists(cfg, branch, run = runSync) {
  const r = run('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], {
    cfg, kind: 'git', cwd: cfg.targetRepoPath, label: `find branch ${branch}`,
  });
  return r.status === 0;
}

function ensureWorktree(built, run = runSync) {
  if (built.folder.exists) return { ok: true, created: false };
  const args = ['worktree', 'add'];
  const exists = branchExists(built.cfg, built.folder.branch, run);
  if (!exists) args.push('-b', built.folder.branch);
  args.push(built.folder.dir, exists ? built.folder.branch : built.branch);
  const r = run('git', args, {
    cfg: built.cfg, kind: 'git', cwd: built.cfg.targetRepoPath,
    label: `create test-author worktree ${built.folder.branch}`,
  });
  if (r.status !== 0) return { ok: false, error: failureText(r, 'git worktree add failed') };
  return { ok: true, created: true };
}

function launchAuthor(built, model, run = runSync) {
  // -p reads the prompt from stdin when no prompt argv follows it. That avoids both a shell and
  // Windows' command-line length limit. Permissions stay at the host user's normal policy.
  const timeoutMs = Math.max(1, Number(built.cfg.wallClockMinutes) || 240) * 60 * 1000;
  return run(process.env.PIPELINE_TEST_AUTHOR_CMD || 'claude',
    ['-p', '--model', model], {
      cfg: built.cfg, cwd: built.folder.dir, input: `${built.text}\n`, timeoutMs,
      label: 'Claude test-author session', maxBuffer: MAX_BUFFER, env: process.env,
    });
}

function nextStep(id, configPath) {
  return `Human approval is mandatory. Review the suite and agent report; only then run: node scripts/freeze.js commit ${id} --config ${configPath}`;
}

function failureStep() {
  return 'Next human step: inspect the agent failure and worktree, then fix the prerequisite or rerun author-tests. Do not freeze a failed session.';
}

function main(argv, io = {}, seams = {}) {
  const out = io.out || console.log; const err = io.err || console.error;
  const opts = parseArgs(argv);
  if (opts.help) { out(USAGE); return EXIT_OK; }
  if (opts.error || !opts.id || !opts.config) {
    err(`author-tests: ${opts.error || 'an issue id and --config are required'}`); err(USAGE); return EXIT_USAGE;
  }
  const builder = seams.buildBrief || buildBrief;
  let built = builder(opts);
  if (!built.ok) {
    err(`author-tests: ${built.error}`);
    return built.kind === 'config' ? EXIT_USAGE : EXIT_SETUP;
  }
  const configPath = path.resolve(opts.config);
  const model = String(built.cfg.testAuthorModel || built.cfg.model || '').trim();
  if (!model) { err('author-tests: no model is available; set testAuthorModel or model in the run config'); return EXIT_SETUP; }

  out(`Issue: ${opts.id}`); out(`Selected test-author model: ${model}`);
  if (built.state === 'ready') {
    out('Outcome: no launch — the suite is already frozen and dispatchable.');
    out('Next human step: review the existing frozen suite before launching the pipeline.');
    return EXIT_OK;
  }
  if (built.state !== 'write') {
    out(`Worktree: ${built.folder.dir}`);
    out(`Outcome: no launch — state is ${built.state}; writing tests is unnecessary.`);
    out(nextStep(opts.id, configPath));
    return EXIT_OK;
  }

  const made = ensureWorktree(built, seams.runSync || runSync);
  if (!made.ok) { err(`author-tests: cannot prepare ${built.folder.dir}: ${made.error}`); return EXIT_SETUP; }
  if (!fs.existsSync(built.folder.dir)) { err(`author-tests: worktree was not created: ${built.folder.dir}`); return EXIT_SETUP; }
  // The first brief necessarily contained `git worktree add` when the tree was absent. Rebuild
  // after creation so git's registry supplies the now-existing folder and the launched agent's
  // first instruction is to work there, not to try to create it a second time.
  if (made.created) {
    const refreshed = builder(opts);
    if (!refreshed.ok || refreshed.state !== 'write' || !refreshed.folder.exists) {
      err(`author-tests: worktree was created but the spec brief could not resolve it: ${refreshed.error || refreshed.state}`);
      return EXIT_SETUP;
    }
    built = refreshed;
  }
  out(`Worktree: ${built.folder.dir}${made.created ? ' (created)' : ' (reused)'}`);
  out(`Launching Claude with explicit model alias ${model}; freeze/commit/push are not part of this command.`);
  const r = (seams.launchAuthor || launchAuthor)(built, model, seams.runSync || runSync);
  if (r.stdout) out(String(r.stdout).trimEnd());
  if (r.stderr) err(String(r.stderr).trimEnd());
  if (r.status !== 0) {
    if (!r.stderr && !r.stdout) err(`author-tests: ${failureText(r, 'Claude executable failed')}`);
    err(`Outcome: test-author agent failed (exit ${r.status === null ? 'unavailable' : r.status}).`);
    err(failureStep());
    return EXIT_AGENT;
  }
  out('Outcome: test-author agent exited successfully. No commit or push was performed by the launcher.');
  out(nextStep(opts.id, configPath));
  return EXIT_OK;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { main, parseArgs, ensureWorktree, launchAuthor, nextStep, failureStep, EXIT_USAGE, EXIT_SETUP, EXIT_AGENT };
