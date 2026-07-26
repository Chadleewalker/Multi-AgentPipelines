// Frozen acceptance test — Task C: runner memory export + PIPELINE_BD_CMD seam
// (DESIGN.md §3.6 in-channel, §4.10). Written before implementation; criteria
// C1–C4 of the approved spec. Plain Node, Docker-free: the bd layer is stubbed
// through the PIPELINE_BD_CMD seam this task introduces.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
let failed = 0;
function check(name, cond) {
  console.log(`${cond ? 'ok' : 'FAIL'} - ${name}`);
  if (!cond) failed = 1;
}

// The stub bd: logs its args to $BD_ARGS_LOG, emits $BD_STUB_OUT, exits $BD_STUB_EXIT.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-c-'));
const stub = path.join(tmp, 'bd-stub.sh');
const argsLog = path.join(tmp, 'bd-args.log');
const stubOut = path.join(tmp, 'bd-stdout.txt');
fs.writeFileSync(stub, [
  '#!/bin/sh',
  'printf \'%s\\n\' "$*" >> "$BD_ARGS_LOG"',
  '[ -f "$BD_STUB_OUT" ] && cat "$BD_STUB_OUT"',
  'exit "${BD_STUB_EXIT:-0}"',
  '',
].join('\n'));
fs.chmodSync(stub, 0o755);
process.env.PIPELINE_BD_CMD = stub;
process.env.BD_ARGS_LOG = argsLog;
process.env.BD_STUB_OUT = stubOut;
delete process.env.BD_STUB_EXIT;

const cfg = { targetRepoPath: '/nonexistent-by-design', image: 'unused' };
let memory = null;
try { memory = require(path.join(ROOT, 'runner', 'memory.js')); } catch { /* fails below */ }
check('runner/memory.js is requirable', memory !== null);
check('exportMemory is exported', memory !== null && typeof memory.exportMemory === 'function');

function readMemoryMd(dir) {
  try { return fs.readFileSync(path.join(dir, 'memory.md'), 'utf8'); } catch { return null; }
}
function run(name, dir) {
  fs.mkdirSync(dir, { recursive: true });
  try { return memory.exportMemory(cfg, dir); }
  catch (e) { check(`${name} exportMemory must not throw (threw: ${e.message})`, false); return null; }
}

if (memory && typeof memory.exportMemory === 'function') {
  // C1: two memories -> header + both entries.
  fs.writeFileSync(stubOut, '{"schema_version":1,"k1":"first memory","k2":"second memory"}\n');
  const d1 = path.join(tmp, 'run1');
  const r1 = run('C1', d1);
  const m1 = readMemoryMd(d1);
  check('C1 memory.md written', m1 !== null);
  if (m1 !== null) {
    check('C1 first line is "# Project memory"', m1.split('\n')[0].replace(/\r$/, '') === '# Project memory');
    check('C1 contains k1: first memory', m1.includes('k1: first memory'));
    check('C1 contains k2: second memory', m1.includes('k2: second memory'));
  }
  check('C1 returns ok true', r1 !== null && r1.ok === true);

  // C2: no memories -> the exact marker line.
  fs.writeFileSync(stubOut, '{"schema_version":1}\n');
  const d2 = path.join(tmp, 'run2');
  const r2 = run('C2', d2);
  const m2 = readMemoryMd(d2);
  check('C2 memory.md is the marker line',
    m2 !== null && m2.replace(/\r/g, '').trim() === '(no memories recorded)');
  check('C2 returns ok true', r2 !== null && r2.ok === true);

  // C3: bd failure -> non-fatal, marker written, ok:false with error.
  process.env.BD_STUB_EXIT = '1';
  const d3 = path.join(tmp, 'run3');
  const r3 = run('C3', d3);
  const m3 = readMemoryMd(d3);
  check('C3 memory.md still written with marker',
    m3 !== null && m3.includes('(no memories recorded)'));
  check('C3 returns ok false with non-empty error',
    r3 !== null && r3.ok === false && typeof r3.error === 'string' && r3.error.length > 0);
  delete process.env.BD_STUB_EXIT;
}

// C4: the seam contract in runner/bd.js, plus workspace wiring.
let bdMod = null;
try { bdMod = require(path.join(ROOT, 'runner', 'bd.js')); } catch { /* fails below */ }
check('runner/bd.js is requirable', bdMod !== null);
if (bdMod) {
  fs.writeFileSync(stubOut, '{"schema_version":1}\n');
  fs.writeFileSync(argsLog, '');
  bdMod.bd(cfg, ['memories', '--json']);
  const lines = fs.readFileSync(argsLog, 'utf8').split('\n').filter(Boolean);
  check('C4 seam spawned the stub exactly once', lines.length === 1);
  if (lines.length === 1) {
    check('C4 argv contains memories and --json',
      lines[0].includes('memories') && lines[0].includes('--json'));
    check('C4 argv has no -C prefix and no docker',
      !/(^|\s)-C(\s|$)/.test(lines[0]) && !lines[0].includes('docker'));
  }
}
const ws = fs.readFileSync(path.join(ROOT, 'runner', 'workspace.js'), 'utf8');
check('C4 workspace.js wires exportMemory', ws.includes('exportMemory'));

process.exit(failed);
