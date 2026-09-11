// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0
'use strict';
const fs0 = require('fs');
const path = require('path');
const AUTH_MODES = ['api-key', 'chatgpt'];
const LOGIN_REMEDY = 'run `codex login` to complete device authentication, then retry';
function validateConfig(raw = {}) {
  const { CODEX_API_KEY, ...safe } = raw;
  raw = safe; const mode = raw.codexAuth == null ? 'api-key' : raw.codexAuth;
  if (raw.provider && String(raw.provider).toLowerCase() !== 'codex') return { ...raw, codexAuth: mode };
  if (!AUTH_MODES.includes(mode)) return { ok: false, reason: "codexAuth must be 'chatgpt' or 'api-key'" };
  return { ...raw, codexAuth: mode, credentialName: mode === 'api-key' ? 'CODEX_API_KEY' : null };
}
function managedAuth(file, fs = fs0) { try { const v = JSON.parse(fs.readFileSync(file, 'utf8')); return !!(v && v.auth_mode === 'chatgpt' && v.tokens && typeof v.tokens.refresh_token === 'string' && v.tokens.refresh_token.trim()); } catch { return false; } }
function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e && e.code === 'EPERM'; } }
async function acquire(opts) {
  const fs = opts.fs || fs0; const root = opts.cacheRoot; const retry = opts.retryMs || 25; const timeout = opts.timeoutMs == null ? 30000 : opts.timeoutMs;
  const lock = path.join(root, '.chatgpt-lane.lock'); const owner = `${process.pid}-${Date.now()}-${Math.random()}`; const end = Date.now() + timeout;
  fs.mkdirSync(root, { recursive: true });
  for (;;) {
    try { fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, owner }), { flag: 'wx', mode: 0o600 }); return { fs, lock, owner }; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let old; try { old = JSON.parse(fs.readFileSync(lock, 'utf8')); } catch { old = null; }
      // A clock is never evidence an owner died; only a dead PID is reclaimable.
      if (old && Number.isInteger(old.pid) && !alive(old.pid)) { try { fs.unlinkSync(lock); } catch {} continue; }
      if (Date.now() >= end) throw new Error('ChatGPT credential lane is busy; wait for its active worker');
      await delay(retry);
    }
  }
}
function release(state) { try { if (JSON.parse(state.fs.readFileSync(state.lock, 'utf8')).owner === state.owner) state.fs.unlinkSync(state.lock); } catch {} }
async function withCacheLock(opts, fn) { const state = await acquire(opts); try { return await fn(); } finally { release(state); } }
async function preflight(opts = {}) {
  if (opts.mode !== 'chatgpt') return { ok: true, cacheRoot: opts.cacheRoot };
  const fs = opts.fs || fs0; const root = opts.cacheRoot;
  try { return await withCacheLock({ ...opts, fs }, async () => {
    const durable = path.join(root, 'auth.json'); if (managedAuth(durable, fs)) return { ok: true, cacheRoot: root };
    const home = opts.codexHome || (opts.env && opts.env.CODEX_HOME) || process.env.CODEX_HOME || path.join(process.env.HOME || '', '.codex');
    const source = path.join(home, 'auth.json'); if (!managedAuth(source, fs)) return { ok: false, reason: LOGIN_REMEDY };
    fs.mkdirSync(root, { recursive: true }); const staged = path.join(root, `.auth.seed-${process.pid}-${Date.now()}`);
    fs.copyFileSync(source, staged); fs.renameSync(staged, durable); return { ok: true, cacheRoot: root };
  }); } catch (e) { return { ok: false, reason: /busy|lane/i.test(e.message) ? e.message : LOGIN_REMEDY }; }
}
async function stageTaskCache(opts = {}) {
  const fs = opts.fs || fs0; const root = opts.cacheRoot; const lane = await acquire({ ...opts, fs });
  try {
    const durable = path.join(root, 'auth.json');
    if (!managedAuth(durable, fs)) {
      const source = path.join(opts.codexHome || process.env.CODEX_HOME || '', 'auth.json');
      if (!managedAuth(source, fs)) throw new Error(LOGIN_REMEDY);
      fs.mkdirSync(root, { recursive: true }); fs.copyFileSync(source, durable);
    }
    const id = String(opts.taskId || 'task').replace(/[^A-Za-z0-9_.-]/g, '_'); const hostPath = path.join(root, 'tasks', `${id}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    fs.mkdirSync(hostPath, { recursive: true, mode: 0o700 }); fs.copyFileSync(durable, path.join(hostPath, 'auth.json'));
    const containerPath = opts.containerPath || '/root/.codex'; return { hostPath, containerPath, cacheRoot: root, mount: `${hostPath}:${containerPath}:rw`, fs, lane };
  } catch (e) { release(lane); throw e; }
}
async function releaseTaskCache(handle) {
  const fs = handle.fs || fs0; const taskAuth = path.join(handle.hostPath, 'auth.json'); const durable = path.join(handle.cacheRoot, 'auth.json');
  if (!managedAuth(taskAuth, fs)) throw new Error('task cache has no managed ChatGPT refresh token');
  const tmp = path.join(handle.cacheRoot, `.auth.refresh-${process.pid}-${Date.now()}`);
  try { fs.copyFileSync(taskAuth, tmp); fs.renameSync(tmp, durable); fs.rmSync(handle.hostPath, { recursive: true, force: true }); }
  finally { if (handle.lane) release(handle.lane); }
}
module.exports = { AUTH_MODES, validateConfig, preflight, stageTaskCache, releaseTaskCache, withCacheLock };
