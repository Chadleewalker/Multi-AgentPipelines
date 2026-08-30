#!/usr/bin/env node
// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const P = require('../../scripts/prove-tests');

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${!ok && detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prove-tests-unit-'));
const target = path.join(tmp, 'target with spaces');
const author = path.join(tmp, 'author with spaces');
for (const root of [target, author]) {
  fs.mkdirSync(path.join(root, 'tests', 'acceptance', '_control'), { recursive: true });
  fs.mkdirSync(path.join(root, 'tests', 'acceptance', 'app-7'), { recursive: true });
  fs.mkdirSync(path.join(root, 'tools'), { recursive: true });
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'pipeline.config.json'), JSON.stringify({
    verifyCommand: 'sh tools/run-acceptance.sh',
    frozenPaths: ['tools/run-acceptance.sh', 'scripts/test-*.sh'],
  }));
  fs.writeFileSync(path.join(root, 'tools', 'run-acceptance.sh'), '# runner\n');
  fs.writeFileSync(path.join(root, 'tests', 'acceptance', '_control', 'pass.js'), '// pass\n');
  fs.writeFileSync(path.join(root, 'tests', 'acceptance', 'app-7', 'test.js'), '// exact judge\n');
  fs.writeFileSync(path.join(root, 'scripts', 'test-core.sh'), '# frozen wildcard\n');
}
fs.writeFileSync(path.join(target, '.gitignore'), 'scripts/test-ignored.sh\n');
spawnSync('git', ['init', '-q', '--initial-branch', 'main', '.'], { cwd: target });
spawnSync('git', ['config', 'user.email', 'fixture@test.local'], { cwd: target });
spawnSync('git', ['config', 'user.name', 'fixture'], { cwd: target });
spawnSync('git', ['add', '-A'], { cwd: target });
spawnSync('git', ['commit', '-qm', 'fixture'], { cwd: target });

const built = {
  id: 'app-7', branch: 'main', folder: { dir: author },
  cfg: { targetRepoPath: target, image: 'fixture-probe:latest', wallClockMinutes: 2, testProbeAttempts: 3,
    hostEnv: { PROBE_TEST_HOST_ONLY: 'fixture-tool-value' } },
  policy: { verifyCommand: 'sh tools/run-acceptance.sh',
    frozenPaths: ['tools/run-acceptance.sh', 'scripts/test-*.sh'] },
};
const cliSeams = (extra = {}) => ({
  loadConfig: () => ({ targetRepoPath: target }),
  acquireLock: () => ({ ok: true, tookOver: false, ownership: { token: 'fixture-proof' } }),
  releaseLock: () => {},
  ...extra,
});

check('A1 ordinary issue ids are accepted', P.validIssueId('Junkstronaut_Final-pyx'));
for (const bad of ['..', 'app..7', '../x', 'a/b', 'a\\b', 'a b', 'x)', 'x,', 'x&y', '-option', 'CON', 'app.']) {
  check(`A2 unsafe issue id is rejected: ${bad}`, !P.validIssueId(bad));
}

const manifest = P.protectedManifest(target, built.policy, built.id);
check('B1 manifest covers all acceptance tests, pipeline config and frozen verifier',
  manifest.some(([p]) => p === 'tests/acceptance/app-7/test.js')
  && manifest.some(([p]) => p === 'tests/acceptance/_control/pass.js')
  && manifest.some(([p]) => p === 'pipeline.config.json')
  && manifest.some(([p]) => p === 'tools/run-acceptance.sh')
  && manifest.some(([p]) => p === 'scripts/test-core.sh'));
fs.writeFileSync(path.join(target, 'tools', 'run-acceptance.sh'), '# softened\n');
check('B2 a frozen verifier edit changes the protected manifest',
  P.manifestDifference(manifest, P.protectedManifest(target, built.policy, built.id))
    .some((x) => /tools\/run-acceptance\.sh/.test(x)));
fs.writeFileSync(path.join(target, 'tools', 'run-acceptance.sh'), '# runner\n');
fs.writeFileSync(path.join(target, 'tests', 'acceptance', '_control', 'new.js'), '// new judge\n');
check('B3 an added acceptance file changes the protected manifest',
  P.manifestDifference(manifest, P.protectedManifest(target, built.policy, built.id))
    .some((x) => /added tests\/acceptance\/_control\/new\.js/.test(x)));
fs.rmSync(path.join(target, 'tests', 'acceptance', '_control', 'new.js'));
check('B4 a protected path cannot escape the repository', (() => {
  try { P.protectedManifest(target, { frozenPaths: ['../outside'] }, built.id); return false; } catch { return true; }
})());
fs.writeFileSync(path.join(target, 'scripts', 'test-core.sh'), '# wildcard edited\n');
check('B5 a wildcard frozen-path edit changes the protected manifest',
  P.manifestDifference(manifest, P.protectedManifest(target, built.policy, built.id))
    .some((x) => /scripts\/test-core\.sh/.test(x)));
fs.writeFileSync(path.join(target, 'scripts', 'test-core.sh'), '# frozen wildcard\n');
fs.writeFileSync(path.join(target, 'scripts', 'test-ignored.sh'), '# ignored but executable\n');
check('B6 an ignored addition matching a frozen path is still protected',
  P.manifestDifference(manifest, P.protectedManifest(target, built.policy, built.id))
    .some((x) => /added scripts\/test-ignored\.sh/.test(x)));
fs.rmSync(path.join(target, 'scripts', 'test-ignored.sh'));

{
  let call;
  const prepared = { probe: path.join(tmp, 'probe') };
  P.launchProbe(built, prepared, 'opus', 'host evidence', (cmd, args, opts) => {
    call = { cmd, args, opts }; return { status: 0 };
  });
  check('C1 prompt is stdin and model is a bounded argv value',
    call.opts.input.includes('host evidence') && call.args[call.args.indexOf('--model') + 1] === 'opus');
  check('C2 probe exposes no Bash tool and explicitly denies it',
    call.args[call.args.indexOf('--tools') + 1] === P.PROBE_TOOLS
    && !P.PROBE_TOOLS.includes('Bash')
    && call.args[call.args.indexOf('--disallowedTools') + 1].includes('Bash'));
  check('C3 probe is restricted, nonpersistent and rooted in its isolated clone',
    call.args.includes('--restricted') && call.args.includes('--no-session-persistence')
    && call.opts.cwd === prepared.probe);
  check('C4 host verifier environment is not injected into Claude', call.opts.env.PROBE_TEST_HOST_ONLY === undefined);
}

{
  let call;
  P.runGate(built, { baseline: 'C:/baseline with spaces', probe: 'C:/probe with spaces' },
    (cmd, args, opts) => { call = { cmd, args, opts }; return { status: 0 }; });
  check('D1 gate uses argv without a shell and names both isolated trees exactly',
    call.cmd === process.execPath && call.args.includes('C:/baseline with spaces')
    && call.args.includes('C:/probe with spaces'));
  check('D2 gate selects the configured container image and receives no host-only environment',
    call.opts.env.FREEZE_GATE_DOCKER_IMAGE === built.cfg.image
    && call.opts.env.PROBE_TEST_HOST_ONLY === undefined);
}

{
  const calls = [];
  const cloneRoot = path.join(tmp, 'prepared');
  // The ordinary authoring shape: the dedicated author tree has the new suite, while the
  // integration checkout is still at the untouched fork point.
  fs.rmSync(path.join(target, 'tests', 'acceptance', 'app-7'), { recursive: true, force: true });
  const fakeRun = (cmd, args, opts) => {
    calls.push({ cmd, args: [...args], cwd: opts.cwd });
    if (args[0] === 'rev-parse') return { status: 0, stdout: 'a'.repeat(40) + '\n' };
    if (args[0] === 'clone') {
      const dest = args[args.length - 1];
      fs.cpSync(target, dest, { recursive: true });
      return { status: 0 };
    }
    return { status: 0 };
  };
  const prepared = P.prepareProbe(built, 'opus', fakeRun, cloneRoot);
  check('E1 preparation creates two independent clones at the exact author HEAD',
    prepared.ok && calls.filter((c) => c.args[0] === 'clone').length === 2
    && calls.filter((c) => c.args[0] === 'checkout').every((c) => c.args.includes('a'.repeat(40))));
  check('E2 clone creation forbids hardlinks and overlays byte-identical suite copies',
    calls.filter((c) => c.args[0] === 'clone').every((c) => c.args.includes('--no-hardlinks'))
    && P.suiteDifference(prepared.sourceSuite, prepared.baselineSuite).length === 0
    && P.suiteDifference(prepared.sourceSuite, prepared.probeSuite).length === 0);
  check('E3 successful preparation carries an ownership marker', P.ownedContainer(prepared.container));
  const ownerRecord = P.ownerRecordPath(prepared.container);
  const ownerBytes = fs.readFileSync(ownerRecord);
  fs.rmSync(ownerRecord);
  check('E3b the editable in-container marker cannot authorize cleanup without its out-of-band owner record',
    !P.ownedContainer(prepared.container));
  fs.writeFileSync(ownerRecord, ownerBytes);
  const markerPath = path.join(prepared.container, P.MARKER);
  const markerBytes = fs.readFileSync(markerPath);
  const forgedMarker = JSON.parse(markerBytes.toString('utf8'));
  forgedMarker.cleanupToken = 'f'.repeat(64);
  fs.writeFileSync(markerPath, JSON.stringify(forgedMarker));
  check('E3c a token forged only in the editable marker is refused', !P.ownedContainer(prepared.container));
  fs.writeFileSync(markerPath, markerBytes);
  P.markProven(prepared, 1, 'RED: fully proven');
  const managed = P.validateManagedProbe(prepared.probe, target, ['app-7'], 'a'.repeat(40));
  check('E4 a proven managed probe recognizes the untouched integration fork point',
    managed.ok && managed.managed && managed.needsPromotion);
  const promoted = P.promoteManagedSuite(managed, target);
  check('E5 promotion copies only the exact proven suite into the integration checkout',
    promoted.ok && promoted.promoted
    && P.suiteDifference(prepared.probeSuite, path.join(target, 'tests', 'acceptance', 'app-7')).length === 0);
  const afterPromotion = P.validateManagedProbe(prepared.probe, target, ['app-7'], 'a'.repeat(40));
  check('E6 the promoted checkout reproduces the protected proof hash',
    afterPromotion.ok && afterPromotion.managed && !afterPromotion.needsPromotion);
  fs.writeFileSync(path.join(prepared.probe, 'tools', 'run-acceptance.sh'), '# tampered after proof\n');
  check('E7 a retained probe that changes a protected byte is refused',
    !P.validateManagedProbe(prepared.probe, target, ['app-7'], 'a'.repeat(40)).ok);
  fs.writeFileSync(path.join(prepared.probe, 'tools', 'run-acceptance.sh'), '# runner\n');
  fs.writeFileSync(path.join(target, 'tests', 'acceptance', '_control', 'pass.js'), '// changed concurrently\n');
  check('E8 concurrent protected integration changes are refused rather than overwritten',
    !P.validateManagedProbe(prepared.probe, target, ['app-7'], 'a'.repeat(40)).ok);
  fs.writeFileSync(path.join(target, 'tests', 'acceptance', '_control', 'pass.js'), '// pass\n');
  const rolled = P.rollbackManagedPromotion(promoted);
  check('E9 a refused freeze can transactionally restore the untouched integration suite',
    rolled.ok && rolled.rolledBack && !fs.existsSync(path.join(target, 'tests', 'acceptance', 'app-7')));
  P.removeOwnedPath(prepared.container, prepared.baseline);
  check('E10 owned cleanup removes only the named child', !fs.existsSync(prepared.baseline) && fs.existsSync(prepared.probe));
  check('E11 cleanup refuses the container itself', (() => {
    try { P.removeOwnedPath(prepared.container, prepared.container); return false; } catch { return true; }
  })());
  const malformedRoot = path.join(tmp, P.PROBE_ROOT_NAME);
  const malformedContainer = path.join(malformedRoot, `${P.PROBE_PREFIX}bad-fixture`);
  fs.mkdirSync(path.join(malformedContainer, 'probe'), { recursive: true });
  fs.writeFileSync(path.join(malformedContainer, P.MARKER), '{not valid json');
  check('E12 a damaged managed marker fails closed instead of downgrading to a manual probe',
    !P.validateManagedProbe(path.join(malformedContainer, 'probe'), target, ['app-7'], 'a'.repeat(40)).ok);
  P.removeOwnedContainer(prepared.container);
  check('E13 owned container cleanup also removes its out-of-band owner record',
    !fs.existsSync(prepared.container) && !fs.existsSync(ownerRecord));
}

{
  const prepared = { ok: true, container: path.join(tmp, 'fake-container'), baseline: path.join(tmp, 'fake-baseline'),
    probe: path.join(tmp, 'fake-probe') };
  let gates = 0; const prior = [];
  const result = P.proveTests(built, 'opus', {
    prepareProbe: () => prepared,
    launchProbe: (b, p, m, evidence) => { prior.push(evidence); return { status: 0 }; },
    invariantErrors: () => [],
    runGate: () => (++gates === 1 ? { status: 3, stdout: 'still red' } : { status: 0, stdout: 'RED: fully proven' }),
    markProven: () => {},
  });
  check('F1 controller retries with host evidence and accepts only gate exit 0',
    result.ok && result.attempt === 2 && prior[0] === '' && prior[1].includes('still red'));
}

{
  let gates = 0;
  const result = P.proveTests(built, 'opus', {
    prepareProbe: () => ({ ok: true, container: 'x', baseline: 'y', probe: 'z' }),
    launchProbe: () => ({ status: 0 }),
    invariantErrors: () => ['probe protected path edited tools/run-acceptance.sh'],
    runGate: () => { gates += 1; return { status: 0 }; },
  });
  check('F2 protected-path tampering refuses before any gate', !result.ok && result.kind === 'tamper' && gates === 0);
}

{
  const out = []; const err = [];
  const rc = P.main(['app-7', '--config', 'x.json'], (s) => out.push(String(s)), (s) => err.push(String(s)), cliSeams({
    buildBrief: () => ({ ...built, ok: true, state: 'write', folder: { ...built.folder, exists: true },
      cfg: { ...built.cfg, testProbeModel: 'opus' } }),
    proveTests: () => ({ ok: true, attempt: 1, probe: 'C:/owned probe' }),
  }));
  check('G1 standalone proof command reports success but still requires human freeze approval',
    rc === 0 && out.some((s) => /fully proven/.test(s)) && out.some((s) => /human approval/.test(s)));
  check('G2 unsafe standalone ids fail before building a brief', P.main(['../x', '--config', 'x'], () => {}, () => {}) === 2);
}
{
  const out = []; const err = []; let proves = 0; let builds = 0;
  const rc = P.main(['app-7', '--config', 'x.json'], (s) => out.push(String(s)), (s) => err.push(String(s)), cliSeams({
    buildBrief: () => { builds += 1; return { ...built, ok: true, state: 'write', folder: { ...built.folder, exists: true },
      cfg: { ...built.cfg, testProbeModel: 'opus' } }; },
    acquireLock: () => ({ ok: false, holder: { runId: 'implementation-run-live', pid: 55 } }),
    proveTests: () => { proves += 1; return { ok: true }; },
  }));
  check('G3 standalone proof refuses a live target owner before probe mutation or another brief read',
    rc === 3 && builds === 0 && proves === 0 && /implementation-run-live/.test(err.join('\n')));
}
{
  let released = 0; let builds = 0; const ownership = { token: 'proof-owner' };
  const rc = P.main(['app-7', '--config', 'x.json'], () => {}, () => {}, cliSeams({
    buildBrief: () => { builds += 1; return ({ ...built, ok: true, state: 'write', folder: { ...built.folder, exists: true },
      cfg: { ...built.cfg, testProbeModel: 'opus' } }); },
    acquireLock: () => ({ ok: true, ownership }),
    releaseLock: (root, targetPath, got) => { if (got === ownership && targetPath === target) released += 1; },
    proveTests: () => ({ ok: false, kind: 'unproven', error: 'still red' }),
  }));
  check('G4 standalone proof builds exactly once under the lock and releases ownership on failure',
    rc === 4 && builds === 1 && released === 1);
}
{
  let locks = 0;
  P.proveTests(built, 'opus', {
    acquireLock: () => { locks += 1; return { ok: false }; },
    prepareProbe: () => ({ ok: false, error: 'fixture stop' }),
  });
  check('G5 structured proof API never acquires the standalone CLI lock', locks === 0);
}
{
  const err = []; let builds = 0; let probes = 0; let released = 0;
  const ownership = { token: 'stale-proof-owner' };
  const rc = P.main(['app-7', '--config', 'x.json'], () => {}, (s) => err.push(String(s)), cliSeams({
    buildBrief: () => { builds += 1; return { ...built, ok: true }; },
    acquireLock: () => ({ ok: true, tookOver: true, ownership }),
    releaseLock: (_root, _target, got) => { if (got === ownership) released += 1; },
    proveTests: () => { probes += 1; return { ok: true }; },
  }));
  check('G6 standalone proof refuses stale-owner takeover before Beads or probe and releases it',
    rc === 3 && builds === 0 && probes === 0 && released === 1
      && /normal pipeline recovery/.test(err.join('\n')));
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
