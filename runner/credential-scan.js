// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// Host-side pre-push credential scan.
//
// Scan every Git object introduced since the task fork point, not merely the files at
// HEAD. A task can commit a secret and delete it in a later commit; the tip is clean, but
// pushing the branch still publishes the earlier blob. Raw tree objects are included too,
// so a secret embedded in a tracked filename is not an escape hatch.
'use strict';

const { spawnSync } = require('child_process');

const DEFAULT_TIMEOUT_MS = 60000;
const MAX_OBJECTS = 10000;
const MAX_BATCH_BYTES = 64 * 1024 * 1024;

// Deliberately high-confidence shapes. Generic words such as `password` or `apiKey` are
// source-code vocabulary, not evidence. Exact injected secrets are checked independently.
const CREDENTIAL_PATTERNS = [
  { kind: 'private-key', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/i },
  { kind: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { kind: 'aws-access-key', re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/ },
  { kind: 'anthropic-api-key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { kind: 'openai-api-key', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/ },
  { kind: 'bearer-token', re: /\bBearer\s+[A-Za-z0-9._~+/=-]{24,}\b/i },
];

function git(dir, args, opts = {}) {
  return spawnSync('git', args, {
    cwd: dir,
    encoding: opts.encoding === undefined ? 'utf8' : opts.encoding,
    input: opts.input,
    timeout: opts.timeoutMs || DEFAULT_TIMEOUT_MS,
    maxBuffer: opts.maxBuffer || MAX_BATCH_BYTES,
    killSignal: 'SIGKILL',
  });
}

function processFailure(result, action) {
  const why = result && result.error
    ? (result.error.code === 'ETIMEDOUT' ? 'timed out' : 'could not start')
    : `exited ${result && result.status}`;
  return { ok: false, reason: `${action} ${why}` };
}

function introducedObjectIds(dir, forkPoint, timeoutMs = DEFAULT_TIMEOUT_MS) {
  if (!/^[0-9a-f]{40,64}$/i.test(String(forkPoint || ''))) {
    return { ok: false, reason: 'credential scan has no valid fork point' };
  }
  const r = git(dir, ['rev-list', '--objects', '--no-object-names', `${forkPoint}..HEAD`],
    { timeoutMs });
  if (r.status !== 0 || r.error) return processFailure(r, 'Git object enumeration');
  const ids = String(r.stdout || '').trim().split(/\s+/).filter(Boolean);
  if (ids.some((id) => !/^[0-9a-f]{40,64}$/i.test(id))) {
    return { ok: false, reason: 'Git object enumeration returned an invalid object id' };
  }
  if (ids.length > MAX_OBJECTS) {
    return { ok: false, reason: `branch introduces too many Git objects to scan (${ids.length} > ${MAX_OBJECTS})` };
  }
  return { ok: true, ids };
}

function findingIn(bytes, secrets) {
  for (const secret of secrets) {
    const needle = Buffer.isBuffer(secret) ? secret : Buffer.from(String(secret));
    if (needle.length && bytes.indexOf(needle) !== -1) return 'exact-injected-secret';
  }
  const text = bytes.toString('utf8');
  for (const pattern of CREDENTIAL_PATTERNS) {
    if (pattern.re.test(text)) return pattern.kind;
  }
  return null;
}

function scanBatch(bytes, expectedIds, secrets) {
  let offset = 0;
  for (const expected of expectedIds) {
    const newline = bytes.indexOf(0x0a, offset);
    if (newline < 0) return { ok: false, reason: 'Git object batch ended before its header' };
    const header = bytes.subarray(offset, newline).toString('ascii');
    const match = /^([0-9a-f]{40,64}) ([a-z]+) ([0-9]+)$/i.exec(header);
    if (!match || match[1].toLowerCase() !== expected.toLowerCase()) {
      return { ok: false, reason: 'Git object batch returned an invalid header' };
    }
    const size = Number(match[3]);
    const start = newline + 1;
    const end = start + size;
    if (!Number.isSafeInteger(size) || size < 0 || end >= bytes.length || bytes[end] !== 0x0a) {
      return { ok: false, reason: 'Git object batch returned a truncated object' };
    }
    const kind = findingIn(bytes.subarray(start, end), secrets);
    if (kind) {
      return {
        ok: false,
        finding: kind,
        objectType: match[2],
        objectId: expected.slice(0, 12),
        reason: `${kind} detected in introduced ${match[2]} ${expected.slice(0, 12)}`,
      };
    }
    offset = end + 1;
  }
  if (offset !== bytes.length) {
    return { ok: false, reason: 'Git object batch returned unexpected trailing data' };
  }
  return { ok: true, scannedObjects: expectedIds.length };
}

function scanIntroducedObjects(dir, forkPoint, secrets = [], opts = {}) {
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const listed = introducedObjectIds(dir, forkPoint, timeoutMs);
  if (!listed.ok || listed.ids.length === 0) {
    return listed.ok ? { ok: true, scannedObjects: 0 } : listed;
  }
  const r = git(dir, ['cat-file', '--batch'], {
    encoding: null,
    input: Buffer.from(`${listed.ids.join('\n')}\n`),
    timeoutMs,
    maxBuffer: MAX_BATCH_BYTES,
  });
  if (r.status !== 0 || r.error) return processFailure(r, 'Git object scan');
  return scanBatch(r.stdout, listed.ids, secrets.filter((s) => s !== null && s !== undefined));
}

module.exports = {
  scanIntroducedObjects,
  introducedObjectIds,
  findingIn,
  scanBatch,
  CREDENTIAL_PATTERNS,
  MAX_OBJECTS,
  MAX_BATCH_BYTES,
};
