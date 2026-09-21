#!/usr/bin/env node
// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0
'use strict';

// Real local Git fixtures; gates are injected to isolate candidate adoption from Docker.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const P = require('../../scripts/prove-tests');
const C = require('../../scripts/proof-candidate');
const B = require('../../scripts/prepare-batch');
const W = require('../../scripts/prepare-batch-worker');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'proof-candidate-review-'));
const originalEnv = { ...process.env };
let sequence = 0;

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', timeout: 60000, windowsHide: true, ...options });
}
function git(root, ...args) {
  const result = run('git', ['-c', 'core.autocrlf=false', '-c', `safe.directory=${root}`, ...args], { cwd: root });
  assert.strictEqual(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return String(result.stdout || '');
}
function put(root, rel, data) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
}
function digestTree(root) {
  const rows = [];
  function visit(dir, prefix) {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name); const rel = prefix ? `${prefix}/${name}` : name;
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) rows.push([rel, 'link', fs.readlinkSync(file)]);
      else if (stat.isDirectory()) { rows.push([rel, 'directory']); visit(file, rel); }
      else rows.push([rel, stat.mode & 0o777, crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')]);
    }
  }
  visit(root, '');
  return JSON.stringify(rows);
}
function fixture() {
  const dir = path.join(tmp, `case-${++sequence}`);
  const target = path.join(dir, 'target'); const author = path.join(dir, 'author');
  fs.mkdirSync(target, { recursive: true });
  put(target, 'pipeline.config.json', JSON.stringify({ defaultBranch: 'main',
    verifyCommand: 'sh tools/accept.sh', frozenPaths: ['tools/accept.sh'] }));
  put(target, 'tools/accept.sh', '#!/bin/sh\nexit 0\n');
  put(target, 'tests/acceptance/_control/pass.js', '// existing frozen control\n');
  put(target, 'src/value.txt', 'red\n');
  put(target, 'src/remove.txt', 'remove me\n');
  put(target, 'src/script.sh', '#!/bin/sh\nprintf old\\n\n');
  git(target, 'init', '-q', '-b', 'main');
  git(target, 'config', 'user.name', 'candidate fixture');
  git(target, 'config', 'user.email', 'fixture@example.invalid');
  git(target, 'config', 'core.filemode', 'false');
  git(target, 'add', '-A'); git(target, 'commit', '-qm', 'base');
  git(dir, 'clone', '--quiet', target, author);
  const suiteRel = 'tests/acceptance/reuse-case';
  put(author, `${suiteRel}/test.js`, '// original author fixture\nthrow Error("incorrect assertion");\n');
  const built = { ok: true, id: 'reuse-case', state: 'freeze', folder: { dir: author, exists: true },
    cfg: { targetRepoPath: target, image: 'fixture:local', wallClockMinutes: 1,
      model: 'fixture-model', testProbeModel: 'fixture-model', testProbeAttempts: 3 },
    policy: { frozenPaths: ['tools/accept.sh'] } };
  const old = P.prepareProbe(built, 'fixture-model', run, dir);
  assert(old.ok, old.error);
  git(old.probe, 'config', 'core.filemode', 'false');
  put(old.probe, 'src/value.txt', 'green\n');
  put(old.probe, 'src/binary.bin', Buffer.from([0, 255, 13, 10, 0, 128, 65]));
  put(old.probe, 'src/script.sh', '#!/bin/sh\nprintf "candidate\\n"\r\n');
  git(old.probe, 'add', '--', 'src/script.sh', 'src/binary.bin');
  git(old.probe, 'update-index', '--chmod=+x', '--', 'src/script.sh');
  fs.unlinkSync(path.join(old.probe, 'src/remove.txt'));
  put(old.container, 'prior-result.json', JSON.stringify({ outcome: 'unproven', kind: 'agent', phase: 'proof' }));
  put(author, `${suiteRel}/test.js`, '// approved assertion correction\nif (require("fs").readFileSync("src/value.txt", "utf8") !== "green\\n") throw Error("red");\n');
  return { dir, target, author, built, old, suiteRel };
}
function selector(f) {
  const inspected = C.inspectCandidate(f.built, f.old.probe, P, run);
  assert.match(inspected.hash, /^[a-f0-9]{64}$/);
  return { path: f.old.probe, hash: inspected.hash };
}
function prove(f, selected, gate) {
  let launches = 0; let gates = 0; let prepared = null;
  const result = P.proveTests(f.built, 'fixture-model', {
    candidateProbe: selected, runSync: run, tempRoot: f.dir,
    launchProbe: () => { launches++; throw Error('candidate reuse launched a model'); },
    runGate: (built, fresh) => { gates++; prepared = fresh; return gate(built, fresh); },
  });
  assert.strictEqual(launches, 0, 'no model launch, including after refusal or a failed gate');
  return { result, gates, prepared };
}
function check(name, body) { body(); console.log(`PASS ${name}`); }

try {
  const gitconfig = path.join(tmp, 'gitconfig'); fs.writeFileSync(gitconfig, '');
  for (const name of Object.keys(process.env)) {
    if (/^(GIT_|PIPELINE_|FREEZE_GATE_|NODE_OPTIONS$|NODE_TEST_CONTEXT$)/.test(name)) delete process.env[name];
  }
  process.env.GIT_CONFIG_GLOBAL = gitconfig; process.env.GIT_CONFIG_SYSTEM = gitconfig;
  process.env.GIT_CONFIG_NOSYSTEM = '1'; process.env.GIT_TERMINAL_PROMPT = '0';
  process.env.BD_SKIP_AUTO_PUSH = '1'; process.env.BD_SKIP_AUTO_PULL = '1';

  check('fresh proof reuses exact candidate bytes and modes, with corrected suites and no model; old evidence survives', () => {
    const f = fixture();
    // An ordinary cancelled attempt may have removed its baseline. Adoption does not rewrite it.
    P.removeOwnedPath(f.old.container, f.old.baseline);
    const selected = selector(f); const before = digestTree(f.old.container);
    const result = prove(f, selected, (built, fresh) => {
      assert.notStrictEqual(fresh.container, f.old.container);
      assert.strictEqual(fresh.head, f.old.head);
      assert.strictEqual(fs.readFileSync(path.join(fresh.baseline, 'src/value.txt'), 'utf8'), 'red\n');
      assert.strictEqual(fs.readFileSync(path.join(fresh.probe, 'src/value.txt'), 'utf8'), 'green\n');
      assert(fs.existsSync(path.join(fresh.baseline, 'src/remove.txt')));
      assert(!fs.existsSync(path.join(fresh.probe, 'src/remove.txt')));
      for (const rel of ['src/binary.bin', 'src/script.sh']) {
        assert(fs.readFileSync(path.join(fresh.probe, rel)).equals(fs.readFileSync(path.join(f.old.probe, rel))));
      }
      const mode = git(fresh.probe, 'ls-files', '--stage', '--', 'src/script.sh');
      assert.match(mode, /^100755 /);
      assert.match(git(fresh.baseline, 'ls-files', '--stage', '--', 'src/script.sh'), /^100644 /);
      for (const root of [fresh.baseline, fresh.probe]) {
        assert(fs.readFileSync(path.join(root, f.suiteRel, 'test.js')).equals(fs.readFileSync(path.join(f.author, f.suiteRel, 'test.js'))));
      }
      assert.strictEqual(fresh.candidateReuse.sourceHash, selected.hash);
      return { status: 0, stdout: 'RED baseline, GREEN candidate; deterministic fixture gate' };
    });
    assert(result.result.ok, result.result.error); assert.strictEqual(result.gates, 1);
    assert.strictEqual(digestTree(f.old.container), before, 'old probe, marker and prior result remain byte/mode-identical');
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(result.prepared.container, P.MARKER))).status, 'proven');
  });

  check('wrong selector, repository, issue, author worktree and base refuse before a gate', () => {
    const variants = [
      f => ({ path: f.old.probe, hash: '0'.repeat(64) }),
      f => { f.built.cfg.targetRepoPath = f.author; },
      f => { f.built.id = 'different-issue'; },
      f => { f.built.folder = { dir: f.target, exists: true }; },
      f => { git(f.author, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'different base'); },
    ];
    for (const mutate of variants) {
      const f = fixture(); const selected = selector(f); const before = digestTree(f.old.container);
      const chosen = mutate(f) || selected;
      const result = prove(f, chosen, () => { throw Error('invalid candidate reached gate'); });
      assert.strictEqual(result.result.ok, false); assert.strictEqual(result.gates, 0);
      assert.strictEqual(digestTree(f.old.container), before);
    }
  });

  check('old-suite, verifier and configuration tampering refuse candidate inspection', () => {
    for (const rel of ['tests/acceptance/reuse-case/test.js', 'tools/accept.sh', 'pipeline.config.json']) {
      const f = fixture(); put(f.old.probe, rel, 'tampered protected bytes\n');
      assert.throws(() => C.inspectCandidate(f.built, f.old.probe, P, run));
    }
  });

  check('unsupported indexed modes and linked product paths cannot become candidate files', () => {
    const f = fixture();
    const blob = git(f.old.probe, 'hash-object', '-w', '--stdin');
    git(f.old.probe, 'update-index', '--add', '--cacheinfo', `120000,${blob.trim()},src/link`);
    put(f.old.probe, 'src/link', 'value.txt');
    assert.throws(() => C.inspectCandidate(f.built, f.old.probe, P, run));
    const linked = fixture(); const outside = path.join(linked.dir, 'outside'); fs.mkdirSync(outside);
    put(outside, 'secret.txt', 'must never be copied\n');
    fs.symlinkSync(outside, path.join(linked.old.probe, 'src/linked'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => C.inspectCandidate(linked.built, linked.old.probe, P, run));
  });

  check('product bytes and Git modes changed after inspection invalidate the explicit selector', () => {
    for (const mutate of [
      f => put(f.old.probe, 'src/value.txt', 'different candidate\n'),
      f => git(f.old.probe, 'update-index', '--chmod=-x', '--', 'src/script.sh'),
    ]) {
      const f = fixture(); const selected = selector(f); mutate(f);
      const before = digestTree(f.old.container);
      const result = prove(f, selected, () => { throw Error('changed source reached gate'); });
      assert.strictEqual(result.result.ok, false); assert.strictEqual(result.gates, 0);
      assert.strictEqual(digestTree(f.old.container), before);
    }
  });

  check('source or adopted product and non-product changes during the gate prevent a proven result', () => {
    for (const source of [false, true]) {
      for (const rel of ['src/value.txt', 'README.md']) {
        const f = fixture(); const selected = selector(f);
        const result = prove(f, selected, (_built, fresh) => {
          put(source ? f.old.probe : fresh.probe, rel, 'changed during verification\n');
          return { status: 0, stdout: 'gate passed before mutation was detected' };
        });
        assert.strictEqual(result.result.ok, false, `${source ? 'source' : 'adopted'} ${rel} changed during gate`);
        assert.strictEqual(result.gates, 1);
        assert.notStrictEqual(JSON.parse(fs.readFileSync(path.join(result.prepared.container, P.MARKER))).status, 'proven');
      }
    }
  });

  check('a failed deterministic gate never falls back to a model or alters prior evidence', () => {
    const f = fixture(); const selected = selector(f); const before = digestTree(f.old.container);
    const result = prove(f, selected, () => ({ status: 1, stdout: 'candidate fails the corrected suite' }));
    assert.strictEqual(result.result.ok, false); assert.strictEqual(result.gates, 1);
    assert.strictEqual(digestTree(f.old.container), before);
    assert.notStrictEqual(JSON.parse(fs.readFileSync(path.join(result.prepared.container, P.MARKER))).status, 'proven');
  });

  check('candidate selection is explicit and proof-only at CLI and worker boundaries', () => {
    const hash = 'a'.repeat(64); const selected = { path: path.join(tmp, 'candidate'), hash };
    const prefix = ['retry', 'fixture-batch', 'reuse-case'];
    const pair = ['--candidate-probe', selected.path, '--candidate-hash', hash];
    const parsed = B.parseArgs([...prefix, ...pair]);
    assert(!parsed.error, parsed.error);
    for (const args of [
      [...prefix, '--candidate-probe', selected.path], [...prefix, '--candidate-hash', hash],
      [...prefix, 'other-issue', ...pair], [...prefix, ...pair, '--resume-partial'],
      ['resume', 'fixture-batch', ...pair], [...prefix, '--candidate-probe', selected.path, '--candidate-hash', 'wrong'],
    ]) assert(B.parseArgs(args).error, `accepted invalid candidate invocation ${args.join(' ')}`);
    const f = fixture(); let observed = null; let validated = 0;
    const result = W.execute({ action: 'proof', built: f.built, candidateProbe: selected }, {
      proveTests: (_built, _model, opts) => { observed = opts; return { ok: true, attempt: 1, probe: 'new-proof', evidence: 'fixture' }; },
      launchAuthor: () => { throw Error('proof-only candidate called author'); },
      validateManagedProbe: (probe, target, ids, head) => {
        validated++;
        assert.strictEqual(probe, 'new-proof'); assert.strictEqual(target, f.target);
        assert.deepStrictEqual(ids, ['reuse-case']); assert.strictEqual(head, f.old.head);
        return { ok: true, managed: true, marker: { issue: 'reuse-case', head, attempts: 1 } };
      },
    });
    assert.strictEqual(result.ok, true, result.error);
    assert.deepStrictEqual(observed.candidateProbe, selected);
    assert.strictEqual(observed.retainedProbe, undefined);
    assert.strictEqual(validated, 1, 'worker still validates a successful managed proof');
    assert(W.validateJob({ action: 'author-proof', built: { ...f.built, state: 'write', text: 'brief' }, candidateProbe: selected }));
    assert(W.validateJob({ action: 'proof', built: f.built, candidateProbe: selected, retainedProbe: 'old' }));
  });
} finally {
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  for (const [key, value] of Object.entries(originalEnv)) process.env[key] = value;
  const resolved = path.resolve(tmp); const parent = path.resolve(os.tmpdir());
  assert.strictEqual(path.dirname(resolved), parent);
  assert(path.basename(resolved).startsWith('proof-candidate-review-'));
  fs.rmSync(resolved, { recursive: true, force: true });
}
