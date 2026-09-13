#!/usr/bin/env node
// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0
'use strict';

// Resumable planning-side preparation for a named issue set. Beads is read serially here; the
// bounded workers receive complete immutable briefs and cannot address Beads themselves. This
// command stops at proven-at-base. Publication remains a separate human operation.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { loadConfig } = require('../runner/config');
const { runSync } = require('../runner/process');
const lock = require('../runner/lock');
const supervisor = require('../runner/supervisor');
const { bdJson } = require('../runner/bd');
const { readyQueue, resolveBranch } = require('../runner/queue');
const { buildBrief } = require('./spec-brief');
const author = require('./author-tests');
const proof = require('./prove-tests');
const prepState = require('../runner/preparation-state');
const prerequisites = require('../runner/prerequisites');
const writeProtection = require('./write-protection-policy');
const designRef = require('../runner/design-ref');

const ROOT = path.resolve(__dirname, '..');
const WORKER = path.join(__dirname, 'prepare-batch-worker.js');
const MAX_WORKER_OUTPUT = 1024 * 1024;
const STAGE_PREFIX = 'PREPARATION_STAGE ';
const DEFAULT_CONCURRENCY = 10;
const MAX_CONCURRENCY = 10;
const SECRET_MARKER = '<redacted-host-env>';
const EXIT_USAGE = 2;
const EXIT_REFUSED = 3;
const EXIT_ATTENTION = 4;
const PREREQUISITE_SEAMS = [
  'checkPrerequisites', 'dockerAvailable', 'imageExists', 'resolveHostShell', 'loadToken',
  'loadProviderCredential', 'codexAuthStatus',
];

const USAGE = [
  'usage:',
  `  node scripts/prepare-batch.js start <batch> --config <path> --issue <id> [--issue <id> ...] [--author-concurrency 1..${MAX_CONCURRENCY}]`,
  '  node scripts/prepare-batch.js resume <batch>',
  '  node scripts/prepare-batch.js status <batch> [--json]',
  '  node scripts/prepare-batch.js retry <batch> <id> [<id> ...]',
  '  node scripts/prepare-batch.js acknowledge-interrupted <batch> <id> [<id> ...]',
].join('\n');

function parseArgs(argv) {
  const answer = { mode: argv[0] || null, batch: argv[1] || null, issues: [], concurrency: DEFAULT_CONCURRENCY };
  const modes = new Set(['start', 'resume', 'status', 'retry', 'acknowledge-interrupted']);
  if (!modes.has(answer.mode)) return { error: `unknown mode ${JSON.stringify(answer.mode)}` };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--config' || arg === '--issue' || arg === '--author-concurrency') {
      const value = argv[++i];
      if (value === undefined || value.startsWith('--')) return { error: `${arg} needs a value` };
      if (arg === '--config') answer.config = value;
      else if (arg === '--issue') answer.issues.push(value);
      else answer.concurrency = Number(value);
    } else if (arg === '--json') answer.json = true;
    else if (arg.startsWith('--')) return { error: `unknown option ${JSON.stringify(arg)}` };
    else if (answer.mode === 'retry' || answer.mode === 'acknowledge-interrupted') answer.issues.push(arg);
    else return { error: `unexpected argument ${JSON.stringify(arg)}` };
  }
  try { prepState.validateBatchId(answer.batch); }
  catch { return { error: 'a safe batch id is required' }; }
  if (!Number.isInteger(answer.concurrency) || answer.concurrency < 1 || answer.concurrency > MAX_CONCURRENCY) {
    return { error: `--author-concurrency must be a whole number from 1 to ${MAX_CONCURRENCY}` };
  }
  if (answer.mode === 'start' && (!answer.config || !answer.issues.length)) {
    return { error: 'start requires --config and at least one --issue' };
  }
  if (answer.mode !== 'start' && answer.config) return { error: `--config is not accepted by ${answer.mode}` };
  if (answer.mode !== 'start' && argv.includes('--issue')) return { error: `--issue is accepted only by start` };
  if ((answer.mode === 'retry' || answer.mode === 'acknowledge-interrupted') && !answer.issues.length) {
    return { error: `${answer.mode} needs at least one issue id` };
  }
  if (answer.mode !== 'start' && argv.includes('--author-concurrency')) {
    return { error: `--author-concurrency is fixed by the manifest for ${answer.mode}` };
  }
  if (answer.mode !== 'status' && answer.json) return { error: '--json is accepted only by status' };
  const seen = new Set();
  for (const id of answer.issues) {
    try { prepState.validateIssueId(id); }
    catch { return { error: `unsafe issue id ${JSON.stringify(id)}` }; }
    const key = process.platform === 'win32' ? id.toLowerCase() : id;
    if (seen.has(key)) return { error: `duplicate issue id ${JSON.stringify(id)}` };
    seen.add(key);
  }
  return answer;
}

function dependenciesOf(issue) {
  const values = [];
  const visit = (value) => {
    if (typeof value === 'string' && proof.validIssueId(value)) values.push(value);
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') {
      if (typeof value.id === 'string') visit(value.id);
      else if (typeof value.depends_on_id === 'string') visit(value.depends_on_id);
    }
  };
  visit(issue && issue.dependencies);
  visit(issue && issue.depends_on);
  return [...new Set(values)];
}

function issueSummary(id, issue) {
  const answer = {
    id,
    title: issue && typeof issue.title === 'string' ? issue.title : '',
    dependencies: dependenciesOf(issue),
  };
  if (issue && Number.isInteger(issue.priority) && issue.priority >= 0) answer.priority = issue.priority;
  return answer;
}

function sameConfigIdentity(expected, actual) {
  try {
    return expected && actual
      && lock.canonicalTarget(expected.targetRepoPath) === lock.canonicalTarget(actual.targetRepoPath)
      && prepState.canonicalHash(prepState.redactConfig(expected))
        === prepState.canonicalHash(prepState.redactConfig(actual));
  } catch { return false; }
}

function classifyBuilt(id, built) {
  if (!built || !built.ok) {
    const collision = built && built.kind === 'collision';
    return { id, outcome: collision ? 'collision' : 'attention', error: built && built.error };
  }
  if (built.state === 'ready') return { id, outcome: 'already-frozen', built };
  if (built.design && built.design.ok === false) {
    return { id, outcome: 'needs-design', built };
  }
  const criteria = built.criteria || null;
  const missing = criteria ? criteria.source === 'none'
    : /ISSUE CARRIES NO ACCEPTANCE CRITERIA/i.test(String(built.text || ''));
  if (missing) return { id, outcome: 'needs-criteria', built };
  if (!built.folder) return { id, outcome: 'collision', built, error: 'issue has no unambiguous worktree' };
  if (built.state === 'write') return { id, outcome: 'author-proof', action: 'author-proof', built };
  if (built.state === 'freeze' || built.state === 're-gate') {
    return { id, outcome: 'proof', action: 'proof', built };
  }
  return { id, outcome: 'attention', built, error: `unsupported brief state ${built.state}` };
}

function readIssue(cfg, id, built, seams = {}) {
  if (built && built.issue && typeof built.issue === 'object') return { ok: true, issue: built.issue };
  return (seams.bdJson || bdJson)(cfg, ['show', id]);
}

// All calls here are synchronous on purpose: there is exactly one embedded-Dolt reader during
// snapshotting. No worker exists until every issue and dependency set has been captured.
function snapshotBatch(cfg, ids, configPath, seams = {}) {
  const builder = seams.buildBrief || buildBrief;
  const snapshots = [];
  for (const id of ids) {
    const built = builder({ id, config: configPath });
    if (built && built.ok && !sameConfigIdentity(cfg, built.cfg)) {
      snapshots.push({ id, outcome: 'attention', error: 'spec brief config identity differs from the locked batch config',
        summary: issueSummary(id, null) });
      continue;
    }
    const classified = classifyBuilt(id, built);
    const shown = built && built.ok ? readIssue(cfg, id, built, seams) : { ok: false, error: built && built.error };
    if (shown.ok) {
      const raw = Array.isArray(shown.data) ? shown.data[0] : shown.data;
      classified.issue = built.issue || raw;
      classified.summary = issueSummary(id, classified.issue);
    } else classified.summary = issueSummary(id, null);
    snapshots.push(classified);
  }
  const byFolder = new Map();
  const byCanonical = new Map();
  for (const item of snapshots.filter((s) => s.built && s.built.canonicalId)) {
    const key = process.platform === 'win32'
      ? item.built.canonicalId.toLowerCase() : item.built.canonicalId;
    const prior = byCanonical.get(key);
    if (prior && prior.id !== item.id) {
      for (const collided of [prior, item]) {
        collided.outcome = 'collision'; delete collided.action;
        collided.error = `batch inputs ${prior.id} and ${item.id} resolve to canonical issue ${item.built.canonicalId}`;
      }
    } else byCanonical.set(key, item);
  }
  for (const item of snapshots.filter((s) => s.built && s.built.folder)) {
    const key = path.resolve(item.built.folder.dir).toLowerCase();
    const prior = byFolder.get(key);
    if (prior && prior.id !== item.id) {
      for (const collided of [prior, item]) {
        collided.outcome = 'collision'; delete collided.action;
        collided.error = `issues ${prior.id} and ${item.id} resolve to the same worktree`;
      }
    } else byFolder.set(key, item);
  }
  return snapshots;
}

function prepareWorktrees(snapshots, configPath, seams = {}, expectedHead = null, expectedCfg = null) {
  const ensure = seams.ensureWorktree || author.ensureWorktree;
  const builder = seams.buildBrief || buildBrief;
  for (const item of snapshots) {
    if (!item.action) continue;
    if (!item.built.folder.exists) {
      const made = ensure(item.built, seams.runSync);
      if (!made.ok) {
        item.outcome = 'collision'; delete item.action; item.error = made.error; continue;
      }
      const refreshed = builder({ id: item.id, config: configPath });
      const next = classifyBuilt(item.id, refreshed);
      if (!refreshed.ok || next.action !== item.action || !refreshed.folder.exists
          || refreshed.canonicalId !== item.built.canonicalId
          || refreshed.suiteId !== item.built.suiteId
          || (expectedCfg && !sameConfigIdentity(expectedCfg, refreshed.cfg))) {
        item.outcome = 'collision'; delete item.action;
        item.error = refreshed.error || (expectedCfg && !sameConfigIdentity(expectedCfg, refreshed.cfg)
          ? 'refreshed spec brief config identity differs from the locked batch config'
          : 'created worktree did not resolve back to this issue');
        continue;
      }
      item.built = refreshed;
      item.outcome = next.outcome;
    }
    if (expectedHead) {
      const head = integrationHead({ ...item.built.cfg, targetRepoPath: item.built.folder.dir }, seams);
      if (head !== expectedHead) {
        item.outcome = 'attention'; delete item.action;
        item.error = `issue worktree is at ${head || 'an unreadable HEAD'}, not integration base ${expectedHead}`;
      }
    }
  }
  return snapshots;
}

function parseWorkerResult(stdout) {
  return parseWorkerEnvelope(stdout).result;
}

function parseWorkerEnvelope(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return { verified: false,
    result: { ok: false, outcome: 'interrupted', error: 'worker returned no result' } };
  try {
    const value = JSON.parse(text);
    const verified = value && typeof value === 'object' && !Array.isArray(value)
      && typeof value.ok === 'boolean' && typeof value.outcome === 'string'
      && (value.outcome !== 'usage-limit' || canonicalUsageLimit(value));
    return verified
      ? { verified: true, result: value }
      : { verified: false, result: { ok: false, outcome: 'invalid', error: 'worker result is not a protocol object' } };
  } catch (e) {
    return { verified: false,
      result: { ok: false, outcome: 'invalid', error: `worker returned invalid JSON: ${e.message}` } };
  }
}

// This is deliberately a closed protocol. Only a launcher-normalized result with an
// absolute reset instant and verbatim structured evidence can park preparation; prose and
// partially-shaped objects retain their ordinary failure handling.
function canonicalUsageLimit(result) {
  const limit = result && result.ok === false && result.outcome === 'usage-limit'
    && result.rateLimit;
  return !!(limit && typeof limit === 'object' && !Array.isArray(limit)
    && typeof limit.resetAt === 'string' && Number.isFinite(Date.parse(limit.resetAt))
    && new Date(limit.resetAt).toISOString() === limit.resetAt
    && typeof limit.evidence === 'string' && limit.evidence.length > 0);
}

function retainedPaths(value) {
  const found = [];
  const add = (candidate) => {
    if (typeof candidate === 'string' && candidate.length && !found.includes(candidate)) found.push(candidate);
  };
  if (value && typeof value === 'object') {
    add(value.retained); add(value.probe);
    if (value.proof && typeof value.proof === 'object') add(value.proof.probe);
    if (value.built && value.built.folder) add(value.built.folder.dir);
  }
  return found;
}

function activeUsagePause(events) {
  let pause = null;
  for (const event of events || []) {
    if (event && event.type === 'batch.usage-limit-paused' && event.payload) pause = event.payload;
    if (event && event.type === 'batch.usage-limit-resumed') pause = null;
  }
  return pause;
}

function hasUsageLimitHistory(events) {
  return (events || []).some((event) => event &&
    (event.type === 'batch.usage-limit-paused' || event.type === 'batch.usage-limit-resumed'));
}

// Small deterministic controller used by the host coordinator contract tests. It has no
// filesystem or process authority: the caller supplies the clock, append-only ledger and
// canonical launcher. Production uses the same predicates and event shapes below.
function createUsageLimitPreparation(deps = {}) {
  const now = typeof deps.now === 'function' ? deps.now : () => new Date().toISOString();
  const append = typeof deps.appendEvent === 'function' ? deps.appendEvent : () => {};
  const read = typeof deps.readEvents === 'function' ? deps.readEvents : () => [];
  const launch = deps.launch;
  const batches = new Map();
  const resumeCommand = (batch) => `node scripts/prepare-batch.js resume ${batch}`;

  function view(state) {
    const pause = state.pause;
    return {
      paused: !!pause,
      resetAt: pause && pause.resetAt,
      stage: pause && pause.stage,
      activeWorkers: pause ? pause.activeWorkers.slice() : [],
      preservedPaths: [...state.preserved],
      resumeCommand: resumeCommand(state.batch),
      issues: state.issues,
    };
  }
  function start({ batch, issues, concurrency }) {
    const state = { batch, roster: issues.slice(), issues: {}, preserved: new Set(), pause: null,
      resumed: false, interrupted: false };
    batches.set(batch, state);
    for (const id of issues) state.issues[id] = { outcome: 'pending' };
    const active = issues.slice(0, Math.max(1, concurrency || 1));
    const settled = [];
    for (const id of active) settled.push({ id, result: launch(id, 'author-proof') });
    const limited = settled.find(({ result }) => canonicalUsageLimit(result));
    for (const { id, result } of settled) {
      if (canonicalUsageLimit(result)) state.issues[id] = { outcome: 'paused' };
      else {
        state.issues[id] = { ...result };
        for (const retained of retainedPaths(result)) state.preserved.add(retained);
      }
    }
    if (limited) {
      state.pause = {
        state: 'paused', resetAt: limited.result.rateLimit.resetAt, stage: 'author-proof',
        activeWorkers: active.slice(), issueId: limited.id, preservedPaths: [...state.preserved],
        resumeCommand: resumeCommand(batch),
      };
      append('batch.usage-limit-paused', state.pause);
    }
    return view(state);
  }
  function status(batch) {
    const state = batches.get(batch);
    if (!state) return { found: false };
    activeUsagePause(read());
    return view(state);
  }
  function resume(batch) {
    const state = batches.get(batch);
    if (!state || !state.pause) return { idempotent: true, ...(state ? view(state) : {}) };
    if (Date.parse(now()) < Date.parse(state.pause.resetAt)) return { refused: true, ...view(state) };
    if (state.resumed) return { idempotent: true, ...view(state) };
    state.resumed = true;
    const id = state.pause.issueId;
    const result = launch(id, state.pause.stage);
    for (const retained of retainedPaths(result)) state.preserved.add(retained);
    state.issues[id] = canonicalUsageLimit(result) ? { outcome: 'paused' } : { ...result };
    append('batch.usage-limit-resumed', { state: 'running', resetAt: state.pause.resetAt,
      issueId: id, resumeCommand: resumeCommand(batch) });
    return { resumed: true, ...view(state) };
  }
  function settleWorker(issueId, result) {
    const state = [...batches.values()].find((candidate) => candidate.roster.includes(issueId));
    if (!state || state.issues[issueId].settled) return { recorded: false };
    state.issues[issueId] = { ...result, settled: true };
    for (const retained of retainedPaths(result)) state.preserved.add(retained);
    append('issue.worker-result', { issueId, state: result.outcome, retained: result.retained || result.probe || null });
    return { recorded: true };
  }
  function interrupt(batch) {
    const state = batches.get(batch); if (!state) return { liveWorkers: [] };
    state.interrupted = true;
    return { liveWorkers: state.pause ? [state.pause.issueId] : [] };
  }
  return { start, status, resume, settleWorker, interrupt };
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }
}

function workerEnv(source = process.env) {
  const env = { ...source };
  if (env.PIPELINE_TESTING_PREPARE_BATCH_SEAMS !== '1') {
    for (const key of [
      'PIPELINE_TEST_AUTHOR_CMD', 'PIPELINE_TEST_PROBE_CMD',
      'PIPELINE_TESTING_FREEZE_GATE_SEAM', 'FREEZE_GATE_CMD', 'FREEZE_GATE_DOCKER_CMD',
      'PIPELINE_BD_CMD', 'PIPELINE_IMAGE_BD_CMD',
    ]) delete env[key];
  }
  return env;
}

function hostEnvSecrets(cfg) {
  const env = cfg && cfg.hostEnv && typeof cfg.hostEnv === 'object' && !Array.isArray(cfg.hostEnv)
    ? cfg.hostEnv : {};
  return [...new Set(Object.values(env).filter((value) => typeof value === 'string' && value.length > 0))]
    .sort((a, b) => b.length - a.length);
}

function scrubSecrets(value, cfgOrSecrets) {
  const secrets = Array.isArray(cfgOrSecrets) ? cfgOrSecrets : hostEnvSecrets(cfgOrSecrets);
  const text = (input) => {
    let answer = input;
    for (const secret of secrets) answer = answer.split(secret).join(SECRET_MARKER);
    return answer;
  };
  if (typeof value === 'string') return text(value);
  if (Array.isArray(value)) return value.map((item) => scrubSecrets(item, secrets));
  if (!value || typeof value !== 'object') return value;
  const answer = Object.create(null);
  for (const [key, item] of Object.entries(value)) {
    Object.defineProperty(answer, text(key), {
      value: scrubSecrets(item, secrets), enumerable: true, configurable: true, writable: true,
    });
  }
  return answer;
}

function runWorker(root, batch, item, configPath, state = prepState, seams = {}) {
  return new Promise((resolve) => {
    const nonce = (seams.createWorkerNonce || state.createWorkerNonce)();
    const child = (seams.spawn || spawn)(process.execPath, [WORKER], {
      cwd: ROOT, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
      env: workerEnv(process.env),
    });
    const started = { nonce, pid: child.pid, phase: item.action, data: { action: item.action } };
    try { state.writeWorkerStarted(root, batch, item.id, started); }
    catch (e) {
      try { child.kill('SIGKILL'); } catch { /* the not-yet-fed worker owns no descendant */ }
      resolve({ id: item.id, ok: false, outcome: 'interrupted', error: `cannot record worker ownership: ${e.message}` });
      return;
    }
    try {
      (seams.markPreparationUncertain || lock.markPreparationUncertain)(seams.ownership, {
        nonce, pid: child.pid, batch, issueId: item.id, phase: item.action,
      });
    } catch (e) {
      try { child.kill('SIGKILL'); } catch { /* immutable job was never fed */ }
      resolve({ id: item.id, ok: false, outcome: 'interrupted',
        error: `cannot record target-global worker uncertainty: ${e.message}` });
      return;
    }
    const chunks = []; let bytes = 0; let overflow = false; let stderr = ''; let stageBuffer = '';
    const reportStage = (line) => {
      if (!line.startsWith(STAGE_PREFIX)) return;
      try {
        const event = JSON.parse(line.slice(STAGE_PREFIX.length));
        if (proof.validStageEvent(event) && typeof seams.onWorkerProgress === 'function') {
          seams.onWorkerProgress(item.id, event);
        }
      } catch { /* ordinary worker stderr is not a progress event */ }
    };
    child.stdout.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes <= MAX_WORKER_OUTPUT) chunks.push(chunk);
      else if (!overflow) { overflow = true; try { child.kill('SIGKILL'); } catch { /* owned child */ } }
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      if (stderr.length < 65536) stderr += text.slice(0, 65536 - stderr.length);
      stageBuffer += text;
      for (;;) {
        const newline = stageBuffer.indexOf('\n');
        if (newline < 0) break;
        reportStage(stageBuffer.slice(0, newline).replace(/\r$/, ''));
        stageBuffer = stageBuffer.slice(newline + 1);
      }
      if (stageBuffer.length > 65536) stageBuffer = '';
    });
    child.on('error', (e) => {
      const result = scrubSecrets(
        { id: item.id, ok: false, outcome: 'interrupted', error: e.message, nonce }, item.built.cfg);
      try { state.writeWorkerResult(root, batch, item.id,
        { nonce, outcome: result.outcome, exitCode: 1, data: result });
        state.appendEvent(root, batch, 'issue.worker-result',
          scrubSecrets({ issueId: item.id, state: result.outcome, nonce }, item.built.cfg));
      } catch { /* manifest still shows started */ }
      resolve(result);
    });
    child.on('close', (code) => {
      if (stageBuffer) reportStage(stageBuffer.replace(/\r$/, ''));
      const envelope = overflow ? { verified: false,
        result: { ok: false, outcome: 'interrupted', error: `worker output exceeded ${MAX_WORKER_OUTPUT} bytes` } }
        : parseWorkerEnvelope(Buffer.concat(chunks).toString('utf8'));
      let result = envelope.result;
      result = scrubSecrets({ id: item.id, ...result, nonce, exitCode: code }, item.built.cfg);
      if (stderr) result.stderr = stderr;
      result = scrubSecrets(result, item.built.cfg);
      let recorded = false;
      try { state.writeWorkerResult(root, batch, item.id,
        { nonce, outcome: result.outcome, exitCode: Number.isInteger(code) ? code : 1, data: result });
        state.appendEvent(root, batch, 'issue.worker-result',
          scrubSecrets({ issueId: item.id, state: result.outcome, nonce }, item.built.cfg));
        recorded = true;
      }
      catch (e) { result = { ...result, ok: false, outcome: 'interrupted', error: `result was not durably recorded: ${e.message}` }; }
      if (recorded && envelope.verified && Number.isInteger(code)) {
        try { (seams.clearPreparationUncertain || lock.clearPreparationUncertain)(seams.ownership, nonce); }
        catch (e) { result = { ...result, ok: false, outcome: 'interrupted',
          error: `result was recorded but target-global worker uncertainty remains: ${e.message}` }; }
      }
      resolve(result);
    });
    child.stdin.end(JSON.stringify({ action: item.action, built: item.built, configPath,
      ...(item.retainedProbe ? { retainedProbe: item.retainedProbe } : {}) }));
  });
}

async function runPool(items, concurrency, worker) {
  const results = new Array(items.length); let next = 0;
  async function lane() {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await worker(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, lane));
  return results;
}

async function runPoolUntilUsageLimit(items, concurrency, worker, onLimit) {
  const results = new Array(items.length); let next = 0; let parked = false;
  const active = new Set();
  async function lane() {
    for (;;) {
      if (parked) return;
      const index = next++;
      if (index >= items.length) return;
      const item = items[index];
      active.add(item.id);
      const result = await worker(item);
      results[index] = result;
      if (!parked && canonicalUsageLimit(result)) {
        parked = true;
        onLimit(result, item, [...active]);
      }
      active.delete(item.id);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, lane));
  return { results: results.filter((value) => value !== undefined), parked };
}

function manifestValue(record) { return record && record.value && typeof record.value === 'object' ? record.value : record; }
function manifestInput(record) {
  const value = manifestValue(record) || {};
  if (value.input || value.manifest) return value.input || value.manifest;
  return {
    configPath: value.runConfig,
    authorConcurrency: value.concurrency,
    issues: value.issues,
  };
}

function usageLimitStatus(derived, batch) {
  const pause = activeUsagePause(derived && derived.events);
  if (!pause) return null;
  const preserved = new Set(Array.isArray(pause.preservedPaths) ? pause.preservedPaths : []);
  for (const event of derived.events || []) {
    if (event.type === 'issue.snapshotted' && event.payload) {
      for (const candidate of retainedPaths({ retained: event.payload.folder })) preserved.add(candidate);
    }
  }
  for (const issue of derived.issues || []) {
    for (const row of issue.workers || []) {
      for (const candidate of retainedPaths(row.result && row.result.data)) preserved.add(candidate);
    }
  }
  return {
    paused: true, resetAt: pause.resetAt, stage: pause.stage,
    activeWorkers: Array.isArray(pause.activeWorkers) ? pause.activeWorkers : [],
    preservedPaths: [...preserved],
    resumeCommand: pause.resumeCommand || `node scripts/prepare-batch.js resume ${batch}`,
  };
}

function statusReport(root, batch, json, state = prepState, io = {}) {
  const out = io.out || console.log; const err = io.err || console.error;
  try {
    const derived = state.deriveState(root, batch);
    if (!derived.ok) {
      if (json) out(JSON.stringify(derived, null, 2));
      throw new Error(derived.error || 'preparation state is invalid');
    }
    const pause = usageLimitStatus(derived, batch);
    if (pause) Object.assign(derived, pause);
    if (json) out(JSON.stringify(derived, null, 2));
    else {
      out(`== preparation batch ${batch} ==`);
      if (pause) {
        out(`  paused stage: ${pause.stage}`);
        out(`  reset at: ${pause.resetAt}`);
        out(`  affected active workers: ${pause.activeWorkers.length ? pause.activeWorkers.join(', ') : '(none recorded)'}`);
        out(`  preserved paths: ${pause.preservedPaths.length ? pause.preservedPaths.join(', ') : '(none recorded)'}`);
        out(`  resume command: ${pause.resumeCommand}`);
      }
      const items = derived.issues || derived.items || [];
      if (Array.isArray(items)) {
        for (const value of items) out(`  ${value.id}: ${value.outcome || value.state || 'pending'}`);
        if (!items.length) out('  no issue state recorded');
      } else {
        for (const [id, value] of Object.entries(items)) out(`  ${id}: ${value.outcome || value.state || 'pending'}`);
        if (!Object.keys(items).length) out('  no issue state recorded');
      }
    }
    return 0;
  } catch (e) { err(`prepare-batch: ${e.message}`); return EXIT_REFUSED; }
}

function latestAttempt(records) {
  if (!records) return { started: null, result: null };
  if (!Array.isArray(records)) return { started: records.started || null, result: records.result || null };
  let started = null; let result = null;
  for (const rec of records) {
    if (rec && rec.started) { started = rec.started; result = rec.result || null; continue; }
    const value = manifestValue(rec) || {};
    const kind = rec.type || rec.kind || value.type || value.kind;
    if (/started/i.test(kind || '')) { started = value; result = null; }
    if (/result/i.test(kind || '')) result = value;
  }
  return { started, result };
}

function attemptPhase(started) {
  return started && (started.phase || (started.data && started.data.action)) || null;
}

function unresolvedWorkers(root, state = prepState, targetRepoPath = null) {
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); }
  catch (e) { if (e && e.code === 'ENOENT') return { ok: true, workers: [] }; return { ok: false, error: e.message }; }
  const workers = [];
  let target = null;
  try { if (targetRepoPath) target = lock.canonicalTarget(targetRepoPath); }
  catch (e) { return { ok: false, error: `cannot identify preparation target: ${e.message}` }; }
  try {
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const manifest = state.readManifest(root, entry.name);
      const value = manifestValue(manifest);
      const recordedPath = value.config && value.config.targetRepoPath;
      if (target && recordedPath && lock.canonicalTarget(recordedPath) !== target) continue;
      for (const issue of value.issues || []) {
        const id = typeof issue === 'string' ? issue : issue.id;
        const latest = latestAttempt(state.readWorkerRecords(root, entry.name, id));
        if (latest.started && !latest.result) {
          workers.push({ batch: entry.name, issueId: id, pid: latest.started.pid || null,
            phase: attemptPhase(latest.started), nonce: latest.started.nonce || null });
        }
      }
    }
  } catch (e) { return { ok: false, error: `cannot audit interrupted preparation workers: ${e.message}` }; }
  return { ok: true, workers };
}

function acknowledgeInterrupted(root, batch, ids, state = prepState, cfg = {}, io = {}, seams = {}) {
  const out = io.out || console.log; const err = io.err || console.error;
  let attention = false;
  let markers;
  try { markers = (seams.listPreparationUncertain || lock.listPreparationUncertain)(cfg.targetRepoPath); }
  catch (e) { err(`prepare-batch: cannot read target-global worker uncertainty: ${e.message}`); return EXIT_ATTENTION; }
  for (const id of ids) {
    const prior = latestAttempt(state.readWorkerRecords(root, batch, id));
    if (!prior.started) {
      err(`prepare-batch: ${id} has no interrupted worker to acknowledge.`);
      attention = true; continue;
    }
    const phase = attemptPhase(prior.started);
    if (!['author-proof', 'proof'].includes(phase)) {
      err(`prepare-batch: ${id} has an unknown interrupted phase; state needs manual inspection.`);
      attention = true; continue;
    }
    if (pidAlive(Number(prior.started.pid))) {
      err(`prepare-batch: ${id} worker pid ${prior.started.pid} is still live; stop it before acknowledging interruption.`);
      attention = true; continue;
    }
    const marker = markers.find((value) => value.nonce === prior.started.nonce);
    const alreadyAcknowledged = prior.result && prior.result.data
      && prior.result.data.acknowledgedInterrupted === true;
    if (prior.result && !marker && !alreadyAcknowledged) {
      err(`prepare-batch: ${id} has a completed worker and no target-global uncertainty to acknowledge.`);
      attention = true; continue;
    }
    if (!prior.result) {
      const payload = scrubSecrets({
        id, ok: false, outcome: 'abandoned', kind: 'human-acknowledged-interruption',
        acknowledgedInterrupted: true, interruptedPhase: phase,
        error: 'operator acknowledged that the interrupted worker and its descendants were stopped',
      }, cfg);
      state.writeWorkerResult(root, batch, id, {
        nonce: prior.started.nonce, outcome: 'abandoned', exitCode: 130, data: payload,
      });
    }
    const hasAckEvent = state.readEvents(root, batch).some((event) => event.type === 'issue.interruption-acknowledged'
      && event.payload && event.payload.issueId === id && event.payload.nonce === prior.started.nonce);
    if (!hasAckEvent) {
      state.appendEvent(root, batch, 'issue.interruption-acknowledged', scrubSecrets({
        issueId: id, state: 'abandoned', nonce: prior.started.nonce,
        acknowledgedInterrupted: true, interruptedPhase: phase,
      }, cfg));
    }
    if (marker) {
      try { (seams.clearPreparationUncertain || lock.clearPreparationUncertain)(seams.ownership, prior.started.nonce); }
      catch (e) {
        err(`prepare-batch: ${id} acknowledgement is durable but its target-global marker remains: ${e.message}`);
        attention = true; continue;
      }
    }
    out(`${id}: interruption acknowledged; a separate retry may now start a new ${phase} attempt.`);
  }
  return attention ? EXIT_ATTENTION : 0;
}

function integrationHead(cfg, seams = {}) {
  const run = seams.runSync || runSync;
  const r = run('git', ['rev-parse', 'HEAD'], {
    cfg, kind: 'git', cwd: cfg.targetRepoPath, label: 'snapshot preparation integration HEAD',
  });
  const head = String(r.stdout || '').trim();
  return r.status === 0 && /^[0-9a-f]{40,64}$/i.test(head) ? head : null;
}

function inspectIntegration(cfg, expectedBranch = null, seams = {}) {
  const run = seams.runSync || runSync;
  const resolved = expectedBranch ? { ok: true, branch: expectedBranch }
    : (seams.resolveBranch || resolveBranch)(cfg);
  if (!resolved.ok) return { ok: false, error: resolved.error };
  const localBranch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cfg, kind: 'git', cwd: cfg.targetRepoPath, label: 'read preparation integration branch',
  });
  const localHead = integrationHead(cfg, seams);
  if (localBranch.status !== 0 || String(localBranch.stdout || '').trim() !== resolved.branch) {
    return { ok: false, error: `target checkout is not on integration branch ${resolved.branch}` };
  }
  const remote = run('git', ['ls-remote', cfg.targetRepoRemote, `refs/heads/${resolved.branch}`], {
    cfg, kind: 'git', cwd: cfg.targetRepoPath, label: 'read remote integration HEAD',
  });
  const remoteHead = String(remote.stdout || '').trim().split(/\s+/)[0];
  if (remote.status !== 0 || !/^[0-9a-f]{40,64}$/i.test(remoteHead)) {
    return { ok: false, error: `cannot resolve remote integration HEAD for ${resolved.branch}` };
  }
  if (localHead !== remoteHead) {
    return { ok: false, error: `local integration HEAD ${localHead || '(unreadable)'} differs from remote ${remoteHead}` };
  }
  return { ok: true, branch: resolved.branch, head: localHead };
}

function snapshotFingerprints(state, root, batch) {
  const found = new Map();
  for (const event of state.readEvents(root, batch)) {
    if (event.type !== 'issue.snapshotted' || !event.payload || !event.payload.issueId) continue;
    if (!found.has(event.payload.issueId)) found.set(event.payload.issueId, event.payload);
  }
  return found;
}

function acknowledgedPhases(state, root, batch) {
  const found = new Map();
  for (const event of state.readEvents(root, batch)) {
    if (event.type !== 'issue.interruption-acknowledged' || !event.payload) continue;
    const key = `${event.payload.issueId || ''}\0${event.payload.nonce || ''}`;
    if (!found.has(key)) found.set(key, event.payload.interruptedPhase || null);
  }
  return found;
}

function strayIssues(cfg, ids, seams = {}) {
  const queued = (seams.readyQueue || readyQueue)(cfg);
  if (!queued.ok) return { ok: false, error: queued.error || 'ready queue could not be read', ids: [] };
  const named = new Set(ids);
  return { ok: true, ids: (queued.issues || []).map((issue) => issue.id).filter((id) => !named.has(id)) };
}

function settleEmptyTakeover(held, seams = {}) {
  if (!held.tookOver) return { ok: true };
  const previous = held.previous || {};
  return { ok: false,
    error: `prior target owner ${previous.runId || '(unknown)'} ended without releasing ownership; normal pipeline recovery is required` };
}

// Existing unit workflows inject narrow seams for the operation they exercise and predate the
// host-prerequisite gate. Preserve those paths without weakening production: an ordinary CLI
// call has no seams and always runs the real gate; a prerequisite-aware test opts in by naming
// either the whole gate or one of its probes.
function shouldCheckPrerequisites(seams) {
  const keys = Object.keys(seams || {});
  return keys.length === 0 || PREREQUISITE_SEAMS.some((key) => Object.prototype.hasOwnProperty.call(seams, key));
}

async function execute(opts, io = {}, seams = {}) {
  const out = io.out || console.log; const err = io.err || console.error;
  const state = seams.state || prepState;
  const root = (seams.preparationRoot || state.preparationRoot)(process.env);
  if (opts.mode === 'status') return statusReport(root, opts.batch, opts.json, state, io);

  let manifest = null; let configPath = opts.config; let concurrency = opts.concurrency;
  let ids = opts.issues; let rosterIds = opts.issues;
  if (opts.mode !== 'start') {
    try { manifest = state.readManifest(root, opts.batch); }
    catch (e) { err(`prepare-batch: ${e.message}`); return EXIT_REFUSED; }
    const input = manifestInput(manifest);
    configPath = input.configPath;
    concurrency = input.authorConcurrency || DEFAULT_CONCURRENCY;
    rosterIds = (input.issues || []).map((v) => typeof v === 'string' ? v : v.id);
    if (opts.mode === 'resume') ids = rosterIds;
    if (opts.mode === 'retry' || opts.mode === 'acknowledge-interrupted') {
      const outside = ids.filter((id) => !rosterIds.includes(id));
      if (outside.length) {
        err(`prepare-batch: retry names issue(s) outside the immutable batch: ${outside.join(', ')}`);
        return EXIT_USAGE;
      }
    }
  }
  let cfg;
  try {
    // Acknowledgement is recovery metadata, not a new run. Use the immutable manifest's target
    // identity so a moved/edited/deleted config cannot make an interrupted record impossible to
    // settle, and do not require the old integration base still to be current.
    cfg = opts.mode === 'acknowledge-interrupted'
      ? manifestValue(manifest).config
      : (seams.loadConfig || loadConfig)(configPath);
  } catch (e) { err(`prepare-batch: ${e.message}`); return EXIT_USAGE; }

  // Child admission (§3.10), first: ahead of the write-protection backstop, ahead of the target
  // lock, ahead of every worker, worktree and Beads read. With no supervisor on this canonical
  // target this answers `standalone` and the whole path below is unchanged. With one live, a
  // preparation that presents no scoped grant is refused by that supervisor's name, and a
  // forged, replayed, expired, wrong-target, wrong-parent or released grant is refused by its
  // reason — in both cases with nothing launched and no ownership record touched.
  const entry = (seams.admitEntry || supervisor.admitEntry)('preparation', {
    targetRepoPath: cfg.targetRepoPath, repoRoot: ROOT, env: process.env,
  });
  if (!entry.ok) {
    err(`prepare-batch: child authority refused (${entry.reason}): ${entry.message} No worker was launched.`);
    return EXIT_REFUSED;
  }
  const childAdmission = entry.mode === 'supervisor-child' ? entry.admission : null;

  if (opts.mode !== 'acknowledge-interrupted' && shouldCheckPrerequisites(seams)) {
    const check = seams.checkPrerequisites || prerequisites.checkPrerequisites;
    const prerequisite = check(cfg, ROOT, seams);
    if (!prerequisite.ok) {
      err("prepare-batch: prerequisite '" + prerequisite.prerequisite + "' unavailable for batch '"
        + opts.batch + "': " + prerequisite.reason);
      err('prepare-batch: remedy: ' + prerequisite.remedy);
      err("prepare-batch: no author, probe, or worker operation was launched; fix the prerequisite and retry the same batch '"
        + opts.batch + "'.");
      return EXIT_REFUSED;
    }
  }

  if (opts.mode !== 'acknowledge-interrupted' && cfg.allowHalfProven === true) {
    err('prepare-batch: all-proven preparation refuses a config with allowHalfProven=true; change that policy explicitly first.');
    return EXIT_REFUSED;
  }
  if (manifest && opts.mode !== 'acknowledge-interrupted') {
    const value = manifestValue(manifest);
    const currentHash = state.canonicalHash(state.redactConfig(cfg));
    if (value.configHash !== currentHash) {
      err('prepare-batch: run config changed after this immutable batch manifest; start a new batch.');
      return EXIT_REFUSED;
    }
    const integration = (seams.inspectIntegration || inspectIntegration)(cfg, value.integrationBranch, seams);
    if (!integration.ok || (value.integrationHead && value.integrationHead !== integration.head)) {
      err(`prepare-batch: integration base moved or is unsynchronized after this batch snapshot${integration.error ? ` — ${integration.error}` : ''}; start a new batch.`);
      return EXIT_ATTENTION;
    }
  }

  // The write-protection backstop (change-log row `repo-324`), before the lock and before any
  // worker is launched: preparation promotes suites into this checkout, and a checkout already
  // carrying hand-made protected edits is one where promotion would mix them into evidence
  // nobody agreed to. Reported, never cleaned up.
  if (opts.mode !== 'acknowledge-interrupted') {
    const admitted = writeProtection.admit(cfg.targetRepoPath, { issues: ids });
    if (!admitted.admit) {
      err('prepare-batch: refusing to prepare — the integration checkout is not admissible.');
      for (const line of writeProtection.admissionRefusal(admitted, { label: admitted.target, issues: ids })) {
        err(`               ${line}`);
      }
      return EXIT_REFUSED;
    }
  }

  const acquireOptions = opts.mode === 'acknowledge-interrupted' ? { allowPreparationRecovery: true } : undefined;
  // An admitted child runs under its parent's lease: the target is already excluded from every
  // other coordinator, so taking a second lock would only refuse its own parent. It gets a
  // delegated handle instead, good for the target-keyed preparation-uncertainty records and
  // for nothing else.
  const held = childAdmission
    ? { ok: true, tookOver: false, ownership: supervisor.childOwnership(childAdmission) }
    : (seams.acquire || lock.acquire)(ROOT, cfg.targetRepoPath, `prepare-${opts.batch}`, acquireOptions);
  if (!held.ok) {
    err(`prepare-batch: target is owned by ${held.holder.runId} (pid ${held.holder.pid || 'unknown'}); no worker was launched.`);
    return EXIT_REFUSED;
  }
  try {
    const takeover = settleEmptyTakeover(held, seams);
    if (!takeover.ok && opts.mode !== 'acknowledge-interrupted') {
      err(`prepare-batch: ${takeover.error}; run normal pipeline recovery before preparing tests.`);
      return EXIT_ATTENTION;
    }
    if (opts.mode === 'acknowledge-interrupted') {
      return acknowledgeInterrupted(root, opts.batch, ids, state, cfg, io,
        { ...seams, ownership: held.ownership });
    }
    const resumeEvents = opts.mode === 'resume' ? state.readEvents(root, opts.batch) : [];
    const priorPause = activeUsagePause(resumeEvents);
    if (opts.mode === 'resume' && !priorPause && hasUsageLimitHistory(resumeEvents)) {
      out(`preparation batch ${opts.batch} has no active usage-limit pause; nothing was launched.`);
      return 0;
    }
    const clockValue = typeof seams.now === 'function' ? seams.now() : new Date().toISOString();
    if (priorPause && Date.parse(clockValue) < Date.parse(priorPause.resetAt)) {
      err(`prepare-batch: batch ${opts.batch} is paused in ${priorPause.stage} until ${priorPause.resetAt}; no worker was launched.`);
      err(`prepare-batch: resume with: ${priorPause.resumeCommand}`);
      return EXIT_REFUSED;
    }
    const interrupted = unresolvedWorkers(root, state, cfg.targetRepoPath);
    if (!interrupted.ok) {
      err(`prepare-batch: ${interrupted.error}`);
      return EXIT_ATTENTION;
    }
    if (interrupted.workers.length) {
      for (const worker of interrupted.workers) {
        err(`prepare-batch: interrupted ${worker.phase || 'unknown'} worker remains for ${worker.issueId}`
          + ` in batch ${worker.batch}${worker.pid ? ` (recorded pid ${worker.pid})` : ''}.`);
      }
      err('No worker was launched. Stop any surviving descendants, then use acknowledge-interrupted before retrying or starting another batch.');
      return EXIT_ATTENTION;
    }
    let snapshots = snapshotBatch(cfg, ids, configPath, seams);
    const expectedBranch = snapshots.find((s) => s.built && s.built.branch)?.built.branch || null;
    const integration = (seams.inspectIntegration || inspectIntegration)(cfg, expectedBranch, seams);
    if (!integration.ok) { err(`prepare-batch: ${integration.error}`); return EXIT_ATTENTION; }
    const baseHead = integration.head;
    const resolveDesign = seams.resolveDesign || designRef.resolveIssue;
    for (const item of snapshots) {
      // A suite that already crossed the publication boundary keeps its established result.
      // New preparation work is judged against the pinned integration commit before a
      // worktree or worker exists.
      if (!item.built || item.outcome === 'already-frozen') continue;
      const resolution = resolveDesign(item.issue || item.built.issue, {
        repoPath: cfg.targetRepoPath, commit: baseHead,
      });
      item.built.design = resolution;
      item.designCommit = resolution && resolution.commit || baseHead;
      item.designReasons = resolution && Array.isArray(resolution.reasons) ? resolution.reasons : [];
      if (resolution && resolution.ok === true) {
        const next = classifyBuilt(item.id, item.built);
        item.outcome = next.outcome;
        if (next.action) item.action = next.action; else delete item.action;
        if (next.error) item.error = next.error; else delete item.error;
      } else {
        item.outcome = 'needs-design';
        delete item.action;
        item.error = designRef.refusalLines(resolution || {
          ok: false, reasons: ['unparsable'], remedies: [], refs: [],
        }, { issueId: item.id }).join(' ');
      }
    }
    const priorFingerprints = opts.mode === 'start' ? new Map() : snapshotFingerprints(state, root, opts.batch);
    for (const item of snapshots) {
      const prior = priorFingerprints.get(item.id);
      const criteriaHash = item.built && item.built.criteria && item.built.criteria.sha256;
      const issueUpdatedAt = item.built && item.built.issueUpdatedAt;
      if (prior && (prior.criteriaHash !== criteriaHash || prior.issueUpdatedAt !== issueUpdatedAt)) {
        item.outcome = 'attention'; delete item.action;
        item.error = 'issue criteria changed after the immutable batch snapshot';
      }
    }
    if (opts.mode === 'start') {
      const input = {
        project: path.basename(cfg.targetRepoPath), runConfig: path.resolve(configPath),
        intent: 'all-proven test preparation', concurrency,
        integrationBranch: integration.branch,
        integrationHead: baseHead, config: cfg, issues: snapshots.map((s) => s.summary),
      };
      manifest = state.createManifest(root, opts.batch, input);
    }
    // A test-supplied integration inspector is already the authority for its synthetic tree;
    // production still re-reads each real worktree HEAD after creation.
    snapshots = prepareWorktrees(snapshots, configPath, seams,
      Object.prototype.hasOwnProperty.call(seams, 'inspectIntegration') ? null : baseHead, cfg);
    const strays = strayIssues(cfg, rosterIds, seams);
    state.appendEvent(root, opts.batch, 'batch.strays', scrubSecrets({
      state: strays.ok ? (strays.ids.length ? 'attention' : 'clear') : 'attention',
      ids: strays.ids, error: strays.error || null,
    }, cfg));
    const runnable = [];
    const ackedPhases = acknowledgedPhases(state, root, opts.batch);
    for (const item of snapshots) {
      const prior = latestAttempt(state.readWorkerRecords(root, opts.batch, item.id));
      if (opts.mode === 'start' && prior.started) {
        item.outcome = 'attention'; delete item.action;
        item.error = 'worker record unexpectedly predates batch start';
      } else if (opts.mode === 'resume' && prior.started) {
        if (prior.result && prior.result.outcome === 'usage-limit' && canonicalUsageLimit(prior.result.data)) {
          item.action = item.action || attemptPhase(prior.started);
          item.retainedProbe = prior.result.data.probe || null;
          item.outcome = item.action;
        } else if (prior.result) {
          delete item.action; item.outcome = prior.result.outcome;
        }
        else {
          delete item.action;
          item.outcome = 'attention';
          item.error = 'interrupted worker requires explicit retry';
        }
      }
      if (opts.mode === 'retry') {
        if (!ids.includes(item.id)) { delete item.action; continue; }
        if (prior.started && !prior.result) {
          const phase = attemptPhase(prior.started);
          item.outcome = 'attention'; delete item.action;
          item.error = !['author-proof', 'proof'].includes(phase)
            ? 'interrupted worker has no valid recorded phase'
            : `interrupted ${phase} attempt must be acknowledged before retry; it cannot become ${item.action || 'another phase'}`;
        } else if (prior.started && prior.result) {
          const key = `${item.id}\0${prior.started.nonce || ''}`;
          const interruptedPhase = ackedPhases.get(key)
            || (prior.result.data && prior.result.data.acknowledgedInterrupted
              ? prior.result.data.interruptedPhase : null);
          if (interruptedPhase && item.action !== interruptedPhase) {
            const nextPhase = item.action || 'no runnable phase';
            item.outcome = 'attention'; delete item.action;
            item.error = `acknowledged ${interruptedPhase} attempt now classifies as ${nextPhase}; inspect or remove the partial suite before retry`;
          }
        }
      }
      state.appendEvent(root, opts.batch, 'issue.snapshotted', scrubSecrets({
        issueId: item.id, state: item.outcome, action: item.action || null,
        error: item.error || null, issueUpdatedAt: item.built && item.built.issueUpdatedAt,
        criteriaHash: item.built && item.built.criteria && item.built.criteria.sha256,
        branch: item.built && item.built.folder && item.built.folder.branch,
        folder: item.built && item.built.folder && item.built.folder.dir,
        designCommit: item.designCommit || null,
        designReasons: item.designReasons || [],
      }, cfg));
      if (item.action) runnable.push(item);
    }
    const workerStages = new Map();
    const reportWorkerProgress = seams.onWorkerProgress || ((id, event) => {
      const line = proof.proofStageLine(event); if (line) err(`${id}: ${line}`);
    });
    const onWorkerProgress = (id, event) => {
      if (event && typeof event.stage === 'string') workerStages.set(id, event.stage);
      reportWorkerProgress(id, event);
    };
    const pooled = await runPoolUntilUsageLimit(runnable, concurrency,
      (item) => (seams.runWorker || runWorker)(root, opts.batch, item, configPath, state,
        { ...seams, ownership: held.ownership, onWorkerProgress }),
      (result, item, activeWorkers) => {
        const pausePayload = {
          state: 'paused', resetAt: result.rateLimit.resetAt,
          stage: workerStages.get(item.id) || item.action,
          activeWorkers, issueId: item.id,
          preservedPaths: snapshots.flatMap(retainedPaths),
          resumeCommand: `node scripts/prepare-batch.js resume ${opts.batch}`,
        };
        if (!priorPause) state.appendEvent(root, opts.batch, 'batch.usage-limit-paused', scrubSecrets(pausePayload, cfg));
      });
    const results = pooled.results;
    if (priorPause && !pooled.parked) {
      state.appendEvent(root, opts.batch, 'batch.usage-limit-resumed', scrubSecrets({
        state: 'running', resetAt: priorPause.resetAt, stage: priorPause.stage,
        activeWorkers: priorPause.activeWorkers || [], issueId: priorPause.issueId,
        preservedPaths: [...new Set(results.flatMap(retainedPaths))],
        resumeCommand: priorPause.resumeCommand,
      }, cfg));
    }
    for (const item of snapshots.filter((s) => !s.action)) out(`${item.id}: ${item.outcome}${item.error ? ` — ${item.error}` : ''}`);
    for (const result of results) out(`${result.id}: ${result.outcome}${result.error ? ` — ${result.error}` : ''}`);
    if (strays.ids.length) out(`stray dispatchable issues outside this batch: ${strays.ids.join(', ')}`);
    if (!strays.ok) out(`ready-queue attention: ${strays.error}`);
    const attention = snapshots.some((s) => ['attention', 'collision', 'needs-criteria', 'needs-design'].includes(s.outcome))
      || results.some((r) => !r.ok && !canonicalUsageLimit(r)) || !strays.ok || strays.ids.length > 0;
    return attention ? EXIT_ATTENTION : 0;
  } finally {
    // A child releases nothing: the lease it ran under belongs to its parent, and releasing
    // another coordinator's ownership record is the one mistake this whole layer exists to
    // make impossible. Its parent settles the grant instead.
    if (!childAdmission) {
      try { (seams.release || lock.release)(ROOT, cfg.targetRepoPath, held.ownership); }
      catch (e) { err(`prepare-batch: target lock release failed: ${e.message}`); }
    }
  }
}

async function main(argv, io = {}, seams = {}) {
  const err = io.err || console.error;
  const opts = parseArgs(argv);
  if (opts.error) { err(`prepare-batch: ${opts.error}`); err(USAGE); return EXIT_USAGE; }
  try { return await execute(opts, io, seams); }
  catch (e) { err(`prepare-batch: ${e.message}`); return EXIT_ATTENTION; }
}

if (require.main === module) main(process.argv.slice(2)).then((code) => { process.exitCode = code; });

module.exports = {
  main, execute, parseArgs, dependenciesOf, classifyBuilt, snapshotBatch, prepareWorktrees,
  runPool, runPoolUntilUsageLimit, runWorker, parseWorkerResult, parseWorkerEnvelope, latestAttempt, pidAlive, statusReport,
  workerEnv, hostEnvSecrets, scrubSecrets, integrationHead, snapshotFingerprints,
  inspectIntegration, strayIssues, settleEmptyTakeover, unresolvedWorkers, acknowledgeInterrupted,
  acknowledgedPhases, shouldCheckPrerequisites, canonicalUsageLimit, activeUsagePause, hasUsageLimitHistory,
  retainedPaths, usageLimitStatus, createUsageLimitPreparation,
  attemptPhase, sameConfigIdentity, SECRET_MARKER,
  DEFAULT_CONCURRENCY, MAX_CONCURRENCY, MAX_WORKER_OUTPUT, STAGE_PREFIX,
  EXIT_USAGE, EXIT_REFUSED, EXIT_ATTENTION,
};
