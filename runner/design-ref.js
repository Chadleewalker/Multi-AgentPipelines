// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0
'use strict';

// Design provenance is resolved from one immutable Git commit.  In particular, this module
// never falls back to the index, the working tree, the pipeline checkout, or an operator's
// filesystem when a referenced blob is absent.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REASONS = Object.freeze([
  'absent', 'unparsable', 'operator-local', 'missing-path', 'missing-anchor',
  'snapshot-mismatch',
]);
const PROVENANCE_DIR = 'docs/design/provenance';
const GIT_TIMEOUT_MS = 60000;
const REMEDY = 'publish approved design provenance with: node scripts/design-provenance.js publish <issue-id> --config <config> --source <file>';

function localPath(value) {
  const raw = String(value || '');
  if (/^(?:[A-Za-z]:[\\/]|[\\/]{2}|\/|~(?:[\\/]|$)|file:\/\/)/i.test(raw)) return true;
  const forward = raw.replace(/\\/g, '/');
  let depth = 0;
  for (const part of forward.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      depth -= 1;
      if (depth < 0) return true;
    } else depth += 1;
  }
  return false;
}

function snapshotFrom(lines) {
  const index = lines.findIndex((line) => /^\s*design-snapshot\s*:/i.test(line));
  if (index < 0) return null;
  const match = /^\s*design-snapshot\s*:\s*sha256:([0-9a-f]{64})\s*$/i.exec(lines[index]);
  if (!match) return { invalid: true, sha256: null, body: '' };
  const open = lines.findIndex((line, i) => i > index && /^\s*```[^`]*\s*$/.test(line));
  if (open < 0) return { invalid: true, sha256: match[1].toLowerCase(), body: '' };
  const close = lines.findIndex((line, i) => i > open && /^\s*```\s*$/.test(line));
  if (close < 0) return { invalid: true, sha256: match[1].toLowerCase(), body: '' };
  return {
    sha256: match[1].toLowerCase(),
    body: `${lines.slice(open + 1, close).join('\n')}\n`,
  };
}

function parse(value) {
  const field = value && typeof value === 'object' ? value.design : value;
  const text = typeof field === 'string' ? field : '';
  const lines = text.split(/\r?\n/);
  const snapshot = snapshotFrom(lines);
  const refs = [];
  let sawRef = false;

  for (const line of lines) {
    const match = /^\s*design-ref\s*:\s*(.*?)\s*$/i.exec(line);
    if (!match) continue;
    sawRef = true;
    const rest = match[1];
    const token = /^(\S+)(?:\s+(.+))?$/.exec(rest);
    if (!token || /^[#§]/.test(token[1])) {
      return { ok: false, reason: 'unparsable', error: 'design-ref requires a repository-relative document path before its anchor' };
    }
    let refPath = token[1];
    let anchor = token[2] ? token[2].trim() : null;
    const hash = refPath.indexOf('#');
    if (hash >= 0) {
      if (anchor !== null || hash === refPath.length - 1) {
        return { ok: false, reason: 'unparsable', error: `cannot parse design reference ${JSON.stringify(rest)}` };
      }
      anchor = refPath.slice(hash + 1).trim();
      refPath = refPath.slice(0, hash);
    }
    if (!refPath || (anchor !== null && !anchor)) {
      return { ok: false, reason: 'unparsable', error: `cannot parse design reference ${JSON.stringify(rest)}` };
    }
    refs.push({ raw: rest, path: refPath.replace(/\\/g, '/'), anchor, local: localPath(refPath) });
  }

  if (!sawRef && !snapshot) return { ok: false, reason: 'absent', error: 'the issue has no design-ref or design-snapshot' };
  if (snapshot && snapshot.invalid) {
    return { ok: true, refs, snapshot };
  }
  return { ok: true, refs, snapshot };
}

function defaultReadBlob(repoPath, commit, blobPath) {
  if (!repoPath || !commit) return { ok: false };
  let target = path.resolve(repoPath);
  try { target = fs.realpathSync(target); } catch { return { ok: false }; }
  const result = spawnSync('git', ['-c', `safe.directory=${target}`, 'cat-file', 'blob', `${commit}:${blobPath}`], {
    cwd: target, encoding: 'utf8', timeout: GIT_TIMEOUT_MS,
    killSignal: 'SIGKILL', maxBuffer: 64 * 1024 * 1024, windowsHide: true,
  });
  return result.status === 0 ? { ok: true, text: String(result.stdout || '') } : { ok: false };
}

function anchorKey(anchor) {
  return String(anchor || '').trim().replace(/^[#§]+/, '').trim();
}

function hasAnchor(text, anchor) {
  if (anchor === null || anchor === undefined) return true;
  const wanted = anchorKey(anchor);
  if (!wanted) return false;
  for (const line of String(text || '').split(/\r?\n/)) {
    const heading = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      const title = heading[1].trim();
      if (title === wanted || title.startsWith(`${wanted} `) || title.startsWith(`${wanted}\t`)) return true;
    }
    const tag = /<a\s+[^>]*(?:id|name)\s*=\s*["']([^"']+)["'][^>]*>/ig;
    let match;
    while ((match = tag.exec(line))) {
      if (match[1] === wanted || match[1] === String(anchor).replace(/^#/, '')) return true;
    }
  }
  return false;
}

function failed(ref, reason) {
  return {
    ok: false, ref, path: ref && ref.path, anchor: ref && ref.anchor, reason, remedy: REMEDY,
  };
}

function resolveRef(ref, options = {}) {
  if (!ref || ref.local) return failed(ref || {}, 'operator-local');
  const reader = options.readBlob || ((commit, blobPath) => defaultReadBlob(options.repoPath, commit, blobPath));
  const read = reader(options.commit, ref.path);
  if (!read || !read.ok) return failed(ref, 'missing-path');
  if (!hasAnchor(read.text, ref.anchor)) return failed(ref, 'missing-anchor');
  return { ok: true, ref, path: ref.path, anchor: ref.anchor, blob: read.text };
}

function resolveIssue(issue, options = {}) {
  const parsed = parse(issue);
  if (!parsed.ok) {
    return {
      ok: false, commit: options.commit, refs: [], reasons: [parsed.reason], remedies: [REMEDY],
      error: parsed.error,
    };
  }
  if (parsed.snapshot) {
    const actual = crypto.createHash('sha256').update(parsed.snapshot.body, 'utf8').digest('hex');
    if (!parsed.snapshot.invalid && actual === parsed.snapshot.sha256) {
      return { ok: true, commit: options.commit, refs: [], reasons: [], remedies: [], snapshot: parsed.snapshot };
    }
    return {
      ok: false, commit: options.commit, refs: [], reasons: ['snapshot-mismatch'], remedies: [REMEDY],
      snapshot: parsed.snapshot,
    };
  }
  const refs = parsed.refs.map((ref) => resolveRef(ref, options));
  const reasons = [...new Set(refs.filter((ref) => !ref.ok).map((ref) => ref.reason))];
  const remedies = [...new Set(refs.filter((ref) => !ref.ok).map((ref) => ref.remedy))];
  return { ok: reasons.length === 0, commit: options.commit, refs, reasons, remedies };
}

function refusalLines(resolution, options = {}) {
  if (!resolution || resolution.ok) return [];
  const issue = options.issueId || 'issue';
  const unresolved = Array.isArray(resolution.refs) ? resolution.refs.filter((ref) => !ref.ok) : [];
  if (unresolved.length) {
    return unresolved.map((ref) => {
      const where = ref.path || '(missing document path)';
      const anchor = ref.anchor ? ` anchor ${ref.anchor}` : '';
      return `${issue}: ${ref.reason} — ${where}${anchor}. Remedy: ${ref.remedy || REMEDY}`;
    });
  }
  return (resolution.reasons || ['unparsable']).map((reason) =>
    `${issue}: ${reason} design provenance. Remedy: ${(resolution.remedies || [REMEDY])[0] || REMEDY}`);
}

module.exports = {
  REASONS, PROVENANCE_DIR, parse, resolveRef, resolveIssue, refusalLines, hasAnchor,
};
