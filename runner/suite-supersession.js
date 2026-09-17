#!/usr/bin/env node
// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0
'use strict';

// Retirement of superseded frozen acceptance contracts, as data plus one resolver.
//
// WHY THIS EXISTS. Two frozen suites can contradict each other: the older one pins behaviour the
// newer one replaces. Whichever runs last is red, and the only thing that runs the whole tree can
// say nothing about it beyond "ALREADY red at the fork point" — which is exactly how a real
// regression gets to look normal. Nothing recorded WHY a suite is red on purpose, which issue
// replaced it, or at which commit that replacement became true.
//
// `contracts/superseded-suites.json` records that. This file is the only implementation of "what
// does the roster say": the sweep coordinator, the publication path and hosted validation all
// resolve through it rather than keeping a roster of their own. It depends on Node built-ins and
// Git alone, so any checkout carrying this one file can run it.
//
// A retirement is a claim about immutable history, so it is believed only when every part of the
// claim is checkable: the replacement suite is frozen on the integration branch at EXACTLY the
// commit that introduced it (not merely a later commit that still contains it), the retired suite
// still matches the bytes the candidate committed, and the superseding implementation is actually
// present at the candidate under validation. Anything else fails closed, with no roster handed
// back — an unresolvable roster is never the same answer as an empty one.
//
// One field, `integrationCommit`, may be written either as the canonical 40-hex literal or as the
// token `derive:freeze-commit`, which asks this repository's own history for that same identity
// (see DERIVE_FREEZE_COMMIT below). Resolving the token is the only reason the contract READER
// ever invokes Git; a contract spelled in literals is validated from the file alone.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const CONTRACT_PATH = 'contracts/superseded-suites.json';

// A suite id is a BARE directory name, spelled exactly as the directory is spelled on disk. No
// separators, no traversal, no drive letters: a case-folded or path-bearing id would run or
// retire something the contract never named on a filesystem that happily opens it anyway.
const SUITE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const COMMIT_ID = /^[0-9a-f]{40}$/;
const CONTROL_DIR = '_control';
const ENTRY_KEYS = ['suite', 'supersededBy', 'replacementSuite', 'rationale', 'integrationCommit'];

// The files a frozen acceptance suite cannot be without. A freeze lands them in one commit, so
// the commit that ADDED them is the commit that froze the suite.
const REQUIRED_SUITE_FILES = ['guard.js', 'test.js'];

// `integrationCommit` is canonically the 40-hex literal. It may instead ask for that commit BY
// NAME with this token, which means "the commit that introduced tests/acceptance/<replacement>/,
// derived from this repository's own history". The identity is the same fact either way; the
// token keeps it from being a second, hand-typed copy of the fact that rots the moment history
// is rewritten. Resolving the token is the ONE thing that makes this reader ask Git — a contract
// spelled entirely in literals still needs nothing but the file itself.
const DERIVE_FREEZE_COMMIT = 'derive:freeze-commit';

function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value;
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

function refusal(error) {
  return deepFreeze({ ok: false, error: String(error) });
}

function contractFile(root) {
  return path.join(root, ...CONTRACT_PATH.split('/'));
}

// The commit that froze `suite`: the EARLIEST commit reachable from the candidate that added each
// file a frozen suite cannot lose. Both answers must agree — a freeze lands them together, and if
// they ever stop agreeing this says so rather than picking one.
function deriveFreezeCommit(root, suite) {
  const introduced = new Map();
  for (const name of REQUIRED_SUITE_FILES) {
    const rel = `tests/acceptance/${suite}/${name}`;
    const added = gitAt(root, ['log', '--diff-filter=A', '--format=%H', 'HEAD', '--', rel]);
    if (!added || added.status !== 0) {
      return { ok: false, error: `Git could not read the history of ${rel}: ${((added && added.stderr) || '').trim() || 'git is unavailable'}` };
    }
    const commits = String(added.stdout || '').trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (!commits.length) {
      return { ok: false, error: `Git history records no commit that added ${rel}, so the freeze of "${suite}" cannot be dated` };
    }
    introduced.set(rel, commits[commits.length - 1]);
  }
  const derived = [...new Set(introduced.values())];
  if (derived.length !== 1) {
    return { ok: false, error: `the required files of "${suite}" were not introduced by one freeze commit: `
      + [...introduced].map(([rel, oid]) => `${rel} at ${oid}`).join(', ') };
  }
  if (!COMMIT_ID.test(derived[0])) {
    return { ok: false, error: `the derived freeze commit of "${suite}" is not 40 lowercase hex: ${JSON.stringify(derived[0])}` };
  }
  return { ok: true, commit: derived[0] };
}

// ---- the contract, read and shape-validated alone -------------------------------------------
// No roster, no suite directories, no presence probe and no filesystem beyond the one file: a
// consumer that only wants to know what the repository CLAIMS must not need the whole tree to
// ask. The single exception is the `derive:freeze-commit` token, which by construction is a
// question only history can answer.
function readContract(root) {
  const rootDir = path.resolve(root === undefined || root === null ? process.cwd() : root);
  const file = contractFile(rootDir);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    // An ABSENT contract is the ordinary state of a checkout that has retired nothing. It is an
    // empty retirement set, never a refusal, or every consumer fails closed on a clean tree.
    if (error && error.code === 'ENOENT') return deepFreeze({ ok: true, version: 1, entries: [] });
    return refusal(`cannot read ${CONTRACT_PATH}: ${(error && error.message) || error}`);
  }

  let doc;
  try { doc = JSON.parse(raw); }
  catch (error) { return refusal(`${CONTRACT_PATH} is not valid JSON: ${(error && error.message) || error}`); }

  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    return refusal(`${CONTRACT_PATH} must be a JSON object with exactly "version" and "supersessions"`);
  }
  const topKeys = Object.keys(doc);
  const unknownTop = topKeys.filter((key) => key !== 'version' && key !== 'supersessions');
  if (unknownTop.length) {
    return refusal(`${CONTRACT_PATH} carries unknown top-level field(s): ${unknownTop.join(', ')}`);
  }
  if (!topKeys.includes('version')) return refusal(`${CONTRACT_PATH} declares no "version"`);
  if (doc.version !== 1) {
    return refusal(`${CONTRACT_PATH} declares unsupported "version" ${JSON.stringify(doc.version)}; this reader understands version 1`);
  }
  if (!topKeys.includes('supersessions')) return refusal(`${CONTRACT_PATH} declares no "supersessions"`);
  if (!Array.isArray(doc.supersessions)) {
    return refusal(`${CONTRACT_PATH} "supersessions" must be an array of retirement entries`);
  }

  const entries = [];
  const retired = new Set();
  for (let index = 0; index < doc.supersessions.length; index += 1) {
    const row = doc.supersessions[index];
    const where = `${CONTRACT_PATH} supersessions[${index}]`;
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      return refusal(`${where} is not a retirement entry object`);
    }
    const keys = Object.keys(row);
    const unknown = keys.filter((key) => !ENTRY_KEYS.includes(key));
    if (unknown.length) return refusal(`${where} carries unknown field(s): ${unknown.join(', ')}`);
    const missing = ENTRY_KEYS.filter((key) => !keys.includes(key));
    if (missing.length) return refusal(`${where} is missing field(s): ${missing.join(', ')}`);

    // Named by its own suite id from here on, because that is the word a reader will look for.
    const label = typeof row.suite === 'string' && row.suite !== '' ? row.suite : where;
    if (typeof row.suite !== 'string' || !SUITE_ID.test(row.suite)) {
      return refusal(`${where}: "suite" must be a bare acceptance suite directory name, got ${JSON.stringify(row.suite)}`);
    }
    if (typeof row.replacementSuite !== 'string' || !SUITE_ID.test(row.replacementSuite)) {
      return refusal(`the retirement of "${label}": "replacementSuite" must be a bare acceptance suite directory name, got ${JSON.stringify(row.replacementSuite)}`);
    }
    if (typeof row.supersededBy !== 'string' || row.supersededBy.trim() === '') {
      return refusal(`the retirement of "${label}": "supersededBy" must name the newer issue that retires it`);
    }
    if (typeof row.rationale !== 'string' || row.rationale.trim() === '' || /[\r\n]/.test(row.rationale)) {
      return refusal(`the retirement of "${label}": "rationale" must be a non-empty single-line string saying why`);
    }
    // Either the canonical literal, or the token that asks history for the same identity. The
    // token is resolved HERE so that every later reader — including this file's own Git checks —
    // sees one kind of value: a 40-hex commit.
    let integrationCommit = row.integrationCommit;
    if (integrationCommit === DERIVE_FREEZE_COMMIT) {
      const derived = deriveFreezeCommit(rootDir, row.replacementSuite);
      if (!derived.ok) return refusal(`the retirement of "${label}": ${derived.error}`);
      integrationCommit = derived.commit;
    }
    if (typeof integrationCommit !== 'string' || !COMMIT_ID.test(integrationCommit)) {
      return refusal(`the retirement of "${label}": "integrationCommit" must be 40 lowercase hex, got ${JSON.stringify(row.integrationCommit)}`);
    }
    if (row.suite === row.replacementSuite) {
      return refusal(`the retirement of "${label}" names itself as its own replacement, which retires nothing`);
    }
    if (retired.has(row.suite)) {
      return refusal(`the suite "${row.suite}" is retired more than once; two entries for one suite are two contradictory claims`);
    }
    retired.add(row.suite);
    entries.push({
      suite: row.suite,
      supersededBy: row.supersededBy,
      replacementSuite: row.replacementSuite,
      rationale: row.rationale,
      integrationCommit,
    });
  }

  return deepFreeze({ ok: true, version: doc.version, entries });
}

// ---- Git, asked rather than assumed ----------------------------------------------------------
function gitAt(root, args) {
  return spawnSync('git', ['-c', 'safe.directory=*', '-C', root, ...args], {
    encoding: 'utf8', windowsHide: true, timeout: 120000, maxBuffer: 64 * 1024 * 1024,
  });
}

function revParse(root, ref) {
  const result = gitAt(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  const oid = String((result && result.stdout) || '').trim();
  return result && result.status === 0 && COMMIT_ID.test(oid) ? oid : null;
}

// Does this commit's TREE carry the suite? `null` means Git could not answer, which is not "no".
function treeCarriesSuite(root, commit, suite) {
  const listed = gitAt(root, ['ls-tree', '-r', '--name-only', commit, '--', `tests/acceptance/${suite}/`]);
  if (!listed || listed.status !== 0) return null;
  return String(listed.stdout || '').trim().length > 0;
}

function parentsOf(root, commit) {
  const listed = gitAt(root, ['rev-list', '--parents', '-n', '1', commit]);
  if (!listed || listed.status !== 0) return null;
  return String(listed.stdout || '').trim().split(/\s+/).filter(Boolean).slice(1);
}

function projectConfig(root) {
  try { return JSON.parse(fs.readFileSync(path.join(root, 'pipeline.config.json'), 'utf8')); }
  catch { return {}; }
}

// The default presence probe: the project's own verify command, over the replacement suite, in
// the candidate tree. It answers one question — is the superseding implementation there yet?
function defaultRunSuite(root) {
  const cfg = projectConfig(root);
  const verify = typeof cfg.verifyCommand === 'string' && cfg.verifyCommand.trim()
    ? cfg.verifyCommand.trim() : 'sh tools/run-acceptance.sh';
  const parts = verify.split(/\s+/).filter(Boolean);
  return (suiteId) => {
    const result = spawnSync(parts[0], [...parts.slice(1), `tests/acceptance/${suiteId}/`], {
      cwd: root, encoding: 'utf8', windowsHide: true, timeout: 1800000, maxBuffer: 64 * 1024 * 1024,
    });
    if (!result || result.error || result.status === null) return { ok: false };
    return { ok: result.status === 0 };
  };
}

function bySuite(a, b) {
  if (a.suite === b.suite) return 0;
  return a.suite < b.suite ? -1 : 1;
}

// ---- the roster -------------------------------------------------------------------------------
function resolveSuites(options = {}) {
  const root = path.resolve(options.root === undefined || options.root === null ? process.cwd() : options.root);

  const contract = readContract(root);
  if (!contract.ok) return refusal(contract.error);
  const entries = contract.entries.map((row) => ({ ...row }));

  // A checkout with no tests/acceptance/ at all is an ordinary input — a `scripts/*` fixture, a
  // tools-only tree — not a defect. It resolves to an empty roster, the same way an absent
  // contract does.
  let onDisk = [];
  try {
    onDisk = fs.readdirSync(path.join(root, 'tests', 'acceptance'), { withFileTypes: true })
      .filter((item) => item.isDirectory() && item.name !== CONTROL_DIR)
      .map((item) => item.name);
  } catch (error) {
    if (!error || error.code !== 'ENOENT') {
      return refusal(`cannot read tests/acceptance/: ${(error && error.message) || error}`);
    }
  }

  if (!entries.length) {
    const active = [...onDisk].sort();
    return deepFreeze({
      ok: true,
      active,
      superseded: [],
      pending: [],
      report: active.map((id) => `active ${id}`),
    });
  }

  const present = new Set(onDisk);
  for (const row of entries) {
    if (!present.has(row.suite)) {
      return refusal(`the retirement of "${row.suite}" names a suite that is not an immediate directory under tests/acceptance/ spelled exactly that way`);
    }
    if (!present.has(row.replacementSuite)) {
      return refusal(`the retirement of "${row.suite}" names the replacement suite "${row.replacementSuite}", which is not an immediate directory under tests/acceptance/ spelled exactly that way`);
    }
  }

  const declared = projectConfig(root).defaultBranch;
  const branch = typeof declared === 'string' && declared ? declared : 'main';
  let integrationRef = options.integrationRef || null;
  if (!integrationRef) {
    for (const candidate of [`origin/${branch}`, branch, 'HEAD']) {
      if (revParse(root, candidate)) { integrationRef = candidate; break; }
    }
  }
  if (!integrationRef || !revParse(root, integrationRef)) {
    return refusal(`the integration ref ${JSON.stringify(integrationRef || `origin/${branch}`)} does not resolve to a commit, so no retirement can be dated`);
  }
  const candidateRef = options.candidateRef || 'HEAD';
  if (!revParse(root, candidateRef)) {
    return refusal(`the candidate ref ${JSON.stringify(candidateRef)} does not resolve to a commit`);
  }

  for (const row of entries) {
    const label = `the retirement of "${row.suite}" (replacement "${row.replacementSuite}")`;
    const kind = gitAt(root, ['cat-file', '-t', row.integrationCommit]);
    if (String((kind && kind.stdout) || '').trim() !== 'commit') {
      return refusal(`${label}: integrationCommit ${row.integrationCommit} is not a commit in this repository`);
    }
    const reachable = gitAt(root, ['merge-base', '--is-ancestor', row.integrationCommit, integrationRef]);
    if (!reachable || reachable.status !== 0) {
      return refusal(`${label}: integrationCommit ${row.integrationCommit} is not reachable from the integration ref ${integrationRef}, so the replacement is not frozen on the integration branch`);
    }
    // "Superseded at commit X" is a claim about WHEN the replacement became true. Every commit
    // after the freeze carries the files too, so "contains it" is not an identity: only the
    // commit that INTRODUCED the suite dates the retirement.
    const carries = treeCarriesSuite(root, row.integrationCommit, row.replacementSuite);
    if (carries === null) {
      return refusal(`${label}: the tree of integrationCommit ${row.integrationCommit} could not be read`);
    }
    if (carries === false) {
      return refusal(`${label}: integrationCommit ${row.integrationCommit} does not carry the replacement suite "${row.replacementSuite}" at all, so it cannot be the commit that froze it`);
    }
    const parents = parentsOf(root, row.integrationCommit);
    if (parents === null) {
      return refusal(`${label}: the history of integrationCommit ${row.integrationCommit} could not be read`);
    }
    for (const parent of parents) {
      const before = treeCarriesSuite(root, parent, row.replacementSuite);
      if (before === null) {
        return refusal(`${label}: the tree of ${parent}, a parent of integrationCommit ${row.integrationCommit}, could not be read`);
      }
      if (before === true) {
        return refusal(`${label}: integrationCommit ${row.integrationCommit} is a later commit that merely still contains the replacement suite "${row.replacementSuite}" — its parent ${parent} already carried it, so it is not the commit that introduced it`);
      }
    }
    // A retirement is a claim about immutable history. If that history has been edited under it,
    // the claim is no longer checkable and must not be believed.
    const edited = gitAt(root, ['diff', '--quiet', candidateRef, '--', `tests/acceptance/${row.suite}/`]);
    if (!edited || edited.status !== 0) {
      return refusal(`the retired suite "${row.suite}" no longer matches the bytes ${candidateRef} records for it; a retirement cannot stand over edited history`);
    }
  }

  // ---- chains ---------------------------------------------------------------------------------
  // Retirements may chain. No link may be retired on the strength of a link that is itself
  // retired, so an entry's presence probe is its TERMINAL replacement. A chain that closes on
  // itself says nothing at all and fails closed.
  const retiredBy = new Map(entries.map((row) => [row.suite, row]));
  for (const start of entries) {
    const walked = [];
    const seen = new Set();
    let current = start.suite;
    while (retiredBy.has(current)) {
      if (seen.has(current)) {
        return refusal(`the retirement contract closes on itself: ${walked.join(' -> ')} -> ${current}`);
      }
      seen.add(current);
      walked.push(current);
      current = retiredBy.get(current).replacementSuite;
    }
  }
  const terminalFor = (suite) => {
    let current = retiredBy.get(suite).replacementSuite;
    while (retiredBy.has(current)) current = retiredBy.get(current).replacementSuite;
    return current;
  };

  const runSuite = typeof options.runSuite === 'function' ? options.runSuite : defaultRunSuite(root);
  const verdicts = new Map();
  const asked = [];
  for (const row of entries) {
    const terminal = terminalFor(row.suite);
    if (!verdicts.has(terminal)) { verdicts.set(terminal, null); asked.push(terminal); }
  }
  for (const terminal of asked) {
    let answer;
    try { answer = runSuite(terminal); }
    catch (error) {
      return refusal(`the candidate-presence probe for the replacement suite "${terminal}" could not run: ${(error && error.message) || error}`);
    }
    if (!answer || typeof answer !== 'object' || typeof answer.ok !== 'boolean') {
      return refusal(`the candidate-presence probe for the replacement suite "${terminal}" returned no verdict; an unanswerable probe retires nothing`);
    }
    verdicts.set(terminal, answer.ok);
  }

  const superseded = [];
  const pending = [];
  for (const row of entries) {
    const terminal = terminalFor(row.suite);
    if (verdicts.get(terminal) === true) {
      superseded.push({ ...row });
    } else {
      pending.push({
        suite: row.suite,
        replacementSuite: row.replacementSuite,
        reason: `the superseding implementation is not present at this candidate yet: the replacement suite ${terminal} does not pass here`,
      });
    }
  }
  superseded.sort(bySuite);
  pending.sort(bySuite);

  const gone = new Set(superseded.map((row) => row.suite));
  const active = onDisk.filter((id) => !gone.has(id)).sort();

  const report = [
    ...active.map((id) => `active ${id}`),
    ...superseded.map((row) => `superseded ${row.suite} -> ${row.replacementSuite}`
      + ` (issue ${row.supersededBy}, frozen at ${row.integrationCommit}): ${row.rationale}`),
    ...pending.map((row) => `pending ${row.suite} -> ${row.replacementSuite}: ${row.reason}`),
  ];

  return deepFreeze({ ok: true, active, superseded, pending, report });
}

// ---- the CLI -----------------------------------------------------------------------------------
// verify-pr.sh cannot import anything, so the resolver has to be reachable from a command line
// over the checkout being validated.
const USAGE = [
  'usage:',
  '  node runner/suite-supersession.js plan   --repo <root>   # one line per roster row',
  '  node runner/suite-supersession.js active --repo <root>   # one active suite id per line',
].join('\n');

function main(argv, out = (line) => process.stdout.write(`${line}\n`),
  err = (line) => process.stderr.write(`${line}\n`)) {
  const args = Array.isArray(argv) ? argv.slice() : [];
  const verb = args.shift();
  if (verb !== 'plan' && verb !== 'active') {
    err(`suite-supersession: unknown verb ${JSON.stringify(verb === undefined ? null : verb)}`);
    err(USAGE);
    return 2;
  }
  let root = process.cwd();
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--repo') {
      const value = args[i + 1];
      if (value === undefined || value.startsWith('--')) { err('suite-supersession: --repo needs a value'); return 2; }
      root = value;
      i += 1;
      continue;
    }
    err(`suite-supersession: unknown option ${JSON.stringify(args[i])}`);
    return 2;
  }

  const resolved = resolveSuites({ root });
  if (!resolved.ok) {
    err(`suite-supersession: ${resolved.error}`);
    return 1;
  }
  const lines = verb === 'plan' ? resolved.report : resolved.active;
  for (const line of lines) out(line);
  return 0;
}

// `process.exitCode` rather than `process.exit()`: stdout and stderr are ASYNCHRONOUS when they
// are pipes on Windows, and every consumer of this CLI reads it through a pipe — `verify-pr.sh`
// captures the report, and the acceptance suite captures the refusal and looks for the commit it
// names. `process.exit()` would be free to drop exactly that text. Setting the code and letting
// the process end on its own flushes first and still exits non-zero.
if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { CONTRACT_PATH, readContract, resolveSuites, main };
