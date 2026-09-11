'use strict';

// A saved ChatGPT session is a single credential lane.  The durable copy is host-private;
// containers only ever receive a task copy while holding this lock.
const fsNative = require('fs');
const path = require('path');
const os = require('os');

const AUTH_MODES = ['api-key', 'chatgpt'];
const authFile = (root) => path.join(root, 'auth.json');
const lockFile = (root) => path.join(root, '.codex-chatgpt.lock');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function validateConfig(raw = {}) {
  if (raw.provider !== 'codex') return { ok: true, codexAuth: raw.codexAuth || 'api-key' };
  const codexAuth = raw.codexAuth === undefined ? 'api-key' : raw.codexAuth;
  if (!AUTH_MODES.includes(codexAuth)) return { ok: false, reason: "run.config.json: 'codexAuth' must be one of chatgpt | api-key" };
  return { ok: true, codexAuth, credentialName: codexAuth === 'api-key' ? 'CODEX_API_KEY' : null };
}

function managed(text) {
  try {
    const value = JSON.parse(text);
    return value && value.auth_mode === 'chatgpt' && value.tokens
      && typeof value.tokens.refresh_token === 'string' && value.tokens.refresh_token.trim() ? value : null;
  } catch { return null; }
}
function secureDir(fs, dir) { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); fs.chmodSync(dir, 0o700); }
function secureFile(fs, file, value) {
  const fd = fs.openSync(file, 'w', 0o600); try { fs.writeFileSync(fd, value); } finally { fs.closeSync(fd); }
  fs.chmodSync(file, 0o600);
}
function ownerAlive(owner) {
  if (!owner || !Number.isInteger(owner.pid) || owner.pid <= 0) return false;
  try { process.kill(owner.pid, 0); return true; } catch (e) { return e && e.code === 'EPERM'; }
}
async function withCacheLock(opts, fn) {
  const fs = opts.fs || fsNative; const root = opts.cacheRoot; const retry = opts.retryMs || 25;
  const timeout = opts.timeoutMs === undefined ? 1000 : opts.timeoutMs; const stale = opts.staleMs === undefined ? 30000 : opts.staleMs;
  secureDir(fs, root); const file = lockFile(root); const owner = { pid: process.pid, nonce: `${process.pid}-${Date.now()}-${Math.random()}` };
  const started = Date.now();
  for (;;) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600); fs.writeFileSync(fd, JSON.stringify(owner)); fs.closeSync(fd); fs.chmodSync(file, 0o600);
      let result;
      try { result = await fn(owner); return result; }
      finally {
        if (!(result && result._keepLock)) {
          try { const current = JSON.parse(fs.readFileSync(file, 'utf8')); if (current && current.nonce === owner.nonce) fs.unlinkSync(file); } catch { /* successor or broken record */ }
        }
      }
    } catch (e) {
      if (!e || e.code !== 'EEXIST') throw e;
      let text = ''; let stat = null; try { text = fs.readFileSync(file, 'utf8'); stat = fs.statSync(file); } catch { continue; }
      let existing = null; try { existing = JSON.parse(text); } catch { /* initialization record */ }
      const old = stat && Date.now() - stat.mtimeMs > stale;
      // Never take a live owner's lock due to age. An incomplete record has no liveness
      // proof, but gets an initialization grace before recovery.
      if ((existing && !ownerAlive(existing)) || (!existing && old)) { try { fs.unlinkSync(file); } catch {} continue; }
      if (Date.now() - started >= timeout) throw new Error('ChatGPT credential lane is busy; wait for the active Codex worker');
      await sleep(retry);
    }
  }
}
async function preflight(opts = {}) {
  if (opts.mode !== 'chatgpt') return { ok: true };
  const fs = opts.fs || fsNative; const source = authFile(opts.codexHome || path.join(os.homedir(), '.codex'));
  let seed; try { seed = fs.readFileSync(source, 'utf8'); } catch { return { ok: false, reason: 'run codex login (device authentication) before using ChatGPT workers' }; }
  if (!managed(seed)) return { ok: false, reason: 'run codex login (device authentication) before using ChatGPT workers' };
  try {
    return await withCacheLock(opts, async () => {
      const durable = authFile(opts.cacheRoot);
      if (fs.existsSync(durable)) { if (!managed(fs.readFileSync(durable, 'utf8'))) return { ok: false, reason: 'run codex login (device authentication) before using ChatGPT workers' }; }
      else secureFile(fs, durable, seed);
      return { ok: true, cacheRoot: opts.cacheRoot };
    });
  } catch (e) { return { ok: false, reason: e.message || 'ChatGPT credential lane is busy' }; }
}
async function stageTaskCache(opts = {}) {
  const fs = opts.fs || fsNative; const root = opts.cacheRoot; const taskRoot = path.join(root, 'tasks');
  const acquire = () => withCacheLock({ ...opts, timeoutMs: opts.wait ? 0x7fffffff : opts.timeoutMs }, async (owner) => {
    const durable = authFile(root); let text;
    try { text = fs.readFileSync(durable, 'utf8'); } catch {
      const source = authFile(opts.codexHome || path.join(os.homedir(), '.codex')); text = fs.readFileSync(source, 'utf8');
      if (!managed(text)) throw new Error('run codex login (device authentication) before using ChatGPT workers'); secureFile(fs, durable, text);
    }
    if (!managed(text)) throw new Error('managed ChatGPT auth is invalid');
    secureDir(fs, taskRoot); const hostPath = path.join(taskRoot, `${opts.taskId || 'task'}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    secureDir(fs, hostPath); secureFile(fs, authFile(hostPath), text);
    return { hostPath, containerPath: opts.containerPath || '/root/.codex', mount: `${hostPath}:${opts.containerPath || '/root/.codex'}:rw`, cacheRoot: root, _keepLock: true, lockNonce: owner.nonce, fs };
  });
  return acquire();
}
async function releaseTaskCache(handle) {
  const fs = handle.fs || fsNative; const candidate = authFile(handle.hostPath); let text;
  try { text = fs.readFileSync(candidate, 'utf8'); } catch (e) { throw e; }
  if (!managed(text)) {
    try { const current = JSON.parse(fs.readFileSync(lockFile(handle.cacheRoot), 'utf8')); if (current && current.nonce === handle.lockNonce) fs.unlinkSync(lockFile(handle.cacheRoot)); } catch {}
    throw new Error('task ChatGPT auth is invalid; task cache preserved for recovery');
  }
  const tmp = `${authFile(handle.cacheRoot)}.tmp-${process.pid}-${Date.now()}`;
  try { secureFile(fs, tmp, text); fs.renameSync(tmp, authFile(handle.cacheRoot)); fs.chmodSync(authFile(handle.cacheRoot), 0o600); fs.rmSync(handle.hostPath, { recursive: true, force: true }); }
  catch (e) { try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {} throw e; }
  finally { try { const file = lockFile(handle.cacheRoot); const current = JSON.parse(fs.readFileSync(file, 'utf8')); if (current && current.nonce === handle.lockNonce) fs.unlinkSync(file); } catch {} }
}
module.exports = { AUTH_MODES, validateConfig, preflight, stageTaskCache, releaseTaskCache, withCacheLock };
