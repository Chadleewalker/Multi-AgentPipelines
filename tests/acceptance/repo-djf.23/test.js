// Frozen acceptance test — repo-djf.23: recovery stays inside exclusive private ownership.
// PAIRING (criterion -> tests): C1 -> G1,T1,T2; C2 -> G2,T3,T5;
// C3 -> G3,T3,T4; C4 -> G4,G5,G6,T1,T2,T3,T4,T5,T6.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const REPO = path.resolve(__dirname, '..', '..', '..');
let AUTH = null; let CONFIG = null; let PREFLIGHT = null; let REPORT = null;
try { AUTH = require(path.join(REPO, 'runner', 'codex-auth.js')); } catch {}
try { CONFIG = require(path.join(REPO, 'runner', 'config.js')); } catch {}
try { PREFLIGHT = require(path.join(REPO, 'runner', 'preflight.js')); } catch {}
try { REPORT = require(path.join(REPO, 'runner', 'report.js')); } catch {}
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
function redacted(value, secrets) {
  let text;
  try { text = JSON.stringify(value); } catch { text = String(value); }
  for (const secret of secrets) text = text.split(secret).join('[redacted]');
  return text;
}
function lane(parent, name, token) {
  const root = path.join(parent, name);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  fs.chmodSync(root, 0o700);
  fs.writeFileSync(path.join(root, 'auth.json'), session(token), { mode: 0o600 });
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
function samePath(a, b) {
  const left = path.resolve(String(a || ''));
  const right = path.resolve(String(b || ''));
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}
function git(cwd, args) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
}
function gitObjects(cwd) {
  const listed = git(cwd, ['rev-list', '--objects', '--all']);
  if (listed.status !== 0) return { ids: [], bytes: '', error: listed.stderr || listed.stdout };
  const ids = String(listed.stdout || '').trim().split(/\r?\n/).filter(Boolean)
    .map((line) => line.split(/\s+/)[0]);
  const bytes = ids.map((id) => {
    const object = git(cwd, ['cat-file', '-p', id]);
    return object.status === 0 ? object.stdout : '';
  }).join('\n');
  return { ids, bytes, error: '' };
}
function privateModeFs(nonPrivateRoot) {
  const identity = path.resolve(nonPrivateRoot);
  const inside = (value) => {
    const candidate = path.resolve(String(value));
    return samePath(candidate, identity) || candidate.startsWith(`${identity}${path.sep}`);
  };
  return new Proxy(fs, {
    get(target, property) {
      if (property === 'chmodSync') return (value, mode) => {
        if (!inside(value)) return target.chmodSync(value, mode);
        return undefined;
      };
      if (property === 'statSync' || property === 'lstatSync') return (value, ...args) => {
        const stat = target[property](value, ...args);
        if (!samePath(value, identity)) return stat;
        return new Proxy(stat, { get(item, key) {
          if (key === 'mode') return (item.mode & ~0o777) | 0o755;
          const answer = item[key];
          return typeof answer === 'function' ? answer.bind(item) : answer;
        } });
      };
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
function hasNewApi() {
  return !!AUTH && !!CONFIG && !!PREFLIGHT && !!REPORT
    && typeof AUTH.preflight === 'function'
    && typeof AUTH.createLanePool === 'function'
    && typeof AUTH.stageTaskCache === 'function'
    && typeof AUTH.releaseTaskCache === 'function';
}
async function bounded(promise, ms, label) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms); }),
  ]);
}
function waitLine(child, prefix, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => finish(new Error(`child did not emit ${prefix}`)), timeoutMs);
    const onData = (chunk) => {
      buffer += String(chunk);
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop();
      const match = lines.find((line) => line.startsWith(prefix));
      if (match) finish(null, match);
    };
    const onExit = (code) => finish(new Error(`lane owner exited before ${prefix} (code ${code})`));
    function finish(error, value) {
      clearTimeout(timer);
      child.stdout.off('data', onData);
      child.off('exit', onExit);
      if (error) reject(error); else resolve(value);
    }
    child.stdout.on('data', onData);
    child.on('exit', onExit);
  });
}
function spawnLaneOwner(cacheRoot) {
  const script = [
    "'use strict';",
    "const path=require('path');",
    "const auth=require(path.join(process.argv[1],'runner','codex-auth.js'));",
    "let handle=null;",
    "Promise.resolve(auth.stageTaskCache({cacheRoot:process.argv[2],taskId:'other-project',wait:false,timeoutMs:200,retryMs:2})).then((h)=>{",
    " handle=h; process.stdout.write('READY '+String(h.owner&&h.owner.nonce||'')+'\\n');",
    " process.stdin.once('data',()=>Promise.resolve(auth.releaseTaskCache(handle)).then(()=>{process.stdout.write('RELEASED\\n');process.exit(0);},(e)=>{process.stderr.write(String(e&&e.message||e));process.exit(3);}));",
    "},(e)=>{process.stderr.write(String(e&&e.message||e));process.exit(2);});",
  ].join('');
  return spawn(process.execPath, ['-e', script, REPO, cacheRoot], {
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
}

async function main() {
  const roots = [];
  const secrets = [
    'djf23-valid-A', 'djf23-valid-B', 'djf23-target-secret',
    'djf23-workspace-secret', 'djf23-nested-parent', 'djf23-nested-child',
    'djf23-non-private', 'djf23-race-A0', 'djf23-race-A-repair',
    'djf23-race-B0', 'djf23-race-B-progress', 'djf23-changed-A0',
    'djf23-changed-retained', 'djf23-changed-owner',
  ];
  const observations = [];
  const workerViews = [];
  let targetObjectsBefore = null;
  let targetObjectsAfter = null;
  let reportText = '';
  let ownerChild = null;
  let missingApi = '';
  try {
    if (!hasNewApi()) missingApi = 'createLanePool and the multi-lane recovery API are required';

    const pathRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-djf23-paths-'));
    roots.push(pathRoot);
    const target = path.join(pathRoot, 'target');
    fs.mkdirSync(target, { recursive: true });
    git(target, ['init', '-q']);
    git(target, ['config', 'user.email', 'acceptance@example.invalid']);
    git(target, ['config', 'user.name', 'Acceptance Fixture']);
    fs.writeFileSync(path.join(target, 'README.md'), 'fixture\n');
    git(target, ['add', 'README.md']);
    git(target, ['commit', '-qm', 'fixture']);
    targetObjectsBefore = gitObjects(target);

    const validA = lane(pathRoot, 'private-a', secrets[0]);
    const validB = lane(pathRoot, 'private-b', secrets[1]);
    const targetLocal = lane(target, 'credential-lane', secrets[2]);
    const workspace = path.join(pathRoot, 'pipeline-task-workspace');
    fs.mkdirSync(path.join(workspace, '.git'), { recursive: true });
    fs.mkdirSync(path.join(workspace, '.run'), { recursive: true });
    const workspaceLocal = lane(workspace, 'credential-lane', secrets[3]);
    const nestedParent = lane(pathRoot, 'nested-parent', secrets[4]);
    const nestedChild = lane(nestedParent, 'nested-child', secrets[5]);
    const nonPrivate = lane(pathRoot, 'non-private', secrets[6]);
    const missing = path.join(pathRoot, 'missing-lane');
    const lexicalAlias = path.join(validA, '..', path.basename(validA));
    const linkAlias = path.join(pathRoot, 'linked-alias');
    let aliasCreated = false;
    try {
      fs.symlinkSync(validA, linkAlias, process.platform === 'win32' ? 'junction' : 'dir');
      aliasCreated = true;
    } catch { /* lexical alias still proves an alternate spelling */ }

    async function attemptAdmission(label, listedRoots) {
      const calls = { admission: 0, identity: 0, docker: 0, network: 0, beads: 0 };
      const logs = [];
      let cfg = null; let loadError = null; let result = null;
      try { cfg = CONFIG && CONFIG.loadConfig(configFile(pathRoot, target, listedRoots)); }
      catch (error) { loadError = error; }
      if (cfg && PREFLIGHT) {
        try {
          result = await PREFLIGHT.preflight(cfg, REPO, {
            runId: `accept-djf23-${label}`,
            info(...args) { logs.push(args); }, error(...args) { logs.push(args); },
          }, {
            env: {},
            admitEntry() { calls.admission += 1; return {
              ok: false, reason: 'fixture-stop', message: 'stop after authentication boundary',
            }; },
            verifyRepoIdentity() { calls.identity += 1; return { ok: true }; },
            dockerAvailable() { calls.docker += 1; return { status: 0 }; },
            networkUp() { calls.network += 1; return { ok: true }; },
            recoverStaleIssues() { calls.beads += 1; return { recovered: [] }; },
          });
        } catch (error) { result = { thrown: error && error.message }; }
      }
      const visible = { loadError: loadError && loadError.message, result, logs };
      const refused = !!loadError || !!(result && result.authRefused === true);
      const beforeMutation = Object.values(calls).every((count) => count === 0);
      const item = { label, refused, beforeMutation, calls, safe: safe(visible, secrets) };
      observations.push({ label, visible });
      return item;
    }

    let healthy = null; let healthyCfg = null;
    if (hasNewApi()) {
      try {
        healthyCfg = CONFIG.loadConfig(configFile(pathRoot, target, [validA, validB]));
        healthy = await AUTH.preflight({ mode: 'chatgpt', cacheRoots: [validA, validB],
          wait: false, timeoutMs: 30, retryMs: 2 });
      } catch (error) { healthy = { error: error && error.message }; }
    }
    const syntaxCases = hasNewApi() ? await Promise.all([
      attemptAdmission('relative', [validA, path.relative(process.cwd(), validB)]),
      attemptAdmission('missing', [validA, missing]),
      attemptAdmission('lexical-alias', [validA, lexicalAlias]),
      ...(aliasCreated ? [attemptAdmission('link-alias', [validA, linkAlias])] : []),
    ]) : [];
    check('T1 C1/C4 configured lane roots are canonical absolute existing identities and relative, missing, or aliased rosters refuse safely before mutation',
      !missingApi && !!healthyCfg && Array.isArray(healthyCfg.codexAuthCacheRoots)
        && healthyCfg.codexAuthCacheRoots.length > 0
        && samePath(healthyCfg.codexAuthCacheRoots[0], validA)
        && samePath(healthyCfg.codexAuthCacheRoots[1], validB)
        && healthy && healthy.ok === true
        && healthy.healthyLaneCount === healthyCfg.codexAuthCacheRoots.length
        && syntaxCases.length >= 3
        && syntaxCases.every((item) => item.refused && item.beforeMutation && item.safe)
        && !fs.existsSync(missing),
      redacted({ missingApi, healthy: healthy && { ok: healthy.ok, count: healthy.healthyLaneCount },
        cases: syntaxCases }, secrets));

    const locationCases = hasNewApi() ? await Promise.all([
      attemptAdmission('pipeline-local', [validA, path.join(REPO, 'runner')]),
      attemptAdmission('target-local', [validA, targetLocal]),
      attemptAdmission('task-workspace-local', [validA, workspaceLocal]),
      attemptAdmission('overlapping', [nestedParent, nestedChild]),
    ]) : [];
    let nonPrivateResult = null;
    if (hasNewApi()) {
      const platform = Object.getOwnPropertyDescriptor(process, 'platform');
      try {
        Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
        nonPrivateResult = await AUTH.preflight({ mode: 'chatgpt', cacheRoots: [nonPrivate],
          fs: privateModeFs(nonPrivate), wait: false, timeoutMs: 30, retryMs: 2,
          targetRepoPath: target, repoRoot: REPO, workspaceRoots: [workspace] });
      } catch (error) { nonPrivateResult = { thrown: error && error.message }; }
      finally { Object.defineProperty(process, 'platform', platform); }
    }
    observations.push({ label: 'non-private', visible: nonPrivateResult });
    check('T2 C1/C4 repository-local, target-local, task-workspace, overlapping, and non-private lane roots all refuse before target mutation without disclosure',
      !missingApi && locationCases.length > 0
        && locationCases.every((item) => item.refused && item.beforeMutation && item.safe)
        && nonPrivateResult && nonPrivateResult.ok === false
        && safe(nonPrivateResult, secrets),
      redacted({ missingApi, cases: locationCases,
        nonPrivate: nonPrivateResult && { ok: nonPrivateResult.ok,
          count: nonPrivateResult.healthyLaneCount, reason: nonPrivateResult.reason } }, secrets));

    let busyInvariant = false;
    let safeRecovery = false;
    let progress = false;
    let raceEvents = [];
    let racePool = null;
    let raceContext = null;
    let raceError = null;
    let raceRoot = null;
    let raceA = null;
    let raceB = null;
    if (hasNewApi()) {
      raceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-djf23-race-'));
      roots.push(raceRoot);
      raceA = lane(raceRoot, 'lane-a', secrets[7]);
      raceB = lane(raceRoot, 'lane-b', secrets[9]);
      try {
        const pre = await AUTH.preflight({ mode: 'chatgpt', cacheRoots: [raceA, raceB],
          wait: false, timeoutMs: 40, retryMs: 2 });
        racePool = AUTH.createLanePool({ lanes: pre.lanes, retryMs: 2, timeoutMs: 40,
          onEvent: (event) => raceEvents.push(event) });
        try {
          await racePool.run({ id: 'retained-owner', stage: 'implementation', credential: true }, async (ctx) => {
            raceContext = ctx;
            fs.writeFileSync(path.join(ctx.authCache.hostPath, 'auth.json'), '{ broken refresh');
          });
        } catch (error) { raceError = error; }
        fs.writeFileSync(path.join(raceContext.authCache.hostPath, 'auth.json'), session(secrets[8]));
        const durableBefore = fs.readFileSync(path.join(raceA, 'auth.json'), 'utf8');
        const retainedBefore = fs.readFileSync(path.join(raceContext.authCache.hostPath, 'auth.json'), 'utf8');
        ownerChild = spawnLaneOwner(raceA);
        const ready = await waitLine(ownerChild, 'READY ');
        const otherNonce = ready.slice('READY '.length);
        const lockFile = path.join(raceA, '.lane.lock');
        const lockBefore = fs.readFileSync(lockFile, 'utf8');
        let busyRecover = null; let busyRecoverError = null;
        try { busyRecover = await bounded(racePool.recover(), 750, 'busy recovery'); }
        catch (error) { busyRecoverError = error; }
        const lockAfter = fs.existsSync(lockFile) ? fs.readFileSync(lockFile, 'utf8') : null;
        const busySnapshot = racePool.snapshot();
        busyInvariant = !!raceError && otherNonce
          && raceContext.authCache.owner && otherNonce !== raceContext.authCache.owner.nonce
          && !busyRecoverError && busyRecover
          && Array.isArray(busyRecover.recovered) && busyRecover.recovered.length === 0
          && fs.readFileSync(path.join(raceA, 'auth.json'), 'utf8') === durableBefore
          && fs.existsSync(raceContext.authCache.hostPath)
          && fs.readFileSync(path.join(raceContext.authCache.hostPath, 'auth.json'), 'utf8') === retainedBefore
          && lockAfter === lockBefore
          && busySnapshot.quarantined.some((item) => item.id === raceContext.laneId)
          && !raceEvents.some((event) => event.type === 'lane.recovered');

        if (busyInvariant) {
          try {
            const value = await bounded(racePool.run({ id: 'healthy-sibling', stage: 'implementation',
              credential: true }, async (ctx) => {
              workerViews.push(ctx);
              fs.writeFileSync(path.join(ctx.authCache.hostPath, 'auth.json'), session(secrets[10]));
              return ctx.laneId;
            }), 750, 'healthy sibling');
            progress = value && value !== raceContext.laneId
              && fs.readFileSync(path.join(raceB, 'auth.json'), 'utf8') === session(secrets[10]);
          } catch { progress = false; }
        }
        const releasedLine = waitLine(ownerChild, 'RELEASED');
        ownerChild.stdin.write('release\n');
        await releasedLine;
        ownerChild = null;
        const safeResult = await bounded(racePool.recover(), 750, 'safe recovery');
        const durableAfter = fs.readFileSync(path.join(raceA, 'auth.json'), 'utf8');
        const stateAfter = racePool.snapshot();
        const secondResult = await bounded(racePool.recover(), 750, 'second recovery');
        safeRecovery = busyInvariant && progress
          && safeResult.recovered.length === 1 && safeResult.recovered[0] === raceContext.laneId
          && durableAfter === session(secrets[8])
          && !fs.existsSync(raceContext.authCache.hostPath)
          && !fs.existsSync(path.join(raceA, '.lane.lock'))
          && stateAfter.healthyLaneCount === 2
          && secondResult.recovered.length === 0
          && fs.readFileSync(path.join(raceA, 'auth.json'), 'utf8') === durableAfter
          && raceEvents.filter((event) => event.type === 'lane.recovered'
            && event.laneId === raceContext.laneId).length === 1;
      } catch (error) {
        observations.push({ label: 'race-error', visible: error && error.message });
      } finally {
        if (ownerChild) {
          try { ownerChild.stdin.write('release\n'); } catch {}
          try { ownerChild.kill(); } catch {}
          ownerChild = null;
        }
      }
    }
    check('T3 C2/C3/C4 retained recovery cannot write, become healthy, or remove the exact lock while a distinct owner holds the lane',
      !missingApi && busyInvariant && safe({ raceError: raceError && raceError.message,
        events: raceEvents, workerViews }, secrets),
      redacted({ missingApi, busyInvariant, snapshot: racePool && racePool.snapshot(),
        eventTypes: raceEvents.map((event) => event.type) }, secrets));
    check('T4 C3/C4 after safe release the retained repair recovers exactly once while a healthy sibling lane continues without starvation or disclosure',
      !missingApi && safeRecovery && progress
        && safe({ events: raceEvents, workerViews }, secrets),
      redacted({ missingApi, safeRecovery, progress,
        recoveredEvents: raceEvents.filter((event) => event.type === 'lane.recovered').length }, secrets));

    let changedInvariant = false;
    let changedEvents = [];
    if (hasNewApi()) {
      const changedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-djf23-changed-'));
      roots.push(changedRoot);
      const changedLane = lane(changedRoot, 'lane', secrets[11]);
      try {
        const pre = await AUTH.preflight({ mode: 'chatgpt', cacheRoots: [changedLane],
          wait: false, timeoutMs: 40, retryMs: 2 });
        const pool = AUTH.createLanePool({ lanes: pre.lanes, retryMs: 2, timeoutMs: 40,
          onEvent: (event) => changedEvents.push(event) });
        let retained = null; let rejected = null;
        try {
          await pool.run({ id: 'changed-retained', stage: 'implementation', credential: true }, async (ctx) => {
            retained = ctx;
            fs.writeFileSync(path.join(ctx.authCache.hostPath, 'auth.json'), '{ invalid');
          });
        } catch (error) { rejected = error; }
        fs.writeFileSync(path.join(retained.authCache.hostPath, 'auth.json'), session(secrets[12]));
        const contender = await AUTH.stageTaskCache({ cacheRoot: changedLane,
          taskId: 'changed-owner', wait: false, timeoutMs: 40, retryMs: 2 });
        fs.writeFileSync(path.join(contender.hostPath, 'auth.json'), session(secrets[13]));
        await AUTH.releaseTaskCache(contender);
        const durableChanged = fs.readFileSync(path.join(changedLane, 'auth.json'), 'utf8');
        const retainedChanged = fs.readFileSync(path.join(retained.authCache.hostPath, 'auth.json'), 'utf8');
        const recovered = await bounded(pool.recover(), 750, 'changed-source recovery');
        changedInvariant = !!rejected && recovered.recovered.length === 0
          && fs.readFileSync(path.join(changedLane, 'auth.json'), 'utf8') === durableChanged
          && durableChanged === session(secrets[13])
          && fs.existsSync(retained.authCache.hostPath)
          && fs.readFileSync(path.join(retained.authCache.hostPath, 'auth.json'), 'utf8') === retainedChanged
          && retainedChanged === session(secrets[12])
          && pool.snapshot().quarantined.some((item) => item.id === retained.laneId)
          && !fs.existsSync(path.join(changedLane, '.lane.lock'))
          && !changedEvents.some((event) => event.type === 'lane.recovered');
      } catch (error) { observations.push({ label: 'changed-error', visible: error && error.message }); }
    }
    check('T5 C2/C4 recovery proves the durable source version and leaves a changed lane plus retained repair byte-for-byte quarantined',
      !missingApi && changedInvariant && safe(changedEvents, secrets),
      redacted({ missingApi, changedInvariant,
        eventTypes: changedEvents.map((event) => event.type) }, secrets));

    targetObjectsAfter = gitObjects(target);
    const project = JSON.parse(fs.readFileSync(path.join(REPO, 'pipeline.config.json'), 'utf8'));
    const regression = String(project.regressionCommand || '').trim().split(/\s+/).pop();
    reportText = REPORT ? REPORT.renderReport({
      runId: 'repo-djf23', startedAt: '2026-01-01T00:00:00Z',
      finishedAt: '2026-01-01T00:00:01Z', targetRepo: target,
      tasks: [{ issueId: 'repo-djf.23', outcome: 'failed', attempts: 1,
        error: String(raceError && raceError.message || 'lane remained quarantined'),
        attemptNotes: raceEvents.map((event) => `${event.type}:${event.reason || ''}`) }],
    }) : '';
    const allObservableSafe = safe({ observations, workerViews, raceEvents, changedEvents,
      reportText, targetObjects: targetObjectsAfter }, secrets);
    const gitUnchanged = targetObjectsBefore && targetObjectsAfter
      && !targetObjectsBefore.error && !targetObjectsAfter.error
      && JSON.stringify(targetObjectsAfter.ids) === JSON.stringify(targetObjectsBefore.ids)
      && safe(targetObjectsAfter.bytes, secrets);

    for (const root of roots) {
      try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
    }
    const fixturesRemoved = roots.every((root) => !fs.existsSync(root));
    check('T6 C4 errors, events, generated reports, Git objects, and worker-visible paths contain no lane bytes, and the focused fixture leaves no lock or retained artifact',
      !missingApi && allObservableSafe && gitUnchanged && fixturesRemoved
        && project.regressionPolicy === 'required' && !!regression
        && fs.existsSync(path.resolve(REPO, regression.replace(/^[\'\"]|[\'\"]$/g, ''))),
      redacted({ missingApi, allObservableSafe, gitUnchanged, fixturesRemoved,
        regressionPolicy: project.regressionPolicy, regressionCommand: project.regressionCommand }, secrets));
  } catch (error) {
    console.error(`FAIL - T1-T6 C1-C4 deterministic acceptance fixture completes — ${redacted(error && error.stack || error, secrets)}`);
    failed = 1;
  } finally {
    if (ownerChild) {
      try { ownerChild.kill(); } catch {}
    }
    for (const root of roots) {
      try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
    }
  }
  process.exitCode = failed;
}
main().catch((error) => {
  console.error(`FAIL - T1-T6 C1-C4 deterministic acceptance fixture settles — ${String(error && error.message || error)}`);
  process.exitCode = 1;
});
