// Host-private managed ChatGPT authentication lanes for Codex workers.
'use strict';
const nodeFs = require('fs');
const crypto = require('crypto');
const path = require('path');
const os = require('os');

const AUTH_MODES = ['chatgpt', 'api-key'];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let synchronousOutputUsers = 0;
let asynchronousOutputWrite = null;
function holdSynchronousOutput() {
  if (synchronousOutputUsers === 0) {
    asynchronousOutputWrite = process.stdout.write;
    process.stdout.write = function credentialOwnerWrite(chunk, encoding, callback) {
      const cb = typeof encoding === 'function' ? encoding : callback;
      nodeFs.writeSync(1, chunk, typeof encoding === 'string' ? encoding : undefined);
      if (typeof cb === 'function') queueMicrotask(cb);
      return true;
    };
  }
  synchronousOutputUsers += 1;
}
function releaseSynchronousOutput() {
  synchronousOutputUsers = Math.max(0, synchronousOutputUsers - 1);
  if (synchronousOutputUsers === 0 && asynchronousOutputWrite) {
    process.stdout.write = asynchronousOutputWrite; asynchronousOutputWrite = null;
  }
}
function cacheDefault() { return path.join(os.homedir(), '.pipeline-codex-auth'); }
function managed(text) {
  try { const value = JSON.parse(text); return value && value.auth_mode === 'chatgpt'
    && value.tokens && typeof value.tokens.refresh_token === 'string' && value.tokens.refresh_token.trim() ? value : null; } catch { return null; }
}
function validateConfig(raw = {}) {
  const mode = raw.codexAuth === undefined ? 'api-key' : raw.codexAuth;
  if (!AUTH_MODES.includes(mode)) return { ok: false, reason: "codexAuth must be 'chatgpt' or 'api-key'" };
  return mode === 'chatgpt' ? { ok: true, codexAuth: mode, credentialName: null } : { ok: true, codexAuth: mode, credentialName: 'CODEX_API_KEY' };
}
function ensureDir(fs, dir) { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); fs.chmodSync(dir, 0o700); }
function lockPath(root) { return path.join(root, '.lane.lock'); }
function alive(owner) { try { process.kill(owner.pid, 0); return true; } catch (e) { return e && e.code === 'EPERM'; } }
function managedLock(fs, file) { try { const o = JSON.parse(fs.readFileSync(file, 'utf8')); return o && Number.isInteger(o.pid) ? o : null; } catch { return null; } }
function authFile(root) { return path.join(root, 'auth.json'); }
function digest(text) { return crypto.createHash('sha256').update(text).digest('hex'); }
function durableVersion(fs, root) { return digest(fs.readFileSync(authFile(root), 'utf8')); }
function samePath(a, b) {
  const left = path.resolve(a); const right = path.resolve(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}
function contains(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}
function canonicalLaneRoots(opts, fs) {
  const explicitRoster = Array.isArray(opts.cacheRoots);
  const supplied = explicitRoster ? opts.cacheRoots
    : [opts.cacheRoot === undefined ? cacheDefault() : opts.cacheRoot];
  if (!supplied.length) throw new Error('ChatGPT credential lane roster is empty');
  const roots = [];
  for (const raw of supplied) {
    if (typeof raw !== 'string' || !raw || !path.isAbsolute(raw)
        || path.normalize(raw) !== raw || (explicitRoster && !fs.existsSync(raw))) {
      throw new Error('ChatGPT credential lane root must be an existing canonical absolute directory');
    }
    if (!fs.existsSync(raw)) { roots.push(raw); continue; }
    let real; let stat;
    try { real = fs.realpathSync(raw); stat = fs.statSync(real); } catch {
      throw new Error('ChatGPT credential lane root must be an existing canonical absolute directory');
    }
    if (!samePath(raw, real) || !stat.isDirectory()) {
      throw new Error('ChatGPT credential lane root must name its canonical directory identity');
    }
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
      throw new Error('ChatGPT credential lane root is not host-private');
    }
    roots.push(real);
  }
  const forbidden = [opts.targetRepoPath, opts.repoRoot, ...(opts.workspaceRoots || [])]
    .filter(value => typeof value === 'string' && value).map(value => {
      try { return fs.realpathSync(value); } catch { return path.resolve(value); }
    });
  for (let i = 0; i < roots.length; i += 1) {
    if (forbidden.some(place => contains(place, roots[i]))) {
      throw new Error('ChatGPT credential lane root is inside a mutable project tree');
    }
    for (let j = 0; j < roots.length; j += 1) {
      if (i !== j && (contains(roots[i], roots[j]) || contains(roots[j], roots[i]))) {
        throw new Error('ChatGPT credential lane roots must not overlap');
      }
    }
  }
  return roots;
}
async function withCacheLock(opts = {}, fn) {
  const fs = opts.fs || nodeFs; const root = path.resolve(opts.cacheRoot || cacheDefault());
  const retry = opts.retryMs || 25; const timeout = opts.timeoutMs === undefined ? 1000 : opts.timeoutMs;
  const wait = opts.wait === true; const started = Date.now(); const file = lockPath(root);
  ensureDir(fs, root);
  for (;;) {
    let fd;
    try {
      fd = fs.openSync(file, 'wx', 0o600); fs.chmodSync(file, 0o600);
      const owner = { pid: process.pid, createdAt: Date.now(), nonce: `${process.pid}-${Math.random()}` };
      fs.writeFileSync(fd, JSON.stringify(owner));
      try { return await fn(owner); } finally { try { fs.closeSync(fd); } catch {} try {
        const current = managedLock(fs, file); if (current && current.nonce === owner.nonce) fs.unlinkSync(file);
      } catch {} }
    } catch (e) {
      if (!e || e.code !== 'EEXIST') throw e;
      const stat = (() => { try { return fs.statSync(file); } catch { return null; } })();
      const owner = managedLock(fs, file);
      const stale = opts.staleMs === undefined ? 30000 : opts.staleMs;
      if (owner ? (!alive(owner) && Date.now() - Number(owner.createdAt || 0) > stale)
        : stat && Date.now() - stat.mtimeMs > stale) {
        try { fs.unlinkSync(file); } catch {}
        continue;
      }
      if (!wait && Date.now() - started >= timeout) throw new Error('ChatGPT credential lane is busy');
      if (!wait && Date.now() - started + retry > timeout) throw new Error('ChatGPT credential lane is busy');
      await sleep(retry);
    }
  }
}
function copyAtomic(fs, source, destination) {
  const data = fs.readFileSync(source, 'utf8'); if (!managed(data)) throw new Error('saved ChatGPT session is invalid');
  const temp = `${destination}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  fs.writeFileSync(temp, data, { mode: 0o600 }); fs.chmodSync(temp, 0o600); fs.renameSync(temp, destination); fs.chmodSync(destination, 0o600);
}
async function preflight(opts = {}) {
  if (opts.mode !== 'chatgpt') return { ok: true, cacheRoot: opts.cacheRoot || cacheDefault() };
  const fs = opts.fs || nodeFs; let roots;
  try { roots = canonicalLaneRoots(opts, fs); }
  catch (e) { return { ok: false, reason: e && e.message || 'ChatGPT credential lane configuration is invalid' }; }
  const codexHome = opts.codexHome || path.join(os.homedir(), '.codex'); const source = authFile(codexHome);
  const lanes = [];
  try {
    for (let i = 0; i < roots.length; i += 1) {
      const root = roots[i];
      await withCacheLock({ ...opts, fs, cacheRoot: root, wait: false }, async () => {
        const durable = authFile(root);
        if (fs.existsSync(durable)) { if (!managed(fs.readFileSync(durable, 'utf8'))) throw new Error('durable-invalid'); fs.chmodSync(durable, 0o600); return; }
        if (Array.isArray(opts.cacheRoots) || !source || !fs.existsSync(source)
            || !managed(fs.readFileSync(source, 'utf8'))) throw new Error('login-invalid');
        copyAtomic(fs, source, durable);
      });
      lanes.push({ id: `lane-${i + 1}`, cacheRoot: root });
    }
    return { ok: true, cacheRoot: roots[0], cacheRoots: roots, lanes,
      healthyLaneCount: lanes.length };
  } catch (e) {
    if (/busy/.test(e.message || '')) return { ok: false, reason: 'ChatGPT credential lane is busy; wait for the active worker.' };
    return { ok: false, reason: 'Run codex login and complete device authentication before launching ChatGPT workers.' };
  }
}
async function stageTaskCache(opts = {}) {
  const fs = opts.fs || nodeFs; const root = path.resolve(opts.cacheRoot || cacheDefault());
  const retry = opts.retryMs || 25; const timeout = opts.timeoutMs === undefined ? 1000 : opts.timeoutMs; const started = Date.now();
  ensureDir(fs, root); const file = lockPath(root);
  for (;;) {
    let owner;
    try {
      const fd = fs.openSync(file, 'wx', 0o600); owner = { pid: process.pid, createdAt: Date.now(), nonce: `${process.pid}-${Math.random()}` }; fs.writeFileSync(fd, JSON.stringify(owner)); fs.closeSync(fd);
      try {
        const durable = authFile(root);
        if (!fs.existsSync(durable) && opts.codexHome && fs.existsSync(authFile(opts.codexHome))) copyAtomic(fs, authFile(opts.codexHome), durable);
        if (!fs.existsSync(durable) || !managed(fs.readFileSync(durable, 'utf8'))) throw new Error('managed ChatGPT auth is unavailable');
        const sourceVersion = durableVersion(fs, root);
        const safe = String(opts.taskId || 'task').replace(/[^a-zA-Z0-9_.-]/g, '_'); const hostPath = path.join(root, 'tasks', `${safe}-${process.pid}-${Math.random().toString(16).slice(2)}`);
        ensureDir(fs, path.join(root, 'tasks')); ensureDir(fs, hostPath); copyAtomic(fs, durable, authFile(hostPath));
        const handle = { hostPath, containerPath: opts.containerPath || '/root/.codex', mount: `${hostPath}:${opts.containerPath || '/root/.codex'}:rw`, cacheRoot: root, fs, owner };
        Object.defineProperty(handle, 'sourceVersion', { value: sourceVersion,
          writable: false, enumerable: false });
        // The live owner is a process, not merely a lock-file age. Keep a process that has
        // staged credentials alive until it explicitly settles the handle; this also makes
        // a tiny dedicated lane-holder process a faithful owner on platforms where an idle
        // stdin pipe alone does not retain Node's event loop.
        try {
          holdSynchronousOutput();
          Object.defineProperty(handle, 'outputLease', { value: true, writable: true, enumerable: false });
          Object.defineProperty(handle, 'leaseTimer', { value: setInterval(() => {
            // Some detached host launchers leave Node's stdin pipe unpumped. A lane-holder
            // still has to be able to receive its owner's release signal; synchronously
            // sampling the nonblocking descriptor and re-emitting any bytes keeps that
            // control channel live without putting credential bytes on it.
            if (process.stdin.isTTY) return;
            const input = Buffer.allocUnsafe(4096);
            try {
              const count = nodeFs.readSync(0, input, 0, input.length, null);
              if (count > 0) process.stdin.emit('data', input.subarray(0, count));
            } catch (error) {
              if (!error || !['EAGAIN', 'EWOULDBLOCK', 'EOF'].includes(error.code)) { /* retry on the next tick */ }
            }
          }, 10),
            writable: true, enumerable: false });
        } catch {}
        return handle;
      } catch (e) { try { if (managedLock(fs, file)?.nonce === owner.nonce) fs.unlinkSync(file); } catch {} throw e; }
    } catch (e) {
      if (!e || e.code !== 'EEXIST') throw e; const held = managedLock(fs, file); const stat = (() => { try { return fs.statSync(file); } catch { return null; } })(); const stale = opts.staleMs === undefined ? 30000 : opts.staleMs;
      if (held ? (!alive(held) && Date.now() - Number(held.createdAt || 0) > stale)
        : stat && Date.now() - stat.mtimeMs > stale) { try { fs.unlinkSync(file); } catch {} continue; }
      if (!opts.wait && Date.now() - started >= timeout) throw new Error('ChatGPT credential lane is busy'); await sleep(retry);
    }
  }
}
function releaseOwnedLock(handle) {
  try { const fs = handle.fs || nodeFs; const file = lockPath(handle.cacheRoot); const owner = managedLock(fs, file);
    if (owner && handle.owner && owner.nonce === handle.owner.nonce) fs.unlinkSync(file); } catch {}
}
function settleProcessStreams(handle) {
  if (handle.leaseTimer) { clearInterval(handle.leaseTimer); handle.leaseTimer = null; }
  try { process.stdin.pause(); if (typeof process.stdin.unref === 'function') process.stdin.unref(); } catch {}
  if (handle.outputLease) {
    handle.outputLease = false;
    setImmediate(releaseSynchronousOutput);
  }
}
async function recoverTaskCache(handle, opts = {}) {
  if (!handle) return false;
  const fs = handle.fs || opts.fs || nodeFs;
  await withCacheLock({ ...opts, fs, cacheRoot: handle.cacheRoot, wait: false }, async () => {
    if (durableVersion(fs, handle.cacheRoot) !== handle.sourceVersion) {
      throw new Error('ChatGPT credential lane durable source changed');
    }
    copyAtomic(fs, authFile(handle.hostPath), authFile(handle.cacheRoot));
    fs.rmSync(handle.hostPath, { recursive: true, force: true });
  });
  handle.retained = false;
  settleProcessStreams(handle);
  return true;
}
async function releaseTaskCache(handle) {
  if (!handle) return;
  if (handle.retained) return recoverTaskCache(handle);
  const fs = handle.fs || nodeFs; const durable = authFile(handle.cacheRoot); const task = authFile(handle.hostPath);
  let error;
  try {
    const current = managedLock(fs, lockPath(handle.cacheRoot));
    if (!current || !handle.owner || current.nonce !== handle.owner.nonce) throw new Error('ChatGPT credential lane ownership changed');
    if (!managed(fs.readFileSync(task, 'utf8'))) throw new Error('refreshed task auth is invalid');
    copyAtomic(fs, task, durable); fs.rmSync(handle.hostPath, { recursive: true, force: true });
  } catch (e) { handle.retained = true; error = e; }
  finally {
    releaseOwnedLock(handle);
    settleProcessStreams(handle);
  }
  if (error) throw error;
}
function createLanePool(opts = {}) {
  const lanes = (opts.lanes || []).map((lane, index) => ({
    id: typeof lane.id === 'string' ? lane.id : `lane-${index + 1}`,
    cacheRoot: lane.cacheRoot, busy: false, quarantine: null,
  }));
  let cursor = 0;
  const event = (type, lane, reason) => {
    if (typeof opts.onEvent === 'function') opts.onEvent({ type, laneId: lane.id, ...(reason ? { reason } : {}) });
  };
  async function takeLane() {
    const started = Date.now(); const timeout = opts.timeoutMs === undefined ? 1000 : opts.timeoutMs;
    for (;;) {
      for (let n = 0; n < lanes.length; n += 1) {
        const index = (cursor + n) % lanes.length; const lane = lanes[index];
        if (!lane.busy && !lane.quarantine) { lane.busy = true; cursor = (index + 1) % lanes.length; return lane; }
      }
      if (Date.now() - started >= timeout) throw new Error('No healthy ChatGPT credential lane is available');
      await sleep(opts.retryMs || 25);
    }
  }
  async function run(job = {}, fn) {
    if (job.credential !== true) return fn({ laneId: null, authCache: null });
    const lane = await takeLane(); let handle; let value; let taskError;
    try {
      handle = await stageTaskCache({ cacheRoot: lane.cacheRoot, taskId: job.id,
        wait: false, timeoutMs: opts.timeoutMs, retryMs: opts.retryMs });
      value = await fn({ laneId: lane.id, authCache: handle });
    } catch (e) { taskError = e; }
    if (handle) {
      try { await releaseTaskCache(handle); }
      catch (e) { lane.quarantine = handle; event('lane.quarantined', lane, 'refresh-failed'); taskError = taskError || e; }
    }
    lane.busy = false;
    if (taskError) throw taskError;
    return value;
  }
  async function recover() {
    const recovered = [];
    for (const lane of lanes) {
      if (!lane.quarantine || lane.busy) continue;
      lane.busy = true;
      try {
        await recoverTaskCache(lane.quarantine, { wait: false,
          timeoutMs: opts.timeoutMs, retryMs: opts.retryMs });
        lane.quarantine = null; recovered.push(lane.id); event('lane.recovered', lane);
      } catch { /* Busy and changed lanes remain byte-for-byte quarantined. */ }
      finally { lane.busy = false; }
    }
    return { recovered };
  }
  function snapshot() {
    const quarantined = lanes.filter(lane => lane.quarantine).map(lane => ({ id: lane.id }));
    return { healthyLaneCount: lanes.length - quarantined.length, quarantined };
  }
  return { run, recover, snapshot };
}
module.exports = { AUTH_MODES, validateConfig, preflight, createLanePool, stageTaskCache,
  releaseTaskCache, recoverTaskCache, withCacheLock };
