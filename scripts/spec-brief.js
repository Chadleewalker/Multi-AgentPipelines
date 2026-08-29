#!/usr/bin/env node
// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// The brief that sends an agent to write one issue's frozen tests — generated, not written by
// hand (PLANNING.md step 3; change-log row `spec-brief`).
//
// WHY THIS EXISTS. The brief is the same eight paragraphs every time, wrapped around six facts
// that change per issue and per project: the integration branch, the verify command, the frozen
// paths, the host environment a headless test needs, which folder the agent works in, and where
// the gate has to be pointed. Written by hand it was wrong on four of those six the first time
// it was tried — a Godot path that had moved, a `scripts/` folder that does not exist in the
// target repo, a `--repo` aimed at the shared checkout rather than the worktree, and a worktree
// the brief told the agent to create when one already existed. Three of the four would have
// produced a gate result that looked like an answer and was not. At one issue that is an
// annoying morning. At twenty it is the reason the tests do not get written.
//
// Every one of those six facts is already recorded somewhere the host can read: the run config,
// the target's `pipeline.config.json`, git's own worktree registry, and Beads. So none of them
// is retyped here.
//
// THREE STATES, THREE BRIEFS. The command works out which one the issue is in before it writes
// a word, because the instructions are genuinely different:
//
//   write    — no suite anywhere. Write the tests, prove them red, stop for approval.
//   freeze   — a suite in the working tree that the branch has never seen. Gate and freeze it;
//              there is nothing to write.
//   re-gate  — a suite on the branch whose receipt is missing or stale. One command.
//
// Telling them apart is the difference between "here are seventeen briefs" and "here are
// seventeen briefs, three of which are already ninety per cent done and say so".
//
// It prints and changes nothing. Safe to run at any time, including while a run is in flight.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { loadConfig } = require('../runner/config');
const { bdJson } = require('../runner/bd');
const { partitionByFreeze, resolveBranch, gitSpawnOptions, REFUSAL } = require('../runner/queue');

const EXIT_OK = 0;
const EXIT_USAGE = 2;
const EXIT_UNKNOWN = 3;

const USAGE = [
  'usage:',
  '  node scripts/spec-brief.js <issue-id> --config run.config.<project>.json [--out <file>]',
  '',
  'Prints the brief for writing (or freezing) one issue\'s frozen acceptance tests, with every',
  'project-specific fact filled in from the run config, the target\'s pipeline.config.json, git\'s',
  'worktree registry and Beads. Reads only; writes nothing but --out.',
].join('\n');

function parseArgs(argv) {
  const opts = { id: null, config: null, out: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--config' || arg === '--out') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) return { error: `${arg} needs a value` };
      if (arg === '--config') opts.config = value; else opts.out = value;
      i += 1;
      continue;
    }
    if (arg.startsWith('--')) return { error: `unknown option "${arg}"` };
    if (opts.id) return { error: `only one issue id at a time (got "${arg}" after "${opts.id}")` };
    opts.id = arg;
  }
  return opts;
}

const git = (cfg, args, extra) => spawnSync('git', args, gitSpawnOptions(cfg, extra));

// ---- the six facts -------------------------------------------------------------------------

// The target's own verifier contract. Never defaulted: a brief that guessed the verify command
// would send an agent to write tests no runner will ever invoke, and the guess would look
// plausible right up to the freeze gate.
function targetPolicy(cfg) {
  const file = path.join(cfg.targetRepoPath, 'pipeline.config.json');
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (typeof raw.verifyCommand !== 'string' || !raw.verifyCommand.trim()) {
      return { ok: false, error: `${file} names no verifyCommand` };
    }
    return {
      ok: true,
      verifyCommand: raw.verifyCommand.trim(),
      frozenPaths: Array.isArray(raw.frozenPaths) ? raw.frozenPaths.filter((p) => typeof p === 'string') : [],
    };
  } catch (e) {
    return { ok: false, error: `cannot read ${file}: ${(e && e.message) || String(e)}` };
  }
}

// GIT'S OWN REGISTRY, never a folder-naming convention. An agent told to create a worktree that
// already exists loses its first move to an error, and an agent told to work in the shared
// checkout is refused by the write guard — correctly, and confusingly, because the brief sent it
// there. `--porcelain` so a path containing a space is still one field.
function worktrees(cfg) {
  const r = git(cfg, ['worktree', 'list', '--porcelain'], { cwd: cfg.targetRepoPath });
  if (r.status !== 0) return [];
  const out = [];
  let current = null;
  for (const line of String(r.stdout || '').split(/\r?\n/)) {
    if (line.startsWith('worktree ')) current = { dir: line.slice(9).trim(), branch: null };
    else if (line.startsWith('branch ') && current) current.branch = line.slice(7).trim().replace(/^refs\/heads\//, '');
    else if (!line.trim() && current) { out.push(current); current = null; }
  }
  if (current) out.push(current);
  // The main checkout is the first entry and is never a session folder.
  return out.slice(1);
}

// A suite an agent can copy the SHAPE from — the most recently touched one, which is the closest
// to whatever conventions the project has drifted into. Naming a stale example teaches the old
// shape, so this is deliberately mtime and not alphabetical.
function exampleSuite(cfg, issueId) {
  const root = path.join(cfg.targetRepoPath, 'tests', 'acceptance');
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return null; }
  const best = entries
    .filter((e) => e.isDirectory() && e.name !== '_control' && e.name !== issueId)
    .map((e) => {
      const dir = path.join(root, e.name);
      let mtime = 0;
      let files = [];
      try {
        mtime = fs.statSync(dir).mtimeMs;
        files = fs.readdirSync(dir).filter((f) => f !== '.freeze-gate.json');
      } catch { /* unreadable: it simply loses */ }
      return { name: e.name, mtime, files };
    })
    .filter((s) => s.files.length)
    .sort((a, b) => b.mtime - a.mtime)[0];
  return best || null;
}

// The issue as Beads holds it. The ISSUE is canonical from freeze onward (PLANNING.md step 5),
// so the brief quotes it rather than the planning draft that produced it — two tasks in one batch
// have already been built against a draft the issue had moved past.
function issue(cfg, id) {
  const res = bdJson(cfg, ['show', id]);
  if (!res.ok) return { ok: false, error: res.error };
  const data = Array.isArray(res.data) ? res.data[0] : res.data;
  if (!data || typeof data !== 'object') return { ok: false, error: `bd returned no issue for ${id}` };
  return { ok: true, issue: data };
}

// ---- which of the three states ---------------------------------------------------------------

function classify(cfg, id, branch) {
  const rel = `tests/acceptance/${id}`;
  const abs = path.join(cfg.targetRepoPath, ...rel.split('/'));

  // What the BRANCH holds is what a container forks from, so it is asked first and it is asked
  // through the runner's own gate — the same judgement a launch makes, not a second copy of it.
  const gate = partitionByFreeze(cfg, [{ id }]);
  if (!gate.ok) return { ok: false, error: gate.error };
  if (gate.issues.length) return { ok: true, state: 'ready' };
  const refusal = (gate.undispatchable[0] || {}).refusal;

  if (refusal !== REFUSAL.NO_SUITE) {
    // A suite is on the branch; what is wrong is the receipt beside it. One command fixes it and
    // nothing needs writing — which is worth saying loudly, because it looks like the same
    // problem as a missing suite in every report that does not separate them.
    return { ok: true, state: 're-gate', refusal, reason: (gate.undispatchable[0] || {}).reason };
  }

  // Nothing on the branch. The working tree decides between "write them" and "freeze what is
  // already written" — a distinction no branch-side check can make, and the state a planning
  // session that stopped one step early leaves behind.
  let files = [];
  try { files = fs.readdirSync(abs).filter((f) => f !== '.freeze-gate.json'); } catch { files = null; }
  if (files === null) return { ok: true, state: 'write', local: null };
  if (!files.length) return { ok: true, state: 'write', local: 'empty' };
  return { ok: true, state: 'freeze', local: files };
}

// THE MAIN CHECKOUT of this repo, not the folder this script happens to be running from. The
// brief tells someone else where to `cd` to reach the gate, and this command is itself most
// often run from a session worktree — naming that worktree sends the reader into a folder that
// is somebody's work in progress, and may not exist by the time they read it. `--git-common-dir`
// is the shared `.git` whichever folder asks, so its parent is the main checkout.
function pipelineMain() {
  const here = path.resolve(__dirname, '..');
  const r = spawnSync('git', ['rev-parse', '--git-common-dir'], { cwd: here, encoding: 'utf8', timeout: 15000 });
  if (r.status !== 0) return here;                          // not a git checkout: this is all we know
  const common = path.resolve(here, String(r.stdout || '').trim());
  const parent = path.dirname(common);
  return path.basename(common) === '.git' && fs.existsSync(parent) ? parent : here;
}

// ---- the brief -------------------------------------------------------------------------------

const RULE = '─'.repeat(78);

function envLines(cfg) {
  const env = (cfg.hostEnv && typeof cfg.hostEnv === 'object' && !Array.isArray(cfg.hostEnv)) ? cfg.hostEnv : {};
  return Object.entries(env)
    .filter(([, v]) => typeof v === 'string' && v)
    .map(([k, v]) => `export ${k}="${v}"`);
}

function header(cfg, id, data, folder, branch) {
  const lines = [];
  lines.push(RULE);
  lines.push(`Frozen acceptance tests for ${id}`);
  if (data && data.title) lines.push(`  ${data.title}`);
  lines.push(RULE);
  lines.push('');
  lines.push(`Work in: ${folder.dir}${folder.exists ? '' : '   (create it first — see below)'}`);
  lines.push(`Branch:  ${folder.branch}, off ${branch}`);
  lines.push('');
  if (!folder.exists) {
    lines.push('Create the worktree, then OPEN A SESSION WITH THAT FOLDER AS ITS WORKING DIRECTORY.');
    lines.push('You cannot write into a worktree from the folder you made it in — the write guard');
    lines.push('refuses, and it is right to; it cannot tell a folder you cut seconds ago from one');
    lines.push('someone else is working in.');
    lines.push('');
    lines.push(`    git -C ${cfg.targetRepoPath} worktree add -b ${folder.branch} ${folder.dir} ${branch}`);
    lines.push('');
  }
  return lines;
}

function setupLines(cfg) {
  const env = envLines(cfg);
  if (!env.length) return [];
  return [
    'SETUP, BEFORE ANYTHING ELSE. These are not on PATH on this host:',
    '',
    ...env.map((l) => `    ${l}`),
    '',
    'Get this wrong and every test false-fails on a missing binary — and the freeze gate\'s',
    'control fixture needs none of them, so it will certify that as a discriminating red. A',
    'gate RED means nothing until you have read the per-test failure reasons.',
    '',
  ];
}

function gateLines(repoRoot, cfg, id, folder) {
  return [
    'PROVE THEY CAN FAIL. The gate lives in the pipelines repo, and --repo must point at YOUR',
    'worktree — pointed at the shared checkout it grades a directory that is not there and',
    'answers indeterminate, which is never a pass:',
    '',
    `    cd ${repoRoot}`,
    '    node scripts/freeze-gate.js \\',
    `      --repo ${folder.dir} \\`,
    `      --tests tests/acceptance/${id}/`,
    '',
    'Red (0) or half-proven (4) is what you want. Green (1) means a criterion is not',
    'discriminating — it would pass a correct implementation, a broken one and an empty diff',
    'alike. Indeterminate (2) means the harness is broken independently of your tests, usually',
    'the environment above. Unreachable (3) means a check cannot be satisfied by any',
    'implementation. Stale-guard (5) means something you labelled a guard is red at the fork',
    'point. Never treat 2, 3 or 5 as a pass.',
    '',
  ];
}

function criteriaLines(data) {
  const text = (data && data.acceptance_criteria) || '';
  if (!text.trim()) {
    return [
      'THE ISSUE CARRIES NO ACCEPTANCE CRITERIA. That is a spec bug and it is not yours to fix:',
      'there is nothing to write tests against. Report it and stop.',
      '',
    ];
  }
  return [
    'THE CRITERIA, from Beads, which is canonical from freeze onward — not the planning draft',
    'that produced it. Where the two disagree the issue wins, and two tasks in one batch have',
    'already been built against a draft the issue had moved past:',
    '',
    ...text.split(/\r?\n/).map((l) => `    ${l}`),
    '',
  ];
}

function writeBrief(ctx) {
  const { cfg, id, data, folder, branch, policy, example, repoRoot, state } = ctx;
  const lines = header(cfg, id, data, folder, branch);

  lines.push('YOUR JOB is to write the frozen acceptance tests for this issue. You are NOT');
  lines.push('implementing it. Do not write, edit or fix any product code.');
  lines.push('');
  if (state.local === 'empty') {
    lines.push(`NOTE: tests/acceptance/${id}/ exists and is empty — a placeholder from an earlier`);
    lines.push('session. An empty suite directory is worse than none: the verifier exits 1 on "no');
    lines.push('test files" for all three attempts. Fill it.');
    lines.push('');
  }
  lines.push(...setupLines(cfg));
  lines.push(...criteriaLines(data));

  lines.push(`WRITE THEM TO tests/acceptance/${id}/ in your worktree. They must run under the`);
  lines.push('project\'s own verifier, which the host invokes as:');
  lines.push('');
  lines.push(`    ${policy.verifyCommand} tests/acceptance/${id}/`);
  lines.push('');
  if (example) {
    lines.push(`Copy the file shape from tests/acceptance/${example.name}/ — the most recently`);
    lines.push(`written suite in this project (${example.files.length} files: ${example.files.slice(0, 4).join(', ')}${example.files.length > 4 ? ', …' : ''}).`);
    lines.push('');
  }
  lines.push('PAIR THEM UP, BOTH DIRECTIONS. Every criterion names the test that proves it, and');
  lines.push('every test names the criterion it serves. An orphan on either side is a spec bug —');
  lines.push('report it, do not paper over it.');
  lines.push('');
  lines.push('THE TESTS MUST FAIL NOW. The implementation does not exist, so a test that passes');
  lines.push('today proves nothing. The one exception is a guard — a check that existing behaviour');
  lines.push('still holds — which is legal, must carry the literal [guard] token in a comment in');
  lines.push('its first ten lines, and must be GREEN at the fork point. Never label something a');
  lines.push('guard that is red today; that refuses the freeze outright.');
  lines.push('');
  lines.push(...gateLines(repoRoot, cfg, id, folder));

  const frozen = policy.frozenPaths.length
    ? policy.frozenPaths.join(', ')
    : '(none configured)';
  lines.push(`DO NOT TOUCH: ${frozen} — frozen by this project's config, so a criterion naming`);
  lines.push('one ends every attempt as tampered before any test result exists. Nor any other');
  lines.push('suite under tests/acceptance/, nor the issue text itself.');
  lines.push('');
  lines.push('STOP AND REPORT: the files you wrote, which criterion each proves, the gate\'s');
  lines.push('verdict with the per-test reasons behind it, and any spec defect you found. Do not');
  lines.push(`commit to ${branch} and do not freeze. Approval comes before the freeze.`);
  lines.push('');
  lines.push(RULE);
  return lines;
}

function freezeBrief(ctx) {
  const { cfg, id, data, folder, branch, repoRoot, state, configPath } = ctx;
  const lines = header(cfg, id, data, folder, branch);
  lines.push(`THE TESTS ARE ALREADY WRITTEN — ${state.local.length} file(s) in the working tree that`);
  lines.push(`${branch} has never seen. Nothing needs drafting. What is missing is the freeze.`);
  lines.push('');
  lines.push(...setupLines(cfg));
  lines.push(...gateLines(repoRoot, cfg, id, folder));
  lines.push('If it comes back red or half-proven, freeze it — this gates it again, commits the');
  lines.push('suite and its receipt, pushes, and then asks the runner whether the branch it just');
  lines.push('wrote will actually be accepted:');
  lines.push('');
  lines.push(`    node scripts/freeze.js commit ${id} --config ${configPath}`);
  lines.push('');
  lines.push('If it comes back green, unreachable or stale-guard, do not freeze. Report which and');
  lines.push('why — that is a spec bug found before it cost a container, which is the point.');
  lines.push('');
  lines.push(RULE);
  return lines;
}

function reGateBrief(ctx) {
  const { cfg, id, data, folder, branch, repoRoot, state, configPath } = ctx;
  const lines = header(cfg, id, data, folder, branch);
  lines.push(`THE SUITE IS ALREADY ON ${branch}. Nothing needs writing. The runner refuses it for`);
  lines.push('one reason:');
  lines.push('');
  lines.push(`    ${state.reason}`);
  lines.push('');
  if (state.refusal === REFUSAL.MISMATCH) {
    lines.push('The suite was edited after the gate blessed it, so the receipt beside it describes a');
    lines.push('suite nobody gated. Re-running the gate is the whole fix.');
  } else {
    lines.push('The gate was never run over it, or its receipt was never pushed. Either way the');
    lines.push('runner cannot tell a gated suite from an ungated one, and refuses rather than guess.');
  }
  lines.push('');
  lines.push(...setupLines(cfg));
  lines.push(...gateLines(repoRoot, cfg, id, folder));
  lines.push('On red or half-proven, freeze it — one command, which re-gates, commits the receipt,');
  lines.push('pushes, and confirms with the runner\'s own gate that it will now dispatch:');
  lines.push('');
  lines.push(`    node scripts/freeze.js commit ${id} --config ${configPath}`);
  lines.push('');
  lines.push('On green, unreachable or stale-guard: STOP. A suite that has been sitting on the');
  lines.push('branch does not mean it was ever discriminating — nothing has judged it until now.');
  lines.push('Report the verdict and the per-test reasons.');
  lines.push('');
  lines.push(RULE);
  return lines;
}

// ---- entry -------------------------------------------------------------------------------------

function buildBrief(opts) {
  let cfg;
  const configPath = path.resolve(opts.config);
  try { cfg = loadConfig(configPath); } catch (e) { return { ok: false, kind: 'config', error: (e && e.message) || String(e) }; }

  const policy = targetPolicy(cfg);
  if (!policy.ok) return { ok: false, kind: 'unknown', error: policy.error };

  const resolved = resolveBranch(cfg);
  if (!resolved.ok) return { ok: false, kind: 'unknown', error: resolved.error };
  const branch = resolved.branch;

  const found = issue(cfg, opts.id);
  if (!found.ok) return { ok: false, kind: 'issue', error: found.error };

  const state = classify(cfg, opts.id, branch);
  if (!state.ok) return { ok: false, kind: 'unknown', error: state.error };

  if (state.state === 'ready') {
    return { ok: true, state: state.state, cfg, branch, text: null, folder: null };
  }

  // An existing worktree is REUSED, never re-created. Matched on the branch a session folder
  // would carry for this issue, then on the folder holding its suite — an agent told to make a
  // worktree that exists loses its first move to an error message.
  const slug = String(opts.id).split('-').pop();
  const wanted = `freeze-${slug}`;
  const existing = worktrees(cfg).find((w) => w.branch === wanted)
    || worktrees(cfg).find((w) => fs.existsSync(path.join(w.dir, 'tests', 'acceptance', opts.id)));
  const folder = existing
    ? { dir: existing.dir, branch: existing.branch, exists: true }
    : { dir: `${cfg.targetRepoPath}-${wanted}`, branch: wanted, exists: false };

  const ctx = {
    cfg,
    configPath: opts.config,
    id: opts.id,
    data: found.issue,
    folder,
    branch,
    policy,
    example: exampleSuite(cfg, opts.id),
    repoRoot: pipelineMain(),
    state,
  };

  const lines = state.state === 'write' ? writeBrief(ctx)
    : state.state === 'freeze' ? freezeBrief(ctx)
      : reGateBrief(ctx);

  return { ok: true, state: state.state, cfg, branch, folder, text: lines.join('\n') };
}

function main(argv, out = console.log, err = console.error) {
  if (!argv.length || argv[0] === '--help' || argv[0] === '-h') {
    out(USAGE);
    return argv.length ? EXIT_OK : EXIT_USAGE;
  }
  const opts = parseArgs(argv);
  if (opts.error) { err(`spec-brief: ${opts.error}`); err(USAGE); return EXIT_USAGE; }
  if (!opts.id) { err('spec-brief: needs an issue id'); err(USAGE); return EXIT_USAGE; }
  if (!opts.config) { err('spec-brief: --config names the run.config.<project>.json a launch would type'); return EXIT_USAGE; }

  const built = buildBrief(opts);
  if (!built.ok) {
    const prefix = built.kind === 'config' ? `cannot read ${opts.config}`
      : built.kind === 'issue' ? `cannot read ${opts.id} from Beads` : '';
    err(`spec-brief: ${prefix ? `${prefix}: ` : ''}${built.error}`);
    return built.kind === 'config' ? EXIT_USAGE : EXIT_UNKNOWN;
  }
  if (built.state === 'ready') {
    out(`${opts.id} is already frozen and the runner will dispatch it. Nothing to brief.`);
    return EXIT_OK;
  }

  if (opts.out) {
    fs.writeFileSync(path.resolve(opts.out), `${built.text}\n`);
    out(`brief written: ${path.resolve(opts.out)}  (${built.state})`);
  } else {
    out(built.text);
  }
  return EXIT_OK;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { main, buildBrief, parseArgs, classify, exampleSuite, worktrees, envLines };
