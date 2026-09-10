// Frozen acceptance test — repo-djf.3 concurrent credential-cache lifecycle.
// This file creates real overlapping asynchronous callbacks. Merely returning two task
// handles from synchronous Promise.all inputs is not evidence that the lock excludes work.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const AUTH = require('../../../runner/codex-auth');
const AUTH_PATH = require.resolve('../../../runner/codex-auth');

let failed = 0;
function check(name, yes, detail = '') {
  console.log(`${yes ? 'ok' : 'FAIL'} - ${name}${yes || !detail ? '' : ` — ${detail}`}`);
  if (!yes) failed = 1;
}
function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function waitForLock(child) {
  return new Promise((resolve, reject) => {
    let text = '';
    const timeout = setTimeout(() => reject(new Error('child did not acquire the lifecycle lock')), 1500);
    child.stdout.on('data', chunk => {
      text += String(chunk);
      if (text.includes('LOCKED')) { clearTimeout(timeout); resolve(); }
    });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => {
      if (!text.includes('LOCKED')) { clearTimeout(timeout); reject(new Error(`lock child exited ${code}`)); }
    });
  });
}
function waitForExit(child) {
  return new Promise(resolve => child.once('exit', resolve));
}

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

    const faultRoot = path.join(root, 'fault-durable');
    const faultTask = path.join(faultRoot, 'tasks', 'fault-task');
    fs.mkdirSync(faultTask, { recursive: true });
    const durableAuth = path.join(faultRoot, 'auth.json');
    const priorBytes = JSON.stringify({ tokens: { refresh_token: 'recoverable-prior' } });
    fs.writeFileSync(durableAuth, priorBytes);
    fs.writeFileSync(path.join(faultTask, 'auth.json'), JSON.stringify({ tokens: { refresh_token: 'new-refresh' } }));
    let directOverwriteAttempted = false;
    const faultFs = Object.create(fs);
    faultFs.copyFileSync = (source, destination) => {
      if (path.resolve(destination) === path.resolve(durableAuth)) {
        directOverwriteAttempted = true;
        fs.writeFileSync(destination, '{ injected torn write');
        throw new Error('injected direct-overwrite failure');
      }
      return fs.copyFileSync(source, destination);
    };
    let faultError = null;
    try {
      await AUTH.releaseTaskCache({
        hostPath: faultTask, cacheRoot: faultRoot, fs: faultFs, retryMs: 5, timeoutMs: 1000,
      });
    } catch (error) { faultError = error; }
    const afterFault = fs.readFileSync(durableAuth, 'utf8');
    const atomicSuccess = !directOverwriteAttempted
      && JSON.parse(afterFault).tokens.refresh_token === 'new-refresh' && !fs.existsSync(faultTask);
    const recoverableFailure = directOverwriteAttempted && !!faultError
      && afterFault === priorBytes && fs.existsSync(path.join(faultTask, 'auth.json'));
    check('C4 refresh persistence is atomic: a failed direct overwrite cannot corrupt the durable cache or delete the recoverable task copy',
      atomicSuccess || recoverableFailure,
      JSON.stringify({ directOverwriteAttempted, faultError: faultError && faultError.message,
        afterFault, taskExists: fs.existsSync(faultTask) }));

    const staleRoot = path.join(root, 'stale-durable');
    const childCode = [
      "const auth=require(process.argv[1]);",
      "const root=process.argv[2];",
      "Promise.resolve(auth.withCacheLock({cacheRoot:root},async()=>{process.stdout.write('LOCKED\\n');await new Promise(()=>{});})).catch(()=>process.exit(2));",
    ].join('');
    const child = spawn(process.execPath, ['-e', childCode, AUTH_PATH, staleRoot],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      await waitForLock(child);
      child.kill('SIGKILL');
      await waitForExit(child);
      const recovered = await Promise.race([
        Promise.resolve(AUTH.withCacheLock(
          { cacheRoot: staleRoot, retryMs: 5, timeoutMs: 750, staleMs: 0 },
          () => 'recovered',
        )),
        delay(1200).then(() => 'timeout'),
      ]);
      check('C4 a dead lock owner is recoverable, so an interrupted process cannot permanently brick ChatGPT workers',
        recovered === 'recovered', JSON.stringify({ recovered }));
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  }
}

main().catch(error => {
  check('C4 concurrent lifecycle harness completes', false, error && (error.stack || error.message) || String(error));
}).finally(() => { process.exitCode = failed; });
