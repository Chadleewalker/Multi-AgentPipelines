// Frozen acceptance guard — repo-djf.49. [guard]
// Criteria -> tests: C1's "existing usage-limit parking alone does not satisfy interruption
// coverage" names existing behaviour that must not regress -> G2 here. C3's six named identity
// checks (issue, source worktree, suite bytes, author HEAD, baseline manifest, ownership) are
// already implemented and already correct in `resumeProbe` (used today only through the batch
// worker's `retainedProbe` wiring) -> G3 here; test.js's T9-T12 cover the genuinely new half of
// C3, the standalone `--resume-probe`/`--skip-agent` command surface, since that half does not
// exist at all yet. C5's "a baseline-green guard keeps malformed buildBrief results with missing
// or undefined ok fail-closed" is itself a guard by name -> G1. C5's "tests/unit/prove-tests.
// test.js plus tests/unit/freeze-cmd.test.js remain green" names two already-passing frozen unit
// suites -> G4.
// Every check here is GREEN at the fork point (none of it depends on repo-djf.49's own
// unbuilt retention/resume feature; each pins behaviour `scripts/prove-tests.js` already has)
// and must stay green.
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const PROVE_FILE = path.join(ROOT, 'scripts', 'prove-tests.js');

for (const name of ['CODEX_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN',
  'PIPELINE_BD_CMD', 'BD_ARGS_LOG', 'BD_STUB_OUT', 'BD_STUB_EXIT']) delete process.env[name];

assert(fs.existsSync(PROVE_FILE), `scripts/prove-tests.js does not exist: ${PROVE_FILE}`);
const P = require(PROVE_FILE);

let failed = 0;
function check(name, body) {
  try { body(); console.log(`ok - ${name}`); }
  catch (error) { failed = 1; console.error(`FAIL - ${name} — ${error.stack || error.message}`); }
}

const ISSUE = 'app-9g';
const temps = [];
function tmp(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `repo-djf49-guard-${tag}-`));
  temps.push(dir);
  return dir;
}

function initGitRepo(root) {
  spawnSync('git', ['init', '-q', '--initial-branch', 'main', '.'], { cwd: root });
  spawnSync('git', ['config', 'user.email', 'fixture@repo-djf49.test'], { cwd: root });
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

function retainedContainer(fx) {
  const prepared = P.prepareProbe(fx.built, 'fixture-model', fakeRun(fx.target), tmp(`${fx.built.id}-probes`));
  assert(prepared.ok, `fixture preparation failed: ${prepared.error}`);
  return prepared;
}

// G1 / C5 [guard] — a malformed buildBrief result (missing or undefined `ok`) already fails the
// standalone command closed, before any lock work or proof attempt is trusted.
check('G1 C5 [guard] a malformed buildBrief result with a missing or undefined ok field already fails main() closed', () => {
  const seams = {
    loadConfig: () => ({ targetRepoPath: 'C:/unused-guard-target' }),
    acquireLock: () => ({ ok: true, tookOver: false, ownership: {} }),
    releaseLock: () => {},
  };
  const rcMissing = P.main([ISSUE, '--config', 'x.json'], () => {}, () => {}, { ...seams, buildBrief: () => ({}) });
  assert.strictEqual(rcMissing, 3, `a buildBrief result with no ok field did not fail closed (exit ${rcMissing})`);
  const rcUndefined = P.main([ISSUE, '--config', 'x.json'], () => {}, () => {}, { ...seams, buildBrief: () => ({ ok: undefined }) });
  assert.strictEqual(rcUndefined, 3, `a buildBrief result with ok: undefined did not fail closed (exit ${rcUndefined})`);
});

// G2 / C1 [guard] — the existing usage-limit park already preserves both halves of a retained
// probe; the new exhaustion/interruption retention this issue adds must not weaken this path.
check('G2 C1 [guard] existing usage-limit parking already preserves both the retained baseline and probe', () => {
  const fx = makeFixture('g2');
  const prepared = retainedContainer(fx);
  const result = P.proveTests(fx.built, 'fixture-model', {
    prepareProbe: () => prepared,
    launchProbe: () => ({ status: 1, stdout: 'usage limit reached|9999999999' }),
  });
  assert.strictEqual(result.kind, 'usage-limit', JSON.stringify(result));
  assert(fs.existsSync(prepared.baseline), 'usage-limit parking no longer preserves the retained baseline');
  assert(fs.existsSync(prepared.probe), 'usage-limit parking no longer preserves the retained probe');
});

// G3 / C3,C5(every identity dimension) [guard] — `resumeProbe` already individually validates
// every one of the six identity dimensions the new standalone resume command will delegate to;
// the command surface is new, this validation engine underneath it is not.
check('G3 C3,C5(every identity dimension) [guard] resumeProbe already individually refuses on issue, source worktree, suite bytes, author HEAD, baseline manifest and ownership mismatches, and accepts a genuine match', () => {
  const fx = makeFixture('g3');
  const prepared = retainedContainer(fx);
  const run = fakeRun(fx.target);

  const accepted = P.resumeProbe(fx.built, prepared.probe, run);
  assert(accepted.ok, `a matching retained probe was refused: ${accepted.error}`);

  function withMutatedMarker(mutate) {
    const before = fs.readFileSync(path.join(prepared.container, P.MARKER));
    const marker = JSON.parse(before.toString('utf8'));
    mutate(marker);
    fs.writeFileSync(path.join(prepared.container, P.MARKER), JSON.stringify(marker));
    const refused = P.resumeProbe(fx.built, prepared.probe, run);
    fs.writeFileSync(path.join(prepared.container, P.MARKER), before);
    return refused;
  }

  assert(!withMutatedMarker((m) => { m.issue = 'other-issue'; }).ok, 'an issue mismatch was not refused');
  assert(!withMutatedMarker((m) => { m.sourceWorktree = path.join(fx.root, 'elsewhere'); }).ok, 'a source-worktree mismatch was not refused');
  assert(!withMutatedMarker((m) => { m.head = 'b'.repeat(40); }).ok, 'an author-HEAD mismatch was not refused');
  assert(!withMutatedMarker((m) => { m.manifestHash = 'not-the-recorded-manifest-value'.repeat(2); }).ok, 'a baseline-manifest mismatch was not refused');

  fs.writeFileSync(path.join(prepared.baselineSuite, 'test.js'), '// guard tamper\n');
  assert(!P.resumeProbe(fx.built, prepared.probe, run).ok, 'a suite-bytes mismatch was not refused');
  fs.writeFileSync(path.join(prepared.baselineSuite, 'test.js'), '// fixture judge\n');

  const ownerRecord = P.ownerRecordPath(prepared.container);
  const ownerBytes = fs.readFileSync(ownerRecord);
  fs.rmSync(ownerRecord);
  assert(!P.resumeProbe(fx.built, prepared.probe, run).ok, 'an ownership-loss mismatch was not refused');
  fs.writeFileSync(ownerRecord, ownerBytes);

  assert(P.resumeProbe(fx.built, prepared.probe, run).ok, 'restoring the exact matching state was not accepted again');
});

// G4 / C5 [guard] — the two frozen unit suites this issue's docs name are already green.
check('G4 C5 [guard] tests/unit/prove-tests.test.js and tests/unit/freeze-cmd.test.js already pass', () => {
  for (const name of ['prove-tests.test.js', 'freeze-cmd.test.js']) {
    const unitTest = path.join(ROOT, 'tests', 'unit', name);
    assert(fs.existsSync(unitTest), `frozen unit suite is missing: ${unitTest}`);
    const result = spawnSync(process.execPath, [unitTest], { cwd: ROOT, encoding: 'utf8' });
    assert.strictEqual(result.status, 0,
      `tests/unit/${name} is not currently green (exit ${JSON.stringify(result.status)})\n`
      + `--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`);
  }
});

for (const dir of temps.splice(0)) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
process.exitCode = failed;
