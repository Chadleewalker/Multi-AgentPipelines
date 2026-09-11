// Private, refreshable ChatGPT authentication lane for trusted Codex workers.
'use strict';
const fs0 = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const AUTH_MODES = ['chatgpt', 'api-key'];
const loginReason = 'no usable managed ChatGPT session — run `codex login` and complete device authentication';
function fsOf(opts) { return (opts && opts.fs) || fs0; }
function cacheRootOf(opts) { return path.resolve((opts && opts.cacheRoot) || process.env.PIPELINE_CODEX_CACHE || path.join(os.homedir(), '.pipeline-codex-chatgpt')); }
function authFile(root) { return path.join(root, 'auth.json'); }
function managed(value) { return !!(value && value.auth_mode === 'chatgpt' && value.tokens && typeof value.tokens.refresh_token === 'string' && value.tokens.refresh_token.trim()); }
function readManaged(file, f = fs0) { try { return managed(JSON.parse(f.readFileSync(file, 'utf8'))); } catch { return false; } }
function secureDir(dir, f) { f.mkdirSync(dir, { recursive: true, mode: 0o700 }); f.chmodSync(dir, 0o700); }
function copySecure(from, to, f) { const data = f.readFileSync(from); const fd = f.openSync(to, 'w', 0o600); try { f.writeFileSync(fd, data); } finally { f.closeSync(fd); } f.chmodSync(to, 0o600); }
function alive(owner) { if (!owner || !Number.isInteger(owner.pid) || owner.pid <= 0) return false; try { process.kill(owner.pid, 0); return true; } catch (e) { return e && e.code === 'EPERM'; } }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function withCacheLock(opts, fn) {
  const f = fsOf(opts); const root = cacheRootOf(opts); const lock = `${root}.lock`;
  const retryMs = Number(opts && opts.retryMs) || 40; const timeoutMs = opts && opts.timeoutMs;
  const waitForever = !!(opts && opts.wait); const started = Date.now(); const nonce = crypto.randomBytes(16).toString('hex');
  secureDir(path.dirname(lock), f);
  for (;;) {
    try {
      const fd = f.openSync(lock, 'wx', 0o600);
      try { f.writeFileSync(fd, JSON.stringify({ pid: process.pid, nonce, startedAt: new Date().toISOString() })); }
      finally { f.closeSync(fd); }
      try { return await fn(); }
      finally {
        try { const owner = JSON.parse(f.readFileSync(lock, 'utf8')); if (owner && owner.nonce === nonce) f.unlinkSync(lock); } catch { /* successor or interrupted owner */ }
      }
    } catch (e) {
      if (!e || e.code !== 'EEXIST') throw e;
      let owner = null; try { owner = JSON.parse(f.readFileSync(lock, 'utf8')); } catch { /* malformed is recoverable */ }
      if (!alive(owner)) { try { f.unlinkSync(lock); } catch { /* another waiter recovered it */ } continue; }
      if (!waitForever && timeoutMs !== undefined && Date.now() - started >= timeoutMs) throw new Error('ChatGPT credential lane is busy; wait for the active worker to finish');
      await sleep(retryMs);
    }
  }
}

function validateConfig(raw) {
  if (!raw || raw.provider !== 'codex') return { ...raw, codexAuth: raw && raw.codexAuth || 'api-key' };
  const mode = raw.codexAuth === undefined || raw.codexAuth === null ? 'api-key' : raw.codexAuth;
  if (!AUTH_MODES.includes(mode)) return { ok: false, reason: `run.config.json: 'codexAuth' must be one of ${AUTH_MODES.join(' | ')}` };
  const clean = { ...raw }; delete clean.CODEX_API_KEY;
  return { ...clean, codexAuth: mode, ...(mode === 'chatgpt' ? { credentialName: null } : {}) };
}

async function preflight(opts = {}) {
  if (opts.mode !== 'chatgpt') return { ok: true, cacheRoot: cacheRootOf(opts) };
  const f = fsOf(opts); const root = cacheRootOf(opts); const source = path.join(opts.codexHome || (opts.env && opts.env.CODEX_HOME) || process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'auth.json');
  try {
    return await withCacheLock({ ...opts, cacheRoot: root }, async () => {
      secureDir(root, f); const durable = authFile(root);
      if (!f.existsSync(durable)) {
        if (!readManaged(source, f)) return { ok: false, reason: loginReason };
        copySecure(source, durable, f);
      }
      if (!readManaged(durable, f)) return { ok: false, reason: loginReason };
      f.chmodSync(durable, 0o600);
      return { ok: true, cacheRoot: root };
    });
  } catch (e) { return { ok: false, busy: true, reason: e && e.message ? e.message : 'ChatGPT credential lane is busy; wait for the active worker' }; }
}

async function stageTaskCache(opts = {}) {
  const f = fsOf(opts); const root = cacheRootOf(opts);
  return withCacheLock({ ...opts, cacheRoot: root, wait: opts.wait !== false }, async () => {
    const durable = authFile(root); if (!readManaged(durable, f)) throw new Error(loginReason);
    const tasks = path.join(root, 'tasks'); secureDir(tasks, f);
    const hostPath = path.join(tasks, `${String(opts.taskId || 'task').replace(/[^A-Za-z0-9_.-]/g, '-')}-${crypto.randomBytes(8).toString('hex')}`);
    secureDir(hostPath, f); copySecure(durable, authFile(hostPath), f);
    // Keep the lock until releaseTaskCache: this is one credential lane, not a copy pool.
    return { hostPath, containerPath: opts.containerPath || '/root/.codex', mount: `${hostPath}:${opts.containerPath || '/root/.codex'}:rw`, cacheRoot: root, _lock: { nonce: null } };
  });
}

// stageTaskCache needs a lease that survives its callback. Acquire it separately so callers
// cannot accidentally receive concurrent auth copies.
const originalStage = stageTaskCache;
async function stageTaskCacheLeased(opts = {}) {
  const f = fsOf(opts); const root = cacheRootOf(opts); const lock = `${root}.lock`; const retryMs = Number(opts.retryMs) || 40; const timeoutMs = opts.timeoutMs; const nonce = crypto.randomBytes(16).toString('hex'); const started = Date.now(); secureDir(path.dirname(lock), f);
  for (;;) { try { const fd = f.openSync(lock, 'wx', 0o600); try { f.writeFileSync(fd, JSON.stringify({ pid: process.pid, nonce })); } finally { f.closeSync(fd); } break; } catch (e) { if (e.code !== 'EEXIST') throw e; let owner; try { owner=JSON.parse(f.readFileSync(lock,'utf8')); } catch {} if (!alive(owner)) { try { f.unlinkSync(lock); } catch {} continue; } if (!opts.wait && timeoutMs !== undefined && Date.now()-started >= timeoutMs) throw new Error('ChatGPT credential lane is busy; wait for the active worker to finish'); await sleep(retryMs); } }
  try { const durable=authFile(root); if (!f.existsSync(durable) && opts.codexHome && readManaged(path.join(opts.codexHome, 'auth.json'), f)) { secureDir(root, f); copySecure(path.join(opts.codexHome, 'auth.json'), durable, f); } if (!readManaged(durable,f)) throw new Error(loginReason); const tasks=path.join(root,'tasks'); secureDir(tasks,f); const hostPath=path.join(tasks,`${String(opts.taskId||'task').replace(/[^A-Za-z0-9_.-]/g,'-')}-${crypto.randomBytes(8).toString('hex')}`); secureDir(hostPath,f); copySecure(durable,authFile(hostPath),f); const containerPath=opts.containerPath||'/root/.codex'; return {hostPath,containerPath,mount:`${hostPath}:${containerPath}:rw`,cacheRoot:root,_lock:{lock,nonce}}; } catch (e) { try { f.unlinkSync(lock); } catch {} throw e; }
}
async function releaseTaskCache(handle) {
  if (!handle) return; const f = handle.fs || fs0; const taskAuth = authFile(handle.hostPath); const durable = authFile(handle.cacheRoot);
  try {
    if (!readManaged(taskAuth, f)) throw new Error('task ChatGPT auth is malformed; task cache preserved for recovery');
    const tmp = `${durable}.tmp-${crypto.randomBytes(8).toString('hex')}`; copySecure(taskAuth, tmp, f); f.renameSync(tmp, durable); f.chmodSync(durable, 0o600); f.rmSync(handle.hostPath, { recursive: true, force: true });
  } finally {
    if (handle._lock) { try { const owner=JSON.parse(f.readFileSync(handle._lock.lock,'utf8')); if(owner && owner.nonce===handle._lock.nonce) f.unlinkSync(handle._lock.lock); } catch {} }
  }
}
module.exports = { AUTH_MODES, validateConfig, preflight, stageTaskCache: stageTaskCacheLeased, releaseTaskCache, withCacheLock };
