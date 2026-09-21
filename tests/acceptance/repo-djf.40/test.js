// Frozen acceptance test — repo-djf.40: dispose acceptance-author containment shims after launch.
// This is the RED half. `guard.js` beside it carries the checks that are already green at the
// fork point (repo-7a0's containment, Claude compatibility, boundary and no-key behavior) and
// must stay green; between them every criterion is covered in both directions.
//
// This suite supersedes an earlier, under-scoped draft that accepted a patch which merely made
// `containmentDir` unique, added an unsafe `dispose(prepared)`, and wrapped `launchAuthor` without
// any ownership contract. That patch is not this criterion: a leak-free dispose has to survive a
// noexec fallback, a forged or mismatched handle, a symlinked root, a partial cleanup failure and
// a construction failure — not merely a happy path. Every check below is written to fail against
// that weaker shape and to keep failing until the ownership contract below is actually built.
//
// CRITERION PAIRING — every check below also names its own criterion in its label.
//
//   C1  prepare() returns an opaque per-launch handle recording the exact shim root and every
//       fallback candidate it actually created — including one that failed its own execution
//       self-test — plus a fresh nonce and an ownership marker written into every owned root
//       before any other content.                                    -> T4, T8b, T11
//   C2  the handle is host-owned: it never reaches the author's prompt or child environment.
//       applyEnv() keeps exposing only prepared.dir, exactly as repo-7a0 pinned it.  -> T1, T1b
//   C3  dispose() accepts only a handle shaped like prepare()'s own. It refuses arbitrary paths,
//       a missing or mismatched ownership marker, a symlinked/reparse-point root, and a root
//       outside the declared safe parents — and it never infers ownership from a directory name
//       or prefix alone.                                              -> T4, T5, T6, T7
//   C4  dispose() removes the shim root first, then each owned fallback root, deepest path
//       first, using only the literal paths in the handle. It never enumerates or sweeps a
//       parent directory, so concurrent launches are independent by construction. -> T2a, T2b
//   C5  dispose() is idempotent: a repeat call against an already-removed, correctly-owned root
//       is still success, not an error.                                -> T4, T2b
//   C6  dispose() attempts every owned root even when one fails, and reports one bounded,
//       role-only error — never a host path and never provider stdout/stderr. -> T3, T7, T8b
//   C7  prepare() rolls back every root it created when construction fails before it can return
//       a valid handle. A rollback failure is attached to the preparation error without masking
//       that error's original cause.                                  -> T8a, T8c
//   C8  only the Codex AGENT.launch() call is wrapped in try/finally. The shim stays present and
//       usable for the whole provider call and is disposed exactly once after the provider
//       settles or throws — across success, a nonzero exit, incomplete output and a thrown
//       launch error.                                                 -> T1
//   C9  the provider's own result, or its thrown error, is preserved unchanged; a bounded
//       cleanup outcome is added purely additively. A thrown launch error keeps its original
//       message and carries the cleanup outcome as attached metadata, falling back to an
//       aggregate whose primary cause is the launch error when direct attachment is impossible.
//                                                                       -> T1, T1b, T3
//   C10 authorIssue() reports a cleanup failure explicitly. A nonzero, usage-limit or incomplete
//       provider outcome stays truthful regardless of cleanup. A provider-complete session with
//       failed cleanup cannot begin proof or print a freeze command, and instead returns one
//       distinct outcome carrying the original provider status.        -> T9
//   C11 (guard.js) existing repo-7a0 containment, Claude compatibility, Codex argv and boundary
//       behavior remain green.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE FROZEN INTERFACE. The issue names no module or function surface beyond the repo-7a0 module
// it extends, so this suite fixes one. Node built-ins only, synchronous, no container engine, no
// network, NO PROVIDER KEY, and — per the hardened verifier's restricted tmpfs — no execution of
// any generated shim file: every check below proves the noexec-fallback and self-test machinery
// through injectable seams (`fallbackParents`, `selfTest`) rather than by spawning anything.
//
// `runner/author-containment.js` (existing module) gains:
//
//   OWNERSHIP_MARKER_NAME
//     A non-empty file name. prepare() writes this file, containing a fresh nonce, into every
//     root it creates — the shim root and every fallback candidate — before any other content.
//     dispose() refuses to remove a root whose marker is absent or whose content does not match
//     the nonce recorded in the handle it was given.
//
//   prepare(dir, { issueId, fallbackParents, selfTest }) ->
//       success: { ok: true, dir: <the root actually usable>, names: ['bd', 'bd.cmd'], handle }
//         handle = { issueId, nonce, shimRoot: <resolved dir>, fallbackRoots: [ ...every
//           fallback candidate directory actually created, in creation order, including any
//           that failed its self-test ] }
//       failure: { ok: false, error: <non-empty string>, rollbackError: <string|null>, handle: null }
//     `fallbackParents` is an array of candidate parent directories tried in order when `dir`
//     itself fails its self-test (the noexec case); `selfTest(candidateDir) -> boolean` decides
//     usability without ever spawning anything, so a caller — this suite — can force the noexec
//     path deterministically. A construction failure (no root, including `dir` itself, ever
//     passes its self-test) rolls back every root prepare() created during that call before
//     returning; a failure encountered during that rollback is reported as `rollbackError`
//     without replacing the original `error`.
//
//   dispose(handle, { shimParent, fallbackParents }) -> { ok: true } | { ok: false, error }
//     `shimParent` is the one directory the shim root's parent must resolve to; `fallbackParents`
//     is the same array prepare() was given. Only a handle whose every owned root (i) is not a
//     symlink or reparse point, (ii) has a parent equal to `shimParent` (for the shim root) or a
//     member of `fallbackParents` (for a fallback root), and (iii) carries an ownership marker
//     matching `handle.nonce`, is ever removed — and only that exact literal path, longest path
//     first. dispose() attempts every owned root regardless of an earlier failure and reports one
//     bounded error naming only the failed roles (e.g. "shim", "fallback[0]"), never a host path
//     or any provider output. A root that no longer exists is already disposed and counts as
//     success. dispose() never reads a parent directory's contents.
//
//   applyEnv(baseEnv, prepared) — unchanged from repo-7a0: still reads only `prepared.dir`.
//
// `scripts/author-tests.js` changes behaviour in two places:
//
//   launchAuthor(built, model, run)
//     For a Codex test-author, `runner/author-containment.js`'s prepare() is called before the
//     provider is invoked; only the `run(...)` call itself is wrapped in try/finally, and
//     dispose() runs against the exact handle prepare() returned after `run` has settled or
//     thrown — never before, never concurrently with it. A returned result carries its original
//     `status`/`stdout`/`stderr` (and any usage-limit evidence) completely unmodified, plus
//     `containmentCleanup: { ok: true }` or a bounded `{ ok: false, error }`. A thrown `run` error
//     is rethrown with its original `message` unmodified, carrying the bounded cleanup outcome as
//     `error.containmentCleanup`; if that attachment is impossible the thrown value is instead an
//     aggregate whose primary/cause is the original error and which still carries
//     `containmentCleanup`. `containmentCleanup` is `undefined` for a non-Codex provider.
//
//   authorIssue(built, configPath, io, seams)
//     A cleanup failure is reported explicitly. A nonzero exit, a usage-limit result, or an
//     incomplete terminal result still reports its existing truthful outcome even when cleanup
//     also failed. Only when the provider itself completed successfully AND cleanup failed does
//     authorIssue refuse to call proveTests or print the freeze-command next step, returning one
//     distinct outcome that still carries the original (successful) provider status.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// INTERFACE CHOICES — the issue and the controlling design specify the safety contract but not a
// literal marker file name, option names or handle field names; this suite fixes concrete ones
// (above) so the contract is checkable. Any implementation satisfying the CONTRACT — not these
// particular identifiers — is free to pick different internal names as long as the exports this
// suite requires exist and behave as described.
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const PROVIDER_KEY_NAMES = Object.freeze([
  'CODEX_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN',
]);

// Deterministic and key-free, exactly like the already-frozen repo-7a0 suite this one extends.
for (const name of [...PROVIDER_KEY_NAMES,
  'PIPELINE_BD_CMD', 'BD_ARGS_LOG', 'BD_STUB_OUT', 'BD_STUB_EXIT',
  'PIPELINE_TEST_AUTHOR_CMD', 'PIPELINE_TEST_PROBE_CMD']) delete process.env[name];

const AUTHOR = require(path.join(ROOT, 'scripts', 'author-tests.js'));
const CONTAINMENT_FILE = path.join(ROOT, 'runner', 'author-containment.js');

const tests = [];
function test(name, body) { tests.push({ name, body }); }

const ISSUE = 'repo-djf.40';

const temps = [];
function tmp(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `repo-djf40-${tag}-`));
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

function pathKeys(env) { return Object.keys(env).filter((k) => k.toLowerCase() === 'path'); }
function firstPathEntry(env) {
  const keys = pathKeys(env);
  assert.deepStrictEqual(keys, ['PATH'], `env must carry exactly one path key spelled PATH, got ${JSON.stringify(keys)}`);
  return String(env.PATH).split(path.delimiter)[0];
}

function writeBuilt(cfgOverrides = {}, worktree = null) {
  const dir = worktree || tmp('worktree');
  return {
    ok: true, state: 'write', id: ISSUE, requestedId: ISSUE, canonicalId: ISSUE, suiteId: ISSUE,
    branch: 'main', text: `FIXTURE BRIEF for ${ISSUE}`,
    policy: { verifyCommand: 'sh tools/run-acceptance.sh', frozenPaths: ['tools/run-acceptance.sh'] },
    folder: { dir, exists: true, branch: `freeze-${ISSUE}` },
    cfg: {
      targetRepoPath: ROOT, model: 'fixture-model', testAuthorModel: 'fixture-model',
      testProbeModel: 'fixture-model', wallClockMinutes: 2,
      provider: 'codex', testAuthorProvider: 'codex', testProbeProvider: 'codex',
      reasoningEffort: 'high', testAuthorReasoningEffort: 'high',
      hostEnv: {}, ...cfgOverrides,
    },
  };
}

const CODEX_TERMINAL = `${JSON.stringify({ type: 'thread.started', thread_id: 'th-fixture' })}\n`
  + `${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Wrote the suite.' } })}\n`
  + `${JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } })}\n`;
const CODEX_NO_TERMINAL = `${JSON.stringify({ type: 'thread.started', thread_id: 'th-fixture' })}\n`
  + `${JSON.stringify({ type: 'item.started', item: { type: 'agent_message' } })}\n`;

// Structural proof that a shim root is a real, functional containment root — WITHOUT ever
// spawning the shim files it contains. The hardened verifier's restricted tmpfs cannot reliably
// execute a generated /tmp binary at all, so this suite never tries.
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

function assertDisposed(dir) {
  assert.strictEqual(fs.existsSync(dir), false, `the owned root was not disposed: ${dir}`);
}

function forceRmSyncFailure() {
  const real = fs.rmSync;
  fs.rmSync = () => { throw Object.assign(new Error('repo-djf.40 fixture: EPERM, permission denied'), { code: 'EPERM' }); };
  return () => { fs.rmSync = real; };
}

// ── T1 / C2,C8,C9 ────────────────────────────────────────────────────────────────────────────
test('T1 C2,C8,C9 a Codex launch\'s shim stays present through success, a nonzero exit, incomplete output and a thrown launch error, is disposed exactly once after each settles, and never leaks its ownership nonce into the prompt or child environment', () => {
  const CONTAIN = containment();

  const scenarios = [
    ['success (terminal Codex result)', () => ({ status: 0, stdout: CODEX_TERMINAL, stderr: '' })],
    ['nonzero exit', () => ({ status: 9, stdout: '', stderr: 'codex died' })],
    ['incomplete output (zero exit, no terminal result)', () => ({ status: 0, stdout: CODEX_NO_TERMINAL, stderr: '' })],
    ['a thrown launch error', () => { throw new Error('repo-djf.40 fixture: spawn ENOENT'); }],
  ];

  for (const [label, respond] of scenarios) {
    const built = writeBuilt();
    let capturedDir = null;
    const run = (command, args, opts) => {
      capturedDir = firstPathEntry(opts.env);
      const nonce = assertShimPresent(CONTAIN, capturedDir);
      assert(!String(opts.input).includes(nonce), `${label}: the ownership nonce leaked into the author prompt`);
      for (const [key, value] of Object.entries(opts.env)) {
        assert(!(typeof value === 'string' && value.includes(nonce)),
          `${label}: the ownership nonce leaked into environment variable ${key}`);
      }
      return respond();
    };

    let threw = null;
    let result = null;
    try { result = AUTHOR.launchAuthor(built, 'fixture-model', run); }
    catch (error) { threw = error; }

    assert(capturedDir, `${label}: the run seam was never reached`);
    if (label === 'a thrown launch error') {
      assert(threw, `${label}: launchAuthor swallowed a thrown run() error instead of propagating it`);
      assert(/repo-djf\.40 fixture: spawn ENOENT/.test(threw.message),
        `${label}: the propagated error was altered: ${threw.message}`);
      assert(threw.containmentCleanup && typeof threw.containmentCleanup.ok === 'boolean',
        `${label}: the thrown error carries no bounded cleanup metadata: ${JSON.stringify(threw.containmentCleanup)}`);
    } else {
      assert(!threw, `${label}: launchAuthor threw unexpectedly: ${threw && (threw.stack || threw.message)}`);
      assert(result, `${label}: launchAuthor returned nothing`);
      assert(result.containmentCleanup && result.containmentCleanup.ok === true,
        `${label}: cleanup did not report success: ${JSON.stringify(result.containmentCleanup)}`);
      if (label === 'success (terminal Codex result)') {
        assert.strictEqual(result.status, 0); assert.strictEqual(result.stdout, CODEX_TERMINAL);
      } else if (label === 'nonzero exit') {
        assert.strictEqual(result.status, 9); assert.strictEqual(result.stderr, 'codex died');
      } else {
        assert.strictEqual(result.status, 0); assert.strictEqual(result.stdout, CODEX_NO_TERMINAL);
      }
    }
    // Whether launchAuthor returned or threw, the shim used for THIS call is gone once it has
    // settled — cleanup runs after the provider process, never before.
    assertDisposed(capturedDir);
  }
});

// ── T1b / C2,C9 ──────────────────────────────────────────────────────────────────────────────
test('T1b C9 a thrown launch error that cannot itself be extended (e.g. frozen) still surfaces its original message and cause, wrapped only enough to attach the bounded cleanup outcome', () => {
  const built = writeBuilt();
  const original = Object.freeze(new Error('repo-djf.40 fixture: frozen spawn failure'));
  const run = () => { throw original; };

  let threw = null;
  try { AUTHOR.launchAuthor(built, 'fixture-model', run); }
  catch (error) { threw = error; }

  assert(threw, 'launchAuthor swallowed the thrown run() error');
  const primary = (threw.errors && threw.errors[0]) || threw.cause || threw;
  assert.strictEqual(primary, original,
    'the original frozen launch error is no longer reachable as the primary cause of what launchAuthor threw');
  assert(/frozen spawn failure/.test(threw.message), `the propagated error lost its original message: ${threw.message}`);
  assert(threw.containmentCleanup && typeof threw.containmentCleanup.ok === 'boolean',
    `the wrapped error carries no bounded cleanup metadata: ${JSON.stringify(threw.containmentCleanup)}`);
});

// ── T2a / C4 ─────────────────────────────────────────────────────────────────────────────────
test('T2a C4 concurrent Codex launches each dispose only their own shim; a sibling launch, the shared root and an unrelated cache path all survive', () => {
  const CONTAIN = containment();

  const decoyRoot = path.join(os.tmpdir(), 'multi-agent-author-containment');
  fs.mkdirSync(decoyRoot, { recursive: true });
  const decoy = fs.mkdtempSync(path.join(decoyRoot, 'repo-djf40-decoy-'));
  fs.writeFileSync(path.join(decoy, 'sentinel'), 'do-not-touch');

  const builtOuter = writeBuilt();
  const builtInner = writeBuilt({}, tmp('inner-worktree'));
  let outerDir = null;
  let innerDir = null;

  const runOuter = (command, args, opts) => {
    outerDir = firstPathEntry(opts.env);
    assertShimPresent(CONTAIN, outerDir);

    const runInner = (innerCommand, innerArgs, innerOpts) => {
      innerDir = firstPathEntry(innerOpts.env);
      assert.notStrictEqual(path.resolve(innerDir), path.resolve(outerDir),
        'two concurrent launches were handed the same shim directory');
      assertShimPresent(CONTAIN, innerDir);
      return { status: 0, stdout: CODEX_TERMINAL, stderr: '' };
    };
    AUTHOR.launchAuthor(builtInner, 'fixture-model', runInner);
    assert(innerDir, 'the nested concurrent launch never reached the run seam');
    assertDisposed(innerDir);

    // B's cleanup must not have touched A's still-active shim, the decoy, or the shared root.
    assertShimPresent(CONTAIN, outerDir);
    assert(fs.existsSync(decoy) && fs.existsSync(path.join(decoy, 'sentinel')),
      'a concurrent launch\'s cleanup reached an unrelated cache path');
    return { status: 0, stdout: CODEX_TERMINAL, stderr: '' };
  };
  AUTHOR.launchAuthor(builtOuter, 'fixture-model', runOuter);

  assertDisposed(outerDir);
  assert(fs.existsSync(decoyRoot) && fs.existsSync(decoy),
    'a launch\'s cleanup swept the shared containment root or an unrelated sibling beneath it');
});

// ── T2b / C4,C5 ──────────────────────────────────────────────────────────────────────────────
test('T2b C4,C5 two directly prepared handles dispose independently in either order, touching only their own owned roots', () => {
  const CONTAIN = containment();
  const shimParentA = tmp('shimparent-a');
  const shimParentB = tmp('shimparent-b');
  const fbParents = [tmp('fb-a'), tmp('fb-b')];
  const selfTest = () => true;

  const dirA = path.join(shimParentA, 'shim');
  const dirB = path.join(shimParentB, 'shim');
  const preparedA = CONTAIN.prepare(dirA, { issueId: ISSUE, fallbackParents: fbParents, selfTest });
  const preparedB = CONTAIN.prepare(dirB, { issueId: ISSUE, fallbackParents: fbParents, selfTest });
  assert(preparedA.ok && preparedB.ok, JSON.stringify([preparedA, preparedB]));

  const rB = CONTAIN.dispose(preparedB.handle, { shimParent: shimParentB, fallbackParents: fbParents });
  assert.deepStrictEqual(rB, { ok: true }, JSON.stringify(rB));
  assertDisposed(dirB);
  assert(fs.existsSync(dirA), 'disposing B removed A\'s still-active shim');

  const rA = CONTAIN.dispose(preparedA.handle, { shimParent: shimParentA, fallbackParents: fbParents });
  assert.deepStrictEqual(rA, { ok: true }, JSON.stringify(rA));
  assertDisposed(dirA);

  // Repeated, in the opposite order: still idempotent regardless of order.
  assert.deepStrictEqual(CONTAIN.dispose(preparedA.handle, { shimParent: shimParentA, fallbackParents: fbParents }), { ok: true });
  assert.deepStrictEqual(CONTAIN.dispose(preparedB.handle, { shimParent: shimParentB, fallbackParents: fbParents }), { ok: true });
});

// ── T3 / C6,C9 ───────────────────────────────────────────────────────────────────────────────
test('T3 C6,C9 a cleanup failure is explicit, bounded to owned roles (never a host path or the underlying OS text), and never masks the provider\'s own result', () => {
  const restore = forceRmSyncFailure();
  try {
    const okBuilt = writeBuilt();
    let okDir = null;
    const okRun = (command, args, opts) => { okDir = firstPathEntry(opts.env); return { status: 0, stdout: CODEX_TERMINAL, stderr: '' }; };
    const okResult = AUTHOR.launchAuthor(okBuilt, 'fixture-model', okRun);
    assert.strictEqual(okResult.status, 0, 'a forced cleanup failure altered the provider exit status');
    assert.strictEqual(okResult.stdout, CODEX_TERMINAL, 'a forced cleanup failure altered the provider stdout');
    assert(okResult.containmentCleanup && okResult.containmentCleanup.ok === false,
      `a forced cleanup failure was not reported: ${JSON.stringify(okResult.containmentCleanup)}`);
    const cleanupError = okResult.containmentCleanup.error;
    assert(typeof cleanupError === 'string' && cleanupError.length > 0 && cleanupError.length <= 200,
      `the cleanup failure carries no bounded explanation: ${JSON.stringify(cleanupError)}`);
    assert(!cleanupError.includes(okDir), `the bounded cleanup error names a host path: ${cleanupError}`);
    assert(!/EPERM|repo-djf\.40 fixture/.test(cleanupError),
      `the bounded cleanup error leaked the underlying OS error text: ${cleanupError}`);
    assert(fs.existsSync(okDir), 'the shim directory vanished despite fs.rmSync being forced to fail');

    const failBuilt = writeBuilt();
    const failRun = () => ({ status: 9, stdout: '', stderr: 'codex died' });
    const failResult = AUTHOR.launchAuthor(failBuilt, 'fixture-model', failRun);
    assert.strictEqual(failResult.status, 9, 'a forced cleanup failure altered a failing provider exit status');
    assert.strictEqual(failResult.stderr, 'codex died', 'a forced cleanup failure altered a failing provider stderr');
    assert(failResult.containmentCleanup && failResult.containmentCleanup.ok === false,
      `a forced cleanup failure on a failing session was not reported: ${JSON.stringify(failResult.containmentCleanup)}`);
  } finally {
    restore();
  }
});

// ── T4 / C1,C3,C5 ────────────────────────────────────────────────────────────────────────────
test('T4 C1,C3,C5 dispose() accepts only a handle shaped like prepare()\'s own, is idempotent, and never infers ownership from a directory\'s path or name alone', () => {
  const CONTAIN = containment();
  assert.strictEqual(typeof CONTAIN.dispose, 'function', 'runner/author-containment.js does not export dispose()');

  const dir = tmp('dispose-plain');
  const control = tmp('dispose-plain-control');
  fs.writeFileSync(path.join(control, 'sentinel'), 'keep');
  const fbParents = [tmp('fb-x'), tmp('fb-y')];
  const prepared = CONTAIN.prepare(dir, { issueId: ISSUE, fallbackParents: fbParents, selfTest: () => true });
  assert(prepared.ok, JSON.stringify(prepared));
  assert(prepared.handle && typeof prepared.handle.nonce === 'string' && prepared.handle.nonce.length > 0,
    `prepare() did not return a handle with a nonce: ${JSON.stringify(prepared)}`);
  assert.strictEqual(prepared.handle.shimRoot, path.resolve(dir));
  assert(Array.isArray(prepared.handle.fallbackRoots) && prepared.handle.fallbackRoots.length === 0,
    `an in-place-usable shim root should carry no fallback roots: ${JSON.stringify(prepared.handle)}`);

  // Non-handle-shaped values are refused wholesale, without ever touching the filesystem.
  for (const bogus of [null, undefined, '/some/path', { dir }, { shimRoot: dir }, 42, prepared.dir]) {
    const r = CONTAIN.dispose(bogus, { shimParent: path.dirname(dir), fallbackParents: fbParents });
    assert.strictEqual(r.ok, false, `dispose() accepted a non-handle value: ${JSON.stringify(bogus)}`);
    assert(fs.existsSync(dir), 'dispose() touched the shim directory while refusing an unrelated bogus value');
  }

  const r = CONTAIN.dispose(prepared.handle, { shimParent: path.dirname(dir), fallbackParents: fbParents });
  assert.deepStrictEqual(r, { ok: true }, JSON.stringify(r));
  assertDisposed(dir);
  assert(fs.existsSync(control), 'dispose() touched an unrelated directory');

  // Idempotent.
  assert.deepStrictEqual(
    CONTAIN.dispose(prepared.handle, { shimParent: path.dirname(dir), fallbackParents: fbParents }), { ok: true },
  );

  // A directory re-created at the exact same path afterward, with no matching ownership marker,
  // must not be swept just because its path matches a once-owned root.
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'sentinel-not-ours'), 'should survive');
  const impostor = CONTAIN.dispose(prepared.handle, { shimParent: path.dirname(dir), fallbackParents: fbParents });
  assert.strictEqual(impostor.ok, false, 'dispose() deleted a same-path directory carrying no matching ownership marker');
  assert(fs.existsSync(path.join(dir, 'sentinel-not-ours')),
    'dispose() deleted a re-created directory it never actually marked as owned');
});

// ── T5 / C3 ──────────────────────────────────────────────────────────────────────────────────
test('T5 C3 dispose() refuses any owned root whose declared parent does not match the safe root it is told about', () => {
  const CONTAIN = containment();
  const properParent = tmp('proper-parent');
  const wrongParent = tmp('wrong-parent');
  const dir = path.join(properParent, 'shim');
  const fbParents = [tmp('fb-1'), tmp('fb-2')];
  const prepared = CONTAIN.prepare(dir, { issueId: ISSUE, fallbackParents: fbParents, selfTest: () => true });
  assert(prepared.ok, JSON.stringify(prepared));

  const wrong = CONTAIN.dispose(prepared.handle, { shimParent: wrongParent, fallbackParents: fbParents });
  assert.strictEqual(wrong.ok, false, JSON.stringify(wrong));
  assert(fs.existsSync(dir), 'dispose() removed a root whose parent did not match the declared safe root');

  const ok = CONTAIN.dispose(prepared.handle, { shimParent: properParent, fallbackParents: fbParents });
  assert.deepStrictEqual(ok, { ok: true }, JSON.stringify(ok));
});

// ── T6 / C3 ──────────────────────────────────────────────────────────────────────────────────
test('T6 C3 dispose() refuses a symlinked/reparse-point owned root and never follows it into its target', () => {
  const CONTAIN = containment();
  const shimParent = tmp('symlink-parent');
  const target = tmp('symlink-target');
  fs.writeFileSync(path.join(target, 'do-not-touch'), 'precious');
  const linkPath = path.join(shimParent, 'shim-link');

  let linked = false;
  try {
    fs.symlinkSync(path.resolve(target), linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    linked = true;
  } catch { /* host cannot create a directory symlink/junction without privilege */ }
  if (!linked) { console.log('[test] SKIP T6: host cannot create a directory symlink/junction'); return; }

  const handle = { issueId: ISSUE, nonce: 'fixture-nonce-t6', shimRoot: path.resolve(linkPath), fallbackRoots: [] };
  const r = CONTAIN.dispose(handle, { shimParent, fallbackParents: [] });
  assert.strictEqual(r.ok, false, JSON.stringify(r));
  assert(fs.existsSync(path.join(target, 'do-not-touch')), 'dispose() followed a reparse point into its target');
  assert(fs.lstatSync(linkPath).isSymbolicLink(), 'dispose() removed the reparse point itself despite refusing it');
});

// ── T7 / C3,C6 ───────────────────────────────────────────────────────────────────────────────
test('T7 C3,C6 dispose() refuses a foreign directory that merely matches the fallback naming convention but carries no matching ownership marker, while still disposing everything it does own', () => {
  const CONTAIN = containment();
  const fbParent = tmp('fb-foreign-parent');

  // No marker at all.
  const foreign = path.join(fbParent, 'author-containment-fallback-lookalike');
  fs.mkdirSync(foreign, { recursive: true });
  fs.writeFileSync(path.join(foreign, 'innocent-file'), 'not ours');
  const shimRootA = tmp('shim-t7a');
  const handleA = { issueId: ISSUE, nonce: 'fixture-nonce-t7a', shimRoot: shimRootA, fallbackRoots: [foreign] };
  fs.writeFileSync(path.join(shimRootA, CONTAIN.OWNERSHIP_MARKER_NAME), handleA.nonce);
  let r = CONTAIN.dispose(handleA, { shimParent: path.dirname(shimRootA), fallbackParents: [fbParent] });
  assert.strictEqual(r.ok, false, JSON.stringify(r));
  assert(fs.existsSync(foreign), 'dispose() deleted a fallback-shaped directory carrying no ownership marker at all');
  assertDisposed(shimRootA);

  // A marker that exists but carries the WRONG nonce is refused the same way.
  const foreign2 = path.join(fbParent, 'author-containment-fallback-lookalike-2');
  fs.mkdirSync(foreign2, { recursive: true });
  fs.writeFileSync(path.join(foreign2, CONTAIN.OWNERSHIP_MARKER_NAME), 'someone-elses-nonce');
  const shimRootB = tmp('shim-t7b');
  const handleB = { issueId: ISSUE, nonce: 'fixture-nonce-t7b', shimRoot: shimRootB, fallbackRoots: [foreign2] };
  fs.writeFileSync(path.join(shimRootB, CONTAIN.OWNERSHIP_MARKER_NAME), handleB.nonce);
  r = CONTAIN.dispose(handleB, { shimParent: path.dirname(shimRootB), fallbackParents: [fbParent] });
  assert.strictEqual(r.ok, false, JSON.stringify(r));
  assert(fs.existsSync(foreign2), 'dispose() deleted a directory whose ownership marker did not match the handle\'s nonce');
  assertDisposed(shimRootB);
});

// ── T8a / C7 ─────────────────────────────────────────────────────────────────────────────────
test('T8a C7 prepare() rolls back the shim root and every fallback candidate it created when construction fails, and never returns a usable handle', () => {
  const CONTAIN = containment();
  const shimParent = tmp('t8a-shim-parent');
  const fbParents = [tmp('t8a-fb-a'), tmp('t8a-fb-b')];
  const dir = path.join(shimParent, 'shim');
  const created = [];
  const selfTest = (candidate) => { created.push(candidate); return false; };

  const prepared = CONTAIN.prepare(dir, { issueId: ISSUE, fallbackParents: fbParents, selfTest });
  assert.strictEqual(prepared.ok, false, JSON.stringify(prepared));
  assert(typeof prepared.error === 'string' && prepared.error.length > 0, JSON.stringify(prepared));
  assert.strictEqual(prepared.handle, null, JSON.stringify(prepared));
  assert(created.length >= 3,
    `expected the shim root plus a candidate under each fallback parent to be self-tested, got ${created.length}`);
  for (const candidate of created) {
    assert.strictEqual(fs.existsSync(candidate), false, `prepare() left a failed candidate behind: ${candidate}`);
  }
  assert(fs.existsSync(shimParent), 'prepare() rollback removed a parent directory it did not create');
  assert(fs.existsSync(fbParents[0]) && fs.existsSync(fbParents[1]),
    'prepare() rollback removed a fallback parent directory it did not create');
});

// ── T8b / C1,C6 ──────────────────────────────────────────────────────────────────────────────
test('T8b C1,C6 a first-candidate self-test failure leaves no failed candidate behind once the eventual successful handle is disposed', () => {
  const CONTAIN = containment();
  const shimParent = tmp('t8b-shim-parent');
  const fbParents = [tmp('t8b-fb-a'), tmp('t8b-fb-b')];
  const dir = path.join(shimParent, 'shim');
  const selfTest = (candidate) => candidate.startsWith(path.resolve(fbParents[1]));

  const prepared = CONTAIN.prepare(dir, { issueId: ISSUE, fallbackParents: fbParents, selfTest });
  assert(prepared.ok, JSON.stringify(prepared));
  assert.strictEqual(prepared.handle.fallbackRoots.length, 2, JSON.stringify(prepared.handle));
  const [failedCandidate, usedCandidate] = prepared.handle.fallbackRoots;
  assert(failedCandidate.startsWith(path.resolve(fbParents[0])), JSON.stringify(prepared.handle));
  assert(usedCandidate.startsWith(path.resolve(fbParents[1])), JSON.stringify(prepared.handle));
  assert.strictEqual(prepared.dir, usedCandidate, 'prepare() did not select the successfully self-tested candidate for PATH');
  assert(fs.existsSync(failedCandidate), 'the failed candidate should still be tracked (not deleted) before dispose');
  assert(fs.existsSync(dir), 'the original unusable shim root should still be tracked (not deleted) before dispose');

  const r = CONTAIN.dispose(prepared.handle, { shimParent, fallbackParents: fbParents });
  assert.deepStrictEqual(r, { ok: true }, JSON.stringify(r));
  assertDisposed(dir);
  assertDisposed(failedCandidate);
  assertDisposed(usedCandidate);
});

// ── T8c / C7 ─────────────────────────────────────────────────────────────────────────────────
test('T8c C7 a rollback failure during construction is attached without masking the original construction error', () => {
  const CONTAIN = containment();
  const shimParent = tmp('t8c-shim-parent');
  const fbParents = [tmp('t8c-fb-a'), tmp('t8c-fb-b')];
  const dir = path.join(shimParent, 'shim');
  const restore = forceRmSyncFailure();
  try {
    const prepared = CONTAIN.prepare(dir, { issueId: ISSUE, fallbackParents: fbParents, selfTest: () => false });
    assert.strictEqual(prepared.ok, false, JSON.stringify(prepared));
    assert(typeof prepared.error === 'string' && prepared.error.length > 0,
      'the primary construction error was masked or dropped');
    assert(!/EPERM/.test(prepared.error), 'the rollback\'s own OS error text leaked into the primary error');
    assert(typeof prepared.rollbackError === 'string' && prepared.rollbackError.length > 0,
      `a forced rollback failure was not reported: ${JSON.stringify(prepared)}`);
  } finally {
    restore();
  }
});

// ── T9 / C10 ─────────────────────────────────────────────────────────────────────────────────
function runAuthorIssue(built, launched, extraSeams = {}) {
  const out = []; const err = []; const proofs = [];
  const seams = {
    auditAuthorTree: () => ({ ok: true }),
    launchAuthor: () => launched,
    proveTests: () => {
      proofs.push(true);
      return { ok: true, attempt: 1, probe: path.join(os.tmpdir(), 'fixture-probe'), container: null,
        evidence: 'gate exit 0', agentOutput: '' };
    },
    ...extraSeams,
  };
  const result = AUTHOR.authorIssue(built, path.join(ROOT, 'run.config.fixture.json'), {
    out: (m) => out.push(String(m)), err: (m) => err.push(String(m)),
  }, seams);
  return { result, out: out.join('\n'), err: err.join('\n'), proofs: proofs.length };
}

test('T9 C10 authorIssue reports a cleanup failure explicitly, stays truthful for a nonzero or incomplete provider outcome regardless of cleanup, and blocks proof/freeze only when the provider itself succeeded', () => {
  {
    const built = writeBuilt();
    const seen = runAuthorIssue(built, { status: 0, stdout: CODEX_TERMINAL, stderr: '', containmentCleanup: { ok: true } });
    assert.strictEqual(seen.result.ok, true, JSON.stringify(seen.result));
    assert.strictEqual(seen.result.outcome, 'proven', JSON.stringify(seen.result));
    assert.strictEqual(seen.proofs, 1, 'a successful cleanup after a successful provider did not reach proof');
  }
  {
    const built = writeBuilt();
    const seen = runAuthorIssue(built, { status: 0, stdout: CODEX_TERMINAL, stderr: '',
      containmentCleanup: { ok: false, error: 'author-containment dispose failed for: fallback[0]' } });
    assert.strictEqual(seen.result.ok, false, JSON.stringify(seen.result));
    assert.notStrictEqual(seen.result.outcome, 'proven', JSON.stringify(seen.result));
    assert(/cleanup/i.test(`${seen.result.outcome || ''} ${seen.result.kind || ''}`), JSON.stringify(seen.result));
    assert.strictEqual(seen.result.agentStatus, 0,
      'the distinct cleanup-failure outcome did not carry the original (successful) provider status');
    assert.strictEqual(seen.proofs, 0, 'a failed cleanup after a successful provider still reached the green proof');
    assert(!/freeze\.js commit/.test(seen.out), 'a freeze command was printed despite a failed cleanup');
    assert(/cleanup/i.test(seen.err), 'the cleanup failure was not reported explicitly');
  }
  {
    const built = writeBuilt();
    const seen = runAuthorIssue(built, { status: 9, stdout: '', stderr: 'codex died',
      containmentCleanup: { ok: false, error: 'author-containment dispose failed for: shim' } });
    assert.strictEqual(seen.result.outcome, 'agent-failed', JSON.stringify(seen.result));
    assert.strictEqual(seen.proofs, 0);
  }
  {
    const built = writeBuilt();
    const seen = runAuthorIssue(built, { status: 0, stdout: CODEX_NO_TERMINAL, stderr: '',
      containmentCleanup: { ok: false, error: 'author-containment dispose failed for: shim' } });
    assert.strictEqual(seen.result.outcome, 'agent-incomplete', JSON.stringify(seen.result));
    assert.strictEqual(seen.proofs, 0);
  }
  {
    const built = writeBuilt({ provider: 'claude', testAuthorProvider: 'claude', testProbeProvider: 'claude' });
    const seen = runAuthorIssue(built, { status: 0, stdout: 'Wrote the suite and stopped.\n', stderr: '' });
    assert.strictEqual(seen.result.ok, true, JSON.stringify(seen.result));
    assert.strictEqual(seen.proofs, 1, 'a Claude session with no containmentCleanup field was blocked by the new gating');
  }
});

// ── T11 / C1 ─────────────────────────────────────────────────────────────────────────────────
test('T11 C1 containmentDir(issueId) hands out a fresh, already-created directory under one shared parent every call, even for the same issue id', () => {
  const CONTAIN = containment();
  const first = CONTAIN.containmentDir(ISSUE);
  const second = CONTAIN.containmentDir(ISSUE);
  assert.notStrictEqual(path.resolve(first), path.resolve(second),
    'containmentDir returned the same directory twice for one issue id, which cannot support isolated per-launch disposal');
  assert.strictEqual(path.dirname(path.resolve(first)), path.dirname(path.resolve(second)),
    'containmentDir\'s two results do not share one canonical parent, which safe-root validation depends on');
  assert(fs.existsSync(first) && fs.existsSync(second));
  fs.rmSync(first, { recursive: true, force: true });
  fs.rmSync(second, { recursive: true, force: true });
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
