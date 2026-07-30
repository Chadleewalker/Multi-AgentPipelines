#!/usr/bin/env node
// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// Checks for `scripts/spec-lint.js` — the pre-critic mechanical checks (DESIGN.md §3.2,
// "Below the panel", move 3a; change-log row `spec-lint-frozen-paths`).
//
// Docker-free and network-free: it builds its fixtures as strings in memory and reads two
// tracked files (`pipeline/verify.js`, `pipeline.config.json`). Safe to run anywhere,
// including inside a task container. The sweep discovers its wrapper by glob.
//
// The shape of this suite is deliberate. "The lint exits 0 on a clean spec" is satisfied by
// a lint that never fires, so every rule here is exercised from BOTH sides: a fixture that
// must produce a finding, and a near-miss fixture that must not. The near-misses are the
// half that keeps the tool switched on — a check that fires on every spec gets disabled.
//
// Run from Git Bash:  node tests/unit/spec-lint.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const { frozenPathFindings, frozenPathsFor } = require('../../scripts/spec-lint.js');

const ROOT = path.resolve(__dirname, '..', '..');
let failed = 0;
const pass = (n) => console.log(`PASS  ${n}`);
const fail = (n, why) => { console.log(`FAIL  ${n}${why ? ` — ${why}` : ''}`); failed = 1; };
const check = (n, cond, why) => { (cond ? pass : (x) => fail(x, why))(n); return cond; };

const FROZEN = ['tools/run-regression.sh', 'tools/run-acceptance.sh'];

// --- it fires on the case that caused the failure ----------------------------------------

// Almost verbatim the criterion two drafts carried in the first real panel run: it orders
// the agent to edit a script the verifier diffs against the fork point.
const TAMPER_ORDER = [
  '## Done means',
  '',
  '1. The provenance checker exists at `tools/check-assets.sh`.',
  '2. The checker is invoked by `tools/run-regression.sh` and fails the suite on a gap.',
  '3. Every committed asset traces to a row in CREDITS.md.',
].join('\n');

const hits = frozenPathFindings(TAMPER_ORDER, FROZEN, 'draft.md');
check('a criterion naming a frozen path is reported', hits.length === 1,
  `expected 1 finding, got ${hits.length}`);
check('the finding points at the right line', hits[0] && hits[0].line === 4,
  hits[0] ? `line ${hits[0].line}, expected 4` : 'no finding');
check('the finding names which frozen path', hits[0] && hits[0].frozenPath === 'tools/run-regression.sh');
check('the finding carries the offending text', hits[0] && /run-regression/.test(hits[0].text || ''));

// --- it does NOT fire on the cases that would turn it off --------------------------------

// Every spec names the acceptance directory; that is where planning writes the tests. A
// check that fires on all of them is a check someone deletes.
const NORMAL_SPEC = [
  '## Done means',
  '',
  '1. Tests live at `tests/acceptance/repo-abc/` and run via the project verifyCommand.',
  '2. `runner/queue.js` exports readyQueue() and drops epics.',
].join('\n');
check('the acceptance directory is never a finding',
  frozenPathFindings(NORMAL_SPEC, ['tests/acceptance/', ...FROZEN], 'draft.md').length === 0);

// A near-miss on both sides of the path: a longer basename and a longer parent directory.
const NEAR_MISS = [
  'The old copy at `tools/run-regression.sh.bak` may be deleted.',
  'Add `my-tools/run-regression.sh` for the local harness.',
  'See `vendor/tools/run-regression.shim` for prior art.',
].join('\n');
const nm = frozenPathFindings(NEAR_MISS, FROZEN, 'draft.md');
check('a longer basename does not match (run-regression.sh.bak)', !nm.some((f) => f.line === 1),
  'suffix match leaked');
check('a longer parent does not match (my-tools/)', !nm.some((f) => f.line === 2),
  'prefix boundary leaked');
check('a different extension does not match (.shim)', !nm.some((f) => f.line === 3),
  'extension boundary leaked');

// A draft that quotes the config while explaining the freeze is documentation, not an order.
const QUOTES_CONFIG = '  "frozenPaths": ["tools/run-regression.sh"],';
check('a line quoting frozenPaths is not a finding',
  frozenPathFindings(QUOTES_CONFIG, FROZEN, 'draft.md').length === 0);

// --- line endings ------------------------------------------------------------------------

// The working copy on the reference host is CRLF and every container sees LF. A splitter
// that assumes one reports every line number after the first as wrong.
const CRLF = TAMPER_ORDER.split('\n').join('\r\n');
const crlfHits = frozenPathFindings(CRLF, FROZEN, 'draft.md');
check('CRLF input yields the same finding', crlfHits.length === 1);
check('CRLF input yields the same line number', crlfHits[0] && crlfHits[0].line === 4,
  crlfHits[0] ? `line ${crlfHits[0].line}, expected 4` : 'no finding');
check('the reported text carries no stray CR', crlfHits[0] && !/\r/.test(crlfHits[0].text || ''));

// Windows separators in the config still match POSIX separators in the prose.
check('a backslash-separated frozen path still matches',
  frozenPathFindings('invoked by tools/run-regression.sh', ['tools\\run-regression.sh']).length === 1);

// --- the drift pin -----------------------------------------------------------------------

// The lint checks `config.frozenPaths` and deliberately NOT the acceptance directory, which
// is only correct while the verifier's frozen set is exactly those two parts. If the
// verifier ever freezes a third thing, this lint silently stops covering it — so pin the
// verifier's own literal rather than trusting the comment in spec-lint.js. Asserting the
// value against something independent, not merely that the lint runs.
const verifySrc = fs.readFileSync(path.join(ROOT, 'pipeline', 'verify.js'), 'utf8');
check("the verifier's frozen set is still acceptance-dir + frozenPaths",
  /const frozen = \[\s*'tests\/acceptance\/',\s*\.\.\.\(config\.frozenPaths \|\| \[\]\)\s*\]/.test(verifySrc),
  'pipeline/verify.js changed its frozen set — spec-lint.js must be re-checked against it');

// --- reading a real config ---------------------------------------------------------------

const own = frozenPathsFor(ROOT);
check('frozenPathsFor reads this repo\'s config', Array.isArray(own) && own.length >= 1,
  `got ${JSON.stringify(own)}`);
check('this repo\'s frozen runner is in it', own.includes('tools/run-acceptance.sh'));

// A target that declares no frozenPaths is legal (the field is optional — §3.4) and must
// produce no findings rather than an error.
check('a config with no frozenPaths yields no findings',
  frozenPathFindings(TAMPER_ORDER, []).length === 0);

process.exit(failed);
