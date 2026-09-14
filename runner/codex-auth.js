// Host-private managed ChatGPT authentication lane for Codex workers.
'use strict';
const nodeFs = require('fs');
const crypto = require('crypto');
const path = require('path');
const os = require('os');

const AUTH_MODES = ['chatgpt', 'api-key'];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
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
      try { return await fn(); } finally { try { fs.closeSync(fd); } catch {} try {
        const current = managedLock(fs, file); if (current && current.nonce === owner.nonce) fs.unlinkSync(file);
      } catch {} }
    } catch (e) {
      if (!e || e.code !== 'EEXIST') throw e;
      const stat = (() => { try { return fs.statSync(file); } catch { return null; } })();
      const owner = managedLock(fs, file);
      const stale = opts.staleMs === undefined ? 30000 : opts.staleMs;
      // Dead and incomplete records retain a grace period; live owners are never stolen.
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
function managedLock(fs, file) { try { const o = JSON.parse(fs.readFileSync(file, 'utf8')); return o && Number.isInteger(o.pid) ? o : null; } catch { return null; } }
function authFile(root) { return path.join(root, 'auth.json'); }
function digest(text) { return crypto.createHash('sha256').update(text).digest('hex'); }
function durableVersion(fs, root) { return digest(fs.readFileSync(authFile(root), 'utf8')); }
function laneIdentity(root, fs = nodeFs) {
  let identity = path.resolve(root);
  try { identity = fs.realpathSync(identity); } catch { /* validation names missing roots */ }
  return process.platform === 'win32' ? identity.toLowerCase() : identity;
}
function samePath(left, right) {
  const a = path.resolve(left); const b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}
function contains(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative));
}
function canonicalLaneRoots(opts, fs) {
  const explicit = Array.isArray(opts.cacheRoots);
  const supplied = explicit ? opts.cacheRoots
    : [opts.cacheRoot === undefined ? cacheDefault() : opts.cacheRoot];
  if (!supplied.length) throw new Error('ChatGPT credential lane roster is empty');
  const roots = [];
  for (const raw of supplied) {
    if (typeof raw !== 'string' || !raw || !path.isAbsolute(raw)
        || path.normalize(raw) !== raw || (explicit && !fs.existsSync(raw))) {
      throw new Error('ChatGPT credential lane root must be an existing canonical absolute directory');
    }
    if (!fs.existsSync(raw)) { roots.push(path.resolve(raw)); continue; }
    let real; let stat;
    try {
      real = fs.realpathSync(raw);
      if (!samePath(raw, real)) throw new Error('alias');
      ensureDir(fs, real);
      stat = fs.statSync(real);
    } catch {
      throw new Error('ChatGPT credential lane root must name its canonical directory identity');
    }
    if (!stat.isDirectory()) throw new Error('ChatGPT credential lane root must name a directory');
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
      throw new Error('ChatGPT credential lane root is not host-private');
    }
    roots.push(real);
  }
  const forbidden = [opts.targetRepoPath, opts.repoRoot, ...(opts.workspaceRoots || [])]
    .filter((value) => typeof value === 'string' && value)
    .map((value) => { try { return fs.realpathSync(value); } catch { return path.resolve(value); } });
  for (let i = 0; i < roots.length; i += 1) {
    if (forbidden.some((place) => contains(place, roots[i]))) {
      throw new Error('ChatGPT credential lane root is inside a mutable project tree');
    }
    for (let j = i + 1; j < roots.length; j += 1) {
      if (contains(roots[i], roots[j]) || contains(roots[j], roots[i])) {
        throw new Error('ChatGPT credential lane roots must not overlap');
      }
    }
  }
  return roots;
}
function copyAtomic(fs, source, destination) {
  const data = fs.readFileSync(source, 'utf8'); if (!managed(data)) throw new Error('saved ChatGPT session is invalid');
  const temp = `${destination}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  fs.writeFileSync(temp, data, { mode: 0o600 }); fs.chmodSync(temp, 0o600); fs.renameSync(temp, destination);
}
async function preflight(opts = {}) {
  if (opts.mode !== 'chatgpt') return { ok: true, cacheRoot: opts.cacheRoot || cacheDefault() };
  const fs = opts.fs || nodeFs;
  // Explicit roots are independently authenticated lanes and are never ambient-seeded.
  if (opts.cacheRoots !== undefined) {
    let roots;
    try { roots = canonicalLaneRoots(opts, fs); }
    catch (error) { return { ok: false, lanes: [], healthyLaneCount: 0, quarantined: [],
      reason: error && error.message || 'ChatGPT credential lane configuration is invalid' }; }
    const lanes = []; const quarantined = []; const identities = new Set();
    for (let index = 0; index < roots.length; index += 1) {
      const root = roots[index];
      const item = { id: `lane-${index + 1}`, cacheRoot: root, healthy: false };
      try {
        const identity = laneIdentity(root, fs);
        if (identities.has(identity)) throw new Error('lane-duplicate');
        identities.add(identity);
        await withCacheLock({ ...opts, fs, cacheRoot: root, wait: false }, async () => {
          const durable = authFile(root);
          if (!fs.existsSync(durable) || !managed(fs.readFileSync(durable, 'utf8'))) throw new Error('lane-invalid');
          fs.chmodSync(durable, 0o600);
        });
        item.healthy = true;
      } catch (error) {
        const message = String(error && error.message);
        item.reason = /duplicate/.test(message) ? 'duplicate' : /busy/.test(message) ? 'busy' : 'invalid';
        quarantined.push({ id: item.id, reason: item.reason });
      }
      lanes.push(item);
    }
    const healthyLaneCount = lanes.filter((item) => item.healthy).length;
    return { ok: healthyLaneCount > 0, lanes, healthyLaneCount, quarantined,
      ...(healthyLaneCount ? {} : { reason: 'No healthy independently authenticated ChatGPT credential lane is available.' }) };
  }
  const root = path.resolve(opts.cacheRoot || cacheDefault()); const codexHome = opts.codexHome || path.join(os.homedir(), '.codex'); const source = authFile(codexHome);
  try {
    await withCacheLock({ ...opts, fs, cacheRoot: root, wait: false }, async () => {
      ensureDir(fs, root); const durable = authFile(root);
      if (fs.existsSync(durable)) { if (!managed(fs.readFileSync(durable, 'utf8'))) throw new Error('durable-invalid'); fs.chmodSync(durable, 0o600); return; }
      if (!source || !fs.existsSync(source) || !managed(fs.readFileSync(source, 'utf8'))) throw new Error('login-invalid');
      copyAtomic(fs, source, durable);
    });
    return { ok: true, cacheRoot: root };
  } catch (e) {
    if (/busy/.test(e.message || '')) return { ok: false, reason: 'ChatGPT credential lane is busy; wait for the active worker.' };
    return { ok: false, reason: 'Run codex login and complete device authentication before launching ChatGPT workers.' };
  }
}

// Credential jobs share a deterministic FIFO queue and acquire one exclusive lane;
// credential-free stages have independent caps and never receive auth context.
function createLanePool(opts = {}) {
  const onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : () => {};
  const stageCaps = opts.stageCaps && typeof opts.stageCaps === 'object' ? opts.stageCaps : {};
  const identities = new Set();
  const lanes = (Array.isArray(opts.lanes) ? opts.lanes : []).map((item, index) => {
    const identity = item && item.cacheRoot ? laneIdentity(item.cacheRoot, opts.fs || nodeFs) : null;
    const distinct = !!identity && !identities.has(identity);
    if (identity) identities.add(identity);
    return { id: item && item.id || `lane-${index + 1}`, cacheRoot: item && item.cacheRoot,
      state: item && item.healthy && distinct ? 'healthy' : 'quarantined', retained: null };
  });
  const credentialQueue = [];
  const freeQueues = new Map();
  const freeActive = new Map();
  let laneCursor = 0;
  const laneIo = {
    ...(opts.fs ? { fs: opts.fs } : {}),
    ...(opts.retryMs !== undefined ? { retryMs: opts.retryMs } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  };
  function emit(type, lane, job, reason) {
    try { onEvent({ type, laneId: lane && lane.id, jobId: job && job.id,
      ...(reason ? { reason } : {}) }); } catch { /* observation is non-owning */ }
  }
  function snapshot() {
    const healthy = lanes.filter((lane) => lane.state === 'healthy' || lane.state === 'busy');
    return { healthyLaneCount: healthy.length,
      quarantined: lanes.filter((lane) => lane.state === 'quarantined').map((lane) => ({ id: lane.id })),
      queuedCredentialCount: credentialQueue.length };
  }
  function rejectUnserviceable() {
    if (lanes.some((lane) => lane.state === 'healthy' || lane.state === 'busy')) return;
    while (credentialQueue.length) credentialQueue.shift().reject(new Error('No healthy ChatGPT credential lane is available'));
  }
  function pumpCredential() {
    for (;;) {
      let lane = null; let laneIndex = -1;
      for (let offset = 0; offset < lanes.length; offset += 1) {
        const index = (laneCursor + offset) % lanes.length;
        if (lanes[index].state === 'healthy') { lane = lanes[index]; laneIndex = index; break; }
      }
      const queued = credentialQueue.shift();
      if (!lane || !queued) {
        if (queued) credentialQueue.unshift(queued);
        rejectUnserviceable();
        return;
      }
      laneCursor = (laneIndex + 1) % Math.max(1, lanes.length);
      lane.state = 'busy';
      Promise.resolve().then(async () => {
        let handle = null; let value; let stageError = null; let workerError = null; let releaseError = null;
        try { handle = await stageTaskCache({ ...laneIo, cacheRoot: lane.cacheRoot, taskId: queued.job.id, wait: false }); }
        catch (error) { stageError = error; }
        try {
          if (stageError) throw stageError;
          value = await queued.worker({ laneId: lane.id, cacheRoot: lane.cacheRoot, authCache: handle });
        } catch (error) { workerError = error; }
        if (handle) {
          try { await releaseTaskCache(handle); } catch (error) { releaseError = error; }
        }
        if (stageError && /busy/i.test(String(stageError && stageError.message))) {
          lane.state = 'healthy'; credentialQueue.unshift(queued);
        } else if (stageError || releaseError) {
          lane.state = 'quarantined'; lane.retained = handle;
          emit('lane.quarantined', lane, queued.job, stageError ? 'handoff-unavailable' : 'refresh-invalid');
          queued.reject(new Error(stageError
            ? 'ChatGPT credential lane became unavailable and was quarantined'
            : 'ChatGPT lane refresh failed; prior durable cache and recoverable task copy were preserved'));
        } else {
          lane.state = 'healthy'; lane.retained = null;
          if (workerError) queued.reject(workerError); else queued.resolve(value);
        }
        pumpCredential();
      });
    }
  }
  function capFor(stage) {
    const value = stageCaps[stage];
    return Number.isInteger(value) && value > 0 ? value : Number.POSITIVE_INFINITY;
  }
  function pumpFree(stage) {
    const queue = freeQueues.get(stage) || [];
    let active = freeActive.get(stage) || 0;
    while (queue.length && active < capFor(stage)) {
      const queued = queue.shift(); active += 1; freeActive.set(stage, active);
      Promise.resolve().then(() => queued.worker({ jobId: queued.job.id, stage }))
        .then(queued.resolve, queued.reject).finally(() => {
          freeActive.set(stage, (freeActive.get(stage) || 1) - 1); pumpFree(stage);
        });
    }
  }
  function run(job = {}, worker) {
    if (typeof worker !== 'function') return Promise.reject(new Error('lane worker must be a function'));
    return new Promise((resolve, reject) => {
      const queued = { job, worker, resolve, reject };
      if (job.credential) { credentialQueue.push(queued); pumpCredential(); return; }
      const stage = String(job.stage || 'other');
      if (!freeQueues.has(stage)) freeQueues.set(stage, []);
      freeQueues.get(stage).push(queued); pumpFree(stage);
    });
  }
  async function recover() {
    const recovered = [];
    for (const lane of lanes.filter((candidate) => candidate.state === 'quarantined')) {
      try {
        if (lane.retained) await recoverTaskCache(lane.retained, laneIo);
        else {
          const checked = await preflight({ ...laneIo, mode: 'chatgpt', cacheRoots: [lane.cacheRoot] });
          if (!checked.ok) continue;
        }
        lane.retained = null; lane.state = 'healthy'; recovered.push(lane.id);
        emit('lane.recovered', lane, null);
      } catch { /* retained evidence remains for an exclusive later repair */ }
    }
    pumpCredential();
    return { recovered, healthyLaneCount: snapshot().healthyLaneCount };
  }
  return { run, snapshot, recover };
}
async function stageTaskCache(opts = {}) {
  const fs = opts.fs || nodeFs; const root = path.resolve(opts.cacheRoot || cacheDefault());
  const retry = opts.retryMs || 25; const timeout = opts.timeoutMs === undefined ? 1000 : opts.timeoutMs; const started = Date.now();
  ensureDir(fs, root); const file = lockPath(root);
  for (;;) {
    let owner;
    try {
      const fd = fs.openSync(file, "wx", 0o600); owner = { pid: process.pid, createdAt: Date.now(), nonce: `${process.pid}-${Math.random()}` }; fs.writeFileSync(fd, JSON.stringify(owner)); fs.closeSync(fd);
      try {
        const durable = authFile(root);
        if (!fs.existsSync(durable) && opts.codexHome && fs.existsSync(authFile(opts.codexHome))) copyAtomic(fs, authFile(opts.codexHome), durable);
        if (!fs.existsSync(durable) || !managed(fs.readFileSync(durable, "utf8"))) throw new Error("managed ChatGPT auth is unavailable");
        const sourceVersion = durableVersion(fs, root);
        const safe = String(opts.taskId || "task").replace(/[^a-zA-Z0-9_.-]/g, "_"); const hostPath = path.join(root, "tasks", `${safe}-${process.pid}-${Math.random().toString(16).slice(2)}`);
        ensureDir(fs, path.join(root, "tasks")); ensureDir(fs, hostPath); copyAtomic(fs, durable, authFile(hostPath));
        const handle = { hostPath, containerPath: opts.containerPath || "/root/.codex", mount: `${hostPath}:${opts.containerPath || "/root/.codex"}:rw`, cacheRoot: root, fs, owner };
        Object.defineProperty(handle, 'sourceVersion', { value: sourceVersion, writable: false, enumerable: false });
        return handle;
      } catch (e) { try { if (managedLock(fs, file)?.nonce === owner.nonce) fs.unlinkSync(file); } catch {} throw e; }
    } catch (e) {
      if (!e || e.code !== "EEXIST") throw e; const held = managedLock(fs, file); const stat = (() => { try { return fs.statSync(file); } catch { return null; } })(); const stale = opts.staleMs === undefined ? 30000 : opts.staleMs;
      if (held ? (!alive(held) && Date.now() - Number(held.createdAt || 0) > stale)
        : stat && Date.now() - stat.mtimeMs > stale) { try { fs.unlinkSync(file); } catch {} continue; }
      if (!opts.wait && Date.now() - started >= timeout) throw new Error("ChatGPT credential lane is busy"); await sleep(retry);
    }
  }
}
async function releaseTaskCache(handle) {
  if (!handle) return; const fs = handle.fs || nodeFs; const durable = authFile(handle.cacheRoot); const task = authFile(handle.hostPath);
  if (handle.retained) return recoverTaskCache(handle);
  let error;
  try {
    const current = managedLock(fs, lockPath(handle.cacheRoot));
    if (!current || !handle.owner || current.nonce !== handle.owner.nonce) throw new Error('ChatGPT credential lane ownership changed');
    if (!managed(fs.readFileSync(task, 'utf8'))) throw new Error('refreshed task auth is invalid');
    copyAtomic(fs, task, durable); fs.rmSync(handle.hostPath, { recursive: true, force: true });
  } catch (e) { handle.retained = true; error = e; }
  finally { try { const file = lockPath(handle.cacheRoot); const owner = managedLock(fs, file); if (owner && handle.owner && owner.nonce === handle.owner.nonce) fs.unlinkSync(file); } catch {} }
  if (error) throw error;
}
async function recoverTaskCache(handle, opts = {}) {
  if (!handle) return false;
  const fs = handle.fs || opts.fs || nodeFs;
  await withCacheLock({ ...opts, fs, cacheRoot: handle.cacheRoot, wait: false }, async () => {
    if (durableVersion(fs, handle.cacheRoot) !== handle.sourceVersion) throw new Error('ChatGPT credential lane durable source changed');
    copyAtomic(fs, authFile(handle.hostPath), authFile(handle.cacheRoot));
    fs.rmSync(handle.hostPath, { recursive: true, force: true });
  });
  handle.retained = false;
  return true;
}
module.exports = { AUTH_MODES, validateConfig, preflight, stageTaskCache, releaseTaskCache,
  recoverTaskCache, withCacheLock, createLanePool };
