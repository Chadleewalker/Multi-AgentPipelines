#!/usr/bin/env node
// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// Publication-hygiene checker — nothing in the tracked tree identifies the author's
// machine, another project, or a credential (DESIGN.md §6, change-log row
// `publish-sanitize-followup`).
//
// This repo is public and is used on private work. The boundary that keeps both true is:
// the repo documents the *machinery*, never the *work done with it*. That boundary is prose
// in ONBOARDING.md and a rule nobody can apply reliably by eye, so this is the scaffolding
// that enforces it. It exists because eyes already failed twice on the same file — see
// "Why bytes, not text" below.
//
// Two classes of check:
//   * Generic, always on, committed here. Absolute user paths, real email addresses,
//     credential shapes. These are universal, so publishing them costs nothing.
//   * Project-specific, optional, host-only. A denylist of private names lives in
//     `.sanitize-denylist` at the repo root, which is git-ignored — committing a list of
//     the private things you must not mention would publish the list of private things.
//     Copy `.sanitize-denylist.example` and fill it in; absent, those checks are skipped
//     with a notice rather than failing, so a fresh clone is still green.
//
// Why bytes, not text. `tests/acceptance/repo-006/test.js` contains a literal NUL byte, so
// git classifies it as binary and `git grep` skips it by default — which is exactly how a
// private project name survived a hand sanitize pass AND the first pass of the audit that
// went looking for it. Every file is read as a Buffer and scanned via latin1, so no file is
// ever skipped for being "binary". The patterns are all ASCII, so latin1 is lossless here.
//
// Docker-free and network-free: it reads tracked files and nothing else. The sweep
// discovers its wrapper by glob (scripts/test-*.sh).
//
// Set SANITIZE_FIXTURE_DIR to scan a directory instead of the repo's tracked files; that is
// the seam the negative cases run through, without which "exits 0 on a clean tree" would be
// satisfied by a checker that checks nothing.
//
// Run from Git Bash:  node tests/unit/sanitize.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const FIXTURE = process.env.SANITIZE_FIXTURE_DIR ? path.resolve(process.env.SANITIZE_FIXTURE_DIR) : null;

let failed = 0;
function pass(name) { console.log(`PASS  ${name}`); }
function fail(name) { console.log(`FAIL  ${name}`); failed = 1; }
function check(name, cond) { (cond ? pass : fail)(name); return cond; }
function note(msg) { console.log(`NOTE  ${msg}`); }

// Evidence lines have to be short: a match can land inside a minified blob or a long prose
// cell, and a checker that dumps a whole paragraph into a PR body is its own leak.
const snip = (s) => {
  const one = String(s).replace(/[\r\n\t]+/g, ' ').trim();
  return one.length > 70 ? one.slice(0, 70) + '…' : one;
};

// ---- the file list ------------------------------------------------------------------
// Tracked files only. Untracked and git-ignored files are host-only by construction
// (.env.pipeline, run.config.<project>.json) and are not published, so scanning them
// would report findings that cannot leak and train the reader to ignore this suite.
function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.git') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

function trackedFiles() {
  if (FIXTURE) return walk(FIXTURE).map((p) => ({ abs: p, rel: path.relative(FIXTURE, p).split(path.sep).join('/') }));
  const r = spawnSync('git', ['-C', ROOT, 'ls-files', '-z'], { encoding: 'buffer' });
  if (r.status !== 0) return null;
  return String(r.stdout.toString('utf8'))
    .split('\0')
    .filter(Boolean)
    .map((rel) => ({ abs: path.join(ROOT, rel), rel }));
}

const files = trackedFiles();
if (files === null) {
  fail('git ls-files succeeded (needed to enumerate what is actually published)');
  process.exit(1);
}
check(`enumerated ${files.length} files to scan`, files.length > 0);

// Read as bytes. latin1 maps every byte 1:1 to a char and never throws, so a NUL, a lone
// 0x80, or a truncated UTF-8 sequence cannot make a file unscannable.
const contents = new Map();
for (const f of files) {
  try { contents.set(f.rel, fs.readFileSync(f.abs).toString('latin1')); }
  catch { /* unreadable (symlink, permissions) — reported by the count check above */ }
}

// ---- rules ---------------------------------------------------------------------------
// Each rule is {name, re, allow}. `allow` filters matches that are legitimate: the MSYS
// path-conversion bug is documented by quoting the literal rewritten path, test fixtures
// use reserved example domains, and this repo's own public URL names its author.
const RULES = [
  // A Windows drive is ONE letter. Without the lookbehind, `https://github.com/x` matches
  // as drive `s` — which is how the first draft of this rule reported nine false hits on
  // ordinary URLs. The lookbehind is this defence, not decoration.
  {
    name: 'no absolute user-home paths',
    re: /(?<![A-Za-z])[A-Za-z]:[\\/]{1,2}Users[\\/]{1,2}[A-Za-z0-9._-]+|\/home\/[a-z][a-z0-9._-]*|\/Users\/[A-Za-z][A-Za-z0-9._-]*/g,
    // /home/node and /home/runner are container/CI accounts, not a person's workstation.
    allow: (m) => /^\/home\/(node|runner|user)\b/.test(m),
  },
  {
    name: 'no absolute paths outside the standard toolchain',
    re: /(?<![A-Za-z])[A-Za-z]:[\\/]{1,2}[A-Za-z0-9._ -]+[\\/]{1,2}[A-Za-z0-9._ -]+/g,
    // What leaks is a *specific* layout — real directory names off a real drive. Docs and
    // templates legitimately need to show the shape of a path, and they signal that with a
    // placeholder segment (`path/to`, a literal `...`, an angle-bracket slot) or by rooting
    // the example in a generic scratch directory. Those carry no information about any
    // machine, so allowing them is what keeps this rule specific enough to stay on.
    allow: (m) => /[\\/]{1,2}(path[\\/]{1,2}to|\.\.\.|tmp)(?:[\\/]{1,2})?/i.test(m) || /[<>]/.test(m)
      || /^[A-Za-z]:[\\/]{1,2}(?:Windows[\\/]{1,2}System32|Program Files[\\/]{1,2}(?:Git|nodejs|Docker|GitHub CLI))\b/i.test(m),
  },
  {
    name: 'no real email addresses',
    re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    allow: (m, context) => {
      if (/@(test\.local|example\.(com|org|net|test|invalid)|localhost)$/i.test(m)
        || /^noreply@anthropic\.com$/i.test(m)) return true;
      const before = context.text.slice(Math.max(0, context.index - 100), context.index);
      const after = context.text.slice(context.index + m.length, context.index + m.length + 1);
      // These are transport authorities, not mailbox addresses: scp-style Git SSH and
      // URL userinfo. Require their delimiter/context so prose mail at the same host still fires.
      return (after === ':' && /^git@github\.com$/i.test(m))
        || (after === '/' && /(?:https?|ssh):\/\/[^\s/]*$/i.test(before));
    },
  },
  {
    name: 'no credential-shaped strings',
    re: /\bsk-ant-[A-Za-z0-9_-]{8,}|\bghp_[A-Za-z0-9]{20,}|\bgho_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}|\bAKIA[0-9A-Z]{16}\b|-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
    allow: () => false,
  },
];

for (const rule of RULES) {
  const hits = [];
  for (const [rel, text] of contents) {
    // Fresh lastIndex per file: these are /g regexes reused across the loop.
    rule.re.lastIndex = 0;
    let m;
    while ((m = rule.re.exec(text)) !== null) {
      if (rule.allow(m[0], { rel, text, index: m.index })) continue;
      const line = text.slice(0, m.index).split('\n').length;
      hits.push(`${rel}:${line} ${snip(m[0])}`);
      if (hits.length > 8) break;
    }
    if (hits.length > 8) break;
  }
  check(`${rule.name}${hits.length ? ` — ${hits.length} hit(s): ${hits.slice(0, 3).join(' | ')}` : ''}`,
    hits.length === 0);
}

// ---- host-only denylist ---------------------------------------------------------------
// One term per line, blank lines and #-comments ignored. Terms are matched
// case-insensitively as plain substrings, not regexes: the point is to name a project, and
// a name that happens to contain a regex metacharacter should not silently stop matching.
const DENYLIST = path.join(ROOT, '.sanitize-denylist');
let terms = [];
if (!FIXTURE && fs.existsSync(DENYLIST)) {
  terms = fs.readFileSync(DENYLIST, 'utf8')
    .split('\n')
    // trim() each line: the working copy is CRLF on the reference host and LF everywhere
    // else, and a stray \r would be scanned for as part of the term.
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
} else if (FIXTURE && process.env.SANITIZE_DENY_TERM) {
  terms = [process.env.SANITIZE_DENY_TERM.trim()];
}

if (!terms.length) {
  note('.sanitize-denylist absent or empty — project-name checks skipped (see the file header)');
} else {
  const hits = [];
  for (const term of terms) {
    const needle = term.toLowerCase();
    for (const [rel, text] of contents) {
      const idx = text.toLowerCase().indexOf(needle);
      if (idx < 0) continue;
      const line = text.slice(0, idx).split('\n').length;
      hits.push(`${rel}:${line} (${snip(term)})`);
    }
  }
  check(`no denylisted project names in ${terms.length} term(s)${hits.length ? ` — ${hits.slice(0, 3).join(' | ')}` : ''}`,
    hits.length === 0);
}

// ---- the host-only files really are untracked -----------------------------------------
// A secret that is git-ignored is safe; the failure mode is someone `git add -f`-ing one.
if (!FIXTURE) {
  const tracked = new Set(files.map((f) => f.rel));
  const MUST_BE_UNTRACKED = ['.env.pipeline', '.env.Project', '.sanitize-denylist'];
  const leaked = MUST_BE_UNTRACKED.filter((p) => tracked.has(p));
  check(`host-only files are untracked${leaked.length ? ` — tracked: ${leaked.join(', ')}` : ''}`,
    leaked.length === 0);
  const cfgs = [...tracked].filter((p) => /^run\.config\..+\.json$/.test(p) && p !== 'run.config.example.json');
  check(`no run.config.<project>.json is tracked${cfgs.length ? ` — ${cfgs.join(', ')}` : ''}`,
    cfgs.length === 0);
}

process.exit(failed);
