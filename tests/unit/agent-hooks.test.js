#!/usr/bin/env node
// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// Container-hygiene checker — no tracked file configures an agent hook (DESIGN.md
// change-log rows `dogfood-onboarding` and `agent-hooks-untracked`).
//
// Why this exists. This repo is a target of its own pipeline, so every tracked file is
// cloned into a task container that has `bd` on no PATH and no network beyond the
// Anthropic endpoints. An agent hook committed here therefore fires inside that container
// and fails on every session. `ONBOARDING.md` has said "remove the hooks entry" since the
// dogfooding onboarding, and it did not hold: `bd` rewrites `.claude/settings.json`
// whenever it re-initialises, so the entry came back in a later commit and nobody noticed
// for weeks. A checklist step cannot win against a tool that regenerates the file. This
// can.
//
// The rule is about the TRACKED tree only. Hooks are wanted on the host — `bd prime` at
// session start is genuinely useful there — so the fix is never "delete them", it is
// "keep them out of git": put them in `.claude/settings.local.json`, which is git-ignored,
// and the host keeps its behaviour while the container sees nothing.
//
// What counts as a finding:
//   * any tracked file under `.claude/hooks/` or `.codex/hooks/`
//   * any tracked `.codex/hooks.json`
//   * any tracked `.claude/settings*.json` or `.codex/settings*.json` carrying a
//     non-empty `hooks` property
//
// Set AGENT_HOOKS_FIXTURE_DIR to scan a directory instead of the repo's tracked files;
// that is the seam the negative cases run through, without which "exits 0 on a clean
// tree" would be satisfied by a checker that checks nothing.
//
// Docker-free and network-free. Run from Git Bash:
//   node tests/unit/agent-hooks.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const FIXTURE = process.env.AGENT_HOOKS_FIXTURE_DIR
  ? path.resolve(process.env.AGENT_HOOKS_FIXTURE_DIR)
  : null;

let failed = 0;
const pass = (m) => console.log(`PASS  ${m}`);
const fail = (m) => { console.log(`FAIL  ${m}`); failed = 1; };

// ---- the file list -----------------------------------------------------------------
// Tracked files, or every file under the fixture. Paths are returned repo-relative with
// forward slashes so one set of patterns matches on both platforms.
function walk(dir, base, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, base, out);
    else out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

function fileList() {
  if (FIXTURE) return walk(FIXTURE, FIXTURE, []);
  const r = spawnSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) {
    fail(`could not list tracked files: ${(r.stderr || '').trim()}`);
    return [];
  }
  return (r.stdout || '').split('\0').filter(Boolean);
}

const base = FIXTURE || ROOT;
const files = fileList();
const read = (rel) => {
  try { return fs.readFileSync(path.join(base, rel), 'utf8'); } catch { return null; }
};

// ---- the rules ---------------------------------------------------------------------
const HOOK_DIR = /(^|\/)\.(claude|codex)\/hooks\//;
const HOOKS_JSON = /(^|\/)\.(claude|codex)\/hooks\.json$/;
const SETTINGS = /(^|\/)\.(claude|codex)\/settings([.][^/]+)?\.json$/;

const findings = [];

for (const rel of files) {
  if (HOOK_DIR.test(rel)) {
    findings.push(`${rel} is a committed agent hook file`);
    continue;
  }
  if (HOOKS_JSON.test(rel)) {
    findings.push(`${rel} is a committed agent hook config`);
    continue;
  }
  if (!SETTINGS.test(rel)) continue;

  const text = read(rel);
  if (text === null) {
    fail(`${rel} is listed but could not be read`);
    continue;
  }
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* handled below */ }
  if (parsed === null) {
    // Unparseable settings are not silently trusted: a hooks block hiding in a file with
    // a trailing comma would otherwise sail straight through the JSON path.
    if (/"hooks"\s*:/.test(text)) {
      findings.push(`${rel} is not valid JSON and contains a "hooks" key`);
    } else {
      fail(`${rel} is not valid JSON (cannot be checked for hooks)`);
    }
    continue;
  }
  const hooks = parsed && typeof parsed === 'object' ? parsed.hooks : undefined;
  const nonEmpty = hooks && typeof hooks === 'object' && Object.keys(hooks).length > 0;
  if (nonEmpty) {
    findings.push(`${rel} carries a non-empty "hooks" property (events: ${Object.keys(hooks).join(', ')})`);
  }
}

// ---- report ------------------------------------------------------------------------
// One PASS line per rule, so the wrapper's "checker ran N checks" is meaningful and a
// checker that silently listed nothing cannot look like a clean tree.
if (!files.length) {
  fail('no files to check — the file list came back empty');
} else {
  pass(`scanned ${files.length} ${FIXTURE ? 'fixture' : 'tracked'} files`);
}

for (const f of findings) fail(f);

if (!findings.length) {
  pass('no committed agent hook files (.claude/hooks/, .codex/hooks/)');
  pass('no committed hooks.json');
  pass('no settings file carries a "hooks" property');
  console.log('');
  console.log('Agent hooks belong in .claude/settings.local.json (git-ignored), never in a');
  console.log('tracked file: this repo is cloned into task containers that have no bd.');
}

process.exit(failed || (findings.length ? 1 : 0));
