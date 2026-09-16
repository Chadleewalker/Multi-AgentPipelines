// Frozen acceptance test — repo-djf.44: refuse fallback success after containment rollback
// failure. `guard.js` beside it carries the checks that are already green at the fork point
// (Claude compatibility, the Codex author argv, the legacy no-fallback prepare()/applyEnv()
// shape, and the mandatory regression profile's own configuration) and must stay green; between
// them every criterion is covered in both directions.
//
// SCOPE. repo-djf.40 gives `runner/author-containment.js` a construction handle, an ownership
// marker, a `dir`-then-`fallbackParents` candidate search, and immediate rollback of a candidate
// whose ownership initialization fails partway through. repo-djf.43 proves that immediate
// rollback recovers cleanly through the next fallback candidate. Both suites only ever exercise
// a rollback that SUCCEEDS. Neither ever asks what happens when the rollback of the failed
// candidate itself cannot be trusted to have happened — because the very thing that would prove
// it owns that root (its ownership marker) is gone, wrong, or the root has been swapped for a
// symlink/reparse point out from under it. This suite is scoped to exactly that gap: rollback
// itself refusing or erroring must fail the whole preparation, even when a later, perfectly
// usable fallback candidate is sitting right there. Treating a later fallback as a recovery in
// this situation would let a launch proceed while a directory it cannot account for is left
// behind under its authority — indistinguishable, from the outside, between "safely cleaned up"
// and "someone else's data now sits where our shim used to be."
//
// CRITERION PAIRING — every check below also names its own criterion in its label.
//
//   C1  If rollback of any failed containment candidate refuses or errors, preparation cannot
//       return ok or launch the provider even when a later fallback candidate is usable.
//                                                                       -> T1, T2, T3, T4
//   C2  Preparation still attempts cleanup of every exact root it created, preserves the primary
//       construction failure, and reports all rollback failures as bounded role-only text with
//       no path, errno, or provider output.                            -> T1, T2, T3, T4
//   C3  Deterministic tests inject marker mismatch, missing/mismatched initialized ownership,
//       and symlink/reparse refusal before a later fallback succeeds; every case proves setup
//       fails, the provider is not launched, removable owned roots are cleaned, the refused root
//       is left as evidence, and no sibling/shared parent is enumerated or touched.
//         marker mismatch                     -> T1
//         missing initialized ownership       -> T2
//         symlink/reparse refusal             -> T3
//         no sibling/shared parent touched     -> T4 (reusing the marker-mismatch shape)
//   C4  Existing repo-djf.43 and repo-djf.40 suites, no-key Codex containment, Claude
//       compatibility, and the mandatory regression profile remain green.
//                                                          -> T5 (djf.43/djf.40 red here); guard.js
//
// "The provider is not launched" is proved at the level this suite (like repo-djf.43 before it)
// exercises: `runner/author-containment.js`'s prepare() directly, never `scripts/author-tests.js`.
// `applyEnv` — unchanged since repo-7a0 and re-pinned by guard.js G3 — refuses to build a launch
// environment from anything but a successful `prepared.dir`; `prepared.ok === false` therefore IS
// the fact that no PATH-leading shim directory was ever produced for a provider to be launched
// against. Proving `ok === false` and `handle === null` at this layer proves the provider is not
// launched without re-deriving `scripts/author-tests.js`'s own call sequence, which neither this
// issue nor djf.40/djf.43 fixes as a literal name.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE FROZEN INTERFACE. This suite adds no export and fixes no new name: it exercises the exact
// `runner/author-containment.js` surface repo-djf.40 fixed and repo-djf.43 extended —
// `OWNERSHIP_MARKER_NAME`, `prepare(dir, { issueId, fallbackParents, selfTest })` returning
// `{ ok, dir, names, handle }` or `{ ok: false, error, rollbackError, handle: null }` where
// `handle = { issueId, nonce, shimRoot, fallbackRoots }` — through the same injectable seams
// (`selfTest`, `fs.writeFileSync` fault injection) repo-djf.43 already established as the
// plainest deterministic, key-free, no-generated-file-execution fault injection available.
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

const ISSUE = 'repo-djf.44';
const FIXTURE_TEXT = 'repo-djf.44 fixture';

const tests = [];
function test(name, body) { tests.push({ name, body }); }

const temps = [];
function tmp(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `repo-djf44-${tag}-`));
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

function fixtureError() {
  return Object.assign(new Error(`${FIXTURE_TEXT}: EIO, write failed`), { code: 'EIO' });
}

function assertShimPresent(CONTAIN, dir) {
  for (const name of ['bd', 'bd.cmd']) {
    assert(fs.existsSync(path.join(dir, name)), `${dir} is missing ${name}`);
  }
  assert(typeof CONTAIN.OWNERSHIP_MARKER_NAME === 'string' && CONTAIN.OWNERSHIP_MARKER_NAME.length > 0,
    'runner/author-containment.js does not export a non-empty OWNERSHIP_MARKER_NAME');
}

function assertGone(dir, label) {
  assert.strictEqual(fs.existsSync(dir), false, `${label}: a removable owned root was not cleaned up: ${dir}`);
}

function assertBoundedAndClean(text, label, hostPaths) {
  assert(typeof text === 'string' && text.length > 0, `${label} is missing or empty: ${JSON.stringify(text)}`);
  assert(text.length <= 300, `${label} is not bounded: ${text.length} chars`);
  assert(!new RegExp('EIO|EPERM|ENOENT|' + FIXTURE_TEXT.replace('.', '\\.')).test(text),
    `${label} leaked the underlying OS/fixture error text: ${text}`);
  for (const hostPath of hostPaths) {
    assert(!text.includes(hostPath), `${label} names a host path: ${text}`);
  }
}

// ── T1 / C1,C2,C3 ────────────────────────────────────────────────────────────────────────────
test('T1 C1,C2,C3(marker mismatch) a fallback candidate whose ownership marker no longer matches at rollback time refuses that rollback, leaves the mismatched root as evidence, and blocks recovery through a later, otherwise-usable fallback', () => {
  const CONTAIN = containment();
  const shimParent = tmp('t1-shim-parent');
  const fbParents = [tmp('t1-fb-a'), tmp('t1-fb-b')];
  const dir = path.join(shimParent, 'shim');
  let idx = -1;
  let failingCandidate = null;
  const selfTest = (candidate) => {
    idx += 1;
    if (idx === 1) failingCandidate = candidate;
    return true;
  };

  const real = fs.writeFileSync;
  fs.writeFileSync = (p, ...rest) => {
    // idx 0: the shim root's own ownership-marker write throws with nothing tampered — an
    // ordinary rollback, which must still succeed and let construction continue.
    if (idx === 0 && path.basename(p) === CONTAIN.OWNERSHIP_MARKER_NAME) throw fixtureError();
    // idx 1: this candidate's marker was written successfully, but by the time its POSIX shim
    // write fails, something else has overwritten the marker's content — a race that leaves
    // rollback unable to prove this root is the one it just created.
    if (idx === 1 && path.basename(p) === 'bd') {
      real(path.join(path.dirname(p), CONTAIN.OWNERSHIP_MARKER_NAME), 'someone-elses-nonce');
      throw fixtureError();
    }
    return real(p, ...rest);
  };

  let prepared;
  try { prepared = CONTAIN.prepare(dir, { issueId: ISSUE, fallbackParents: fbParents, selfTest }); }
  finally { fs.writeFileSync = real; }

  assert.strictEqual(prepared.ok, false, JSON.stringify(prepared));
  assert.strictEqual(prepared.handle, null, JSON.stringify(prepared));
  assert(failingCandidate, 'the fallback-candidate boundary under test was never reached');
  assert.strictEqual(idx, 1, 'construction reached a fallback candidate beyond the one whose rollback was refused');

  // The earlier, untampered shim-root candidate was still cleaned up in full.
  assertGone(dir, 'T1 shim root');
  // The refused candidate is left exactly as evidence: present, with the tampered marker intact.
  assertShimPresent(CONTAIN, failingCandidate);
  const markerAfter = fs.readFileSync(path.join(failingCandidate, CONTAIN.OWNERSHIP_MARKER_NAME), 'utf8');
  assert.strictEqual(markerAfter, 'someone-elses-nonce',
    'the refused root\'s mismatched marker was altered instead of being left as evidence');

  const hostPaths = [shimParent, ...fbParents, dir, failingCandidate];
  assertBoundedAndClean(prepared.error, 'the primary preparation error', hostPaths);
  assertBoundedAndClean(prepared.rollbackError, 'the rollback error', hostPaths);
});

// ── T2 / C1,C2,C3 ────────────────────────────────────────────────────────────────────────────
test('T2 C1,C2,C3(missing initialized ownership) a fallback candidate whose ownership marker has vanished by rollback time refuses that rollback and blocks recovery through a later, otherwise-usable fallback', () => {
  const CONTAIN = containment();
  const shimParent = tmp('t2-shim-parent');
  const fbParents = [tmp('t2-fb-a'), tmp('t2-fb-b')];
  const dir = path.join(shimParent, 'shim');
  let idx = -1;
  let failingCandidate = null;
  const selfTest = (candidate) => {
    idx += 1;
    if (idx === 1) failingCandidate = candidate;
    return true;
  };

  const real = fs.writeFileSync;
  fs.writeFileSync = (p, ...rest) => {
    if (idx === 0 && path.basename(p) === CONTAIN.OWNERSHIP_MARKER_NAME) throw fixtureError();
    if (idx === 1 && path.basename(p) === 'bd') {
      const markerPath = path.join(path.dirname(p), CONTAIN.OWNERSHIP_MARKER_NAME);
      try { fs.unlinkSync(markerPath); } catch { /* best effort race simulation */ }
      throw fixtureError();
    }
    return real(p, ...rest);
  };

  let prepared;
  try { prepared = CONTAIN.prepare(dir, { issueId: ISSUE, fallbackParents: fbParents, selfTest }); }
  finally { fs.writeFileSync = real; }

  assert.strictEqual(prepared.ok, false, JSON.stringify(prepared));
  assert.strictEqual(prepared.handle, null, JSON.stringify(prepared));
  assert(failingCandidate, 'the fallback-candidate boundary under test was never reached');
  assert.strictEqual(idx, 1, 'construction reached a fallback candidate beyond the one whose rollback was refused');

  assertGone(dir, 'T2 shim root');
  assert(fs.existsSync(failingCandidate), 'the refused root was removed instead of being left as evidence');
  assert(fs.existsSync(path.join(failingCandidate, 'bd')), 'the refused root\'s partial contents were altered');
  assert.strictEqual(fs.existsSync(path.join(failingCandidate, CONTAIN.OWNERSHIP_MARKER_NAME)), false,
    'the refused root\'s marker reappeared; it should stay exactly as it was at the moment rollback refused it');

  const hostPaths = [shimParent, ...fbParents, dir, failingCandidate];
  assertBoundedAndClean(prepared.error, 'the primary preparation error', hostPaths);
  assertBoundedAndClean(prepared.rollbackError, 'the rollback error', hostPaths);
});

// ── T3 / C1,C2,C3 ────────────────────────────────────────────────────────────────────────────
test('T3 C1,C2,C3(symlink/reparse refusal) a fallback candidate swapped for a symlink/reparse point mid-construction refuses rollback, leaves the reparse point untouched, and blocks recovery through a later, otherwise-usable fallback', () => {
  const CONTAIN = containment();
  const shimParent = tmp('t3-shim-parent');
  const fbParents = [tmp('t3-fb-a'), tmp('t3-fb-b')];
  const dir = path.join(shimParent, 'shim');
  const decoy = tmp('t3-decoy');
  fs.writeFileSync(path.join(decoy, 'do-not-touch'), 'precious');

  let idx = -1;
  let failingCandidate = null;
  let canSymlink = true;
  const selfTest = (candidate) => {
    idx += 1;
    if (idx === 1) failingCandidate = candidate;
    return true;
  };

  const real = fs.writeFileSync;
  fs.writeFileSync = (p, ...rest) => {
    if (idx === 0 && path.basename(p) === CONTAIN.OWNERSHIP_MARKER_NAME) throw fixtureError();
    if (idx === 1 && path.basename(p) === 'bd') {
      const candidateDir = path.dirname(p);
      try {
        fs.rmSync(candidateDir, { recursive: true, force: true });
        fs.symlinkSync(path.resolve(decoy), candidateDir, process.platform === 'win32' ? 'junction' : 'dir');
      } catch { canSymlink = false; }
      throw fixtureError();
    }
    return real(p, ...rest);
  };

  let prepared;
  try { prepared = CONTAIN.prepare(dir, { issueId: ISSUE, fallbackParents: fbParents, selfTest }); }
  finally { fs.writeFileSync = real; }

  if (!canSymlink) { console.log('[test] SKIP T3: host cannot create a directory symlink/junction'); return; }

  assert.strictEqual(prepared.ok, false, JSON.stringify(prepared));
  assert.strictEqual(prepared.handle, null, JSON.stringify(prepared));
  assert(failingCandidate, 'the fallback-candidate boundary under test was never reached');
  assert.strictEqual(idx, 1, 'construction reached a fallback candidate beyond the one whose rollback was refused');

  assertGone(dir, 'T3 shim root');
  assert(fs.existsSync(path.join(decoy, 'do-not-touch')), 'rollback followed the swapped-in reparse point into its target');
  assert(fs.lstatSync(failingCandidate).isSymbolicLink(),
    'rollback removed the reparse point itself instead of refusing to follow it');

  const hostPaths = [shimParent, ...fbParents, dir, failingCandidate, decoy];
  assertBoundedAndClean(prepared.error, 'the primary preparation error', hostPaths);
  assertBoundedAndClean(prepared.rollbackError, 'the rollback error', hostPaths);
});

// ── T4 / C1,C2,C3 ────────────────────────────────────────────────────────────────────────────
test('T4 C1,C2,C3(no sibling/shared parent touched) a refused rollback inside a fallback parent shared with another launch never enumerates that parent and leaves the sibling\'s already-owned root untouched', () => {
  const CONTAIN = containment();
  const sharedFbParent = tmp('t4-shared-fb');

  const dirB = path.join(sharedFbParent, 'shim-b');
  const preparedB = CONTAIN.prepare(dirB, { issueId: ISSUE, fallbackParents: [], selfTest: () => true });
  assert(preparedB.ok, JSON.stringify(preparedB));
  assertShimPresent(CONTAIN, preparedB.dir);
  const nonceB = fs.readFileSync(path.join(preparedB.dir, CONTAIN.OWNERSHIP_MARKER_NAME), 'utf8');

  const shimParentA = tmp('t4-shim-parent-a');
  const dirA = path.join(shimParentA, 'shim');
  const fbC = tmp('t4-fb-c'); // a later, otherwise-usable fallback that must never be reached
  let idx = -1;
  let failingCandidate = null;
  const selfTest = (candidate) => {
    idx += 1;
    if (idx === 1) failingCandidate = candidate;
    return true;
  };

  const real = fs.writeFileSync;
  fs.writeFileSync = (p, ...rest) => {
    if (idx === 0 && path.basename(p) === CONTAIN.OWNERSHIP_MARKER_NAME) throw fixtureError();
    if (idx === 1 && path.basename(p) === 'bd') {
      real(path.join(path.dirname(p), CONTAIN.OWNERSHIP_MARKER_NAME), 'someone-elses-nonce');
      throw fixtureError();
    }
    return real(p, ...rest);
  };

  const realReaddir = fs.readdirSync;
  let sharedParentEnumerated = false;
  fs.readdirSync = (...args) => {
    if (path.resolve(String(args[0])) === path.resolve(sharedFbParent)) sharedParentEnumerated = true;
    return realReaddir(...args);
  };

  let prepared;
  try {
    prepared = CONTAIN.prepare(dirA, { issueId: ISSUE, fallbackParents: [sharedFbParent, fbC], selfTest });
  } finally {
    fs.writeFileSync = real;
    fs.readdirSync = realReaddir;
  }

  assert.strictEqual(prepared.ok, false, JSON.stringify(prepared));
  assert.strictEqual(prepared.handle, null, JSON.stringify(prepared));
  assert(failingCandidate, 'the fallback-candidate boundary under test was never reached');
  assert.strictEqual(idx, 1, 'construction reached the later, otherwise-usable fallback parent instead of stopping');
  assert.strictEqual(sharedParentEnumerated, false,
    'rollback enumerated the shared fallback parent directory instead of removing only its own exact registered path');

  assertGone(dirA, 'T4 shim root');
  assertShimPresent(CONTAIN, preparedB.dir);
  const nonceAfter = fs.readFileSync(path.join(preparedB.dir, CONTAIN.OWNERSHIP_MARKER_NAME), 'utf8');
  assert.strictEqual(nonceAfter, nonceB, 'the sibling launch\'s ownership marker changed during an unrelated construction failure');

  const hostPaths = [shimParentA, sharedFbParent, fbC, dirA, failingCandidate];
  assertBoundedAndClean(prepared.error, 'the primary preparation error', hostPaths);
  assertBoundedAndClean(prepared.rollbackError, 'the rollback error', hostPaths);
});

// ── T5 / C4 ──────────────────────────────────────────────────────────────────────────────────
test('T5 C4 the existing frozen tests/acceptance/repo-djf.43/test.js and tests/acceptance/repo-djf.40/test.js still pass in full once this refuse-on-rollback-failure behavior is built', () => {
  for (const sibling of ['repo-djf.43', 'repo-djf.40']) {
    const SIBLING_TEST = path.join(ROOT, 'tests', 'acceptance', sibling, 'test.js');
    assert(fs.existsSync(SIBLING_TEST), `sibling suite is missing: ${SIBLING_TEST}`);
    const result = spawnSync(process.execPath, [SIBLING_TEST], { cwd: ROOT, encoding: 'utf8' });
    assert.strictEqual(result.status, 0,
      `tests/acceptance/${sibling}/test.js did not pass (exit ${JSON.stringify(result.status)}) — `
      + `a valid repo-djf.44 fix must be additive to, not a narrower replacement of, that suite's contract\n`
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
