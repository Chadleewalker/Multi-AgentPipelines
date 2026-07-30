#!/usr/bin/env node
// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// Spec lint — the mechanical checks that run BEFORE any critic reads a draft spec
// (DESIGN.md §3.2, "Below the panel", move 3).
//
// A critic costs a `claude -p` call and fresh context; these cost nothing and need no
// judgment, so anything they can catch should never reach the panel. Findings are reported
// with a file:line, and every one gets a disposition in the planning draft the same way a
// critic's `details[]` entry does (PLANNING.md steps 2 and 5) — the check reports, a human
// decides. It is not a gate on a run: nothing here can change a task's outcome (hard rule 5
// is about run time, but the same reflex applies — this is planning-time scaffolding).
//
// Rule implemented here:
//
//   frozen-path — does any line of the spec name a path in the target's `frozenPaths`?
//     Such a criterion orders the agent to edit a file the verifier diffs against the fork
//     point, so the task ends `tampered` on every attempt, before any test result exists.
//     Two drafts did exactly this in the first real panel run.
//
// Rules declared in §3.2 and NOT implemented yet: the fork-point red gate (move 1) and the
// config-key check (move 3b, which needs a new `pipeline.config.json` field). They belong in
// this file when they are built; RULES is the registry they slot into.
//
// Why `frozenPaths` and not the verifier's whole frozen set: `pipeline/verify.js` freezes
// `['tests/acceptance/', ...config.frozenPaths]`, but `tests/acceptance/` is where planning
// legitimately writes — every spec names it, so including it would make this fire on all of
// them and be turned off within a week. `frozenPaths` beyond it is the half planning has no
// reason to touch. `assertFrozenSetUnchanged` in the suite pins that reasoning against the
// verifier so the two cannot drift apart silently.
//
// Usage:
//   node scripts/spec-lint.js --repo <target-repo> <spec-file> [<spec-file> ...]
//   node scripts/spec-lint.js --frozen tools/a.sh,tools/b.sh <spec-file>
//
// Exit codes: 0 clean, 1 findings, 2 could not run (bad arguments, unreadable config).
'use strict';
const fs = require('fs');
const path = require('path');

// --- the rules -------------------------------------------------------------------------

// Escape a literal path for use inside a RegExp. Paths carry `.` and `/` and, on a config
// written on Windows, possibly `\`.
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Build one matcher per frozen path. A trailing slash means a directory: anything beneath it
// counts. Otherwise the path matches on its own, with an optional `./` prefix, and must not
// be a prefix of a longer path segment (`tools/run.sh` must not match `tools/run.sh.bak`).
//
// Separators are matched as either `/` or `\` so a config written with Windows separators
// still matches a spec written with POSIX ones — the working copy on the reference host is
// CRLF and mixed-separator prose is normal in it.
function matcherFor(frozenPath) {
  const clean = frozenPath.replace(/^\.\//, '').replace(/\\/g, '/');
  const isDir = clean.endsWith('/');
  const body = escapeRe(isDir ? clean.slice(0, -1) : clean).replace(/\//g, '[/\\\\]');
  // A path is "named" when it appears not preceded by a word character, path separator or
  // dash — so `run-regression.sh` inside `tools/run-regression.sh` is one hit, not two, and
  // `my-tools/run.sh` does not match `tools/run.sh`.
  const lead = '(?<![\\w/\\\\.-])';
  const tail = isDir ? '[/\\\\]\\S*' : '(?![\\w.-])';
  return { frozenPath, re: new RegExp(`${lead}(?:\\./)?${body}${tail}`) };
}

// Lines that are the *document's own* scaffolding rather than spec text. A planning draft
// quotes `pipeline.config.json` while explaining the freeze, and a spec may cite this very
// rule; neither is a criterion ordering anyone to edit anything.
const IS_QUOTED_CONFIG = /"frozenPaths"|frozenPaths\s*[:=]/;

function frozenPathFindings(text, frozenPaths, file = '<spec>') {
  const matchers = (frozenPaths || [])
    // `tests/acceptance/` is where planning writes the tests; naming it is normal and
    // required, so it is never a finding even when a config lists it redundantly.
    .filter((p) => {
      const c = String(p).replace(/^\.\//, '').replace(/\\/g, '/');
      return c !== 'tests/acceptance' && c !== 'tests/acceptance/';
    })
    .map(matcherFor);
  if (!matchers.length) return [];

  const findings = [];
  // Split on \r?\n: the working copy here is CRLF and every container sees LF, so the line
  // splitter has to say which it means (CLAUDE.md, "guard line endings at the point of
  // parsing"). Reported line numbers are 1-indexed to match an editor.
  const lines = String(text).split(/\r?\n/);
  lines.forEach((line, i) => {
    if (IS_QUOTED_CONFIG.test(line)) return;
    for (const m of matchers) {
      if (m.re.test(line)) {
        findings.push({
          rule: 'frozen-path',
          file,
          line: i + 1,
          frozenPath: m.frozenPath,
          text: line.trim().slice(0, 160),
        });
      }
    }
  });
  return findings;
}

const RULES = { 'frozen-path': frozenPathFindings };

// --- config ------------------------------------------------------------------------------

// The frozen set as the verifier defines it, minus the acceptance directory — see the header.
// Reads the working tree, not a fork-point commit: this runs at planning time, before any
// branch exists, so there is no fork point to read from and nothing here judges a run.
function frozenPathsFor(repoRoot) {
  const configPath = path.join(repoRoot, 'pipeline.config.json');
  const raw = fs.readFileSync(configPath, 'utf8');
  const config = JSON.parse(raw);
  if (config.frozenPaths != null && !Array.isArray(config.frozenPaths)) {
    throw new Error(`${configPath}: frozenPaths must be an array`);
  }
  return config.frozenPaths || [];
}

// --- CLI ---------------------------------------------------------------------------------

function main(argv) {
  const files = [];
  let repo = null;
  let frozen = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repo') { repo = argv[++i]; }
    else if (a === '--frozen') { frozen = String(argv[++i] || '').split(',').filter(Boolean); }
    else if (a === '-h' || a === '--help') { usage(); return 0; }
    else if (a.startsWith('-')) { console.error(`spec-lint: unknown option ${a}`); return 2; }
    else { files.push(a); }
  }
  if (!files.length) { usage(); return 2; }
  if (frozen == null) {
    if (!repo) { console.error('spec-lint: one of --repo or --frozen is required'); return 2; }
    try { frozen = frozenPathsFor(path.resolve(repo)); }
    catch (e) { console.error(`spec-lint: ${e.message}`); return 2; }
  }

  if (!frozen.length) {
    console.log('spec-lint: the target declares no frozenPaths — nothing to check');
    return 0;
  }

  let findings = [];
  for (const f of files) {
    let text;
    try { text = fs.readFileSync(f, 'utf8'); }
    catch (e) { console.error(`spec-lint: ${e.message}`); return 2; }
    findings = findings.concat(frozenPathFindings(text, frozen, f));
  }

  if (!findings.length) {
    console.log(`spec-lint: clean — no criterion names any of ${frozen.length} frozen path(s)`);
    return 0;
  }
  // One line per finding, `file:line` first so an editor and a terminal can both jump to it.
  for (const f of findings) {
    console.log(`${f.file}:${f.line}  [${f.rule}] names frozen path '${f.frozenPath}'`);
    console.log(`    ${f.text}`);
  }
  console.log(
    `\nspec-lint: ${findings.length} finding(s). A criterion naming a frozen path orders the`
    + '\nagent to tamper: the verifier diffs those paths against the fork point, so the task ends'
    + '\n"tampered" on every attempt before any test result exists. Rewrite the criterion, or'
    + '\nrecord a disposition for it in the planning draft (PLANNING.md step 2).',
  );
  return 1;
}

function usage() {
  console.log('usage: node scripts/spec-lint.js --repo <target-repo> <spec-file> [...]');
  console.log('       node scripts/spec-lint.js --frozen a.sh,b.sh <spec-file> [...]');
}

module.exports = { frozenPathFindings, frozenPathsFor, matcherFor, RULES, main };

if (require.main === module) process.exit(main(process.argv.slice(2)));
