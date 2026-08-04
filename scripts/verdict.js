#!/usr/bin/env node
// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// The review verdict recorder — DESIGN.md §5 (change-log row `review-verdict`).
//
// Merge-or-send-back is the one signal the pipeline cannot generate about itself: a run
// record can say `done`, green, one attempt, and the human can still reject the PR. That
// verdict exists for one moment, at review time; anything that tries to recover it later
// is inferring what could simply have been written down. So the review ritual ends with
// one line per PR:
//
//   node scripts/verdict.js record <issue-id> <merged|rejected> "<why>" [--run <runId>]
//   node scripts/verdict.js pending
//
// `record` writes `runs/<runId>/tasks/<issue-id>/verdict.json` into the run that produced
// the PR being judged. `pending` lists every PR-bearing task that still lacks one, so an
// unfinished review is visible rather than remembered.
//
// THREE PROPERTIES ARE LOAD-BEARING, and every decision below follows from one of them:
//
//   1. Deterministic scaffolding (hard rule 7). No LLM anywhere near it, and no Beads
//      access of any kind — it must work on a host where `bd` is not installed. Nothing
//      here spawns a child process at all.
//   2. Evidence, never a gate (hard rule 5's shape applied to scaffolding). `record`
//      creates or overwrites exactly one file and edits no existing artifact — never
//      `run.json`, never `status.json`. `pending` exits 0 whatever it finds: it is a
//      report. Usage errors are validated BEFORE any write, so a refusal leaves the runs
//      root byte-identical.
//   3. Host-only. A verdict names PRs and the reason a human gave, so it lives under the
//      git-ignored `runs/` tree with everything else that names the work, and is never
//      committed.
//
// PINNED DECISIONS a future reader would otherwise re-litigate:
//
//   * "The most recent run" is ordered by `run.json`'s `startedAt`. Not by runId — three
//     naming shapes exist in the real tree and they sort wrong against each other — and
//     not by directory mtime, which a copy or a backup rewrites. A run whose `run.json`
//     parses but carries no parseable `startedAt` sorts OLDEST and is never chosen over a
//     dated one. `--run <runId>` overrides recency outright.
//   * With `VERDICT_RUNS_DIR` unset the runs root is resolved from THIS FILE's location
//     (`<script dir>/../runs`), never from the working directory — the reviewer runs this
//     from wherever they happen to be. That is also why this file is self-contained: node
//     built-ins only, no requires of anything else in the repo, so a copy of it works
//     from any repo-shaped root. Keep it that way.
//   * A missing runs root reads as empty: `pending` exits 0 with nothing, `record` fails
//     as an unknown issue.
//   * Entries under the runs root that are not run directories — a plain file, a
//     directory with no `run.json` (`sweeps/`, `locks/`), a malformed `run.json` — are
//     skipped silently. All three shapes exist in a real tree, and a crash there would
//     make the report useless exactly when it is most needed.
//   * `"prUrl": null` is a real value in real manifests. Only a truthy non-empty string
//     counts as PR-bearing, and `record` copies `prUrl` only when truthy — otherwise the
//     written verdict has NO `prUrl` key rather than a null one.
//   * Re-recording the same (run, issue) overwrites in place: one `verdict.json`, the
//     reviewer's latest word wins, `recordedAt` says when.
//
// Covered by tests/unit/verdict.test.js through scripts/test-verdict.sh (Docker-free;
// the sweep discovers it by glob). `VERDICT_RUNS_DIR` is the test seam that re-aims the
// runs root, the same shape as `CHANGELOG_FILE` and `SANITIZE_FIXTURE_DIR`.
'use strict';
const fs = require('fs');
const path = require('path');

const VERDICT_WORDS = ['merged', 'rejected'];

const USAGE = [
  'usage:',
  '  node scripts/verdict.js record <issue-id> <merged|rejected> "<why>" [--run <runId>]',
  '  node scripts/verdict.js pending',
  '',
  'The runs root is $VERDICT_RUNS_DIR, else <script dir>/../runs.',
].join('\n');

// Exit codes. Non-zero is the frozen part; which non-zero is an implementation choice.
const EXIT_OK = 0;
const EXIT_USAGE = 2;   // the command as typed cannot mean anything
const EXIT_NOT_FOUND = 3; // well-formed, but names nothing in the runs tree

// ---- the runs root ------------------------------------------------------------------
// An empty or whitespace-only seam is treated as unset rather than as "the root is the
// empty path": an exported-but-blank variable is a shell accident, not a request.
function runsRoot(env = process.env) {
  const seam = env.VERDICT_RUNS_DIR;
  if (typeof seam === 'string' && seam.trim()) return path.resolve(seam.trim());
  return path.resolve(__dirname, '..', 'runs');
}

// ---- reading the runs tree ----------------------------------------------------------
// Everything malformed is skipped, never thrown on: this is a report over a directory a
// human and several other tools also write into.
function isRunManifest(m) {
  return !!m && typeof m === 'object' && !Array.isArray(m);
}

function taskRows(manifest) {
  if (!Array.isArray(manifest.tasks)) return [];
  const rows = [];
  for (const t of manifest.tasks) {
    if (!t || typeof t !== 'object' || Array.isArray(t)) continue;
    if (typeof t.issueId !== 'string' || !t.issueId.trim()) continue;
    rows.push({ issueId: t.issueId.trim(), prUrl: prUrlOf(t) });
  }
  return rows;
}

// Only a truthy non-empty string is a PR. `null`, an absent key, `""` and a non-string
// all mean "this task produced no pull request".
function prUrlOf(row) {
  return typeof row.prUrl === 'string' && row.prUrl.trim() ? row.prUrl : null;
}

// Newest first by startedAt; undated runs last, and never chosen over a dated one. The
// runId tie-break is there so two runs with the same startedAt resolve the same way on
// every invocation — a recorder that picked differently each time would be worse than
// one that picked wrong.
function byRecency(a, b) {
  if (a.startedAt === null && b.startedAt === null) return a.runId.localeCompare(b.runId);
  if (a.startedAt === null) return 1;
  if (b.startedAt === null) return -1;
  if (a.startedAt !== b.startedAt) return b.startedAt - a.startedAt;
  return a.runId.localeCompare(b.runId);
}

function readRuns(root) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return []; // a missing (or unreadable) root reads as empty
  }
  const runs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue; // a plain file at the root — `runs/live-*.log`
    const dir = path.join(root, entry.name);
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(dir, 'run.json'), 'utf8'));
    } catch {
      continue; // no run.json (sweeps/, locks/) or a malformed one — not a run directory
    }
    if (!isRunManifest(manifest)) continue;
    const runId = typeof manifest.runId === 'string' && manifest.runId.trim()
      ? manifest.runId.trim() : entry.name;
    const parsed = typeof manifest.startedAt === 'string' ? Date.parse(manifest.startedAt) : NaN;
    runs.push({
      dirName: entry.name,
      dir,
      runId,
      startedAt: Number.isNaN(parsed) ? null : parsed,
      tasks: taskRows(manifest),
    });
  }
  runs.sort(byRecency);
  return runs;
}

const verdictPath = (run, issueId) => path.join(run.dir, 'tasks', issueId, 'verdict.json');
const hasVerdict = (run, issueId) => fs.existsSync(verdictPath(run, issueId));
const rowFor = (run, issueId) => run.tasks.find((t) => t.issueId === issueId) || null;

// ---- record -------------------------------------------------------------------------
// Arguments are parsed and validated in full before the runs tree is even read, so every
// refusal below happens with nothing written.
function parseRecordArgs(argv) {
  const positional = [];
  let runId = null;
  const args = argv.slice();
  while (args.length) {
    const a = args.shift();
    if (a === '--run') {
      if (!args.length) return { error: '--run needs a runId' };
      runId = args.shift();
      if (!runId || !runId.trim()) return { error: '--run needs a runId' };
      runId = runId.trim();
    } else if (a.startsWith('--')) {
      return { error: `unknown option "${a}"` };
    } else {
      positional.push(a);
    }
  }
  const [issueId, verdict, reason, ...extra] = positional;
  if (!issueId) return { error: 'record needs an issue id' };
  if (issueId.includes('/') || issueId.includes('\\') || issueId === '.' || issueId === '..') {
    return { error: `"${issueId}" is not an issue id` };
  }
  if (!verdict) return { error: `record needs a verdict word (${VERDICT_WORDS.join('|')})` };
  if (!VERDICT_WORDS.includes(verdict)) {
    return { error: `"${verdict}" is not a verdict — use ${VERDICT_WORDS.join(' or ')}` };
  }
  if (typeof reason !== 'string' || !reason.trim()) {
    return { error: 'record needs a reason — why it was merged or sent back' };
  }
  if (extra.length) return { error: `unexpected argument "${extra[0]}" (quote the reason)` };
  return { issueId: issueId.trim(), verdict, reason, runId };
}

function record(argv, out, err) {
  const opts = parseRecordArgs(argv);
  if (opts.error) {
    err(`verdict: ${opts.error}`);
    err(USAGE);
    return EXIT_USAGE;
  }

  const root = runsRoot();
  const runs = readRuns(root);
  let chosen = null;
  let row = null;
  if (opts.runId) {
    const named = runs.find((r) => r.runId === opts.runId || r.dirName === opts.runId);
    if (!named) {
      err(`verdict: no run "${opts.runId}" under ${root}`);
      return EXIT_NOT_FOUND;
    }
    row = rowFor(named, opts.issueId);
    if (!row) {
      err(`verdict: run "${opts.runId}" carries no task ${opts.issueId}`);
      return EXIT_NOT_FOUND;
    }
    chosen = named;
  } else {
    for (const run of runs) { // already newest-first
      const found = rowFor(run, opts.issueId);
      if (found) { chosen = run; row = found; break; }
    }
    if (!chosen) {
      err(`verdict: no run under ${root} carries task ${opts.issueId}`);
      return EXIT_NOT_FOUND;
    }
  }

  // Key order is the order a human reads it in: what, where, the call, the why, the
  // witness, the when. `prUrl` is present only when there is one.
  const verdict = {
    issueId: opts.issueId,
    runId: chosen.runId,
    verdict: opts.verdict,
    reason: opts.reason,
  };
  if (row.prUrl) verdict.prUrl = row.prUrl;
  verdict.recordedAt = new Date().toISOString();

  const taskDir = path.join(chosen.dir, 'tasks', opts.issueId);
  fs.mkdirSync(taskDir, { recursive: true }); // the run may never have had a tasks/<id>/
  fs.writeFileSync(path.join(taskDir, 'verdict.json'), `${JSON.stringify(verdict, null, 2)}\n`);
  out(`verdict: ${opts.verdict} recorded for ${opts.issueId} in run ${chosen.runId}`);
  return EXIT_OK;
}

// ---- pending ------------------------------------------------------------------------
// A report, never a gate: exit 0 whatever it finds, including nothing and including a
// runs root that does not exist.
function pending(argv, out, err) {
  if (argv.length) {
    err(`verdict: pending takes no arguments (got "${argv[0]}")`);
    err(USAGE);
    return EXIT_USAGE;
  }
  const root = runsRoot();
  const awaiting = [];
  for (const run of readRuns(root)) { // newest run first
    for (const task of run.tasks) {
      if (!task.prUrl) continue; // not PR-bearing — nothing to judge
      if (hasVerdict(run, task.issueId)) continue;
      awaiting.push({ runId: run.runId, issueId: task.issueId, prUrl: task.prUrl });
    }
  }
  out(`== PRs awaiting a verdict (${awaiting.length}) ==`);
  for (const a of awaiting) out(`  ${a.runId}  ${a.issueId}  ${a.prUrl}`);
  if (!awaiting.length) out('  none — every PR-bearing task in every run carries a verdict');
  out('record one with: node scripts/verdict.js record <issue-id> <merged|rejected> "<why>"');
  return EXIT_OK;
}

// ---- CLI ----------------------------------------------------------------------------
function main(argv, out = console.log, err = console.error) {
  const args = argv.slice();
  const mode = args.shift();
  if (mode === 'record') return record(args, out, err);
  if (mode === 'pending') return pending(args, out, err);
  err(mode ? `verdict: unknown mode "${mode}"` : 'verdict: no mode given');
  err(USAGE);
  return EXIT_USAGE;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { main, record, pending, readRuns, runsRoot, prUrlOf, byRecency, USAGE };
