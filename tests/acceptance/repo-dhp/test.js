// Frozen acceptance test — repo-dhp: a re-runnable, Docker-free suite for
// runner/memory.js (DESIGN.md §3.6, §4.4). Written before implementation, from the
// spec alone; criteria C1–C8 of the approved spec. Plain Node, Docker-free.
//
// Three deliberate choices, all from the planning critic:
//   * C7 checks EXECUTED COMMANDS with comment lines stripped, never bare occurrences
//     of the words. A correct header comment says "Plain Node, Docker-free" and a file
//     documenting its own constraint contains the literal "node --test"; a naive grep
//     would fail correct code and push an agent to delete accurate comments to turn the
//     gate green — shadow-01 exactly.
//   * C1/C6 need an injectable failure, or "exits non-zero when a check fails" is
//     unfalsifiable: a file with zero assertions satisfies the green half. Hence the
//     MEMORY_TEST_EXTRA seam, whose contract is pinned in the spec.
//   * C5 is asserted against the exported predicate's behaviour, not against source
//     text, so it survives any legitimate refactor.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const UNIT = path.join(ROOT, 'tests', 'unit', 'memory.test.js');
const WRAPPER = path.join(ROOT, 'scripts', 'test-runner-memory.sh');
let failed = 0;
function check(name, cond) {
  console.log(`${cond ? 'ok' : 'FAIL'} - ${name}`);
  if (!cond) failed = 1;
}
const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };

// A clean environment for every child: the parent must not be able to steer the suite.
function cleanEnv(extra) {
  const env = { ...process.env, ...(extra || {}) };
  for (const k of ['PIPELINE_BD_CMD', 'BD_ARGS_LOG', 'BD_STUB_OUT', 'BD_STUB_EXIT']) {
    if (!(extra && k in extra)) delete env[k];
  }
  return env;
}

// ---- C8: the suite is discoverable by the sweep's glob -----------------------------
check('C8 scripts/test-runner-memory.sh exists', fs.existsSync(WRAPPER));
check('C8 name matches the scripts/test-*.sh glob',
  /^test-.*\.sh$/.test(path.basename(WRAPPER)));
check('C1 tests/unit/memory.test.js exists', fs.existsSync(UNIT));

// ---- C1: the suite runs green under plain node, with no arguments ------------------
const green = spawnSync(process.execPath, [UNIT], { cwd: ROOT, encoding: 'utf8', timeout: 120000, env: cleanEnv() });
const out = `${green.stdout || ''}${green.stderr || ''}`;
check('C1 unit suite exits 0', green.status === 0);
const okLines = out.split('\n').filter((l) => /^ok\b/.test(l.trim()));
const failLines = out.split('\n').filter((l) => /^FAIL\b/.test(l.trim()));
check('C1 unit suite reports no FAIL lines', failLines.length === 0);
check('C1 unit suite runs at least 12 checks', okLines.length >= 12);

// ---- C2/C3/C4: the coverage contract, by subject named in the check labels ---------
const labels = okLines.join('\n');
check('C2 exportMemory is exercised by name', /exportMemory/.test(labels));
check('C3 fileMemoryNotes is exercised by name', /fileMemoryNotes/.test(labels));
check('C5 the outcome predicate is exercised by name', /shouldFileMemory/.test(labels));
check('C4 the bd seam contract is exercised by name', /seam/i.test(labels));

// ---- C1: the failure half, through the pinned MEMORY_TEST_EXTRA seam ---------------
// Contract: MEMORY_TEST_EXTRA names a module exporting a function that receives the
// suite's own check(name, cond). A fixture failing a check must turn the suite red.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-dhp-'));
const badFixture = path.join(tmp, 'failing-fixture.js');
fs.writeFileSync(badFixture,
  "module.exports = (check) => check('injected failure (acceptance fixture)', false);\n");
const red = spawnSync(process.execPath, [UNIT],
  { cwd: ROOT, encoding: 'utf8', timeout: 120000, env: cleanEnv({ MEMORY_TEST_EXTRA: badFixture }) });
check('C1 an injected failing check turns the suite non-zero', red.status !== 0 && red.status !== null);

const goodFixture = path.join(tmp, 'passing-fixture.js');
fs.writeFileSync(goodFixture,
  "module.exports = (check) => check('injected pass (acceptance fixture)', true);\n");
const stillGreen = spawnSync(process.execPath, [UNIT],
  { cwd: ROOT, encoding: 'utf8', timeout: 120000, env: cleanEnv({ MEMORY_TEST_EXTRA: goodFixture }) });
check('C1 an injected passing check leaves the suite green', stillGreen.status === 0);

// ---- C5: the outcome gate is a testable predicate, and run.js uses it --------------
let memory = null;
try { memory = require(path.join(ROOT, 'runner', 'memory.js')); } catch { /* reported below */ }
check('C5 runner/memory.js is requirable', memory !== null);
check('C5 shouldFileMemory is exported',
  memory !== null && typeof memory.shouldFileMemory === 'function');
if (memory && typeof memory.shouldFileMemory === 'function') {
  for (const s of ['done', 'partial', 'failed', 'stuck']) {
    check(`C5 shouldFileMemory('${s}') is true`, memory.shouldFileMemory(s) === true);
  }
  for (const s of ['tampered', 'paused']) {
    check(`C5 shouldFileMemory('${s}') is false`, memory.shouldFileMemory(s) === false);
  }
  check('C5 an unrecognised status is false', memory.shouldFileMemory('not-a-status') === false);
  check('C5 undefined is false', memory.shouldFileMemory(undefined) === false);
}
const runSrc = read(path.join(ROOT, 'runner', 'run.js')) || '';
const runExec = runSrc.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));
check('C5 run.js calls the predicate', runExec.some((l) => l.includes('shouldFileMemory')));
check('C5 run.js no longer inlines the outcome list',
  !runExec.some((l) => /\[\s*'done'\s*,\s*'partial'\s*,\s*'failed'\s*,\s*'stuck'\s*\]/.test(l)));

// ---- C6: the wrapper propagates status and scrubs the environment ------------------
const wrapGreen = spawnSync('sh', [WRAPPER], { cwd: ROOT, encoding: 'utf8', timeout: 180000, env: cleanEnv() });
const wrapOut = `${wrapGreen.stdout || ''}${wrapGreen.stderr || ''}`;
check('C6 wrapper exits 0 when the suite passes', wrapGreen.status === 0);
check('C6 wrapper prints suite-convention PASS lines', /^PASS\s/m.test(wrapOut));

const wrapRed = spawnSync('sh', [WRAPPER],
  { cwd: ROOT, encoding: 'utf8', timeout: 180000, env: cleanEnv({ MEMORY_TEST_EXTRA: badFixture }) });
check('C6 wrapper propagates a non-zero status', wrapRed.status !== 0 && wrapRed.status !== null);
check('C6 wrapper prints a FAIL line when the suite fails', /^FAIL\s/m.test(`${wrapRed.stdout || ''}${wrapRed.stderr || ''}`));

// A poisoned parent environment must not reach the suite: the wrapper scrubs the bd
// stub variables, so a leaked BD_STUB_EXIT cannot fail every check for an unrelated
// reason. (runner/bd.js gives PIPELINE_BD_CMD absolute precedence over everything.)
const wrapPoisoned = spawnSync('sh', [WRAPPER], {
  cwd: ROOT,
  encoding: 'utf8',
  timeout: 180000,
  env: { ...process.env, BD_STUB_EXIT: '1', BD_ARGS_LOG: path.join(tmp, 'leaked.log'), PIPELINE_BD_CMD: path.join(tmp, 'nonexistent-stub.js') },
});
check('C6 a poisoned parent environment does not reach the suite', wrapPoisoned.status === 0);

// ---- C7: no docker, and no --test on a node invocation, on executed lines ----------
function executedLines(src) {
  return (src || '').split('\n')
    .map((l) => l.replace(/#.*$/, ''))          // strip shell comments
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)) // strip JS comment lines
    .filter((l) => l.trim() !== '');
}
for (const [name, file] of [['unit suite', UNIT], ['wrapper', WRAPPER]]) {
  const lines = executedLines(read(file));
  check(`C7 ${name} runs no docker command`,
    !lines.some((l) => /\bdocker[ \t]+(run|build|exec|network|compose|image|ps)\b/.test(l)));
  check(`C7 ${name} passes no --test flag to node`,
    !lines.some((l) => /\bnode\b[^\n]*--test\b/.test(l)));
}

// The stub must be a .js file run through process.execPath, never a shebang script:
// runner/bd.js spawns PIPELINE_BD_CMD with spawnSync and no shell, and on Windows a
// `#!/bin/sh` file fails with EFTYPE — which would make the suite green in the
// container and red in the host sweep.
const unitLines = executedLines(read(UNIT));
check('C7 the bd stub is invoked through process.execPath',
  unitLines.some((l) => l.includes('process.execPath')));
check('C7 the unit suite writes no shebang stub',
  !unitLines.some((l) => /#!\s*\/bin\/(sh|bash)/.test(l)));

process.exit(failed);
