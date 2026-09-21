#!/usr/bin/env node
// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// FROZEN acceptance suite for repo-inj — the freeze gate proves the GREEN side too.
//
// Written before any implementation exists, from the spec alone, and proven both ways before
// freezing: RED against the fork point, GREEN against a probe. Do not edit during a run —
// everything under tests/acceptance/ is diffed against the fork point and any difference ends
// the task `tampered` (DESIGN.md §4.4).
//
// Section headers name the criterion they serve; every criterion in the issue has one.
//
// Three things this suite deliberately does, each because their absence cost a run before:
//   * It NEVER string-compares `process.cwd()`. On the reference host a temp path can be an
//     8.3 short name and Git Bash and the child disagree on separators and case, so that
//     comparison passes for whoever wrote it and fails for the verifier. Which tree a run
//     happened in is decided by where the stub's MARKER FILE landed.
//   * Its oversized-output stub writes with fs.writeSync, never process.stdout.write followed
//     by process.exit — the async write is truncated by the exit, nothing overflows, and the
//     check would pass against the unchanged implementation it exists to catch.
//   * It runs the gate once with the command NOT stubbed. With the command stubbed the probe
//     tree's contents are irrelevant, so every other check here would pass an implementation
//     that resolves the probe's suite path wrongly under the real runner — the miss
//     change-log row `freeze-gate-red` records.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const GATE = path.join(ROOT, 'scripts', 'freeze-gate.js');

let failed = 0;
function check(name, cond, detail) {
  console.log(`${cond ? 'ok' : 'FAIL'} - ${name}`);
  if (!cond) { failed = 1; if (detail) console.log(`       ${String(detail).slice(0, 300)}`); }
  return cond;
}
function read(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-inj-'));
const q = (p) => `"${String(p).replace(/\\/g, '/')}"`;

// ---- harness -----------------------------------------------------------------------------

let gate = null;
try { gate = require(GATE); } catch (e) { gate = null; }
check('the gate is requirable as a module', gate !== null && typeof gate.main === 'function',
  'scripts/freeze-gate.js must keep exporting main()');

// Capture rather than silence: several criteria are about WHAT the report says, and a
// criterion that only reads an exit code passes vacuously against the current code.
function runGate(args, env) {
  const out = [];
  const o = console.log; const e = console.error;
  const saved = {};
  for (const k of Object.keys(env || {})) { saved[k] = process.env[k]; process.env[k] = env[k]; }
  console.log = (...a) => out.push(a.join(' '));
  console.error = (...a) => out.push(a.join(' '));
  let code;
  try { code = gate.main(args); } catch (err) { code = `threw: ${err.message}`; } finally {
    console.log = o; console.error = e;
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
  return { code, out: out.join('\n') };
}

// A tree the gate can be pointed at. `withSuite` decides whether the acceptance directory is
// present, which is how a probe is made malformed.
function makeTree(name, { withSuite = true, withControl = true, withRunner = false } = {}) {
  const dir = path.join(TMP, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'pipeline.config.json'),
    JSON.stringify({ verifyCommand: 'sh tools/run-acceptance.sh' }));
  if (withSuite) {
    const d = path.join(dir, 'tests', 'acceptance', 'demo');
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'test.js'), 'process.exit(0);\n');
  }
  if (withControl) {
    const c = path.join(dir, 'tests', 'acceptance', '_control');
    fs.mkdirSync(c, { recursive: true });
    fs.writeFileSync(path.join(c, 'control.js'), 'process.exit(0);\n');
  }
  if (withRunner) {
    fs.mkdirSync(path.join(dir, 'tools'), { recursive: true });
    const src = path.join(ROOT, 'tools', 'run-acceptance.sh');
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, 'tools', 'run-acceptance.sh'));
  }
  return dir;
}

// The stub records where it ran by dropping a marker into its own working directory, and what
// it was asked to judge by appending to a log. Both are read afterwards; neither compares a
// path string.
const STUB = `
const fs = require('fs'); const path = require('path');
const arg = process.argv[2] || '';
fs.appendFileSync(process.env.STUB_LOG, JSON.stringify({ arg }) + '\\n');
fs.writeFileSync(path.join(process.cwd(), '.ran-here-' + process.pid + '-' + Math.floor(process.hrtime()[1])), '');
const mode = process.env.STUB_MODE || 'honest';
const isControl = /_control/.test(arg);
if (mode === 'probe-broken' && fs.existsSync(path.join(process.cwd(), '.is-probe'))) process.exit(1);
if (mode === 'probe-suite-red' && fs.existsSync(path.join(process.cwd(), '.is-probe')) && !isControl) process.exit(1);
if (mode === 'always-green') process.exit(0);
if (isControl) process.exit(0);
let n = 0; try { n = fs.readdirSync(arg).length; } catch { n = 0; }
process.exit(n > 0 ? 1 : 0);
`;
const stubPath = path.join(TMP, 'stub.js');
fs.writeFileSync(stubPath, STUB);
const STUB_CMD = `${q(process.execPath)} ${q(stubPath)}`;

function freshLog() {
  const f = path.join(TMP, `log-${Math.random().toString(36).slice(2)}.jsonl`);
  fs.writeFileSync(f, '');
  return f;
}
const logLines = (f) => (read(f) || '').split('\n').filter(Boolean).map((l) => JSON.parse(l));
function markersIn(dir) {
  try { return fs.readdirSync(dir).filter((n) => n.startsWith('.ran-here-')).length; } catch { return 0; }
}
function clearMarkers(dir) {
  try { for (const n of fs.readdirSync(dir)) if (n.startsWith('.ran-here-')) fs.rmSync(path.join(dir, n)); } catch { /* none */ }
}

// ---- C1: --green is parsed; an unusable probe is refused, naming the path -----------------

if (gate) {
  const repo = makeTree('c1-repo');
  const base = ['--repo', repo, '--tests', 'tests/acceptance/demo/'];
  const missing = path.join(TMP, 'no-such-probe-dir');
  const asFile = path.join(TMP, 'probe-is-a-file'); fs.writeFileSync(asFile, 'x');

  for (const [label, probe] of [['a non-existent path', missing], ['a path that is a file', asFile]]) {
    const r = runGate([...base, '--green', probe], { STUB_LOG: freshLog(), FREEZE_GATE_CMD: STUB_CMD });
    check(`C1 ${label} exits 2`, r.code === 2, `got ${r.code}`);
    check(`C1 ${label} is refused NAMING the path`,
      typeof r.out === 'string' && r.out.includes(path.basename(probe)),
      `today --green hits "unexpected argument" and never reads the path — output was: ${r.out.slice(0, 160)}`);
  }
  const empty = runGate([...base, '--green', ''], { STUB_LOG: freshLog(), FREEZE_GATE_CMD: STUB_CMD });
  check('C1 an empty --green value exits 2', empty.code === 2, `got ${empty.code}`);
  const noVal = runGate([...base, '--green'], { STUB_LOG: freshLog(), FREEZE_GATE_CMD: STUB_CMD });
  check('C1 --green with no value exits 2 and says so',
    noVal.code === 2 && /--green/.test(noVal.out), `got ${noVal.code}: ${noVal.out.slice(0, 160)}`);
} else {
  for (const n of ['C1 the gate is unavailable']) check(n, false, 'gate not requirable');
}

// ---- C2: four invocations with --green, two without; identified by marker file -------------

if (gate) {
  const repo = makeTree('c2-repo');
  const probe = makeTree('c2-probe');
  fs.writeFileSync(path.join(probe, '.is-probe'), '');
  const base = ['--repo', repo, '--tests', 'tests/acceptance/demo/'];

  clearMarkers(repo); clearMarkers(probe);
  const log2 = freshLog();
  runGate([...base], { STUB_LOG: log2, FREEZE_GATE_CMD: STUB_CMD });
  check('C2 without --green the verify command is spawned twice', logLines(log2).length === 2,
    `got ${logLines(log2).length}`);

  clearMarkers(repo); clearMarkers(probe);
  const log4 = freshLog();
  runGate([...base, '--green', probe], { STUB_LOG: log4, FREEZE_GATE_CMD: STUB_CMD });
  const lines = logLines(log4);
  check('C2 with --green the verify command is spawned four times', lines.length === 4,
    `got ${lines.length} — suite and control, in each of two trees`);

  const suiteArgs = lines.map((l) => l.arg).filter((a) => /demo/.test(a));
  check('C2 exactly two invocations carry the suite directory', suiteArgs.length === 2,
    suiteArgs.join(' | '));
  check('C2 both carry the SAME repo-relative string, byte for byte',
    suiteArgs.length === 2 && suiteArgs[0] === suiteArgs[1],
    `${suiteArgs[0]} vs ${suiteArgs[1]} — never an absolute path into the probe`);
  check('C2 the two suite runs happened in DIFFERENT trees',
    markersIn(repo) >= 1 && markersIn(probe) >= 1,
    `markers: repo ${markersIn(repo)}, probe ${markersIn(probe)} — identified by where the stub wrote, never by comparing cwd strings`);
}

// ---- C3: the verdict table as a pure exported function -------------------------------------

const ok = (status) => ({ status, error: null, signal: null, stdout: '', stderr: '' });
if (gate && typeof gate.verdictFor === 'function') {
  const V = gate.verdictFor;
  const row = (real, control, probe, probeControl) => V(ok(real), ok(control), 'conventional',
    probe === null ? null : ok(probe), probeControl === null ? null : ok(probeControl));

  check('C3 red + green probe = red, exit 0',
    (() => { const v = row(1, 0, 0, 0); return v && v.verdict === 'red' && v.exit === 0; })(),
    JSON.stringify(row(1, 0, 0, 0)));
  check('C3 red + red probe = unreachable, exit 3',
    (() => { const v = row(1, 0, 1, 0); return v && v.verdict === 'unreachable' && v.exit === 3; })(),
    JSON.stringify(row(1, 0, 1, 0)));
  check('C3 red + no probe = half-proven, exit 4',
    (() => { const v = row(1, 0, null, null); return v && v.verdict === 'half-proven' && v.exit === 4; })(),
    JSON.stringify(row(1, 0, null, null)));
  check('C3 a not-green probe control is indeterminate/2 whatever the probe suite did',
    (() => { const a = row(1, 0, 0, 1); const b = row(1, 0, 1, 1);
      return a && b && a.exit === 2 && b.exit === 2; })(),
    'exit 3 must be unreachable unless the probe control is green');
  check('C3 a green real run stays green/1 whatever the probe says',
    (() => { const v = row(0, 0, 0, 0); return v && v.verdict === 'green' && v.exit === 1; })());
  check('C3 a not-green control stays indeterminate/2 whatever the probe says',
    (() => { const v = row(1, 1, 0, 0); return v && v.exit === 2; })());
  check('C3 the existing `red` token survives (test-freeze-gate.sh greps the report for RED:)',
    (() => { const v = row(1, 0, 0, 0); return v && v.verdict === 'red'; })(),
    'renaming it to discriminating silently stops that grep matching');
} else {
  check('C3 verdictFor is exported', false, 'gate must export verdictFor');
}

// ---- C4: a broken probe is indeterminate, never unreachable --------------------------------
// The pair. A naive implementation answers 3 for both, and only running both tells them apart.

if (gate) {
  const repo = makeTree('c4-repo');
  const probe = makeTree('c4-probe');
  fs.writeFileSync(path.join(probe, '.is-probe'), '');
  const base = ['--repo', repo, '--tests', 'tests/acceptance/demo/', '--green', probe];

  const broken = runGate(base, { STUB_LOG: freshLog(), FREEZE_GATE_CMD: STUB_CMD, STUB_MODE: 'probe-broken' });
  check('C4 a probe whose CONTROL is not green exits 2, never 3', broken.code === 2, `got ${broken.code}`);
  check('C4 that exit-2 detail names the PROBE as the broken side', /probe/i.test(broken.out),
    broken.out.slice(0, 200));

  const suiteRed = runGate(base, { STUB_LOG: freshLog(), FREEZE_GATE_CMD: STUB_CMD, STUB_MODE: 'probe-suite-red' });
  check('C4 a probe with a GREEN control and a red suite exits 3', suiteRed.code === 3, `got ${suiteRed.code}`);
  check('C4 that verdict is named unreachable', /unreachable/i.test(suiteRed.out), suiteRed.out.slice(0, 200));
}

// ---- C5: the output ceiling, proven against the real 1 MiB limit ---------------------------

if (gate) {
  const repo = makeTree('c5-repo');
  const probe = makeTree('c5-probe');
  // fs.writeSync, NOT process.stdout.write + process.exit: the latter's write is async and is
  // truncated by the exit, so nothing overflows and this check would pass against the
  // unchanged implementation it exists to catch.
  const loud = path.join(TMP, 'loud.js');
  fs.writeFileSync(loud, `
const fs = require('fs');
fs.appendFileSync(process.env.STUB_LOG, JSON.stringify({ arg: process.argv[2] || '' }) + '\\n');
const arg = process.argv[2] || '';
if (/_control/.test(arg)) process.exit(0);
if (fs.existsSync(require('path').join(process.cwd(), '.is-probe'))) {
  fs.writeSync(1, 'x'.repeat(2 * 1024 * 1024) + '\\n');
  process.exit(0);
}
process.exit(1);
`);
  fs.writeFileSync(path.join(probe, '.is-probe'), '');
  const r = runGate(['--repo', repo, '--tests', 'tests/acceptance/demo/', '--green', probe],
    { STUB_LOG: freshLog(), FREEZE_GATE_CMD: `${q(process.execPath)} ${q(loud)}` });
  check('C5 a probe printing more than 1 MiB and exiting 0 is read as GREEN, not killed',
    r.code === 0,
    `got ${r.code} — Node's default maxBuffer is 1 MiB and spawnSync KILLS the child on overflow; a passing probe is verbose by definition`);
}

// ---- C6: it works with the REAL runner, not only the stub -----------------------------------

if (gate && fs.existsSync(path.join(ROOT, 'tools', 'run-acceptance.sh'))) {
  const repo = makeTree('c6-repo', { withRunner: true });
  const probeOk = makeTree('c6-probe-ok', { withRunner: true });
  // The probe's suite passes; the fork-point one fails, so the real run is red.
  fs.writeFileSync(path.join(repo, 'tests', 'acceptance', 'demo', 'test.js'), 'process.exit(1);\n');

  const good = runGate(['--repo', repo, '--tests', 'tests/acceptance/demo/', '--green', probeOk],
    { FREEZE_GATE_CMD: '' });
  check('C6 with the REAL runner, a good probe gives exit 0', good.code === 0,
    `got ${good.code}: ${good.out.slice(0, 200)}`);

  const probeNoRunner = makeTree('c6-probe-bad', { withRunner: false });
  const bad = runGate(['--repo', repo, '--tests', 'tests/acceptance/demo/', '--green', probeNoRunner],
    { FREEZE_GATE_CMD: '' });
  // Exit 2 alone is NOT evidence here: today every --green invocation exits 2 on "unexpected
  // argument", so an exit-code-only check passes vacuously against the unchanged gate. The
  // discriminating half is that the refusal is ABOUT the probe.
  check('C6 a probe MISSING the runner script exits 2, not 3',
    bad.code === 2 && /probe/i.test(bad.out),
    `got ${bad.code}: ${bad.out.slice(0, 160)} — a malformed probe must not be reported as unsatisfiable criteria`);
}

// ---- C7: the playbook says what to do, and its own suite enforces it ------------------------

const playbook = read(path.join(ROOT, 'PLANNING.md')) || '';
check('C7 PLANNING.md carries the exit 3 stanza', playbook.includes('exit 3 — unreachable'));
check('C7 PLANNING.md carries the exit 4 stanza', playbook.includes('exit 4 — half-proven'));
check('C7 PLANNING.md shows the --green invocation', /--green/.test(playbook));
check('C7 the half-proven stanza says a no-probe freeze may proceed',
  (() => {
    const i = playbook.indexOf('exit 4 — half-proven');
    if (i < 0) return false;
    return /proceed/i.test(playbook.slice(i, i + 500));
  })(), 'the stanza must state the action, as every other stanza in step 4 does');

const pbSuite = path.join(ROOT, 'scripts', 'test-planning-playbook.sh');
if (fs.existsSync(pbSuite)) {
  const stripped = path.join(TMP, 'playbook-without-stanzas.md');
  fs.writeFileSync(stripped, playbook.split('exit 3 — unreachable').join('exit 3 — REMOVED')
    .split('exit 4 — half-proven').join('exit 4 — REMOVED'));
  const neg = spawnSync('bash', [pbSuite], {
    cwd: ROOT, encoding: 'utf8', timeout: 300000,
    env: { ...process.env, PLAYBOOK_FILE: stripped },
  });
  check('C7 the playbook suite FAILS on a playbook lacking the new stanzas', neg.status !== 0,
    'checked behaviourally through PLAYBOOK_FILE, never by grepping the suite source');
  const pos = spawnSync('bash', [pbSuite], {
    cwd: ROOT, encoding: 'utf8', timeout: 300000,
    env: { ...process.env, PLAYBOOK_FILE: path.join(ROOT, 'PLANNING.md') },
  });
  check('C7 the playbook suite passes on the real playbook', pos.status === 0,
    (pos.stdout || '').split('\n').filter((l) => /^FAIL/.test(l)).slice(0, 3).join(' / '));
}

// ---- C8: both suites assert the new contract, and neither shrinks ---------------------------

const unit = spawnSync(process.execPath, [path.join(ROOT, 'tests', 'unit', 'freeze-gate.test.js')],
  { cwd: ROOT, encoding: 'utf8', timeout: 600000 });
const unitOut = `${unit.stdout || ''}${unit.stderr || ''}`;
const unitPass = unitOut.split(/\r?\n/).filter((l) => /^PASS/.test(l)).length;
check('C8 the unit suite exits 0', unit.status === 0,
  unitOut.split(/\r?\n/).filter((l) => /^FAIL/.test(l)).slice(0, 4).join(' / '));
check('C8 the unit suite has at least 115 PASS lines (100 today)', unitPass >= 115, `got ${unitPass}`);

const shellSuite = read(path.join(ROOT, 'scripts', 'test-freeze-gate.sh')) || '';
check('C8 the shell suite floor rises to at least 110', /-ge\s+1[1-9]\d/.test(shellSuite),
  'the floor is -ge 90 today; a floor that does not move lets the count shrink');
const wrapper = spawnSync('bash', [path.join(ROOT, 'scripts', 'test-freeze-gate.sh')],
  { cwd: ROOT, encoding: 'utf8', timeout: 900000 });
check('C8 the shell suite exits 0', wrapper.status === 0,
  `${wrapper.stdout || ''}`.split(/\r?\n/).filter((l) => /^FAIL/.test(l)).slice(0, 4).join(' / '));

// ---- C9: the documents this changes are changed ----------------------------------------------

const design = read(path.join(ROOT, 'DESIGN.md')) || '';
const diagram = read(path.join(ROOT, 'docs', 'pipeline-diagram.md')) || '';
const changelog = read(path.join(ROOT, 'docs', 'change-log.md')) || '';
// Every string below is chosen to be ABSENT from the tree today, so each check is genuinely
// red at the fork point. The first draft of this section keyed on `unreachable`, which
// DESIGN.md already contains eight times and the change log five, and on a regex for
// "verifyCommand twice" that the backticks around `verifyCommand` defeated — so three of these
// four passed vacuously against the unchanged tree. Verified absent before freezing:
// `half-proven` appears 0 times in DESIGN.md and 0 in docs/change-log.md.
check('C9 DESIGN.md no longer says the gate runs the verify command twice',
  !/twice\s+—\s+once/.test(design),
  'DESIGN.md reads "runs the target\'s `verifyCommand` twice — once …" today');
check('C9 DESIGN.md names the half-proven verdict',
  /half-proven/i.test(design), 'absent today — red until the design doc is amended');
check('C9 the diagram no longer says the verdict is only red, green or indeterminate',
  !/red,\s*green\s*or\s*indeterminate/i.test(diagram));
check('C9 a change-log row records this amendment',
  /half-proven/i.test(changelog), 'absent today');

// ---- C10 [guard]: the old contract survives, and nothing is left behind ----------------------

if (gate) {
  const repo = makeTree('c10-repo');
  const probe = makeTree('c10-probe');
  const base = ['--repo', repo, '--tests', 'tests/acceptance/demo/'];

  check('C10 [guard] green at the fork point still exits 1',
    runGate(base, { STUB_LOG: freshLog(), FREEZE_GATE_CMD: STUB_CMD, STUB_MODE: 'always-green' }).code === 1);
  check('C10 [guard] a missing test directory still exits 2',
    runGate(['--repo', repo, '--tests', 'tests/acceptance/absent/'],
      { STUB_LOG: freshLog(), FREEZE_GATE_CMD: STUB_CMD }).code === 2);
  check('C10 [guard] no arguments still exits 2', runGate([], {}).code === 2);
  // Deliberately WITHOUT --green. A guard must be green at the fork point, and with --green
  // the current gate exits 2 on "unexpected argument" before printing anything at all — so
  // the first draft of this check was red today for a reason that had nothing to do with the
  // lint, which is a guard measuring the wrong thing.
  const rep = runGate([...base], { STUB_LOG: freshLog(), FREEZE_GATE_CMD: STUB_CMD });
  check('C10 [guard] the brittleness lint still reports', /brittleness findings:/i.test(rep.out),
    rep.out.slice(0, 160));
  const leftovers = (d) => { try { return fs.readdirSync(d).filter((n) => n.startsWith('.freeze-gate-control-')); } catch { return []; } };
  check('C10 [guard] no control scratch directory survives in either tree',
    leftovers(repo).length === 0 && leftovers(probe).length === 0,
    `${leftovers(repo).join(',')} | ${leftovers(probe).join(',')}`);
}

// ---- teardown: best effort, never a verdict ---------------------------------------------------
try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 3 }); } catch { /* ignore */ }

process.exit(failed);
