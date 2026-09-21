// Frozen acceptance test — repo-uig: the run-level spec-concern headline
// (DESIGN.md §3.7, the readership amendment; change-log row `concern-repeat-surfacing`).
// Written before implementation, from the spec alone; criteria B1.1–B1.3. Plain Node,
// Docker-free, node built-ins only.
//
// Five deliberate choices, three of them forced by the panel:
//
//   * THE HEADLINE TEXT IS PINNED AND SO ARE ITS SLOTS. `spec concerns: <total> raised by
//     <k> of <n> tasks`. Without a literal token a test cannot FIND the line — the region
//     between the counts line and the first task heading already holds blank lines and
//     "Ordered by how much scrutiny each item needs." — and without fixed slots the 9/7/8
//     fixture is passed by an implementation that prints the three integers in the wrong
//     roles. Both halves are asserted; neither is sufficient alone.
//
//   * THE ZERO-CONCERN FIXTURE IS LOAD-BEARING, not filler. The most likely wrong build is
//     a copy of the per-task guard `if (t.specConcerns && t.specConcerns.length)` hoisted
//     to run level, which prints nothing on a clean run — and passes every fixture that
//     HAS concerns. Only a manifest with none can fail it.
//
//   * THE MALFORMED FIXTURE IS THE `repo-iok` CASE ONE LEVEL UP. The manifest is not
//     schema-validated at render time, so `(t.specConcerns || []).length` counts the
//     STRING 'nope' as four concerns and marks that task as a raiser. Non-empty,
//     well-formed and false. Every other fixture here passes such a build.
//
//   * B1.3's CORPUS PAIR IS INVERTED ON PURPOSE. An earlier draft varied four corpus
//     states against a task that does no corpus I/O — a gate no implementation could
//     fail, which is the shape that cost this project a whole run. Inverted, it catches
//     the opposite error: an implementation that reads `runs/` HERE, in the half that is
//     specified not to. Two routes are covered, because an implementation may resolve the
//     root from the cwd or from the module's own location: renders from two different
//     cwds must agree, AND the output must carry no prior-run vocabulary at all.
//
//   * NO FIXTURE IS COMMITTED. `tools/run-acceptance.sh` executes every *.js and *.sh in
//     this directory AS A TEST, so a fixture file beside this one would be run as one.
//     Everything is built at runtime under os.tmpdir() and removed.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
let failed = 0;
function check(name, cond) {
  console.log(`${cond ? 'ok' : 'FAIL'} - ${name}`);
  if (!cond) failed = 1;
}
function safe(label, fn, fallback) {
  try { return fn(); } catch (e) {
    check(`${label} must not throw (threw: ${e && e.message})`, false);
    return fallback;
  }
}
const report = (() => {
  try { return require(path.join(ROOT, 'runner', 'report.js')); } catch { return null; }
})();

if (!report || typeof report.renderReport !== 'function') {
  check('runner/report.js exports renderReport', false);
  process.exit(1);
}

// --- fixtures ------------------------------------------------------------------------

// A manifest shaped like the real thing. `concerns` is placed verbatim so a fixture can
// carry a malformed value, which is the whole point of B1.2.
function task(id, outcome, concerns) {
  const t = { issueId: id, title: `t ${id}`, outcome, attempts: 1, diffLines: 3 };
  if (concerns !== undefined) t.specConcerns = concerns;
  return t;
}
function manifestOf(tasks) {
  return {
    runId: '2026-08-25T00-00-00-000Z',
    startedAt: '2026-08-25T00:00:00.000Z',
    finishedAt: '2026-08-25T00:10:00.000Z',
    targetRepo: 'https://example.invalid/t.git',
    tasks,
  };
}

// The pinned template, with its three slots captured in fixed order. Case-insensitive so
// the spec is not failed on capitalisation; markdown emphasis around it is allowed, which
// is what lets the implementation render it bold.
const HEADLINE = /spec concerns:\s*(\d+)\s+raised by\s+(\d+)\s+of\s+(\d+)\s+tasks/i;

function headlineOf(md) {
  const lines = String(md).split(/\r?\n/);
  const hits = lines.filter((l) => HEADLINE.test(l));
  return { count: hits.length, line: hits[0] || null, m: hits[0] ? hits[0].match(HEADLINE) : null };
}

// --- B1.1 — one headline, pinned template, fixed slots --------------------------------

const sixClean = manifestOf(['a', 'b', 'c', 'd', 'e', 'f'].map((c) => task(`i-${c}`, 'done')));
const md6 = safe('B1.1 render (six clean)', () => report.renderReport(sixClean), '');
const h6 = headlineOf(md6);
check('B1.1 a six-task manifest with ZERO concerns still prints exactly one headline',
  h6.count === 1);
check('B1.1 the zero-concern headline reads 0 raised by 0 of 6',
  !!h6.m && h6.m[1] === '0' && h6.m[2] === '0' && h6.m[3] === '6');

// Seven of eight tasks raise nine concerns between them: two tasks carry two each.
const eight = manifestOf([
  task('i-1', 'stuck', ['one', 'two']),
  task('i-2', 'stuck', ['three', 'four']),
  task('i-3', 'stuck', ['five']),
  task('i-4', 'failed', ['six']),
  task('i-5', 'failed', ['seven']),
  task('i-6', 'partial', ['eight']),
  task('i-7', 'done', ['nine']),
  task('i-8', 'done'),
]);
const md8 = safe('B1.1 render (eight)', () => report.renderReport(eight), '');
const h8 = headlineOf(md8);
check('B1.1 the 9/7/8 manifest prints exactly one headline', h8.count === 1);
check('B1.1 its three integers are 9 concerns, 7 tasks, 8 total — IN THAT ORDER',
  !!h8.m && h8.m[1] === '9' && h8.m[2] === '7' && h8.m[3] === '8');

const zero = manifestOf([]);
const md0 = safe('B1.1 render (zero tasks)', () => report.renderReport(zero), '');
const h0 = headlineOf(md0);
check('B1.1 a zero-task manifest prints exactly one headline', h0.count === 1);
check('B1.1 the zero-task headline reads 0 raised by 0 of 0',
  !!h0.m && h0.m[1] === '0' && h0.m[2] === '0' && h0.m[3] === '0');

// Positional anchor. After the counts line; before the first task heading where one
// exists, else before the report's closing `---`.
function anchorOk(md) {
  const iCounts = md.search(/^\*\*\d+ task\(s\)\*\*:/m);
  const iHead = md.indexOf('\n## ');
  const iLine = md.search(HEADLINE);
  if (iCounts < 0 || iLine < 0) return false;
  if (iLine <= iCounts) return false;
  if (iHead >= 0) return iLine < iHead;
  const iRule = md.search(/^---\s*$/m);
  return iRule < 0 ? true : iLine < iRule;
}
check('B1.1 the headline sits after the counts line and before the first task heading (8 tasks)',
  anchorOk(md8));
check('B1.1 the anchor also holds for the zero-task manifest, which HAS no first heading',
  anchorOk(md0));

// --- B1.2 — a malformed specConcerns counts as zero and does not throw -----------------

const malformed = manifestOf([
  task('i-a', 'done', 'nope'),          // a string: (x || []).length === 4
  task('i-b', 'done', null),
  task('i-c', 'done', {}),
  task('i-d', 'done', ['real one', 'real two']),
]);
const mdM = safe('B1.2 render (malformed)', () => report.renderReport(malformed), '');
const hM = headlineOf(mdM);
check('B1.2 a malformed specConcerns does not throw and still yields one headline',
  hM.count === 1);
check("B1.2 'nope' / null / {} count as ZERO — the headline reads 2 raised by 1 of 4",
  !!hM.m && hM.m[1] === '2' && hM.m[2] === '1' && hM.m[3] === '4');

// --- B1.3 [guard] — a concern changes nothing, and this task reads no corpus -----------

const headings = (md) => String(md).split(/\r?\n/).filter((l) => /^## /.test(l));

const CONCERN_STATES = [
  [],
  ['one only'],
  ['a', 'b', 'c', 'd', 'e'],
  ['carries\nan embedded newline'],
  ['## a heading-shaped line inside a concern'],
  ['Z'.repeat(1000)],
];
let guardOk = true;
let exitBefore = process.exitCode;
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-uig-'));
const manifestBytes = [];
for (let i = 0; i < CONCERN_STATES.length; i++) {
  const m = manifestOf([
    task('i-tamp', 'tampered'),
    task('i-stuck', 'stuck', CONCERN_STATES[i]),
    task('i-done1', 'done'),
  ]);
  const md = safe(`B1.3 render (state ${i})`, () => report.renderReport(m), null);
  if (md === null) { guardOk = false; continue; }
  // Heading sequence is exactly the per-task headings, in manifest (scrutiny) order.
  const hs = headings(md);
  if (hs.length !== 3) guardOk = false;
  // Each task carrying concerns still renders them above "What changed".
  if (CONCERN_STATES[i].length) {
    const seg = md.slice(md.indexOf('## i-stuck'));
    const iC = seg.indexOf('Spec concern');
    const iW = seg.indexOf('**What changed**');
    if (!(iC >= 0 && iW >= 0 && iC < iW)) guardOk = false;
  }
  if (typeof report.writeManifest === 'function') {
    const d = path.join(tmpRoot, `m${i}`);
    fs.mkdirSync(d, { recursive: true });
    safe(`B1.3 writeManifest (state ${i})`, () => report.writeManifest(d, m), null);
    const raw = (() => { try { return fs.readFileSync(path.join(d, 'run.json'), 'utf8'); } catch { return null; } })();
    // The stated normalisation: blank the concern arrays, then compare. "identical except
    // for X" is not checkable without one.
    manifestBytes.push(raw === null ? null
      : raw.replace(/"specConcerns":\s*\[[\s\S]*?\]/g, '"specConcerns":[]'));
  }
}
check('B1.3 [guard] every concern state renders three task headings, concerns above What changed',
  guardOk);
check('B1.3 [guard] run.json is byte-identical across concern states once the arrays are blanked',
  manifestBytes.length > 1 && manifestBytes.every((b) => b !== null && b === manifestBytes[0]));
check('B1.3 [guard] rendering never touched process.exitCode',
  process.exitCode === exitBefore);

// The corpus pair. This task must not read `runs/`. Two routes an implementation could
// take are covered: resolving the root from the CWD, and resolving it from anywhere at
// all (caught by the vocabulary assertion, which no correct B1 output can trip).
const emptyCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-uig-nocorpus-'));
const fullCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-uig-corpus-'));
{
  const runs = path.join(fullCwd, 'runs');
  for (const id of ['2026-01-01T00-00-00-000Z', '2026-01-02T00-00-00-000Z']) {
    const d = path.join(runs, id);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'run.json'), JSON.stringify({
      runId: id,
      startedAt: '2026-01-01T00:00:00.000Z',
      targetRepo: 'https://example.invalid/t.git',
      tasks: [{ issueId: 'i-old', outcome: 'stuck', specConcerns: ['one only'] }],
    }));
  }
}
const cwdBefore = process.cwd();
let mdEmpty = null; let mdFull = null;
try {
  process.chdir(emptyCwd);
  mdEmpty = safe('B1.3 render from an empty cwd', () => report.renderReport(eight), null);
  process.chdir(fullCwd);
  mdFull = safe('B1.3 render from a cwd holding a populated runs/', () => report.renderReport(eight), null);
} finally {
  try { process.chdir(cwdBefore); } catch { /* best effort */ }
}
check('B1.3 [guard] the render is identical with and without a populated runs/ beside it',
  mdEmpty !== null && mdEmpty === mdFull);
// The backstop: an implementation resolving the corpus from its own location rather than
// the cwd is invisible to the pair above, but cannot avoid saying something about it.
const PRIOR = /prior run|earlier run|previous run|seen in \d+ run|shapes?:|×\s*\d/i;
check('B1.3 [guard] the report carries NO prior-run or grouping vocabulary — that is B2 work',
  typeof mdFull === 'string' && !PRIOR.test(mdFull));

// --- cleanup ---------------------------------------------------------------------------
for (const d of [tmpRoot, emptyCwd, fullCwd]) {
  try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
}

process.exit(failed);
