#!/usr/bin/env node
// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// The run-history audit — read the corpus, print one report, change nothing
// (DESIGN.md §5, change-log row `run-audit`).
//
//   node scripts/audit-runs.js          (no arguments; any argument is a usage error)
//
// It walks the runs root, joins the structured artifacts a run leaves behind — `run.json`
// as the spine, per-task `status.json`, `verify.json` and `verdict.json` as refinements —
// and prints ONE markdown report to stdout. What it prints is the reading a human did by
// hand once (2026-08-04: 134 run directories, 103 task records) and should never have to
// do again: which entries under the root are runs at all, why the preflight failures
// failed, what each target's outcomes look like, which issue ids came back run after run,
// which partials were killed by a *sibling's* frozen tests, whether the evidence channels
// (spec concerns, memory notes, review verdicts) are being used, and the shape of the
// activeSeconds / diffLines distributions.
//
// Three properties are load-bearing, and each has a frozen test:
//   * It is a PURE READER. It creates, modifies and deletes nothing, anywhere — no cache,
//     no index, no report file. Stdout only; the human redirects if they want a copy, and
//     that copy lands under the git-ignored `runs/` because the report names targets, PR
//     URLs and issue ids.
//   * It is NEVER A GATE (hard rule 5's shape applied to scaffolding). Exit 0 on any
//     readable tree, whatever it finds — a broken manifest, an empty root, a missing root.
//     The only non-zero exit is a usage error, which prints usage and no report.
//   * It holds NO LLM (hard rule 7). A measurement that cannot hallucinate is the entire
//     value: the hand pass this replaces mis-keyed `specConcerns` as `concerns` and
//     reported a 43-use channel as never used — non-empty, well-formed and false.
//
// Deterministic to the byte: fixed section order, every row order pinned (runs and
// sequences by `run.json`'s `startedAt` ascending — never runId sort, never mtime — and
// everything else by count then key, compared as code units so no locale can move a row),
// nearest-rank quantiles so every printed statistic is an actual observed sample, and no
// wall-clock timestamp anywhere. Two invocations over one tree produce identical bytes.
//
// Self-contained on purpose: node built-ins only, no requires of other repo files, so a
// copy of this file works from any repo-shaped root (the tests rely on that to prove the
// default root resolves from the script's own location and not the cwd). `AUDIT_RUNS_DIR`
// re-aims the root, pinned identically to `VERDICT_RUNS_DIR` so the two tools cannot
// drift. A missing root is an empty corpus, not an error.
//
// Docker-free by construction; covered forever by scripts/test-audit-runs.sh over
// tests/unit/audit-runs.test.js.
'use strict';
const fs = require('fs');
const path = require('path');

const USAGE = [
  'usage: node scripts/audit-runs.js',
  '',
  'Reads the pipeline run corpus and prints one markdown report to stdout.',
  'It takes no arguments. Set AUDIT_RUNS_DIR to re-aim the runs root; the default is',
  '<script dir>/../runs. It writes nothing and exits 0 whatever it finds.',
].join('\n');

// ---- reading ------------------------------------------------------------------------
// Everything here answers "null" rather than throwing: an unreadable file is a fact to
// report, never a reason to stop. The corpus is a pile of artifacts left by runs that
// were, by definition, sometimes going wrong.

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (_) {
    return null;
  }
}

function readJson(file) {
  const raw = readText(file);
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch (_) {
    return null;
  }
}

// The promoted line-endings convention: guard at the point of parsing and nowhere else.
// The working copy on the reference host is CRLF, every container writes LF, and a run.log
// carrying \r must group with its LF twin rather than becoming a second reason.
function splitLines(text) {
  return String(text).split(/\r?\n/).map((line) => line.replace(/\r+$/, ''));
}

function str(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function resolveRoot() {
  const seam = process.env.AUDIT_RUNS_DIR;
  if (typeof seam === 'string' && seam.trim() !== '') return path.resolve(seam);
  return path.resolve(__dirname, '..', 'runs');
}

function listEntries(root) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (_) {
    return []; // a missing or unreadable root is an empty corpus, not an error
  }
  return entries
    .map((e) => ({ name: e.name, isDir: e.isDirectory() }))
    .sort((a, b) => cmp(a.name, b.name));
}

// The last line carrying the ERROR level token, with its timestamp and [runId/phase] tag
// stripped. It is NOT always a `PREFLIGHT FAILED` line — group whatever it says; a log
// with no ERROR line at all is its own pinned group (28 of the 60 real preflight dirs).
const NO_ERROR_LINE = '(no ERROR line in run.log)';

function reasonFromLog(text) {
  const lines = splitLines(text);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const at = lines[i].search(/(^|\s)ERROR(\s|$)/);
    if (at < 0) continue;
    const rest = lines[i]
      .slice(at)
      .replace(/^\s*ERROR\s*/, '')      // the level token itself
      .replace(/^\[[^\]]*\]\s*/, '')    // the [runId/phase] tag
      .trim();
    return rest === '' ? '(ERROR line with no message)' : rest;
  }
  return NO_ERROR_LINE;
}

function readTask(runDir, row) {
  const issueId = str(row.issueId) || '(no issueId)';
  const taskDir = path.join(runDir, 'tasks', issueId);
  return {
    issueId,
    outcome: str(row.outcome) || '(no outcome)',
    exitCode: num(row.exitCode),
    attempts: num(row.attempts),
    pauses: num(row.pauses) || 0,
    model: str(row.model),
    prUrl: str(row.prUrl),                    // `prUrl: null` is a real value, not a PR
    activeSeconds: num(row.activeSeconds),
    diffLines: num(row.diffLines),
    status: readJson(path.join(taskDir, 'status.json')),
    verify: readJson(path.join(taskDir, 'verify.json')),
    verdict: readJson(path.join(taskDir, 'verdict.json')),
  };
}

function readRun(root, dirName, manifest) {
  const runDir = path.join(root, dirName);
  const startedAt = str(manifest.startedAt);
  const rows = Array.isArray(manifest.tasks) ? manifest.tasks : [];
  return {
    dirName,
    runId: str(manifest.runId) || dirName,
    // A parseable run.json without a parseable startedAt sorts OLDEST (the `repo-1ie`
    // pin, reused): three runId naming shapes exist and interleave wrongly under a name
    // sort, and a directory copy rewrites mtime.
    startedAt: startedAt !== null && Number.isFinite(Date.parse(startedAt)) ? startedAt : null,
    target: str(manifest.targetRepo) || '(no targetRepo)',
    tasks: rows
      .filter((r) => r && typeof r === 'object' && !Array.isArray(r))
      .map((r) => readTask(runDir, r)),
  };
}

// Code-unit ordering, never localeCompare: byte-determinism must not depend on the host's
// ICU data.
function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareRuns(a, b) {
  if (a.startedAt === null && b.startedAt !== null) return -1;
  if (a.startedAt !== null && b.startedAt === null) return 1;
  if (a.startedAt !== null && b.startedAt !== null && a.startedAt !== b.startedAt) {
    return cmp(a.startedAt, b.startedAt);
  }
  return cmp(a.runId, b.runId); // so two runs at one instant resolve identically every call
}

// Every readdir entry lands in exactly one of three buckets, and the counts reconcile
// against the raw total. All of these shapes exist in the real tree.
function readCorpus(root) {
  const entries = listEntries(root);
  const runs = [];
  const preflight = [];
  const other = [];
  for (const entry of entries) {
    if (!entry.isDir) {
      other.push({ name: entry.name, kind: 'file' });
      continue;
    }
    const manifestPath = path.join(root, entry.name, 'run.json');
    if (fs.existsSync(manifestPath)) {
      const manifest = readJson(manifestPath);
      if (manifest) runs.push(readRun(root, entry.name, manifest));
      else other.push({ name: entry.name, kind: 'unreadable-manifest' });
      continue;
    }
    const log = readText(path.join(root, entry.name, 'run.log'));
    if (log !== null) preflight.push({ name: entry.name, reason: reasonFromLog(log) });
    else other.push({ name: entry.name, kind: 'no-artifacts' });
  }
  runs.sort(compareRuns);
  return { total: entries.length, runs, preflight, other };
}

// ---- tallying -----------------------------------------------------------------------

function tally(map, key, by) {
  map.set(key, (map.get(key) || 0) + (by === undefined ? 1 : by));
  return map;
}

// Descending by count, then ascending by key — the pinned order for every grouped list.
function byCountThenKey(map) {
  return [...map.entries()].sort((a, b) => (b[1] - a[1]) || cmp(a[0], b[0]));
}

function byKey(map) {
  return [...map.entries()].sort((a, b) => cmp(a[0], b[0]));
}

// Nearest-rank quantiles: sort ascending, take element ceil(p * n), 1-indexed. Always an
// actual observed sample, never an interpolation — which is what keeps the output stable
// to the byte, and what keeps every printed number one that really happened.
function nearestRank(sorted, p) {
  const rank = Math.ceil(p * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

function distribution(runs, key) {
  const samples = [];
  let excluded = 0;
  for (const run of runs) {
    for (const task of run.tasks) {
      if (task.outcome !== 'done') continue; // done tasks only
      if (task[key] === null) excluded += 1;
      else samples.push(task[key]);
    }
  }
  samples.sort((a, b) => a - b);
  return { key, samples, excluded };
}

const SIBLING_RE = /frozen acceptance tests in tests\/acceptance\/([^/\s]+)\/ FAIL/g;

// Partial forensics read verify.json, never the task row's embedded `verification` copy —
// that copy carries no regressionOutput, so an audit reading it is silently empty forever.
function siblingsOf(task) {
  const verify = task.verify;
  const output = verify && typeof verify.regressionOutput === 'string' ? verify.regressionOutput : null;
  if (output === null) return null; // "no regressionOutput key" is a fact, not an empty list
  const found = new Set();
  for (const line of splitLines(output)) {
    SIBLING_RE.lastIndex = 0;
    let m = SIBLING_RE.exec(line);
    while (m) {
      found.add(m[1]);
      m = SIBLING_RE.exec(line);
    }
  }
  return [...found].sort(cmp);
}

// ---- rendering ----------------------------------------------------------------------

function render(corpus) {
  const { runs } = corpus;
  const out = [];
  const line = (s) => out.push(s === undefined ? '' : s);

  line('# Run-history audit');
  line();
  line('A deterministic reading of the run corpus. Evidence for a human, never a verdict.');
  line();

  // ---- corpus -----------------------------------------------------------------------
  line('## Corpus');
  line();
  line(`- total entries: ${corpus.total}`);
  line(`- real runs: ${runs.length}`);
  line(`- preflight dirs: ${corpus.preflight.length}`);
  line(`- other entries: ${corpus.other.length}`);
  line();
  line('Every entry under the runs root lands in exactly one bucket, so the buckets');
  line('reconcile against the raw total.');
  line();

  line('### Preflight-failure reasons');
  line();
  if (!corpus.preflight.length) {
    line('- (no preflight-failure directories)');
  } else {
    const grouped = new Map();
    for (const dir of corpus.preflight) {
      if (!grouped.has(dir.reason)) grouped.set(dir.reason, []);
      grouped.get(dir.reason).push(dir.name);
    }
    const rows = [...grouped.entries()].sort((a, b) => (b[1].length - a[1].length) || cmp(a[0], b[0]));
    for (const [reason, dirs] of rows) {
      line(`- ${dirs.length}: ${reason}`);
      line(`  (${dirs.slice().sort(cmp).join(', ')})`);
    }
  }
  line();

  line('### Other entries');
  line();
  if (!corpus.other.length) line('- (none)');
  for (const entry of corpus.other.slice().sort((a, b) => cmp(a.name, b.name))) {
    line(`- ${entry.name} — ${entry.kind}`);
  }
  line();

  // ---- runs -------------------------------------------------------------------------
  line('## Runs');
  line();
  line('Ordered by startedAt ascending; a run whose manifest carries none sorts oldest.');
  line();
  if (!runs.length) line('- (no parseable run.json under the runs root)');
  for (const run of runs) {
    const when = run.startedAt === null ? '(no startedAt)' : run.startedAt;
    line(`- ${when} ${run.runId} — ${run.target} — ${run.tasks.length} task rows`);
    for (const task of run.tasks.slice().sort((a, b) => cmp(a.issueId, b.issueId))) {
      line(`  - ${task.issueId}:${task.outcome}:${task.exitCode === null ? '(none)' : task.exitCode}`);
    }
  }
  line();

  // ---- targets ----------------------------------------------------------------------
  line('## Targets');
  line();
  const targets = new Map();
  for (const run of runs) {
    if (!targets.has(run.target)) targets.set(run.target, { runs: 0, tasks: 0, outcomes: new Map() });
    const t = targets.get(run.target);
    t.runs += 1;
    t.tasks += run.tasks.length;
    for (const task of run.tasks) tally(t.outcomes, task.outcome);
  }
  if (!targets.size) line('- (no targets — no real runs)');
  for (const [target, t] of byKey(targets)) {
    line(`### ${target}`);
    line();
    line(`- runs: ${t.runs}`);
    line(`- task rows: ${t.tasks}`);
    for (const [outcome, count] of byCountThenKey(t.outcomes)) line(`- ${outcome}: ${count}`);
    line();
  }

  // ---- repeats ----------------------------------------------------------------------
  line('## Repeated issues');
  line();
  line('An issueId carried by more than one real run, its runs in startedAt order.');
  line();
  const seen = new Map();
  for (const run of runs) {
    for (const task of run.tasks) {
      if (!seen.has(task.issueId)) seen.set(task.issueId, []);
      seen.get(task.issueId).push(
        `${run.runId}:${task.outcome}:${task.exitCode === null ? '(none)' : task.exitCode}`
      );
    }
  }
  const repeats = byKey(seen).filter(([, items]) => items.length > 1);
  if (!repeats.length) line('- (no issueId appears in more than one run)');
  for (const [issueId, items] of repeats) {
    line(`- ${issueId} in ${items.length} runs: ${items.join(', ')}`);
  }
  line();

  // ---- effort -----------------------------------------------------------------------
  line('## Effort');
  line();
  line('### Attempts (done tasks)');
  line();
  const attempts = new Map();
  let doneTasks = 0;
  for (const run of runs) {
    for (const task of run.tasks) {
      if (task.outcome !== 'done') continue;
      doneTasks += 1;
      tally(attempts, task.attempts === null ? '(not recorded)' : String(task.attempts));
    }
  }
  if (!attempts.size) line('- (no done tasks)');
  // Numeric, not lexicographic: "10" sorts before "2" as a string, and the bound is a
  // config knob rather than three forever. The unrecorded bucket sorts last.
  const attemptOrder = [...attempts.entries()].sort((a, b) => {
    const x = Number(a[0]);
    const y = Number(b[0]);
    if (Number.isFinite(x) && Number.isFinite(y)) return x - y;
    if (Number.isFinite(x)) return -1;
    if (Number.isFinite(y)) return 1;
    return cmp(a[0], b[0]);
  });
  for (const [key, count] of attemptOrder) line(`- ${key} attempt(s): ${count}`);
  line();

  line('### Rate-limit pauses');
  line();
  let pauseSum = 0;
  for (const run of runs) for (const task of run.tasks) pauseSum += task.pauses;
  line(`- pauses across every task row (sum): ${pauseSum}`);
  line();

  line('### Models');
  line();
  line('Outcome, first-attempt pass rate and review verdicts, cut by resolved model id.');
  line('The model is recorded per TASK (§4.11), not per run, so a corpus whose config');
  line('changed part way through still cross-tabs correctly. This is the only place the');
  line('corpus can answer "was the cheaper model good enough for this work" — the flat');
  line('tally it replaced could say which models ran and the outcome table could say how');
  line('the work went, and neither could say whether the two were related.');
  line();
  const models = new Map();
  for (const run of runs) {
    for (const task of run.tasks) {
      const key = task.model === null ? '(none recorded)' : task.model;
      if (!models.has(key)) {
        models.set(key, {
          rows: 0, outcomes: new Map(), doneWithAttempts: 0, firstAttempt: 0, verdicts: new Map(),
        });
      }
      const m = models.get(key);
      m.rows += 1;
      tally(m.outcomes, task.outcome);
      // The denominator is done tasks that RECORDED an attempt count, never all done
      // tasks: `attempts` is null on rows written before the field existed, and folding
      // those in either way invents a pass rate out of a missing field. The printed
      // fraction carries its own denominator for exactly that reason.
      if (task.outcome === 'done' && task.attempts !== null) {
        m.doneWithAttempts += 1;
        if (task.attempts === 1) m.firstAttempt += 1;
      }
      // Same PR-bearing rule the coverage section uses: a verdict recorded against a
      // row with no PR is anomalous data, and counting it here while the coverage
      // section skips it would have one report disagree with itself about how many
      // verdicts exist.
      const v = task.prUrl !== null && task.verdict ? str(task.verdict.verdict) : null;
      if (v !== null) tally(m.verdicts, v);
    }
  }
  if (!models.size) line('- (no task rows)');
  for (const [model, m] of byKey(models)) {
    line(`- ${model}: ${m.rows} task row(s)`);
    for (const [outcome, count] of byCountThenKey(m.outcomes)) line(`  - ${outcome}: ${count}`);
    if (m.doneWithAttempts === 0) {
      line('  - done on attempt 1: (no done task with a recorded attempt count)');
    } else {
      line(`  - done on attempt 1: ${m.firstAttempt} of ${m.doneWithAttempts} done task(s) with a recorded attempt count`);
    }
    const verdictTotal = [...m.verdicts.values()].reduce((sum, n) => sum + n, 0);
    if (verdictTotal === 0) line('  - review verdicts: (no verdict recorded)');
    else {
      const parts = byCountThenKey(m.verdicts).map(([k, c]) => `${k} ${c}`).join(', ');
      line(`  - review verdicts: ${parts} (of ${verdictTotal} recorded)`);
    }
  }
  line();

  // ---- partial forensics ------------------------------------------------------------
  line('## Partial forensics');
  line();
  line('Which frozen suite failed a partial, and whether its owner ran alongside it.');
  line();
  let partials = 0;
  for (const run of runs) {
    const rowIds = new Set(run.tasks.map((t) => t.issueId));
    for (const task of run.tasks.slice().sort((a, b) => cmp(a.issueId, b.issueId))) {
      if (task.outcome !== 'partial') continue;
      partials += 1;
      const siblings = siblingsOf(task);
      if (siblings === null || !siblings.length) {
        line(`- ${task.issueId} (${run.runId}): (no regression output recorded)`);
        continue;
      }
      for (const sibling of siblings) {
        line(`- ${task.issueId} (${run.runId}): sibling ${sibling} — ${rowIds.has(sibling) ? 'same-run' : 'other-run'}`);
      }
    }
  }
  if (!partials) line('- (no partial tasks in this corpus)');
  line();

  // ---- channels ---------------------------------------------------------------------
  // The keys are specConcerns and memoryNotes. The hand pass read `concerns` and called a
  // 43-use channel unused: non-empty, well-formed and false.
  line('## Channels');
  line();
  let concerns = 0;
  let notes = 0;
  let statusFiles = 0;
  for (const run of runs) {
    for (const task of run.tasks) {
      if (!task.status) continue;
      statusFiles += 1;
      if (Array.isArray(task.status.specConcerns)) concerns += task.status.specConcerns.length;
      if (Array.isArray(task.status.memoryNotes)) notes += task.status.memoryNotes.length;
    }
  }
  line(`- spec concerns: ${concerns} (from ${statusFiles} readable status.json)`);
  if (concerns === 0) line('- (zero spec concerns recorded anywhere in this corpus)');
  line(`- memory notes: ${notes}`);
  line();

  line('### Verdict coverage');
  line();
  line('PR-bearing task rows, with and without a parseable verdict.json.');
  line();
  let withV = 0;
  let withoutV = 0;
  const awaiting = [];
  const perRun = [];
  for (const run of runs) {
    let w = 0;
    let n = 0;
    for (const task of run.tasks.slice().sort((a, b) => cmp(a.issueId, b.issueId))) {
      if (task.prUrl === null) continue; // `null` is a real value and is not PR-bearing
      if (task.verdict) w += 1;                 // unparseable or absent both count as without
      else {
        n += 1;
        awaiting.push(`- ${task.issueId} (${run.runId}) — awaiting a verdict`);
      }
    }
    withV += w;
    withoutV += n;
    // Runs with nothing to review say nothing: on the real corpus that is most of them,
    // and a hundred lines reading "0 with, 0 without" bury the ones with work in them.
    if (w + n > 0) perRun.push(`- ${run.runId}: ${w} with, ${n} without`);
  }
  line(`- corpus: ${withV} with, ${withoutV} without`);
  for (const row of perRun) line(row);
  for (const row of awaiting) line(row);
  line();

  line('### Done but sent back');
  line();
  line('The blind spot the verdict record exists to close: green by the pipeline, and the');
  line('human disagreed.');
  line();
  const blind = [];
  for (const run of runs) {
    for (const task of run.tasks.slice().sort((a, b) => cmp(a.issueId, b.issueId))) {
      if (task.outcome !== 'done' || !task.verdict) continue;
      if (str(task.verdict.verdict) !== 'rejected') continue;
      const why = str(task.verdict.reason);
      blind.push(`- ${task.issueId} (${run.runId}) — done, rejected${why === null ? '' : `: ${why}`}`);
    }
  }
  if (!blind.length) line('- (no task recorded as done and rejected)');
  for (const row of blind) line(row);
  line();

  // ---- distributions ----------------------------------------------------------------
  line('## Distributions');
  line();
  line('Done tasks only. Nearest-rank quantiles: every figure below is a sample that');
  line('really happened, never an interpolation between two that did.');
  line();
  for (const key of ['activeSeconds', 'diffLines']) {
    const d = distribution(runs, key);
    if (!d.samples.length) {
      line(`- ${key}: (no data) excluded: ${d.excluded}`);
      continue;
    }
    const s = d.samples;
    line(
      `- ${key}: n=${s.length} min=${s[0]} p25=${nearestRank(s, 0.25)} med=${nearestRank(s, 0.5)}`
      + ` p75=${nearestRank(s, 0.75)} p95=${nearestRank(s, 0.95)} max=${s[s.length - 1]}`
      + ` excluded: ${d.excluded}`
    );
  }
  line();
  line(`Done task rows read: ${doneTasks}.`);

  return `${out.join('\n')}\n`;
}

// ---- entry point --------------------------------------------------------------------
// process.exitCode rather than process.exit(): a pending write to a pipe is truncated by
// an explicit exit, and the report is the whole product.
function main(argv) {
  if (argv.length) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  const root = resolveRoot();
  process.stderr.write(`audit-runs: reading ${root}\n`);
  process.stdout.write(render(readCorpus(root)));
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { readCorpus, reasonFromLog, nearestRank, compareRuns, render, resolveRoot };
