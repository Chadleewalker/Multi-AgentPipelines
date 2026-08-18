#!/usr/bin/env node
// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// Re-runnable checks for the two schemas that have to agree: the verifier's result file
// (schemas/verify.schema.json, DESIGN.md §4.4) and the per-run manifest
// (schemas/run.schema.json, §4.12). The frozen acceptance suite under
// tests/acceptance/repo-4d8/ proves the fix once and is never run again — nothing under
// scripts/ ever executes an acceptance directory — so this is the copy the sweep keeps
// running.
//
// WHAT DRIFTS AND WHY IT IS SILENT: `runner/run.js` copies the verifier's `acceptance` and
// `regressions` values onto the manifest task row VERBATIM — no mapping, no filtering. The
// two enums are therefore one vocabulary written down twice, and a value added to the
// verifier alone is invisible until a run actually emits it: change-log row
// `verify-nobuffer` added `error` to verify.schema.json and left run.schema.json at three
// values, and the only symptom would have been a `run.json` failing its own ajv validation
// in scripts/test-report.sh and scripts/e2e.sh — a schema error where the truth was a
// harness fault (change-log row `repo-4d8`).
//
// Both directions are checked, on both fields. Set equality alone would be satisfied by
// NARROWING the verifier to match the manifest, which is the perverse fix: it would undo
// `verify-nobuffer` and record a killed regression run as a real failure. So `error` is
// additionally pinned present in all four enums.
//
// Docker-free, network-free, git-free and ajv-free: it reads two JSON files. The directory
// it reads them from is `SCHEMA_DRIFT_DIR` when set, otherwise <repo>/schemas — that seam
// is how a planted drifted pair proves this checker can actually go red, without which
// "exits 0 on the real schemas" would be satisfied by a checker that checks nothing
// (the CHANGELOG_FILE / SANITIZE_FIXTURE_DIR / AUDIT_RUNS_DIR precedent). Safe anywhere
// node exists, including inside a task container.
//
// Run from Git Bash:  node tests/unit/schema-drift.test.js
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const DIR = process.env.SCHEMA_DRIFT_DIR
  ? path.resolve(process.env.SCHEMA_DRIFT_DIR)
  : path.join(ROOT, 'schemas');

let failed = 0;
function ok(name, cond) {
  console.log(`${cond ? 'ok' : 'FAIL'} - ${name}`);
  if (!cond) failed = 1;
  return Boolean(cond);
}
const show = (v) => JSON.stringify(v);
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };

console.log(`# schemas read from ${DIR}`);

// Both files must be present and parse BEFORE anything is compared. A lookup into a null
// schema yields undefined on both sides, and "the two sets are equal" is then trivially
// true — the way a cross-file equality check goes vacuously green.
const runSchema = readJson(path.join(DIR, 'run.schema.json'));
const verifySchema = readJson(path.join(DIR, 'verify.schema.json'));
ok('run.schema.json parsed to an object', Boolean(runSchema) && typeof runSchema === 'object');
ok('verify.schema.json parsed to an object', Boolean(verifySchema) && typeof verifySchema === 'object');
if (!runSchema || !verifySchema) {
  console.log('FAIL - HARNESS BROKEN: a schema file is missing or unparsable, so every');
  console.log('       comparison below would be between two empty sets and would read as');
  console.log('       agreement. Refusing to report that as a pass.');
  process.exit(1);
}

// The pinned JSON paths, named once. `runner/run.js` writes the manifest's copy at
// tasks[].verification; the verifier writes its own at the top level of verify.json.
const rowSchema = runSchema.properties && runSchema.properties.tasks
  && runSchema.properties.tasks.items;
const verification = rowSchema && rowSchema.properties && rowSchema.properties.verification;
const runEnums = (verification && verification.properties) || {};
const verifyEnums = verifySchema.properties || {};

ok('run.schema.json carries a task-row verification object at properties.tasks.items.properties.verification',
  Boolean(verification) && typeof verification === 'object');

// The fields the runner copies across verbatim. Both are compared in both directions.
const FIELDS = ['acceptance', 'regressions'];

for (const field of FIELDS) {
  const runEnum = runEnums[field] && runEnums[field].enum;
  const verifyEnum = verifyEnums[field] && verifyEnums[field].enum;

  // Located and non-trivial FIRST, then compared. Asserting each side separately is what
  // makes a missing node a loud failure rather than a silent agreement.
  const runFound = ok(`run.schema.json's ${field} enum is located and holds at least 3 values (got ${show(runEnum)})`,
    Array.isArray(runEnum) && runEnum.length >= 3);
  const verifyFound = ok(`verify.schema.json's ${field} enum is located and holds at least 3 values (got ${show(verifyEnum)})`,
    Array.isArray(verifyEnum) && verifyEnum.length >= 3);
  if (!runFound || !verifyFound) continue;

  // The direction that bit: a value the verifier can emit and the manifest rejects. The
  // failing line NAMES the values, because "the enums differ" is not actionable at 3am.
  const missing = verifyEnum.filter((v) => !runEnum.includes(v));
  ok(`every ${field} value the verifier can emit is admitted by the manifest`
    + (missing.length ? ` — MISSING from run.schema.json: ${missing.map(show).join(', ')}` : ''),
    missing.length === 0);

  // And the other direction: a manifest value no verifier run can produce is dead
  // vocabulary, and usually the fossil of a rename done on one side only.
  const extra = runEnum.filter((v) => !verifyEnum.includes(v));
  ok(`the manifest admits no ${field} value the verifier cannot emit`
    + (extra.length ? ` — EXTRA in run.schema.json: ${extra.map(show).join(', ')}` : ''),
    extra.length === 0);

  ok(`the two ${field} vocabularies are exactly equal (run ${show(runEnum)} vs verify ${show(verifyEnum)})`,
    show(runEnum.slice().sort()) === show(verifyEnum.slice().sort()));

  // Set equality is satisfiable by deleting from the verifier instead of adding to the
  // manifest. That is the perverse fix, so the value `verify-nobuffer` exists to carry is
  // pinned present on BOTH sides: a killed run has no opinion, and must be neither a
  // regression (which downgrades a passing task) nor absent (which hides it).
  ok(`verify.schema.json's ${field} enum still carries "error" — a killed run reaches no verdict (change-log row \`verify-nobuffer\`)`,
    verifyEnum.includes('error'));
  ok(`run.schema.json's ${field} enum still carries "error"`,
    runEnum.includes('error'));
}

process.exit(failed);
