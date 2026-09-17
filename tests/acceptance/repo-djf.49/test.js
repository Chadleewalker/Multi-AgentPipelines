// Frozen acceptance test — repo-djf.49: retain and safely resume an owned failed green proof.
// `guard.js` beside it carries the checks that are already green at the fork point (existing
// usage-limit parking, the existing six-dimension `resumeProbe` engine, `main()`'s existing
// fail-closed handling of a malformed `buildBrief` result, and the two named unit-test files
// staying green) and must stay green; between them every criterion is covered in both
// directions.
//
// SCOPE. `scripts/prove-tests.js` already retains an owned probe when the model hits a usage
// limit (`kind: 'usage-limit'`, `keepBaseline = true`), and it already resumes such a probe when
// a batch worker later hands back a `retainedProbe` path (`resumeProbe`, wired only through
// `prepare-batch-worker.js`). Neither path exists for the two other ways a green proof can be
// interrupted mid-flight — ordinary attempt exhaustion, and a recoverable non-usage-limit
// exception after preparation — and there is no command a human or a single-issue re-run can
// call on its own to resume a retained proof outside the batch machinery. This suite is scoped
// to exactly that gap.
//
// CRITERION PAIRING — every check below also names its own criterion in its label.
//
//   C1  Ordinary attempt exhaustion and a recoverable non-usage-limit exception/interruption
//       after preparation retain the proof only after a FRESH out-of-band ownership check,
//       durably record a distinct "unfinished" marker state, and report an explicit boolean
//       `retained` field — never left implicit. A marker write that cannot durably land must
//       not claim retention.                                                -> T1, T2, T3; guard.js G2
//   C2  Missing, mismatched, malformed or symlinked ownership at the retention decision produces
//       no retention claim, rewrites no marker, follows no reparse point, and triggers no
//       recursive cleanup.                                                  -> T4, T5, T6, T7
//   C3  A standalone resume mode of the same command, under the same target lock, individually
//       validates issue, source worktree, suite bytes, author HEAD, baseline manifest and
//       ownership before any agent launch or gate; an optional skip-agent mode never launches a
//       model but still runs invariants before and after exactly one two-direction gate.
//                                                              -> T9, T10a-T10f, T11; guard.js G3
//   C4  Only a successful gate ever writes "proven"; tamper is refused as explicitly
//       non-resumable even with intact ownership, and interruption/exhaustion are explicitly
//       resumable or explicitly non-resumable — never merely absent.        -> T1, T2, T3, T8
//   C5  Deterministic coverage of success, exhaustion, non-usage-limit interruption, marker-write
//       failure, every identity dimension, ownership loss, symlink refusal, tamper, lock
//       contention, bounded diagnostics and exact cleanup, plus the two stay-green guards.
//         success                    -> T11
//         exhaustion                 -> T1
//         non-usage-limit interruption -> T2
//         marker-write failure       -> T3
//         every identity dimension   -> T10a-T10f; guard.js G3
//         ownership loss             -> T4, T5, T6
//         symlink refusal            -> T7
//         tamper                     -> T8
//         lock contention            -> T9
//         bounded diagnostics        -> T12
//         exact cleanup              -> T4, T5, T6, T10a-T10f
//         baseline-green guard (malformed buildBrief)                      -> guard.js G1
//         tests/unit/prove-tests.test.js + tests/unit/freeze-cmd.test.js remain green
//                                                                           -> guard.js G4
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE FROZEN INTERFACE THIS SUITE REQUIRES. `scripts/prove-tests.js` adds no new file and keeps
// every existing export; it extends two things:
//
//   1. `proveTests(built, model, seams)` — on `kind: 'unproven'` (ordinary attempt exhaustion)
//      and on a thrown, caught exception after preparation (`kind: 'setup'`, an interruption),
//      before returning it freshly re-checks `ownedContainer(prepared.container)` (never trusting
//      a value cached from preparation time) and, only if that still holds, durably rewrites the
//      container's marker file with `status: 'unfinished'` (distinct from `'proven'` and from the
//      absence of a status the usage-limit path already leaves) and sets `retained: true` on the
//      result, keeping BOTH `prepared.baseline` and `prepared.probe` on disk. If ownership does
//      not hold, or the marker write itself throws, the result carries `retained: false` (an
//      explicit boolean, never left `undefined`) and touches neither the marker bytes nor
//      anything outside the owned container. `kind: 'tamper'` is excluded from retention
//      entirely and also reports `retained: false` explicitly. `seams.skipAgent === true`
//      (meaningful only together with `seams.retainedProbe`) skips `launchProbe` entirely and
//      runs exactly one `invariantErrors` → `runGate` → `invariantErrors` cycle before applying
//      the same success/retention rules above.
//   2. `main(argv, out, err, seams)` — the existing single-issue invocation gains two flags:
//      `--resume-probe <dir>` (the retained container's `probe` directory, exactly the shape
//      `prepareProbe`/`resumeProbe` already use) sets `probeSeams.retainedProbe`, and
//      `--skip-agent` sets `probeSeams.skipAgent = true`, merged into the existing
//      `probeSeams = { ...(seams.probeSeams || {}) }` construction the same way `onStage`
//      already is, so a caller's own `probeSeams.launchProbe`/`runGate` stubs still apply. Both
//      flags are additive: an invocation without them is byte-for-byte the existing command, and
//      `--resume-probe` reaches `proveTests` under the exact same lock/`buildBrief` sequence the
//      plain invocation already uses.
// ─────────────────────────────────────────────────────────────────────────────────────────────
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const PROVE_FILE = path.join(ROOT, 'scripts', 'prove-tests.js');

// Deterministic and key-free: this suite never spawns a real agent or reads Beads.
for (const name of ['CODEX_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN',
  'PIPELINE_BD_CMD', 'BD_ARGS_LOG', 'BD_STUB_OUT', 'BD_STUB_EXIT']) delete process.env[name];

const ISSUE = 'app-9';

function proveTestsModule() {
  assert(fs.existsSync(PROVE_FILE), `scripts/prove-tests.js does not exist: ${PROVE_FILE}`);
  // eslint-disable-next-line global-require
  return require(PROVE_FILE);
}

const tests = [];
function test(name, body) { tests.push({ name, body }); }

const temps = [];
function tmp(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `repo-djf49-${tag}-`));
  temps.push(dir);
  return dir;
}
function cleanupTemps() {
  for (const dir of temps.splice(0)) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
}

function initGitRepo(root) {
  spawnSync('git', ['init', '-q', '--initial-branch', 'main', '.'], { cwd: root });
  spawnSync('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: root });
  spawnSync('git', ['config', 'user.name', 'fixture'], { cwd: root });
  spawnSync('git', ['add', '-A'], { cwd: root });
  spawnSync('git', ['commit', '-qm', 'fixture'], { cwd: root });
}

function makeFixture(tag) {
  const root = tmp(`${tag}-root`);
  const target = path.join(root, 'target');
  const author = path.join(root, 'author');
  for (const dir of [target, author]) {
    fs.mkdirSync(path.join(dir, 'tests', 'acceptance', ISSUE), { recursive: true });
    fs.mkdirSync(path.join(dir, 'tools'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'pipeline.config.json'),
      `${JSON.stringify({ verifyCommand: 'sh tools/run-acceptance.sh', frozenPaths: ['tools/run-acceptance.sh'] })}\n`);
    fs.writeFileSync(path.join(dir, 'tools', 'run-acceptance.sh'), '# fixture runner\n');
    fs.writeFileSync(path.join(dir, 'tests', 'acceptance', ISSUE, 'test.js'), '// fixture judge\n');
  }
  initGitRepo(target);
  const built = {
    id: ISSUE, suiteId: ISSUE, folder: { dir: author, exists: true },
    cfg: { targetRepoPath: target, wallClockMinutes: 2, testProbeAttempts: 2, testProbeModel: 'fixture-model' },
    policy: { verifyCommand: 'sh tools/run-acceptance.sh', frozenPaths: ['tools/run-acceptance.sh'] },
  };
  return { root, target, author, built };
}

function fakeRun(target) {
  return (cmd, args) => {
    if (args[0] === 'rev-parse') return { status: 0, stdout: `${'a'.repeat(40)}\n` };
    if (args[0] === 'clone') {
      fs.cpSync(target, args[args.length - 1], { recursive: true });
      return { status: 0 };
    }
    return { status: 0 };
  };
}

function retainedContainer(P, fx) {
  const prepared = P.prepareProbe(fx.built, 'fixture-model', fakeRun(fx.target), tmp(`${fx.built.id}-probes`));
  assert(prepared.ok, `fixture preparation failed: ${prepared.error}`);
  return prepared;
}

function cliSeams(fx, extra = {}) {
  return {
    loadConfig: () => ({ targetRepoPath: fx.target }),
    acquireLock: () => ({ ok: true, tookOver: false, ownership: { token: `fixture-${fx.built.id}` } }),
    releaseLock: () => {},
    buildBrief: () => ({ ...fx.built, ok: true, state: 'write' }),
    ...extra,
  };
}

function markerOf(P, prepared) {
  return JSON.parse(fs.readFileSync(path.join(prepared.container, P.MARKER), 'utf8'));
}
function writeMarker(P, prepared, marker) {
  fs.writeFileSync(path.join(prepared.container, P.MARKER), JSON.stringify(marker));
}

// ── T1 / C1,C4,C5(exhaustion) ───────────────────────────────────────────────────────────────
test('T1 C1,C4,C5(exhaustion) ordinary attempt exhaustion with intact ownership retains the baseline and probe, durably records a distinct "unfinished" marker, and reports retained: true', () => {
  const P = proveTestsModule();
  const fx = makeFixture('t1');
  const prepared = retainedContainer(P, fx);
  const result = P.proveTests(fx.built, 'fixture-model', {
    prepareProbe: () => prepared,
    launchProbe: () => ({ status: 0 }),
    invariantErrors: () => [],
    runGate: () => ({ status: 3, stdout: 'still red' }),
  });
  assert.strictEqual(result.ok, false, JSON.stringify(result));
  assert.strictEqual(result.kind, 'unproven', JSON.stringify(result));
  assert.strictEqual(result.retained, true, 'attempt exhaustion with intact ownership did not report retained: true');
  assert(fs.existsSync(prepared.baseline), 'the retained baseline was deleted after exhaustion');
  assert(fs.existsSync(prepared.probe), 'the retained probe was deleted after exhaustion');
  const marker = markerOf(P, prepared);
  assert.strictEqual(marker.status, 'unfinished', `exhaustion did not durably record the distinct unfinished marker state: ${JSON.stringify(marker)}`);
});

// ── T2 / C1,C4,C5(interruption) ─────────────────────────────────────────────────────────────
test('T2 C1,C4,C5(non-usage-limit interruption) a recoverable exception thrown after preparation is retained identically to ordinary exhaustion', () => {
  const P = proveTestsModule();
  const fx = makeFixture('t2');
  const prepared = retainedContainer(P, fx);
  const result = P.proveTests(fx.built, 'fixture-model', {
    prepareProbe: () => prepared,
    launchProbe: () => ({ status: 0 }),
    invariantErrors: () => { throw new Error('fixture interruption: a host fault mid-check'); },
  });
  assert.strictEqual(result.ok, false, JSON.stringify(result));
  assert.strictEqual(result.retained, true, 'a recoverable interruption after preparation did not report retained: true');
  assert(fs.existsSync(prepared.baseline), 'the retained baseline was deleted after an interruption');
  assert(fs.existsSync(prepared.probe), 'the retained probe was deleted after an interruption');
  const marker = markerOf(P, prepared);
  assert.strictEqual(marker.status, 'unfinished', 'interruption did not durably record the distinct unfinished marker state');
});

// ── T3 / C1,C4,C5(marker-write failure) ─────────────────────────────────────────────────────
test('T3 C1,C4,C5(marker-write failure) if the unfinished marker cannot be durably written, retained is explicitly false even though ownership was intact', () => {
  const P = proveTestsModule();
  const fx = makeFixture('t3');
  const prepared = retainedContainer(P, fx);
  const markerPath = path.join(prepared.container, P.MARKER);
  const before = fs.readFileSync(markerPath);
  const real = fs.writeFileSync;
  fs.writeFileSync = (p, ...rest) => {
    if (path.resolve(String(p)) === path.resolve(markerPath)) {
      throw Object.assign(new Error('fixture EIO: marker write failed'), { code: 'EIO' });
    }
    return real(p, ...rest);
  };
  let result;
  try {
    result = P.proveTests(fx.built, 'fixture-model', {
      prepareProbe: () => prepared,
      launchProbe: () => ({ status: 0 }),
      invariantErrors: () => [],
      runGate: () => ({ status: 3, stdout: 'still red' }),
    });
  } finally { fs.writeFileSync = real; }
  assert.strictEqual(result.ok, false, JSON.stringify(result));
  assert.strictEqual(result.retained, false, 'a failed marker write did not report retained as explicit false');
  assert.deepStrictEqual(fs.readFileSync(markerPath), before, 'a failed marker write nonetheless changed the marker bytes on disk');
});

// ── T4 / C2,C5(ownership loss, exact cleanup) ───────────────────────────────────────────────
test('T4 C2,C5(ownership loss - missing, exact cleanup) an owner record gone by the retention decision blocks retention, leaves the marker bytes exactly as they were, and removes nothing', () => {
  const P = proveTestsModule();
  const fx = makeFixture('t4');
  const prepared = retainedContainer(P, fx);
  const markerPath = path.join(prepared.container, P.MARKER);
  const before = fs.readFileSync(markerPath);
  fs.rmSync(P.ownerRecordPath(prepared.container));
  const result = P.proveTests(fx.built, 'fixture-model', {
    prepareProbe: () => prepared,
    launchProbe: () => ({ status: 0 }),
    invariantErrors: () => [],
    runGate: () => ({ status: 3, stdout: 'still red' }),
  });
  assert.strictEqual(result.ok, false, JSON.stringify(result));
  assert.strictEqual(result.retained, false, 'a lost owner record did not report retained as explicit false');
  assert.deepStrictEqual(fs.readFileSync(markerPath), before, 'a lost owner record did not stop the marker from being rewritten');
  assert(fs.existsSync(prepared.container), 'a lost owner record was followed by recursive container cleanup anyway');
});

// ── T5 / C2,C5(ownership loss) ──────────────────────────────────────────────────────────────
test('T5 C2,C5(ownership loss - mismatched) a cleanupToken forged only in the editable marker blocks retention identically', () => {
  const P = proveTestsModule();
  const fx = makeFixture('t5');
  const prepared = retainedContainer(P, fx);
  const markerPath = path.join(prepared.container, P.MARKER);
  const marker = markerOf(P, prepared);
  marker.cleanupToken = 'f'.repeat(64);
  writeMarker(P, prepared, marker);
  const before = fs.readFileSync(markerPath);
  const result = P.proveTests(fx.built, 'fixture-model', {
    prepareProbe: () => prepared,
    launchProbe: () => ({ status: 0 }),
    invariantErrors: () => [],
    runGate: () => ({ status: 3, stdout: 'still red' }),
  });
  assert.strictEqual(result.ok, false, JSON.stringify(result));
  assert.strictEqual(result.retained, false, 'a forged cleanupToken did not report retained as explicit false');
  assert.deepStrictEqual(fs.readFileSync(markerPath), before, 'a mismatched marker was rewritten instead of left exactly as it was');
});

// ── T6 / C2,C5(ownership loss) ──────────────────────────────────────────────────────────────
test('T6 C2,C5(ownership loss - malformed) a marker that is not valid JSON at the retention decision blocks retention identically', () => {
  const P = proveTestsModule();
  const fx = makeFixture('t6');
  const prepared = retainedContainer(P, fx);
  const markerPath = path.join(prepared.container, P.MARKER);
  fs.writeFileSync(markerPath, '{not valid json');
  const before = fs.readFileSync(markerPath);
  const result = P.proveTests(fx.built, 'fixture-model', {
    prepareProbe: () => prepared,
    launchProbe: () => ({ status: 0 }),
    invariantErrors: () => [],
    runGate: () => ({ status: 3, stdout: 'still red' }),
  });
  assert.strictEqual(result.ok, false, JSON.stringify(result));
  assert.strictEqual(result.retained, false, 'a malformed marker did not report retained as explicit false');
  assert.deepStrictEqual(fs.readFileSync(markerPath), before, 'a malformed marker was rewritten instead of left exactly as it was');
});

// ── T7 / C2,C5(symlink refusal) ─────────────────────────────────────────────────────────────
test('T7 C2,C5(symlink refusal) a container swapped for a symlink/reparse point at the retention decision refuses to follow it, leaves the decoy target untouched, and is not retained', () => {
  const P = proveTestsModule();
  const fx = makeFixture('t7');
  const prepared = retainedContainer(P, fx);
  const decoy = tmp('t7-decoy');
  fs.writeFileSync(path.join(decoy, 'do-not-touch'), 'precious');
  const containerPath = prepared.container;
  let canSymlink = true;
  fs.rmSync(containerPath, { recursive: true, force: true });
  try { fs.symlinkSync(path.resolve(decoy), containerPath, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch { canSymlink = false; }
  if (!canSymlink) { console.log('[test] SKIP T7: host cannot create a directory symlink/junction'); return; }

  const result = P.proveTests(fx.built, 'fixture-model', {
    prepareProbe: () => prepared,
    launchProbe: () => ({ status: 0 }),
    invariantErrors: () => [],
    runGate: () => ({ status: 3, stdout: 'still red' }),
  });
  assert.strictEqual(result.ok, false, JSON.stringify(result));
  assert.strictEqual(result.retained, false, 'a container swapped for a reparse point did not report retained as explicit false');
  assert(fs.existsSync(path.join(decoy, 'do-not-touch')), 'retention followed the swapped-in reparse point into its target');
  assert(fs.lstatSync(containerPath).isSymbolicLink(), 'retention removed the reparse point itself instead of refusing to follow it');
});

// ── T8 / C4 ──────────────────────────────────────────────────────────────────────────────────
test('T8 C4 protected-path tampering is refused as explicitly non-resumable even though ownership stays fully intact', () => {
  const P = proveTestsModule();
  const fx = makeFixture('t8');
  const prepared = retainedContainer(P, fx);
  const result = P.proveTests(fx.built, 'fixture-model', {
    prepareProbe: () => prepared,
    launchProbe: () => ({ status: 0 }),
    invariantErrors: () => ['probe protected path edited tools/run-acceptance.sh'],
    runGate: () => { throw new Error('a tamper refusal must never reach the gate'); },
  });
  assert.strictEqual(result.ok, false, JSON.stringify(result));
  assert.strictEqual(result.kind, 'tamper', JSON.stringify(result));
  assert.strictEqual(result.retained, false, 'protected-path tampering was not reported as explicitly non-resumable');
  const marker = markerOf(P, prepared);
  assert.notStrictEqual(marker.status, 'unfinished', 'a tamper refusal wrote the same durable marker state as a legitimate retained failure');
  assert.notStrictEqual(marker.status, 'proven', 'only a successful gate may write "proven"');
});

// ── T9 / C3,C5(lock contention) ─────────────────────────────────────────────────────────────
test('T9 C3,C5(lock contention) the --resume-probe mode acquires the target lock exactly like the ordinary standalone command and refuses under a live competing owner before Beads or the retained probe are touched', () => {
  const P = proveTestsModule();
  const fx = makeFixture('t9');
  const prepared = retainedContainer(P, fx);
  const out = []; const err = [];
  let builds = 0; let proves = 0;
  const rc = P.main([ISSUE, '--config', 'x.json', '--resume-probe', prepared.probe],
    (s) => out.push(String(s)), (s) => err.push(String(s)), cliSeams(fx, {
      acquireLock: () => ({ ok: false, holder: { runId: 'implementation-run-live', pid: 77 } }),
      buildBrief: () => { builds += 1; return { ...fx.built, ok: true, state: 'write' }; },
      proveTests: () => { proves += 1; return { ok: true }; },
    }));
  assert.strictEqual(rc, 3, `expected the same lock-contention exit code as the ordinary standalone command, got ${rc}`);
  assert.strictEqual(builds, 0, 'resume read the brief before the lock was confirmed');
  assert.strictEqual(proves, 0, 'resume touched the retained probe before the lock was confirmed');
  assert(err.some((line) => /implementation-run-live/.test(line)), 'lock contention did not name the competing owner');
  assert(fs.existsSync(prepared.container), 'the retained container was removed by a refused resume');
});

// ── T10a-T10f / C3,C5(every identity dimension, exact cleanup) ──────────────────────────────
function checkResumeDimension(tag, label, expected, corrupt) {
  const P = proveTestsModule();
  const fx = makeFixture(`t10-${tag}`);
  const prepared = retainedContainer(P, fx);
  corrupt(P, prepared, fx);
  const out = []; const err = [];
  let launches = 0; let gates = 0;
  const rc = P.main([ISSUE, '--config', 'x.json', '--resume-probe', prepared.probe],
    (s) => out.push(String(s)), (s) => err.push(String(s)), cliSeams(fx, {
      probeSeams: {
        runSync: fakeRun(fx.target),
        launchProbe: () => { launches += 1; return { status: 0 }; },
        runGate: () => { gates += 1; return { status: 0, stdout: 'RED: fully proven' }; },
      },
    }));
  assert.notStrictEqual(rc, 0, `${label} mismatch was not refused (exit ${rc})`);
  assert(expected.test(err.join('\n')), `${label} mismatch was not refused for the expected reason: ${err.join(' | ')}`);
  assert.strictEqual(launches, 0, `${label} mismatch reached an agent launch before validation refused it`);
  assert.strictEqual(gates, 0, `${label} mismatch reached the gate before validation refused it`);
  assert(fs.existsSync(prepared.container), `${label} mismatch removed the retained container`);
  assert(fs.existsSync(prepared.probe), `${label} mismatch removed the retained probe`);
}

test('T10a C3,C5(identity dimension: issue, exact cleanup) --resume-probe refuses an issue mismatch before any agent launch or gate, untouched', () => {
  checkResumeDimension('issue', 'issue', /identity does not match/, (P, prepared) => {
    const marker = markerOf(P, prepared);
    marker.issue = 'other-issue';
    writeMarker(P, prepared, marker);
  });
});

test('T10b C3,C5(identity dimension: source worktree, exact cleanup) --resume-probe refuses a source-worktree mismatch before any agent launch or gate, untouched', () => {
  checkResumeDimension('worktree', 'source worktree', /identity does not match/, (P, prepared, fx) => {
    const marker = markerOf(P, prepared);
    marker.sourceWorktree = path.join(fx.root, 'somewhere-else');
    writeMarker(P, prepared, marker);
  });
});

test('T10c C3,C5(identity dimension: suite bytes, exact cleanup) --resume-probe refuses a suite-bytes mismatch before any agent launch or gate, untouched', () => {
  checkResumeDimension('suite-bytes', 'suite bytes', /suite changed|preparation was parked/, (P, prepared) => {
    fs.writeFileSync(path.join(prepared.baselineSuite, 'test.js'), '// tampered after the fact\n');
  });
});

test('T10d C3,C5(identity dimension: author HEAD, exact cleanup) --resume-probe refuses an author-HEAD mismatch before any agent launch or gate, untouched', () => {
  checkResumeDimension('head', 'author HEAD', /author HEAD/, (P, prepared) => {
    const marker = markerOf(P, prepared);
    marker.head = 'b'.repeat(40);
    writeMarker(P, prepared, marker);
  });
});

test('T10e C3,C5(identity dimension: baseline manifest, exact cleanup) --resume-probe refuses a baseline-manifest mismatch before any agent launch or gate, untouched', () => {
  checkResumeDimension('manifest', 'baseline manifest', /preparation was parked/, (P, prepared) => {
    const marker = markerOf(P, prepared);
    marker.manifestHash = 'not-the-recorded-manifest-value'.repeat(2);
    writeMarker(P, prepared, marker);
  });
});

test('T10f C3,C5(identity dimension: ownership, exact cleanup) --resume-probe refuses an ownership-loss mismatch before any agent launch or gate, untouched', () => {
  checkResumeDimension('ownership', 'ownership', /ownership evidence/, (P, prepared) => {
    fs.rmSync(P.ownerRecordPath(prepared.container));
  });
});

// ── T11 / C3,C5(success) ────────────────────────────────────────────────────────────────────
test('T11 C3,C5(success) --skip-agent never launches a model and runs invariants before and after exactly one two-direction gate, succeeding directly from a matching retained probe', () => {
  const P = proveTestsModule();
  const fx = makeFixture('t11');
  const prepared = retainedContainer(P, fx);
  let launches = 0; let gates = 0; let invariantCalls = 0;
  const out = []; const err = [];
  const rc = P.main([ISSUE, '--config', 'x.json', '--resume-probe', prepared.probe, '--skip-agent'],
    (s) => out.push(String(s)), (s) => err.push(String(s)), cliSeams(fx, {
      probeSeams: {
        runSync: fakeRun(fx.target),
        launchProbe: () => { launches += 1; return { status: 0 }; },
        invariantErrors: () => { invariantCalls += 1; return []; },
        runGate: () => { gates += 1; return { status: 0, stdout: 'RED: fully proven' }; },
      },
    }));
  assert.strictEqual(rc, 0, `expected --skip-agent to succeed against a matching retained probe (exit ${rc})`);
  assert.strictEqual(launches, 0, '--skip-agent launched a model');
  assert.strictEqual(gates, 1, `--skip-agent must run exactly one two-direction gate, ran ${gates}`);
  assert.strictEqual(invariantCalls, 2, '--skip-agent must run invariants both before and after the gate');
});

// ── T12 / C5(bounded diagnostics) ───────────────────────────────────────────────────────────
test('T12 C5(bounded diagnostics) a resume refusal reported through the CLI is bounded, names the real reason, and leaks no host path or raw OS error text', () => {
  const P = proveTestsModule();
  const fx = makeFixture('t12');
  const prepared = retainedContainer(P, fx);
  const marker = markerOf(P, prepared);
  marker.head = 'c'.repeat(40);
  writeMarker(P, prepared, marker);
  const out = []; const err = [];
  P.main([ISSUE, '--config', 'x.json', '--resume-probe', prepared.probe],
    (s) => out.push(String(s)), (s) => err.push(String(s)), cliSeams(fx));
  const text = err.join('\n');
  assert(text.length > 0, 'a refused resume printed no diagnostic at all');
  assert(text.length <= 400, `resume diagnostics are not bounded: ${text.length} chars`);
  assert(/author HEAD/.test(text), `resume diagnostics did not name the real refusal reason: ${text}`);
  assert(!/EIO|EPERM|ENOENT|ENOTDIR|EACCES/.test(text), `resume diagnostics leaked raw OS error text: ${text}`);
  for (const hostPath of [fx.root, fx.target, fx.author, prepared.container]) {
    assert(!text.includes(hostPath), `resume diagnostics named a host path: ${text}`);
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
