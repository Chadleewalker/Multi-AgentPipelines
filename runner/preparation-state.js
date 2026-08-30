// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0
'use strict';

// Durable, host-only state for planning-side batch preparation. The coordinator is allowed
// to crash; the evidence it leaves is not allowed to become an instruction to launch the
// same author twice. Immutable records and a hash-chained event ledger make an incomplete
// attempt visible without requiring any recovery writer to edit history.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const STATE_SCHEMA = 1;
const ROOT_ENV = 'PREPARATION_RUNS_DIR';
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_BATCH = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const SAFE_LABEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const SAFE_NONCE = /^[a-f0-9]{32,64}$/;
const RESERVED = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);
const MAX_RECORD_BYTES = 1024 * 1024;

function preparationRoot(env = process.env) {
  const aimed = env && typeof env[ROOT_ENV] === 'string' ? env[ROOT_ENV].trim() : '';
  return aimed ? path.resolve(aimed) : path.resolve(__dirname, '..', 'runs', 'preparations');
}

function validateNamedId(value, re, label) {
  if (typeof value !== 'string' || !re.test(value) || value === '.' || value === '..'
      || value.includes('..') || /[. ]$/.test(value)) {
    throw new Error(`${label} must be a safe portable identifier`);
  }
  const device = value.split('.')[0].toLowerCase();
  if (RESERVED.has(device)) throw new Error(`${label} is a reserved filesystem name`);
  return value;
}

const validateBatchId = (value) => validateNamedId(value, SAFE_BATCH, 'batch id');
const validateIssueId = (value) => validateNamedId(value, SAFE_ID, 'issue id');

function validateNonce(value) {
  if (typeof value !== 'string' || !SAFE_NONCE.test(value)) {
    throw new Error('worker nonce must be 32 to 64 lowercase hexadecimal characters');
  }
  return value;
}

function safePath(root, ...segments) {
  const base = path.resolve(root);
  const target = path.resolve(base, ...segments);
  if (target !== base && !target.startsWith(`${base}${path.sep}`)) {
    throw new Error(`path escapes preparation root: ${target}`);
  }
  return target;
}

function realContained(root, target) {
  const base = fs.realpathSync(root);
  const resolved = fs.realpathSync(target);
  const fold = (value) => process.platform === 'win32' ? value.toLowerCase() : value;
  const a = fold(base); const b = fold(resolved);
  return b === a || b.startsWith(`${a}${path.sep}`);
}

function assertRealDirectory(dir, root = dir, label = 'preparation directory') {
  let stat;
  try { stat = fs.lstatSync(dir); } catch (e) { throw new Error(`${label} is unavailable: ${e.message}`); }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a real non-symbolic directory`);
  let rootStat;
  try { rootStat = fs.lstatSync(root); } catch (e) { throw new Error(`preparation root is unavailable: ${e.message}`); }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('preparation root must be a real non-symbolic directory');
  }
  if (!realContained(root, dir)) throw new Error(`${label} escapes the real preparation root`);
  return dir;
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function canonicalValue(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonical JSON refuses non-finite numbers');
    return value;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new Error('canonical JSON refuses cycles');
    seen.add(value);
    const out = value.map((item) => canonicalValue(item, seen));
    seen.delete(value);
    return out;
  }
  if (!plainObject(value)) throw new Error('canonical JSON accepts only plain JSON values');
  if (seen.has(value)) throw new Error('canonical JSON refuses cycles');
  seen.add(value);
  const out = {};
  for (const key of Object.keys(value).sort()) {
    const item = value[key];
    if (item === undefined || typeof item === 'function' || typeof item === 'symbol') {
      throw new Error(`canonical JSON refuses non-JSON value at ${key}`);
    }
    out[key] = canonicalValue(item, seen);
  }
  seen.delete(value);
  return out;
}

function canonicalStringify(value) {
  return JSON.stringify(canonicalValue(value));
}

function canonicalHash(value) {
  return crypto.createHash('sha256').update(canonicalStringify(value)).digest('hex');
}

function redactUrlUserinfo(value) {
  if (typeof value !== 'string') return value;
  const scheme = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.exec(value);
  if (!scheme) return value;
  const authorityStart = scheme[0].length;
  const tailOffset = value.slice(authorityStart).search(/[/?#]/);
  const authorityEnd = tailOffset < 0 ? value.length : authorityStart + tailOffset;
  const at = value.lastIndexOf('@', authorityEnd - 1);
  if (at < authorityStart) return value;
  // Preserve the scheme, host, port and complete repository path verbatim. Only URL userinfo is
  // removed, so two credentials for one remote hash identically while a different remote does not.
  return `${value.slice(0, authorityStart)}${value.slice(at + 1)}`;
}

function redactValue(value, key = '') {
  if (key.toLowerCase() === 'hostenv') {
    if (!plainObject(value)) return '<redacted>';
    const names = {};
    for (const name of Object.keys(value).sort()) names[name] = '<redacted>';
    return names;
  }
  if (/(?:token|password|passwd|secret|credential|api[_-]?key)$/i.test(key)) return '<redacted>';
  if (Array.isArray(value)) return value.map((item) => redactValue(item));
  if (plainObject(value)) {
    const out = {};
    for (const name of Object.keys(value).sort()) {
      // Optional JS fields are routinely represented as undefined before they reach JSON.
      // Omit them explicitly; canonicalStringify itself remains strict for callers that are
      // hashing an allegedly complete value.
      if (value[name] !== undefined) out[name] = redactValue(value[name], name);
    }
    return out;
  }
  return redactUrlUserinfo(value);
}

function redactConfig(config) {
  if (!plainObject(config)) throw new Error('config must be a plain object');
  return canonicalValue(redactValue(config));
}

function ensureRoot(root) {
  fs.mkdirSync(path.resolve(root), { recursive: true });
  assertRealDirectory(path.resolve(root), path.resolve(root), 'preparation root');
}

function caseCollision(parent, name) {
  let entries = [];
  try { entries = fs.readdirSync(parent); } catch { return null; }
  return entries.find((entry) => entry.toLowerCase() === name.toLowerCase() && entry !== name) || null;
}

function ensureNamedDir(parent, name, containmentRoot = parent) {
  assertRealDirectory(parent, containmentRoot, 'preparation parent directory');
  const collision = caseCollision(parent, name);
  if (collision) throw new Error(`portable-name collision: ${name} conflicts with ${collision}`);
  const dir = safePath(parent, name);
  try { fs.mkdirSync(dir); } catch (e) { if (!e || e.code !== 'EEXIST') throw e; }
  return assertRealDirectory(dir, containmentRoot, `${name} directory`);
}

function batchDir(root, batchId, create = false) {
  validateBatchId(batchId);
  const base = path.resolve(root);
  if (create) ensureRoot(base);
  else assertRealDirectory(base, base, 'preparation root');
  const collision = caseCollision(base, batchId);
  if (collision) throw new Error(`portable-name collision: ${batchId} conflicts with ${collision}`);
  const dir = safePath(base, batchId);
  if (create) return ensureNamedDir(base, batchId, base);
  return assertRealDirectory(dir, base, `preparation batch ${batchId}`);
}

function isoNow(opts) {
  const value = opts && typeof opts.now === 'function' ? opts.now() : new Date().toISOString();
  const text = value instanceof Date ? value.toISOString() : String(value);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(text) || !Number.isFinite(Date.parse(text))) {
    throw new Error('record clock must return an RFC3339 instant');
  }
  return text;
}

function writeBytesExclusive(file, text) {
  if (Buffer.byteLength(text) > MAX_RECORD_BYTES) throw new Error('preparation record exceeds size bound');
  const fd = fs.openSync(file, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, text, 'utf8');
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
}

function writeAtomicExclusive(file, value) {
  const text = `${canonicalStringify(value)}\n`;
  if (Buffer.byteLength(text) > MAX_RECORD_BYTES) throw new Error('preparation record exceeds size bound');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = safePath(path.dirname(file), `.${path.basename(file)}.tmp-${process.pid}-${crypto.randomBytes(8).toString('hex')}`);
  try {
    writeBytesExclusive(tmp, text);
    // A hard link is an atomic create-if-absent operation on the same volume. Unlike rename,
    // it cannot replace a record another process won the race to publish.
    fs.linkSync(tmp, file);
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch { /* an incomplete temp is harmless */ }
  }
}

function readJson(file) {
  let text;
  let stat;
  try { stat = fs.lstatSync(file); } catch (e) { throw new Error(`cannot inspect ${file}: ${e.message}`); }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`record must be a real non-symbolic file: ${file}`);
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { throw new Error(`cannot read ${file}: ${e.message}`); }
  if (Buffer.byteLength(text) > MAX_RECORD_BYTES) throw new Error(`record is too large: ${file}`);
  try { return JSON.parse(text); } catch { throw new Error(`record is malformed JSON: ${file}`); }
}

function hashedRecord(kind, fields) {
  const body = { schema: STATE_SCHEMA, kind, ...fields };
  return { ...body, recordHash: canonicalHash(body) };
}

function verifyHashedRecord(value, kind, file) {
  if (!plainObject(value) || value.schema !== STATE_SCHEMA || value.kind !== kind
      || typeof value.recordHash !== 'string') throw new Error(`invalid ${kind} record: ${file}`);
  const body = { ...value }; delete body.recordHash;
  if (canonicalHash(body) !== value.recordHash) throw new Error(`tampered ${kind} record: ${file}`);
  return value;
}

function normalizeIssues(issues) {
  if (!Array.isArray(issues) || !issues.length) throw new Error('manifest needs at least one issue');
  const seen = new Map();
  return issues.map((row) => {
    const raw = typeof row === 'string' ? { id: row } : row;
    if (!plainObject(raw)) throw new Error('manifest issue must be an id or object');
    const id = validateIssueId(raw.id);
    const folded = id.toLowerCase();
    if (seen.has(folded)) throw new Error(`duplicate or case-colliding issue ids: ${seen.get(folded)} and ${id}`);
    seen.set(folded, id);
    const dependencies = raw.dependencies === undefined ? [] : raw.dependencies;
    if (!Array.isArray(dependencies)) throw new Error(`dependencies for ${id} must be an array`);
    const depSeen = new Set();
    const deps = dependencies.map(validateIssueId).map((dep) => {
      const key = dep.toLowerCase();
      if (depSeen.has(key)) throw new Error(`duplicate or case-colliding dependency for ${id}: ${dep}`);
      depSeen.add(key); return dep;
    });
    const out = { id, title: typeof raw.title === 'string' ? raw.title : '', dependencies: deps };
    if (raw.priority !== undefined) {
      if (!Number.isInteger(raw.priority) || raw.priority < 0) throw new Error(`priority for ${id} must be a nonnegative integer`);
      out.priority = raw.priority;
    }
    return out;
  });
}

function createManifest(root, batchId, input, opts = {}) {
  validateBatchId(batchId);
  if (!plainObject(input)) throw new Error('manifest input must be a plain object');
  const config = redactConfig(input.config || {});
  const fields = {
    batchId,
    createdAt: isoNow(opts),
    project: typeof input.project === 'string' ? input.project : '',
    runConfig: typeof input.runConfig === 'string' ? input.runConfig : '',
    intent: typeof input.intent === 'string' ? input.intent : '',
    issues: normalizeIssues(input.issues),
    config,
    configHash: canonicalHash(config),
  };
  if (input.concurrency !== undefined) {
    if (!Number.isInteger(input.concurrency) || input.concurrency < 1) throw new Error('manifest concurrency must be a positive integer');
    fields.concurrency = input.concurrency;
  }
  if (typeof input.integrationBranch === 'string') fields.integrationBranch = input.integrationBranch;
  if (typeof input.integrationHead === 'string') fields.integrationHead = input.integrationHead;
  const manifest = hashedRecord('preparation-manifest', fields);
  const dir = batchDir(root, batchId, true);
  // The manifest itself is the immutable allocation of the batch id. O_EXCL means a second
  // start cannot overwrite it, including after a crash left a visibly torn first attempt.
  writeBytesExclusive(path.join(dir, 'manifest.json'), `${canonicalStringify(manifest)}\n`);
  return manifest;
}

function readManifest(root, batchId) {
  const file = path.join(batchDir(root, batchId), 'manifest.json');
  const value = verifyHashedRecord(readJson(file), 'preparation-manifest', file);
  if (value.batchId !== batchId) throw new Error(`manifest batch id mismatch: ${file}`);
  normalizeIssues(value.issues);
  if (canonicalHash(value.config) !== value.configHash) throw new Error(`manifest config hash mismatch: ${file}`);
  return value;
}

function eventFile(eventsDir, seq) {
  return path.join(eventsDir, `${String(seq).padStart(8, '0')}.json`);
}

function ownedSubdir(root, batchId, name, create = false) {
  const batch = batchDir(root, batchId);
  const dir = safePath(batch, name);
  if (!fs.existsSync(dir)) {
    if (!create) return null;
    return ensureNamedDir(batch, name, path.resolve(root));
  }
  const collision = caseCollision(batch, name);
  if (collision) throw new Error(`portable-name collision: ${name} conflicts with ${collision}`);
  return assertRealDirectory(dir, path.resolve(root), `${name} directory`);
}

function readEvents(root, batchId) {
  const manifest = readManifest(root, batchId);
  const dir = ownedSubdir(root, batchId, 'events', false);
  if (!dir) return [];
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { throw new Error(`cannot read events directory: ${e.message}`); }
  // Dot-prefixed temp files are remnants of a process that died before publication. They are
  // not events and are safe to ignore. Every visible JSON event must form one exact chain.
  const visible = names.filter((name) => !name.startsWith('.'));
  for (const name of visible) if (!/^\d{8}\.json$/.test(name)) throw new Error(`unexpected event record: ${name}`);
  visible.sort();
  const events = [];
  let prevHash = manifest.recordHash;
  for (let index = 0; index < visible.length; index += 1) {
    const expectedSeq = index + 1;
    const expectedName = path.basename(eventFile(dir, expectedSeq));
    if (visible[index] !== expectedName) throw new Error(`event sequence gap before ${visible[index]}`);
    const file = path.join(dir, visible[index]);
    const event = verifyHashedRecord(readJson(file), 'preparation-event', file);
    if (event.batchId !== batchId || event.seq !== expectedSeq || event.prevHash !== prevHash) {
      throw new Error(`event chain mismatch at ${visible[index]}`);
    }
    events.push(event); prevHash = event.recordHash;
  }
  return events;
}

function appendEvent(root, batchId, type, payload = {}, opts = {}) {
  if (typeof type !== 'string' || !SAFE_LABEL.test(type)) throw new Error('event type must be a safe label');
  if (!plainObject(payload)) throw new Error('event payload must be a plain object');
  const manifest = readManifest(root, batchId);
  if (payload.issueId !== undefined) {
    const id = validateIssueId(payload.issueId);
    if (!manifest.issues.some((issue) => issue.id === id)) throw new Error(`event names issue outside manifest: ${id}`);
  }
  const events = readEvents(root, batchId);
  const prevHash = events.length ? events[events.length - 1].recordHash : manifest.recordHash;
  if (opts.expectedPrevHash !== undefined && opts.expectedPrevHash !== prevHash) {
    throw new Error('event predecessor changed before append');
  }
  const seq = events.length + 1;
  const event = hashedRecord('preparation-event', {
    batchId, seq, at: isoNow(opts), type, payload: canonicalValue(redactValue(payload)), prevHash,
  });
  const dir = ownedSubdir(root, batchId, 'events', true);
  writeAtomicExclusive(eventFile(dir, seq), event);
  return event;
}

function createWorkerNonce() {
  return crypto.randomBytes(16).toString('hex');
}

function workerPayload(data, reserved) {
  const out = plainObject(data.data) ? { ...data.data } : {};
  for (const [key, value] of Object.entries(data)) {
    if (!reserved.has(key) && key !== 'data') out[key] = value;
  }
  return canonicalValue(redactValue(out));
}

function rosterIssue(manifest, issueId) {
  const id = validateIssueId(issueId);
  if (!manifest.issues.some((issue) => issue.id === id)) throw new Error(`worker issue is outside manifest: ${id}`);
  return id;
}

function workerDir(root, batchId, issueId, create = false) {
  const manifest = readManifest(root, batchId);
  const id = rosterIssue(manifest, issueId);
  const parent = ownedSubdir(root, batchId, 'workers', create);
  if (!parent) return safePath(batchDir(root, batchId), 'workers', id);
  const collision = caseCollision(parent, id);
  if (collision) throw new Error(`portable-name collision: ${id} conflicts with ${collision}`);
  const dir = safePath(parent, id);
  if (create) return ensureNamedDir(parent, id, path.resolve(root));
  if (!fs.existsSync(dir)) return dir;
  return assertRealDirectory(dir, path.resolve(root), `worker issue ${id} directory`);
}

function nextWorkerGeneration(dir, batchId, issueId) {
  let names = [];
  try { names = fs.readdirSync(dir).filter((name) => /^[a-f0-9]{32,64}\.started\.json$/.test(name)); }
  catch (e) { throw new Error(`cannot read worker generations: ${e.message}`); }
  let max = 0;
  const seen = new Set();
  for (const name of names) {
    const record = readWorkerFile(path.join(dir, name), 'worker-started');
    if (record.batchId !== batchId || record.issueId !== issueId || !Number.isInteger(record.generation)
        || record.generation < 1 || seen.has(record.generation)) {
      throw new Error(`invalid or duplicate worker generation in ${name}`);
    }
    seen.add(record.generation); max = Math.max(max, record.generation);
  }
  return max + 1;
}

function writeWorkerStarted(root, batchId, issueId, data = {}, opts = {}) {
  if (!plainObject(data)) throw new Error('worker start data must be a plain object');
  const nonce = validateNonce(data.nonce || createWorkerNonce());
  const phase = validateNamedId(data.phase || data.action || 'author', SAFE_LABEL, 'worker phase');
  if (data.pid !== undefined && (!Number.isInteger(data.pid) || data.pid < 1)) throw new Error('worker pid must be a positive integer');
  const dir = workerDir(root, batchId, issueId, true);
  const generation = nextWorkerGeneration(dir, batchId, issueId);
  const record = hashedRecord('worker-started', {
    batchId, issueId: validateIssueId(issueId), nonce, generation, phase, startedAt: isoNow(opts),
    ...(data.pid === undefined ? {} : { pid: data.pid }),
    data: workerPayload(data, new Set(['nonce', 'pid', 'phase', 'action', 'startedAt'])),
  });
  writeAtomicExclusive(path.join(dir, `${nonce}.started.json`), record);
  return record;
}

function readWorkerFile(file, kind) {
  return verifyHashedRecord(readJson(file), kind, file);
}

function writeWorkerResult(root, batchId, issueId, data = {}, opts = {}) {
  if (!plainObject(data)) throw new Error('worker result data must be a plain object');
  const nonce = validateNonce(data.nonce);
  const dir = workerDir(root, batchId, issueId, false);
  const startedFile = path.join(dir, `${nonce}.started.json`);
  const started = readWorkerFile(startedFile, 'worker-started');
  if (started.batchId !== batchId || started.issueId !== issueId || started.nonce !== nonce) {
    throw new Error('worker result nonce does not match its immutable start record');
  }
  if (!Number.isInteger(started.generation) || started.generation < 1
      || typeof started.startedAt !== 'string' || !Number.isFinite(Date.parse(started.startedAt))) {
    throw new Error('worker result start record has invalid chronology');
  }
  const outcome = validateNamedId(data.outcome || 'unknown', SAFE_LABEL, 'worker outcome');
  const fields = {
    batchId, issueId, nonce, generation: started.generation,
    phase: started.phase, finishedAt: isoNow(opts), outcome,
    data: workerPayload(data, new Set(['nonce', 'outcome', 'exitCode', 'finishedAt'])),
    startHash: started.recordHash,
  };
  if (data.exitCode !== undefined) {
    if (!Number.isInteger(data.exitCode)) throw new Error('worker exitCode must be an integer');
    fields.exitCode = data.exitCode;
  }
  const result = hashedRecord('worker-result', fields);
  writeAtomicExclusive(path.join(dir, `${nonce}.result.json`), result);
  return result;
}

function readWorkerRecords(root, batchId, issueId) {
  const dir = workerDir(root, batchId, issueId, false);
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { if (e && e.code === 'ENOENT') return []; throw e; }
  const visible = names.filter((name) => !name.startsWith('.'));
  for (const name of visible) {
    if (!/^[a-f0-9]{32,64}\.(?:started|result)\.json$/.test(name)) {
      throw new Error(`unexpected worker record: ${name}`);
    }
  }
  const nonces = [...new Set(visible.map((name) => name.split('.')[0]))].sort();
  const rows = nonces.map((nonce) => {
    const startFile = path.join(dir, `${nonce}.started.json`);
    if (!fs.existsSync(startFile)) throw new Error(`orphan worker result for nonce ${nonce}`);
    const started = readWorkerFile(startFile, 'worker-started');
    if (started.batchId !== batchId || started.issueId !== issueId || started.nonce !== nonce) {
      throw new Error(`worker start identity mismatch for nonce ${nonce}`);
    }
    if (!Number.isInteger(started.generation) || started.generation < 1
        || typeof started.startedAt !== 'string' || !Number.isFinite(Date.parse(started.startedAt))) {
      throw new Error(`invalid worker chronology for nonce ${nonce}`);
    }
    const resultFile = path.join(dir, `${nonce}.result.json`);
    let result = null;
    if (fs.existsSync(resultFile)) {
      result = readWorkerFile(resultFile, 'worker-result');
      if (result.batchId !== batchId || result.issueId !== issueId || result.nonce !== nonce
          || result.generation !== started.generation
          || result.startHash !== started.recordHash || result.phase !== started.phase) {
        throw new Error(`worker result nonce does not match start for ${nonce}`);
      }
    }
    return { nonce, generation: started.generation, started, result };
  });
  const generations = new Set();
  for (const row of rows) {
    if (generations.has(row.generation)) throw new Error(`duplicate worker generation: ${row.generation}`);
    generations.add(row.generation);
  }
  // Generation is the immutable allocation order and therefore the chronology authority even
  // when the wall clock moves backwards. startedAt remains human-auditable metadata only; nonce
  // is deliberately absent because it is random and cannot encode attempt order.
  return rows.sort((a, b) => a.generation - b.generation
    || a.started.recordHash.localeCompare(b.started.recordHash));
}

function deriveState(root, batchId) {
  try {
    const manifest = readManifest(root, batchId);
    const events = readEvents(root, batchId);
    const issues = manifest.issues.map((issue) => ({ ...issue, state: 'pending', events: [], workers: [] }));
    const byId = new Map(issues.map((issue) => [issue.id, issue]));
    for (const event of events) {
      const id = event.payload && event.payload.issueId;
      if (id && byId.has(id)) {
        const row = byId.get(id);
        row.events.push(event);
        if (typeof event.payload.state === 'string' && SAFE_LABEL.test(event.payload.state)) row.state = event.payload.state;
      }
    }
    for (const issue of issues) {
      issue.workers = readWorkerRecords(root, batchId, issue.id);
      const latest = issue.workers[issue.workers.length - 1];
      if (latest && !latest.result) issue.state = 'interrupted-unknown';
      else if (latest && latest.result && issue.state === 'pending') issue.state = latest.result.outcome;
    }
    return { ok: true, manifest, events, issues, headHash: events.length ? events[events.length - 1].recordHash : manifest.recordHash };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e), manifest: null, events: [], issues: [] };
  }
}

module.exports = {
  STATE_SCHEMA, ROOT_ENV, preparationRoot, validateBatchId, validateIssueId, validateNonce,
  safePath, assertRealDirectory, canonicalStringify, canonicalHash, redactConfig, createManifest, readManifest,
  appendEvent, readEvents, createWorkerNonce, writeWorkerStarted, writeWorkerResult,
  readWorkerRecords, deriveState,
};
