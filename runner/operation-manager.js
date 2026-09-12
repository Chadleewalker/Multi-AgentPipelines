// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// Durable host child operations for a project supervisor (DESIGN.md §3.10, §4.12).
//
// This module deliberately does not implement preparation or task execution. It launches the
// existing prepare-batch and live-feed runner entry points and observes their existing durable
// artifacts. The only new persistence is host-owned process/attempt metadata, which closes the
// crash window between deciding to launch a child and learning its pid.
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const lock = require('./lock');
const defaultSupervisor = require('./supervisor');
const defaultPreparationState = require('./preparation-state');

const PROVIDER_CREDENTIALS = [
  'CODEX_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
];
const DEFAULT_LIFECYCLE_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const ACTIVE_PREPARATION_STATES = new Set(['pending', 'interrupted-unknown']);

function readJson(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const scratch = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(scratch, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(scratch, file);
  } finally {
    try { fs.unlinkSync(scratch); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
}

function createJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  let fd;
  try { fd = fs.openSync(file, 'wx', 0o600); }
  catch (e) { if (e.code === 'EEXIST') return false; throw e; }
  try { fs.writeSync(fd, `${JSON.stringify(value, null, 2)}\n`); }
  finally { fs.closeSync(fd); }
  return true;
}

function removeFile(file) {
  try { fs.unlinkSync(file); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
}

function sameBytes(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function containedBy(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function canonicalProject(project) {
  if (typeof project !== 'string' || !project.trim()) throw new Error('operation manager: project is required');
  return lock.canonicalTarget(project);
}

function projectKey(project) {
  return crypto.createHash('sha256').update(canonicalProject(project)).digest('hex');
}

function safeId(value) {
  const id = String(value || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) || id === '.' || id === '..' || id.includes('..')) {
    throw new Error('operation manager: operation id must be a safe portable identifier');
  }
  return id;
}

function runId() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${stamp}-${crypto.randomBytes(5).toString('hex')}`;
}

function publicRecord(record) {
  if (!record) return null;
  const copy = { ...record };
  delete copy.parentLease;
  return copy;
}

function createHostOperationManager(options = {}) {
  const pipelineRoot = path.resolve(options.pipelineRoot || path.join(__dirname, '..'));
  const env = { ...(options.env || process.env) };
  const stateRoot = path.resolve(options.stateRoot
    || path.join(env.PIPELINE_STATE_DIR || path.join(os.homedir(), '.multi-agent-pipelines'), 'operations'));
  const preparationState = options.preparationState || defaultPreparationState;
  const preparationRoot = path.resolve(options.preparationRoot
    || defaultPreparationState.preparationRoot(env));
  const runsRoot = path.resolve(options.runsRoot || path.join(pipelineRoot, 'runs'));
  const supervisor = options.supervisor || defaultSupervisor;
  const spawn = options.spawn || cp.spawn;
  const faults = options.faults || {};
  const lifecycleTimeoutMs = Number.isFinite(options.lifecycleTimeoutMs) && options.lifecycleTimeoutMs > 0
    ? options.lifecycleTimeoutMs : DEFAULT_LIFECYCLE_TIMEOUT_MS;
  const scripts = {
    prepare: path.resolve((options.scripts && options.scripts.prepare)
      || path.join(pipelineRoot, 'scripts', 'prepare-batch.js')),
    run: path.resolve((options.scripts && options.scripts.run)
      || path.join(pipelineRoot, 'runner', 'run.js')),
  };

  function pathsFor(project, id) {
    const key = projectKey(project);
    const operationId = safeId(id);
    const dir = path.join(stateRoot, key);
    const statePath = path.join(dir, `${operationId}.json`);
    return {
      dir,
      statePath,
      retryPath: `${statePath}.retry`,
      reconcilePath: `${statePath}.reconcile`,
      feedPath: path.join(dir, 'implementation-feed.slot'),
    };
  }

  function assertExternal(project) {
    const target = canonicalProject(project);
    const durableRoot = canonicalProject(stateRoot);
    if (containedBy(target, durableRoot)) {
      throw new Error('operation manager: durable operation state must be outside the model-editable project');
    }
    return target;
  }

  function persist(record) {
    writeJson(record.statePath, record);
    return record;
  }

  function acquireTransition(file, value) {
    const token = crypto.randomBytes(18).toString('hex');
    const holder = { ...value, token, pid: process.pid, ...lock.livenessFields() };
    if (createJson(file, holder)) return { ok: true, token };
    const existing = readJson(file);
    // A process that died during the small synchronous transition cannot finish it. Reclaim
    // only when the shared liveness primitive proves that fact; unreadable identity fails closed.
    if (existing && existing.token && !lock.isHolderLive(existing)) {
      removeFile(file);
      if (createJson(file, holder)) return { ok: true, token };
    }
    return { ok: false, error: 'operation manager: another atomic transition is in progress' };
  }

  function releaseTransition(file, token) {
    const holder = readJson(file);
    if (holder && holder.token === token && holder.pid === process.pid) removeFile(file);
  }

  function acquireFeedSlot(project, id, attempt, nonce, currentRunId) {
    const { feedPath } = pathsFor(project, id);
    const token = crypto.randomBytes(18).toString('hex');
    const slot = {
      schema: 1, kind: 'implementation-feed-slot', project, id, attempt,
      grantNonce: nonce, runId: currentRunId, token, reservedAt: new Date().toISOString(),
    };
    if (!createJson(feedPath, slot)) {
      const holder = readJson(feedPath);
      return { ok: false, error: `operation manager: project already has a reserved implementation feed${holder && holder.id ? ` ${holder.id}` : ''}` };
    }
    return { ok: true, feedPath, token };
  }

  function releaseFeedSlot(record) {
    if (!record || !record.feedPath || !record.feedSlotToken) return;
    const holder = readJson(record.feedPath);
    if (holder && holder.token === record.feedSlotToken
        && holder.id === record.id && holder.attempt === record.attempt) removeFile(record.feedPath);
  }

  function updateIfCurrent(statePath, attempt, pid, fn) {
    const current = readJson(statePath);
    if (!current || current.attempt !== attempt || (pid !== null && current.pid !== pid)) return null;
    const next = fn({ ...current });
    if (next && !sameBytes(current, next)) writeJson(statePath, next);
    return next || current;
  }

  function stateFiles(project) {
    const dir = path.join(stateRoot, projectKey(project));
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return []; }
    return names.filter((name) => name.endsWith('.json')).map((name) => path.join(dir, name));
  }

  function recoverImplementationIdentity(record, mutate = true) {
    if (record.kind !== 'implementation' || record.pid || record.childIdentity !== 'pending') return record;
    let names = [];
    try { names = fs.readdirSync(runsRoot); } catch { return record; }
    for (const name of names.sort()) {
      const observed = readJson(path.join(runsRoot, name, 'child-observed.json'));
      if (!observed || observed.kind !== 'implementation-child' || observed.authenticated !== true
          || observed.authorityNonce !== record.grantNonce || observed.runId !== record.runId
          || name !== record.runId || !Number.isInteger(observed.pid) || observed.pid <= 0) continue;
      const recovered = {
        ...record,
        pid: observed.pid,
        processIdentity: { ...lock.livenessFields(observed.pid), startedAt: record.startedAt },
        childIdentity: 'known',
        childObserved: observed,
        identityRecoveredAt: new Date().toISOString(),
      };
      if (mutate) persist(recovered);
      return recovered;
    }
    return record;
  }

  function evidence(record) {
    const live = !record.exitedAt && !!record.processIdentity
      && lock.isHolderLive(record.processIdentity);

    if (record.kind === 'preparation') {
      const preparation = preparationState.deriveState(preparationRoot, record.batchId);
      const issues = preparation && Array.isArray(preparation.issues) ? preparation.issues : [];
      const interrupted = issues.some((issue) => issue && issue.state === 'interrupted-unknown');
      const terminal = !!(preparation && preparation.ok && issues.length
        && issues.every((issue) => issue && !ACTIVE_PREPARATION_STATES.has(issue.state)));
      return { live, terminal, interrupted, preparation };
    }

    const manifest = readJson(path.join(record.runDir, 'run.json'));
    const terminal = !!(manifest && manifest.runId === record.runId && manifest.finishedAt);
    return { live, terminal, interrupted: false, manifest };
  }

  function attemptSnapshot(record) {
    const observed = evidence(record);
    return {
      attempt: record.attempt,
      state: record.state,
      operation: {
        kind: record.kind, id: record.id, project: record.project,
        batchId: record.batchId, runId: record.runId, configPath: record.configPath,
        startedAt: record.startedAt, observedAt: record.observedAt || null,
      },
      pid: record.pid,
      processIdentity: record.processIdentity || null,
      startedAt: record.startedAt,
      exitedAt: record.exitedAt || null,
      grantNonce: record.grantNonce,
      authorityPath: record.authorityPath,
      authority: readJson(record.authorityPath),
      artifactPaths: record.artifactPaths,
      artifactEvidence: record.kind === 'preparation' ? observed.preparation : observed.manifest,
      exit: {
        exitedAt: record.exitedAt || null,
        code: Number.isInteger(record.exitCode) ? record.exitCode : null,
        signal: record.exitSignal || null,
      },
      attention: record.attention || record.launchError || 'child exited without terminal artifact evidence',
      settlement: record.settlement || null,
      childIdentity: record.childIdentity || (record.pid ? 'known' : 'uncertain'),
    };
  }

  function settleCompleted(record) {
    if (record.settlement && record.settlement.state === 'complete') return record;
    const marker = `${record.statePath}.settlement`;
    if (!createJson(marker, {
      operation: record.id,
      attempt: record.attempt,
      grantNonce: record.grantNonce,
      startedAt: new Date().toISOString(),
    })) {
      return { ...record, settlement: { state: 'attempting',
        attemptedAt: (record.settlement && record.settlement.attemptedAt) || null } };
    }
    // Persist the intent first. If this process dies inside the parent call, a later observer
    // reports attention instead of issuing a second settlement whose first result is unknown.
    let current = { ...record, settlement: { state: 'attempting', attemptedAt: new Date().toISOString() } };
    persist(current);
    let result;
    try {
      result = supervisor.settle(current.parentLease, current.grantNonce, { outcome: 'complete' });
    } catch (e) {
      // A throw does not tell us whether the parent wrote before throwing. Keep the exclusive
      // marker and the attempting record so restart cannot turn uncertainty into a duplicate.
      current = { ...current, settlement: { ...current.settlement,
        error: (e && e.message) || String(e) } };
      persist(current);
      return current;
    }
    const uncertain = !result || result.uncertain === true;
    current = {
      ...current,
      state: result && result.ok ? 'completed' : (uncertain ? 'attention' : current.state),
      settlement: result && result.ok
        ? { state: 'complete', attemptedAt: current.settlement.attemptedAt, settledAt: new Date().toISOString() }
        : uncertain
          ? { state: 'attempting', attemptedAt: current.settlement.attemptedAt,
            error: (result && result.error) || 'parent settlement result is uncertain' }
          : { state: 'pending', attemptedAt: current.settlement.attemptedAt,
            error: result.error || 'parent refused settlement' },
      ...(uncertain ? { attention: 'settlement outcome is uncertain; reconcile the parent grant before retrying' } : {}),
    };
    persist(current);
    if (!uncertain) removeFile(marker);
    return current;
  }

  function inspect(record, mutate = true) {
    record = recoverImplementationIdentity(record, mutate);
    const observed = evidence(record);
    let state;
    if (observed.live) state = 'running';
    else if (observed.terminal && !observed.interrupted
      && !(record.settlement && record.settlement.state === 'attempting')
      && !fs.existsSync(`${record.statePath}.settlement`)) state = 'completed';
    else state = 'attention';

    let current = record;
    if (record.state !== state) {
      current = { ...record, state, observedAt: new Date().toISOString(),
        ...(state === 'attention' && !record.attention
          ? { attention: record.childIdentity === 'pending'
            ? 'child identity is uncertain; reconcile authenticated child artifacts before retrying'
            : 'child exited without terminal artifact evidence' }
          : {}) };
      if (mutate) persist(current);
    }
    if (state === 'completed' && mutate) current = settleCompleted(current);
    if (current.settlement && current.settlement.state === 'attempting') state = 'attention';
    if (state === 'attention' && current.settlement && current.settlement.state === 'attempting') {
      const attention = 'settlement outcome is uncertain; inspect the parent grant before retrying';
      current = { ...current, state: 'attention', attention };
      if (mutate && (record.state !== 'attention' || record.attention !== attention)) persist(current);
    }
    if (mutate && !observed.live && current.childIdentity !== 'pending') releaseFeedSlot(current);
    return {
      ...publicRecord(current),
      state,
      ...(record.kind === 'preparation' ? { preparation: observed.preparation } : { manifest: observed.manifest }),
    };
  }

  function status({ project, id } = {}) {
    let statePath;
    try { ({ statePath } = pathsFor(project, id)); }
    catch (e) { return { ok: false, error: e.message }; }
    const record = readJson(statePath);
    if (!record || record.project !== canonicalProject(project) || record.id !== String(id)) {
      return { ok: false, error: `operation manager: no operation ${String(id || '')} for this project` };
    }
    return { ok: true, ...inspect(record) };
  }

  function validateGrant(kind, project, batchId, grant) {
    const authority = grant && grant.authority;
    if (!authority || typeof authority !== 'object') return 'a child grant is required';
    if (authority.scope !== kind) return `grant scope ${authority.scope || '(missing)'} does not match ${kind}`;
    let target;
    try { target = canonicalProject(authority.target); }
    catch { return 'grant target is missing or invalid'; }
    if (target !== canonicalProject(project)) return 'grant target does not match the project';
    if (!/^[a-f0-9]{32,128}$/.test(String(authority.nonce || ''))) return 'grant nonce is invalid';
    if (kind === 'preparation' && authority.batch !== batchId) return 'grant batch does not match the preparation batch';
    if (!grant.parentLease || typeof grant.parentLease !== 'object') return 'the parent lease is required for settlement';
    return null;
  }

  function competingImplementation(project, exceptId = null) {
    for (const file of stateFiles(project)) {
      const record = readJson(file);
      if (!record || record.kind !== 'implementation' || record.id === exceptId) continue;
      // A launch decision already persisted but not yet assigned a pid is still exclusive.
      // The caller that wrote it may be between create and spawn in another process.
      if (record.state === 'launching') return publicRecord(record);
      const observed = inspect(record);
      if (observed.state === 'running') return observed;
    }
    return null;
  }

  function launch(input, prior = null) {
    const kind = input.kind;
    const id = safeId(input.id);
    const project = assertExternal(input.project);
    const grantError = validateGrant(kind, project, input.batchId || null, input.grant);
    if (grantError) return { ok: false, error: `operation manager: ${grantError}` };
    const { dir, statePath } = pathsFor(project, id);

    const attempt = prior ? prior.attempt + 1 : 1;
    const authorityPath = path.join(dir, `${id}.attempt-${attempt}.authority.json`);
    const currentRunId = kind === 'implementation' ? runId() : null;
    const runDir = currentRunId ? path.join(runsRoot, currentRunId) : null;
    const startedAt = new Date().toISOString();
    const previousAttempts = prior
      ? [...(Array.isArray(prior.attempts) ? prior.attempts
        : (Array.isArray(prior.previousAttempts) ? prior.previousAttempts : [])), attemptSnapshot(prior)]
      : [];
    let feedSlot = null;
    if (kind === 'implementation') {
      feedSlot = acquireFeedSlot(project, id, attempt, input.grant.authority.nonce, currentRunId);
      if (!feedSlot.ok) return feedSlot;
      const competitor = competingImplementation(project, id);
      if (competitor) {
        releaseFeedSlot({ id, attempt, feedPath: feedSlot.feedPath, feedSlotToken: feedSlot.token });
        return { ok: false, error: `operation manager: project already has live implementation ${competitor.id}` };
      }
    }
    const record = {
      schema: 1,
      kind,
      id,
      project,
      state: 'launching',
      statePath,
      attempt,
      previousAttempts,
      attempts: previousAttempts,
      startedAt,
      pid: null,
      processIdentity: null,
      childIdentity: 'pending',
      grantNonce: input.grant.authority.nonce,
      authorityPath,
      parentLease: input.grant.parentLease,
      configPath: input.configPath,
      issues: kind === 'preparation' ? [...input.issues] : [],
      ...(kind === 'preparation' && input.authorConcurrency !== undefined
        ? { authorConcurrency: input.authorConcurrency } : {}),
      batchId: kind === 'preparation' ? input.batchId : null,
      runId: currentRunId,
      runDir,
      feedPath: feedSlot && feedSlot.feedPath,
      feedSlotToken: feedSlot && feedSlot.token,
      artifactPaths: kind === 'preparation'
        ? { preparationDir: path.join(preparationRoot, input.batchId) }
        : { runDir, manifest: path.join(runDir, 'run.json'), log: path.join(runDir, 'run.log') },
    };

    // Exact-operation exclusion is the exclusive create itself. On retry the prior record is
    // intentionally replaced, but its attempt evidence has already been copied above.
    if (prior) persist(record);
    else if (!createJson(statePath, record)) {
      releaseFeedSlot(record);
      return { ok: false, error: `operation manager: operation ${id} is already recorded` };
    }
    writeJson(authorityPath, input.grant.authority);

    const childEnv = { ...env, PIPELINE_CHILD_AUTHORITY: authorityPath };
    for (const name of PROVIDER_CREDENTIALS) delete childEnv[name];
    if (kind === 'preparation') childEnv.PREPARATION_RUNS_DIR = preparationRoot;
    else {
      childEnv.RUN_ID = currentRunId;
      childEnv.PIPELINE_RUNS_DIR = runsRoot;
    }
    const argv = kind === 'preparation'
      ? [scripts.prepare, 'start', input.batchId, '--config', input.configPath,
        ...input.issues.flatMap((issue) => ['--issue', issue]),
        ...(input.authorConcurrency === undefined ? [] : ['--author-concurrency', String(input.authorConcurrency)])]
      : [scripts.run, '--config', input.configPath];
    let child;
    try {
      child = spawn(process.execPath, argv, {
        shell: false,
        stdio: 'ignore',
        timeout: lifecycleTimeoutMs,
        killSignal: 'SIGKILL',
        env: childEnv,
      });
      if (!child || !Number.isInteger(child.pid) || child.pid <= 0) throw new Error('spawn returned no child pid');
    } catch (e) {
      const failed = { ...record, state: 'attention', childIdentity: 'not-spawned',
        attention: 'child spawn failed before a process identity was returned',
        launchError: (e && e.message) || String(e), observedAt: new Date().toISOString() };
      persist(failed);
      releaseFeedSlot(failed);
      return { ok: false, error: `operation manager: child launch failed: ${failed.launchError}`, operation: publicRecord(failed) };
    }

    // The launching record, exact authority and run id are durable before spawn. This seam
    // models loss of the manager in the one remaining window; recovery must authenticate the
    // child's own host artifact and must not clear the project slot merely because pid is null.
    if (faults.afterSpawnBeforePidPersist === true) {
      throw new Error('operation manager: injected crash after spawn before pid persistence');
    }

    const running = {
      ...record,
      state: 'running',
      pid: child.pid,
      childIdentity: 'known',
      processIdentity: { ...lock.livenessFields(child.pid), startedAt },
    };
    persist(running);
    if (typeof child.once === 'function') {
      child.once('exit', (code, signal) => {
        updateIfCurrent(statePath, attempt, child.pid, (latest) => ({
          ...latest,
          exitedAt: new Date().toISOString(),
          exitCode: Number.isInteger(code) ? code : null,
          exitSignal: signal || null,
        }));
      });
      child.once('error', (error) => {
        updateIfCurrent(statePath, attempt, child.pid, (latest) => ({
          ...latest, state: 'attention', observedAt: new Date().toISOString(),
          launchError: (error && error.message) || String(error),
        }));
      });
    }
    return { ok: true, operation: publicRecord(running) };
  }

  function startPreparation(input = {}) {
    const issues = Array.isArray(input.issues) ? input.issues.map(String) : [];
    if (!issues.length) return { ok: false, error: 'operation manager: at least one preparation issue is required' };
    return launch({ ...input, kind: 'preparation', id: input.batchId, issues });
  }

  function startImplementation(input = {}) {
    return launch({ ...input, kind: 'implementation', id: input.operationId });
  }

  function restart(input = {}) {
    const found = status(input);
    if (!found.ok) return found;
    return { ok: false, error: `operation manager: ${found.id} is ${found.state}; restart never launches recorded work`, operation: found };
  }

  function retry(input = {}) {
    if (input.approved !== true) return { ok: false, error: 'operation manager: retry requires explicit approval' };
    let statePath, retryPath;
    try { ({ statePath, retryPath } = pathsFor(input.project, input.id)); }
    catch (e) { return { ok: false, error: e.message }; }
    const transition = acquireTransition(retryPath, { kind: 'operation-retry', statePath });
    if (!transition.ok) return transition;
    try {
      const prior = readJson(statePath);
      if (!prior) return { ok: false, error: 'operation manager: no recorded operation to retry' };
      const marker = `${statePath}.settlement`;
      if ((prior.settlement && prior.settlement.state === 'attempting') || fs.existsSync(marker)) {
        return { ok: false, error: 'operation manager: settlement is uncertain; reconcile it before retrying' };
      }
      if (prior.childIdentity === 'pending') {
        return { ok: false, error: 'operation manager: child identity is uncertain; retry is forbidden' };
      }
      // Validate supplied authority before observing or persisting anything: a bad transition
      // must leave the operation evidence byte-for-byte unchanged.
      const grantError = validateGrant(prior.kind, prior.project, prior.batchId, input.grant);
      if (grantError) return { ok: false, error: `operation manager: ${grantError}` };
      const observed = inspect(prior, false);
      if (observed.state !== 'attention') {
        return { ok: false, error: `operation manager: only attention operations may be retried (${observed.state})` };
      }
      releaseFeedSlot(prior);
      const retryPrior = { ...prior, state: 'attention', observedAt: observed.observedAt,
        attention: observed.attention || prior.attention || 'child exited without terminal artifact evidence' };
      return launch({
        kind: prior.kind,
        id: prior.id,
        project: prior.project,
        batchId: prior.batchId,
        configPath: prior.configPath,
        issues: prior.issues,
        authorConcurrency: prior.authorConcurrency,
        grant: input.grant,
      }, retryPrior);
    } finally {
      releaseTransition(retryPath, transition.token);
    }
  }

  function reconcile(input = {}) {
    let statePath, retryPath;
    try { ({ statePath, retryPath } = pathsFor(input.project, input.id)); }
    catch (e) { return { ok: false, error: e.message }; }
    const transition = acquireTransition(retryPath, { kind: 'operation-reconcile', statePath });
    if (!transition.ok) return transition;
    try {
      let current = readJson(statePath);
      if (!current) return { ok: false, error: 'operation manager: no recorded operation to reconcile' };
      const marker = `${statePath}.settlement`;
      if (!(current.settlement && current.settlement.state === 'attempting') && !fs.existsSync(marker)) {
        return { ok: false, error: 'operation manager: no uncertain settlement requires reconciliation' };
      }
      if (typeof supervisor.settlementState !== 'function') {
        return { ok: false, error: 'operation manager: parent cannot prove settlement state; attention remains' };
      }
      let knowledge;
      try { knowledge = supervisor.settlementState(current.parentLease, current.grantNonce); }
      catch (e) {
        return { ok: false, error: `operation manager: settlement remains uncertain: ${(e && e.message) || e}` };
      }
      if (!knowledge || knowledge.ok !== true || typeof knowledge.settled !== 'boolean') {
        return { ok: false, error: `operation manager: settlement remains uncertain${knowledge && knowledge.error ? `: ${knowledge.error}` : ''}` };
      }
      if (knowledge.settled) {
        current = { ...current, state: 'completed', attention: null,
          settlement: { ...current.settlement, state: 'complete', reconciledAt: new Date().toISOString() } };
        persist(current);
        removeFile(marker);
      } else {
        // The parent has proved that the first call did not settle. Only now may the old
        // exclusive marker be removed and the exact same grant settlement be attempted again.
        current = { ...current, state: 'completed', attention: null,
          settlement: { ...current.settlement, state: 'pending', reconciledAt: new Date().toISOString() } };
        persist(current);
        removeFile(marker);
        current = settleCompleted(current);
      }
      const operation = inspect(current);
      return operation.state === 'completed'
        ? { ok: true, operation }
        : { ok: false, error: 'operation manager: settlement remains uncertain', operation };
    } finally {
      releaseTransition(retryPath, transition.token);
    }
  }

  function stop(input = {}) {
    const found = status(input);
    if (!found.ok) return found;
    if (found.kind !== 'implementation') return { ok: false, error: 'operation manager: only an implementation feed can be stopped' };
    if (found.state !== 'running') return { ok: false, error: `operation manager: implementation is ${found.state}` };
    fs.mkdirSync(found.runDir, { recursive: true });
    const stopFile = path.join(found.runDir, 'stop');
    try { fs.closeSync(fs.openSync(stopFile, 'a', 0o600)); }
    catch (e) { return { ok: false, error: `operation manager: could not request stop: ${e.message}` }; }
    return { ok: true, id: found.id, runId: found.runId, stopFile };
  }

  return { startPreparation, startImplementation, status, restart, retry, reconcile, stop };
}

module.exports = { createHostOperationManager };
