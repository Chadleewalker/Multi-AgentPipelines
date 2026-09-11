'use strict';
// Host-private managed ChatGPT session lane.  The durable cache is deliberately outside
// task workspaces; each task receives a fresh copy while holding this one exclusive lane.
const fsDefault = require('fs');
const path = require('path');
const crypto = require('crypto');

const AUTH_MODES = ['chatgpt', 'api-key'];
const LOGIN_REMEDY = 'no usable managed ChatGPT session — run codex login (device authentication) on the host';
function validateConfig(raw = {}) {
  const mode = raw.codexAuth === undefined || raw.codexAuth === null ? 'api-key' : raw.codexAuth;
  if (!AUTH_MODES.includes(mode)) return { ok: false, reason: `codexAuth must be one of ${AUTH_MODES.join(' | ')}` };
  const { CODEX_API_KEY, ...safe } = raw; return { ...safe, codexAuth: mode, credentialName: null };
}
function authFile(root) { return path.join(root, 'auth.json'); }
function managed(file, fs = fsDefault) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value && value.auth_mode === 'chatgpt' && value.tokens
      && typeof value.tokens.refresh_token === 'string' && value.tokens.refresh_token.trim() ? value : null;
  } catch { return null; }
}
function mkdirPrivate(fs, dir) { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); fs.chmodSync(dir, 0o700); }
function writeAtomic(fs, file, data) {
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  fs.writeFileSync(tmp, data, { mode: 0o600 }); fs.chmodSync(tmp, 0o600); fs.renameSync(tmp, file); fs.chmodSync(file, 0o600);
}
function ownerAlive(owner) { try { process.kill(owner.pid, 0); return true; } catch (e) { return e && e.code === 'EPERM'; } }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
async function withCacheLock(opts, fn) {
  const fs = opts.fs || fsDefault; const root = path.resolve(opts.cacheRoot); const lock = `${root}.lock`;
  const retryMs = opts.retryMs || 25; const timeoutMs = opts.timeoutMs == null ? 500 : opts.timeoutMs;
  const wait = opts.wait === true; const staleMs = opts.staleMs == null ? 30000 : opts.staleMs; const started = Date.now();
  mkdirPrivate(fs, root);
  const nonce = crypto.randomBytes(12).toString('hex');
  for (;;) {
    try {
      const fd = fs.openSync(lock, 'wx', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, nonce, startedAt: Date.now() })); } finally { fs.closeSync(fd); }
      let result;
      try { result = await fn({ lock, owner: { pid: process.pid, nonce } }); return result && result.__keepLock ? result.value : result; }
      finally {
        if (!(result && result.__keepLock)) try { const current = JSON.parse(fs.readFileSync(lock, 'utf8')); if (current && current.nonce === nonce) fs.unlinkSync(lock); } catch { /* successor or interrupted lock */ }
      }
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let owner = null; let stat = null; try { stat = fs.statSync(lock); } catch {} try { owner = JSON.parse(fs.readFileSync(lock, 'utf8')); } catch { /* initializing */ }
      const old = stat && Date.now() - stat.mtimeMs > staleMs;
      const dead = owner && Number.isInteger(owner.pid) && !ownerAlive(owner);
      if ((dead || (!owner && old)) && old) { try { fs.unlinkSync(lock); } catch {} continue; }
      if (!wait && Date.now() - started >= timeoutMs) throw new Error('ChatGPT credential lane is busy (lock in use)');
      await sleep(retryMs);
    }
  }
}
async function preflight(opts = {}) {
  if (opts.mode !== 'chatgpt') return { ok: true };
  const fs = opts.fs || fsDefault; const cacheRoot = path.resolve(opts.cacheRoot || process.env.PIPELINE_CODEX_CACHE || path.join(process.cwd(), '.pipeline-codex-cache'));
  try {
    return await withCacheLock({ ...opts, fs, cacheRoot }, async () => {
      const durable = authFile(cacheRoot);
      if (managed(durable, fs)) return { ok: true, cacheRoot };
      const source = authFile(opts.codexHome || process.env.CODEX_HOME || path.join(process.env.HOME || '', '.codex'));
      const seed = managed(source, fs);
      if (!seed) return { ok: false, reason: LOGIN_REMEDY };
      writeAtomic(fs, durable, JSON.stringify(seed));
      return { ok: true, cacheRoot };
    });
  } catch (e) { return { ok: false, reason: /busy|lock|lane/i.test(e.message) ? e.message : LOGIN_REMEDY }; }
}
async function stageTaskCache(opts = {}) {
  const fs = opts.fs || fsDefault; const cacheRoot = path.resolve(opts.cacheRoot); const taskId = String(opts.taskId || 'task').replace(/[^A-Za-z0-9_.-]/g, '-');
  const handle = await withCacheLock({ ...opts, fs, cacheRoot, wait: opts.wait === true }, async (lease) => {
    let data = managed(authFile(cacheRoot), fs);
    if (!data && opts.codexHome) { data = managed(authFile(opts.codexHome), fs); if (data) writeAtomic(fs, authFile(cacheRoot), JSON.stringify(data)); }
    if (!data) throw new Error(LOGIN_REMEDY);
    const hostPath = path.join(cacheRoot, "tasks", `${taskId}-${crypto.randomBytes(6).toString("hex")}`);
    mkdirPrivate(fs, path.join(cacheRoot, "tasks")); mkdirPrivate(fs, hostPath);
    writeAtomic(fs, authFile(hostPath), JSON.stringify(data));
    return { __keepLock: true, value: { hostPath, containerPath: opts.containerPath || "/root/.codex", mount: `${hostPath}:${opts.containerPath || "/root/.codex"}:rw`, cacheRoot, lockHeld: true, fs, lockFile: lease.lock, owner: lease.owner } };
  });
  return handle;
}
async function releaseTaskCache(handle) {
  const fs = handle.fs || fsDefault; const source = authFile(handle.hostPath); const data = managed(source, fs);
  if (!data) { releaseLock(handle, fs); throw new Error('task ChatGPT auth is malformed; task copy preserved for recovery'); }
  try { writeAtomic(fs, authFile(handle.cacheRoot), JSON.stringify(data)); }
  catch (e) { releaseLock(handle, fs); throw e; }
  try { fs.rmSync(handle.hostPath, { recursive: true, force: true }); } finally { releaseLock(handle, fs); }
}
function releaseLock(handle, fs) { try { const current = JSON.parse(fs.readFileSync(handle.lockFile, 'utf8')); if (current && handle.owner && current.nonce === handle.owner.nonce) fs.unlinkSync(handle.lockFile); } catch {} }
module.exports = { AUTH_MODES, validateConfig, preflight, stageTaskCache, releaseTaskCache, withCacheLock };
