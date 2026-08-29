#!/usr/bin/env node
// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// One session, one folder — enforced at the moment of the write, not in prose
// (docs/parallel-sessions.md §8, change-log row `session-write-guard`).
//
// The problem this exists for. `docs/parallel-sessions.md` has said "one folder per
// session, never two sessions in one folder" since worktrees landed, and CLAUDE.md
// repeats the three rules that make it hold. Both are prose, and prose is advice a
// session weighs against the task in front of it. A session asked for a change it judges
// too small to be worth a pipeline run reasons its way to editing the shared checkout
// directly, and at two sessions that is usually survivable. At twenty it is not:
//
//   * Two sessions edit one file seconds apart. The second write wins. Neither sees a
//     conflict, because there is no merge — it is one file on one disk, and the first
//     version was never committed, so git never had a copy of it to offer back.
//   * One session commits. `git add -A` stages the FOLDER, so the other nineteen
//     sessions' half-finished files land in a commit about something else.
//   * There is one branch per folder, so there is no way to review, revert or merge one
//     session's change without carrying the other nineteen along with it.
//
// None of that is a token-efficiency problem; it is silent corruption of work that has no
// copy anywhere. The fix is not care. The fix is that the write does not happen.
//
// What this refuses, and only this:
//
//   1. Writing a file that git tracks (or would track) while running in the MAIN
//      checkout. Host-only paths — `runs/`, `.env.pipeline`, the local configs, anything
//      `.gitignore` covers — stay writable, because the operator session legitimately
//      writes them and none of them merge.
//   2. Writing into the main checkout from inside a worktree, which is the same
//      collision approached from the other side.
//   3. The four commands that destroy or mis-stage work another session wrote:
//      `git add -A`/`.`, `git commit -a`, `git checkout --`/`restore`/`stash`, and
//      `git reset --hard`/`clean`. These are refused from EVERY folder, worktree
//      included — a worktree shrinks the blast radius to your own work, which is an
//      improvement and not a licence.
//
// It is a guard, not a sandbox. It stops the honest default, names the folder rule, and
// says the one command that fixes it. A session determined to route around it can; that
// is not the failure mode this is for.
//
// Deliberately fails OPEN. A guard that cannot decide — git missing, a path it cannot
// parse, its own crash — allows the write. Twenty sessions bricked by a broken checker is
// a worse outcome than the collision it was watching for, and a guard that fails closed
// gets uninstalled the first time it is wrong.
//
// Harness-neutral by construction: it reads one JSON object on stdin and answers with an
// exit code, so wiring it to a particular agent CLI is a separate, host-only concern
// (`scripts/session-guard-bridge.js`, installed by `scripts/install-session-guard.js`).
// Nothing tracked in this repo configures an agent hook — see
// `tests/unit/agent-hooks.test.js` for why that boundary matters here.
//
//   stdin   {"cwd":"<folder>","action":"write","path":"<file>"}
//           {"cwd":"<folder>","action":"shell","command":"<command line>"}
//   exit 0  allowed, silent
//   exit 2  refused, plain-English reason on stderr
//
// Zero dependencies, node built-ins only, spawns nothing but `git`. Checks:
// `bash scripts/test-session-guard.sh`.
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const GIT = process.env.SESSION_GUARD_GIT || 'git';

// A folder holding this file is exempt. It is git-ignored, so creating one is a local act
// that cannot travel to anyone else, and its presence is visible in a directory listing —
// which is the property an environment-variable escape hatch would not have.
const MARKER = '.session-guard-off';

const WIN = process.platform === 'win32';

function allow() {
  process.exit(0);
}

function refuse(reason) {
  process.stderr.write(`session-guard: ${reason}\n`);
  process.exit(2);
}

// ---- paths ---------------------------------------------------------------------------

function norm(p) {
  const a = path.resolve(p);
  return WIN ? a.toLowerCase() : a;
}

// True when `child` is `dir` itself or lives beneath it. Used for every containment
// question here, so the Windows case-folding is stated once.
function within(dir, child) {
  const rel = path.relative(norm(dir), norm(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// Walk up for the `.git` entry. Which KIND of entry it is answers the only question that
// matters: a directory means this folder is the main checkout, where the shared history
// and everyone else's files live; a file means it is a worktree, and the file names the
// main checkout's `.git` directory, which is how the main checkout is located from here
// without spawning anything.
function locate(cwd) {
  let dir = path.resolve(cwd);
  for (;;) {
    const dotgit = path.join(dir, '.git');
    let st = null;
    try {
      st = fs.statSync(dotgit);
    } catch {
      st = null;
    }
    if (st && st.isDirectory()) return { root: dir, isMain: true, main: dir };
    if (st && st.isFile()) {
      let main = null;
      try {
        const m = /gitdir:\s*(.+)/.exec(fs.readFileSync(dotgit, 'utf8'));
        if (m) {
          // <main>/.git/worktrees/<slug>  ->  <main>
          const gitdir = path.resolve(m[1].trim().replace(/[\\/]+$/, ''));
          const parts = gitdir.split(/[\\/]/);
          const at = parts.lastIndexOf('worktrees');
          if (at > 1 && parts[at - 1] === '.git') main = parts.slice(0, at - 1).join(path.sep);
        }
      } catch {
        main = null;
      }
      return { root: dir, isMain: false, main };
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// Every other session's folder, read from git's own worktree registry rather than from a
// folder-naming convention. Each `<main>/.git/worktrees/<slug>/gitdir` names that
// worktree's `.git` file, so its parent is the folder — which is true whether the session
// folders sit inside the repository, beside it, or on another drive, and stays true if the
// container directory is ever renamed.
//
// This matters more once they live inside the repository: a sibling folder is only
// reachable by a path that climbs out of the checkout, while `.worktrees/other-idea/file`
// is a short relative path from the main checkout, and the container directory is
// git-ignored, so the "would git track this?" question answers "no" for every file in
// every other session's folder. Without this the ignore rule would quietly open the very
// collision the folders exist to prevent.
function registeredWorktrees(main) {
  const dir = path.join(main, '.git', 'worktrees');
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const roots = [];
  for (const name of names) {
    try {
      const gitfile = fs.readFileSync(path.join(dir, name, 'gitdir'), 'utf8').trim();
      if (gitfile) roots.push(path.dirname(path.resolve(gitfile)));
    } catch {
      /* a half-written registry entry is not worth refusing a write over */
    }
  }
  return roots;
}

// Would git track this file? `check-ignore` is the only correct answer, because the
// allowlist IS `.gitignore` — writing the host-only list out a second time here would be
// the "second source literal" this repo bans, and it would go stale the first time
// `.gitignore` gained an entry.
//
// Two fast paths first, because they are the ones a session hits constantly and each
// spawn is paid per write.
function ignored(root, abs) {
  const rel = path.relative(root, abs).split(path.sep).join('/');
  if (!rel || rel.startsWith('..')) return true;
  if (rel === '.git' || rel.startsWith('.git/')) return true;
  if (rel === 'runs' || rel.startsWith('runs/') || rel.startsWith('node_modules/')) return true;
  const r = spawnSync(GIT, ['check-ignore', '-q', '--', rel], {
    cwd: root,
    timeout: 15000,
    windowsHide: true,
  });
  // 0 ignored, 1 not ignored, anything else is git failing to answer — fail open.
  if (r.error || typeof r.status !== 'number') return true;
  return r.status !== 1;
}

// ---- shell parsing -------------------------------------------------------------------

// Drop the BODY of every here-document, keeping the command line that introduces it.
//
// A here-document body is data being written, not commands being run, and a guard that
// reads it as commands refuses the wrong thing with total confidence. This is not a
// hypothetical: writing this repository's own pull-request description was refused,
// because the description contains a table listing the commands the guard blocks. The
// same mistake in the host's earlier substring-matching check is what made that check
// worth replacing, so inheriting it here would have been the whole exercise wasted.
//
// The introducer's own line is kept, so `cat > tracked.md <<EOF` is still judged on its
// redirect target — the file is genuinely being written, whatever the body says. An
// unterminated body runs to the end of the command, which is the reading a shell would
// take too.
function stripHeredocs(command) {
  const lines = command.split('\n');
  const kept = [];
  let terminator = null;
  for (const line of lines) {
    if (terminator !== null) {
      if (line.trim() === terminator) terminator = null;
      continue;
    }
    kept.push(line);
    // <<WORD, <<-WORD, <<'WORD', <<"WORD" — last one on the line wins, which is what a
    // shell does with a single command; multiple here-docs on one line are rare enough
    // that reading only the last is a safe simplification for a guard.
    const intro = [...line.matchAll(/<<-?\s*(["']?)([A-Za-z_][A-Za-z0-9_]*)\1/g)].pop();
    if (intro) terminator = intro[2];
  }
  return kept.join('\n');
}

// A small tokeniser: enough to find the operands of a redirect, a `tee` or a `sed -i`,
// and no more. It is not a shell. Anything it cannot read becomes an allowed command,
// per the fail-open rule at the top.
function tokenise(command) {
  const out = [];
  let cur = '';
  let quote = null;
  let had = false;
  const push = () => {
    if (had) out.push(cur);
    cur = '';
    had = false;
  };
  for (let i = 0; i < command.length; i += 1) {
    const c = command[i];
    if (quote) {
      if (c === quote) quote = null;
      else {
        cur += c;
        had = true;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      had = true;
      continue;
    }
    if (/\s/.test(c)) {
      push();
      continue;
    }
    if (c === '|' || c === ';' || c === '&') {
      push();
      let run = c;
      while (command[i + 1] === c) {
        run += c;
        i += 1;
      }
      out.push(run);
      continue;
    }
    cur += c;
    had = true;
  }
  push();
  return out;
}

const CONTROL = new Set(['|', '||', ';', '&', '&&', '(', ')']);
const isFlag = (t) => t.startsWith('-') && t !== '-';

// The commands CLAUDE.md forbids outright, each with the damage it does. Matched against
// the token stream rather than the raw string so that `git add -A` and `git add --all`
// and a quoted variant all land the same way, and so a filename containing the words
// does not trip it.
function destructiveGit(tokens) {
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i] !== 'git') continue;
    const rest = [];
    for (let j = i + 1; j < tokens.length && !CONTROL.has(tokens[j]); j += 1) rest.push(tokens[j]);
    const sub = rest.find((t) => !isFlag(t));
    const flags = rest.filter(isFlag);
    const shortFlags = flags
      .filter((f) => !f.startsWith('--'))
      .join('')
      .replace(/-/g, '');

    if (sub === 'add' && (flags.includes('-A') || flags.includes('--all') || rest.includes('.'))) {
      return '`git add -A` and `git add .` stage the FOLDER, not your work. In a shared checkout that commits other sessions\' half-finished files under your message; in your own worktree it sweeps up whatever you left unfinished an hour ago. Stage the paths you changed by name instead.';
    }
    if (sub === 'commit' && shortFlags.includes('a')) {
      return '`git commit -a` commits every modified tracked file in the folder, not the ones you changed. Stage the paths you changed by name, then commit.';
    }
    if (sub === 'checkout' && rest.includes('--')) {
      return '`git checkout -- <path>` throws away the edits in that file. If any of them were not yours they are gone, because uncommitted work has no copy anywhere. If you need a clean tree to test something, make a worktree.';
    }
    if (sub === 'restore') {
      return '`git restore` throws away uncommitted edits, and uncommitted work has no copy anywhere. If you need a clean tree to test something, make a worktree.';
    }
    if (sub === 'stash') {
      return '`git stash` pockets every uncommitted change in the folder, including changes you did not write, and moves them somewhere the session that made them will not look.';
    }
    if (sub === 'reset' && flags.includes('--hard')) {
      return '`git reset --hard` permanently discards every uncommitted change in the folder.';
    }
    if (sub === 'clean') {
      return '`git clean` permanently deletes untracked files, which is where another session\'s brand-new work lives before its first commit.';
    }
  }
  return null;
}

// ---- machine-level refusals ------------------------------------------------------------
// These are about the HOST, not about any repository, so they apply in every folder — a
// project that carries no guard of its own, a folder that is not a repository at all, and
// a folder holding the off marker, which exempts the one-folder rule and was never meant to
// exempt formatting a disk.
//
// They live here rather than in the harness bridge so that there is exactly one command
// parser. The host's earlier check matched these as plain substrings, which refused
// `rm -rf /tmp/scratch` for containing `rm -rf /` and refused any command whose text merely
// mentioned one of them. Every rule below reads parsed words instead.

function homeDir() {
  return process.env.SESSION_GUARD_HOME || require('os').homedir();
}

// `/`, a bare drive root, or the home directory — the three operands that turn a delete
// into a machine rebuild. `~` is expanded because the shell would; `$HOME` is matched by
// name because this is not a shell and does not expand variables.
function catastrophicTarget(token) {
  if (token === '~' || token === '$HOME' || token === '${HOME}') return true;
  if (/^~[\\/]?$/.test(token)) return true;
  let abs;
  try {
    abs = path.resolve(token.replace(/^~(?=[\\/])/, homeDir()));
  } catch {
    return false;
  }
  if (norm(abs) === norm(homeDir())) return true;
  return norm(abs) === norm(path.parse(abs).root);
}

function hostDangerous(tokens) {
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    const rest = [];
    for (let j = i + 1; j < tokens.length && !CONTROL.has(tokens[j]); j += 1) rest.push(tokens[j]);

    if (t === 'git') {
      const sub = rest.find((x) => !isFlag(x));
      const flags = rest.filter(isFlag);
      const short = flags.filter((f) => !f.startsWith('--')).join('').replace(/-/g, '');
      // `--force-with-lease` is deliberately NOT here. It is still a rewrite, but it
      // refuses when the remote has moved, which is the case this rule is protecting; a
      // guard that also blocked the safe form would be the over-blocking that gets a guard
      // switched off.
      if (sub === 'push' && (flags.includes('--force') || short.includes('f'))) {
        return 'force-pushing rewrites history that other people and other clones already have, and there is no undo on the remote. If a branch genuinely needs replacing, say so and do it deliberately.';
      }
    }

    if (t === 'rm') {
      const recursive = rest.some((f) => isFlag(f) && (/^--recursive$/.test(f) || (!f.startsWith('--') && /r/i.test(f))));
      if (!recursive) continue;
      for (const operand of rest) {
        if (isFlag(operand)) continue;
        if (catastrophicTarget(operand)) {
          return `\`rm\` on \`${operand}\` recursively would delete the whole home directory or the whole drive. Name the directory you actually mean.`;
        }
      }
    }

    if (t === 'diskpart' || t === 'Format-Volume' || /^mkfs(\.|$)/.test(t)) {
      return `\`${t}\` formats or repartitions a disk. Nothing an agent session is doing needs that.`;
    }
  }
  return null;
}

// The file operands of the constructs an agent actually edits files with. Inputs are
// deliberately NOT collected: `sed -n '1,5p' CLAUDE.md > /tmp/out` writes to the scratch
// file and reads the tracked one, and a guard that refused it would be wrong in the way
// that gets a guard switched off.
function writeTargets(tokens) {
  const targets = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];

    // `> file`, `>> file`, `1> file`, and the attached forms `>file` / `2>>file`.
    // `2>&1` and friends duplicate a descriptor and touch no file.
    const redir = /^(\d*)(>>?)(.*)$/.exec(t);
    if (redir && redir[2]) {
      const tail = redir[3];
      if (tail.startsWith('&')) continue;
      if (tail) targets.push(tail);
      else if (tokens[i + 1] && !CONTROL.has(tokens[i + 1])) targets.push(tokens[i + 1]);
      continue;
    }

    if (t === 'tee') {
      for (let j = i + 1; j < tokens.length && !CONTROL.has(tokens[j]); j += 1) {
        if (!isFlag(tokens[j])) targets.push(tokens[j]);
      }
      continue;
    }

    if (t === 'sed') {
      const rest = [];
      for (let j = i + 1; j < tokens.length && !CONTROL.has(tokens[j]); j += 1) rest.push(tokens[j]);
      const inPlace = rest.some(
        (f) => f === '--in-place' || /^--in-place=/.test(f) || (/^-[^-]*i/.test(f))
      );
      if (!inPlace) continue;
      const operands = rest.filter((f) => !isFlag(f));
      // Without `-e`/`-f` the first operand is the script, not a file.
      const scripted = rest.some((f) => /^-[^-]*[ef]/.test(f) || f === '--expression' || f === '--file');
      targets.push(...(scripted ? operands : operands.slice(1)));
      continue;
    }

    if (t === 'rm' || t === 'mv' || t === 'touch') {
      // `mv` removes its sources as well as writing its destination, so every operand
      // counts. `cp` only writes the last one.
      for (let j = i + 1; j < tokens.length && !CONTROL.has(tokens[j]); j += 1) {
        if (!isFlag(tokens[j])) targets.push(tokens[j]);
      }
      continue;
    }

    if (t === 'cp') {
      const operands = [];
      for (let j = i + 1; j < tokens.length && !CONTROL.has(tokens[j]); j += 1) {
        if (!isFlag(tokens[j])) operands.push(tokens[j]);
      }
      if (operands.length > 1) targets.push(operands[operands.length - 1]);
      continue;
    }
  }
  return targets.filter((t) => t && !t.startsWith('-') && !/^\$/.test(t));
}

// ---- the reasons ---------------------------------------------------------------------

function sharedCheckoutReason(rel) {
  return [
    `this session is running in the shared main checkout, and \`${rel}\` is a file git tracks.`,
    '',
    'Every other session on this project has that same file open in that same folder. Two',
    'sessions editing it seconds apart is not a merge conflict — the second write simply wins,',
    'nobody is told, and the overwritten version was never committed so git cannot give it back.',
    '',
    'Take your own folder first, then reopen this session with it as the working directory:',
    '',
    '    node scripts/worktree.js new <short-idea-name>',
    '',
    'Host-only paths stay writable here — runs/, the local configs, anything .gitignore covers.',
    `To exempt this folder anyway, create a file named ${MARKER} in it.`,
  ].join('\n');
}

function otherSessionReason(folder) {
  return [
    `\`${folder}\` is another session's folder.`,
    '',
    'Session folders sit inside the repository and the repository ignores them, so a path',
    'into one looks harmless and is not: whoever is working in there has uncommitted files',
    'with no copy anywhere, on a branch that is not yours. Make the change in your own',
    'folder, or ask for theirs to be merged.',
  ].join('\n');
}

function reachInReason(rel) {
  return [
    `\`${rel}\` is in the main checkout, and this session is in a worktree.`,
    '',
    'The point of the worktree is that your files are yours. Writing back into the shared',
    'checkout puts the change where every other session will pick it up as an unexplained',
    'edit, and where it belongs to no branch and no PR. Make the change in this folder and',
    'let the merge carry it over.',
  ].join('\n');
}

// ---- main ----------------------------------------------------------------------------

function main() {
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    allow();
    return;
  }

  const cwd = payload && payload.cwd ? String(payload.cwd) : process.cwd();
  const place = locate(cwd);

  // Machine-level rules are settled before anything repository-shaped is consulted: they
  // hold in a folder that is not a repository, in a project that carries no guard of its
  // own, and in a folder that has switched the one-folder rule off.
  const tokens = payload.action === 'shell' && String(payload.command || '').trim()
    ? tokenise(stripHeredocs(String(payload.command)))
    : null;
  if (tokens) {
    const host = hostDangerous(tokens);
    if (host) refuse(host);
  }

  if (!place) allow(); // not in a git repository — nothing project-shaped left to say

  if (fs.existsSync(path.join(place.root, MARKER))) allow();

  if (payload.action === 'shell') {
    if (!tokens) allow();

    const destructive = destructiveGit(tokens);
    if (destructive) refuse(destructive);

    // Shell writes are judged by exactly the rules a Write/Edit is judged by; the tool
    // used to make the change is not the thing that matters.
    for (const raw of writeTargets(tokens)) {
      const verdict = judgeWrite(place, cwd, raw);
      if (verdict) refuse(verdict);
    }
    allow();
  }

  if (payload.action === 'write') {
    const raw = String(payload.path || '');
    if (!raw) allow();
    const verdict = judgeWrite(place, cwd, raw);
    if (verdict) refuse(verdict);
    allow();
  }

  allow(); // an action this guard has no opinion about
}

// The one place a write is judged, so the Write tool and a shell redirect cannot drift
// apart. Returns null to allow, or the reason to refuse.
function judgeWrite(place, cwd, raw) {
  let abs;
  try {
    abs = path.resolve(cwd, raw);
  } catch {
    return null;
  }

  const mine = place.root;
  const main = place.isMain ? place.root : place.main;

  // Somebody else's session folder, first and regardless of everything below. It has to be
  // first because a session folder now sits inside the main checkout, in a directory the
  // repository ignores: judged by the shared-checkout rule this would come back "git does
  // not track it, so writing it collides with nobody", which is exactly backwards.
  if (main) {
    for (const other of registeredWorktrees(main)) {
      if (norm(other) === norm(mine)) continue;
      if (within(other, abs)) return otherSessionReason(path.basename(other));
    }
  }

  if (place.isMain) {
    if (!within(mine, abs)) return null; // scratchpad, another project, anywhere else
    if (ignored(mine, abs)) return null;
    return sharedCheckoutReason(path.relative(mine, abs).split(path.sep).join('/'));
  }

  // In a worktree: your own folder is yours, and reaching back into the shared checkout is
  // the same collision approached from the other side.
  if (within(mine, abs)) return null;
  if (main && within(main, abs)) {
    if (ignored(main, abs)) return null;
    return reachInReason(path.relative(main, abs).split(path.sep).join('/'));
  }
  return null;
}

main();
