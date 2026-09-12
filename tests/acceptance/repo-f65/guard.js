// Frozen acceptance test — repo-f65, the [guard] half: concurrent task PRs must become
// mergeable AS A BATCH without spending anything the single-task path already has.
//
// [guard] Every check in this file is GREEN at the fork point and must stay green. It is the
// whole of criterion C5 — "existing single-task, frozen-suite, credential-scan, and mandatory-
// regression behavior remains green" — and nothing else in this suite proves C5. Every red
// check for C1-C4 lives in `test.js` beside it.
//
// Nothing red belongs in this file. A [guard] file that is red at the fork point is a stale pin
// and refuses the freeze outright (`scripts/freeze-gate.js`, verdict `stale-guard`).
//
// SPEC DEFECT, REPORTED NOT PAPERED OVER — and the same one `repo-rj7`'s guard reported, for
// the same reason. C5 names four BEHAVIOURS by the name of the machinery that carries them,
// and three of those four live behind frozen files. "Frozen-suite behavior" is
// `runner/suite-hash.js` plus `tools/run-acceptance.sh` and `pipeline.config.json`'s
// `frozenPaths`; "credential-scan behavior" is `runner/credential-scan.js`; the regression
// suites that would exercise them are `scripts/test-*.sh` and `tests/unit/`. A frozen
// acceptance suite may never EDIT those files, and it may not shell into a suite it cannot
// adjust — the freeze gate additionally runs this guard subset ALONE in a flat scratch
// directory, where no sibling helper is reachable and no `scripts/test-*.sh` may be assumed to
// be runnable in this environment. Reading a frozen module and asserting its behaviour is not
// editing it, so C5 is proven here the way `repo-rj7` and `repo-yk4` proved their own
// frozen-script criteria: as the SUBSTANCE those suites carry, restated directly against
// `runner/workspace.js`, `runner/publish.js`, `runner/credential-scan.js` and
// `runner/suite-hash.js`, plus the static fact that each named suite file is still present.
// "The configured regression command is green" stays a pipeline-level gate; no acceptance
// suite in this project can honestly claim it.
//
// SELF-CONTAINED ON PURPOSE. It starts no container engine, opens no network, needs no `bd`
// and no `gh`, and resolves the repository the way every suite here does — the tree it sits
// in, never the cwd. Every fixture is a throwaway repository under the OS temp directory; the
// only repository this file reads in place is its own, and only to read.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..', '..');
const WORKSPACE = path.join(REPO, 'runner', 'workspace.js');
const PUBLISH = path.join(REPO, 'runner', 'publish.js');
const CREDENTIAL_SCAN = path.join(REPO, 'runner', 'credential-scan.js');
const SUITE_HASH = path.join(REPO, 'runner', 'suite-hash.js');

// Fixtures are routinely owned by another uid inside a container, and a frozen test must not
// depend on ambient git config.
const GIT_SAFE = ['-c', 'safe.directory=*'];

let failed = 0;
function check(name, cond, detail) {
  console.log(`${cond ? 'ok' : 'FAIL'} - ${name}${!cond && detail ? ` — ${detail}` : ''}`);
  if (!cond) failed = 1;
}
function git(cwd, ...args) {
  return spawnSync('git', [...GIT_SAFE, ...args], {
    cwd, encoding: 'utf8', timeout: 60000, maxBuffer: 64 * 1024 * 1024, windowsHide: true,
  });
}
// Temp trees hold objects git wrote read-only. Clear the bits before removing, and never let
// disposal decide a verdict.
function rmrf(target) {
  const walk = (p) => {
    let stat;
    try { stat = fs.lstatSync(p); } catch { return; }
    try { fs.chmodSync(p, 0o700); } catch { /* best effort */ }
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      let names = [];
      try { names = fs.readdirSync(p); } catch { names = []; }
      for (const n of names) walk(path.join(p, n));
    }
  };
  walk(target);
  try { fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  catch { /* disposable */ }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-f65-'));
const CFG = { gitTimeoutMs: 60000, bdTimeoutMs: 60000, lifecycleTimeoutMs: 60000 };
const LOG = { runId: 'GUARD-F65', info() {}, error() {} };
const write = (dir, rel, text) => {
  const full = path.join(dir, ...rel.split('/'));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text);
};

function body() {
  // ---- C5, the surface every existing behaviour is reached through ------------------------
  // Asserted before it is used, so a moved export is one named failure instead of a thrown
  // stack that says nothing about which entry point went.
  let workspace = null; let publishMod = null; let scanMod = null; let hashMod = null;
  try { workspace = require(WORKSPACE); } catch { workspace = null; }
  try { publishMod = require(PUBLISH); } catch { publishMod = null; }
  try { scanMod = require(CREDENTIAL_SCAN); } catch { scanMod = null; }
  try { hashMod = require(SUITE_HASH); } catch { hashMod = null; }

  const has = (mod, ...names) => !!mod && names.every((n) => typeof mod[n] === 'function');
  check('C5 [guard] runner/workspace.js still exports the single-task preparation surface',
    has(workspace, 'prepare', 'chooseBranch', 'hasCommits', 'regressionPolicyAt', 'discard'));
  check('C5 [guard] runner/publish.js still exports the publication boundary',
    has(publishMod, 'publish', 'buildPrBody', 'pushBranch', 'openPr')
    && !!publishMod && publishMod.PR_ELIGIBLE_OUTCOMES instanceof Set);
  check('C5 [guard] runner/credential-scan.js still exports the pre-push scan',
    has(scanMod, 'scanIntroducedObjects', 'introducedObjectIds', 'findingIn', 'scanBatch'));
  check('C5 [guard] runner/suite-hash.js still exports the frozen-suite identity surface',
    has(hashMod, 'suiteHash', 'workingTreeEntries', 'treeEntries', 'isGitRepo', 'headCommit')
    && !!hashMod && typeof hashMod.RECEIPT_NAME === 'string');
  if (!workspace || !publishMod || !scanMod || !hashMod) {
    console.log('FAIL - HARNESS: an entry point could not be loaded; the rest of C5 cannot run');
    process.exit(1);
  }

  // ---- C5, single-task behaviour: branch naming, commit detection, publication policy ------
  // A bare repository plus one clone is the whole world `runner/workspace.js` needs; no
  // network, no GitHub, and no `origin` that is not on this disk.
  const bare = path.join(tmp, 'origin.git');
  fs.mkdirSync(bare, { recursive: true });
  git(bare, 'init', '-q', '--bare', '-b', 'main');
  const seed = path.join(tmp, 'seed');
  fs.mkdirSync(seed, { recursive: true });
  git(seed, 'init', '-q', '-b', 'main');
  git(seed, 'config', 'user.email', 'fixture@test.local');
  git(seed, 'config', 'user.name', 'fixture');
  write(seed, 'README.md', '# f65 guard fixture\n');
  write(seed, 'pipeline.config.json', `${JSON.stringify({
    verifyCommand: 'sh tools/run-acceptance.sh',
    regressionCommand: 'true',
    regressionPolicy: 'required',
    defaultBranch: 'main',
    frozenPaths: ['tools/run-acceptance.sh'],
  }, null, 2)}\n`);
  git(seed, 'add', '-A');
  git(seed, 'commit', '-qm', 'seed');
  git(seed, 'remote', 'add', 'origin', bare);
  git(seed, 'push', '-q', 'origin', 'main');
  const clone = path.join(tmp, 'clone');
  git(tmp, 'clone', '-q', bare, clone);
  git(clone, 'config', 'user.email', 'fixture@test.local');
  git(clone, 'config', 'user.name', 'fixture');
  const forkPoint = String(git(clone, 'rev-parse', 'HEAD').stdout || '').trim();

  check('C5 [guard] harness: the single-task fixture clone has a fork point',
    /^[0-9a-f]{40}$/.test(forkPoint), forkPoint);
  check('C5 [guard] a free task branch is still named task/<issue-id>',
    workspace.chooseBranch(clone, 'f65-guard', CFG) === 'task/f65-guard');
  // Never force-push: an earlier attempt's branch survives and the next run steps around it.
  git(seed, 'checkout', '-q', '-b', 'task/f65-guard');
  git(seed, 'push', '-q', 'origin', 'task/f65-guard');
  git(clone, 'fetch', '-q', 'origin');
  check('C5 [guard] a taken task branch still steps aside to -r2 rather than being reused',
    workspace.chooseBranch(clone, 'f65-guard', CFG) === 'task/f65-guard-r2');

  check('C5 [guard] a branch with no commits since the fork point still reports none',
    workspace.hasCommits(clone, forkPoint, CFG) === false);
  write(clone, 'runner/alpha.js', '// alpha guard\n');
  git(clone, 'add', '-A');
  git(clone, 'commit', '-qm', 'Task f65-guard: implementation (verified on attempt 1)');
  check('C5 [guard] a branch WITH commits since the fork point still reports some',
    workspace.hasCommits(clone, forkPoint, CFG) === true);

  // The load-bearing half: the policy is read from the FORK-POINT blob, never the working
  // tree, so an implementation cannot delete its own publication gate.
  check('C5 [guard] a `required` regression policy is still read from the fork point',
    workspace.regressionPolicyAt(clone, forkPoint, CFG) === 'required');
  write(clone, 'pipeline.config.json', `${JSON.stringify({ regressionPolicy: 'evidence' }, null, 2)}\n`);
  git(clone, 'add', '-A');
  git(clone, 'commit', '-qm', 'Task f65-guard: weaken the gate in the working tree');
  check('C5 [guard] ... and a working tree that weakens it is still ignored',
    workspace.regressionPolicyAt(clone, forkPoint, CFG) === 'required');
  const noConfig = path.join(tmp, 'no-config');
  fs.mkdirSync(noConfig, { recursive: true });
  git(noConfig, 'init', '-q', '-b', 'main');
  git(noConfig, 'config', 'user.email', 'fixture@test.local');
  git(noConfig, 'config', 'user.name', 'fixture');
  write(noConfig, 'README.md', '# no config\n');
  git(noConfig, 'add', '-A');
  git(noConfig, 'commit', '-qm', 'seed');
  check('C5 [guard] a project with no config at the fork point is still evidence-only',
    workspace.regressionPolicyAt(noConfig, String(git(noConfig, 'rev-parse', 'HEAD').stdout).trim(),
      CFG) === 'evidence');

  // ---- C5, mandatory-regression behaviour --------------------------------------------------
  // The gate runs BEFORE anything is pushed, so every case below reaches its verdict without a
  // remote, a credential or a `gh`.
  const wsFor = (policy) => ({
    dir: clone, branch: 'task/f65-guard', forkPoint, defaultBranch: 'main', regressionPolicy: policy,
  });
  const ctx = (policy, regressions, hasCommits) => ({
    ws: wsFor(policy),
    outcome: { status: 'done' },
    hasCommits,
    issueMarkdown: '# f65 guard issue\n',
    status: { changeSummary: 'guard', attempts: [{}] },
    verify: regressions === null ? null : { acceptance: 'pass', regressions },
    issue: { id: 'f65-guard', title: 'guard' },
    runId: 'GUARD-F65',
    secrets: [],
  });
  const refused = publishMod.publish({ ...CFG }, ctx('required', 'fail', true), LOG, 't');
  check('C5 [guard] a required regression gate that did not pass still refuses publication',
    !!refused && refused.ok === false && refused.pushed === false
    && /required regression gate did not pass/i.test(String(refused.error || '')),
    JSON.stringify(refused));
  const missing = publishMod.publish({ ...CFG }, ctx('required', null, true), LOG, 't');
  check('C5 [guard] ... and a MISSING regression verdict is still refused, not assumed pass',
    !!missing && missing.ok === false && missing.pushed === false
    && /\(missing\)/.test(String(missing.error || '')), JSON.stringify(missing));
  const allowed = publishMod.publish({ ...CFG }, ctx('required', 'pass', false), LOG, 't');
  check('C5 [guard] an exact regression pass still gets past the gate',
    !!allowed && allowed.ok === true && allowed.pushed === false && !allowed.error,
    JSON.stringify(allowed));
  const evidenceOnly = publishMod.publish({ ...CFG }, ctx('evidence', 'fail', false), LOG, 't');
  check('C5 [guard] an evidence-only project is still not gated by its regressions',
    !!evidenceOnly && evidenceOnly.ok === true && !evidenceOnly.error, JSON.stringify(evidenceOnly));
  check('C5 [guard] a branch with no commits is still a no-op rather than a failure',
    publishMod.publish({ ...CFG }, ctx('evidence', 'pass', false), LOG, 't').pushed === false);
  check('C5 [guard] only done and partial are still PR-eligible outcomes',
    [...publishMod.PR_ELIGIBLE_OUTCOMES].sort().join(',') === 'done,partial');

  // The PR body is still assembled by the host from structured artifacts only.
  const body1 = publishMod.buildPrBody({
    issueMarkdown: '# spec text', status: { changeSummary: 'summary text', specConcerns: ['the spec is wrong'], attempts: [{}, {}] },
    verify: { acceptance: 'pass', regressions: 'fail', acceptanceOutput: 'acceptance text' },
    outcome: { status: 'partial' }, branch: 'task/f65-guard', runId: 'GUARD-F65',
  });
  check('C5 [guard] the PR body still carries spec, change summary and verification evidence',
    /## Spec/.test(body1) && /spec text/.test(body1)
    && /## Change summary/.test(body1) && /summary text/.test(body1)
    && /## Verification evidence/.test(body1) && /acceptance text/.test(body1));
  check('C5 [guard] a spec concern is still surfaced above the change summary',
    body1.indexOf('the spec is wrong') > -1
    && body1.indexOf('the spec is wrong') < body1.indexOf('## Change summary'));
  check('C5 [guard] a partial outcome still says so in the PR body',
    /PARTIAL — needs scrutiny/.test(body1) && /attempt 2 of 3/.test(body1));

  // ---- C5, credential-scan behaviour -------------------------------------------------------
  // A real repository, because the scan's whole point is that it reads the introduced OBJECT
  // GRAPH rather than the files at the tip.
  const secretRepo = path.join(tmp, 'secrets');
  fs.mkdirSync(secretRepo, { recursive: true });
  git(secretRepo, 'init', '-q', '-b', 'main');
  git(secretRepo, 'config', 'user.email', 'fixture@test.local');
  git(secretRepo, 'config', 'user.name', 'fixture');
  write(secretRepo, 'README.md', '# scan fixture\n');
  git(secretRepo, 'add', '-A');
  git(secretRepo, 'commit', '-qm', 'seed');
  const scanFork = String(git(secretRepo, 'rev-parse', 'HEAD').stdout || '').trim();
  write(secretRepo, 'src/clean.js', '// nothing to see\n');
  git(secretRepo, 'add', '-A');
  git(secretRepo, 'commit', '-qm', 'clean work');
  const clean = scanMod.scanIntroducedObjects(secretRepo, scanFork, ['not-present-anywhere'],
    { timeoutMs: 60000 });
  check('C5 [guard] a clean branch still passes the pre-push scan and says what it scanned',
    !!clean && clean.ok === true && clean.scannedObjects > 0, JSON.stringify(clean));

  // The injected subscription token: committed, then deleted at the tip. The tip is clean and
  // the push would still publish the blob, which is the case this scan exists for.
  const INJECTED = 'f65-guard-injected-subscription-token-000111222';
  write(secretRepo, 'src/oops.txt', `token=${INJECTED}\n`);
  git(secretRepo, 'add', '-A');
  git(secretRepo, 'commit', '-qm', 'oops');
  git(secretRepo, 'rm', '-q', 'src/oops.txt');
  git(secretRepo, 'commit', '-qm', 'remove it again');
  check('C5 [guard] harness: the token is gone from the tip', !fs.existsSync(path.join(secretRepo, 'src', 'oops.txt')));
  const caught = scanMod.scanIntroducedObjects(secretRepo, scanFork, [INJECTED], { timeoutMs: 60000 });
  check('C5 [guard] a secret deleted before the tip is still caught in the introduced objects',
    !!caught && caught.ok === false && caught.finding === 'exact-injected-secret',
    JSON.stringify(caught));
  check('C5 [guard] ... and the refusal still names a kind and an object id, never the bytes',
    !!caught && !String(caught.reason || '').includes(INJECTED)
    && /^[0-9a-f]{12}$/.test(String(caught.objectId || '')), String(caught && caught.reason));
  // Shape detection is independent of any injected list.
  check('C5 [guard] a high-confidence credential SHAPE is still caught with no secret list',
    scanMod.findingIn(Buffer.from('-----BEGIN OPENSSH PRIVATE KEY-----'), []) === 'private-key'
    && scanMod.findingIn(Buffer.from('ghp_abcdefghijklmnopqrstuvwxyz012345'), []) === 'github-token');
  check('C5 [guard] ... and ordinary source vocabulary is still not evidence',
    scanMod.findingIn(Buffer.from('const password = getPassword(apiKey);'), []) === null);
  check('C5 [guard] a scan with no valid fork point is still refused rather than skipped',
    scanMod.introducedObjectIds(secretRepo, 'not-a-sha').ok === false);

  // ---- C5, frozen-suite behaviour ----------------------------------------------------------
  // THE FORMULA, restated rather than imported: sorted bytewise by suite-relative path, then
  // `path\0blob\n` concatenated and sha256'd. Two copies of a formula drift, which is exactly
  // why the guard keeps one — a guard that asks the module to agree with itself proves nothing.
  const restate = (entries) => {
    const h = crypto.createHash('sha256');
    for (const e of [...entries].sort((a, b) => Buffer.compare(
      Buffer.from(String(a.path), 'utf8'), Buffer.from(String(b.path), 'utf8')))) {
      h.update(`${e.path}\0${e.blob}\n`);
    }
    return h.digest('hex');
  };
  const sample = [
    { path: 'test.js', blob: 'a'.repeat(40) },
    { path: 'guard.js', blob: 'b'.repeat(40) },
    { path: 'a/b.js', blob: 'c'.repeat(40) },
  ];
  check('C5 [guard] the suite hash is still the sorted `path\\0blob\\n` sha256',
    hashMod.suiteHash(sample) === restate(sample), hashMod.suiteHash(sample));
  check('C5 [guard] the suite hash is still order-independent in its input',
    hashMod.suiteHash(sample) === hashMod.suiteHash([...sample].reverse()));
  check('C5 [guard] two suites differing only in one blob still hash differently',
    hashMod.suiteHash(sample)
      !== hashMod.suiteHash([...sample.slice(1), { path: 'test.js', blob: 'd'.repeat(40) }]));

  // The working-copy side and the committed side must still agree, because the freeze gate
  // hashes the first and the dispatch gate recomputes the second.
  const suiteRepo = path.join(tmp, 'suite');
  fs.mkdirSync(suiteRepo, { recursive: true });
  git(suiteRepo, 'init', '-q', '-b', 'main');
  git(suiteRepo, 'config', 'user.email', 'fixture@test.local');
  git(suiteRepo, 'config', 'user.name', 'fixture');
  write(suiteRepo, 'tests/acceptance/repo-guard/test.js', 'process.exit(0);\n');
  write(suiteRepo, 'tests/acceptance/repo-guard/guard.js', 'process.exit(0);\n');
  const wtEntries = hashMod.workingTreeEntries(suiteRepo, 'tests/acceptance/repo-guard/');
  check('C5 [guard] an uncommitted suite is still visible to the working-copy hash',
    wtEntries.map((e) => e.path).sort().join(',') === 'guard.js,test.js',
    JSON.stringify(wtEntries));
  git(suiteRepo, 'add', '-A');
  git(suiteRepo, 'commit', '-qm', 'freeze');
  check('C5 [guard] the working copy and the committed tree still hash to the same suite',
    hashMod.suiteHash(wtEntries)
      === hashMod.suiteHash(hashMod.treeEntries(suiteRepo, 'HEAD', 'tests/acceptance/repo-guard/')));
  write(suiteRepo, `tests/acceptance/repo-guard/${hashMod.RECEIPT_NAME}`, '{"verdict":"red"}\n');
  check('C5 [guard] the gate receipt is still excluded from the suite it describes',
    hashMod.suiteHash(hashMod.workingTreeEntries(suiteRepo, 'tests/acceptance/repo-guard/'))
      === hashMod.suiteHash(wtEntries));

  // The frozen list itself, and the files it names. Recorded, never run: see the SPEC DEFECT
  // note at the top of this file.
  let projectCfg = null;
  try { projectCfg = JSON.parse(fs.readFileSync(path.join(REPO, 'pipeline.config.json'), 'utf8')); }
  catch { projectCfg = null; }
  const frozen = (projectCfg && projectCfg.frozenPaths) || [];
  for (const rel of ['tools/run-acceptance.sh', 'scripts/test-ci.sh', 'scripts/test-*.sh',
    'runner/credential-scan.js', 'runner/control-plane.js', 'runner/artifact-schema.js',
    'runner/repo-identity.js', 'runner/process.js', 'contracts/control-plane.json',
    'schemas/status.schema.json', 'schemas/verify.schema.json', 'tests/unit/']) {
    check(`C5 [guard] \`${rel}\` is still a frozen path of this project`, frozen.includes(rel),
      JSON.stringify(frozen));
  }
  check('C5 [guard] the verifier is still invoked as `sh tools/run-acceptance.sh`',
    !!projectCfg && projectCfg.verifyCommand === 'sh tools/run-acceptance.sh');
  check('C5 [guard] this project still declares its regression suite mandatory',
    !!projectCfg && projectCfg.regressionPolicy === 'required');
  for (const rel of ['tools/run-acceptance.sh', 'scripts/test-ci.sh', 'scripts/test-changelog.sh',
    'scripts/test-credential-scan.sh', 'scripts/test-worktree.sh', 'scripts/test-verifier.sh',
    'runner/credential-scan.js', 'runner/suite-hash.js', 'runner/workspace.js',
    'runner/publish.js', 'tests/unit']) {
    check(`C5 [guard] the existing suite or module \`${rel}\` is still present`,
      fs.existsSync(path.join(REPO, ...rel.split('/'))));
  }
}

try {
  body();
} catch (e) {
  failed = 1;
  console.log(`FAIL - HARNESS BROKEN: unexpected exception: ${e && e.stack ? e.stack : e}`);
} finally {
  rmrf(tmp);
  process.exit(failed);
}
