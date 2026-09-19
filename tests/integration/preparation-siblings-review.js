#!/usr/bin/env node
// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0
'use strict';

// Unfrozen regression for the preparation pre-manifest guard. Real supervisor leases/grants,
// child admission, execute(), worker-start production and state readers are used. Only issue,
// integration and external author/proof process boundaries use deterministic local fixtures.
// No model, Docker, Beads service, network, or real target authority is involved.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const ROOT = path.resolve(__dirname, '..', '..');
const S = require(path.join(ROOT, 'runner/supervisor'));
const L = require(path.join(ROOT, 'runner/lock'));
const State = require(path.join(ROOT, 'runner/preparation-state'));
const P = require(path.join(ROOT, 'scripts/prepare-batch'));

// Serialized into a genuine separate preparation coordinator process, so the redeemed PID
// really differs from both the supervisor and the external worker's PID.
async function coordinator() {
  const fs = require('fs'), path = require('path'), cp = require('child_process');
  const input = JSON.parse(process.argv[1]);
  const P = require(path.join(input.repo, 'scripts/prepare-batch'));
  const cfg = { targetRepoPath: input.target, allowHalfProven: false, model: 'unused' };
  const lines = [];
  const workerProgram = [
    'const fs=require("fs");',
    'const input=JSON.parse(process.argv[1]);',
    'process.stdin.resume();',
    'const deadline=Date.now()+30000;',
    'function finish(){console.log(JSON.stringify({ok:true,outcome:"proven-at-base"}));process.exit(0);}',
    'function poll(){if(!input.hold||fs.existsSync(input.release))return finish();',
    ' if(Date.now()>deadline)process.exit(70); setTimeout(poll,15);}',
    'process.stdin.on("end",()=>{fs.writeFileSync(input.trace,String(process.pid));poll();});',
  ].join('\n');
  const code = await P.execute({ mode: 'start', batch: input.batch, config: input.config,
    issues: [input.issue], concurrency: 1 }, {
    out: line => lines.push(line), err: line => lines.push(line),
  }, {
    preparationRoot: () => input.state,
    loadConfig: () => cfg,
    inspectIntegration: () => ({ ok: true, branch: 'main', head: 'f'.repeat(40) }),
    resolveDesign: () => ({ ok: true, commit: 'f'.repeat(40), refs: [], reasons: [] }),
    readyQueue: () => ({ ok: true, issues: [] }),
    buildBrief: () => {
      fs.writeFileSync(input.snapshot, 'snapshot reached\n');
      return { ok: true, id: input.issue, state: 'write', branch: 'main', text: 'fixture', cfg,
        policy: { verifyCommand: 'unused', frozenPaths: [] },
        folder: { dir: input.folder, branch: 'freeze-' + input.issue, exists: true },
        criteria: { source: 'structured', sha256: 'a'.repeat(64), text: '1. fixture' },
        issue: { id: input.issue, title: input.issue, dependencies: [] } };
    },
    spawn: (_command, _args, options) => cp.spawn(process.execPath,
      ['-e', workerProgram, JSON.stringify(input)], { ...options, detached: true }),
  });
  console.log(JSON.stringify({ code, lines }));
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) {
  const end = Date.now() + 10000;
  while (Date.now() < end) { const value = fn(); if (value) return value; await delay(15); }
  throw new Error('timed out: ' + label);
}
function start(input, authority) {
  const child = cp.spawn(process.execPath, ['-e', `(${coordinator.toString()})().catch(e=>{console.error(e.stack);process.exit(1);});`,
    JSON.stringify(input)], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PIPELINE_CHILD_AUTHORITY: authority } });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  return { child, done };
}
function grant(lease, batch, issue, file) {
  const result = S.grant(lease, { scope: 'preparation', batch, issueId: issue, ttlMs: 60000 });
  assert(result.ok, JSON.stringify(result));
  fs.writeFileSync(file, JSON.stringify(result.authority));
  return result.authority;
}
function replaceStarted(state, batch, issue, change) {
  const record = State.readWorkerRecords(state, batch, issue)[0].started;
  change(record);
  delete record.recordHash;
  record.recordHash = State.canonicalHash(record);
  const file = path.join(state, batch, 'workers', issue, record.nonce + '.started.json');
  fs.writeFileSync(file, State.canonicalStringify(record) + '\n');
}
function stillOwned(identity) {
  if (!L.isHolderLive(identity)) return false;
  const current = identity && S.preparationProcessIdentity(identity.pid);
  return current && current.processStart === identity.processStart && L.isHolderLive(identity);
}

(async () => {
  const world = fs.mkdtempSync(path.join(os.tmpdir(), 'preparation-siblings-review-'));
  const saved = process.env.PIPELINE_GLOBAL_LOCK_DIR;
  process.env.PIPELINE_GLOBAL_LOCK_DIR = path.join(world, 'authority');
  const target = path.join(world, 'target');
  const observer = path.join(world, 'pipeline');
  fs.mkdirSync(target); fs.mkdirSync(observer);
  const held = S.acquire(observer, target, 'siblings-review-owner');
  assert(held.ok, JSON.stringify(held));
  const children = [], workers = [], releases = [], restorations = [];
  let checks = 0;
  try {
    for (const scenario of ['live', 'no-link', 'malformed', 'identity-missing', 'recycled-pid', 'recycled-parent', 'foreign', 'settled', 'dead-coordinator', 'dead-worker']) {
      const dir = path.join(world, scenario); fs.mkdirSync(dir);
      const state = path.join(dir, 'state');
      const alpha = { repo: ROOT, target, state, batch: 'alpha-' + scenario, issue: 'alpha-' + scenario,
        config: path.join(dir, 'run.json'), folder: path.join(dir, 'author'), hold: true,
        trace: path.join(dir, 'a-worker'), snapshot: path.join(dir, 'a-snapshot'), release: path.join(dir, 'release') };
      fs.mkdirSync(alpha.folder);
      releases.push(alpha.release);
      const alphaAuthorityFile = path.join(dir, 'alpha.authority.json');
      const alphaAuthority = grant(held.lease, alpha.batch, alpha.issue, alphaAuthorityFile);
      const a = start(alpha, alphaAuthorityFile); children.push(a);
      const initial = await until(() => {
        try {
          const row = State.readWorkerRecords(state, alpha.batch, alpha.issue)[0];
          return row && !row.result && fs.existsSync(alpha.trace) ? row.started : null;
        } catch { return null; }
      }, scenario + ' genuine worker start');
      workers.push(initial.process);
      assert.strictEqual(initial.data.supervisor.nonce, alphaAuthority.nonce, 'actual runWorker producer must persist its admitted grant');
      assert.strictEqual(initial.data.supervisor.coordinator.pid, a.child.pid);
      assert.notStrictEqual(initial.pid, a.child.pid, 'worker and coordinator must be distinct real processes');
      assert.strictEqual(P.unresolvedWorkers(state, State, target).workers.length, 1,
        'standalone/legacy caller must continue to see the unmatched worker');

      let foreign = null;
      if (scenario === 'no-link') replaceStarted(state, alpha.batch, alpha.issue, r => { delete r.data.supervisor; });
      if (scenario === 'malformed') {
        const file = path.join(state, alpha.batch, 'workers', alpha.issue, initial.nonce + '.started.json');
        fs.writeFileSync(file, '{malformed');
      }
      if (scenario === 'identity-missing') replaceStarted(state, alpha.batch, alpha.issue, r => { r.process = { pid: r.pid }; });
      if (scenario === 'recycled-pid') {
        assert(L.isHolderLive(initial.process), 'PID-only liveness must still be true for this negative control');
        replaceStarted(state, alpha.batch, alpha.issue, r => { r.process.processStart = '1'; });
      }
      let restoreParent = null;
      if (scenario === 'recycled-parent') {
        const file = path.join(S.supervisorDir(target), 'lease.json');
        const original = fs.readFileSync(file);
        const changed = JSON.parse(original);
        changed.preparationProcess.processStart = '1';
        delete changed.recordHash; changed.recordHash = State.canonicalHash(changed);
        fs.writeFileSync(file, JSON.stringify(changed));
        restoreParent = () => fs.writeFileSync(file, original);
        restorations.push(restoreParent);
        assert.strictEqual(S.leaseHolder(target).live, true,
          'the unchanged conservative lock API must still refuse takeover of this live PID');
      }
      if (scenario === 'foreign') {
        const other = path.join(dir, 'other-target'); fs.mkdirSync(other);
        foreign = { target: other, held: S.acquire(observer, other, 'foreign-owner') };
        assert(foreign.held.ok);
        const authority = grant(foreign.held.lease, alpha.batch, alpha.issue, path.join(dir, 'foreign.authority.json'));
        assert(S.admit(authority, { targetRepoPath: other, scope: 'preparation' }).ok);
        foreign.nonce = authority.nonce;
        replaceStarted(state, alpha.batch, alpha.issue, r => { r.data.supervisor.nonce = authority.nonce; });
      }
      if (scenario === 'settled') assert(S.settle(held.lease, alphaAuthority.nonce, { outcome: 'complete' }).ok);
      if (scenario === 'dead-coordinator') {
        a.child.kill('SIGKILL'); await a.done;
        assert(L.isHolderLive(initial.process), 'external worker must still be live after its coordinator dies');
      }
      if (scenario === 'dead-worker') {
        const ended = cp.spawnSync(process.execPath, ['-e',
          'console.log(JSON.stringify(require(process.argv[1]).preparationProcessIdentity()));', path.join(ROOT, 'runner/supervisor')],
        { encoding: 'utf8', windowsHide: true });
        assert.strictEqual(ended.status, 0, ended.stderr);
        const identity = JSON.parse(ended.stdout);
        assert(!L.isHolderLive(identity), 'negative control must use a process that has actually exited');
        replaceStarted(state, alpha.batch, alpha.issue, r => { r.pid = identity.pid; r.process = identity; });
      }

      const beta = { ...alpha, batch: 'beta-' + scenario, issue: 'beta-' + scenario, hold: false,
        folder: path.join(dir, 'beta-author'), trace: path.join(dir, 'b-worker'), snapshot: path.join(dir, 'b-snapshot') };
      fs.mkdirSync(beta.folder);
      const betaAuthorityFile = path.join(dir, 'beta.authority.json');
      const betaAuthority = grant(held.lease, beta.batch, beta.issue, betaAuthorityFile);
      const before = fs.readFileSync(path.join(state, alpha.batch, 'workers', alpha.issue, initial.nonce + '.started.json'));
      const b = start(beta, betaAuthorityFile); children.push(b);
      const finished = await b.done;
      assert.strictEqual(finished.code, 0, finished.stderr);
      const result = JSON.parse(finished.stdout.trim());
      assert.strictEqual(result.code, scenario === 'live' ? 0 : P.EXIT_ATTENTION, JSON.stringify(result));
      for (const file of [beta.snapshot, beta.trace, path.join(state, beta.batch, 'manifest.json')]) {
        assert.strictEqual(fs.existsSync(file), scenario === 'live', 'pre-manifest boundary: ' + file);
      }
      assert(before.equals(fs.readFileSync(path.join(state, alpha.batch, 'workers', alpha.issue, initial.nonce + '.started.json'))),
        'classification must not rewrite sibling evidence');
      if (restoreParent) restoreParent();
      assert(S.settle(held.lease, betaAuthority.nonce, { outcome: 'complete' }).ok);
      fs.writeFileSync(alpha.release, 'release');
      await a.done;
      await until(() => !stillOwned(initial.process), 'owned worker exit');
      // Fault cases deliberately prevent a normal result from clearing their uncertainty.
      const markers = L.listPreparationUncertain(target);
      if (markers.some(marker => marker.nonce === initial.nonce)) L.clearPreparationUncertain(held.lease.ownership, initial.nonce);
      if (scenario !== 'settled') assert(S.settle(held.lease, alphaAuthority.nonce, { outcome: 'complete' }).ok);
      if (foreign) {
        assert(S.settle(foreign.held.lease, foreign.nonce, { outcome: 'complete' }).ok);
        S.release(observer, foreign.target, foreign.held.lease);
      }
      checks += 1;
      console.log('PASS ' + scenario + ': actual execute pre-manifest sibling classification');
    }
    console.log(checks + '/' + checks + ' preparation sibling scenarios passed');
  } finally {
    for (const restore of restorations) restore();
    for (const file of releases) { try { fs.writeFileSync(file, 'release'); } catch {} }
    for (const child of children) { if (child.child.exitCode === null) { try { child.child.kill('SIGKILL'); } catch {} } }
    for (const identity of workers) { if (stillOwned(identity)) { try { process.kill(identity.pid, 'SIGKILL'); } catch {} } }
    await Promise.all(children.map(child => child.done.catch(() => null)));
    S.release(observer, target, held.lease);
    if (saved === undefined) delete process.env.PIPELINE_GLOBAL_LOCK_DIR;
    else process.env.PIPELINE_GLOBAL_LOCK_DIR = saved;
    fs.rmSync(world, { recursive: true, force: true });
  }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
