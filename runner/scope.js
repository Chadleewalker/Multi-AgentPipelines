// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// Final file-scope gate — DESIGN.md §4.3, §4.5 (repo-cl9, change-log row `repo-cl9`).
// The HOST, never the container, decides whether a finished branch may leave the
// machine. A target opts in with `scopePolicy: "required"` in its FORK-POINT config
// (read like the verifier reads its config, so a worktree edit cannot widen it); a task
// then needs one explicit `Allowed implementation files:` list in its Constraints. The
// final branch is compared to its fork commit — committed, uncommitted, untracked,
// deleted and renamed paths alike — and only the exact listed files may have changed.
//
// Deterministic scaffolding, no LLM (hard rule 7). Node built-ins only, so the runner's
// Docker-free suites can exercise it (tests/unit/scope.test.js).
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const git = (dir, args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
function gitLines(dir, args) {
  const r = git(dir, args);
  if (r.status !== 0) return [];
  // Guard line endings at the point of parsing (§3.6 CRLF rule): trim each cell.
  return (r.stdout || '').split('\n').map((l) => l.replace(/\r$/, '')).filter(Boolean);
}

// The allowed-files list, parsed out of the issue's Constraints. One structured line —
// `Allowed implementation files: a/b.js, c/d.md.` — never a design reference (§4.5:
// naming a file in the design is not permission to edit it). Returns:
//   { present:false }                          no such line at all
//   { present:true, ok:false, reason }         malformed / duplicate / unsafe
//   { present:true, ok:true, paths:[...] }     a clean, safe, deduplicated list
function parseAllowedList(description) {
  const text = String(description || '');
  const m = /Allowed implementation files:\s*(.+)/.exec(text);
  if (!m) return { present: false };
  // Strip a single trailing sentence period, then split the comma list.
  const body = m[1].replace(/\r$/, '').trim().replace(/\.$/, '');
  const paths = body.split(',').map((s) => s.trim()).filter(Boolean);
  if (!paths.length) return { present: true, ok: false, reason: 'the allowed-files list is empty' };
  if (new Set(paths).size !== paths.length) {
    return { present: true, ok: false, reason: 'the allowed-files list contains duplicates' };
  }
  const unsafe = paths.filter((p) => !isSafeRepoPath(p));
  if (unsafe.length) {
    return { present: true, ok: false, reason: `unsafe path(s) in the allowed-files list: ${unsafe.join(', ')}` };
  }
  return { present: true, ok: true, paths };
}

// A path is safe iff it names something INSIDE the repo: relative, no `..` traversal, no
// absolute or drive-rooted form. Anything else is a way to authorise an edit outside the
// tree the gate can see, so it fails closed.
function isSafeRepoPath(p) {
  if (!p || typeof p !== 'string') return false;
  if (path.isAbsolute(p)) return false;
  if (/^[a-zA-Z]:[\\/]/.test(p)) return false;                 // Windows drive-rooted
  const normalised = path.posix.normalize(p.replace(/\\/g, '/'));
  if (normalised === '..' || normalised.startsWith('../')) return false;
  if (normalised.startsWith('/')) return false;
  return true;
}

// Every path that differs between the fork commit and the final branch — committed,
// staged, unstaged, untracked, deleted, renamed. Two sources, each CRLF-safe:
//   * `git diff --name-only <fork> HEAD` is blob-to-blob, immune to autocrlf (§3.6: a
//     worktree diff on a CRLF checkout reports every file — a commit-to-commit diff does
//     not).
//   * `git status --porcelain` compares through git's own eol filters, so an unmodified
//     file on a CRLF checkout is NOT reported. `--no-renames` splits a rename into its
//     delete and add, so the (possibly out-of-scope) destination is named explicitly.
function changedPaths(dir, forkPoint) {
  const set = new Set();
  for (const p of gitLines(dir, ['diff', '--name-only', '--no-renames', forkPoint, 'HEAD'])) set.add(p);
  for (const line of gitLines(dir, ['status', '--porcelain', '--no-renames', '-uall'])) {
    let p = line.slice(3).trim();
    if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
    const arrow = p.indexOf(' -> ');
    if (arrow >= 0) p = p.slice(arrow + 4);
    if (p) set.add(p);
  }
  return [...set];
}

// The scope policy, read from the FORK-POINT pipeline.config.json (never the working
// tree — the same discipline the verifier uses so the gate cannot be widened in-run).
// 'required' when the frozen config opts in; 'optional' (legacy) otherwise.
function readScopePolicy(dir, forkPoint) {
  const r = git(dir, ['show', `${forkPoint}:pipeline.config.json`]);
  if (r.status === 0) {
    try {
      const cfg = JSON.parse(r.stdout);
      if (cfg && cfg.scopePolicy === 'required') return 'required';
    } catch { /* an unreadable frozen config falls back to legacy */ }
  }
  return 'optional';
}

// The gate itself. `policy` is passed explicitly (the frozen acceptance test drives it
// directly); the runner derives it with readScopePolicy() first.
//
//   required  — a valid, safe, explicit list is mandatory; its absence fails the task.
//   optional  — a legacy target: NO list means no enforcement, but a list that IS present
//               is still validated and enforced (§4.5: a stray list never becomes a
//               licence to change anything).
//
// Returns { ok, disallowedPaths, allowedPaths?, reason? }. disallowedPaths is always an
// array; on a list-validity failure it is empty and `reason` explains why.
function checkScope({ dir, forkPoint, issue, policy }) {
  const list = parseAllowedList(issue && issue.description);

  if (!list.present) {
    if (policy === 'required') {
      return { ok: false, disallowedPaths: [], reason: 'scopePolicy is required but the task has no "Allowed implementation files:" list' };
    }
    return { ok: true, disallowedPaths: [] };            // legacy target, no list, unenforced
  }
  if (!list.ok) {
    return { ok: false, disallowedPaths: [], reason: list.reason };
  }

  const allowed = new Set(list.paths);
  const disallowedPaths = changedPaths(dir, forkPoint).filter((p) => !allowed.has(p)).sort();
  if (disallowedPaths.length) {
    return {
      ok: false,
      disallowedPaths,
      allowedPaths: list.paths,
      reason: `changed path(s) outside the allowed list: ${disallowedPaths.join(', ')}`,
    };
  }
  return { ok: true, disallowedPaths: [], allowedPaths: list.paths };
}

module.exports = { checkScope, readScopePolicy, parseAllowedList, isSafeRepoPath, changedPaths };
