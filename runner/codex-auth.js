// Managed ChatGPT authentication for isolated Codex tasks.  The durable cache is host
// private; each task gets a short-lived copy while an exclusive lane lock is held.
'use strict';
const fs0 = require('fs');
const os = require('os');
const path = require('path');

const AUTH_MODES = ['chatgpt', 'api-key'];
const defaultCacheRoot = () => path.join(os.homedir(), '.pipeline', 'codex-chatgpt');
const managed = (value) => !!(value && value.auth_mode === 'chatgpt' && value.tokens
  && typeof value.tokens.refresh_token === 'string' && value.tokens.refresh_token.trim());
function readAuth(file, fs = fs0) { try { const value = JSON.parse(fs.readFileSync(file, 'utf8')); return managed(value) ? value : null; } catch { return null; } }
function chmod(fs, file, mode) { try { fs.chmodSync(file, mode); } catch {} }
function ensureDir(fs, dir) { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); chmod(fs, dir, 0o700); }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function lockPath(root) { return `${path.resolve(root)}.lock`; }
function ownerAlive(owner) { try { process.kill(owner.pid, 0); return true; } catch (e) { return e && e.code === 'EPERM'; } }

async function withCacheLock(opts, fn) {
  const fs = opts.fs || fs0; const root = path.resolve(opts.cacheRoot || defaultCacheRoot());
  const file = lockPath(root); const retryMs = opts.retryMs || 25; const timeoutMs = opts.timeoutMs == null ? 1000 : opts.timeoutMs;
  const staleMs = opts.staleMs == null ? 30000 : opts.staleMs; const wait = opts.wait === true;
  fs.mkdirSync(path.dirname(root), { recursive: true, mode: 0o700 }); const started = Date.now(); const owner = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  for (;;) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, owner, createdAt: Date.now() }), 'utf8'); } finally { fs.closeSync(fd); }
      chmod(fs, file, 0o600);
      let released = false;
      const release = () => { if (released) return; released = true; try { const record = JSON.parse(fs.readFileSync(file, 'utf8')); if (record.owner === owner) fs.unlinkSync(file); } catch {} };
      try { return await fn(); } finally { release(); }
    } catch (e) {
      if (!e || e.code !== 'EEXIST') throw e;
      let record = null; let stat = null; try { record = JSON.parse(fs.readFileSync(file, 'utf8')); stat = fs.statSync(file); } catch { try { stat = fs.statSync(file); } catch {} }
      const old = !!stat && Date.now() - stat.mtimeMs > staleMs;
      // A well-formed live owner is never taken merely because it is old.
      if (record && Number.isInteger(record.pid) && ownerAlive(record)) { /* wait */ }
      else if (old) {
        // Unlink only the record we observed; an owner-aware rename/unlink race cannot remove a successor.
        try { const now = fs.readFileSync(file, 'utf8'); if ((!record && now === '{') || (record && now === JSON.stringify(record))) fs.unlinkSync(file); } catch {}
      }
      if (!wait && Date.now() - started >= timeoutMs) { const err = new Error('ChatGPT credential lane is busy; wait for the active worker'); err.code = 'CODEX_AUTH_BUSY'; throw err; }
      await sleep(retryMs);
    }
  }
}

function validateConfig(raw = {}) {
  const mode = raw.codexAuth == null ? 'api-key' : raw.codexAuth;
  if (!AUTH_MODES.includes(mode)) return { ok: false, reason: "codexAuth must be 'chatgpt' or 'api-key'" };
  return { ok: true, codexAuth: mode, credentialName: mode === 'api-key' ? 'CODEX_API_KEY' : null };
}
async function preflight(opts = {}) {
  if (opts.mode !== 'chatgpt') return { ok: true, cacheRoot: path.resolve(opts.cacheRoot || defaultCacheRoot()) };
  const fs = opts.fs || fs0; const root = path.resolve(opts.cacheRoot || defaultCacheRoot()); const durable = path.join(root, 'auth.json');
  try {
    return await withCacheLock({ ...opts, fs, cacheRoot: root }, async () => {
      if (fs.existsSync(durable)) {
        if (!readAuth(durable, fs)) return { ok: false, reason: 'saved ChatGPT session is invalid; run `codex login` with device authentication' };
        chmod(fs, durable, 0o600); return { ok: true, cacheRoot: root };
      }
      const seed = path.join(opts.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'auth.json');
      const auth = readAuth(seed, fs);
      if (!auth) return { ok: false, reason: 'no managed ChatGPT session; run `codex login` with device authentication' };
      ensureDir(fs, root);
      const temp = path.join(root, `.auth-${process.pid}-${Date.now()}`);
      fs.writeFileSync(temp, JSON.stringify(auth), { mode: 0o600 }); chmod(fs, temp, 0o600); fs.renameSync(temp, durable); chmod(fs, durable, 0o600);
      return { ok: true, cacheRoot: root };
    });
  } catch (e) { return { ok: false, reason: e && e.code === 'CODEX_AUTH_BUSY' ? e.message : 'ChatGPT credential lane is busy; wait for the active worker' }; }
}
async function stageTaskCache(opts = {}) {
  const fs = opts.fs || fs0; const root = path.resolve(opts.cacheRoot || defaultCacheRoot());
  let held = null;
  await withCacheLock({ ...opts, fs, cacheRoot: root, wait: opts.wait === true }, async () => {
    let auth = readAuth(path.join(root, 'auth.json'), fs);
    if (!auth && opts.codexHome) { auth = readAuth(path.join(opts.codexHome, 'auth.json'), fs); if (auth) { ensureDir(fs, root); fs.writeFileSync(path.join(root, 'auth.json'), JSON.stringify(auth), { mode: 0o600 }); chmod(fs, path.join(root, 'auth.json'), 0o600); } }
    if (!auth) throw new Error('managed ChatGPT durable auth is missing or invalid');
    const tasks = path.join(root, 'tasks'); ensureDir(fs, root); ensureDir(fs, tasks);
    const safeId = String(opts.taskId || 'task').replace(/[^A-Za-z0-9_.-]/g, '-'); const hostPath = path.join(tasks, `${safeId}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    ensureDir(fs, hostPath); const target = path.join(hostPath, 'auth.json'); fs.writeFileSync(target, JSON.stringify(auth), { mode: 0o600 }); chmod(fs, target, 0o600);
    held = { hostPath, cacheRoot: root, containerPath: opts.containerPath || '/root/.codex', mount: `${hostPath}:${opts.containerPath || '/root/.codex'}:rw`, lockHeld: true, fs };
    // Keep the lock beyond this callback by recreating it under a task-specific owner.
    // The task handle owns a separate exclusive lease; this short lock only serializes setup.
  });
  // Reacquire as a long lane. `wait:true` is deliberately unbounded for queued workers.
  // A simple durable task lock is held through releaseTaskCache; the lock filename is distinct
  // from bootstrap locking so preflight can provide bounded busy diagnostics.
  const lane = `${root}.lane`;
  const acquireLane = async () => {
    const start = Date.now(); for (;;) { try { const fd = fs.openSync(lane, 'wx', 0o600); fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, hostPath: held.hostPath }), 'utf8'); fs.closeSync(fd); chmod(fs, lane, 0o600); break; } catch (e) { if (e.code !== 'EEXIST') throw e; if (opts.wait !== true && Date.now() - start >= (opts.timeoutMs || 1000)) throw e; await sleep(opts.retryMs || 25); } }
  };
  try {
    await acquireLane();
    // A queued worker must copy after it owns the lane: an earlier worker may have
    // refreshed the durable session while this one waited.
    const refreshed = readAuth(path.join(root, 'auth.json'), fs);
    if (!refreshed) throw new Error('managed ChatGPT durable auth is missing or invalid');
    fs.writeFileSync(path.join(held.hostPath, 'auth.json'), JSON.stringify(refreshed), { mode: 0o600 });
    chmod(fs, path.join(held.hostPath, 'auth.json'), 0o600);
    held.lane = lane; return held;
  } catch (e) { try { fs.rmSync(held.hostPath, { recursive: true, force: true }); } catch {} throw e; }
}
async function releaseTaskCache(handle) {
  const fs = handle.fs || fs0; const durable = path.join(handle.cacheRoot, 'auth.json'); const taskAuth = path.join(handle.hostPath, 'auth.json');
  try {
    const auth = readAuth(taskAuth, fs); if (!auth) throw new Error('task ChatGPT auth is invalid; task cache preserved for recovery');
    const temp = path.join(handle.cacheRoot, `.auth-${process.pid}-${Date.now()}`); fs.writeFileSync(temp, JSON.stringify(auth), { mode: 0o600 }); chmod(fs, temp, 0o600); fs.renameSync(temp, durable); chmod(fs, durable, 0o600);
    fs.rmSync(handle.hostPath, { recursive: true, force: true });
  } finally { if (handle.lane) { try { fs.unlinkSync(handle.lane); } catch {} } }
}
module.exports = { AUTH_MODES, validateConfig, preflight, stageTaskCache, releaseTaskCache, withCacheLock };
