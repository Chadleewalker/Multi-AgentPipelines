#!/usr/bin/env node
// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// FROZEN acceptance suite for repo-erq — the freeze gate leaves a receipt.
//
// Written before any implementation exists, from the spec alone. Do not edit during a run —
// everything under tests/acceptance/ is diffed against the fork point and any difference ends
// the task `tampered` (DESIGN.md §4.4).
//
// Section headers name the criterion they serve; every criterion in the issue has one.
//
// What this suite is careful about, each because it has cost a run before:
//   * The hash is proven by RECOMPUTING it from git, never by trusting the receipt: a receipt
//     that is present, well-formed and wrong is the failure this repo has a rule about.
//   * The CRLF fixture writes core.autocrlf into the fixture's OWN .git/config and points
//     GIT_CONFIG_GLOBAL at an empty file, so neither the host's global config nor the
//     container's absence of one decides the answer.
//   * The verify command is a `.js` stub run through process.execPath — never a `#!/bin/sh`
//     script, which spawnSync fails with EFTYPE on the Windows host.
//   * A failed receipt WRITE is provoked portably: `.freeze-gate.json` is made a directory, so
//     writing the file fails on every platform without relying on chmod.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const GATE = path.join(ROOT, 'scripts', 'freeze-gate.js');
const HASH_MOD = path.join(ROOT, 'runner', 'suite-hash.js');
const SUITE_REL = 'tests/acceptance/demo';
const RECEIPT = '.freeze-gate.json';

let failed = 0;
function check(name, cond, detail) {
  console.log(`${cond ? 'ok' : 'FAIL'} - ${name}`);
  if (!cond) { failed = 1; if (detail) console.log(`       ${String(detail).slice(0, 300)}`); }
  return cond;
}
function read(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } }
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-erq-'));
const q = (p) => `"${String(p).replace(/\\/g, '/')}"`;

// ---- git, with the environment pinned -------------------------------------------------------
// Identity and gpgsign so a container with neither can commit; GIT_CONFIG_GLOBAL at an empty
// file so the host's global core.autocrlf cannot reach any fixture. NO per-call -c overrides:
// the fixtures decide their own line-ending policy in their own .git/config.
const EMPTY_GLOBAL = path.join(TMP, 'empty-gitconfig');
fs.writeFileSync(EMPTY_GLOBAL, '');
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'frozen', GIT_AUTHOR_EMAIL: 'frozen@test.local',
  GIT_COMMITTER_NAME: 'frozen', GIT_COMMITTER_EMAIL: 'frozen@test.local',
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: EMPTY_GLOBAL,
};
function git(cwd, args) {
  return spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', env: GIT_ENV });
}
const gitOut = (cwd, args) => (git(cwd, args).stdout || '').trim();

// ---- harness ---------------------------------------------------------------------------------

let gate = null;
try { gate = require(GATE); } catch { gate = null; }
check('the gate is requirable as a module', gate !== null && typeof gate.main === 'function');

let hashMod = null;
try { hashMod = require(HASH_MOD); } catch { hashMod = null; }
check('runner/suite-hash.js exists and exports suiteHash',
  hashMod !== null && typeof hashMod.suiteHash === 'function',
  'the hash formula must be one exported function both the gate and the dispatch gate import');

// Capture rather than silence: several criteria are about WHAT the report says.
function runGate(args, env) {
  const out = [];
  const errs = [];
  const o = console.log; const e = console.error;
  const saved = {};
  for (const k of Object.keys(env || {})) { saved[k] = process.env[k]; process.env[k] = env[k]; }
  console.log = (...a) => out.push(a.join(' '));
  console.error = (...a) => { errs.push(a.join(' ')); out.push(a.join(' ')); };
  let code;
  try { code = gate.main(args); } catch (err) { code = `threw: ${err.message}`; } finally {
    console.log = o; console.error = e;
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
  return { code, out: out.join('\n'), err: errs.join('\n') };
}

// A repo-shaped tree that is a real git repository with one commit, or (git:false) a plain
// directory. `crlf` writes the test file with \r\n and sets core.autocrlf=true in the
// fixture's own config; otherwise autocrlf is false there.
function makeRepo(name, { git: isGit = true, crlf = false, withControl = true } = {}) {
  const dir = path.join(TMP, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'pipeline.config.json'),
    JSON.stringify({ verifyCommand: 'sh tools/run-acceptance.sh' }) + '\n');
  const suite = path.join(dir, 'tests', 'acceptance', 'demo');
  fs.mkdirSync(suite, { recursive: true });
  const nl = crlf ? '\r\n' : '\n';
  fs.writeFileSync(path.join(suite, 'test.js'), `// demo${nl}process.exit(1);${nl}`);
  fs.writeFileSync(path.join(suite, 'helper.txt'), `one${nl}two${nl}`);
  if (withControl) {
    const c = path.join(dir, 'tests', 'acceptance', '_control');
    fs.mkdirSync(c, { recursive: true });
    fs.writeFileSync(path.join(c, 'control.js'), 'process.exit(0);\n');
  }
  if (isGit) {
    git(dir, ['init', '-q', '--initial-branch', 'main', '.']);
    git(dir, ['config', 'core.autocrlf', crlf ? 'true' : 'false']);
    if (!crlf) git(dir, ['config', 'core.eol', 'lf']);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-qm', 'fixture']);
  }
  return dir;
}
const suiteDir = (repo) => path.join(repo, 'tests', 'acceptance', 'demo');
const receiptPath = (repo) => path.join(suiteDir(repo), RECEIPT);

// The independent computation of the hash — from git, by the formula in the spec.
function entriesFromWorkingTree(repo) {
  const listed = gitOut(repo, ['ls-files', '--cached', '--others', '--exclude-standard', '--', SUITE_REL])
    .split(/\r?\n/).filter(Boolean);
  const entries = [];
  for (const rootRel of listed) {
    const rel = rootRel.slice(SUITE_REL.length + 1);
    if (rel === RECEIPT) continue;
    const blob = gitOut(repo, ['hash-object', '--path', rootRel, path.join(repo, rootRel)]);
    entries.push({ path: rel, blob });
  }
  return entries;
}
function entriesFromHead(repo) {
  const lines = gitOut(repo, ['ls-tree', '-r', 'HEAD', '--', SUITE_REL]).split(/\r?\n/).filter(Boolean);
  const entries = [];
  for (const line of lines) {
    const m = /^\d+ blob ([0-9a-f]{40})\t(.+)$/.exec(line);
    if (!m) continue;
    const rel = m[2].slice(SUITE_REL.length + 1);
    if (rel === RECEIPT) continue;
    entries.push({ path: rel, blob: m[1] });
  }
  return entries;
}
function formulaHash(entries) {
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return crypto.createHash('sha256').update(sorted.map((e) => `${e.path}\0${e.blob}\n`).join('')).digest('hex');
}
function rawBytesHash(repo) {
  // What a byte-hashing implementation would produce — used only to prove the CRLF pair
  // discriminates.
  const files = fs.readdirSync(suiteDir(repo)).filter((n) => n !== RECEIPT).sort();
  return crypto.createHash('sha256').update(files.map((n) =>
    `${n}\0${crypto.createHash('sha256').update(fs.readFileSync(path.join(suiteDir(repo), n))).digest('hex')}\n`).join('')).digest('hex');
}

// The stub verify command. honest: control -> 0, probe tree -> 0, any other non-empty dir -> 1.
// Modes vary one thing each. `self-writing` drops a file INTO the suite directory it was asked
// to judge, which is what a real suite that writes beside itself does.
const STUB = `
const fs = require('fs'); const path = require('path');
const arg = process.argv[2] || '';
if (process.env.STUB_LOG) fs.appendFileSync(process.env.STUB_LOG, JSON.stringify({ arg }) + '\\n');
const mode = process.env.STUB_MODE || 'honest';
const isControl = /_control/.test(arg);
const inProbe = fs.existsSync(path.join(process.cwd(), '.is-probe'));
if (mode === 'always-red') process.exit(1);
if (mode === 'always-green') process.exit(0);
if (isControl) process.exit(0);
if (inProbe) process.exit(mode === 'probe-red' ? 1 : 0);
if (mode === 'self-writing') { try { fs.writeFileSync(path.join(process.cwd(), arg, 'side.out'), 'written by the suite\\n'); } catch {} }
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
const logLines = (f) => (read(f) || '').split('\n').filter(Boolean);

function makeProbe(name) {
  const probe = makeRepo(name, { git: false });
  fs.writeFileSync(path.join(probe, '.is-probe'), '');
  return probe;
}
const specPath = path.join(TMP, 'spec.md');
fs.writeFileSync(specPath, '# spec\n\n- A1 does the thing\n- A2 [guard] old behaviour holds\n- A3 [guard] other old behaviour holds\n');

const KEYS = ['brittleness', 'gateHead', 'gateVersion', 'guards', 'probeSupplied', 'suiteHash', 'verdict', 'writtenAt'];

// ---- A1: the receipt is written on a proceeding verdict, and only then ----------------------

if (gate) {
  const repo = makeRepo('a1-repo');
  const probe = makeProbe('a1-probe');
  const base = ['--repo', repo, '--tests', SUITE_REL + '/'];

  const withProbe = runGate([...base, '--green', probe, '--spec', specPath], { FREEZE_GATE_CMD: STUB_CMD });
  check('A1 red with a green probe exits 0', withProbe.code === 0, `got ${withProbe.code}: ${withProbe.out.slice(-200)}`);
  const r1 = readJson(receiptPath(repo));
  check('A1 the receipt exists after exit 0 and is JSON', r1 !== null && typeof r1 === 'object');
  check('A1 the receipt carries exactly the eight keys',
    r1 !== null && JSON.stringify(Object.keys(r1).sort()) === JSON.stringify(KEYS),
    r1 && Object.keys(r1).sort().join(','));
  check('A1 gateVersion is the integer 1', r1 !== null && r1.gateVersion === 1);
  check('A1 verdict is "red" and matches the printed verdict',
    r1 !== null && r1.verdict === 'red' && /^RED:/m.test(withProbe.out));
  check('A1 probeSupplied is true when --green was given', r1 !== null && r1.probeSupplied === true);
  check('A1 suiteHash is 64 lowercase hex', r1 !== null && /^[0-9a-f]{64}$/.test(String(r1.suiteHash)));
  check('A1 gateHead is the fixture repository\'s HEAD',
    r1 !== null && r1.gateHead === gitOut(repo, ['rev-parse', 'HEAD']) && /^[0-9a-f]{40}$/.test(String(r1.gateHead)));
  check('A1 guards counts the [guard] lines of --spec (2)', r1 !== null && r1.guards === 2, r1 && String(r1.guards));
  check('A1 brittleness is an integer count', r1 !== null && Number.isInteger(r1.brittleness));
  check('A1 writtenAt parses as a date', r1 !== null && !Number.isNaN(Date.parse(r1.writtenAt)));

  fs.rmSync(receiptPath(repo), { force: true });
  const noProbe = runGate(base, { FREEZE_GATE_CMD: STUB_CMD });
  check('A1 red with no probe exits 4', noProbe.code === 4, `got ${noProbe.code}`);
  const r2 = readJson(receiptPath(repo));
  check('A1 the receipt exists after exit 4', r2 !== null);
  check('A1 verdict is "half-proven" and probeSupplied is false',
    r2 !== null && r2.verdict === 'half-proven' && r2.probeSupplied === false);
  check('A1 guards is null without --spec, never 0', r2 !== null && r2.guards === null, r2 && String(r2.guards));

  // The failing verdicts write nothing and leave a pre-existing receipt byte-identical.
  for (const [mode, expect, label] of [['always-green', 1, 'green'], ['always-red', 2, 'indeterminate'], ['probe-red', 3, 'unreachable']]) {
    fs.writeFileSync(receiptPath(repo), 'SENTINEL');
    const r = runGate([...base, '--green', probe], { FREEZE_GATE_CMD: STUB_CMD, STUB_MODE: mode });
    check(`A1 ${label} still exits ${expect}`, r.code === expect, `got ${r.code}`);
    check(`A1 ${label} leaves an existing receipt byte-identical`, read(receiptPath(repo)) === 'SENTINEL');
  }
  fs.rmSync(receiptPath(repo), { force: true });

  // Not a git repository: refused before any run.
  const plain = makeRepo('a1-plain', { git: false });
  const log = freshLog();
  const notGit = runGate(['--repo', plain, '--tests', SUITE_REL + '/'], { FREEZE_GATE_CMD: STUB_CMD, STUB_LOG: log });
  check('A1 a --repo that is not a git repository exits 2', notGit.code === 2, `got ${notGit.code}`);
  check('A1 ...before any verify run', logLines(log).length === 0, `${logLines(log).length} run(s)`);
  check('A1 ...and no receipt is written', !fs.existsSync(receiptPath(plain)));

  // A receipt write that fails: the receipt path is a DIRECTORY, so the write cannot succeed.
  const blocked = makeRepo('a1-blocked');
  fs.mkdirSync(receiptPath(blocked));
  const failedWrite = runGate(['--repo', blocked, '--tests', SUITE_REL + '/'], { FREEZE_GATE_CMD: STUB_CMD });
  check('A1 a receipt write that fails exits 2', failedWrite.code === 2, `got ${failedWrite.code}`);
  check('A1 ...and stderr names the receipt path', failedWrite.err.includes(RECEIPT),
    failedWrite.err.slice(0, 200));
} else {
  check('A1 the gate is unavailable', false);
}

// ---- A2: the hash is over git blob ids, excludes the receipt, and is reproduced independently

if (gate) {
  const repo = makeRepo('a2-repo');
  const probe = makeProbe('a2-probe');
  const base = ['--repo', repo, '--tests', SUITE_REL + '/', '--green', probe];

  const first = runGate(base, { FREEZE_GATE_CMD: STUB_CMD });
  const h1 = (readJson(receiptPath(repo)) || {}).suiteHash;
  const expected = formulaHash(entriesFromWorkingTree(repo));
  check('A2 the receipt\'s hash equals the formula recomputed from git in this test',
    first.code === 0 && h1 === expected, `receipt ${h1} vs formula ${expected}`);
  check('A2 ...and equals runner/suite-hash.js over the same entries',
    hashMod !== null && h1 === hashMod.suiteHash(entriesFromWorkingTree(repo)));

  const second = runGate(base, { FREEZE_GATE_CMD: STUB_CMD });
  const h2 = (readJson(receiptPath(repo)) || {}).suiteHash;
  check('A2 a second run, with the first receipt present, produces the same hash (the receipt is excluded)',
    second.code === 0 && typeof h1 === 'string' && h1 === h2, `${h1} vs ${h2}`);

  fs.appendFileSync(path.join(suiteDir(repo), 'test.js'), '// one more byte\n');
  runGate(base, { FREEZE_GATE_CMD: STUB_CMD });
  const h3 = (readJson(receiptPath(repo)) || {}).suiteHash;
  check('A2 editing one test file changes the hash', h3 !== undefined && h3 !== h1);

  // THE CRLF PAIR. The fixture commits \r\n through autocrlf=true, so the blob is LF while the
  // working copy is CRLF. Blob-id hashing matches the commit; byte hashing does not.
  const crlf = makeRepo('a2-crlf', { crlf: true });
  const testBlob = gitOut(crlf, ['ls-tree', 'HEAD', '--', SUITE_REL + '/test.js']).split(/\s+/)[2];
  const blobBody = gitOut(crlf, ['cat-file', '-p', testBlob]);
  check('A2 CRLF fixture: the committed blob carries no \\r', !!testBlob && !/\r/.test(git(crlf, ['cat-file', '-p', testBlob]).stdout));
  check('A2 CRLF fixture: the working copy DOES carry \\r', /\r\n/.test(fs.readFileSync(path.join(suiteDir(crlf), 'test.js'), 'utf8')));
  const probe2 = makeProbe('a2-crlf-probe');
  const cr = runGate(['--repo', crlf, '--tests', SUITE_REL + '/', '--green', probe2], { FREEZE_GATE_CMD: STUB_CMD });
  const hc = (readJson(receiptPath(crlf)) || {}).suiteHash;
  const fromHead = formulaHash(entriesFromHead(crlf));
  check('A2 CRLF fixture: the receipt\'s hash equals the hash of the COMMIT\'s blob ids',
    cr.code === 0 && hc === fromHead, `receipt ${hc} vs HEAD ${fromHead} (blob body: ${JSON.stringify(blobBody).slice(0, 40)})`);
  check('A2 CRLF fixture: a raw-byte hash would have differed (the pair discriminates)',
    hc !== undefined && rawBytesHash(crlf) !== hc);

  // An ignored file in the suite, and a suite that writes beside itself when run: neither
  // reaches the hash, so the receipt still matches the committed tree.
  const noisy = makeRepo('a2-noisy');
  fs.writeFileSync(path.join(noisy, '.gitignore'), '*.tmp\n');
  git(noisy, ['add', '-A']); git(noisy, ['commit', '-qm', 'ignore tmp']);
  fs.writeFileSync(path.join(suiteDir(noisy), 'scratch.tmp'), 'ignored\n');
  // The probe is a copy of the tree, scratch file included, so the pre-run suite comparison
  // (which reads the disk, not git) sees the same files on both sides.
  const probe3 = makeProbe('a2-noisy-probe');
  fs.writeFileSync(path.join(suiteDir(probe3), 'scratch.tmp'), 'ignored\n');
  const nz = runGate(['--repo', noisy, '--tests', SUITE_REL + '/', '--green', probe3], { FREEZE_GATE_CMD: STUB_CMD, STUB_MODE: 'self-writing' });
  check('A2 noisy fixture: the suite wrote beside itself during the run', fs.existsSync(path.join(suiteDir(noisy), 'side.out')));
  const hn = (readJson(receiptPath(noisy)) || {}).suiteHash;
  check('A2 noisy fixture: the receipt still matches the committed tree — ignored and run-written files never enter the hash',
    nz.code === 0 && hn === formulaHash(entriesFromHead(noisy)), `receipt ${hn} vs HEAD ${formulaHash(entriesFromHead(noisy))}`);

  const src = read(GATE) || '';
  check('A2 scripts/freeze-gate.js requires runner/suite-hash', /require\(['"][^'"]*suite-hash(\.js)?['"]\)/.test(src));
} else {
  check('A2 the gate is unavailable', false);
}

// ---- A3: the probe gets no receipt, and a probe lacking one is not "missing a file" ----------

if (gate) {
  const repo = makeRepo('a3-repo');
  const probe = makeProbe('a3-probe');
  const base = ['--repo', repo, '--tests', SUITE_REL + '/', '--green', probe];
  const before = rawBytesHash(probe);
  const first = runGate(base, { FREEZE_GATE_CMD: STUB_CMD });
  check('A3 the first run passes', first.code === 0, `got ${first.code}`);
  check('A3 the probe\'s suite has no receipt after a --green run', !fs.existsSync(receiptPath(probe)));
  check('A3 the probe\'s suite digest is unchanged by the run', rawBytesHash(probe) === before);
  check('A3 the fork point\'s suite DOES have one', fs.existsSync(receiptPath(repo)));
  // Now the fork point carries a receipt and the probe does not: compareSuites must not call
  // the receipt an absent file, or every re-run would exit 2.
  const again = runGate(base, { FREEZE_GATE_CMD: STUB_CMD });
  check('A3 a re-run with the receipt present on the fork side and absent in the probe exits 0, not 2',
    again.code === 0, `got ${again.code}: ${again.out.slice(0, 200)}`);
  if (typeof gate.compareSuites === 'function') {
    const diff = gate.compareSuites(suiteDir(repo), suiteDir(probe));
    check('A3 compareSuites does not list the receipt as absent', !(diff.absent || []).includes(RECEIPT), JSON.stringify(diff));
  } else {
    check('A3 compareSuites is exported', false);
  }
} else {
  check('A3 the gate is unavailable', false);
}

// ---- A4: the documents say the receipt is part of the freeze ---------------------------------

const planning = read(path.join(ROOT, 'PLANNING.md')) || '';
const step6 = (() => {
  const a = planning.indexOf('### 6. Freeze');
  const b = planning.indexOf('### 7.', a + 1);
  return a >= 0 && b > a ? planning.slice(a, b) : '';
})();
check('A4 PLANNING.md step 6 names .freeze-gate.json', step6.includes(RECEIPT));
check('A4 ONBOARDING.md names .freeze-gate.json', (read(path.join(ROOT, 'ONBOARDING.md')) || '').includes(RECEIPT));
check('A4 DESIGN.md 3.2 names .freeze-gate.json', (read(path.join(ROOT, 'DESIGN.md')) || '').includes(RECEIPT));
check('A4 docs/change-log.md has a row for repo-erq', /\|\s*repo-erq\s*\|/.test(read(path.join(ROOT, 'docs', 'change-log.md')) || ''));
for (const s of ['test-changelog.sh', 'test-sanitize.sh']) {
  const r = spawnSync('bash', [path.join(ROOT, 'scripts', s)], { cwd: ROOT, encoding: 'utf8' });
  check(`A4 scripts/${s} exits 0`, r.status === 0, (r.stdout || '').split('\n').filter((l) => /FAIL/.test(l)).slice(0, 3).join(' | '));
}
{
  // Re-runnable coverage grows: the unit suite still passes and counts more checks than the
  // fork point's 170.
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tests', 'unit', 'freeze-gate.test.js')], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } });
  const passes = (r.stdout || '').split('\n').filter((l) => /^PASS /.test(l)).length;
  check('A4 tests/unit/freeze-gate.test.js exits 0', r.status === 0);
  check('A4 ...and counts more than the fork point\'s 170 PASS lines', passes > 170, `${passes}`);
}

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* temp */ }
process.exit(failed);
