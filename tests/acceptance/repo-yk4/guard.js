// Frozen acceptance test — repo-yk4, the [guard] half: making the protected manifest read
// GIT-RELEVANT file modes must not cost it the sensitivity it already has.
//
// [guard] Every check in this file is GREEN at the fork point and must stay green. It pins
// two things the repair is licensed to keep and forbidden to spend:
//
//   C2, its retention half — "keep byte and symlink sensitivity, and still detect
//        executable-bit changes where Git records them". The repair loosens ONE axis of
//        `entryFor`'s comparison (the permission bits Git does not record). Loosening the
//        whole entry would pass every red check in test.js and quietly stop protecting the
//        frozen tree, which is the failure this file exists to catch.
//   C4 — "no existing frozen path is edited by the implementation task", asserted as the
//        house merge-base content diff (DESIGN.md's brittleness note cites `repo-1cy`'s
//        version of this as the correct shape) over the frozen list READ FROM
//        `pipeline.config.json`, never a list typed here.
//
// Nothing red belongs in this file. A [guard] file that is red at the fork point is a stale
// pin and refuses the freeze outright (`scripts/freeze-gate.js`, verdict `stale-guard`).
//
// SELF-CONTAINED ON PURPOSE. The freeze gate runs the guard subset ALONE in a flat scratch
// directory beside the suite, so this file requires nothing from its own folder. It resolves
// the repository the same way every suite here does — the tree it sits in, never the cwd.
//
// IT RUNS NO FROZEN SCRIPT. `scripts/test-*.sh` and `tests/unit/` are frozen paths; a frozen
// suite that shells into one is asserting through a file it may never adjust. Every behaviour
// below is stated directly against `scripts/protected-tree.js` and against Git.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..', '..');
const PROTECTED_TREE = path.join(REPO, 'scripts', 'protected-tree.js');

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

// Temp trees carry read-only files on purpose (that is half of what this file measures) and a
// fixture repository's loose objects are read-only on Windows besides. Clear the bits before
// removing, and never let disposal decide a verdict.
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

// A symbolic link where the host allows one, and a directory junction where it does not:
// Windows refuses `symlink()` to an unprivileged process but allows a junction, and Node
// reports both through `lstat().isSymbolicLink()`, which is the predicate `protected-tree.js`
// actually branches on. Returns null when neither is available.
function linkDir(target, where) {
  for (const type of [undefined, 'junction']) {
    try { fs.symlinkSync(target, where, type); return type || 'symlink'; } catch { /* try next */ }
  }
  return null;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-yk4-'));
const POLICY = { frozenPaths: ['tools/run-acceptance.sh'] };

// A repo-shaped tree: the two patterns `protectedManifest` always adds (`tests/acceptance` and
// `pipeline.config.json`) plus one declared frozen path, which is every shape it classifies.
function tree(name) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(path.join(dir, 'tests', 'acceptance', 'demo'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'tools'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'pipeline.config.json'), '{"frozenPaths":["tools/run-acceptance.sh"]}\n');
  fs.writeFileSync(path.join(dir, 'tools', 'run-acceptance.sh'), '# runner\n');
  fs.writeFileSync(path.join(dir, 'tests', 'acceptance', 'demo', 'test.js'), '// demo\n');
  return dir;
}

function commit(dir) {
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'fixture@test.local');
  git(dir, 'config', 'user.name', 'fixture');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'fixture');
  return dir;
}

try {
  check('C2 the protected tree module is still present at scripts/protected-tree.js',
    fs.existsSync(PROTECTED_TREE));
  // eslint-disable-next-line global-require, import/no-dynamic-require
  const PT = require(PROTECTED_TREE);
  const manifest = (dir) => PT.protectedManifest(dir, POLICY, 'demo');
  const differs = (a, b) => PT.manifestDifference(manifest(a), manifest(b));

  // ---- C2, byte sensitivity ---------------------------------------------------------------
  const base = tree('base');
  const bytes = tree('bytes');
  check('C2 [guard] two identical repo-shaped trees still compare equal',
    differs(base, bytes).length === 0);

  fs.writeFileSync(path.join(bytes, 'tools', 'run-acceptance.sh'), '# runnex\n');
  check('C2 [guard] a one-byte edit to a protected file is still reported as edited',
    differs(base, bytes).some((d) => /^edited tools\/run-acceptance\.sh$/.test(d)));

  fs.writeFileSync(path.join(bytes, 'tools', 'run-acceptance.sh'), '# runner\n');
  fs.rmSync(path.join(bytes, 'tests', 'acceptance', 'demo', 'test.js'));
  check('C2 [guard] a protected file that disappears is still reported as removed',
    differs(base, bytes).some((d) => /^removed tests\/acceptance\/demo\/test\.js$/.test(d)));

  fs.writeFileSync(path.join(bytes, 'tests', 'acceptance', 'demo', 'test.js'), '// demo\n');
  fs.writeFileSync(path.join(bytes, 'tests', 'acceptance', 'demo', 'extra.js'), '// extra\n');
  check('C2 [guard] a protected file that appears is still reported as added',
    differs(base, bytes).some((d) => /^added tests\/acceptance\/demo\/extra\.js$/.test(d)));

  // ---- C2, symlink sensitivity ------------------------------------------------------------
  // Mode normalisation must not collapse a link into the thing it points at. The fixture
  // stands a real directory in one tree against a link to an IDENTICAL directory in the other,
  // so nothing but the link-ness itself distinguishes them.
  const realTree = tree('link-real');
  const linkTree = tree('link-link');
  fs.mkdirSync(path.join(realTree, 'tests', 'acceptance', 'demo', 'sub'));
  fs.writeFileSync(path.join(realTree, 'tests', 'acceptance', 'demo', 'sub', 'k.js'), '// k\n');
  const away = path.join(tmp, 'away');
  fs.mkdirSync(away);
  fs.writeFileSync(path.join(away, 'k.js'), '// k\n');
  const linkKind = linkDir(away, path.join(linkTree, 'tests', 'acceptance', 'demo', 'sub'));
  if (linkKind === null) {
    // Recorded rather than silently dropped: an environment that can make no link at all has
    // nothing to say about link sensitivity, and pretending otherwise would be the vacuous
    // pass this whole file exists to refuse.
    check('C2 [guard] symlink sensitivity is unobservable here (no symlink or junction can be created) — recorded, not claimed',
      true);
  } else {
    const linked = manifest(linkTree);
    check(`C2 [guard] a protected directory replaced by a ${linkKind} is still reported`,
      PT.manifestDifference(manifest(realTree), linked)
        .some((d) => /tests\/acceptance\/demo\/sub/.test(d)));
    check(`C2 [guard] the ${linkKind} is recorded as a link and not walked through`,
      linked.some(([rel, value]) => rel === 'tests/acceptance/demo/sub' && /^link:/.test(value))
      && !linked.some(([rel]) => rel === 'tests/acceptance/demo/sub/k.js'));

    const away2 = path.join(tmp, 'away2');
    fs.mkdirSync(away2);
    fs.writeFileSync(path.join(away2, 'k.js'), '// k\n');
    rmrf(path.join(linkTree, 'tests', 'acceptance', 'demo', 'sub'));
    linkDir(away2, path.join(linkTree, 'tests', 'acceptance', 'demo', 'sub'));
    check('C2 [guard] retargeting that link at an identical directory is still reported',
      PT.manifestDifference(linked, manifest(linkTree))
        .some((d) => /^edited tests\/acceptance\/demo\/sub$/.test(d)));
  }

  // ---- C2, the executable bit, where Git records it ----------------------------------------
  // The criterion's own qualifier is load-bearing. Git records an executable bit only where
  // the filesystem carries one and `core.filemode` is therefore true; on the Windows host
  // `chmod` cannot set it and `git status` stays clean, so there is no recorded change to
  // detect and this check states the precondition instead of inventing one.
  const execRepo = commit(tree('exec'));
  const execFile = path.join(execRepo, 'tools', 'run-acceptance.sh');
  const beforeExec = manifest(execRepo);
  let execRepresentable = false;
  try { fs.chmodSync(execFile, 0o755); execRepresentable = (fs.lstatSync(execFile).mode & 0o111) !== 0; }
  catch { execRepresentable = false; }
  const execRecorded = execRepresentable
    && String(git(execRepo, 'status', '--porcelain').stdout || '').trim() !== '';
  if (!execRecorded) {
    check('C2 [guard] this filesystem records no executable bit for Git to see — recorded, not claimed',
      !execRepresentable || String(git(execRepo, 'status', '--porcelain').stdout || '').trim() === '');
  } else {
    check('C2 [guard] an executable-bit change Git records is still reported by the manifest',
      PT.manifestDifference(beforeExec, manifest(execRepo))
        .some((d) => /^edited tools\/run-acceptance\.sh$/.test(d)));
  }

  // ---- C4, the frozen tree is untouched ----------------------------------------------------
  let policy = null;
  try { policy = JSON.parse(fs.readFileSync(path.join(REPO, 'pipeline.config.json'), 'utf8')); }
  catch { policy = null; }
  const frozen = Array.isArray(policy && policy.frozenPaths) ? policy.frozenPaths : [];
  check('C4 [guard] pipeline.config.json still declares a frozen list', frozen.length > 0);
  // The four this issue's own criteria name, so the repair cannot quietly unfreeze the paths
  // C3 and C4 are about. Not an equality: later work is licensed to freeze more.
  for (const pinned of ['scripts/test-*.sh', 'tools/run-acceptance.sh', 'scripts/test-ci.sh', 'tests/unit/']) {
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
    // Both sides are listed WITHOUT a pathspec and filtered here by the project's own frozen-path
    // matcher. `git ls-tree` accepts only a limited prefix pathspec, so handing it
    // `scripts/test-*.sh` silently matches nothing and every such script then looks "added";
    // filtering both name lists through one matcher keeps the before/after comparison honest.
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
    // see, and `tests/unit/` is a directory pathspec that a new checker would slide into.
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
