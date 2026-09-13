// Frozen acceptance test — repo-djf.24: the full lane scheduler and safe recovery coexist.
// PAIRING (criterion -> tests): C1 -> T1; C2 -> T1,T2; C3 -> T1,T3;
// C4 -> T1; C5 -> G1,G2,G3,G4,T1,T4.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const REPO = path.resolve(__dirname, '..', '..', '..');
const processBeforeAuth = {
  stdoutWrite: process.stdout.write,
  stdinRead: process.stdin.read,
  stdinEmit: process.stdin.emit,
};
let AUTH = null; let CONFIG = null; let PREFLIGHT = null;
try { AUTH = require(path.join(REPO, 'runner', 'codex-auth.js')); } catch {}
try { CONFIG = require(path.join(REPO, 'runner', 'config.js')); } catch {}
try { PREFLIGHT = require(path.join(REPO, 'runner', 'preflight.js')); } catch {}
let failed = 0;
function check(name, yes, detail = '') {
  console.log(`${yes ? 'ok' : 'FAIL'} - ${name}${yes || !detail ? '' : ` — ${detail}`}`);
  if (!yes) failed = 1;
}
function session(token) {
  return JSON.stringify({ auth_mode: 'chatgpt', tokens: { refresh_token: token } });
}
function safe(value, secrets) {
  let text;
  try { text = JSON.stringify(value); } catch { text = String(value); }
  return !secrets.some((secret) => secret && text.includes(secret));
}
function samePath(a, b) {
  const left = path.resolve(String(a || ''));
  const right = path.resolve(String(b || ''));
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}
function lane(parent, name, token, valid = true) {
  const root = path.join(parent, name);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  fs.chmodSync(root, 0o700);
  fs.writeFileSync(path.join(root, 'auth.json'), valid ? session(token) : '{ invalid saved session',
    { mode: 0o600 });
  fs.chmodSync(path.join(root, 'auth.json'), 0o600);
  return fs.realpathSync(root);
}
function configFile(root, target, roots) {
  const file = path.join(root, `run.config.${Math.random().toString(16).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify({
    targetRepoPath: target,
    targetRepoRemote: 'https://example.invalid/private-target.git',
    image: 'fixture:image', provider: 'codex', codexAuth: 'chatgpt',
    codexAuthCacheRoots: roots,
  }));
  return file;
}
function defer() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function bounded(promise, ms, label) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms); }),
  ]);
}
async function eventually(predicate, timeoutMs = 1000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (predicate()) return true;
    await delay(2);
  }
  return predicate();
}
function hasPoolApi() {
  return !!AUTH && !!CONFIG && !!PREFLIGHT
    && typeof AUTH.preflight === 'function'
    && typeof AUTH.createLanePool === 'function';
}
function scrubbedEnv() {
  const env = { ...process.env };
  for (const key of ['CODEX_API_KEY', 'OPENAI_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CODEX_HOME']) {
    delete env[key];
  }
  return env;
}
function runFrozenUnion() {
  const runs = [];
  for (let round = 1; round <= 2; round += 1) {
    for (const suite of ['repo-djf.22', 'repo-djf.23']) {
      const dir = path.join(REPO, 'tests', 'acceptance', suite);
      const files = fs.readdirSync(dir).filter((name) => /\.(?:js|sh)$/.test(name)).sort();
      for (const name of files) {
        const file = path.join(dir, name);
        let result;
        if (name.endsWith('.js')) {
          result = spawnSync(process.execPath, [file], {
            cwd: REPO, encoding: 'utf8', windowsHide: true, timeout: 20000,
            maxBuffer: 16 * 1024 * 1024, env: scrubbedEnv(),
          });
        } else {
          result = { status: null, signal: null, error: new Error('the frozen union unexpectedly contains a shell test') };
        }
        const failureNames = String(result.stdout || '').split(/\r?\n/)
          .filter((line) => /^(?:FAIL|not ok)\b/i.test(line))
          .map((line) => line.replace(/\s+—.*$/, '').slice(0, 180));
        runs.push({ round, suite, file: name, status: result.status, signal: result.signal,
          error: result.error && result.error.message, failureNames });
      }
    }
  }
  return runs;
}
function instrumentProcess() {
  const effects = [];
  const restores = [];
  const stdout = process.stdout;
  const descriptor = Object.getOwnPropertyDescriptor(stdout, 'write');
  const originalWrite = stdout.write;
  Object.defineProperty(stdout, 'write', {
    configurable: true,
    enumerable: descriptor ? descriptor.enumerable : false,
    get() { return originalWrite; },
    set() { effects.push('stdout.write replaced'); },
  });
  restores.push(() => {
    if (descriptor) Object.defineProperty(stdout, 'write', descriptor);
    else delete stdout.write;
  });
  function observe(object, method, label) {
    if (!object || typeof object[method] !== 'function') return;
    const own = Object.getOwnPropertyDescriptor(object, method);
    const original = object[method];
    Object.defineProperty(object, method, {
      configurable: true, enumerable: own ? own.enumerable : false, writable: true,
      value(...args) {
        if (/[\\/]runner[\\/]/i.test(String(new Error().stack || ''))) effects.push(label);
        return original.apply(this, args);
      },
    });
    restores.push(() => {
      if (own) Object.defineProperty(object, method, own);
      else delete object[method];
    });
  }
  observe(process.stdin, 'read', 'stdin read');
  observe(process.stdin, 'emit', 'stdin emit');
  for (const [name, stream] of [['stdin', process.stdin], ['stdout', stdout], ['stderr', process.stderr]]) {
    observe(stream, 'pause', `${name} paused`);
    observe(stream, 'unref', `${name} unrefed`);
  }
  const originalSetInterval = global.setInterval;
  global.setInterval = (...args) => {
    if (/[\\/]runner[\\/]/i.test(String(new Error().stack || ''))) {
      effects.push('caller keepalive interval installed');
    }
    return originalSetInterval(...args);
  };
  restores.push(() => { global.setInterval = originalSetInterval; });
  return {
    effects,
    restore() {
      for (const restore of restores.reverse()) {
        try { restore(); } catch {}
      }
    },
  };
}
function spawnLaneOwner(cacheRoot) {
  const script = [
    "'use strict';",
    "const path=require('path');",
    "const auth=require(path.join(process.argv[1],'runner','codex-auth.js'));",
    "const ownKeepalive=setInterval(()=>{},1000);",
    "const before={stdout:process.stdout.write,read:process.stdin.read,emit:process.stdin.emit};",
    "const realInterval=global.setInterval;let foreignIntervals=0;",
    "global.setInterval=(...a)=>{foreignIntervals+=1;return realInterval(...a);};",
    "let handle=null;",
    "Promise.resolve(auth.stageTaskCache({cacheRoot:process.argv[2],taskId:'cross-process-owner',wait:false,timeoutMs:20,retryMs:2})).then((h)=>{",
    " handle=h;process.send({type:'ready',pid:process.pid});",
    " process.on('message',(message)=>{if(!message||message.type!=='release')return;",
    "  Promise.resolve(auth.releaseTaskCache(handle)).then(()=>{",
    "   const stable=before.stdout===process.stdout.write&&before.read===process.stdin.read&&before.emit===process.stdin.emit;",
    "   global.setInterval=realInterval;clearInterval(ownKeepalive);",
    "   process.send({type:'released',stable,foreignIntervals},()=>process.disconnect());",
    "  },(error)=>process.send({type:'error',message:String(error&&error.message||error)}));",
    " });",
    "},(error)=>process.send({type:'error',message:String(error&&error.message||error)}));",
  ].join('');
  return spawn(process.execPath, ['-e', script, REPO, cacheRoot], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true,
  });
}
function waitMessage(child, type, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`child did not send ${type}`)), timeoutMs);
    const onMessage = (message) => {
      if (message && message.type === 'error') finish(new Error(message.message));
      else if (message && message.type === type) finish(null, message);
    };
    const onExit = (code) => finish(new Error(`lane owner exited before ${type} (code ${code})`));
    function finish(error, value) {
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('exit', onExit);
      if (error) reject(error); else resolve(value);
    }
    child.on('message', onMessage);
    child.on('exit', onExit);
  });
}

async function main() {
  const roots = [];
  const secrets = [
    'djf24-queue-secret', 'djf24-invalid-a', 'djf24-invalid-b',
    'djf24-child-a', 'djf24-parent-b', 'djf24-parent-b-after',
  ];
  let child = null;
  try {
    const unionRuns = runFrozenUnion();
    check('T1 C1/C2/C3/C4/C5 the complete repo-djf.22 and repo-djf.23 suites pass twice on the exact candidate',
      unionRuns.length > 0 && unionRuns.every((item) => item.status === 0 && !item.signal && !item.error),
      JSON.stringify({ platform: process.platform, runs: unionRuns }));

    let queueResult = null;
    if (hasPoolApi()) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-djf24-queue-'));
      roots.push(root);
      const only = lane(root, 'lane', secrets[0]);
      try {
        const pre = await AUTH.preflight({ mode: 'chatgpt', cacheRoots: [only],
          wait: false, timeoutMs: 20, retryMs: 2 });
        const pool = AUTH.createLanePool({ lanes: pre.lanes, timeoutMs: 20, retryMs: 2,
          stageCaps: { specification: 2, proof: 1 } });
        const credentialStarted = defer();
        const releaseCredential = defer();
        const releaseFree = defer();
        const order = [];
        const freeStarts = [];
        const first = Promise.resolve(pool.run({ id: 'first', stage: 'implementation', credential: true }, async () => {
          order.push('first');
          credentialStarted.resolve();
          await releaseCredential.promise;
        })).then(() => ({ ok: true }), (error) => ({ ok: false, error: error && error.message }));
        await bounded(credentialStarted.promise, 500, 'first credential start');
        let secondState = 'queued';
        let thirdState = 'queued';
        const second = Promise.resolve(pool.run({ id: 'second', stage: 'implementation', credential: true }, async () => {
          secondState = 'running'; order.push('second');
        })).then(() => ({ ok: true }), (error) => ({ ok: false, error: error && error.message }));
        const third = Promise.resolve(pool.run({ id: 'third', stage: 'implementation', credential: true }, async () => {
          thirdState = 'running'; order.push('third');
        })).then(() => ({ ok: true }), (error) => ({ ok: false, error: error && error.message }));
        const free = [
          ['specification', 1], ['specification', 2], ['specification', 3],
          ['proof', 1], ['proof', 2],
        ].map(([stage, index]) => Promise.resolve(pool.run({
          id: `${stage}-${index}`, stage, credential: false,
        }, async () => {
          freeStarts.push(stage);
          await releaseFree.promise;
        })).then(() => ({ ok: true }), (error) => ({ ok: false, error: error && error.message })));
        const capsReached = await eventually(() => freeStarts.length === 3, 500);
        await delay(85);
        const waitedPastLockTimeout = secondState === 'queued' && thirdState === 'queued';
        const heldCounts = {
          specification: freeStarts.filter((stage) => stage === 'specification').length,
          proof: freeStarts.filter((stage) => stage === 'proof').length,
        };
        releaseFree.resolve();
        releaseCredential.resolve();
        const outcomes = await bounded(Promise.all([first, second, third, ...free]), 1500,
          'queued credential and credential-free workers');
        queueResult = { capsReached, waitedPastLockTimeout, heldCounts, order, outcomes,
          lockGone: !fs.existsSync(path.join(only, '.lane.lock')) };
      } catch (error) {
        queueResult = { error: error && error.message };
      }
    }
    check('T2 C2 credential-free stages reach exact caps while FIFO credential jobs wait beyond the external lock timeout',
      !!queueResult && !queueResult.error && queueResult.capsReached
        && queueResult.waitedPastLockTimeout
        && queueResult.heldCounts.specification === 2 && queueResult.heldCounts.proof === 1
        && JSON.stringify(queueResult.order) === JSON.stringify(['first', 'second', 'third'])
        && queueResult.outcomes.every((item) => item.ok) && queueResult.lockGone
        && safe(queueResult, [secrets[0]]),
      JSON.stringify(queueResult ? {
        hadError: !!queueResult.error, capsReached: queueResult.capsReached,
        waitedPastLockTimeout: queueResult.waitedPastLockTimeout,
        heldCounts: queueResult.heldCounts, order: queueResult.order,
        outcomes: queueResult.outcomes && queueResult.outcomes.map((item) => item.ok),
        lockGone: queueResult.lockGone,
      } : { missingApi: true }));

    let invalidResult = null;
    if (hasPoolApi()) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-djf24-invalid-'));
      roots.push(root);
      const target = path.join(root, 'target');
      fs.mkdirSync(target, { recursive: true });
      const marker = path.join(target, 'untouched.txt');
      fs.writeFileSync(marker, 'before\n');
      const invalidA = lane(root, 'invalid-a', secrets[1], false);
      const invalidB = lane(root, 'invalid-b', secrets[2], false);
      const calls = { admission: 0, identity: 0, docker: 0, network: 0, beads: 0 };
      try {
        const cfg = CONFIG.loadConfig(configFile(root, target, [invalidA, invalidB]));
        const authResult = await AUTH.preflight({ mode: 'chatgpt', cacheRoots: [invalidA, invalidB],
          wait: false, timeoutMs: 20, retryMs: 2, targetRepoPath: target, repoRoot: REPO });
        const integrated = await PREFLIGHT.preflight(cfg, REPO, {
          runId: 'accept-djf24-invalid', info() {}, error() {},
        }, {
          env: {},
          admitEntry() { calls.admission += 1; return { ok: true, mode: 'standalone' }; },
          verifyRepoIdentity() { calls.identity += 1; return { ok: true }; },
          dockerAvailable() { calls.docker += 1; return { status: 0 }; },
          networkUp() { calls.network += 1; return { ok: true }; },
          recoverStaleIssues() { calls.beads += 1; return { recovered: [] }; },
        });
        invalidResult = {
          authResult,
          integrated,
          calls,
          marker: fs.readFileSync(marker, 'utf8'),
          locks: [invalidA, invalidB].filter((item) => fs.existsSync(path.join(item, '.lane.lock'))),
          taskRoots: [invalidA, invalidB].filter((item) => fs.existsSync(path.join(item, 'tasks'))),
        };
      } catch (error) {
        invalidResult = { error: error && error.message, calls };
      }
    }
    const quarantined = invalidResult && invalidResult.authResult
      && Array.isArray(invalidResult.authResult.quarantined) ? invalidResult.authResult.quarantined : [];
    check('T3 C3 two invalid saved sessions are quarantined individually and zero healthy lanes fail before target mutation',
      !!invalidResult && !invalidResult.error
        && invalidResult.authResult.ok === false
        && invalidResult.authResult.healthyLaneCount === 0
        && quarantined.length === 2
        && invalidResult.integrated && invalidResult.integrated.ok === false
        && invalidResult.integrated.authRefused === true
        && Object.values(invalidResult.calls).every((count) => count === 0)
        && invalidResult.marker === 'before\n'
        && invalidResult.locks.length === 0 && invalidResult.taskRoots.length === 0
        && safe(invalidResult, [secrets[1], secrets[2]]),
      JSON.stringify({ missingApi: !hasPoolApi(), error: invalidResult && invalidResult.error,
        healthy: invalidResult && invalidResult.authResult && invalidResult.authResult.healthyLaneCount,
        quarantined: quarantined.length, calls: invalidResult && invalidResult.calls,
        marker: invalidResult && invalidResult.marker,
        locks: invalidResult && invalidResult.locks && invalidResult.locks.length,
        taskRoots: invalidResult && invalidResult.taskRoots && invalidResult.taskRoots.length }));

    let ownershipResult = null;
    if (hasPoolApi()) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-djf24-process-'));
      roots.push(root);
      const laneA = lane(root, 'lane-a', secrets[3]);
      const laneB = lane(root, 'lane-b', secrets[4]);
      try {
        const pre = await AUTH.preflight({ mode: 'chatgpt', cacheRoots: [laneA, laneB],
          wait: false, timeoutMs: 20, retryMs: 2 });
        const pool = AUTH.createLanePool({ lanes: pre.lanes, timeoutMs: 20, retryMs: 2 });
        child = spawnLaneOwner(laneA);
        const ready = await waitMessage(child, 'ready');
        await delay(85);
        const childStayedAlive = ready.pid === child.pid && child.exitCode === null && !child.killed;
        const probe = instrumentProcess();
        let worker = null; let workerError = null;
        try {
          worker = await bounded(pool.run({ id: 'sibling-worker', stage: 'implementation', credential: true }, async (ctx) => {
            fs.writeFileSync(path.join(ctx.authCache.hostPath, 'auth.json'), session(secrets[5]));
            return { laneId: ctx.laneId, cacheRoot: ctx.cacheRoot };
          }), 1000, 'healthy sibling worker');
          await bounded(pool.recover(), 500, 'empty recovery');
        } catch (error) { workerError = error; }
        const effects = [...probe.effects];
        probe.restore();
        const releasedPromise = waitMessage(child, 'released');
        child.send({ type: 'release' });
        const released = await releasedPromise;
        await bounded(new Promise((resolve) => child.once('exit', resolve)), 1000, 'lane owner exit');
        child = null;
        ownershipResult = {
          childStayedAlive, released, effects, workerError: workerError && workerError.message,
          siblingUsedOtherLane: worker && samePath(worker.cacheRoot, laneB),
          moduleLoadStable: processBeforeAuth.stdoutWrite === process.stdout.write
            && processBeforeAuth.stdinRead === process.stdin.read
            && processBeforeAuth.stdinEmit === process.stdin.emit,
          laneAArtifacts: fs.existsSync(path.join(laneA, '.lane.lock'))
            || (fs.existsSync(path.join(laneA, 'tasks')) && fs.readdirSync(path.join(laneA, 'tasks')).length > 0),
          laneBArtifacts: fs.existsSync(path.join(laneB, '.lane.lock'))
            || (fs.existsSync(path.join(laneB, 'tasks')) && fs.readdirSync(path.join(laneB, 'tasks')).length > 0),
        };
      } catch (error) {
        ownershipResult = { error: error && error.message };
      } finally {
        if (child) {
          try { child.kill(); } catch {}
          child = null;
        }
      }
    }
    check('T4 C5 credential ownership leaves process I/O and caller timers untouched while a self-kept child holds one lane and its sibling progresses',
      !!ownershipResult && !ownershipResult.error && ownershipResult.childStayedAlive
        && ownershipResult.released && ownershipResult.released.stable === true
        && ownershipResult.released.foreignIntervals === 0
        && ownershipResult.effects.length === 0 && !ownershipResult.workerError
        && ownershipResult.siblingUsedOtherLane && ownershipResult.moduleLoadStable
        && !ownershipResult.laneAArtifacts && !ownershipResult.laneBArtifacts
        && safe(ownershipResult, [secrets[3], secrets[4], secrets[5]]),
      JSON.stringify(ownershipResult ? {
        hadError: !!ownershipResult.error, childStayedAlive: ownershipResult.childStayedAlive,
        released: ownershipResult.released, effects: ownershipResult.effects,
        hadWorkerError: !!ownershipResult.workerError,
        siblingUsedOtherLane: ownershipResult.siblingUsedOtherLane,
        moduleLoadStable: ownershipResult.moduleLoadStable,
        laneAArtifacts: ownershipResult.laneAArtifacts,
        laneBArtifacts: ownershipResult.laneBArtifacts,
      } : { missingApi: true }));
  } catch (error) {
    check('T1-T4 C1-C5 deterministic acceptance fixture executes', false,
      String(error && error.stack || error).replace(/djf24-[a-z-]+/gi, '[redacted]'));
  } finally {
    if (child) {
      try { child.kill(); } catch {}
    }
    for (const root of roots) {
      try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
    }
  }
  process.exitCode = failed;
}
main().catch((error) => {
  console.error(`FAIL - T1-T4 C1-C5 fixture settles — ${String(error && error.message || error)}`);
  process.exitCode = 1;
});
