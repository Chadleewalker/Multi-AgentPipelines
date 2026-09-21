#!/usr/bin/env node
// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// FROZEN acceptance suite for repo-isq — the dispatch gate refuses a frozen suite that carries
// no matching receipt (DESIGN.md §4.12, the third admission rule).
//
// Written before any implementation exists, from the spec alone. Do not edit during a run —
// everything under tests/acceptance/ is diffed against the fork point and any difference ends
// the task `tampered` (DESIGN.md §4.4).
//
// The fixtures are throwaway bare remotes and working copies under the OS temp dir, on the
// dispatch-gate suite's pattern. The receipts they carry are produced by the SHARED formula in
// runner/suite-hash.js, never by a formula this file carries — a drift between the gate's hash
// and the runner's would otherwise pass every check while refusing every real freeze.
//
// Section headers name the criterion they serve; every criterion in the issue has one.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const RECEIPT = '.freeze-gate.json';
const KINDS = ['no-suite', 'no-receipt', 'receipt-mismatch', 'half-proven'];

let failed = 0;
function check(name, cond, detail) {
  console.log(`${cond ? 'ok' : 'FAIL'} - ${name}`);
  if (!cond) { failed = 1; if (detail) console.log(`       ${String(detail).slice(0, 300)}`); }
  return cond;
}
function read(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } }
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }

delete process.env.PIPELINE_BD_CMD;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-isq-'));

let queue = null; let hashMod = null; let config = null; let report = null; let feed = null; let runmod = null;
try { queue = require(path.join(ROOT, 'runner', 'queue.js')); } catch { queue = null; }
try { hashMod = require(path.join(ROOT, 'runner', 'suite-hash.js')); } catch { hashMod = null; }
try { config = require(path.join(ROOT, 'runner', 'config.js')); } catch { config = null; }
try { report = require(path.join(ROOT, 'runner', 'report.js')); } catch { report = null; }
try { feed = require(path.join(ROOT, 'runner', 'feed.js')); } catch { feed = null; }
try { runmod = require(path.join(ROOT, 'runner', 'run.js')); } catch { runmod = null; }
check('runner/queue.js, suite-hash.js, config.js, report.js, feed.js and run.js are requirable',
  !!queue && !!hashMod && !!config && !!report && !!feed && !!runmod);
const schema = readJson(path.join(ROOT, 'schemas', 'run.schema.json'));
const EXAMPLE = readJson(path.join(ROOT, 'run.config.example.json')) || {};

// ---- git fixtures ---------------------------------------------------------------------------
const EMPTY_GLOBAL = path.join(TMP, 'empty-gitconfig');
fs.writeFileSync(EMPTY_GLOBAL, '');
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'frozen', GIT_AUTHOR_EMAIL: 'frozen@test.local',
  GIT_COMMITTER_NAME: 'frozen', GIT_COMMITTER_EMAIL: 'frozen@test.local',
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: EMPTY_GLOBAL,
};
function git(cwd, args) {
  return spawnSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', '-c', 'core.eol=lf', ...args],
    { cwd, encoding: 'utf8', env: GIT_ENV });
}
const mk = (d) => { fs.mkdirSync(d, { recursive: true }); return d; };
function mkBare(dir) {
  mk(dir);
  git(dir, ['init', '--bare', '--initial-branch', 'main', '.']);
  git(dir, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  return dir;
}
function mkWork(dir, remote) {
  mk(dir);
  git(dir, ['init', '--initial-branch', 'main', '.']);
  git(dir, ['remote', 'add', 'origin', remote]);
  fs.writeFileSync(path.join(dir, 'README.md'), 'fixture\n');
  fs.writeFileSync(path.join(dir, 'pipeline.config.json'),
    JSON.stringify({ verifyCommand: 'sh tools/run-acceptance.sh', defaultBranch: 'main', frozenPaths: [], dependencies: {} }, null, 2));
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', 'init']);
  git(dir, ['push', '-q', 'origin', 'main']);
  return dir;
}
const suiteRel = (id) => `tests/acceptance/${id}`;
// A receipt the SHARED formula would write for the suite as it stands in `work`.
function receiptFor(work, id, over = {}) {
  const entries = hashMod.workingTreeEntries(work, suiteRel(id));
  return {
    gateVersion: 1, verdict: 'red', probeSupplied: true, suiteHash: hashMod.suiteHash(entries),
    gateHead: null, guards: null, brittleness: 0, writtenAt: '2026-08-28T00:00:00.000Z', ...over,
  };
}
// Adds a suite for `id`; `receipt` is null (none), an object (written as JSON) or a raw string.
function addSuite(work, id, receipt, { push = true } = {}) {
  const p = mk(path.join(work, 'tests', 'acceptance', id));
  fs.writeFileSync(path.join(p, 'test.js'), `// suite ${id}\nprocess.exit(1);\n`);
  if (receipt !== null && receipt !== undefined) {
    const body = typeof receipt === 'string' ? receipt : `${JSON.stringify(receipt, null, 2)}\n`;
    fs.writeFileSync(path.join(p, RECEIPT), body);
  }
  git(work, ['add', '-A']);
  git(work, ['commit', '-qm', `suite ${id}`]);
  if (push) git(work, ['push', '-q', 'origin', 'main']);
}

// ---- the bd seam ----------------------------------------------------------------------------
// Stand-aside guard first: the preload reaches every node child; a real script child has a
// .js argv[0] that exists. Verbs are matched on the basename because node absolutises argv[0].
function writeBdStub(dir, entries, logFile) {
  const stub = path.join(dir, 'bd-stub.js');
  fs.writeFileSync(stub, [
    "'use strict';",
    'const fs = require("fs");',
    'const argv = process.argv.slice(1);',
    'if (argv.length && /\\.js$/i.test(argv[0]) && fs.existsSync(argv[0])) return;',
    `fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify(argv) + "\\n");`,
    'if (argv.some((a) => /(^|[\\\\/])ready$/.test(String(a)))) {',
    `  fs.writeSync(1, ${JSON.stringify(JSON.stringify(entries))});`,
    '  process.exit(0);',
    '}',
    'process.exit(0);',
  ].join('\n'));
  return stub;
}
function withBd(stub, fn) {
  const savedCmd = process.env.PIPELINE_BD_CMD; const savedOpts = process.env.NODE_OPTIONS;
  process.env.PIPELINE_BD_CMD = process.execPath;
  process.env.NODE_OPTIONS = `--require "${stub.split(path.sep).join('/')}"`;
  try { return fn(); } finally {
    if (savedCmd === undefined) delete process.env.PIPELINE_BD_CMD; else process.env.PIPELINE_BD_CMD = savedCmd;
    if (savedOpts === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = savedOpts;
  }
}
const issue = (id) => ({ id, title: `t ${id}`, issue_type: 'task', priority: 2, created_at: '2026-01-01T00:00:00Z' });
const cfgFor = (work, remote, over = {}) => ({ ...EXAMPLE, targetRepoPath: work, targetRepoRemote: remote, gitTimeoutMs: 60000, bdTimeoutMs: 60000, ...over });
function readyWith(work, remote, ids, over) {
  const logFile = path.join(TMP, `bd-${Math.random().toString(36).slice(2)}.log`);
  fs.writeFileSync(logFile, '');
  const stub = writeBdStub(TMP, ids.map(issue), logFile);
  const res = withBd(stub, () => queue.readyQueue(cfgFor(work, remote, over)));
  return { res, bdLog: read(logFile) || '' };
}
const refusalOf = (res, id) => (res.undispatchable || []).find((u) => u && u.issue && u.issue.id === id) || null;
const dispatched = (res, id) => (res.issues || []).some((i) => i.id === id);

// ---- A1: four refusals from the fetched branch, and admission on a matching receipt ----------

if (queue && hashMod) {
  const remote = mkBare(path.join(TMP, 'a1-remote.git'));
  const work = mkWork(path.join(TMP, 'a1-work'), remote);
  // (b) suite, no receipt
  addSuite(work, 'no-rc', null);
  // (c) receipt, then the suite edited and pushed without re-running the gate
  addSuite(work, 'mism', receiptFor(work, 'mism'));
  fs.appendFileSync(path.join(work, 'tests', 'acceptance', 'mism', 'test.js'), '// edited after the gate\n');
  git(work, ['add', '-A']); git(work, ['commit', '-qm', 'edit mism']); git(work, ['push', '-q', 'origin', 'main']);
  // (d) half-proven, correct hash
  addSuite(work, 'half', null, { push: false });
  fs.writeFileSync(path.join(work, 'tests', 'acceptance', 'half', RECEIPT), `${JSON.stringify(receiptFor(work, 'half', { verdict: 'half-proven', probeSupplied: false }), null, 2)}\n`);
  git(work, ['add', '-A']); git(work, ['commit', '-qm', 'half receipt']); git(work, ['push', '-q', 'origin', 'main']);
  // (e) red receipt, correct hash
  addSuite(work, 'good', null, { push: false });
  fs.writeFileSync(path.join(work, 'tests', 'acceptance', 'good', RECEIPT), `${JSON.stringify(receiptFor(work, 'good'), null, 2)}\n`);
  git(work, ['add', '-A']); git(work, ['commit', '-qm', 'good receipt']); git(work, ['push', '-q', 'origin', 'main']);
  // malformed receipts -> no-receipt
  addSuite(work, 'badv', null, { push: false });
  fs.writeFileSync(path.join(work, 'tests', 'acceptance', 'badv', RECEIPT), `${JSON.stringify(receiptFor(work, 'badv', { verdict: 'green' }), null, 2)}\n`);
  addSuite(work, 'badver', null, { push: false });
  fs.writeFileSync(path.join(work, 'tests', 'acceptance', 'badver', RECEIPT), `${JSON.stringify(receiptFor(work, 'badver', { gateVersion: 99 }), null, 2)}\n`);
  addSuite(work, 'trunc', null, { push: false });
  fs.writeFileSync(path.join(work, 'tests', 'acceptance', 'trunc', RECEIPT), '{"gateVersion": 1, "verdict": "red", "suiteHa');
  git(work, ['add', '-A']); git(work, ['commit', '-qm', 'malformed receipts']); git(work, ['push', '-q', 'origin', 'main']);

  const ids = ['absent', 'no-rc', 'mism', 'half', 'good', 'badv', 'badver', 'trunc'];
  const { res, bdLog } = readyWith(work, remote, ids);
  check('A1 the queue read succeeds', res.ok === true, JSON.stringify(res).slice(0, 200));
  const expect = { absent: ['no-suite', /no frozen acceptance suite/], 'no-rc': ['no-receipt', /no freeze receipt/],
    mism: ['receipt-mismatch', /receipt does not match/], half: ['half-proven', /half-proven/],
    badv: ['no-receipt', /no freeze receipt/], badver: ['no-receipt', /no freeze receipt/], trunc: ['no-receipt', /no freeze receipt/] };
  for (const [id, [kind, phrase]] of Object.entries(expect)) {
    const u = refusalOf(res, id);
    check(`A1 ${id} is refused as ${kind} with the distinguishing phrase`,
      !!u && u.refusal === kind && phrase.test(String(u.reason)) && !dispatched(res, id), JSON.stringify(u));
  }
  check('A1 a matching red receipt is dispatched', dispatched(res, 'good') && !refusalOf(res, 'good'));
  check('A1 the four kinds are pairwise distinct on the refusal objects',
    new Set((res.undispatchable || []).map((u) => u.refusal)).size === 4);
  check('A1 no Beads write reaches the seam', !/\b(update|note|close)\b/.test(bdLog), bdLog.slice(0, 200));

  // THE BRANCH-NOT-WORKING-COPY PAIR.
  const pairRemote = mkBare(path.join(TMP, 'a1-pair-remote.git'));
  const pairWork = mkWork(path.join(TMP, 'a1-pair-work'), pairRemote);
  addSuite(pairWork, 'pair', null, { push: false });
  fs.writeFileSync(path.join(pairWork, 'tests', 'acceptance', 'pair', RECEIPT), `${JSON.stringify(receiptFor(pairWork, 'pair'), null, 2)}\n`);
  git(pairWork, ['add', '-A']); git(pairWork, ['commit', '-qm', 'pair']); git(pairWork, ['push', '-q', 'origin', 'main']);
  // (f) uncommitted edit in the working copy; the pushed branch still matches its receipt
  fs.appendFileSync(path.join(pairWork, 'tests', 'acceptance', 'pair', 'test.js'), '// uncommitted planning edit\n');
  const f = readyWith(pairWork, pairRemote, ['pair']);
  check('A1 (f) an uncommitted working-copy edit does not refuse a branch that matches its receipt',
    f.res.ok === true && dispatched(f.res, 'pair'), JSON.stringify(f.res).slice(0, 200));
  // (g) the working copy is pristine at the receipt's hash while the branch gained one byte
  git(pairWork, ['checkout', '--', 'tests/acceptance/pair/test.js']);
  const other = mk(path.join(TMP, 'a1-pair-other'));
  git(other, ['clone', '-q', pairRemote, '.']);
  fs.appendFileSync(path.join(other, 'tests', 'acceptance', 'pair', 'test.js'), '// pushed from elsewhere\n');
  git(other, ['add', '-A']); git(other, ['commit', '-qm', 'one more byte']); git(other, ['push', '-q', 'origin', 'main']);
  const g = readyWith(pairWork, pairRemote, ['pair']);
  const gu = refusalOf(g.res, 'pair');
  check('A1 (g) a pristine working copy does not admit a branch whose suite moved past its receipt',
    g.res.ok === true && !!gu && gu.refusal === 'receipt-mismatch', JSON.stringify(g.res).slice(0, 200));

  const qsrc = read(path.join(ROOT, 'runner', 'queue.js')) || '';
  const hsrc = read(path.join(ROOT, 'runner', 'suite-hash.js')) || '';
  const gsrc = read(path.join(ROOT, 'scripts', 'freeze-gate.js')) || '';
  check('A1 both the gate and the dispatch gate require runner/suite-hash',
    /require\((['"])[^'"]*suite-hash(\.js)?\1\)/.test(qsrc) && /require\((['"])[^'"]*suite-hash(\.js)?\1\)/.test(gsrc));
  const spawnSites = (qsrc.match(/spawnSync\(/g) || []).length;
  const boundedSites = (qsrc.match(/spawnSync\([^;]*?gitSpawnOptions\(/g) || []).length
    + (qsrc.match(/spawnSync\([^;]*?spawnOptions\(/g) || []).length;
  check('A1 every spawnSync in runner/queue.js is built from the bounded spawn options [guard]',
    spawnSites > 0 && boundedSites >= spawnSites, `${boundedSites} of ${spawnSites}`);
  check('A1 runner/suite-hash.js bounds its own git calls with a timeout', /timeout/.test(hsrc));
} else {
  check('A1 the runner modules are unavailable', false);
}

// ---- A2: allowHalfProven — validated, defaulted, consulted only for the half-proven refusal --

if (queue && config && hashMod) {
  const write = (name, over) => {
    const p = path.join(TMP, name);
    const cfg = { ...EXAMPLE, ...over };
    fs.writeFileSync(p, JSON.stringify(cfg));
    return p;
  };
  const load = (p) => { try { return { ok: true, cfg: config.loadConfig(p) }; } catch (e) { return { ok: false, error: String(e && e.message) }; } };
  for (const [label, v] of [['a string', 'yes'], ['a number', 1], ['null', null]]) {
    const r = load(write(`cfg-${label.replace(/\s/g, '')}.json`, { allowHalfProven: v }));
    check(`A2 allowHalfProven set to ${label} is refused by name`, r.ok === false && /allowHalfProven/.test(r.error), r.error);
  }
  const t = load(write('cfg-true.json', { allowHalfProven: true }));
  const fls = load(write('cfg-false.json', { allowHalfProven: false }));
  const abs = (() => { const c = { ...EXAMPLE }; delete c.allowHalfProven; const p = path.join(TMP, 'cfg-absent.json'); fs.writeFileSync(p, JSON.stringify(c)); return load(p); })();
  check('A2 true, false and absent all load, absent as false',
    t.ok && t.cfg.allowHalfProven === true && fls.ok && fls.cfg.allowHalfProven === false && abs.ok && abs.cfg.allowHalfProven === false);
  check('A2 DEFAULTS.allowHalfProven is false', !!config.DEFAULTS && config.DEFAULTS.allowHalfProven === false);
  check('A2 run.config.example.json carries allowHalfProven: false', EXAMPLE.allowHalfProven === false);
  check('A2 the manifest schema declares top-level allowHalfProven as boolean',
    !!schema && !!schema.properties.allowHalfProven && schema.properties.allowHalfProven.type === 'boolean');
  check('A2 runner/run.js writes cfg.allowHalfProven into the manifest (structural — main() is behind the preflight)',
    /allowHalfProven:\s*cfg\.allowHalfProven/.test(read(path.join(ROOT, 'runner', 'run.js')) || ''));

  const remote = mkBare(path.join(TMP, 'a2-remote.git'));
  const work = mkWork(path.join(TMP, 'a2-work'), remote);
  addSuite(work, 'no-rc', null);
  addSuite(work, 'mism', receiptFor(work, 'mism'));
  fs.appendFileSync(path.join(work, 'tests', 'acceptance', 'mism', 'test.js'), '// edited\n');
  git(work, ['add', '-A']); git(work, ['commit', '-qm', 'edit']); git(work, ['push', '-q', 'origin', 'main']);
  addSuite(work, 'half', null, { push: false });
  fs.writeFileSync(path.join(work, 'tests', 'acceptance', 'half', RECEIPT), `${JSON.stringify(receiptFor(work, 'half', { verdict: 'half-proven', probeSupplied: false }), null, 2)}\n`);
  git(work, ['add', '-A']); git(work, ['commit', '-qm', 'half']); git(work, ['push', '-q', 'origin', 'main']);
  const on = readyWith(work, remote, ['no-rc', 'mism', 'half'], { allowHalfProven: true }).res;
  check('A2 with allowHalfProven true the half-proven suite dispatches',
    on.ok === true && dispatched(on, 'half'), JSON.stringify(on).slice(0, 200));
  check('A2 ...while no-receipt and receipt-mismatch are still refused',
    on.ok === true && !!refusalOf(on, 'no-rc') && refusalOf(on, 'no-rc').refusal === 'no-receipt'
    && !!refusalOf(on, 'mism') && refusalOf(on, 'mism').refusal === 'receipt-mismatch');
  const off = readyWith(work, remote, ['half'], { allowHalfProven: false }).res;
  check('A2 with allowHalfProven false it is refused as half-proven',
    off.ok === true && !!refusalOf(off, 'half') && refusalOf(off, 'half').refusal === 'half-proven');
} else {
  check('A2 the runner modules are unavailable', false);
}

// ---- A3: the refusal kind travels on the row and through the feed ----------------------------

if (queue && feed && runmod && schema) {
  const props = (schema.properties.tasks.items.properties) || {};
  const enumOf = props.refusal && props.refusal.enum;
  check('A3 the schema declares tasks.items.properties.refusal with the four-value enum',
    Array.isArray(enumOf) && JSON.stringify([...enumOf].sort()) === JSON.stringify([...KINDS].sort()), JSON.stringify(enumOf));
  for (const k of KINDS) {
    const row = queue.undispatchableRow(issue('x-1'), `reason for ${k}`, 'run-1', k);
    check(`A3 undispatchableRow carries refusal ${k} and only declared keys`,
      !!row && row.refusal === k && row.outcome === 'undispatchable' && Object.keys(row).every((key) => key in props),
      Object.keys(row || {}).join(','));
  }
  // The feed: an initial refusal keeps its kind with the feed off, and a re-polled one with it on.
  const initial = feed.createFeedSource([], {
    poll: () => ({ ok: true, issues: [], undispatchable: [] }), concurrency: 1, idleGraceMs: 0,
    undispatchable: [{ issue: issue('i-1'), reason: 'no freeze receipt at tests/acceptance/i-1/', refusal: 'no-receipt' }],
  });
  const left = initial.undispatchable();
  check('A3 an initial refusal keeps its kind through the feed source',
    left.length === 1 && left[0].refusal === 'no-receipt' && left[0].issue.id === 'i-1', JSON.stringify(left));
  (async () => {
    let t = 1000; const wait = async (ms) => { t += ms; };
    const polled = feed.createFeedSource([], {
      poll: () => ({ ok: true, issues: [], undispatchable: [{ issue: issue('p-1'), reason: 'receipt does not match', refusal: 'receipt-mismatch' }] }),
      concurrency: 1, idleGraceMs: 5000, pollMs: 1000, now: () => t, wait,
    });
    await runmod.drainQueue(polled, async () => ({ issueId: 'none', outcome: 'done' }), 1);
    const after = polled.undispatchable();
    check('A3 a re-polled refusal keeps its kind too', after.length === 1 && after[0].refusal === 'receipt-mismatch', JSON.stringify(after));
    finish();
  })().catch((e) => { check(`A3 the feed check threw: ${e && e.message}`, false); finish(); });
} else {
  check('A3 the runner modules are unavailable', false);
  finish();
}

// ---- A4 + A5 run after the async feed check so the exit code is honest -----------------------

function finish() {
  if (report && queue) {
    const manifestOf = (rows) => ({ runId: 'r', startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:01:00.000Z', targetRepo: 'x', tasks: rows });
    const remedy = {
      'no-suite': [/freeze/i, /freeze gate/i],
      'no-receipt': [/run the freeze gate/i, /--green|allowHalfProven/],
      'receipt-mismatch': [/run the freeze gate/i, /--green|allowHalfProven/],
      'half-proven': [/--green|allowHalfProven/, /no frozen/i],
    };
    const headings = {};
    for (const k of KINDS) {
      const row = queue.undispatchableRow(issue('x-1'), `reason (${k})`, 'run-1', k);
      const out = report.renderReport(manifestOf([row]));
      const h = (out.split('\n').find((l) => /^## x-1 — UNDISPATCHABLE — /.test(l)) || '');
      headings[k] = h;
      const body = out.slice(out.indexOf(h) + h.length);
      const [must, mustNot] = remedy[k];
      check(`A4 ${k}: heading, body, changeSummary and attemptNotes carry its remedy and not another kind's`,
        h.length > 0 && must.test(h + body) && must.test(row.changeSummary) && must.test(row.attemptNotes.join('\n'))
        && !mustNot.test(h) && !mustNot.test(body) && !mustNot.test(row.changeSummary) && !mustNot.test(row.attemptNotes.join('\n')),
        `${h} || ${row.changeSummary.slice(0, 120)}`);
    }
    check('A4 the four headings are pairwise distinct', new Set(Object.values(headings)).size === 4, JSON.stringify(headings));
    const old = report.renderReport(manifestOf([{ issueId: 'x-2', title: 't', outcome: 'undispatchable', changeSummary: 'legacy', attemptNotes: [] }]));
    check('A4 a row with no refusal renders the historic sentence', /no frozen acceptance suite on the integration branch/.test(old));
    const done = report.renderReport(manifestOf([{ issueId: 'x-3', title: 't', outcome: 'done', attempts: 1 }]));
    check('A4 a done row gains no refusal paragraph [guard]', !/Not dispatched/.test(done));
    const order = [{ issueId: 's', outcome: 'stuck' }, { issueId: 'u', outcome: 'undispatchable' }, { issueId: 't', outcome: 'tampered' }].sort(report.byScrutiny).map((r) => r.issueId).join(',');
    check('A4 scrutiny order keeps undispatchable between tampered and stuck [guard]', order === 't,u,s', order);
  } else {
    check('A4 report.js is unavailable', false);
  }

  const design = read(path.join(ROOT, 'DESIGN.md')) || '';
  const para = design.split(/\r?\n\r?\n/).find((p) => p.includes('third admission rule') && p.includes(RECEIPT));
  check('A5 DESIGN.md 4.12 has one paragraph holding both "third admission rule" and .freeze-gate.json [guard]', !!para);
  const planning = read(path.join(ROOT, 'PLANNING.md')) || '';
  const s8 = planning.slice(planning.indexOf('### 8.'));
  check('A5 PLANNING.md step 8 names the receipt', planning.indexOf('### 8.') >= 0 && s8.includes(RECEIPT));
  check('A5 docs/STATUS.md names re-gating open suites as a host obligation', /re-gat/i.test(read(path.join(ROOT, 'docs', 'STATUS.md')) || ''));
  check('A5 docs/change-log.md has a row for repo-isq', /\|\s*repo-isq\s*\|/.test(read(path.join(ROOT, 'docs', 'change-log.md')) || ''));
  const env = { ...process.env }; delete env.NODE_OPTIONS; for (const k of Object.keys(env)) if (/^PIPELINE_|^BD_/.test(k)) delete env[k];
  for (const s of ['test-dispatch-gate.sh', 'test-feed.sh', 'test-changelog.sh', 'test-sanitize.sh']) {
    const r = spawnSync('bash', [path.join(ROOT, 'scripts', s)], { cwd: ROOT, encoding: 'utf8', env });
    check(`A5 scripts/${s} exits 0`, r.status === 0, (r.stdout || '').split('\n').filter((l) => /FAIL/.test(l)).slice(0, 3).join(' | '));
  }
  const dg = spawnSync(process.execPath, [path.join(ROOT, 'tests', 'unit', 'dispatch-gate.test.js')], { cwd: ROOT, encoding: 'utf8', env });
  const oks = (dg.stdout || '').split('\n').filter((l) => /^ok - /.test(l)).length;
  check('A5 the dispatch-gate unit suite counts more than the fork point\'s 64 checks', dg.status === 0 && oks > 64, `${oks}`);

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* temp */ }
  process.exit(failed);
}
