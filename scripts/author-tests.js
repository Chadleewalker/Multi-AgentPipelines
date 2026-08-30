#!/usr/bin/env node
// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0
'use strict';

// Planning-side bridge from the deterministic spec brief to one pinned Claude session.
// It writes only by creating the issue worktree and by letting the test author work there.
// Freezing, committing and pushing remain explicit human-approved operations.

const fs = require('fs');
const path = require('path');
const { loadConfig } = require('../runner/config');
const { runSync, failureText } = require('../runner/process');
const { acquire, release } = require('../runner/lock');
const { buildBrief, verifyCommandError } = require('./spec-brief');
const { proveTests, validIssueId } = require('./prove-tests');

const EXIT_OK = 0;
const EXIT_USAGE = 2;
const EXIT_SETUP = 3;
const EXIT_AGENT = 4;
const EXIT_PROBE = 5;
const MAX_BUFFER = 64 * 1024 * 1024;
const USAGE = 'usage: node scripts/author-tests.js <issue-id> --config run.config.<project>.json';
const AUTHOR_TOOLS = 'Read,Edit,Write,Glob,Grep,Bash';
const DENIED_TOOLS = [
  'Bash(git commit*)', 'Bash(git push*)', 'Bash(git merge*)',
  'Bash(git rebase*)', 'Bash(git reset*)', 'Bash(git * commit*)',
  'Bash(git * push*)', 'Bash(git * merge*)', 'Bash(git * rebase*)',
  'Bash(git * reset*)', 'Bash(bd *)', 'Bash(bd*)',
  'Bash(node *freeze.js*)',
].join(',');
const ROOT = path.resolve(__dirname, '..');

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
  const unsafeVerifier = verifyCommandError(built && built.policy && built.policy.verifyCommand);
  if (unsafeVerifier) return { status: EXIT_SETUP, stdout: '', stderr: `unsafe verifyCommand: ${unsafeVerifier}` };
  // -p reads the prompt from stdin when no prompt argv follows it. That avoids both a shell and
  // Windows' command-line length limit. Permissions stay at the host user's normal policy.
  const timeoutMs = Math.max(1, Number(built.cfg.wallClockMinutes) || 240) * 60 * 1000;
  const suite = `tests/acceptance/${built.suiteId || built.id}/`;
  const verifier = `${built.policy.verifyCommand} ${suite}`;
  const allowed = `Read,Edit,Write,Glob,Grep,Bash(${verifier})`;
  return run(process.env.PIPELINE_TEST_AUTHOR_CMD || 'claude', [
    '-p', '--model', model,
    '--restricted', '--permission-mode', 'acceptEdits',
    '--tools', AUTHOR_TOOLS,
    '--allowedTools', allowed,
    '--disallowedTools', DENIED_TOOLS,
    '--no-session-persistence',
  ], {
      cfg: built.cfg, cwd: built.folder.dir, input: `${built.text}\n`, timeoutMs,
      label: 'Claude test-author session', maxBuffer: MAX_BUFFER,
      env: { ...process.env, ...(built.cfg.hostEnv || {}) },
    });
}

function quote(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

function nextStep(id, configPath, probe) {
  const green = probe ? ` --probe ${quote(probe)}` : '';
  return `Human approval is mandatory. Review the suite and proof report; only then run: node scripts/freeze.js commit ${id} --config ${quote(configPath)}${green}`;
}

function failureStep() {
  return 'Next human step: inspect the agent failure and worktree, then fix the prerequisite or rerun author-tests. Do not freeze a failed session.';
}

function statusPaths(output) {
  return String(output || '').split('\0').filter(Boolean).map((record) =>
    record.length > 3 && record[2] === ' ' ? record.slice(3) : record);
}

// The test author owns exactly one suite. Restricted mode confines file tools to its worktree,
// not to that directory, so the boundary is checked mechanically before and after the model.
function auditAuthorTree(built, run = runSync) {
  const result = run('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
    cfg: built.cfg, kind: 'git', cwd: built.folder.dir, label: 'audit test-author worktree',
  });
  if (result.status !== 0) return { ok: false, error: failureText(result, 'git status failed') };
  const suite = `tests/acceptance/${built.suiteId || built.id}`;
  const outside = statusPaths(result.stdout).map((p) => p.split('\\').join('/'))
    .filter((p) => p !== suite && !p.startsWith(`${suite}/`));
  return outside.length
    ? { ok: false, error: `the dedicated test-author worktree has changes outside ${suite}/: ${outside.join(', ')}` }
    : { ok: true };
}

// Structured, Beads-free worker seam. The caller owns discovery and worktree creation; this
// function accepts one already-built immutable brief and never calls buildBrief, bd, or
// `git worktree add`. That makes it safe for a batch coordinator to serialize all Beads reads
// in its parent process and run these workers concurrently without contending on embedded Dolt.
function authorIssue(built, configPath, io = {}, seams = {}) {
  const out = io.out || console.log; const err = io.err || console.error;
  const setup = (kind, error) => ({ ok: false, outcome: 'setup-failed', kind, error, exitCode: EXIT_SETUP });
  if (!built || !built.ok || built.state !== 'write') {
    const result = setup('state', `structured author requires write state (got ${(built && built.state) || 'invalid'})`);
    err(`author-tests: ${result.error}`);
    return result;
  }
  if (!built.folder || !built.folder.exists || !fs.existsSync(built.folder.dir)) {
    const result = setup('worktree', `structured author requires an existing issue worktree: ${(built.folder && built.folder.dir) || '(absent)'}`);
    err(`author-tests: ${result.error}`);
    return result;
  }
  if (typeof configPath !== 'string' || !configPath.trim()) {
    const result = setup('config', 'structured author requires the run config path used to build its snapshot');
    err(`author-tests: ${result.error}`);
    return result;
  }
  const unsafeVerifier = verifyCommandError(built.policy && built.policy.verifyCommand);
  if (unsafeVerifier) {
    const result = setup('verify-command', unsafeVerifier);
    err(`author-tests: ${result.error}`);
    return result;
  }
  const model = String(built.cfg.testAuthorModel || built.cfg.model || '').trim();
  const probeModel = String(built.cfg.testProbeModel || built.cfg.testAuthorModel || built.cfg.model || '').trim();
  if (!model) {
    const result = setup('model', 'no model is available; set testAuthorModel or model in the run config');
    err(`author-tests: ${result.error}`);
    return result;
  }
  if (!probeModel) {
    const result = setup('probe-model', 'no probe model is available; set testProbeModel, testAuthorModel or model in the run config');
    err(`author-tests: ${result.error}`);
    return result;
  }

  const before = (seams.auditAuthorTree || auditAuthorTree)(built, seams.runSync || runSync);
  if (!before.ok) {
    err(`author-tests: ${before.error}`); err(failureStep());
    return setup('boundary-before', before.error);
  }
  out(`Launching Claude with explicit model alias ${model}; freeze/commit/push are not part of this command.`);
  const r = (seams.launchAuthor || launchAuthor)(built, model, seams.runSync || runSync);
  if (r.stdout) out(String(r.stdout).trimEnd());
  if (r.stderr) err(String(r.stderr).trimEnd());
  if (r.status !== 0) {
    const detail = failureText(r, 'Claude executable failed');
    if (!r.stderr && !r.stdout) err(`author-tests: ${detail}`);
    err(`Outcome: test-author agent failed (exit ${r.status === null ? 'unavailable' : r.status}).`);
    err(failureStep());
    return { ok: false, outcome: 'agent-failed', kind: 'agent', error: detail,
      agentStatus: r.status, exitCode: EXIT_AGENT };
  }
  const after = (seams.auditAuthorTree || auditAuthorTree)(built, seams.runSync || runSync);
  if (!after.ok) {
    err(`Outcome: test-author boundary violation — ${after.error}`);
    err('Do not freeze this suite. Inspect the dedicated worktree and remove or recover the out-of-scope changes.');
    return { ok: false, outcome: 'boundary-violation', kind: 'boundary-after',
      error: after.error, exitCode: EXIT_AGENT };
  }

  out('Test-author agent exited successfully. Starting the isolated two-direction green proof.');
  const proof = (seams.proveTests || proveTests)(built, probeModel, seams.probeSeams || {});
  if (proof.agentOutput) out(proof.agentOutput);
  if (proof.evidence) out(proof.evidence);
  if (!proof.ok) {
    err(`Outcome: suite is not fully proven (${proof.kind || 'unknown'}): ${proof.error}`);
    if (proof.probe) err(`Probe retained for inspection: ${proof.probe}`);
    err('No freeze, commit or push was performed. Fix the probe or the suite before approval.');
    return { ok: false, outcome: 'unproven', kind: proof.kind || 'unknown', error: proof.error,
      attempt: proof.attempt || null, probe: proof.probe || null, evidence: proof.evidence || '',
      agentOutput: proof.agentOutput || '', exitCode: EXIT_PROBE };
  }
  const resolvedConfig = path.resolve(configPath);
  out(`Outcome: fully proven — RED at the fork point and GREEN in the protected probe (attempt ${proof.attempt}).`);
  out(`Probe retained for the human-approved freeze: ${proof.probe}`);
  out('No freeze, commit or push was performed by the launcher.');
  out(nextStep(built.suiteId || built.id, resolvedConfig, proof.probe));
  return { ok: true, outcome: 'proven', kind: 'proven', attempt: proof.attempt,
    probe: proof.probe, container: proof.container || null, evidence: proof.evidence || '',
    agentOutput: proof.agentOutput || '', exitCode: EXIT_OK };
}

function main(argv, io = {}, seams = {}) {
  const out = io.out || console.log; const err = io.err || console.error;
  const opts = parseArgs(argv);
  if (opts.help) { out(USAGE); return EXIT_OK; }
  if (opts.error || !opts.id || !opts.config || !validIssueId(opts.id)) {
    err(`author-tests: ${opts.error || 'a safe issue id and --config are required'}`); err(USAGE); return EXIT_USAGE;
  }
  const configPath = path.resolve(opts.config);
  let lockCfg;
  try { lockCfg = (seams.loadConfig || loadConfig)(configPath); }
  catch (e) { err(`author-tests: ${(e && e.message) || String(e)}`); return EXIT_USAGE; }

  // A manual CLI must not race any Beads reader, batch coordinator or implementation run.
  // Load only the host config needed to identify the target, then acquire before buildBrief's
  // sole Beads read. A stale-owner takeover is recovery evidence, never launch authority.
  const lockRunId = `test-author-cli-${process.pid}-${Date.now()}`;
  const locked = (seams.acquireLock || acquire)(ROOT, lockCfg.targetRepoPath, lockRunId);
  if (!locked.ok) {
    const holder = locked.holder || {};
    err(`author-tests: target is already owned by ${holder.runId || 'another live operation'}`
      + `${holder.pid ? ` (pid ${holder.pid})` : ''}; no worktree or author was started.`);
    return EXIT_SETUP;
  }
  try {
    if (locked.tookOver) {
      err('author-tests: stale target ownership requires normal pipeline recovery; no Beads read, worktree change or author was started.');
      return EXIT_SETUP;
    }
    const builder = seams.buildBrief || buildBrief;
    let built = builder(opts);
    if (!built.ok) {
      err(`author-tests: ${built.error}`);
      return built.kind === 'config' ? EXIT_USAGE : EXIT_SETUP;
    }
    if (!built.cfg || typeof built.cfg.targetRepoPath !== 'string'
        || path.resolve(built.cfg.targetRepoPath) !== path.resolve(lockCfg.targetRepoPath)) {
      err('author-tests: run config target changed after target ownership was acquired; no worktree or author was started.');
      return EXIT_SETUP;
    }
    const model = String(built.cfg.testAuthorModel || built.cfg.model || '').trim();
    const probeModel = String(built.cfg.testProbeModel || built.cfg.testAuthorModel || built.cfg.model || '').trim();
    if (!model) { err('author-tests: no model is available; set testAuthorModel or model in the run config'); return EXIT_SETUP; }
    if (!probeModel) { err('author-tests: no probe model is available; set testProbeModel, testAuthorModel or model in the run config'); return EXIT_SETUP; }

    out(`Issue: ${opts.id}`); out(`Selected test-author model: ${model}`); out(`Selected green-probe model: ${probeModel}`);
    if (built.state === 'ready') {
      out('Outcome: no launch — the suite is already frozen and dispatchable.');
      out('Next human step: review the existing frozen suite before launching the pipeline.');
      return EXIT_OK;
    }
    if (built.state !== 'write') {
      out(`Worktree: ${built.folder.dir}`);
      out(`Outcome: no launch — state is ${built.state}; writing tests is unnecessary.`);
      out(nextStep(built.suiteId || opts.id, configPath));
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
      if (!refreshed.cfg || typeof refreshed.cfg.targetRepoPath !== 'string'
          || path.resolve(refreshed.cfg.targetRepoPath) !== path.resolve(lockCfg.targetRepoPath)) {
        err('author-tests: run config target changed while refreshing the issue worktree; no author was started.');
        return EXIT_SETUP;
      }
      built = refreshed;
    }
    out(`Worktree: ${built.folder.dir}${made.created ? ' (created)' : ' (reused)'}`);
    return authorIssue(built, configPath, io, seams).exitCode;
  } finally {
    (seams.releaseLock || release)(ROOT, lockCfg.targetRepoPath, locked.ownership);
  }
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = {
  main, parseArgs, ensureWorktree, launchAuthor, nextStep, failureStep, auditAuthorTree, statusPaths,
  authorIssue,
  AUTHOR_TOOLS, DENIED_TOOLS, EXIT_USAGE, EXIT_SETUP, EXIT_AGENT, EXIT_PROBE,
};
