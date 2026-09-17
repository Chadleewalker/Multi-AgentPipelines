// Frozen acceptance guard — repo-djf.48: retire superseded frozen acceptance contracts
// explicitly. [guard]
//
// Criteria -> tests, the STAY-GREEN half. Everything in this file is GREEN at the fork point
// (repo-djf.48 has not landed; the supersession contract, its resolver and the consumer wiring
// all sit on top of the interfaces pinned below) and must stay green afterwards.
//
//   G1 / C3  `scripts/test-all.sh` and `scripts/test-ci.sh` stay exactly as the candidate
//            committed them. This is not decoration: `scripts/test-*.sh` is a frozen pathspec in
//            `pipeline.config.json` and `tests/acceptance/repo-djf.2/` already pins both files, so
//            the `test-all` consumer named in C3 can only be reached through the coordinator that
//            owns its invocation. See test.js T5 and the SPEC DEFECT note there.
//   G2 / C4  `tests/acceptance/repo-7a0/` and `tests/acceptance/repo-djf.40/` exist, still hold
//            the guard.js and test.js a frozen suite cannot lose, match their committed history
//            byte for byte, and every .js they carry is directly loadable by node —
//            "repo-7a0 history remains immutable and directly runnable" in its stay-green half.
//   G3 / C5  the mandatory, Docker-free regression profile stays required and runnable.
//   G4 / C3  the four consumer entry points C3 names still exist where the resolver has to
//            reach them, and the two that carry the acceptance roster today still do so:
//            verify-pr.sh still re-runs the sibling acceptance suites through the frozen runner,
//            and freeze.js keeps its publication surface exported.
//
// test.js carries the RED half of C3, C4 and C5 (and all of C1 and C2).
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');

for (const name of ['CODEX_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN',
  'PIPELINE_BD_CMD', 'BD_ARGS_LOG', 'BD_STUB_OUT', 'BD_STUB_EXIT']) delete process.env[name];

let failed = 0;
function check(name, body) {
  try { body(); console.log(`ok - ${name}`); }
  catch (error) { failed = 1; console.error(`FAIL - ${name} — ${error.stack || error.message}`); }
}

// Bytes back rather than a decoded string: committed blobs are compared as buffers, so the read
// must not go through a text decoder, and NUL-separated `ls-tree` output must stay separable.
function git(...args) {
  return spawnSync('git', ['-c', 'safe.directory=*', '-C', ROOT, ...args],
    { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, windowsHide: true, timeout: 60000 });
}

// The file population HEAD records for a pathspec, as Git-style relative paths. `-z` is what
// makes this exact: NUL-terminated names are never quoted or escaped, so a path is whatever
// sits between two separators.
function trackedFilesAt(pathspec) {
  const listed = git('ls-tree', '-r', '-z', '--name-only', 'HEAD', '--', pathspec);
  assert.strictEqual(listed.status, 0,
    `git could not read HEAD for ${pathspec}: ${String(listed.stderr || '')}`);
  return String(listed.stdout || '').split('\0').filter((name) => name.length > 0);
}

// The same population as it exists on disk, in the same Git-style relative spelling, so the two
// can be compared directly. A pathspec naming one file answers with that one path (or nothing,
// when it is gone); a directory is walked whole, which is what makes an untracked addition
// visible without a roster typed into this file.
function workingFilesAt(pathspec) {
  const rel = pathspec.replace(/\/+$/, '');
  const abs = path.join(ROOT, ...rel.split('/'));
  let stat;
  try { stat = fs.statSync(abs); } catch { return []; }
  if (!stat.isDirectory()) return [rel];
  const found = [];
  const walk = (dirAbs, dirRel) => {
    for (const entry of fs.readdirSync(dirAbs, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (entry.name === '.git') continue;
      const childAbs = path.join(dirAbs, entry.name);
      const childRel = `${dirRel}/${entry.name}`;
      if (entry.isDirectory()) walk(childAbs, childRel);
      else found.push(childRel);
    }
  };
  walk(abs, rel);
  return found;
}

// Source, shell and config text is stored in the index with LF and may be checked out with CRLF;
// that transformation is the checkout doing its job, not somebody editing a frozen file. Content
// that is not line-oriented gets no such licence and is compared byte for byte.
const TEXTUAL_SUFFIXES = ['.js', '.cjs', '.mjs', '.sh', '.json', '.md', '.txt', '.yml', '.yaml'];
function isTextual(rel, committed, working) {
  if (TEXTUAL_SUFFIXES.some((suffix) => rel.toLowerCase().endsWith(suffix))) return true;
  return !committed.includes(0) && !working.includes(0);
}

function sameContent(rel, committed, working) {
  if (committed.equals(working)) return true;
  if (!isTextual(rel, committed, working)) return false;
  const normalize = (buf) => buf.toString('latin1').replace(/\r\n/g, '\n');
  return normalize(committed) === normalize(working);
}

function summarize(names) {
  const shown = names.slice(0, 5).join(', ');
  return names.length > 5 ? `${shown} (and ${names.length - 5} more)` : shown;
}

// "Unchanged" asked of Git rather than of a digest typed into this file, and answered without
// `git diff`: the path is tracked at the candidate's HEAD, and every file HEAD records under it
// still holds the bytes of its committed blob. The populations are compared first, so a deleted
// file and an untracked addition are both caught; then each committed blob is read back with
// `git cat-file` and compared against the working bytes — after folding CRLF to LF for textual
// content, because a checkout that normalizes EOLs has not edited anything. `git diff` is what
// this deliberately avoids: against a Windows clone mounted into a container its index/worktree
// EOL filters report frozen JS files as changed when their content is identical, and it never
// looks at untracked files at all. A literal hash would only be correct for one checkout of one
// commit; a blob comparison is correct for every checkout of the commit under test.
function assertTrackedAndUnmodified(pathspec, label) {
  const tracked = trackedFilesAt(pathspec);
  assert(tracked.length > 0, `${label} is not tracked at the candidate's HEAD: ${pathspec}`);

  const working = workingFilesAt(pathspec);
  const trackedSet = new Set(tracked);
  const workingSet = new Set(working);
  const removed = tracked.filter((rel) => !workingSet.has(rel));
  const added = working.filter((rel) => !trackedSet.has(rel));
  assert.strictEqual(removed.length, 0,
    `${label} lost files the candidate committed — a frozen path was edited: ${summarize(removed)}`);
  assert.strictEqual(added.length, 0,
    `${label} gained files the candidate never committed — a frozen path was edited: ${summarize(added)}`);

  const drifted = [];
  for (const rel of tracked) {
    const blob = git('cat-file', 'blob', `HEAD:${rel}`);
    assert.strictEqual(blob.status, 0,
      `git could not read the committed blob for ${rel}: ${String(blob.stderr || '')}`);
    if (!sameContent(rel, blob.stdout, fs.readFileSync(path.join(ROOT, ...rel.split('/'))))) {
      drifted.push(rel);
    }
  }
  assert.strictEqual(drifted.length, 0,
    `${label} differs from the bytes the candidate committed — a frozen path was edited: ${summarize(drifted)}`);
}

// G1 / C3 — the two canonical profile scripts stay exactly as the candidate committed them.
// `tests/acceptance/repo-djf.2/` already pins both, so this guard is the reason C3's `test-all`
// obligation has to be carried by the coordinator rather than by editing the sweep.
check('G1 C3 [guard] scripts/test-all.sh and scripts/test-ci.sh are unedited frozen paths', () => {
  for (const rel of ['scripts/test-ci.sh', 'scripts/test-all.sh']) {
    assert(fs.existsSync(path.join(ROOT, ...rel.split('/'))), `${rel} is missing`);
    assertTrackedAndUnmodified(rel, rel);
  }
  // The canonical frozenPaths contract is the other half: the glob that makes these two
  // unreachable for any implementation, and forbids a new `scripts/test-<anything>.sh` sibling.
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'pipeline.config.json'), 'utf8'));
  assert(Array.isArray(config.frozenPaths) && config.frozenPaths.includes('scripts/test-*.sh'),
    `pipeline.config.json no longer freezes scripts/test-*.sh: ${JSON.stringify(config.frozenPaths)}`);
});

// G2 / C4 — the suite this issue retires, and the suite that retires it, are both present and
// unmodified with respect to committed history, and both still load directly under node. A
// supersession contract that "retires" a suite by editing or deleting it is the failure this
// guard exists to make impossible.
check('G2 C4 [guard] repo-7a0 and repo-djf.40 keep their required files, match committed history, and stay directly loadable', () => {
  for (const id of ['repo-7a0', 'repo-djf.40']) {
    const dir = path.join(ROOT, 'tests', 'acceptance', id);
    assert(fs.existsSync(dir), `tests/acceptance/${id}/ is missing`);
    const files = fs.readdirSync(dir).filter((name) => name.endsWith('.js')).sort();
    // The files a frozen suite may never lose — required, not exhaustive. A later suite may
    // legitimately grow a helper beside guard.js and test.js; losing either of them is the
    // failure this guard exists to catch, so require membership rather than an exact roster.
    for (const required of ['guard.js', 'test.js']) {
      assert(files.includes(required),
        `tests/acceptance/${id}/ no longer holds ${required}: ${files.join(', ') || '(no .js files)'}`);
      assertTrackedAndUnmodified(`tests/acceptance/${id}/${required}`, `tests/acceptance/${id}/${required}`);
    }
    // And nothing anywhere under the suite may have drifted from what the candidate committed —
    // added helpers included. A supersession contract that "retires" a suite by editing or
    // deleting it is exactly what this makes impossible.
    assertTrackedAndUnmodified(`tests/acceptance/${id}/`, `tests/acceptance/${id}/`);
    for (const name of files) {
      const parsed = spawnSync(process.execPath, ['--check', path.join(dir, name)],
        { encoding: 'utf8', windowsHide: true, timeout: 60000 });
      assert.strictEqual(parsed.status, 0,
        `tests/acceptance/${id}/${name} is no longer directly loadable by node: ${parsed.stderr}`);
    }
  }
});

// G3 / C5 — the mandatory regression layer stays required and names a command that exists. It is
// what keeps enforcing everything this change touches once it lands.
check('G3 C5 [guard] the mandatory regression profile remains required and names an existing command', () => {
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'pipeline.config.json'), 'utf8'));
  assert.strictEqual(config.regressionPolicy, 'required', JSON.stringify(config.regressionPolicy));
  assert.strictEqual(config.regressionCommand, 'bash scripts/test-ci.sh', JSON.stringify(config.regressionCommand));
  assert(fs.existsSync(path.join(ROOT, 'scripts', 'test-ci.sh')), 'scripts/test-ci.sh is missing');
  assert.strictEqual(config.verifyCommand, 'sh tools/run-acceptance.sh', JSON.stringify(config.verifyCommand));
});

// G4 / C3 — the four consumer entry points C3 names exist where a shared resolver has to reach
// them, and the existing acceptance-roster behaviour they carry today is still there: verify-pr.sh
// enumerates the sibling acceptance directories, and freeze.js keeps exporting the publication
// surface that puts an exact HEAD on the integration branch.
check('G4 C3 [guard] the four consumer entry points exist and keep the roster behaviour a shared resolver must take over', () => {
  for (const rel of ['scripts/fast-full-sweep.js', 'scripts/test-all.sh', 'scripts/verify-pr.sh', 'scripts/freeze.js']) {
    assert(fs.existsSync(path.join(ROOT, ...rel.split('/'))), `${rel} is missing`);
  }
  const verifyPr = fs.readFileSync(path.join(ROOT, 'scripts', 'verify-pr.sh'), 'utf8');
  // The behaviour, not the loop that spells it today: hosted validation still re-runs sibling
  // acceptance suites through the frozen runner. C3 moves WHICH suites those are into the shared
  // resolver (test.js T15), so pinning the literal `for d in tests/acceptance/*/` here would
  // freeze the very line a correct implementation has to re-source.
  assert(/tools\/run-acceptance\.sh/.test(verifyPr),
    'scripts/verify-pr.sh no longer re-runs acceptance suites through the frozen runner');
  assert(/tests\/acceptance/.test(verifyPr),
    'scripts/verify-pr.sh no longer looks at the sibling acceptance suites at all');
  // eslint-disable-next-line global-require
  const freeze = require(path.join(ROOT, 'scripts', 'freeze.js'));
  for (const name of ['main', 'parseArgs', 'currentHead', 'validateTreeSnapshot',
    'prepareFreezeSnapshot', 'makeFreezeCommit', 'pushFreezeCommit']) {
    assert.strictEqual(typeof freeze[name], 'function', `scripts/freeze.js no longer exports ${name}()`);
  }
});

process.exitCode = failed;
