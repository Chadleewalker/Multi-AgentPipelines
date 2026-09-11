// Managed ChatGPT authentication for trusted, headless Codex workers.
'use strict';
const crypto = require('crypto');
const nativeFs = require('fs');
const os = require('os');
const path = require('path');

const AUTH_MODES = ['chatgpt', 'api-key'];
const defaultCacheRoot = () => path.join(os.homedir(), '.pipeline-codex-auth');
const pause = (ms) => new Promise(resolve => setTimeout(resolve, ms));
function managed(text) {
  try {
    const value = JSON.parse(text);
    return value && value.auth_mode === 'chatgpt' && value.tokens
      && typeof value.tokens.refresh_token === 'string' && value.tokens.refresh_token.trim() ? value : null;
  } catch { return null; }
}
function validateConfig(raw = {}) {
  const mode = raw.codexAuth === undefined ? 'api-key' : raw.codexAuth;
  if (!AUTH_MODES.includes(mode)) return { ok: false, reason: "codexAuth must be 'chatgpt' or 'api-key'" };
  return { ok: true, codexAuth: mode, credentialName: mode === 'api-key' ? 'CODEX_API_KEY' : null };
}
function secureDir(fs, dir) { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); fs.chmodSync(dir, 0o700); }
function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e && e.code === 'EPERM'; } }
function lockPath(root) { return path.join(root, '.lock'); }
async function acquire(opts = {}) {
  const fs = opts.fs || nativeFs; const root = path.resolve(opts.cacheRoot || defaultCacheRoot());
  const retryMs = opts.retryMs || 25; const timeoutMs = opts.timeoutMs || 1000; const wait = opts.wait === true;
  const staleMs = opts.staleMs === undefined ? 30000 : opts.staleMs; const started = Date.now();
  secureDir(fs, root); const file = lockPath(root); const nonce = crypto.randomBytes(16).toString('hex');
  for (;;) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, nonce, createdAt: Date.now() })); }
      finally { fs.closeSync(fd); }
      fs.chmodSync(file, 0o600);
      return { fs, root, file, nonce };
    } catch (e) {
      if (!e || e.code !== 'EEXIST') throw e;
      let owner = null; let stat = null;
      try { stat = fs.statSync(file); owner = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* initializing */ }
      const age = stat ? Date.now() - stat.mtimeMs : 0;
      // Age is only an initialization grace for malformed records. A parsable live PID is never stolen.
      const recover = owner && Number.isInteger(owner.pid) ? !alive(owner.pid) : age > staleMs;
      if (recover) {
        try { fs.unlinkSync(file); } catch (unlinkError) { if (!unlinkError || unlinkError.code !== 'ENOENT') throw unlinkError; }
        continue;
      }
      if (!wait && Date.now() - started >= timeoutMs) throw new Error('ChatGPT credential lane is busy; wait for the active worker');
      if (!wait && Date.now() - started >= timeoutMs) throw new Error('ChatGPT credential lane is busy');
      await pause(retryMs);
    }
  }
}
function releaseLock(lock) {
  try {
    const owner = JSON.parse(lock.fs.readFileSync(lock.file, 'utf8'));
    if (owner && owner.nonce === lock.nonce) lock.fs.unlinkSync(lock.file);
  } catch (e) { if (!e || e.code !== 'ENOENT') throw e; }
}
async function withCacheLock(opts, fn) { const lock = await acquire(opts); try { return await fn(); } finally { releaseLock(lock); } }
function authFile(root) { return path.join(root, 'auth.json'); }
function readManaged(fs, file) { try { return managed(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function atomicWrite(fs, target, text) {
  const temp = `${target}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try { fs.writeFileSync(temp, text, { mode: 0o600 }); fs.chmodSync(temp, 0o600); fs.renameSync(temp, target); fs.chmodSync(target, 0o600); }
  catch (e) { try { fs.unlinkSync(temp); } catch {} throw e; }
}
async function preflight(opts = {}) {
  if (opts.mode !== 'chatgpt') return { ok: true, cacheRoot: opts.cacheRoot || defaultCacheRoot() };
  const fs = opts.fs || nativeFs; const root = path.resolve(opts.cacheRoot || defaultCacheRoot());
  try {
    await withCacheLock({ ...opts, fs, cacheRoot: root, wait: false }, async () => {
      const durable = authFile(root);
      if (fs.existsSync(durable)) {
        if (!readManaged(fs, durable)) throw new Error('LOGIN');
        fs.chmodSync(durable, 0o600); return;
      }
      const seed = authFile(opts.codexHome || path.join(os.homedir(), '.codex'));
      const value = readManaged(fs, seed);
      if (!value) throw new Error('LOGIN');
      secureDir(fs, root); atomicWrite(fs, durable, JSON.stringify(value));
    });
    return { ok: true, cacheRoot: root };
  } catch (e) {
    if (/busy|lane/i.test(e && e.message)) return { ok: false, reason: 'ChatGPT credential lane is busy; wait for the active worker' };
    return { ok: false, reason: 'Run codex login to complete ChatGPT device authentication before starting workers.' };
  }
}
function safeTaskId(id) { return String(id || 'task').replace(/[^A-Za-z0-9_.-]/g, '-'); }
async function stageTaskCache(opts = {}) {
  const fs = opts.fs || nativeFs; const root = path.resolve(opts.cacheRoot || defaultCacheRoot());
  const lock = await acquire({ ...opts, fs, cacheRoot: root, wait: opts.wait === true });
  try {
    const durable = authFile(root); let value = readManaged(fs, durable);
    if (!value && !fs.existsSync(durable) && opts.codexHome) {
      value = readManaged(fs, authFile(opts.codexHome));
      if (value) atomicWrite(fs, durable, JSON.stringify(value));
    }
    if (!value) throw new Error('managed ChatGPT durable auth is missing or invalid');
    const tasks = path.join(root, 'tasks'); secureDir(fs, tasks);
    const hostPath = path.join(tasks, `${safeTaskId(opts.taskId)}-${crypto.randomBytes(8).toString('hex')}`);
    secureDir(fs, hostPath); atomicWrite(fs, authFile(hostPath), JSON.stringify(value));
    return { hostPath, containerPath: opts.containerPath || '/root/.codex', mount: `${hostPath}:${opts.containerPath || '/root/.codex'}:rw`, cacheRoot: root, fs, lock };
  } catch (e) { try { releaseLock(lock); } catch {} throw e; }
}
async function releaseTaskCache(handle) {
  const fs = handle.fs || nativeFs;
  let error = null;
  try {
    const file = authFile(handle.hostPath); const value = readManaged(fs, file);
    if (!value) throw new Error('managed task auth is invalid; task cache retained for recovery');
    atomicWrite(fs, authFile(handle.cacheRoot), JSON.stringify(value));
    fs.rmSync(handle.hostPath, { recursive: true, force: true });
  } catch (e) { error = e; }
  try { releaseLock(handle.lock || { fs, file: lockPath(handle.cacheRoot), nonce: '' }); } catch (e) { if (!error) error = e; }
  if (error) throw error;
}
module.exports = { AUTH_MODES, validateConfig, preflight, stageTaskCache, releaseTaskCache, withCacheLock };
