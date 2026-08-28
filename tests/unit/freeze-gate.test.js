#!/usr/bin/env node
// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// Checks for `scripts/freeze-gate.js` — the fork-point red gate (DESIGN.md §3.2, "Below the
// panel", move 1; change-log row `freeze-gate-red`).
//
// Docker-free and network-free. The target project's verify command is stubbed through
// FREEZE_GATE_CMD, so the gate's own logic is exercised without any engine, runner or image.
// The stub is a `.js` file invoked through `process.execPath`, never a `#!/bin/sh` script:
// `spawnSync` fails such a script with EFTYPE on the Windows host, so a shell stub would pass
// in a container and fail in the host sweep (CLAUDE.md, the Docker-free suite rule).
//
// The decision table is the thing under test, and it is exercised from every side. A gate
// that only ever sees genuine-red is a gate whose two interesting verdicts — green, and
// can't-tell — have never executed, and those are the two that carry the design.
//
// Run from Git Bash:  node tests/unit/freeze-gate.test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  verdictFor, guardCount, guardFiles, withEmptyControlDir, withGuardDir, resolveControl,
  CONTROL_DIR, main,
  brittleFindings, lintSuite, runVerify, compareSuites, digestSuite, MAX_BUFFER,
} = require('../../scripts/freeze-gate.js');
const { MAX_BUFFER: VERIFIER_MAX_BUFFER } = require('../../pipeline/verify-classify.js');

let failed = 0;
const pass = (n) => console.log(`PASS  ${n}`);
const fail = (n, why) => { console.log(`FAIL  ${n}${why ? ` — ${why}` : ''}`); failed = 1; };
const check = (n, cond, why) => { (cond ? pass : (x) => fail(x, why))(n); return cond; };

const ok = (status) => ({ status, signal: null, stdout: '', stderr: '', error: null });

// --- the decision table -------------------------------------------------------------------

// The verdict that lets a freeze proceed. Note it needs FOUR observations, not two: red alone
// is not enough (that is what the control run buys), and red at the fork point is not enough
// either (that is what the probe buys — change-log row `repo-inj`).
let v = verdictFor(ok(1), ok(0), 'conventional', ok(0), ok(0));
check('real red + control green + probe green = red (gate passes)',
  v.verdict === 'red' && v.exit === 0, `${v.verdict}/${v.exit}`);

// The finding the gate exists to produce. Several criteria in the first real panel run were
// satisfied by an empty diff; this is the state that catches them.
v = verdictFor(ok(0), ok(0));
check('real green = green (gate fails, exit 1)', v.verdict === 'green' && v.exit === 1,
  `${v.verdict}/${v.exit}`);
check('the green verdict names the guard escape', /\[guard\]/.test(v.detail));
check('the green verdict says an empty diff would pass', /empty diff/.test(v.detail));

// Green is green regardless of the control: if the tests pass with no implementation, what
// the harness does on an empty directory cannot rescue them.
v = verdictFor(ok(0), ok(3));
check('real green stays green even when the control also fails', v.verdict === 'green');

// The carve-out that keeps the gate honest — a broken harness must never read as a pass.
v = verdictFor(ok(1), ok(1));
check('real red + control red = indeterminate, not red', v.verdict === 'indeterminate' && v.exit === 2,
  `${v.verdict}/${v.exit}`);
// The no-tests-found explanation belongs to the empty-probe fallback specifically — with a
// real control fixture that diagnosis would be wrong, and the messages are checked apart
// below. Naming the kind here keeps this check from passing on the wrong branch.
check('the indeterminate verdict explains no-tests-found',
  /no tests/i.test(verdictFor(ok(1), ok(1), 'empty-probe').detail));
check('indeterminate never exits 0', verdictFor(ok(5), ok(5)).exit !== 0);

// A command that could not start, or was killed, is not evidence of anything.
check('a spawn error is indeterminate',
  verdictFor({ ...ok(null), error: 'ENOENT' }, ok(0)).verdict === 'indeterminate');
check('a timeout kill is indeterminate',
  verdictFor({ ...ok(null), signal: 'SIGTERM' }, ok(0)).verdict === 'indeterminate');
check('a null exit status is never treated as 0',
  verdictFor(ok(null), ok(0)).verdict === 'indeterminate');
// The control failing to START is different from the control failing a test, but both leave
// the real run's exit code uninterpretable.
check('a control that could not run is indeterminate',
  verdictFor(ok(1), { ...ok(null), error: 'ENOENT' }).verdict === 'indeterminate');

// A suite that could not RUN is not a suite that failed. Conventionally a runner exits 1 for
// failing tests and 2+ for could-not-run: a parse error, a missing import, nothing collected.
// The control cannot catch this -- it proves the harness works on OTHER tests, so a suite whose
// own script fails to load leaves the control perfectly green. Found in anger: a frozen GDScript
// suite with a parse error exited 2 against a green control and this gate called it RED.
v = verdictFor(ok(2), ok(0));
check('exit 2 with a green control is indeterminate, not red', v.verdict === 'indeterminate' && v.exit === 2);
check('the message says could-not-run rather than failed', /could not run|did not execute/i.test(v.headline + v.detail));
check('exit 5 is indeterminate too', verdictFor(ok(5), ok(0)).verdict === 'indeterminate');
check('exit 1 with a green control and a green probe is still red',
  verdictFor(ok(1), ok(0), 'conventional', ok(0), ok(0)).verdict === 'red');

// --- the green side: --green, and the two verdicts it adds (change-log row `repo-inj`) --------
//
// Red at the fork point and a suite whose own fixture is broken are THE SAME OBSERVATION, so
// everything above is satisfied by a suite no implementation could ever turn green. Two tasks
// have burned three attempts each on exactly that. These rows are the other half of the proof,
// and the argument ORDER is load-bearing: `verdictFor(real, control, controlKind, probe,
// probeControl)`. The two rows that separate a correct table from one that reads the last two
// arguments the other way round are `(1,0,probe red,control green) -> unreachable` and
// `(1,0,probe green,control red) -> indeterminate`; every other row answers the same either way.
const row = (real, control, probe, probeControl) => verdictFor(ok(real), ok(control), 'conventional',
  probe === null ? null : ok(probe), probeControl === null ? null : ok(probeControl));

v = row(1, 0, 1, 0);
check('red at the fork point and red in the probe = unreachable, exit 3',
  v.verdict === 'unreachable' && v.exit === 3, `${v.verdict}/${v.exit}`);
check('the unreachable verdict says it is NOT a pass', /not a pass/i.test(v.detail));
check('the unreachable verdict names the probe as the tree the criteria should already satisfy',
  /probe/i.test(v.detail));

v = row(1, 0, null, null);
check('red with NO probe = half-proven, exit 4', v.verdict === 'half-proven' && v.exit === 4,
  `${v.verdict}/${v.exit}`);
check('the half-proven verdict says a freeze without a probe PROCEEDS', /proceeds/i.test(v.detail));
check('the half-proven verdict names the flag that completes the proof', /--green/.test(v.detail));
check('the half-proven verdict sends the state to the approval pass',
  /approval pass/i.test(v.detail));

// A BROKEN PROBE IS NEVER `unreachable`. This is the pair a naive implementation fails: it
// answers 3 for both, and only running both tells them apart.
check('a probe whose CONTROL is not green is indeterminate/2, not unreachable',
  row(1, 0, 1, 1).verdict === 'indeterminate' && row(1, 0, 1, 1).exit === 2,
  JSON.stringify(row(1, 0, 1, 1)));
check('...and so is a GREEN probe suite behind a red probe control',
  row(1, 0, 0, 1).exit === 2, JSON.stringify(row(1, 0, 0, 1)));
check('that detail names the PROBE as the broken side, not the spec',
  /probe/i.test(row(1, 0, 1, 1).detail) && /probe/i.test(row(1, 0, 1, 1).headline));
check('a probe control that could not START is indeterminate, never unreachable',
  verdictFor(ok(1), ok(0), 'conventional', ok(1), { ...ok(null), error: 'ENOENT' }).exit === 2);
check('a probe suite killed by a signal is indeterminate, never unreachable',
  verdictFor(ok(1), ok(0), 'conventional', { ...ok(null), signal: 'SIGTERM' }, ok(0)).exit === 2);
check('a probe suite that exited 2 is "could not run", not unreachable',
  row(1, 0, 2, 0).verdict === 'indeterminate' && row(1, 0, 2, 0).exit === 2,
  JSON.stringify(row(1, 0, 2, 0)));
check('exit 3 is reachable ONLY behind a green probe control',
  [[0, 1], [1, 1], [2, 1], [null, 1]].every(([p, pc]) =>
    verdictFor(ok(1), ok(0), 'conventional', ok(p), ok(pc)).exit !== 3));

// The two verdicts above the probe rows are decided before the probe is consulted at all: a
// suite that passes at the fork point cannot be rescued by a probe, and a broken fork-point
// harness cannot be repaired by one.
check('a green real run stays green/1 whatever the probe says',
  row(0, 0, 1, 1).verdict === 'green' && row(0, 0, 1, 1).exit === 1);
check('a not-green control stays indeterminate/2 whatever the probe says',
  row(1, 1, 0, 0).verdict === 'indeterminate' && row(1, 1, 0, 0).exit === 2);
check('the fork point exiting 2 stays indeterminate even with a green probe',
  row(2, 0, 0, 0).exit === 2);
// `scripts/test-freeze-gate.sh` greps the report for "RED:". Renaming the token to something
// truer like `discriminating` silently stops that grep matching, and the suite goes on passing.
check('the existing `red` token is kept for exit 0 rather than renamed',
  row(1, 0, 0, 0).verdict === 'red');

// --- the stale guard: the sixth verdict (change-log rows `stale-guard-design`, `repo-i4b`) ----
//
// The guard row is a SIXTH argument, and the load-bearing property is what it does NOT change:
// `guard` absent and `guard` green must answer identically to each other AND to the
// five-argument call, or the frozen `repo-inj` suite — which cannot be edited and will never
// run again — silently stops meaning what it meant. That equivalence is checked over every
// existing row rather than spot-checked, because it is a property of the whole table.
const guardRow = (real, control, probe, probeControl, guard) => verdictFor(
  ok(real), ok(control), 'conventional',
  probe === null ? null : ok(probe), probeControl === null ? null : ok(probeControl),
  guard === null ? null : (typeof guard === 'object' ? guard : ok(guard)));

v = guardRow(1, 0, null, null, 1);
check('a [guard] file red at the fork point is stale-guard, exit 5',
  v.verdict === 'stale-guard' && v.exit === 5, `${v.verdict}/${v.exit}`);
check('the stale-guard verdict says it is never a pass', /never a pass/i.test(v.detail));
check('the stale-guard verdict explains that a guard is SUPPOSED to be green',
  /supposed to be green/i.test(v.detail));
check('the stale-guard verdict says the pin has already moved', /already moved/i.test(v.detail));
// It BEATS the three verdicts a red fork point can otherwise produce. Each of these is a
// separate row rather than one loop, because getting the ORDER wrong inside `verdictFor`
// produces a different wrong answer in each: 0, 3 and 4 respectively.
check('stale-guard beats `red` — a green probe cannot rescue a moved pin',
  guardRow(1, 0, 0, 0, 1).exit === 5);
check('stale-guard beats `unreachable` — the guard is read before the probe',
  guardRow(1, 0, 1, 0, 1).exit === 5);
check('stale-guard beats `half-proven` — no probe is needed to reach it',
  guardRow(1, 0, null, null, 1).exit === 5);
// And it is beaten by everything that makes the fork-point observation unreadable in the first
// place. In all three the guard's own red is one more uninterpretable number, not a finding.
check('a green fork point stays green/1 whatever the guard did',
  guardRow(0, 0, null, null, 1).verdict === 'green' && guardRow(0, 0, null, null, 1).exit === 1);
check('a not-green control stays indeterminate/2 whatever the guard did',
  guardRow(1, 1, null, null, 1).exit === 2);
check('a fork point that exited 2 stays indeterminate/2 whatever the guard did',
  guardRow(2, 0, null, null, 1).exit === 2);

// A guard subset that could not RUN is `indeterminate` naming the guard side — never 5, and
// never 0. Same reasoning that keeps a broken probe off exit 3: a run that never happened is
// not evidence, and blaming the spec for it would be the exact false confidence the control
// run exists to prevent. The 'killed' shapes are only reachable here: a CLI fixture for them
// would have to make a real spawn time out, which is a slow test measuring the clock.
for (const [label, broken] of [
  ['exit 2', ok(2)],
  ['exit 127 — the command did not exist', ok(127)],
  ['a null exit status', ok(null)],
  ['killed by a signal', { ...ok(null), signal: 'SIGTERM' }],
  ['a spawn that errored', { ...ok(null), error: 'ENOENT' }],
]) {
  const bad = guardRow(1, 0, null, null, broken);
  check(`a guard subset that could not run (${label}) is indeterminate/2 naming the guard side`,
    bad.verdict === 'indeterminate' && bad.exit === 2 && /guard/i.test(bad.headline),
    JSON.stringify(bad));
}

// The equivalence, over every row of the pre-existing table. Not a spot check: an
// implementation that reads the guard argument one branch too early answers differently on
// exactly one of these, and which one depends on the mistake.
const PRIOR_ROWS = [[1, 0, 0, 0], [0, 0, null, null], [1, 1, null, null], [2, 0, null, null],
  [1, 0, 1, 0], [1, 0, null, null], [1, 0, 1, 1], [1, 0, 0, 1], [1, 0, 2, 0]];
const sameAnswer = (a, b) => a && b && a.verdict === b.verdict && a.exit === b.exit;
check('every pre-existing row answers identically with no guard argument at all, with null, and with a green guard',
  PRIOR_ROWS.every(([r2, c2, p2, pc2]) => {
    const five = row(r2, c2, p2, pc2);
    return sameAnswer(five, guardRow(r2, c2, p2, pc2, null))
      && sameAnswer(five, guardRow(r2, c2, p2, pc2, 0));
  }));
// Exit 5 is the gate's own number and has nothing to do with the runner's. A SUITE that exits
// 5 is "could not run", exactly as 2 and 127 are — the two 5s must never be confused, because
// one of them is a pass-adjacent verdict and the other is a broken harness.
check('a SUITE exiting 5 is still indeterminate — the gate\'s 5 is not the runner\'s',
  verdictFor(ok(5), ok(0)).exit === 2);
check('exit 5 is reachable from exactly one row, and only with a red guard',
  (() => {
    let fives = 0; let staleGuards = 0;
    for (const r2 of [0, 1, 2, 5]) {
      for (const c2 of [0, 1]) {
        for (const [p2, pc2] of [[null, null], [0, 0], [1, 0], [1, 1], [2, 0]]) {
          for (const g2 of [null, 0, 1, 2, 127]) {
            const got = guardRow(r2, c2, p2, pc2, g2);
            if (got.exit === 5) { fives++; if (!(r2 === 1 && c2 === 0 && g2 === 1)) return false; }
            if (got.verdict === 'stale-guard') staleGuards++;
          }
        }
      }
    }
    return fives > 0 && fives === staleGuards;
  })());

// --- guards ---------------------------------------------------------------------------------

const SPEC = [
  '## Done means',
  '1. `Astronaut.burn()` clamps to the remaining fuel.',
  '2. [guard] Determinism still holds: the sweep is reproducible.',
  '3. [GUARD] Existing cargo values are unchanged.',
  '4. The new key is read from config.',
].join('\n');
const g = guardCount(SPEC);
check('guards are counted', g.length === 2, `got ${g.length}`);
check('the guard marker is case-insensitive', g.some((x) => x.line === 3));
check('guards report their line number', g[0] && g[0].line === 3);
check('an unmarked criterion is not a guard', !g.some((x) => /clamps/.test(x.text)));
check('a spec with no guards reports zero, not an error', guardCount('1. does a thing').length === 0);
check('guard counting survives CRLF', guardCount(SPEC.split('\n').join('\r\n')).length === 2);

// --- guardFiles: which TEST FILES declare themselves guards ------------------------------------
//
// `guardCount` reads the SPEC and counts labels a human typed; `guardFiles` reads the SUITE and
// decides which files are run alone. The pairs below are what separate a useful scanner from
// one that answers "every file that mentions the word": for each rule, one file that must be
// found and one that differs in exactly the feature the rule turns on. The near-miss that
// matters most is `d.js` — a `[guard]` token inside a STRING, which is what a test ABOUT guards
// looks like, and this very file is full of them.
{
  const suite = fs.mkdtempSync(path.join(os.tmpdir(), 'freeze-guardfiles-'));
  const TOKEN = `[${'guard'}]`;   // assembled: a literal here would make this file a guard
  fs.mkdirSync(path.join(suite, 'nested'), { recursive: true });
  const write = (n, body) => fs.writeFileSync(path.join(suite, n), body);
  write('a.js', `'use strict';\n// ${TOKEN} the burn table is unchanged\nprocess.exit(0);\n`);
  write('b.sh', `#!/bin/sh\n#\n#\n#\n#\n#\n#\n#\n#\n# ${TOKEN} on the tenth line exactly\nexit 0\n`);
  write('c.js', `${'//\n'.repeat(10)}// ${TOKEN} on the eleventh line\n`);
  write('d.js', `'use strict';\nconst MARKER = '${TOKEN}';\nprocess.exit(0);\n`);
  write('e.gd', `# ${TOKEN} GDScript comments are #\nfunc _ready(): pass\n`);
  write('f.py', `# nothing here\n`);
  write('g.sql', `-- ${TOKEN} a dialect this repo does not lint\n`);
  write('h.ts', `/* ${TOKEN} a block comment opener counts */\n`);
  write('i.js', ` *  ${TOKEN} a continuation line inside a block comment\n`);
  write('j.js', `//    ${TOKEN.toUpperCase()} shouting is still declaring\n`);
  write('README.md', `${TOKEN} described in prose, in a file nothing runs\n`);
  write('logo.png', Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from(`// ${TOKEN}\n`)]));
  write('nul.js', Buffer.concat([Buffer.from('// \0 a NUL in the header\n'), Buffer.from(`// ${TOKEN}\n`)]));
  fs.writeFileSync(path.join(suite, 'nested', 'k.js'), `// ${TOKEN} one directory down\n`);

  const found = guardFiles(suite);
  const has = (n) => found.includes(n);
  check('guardFiles finds a token on a // comment line inside the first ten', has('a.js'));
  check('guardFiles finds a token on the tenth line exactly — the boundary is inclusive', has('b.sh'));
  check('guardFiles does NOT find a token on the eleventh line', !has('c.js'));
  check('guardFiles does NOT fire on a token inside a STRING — a test ABOUT guards is not a guard',
    !has('d.js'));
  check('guardFiles reads # as a comment marker (GDScript, Python, shell)', has('e.gd'));
  check('guardFiles reads /* and a bare * as comment markers', has('h.ts') && has('i.js'));
  check('guardFiles is case-insensitive, like the spec-side marker', has('j.js'));
  check('guardFiles skips a file with no token at all', !has('f.py'));
  check('guardFiles skips an extension the lint will not read — the SAME allowlist',
    !has('README.md') && !has('g.sql'));
  check('guardFiles skips a binary file rather than reading confident nonsense', !has('logo.png'));
  check('guardFiles skips a file with a NUL in its header — the lint\'s own sniff', !has('nul.js'));
  check('guardFiles is top-level only: a nested file is never in the subset', !has('k.js'));
  check('guardFiles returns the exact set, sorted and suite-relative',
    JSON.stringify(found) === JSON.stringify(['a.js', 'b.sh', 'e.gd', 'h.ts', 'i.js', 'j.js']),
    JSON.stringify(found));
  // CRLF: the reference host's working copy is CRLF and every container sees LF, so a scanner
  // that split on '\n' alone would carry a trailing '\r' into the line it tests. Harmless for
  // the token, and NOT harmless for the ten-line window: the count would still be right, but
  // the same file has to answer the same way both ways or the gate disagrees with itself
  // across hosts.
  const crlf = fs.mkdtempSync(path.join(os.tmpdir(), 'freeze-guardfiles-crlf-'));
  for (const n of ['a.js', 'b.sh', 'c.js', 'd.js']) {
    fs.writeFileSync(path.join(crlf, n),
      fs.readFileSync(path.join(suite, n), 'utf8').split('\n').join('\r\n'));
  }
  check('guardFiles answers identically on a CRLF checkout',
    JSON.stringify(guardFiles(crlf)) === JSON.stringify(['a.js', 'b.sh']),
    JSON.stringify(guardFiles(crlf)));

  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'freeze-guardfiles-empty-'));
  check('a suite with no guard file yields [] rather than throwing',
    Array.isArray(guardFiles(empty)) && guardFiles(empty).length === 0);
  check('an unreadable or missing directory yields [] rather than throwing',
    Array.isArray(guardFiles(path.join(empty, 'no-such-dir'))));
  fs.rmSync(suite, { recursive: true, force: true });
  fs.rmSync(crlf, { recursive: true, force: true });
  fs.rmSync(empty, { recursive: true, force: true });
}

// --- withGuardDir: the scratch directory the subset runs from ---------------------------------
//
// A mirror of `withEmptyControlDir`, and it inherits both of that function's lessons. The
// SIBLING placement is not cosmetic: every frozen suite resolves its own root as
// `path.resolve(__dirname, '..', '..', '..')`, so a guard file judged from anywhere at another
// depth resolves a different tree and fails for a reason that has nothing to do with its pin.
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'freeze-guarddir-'));
  const suite = path.join(root, 'tests', 'acceptance', 'demo');
  fs.mkdirSync(suite, { recursive: true });
  fs.writeFileSync(path.join(suite, 'guard.js'), 'process.exit(0);\n');
  fs.writeFileSync(path.join(suite, 'other.js'), 'process.exit(1);\n');

  let handed = null; let contents = null; let livedAt = null;
  const returned = withGuardDir(root, suite, ['guard.js'], (dir) => {
    handed = dir;
    livedAt = path.join(root, dir);
    contents = fs.readdirSync(livedAt).sort();
    return 'the callback\'s value';
  });
  check('withGuardDir hands back a repo-relative POSIX path, never an absolute one',
    typeof handed === 'string' && !path.isAbsolute(handed) && !handed.includes('\\'), handed);
  check('...that is a SIBLING of the suite, at the same depth',
    /^tests\/acceptance\/\.freeze-gate-guards-[^/]+\/$/.test(handed), handed);
  check('...holding exactly the named files and nothing else',
    JSON.stringify(contents) === JSON.stringify(['guard.js']), JSON.stringify(contents));
  check('withGuardDir returns whatever its callback returned', returned === 'the callback\'s value');
  check('the directory is removed afterwards', !fs.existsSync(livedAt));

  // The per-call counter, not the pid alone. `withEmptyControlDir` was keyed on the pid and
  // became one name per process the moment the gate started calling it twice; the second
  // call's `finally` then deleted the first call's directory out from under it. The mirror
  // inherits the fix, and this is the check that keeps it.
  let first = null; let second = null;
  withGuardDir(root, suite, [], (d) => { first = d; });
  withGuardDir(root, suite, [], (d) => { second = d; });
  check('two calls in one process get different directories', first !== second, `${first} vs ${second}`);

  // Cleanup is in a `finally`, so a callback that throws still leaves nothing in a tree that is
  // about to be committed and frozen.
  let seen = null; let threw = false;
  try {
    withGuardDir(root, suite, ['guard.js'], (d) => { seen = path.join(root, d); throw new Error('boom'); });
  } catch { threw = true; }
  check('a callback that throws still removes the directory and propagates',
    threw && seen && !fs.existsSync(seen));
  check('nothing named .freeze-gate-guards- survives beside the suite',
    fs.readdirSync(path.join(root, 'tests', 'acceptance'))
      .every((e) => !e.startsWith('.freeze-gate-guards-')),
    fs.readdirSync(path.join(root, 'tests', 'acceptance')).join(', '));
  fs.rmSync(root, { recursive: true, force: true });
}

// --- the brittleness lint (DESIGN.md §3.2, "below the panel", move 6) -------------------------
//
// The frozen suite `tests/acceptance/repo-uw6/` gated this once and never runs again, so this
// is the coverage that survives. The pairs below are copied here FIRST, ahead of anything
// merely exercising the code, because they are the only checks that separate a useful lint
// from one that flags everything: for each shape, one line that must fire and one that must
// not, differing in exactly the feature the rule turns on. Two of the four are VERBATIM house
// patterns from this repo's own frozen suites — six of them compare two computed digests as
// the "writes nothing" guard, and `repo-1cy` runs git against a ref it created itself — so a
// detector keyed on `createHash` or on `git diff` fails here while scoring full marks on
// every "does the shape fire" check in the file.

const shapesAt = (text, file) => brittleFindings(text, file || 'f.js').map((f) => f.shape);
const fires = (shape, text, opts) =>
  brittleFindings(String(text), 'f.js', opts).some((f) => f.shape === shape);

// literal-name-list — a hand-typed list of names on the EXPECTED side of an equality assertion.
check('literal-name-list fires on a three-name array compared by deepStrictEqual',
  fires('literal-name-list', "assert.deepStrictEqual(keys, ['alpha', 'beta', 'gamma']);"));
check('literal-name-list fires with double quotes and no spacing',
  fires('literal-name-list', 'assert.deepStrictEqual(names, ["one","two"]);'));
check('literal-name-list fires on a two-name list, the smallest catalogue',
  fires('literal-name-list', "assert.deepStrictEqual(order, ['first', 'second']);"));
// The near-miss: the same literal, used as an INPUT rather than as the expected value.
check('literal-name-list does NOT fire on a literal list passed to path.join',
  !fires('literal-name-list', "const p = path.join('tests', 'acceptance', 'demo');"));
check('literal-name-list does NOT fire on a plain assignment of a name list',
  !fires('literal-name-list', "const FIXTURE_FILES = ['a.js', 'b.js'];"));
check('literal-name-list does NOT fire on two computed lists compared to each other',
  !fires('literal-name-list', 'assert.deepStrictEqual(Object.keys(got), Object.keys(want));'));

// literal-count — a population pinned at an exact size.
check('literal-count fires on strictEqual(x.length, N)',
  fires('literal-count', 'assert.strictEqual(rows.length, 30);'));
check('literal-count fires on an === comparison against an integer',
  fires('literal-count', 'assert(out.length === 7);'));
check('literal-count fires on GDScript `.size()` inside assert_eq',
  fires('literal-count', 'assert_eq(entries.size(), 61)'));
check('literal-count fires on a Python len() pinned by an assertion',
  fires('literal-count', 'assert len(rows) == 12'));
// The near-misses: describing a population without pinning it, and the two counts that are
// almost never a catalogue.
check('literal-count does NOT fire on > 0', !fires('literal-count', 'assert(lines.length > 0);'));
check('literal-count does NOT fire on === 0',
  !fires('literal-count', 'assert.strictEqual(errors.length, 0);'));
check('literal-count does NOT fire on === 1',
  !fires('literal-count', 'assert.strictEqual(matches.length, 1);'));
check('literal-count does NOT fire on a non-count field compared to an integer',
  !fires('literal-count', 'assert.strictEqual(r.status, 0);'));

// literal-digest — a hash compared against a literal somebody typed.
check('literal-digest fires on a digest compared to a hex string literal',
  fires('literal-digest', "assert.strictEqual(sha1(tree), 'd41d8cd98f00b204e9800998ecf8427e');"));
check('literal-digest fires through createHash().digest() as well',
  fires('literal-digest',
    "assert.equal(crypto.createHash('sha1').update(b).digest('hex'), '0123456789abcdef0123456789abcdef');"));
// THE HOUSE PATTERN. Six of this repo's frozen suites hash a walked tree before and after and
// compare the two. Nothing later work does can change a before/after snapshot, so this must
// never fire — and a detector keyed on `createHash` flags all six.
check('literal-digest does NOT fire on two COMPUTED digests compared to each other',
  !fires('literal-digest', 'assert.strictEqual(digestBefore, digestAfter);'));
check('literal-digest does NOT fire on the house snapshot guard as this repo writes it',
  !fires('literal-digest', "check('the gate writes nothing', digestOf(root) === after);"));

// branch-self-diff — the shape that INVERTS, going red because a later task did its job.
check('branch-self-diff fires on a diff against origin/main',
  fires('branch-self-diff', "spawnSync('git', ['diff', '--name-only', 'origin/main', 'HEAD']);"));
check('branch-self-diff fires on a merge-base against origin/master in a shell string',
  fires('branch-self-diff', "run('git merge-base origin/master HEAD');"));
check('branch-self-diff fires on a bare integration-branch name from pipeline.config.json',
  fires('branch-self-diff', "spawnSync('git', ['diff', 'release', 'HEAD']);",
    { defaultBranch: 'release' }));
// THE OTHER HOUSE PATTERN, verbatim from `repo-1cy`: git against a ref the test built itself
// in a throwaway repository, which CLAUDE.md cites as the CORRECT way to do this.
check('branch-self-diff does NOT fire on git against a ref the test created itself',
  !fires('branch-self-diff',
    "spawnSync('git', ['diff', '--name-only', base, 'HEAD'], { cwd: throwaway });"));
check('branch-self-diff does NOT fire on a git call that is not diff or merge-base',
  !fires('branch-self-diff', "spawnSync('git', ['status', '--porcelain'], { cwd: tmp });"));

// --- the record: line, file, text, question ----------------------------------------------------

const MULTILINE = [
  '// a fixture',
  "const list = ['x'];",
  'assert.deepStrictEqual(list,',
  "  ['x', 'y', 'z']);",
].join('\n');
const ml = brittleFindings(MULTILINE, 'multi.js');
check('a finding is 1-indexed against the source line', ml.length > 0 && ml[0].line === 3,
  ml.map((f) => f.line).join(','));
check('an assertion split across lines is reported where it STARTS',
  ml.some((f) => f.shape === 'literal-name-list' && f.line === 3));
check('the continuation line is not reported a second time on its own',
  !ml.some((f) => f.line === 4));
check('`text` is the trimmed source line the finding sits on',
  ml.every((f) => f.text === MULTILINE.split('\n')[f.line - 1].trim()));
check('`file` is echoed back exactly as it was handed in',
  ml.every((f) => f.file === 'multi.js'));

// This working copy is CRLF and every container is LF (CLAUDE.md, the line-endings rule), so
// the line number has to survive both. A naive counter is off by nothing on LF and wrong
// everywhere on CRLF, which is the environment a planning session actually runs in.
check('line numbers survive CRLF input',
  brittleFindings(MULTILINE.split('\n').join('\r\n'), 'multi.js')
    .some((f) => f.shape === 'literal-name-list' && f.line === 3));

// Per line, per shape — a precedence rule would hide the second reason a line is brittle.
const BOTH = "assert.deepStrictEqual(names, ['a', 'b']); assert.strictEqual(names.length, 2);";
check('one line matching two shapes yields TWO findings, one each, with no precedence',
  shapesAt(BOTH).filter((s) => s === 'literal-name-list').length === 1
  && shapesAt(BOTH).filter((s) => s === 'literal-count').length === 1,
  shapesAt(BOTH).join(','));

// Comments and string literals are linted deliberately: a commented-out brittle assertion is
// a brittle assertion someone will uncomment.
check('a commented-out brittle assertion is still reported',
  fires('literal-count', '// assert.strictEqual(rows.length, 30);'));
// ...but prose ABOUT a shape is not an instance of it.
check('prose describing the shape is not itself a finding',
  brittleFindings('// this used to pin the catalogue at exactly thirty entries', 'p.js').length === 0);
check('empty input is zero findings rather than a throw', brittleFindings('', 'e.js').length === 0);

const questions = ['literal-name-list', 'literal-count', 'literal-digest', 'branch-self-diff']
  .map((shape) => {
    const t = {
      'literal-name-list': "assert.deepStrictEqual(k, ['a', 'b']);",
      'literal-count': 'assert.strictEqual(k.length, 9);',
      'literal-digest': "assert.strictEqual(sha1(t), 'd41d8cd98f00b204e9800998ecf8427e');",
      'branch-self-diff': "spawnSync('git', ['merge-base', 'origin/main', 'HEAD']);",
    }[shape];
    const f = brittleFindings(t, 'q.js').find((x) => x.shape === shape);
    return [shape, f ? String(f.question) : ''];
  });
check('every shape carries a question', questions.every(([, q]) => q.length > 0));
check('the four questions are pairwise distinct, not one generic string',
  new Set(questions.map(([, q]) => q)).size === 4);
check('each question names its own shape', questions.every(([s, q]) => q.includes(s)));

// --- lintSuite: what is read, and what is NAMED as skipped -------------------------------------

const lintRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'freeze-lint-'));
fs.writeFileSync(path.join(lintRoot, 'good.js'), "assert.deepStrictEqual(k, ['a', 'b']);\n");
// `fs.readFileSync(p, 'utf8')` DOES NOT THROW on binary input — it returns replacement
// characters — so without a sniff a naive implementation lints this file and reports whatever
// the mojibake happens to look like.
fs.writeFileSync(path.join(lintRoot, 'bin.js'), Buffer.from([0x41, 0x00, 0x42]));
fs.writeFileSync(path.join(lintRoot, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
fs.mkdirSync(path.join(lintRoot, 'nested'), { recursive: true });
fs.writeFileSync(path.join(lintRoot, 'nested', 'deep.gd'), 'assert_eq(rows.size(), 30)\n');
const suite = lintSuite(lintRoot);
const skipReason = (n) => (suite.skipped.find((s) => s.path.endsWith(n)) || {}).reason;
check('a NUL-byte file is skipped with the pinned reason `binary`', skipReason('bin.js') === 'binary',
  skipReason('bin.js'));
check('a file outside the read allowlist is skipped with the pinned reason `extension`',
  skipReason('image.png') === 'extension', skipReason('image.png'));
// The assertion that separates the two silent failures — swallowing the file, and aborting
// the whole pass — which are otherwise indistinguishable from "clean suite".
check('THE READABLE SIBLING IS STILL LINTED beside the skipped ones',
  suite.findings.some((f) => f.file === 'good.js'));
check('lintSuite recurses, and reports paths suite-relative with forward slashes',
  suite.findings.some((f) => f.file === 'nested/deep.gd'), suite.findings.map((f) => f.file).join(','));
check('a clean suite returns an empty findings array rather than nothing',
  Array.isArray(lintSuite(path.join(lintRoot, 'nested', 'deep.gd')).findings));
fs.rmSync(lintRoot, { recursive: true, force: true });

// --- choosing the control ---------------------------------------------------------------------

// The empty-directory probe was the first design and it was wrong in the worst direction: a
// good runner SHOULD fail on "no test files found", so the probe fails on exactly the
// well-built runners the gate most needs to work with. These checks pin the replacement.
const ctlRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'freeze-ctl-'));
check('with no control fixture, the gate falls back to the empty probe',
  resolveControl(ctlRepo, null).kind === 'empty-probe');
check('the empty-probe fallback supplies no directory',
  resolveControl(ctlRepo, null).dir === null);

// An empty _control directory is not a control — it is the fallback wearing a costume.
fs.mkdirSync(path.join(ctlRepo, 'tests', 'acceptance', '_control'), { recursive: true });
check('an EMPTY _control directory does not count as a control',
  resolveControl(ctlRepo, null).kind === 'empty-probe');

fs.writeFileSync(path.join(ctlRepo, 'tests', 'acceptance', '_control', 'c.js'), 'process.exit(0);');
check('a populated _control directory is used', resolveControl(ctlRepo, null).kind === 'conventional');
check('the conventional control is the documented path',
  resolveControl(ctlRepo, null).dir === CONTROL_DIR);
check('--control overrides the convention',
  resolveControl(ctlRepo, 'some/other/dir').kind === 'explicit');
fs.rmSync(ctlRepo, { recursive: true, force: true });

// The indeterminate message must differ by which control was used: with no fixture the fix is
// "add one", with a real one the fix is "your harness is broken". Same verdict, opposite
// instruction, and telling a user to fix a harness that is fine wastes the finding.
const weak = verdictFor(ok(1), ok(1), 'empty-probe');
const strong = verdictFor(ok(1), ok(1), 'conventional');
check('both control kinds still yield indeterminate',
  weak.verdict === 'indeterminate' && strong.verdict === 'indeterminate');
check('the empty-probe message says the probe proves nothing', /proves nothing/.test(weak.detail));
check('the empty-probe message names the fixture to add', new RegExp(CONTROL_DIR).test(weak.detail));
check('the real-control message blames the harness instead',
  /harness is broken/.test(strong.detail) && !new RegExp(CONTROL_DIR).test(strong.detail));

// --- the empty-directory fallback ---------------------------------------------------------

const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'freeze-gate-'));
let seenDir = null;
const returned = withEmptyControlDir(tmpRepo, (dir) => {
  seenDir = dir;
  const abs = path.join(tmpRepo, dir);
  check('the control directory exists while the callback runs', fs.existsSync(abs));
  check('the control directory is empty', fs.readdirSync(abs).length === 0);
  return 'value';
});
check('withEmptyControlDir returns the callback value', returned === 'value');
check('the control directory is removed afterwards',
  seenDir && !fs.existsSync(path.join(tmpRepo, seenDir)));
// It is handed to the verify command as a repo-relative POSIX path, because that is how the
// verifier passes the real test directory and some runners reject anything else.
check('the control path is repo-relative and POSIX', seenDir && !path.isAbsolute(seenDir)
  && !seenDir.includes('\\'), seenDir);
check('the control directory is cleaned up even when the callback throws', (() => {
  let d = null;
  try { withEmptyControlDir(tmpRepo, (dir) => { d = dir; throw new Error('boom'); }); }
  catch { /* expected */ }
  return d && !fs.existsSync(path.join(tmpRepo, d));
})());

// TWO CALLS IN ONE TREE. The gate now makes this call once per tree, and the two trees can be
// the same tree — a probe built in place, or both flags aimed at one fixture. Keyed on the pid
// alone the name was a single name per process, so the inner call's `finally` deleted the outer
// call's directory and the fork-point control silently probed a path that no longer existed.
check('two calls in ONE tree get different directories, and the outer survives the inner', (() => {
  let outerDir = null; let innerDir = null; let outerAliveAfterInner = false;
  withEmptyControlDir(tmpRepo, (a) => {
    outerDir = a;
    withEmptyControlDir(tmpRepo, (b) => { innerDir = b; });
    outerAliveAfterInner = fs.existsSync(path.join(tmpRepo, a));
  });
  return outerDir && innerDir && outerDir !== innerDir && outerAliveAfterInner;
})());
check('both nested control directories are removed afterwards',
  fs.readdirSync(tmpRepo).every((e) => !e.startsWith('.freeze-gate-control')),
  fs.readdirSync(tmpRepo).join(', '));

// The root is a PARAMETER, not "the target repo": a probe is a repo-shaped tree with a control
// of its own, and resolving the probe's control against the target would judge the probe by a
// harness it does not use.
const probeCtl = fs.mkdtempSync(path.join(os.tmpdir(), 'freeze-probe-ctl-'));
fs.mkdirSync(path.join(probeCtl, 'tests', 'acceptance', '_control'), { recursive: true });
fs.writeFileSync(path.join(probeCtl, 'tests', 'acceptance', '_control', 'c.js'), 'process.exit(0);');
check('resolveControl answers about the root it is HANDED, not a fixed one',
  resolveControl(probeCtl, null).kind === 'conventional'
  && resolveControl(tmpRepo, null).kind === 'empty-probe');
check('withEmptyControlDir builds inside the root it is handed',
  withEmptyControlDir(probeCtl, (dir) => fs.existsSync(path.join(probeCtl, dir))));
fs.rmSync(probeCtl, { recursive: true, force: true });

// --- the probe's copy of the suite ----------------------------------------------------------
//
// The probe runs its OWN copy of the suite, so a probe author can satisfy the criteria by
// editing the test rather than the tree — and the gate would then bless the freeze it exists to
// prevent. Hashed byte for byte, in name order, before any probe run.
const cmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'freeze-cmp-'));
const mk = (name, files) => {
  const d = path.join(cmpRoot, name);
  fs.mkdirSync(path.join(d, 'nested'), { recursive: true });
  for (const [f, body] of Object.entries(files)) fs.writeFileSync(path.join(d, f), body);
  return d;
};
const forkSuite = mk('fork', { 'test.js': 'A\n', 'helper.js': 'B\n', 'nested/deep.js': 'C\n' });
const sameSuite = mk('same', { 'test.js': 'A\n', 'helper.js': 'B\n', 'nested/deep.js': 'C\n' });
const editSuite = mk('edited', { 'test.js': 'A\n', 'helper.js': 'B!\n', 'nested/deep.js': 'C\n' });
const goneSuite = mk('gone', { 'test.js': 'A\n', 'nested/deep.js': 'C\n' });
const plusSuite = mk('plus', { 'test.js': 'A\n', 'helper.js': 'B\n', 'nested/deep.js': 'C\n', 'extra.js': 'D\n' });
const cmp = compareSuites(forkSuite, sameSuite);
check('two identical suite copies compare equal', !cmp.probeMissing && cmp.absent.length === 0
  && cmp.differing.length === 0 && cmp.extra.length === 0, JSON.stringify(cmp));
check('the comparison recurses into subdirectories',
  digestSuite(forkSuite).has('nested/deep.js'), [...digestSuite(forkSuite).keys()].join(','));
check('a file whose BYTES differ is named as edited',
  compareSuites(forkSuite, editSuite).differing.join(',') === 'helper.js',
  JSON.stringify(compareSuites(forkSuite, editSuite)));
check('a file the probe DELETED is named as absent',
  compareSuites(forkSuite, goneSuite).absent.join(',') === 'helper.js');
check('a file present only in the probe is named as extra',
  compareSuites(forkSuite, plusSuite).extra.join(',') === 'extra.js');
check('a probe with no suite directory at all reports probeMissing',
  compareSuites(forkSuite, path.join(cmpRoot, 'nope')).probeMissing === true);
check('a probe whose suite path is a FILE is probeMissing, not a crash',
  (() => { const f = path.join(cmpRoot, 'a-file'); fs.writeFileSync(f, 'x');
    return compareSuites(forkSuite, f).probeMissing === true; })());
check('digestSuite hashes content, so whitespace alone is a difference',
  compareSuites(forkSuite, mk('ws', { 'test.js': 'A \n', 'helper.js': 'B\n', 'nested/deep.js': 'C\n' }))
    .differing.join(',') === 'test.js');
fs.rmSync(cmpRoot, { recursive: true, force: true });

// --- the capture ceiling, proven against the REAL 1 MiB limit ---------------------------------
//
// `runVerify` had no maxBuffer, so Node's 1 MiB default applied and spawnSync KILLED the child
// on overflow — and a probe that passes is verbose by definition. Change-log row
// `verify-nobuffer` recurring inside the gate that judges the freeze.
check('the gate\'s ceiling IS the verifier\'s, not a second copy of the number',
  MAX_BUFFER === VERIFIER_MAX_BUFFER && typeof MAX_BUFFER === 'number', String(MAX_BUFFER));
// Value equality is only half of it: a retyped literal has the right value too, and the two
// copies then drift silently and unattended (the `runner/pause.js` precedent). So the source
// must IMPORT it and must not carry a maxBuffer of its own.
const gateSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'freeze-gate.js'), 'utf8');
check('the ceiling is imported from pipeline/verify-classify.js by name',
  /MAX_BUFFER\s*}\s*=\s*require\(['"]\.\.\/pipeline\/verify-classify(\.js)?['"]\)/.test(gateSrc));
check('and no line assigns maxBuffer a literal of its own',
  !gateSrc.split(/\r?\n/).some((l) => /maxBuffer\s*:\s*[\d(]/.test(l)),
  gateSrc.split(/\r?\n/).filter((l) => /maxBuffer\s*:/.test(l)).join(' | '));
// Behavioural, against the limit itself. fs.writeSync, never process.stdout.write followed by
// process.exit: that write is async and the exit truncates it, so nothing overflows and the
// check passes against the very implementation it exists to catch.
const loudRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'freeze-loud-'));
const loudStub = path.join(loudRoot, 'loud.js');
fs.writeFileSync(loudStub, "const fs = require('fs');\nfs.writeSync(1, 'x'.repeat(2 * 1024 * 1024) + '\\n');\nprocess.exit(0);\n");
const savedCmd = process.env.FREEZE_GATE_CMD;
process.env.FREEZE_GATE_CMD = `"${process.execPath.replace(/\\/g, '/')}" "${loudStub.replace(/\\/g, '/')}"`;
const loudRun = runVerify(loudRoot, 'unused', '.', 600000);
if (savedCmd === undefined) delete process.env.FREEZE_GATE_CMD; else process.env.FREEZE_GATE_CMD = savedCmd;
check('a run printing more than 1 MiB and exiting 0 keeps its exit status',
  loudRun.status === 0, `${loudRun.status} / ${loudRun.error} / ${loudRun.signal}`);
check('...and is not reported as killed', !loudRun.signal && !loudRun.error,
  `${loudRun.signal} ${loudRun.error}`);
check('...and the output past 1 MiB is actually captured',
  loudRun.stdout.length > 1024 * 1024, String(loudRun.stdout.length));
fs.rmSync(loudRoot, { recursive: true, force: true });

// --- end to end, through the CLI, with a stubbed verify command ------------------------------

// A stub that reports red exactly when the directory it is given holds files — the behaviour
// of an honest test runner, and the only shape that produces a `red` verdict. Which TREE it is
// running in is read from a marker file in its own working directory, never from comparing
// `process.cwd()` against a string: on the reference host a temp path can be an 8.3 short name,
// and Git Bash and the child disagree on separators and case, so that comparison passes for
// whoever wrote it and fails for everyone else.
const STUB = `
const fs = require('fs'); const path = require('path'); const crypto = require('crypto');
const p = process.argv[2];
const mode = process.env.STUB_MODE || 'honest';
let listing = []; const digests = {};
try {
  listing = fs.readdirSync(p).sort();
  for (const f of listing) {
    try { digests[f] = crypto.createHash('sha256').update(fs.readFileSync(path.join(p, f))).digest('hex'); }
    catch {}
  }
} catch {}
if (process.env.STUB_LOG) {
  fs.appendFileSync(process.env.STUB_LOG, JSON.stringify({ arg: p, listing, digests }) + '\\n');
  // The marker carries the ARGUMENT as well as the pid, so a later check can ask which TREE a
  // named run happened in rather than only how many runs each tree saw.
  fs.writeFileSync(path.join(process.cwd(),
    '.ran-here-' + process.pid + '-' + Math.floor(process.hrtime()[1])
    + '-' + String(p).replace(/[^A-Za-z0-9._-]/g, '_')), '');
}
const inProbe = fs.existsSync(path.join(process.cwd(), '.is-probe'));
const isControl = /_control|freeze-gate-control/.test(p);
// The guard subset, judged before every other mode: the modes below describe what the SUITE
// does, and the subset is a different question asked of the same command.
if (/[.]freeze-gate-guards-/.test(p)) {
  if (mode === 'guard-red') { process.stderr.write('guard: the burn table moved\\n'); process.exit(1); }
  // What a FREEZE_GATE_CMD naming a command that does not exist produces, byte for byte:
  // \`sh -c\` answers 127 on stderr. Reproduced on the guard run alone because one env var
  // drives all four invocations — a genuinely missing command would take the fork point down
  // with it and never reach the guard side at all.
  if (mode === 'guard-nocmd') { process.stderr.write('sh: no-such-verify-command: not found\\n'); process.exit(127); }
  process.exit(0);
}
let n = 0; try { n = listing.length; } catch { n = 0; }
if (mode === 'always-green') process.exit(0);
if (mode === 'always-red') process.exit(4);
if (inProbe && mode === 'probe-broken') process.exit(1);
if (inProbe && mode === 'probe-red') process.exit(isControl ? 0 : 1);
if (inProbe) process.exit(0);
// A control fixture is a test known to pass, so the honest answer is 0 whatever it holds. Last,
// deliberately: every mode above describes a harness that is broken for ALL directories, and a
// control that answered 0 through those would make the broken-harness rows unreachable.
if (isControl) process.exit(0);
process.exit(n > 0 ? 1 : 0);
`;
const stubPath = path.join(tmpRepo, 'stub.js');
fs.writeFileSync(stubPath, STUB);
// Forward slashes and explicit quoting: the command is handed to `sh -c`, and process.execPath
// on this host is a Windows path containing a space.
const q = (p) => `"${p.replace(/\\/g, '/')}"`;
process.env.FREEZE_GATE_CMD = `${q(process.execPath)} ${q(stubPath)}`;

fs.writeFileSync(path.join(tmpRepo, 'pipeline.config.json'),
  JSON.stringify({ verifyCommand: 'unused-because-stubbed' }));
const testDir = path.join(tmpRepo, 'tests', 'acceptance', 'demo');
fs.mkdirSync(testDir, { recursive: true });
fs.writeFileSync(path.join(testDir, 'test.js'), '// a test');
const specPath = path.join(tmpRepo, 'spec.md');
fs.writeFileSync(specPath, SPEC);

// Silence both streams: the negative cases deliberately provoke error output, and a passing
// run that prints its own expected errors trains a reader to ignore the output entirely.
const silence = () => {
  const o = console.log; const e = console.error;
  console.log = () => {}; console.error = () => {};
  return () => { console.log = o; console.error = e; };
};
const runMain = (args) => { const restore = silence(); try { return main(args); } finally { restore(); } };

// The probe: a second repo-shaped tree carrying its own copy of the suite, byte for byte, plus
// the marker the stub reads to know which tree it woke up in.
const probeRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'freeze-probe-'));
fs.writeFileSync(path.join(probeRepo, 'pipeline.config.json'),
  JSON.stringify({ verifyCommand: 'a probe-side config is never read' }));
fs.mkdirSync(path.join(probeRepo, 'tests', 'acceptance', 'demo'), { recursive: true });
fs.writeFileSync(path.join(probeRepo, 'tests', 'acceptance', 'demo', 'test.js'), '// a test');
fs.writeFileSync(path.join(probeRepo, '.is-probe'), '');

const ARGS = ['--repo', tmpRepo, '--tests', 'tests/acceptance/demo/'];
const GREEN = [...ARGS, '--green', probeRepo];
check('CLI exits 0 when the tests are red at the fork point and GREEN in the probe',
  runMain(GREEN) === 0);
check('CLI exits 4 — half-proven — when the tests are red and no probe was given',
  runMain(ARGS) === 4);

process.env.STUB_MODE = 'probe-red';
check('CLI exits 3 when the tests are red in the probe too', runMain(GREEN) === 3);
process.env.STUB_MODE = 'probe-broken';
check('CLI exits 2, never 3, when the PROBE\'S control is not green', runMain(GREEN) === 2);
delete process.env.STUB_MODE;

process.env.STUB_MODE = 'always-green';
check('CLI exits 1 when the tests pass at the fork point', runMain(ARGS) === 1);
check('...and still 1 with a probe supplied', runMain(GREEN) === 1);

process.env.STUB_MODE = 'always-red';
check('CLI exits 2 when red cannot be told from a broken harness', runMain(ARGS) === 2);
check('...and still 2 with a probe supplied', runMain(GREEN) === 2);
delete process.env.STUB_MODE;

// The refusals, each NAMING the offending path. An exit-code-only check passes vacuously here:
// before this flag existed, `--green` hit `unexpected argument` and ALSO exited 2.
const refusal = (args) => {
  const o = console.log; const e = console.error;
  let buf = '';
  console.log = (...a) => { buf += `${a.join(' ')}\n`; };
  console.error = (...a) => { buf += `${a.join(' ')}\n`; };
  try { return { code: main(args), out: buf }; } finally { console.log = o; console.error = e; }
};
const missingProbe = path.join(os.tmpdir(), 'freeze-gate-no-such-probe-dir');
const fileProbe = path.join(tmpRepo, 'probe-is-a-file'); fs.writeFileSync(fileProbe, 'x');
let r = refusal([...ARGS, '--green', missingProbe]);
check('a --green path that does not exist exits 2', r.code === 2, String(r.code));
check('...and the refusal NAMES the path', r.out.includes(path.basename(missingProbe)), r.out);
r = refusal([...ARGS, '--green', fileProbe]);
check('a --green path that is a file exits 2', r.code === 2, String(r.code));
check('...and that refusal names the path too', r.out.includes(path.basename(fileProbe)), r.out);
r = refusal([...ARGS, '--green', '']);
check('an empty --green value exits 2', r.code === 2, String(r.code));
check('...and says the flag was given no usable value', /--green/.test(r.out), r.out);
r = refusal([...ARGS, '--green']);
check('--green with no value at all exits 2 and says so',
  r.code === 2 && /--green/.test(r.out), `${r.code}: ${r.out}`);
check('every one of those refusals names WHICH SIDE is broken',
  [missingProbe, fileProbe, '', null].every((p) => {
    const out = refusal(p === null ? [...ARGS, '--green'] : [...ARGS, '--green', p]).out;
    return /probe|arguments/i.test(out);
  }));

// A probe that is not repo-shaped is the probe's bug, and it is caught BEFORE any probe run —
// so it is reported as a broken probe and never as unsatisfiable criteria.
const shapeless = fs.mkdtempSync(path.join(os.tmpdir(), 'freeze-shapeless-'));
r = refusal([...ARGS, '--green', shapeless]);
check('a probe carrying no copy of the suite exits 2, not 3', r.code === 2, String(r.code));
check('...and the message names the probe and says what a probe is',
  /probe/i.test(r.out) && /repo-shaped/i.test(r.out), r.out);
// The crudest way to make a suite pass is to delete the check that fails. The probe runs its
// OWN copy, so this must be refused before the probe runs at all — and this message WINS over
// the broken-probe verdict, which would otherwise describe the same tree.
const deleter = fs.mkdtempSync(path.join(os.tmpdir(), 'freeze-deleter-'));
fs.mkdirSync(path.join(deleter, 'tests', 'acceptance', 'demo'), { recursive: true });
fs.writeFileSync(path.join(deleter, '.is-probe'), '');
r = refusal([...ARGS, '--green', deleter]);
check('a probe that DELETED a file of the frozen suite exits 2', r.code === 2, String(r.code));
check('...and the missing file is named', /test\.js/.test(r.out), r.out);
fs.rmSync(shapeless, { recursive: true, force: true });
fs.rmSync(deleter, { recursive: true, force: true });
fs.rmSync(fileProbe, { force: true });

// A probe that EDITED a test is not refused — the fork point's own copy is what the verdict is
// about — but the difference is named, loudly, because a green probe then says only that the
// edited test passes.
const editor = fs.mkdtempSync(path.join(os.tmpdir(), 'freeze-editor-'));
fs.mkdirSync(path.join(editor, 'tests', 'acceptance', 'demo'), { recursive: true });
fs.writeFileSync(path.join(editor, 'tests', 'acceptance', 'demo', 'test.js'), '// EDITED');
fs.writeFileSync(path.join(editor, '.is-probe'), '');
r = refusal([...ARGS, '--green', editor]);
check('a probe whose copy of a test was edited names the difference',
  /probe suite differs:/.test(r.out) && /test\.js/.test(r.out), r.out);
fs.rmSync(editor, { recursive: true, force: true });

// The report says what happened in the probe, not only what it decided.
const withProbe = refusal(GREEN);
check('the report shows the probe run', /probe run\s+exit\s+0/.test(withProbe.out), withProbe.out);
check('the report shows the probe\'s own control run',
  /probe control\s+exit\s+0/.test(withProbe.out), withProbe.out);
check('the report still names the verdict as RED:', /RED:/.test(withProbe.out));

// The probe's control is resolved against the PROBE, by the same rule used at the target root.
// The fixture is a PAIR and has to be read as one: the probe carries a `_control` fixture and
// the target does not, so the two lines of the report differ — an implementation that resolved
// the probe's control against the target would print the target's answer twice, and with both
// trees shaped alike that is invisible.
fs.mkdirSync(path.join(probeRepo, 'tests', 'acceptance', '_control'), { recursive: true });
fs.writeFileSync(path.join(probeRepo, 'tests', 'acceptance', '_control', 'c.js'), 'process.exit(0);');
const twoControls = refusal(GREEN);
check('the probe\'s control comes from the PROBE\'s own tree',
  new RegExp(`probe control\\s+exit\\s+0\\s+\\(${CONTROL_DIR} in the probe`).test(twoControls.out),
  twoControls.out.split(/\r?\n/).slice(0, 6).join(' | '));
check('...while the target, which has no fixture, still admits its control is weak',
  /control run\s+exit\s+0\s+\(empty directory — NO control fixture/.test(twoControls.out),
  twoControls.out.split(/\r?\n/).slice(0, 6).join(' | '));

// --- HOW the probe is invoked, not only what it decided -----------------------------------
//
// Four invocations with a probe, two without — suite and control in each of two trees. The two
// suite runs carry the SAME repo-relative string, byte for byte, because a frozen suite resolves
// its own root from the tree it sits in and the runner is handed a path relative to cwd: an
// absolute path into the probe would run the fork point's own copy from inside the probe and
// prove nothing about either. WHICH TREE a run happened in is decided by where the stub's marker
// file landed, never by string-comparing `process.cwd()` — on the reference host a temp path can
// be an 8.3 short name, and Git Bash and the child disagree on separators and case, so that
// comparison passes for whoever wrote it and fails for everyone else.
const stubLog = path.join(tmpRepo, 'stub-log.jsonl');
const markers = (d) => fs.readdirSync(d).filter((n) => n.startsWith('.ran-here-'));
const clearMarkers = (d) => { for (const n of markers(d)) fs.rmSync(path.join(d, n)); };
const invocations = (args) => {
  fs.writeFileSync(stubLog, '');
  clearMarkers(tmpRepo); clearMarkers(probeRepo);
  process.env.STUB_LOG = stubLog;
  try { runMain(args); } finally { delete process.env.STUB_LOG; }
  return fs.readFileSync(stubLog, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
};
const plain = invocations(ARGS);
check('without a probe the verify command is spawned twice', plain.length === 2, String(plain.length));
const four = invocations(GREEN);
check('with a probe it is spawned four times — suite and control, in each of two trees',
  four.length === 4, String(four.length));
const suiteArgs = four.map((l) => l.arg).filter((a) => /demo/.test(a));
check('exactly two of the four carry the suite directory', suiteArgs.length === 2,
  suiteArgs.join(' | '));
check('and both carry the SAME repo-relative string, byte for byte',
  suiteArgs[0] === suiteArgs[1], `${suiteArgs[0]} vs ${suiteArgs[1]}`);
check('neither is an absolute path into the probe', !suiteArgs.some((a) => path.isAbsolute(a)),
  suiteArgs.join(' | '));
check('the two suite runs happened in DIFFERENT trees',
  markers(tmpRepo).length >= 1 && markers(probeRepo).length >= 1,
  `repo ${markers(tmpRepo).length}, probe ${markers(probeRepo).length}`);
clearMarkers(tmpRepo); clearMarkers(probeRepo);
fs.rmSync(stubLog, { force: true });

// Nothing is left behind in EITHER tree, after a run that exited non-zero for any reason.
process.env.STUB_MODE = 'probe-red';
runMain(GREEN);
delete process.env.STUB_MODE;
check('no control scratch directory survives in the target tree',
  fs.readdirSync(tmpRepo).every((e) => !e.startsWith('.freeze-gate-control')),
  fs.readdirSync(tmpRepo).join(', '));
check('no control scratch directory survives in the PROBE tree',
  fs.readdirSync(probeRepo).every((e) => !e.startsWith('.freeze-gate-control')),
  fs.readdirSync(probeRepo).join(', '));

check('CLI exits 2 on a missing test directory',
  runMain(['--repo', tmpRepo, '--tests', 'tests/acceptance/nope/']) === 2);
check('CLI exits 2 with no arguments', runMain([]) === 2);
check('CLI exits 2 when the target has no pipeline.config.json',
  runMain(['--repo', path.join(tmpRepo, 'tests'), '--tests', 'acceptance/demo/']) === 2);
check('CLI still exits 0 with --spec supplied', runMain([...GREEN, '--spec', specPath]) === 0);

// The gate must leave nothing behind in the target repo — it runs against a tree that is
// about to be committed and frozen, so a stray directory would land in the freeze.
check('no control directory survives the run',
  fs.readdirSync(tmpRepo).every((e) => !e.startsWith('.freeze-gate-control')),
  fs.readdirSync(tmpRepo).join(', '));

// --- the guard subset through the CLI (change-log row `repo-i4b`) -----------------------------
//
// A second repo/probe pair rather than more files in the one above: a guard file in the shared
// suite would put a third invocation into every count the section above pins, and those counts
// are the only thing that proves the probe is invoked the way it is.
const GTOKEN = `[${'guard'}]`;              // assembled, so this file never declares itself one
const BRITTLE = [
  "assert.deepStrictEqual(keys, ['alpha', 'beta', 'gamma']);",
  'assert.strictEqual(rows.length, 30);',
  "assert.strictEqual(sha1(tree), 'd41d8cd98f00b204e9800998ecf8427e');",
  "spawnSync('git', ['merge-base', 'origin/main', 'HEAD']);",
].join('\n');
const guardRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'freeze-guardcli-repo-'));
const guardProbe = fs.mkdtempSync(path.join(os.tmpdir(), 'freeze-guardcli-probe-'));
const buildGuardTree = (root, isProbe) => {
  fs.writeFileSync(path.join(root, 'pipeline.config.json'),
    JSON.stringify({ verifyCommand: 'unused-because-stubbed' }));
  const d = path.join(root, 'tests', 'acceptance', 'demo');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'test.js'), '// an ordinary criterion\n');
  fs.writeFileSync(path.join(d, 'brittle.js'), BRITTLE);
  fs.writeFileSync(path.join(d, 'guard.js'), `// ${GTOKEN} the burn table is unchanged\nprocess.exit(0);\n`);
  const c = path.join(root, 'tests', 'acceptance', '_control');
  fs.mkdirSync(c, { recursive: true });
  fs.writeFileSync(path.join(c, 'c.js'), 'process.exit(0);\n');
  if (isProbe) fs.writeFileSync(path.join(root, '.is-probe'), '');
};
buildGuardTree(guardRepo, false);
buildGuardTree(guardProbe, true);
const GARGS = ['--repo', guardRepo, '--tests', 'tests/acceptance/demo/'];
const GUARD_GREEN = [...GARGS, '--green', guardProbe];
const gcap = (args, mode) => {
  const o = console.log; const e = console.error;
  let buf = '';
  console.log = (...a) => { buf += `${a.join(' ')}\n`; };
  console.error = (...a) => { buf += `${a.join(' ')}\n`; };
  if (mode) process.env.STUB_MODE = mode; else delete process.env.STUB_MODE;
  try { return { code: main(args), out: buf }; } finally {
    console.log = o; console.error = e; delete process.env.STUB_MODE;
  }
};
const gLog = path.join(os.tmpdir(), `freeze-guard-log-${process.pid}.jsonl`);
const gruns = (args, mode) => {
  fs.writeFileSync(gLog, '');
  for (const t of [guardRepo, guardProbe]) clearMarkers(t);
  process.env.STUB_LOG = gLog;
  let out;
  try { out = gcap(args, mode); } finally { delete process.env.STUB_LOG; }
  return {
    ...out,
    lines: fs.readFileSync(gLog, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)),
  };
};
const SUBSET = /[.]freeze-gate-guards-/;
const strays = (root) => fs.readdirSync(path.join(root, 'tests', 'acceptance'))
  .filter((n) => SUBSET.test(n));

// The count IS the evidence. A subset that is built and then judged by nobody looks exactly
// like a working one from the exit code alone, and a probe still running behind a stale guard
// spends the project's whole test command twice for an answer nothing reads.
const three = gruns(GARGS);
check('a suite with one guard file is THREE invocations without a probe',
  three.lines.length === 3, `${three.lines.length} (exit ${three.code})`);
const five = gruns(GUARD_GREEN);
check('...and FIVE with one — the subset is not re-run in the probe',
  five.lines.length === 5, String(five.lines.length));
const subsetRuns = five.lines.filter((l) => SUBSET.test(l.arg));
check('exactly one invocation judged the guard subset', subsetRuns.length === 1,
  subsetRuns.map((s) => s.arg).join(' | '));
const sub = subsetRuns[0] || { arg: '', listing: [], digests: {} };
check('the subset directory holds the guard file and nothing else',
  JSON.stringify(sub.listing) === JSON.stringify(['guard.js']), JSON.stringify(sub.listing));
check('...byte-identical to the fork point\'s copy',
  sub.digests['guard.js'] === require('crypto').createHash('sha256')
    .update(fs.readFileSync(path.join(guardRepo, 'tests', 'acceptance', 'demo', 'guard.js')))
    .digest('hex'));
check('the subset is handed over as a repo-relative POSIX sibling of the suite',
  /^tests\/acceptance\/\.freeze-gate-guards-[^/]+\/?$/.test(sub.arg), sub.arg);
// WHICH TREE, from the marker the stub named after its own argument — never by comparing
// `process.cwd()` to a string, for the 8.3-short-name reason recorded above.
const subsetMarker = markers(guardRepo).filter((m) => SUBSET.test(m));
check('the subset ran in the FORK-POINT tree, not the probe',
  subsetMarker.length === 1 && markers(guardProbe).filter((m) => SUBSET.test(m)).length === 0,
  `${markers(guardRepo).join(' ')} || ${markers(guardProbe).join(' ')}`);
for (const t of [guardRepo, guardProbe]) clearMarkers(t);
check('no subset directory survives in either tree',
  strays(guardRepo).length === 0 && strays(guardProbe).length === 0,
  `${strays(guardRepo).join(' ')} | ${strays(guardProbe).join(' ')}`);

// The verdicts, from a real argument vector.
const staleNoProbe = gcap(GARGS, 'guard-red');
check('a red guard is exit 5 from the CLI', staleNoProbe.code === 5, String(staleNoProbe.code));
check('...announced as STALE-GUARD: at the start of a line',
  /^STALE-GUARD:/m.test(staleNoProbe.out));
check('...with the guard run\'s own exit status in the report',
  /guard run\s+exit\s+1/.test(staleNoProbe.out), staleNoProbe.out.split('\n').slice(0, 6).join(' | '));
check('...naming the file, because the exit code cannot say WHICH guard is stale',
  staleNoProbe.out.includes('guard.js'));
check('...and carrying the subset\'s stderr, which the whole-suite run drowned',
  staleNoProbe.out.includes('the burn table moved'));
const staleWithProbe = gruns(GUARD_GREEN, 'guard-red');
check('a red guard is still exit 5 WITH a probe — it beats every probe verdict',
  staleWithProbe.code === 5, String(staleWithProbe.code));
check('...and the probe is short-circuited: three invocations, not five',
  staleWithProbe.lines.length === 3, String(staleWithProbe.lines.length));
check('a green guard leaves the no-probe verdict at half-proven/4', gcap(GARGS).code === 4);
check('...reported as a green guard run', /guard run\s+exit\s+0/.test(gcap(GARGS).out));
check('a green guard leaves the probe verdict at red/0', gcap(GUARD_GREEN).code === 0);
check('a green guard leaves a red probe at unreachable/3',
  gcap(GUARD_GREEN, 'probe-red').code === 3);

// A subset that could not RUN is the guard side's bug and says so — never 5, never 0. This is
// what a verify command that does not exist produces on the guard run specifically.
const nocmd = gcap(GARGS, 'guard-nocmd');
check('a guard subset spawned through a command that does not exist is exit 2',
  nocmd.code === 2, String(nocmd.code));
check('...reported as INDETERMINATE, never STALE-GUARD',
  /^INDETERMINATE:/m.test(nocmd.out) && !/STALE-GUARD/.test(nocmd.out));
check('...with the guard side named in the headline, not the spec',
  /guard/i.test((nocmd.out.split('\n').find((l) => /^INDETERMINATE:/.test(l)) || '')),
  nocmd.out.split('\n').find((l) => /^INDETERMINATE:/.test(l)));
check('...and the failing command\'s own words carried through',
  nocmd.out.includes('no-such-verify-command'));

// The count line, on every run and at zero — the `guards declared:` precedent. A line that
// only appears on the interesting branch cannot be told from one that never ran.
check('every run prints the guard-file count',
  [staleNoProbe.out, gcap(GARGS).out, gcap(GUARD_GREEN).out, gcap(GARGS, 'always-green').out]
    .every((o) => /^guard files:\s*1\b/m.test(o)));
// The subset is asked for ONLY from the one state where its answer means anything. In each of
// these the fork point is already unreadable, and a guard's red would be one more number.
for (const [mode, code] of [['always-green', 1], ['always-red', 2]]) {
  const r2 = gruns(GARGS, mode);
  check(`${mode}: the subset is not run at all — two invocations, and no STALE-GUARD`,
    r2.lines.length === 2 && r2.code === code && !/STALE-GUARD/.test(r2.out),
    `${r2.code} / ${r2.lines.length}`);
  check(`${mode}: ...and the report SAYS the guard run did not happen`,
    /guard run\s+not run/.test(r2.out), r2.out.split('\n').slice(0, 6).join(' | '));
}
// And a suite with no guard file says zero and prints no guard line at all — there is nothing
// that could have run, which is a different statement from "it did not run".
const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'freeze-guardcli-bare-'));
buildGuardTree(bare, false);
fs.rmSync(path.join(bare, 'tests', 'acceptance', 'demo', 'guard.js'));
const bareOut = gcap(['--repo', bare, '--tests', 'tests/acceptance/demo/']);
check('a suite with no guard file prints `guard files: 0`', /^guard files:\s*0\b/m.test(bareOut.out));
check('...and no guard run line of any kind', !/guard run/.test(bareOut.out), bareOut.out);
check('...and is still half-proven/4', bareOut.code === 4, String(bareOut.code));
fs.rmSync(bare, { recursive: true, force: true });
fs.rmSync(gLog, { force: true });

// --- the lint through the CLI: it reports, and it never touches the verdict -------------------

const capture = (args) => {
  const o = console.log; const e = console.error;
  let buf = '';
  console.log = (...a) => { buf += `${a.join(' ')}\n`; };
  console.error = (...a) => { buf += `${a.join(' ')}\n`; };
  try { return { code: main(args), out: buf }; } finally { console.log = o; console.error = e; }
};
const COUNT_LINE = /brittleness findings:\s*(\d+)/;

// A clean suite must still print the count. A discriminator silent when it finds nothing
// cannot be told from one that never ran — the `guards declared:` precedent.
const clean = capture(GREEN);
check('the count line prints even when the suite is clean',
  /brittleness findings:\s*0\b/.test(clean.out), clean.out.split('\n').slice(-3).join(' | '));
check('a clean suite does not change the verdict', clean.code === 0);

// The obvious wrong placement is inside `if (spec)`, beside `guards declared:` — where the
// lint vanishes for every invocation that omits `--spec`, which is most of them.
check('the count line prints WITHOUT --spec', COUNT_LINE.test(capture(ARGS).out));
check('the count line prints WITH --spec', COUNT_LINE.test(capture([...ARGS, '--spec', specPath]).out));

fs.writeFileSync(path.join(testDir, 'brittle.js'), [
  "assert.deepStrictEqual(keys, ['alpha', 'beta', 'gamma']);",
  'assert.strictEqual(rows.length, 30);',
  "assert.strictEqual(sha1(tree), 'd41d8cd98f00b204e9800998ecf8427e');",
  "spawnSync('git', ['merge-base', 'origin/main', 'HEAD']);",
].join('\n'));
fs.writeFileSync(path.join(testDir, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
// The probe carries the same suite, byte for byte — plus one brittle file of its own, which the
// lint must never read: the lint runs ONCE, over the fork-point suite only. A probe is
// throwaway and deliberately crude, and findings nobody will ever fix are noise in a report
// whose whole value is that every finding takes a disposition.
const probeSuite = path.join(probeRepo, 'tests', 'acceptance', 'demo');
fs.copyFileSync(path.join(testDir, 'brittle.js'), path.join(probeSuite, 'brittle.js'));
fs.copyFileSync(path.join(testDir, 'logo.png'), path.join(probeSuite, 'logo.png'));
fs.writeFileSync(path.join(probeSuite, 'probe-only-brittle.js'),
  "assert.deepStrictEqual(keys, ['probe', 'only', 'list']);\nassert.strictEqual(rows.length, 44);\n");

// The exit code is a verdict about red, green and indeterminate that PLANNING.md step 4
// branches on. A lint that can fail a freeze is a gate on spec AUTHORING, whose only defeat is
// rewording until it passes (hard rule 5) — so it is checked in all three arms, with findings
// present in every one. The green and indeterminate arms are the ones that catch an
// `if (findings.length) return 1`: red already exits 0, so there it is invisible.
// The `stale-guard` arm runs against the guard pair rather than this one, because a guard file
// in the suite above would put a third invocation into every count that section pins. Its suite
// carries a byte-identical copy of the same brittle file, so the "the lint fired here too"
// half of this check means the same thing in all seven arms.
const arms = [
  [null, ARGS, 4], [null, GREEN, 0], ['always-green', GREEN, 1], ['always-red', GREEN, 2],
  ['probe-red', GREEN, 3], ['probe-broken', GREEN, 2], ['guard-red', GUARD_GREEN, 5],
];
let armsHeld = true; let armsFired = true; const armsSeen = [];
for (const [mode, args, expected] of arms) {
  if (mode) process.env.STUB_MODE = mode; else delete process.env.STUB_MODE;
  const r = capture(args);
  const m = r.out.match(COUNT_LINE);
  armsSeen.push(`${mode || 'honest'}:${r.code}`);
  if (r.code !== expected) armsHeld = false;
  if (!m || Number(m[1]) < 4) armsFired = false;
}
delete process.env.STUB_MODE;
check('findings never move the exit code, in any of the SIX verdicts', armsHeld, armsSeen.join(' '));
check('and the lint is proven to have FIRED in each of those same runs', armsFired);
check('every exit code the gate can produce was reached in that sweep',
  new Set(armsSeen.map((s) => s.split(':')[1])).size === 6, armsSeen.join(' '));

const loud = capture(GREEN);
check('the lint runs ONCE, over the fork-point suite only — never over the probe',
  Number(loud.out.match(COUNT_LINE)[1]) === 4, loud.out.match(COUNT_LINE)[0]);
check('...and no finding names a file that exists only in the probe',
  !/probe-only-brittle\.js:\d+\s+\[/.test(loud.out));
check('each finding is reported as <file>:<line>  [<shape>]',
  /brittle\.js:1\s+\[literal-name-list\]/.test(loud.out));
check('all four shapes reach stdout',
  ['literal-name-list', 'literal-count', 'literal-digest', 'branch-self-diff']
    .every((s) => loud.out.includes(`[${s}]`)));
check('a skipped path is named on stdout with its reason',
  /skipped:\s*logo\.png\s+\(extension\)/.test(loud.out), loud.out);
check('the finding line carries the question the human is being asked',
  /is later work licensed/.test(loud.out));

// If the pass itself fails it must say so, keep the verdict, and NEVER print a `0` — a silent
// false clean is the exact failure the "name what is skipped" rule exists to prevent. There is
// no portable unreadable file (chmod-000 is unreadable in a container and readable on the
// Windows host), so the throw is injected at the seam instead and restored immediately.
const realStatSync = fs.statSync;
let broken;
try {
  fs.statSync = (p, ...rest) => {
    if (String(p).replace(/\\/g, '/').includes('tests/acceptance/demo')) throw new Error('injected read failure');
    return realStatSync(p, ...rest);
  };
  broken = capture(ARGS);
} finally { fs.statSync = realStatSync; }
// 4 because these ARGS carry no probe: the verdict is half-proven, and a lint that threw must
// leave it exactly there — the seam is injected on the suite directory, which the probe-side
// comparison also reads, so this arm deliberately runs without one.
check('a lint that throws still leaves the verdict at its own exit code', broken.code === 4,
  String(broken.code));
check('a lint that throws prints `unavailable` and names the reason',
  /brittleness findings: unavailable - .*injected read failure/.test(broken.out), broken.out);
check('a lint that throws NEVER prints a count of 0 — a silent false clean',
  !/brittleness findings:\s*0\b/.test(broken.out));

fs.rmSync(tmpRepo, { recursive: true, force: true });
fs.rmSync(probeRepo, { recursive: true, force: true });
fs.rmSync(guardRepo, { recursive: true, force: true });
fs.rmSync(guardProbe, { recursive: true, force: true });
process.exit(failed);
