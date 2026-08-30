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
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const { loadConfig } = require('../runner/config');
const { bdJson } = require('../runner/bd');
const { partitionByFreeze, resolveBranch, gitSpawnOptions, REFUSAL } = require('../runner/queue');
const { failureText } = require('../runner/process');

const EXIT_OK = 0;
const EXIT_USAGE = 2;
const EXIT_UNKNOWN = 3;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function validIssueId(id) {
  if (typeof id !== 'string' || !SAFE_ID.test(id) || id === '.' || id.includes('..') || id.endsWith('.')) return false;
  const stem = id.split('.')[0].toUpperCase();
  return !/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem);
}

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

// verifyCommand is interpolated into Claude's `Bash(<exact command>)` permission pattern and
// is also invoked by the target's shell.  Treat it as a small argv-shaped command, not as an
// arbitrary shell program: punctuation that can close the permission pattern, add another
// tool, or compose a second shell command is never a legitimate verifier path or argument.
// Commas are called out separately because Claude's tool list uses them as separators.
const SAFE_VERIFY_COMMAND = /^[A-Za-z0-9_./:@%+=-]+(?:[ \t]+[A-Za-z0-9_./:@%+=-]+)*$/;
function verifyCommandError(value) {
  if (typeof value !== 'string' || !value.trim()) return 'names no verifyCommand';
  if (/[\x00-\x1f\x7f]/.test(value)) return 'verifyCommand contains a control character';
  if (value.includes(',')) return 'verifyCommand contains a comma that can escape the tool permission';
  if (!SAFE_VERIFY_COMMAND.test(value)) {
    return 'verifyCommand contains shell or permission-pattern metacharacters';
  }
  return null;
}

// The old suffix-only name (`freeze-${id.split('-').pop()}`) mapped two different issue ids
// onto one branch.  The issue id has already passed prove-tests' safe-id grammar before an
// author can launch, so retaining the whole id is both Git-safe and injective.
function issueNames(id) {
  const stem = `freeze-${String(id)}`;
  return { branch: stem, dirSuffix: stem };
}

function canonicalIssueId(data, requestedId) {
  const canonical = data && data.id;
  if (!validIssueId(canonical)) {
    return { ok: false, error: `bd returned an unsafe canonical issue id for ${requestedId}` };
  }
  if (canonical !== requestedId && !canonical.endsWith(`-${requestedId}`)) {
    return { ok: false, error: `bd resolved ${requestedId} to unrelated issue ${canonical}` };
  }
  return { ok: true, id: canonical };
}

function suiteCandidates(canonicalId, requestedId) {
  return [...new Set([canonicalId, requestedId])];
}

// ---- the six facts -------------------------------------------------------------------------

// The target's own verifier contract. Never defaulted: a brief that guessed the verify command
// would send an agent to write tests no runner will ever invoke, and the guess would look
// plausible right up to the freeze gate.
function targetPolicy(cfg) {
  const file = path.join(cfg.targetRepoPath, 'pipeline.config.json');
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const unsafe = verifyCommandError(raw.verifyCommand);
    if (unsafe) return { ok: false, error: `${file} ${unsafe}` };
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
  if (r.status !== 0) throw new Error(failureText(r, 'git worktree list failed'));
  const out = [];
  let current = null;
  for (const line of String(r.stdout || '').split(/\r?\n/)) {
    if (line.startsWith('worktree ')) current = { dir: line.slice(9).trim(), branch: null, locked: false, prunable: false };
    else if (line.startsWith('branch ') && current) current.branch = line.slice(7).trim().replace(/^refs\/heads\//, '');
    else if (line.startsWith('locked') && current) current.locked = true;
    else if (line.startsWith('prunable') && current) current.prunable = true;
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

function classifyBranch(cfg, id) {
  // What the BRANCH holds is what a container forks from, so it is asked first and it is asked
  // through the runner's own gate — the same judgement a launch makes, not a second copy of it.
  const gate = partitionByFreeze(cfg, [{ id }]);
  if (!gate.ok) return { ok: false, error: gate.error };
  if (gate.issues.length) return { ok: true, state: 'ready' };
  const row = gate.undispatchable[0] || {};
  const refusal = row.refusal;

  if (refusal !== REFUSAL.NO_SUITE) {
    // A suite is on the branch; what is wrong is the receipt beside it. One command fixes it and
    // nothing needs writing — which is worth saying loudly, because it looks like the same
    // problem as a missing suite in every report that does not separate them.
    return {
      ok: true, state: 're-gate', refusal, reason: row.reason,
      suiteTree: row.suiteTree,
    };
  }
  return { ok: true, state: 'local' };
}

function classifyLocal(cfg, canonicalId, requestedId, folder) {
  const candidates = suiteCandidates(canonicalId, requestedId);
  // Nothing on the branch. The working tree decides between "write them" and "freeze what is
  // already written" — a distinction no branch-side check can make, and the state a planning
  // session that stopped one step early leaves behind.
  if (!folder || !folder.exists) {
    // Only branch absence makes this interesting. A suite which is already frozen normally
    // exists in the shared checkout and returned above; here it is unowned local planning work.
    const shared = candidates.filter((id) => suiteFiles(cfg.targetRepoPath, id) !== null);
    if (shared.length) {
      return { ok: false, kind: 'collision', error: `the shared checkout contains ${shared.map((id) => `tests/acceptance/${id}/`).join(' and ')} but no issue worktree owns it` };
    }
    return { ok: true, state: 'write', local: null, suiteId: canonicalId };
  }
  const present = candidates.map((id) => ({ id, files: suiteFiles(folder.dir, id) }))
    .filter((value) => value.files !== null);
  if (present.length > 1) {
    return { ok: false, kind: 'collision', error: `the issue worktree contains both canonical and alias suite directories: ${present.map((value) => `tests/acceptance/${value.id}/`).join(', ')}` };
  }
  if (!present.length) return { ok: true, state: 'write', local: null, suiteId: canonicalId };
  const selected = present[0];
  if (!selected.files.length) return { ok: true, state: 'write', local: 'empty', suiteId: selected.id };
  return { ok: true, state: 'freeze', local: selected.files, suiteId: selected.id };
}

function classify(cfg, id, branch, folder = null) { // branch retained for the public seam
  const remote = classifyBranch(cfg, id);
  if (!remote.ok || remote.state !== 'local') return remote;
  return classifyLocal(cfg, id, id, folder);
}

function classifyBranchCandidates(cfg, canonicalId, requestedId) {
  const rows = suiteCandidates(canonicalId, requestedId)
    .map((suiteId) => ({ suiteId, result: classifyBranch(cfg, suiteId) }));
  const failed = rows.find((row) => !row.result.ok);
  if (failed) return failed.result;
  const existing = rows.filter((row) => row.result.state !== 'local');
  if (existing.length > 1) {
    return { ok: false, kind: 'collision', error: `both canonical and alias suites exist on the integration branch: ${existing.map((row) => `tests/acceptance/${row.suiteId}/`).join(', ')}` };
  }
  if (existing.length === 1 && existing[0].suiteId !== canonicalId) {
    return { ok: false, kind: 'collision',
      error: `legacy alias suite tests/acceptance/${existing[0].suiteId}/ exists on the integration branch; the runner requires canonical tests/acceptance/${canonicalId}/, so re-cut it under the canonical id` };
  }
  if (existing.length === 1) return { ...existing[0].result, suiteId: existing[0].suiteId };
  return { ok: true, state: 'local', suiteId: canonicalId };
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
    'This is only the RED-side author check. The launcher follows a successful author session',
    'with a separate, disposable green-probe agent and will not offer a freeze command until',
    'the same suite has passed there without changing any protected test or verifier byte.',
    '',
  ];
}

function suiteFiles(root, id) {
  const dir = path.join(root, 'tests', 'acceptance', id);
  try { return fs.readdirSync(dir).filter((f) => f !== '.freeze-gate.json'); } catch { return null; }
}

function suiteTree(cfg, cwd, ref, id) {
  const suite = `tests/acceptance/${id}`;
  const r = git(cfg, ['rev-parse', '--verify', `${ref}:${suite}`], { cwd });
  const oid = String(r.stdout || '').trim();
  return r.status === 0 && /^[0-9a-f]{40,64}$/i.test(oid) ? oid : null;
}

// A committed suite appears in every worktree whose branch inherited that commit. Directory
// presence alone therefore cannot mean that the other worktree owns unpublished test work. The
// exemption is deliberately narrow: the complete committed suite tree must equal the resolved
// integration branch, and Git must see no tracked, untracked OR ignored working-tree bytes under
// it. Any uncertainty remains a collision so divergent/manual evidence is never adopted or lost.
function inheritedSuite(cfg, id, folder, integrationTree) {
  if (!integrationTree || suiteTree(cfg, folder.dir, 'HEAD', id) !== integrationTree) return false;
  const suite = `tests/acceptance/${id}`;
  const clean = git(cfg, [
    'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching', '--', suite,
  ], { cwd: folder.dir });
  return clean.status === 0 && !String(clean.stdout || '').length;
}

// Resolve one and only one place for an issue.  A worktree containing the suite under any
// other branch is evidence from an older/manual session, not permission to take that session
// over.  Likewise, a directory at the path we intend to create which Git does not register is
// a collision, never an existing worktree to trust by filename.
function resolveIssueFolder(cfg, canonicalId, requestedId = canonicalId, registered = null, inherited = null) {
  // Preserve the public test/tool seam from the preceding release:
  // resolveIssueFolder(cfg, id, registered, inheritedTree).
  if (Array.isArray(requestedId)) {
    inherited = typeof registered === 'string' ? { suiteId: canonicalId, tree: registered } : null;
    registered = requestedId; requestedId = canonicalId;
  }
  if (!Array.isArray(registered)) registered = worktrees(cfg);
  const names = issueNames(canonicalId);
  const legacyNames = issueNames(requestedId);
  const exact = registered.filter((w) => w.branch === names.branch);
  const legacyExact = names.branch === legacyNames.branch ? []
    : registered.filter((w) => w.branch === legacyNames.branch);
  const candidates = suiteCandidates(canonicalId, requestedId);
  const carrying = registered.filter((w) => candidates.some((id) => suiteFiles(w.dir, id) !== null));
  // Only a tree identity carried out of the runner's exact FETCH_HEAD probe may relax a
  // collision. A branch name would be re-resolved in the host checkout and can drift ahead
  // of or behind the remote commit that partitionByFreeze actually judged.
  const integrationTree = inherited && typeof inherited.tree === 'string'
    && /^[0-9a-f]{40,64}$/i.test(inherited.tree) ? inherited.tree.toLowerCase() : null;
  const integrationSuiteId = inherited && inherited.suiteId;
  const adoptedLegacy = exact.length === 0 && legacyExact.length === 1 ? legacyExact[0] : null;
  const ownedBranches = new Set([names.branch, ...(adoptedLegacy ? [legacyNames.branch] : [])]);
  const legacy = carrying.filter((w) => !ownedBranches.has(w.branch))
    .filter((w) => !(integrationSuiteId
      && inheritedSuite(cfg, integrationSuiteId, w, integrationTree)));
  if (exact.length > 1) {
    return { ok: false, kind: 'collision', error: `multiple worktrees claim exact branch ${names.branch}: ${exact.map((w) => w.dir).join(', ')}` };
  }
  if (legacyExact.length > 1 || (exact.length && legacyExact.length)) {
    return { ok: false, kind: 'collision', error: `canonical and legacy issue branches are both registered for ${canonicalId}: ${[...exact, ...legacyExact].map((w) => `${w.dir} (${w.branch})`).join(', ')}` };
  }
  if (exact.some((w) => w.locked || w.prunable)) {
    const unsafe = exact.filter((w) => w.locked || w.prunable);
    return { ok: false, kind: 'collision', error: `exact branch ${names.branch} has locked or prunable worktree registry state: ${unsafe.map((w) => w.dir).join(', ')}` };
  }
  if (legacy.length) {
    return { ok: false, kind: 'collision', error: `legacy or ambiguous worktree already contains one of ${candidates.map((id) => `tests/acceptance/${id}/`).join(', ')} outside ${names.branch}: ${legacy.map((w) => `${w.dir} (${w.branch || 'detached'})`).join(', ')}` };
  }
  if (exact.length === 1) {
    return { ok: true, folder: { dir: exact[0].dir, branch: names.branch, exists: true } };
  }
  if (adoptedLegacy) {
    if (adoptedLegacy.locked || adoptedLegacy.prunable) {
      return { ok: false, kind: 'collision', error: `legacy issue branch ${legacyNames.branch} has locked or prunable worktree registry state: ${adoptedLegacy.dir}` };
    }
    return { ok: true, folder: { dir: adoptedLegacy.dir, branch: legacyNames.branch, exists: true,
      legacyBranchAlias: true } };
  }
  const dir = `${cfg.targetRepoPath}-${names.dirSuffix}`;
  if (fs.existsSync(dir)) {
    return { ok: false, kind: 'collision', error: `${dir} exists but Git does not register it as ${names.branch}` };
  }
  return { ok: true, folder: { dir, branch: names.branch, exists: false } };
}

function commentState(line, initial) {
  let active = initial;
  let ambiguous = false;
  let at = 0;
  while (at < line.length) {
    const opening = line.indexOf('<!--', at);
    const closing = line.indexOf('-->', at);
    if (active) {
      if (opening !== -1 && (closing === -1 || opening < closing)) {
        ambiguous = true;
        at = opening + 4;
      } else if (closing !== -1) {
        active = false;
        at = closing + 3;
      } else break;
    } else if (closing !== -1 && (opening === -1 || closing < opening)) {
      ambiguous = true;
      at = closing + 3;
    } else if (opening !== -1) {
      active = true;
      at = opening + 4;
    } else break;
  }
  return { active, ambiguous };
}

function rawHtmlLine(line) {
  return /^ {0,3}<(?:\/?[A-Za-z][A-Za-z0-9-]*(?:[ \t/>]|$)|!DOCTYPE(?:[ \t>]|$)|!\[CDATA\[|\?)/i.test(line)
    || /^ {0,3}<![A-Z]/.test(line);
}

function markdownLineState(lines) {
  let fence = null;
  let comment = false;
  let declaration = false;
  let invalidComment = false;
  let rawHtml = false;
  const visible = lines.map((line) => {
    if (fence) {
      const closing = line.match(/^ {0,3}(`+|~+)[ \t]*$/);
      if (closing && closing[1][0] === fence.char && closing[1].length >= fence.length) {
        fence = null;
      }
      return false;
    }
    if (declaration) {
      if (line.includes('>')) declaration = false;
      return false;
    }

    const startedInComment = comment;
    if (!startedInComment) {
      const opening = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
      if (opening && (opening[1][0] !== '`' || !opening[2].includes('`'))) {
        fence = { char: opening[1][0], length: opening[1].length };
        return false;
      }
    }

    if (!startedInComment && /^ {0,3}<![A-Z]/.test(line)) {
      rawHtml = true;
      declaration = !line.slice(line.indexOf('<!') + 2).includes('>');
      return false;
    }

    const firstComment = line.indexOf('<!--');
    const beginsWithComment = firstComment !== -1 && !line.slice(0, firstComment).trim();
    const next = commentState(line, comment);
    comment = next.active;
    invalidComment = invalidComment || next.ambiguous;
    if (startedInComment || beginsWithComment) {
      return false;
    }
    rawHtml = rawHtml || rawHtmlLine(line);
    return true;
  });
  return { visible, invalidComment: invalidComment || comment, rawHtml: rawHtml || declaration };
}

function setextTitle(line) {
  if (!line.trim() || /^ {4}/.test(line)) return false;
  if (/^ {0,3}(?:#{1,6}(?:[ \t]+|$)|>|`{3,}|~{3,})/.test(line)) return false;
  if (/^ {0,3}(?:(?:[*+-]|\d{1,9}[.)])[ \t]+)/.test(line)) return false;
  if (/^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/.test(line)) return false;
  return !rawHtmlLine(line);
}

function setextHeadings(lines, visible) {
  const levels = new Map();
  for (let i = 0; i + 1 < lines.length; i += 1) {
    if (!visible[i] || !visible[i + 1] || !setextTitle(lines[i])) continue;
    const underline = lines[i + 1].match(/^ {0,3}(=+|-+)[ \t]*$/);
    if (underline) levels.set(i, underline[1][0] === '=' ? 1 : 2);
  }
  return levels;
}

function descriptionCriteria(data) {
  const description = data && typeof data.description === 'string' ? data.description : '';
  const lines = description.split(/\r?\n/);
  const state = markdownLineState(lines);
  if (state.invalidComment || state.rawHtml) return '';
  const setext = setextHeadings(lines, state.visible);
  for (let i = 0; i < lines.length; i += 1) {
    if (!state.visible[i]) continue;
    const heading = lines[i].match(/^ {0,3}(#{1,6})[ \t]+Acceptance criteria:?(?:[ \t]+#+)?[ \t]*$/i);
    if (!heading) continue;

    const level = heading[1].length;
    const section = [];
    for (let j = i + 1; j < lines.length; j += 1) {
      const nextHeading = state.visible[j] && lines[j].match(/^ {0,3}(#{1,6})(?:[ \t]+|$)/);
      if ((nextHeading && nextHeading[1].length <= level)
          || (setext.has(j) && setext.get(j) <= level)) break;
      section.push(lines[j]);
    }
    while (section.length && !section[0].trim()) section.shift();
    while (section.length && !section[section.length - 1].trim()) section.pop();
    if (section.length && /^1\.[ \t]+\S/.test(section[0])
        && section.some((line) => /^\d+\.[ \t]+\S/.test(line))) {
      return section.join('\n');
    }
  }
  return '';
}

function acceptanceCriteria(data) {
  const hasStructured = data && Object.prototype.hasOwnProperty.call(data, 'acceptance_criteria');
  if (hasStructured && typeof data.acceptance_criteria !== 'string') return '';
  const structured = hasStructured ? data.acceptance_criteria.trim() : '';
  return structured || descriptionCriteria(data);
}

function criteriaInfo(data) {
  const hasStructured = data && Object.prototype.hasOwnProperty.call(data, 'acceptance_criteria');
  if (hasStructured && typeof data.acceptance_criteria !== 'string') {
    const text = '';
    return { text, source: 'none', sha256: crypto.createHash('sha256').update(text).digest('hex') };
  }
  const structured = hasStructured && typeof data.acceptance_criteria === 'string'
    ? data.acceptance_criteria.trim() : '';
  const fallback = structured ? '' : descriptionCriteria(data);
  const text = structured || fallback;
  const source = structured ? 'structured' : fallback ? 'description' : 'none';
  return { text, source, sha256: crypto.createHash('sha256').update(text).digest('hex') };
}

function criteriaLines(data) {
  const text = acceptanceCriteria(data);
  if (!text) {
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
  const { cfg, id, suiteId, data, folder, branch, policy, example, repoRoot, state } = ctx;
  const lines = header(cfg, id, data, folder, branch);

  lines.push('YOUR JOB is to write the frozen acceptance tests for this issue. You are NOT');
  lines.push('implementing it. Do not write, edit or fix any product code.');
  lines.push('');
  if (state.local === 'empty') {
    lines.push(`NOTE: tests/acceptance/${suiteId}/ exists and is empty — a placeholder from an earlier`);
    lines.push('session. An empty suite directory is worse than none: the verifier exits 1 on "no');
    lines.push('test files" for all three attempts. Fill it.');
    lines.push('');
  }
  lines.push(...setupLines(cfg));
  lines.push(...criteriaLines(data));

  lines.push(`WRITE THEM TO tests/acceptance/${suiteId}/ in your worktree. They must run under the`);
  lines.push('project\'s own verifier, which the host invokes as:');
  lines.push('');
  lines.push(`    ${policy.verifyCommand} tests/acceptance/${suiteId}/`);
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
  lines.push(...gateLines(repoRoot, cfg, suiteId, folder));

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
  const { cfg, id, suiteId, data, folder, branch, repoRoot, state, configPath } = ctx;
  const lines = header(cfg, id, data, folder, branch);
  lines.push(`THE TESTS ARE ALREADY WRITTEN — ${state.local.length} file(s) in the working tree that`);
  lines.push(`${branch} has never seen. Nothing needs drafting. What is missing is the freeze.`);
  lines.push('');
  lines.push(...setupLines(cfg));
  lines.push(...gateLines(repoRoot, cfg, suiteId, folder));
  lines.push('If it comes back red or half-proven, freeze it — this gates it again, commits the');
  lines.push('suite and its receipt, pushes, and then asks the runner whether the branch it just');
  lines.push('wrote will actually be accepted:');
  lines.push('');
  lines.push(`    node scripts/freeze.js commit ${suiteId} --config ${configPath}`);
  lines.push('');
  lines.push('If it comes back green, unreachable or stale-guard, do not freeze. Report which and');
  lines.push('why — that is a spec bug found before it cost a container, which is the point.');
  lines.push('');
  lines.push(RULE);
  return lines;
}

function reGateBrief(ctx) {
  const { cfg, id, suiteId, data, folder, branch, repoRoot, state, configPath } = ctx;
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
  lines.push(...gateLines(repoRoot, cfg, suiteId, folder));
  lines.push('On red or half-proven, freeze it — one command, which re-gates, commits the receipt,');
  lines.push('pushes, and confirms with the runner\'s own gate that it will now dispatch:');
  lines.push('');
  lines.push(`    node scripts/freeze.js commit ${suiteId} --config ${configPath}`);
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
  if (!validIssueId(opts && opts.id)) return { ok: false, kind: 'issue', error: `unsafe issue id: ${opts && opts.id}` };
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
  const canonical = canonicalIssueId(found.issue, opts.id);
  if (!canonical.ok) return { ok: false, kind: 'issue', error: canonical.error };
  const canonicalId = canonical.id;
  const criteria = criteriaInfo(found.issue);

  // A dispatchable issue needs no issue tree, so old forensic worktrees cannot turn an
  // already-frozen no-op into a preparation collision. Every state that can launch or prove
  // still goes through the strict exact-branch resolver below.
  const remoteState = classifyBranchCandidates(cfg, canonicalId, opts.id);
  if (!remoteState.ok) return { ok: false, kind: 'unknown', error: remoteState.error };
  if (remoteState.state === 'ready') {
    return {
      ok: true, state: remoteState.state, cfg, branch, id: opts.id, requestedId: opts.id,
      canonicalId, suiteId: remoteState.suiteId, policy, text: null, folder: null,
      issue: found.issue, criteria, issueUpdatedAt: found.issue.updated_at || null,
    };
  }

  let located;
  try {
    located = resolveIssueFolder(cfg, canonicalId, opts.id, undefined,
      remoteState.state === 're-gate'
        ? { suiteId: remoteState.suiteId, tree: remoteState.suiteTree } : null);
  }
  catch (e) { return { ok: false, kind: 'unknown', error: (e && e.message) || String(e) }; }
  if (!located.ok) return { ok: false, kind: located.kind, error: located.error };
  const folder = located.folder;

  const state = remoteState.state === 'local'
    ? classifyLocal(cfg, canonicalId, opts.id, folder) : remoteState;
  if (!state.ok) return { ok: false, kind: state.kind || 'unknown', error: state.error };

  const ctx = {
    cfg,
    configPath: opts.config,
    id: opts.id,
    requestedId: opts.id,
    canonicalId,
    suiteId: state.suiteId,
    data: found.issue,
    folder,
    branch,
    policy,
    example: exampleSuite(cfg, state.suiteId),
    repoRoot: pipelineMain(),
    state,
  };

  const lines = state.state === 'write' ? writeBrief(ctx)
    : state.state === 'freeze' ? freezeBrief(ctx)
      : reGateBrief(ctx);

  return {
    ok: true, state: state.state, cfg, branch, id: opts.id, requestedId: opts.id,
    canonicalId, suiteId: state.suiteId, policy, folder,
    text: lines.join('\n'), issue: found.issue, criteria,
    issueUpdatedAt: found.issue.updated_at || null,
  };
}

function main(argv, out = console.log, err = console.error) {
  if (!argv.length || argv[0] === '--help' || argv[0] === '-h') {
    out(USAGE);
    return argv.length ? EXIT_OK : EXIT_USAGE;
  }
  const opts = parseArgs(argv);
  if (opts.error) { err(`spec-brief: ${opts.error}`); err(USAGE); return EXIT_USAGE; }
  if (!opts.id || !validIssueId(opts.id)) { err('spec-brief: needs a safe issue id'); err(USAGE); return EXIT_USAGE; }
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

module.exports = {
  main,
  buildBrief,
  parseArgs,
  classify,
  exampleSuite,
  worktrees,
  envLines,
  acceptanceCriteria,
  criteriaInfo,
  issueNames,
  canonicalIssueId,
  suiteCandidates,
  classifyBranchCandidates,
  resolveIssueFolder,
  targetPolicy,
  verifyCommandError,
  validIssueId,
};
