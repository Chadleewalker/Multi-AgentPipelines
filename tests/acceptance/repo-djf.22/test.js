// Frozen acceptance test — repo-djf.22: safe ChatGPT subscription lanes without ownership leaks.
// PAIRING: C1 -> T1 exclusive credential work + T2 credential-free overlap/caps.
// C2 -> T3 private-lane preflight/quarantine/cleanup + T4 healthy-count bound + T8 recovery.
// C3 -> T5 unique lane-local handoffs/write-back/non-disclosure + T6 failure preservation.
// C4 -> T2 stage caps + T3 owned-fixture cleanup + T7 FIFO + T8 quarantine/recovery +
// T9 two-lane makespan; guard.js G3/G4 pair the mandatory profile and owned-artifact cleanup.
//
// Frozen interface: runner/codex-auth.js extends preflight({cacheRoots:[...]}) to return
// {ok, lanes:[{id,cacheRoot,healthy,...}], healthyLaneCount, quarantined}, and exports
// createLanePool({lanes,stageCaps,onEvent}). The pool exposes run(job, worker), snapshot(),
// and recover(); job is {id,stage,credential}. Credential workers receive only
// {laneId,cacheRoot,authCache}; credential-free workers receive no lane and obey stageCaps.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const REPO = path.resolve(__dirname, '..', '..', '..');
let AUTH = null; let CONFIG = null; let PREFLIGHT = null; let RUNNER = null; let LOCK = null;
try { AUTH = require(path.join(REPO, 'runner', 'codex-auth.js')); } catch {}
try { CONFIG = require(path.join(REPO, 'runner', 'config.js')); } catch {}
try { PREFLIGHT = require(path.join(REPO, 'runner', 'preflight.js')); } catch {}
try { RUNNER = require(path.join(REPO, 'runner', 'run.js')); } catch {}
try { LOCK = require(path.join(REPO, 'runner', 'lock.js')); } catch {}
let failed = 0;
function check(name, yes, detail = '') {
  console.log(`${yes ? 'ok' : 'FAIL'} - ${name}${yes || !detail ? '' : ` — ${detail}`}`);
  if (!yes) failed = 1;
}
function session(token) {
  return JSON.stringify({ auth_mode: 'chatgpt', tokens: { refresh_token: token } });
}
function lane(root, name, token, valid = true) {
  const dir = path.join(root, name); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'auth.json'), valid ? session(token) : '{ malformed');
  return dir;
}
function defer() {
  let resolve; const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function eventually(predicate, timeoutMs = 1000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) { if (predicate()) return true; await delay(2); }
  return predicate();
}
function safe(value, secrets) {
  let text; try { text = JSON.stringify(value); } catch { text = String(value); }
  return !(secrets || []).some((secret) => secret && text.includes(secret));
}
function hasPoolApi() {
  return !!AUTH && typeof AUTH.preflight === 'function' && typeof AUTH.createLanePool === 'function';
}
async function prepared(roots, options = {}) {
  const pre = await AUTH.preflight({ mode: 'chatgpt', cacheRoots: roots, retryMs: 2,
    timeoutMs: 30 });
  const pool = AUTH.createLanePool({ lanes: pre.lanes, stageCaps: options.stageCaps || {},
    onEvent: options.onEvent });
  return { pre, pool };
}
function configFile(root, extra) {
  const target = path.join(root, 'target'); fs.mkdirSync(target, { recursive: true });
  const file = path.join(root, `run.config.${Math.random().toString(16).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify({ targetRepoPath: target,
    targetRepoRemote: 'https://example.invalid/fixture.git', image: 'fixture:image',
    provider: 'codex', codexAuth: 'chatgpt', concurrency: 9, ...extra }));
  return file;
}

async function main() {
  const roots = [];
  try {
    // T1/T2: one credential lane stays exclusive while independently capped free stages move.
    {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-djf22-overlap-')); roots.push(root);
      const one = lane(root, 'only-lane', 'overlap-secret');
      let pool = null; let setupError = null;
      try { if (hasPoolApi()) pool = (await prepared([one], { stageCaps: {
        specification: 2, proof: 1, verification: 1, publication: 1, review: 1,
        implementation: 9,
      } })).pool; } catch (error) { setupError = error; }
      let activeCredential = 0; let peakCredential = 0; let secondCredentialStarted = false;
      const credentialStarted = defer(); const releaseCredential = defer();
      const releaseFree = defer(); const starts = [];
      let first; let second; let free = [];
      if (pool) {
        first = pool.run({ id: 'implementation-1', stage: 'implementation', credential: true }, async () => {
          activeCredential += 1; peakCredential = Math.max(peakCredential, activeCredential);
          credentialStarted.resolve(); await releaseCredential.promise; activeCredential -= 1;
        });
        await credentialStarted.promise;
        second = pool.run({ id: 'implementation-2', stage: 'implementation', credential: true }, async () => {
          secondCredentialStarted = true; activeCredential += 1;
          peakCredential = Math.max(peakCredential, activeCredential); activeCredential -= 1;
        });
        const stages = ['specification', 'specification', 'specification', 'proof', 'proof',
          'verification', 'verification', 'publication', 'publication', 'review', 'review'];
        free = stages.map((stage, index) => pool.run({
          id: `${stage}-${index}`, stage, credential: false,
        }, async (ctx) => {
          starts.push(stage); await releaseFree.promise; return ctx;
        }));
      }
      const capsObserved = pool && await eventually(() => starts.length === 6);
      const initialCounts = Object.fromEntries(['specification', 'proof', 'verification', 'publication', 'review']
        .map((stage) => [stage, starts.filter((item) => item === stage).length]));
      check('T1 C1 one configured login is never cloned concurrently even when task concurrency is higher',
        !!pool && peakCredential === 1 && secondCredentialStarted === false,
        JSON.stringify({ setupError: setupError && setupError.message, peakCredential, secondCredentialStarted }));
      check('T2 C1/C4 credential-free stages overlap a held lane and each stops exactly at its configured stage cap',
        !!capsObserved && initialCounts.specification === 2 && initialCounts.proof === 1
          && initialCounts.verification === 1 && initialCounts.publication === 1
          && initialCounts.review === 1 && secondCredentialStarted === false,
        JSON.stringify({ setupError: setupError && setupError.message, initialCounts, starts }));
      releaseFree.resolve(); releaseCredential.resolve();
      if (pool) await Promise.all([first, second, ...free]);
    }

    // T3: all private lanes are validated before target mutation; successful fixture settles
    // both returned obligations in finally and proves no observer lock remains.
    let multiPre = null; let multiRoots = null; let config = null; let configError = null;
    {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-djf22-preflight-')); roots.push(root);
      const secretA = 'private-preflight-A'; const secretB = 'private-preflight-B';
      multiRoots = [lane(root, 'lane-a', secretA), lane(root, 'lane-b', secretB),
        lane(root, 'lane-bad', 'unused', false)];
      try { config = CONFIG && CONFIG.loadConfig(configFile(root, { codexAuthCacheRoots: multiRoots })); }
      catch (error) { configError = error; }
      let duplicateError = null;
      try { if (CONFIG) CONFIG.loadConfig(configFile(root, {
        codexAuthCacheRoots: [multiRoots[0], multiRoots[0]],
      })); } catch (error) { duplicateError = error; }
      try { if (hasPoolApi()) multiPre = await AUTH.preflight({ mode: 'chatgpt',
        cacheRoots: multiRoots, retryMs: 2, timeoutMs: 30 }); } catch {}

      const order = []; let captured = null; let integrated = null; let cleanup = null;
      let networkDowns = 0; let releasedOwnership = null; let observer = null;
      if (PREFLIGHT && RUNNER && LOCK && config && multiPre) {
        try {
          integrated = await PREFLIGHT.preflight(config, REPO,
            { runId: 'accept-djf22', info() {}, error() {} }, {
              env: {}, codexAuth: { preflight(opts) { captured = opts; order.push('auth'); return multiPre; } },
              admitEntry: () => ({ ok: true, mode: 'standalone' }),
              verifyRepoIdentity: () => { order.push('identity'); return { ok: true, remoteName: 'fixture', identity: 'fixture' }; },
              resolveHostShell: () => ({ ok: true, command: 'fixture-shell', kind: 'fixture' }),
              dockerAvailable: () => ({ status: 0 }), imageExists: () => ({ status: 0 }),
              imageSupportsProvider: () => true,
              networkUp: () => { order.push('network'); return { ok: true }; },
              egressCheck: () => ({ ok: true }), recoverStaleIssues: () => ({ recovered: [] }),
            });
        } finally {
          if (integrated && integrated.ok) {
            cleanup = RUNNER.cleanupOwnedLifecycle(config, REPO, { error() {} },
              'accept-djf22/fixture-cleanup', {
                ownership: integrated.ownership, lockOwned: integrated.lockOwned,
                networkDown: () => { networkDowns += 1; return { ok: true }; },
                releaseLock: (repoRoot, target, ownership) => {
                  releasedOwnership = ownership; return LOCK.release(repoRoot, target, ownership);
                },
              });
            observer = LOCK.acquire(REPO, config.targetRepoPath, 'accept-djf22-observer');
            if (observer && observer.ok) LOCK.release(REPO, config.targetRepoPath, observer.ownership);
          }
        }
      }
      const healthy = multiPre && Array.isArray(multiPre.lanes)
        ? multiPre.lanes.filter((item) => item && item.healthy).length : 0;
      const quarantined = multiPre && Array.isArray(multiPre.quarantined) ? multiPre.quarantined : [];
      check('T3 C2/C4 config accepts unique private lanes, quarantines invalid auth before mutation, and the successful fixture releases network plus exact lock ownership',
        !!config && !configError
          && JSON.stringify(config.codexAuthCacheRoots) === JSON.stringify(multiRoots)
          && duplicateError && /codexAuthCacheRoots|duplicate|unique|distinct/i.test(duplicateError.message || '')
          && multiPre && multiPre.ok === true && healthy === 2 && multiPre.healthyLaneCount === 2
          && quarantined.length === 1 && safe(multiPre, [secretA, secretB])
          && captured && JSON.stringify(captured.cacheRoots) === JSON.stringify(multiRoots)
          && integrated && integrated.ok === true && order[0] === 'auth'
          && cleanup && cleanup.ok === true && networkDowns === 1
          && releasedOwnership === integrated.ownership && observer && observer.ok === true,
        JSON.stringify({ configError: configError && configError.message,
          duplicateError: duplicateError && duplicateError.message, multiPre,
          captured, integrated: integrated && integrated.ok, order, cleanup, networkDowns,
          exactOwnership: !!integrated && releasedOwnership === integrated.ownership,
          observer: observer && observer.ok }));
    }

    // T4: an oversized worker request is bounded by healthy authenticated lanes.
    {
      let pool = null; let setupError = null;
      try { if (hasPoolApi() && multiPre) pool = AUTH.createLanePool({ lanes: multiPre.lanes }); }
      catch (error) { setupError = error; }
      let active = 0; let peak = 0; const used = [];
      if (pool) await Promise.all(Array.from({ length: 6 }, (_, i) => pool.run({
        id: `bounded-${i}`, stage: 'implementation', credential: true,
      }, async (ctx) => {
        active += 1; peak = Math.max(peak, active); used.push(ctx && ctx.laneId);
        await delay(25); active -= 1;
      })));
      check('T4 C2 credential concurrency reaches but never exceeds the healthy lane count',
        !!pool && multiPre && multiPre.healthyLaneCount > 1
          && peak === multiPre.healthyLaneCount
          && new Set(used.filter(Boolean)).size === multiPre.healthyLaneCount,
        JSON.stringify({ setupError: setupError && setupError.message, peak, used }));
    }

    // T5: concurrent workers see different lane-local handoffs and never another lane secret.
    {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-djf22-isolation-')); roots.push(root);
      const tokenA = 'isolation-A-before'; const tokenB = 'isolation-B-before';
      const laneA = lane(root, 'lane-a', tokenA); const laneB = lane(root, 'lane-b', tokenB);
      let pool = null; let setupError = null; const seen = [];
      try { if (hasPoolApi()) pool = (await prepared([laneA, laneB])).pool; }
      catch (error) { setupError = error; }
      if (pool) await Promise.all(['one', 'two'].map((id) => pool.run({
        id, stage: 'implementation', credential: true,
      }, async (ctx) => {
        const source = ctx.cacheRoot === laneA ? 'A' : ctx.cacheRoot === laneB ? 'B' : '?';
        const ownToken = source === 'A' ? tokenA : tokenB;
        const otherToken = source === 'A' ? tokenB : tokenA;
        const before = fs.readFileSync(path.join(ctx.authCache.hostPath, 'auth.json'), 'utf8');
        seen.push({ id, source, laneId: ctx.laneId, hostPath: ctx.authCache.hostPath,
          correctSource: before === session(ownToken), noOtherLane: !JSON.stringify(ctx).includes(otherToken) });
        fs.writeFileSync(path.join(ctx.authCache.hostPath, 'auth.json'), session(`isolation-${source}-after`));
        await delay(15);
      })));
      const unique = seen.length === 2 && new Set(seen.map((item) => item.hostPath)).size === 2
        && new Set(seen.map((item) => item.laneId)).size === 2;
      const local = seen.every((item) => item.correctSource && item.noOtherLane
        && item.hostPath.startsWith(`${item.source === 'A' ? laneA : laneB}${path.sep}`));
      check('T5 C3 each worker gets one unique writable handoff, sees no other lane, and writes back only to its source',
        !!pool && unique && local
          && fs.readFileSync(path.join(laneA, 'auth.json'), 'utf8') === session('isolation-A-after')
          && fs.readFileSync(path.join(laneB, 'auth.json'), 'utf8') === session('isolation-B-after'),
        JSON.stringify({ setupError: setupError && setupError.message, seen }));
    }

    // T6/T8: a bad refresh quarantines only that lane; its retained copy repairs in place.
    {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-djf22-recovery-')); roots.push(root);
      const badRoot = lane(root, 'lane-a', 'recovery-A-before');
      const goodRoot = lane(root, 'lane-b', 'recovery-B-before');
      const events = []; let pool = null; let setupError = null; let badContext = null; let goodContext = null;
      try { if (hasPoolApi()) pool = (await prepared([badRoot, goodRoot], {
        onEvent: (event) => events.push(event),
      })).pool; } catch (error) { setupError = error; }
      let settled = [];
      if (pool) settled = await Promise.allSettled([
        pool.run({ id: 'bad-refresh', stage: 'implementation', credential: true }, async (ctx) => {
          badContext = ctx; fs.writeFileSync(path.join(ctx.authCache.hostPath, 'auth.json'), '{ broken');
        }),
        pool.run({ id: 'good-refresh', stage: 'implementation', credential: true }, async (ctx) => {
          goodContext = ctx; fs.writeFileSync(path.join(ctx.authCache.hostPath, 'auth.json'), session('good-after'));
          await delay(10);
        }),
      ]);
      const badDurable = badContext && fs.readFileSync(path.join(badContext.cacheRoot, 'auth.json'), 'utf8');
      const goodDurable = goodContext && fs.readFileSync(path.join(goodContext.cacheRoot, 'auth.json'), 'utf8');
      const beforeRecovery = pool && pool.snapshot();
      const preserved = badContext && badDurable === (badContext.cacheRoot === badRoot
        ? session('recovery-A-before') : session('recovery-B-before'))
        && fs.existsSync(badContext.authCache.hostPath);
      check('T6 C3 a refresh failure preserves the prior lane and recoverable task copy while the other lane commits independently',
        !!pool && settled.some((item) => item.status === 'rejected') && preserved
          && goodDurable === session('good-after'),
        JSON.stringify({ setupError: setupError && setupError.message, settled: settled.map((s) => s.status),
          badDurable, goodDurable, beforeRecovery }));

      let recovered = null;
      if (pool && badContext) {
        fs.writeFileSync(path.join(badContext.authCache.hostPath, 'auth.json'), session('recovered-after'));
        try { recovered = await pool.recover(); } catch (error) { recovered = { error: error.message }; }
      }
      const afterRecovery = pool && pool.snapshot();
      const secrets = ['recovery-A-before', 'recovery-B-before', 'good-after', 'recovered-after'];
      check('T8 C2/C4 one bad lane is quarantined without disclosure and returns only after its retained handoff validates',
        !!pool && beforeRecovery && beforeRecovery.healthyLaneCount === 1
          && afterRecovery && afterRecovery.healthyLaneCount === 2
          && fs.readFileSync(path.join(badContext.cacheRoot, 'auth.json'), 'utf8') === session('recovered-after')
          && !fs.existsSync(badContext.authCache.hostPath)
          && safe({ events, beforeRecovery, afterRecovery, recovered,
            settled: settled.map((item) => item.reason) }, secrets),
        JSON.stringify({ beforeRecovery, afterRecovery, recovered, eventCount: events.length }));
    }

    // T7: queued credential workers are FIFO even when completion timing differs.
    {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-djf22-fair-')); roots.push(root);
      const only = lane(root, 'lane', 'fair-secret'); let pool = null; let setupError = null;
      try { if (hasPoolApi()) pool = (await prepared([only])).pool; } catch (error) { setupError = error; }
      const order = []; const queued = ['second', 'third', 'fourth'];
      const expectedOrder = ['first', ...queued];
      const started = defer(); const release = defer(); let first = null; let rest = [];
      if (pool) {
        first = pool.run({ id: 'first', stage: 'implementation', credential: true }, async () => {
          order.push('first'); started.resolve(); await release.promise;
        });
        await started.promise;
        rest = queued.map((id, index) => pool.run({
          id, stage: 'implementation', credential: true,
        }, async () => { order.push(id); await delay(12 - index * 3); }));
        release.resolve(); await Promise.all([first, ...rest]);
      }
      check('T7 C4 delayed credential workers acquire a lane in deterministic FIFO order without starvation',
        !!pool && order.length === expectedOrder.length
          && order.every((id, index) => id === expectedOrder[index]),
        JSON.stringify({ setupError: setupError && setupError.message, order }));
    }

    // T9: four equal delayed workers take about two waves on two lanes, four on one.
    async function measured(count) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), `accept-djf22-speed-${count}-`)); roots.push(root);
      const laneRoots = Array.from({ length: count }, (_, i) => lane(root, `lane-${i}`, `speed-${i}`));
      const { pool } = await prepared(laneRoots); const start = Date.now();
      await Promise.all(Array.from({ length: 4 }, (_, i) => pool.run({
        id: `speed-worker-${i}`, stage: 'implementation', credential: true,
      }, async () => { await delay(65); })));
      return Date.now() - start;
    }
    let oneMs = null; let twoMs = null; let speedError = null;
    try { if (hasPoolApi()) { oneMs = await measured(1); twoMs = await measured(2); } }
    catch (error) { speedError = error; }
    check('T9 C4 two healthy lanes give four deterministic delayed workers a materially shorter makespan',
      Number.isFinite(oneMs) && Number.isFinite(twoMs) && twoMs + 50 < oneMs && twoMs < oneMs * 0.78,
      JSON.stringify({ speedError: speedError && speedError.message, oneMs, twoMs }));
  } catch (error) {
    check('T1-T9 C1-C4 deterministic lane fixture executes', false, error.stack || String(error));
  } finally {
    for (const root of roots) try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  }
  process.exitCode = failed;
}
main().catch((error) => {
  check('T1-T9 C1-C4 deterministic lane fixture settles', false, error.stack || String(error));
  process.exitCode = 1;
});
