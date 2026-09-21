#!/usr/bin/env node
// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// Checks for scripts/worktree.js — one folder per agent session (DESIGN.md §6.2,
// change-log row `parallel-sessions`).
//
// Docker-free and network-free: every fixture is a throwaway git repository built under the
// OS temp directory, and the real CLI is driven against it as a child process. It touches
// neither this repo's history nor its working tree, so it is safe to run anywhere git and
// node exist, including inside a task container.
//
// What this tool decides is whether one session can destroy another's work, and every way
// it fails is silent — a folder is gone and the reason it was safe to delete was wrong. So
// the fixtures are chosen so that a PLAUSIBLE WRONG implementation fails them rather than
// merely being exercised by them. Four are load-bearing; the rest are shape.
//
//   1. A worktree dirty with ONLY AN UNTRACKED FILE, beside one dirty with a tracked
//      modification. The obvious implementation of "does this hold work?" is `git diff
//      --quiet`, which passes the tracked fixture and DELETES the untracked one — and an
//      uncommitted new test file is precisely the work that got swept up in the incident
//      this tool exists for. Only the pair tells the two implementations apart.
//   2. A worktree that is CLEAN but carries a commit on no remote. Every dirtiness check in
//      the world says this folder is safe to delete, and deleting it loses the commit.
//   3. `runs/` named in .worktree-carry. An implementation that copies each entry in turn
//      passes every other carry fixture and quietly forks the evidence corpus and lock
//      observer (§4.12) three files away.
//   4. `new` invoked FROM INSIDE a worktree. The obvious way to find the checkout is
//      `rev-parse --show-toplevel`, which is correct from the main checkout and wrong from
//      a worktree — it would read the carry list from the worktree's own copy. Only a
//      fixture that calls from inside a worktree separates it from `--git-common-dir`.
//
// And one inherited from change-log row `repo-5yu`: a `master` project whose default branch
// cannot be resolved must ABORT, never fall back to the literal `main`, or the tool
// confidently branches from a ref that does not exist.
//
// Run from Git Bash:  node tests/unit/worktree.test.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const CLI = path.join(ROOT, 'scripts', 'worktree.js');

let failed = 0;
function pass(name) { console.log(`PASS  ${name}`); }
function fail(name, detail) {
  console.log(`FAIL  ${name}`);
  if (detail) console.log(`      ${String(detail).replace(/\n/g, '\n      ')}`);
  failed = 1;
}
function check(name, cond, detail) { (cond ? pass : (n) => fail(n, detail))(name); return cond; }

// ---- harness -------------------------------------------------------------------------

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-test-'));
const made = [];

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 60000, windowsHide: true });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim(), status: r.status };
}

// The CLI is spawned through process.execPath, never a shell: spawnSync without a shell
// fails a `#!` script with EFTYPE on the Windows host, and a suite that passes in a
// container and fails in the host sweep is worse than no suite (CLAUDE.md's stub rule).
function cli(args, cwd, env) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 120000,
    windowsHide: true,
    env: { ...process.env, ...(env || {}) },
  });
  return { out: (r.stdout || '') + (r.stderr || ''), status: r.status };
}

// A project fixture: a bare "remote", a working copy with one commit on `branch`, pushed.
function makeProject(name, branch) {
  const dir = path.join(TMP, name);
  const bare = path.join(TMP, `${name}.git`);
  fs.mkdirSync(dir, { recursive: true });
  git(['init', '--bare', '--initial-branch', branch, bare], TMP);
  git(['init', '--initial-branch', branch], dir);
  git(['config', 'user.email', 'test@example.invalid'], dir);
  git(['config', 'user.name', 'Test'], dir);
  git(['config', 'commit.gpgsign', 'false'], dir);
  fs.writeFileSync(path.join(dir, 'README.md'), '# fixture\n');
  git(['add', 'README.md'], dir);
  git(['commit', '-m', 'initial'], dir);
  git(['remote', 'add', 'origin', bare], dir);
  git(['push', '-u', 'origin', branch], dir);
  // `origin/HEAD` is what the default-branch chain reads first. A fresh `git push` does not
  // set it, so the fixture sets it explicitly — and the fixture that must NOT have it
  // (default-branch-abort) is built by makeProjectNoHead below.
  git(['remote', 'set-head', 'origin', branch], dir);
  made.push(dir, bare);
  return { dir, bare, branch };
}

function makeProjectNoHead(name, branch) {
  const p = makeProject(name, branch);
  git(['remote', 'set-head', 'origin', '--delete'], p.dir);
  return p;
}

function treePath(project, slug) {
  return path.join(TMP, `${path.basename(project.dir)}-${slug}`);
}

function rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 3 }); } catch { /* best effort */ }
}

// ---- 1. slug validation ---------------------------------------------------------------
// The slug becomes a folder name AND a branch name, so anything that escapes either is a
// path-traversal or a git flag. These are cheap and they are the first line.

const wt = require(CLI);

check('slug: a plain idea name is accepted', wt.validSlug('flight-tuning'));
check('slug: digits, dots and underscores are accepted', wt.validSlug('spec_2026.08'));
check('slug: a path separator is rejected', !wt.validSlug('feat/x'));
check('slug: a parent-directory escape is rejected', !wt.validSlug('../evil'));
check('slug: a leading dash is rejected (git would read it as a flag)', !wt.validSlug('-rf'));
check('slug: an upper-case name is rejected', !wt.validSlug('Flight'));
check('slug: an empty name is rejected', !wt.validSlug(''));
check('slug: a trailing dot is rejected (Windows cannot name such a folder)', !wt.validSlug('idea.'));

// ---- 2. new: the happy path ------------------------------------------------------------

const proj = makeProject('alpha', 'main');
const r1 = cli(['new', 'idea-one', '--root', TMP], proj.dir);
const tree1 = treePath(proj, 'idea-one');

check('new: exits 0', r1.status === 0, r1.out);
check('new: the folder exists', fs.existsSync(tree1), r1.out);
check('new: the folder is a worktree, not a clone',
  fs.existsSync(path.join(tree1, '.git')) && fs.statSync(path.join(tree1, '.git')).isFile(),
  'a worktree has a .git FILE pointing at the shared repository; a .git directory means a second history');
check('new: tracked files are checked out', fs.existsSync(path.join(tree1, 'README.md')));
check('new: the branch is named after the idea',
  git(['rev-parse', '--abbrev-ref', 'HEAD'], tree1).out === 'idea-one');
check('new: it says nothing was carried when there is no .worktree-carry',
  /no \.worktree-carry/.test(r1.out), r1.out);

// A second worktree of the same name must be refused rather than half-made.
const r1b = cli(['new', 'idea-one', '--root', TMP], proj.dir);
check('new: a name already in use is refused', r1b.status !== 0 && /already exists/.test(r1b.out), r1b.out);

// Nesting a worktree inside the checkout is allowed in exactly one place: a directory the
// repository ignores. That condition is the whole safety argument — an un-ignored nested
// worktree puts every one of its files into the parent's `git status` as untracked, which
// is the noise that gets `git add -A` typed. So it is refused, and the remedy is named.
const r1c = cli(['new', 'nested', '--root', path.join(proj.dir, 'inside')], proj.dir);
check('new: refuses to nest a worktree in a directory the repository does not ignore',
  r1c.status !== 0 && /does not ignore/.test(r1c.out), r1c.out);
check('new: and names the remedy rather than only the refusal',
  /\.gitignore/.test(r1c.out) && /--root/.test(r1c.out), r1c.out);

// The default location, which is the one every session actually uses: inside the checkout,
// under the ignored container directory, named for the idea alone.
const nestProj = makeProject('alpha-nest', 'main');
fs.appendFileSync(path.join(nestProj.dir, '.gitignore'), '.worktrees/\n');
git(['add', '.gitignore'], nestProj.dir);
git(['commit', '-m', 'ignore worktrees'], nestProj.dir);
const r1d = cli(['new', 'inside-idea'], nestProj.dir);
const nested = path.join(nestProj.dir, '.worktrees', 'inside-idea');
check('new: with no --root the folder lands under .worktrees/ inside the checkout',
  r1d.status === 0 && fs.existsSync(nested), r1d.out);
check('new: the nested folder is a worktree, not a clone',
  fs.existsSync(path.join(nested, '.git')) && fs.statSync(path.join(nested, '.git')).isFile());
check('new: the nested folder is named for the idea alone, with no repository prefix',
  fs.existsSync(nested) && !fs.existsSync(path.join(nestProj.dir, '.worktrees', 'alpha-nest-inside-idea')));
// The load-bearing consequence, and the reason nesting was refused before: the main
// checkout's own status has to stay clean with a session folder sitting inside it.
const nestStatus = git(['status', '--porcelain'], nestProj.dir).out;
check('new: a nested worktree leaves the main checkout status clean',
  nestStatus === '', `main checkout status: ${nestStatus}`);
// And the allowance has to depend on the ignore rather than on the folder's name, or the
// check above is decorative the day someone edits .gitignore.
fs.writeFileSync(path.join(nestProj.dir, '.gitignore'), '');
const r1e = cli(['new', 'second-idea'], nestProj.dir);
check('new: the nesting allowance depends on the ignore, not on the folder name',
  r1e.status !== 0 && /does not ignore/.test(r1e.out), r1e.out);

// ---- 3. LOAD-BEARING: the default branch is resolved, never guessed --------------------
// Inherited from change-log row `repo-5yu`. A `master` project is the only fixture that
// catches a chain ending at the literal 'main': with `main` guessed, the start point does
// not exist and the tool either fails obscurely or branches from the wrong place.

const master = makeProject('bravo', 'master');
const rm = cli(['new', 'on-master', '--root', TMP], master.dir);
check('default branch: a master project branches from master, not a guessed main',
  rm.status === 0 && git(['rev-parse', '--abbrev-ref', 'HEAD'], treePath(master, 'on-master')).out === 'on-master',
  rm.out);
check('default branch: the start point is reported as master',
  /off origin\/master/.test(rm.out), rm.out);

const headless = makeProjectNoHead('charlie', 'master');
const rh = cli(['new', 'no-head', '--root', TMP], headless.dir);
check('default branch: an unresolvable default branch ABORTS rather than falling back to main',
  rh.status !== 0 && /could not work out the default branch/.test(rh.out), rh.out);
check('default branch: the abort names the remedy',
  /--from/.test(rh.out), rh.out);

const rh2 = cli(['new', 'explicit', '--from', 'master', '--root', TMP], headless.dir);
check('default branch: --from makes the same project work',
  rh2.status === 0 && fs.existsSync(treePath(headless, 'explicit')), rh2.out);

// ---- 4. LOAD-BEARING: the carry list ---------------------------------------------------
// A worktree checks out TRACKED files only, so the git-ignored host-only files a session
// needs are simply absent. The list says which to copy; `runs/` says which never to.

const carrier = makeProject('delta', 'main');
fs.writeFileSync(path.join(carrier.dir, '.env.pipeline'), 'TOKEN=fixture\n');
fs.mkdirSync(path.join(carrier.dir, 'runs', 'locks'), { recursive: true });
fs.writeFileSync(path.join(carrier.dir, 'runs', 'locks', 'a.lock'), 'held\n');
fs.mkdirSync(path.join(carrier.dir, 'conf'), { recursive: true });
fs.writeFileSync(path.join(carrier.dir, 'conf', 'local.json'), '{}\n');
fs.writeFileSync(path.join(carrier.dir, '.worktree-carry'), [
  '# host-only files a worktree cannot check out',
  '.env.pipeline',
  'conf',
  'runs',                 // must be REFUSED, not copied
  'absent.json',          // must be reported missing, not fatal
  '../outside.txt',       // must be refused as an escape
  '',
].join('\n'));

const rc = cli(['new', 'carried', '--root', TMP], carrier.dir);
const tree4 = treePath(carrier, 'carried');

check('carry: exits 0 despite a missing and a refused entry', rc.status === 0, rc.out);
check('carry: a named host-only FILE is copied',
  fs.existsSync(path.join(tree4, '.env.pipeline'))
  && fs.readFileSync(path.join(tree4, '.env.pipeline'), 'utf8') === 'TOKEN=fixture\n', rc.out);
check('carry: a named host-only DIRECTORY is copied recursively',
  fs.existsSync(path.join(tree4, 'conf', 'local.json')), rc.out);
check('carry: runs/ is NOT copied — a forked evidence corpus is a broken guarantee',
  !fs.existsSync(path.join(tree4, 'runs')), rc.out);
check('carry: the refusal of runs/ is REPORTED, not silent',
  /refused: runs/.test(rc.out) && /lock observer/.test(rc.out), rc.out);
check('carry: a missing entry is reported and is not fatal',
  /missing: absent\.json/.test(rc.out), rc.out);
check('carry: an entry escaping the checkout is refused',
  /refused: \.\.\/outside\.txt/.test(rc.out), rc.out);
check('carry: a comment line is not treated as a path',
  !/host-only files a worktree/.test(rc.out.replace(/refused:.*/g, '')), rc.out);

// ---- 5. LOAD-BEARING: `new` from INSIDE a worktree resolves the MAIN checkout ------------
// `rev-parse --show-toplevel` answers "this worktree"; `--git-common-dir` answers "the
// repository". Only this fixture tells them apart, and getting it wrong means the carry
// list is read from a worktree's own copy — which is empty, so a session silently gets a
// worktree with none of its host-only files.

check('main checkout: resolved from the main checkout', wt.mainCheckout(carrier.dir) === path.resolve(carrier.dir));
check('main checkout: resolved identically from INSIDE a worktree',
  wt.mainCheckout(tree4) === path.resolve(carrier.dir),
  `got ${wt.mainCheckout(tree4)}, expected ${path.resolve(carrier.dir)}`);

const rNested = cli(['new', 'from-within', '--root', TMP], tree4);
check('new: works when invoked from inside a worktree',
  rNested.status === 0 && fs.existsSync(treePath(carrier, 'from-within')), rNested.out);
check('new: a worktree made from inside a worktree still carries the host-only files',
  fs.existsSync(path.join(treePath(carrier, 'from-within'), '.env.pipeline')),
  'the carry list was read from the worktree rather than the main checkout');
check('new: it is a sibling of the MAIN checkout, not nested in the worktree it was run from',
  path.resolve(treePath(carrier, 'from-within')) === path.resolve(TMP, 'delta-from-within'));

// ---- 6. list ----------------------------------------------------------------------------

const rl = cli(['list'], carrier.dir);
check('list: exits 0', rl.status === 0, rl.out);
check('list: names the main checkout with a marker', /^\*/m.test(rl.out), rl.out);
check('list: names every worktree branch', /carried/.test(rl.out) && /from-within/.test(rl.out), rl.out);
check('list: warns that runs belong in the main checkout',
  /never from a worktree/.test(rl.out), rl.out);

// ---- 7. LOAD-BEARING: remove refuses to discard work -------------------------------------
// Fixture A and fixture B differ ONLY in whether the uncommitted file is tracked. An
// implementation built on `git diff --quiet` refuses A and deletes B.

const guard = makeProject('echo', 'main');
cli(['new', 'tracked-dirty', '--root', TMP], guard.dir);
cli(['new', 'untracked-dirty', '--root', TMP], guard.dir);
cli(['new', 'unpushed-clean', '--root', TMP], guard.dir);
cli(['new', 'genuinely-clean', '--root', TMP], guard.dir);

const tA = treePath(guard, 'tracked-dirty');
const tB = treePath(guard, 'untracked-dirty');
const tC = treePath(guard, 'unpushed-clean');
const tD = treePath(guard, 'genuinely-clean');

// A: a tracked file, modified and not committed.
fs.writeFileSync(path.join(tA, 'README.md'), '# fixture\nedited by another session\n');

// B: a NEW file nobody has `git add`ed. This is the incident: an uncommitted new test file.
fs.writeFileSync(path.join(tB, 'new_test.js'), '// half-written work\n');

// C: perfectly clean tree, one commit that exists on no remote.
fs.writeFileSync(path.join(tC, 'feature.txt'), 'done\n');
git(['add', 'feature.txt'], tC);
git(['config', 'user.email', 'test@example.invalid'], tC);
git(['config', 'user.name', 'Test'], tC);
git(['commit', '-m', 'a finished piece of work'], tC);

const rA = cli(['remove', 'tracked-dirty'], guard.dir);
check('remove: refuses a worktree with a MODIFIED TRACKED file',
  rA.status !== 0 && fs.existsSync(tA), rA.out);
check('remove: the refusal names the file', /README\.md/.test(rA.out), rA.out);

// The assertion is on OUR refusal, not merely on a non-zero exit. `git worktree remove`
// has a dirtiness guard of its own, so a tool that measured dirtiness with `git diff`
// (tracked files only) still exits non-zero here — git catches it and prints its own error.
// Asserting the exit code alone therefore passes the broken implementation, which is what
// the mutation pass found. Pinning the message is what separates "this tool refused, and
// said why" from "git happened to catch it".
const rB = cli(['remove', 'untracked-dirty'], guard.dir);
check('remove: refuses a worktree whose only work is an UNTRACKED file',
  rB.status !== 0 && fs.existsSync(tB) && /still holds 1 uncommitted change/.test(rB.out),
  `this is the git diff --quiet trap; the refusal must be this tool's, not git's — output was: ${rB.out}`);
check('remove: the refusal names the untracked file', /new_test\.js/.test(rB.out), rB.out);

const rC = cli(['remove', 'unpushed-clean'], guard.dir);
check('remove: refuses a CLEAN worktree holding a commit on no remote',
  rC.status !== 0 && fs.existsSync(tC),
  `every dirtiness check calls this folder safe to delete — output was: ${rC.out}`);
check('remove: the refusal names the commit and the remedy',
  /a finished piece of work/.test(rC.out) && /PR/.test(rC.out), rC.out);

const rD = cli(['remove', 'genuinely-clean'], guard.dir);
check('remove: removes a worktree that holds nothing', rD.status === 0 && !fs.existsSync(tD), rD.out);
check('remove: the branch OUTLIVES the folder',
  git(['rev-parse', '--verify', 'genuinely-clean'], guard.dir).ok,
  'deleting the branch is a second irreversible act and belongs to whoever merges');
check('remove: it says the branch survived', /still exists/.test(rD.out), rD.out);

// --force is the documented escape hatch, and it has to actually work or the refusals above
// become a trap of their own.
const rF = cli(['remove', 'untracked-dirty', '--force'], guard.dir);
check('remove --force: removes a worktree that holds work', rF.status === 0 && !fs.existsSync(tB), rF.out);

const rMissing = cli(['remove', 'no-such-idea'], guard.dir);
check('remove: an unknown name is refused with the remedy',
  rMissing.status !== 0 && /list/.test(rMissing.out), rMissing.out);

// The main checkout is not removable by any name — it is excluded from the candidate set
// before any check runs, so the tool reports it as unknown rather than as protected.
//
// Again the assertion is on OUR message. `git worktree remove` refuses to remove a main
// working tree on its own, so exit-code-only passes an implementation whose candidate
// filter has stopped excluding it — a mutation that survived the first pass. The fixture's
// name is the main checkout's own folder name, which is what such a filter would match.
const rMain = cli(['remove', path.basename(guard.dir)], guard.dir);
check('remove: the MAIN checkout is not even a candidate',
  rMain.status !== 0
  && fs.existsSync(path.join(guard.dir, 'README.md'))
  && /no worktree for/.test(rMain.out),
  `the refusal must come from the candidate filter, not from git — output was: ${rMain.out}`);

// ---- 8. isolation, end to end -------------------------------------------------------------
// The proof the whole design rests on: a commit in one worktree contains none of the other's
// files, even when both edit a file of the same name at the same moment.

const iso = makeProject('foxtrot', 'main');
cli(['new', 'session-a', '--root', TMP], iso.dir);
cli(['new', 'session-b', '--root', TMP], iso.dir);
const tSA = treePath(iso, 'session-a');
const tSB = treePath(iso, 'session-b');

for (const t of [tSA, tSB]) {
  git(['config', 'user.email', 'test@example.invalid'], t);
  git(['config', 'user.name', 'Test'], t);
}

fs.writeFileSync(path.join(tSA, 'a-only.txt'), 'session A work\n');
fs.writeFileSync(path.join(tSA, 'README.md'), '# fixture\nA edit\n');
fs.writeFileSync(path.join(tSB, 'b-only.txt'), 'session B work\n');
fs.writeFileSync(path.join(tSB, 'README.md'), '# fixture\nB edit\n');

// Deliberately the DANGEROUS form — `git add -A` — because the claim under test is that a
// worktree makes the blast radius of the habit the session's own folder.
git(['add', '-A'], tSA); git(['commit', '-m', 'A: work'], tSA);
git(['add', '-A'], tSB); git(['commit', '-m', 'B: work'], tSB);

const filesA = git(['show', '--name-only', '--format=', 'HEAD'], tSA).out.split('\n').map((s) => s.trim()).filter(Boolean);
const filesB = git(['show', '--name-only', '--format=', 'HEAD'], tSB).out.split('\n').map((s) => s.trim()).filter(Boolean);

check("isolation: A's commit contains A's file", filesA.includes('a-only.txt'), filesA.join(','));
check("isolation: A's commit does NOT contain B's file", !filesA.includes('b-only.txt'), filesA.join(','));
check("isolation: B's commit contains B's file", filesB.includes('b-only.txt'), filesB.join(','));
check("isolation: B's commit does NOT contain A's file", !filesB.includes('a-only.txt'), filesB.join(','));
check('isolation: both edited README.md independently',
  filesA.includes('README.md') && filesB.includes('README.md')
  && fs.readFileSync(path.join(tSA, 'README.md'), 'utf8').includes('A edit')
  && fs.readFileSync(path.join(tSB, 'README.md'), 'utf8').includes('B edit'));
check('isolation: the two branches share one history',
  git(['merge-base', 'session-a', 'session-b'], iso.dir).out
  === git(['rev-parse', 'main'], iso.dir).out);
check('isolation: neither commit is on the other branch',
  !git(['merge-base', '--is-ancestor', 'session-a', 'session-b'], iso.dir).ok
  && !git(['merge-base', '--is-ancestor', 'session-b', 'session-a'], iso.dir).ok);

// The destructive command from the incident report, aimed at a file another session is
// editing. In one shared checkout it destroys their work; across worktrees it cannot reach.
const beforeB = fs.readFileSync(path.join(tSB, 'README.md'), 'utf8');
fs.writeFileSync(path.join(tSA, 'README.md'), '# fixture\nA experiment\n');
git(['checkout', '--', 'README.md'], tSA);
check("isolation: a git checkout -- in A cannot touch B's copy of the same path",
  fs.readFileSync(path.join(tSB, 'README.md'), 'utf8') === beforeB);

// ---- 9. the tool judges nothing it did not create -------------------------------------
// It must leave the main checkout's working tree exactly as it found it — the constraint
// the whole exercise is about.

const witness = makeProject('golf', 'main');
fs.writeFileSync(path.join(witness.dir, 'someone-elses-work.txt'), 'in progress\n');
const beforeStatus = git(['status', '--porcelain'], witness.dir).out;
cli(['new', 'observer', '--root', TMP], witness.dir);
cli(['list'], witness.dir);
cli(['remove', 'observer'], witness.dir);
const afterStatus = git(['status', '--porcelain'], witness.dir).out;
check('hygiene: the main checkout\'s working tree is untouched across new/list/remove',
  beforeStatus === afterStatus && fs.readFileSync(path.join(witness.dir, 'someone-elses-work.txt'), 'utf8') === 'in progress\n',
  `before: ${beforeStatus} / after: ${afterStatus}`);

// ---- 10. usage --------------------------------------------------------------------------

const rU = cli([], TMP);
check('usage: bare invocation prints usage and exits 0', rU.status === 0 && /new <idea-name>/.test(rU.out), rU.out);
const rUnknown = cli(['frobnicate'], TMP);
check('usage: an unknown command exits non-zero', rUnknown.status !== 0, rUnknown.out);

// ---- teardown ---------------------------------------------------------------------------
// Best effort, and never a verdict: the exit code is decided by the checks above, and a
// temp directory Windows will not release must not turn a green suite red.

for (const p of made) {
  const inv = git(['worktree', 'list', '--porcelain'], p);
  if (inv.ok) {
    for (const line of inv.out.split('\n')) {
      if (line.startsWith('worktree ') && path.resolve(line.slice(9)) !== path.resolve(p)) {
        git(['worktree', 'remove', '--force', line.slice(9)], p);
      }
    }
  }
}
rmrf(TMP);

process.exit(failed);
