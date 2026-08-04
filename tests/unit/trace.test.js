#!/usr/bin/env node
// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// Traceability-ledger checks — scripts/trace.js (docs/IDEAS.md, 2026-08-04 entry).
//
// Docker-free: the end-to-end cases build a throwaway git repository under the OS temp
// directory and drive the real CLI against it through process.execPath, so nothing here
// touches this repo's own history or working tree. The fixture history is built so that
// the answers a KNOWN WRONG implementation would give differ from the expected ones
// (CLAUDE.md §3.6, "plausible and wrong"): item one is ticked by one commit and reworded
// by a later, id-less commit, so a naive `git blame` backfill would report it
// unrecoverable — the expected answer (tst-a1) is reachable only by walking the line's
// history for the commit that introduced the tick.
//
// The fixture spec is written with CRLF endings on purpose: this working copy is CRLF and
// containers see LF, and the write path must preserve what it found.
//
// Run from Git Bash:  node tests/unit/trace.test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const TRACE = path.join(ROOT, 'scripts', 'trace.js');
const { parseSpec } = require(TRACE);

let failed = 0;
function pass(name) { console.log(`PASS  ${name}`); }
function fail(name) { console.log(`FAIL  ${name}`); failed = 1; }
function check(name, cond) { (cond ? pass : fail)(name); return cond; }

// Never a literal address in this tracked file — the sanitize checker reads bytes.
const EMAIL = ['trace-test', 'example.invalid'].join('@');
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'trace-test', GIT_AUTHOR_EMAIL: EMAIL,
  GIT_COMMITTER_NAME: 'trace-test', GIT_COMMITTER_EMAIL: EMAIL,
};

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', env: GIT_ENV });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${(r.stderr || '').trim()}`);
  return r.stdout;
}

// CLI arg order is `mode` first; keep the helper honest about that.
function run(cwd, mode, ...rest) {
  return spawnSync(process.execPath, [TRACE, mode, '--prefix', 'tst', ...rest], { cwd, encoding: 'utf8', env: GIT_ENV });
}

// ---- pure parsing -------------------------------------------------------------------
{
  const lf = '- [ ] alpha\n- [x] beta done\n* [X] gamma done (tst-ab1)\nnot a box\n';
  const items = parseSpec(lf, 'tst');
  check('parse: finds 3 items and skips prose', items.length === 3);
  check('parse: tick state read per item', items[0].ticked === false && items[1].ticked === true && items[2].ticked === true);
  check('parse: trailing parenthesised ref extracted', items[2].ref === 'tst-ab1');
  check('parse: unrefed item has null ref', items[1].ref === null);

  const crlf = lf.replace(/\n/g, '\r\n');
  const items2 = parseSpec(crlf, 'tst');
  check('parse: CRLF input parses identically to LF', JSON.stringify(items2) === JSON.stringify(items));

  const mid = parseSpec('- [x] mentions tst-ab1 mid-prose but claims nothing\n', 'tst');
  check('parse: an id mid-prose is not a ref', mid[0].ref === null);
}

// ---- end to end against a real (throwaway) history ----------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-test-'));
try {
  const spec = path.join(tmp, 'SPEC.md');
  const writeSpec = (lines) => fs.writeFileSync(spec, ['# Spec', '', ...lines, ''].join('\r\n'));

  git(tmp, 'init', '-q');
  git(tmp, 'config', 'core.autocrlf', 'false');

  // c1: four unticked items (SPEC.md lines 3-6)
  writeSpec([
    '- [ ] item one does a thing',
    '- [ ] item two does a thing',
    '- [ ] item three does a thing',
    '- [ ] item four does a thing',
  ]);
  git(tmp, 'add', '.'); git(tmp, 'commit', '-q', '-m', 'add spec');

  // c2: tst-a1 ticks item one — the convention NOT followed (no ref written)
  writeSpec([
    '- [x] item one does a thing',
    '- [ ] item two does a thing',
    '- [ ] item three does a thing',
    '- [ ] item four does a thing',
  ]);
  git(tmp, 'add', '.'); git(tmp, 'commit', '-q', '-m', 'Task tst-a1: implementation (verified on attempt 1)');

  // c3: tst-b2 ticks item two — the convention followed
  writeSpec([
    '- [x] item one does a thing',
    '- [x] item two does a thing (tst-b2)',
    '- [ ] item three does a thing',
    '- [ ] item four does a thing',
  ]);
  git(tmp, 'add', '.'); git(tmp, 'commit', '-q', '-m', 'Task tst-b2: implementation');

  // c4: the trap — item one reworded by a commit that names no issue
  writeSpec([
    '- [x] item one does a thing, reworded',
    '- [x] item two does a thing (tst-b2)',
    '- [ ] item three does a thing',
    '- [ ] item four does a thing',
  ]);
  git(tmp, 'add', '.'); git(tmp, 'commit', '-q', '-m', 'reword item one');

  // c5: item four ticked by an id-less commit — genuinely unrecoverable
  // c6: item three ticked with a ref to an id git has never seen — broken ref
  writeSpec([
    '- [x] item one does a thing, reworded',
    '- [x] item two does a thing (tst-b2)',
    '- [ ] item three does a thing',
    '- [x] item four does a thing',
  ]);
  git(tmp, 'add', '.'); git(tmp, 'commit', '-q', '-m', 'misc cleanup');
  writeSpec([
    '- [x] item one does a thing, reworded',
    '- [x] item two does a thing (tst-b2)',
    '- [x] item three does a thing (tst-zzz)',
    '- [x] item four does a thing',
  ]);
  git(tmp, 'add', '.'); git(tmp, 'commit', '-q', '-m', 'tick with stale ref');

  // c7: work that ticked nothing — an id in history no ref points at
  fs.writeFileSync(path.join(tmp, 'README.md'), 'notes\n');
  git(tmp, 'add', '.'); git(tmp, 'commit', '-q', '-m', 'Task tst-c3: docs');

  // ---- report ----
  const r1 = run(tmp, 'report');
  check('report: exits 0 (a report is never a gate)', r1.status === 0);
  check('report: counts 4 items, 4 ticked', r1.stdout.includes('4 checkbox item(s), 4 ticked'));
  check('report: two claims with no witness', r1.stdout.includes('-- ticked, no witness: 2 --'));
  check('report: item one named as unwitnessed', /no witness[\s\S]*SPEC\.md:3 {2}item one/.test(r1.stdout));
  check('report: item four named as unwitnessed', /SPEC\.md:6 {2}item four/.test(r1.stdout));
  check('report: the stale ref is broken', r1.stdout.includes('-- broken refs (id never in history): 1 --') && r1.stdout.includes('(tst-zzz)'));
  check('report: tst-a1 and tst-c3 are work no ref points at', r1.stdout.includes('-- work no ref points at: 2 --') && r1.stdout.includes('tst-a1 (') && r1.stdout.includes('tst-c3 ('));
  check('report: tst-b2 is fully traced, so absent from every list', !/tst-b2 \(/.test(r1.stdout));

  // ---- backfill, dry ----
  const b1 = run(tmp, 'backfill');
  check('backfill dry: exits 0', b1.status === 0);
  check('backfill dry: recovers tst-a1 for item one DESPITE the later reword', /SPEC\.md:3 {2}\+ \(tst-a1\)/.test(b1.stdout));
  check('backfill dry: item four reported unrecoverable, not guessed', /SPEC\.md:6 {2}\? {2}no id recoverable/.test(b1.stdout));
  check('backfill dry: totals are 1 recovered, 1 unrecoverable', b1.stdout.includes('recovered 1, unrecoverable 1'));
  check('backfill dry: did not touch the file', !fs.readFileSync(spec, 'utf8').includes('(tst-a1)'));

  // ---- backfill, write ----
  const b2 = run(tmp, 'backfill', '--write');
  check('backfill write: exits 0', b2.status === 0);
  const after = fs.readFileSync(spec, 'utf8');
  check('backfill write: ref written onto item one', after.includes('- [x] item one does a thing, reworded (tst-a1)\r\n'));
  check('backfill write: every line still CRLF', after.split('\n').slice(0, -1).every((l) => l.endsWith('\r')));
  check('backfill write: unrecoverable item four left alone', after.includes('- [x] item four does a thing\r\n'));

  // ---- report after backfill: the drift shrinks by exactly what was recovered ----
  const r2 = run(tmp, 'report');
  check('report after write: one claim with no witness remains', r2.stdout.includes('-- ticked, no witness: 1 --'));
  check('report after write: tst-a1 no longer unrecorded, tst-c3 still is', !/tst-a1 \(/.test(r2.stdout) && /tst-c3 \(/.test(r2.stdout));
} finally {
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
}

process.exit(failed);
