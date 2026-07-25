#!/usr/bin/env node
// The runner — host-side orchestrator (DESIGN.md §4.1, §4.12). T11: bootstrap only.
// Deterministic scaffolding, never an LLM. Runs from Git Bash on Windows; no WSL,
// no platform `timeout` (wall-clock is a Node timer + docker kill — T14).
//
//   node runner/run.js [--config <path>] [--dry-run]
//
// T11 scope: config load, run folder + trace IDs, lifecycle ownership (network up,
// egress gate, image assert, stale-issue recovery), teardown. The queue loop lands
// in T12/T15; task execution in T14.
'use strict';
const fs = require('fs');
const path = require('path');
const { loadConfig, loadToken } = require('./config');
const { startRun } = require('./log');
const { preflight, networkDown } = require('./preflight');
const { readyQueue, claim, exportIssue, finish, outcomeFor, attemptNotes } = require('./queue');
const { prepare, hasCommits, collectArtifacts, discard } = require('./workspace');
const { runTask } = require('./container');
const { waitForWindow } = require('./pause');
const { publish } = require('./publish');
const { writeManifest, writeReport } = require('./report');

// Diff size on the branch — the report's final tie-breaker (§4.9).
function diffLines(dir, forkPoint) {
  const r = require('child_process').spawnSync('git', ['diff', '--shortstat', `${forkPoint}..HEAD`],
    { cwd: dir, encoding: 'utf8' });
  const m = /(\d+) insertion[^,]*(?:, (\d+) deletion)?/.exec(r.stdout || '');
  if (!m) return 0;
  return Number(m[1] || 0) + Number(m[2] || 0);
}

const REPO_ROOT = path.join(__dirname, '..');

function parseArgs(argv) {
  const out = { config: null, dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--config') out.config = argv[++i];
    else if (argv[i] === '--dry-run') out.dryRun = true;
  }
  return out;
}

// Placeholder task execution until T13/T14 land. PIPELINE_EXEC_STUB names a script
// whose exit code stands in for the container's, and which may write status.json /
// verify.json into the task's log dir — enough to exercise every §4.11 transition.
// One task container (§4.10). PIPELINE_EXEC_STUB replaces the container with a local
// script — used by the runner's own test suites to exercise outcome paths cheaply;
// real runs always take the docker path.
async function executeTask(cfg, issue, taskDir, log, traceId, ws, token, wallClockMinutes) {
  const stub = process.env.PIPELINE_EXEC_STUB;
  if (stub) {
    const r = require('child_process').spawnSync('bash', [stub], {
      encoding: 'utf8',
      cwd: ws.dir,
      env: { ...process.env, ISSUE_ID: issue.id, TASK_DIR: taskDir, WORKSPACE: ws.dir, RUN_DIR: path.join(ws.dir, '.run') },
    });
    log.info(traceId, `exec stub exited ${r.status}`);
    return { exitCode: r.status === 124 ? 'killed' : r.status };
  }
  // Container names must be unique across relaunches (§4.7 resume).
  const attempt = (executeTask.counter = (executeTask.counter || 0) + 1);
  return runTask(cfg, {
    containerName: `task-${issue.id}-${log.runId}-${attempt}`.replace(/[^A-Za-z0-9_.-]/g, '-'),
    workspaceDir: ws.dir,
    pipelineDir: path.join(REPO_ROOT, 'pipeline'),
    issueId: issue.id,
    taskDir,
    token,
    wallClockMinutes: wallClockMinutes || cfg.wallClockMinutes,
  }, log, traceId);
}

async function main() {
  const args = parseArgs(process.argv);

  let cfg;
  try {
    cfg = loadConfig(args.config);
  } catch (e) {
    console.error(`runner: ${e.message}`);
    process.exit(2);
  }

  const log = startRun(REPO_ROOT, process.env.RUN_ID);
  const startedAt = new Date().toISOString();
  const t = `${log.runId}/preflight`;
  log.info(t, `run started (config: ${cfg.configPath})`);
  log.info(t, `target: ${cfg.targetRepoPath} -> ${cfg.targetRepoRemote}`);

  const token = loadToken(REPO_ROOT);
  if (!token) {
    log.error(t, 'no CLAUDE_CODE_OAUTH_TOKEN (.env.pipeline or environment) — tasks cannot authenticate');
    process.exit(2);
  }
  log.info(t, 'subscription token loaded');

  const pre = preflight(cfg, REPO_ROOT, log);
  if (!pre.ok) {
    log.error(t, `PREFLIGHT FAILED — no tasks launched: ${pre.reason}`);
    networkDown(REPO_ROOT);
    process.exit(1);
  }
  log.info(t, `preflight passed${pre.recovered.length ? ` (recovered: ${pre.recovered.join(', ')})` : ''}`);

  if (args.dryRun) {
    log.info(t, 'dry run: stopping before the task loop');
    networkDown(REPO_ROOT);
    log.info(t, `run finished; artifacts in ${log.dir}`);
    return;
  }

  // ---- the task loop (§4.12): drain the ready queue, one container per task ----
  const q = readyQueue(cfg);
  if (!q.ok) {
    log.error(t, `cannot read the Beads ready queue: ${q.error}`);
    networkDown(REPO_ROOT);
    process.exit(1);
  }
  log.info(t, `ready queue: ${q.issues.length} task(s) — ${q.issues.map((i) => i.id).join(', ') || '(empty)'}`);

  const results = [];
  for (const issue of q.issues) {
    const tr = log.trace(issue.id);
    const taskDir = log.taskDir(issue.id);
    log.info(tr, `starting task (priority ${issue.priority ?? 2}): ${issue.title || ''}`);

    if (!claim(cfg, issue.id)) {
      log.error(tr, 'could not mark the issue in_progress; skipping');
      continue;
    }
    const exported = exportIssue(cfg, issue.id);
    if (!exported.ok) {
      log.error(tr, `could not export the issue: ${exported.error}`);
      finish(cfg, issue.id, { status: 'failed', beads: 'blocked' },
        [`run ${log.runId}: could not export issue spec — ${exported.error}`]);
      results.push({ issueId: issue.id, outcome: 'failed' });
      continue;
    }
    fs.writeFileSync(path.join(taskDir, 'issue.md'), exported.markdown);

    // ---- per-task workspace: fresh clone, task branch, issue mounted (§4.2, T13) ----
    const ws = prepare(cfg, issue.id, exported.markdown, log, tr);
    if (!ws.ok) {
      log.error(tr, `workspace preparation failed: ${ws.reason}`);
      finish(cfg, issue.id, { status: 'failed', beads: 'blocked' },
        [`run ${log.runId}: workspace preparation failed — ${ws.reason}`]);
      results.push({ issueId: issue.id, outcome: 'failed' });
      continue;
    }

    // ---- run the task, pausing and resuming across usage windows (§4.7) ----
    // Active time accumulates across relaunches; paused time never counts (§4.6).
    let exec;
    let artifacts;
    let activeMs = 0;
    let pauses = 0;
    for (;;) {
      const remainingMinutes = cfg.wallClockMinutes - activeMs / 60000;
      if (remainingMinutes <= 0) {
        log.error(tr, 'active wall-clock budget exhausted across relaunches');
        exec = { exitCode: 'killed', killed: true, durationMs: 0 };
        artifacts = collectArtifacts(ws.dir, taskDir);
        break;
      }
      exec = await executeTask(cfg, issue, taskDir, log, tr, ws, token, remainingMinutes);
      activeMs += exec.durationMs || 0;
      if (exec.durationMs !== undefined) {
        log.info(tr, `container ran ${Math.round(exec.durationMs / 1000)}s` +
          `${exec.killed ? ' (killed at budget)' : ''}; active total ${Math.round(activeMs / 1000)}s`);
      }
      artifacts = collectArtifacts(ws.dir, taskDir);

      if (exec.exitCode !== 20) break;                       // not a rate limit — done

      pauses += 1;
      log.info(tr, `rate limit hit (pause ${pauses}) — parking the task; issue stays in_progress`);
      const waited = await waitForWindow(cfg, artifacts.status, log, tr, { token });
      if (!waited.resumed) {
        log.error(tr, `giving up on the pause: ${waited.reason}`);
        break;                                               // stays exit 20 -> paused
      }
      log.info(tr, 'relaunching in a fresh container against the same workspace (attempt counter carries over)');
    }
    if (pauses) log.info(tr, `task resumed across ${pauses} usage-window pause(s)`);
    const outcome = outcomeFor(exec.exitCode, artifacts.verify);
    const commits = hasCommits(ws.dir, ws.forkPoint);
    log.info(tr, `branch ${ws.branch}: ${commits ? 'has commits (push candidate)' : 'no commits (nothing to push)'}`);

    // ---- publish: push what exists, PR what passed (§4.5, T16) ----
    const published = publish(cfg, {
      ws,
      outcome,
      hasCommits: commits,
      issueMarkdown: exported.markdown,
      status: artifacts.status,
      verify: artifacts.verify,
      issue,
      runId: log.runId,
    }, log, tr);

    const notes = attemptNotes(log.runId, outcome, artifacts.status);
    if (published.prUrl) notes.push(`PR: ${published.prUrl}`);
    else if (published.pushed) notes.push(`branch pushed for review: ${ws.branch} (no PR — ${outcome.status})`);
    finish(cfg, issue.id, outcome, notes);

    log.info(tr, `task finished: exit ${exec.exitCode} -> ${outcome.status}` +
      (outcome.beads ? ` (issue ${outcome.beads})` : ' (issue stays in_progress)'));
    const v = artifacts.verify;
    results.push({
      issueId: issue.id,
      title: issue.title || '',
      outcome: outcome.status,
      exitCode: exec.exitCode,
      branch: ws.branch,
      pushed: published.pushed,
      prUrl: published.prUrl || null,
      attempts: ((artifacts.status && artifacts.status.attempts) || []).length,
      pauses,
      activeSeconds: Math.round(activeMs / 1000),
      diffLines: diffLines(ws.dir, ws.forkPoint),
      ...(artifacts.status && artifacts.status.changeSummary ? { changeSummary: artifacts.status.changeSummary } : {}),
      ...(artifacts.status && artifacts.status.model ? { model: artifacts.status.model } : {}),
      ...(v ? {
        verification: {
          acceptance: v.acceptance,
          regressions: v.regressions,
          ...(v.acceptanceOutput ? { evidence: String(v.acceptanceOutput).slice(-1500) } : {}),
        },
      } : {}),
      ...(artifacts.status && artifacts.status.stuckState ? { stuckState: artifacts.status.stuckState } : {}),
      attemptNotes: notes,
    });

    if (process.env.PIPELINE_KEEP_WORKSPACE) log.info(tr, `workspace kept at ${ws.dir}`);
    else discard(ws.dir);
  }

  log.info(t, `queue drained: ${results.map((r) => `${r.issueId}=${r.outcome}`).join(', ') || '(nothing ran)'}`);

  // ---- manifest + report (§4.9, §4.12) ----
  const { manifest } = writeManifest(log.dir, {
    runId: log.runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    targetRepo: cfg.targetRepoRemote,
    tasks: results,
  });
  const reportFile = writeReport(log.dir, manifest);
  log.info(t, `run report: ${reportFile}`);

  networkDown(REPO_ROOT);
  log.info(t, `run finished; artifacts in ${log.dir}`);
}

main().catch((e) => {
  console.error(`runner: unexpected failure — ${e && e.stack ? e.stack : e}`);
  process.exit(3);
});
