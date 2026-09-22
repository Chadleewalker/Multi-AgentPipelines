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

// Run git and FAIL CLOSED (§4.5, repo-cl10): a non-zero status is an error to surface,
// never a silently-empty result. Returns stdout on success; throws (marked .gitFailed) on
// failure so the caller can turn "we could not diff the branch" into a scope block rather
// than a false "nothing changed".
function gitOrThrow(dir, args) {
  const r = git(dir, args);
  if (r.status !== 0) {
    const e = new Error(`git ${args.join(' ')} failed against the fork point: ${(r.stderr || '').trim() || 'non-zero exit'}`);
    e.gitFailed = true;
    throw e;
  }
  return r.stdout || '';
}

// The body of the issue's `Constraints` section, and ONLY that section (§4.5, repo-cl10).
// The allowed list is honoured nowhere else: a Summary or a design reference that happens
// to name files is not edit permission, so a list under any other heading does not count.
// Returns the text between the `Constraints` heading and the next heading (or EOF), or ''.
function constraintsSection(description) {
  const lines = String(description || '').split('\n');
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^#{1,6}\s+Constraints\b/i.test(lines[i].trim())) { start = i + 1; break; }
  }
  if (start < 0) return '';
  const body = [];
  for (let i = start; i < lines.length; i++) {
    if (/^#{1,6}\s+\S/.test(lines[i].trim())) break;    // the next heading ends the section
    body.push(lines[i]);
  }
  return body.join('\n');
}

// The allowed-files list, parsed out of the issue's Constraints section. One structured
// line — `Allowed implementation files: a/b.js, c/d.md.` — never a design reference (§4.5:
// naming a file in the design is not permission to edit it), and never more than once
// (repo-cl10: two lists are ambiguous, so they fail closed). Returns:
//   { present:false }                          no such line in Constraints
//   { present:true, ok:false, reason }         malformed / duplicate / unsafe
//   { present:true, ok:true, paths:[...] }     a clean, safe, deduplicated list
function parseAllowedList(description) {
  const section = constraintsSection(description);
  const listLines = section.split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .filter((l) => /^\s*Allowed implementation files:/i.test(l));
  if (listLines.length === 0) return { present: false };
  if (listLines.length > 1) {
    return { present: true, ok: false, reason: 'the allowed-files list appears on more than one line (duplicate lists)' };
  }
  const m = /Allowed implementation files:\s*(.*)$/i.exec(listLines[0]);
  // Strip a single trailing sentence period, then split the comma list. A blank entry —
  // e.g. a stray trailing comma — is malformed and must NOT be silently dropped (repo-cl10).
  const body = (m ? m[1] : '').trim().replace(/\.\s*$/, '');
  const paths = body.split(',').map((s) => s.trim());
  if (!paths.length || paths.some((s) => s === '')) {
    return { present: true, ok: false, reason: 'the allowed-files list is empty or has a blank entry' };
  }
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
// staged, unstaged, untracked, deleted, renamed. Two sources, each CRLF-safe, and both
// read with `-z` + `core.quotePath=false` so a filename with a space or a non-ASCII
// character is preserved EXACTLY (repo-cl10) rather than octal-escaped or C-quoted:
//   * `git diff --name-only <fork> HEAD` is blob-to-blob, immune to autocrlf (§3.6: a
//     worktree diff on a CRLF checkout reports every file — a commit-to-commit diff does
//     not).
//   * `git status --porcelain` compares through git's own eol filters, so an unmodified
//     file on a CRLF checkout is NOT reported. `--no-renames` splits a rename into its
//     delete and add, so the (possibly out-of-scope) destination is named explicitly.
// Either git call failing THROWS (via gitOrThrow) — a branch we cannot diff against its
// fork point must not read as an empty change set (repo-cl10, fail closed).
function changedPaths(dir, forkPoint) {
  const set = new Set();
  const diff = gitOrThrow(dir, ['-c', 'core.quotePath=false', 'diff', '--name-only', '--no-renames', '-z', forkPoint, 'HEAD']);
  for (const p of diff.split('\0')) { if (p) set.add(p); }
  const status = gitOrThrow(dir, ['-c', 'core.quotePath=false', 'status', '--porcelain', '--no-renames', '-uall', '-z']);
  // -z porcelain records are NUL-separated `XY <path>` — two status chars, a space, then
  // the exact path bytes (no quoting under -z). --no-renames means one path per record.
  for (const rec of status.split('\0')) {
    if (rec.length < 4) continue;                       // 'XY ' + at least one path char
    const p = rec.slice(3);
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
  let changed;
  try {
    changed = changedPaths(dir, forkPoint);
  } catch (e) {
    // Fail CLOSED (§4.5, repo-cl10): a git error is never an empty change set. A branch we
    // cannot diff against its fork commit does not get to leave the machine.
    return {
      ok: false,
      disallowedPaths: [],
      allowedPaths: list.paths,
      reason: `could not diff the branch against its fork commit: ${e.message}`,
    };
  }
  const disallowedPaths = changed.filter((p) => !allowed.has(p)).sort();
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

// Early admission (§4.5, repo-cl10): the list REQUIREMENT alone, checked BEFORE any agent
// work. It validates only the list's presence and shape — never the diff, which does not
// exist yet. A `required` target with a missing, malformed, duplicate or unsafe list is
// refused before a container ever launches: there is nothing an agent could do to make an
// invalid list valid, and launching one would burn a usage window to reach the same block.
// A legacy (`optional`) target admits a task with no list, but still rejects an invalid one.
// Returns { ok:true, allowedPaths? } or { ok:false, reason }.
function admitScope({ issue, policy }) {
  const list = parseAllowedList(issue && issue.description);
  if (!list.present) {
    if (policy === 'required') {
      return { ok: false, reason: 'scopePolicy is required but the task has no "Allowed implementation files:" list' };
    }
    return { ok: true };                                 // legacy target, no list — nothing to admit
  }
  if (!list.ok) return { ok: false, reason: list.reason };
  return { ok: true, allowedPaths: list.paths };
}

module.exports = { checkScope, admitScope, readScopePolicy, parseAllowedList, isSafeRepoPath, changedPaths };
