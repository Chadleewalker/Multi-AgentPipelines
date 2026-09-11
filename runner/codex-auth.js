// Managed ChatGPT authentication for trusted, headless Codex workers.
'use strict';
const nodeFs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const AUTH_MODES = ['chatgpt', 'api-key'];
const LOGIN = 'Codex ChatGPT authentication is unavailable — run `codex login` (device authentication) on the host.';
const BUSY = 'Codex ChatGPT credential lane is busy; wait for the active subscription worker to finish.';
function managed(text) { try { const v = JSON.parse(text); return v && v.auth_mode === 'chatgpt' && v.tokens && typeof v.tokens.refresh_token === 'string' && v.tokens.refresh_token.trim() ? v : null; } catch { return null; } }
function authFile(root) { return path.join(root, 'auth.json'); }
function defaultCacheRoot() { return path.join(os.homedir(), '.pipeline-codex-chatgpt'); }
function validateConfig(raw = {}) {
  const mode = raw.codexAuth === undefined ? 'api-key' : raw.codexAuth;
  if (!AUTH_MODES.includes(mode)) return { ok: false, reason: "codexAuth must be one of chatgpt | api-key" };
  return { ok: true, codexAuth: mode, credentialName: mode === 'api-key' ? 'CODEX_API_KEY' : null };
}
function mkdir(fs, dir) { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); try { fs.chmodSync(dir, 0o700); } catch {} }
function owner() { return { pid: process.pid, nonce: crypto.randomBytes(12).toString('hex'), createdAt: Date.now() }; }
function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e && e.code === 'EPERM'; } }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
async function withCacheLock(opts = {}, fn) {
  const fs = opts.fs || nodeFs; const root = opts.cacheRoot || defaultCacheRoot(); const file = path.join(root, '.credential.lock');
  const retry = opts.retryMs || 25; const timeout = opts.timeoutMs == null ? 1000 : opts.timeoutMs; const stale = opts.staleMs == null ? 30000 : opts.staleMs; const mine = owner(); const started = Date.now();
  mkdir(fs, root);
  for (;;) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600); fs.writeFileSync(fd, JSON.stringify(mine), 'utf8'); fs.closeSync(fd);
      let result;
      try { result = await fn({ lock: file, owner: mine }); return result; }
      finally { if (!(result && result.keepLock)) try { const current = managedLock(fs, file); if (current && current.nonce === mine.nonce) fs.unlinkSync(file); } catch {} }
    } catch (e) {
      if (!e || e.code !== 'EEXIST') throw e;
      const record = managedLock(fs, file); let recover = false;
      if (!record) { try { recover = Date.now() - fs.statSync(file).mtimeMs > stale; } catch {} }
      else if (!alive(record.pid)) recover = true;
      if (recover) { try { fs.unlinkSync(file); } catch {} continue; }
      if (opts.wait === false || Date.now() - started >= timeout) { const err = new Error(BUSY); err.code = 'CODEX_AUTH_BUSY'; throw err; }
      await sleep(retry);
    }
  }
}
function managedLock(fs, file) { try { const v = JSON.parse(fs.readFileSync(file, 'utf8')); return v && typeof v.pid === 'number' && v.nonce ? v : null; } catch { return null; } }
async function preflight(opts = {}) {
  if (opts.mode !== 'chatgpt') return { ok: true, cacheRoot: opts.cacheRoot || defaultCacheRoot() };
  const fs = opts.fs || nodeFs; const root = opts.cacheRoot || defaultCacheRoot(); const source = opts.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  try {
    return await withCacheLock({ ...opts, fs, cacheRoot: root }, async () => {
      const durable = authFile(root); let saved = null;
      if (fs.existsSync(durable)) saved = managed(fs.readFileSync(durable, 'utf8'));
      if (fs.existsSync(durable) && !saved) return { ok: false, reason: LOGIN };
      if (!saved) {
        const seed = (() => { try { return managed(fs.readFileSync(authFile(source), 'utf8')); } catch { return null; } })();
        if (!seed) return { ok: false, reason: LOGIN };
        mkdir(fs, root); const tmp = `${durable}.${process.pid}.seed`; fs.writeFileSync(tmp, JSON.stringify(seed), { mode: 0o600 }); fs.chmodSync(tmp, 0o600); fs.renameSync(tmp, durable); fs.chmodSync(durable, 0o600);
      }
      return { ok: true, cacheRoot: root };
    });
  } catch (e) { return { ok: false, reason: e && e.code === 'CODEX_AUTH_BUSY' ? BUSY : LOGIN }; }
}
async function stageTaskCache(opts = {}) {
  const fs = opts.fs || nodeFs; const root = opts.cacheRoot || defaultCacheRoot();
  return withCacheLock({ ...opts, fs, cacheRoot: root, wait: opts.wait !== false, timeoutMs: opts.wait ? undefined : opts.timeoutMs }, async (lease) => {
    const durable = authFile(root); let value = (() => { try { return managed(fs.readFileSync(durable, 'utf8')); } catch { return null; } })();
    if (!value && opts.codexHome) { try { value = managed(fs.readFileSync(authFile(opts.codexHome), "utf8")); if (value) { mkdir(fs, root); fs.writeFileSync(durable, JSON.stringify(value), { mode: 0o600 }); fs.chmodSync(durable, 0o600); } } catch {} }
    if (!value) throw new Error(LOGIN);
    const safe = String(opts.taskId || 'task').replace(/[^A-Za-z0-9._-]/g, '_'); const tasks = path.join(root, 'tasks'); mkdir(fs, tasks);
    const task = path.join(tasks, `${safe}-${crypto.randomBytes(8).toString('hex')}`); mkdir(fs, task);
    try { fs.writeFileSync(authFile(task), JSON.stringify(value), { mode: 0o600 }); fs.chmodSync(authFile(task), 0o600); }
    catch (e) { try { fs.rmSync(task, { recursive: true, force: true }); } catch {} throw e; }
    // Keep lock open beyond this callback; releaseTaskCache performs the owner-aware unlock.
    return { hostPath: task, containerPath: opts.containerPath || "/root/.codex", mount: task + ":/run/pipeline-auth-host/cache:rw", cacheRoot: root, lock: lease.lock, owner: lease.owner, fs, cleanup: true, keepLock: true };
  });
}
async function releaseTaskCache(handle) {
  if (!handle) return; const fs = handle.fs || nodeFs; const taskAuth = authFile(handle.hostPath); const durable = authFile(handle.cacheRoot);
  let error = null;
  try {
    const value = managed(fs.readFileSync(taskAuth, 'utf8')); if (!value) throw new Error('task ChatGPT auth is malformed; preserved for recovery');
    const temp = `${durable}.${process.pid}.refresh`; fs.writeFileSync(temp, JSON.stringify(value), { mode: 0o600 }); fs.chmodSync(temp, 0o600); fs.renameSync(temp, durable); fs.chmodSync(durable, 0o600);
    fs.rmSync(handle.hostPath, { recursive: true, force: true });
  } catch (e) { error = e; }
  try { const current = managedLock(fs, handle.lock); if (current && handle.owner && current.nonce === handle.owner.nonce) fs.unlinkSync(handle.lock); } catch {}
  if (error) throw error;
}
module.exports = { AUTH_MODES, validateConfig, preflight, stageTaskCache, releaseTaskCache, withCacheLock, defaultCacheRoot };
