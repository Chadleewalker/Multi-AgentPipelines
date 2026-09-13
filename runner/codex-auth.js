// Host-private managed ChatGPT authentication lane for Codex workers.
'use strict';
const nodeFs = require('fs');
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
      // A readable live owner is never stolen on age alone. An incomplete record has a
      // grace period so another process cannot steal while its creator is writing it.
      if (owner ? !alive(owner) : stat && Date.now() - stat.mtimeMs > stale) {
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
function laneIdentity(root, fs = nodeFs) {
  let identity = path.resolve(root);
  try { identity = fs.realpathSync(identity); } catch { /* validation below names missing roots */ }
  return process.platform === 'win32' ? identity.toLowerCase() : identity;
}
function copyAtomic(fs, source, destination) {
  const data = fs.readFileSync(source, 'utf8'); if (!managed(data)) throw new Error('saved ChatGPT session is invalid');
  const temp = `${destination}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  // Nothing that can fail follows rename: once replacement occurs, persistence succeeded.
  // This keeps every reported failure on the side where the prior durable file still exists.
  fs.writeFileSync(temp, data, { mode: 0o600 }); fs.chmodSync(temp, 0o600); fs.renameSync(temp, destination);
}
async function preflight(opts = {}) {
  if (opts.mode !== 'chatgpt') return { ok: true, cacheRoot: opts.cacheRoot || cacheDefault() };
  const fs = opts.fs || nodeFs;
  // An explicit roster means every root is already an independently authenticated private
  // lane. Never seed one roster entry from the ambient login: doing so would clone the one
  // refresh token while presenting it as independent authentication.
  if (opts.cacheRoots !== undefined) {
    const roots = Array.isArray(opts.cacheRoots) ? opts.cacheRoots : [];
    const lanes = [];
    const quarantined = [];
    const identities = new Set();
    for (let index = 0; index < roots.length; index += 1) {
      const root = path.resolve(roots[index]);
      const item = { id: `lane-${index + 1}`, cacheRoot: root, healthy: false };
      try {
        const identity = laneIdentity(root, fs);
        if (identities.has(identity)) throw new Error('lane-duplicate');
        identities.add(identity);
        await withCacheLock({ ...opts, fs, cacheRoot: root, wait: false }, async () => {
          ensureDir(fs, root);
          const durable = authFile(root);
          if (!fs.existsSync(durable) || !managed(fs.readFileSync(durable, 'utf8'))) {
            throw new Error('lane-invalid');
          }
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
    return {
      ok: healthyLaneCount > 0,
      lanes,
      healthyLaneCount,
      quarantined,
      ...(healthyLaneCount ? {} : { reason: 'No healthy independently authenticated ChatGPT credential lane is available.' }),
    };
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

// Host-side scheduler for credential and credential-free stages. Credential jobs use one
// FIFO admission queue and one independently locked lane each. Free stages have independent
// caps and deliberately receive no lane data at all.
function createLanePool(opts = {}) {
  const onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : () => {};
  const stageCaps = opts.stageCaps && typeof opts.stageCaps === 'object' ? opts.stageCaps : {};
  const identities = new Set();
  const lanes = (Array.isArray(opts.lanes) ? opts.lanes : []).map((item, index) => {
    const identity = item && item.cacheRoot ? laneIdentity(item.cacheRoot, opts.fs || nodeFs) : null;
    const distinct = !!identity && !identities.has(identity);
    if (identity) identities.add(identity);
    return {
      id: item && item.id || `lane-${index + 1}`,
      cacheRoot: item && item.cacheRoot,
      state: item && item.healthy && distinct ? 'healthy' : 'quarantined',
      retained: null,
    };
  });
  const credentialQueue = [];
  const freeQueues = new Map();
  const freeActive = new Map();
  const laneIo = {
    ...(opts.fs ? { fs: opts.fs } : {}),
    ...(opts.retryMs !== undefined ? { retryMs: opts.retryMs } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  };

  function emit(type, lane, job, reason) {
    try { onEvent({ type, laneId: lane && lane.id, jobId: job && job.id,
      ...(reason ? { reason } : {}) }); } catch { /* observation cannot break ownership */ }
  }
  function snapshot() {
    const healthy = lanes.filter((lane) => lane.state === 'healthy' || lane.state === 'busy');
    return {
      healthyLaneCount: healthy.length,
      quarantined: lanes.filter((lane) => lane.state === 'quarantined').map((lane) => ({ id: lane.id })),
      queuedCredentialCount: credentialQueue.length,
    };
  }
  function rejectUnserviceable() {
    if (lanes.some((lane) => lane.state === 'healthy' || lane.state === 'busy')) return;
    while (credentialQueue.length) credentialQueue.shift().reject(new Error('No healthy ChatGPT credential lane is available'));
  }
  function pumpCredential() {
    for (;;) {
      const lane = lanes.find((candidate) => candidate.state === 'healthy');
      const queued = credentialQueue.shift();
      if (!lane || !queued) {
        if (queued) credentialQueue.unshift(queued);
        rejectUnserviceable();
        return;
      }
      lane.state = 'busy';
      Promise.resolve().then(async () => {
        let handle = null; let value; let stageError = null; let workerError = null; let releaseError = null;
        try {
          handle = await stageTaskCache({ ...laneIo, cacheRoot: lane.cacheRoot, taskId: queued.job.id, wait: true });
        } catch (error) { stageError = error; }
        try {
          if (stageError) throw stageError;
          value = await queued.worker({ laneId: lane.id, cacheRoot: lane.cacheRoot, authCache: handle });
        } catch (error) { workerError = error; }
        if (handle) {
          try { await releaseTaskCache(handle); }
          catch (error) { releaseError = error; }
        }
        if (stageError || releaseError) {
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
        if (lane.retained) await releaseTaskCache(lane.retained);
        else {
          const checked = await preflight({ ...laneIo, mode: 'chatgpt', cacheRoots: [lane.cacheRoot] });
          if (!checked.ok) continue;
        }
        lane.retained = null; lane.state = 'healthy'; recovered.push(lane.id);
        emit('lane.recovered', lane, null);
      } catch { /* retained evidence remains available for the next repair attempt */ }
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
        const safe = String(opts.taskId || "task").replace(/[^a-zA-Z0-9_.-]/g, "_"); const hostPath = path.join(root, "tasks", `${safe}-${process.pid}-${Math.random().toString(16).slice(2)}`);
        ensureDir(fs, path.join(root, "tasks")); ensureDir(fs, hostPath); copyAtomic(fs, durable, authFile(hostPath));
        return { hostPath, containerPath: opts.containerPath || "/root/.codex", mount: `${hostPath}:${opts.containerPath || "/root/.codex"}:rw`, cacheRoot: root, fs, owner };
      } catch (e) { try { if (managedLock(fs, file)?.nonce === owner.nonce) fs.unlinkSync(file); } catch {} throw e; }
    } catch (e) {
      if (!e || e.code !== "EEXIST") throw e; const held = managedLock(fs, file); const stat = (() => { try { return fs.statSync(file); } catch { return null; } })(); const stale = opts.staleMs === undefined ? 30000 : opts.staleMs;
      if (held ? !alive(held) : stat && Date.now() - stat.mtimeMs > stale) { try { fs.unlinkSync(file); } catch {} continue; }
      if (!opts.wait && Date.now() - started >= timeout) throw new Error("ChatGPT credential lane is busy"); await sleep(retry);
    }
  }
}
async function releaseTaskCache(handle) {
  if (!handle) return; const fs = handle.fs || nodeFs; const durable = authFile(handle.cacheRoot); const task = authFile(handle.hostPath);
  let error;
  try { if (!managed(fs.readFileSync(task, 'utf8'))) throw new Error('refreshed task auth is invalid'); copyAtomic(fs, task, durable); fs.rmSync(handle.hostPath, { recursive: true, force: true }); }
  catch (e) { error = e; }
  finally { try { const file = lockPath(handle.cacheRoot); const owner = managedLock(fs, file); if (owner && handle.owner && owner.nonce === handle.owner.nonce) fs.unlinkSync(file); } catch {} }
  if (error) throw error;
}
module.exports = { AUTH_MODES, validateConfig, preflight, stageTaskCache, releaseTaskCache, withCacheLock, createLanePool };
