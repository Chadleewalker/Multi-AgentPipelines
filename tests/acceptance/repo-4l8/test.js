// Frozen acceptance test — repo-4l8: the runner skips epics when draining the ready
// queue (DESIGN.md §3.1, §4.12). Written before implementation, from the spec alone;
// criteria F1–F8. Plain Node, Docker-free.
//
// Three things this file gets right on purpose, each from a planning critique:
//
//   * THE FIXTURE IS BUILT TO FAIL A WRONG FIX. The epic sits third of four in both
//     input and sorted order — not at an edge, where a positional slice/splice would
//     pass without any type check — and shares its priority with a kept task. The input
//     is unsorted on BOTH axes, because Array#sort is stable in Node >= 11: a fixture
//     already in FIFO order passes even if the created_at tie-break were deleted.
//   * THE bd STUB IS A .js FILE run through process.execPath, never a shebang script.
//     runner/bd.js spawns PIPELINE_BD_CMD with spawnSync and no shell, and on Windows a
//     /bin/sh stub fails with EFTYPE — which is how repo-dhp shipped a suite that was
//     green in the container and red in the host sweep. NODE_OPTIONS carries forward
//     slashes for the same reason.
//   * F6 ASSERTS A FUNCTION, NOT A LOG. run.js:121 is only reached after loadToken and
//     the Docker preflight, and --dry-run returns before the task loop, so no test in
//     this container can ever execute it. queueSummary() is the testable surface; the
//     Docker suite scripts/test-runner-queue.sh covers actual emission.
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
const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };

// ---- the bd stub: prints whatever BD_STUB_OUT holds, exits 0 -----------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-4l8-'));
const stub = path.join(tmp, 'bd-stub.js');
const stubOut = path.join(tmp, 'bd-stdout.json');
fs.writeFileSync(stub, [
  "'use strict';",
  "const sfs = require('fs');",
  "let body = '';",
  "try { body = sfs.readFileSync(process.env.BD_STUB_OUT, 'utf8'); } catch { body = '[]'; }",
  'sfs.writeSync(1, body);',
  'process.exit(0);',
  '',
].join('\n'));
fs.writeFileSync(stubOut, '[]');

process.env.PIPELINE_BD_CMD = process.execPath;
process.env.NODE_OPTIONS = `--require "${stub.split(path.sep).join('/')}"`;
process.env.BD_STUB_OUT = stubOut;

const cfg = { targetRepoPath: '/nonexistent-by-design', image: 'unused' };
let queue = null;
try { queue = require(path.join(ROOT, 'runner', 'queue.js')); } catch { /* reported below */ }
check('runner/queue.js is requirable', queue !== null);
const readyQueue = (queue && queue.readyQueue) ? queue.readyQueue : () => ({ ok: false, error: 'not loaded' });

function withQueue(entries) {
  fs.writeFileSync(stubOut, JSON.stringify(entries));
  return readyQueue(cfg);
}
const ids = (r) => (r.issues || []).map((i) => i.id);

// ---- F1 / F2 / F3: the discriminating fixture --------------------------------------
// Input order: t-b, t-a, EPIC, t-c  → epic third of four, never at an edge.
// Sorted order: t-a (p0), t-c (p1 @01), EPIC (p1 @02), t-b (p1 @03) → epic third again.
// Unsorted on both axes: priorities run 1,0,1,1 and the p1 group is not in FIFO order.
const MAIN = [
  { id: 't-b', priority: 1, created_at: '2026-01-01T03:00:00Z', issue_type: 'task' },
  { id: 't-a', priority: 0, created_at: '2026-01-09T00:00:00Z', issue_type: 'task' },
  { id: 'e-1', priority: 1, created_at: '2026-01-01T02:00:00Z', issue_type: 'epic' },
  { id: 't-c', priority: 1, created_at: '2026-01-01T01:00:00Z', issue_type: 'task' },
];
const main = withQueue(MAIN);
check('F1 the queue read succeeded', main.ok === true);
check('F1 the epic is gone and all three tasks survive',
  ids(main).length === 3 && !ids(main).includes('e-1')
  && ['t-a', 't-b', 't-c'].every((i) => ids(main).includes(i)));
check(`F3 survivors ordered priority-then-FIFO (got ${JSON.stringify(ids(main))})`,
  JSON.stringify(ids(main)) === JSON.stringify(['t-a', 't-c', 't-b']));
check('F2 skipped holds exactly one entry', Array.isArray(main.skipped) && main.skipped.length === 1);
check('F2 the skipped entry carries the id AND the type the log line needs',
  !!main.skipped && !!main.skipped[0]
  && main.skipped[0].id === 'e-1' && main.skipped[0].issue_type === 'epic');

// ---- F4: back-compat, fail-open ----------------------------------------------------
const compat = withQueue([
  { id: 'c-1', priority: 1, created_at: '2026-01-01T01:00:00Z' },
  { id: 'c-2', priority: 1, created_at: '2026-01-01T02:00:00Z', issue_type: null },
  { id: 'c-3', priority: 1, created_at: '2026-01-01T03:00:00Z', issue_type: '' },
]);
check('F4 absent / null / empty issue_type are all kept',
  compat.ok === true && ids(compat).length === 3);
check('F4 nothing was skipped for a missing type',
  Array.isArray(compat.skipped) && compat.skipped.length === 0);

// ---- F5: only epic is excluded -----------------------------------------------------
const types = withQueue([
  { id: 'k-bug', priority: 1, created_at: '2026-01-01T01:00:00Z', issue_type: 'bug' },
  { id: 'k-feat', priority: 1, created_at: '2026-01-01T02:00:00Z', issue_type: 'feature' },
  { id: 'k-chore', priority: 1, created_at: '2026-01-01T03:00:00Z', issue_type: 'chore' },
  { id: 'k-dec', priority: 1, created_at: '2026-01-01T04:00:00Z', issue_type: 'decision' },
  { id: 'x-epic', priority: 1, created_at: '2026-01-01T05:00:00Z', issue_type: 'epic' },
]);
check('F5 bug, feature, chore and decision are all kept',
  ids(types).length === 4 && !ids(types).includes('x-epic'));

// ---- F8: an epic-only queue ---------------------------------------------------------
const only = withQueue([{ id: 'solo', priority: 0, created_at: '2026-01-01T00:00:00Z', issue_type: 'epic' }]);
check('F8 an epic-only queue is empty, not an error',
  only.ok === true && (only.issues || []).length === 0
  && Array.isArray(only.skipped) && only.skipped.length === 1);

// ---- F6 / F7: the summary line is a testable function ------------------------------
const qs = queue && queue.queueSummary;
check('F6 queue.js exports queueSummary', typeof qs === 'function');
if (typeof qs === 'function') {
  const A = { id: 'a', issue_type: 'task' };
  const B = { id: 'b', issue_type: 'task' };
  const E = { id: 'e-1', issue_type: 'epic' };

  const plain = String(qs([A, B], []));
  check(`F7 plain queue keeps the existing prefix (got ${JSON.stringify(plain)})`,
    plain.startsWith('ready queue: 2 task(s) — a, b'));
  check('F6 a plain queue mentions no skipping', !/skip/i.test(plain));

  const empty = String(qs([], []));
  check(`F7 an empty queue still renders (empty) (got ${JSON.stringify(empty)})`,
    empty.startsWith('ready queue: 0 task(s) — (empty)'));

  const withSkip = String(qs([A, B], [E]));
  check('F7 the skipped clause is appended after the existing prefix',
    withSkip.startsWith('ready queue: 2 task(s) — a, b'));
  check('F6 the skipped epic is named, with its type', /skip/i.test(withSkip)
    && withSkip.includes('e-1') && withSkip.includes('epic'));

  const nonTask = String(qs([A, { id: 'c', issue_type: 'bug' }], []));
  check('F6 a kept non-task entry is called out, with its type',
    nonTask.includes('c') && nonTask.includes('bug'));
}

// F6: run.js uses it, on a line that actually executes.
const runSrc = read(path.join(ROOT, 'runner', 'run.js')) || '';
const runExec = runSrc.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));
check('F6 run.js calls queueSummary on a non-comment line',
  runExec.some((l) => l.includes('queueSummary')));

process.exit(failed);
