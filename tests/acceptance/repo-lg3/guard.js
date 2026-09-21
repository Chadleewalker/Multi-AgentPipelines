// Frozen acceptance test — repo-lg3, the [guard] half: make kickoff intake state genuinely
// durable. `test.js` beside it carries the RED checks. This file carries only what is already
// true, and pins the ground the red half stands on.
//
// [guard] Every check in this file is GREEN at the fork point and must stay green. It pins the
// four things this issue builds ON TOP OF and is forbidden to spend:
//
//   C1, its measurability half — the durable per-user root is `~/<name>`, and `~` is a real,
//        existing directory that is NOT inside the OS temp area. `test.js` measures the CLI's
//        DEFAULT by handing a child a disposable `HOME`/`USERPROFILE` and removing the state
//        seam entirely; that technique is only sound if `os.homedir()` in a child really follows
//        those variables, which is pinned here. Without it the red half would be measuring the
//        operator's live home, or nothing at all.
//   C2, its "OS-temp lock root" half — the host-global lock root really is computed under
//        `os.tmpdir()`, `PIPELINE_GLOBAL_LOCK_DIR` really re-aims it, and `canonicalTarget`
//        really folds equivalent spellings of one target to one key. Those are what make
//        "remove the OS-temp lock root" and "an equivalent target spelling" real operations
//        rather than figures of speech.
//   C3, its "ordinary target lock" and Docker halves — `runner/lock.js` is the ordinary target
//        lock, its authority file lives OUTSIDE the target repository (which is what makes "the
//        target Git tree is unchanged" achievable at all), and this suite starts no container
//        engine and asserts through no frozen path.
//   C4, its regression half — the mandatory regression command is still declared and still
//        required by `pipeline.config.json`, the frozen tree is byte-identical to the fork
//        point with nothing added under it, and `docs/control-plane.md` is still the authority
//        document the criterion asks to extend. A frozen acceptance suite cannot honestly run
//        the project's whole regression layer — that command is itself a frozen path — so what
//        it can hold is pinned here and the run stays a pipeline-level gate. Recorded in
//        `test.js` under SPEC DEFECTS rather than papered over.
//
// Nothing red belongs in this file. A [guard] file that is red at the fork point is a stale pin
// and refuses the freeze outright (`scripts/freeze-gate.js`, verdict `stale-guard`).
//
// SELF-CONTAINED ON PURPOSE. The freeze gate runs the guard subset ALONE in a flat scratch
// directory beside the suite, so this file requires nothing from its own folder. It resolves the
// repository the same way every suite here does — the tree it sits in, never the cwd — which is
// why the suite scan reads the suite through `REPO` rather than through `__dirname`.
//
// EVERY LOCK ROOT IT NAMES IS RE-AIMED. `PIPELINE_GLOBAL_LOCK_DIR` moves the host-global
// authority into a disposable temp directory for the length of one check, so running this file
// can never disturb a live run on the same machine, and the variable is restored afterwards.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..', '..');
const SUITE = path.join(REPO, 'tests', 'acceptance', 'repo-lg3');
const LOCK_MODULE = path.join(REPO, 'runner', 'lock.js');
const PROTECTED_TREE = path.join(REPO, 'scripts', 'protected-tree.js');
const CONTROL_PLANE_DOC = path.join(REPO, 'docs', 'control-plane.md');
const POLICY_FILE = path.join(REPO, 'pipeline.config.json');

// The durable per-user directory name `test.js` declares. Restated here only as the name inside
// the home directory: what this file pins is the HOME, not the layout, which is the red half's
// business.
const ROOT_NAME = '.multi-agent-pipelines';

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

// Temp trees can carry read-only files. Clear the bits before removing, and never let disposal
// decide a verdict.
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

const isUnder = (child, parent) => {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-lg3-'));

try {
  // ---- C1, the durable per-user root is a real and measurable place -------------------------
  const home = os.homedir();
  check(`C1 [guard] the running user has a home directory, so \`~/${ROOT_NAME}\` names a real place (${home})`,
    typeof home === 'string' && home.length > 0 && path.isAbsolute(home) && fs.existsSync(home));
  // Durable means "not the thing an OS temp sweep takes". The home directory is not inside the
  // temp area; the relationship in the other direction is normal on Windows and says nothing.
  check('C1 [guard] the home directory is not itself inside the OS temp area — a per-user root there is durable',
    !isUnder(home, os.tmpdir()));

  // The technique `test.js` measures the DEFAULT store with: a child's own idea of home follows
  // the environment, so the default can be observed without writing into the operator's real
  // home. Both variables are set because the answer comes from `HOME` on POSIX and from
  // `USERPROFILE` on Windows.
  const fakeHome = path.join(tmp, 'home');
  fs.mkdirSync(fakeHome, { recursive: true });
  const probe = spawnSync(process.execPath, ['-e', 'process.stdout.write(require("os").homedir())'], {
    encoding: 'utf8',
    timeout: 60000,
    windowsHide: true,
    env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome },
  });
  check(`C1 [guard] a child process's home directory still follows HOME/USERPROFILE, so the default store can be measured on a disposable home (got ${JSON.stringify((probe.stdout || '').slice(0, 120))})`,
    probe.status === 0 && path.resolve(String(probe.stdout || '.')) === path.resolve(fakeHome));

  // ---- C2/C3, the lock is still the lock, and its root is still OS-temp ----------------------
  check('C3 [guard] the ordinary target lock module is still present at runner/lock.js',
    fs.existsSync(LOCK_MODULE));
  // eslint-disable-next-line global-require, import/no-dynamic-require
  const LOCK = require(LOCK_MODULE);

  // Named individually rather than as a typed roster compared for equality: later work is
  // licensed to export more from this module, and a list pinned by equality would go red for
  // that. Each name below is one the red half depends on by name.
  for (const fn of ['acquire', 'release', 'globalLockPath', 'globalLockRoot', 'canonicalTarget']) {
    check(`C3 [guard] runner/lock.js still exports \`${fn}\``, typeof LOCK[fn] === 'function');
  }

  const targetDir = path.join(tmp, 'target');
  fs.mkdirSync(path.join(targetDir, 'sub'), { recursive: true });

  // The identity rule C2's "an equivalent target spelling" rests on. Computed on BOTH sides in
  // this one run — never compared against a spelling typed as an expected value — so nothing
  // later work does can move the answer.
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
  check(`C2 [guard] canonicalTarget still folds ${spellings.length} equivalent spellings of one target to one key`,
    new Set(spellings.map((s) => LOCK.canonicalTarget(s))).size === 1);
  check('C2 [guard] canonicalTarget still refuses an empty target path',
    (() => { try { LOCK.canonicalTarget(''); return false; } catch { return true; } })());

  // The lock root, in both of its forms: the OS-temp default C2 removes, and the re-aimed one
  // this suite uses so that removing it can never touch a live run.
  const savedAim = process.env.PIPELINE_GLOBAL_LOCK_DIR;
  try {
    delete process.env.PIPELINE_GLOBAL_LOCK_DIR;
    const defaultRoot = LOCK.globalLockRoot();
    check(`C2 [guard] the host-global lock root is still computed under the OS temp area — the very thing that makes it a bad home for durable intent (${defaultRoot})`,
      isUnder(defaultRoot, os.tmpdir()));
    check('C2 [guard] the host-global lock root is still NOT under the per-user home root this issue moves state to',
      !isUnder(defaultRoot, path.join(home, ROOT_NAME)));

    const aimed = path.join(tmp, 'lock-root');
    process.env.PIPELINE_GLOBAL_LOCK_DIR = aimed;
    const root = LOCK.globalLockRoot();
    const authority = LOCK.globalLockPath(targetDir);
    check('C2 [guard] PIPELINE_GLOBAL_LOCK_DIR still re-aims the host-global lock root',
      path.resolve(root) === path.resolve(aimed));
    check('C2 [guard] the target lock authority file still sits under that root, so removing the root really removes the lock state',
      isUnder(authority, aimed));
    check('C2 [guard] equivalent spellings of one target still reach one authority file',
      new Set(spellings.map((s) => LOCK.globalLockPath(s))).size === 1);
    // The property that makes "the target Git tree remains unchanged" achievable at all: the
    // host-global authority for a target is not inside that target.
    check('C3 [guard] the target lock authority file still sits OUTSIDE the target repository',
      !isUnder(authority, targetDir));
  } finally {
    if (savedAim === undefined) delete process.env.PIPELINE_GLOBAL_LOCK_DIR;
    else process.env.PIPELINE_GLOBAL_LOCK_DIR = savedAim;
  }

  // A sanity pin on the hashing primitive `test.js` states the id and hash rules with. Two
  // values computed in this one run: a suite whose hash function had quietly changed shape would
  // report tampering everywhere.
  check('C3 [guard] sha256 over UTF-8 bytes is still 64 lowercase hex characters',
    /^[0-9a-f]{64}$/.test(crypto.createHash('sha256').update(Buffer.from('kickoff', 'utf8')).digest('hex')));

  // ---- C3, this suite is Docker-free and asserts through no frozen path ----------------------
  //
  // A LINE CONJUNCTION, not a bare token search. Prose is allowed to SAY that this suite starts
  // no container engine and to name the frozen scripts it deliberately does not run — the header
  // of every file in this suite does — so a token scan would fire on the very comments that
  // record the rule. What is forbidden is a line that both invokes something and names one of
  // these, which is what an actual invocation looks like in every shape used here.
  const INVOKES = /\b(spawn|spawnSync|exec|execSync|execFile|execFileSync|fork|system|sh\s+-c)\b/;
  const FORBIDDEN = /(docker|podman|nerdctl|containerd|scripts\/test-|test-ci\.sh|test-all\.sh|run-acceptance\.sh|tests\/unit|e2e-scope|write-fixture-receipt|contracts\/control-plane\.json|runner\/(control-plane|credential-scan|artifact-schema|host-shell|repo-identity|process|deadline-watchdog)\.js|schemas\/(status|verify)\.schema\.json)/i;
  let suiteFiles = [];
  try {
    suiteFiles = fs.readdirSync(SUITE).filter((n) => /\.(js|sh)$/i.test(n)).sort();
  } catch { suiteFiles = []; }
  check(`C3 [guard] the suite's own executable files are readable from the tree it sits in (${suiteFiles.join(', ') || 'none'})`,
    suiteFiles.length > 0);
  const offending = [];
  for (const name of suiteFiles) {
    let text = '';
    try { text = fs.readFileSync(path.join(SUITE, name), 'utf8'); } catch { text = ''; }
    text.split(/\r?\n/).forEach((line, i) => {
      if (INVOKES.test(line) && FORBIDDEN.test(line)) offending.push(`${name}:${i + 1}`);
    });
  }
  check(`C3 [guard] no line in this suite invokes a container engine or a frozen path${offending.length ? ` (${offending.slice(0, 5).join(', ')})` : ''}`,
    offending.length === 0);

  // ---- C4, the prose home and the mandatory regression layer are still what the criterion means
  let doc = '';
  try { doc = fs.readFileSync(CONTROL_PLANE_DOC, 'utf8'); } catch { doc = ''; }
  check('C4 [guard] docs/control-plane.md is still present and non-trivial', doc.length > 500);
  // Substance tokens, not a sentence to copy: what is pinned is that this file still owns the
  // authority order, so a state-location section added by this issue has a correct home rather
  // than a coincidental one.
  for (const token of ['Authority order', 'contracts/control-plane.json', 'pipeline.config.json']) {
    check(`C4 [guard] docs/control-plane.md still names \`${token}\``, doc.includes(token));
  }

  let policy = null;
  try { policy = JSON.parse(fs.readFileSync(POLICY_FILE, 'utf8')); } catch { policy = null; }
  // Read, never typed: the criterion says the implementation must pass "the mandatory regression
  // suite", and what a frozen suite can hold is that such a suite is still declared and still
  // mandatory. Which command it is stays the project's business.
  check('C4 [guard] pipeline.config.json still declares a regression command',
    policy !== null && typeof policy.regressionCommand === 'string' && policy.regressionCommand.trim().length > 0);
  check('C4 [guard] that regression layer is still required rather than advisory',
    policy !== null && policy.regressionPolicy === 'required');
  check('C4 [guard] pipeline.config.json still declares a verify command for acceptance suites',
    policy !== null && typeof policy.verifyCommand === 'string' && policy.verifyCommand.trim().length > 0);

  // ---- C4, the frozen tree is untouched ------------------------------------------------------
  // Asserted as the house merge-base content diff over the frozen list READ FROM
  // `pipeline.config.json`, never a list typed here. Its purpose in this suite is narrow: the
  // criteria name a document and a CLI, and a suite that quietly asserted through a frozen
  // checker instead would be asserting through a file no implementation may adjust.
  // eslint-disable-next-line global-require, import/no-dynamic-require
  const PT = require(PROTECTED_TREE);
  const frozen = Array.isArray(policy && policy.frozenPaths) ? policy.frozenPaths : [];
  check('C4 [guard] pipeline.config.json still declares a frozen list', frozen.length > 0);

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
    // frozen-path matcher: `git ls-tree` accepts only a limited prefix pathspec, so handing it a
    // glob silently matches nothing and every such file then looks "added".
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
    // see, and a frozen directory pathspec is one a new checker would slide into.
    const now = git(REPO, 'ls-files', '-z', '--cached', '--others', '--exclude-standard');
    const present = String(now.stdout || '').split('\0').filter(Boolean).filter(isFrozen);
    const known = new Set(tracked);
    const added = present.filter((rel) => !known.has(rel));
    check(`C4 [guard] no file has been added under the frozen paths since the fork point${added.length ? ` (added: ${added.slice(0, 5).join(', ')})` : ''}`,
      now.status === 0 && added.length === 0);
  }
} catch (e) {
  failed = 1;
  console.log(`FAIL - HARNESS BROKEN: unexpected exception: ${e && e.stack ? e.stack : e}`);
} finally {
  rmrf(tmp);
}
process.exit(failed);
