// Frozen acceptance test — repo-djf.51: bind retained proofs to canonical target repository
// identity. This is the RED half; `guard.js` beside it carries the checks that are already
// green at the fork point (the shared lock canonicalization authority itself, `prove-tests.js`'s
// existing exported surface, its existing ownership-marker forging protections, and the
// mandatory regression profile) and must stay green.
//
// SCOPE. `scripts/prove-tests.js`'s `resumeProbe()` today binds a parked, unfinished proof to
// the author worktree path (`marker.sourceWorktree`) and to the issue id, but never to the
// repository `prepareProbe()` actually cloned from (`built.cfg.targetRepoPath`, the same
// argument `runner/lock.js:acquire()` takes as its target). A config edited, swapped, or
// resolved differently between the preparation attempt that created the retained probe and the
// later attempt that resumes it can point that argument at an entirely different repository, or
// at a directory whose junction/symlink now resolves somewhere else, while `built.folder.dir`
// and the issue id stay byte-for-byte the same — and resume proceeds anyway. This suite is
// scoped to exactly that gap.
//
// CRITERION PAIRING — every check below also names its own criterion in its label.
//
//   C1  Probe preparation records the canonical target repository identity produced by the
//       shared lock canonicalization authority (`runner/lock.js:canonicalTarget`).  -> T1
//   C2  Resume accepts the same repository reached through an equivalent path alias but refuses
//       a different repository, a retargeted junction or symlink at the same literal path, and
//       missing or malformed canonical identity.        -> T2, T3, T4, T5(win32/case), T6
//   C3  Identity refusal occurs before agent launch, gate, marker mutation, or cleanup and
//       leaves the retained container byte-identical.    -> T3, T4, T6 (container untouched);
//                                                            T7 (ordering, at the proveTests()
//                                                            level, with launch/gate/marker-write
//                                                            spied and never invoked)
//   C4  Deterministic cross-platform tests cover real path, same-repository alias, different
//       repository, retargeted alias where supported, case and normalization behavior, and
//       symlink or junction refusal without following or deleting decoys.
//         real path                             -> T1
//         same-repository alias                 -> T2
//         different repository                  -> T3
//         retargeted alias where supported       -> T4 (skips where the host cannot symlink)
//         case and normalization                -> T5 (skips off a case-insensitive host)
//         symlink/junction refusal, no decoy follow/delete -> T4
//   C5  Existing target-lock, probe ownership, and freeze regressions remain green.  -> T8
//       (guard.js carries the static half of C5; T8 proves it by actually re-running the two
//       sibling suites this change is closest to: repo-os9, the target-lock acceptance suite,
//       and repo-djf.14, the managed-probe-ownership/freeze acceptance suite.)
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE FROZEN INTERFACE. This suite fixes one new marker field on the exact
// `scripts/prove-tests.js` surface repo-djf.14 already exercises directly (`prepareProbe(built,
// model, run, tempRoot)` and `resumeProbe(built, probePath, run)`), using the identity primitive
// `runner/lock.js` already exports and freezes for this purpose (`canonicalTarget`):
//
//   * `prepareProbe()` writes `targetIdentity` into `.pipeline-green-probe.json`, equal to
//     `lock.canonicalTarget(built.cfg.targetRepoPath)` computed at preparation time.
//   * `resumeProbe()` recomputes `lock.canonicalTarget(built.cfg.targetRepoPath)` from the
//     `built` it is given and refuses — `{ ok: false, error: <bounded text> }`, before touching
//     the container, launching anything, or running the gate — unless that recomputed identity
//     is a non-empty string equal to the marker's recorded `targetIdentity`.
//
// NO NEW SUCCESS-RESULT FIELD. Acceptance is observed exactly as it is observed today: through
// `ok === true` on `resumeProbe()`'s existing ok-result. An accepted alias or case spelling is
// pinned here by the two identities this suite has already proven at that point — the marker's
// recorded `targetIdentity` and `lock.canonicalTarget()` of the spelling being resumed — rather
// than by a value echoed back out of the refusal check. An implementation is free to return
// precisely what `resumeProbe()` returns today on success.
// ─────────────────────────────────────────────────────────────────────────────────────────────
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const PROVE_FILE = path.join(ROOT, 'scripts', 'prove-tests.js');
const LOCK_FILE = path.join(ROOT, 'runner', 'lock.js');

for (const name of ['CODEX_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN',
  'PIPELINE_BD_CMD', 'BD_ARGS_LOG', 'BD_STUB_OUT', 'BD_STUB_EXIT']) delete process.env[name];

const ISSUE = 'repo-djf.51';

const tests = [];
function test(name, body) { tests.push({ name, body }); }

const temps = [];
function tmp(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `repo-djf51-${tag}-`));
  temps.push(dir);
  return dir;
}
function cleanupTemps() {
  for (const dir of temps.splice(0)) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
}

function PROVE() {
  assert(fs.existsSync(PROVE_FILE), `scripts/prove-tests.js does not exist: ${PROVE_FILE}`);
  // eslint-disable-next-line global-require
  return require(PROVE_FILE);
}
function LOCK() {
  assert(fs.existsSync(LOCK_FILE), `runner/lock.js does not exist: ${LOCK_FILE}`);
  // eslint-disable-next-line global-require
  return require(LOCK_FILE);
}

function run(cmd, args, o = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', timeout: 60000, maxBuffer: 32 * 1024 * 1024, windowsHide: true, ...o });
}
function git(dir, ...args) { return run('git', ['-c', 'safe.directory=*', ...args], { cwd: dir }); }
function head(dir) { return String(git(dir, 'rev-parse', 'HEAD').stdout || '').trim(); }
function write(dir, rel, bytes) {
  const f = path.join(dir, ...rel.split('/'));
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, bytes);
}
function commit(dir, msg) { git(dir, 'add', '-A'); git(dir, 'commit', '-qm', msg); return head(dir); }

// A minimal integration checkout + author worktree sharing one bare origin, exactly the shape
// `prepareProbe()` expects: it clones `cfg.targetRepoPath` at the author's HEAD and copies the
// (possibly still-uncommitted) authored suite from `folder.dir` into both clones.
function fixture(root, id) {
  const bare = path.join(root, 'remote.git');
  const target = path.join(root, 'target');
  const author = path.join(root, 'author');
  fs.mkdirSync(root, { recursive: true });
  git(root, 'init', '-q', '--bare', '-b', 'main', bare);
  git(root, 'clone', '-q', bare, target);
  git(target, 'config', 'user.email', 'fixture@example.invalid');
  git(target, 'config', 'user.name', 'fixture');
  write(target, 'pipeline.config.json', JSON.stringify({ frozenPaths: [] }));
  write(target, 'tests/acceptance/_control/test.js', "'use strict';\n");
  commit(target, 'integration');
  git(target, 'push', '-q', 'origin', 'main');
  git(root, 'clone', '-q', bare, author);
  git(author, 'config', 'user.email', 'fixture@example.invalid');
  git(author, 'config', 'user.name', 'fixture');
  write(author, `tests/acceptance/${id}/test.js`, "'use strict';\n// authored\n");
  return { root, bare, target, author };
}

// A wholly unrelated repository: its own history, sharing nothing with `fixture()`'s bare
// origin. Stands in for "a different repository" reached via the same config field.
function differentRepo(root) {
  fs.mkdirSync(root, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'fixture@example.invalid');
  git(root, 'config', 'user.name', 'fixture');
  write(root, 'pipeline.config.json', JSON.stringify({ frozenPaths: [] }));
  write(root, 'do-not-touch', 'a genuinely different repository\n');
  commit(root, 'unrelated history');
  return root;
}

function built(f, id, targetRepoPath = f.target) {
  return { id, suiteId: id, folder: { dir: f.author },
    cfg: { targetRepoPath, gitTimeoutMs: 30000 }, policy: { frozenPaths: [] } };
}

function markerPath(container, MARKER) { return path.join(container, MARKER); }
function readMarker(container, MARKER) { return JSON.parse(fs.readFileSync(markerPath(container, MARKER), 'utf8')); }
function writeMarker(container, MARKER, value) {
  fs.writeFileSync(markerPath(container, MARKER), `${JSON.stringify(value, null, 2)}\n`);
}

// A recursive content fingerprint of a directory tree: proves "byte-identical" rather than
// merely "still exists".
function snapshotTree(dir) {
  const items = [];
  (function walk(rel) {
    const abs = path.join(dir, rel);
    const stat = fs.lstatSync(abs);
    if (stat.isSymbolicLink()) { items.push(`${rel}\0symlink\0${fs.readlinkSync(abs)}`); return; }
    if (stat.isDirectory()) { for (const child of fs.readdirSync(abs).sort()) walk(path.join(rel, child)); return; }
    items.push(`${rel}\0file\0${crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex')}`);
  }('.'));
  return items.sort().join('\n');
}

function trySymlinkDir(realDir, linkPath) {
  try { fs.symlinkSync(path.resolve(realDir), linkPath, process.platform === 'win32' ? 'junction' : 'dir'); return true; }
  catch { return false; }
}

// ── T1 / C1,C4(real path) ───────────────────────────────────────────────────────────────────
test('T1 C1,C4(real path) prepareProbe records the canonical target repository identity produced by lock.canonicalTarget, and resume of the identical real path succeeds', () => {
  const prove = PROVE();
  const lock = LOCK();
  const f = fixture(tmp('t1'), ISSUE);
  const b = built(f, ISSUE);
  const prepared = prove.prepareProbe(b, 'fixture-model');
  assert(prepared.ok, JSON.stringify(prepared));
  const marker = readMarker(prepared.container, prove.MARKER);
  const expected = lock.canonicalTarget(f.target);
  assert.strictEqual(typeof marker.targetIdentity === 'string' && marker.targetIdentity.length > 0,
    true, `prepareProbe did not record a non-empty canonical targetIdentity: ${JSON.stringify(marker)}`);
  assert.strictEqual(marker.targetIdentity, expected,
    `recorded identity ${JSON.stringify(marker.targetIdentity)} does not match lock.canonicalTarget(targetRepoPath) = ${JSON.stringify(expected)}`);

  // Acceptance is `ok === true` and nothing more: the recorded identity asserted just above is
  // what makes this resume a proof that the real path is accepted under the recorded identity.
  const resumed = prove.resumeProbe(b, prepared.probe);
  assert.strictEqual(resumed.ok, true, JSON.stringify(resumed));
});

// ── T2 / C2,C4(same-repository alias) ───────────────────────────────────────────────────────
test('T2 C2,C4(same-repository alias) resume through an equivalent (non-real, redundant-segment) spelling of the same real target repository succeeds', () => {
  const prove = PROVE();
  const lock = LOCK();
  const f = fixture(tmp('t2'), ISSUE);
  const b = built(f, ISSUE);
  const prepared = prove.prepareProbe(b, 'fixture-model');
  assert(prepared.ok, JSON.stringify(prepared));

  // The two identities this acceptance is read against: the one preparation recorded, and the
  // one the differently-spelled path canonicalizes to. Acceptance below is `ok === true`.
  const expected = lock.canonicalTarget(f.target);
  const marker = readMarker(prepared.container, prove.MARKER);
  assert.strictEqual(marker.targetIdentity, expected,
    `prepareProbe did not record the canonical identity this alias resume is accepted against: ${JSON.stringify(marker)}`);

  const alias = f.target + path.sep + 'redundant' + path.sep + '..';
  assert.strictEqual(lock.canonicalTarget(alias), expected,
    'test fixture bug: the alias path is not actually equivalent under the shared canonicalization authority');
  assert.notStrictEqual(alias, f.target, 'test fixture bug: the alias is not spelled differently from the real path');

  const resumed = prove.resumeProbe(built(f, ISSUE, alias), prepared.probe);
  assert.strictEqual(resumed.ok, true, JSON.stringify(resumed));
});

// ── T3 / C2,C3,C4(different repository) ─────────────────────────────────────────────────────
test('T3 C2,C3,C4(different repository) resume refuses a genuinely different repository at the same config field, before touching the retained container', () => {
  const prove = PROVE();
  const dir = tmp('t3');
  const f = fixture(path.join(dir, 'fixture'), ISSUE);
  const other = differentRepo(path.join(dir, 'other'));
  const b = built(f, ISSUE);
  const prepared = prove.prepareProbe(b, 'fixture-model');
  assert(prepared.ok, JSON.stringify(prepared));
  const before = snapshotTree(prepared.container);

  const resumed = prove.resumeProbe(built(f, ISSUE, other), prepared.probe);
  assert.strictEqual(resumed.ok, false, JSON.stringify(resumed));
  assert(typeof resumed.error === 'string' && resumed.error.length > 0, `resumeProbe refused with no error text: ${JSON.stringify(resumed)}`);

  assert.strictEqual(snapshotTree(prepared.container), before,
    'the retained container changed while resume was refusing a different repository');
  assert(fs.existsSync(path.join(other, 'do-not-touch')), 'the unrelated different repository was disturbed');
});

// ── T4 / C2,C3,C4(retargeted alias / symlink refusal) ───────────────────────────────────────
test('T4 C2,C3,C4(retargeted junction/symlink) resume refuses a junction/symlink retargeted to a different repository at the same literal path, without following or deleting the swapped-in decoy', () => {
  const prove = PROVE();
  const dir = tmp('t4');
  const f = fixture(path.join(dir, 'fixture'), ISSUE);
  const other = differentRepo(path.join(dir, 'other'));
  const linkPath = path.join(dir, 'target-link');

  if (!trySymlinkDir(f.target, linkPath)) {
    console.log('[test] SKIP T4: host cannot create a directory symlink/junction');
    return;
  }
  const b = built(f, ISSUE, linkPath);
  const prepared = prove.prepareProbe(b, 'fixture-model');
  assert(prepared.ok, JSON.stringify(prepared));
  const before = snapshotTree(prepared.container);

  fs.rmSync(linkPath, { force: true });
  assert(trySymlinkDir(other, linkPath), 'test fixture bug: could not retarget the symlink/junction the first creation just proved possible');

  const resumed = prove.resumeProbe(built(f, ISSUE, linkPath), prepared.probe);
  assert.strictEqual(resumed.ok, false, JSON.stringify(resumed));
  assert(typeof resumed.error === 'string' && resumed.error.length > 0, `resumeProbe refused with no error text: ${JSON.stringify(resumed)}`);

  assert.strictEqual(snapshotTree(prepared.container), before,
    'the retained container changed while resume was refusing a retargeted junction/symlink');
  assert(fs.existsSync(path.join(other, 'do-not-touch')),
    'rollback followed the retargeted junction/symlink into the swapped-in decoy repository');
  assert(fs.lstatSync(linkPath).isSymbolicLink(), 'refusal removed or replaced the retargeted junction/symlink itself');
});

// ── T5 / C2,C4(case and normalization) ──────────────────────────────────────────────────────
test('T5 C2,C4(case and normalization) resume through a differently-cased, differently-slashed spelling of the same real target repository succeeds on a case-insensitive host filesystem', () => {
  if (process.platform !== 'win32') {
    console.log('[test] SKIP T5: host is not the case-insensitive, backslash-native platform this check exercises');
    return;
  }
  const prove = PROVE();
  const lock = LOCK();
  const f = fixture(tmp('t5'), ISSUE);
  const b = built(f, ISSUE);
  const prepared = prove.prepareProbe(b, 'fixture-model');
  assert(prepared.ok, JSON.stringify(prepared));

  // As in T2: the recorded identity and the canonicalized spelling are what this acceptance is
  // read against, and acceptance itself is `ok === true`.
  const expected = lock.canonicalTarget(f.target);
  const marker = readMarker(prepared.container, prove.MARKER);
  assert.strictEqual(marker.targetIdentity, expected,
    `prepareProbe did not record the canonical identity this case/slash-flipped resume is accepted against: ${JSON.stringify(marker)}`);

  const flipped = f.target.split(path.sep)
    .map((seg, i) => (i === 0 ? seg : seg.split('').map((ch) => (ch === ch.toUpperCase() ? ch.toLowerCase() : ch.toUpperCase())).join('')))
    .join('/');
  assert.strictEqual(lock.canonicalTarget(flipped), expected,
    'test fixture bug: the case/slash-flipped alias is not actually equivalent under the shared canonicalization authority');

  const resumed = prove.resumeProbe(built(f, ISSUE, flipped), prepared.probe);
  assert.strictEqual(resumed.ok, true, JSON.stringify(resumed));
});

// ── T6 / C2,C3(missing or malformed canonical identity) ─────────────────────────────────────
test('T6 C2,C3(missing/malformed canonical identity) resume refuses a retained marker whose canonical identity is missing or malformed, before touching the retained container', () => {
  const prove = PROVE();
  const dir = tmp('t6');

  const fMissing = fixture(path.join(dir, 'missing'), ISSUE);
  const bMissing = built(fMissing, ISSUE);
  const preparedMissing = prove.prepareProbe(bMissing, 'fixture-model');
  assert(preparedMissing.ok, JSON.stringify(preparedMissing));
  const markerMissing = readMarker(preparedMissing.container, prove.MARKER);
  delete markerMissing.targetIdentity;
  writeMarker(preparedMissing.container, prove.MARKER, markerMissing);
  const beforeMissing = snapshotTree(preparedMissing.container);
  const resumedMissing = prove.resumeProbe(bMissing, preparedMissing.probe);
  assert.strictEqual(resumedMissing.ok, false, JSON.stringify(resumedMissing));
  assert(typeof resumedMissing.error === 'string' && resumedMissing.error.length > 0,
    `resumeProbe refused a missing canonical identity with no error text: ${JSON.stringify(resumedMissing)}`);
  assert.strictEqual(snapshotTree(preparedMissing.container), beforeMissing,
    'the retained container changed while resume was refusing a missing canonical identity');

  const fMalformed = fixture(path.join(dir, 'malformed'), ISSUE);
  const bMalformed = built(fMalformed, ISSUE);
  const preparedMalformed = prove.prepareProbe(bMalformed, 'fixture-model');
  assert(preparedMalformed.ok, JSON.stringify(preparedMalformed));
  const markerMalformed = readMarker(preparedMalformed.container, prove.MARKER);
  markerMalformed.targetIdentity = 42;
  writeMarker(preparedMalformed.container, prove.MARKER, markerMalformed);
  const beforeMalformed = snapshotTree(preparedMalformed.container);
  const resumedMalformed = prove.resumeProbe(bMalformed, preparedMalformed.probe);
  assert.strictEqual(resumedMalformed.ok, false, JSON.stringify(resumedMalformed));
  assert(typeof resumedMalformed.error === 'string' && resumedMalformed.error.length > 0,
    `resumeProbe refused a malformed canonical identity with no error text: ${JSON.stringify(resumedMalformed)}`);
  assert.strictEqual(snapshotTree(preparedMalformed.container), beforeMalformed,
    'the retained container changed while resume was refusing a malformed canonical identity');
});

// ── T7 / C3 ──────────────────────────────────────────────────────────────────────────────────
test('T7 C3 identity refusal at the proveTests() level happens before any agent launch, gate run, or marker mutation, and leaves the retained container byte-identical', () => {
  const prove = PROVE();
  const dir = tmp('t7');
  const f = fixture(path.join(dir, 'fixture'), ISSUE);
  const other = differentRepo(path.join(dir, 'other'));
  const b = built(f, ISSUE);
  const prepared = prove.prepareProbe(b, 'fixture-model');
  assert(prepared.ok, JSON.stringify(prepared));
  const before = snapshotTree(prepared.container);

  let launchCalled = false; let gateCalled = false; let markProvenCalled = false;
  const stages = [];
  const seams = {
    retainedProbe: prepared.probe,
    onStage: (event) => stages.push(event.stage),
    launchProbe: () => { launchCalled = true; return { status: 0, stdout: '', stderr: '' }; },
    runGate: () => { gateCalled = true; return { status: 0, stdout: '', stderr: '' }; },
    markProven: () => { markProvenCalled = true; },
  };
  const resumedBuilt = built(f, ISSUE, other);
  const result = prove.proveTests(resumedBuilt, 'fixture-model', seams);

  assert.strictEqual(result.ok, false, JSON.stringify(result));
  assert.strictEqual(result.kind, 'setup', JSON.stringify(result));
  assert.strictEqual(launchCalled, false, 'proveTests launched the probe agent despite a refused identity');
  assert.strictEqual(gateCalled, false, 'proveTests ran the freeze gate despite a refused identity');
  assert.strictEqual(markProvenCalled, false, 'proveTests wrote a proven marker despite a refused identity');
  assert(!stages.includes('probe-agent') && !stages.includes('gate') && !stages.includes('marker-write'),
    `proveTests progressed past prepare despite a refused identity: ${stages.join(', ')}`);
  assert.strictEqual(snapshotTree(prepared.container), before,
    'the retained container changed while proveTests was refusing a different repository at resume');
});

// ── T8 / C5 ──────────────────────────────────────────────────────────────────────────────────
test('T8 C5 the existing frozen tests/acceptance/repo-os9/test.js (target-lock) and tests/acceptance/repo-djf.14/test.js (probe ownership and freeze) still pass in full once canonical target identity binding is built', () => {
  for (const sibling of ['repo-os9', 'repo-djf.14']) {
    const SIBLING_TEST = path.join(ROOT, 'tests', 'acceptance', sibling, 'test.js');
    assert(fs.existsSync(SIBLING_TEST), `sibling suite is missing: ${SIBLING_TEST}`);
    const result = spawnSync(process.execPath, [SIBLING_TEST],
      { cwd: ROOT, encoding: 'utf8', timeout: 300000, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
    assert.strictEqual(result.status, 0,
      `tests/acceptance/${sibling}/test.js did not pass (exit ${JSON.stringify(result.status)}) — `
      + `a valid repo-djf.51 fix must be additive to, not a narrower replacement of, that suite's contract\n`
      + `--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`);
  }
});

(async () => {
  let failed = 0;
  for (const item of tests) {
    try { await item.body(); console.log(`[test] PASS ${item.name}`); }
    catch (error) { failed += 1; console.error(`[test] FAIL ${item.name}: ${error.stack || error.message}`); }
  }
  cleanupTemps();
  if (failed) { console.error(`[test] FAIL ${failed}/${tests.length} focused checks`); process.exitCode = 1; }
  else console.log(`[test] PASS ${tests.length}/${tests.length} focused checks`);
})().catch((error) => {
  cleanupTemps();
  console.error(`[test] FAIL harness: ${error.stack || error.message}`);
  process.exitCode = 1;
});
