// Frozen acceptance test — repo-0ay: the sweep counts assertions in both of the repo's
// vocabularies. Written before implementation, from the spec alone; criteria S1–S5.
// Plain Node, Docker-free — a task container cannot run Docker.
//
// THE DEFECT. `scripts/test-all.sh` builds its ASSERTS column with `grep -c '^PASS[[:space:]]'`,
// but this repo has two assertion vocabularies: the shell suites print `PASS`/`FAIL` lines, and
// the Node acceptance tests and `tests/unit/` suites print `ok - ` / `FAIL - ` lines. A suite in
// the second vocabulary therefore reports the count of its WRAPPER's summary lines rather than its
// own assertions — measured on the 2026-07-31 sweep, `test-sweep-hygiene` reported 3.
//
// WHAT THIS FILE PINS, since the spec left it open on purpose. The column counts assertions that
// PASSED, not assertions attempted, because that is what `^PASS` counts today and changing the
// semantics would silently move every existing suite's number. So a log with 7 `ok - ` and 2
// `FAIL - ` lines reports 7.
//
// Never `load`/`require` a path the task has not written yet without checking it exists first: on
// a missing file `require` throws, the runner reads that as a broken harness rather than as red,
// and the freeze gate would refuse the suite forever instead of reporting a failure.

'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..', '..');
const COUNTER = path.join(REPO, 'scripts', 'sweep-assertions.js');
const TEST_ALL = path.join(REPO, 'scripts', 'test-all.sh');

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log(`ok - ${msg}`); }
  else { fail++; console.log(`FAIL - ${msg}`); }
}

function counter() {
  if (!fs.existsSync(COUNTER)) {
    ok(false, `S1 ${path.relative(REPO, COUNTER)} must exist`);
    return null;
  }
  try { return require(COUNTER); } catch (e) {
    ok(false, `S1 sweep-assertions.js must be requirable (${e.message})`);
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// S1 — a pure counter over both vocabularies, and over a log carrying both.
// ---------------------------------------------------------------------------------------------

const SHELL_LOG = [
  'ok     docker is running',
  'PASS  the network came up',
  'PASS  the proxy answered',
  'FAIL  the allowlist let something through',
  'PASS  teardown removed what it made',
].join('\n');

const NODE_LOG = [
  'ok - A1 the bound fired',
  'ok - A2 the failure named the timeout',
  'FAIL - A3 the default was wrong',
  'ok - A4 every call site is built from the builder',
].join('\n');

// A shell wrapper around a Node suite: the wrapper prints its own summary AND the suite's
// assertions ride along in the same log. The honest answer is one total, never the sum.
const BOTH_LOG = [
  'ok - L1 the checker sees the tree',
  'ok - L2 removing one entry surfaces exactly that literal',
  'ok - L3 the exemptions are component-scoped',
  'PASS  sweep-hygiene: all checks passed',
].join('\n');

function s1() {
  const m = counter();
  if (m === null) return;
  ok(typeof m.countAssertions === 'function',
    'S1 sweep-assertions.js exports countAssertions(logText)');
  if (typeof m.countAssertions !== 'function') return;

  const shell = m.countAssertions(SHELL_LOG);
  ok(shell && shell.count === 3,
    `S1 a PASS/FAIL log counts its passes (got ${shell && shell.count}, expected 3)`);

  const node = m.countAssertions(NODE_LOG);
  ok(node && node.count === 3,
    `S1 an "ok - "/"FAIL - " log counts its passes (got ${node && node.count}, expected 3) — `
    + 'this is the vocabulary the sweep is blind to today');

  const both = m.countAssertions(BOTH_LOG);
  ok(both && both.count === 3,
    `S1 a log carrying BOTH reports one honest total, not the sum (got ${both && both.count}, `
    + 'expected 3 — a wrapper summary line is not a fourth assertion)');
}

// ---------------------------------------------------------------------------------------------
// S2 — "none found" is distinguishable from a genuine zero.
// ---------------------------------------------------------------------------------------------

function s2() {
  const m = counter();
  if (m === null || typeof m.countAssertions !== 'function') return;

  const none = m.countAssertions('Godot Engine v4.7.1\nsome chatter\nand nothing countable\n');
  const zero = m.countAssertions('FAIL  the only assertion failed\n');

  ok(none && none.count !== zero.count || (none && none.found === false),
    'S2 a log with no countable assertion lines is distinguishable from a log whose assertions '
    + 'all failed — 0 and "could not tell" are different, and this repo has been bitten by that '
    + 'difference before');
  ok(none && none.found === false,
    'S2 …and it says so explicitly rather than leaving the caller to infer it from a 0');
  ok(zero && zero.found === true && zero.count === 0,
    'S2 a genuine zero is found:true, count:0');
}

// ---------------------------------------------------------------------------------------------
// S3 — the semantics are pinned: passes, not attempts.
// ---------------------------------------------------------------------------------------------

function s3() {
  const m = counter();
  if (m === null || typeof m.countAssertions !== 'function') return;

  const lines = [];
  for (let i = 0; i < 7; i++) lines.push(`ok - assertion ${i}`);
  for (let i = 0; i < 2; i++) lines.push(`FAIL - assertion f${i}`);
  const r = m.countAssertions(lines.join('\n'));

  ok(r && r.count === 7,
    `S3 7 passing and 2 failing assertions report 7 (got ${r && r.count}) — the column counts `
    + 'PASSES, because that is what `^PASS` counts today and changing the semantics would '
    + 'silently move every existing suite\'s number');
}

// ---------------------------------------------------------------------------------------------
// S4 [guard] — the RESULT column and the exit code are untouched.
// ---------------------------------------------------------------------------------------------

function makeRoot(suiteExit) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-0ay-'));
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'runs'), { recursive: true });
  fs.copyFileSync(TEST_ALL, path.join(root, 'scripts', 'test-all.sh'));
  for (const f of ['sweep-reclaim.js', 'sweep-assertions.js']) {
    const src = path.join(REPO, 'scripts', f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(root, 'scripts', f));
  }
  fs.writeFileSync(path.join(root, 'scripts', 'test-stub.sh'),
    `#!/bin/sh\necho "ok - the stub asserted something"\necho "PASS  stub summary"\nexit ${suiteExit}\n`);
  fs.writeFileSync(path.join(root, 'scripts', 'fake-docker.sh'),
    '#!/bin/sh\ncase "$1" in\n  ps) echo "" ;;\n  network) echo "" ;;\nesac\nexit 0\n');
  for (const f of ['test-all.sh', 'test-stub.sh', 'fake-docker.sh']) {
    try { fs.chmodSync(path.join(root, 'scripts', f), 0o755); } catch (_) {}
  }
  return root;
}

function runSweep(root) {
  return spawnSync('bash', [path.join(root, 'scripts', 'test-all.sh'), '--skip', 'e2e'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120000,
    env: Object.assign({}, process.env, {
      SWEEP_DOCKER: path.join(root, 'scripts', 'fake-docker.sh'),
    }),
  });
}

function s4() {
  for (const kase of [{ exit: 1, want: 'FAIL' }, { exit: 0, want: 'PASS' }]) {
    const root = makeRoot(kase.exit);
    const r = runSweep(root);
    ok(r.status === kase.exit,
      `S4 [guard] a stub exiting ${kase.exit} leaves the sweep exiting ${kase.exit} `
      + `(got ${r.status}) — this task changes a count, never a verdict`);
    const out = (r.stdout || '') + (r.stderr || '');
    ok(out.includes(kase.want),
      `S4 [guard] …and the RESULT column still reads ${kase.want}`);
  }
}

// ---------------------------------------------------------------------------------------------
// S5 [guard] — every docker call still routes through the seam.
// ---------------------------------------------------------------------------------------------

function s5() {
  const src = fs.readFileSync(TEST_ALL, 'utf8').split('\n')
    .filter((l) => !/^\s*#/.test(l)).join('\n');
  const bare = src.split('\n')
    .filter((l) => /(^|[^_])\bdocker\s/.test(l) && !/SWEEP_DOCKER/.test(l));
  ok(bare.length === 0,
    'S5 [guard] every docker call in test-all.sh still goes through $SWEEP_DOCKER, prechecks '
    + `included, or the suite cannot run where the verifier runs it (offending: ${
      bare.map((l) => l.trim().slice(0, 40)).join(' | ') || 'none'})`);
}

s1();
s2();
s3();
s4();
s5();

console.log(`\nrepo-0ay: ${pass} passed, ${fail} failed`);
if (fail > 0) { console.log('repo-0ay: FAILED'); process.exit(1); }
console.log('repo-0ay: all checks passed');
