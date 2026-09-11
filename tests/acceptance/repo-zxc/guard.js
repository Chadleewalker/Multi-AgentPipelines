// Frozen acceptance test — repo-zxc, the [guard] half: approved design references become
// resolvable at preparation WITHOUT spending the four guarantees freeze already carries.
//
// [guard] Every check in this file is GREEN at the fork point and must stay green. It is the
// whole of criterion C5 — "existing freeze receipts, issue fingerprints, write protection, and
// mandatory regressions remain green" — and nothing else in this suite proves C5. Every red
// check for C1-C4 lives in `test.js` beside it.
//
// Nothing red belongs in this file. A [guard] file that is red at the fork point is a stale pin
// and refuses the freeze outright (`scripts/freeze-gate.js`, verdict `stale-guard`).
//
// SPEC DEFECT, REPORTED NOT PAPERED OVER. C5's fourth clause is "mandatory regressions remain
// green". This project's mandatory regression is `pipeline.config.json`'s
// `regressionCommand: bash scripts/test-ci.sh` with `regressionPolicy: required` — a frozen path
// under `scripts/test-*.sh`, and a command that itself runs every acceptance suite in
// `tests/acceptance/`, including this one. An acceptance suite that shelled into it would
// recurse, would assert through a file it may not edit, and would be judged in the flat scratch
// directory the gate builds for a guard subset, where no sibling is reachable. So C5's fourth
// clause is proven the way `repo-rj7` and `repo-yk4` proved their own frozen-script criteria: as
// the SUBSTANCE the regression carries for the three subsystems C5 names, restated directly
// against `runner/queue.js`, `runner/suite-hash.js`, `scripts/freeze.js`, `scripts/freeze-gate.js`,
// `scripts/spec-brief.js`, `scripts/prepare-batch.js` and `scripts/write-protection-policy.js`,
// plus the static facts that the regression policy is still declared and every suite file it
// names is still present. "The configured regression command is green" stays a pipeline-level
// gate; no acceptance suite in this project can honestly claim it.
//
// SELF-CONTAINED ON PURPOSE, and it starts no container engine and reaches no network. It
// resolves the repository the way every suite here does — the tree it sits in, never the cwd.
//
// EVERY LOCK AND STATE ROOT IT TAKES IS RE-AIMED. `PIPELINE_GLOBAL_LOCK_DIR` moves the
// host-global canonical-target authority into a disposable temp directory and
// `PREPARATION_RUNS_DIR` does the same for preparation state, so running this file can never
// disturb a live run on the same machine.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..', '..');
const QUEUE = path.join(REPO, 'runner', 'queue.js');
const SUITE_HASH = path.join(REPO, 'runner', 'suite-hash.js');
const FREEZE = path.join(REPO, 'scripts', 'freeze.js');
const FREEZE_GATE = path.join(REPO, 'scripts', 'freeze-gate.js');
const SPEC_BRIEF = path.join(REPO, 'scripts', 'spec-brief.js');
const PREPARE_BATCH = path.join(REPO, 'scripts', 'prepare-batch.js');
const WRITE_PROTECTION = path.join(REPO, 'scripts', 'write-protection-policy.js');

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

// Temp trees hold lock records created with mode 0o600 and, on Windows, files a rename left
// read-only. Clear the bits before removing, and never let disposal decide a verdict.
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-zxc-'));
const savedEnv = {
  lock: process.env.PIPELINE_GLOBAL_LOCK_DIR,
  prep: process.env.PREPARATION_RUNS_DIR,
  bd: process.env.PIPELINE_BD_CMD,
  child: process.env.PIPELINE_CHILD_AUTHORITY,
};
process.env.PIPELINE_GLOBAL_LOCK_DIR = path.join(tmp, 'lockauth');
process.env.PREPARATION_RUNS_DIR = path.join(tmp, 'preparations');
// A `bd` that cannot exist, so no guard check can ever wait on a real Beads database.
process.env.PIPELINE_BD_CMD = path.join(tmp, 'no-such-bd-binary');
delete process.env.PIPELINE_CHILD_AUTHORITY;

function project(name) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// `scripts/prepare-batch.js` exports an ASYNC `main`/`execute`, so the body runs inside one
// async function rather than at module top level: top-level `await` is not available to a
// CommonJS file, and `sh tools/run-acceptance.sh` runs these with plain `node <file>`.
async function body() {
  // ---- C5, the surface every named subsystem is reached through ---------------------------
  // Asserted before it is used, so a missing export is one named failure instead of a thrown
  // stack that says nothing about which entry point moved.
  let queue = null; let hashes = null; let freeze = null; let gate = null;
  let brief = null; let prepare = null; let protection = null;
  try { queue = require(QUEUE); } catch { queue = null; }
  try { hashes = require(SUITE_HASH); } catch { hashes = null; }
  try { freeze = require(FREEZE); } catch { freeze = null; }
  try { gate = require(FREEZE_GATE); } catch { gate = null; }
  try { brief = require(SPEC_BRIEF); } catch { brief = null; }
  try { prepare = require(PREPARE_BATCH); } catch { prepare = null; }
  try { protection = require(WRITE_PROTECTION); } catch { protection = null; }

  const has = (mod, ...names) => !!mod && names.every((n) => typeof mod[n] === 'function');
  check('C5 [guard] runner/queue.js still exports the receipt reader and its refusal vocabulary',
    has(queue, 'parseReceipt', 'partitionByFreeze', 'resolveBranch')
    && !!queue && queue.RECEIPT_VERDICTS instanceof Set && queue.KNOWN_GATE_VERSIONS instanceof Set
    && !!queue.REFUSAL);
  check('C5 [guard] runner/suite-hash.js still exports the one suite-hash formula',
    has(hashes, 'suiteHash', 'workingTreeEntries', 'treeEntries', 'isGitRepo', 'headCommit')
    && !!hashes && hashes.RECEIPT_NAME === '.freeze-gate.json');
  check('C5 [guard] scripts/freeze.js still exports its CLI, verdict map and exit codes',
    has(freeze, 'main', 'parseArgs', 'currentHead') && !!freeze && !!freeze.GATE_VERDICT
    && freeze.PROCEEDS instanceof Set);
  check('C5 [guard] scripts/freeze-gate.js still exports its receipt version and guard scanner',
    has(gate, 'guardFiles', 'guardCount', 'verdictFor', 'lintSuite')
    && !!gate && Number.isInteger(gate.RECEIPT_VERSION) && gate.RECEIPT_NAME === '.freeze-gate.json');
  check('C5 [guard] scripts/spec-brief.js still exports the issue fingerprint helpers',
    has(brief, 'criteriaInfo', 'acceptanceCriteria', 'buildBrief', 'classify'));
  check('C5 [guard] scripts/prepare-batch.js still exports its snapshot fingerprint surface',
    has(prepare, 'main', 'execute', 'parseArgs', 'classifyBuilt', 'snapshotFingerprints',
      'snapshotBatch', 'inspectIntegration'));
  check('C5 [guard] scripts/write-protection-policy.js still exports the admission backstop',
    has(protection, 'admit', 'admissionRefusal', 'classify', 'contract', 'locate', 'contextFor'));
  if (!queue || !hashes || !freeze || !gate || !brief || !prepare || !protection) {
    console.log('FAIL - HARNESS: a named subsystem could not be loaded; the rest of C5 cannot run');
    process.exit(1);
  }

  // ---- C5, freeze receipts ----------------------------------------------------------------
  // The receipt is the fact a run checks instead of trusting that a freeze happened. C1 makes
  // the freeze refuse one more thing; the receipt's own reader, writer version and hash formula
  // must be exactly as they were. Provenance admission stays in preparation rather than
  // changing these established freeze outcomes.
  check('C5 [guard] a receipt is still written for red and half-proven and nothing else',
    [...queue.RECEIPT_VERDICTS].sort().join(',') === 'half-proven,red');
  check('C5 [guard] the freeze command still proceeds on exactly the runner\'s receipt verdicts',
    freeze.PROCEEDS === queue.RECEIPT_VERDICTS);
  check('C5 [guard] the gate\'s six verdict words are still mapped to its six exit codes',
    [0, 1, 2, 3, 4, 5].map((c) => freeze.GATE_VERDICT[c]).join(',')
      === 'red,green,indeterminate,unreachable,half-proven,stale-guard',
    [0, 1, 2, 3, 4, 5].map((c) => freeze.GATE_VERDICT[c]).join(','));
  check('C5 [guard] the version the gate WRITES is still one the runner can read',
    queue.KNOWN_GATE_VERSIONS.has(gate.RECEIPT_VERSION));
  const receiptHash = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
  const goodReceipt = JSON.stringify({
    gateVersion: gate.RECEIPT_VERSION, verdict: 'red', suiteHash: receiptHash,
    probe: false, guards: 1,
  });
  const readGood = queue.parseReceipt(goodReceipt);
  check('C5 [guard] a well-formed receipt is still accepted and reduced to its three load-bearing fields',
    readGood.ok === true && readGood.receipt.verdict === 'red'
    && readGood.receipt.gateVersion === gate.RECEIPT_VERSION
    && readGood.receipt.suiteHash === receiptHash,
    JSON.stringify(readGood));
  for (const [label, text, pattern] of [
    ['an absent receipt', null, /never been run|not pushed/i],
    ['a receipt that is not JSON', '{not json', /not valid JSON/i],
    ['a receipt that is not an object', '[1,2]', /not a receipt object/i],
    ['a receipt from an unknown gate version', JSON.stringify({ gateVersion: 99, verdict: 'red', suiteHash: 'a'.repeat(40) }), /gateVersion/i],
    ['a receipt whose verdict is not one the gate writes', JSON.stringify({ gateVersion: gate.RECEIPT_VERSION, verdict: 'green', suiteHash: 'a'.repeat(40) }), /verdict/i],
    ['a receipt with no usable suite hash', JSON.stringify({ gateVersion: gate.RECEIPT_VERSION, verdict: 'red', suiteHash: true }), /suite hash/i],
  ]) {
    const answer = queue.parseReceipt(text);
    check(`C5 [guard] ${label} is still refused, with a reason a person can act on`,
      answer.ok === false && pattern.test(String(answer.detail || '')),
      JSON.stringify(answer));
  }
  check('C5 [guard] the dispatch refusal vocabulary is unchanged',
    [queue.REFUSAL.NO_SUITE, queue.REFUSAL.NO_RECEIPT, queue.REFUSAL.MISMATCH,
      queue.REFUSAL.HALF_PROVEN].join(',') === 'no-suite,no-receipt,receipt-mismatch,half-proven');

  // The hash the receipt records, and the reason it is over blob ids rather than disk bytes.
  const entriesA = [{ path: 'guard.js', blob: 'b'.repeat(40) }, { path: 'test.js', blob: 'c'.repeat(40) }];
  const entriesB = [{ path: 'test.js', blob: 'c'.repeat(40) }, { path: 'guard.js', blob: 'b'.repeat(40) }];
  check('C5 [guard] the suite hash is still order-independent over its entries',
    hashes.suiteHash(entriesA) === hashes.suiteHash(entriesB));
  check('C5 [guard] the suite hash still changes when a blob changes',
    hashes.suiteHash(entriesA)
      !== hashes.suiteHash([{ path: 'guard.js', blob: 'd'.repeat(40) }, ...entriesA.slice(1)]));
  check('C5 [guard] the suite hash still changes when a path changes',
    hashes.suiteHash(entriesA)
      !== hashes.suiteHash([{ path: 'guard2.js', blob: 'b'.repeat(40) }, ...entriesA.slice(1)]));
  check('C5 [guard] the suite hash is still a sha256 the receipt reader will accept',
    /^[0-9a-f]{64}$/.test(hashes.suiteHash(entriesA))
    && queue.parseReceipt(JSON.stringify({
      gateVersion: gate.RECEIPT_VERSION, verdict: 'half-proven', suiteHash: hashes.suiteHash(entriesA),
    })).ok === true);

  // The guard declaration itself — the mechanism this very file relies on. A freeze whose guard
  // scanner stopped seeing `[guard]` would read every guard as a non-discriminating test.
  const scan = project('guard-scan');
  fs.writeFileSync(path.join(scan, 'declared.js'), '// [guard] a declaration in a comment\n');
  fs.writeFileSync(path.join(scan, 'quoted.js'), 'const G = "[guard]";\n');
  fs.writeFileSync(path.join(scan, 'late.js'), `${'// filler\n'.repeat(12)}// [guard] too late\n`);
  check('C5 [guard] the gate still recognises a [guard] declaration only in a first-ten-lines comment',
    gate.guardFiles(scan).join(',') === 'declared.js', gate.guardFiles(scan).join(','));

  // ---- C5, issue fingerprints -------------------------------------------------------------
  // The fingerprint is what makes an immutable batch immutable: an issue whose criteria moved
  // after the snapshot must not be prepared against the text it no longer has. C1 adds a design
  // reference to the same snapshot; the criteria half must not move.
  const structured = { id: 'zxc-fp', acceptance_criteria: '1. it resolves\n2. it refuses', description: 'x' };
  const infoOne = brief.criteriaInfo(structured);
  const infoTwo = brief.criteriaInfo({ ...structured, title: 'a different title' });
  check('C5 [guard] structured criteria are still fingerprinted by a sha256 of their text alone',
    infoOne.source === 'structured' && /^[0-9a-f]{64}$/.test(infoOne.sha256)
    && infoOne.sha256 === infoTwo.sha256
    && infoOne.sha256 === crypto.createHash('sha256').update('1. it resolves\n2. it refuses').digest('hex'));
  check('C5 [guard] changed criteria still change the fingerprint',
    brief.criteriaInfo({ ...structured, acceptance_criteria: '1. it resolves' }).sha256 !== infoOne.sha256);
  check('C5 [guard] an issue with no criteria at all still fingerprints as source `none`',
    brief.criteriaInfo({ id: 'zxc-empty' }).source === 'none');
  check('C5 [guard] an issue with no criteria is still stopped before authoring, with no action',
    (() => {
      const built = {
        ok: true, id: 'zxc-empty', state: 'write', branch: 'main',
        criteria: { source: 'none', sha256: '', text: '' },
        folder: { dir: path.join(tmp, 'freeze-zxc-empty'), branch: 'freeze-zxc-empty', exists: true },
      };
      const classified = prepare.classifyBuilt('zxc-empty', built);
      return classified.outcome === 'needs-criteria' && !classified.action;
    })());
  check('C5 [guard] the first recorded snapshot of an issue still wins over every later one',
    (() => {
      const events = [
        { type: 'issue.snapshotted', payload: { issueId: 'zxc-fp', criteriaHash: 'a'.repeat(64) } },
        { type: 'issue.snapshotted', payload: { issueId: 'zxc-fp', criteriaHash: 'b'.repeat(64) } },
      ];
      const found = prepare.snapshotFingerprints({ readEvents: () => events }, 'R', 'wave');
      return found.get('zxc-fp').criteriaHash === 'a'.repeat(64);
    })());

  // The same fact through the real coordinator: a resume whose issue text moved since the batch
  // snapshot is attention, and no worker is launched for it.
  const fpTarget = project('zxc-fingerprint-target');
  const fpBuilt = {
    ok: true, id: 'zxc-fp', state: 'write', branch: 'main', text: 'brief',
    cfg: { targetRepoPath: fpTarget },
    policy: { verifyCommand: 'sh tools/run-acceptance.sh', frozenPaths: [] },
    folder: { dir: path.join(tmp, 'freeze-zxc-fp'), branch: 'freeze-zxc-fp', exists: true },
    criteria: { source: 'structured', sha256: 'a'.repeat(64), text: '1. works' },
    issue: { id: 'zxc-fp', title: 'zxc-fp', priority: 2, dependencies: [] },
  };
  const events = []; let workers = 0;
  const resumeState = {
    preparationRoot: () => 'R',
    readManifest: () => ({
      runConfig: 'run.json', concurrency: 2, issues: [{ id: 'zxc-fp' }],
      configHash: 'H', integrationHead: 'f'.repeat(40),
    }),
    canonicalHash: () => 'H',
    redactConfig: (v) => v,
    // The recorded fingerprint disagrees with the issue as it stands now.
    readEvents: () => [{
      type: 'issue.snapshotted',
      payload: { issueId: 'zxc-fp', criteriaHash: 'c'.repeat(64), issueUpdatedAt: undefined },
    }],
    readWorkerRecords: () => [],
    appendEvent: (_r, _b, type, payload) => events.push([type, payload]),
    createWorkerNonce: () => 'b'.repeat(32),
    writeWorkerStarted() {},
    writeWorkerResult() {},
  };
  const resumeCode = await prepare.execute(
    { mode: 'resume', batch: 'wave', issues: [], concurrency: 2 },
    { out() {}, err() {} },
    {
      state: resumeState, preparationRoot: () => 'R',
      loadConfig: () => ({ targetRepoPath: fpTarget, allowHalfProven: false }),
      acquire: () => ({ ok: true, tookOver: false, ownership: {} }),
      release() {},
      runSync: () => ({ status: 0, stdout: 'f'.repeat(40), stderr: '' }),
      inspectIntegration: () => ({ ok: true, branch: 'main', head: 'f'.repeat(40) }),
      readyQueue: () => ({ ok: true, issues: [] }),
      buildBrief: () => fpBuilt,
      runWorker: () => { workers += 1; return { id: 'zxc-fp', ok: true, outcome: 'proven' }; },
    },
  );
  const snapshotted = events.filter((e) => e[0] === 'issue.snapshotted').map((e) => e[1]);
  check(`C5 [guard] an issue whose criteria moved after the batch snapshot is still attention — exit ${resumeCode}`,
    resumeCode === prepare.EXIT_ATTENTION);
  check('C5 [guard] ... its durable record still names the fingerprint drift',
    snapshotted.some((p) => p.state === 'attention'
      && /criteria changed after the immutable batch snapshot/i.test(String(p.error || ''))),
    JSON.stringify(snapshotted));
  check('C5 [guard] ... and no worker was launched for it', workers === 0);

  // An already-frozen snapshot has already crossed its publication boundary. Re-resolving a
  // newly introduced design field here would retroactively strand old work whose receipt is
  // still valid, rather than protecting a suite that is about to be created.
  const frozenEvents = []; let frozenWorkers = 0; let frozenDesignReads = 0;
  const frozenCfg = { targetRepoPath: fpTarget, allowHalfProven: false };
  const frozenBuilt = {
    ...fpBuilt,
    id: 'zxc-frozen',
    state: 'ready',
    cfg: frozenCfg,
    issue: {
      id: 'zxc-frozen', title: 'zxc-frozen', priority: 2, dependencies: [],
      design: 'design-ref: docs/design/legacy-local-only.md#§1',
    },
    folder: { dir: path.join(tmp, 'freeze-zxc-frozen'), branch: 'freeze-zxc-frozen', exists: true },
  };
  const frozenState = {
    preparationRoot: () => 'R', validateBatchId: () => true, validateIssueId: () => true,
    createManifest: (_r, _b, input) => ({ ...input }),
    canonicalHash: () => 'H', redactConfig: (v) => v,
    readEvents: () => [], readWorkerRecords: () => [],
    appendEvent: (_r, _b, type, payload) => frozenEvents.push([type, payload]),
    createWorkerNonce: () => 'c'.repeat(32), writeWorkerStarted() {}, writeWorkerResult() {},
    deriveState: () => ({ ok: true, issues: [] }),
  };
  const frozenCode = await prepare.execute(
    { mode: 'start', batch: 'frozenwave', config: path.join(tmp, 'unused.json'),
      issues: ['zxc-frozen'], concurrency: 1 },
    { out() {}, err() {} },
    {
      state: frozenState, preparationRoot: () => 'R',
      loadConfig: () => frozenCfg,
      acquire: () => ({ ok: true, tookOver: false, ownership: {} }), release() {},
      runSync: () => ({ status: 0, stdout: 'f'.repeat(40), stderr: '' }),
      inspectIntegration: () => ({ ok: true, branch: 'main', head: 'f'.repeat(40) }),
      readyQueue: () => ({ ok: true, issues: [] }), buildBrief: () => frozenBuilt,
      resolveDesign: () => {
        frozenDesignReads += 1;
        return { ok: false, reasons: ['missing-path'], refs: [] };
      },
      runWorker: () => {
        frozenWorkers += 1;
        return { id: 'zxc-frozen', ok: true, outcome: 'proven' };
      },
    },
  );
  const frozenSnapshots = frozenEvents.filter((e) => e[0] === 'issue.snapshotted').map((e) => e[1]);
  check('C5 [guard] an already-frozen snapshot remains a no-op without retroactive design resolution',
    frozenCode === 0 && frozenDesignReads === 0 && frozenWorkers === 0
    && frozenSnapshots.some((p) => p.state === 'already-frozen'),
    JSON.stringify({ frozenCode, frozenDesignReads, frozenWorkers, frozenSnapshots }));

  // ---- C5, write protection ---------------------------------------------------------------
  // The admission backstop is what stands between a hand-made edit and the integration branch,
  // and C1 puts a NEW refusal in front of the same freeze. Neither the classification nor the
  // admission may move; preparation's provenance refusal composes with this existing guard.
  const contract = protection.contract();
  check('C5 [guard] the four admission-guarded path classes are still the guarded set',
    [...(contract.admissionClasses || [])].sort().join(',') === 'config,control,frozen,product',
    JSON.stringify(contract.admissionClasses));
  check('C5 [guard] `docs/**` is still PLANNING and so outside the admission-guarded set',
    protection.classify('docs/design/whatever.md') === 'planning'
    && !(contract.admissionClasses || []).includes('planning'));
  check('C5 [guard] an acceptance suite is still classified `frozen`, ahead of `product`',
    protection.classify('tests/acceptance/repo-zxc/test.js') === 'frozen'
    && protection.classify('runner/queue.js') === 'product'
    && protection.classify('pipeline.config.json') === 'config'
    && protection.classify('contracts/control-plane.json') === 'control');

  const unprotected = project('zxc-plain-checkout');
  fs.writeFileSync(path.join(unprotected, 'README.md'), '# plain\n');
  const plainAdmit = protection.admit(unprotected, { issues: ['zxc-demo'] });
  check('C5 [guard] a checkout with no pipeline.config.json is still unprotected and admitted',
    plainAdmit.admit === true && plainAdmit.protected === false, JSON.stringify(plainAdmit));

  const guarded = project('zxc-pipeline-checkout');
  fs.mkdirSync(path.join(guarded, 'runner'), { recursive: true });
  fs.writeFileSync(path.join(guarded, 'pipeline.config.json'),
    `${JSON.stringify({ verifyCommand: 'sh tools/run-acceptance.sh', defaultBranch: 'main', frozenPaths: [] }, null, 2)}\n`);
  fs.writeFileSync(path.join(guarded, 'README.md'), '# guarded\n');
  git(guarded, 'init', '-q', '-b', 'main');
  git(guarded, 'config', 'user.email', 'fixture@test.local');
  git(guarded, 'config', 'user.name', 'fixture');
  git(guarded, 'add', '-A');
  git(guarded, 'commit', '-qm', 'fixture');
  const cleanAdmit = protection.admit(guarded, { issues: ['zxc-demo'] });
  check('C5 [guard] a clean pipeline-first checkout is still protected AND admitted',
    cleanAdmit.admit === true && cleanAdmit.protected === true, JSON.stringify(cleanAdmit));

  fs.writeFileSync(path.join(guarded, 'runner', 'hand-made.js'), '// nobody planned this\n');
  const dirtyAdmit = protection.admit(guarded, { issues: ['zxc-demo'] });
  check('C5 [guard] an unplanned product edit is still refused, by exact path',
    dirtyAdmit.admit === false
    && dirtyAdmit.refusals.some((r) => r.path === 'runner/hand-made.js' && r.class === 'product'),
    JSON.stringify(dirtyAdmit.refusals));
  const refusalText = protection.admissionRefusal(dirtyAdmit,
    { label: dirtyAdmit.target, issues: ['zxc-demo'] }).join('\n');
  check('C5 [guard] ... and the one refusal text still promises nothing was reset, cleaned or stashed',
    /runner\/hand-made\.js/.test(refusalText)
    && /nothing was staged, committed, promoted or dispatched/i.test(refusalText)
    && /reset, cleaned/i.test(refusalText), refusalText);
  fs.rmSync(path.join(guarded, 'runner', 'hand-made.js'));

  // The two changes that DO arrive with a reason, and must keep arriving with one: this issue's
  // own suite, and the gate receipt the freeze writes beside it.
  fs.mkdirSync(path.join(guarded, 'tests', 'acceptance', 'zxc-demo'), { recursive: true });
  fs.writeFileSync(path.join(guarded, 'tests', 'acceptance', 'zxc-demo', 'test.js'), '// suite\n');
  fs.writeFileSync(path.join(guarded, 'tests', 'acceptance', 'zxc-demo', '.freeze-gate.json'), '{}\n');
  check('C5 [guard] this issue\'s own untracked suite and receipt are still admitted',
    protection.admit(guarded, { issues: ['zxc-demo'] }).admit === true);
  check('C5 [guard] ... and another issue\'s untracked suite is still refused',
    (() => {
      const other = protection.admit(guarded, { issues: ['zxc-somebody-else'] });
      return other.admit === false
        && other.refusals.some((r) => r.path === 'tests/acceptance/zxc-demo/test.js' && r.class === 'frozen');
    })());
  // A design document under `docs/` is planning, not an admission class: the pipeline-owned
  // publication C2 asks for has somewhere to write without a lease.
  fs.mkdirSync(path.join(guarded, 'docs', 'design', 'provenance'), { recursive: true });
  fs.writeFileSync(path.join(guarded, 'docs', 'design', 'provenance', 'zxc-demo.md'), '# approved design\n');
  check('C5 [guard] an untracked document under `docs/` is still admitted by the backstop',
    protection.admit(guarded, { issues: ['zxc-demo'] }).admit === true);

  // ---- C5, mandatory regressions ----------------------------------------------------------
  // Recorded, never run: see the SPEC DEFECT note at the top of this file. Their presence and
  // their declared policy are what make "the regressions remain green" a question about
  // anything at all.
  let projectConfig = null;
  try { projectConfig = JSON.parse(fs.readFileSync(path.join(REPO, 'pipeline.config.json'), 'utf8')); }
  catch { projectConfig = null; }
  check('C5 [guard] this project still declares a REQUIRED regression command',
    !!projectConfig && projectConfig.regressionPolicy === 'required'
    && projectConfig.regressionCommand === 'bash scripts/test-ci.sh',
    JSON.stringify(projectConfig && {
      cmd: projectConfig.regressionCommand, policy: projectConfig.regressionPolicy,
    }));
  check('C5 [guard] the verify command the gate and the freeze both drive is unchanged',
    !!projectConfig && projectConfig.verifyCommand === 'sh tools/run-acceptance.sh');
  check('C5 [guard] the frozen-path list still covers the verifier, the CI entry point and tests/unit/',
    !!projectConfig && Array.isArray(projectConfig.frozenPaths)
    && ['tools/run-acceptance.sh', 'scripts/test-ci.sh', 'scripts/test-*.sh', 'tests/unit/']
      .every((p) => projectConfig.frozenPaths.includes(p)));
  for (const rel of ['scripts/test-ci.sh', 'scripts/test-freeze.sh', 'scripts/test-freeze-gate.sh',
    'scripts/test-spec-brief.sh', 'scripts/test-prepare-batch.sh', 'scripts/test-verifier.sh',
    'tools/run-acceptance.sh', 'tests/acceptance/_control']) {
    check(`C5 [guard] the existing regression entry point \`${rel}\` is still present`,
      fs.existsSync(path.join(REPO, ...rel.split('/'))));
  }
}

body()
  .catch((e) => {
    failed = 1;
    console.log(`FAIL - HARNESS BROKEN: unexpected exception: ${e && e.stack ? e.stack : e}`);
  })
  .then(() => {
    for (const [key, name] of [['lock', 'PIPELINE_GLOBAL_LOCK_DIR'], ['prep', 'PREPARATION_RUNS_DIR'],
      ['bd', 'PIPELINE_BD_CMD'], ['child', 'PIPELINE_CHILD_AUTHORITY']]) {
      if (savedEnv[key] === undefined) delete process.env[name];
      else process.env[name] = savedEnv[key];
    }
    rmrf(tmp);
    process.exit(failed);
  });
