// Frozen acceptance test — Task D: memoryNotes filing via bd remember (DESIGN.md
// §3.6 out-channel + audit trail, §4.11). Written before implementation; criteria
// D1–D6 of the approved spec. Plain Node, Docker-free: bd is stubbed through the
// PIPELINE_BD_CMD seam Task C introduced.
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-d-'));
const stub = path.join(tmp, 'bd-stub.sh');
const argsLog = path.join(tmp, 'bd-args.log');
fs.writeFileSync(stub, [
  '#!/bin/sh',
  'printf \'%s\\n\' "$*" >> "$BD_ARGS_LOG"',
  'exit "${BD_STUB_EXIT:-0}"',
  '',
].join('\n'));
fs.chmodSync(stub, 0o755);
process.env.PIPELINE_BD_CMD = stub;
process.env.BD_ARGS_LOG = argsLog;
delete process.env.BD_STUB_EXIT;

const cfg = { targetRepoPath: '/nonexistent-by-design', image: 'unused' };
let memory = null;
try { memory = require(path.join(ROOT, 'runner', 'memory.js')); } catch { /* fails below */ }
check('runner/memory.js is requirable', memory !== null);
check('fileMemoryNotes is exported', memory !== null && typeof memory.fileMemoryNotes === 'function');

function logLines() {
  try { return fs.readFileSync(argsLog, 'utf8').split('\n').filter(Boolean); }
  catch { return []; }
}
function file(name, issueId, status) {
  fs.writeFileSync(argsLog, '');
  try { return memory.fileMemoryNotes(cfg, issueId, status); }
  catch (e) { check(`${name} fileMemoryNotes must not throw (threw: ${e.message})`, false); return null; }
}

if (memory && typeof memory.fileMemoryNotes === 'function') {
  // D1: two notes -> two remember calls, keyed by issue id + note index.
  const r1 = file('D1', 'repo-abc', { issueId: 'repo-abc', attempts: [], memoryNotes: ['a', 'b'] });
  const l1 = logLines();
  check('D1 exactly 2 bd invocations', l1.length === 2);
  check('D1 every invocation has remember and --key',
    l1.every((l) => l.includes('remember') && l.includes('--key')));
  check('D1 keys carry the issue id and note index',
    l1.some((l) => l.includes('repo-abc-note-1')) && l1.some((l) => l.includes('repo-abc-note-2')));
  check('D1 returns filed 2, no errors',
    r1 !== null && r1.filed === 2 && Array.isArray(r1.errors) && r1.errors.length === 0);

  // D2: absent and empty memoryNotes are both silent no-ops.
  const r2a = file('D2', 'repo-abc', { issueId: 'repo-abc', attempts: [] });
  check('D2 absent field: zero invocations, filed 0, no errors',
    logLines().length === 0 && r2a !== null && r2a.filed === 0 && r2a.errors.length === 0);
  const r2b = file('D2', 'repo-abc', { issueId: 'repo-abc', attempts: [], memoryNotes: [] });
  check('D2 empty array: zero invocations, filed 0, no errors',
    logLines().length === 0 && r2b !== null && r2b.filed === 0 && r2b.errors.length === 0);

  // D3: host re-enforces the bounds — first 20 notes, first 500 chars.
  const many = Array.from({ length: 22 }, () => 'x'.repeat(600));
  const r3 = file('D3', 'repo-xyz', { issueId: 'repo-xyz', attempts: [], memoryNotes: many });
  const l3 = logLines();
  check('D3 exactly 20 invocations for 22 notes', l3.length === 20);
  check('D3 notes truncated to 500 chars',
    l3.every((l) => l.includes('x'.repeat(500)) && !l.includes('x'.repeat(501))));
  check('D3 returns filed 20', r3 !== null && r3.filed === 20);

  // D4: bd failure is non-fatal and recorded.
  process.env.BD_STUB_EXIT = '1';
  const r4 = file('D4', 'repo-abc', { issueId: 'repo-abc', attempts: [], memoryNotes: ['a'] });
  check('D4 no throw, filed 0, errors non-empty',
    r4 !== null && r4.filed === 0 && Array.isArray(r4.errors) && r4.errors.length > 0);
  delete process.env.BD_STUB_EXIT;
}

// D5: review visibility in the attempt log.
let queue = null;
try { queue = require(path.join(ROOT, 'runner', 'queue.js')); } catch { /* fails below */ }
check('runner/queue.js is requirable', queue !== null);
if (queue) {
  const outcome = { status: 'done', beads: 'closed' };
  const withNotes = queue.attemptNotes('r1', outcome,
    { issueId: 'i', attempts: [], memoryNotes: ['a', 'b'] }).join('\n');
  check('D5 attempt log shows "memory notes: 2"', withNotes.includes('memory notes: 2'));
  const without = queue.attemptNotes('r1', outcome, { issueId: 'i', attempts: [] }).join('\n');
  check('D5 no memory line when field absent', !without.includes('memory notes:'));
}

// D6: run.js wiring.
const runJs = fs.readFileSync(path.join(ROOT, 'runner', 'run.js'), 'utf8');
check('D6 run.js wires fileMemoryNotes', runJs.includes('fileMemoryNotes'));

process.exit(failed);
