// Frozen acceptance test — repo-iok: the spec-concern channel, HOST side
// (DESIGN.md §3.7, §3.5, §4.9, §4.11, §4.12). Written before implementation, from the
// spec alone; criteria A1–A6 of the approved spec. Plain Node, Docker-free.
//
// Five deliberate choices, four of them forced by the testability critic:
//   * ONE hostile fixture drives all four surfaces. HOSTILE interleaves a blank, a
//     whitespace-only entry, two non-strings and a 1500-character entry among seven real
//     concerns, and its 1001st character is a distinctive 'Z'. A fixture built from
//     plausible agent output cannot discriminate: `pipeline/status.js` already caps at
//     5/1000 on the way in, so every such fixture passes against a host that does no
//     bounding at all. This one fails unless the bound is really re-enforced, and the
//     same five expected values must come out of all four surfaces — which is the only
//     behavioural check on "the bounds live in exactly one place".
//   * The manifest is asserted through an EXPORTED record fragment, not through
//     writeManifest. writeManifest spreads whatever task objects it is handed and
//     computes nothing, so "run.json carries the concerns" passes against a build where
//     nothing populates the field at all. concerns.manifestFields() is the seam that can
//     actually fail. run.js itself stays unreachable (loadToken + Docker preflight sit in
//     front of it); the source check is named as the weak check it is, and the run-level
//     proof is gated by asserting scripts/test-report.sh carries the case.
//   * A6 does not merely re-assert the §4.11 table — that table passes today and would
//     keep passing while a concern leaked into a transition. The differential drives
//     queue.finish() through the PIPELINE_BD_CMD seam and requires the non-`note` bd argv
//     to be byte-identical with and without concerns, for every outcome.
//   * The git fixtures inherit nothing: explicit HOME, GIT_CONFIG_NOSYSTEM, an explicit
//     identity and core.autocrlf=false on every commit, and an explicitly named branch.
//     The image sets a git identity only inside /workspace, so a fixture relying on
//     ambient config passes on a developer host and dies with "Author identity unknown"
//     where the verifier actually runs.
//   * The stub for the bd seam is a .js preloaded through process.execPath, never a
//     /bin/sh script: runner/bd.js spawns PIPELINE_BD_CMD with no shell, and a shell
//     script spawned that way returns EFTYPE on the Windows host — green in the
//     container, red in the sweep.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
let failed = 0;
function check(name, cond) {
  console.log(`${cond ? 'ok' : 'FAIL'} - ${name}`);
  if (!cond) failed = 1;
}
function deepEq(actual, expected) {
  try { assert.deepStrictEqual(actual, expected); return true; } catch { return false; }
}
const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
const req = (rel) => { try { return require(path.join(ROOT, rel)); } catch { return null; } };
// Every surface must survive malformed input; a throw is a failed check, not a crashed
// suite, so the remaining criteria still report.
function safe(label, fn, fallback) {
  try { return fn(); } catch (e) {
    check(`${label} must not throw (threw: ${e && e.message})`, false);
    return fallback;
  }
}

const ISO = '2026-07-28T00:00:00Z';
const ATTEMPT = { number: 1, verifierResult: 'pass', timestamp: ISO };

// ---- the one hostile fixture, shared by every surface -------------------------------
// Junk is INTERLEAVED, not leading: an implementation that slices to five before
// dropping junk keeps '' and '   ', and every assertion below then fails. The long
// entry's 1001st character is 'Z' and appears nowhere else, so the truncation point is
// checkable in rendered prose, not just in the array.
const LONG = `${'A'.repeat(1000)}Z${'B'.repeat(499)}`;
const HOSTILE = [
  '',
  'SC-1 the criteria contradict section 4.4',
  '   ',
  42,
  'SC-2 the fixture the spec demands cannot exist',
  null,
  'SC-3 the frozen test asserts the opposite of the description',
  LONG,
  { text: 'not a string' },
  'SC-4 the dependency named is not in the image',
  'SC-5 must-never-be-surfaced',
  'SC-6 must-never-be-surfaced',
  'SC-7 must-never-be-surfaced',
];
// Deliberately not alphabetical and not input-index order — SC-4 comes after the long
// entry, so a surface that sorts or reorders is visible.
const EXPECTED = [
  'SC-1 the criteria contradict section 4.4',
  'SC-2 the fixture the spec demands cannot exist',
  'SC-3 the frozen test asserts the opposite of the description',
  'A'.repeat(1000),
  'SC-4 the dependency named is not in the image',
];
const DROPPED = ['SC-5 must-never-be-surfaced', 'SC-6 must-never-be-surfaced', 'SC-7 must-never-be-surfaced'];

// The three assertions every rendered surface must satisfy, so no surface can be bounded
// while another is not.
function surfaceChecks(label, text) {
  const t = text || '';
  check(`${label} renders all five surviving concerns`, EXPECTED.every((e) => t.includes(e)));
  check(`${label} renders none of the dropped concerns`, DROPPED.every((d) => !t.includes(d)));
  check(`${label} cuts the over-long concern at exactly 1000 characters`,
    t.includes('A'.repeat(1000)) && !t.includes(`${'A'.repeat(1000)}Z`));
  const order = EXPECTED.map((e) => t.indexOf(e));
  check(`${label} keeps the concerns in input order`,
    order.every((i) => i >= 0) && order.every((v, i) => i === 0 || v > order[i - 1]));
}

// ---- A1: one bounded normaliser, reached by every surface ---------------------------
const concerns = req('runner/concerns.js');
check('A1 runner/concerns.js is requirable', concerns !== null);
check('A1 specConcerns is exported',
  !!concerns && typeof concerns.specConcerns === 'function');
check('A1 manifestFields is exported',
  !!concerns && typeof concerns.manifestFields === 'function');

const norm = (s) => (concerns && typeof concerns.specConcerns === 'function'
  ? safe('A1 specConcerns', () => concerns.specConcerns(s), null)
  : null);
const empty = (v) => Array.isArray(v) && v.length === 0;

check('A1 absent field -> []', empty(norm({ issueId: 'repo-iok', attempts: [] })));
check('A1 null status -> []', empty(norm(null)));
check('A1 undefined status -> []', empty(norm(undefined)));
check('A1 null field -> []', empty(norm({ specConcerns: null })));
check('A1 string field -> []', empty(norm({ specConcerns: 'not an array' })));
check('A1 object field -> []', empty(norm({ specConcerns: { 0: 'x' } })));
check('A1 number field -> []', empty(norm({ specConcerns: 3 })));
check('A1 empty array -> []', empty(norm({ specConcerns: [] })));

const normalised = norm({ issueId: 'repo-iok', attempts: [ATTEMPT], specConcerns: HOSTILE });
check('A1 the hostile fixture normalises to exactly the five expected values',
  deepEq(normalised, EXPECTED));

// ---- A2: the Beads attempt log ------------------------------------------------------
const queue = req('runner/queue.js');
check('A2 runner/queue.js is requirable', queue !== null);
const DONE = { status: 'done', beads: 'closed' };
const notesFor = (status, outcome) => (queue && typeof queue.attemptNotes === 'function'
  ? safe('A2 attemptNotes', () => queue.attemptNotes('run-iok', outcome || DONE, status, 3).join('\n'), null)
  : null);
const BASE = { issueId: 'repo-iok', attempts: [ATTEMPT] };

const logged = notesFor({ ...BASE, specConcerns: HOSTILE });
check('A2 the count line reports the bounded 5, never the raw 13',
  /spec concerns: 5/.test(logged || '') && !/spec concerns: (7|10|13)/.test(logged || ''));
surfaceChecks('A2 attempt log', logged);
check('A2 the historic outcome line is unchanged',
  (logged || '').includes('run run-iok: outcome done'));
check('A2 the historic attempt line is unchanged',
  (logged || '').includes(`attempt 1: pass at ${ISO}`));
check('A2 the historic memory-in line is unchanged', (logged || '').includes('memory in: 3'));

// Position is pinned, not left to the implementer: the block is multi-line, so it goes
// last, after every single-line fact. A presence-only assertion cannot catch the count
// line being emitted above the `run <id>: outcome` header, which breaks the block.
if (logged) {
  const lines = logged.split('\n');
  const iCount = lines.findIndex((l) => /spec concerns: 5/.test(l));
  const iMemIn = lines.findIndex((l) => l.includes('memory in: 3'));
  check('A2 the header is still the first line', /^run run-iok: outcome done$/.test(lines[0] || ''));
  check('A2 the concern block comes last, after every existing line',
    iCount > 0 && iMemIn > 0 && iCount > iMemIn);
  check('A2 the five concerns follow the count line, one line each',
    iCount > 0 && lines.length === iCount + 6);
}

const withNone = notesFor(BASE);
check('A2 no concern line at all when the field is absent',
  withNone !== null && !/spec concerns/i.test(withNone));
const withEmpty = notesFor({ ...BASE, specConcerns: [] });
check('A2 no concern line when the array is empty',
  withEmpty !== null && !/spec concerns/i.test(withEmpty));
const withJunk = notesFor({ ...BASE, specConcerns: 'nope' });
check('A2 malformed field: no line and no throw',
  withJunk !== null && !/spec concerns/i.test(withJunk));

// A bd note is an indented block; a concern containing newlines must not break it apart.
const multi = notesFor({ ...BASE, specConcerns: ['head line\nmiddle line\ntail line'] });
const multiLines = (multi || '').split('\n').filter((l) => l.includes('head line'));
check('A2 a multi-line concern is collapsed onto a single line',
  multiLines.length === 1 && multiLines[0].includes('tail line'));

// ---- A3: the run manifest -----------------------------------------------------------
const runSchema = (() => {
  try { return JSON.parse(read(path.join(ROOT, 'schemas', 'run.schema.json'))); } catch { return {}; }
})();
const taskItem = (((runSchema.properties || {}).tasks || {}).items) || {};
const sc = (taskItem.properties || {}).specConcerns;
check('A3 run.schema.json declares tasks[].specConcerns', sc !== undefined);
check('A3 declared as an array of strings',
  !!sc && sc.type === 'array' && !!sc.items && sc.items.type === 'string');
check('A3 maxItems 5 on the array', !!sc && sc.maxItems === 5);
check('A3 maxLength 1000 on the ITEMS, not on the array',
  !!sc && !!sc.items && sc.items.maxLength === 1000 && sc.maxLength === undefined);
check('A3 optional (absent from the task item\'s required list)',
  !Array.isArray(taskItem.required) || !taskItem.required.includes('specConcerns'));
check('A3 the task item still forbids additional properties',
  taskItem.additionalProperties === false);

// The record fragment run.js spreads. This is the seam that can fail — writeManifest
// spreads what it is handed, so asserting there proves nothing about population.
const fields = (s) => (concerns && typeof concerns.manifestFields === 'function'
  ? safe('A3 manifestFields', () => concerns.manifestFields(s), null)
  : null);
check('A3 the hostile status yields the five bounded values on the record',
  deepEq(fields({ ...BASE, specConcerns: HOSTILE }), { specConcerns: EXPECTED }));
check('A3 no concerns yields no key at all (not an empty array)', deepEq(fields(BASE), {}));
check('A3 an empty array yields no key', deepEq(fields({ ...BASE, specConcerns: [] }), {}));
check('A3 a malformed value yields no key and does not throw',
  deepEq(fields({ ...BASE, specConcerns: 'nope' }), {})
  && deepEq(fields({ ...BASE, specConcerns: 7 }), {}));

const report = req('runner/report.js');
check('A3 runner/report.js is requirable', report !== null);
const manifestOf = (tasks) => ({
  runId: 'run-iok', startedAt: ISO, finishedAt: ISO,
  targetRepo: 'https://example.test/repo.git', tasks,
});
const stuckTask = {
  issueId: 'i-stuck', title: 'never converged', outcome: 'stuck', exitCode: 10,
  branch: 'task/i-stuck', pushed: true, prUrl: null, attempts: 3, pauses: 0,
  activeSeconds: 30, diffLines: 12, changeSummary: 'Tried three ways.',
  verification: { acceptance: 'fail', regressions: 'absent' },
  attemptNotes: ['run run-iok: outcome stuck'],
  specConcerns: HOSTILE,
};
const cleanTask = {
  issueId: 'i-done', title: 'clean pass', outcome: 'done', exitCode: 0,
  branch: 'task/i-done', pushed: true, prUrl: 'https://example.test/pr/1', attempts: 1,
  pauses: 0, activeSeconds: 10, diffLines: 3, changeSummary: 'Added the widget.',
  verification: { acceptance: 'pass', regressions: 'pass' },
  attemptNotes: ['run run-iok: outcome done'],
};

if (report && typeof report.writeManifest === 'function') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-iok-man-'));
  const bounded = { ...cleanTask, ...(fields({ ...BASE, specConcerns: HOSTILE }) || {}) };
  safe('A3 writeManifest', () => report.writeManifest(dir, manifestOf([bounded])), null);
  const onDisk = (() => { try { return JSON.parse(read(path.join(dir, 'run.json'))); } catch { return null; } })();
  const written = onDisk && Array.isArray(onDisk.tasks) ? onDisk.tasks[0] : null;
  check('A3 run.json carries the bounded concerns to disk',
    !!written && deepEq(written.specConcerns, EXPECTED));
} else {
  check('A3 writeManifest is exported', false);
}

// run.js is the one hop no Docker-free test can execute (loadToken + preflight sit in
// front of it), so this is a WEAK check by construction and is labelled as one: it
// cannot distinguish a wired call from a discarded one. The behavioural proof is the
// scripts/test-report.sh case gated immediately below.
const runJsLines = (read(path.join(ROOT, 'runner', 'run.js')) || '')
  .split('\n').filter((l) => !l.trim().startsWith('//'));
const runJsCode = runJsLines.join('\n');
check('A3 (weak) run.js requires the shared normaliser on a non-comment line',
  /require\(['"]\.\/concerns['"]\)/.test(runJsCode));
check('A3 (weak) run.js spreads the record fragment on a non-comment line',
  /manifestFields\s*\(/.test(runJsCode));

// The run-level proof this criterion defers to the host suites must actually exist,
// or the carve-out is a hole: the verifier runs only this directory, so a deferred
// assertion nobody wrote would never be noticed.
const reportSuite = read(path.join(ROOT, 'scripts', 'test-report.sh')) || '';
check('A3 the host report suite carries a spec-concerns case',
  reportSuite.includes('specConcerns') && /Spec concerns/.test(reportSuite));

// ---- A4: the run report -------------------------------------------------------------
const render = (tasks) => (report && typeof report.renderReport === 'function'
  ? safe('A4 renderReport', () => report.renderReport(manifestOf(tasks)), null)
  : null);

const rep = render([stuckTask]);
check('A4 the section heading is rendered', /\*\*Spec concerns\*\*/.test(rep || ''));
// The disclaimer is pinned to a literal substring, case-insensitive; the rest of the
// sentence is free. Unpinned, a frozen test invents prose and any rewording fails a
// correct implementation — while asserting nothing lets the disclaimer be dropped.
check('A4 the section carries the literal "evidence only"', /evidence only/i.test(rep || ''));
surfaceChecks('A4 report', rep);
if (rep) {
  const iTask = rep.indexOf('## i-stuck');
  const iConcerns = rep.indexOf('**Spec concerns**');
  const iChanged = rep.indexOf('**What changed**');
  check('A4 concerns sit inside the task section, above "What changed"',
    iTask >= 0 && iConcerns > iTask && iChanged > iConcerns);
}
check('A4 the existing sections and label are untouched',
  (rep || '').includes('STUCK — bailed after 3 attempts')
  && (rep || '').includes('**What changed**')
  && (rep || '').includes('**Verification evidence**')
  && (rep || '').includes('**Attempt notes**'));

const repNone = render([cleanTask]);
check('A4 no section for a task with no concerns',
  repNone !== null && !/Spec concerns/i.test(repNone));
const repEmpty = render([{ ...cleanTask, specConcerns: [] }]);
check('A4 an empty array renders no section',
  repEmpty !== null && !/Spec concerns/i.test(repEmpty));
const repJunk = render([{ ...cleanTask, specConcerns: 'nope' }]);
check('A4 a malformed value renders no section and does not throw',
  repJunk !== null && !/Spec concerns/i.test(repJunk));

// ---- A5: the PR body ----------------------------------------------------------------
const publishMod = req('runner/publish.js');
check('A5 runner/publish.js is requirable', publishMod !== null);
const bodyFor = (status, outcome) => (publishMod && typeof publishMod.buildPrBody === 'function'
  ? safe('A5 buildPrBody', () => publishMod.buildPrBody({
    issueMarkdown: '# i-done: clean pass\n\nspec text',
    status,
    verify: { acceptance: 'pass', regressions: 'pass' },
    outcome: outcome || { status: 'done' },
    branch: 'task/i-done',
    runId: 'run-iok',
  }), null)
  : null);

const body = bodyFor({ ...BASE, changeSummary: 'Added the widget.', specConcerns: HOSTILE });
check('A5 the PR body has a spec-concerns section', /## Spec concerns/.test(body || ''));
check('A5 the section carries the literal "evidence only"', /evidence only/i.test(body || ''));
surfaceChecks('A5 PR body', body);
if (body) {
  check('A5 concerns follow the change summary',
    body.indexOf('## Change summary') < body.indexOf('## Spec concerns'));
}
check('A5 the existing sections are untouched',
  (body || '').includes('## Spec') && (body || '').includes('## Change summary')
  && (body || '').includes('## Verification evidence')
  && (body || '').includes('_Pipeline run `run-iok`'));

const bodyNone = bodyFor({ ...BASE, changeSummary: 'Added the widget.' });
check('A5 no section when there are no concerns',
  bodyNone !== null && !/Spec concerns/i.test(bodyNone));
const bodyJunk = bodyFor({ ...BASE, changeSummary: 'x', specConcerns: 7 });
check('A5 a malformed value yields no section and no throw',
  bodyJunk !== null && !/Spec concerns/i.test(bodyJunk));

// ---- A6: evidence only — a concern moves nothing ------------------------------------
// (i) The §4.11 table, pinned. This passes today and is a regression pin, not a proof:
// it fails only if a concerns clause is woven into outcomeFor itself.
if (queue && typeof queue.outcomeFor === 'function') {
  const table = [
    ['exit 0, regressions pass', [0, { acceptance: 'pass', regressions: 'pass' }], 'done', 'closed'],
    ['exit 0, regressions absent', [0, { acceptance: 'pass', regressions: 'absent' }], 'done', 'closed'],
    ['exit 0, regressions fail', [0, { acceptance: 'pass', regressions: 'fail' }], 'partial', 'closed'],
    ['exit 10', [10, null], 'stuck', 'blocked'],
    ['exit 11', [11, null], 'tampered', 'blocked'],
    ['exit 30', [30, null], 'failed', 'blocked'],
    ['wall-clock kill', ['killed', null], 'failed', 'blocked'],
  ];
  for (const [label, args, status, beads] of table) {
    const got = safe('A6 outcomeFor', () => queue.outcomeFor(...args), null);
    check(`A6 ${label} -> ${status}/${beads}`,
      !!got && got.status === status && got.beads === beads);
  }
  const paused = safe('A6 outcomeFor', () => queue.outcomeFor(20, null), null);
  check('A6 exit 20 -> paused with a null Beads transition',
    !!paused && paused.status === 'paused' && !paused.beads);
}

// (ii) The differential that the table cannot give: the Beads writes the runner actually
// performs must be byte-identical with and without concerns, for every outcome. The
// `note` invocations are excluded on purpose — the note text differs by design (A2); the
// transition must not.
if (queue && typeof queue.finish === 'function') {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-iok-bd-'));
  const stub = path.join(tmp, 'bd-stub.js');
  const argsLog = path.join(tmp, 'bd-args.log');
  fs.writeFileSync(stub, [
    "'use strict';",
    "const sfs = require('fs');",
    "const spath = require('path');",
    'const argv = process.argv.slice(1);',
    'if (argv.length) argv[0] = spath.basename(argv[0]);',
    'sfs.appendFileSync(process.env.BD_ARGS_LOG, JSON.stringify(argv) + "\\n");',
    'process.exit(0);',
    '',
  ].join('\n'));
  fs.writeFileSync(argsLog, '');

  const saved = { cmd: process.env.PIPELINE_BD_CMD, opts: process.env.NODE_OPTIONS };
  process.env.PIPELINE_BD_CMD = process.execPath;
  // Forward slashes and quotes: NODE_OPTIONS treats backslashes as escapes, and the temp
  // path may contain spaces. A mangled preload makes every stubbed call look like a bd
  // failure — 11 checks went red exactly this way on the Windows host once.
  process.env.NODE_OPTIONS = `--require "${stub.split(path.sep).join('/')}"`;
  process.env.BD_ARGS_LOG = argsLog;

  const cfg = { targetRepoPath: '/nonexistent-by-design', image: 'unused' };
  const transitions = (status, outcome) => {
    fs.writeFileSync(argsLog, '');
    safe('A6 finish', () => queue.finish(cfg, 'i-diff', outcome,
      queue.attemptNotes('run-iok', outcome, status, 3)), null);
    return (read(argsLog) || '').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return ['unparseable', l]; } })
      .filter((a) => a[0] !== 'note');
  };

  const OUTCOMES = [
    ['done', { status: 'done', beads: 'closed' }],
    ['partial', { status: 'partial', beads: 'closed' }],
    ['stuck', { status: 'stuck', beads: 'blocked' }],
    ['tampered', { status: 'tampered', beads: 'blocked' }],
    ['failed', { status: 'failed', beads: 'blocked' }],
    ['paused', { status: 'paused', beads: null }],
  ];
  const sanity = transitions(BASE, OUTCOMES[0][1]);
  check('A6 the bd seam is live (the stub recorded the close for a done task)',
    sanity.length === 1 && sanity[0][0] === 'close');
  for (const [label, outcome] of OUTCOMES) {
    const plain = transitions(BASE, outcome);
    const carrying = transitions({ ...BASE, specConcerns: HOSTILE }, outcome);
    check(`A6 ${label}: the Beads transition is identical with and without concerns`,
      JSON.stringify(plain) === JSON.stringify(carrying));
  }

  if (saved.cmd === undefined) delete process.env.PIPELINE_BD_CMD;
  else process.env.PIPELINE_BD_CMD = saved.cmd;
  if (saved.opts === undefined) delete process.env.NODE_OPTIONS;
  else process.env.NODE_OPTIONS = saved.opts;
}

// (iii) Publication is likewise untouched: a concern must neither open a PR on a stuck
// task nor suppress one on a done task. Real git, a real bare remote, a gh stub, and
// nothing inherited from the ambient environment.
function gitFixture(tag) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `accept-iok-${tag}-`));
  const home = path.join(base, 'home');
  const remote = path.join(base, 'remote.git');
  const work = path.join(base, 'work');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(work, { recursive: true });
  // HOME + GIT_CONFIG_NOSYSTEM: no global or system config reaches these repos. The
  // image sets an identity only inside /workspace, so anything inherited here would
  // pass on a developer host and die where the verifier runs.
  const env = { ...process.env, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(home, 'nonexistent') };
  const CFG = ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'core.autocrlf=false',
    '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main'];
  const run = (cwd, args) => spawnSync('git', [...CFG, ...args], { cwd, encoding: 'utf8', env });
  if (spawnSync('git', [...CFG, 'init', '--bare', '-q', remote], { encoding: 'utf8', env }).status !== 0) return null;
  if (run(work, ['init', '-q']).status !== 0) return null;
  fs.writeFileSync(path.join(work, 'seed.txt'), 'seed\n');
  run(work, ['add', '-A']);
  if (run(work, ['commit', '-q', '-m', 'seed']).status !== 0) return null;
  const branch = `task/${tag}`;
  if (run(work, ['checkout', '-q', '-b', branch]).status !== 0) return null;
  fs.writeFileSync(path.join(work, 'work.txt'), 'work\n');
  run(work, ['add', '-A']);
  if (run(work, ['commit', '-q', '-m', 'the task commit']).status !== 0) return null;
  if (run(work, ['remote', 'add', 'origin', remote.replace(/\\/g, '/')]).status !== 0) return null;
  return { base, work, remote, branch, prBodyFile: path.join(base, 'pr-body.txt') };
}

function runPublish(fx, outcome, status) {
  const prev = process.env.PIPELINE_GH_CMD;
  process.env.PIPELINE_GH_CMD =
    `printf '%s' "$PR_BODY" > '${fx.prBodyFile.replace(/\\/g, '/')}'; echo https://example.test/pr/9`;
  const log = { info() {}, error() {} };
  const out = safe('A6 publish', () => publishMod.publish({}, {
    ws: { dir: fx.work, branch: fx.branch, defaultBranch: 'main', forkPoint: 'HEAD~1' },
    outcome,
    hasCommits: true,
    issueMarkdown: '# i: title\n\nspec',
    status,
    verify: { acceptance: outcome.status === 'done' ? 'pass' : 'fail', regressions: 'absent' },
    issue: { id: 'i', title: 'title' },
    runId: 'run-iok',
  }, log, 'trace'), null);
  if (prev === undefined) delete process.env.PIPELINE_GH_CMD;
  else process.env.PIPELINE_GH_CMD = prev;
  return out;
}

if (publishMod && typeof publishMod.publish === 'function') {
  const CONCERNED = { ...BASE, changeSummary: 'did the work', specConcerns: HOSTILE };

  const stuckFx = gitFixture('stuck');
  check('A6 fixture: a git repo with a bare remote was built (stuck case)', stuckFx !== null);
  if (stuckFx) {
    const res = runPublish(stuckFx, { status: 'stuck', beads: 'blocked' }, CONCERNED);
    check('A6 a stuck task carrying concerns is still pushed', !!res && res.pushed === true);
    check('A6 a concern does not open a PR on a stuck task', !!res && res.prUrl === null);
    // Observable form of "no PR body assembled": the gh stub was never invoked, so its
    // artefact does not exist. buildPrBody itself is pure and leaves no trace.
    check('A6 the gh stub was never invoked for the stuck task', !fs.existsSync(stuckFx.prBodyFile));
  }

  const doneFx = gitFixture('done');
  check('A6 fixture: a git repo with a bare remote was built (done case)', doneFx !== null);
  if (doneFx) {
    const res = runPublish(doneFx, { status: 'done', beads: 'closed' }, CONCERNED);
    check('A6 a done task carrying concerns is still pushed', !!res && res.pushed === true);
    check('A6 a concern does not suppress the PR on a done task',
      !!res && res.prUrl === 'https://example.test/pr/9');
    // The one place a concern's value is pinned against something independent: the bytes
    // the runner actually handed to gh, bounded, not the string a builder returned.
    const sent = read(doneFx.prBodyFile) || '';
    check('A6 the PR the runner actually opened carries the concerns section',
      sent.includes('## Spec concerns'));
    surfaceChecks('A6 the PR body gh received', sent);
  }
}

process.exit(failed);
