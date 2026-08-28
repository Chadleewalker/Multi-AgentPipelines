#!/usr/bin/env node
// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// The suite hash — DESIGN.md §3.2 ("The stale guard, and the receipt", change-log row
// `receipt-design`) and §4.12's third admission rule.
//
// ONE FORMULA, ONE FILE. The freeze gate writes a content hash of the frozen suite into
// `tests/acceptance/<issue-id>/.freeze-gate.json`, and the dispatch gate later recomputes the
// same hash from the integration branch and refuses a candidate whose suite has moved since the
// gate blessed it. Two copies of that formula would drift silently and unattended — the
// `runner/pause.js` precedent — and the failure would be a whole batch refused for a reason
// nobody could reproduce, or worse, a changed suite accepted. So the formula is `suiteHash`
// below and nothing else computes one.
//
// THE HASH IS OVER GIT BLOB IDS, NEVER RAW WORKING-COPY BYTES. This is the load-bearing
// decision and it is not a matter of taste: the reference host's checkout is CRLF and the
// committed blob is LF (CLAUDE.md, "guard line endings at the point of parsing"), so a hash of
// the bytes on the planning machine's disk would disagree with the branch on every single
// freeze, and the dispatch gate would refuse every task it was built to admit. A blob id is
// what git will actually store — the content after the clean filter that `core.autocrlf`,
// `core.eol` and any `.gitattributes` filter applies — so the two sides agree by construction.
//
// Node built-ins only, and HOST-ONLY: a container has no `git` history to hash and no reason to
// (its own suite is what it is being judged against). Nothing here is reachable from
// `pipeline/`.
'use strict';

const crypto = require('crypto');
const { spawnSync } = require('child_process');

// The receipt's own name, exported so no caller retypes it. It is excluded from the hash on
// both sides: the file records the hash, so including it would be self-referential, and a probe
// that has not been gated does not carry one.
const RECEIPT_NAME = '.freeze-gate.json';

// Every `git` call here is bounded. An unbounded `spawnSync` is how a wedged git parks a
// planning session with no diagnostic (change-log row `repo-sls`), and `spawnSync` reports a
// timeout as `status: null` with empty stdout, which is indistinguishable from a query that
// answered with nothing — so a bound has to be turned into a real error, not left as silence.
const DEFAULT_GIT_TIMEOUT_MS = 60000;
// Generous, because a suite listing is a listing of paths and a suite can be large. The
// verifier's own ceiling exists for the same reason (change-log row `verify-nobuffer`); this
// number is not that one and is deliberately its own, because what overflows here is a file
// list rather than a test run's chatter.
const MAX_GIT_BUFFER = 64 * 1024 * 1024;

// GIT_DIR, GIT_WORK_TREE and GIT_INDEX_FILE are stripped: they make `git` answer about a
// repository other than the one named by `cwd`, so a gate invoked from inside a git hook — or
// from any process that inherited them — would hash the wrong tree and say nothing.
function gitEnv() {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  return env;
}

function git(repoRoot, args, opts) {
  const timeout = (opts && opts.timeoutMs) || DEFAULT_GIT_TIMEOUT_MS;
  const r = spawnSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    env: gitEnv(),
    timeout,
    killSignal: 'SIGKILL',
    maxBuffer: MAX_GIT_BUFFER,
  });
  if (r.error && r.error.code === 'ETIMEDOUT') {
    return { ok: false, status: 124, stdout: '', stderr: `git ${args[0]} did not answer within ${timeout}ms` };
  }
  if (r.error) return { ok: false, status: null, stdout: '', stderr: r.error.message };
  if (r.status === null) {
    return { ok: false, status: null, stdout: r.stdout || '', stderr: `git ${args[0]} was killed by ${r.signal || 'a signal'}` };
  }
  return { ok: r.status === 0, status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

// Is this a git repository at all? Asked before anything else, because every value the receipt
// records comes from git and a plain directory would otherwise produce a receipt whose hash is
// over nothing — present, well-formed and meaningless.
function isGitRepo(repoRoot) {
  return git(repoRoot, ['rev-parse', '--git-dir']).ok;
}

// The planning checkout's HEAD when the gate ran. Informational — never compared (§3.2) — and
// `null` on an unborn HEAD, which is a legitimate state for a repository onboarded minutes ago.
function headCommit(repoRoot) {
  const r = git(repoRoot, ['rev-parse', 'HEAD']);
  const out = (r.stdout || '').trim();
  return r.ok && /^[0-9a-f]{40}$/.test(out) ? out : null;
}

// `tests/acceptance/demo/` and `tests\acceptance\demo` are the same suite. Normalised to the
// repo-root-relative, POSIX-separated, slash-free-at-the-end form git speaks.
function normalizeSuiteRel(tests) {
  return String(tests == null ? '' : tests)
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '');
}

// THE FORMULA. Sorted bytewise by suite-relative path, then `path\0blob\n` concatenated and
// hashed with sha256. The NUL is what stops two different suites colliding by having a path and
// a blob id run together, and the sort is bytewise rather than locale-aware because a hash whose
// value depends on the planning machine's collation is a hash the dispatch gate cannot check.
const byPathBytes = (a, b) =>
  Buffer.compare(Buffer.from(String(a.path), 'utf8'), Buffer.from(String(b.path), 'utf8'));

function suiteHash(entries) {
  const list = [...(entries || [])].sort(byPathBytes);
  const h = crypto.createHash('sha256');
  for (const e of list) h.update(`${e.path}\0${e.blob}\n`);
  return h.digest('hex');
}

// The entries as they stand in a WORKING COPY — what the freeze gate hashes, because at
// planning time the suite has just been written and may not be committed yet.
//
// `--cached --others --exclude-standard` is the pair that makes this honest: `--cached` catches
// a suite already committed, `--others` a suite only just written, and `--exclude-standard` drops
// what `.gitignore` drops — because a file git will never store is a file the dispatch gate can
// never see, and hashing it would make the receipt disagree with the branch for a file that was
// never part of the freeze. A file the SUITE ITSELF writes when it runs falls out of the same
// rule the other way: it is not there yet, which is why the gate takes this hash BEFORE the run.
function workingTreeEntries(repoRoot, tests, opts) {
  const prefix = normalizeSuiteRel(tests);
  const listing = git(repoRoot, [
    'ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', prefix,
  ], opts);
  if (!listing.ok) {
    throw new Error(`git ls-files failed in ${repoRoot}: ${(listing.stderr || '').trim() || `exit ${listing.status}`}`);
  }
  // `-z`, so a path git would otherwise quote (`core.quotePath`) arrives verbatim.
  const rootRels = listing.stdout.split('\0').filter(Boolean);
  const seen = new Map();
  for (const rootRel of rootRels) {
    const rel = rootRel.slice(prefix.length + 1);
    if (!rel || rel === RECEIPT_NAME) continue;
    if (seen.has(rel)) continue;
    // `--path` is what applies the clean filter for this path's attributes; without it the
    // answer would be the raw bytes, which is the whole thing this module exists not to do.
    const h = git(repoRoot, ['hash-object', '--path', rootRel, '--', rootRel], opts);
    const blob = (h.stdout || '').trim();
    if (!h.ok || !/^[0-9a-f]{40}$/.test(blob)) {
      throw new Error(`git hash-object failed for ${rootRel}: ${(h.stderr || '').trim() || `exit ${h.status}`}`);
    }
    seen.set(rel, blob);
  }
  return [...seen].map(([p, blob]) => ({ path: p, blob }));
}

// The entries as they stand in a COMMITTED TREE — what the dispatch gate will hash, because by
// then the suite is on the integration branch and there is no working copy to read. `ls-tree`
// hands back the blob ids directly, so no filter question arises on this side at all.
function treeEntries(repoRoot, ref, tests, opts) {
  const prefix = normalizeSuiteRel(tests);
  const listing = git(repoRoot, ['ls-tree', '-r', '-z', ref, '--', prefix], opts);
  if (!listing.ok) {
    throw new Error(`git ls-tree failed in ${repoRoot}: ${(listing.stderr || '').trim() || `exit ${listing.status}`}`);
  }
  const entries = [];
  for (const record of listing.stdout.split('\0').filter(Boolean)) {
    const m = /^\d+ blob ([0-9a-f]{40})\t([\s\S]+)$/.exec(record);
    if (!m) continue;
    const rel = m[2].slice(prefix.length + 1);
    if (!rel || rel === RECEIPT_NAME) continue;
    entries.push({ path: rel, blob: m[1] });
  }
  return entries;
}

module.exports = {
  suiteHash,
  workingTreeEntries,
  treeEntries,
  isGitRepo,
  headCommit,
  normalizeSuiteRel,
  RECEIPT_NAME,
  DEFAULT_GIT_TIMEOUT_MS,
};
