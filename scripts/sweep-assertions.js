// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// How many assertions did a suite pass? The counting decision behind the sweep summary's
// `PASSED` column. DESIGN.md §4.12 (the sweep summary is the artifact a human reads);
// change-log row `repo-0ay`.
//
// THIS REPO HAS TWO ASSERTION VOCABULARIES, and `scripts/test-all.sh` used to read only one:
//
//   PASS  the network came up          <- the shell wrappers (scripts/test-*.sh)
//   ok - A1 the bound fired            <- the Node checkers (tests/unit/, tests/acceptance/)
//
// A suite in the second vocabulary therefore reported the count of its WRAPPER's summary
// lines rather than its own assertions: measured on the 2026-07-31 sweep, `test-sweep-hygiene`
// reported 3, `test-network-names` 2 against 34 real checks. That number is present,
// well-formed and measuring a different thing — the shape of every silent-degradation defect
// this repo has recorded. The column's job is to make coverage quietly disappearing VISIBLE,
// and for a third of the suites it could not do that.
//
// THREE DECISIONS, all of them deliberate:
//
//   1. PASSES, not attempts. `^PASS` counted passes, so counting attempts would silently move
//      every existing suite's number — the same class of change this exists to prevent. A log
//      with 7 `ok - ` and 2 `FAIL - ` lines reports 7. The summary's header says so.
//   2. ONE HONEST TOTAL, NEVER THE SUM. A shell wrapper around a Node checker emits both
//      vocabularies into one log, and the wrapper's `PASS` lines are largely a SUMMARY of the
//      `ok - ` lines beneath them ("unit suite ran 34 checks"). Adding them double-counts. We
//      report the larger of the two counts: the finer-grained view of the same run, and — this
//      is the half that matters — a number that can never come out BELOW what the old
//      single-vocabulary counter reported, so no suite's count drops as a side effect of this
//      change. Ties go to the Node vocabulary, which is the inner one.
//   3. "COULD NOT TELL" IS NOT ZERO. A log carrying no countable assertion line at all returns
//      `found: false`, and the summary renders it `?` rather than `0`. A suite whose harness
//      broke before it asserted anything and a suite whose every assertion failed are different
//      facts, and this repo has been bitten by a well-formed number that meant neither.
//
// The FAIL side needs none of this and is deliberately untouched: both vocabularies begin a
// failure line with `FAIL` followed by whitespace, so `grep -c '^FAIL[[:space:]]'` — which is
// what feeds the sweep's "printed FAIL but exited 0" net — already sees both. Nothing here
// feeds a verdict. `countAssertions` decides a COUNT; the RESULT column and the sweep's exit
// code come from the suite's exit code and that FAIL grep, exactly as before.
//
// Usage:
//   node scripts/sweep-assertions.js count <logfile>   # prints the summary cell, e.g. `34` or `?`
//
// Exits 0 when it could read the log (whether or not it found assertions), 1 when it could
// not — which is the sweep's cue to fall back to its own grep rather than to report nothing.
'use strict';

const fs = require('fs');

// Anchored at the start of the line, like the `^PASS[[:space:]]` this replaces: a suite's
// assertions are printed at column 0 here, and a looser anchor would count a quoted example
// inside somebody's diagnostic output.
const NODE_PASS = /^ok - /;
const NODE_FAIL = /^FAIL - /;
const SHELL_PASS = /^PASS[ \t]/;
const SHELL_FAIL = /^FAIL[ \t]/;

// What the summary prints when nothing countable was in the log. Not `0`.
const NOT_FOUND = '?';

// Vocabularies in tie-break order: the Node one first, because where both appear in one log
// it is the inner suite and the shell lines are its wrapper's summary.
function countAssertions(logText) {
  const text = typeof logText === 'string' ? logText : '';
  const tally = {
    node: { vocabulary: 'node', passed: 0, failed: 0 },
    shell: { vocabulary: 'shell', passed: 0, failed: 0 },
  };

  for (const raw of text.split('\n')) {
    // The working copy is CRLF and every container is LF (CLAUDE.md): strip the carriage
    // return here, at the point of parsing, rather than anywhere upstream.
    const line = raw.replace(/\r+$/, '');
    // Node lines are classified first and `continue`: `FAIL - x` also satisfies the shell
    // failure pattern, and counting it twice would make a Node log look like a mixed one.
    if (NODE_PASS.test(line)) { tally.node.passed++; continue; }
    if (NODE_FAIL.test(line)) { tally.node.failed++; continue; }
    if (SHELL_PASS.test(line)) { tally.shell.passed++; continue; }
    if (SHELL_FAIL.test(line)) { tally.shell.failed++; }
  }

  const counts = { node: tally.node.passed, shell: tally.shell.passed };
  // Only a vocabulary that actually appeared can win — a log of nothing but `FAIL  ` lines is
  // a genuine zero in the SHELL vocabulary, not an absent-and-therefore-zero Node one.
  const seen = [tally.node, tally.shell].filter((v) => v.passed + v.failed > 0);
  if (seen.length === 0) {
    return { found: false, count: 0, failed: 0, vocabulary: null, counts };
  }
  // Stable sort: on a tie the Node entry, listed first above, stays first.
  seen.sort((a, b) => b.passed - a.passed);
  const winner = seen[0];
  return {
    found: true,
    count: winner.passed,
    failed: winner.failed,
    vocabulary: winner.vocabulary,
    counts,
  };
}

// The one string the sweep puts in its table. Kept here so "could not tell" renders the same
// way wherever it is asked for.
function cell(result) {
  return result && result.found ? String(result.count) : NOT_FOUND;
}

function main(argv) {
  const [cmd, file] = argv;
  if (cmd !== 'count' || !file) {
    process.stderr.write('usage: node scripts/sweep-assertions.js count <logfile>\n');
    return 2;
  }
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    process.stderr.write(`sweep-assertions: cannot read ${file}: ${e.message}\n`);
    return 1;
  }
  process.stdout.write(`${cell(countAssertions(text))}\n`);
  return 0;
}

module.exports = { countAssertions, cell, NOT_FOUND };

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
