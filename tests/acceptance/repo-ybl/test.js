// Frozen acceptance test — the audit's per-model cost cut (planning draft 2026-08-18,
// Task 2; design-ref DESIGN.md §4.3, §4.11, §5, change-log row `task-cost`). Written
// before implementation, from the spec alone; criteria C7–C8 map 1:1 to the issue's
// "Done means" list. Plain Node, Docker-free: it builds throwaway runs roots under the
// OS temp dir and drives scripts/audit-runs.js as a child through process.execPath,
// reaching each fixture through the AUDIT_RUNS_DIR seam. Every id is invented —
// nothing here names a real target project, and nothing reads the real runs/.
//
// DEPENDS ON the per-task cost record task: it reads `modelTokens` off manifest task
// rows and writes none of its own.
//
// THE FROZEN INTERFACE (added to the existing `### Models` section):
//   - a subsection headed by the literal line `#### Token cost`, inside `### Models`.
//   - one line per model NAMED BY A RECORD — not per resolved model id — carrying that
//     model's id, its four summed counts, and the fraction `<N> of <M>`, where N is the
//     number of task rows whose record names it and M is the number of task rows that
//     recorded any usage at all.
//   - one coverage line containing `no usage recorded` and the fraction of task rows
//     that recorded nothing, so a missing record is visible as missing rather than
//     silently counted as a zero.
//   - on a corpus where nothing recorded usage, the literal line
//     `(no task row recorded any token usage)` and exit 0.
//
// THE DISCRIMINATING FIXTURE: `fixture-helper` is named by two records and is NEVER any
// row's resolved model id, and `fixture-alpha`'s record sits in the same row as one of
// those helper entries. An implementation that sums a row's whole record into its
// RESOLVED-model bucket therefore reports fixture-alpha as 11/22/33/44 and never
// mentions fixture-helper at all — non-empty, well-formed and false, the defect-8 shape
// (change-log row `repo-wxh`) in new clothes. The exact per-key sums are what kill it.
//
// Deliberately NOT frozen: section prose, the order of the cost lines, and the exact
// separators inside a line — outcomes freeze, formatting decisions do not.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'audit-runs.js');

let failed = 0;
function check(name, cond) {
  console.log(`${cond ? 'ok' : 'FAIL'} - ${name}`);
  if (!cond) failed = 1;
}
const show = (v) => JSON.stringify(v);

check('scripts/audit-runs.js exists', fs.existsSync(SCRIPT));

// Fixture time lives in 2020, computed from a fixed epoch — never the wall clock, so
// the report stays byte-stable however long after this was written it runs.
const T0 = Date.UTC(2020, 0, 1);
const iso = (h) => new Date(T0 + h * 3600 * 1000).toISOString();

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-ybl-'));

const ALPHA = 'fixture-alpha';
const BETA = 'fixture-beta';
const HELPER = 'fixture-helper';           // never any row's resolved model id
const tok = (i, o, r, c) => ({ inputTokens: i, outputTokens: o, cacheReadInputTokens: r, cacheCreationInputTokens: c });

// Expected sums, keyed by the RECORD's own model ids:
//   alpha   1 /   2 /   3 /   4   named by 1 row
//   beta  105 / 206 / 307 / 408   named by 2 rows
//   helper 11 /  21 /  31 /  41   named by 2 rows, resolved by none
// 3 of the 4 task rows recorded any usage; 1 recorded none.
const EXPECT = {
  [ALPHA]: { counts: [1, 2, 3, 4], rows: 1 },
  [BETA]: { counts: [105, 206, 307, 408], rows: 2 },
  [HELPER]: { counts: [11, 21, 31, 41], rows: 2 },
};
const USAGE_ROWS = 3;
const TOTAL_ROWS = 4;

function writeRun(root, runId, manifest) {
  const d = path.join(root, runId);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'run.json'), JSON.stringify(manifest, null, 2));
}
function corpus(root, { withTokens }) {
  const strip = (row) => { const c = { ...row }; if (!withTokens) delete c.modelTokens; return c; };
  writeRun(root, '2020-01-01T00-00-00-000Z', {
    runId: '2020-01-01T00-00-00-000Z', startedAt: iso(0), finishedAt: iso(1),
    targetRepo: 'https://example.invalid/repo-fixture.git',
    tasks: [
      strip({
        issueId: 'app-001', outcome: 'done', attempts: 1, pauses: 0, prUrl: 'https://example.invalid/pr/1',
        model: ALPHA, modelTokens: { [ALPHA]: tok(1, 2, 3, 4), [HELPER]: tok(10, 20, 30, 40) },
      }),
      // The one row that records NOTHING: it must not be counted as a zero anywhere.
      strip({ issueId: 'app-002', outcome: 'stuck', attempts: 3, pauses: 0, prUrl: null, model: ALPHA }),
    ],
  });
  writeRun(root, '2020-01-03T00-00-00-000Z', {
    runId: '2020-01-03T00-00-00-000Z', startedAt: iso(48), finishedAt: iso(49),
    targetRepo: 'https://example.invalid/repo-fixture.git',
    tasks: [
      strip({
        issueId: 'app-003', outcome: 'done', attempts: 1, pauses: 0, prUrl: 'https://example.invalid/pr/3',
        model: BETA, modelTokens: { [BETA]: tok(100, 200, 300, 400) },
      }),
      strip({
        issueId: 'app-004', outcome: 'done', attempts: 2, pauses: 1, prUrl: 'https://example.invalid/pr/4',
        model: BETA, modelTokens: { [BETA]: tok(5, 6, 7, 8), [HELPER]: tok(1, 1, 1, 1) },
      }),
    ],
  });
  return root;
}
function runAudit(runsDir) {
  const env = { ...process.env };
  delete env.AUDIT_RUNS_DIR;
  if (runsDir !== null) env.AUDIT_RUNS_DIR = runsDir;
  return spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', env, cwd: tmp, timeout: 120000 });
}
const linesOf = (s) => String(s || '').split(/\r?\n/);
function snapshot(root) {
  const map = new Map();
  if (!fs.existsSync(root)) return map;
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(dir, e.name);
      const rel = path.relative(root, p).split(path.sep).join('/');
      if (e.isDirectory()) { map.set(rel + '/', 'dir'); walk(p); }
      else map.set(rel, crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex'));
    }
  })(root);
  return map;
}
const sameSnapshot = (a, b) => a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);

// The slice of the report between `### Models` and the next heading of the same or a
// higher level — the cost subsection has to live INSIDE the Models section, not after it.
function modelsSection(out) {
  const L = linesOf(out);
  const start = L.findIndex((l) => l.trim() === '### Models');
  if (start === -1) return null;
  let end = L.length;
  for (let i = start + 1; i < L.length; i++) {
    if (/^#{1,3} /.test(L[i])) { end = i; break; }
  }
  return L.slice(start, end);
}
// The pre-existing cross-tab lines, which this task must leave untouched.
const crossTabLines = (out) => linesOf(out).filter((l) =>
  /task row\(s\)/.test(l) || /done on attempt 1/.test(l) || /review verdicts/.test(l));

try {
  // ==== C7: cost is cut by the record's own model keys, in its own subsection ======
  const full = corpus(path.join(tmp, 'full'), { withTokens: true });
  const r1 = runAudit(full);
  check(`C7 the audit exits 0 on the fixture corpus (got ${r1.status}; stderr: ${(r1.stderr || '').trim().slice(0, 200)})`,
    r1.status === 0);
  const out = r1.stdout || '';
  const sect = modelsSection(out);
  check('C7 the report still has a `### Models` section', Boolean(sect));
  check('C7 the cost subsection `#### Token cost` sits INSIDE the Models section',
    Boolean(sect) && sect.some((l) => l.trim() === '#### Token cost'));

  // Scoped strictly to the lines BELOW the pinned heading: without this, an absent
  // heading would leave the whole Models section standing in for the cost subsection,
  // and the existing bucket lines would answer checks meant for the new ones.
  const costStart = sect ? sect.findIndex((l) => l.trim() === '#### Token cost') : -1;
  const costLines = costStart === -1 ? [] : sect.slice(costStart + 1);
  for (const model of Object.keys(EXPECT)) {
    const want = EXPECT[model];
    const line = costLines.find((l) => l.includes(model));
    check(`C7 the cost subsection carries a line for ${model}${model === HELPER ? ' — a model NO row resolves to' : ''} (got ${show(line)})`,
      Boolean(line));
    if (!line) continue;
    for (const n of want.counts) {
      check(`C7 ${model}'s line carries the exact summed count ${n}`,
        new RegExp(`(^|[^0-9])${n}([^0-9]|$)`).test(line));
    }
    check(`C7 ${model}'s line carries the fraction "${want.rows} of ${USAGE_ROWS}" — its own numerator over the rows that recorded any usage (got ${show(line)})`,
      line.includes(`${want.rows} of ${USAGE_ROWS}`));
  }
  // The anti-fold assertion, stated positively: folding a row's whole record into its
  // resolved-model bucket would report fixture-alpha as 11/22/33/44.
  const alphaLine = costLines.find((l) => l.includes(ALPHA)) || '';
  check('C7 fixture-alpha is NOT credited with the helper model\'s tokens (no 11/22/33/44)',
    !/(^|[^0-9])11([^0-9]|$)/.test(alphaLine) && !/(^|[^0-9])22([^0-9]|$)/.test(alphaLine));

  check(`C7 a coverage line reports the rows that recorded nothing — "no usage recorded", ${TOTAL_ROWS - USAGE_ROWS} of ${TOTAL_ROWS} (got ${show(costLines.filter((l) => l.includes('no usage recorded')))})`,
    costLines.some((l) => l.includes('no usage recorded') && l.includes(`${TOTAL_ROWS - USAGE_ROWS} of ${TOTAL_ROWS}`)));

  // (e) the existing resolved-model buckets are unchanged.
  const stripped = corpus(path.join(tmp, 'stripped'), { withTokens: false });
  const rStrip = runAudit(stripped);
  check(`C7 the audit exits 0 on the same corpus with every modelTokens stripped (got ${rStrip.status})`,
    rStrip.status === 0);
  const a = crossTabLines(out);
  const b = crossTabLines(rStrip.stdout || '');
  check(`C7 the pre-existing cross-tab lines are byte-identical with and without the records (${a.length} vs ${b.length} lines)`,
    a.length > 0 && show(a) === show(b));
  check(`C7 the resolved-model buckets are still keyed on task.model — ${HELPER} is not one of them`,
    !a.some((l) => l.includes(HELPER)));

  // ==== C8: the audit stays a pure reader ==========================================
  const before = snapshot(full);
  const r2 = runAudit(full);
  const after = snapshot(full);
  check('C8 stdout is byte-identical across two consecutive invocations over one tree',
    (r1.stdout || '') === (r2.stdout || ''));
  check('C8 nothing under the runs root was created, modified or deleted', sameSnapshot(before, after));
  const src = fs.readFileSync(SCRIPT, 'utf8');
  check('C8 scripts/audit-runs.js still requires no child_process',
    !/require\(\s*['"]child_process['"]\s*\)/.test(src) && !/from\s+['"]child_process['"]/.test(src));

  const bare = corpus(path.join(tmp, 'bare'), { withTokens: false });
  const r3 = runAudit(bare);
  check(`C8 the audit exits 0 on a corpus where nothing records usage (got ${r3.status})`, r3.status === 0);
  const bareSect = modelsSection(r3.stdout || '');
  check('C8 that corpus still renders the cost subsection rather than omitting it',
    Boolean(bareSect) && bareSect.some((l) => l.trim() === '#### Token cost'));
  check('C8 and it says so in its own words: the literal line `(no task row recorded any token usage)`',
    Boolean(bareSect) && bareSect.some((l) => l.trim() === '(no task row recorded any token usage)'));
} catch (e) {
  failed = 1;
  console.log(`FAIL - HARNESS BROKEN: unexpected exception: ${e && e.stack ? e.stack : e}`);
} finally {
  // Cleanup is never a verdict.
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* disposable */ }
}
process.exit(failed);
