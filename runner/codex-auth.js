// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0
'use strict';

// ChatGPT authentication is deliberately a file boundary, not an environment boundary.
// The durable copy belongs to the pipeline; each task receives a short-lived writable copy.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const AUTH_MODES = ['chatgpt', 'api-key'];
const AUTH_NAME = 'auth.json';
const CONTAINER_PATH = '/root/.codex';
const LOCK_WAIT_MS = 2000;
const HELD_LOCKS = new Set();

function defaultCodexHome(env = process.env) { return env.CODEX_HOME || path.join(os.homedir(), '.codex'); }
function defaultCacheRoot() { return path.join(os.homedir(), '.multi-agent-pipelines', 'codex-chatgpt-auth'); }
function loginRemedy() { return 'Codex ChatGPT authentication is unavailable — run `codex login` (device authentication) on the host, then retry.'; }

function usableAuth(text) {
  let value;
  try { value = JSON.parse(text); } catch { return false; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  // Codex session files have varied shape. Accept an actual session token, never an API-key-only file.
  const seen = new Set();
  const visit = (v, key = '') => {
    if (!v || typeof v !== 'object' || seen.has(v)) return false;
    seen.add(v);
    for (const [k, child] of Object.entries(v)) {
      if (/api[_-]?key/i.test(k)) continue;
      if (typeof child === 'string' && child.trim() && /(access|refresh|id)[_-]?token|token/i.test(k)) return true;
      if (child && typeof child === 'object' && visit(child, k)) return true;
    }
    return false;
  };
  return visit(value);
}

function validateConfig(raw = {}) {
  const provider = String(raw.provider || '').trim().toLowerCase();
  if (provider !== 'codex') return { ok: true, codexAuth: null, credentialName: null };
  const mode = raw.codexAuth == null ? 'api-key' : String(raw.codexAuth).trim().toLowerCase();
  if (!AUTH_MODES.includes(mode)) return { ok: false, reason: `run.config.json: 'codexAuth' must be one of ${AUTH_MODES.join(' | ')}` };
  return { ok: true, codexAuth: mode, credentialName: mode === 'api-key' ? 'CODEX_API_KEY' : null };
}

function mkdirPrivate(dir) { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); try { fs.chmodSync(dir, 0o700); } catch {} }
function copyAtomic(from, to) {
  const temp = `${to}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  fs.copyFileSync(from, temp); try { fs.chmodSync(temp, 0o600); } catch {}
  fs.renameSync(temp, to);
}

function withCacheLock(opts = {}, fn) {
  const root = opts.cacheRoot || defaultCacheRoot();
  if (HELD_LOCKS.has(root)) return fn();
  mkdirPrivate(root);
  const lock = path.join(root, ".lock");
  const deadline = Date.now() + (opts.timeoutMs || LOCK_WAIT_MS);
  for (;;) {
    try { fs.mkdirSync(lock, { mode: 0o700 }); HELD_LOCKS.add(root); break; }
    catch (e) {
      if (e.code !== "EEXIST" || Date.now() >= deadline) throw new Error("Codex credential cache is busy; retry shortly.");
      try { if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_WAIT_MS * 3) fs.rmdirSync(lock); } catch {}
    }
  }
  const release = () => { HELD_LOCKS.delete(root); try { fs.rmdirSync(lock); } catch {} };
  try {
    const result = fn();
    if (result && typeof result.then === "function") return result.then((v) => { release(); return v; }, (e) => { release(); throw e; });
    release(); return result;
  } catch (e) { release(); throw e; }
}

function preflight(opts = {}) {
  if ((opts.mode || 'chatgpt') !== 'chatgpt') return { ok: true, reason: null };
  const home = opts.codexHome || defaultCodexHome(opts.env);
  const root = opts.cacheRoot || defaultCacheRoot();
  const source = path.join(home, AUTH_NAME);
  try {
    const contents = fs.readFileSync(source, 'utf8');
    if (!usableAuth(contents)) return { ok: false, reason: loginRemedy() };
    withCacheLock({ cacheRoot: root }, () => {
      mkdirPrivate(root);
      const durable = path.join(root, AUTH_NAME);
      // Refresh persistence wins: a usable durable session is retained. Seed only when absent/bad.
      let cached = ''; try { cached = fs.readFileSync(durable, 'utf8'); } catch {}
      if (!usableAuth(cached)) copyAtomic(source, durable);
    });
    return { ok: true, cacheRoot: root, codexHome: home };
  } catch { return { ok: false, reason: loginRemedy() }; }
}

function stageTaskCache(opts = {}) {
  const root = opts.cacheRoot || defaultCacheRoot();
  const home = opts.codexHome || defaultCodexHome(opts.env);
  const taskId = String(opts.taskId || 'task').replace(/[^A-Za-z0-9_.-]/g, '-');
  return withCacheLock({ cacheRoot: root }, () => {
    mkdirPrivate(root);
    const durable = path.join(root, AUTH_NAME);
    let source = durable;
    let text = ''; try { text = fs.readFileSync(source, 'utf8'); } catch {}
    if (!usableAuth(text)) {
      source = path.join(home, AUTH_NAME); text = fs.readFileSync(source, 'utf8');
      if (!usableAuth(text)) throw new Error(loginRemedy());
      copyAtomic(source, durable); source = durable;
    }
    const hostPath = path.join(root, 'tasks', `${taskId}-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
    mkdirPrivate(hostPath); copyAtomic(source, path.join(hostPath, AUTH_NAME));
    // Node in the pinned image is uid 1000. A private cache is still pipeline-owned, while
    // group/world remain closed and the non-root task user can refresh its mounted copy.
    try { fs.chmodSync(hostPath, 0o700); fs.chmodSync(path.join(hostPath, AUTH_NAME), 0o600); } catch {}
    const containerPath = opts.containerPath || CONTAINER_PATH;
    return { hostPath, containerPath, mount: `${hostPath}:${containerPath}:rw`, durablePath: durable, cleanup: true };
  });
}

function releaseTaskCache(handle) {
  if (!handle || !handle.hostPath) return;
  const root = handle.durablePath ? path.dirname(handle.durablePath) : path.dirname(path.dirname(handle.hostPath));
  try {
    withCacheLock({ cacheRoot: root }, () => {
      const refreshed = path.join(handle.hostPath, AUTH_NAME);
      let text = ''; try { text = fs.readFileSync(refreshed, 'utf8'); } catch {}
      if (handle.durablePath && usableAuth(text)) copyAtomic(refreshed, handle.durablePath);
      fs.rmSync(handle.hostPath, { recursive: true, force: true });
    });
  } catch { try { fs.rmSync(handle.hostPath, { recursive: true, force: true }); } catch {} }
}

module.exports = { AUTH_MODES, validateConfig, preflight, stageTaskCache, releaseTaskCache, withCacheLock, defaultCacheRoot, defaultCodexHome };
