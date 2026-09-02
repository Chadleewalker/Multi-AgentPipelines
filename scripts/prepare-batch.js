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
const { bdJson } = require('../runner/bd');
const { readyQueue, resolveBranch } = require('../runner/queue');
const { buildBrief } = require('./spec-brief');
const author = require('./author-tests');
const proof = require('./prove-tests');
const prepState = require('../runner/preparation-state');
const writeProtection = require('./write-protection-policy');

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
      && typeof value.ok === 'boolean' && typeof value.outcome === 'string';
    return verified
      ? { verified: true, result: value }
      : { verified: false, result: { ok: false, outcome: 'invalid', error: 'worker result is not a protocol object' } };
  } catch (e) {
    return { verified: false,
      result: { ok: false, outcome: 'invalid', error: `worker returned invalid JSON: ${e.message}` } };
  }
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
    child.stdin.end(JSON.stringify({ action: item.action, built: item.built, configPath }));
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

function statusReport(root, batch, json, state = prepState, io = {}) {
  const out = io.out || console.log; const err = io.err || console.error;
  try {
    const derived = state.deriveState(root, batch);
    if (!derived.ok) {
      if (json) out(JSON.stringify(derived, null, 2));
      throw new Error(derived.error || 'preparation state is invalid');
    }
    if (json) out(JSON.stringify(derived, null, 2));
    else {
      out(`== preparation batch ${batch} ==`);
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
  const held = (seams.acquire || lock.acquire)(ROOT, cfg.targetRepoPath, `prepare-${opts.batch}`, acquireOptions);
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
    snapshots = prepareWorktrees(snapshots, configPath, seams, baseHead, cfg);
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
        delete item.action;
        if (prior.result) item.outcome = prior.result.outcome;
        else {
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
      }, cfg));
      if (item.action) runnable.push(item);
    }
    const onWorkerProgress = seams.onWorkerProgress || ((id, event) => {
      const line = proof.proofStageLine(event); if (line) err(`${id}: ${line}`);
    });
    const results = await runPool(runnable, concurrency,
      (item) => (seams.runWorker || runWorker)(root, opts.batch, item, configPath, state,
        { ...seams, ownership: held.ownership, onWorkerProgress }));
    for (const item of snapshots.filter((s) => !s.action)) out(`${item.id}: ${item.outcome}${item.error ? ` — ${item.error}` : ''}`);
    for (const result of results) out(`${result.id}: ${result.outcome}${result.error ? ` — ${result.error}` : ''}`);
    if (strays.ids.length) out(`stray dispatchable issues outside this batch: ${strays.ids.join(', ')}`);
    if (!strays.ok) out(`ready-queue attention: ${strays.error}`);
    const attention = snapshots.some((s) => ['attention', 'collision', 'needs-criteria'].includes(s.outcome))
      || results.some((r) => !r.ok) || !strays.ok || strays.ids.length > 0;
    return attention ? EXIT_ATTENTION : 0;
  } finally {
    try { (seams.release || lock.release)(ROOT, cfg.targetRepoPath, held.ownership); }
    catch (e) { err(`prepare-batch: target lock release failed: ${e.message}`); }
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
  runPool, runWorker, parseWorkerResult, parseWorkerEnvelope, latestAttempt, pidAlive, statusReport,
  workerEnv, hostEnvSecrets, scrubSecrets, integrationHead, snapshotFingerprints,
  inspectIntegration, strayIssues, settleEmptyTakeover, unresolvedWorkers, acknowledgeInterrupted,
  acknowledgedPhases,
  attemptPhase, sameConfigIdentity, SECRET_MARKER,
  DEFAULT_CONCURRENCY, MAX_CONCURRENCY, MAX_WORKER_OUTPUT, STAGE_PREFIX,
  EXIT_USAGE, EXIT_REFUSED, EXIT_ATTENTION,
};
