#!/usr/bin/env node
// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// The freeze, as a command — PLANNING.md step 6 and step 8's first two bullets, automated
// (DESIGN.md §3.2, §4.12; change-log row `freeze-command`).
//
// WHAT THIS EXISTS FOR. Every enforcement point around the freeze sits at the END of the
// loop. `bd create` is one line, always available, needs no tests, and produces an issue that
// reads `ready` in `bd ready` forever; the freeze gate is invoked by hand and nothing records
// whether it ever ran; and the runner's refusal arrives minutes into a launch. Between "an
// issue exists" and "a run refuses it" there was no moment where a missing suite was anyone's
// problem — so a queue of eight dispatched zero, and the person who filed them had done
// nothing a tool could complain about at the time.
//
// Two verbs, for the two halves of that gap:
//
//   status   — what would a run dispatch RIGHT NOW, asked without launching one. The question
//              nobody could ask in advance.
//   commit   — the freeze itself: gate the suite, commit it with its receipt to the
//              integration branch, push, and then prove the runner will accept it.
//
// THE RULE IS NEVER RESTATED HERE. Both verbs reach `runner/queue.js` for the real
// dispatchability judgement — the same `partitionByFreeze` a run uses, against the same
// fetched branch, reading the same receipt. A second implementation of "is this frozen?" that
// agreed with the runner on the day it was written is the failure this file is meant to
// prevent, not a shortcut it may take: the whole value of asking in advance is that the
// answer is the one the run will give.
//
// WHAT IT DELIBERATELY DOES NOT DO: write the tests. The acceptance suite IS the spec (§2,
// hard invariant 3 — planning is interactive), and a machine that drafts it decides what
// "done" means with nobody in the room. `commit` refuses an issue whose suite directory is
// absent and says so in those words; that refusal is the tool working, not a gap in it.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { loadConfig } = require('../runner/config');
const {
  validateManagedProbe, promoteManagedSuite, rollbackManagedPromotion,
  finalizeManagedPromotion, removeOwnedContainer,
} = require('./prove-tests');
const {
  readyQueue, partitionByFreeze, resolveBranch, gitSpawnOptions, REFUSAL, RECEIPT_VERDICTS,
} = require('../runner/queue');
const { suiteHash, treeEntries } = require('../runner/suite-hash');

const ROOT = path.resolve(__dirname, '..');
const GATE = path.join(ROOT, 'scripts', 'freeze-gate.js');

const EXIT_OK = 0;
const EXIT_REFUSED = 1;   // a well-formed question, answered no
const EXIT_USAGE = 2;     // the command as typed cannot mean anything
const EXIT_UNKNOWN = 3;   // could not tell — bd, git or the gate was unavailable

// The gate's verdicts, by the exit code it uses for each (`scripts/freeze-gate.js`). Read as
// data rather than compared inline so the refusal message can name the verdict a planner will
// have seen in the gate's own report, in the gate's own word.
const GATE_VERDICT = {
  0: 'red',
  1: 'green',
  2: 'indeterminate',
  3: 'unreachable',
  4: 'half-proven',
  5: 'stale-guard',
};

// The two verdicts a freeze may proceed on — the RUNNER'S OWN SET, imported rather than
// restated. `runner/queue.js` keeps a reader's set and a writer's set apart deliberately, on
// the reasoning that a writer writes one version and a reader accepts every version it can
// still interpret; that reasoning does not apply here, because this command's whole job is to
// push only what a run will take. A literal pair that agreed on the day it was written is the
// drift this file exists to remove, not one it may introduce.
const PROCEEDS = RECEIPT_VERDICTS;

const USAGE = [
  'usage:',
  '  node scripts/freeze.js status --config run.config.<project>.json',
  '  node scripts/freeze.js commit <issue-id> [<issue-id>...] --config run.config.<project>.json',
  '',
  'status options:',
  '  --config <file>        the run config a launch would type (required)',
  '',
  'commit options:',
  '  --config <file>        the run config a launch would type (required)',
  '  --probe <dir>          a repo-shaped tree in which the criteria are already satisfied,',
  '                         handed to the freeze gate as --green (PLANNING.md step 4)',
  '  --allow-half-proven    proceed on a red suite no probe was ever run against',
  '  --dry-run              gate everything and report, but commit and push nothing',
].join('\n');

// ---- argument parsing --------------------------------------------------------------------
// Flags that take a value are named, so `--config` with nothing after it is a usage error
// rather than a config path of `undefined` reported ten lines later as a missing file.
const VALUE_FLAGS = new Set(['--config', '--probe']);
const BARE_FLAGS = new Set(['--allow-half-proven', '--dry-run']);

function parseArgs(argv) {
  const opts = { positional: [], config: null, probe: null, allowHalfProven: false, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (VALUE_FLAGS.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        return { error: `${arg} needs a value` };
      }
      if (arg === '--config') opts.config = value;
      if (arg === '--probe') opts.probe = value;
      i += 1;
      continue;
    }
    if (BARE_FLAGS.has(arg)) {
      if (arg === '--allow-half-proven') opts.allowHalfProven = true;
      if (arg === '--dry-run') opts.dryRun = true;
      continue;
    }
    if (arg.startsWith('--')) return { error: `unknown option "${arg}"` };
    opts.positional.push(arg);
  }
  return opts;
}

// ---- shared -------------------------------------------------------------------------------

// The config, or the reason there is none. `loadConfig` throws on every malformed shape, and a
// stack trace is the wrong answer for a typo in a filename.
function load(file) {
  if (!file) return { ok: false, error: '--config names the run.config.<project>.json a launch would type' };
  try {
    return { ok: true, cfg: loadConfig(path.resolve(file)) };
  } catch (e) {
    return { ok: false, error: `cannot read ${file}: ${(e && e.message) || String(e)}` };
  }
}

const git = (cfg, args, extra) => spawnSync('git', args, gitSpawnOptions(cfg, extra));

// What a planner does about each refusal, keyed by the runner's own refusal kind. The runner
// prints a remedy in its report too; this is the same advice arriving early enough to act on.
const REMEDY = {
  [REFUSAL.NO_SUITE]: 'write the acceptance tests, then: node scripts/freeze.js commit <id> --config <config>',
  [REFUSAL.NO_RECEIPT]: 're-run the freeze gate over the suite and push the receipt with it: node scripts/freeze.js commit <id> --config <config>',
  [REFUSAL.MISMATCH]: 'the suite changed after the gate blessed it — re-freeze it: node scripts/freeze.js commit <id> --config <config>',
  [REFUSAL.HALF_PROVEN]: 'build a probe and re-freeze (PLANNING.md step 4), or set allowHalfProven in the run config',
};

const remedyFor = (kind) => REMEDY[kind] || 'see the refusal above';

// ---- status --------------------------------------------------------------------------------
// A REPORT plus one bit of signal. It changes nothing, touches no Beads state and writes to no
// tree — safe to run at any time, including while a run is in flight.
//
// The exit code answers one question and not a broader one: **would a launch right now do any
// work at all?** A partly-frozen queue is the normal state of a project being worked and exits
// 0; a queue that has candidates and can dispatch none of them exits 1, because that is the
// state a run reports as success today while doing nothing whatsoever.
function status(opts, out, err) {
  if (opts.positional.length) {
    err(`freeze: status takes no issue ids (got "${opts.positional[0]}")`);
    return EXIT_USAGE;
  }
  const loaded = load(opts.config);
  if (!loaded.ok) {
    err(`freeze: ${loaded.error}`);
    return EXIT_USAGE;
  }
  const cfg = loaded.cfg;

  const q = readyQueue(cfg);
  if (!q.ok) {
    // The runner's own two failure channels, kept apart by the field it sets rather than by
    // the wording: a git failure reported as a Beads failure sends a person to the wrong system.
    err(`freeze: cannot tell what is frozen — ${q.cause === 'bd' ? 'the Beads ready queue could not be read' : 'the integration branch could not be read'}: ${q.error}`);
    return EXIT_UNKNOWN;
  }

  const ready = q.issues || [];
  const refused = q.undispatchable || [];
  const skipped = q.skipped || [];

  out(`== what a run would dispatch right now: ${ready.length} of ${ready.length + refused.length} ==`);
  out('');
  out(`DISPATCHABLE (${ready.length}):`);
  for (const issue of ready) out(`  ${issue.id}  ${issue.title || ''}`.trimEnd());
  if (!ready.length) out('  (none)');

  out('');
  out(`NOT DISPATCHABLE (${refused.length}):`);
  for (const u of refused) {
    const id = (u.issue && u.issue.id) || '(unknown)';
    out(`  ${id}  ${(u.issue && u.issue.title) || ''}`.trimEnd());
    out(`      ${u.reason}`);
    out(`      remedy: ${remedyFor(u.refusal)}`);
  }
  if (!refused.length) out('  (none)');

  // Epic parents are filtered by type and are NOT a finding: `bd ready` returns them by design
  // and the runner drops them, so reporting them as refused would raise a false alarm on every
  // single run of this command.
  if (skipped.length) {
    out('');
    out(`filtered by type (${skipped.length}, expected): ${skipped.map((i) => i.id).join(', ')}`);
  }

  out('');
  if (!ready.length && refused.length) {
    out('a launch now would dispatch NOTHING: every candidate is refused for want of a freeze.');
    return EXIT_REFUSED;
  }
  if (!ready.length) {
    out('the ready queue is empty — nothing is waiting, which is a legitimate no-op.');
    return EXIT_OK;
  }
  return EXIT_OK;
}

// ---- commit ---------------------------------------------------------------------------------

// The suite as it stands in the operator's working tree. `commit` freezes what is on disk, so
// this is deliberately the working copy and not a branch — the opposite of the runner's rule,
// and for the opposite reason: the runner asks what the container will fork from, and this asks
// what the planner just wrote.
function localSuite(cfg, issueId, repoRoot = cfg.targetRepoPath) {
  const rel = `tests/acceptance/${issueId}`;
  const abs = path.join(repoRoot, rel);
  let entries;
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true });
  } catch {
    return {
      ok: false,
      reason: `no acceptance suite at ${rel}/ in ${repoRoot}`,
      // Named as the interactive step it is, because this is the refusal a person will hit
      // most and the wrong reading of it — "the tool is broken" — costs a planning session.
      detail: 'the tests are the spec and are written with the user, never by this command '
        + '(PLANNING.md step 3). Write them there first, then freeze them here.',
    };
  }
  const files = entries.filter((e) => e.isFile() && e.name !== '.freeze-gate.json');
  if (!files.length) {
    return {
      ok: false,
      reason: `${rel}/ exists but holds no test files`,
      detail: 'an empty suite directory is the vacuous freeze the gate exists to prevent — '
        + 'the verifier would exit 1 on "no test files" for every attempt.',
    };
  }
  return { ok: true, rel, abs, files: files.length };
}

// The gate, through `process.execPath` rather than by shelling out to a path — the Windows host
// cannot execute a `#!` line, and every executable seam in this repo is invoked this way.
function runGate(cfg, rel, probe, out, repoRoot = cfg.targetRepoPath) {
  const args = [GATE, '--repo', repoRoot, '--tests', `${rel}/`];
  if (probe) args.push('--green', probe);
  const env = { ...process.env, FREEZE_GATE_DOCKER_IMAGE: cfg.image };
  if (env.PIPELINE_TESTING_FREEZE_GATE_SEAM !== '1') {
    delete env.FREEZE_GATE_CMD; delete env.FREEZE_GATE_DOCKER_CMD;
  }
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', env });
  if (r.error || r.status === null) {
    return { ok: false, verdict: null, report: (r.stderr || '') + ((r.error && r.error.message) || '') };
  }
  const report = `${r.stdout || ''}${r.stderr || ''}`;
  return { ok: true, verdict: GATE_VERDICT[r.status] || `exit ${r.status}`, code: r.status, report };
}

// Nothing may already be staged in the target checkout. A freeze commit stages named paths and
// then commits the INDEX, so a file another session left staged would ride into a commit under
// this one's message — the exact accident CLAUDE.md's staging rule was written after.
function indexIsClean(cfg) {
  const r = git(cfg, ['diff', '--cached', '--name-only', '-z'], { cwd: cfg.targetRepoPath });
  if (r.status !== 0) {
    return { ok: false, error: `cannot read the index of ${cfg.targetRepoPath}: ${(r.stderr || '').trim()}` };
  }
  const staged = String(r.stdout || '').split('\0').filter(Boolean);
  if (staged.length) {
    return {
      ok: false,
      error: `${staged.length} path(s) are already staged in ${cfg.targetRepoPath} — this command commits the index, `
        + `so they would ride into the freeze commit under its message: ${staged.slice(0, 5).join(', ')}`
        + `${staged.length > 5 ? ', …' : ''}`,
    };
  }
  return { ok: true };
}

const normalizeGitPath = (p) => String(p).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');

// The index is shared by every process using this checkout. The clean check immediately above
// cannot lock it: another session may stage a path after the check and before this process calls
// `git commit`. Query it again after our named adds, reject anything outside the suites this
// invocation gated. Production calls this against a private index, not the checkout's shared
// one; the helper is also the fail-closed parser for either context.
function stagedFreezePaths(cfg, gated, run = git, extra = {}) {
  const r = run(cfg, ['diff', '--cached', '--name-only', '-z'], { cwd: cfg.targetRepoPath, ...extra });
  if (r.status !== 0) {
    return { ok: false, kind: 'query', error: `cannot read the staged freeze paths: ${(r.stderr || '').trim() || `exit ${r.status}`}` };
  }
  const staged = String(r.stdout || '').split('\0').filter(Boolean).map(normalizeGitPath);
  const roots = gated.map((g) => normalizeGitPath(g.rel));
  const approved = (p) => roots.some((root) => p === root || p.startsWith(`${root}/`));
  const outside = staged.filter((p) => !approved(p));
  if (outside.length) {
    return { ok: false, kind: 'outside', staged, outside,
      error: `${outside.length} concurrently staged path(s) are outside the approved freeze suites: ${outside.slice(0, 5).join(', ')}`
        + `${outside.length > 5 ? ', …' : ''}` };
  }
  return { ok: true, staged, outside: [] };
}

// Roll back only paths this invocation owns. A blanket reset would discard the very concurrent
// index work the check above detected. Promotion changes the working tree as well, so its exact
// backup is restored after the approved paths have been removed from the index.
function rollbackFreezePreparation(cfg, gated, promotion, run = git,
  rollbackPromotion = rollbackManagedPromotion) {
  const errors = [];
  const rels = gated.map((g) => g.rel);
  if (rels.length) {
    const reset = run(cfg, ['reset', '-q', '--', ...rels], { cwd: cfg.targetRepoPath });
    if (reset.status !== 0) errors.push(`could not reset approved suite paths: ${(reset.stderr || '').trim() || `exit ${reset.status}`}`);
  }
  if (promotion) {
    const rolled = rollbackPromotion(promotion);
    if (!rolled.ok) errors.push(`could not restore promoted suite: ${rolled.error}`);
  }
  return errors.length ? { ok: false, error: errors.join('; ') } : { ok: true };
}

function removeSnapshot(snapshot) {
  if (!snapshot || !snapshot.tempDir) return;
  try { fs.rmSync(snapshot.tempDir, { recursive: true, force: true }); } catch { /* best effort */ }
}

function validateTreeSnapshot(cfg, gated, head, tree, run = git) {
  const changed = run(cfg, ['diff-tree', '-r', '--no-commit-id', '--name-only', '-z', head, tree],
    { cwd: cfg.targetRepoPath });
  if (changed.status !== 0) {
    return { ok: false, error: `cannot inspect the freeze tree: ${(changed.stderr || '').trim() || `exit ${changed.status}`}` };
  }
  const paths = String(changed.stdout || '').split('\0').filter(Boolean).map(normalizeGitPath);
  const roots = gated.map((g) => normalizeGitPath(g.rel));
  const outside = paths.filter((p) => !roots.some((root) => p === root || p.startsWith(`${root}/`)));
  if (outside.length) return { ok: false, error: `freeze tree contains paths outside the approved suites: ${outside.join(', ')}` };

  for (const g of gated) {
    const receiptRel = `${normalizeGitPath(g.rel)}/.freeze-gate.json`;
    const shown = run(cfg, ['show', `${tree}:${receiptRel}`], { cwd: cfg.targetRepoPath });
    if (shown.status !== 0) return { ok: false, error: `freeze tree has no readable receipt for ${g.id}` };
    let receipt;
    try { receipt = JSON.parse(shown.stdout || ''); }
    catch { return { ok: false, error: `freeze tree has a malformed receipt for ${g.id}` }; }
    let hash;
    try { hash = suiteHash(treeEntries(cfg.targetRepoPath, tree, g.rel, { timeoutMs: gitSpawnOptions(cfg).timeout })); }
    catch (e) { return { ok: false, error: `cannot hash ${g.id} in the freeze tree: ${e.message}` }; }
    if (!receipt || receipt.suiteHash !== hash || receipt.verdict !== g.verdict) {
      return { ok: false, error: `freeze tree does not match the gated receipt for ${g.id}` };
    }
  }
  return { ok: true, paths };
}

// Build the candidate commit in a private index seeded from the exact validated HEAD. The real
// index is never used as the commit source, so concurrent staging cannot enter the tree. Once
// `write-tree` returns, later working-tree edits — including edits inside the approved suite —
// cannot change this immutable object.
function prepareFreezeSnapshot(cfg, gated, head, run = git, tempRoot = os.tmpdir()) {
  const tempDir = fs.mkdtempSync(path.join(path.resolve(tempRoot), 'freeze-index-'));
  const index = path.join(tempDir, 'index');
  const env = { ...process.env, GIT_INDEX_FILE: index };
  const extra = { env };
  const fail = (error) => { const answer = { ok: false, error, tempDir, index }; removeSnapshot(answer); return answer; };

  const seeded = run(cfg, ['read-tree', head], { cwd: cfg.targetRepoPath, ...extra });
  if (seeded.status !== 0) return fail(`cannot seed the isolated freeze index: ${(seeded.stderr || '').trim() || `exit ${seeded.status}`}`);
  const rels = gated.map((g) => g.rel);
  const added = run(cfg, ['add', '--', ...rels], { cwd: cfg.targetRepoPath, ...extra });
  if (added.status !== 0) return fail(`cannot stage the approved suites in the isolated index: ${(added.stderr || '').trim() || `exit ${added.status}`}`);
  const staged = stagedFreezePaths(cfg, gated, run, extra);
  if (!staged.ok) return fail(staged.error);
  const written = run(cfg, ['write-tree'], { cwd: cfg.targetRepoPath, ...extra });
  const tree = String(written.stdout || '').trim();
  if (written.status !== 0 || !/^[0-9a-f]{40,64}$/i.test(tree)) {
    return fail(`cannot write the isolated freeze tree: ${(written.stderr || '').trim() || `exit ${written.status}`}`);
  }
  const valid = validateTreeSnapshot(cfg, gated, head, tree, run);
  if (!valid.ok) return fail(valid.error);
  return { ok: true, tempDir, index, env, tree, head, staged: staged.staged, paths: valid.paths };
}

function makeFreezeCommit(cfg, gated, snapshot, subject, body, run = git) {
  const made = run(cfg, ['commit-tree', snapshot.tree, '-p', snapshot.head], {
    cwd: cfg.targetRepoPath, input: `${subject}\n\n${body}\n`,
  });
  const commit = String(made.stdout || '').trim();
  if (made.status !== 0 || !/^[0-9a-f]{40,64}$/i.test(commit)) {
    return { ok: false, error: (made.stderr || '').trim() || `git commit-tree exited ${made.status}` };
  }
  const valid = validateTreeSnapshot(cfg, gated, snapshot.head, commit, run);
  return valid.ok ? { ok: true, commit } : { ok: false, error: valid.error };
}

// Publish the immutable object that was validated, never the ambient branch name or HEAD.
// The exact lease makes the remote comparison atomic with the ref update: if another publisher
// moved the integration branch after our snapshot, Git refuses instead of overwriting it. A
// local process moving this checkout's branch cannot change either side of this refspec.
function pushFreezeCommit(cfg, branch, sourceOid, expectedRemoteOid, run = git) {
  const oid = /^[0-9a-f]{40,64}$/i;
  if (!oid.test(String(sourceOid || '')) || !oid.test(String(expectedRemoteOid || ''))) {
    return { ok: false, error: 'freeze publication requires exact source and lease object IDs' };
  }
  const ref = `refs/heads/${branch}`;
  const pushed = run(cfg, [
    'push',
    `--force-with-lease=${ref}:${expectedRemoteOid}`,
    cfg.targetRepoRemote,
    `${sourceOid}:${ref}`,
  ], { cwd: cfg.targetRepoPath });
  return pushed.status === 0
    ? { ok: true }
    : { ok: false, error: (pushed.stderr || '').trim() || `git push exited ${pushed.status}` };
}

// HEAD must already BE the integration branch. Checking out is not an option worth having: a
// branch switch in a checkout another session may be using mutates a working tree this command
// does not own, and the failure mode is silent (CLAUDE.md's working-tree safety rules).
function headIs(cfg, branch) {
  const r = git(cfg, ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: cfg.targetRepoPath });
  if (r.status !== 0) {
    return { ok: false, error: `cannot read HEAD of ${cfg.targetRepoPath}: ${(r.stderr || '').trim()}` };
  }
  const head = (r.stdout || '').trim();
  if (head !== branch) {
    return {
      ok: false,
      error: `${cfg.targetRepoPath} is on "${head}" and the integration branch is "${branch}" — `
        + `switch it yourself (this command never moves a working tree it does not own)`,
    };
  }
  return { ok: true };
}

function currentHead(cfg) {
  const r = git(cfg, ['rev-parse', 'HEAD'], { cwd: cfg.targetRepoPath });
  const head = String(r.stdout || '').trim();
  return r.status === 0 && /^[0-9a-f]{40,64}$/i.test(head)
    ? { ok: true, head }
    : { ok: false, error: `cannot read HEAD of ${cfg.targetRepoPath}: ${(r.stderr || '').trim()}` };
}

function commit(opts, out, err) {
  const ids = opts.positional;
  if (!ids.length) {
    err('freeze: commit needs at least one issue id');
    return EXIT_USAGE;
  }
  const loaded = load(opts.config);
  if (!loaded.ok) {
    err(`freeze: ${loaded.error}`);
    return EXIT_USAGE;
  }
  const cfg = loaded.cfg;

  if (opts.probe && !fs.existsSync(opts.probe)) {
    err(`freeze: --probe names ${opts.probe}, which does not exist`);
    return EXIT_USAGE;
  }

  // `--allow-half-proven` here without `allowHalfProven` in the run config produces a freeze
  // this command calls done and the runner refuses at dispatch — the exact outcome it exists to
  // make impossible, arrived at through its own flag. The two settings are not duplicates: the
  // config decides which suites a RUN will admit and the flag decides what this command will
  // push, so a flag that could disagree with the config is a flag that manufactures the failure.
  // Refused up front rather than after the push, because after the push the branch already
  // carries a suite nothing will run.
  if (opts.allowHalfProven && cfg.allowHalfProven !== true) {
    err('freeze: --allow-half-proven, but the run config does not set "allowHalfProven": true — '
      + 'the freeze would land on the branch and the runner would refuse it at dispatch.');
    err('        Either build a probe and pass --probe (PLANNING.md step 4), or set '
      + `"allowHalfProven": true in ${opts.config} and accept that for every task in the run.`);
    return EXIT_REFUSED;
  }

  const resolved = resolveBranch(cfg);
  if (!resolved.ok) {
    err(`freeze: ${resolved.error}`);
    return EXIT_UNKNOWN;
  }
  const branch = resolved.branch;
  out(`integration branch: ${branch}  (${cfg.targetRepoRemote})`);

  // A managed proof may need to promote its exact suite from the author's dedicated worktree
  // into this checkout. Refuse a staged index or wrong branch before that first write, then
  // repeat the same checks before the commit to catch concurrent activity.
  const earlyClean = indexIsClean(cfg);
  if (!earlyClean.ok) { err(`freeze: ${earlyClean.error}`); return EXIT_REFUSED; }
  const earlyBranch = headIs(cfg, branch);
  if (!earlyBranch.ok) { err(`freeze: ${earlyBranch.error}`); return EXIT_REFUSED; }

  let managedProbe = null;
  let managedHead = null;
  if (opts.probe) {
    const head = currentHead(cfg);
    if (!head.ok) { err(`freeze: ${head.error}`); return EXIT_UNKNOWN; }
    managedHead = head.head;
    managedProbe = validateManagedProbe(path.resolve(opts.probe), cfg.targetRepoPath, ids, head.head);
    if (!managedProbe.ok) {
      err(`freeze: managed green probe is stale or unsafe — ${managedProbe.error}`);
      err('        rebuild the probe; nothing has been staged, committed or pushed.');
      return EXIT_REFUSED;
    }
  }

  // ---- every suite is gated BEFORE anything is staged ------------------------------------
  // One commit carries the whole batch, so a refusal on the fourth id must not leave the first
  // three committed: the gate runs over all of them first and a single refusal stops the lot.
  const gated = [];
  const gateRoot = managedProbe && managedProbe.managed ? managedProbe.baseline : cfg.targetRepoPath;
  for (const id of ids) {
    const suite = localSuite(cfg, id, gateRoot);
    if (!suite.ok) {
      err(`freeze: ${id} — ${suite.reason}`);
      err(`        ${suite.detail}`);
      return EXIT_REFUSED;
    }
    out('');
    out(`${id}: gating ${suite.rel}/ (${suite.files} file(s))`);
    const gate = runGate(cfg, suite.rel, opts.probe, out, gateRoot);
    if (!gate.ok) {
      err(`freeze: ${id} — the freeze gate could not be run: ${gate.report.trim()}`);
      return EXIT_UNKNOWN;
    }
    out(gate.report.trimEnd());
    if (!PROCEEDS.has(gate.verdict)) {
      err(`freeze: ${id} — the gate says ${gate.verdict}; a freeze proceeds only on red or half-proven`);
      err('        nothing has been staged, committed or pushed.');
      return EXIT_REFUSED;
    }
    if (gate.verdict === 'half-proven' && !opts.allowHalfProven) {
      err(`freeze: ${id} — the gate says half-proven: the suite can fail, but no probe has ever `
        + 'shown an implementation can turn it green.');
      err('        build a probe and pass --probe, or accept it with --allow-half-proven.');
      return EXIT_REFUSED;
    }
    if (managedProbe && managedProbe.managed) {
      const afterGate = validateManagedProbe(path.resolve(opts.probe), cfg.targetRepoPath, ids, managedHead);
      if (!afterGate.ok) {
        err(`freeze: the verifier changed a protected byte during the managed gate — ${afterGate.error}`);
        err('        nothing has been copied, staged, committed or pushed.');
        return EXIT_REFUSED;
      }
      managedProbe = afterGate;
    }
    gated.push({ id, rel: suite.rel, verdict: gate.verdict });
  }

  if (opts.dryRun) {
    out('');
    out(`dry run: ${gated.length} suite(s) gated and would be frozen — ${gated.map((g) => `${g.id} (${g.verdict})`).join(', ')}`);
    out('nothing was staged, committed or pushed.');
    return EXIT_OK;
  }

  // ---- the commit ------------------------------------------------------------------------
  const clean = indexIsClean(cfg);
  if (!clean.ok) {
    err(`freeze: ${clean.error}`);
    return EXIT_REFUSED;
  }
  const onBranch = headIs(cfg, branch);
  if (!onBranch.ok) {
    err(`freeze: ${onBranch.error}`);
    return EXIT_REFUSED;
  }

  let promotion = null;
  if (managedProbe && managedProbe.managed) {
    const headNow = currentHead(cfg);
    if (!headNow.ok || headNow.head !== managedHead) {
      err(`freeze: integration HEAD moved during the managed gate; rebuild the probe. Nothing was copied, staged, committed or pushed.`);
      return EXIT_REFUSED;
    }
    const checked = validateManagedProbe(path.resolve(opts.probe), cfg.targetRepoPath, ids, managedHead);
    if (!checked.ok) {
      err(`freeze: managed proof changed before promotion — ${checked.error}`);
      return EXIT_REFUSED;
    }
    promotion = promoteManagedSuite(checked, cfg.targetRepoPath);
    if (!promotion.ok) {
      err(`freeze: could not promote the proven suite into the integration checkout — ${promotion.error}`);
      err('        nothing has been staged, committed or pushed.');
      return EXIT_REFUSED;
    }
    const promotedCheck = validateManagedProbe(path.resolve(opts.probe), cfg.targetRepoPath, ids, managedHead);
    if (!promotedCheck.ok || promotedCheck.needsPromotion) {
      const rolled = rollbackManagedPromotion(promotion);
      err(`freeze: promoted suite did not reproduce the proven protected tree — ${promotedCheck.error || 'hash mismatch'}`);
      if (!rolled.ok) err(`freeze: rollback also failed — ${rolled.error}`);
      return EXIT_REFUSED;
    }
    managedProbe = promotedCheck;
    out(`promoted the exact proven suite for ${ids[0]} into the integration checkout`);
  }

  // A RE-FREEZE OF AN UNCHANGED SUITE MUST NOT MAKE A COMMIT. The gate stamps the moment it ran
  // into the receipt, so re-running it over a suite nobody touched produces a file that differs
  // in one timestamp and nothing else — and this command would then commit and push that
  // difference every time it was run. An operator re-runs a freeze constantly (after a refusal,
  // after a rebase, to check), so the integration branch would collect a commit per re-run, each
  // claiming to have frozen something. The suite hash is the thing that decides: equal hash means
  // the gate judged the identical suite, so the committed receipt is restored byte for byte and
  // there is nothing to stage. An unequal hash is a real re-freeze and proceeds.
  for (const g of gated) {
    const rel = `${g.rel}/.freeze-gate.json`;
    const abs = path.join(cfg.targetRepoPath, ...rel.split('/'));
    const shown = git(cfg, ['show', `HEAD:${rel}`], { cwd: cfg.targetRepoPath });
    if (shown.status !== 0) continue;                       // never frozen before: a real freeze
    let before;
    let after;
    try {
      before = JSON.parse(shown.stdout || '');
      after = JSON.parse(fs.readFileSync(abs, 'utf8'));
    } catch {
      continue;                                             // unreadable either side: let it commit
    }
    if (before && after && before.suiteHash && before.suiteHash === after.suiteHash
        && before.verdict === after.verdict) {
      fs.writeFileSync(abs, shown.stdout);
      g.unchanged = true;
    }
  }

  const snapshotHead = currentHead(cfg);
  if (!snapshotHead.ok) {
    if (promotion) rollbackManagedPromotion(promotion);
    err(`freeze: ${snapshotHead.error}`);
    return EXIT_UNKNOWN;
  }
  const snapshot = prepareFreezeSnapshot(cfg, gated, snapshotHead.head);
  if (!snapshot.ok) {
    if (promotion) {
      const rolled = rollbackManagedPromotion(promotion);
      if (!rolled.ok) err(`freeze: rollback also failed — ${rolled.error}`);
    }
    err(`freeze: cannot build an isolated freeze snapshot — ${snapshot.error}`);
    err('        no freeze commit or push was made; the shared index was not used.');
    return EXIT_UNKNOWN;
  }
  const stagedPaths = snapshot.staged;
  // Even the no-change path publishes the exact HEAD whose tree was validated above. Keep this
  // separate from the ambient branch: another local process may move that ref before the push.
  let publicationOid = snapshot.head;
  const expectedRemoteOid = snapshot.head;
  if (!stagedPaths.length) {
    removeSnapshot(snapshot);
    out('');
    out('every suite is already committed exactly as the gate blessed it — nothing to commit.');
  } else {
    out('');
    out(`staging ${stagedPaths.length} path(s):`);
    for (const p of stagedPaths) out(`  ${p}`);
    const subject = gated.length === 1
      ? `Freeze the acceptance suite for ${gated[0].id}`
      : `Freeze acceptance suites for ${gated.map((g) => g.id).join(', ')}`;
    const body = gated.map((g) => `${g.id}: ${g.verdict}`).join('\n');
    const made = makeFreezeCommit(cfg, gated, snapshot, subject, body);
    if (!made.ok) {
      removeSnapshot(snapshot);
      if (promotion) {
        const rolled = rollbackManagedPromotion(promotion);
        if (!rolled.ok) err(`freeze: rollback also failed — ${rolled.error}`);
      }
      err(`freeze: the isolated commit failed validation: ${made.error}`);
      return EXIT_UNKNOWN;
    }
    publicationOid = made.commit;
    // The candidate commit is already an immutable, validated object. Updating the branch with
    // an expected-old value is atomic: if another process moved HEAD, Git refuses rather than
    // dropping that work. No hook or working-tree read can change the candidate tree here.
    const moved = git(cfg, ['update-ref', `refs/heads/${branch}`, made.commit, snapshot.head],
      { cwd: cfg.targetRepoPath });
    if (moved.status !== 0) {
      removeSnapshot(snapshot);
      if (promotion) {
        const rolled = rollbackManagedPromotion(promotion);
        if (!rolled.ok) err(`freeze: rollback also failed — ${rolled.error}`);
      }
      err(`freeze: integration HEAD changed before the freeze commit could land: ${(moved.stderr || '').trim()}`);
      return EXIT_REFUSED;
    }
    // Bring only our suite entries in the shared index forward to the new HEAD. Any unrelated
    // staged path remains byte-for-byte as the other process left it.
    const synced = git(cfg, ['reset', '-q', made.commit, '--', ...gated.map((g) => g.rel)],
      { cwd: cfg.targetRepoPath });
    if (synced.status !== 0) {
      const restored = git(cfg, ['update-ref', `refs/heads/${branch}`, snapshot.head, made.commit],
        { cwd: cfg.targetRepoPath });
      git(cfg, ['reset', '-q', snapshot.head, '--', ...gated.map((g) => g.rel)], { cwd: cfg.targetRepoPath });
      removeSnapshot(snapshot);
      if (promotion) {
        const rolled = rollbackManagedPromotion(promotion);
        if (!rolled.ok) err(`freeze: rollback also failed — ${rolled.error}`);
      }
      err(`freeze: could not synchronize approved suite paths in the shared index: ${(synced.stderr || '').trim()}`);
      if (restored.status !== 0) err(`freeze: branch rollback also failed: ${(restored.stderr || '').trim()}`);
      return EXIT_UNKNOWN;
    }
    removeSnapshot(snapshot);
    out(`committed: ${subject}`);
  }

  if (promotion) {
    const finished = finalizeManagedPromotion(promotion);
    if (!finished.ok) err(`freeze: warning — committed suite backup could not be removed: ${finished.error}`);
  }

  // ---- the push, which is the half that is actually load-bearing -------------------------
  // "Committed locally and unpushed is the same as absent" (§4.12): a task branch forks from the
  // REMOTE's integration branch, so a freeze that never left this machine refuses exactly like a
  // freeze that was never written.
  const pushed = pushFreezeCommit(cfg, branch, publicationOid, expectedRemoteOid);
  if (!pushed.ok) {
    err(`freeze: the push to ${cfg.targetRepoRemote} failed: ${pushed.error}`);
    err('        the commit is on this machine and the runner cannot see it — push it before launching.');
    return EXIT_UNKNOWN;
  }
  out(`pushed to ${branch} on ${cfg.targetRepoRemote}`);

  // ---- the proof -------------------------------------------------------------------------
  // The runner's OWN judgement, run against the branch as it now stands. Everything above is
  // this command's belief about what it did; this is the only line that is evidence, and it is
  // why the command exists rather than a documented sequence of git invocations. A freeze that
  // reports success and is then refused at launch is the failure being automated away.
  const verify = partitionByFreeze(cfg, gated.map((g) => ({ id: g.id })));
  out('');
  if (!verify.ok) {
    err(`freeze: pushed, but the dispatch gate could not be read back: ${verify.error}`);
    return EXIT_UNKNOWN;
  }
  const stillRefused = verify.undispatchable || [];
  for (const g of gated) {
    const bad = stillRefused.find((u) => u.issue && u.issue.id === g.id);
    if (bad) err(`  ${g.id}  STILL REFUSED — ${bad.reason}`);
    else out(`  ${g.id}  the runner will dispatch it`);
  }
  if (stillRefused.length) {
    err('freeze: the freeze is on the branch and the runner would still refuse it — nothing above is a pass.');
    return EXIT_REFUSED;
  }
  out('');
  out(`frozen: ${gated.length} suite(s) the runner has just confirmed it will dispatch.`);
  if (managedProbe && managedProbe.managed) {
    try {
      removeOwnedContainer(managedProbe.container);
      out(`removed the consumed disposable green probe: ${managedProbe.container}`);
    } catch (e) {
      err(`freeze: warning — the freeze succeeded, but the disposable probe could not be removed: ${e.message}`);
    }
  }
  return EXIT_OK;
}

// ---- entry -----------------------------------------------------------------------------------

function main(argv, out = console.log, err = console.error) {
  const verb = argv[0];
  if (!verb || verb === '--help' || verb === '-h') {
    out(USAGE);
    return verb ? EXIT_OK : EXIT_USAGE;
  }
  if (verb !== 'status' && verb !== 'commit') {
    err(`freeze: unknown verb "${verb}"`);
    err(USAGE);
    return EXIT_USAGE;
  }
  const opts = parseArgs(argv.slice(1));
  if (opts.error) {
    err(`freeze: ${opts.error}`);
    err(USAGE);
    return EXIT_USAGE;
  }
  return verb === 'status' ? status(opts, out, err) : commit(opts, out, err);
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { main, parseArgs, GATE_VERDICT, PROCEEDS, currentHead,
  indexIsClean, stagedFreezePaths, rollbackFreezePreparation, normalizeGitPath,
  validateTreeSnapshot, prepareFreezeSnapshot, makeFreezeCommit, pushFreezeCommit, removeSnapshot,
  EXIT_OK, EXIT_REFUSED, EXIT_USAGE, EXIT_UNKNOWN };
