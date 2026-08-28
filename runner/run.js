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
  readyQueue, claim, exportIssue, finish, outcomeFor, attemptNotes,
  undispatchableRow, logQueueRead, logUndispatched,
} = require('./queue');
const { prepare, hasCommits, collectArtifacts, discard } = require('./workspace');
const { runTask } = require('./container');
const { createPauseGate } = require('./pause');
const { createFeedSource, fixedSource, ENDINGS } = require('./feed');
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
// `source` is either the ready queue as a plain ARRAY — the historic contract, and still
// what every existing caller passes — or a live source from `runner/feed.js` that re-reads
// the queue while the run is in flight (§4.12, change-log row `live-queue-feed`).
// `taskFn(issue)` is the runner's own per-task body; at most `concurrency` of those calls
// are in flight at once. The resolved array is INDEX-ALIGNED WITH DISPATCH ORDER, so a task
// that finishes first does not overtake its neighbours in the manifest. For an array those
// are the same thing — the cursor hands items out in ready-queue order — which is why
// wrapping an array in `fixedSource` changes no existing behaviour and no existing result.
//
// N fixed workers pulling from a shared source, rather than a promise-set watched with
// Promise.race: nothing here needs to know which task finished, only that a slot opened.
// A worker asking for work IS the free-slot signal a live source polls on, so the shape
// chosen for ordering turns out to be the shape feeding needs.
async function drainQueue(source, taskFn, concurrency) {
  const live = source && !Array.isArray(source) && typeof source.next === 'function';
  const src = live ? source : fixedSource(source);
  const n = Number.isInteger(concurrency) && concurrency > 0 ? concurrency : 1;
  const results = [];
  const worker = async () => {
    for (;;) {
      const item = await src.next();
      if (!item) return;
      results[item.index] = await taskFn(item.issue, item.index);
    }
  };
  // A live source has no length to bound the pool by — the whole point is that more work
  // may arrive — so the pool is `concurrency` wide and the source decides when to stop
  // feeding it. A fixed source still starts no more workers than it has items.
  const width = live ? n : Math.min(n, Array.isArray(source) ? source.length : 0);
  const workers = [];
  for (let i = 0; i < width; i++) workers.push(worker());
  await Promise.all(workers);
  // Dispatch indices are dense — the source hands them out sequentially — but a worker whose
  // body resolved `undefined` leaves a hole that `Array.from` normalises away, so callers see
  // a real list at every index rather than a sparse array they have to know about.
  return Array.from(results);
}

// ---- the two ledger-only task facts (§4.12, §5; change-log row `repo-3xw`) --------------
// Neither has a prose form, and that is the point: `run.log` already tells a human how the
// task ended, and nothing it could say would let a reader ask "did the last two attempts fail
// the same set of checks?" without re-parsing a verifier log it may no longer have. So these
// go to the ledger only — `log.event()`, `msg: null`, never echoed — and `run.log` stays
// byte-identical for the human reading it.

// WHICH checks failed, from `scripts/sweep-assertions.js`: the one file that owns this repo's
// assertion-line vocabulary. Importing it rather than re-parsing here is the whole reason
// `failingChecks` was added there — a second parser would drift the first time a suite's
// output changed, and the drift would be a name list that is non-empty, well-formed and stale.
const { failingChecks } = require('../scripts/sweep-assertions');

// THREE ANSWERS, and they are three different facts:
//   [ ]   — nothing failed;
//   [...] — these failed;
//   null  — nothing is known either way.
// Collapsing the third onto the first is the "non-empty, well-formed and false" shape this
// repo keeps paying for: a reader comparing attempt sets would score two attempts that
// recorded nothing as having failed identically.
//
// TWO ways to know the set is empty, and only one of them needs text. Where the attempt left
// verifier output, the names come from parsing it. Where it left none but the verifier called
// it a PASS, the set is empty by definition — the frozen suite ran and every check in it
// passed — and answering `null` there would be a small lie about a fact the run does know.
// `null` is reserved for the case that is genuinely unknown: an attempt that FAILED and whose
// output did not survive (a killed container leaves a half-written verify.json, which
// `collectArtifacts` drops on purpose), where the run knows something failed and not what.
function checksFor(attempt, text) {
  if (typeof text === 'string') return failingChecks(text);
  if (attempt && attempt.verifierResult === 'pass') return [];
  return null;
}

// The THIRD argument of `info`/`error` has always been absent-safe — a log object that ignores
// it still works, which is what lets four other suites hand `runOneTask` a bare
// `{info, error}` stand-in. `event()` is a different shape and cannot be ignored the same way:
// calling a method that is not there THROWS, from inside the task body, after the container
// has run and before the outcome is written. So both emitters ask for the writer first.
// This is not a fail-safe swallow of an error — its ABSENCE is checked, never its failure —
// and it costs a real run nothing, because the real `runner/log.js` always has it.
const hasLedger = (log) => !!log && typeof log.event === 'function';

function logAttempts(log, tr, issueId, status, verify) {
  if (!hasLedger(log)) return;
  const attempts = (status && Array.isArray(status.attempts)) ? status.attempts : [];
  attempts.forEach((a, i) => {
    // Only a FAILING attempt records feedback — `pipeline/entrypoint.sh` writes it from that
    // attempt's verify.json when the verifier exits 1, and a pass has nothing to feed back.
    // `verify.json` itself survives for the LAST attempt only, because each attempt
    // overwrites it, so its output may stand in for the final attempt and no other.
    const feedback = a && typeof a.feedback === 'string' ? a.feedback : null;
    const final = i === attempts.length - 1;
    const text = feedback !== null ? feedback
      : (final && verify && typeof verify.acceptanceOutput === 'string' ? verify.acceptanceOutput : null);
    log.event(tr, 'attempt.finished', {
      // Carried in `data` as well as in the envelope: the envelope's `issueId` is derived from
      // the trace, and a reader extracting attempt rows should not have to know that rule.
      issueId,
      number: Number.isInteger(a && a.number) ? a.number : null,
      verifierResult: (a && typeof a.verifierResult === 'string') ? a.verifierResult : null,
      failingChecks: checksFor(a, text),
    });
  });
}

// §3.7's "this spec is wrong" channel, one event per entry, VERBATIM — never summarised and
// never counted, because the text is the whole content of a concern. Non-strings are skipped
// rather than coerced: `pipeline/status.js` bounds this channel on the way in, but the status
// file is not schema-validated here, and `String(x)` on a stray object would file `[object
// Object]` as a concern a human then has to go and disprove (repo-iok-note-2's lesson).
// Evidence only, exactly like every other surface this channel reaches: it cannot change an
// outcome (§3.5).
function logConcerns(log, tr, status) {
  if (!hasLedger(log)) return;
  const concerns = (status && Array.isArray(status.specConcerns)) ? status.specConcerns : [];
  for (const text of concerns) {
    if (typeof text !== 'string') continue;
    log.event(tr, 'concern.raised', { text });
  }
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
    log.error(tr, 'refused: the run-level rate-limit pause cap has fired; nothing launched, issue stays open',
      { event: 'task.refused', data: {} });
    return {
      issueId: issue.id,
      title: issue.title || '',
      outcome: 'paused',
      attemptNotes: [`run ${log.runId}: not launched — the run-level rate-limit pause cap had already fired; the issue stays open for the next run`],
    };
  }

  // One expression, two records: the ledger's `priority` is the number the line printed,
  // never a second reading of `issue`, so the twin cannot disagree with its own message.
  const priority = issue.priority ?? 2;
  const title = issue.title || '';
  log.info(tr, `starting task (priority ${priority}): ${title}`,
    { event: 'task.started', data: { priority, title } });

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
        `${exec.killed ? ' (killed at budget)' : ''}; active total ${Math.round(activeMs / 1000)}s`, {
        event: 'container.ran',
        data: {
          seconds: Math.round(exec.durationMs / 1000),
          killed: !!exec.killed,
          activeSeconds: Math.round(activeMs / 1000),
        },
      });
    }
    artifacts = collectArtifacts(ws.dir, taskDir);

    if (exec.exitCode !== 20) break;                       // not a rate limit — done

    pauses += 1;
    log.info(tr, `rate limit hit (pause ${pauses}) — parking the task; issue stays in_progress`,
      { event: 'task.rateLimited', data: { pause: pauses } });
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
    log.info(tr, 'relaunching in a fresh container against the same workspace (attempt counter carries over)',
      { event: 'task.relaunched', data: {} });
  }
  if (pauses) log.info(tr, `task resumed across ${pauses} usage-window pause(s)`);

  // ---- the two ledger-only facts (§4.12, §5; change-log row `repo-3xw`) ----------------
  // AFTER the relaunch loop, once, from the COLLECTED status file — never inside it. A parked
  // task collects its status on every relaunch, and emitting there would write attempt 1
  // twice for a task that paused once and three times for one that paused twice: a ledger
  // whose attempt count depends on how the subscription window happened to fall.
  logAttempts(log, tr, issue.id, artifacts.status, artifacts.verify);
  logConcerns(log, tr, artifacts.status);

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
    (outcome.beads ? ` (issue ${outcome.beads})` : ' (issue stays in_progress)'), {
    event: 'task.finished',
    // `beads` is null rather than absent when the issue stays in_progress: "no Beads
    // transition" is a fact about this task, and a missing key would make it read as a
    // ledger written before the field existed.
    data: { exitCode: exec.exitCode, outcome: outcome.status, beads: outcome.beads || null },
  });
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
  log.info(t, `target: ${cfg.targetRepoPath} -> ${cfg.targetRepoRemote}`,
    { event: 'run.target', data: { url: cfg.targetRepoRemote } });

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
    log.info(t, `run finished; artifacts in ${log.dir}`, { event: 'run.finished', data: { dir: log.dir } });
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
  // The summary line and its structured twin, from ONE call (change-log row `repo-3xw`).
  // `queueSummary` is no longer called here: two call sites would be two chances for the
  // prose and the event to describe different queues.
  logQueueRead(log, q);

  // Every task is the same body; `concurrency` (default 1) decides how many of them are
  // in flight at once, and the drain hands back one row per DISPATCHED issue in dispatch
  // order — so the manifest reads the same at any depth. A row is null only where the issue
  // could not be claimed and nothing ran.
  //
  // ONE park for the whole run (§7). A usage limit belongs to the subscription window, not
  // to a task, so the gate holds the single shared wait and the single run-level cycle cap
  // that every task in this drain reports into and waits behind.
  const gate = createPauseGate(cfg, log, { token });

  // The source the pool pulls from (§4.12, change-log row `live-queue-feed`). With
  // `feedIdleGraceMinutes` at its default of 0 this is a fixed roster and the run behaves
  // exactly as it did before feeding existed: read once, drain, close out.
  const source = createFeedSource(q.issues, {
    poll: () => readyQueue(cfg),
    concurrency: cfg.concurrency,
    idleGraceMs: cfg.feedIdleGraceMinutes * 60000,
    pollMs: cfg.feedPollSeconds * 1000,
    // The STARTUP roster's refusals, seeded here rather than left to the first poll. A
    // non-fed run never polls at all, so without this the source's refusal map stays empty
    // for the whole run and `source.undispatchable()` below hands back nothing: the manifest
    // gets no row, the report reads "0 task(s): none", and a queue that was WHOLLY refused
    // becomes indistinguishable from a queue nobody filled. Refusals stay live exactly as
    // before — a poll still replaces this map wholesale.
    undispatchable: q.undispatchable,
    // The sentinel is per RUN and lives beside that run's artifacts, so stopping a fed run
    // is `touch runs/<runId>/stop` from anywhere — no signal, no pid, and no killing a
    // process that is holding containers. Workers finish what they hold; nothing new starts.
    stopFile: path.join(log.dir, 'stop'),
    // Once the §7 run-level cap has fired, every further task is refused before it launches
    // and stays `open`. A fed run that kept polling would sit idle handing out work nothing
    // can start, so the fired cap closes the feed instead.
    shouldStop: () => gate.exhausted,
    log,
  });
  if (source.fed) {
    log.info(t, `live queue feed: ON — re-reading the ready queue while the run is in flight; `
      + `closing after ${cfg.feedIdleGraceMinutes} idle minute(s), or when ${path.join(log.dir, 'stop')} appears`,
    { event: 'feed.on', data: {} });
  }

  const drained = await drainQueue(source, (issue) => runOneTask(cfg, issue, log, token, gate), cfg.concurrency);
  const results = drained.filter(Boolean);

  // §4.12's second admission rule refused these before `claim()`, so Beads is untouched and
  // they stay `open` for a freeze session. They never enter drainQueue — the rows are
  // MANUFACTURED here, from the only place that information still exists, because a refused
  // task that produced no row is indistinguishable, after exactly the unattended run where
  // nobody watched it happen, from a task nobody queued.
  //
  // Read from the SOURCE and after the drain, never from the startup read: under feeding a
  // refusal is a wait, not a verdict, so a task refused at 14:05 whose suite was pushed at
  // 14:20 ran and has a PR. Reporting it as undispatchable would be a lie about a task the
  // reviewer can see succeeded.
  const stillRefused = source.undispatchable();
  const refusedRows = stillRefused.map((u) => undispatchableRow(u.issue, u.reason, log.runId));
  for (const u of stillRefused) logUndispatched(log, u);

  if (gate.waits) {
    log.info(t, `run-level rate-limit park: ${gate.waits} shared wait(s), ${gate.cycles} cycle(s) spent` +
      `${gate.exhausted ? ' — the run-level pause cap fired; refused tasks stay open for the next run' : ''}`);
  }
  if (source.fed) {
    // `ending` is normalised the way the manifest below normalises it, so the ledger and
    // run.json give a later reader the same vocabulary for how the run ended.
    log.info(t, `live queue feed: ${source.polls()} re-read(s) of the ready queue; run ended: ${source.ending()}`,
      { event: 'feed.closed', data: { polls: source.polls(), ending: source.ending() || ENDINGS.DRAINED } });
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
    // Recorded whether or not it was on, so a later reader can tell "this run did not feed"
    // from "this manifest predates feeding" — the same reason `concurrency` is written even
    // when it is 1. `ending` is the fact the log line alone would lose: a run that stopped
    // because someone touched the sentinel and one that ran out of work look identical in
    // the outcome table.
    feed: {
      enabled: !!source.fed,
      idleGraceMinutes: cfg.feedIdleGraceMinutes,
      polls: source.polls(),
      ending: source.ending() || ENDINGS.DRAINED,
    },
    tasks: [...results, ...refusedRows],
  });
  const reportFile = writeReport(log.dir, manifest);
  log.info(t, `run report: ${reportFile}`);

  networkDown(REPO_ROOT, cfg);
  log.info(t, `run finished; artifacts in ${log.dir}`, { event: 'run.finished', data: { dir: log.dir } });
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
// `logAttempts` and `logConcerns` are exported for the third time on the same reasoning: the
// trichotomy they decide — `[]` vs a list vs `null` — turns on shapes a fixture RUN can only
// reach one of at a time (a container writes one status file per task), and the answer that
// matters most is the one for an attempt whose output did not survive. Driven directly, a
// planted status object reaches all of them in a few lines and none of them needs a clone.
module.exports = { drainQueue, executeTask, runOneTask, logAttempts, logConcerns };
