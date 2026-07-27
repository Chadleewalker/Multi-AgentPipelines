#!/usr/bin/env node
// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// repo-006 — the change-log shape checker (DESIGN.md §12, §3.1).
//
// Enforces the identity convention for §12's table: every row has a `Ref` cell holding a
// stable kebab-case slug, refs are unique, and no row's what-changed cell is led by a
// version number. Version numbers assigned by parallel agents collide by construction —
// this is what stops the convention drifting back.
//
// Docker-free and network-free: it reads markdown and nothing else. The file under test is
// `CHANGELOG_FILE` when set, otherwise <repo>/DESIGN.md — that seam is how the negative
// cases (a duplicate ref, a version-numbered row) are exercised against fixtures, without
// which "exits 0 on the good file" would be satisfied by a checker that checks nothing.
//
// The cross-document citation checks only run against the real DESIGN.md: a fixture has no
// living documents pointing at it, so running them there would be red for the wrong reason.
//
// Run from Git Bash:  node tests/unit/changelog.test.js
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_FILE = path.join(ROOT, 'DESIGN.md');
const FILE = process.env.CHANGELOG_FILE ? path.resolve(process.env.CHANGELOG_FILE) : DEFAULT_FILE;
const IS_REAL_DESIGN = path.resolve(FILE) === path.resolve(DEFAULT_FILE);

// The five documents a human actually reads while working, all of which used to cite
// change-log rows by version number.
const LIVING_DOCS = ['docs/STATUS.md', 'CLAUDE.md', 'PLANNING.md', 'ONBOARDING.md', 'README.md'];
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const VERSION_LED = /^\s*v[0-9]+\.[0-9]+/;
const VERSION_ANYWHERE = /\bv[0-9]+\.[0-9]+(\.[0-9]+)?\b/g;
// The pinned citation form: without a marker phrase no script can tell a citation from
// ordinary hyphenated prose or from a Beads memory key like `repo-52m-note-4`.
const CITATION = /change-log row\s+`([^`]+)`/g;

let failed = 0;
function pass(name) { console.log(`PASS  ${name}`); }
function fail(name) { console.log(`FAIL  ${name}`); failed = 1; }
function check(name, cond) { (cond ? pass : fail)(name); return cond; }
const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
// Keep evidence lines short: an unchecked ref cell can hold a whole paragraph, and an
// unbounded FAIL line buries the rest of the output in a PR body or run report.
const snip = (s, n = 40) => (String(s).length > n ? `${String(s).slice(0, n)}…` : String(s));

// A row's cells cannot be found by splitting on `|`: one row of the real table carries
// `done|partial|failed|stuck` inside a code span and so has three pipes that are not cell
// boundaries. Mask backtick spans (preserving offsets), split on what is left.
function cells(line) {
  const masked = line.replace(/`[^`]*`/g, (m) => ' '.repeat(m.length));
  const out = [];
  let start = 0;
  for (let i = 0; i < masked.length; i++) {
    if (masked[i] === '|') { out.push(line.slice(start, i)); start = i + 1; }
  }
  out.push(line.slice(start));
  const trimmed = out.map((c) => c.trim());
  if (trimmed[0] === '') trimmed.shift();
  if (trimmed[trimmed.length - 1] === '') trimmed.pop();
  return trimmed;
}

const text = read(FILE);
if (text === null) {
  fail(`change-log file is readable (${FILE})`);
  process.exit(1);
}
console.log(`== repo-006 checks: change-log identity convention (${path.relative(ROOT, FILE) || FILE}) ==`);

const lines = text.split('\n');
const start = lines.findIndex((l) => /^##\s*12\.\s*Change Log/.test(l));
if (!check('the §12 change log section exists', start >= 0)) process.exit(1);

const header = lines.slice(start).find((l) => /^\|\s*Date\s*\|/.test(l));
check('the table header names a Ref column: | Date | Ref | What changed | Why |',
  !!header && cells(header).map((c) => c.toLowerCase()).join('|') === 'date|ref|what changed|why');

const rows = [];
for (let i = start; i < lines.length; i++) {
  if (/^\|\s*20\d\d-/.test(lines[i])) rows.push({ line: i + 1, cells: cells(lines[i]) });
}
if (!check('the change log has at least one row', rows.length > 0)) process.exit(1);

// ---- shape: four cells per row, the ref second -------------------------------------
const wrongShape = rows.filter((r) => r.cells.length !== 4);
check(`every row has exactly four cells${wrongShape.length ? ` — bad rows: ${wrongShape.map((r) => r.line).join(', ')}` : ` (${rows.length} rows)`}`,
  wrongShape.length === 0);

const refs = rows.map((r) => (r.cells[1] || '').replace(/`/g, '').trim());
const whats = rows.map((r) => r.cells[2] || '');

// ---- identity: kebab-case slugs, never a date, never repeated -----------------------
const badSlug = rows.filter((r, i) => !SLUG.test(refs[i]));
check(`every ref is a kebab-case slug${badSlug.length ? ` — e.g. line ${badSlug[0].line}: "${snip(refs[rows.indexOf(badSlug[0])])}"` : ''}`,
  badSlug.length === 0);

const dateRefs = rows.filter((r, i) => /^\d{4}-\d{2}-\d{2}$/.test(refs[i]));
check(`no ref is a bare date${dateRefs.length ? ` — line ${dateRefs[0].line}` : ''}`, dateRefs.length === 0);

const seen = new Map();
const dupes = [];
refs.forEach((ref, i) => {
  if (seen.has(ref)) dupes.push(`${ref} (lines ${seen.get(ref)} and ${rows[i].line})`);
  else seen.set(ref, rows[i].line);
});
check(`refs are unique across the log${dupes.length ? ` — duplicates: ${dupes.slice(0, 3).join('; ')}` : ''}`,
  dupes.length === 0);

// ---- no row is identified by a version number any more ------------------------------
// Only the LEADING token: version mentions inside prose are history and must survive.
const versionLed = rows.filter((r, i) => VERSION_LED.test(whats[i]));
check(`no what-changed cell begins with a version token${versionLed.length ? ` — e.g. line ${versionLed[0].line}: "${snip(whats[rows.indexOf(versionLed[0])])}"` : ''}`,
  versionLed.length === 0);

// ---- the living documents cite slugs, not versions ----------------------------------
if (IS_REAL_DESIGN) {
  const refSet = new Set(refs);
  let pinnedFormSeen = false;
  for (const rel of LIVING_DOCS) {
    const doc = read(path.join(ROOT, rel));
    if (doc === null) { fail(`${rel} is readable`); continue; }
    const versions = [...new Set(doc.match(VERSION_ANYWHERE) || [])];
    check(`${rel} cites no change-log version${versions.length ? ` — found ${versions.join(', ')}` : ''}`,
      versions.length === 0);
    const cited = [...doc.matchAll(CITATION)].map((m) => m[1]);
    if (cited.length) pinnedFormSeen = true;
    const dangling = [...new Set(cited.filter((c) => !refSet.has(c)))];
    check(`${rel}: every cited slug resolves to a row${dangling.length ? ` — dangling: ${dangling.join(', ')}` : ''}`,
      dangling.length === 0);
  }
  check('at least one living document uses the pinned citation form (change-log row `<slug>`)',
    pinnedFormSeen);
}

process.exit(failed);
