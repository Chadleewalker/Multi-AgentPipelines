#!/usr/bin/env node
// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

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
const { release: releaseLock } = require('./lock');
const {
  readyQueue, queueSummary, claim, exportIssue, finish, outcomeFor, attemptNotes,
  undispatchableRow,
} = require('./queue');
const { prepare, hasCommits, collectArtifacts, discard } = require('./workspace');
const { runTask } = require('./container');
const { createPauseGate } = require('./pause');
const { fileMemoryNotes, shouldFileMemory } = require('./memory');
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
    // Asynchronous on purpose (§7): spawnSync here would serialise every stubbed task and
    // make the worker pool unobservable to exactly the Docker-free suites that prove it.
    // The invocation stays `bash <stub>` — an explicit interpreter, so a stub script never
    // fails with EFTYPE on the Windows host — and the environment contract is unchanged,
    // because the existing Docker suites depend on both. Output is discarded rather than
    // piped: spawnSync's pipes were never read either, and an unread pipe would now block
    // a chatty stub instead of quietly filling a buffer nobody looks at.
    const status = await new Promise((resolve) => {
      const child = require('child_process').spawn('bash', [stub], {
        cwd: ws.dir,
        stdio: ['ignore', 'ignore', 'ignore'],
        env: { ...process.env, ISSUE_ID: issue.id, TASK_DIR: taskDir, WORKSPACE: ws.dir, RUN_DIR: path.join(ws.dir, '.run') },
      });
      child.on('error', () => resolve(null));      // same shape spawnSync reported: no status
      child.on('close', (code) => resolve(code));  // null when a signal killed it
    });
    log.info(traceId, `exec stub exited ${status}`);
    return { exitCode: status === 124 ? 'killed' : status };
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

// ---- the bounded worker pool (§7, §4.12) ------------------------------------------
// ONE runner process working N tasks of one project at once, never N runner processes:
// the sole-Beads-writer rule (§4.10) and claim-based double-pick prevention survive only
// inside a single process. Several runners, one per project, are a different thing and
// already shipped (change-log row `repo-jur`).
//
// `issues` is the ready queue in ready-queue order; `taskFn(issue)` is the runner's own
// per-task body; at most `concurrency` of those calls are in flight at once. The resolved
// array is INDEX-ALIGNED WITH `issues` — ready-queue order, never completion order — so a
// task that finishes first does not overtake its neighbours in the manifest.
//
// N fixed workers pulling from a shared cursor, rather than a promise-set watched with
// Promise.race: nothing here needs to know which task finished, only that a slot opened,
// and the cursor is what keeps starts in ready-queue order at any depth.
async function drainQueue(issues, taskFn, concurrency) {
  const queue = Array.from(issues || []);
  const n = Number.isInteger(concurrency) && concurrency > 0 ? concurrency : 1;
  const results = new Array(queue.length);
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const i = cursor++;
      if (i >= queue.length) return;
      results[i] = await taskFn(queue[i], i);
    }
  };
  const workers = [];
  for (let i = 0; i < Math.min(n, queue.length); i++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

// One task, start to finish: claim, export, workspace, container (with pause/resume),
// memory, publish, Beads finish. Resolves to the task's manifest row, or null when the
// issue could not be claimed and nothing ran. Everything it touches is per task, so N of
// these can be in flight at once; the shared pieces it calls into — Beads through
// runner/bd.js, the clone and the push — are synchronous and serialise themselves.
//
// `gate` is the RUN-level rate-limit park (§7), built once in main() and shared by every
// task: this function asks it for admission before it starts and reports its own limits
// into it, but never owns one.
async function runOneTask(cfg, issue, log, token, gate) {
  const tr = log.trace(issue.id);
  const taskDir = log.taskDir(issue.id);

  // Admission is checked BEFORE claim() (§7). Two populations come out of a run-level park
  // and only one of them touches Beads:
  //   PARKED  — launched, exited 20, waited, gave up: the issue stays in_progress, and the
  //             normal paused row below reports it.
  //   REFUSED — the run-level cap had already fired, so this task never launched. Beads is
  //             never touched, so the issue stays `open` for the next run to pick up.
  // A refused task still resolves a row rather than null: main()'s .filter(Boolean) would
  // otherwise erase it from run.json entirely — a silent hole after an unattended run.
  if (!(await gate.admit(issue.id))) {
    log.error(tr, 'refused: the run-level rate-limit pause cap has fired; nothing launched, issue stays open');
    return {
      issueId: issue.id,
      title: issue.title || '',
      outcome: 'paused',
      attemptNotes: [`run ${log.runId}: not launched — the run-level rate-limit pause cap had already fired; the issue stays open for the next run`],
    };
  }

  log.info(tr, `starting task (priority ${issue.priority ?? 2}): ${issue.title || ''}`);

  if (!claim(cfg, issue.id)) {
    log.error(tr, 'could not mark the issue in_progress; skipping');
    return null;
  }
  const exported = exportIssue(cfg, issue.id);
  if (!exported.ok) {
    log.error(tr, `could not export the issue: ${exported.error}`);
    finish(cfg, issue.id, { status: 'failed', beads: 'blocked' },
      [`run ${log.runId}: could not export issue spec — ${exported.error}`]);
    return { issueId: issue.id, outcome: 'failed' };
  }
  fs.writeFileSync(path.join(taskDir, 'issue.md'), exported.markdown);

  // ---- per-task workspace: fresh clone, task branch, issue mounted (§4.2, T13) ----
  // Synchronous (spawnSync: git clone), so it blocks the other workers for its few
  // seconds. Deliberate (§7): against container times measured in tens of minutes it is a
  // rounding error, and making it async would widen this into four more runner files. The
  // visible consequence is that a wall-clock kill timer can fire a few seconds late while
  // another worker is cloning. Same for publish() below (git push, gh pr create).
  const ws = prepare(cfg, issue.id, exported.markdown, log, tr);
  if (!ws.ok) {
    log.error(tr, `workspace preparation failed: ${ws.reason}`);
    finish(cfg, issue.id, { status: 'failed', beads: 'blocked' },
      [`run ${log.runId}: workspace preparation failed — ${ws.reason}`]);
    return { issueId: issue.id, outcome: 'failed' };
  }

  // ---- run the task, pausing and resuming across usage windows (§4.7) ----
  // Active time accumulates across relaunches; paused time never counts (§4.6).
  let exec;
  let artifacts;
  let activeMs = 0;
  // PER TASK, and it stays per task: `pauses` counts this task's RELAUNCHES and is what
  // the manifest row reports. The wait-cycle count it used to carry alongside is a
  // different quantity and now lives on the run-level gate, once for the whole run (§7).
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
    // The park is RUN-LEVEL (§7): the FIRST exit 20 of the run opens one shared wait, on
    // that task's reported reset time, and every later reporter — this one included —
    // joins it rather than sleeping against the same window on its own. Joining never
    // extends it: if the window is still closed when it ends, the relaunched tasks exit 20
    // again and open a fresh one. Nothing already running is killed; a container whose
    // window is genuinely closed exits 20 by itself.
    const waited = await gate.reportLimit(artifacts.status, tr);
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

  // ---- memory out-channel (§3.6): file the agent's proposed notes, host as sole
  // Beads writer. Which outcomes qualify is memory.js's rule, not the runner's —
  // shouldFileMemory() states it once, where a Docker-free test can reach it.
  // Non-fatal by construction: it never throws and never touches the outcome.
  if (shouldFileMemory(outcome.status)) {
    const mem = fileMemoryNotes(cfg, issue.id, artifacts.status);
    if (mem.filed) log.info(tr, `memory: filed ${mem.filed} note(s) via bd remember`);
    for (const err of mem.errors) log.error(tr, `memory: could not file a note — ${err}`);
  }

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

  const notes = attemptNotes(log.runId, outcome, artifacts.status, ws.memoryCount);
  if (published.prUrl) notes.push(`PR: ${published.prUrl}`);
  else if (published.pushed) notes.push(`branch pushed for review: ${ws.branch} (no PR — ${outcome.status})`);
  finish(cfg, issue.id, outcome, notes);

  log.info(tr, `task finished: exit ${exec.exitCode} -> ${outcome.status}` +
    (outcome.beads ? ` (issue ${outcome.beads})` : ' (issue stays in_progress)'));
  const v = artifacts.verify;
  const row = {
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
    // §3.7: the agent's "this spec is wrong" channel. Carried onto the manifest so the
    // report and the PR body can surface it — evidence only, and deliberately NOT part of
    // `scrutinyKey`, because a concern that could reorder the report would be a gate (§3.5).
    ...(artifacts.status && Array.isArray(artifacts.status.specConcerns)
      && artifacts.status.specConcerns.length
      ? { specConcerns: artifacts.status.specConcerns } : {}),
    attemptNotes: notes,
  };

  if (process.env.PIPELINE_KEEP_WORKSPACE) log.info(tr, `workspace kept at ${ws.dir}`);
  else discard(ws.dir);
  return row;
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
    // A run refused by the project lock started nothing (§4.12): the lock is the first
    // gate, so there is no network of ours to tear down — and tearing one down here would
    // be acting on plumbing that belongs to the run that holds the lock. Every other
    // preflight failure has already released the lock itself.
    if (!pre.locked) networkDown(REPO_ROOT, cfg);
    process.exit(1);
  }
  // The lock is ours from here to process exit. Registered once, at the point it becomes
  // true, so every later way out — the queue-read abort below, an unexpected throw, the
  // normal end — leaves the project free for the next run rather than a stale lock for it
  // to take over (§4.12). Best effort by construction: a process killed outright runs no
  // handler, which is exactly the case takeover exists for.
  process.on('exit', () => {
    try { releaseLock(REPO_ROOT, cfg.targetRepoPath); } catch { /* never mask the real exit */ }
  });
  log.info(t, `preflight passed${pre.recovered.length ? ` (recovered: ${pre.recovered.join(', ')})` : ''}`);

  if (args.dryRun) {
    log.info(t, 'dry run: stopping before the task loop');
    networkDown(REPO_ROOT, cfg);
    log.info(t, `run finished; artifacts in ${log.dir}`);
    return;
  }

  // ---- the task loop (§4.12): drain the ready queue, one container per task ----
  const q = readyQueue(cfg);
  if (!q.ok) {
    // Two systems, two channels (§4.12). The discriminator is the `cause` FIELD, never the
    // wording: a fetch failure logged as "cannot read the Beads ready queue" sends a person
    // to the wrong system entirely, and the queue is unreadable for want of git, not bd.
    if (q.cause === 'git') {
      log.error(t, 'cannot check which tasks are frozen, so none can be dispatched: ' +
        `${q.error}`);
    } else {
      log.error(t, `cannot read the Beads ready queue: ${q.error}`);
    }
    networkDown(REPO_ROOT, cfg);
    process.exit(1);
  }
  log.info(t, queueSummary(q.issues, q.skipped, q.undispatchable));

  // §4.12's second admission rule refused these before `claim()`, so Beads is untouched and
  // they stay `open` for a freeze session. They never enter drainQueue — the rows are
  // MANUFACTURED here, from the only place that information still exists, because a refused
  // task that produced no row is indistinguishable, after exactly the unattended run where
  // nobody watched it happen, from a task nobody queued.
  const refusedRows = (q.undispatchable || [])
    .map((u) => undispatchableRow(u.issue, u.reason, log.runId));
  for (const u of q.undispatchable || []) {
    log.error(log.trace(u.issue.id), `not dispatched: ${u.reason} — Beads untouched, the issue stays open`);
  }

  // Every task is the same body; `concurrency` (default 1) decides how many of them are
  // in flight at once, and the drain hands back one row per queued issue in READY-QUEUE
  // ORDER — so the manifest reads the same at any depth. A row is null only where the
  // issue could not be claimed and nothing ran.
  //
  // ONE park for the whole run (§7). A usage limit belongs to the subscription window, not
  // to a task, so the gate holds the single shared wait and the single run-level cycle cap
  // that every task in this drain reports into and waits behind.
  const gate = createPauseGate(cfg, log, { token });
  const drained = await drainQueue(q.issues, (issue) => runOneTask(cfg, issue, log, token, gate), cfg.concurrency);
  const results = drained.filter(Boolean);

  if (gate.waits) {
    log.info(t, `run-level rate-limit park: ${gate.waits} shared wait(s), ${gate.cycles} cycle(s) spent` +
      `${gate.exhausted ? ' — the run-level pause cap fired; refused tasks stay open for the next run' : ''}`);
  }
  // The refusals are named here too. "queue drained: (nothing ran)" against a queue that was
  // wholly refused is true and reads like an empty queue — the closing line is where an
  // operator skimming the log stops.
  log.info(t, `queue drained: ${[...results, ...refusedRows].map((r) => `${r.issueId}=${r.outcome}`).join(', ') || '(nothing ran)'}`);

  // ---- manifest + report (§4.9, §4.12) ----
  const { manifest } = writeManifest(log.dir, {
    runId: log.runId,
    startedAt,
    finishedAt: new Date().toISOString(),
    targetRepo: cfg.targetRepoRemote,
    // The CONFIGURED (or defaulted) setting, not the observed peak in flight: what the run
    // was allowed to do is the thing a later reader needs to interpret its wall clock.
    concurrency: cfg.concurrency,
    tasks: [...results, ...refusedRows],
  });
  const reportFile = writeReport(log.dir, manifest);
  log.info(t, `run report: ${reportFile}`);

  networkDown(REPO_ROOT, cfg);
  log.info(t, `run finished; artifacts in ${log.dir}`);
}

// Guarded, so `require('runner/run.js')` runs NOTHING and the scheduler above is reachable
// to a Docker-free test (§7). main() cannot run in a task container anyway — it sits behind
// loadToken and a Docker preflight that always fails there — and every caller in this repo
// invokes this file as `node runner/run.js`, so the guard costs nothing.
if (require.main === module) {
  main().catch((e) => {
    console.error(`runner: unexpected failure — ${e && e.stack ? e.stack : e}`);
    process.exit(3);
  });
}

// `executeTask` is exported for the same reason: its PIPELINE_EXEC_STUB branch is the one
// path a Docker-free suite can execute, and "the stub path does not block the event loop"
// is exactly the kind of thing that regresses silently back to spawnSync.
// `runOneTask` is exported for the same reason again: everything it reaches — Beads, git,
// gh, the container — is behind a seam (PIPELINE_BD_CMD, targetRepoRemote, PIPELINE_GH_CMD,
// PIPELINE_EXEC_STUB), so "a refused task never touches Beads" and "an exit-20 task reports
// to the gate exactly once" are both provable without Docker.
module.exports = { drainQueue, executeTask, runOneTask };
