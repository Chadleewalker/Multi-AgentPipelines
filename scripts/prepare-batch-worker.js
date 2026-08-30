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
  const result = (seams.proveTests || proof.proveTests)(built, probeModel, seams.probeSeams || {});
  return result.ok
    ? { ok: true, outcome: 'proven-at-base', probe: result.probe, attempt: result.attempt,
      evidence: limited(result.evidence), agentOutput: limited(result.agentOutput) }
    : { ok: false, outcome: 'unproven', kind: result.kind, probe: result.probe,
      error: result.error, evidence: limited(result.evidence) };
}

function proofStructured(built, seams) {
  const model = String(built.cfg.testProbeModel || built.cfg.testAuthorModel || built.cfg.model || '').trim();
  if (!model) return { ok: false, outcome: 'unproven', kind: 'config', error: 'no probe model is configured' };
  const result = (seams.proveTests || proof.proveTests)(built, model, seams.probeSeams || {});
  return result.ok
    ? { ok: true, outcome: 'proven-at-base', probe: result.probe, attempt: result.attempt,
      evidence: limited(result.evidence), agentOutput: limited(result.agentOutput) }
    : { ok: false, outcome: 'unproven', kind: result.kind, probe: result.probe,
      error: result.error, evidence: limited(result.evidence) };
}

function execute(job, seams = {}) {
  const invalid = validateJob(job);
  if (invalid) return { ok: false, outcome: 'invalid', error: invalid };
  const log = [];
  let answer = job.action === 'author-proof'
    ? authorStructured(job.built, job.configPath, seams, log)
    : proofStructured(job.built, seams);
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
      };
    }
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
    const result = execute(job);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result.ok ? 0 : 1;
  } catch (e) {
    process.stdout.write(`${JSON.stringify({ ok: false, outcome: 'invalid', error: e.message })}\n`);
    return 2;
  }
}

if (require.main === module) main().then((code) => { process.exitCode = code; });

module.exports = { execute, validateJob, readJob, limited, currentHead, MAX_INPUT, MAX_TEXT };
