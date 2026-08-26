#!/usr/bin/env node
// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// FROZEN acceptance suite for repo-cfe — the change-log rows move to docs/change-log.md and
// that file, alone, is marked `merge=union` so parallel task branches can each append a row
// without conflicting.
//
// Written before any implementation exists, from the spec alone, and proven RED at the fork
// point (PLANNING.md step 4). Do not edit during a run: everything under tests/acceptance/
// is diffed against the fork point and any difference ends the task `tampered` (DESIGN.md
// §4.4).
//
// Criterion -> check mapping is in the section headers below; every criterion in the issue
// has a section here and every section names its criterion.
//
// Two things this suite deliberately does NOT do, both because they cost a run elsewhere:
//   * It never pins a PASS-line COUNT for tests/unit/changelog.test.js. The count belongs to
//     the wrapper, not the checker, and a criterion pinned to the wrong one is unreachable by
//     any correct implementation. C4 names the eleven check LINES instead, which is what
//     actually discriminates the failure it is aimed at.
//   * It never inherits git identity or git config. `pipeline/entrypoint.sh` sets the identity
//     repo-locally in /workspace, not globally, so a `git init` under the OS temp dir has no
//     author in the container and `git commit` exits "Author identity unknown" — while the
//     same test passes on a developer host. Every git call below goes through git() with an
//     explicit environment.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const CHANGELOG = path.join(ROOT, 'docs', 'change-log.md');
const DESIGN = path.join(ROOT, 'DESIGN.md');
const CHECKER = path.join(ROOT, 'tests', 'unit', 'changelog.test.js');

let failed = 0;
function check(name, cond, detail) {
  console.log(`${cond ? 'ok' : 'FAIL'} - ${name}`);
  if (!cond) { failed = 1; if (detail) console.log(`       ${String(detail).slice(0, 300)}`); }
  return cond;
}
function read(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } }

// Every git invocation supplies its own identity and config and inherits none.
const GIT_ENV = {
  PATH: process.env.PATH,
  SystemRoot: process.env.SystemRoot,
  HOME: process.env.HOME || os.tmpdir(),
  GIT_AUTHOR_NAME: 'acceptance', GIT_AUTHOR_EMAIL: 'acceptance@test.local',
  GIT_COMMITTER_NAME: 'acceptance', GIT_COMMITTER_EMAIL: 'acceptance@test.local',
  GIT_CONFIG_NOSYSTEM: '1',
};
function git(args, cwd) {
  const r = spawnSync('git', [
    '-c', 'commit.gpgsign=false',
    '-c', 'core.autocrlf=false',
    '-c', 'core.eol=lf',
    '-c', 'core.attributesFile=/dev/null',
    ...args,
  ], { cwd: cwd || ROOT, encoding: 'utf8', timeout: 120000, env: GIT_ENV });
  return { ok: r.status === 0, out: (r.stdout || ''), err: (r.stderr || ''), status: r.status };
}

// The masked-pipe splitter, inlined. A frozen test that imported a shared helper could have
// what it gates changed without its own frozen text changing (DESIGN.md §3.1), so frozen
// tests inline what they need. One row carries `done|partial|failed|stuck` inside a code
// span and therefore has 7 pipes where every other row has 5.
function cells(line) {
  let masked = '';
  let inSpan = false;
  for (const ch of String(line)) {
    if (ch === '`') { inSpan = !inSpan; masked += ' '; continue; }
    masked += inSpan && ch === '|' ? ' ' : ch;
  }
  const parts = masked.split('|');
  if (parts.length && parts[0].trim() === '') parts.shift();
  if (parts.length && parts[parts.length - 1].trim() === '') parts.pop();
  // Slice the ORIGINAL line at the mask's boundaries so cell text keeps its backticks.
  const out = [];
  let cursor = 0;
  for (const p of parts) {
    const idx = masked.indexOf(p, cursor);
    out.push(String(line).slice(idx, idx + p.length).trim());
    cursor = idx + p.length;
  }
  return out;
}

const ROW_RE = /^\|\s*20\d\d-/;
function rowsOf(text) {
  return String(text).split('\n').filter((l) => ROW_RE.test(l)).map((l) => {
    const c = cells(l);
    return { date: c[0], ref: c[1], what: c[2], why: c[3] };
  });
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-cfe-'));

// ---- C1: the rows moved, all of them, unchanged --------------------------------------
// The fork-point read is PINNED before anything is compared with it. Two empty lists are
// identical, so an unresolvable ref would otherwise make this criterion pass having compared
// nothing — which is also its permanent state once this branch merges, since
// scripts/verify-pr.sh re-runs sibling suites against later fork points that hold no rows.

const cfgRaw = read(path.join(ROOT, 'pipeline.config.json'));
let defaultBranch = 'main';
try { defaultBranch = (JSON.parse(cfgRaw || '{}').defaultBranch) || 'main'; } catch { /* keep default */ }

let forkRows = null;
let forkVia = null;
for (const base of [`origin/${defaultBranch}`, defaultBranch]) {
  const mb = git(['merge-base', 'HEAD', base]);
  if (!mb.ok) continue;
  const sha = mb.out.trim();
  const show = git(['show', `${sha}:DESIGN.md`]);
  if (!show.ok) continue;
  forkRows = rowsOf(show.out);
  forkVia = `${base} (${sha.slice(0, 8)})`;
  break;
}

const forkOk = check('C1 the fork-point DESIGN.md was read (a failed read is never a pass)',
  forkRows !== null, 'no merge-base/show succeeded for origin/' + defaultBranch + ' or ' + defaultBranch);
const floorOk = check('C1 the fork point yields at least 80 rows (pins the comparison against something real)',
  forkRows !== null && forkRows.length >= 80, forkRows === null ? 'unread' : `got ${forkRows.length} via ${forkVia}`);

const clText = read(CHANGELOG);
check('C1 docs/change-log.md exists', clText !== null);

const clRows = clText === null ? [] : rowsOf(clText);
if (forkOk && floorOk && clText !== null) {
  check('C1 docs/change-log.md holds exactly the fork-point rows, in order',
    clRows.length === forkRows.length
    && clRows.every((r, i) => r.date === forkRows[i].date && r.ref === forkRows[i].ref
      && r.what === forkRows[i].what && r.why === forkRows[i].why),
    `fork ${forkRows.length} rows, change-log ${clRows.length} rows`);
} else {
  check('C1 docs/change-log.md holds exactly the fork-point rows, in order', false,
    'skipped: prerequisites above failed');
}

const designText = read(DESIGN) || '';
check('C1 the working-tree DESIGN.md holds no rows',
  designText.split('\n').filter((l) => ROW_RE.test(l)).length === 0);

// ---- C2: the attribute resolves, for that file and nothing else ------------------------
// Ask git, never grep .gitattributes: that also proves the pattern matches the path. Ambient
// inputs are neutralised — core.attributesFile is pinned to /dev/null in git(), and
// .git/info/attributes cannot be suppressed, so it is asserted absent instead.

const infoAttrPath = git(['rev-parse', '--git-path', 'info/attributes']);
const iap = infoAttrPath.ok ? path.resolve(ROOT, infoAttrPath.out.trim()) : null;
check('C2 .git/info/attributes is absent or empty (it cannot be suppressed and would decide the answer per machine)',
  iap === null || !fs.existsSync(iap) || fs.readFileSync(iap, 'utf8').trim() === '');

const attr = git(['check-attr', 'merge', '--', 'docs/change-log.md']);
check('C2 merge=union resolves for docs/change-log.md',
  attr.ok && /docs\/change-log\.md:\s*merge:\s*union/.test(attr.out.trim()),
  attr.out.trim() || attr.err.trim());

const listed = git(['ls-files']);
const others = [];
if (listed.ok) {
  const files = listed.out.split('\n').map((s) => s.trim()).filter(Boolean);
  // -z on both sides: a tracked path containing whitespace must not word-split.
  const r = spawnSync('git', ['-c', 'core.attributesFile=/dev/null', 'check-attr', '--stdin', '-z', 'merge'],
    { cwd: ROOT, encoding: 'utf8', timeout: 120000, env: GIT_ENV, input: files.join('\0') + '\0' });
  const fields = (r.stdout || '').split('\0');
  for (let i = 0; i + 2 < fields.length; i += 3) {
    if (fields[i + 2] === 'union' && fields[i] !== 'docs/change-log.md') others.push(fields[i]);
  }
}
check('C2 no other tracked file resolves to merge=union', listed.ok && others.length === 0,
  others.slice(0, 5).join(', '));

check('C2 the .gitattributes rule says WHY union is safe here',
  /append|never edited|not edited/i.test(read(path.join(ROOT, '.gitattributes')) || ''),
  'the comment is the only thing stopping a later session pointing union at DESIGN.md');

// ---- C3: the thing the task exists for -------------------------------------------------
// Two branches each append a row; the merge must not conflict and must keep both.

function fixtureRepo(withAttributes) {
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'merge-'));
  git(['init', '-q', '-c', 'init.defaultBranch=main', '.'], dir);
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
  fs.copyFileSync(CHANGELOG, path.join(dir, 'docs', 'change-log.md'));
  if (withAttributes) fs.copyFileSync(path.join(ROOT, '.gitattributes'), path.join(dir, '.gitattributes'));
  git(['add', '-A'], dir); git(['commit', '-q', '-m', 'base'], dir);
  return dir;
}
function appendRowOn(dir, branch, ref) {
  git(['checkout', '-q', '-b', branch, 'main'], dir);
  fs.appendFileSync(path.join(dir, 'docs', 'change-log.md'),
    `| 2026-08-26 | ${ref} | appended by ${branch} | fixture |\n`);
  git(['add', 'docs/change-log.md'], dir);
  git(['commit', '-q', '-m', branch], dir);
}

if (clText !== null) {
  const dir = fixtureRepo(true);
  appendRowOn(dir, 'branch-a', 'fixture-aaa');
  appendRowOn(dir, 'branch-b', 'fixture-bbb');
  git(['checkout', '-q', 'branch-a'], dir);
  const merged = git(['merge', 'branch-b', '-m', 'merged'], dir);
  const result = read(path.join(dir, 'docs', 'change-log.md')) || '';
  check('C3 two branches each appending a row merge with git merge exiting 0',
    merged.ok, (merged.err || merged.out).split('\n').slice(0, 3).join(' / '));
  check('C3 both appended rows survive the merge',
    result.includes('fixture-aaa') && result.includes('fixture-bbb'));

  // The negative half: without the attribute the same case conflicts. This is what proves
  // C3 is measuring the attribute and not something incidental about the fixture.
  const bare = fixtureRepo(false);
  appendRowOn(bare, 'branch-a', 'fixture-ccc');
  appendRowOn(bare, 'branch-b', 'fixture-ddd');
  git(['checkout', '-q', 'branch-a'], bare);
  const conflicted = git(['merge', 'branch-b', '-m', 'merged'], bare);
  check('C3 [control] the SAME case without the attribute does conflict',
    !conflicted.ok, 'if this passes, C3 proves nothing about merge=union');
} else {
  check('C3 two branches each appending a row merge with git merge exiting 0', false, 'no docs/change-log.md');
  check('C3 both appended rows survive the merge', false, 'no docs/change-log.md');
  check('C3 [control] the SAME case without the attribute does conflict', false, 'no docs/change-log.md');
}

// ---- C4: the checker reads the new file and keeps ALL of its checks ---------------------
// CHANGELOG_FILE is deleted from the child environment rather than assumed unset: C5 below
// sets it, and any parent that exports it would otherwise silently flip IS_REAL_DESIGN and
// switch off the eleven citation checks while still exiting 0.

const cleanEnv = { ...process.env };
delete cleanEnv.CHANGELOG_FILE;
const chk = spawnSync(process.execPath, [CHECKER], { cwd: ROOT, encoding: 'utf8', timeout: 300000, env: cleanEnv });
const chkOut = `${chk.stdout || ''}${chk.stderr || ''}`;
check('C4 the checker exits 0 with no CHANGELOG_FILE set', chk.status === 0,
  chkOut.split('\n').filter((l) => /^FAIL/.test(l)).slice(0, 4).join(' / '));

const LIVING = ['docs/STATUS.md', 'CLAUDE.md', 'PLANNING.md', 'ONBOARDING.md', 'README.md'];
for (const doc of LIVING) {
  check(`C4 the citation half still runs for ${doc} (version check)`,
    chkOut.includes(`${doc} cites no change-log version`));
  check(`C4 the citation half still runs for ${doc} (slug resolution)`,
    chkOut.includes(`${doc}: every cited slug resolves to a row`));
}
check('C4 the pinned-citation-form check still runs',
  /pinned citation form/i.test(chkOut),
  'IS_REAL_DESIGN gates these eleven by comparing FILE against DEFAULT_FILE — moving one and not the other disables all of them silently');

// ---- C5: the CHANGELOG_FILE seam still discriminates ------------------------------------
// Fixtures use the heading the frozen repo-006 suite also uses, which the checker must keep
// accepting alongside the new file's own heading.

function fixtureFile(name, rows) {
  const f = path.join(tmpRoot, name);
  fs.writeFileSync(f, [
    '## 12. Change Log',
    '',
    'Rows are identified by a unique kebab-case slug in the Ref column, never a version number.',
    '',
    '| Date | Ref | What changed | Why |',
    '|---|---|---|---|',
    ...rows,
    '',
  ].join('\n'));
  return f;
}
function runChecker(file) {
  return spawnSync(process.execPath, [CHECKER],
    { cwd: ROOT, encoding: 'utf8', timeout: 300000, env: { ...process.env, CHANGELOG_FILE: file } });
}

const okFixture = fixtureFile('ok.md', ['| 2026-07-26 | fix-aaa | did a thing | because |']);
const dupFixture = fixtureFile('dup.md', [
  '| 2026-07-26 | fix-bbb | did a thing | because |',
  '| 2026-07-26 | fix-bbb | did another thing | because |',
]);
const verFixture = fixtureFile('ver.md', ['| 2026-07-26 | fix-ccc | v1.9.9: did a thing | because |']);

const okRun = runChecker(okFixture);
check('C5 a well-formed fixture is accepted (the seam is not simply always red)', okRun.status === 0,
  `${okRun.stdout || ''}`.split('\n').filter((l) => /^FAIL/.test(l)).slice(0, 3).join(' / '));
for (const [label, f] of [['duplicate ref', dupFixture], ['version-led row', verFixture]]) {
  const r = runChecker(f);
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  // Non-zero alone is not evidence — a checker that failed to start also exits non-zero.
  check(`C5 ${label}: the checker exits non-zero AND prints a FAIL line`,
    r.status !== 0 && r.status !== null && /^FAIL/m.test(out));
}

// ---- C6: section 12 survives the move ---------------------------------------------------
// Without this, an implementation that deletes section 12 outright passes everything else.

const sec12 = (designText.split(/^##\s*12\./m)[1] || '').split(/^##\s/m)[0];
check('C6 DESIGN.md still has a "## 12." change-log heading', /^##\s*12\./m.test(designText));
check('C6 section 12 still carries the slug convention', /slug/i.test(sec12));
check('C6 section 12 still carries the chronological rule', /chronolog/i.test(sec12));
check('C6 section 12 points at docs/change-log.md', sec12.includes('docs/change-log.md'));

// ---- C7: the documents that state the location name the new one -------------------------

const claude = read(path.join(ROOT, 'CLAUDE.md')) || '';
const claudeChanging = (claude.split('## Changing the design')[1] || '').split('\n## ')[0];
const readme = read(path.join(ROOT, 'README.md')) || '';
const status = read(path.join(ROOT, 'docs', 'STATUS.md')) || '';
const planning = read(path.join(ROOT, 'PLANNING.md')) || '';
const planningFreeze = (planning.split('## Spec Changes After Freeze')[1] || '').split('\n## ')[0];

check('C7 CLAUDE.md read-these-first table names docs/change-log.md',
  claude.split('## How to talk to')[0].includes('docs/change-log.md'));
check('C7 CLAUDE.md "Changing the design" names docs/change-log.md',
  claudeChanging.includes('docs/change-log.md'));
check('C7 README.md names docs/change-log.md', readme.includes('docs/change-log.md'));
check('C7 docs/STATUS.md names docs/change-log.md beside test-changelog.sh',
  status.includes('docs/change-log.md'));
check('C7 PLANNING.md names docs/change-log.md in "Spec Changes After Freeze"',
  planningFreeze.includes('docs/change-log.md'));

// ---- C8 [guard]: every pinned citation still resolves ------------------------------------

const refs = new Set(clRows.map((r) => r.ref));
let dangling = [];
for (const doc of LIVING) {
  const text = read(path.join(ROOT, doc)) || '';
  for (const m of text.matchAll(/change-log row `([^`]+)`/g)) {
    if (!refs.has(m[1])) dangling.push(`${doc}:${m[1]}`);
  }
}
check('C8 [guard] every pinned change-log citation resolves to a row in docs/change-log.md',
  clText !== null && dangling.length === 0, dangling.slice(0, 6).join(', '));

// ---- teardown: best effort, never a verdict ---------------------------------------------
try { fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 3 }); } catch { /* ignore */ }

process.exit(failed);
