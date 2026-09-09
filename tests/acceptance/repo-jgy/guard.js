// Frozen acceptance test — repo-jgy, the [guard] half: durable non-blocking kickoff intake.
// `test.js` beside it carries the RED checks. This file carries only what is already true.
//
// [guard] Every check in this file is GREEN at the fork point and must stay green. It pins the
// two things this issue is licensed to build ON TOP OF and forbidden to spend:
//
//   C4, its retention half — "submit invokes no child process and succeeds while the ORDINARY
//        TARGET LOCK is held; the target Git tree, index and Beads database remain unchanged".
//        The criterion is only meaningful if the thing it names still exists and still means
//        what it means: `runner/lock.js` is the ordinary target lock, its authority file lives
//        OUTSIDE the target repository, and `canonicalTarget` folds equivalent spellings of one
//        target to one key. If any of that moved, C4 and C3 would be asserting about a
//        different machine and `test.js` would be measuring nothing. Pinned here because it is
//        a statement about what did NOT change, and so is green by construction.
//   C6, its Docker-free half — "docs/control-plane.md, CLI help and Docker-free tests name the
//        same contract". "Docker-free" is a fact about THIS SUITE, true the moment it is
//        written, and a red file is the wrong home for it. Also pinned: that
//        `docs/control-plane.md` is still present and still the authority-order document the
//        criterion asks to extend, and that `pipeline.config.json` still freezes the paths this
//        suite may therefore never assert through.
//
// Nothing red belongs in this file. A [guard] file that is red at the fork point is a stale pin
// and refuses the freeze outright (`scripts/freeze-gate.js`, verdict `stale-guard`).
//
// SELF-CONTAINED ON PURPOSE. The freeze gate runs the guard subset ALONE in a flat scratch
// directory beside the suite, so this file requires nothing from its own folder. It resolves the
// repository the same way every suite here does — the tree it sits in, never the cwd — which is
// why the C6 scan reads the suite through `REPO` rather than through `__dirname`.
//
// IT RUNS NO FROZEN SCRIPT AND STARTS NO CONTAINER ENGINE, which is the very thing its C6 half
// asserts about the suite. Every behaviour below is stated directly against `runner/lock.js`,
// `scripts/protected-tree.js`, `pipeline.config.json` and Git.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..', '..');
const SUITE = path.join(REPO, 'tests', 'acceptance', 'repo-jgy');
const LOCK_MODULE = path.join(REPO, 'runner', 'lock.js');
const PROTECTED_TREE = path.join(REPO, 'scripts', 'protected-tree.js');
const CONTROL_PLANE_DOC = path.join(REPO, 'docs', 'control-plane.md');

// `-c safe.directory=*` is not decoration: fixtures and worktrees are routinely owned by a
// different uid than the process inside a container, and git's dubious-ownership guard would
// otherwise refuse every call. A frozen test must not depend on ambient git config.
const GIT_SAFE = ['-c', 'safe.directory=*'];

let failed = 0;
function check(name, cond) {
  console.log(`${cond ? 'ok' : 'FAIL'} - ${name}`);
  if (!cond) failed = 1;
}

function git(cwd, ...args) {
  return spawnSync('git', [...GIT_SAFE, ...args], {
    cwd, encoding: 'utf8', timeout: 60000, maxBuffer: 64 * 1024 * 1024, windowsHide: true,
  });
}

// Temp trees can carry read-only files, and a fixture repository's loose objects are read-only
// on Windows besides. Clear the bits before removing, and never let disposal decide a verdict.
function rmrf(target) {
  const walk = (p) => {
    let stat;
    try { stat = fs.lstatSync(p); } catch { return; }
    try { fs.chmodSync(p, 0o700); } catch { /* best effort */ }
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      let names = [];
      try { names = fs.readdirSync(p); } catch { names = []; }
      for (const n of names) walk(path.join(p, n));
    }
  };
  walk(target);
  try { fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  catch { /* disposable */ }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-jgy-'));

try {
  // ---- C4, the ordinary target lock is still the thing the criterion names -----------------
  check('C4 [guard] the ordinary target lock module is still present at runner/lock.js',
    fs.existsSync(LOCK_MODULE));
  // eslint-disable-next-line global-require, import/no-dynamic-require
  const LOCK = require(LOCK_MODULE);

  // Named individually rather than as a typed roster compared for equality: later work is
  // licensed to export more from this module, and a list pinned by equality would go red for
  // that. Each name below is one C4 or C3 depends on by name.
  for (const fn of ['acquire', 'release', 'globalLockPath', 'globalLockRoot', 'canonicalTarget']) {
    check(`C4 [guard] runner/lock.js still exports \`${fn}\``, typeof LOCK[fn] === 'function');
  }

  // The identity rule C3's "equivalent path spelling of the same target" rests on. Computed on
  // BOTH sides in this one run — never compared against a spelling typed as an expected value —
  // so nothing later work does can move the answer.
  const targetDir = path.join(tmp, 'target');
  fs.mkdirSync(path.join(targetDir, 'sub'), { recursive: true });
  const spellings = [
    targetDir,
    `${targetDir}${path.sep}`,
    path.join(targetDir, 'sub', '..'),
    `${targetDir}/./`,
  ];
  if (process.platform === 'win32') {
    // Only on win32: a backslash is a legal character in a POSIX file name, so a slash flip is
    // not an equivalent spelling there and asserting it would be asserting the wrong thing.
    spellings.push(targetDir.split(path.sep).join('/'), targetDir.toUpperCase());
  }
  const keys = new Set(spellings.map((s) => LOCK.canonicalTarget(s)));
  check(`C4 [guard] canonicalTarget still folds ${spellings.length} equivalent spellings of one target to one key`,
    keys.size === 1);
  check('C4 [guard] canonicalTarget still refuses an empty target path',
    (() => { try { LOCK.canonicalTarget(''); return false; } catch { return true; } })());

  // Where the authority lives, and that it is re-aimable. `test.js` isolates itself from the
  // operator's real host state through exactly this seam; without it the suite could not run at
  // all without touching live locks, and the intake state it measures would have nowhere
  // testable to be.
  const aimed = path.join(tmp, 'lock-home');
  const before = process.env.PIPELINE_GLOBAL_LOCK_DIR;
  try {
    process.env.PIPELINE_GLOBAL_LOCK_DIR = aimed;
    const root = LOCK.globalLockRoot();
    const authority = LOCK.globalLockPath(targetDir);
    check('C4 [guard] PIPELINE_GLOBAL_LOCK_DIR still re-aims the host-global lock root',
      path.resolve(root) === path.resolve(aimed));
    check('C4 [guard] the target lock authority file still sits under that root',
      path.resolve(path.dirname(authority)) === path.resolve(aimed));
    // The property that makes "the target Git tree remains unchanged" achievable at all: the
    // host-global authority for a target is not inside that target.
    const rel = path.relative(path.resolve(targetDir), path.resolve(authority));
    check('C4 [guard] the target lock authority file still sits OUTSIDE the target repository',
      rel.startsWith('..') || path.isAbsolute(rel));
    // Two spellings of one target must still reach one authority file, which is the same
    // property C3 asks of `list` and `show`.
    check('C4 [guard] equivalent spellings of one target still reach one authority file',
      new Set(spellings.map((s) => LOCK.globalLockPath(s))).size === 1);
  } finally {
    if (before === undefined) delete process.env.PIPELINE_GLOBAL_LOCK_DIR;
    else process.env.PIPELINE_GLOBAL_LOCK_DIR = before;
  }

  // ---- C6, this suite is Docker-free and asserts through no frozen path ---------------------
  //
  // A LINE CONJUNCTION, not a bare token search. Prose is allowed to SAY "this suite starts no
  // container engine" and to name the frozen scripts it deliberately does not run — the header
  // of every file in this suite does — so a token scan would fire on the very comments that
  // record the rule. What is forbidden is a line that both invokes something and names one of
  // these, which is what an actual invocation looks like in every shape used here.
  const INVOKES = /\b(spawn|spawnSync|exec|execSync|execFile|execFileSync|fork|system|sh\s+-c)\b/;
  const FORBIDDEN = /(docker|podman|nerdctl|containerd|scripts\/test-|test-ci\.sh|test-all\.sh|run-acceptance\.sh|tests\/unit|e2e-scope|write-fixture-receipt|contracts\/control-plane\.json|runner\/(control-plane|credential-scan|artifact-schema|host-shell|repo-identity|process|deadline-watchdog)\.js|schemas\/(status|verify)\.schema\.json)/i;
  let suiteFiles = [];
  try {
    suiteFiles = fs.readdirSync(SUITE).filter((n) => /\.(js|sh)$/i.test(n)).sort();
  } catch { suiteFiles = []; }
  check(`C6 [guard] the suite's own executable files are readable from the tree it sits in (${suiteFiles.join(', ') || 'none'})`,
    suiteFiles.length > 0);
  const offending = [];
  for (const name of suiteFiles) {
    let text = '';
    try { text = fs.readFileSync(path.join(SUITE, name), 'utf8'); } catch { text = ''; }
    text.split(/\r?\n/).forEach((line, i) => {
      if (INVOKES.test(line) && FORBIDDEN.test(line)) offending.push(`${name}:${i + 1}`);
    });
  }
  check(`C6 [guard] no line in this suite invokes a container engine or a frozen path${offending.length ? ` (${offending.slice(0, 5).join(', ')})` : ''}`,
    offending.length === 0);

  // The document the criterion asks to extend is still there and still the document it means.
  // Substance tokens, not a sentence to copy: what is pinned is that this file still owns the
  // authority order and still points at the control-plane contract, so a new contract section
  // added by this issue has a correct home rather than a coincidental one.
  let doc = '';
  try { doc = fs.readFileSync(CONTROL_PLANE_DOC, 'utf8'); } catch { doc = ''; }
  check('C6 [guard] docs/control-plane.md is still present and non-trivial', doc.length > 500);
  for (const token of ['Authority order', 'contracts/control-plane.json', 'pipeline.config.json']) {
    check(`C6 [guard] docs/control-plane.md still names \`${token}\``, doc.includes(token));
  }

  // ---- C4/C6, the frozen tree is untouched --------------------------------------------------
  // Asserted as the house merge-base content diff over the frozen list READ FROM
  // `pipeline.config.json`, never a list typed here. Its purpose in this suite is narrow: the
  // criteria name `docs/control-plane.md` and a CLI, and a suite that quietly asserted through
  // a frozen checker instead would be asserting through a file no implementation may adjust.
  // eslint-disable-next-line global-require, import/no-dynamic-require
  const PT = require(PROTECTED_TREE);
  let policy = null;
  try { policy = JSON.parse(fs.readFileSync(path.join(REPO, 'pipeline.config.json'), 'utf8')); }
  catch { policy = null; }
  const frozen = Array.isArray(policy && policy.frozenPaths) ? policy.frozenPaths : [];
  check('C4 [guard] pipeline.config.json still declares a frozen list', frozen.length > 0);
  // The three this suite is closest to touching, so the implementation cannot quietly unfreeze
  // the verifier or the contract loader and then assert through it. Not an equality: later work
  // is licensed to freeze more.
  for (const pinned of ['tools/run-acceptance.sh', 'contracts/control-plane.json', 'runner/control-plane.js']) {
    check(`C4 [guard] pipeline.config.json still freezes \`${pinned}\``, frozen.includes(pinned));
  }

  // The fork point, resolved from refs rather than typed. Where no integration ref is reachable
  // — a detached proof clone is exactly that — the comparison degrades to HEAD, which still
  // catches an uncommitted edit, and says so in the check's own name rather than in silence.
  const forkPoint = (() => {
    for (const ref of ['main', 'origin/main', 'refs/remotes/origin/main']) {
      const r = git(REPO, 'merge-base', ref, 'HEAD');
      if (r.status === 0 && String(r.stdout || '').trim()) return { rev: r.stdout.trim(), ref };
    }
    const head = git(REPO, 'rev-parse', 'HEAD');
    if (head.status === 0 && String(head.stdout || '').trim()) return { rev: head.stdout.trim(), ref: 'HEAD' };
    return null;
  })();
  check('C4 [guard] a fork point could be resolved', forkPoint !== null);

  if (forkPoint && frozen.length) {
    // Content comparison, never `git diff --name-only`: a Windows-origin clone stores CRLF on
    // disk, so every file "differs" from its blob inside a Linux container and the diff reports
    // the whole frozen tree as changed. Normalising both sides is what removes that false
    // positive. Compared against the WORKING TREE because an implementation task's edits are
    // uncommitted at the moment its verifier runs.
    const norm = (t) => String(t).replace(/\r\n/g, '\n');
    // Both sides are listed WITHOUT a pathspec and filtered here by the project's own
    // frozen-path matcher: `git ls-tree` accepts only a limited prefix pathspec, so handing it
    // `scripts/test-*.sh` silently matches nothing and every such script then looks "added".
    const matchers = frozen.map((p) => PT.regexFor(PT.safePattern(p, REPO)));
    const isFrozen = (rel) => matchers.some((re) => re.test(rel));
    const listed = git(REPO, 'ls-tree', '-r', '--name-only', '-z', forkPoint.rev);
    const tracked = String(listed.stdout || '').split('\0').filter(Boolean).filter(isFrozen);
    check(`C4 [guard] the fork point (${forkPoint.ref}) lists the frozen paths`,
      listed.status === 0 && tracked.length >= frozen.length);

    const changed = tracked.filter((rel) => {
      const shown = git(REPO, 'show', `${forkPoint.rev}:${rel}`);
      if (shown.status !== 0) return true;
      let disk;
      try { disk = fs.readFileSync(path.join(REPO, ...rel.split('/')), 'utf8'); } catch { return true; }
      return norm(disk) !== norm(shown.stdout);
    });
    check(`C4 [guard] every frozen path is byte-identical to the fork point${changed.length ? ` (changed: ${changed.slice(0, 5).join(', ')})` : ''}`,
      changed.length === 0);

    // An ADDED file matching a frozen pathspec is a change the tracked-file walk above cannot
    // see, and `tests/unit/` is a directory pathspec a new checker would slide into.
    const now = git(REPO, 'ls-files', '-z', '--cached', '--others', '--exclude-standard');
    const present = String(now.stdout || '').split('\0').filter(Boolean).filter(isFrozen);
    const known = new Set(tracked);
    const added = present.filter((rel) => !known.has(rel));
    check(`C4 [guard] no file has been added under the frozen paths since the fork point${added.length ? ` (added: ${added.slice(0, 5).join(', ')})` : ''}`,
      now.status === 0 && added.length === 0);
  }

  // A sanity pin on the hashing primitive `test.js` states the id/hash rule with. Two values
  // computed in this one run: nothing later work does can move it, and a suite whose hash
  // function had quietly changed shape would report tampering everywhere.
  check('C4 [guard] sha256 over UTF-8 bytes is still 64 lowercase hex characters',
    /^[0-9a-f]{64}$/.test(crypto.createHash('sha256').update(Buffer.from('kickoff', 'utf8')).digest('hex')));
} catch (e) {
  failed = 1;
  console.log(`FAIL - HARNESS BROKEN: unexpected exception: ${e && e.stack ? e.stack : e}`);
} finally {
  rmrf(tmp);
}
process.exit(failed);
