// Frozen acceptance test — repo-7nc: complete acceptance-author containment on current main.
// This is the RED half. `guard.js` beside it carries the checks that are already GREEN at the
// fork point (the unchanged Codex/Claude launch behaviour, the current author-containment env
// contract, the current authorIssue outcomes with no cleanup evidence, and the batch worker's
// existing invalid-outcome envelope) and must stay green; between them every criterion below is
// covered in BOTH directions.
//
// WHY THIS SUITE EXISTS SEPARATELY FROM repo-djf.40/.43/.44. Those three suites fix the
// containment OWNERSHIP + DISPOSAL + CONSTRUCTION-ROLLBACK contract on
// `runner/author-containment.js` and its `scripts/author-tests.js` wrapper. repo-7nc CONSOLIDATES
// that work onto current main and closes the reporting gap the design calls out: unsuccessful
// provider outcomes (`authorIssue`) and the batch worker's terminal exception envelope
// (`scripts/prepare-batch-worker.js`) discard the simultaneous cleanup-failure evidence. The
// discriminating weight of this suite is therefore at the PUBLIC CONSUMER BOUNDARY — authorIssue's
// structured result and the real worker's serialized envelope — which the reference containment
// implementation (repo-djf.40) does NOT report, exactly as criterion 5 requires: "The reporting
// matrix must discriminate against the reference containment implementation itself, not fail only
// because current main lacks its ownership APIs."
//
// CRITERION PAIRING — every check below also names its own criterion (C1..C6) in its label.
//
//   C1  Each Codex author launch owns fresh containment roots recorded in a host-owned handle
//       with per-launch ownership evidence; disposal removes only recorded, validated roots, is
//       idempotent, and leaves foreign roots and substituted symlinks/reparse points untouched.
//                                                                       -> T1
//   C2  Every created candidate is registered before ownership initialization can fail; a false
//       self-test retains the candidate and permits fallback, a thrown/marker/shim fault triggers
//       exact-root rollback, and a refused rollback fails preparation with the primary error
//       preserved plus additive bounded role-only rollback evidence and no handle.   -> T2
//   C3  Containment stays usable through the whole Codex invocation and is disposed exactly once;
//       provider result/error is preserved with cleanup evidence added additively; and exception
//       evidence survives the PUBLIC CONSUMER BOUNDARY — authorIssue preserves the thrown primary
//       exception while reporting failed cleanup, and the batch worker's terminal exception
//       envelope keeps its invalid outcome + primary message with additive cleanup evidence.
//                                                                       -> T3, T4, T5
//   C4  Failed cleanup is explicit and additive for provider failure, canonical usage-limit,
//       incomplete completion and successful completion; primary outcomes / statuses / usage-limit
//       reset identity stay authoritative; a completed-provider cleanup failure is a distinct
//       outcome that starts no proof and prints no freeze command.      -> T6, T7
//   C5  Cleanup/rollback diagnostics obey the bounded role-only disclosure contract (no host path,
//       nonce, OS error text, credentials or provider output); the matrix discriminates against
//       the reference containment implementation itself; and a batch-envelope fixture exercises
//       exception serialization through the real worker consumer.       -> T5, T6, T8
//   C6  The consolidated candidate appends a change-log entry and keeps the unchanged repo-djf.40,
//       repo-djf.43 and repo-djf.44 behavioural suites passing on the same candidate tree. -> T9
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE FROZEN INTERFACE. repo-7nc adds no new export name of its own: it consolidates the exact
// `runner/author-containment.js` surface repo-djf.40 fixed and repo-djf.43/.44 extended
// (`OWNERSHIP_MARKER_NAME`; `prepare(dir, { issueId, fallbackParents, selfTest })` returning
// `{ ok, dir, names, handle }` or `{ ok:false, error, rollbackError, handle:null }` with
// `handle = { issueId, nonce, shimRoot, fallbackRoots }`; `dispose(handle, { shimParent,
// fallbackParents })`), plus `scripts/author-tests.js`'s `launchAuthor` attaching a bounded
// `containmentCleanup` and `authorIssue` reporting it. Two consumer-boundary behaviours this
// suite fixes concretely, because the issue names behaviour and not a field and a frozen test
// cannot assert behaviour without naming the thing that behaves (SPEC DEFECT 1):
//
//   * authorIssue's structured result carries the launched result's `containmentCleanup`
//     ADDITIVELY (never replacing the truthful primary outcome/status/usage-limit identity), and
//     when the provider itself completed successfully but cleanup failed it returns ONE distinct
//     cleanup-failure outcome (not `proven`) carrying the original `agentStatus`.
//   * the batch worker's `execute(job, seams)` (the real consumer `scripts/prepare-batch-worker.js`
//     `main` serializes) turns a thrown authorIssue/launch exception into its EXISTING terminal
//     envelope `{ ok:false, outcome:'invalid', error:<primary message> }` with an additive bounded
//     `containmentCleanup` diagnostic — and does NOT serialize the raw exception cause into any new
//     public field (criterion 3: "in-process cause preservation and durable cleanup evidence are
//     separate requirements").
//
// An implementation satisfying the CONTRACT is free to pick different internal names as long as
// the observable exports/behaviour this suite requires exist.
//
// SPEC DEFECTS, REPORTED NOT PAPERED OVER (see the STOP AND REPORT summary):
//   1. The issue names no module/function surface for the containment lifecycle; this suite reuses
//      the surface repo-djf.40/.43/.44 already froze and fixes the two consumer-boundary field
//      names above so the additive contract is checkable.
//   2. Criterion 6 says the behavioural suites "pass on the candidate", which is a property of the
//      finished implementation, not of the fork point; T9 asserts it by RE-RUNNING those frozen
//      suites against this same tree (as repo-djf.43 T8 / repo-djf.44 T5 already do), so it is red
//      now (no implementation) and reachable by a probe. "The authorized publication profile
//      passes" is a pipeline-stage fact no acceptance suite in this project can honestly assert,
//      and is left to that stage; guard.js G5 pins only the static presence of the named suites.
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const CONTAINMENT_FILE = path.join(ROOT, 'runner', 'author-containment.js');
const AUTHOR = require(path.join(ROOT, 'scripts', 'author-tests.js'));
const WORKER = require(path.join(ROOT, 'scripts', 'prepare-batch-worker.js'));

// Deterministic and key-free, exactly like the frozen repo-djf.40/.43/.44 suites this one
// consolidates: no provider key, no Beads, no live provider, no network, no container engine, and
// no execution of any generated shim file (the hardened verifier's restricted tmpfs).
for (const name of ['CODEX_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN',
  'PIPELINE_BD_CMD', 'BD_ARGS_LOG', 'BD_STUB_OUT', 'BD_STUB_EXIT',
  'PIPELINE_TEST_AUTHOR_CMD', 'PIPELINE_TEST_PROBE_CMD']) delete process.env[name];

const ISSUE = 'repo-7nc';

const tests = [];
function test(name, body) { tests.push({ name, body }); }

const temps = [];
function tmp(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `repo-7nc-${tag}-`));
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

// ---- fixtures --------------------------------------------------------------------------------

const CODEX_TERMINAL = `${JSON.stringify({ type: 'thread.started', thread_id: 'th-7nc' })}\n`
  + `${JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Wrote the suite.' } })}\n`
  + `${JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } })}\n`;
const CODEX_NO_TERMINAL = `${JSON.stringify({ type: 'thread.started', thread_id: 'th-7nc' })}\n`
  + `${JSON.stringify({ type: 'item.started', item: { type: 'agent_message' } })}\n`;
// The one canonical usage-limit reset identity this suite pins: a strict ISO instant so
// `AGENT.usageLimitFromLaunch` accepts it and its `resetAt` must round-trip byte-identical.
const USAGE_LIMIT_RESET = '2026-09-18T00:00:00.000Z';
const CODEX_USAGE_LIMIT = `${JSON.stringify({ type: 'error',
  error: { type: 'usage_limit_exceeded', message: 'usage limit reached', resets_at: USAGE_LIMIT_RESET } })}\n`;

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

// authorIssue driven entirely through seams — no git, no provider, no Beads. `launched` is what
// the (seamed) launchAuthor returns, OR a function that throws to model a launch/cleanup fault.
function runAuthorIssue(built, launched, extraSeams = {}) {
  const out = []; const err = []; const proofs = [];
  const seams = {
    auditAuthorTree: () => ({ ok: true }),
    launchAuthor: typeof launched === 'function' ? launched : () => launched,
    proveTests: () => {
      proofs.push(true);
      return { ok: true, attempt: 1, probe: null, container: null, evidence: 'gate exit 0', agentOutput: '' };
    },
    ...extraSeams,
  };
  let result = null;
  let threw = null;
  try {
    result = AUTHOR.authorIssue(built, path.join(ROOT, 'run.config.fixture.json'), {
      out: (m) => out.push(String(m)), err: (m) => err.push(String(m)),
    }, seams);
  } catch (error) { threw = error; }
  return { result, threw, out: out.join('\n'), err: err.join('\n'), proofs: proofs.length };
}

function firstPathEntry(env) {
  const keys = Object.keys(env).filter((k) => k.toLowerCase() === 'path');
  assert.deepStrictEqual(keys, ['PATH'], `env must carry exactly one path key spelled PATH, got ${JSON.stringify(keys)}`);
  return String(env.PATH).split(path.delimiter)[0];
}

function forceRmSyncFailure() {
  const real = fs.rmSync;
  fs.rmSync = () => { throw Object.assign(new Error('repo-7nc fixture: EPERM, permission denied'), { code: 'EPERM' }); };
  return () => { fs.rmSync = real; };
}

// A cleanup/rollback diagnostic is bounded and role-only: present, short, and free of host paths,
// the ownership nonce, OS error text, credentials, and copied provider output.
function assertBoundedRoleOnly(textValue, label, forbidden = []) {
  assert(typeof textValue === 'string' && textValue.length > 0, `${label} is missing or empty: ${JSON.stringify(textValue)}`);
  assert(textValue.length <= 200, `${label} is not bounded: ${textValue.length} chars`);
  assert(!/EPERM|EACCES|ENOENT|EIO|EEXIST|repo-7nc fixture/i.test(textValue),
    `${label} leaked OS/fixture error text: ${textValue}`);
  assert(!/Wrote the suite|usage limit reached|SECRET/i.test(textValue),
    `${label} leaked provider output or an internal secret: ${textValue}`);
  for (const bad of forbidden) {
    if (bad) assert(!textValue.includes(bad), `${label} disclosed a forbidden token (host path/nonce): ${textValue}`);
  }
}

// The cleanup evidence a repaired authorIssue result / worker envelope must carry, additively.
function cleanupEvidence(obj) {
  return obj && typeof obj === 'object' && obj.containmentCleanup && typeof obj.containmentCleanup === 'object'
    ? obj.containmentCleanup : null;
}

function withinFixture(root, candidate) {
  if (typeof candidate !== 'string') return false;
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

// Real production preparation, with default host parents redirected into owned fixtures.
// Simulate mode-stripping on the primary filesystem, never replace prepare/dispose answers.
// No generated executable runs; the existing provider-transport seam ends the launch.
function withContainmentHost(tag, stripPrimaryExecute, body) {
  const primary = tmp(`${tag}-tmp`), home = tmp(`${tag}-home`);
  const original = { tmpdir: os.tmpdir, homedir: os.homedir,
    statSync: fs.statSync, lstatSync: fs.lstatSync, mkdtempSync: fs.mkdtempSync,
    mkdirSync: fs.mkdirSync, writeFileSync: fs.writeFileSync, rmSync: fs.rmSync,
    platform: Object.getOwnPropertyDescriptor(process, 'platform'), state: process.env.PIPELINE_STATE_DIR };
  const observed = { primary, home, created: [], strippedReads: 0 };
  const owned = p => withinFixture(primary, p) || withinFixture(home, p);
  const demandOwned = p => assert(owned(p), 'fixture refused an out-of-scope filesystem mutation');
  const modeView = (real, p, args) => {
    const stat = real.call(fs, p, ...args);
    if (!owned(p) || !stat.isFile()) return stat;
    const view = Object.create(stat);
    const stripped = stripPrimaryExecute && withinFixture(primary, p);
    if (stripped) observed.strippedReads += 1;
    Object.defineProperty(view, 'mode', {
      value: stripped ? (stat.mode & ~0o111) : (stat.mode | 0o100), enumerable: true,
    });
    return view;
  };
  try {
    os.tmpdir = () => primary; os.homedir = () => home;
    delete process.env.PIPELINE_STATE_DIR;
    Object.defineProperty(process, 'platform', { ...original.platform, value: 'linux' });
    fs.statSync = (p, ...args) => modeView(original.statSync, p, args);
    fs.lstatSync = (p, ...args) => modeView(original.lstatSync, p, args);
    fs.mkdirSync = (p, ...args) => { demandOwned(p); return original.mkdirSync(p, ...args); };
    fs.writeFileSync = (p, ...args) => { demandOwned(p); return original.writeFileSync(p, ...args); };
    fs.rmSync = (p, ...args) => { demandOwned(p); return original.rmSync(p, ...args); };
    fs.mkdtempSync = (prefix, ...args) => {
      demandOwned(prefix);
      const created = original.mkdtempSync(prefix, ...args);
      observed.created.push(created); return created;
    };
    return body(observed);
  } finally {
    os.tmpdir = original.tmpdir; os.homedir = original.homedir;
    for (const name of ['statSync', 'lstatSync', 'mkdtempSync', 'mkdirSync', 'writeFileSync', 'rmSync'])
      fs[name] = original[name];
    Object.defineProperty(process, 'platform', original.platform);
    if (original.state === undefined) delete process.env.PIPELINE_STATE_DIR;
    else process.env.PIPELINE_STATE_DIR = original.state;
  }
}

// ── T1 / C1 ────────────────────────────────────────────────────────────────────────────────
test('T1 C1 a Codex launch owns fresh per-launch roots recorded in a host-owned handle, and disposal removes only recorded validated roots — idempotently, leaving foreign roots and substituted symlinks untouched', () => {
  const CONTAIN = containment();
  assert.strictEqual(typeof CONTAIN.dispose, 'function', 'runner/author-containment.js does not export dispose()');
  assert(typeof CONTAIN.OWNERSHIP_MARKER_NAME === 'string' && CONTAIN.OWNERSHIP_MARKER_NAME.length > 0,
    'runner/author-containment.js does not export a non-empty OWNERSHIP_MARKER_NAME');

  // Fresh roots per launch under one shared parent, even for one issue id — the property isolated
  // per-launch disposal depends on, and the one current main's stable containmentDir lacks.
  const a = CONTAIN.containmentDir(ISSUE);
  const b = CONTAIN.containmentDir(ISSUE);
  assert.notStrictEqual(path.resolve(a), path.resolve(b), 'containmentDir handed out the same root twice for one issue');
  assert.strictEqual(path.dirname(path.resolve(a)), path.dirname(path.resolve(b)),
    'the two fresh roots do not share one canonical parent, which safe-root validation depends on');

  const shimParent = tmp('t1-shim-parent');
  const fbParents = [tmp('t1-fb-a'), tmp('t1-fb-b')];
  const dir = path.join(shimParent, 'shim');
  const prepared = CONTAIN.prepare(dir, { issueId: ISSUE, fallbackParents: fbParents, selfTest: () => true });
  assert(prepared.ok, JSON.stringify(prepared));
  assert(prepared.handle && typeof prepared.handle.nonce === 'string' && prepared.handle.nonce.length > 0,
    `prepare() returned no host-owned handle with per-launch ownership evidence: ${JSON.stringify(prepared)}`);
  assert.strictEqual(prepared.handle.shimRoot, path.resolve(dir));
  const nonce = fs.readFileSync(path.join(dir, CONTAIN.OWNERSHIP_MARKER_NAME), 'utf8').trim();
  assert.strictEqual(nonce, prepared.handle.nonce, 'the owned root carries no marker matching the handle nonce');

  // A foreign directory that merely matches the fallback shape but carries no matching marker is
  // never removed, even while its sibling owned root is.
  const foreign = path.join(fbParents[0], 'author-containment-fallback-lookalike');
  fs.mkdirSync(foreign, { recursive: true });
  fs.writeFileSync(path.join(foreign, 'sentinel'), 'not ours');
  const withForeign = { ...prepared.handle, fallbackRoots: [foreign] };
  const refused = CONTAIN.dispose(withForeign, { shimParent, fallbackParents: fbParents });
  assert.strictEqual(refused.ok, false, 'dispose() removed a fallback-shaped foreign directory with no matching marker');
  assert(fs.existsSync(path.join(foreign, 'sentinel')), 'dispose() deleted a foreign directory it never marked as owned');

  const ok = CONTAIN.dispose(prepared.handle, { shimParent, fallbackParents: fbParents });
  assert.deepStrictEqual(ok, { ok: true }, JSON.stringify(ok));
  assert.strictEqual(fs.existsSync(dir), false, 'the owned shim root was not disposed');
  // Idempotent: a repeat against the already-removed, correctly-owned root is still success.
  assert.deepStrictEqual(CONTAIN.dispose(prepared.handle, { shimParent, fallbackParents: fbParents }), { ok: true });
});

// ── T2 / C2 ────────────────────────────────────────────────────────────────────────────────
test('T2 C2 every candidate is registered before ownership init can fail: a false self-test retains the candidate and permits fallback, a thrown fault triggers exact-root rollback and recovery, and a refused rollback fails preparation with the primary error preserved plus additive bounded role-only rollback evidence', () => {
  const CONTAIN = containment();

  // (a) A self-test returning false denotes an unusable filesystem: the candidate is RETAINED for
  // eventual disposal and fallback is permitted (repo-djf.40's frozen fallback lifecycle).
  {
    const shimParent = tmp('t2a-shim-parent');
    const fbParents = [tmp('t2a-fb-a'), tmp('t2a-fb-b')];
    const dir = path.join(shimParent, 'shim');
    const selfTest = (candidate) => candidate.startsWith(path.resolve(fbParents[1]));
    const prepared = CONTAIN.prepare(dir, { issueId: ISSUE, fallbackParents: fbParents, selfTest });
    assert(prepared.ok, JSON.stringify(prepared));
    assert.strictEqual(prepared.handle.fallbackRoots.length, 2, JSON.stringify(prepared.handle));
    assert(fs.existsSync(dir), 'the unusable shim root was deleted instead of retained for disposal');
    assert(fs.existsSync(prepared.handle.fallbackRoots[0]), 'the false-self-test candidate was deleted instead of retained');
    assert(prepared.dir.startsWith(path.resolve(fbParents[1])), 'fallback was not permitted after a false self-test');
  }

  // (b) A THROWN self-test at a candidate boundary is caught, that exact root is rolled back, and
  // construction recovers through the next candidate — never escaping prepare().
  {
    const shimParent = tmp('t2b-shim-parent');
    const fbParents = [tmp('t2b-fb-a'), tmp('t2b-fb-b')];
    const dir = path.join(shimParent, 'shim');
    let idx = -1;
    let thrownCandidate = null;
    const selfTest = (candidate) => {
      idx += 1;
      if (idx === 0) return false;
      if (idx === 1) { thrownCandidate = candidate; throw new Error('repo-7nc fixture: self-test blew up'); }
      return true;
    };
    let threw = null; let prepared = null;
    try { prepared = CONTAIN.prepare(dir, { issueId: ISSUE, fallbackParents: fbParents, selfTest }); }
    catch (e) { threw = e; }
    assert(!threw, `prepare() propagated a thrown self-test instead of treating it as a failed candidate: ${threw && threw.message}`);
    assert(prepared.ok, JSON.stringify(prepared));
    assert(thrownCandidate && !fs.existsSync(thrownCandidate), 'the thrown candidate was not rolled back to its exact root');
  }

  // (c) A REFUSED rollback (marker mismatch) fails the whole preparation even with a later usable
  // fallback: no handle, the primary error preserved, and additive bounded role-only rollback text.
  {
    const shimParent = tmp('t2c-shim-parent');
    const fbParents = [tmp('t2c-fb-a'), tmp('t2c-fb-b')];
    const dir = path.join(shimParent, 'shim');
    let idx = -1;
    let failingCandidate = null;
    const selfTest = (candidate) => { idx += 1; if (idx === 1) failingCandidate = candidate; return true; };
    const real = fs.writeFileSync;
    fs.writeFileSync = (p, ...rest) => {
      if (idx === 0 && path.basename(p) === CONTAIN.OWNERSHIP_MARKER_NAME) {
        throw Object.assign(new Error('repo-7nc fixture: EIO, write failed'), { code: 'EIO' });
      }
      if (idx === 1 && path.basename(p) === 'bd') {
        real(path.join(path.dirname(p), CONTAIN.OWNERSHIP_MARKER_NAME), 'someone-elses-nonce');
        throw Object.assign(new Error('repo-7nc fixture: EIO, write failed'), { code: 'EIO' });
      }
      return real(p, ...rest);
    };
    let prepared;
    try { prepared = CONTAIN.prepare(dir, { issueId: ISSUE, fallbackParents: fbParents, selfTest }); }
    finally { fs.writeFileSync = real; }

    assert.strictEqual(prepared.ok, false, JSON.stringify(prepared));
    assert.strictEqual(prepared.handle, null, 'a refused rollback still returned a usable handle');
    assert.strictEqual(idx, 1, 'construction proceeded past the candidate whose rollback was refused');
    assert.strictEqual(fs.existsSync(dir), false, 'the earlier, cleanly-rolled-back shim root was not removed');
    const forbidden = [shimParent, ...fbParents, dir, failingCandidate];
    assertBoundedRoleOnly(prepared.error, 'the primary preparation error', forbidden);
    assertBoundedRoleOnly(prepared.rollbackError, 'the additive rollback error', forbidden);
  }
});

// ── T3 / C3 ────────────────────────────────────────────────────────────────────────────────
test('T3 C3 a Codex launchAuthor keeps its shim usable through the whole provider call and disposes it exactly once after settle OR throw, preserving the provider result/error while adding cleanup evidence additively', () => {
  const CONTAIN = containment();

  // Success: the shim is present during the call, the result keeps its status/stdout, cleanup is
  // reported additively, and the shim is gone afterward.
  {
    const built = writeBuilt();
    let capturedDir = null;
    const run = (command, args, opts) => {
      capturedDir = firstPathEntry(opts.env);
      for (const n of ['bd', 'bd.cmd', CONTAIN.OWNERSHIP_MARKER_NAME]) {
        assert(fs.existsSync(path.join(capturedDir, n)), `the shim root is missing ${n} during the provider call`);
      }
      return { status: 0, stdout: CODEX_TERMINAL, stderr: '' };
    };
    const result = AUTHOR.launchAuthor(built, 'fixture-model', run);
    assert(capturedDir, 'the run seam was never reached');
    assert.strictEqual(result.status, 0, 'cleanup altered the provider exit status');
    assert.strictEqual(result.stdout, CODEX_TERMINAL, 'cleanup altered the provider stdout');
    assert(result.containmentCleanup && result.containmentCleanup.ok === true,
      `launchAuthor did not report successful cleanup additively: ${JSON.stringify(result.containmentCleanup)}`);
    assert.strictEqual(fs.existsSync(capturedDir), false, 'the shim was not disposed after the provider settled');
  }

  // A thrown launch error is rethrown with its original message and carries bounded cleanup
  // metadata; a frozen/non-extensible error keeps its original message and primary cause.
  {
    const built = writeBuilt();
    const frozen = Object.freeze(new Error('repo-7nc launch failure: spawn ENOENT'));
    let threw = null;
    try { AUTHOR.launchAuthor(built, 'fixture-model', () => { throw frozen; }); }
    catch (e) { threw = e; }
    assert(threw, 'launchAuthor swallowed a thrown run() error');
    assert(/repo-7nc launch failure: spawn ENOENT/.test(threw.message), `the propagated error lost its message: ${threw.message}`);
    const primary = (threw.errors && threw.errors[0]) || threw.cause || threw;
    assert.strictEqual(primary, frozen, 'the original frozen launch error is no longer reachable as the primary cause');
    assert(threw.containmentCleanup && typeof threw.containmentCleanup.ok === 'boolean',
      `the thrown error carries no bounded cleanup metadata: ${JSON.stringify(threw.containmentCleanup)}`);
  }
});

// ── T4 / C3 ────────────────────────────────────────────────────────────────────────────────
test('T4 C3 authorIssue preserves the thrown primary exception AND reports the failed cleanup at the public consumer boundary — it does not silently succeed or drop the cleanup diagnostic', () => {
  const built = writeBuilt();
  const launchError = Object.assign(new Error('repo-7nc launch failure at the consumer boundary'), {
    containmentCleanup: { ok: false, error: 'author-containment dispose failed for: fallback[0]' },
  });
  const seen = runAuthorIssue(built, () => { throw launchError; });

  // The primary exception must survive: authorIssue may rethrow it (message preserved) or return a
  // result that carries it, but it must NOT report a successful, proven outcome.
  const surfacedByThrow = !!(seen.threw && /repo-7nc launch failure at the consumer boundary/.test(String(seen.threw.message)));
  const surfacedByResult = !!(seen.result && seen.result.ok === false
    && /repo-7nc launch failure at the consumer boundary/.test(`${seen.result.error || ''} ${seen.result.kind || ''}`));
  assert(surfacedByThrow || surfacedByResult,
    `authorIssue neither rethrew nor reported the primary launch exception: threw=${seen.threw && seen.threw.message}, result=${JSON.stringify(seen.result)}`);
  assert.notStrictEqual(seen.result && seen.result.outcome, 'proven', 'authorIssue reported a proven outcome despite a thrown launch failure');
  assert.strictEqual(seen.proofs, 0, 'authorIssue reached the green proof despite a thrown launch failure');

  // The failed cleanup must be REPORTED (not merely attached to an internal error object) at this
  // boundary — an explicit, bounded, role-only diagnostic on stderr and/or the returned result.
  const cleanupReportedOnErr = /cleanup/i.test(seen.err) && /fallback\[0\]|shim/i.test(seen.err);
  const cleanupOnResult = cleanupEvidence(seen.result);
  assert(cleanupReportedOnErr || (cleanupOnResult && cleanupOnResult.ok === false),
    `the failed cleanup was not reported at the public consumer boundary: err=${JSON.stringify(seen.err)} result=${JSON.stringify(seen.result)}`);
  if (cleanupReportedOnErr) {
    const line = seen.err.split('\n').find((l) => /cleanup/i.test(l)) || seen.err;
    assertBoundedRoleOnly(line.trim(), 'the authorIssue cleanup diagnostic', [built.folder.dir]);
  }
});

// ── T5 / C3,C5 ─────────────────────────────────────────────────────────────────────────────
test('T5 C3,C5 the batch worker\'s terminal exception envelope keeps its invalid outcome and primary error message with additive bounded cleanup evidence, exercised through the real worker consumer, and never serializes the raw exception cause', () => {
  const worktree = tmp('t5-worktree');
  const built = writeBuilt({}, worktree);
  const secretCause = new Error('SECRET-CAUSE-TOKEN-must-not-serialize');
  const thrown = Object.assign(new Error('repo-7nc worker primary launch failure'), {
    cause: secretCause,
    containmentCleanup: { ok: false, error: 'author-containment dispose failed for: shim' },
  });
  const job = {
    action: 'author-proof', configPath: path.join(ROOT, 'run.config.fixture.json'), built,
  };
  const seams = {
    auditAuthorTree: () => ({ ok: true }),
    launchAuthor: () => { throw thrown; },
    proveTests: () => ({ ok: true, attempt: 1, probe: null }),
    runSync: () => ({ status: 0, stdout: '', stderr: '' }),
  };

  // The real consumer: `execute` is what `scripts/prepare-batch-worker.js` `main` serializes to
  // stdout. It must SERIALIZE the exception into the terminal envelope rather than throw.
  let envelope = null;
  let escaped = null;
  try { envelope = WORKER.execute(job, seams); }
  catch (e) { escaped = e; }
  assert(!escaped, `execute() let the launch exception escape the worker consumer unserialized: ${escaped && escaped.message}`);
  assert(envelope && envelope.ok === false, `the terminal envelope is not a failure: ${JSON.stringify(envelope)}`);
  assert.strictEqual(envelope.outcome, 'invalid', 'the terminal exception envelope lost its existing invalid outcome');
  assert(/repo-7nc worker primary launch failure/.test(String(envelope.error || '')),
    `the terminal envelope lost the primary error message: ${JSON.stringify(envelope.error)}`);

  // Additive bounded cleanup evidence on the serialized envelope.
  const serialized = JSON.stringify(envelope);
  const cleanup = cleanupEvidence(envelope);
  const cleanupText = cleanup && cleanup.error
    ? cleanup.error
    : (/cleanup/i.test(serialized) ? (envelope.cleanup || envelope.containmentDiagnostic || '') : '');
  assert(/cleanup/i.test(serialized) && /shim/i.test(serialized),
    `the terminal envelope carries no additive cleanup diagnostic: ${serialized}`);
  if (cleanupText) assertBoundedRoleOnly(cleanupText, 'the worker cleanup diagnostic', [worktree]);

  // In-process cause preservation and durable cleanup evidence are SEPARATE: the raw exception
  // cause must not be serialized into any new public field of the envelope.
  assert(!serialized.includes('SECRET-CAUSE-TOKEN'),
    `the worker serialized the raw exception cause into a public field: ${serialized}`);
  // The envelope survives a JSON round-trip unchanged (it is consumed through a pipe).
  const roundTripped = JSON.parse(serialized);
  assert.strictEqual(roundTripped.outcome, 'invalid');
  assert(/repo-7nc worker primary launch failure/.test(String(roundTripped.error || '')));
});

// ── T6 / C4,C5 ─────────────────────────────────────────────────────────────────────────────
test('T6 C4,C5 authorIssue keeps a failing provider outcome authoritative while carrying additive cleanup-failure evidence — provider failure, canonical usage-limit (reset identity intact), and incomplete completion all start no proof and print no freeze', () => {
  const cases = [
    ['provider failure', { status: 9, stdout: '', stderr: 'codex died',
      containmentCleanup: { ok: false, error: 'author-containment dispose failed for: shim' } }, 'agent-failed'],
    ['incomplete completion', { status: 0, stdout: CODEX_NO_TERMINAL, stderr: '',
      containmentCleanup: { ok: false, error: 'author-containment dispose failed for: shim' } }, 'agent-incomplete'],
    ['canonical usage-limit', { status: 1, stdout: CODEX_USAGE_LIMIT, stderr: '',
      containmentCleanup: { ok: false, error: 'author-containment dispose failed for: fallback[0]' } }, 'usage-limit'],
  ];
  for (const [label, launched, wantOutcome] of cases) {
    const built = writeBuilt();
    const seen = runAuthorIssue(built, launched);
    assert.strictEqual(seen.result && seen.result.outcome, wantOutcome,
      `${label}: the primary outcome was not authoritative: ${JSON.stringify(seen.result)}`);
    assert.strictEqual(seen.proofs, 0, `${label}: a failing provider outcome still reached the green proof`);
    assert(!/freeze\.js commit/.test(seen.out), `${label}: a freeze command was printed for a failing invocation`);
    const cleanup = cleanupEvidence(seen.result);
    assert(cleanup && cleanup.ok === false,
      `${label}: the simultaneous cleanup failure was discarded rather than carried additively: ${JSON.stringify(seen.result)}`);
    assertBoundedRoleOnly(cleanup.error, `${label}: the additive cleanup evidence`, [built.folder.dir]);
    if (label === 'canonical usage-limit') {
      assert(seen.result.rateLimit && seen.result.rateLimit.resetAt === USAGE_LIMIT_RESET,
        `usage-limit reset identity was not preserved authoritatively alongside cleanup: ${JSON.stringify(seen.result.rateLimit)}`);
    }
  }
});

// ── T7 / C4 ────────────────────────────────────────────────────────────────────────────────
test('T7 C4 a provider that completed successfully but whose cleanup failed returns one distinct cleanup-failure outcome carrying the original successful status, starts no proof, and prints no freeze command', () => {
  const built = writeBuilt();
  const seen = runAuthorIssue(built, { status: 0, stdout: CODEX_TERMINAL, stderr: '',
    containmentCleanup: { ok: false, error: 'author-containment dispose failed for: fallback[0]' } });
  assert.strictEqual(seen.result && seen.result.ok, false, `a failed cleanup after a successful provider was reported ok: ${JSON.stringify(seen.result)}`);
  assert.notStrictEqual(seen.result.outcome, 'proven', 'a failed cleanup still reported the proven outcome');
  assert(/cleanup/i.test(`${seen.result.outcome || ''} ${seen.result.kind || ''}`),
    `the distinct cleanup-failure outcome is not identifiable as such: ${JSON.stringify(seen.result)}`);
  assert.strictEqual(seen.result.agentStatus, 0, 'the distinct cleanup-failure outcome did not carry the original successful provider status');
  assert.strictEqual(seen.proofs, 0, 'a failed cleanup after a successful provider still reached the green proof');
  assert(!/freeze\.js commit/.test(seen.out), 'a freeze command was printed despite a failed cleanup');
  assert(/cleanup/i.test(seen.err), 'the cleanup failure was not reported explicitly on stderr');
});

// ── T8 / C5 ────────────────────────────────────────────────────────────────────────────────
test('T8 C5 an implementation-generated cleanup failure (a real dispose fault under launchAuthor) is reported bounded and role-only — never a host path, the ownership nonce, OS error text, or copied provider output', () => {
  const restore = forceRmSyncFailure();
  try {
    const built = writeBuilt();
    let capturedDir = null;
    let nonce = null;
    const run = (command, args, opts) => {
      capturedDir = firstPathEntry(opts.env);
      try { nonce = fs.readFileSync(path.join(capturedDir, containment().OWNERSHIP_MARKER_NAME), 'utf8').trim(); }
      catch { nonce = null; }
      return { status: 0, stdout: CODEX_TERMINAL, stderr: '' };
    };
    const result = AUTHOR.launchAuthor(built, 'fixture-model', run);
    assert.strictEqual(result.status, 0, 'a forced cleanup failure altered the provider exit status');
    assert.strictEqual(result.stdout, CODEX_TERMINAL, 'a forced cleanup failure altered the provider stdout');
    const cleanup = cleanupEvidence(result);
    assert(cleanup && cleanup.ok === false,
      `a forced cleanup failure was not reported additively: ${JSON.stringify(result.containmentCleanup)}`);
    assertBoundedRoleOnly(cleanup.error, 'the launchAuthor cleanup diagnostic', [capturedDir, nonce]);
  } finally {
    restore();
  }
});

// ── T9 / C6 ────────────────────────────────────────────────────────────────────────────────
test('T9 C6 the consolidated candidate appends a change-log entry for this task and keeps the unchanged repo-djf.40 / repo-djf.43 / repo-djf.44 behavioural suites passing against this same candidate tree', () => {
  const changeLog = path.join(ROOT, 'docs', 'change-log.md');
  assert(fs.existsSync(changeLog), `docs/change-log.md is missing: ${changeLog}`);
  const text = fs.readFileSync(changeLog, 'utf8');
  assert(/repo-7nc/.test(text), 'no change-log entry was appended for repo-7nc');
  assert(/cleanup|containment/i.test(text), 'the change-log does not describe the containment-cleanup consolidation');

  for (const sibling of ['repo-djf.40', 'repo-djf.43', 'repo-djf.44']) {
    const SIBLING_TEST = path.join(ROOT, 'tests', 'acceptance', sibling, 'test.js');
    assert(fs.existsSync(SIBLING_TEST), `sibling behavioural suite is missing: ${SIBLING_TEST}`);
    const r = spawnSync(process.execPath, [SIBLING_TEST], { cwd: ROOT, encoding: 'utf8' });
    assert.strictEqual(r.status, 0,
      `tests/acceptance/${sibling}/test.js did not pass (exit ${JSON.stringify(r.status)}) against this candidate tree — `
      + `the consolidation must keep the existing behavioural suites green.\n`
      + `--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`);
  }
});

test('T10 C1,C2 lookup denial is not absence: disposal reports it, rollback stops fallback, and genuinely absent roots remain idempotent', () => {
  const C = containment();
  const shimParent = tmp('t10-shim'), fbParent = tmp('t10-fallback');
  const dir = path.join(shimParent, 'root');
  const prepared = C.prepare(dir, { issueId: ISSUE, fallbackParents: [fbParent],
    selfTest: candidate => path.resolve(candidate) !== path.resolve(dir) });
  assert(prepared.ok && prepared.handle.fallbackRoots.length === 1, 'both real owned roots must exist');
  const realLstat = fs.lstatSync;
  let deniedReads = 0, disposed;
  try {
    fs.lstatSync = (p, ...args) => {
      if (path.resolve(String(p)) === path.resolve(dir)) {
        deniedReads += 1;
        throw Object.assign(new Error('repo-7nc fixture lookup denied'), { code: 'EACCES' });
      }
      return realLstat(p, ...args);
    };
    disposed = C.dispose(prepared.handle, { shimParent, fallbackParents: [fbParent] });
  } finally { fs.lstatSync = realLstat; }
  assert(deniedReads > 0, 'the lookup-denial fixture was not reached');
  assert.strictEqual(disposed.ok, false, 'an unreadable root was reported already disposed');
  assertBoundedRoleOnly(disposed.error, 'lookup-denial disposal evidence', [dir, shimParent, fbParent]);
  assert(/shim/.test(disposed.error));
  assert(fs.existsSync(dir), 'the denied root was removed');
  assert(!fs.existsSync(prepared.handle.fallbackRoots[0]), 'other owned roots were not attempted');
  assert.deepStrictEqual(C.dispose(prepared.handle, { shimParent, fallbackParents: [fbParent] }), { ok: true });
  assert(!fs.existsSync(dir));
  assert.deepStrictEqual(C.dispose(prepared.handle, { shimParent, fallbackParents: [fbParent] }), { ok: true });

  const rollbackDir = path.join(shimParent, 'rollback-root');
  let denyRollback = false, laterCandidateSeen = false, rollbackReads = 0, refused;
  try {
    fs.lstatSync = (p, ...args) => {
      if (denyRollback && path.resolve(String(p)) === path.resolve(rollbackDir)) {
        rollbackReads += 1;
        throw Object.assign(new Error('repo-7nc fixture rollback lookup denied'), { code: 'EACCES' });
      }
      return realLstat(p, ...args);
    };
    refused = C.prepare(rollbackDir, { issueId: ISSUE, fallbackParents: [fbParent],
      selfTest: candidate => {
        if (path.resolve(candidate) !== path.resolve(rollbackDir)) { laterCandidateSeen = true; return true; }
        denyRollback = true; throw new Error('repo-7nc fixture construction failed');
      },
    });
  } finally { fs.lstatSync = realLstat; }
  assert(rollbackReads > 0, 'construction did not reach denied rollback lookup');
  assert.strictEqual(refused.ok, false); assert.strictEqual(refused.handle, null);
  assert.strictEqual(laterCandidateSeen, false, 'fallback continued after unconfirmed removal');
  assert(fs.existsSync(rollbackDir));
  assertBoundedRoleOnly(refused.rollbackError, 'lookup-denial rollback evidence', [rollbackDir, fbParent]);
});

test('T11 C1,C2 a marker-write fault refuses a foreign marker before initialization confirmation; absent markers permit exact-root rollback', () => {
  const C = containment();
  for (const foreign of [false, true]) {
    const shimParent = tmp(`t11-${foreign}-shim`), fbParent = tmp(`t11-${foreign}-fallback`);
    const dir = path.join(shimParent, 'root'), marker = path.join(dir, C.OWNERSHIP_MARKER_NAME);
    const realWrite = fs.writeFileSync;
    let faultSeen = false, fallbackSeen = false, result;
    try {
      fs.writeFileSync = (p, ...args) => {
        if (!faultSeen && path.resolve(String(p)) === path.resolve(marker)) {
          faultSeen = true;
          if (foreign) realWrite(marker, 'foreign-owner-fixture\n');
          throw Object.assign(new Error('repo-7nc fixture marker write failed'), { code: 'EIO' });
        }
        return realWrite(p, ...args);
      };
      result = C.prepare(dir, { issueId: ISSUE, fallbackParents: [fbParent],
        selfTest: candidate => { if (path.resolve(candidate) !== path.resolve(dir)) fallbackSeen = true; return true; },
      });
    } finally { fs.writeFileSync = realWrite; }
    assert(faultSeen, 'the marker-write boundary was not reached');
    if (foreign) {
      assert.strictEqual(result.ok, false, 'a foreign-marked root was treated as accounted for');
      assert.strictEqual(result.handle, null); assert.strictEqual(fallbackSeen, false);
      assert.strictEqual(fs.readFileSync(marker, 'utf8'), 'foreign-owner-fixture\n');
      assertBoundedRoleOnly(result.rollbackError, 'unconfirmed-marker rollback evidence', [dir, fbParent]);
    } else {
      assert(result.ok && fallbackSeen, 'the ordinary failed-write positive control did not recover');
      assert(!fs.existsSync(dir));
      assert.deepStrictEqual(C.dispose(result.handle, { shimParent, fallbackParents: [fbParent] }), { ok: true });
    }
  }
});

test('T12 C1,C3 real launchAuthor selects and disposes a default fallback when the primary filesystem strips executable bits', () => {
  const C = containment();
  for (const stripPrimary of [false, true]) {
    const built = writeBuilt();
    withContainmentHost(`t12-${stripPrimary}`, stripPrimary, host => {
      let calls = 0, selected = null;
      const result = AUTHOR.launchAuthor(built, 'fixture-model', (command, args, opts) => {
        calls += 1; selected = firstPathEntry(opts.env);
        for (const name of ['bd', 'bd.cmd', C.OWNERSHIP_MARKER_NAME])
          assert(fs.existsSync(path.join(selected, name)), 'selected root incomplete during launch');
        return { status: 0, stdout: CODEX_TERMINAL, stderr: '' };
      });
      assert.strictEqual(calls, 1); assert.strictEqual(result.status, 0); assert.strictEqual(result.stdout, CODEX_TERMINAL);
      if (stripPrimary) {
        assert(host.strippedReads > 0, 'production never observed the unusable filesystem');
        assert(withinFixture(host.home, selected), 'default fallback was not selected');
        assert(host.created.some(p => withinFixture(host.primary, p)), 'primary candidate was not constructed');
      } else assert(withinFixture(host.primary, selected), 'usable primary unnecessarily fell back');
      assert(result.containmentCleanup && result.containmentCleanup.ok === true);
      assert(host.created.length > 0);
      for (const root of host.created) assert(!fs.existsSync(root), 'a production root outlived its launch');
      assert(fs.existsSync(host.primary) && fs.existsSync(host.home), 'a shared parent was removed');
    });
  }
});

test('T13 C2,C5 real launchAuthor preserves real construction and rollback evidence while refusing provider launch', () => {
  const C = containment(), built = writeBuilt();
  withContainmentHost('t13', false, host => {
    const realWrite = fs.writeFileSync, realRm = fs.rmSync;
    const blockedRoots = new Set();
    let markerFaults = 0, rollbackAttempts = 0, providerCalls = 0;
    try {
      fs.writeFileSync = (p, ...args) => {
        if (path.basename(String(p)) === C.OWNERSHIP_MARKER_NAME && withinFixture(host.primary, String(p))) {
          blockedRoots.add(path.resolve(path.dirname(String(p)))); markerFaults += 1;
          throw Object.assign(new Error('repo-7nc fixture initialization failed'), { code: 'EIO' });
        }
        return realWrite(p, ...args);
      };
      fs.rmSync = (p, ...args) => {
        if (blockedRoots.has(path.resolve(String(p)))) {
          rollbackAttempts += 1;
          throw Object.assign(new Error('repo-7nc fixture rollback failed'), { code: 'EPERM' });
        }
        return realRm(p, ...args);
      };
      const expected = C.prepare(path.join(host.primary, 'comparison-root'), { issueId: ISSUE });
      assert.strictEqual(expected.ok, false); assert.strictEqual(expected.handle, null);
      assertBoundedRoleOnly(expected.error, 'real construction evidence', [host.primary]);
      assertBoundedRoleOnly(expected.rollbackError, 'real rollback evidence', [host.primary]);
      let result = null, thrown = null;
      try { result = AUTHOR.launchAuthor(built, 'fixture-model', () => {
        providerCalls += 1; return { status: 0, stdout: CODEX_TERMINAL, stderr: '' };
      }); } catch (error) { thrown = error; }
      assert(markerFaults >= 2 && rollbackAttempts >= 2, 'both real paths did not encounter the faults');
      assert.strictEqual(providerCalls, 0); assert(thrown || (result && result.status !== 0));
      const reported = [result?.stderr, result?.error, result?.rollbackError, result?.containmentCleanup?.error,
        thrown?.message, thrown?.rollbackError, thrown?.containmentCleanup?.error]
        .filter(s => typeof s === 'string' && s.length);
      assert(reported.some(s => s.includes(expected.error)), 'primary preparation evidence was discarded');
      assert(reported.some(s => s.includes(expected.rollbackError)), 'rollback evidence was discarded');
      for (const text of reported) assertBoundedRoleOnly(text, 'construction consumer diagnostic', [host.primary, host.home]);
    } finally { fs.writeFileSync = realWrite; fs.rmSync = realRm; }
  });
});

test('T14 C4 boundary failure stays primary with additive failed cleanup through authorIssue and the real worker', () => {
  for (const cleanupFailed of [false, true]) {
    const built = writeBuilt();
    const cleanup = cleanupFailed ? { ok: false, error: 'author-containment dispose failed for: shim' } : { ok: true };
    const launched = { status: 0, stdout: CODEX_TERMINAL, stderr: '', containmentCleanup: cleanup };
    const boundary = 'fixture post-launch boundary violation';
    let audits = 0;
    const seen = runAuthorIssue(built, launched, {
      auditAuthorTree: () => (++audits === 1 ? { ok: true } : { ok: false, error: boundary }),
    });
    assert.strictEqual(audits, 2); assert.strictEqual(seen.result.outcome, 'boundary-violation');
    assert.strictEqual(seen.result.error, boundary); assert.strictEqual(seen.proofs, 0);
    assert(!/freeze\.js commit/.test(seen.out));
    if (cleanupFailed) {
      assert.deepStrictEqual(cleanupEvidence(seen.result), cleanup); assert(/cleanup/i.test(seen.err));
    } else assert(!/cleanup failed/i.test(seen.err));
    audits = 0; let proofs = 0;
    const envelope = WORKER.execute({ action: 'author-proof', configPath: path.join(ROOT, 'run.config.fixture.json'), built }, {
      auditAuthorTree: () => (++audits === 1 ? { ok: true } : { ok: false, error: boundary }),
      launchAuthor: () => launched, proveTests: () => { proofs += 1; throw new Error('unexpected proof'); },
    });
    assert.strictEqual(envelope.outcome, 'boundary-violation'); assert.strictEqual(envelope.error, boundary);
    assert.strictEqual(proofs, 0);
    if (cleanupFailed) assert.deepStrictEqual(cleanupEvidence(JSON.parse(JSON.stringify(envelope))), cleanup);
  }
});

test('T15 C2,C5 many owned-root failures stay bounded and role-only without stopping disposal or rollback early', () => {
  const C = containment(), shimParent = tmp('t15-shim');
  const fallbackParents = Array.from({ length: 30 }, (_, i) => tmp(`t15-fallback-${i}`));
  const prepared = C.prepare(path.join(shimParent, 'dispose-root'), { issueId: ISSUE, fallbackParents,
    selfTest: candidate => withinFixture(fallbackParents[fallbackParents.length - 1], candidate) });
  assert(prepared.ok && prepared.handle.fallbackRoots.length === fallbackParents.length);
  const roots = new Set([prepared.handle.shimRoot, ...prepared.handle.fallbackRoots].map(p => path.resolve(p)));
  const realRm = fs.rmSync, attempted = new Set();
  let result;
  try {
    fs.rmSync = (p, ...args) => {
      const resolved = path.resolve(String(p));
      if (roots.has(resolved)) { attempted.add(resolved);
        throw Object.assign(new Error('repo-7nc fixture removal failed'), { code: 'EPERM' }); }
      return realRm(p, ...args);
    };
    result = C.dispose(prepared.handle, { shimParent, fallbackParents });
  } finally { fs.rmSync = realRm; }
  assert.strictEqual(result.ok, false); assert.strictEqual(attempted.size, roots.size);
  assertBoundedRoleOnly(result.error, 'many-role disposal evidence', [...roots, prepared.handle.nonce]);
  assert(/shim|fallback\[\d+\]/.test(result.error));
  assert.deepStrictEqual(C.dispose(prepared.handle, { shimParent, fallbackParents }), { ok: true });
  for (const root of roots) assert(!fs.existsSync(root));
  const rollbackRoots = new Set(), rollbackAttempts = new Set();
  let failed;
  try {
    fs.rmSync = (p, ...args) => {
      const resolved = path.resolve(String(p));
      if (rollbackRoots.has(resolved)) { rollbackAttempts.add(resolved);
        throw Object.assign(new Error('repo-7nc fixture rollback failed'), { code: 'EPERM' }); }
      return realRm(p, ...args);
    };
    failed = C.prepare(path.join(shimParent, 'rollback-root'), { issueId: ISSUE, fallbackParents,
      selfTest: candidate => { rollbackRoots.add(path.resolve(candidate)); return false; } });
  } finally { fs.rmSync = realRm; }
  assert.strictEqual(failed.ok, false); assert.strictEqual(failed.handle, null);
  assert.strictEqual(rollbackRoots.size, fallbackParents.length + 1);
  assert.strictEqual(rollbackAttempts.size, rollbackRoots.size);
  assertBoundedRoleOnly(failed.error, 'many-role construction evidence', [...rollbackRoots]);
  assertBoundedRoleOnly(failed.rollbackError, 'many-role rollback evidence', [...rollbackRoots]);
  assert(/shim|fallback\[\d+\]/.test(failed.rollbackError));
});

test('T16 C1 an empty or omitted declared fallback-parent set grants no deletion authority, while the correct parent permits disposal', () => {
  const C = containment();
  for (const omitParents of [false, true]) {
    const shimParent = tmp(`t16-${omitParents}-shim`);
    const fallbackParent = tmp(`t16-${omitParents}-fallback`);
    const shimRoot = path.join(shimParent, 'root');
    const prepared = C.prepare(shimRoot, { issueId: ISSUE, fallbackParents: [fallbackParent],
      selfTest: candidate => path.resolve(candidate) !== path.resolve(shimRoot) });
    assert(prepared.ok && prepared.handle.fallbackRoots.length === 1,
      'the fixture must establish a real marker-matched fallback');
    const fallback = prepared.handle.fallbackRoots[0];
    const marker = path.join(fallback, C.OWNERSHIP_MARKER_NAME);
    const markerBefore = fs.readFileSync(marker, 'utf8');
    const options = omitParents ? { shimParent } : { shimParent, fallbackParents: [] };
    const refused = C.dispose(prepared.handle, options);
    assert.strictEqual(refused.ok, false, 'an undeclared fallback parent authorized deletion');
    assert(fs.existsSync(fallback), 'the refused fallback was removed');
    assert.strictEqual(fs.readFileSync(marker, 'utf8'), markerBefore);
    assertBoundedRoleOnly(refused.error, 'undeclared-parent refusal',
      [shimParent, fallbackParent, fallback, prepared.handle.nonce]);
    assert(/fallback/.test(refused.error), 'the refused fallback role was not reported');
    assert.deepStrictEqual(C.dispose(prepared.handle,
      { shimParent, fallbackParents: [fallbackParent] }), { ok: true });
    assert(!fs.existsSync(fallback), 'correct declared parent did not permit owned disposal');
    assert(fs.existsSync(shimParent) && fs.existsSync(fallbackParent), 'a shared parent was removed');
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
