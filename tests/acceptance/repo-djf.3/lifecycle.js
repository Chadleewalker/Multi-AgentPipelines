// Frozen acceptance test — repo-djf.3 serialized ChatGPT credential-lane lifecycle.
// OpenAI's managed-auth contract permits one auth.json per serialized workflow stream.
// The lane lease therefore spans staging, the whole Codex run, and refreshed write-back.
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
function managed(refresh) {
  return { auth_mode: 'chatgpt', tokens: { access_token: `access-${refresh}`, refresh_token: refresh } };
}
function readRefresh(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8')).tokens.refresh_token;
}
function waitForText(child, wanted, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    let text = '';
    const timeout = setTimeout(() => reject(new Error(`child did not print ${wanted}`)), timeoutMs);
    child.stdout.on('data', chunk => {
      text += String(chunk);
      if (text.includes(wanted)) { clearTimeout(timeout); resolve(text); }
    });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => {
      if (!text.includes(wanted)) { clearTimeout(timeout); reject(new Error(`lock child exited ${code}`)); }
    });
  });
}
function waitForExit(child) {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise(resolve => child.once('exit', resolve));
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-djf3-lifecycle-'));
  try {
    const shortRoot = path.join(root, 'short-lock');
    let active = 0;
    let maximum = 0;
    const order = [];
    let releaseFirst;
    const firstGate = new Promise(resolve => { releaseFirst = resolve; });
    const first = Promise.resolve(AUTH.withCacheLock(
      { cacheRoot: shortRoot, retryMs: 5, timeoutMs: 1000 },
      async () => {
        active += 1; maximum = Math.max(maximum, active); order.push('first-start');
        await firstGate;
        order.push('first-end'); active -= 1;
      },
    ));
    while (!order.includes('first-start')) await delay(2);
    const second = Promise.resolve(AUTH.withCacheLock(
      { cacheRoot: shortRoot, retryMs: 5, timeoutMs: 1000 },
      async () => {
        active += 1; maximum = Math.max(maximum, active); order.push('second-start');
        await delay(5);
        order.push('second-end'); active -= 1;
      },
    ));
    await delay(25);
    const waited = !order.includes('second-start');
    releaseFirst();
    await Promise.all([first, second]);
    check('C3 overlapping short cache operations wait and execute one at a time',
      waited && maximum === 1
        && order.join(',') === 'first-start,first-end,second-start,second-end',
      JSON.stringify({ waited, maximum, order }));

    const busySource = path.join(root, 'busy-source');
    const busyRoot = path.join(root, 'busy-cache');
    fs.mkdirSync(busySource, { recursive: true });
    fs.writeFileSync(path.join(busySource, 'auth.json'), JSON.stringify(managed('busy-seed')));
    let releaseBusy;
    let busyEntered = false;
    const busyGate = new Promise(resolve => { releaseBusy = resolve; });
    const holder = Promise.resolve(AUTH.withCacheLock(
      { cacheRoot: busyRoot, retryMs: 5, timeoutMs: 1000 },
      async () => { busyEntered = true; await busyGate; },
    ));
    while (!busyEntered) await delay(2);
    const busyPreflight = await Promise.resolve(AUTH.preflight({
      mode: 'chatgpt', codexHome: busySource, cacheRoot: busyRoot,
      retryMs: 5, timeoutMs: 70,
    }));
    releaseBusy();
    await holder;
    check('C2 live cache contention reports a bounded busy-lane remedy, never a false login failure',
      busyPreflight && busyPreflight.ok === false
        && /busy|lock|lane|in use/i.test(busyPreflight.reason || '')
        && !/codex login|device authentication/i.test(busyPreflight.reason || ''),
      JSON.stringify(busyPreflight));

    const liveRoot = path.join(root, 'live-owner');
    const liveCode = [
      "const auth=require(process.argv[1]);",
      "const root=process.argv[2];",
      "Promise.resolve(auth.withCacheLock({cacheRoot:root,staleMs:0},async()=>{",
      "process.stdout.write('LOCKED\\n');await new Promise(r=>setTimeout(r,350));",
      "})).then(()=>process.exit(0),()=>process.exit(2));",
    ].join('');
    const live = spawn(process.execPath, ['-e', liveCode, AUTH_PATH, liveRoot],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    await waitForText(live, 'LOCKED');
    let stolen = null;
    let busy = null;
    try {
      stolen = await AUTH.withCacheLock(
        { cacheRoot: liveRoot, retryMs: 5, timeoutMs: 90, staleMs: 0 },
        () => 'stolen',
      );
    } catch (error) { busy = error; }
    const liveDuringAttempt = live.exitCode === null;
    await waitForExit(live);
    check('C3 lock age alone never steals a live owner even when staleMs is zero',
      stolen === null && !!busy && liveDuringAttempt,
      JSON.stringify({ stolen, busy: busy && busy.message, liveDuringAttempt }));

    const staleRoot = path.join(root, 'dead-owner');
    const deadCode = [
      "const auth=require(process.argv[1]);",
      "const root=process.argv[2];",
      "Promise.resolve(auth.withCacheLock({cacheRoot:root},async()=>{",
      "process.stdout.write('LOCKED\\n');await new Promise(()=>{});",
      "})).catch(()=>process.exit(2));",
    ].join('');
    const dead = spawn(process.execPath, ['-e', deadCode, AUTH_PATH, staleRoot],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      await waitForText(dead, 'LOCKED');
      dead.kill('SIGKILL');
      await waitForExit(dead);
      const recovered = await Promise.race([
        Promise.resolve(AUTH.withCacheLock(
          { cacheRoot: staleRoot, retryMs: 5, timeoutMs: 750, staleMs: 0 },
          () => 'recovered',
        )),
        delay(1200).then(() => 'timeout'),
      ]);
      check('C3 a dead lock owner is recoverable, so interruption cannot brick the credential lane',
        recovered === 'recovered', JSON.stringify({ recovered }));
    } finally {
      if (dead.exitCode === null) dead.kill('SIGKILL');
    }

    const durable = path.join(root, 'serialized-lane');
    fs.mkdirSync(durable, { recursive: true });
    fs.writeFileSync(path.join(durable, 'auth.json'), JSON.stringify(managed('initial')));
    const firstHandle = await AUTH.stageTaskCache({
      cacheRoot: durable, taskId: 'first', retryMs: 5, timeoutMs: 1000,
    });
    let secondSettled = false;
    let secondError = null;
    const secondHandlePromise = Promise.resolve(AUTH.stageTaskCache({
      cacheRoot: durable, taskId: 'second', retryMs: 5, timeoutMs: 20, wait: true,
    })).then(handle => { secondSettled = true; return handle; }, error => {
      secondSettled = true; secondError = error; return null;
    });
    // A task lane is deliberately longer-lived than the bounded preflight lock. Prove the
    // queueing request survives beyond the supplied short diagnostic timeout and still sees
    // the first worker's refresh after release.
    await delay(60);
    const secondWaitedForWholeRun = !secondSettled;
    fs.writeFileSync(path.join(firstHandle.hostPath, 'auth.json'), JSON.stringify(managed('refreshed-one')));
    await AUTH.releaseTaskCache(firstHandle);
    const secondHandle = await Promise.race([
      secondHandlePromise,
      delay(1300).then(() => null),
    ]);
    const secondSawRefresh = secondHandle
      && readRefresh(path.join(secondHandle.hostPath, 'auth.json')) === 'refreshed-one';
    check('C3 one saved session is one serialized lane spanning stage, Codex use, and refresh persistence',
      secondWaitedForWholeRun && !secondError && !!secondHandle && secondSawRefresh
        && secondHandle.hostPath !== firstHandle.hostPath
        && !fs.existsSync(firstHandle.hostPath),
      JSON.stringify({ secondWaitedForWholeRun, secondError: secondError && secondError.message, secondSawRefresh,
        unique: secondHandle && secondHandle.hostPath !== firstHandle.hostPath }));
    if (secondHandle) await AUTH.releaseTaskCache(secondHandle);

    const seedRoot = path.join(root, 'seed-once');
    const sourceHome = path.join(seedRoot, 'source');
    const privateRoot = path.join(seedRoot, 'private');
    fs.mkdirSync(sourceHome, { recursive: true });
    fs.mkdirSync(privateRoot, { recursive: true });
    fs.writeFileSync(path.join(sourceHome, 'auth.json'), JSON.stringify(managed('original-seed')));
    fs.writeFileSync(path.join(privateRoot, 'auth.json'), JSON.stringify(managed('durable-refresh')));
    const existing = await Promise.resolve(AUTH.preflight({
      mode: 'chatgpt', codexHome: sourceHome, cacheRoot: privateRoot,
      retryMs: 5, timeoutMs: 500,
    }));
    const keptRefresh = readRefresh(path.join(privateRoot, 'auth.json'));
    const freshRoot = path.join(seedRoot, 'fresh-private');
    const seeded = await Promise.resolve(AUTH.preflight({
      mode: 'chatgpt', codexHome: sourceHome, cacheRoot: freshRoot,
      retryMs: 5, timeoutMs: 500,
    }));
    check('C2 preflight seeds a missing private cache once and never overwrites its refreshed auth from the original host seed',
      existing && existing.ok && seeded && seeded.ok
        && keptRefresh === 'durable-refresh'
        && readRefresh(path.join(freshRoot, 'auth.json')) === 'original-seed',
      JSON.stringify({ existing, seeded, keptRefresh }));

    const faultRoot = path.join(root, 'atomic-fault');
    fs.mkdirSync(faultRoot, { recursive: true });
    fs.writeFileSync(path.join(faultRoot, 'auth.json'), JSON.stringify(managed('recoverable-prior')));
    const faultHandle = await AUTH.stageTaskCache({
      cacheRoot: faultRoot, taskId: 'fault', retryMs: 5, timeoutMs: 1000,
    });
    fs.writeFileSync(path.join(faultHandle.hostPath, 'auth.json'), JSON.stringify(managed('new-refresh')));
    const durableAuth = path.join(faultRoot, 'auth.json');
    const faultFs = Object.create(fs);
    faultFs.renameSync = (source, destination) => {
      if (path.resolve(destination) === path.resolve(durableAuth)) {
        throw new Error('injected atomic replacement failure');
      }
      return fs.renameSync(source, destination);
    };
    let faultError = null;
    try { await AUTH.releaseTaskCache({ ...faultHandle, fs: faultFs }); }
    catch (error) { faultError = error; }
    check('C3 failed atomic persistence preserves the prior durable cache and recoverable task copy',
      !!faultError && readRefresh(durableAuth) === 'recoverable-prior'
        && fs.existsSync(path.join(faultHandle.hostPath, 'auth.json')),
      JSON.stringify({ faultError: faultError && faultError.message,
        durable: readRefresh(durableAuth), taskExists: fs.existsSync(faultHandle.hostPath) }));

    const invalidRoot = path.join(root, 'invalid-task-auth');
    fs.mkdirSync(invalidRoot, { recursive: true });
    fs.writeFileSync(path.join(invalidRoot, 'auth.json'), JSON.stringify(managed('invalid-prior')));
    const invalidHandle = await AUTH.stageTaskCache({
      cacheRoot: invalidRoot, taskId: 'invalid-first', retryMs: 5, timeoutMs: 250,
    });
    fs.writeFileSync(path.join(invalidHandle.hostPath, 'auth.json'), '{ invalid');
    let invalidError = null;
    try { await AUTH.releaseTaskCache(invalidHandle); } catch (error) { invalidError = error; }
    const afterInvalid = await Promise.race([
      Promise.resolve(AUTH.stageTaskCache({
        cacheRoot: invalidRoot, taskId: 'invalid-second', retryMs: 5, timeoutMs: 180,
      })).catch(() => null),
      delay(350).then(() => null),
    ]);
    check('C3 malformed task auth is preserved for recovery but still releases its lane for the next queued worker',
      !!invalidError && fs.existsSync(path.join(invalidHandle.hostPath, 'auth.json'))
        && !!afterInvalid && afterInvalid.hostPath !== invalidHandle.hostPath,
      JSON.stringify({ invalidError: invalidError && invalidError.message,
        preserved: fs.existsSync(invalidHandle.hostPath), nextStarted: !!afterInvalid }));
    if (afterInvalid) await AUTH.releaseTaskCache(afterInvalid);

    const secureHome = path.join(root, 'mode-source');
    const secureRoot = path.join(root, 'private-modes');
    fs.mkdirSync(secureHome, { recursive: true });
    fs.writeFileSync(path.join(secureHome, 'auth.json'), JSON.stringify(managed('mode-seed')));
    const modeCalls = [];
    const secureFs = Object.create(fs);
    secureFs.mkdirSync = (file, options) => {
      modeCalls.push(['mkdir', path.resolve(file), options && options.mode]);
      return fs.mkdirSync(file, options);
    };
    secureFs.chmodSync = (file, mode) => {
      modeCalls.push(['chmod', path.resolve(file), mode]);
      return fs.chmodSync(file, mode);
    };
    secureFs.openSync = (file, flags, mode) => {
      modeCalls.push(['open', path.resolve(file), mode]);
      return fs.openSync(file, flags, mode);
    };
    const securePreflight = await Promise.resolve(AUTH.preflight({
      mode: 'chatgpt', codexHome: secureHome, cacheRoot: secureRoot,
      fs: secureFs, retryMs: 5, timeoutMs: 250,
    }));
    const secureHandle = securePreflight && securePreflight.ok
      ? await AUTH.stageTaskCache({
        cacheRoot: secureRoot, taskId: 'mode-task', fs: secureFs,
        retryMs: 5, timeoutMs: 250,
      }) : null;
    if (secureHandle) await AUTH.releaseTaskCache({ ...secureHandle, fs: secureFs });
    const saw = (operation, file, mode) => modeCalls.some(call =>
      call[0] === operation && call[1] === path.resolve(file) && call[2] === mode);
    check('C2-C3 every durable/task cache directory is forced to 0700 and every credential or lock file to 0600',
      !!secureHandle
        && saw('chmod', secureRoot, 0o700)
        && saw('chmod', path.join(secureRoot, 'auth.json'), 0o600)
        && saw('chmod', secureHandle.hostPath, 0o700)
        && saw('chmod', path.join(secureHandle.hostPath, 'auth.json'), 0o600)
        && modeCalls.some(call => call[0] === 'open' && /\.lock$/.test(call[1]) && call[2] === 0o600),
      JSON.stringify(modeCalls));
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  }
}

main().catch(error => {
  check('C2-C3 credential-lane lifecycle harness completes', false,
    error && (error.stack || error.message) || String(error));
}).finally(() => { process.exitCode = failed; });
