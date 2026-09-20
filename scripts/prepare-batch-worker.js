#!/usr/bin/env node
// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0
'use strict';

// One deliberately narrow preparation worker. The parent has already read Beads, resolved the
// issue worktree and materialised the complete brief. This process consumes that immutable JSON
// on stdin; it has no config/issue CLI and therefore no route back through buildBrief or bd.

const fs = require('fs');
const { runSync } = require('../runner/process');
const author = require('./author-tests');
const proof = require('./prove-tests');

const MAX_INPUT = 4 * 1024 * 1024;
const MAX_TEXT = 64 * 1024;
const SAFE_ACTIONS = new Set(['author-proof', 'proof']);
const STAGE_PREFIX = 'PREPARATION_STAGE ';

function limited(value, max = MAX_TEXT) {
  const text = String(value || '');
  return text.length <= max ? text : `${text.slice(0, max)}\n[truncated ${text.length - max} characters]`;
}

function validateJob(job) {
  if (!job || typeof job !== 'object' || Array.isArray(job)) return 'job must be a JSON object';
  if (!SAFE_ACTIONS.has(job.action)) return 'action must be author-proof or proof';
  const built = job.built;
  if (!built || typeof built !== 'object' || !proof.validIssueId(built.id)) return 'job has no safe issue id';
  if (built.suiteId !== undefined && !proof.validIssueId(built.suiteId)) return 'job has no safe canonical suite id';
  if (!built.cfg || typeof built.cfg !== 'object' || !built.policy || typeof built.policy !== 'object') {
    return 'job has no immutable config/policy snapshot';
  }
  if (!built.folder || built.folder.exists !== true || typeof built.folder.dir !== 'string') {
    return 'job has no existing dedicated worktree';
  }
  if (job.action === 'author-proof' && (built.state !== 'write' || typeof built.text !== 'string')) {
    return 'author-proof needs a write-state brief';
  }
  if (job.action === 'proof' && !['freeze', 're-gate', 'write'].includes(built.state)) {
    return 'proof job has an unsupported brief state';
  }
  if (job.retainedProbe !== undefined && typeof job.retainedProbe !== 'string') return 'retained probe must be a path string';
  if (job.candidateProbe !== undefined) {
    if (job.action !== 'proof') return 'candidate reuse requires a proof-only job';
    if (job.retainedProbe !== undefined) return 'candidate reuse cannot be combined with a retained probe';
    const candidate = job.candidateProbe;
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)
        || typeof candidate.path !== 'string' || !candidate.path.trim() || candidate.path.includes('\0')
        || typeof candidate.hash !== 'string' || !/^[0-9a-f]{64}$/.test(candidate.hash)) {
      return 'candidate reuse requires a path and a 64-character lowercase hash';
    }
  }
  return null;
}

function currentHead(built, run = runSync) {
  const r = run('git', ['rev-parse', 'HEAD'], {
    cfg: built.cfg, kind: 'git', cwd: built.cfg.targetRepoPath,
    label: 'read integration HEAD after preparation proof',
  });
  const head = String(r.stdout || '').trim();
  return r.status === 0 && /^[0-9a-f]{40,64}$/i.test(head) ? head : null;
}

function authorStructured(built, configPath, seams, log) {
  if (typeof author.authorIssue === 'function') {
    return author.authorIssue(built, configPath, { out: (s) => log.push(limited(s)), err: (s) => log.push(limited(s)) }, seams);
  }
  // Compatibility with the immediately preceding release. This is the same bd-free core that
  // authorIssue extracts: audit, restricted author, audit, then the independent green proof.
  const before = (seams.auditAuthorTree || author.auditAuthorTree)(built, seams.runSync || runSync);
  if (!before.ok) return { ok: false, kind: 'boundary', error: before.error };
  const model = String(built.cfg.testAuthorModel || built.cfg.model || '').trim();
  const probeModel = String(built.cfg.testProbeModel || built.cfg.testAuthorModel || built.cfg.model || '').trim();
  const launched = (seams.launchAuthor || author.launchAuthor)(built, model, seams.runSync || runSync);
  log.push(limited(launched.stdout)); log.push(limited(launched.stderr));
  if (launched.status !== 0) return { ok: false, kind: 'agent', error: `test author exited ${launched.status}` };
  const after = (seams.auditAuthorTree || author.auditAuthorTree)(built, seams.runSync || runSync);
  if (!after.ok) return { ok: false, kind: 'boundary', error: after.error };
  const probeSeams = { ...(seams.probeSeams || {}) };
  if (typeof seams.onStage === 'function' && typeof probeSeams.onStage !== 'function') probeSeams.onStage = seams.onStage;
  const result = (seams.proveTests || proof.proveTests)(built, probeModel, probeSeams);
  if (result && result.outcome === 'usage-limit' && result.rateLimit) return { ...result };
  return result.ok
    ? { ok: true, outcome: 'proven-at-base', probe: result.probe, attempt: result.attempt,
      evidence: limited(result.evidence), agentOutput: limited(result.agentOutput) }
    : { ok: false, outcome: 'unproven', kind: result.kind, probe: result.probe,
      error: result.error, evidence: limited(result.evidence) };
}

function proofStructured(built, seams, retainedProbe = null, candidateProbe = null) {
  const model = String(built.cfg.testProbeModel || built.cfg.testAuthorModel || built.cfg.model || '').trim();
  if (!model) return { ok: false, outcome: 'unproven', kind: 'config', error: 'no probe model is configured' };
  const probeSeams = { ...(seams.probeSeams || {}) };
  if (retainedProbe) probeSeams.retainedProbe = retainedProbe;
  if (candidateProbe) probeSeams.candidateProbe = candidateProbe;
  if (typeof seams.onStage === 'function' && typeof probeSeams.onStage !== 'function') probeSeams.onStage = seams.onStage;
  const answered = (seams.proveTests || proof.proveTests)(built, model, probeSeams);
  // A proof that answered with nothing object-shaped is a malformed result, not a verdict: read
  // no field off it rather than throwing out of the worker body.
  const result = answered && typeof answered === 'object' && !Array.isArray(answered) ? answered : {};
  if (result.outcome === 'usage-limit' && result.rateLimit) return { ...result };
  return result.ok
    ? { ok: true, outcome: 'proven-at-base', probe: result.probe, attempt: result.attempt,
      evidence: limited(result.evidence), agentOutput: limited(result.agentOutput) }
    : { ok: false, outcome: 'unproven', kind: result.kind, probe: result.probe,
      error: result.error, evidence: limited(result.evidence) };
}

// The one proof outcome a later attempt may resume, filtered from the broader `retained` flag
// `prove-tests` sets. Usage-limit parks and post-preparation interruptions also report
// `retained: true`, and every refusal that leaves a container behind still reports `probe` for
// inspection; neither is authority to reuse a container as a proof in progress. So: ordinary
// attempt exhaustion only, and the claimed path is re-read on disk here rather than echoed —
// it must still be an owned managed container for THIS job's suite whose durable marker says
// `unfinished`. Anything else publishes nothing.
function resumableProbeFrom(result, built, seams = {}) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
  if (result.ok !== false || result.kind !== 'unproven' || result.retained !== true) return null;
  if (result.outcome !== undefined && result.outcome !== 'unproven') return null;
  const probe = result.probe;
  if (typeof probe !== 'string' || !probe.length) return null;
  const suiteId = built && (built.suiteId || built.id);
  if (!proof.validIssueId(suiteId)) return null;
  let managed = null;
  try { managed = (seams.readManagedProbe || proof.readManagedProbe)(probe); }
  catch { return null; }
  if (!managed || !managed.marker || managed.marker.issue !== suiteId
      || managed.marker.status !== 'unfinished') return null;
  return probe;
}

// Serialize an exception that escaped the author/proof body into the worker's existing terminal
// invalid envelope. The primary message survives; a bounded, role-only containment-cleanup
// outcome is added additively when the exception carried one. The raw exception cause is never
// serialized into a public field — cause preservation stays in-process.
function terminalException(thrown, log = []) {
  const message = (thrown && thrown.message) || String(thrown);
  const envelope = { ok: false, outcome: 'invalid', error: limited(message) };
  const cleanup = thrown && typeof thrown === 'object' ? thrown.containmentCleanup : null;
  if (cleanup && typeof cleanup === 'object') {
    envelope.containmentCleanup = {
      ok: cleanup.ok === true,
      error: cleanup.error === undefined || cleanup.error === null ? null : limited(String(cleanup.error)),
    };
  }
  if (log && log.length) envelope.log = limited(log.filter(Boolean).join('\n'));
  return envelope;
}

function execute(job, seams = {}) {
  const invalid = validateJob(job);
  if (invalid) return { ok: false, outcome: 'invalid', error: invalid };
  const log = [];
  // Both job shapes reach the proof through this one seam, and only the proof's own result
  // carries the `retained` decision the filter above needs — the structured answers below have
  // already flattened it away. Observe it here so `proof` and `author-proof` publish the
  // dedicated path under identical terms.
  const observedProofs = [];
  const innerProveTests = seams.proveTests || proof.proveTests;
  const proofSeams = { ...seams, proveTests: (...args) => {
    const value = innerProveTests(...args);
    observedProofs.push(value);
    return value;
  } };
  let answer;
  try {
    answer = job.action === 'author-proof'
      ? authorStructured(job.built, job.configPath, proofSeams, log)
      : proofStructured(job.built, proofSeams, job.retainedProbe, job.candidateProbe);
  } catch (thrown) {
    // A launch/author exception that escaped authorIssue is serialized into the worker's
    // EXISTING terminal invalid envelope rather than crashing the worker: its primary message is
    // preserved, and a bounded containment-cleanup outcome the exception carried is added
    // additively as a role-only diagnostic. The raw in-process cause is deliberately NOT
    // serialized into any new public field — in-process cause preservation and durable cleanup
    // evidence are separate requirements, so the envelope carries the cleanup role only.
    return terminalException(thrown, log);
  }
  answer = answer && typeof answer === 'object' ? { ...answer } : { ok: false, outcome: 'unproven', error: 'worker returned no result' };
  if (answer.ok) answer.outcome = 'proven-at-base';
  else if (!answer.outcome) answer.outcome = 'unproven';
  for (const key of ['evidence', 'agentOutput', 'error', 'stderr', 'log']) {
    if (answer[key] !== undefined && answer[key] !== null) answer[key] = limited(answer[key]);
  }
  if (answer.ok && answer.probe) {
    const head = currentHead(job.built, seams.runSync || runSync);
    const checked = head && (seams.validateManagedProbe || proof.validateManagedProbe)(
      answer.probe, job.built.cfg.targetRepoPath, [job.built.suiteId || job.built.id], head);
    if (!checked || !checked.ok || !checked.managed) {
      answer = { ok: false, outcome: 'unproven', kind: 'proof-validation', probe: answer.probe,
        error: checked ? checked.error || 'proof is not a managed probe' : 'integration HEAD could not be read' };
    } else {
      answer.proof = {
        issue: checked.marker.issue, head: checked.marker.head,
        manifestHash: checked.marker.manifestHash, evidenceHash: checked.marker.evidenceHash,
        attempts: checked.marker.attempts,
        ...(job.candidateProbe && checked.marker.candidateReuse
          ? { candidateReuse: checked.marker.candidateReuse } : {}),
      };
    }
  }
  if (answer.ok === false) {
    const resumable = resumableProbeFrom(observedProofs[observedProofs.length - 1], job.built, seams);
    if (resumable) answer.resumableProbe = resumable;
  }
  if (log.length) answer.log = limited(log.filter(Boolean).join('\n'));
  return answer;
}

function readJob(stream = process.stdin, limit = MAX_INPUT) {
  return new Promise((resolve, reject) => {
    const chunks = []; let bytes = 0; let settled = false;
    const finish = (fn, value) => { if (!settled) { settled = true; fn(value); } };
    const timer = setTimeout(() => finish(reject, new Error('timed out waiting for immutable job on stdin')), 30000);
    stream.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > limit) {
        clearTimeout(timer); finish(reject, new Error(`job exceeds ${limit} bytes`));
        if (typeof stream.destroy === 'function') stream.destroy();
      } else chunks.push(chunk);
    });
    stream.on('error', (e) => { clearTimeout(timer); finish(reject, e); });
    stream.on('end', () => {
      clearTimeout(timer);
      try { finish(resolve, JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { finish(reject, new Error(`invalid job JSON: ${e.message}`)); }
    });
  });
}

async function main() {
  try {
    const job = await readJob();
    const result = execute(job, { onStage: (event) => {
      if (proof.validStageEvent(event)) process.stderr.write(`${STAGE_PREFIX}${JSON.stringify(event)}\n`);
    } });
    // This protocol is consumed through a pipe and the process exits immediately afterward.
    // A synchronous write keeps the one-result envelope intact on Windows hosts, where
    // process.stdout.write to a pipe is asynchronous and can otherwise be truncated.
    fs.writeSync(1, `${JSON.stringify(result)}\n`);
    return result.ok ? 0 : 1;
  } catch (e) {
    fs.writeSync(1, `${JSON.stringify({ ok: false, outcome: 'invalid', error: e.message })}\n`);
    return 2;
  }
}

if (require.main === module) main().then((code) => { process.exitCode = code; });

module.exports = {
  execute, validateJob, readJob, limited, currentHead, resumableProbeFrom,
  MAX_INPUT, MAX_TEXT, STAGE_PREFIX,
};
