#!/usr/bin/env node
// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// FROZEN acceptance suite for repo-i4b — a guard test file that is red at the fork point is a
// stale pin, and the gate says so (verdict stale-guard, exit 5).
//
// Written before any implementation exists, from the spec alone. Do not edit during a run —
// everything under tests/acceptance/ is diffed against the fork point and any difference ends
// the task `tampered` (DESIGN.md §4.4).
//
// NOTE ON THE TOKEN: this file writes fixtures containing the guard token. It never carries
// that token on a comment line of its own first ten lines, because after this task ships the
// gate would read this suite as a guard and refuse it at exit 5.
//
// Section headers name the criterion they serve; every criterion in the issue has one.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const GATE = path.join(ROOT, 'scripts', 'freeze-gate.js');
const TOKEN = '[' + 'guard' + ']';           // assembled so the literal never appears above
const SUBSET = /\.freeze-gate-guards-/;

let failed = 0;
function check(name, cond, detail) {
  console.log(`${cond ? 'ok' : 'FAIL'} - ${name}`);
  if (!cond) { failed = 1; if (detail) console.log(`       ${String(detail).slice(0, 300)}`); }
  return cond;
}
function read(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-i4b-'));
const q = (p) => `"${String(p).replace(/\\/g, '/')}"`;
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

let gate = null;
try { gate = require(GATE); } catch { gate = null; }
check('the gate is requirable as a module', gate !== null && typeof gate.main === 'function');

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

// A repo-shaped tree: config, a demo suite of one ordinary test and (optionally) one guard
// file, a control, and optionally a copy of the real acceptance runner.
function makeTree(name, { guard = true, withRunner = false } = {}) {
  const dir = path.join(TMP, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'pipeline.config.json'),
    JSON.stringify({ verifyCommand: 'sh tools/run-acceptance.sh' }) + '\n');
  const d = path.join(dir, 'tests', 'acceptance', 'demo');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'plain.js'), 'process.exit(1);\n');
  if (guard) fs.writeFileSync(path.join(d, 'guard.js'), `// ${TOKEN} existing behaviour still holds\nprocess.exit(0);\n`);
  const c = path.join(dir, 'tests', 'acceptance', '_control');
  fs.mkdirSync(c, { recursive: true });
  fs.writeFileSync(path.join(c, 'control.js'), 'process.exit(0);\n');
  if (withRunner) {
    fs.mkdirSync(path.join(dir, 'tools'), { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'tools', 'run-acceptance.sh'), path.join(dir, 'tools', 'run-acceptance.sh'));
  }
  return dir;
}
const suiteOf = (tree) => path.join(tree, 'tests', 'acceptance', 'demo');
function makeProbe(name, opts) {
  const p = makeTree(name, opts);
  fs.writeFileSync(path.join(p, '.is-probe'), '');
  return p;
}

// The stub's protocol, as the spec pins it: control -> 0; probe tree -> 0 (probe-red: 1 for
// the suite); a directory whose name matches the subset pattern -> 0 unless guard-red (1) or
// guard-broken (3, stderr line); always-green -> 0; always-red -> 1; suite-only-2 -> 2 for the
// suite itself; any other non-empty directory -> 1. Every spawn logs its argument, the sorted
// listing of that directory and each file's digest, and drops a marker NAMED FROM THE ARGUMENT
// in its cwd — so the spawn that judged the subset can be told from the ones that did not.
const STUB = `
const fs = require('fs'); const path = require('path'); const crypto = require('crypto');
const arg = process.argv[2] || '';
let listing = []; const digests = {};
try { listing = fs.readdirSync(arg).sort(); for (const n of listing) { try { digests[n] = crypto.createHash('sha256').update(fs.readFileSync(path.join(arg, n))).digest('hex'); } catch {} } } catch {}
if (process.env.STUB_LOG) fs.appendFileSync(process.env.STUB_LOG, JSON.stringify({ arg, listing, digests }) + '\\n');
try { fs.writeFileSync(path.join(process.cwd(), '.ran-here-' + arg.replace(/[^A-Za-z0-9._-]/g, '_')), arg); } catch {}
const mode = process.env.STUB_MODE || 'honest';
const isControl = /_control/.test(arg);
const isSubset = /\\.freeze-gate-guards-/.test(arg);
const inProbe = fs.existsSync(path.join(process.cwd(), '.is-probe'));
if (mode === 'always-red') process.exit(1);
if (mode === 'always-green') process.exit(0);
if (isControl) process.exit(0);
if (isSubset) {
  if (mode === 'guard-red') { process.stderr.write('guard assertion failed\\n'); process.exit(1); }
  if (mode === 'guard-broken') { process.stderr.write('injected guard failure\\n'); process.exit(3); }
  process.exit(0);
}
if (inProbe) process.exit(mode === 'probe-red' ? 1 : 0);
if (mode === 'suite-only-2') process.exit(2);
process.exit(listing.length > 0 ? 1 : 0);
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
const markers = (dir) => { try { return fs.readdirSync(dir).filter((n) => n.startsWith('.ran-here-')); } catch { return []; } };
const leftovers = (tree) => { try { return fs.readdirSync(path.join(tree, 'tests', 'acceptance')).filter((n) => SUBSET.test(n)); } catch { return []; } };
function run(tree, extra, env) {
  return runGate(['--repo', tree, '--tests', 'tests/acceptance/demo/', ...(extra || [])], { FREEZE_GATE_CMD: STUB_CMD, ...(env || {}) });
}

// ---- A1: a guard file declares itself, and only a test file can ----------------------------

if (gate && typeof gate.guardFiles === 'function') {
  const d = path.join(TMP, 'a1-suite');
  fs.mkdirSync(path.join(d, 'nested'), { recursive: true });
  const nine = [
    ['a.js', `'use strict';\n// ${TOKEN} on line two\nprocess.exit(0);\n`],
    ['b.sh', `#!/bin/sh\n#\n#\n#\n#\n#\n#\n#\n#\n# ${TOKEN.toUpperCase()} on line ten\nexit 0\n`],
    ['c.js', `${'//\n'.repeat(10)}// ${TOKEN} on line eleven\n`],
    ['d.js', `'use strict';\nconst G = '${TOKEN}';\nprocess.exit(0);\n`],
    ['README.md', `${TOKEN} described in prose\n`],
    ['e.png', Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(`// ${TOKEN}\n`)])],
    ['f.js', Buffer.concat([Buffer.from('// \0 nul here\n'), Buffer.from(`// ${TOKEN}\n`)])],
    ['nested/g.js', `// ${TOKEN} nested\n`],
    ['h.js', 'process.exit(0);\n'],
  ];
  for (const [n, body] of nine) fs.writeFileSync(path.join(d, n), body);
  const found = gate.guardFiles(d);
  check('A1 the scanner finds exactly a.js and b.sh (comment line, first ten lines, top level, readable extension)',
    Array.isArray(found) && JSON.stringify(found) === JSON.stringify(['a.js', 'b.sh']), JSON.stringify(found));
  fs.rmSync(path.join(d, 'a.js')); fs.rmSync(path.join(d, 'b.sh'));
  let empty = null; let threw = false;
  try { empty = gate.guardFiles(d); } catch { threw = true; }
  check('A1 a suite with no guard file yields [] rather than throwing', !threw && Array.isArray(empty) && empty.length === 0);
} else {
  check('A1 the gate exports guardFiles(dir)', false, 'the guard-file scanner must be exported');
}

// ---- A2: the pure verdict table gains one row --------------------------------------------------

const ok = (status) => ({ status, error: null, signal: null, stdout: '', stderr: '' });
if (gate && typeof gate.verdictFor === 'function') {
  const V = gate.verdictFor;
  const G = (real, control, probe, probeControl, guard) => V(ok(real), ok(control), 'conventional',
    probe === null ? null : ok(probe), probeControl === null ? null : ok(probeControl),
    guard === undefined ? undefined : guard === null ? null : (typeof guard === 'object' ? guard : ok(guard)));
  const is = (v, verdict, exit) => v && v.verdict === verdict && v.exit === exit;

  check('A2 red, no probe, guard red = stale-guard/5', is(G(1, 0, null, null, 1), 'stale-guard', 5), JSON.stringify(G(1, 0, null, null, 1)));
  check('A2 red, green probe, guard red = stale-guard/5 (beats red)', is(G(1, 0, 0, 0, 1), 'stale-guard', 5));
  check('A2 red, red probe, guard red = stale-guard/5 (beats unreachable)', is(G(1, 0, 1, 0, 1), 'stale-guard', 5));
  check('A2 a green fork point stays green/1 whatever the guard did', is(G(0, 0, null, null, 1), 'green', 1));
  check('A2 a red control stays indeterminate/2 whatever the guard did', is(G(1, 1, null, null, 1), 'indeterminate', 2));
  check('A2 a fork point exiting 2 stays indeterminate/2 whatever the guard did', is(G(2, 0, null, null, 1), 'indeterminate', 2));
  for (const [label, g] of [['exit 2', ok(2)], ['null status', ok(null)], ['signal', { ...ok(null), signal: 'SIGTERM' }], ['spawn error', { ...ok(null), error: 'ENOENT' }]]) {
    const v = G(1, 0, null, null, g);
    check(`A2 a guard run that could not run (${label}) is indeterminate/2 naming the guard side`,
      is(v, 'indeterminate', 2) && /guard/i.test(v.headline), JSON.stringify(v));
  }
  const rows = [[1, 0, 0, 0], [0, 0, null, null], [1, 1, null, null], [2, 0, null, null], [1, 0, 1, 0], [1, 0, null, null], [1, 0, 1, 1]];
  const same = (a, b) => a && b && a.verdict === b.verdict && a.exit === b.exit;
  check('A2 the seven existing rows are identical with guard null, with guard exit 0, and with five arguments',
    rows.every(([r, c, p, pc]) => {
      const five = V(ok(r), ok(c), 'conventional', p === null ? null : ok(p), pc === null ? null : ok(pc));
      return same(five, G(r, c, p, pc, null)) && same(five, G(r, c, p, pc, 0));
    }));
  const sweep = [];
  for (const r of [0, 1, 2]) for (const c of [0, 1]) for (const [p, pc] of [[null, null], [0, 0], [1, 0], [1, 1], [2, 0]]) for (const g of [null, 0, 1, 2]) sweep.push(G(r, c, p, pc, g));
  check('A2 within the sweep every exit 5 is stale-guard and every stale-guard is exit 5',
    sweep.every((v) => v && ((v.exit === 5) === (v.verdict === 'stale-guard'))));
  check('A2 a SUITE exiting 5 is still indeterminate — the gate\'s 5 is not the runner\'s',
    is(V(ok(5), ok(0)), 'indeterminate', 2));
} else {
  check('A2 verdictFor is exported', false);
}

// ---- A3: the guard subset is a real third spawn over exactly the guard files -----------------

if (gate) {
  const repo = makeTree('a3-repo');
  const probe = makeProbe('a3-probe');
  const guardDigest = sha(path.join(suiteOf(repo), 'guard.js'));

  const l3 = freshLog();
  const r3 = run(repo, [], { STUB_LOG: l3 });
  const lines3 = logLines(l3);
  check('A3 without --green a suite with one guard file is THREE spawns', lines3.length === 3, `${lines3.length} (exit ${r3.code})`);
  const l5 = freshLog();
  run(repo, ['--green', probe], { STUB_LOG: l5 });
  const lines5 = logLines(l5);
  check('A3 with --green it is FIVE', lines5.length === 5, `${lines5.length}`);
  const subset = lines5.filter((l) => SUBSET.test(l.arg));
  check('A3 exactly one spawn judged the guard subset', subset.length === 1, subset.map((s) => s.arg).join(' | '));
  const s = subset[0] || { arg: '', listing: [], digests: {} };
  check('A3 the subset directory holds exactly guard.js', JSON.stringify(s.listing) === JSON.stringify(['guard.js']), JSON.stringify(s.listing));
  check('A3 ...byte-identical to the fork point\'s guard.js', s.digests['guard.js'] === guardDigest);
  check('A3 the subset path is a repo-relative POSIX sibling of the suite',
    /^tests\/acceptance\/\.freeze-gate-guards-[^/]+\/?$/.test(s.arg), s.arg);
  const marker = '.ran-here-' + s.arg.replace(/[^A-Za-z0-9._-]/g, '_');
  check('A3 the marker named from the subset argument landed in the repo tree, not the probe',
    markers(repo).includes(marker) && !markers(probe).includes(marker));
  check('A3 no subset directory is left behind in either tree', leftovers(repo).length === 0 && leftovers(probe).length === 0);

  const bare = makeTree('a3-bare', { guard: false });
  const bareProbe = makeProbe('a3-bare-probe', { guard: false });
  const l2 = freshLog(); run(bare, [], { STUB_LOG: l2 });
  const l4 = freshLog(); run(bare, ['--green', bareProbe], { STUB_LOG: l4 });
  check('A3 with no guard file the counts are two and four again', logLines(l2).length === 2 && logLines(l4).length === 4,
    `${logLines(l2).length} / ${logLines(l4).length}`);
} else {
  check('A3 the gate is unavailable', false);
}

// ---- A4: a red guard is exit 5 and the report names it; a green guard changes nothing ---------

if (gate) {
  const repo = makeTree('a4-repo');
  const probe = makeProbe('a4-probe');
  const red = run(repo, [], { STUB_MODE: 'guard-red' });
  check('A4 guard-red without --green exits 5', red.code === 5, `got ${red.code}`);
  check('A4 ...prints STALE-GUARD:', /^STALE-GUARD:/m.test(red.out));
  check('A4 ...prints the guard run\'s exit status', /guard run\s+exit\s+1/.test(red.out));
  check('A4 ...names guard.js', red.out.includes('guard.js'));
  check('A4 ...and carries the subset\'s stderr tail', red.out.includes('guard assertion failed'));
  const lr = freshLog();
  const redProbe = run(repo, ['--green', probe], { STUB_MODE: 'guard-red', STUB_LOG: lr });
  check('A4 guard-red WITH --green still exits 5', redProbe.code === 5, `got ${redProbe.code}`);
  check('A4 ...and the probe is short-circuited: three spawns, not five', logLines(lr).length === 3, `${logLines(lr).length}`);
  const dflt = run(repo, []);
  check('A4 a green guard without --green is half-proven/4', dflt.code === 4, `got ${dflt.code}`);
  check('A4 ...with the guard run reported green', /guard run\s+exit\s+0/.test(dflt.out));
  check('A4 a green guard with --green is red/0', run(repo, ['--green', probe]).code === 0);
  check('A4 probe-red with a green guard is unreachable/3', run(repo, ['--green', probe], { STUB_MODE: 'probe-red' }).code === 3);
  check('A4 every run prints the guard-file count', /^guard files:\s*1\b/m.test(dflt.out) && /^guard files:\s*1\b/m.test(red.out));
  const bare = makeTree('a4-bare', { guard: false });
  const b = run(bare, []);
  check('A4 a suite with no guard file prints guard files: 0 and no guard run line',
    /^guard files:\s*0\b/m.test(b.out) && !/guard run/.test(b.out));
} else {
  check('A4 the gate is unavailable', false);
}

// ---- A5: the subset never runs when the fork point is not red-on-green ------------------------

if (gate) {
  const repo = makeTree('a5-repo');
  for (const [mode, code] of [['always-green', 1], ['always-red', 2], ['suite-only-2', 2]]) {
    const l = freshLog();
    const r = run(repo, [], { STUB_MODE: mode, STUB_LOG: l });
    check(`A5 ${mode} exits ${code} with two spawns and no STALE-GUARD`,
      r.code === code && logLines(l).length === 2 && !/STALE-GUARD/.test(r.out), `got ${r.code}, ${logLines(l).length} spawn(s)`);
    if (mode === 'always-green') check('A5 ...and says the guard run was not run', /guard run\s+not run/.test(r.out));
  }
  const missing = runGate(['--repo', repo, '--tests', 'tests/acceptance/nope/'], { FREEZE_GATE_CMD: STUB_CMD });
  check('A5 a missing test directory is still exit 2', missing.code === 2, `got ${missing.code}`);
  check('A5 no arguments is still exit 2', runGate([], { FREEZE_GATE_CMD: STUB_CMD }).code === 2);
} else {
  check('A5 the gate is unavailable', false);
}

// ---- A6: a guard subset that cannot run is indeterminate, naming the guard side ----------------

if (gate) {
  const repo = makeTree('a6-repo');
  const broken = run(repo, [], { STUB_MODE: 'guard-broken' });
  check('A6 guard-broken exits 2', broken.code === 2, `got ${broken.code}`);
  check('A6 ...as INDETERMINATE', /^INDETERMINATE:/m.test(broken.out));
  check('A6 ...naming the guard side in the headline',
    (broken.out.split('\n').find((l) => /^INDETERMINATE:/.test(l)) || '').match(/guard/i) !== null);
  check('A6 ...with the subset\'s stderr included', broken.out.includes('injected guard failure'));
  check('A6 ...and never STALE-GUARD', !/STALE-GUARD/.test(broken.out));
} else {
  check('A6 the gate is unavailable', false);
}

// ---- A7: with the real runner, not the stub — one pair, never proven as halves ------------------

if (gate) {
  const tree = makeTree('a7-real', { withRunner: true });
  fs.writeFileSync(path.join(suiteOf(tree), 'guard.js'), [
    `// ${TOKEN} resolves the tree root the way every frozen suite does`,
    "const fs = require('fs'); const path = require('path');",
    "process.exit(fs.existsSync(path.resolve(__dirname, '..', '..', '..', 'pipeline.config.json')) ? 0 : 1);",
    '',
  ].join('\n'));
  const green = runGate(['--repo', tree, '--tests', 'tests/acceptance/demo/'], { FREEZE_GATE_CMD: '' });
  fs.writeFileSync(path.join(suiteOf(tree), 'guard.js'), `// ${TOKEN} now stale\nprocess.exit(1);\n`);
  const stale = runGate(['--repo', tree, '--tests', 'tests/acceptance/demo/'], { FREEZE_GATE_CMD: '' });
  check('A7 real runner: a guard that resolves the tree root and passes leaves the verdict half-proven/4',
    green.code === 4, `got ${green.code}: ${green.out.slice(-300)}`);
  check('A7 real runner: the same tree with the guard exiting 1 is stale-guard/5 naming guard.js',
    stale.code === 5 && stale.out.includes('guard.js'), `got ${stale.code}: ${stale.out.slice(-300)}`);
} else {
  check('A7 the gate is unavailable', false);
}

// ---- A8: the documents change ------------------------------------------------------------------

const design = read(path.join(ROOT, 'DESIGN.md')) || '';
const at = design.indexOf('The gate\'s table, as it now stands');
check('A8 DESIGN.md has stale-guard within 2000 characters after the gate\'s table', at >= 0 && design.slice(at, at + 2000).includes('stale-guard'));
const planning = read(path.join(ROOT, 'PLANNING.md')) || '';
const pat = planning.indexOf('exit 5 — stale-guard');
check('A8 PLANNING.md step 4 has the exit 5 — stale-guard stanza', pat >= 0);
check('A8 ...followed within 500 characters by "never a pass"', pat >= 0 && /never a pass/i.test(planning.slice(pat, pat + 500)));
check('A8 docs/pipeline-diagram.md names stale-guard', (read(path.join(ROOT, 'docs', 'pipeline-diagram.md')) || '').includes('stale-guard'));
check('A8 docs/change-log.md names stale-guard in a repo-i4b row',
  /\|\s*repo-i4b\s*\|[^\n]*stale-guard/.test(read(path.join(ROOT, 'docs', 'change-log.md')) || ''));
{
  const pb = path.join(ROOT, 'scripts', 'test-planning-playbook.sh');
  const real = spawnSync('bash', [pb], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } });
  check('A8 the playbook suite passes on the real PLANNING.md', real.status === 0);
  const copy = path.join(TMP, 'PLANNING-without-stanza.md');
  fs.writeFileSync(copy, planning.replace(/exit 5 — stale-guard/g, 'exit 5 — removed'));
  const without = spawnSync('bash', [pb], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '', PLAYBOOK_FILE: copy } });
  check('A8 ...and fails through PLAYBOOK_FILE on a copy with the stanza removed', pat >= 0 && without.status !== 0);
}
{
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tests', 'unit', 'freeze-gate.test.js')], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } });
  const passes = (r.stdout || '').split('\n').filter((l) => /^PASS /.test(l)).length;
  check('A8 tests/unit/freeze-gate.test.js exits 0 and counts more than the fork point\'s 170', r.status === 0 && passes > 170, `${r.status} / ${passes}`);
  const floor = /-ge\s+(\d+)/.exec(read(path.join(ROOT, 'scripts', 'test-freeze-gate.sh')) || '');
  check('A8 scripts/test-freeze-gate.sh\'s PASS floor is raised to at least 170', !!floor && Number(floor[1]) >= 170, floor && floor[1]);
}

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* temp */ }
process.exit(failed);
