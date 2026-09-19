#!/usr/bin/env node
// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const P = require('../../scripts/prove-tests');
const M = require('../../scripts/probe-mode-intent');
const W = require('../../scripts/prepare-batch-worker');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-mode-intent-test-'));
const originalEnv = { ...process.env };
let sequence = 0;
const requestText = (changes) => `${M.HEADER}\n${JSON.stringify({ version: 1, changes })}`;
const request = (name, mode = '100755') => M.parseRequest(requestText([{ path: name, mode }]));
const script = '#!/bin/sh\nprintf "probe\\n"\n';

function run(cmd, args, options = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 60000, windowsHide: true, ...options });
  return r;
}
function git(root, ...args) {
  const r = run('git', ['-c', 'core.autocrlf=false', '-c', `safe.directory=${root}`, ...args], { cwd: root });
  assert.strictEqual(r.status, 0, `fixture git ${args[0]} failed: ${r.stderr}`);
  return String(r.stdout || '');
}
function index(root, rel) { return git(root, '--literal-pathspecs', 'ls-files', '--stage', '-z', '--', rel); }
function check(name, body) { body(); console.log(`PASS ${name}`); }

function fixture() {
  const dir = path.join(tmp, `case-${++sequence}`);
  const target = path.join(dir, 'target');
  const author = path.join(dir, 'author');
  fs.mkdirSync(path.join(target, 'src'), { recursive: true });
  fs.mkdirSync(path.join(target, 'tools'), { recursive: true });
  fs.mkdirSync(path.join(target, 'tests', 'acceptance', '_control'), { recursive: true });
  fs.writeFileSync(path.join(target, 'pipeline.config.json'), JSON.stringify({
    defaultBranch: 'main', verifyCommand: 'sh tools/accept.sh', frozenPaths: ['tools/accept.sh'],
  }));
  fs.writeFileSync(path.join(target, 'tools', 'accept.sh'),
    '#!/bin/sh\nfor f in "$1"*.sh; do [ -f "$f" ] || exit 2; sh "$f" || exit 1; done\n');
  fs.writeFileSync(path.join(target, 'tests', 'acceptance', '_control', 'pass.sh'), 'exit 0\n');
  fs.writeFileSync(path.join(target, 'src', 'retained.sh'), script);
  fs.writeFileSync(path.join(target, 'src', 'plain.txt'), 'ordinary\n');
  git(target, 'init', '-q', '-b', 'main');
  git(target, 'config', 'user.email', 'fixture@example.invalid');
  git(target, 'config', 'user.name', 'mode intent fixture');
  git(target, 'config', 'core.filemode', 'false');
  git(target, 'add', '-A');
  git(target, 'update-index', '--chmod=+x', '--', 'src/retained.sh');
  git(target, 'commit', '-qm', 'fixture');
  git(dir, 'clone', '--quiet', target, author);
  const suite = path.join(author, 'tests', 'acceptance', 'mode-case');
  fs.mkdirSync(suite);
  fs.writeFileSync(path.join(suite, 'exec.sh'),
    '#!/bin/sh\ntest -x src/new.sh || exit 1\n[ "$(./src/new.sh)" = probe ]\n');
  const built = { id: 'mode-case', folder: { dir: author },
    cfg: { targetRepoPath: target, image: 'fixture:local', wallClockMinutes: 1, testProbeAttempts: 1 },
    policy: { frozenPaths: ['tools/accept.sh'] } };
  const prepared = P.prepareProbe(built, 'fixture-model', run, dir);
  assert(prepared.ok, prepared.error);
  for (const clone of [prepared.baseline, prepared.probe]) git(clone, 'config', 'core.filemode', 'false');
  return { built, prepared };
}

try {
  const cfg = path.join(tmp, 'gitconfig'); fs.writeFileSync(cfg, '');
  for (const name of Object.keys(process.env)) {
    if (/^(GIT_|PIPELINE_|FREEZE_GATE_|NODE_OPTIONS$|NODE_TEST_CONTEXT$)/.test(name)) delete process.env[name];
  }
  process.env.GIT_CONFIG_GLOBAL = cfg; process.env.GIT_CONFIG_SYSTEM = cfg;
  process.env.GIT_CONFIG_NOSYSTEM = '1'; process.env.GIT_TERMINAL_PROMPT = '0';

  check('ordinary final responses and tool/log requests do not create mode intent', () => {
    assert.strictEqual(M.requestFromLaunch('claude', { status: 0, stdout: 'Product implementation is ready.' }), null);
    const text = requestText([{ path: 'src/new.sh', mode: '100755' }]);
    assert.strictEqual(M.requestFromLaunch('claude', { status: 0,
      stdout: JSON.stringify({ type: 'assistant', message: { content: text } }) }), null);
    assert.strictEqual(M.requestFromLaunch('codex', { status: 0, stdout: [
      { type: 'item.completed', item: { type: 'command_execution', aggregated_output: text } },
      { type: 'turn.completed' },
    ].map(JSON.stringify).join('\n') }), null);
    assert.strictEqual(M.requestFromLaunch('claude', { status: 0, stdout: 'done', stderr: text }), null);
    assert.strictEqual(M.requestFromLaunch('claude', { status: 1, stdout: text }), null);
  });
  check('only actual completed provider final responses produce the same strict request', () => {
    const text = requestText([{ path: 'src/new.sh', mode: '100755' }]);
    const expected = request('src/new.sh');
    assert.deepStrictEqual(M.requestFromLaunch('claude', { status: 0, stdout: text.replace(/\n/g, '\r\n') }), expected);
    assert.deepStrictEqual(M.requestFromLaunch('claude', { status: 0,
      stdout: JSON.stringify({ type: 'result', subtype: 'success', result: text }) }), expected);
    assert.deepStrictEqual(M.requestFromLaunch('codex', { status: 0, stdout: [
      { type: 'item.completed', item: { type: 'agent_message', text } }, { type: 'turn.completed' },
    ].map(JSON.stringify).join('\n') }), expected);
    assert.strictEqual(M.requestFromLaunch('codex', { status: 0,
      stdout: JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } }) }), null);
  });
  check('managed Claude envelopes accept only one successful terminal result, including multiline JSON', () => {
    const text = requestText([{ path: 'src/new.sh', mode: '100755' }]);
    const launched = (stdout) => ({ status: 0, stdout, probeResponseFormat: 'claude-json' });
    const result = { type: 'result', subtype: 'success', is_error: false, result: text };
    assert.deepStrictEqual(M.requestFromLaunch('claude', launched(JSON.stringify(result, null, 2))), request('src/new.sh'));
    assert.strictEqual(M.requestFromLaunch('claude', launched(JSON.stringify({ ...result, result: 'Done.',
      messages: [{ type: 'assistant', text }] }))), null);
    for (const stdout of [text, `tool output\n${JSON.stringify(result)}`, JSON.stringify([result]),
      `${JSON.stringify(result)}\n${JSON.stringify(result)}`,
      JSON.stringify({ type: 'assistant', result: text }),
      JSON.stringify({ ...result, subtype: 'error_during_execution' }),
      ...[true, 'true', 1, undefined].map((is_error) => JSON.stringify({ ...result, is_error })),
      JSON.stringify({ ...result, result: null })]) {
      assert.throws(() => M.requestFromLaunch('claude', launched(stdout)), /probe mode intent:/);
    }
    for (const resultText of [`Finished.\n${text}`, `\`\`\`json\n${text}\n\`\`\``, `${text}\n{}`]) {
      assert.throws(() => M.requestFromLaunch('claude', launched(JSON.stringify({ ...result, result: resultText }))));
    }
    try {
      M.requestFromLaunch('claude', launched(JSON.stringify({ ...result, result: `${text}${'x'.repeat(20000)}` })));
      assert.fail('oversized final request was accepted');
    } catch (error) {
      assert.match(error.message, /malformed or oversized/);
      const diagnostic = JSON.parse(error.modeIntentEvidence.split(' ').slice(1).join(' '));
      assert(diagnostic.finalResponse.truncated);
      assert(diagnostic.finalResponse.bytes > M.MAX_REQUEST_BYTES);
      assert(Buffer.byteLength(diagnostic.finalResponse.preview, 'utf8') <= 515);
      assert(error.modeIntentEvidence.length < 4096);
    }
  });
  check('actual managed proof launch requests JSON and consumes only its terminal mode intent', () => {
    for (const useIntent of [false, true]) {
      const native = fixture(); let launches = 0; let gates = 0;
      const baselineIndex = fs.readFileSync(path.join(native.prepared.baseline, '.git', 'index'));
      const text = requestText([{ path: 'src/new.sh', mode: '100755' }]);
      const outcome = P.proveTests(native.built, 'fixture-model', {
        prepareProbe: () => native.prepared,
        runSync: (command, args, opts) => {
          launches += 1;
          assert.strictEqual(command, 'claude');
          assert.strictEqual(args[args.indexOf('--output-format') + 1], 'json');
          assert.strictEqual(args[args.indexOf('--tools') + 1], P.PROBE_TOOLS);
          assert.strictEqual(args[args.indexOf('--disallowedTools') + 1], P.PROBE_DENIED);
          assert(opts.input.includes('Do not wrap a mode request in Markdown fences'));
          fs.writeFileSync(path.join(native.prepared.probe, 'src', 'new.sh'), script);
          return { status: 0, stdout: JSON.stringify({ type: 'result', subtype: 'success', is_error: false,
            result: useIntent ? text : 'Product implementation is ready.',
            messages: [{ type: 'assistant', text }] }), probeResponseFormat: 'untrusted-override' };
        },
        runGate: () => {
          gates += 1;
          assert.strictEqual(index(native.prepared.probe, 'src/new.sh').startsWith('100755 '), useIntent);
          return { status: 0, stdout: 'fixture gate passed' };
        },
      });
      assert(outcome.ok, outcome.error);
      assert.strictEqual(launches, 1); assert.strictEqual(gates, 1);
      assert(baselineIndex.equals(fs.readFileSync(path.join(native.prepared.baseline, '.git', 'index'))));
    }
  });
  check('malformed terminal intent survives actual proof-to-worker failure without retry, mode write or gate', () => {
    const native = fixture(); let launches = 0; let gates = 0;
    const idx = path.join(native.prepared.probe, '.git', 'index');
    const before = fs.readFileSync(idx);
    native.built.state = 'freeze'; native.built.folder.exists = true;
    native.built.cfg.model = 'fixture-model'; native.built.cfg.testProbeAttempts = 3;
    const finalText = `Finished.\n${requestText([{ path: 'src/new.sh', mode: '100755' }])}`;
    const outcome = W.execute({ action: 'proof', built: native.built }, { probeSeams: {
      prepareProbe: () => native.prepared,
      runSync: (command, args) => {
        launches += 1;
        assert.strictEqual(command, 'claude'); assert(args.includes('--output-format'));
        return { status: 0, stdout: JSON.stringify({ type: 'result', subtype: 'success', is_error: false,
          result: finalText, transcript: 'RAW_TRANSCRIPT_MUST_NOT_LEAK' }), stderr: 'STDERR_MUST_NOT_LEAK' };
      },
      runGate: () => { gates += 1; return { status: 0 }; },
    } });
    assert.strictEqual(outcome.ok, false); assert.strictEqual(outcome.kind, 'setup');
    assert.match(outcome.error, /malformed or oversized/);
    const diagnostic = JSON.parse(outcome.evidence.split(' ').slice(1).join(' '));
    assert.strictEqual(diagnostic.format, 'claude-json');
    assert.strictEqual(diagnostic.finalResponse.preview, finalText);
    assert.strictEqual(diagnostic.finalResponse.headerOffset, 'Finished.\n'.length);
    assert.match(diagnostic.finalResponse.sha256, /^[a-f0-9]{64}$/);
    assert(!outcome.evidence.includes('MUST_NOT_LEAK'));
    assert.strictEqual(launches, 1); assert.strictEqual(gates, 0);
    assert(before.equals(fs.readFileSync(idx)));
    assert(!fs.readdirSync(native.prepared.container).some((p) => p.startsWith('.mode-intent-request-')));
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(native.prepared.container, P.MARKER))).status, 'unfinished');
    assert.strictEqual(outcome.resumableProbe, undefined);
  });
  check('bounds, unknown fields, nonregular modes, path syntax and duplicates fail closed', () => {
    for (const name of ['../x', '/tmp/x', 'C:/x', '.git/config', 'src/../x', 'src\\x', '-option', 'src/a\nb']) {
      assert.throws(() => request(name));
    }
    assert.throws(() => request('src/x', '120000'));
    assert.throws(() => M.parseRequest(`${M.HEADER}\n{"version":1,"changes":[],"command":"git"}`));
    assert.throws(() => M.parseRequest(requestText([{ path: 'src/x', mode: '100755' }, { path: 'SRC/X', mode: '100644' }])));
    assert.throws(() => M.parseRequest(requestText(Array.from({ length: M.MAX_CHANGES + 1 }, (_, i) => ({ path: `src/${i}`, mode: '100755' })))));
    assert.throws(() => M.parseRequest(`${M.HEADER}\n${' '.repeat(M.MAX_REQUEST_BYTES)}{}`));
  });

  const f = fixture();
  const { built, prepared } = f;
  const name = 'src/new [literal].sh';
  fs.writeFileSync(path.join(prepared.probe, name), script);
  const baselineIndex = fs.readFileSync(path.join(prepared.baseline, '.git', 'index'));
  const protectedBefore = P.protectedManifest(prepared.probe, built.policy, built.id);
  check('consumer refuses protected paths and validation has no index side effects', () => {
    const before = fs.readFileSync(path.join(prepared.probe, '.git', 'index'));
    for (const bad of ['tools/accept.sh', 'pipeline.config.json', 'tests/acceptance/mode-case/exec.sh']) {
      assert.throws(() => M.applyRequest(built, prepared, request(bad), P.readManagedProbe));
      assert(before.equals(fs.readFileSync(path.join(prepared.probe, '.git', 'index'))));
    }
    const otherTarget = path.join(tmp, 'other-target'); fs.mkdirSync(otherTarget);
    assert.throws(() => M.applyRequest({ ...built, cfg: { ...built.cfg, targetRepoPath: otherTarget } }, prepared, request(name), P.readManagedProbe));
    assert.throws(() => M.applyRequest({ ...built, folder: { dir: otherTarget } }, prepared, request(name), P.readManagedProbe));
  });
  check('explicit intent stages only the named literal file; inherited Git redirection cannot escape', () => {
    const saved = { GIT_DIR: process.env.GIT_DIR, GIT_INDEX_FILE: process.env.GIT_INDEX_FILE, GIT_CONFIG_COUNT: process.env.GIT_CONFIG_COUNT };
    process.env.GIT_DIR = path.join(prepared.baseline, '.git');
    process.env.GIT_INDEX_FILE = path.join(prepared.baseline, '.git', 'index');
    process.env.GIT_CONFIG_COUNT = 'bad';
    let audit;
    try { audit = M.applyRequest(built, prepared, request(name), P.readManagedProbe); }
    finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
    assert(index(prepared.probe, name).startsWith('100755 '));
    assert(index(prepared.probe, 'src/plain.txt').startsWith('100644 '));
    assert(index(prepared.probe, 'src/retained.sh').startsWith('100755 '));
    assert(baselineIndex.equals(fs.readFileSync(path.join(prepared.baseline, '.git', 'index'))));
    assert.deepStrictEqual(P.manifestDifference(protectedBefore, P.protectedManifest(prepared.probe, built.policy, built.id)), []);
    assert(fs.readFileSync(path.join(prepared.probe, name), 'utf8') === script);
    M.verifyApplied(built, prepared, audit, P.readManagedProbe);
    git(prepared.probe, 'update-index', '--chmod=-x', '--', name);
    assert.throws(() => M.verifyApplied(built, prepared, audit, P.readManagedProbe), /Git mode\/blob/);
    const removal = M.applyRequest(built, prepared, request(name, '100644'), P.readManagedProbe);
    M.verifyApplied(built, prepared, removal, P.readManagedProbe);
    assert(index(prepared.probe, name).startsWith('100644 '));
    assert(fs.readdirSync(prepared.container).some((p) => p.startsWith('.mode-intent-request-')));
    assert(!fs.readdirSync(prepared.probe).some((p) => p.startsWith('.mode-intent')));
  });
  check('failed index installation rolls back native mode, preserves index and removes only its own lock', () => {
    const idx = path.join(prepared.probe, '.git', 'index');
    const before = fs.readFileSync(idx);
    const beforeMode = fs.statSync(path.join(prepared.probe, name)).mode;
    const rename = fs.renameSync;
    fs.renameSync = (from, to) => { if (to === idx) throw new Error('injected index installation failure'); return rename(from, to); };
    try { assert.throws(() => M.applyRequest(built, prepared, request(name), P.readManagedProbe), /installation failure/); }
    finally { fs.renameSync = rename; }
    assert(before.equals(fs.readFileSync(idx)));
    assert.strictEqual(fs.statSync(path.join(prepared.probe, name)).mode, beforeMode);
    assert(!fs.existsSync(`${idx}.lock`));
    fs.writeFileSync(`${idx}.lock`, 'another Git owner');
    try {
      assert.throws(() => M.applyRequest(built, prepared, request(name), P.readManagedProbe));
      assert.strictEqual(fs.readFileSync(`${idx}.lock`, 'utf8'), 'another Git owner');
    } finally { fs.unlinkSync(`${idx}.lock`); }
  });
  check('audit failure cannot install modes and cleanup failure cannot disguise successful installation', () => {
    const idx = path.join(prepared.probe, '.git', 'index');
    const before = fs.readFileSync(idx);
    const beforeMode = fs.statSync(path.join(prepared.probe, name)).mode;
    const open = fs.openSync;
    fs.openSync = (file, ...args) => {
      if (String(file).includes('.mode-intent-request-')) throw new Error('injected audit write failure');
      return open(file, ...args);
    };
    try { assert.throws(() => M.applyRequest(built, prepared, request(name), P.readManagedProbe), /audit write failure/); }
    finally { fs.openSync = open; }
    assert(before.equals(fs.readFileSync(idx)));
    assert.strictEqual(fs.statSync(path.join(prepared.probe, name)).mode, beforeMode);
    assert(!fs.existsSync(`${idx}.lock`));
    const remove = fs.rmSync;
    fs.rmSync = (file, ...args) => {
      if (path.basename(String(file)).startsWith('.mode-intent-')) throw new Error('injected scratch cleanup failure');
      return remove(file, ...args);
    };
    let audit;
    try { audit = M.applyRequest(built, prepared, request(name), P.readManagedProbe); }
    finally { fs.rmSync = remove; }
    M.verifyApplied(built, prepared, audit, P.readManagedProbe);
    assert(index(prepared.probe, name).startsWith('100755 '));
  });
  check('Git common-directory redirection is refused before index/object mutation', () => {
    const common = path.join(prepared.probe, '.git', 'commondir');
    fs.writeFileSync(common, path.join(prepared.baseline, '.git'));
    try { assert.throws(() => M.applyRequest(built, prepared, request(name), P.readManagedProbe), /common directory/); }
    finally { fs.unlinkSync(common); }
    assert(baselineIndex.equals(fs.readFileSync(path.join(prepared.baseline, '.git', 'index'))));
  });
  if (process.platform !== 'win32') {
    check('symlink ancestors and files never grant access outside the owned probe', () => {
      const outside = path.join(tmp, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'x'), script);
      fs.symlinkSync(outside, path.join(prepared.probe, 'src', 'linked'));
      assert.throws(() => M.applyRequest(built, prepared, request('src/linked/x'), P.readManagedProbe));
      fs.symlinkSync(path.join(outside, 'x'), path.join(prepared.probe, 'src', 'linked-file'));
      assert.throws(() => M.applyRequest(built, prepared, request('src/linked-file'), P.readManagedProbe));
    });
    check('object-store and index symlinks cannot redirect host mutation into the baseline', () => {
      for (const entry of ['objects', 'index']) {
        const actual = path.join(prepared.probe, '.git', entry);
        const held = `${actual}.fixture-held`;
        fs.renameSync(actual, held);
        fs.symlinkSync(path.join(prepared.baseline, '.git', entry), actual);
        try { assert.throws(() => M.applyRequest(built, prepared, request(name), P.readManagedProbe), /metadata is redirected/); }
        finally { fs.unlinkSync(actual); fs.renameSync(held, actual); }
      }
      const objects = path.join(prepared.probe, '.git', 'objects');
      const fanout = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0')).find((p) => !fs.existsSync(path.join(objects, p)));
      fs.symlinkSync(path.join(prepared.baseline, '.git', 'objects'), path.join(objects, fanout));
      try { assert.throws(() => M.applyRequest(built, prepared, request(name), P.readManagedProbe), /object storage is redirected/); }
      finally { fs.unlinkSync(path.join(objects, fanout)); }
      assert(baselineIndex.equals(fs.readFileSync(path.join(prepared.baseline, '.git', 'index'))));
    });
    check('real native gate distinguishes identical script bytes with and without explicit final-response intent', () => {
      const adapter = path.join(tmp, 'docker-adapter.sh');
      fs.writeFileSync(adapter, '#!/bin/sh\n[ "$1" = rm ] && exit 0\nmount=\nscript=\nwhile [ "$#" -gt 0 ]; do\ncase "$1" in\n-v) mount="${2%%:/workspace}"; shift 2 ;;\n-c) script="$2"; shift 2; break ;;\n*) shift ;;\nesac\ndone\n[ -n "$mount" ] || exit 2\ncd "$mount" || exit 2\nexec sh -c "$script" "$@"\n');
      fs.chmodSync(adapter, 0o755);
      process.env.PIPELINE_TESTING_FREEZE_GATE_SEAM = '1'; process.env.FREEZE_GATE_DOCKER_CMD = adapter;
      for (const useIntent of [false, true]) {
        const native = fixture();
        const before = fs.readFileSync(path.join(native.prepared.baseline, '.git', 'index'));
        const outcome = P.proveTests(native.built, 'fixture-model', {
          prepareProbe: () => native.prepared,
          launchProbe: () => {
            fs.writeFileSync(path.join(native.prepared.probe, 'src', 'new.sh'), script);
            // Apparent native executability alone must not fabricate Git intent.
            fs.chmodSync(path.join(native.prepared.probe, 'src', 'new.sh'), 0o755);
            return { status: 0, stdout: useIntent ? requestText([{ path: 'src/new.sh', mode: '100755' }]) : 'Done.' };
          },
        });
        assert.strictEqual(outcome.ok, useIntent, outcome.error || outcome.evidence);
        assert(before.equals(fs.readFileSync(path.join(native.prepared.baseline, '.git', 'index'))));
        if (useIntent) {
          assert(/real run\s+exit 1/.test(outcome.evidence));
          assert(/probe run\s+exit 0/.test(outcome.evidence));
          assert(index(native.prepared.probe, 'src/new.sh').startsWith('100755 '));
        } else {
          assert(/probe run\s+exit 1/.test(outcome.evidence));
          assert.strictEqual(index(native.prepared.probe, 'src/new.sh'), '');
        }
      }
    });
  } else console.log('SKIP native POSIX materialization and symlink controls on Windows; real Git intent checks still ran');
  console.log('PASS probe mode intent producer/consumer regressions');
} finally {
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  for (const [key, value] of Object.entries(originalEnv)) process.env[key] = value;
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
