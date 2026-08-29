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
const path = require('path');
const { spawnSync } = require('child_process');

const { loadConfig } = require('../runner/config');
const {
  readyQueue, partitionByFreeze, resolveBranch, gitSpawnOptions, REFUSAL, RECEIPT_VERDICTS,
} = require('../runner/queue');

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
function localSuite(cfg, issueId) {
  const rel = `tests/acceptance/${issueId}`;
  const abs = path.join(cfg.targetRepoPath, rel);
  let entries;
  try {
    entries = fs.readdirSync(abs, { withFileTypes: true });
  } catch {
    return {
      ok: false,
      reason: `no acceptance suite at ${rel}/ in ${cfg.targetRepoPath}`,
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
function runGate(cfg, rel, probe, out) {
  const args = [GATE, '--repo', cfg.targetRepoPath, '--tests', `${rel}/`];
  if (probe) args.push('--green', probe);
  const r = spawnSync(process.execPath, args, { encoding: 'utf8' });
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
  const r = git(cfg, ['diff', '--cached', '--name-only'], { cwd: cfg.targetRepoPath });
  if (r.status !== 0) {
    return { ok: false, error: `cannot read the index of ${cfg.targetRepoPath}: ${(r.stderr || '').trim()}` };
  }
  const staged = (r.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
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

  // ---- every suite is gated BEFORE anything is staged ------------------------------------
  // One commit carries the whole batch, so a refusal on the fourth id must not leave the first
  // three committed: the gate runs over all of them first and a single refusal stops the lot.
  const gated = [];
  for (const id of ids) {
    const suite = localSuite(cfg, id);
    if (!suite.ok) {
      err(`freeze: ${id} — ${suite.reason}`);
      err(`        ${suite.detail}`);
      return EXIT_REFUSED;
    }
    out('');
    out(`${id}: gating ${suite.rel}/ (${suite.files} file(s))`);
    const gate = runGate(cfg, suite.rel, opts.probe, out);
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

  // NAMED PATHS, one `git add` per suite. Never `-A` and never `.`: this runs in a checkout an
  // operator uses, and staging the folder rather than the work is how four files from another
  // session once landed in an unrelated commit.
  for (const g of gated) {
    const r = git(cfg, ['add', '--', g.rel], { cwd: cfg.targetRepoPath });
    if (r.status !== 0) {
      err(`freeze: cannot stage ${g.rel}: ${(r.stderr || '').trim()}`);
      return EXIT_UNKNOWN;
    }
  }

  // The receipt is inside the suite directory, so `git add <suite>` already carried it — but
  // an unchanged suite stages nothing at all, and committing an empty index would make a commit
  // that says it froze something and did not.
  const staged = git(cfg, ['diff', '--cached', '--name-only'], { cwd: cfg.targetRepoPath });
  const stagedPaths = (staged.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (!stagedPaths.length) {
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
    const made = git(cfg, ['commit', '-m', subject, '-m', body], { cwd: cfg.targetRepoPath });
    if (made.status !== 0) {
      err(`freeze: the commit failed: ${(made.stderr || '').trim() || (made.stdout || '').trim()}`);
      return EXIT_UNKNOWN;
    }
    out(`committed: ${subject}`);
  }

  // ---- the push, which is the half that is actually load-bearing -------------------------
  // "Committed locally and unpushed is the same as absent" (§4.12): a task branch forks from the
  // REMOTE's integration branch, so a freeze that never left this machine refuses exactly like a
  // freeze that was never written.
  const pushed = git(cfg, ['push', cfg.targetRepoRemote, `HEAD:refs/heads/${branch}`], { cwd: cfg.targetRepoPath });
  if (pushed.status !== 0) {
    err(`freeze: the push to ${cfg.targetRepoRemote} failed: ${(pushed.stderr || '').trim()}`);
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

module.exports = { main, parseArgs, GATE_VERDICT, PROCEEDS, EXIT_OK, EXIT_REFUSED, EXIT_USAGE, EXIT_UNKNOWN };
