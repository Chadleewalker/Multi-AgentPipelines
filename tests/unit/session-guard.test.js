#!/usr/bin/env node
// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// Checks for the one-session-one-folder write guard (change-log row
// `session-write-guard`).
//
// The negative cases carry the weight, and there are two families of them.
//
// A guard that refused everything would satisfy every "it blocks X" case and would be
// worthless: it would be switched off within the hour, and then twenty sessions would be
// back in one folder with nothing watching. So the suite asserts, in the same fixture,
// that the writes a session legitimately makes still go through — a git-ignored path in
// the main checkout, anything outside the repository, and every write inside the session's
// own worktree. `sed -n '1,5p' TRACKED.md > /tmp/out` is here for the same reason: it
// names a tracked file and writes somewhere harmless, and a guard that read the operands
// instead of the redirect target would refuse it.
//
// The other family is the bypass. The rule is about the write, not the tool, so a `sed -i`
// or a `>` redirect into the shared checkout has to land exactly where the Write tool
// does. That case is not hypothetical: an agent told to prefer shell commands over file
// tools reaches for `sed -i` first, so a guard that watched only the file tools would be
// enforcing nothing at all in precisely the configuration it was built for.
//
// Everything runs against throwaway repositories under the OS temp dir and needs git and
// node only — no Docker, no network, no agent CLI.
//
// Run from Git Bash:  node tests/unit/session-guard.test.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const GUARD = path.join(ROOT, 'scripts', 'session-guard.js');
const BRIDGE = path.join(ROOT, 'scripts', 'session-guard-bridge.js');
const INSTALLER = path.join(ROOT, 'scripts', 'install-session-guard.js');

let failed = 0;
function pass(name) { console.log(`PASS  ${name}`); }
function fail(name, detail) {
  console.log(`FAIL  ${name}`);
  if (detail) console.log(`      ${String(detail).replace(/\n/g, '\n      ')}`);
  failed = 1;
}
function check(name, cond, detail) { (cond ? pass : (n) => fail(n, detail))(name); return cond; }

// ---- harness -------------------------------------------------------------------------

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-test-'));
const MARKER_NAME = '.session-guard-off';

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 60000, windowsHide: true });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

// Spawned through process.execPath rather than a shell: a `#!` script run without a shell
// fails with EFTYPE on the Windows host, and a suite that only passes in a container is
// worse than no suite.
function ask(payload, script) {
  const r = spawnSync(process.execPath, [script || GUARD], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 60000,
    windowsHide: true,
  });
  return { status: r.status, err: (r.stderr || '').trim(), out: (r.stdout || '').trim() };
}

const allowed = (name, payload) => {
  const r = ask(payload);
  check(name, r.status === 0, r.err || `exit ${r.status}`);
};
const refused = (name, payload, expect) => {
  const r = ask(payload);
  if (!check(name, r.status === 2, `exit ${r.status}; stderr: ${r.err || '(empty)'}`)) return;
  if (expect && !r.err.includes(expect)) fail(`${name} — reason names the problem`, r.err);
};

// A main checkout with one tracked file, one git-ignored tree, and a worktree beside it.
function fixture(name) {
  const main = path.join(TMP, name);
  fs.mkdirSync(main, { recursive: true });
  git(['init', '--initial-branch', 'main'], main);
  git(['config', 'user.email', 'test@example.invalid'], main);
  git(['config', 'user.name', 'Test'], main);
  git(['config', 'commit.gpgsign', 'false'], main);
  fs.writeFileSync(path.join(main, 'TRACKED.md'), '# tracked\nline two\n');
  fs.writeFileSync(path.join(main, '.gitignore'), 'runs/\nlocal.json\n.session-guard-off\n.worktrees/\n');
  fs.mkdirSync(path.join(main, 'runs'), { recursive: true });
  // The fixture carries the guard where the bridge looks for it, because "the bridge finds
  // the guard" is the case that would otherwise pass vacuously in every direction.
  fs.mkdirSync(path.join(main, 'scripts'), { recursive: true });
  fs.copyFileSync(GUARD, path.join(main, 'scripts', 'session-guard.js'));
  git(['add', 'TRACKED.md', '.gitignore', 'scripts/session-guard.js'], main);
  git(['commit', '-m', 'initial'], main);

  // Session folders live INSIDE the checkout, in the directory the repository ignores.
  // That layout is the one the guard has to get right: every file in it answers "no" to
  // "would git track this?", so the shared-checkout rule alone would wave through a write
  // into any of them. A second folder is here to be the other session.
  const tree = path.join(main, '.worktrees', 'idea');
  const other = path.join(main, '.worktrees', 'other');
  git(['worktree', 'add', '-b', 'idea', tree], main);
  git(['worktree', 'add', '-b', 'other', other], main);
  return { main, tree, other };
}

const F = fixture('proj');
const OUTSIDE = path.join(TMP, 'elsewhere');
fs.mkdirSync(OUTSIDE, { recursive: true });

// ---- 1. the shared checkout is read-only for anything git tracks -----------------------
console.log('== main checkout ==');

refused(
  'Write to a tracked file in the main checkout is refused',
  { cwd: F.main, action: 'write', path: 'TRACKED.md' },
  'shared main checkout'
);
refused(
  'the refusal names the command that fixes it',
  { cwd: F.main, action: 'write', path: 'TRACKED.md' },
  'worktree.js new'
);
refused(
  'a NEW file in the main checkout is refused too — git would track it',
  { cwd: F.main, action: 'write', path: 'docs/new-note.md' },
  'shared main checkout'
);
refused(
  'an absolute path into the main checkout is refused',
  { cwd: F.main, action: 'write', path: path.join(F.main, 'TRACKED.md') },
  'shared main checkout'
);

// ---- 2. and still writable for everything that does not merge --------------------------
console.log('== main checkout: what stays allowed ==');

allowed('a git-ignored file in the main checkout is allowed', {
  cwd: F.main, action: 'write', path: 'local.json',
});
allowed('the run evidence tree is allowed', {
  cwd: F.main, action: 'write', path: 'runs/2026-08-29/report.json',
});
allowed('a path outside the repository is allowed', {
  cwd: F.main, action: 'write', path: path.join(OUTSIDE, 'scratch.txt'),
});
allowed('a folder that is not a git repository at all is allowed', {
  cwd: OUTSIDE, action: 'write', path: 'anything.txt',
});

// ---- 3. inside your own worktree, work normally ----------------------------------------
console.log('== worktree ==');

allowed('the same tracked file IS writable inside a worktree', {
  cwd: F.tree, action: 'write', path: 'TRACKED.md',
});
allowed('a new file inside a worktree is writable', {
  cwd: F.tree, action: 'write', path: 'docs/new-note.md',
});
refused(
  'reaching back into the main checkout from a worktree is refused',
  { cwd: F.tree, action: 'write', path: path.join(F.main, 'TRACKED.md') },
  'main checkout'
);
allowed('reaching into a git-ignored path in the main checkout is allowed', {
  cwd: F.tree, action: 'write', path: path.join(F.main, 'runs', 'r.json'),
});

// ---- 3b. one session cannot reach into another's folder --------------------------------
// The folders sit inside the repository and the repository ignores them, so "would git
// track this?" answers no for every file in every one of them. Judged by that rule alone a
// write into another session's folder would be waved through, which is precisely the
// collision the folders exist to prevent.
console.log('== other sessions\' folders ==');

refused(
  'the main checkout cannot write into a session folder',
  { cwd: F.main, action: 'write', path: path.join('.worktrees', 'idea', 'TRACKED.md') },
  "another session's folder"
);
refused(
  'one session cannot write into another session\'s folder',
  { cwd: F.tree, action: 'write', path: path.join(F.other, 'TRACKED.md') },
  "another session's folder"
);
refused(
  'and not through the shell either',
  { cwd: F.tree, action: 'shell', command: `echo x > ${path.join(F.other, 'TRACKED.md').split(path.sep).join('/')}` },
  "another session's folder"
);
allowed('a session writing in its own folder by absolute path is allowed', {
  cwd: F.tree, action: 'write', path: path.join(F.tree, 'TRACKED.md'),
});

// ---- 4. the shell is not a way round it ------------------------------------------------
// The rule is about the write. An agent steered towards shell commands reaches for these
// first, so each one has to land where the Write tool lands.
console.log('== shell writes ==');

refused(
  'a redirect into a tracked file in the main checkout is refused',
  { cwd: F.main, action: 'shell', command: "echo hello > TRACKED.md" },
  'shared main checkout'
);
refused(
  'an appending redirect is refused',
  { cwd: F.main, action: 'shell', command: "printf 'x' >>TRACKED.md" },
  'shared main checkout'
);
refused(
  'sed -i on a tracked file in the main checkout is refused',
  { cwd: F.main, action: 'shell', command: "sed -i 's/one/two/' TRACKED.md" },
  'shared main checkout'
);
refused(
  'tee into a tracked file in the main checkout is refused',
  { cwd: F.main, action: 'shell', command: 'echo x | tee TRACKED.md' },
  'shared main checkout'
);
refused(
  'rm of a tracked file in the main checkout is refused',
  { cwd: F.main, action: 'shell', command: 'rm -f TRACKED.md' },
  'shared main checkout'
);
refused(
  'a heredoc redirect into a new tracked path is refused',
  { cwd: F.main, action: 'shell', command: "cat > docs/note.md <<'EOF'" },
  'shared main checkout'
);

console.log('== shell reads and scratch writes stay allowed ==');

allowed('reading a tracked file and writing outside the repo is allowed', {
  cwd: F.main,
  action: 'shell',
  command: `sed -n '1,5p' TRACKED.md > ${path.join(OUTSIDE, 'out.txt').split(path.sep).join('/')}`,
});
allowed('a plain read of a tracked file is allowed', {
  cwd: F.main, action: 'shell', command: 'cat TRACKED.md',
});
allowed('grep piped to a pager is allowed', {
  cwd: F.main, action: 'shell', command: 'grep -rn tracked . | head -20',
});
allowed('2>&1 is a descriptor, not a file', {
  cwd: F.main, action: 'shell', command: 'node --version 2>&1',
});
allowed('writing into the ignored run tree from the shell is allowed', {
  cwd: F.main, action: 'shell', command: 'echo x > runs/log.txt',
});
allowed('the same edit inside a worktree is allowed', {
  cwd: F.tree, action: 'shell', command: "sed -i 's/one/two/' TRACKED.md",
});

// ---- 5. the commands that destroy work, refused from every folder -----------------------
// A worktree shrinks the blast radius to your own work. That is an improvement, not a
// licence, so these are refused inside one as well.
console.log('== work-destroying commands ==');

for (const where of [['main checkout', F.main], ['worktree', F.tree]]) {
  const [label, cwd] = where;
  refused(`git add -A is refused in the ${label}`, { cwd, action: 'shell', command: 'git add -A' }, 'stage the FOLDER');
  refused(`git add . is refused in the ${label}`, { cwd, action: 'shell', command: 'git add .' }, 'stage the FOLDER');
  refused(`git commit -am is refused in the ${label}`, { cwd, action: 'shell', command: 'git commit -am "x"' }, 'every modified tracked file');
  refused(`git checkout -- is refused in the ${label}`, { cwd, action: 'shell', command: 'git checkout -- TRACKED.md' }, 'throws away');
  refused(`git restore is refused in the ${label}`, { cwd, action: 'shell', command: 'git restore TRACKED.md' }, 'throws away');
  refused(`git stash is refused in the ${label}`, { cwd, action: 'shell', command: 'git stash' }, 'did not write');
  refused(`git reset --hard is refused in the ${label}`, { cwd, action: 'shell', command: 'git reset --hard HEAD' }, 'permanently discards');
  refused(`git clean is refused in the ${label}`, { cwd, action: 'shell', command: 'git clean -fd' }, 'permanently deletes');
}

console.log('== the git commands that are ordinary work ==');

allowed('git status is allowed', { cwd: F.main, action: 'shell', command: 'git status' });
allowed('git add of a named path is allowed', { cwd: F.tree, action: 'shell', command: 'git add TRACKED.md' });
allowed('git commit with a message is allowed', { cwd: F.tree, action: 'shell', command: 'git commit -m "x"' });
allowed('git checkout of a branch is allowed', { cwd: F.tree, action: 'shell', command: 'git checkout idea' });
allowed('git reset --soft is allowed', { cwd: F.tree, action: 'shell', command: 'git reset --soft HEAD~1' });
allowed('a filename containing the word stash is not a stash', {
  cwd: F.tree, action: 'shell', command: 'cat docs/stash.md',
});

// ---- 6. the escape hatch ---------------------------------------------------------------
// Without a way out, the first false refusal makes the whole thing get uninstalled. It is
// per-folder, git-ignored, and visible in a directory listing.
console.log('== escape hatch ==');

const OFF = path.join(F.main, '.session-guard-off');
fs.writeFileSync(OFF, 'guard off for this folder\n');
allowed('a folder holding the off marker is exempt', {
  cwd: F.main, action: 'write', path: 'TRACKED.md',
});
allowed('the off marker exempts the destructive commands too', {
  cwd: F.main, action: 'shell', command: 'git add -A',
});
fs.rmSync(OFF);
refused(
  'removing the marker restores the refusal',
  { cwd: F.main, action: 'write', path: 'TRACKED.md' },
  'shared main checkout'
);

// ---- 6b. here-document bodies are data, not commands ------------------------------------
// The failure this prevents happened: writing this repository's own pull-request
// description was refused, because the description contains a table listing the commands
// the guard blocks. Reading a document's text as commands is the exact flaw in the
// substring check this guard replaces, so inheriting it would waste the whole exercise.
console.log('== here-documents ==');

const doc = (target) => [
  `cat > ${target} <<'EOF'`,
  '| Anywhere | `git add -A`, `git commit -a`, `git reset --hard`, `git clean` |',
  'and `rm -rf ~` and `git push --force` for good measure',
  'EOF',
].join('\n');

allowed('a document quoting the blocked commands is written, not refused', {
  cwd: F.main, action: 'shell', command: doc(path.join(OUTSIDE, 'notes.md').split(path.sep).join('/')),
});
allowed('the same document written from a worktree is allowed', {
  cwd: F.tree, action: 'shell', command: doc('NOTES.md'),
});
refused(
  'but the redirect target is still judged — the file really is being written',
  { cwd: F.main, action: 'shell', command: doc('TRACKED.md') },
  'shared main checkout'
);
refused(
  'a real command AFTER the body ends is still read as a command',
  {
    cwd: F.main,
    action: 'shell',
    command: `${doc(path.join(OUTSIDE, 'notes.md').split(path.sep).join('/'))}\ngit add -A`,
  },
  'stage the FOLDER'
);
allowed('an unterminated body does not leak into the command stream', {
  cwd: F.main,
  action: 'shell',
  command: `cat > ${path.join(OUTSIDE, 'x.md').split(path.sep).join('/')} <<'EOF'\ngit add -A\n`,
});

// ---- 6c. machine-level rules, everywhere -------------------------------------------------
// These are about the host, not about a project, so they hold in a folder that is not a
// repository, in a project carrying no guard, and in a folder that has switched the
// one-folder rule off. That last one matters: the marker exempts the folder rule and was
// never meant to exempt formatting a disk.
console.log('== machine-level refusals ==');

const HOME = path.join(TMP, 'fake-home');
fs.mkdirSync(HOME, { recursive: true });
const anywhere = (name, command, expect) => {
  for (const [label, cwd] of [['main checkout', F.main], ['worktree', F.tree], ['no repository', OUTSIDE]]) {
    const r = spawnSync(process.execPath, [GUARD], {
      input: JSON.stringify({ cwd, action: 'shell', command }),
      encoding: 'utf8', timeout: 60000, windowsHide: true,
      env: { ...process.env, SESSION_GUARD_HOME: HOME },
    });
    const err = (r.stderr || '').trim();
    if (!check(`${name} (${label})`, r.status === 2, `exit ${r.status}; stderr: ${err || '(empty)'}`)) continue;
    if (expect && !err.includes(expect)) fail(`${name} (${label}) — reason names the problem`, err);
  }
};

anywhere('force-pushing is refused', 'git push --force origin main', 'rewrites history');
anywhere('the short force flag is refused', 'git push -f origin main', 'rewrites history');
anywhere('deleting the home directory is refused', 'rm -rf ~', 'home directory');
anywhere('deleting the drive root is refused', 'rm -rf /', 'whole drive');
anywhere('deleting $HOME by name is refused', 'rm -rf $HOME', 'home directory');
anywhere('a disk partitioner is refused', 'diskpart /s script.txt', 'formats or repartitions');

console.log('== and their near neighbours are not ==');

const anywhereAllowed = (name, command) => {
  const r = spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify({ cwd: OUTSIDE, action: 'shell', command }),
    encoding: 'utf8', timeout: 60000, windowsHide: true,
    env: { ...process.env, SESSION_GUARD_HOME: HOME },
  });
  check(name, r.status === 0, (r.stderr || '').trim() || `exit ${r.status}`);
};

// The substring check this replaces refused this one, for containing the text `rm -rf /`.
anywhereAllowed('deleting a named directory under a root is allowed', 'rm -rf /tmp/scratch/build');
anywhereAllowed('deleting a named directory under home is allowed', 'rm -rf ~/projects/thing/node_modules');
anywhereAllowed('an ordinary push is allowed', 'git push origin main');
anywhereAllowed('force-with-lease is allowed — it refuses when the remote moved', 'git push --force-with-lease origin main');
anywhereAllowed('a command that merely mentions one of them is allowed', 'grep -rn "rm -rf /" docs/');

{
  // The off marker exempts the folder rule and nothing above it.
  const off = path.join(F.main, MARKER_NAME);
  fs.writeFileSync(off, 'off\n');
  const r = spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify({ cwd: F.main, action: 'shell', command: 'rm -rf ~' }),
    encoding: 'utf8', timeout: 60000, windowsHide: true,
    env: { ...process.env, SESSION_GUARD_HOME: HOME },
  });
  check('the off marker does not exempt the machine-level rules', r.status === 2, `exit ${r.status}`);
  fs.rmSync(off);
}

// ---- 7. fail open ----------------------------------------------------------------------
// A guard nobody can work around is a guard that stops twenty sessions when it breaks.
console.log('== fails open ==');

{
  const r = spawnSync(process.execPath, [GUARD], {
    input: 'this is not json',
    encoding: 'utf8', timeout: 60000, windowsHide: true,
  });
  check('unreadable input is allowed, not refused', r.status === 0, `exit ${r.status}`);
}
allowed('an action the guard has no opinion about is allowed', {
  cwd: F.main, action: 'read', path: 'TRACKED.md',
});
allowed('an empty command is allowed', { cwd: F.main, action: 'shell', command: '   ' });

// ---- 8. the bridge ---------------------------------------------------------------------
// It answers for every repository the host opens, so having no opinion about repositories
// that do not carry the guard is the property that makes installing it globally safe.
console.log('== harness bridge ==');

{
  const b = (payload) => ask(payload, BRIDGE);

  let r = b({ cwd: F.main, tool_name: 'Write', tool_input: { file_path: 'TRACKED.md' } });
  check('bridge refuses a Write in the main checkout', r.status === 2, `exit ${r.status}`);

  r = b({ cwd: F.main, tool_name: 'Edit', tool_input: { file_path: 'TRACKED.md' } });
  check('bridge refuses an Edit in the main checkout', r.status === 2, `exit ${r.status}`);

  r = b({ cwd: F.main, tool_name: 'Bash', tool_input: { command: 'git add -A' } });
  check('bridge refuses a work-destroying command', r.status === 2, `exit ${r.status}`);

  r = b({ cwd: F.main, tool_name: 'Read', tool_input: { file_path: 'TRACKED.md' } });
  check('bridge has no opinion about a read', r.status === 0, `exit ${r.status}`);

  r = b({ cwd: F.tree, tool_name: 'Write', tool_input: { file_path: 'TRACKED.md' } });
  check('bridge allows a Write inside a worktree', r.status === 0, `exit ${r.status}`);

  r = b({ cwd: OUTSIDE, tool_name: 'Write', tool_input: { file_path: 'x.txt' } });
  check('bridge is silent in a project that carries no guard', r.status === 0, `exit ${r.status}`);

  r = b({ tool_name: 'Bash' });
  check('bridge survives a payload with no input', r.status === 0, `exit ${r.status}`);

  // The fallback. Without it, replacing the host's standalone command check with this
  // would silently remove force-push and delete-your-home protection from every OTHER
  // project on the machine — the regression that matters most and shows up nowhere.
  const hooks = path.join(TMP, 'hooks-dir');
  fs.mkdirSync(hooks, { recursive: true });
  fs.copyFileSync(BRIDGE, path.join(hooks, 'session-guard.js'));
  const installedBridge = path.join(hooks, 'session-guard.js');

  r = ask({ cwd: OUTSIDE, tool_name: 'Bash', tool_input: { command: 'rm -rf ~' } }, installedBridge);
  check('with no fallback beside it, a guardless project is unguarded', r.status === 0, `exit ${r.status}`);

  fs.copyFileSync(GUARD, path.join(hooks, 'session-guard-policy.js'));
  r = ask({ cwd: OUTSIDE, tool_name: 'Bash', tool_input: { command: 'rm -rf ~' } }, installedBridge);
  check('the fallback keeps the machine-level rules in a project carrying no guard', r.status === 2, `exit ${r.status}`);

  r = ask({ cwd: OUTSIDE, tool_name: 'Bash', tool_input: { command: 'git status' } }, installedBridge);
  check('the fallback still says nothing about ordinary commands', r.status === 0, (r.err || `exit ${r.status}`));

  // A project's own guard wins, so a project can evolve its policy without the machine
  // copy overriding it.
  r = ask({ cwd: F.main, tool_name: 'Write', tool_input: { file_path: 'TRACKED.md' } }, installedBridge);
  check('a project carrying its own guard is judged by that one', r.status === 2, `exit ${r.status}`);
}

// ---- 9. the installer ------------------------------------------------------------------
// Idempotence is the case that matters: an installer that stacks a second entry every time
// it is re-run makes the hook fire twice and the settings file harder to read each time.
console.log('== installer ==');

{
  const cfg = path.join(TMP, 'config-dir');
  fs.mkdirSync(cfg, { recursive: true });
  // A settings file with existing content, to prove the installer adds rather than replaces.
  fs.writeFileSync(
    path.join(cfg, 'settings.json'),
    JSON.stringify({ model: 'opus', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'other-check' }] }] } }, null, 2)
  );

  const run = (...args) => spawnSync(process.execPath, [INSTALLER, ...args], {
    encoding: 'utf8', timeout: 60000, windowsHide: true,
    env: { ...process.env, SESSION_GUARD_CONFIG_DIR: cfg },
  });

  let r = run();
  check('installer exits 0', r.status === 0, (r.stderr || '') + (r.stdout || ''));
  check('installer wrote the bridge', fs.existsSync(path.join(cfg, 'hooks', 'session-guard.js')));
  check('installer wrote the machine-wide fallback policy',
    fs.existsSync(path.join(cfg, 'hooks', 'session-guard-policy.js')));

  const settingsOf = () => JSON.parse(fs.readFileSync(path.join(cfg, 'settings.json'), 'utf8'));
  let s = settingsOf();
  check('unrelated settings survive', s.model === 'opus');
  const ours = (st) => (st.hooks.PreToolUse || []).flatMap((g) => g.hooks || [])
    .filter((h) => String(h.command || '').includes('hooks/session-guard.js'));
  check('the hook entry is present once', ours(s).length === 1, JSON.stringify(s.hooks));
  check('an unrelated PreToolUse hook survives', JSON.stringify(s.hooks).includes('other-check'));

  run();
  r = run();
  s = settingsOf();
  check('re-running does not stack a second entry', ours(s).length === 1, JSON.stringify(s.hooks));

  r = run('--status');
  check('--status reports installed', r.status === 0, (r.stdout || '') + (r.stderr || ''));

  r = run('--uninstall');
  check('--uninstall exits 0', r.status === 0, (r.stderr || '') + (r.stdout || ''));
  s = settingsOf();
  check('--uninstall removes our entry', ours(s).length === 0, JSON.stringify(s.hooks));
  check('--uninstall leaves the unrelated hook alone', JSON.stringify(s.hooks).includes('other-check'));
  check('--uninstall removes the bridge', !fs.existsSync(path.join(cfg, 'hooks', 'session-guard.js')));
  check('--uninstall removes the fallback policy too',
    !fs.existsSync(path.join(cfg, 'hooks', 'session-guard-policy.js')));

  r = run('--status');
  check('--status reports NOT installed after removal', r.status !== 0);

  // A hook this supersedes is REPORTED, never removed. An installer that quietly deletes
  // somebody else's safety check because it believes it has replaced it is the exact
  // hazard refused everywhere else here, so the assertion is both halves: it says so, and
  // the entry is still there afterwards.
  const cfg2 = path.join(TMP, 'config-with-old-check');
  fs.mkdirSync(cfg2, { recursive: true });
  fs.writeFileSync(
    path.join(cfg2, 'settings.json'),
    // A placeholder path, not a synthetic home directory: publication hygiene scans this
    // tracked file and a fixture that looks like somebody's machine is a finding.
    JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'powershell -NoProfile -File path/to/hooks/safety-check.ps1' }] }] } }, null, 2)
  );
  const r2 = spawnSync(process.execPath, [INSTALLER], {
    encoding: 'utf8', timeout: 60000, windowsHide: true,
    env: { ...process.env, SESSION_GUARD_CONFIG_DIR: cfg2 },
  });
  const said = (r2.stdout || '') + (r2.stderr || '');
  check('installing names the check it supersedes', /safety-check/.test(said), said);
  check('and says its rules are covered rather than assuming the reader knows',
    /now covered here/.test(said), said);
  const after = JSON.parse(fs.readFileSync(path.join(cfg2, 'settings.json'), 'utf8'));
  check('and does not remove it — that is a person\'s decision',
    JSON.stringify(after.hooks).includes('safety-check.ps1'), JSON.stringify(after.hooks));
}

// ---- teardown --------------------------------------------------------------------------
try {
  git(['worktree', 'remove', '--force', F.tree], F.main);
  git(['worktree', 'remove', '--force', F.other], F.main);
  fs.rmSync(TMP, { recursive: true, force: true });
} catch {
  /* the OS temp dir is the OS's problem */
}

console.log(failed ? '\nFAILED' : '\nAll session-guard checks passed');
process.exit(failed);
