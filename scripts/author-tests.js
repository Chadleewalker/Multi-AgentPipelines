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
const AGENT = require('../runner/agent-provider');
const CONTAINMENT = require('../runner/author-containment');
const AUTHOR_EVIDENCE = require('../runner/author-evidence');
const { runSync, failureText } = require('../runner/process');
const { acquire, release } = require('../runner/lock');
const { buildBrief, verifyCommandError } = require('./spec-brief');
const { proveTests, validIssueId, proofStageLine } = require('./prove-tests');

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
  // Both providers read the prompt from stdin — Claude's `-p` with no prompt argv, Codex's
  // trailing `-`. That avoids both a shell and Windows' command-line length limit, and it
  // keeps a spec brief out of any process listing. The Claude argv below is unchanged and
  // is what a config with no provider selection still gets, byte for byte; the adapter
  // returns it untouched. Permissions stay at the host user's normal policy.
  const timeoutMs = Math.max(1, Number(built.cfg.wallClockMinutes) || 240) * 60 * 1000;
  const suite = `tests/acceptance/${built.suiteId || built.id}/`;
  const verifier = `${built.policy.verifyCommand} ${suite}`;
  const allowed = `Read,Edit,Write,Glob,Grep,Bash(${verifier})`;
  const provider = AGENT.providerFor(built.cfg, 'test-author');
  // hostEnv is the author stage's own environment (a licence path, a binary that is
  // not on PATH) and carries the selected provider's key on a Codex host.
  let env = { ...process.env, ...(built.cfg.hostEnv || {}) };
  // A Codex session reaches its own shell, so the coordinator's single Beads read buys nothing
  // unless `bd` is closed mechanically. The argv is pinned byte for byte by
  // tests/acceptance/repo-45g, so containment travels in the environment or not at all. Claude
  // closes the same door through `--disallowedTools Bash(bd *)` and is left unchanged.
  let contained = null;
  if (provider === 'codex') {
    contained = CONTAINMENT.beginLaunch(env, built.suiteId || built.id);
    // A containment root that could not be built is a setup failure, not a contained launch, so
    // the provider is never started. Construction attempted to roll back every root it created;
    // `rollbackError` is the case where one of those roots could not be accounted for and was
    // deliberately left standing as evidence, which is exactly why no later fallback candidate
    // was allowed to turn this into a success. Both halves are reported, and both stay bounded
    // and role-only for the same reason cleanup does: a host path or an errno is not ours to
    // repeat here.
    if (!contained.ok) {
      const rollback = contained.rollbackError ? `; ${contained.rollbackError}` : '';
      return { status: EXIT_SETUP, stdout: '', stderr: `${contained.error}${rollback}` };
    }
    env = contained.env;
  }
  const spec = {
    provider,
    model,
    reasoningEffort: AGENT.reasoningEffortFor(built.cfg, 'test-author'),
    command: process.env.PIPELINE_TEST_AUTHOR_CMD || null,
    claudeArgs: [
      '-p', '--model', model,
      '--restricted', '--permission-mode', 'acceptEdits',
      '--tools', AUTHOR_TOOLS,
      '--allowedTools', allowed,
      '--disallowedTools', DENIED_TOOLS,
      '--no-session-persistence',
    ],
    runOptions: {
      cfg: built.cfg, cwd: built.folder.dir, input: `${built.text}\n`, timeoutMs,
      label: `${provider} test-author session`, maxBuffer: MAX_BUFFER,
      env,
    },
  };
  if (!contained) return AGENT.launch(spec, run);
  // Only the provider call is wrapped: the shim has to stay present and usable for the whole
  // session, and disposal happens exactly once after it has settled or thrown — never before,
  // never concurrently with it. The provider's own result, or its error, is preserved
  // unchanged; the cleanup outcome is added beside it.
  let result;
  try {
    result = AGENT.launch(spec, run);
  } catch (error) {
    throw withCleanupError(error, CONTAINMENT.endLaunch(contained));
  }
  return withCleanupResult(result, CONTAINMENT.endLaunch(contained));
}

// Additive: the same object, plus one bounded field. A provider result that refuses the
// assignment (frozen, or not an object at all) is copied rather than reported differently.
function withCleanupResult(result, cleanup) {
  if (!result || typeof result !== 'object') {
    return { status: null, stdout: '', stderr: '', containmentCleanup: cleanup };
  }
  try {
    result.containmentCleanup = cleanup;
    if (result.containmentCleanup === cleanup) return result;
  } catch { /* frozen or exotic; fall through to a copy */ }
  return { ...result, containmentCleanup: cleanup };
}

// A thrown launch error keeps its original message and is rethrown carrying the cleanup
// outcome. When it cannot be extended at all, the aggregate that replaces it keeps the original
// as its primary cause, so nothing about the failure is lost to the reporting of cleanup.
function withCleanupError(error, cleanup) {
  try {
    error.containmentCleanup = cleanup;
    if (error.containmentCleanup === cleanup) return error;
  } catch { /* frozen, sealed, or a primitive */ }
  const message = (error && error.message) || String(error);
  const aggregate = new AggregateError([error], message);
  aggregate.cause = error;
  aggregate.containmentCleanup = cleanup;
  return aggregate;
}

// The one line a failing consumer boundary prints when the launch's OWN containment cleanup
// also failed. It is additive — never a replacement for the primary outcome — and stays
// bounded and role-only: `cleanup.error` already names which owned root could not be removed
// and nothing else (no host path, nonce, OS errno, or provider output), for the same reason
// dispose/rollback text does.
function cleanupDiagnostic(cleanup) {
  return `author containment cleanup also failed: ${(cleanup && cleanup.error) || 'unknown'}`;
}

// Carry a launch's containment-cleanup outcome onto a failing primary result additively, and
// report it once on stderr when it FAILED. The primary outcome, status, error and provider
// identity are untouched — cleanup is added beside them, never over them. A launch that
// reported no cleanup outcome (a non-Codex provider, or a launch that built no containment)
// leaves the primary result exactly as it was.
function carryCleanup(result, cleanup, err) {
  if (!cleanup || typeof cleanup !== 'object') return result;
  if (cleanup.ok === false) err(`Outcome: ${cleanupDiagnostic(cleanup)}`);
  return { ...result, containmentCleanup: cleanup };
}

function quote(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

function nextStep(id, configPath, probe) {
  const green = probe ? ` --probe ${quote(probe)}` : '';
  return `Human approval is mandatory. Review the suite and proof report; only then run: node scripts/freeze.js commit ${id} --config ${quote(configPath)}${green}`;
}

// The freeze command is an invitation to a human to approve something. Offering it for a suite
// whose durable record says its author session never finished is the defect repo-djf.42 exists
// to close: the files look complete, and only the preparation record knows they are not.
function resumeStep(id, configPath, evidence) {
  const state = (evidence && evidence.state) || 'unknown';
  const reason = evidence && evidence.reason ? ` (${evidence.reason})` : '';
  return [
    `Author-generation evidence: ${state}${reason}.`,
    'No freeze command is offered: suite files alone are not evidence that authoring finished,',
    'and nothing has been deleted, moved or archived — the partial bytes are left exactly as they',
    'are for the next session to continue from.',
    `Next human step: re-run this exact command to resume in the same worktree: node scripts/author-tests.js ${id} --config ${quote(configPath)}`,
  ].join('\n');
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
  // The launch itself can THROW — a spawn fault, or a cleanup that failed while unwinding a
  // thrown provider call (launchAuthor attaches its bounded containmentCleanup to the error it
  // rethrows). The primary exception is preserved and re-propagated unchanged so the in-process
  // cause survives; the simultaneous cleanup failure is reported once here, bounded and
  // role-only, so it is not lost at the public consumer boundary.
  let r;
  try {
    r = (seams.launchAuthor || launchAuthor)(built, model, seams.runSync || runSync);
  } catch (error) {
    const thrownCleanup = error && typeof error === 'object' ? error.containmentCleanup : null;
    if (thrownCleanup && thrownCleanup.ok === false) err(`Outcome: ${cleanupDiagnostic(thrownCleanup)}`);
    throw error;
  }
  // The launch's own containment-cleanup outcome, carried additively onto whatever primary
  // outcome the provider result produces below.
  const cleanup = r && typeof r === 'object' ? r.containmentCleanup : undefined;
  if (r.stdout) out(String(r.stdout).trimEnd());
  if (r.stderr) err(String(r.stderr).trimEnd());
  if (r.status !== 0) {
    const limited = AGENT.usageLimitFromLaunch(AGENT.providerFor(built.cfg, 'test-author'), r, model);
    if (limited) return carryCleanup({ ...limited, kind: 'usage-limit', agentStatus: r.status, exitCode: EXIT_AGENT }, cleanup, err);
    const detail = failureText(r, 'Claude executable failed');
    if (!r.stderr && !r.stdout) err(`author-tests: ${detail}`);
    err(`Outcome: test-author agent failed (exit ${r.status === null ? 'unavailable' : r.status}).`);
    err(failureStep());
    return carryCleanup({ ok: false, outcome: 'agent-failed', kind: 'agent', error: detail,
      agentStatus: r.status, exitCode: EXIT_AGENT }, cleanup, err);
  }
  const after = (seams.auditAuthorTree || auditAuthorTree)(built, seams.runSync || runSync);
  if (!after.ok) {
    err(`Outcome: test-author boundary violation — ${after.error}`);
    err('Do not freeze this suite. Inspect the dedicated worktree and remove or recover the out-of-scope changes.');
    return carryCleanup({ ok: false, outcome: 'boundary-violation', kind: 'boundary-after',
      error: after.error, exitCode: EXIT_AGENT }, cleanup, err);
  }

  // A zero exit is the process ending, not the agent finishing. The session is accepted only
  // when the provider's own output carries a terminal completed result; the two author attempts
  // that consumed the whole memory corpus and wrote no suite both exited zero.
  const authorProvider = AGENT.providerFor(built.cfg, 'test-author');
  if (!AGENT.terminalResult(authorProvider, `${r.stdout || ''}\n${r.stderr || ''}`)) {
    const error = `the ${authorProvider} test-author exited 0 without a terminal completed result;`
      + ' the session ended mid-turn and its output is not evidence that a suite was written';
    err(`Outcome: test-author session incomplete — ${error}`);
    err(failureStep());
    return carryCleanup({ ok: false, outcome: 'agent-incomplete', kind: 'incomplete', error,
      provider: authorProvider, agentStatus: r.status, exitCode: EXIT_AGENT }, cleanup, err);
  }

  // The provider itself completed, so the only thing that can still be wrong is our own
  // containment: a root that outlived the session it contained. That is reported explicitly and
  // separately, and it blocks the green proof and the freeze invitation — a launcher that
  // cannot clean up after a session has no business asking a human to approve it. A nonzero,
  // usage-limited or incomplete session keeps its own truthful outcome above, because cleanup
  // is not the interesting failure in any of those.
  if (cleanup && cleanup.ok === false) {
    const error = `author containment cleanup failed after a completed session: ${cleanup.error || 'unknown'}`;
    err(`Outcome: test-author containment cleanup failed — ${error}`);
    err('Do not freeze this suite. The contained session finished, but a containment root it owned'
      + ' could not be removed; inspect the host before approving anything built by it.');
    err(failureStep());
    return { ok: false, outcome: 'cleanup-failed', kind: 'cleanup', error,
      agentStatus: r.status, exitCode: EXIT_AGENT, containmentCleanup: cleanup };
  }

  out('Test-author agent exited successfully. Starting the isolated two-direction green proof.');
  const probeSeams = { ...(seams.probeSeams || {}) };
  if (typeof probeSeams.onStage !== 'function') probeSeams.onStage = (event) => {
    const line = proofStageLine(event); if (line) out(line);
  };
  const proof = (seams.proveTests || proveTests)(built, probeModel, probeSeams);
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
      const evidence = (seams.authorEvidence || AUTHOR_EVIDENCE.forBrief)(built);
      const evidenceState = (evidence && evidence.state) || AUTHOR_EVIDENCE.STATES.AUTHORED_UNPROVEN;
      out(AUTHOR_EVIDENCE.mayPrintFreezeCommand(evidenceState)
        ? nextStep(built.suiteId || opts.id, configPath)
        : resumeStep(opts.id, configPath, evidence));
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
  main, parseArgs, ensureWorktree, launchAuthor, nextStep, resumeStep, failureStep, auditAuthorTree, statusPaths,
  authorIssue,
  AUTHOR_TOOLS, DENIED_TOOLS, EXIT_USAGE, EXIT_SETUP, EXIT_AGENT, EXIT_PROBE,
};
