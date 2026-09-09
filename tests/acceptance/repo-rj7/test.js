// Frozen acceptance test — repo-rj7: one supervisor authority with scoped child operations.
// This is the RED half; `guard.js` beside it is the whole of C6 and carries the checks that are
// already green at the fork point and must stay that way.
//
// WHICH CRITERION EACH SECTION PROVES (every check below names its own in its label):
//
//   C1  exactly one live supervisor lease per canonical target across pipeline checkouts; a
//       second supervisor and every unrelated standalone coordinator are refused BY OWNER NAME
//       before any work is launched.
//   C2  a live supervisor grants narrowly scoped EXPIRING child authority for preparation or
//       implementation, and the existing preparation (`scripts/prepare-batch.js`) and run
//       (`runner/preflight.js`, and so `runner/run.js`) entry paths accept it only when host
//       record, parent liveness, target, nonce and requested scope ALL match.
//   C3  two authorized isolated worker operations may be live together, a deterministic fixture
//       proves their Beads-write and integration-publication sections never overlap, and a
//       child cannot widen its own scope.
//   C4  forged, replayed, expired, wrong-target, wrong-parent and released child authority is
//       refused before Beads, Git, Docker or network mutation, and the refusal leaves existing
//       ownership records untouched.
//   C5  parent or child interruption produces explicit recoverable evidence; a live parent is
//       never taken over; a provably dead parent can be reclaimed without deleting an uncertain
//       preparation marker and without silently declaring its child complete.
//
//   C6 is proven ENTIRELY by `guard.js` — it is a criterion about what did NOT change, so it is
//   green at the fork point by construction and a red file is the wrong home for it.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE FROZEN INTERFACE. The issue names no module, function or command surface (see SPEC
// DEFECTS below), so this suite fixes one. Node built-ins only, synchronous, no container
// engine and no network — the same shape as `runner/lock.js`, which it builds on.
//
// `runner/supervisor.js` exports:
//
//   SCOPES   = ['preparation', 'implementation']            (exactly these two, in this order)
//   SECTIONS = ['beads-write', 'integration-publish']       (exactly these two, in this order)
//
//   acquire(repoRoot, targetRepoPath, supervisorId, options = {})
//     -> { ok: true,  tookOver: false, lease }
//     -> { ok: true,  tookOver: true, previous: { id, pid, outstanding: [...] }, lease }
//     -> { ok: false, holder: { id, pid, since, host }, outstanding: [...] }
//     THE LEASE OCCUPIES THE SAME host-global canonical-target authority `runner/lock.js`
//     uses, and its record's `runId` IS the supervisor id — that is what makes every
//     standalone coordinator refuse by the supervisor's own name without a second exclusion
//     primitive to keep in step. `repoRoot` selects only the observer mirror, exactly as in
//     `lock.acquire`, so two pipeline checkouts naming one canonical target contend.
//     `lease.id` is the supervisor id, `lease.token` is unguessable, and `lease.ownership` is
//     the `runner/lock.js` ownership handle, so a supervisor can still record claims and mark
//     preparation uncertainty.
//     `options.reclaim === true` permits reclaiming a PROVABLY DEAD parent that left
//     recoverable evidence behind. Without it such a parent is REFUSED and the refusal carries
//     that evidence in `outstanding`. `reclaim` is never a licence over a LIVE parent.
//
//   release(repoRoot, targetRepoPath, lease) -> void
//   leaseHolder(targetRepoPath) -> { id, pid, since, host } | null
//
//   grant(lease, { scope, issueId, batch, ttlMs }) -> { ok: true, authority } | { ok: false, error }
//     `authority` is a JSON-serialisable record carrying at least
//       { nonce, scope, issueId, batch, target, parent: { id, pid }, expiresAt }
//     `nonce` is at least 32 hexadecimal characters and unguessable. `target` is the CANONICAL
//     target. `expiresAt` is an ISO timestamp no later than the grant instant plus `ttlMs`.
//     Refuses a scope outside SCOPES, a ttlMs of zero or less, and any caller that does not
//     hold a live lease — so a child, which holds an ADMISSION and no lease, cannot grant.
//
//   settle(lease, nonce, { outcome }) -> { ok: true } | { ok: false, error }
//     outcome is 'complete' or 'released'. Only the parent may settle, and settling is the only
//     thing that removes a grant from `outstanding`.
//
//   outstanding(targetRepoPath) -> [ { nonce, scope, issueId, batch, state, expiresAt } ]
//     Every grant not yet settled by its parent, oldest first. `state` is 'granted' (never
//     admitted) or 'redeemed' (admitted, so a child operation was started). A grant is NEVER
//     removed by inference — not by expiry, not by the parent dying, not by a reclaim.
//
//   admit(authority, { targetRepoPath, scope, now }) -> { ok: true, admission } | { ok: false, reason, message }
//     `admission` = { nonce, scope, issueId, batch, target, parent: { id, pid }, sections }
//       where `sections` is SECTIONS — the two host-global critical sections this child may
//       enter, and no others.
//     `now` is an epoch-millisecond override for the expiry comparison; it defaults to
//     `Date.now()` and exists so a frozen suite can state expiry deterministically.
//     SINGLE USE: a second admit of one nonce answers 'replayed'.
//     `reason` is one of
//       'no-authority' | 'forged' | 'replayed' | 'expired' | 'wrong-target'
//       | 'wrong-parent' | 'released' | 'wrong-scope' | 'supervisor-held'
//     `message` names the nonce and the parent, because a refusal a person cannot act on has
//     not helped anybody.
//
//   admitEntry(entry, { targetRepoPath, repoRoot, env, now })
//     -> { ok: true,  mode: 'supervisor-child', admission }
//     -> { ok: true,  mode: 'standalone' }
//     -> { ok: false, mode: 'refused', reason, message }
//     `entry` is 'preparation' or 'implementation'. THE ONE ADMISSION STEP both existing entry
//     paths call, FIRST, ahead of every lock acquisition and ahead of any Beads, Git, Docker or
//     network mutation. `env` defaults to `process.env`.
//
//   tryEnterSection(admission, section) -> { ok: true, held } | { ok: false, holder: { nonce, issueId, section } }
//   exitSection(held) -> void
//     Host-global mutual exclusion per (canonical target, section). At most one admitted child
//     is inside one named section at a time; the two named sections are INDEPENDENT resources,
//     so two isolated workers really can be live together. A section outside SECTIONS is
//     refused, which is the other half of "a child cannot widen its own scope".
//
// ENTRY-PATH WIRING IS BY ENVIRONMENT AND NOTHING ELSE:
//   PIPELINE_CHILD_AUTHORITY = path to a JSON file holding one `authority` record.
//   * `scripts/prepare-batch.js` requests scope 'preparation'
//   * `runner/preflight.js`, and so `runner/run.js`, requests scope 'implementation'
//        and reports its admission as `childAdmission` on a successful preflight.
//   Set and admitted: the entry path proceeds and takes NO target lock of its own.
//   Set and refused: `prepare-batch` exits 3 and `preflight` answers `{ ok: false }`, with the
//        refusal REASON in the diagnostic, before any mutation, and with every ownership record
//        untouched.
//   Unset: today's behaviour exactly — `lock.acquire`, refused by owner name if held. That is
//        C6, and `guard.js` pins it.
//   NO CLI GRAMMAR CHANGES ANYWHERE, which is why the channel is the environment: C6 pins the
//   observable command line of all three standalone coordinators.
// ─────────────────────────────────────────────────────────────────────────────────────────────
//
// SPEC DEFECTS, REPORTED NOT PAPERED OVER.
//
//  1. THE ISSUE NAMES NO SURFACE. Not a module, not a function, not a flag — only behaviour
//     ("a live supervisor can grant narrowly scoped expiring child authority"). A frozen suite
//     cannot assert behaviour without naming the thing that behaves, so the block above IS the
//     missing half of the spec and every check below is written against it. An implementation
//     that satisfies the criteria through a differently-named surface is not wrong about the
//     issue; it is wrong about this suite, and the suite is what freezes.
//
//  2. C6 NAMES FROZEN FILES. Its four "existing suites" are `scripts/test-*.sh` and
//     `tests/unit/`, both frozen by `pipeline.config.json`. `guard.js` explains what it does
//     about that.
//
//  3. C3's "their Beads-write and integration-publication sections never overlap" is ambiguous
//     between per-section mutual exclusion and one section excluding the other. This suite
//     reads it as PER-SECTION mutual exclusion — no two children inside one named section at
//     once — and additionally asserts the two sections are independent resources, because
//     otherwise "two authorized isolated worker operations may be live together" has no content
//     left: any two workers that both write Beads and both publish would serialise completely.
//
//  4. C4 says the refusal happens "before Beads, Git, Docker or network mutation". READS are
//     unavoidable and are not the harm: `loadConfig` reads a file and the write-protection
//     backstop reads `git status` before anything else in both entry paths. So every check
//     below measures MUTATION — the target repository's HEAD and porcelain state, the Docker
//     and network lifecycle calls, and the Beads writer — and never mere access.
//
//  5. C4's "refusal leaves existing ownership records untouched" is read as: every ownership
//     record that EXISTED before the refusal is byte-identical after it. A refusal is free to
//     ADD a record of its own (an audit line, say); it may not edit or remove one that was
//     already there. Additions are therefore not counted as changes.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..', '..');
const SUPERVISOR = path.join(REPO, 'runner', 'supervisor.js');
const LOCK = path.join(REPO, 'runner', 'lock.js');
const PREFLIGHT = path.join(REPO, 'runner', 'preflight.js');
const PREPARE_BATCH = path.join(REPO, 'scripts', 'prepare-batch.js');
const AUTHOR_TESTS = path.join(REPO, 'scripts', 'author-tests.js');
const PROVE_TESTS = path.join(REPO, 'scripts', 'prove-tests.js');

// See `guard.js`: fixtures are routinely owned by another uid inside a container, and a frozen
// test must not depend on ambient git config.
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
const fwd = (p) => String(p).split(path.sep).join('/');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-rj7-'));
const savedEnv = {
  PIPELINE_GLOBAL_LOCK_DIR: process.env.PIPELINE_GLOBAL_LOCK_DIR,
  PREPARATION_RUNS_DIR: process.env.PREPARATION_RUNS_DIR,
  PIPELINE_BD_CMD: process.env.PIPELINE_BD_CMD,
  PIPELINE_CHILD_AUTHORITY: process.env.PIPELINE_CHILD_AUTHORITY,
};
const LOCK_ROOT = path.join(tmp, 'lockauth');
const PREP_ROOT = path.join(tmp, 'preparations');
const NO_BD = path.join(tmp, 'no-such-bd-binary');
process.env.PIPELINE_GLOBAL_LOCK_DIR = LOCK_ROOT;
process.env.PREPARATION_RUNS_DIR = PREP_ROOT;
process.env.PIPELINE_BD_CMD = NO_BD;
delete process.env.PIPELINE_CHILD_AUTHORITY;

const lock = require(LOCK);
const preflightMod = require(PREFLIGHT);
const prepare = require(PREPARE_BATCH);
const author = require(AUTHOR_TESTS);
const prove = require(PROVE_TESTS);

// ---- fixtures -------------------------------------------------------------------------------

function project(name) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// A real repository, so "no Git mutation" is a statement about a HEAD and a porcelain listing
// rather than about a directory nobody could have committed to. Deliberately WITHOUT a
// `pipeline.config.json`: the write-protection backstop then classifies it as unprotected and
// admits it, which keeps every refusal below attributable to child authority alone.
function repoProject(name) {
  const dir = project(name);
  fs.writeFileSync(path.join(dir, 'README.md'), '# rj7 fixture target\n');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'fixture@test.local');
  git(dir, 'config', 'user.name', 'fixture');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'fixture');
  return dir;
}
function gitState(dir) {
  return JSON.stringify({
    head: String(git(dir, 'rev-parse', 'HEAD').stdout || '').trim(),
    porcelain: String(git(dir, 'status', '--porcelain').stdout || '').trim(),
  });
}

function configFor(target, name) {
  const file = path.join(tmp, `run.config.${name}.json`);
  fs.writeFileSync(file, `${JSON.stringify({
    targetRepoPath: fwd(target),
    targetRepoRemote: 'https://example.invalid/rj7/target.git',
    image: 'pipeline-rj7:latest',
    bdTimeoutMs: 3000,
    gitTimeoutMs: 3000,
    lifecycleTimeoutMs: 5000,
  }, null, 2)}\n`);
  return file;
}
function runCfg(target) {
  return {
    targetRepoPath: target,
    targetRepoRemote: 'https://example.invalid/rj7/target.git',
    image: 'pipeline-rj7:latest',
    network: 'rj7-net',
    proxyName: 'rj7-proxy',
    proxyPort: 18444,
    proxyUrl: 'http://rj7-proxy:18444',
    lifecycleTimeoutMs: 5000,
    bdTimeoutMs: 3000,
    gitTimeoutMs: 3000,
    hostShell: null,
  };
}
const logFor = (runId) => ({ runId, info() {}, error() {} });

// Every host-side gate after the lock, behind a counter. C1 and C4 both need "nothing after
// admission ran", and that is only measurable if each one is named.
function spyDeps(overrides = {}) {
  const calls = [];
  const rec = (name, answer) => (...args) => { calls.push(name); return answer(...args); };
  return {
    calls,
    deps: {
      verifyRepoIdentity: rec('verifyRepoIdentity', () => ({ ok: true, remoteName: 'origin', identity: 'rj7/target' })),
      resolveHostShell: rec('resolveHostShell', () => ({ ok: true, command: 'sh', kind: 'stub' })),
      dockerAvailable: rec('dockerAvailable', () => ({ status: 0 })),
      imageExists: rec('imageExists', () => ({ status: 0 })),
      networkUp: rec('networkUp', () => ({ ok: true, output: '' })),
      networkDown: rec('networkDown', () => ({ ok: true, output: '' })),
      egressCheck: rec('egressCheck', () => ({ ok: true, output: '' })),
      recoverStaleIssues: rec('recoverStaleIssues', () => ({ recovered: [] })),
      ...overrides,
    },
  };
}
const say = () => {
  const lines = [];
  return { lines, fn: (...a) => lines.push(a.join(' ')), text: () => lines.join('\n') };
};

// ---- ownership snapshots (C4, and the record-untouched half of C5) --------------------------
// SPEC DEFECT 5 above: only records that EXISTED before are compared, so a refusal is free to
// add an audit record of its own and is not free to edit or remove an ownership record.
function digestOf(file) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
  catch { return 'absent'; }
}
function walkDigests(dir) {
  const out = {};
  const visit = (d, prefix) => {
    let names = [];
    try { names = fs.readdirSync(d); } catch { return; }
    for (const n of names.sort()) {
      const full = path.join(d, n);
      let st;
      try { st = fs.lstatSync(full); } catch { continue; }
      if (st.isDirectory() && !st.isSymbolicLink()) visit(full, `${prefix}${n}/`);
      else out[`${prefix}${n}`] = digestOf(full);
    }
  };
  visit(dir, '');
  return out;
}
function ownershipSnapshot(target) {
  let uncertain;
  try { uncertain = lock.listPreparationUncertain(target).map((m) => m.nonce).sort().join(','); }
  catch (e) { uncertain = `unreadable: ${e && e.message}`; }
  return {
    lease: digestOf(lock.globalLockPath(target)),
    records: walkDigests(lock.globalLockRoot()),
    uncertain,
  };
}
function ownershipDrift(before, after) {
  const drift = [];
  if (before.lease !== after.lease) drift.push('the lease record itself');
  if (before.uncertain !== after.uncertain) drift.push(`preparation uncertainty (${before.uncertain} -> ${after.uncertain})`);
  for (const [rel, hash] of Object.entries(before.records)) {
    if (after.records[rel] !== hash) drift.push(`${rel} (${after.records[rel] === undefined ? 'removed' : 'edited'})`);
  }
  return drift;
}

// A synchronous wait, so "expired" can be stated against real elapsed time in the two places
// that go through a real CLI and cannot be handed a `now`.
function spinPast(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) { /* deliberately busy: no timer can be awaited inside a CLI call */ }
}

// A supervisor planted by a process that then EXITS, so its lease is held by a pid this host
// can prove is gone. `spawnSync` returns only after the child is reaped, so the fixture is
// deterministic rather than merely likely.
function plantDeadParent(checkout, target, supervisorId, opts = {}) {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  const code = [
    "'use strict';",
    `const sup = require(${JSON.stringify(fwd(SUPERVISOR))});`,
    `const lock = require(${JSON.stringify(fwd(LOCK))});`,
    `const res = sup.acquire(${JSON.stringify(fwd(checkout))}, ${JSON.stringify(fwd(target))}, ${JSON.stringify(supervisorId)});`,
    'const answer = { ok: !!(res && res.ok), pid: process.pid };',
    'if (res && res.ok) {',
    `  if (${opts.grant ? 'true' : 'false'}) {`,
    '    const g = sup.grant(res.lease, { scope: "preparation", issueId: "rj7-orphan-child",',
    '      batch: "rj7batch", ttlMs: 600000 });',
    '    answer.grantOk = !!(g && g.ok); answer.authority = g && g.authority;',
    '  }',
    `  if (${opts.marker ? 'true' : 'false'}) {`,
    `    lock.markPreparationUncertain(res.lease.ownership, { nonce: ${JSON.stringify(opts.marker || '')},`,
    '      batch: "rj7batch", issueId: "rj7-orphan-child", phase: "author-proof", pid: process.pid });',
    '    answer.marked = true;',
    '  }',
    '}',
    'process.stdout.write(JSON.stringify(answer));',
  ].join('\n');
  const r = spawnSync(process.execPath, ['-e', code],
    { encoding: 'utf8', timeout: 120000, env, windowsHide: true });
  let answer = null;
  try { answer = JSON.parse(r.stdout || 'null'); } catch { answer = null; }
  return { answer, why: `exit ${r.status}: ${String(r.stderr || '').trim().split('\n').slice(-2).join(' ')}` };
}

// ---- the body -------------------------------------------------------------------------------

async function body() {
  // The interface is asserted before it is used. A missing surface is reported once per
  // criterion, by name, instead of as a stack trace that says nothing about which criterion
  // went unproven.
  let sup = null;
  let loadError = null;
  try { sup = require(SUPERVISOR); } catch (e) { loadError = (e && e.message) || String(e); }
  check('C1 runner/supervisor.js is requirable', sup !== null, loadError);
  const fns = ['acquire', 'release', 'leaseHolder', 'grant', 'settle', 'outstanding',
    'admit', 'admitEntry', 'tryEnterSection', 'exitSection'];
  const gaps = sup === null ? fns : fns.filter((n) => typeof sup[n] !== 'function');
  check('C1 runner/supervisor.js exports the whole supervisor surface',
    gaps.length === 0, `missing: ${gaps.join(', ')}`);
  if (gaps.length) {
    for (const c of ['C1 one live supervisor lease per canonical target',
      'C2 scoped expiring child authority accepted by both entry paths',
      'C3 two isolated workers live together with non-overlapping sections',
      'C4 forged, replayed, expired, wrong-target, wrong-parent and released authority refused',
      'C5 interruption evidence, no takeover of a live parent, reclaim of a dead one']) {
      check(`${c} — CANNOT BE PROVEN: the supervisor surface is absent`, false,
        `missing: ${gaps.join(', ')}`);
    }
    return;
  }

  check('C2 runner/supervisor.js declares exactly the two scopes the issue names',
    Array.isArray(sup.SCOPES) && sup.SCOPES.join(',') === 'preparation,implementation',
    JSON.stringify(sup.SCOPES));
  check('C3 runner/supervisor.js declares exactly the two sections the issue names',
    Array.isArray(sup.SECTIONS) && sup.SECTIONS.join(',') === 'beads-write,integration-publish',
    JSON.stringify(sup.SECTIONS));

  const checkoutA = project('pipeline-checkout-a');
  const checkoutB = project('pipeline-checkout-b');

  // ════ C1: exactly one live supervisor lease per canonical target ══════════════════════════
  const target = repoProject('rj7-target-main');
  const spare = repoProject('rj7-target-spare');

  const lease = sup.acquire(checkoutA, target, 'SUP-ALPHA');
  check('C1 a supervisor takes the lease on a free canonical target',
    !!lease && lease.ok === true && lease.tookOver === false && !!lease.lease,
    JSON.stringify(lease));
  check('C1 the lease names its supervisor and carries an unguessable token',
    !!lease.lease && lease.lease.id === 'SUP-ALPHA'
    && typeof lease.lease.token === 'string' && lease.lease.token.length >= 16);
  check('C1 the lease carries the lock ownership handle, so a supervisor can still record claims',
    !!lease.lease && !!lease.lease.ownership && typeof lease.lease.ownership.authorityFile === 'string');
  const holderNow = sup.leaseHolder(target);
  check('C1 leaseHolder reports the live supervisor by name',
    !!holderNow && holderNow.id === 'SUP-ALPHA' && holderNow.pid === process.pid,
    JSON.stringify(holderNow));

  const secondSup = sup.acquire(checkoutB, target, 'SUP-BETA');
  check('C1 a SECOND supervisor from a different pipeline checkout is refused BY OWNER NAME',
    !!secondSup && secondSup.ok === false && !!secondSup.holder
    && secondSup.holder.id === 'SUP-ALPHA' && secondSup.holder.pid === process.pid,
    JSON.stringify(secondSup));
  // Identity, not spelling. A lease keyed on the raw string protects a folder, not a project,
  // and a second config written by hand is exactly how the same repo gets two spellings.
  check('C1 a trailing separator does not buy a second lease on one project',
    sup.acquire(checkoutB, `${target}${path.sep}`, 'SUP-GAMMA').ok === false);
  check('C1 a `..` round trip does not buy a second lease on one project',
    sup.acquire(checkoutB, path.join(target, '..', path.basename(target)), 'SUP-GAMMA').ok === false);
  check('C1 a forward-slash spelling does not buy a second lease on one project',
    sup.acquire(checkoutB, fwd(target), 'SUP-GAMMA').ok === false);

  const rivalEnv = { ...process.env };
  delete rivalEnv.NODE_OPTIONS;
  const rival = spawnSync(process.execPath, ['-e', [
    `const s = require(${JSON.stringify(fwd(SUPERVISOR))});`,
    `process.stdout.write(JSON.stringify(s.acquire(${JSON.stringify(fwd(checkoutB))},`,
    `  ${JSON.stringify(fwd(target))}, 'SUP-RIVAL-PROCESS')));`,
  ].join('\n')], { encoding: 'utf8', timeout: 120000, env: rivalEnv, windowsHide: true });
  let rivalAnswer = null;
  try { rivalAnswer = JSON.parse(rival.stdout || 'null'); } catch { rivalAnswer = null; }
  check('C1 harness: a rival supervisor process ran and answered', rivalAnswer !== null,
    `exit ${rival.status}: ${String(rival.stderr || '').trim().split('\n').slice(-3).join(' ')}`);
  check('C1 a supervisor in a SEPARATE process is refused the lease this one holds, by owner name',
    !!rivalAnswer && rivalAnswer.ok === false && !!rivalAnswer.holder
    && rivalAnswer.holder.id === 'SUP-ALPHA');

  // "Exactly one PER CANONICAL TARGET" — refusing everything would pass every check above.
  const spareLease = sup.acquire(checkoutB, spare, 'SUP-OTHER-PROJECT');
  check('C1 a supervisor on a DIFFERENT canonical target is allowed at the same time',
    !!spareLease && spareLease.ok === true, JSON.stringify(spareLease));
  if (spareLease && spareLease.ok) sup.release(checkoutB, spare, spareLease.lease);

  // Every unrelated standalone coordinator, refused by the SUPERVISOR's own name, before work.
  const standalone = lock.acquire(checkoutB, target, 'RUN-UNRELATED');
  check('C1 an unrelated standalone run is refused, and the refusal names the supervisor',
    !!standalone && standalone.ok === false && !!standalone.holder
    && standalone.holder.runId === 'SUP-ALPHA', JSON.stringify(standalone));

  const preSpy = spyDeps();
  const preRefused = preflightMod.preflight(runCfg(target), checkoutB, logFor('RUN-UNRELATED'), preSpy.deps);
  check('C1 an unrelated run\'s preflight is refused while a supervisor lease is live',
    !!preRefused && preRefused.ok === false, JSON.stringify(preRefused));
  check('C1 that preflight refusal names the supervisor that holds the lease',
    !!preRefused && /SUP-ALPHA/.test(String(preRefused.reason || '')),
    String(preRefused && preRefused.reason));
  check('C1 ... and nothing was launched: no identity, shell, Docker, network or Beads call',
    preSpy.calls.length === 0, `called: ${preSpy.calls.join(', ')}`);

  const cfgPath = configFor(target, 'rj7main');
  const gitBefore = gitState(target);
  const prepIo = say();
  const prepCode = await prepare.main(['start', 'rj7batch', '--config', cfgPath, '--issue', 'rj7-demo'],
    { out: () => {}, err: prepIo.fn });
  check(`C1 an unrelated prepare-batch is refused with exit ${prepare.EXIT_REFUSED} — got ${prepCode}`,
    prepCode === prepare.EXIT_REFUSED);
  check('C1 that prepare-batch refusal names the supervisor and says no worker was launched',
    /SUP-ALPHA/.test(prepIo.text()) && /no worker was launched/i.test(prepIo.text()), prepIo.text());
  check('C1 ... and no preparation state was created for the refused batch',
    !fs.existsSync(path.join(PREP_ROOT, 'rj7batch')));

  const authIo = say();
  const authCode = author.main(['rj7-demo', '--config', cfgPath], { out: () => {}, err: authIo.fn });
  check(`C1 an unrelated author-tests is refused with exit 3 — got ${authCode}`, authCode === 3);
  check('C1 that author-tests refusal names the supervisor',
    /SUP-ALPHA/.test(authIo.text()), authIo.text());

  const proveIo = say();
  const proveCode = prove.main(['rj7-demo', '--config', cfgPath], () => {}, proveIo.fn);
  check(`C1 an unrelated prove-tests is refused with exit 3 — got ${proveCode}`, proveCode === 3);
  check('C1 that prove-tests refusal names the supervisor',
    /SUP-ALPHA/.test(proveIo.text()), proveIo.text());
  check('C1 no unrelated coordinator mutated the target repository on its way out',
    gitState(target) === gitBefore);

  // ════ C2: narrowly scoped, expiring child authority ══════════════════════════════════════
  const canon = lock.canonicalTarget(target);
  const TTL = 60000;
  const grantedAt = Date.now();
  const prep = sup.grant(lease.lease, { scope: 'preparation', issueId: 'rj7-prep-one', batch: 'rj7batch', ttlMs: TTL });
  check('C2 a live supervisor grants preparation child authority',
    !!prep && prep.ok === true && !!prep.authority, JSON.stringify(prep));
  const pa = (prep && prep.authority) || {};
  check('C2 the preparation authority is scoped to preparation, one issue and one batch',
    pa.scope === 'preparation' && pa.issueId === 'rj7-prep-one' && pa.batch === 'rj7batch',
    JSON.stringify(pa));
  check('C2 the preparation authority names the CANONICAL target it is good for',
    typeof pa.target === 'string' && lock.canonicalTarget(pa.target) === canon, String(pa.target));
  check('C2 the preparation authority names its parent supervisor and controlling process',
    !!pa.parent && pa.parent.id === 'SUP-ALPHA' && pa.parent.pid === process.pid,
    JSON.stringify(pa.parent));
  check('C2 the nonce is unguessable — at least 32 hexadecimal characters',
    typeof pa.nonce === 'string' && /^[a-f0-9]{32,}$/.test(pa.nonce), String(pa.nonce));
  const expiry = Date.parse(String(pa.expiresAt));
  check('C2 the authority EXPIRES, no later than the grant instant plus the requested ttl',
    Number.isFinite(expiry) && expiry > grantedAt && expiry <= grantedAt + TTL + 1000,
    `expiresAt=${pa.expiresAt} ttl=${TTL}`);

  const impl = sup.grant(lease.lease, { scope: 'implementation', issueId: 'rj7-impl-one', ttlMs: TTL });
  check('C2 a live supervisor grants implementation child authority too',
    !!impl && impl.ok === true && impl.authority && impl.authority.scope === 'implementation',
    JSON.stringify(impl));
  check('C2 two grants never share a nonce',
    !!impl.authority && impl.authority.nonce !== pa.nonce);
  check('C2 grant refuses a scope the issue does not name',
    sup.grant(lease.lease, { scope: 'freeze-commit', issueId: 'rj7-x', ttlMs: TTL }).ok === false);
  check('C2 grant refuses authority that would never expire',
    sup.grant(lease.lease, { scope: 'preparation', issueId: 'rj7-x', ttlMs: 0 }).ok === false
    && sup.grant(lease.lease, { scope: 'preparation', issueId: 'rj7-x', ttlMs: -1 }).ok === false);

  const fresh = (scope, issueId, ttlMs = TTL) => {
    const r = sup.grant(lease.lease, { scope, issueId, batch: 'rj7batch', ttlMs });
    return (r && r.authority) || null;
  };
  const reasonOf = (r) => (r && r.reason) || (r && r.ok === true ? 'ADMITTED' : 'NO ANSWER');

  // The five conjuncts, one at a time, each against a grant of its own so single-use
  // consumption cannot make a later case pass for the wrong reason.
  const good = sup.admit(fresh('preparation', 'rj7-conj-ok'), { targetRepoPath: target, scope: 'preparation' });
  check('C2 an authority matching host record, parent, target, nonce and scope is ADMITTED',
    !!good && good.ok === true && !!good.admission, JSON.stringify(good));
  check('C2 the admission carries the nonce, scope and issue the parent granted',
    !!good.admission && good.admission.scope === 'preparation'
    && good.admission.issueId === 'rj7-conj-ok'
    && /^[a-f0-9]{32,}$/.test(String(good.admission.nonce)));
  check('C2 the admission carries exactly the two sections the child may enter, and no others',
    !!good.admission && Array.isArray(good.admission.sections)
    && good.admission.sections.join(',') === 'beads-write,integration-publish',
    JSON.stringify(good.admission && good.admission.sections));

  const handMade = {
    nonce: crypto.randomBytes(20).toString('hex'), scope: 'preparation',
    issueId: 'rj7-conj-ok', batch: 'rj7batch', target: canon,
    parent: { id: 'SUP-ALPHA', pid: process.pid },
    expiresAt: new Date(Date.now() + TTL).toISOString(),
  };
  const noRecord = sup.admit(handMade, { targetRepoPath: target, scope: 'preparation' });
  check(`C2 HOST RECORD: an authority the supervisor never granted is refused — got ${reasonOf(noRecord)}`,
    !!noRecord && noRecord.ok === false && noRecord.reason === 'forged');

  const tampered = { ...fresh('preparation', 'rj7-conj-tamper'), issueId: 'rj7-somebody-elses-issue' };
  const edited = sup.admit(tampered, { targetRepoPath: target, scope: 'preparation' });
  check(`C2 HOST RECORD: an authority edited after it was granted is refused — got ${reasonOf(edited)}`,
    !!edited && edited.ok === false && edited.reason === 'forged');

  const wrongTarget = sup.admit(fresh('preparation', 'rj7-conj-target'),
    { targetRepoPath: spare, scope: 'preparation' });
  check(`C2 TARGET: authority for one canonical target is refused by another — got ${reasonOf(wrongTarget)}`,
    !!wrongTarget && wrongTarget.ok === false && wrongTarget.reason === 'wrong-target');

  const once = fresh('preparation', 'rj7-conj-nonce');
  const firstUse = sup.admit(once, { targetRepoPath: target, scope: 'preparation' });
  const secondUse = sup.admit(once, { targetRepoPath: target, scope: 'preparation' });
  check('C2 NONCE: the first use of a nonce is admitted', !!firstUse && firstUse.ok === true);
  check(`C2 NONCE: the second use of one nonce is refused as a replay — got ${reasonOf(secondUse)}`,
    !!secondUse && secondUse.ok === false && secondUse.reason === 'replayed');

  const shortLived = fresh('preparation', 'rj7-conj-expiry', 1000);
  const afterExpiry = sup.admit(shortLived,
    { targetRepoPath: target, scope: 'preparation', now: Date.now() + 3600000 });
  check(`C2 EXPIRY: authority presented after its expiry is refused — got ${reasonOf(afterExpiry)}`,
    !!afterExpiry && afterExpiry.ok === false && afterExpiry.reason === 'expired');

  const wrongScope = sup.admit(fresh('preparation', 'rj7-conj-scope'),
    { targetRepoPath: target, scope: 'implementation' });
  check(`C2 SCOPE: preparation authority is refused by the implementation entry — got ${reasonOf(wrongScope)}`,
    !!wrongScope && wrongScope.ok === false && wrongScope.reason === 'wrong-scope');
  const wrongScopeBack = sup.admit(fresh('implementation', 'rj7-conj-scope-2'),
    { targetRepoPath: target, scope: 'preparation' });
  check(`C2 SCOPE: implementation authority is refused by the preparation entry — got ${reasonOf(wrongScopeBack)}`,
    !!wrongScopeBack && wrongScopeBack.ok === false && wrongScopeBack.reason === 'wrong-scope');

  // PARENT LIVENESS, from a supervisor this host can prove is gone.
  const deadTarget = repoProject('rj7-target-dead-parent');
  const dead = plantDeadParent(checkoutA, deadTarget, 'SUP-DEAD-PARENT', { grant: true });
  check('C2 harness: a dead parent planted a lease and a child authority, then exited',
    !!dead.answer && dead.answer.ok === true && dead.answer.grantOk === true && !!dead.answer.authority,
    dead.why);
  const orphanAuthority = (dead.answer && dead.answer.authority) || null;
  const orphanAdmit = orphanAuthority
    ? sup.admit(orphanAuthority, { targetRepoPath: deadTarget, scope: 'preparation' })
    : null;
  check(`C2 PARENT LIVENESS: a child of a dead parent is refused — got ${reasonOf(orphanAdmit)}`,
    !!orphanAdmit && orphanAdmit.ok === false && orphanAdmit.reason === 'wrong-parent');

  // The shared admission step both entry paths call, driven through its documented channel.
  const authorityFile = path.join(tmp, 'child-authority.json');
  const writeAuthority = (authority) => {
    fs.writeFileSync(authorityFile, `${JSON.stringify(authority, null, 2)}\n`);
    return { ...process.env, PIPELINE_CHILD_AUTHORITY: authorityFile };
  };

  const entryPrep = sup.admitEntry('preparation', {
    targetRepoPath: target, repoRoot: checkoutB, env: writeAuthority(fresh('preparation', 'rj7-entry-prep')),
  });
  check('C2 the preparation ENTRY admits a valid preparation authority as a supervisor child',
    !!entryPrep && entryPrep.ok === true && entryPrep.mode === 'supervisor-child'
    && !!entryPrep.admission, JSON.stringify(entryPrep));
  const entryImplWrongScope = sup.admitEntry('implementation', {
    targetRepoPath: target, repoRoot: checkoutB, env: writeAuthority(fresh('preparation', 'rj7-entry-cross')),
  });
  check(`C2 the implementation ENTRY refuses a preparation authority — got ${reasonOf(entryImplWrongScope)}`,
    !!entryImplWrongScope && entryImplWrongScope.ok === false
    && entryImplWrongScope.reason === 'wrong-scope');
  const entryImpl = sup.admitEntry('implementation', {
    targetRepoPath: target, repoRoot: checkoutB, env: writeAuthority(fresh('implementation', 'rj7-entry-impl')),
  });
  check('C2 the implementation ENTRY admits a valid implementation authority',
    !!entryImpl && entryImpl.ok === true && entryImpl.mode === 'supervisor-child');
  const noAuthorityEnv = { ...process.env };
  delete noAuthorityEnv.PIPELINE_CHILD_AUTHORITY;
  const entryUnrelated = sup.admitEntry('preparation', {
    targetRepoPath: target, repoRoot: checkoutB, env: noAuthorityEnv,
  });
  check('C2 an entry presenting NO authority while a supervisor is live is refused by owner name',
    !!entryUnrelated && entryUnrelated.ok === false
    && /SUP-ALPHA/.test(String(entryUnrelated.message || '')), JSON.stringify(entryUnrelated));
  const entryStandalone = sup.admitEntry('preparation', {
    targetRepoPath: spare, repoRoot: checkoutB, env: noAuthorityEnv,
  });
  check('C2 an entry presenting no authority with NO supervisor present is the standalone case',
    !!entryStandalone && entryStandalone.ok === true && entryStandalone.mode === 'standalone',
    JSON.stringify(entryStandalone));

  // The two REAL entry paths. A child authority the supervisor granted must get past admission;
  // the same paths refuse a forged one. `runner/preflight.js` reads the environment, so the
  // variable is set around each call and removed afterwards.
  const childPrepEnvFile = fresh('preparation', 'rj7-real-prep');
  process.env.PIPELINE_CHILD_AUTHORITY = authorityFile;
  fs.writeFileSync(authorityFile, `${JSON.stringify(childPrepEnvFile, null, 2)}\n`);
  const childPrepIo = say();
  const childPrepCode = await prepare.main(
    ['start', 'rj7childbatch', '--config', cfgPath, '--issue', 'rj7-real-prep'],
    { out: () => {}, err: childPrepIo.fn });
  check('C2 prepare-batch with valid preparation authority is NOT refused by ownership',
    childPrepCode !== prepare.EXIT_REFUSED
    && !/owned by|child authority|forged/i.test(childPrepIo.text()),
    `exit ${childPrepCode}: ${childPrepIo.text().slice(0, 400)}`);

  fs.writeFileSync(authorityFile, `${JSON.stringify(handMade, null, 2)}\n`);
  const forgedPrepIo = say();
  const forgedPrepCode = await prepare.main(
    ['start', 'rj7forgedbatch', '--config', cfgPath, '--issue', 'rj7-real-prep'],
    { out: () => {}, err: forgedPrepIo.fn });
  check(`C2 prepare-batch with forged authority is refused with exit ${prepare.EXIT_REFUSED} — got ${forgedPrepCode}`,
    forgedPrepCode === prepare.EXIT_REFUSED);
  check('C2 ... and the prepare-batch refusal names the reason it refused',
    /forged/i.test(forgedPrepIo.text()), forgedPrepIo.text().slice(0, 400));

  const leaseBytesBefore = digestOf(lock.globalLockPath(target));
  const childImplAuthority = fresh('implementation', 'rj7-real-impl');
  fs.writeFileSync(authorityFile, `${JSON.stringify(childImplAuthority, null, 2)}\n`);
  const childPreSpy = spyDeps();
  const childPre = preflightMod.preflight(runCfg(target), checkoutB, logFor('RUN-CHILD'), childPreSpy.deps);
  check('C2 preflight with valid implementation authority passes, so the run entry accepts it',
    !!childPre && childPre.ok === true, JSON.stringify(childPre && childPre.reason));
  check('C2 that preflight reports the admission it was let in on',
    !!childPre && !!childPre.childAdmission
    && childPre.childAdmission.nonce === childImplAuthority.nonce,
    JSON.stringify(childPre && childPre.childAdmission));
  check('C2 an admitted child takes NO target lock of its own — the parent lease is untouched',
    digestOf(lock.globalLockPath(target)) === leaseBytesBefore);
  check('C2 ... and the ordinary gates after admission still ran for the child',
    childPreSpy.calls.join(',').includes('dockerAvailable'), childPreSpy.calls.join(','));
  delete process.env.PIPELINE_CHILD_AUTHORITY;

  // ════ C3: two isolated workers, non-overlapping sections, no self-widening ════════════════
  const workerA = fresh('implementation', 'rj7-worker-a');
  const workerB = fresh('implementation', 'rj7-worker-b');
  const admA = sup.admit(workerA, { targetRepoPath: target, scope: 'implementation' });
  const admB = sup.admit(workerB, { targetRepoPath: target, scope: 'implementation' });
  check('C3 two authorized isolated worker operations are live at the same time',
    !!admA && admA.ok === true && !!admB && admB.ok === true
    && admA.admission.nonce !== admB.admission.nonce,
    `${reasonOf(admA)} / ${reasonOf(admB)}`);
  const live = sup.outstanding(target);
  check('C3 both live children are visible in one place',
    Array.isArray(live)
    && live.some((e) => e.nonce === workerA.nonce && e.state === 'redeemed')
    && live.some((e) => e.nonce === workerB.nonce && e.state === 'redeemed'),
    JSON.stringify(live));

  // THE DETERMINISTIC FIXTURE. A fixed script of enter/exit moves, a ledger with a monotonic
  // tick, and then an OVERLAP TEST over the recorded intervals. Nothing here waits on a clock,
  // a thread or a timer: the interleaving is the same on every host and on every run, which is
  // what makes "never overlap" a proof rather than an observation that happened to hold once.
  const SCRIPT = [
    ['A', 'enter', 'beads-write', true],
    ['B', 'enter', 'beads-write', false],
    ['B', 'enter', 'integration-publish', true],
    ['A', 'enter', 'integration-publish', false],
    ['A', 'exit', 'beads-write', true],
    ['B', 'enter', 'beads-write', true],
    ['B', 'exit', 'integration-publish', true],
    ['A', 'enter', 'integration-publish', true],
    ['B', 'exit', 'beads-write', true],
    ['A', 'exit', 'integration-publish', true],
  ];
  const admissions = { A: admA && admA.admission, B: admB && admB.admission };
  const held = { A: {}, B: {} };
  const ledger = [];
  const mismatches = [];
  let tick = 0;
  let fixtureError = null;
  try {
    for (const [who, move, section, expected] of SCRIPT) {
      tick += 1;
      if (move === 'enter') {
        const r = sup.tryEnterSection(admissions[who], section);
        const entered = !!(r && r.ok === true);
        if (entered !== expected) mismatches.push(`${who} enter ${section} -> ${entered}, expected ${expected}`);
        if (entered) { held[who][section] = r.held; ledger.push({ tick, who, section, event: 'enter' }); }
        else if (!r || !r.holder) mismatches.push(`${who} enter ${section} was refused without naming a holder`);
        else if (r.holder.nonce !== admissions[who === 'A' ? 'B' : 'A'].nonce) {
          mismatches.push(`${who} enter ${section} was refused naming ${r.holder.nonce}, not the other worker`);
        }
      } else {
        sup.exitSection(held[who][section]);
        delete held[who][section];
        ledger.push({ tick, who, section, event: 'exit' });
      }
    }
  } catch (e) { fixtureError = (e && e.message) || String(e); }
  check('C3 the deterministic section fixture ran to completion', fixtureError === null, fixtureError);
  check('C3 every move in the fixture answered exactly as the script requires',
    mismatches.length === 0, mismatches.join('; '));

  function intervalsFor(section) {
    const open = {};
    const out = [];
    for (const row of ledger) {
      if (row.section !== section) continue;
      if (row.event === 'enter') open[row.who] = row.tick;
      else { out.push({ who: row.who, from: open[row.who], to: row.tick }); delete open[row.who]; }
    }
    for (const [who, from] of Object.entries(open)) out.push({ who, from, to: Infinity });
    return out;
  }
  for (const section of ['beads-write', 'integration-publish']) {
    const spans = intervalsFor(section);
    const overlaps = [];
    for (let i = 0; i < spans.length; i += 1) {
      for (let j = i + 1; j < spans.length; j += 1) {
        if (spans[i].who === spans[j].who) continue;
        if (spans[i].from < spans[j].to && spans[j].from < spans[i].to) {
          overlaps.push(`${spans[i].who}[${spans[i].from},${spans[i].to}] vs ${spans[j].who}[${spans[j].from},${spans[j].to}]`);
        }
      }
    }
    check(`C3 no two workers' \`${section}\` sections ever overlap (${spans.length} intervals recorded)`,
      spans.length >= 2 && overlaps.length === 0, overlaps.join('; ') || 'too few intervals to prove anything');
  }
  // The other half of "may be live TOGETHER": the two sections are independent resources. If
  // holding one excluded the other, the fixture above would still show no overlap and the whole
  // criterion would have been satisfied by serialising the two workers completely.
  check('C3 the two named sections are independent — one worker publishes while the other writes Beads',
    ledger.some((r) => r.who === 'B' && r.section === 'integration-publish' && r.event === 'enter'
      && ledger.some((o) => o.who === 'A' && o.section === 'beads-write' && o.event === 'enter' && o.tick < r.tick)
      && ledger.some((o) => o.who === 'A' && o.section === 'beads-write' && o.event === 'exit' && o.tick > r.tick)));

  const crossProcess = spawnSync(process.execPath, ['-e', [
    `const s = require(${JSON.stringify(fwd(SUPERVISOR))});`,
    `const a = s.admit(${JSON.stringify(fresh('implementation', 'rj7-worker-c'))},`,
    `  { targetRepoPath: ${JSON.stringify(fwd(target))}, scope: 'implementation' });`,
    "const r = a.ok ? s.tryEnterSection(a.admission, 'beads-write') : null;",
    'process.stdout.write(JSON.stringify({ admitted: !!a.ok, reason: a.reason || null, entered: !!(r && r.ok), holder: r && r.holder }));',
  ].join('\n')], { encoding: 'utf8', timeout: 120000, env: rivalEnv, windowsHide: true });
  let crossAnswer = null;
  try { crossAnswer = JSON.parse(crossProcess.stdout || 'null'); } catch { crossAnswer = null; }
  const guardHeld = sup.tryEnterSection(admA.admission, 'beads-write');
  const crossProcessTwo = spawnSync(process.execPath, ['-e', [
    `const s = require(${JSON.stringify(fwd(SUPERVISOR))});`,
    `const a = s.admit(${JSON.stringify(fresh('implementation', 'rj7-worker-d'))},`,
    `  { targetRepoPath: ${JSON.stringify(fwd(target))}, scope: 'implementation' });`,
    "const r = a.ok ? s.tryEnterSection(a.admission, 'beads-write') : null;",
    'process.stdout.write(JSON.stringify({ admitted: !!a.ok, entered: !!(r && r.ok), holder: r && r.holder }));',
  ].join('\n')], { encoding: 'utf8', timeout: 120000, env: rivalEnv, windowsHide: true });
  let crossAnswerTwo = null;
  try { crossAnswerTwo = JSON.parse(crossProcessTwo.stdout || 'null'); } catch { crossAnswerTwo = null; }
  check('C3 harness: a separate worker process could be admitted and asked about a section',
    crossAnswer !== null && crossAnswer.admitted === true,
    `${crossProcess.status}: ${String(crossProcess.stderr || '').trim().split('\n').slice(-2).join(' ')}`);
  check('C3 a worker in a SEPARATE process may enter a free section',
    !!crossAnswer && crossAnswer.entered === true, JSON.stringify(crossAnswer));
  check('C3 a worker in a SEPARATE process is kept OUT of a section this process holds',
    !!guardHeld && guardHeld.ok === true && !!crossAnswerTwo && crossAnswerTwo.entered === false
    && !!crossAnswerTwo.holder && crossAnswerTwo.holder.nonce === admA.admission.nonce,
    JSON.stringify(crossAnswerTwo));
  if (guardHeld && guardHeld.ok) sup.exitSection(guardHeld.held);

  // No self-widening: not by asking, not by editing, not by reaching for a section it has no
  // authority over.
  const selfGrant = (() => {
    try { return sup.grant(admA.admission, { scope: 'implementation', issueId: 'rj7-worker-a', ttlMs: TTL }); }
    catch (e) { return { ok: false, error: (e && e.message) || String(e) }; }
  })();
  check('C3 a child holding only an ADMISSION cannot grant itself fresh authority',
    !!selfGrant && selfGrant.ok === false, JSON.stringify(selfGrant));
  const widened = { ...fresh('preparation', 'rj7-widen'), scope: 'implementation' };
  const widenedAdmit = sup.admit(widened, { targetRepoPath: target, scope: 'implementation' });
  check(`C3 a child that rewrites its own scope to implementation is refused — got ${reasonOf(widenedAdmit)}`,
    !!widenedAdmit && widenedAdmit.ok === false
    && ['forged', 'wrong-scope'].includes(widenedAdmit.reason));
  const stretched = (() => {
    const a = fresh('preparation', 'rj7-stretch');
    return { ...a, expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString() };
  })();
  const stretchedAdmit = sup.admit(stretched, { targetRepoPath: target, scope: 'preparation' });
  check(`C3 a child that stretches its own expiry is refused — got ${reasonOf(stretchedAdmit)}`,
    !!stretchedAdmit && stretchedAdmit.ok === false && stretchedAdmit.reason === 'forged');
  const outOfScopeSection = sup.tryEnterSection(admA.admission, 'freeze-commit');
  check('C3 a child cannot enter a section outside the two it was admitted for',
    !!outOfScopeSection && outOfScopeSection.ok === false, JSON.stringify(outOfScopeSection));

  // ════ C4: every bad authority refused before mutation, records untouched ══════════════════
  const released = fresh('preparation', 'rj7-released');
  const settled = sup.settle(lease.lease, released.nonce, { outcome: 'released' });
  check('C4 harness: the parent released one of its own grants',
    !!settled && settled.ok === true, JSON.stringify(settled));

  const cases = [
    ['forged (never granted)', handMade, 'preparation', target, 'forged'],
    ['forged (edited after grant)', { ...fresh('preparation', 'rj7-c4-edit'), batch: 'rj7-other-batch' }, 'preparation', target, 'forged'],
    ['expired', fresh('preparation', 'rj7-c4-expiry', 1000), 'preparation', target, 'expired'],
    ['wrong-target', fresh('preparation', 'rj7-c4-target'), 'preparation', spare, 'wrong-target'],
    ['wrong-parent', orphanAuthority, 'preparation', deadTarget, 'wrong-parent'],
    ['released by the parent', released, 'preparation', target, 'released'],
  ];
  for (const [label, authority, scope, against, want] of cases) {
    const before = ownershipSnapshot(against);
    const gitPre = gitState(against);
    const answer = authority
      ? sup.admit(authority, { targetRepoPath: against, scope, now: Date.now() + 3600000 })
      : null;
    check(`C4 ${label} child authority is refused — got ${reasonOf(answer)}`,
      !!answer && answer.ok === false && answer.reason === want);
    check(`C4 ... and the ${label} refusal names the nonce and the parent so it can be acted on`,
      !!answer && typeof answer.message === 'string'
      && (authority ? answer.message.includes(String(authority.nonce)) : false)
      && /SUP-/.test(answer.message), String(answer && answer.message));
    const drift = ownershipDrift(before, ownershipSnapshot(against));
    check(`C4 ... and the ${label} refusal leaves every existing ownership record untouched`,
      drift.length === 0, drift.join('; '));
    check(`C4 ... and the ${label} refusal mutates no Git state in the target`,
      gitState(against) === gitPre);
  }
  // A replay needs its first use to have happened, so its snapshot is taken after that.
  const replayOnce = fresh('preparation', 'rj7-c4-replay');
  sup.admit(replayOnce, { targetRepoPath: target, scope: 'preparation' });
  const replayBefore = ownershipSnapshot(target);
  const replayGitBefore = gitState(target);
  const replayed = sup.admit(replayOnce, { targetRepoPath: target, scope: 'preparation' });
  check(`C4 replayed child authority is refused — got ${reasonOf(replayed)}`,
    !!replayed && replayed.ok === false && replayed.reason === 'replayed');
  const replayDrift = ownershipDrift(replayBefore, ownershipSnapshot(target));
  check('C4 ... and the replay refusal leaves every existing ownership record untouched',
    replayDrift.length === 0, replayDrift.join('; '));
  check('C4 ... and the replay refusal mutates no Git state in the target',
    gitState(target) === replayGitBefore);

  // The same refusals through the REAL entry paths, where "before mutation" is measurable:
  // no Docker probe, no network up, no Beads writer, no change to the target's HEAD or
  // porcelain state, and no ownership record edited.
  for (const [label, authority] of [
    ['forged', handMade],
    ['expired', (() => { const a = fresh('implementation', 'rj7-entry-expiry', 1); spinPast(25); return a; })()],
    ['released', (() => { const a = fresh('implementation', 'rj7-entry-released'); sup.settle(lease.lease, a.nonce, { outcome: 'released' }); return a; })()],
  ]) {
    fs.writeFileSync(authorityFile, `${JSON.stringify(authority, null, 2)}\n`);
    process.env.PIPELINE_CHILD_AUTHORITY = authorityFile;
    const before = ownershipSnapshot(target);
    const gitPre = gitState(target);
    const spy = spyDeps();
    const answer = preflightMod.preflight(runCfg(target), checkoutB, logFor('RUN-BAD-CHILD'), spy.deps);
    check(`C4 the run entry path refuses ${label} child authority`,
      !!answer && answer.ok === false, JSON.stringify(answer));
    check(`C4 ... and names why it refused (${label})`,
      !!answer && new RegExp(label, 'i').test(String(answer.reason || '')), String(answer && answer.reason));
    check(`C4 ... and refuses ${label} BEFORE any Docker, network, identity or Beads call`,
      spy.calls.length === 0, `called: ${spy.calls.join(', ')}`);
    check(`C4 ... and leaves every existing ownership record untouched (${label})`,
      ownershipDrift(before, ownershipSnapshot(target)).length === 0,
      ownershipDrift(before, ownershipSnapshot(target)).join('; '));
    check(`C4 ... and mutates no Git state in the target (${label})`, gitState(target) === gitPre);

    const io = say();
    const code = await prepare.main(['start', `rj7bad${label}`, '--config', cfgPath, '--issue', 'rj7-demo'],
      { out: () => {}, err: io.fn });
    check(`C4 the preparation entry path refuses ${label} child authority with exit ${prepare.EXIT_REFUSED} — got ${code}`,
      code === prepare.EXIT_REFUSED);
    check(`C4 ... and launched no preparation worker for it (${label})`,
      !fs.existsSync(path.join(PREP_ROOT, `rj7bad${label}`)));
    check(`C4 ... and mutated no Git state in the target (${label}, preparation entry)`,
      gitState(target) === gitPre);
    delete process.env.PIPELINE_CHILD_AUTHORITY;
  }

  // ════ C5: interruption evidence, no takeover of the living, reclaim of the dead ═══════════
  // A live parent is never taken over — not by a second supervisor, and not by one waving
  // `reclaim`. A bounded retry that eventually wins would be the two-writers bug wearing a hat.
  const leaseBytes = digestOf(lock.globalLockPath(target));
  const attempts = [
    sup.acquire(checkoutB, target, 'SUP-INTRUDER-1'),
    sup.acquire(checkoutB, target, 'SUP-INTRUDER-2'),
    sup.acquire(checkoutB, target, 'SUP-INTRUDER-3', { reclaim: true }),
  ];
  check('C5 a LIVE parent is never taken over, however many supervisors ask',
    attempts.every((a) => a && a.ok === false), JSON.stringify(attempts.map((a) => a && a.ok)));
  check('C5 ... not even by one asking for a reclaim — reclaim is no licence over the living',
    attempts[2] && attempts[2].ok === false && !!attempts[2].holder
    && attempts[2].holder.id === 'SUP-ALPHA', JSON.stringify(attempts[2]));
  check('C5 ... and the live lease record is byte-identical after all three attempts',
    digestOf(lock.globalLockPath(target)) === leaseBytes);
  check('C5 ... and the live supervisor is still the holder',
    (sup.leaseHolder(target) || {}).id === 'SUP-ALPHA');

  // CHILD interruption: a child that was started and never settled is explicit, recoverable
  // evidence — and only the parent can clear it.
  const interrupted = fresh('implementation', 'rj7-interrupted-child');
  const startedIt = sup.admit(interrupted, { targetRepoPath: target, scope: 'implementation' });
  check('C5 harness: an interrupted child was admitted and then never settled',
    !!startedIt && startedIt.ok === true);
  const evidence = (sup.outstanding(target) || []).filter((e) => e.nonce === interrupted.nonce);
  check('C5 an interrupted child leaves ONE explicit outstanding record',
    evidence.length === 1, JSON.stringify(sup.outstanding(target)));
  check('C5 that record names the scope, issue and batch a person needs to recover it',
    evidence.length === 1 && evidence[0].scope === 'implementation'
    && evidence[0].issueId === 'rj7-interrupted-child' && evidence[0].state === 'redeemed',
    JSON.stringify(evidence[0]));
  const settledChild = sup.settle(lease.lease, interrupted.nonce, { outcome: 'complete' });
  check('C5 only the parent settles a child, and settling is what clears the evidence',
    !!settledChild && settledChild.ok === true
    && !(sup.outstanding(target) || []).some((e) => e.nonce === interrupted.nonce));
  const grantedNeverStarted = fresh('preparation', 'rj7-never-started');
  check('C5 a child that never started is distinguishable from one that did',
    (sup.outstanding(target) || []).some((e) => e.nonce === grantedNeverStarted.nonce
      && e.state === 'granted'), JSON.stringify(sup.outstanding(target)));

  sup.release(checkoutA, target, lease.lease);

  // PARENT interruption. Three fixtures, because "a provably dead parent can be reclaimed"
  // and "without silently declaring its child complete" pull in opposite directions and only
  // both together say anything.
  const cleanDead = repoProject('rj7-target-dead-clean');
  const cleanPlant = plantDeadParent(checkoutA, cleanDead, 'SUP-DEAD-CLEAN');
  check('C5 harness: a dead parent with nothing outstanding was planted',
    !!cleanPlant.answer && cleanPlant.answer.ok === true, cleanPlant.why);
  const cleanReclaim = sup.acquire(checkoutB, cleanDead, 'SUP-SUCCESSOR-CLEAN');
  check('C5 a dead parent that left NOTHING behind is simply taken over, and says whose lease it seized',
    !!cleanReclaim && cleanReclaim.ok === true && cleanReclaim.tookOver === true
    && !!cleanReclaim.previous && cleanReclaim.previous.id === 'SUP-DEAD-CLEAN',
    JSON.stringify(cleanReclaim));
  if (cleanReclaim && cleanReclaim.ok) sup.release(checkoutB, cleanDead, cleanReclaim.lease);

  const evidenceDead = repoProject('rj7-target-dead-evidence');
  const evidencePlant = plantDeadParent(checkoutA, evidenceDead, 'SUP-DEAD-WITH-CHILD', { grant: true });
  check('C5 harness: a dead parent with an unsettled child was planted',
    !!evidencePlant.answer && evidencePlant.answer.ok === true
    && !!evidencePlant.answer.authority, evidencePlant.why);
  const orphanNonce = evidencePlant.answer && evidencePlant.answer.authority
    && evidencePlant.answer.authority.nonce;
  const blindReclaim = sup.acquire(checkoutB, evidenceDead, 'SUP-SUCCESSOR-BLIND');
  check('C5 a dead parent that left an unsettled child is NOT taken over silently',
    !!blindReclaim && blindReclaim.ok === false, JSON.stringify(blindReclaim));
  check('C5 ... and that refusal hands over the evidence, naming the unsettled child',
    !!blindReclaim && Array.isArray(blindReclaim.outstanding)
    && blindReclaim.outstanding.some((e) => e.nonce === orphanNonce),
    JSON.stringify(blindReclaim && blindReclaim.outstanding));
  const explicitReclaim = sup.acquire(checkoutB, evidenceDead, 'SUP-SUCCESSOR-EXPLICIT', { reclaim: true });
  check('C5 an EXPLICIT reclaim of a provably dead parent succeeds',
    !!explicitReclaim && explicitReclaim.ok === true && explicitReclaim.tookOver === true,
    JSON.stringify(explicitReclaim));
  check('C5 ... and the reclaim reports the dead parent and its unsettled child',
    !!explicitReclaim && !!explicitReclaim.previous
    && explicitReclaim.previous.id === 'SUP-DEAD-WITH-CHILD'
    && Array.isArray(explicitReclaim.previous.outstanding)
    && explicitReclaim.previous.outstanding.some((e) => e.nonce === orphanNonce),
    JSON.stringify(explicitReclaim && explicitReclaim.previous));
  check('C5 ... and the reclaim does NOT silently declare the dead parent\'s child complete',
    (sup.outstanding(evidenceDead) || []).some((e) => e.nonce === orphanNonce),
    JSON.stringify(sup.outstanding(evidenceDead)));
  check('C5 ... and the dead parent\'s child authority is still refused after the reclaim',
    (() => {
      const r = sup.admit(evidencePlant.answer.authority,
        { targetRepoPath: evidenceDead, scope: 'preparation' });
      return !!r && r.ok === false && ['wrong-parent', 'released'].includes(r.reason);
    })());
  if (explicitReclaim && explicitReclaim.ok) sup.release(checkoutB, evidenceDead, explicitReclaim.lease);

  const markerDead = repoProject('rj7-target-dead-marker');
  const markerNonce = crypto.randomBytes(20).toString('hex');
  const markerPlant = plantDeadParent(checkoutA, markerDead, 'SUP-DEAD-WITH-MARKER',
    { grant: true, marker: markerNonce });
  check('C5 harness: a dead parent left an uncertain preparation marker and an unsettled child',
    !!markerPlant.answer && markerPlant.answer.ok === true && markerPlant.answer.marked === true,
    markerPlant.why);
  const markerReclaim = sup.acquire(checkoutB, markerDead, 'SUP-SUCCESSOR-MARKER', { reclaim: true });
  check('C5 a dead parent holding an uncertain preparation marker can still be reclaimed explicitly',
    !!markerReclaim && markerReclaim.ok === true && markerReclaim.tookOver === true,
    JSON.stringify(markerReclaim));
  const survivors = (() => {
    try { return lock.listPreparationUncertain(markerDead).map((m) => m.nonce); }
    catch (e) { return [`unreadable: ${e && e.message}`]; }
  })();
  check('C5 ... and the reclaim does NOT delete the uncertain preparation marker',
    survivors.includes(markerNonce), JSON.stringify(survivors));
  check('C5 ... and the dead parent\'s child is still outstanding after that reclaim too',
    (sup.outstanding(markerDead) || []).some((e) => e.nonce
      === (markerPlant.answer.authority && markerPlant.answer.authority.nonce)),
    JSON.stringify(sup.outstanding(markerDead)));
  if (markerReclaim && markerReclaim.ok) sup.release(checkoutB, markerDead, markerReclaim.lease);
}

body()
  .catch((e) => {
    failed = 1;
    console.log(`FAIL - HARNESS BROKEN: unexpected exception: ${e && e.stack ? e.stack : e}`);
  })
  .then(() => {
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmrf(tmp);
    process.exit(failed);
  });
