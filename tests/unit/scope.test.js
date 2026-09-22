#!/usr/bin/env node
// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// Unit suite for the final file-scope gate — runner/scope.js, DESIGN.md §4.5
// (change-log row `repo-cl9`). Re-runnable: the sweep picks it up through
// scripts/test-scope-gate.sh. It is the half of tests/acceptance/repo-cl9/ that has to
// OUTLIVE that task — a frozen acceptance directory runs once, while this contract keeps
// holding every time the runner's scope gate changes underneath it.
//
// Plain Node, no test framework, no Docker, no network, no `bd`: run it as
// `node tests/unit/scope.test.js` from anywhere git and node exist. One line per check —
// `ok - <label>` — and a non-zero exit if any check failed. Fixtures are throwaway git
// repositories under the OS temp dir; nothing is written into this repo's own tree.
//
// WHERE THIS GOES BEYOND THE FROZEN SUITE, on purpose:
//
//   * Malformed lists the frozen test does not exercise: an EMPTY list, a DUPLICATE
//     entry, an ABSOLUTE path, and a Windows drive-rooted path — "accepts only exact
//     listed paths and rejects ... unsafe lists" is the rule and the frozen suite pins
//     only `..` traversal and absence.
//   * Deletion of a NON-listed committed file — a scope violation the git-mv case only
//     half-covers (it deletes a listed file). "rejects ... deletions" stated directly.
//   * A COMMITTED out-of-scope change (the frozen suite's runner path commits, but the
//     unit-level cases are all uncommitted) — the two changed-path sources must union.
//   * A legacy (`optional`) target that DOES carry a list still enforces it — the frozen
//     suite proves the no-list branch of optional; this proves the with-list branch.
//   * readScopePolicy reads the FORK-POINT config, not the worktree — a worktree edit to
//     scopePolicy cannot widen (or narrow) the gate.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  checkScope, readScopePolicy, parseAllowedList, isSafeRepoPath,
} = require('../../runner/scope');

let checks = 0;
const ok = (label) => { checks++; console.log(`ok - ${label}`); };
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-unit-'));

function git(dir, ...args) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return (r.stdout || '').trim();
}
function put(dir, name, content) {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
let n = 0;
function repo(config) {
  const dir = path.join(temp, `r${n++}`);
  fs.mkdirSync(dir);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'test');
  put(dir, 'pipeline.config.json', JSON.stringify(config));
  put(dir, 'src/app.ts', 'export const x = 1;\n');
  put(dir, 'docs/decisions.md', 'original\n');
  put(dir, 'src/keep.ts', 'keep\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'baseline');
  const forkPoint = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'checkout', '-qb', 'task/x');
  return { dir, forkPoint };
}
const DESC = '## Constraints\nAllowed implementation files: src/app.ts, PROJECT_STATE.md.\n';
const scopeOf = (r, description = DESC, policy = 'required') =>
  checkScope({ dir: r.dir, forkPoint: r.forkPoint, issue: { description }, policy });

try {
  // ---- parseAllowedList: the shapes that must fail closed ------------------------------
  // The list is honoured ONLY inside the Constraints section (repo-cl10), so every fixture
  // here wraps it in one; a bare line, or one under any other heading, is not a list.
  const con = (body) => `## Constraints\n${body}\n`;
  assert.strictEqual(parseAllowedList('nothing here').present, false);
  ok('a description with no list is reported absent');

  assert.deepStrictEqual(parseAllowedList(con('Allowed implementation files: a.js, b.md.')).paths, ['a.js', 'b.md']);
  ok('a clean list parses and drops the trailing period');

  // A list outside the Constraints section is NOT edit permission (§4.5, repo-cl10): a
  // Summary that names files must not license changes to them.
  assert.strictEqual(parseAllowedList('## Summary\nAllowed implementation files: a.js.\n\n## Constraints\nnone.\n').present, false);
  ok('a list outside the Constraints section does not count');

  // Two list lines are ambiguous, so they fail closed rather than picking one (repo-cl10).
  assert.strictEqual(parseAllowedList(con('Allowed implementation files: a.js.\nAllowed implementation files: b.md.')).ok, false);
  ok('duplicate list lines are rejected');

  assert.strictEqual(parseAllowedList(con('Allowed implementation files: .')).ok, false);
  ok('an empty list is malformed');

  // A stray trailing comma leaves a blank entry — malformed, never silently dropped.
  assert.strictEqual(parseAllowedList(con('Allowed implementation files: a.js, .')).ok, false);
  ok('a blank comma-list entry is malformed');

  assert.strictEqual(parseAllowedList(con('Allowed implementation files: a.js, a.js.')).ok, false);
  ok('a duplicate entry is malformed');

  assert.strictEqual(parseAllowedList(con('Allowed implementation files: ../escape.txt.')).ok, false);
  ok('a parent-traversal path is unsafe');

  assert.strictEqual(parseAllowedList(con('Allowed implementation files: /etc/passwd.')).ok, false);
  ok('an absolute path is unsafe');

  // isSafeRepoPath edge cases the parser leans on.
  assert.strictEqual(isSafeRepoPath('a/b/c.ts'), true);
  assert.strictEqual(isSafeRepoPath('../x'), false);
  assert.strictEqual(isSafeRepoPath('a/../../x'), false);   // normalises to ../x — escapes the tree
  assert.strictEqual(isSafeRepoPath('/x'), false);
  assert.strictEqual(isSafeRepoPath('C:\\x'), false);
  assert.strictEqual(isSafeRepoPath(''), false);
  ok('isSafeRepoPath admits in-tree paths and rejects traversal/absolute/drive/empty');

  // ---- checkScope: policy branches ----------------------------------------------------
  {
    const r = repo({ scopePolicy: 'required' });
    assert.strictEqual(scopeOf(r, '## Constraints\nNo file list.').ok, false);
    ok('required policy without a list fails closed');
    assert.strictEqual(scopeOf(r, '## Constraints\nNo file list.', 'optional').ok, true);
    ok('legacy (optional) policy without a list is unenforced');
  }

  // A legacy target that DOES carry a list still enforces it (§4.5).
  {
    const r = repo({ scopePolicy: 'optional' });
    put(r.dir, 'docs/decisions.md', 'unauthorized\n');
    const res = scopeOf(r, DESC, 'optional');
    assert.strictEqual(res.ok, false);
    assert.ok(res.disallowedPaths.includes('docs/decisions.md'));
    ok('optional policy WITH a list still rejects an out-of-scope change');
  }

  // Allowed-only change passes; the untouched keep.ts and config do not trip the gate.
  {
    const r = repo({ scopePolicy: 'required' });
    put(r.dir, 'src/app.ts', 'export const x = 2;\n');
    assert.strictEqual(scopeOf(r).ok, true);
    ok('a change confined to a listed file passes');
  }

  // A committed out-of-scope change is caught (the two changed-path sources must union).
  {
    const r = repo({ scopePolicy: 'required' });
    put(r.dir, 'docs/decisions.md', 'committed unauthorized\n');
    git(r.dir, 'add', '-A');
    git(r.dir, 'commit', '-qm', 'sneak a docs change past the gate');
    const res = scopeOf(r);
    assert.strictEqual(res.ok, false);
    assert.ok(res.disallowedPaths.includes('docs/decisions.md'));
    ok('a COMMITTED out-of-scope change is caught');
  }

  // Deleting a NON-listed file is a violation ("rejects ... deletions").
  {
    const r = repo({ scopePolicy: 'required' });
    fs.rmSync(path.join(r.dir, 'src/keep.ts'));
    const res = scopeOf(r);
    assert.strictEqual(res.ok, false);
    assert.ok(res.disallowedPaths.includes('src/keep.ts'));
    ok('deleting a non-listed file is rejected');
  }

  // A nested untracked file is caught (status -uall names the file, not just its dir).
  {
    const r = repo({ scopePolicy: 'required' });
    put(r.dir, 'src/sub/leak.ts', 'leak\n');
    const res = scopeOf(r);
    assert.strictEqual(res.ok, false);
    assert.ok(res.disallowedPaths.includes('src/sub/leak.ts'));
    ok('a nested untracked file is named and rejected');
  }

  // A git error must FAIL CLOSED (repo-cl10): an unreachable fork point is never an empty
  // change set — the branch we cannot diff does not get to leave the machine.
  {
    const r = repo({ scopePolicy: 'required' });
    const res = checkScope({ dir: r.dir, forkPoint: 'not-a-commit',
      issue: { description: DESC }, policy: 'required' });
    assert.strictEqual(res.ok, false);
    assert.match(String(res.reason || ''), /git|fork|diff|commit/i);
    ok('a git diff failure fails closed with a reason');
  }

  // An unusual filename (space + non-ASCII) is reported EXACTLY, never octal-escaped or
  // C-quoted (repo-cl10) — the reviewer needs the real path to find the leak.
  {
    const r = repo({ scopePolicy: 'required' });
    const unusual = 'notes/café Ω.md';
    put(r.dir, unusual, 'leak\n');
    const res = scopeOf(r);
    assert.strictEqual(res.ok, false);
    assert.ok(res.disallowedPaths.includes(unusual),
      `exact filename not preserved: ${JSON.stringify(res.disallowedPaths)}`);
    ok('an unusual filename is reported exactly');
  }

  // ---- readScopePolicy: fork-point config, never the worktree -------------------------
  {
    const r = repo({ scopePolicy: 'required' });
    assert.strictEqual(readScopePolicy(r.dir, r.forkPoint), 'required');
    // Widen it in the WORKTREE — the gate must not follow.
    put(r.dir, 'pipeline.config.json', JSON.stringify({ scopePolicy: 'optional' }));
    assert.strictEqual(readScopePolicy(r.dir, r.forkPoint), 'required');
    ok('readScopePolicy reads the fork-point config, ignoring a worktree edit');
  }
  {
    const r = repo({ defaultBranch: 'main' });                 // no scopePolicy key
    assert.strictEqual(readScopePolicy(r.dir, r.forkPoint), 'optional');
    ok('a target with no scopePolicy is legacy (optional)');
  }

  console.log(`PASS ${checks} scope-gate assertions`);
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
