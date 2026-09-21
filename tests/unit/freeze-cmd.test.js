#!/usr/bin/env node
// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// Checks for `scripts/freeze.js` — the freeze as a command (change-log row `freeze-command`).
//
// WHAT THIS SUITE IS FOR, and why it uses real repositories rather than stubs for the git half.
// The command's entire claim is that a freeze it reports as done is one the runner will
// actually accept. A suite that stubbed git could assert every message this file prints and
// still bless a command that commits to the wrong branch, forgets the receipt, or never
// pushes — which are precisely the three ways a hand-run freeze has failed here before. So the
// fixture is a bare "remote" and a working clone, the freeze really is committed and really is
// pushed, and the last assertion in the happy path is the RUNNER'S OWN dispatch gate reading
// the branch back. Only the target's verify command is stubbed, through the gate's existing
// `FREEZE_GATE_CMD` seam, because a real one would need a project.
//
// The assertions that matter most, in the order they were written:
//
//   * A REFUSAL LEAVES NOTHING BEHIND. Every failing path is checked for a commit that should
//     not exist and an index that should be empty — a command that half-freezes four suites and
//     then refuses the fifth is worse than one that never ran, because the operator now has a
//     tree they did not make and no record of which half is real.
//   * THE PROOF IS NOT THE COMMAND'S OWN OPINION. The happy path asserts against
//     `partitionByFreeze` from `runner/queue.js`, so "frozen" means what the runner means.
//   * THE MISSING-SUITE REFUSAL SAYS WHY IN THE RIGHT WORDS. It is the refusal a planner hits
//     most often and the one whose wrong reading — "the tool is broken" — costs a session. The
//     message has to name the interactive step, not just the absent directory.
//   * THE STAGING RULE IS ASSERTED AS A FACT, not read out of the source. A pre-staged file in
//     the target checkout must survive untouched and uncommitted; that is the accident
//     CLAUDE.md's named-paths rule exists for, seen from the only side a test can see it.

'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'freeze.js');
const PROOF = require(path.join(ROOT, 'scripts', 'prove-tests.js'));

let failures = 0;
function check(name, ok) {
  if (ok) console.log(`PASS  ${name}`);
  else { console.log(`FAIL  ${name}`); failures += 1; }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'freeze-cmd-'));
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ } });

const fwd = (p) => p.split(path.sep).join('/');
const both = (r) => `${r.stdout || ''}${r.stderr || ''}`;

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '',
    out: `${r.stdout || ''}${r.stderr || ''}` };
}

// Identity and signing go into the FIXTURE's own config, never `-c` on the command line: `-c`
// must precede the subcommand to work at all, and a container has neither set globally.
function initRepo(dir, branch) {
  fs.mkdirSync(dir, { recursive: true });
  if (git(dir, ['init', '-q', '--initial-branch', branch, '.']).status !== 0) git(dir, ['init', '-q', '.']);
  git(dir, ['config', 'user.email', 'fixture@test.local']);
  git(dir, ['config', 'user.name', 'fixture']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  git(dir, ['config', 'core.autocrlf', 'false']);
  git(dir, ['config', 'core.eol', 'lf']);
}

// The verify command the freeze gate will run: red on a suite that has files, green on the
// control and green inside a probe. That is the honest shape — a suite whose criteria are not
// yet implemented fails, and a tree where they are already satisfied passes.
//
// `green.js` is the one escape, and it is here because a GREEN verdict cannot otherwise be
// reached through this command: a suite the stub calls green by being empty is refused earlier,
// by the "no test files" check, so the gate would never see it and the verdict under test would
// be unreachable. Naming a file is the smallest way to ask for the state directly.
const STUB = [
  "const fs = require('fs'); const path = require('path');",
  "const target = process.argv[2] || '';",
  "if (fs.existsSync(path.join(process.cwd(), '.is-probe'))) process.exit(0);",
  "if (/_control|freeze-gate-control/.test(target)) process.exit(0);",
  "let names = []; try { names = fs.readdirSync(target); } catch { names = []; }",
  "if (names.includes('green.js')) process.exit(0);",
  'process.exit(names.length > 0 ? 1 : 0);',
].join('\n');

// One complete world: a bare remote, a clone on `master`, a control fixture, and a run config
// pointing at both. `master` deliberately — a project whose integration branch is not `main` is
// the case a resolver that falls back to a literal gets wrong, and it is the real case here.
let worldN = 0;
function makeWorld() {
  worldN += 1;
  const base = path.join(TMP, `w${worldN}`);
  const origin = path.join(base, 'origin.git');
  const target = path.join(base, 'target');
  const stub = path.join(base, 'stub.js');

  fs.mkdirSync(base, { recursive: true });
  fs.mkdirSync(origin, { recursive: true });
  spawnSync('git', ['init', '-q', '--bare', '--initial-branch', 'master', '.'], { cwd: origin, encoding: 'utf8' });
  fs.writeFileSync(stub, STUB);

  initRepo(target, 'master');
  fs.writeFileSync(path.join(target, 'pipeline.config.json'),
    JSON.stringify({ verifyCommand: 'unused', defaultBranch: 'master' }, null, 2));
  fs.mkdirSync(path.join(target, 'tests', 'acceptance', '_control'), { recursive: true });
  fs.writeFileSync(path.join(target, 'tests', 'acceptance', '_control', 'control.js'), 'process.exit(0);\n');
  git(target, ['add', '--', 'pipeline.config.json', 'tests']);
  git(target, ['commit', '-qm', 'fixture']);
  git(target, ['push', '-q', origin, 'HEAD:refs/heads/master']);

  const cfgFile = path.join(base, 'run.config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({
    targetRepoPath: target, targetRepoRemote: origin, image: 'fixture:latest',
  }, null, 2));

  return { base, origin, target, stub, cfgFile };
}

// A suite in the target's WORKING TREE — what a planning session has just written and not yet
// committed. This is the state `commit` is for.
function writeSuite(world, id, body) {
  const rel = `tests/acceptance/${id}`;
  const dir = path.join(world.target, ...rel.split('/'));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'test.js'), body || "process.exit(require('fs').existsSync('DONE') ? 0 : 1);\n");
  return rel;
}

// A repo-shaped probe: the project's tree with the same suite, byte for byte, in which the
// criteria are already satisfied. `.is-probe` is what the stub reads to answer green.
function makeProbe(world, id) {
  const probe = path.join(world.base, `probe-${id}`);
  const rel = path.join('tests', 'acceptance', id);
  fs.mkdirSync(path.join(probe, rel), { recursive: true });
  fs.mkdirSync(path.join(probe, 'tests', 'acceptance', '_control'), { recursive: true });
  fs.copyFileSync(path.join(world.target, rel, 'test.js'), path.join(probe, rel, 'test.js'));
  fs.copyFileSync(path.join(world.target, 'tests', 'acceptance', '_control', 'control.js'),
    path.join(probe, 'tests', 'acceptance', '_control', 'control.js'));
  fs.copyFileSync(path.join(world.target, 'pipeline.config.json'), path.join(probe, 'pipeline.config.json'));
  fs.writeFileSync(path.join(probe, '.is-probe'), '');
  return probe;
}

// The automatic author flow leaves the suite outside the integration checkout. Its successful
// managed probe records both the untouched fork-point hash and the proven protected-tree hash,
// allowing only the later explicitly invoked freeze to bridge that exact suite into the target.
function makeManagedProbe(world, id) {
  const probeRoot = path.join(world.base, PROOF.PROBE_ROOT_NAME);
  fs.mkdirSync(probeRoot, { recursive: true });
  const container = path.join(probeRoot, `${PROOF.PROBE_PREFIX}${id}-fixture`);
  const probe = path.join(container, 'probe');
  const rel = path.join('tests', 'acceptance', id);
  const baseline = path.join(container, 'baseline');
  fs.mkdirSync(container, { recursive: true });
  spawnSync('git', ['clone', '-q', '--no-hardlinks', world.target, probe], { encoding: 'utf8' });
  spawnSync('git', ['clone', '-q', '--no-hardlinks', world.target, baseline], { encoding: 'utf8' });
  fs.mkdirSync(path.join(probe, rel), { recursive: true });
  fs.mkdirSync(path.join(baseline, rel), { recursive: true });
  fs.writeFileSync(path.join(probe, rel, 'test.js'), "process.exit(require('fs').existsSync('DONE') ? 0 : 1);\n");
  fs.writeFileSync(path.join(baseline, rel, 'test.js'), "process.exit(require('fs').existsSync('DONE') ? 0 : 1);\n");
  fs.writeFileSync(path.join(probe, '.is-probe'), '');
  const policy = { frozenPaths: [] };
  const head = git(world.target, ['rev-parse', 'HEAD']).out.trim();
  const ownership = {
    probeRoot: fs.realpathSync(probeRoot), container: fs.realpathSync(container),
    cleanupToken: 'a'.repeat(64),
  };
  fs.writeFileSync(PROOF.ownerRecordPath(container), JSON.stringify({
    kind: 'multi-agent-green-probe-owner', version: 1, ...ownership,
  }, null, 2));
  fs.writeFileSync(path.join(container, PROOF.MARKER), JSON.stringify({
    kind: 'multi-agent-green-probe', version: 1, issue: id, status: 'proven', head,
    ...ownership,
    baseManifestHash: PROOF.manifestHash(PROOF.protectedManifest(world.target, policy, id)),
    manifestHash: PROOF.manifestHash(PROOF.protectedManifest(probe, policy, id)),
  }, null, 2));
  return { container, probe };
}

function cli(world, args, extraEnv) {
  const env = {
    ...process.env,
    FREEZE_GATE_CMD: `"${fwd(process.execPath)}" "${fwd(world.stub)}"`,
    PIPELINE_TESTING_FREEZE_GATE_SEAM: '1',
    ...(extraEnv || {}),
  };
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env, cwd: world.base });
  return { code: r.status, text: both(r) };
}

// What the REMOTE holds, which is the only tree the runner ever consults.
function onRemote(world, rel) {
  return git(world.origin, ['ls-tree', '-r', '--name-only', 'master', '--', rel]).out.trim();
}
function headCount(world) {
  return Number(git(world.target, ['rev-list', '--count', 'HEAD']).out.trim() || '0');
}
function stagedIn(world) {
  // Successful Git queries may still warn on stderr about host-global configuration that this
  // sandbox cannot read. Staged paths are stdout; treating warnings as filenames makes an empty
  // index look dirty and hides the transaction behavior this fixture exists to measure.
  return git(world.target, ['diff', '--cached', '--name-only']).stdout.trim();
}

// ---- A. the command line ------------------------------------------------------------------
{
  const F = require(SCRIPT);
  check('A1 a flag that takes a value is a usage error when given none',
    F.parseArgs(['--config']).error === '--config needs a value');
  check('A2 a value flag followed by another flag is a usage error, not a config named "--dry-run"',
    F.parseArgs(['--config', '--dry-run']).error === '--config needs a value');
  check('A3 an unknown option is named', /unknown option "--nope"/.test(F.parseArgs(['--nope']).error || ''));
  check('A4 bare flags set their own field and consume no operand', (() => {
    const o = F.parseArgs(['x', '--dry-run', '--allow-half-proven', 'y']);
    return o.dryRun === true && o.allowHalfProven === true && o.positional.join(',') === 'x,y';
  })());
  check('A4a repeated managed probes are retained in command-line order', (() => {
    const o = F.parseArgs(['a', 'b', '--managed-probe', 'a=C:/one', '--managed-probe', 'b=C:/two']);
    return o.managedProbes.join('|') === 'a=C:/one|b=C:/two';
  })());
  check('A4b a managed-probe batch requires exactly one absolute mapping per issue', (() => {
    const missing = F.managedProbeMap({ managedProbes: ['a=C:/one'], probe: null, allowHalfProven: false }, ['a', 'b']);
    const relative = F.managedProbeMap({ managedProbes: ['a=relative/probe'], probe: null, allowHalfProven: false }, ['a']);
    const mixed = F.managedProbeMap({ managedProbes: ['a=C:/one'], probe: 'C:/legacy', allowHalfProven: false }, ['a']);
    return !missing.ok && /missing: b/.test(missing.error)
      && !relative.ok && /absolute/.test(relative.error)
      && !mixed.ok && /cannot be combined/.test(mixed.error);
  })());

  const w = makeWorld();
  check('A5 no verb prints usage and exits 2', cli(w, []).code === 2);
  check('A6 an unknown verb is named and exits 2', (() => {
    const r = cli(w, ['freezify']);
    return r.code === 2 && /unknown verb "freezify"/.test(r.text);
  })());
  check('A7 commit with no issue id exits 2', /needs at least one issue id/.test(cli(w, ['commit', '--config', w.cfgFile]).text));
  check('A8 a --config that names nothing exits 2 without a stack trace', (() => {
    const r = cli(w, ['status', '--config', path.join(w.base, 'no-such.json')]);
    return r.code === 2 && /cannot read/.test(r.text) && !/at Object\./.test(r.text);
  })());

  // The verdicts a freeze proceeds on are the RUNNER'S set, by identity and not by agreement.
  // A copy would pass an equality check on the day it was written; this fails the moment
  // somebody reintroduces one.
  const { RECEIPT_VERDICTS } = require(path.join(ROOT, 'runner', 'queue.js'));
  check('A9 the verdicts a freeze proceeds on ARE the runner\'s set, not a copy of it',
    F.PROCEEDS === RECEIPT_VERDICTS);
}

// ---- A2. the final index transaction is path-bounded even under concurrent activity -------
{
  const F = require(SCRIPT);
  const cfg = { targetRepoPath: 'fixture-target' };
  const gated = [
    { rel: 'tests/acceptance/app-one' },
    { rel: 'tests/acceptance/app-two' },
  ];

  let queryArgs = null;
  const clean = F.stagedFreezePaths(cfg, gated, (seenCfg, args) => {
    queryArgs = args;
    return { status: 0, stdout: 'tests/acceptance/app-one/a.js\0tests/acceptance/app-two/nested/b.js\0', stderr: '' };
  });
  check('A10 the final staged-path query is NUL-delimited and accepts only gated suite descendants',
    clean.ok && clean.staged.length === 2 && queryArgs.includes('-z'));

  const raced = F.stagedFreezePaths(cfg, gated, () => ({
    status: 0,
    stdout: 'tests/acceptance/app-one/a.js\0someone else staged this.txt\0',
    stderr: '',
  }));
  check('A11 a path staged after the cleanliness check is mechanically rejected by name',
    !raced.ok && raced.kind === 'outside'
      && raced.outside.join(',') === 'someone else staged this.txt'
      && /someone else staged this\.txt/.test(raced.error));

  const unavailable = F.stagedFreezePaths(cfg, gated,
    () => ({ status: 128, stdout: 'misleading output\0', stderr: 'index is locked' }));
  check('A12 a failed git diff --cached query is unknown, never parsed as an empty or valid index',
    !unavailable.ok && unavailable.kind === 'query' && /index is locked/.test(unavailable.error));

  const resetCalls = [];
  let promotionRollbacks = 0;
  const rolled = F.rollbackFreezePreparation(cfg, gated, { promoted: true },
    (seenCfg, args) => { resetCalls.push(args); return { status: 0, stdout: '', stderr: '' }; },
    () => { promotionRollbacks += 1; return { ok: true }; });
  check('A13 refusal resets every approved suite path and rolls back promotion, but no broad index path',
    rolled.ok && promotionRollbacks === 1 && resetCalls.length === 1
      && resetCalls[0].join(' ') === `reset -q -- ${gated.map((g) => g.rel).join(' ')}`);
}

// The race a path-limited porcelain commit cannot close: it reads approved paths from the
// working tree again. The private index freezes those bytes first, and commit-tree consumes the
// resulting immutable tree even when the same suite changes before commit creation.
{
  const F = require(SCRIPT);
  const { suiteHash, workingTreeEntries } = require(path.join(ROOT, 'runner', 'suite-hash.js'));
  const w = makeWorld();
  const id = 'app-snapshot-race';
  const rel = writeSuite(w, id, 'ORIGINAL VALIDATED SUITE\n');
  const hash = suiteHash(workingTreeEntries(w.target, rel));
  fs.writeFileSync(path.join(w.target, rel, '.freeze-gate.json'), `${JSON.stringify({
    gateVersion: 1, verdict: 'red', probeSupplied: true, suiteHash: hash,
  })}\n`);
  const head = git(w.target, ['rev-parse', 'HEAD']).out.trim();
  const gated = [{ id, rel, verdict: 'red' }];
  const snapshot = F.prepareFreezeSnapshot({ targetRepoPath: w.target }, gated, head, undefined, TMP);
  check('A14 the isolated index captures and validates an exact candidate tree',
    snapshot.ok && /^[0-9a-f]{40}$/.test(snapshot.tree) && stagedIn(w) === '');

  fs.writeFileSync(path.join(w.target, rel, 'test.js'), 'CONCURRENT SAME-SUITE MUTATION\n');
  const made = F.makeFreezeCommit({ targetRepoPath: w.target }, gated, snapshot, 'fixture freeze', 'red');
  const committedBytes = made.ok
    ? git(w.target, ['show', `${made.commit}:${rel}/test.js`]).out : '';
  check('A15 a same-suite edit after snapshot validation cannot enter the candidate commit',
    made.ok && committedBytes === 'ORIGINAL VALIDATED SUITE\n');
  check('A16 candidate creation preserves the concurrent working edit and does not move HEAD',
    fs.readFileSync(path.join(w.target, rel, 'test.js'), 'utf8') === 'CONCURRENT SAME-SUITE MUTATION\n'
      && git(w.target, ['rev-parse', 'HEAD']).out.trim() === head);
  F.removeSnapshot(snapshot);
}

// Publication consumes the immutable candidate OID, not HEAD. A different local process can
// fast-forward the checked-out branch after the atomic update-ref; that later commit must not
// ride into this command's remote publication.
{
  const F = require(SCRIPT);
  const w = makeWorld();
  const id = 'app-push-race';
  const rel = writeSuite(w, id, 'VALIDATED PUBLICATION\n');
  const { suiteHash, workingTreeEntries } = require(path.join(ROOT, 'runner', 'suite-hash.js'));
  const hash = suiteHash(workingTreeEntries(w.target, rel));
  fs.writeFileSync(path.join(w.target, rel, '.freeze-gate.json'), `${JSON.stringify({
    gateVersion: 1, verdict: 'red', probeSupplied: true, suiteHash: hash,
  })}\n`);
  const head = git(w.target, ['rev-parse', 'HEAD']).out.trim();
  const gated = [{ id, rel, verdict: 'red' }];
  const snapshot = F.prepareFreezeSnapshot({ targetRepoPath: w.target }, gated, head, undefined, TMP);
  const made = F.makeFreezeCommit({ targetRepoPath: w.target }, gated, snapshot, 'fixture freeze', 'red');
  git(w.target, ['update-ref', 'refs/heads/master', made.commit, head]);

  // Simulate a concurrent local fast-forward without changing the validated commit object.
  const laterTree = git(w.target, ['rev-parse', `${made.commit}^{tree}`]).out.trim();
  const later = spawnSync('git', ['commit-tree', laterTree, '-p', made.commit], {
    cwd: w.target, input: 'concurrent local commit\n', encoding: 'utf8',
  }).stdout.trim();
  git(w.target, ['update-ref', 'refs/heads/master', later, made.commit]);
  const pushed = F.pushFreezeCommit({ targetRepoPath: w.target, targetRepoRemote: w.origin },
    'master', made.commit, head);
  const remote = git(w.target, ['ls-remote', w.origin, 'refs/heads/master']).out.trim().split(/\s+/)[0];

  check('A17 a concurrent local branch fast-forward cannot change the exact validated push source',
    pushed.ok && remote === made.commit && git(w.target, ['rev-parse', 'HEAD']).out.trim() === later);

  // Once the remote moves too, the original baseline lease is stale. Even though the validated
  // object still exists locally, publication must refuse and leave the newer remote tip intact.
  git(w.target, ['push', '-q', w.origin, `${later}:refs/heads/master`]);
  const refused = F.pushFreezeCommit({ targetRepoPath: w.target, targetRepoRemote: w.origin },
    'master', made.commit, head);
  const remoteAfterRace = git(w.target, ['ls-remote', w.origin, 'refs/heads/master']).out.trim().split(/\s+/)[0];
  check('A18 an exact remote lease refuses a concurrent publisher without changing its commit',
    !refused.ok && remoteAfterRace === later);
  F.removeSnapshot(snapshot);
}

// ---- B. commit refuses before it touches anything -------------------------------------------
{
  const w = makeWorld();
  const before = headCount(w);

  const missing = cli(w, ['commit', 'app-nope', '--config', w.cfgFile]);
  check('B1 an issue with no suite directory is refused', missing.code === 1);
  check('B2 and the refusal names the path it looked for',
    /tests\/acceptance\/app-nope\//.test(missing.text));
  // The wording is load-bearing: this refusal is the tool working, and a planner who reads it
  // as a bug goes looking for a broken command instead of writing the tests.
  check('B3 and says the tests are written with the user, not by this command',
    /PLANNING\.md step 3/.test(missing.text) && /never by this command/.test(missing.text));
  check('B4 and nothing was committed', headCount(w) === before);

  // An empty directory is the vacuous freeze the whole gate exists to prevent: the verifier
  // would exit 1 on "no test files" for all three attempts.
  fs.mkdirSync(path.join(w.target, 'tests', 'acceptance', 'app-empty'), { recursive: true });
  const empty = cli(w, ['commit', 'app-empty', '--config', w.cfgFile]);
  check('B5 a suite directory holding no test files is refused', empty.code === 1);
  check('B6 and the refusal says why an empty suite is worse than a missing one',
    /no test files/.test(empty.text));
  check('B7 and still nothing was committed', headCount(w) === before);
}

// ---- C. the gate's verdict decides, and a refusal freezes nothing ---------------------------
{
  const w = makeWorld();
  const before = headCount(w);

  // A suite that PASSES at the fork point is satisfied by an empty diff: it would pass a correct
  // submission, a broken one and no submission at all. The gate calls that green and it is a spec
  // bug, so the freeze must stop — this is the verdict the whole gate exists to produce.
  const dir = path.join(w.target, 'tests', 'acceptance', 'app-green');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'green.js'), 'process.exit(0);\n');
  const greenWorld = cli(w, ['commit', 'app-green', '--config', w.cfgFile]);
  check('C1 a verdict other than red or half-proven refuses the freeze', greenWorld.code === 1);
  check('C2 and the refusal names the gate\'s own word for the verdict',
    /the gate says green/.test(greenWorld.text));
  check('C3 and says explicitly that nothing was staged, committed or pushed',
    /nothing has been staged, committed or pushed/.test(greenWorld.text));
  check('C4 and that is true of the tree as well as the message',
    headCount(w) === before && stagedIn(w) === '');
}

// ---- D. half-proven is a decision, not a default --------------------------------------------
{
  const w = makeWorld();
  writeSuite(w, 'app-hp');

  const refused = cli(w, ['commit', 'app-hp', '--config', w.cfgFile]);
  check('D1 a red suite with no probe is refused as half-proven by default', refused.code === 1);
  check('D2 and the refusal says what a probe would have proved',
    /no probe has ever shown an implementation can turn it green/.test(refused.text));
  check('D3 and names both ways forward', /--probe/.test(refused.text) && /--allow-half-proven/.test(refused.text));
  check('D4 and froze nothing', onRemote(w, 'tests/acceptance/app-hp') === '');

  // THE FLAG ALONE IS NOT ENOUGH, and this is the check that found the hole. A run refuses a
  // half-proven suite unless its config says otherwise, so a command that pushed one on the
  // strength of its own flag would manufacture the exact state it exists to prevent: a freeze
  // reported as done, sitting on the branch, that no run will ever take.
  const flagOnly = cli(w, ['commit', 'app-hp', '--config', w.cfgFile, '--allow-half-proven']);
  check('D5 the flag alone is refused when the run config does not admit half-proven', flagOnly.code === 1);
  check('D6 and the refusal explains that the runner would refuse it at dispatch',
    /the runner would refuse it at dispatch/.test(flagOnly.text) && /allowHalfProven/.test(flagOnly.text));
  check('D7 and nothing reached the remote on the strength of the flag',
    onRemote(w, 'tests/acceptance/app-hp') === '');

  // With the config agreeing, the same freeze proceeds — and the proof at the end is the runner
  // reading its own `allowHalfProven`, so the two settings are checked against each other for real.
  const permissive = path.join(w.base, 'run.config.permissive.json');
  fs.writeFileSync(permissive, JSON.stringify({
    targetRepoPath: w.target, targetRepoRemote: w.origin, image: 'fixture:latest', allowHalfProven: true,
  }, null, 2));
  const taken = cli(w, ['commit', 'app-hp', '--config', permissive, '--allow-half-proven']);
  check('D8 with the run config admitting it, the same freeze proceeds', taken.code === 0);
  check('D9 and the suite reaches the remote', /app-hp\/test\.js/.test(onRemote(w, 'tests/acceptance/app-hp')));
}

// ---- E. the happy path, proved by the runner rather than by the command ----------------------
{
  const w = makeWorld();
  writeSuite(w, 'app-1');
  const probe = makeProbe(w, 'app-1');

  const dry = cli(w, ['commit', 'app-1', '--config', w.cfgFile, '--probe', probe, '--dry-run']);
  check('E1 --dry-run gates the suite and reports the verdict', dry.code === 0 && /red/.test(dry.text));
  check('E2 and commits nothing', onRemote(w, 'tests/acceptance/app-1') === '' && stagedIn(w) === '');
  check('E3 and says so rather than leaving the operator to infer it',
    /nothing was staged, committed or pushed/.test(dry.text));

  const r = cli(w, ['commit', 'app-1', '--config', w.cfgFile, '--probe', probe]);
  check('E4 a red suite with a satisfying probe freezes', r.code === 0);
  check('E5 the integration branch is read from the target, never guessed as main',
    /integration branch: master/.test(r.text));

  const listed = onRemote(w, 'tests/acceptance/app-1');
  check('E6 the suite is on the REMOTE, not merely committed locally', /app-1\/test\.js/.test(listed));
  // The receipt is the third admission rule. A freeze that pushed the tests and left the
  // receipt behind is refused at dispatch, which is the failure this command is automating away.
  check('E7 and the freeze receipt went with it in the same push', /app-1\/\.freeze-gate\.json/.test(listed));

  // THE ASSERTION THE WHOLE FILE IS FOR. Not "the command said frozen" — the runner's own gate,
  // reading the branch the container will fork from, by the same code path a launch uses.
  const { partitionByFreeze } = require(path.join(ROOT, 'runner', 'queue.js'));
  const { loadConfig } = require(path.join(ROOT, 'runner', 'config.js'));
  const verdict = partitionByFreeze(loadConfig(w.cfgFile), [{ id: 'app-1' }]);
  check('E8 the runner itself will dispatch what this command froze',
    verdict.ok && verdict.issues.length === 1 && (verdict.undispatchable || []).length === 0);
  check('E9 and the command reported that proof rather than its own belief',
    /the runner will dispatch it/.test(r.text));

  // Re-freezing an unchanged suite is a no-op, not an empty commit claiming to have frozen
  // something. A commit with nothing in it is a lie in the history.
  const again = cli(w, ['commit', 'app-1', '--config', w.cfgFile, '--probe', probe]);
  check('E10 re-freezing an unchanged suite makes no empty commit',
    again.code === 0 && /nothing to commit/.test(again.text));
}

// ---- E2. managed proof promotes the exact authored suite only inside approved freeze ---------
{
  const w = makeWorld();
  const managed = makeManagedProbe(w, 'app-managed');
  const suite = path.join(w.target, 'tests', 'acceptance', 'app-managed');

  const dry = cli(w, ['commit', 'app-managed', '--config', w.cfgFile, '--probe', managed.probe, '--dry-run']);
  check('E11 managed dry-run reruns the complete gate without copying the suite',
    dry.code === 0 && /gated and would be frozen/.test(dry.text) && !fs.existsSync(suite));
  check('E12 managed dry-run retains its proof and changes no remote state',
    fs.existsSync(managed.container) && onRemote(w, 'tests/acceptance/app-managed') === '');

  const frozen = cli(w, ['commit', 'app-managed', '--config', w.cfgFile, '--probe', managed.probe]);
  check('E13 approved managed freeze promotes and freezes the exact proven suite',
    frozen.code === 0 && /promoted the exact proven suite/.test(frozen.text)
    && /app-managed\/test\.js/.test(onRemote(w, 'tests/acceptance/app-managed')));
  check('E14 a consumed managed probe is removed only after successful push and readback',
    !fs.existsSync(managed.container) && /removed the consumed disposable green probe/.test(frozen.text));
}

// ---- E3. individually managed proofs freeze as one atomic publication ------------------------
{
  const w = makeWorld();
  const first = makeManagedProbe(w, 'app-bulk-a');
  const second = makeManagedProbe(w, 'app-bulk-b');
  const before = headCount(w);
  const frozen = cli(w, [
    'commit', 'app-bulk-a', 'app-bulk-b', '--config', w.cfgFile,
    '--managed-probe', `app-bulk-a=${first.probe}`,
    '--managed-probe', `app-bulk-b=${second.probe}`,
  ]);
  check('E15 two same-base managed proofs freeze in one command', frozen.code === 0);
  check('E16 the atomic batch advances the integration branch exactly once', headCount(w) === before + 1);
  check('E17 both exact suites and receipts reach the same remote commit', (() => {
    const a = onRemote(w, 'tests/acceptance/app-bulk-a');
    const b = onRemote(w, 'tests/acceptance/app-bulk-b');
    return /app-bulk-a\/test\.js/.test(a) && /app-bulk-a\/\.freeze-gate\.json/.test(a)
      && /app-bulk-b\/test\.js/.test(b) && /app-bulk-b\/\.freeze-gate\.json/.test(b);
  })());
  const { partitionByFreeze } = require(path.join(ROOT, 'runner', 'queue.js'));
  const { loadConfig } = require(path.join(ROOT, 'runner', 'config.js'));
  const verdict = partitionByFreeze(loadConfig(w.cfgFile), [{ id: 'app-bulk-a' }, { id: 'app-bulk-b' }]);
  check('E18 runner readback admits every suite in the managed batch',
    verdict.ok && verdict.issues.length === 2 && (verdict.undispatchable || []).length === 0);
  check('E19 all managed containers survive until push/readback and are then consumed',
    !fs.existsSync(first.container) && !fs.existsSync(second.container));
}

// ---- E4. managed mapping refuses before any suite is promoted -------------------------------
{
  const w = makeWorld();
  const first = makeManagedProbe(w, 'app-map-a');
  const second = makeManagedProbe(w, 'app-map-b');
  const before = headCount(w);
  const refused = cli(w, [
    'commit', 'app-map-a', 'app-map-b', '--config', w.cfgFile,
    '--managed-probe', `app-map-a=${first.probe}`,
    '--managed-probe', `app-map-a=${second.probe}`,
  ]);
  check('E20 duplicate or missing managed mappings are refused', refused.code === 2 && /repeated|missing/.test(refused.text));
  check('E21 mapping refusal writes no suite, commit or remote state',
    headCount(w) === before
    && !fs.existsSync(path.join(w.target, 'tests', 'acceptance', 'app-map-a'))
    && !fs.existsSync(path.join(w.target, 'tests', 'acceptance', 'app-map-b'))
    && onRemote(w, 'tests/acceptance/app-map-a') === ''
    && onRemote(w, 'tests/acceptance/app-map-b') === '');
}

// ---- E5. one stale managed proof refuses the whole batch before promotion --------------------
{
  const w = makeWorld();
  const first = makeManagedProbe(w, 'app-stale-a');
  const second = makeManagedProbe(w, 'app-stale-b');
  const markerFile = path.join(second.container, PROOF.MARKER);
  const marker = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
  marker.head = '0'.repeat(40);
  fs.writeFileSync(markerFile, JSON.stringify(marker, null, 2));
  const before = headCount(w);
  const refused = cli(w, [
    'commit', 'app-stale-a', 'app-stale-b', '--config', w.cfgFile,
    '--managed-probe', `app-stale-a=${first.probe}`,
    '--managed-probe', `app-stale-b=${second.probe}`,
  ]);
  check('E22 one stale managed proof refuses the complete batch by issue name',
    refused.code === 1 && /app-stale-b/.test(refused.text) && /current HEAD/.test(refused.text));
  check('E23 stale-proof refusal precedes every promotion, commit, cleanup and push',
    headCount(w) === before
    && !fs.existsSync(path.join(w.target, 'tests', 'acceptance', 'app-stale-a'))
    && !fs.existsSync(path.join(w.target, 'tests', 'acceptance', 'app-stale-b'))
    && fs.existsSync(first.container) && fs.existsSync(second.container)
    && onRemote(w, 'tests/acceptance/app-stale-a') === ''
    && onRemote(w, 'tests/acceptance/app-stale-b') === '');
}

// ---- F. it never commits work it did not stage ------------------------------------------------
{
  const w = makeWorld();
  writeSuite(w, 'app-2');
  const probe = makeProbe(w, 'app-2');

  // Another session's staged work, sitting in the index of a shared checkout. Committing the
  // index here would carry it into a commit about a freeze, under this command's message — the
  // accident CLAUDE.md's staging rule was written after.
  fs.writeFileSync(path.join(w.target, 'someone-elses.txt'), 'uncommitted work with no copy anywhere\n');
  git(w.target, ['add', '--', 'someone-elses.txt']);

  const r = cli(w, ['commit', 'app-2', '--config', w.cfgFile, '--probe', probe]);
  check('F1 a target checkout with a dirty index is refused', r.code === 1);
  check('F2 and the refusal names the paths that would have ridden along',
    /someone-elses\.txt/.test(r.text));
  check('F3 and leaves them staged and uncommitted, exactly as they were',
    stagedIn(w) === 'someone-elses.txt' && onRemote(w, 'tests/acceptance/app-2') === '');

  git(w.target, ['reset', '-q', '--', 'someone-elses.txt']);
  const ok = cli(w, ['commit', 'app-2', '--config', w.cfgFile, '--probe', probe]);
  check('F4 with the index clean the same freeze proceeds', ok.code === 0);
  // The freeze commit carries the SUITE and nothing else — the untracked file beside it is
  // still untracked, which is what "stage named paths" means as an observable fact.
  const committed = git(w.target, ['show', '--name-only', '--format=', 'HEAD']).out.trim();
  check('F5 and the freeze commit holds only the suite it froze',
    committed.split(/\r?\n/).every((l) => !l.trim() || l.startsWith('tests/acceptance/app-2')));
  check('F6 and the unrelated file is untouched',
    fs.readFileSync(path.join(w.target, 'someone-elses.txt'), 'utf8').startsWith('uncommitted'));
}

// ---- G. it never moves a working tree it does not own -------------------------------------------
{
  const w = makeWorld();
  writeSuite(w, 'app-3');
  const probe = makeProbe(w, 'app-3');
  git(w.target, ['checkout', '-q', '-b', 'some-other-work']);

  const r = cli(w, ['commit', 'app-3', '--config', w.cfgFile, '--probe', probe]);
  check('G1 a target checkout parked on another branch is refused', r.code === 1);
  check('G2 and the refusal names both branches', /some-other-work/.test(r.text) && /master/.test(r.text));
  check('G3 and says the switch is the operator\'s to make',
    /never moves a working tree it does not own/.test(r.text));
  check('G4 and the checkout is still on the branch the operator left it on',
    git(w.target, ['rev-parse', '--abbrev-ref', 'HEAD']).out.trim() === 'some-other-work');
}

// ---- H. a batch is all-or-nothing ----------------------------------------------------------------
{
  const w = makeWorld();
  writeSuite(w, 'app-a');
  writeSuite(w, 'app-b');
  const probeA = makeProbe(w, 'app-a');
  const before = headCount(w);

  // `app-b` has no probe of its own, so the batch is red-with-probe and red-without: the second
  // id lands on half-proven and the whole batch must stop. A command that committed the first
  // and refused the second would leave a tree the operator did not make.
  const r = cli(w, ['commit', 'app-a', 'app-b', '--config', w.cfgFile, '--probe', probeA]);
  check('H1 a batch in which one suite is refused freezes none of them', r.code === 1);
  check('H2 and no commit was made for the suite that passed its gate', headCount(w) === before);
  check('H3 and neither suite reached the remote',
    onRemote(w, 'tests/acceptance/app-a') === '' && onRemote(w, 'tests/acceptance/app-b') === '');
}

// ---- I. status: the question nobody could ask in advance -------------------------------------------
{
  const w = makeWorld();

  // The bd seam the runner already owns, stubbed the way every other suite here stubs it. The
  // stand-aside guard is load-bearing: `--require` reaches the `freeze.js` child too, and an
  // unguarded stub would exit the reader before its first line.
  const bdStub = path.join(w.base, 'bd-stub.js');
  const queueFile = path.join(w.base, 'queue.json');
  fs.writeFileSync(bdStub, [
    "'use strict';",
    "const fs = require('fs');",
    'const argv = process.argv.slice(1);',
    "if (argv.some((a) => /freeze\\.js$/.test(String(a)))) return;",
    // The MAIN MODULE PATH, not the bare word. `spawnSync(node, ['ready', …])` makes node
    // resolve `ready` against its cwd, so `process.argv[1]` is an absolute path ending in
    // `ready` — a stub comparing against the literal stands aside and node then fails to load
    // a module called `ready`, which surfaces as "the Beads queue could not be read" and sends
    // a reader to the wrong system entirely.
    "if (!argv.some((a) => /[\\\\/]ready$/.test(String(a)))) return;",
    "process.stdout.write(fs.readFileSync(process.env.QUEUE_FILE, 'utf8'));",
    'process.exit(0);',
  ].join('\n'));
  const withQueue = (entries) => {
    fs.writeFileSync(queueFile, JSON.stringify(entries));
    return {
      PIPELINE_BD_CMD: process.execPath,
      QUEUE_FILE: queueFile,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require "${fwd(bdStub)}"`.trim(),
    };
  };

  const empty = cli(w, ['status', '--config', w.cfgFile], withQueue([]));
  check('I1 an empty ready queue is a legitimate no-op and exits 0', empty.code === 0);
  check('I2 and says so, rather than reporting a problem',
    /legitimate no-op/.test(empty.text));

  const allRefused = cli(w, ['status', '--config', w.cfgFile],
    withQueue([{ id: 'app-x', title: 'unfrozen', issue_type: 'task', priority: 1 }]));
  // THE SIGNAL. A run in this state exits 0 today and does nothing; asked in advance, the answer
  // has to be one a script can act on.
  check('I3 a queue that can dispatch nothing exits non-zero', allRefused.code === 1);
  check('I4 and leads with the count, not with the word "empty"',
    /would dispatch right now: 0 of 1/.test(allRefused.text));
  check('I5 and names the remedy for the refusal it found',
    /remedy: .*freeze\.js commit/.test(allRefused.text));

  // A partly-frozen queue is the NORMAL state of a project being worked, and must not fail.
  writeSuite(w, 'app-y');
  const probe = makeProbe(w, 'app-y');
  cli(w, ['commit', 'app-y', '--config', w.cfgFile, '--probe', probe]);
  const mixed = cli(w, ['status', '--config', w.cfgFile], withQueue([
    { id: 'app-y', title: 'frozen', issue_type: 'task', priority: 0 },
    { id: 'app-x', title: 'unfrozen', issue_type: 'task', priority: 1 },
  ]));
  check('I6 a partly-frozen queue exits 0 — it is the normal state, not a failure', mixed.code === 0);
  check('I7 and reports both populations', /DISPATCHABLE \(1\)/.test(mixed.text) && /NOT DISPATCHABLE \(1\)/.test(mixed.text));
  check('I8 and the dispatchable one is the one that was frozen',
    /app-y/.test(mixed.text.split('NOT DISPATCHABLE')[0]));

  // Epic parents are filtered by TYPE and are not a finding — `bd ready` returns them by design
  // and the runner drops them, so calling one refused would raise a false alarm on every run.
  const withEpic = cli(w, ['status', '--config', w.cfgFile], withQueue([
    { id: 'app-y', title: 'frozen', issue_type: 'task', priority: 0 },
    { id: 'app-e', title: 'the parent', issue_type: 'epic', priority: 0 },
  ]));
  check('I9 an epic parent is filtered by type, never reported as unfrozen',
    withEpic.code === 0 && /filtered by type \(1, expected\)/.test(withEpic.text)
    && !/app-e/.test(withEpic.text.split('filtered by type')[0]));

  // status writes nothing, anywhere. It is safe to run while a run is in flight, and a reader
  // with a side effect is the thing §5 forbids.
  check('I10 status leaves the target checkout untouched', stagedIn(w) === '');
}

// ---- J. the rule is not restated here ----------------------------------------------------------
{
  const src = fs.readFileSync(SCRIPT, 'utf8');
  // A second implementation of "is this frozen?" would agree with the runner on the day it was
  // written and drift after. The command must reach for the runner's own gate and own nothing.
  check('J1 the command imports the runner\'s dispatch gate rather than reimplementing it',
    /partitionByFreeze/.test(src) && /require\('\.\.\/runner\/queue'\)/.test(src));
  // It reads `suiteHash` — that is how it tells a re-freeze of an unchanged suite from a real
  // one — and that is a comparison of the gate's own output with itself, not a judgement. What
  // it must never own is the ACCEPTANCE vocabulary: which receipt versions are readable and
  // which verdicts a run will take are the runner's rules, and a second copy here would agree
  // today and drift the first time either moved.
  check('J2 it owns no version-acceptance rule of its own', !/gateVersion|KNOWN_GATE_VERSIONS/.test(src));
  check('J2b and the verdicts it proceeds on are checked against the runner\'s set, not a literal',
    /PROCEEDS/.test(src) && !/'red', *'half-proven'/.test(src.replace(/^\/\/.*$/gm, '')));
  check('J3 and no second copy of the suite path formula',
    (src.match(/tests\/acceptance\//g) || []).length <= 2);
  check('J4 the gate is invoked through process.execPath, not by shelling out to a shebang',
    /spawnSync\(process\.execPath, args/.test(src));
  check('J5 nothing here stages a folder', !/'add', '-A'|'add', '\.'/.test(src));
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
