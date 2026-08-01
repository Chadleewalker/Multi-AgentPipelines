// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// Unit suite for the sweep's assertion counter — `scripts/sweep-assertions.js` and the
// `PASSED` column it feeds in `scripts/test-all.sh`. DESIGN.md §4.12; change-log row
// `repo-0ay`.
//
// Re-runnable: the sweep picks it up through scripts/test-sweep-assertions.sh. Its coverage is
// the half of tests/acceptance/repo-0ay/ that has to outlive that task — a frozen acceptance
// directory is an artifact of a finished run and is never executed again (memory
// `repo-dhp-note-2`), and what it guards against is precisely a number that goes on being
// printed after it stops meaning anything.
//
// Plain Node, no test framework, no Docker, no network: run it as
// `node tests/unit/sweep-assertions.test.js` from the repo root. One line per check —
// `ok - <label>` / `FAIL - <label>` — and a non-zero exit if any check failed, matching
// tests/acceptance/README.md. (Those `ok - ` lines are also this suite's own dogfood: before
// `repo-0ay` the sweep reported this file's coverage as its wrapper's two summary lines.)
//
// THREE THINGS HERE THAT A FIXTURE HAS TO BE BUILT DELIBERATELY TO CATCH:
//
//   * The mixed log. A wrapper's `PASS` summary and the inner checker's `ok - ` lines land in
//     ONE log, so the fixture has to make the sum, the shell count and the node count three
//     DIFFERENT numbers — otherwise a counter that adds them looks identical to one that does
//     not. Here: 4 node, 2 shell, and never 6.
//   * The genuine zero. `found:false` and `count:0` are only distinguishable if a fixture
//     asserts both a log with no assertion lines at all AND a log whose every assertion
//     failed. A counter that returns 0 for both passes any test that only plants the first.
//   * The rendering. A pure function returning the right object proves nothing about the
//     column, so the real `scripts/test-all.sh` is driven over planted stub suites in a temp
//     root — copied, never invoked in place, because it takes a lock and would deadlock
//     against the sweep that is running this.
//
// The `docker` stand-in is `process.execPath` with a recorder preloaded through NODE_OPTIONS,
// never a `#!/bin/sh` file: `sweep-reclaim.js` reaches the seam through `spawnSync` WITHOUT a
// shell and the Windows host fails such a file with EFTYPE (memory `repo-dhp-note-1`).
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const COUNTER = path.join(ROOT, 'scripts', 'sweep-assertions.js');
const RECLAIM = path.join(ROOT, 'scripts', 'sweep-reclaim.js');
const TEST_ALL = path.join(ROOT, 'scripts', 'test-all.sh');
const { countAssertions, cell, NOT_FOUND } = require(COUNTER);

let failed = 0;
function check(name, cond) {
  console.log(`${cond ? 'ok' : 'FAIL'} - ${name}`);
  if (!cond) failed = 1;
}
const fwd = (p) => p.split(path.sep).join('/');
const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'unit-asserts-'));

// ---- the pure decision -----------------------------------------------------------------

const SHELL_LOG = [
  'ok     Docker is running',           // a status line, not an assertion: no ` - ` after ok
  'PASS  the network came up',
  'PASS  the proxy answered',
  'FAIL  the allowlist let something through',
  'PASS  teardown removed what it made',
  '== ALL CHECKS PASSED ==',
].join('\n');

const NODE_LOG = [
  'ok - A1 the bound fired',
  'ok - A2 the failure named the timeout',
  'FAIL - A3 the default was wrong',
  'ok - A4 every call site is built from the builder',
].join('\n');

// The shape the whole task exists for: a shell wrapper around a Node checker. 4 and 2, so the
// sum (6) is a number no correct answer can produce.
const MIXED_LOG = [
  '== repo-jur checks: per-project network + proxy names ==',
  'ok - L1 the checker sees the tree',
  'ok - L2 removing one entry surfaces exactly that literal',
  'ok - L3 the exemptions are component-scoped',
  'ok - L4 a malformed listing is survivable',
  'PASS  unit suite exits 0',
  'PASS  unit suite ran 4 checks',
].join('\n');

const shell = countAssertions(SHELL_LOG);
check(`a PASS/FAIL log counts its passes (${shell.count})`, shell.count === 3);
check('…and names the vocabulary it counted', shell.vocabulary === 'shell');
check('a bare "ok" status line is not an assertion — only "ok - " is',
  shell.counts.node === 0);

const node = countAssertions(NODE_LOG);
check(`an "ok - "/"FAIL - " log counts its passes (${node.count}) — the vocabulary the sweep `
  + 'was blind to before `repo-0ay`', node.count === 3);
check('…and names the vocabulary it counted', node.vocabulary === 'node');
check('a "FAIL - " line is classified as the Node vocabulary, not double-counted as shell',
  node.counts.shell === 0);

const mixed = countAssertions(MIXED_LOG);
check(`a log carrying BOTH reports one honest total, never the sum (${mixed.count}, not 6)`,
  mixed.count === 4);
check('…which is the inner checker\'s count, not the wrapper\'s summary lines',
  mixed.vocabulary === 'node' && mixed.counts.shell === 2);

// The direction that matters for the guard: this change may never make a suite's number DROP,
// so where the shell count is the larger it wins outright.
const shellHeavy = countAssertions(
  Array.from({ length: 40 }, (_, i) => `PASS  wrapper check ${i}`).concat([
    'ok - the one inner check',
  ]).join('\n'));
check(`a mostly-shell log is not collapsed onto a small inner checker (${shellHeavy.count})`,
  shellHeavy.count === 40 && shellHeavy.vocabulary === 'shell');

// ---- "could not tell" is not zero --------------------------------------------------------

const none = countAssertions('Godot Engine v4.7.1\nsome chatter\nand nothing countable\n');
const zero = countAssertions('FAIL  the only assertion failed\n');
check('a log with no countable assertion line reports found:false',
  none.found === false && none.count === 0);
check('a log whose every assertion FAILED is a genuine zero — found:true, count:0',
  zero.found === true && zero.count === 0);
check('…and the two are distinguishable, which is the whole point',
  none.found !== zero.found);
check('a genuine zero still names its vocabulary', zero.vocabulary === 'shell');
check('an all-failed Node log is a genuine zero too',
  countAssertions('FAIL - the only assertion failed\n').found === true);
check(`the summary cell for "could not tell" is not a number (${NOT_FOUND})`,
  cell(none) === NOT_FOUND && cell(zero) === '0' && NOT_FOUND !== '0');

// ---- passes, not attempts: the semantics the header advertises ---------------------------

const seven = countAssertions(
  Array.from({ length: 7 }, (_, i) => `ok - assertion ${i}`)
    .concat(Array.from({ length: 2 }, (_, i) => `FAIL - assertion f${i}`)).join('\n'));
check(`7 passing and 2 failing assertions report 7, not 9 (${seven.count}) — the column counts `
  + 'PASSES, which is what `^PASS` counted before, so no existing suite\'s number moved',
  seven.count === 7);
check('…and the failures are still reported alongside, so "attempted" stays derivable',
  seven.failed === 2);

// ---- junk in, no throw out ---------------------------------------------------------------
// A counter that throws parks a sweep after the suites have already run, which is strictly
// worse than a wrong number: the summary is the artifact, and there would be none.

let threw = false;
try {
  for (const junk of [undefined, null, 42, '', '\n\n\n', {}, []]) countAssertions(junk);
} catch (e) { threw = true; }
check('malformed input is survivable — a counter that throws loses the whole summary', !threw);
check('CRLF is handled at the point of parsing, per CLAUDE.md',
  countAssertions('ok - one\r\nok - two\r\nPASS  summary\r\n').count === 2);

// ---- the CLI, which is what the shell actually calls --------------------------------------

function cli(args) {
  return spawnSync(process.execPath, [COUNTER].concat(args),
    { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
}

const logFile = path.join(tmp, 'planted.log');
fs.writeFileSync(logFile, MIXED_LOG);
const counted = cli(['count', logFile]);
check('the CLI prints the cell and exits 0',
  counted.status === 0 && counted.stdout.trim() === '4');

fs.writeFileSync(path.join(tmp, 'silent.log'), 'nothing countable here\n');
const silent = cli(['count', path.join(tmp, 'silent.log')]);
check('the CLI prints the "could not tell" cell for a log with no assertions',
  silent.status === 0 && silent.stdout.trim() === NOT_FOUND);

const missing = cli(['count', path.join(tmp, 'no-such.log')]);
check('an unreadable log exits non-zero — the sweep\'s cue to fall back rather than print '
  + 'nothing', missing.status === 1);
check('…and says why, on stderr', /cannot read/.test(missing.stderr));
check('no subcommand is a usage error, not a count', cli([]).status === 2);

// ---- the rendering: the real test-all.sh over planted stub suites --------------------------

// Answers every listing with nothing: this suite is about the column, and the reclaimer's own
// behaviour is tests/unit/sweep-hygiene.test.js's subject.
const FAKE_DOCKER = `'use strict';
const path = require('path');
const argv = process.argv.slice(1);
if (argv.length && !/\\.js$/i.test(argv[0])) {
  const sub = path.basename(argv[0]);
  if (sub === 'ps' || sub === 'network') process.exit(0);
  process.exit(0);
}
`;

let rootSeq = 0;
function makeRoot(opts) {
  const root = path.join(tmp, `root-${++rootSeq}`);
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'runs'), { recursive: true });
  fs.copyFileSync(TEST_ALL, path.join(root, 'scripts', 'test-all.sh'));
  fs.copyFileSync(RECLAIM, path.join(root, 'scripts', 'sweep-reclaim.js'));
  // Omitted on purpose in the fallback case: a harness root that carries test-all.sh without
  // the counter must still report a number rather than an empty column.
  if (!opts.withoutCounter) {
    fs.copyFileSync(COUNTER, path.join(root, 'scripts', 'sweep-assertions.js'));
  }
  for (const s of opts.suites) {
    fs.writeFileSync(path.join(root, 'scripts', `test-${s.name}.sh`),
      `#!/bin/sh\n${s.lines.map((l) => `echo ${JSON.stringify(l)}`).join('\n')}\nexit ${s.exit}\n`);
  }
  const stub = path.join(root, 'scripts', 'fake-docker.js');
  fs.writeFileSync(stub, FAKE_DOCKER);
  const r = spawnSync('bash', [path.join(root, 'scripts', 'test-all.sh'), '--skip', 'e2e'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120000,
    env: Object.assign({}, process.env, {
      SWEEP_DOCKER: fwd(process.execPath),
      NODE_OPTIONS: `--require "${fwd(stub)}"`,
    }),
  });
  const base = path.join(root, 'runs', 'sweeps');
  const dirs = fs.existsSync(base) ? fs.readdirSync(base).sort() : [];
  const summary = dirs.length ? read(path.join(base, dirs[dirs.length - 1], 'summary.txt')) : '';
  return { root, r, summary };
}

// One cell per suite, read out of the rendered table rather than guessed at.
function cellOf(summary, suite) {
  const row = summary.split('\n').find((l) => new RegExp(`\\s${suite}\\s`).test(l));
  return row ? row.trim().split(/\s+/)[2] : null;
}

const SUITES = [
  { name: 'mixed', exit: 0, lines: ['ok - inner one', 'ok - inner two', 'PASS  wrapper summary'] },
  { name: 'shellish', exit: 0, lines: ['PASS  one', 'PASS  two', 'PASS  three'] },
  { name: 'silent', exit: 0, lines: ['chatter, and nothing countable at all'] },
  { name: 'zero', exit: 1, lines: ['FAIL  the only assertion failed'] },
];

{
  const { r, summary } = makeRoot({ suites: SUITES });
  check('harness: the sweep ran and wrote a summary', summary.length > 0);
  check('the column is headed PASSED, so the semantics are stated where the number is read',
    /RESULT\s+SUITE\s+PASSED\s+TIME\s+NOTE/.test(summary));
  check('…and the legend says which vocabularies it counts',
    /ok - /.test(summary) && /never their sum/.test(summary));
  check(`a wrapped Node suite reports its OWN assertions, not its wrapper's summary `
    + `(${cellOf(summary, 'test-mixed')})`, cellOf(summary, 'test-mixed') === '2');
  check(`a shell suite is unchanged by all this (${cellOf(summary, 'test-shellish')})`,
    cellOf(summary, 'test-shellish') === '3');
  check(`a log with nothing countable renders visibly differently from a zero `
    + `(${cellOf(summary, 'test-silent')} vs ${cellOf(summary, 'test-zero')})`,
    cellOf(summary, 'test-silent') === NOT_FOUND && cellOf(summary, 'test-zero') === '0');

  // [guard] This task changes a count, never a verdict.
  check('a suite exiting 1 still reads FAIL', /FAIL\s+test-zero/.test(summary));
  check('a suite exiting 0 still reads PASS', /PASS\s+test-mixed/.test(summary));
  check('and the sweep still exits 1 when a suite failed', r.status === 1);
}

{
  const { r, summary } = makeRoot({ suites: [SUITES[0], SUITES[1]] });
  check('an all-green sweep still exits 0', r.status === 0 && !/^FAIL/m.test(summary));
}

{
  // The fallback: no counter on disk. The old single-vocabulary grep answers, so the mixed
  // suite reads 1 (its wrapper line) rather than an empty cell — a stale number beats a hole,
  // and it still cannot touch the verdict.
  const { r, summary } = makeRoot({ suites: SUITES, withoutCounter: true });
  check('with the counter absent the sweep still runs and still fails on a failing suite',
    r.status === 1 && summary.length > 0);
  check(`…and every cell is still filled (${cellOf(summary, 'test-mixed')}, `
    + `${cellOf(summary, 'test-shellish')})`,
    cellOf(summary, 'test-mixed') === '1' && cellOf(summary, 'test-shellish') === '3');
}

// ---- the source rule ----------------------------------------------------------------------
// The seam that lets any of this run where the verifier runs it (change-log row `repo-zje`).

const sweepSrc = read(TEST_ALL).split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
const bare = sweepSrc.split('\n')
  .filter((l) => /(^|[^_])\bdocker\s/.test(l) && !/SWEEP_DOCKER/.test(l));
check(`every docker call in test-all.sh goes through $SWEEP_DOCKER, prechecks included `
  + `(offending: ${bare.map((l) => l.trim().slice(0, 40)).join(' | ') || 'none'})`,
  bare.length === 0);
check('test-all.sh delegates the count rather than keeping a second copy of the decision',
  /sweep-assertions/.test(sweepSrc));

// --------------------------------------------------------------------------------------------

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
console.log(failed ? '\nsweep-assertions: FAILED' : '\nsweep-assertions: all checks passed');
process.exit(failed);
