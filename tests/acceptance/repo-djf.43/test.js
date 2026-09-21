// Frozen acceptance test — repo-djf.43: roll back containment roots when ownership
// initialization fails. `guard.js` beside it carries the checks that are already green at the
// fork point (Claude compatibility, the Codex author argv, and the legacy no-fallback
// prepare()/applyEnv containment shape repo-7a0 pinned) and must stay green; between them every
// criterion is covered in both directions.
//
// SCOPE. repo-djf.40 gives `runner/author-containment.js` a per-launch construction handle,
// an ownership marker, a `dir`-then-`fallbackParents` candidate search driven by an injectable
// `selfTest`, and a `dispose(handle, ...)` that only ever removes an exact, marker-verified,
// non-symlinked owned root. djf.40's own rollback coverage (T8a/T8b/T8c) exercises exactly one
// failure shape: a candidate's `selfTest` returning `false`. This suite is scoped to the failure
// shapes djf.40 never drives: a candidate that self-tests fine and then fails while actually
// being turned into a working, owned root — writing its ownership marker, writing its POSIX
// shim, writing its Windows shim, or `selfTest` itself throwing instead of returning a boolean.
// "Ownership initialization" here names exactly that marker+POSIX-shim+Windows-shim sequence for
// one candidate; a candidate that never finishes it must never survive construction, and the
// original construction error must survive above whatever rollback needed to do about it.
//
// CRITERION PAIRING — every check below also names its own criterion in its label.
//
//   C1  Every shim or fallback directory prepare() creates is registered in its host-owned
//       construction handle immediately after creation and before that candidate's marker or
//       shim files are written. This is proved behaviourally: a candidate whose marker write,
//       POSIX-shim write, Windows-shim write, or self-test fails AFTER creation — before it ever
//       carries a matching marker — still cannot survive the call, which is only possible if the
//       handle already knew its exact path the moment it was made.        -> T1, T2, T3, T4
//   C2  A thrown failure writing the marker, the POSIX shim, the Windows shim, or running
//       self-test rolls back every exact root created so far by that launch, is attempted for
//       every owned root regardless of an earlier failure, preserves the primary preparation
//       error, and — when rollback itself also fails — reports a bounded, role-only rollback
//       error that names neither a host path nor any underlying OS or provider text.
//                                                                          -> T1, T2, T3, T4, T5
//   C3  This rollback refuses to follow a symlink/reparse point substituted for an owned root,
//       never enumerates or sweeps a shared parent directory to find what to remove, and cannot
//       reach a sibling launch's root living beside it in that same shared parent — exactly the
//       safety properties dispose() already owes a marker-complete root, now proved for a root
//       whose ownership initialization never completed.                   -> T1, T6, T7
//   C4  Deterministic, key-free tests inject a failure at the shim-root candidate boundary and,
//       separately, at a fallback-candidate boundary, and prove no directory created during that
//       call survives a total construction failure. The full repo-djf.40 contract — launch
//       lifetime, exact disposal, concurrency, bounded cleanup reporting and authorIssue gating —
//       is proved unbroken by re-running that suite's own frozen test.js against this same
//       candidate tree, rather than by a narrower guard.js summary of it; no-key behavior, Claude
//       compatibility and the legacy no-fallback shape are guarded in guard.js, since neither is
//       touched by this change.
//                                                  -> T1, T2, T3, T4, T5 (red); T8; guard.js
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE FROZEN INTERFACE. This suite adds no export and fixes no new name: it exercises the exact
// `runner/author-containment.js` surface repo-djf.40 already fixed —
// `OWNERSHIP_MARKER_NAME`, `prepare(dir, { issueId, fallbackParents, selfTest })` returning
// `{ ok, dir, names, handle }` or `{ ok: false, error, rollbackError, handle: null }` where
// `handle = { issueId, nonce, shimRoot, fallbackRoots }` — and drives it through failure seams
// that already exist in that interface (`selfTest`) or are the plainest possible fault
// injection available to a Node built-ins-only, synchronous, no-provider suite: monkey-patching
// `fs.writeFileSync` to throw for one specific write, restored immediately after each check.
// No generated shim file is ever executed, matching the hardened verifier's restricted tmpfs.
// ─────────────────────────────────────────────────────────────────────────────────────────────
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const CONTAINMENT_FILE = path.join(ROOT, 'runner', 'author-containment.js');

// Deterministic and key-free: this suite never spawns a provider or reads Beads.
for (const name of ['CODEX_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN',
  'PIPELINE_BD_CMD', 'BD_ARGS_LOG', 'BD_STUB_OUT', 'BD_STUB_EXIT']) delete process.env[name];

const ISSUE = 'repo-djf.43';

const tests = [];
function test(name, body) { tests.push({ name, body }); }

const temps = [];
function tmp(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `repo-djf43-${tag}-`));
  temps.push(dir);
  return dir;
}
function cleanupTemps() {
  for (const dir of temps.splice(0)) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
}

function containment() {
  assert(fs.existsSync(CONTAINMENT_FILE), `runner/author-containment.js does not exist: ${CONTAINMENT_FILE}`);
  // eslint-disable-next-line global-require
  return require(CONTAINMENT_FILE);
}

function assertShimPresent(CONTAIN, dir) {
  for (const name of ['bd', 'bd.cmd']) {
    assert(fs.existsSync(path.join(dir, name)), `${dir} is missing ${name}`);
  }
  assert(typeof CONTAIN.OWNERSHIP_MARKER_NAME === 'string' && CONTAIN.OWNERSHIP_MARKER_NAME.length > 0,
    'runner/author-containment.js does not export a non-empty OWNERSHIP_MARKER_NAME');
  const markerPath = path.join(dir, CONTAIN.OWNERSHIP_MARKER_NAME);
  assert(fs.existsSync(markerPath), `${dir} carries no ownership marker`);
  const nonce = fs.readFileSync(markerPath, 'utf8').trim();
  assert(nonce.length > 0, `the ownership marker in ${dir} is empty`);
  return nonce;
}

function assertGone(dir, label) {
  assert.strictEqual(fs.existsSync(dir), false, `${label}: a newly created child was not rolled back: ${dir}`);
}

// Throws a fixture error the very first time `matches(targetPath)` is true for an
// `fs.writeFileSync` call, then behaves normally forever after (one shot per candidate write).
function forceWriteFailureOnce(matches) {
  const real = fs.writeFileSync;
  let fired = false;
  fs.writeFileSync = (targetPath, ...rest) => {
    if (!fired && matches(targetPath)) {
      fired = true;
      throw Object.assign(new Error('repo-djf.43 fixture: EIO, write failed'), { code: 'EIO' });
    }
    return real(targetPath, ...rest);
  };
  return () => { fs.writeFileSync = real; };
}

function assertBoundedAndClean(text, label, hostPaths) {
  assert(typeof text === 'string' && text.length > 0, `${label} is missing or empty: ${JSON.stringify(text)}`);
  assert(text.length <= 300, `${label} is not bounded: ${text.length} chars`);
  assert(!/EIO|repo-djf\.43 fixture/.test(text), `${label} leaked the underlying OS/fixture error text: ${text}`);
  for (const hostPath of hostPaths) {
    assert(!text.includes(hostPath), `${label} names a host path: ${text}`);
  }
}

// ── T1 / C1,C2,C3,C4 ─────────────────────────────────────────────────────────────────────────
test('T1 C1,C2,C3,C4 a thrown ownership-marker write failure at the shim-root candidate boundary is rolled back immediately — with no marker ever present — and construction recovers through the next fallback candidate', () => {
  const CONTAIN = containment();
  const shimParent = tmp('t1-shim-parent');
  const fbParents = [tmp('t1-fb-a')];
  const dir = path.join(shimParent, 'shim');
  let idx = -1;
  const selfTest = () => { idx += 1; return true; };
  const restore = forceWriteFailureOnce((p) => idx === 0 && path.basename(p) === CONTAIN.OWNERSHIP_MARKER_NAME);

  let prepared;
  try { prepared = CONTAIN.prepare(dir, { issueId: ISSUE, fallbackParents: fbParents, selfTest }); }
  finally { restore(); }

  assert.strictEqual(prepared.ok, true, JSON.stringify(prepared));
  assert.strictEqual(prepared.handle.shimRoot, path.resolve(dir), JSON.stringify(prepared.handle));
  assert.strictEqual(prepared.handle.fallbackRoots.length, 1, JSON.stringify(prepared.handle));
  assert(prepared.dir.startsWith(path.resolve(fbParents[0])), `expected recovery under the fallback parent, got ${prepared.dir}`);
  // The shim-root candidate never got a marker (its write threw) — it is gone entirely, not
  // merely "unmarked", proving it was tracked for removal from the moment it was created.
  assertGone(dir, 'T1');
  assertShimPresent(CONTAIN, prepared.dir);
});

// ── T2 / C1,C2,C4 ────────────────────────────────────────────────────────────────────────────
test('T2 C1,C2,C4 a thrown POSIX-shim write failure at a fallback-candidate boundary (marker already written there) is rolled back in full, and construction recovers through the following fallback candidate', () => {
  const CONTAIN = containment();
  const shimParent = tmp('t2-shim-parent');
  const fbParents = [tmp('t2-fb-a'), tmp('t2-fb-b')];
  const dir = path.join(shimParent, 'shim');
  let idx = -1;
  let failingCandidate = null;
  const selfTest = (candidate) => {
    idx += 1;
    if (idx === 1) failingCandidate = candidate;
    return idx !== 0; // the shim root itself is unusable (ordinary noexec-style fallback trigger)
  };
  const restore = forceWriteFailureOnce((p) => idx === 1 && path.basename(p) === 'bd');

  let prepared;
  try { prepared = CONTAIN.prepare(dir, { issueId: ISSUE, fallbackParents: fbParents, selfTest }); }
  finally { restore(); }

  assert.strictEqual(prepared.ok, true, JSON.stringify(prepared));
  assert.strictEqual(prepared.handle.fallbackRoots.length, 2, JSON.stringify(prepared.handle));
  assert(failingCandidate, 'the fallback-candidate boundary under test was never reached');
  assert(prepared.dir.startsWith(path.resolve(fbParents[1])), `expected recovery under the second fallback parent, got ${prepared.dir}`);
  // This candidate's marker write succeeded before its POSIX-shim write threw; it must still be
  // removed in full, marker included — construction-time rollback does not require a completed
  // ownership marker to remove a root it created this call.
  assertGone(failingCandidate, 'T2');
  assertShimPresent(CONTAIN, prepared.dir);
});

// ── T3 / C1,C2,C4 ────────────────────────────────────────────────────────────────────────────
test('T3 C1,C2,C4 a thrown Windows-shim write failure at the shim-root candidate boundary (marker and POSIX shim already written there) is rolled back in full', () => {
  const CONTAIN = containment();
  const shimParent = tmp('t3-shim-parent');
  const fbParents = [tmp('t3-fb-a')];
  const dir = path.join(shimParent, 'shim');
  let idx = -1;
  const selfTest = () => { idx += 1; return true; };
  const restore = forceWriteFailureOnce((p) => idx === 0 && path.basename(p) === 'bd.cmd');

  let prepared;
  try { prepared = CONTAIN.prepare(dir, { issueId: ISSUE, fallbackParents: fbParents, selfTest }); }
  finally { restore(); }

  assert.strictEqual(prepared.ok, true, JSON.stringify(prepared));
  // Two files already landed on disk for this candidate (the marker and the POSIX shim) before
  // the Windows shim threw — proving the rollback removes the whole partially-initialized root,
  // not just the file that happened to fail last.
  assertGone(dir, 'T3');
  assertShimPresent(CONTAIN, prepared.dir);
});

// ── T4 / C1,C2,C4 ────────────────────────────────────────────────────────────────────────────
test('T4 C1,C2,C4 a self-test that throws instead of returning a boolean, at a fallback-candidate boundary, is caught, rolled back, and never escapes prepare()', () => {
  const CONTAIN = containment();
  const shimParent = tmp('t4-shim-parent');
  const fbParents = [tmp('t4-fb-a'), tmp('t4-fb-b')];
  const dir = path.join(shimParent, 'shim');
  let idx = -1;
  let thrownCandidate = null;
  const selfTest = (candidate) => {
    idx += 1;
    if (idx === 0) return false;
    if (idx === 1) { thrownCandidate = candidate; throw new Error('repo-djf.43 fixture: self-test blew up'); }
    return true;
  };

  let prepared;
  let threw = null;
  try { prepared = CONTAIN.prepare(dir, { issueId: ISSUE, fallbackParents: fbParents, selfTest }); }
  catch (error) { threw = error; }

  assert(!threw, `prepare() propagated a thrown self-test error instead of treating it as a failed candidate: ${threw && (threw.stack || threw.message)}`);
  assert.strictEqual(prepared.ok, true, JSON.stringify(prepared));
  assert(thrownCandidate, 'the fallback-candidate boundary under test was never reached');
  assert.strictEqual(prepared.handle.fallbackRoots.length, 2, JSON.stringify(prepared.handle));
  assert(prepared.dir.startsWith(path.resolve(fbParents[1])), `expected recovery under the second fallback parent, got ${prepared.dir}`);
  assertGone(thrownCandidate, 'T4');
  assertShimPresent(CONTAIN, prepared.dir);
});

// ── T5 / C2,C4 ───────────────────────────────────────────────────────────────────────────────
test('T5 C2,C4 mixed marker/POSIX-shim/self-test failures across the shim root and every fallback candidate roll every one of them back, preserve one bounded primary error, and never leak a host path or OS error text', () => {
  const CONTAIN = containment();
  const shimParent = tmp('t5-shim-parent');
  const fbParents = [tmp('t5-fb-a'), tmp('t5-fb-b')];
  const dir = path.join(shimParent, 'shim');
  const attempted = [];
  let idx = -1;
  const selfTest = (candidate) => {
    idx += 1;
    attempted.push(candidate);
    if (idx === 2) throw new Error('repo-djf.43 fixture: self-test blew up');
    return true;
  };
  const real = fs.writeFileSync;
  fs.writeFileSync = (p, ...rest) => {
    if (idx === 0 && path.basename(p) === CONTAIN.OWNERSHIP_MARKER_NAME) {
      throw Object.assign(new Error('repo-djf.43 fixture: EIO, write failed'), { code: 'EIO' });
    }
    if (idx === 1 && path.basename(p) === 'bd') {
      throw Object.assign(new Error('repo-djf.43 fixture: EIO, write failed'), { code: 'EIO' });
    }
    return real(p, ...rest);
  };

  let prepared;
  try { prepared = CONTAIN.prepare(dir, { issueId: ISSUE, fallbackParents: fbParents, selfTest }); }
  finally { fs.writeFileSync = real; }

  assert.strictEqual(prepared.ok, false, JSON.stringify(prepared));
  assert.strictEqual(prepared.handle, null, JSON.stringify(prepared));
  assert.strictEqual(attempted.length, 3, `expected the shim root plus one candidate per fallback parent, got ${attempted.length}`);

  const hostPaths = [shimParent, ...fbParents, ...attempted];
  assertBoundedAndClean(prepared.error, 'the primary preparation error', hostPaths);
  if (prepared.rollbackError !== null) assertBoundedAndClean(prepared.rollbackError, 'the rollback error', hostPaths);

  for (const candidate of attempted) assertGone(candidate, 'T5');
});

// ── T6 / C3 ──────────────────────────────────────────────────────────────────────────────────
test('T6 C3 rollback never follows a symlink/reparse point substituted for an owned root mid-construction, and leaves its target untouched', () => {
  const CONTAIN = containment();

  const probeParent = tmp('t6-probe-parent');
  const probeTarget = tmp('t6-probe-target');
  let canSymlink = true;
  try {
    fs.symlinkSync(path.resolve(probeTarget), path.join(probeParent, 'probe-link'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch { canSymlink = false; }
  if (!canSymlink) { console.log('[test] SKIP T6: host cannot create a directory symlink/junction'); return; }

  const decoy = tmp('t6-decoy');
  fs.writeFileSync(path.join(decoy, 'do-not-touch'), 'precious');
  const shimParent = tmp('t6-shim-parent');
  const dir = path.join(shimParent, 'shim');

  const real = fs.writeFileSync;
  fs.writeFileSync = (p, ...rest) => {
    if (path.basename(p) === CONTAIN.OWNERSHIP_MARKER_NAME) {
      // Simulate a race: something else swaps the just-created root for a reparse point at the
      // exact instant ownership initialization is writing into it.
      fs.rmSync(path.dirname(p), { recursive: true, force: true });
      fs.symlinkSync(path.resolve(decoy), path.dirname(p), process.platform === 'win32' ? 'junction' : 'dir');
      throw Object.assign(new Error('repo-djf.43 fixture: EIO, write failed'), { code: 'EIO' });
    }
    return real(p, ...rest);
  };

  let prepared;
  try { prepared = CONTAIN.prepare(dir, { issueId: ISSUE, fallbackParents: [], selfTest: () => true }); }
  finally { fs.writeFileSync = real; }

  assert.strictEqual(prepared.ok, false, JSON.stringify(prepared));
  assert(fs.existsSync(path.join(decoy, 'do-not-touch')), 'rollback followed a swapped-in reparse point into its target');
  assert(fs.lstatSync(dir).isSymbolicLink(), 'rollback removed the reparse point itself instead of refusing to follow it');
  assert(typeof prepared.rollbackError === 'string' && prepared.rollbackError.length > 0,
    `a root that could not be safely rolled back (symlinked mid-construction) produced no rollbackError: ${JSON.stringify(prepared)}`);
});

// ── T7 / C3 ──────────────────────────────────────────────────────────────────────────────────
test('T7 C3 a construction failure that falls back into a shared parent directory disposes only its own failed candidate there, never enumerates that shared parent, and leaves a sibling launch\'s already-owned root untouched', () => {
  const CONTAIN = containment();
  const sharedFbParent = tmp('t7-shared-fb');

  const dirB = path.join(sharedFbParent, 'shim-b');
  const preparedB = CONTAIN.prepare(dirB, { issueId: ISSUE, fallbackParents: [], selfTest: () => true });
  assert(preparedB.ok, JSON.stringify(preparedB));
  const nonceB = assertShimPresent(CONTAIN, preparedB.dir);

  const shimParentA = tmp('t7-shim-parent-a');
  const dirA = path.join(shimParentA, 'shim');
  let idx = -1;
  const selfTest = () => { idx += 1; return idx !== 0; };
  const restoreWrite = forceWriteFailureOnce((p) => idx === 1 && path.basename(p) === CONTAIN.OWNERSHIP_MARKER_NAME);

  const realReaddir = fs.readdirSync;
  let sharedParentEnumerated = false;
  fs.readdirSync = (...args) => {
    if (path.resolve(String(args[0])) === path.resolve(sharedFbParent)) sharedParentEnumerated = true;
    return realReaddir(...args);
  };

  let prepared;
  try { prepared = CONTAIN.prepare(dirA, { issueId: ISSUE, fallbackParents: [sharedFbParent], selfTest }); }
  finally { restoreWrite(); fs.readdirSync = realReaddir; }

  assert.strictEqual(prepared.ok, false, JSON.stringify(prepared));
  assert.strictEqual(sharedParentEnumerated, false, 'rollback enumerated the shared fallback parent directory instead of removing only its own exact registered path');
  assertShimPresent(CONTAIN, preparedB.dir);
  const nonceAfter = fs.readFileSync(path.join(preparedB.dir, CONTAIN.OWNERSHIP_MARKER_NAME), 'utf8').trim();
  assert.strictEqual(nonceAfter, nonceB, 'the sibling launch\'s ownership marker changed during an unrelated construction failure');
});

// ── T8 / C4 ──────────────────────────────────────────────────────────────────────────────────
test('T8 C4 the existing frozen tests/acceptance/repo-djf.40/test.js (launch lifetime, exact disposal, concurrency, bounded cleanup reporting and authorIssue gating) still passes in full against this same candidate repository tree', () => {
  const DJF40_TEST = path.join(ROOT, 'tests', 'acceptance', 'repo-djf.40', 'test.js');
  assert(fs.existsSync(DJF40_TEST), `sibling suite is missing: ${DJF40_TEST}`);
  const result = spawnSync(process.execPath, [DJF40_TEST], { cwd: ROOT, encoding: 'utf8' });
  assert.strictEqual(result.status, 0,
    `tests/acceptance/repo-djf.40/test.js did not pass (exit ${JSON.stringify(result.status)}) against this candidate tree — `
    + `a valid repo-djf.43 fix must be additive to, not a narrower replacement of, djf.40's contract\n`
    + `--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`);
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
