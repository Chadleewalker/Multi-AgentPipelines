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
function copyAtomic(fs, source, destination) {
  const data = fs.readFileSync(source, 'utf8'); if (!managed(data)) throw new Error('saved ChatGPT session is invalid');
  const temp = `${destination}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  fs.writeFileSync(temp, data, { mode: 0o600 }); fs.chmodSync(temp, 0o600); fs.renameSync(temp, destination); fs.chmodSync(destination, 0o600);
}
async function preflight(opts = {}) {
  if (opts.mode !== 'chatgpt') return { ok: true, cacheRoot: opts.cacheRoot || cacheDefault() };
  const fs = opts.fs || nodeFs; const root = path.resolve(opts.cacheRoot || cacheDefault()); const codexHome = opts.codexHome || path.join(os.homedir(), '.codex'); const source = authFile(codexHome);
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
module.exports = { AUTH_MODES, validateConfig, preflight, stageTaskCache, releaseTaskCache, withCacheLock };
