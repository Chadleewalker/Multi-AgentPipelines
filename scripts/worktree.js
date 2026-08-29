#!/usr/bin/env node
// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// One folder per agent session — create, list and remove git worktrees safely
// (DESIGN.md §6.2, change-log row `parallel-sessions`).
//
// The problem this exists for: N interactive agent sessions pointed at ONE checkout share
// one set of files and one staging area, so a `git add -A` in session B commits session A's
// half-finished work under B's message, and a `git checkout --` in C destroys it outright.
// Both have happened. A worktree gives each session its own folder and its own branch over
// one shared history, which makes the collision impossible rather than merely discouraged.
//
// Three things this does that `git worktree add` alone does not, each of which cost
// something to learn:
//
//   1. It CARRIES the git-ignored host-only files a fresh worktree would otherwise lack.
//      A worktree checks out tracked files only, so `.env.pipeline`, `run.config.*.json`
//      and `.sanitize-denylist` are simply absent, and a session discovers this as a
//      confusing failure some minutes later. The list is declared per project in
//      `.worktree-carry`; absent, nothing is carried and that is said out loud.
//   2. It REFUSES to carry the run evidence directory. `runs/` holds every report and the
//      local observer mirror of the host-global lock (§4.12). Copied into a second worktree
//      it forks the corpus and gives dashboard/sweep readers a false ownership view. Named
//      in `.worktree-carry`, `runs/` is refused with the reason, not skipped quietly.
//   3. It REFUSES to remove a worktree that still holds work. Uncommitted changes, untracked
//      files, or commits not on the remote all block removal, because the whole point of the
//      tool is that one session cannot discard another's work — and a removal tool that
//      cheerfully deletes a folder is the same hazard wearing a different hat.
//
// Deliberately NOT here: launching runs, merging, pushing, deleting branches. A branch
// outlives its worktree on purpose; a PR is the handoff boundary and merging is the user's.
//
// Zero dependencies, node built-ins only, and it spawns nothing but `git`. Runs the same in
// PowerShell and Git Bash, which is why it is Node rather than a .ps1/.sh pair.
//
// Usage:
//   node scripts/worktree.js new <slug> [--from <branch>] [--root <dir>] [--no-carry]
//   node scripts/worktree.js list
//   node scripts/worktree.js remove <slug> [--force]
//
// Seams for the test suite (tests/unit/worktree.test.js), which builds throwaway
// repositories under the OS temp dir and needs git and node only:
//   WORKTREE_ROOT   parent directory for new worktrees, overriding the in-repo default
//   WORKTREE_GIT    the git binary to spawn
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const GIT = process.env.WORKTREE_GIT || 'git';

// Every git call is built here, so the timeout and the encoding are stated once. A `git`
// that never returns fails loudly instead of parking the session — the `repo-sls`
// precedent, applied to the one other binary this repo spawns.
function git(args, cwd) {
  const r = spawnSync(GIT, args, {
    cwd,
    encoding: 'utf8',
    timeout: 60000,
    windowsHide: true,
  });
  if (r.error) return { ok: false, out: '', err: String(r.error.message || r.error) };
  if (r.status !== 0) return { ok: false, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
  return { ok: true, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

function die(msg) {
  console.error(`worktree: ${msg}`);
  process.exit(1);
}

// The container directory session folders go in, inside the main checkout. One name, used
// by the tool that creates them and named in the `.gitignore` line that makes it safe.
const NEST = '.worktrees';

// Does git ignore this path? Asked of git rather than matched against the name, so that
// "the repository ignores the folder I am about to fill" is a fact rather than a hope.
// A `git` that cannot answer counts as "not ignored": the failure mode being avoided is a
// nested worktree the repository can see, so uncertainty resolves towards refusing.
function ignoredByGit(mainRoot, target) {
  const rel = path.relative(mainRoot, target).split(path.sep).join('/');
  if (!rel || rel.startsWith('..')) return true;
  const r = git(['check-ignore', '-q', '--', rel], mainRoot);
  return r.ok;
}

// ---- locating the main checkout ------------------------------------------------------
// `--git-common-dir` is the shared `.git` every worktree points at, so this resolves to the
// SAME main checkout whether called from the main checkout or from inside a worktree. That
// matters: the host-only files being carried live in the main checkout, and a session that
// spawns a worktree from inside a worktree would otherwise copy a copy.
function mainCheckout(cwd) {
  const common = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd);
  if (!common.ok) return null;
  const gitDir = common.out.replace(/\\/g, '/');
  if (!/\/\.git\/?$/.test(gitDir)) {
    // A bare repository, or a layout with no working copy above the git dir.
    return null;
  }
  return path.resolve(gitDir.replace(/\/\.git\/?$/, ''));
}

// ---- slugs ---------------------------------------------------------------------------
// The slug is the folder name, the branch name and how the session is referred to out loud,
// so it is constrained to what is safe in all three at once: no path separators, no leading
// dash (which git would read as a flag), and nothing git refuses in a ref.
function validSlug(slug) {
  return typeof slug === 'string'
    && /^[a-z0-9][a-z0-9._-]*$/.test(slug)
    && !slug.endsWith('.')
    && !slug.includes('..');
}

// ---- the carry list ------------------------------------------------------------------
// Host-only files a worktree needs but git will never check out. Newline-delimited,
// `#` comments, blank lines ignored. Relative to the main checkout, always.
//
// `runs/` and `.git` are refused rather than skipped. A quiet skip reads as "there was
// nothing to do"; the whole reason the refusal exists is that copying `runs/` looks
// reasonable and breaks an invariant three files away (§4.12's run corpus and observer).
const NEVER_CARRY = new Map([
  ['runs', 'holds the run evidence corpus and lock observer mirror (DESIGN.md §4.12) — a second copy forks reports and gives readers a false ownership view. Launch runs from the main checkout only.'],
  ['.git', 'is the shared repository itself; the worktree already points at it.'],
]);

function readCarryList(mainRoot) {
  const file = path.join(mainRoot, '.worktree-carry');
  if (!fs.existsSync(file)) return { present: false, entries: [] };
  const entries = fs.readFileSync(file, 'utf8')
    .split('\n')
    // The working copy on the reference host is CRLF while a container sees LF, so the
    // guard goes at the point of parsing (CLAUDE.md's line-endings rule).
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  return { present: true, entries };
}

function copyRecursive(from, to) {
  const st = fs.statSync(from);
  if (st.isDirectory()) {
    fs.mkdirSync(to, { recursive: true });
    for (const name of fs.readdirSync(from)) copyRecursive(path.join(from, name), path.join(to, name));
  } else {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
}

function carry(mainRoot, treeRoot) {
  const { present, entries } = readCarryList(mainRoot);
  const carried = [];
  const missing = [];
  const refused = [];
  for (const entry of entries) {
    const normal = entry.replace(/\\/g, '/').replace(/\/+$/, '');
    const top = normal.split('/')[0];
    if (NEVER_CARRY.has(top)) {
      refused.push({ entry: normal, why: NEVER_CARRY.get(top) });
      continue;
    }
    if (path.isAbsolute(normal) || normal.split('/').includes('..')) {
      refused.push({ entry: normal, why: 'is outside the checkout; carry entries are repo-relative.' });
      continue;
    }
    const src = path.join(mainRoot, normal);
    if (!fs.existsSync(src)) { missing.push(normal); continue; }
    copyRecursive(src, path.join(treeRoot, normal));
    carried.push(normal);
  }
  return { present, carried, missing, refused };
}

// ---- worktree inventory --------------------------------------------------------------
// `--porcelain` is the stable machine format; the human `git worktree list` columns are not
// promised to stay put. Records are blank-line separated, `key value` per line.
function inventory(cwd) {
  const r = git(['worktree', 'list', '--porcelain'], cwd);
  if (!r.ok) return null;
  const records = [];
  let current = {};
  for (const raw of r.out.split('\n')) {
    const line = raw.trim();
    if (!line) { if (current.worktree) records.push(current); current = {}; continue; }
    const sp = line.indexOf(' ');
    const key = sp === -1 ? line : line.slice(0, sp);
    const value = sp === -1 ? true : line.slice(sp + 1);
    current[key] = value;
  }
  if (current.worktree) records.push(current);
  return records.map((rec) => ({
    path: path.resolve(String(rec.worktree).replace(/\\/g, '/')),
    branch: typeof rec.branch === 'string' ? rec.branch.replace(/^refs\/heads\//, '') : null,
    head: typeof rec.HEAD === 'string' ? rec.HEAD : null,
    bare: rec.bare === true,
    detached: rec.detached === true,
  }));
}

// Dirty means "holds work someone has not committed", and that has to include UNTRACKED
// files: a new test file nobody has added yet is exactly the kind of work this tool exists
// to protect. `--porcelain` with the default untracked mode reports both.
function dirtyFiles(treeRoot) {
  const r = git(['status', '--porcelain'], treeRoot);
  if (!r.ok) return null;
  return r.out ? r.out.split('\n').map((l) => l.trim()).filter(Boolean) : [];
}

// Commits reachable from HEAD and from no remote-tracking ref — work that exists only in
// this folder, so removing the folder loses it. `--remotes` covers every remote, not just
// origin.
//
// The no-remote case is answered FIRST and separately. `--remotes` with no remotes
// configured expands to nothing, which turns `git log HEAD --not <nothing>` into "every
// commit in the repository", and the tool would refuse to remove any worktree of a
// local-only project forever. "No remote" is not evidence of unpushed work, so it reports
// none and lets the uncommitted-changes check do the protecting.
function unpushedCommits(treeRoot) {
  const remotes = git(['remote'], treeRoot);
  if (!remotes.ok) return null;
  if (!remotes.out) return [];
  const r = git(['log', '--oneline', 'HEAD', '--not', '--remotes'], treeRoot);
  if (!r.ok) return null;
  return r.out ? r.out.split('\n').filter(Boolean) : [];
}

// ---- commands ------------------------------------------------------------------------

function cmdNew(slug, opts, cwd) {
  if (!slug) die('new needs a slug: node scripts/worktree.js new <idea-name>');
  if (!validSlug(slug)) {
    die(`"${slug}" is not a usable name. Use lower-case letters, digits, dots, dashes and underscores, starting with a letter or digit — it becomes both a folder name and a branch name.`);
  }

  const mainRoot = mainCheckout(cwd);
  if (!mainRoot) die('not inside a git repository with a working copy.');

  const explicitRoot = opts.root
    ? path.resolve(opts.root)
    : (process.env.WORKTREE_ROOT ? path.resolve(process.env.WORKTREE_ROOT) : null);
  const root = explicitRoot || path.join(mainRoot, NEST);

  // Inside the checkout by default, in one ignored container directory. Twenty session
  // folders scattered through the projects directory is its own kind of unusable, and
  // every one of them is a copy of THIS repository, so this is where they belong.
  //
  // Nesting was originally refused for one specific reason: a worktree inside the
  // repository shows up in `git status` as a mountain of untracked files, which is exactly
  // the noise that gets `git add -A` typed. Ignoring the container directory answers that
  // reason, so the check below is now that the ignore is really in place — asked of git
  // rather than assumed, because a nested worktree in a repository that had stopped
  // ignoring it would bring the original hazard back silently and at twenty folders.
  //
  // Under an explicit --root the folder keeps the repository prefix in its name: one
  // sitting beside unrelated projects has to say which project it belongs to, while one
  // inside the repository already has.
  const leaf = explicitRoot ? `${path.basename(mainRoot)}-${slug}` : slug;
  const treeRoot = path.join(root, leaf);
  if (fs.existsSync(treeRoot)) die(`${treeRoot} already exists. Pick another name, or remove it first.`);

  const inside = path.resolve(treeRoot).startsWith(path.resolve(mainRoot) + path.sep);
  if (inside && !ignoredByGit(mainRoot, treeRoot)) {
    die(
      `refusing to create a worktree at ${treeRoot}: this repository does not ignore that path, so every file in the new folder would appear as untracked in the main checkout.\n` +
      `        Add a line reading ${NEST}/ to .gitignore, or pass --root <dir> to put the folder outside the repository.`
    );
  }

  // The base branch, resolved rather than guessed. A literal fallback to 'main' is what
  // change-log row `repo-5yu` records as catastrophic for a `master` project, so the chain
  // ends in an abort with the remedy named.
  let base = opts.from;
  if (!base) {
    const head = git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], mainRoot);
    if (head.ok && head.out) base = head.out.replace(/^origin\//, '');
  }
  if (!base) {
    die('could not work out the default branch. Pass it: --from <branch> (usually main or master).');
  }

  const hasOrigin = git(['remote', 'get-url', 'origin'], mainRoot).ok;
  let startPoint = base;
  if (hasOrigin) {
    const fetched = git(['fetch', 'origin', base], mainRoot);
    if (fetched.ok) startPoint = `origin/${base}`;
    else console.log(`note: could not fetch origin/${base} (${fetched.err.split('\n')[0]}); branching from the local ${base}.`);
  }

  const added = git(['worktree', 'add', '-b', slug, treeRoot, startPoint], mainRoot);
  if (!added.ok) die(`git worktree add failed: ${added.err || added.out}`);

  const carried = carry(mainRoot, treeRoot);

  console.log(`worktree: ${treeRoot}`);
  console.log(`branch:   ${slug}  (off ${startPoint})`);
  if (!carried.present) {
    console.log('carried:  nothing — no .worktree-carry in the main checkout.');
  } else {
    console.log(carried.carried.length ? `carried:  ${carried.carried.join(', ')}` : 'carried:  nothing (every entry was missing or refused)');
    for (const m of carried.missing) console.log(`  missing: ${m} — not in the main checkout, so nothing was copied.`);
    for (const r of carried.refused) console.log(`  refused: ${r.entry} — ${r.why}`);
  }
  console.log('');
  console.log('Open your agent session with that folder as its working directory.');
  console.log(`When the work is ready: commit named paths, push, open a PR from ${slug}.`);
  return 0;
}

function cmdList(cwd) {
  const mainRoot = mainCheckout(cwd);
  if (!mainRoot) die('not inside a git repository with a working copy.');
  const trees = inventory(mainRoot);
  if (!trees) die('could not read the worktree list.');

  for (const t of trees) {
    const isMain = path.resolve(t.path) === path.resolve(mainRoot);
    const files = dirtyFiles(t.path);
    const unpushed = unpushedCommits(t.path);
    const state = files === null
      ? 'unreadable'
      : (files.length ? `${files.length} uncommitted` : 'clean');
    const ahead = unpushed === null ? '' : (unpushed.length ? `, ${unpushed.length} unpushed` : '');
    const label = t.branch || (t.detached ? 'detached' : '?');
    console.log(`${isMain ? '*' : ' '} ${label.padEnd(28)} ${state}${ahead}   ${t.path}`);
  }
  if (trees.length === 1) {
    console.log('');
    console.log('Only the main checkout. Every parallel session should have its own:');
    console.log('  node scripts/worktree.js new <idea-name>');
  } else {
    console.log('');
    console.log('* is the main checkout — run the pipeline from there, never from a worktree.');
  }
  return 0;
}

function cmdRemove(slug, opts, cwd) {
  if (!slug) die('remove needs a slug: node scripts/worktree.js remove <idea-name>');
  const mainRoot = mainCheckout(cwd);
  if (!mainRoot) die('not inside a git repository with a working copy.');

  const trees = inventory(mainRoot);
  if (!trees) die('could not read the worktree list.');

  // Match on branch first, then on folder name, so both `remove <branch>` and
  // `remove <folder>` land on the same worktree — a session knows its idea by one name.
  const wanted = trees.filter((t) => path.resolve(t.path) !== path.resolve(mainRoot)
    && (t.branch === slug || path.basename(t.path) === slug || path.basename(t.path) === `${path.basename(mainRoot)}-${slug}`));

  if (!wanted.length) die(`no worktree for "${slug}". Run: node scripts/worktree.js list`);
  if (wanted.length > 1) die(`"${slug}" matches ${wanted.length} worktrees; name the folder exactly.`);

  const tree = wanted[0];
  if (!opts.force) {
    const files = dirtyFiles(tree.path);
    if (files === null) die(`could not read ${tree.path}; not removing anything.`);
    if (files.length) {
      console.error(`worktree: ${tree.path} still holds ${files.length} uncommitted change(s):`);
      for (const f of files.slice(0, 20)) console.error(`  ${f}`);
      if (files.length > 20) console.error(`  … and ${files.length - 20} more`);
      console.error('');
      console.error('That is somebody\'s unfinished work. Commit it, or re-run with --force if you are certain it is yours and disposable.');
      process.exit(1);
    }
    const unpushed = unpushedCommits(tree.path);
    if (unpushed === null) die(`could not read the commit history of ${tree.path}; not removing anything.`);
    if (unpushed.length) {
      console.error(`worktree: ${tree.path} has ${unpushed.length} commit(s) on no remote:`);
      for (const c of unpushed.slice(0, 20)) console.error(`  ${c}`);
      console.error('');
      console.error('Push the branch and open a PR first, or re-run with --force to discard them.');
      process.exit(1);
    }
  }

  const removed = git(opts.force ? ['worktree', 'remove', '--force', tree.path] : ['worktree', 'remove', tree.path], mainRoot);
  if (!removed.ok) die(`git worktree remove failed: ${removed.err || removed.out}`);

  console.log(`removed:  ${tree.path}`);
  // The branch outlives the folder deliberately. Deleting it is a second, irreversible act
  // that belongs to whoever merges, not to whoever tidies up a folder.
  if (tree.branch) console.log(`branch:   ${tree.branch} still exists — delete it yourself once its PR is merged.`);
  return 0;
}

// ---- entry ---------------------------------------------------------------------------

function parse(argv) {
  const opts = { force: false, from: null, root: null, carry: true };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--force') opts.force = true;
    else if (a === '--no-carry') opts.carry = false;
    else if (a === '--from') { opts.from = argv[i + 1]; i += 1; }
    else if (a === '--root') { opts.root = argv[i + 1]; i += 1; }
    else rest.push(a);
  }
  return { opts, rest };
}

const USAGE = `one folder per agent session (DESIGN.md §6.2)

  node scripts/worktree.js new <idea-name> [--from <branch>] [--root <dir>]
  node scripts/worktree.js list
  node scripts/worktree.js remove <idea-name> [--force]

new     makes a folder under .worktrees/ and a branch of the same name off the default
        branch, and copies in the host-only files named in .worktree-carry.
        --root <dir> puts the folder outside the repository instead.
list    every worktree, its branch, and whether it holds uncommitted or unpushed work.
remove  deletes the folder, refusing while it still holds work. The branch survives.`;

function main(argv) {
  const { opts, rest } = parse(argv);
  const [cmd, slug] = rest;
  const cwd = process.cwd();
  switch (cmd) {
    case 'new': return cmdNew(slug, opts, cwd);
    case 'list': return cmdList(cwd);
    case 'remove': return cmdRemove(slug, opts, cwd);
    default:
      console.log(USAGE);
      return cmd ? 1 : 0;
  }
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = { validSlug, readCarryList, carry, inventory, mainCheckout, NEVER_CARRY };
