// Frozen acceptance test — repo-djf.3 concurrent credential-cache lifecycle.
// This file creates real overlapping asynchronous callbacks. Merely returning two task
// handles from synchronous Promise.all inputs is not evidence that the lock excludes work.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const AUTH = require('../../../runner/codex-auth');

let failed = 0;
function check(name, yes, detail = '') {
  console.log(`${yes ? 'ok' : 'FAIL'} - ${name}${yes || !detail ? '' : ` — ${detail}`}`);
  if (!yes) failed = 1;
}
function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-djf3-lock-'));
  try {
    const durable = path.join(root, 'durable');
    fs.mkdirSync(durable, { recursive: true });
    fs.writeFileSync(path.join(durable, 'auth.json'), JSON.stringify({ tokens: { refresh_token: 'initial' } }));

    let active = 0;
    let maximum = 0;
    const order = [];
    let releaseFirst;
    const firstGate = new Promise(resolve => { releaseFirst = resolve; });
    const first = Promise.resolve().then(() => AUTH.withCacheLock(
      { cacheRoot: durable, retryMs: 5, timeoutMs: 1000 },
      async () => {
        active += 1; maximum = Math.max(maximum, active); order.push('first-start');
        await firstGate;
        order.push('first-end'); active -= 1;
        return 'first';
      },
    ));
    while (!order.includes('first-start')) await delay(2);
    const second = Promise.resolve().then(() => AUTH.withCacheLock(
      { cacheRoot: durable, retryMs: 5, timeoutMs: 1000 },
      async () => {
        active += 1; maximum = Math.max(maximum, active); order.push('second-start');
        await delay(5);
        order.push('second-end'); active -= 1;
        return 'second';
      },
    ));
    await delay(25);
    const waited = !order.includes('second-start');
    releaseFirst();
    const settled = await Promise.race([
      Promise.allSettled([first, second]),
      delay(1500).then(() => 'timeout'),
    ]);
    check('C4 overlapping asynchronous cache users wait and execute one at a time instead of throwing or overlapping',
      settled !== 'timeout' && settled.every(result => result.status === 'fulfilled')
        && waited && maximum === 1
        && order.join(',') === 'first-start,first-end,second-start,second-end',
      JSON.stringify({ settled, waited, maximum, order }));

    const task = path.join(durable, 'tasks', 'release-proof');
    fs.mkdirSync(task, { recursive: true });
    fs.writeFileSync(path.join(task, 'auth.json'), JSON.stringify({ tokens: { refresh_token: 'refreshed' } }));
    let refreshCopiedWhileLocked = false;
    let observedLockDepth = 0;
    const observedFs = Object.create(fs);
    observedFs.openSync = (target, flags, ...rest) => {
      const fd = fs.openSync(target, flags, ...rest);
      if (flags === 'wx' && /lock/i.test(String(target))) observedLockDepth += 1;
      return fd;
    };
    observedFs.mkdirSync = (target, options) => {
      const value = fs.mkdirSync(target, options);
      if (/lock/i.test(String(target))) observedLockDepth += 1;
      return value;
    };
    observedFs.unlinkSync = target => {
      const value = fs.unlinkSync(target);
      if (/lock/i.test(String(target))) observedLockDepth = Math.max(0, observedLockDepth - 1);
      return value;
    };
    observedFs.rmSync = (target, options) => {
      const value = fs.rmSync(target, options);
      if (/lock/i.test(String(target))) observedLockDepth = Math.max(0, observedLockDepth - 1);
      return value;
    };
    observedFs.copyFileSync = (source, destination) => {
      if (path.resolve(destination).startsWith(path.resolve(durable))
          && observedLockDepth > 0) refreshCopiedWhileLocked = true;
      return fs.copyFileSync(source, destination);
    };
    await AUTH.releaseTaskCache({
      hostPath: task, cacheRoot: durable, fs: observedFs, retryMs: 5, timeoutMs: 1000,
    });
    const persisted = JSON.parse(fs.readFileSync(path.join(durable, 'auth.json'), 'utf8'));
    check('C4 release persists a refreshed task credential while holding the lifecycle lock, then removes only the task copy',
      refreshCopiedWhileLocked && persisted.tokens.refresh_token === 'refreshed'
        && !fs.existsSync(task) && fs.existsSync(path.join(durable, 'auth.json')),
      JSON.stringify({ refreshCopiedWhileLocked, persisted, taskExists: fs.existsSync(task) }));
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  }
}

main().catch(error => {
  check('C4 concurrent lifecycle harness completes', false, error && (error.stack || error.message) || String(error));
}).finally(() => { process.exitCode = failed; });
