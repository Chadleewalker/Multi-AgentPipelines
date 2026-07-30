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
  verdictFor, guardCount, withEmptyControlDir, resolveControl, CONTROL_DIR, main,
} = require('../../scripts/freeze-gate.js');

let failed = 0;
const pass = (n) => console.log(`PASS  ${n}`);
const fail = (n, why) => { console.log(`FAIL  ${n}${why ? ` — ${why}` : ''}`); failed = 1; };
const check = (n, cond, why) => { (cond ? pass : (x) => fail(x, why))(n); return cond; };

const ok = (status) => ({ status, signal: null, stdout: '', stderr: '', error: null });

// --- the decision table -------------------------------------------------------------------

// The verdict that lets a freeze proceed. Note it needs BOTH observations: red alone is not
// enough, which is the whole point of the control run.
let v = verdictFor(ok(1), ok(0));
check('real red + control green = red (gate passes)', v.verdict === 'red' && v.exit === 0,
  `${v.verdict}/${v.exit}`);

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

// --- end to end, through the CLI, with a stubbed verify command ------------------------------

// A stub that reports red exactly when the directory it is given holds files — the behaviour
// of an honest test runner, and the only shape that produces a `red` verdict.
const STUB = `
const fs = require('fs'); const p = process.argv[2];
const mode = process.env.STUB_MODE || 'honest';
if (mode === 'always-green') process.exit(0);
if (mode === 'always-red') process.exit(4);
let n = 0; try { n = fs.readdirSync(p).length; } catch { n = 0; }
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

const ARGS = ['--repo', tmpRepo, '--tests', 'tests/acceptance/demo/'];
check('CLI exits 0 when the tests are genuinely red', runMain(ARGS) === 0);

process.env.STUB_MODE = 'always-green';
check('CLI exits 1 when the tests pass at the fork point', runMain(ARGS) === 1);

process.env.STUB_MODE = 'always-red';
check('CLI exits 2 when red cannot be told from a broken harness', runMain(ARGS) === 2);
delete process.env.STUB_MODE;

check('CLI exits 2 on a missing test directory',
  runMain(['--repo', tmpRepo, '--tests', 'tests/acceptance/nope/']) === 2);
check('CLI exits 2 with no arguments', runMain([]) === 2);
check('CLI exits 2 when the target has no pipeline.config.json',
  runMain(['--repo', path.join(tmpRepo, 'tests'), '--tests', 'acceptance/demo/']) === 2);
check('CLI still exits 0 with --spec supplied', runMain([...ARGS, '--spec', specPath]) === 0);

// The gate must leave nothing behind in the target repo — it runs against a tree that is
// about to be committed and frozen, so a stray directory would land in the freeze.
check('no control directory survives the run',
  fs.readdirSync(tmpRepo).every((e) => !e.startsWith('.freeze-gate-control')),
  fs.readdirSync(tmpRepo).join(', '));

fs.rmSync(tmpRepo, { recursive: true, force: true });
process.exit(failed);
