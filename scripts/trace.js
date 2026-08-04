#!/usr/bin/env node
// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// Traceability ledger — the deterministic half of "the map and the territory drift"
// (docs/IDEAS.md, the 2026-08-04 entry; the disease is six other entries in that file).
//
// The convention it reads: a ticked spec checkbox carries the id of the issue that ticked
// it, as a trailing parenthesised ref —  `- [x] the thing shipped (repo-abc)`.  The edge
// is recorded at the moment it exists (the host knows the issue id at publish time), so
// nothing here ever infers a link. Everything this tool prints is derived from two places
// only: checkbox lines in markdown, and issue ids already present in git commit messages.
// No LLM anywhere near it (hard rule 7), and it is a REPORT, never a gate — it exits 0
// whatever it finds, because drift is evidence for a planning session, not a verdict
// (hard rule 5's shape, applied to scaffolding).
//
//   node scripts/trace.js report   [--prefix repo] [file.md ...]
//   node scripts/trace.js backfill [--prefix repo] [--write] [file.md ...]
//
// `report` prints three lists:
//   1. ticked boxes with no ref            — a claim with no witness
//   2. refs naming an id git has never seen — a witness that does not exist
//   3. ids in history that no ref points at — work that ticked nothing
// `backfill` recovers missing refs from history: for each ticked, unrefed box it asks git
// which commit first introduced the `[x]` on that line (git log -L, so a later prose edit
// on the same line does not fool it the way naive blame would) and takes the issue id
// from that commit's message. A box whose ticking commit names no id is reported as
// unrecoverable rather than guessed at. `--write` applies only the recovered refs,
// preserving each line's own ending (this working copy is CRLF, containers see LF —
// the guard lives here at the point of parsing, per CLAUDE.md §3.6).
//
// Defaults: spec files are every tracked *.md; the id prefix comes from
// `.beads/config.yaml`'s `issue-prefix:` (override with --prefix). Run it on a clean
// tree — backfill resolves line numbers against HEAD, so uncommitted edits to a spec
// file can shift what -L sees.
//
// Docker-free by construction; the tests drive it against throwaway git repos
// (tests/unit/trace.test.js via scripts/test-trace.sh).
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// ---- git plumbing -------------------------------------------------------------------
// Synchronous on purpose, like runner/bd.js: nothing here is hot, and interleaving two
// git children over one index buys only confusion. Bounded so a wedged git fails loudly.
function git(args, cwd) {
  const r = spawnSync('git', args, {
    cwd, encoding: 'utf8', timeout: 60000, maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) throw new Error(`git ${args[0]}: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} exited ${r.status}: ${(r.stderr || '').trim()}`);
  return r.stdout;
}

// ---- parsing ------------------------------------------------------------------------
// One checkbox item per line. Cells are trimmed at the point of parsing (CRLF host,
// LF containers); the ref is trailing-parenthesised only, so an id mentioned mid-prose
// is prose, not a claim.
const BOX_RE = /^\s*[-*] \[([ xX])\] (.*)$/;

function idRe(prefix, flags) {
  return new RegExp(`\\b${prefix}-[a-z0-9]+\\b`, flags);
}

function parseSpec(content, prefix) {
  const refTail = new RegExp(`\\((${prefix}-[a-z0-9]+)\\)\\s*$`);
  const items = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].replace(/\r$/, '').match(BOX_RE);
    if (!m) continue;
    const text = m[2].trim();
    const ref = (text.match(refTail) || [])[1] || null;
    items.push({ line: i + 1, ticked: m[1] !== ' ', text, ref });
  }
  return items;
}

// Every issue id that appears in any commit message on the current history, id → commits.
function idsInHistory(cwd, prefix) {
  const out = git(['log', '--format=%H\x1f%s\x1f%b\x1e'], cwd);
  const map = new Map();
  for (const rec of out.split('\x1e')) {
    const [hash, subject, body] = rec.split('\x1f');
    if (!hash || !hash.trim()) continue;
    const ids = new Set(`${subject}\n${body || ''}`.match(idRe(prefix, 'g')) || []);
    for (const id of ids) {
      if (!map.has(id)) map.set(id, []);
      map.get(id).push({ hash: hash.trim(), subject: (subject || '').trim() });
    }
  }
  return map;
}

// The commit that first made this line a ticked box. `git log -L` follows the line
// through edits and shows one patch block per touching commit, oldest last; we take the
// oldest block whose ADDED side contains a ticked box, so a later wording tweak (which
// also "touches" the line) is passed over instead of being blamed for the tick.
function tickCommit(cwd, file, line) {
  let out;
  try {
    out = git(['log', '-L', `${line},${line}:${file}`, '--format=%H'], cwd);
  } catch (e) {
    return null; // line not in HEAD (uncommitted edit) — caller reports, never guesses
  }
  const blocks = [];
  let cur = null;
  for (const raw of out.split('\n')) {
    const lineTxt = raw.replace(/\r$/, '');
    if (/^[0-9a-f]{40}$/.test(lineTxt)) { cur = { hash: lineTxt, added: [] }; blocks.push(cur); }
    else if (cur && lineTxt.startsWith('+')) cur.added.push(lineTxt.slice(1));
  }
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i].added.some((l) => BOX_RE.test(l.trim()) && /\[[xX]\]/.test(l))) return blocks[i].hash;
  }
  return null;
}

function commitMessage(cwd, hash) {
  return git(['show', '-s', '--format=%s%n%b', hash], cwd);
}

// ---- the two commands ---------------------------------------------------------------
const snip = (s) => (s.length > 60 ? s.slice(0, 60) + '…' : s);

function loadSpecs(cwd, files, prefix) {
  const list = files.length
    ? files
    : git(['ls-files', '*.md'], cwd).split('\n').map((f) => f.trim()).filter(Boolean);
  const specs = [];
  for (const file of list) {
    const items = parseSpec(fs.readFileSync(path.join(cwd, file), 'utf8'), prefix);
    if (items.length) specs.push({ file, items });
  }
  return specs;
}

function report(cwd, files, prefix, log) {
  const specs = loadSpecs(cwd, files, prefix);
  const history = idsInHistory(cwd, prefix);
  const all = specs.flatMap((s) => s.items.map((it) => ({ ...it, file: s.file })));
  const ticked = all.filter((it) => it.ticked);
  const unwitnessed = ticked.filter((it) => !it.ref);
  const broken = ticked.filter((it) => it.ref && !history.has(it.ref));
  const reffed = new Set(all.map((it) => it.ref).filter(Boolean));
  const unrecorded = [...history.keys()].filter((id) => !reffed.has(id)).sort();

  log(`== traceability report ==`);
  log(`scanned ${specs.length} spec file(s): ${all.length} checkbox item(s), ${ticked.length} ticked`);
  log(`-- ticked, no witness: ${unwitnessed.length} --`);
  for (const it of unwitnessed) log(`  ${it.file}:${it.line}  ${snip(it.text)}`);
  log(`-- broken refs (id never in history): ${broken.length} --`);
  for (const it of broken) log(`  ${it.file}:${it.line}  (${it.ref})`);
  log(`-- work no ref points at: ${unrecorded.length} --`);
  for (const id of unrecorded) log(`  ${id} (${history.get(id).length} commit(s))`);
  return { unwitnessed, broken, unrecorded };
}

function backfill(cwd, files, prefix, write, log) {
  const specs = loadSpecs(cwd, files, prefix);
  const recovered = [];
  const unrecoverable = [];
  for (const spec of specs) {
    for (const it of spec.items) {
      if (!it.ticked || it.ref) continue;
      const hash = tickCommit(cwd, spec.file, it.line);
      const msg = hash ? commitMessage(cwd, hash) : '';
      const id = hash ? (msg.match(idRe(prefix)) || [])[0] : null;
      if (id) recovered.push({ file: spec.file, line: it.line, id, hash });
      else unrecoverable.push({ file: spec.file, line: it.line, text: it.text, hash });
    }
  }
  log(`== backfill${write ? ' (writing)' : ' (dry run — pass --write to apply)'} ==`);
  for (const r of recovered) log(`  ${r.file}:${r.line}  + (${r.id})   from ${r.hash.slice(0, 8)}`);
  for (const u of unrecoverable) {
    log(`  ${u.file}:${u.line}  ?  no id recoverable${u.hash ? ` (ticked by ${u.hash.slice(0, 8)}, which names no issue)` : ' (line not in HEAD)'}`);
  }
  log(`recovered ${recovered.length}, unrecoverable ${unrecoverable.length}`);

  if (write && recovered.length) {
    const byFile = new Map();
    for (const r of recovered) {
      if (!byFile.has(r.file)) byFile.set(r.file, []);
      byFile.get(r.file).push(r);
    }
    for (const [file, refs] of byFile) {
      const abs = path.join(cwd, file);
      const lines = fs.readFileSync(abs, 'utf8').split('\n');
      for (const r of refs) {
        const i = r.line - 1;
        const crlf = lines[i].endsWith('\r');
        lines[i] = `${lines[i].replace(/\r$/, '').replace(/\s+$/, '')} (${r.id})${crlf ? '\r' : ''}`;
      }
      fs.writeFileSync(abs, lines.join('\n'));
      log(`wrote ${refs.length} ref(s) into ${file}`);
    }
  }
  return { recovered, unrecoverable };
}

// ---- CLI ----------------------------------------------------------------------------
function defaultPrefix(cwd) {
  try {
    const yaml = fs.readFileSync(path.join(cwd, '.beads', 'config.yaml'), 'utf8');
    for (const line of yaml.split('\n')) {
      const m = line.replace(/\r$/, '').match(/^\s*issue-prefix:\s*"?([a-z0-9]+)"?\s*$/);
      if (m) return m[1];
    }
  } catch (e) { /* fall through to the explicit error below */ }
  return null;
}

function main(argv) {
  const args = argv.slice();
  const mode = args[0] && !args[0].startsWith('-') ? args.shift() : 'report';
  let prefix = null;
  let write = false;
  const files = [];
  while (args.length) {
    const a = args.shift();
    if (a === '--prefix') prefix = args.shift();
    else if (a === '--write') write = true;
    else files.push(a);
  }
  const cwd = process.cwd();
  prefix = prefix || defaultPrefix(cwd);
  if (!prefix) { console.error('trace: no --prefix given and no .beads/config.yaml issue-prefix found'); return 2; }
  if (mode === 'report') { report(cwd, files, prefix, console.log); return 0; }
  if (mode === 'backfill') { backfill(cwd, files, prefix, write, console.log); return 0; }
  console.error(`trace: unknown mode "${mode}" (use: report | backfill [--write])`);
  return 2;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { parseSpec, idsInHistory, tickCommit, report, backfill, main };
