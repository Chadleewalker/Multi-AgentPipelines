// Unit suite for runner/memory.js — both DESIGN.md §3.6 memory channels plus the
// outcome gate on the Out channel. Re-runnable: the sweep picks it up through
// scripts/test-runner-memory.sh (repo-dhp). Its coverage was extracted from two frozen
// per-task acceptance directories (tests/acceptance/repo-eyn/, tests/acceptance/repo-4gp/),
// which are artifacts of finished tasks and never run again.
//
// Plain Node, no test framework, no Docker, no network, no real bd binary: run it as
// `node tests/unit/memory.test.js` from the repo root. One line per check —
// `ok - <label>` / `FAIL - <label>` — and a non-zero exit if any check failed, matching
// tests/acceptance/README.md.
//
// THE STUB IS A .js FILE RUN THROUGH process.execPath, NOT A SHELL SCRIPT. runner/bd.js
// spawns PIPELINE_BD_CMD with spawnSync and no shell; on the Windows host a `/bin/sh`
// script spawned that way returns status null with EFTYPE, so every stubbed bd call
// would report failure — exportMemory would write "(no memories recorded)" and
// fileMemoryNotes would file nothing. That suite is green in the container and red in
// the host sweep, which is the worst of both. The node binary behaves identically on
// both platforms, so PIPELINE_BD_CMD is process.execPath and the stub is preloaded into
// it with NODE_OPTIONS=--require (quoted: the repo or the temp dir may contain spaces).
// Node runs preloads before it resolves the main module, so the stub does its work and
// exits before node ever looks for the bd argument it was handed as a script path.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const memory = require(path.join(ROOT, 'runner', 'memory.js'));

let failed = 0;
function check(name, cond) {
  console.log(`${cond ? 'ok' : 'FAIL'} - ${name}`);
  if (!cond) failed = 1;
}
// assert is the comparison engine; check() is the reporting convention.
function deepEq(actual, expected) {
  try { assert.deepStrictEqual(actual, expected); return true; } catch { return false; }
}

// ---- the bd seam ------------------------------------------------------------------
// The stub records each invocation's argv as one JSON line, emits the contents of
// BD_STUB_OUT on stdout, and exits BD_STUB_EXIT. node resolves argv[1] against the cwd
// before the preload runs (it is where the main module would be), so the first argument
// is restored to its basename — everything after it is verbatim.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'unit-memory-'));
const stub = path.join(tmp, 'bd-stub.js');
const argsLog = path.join(tmp, 'bd-args.log');
const stubOut = path.join(tmp, 'bd-stdout.txt');

fs.writeFileSync(stub, [
  "'use strict';",
  "const sfs = require('fs');",
  "const spath = require('path');",
  'const argv = process.argv.slice(1);',
  'if (argv.length) argv[0] = spath.basename(argv[0]);',
  'sfs.appendFileSync(process.env.BD_ARGS_LOG, JSON.stringify(argv) + "\\n");',
  'let body = "";',
  'try { body = sfs.readFileSync(process.env.BD_STUB_OUT, "utf8"); } catch { body = ""; }',
  // fs.writeSync, not process.stdout.write: process.exit can truncate an async pipe write.
  'if (body) sfs.writeSync(1, body);',
  'process.exit(Number(process.env.BD_STUB_EXIT || 0));',
  '',
].join('\n'));
fs.writeFileSync(stubOut, '');
fs.writeFileSync(argsLog, '');

process.env.PIPELINE_BD_CMD = process.execPath;
// Forward slashes, not the native separator. NODE_OPTIONS strips the surrounding quotes
// and then treats backslashes as escapes, so `--require "C:\tmp\bd-stub.js"` resolves to
// a mangled path, the preload never loads, node exits 1, and EVERY stubbed bd call looks
// like a bd failure — 11 of these checks went red on the Windows host while passing in
// the Linux container, where the path has no backslashes to mangle. Node accepts forward
// slashes on Windows; the quotes stay, because the temp path may contain spaces.
process.env.NODE_OPTIONS = `--require "${stub.split(path.sep).join('/')}"`;
process.env.BD_ARGS_LOG = argsLog;
process.env.BD_STUB_OUT = stubOut;
delete process.env.BD_STUB_EXIT;

const cfg = { targetRepoPath: '/nonexistent-by-design', image: 'unused' };

function calls() {
  try {
    return fs.readFileSync(argsLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}
function stubEmits(text) { fs.writeFileSync(stubOut, text); }
function stubFails(yes) {
  if (yes) process.env.BD_STUB_EXIT = '1'; else delete process.env.BD_STUB_EXIT;
}

// ---- the In channel: exportMemory --------------------------------------------------
function exportInto(label, dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(argsLog, '');
  try { return memory.exportMemory(cfg, dir); }
  catch (e) { check(`${label}: exportMemory threw (${e.message})`, false); return null; }
}
const readMd = (dir) => {
  try { return fs.readFileSync(path.join(dir, 'memory.md'), 'utf8').replace(/\r/g, ''); }
  catch { return null; }
};

stubEmits('{"schema_version":1,"k1":"first memory","k2":"second memory"}\n');
const two = path.join(tmp, 'export-two');
const rTwo = exportInto('two memories', two);
const mdTwo = readMd(two);
check('exportMemory returns ok with count 2 for two memories',
  rTwo !== null && rTwo.ok === true && rTwo.count === 2);
check('exportMemory writes the header and one line per memory',
  mdTwo !== null && mdTwo.split('\n')[0] === '# Project memory'
  && mdTwo.includes('- k1: first memory') && mdTwo.includes('- k2: second memory'));

// The seam contract, asserted on the argv of the call just made. This is what catches a
// regression in runner/bd.js re-introducing the host `bd` probe or the Docker fallback:
// either one changes the argv, and the Docker-free suites stop being Docker-free.
const seamCalls = calls();
check('bd seam: exportMemory spawns the stub exactly once', seamCalls.length === 1);
check('bd seam: the argv is exactly [memories, --json]',
  seamCalls.length === 1 && deepEq(seamCalls[0], ['memories', '--json']));
check('bd seam: no -C prefix reaches the argv (no host bd probe)',
  seamCalls.every((a) => !a.includes('-C')));
check('bd seam: no docker anywhere in the argv (no container fallback)',
  seamCalls.every((a) => !a.some((x) => /docker/i.test(x))));

stubEmits('{"schema_version":1}\n');
const none = path.join(tmp, 'export-none');
const rNone = exportInto('zero memories', none);
check('exportMemory returns ok with count 0 when there are no memories',
  rNone !== null && rNone.ok === true && rNone.count === 0);
check('exportMemory writes "(no memories recorded)" for zero memories',
  readMd(none) !== null && readMd(none).trim() === '(no memories recorded)');

stubFails(true);
const broken = path.join(tmp, 'export-bd-failed');
const rBroken = exportInto('bd failure', broken);
check('exportMemory treats a bd failure as non-fatal: ok false with an error, no throw',
  rBroken !== null && rBroken.ok === false
  && typeof rBroken.error === 'string' && rBroken.error.length > 0);
check('exportMemory still writes the marker file when bd fails',
  readMd(broken) !== null && readMd(broken).includes('(no memories recorded)'));
stubFails(false);

stubEmits('not json at all\n');
const garbage = path.join(tmp, 'export-garbage');
const rGarbage = exportInto('unparseable bd output', garbage);
check('exportMemory is non-fatal when bd emits unparseable JSON',
  rGarbage !== null && rGarbage.ok === false
  && readMd(garbage) !== null && readMd(garbage).includes('(no memories recorded)'));

// ---- the Out channel: fileMemoryNotes ----------------------------------------------
stubEmits('');
function fileNotes(label, issueId, status) {
  fs.writeFileSync(argsLog, '');
  try { return memory.fileMemoryNotes(cfg, issueId, status); }
  catch (e) { check(`${label}: fileMemoryNotes threw (${e.message})`, false); return null; }
}

const rPair = fileNotes('two notes', 'repo-abc', { issueId: 'repo-abc', memoryNotes: ['a', 'b'] });
const pairCalls = calls();
check('fileMemoryNotes files one bd remember per note',
  pairCalls.length === 2 && rPair !== null && rPair.filed === 2 && rPair.errors.length === 0);
check('fileMemoryNotes keys notes <issueId>-note-<n>, 1-based',
  deepEq(pairCalls[0], ['remember', 'a', '--key', 'repo-abc-note-1'])
  && deepEq(pairCalls[1], ['remember', 'b', '--key', 'repo-abc-note-2']));

const long = 'y'.repeat(600);
const rMany = fileNotes('22 long notes', 'repo-xyz',
  { issueId: 'repo-xyz', memoryNotes: Array.from({ length: 22 }, () => long) });
const manyCalls = calls();
check('fileMemoryNotes truncates 22 notes to exactly 20 bd invocations',
  manyCalls.length === 20 && rMany !== null && rMany.filed === 20);
check('fileMemoryNotes stores exactly the first 500 characters of a long note',
  manyCalls.length === 20
  && manyCalls.every((a) => a[1] === long.slice(0, 500) && a[1].length === 500)
  && !manyCalls.some((a) => a[1].includes('y'.repeat(501))));

const rAbsent = fileNotes('absent field', 'repo-abc', { issueId: 'repo-abc', attempts: [] });
check('fileMemoryNotes with absent memoryNotes makes zero bd invocations',
  calls().length === 0 && rAbsent !== null && rAbsent.filed === 0 && rAbsent.errors.length === 0);
const rEmpty = fileNotes('empty array', 'repo-abc', { issueId: 'repo-abc', memoryNotes: [] });
check('fileMemoryNotes with an empty memoryNotes array makes zero bd invocations',
  calls().length === 0 && rEmpty !== null && rEmpty.filed === 0 && rEmpty.errors.length === 0);

const rBlank = fileNotes('blank note', 'repo-abc', { issueId: 'repo-abc', memoryNotes: ['   ', 'real'] });
check('fileMemoryNotes skips a blank note and keeps the surviving note\'s index',
  calls().length === 1 && rBlank !== null && rBlank.filed === 1
  && deepEq(calls()[0], ['remember', 'real', '--key', 'repo-abc-note-2']));

stubFails(true);
const rFailed = fileNotes('bd failure', 'repo-abc', { issueId: 'repo-abc', memoryNotes: ['a'] });
check('fileMemoryNotes records a bd failure in errors instead of throwing',
  rFailed !== null && rFailed.filed === 0 && Array.isArray(rFailed.errors)
  && rFailed.errors.length === 1 && /repo-abc-note-1/.test(rFailed.errors[0]));
stubFails(false);

// ---- the outcome gate on the Out channel (§3.6) ------------------------------------
check('shouldFileMemory is exported by runner/memory.js',
  typeof memory.shouldFileMemory === 'function');
for (const status of ['done', 'partial', 'failed', 'stuck']) {
  check(`shouldFileMemory('${status}') is true — a terminal outcome may seed memory`,
    memory.shouldFileMemory(status) === true);
}
check('shouldFileMemory(\'tampered\') is false — a failed trust check seeds nothing',
  memory.shouldFileMemory('tampered') === false);
check('shouldFileMemory(\'paused\') is false — not a terminal outcome',
  memory.shouldFileMemory('paused') === false);
check('shouldFileMemory fails closed on an unrecognised status',
  memory.shouldFileMemory('not-a-status') === false);
check('shouldFileMemory fails closed on undefined',
  memory.shouldFileMemory(undefined) === false);

const runExec = fs.readFileSync(path.join(ROOT, 'runner', 'run.js'), 'utf8')
  .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));
check('run.js gates the memory out-channel on shouldFileMemory',
  runExec.some((l) => l.includes('shouldFileMemory')));
check('run.js no longer inlines the outcome list',
  !runExec.some((l) => /\[\s*'done'\s*,\s*'partial'\s*,\s*'failed'\s*,\s*'stuck'\s*\]/.test(l)));

// ---- failure-injection seam --------------------------------------------------------
// Without this, "the suite exits non-zero when a check fails" is unfalsifiable — a file
// with no assertions at all satisfies the green half. MEMORY_TEST_EXTRA names a module
// exporting `(check) => {...}`, called with this suite's own check().
if (process.env.MEMORY_TEST_EXTRA) {
  const extraPath = path.resolve(process.env.MEMORY_TEST_EXTRA);
  let extra = null;
  try { extra = require(extraPath); }
  catch (e) { check(`MEMORY_TEST_EXTRA ${extraPath} could not be loaded (${e.message})`, false); }
  if (extra !== null) {
    if (typeof extra !== 'function') {
      check(`MEMORY_TEST_EXTRA ${extraPath} must export a single function`, false);
    } else {
      extra(check);
    }
  }
}

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp dir, best effort */ }
process.exit(failed);
