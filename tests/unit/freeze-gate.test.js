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
  brittleFindings, lintSuite,
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

// A suite that could not RUN is not a suite that failed. Conventionally a runner exits 1 for
// failing tests and 2+ for could-not-run: a parse error, a missing import, nothing collected.
// The control cannot catch this -- it proves the harness works on OTHER tests, so a suite whose
// own script fails to load leaves the control perfectly green. Found in anger: a frozen GDScript
// suite with a parse error exited 2 against a green control and this gate called it RED.
v = verdictFor(ok(2), ok(0));
check('exit 2 with a green control is indeterminate, not red', v.verdict === 'indeterminate' && v.exit === 2);
check('the message says could-not-run rather than failed', /could not run|did not execute/i.test(v.headline + v.detail));
check('exit 5 is indeterminate too', verdictFor(ok(5), ok(0)).verdict === 'indeterminate');
check('exit 1 with a green control is still red', verdictFor(ok(1), ok(0)).verdict === 'red');

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
const clean = capture(ARGS);
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

// The exit code is a verdict about red, green and indeterminate that PLANNING.md step 4
// branches on. A lint that can fail a freeze is a gate on spec AUTHORING, whose only defeat is
// rewording until it passes (hard rule 5) — so it is checked in all three arms, with findings
// present in every one. The green and indeterminate arms are the ones that catch an
// `if (findings.length) return 1`: red already exits 0, so there it is invisible.
const arms = [[null, 0], ['always-green', 1], ['always-red', 2]];
let armsHeld = true; let armsFired = true;
for (const [mode, expected] of arms) {
  if (mode) process.env.STUB_MODE = mode; else delete process.env.STUB_MODE;
  const r = capture(ARGS);
  const m = r.out.match(COUNT_LINE);
  if (r.code !== expected) armsHeld = false;
  if (!m || Number(m[1]) < 4) armsFired = false;
}
delete process.env.STUB_MODE;
check('findings never move the exit code, in any of the three verdicts', armsHeld);
check('and the lint is proven to have FIRED in each of those same runs', armsFired);

const loud = capture(ARGS);
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
check('a lint that throws still leaves the verdict at its own exit code', broken.code === 0);
check('a lint that throws prints `unavailable` and names the reason',
  /brittleness findings: unavailable - .*injected read failure/.test(broken.out), broken.out);
check('a lint that throws NEVER prints a count of 0 — a silent false clean',
  !/brittleness findings:\s*0\b/.test(broken.out));

fs.rmSync(tmpRepo, { recursive: true, force: true });
process.exit(failed);
