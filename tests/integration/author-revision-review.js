#!/usr/bin/env node
// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0
'use strict';

// Local Git fixtures only. The author and verifier are controlled; candidate adoption is real.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const A = require('../../scripts/author-tests');
const R = require('../../scripts/author-revision');
const P = require('../../scripts/prove-tests');
const C = require('../../scripts/proof-candidate');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'author-revision-review-'));
const originalEnv = { ...process.env };
let sequence = 0;
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const originalTest = '// Existing narrow assertion\nconst expected = false;\n';
const correctedTest = originalTest.replace('false', 'true');

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', timeout: 60000, windowsHide: true, ...options });
}
function git(root, ...args) {
  const r = run('git', ['-c', 'core.autocrlf=false', '-c', `safe.directory=${root}`, ...args], { cwd: root });
  assert.strictEqual(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return String(r.stdout || '');
}
function put(root, rel, bytes) {
  const file = path.join(root, rel); fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes); return file;
}
function digestTree(root) {
  const rows = [];
  function visit(dir, prefix) {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name); const rel = prefix ? `${prefix}/${name}` : name;
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) rows.push([rel, 'link', fs.readlinkSync(file)]);
      else if (stat.isDirectory()) { rows.push([rel, 'directory']); visit(file, rel); }
      else rows.push([rel, stat.mode & 0o777, sha(fs.readFileSync(file))]);
    }
  }
  visit(root, ''); return JSON.stringify(rows);
}
function fixture(options = {}) {
  const dir = path.join(tmp, `case-${++sequence}`); const target = path.join(dir, 'target');
  const author = path.join(dir, 'author'); const suite = 'tests/acceptance/correction-case';
  fs.mkdirSync(target, { recursive: true });
  const policy = { defaultBranch: 'main', verifyCommand: 'sh tools/accept.sh', frozenPaths: ['tools/accept.sh'] };
  put(target, 'pipeline.config.json', JSON.stringify(policy));
  put(target, 'tools/accept.sh', '#!/bin/sh\nexit 0\n');
  put(target, 'tests/acceptance/_control/pass.js', '// published control\n');
  put(target, 'src/value.txt', 'red\n');
  if (options.frozen) put(target, `${suite}/test.js`, originalTest);
  git(target, 'init', '-q', '-b', 'main');
  git(target, 'config', 'user.name', 'revision fixture');
  git(target, 'config', 'user.email', 'fixture@example.invalid');
  git(target, 'config', 'core.filemode', 'false');
  git(target, 'add', '-A'); git(target, 'commit', '-qm', 'base');
  git(target, 'worktree', 'add', '-q', '-b', 'freeze-correction-case', author);
  put(author, `${suite}/test.js`, originalTest);
  put(author, `${suite}/guard.js`, '// [guard] Preserve this exact check.\r\n');
  put(author, `${suite}/fixture.bin`, Buffer.from([0, 255, 13, 10, 128]));
  const criteriaText = 'Show green for the exact selected idea; preserve legacy behavior.';
  const built = { ok: true, id: 'correction-case', canonicalId: 'correction-case', suiteId: 'correction-case',
    state: 'freeze', branch: 'main', folder: { dir: author, branch: 'freeze-correction-case', exists: true },
    issue: { id: 'correction-case', title: 'Correct one assertion', acceptance_criteria: criteriaText },
    criteria: { text: criteriaText, source: 'acceptance_criteria', sha256: sha(Buffer.from(criteriaText)) },
    issueUpdatedAt: '2026-09-20T00:00:00Z', text: 'The normal freeze-state brief.', policy,
    cfg: { targetRepoPath: target, image: 'fixture:local', wallClockMinutes: 1,
      provider: 'claude', testAuthorProvider: 'claude', testProbeProvider: 'claude',
      model: 'fixture-model', testAuthorModel: 'fixture-model', testProbeModel: 'fixture-model', testProbeAttempts: 3 } };
  const old = P.prepareProbe(built, 'fixture-model', run, dir); assert(old.ok, old.error);
  put(old.probe, 'src/value.txt', 'green\n');
  put(old.container, 'prior-result.json', '{"outcome":"unproven","kind":"agent"}\n');
  const inspected = C.inspectCandidate(built, old.probe, P, run);
  const candidateProbe = { path: old.probe, hash: inspected.hash };
  const reviewFile = put(dir, 'review.txt', 'In test.js change only expected = false to expected = true. Preserve guard.js and fixture.bin.');
  const review = R.readReview(reviewFile); const suiteHash = R.inspectSuite(author, built.id).hash;
  return { dir, target, author, suite, built, old, candidateProbe, review, reviewFile, suiteHash };
}
function revision(f) {
  return R.prepareRevision(f.built, { suiteHash: f.suiteHash, review: f.review }, f.candidateProbe, run);
}
function execute(f, pinned, edit, gate = () => ({ status: 0, stdout: 'controlled RED/GREEN gate' })) {
  let authors = 0; let proofModels = 0; let gates = 0; let prepared = null; let launched = null;
  const lines = [];
  const result = A.authorIssue(f.built, path.join(f.dir, 'run.config.json'), {
    out: s => lines.push(String(s)), err: s => lines.push(String(s)),
  }, {
    revision: pinned, runSync: run,
    launchAuthor: b => { authors++; launched = b; return edit(b); },
    probeSeams: { runSync: run, tempRoot: f.dir,
      launchProbe: () => { proofModels++; throw Error('revision must not launch a proof model'); },
      runGate: (built, fresh) => { gates++; prepared = fresh; return gate(built, fresh); },
    },
  });
  assert.strictEqual(proofModels, 0, 'no model fallback on any correction outcome');
  return { result, authors, gates, prepared, launched, lines };
}
function check(name, body) { body(); console.log(`PASS ${name}`); }

try {
  const gitconfig = put(tmp, 'gitconfig', '');
  for (const name of Object.keys(process.env)) {
    if (/^(GIT_|PIPELINE_|FREEZE_GATE_|NODE_OPTIONS$|NODE_TEST_CONTEXT$)/.test(name)) delete process.env[name];
  }
  process.env.GIT_CONFIG_GLOBAL = gitconfig; process.env.GIT_CONFIG_SYSTEM = gitconfig;
  process.env.GIT_CONFIG_NOSYSTEM = '1'; process.env.GIT_TERMINAL_PROMPT = '0';
  process.env.BD_SKIP_AUTO_PUSH = '1'; process.env.BD_SKIP_AUTO_PULL = '1';

  check('one bounded author correction re-proves the retained candidate without rewriting prior evidence', () => {
    const f = fixture(); const pinned = revision(f); const before = digestTree(f.old.container);
    const untouched = ['guard.js', 'fixture.bin'].map(name => [name, fs.readFileSync(path.join(f.author, f.suite, name))]);
    const r = execute(f, pinned, launched => {
      assert.strictEqual(launched.state, 'freeze', 'revision keeps the genuine discovered state');
      assert(launched.text.includes(f.review.text), 'author receives the exact approved feedback');
      assert(launched.text.includes(f.built.criteria.text), 'author retains immutable acceptance criteria');
      put(f.author, `${f.suite}/test.js`, correctedTest);
      return { status: 0, stdout: 'Finished the requested local assertion correction.' };
    }, (_built, fresh) => {
      assert.notStrictEqual(fresh.container, f.old.container);
      for (const root of [fresh.baseline, fresh.probe]) {
        assert.strictEqual(fs.readFileSync(path.join(root, f.suite, 'test.js'), 'utf8'), correctedTest);
        for (const [name, bytes] of untouched) assert(fs.readFileSync(path.join(root, f.suite, name)).equals(bytes));
      }
      assert.strictEqual(fs.readFileSync(path.join(fresh.baseline, 'src/value.txt'), 'utf8'), 'red\n');
      assert.strictEqual(fs.readFileSync(path.join(fresh.probe, 'src/value.txt'), 'utf8'), 'green\n');
      return { status: 0, stdout: 'corrected suite is RED at base and GREEN in exact candidate' };
    });
    assert(r.result.ok, r.result.error); assert.strictEqual(r.authors, 1); assert.strictEqual(r.gates, 1);
    assert(Number.isSafeInteger(r.result.authorElapsedMs) && r.result.authorElapsedMs >= 0, 'author time is measured separately');
    assert.strictEqual(r.result.revision.authorElapsedMs, r.result.authorElapsedMs);
    assert.strictEqual(r.result.revision.sourceSuiteHash, f.suiteHash);
    assert.strictEqual(r.result.revision.reviewHash, f.review.hash);
    assert.strictEqual(r.result.revision.candidateHash, f.candidateProbe.hash);
    assert.strictEqual(r.result.revision.resultSuiteHash, R.inspectSuite(f.author, f.built.id).hash);
    for (const [name, bytes] of untouched) assert(fs.readFileSync(path.join(f.author, f.suite, name)).equals(bytes));
    assert.strictEqual(digestTree(f.old.container), before);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(r.prepared.container, P.MARKER))).status, 'proven');
    assert.notStrictEqual(R.inspectSuite(f.author, f.built.id).hash, f.suiteHash);
  });

  check('review and suite selectors bind exact bytes and reject substituted review content', () => {
    const f = fixture(); const original = R.inspectSuite(f.author, f.built.id).hash;
    assert.match(original, /^[0-9a-f]{64}$/);
    put(f.author, `${f.suite}/test.js`, originalTest.replace(/\n/g, '\r\n'));
    assert.notStrictEqual(R.inspectSuite(f.author, f.built.id).hash, original, 'line endings are raw input bytes');
    assert.throws(() => revision(f));
    put(f.author, `${f.suite}/test.js`, originalTest);
    assert.throws(() => R.prepareRevision(f.built, { suiteHash: f.suiteHash,
      review: { ...f.review, text: `${f.review.text} Broaden the scope.` } }, f.candidateProbe, run));
    git(f.author, 'add', '--', `${f.suite}/test.js`);
    git(f.author, 'update-index', '--chmod=+x', '--', `${f.suite}/test.js`);
    assert.notStrictEqual(R.inspectSuite(f.author, f.built.id).hash, original, 'Git executable mode is pinned');
  });

  check('suite, criteria, worktree, base and candidate drift refuse before author launch', () => {
    const mutations = [
      f => put(f.author, `${f.suite}/test.js`, `${originalTest}// drift\n`),
      f => { f.built.criteria = { ...f.built.criteria, sha256: '0'.repeat(64) }; },
      f => { f.built.issue.acceptance_criteria += ' Changed requirements.'; },
      f => { f.built.issue.metadata = { unrelatedNewInput: 'changed after review' }; },
      f => { f.built.issueUpdatedAt = '2026-09-20T00:00:01Z'; },
      f => { f.built.folder = { ...f.built.folder, dir: f.target }; },
      f => git(f.author, 'commit', '--allow-empty', '-qm', 'different author base'),
      f => put(f.old.probe, 'src/value.txt', 'changed candidate\n'),
    ];
    for (const mutate of mutations) {
      const f = fixture(); const pinned = revision(f); mutate(f);
      const before = digestTree(f.old.container);
      assert.strictEqual(R.validateRevision(f.built, pinned, run).ok, false);
      const r = execute(f, pinned, () => { throw Error('stale revision reached author'); });
      assert.strictEqual(r.result.ok, false); assert.strictEqual(r.authors, 0); assert.strictEqual(r.gates, 0);
      assert.strictEqual(digestTree(f.old.container), before);
    }
  });

  check('published suites and states outside an unfrozen correction cannot acquire a revision', () => {
    const f = fixture();
    for (const state of ['write', 'ready', 're-gate']) {
      assert.throws(() => R.prepareRevision({ ...f.built, state }, { suiteHash: f.suiteHash, review: f.review }, f.candidateProbe, run));
    }
    const frozen = fixture({ frozen: true });
    assert.throws(() => revision(frozen));
  });

  check('review and suite readers enforce finite input limits and refuse linked files or directories', () => {
    const f = fixture();
    assert(Number.isSafeInteger(R.MAX_REVIEW_BYTES) && R.MAX_REVIEW_BYTES > 0);
    assert(Number.isSafeInteger(R.MAX_SUITE_BYTES) && R.MAX_SUITE_BYTES > 0);
    assert(Number.isSafeInteger(R.MAX_FILES) && R.MAX_FILES > 0);
    for (const [name, bytes] of [
      ['empty-review', ' \n'], ['invalid-review', Buffer.from([0xff])],
      ['large-review', Buffer.alloc(R.MAX_REVIEW_BYTES + 1, 65)],
    ]) assert.throws(() => R.readReview(put(f.dir, name, bytes)));
    const hard = path.join(f.dir, 'linked-review'); fs.linkSync(f.reviewFile, hard);
    assert.throws(() => R.readReview(hard));
    const oversized = put(f.author, `${f.suite}/oversized.bin`, Buffer.alloc(R.MAX_SUITE_BYTES + 1));
    assert.throws(() => R.inspectSuite(f.author, f.built.id)); fs.unlinkSync(oversized);
    const crowded = [];
    for (let n = 0; n <= R.MAX_FILES; n++) crowded.push(put(f.author, `${f.suite}/entry-${n}.txt`, 'x'));
    assert.throws(() => R.inspectSuite(f.author, f.built.id));
    for (const file of crowded) fs.unlinkSync(file);
    const outside = path.join(f.dir, 'outside'); fs.mkdirSync(outside);
    put(outside, 'foreign.txt', 'must not enter the suite fingerprint');
    fs.symlinkSync(outside, path.join(f.author, f.suite, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => R.inspectSuite(f.author, f.built.id));
  });

  check('failed or incomplete authors stop before proof and preserve prior candidate evidence', () => {
    for (const launchResult of [{ status: 2, stderr: 'correction could not complete' },
      { status: 0, stdout: '{"type":"result","subtype":"success"}' }]) {
      const f = fixture(); const pinned = revision(f); const before = digestTree(f.old.container);
      const r = execute(f, pinned, () => launchResult);
      assert.strictEqual(r.result.ok, false); assert.strictEqual(r.authors, 1); assert.strictEqual(r.gates, 0);
      assert.strictEqual(digestTree(f.old.container), before);
      assert(!r.lines.some(line => /Outcome: fully proven|freeze\.js commit/.test(line)));
    }
  });

  check('an author product write or failed fresh gate cannot claim the old proof as success', () => {
    const outside = fixture(); const pin = revision(outside); const oldBefore = digestTree(outside.old.container);
    const bad = execute(outside, pin, () => {
      put(outside.author, 'src/value.txt', 'unauthorized product edit\n');
      return { status: 0, stdout: 'done' };
    });
    assert.strictEqual(bad.result.ok, false); assert.strictEqual(bad.authors, 1); assert.strictEqual(bad.gates, 0);
    assert.strictEqual(digestTree(outside.old.container), oldBefore);
    const f = fixture(); const pinned = revision(f); const before = digestTree(f.old.container);
    const red = execute(f, pinned, () => {
      put(f.author, `${f.suite}/test.js`, correctedTest); return { status: 0, stdout: 'done' };
    }, () => ({ status: 1, stdout: 'corrected acceptance still fails' }));
    assert.strictEqual(red.result.ok, false); assert.strictEqual(red.authors, 1); assert.strictEqual(red.gates, 1);
    assert.strictEqual(digestTree(f.old.container), before);
    assert.notStrictEqual(JSON.parse(fs.readFileSync(path.join(red.prepared.container, P.MARKER))).status, 'proven');
    assert(!red.lines.some(line => /Outcome: fully proven|freeze\.js commit/.test(line)));
  });

  check('managed author prompt uses the allowed verifier while the operator retains its gate command', () => {
    const f = fixture(); const S = require('../../scripts/spec-brief');
    const ctx = { cfg: f.built.cfg, id: f.built.id, suiteId: f.built.id, data: f.built.issue,
      folder: f.built.folder, branch: f.built.branch, policy: f.built.policy, example: null,
      repoRoot: f.target, state: { local: 'absent' } };
    const operator = S.writeBrief(ctx).join('\n');
    const managed = S.writeBrief({ ...ctx, managedAuthor: true }).join('\n');
    assert(operator.includes('node scripts/freeze-gate.js'), 'operator still gets the canonical gate command');
    assert(!managed.includes('node scripts/freeze-gate.js'), 'managed author is not instructed to request forbidden host execution');
    assert(managed.includes(`${f.built.policy.verifyCommand} ${f.suite}/`));
    assert(managed.includes(f.built.criteria.text));
    let invocation = null;
    A.launchAuthor({ ...f.built, text: operator, authorText: managed }, 'fixture-model', (_cmd, _args, opts) => {
      invocation = opts; return { status: 0, stdout: 'controlled provider completion' };
    });
    assert.strictEqual(invocation.input, `${managed}\n`, 'actual launcher selects the managed prompt');
  });
} finally {
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  for (const [key, value] of Object.entries(originalEnv)) process.env[key] = value;
  const resolved = path.resolve(tmp); assert.strictEqual(path.dirname(resolved), path.resolve(os.tmpdir()));
  assert(path.basename(resolved).startsWith('author-revision-review-'));
  fs.rmSync(resolved, { recursive: true, force: true });
}
