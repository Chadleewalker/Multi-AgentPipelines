#!/usr/bin/env node
// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require('../../runner/preparation-state');

let passed = 0;
let failed = 0;
function check(label, condition, detail = '') {
  if (condition) { console.log(`ok - ${label}`); passed += 1; }
  else { console.log(`FAIL - ${label}${detail ? `: ${detail}` : ''}`); failed += 1; }
}
function throws(fn, pattern) {
  try { fn(); return false; } catch (e) { return pattern ? pattern.test(e.message || '') : true; }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'preparation-state-'));
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });
const instant = (n = 0) => () => `2026-08-30T12:00:${String(n).padStart(2, '0')}.000Z`;
const manifestInput = (extra = {}) => ({
  project: 'fixture', runConfig: 'run.config.fixture.json', intent: 'prepare the requested wave',
  issues: [
    { id: 'fixture-a1', title: 'first', priority: 1, dependencies: [] },
    { id: 'fixture-b2', title: 'second', priority: 2, dependencies: ['fixture-a1'] },
  ],
  config: {
    targetRepoPath: 'C:/fixture', targetRepoRemote: 'https://example.invalid/repo.git',
    image: 'fixture:local', hostEnv: { GODOT: 'C:/secret/godot.exe', LICENSE_KEY: 'do-not-store' },
    oauthToken: 'also-secret', concurrency: 3,
  },
  ...extra,
});
const linkDirectory = (target, link) => fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');

// Root selection is deterministic and never derives from cwd.
{
  const aimed = path.join(tmp, 'aimed');
  check('PREPARATION_RUNS_DIR re-aims the state root',
    S.preparationRoot({ PREPARATION_RUNS_DIR: aimed }) === path.resolve(aimed));
  check('a blank root override is treated as unset',
    S.preparationRoot({ PREPARATION_RUNS_DIR: '  ' }).endsWith(path.join('runs', 'preparations')));
}

// Portable identifiers: traversal, Windows devices, trailing punctuation, and case collisions
// must fail on every host, not only on the host whose filesystem happens to reject them.
{
  for (const bad of ['', '.', '..', 'a..b', '../escape', 'a/b', 'a\\b', '-option', 'with space', 'tail.', 'CON', 'nul.txt']) {
    check(`unsafe batch id is refused: ${JSON.stringify(bad)}`, throws(() => S.validateBatchId(bad)));
    check(`unsafe issue id is refused: ${JSON.stringify(bad)}`, throws(() => S.validateIssueId(bad)));
  }
  check('safe hyphenated issue ids are accepted', S.validateIssueId('Junkstronaut_Final-pyx') === 'Junkstronaut_Final-pyx');
  check('safePath refuses traversal even when called independently',
    throws(() => S.safePath(tmp, '..', 'outside'), /escapes/));

  const caseRoot = path.join(tmp, 'case-batch'); fs.mkdirSync(caseRoot);
  fs.mkdirSync(path.join(caseRoot, 'Wave-One'));
  check('case-only batch directory collisions are refused portably',
    throws(() => S.createManifest(caseRoot, 'wave-one', manifestInput(), { now: instant() }), /collision/));
  const issueRoot = path.join(tmp, 'case-issue');
  check('case-only issue ids in one manifest are refused', throws(() => S.createManifest(issueRoot, 'wave',
    manifestInput({ issues: [{ id: 'Issue-A' }, { id: 'issue-a' }] }), { now: instant() }), /case-colliding/));
  const depRoot = path.join(tmp, 'case-dependency');
  check('case-only dependency collisions are refused rather than silently collapsed',
    throws(() => S.createManifest(depRoot, 'wave', manifestInput({
      issues: [{ id: 'Issue-A', dependencies: ['Issue-B', 'issue-b'] }],
    }), { now: instant() }), /case-colliding dependency/));
  check('invalid manifest input creates no preparation root or batch directory', !fs.existsSync(depRoot));
}

// Canonicalisation and redaction: key order is irrelevant, while hostEnv values never reach
// bytes OR the digest (changing only those values leaves the redacted digest unchanged).
{
  check('canonical JSON sorts nested object keys',
    S.canonicalStringify({ z: 1, a: { y: 2, b: 3 } }) === '{"a":{"b":3,"y":2},"z":1}');
  check('canonical hashing is key-order independent',
    S.canonicalHash({ b: 2, a: 1 }) === S.canonicalHash({ a: 1, b: 2 }));
  check('canonical JSON refuses non-finite values and cycles',
    throws(() => S.canonicalStringify({ x: Infinity })) && (() => {
      const x = {}; x.self = x; return throws(() => S.canonicalStringify(x));
    })());
  const one = S.redactConfig({ hostEnv: { GODOT: 'first', TOKEN: 'alpha' }, model: 'opus', password: 'pw' });
  const two = S.redactConfig({ password: 'different', model: 'opus', hostEnv: { TOKEN: 'beta', GODOT: 'second' } });
  const bytes = S.canonicalStringify(one);
  check('hostEnv and secret values are absent from redacted bytes',
    !/first|alpha|\bpw\b/.test(bytes) && /GODOT/.test(bytes) && /<redacted>/.test(bytes), bytes);
  check('hostEnv and secret values cannot affect canonical config hash',
    S.canonicalHash(one) === S.canonicalHash(two));

  const credentialRemoteOne = S.redactConfig({
    targetRepoRemote: 'https://build-user:ghp_TOKENVALUE@example.invalid/org/repo.git',
  });
  const credentialRemoteTwo = S.redactConfig({
    targetRepoRemote: 'https://other-user:other-password@example.invalid/org/repo.git',
  });
  const remoteBytes = S.canonicalStringify(credentialRemoteOne);
  check('URL username, password and token are absent from durable config bytes',
    !/build-user|ghp_TOKENVALUE|other-password/.test(remoteBytes)
      && remoteBytes.includes('https://example.invalid/org/repo.git'));
  check('credential changes cannot affect the durable remote hash',
    S.canonicalHash(credentialRemoteOne) === S.canonicalHash(credentialRemoteTwo));
  check('noncredential remote identity still affects the durable hash',
    S.canonicalHash(credentialRemoteOne) !== S.canonicalHash(S.redactConfig({
      targetRepoRemote: 'https://example.invalid/other/repo.git',
    })));
}

// Immutable manifest allocation, exact reads, and no overwrite after success or a torn start.
const root = path.join(tmp, 'state');
const batch = 'fixture-wave';
const manifest = S.createManifest(root, batch, manifestInput(), { now: instant() });
{
  check('manifest carries a self-verifying hash', /^[a-f0-9]{64}$/.test(manifest.recordHash));
  check('manifest round-trips with normalized dependency order intact',
    S.readManifest(root, batch).issues[1].dependencies[0] === 'fixture-a1');
  const raw = fs.readFileSync(path.join(root, batch, 'manifest.json'), 'utf8');
  check('manifest never persists hostEnv values', !/do-not-store|C:\/secret/.test(raw));
  check('an existing manifest cannot be overwritten',
    throws(() => S.createManifest(root, batch, manifestInput({ intent: 'replacement' }), { now: instant(1) }), /EEXIST|exist/i));

  const tornRoot = path.join(tmp, 'torn-manifest');
  fs.mkdirSync(path.join(tornRoot, 'torn'), { recursive: true });
  fs.writeFileSync(path.join(tornRoot, 'torn', 'manifest.json'), '{"unfinished":');
  check('a torn manifest is visible as malformed, never treated as absent',
    throws(() => S.readManifest(tornRoot, 'torn'), /malformed/));
  check('a torn manifest still owns its batch id and cannot be overwritten',
    throws(() => S.createManifest(tornRoot, 'torn', manifestInput(), { now: instant() }), /EEXIST|exist/i));
}

// Hash-chained immutable events. Temp debris is ignored; visible corruption and chain repair
// attempts both fail closed.
{
  const first = S.appendEvent(root, batch, 'classified', { issueId: 'fixture-a1', state: 'needs-review' }, { now: instant(1) });
  const second = S.appendEvent(root, batch, 'approved', { issueId: 'fixture-a1', state: 'approved' },
    { now: instant(2), expectedPrevHash: first.recordHash });
  check('event sequence links back to the exact predecessor',
    second.seq === 2 && second.prevHash === first.recordHash && S.readEvents(root, batch).length === 2);
  check('an event cannot name an issue outside the immutable roster',
    throws(() => S.appendEvent(root, batch, 'classified', { issueId: 'fixture-z9' }), /outside manifest/));
  const optional = S.appendEvent(root, batch, 'optional-fields',
    { issueId: 'fixture-b2', state: 'pending', absent: undefined },
    { now: instant(2), expectedPrevHash: second.recordHash });
  check('undefined optional fields are omitted before durable hashing',
    !Object.prototype.hasOwnProperty.call(optional.payload, 'absent'));
  check('compare-and-append refuses a stale predecessor',
    throws(() => S.appendEvent(root, batch, 'late', {}, { expectedPrevHash: manifest.recordHash }), /predecessor/));

  const eventsDir = path.join(root, batch, 'events');
  fs.writeFileSync(path.join(eventsDir, '.00000004.json.tmp-dead-process'), '{');
  check('a crash-left event temp is ignored', S.readEvents(root, batch).length === 3);

  const eventOneFile = path.join(eventsDir, '00000001.json');
  const original = fs.readFileSync(eventOneFile, 'utf8');
  const edited = JSON.parse(original); edited.payload.state = 'forged';
  fs.writeFileSync(eventOneFile, JSON.stringify(edited));
  check('editing event content without its hash is detected', !S.deriveState(root, batch).ok);
  fs.writeFileSync(eventOneFile, original);

  const rehashed = JSON.parse(original); rehashed.payload.state = 'forged';
  const body = { ...rehashed }; delete body.recordHash; rehashed.recordHash = S.canonicalHash(body);
  fs.writeFileSync(eventOneFile, JSON.stringify(rehashed));
  check('re-hashing an old event still breaks the successor chain', !S.deriveState(root, batch).ok);
  fs.writeFileSync(eventOneFile, original);
  check('restoring exact immutable bytes restores the verified chain', S.deriveState(root, batch).ok);
}

// Worker starts and results are separately atomic and nonce-bound. An unmatched start is not
// retried by inference: deriveState calls it interrupted-unknown.
{
  const nonceA = 'a'.repeat(32);
  const started = S.writeWorkerStarted(root, batch, 'fixture-b2', {
    nonce: nonceA, phase: 'author', pid: 1234, data: { hostEnv: { GODOT: 'must-not-leak' } },
  }, { now: instant(3) });
  check('worker start is immutable and self-hashed', started.nonce === nonceA && /^[a-f0-9]{64}$/.test(started.recordHash));
  check('a started worker with no result derives as interrupted-unknown',
    S.deriveState(root, batch).issues.find((i) => i.id === 'fixture-b2').state === 'interrupted-unknown');
  check('worker start data redacts hostEnv values',
    !fs.readFileSync(path.join(root, batch, 'workers', 'fixture-b2', `${nonceA}.started.json`), 'utf8').includes('must-not-leak'));
  check('the same nonce cannot overwrite a worker start',
    throws(() => S.writeWorkerStarted(root, batch, 'fixture-b2', { nonce: nonceA }), /EEXIST|exist/i));
  check('a result with an unknown nonce is refused',
    throws(() => S.writeWorkerResult(root, batch, 'fixture-b2', { nonce: 'b'.repeat(32), outcome: 'proven' }), /cannot (?:read|inspect)/));
  check('a nonce cannot bind a result to another issue',
    throws(() => S.writeWorkerResult(root, batch, 'fixture-a1', { nonce: nonceA, outcome: 'proven' }), /cannot (?:read|inspect)/));

  const result = S.writeWorkerResult(root, batch, 'fixture-b2', {
    nonce: nonceA, outcome: 'preliminarily-proven', exitCode: 0, data: { probe: 'C:/probe' },
  }, { now: instant(4) });
  check('worker result binds to the immutable start hash', result.startHash === started.recordHash);
  check('the same nonce cannot overwrite a worker result',
    throws(() => S.writeWorkerResult(root, batch, 'fixture-b2', { nonce: nonceA, outcome: 'failed' }), /EEXIST|exist/i));
  const records = S.readWorkerRecords(root, batch, 'fixture-b2');
  check('worker start and result round-trip as one attempt', records.length === 1 && records[0].result.outcome === 'preliminarily-proven');

  const resultFile = path.join(root, batch, 'workers', 'fixture-b2', `${nonceA}.result.json`);
  const saved = fs.readFileSync(resultFile, 'utf8');
  const forged = JSON.parse(saved); forged.startHash = 'f'.repeat(64);
  const resultBody = { ...forged }; delete resultBody.recordHash; forged.recordHash = S.canonicalHash(resultBody);
  fs.writeFileSync(resultFile, JSON.stringify(forged));
  check('even a re-hashed result cannot change its nonce/start binding',
    throws(() => S.readWorkerRecords(root, batch, 'fixture-b2'), /does not match start/));
  fs.writeFileSync(resultFile, saved);

  const workerDir = path.dirname(resultFile);
  fs.writeFileSync(path.join(workerDir, '.dead-worker.tmp-123'), '{');
  check('a crash-left worker temp is ignored', S.readWorkerRecords(root, batch, 'fixture-b2').length === 1);
}

// Attempt chronology is an immutable generation, never lexical nonce order. The newer nonce is
// deliberately lexically smaller than the older one so the historical bug has a falsifier.
{
  const chronologicalRoot = path.join(tmp, 'chronological');
  S.createManifest(chronologicalRoot, 'retry-wave', manifestInput({
    issues: [{ id: 'fixture-retry', title: 'retry ordering', dependencies: [] }],
  }), { now: instant(5) });
  const oldNonce = 'f'.repeat(32); const newNonce = '0'.repeat(32);
  const oldStart = S.writeWorkerStarted(chronologicalRoot, 'retry-wave', 'fixture-retry',
    { nonce: oldNonce, phase: 'author-proof' }, { now: instant(6) });
  S.writeWorkerResult(chronologicalRoot, 'retry-wave', 'fixture-retry',
    { nonce: oldNonce, outcome: 'unproven', exitCode: 1 }, { now: instant(7) });
  // The newer allocation deliberately carries an older wall-clock timestamp: generation, not
  // the system clock, is the only safe retry chronology.
  const newStart = S.writeWorkerStarted(chronologicalRoot, 'retry-wave', 'fixture-retry',
    { nonce: newNonce, phase: 'proof' }, { now: instant(4) });
  S.writeWorkerResult(chronologicalRoot, 'retry-wave', 'fixture-retry',
    { nonce: newNonce, outcome: 'proven-at-base', exitCode: 0 }, { now: instant(9) });
  const attempts = S.readWorkerRecords(chronologicalRoot, 'retry-wave', 'fixture-retry');
  check('worker generations increase independently of reverse nonce and clock order',
    oldStart.generation === 1 && newStart.generation === 2
      && attempts.map((row) => row.nonce).join(',') === `${oldNonce},${newNonce}`);
  check('derived state uses the newest generation despite reverse nonce order',
    S.deriveState(chronologicalRoot, 'retry-wave').issues[0].state === 'proven-at-base');

  const newStartFile = path.join(chronologicalRoot, 'retry-wave', 'workers', 'fixture-retry',
    `${newNonce}.started.json`);
  const savedStart = fs.readFileSync(newStartFile, 'utf8');
  const duplicateGeneration = JSON.parse(savedStart); duplicateGeneration.generation = oldStart.generation;
  const duplicateBody = { ...duplicateGeneration }; delete duplicateBody.recordHash;
  duplicateGeneration.recordHash = S.canonicalHash(duplicateBody);
  fs.writeFileSync(newStartFile, JSON.stringify(duplicateGeneration));
  const newResultFile = path.join(chronologicalRoot, 'retry-wave', 'workers', 'fixture-retry',
    `${newNonce}.result.json`);
  const savedResult = fs.readFileSync(newResultFile, 'utf8');
  const duplicateResult = JSON.parse(savedResult);
  duplicateResult.generation = duplicateGeneration.generation;
  duplicateResult.startHash = duplicateGeneration.recordHash;
  const duplicateResultBody = { ...duplicateResult }; delete duplicateResultBody.recordHash;
  duplicateResult.recordHash = S.canonicalHash(duplicateResultBody);
  fs.writeFileSync(newResultFile, JSON.stringify(duplicateResult));
  check('duplicate generations fail closed even when a start is re-hashed',
    throws(() => S.readWorkerRecords(chronologicalRoot, 'retry-wave', 'fixture-retry'), /duplicate worker generation/));
  fs.writeFileSync(newStartFile, savedStart);
  fs.writeFileSync(newResultFile, savedResult);
}

// Every state directory and record file is a real object under the real root. A lexical path
// beneath the batch is not sufficient: junctions/symlinks must not redirect evidence writes.
{
  const outside = path.join(tmp, 'outside-state'); fs.mkdirSync(outside);

  const batchLinkRoot = path.join(tmp, 'batch-link'); fs.mkdirSync(batchLinkRoot);
  const outsideBatch = path.join(outside, 'batch-target'); fs.mkdirSync(outsideBatch);
  linkDirectory(outsideBatch, path.join(batchLinkRoot, 'linked-wave'));
  check('a batch directory symlink cannot receive a manifest',
    throws(() => S.createManifest(batchLinkRoot, 'linked-wave', manifestInput(), { now: instant() }), /non-symbolic|real/));

  const eventsRoot = path.join(tmp, 'events-link');
  S.createManifest(eventsRoot, 'events-wave', manifestInput(), { now: instant() });
  const outsideEvents = path.join(outside, 'events-target'); fs.mkdirSync(outsideEvents);
  linkDirectory(outsideEvents, path.join(eventsRoot, 'events-wave', 'events'));
  check('an events directory symlink cannot redirect an append',
    throws(() => S.appendEvent(eventsRoot, 'events-wave', 'attempt', {}), /non-symbolic|real/));
  check('a refused event redirect writes nothing outside the root', fs.readdirSync(outsideEvents).length === 0);

  const workersRoot = path.join(tmp, 'workers-link');
  S.createManifest(workersRoot, 'workers-wave', manifestInput(), { now: instant() });
  const outsideWorkers = path.join(outside, 'workers-target'); fs.mkdirSync(outsideWorkers);
  linkDirectory(outsideWorkers, path.join(workersRoot, 'workers-wave', 'workers'));
  check('a workers directory symlink cannot redirect a worker start',
    throws(() => S.writeWorkerStarted(workersRoot, 'workers-wave', 'fixture-a1',
      { nonce: 'c'.repeat(32) }), /non-symbolic|real/));
  check('a refused workers redirect writes nothing outside the root', fs.readdirSync(outsideWorkers).length === 0);

  const issueRoot = path.join(tmp, 'issue-link');
  S.createManifest(issueRoot, 'issue-wave', manifestInput(), { now: instant() });
  fs.mkdirSync(path.join(issueRoot, 'issue-wave', 'workers'));
  const outsideIssue = path.join(outside, 'issue-target'); fs.mkdirSync(outsideIssue);
  linkDirectory(outsideIssue, path.join(issueRoot, 'issue-wave', 'workers', 'fixture-a1'));
  check('an issue worker directory symlink cannot redirect a worker start',
    throws(() => S.writeWorkerStarted(issueRoot, 'issue-wave', 'fixture-a1',
      { nonce: 'd'.repeat(32) }), /non-symbolic|real/));
  check('a refused issue redirect writes nothing outside the root', fs.readdirSync(outsideIssue).length === 0);
}

// Derived state folds only verified events and workers and remains deterministic.
{
  const state = S.deriveState(root, batch);
  const a = state.issues.find((issue) => issue.id === 'fixture-a1');
  const b = state.issues.find((issue) => issue.id === 'fixture-b2');
  check('deriveState returns a verified chain head', state.ok && state.headHash === state.events[2].recordHash);
  check('latest verified issue event determines issue state', a.state === 'approved');
  check('a completed worker is retained without overriding a later explicit state',
    b.workers.length === 1 && b.workers[0].result.outcome === 'preliminarily-proven');
  check('two reads of unchanged state are canonically identical',
    S.canonicalStringify(state) === S.canonicalStringify(S.deriveState(root, batch)));
}

console.log(`preparation state: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
