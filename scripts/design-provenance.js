#!/usr/bin/env node
// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { loadConfig } = require('../runner/config');
const { bd, bdJson } = require('../runner/bd');
const lock = require('../runner/lock');
const { runSync, failureText } = require('../runner/process');
const design = require('../runner/design-ref');

const ROOT = path.resolve(__dirname, '..');
const EXIT_OK = 0;
const EXIT_REFUSED = 1;
const EXIT_USAGE = 2;
const EXIT_UNKNOWN = 3;
const USAGE = [
  'usage:',
  '  node scripts/design-provenance.js publish <issue-id> --config <path> --source <file> [--anchor <anchor>] [--expected-head <sha>]',
  '  node scripts/design-provenance.js verify <issue-id>... --config <path> [--commit <sha>]',
].join('\n');

function parseArgs(argv) {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) return { help: true };
  const verb = argv[0];
  if (!['publish', 'verify'].includes(verb)) return { error: 'the verb must be publish or verify' };
  const answer = { verb, ids: [] };
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (['--config', '--source', '--anchor', '--expected-head', '--commit'].includes(arg)) {
      const value = argv[++i];
      if (value === undefined || value.startsWith('--')) return { error: `${arg} needs a value` };
      answer[arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
    } else if (arg.startsWith('--')) return { error: `unknown option ${arg}` };
    else answer.ids.push(arg);
  }
  if (!answer.config) return { error: '--config is required' };
  if (verb === 'publish' && (answer.ids.length !== 1 || !answer.source)) {
    return { error: 'publish requires one issue id and --source' };
  }
  if (verb === 'verify' && !answer.ids.length) return { error: 'verify requires at least one issue id' };
  if (verb === 'publish' && answer.commit) return { error: '--commit is accepted only by verify' };
  if (verb === 'verify' && (answer.source || answer.anchor || answer.expectedHead)) {
    return { error: '--source, --anchor and --expected-head are accepted only by publish' };
  }
  answer.id = answer.ids[0];
  return answer;
}

function git(cfg, args, label) {
  return runSync('git', ['-c', 'safe.directory=*', ...args], {
    cfg, kind: 'git', cwd: cfg.targetRepoPath, label,
  });
}

function head(cfg) {
  const result = git(cfg, ['rev-parse', 'HEAD'], 'read provenance publication HEAD');
  const value = String(result.stdout || '').trim();
  return result.status === 0 && /^[0-9a-f]{40,64}$/i.test(value)
    ? { ok: true, head: value } : { ok: false, error: failureText(result, 'cannot read HEAD') };
}

function branch(cfg) {
  const result = git(cfg, ['rev-parse', '--abbrev-ref', 'HEAD'], 'read provenance integration branch');
  return result.status === 0 ? String(result.stdout || '').trim() : null;
}

function remoteBranch(cfg) {
  if (cfg.defaultBranch) return cfg.defaultBranch;
  const result = git(cfg, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], 'resolve integration branch');
  if (result.status === 0) return String(result.stdout || '').trim().replace(/^origin\//, '');
  return 'main';
}

function blob(cfg, commit, rel) {
  const result = git(cfg, ['cat-file', 'blob', `${commit}:${rel}`], 'read existing design provenance');
  return result.status === 0 ? { exists: true, text: String(result.stdout || '') } : { exists: false };
}

function defaultUpdateIssue(cfg, id, designField) {
  const result = bd(cfg, ['update', id, '--design', designField]);
  return result.status === 0 ? { ok: true } : { ok: false, error: String(result.stderr || result.stdout || 'bd update failed').trim() };
}

function publish(opts, io = {}, seams = {}) {
  let cfg;
  try { cfg = (seams.loadConfig || loadConfig)(opts.config); }
  catch (e) { return { ok: false, reason: 'not-on-branch', error: e.message }; }
  const sourcePath = opts.source && path.resolve(opts.source);
  let text;
  try { text = sourcePath ? fs.readFileSync(sourcePath, 'utf8') : ''; }
  catch { text = ''; }
  if (!text) return { ok: false, reason: 'no-source', error: `no approved design source was readable at ${sourcePath || '(none)'}` };

  if (opts.anchor && !design.hasAnchor(text, opts.anchor)) {
    return { ok: false, reason: 'missing-anchor', error: `anchor ${opts.anchor} is absent from ${sourcePath}` };
  }

  const held = (seams.acquire || lock.acquire)(ROOT, cfg.targetRepoPath, `design-provenance-${opts.id}`);
  if (!held.ok) {
    const holder = held.holder || {};
    return { ok: false, reason: 'locked', error: `target is owned by ${holder.runId || 'another planning session'} (pid ${holder.pid || 'unknown'})` };
  }
  try {
    const current = head(cfg);
    if (!current.ok) return { ok: false, reason: 'not-on-branch', error: current.error };
    if (opts.expectedHead && opts.expectedHead !== current.head) {
      return { ok: false, reason: 'raced', error: `expected integration HEAD ${opts.expectedHead}, but it is now ${current.head}` };
    }
    const expectedBranch = remoteBranch(cfg);
    const staged = git(cfg, ['diff', '--cached', '--quiet'], 'inspect provenance publication index');
    if (branch(cfg) !== expectedBranch || staged.status !== 0) {
      return { ok: false, reason: 'not-on-branch', error: `checkout must be on ${expectedBranch} with a clean index` };
    }

    const rel = `${design.PROVENANCE_DIR}/${opts.id}.md`;
    const prior = blob(cfg, current.head, rel);
    const designField = `design-ref: ${rel}${opts.anchor ? `#${opts.anchor}` : ''}`;
    const sha256 = crypto.createHash('sha256').update(text, 'utf8').digest('hex');
    if (prior.exists) {
      if (prior.text !== text) {
        return { ok: false, reason: 'already-published', error: `${rel} is immutable provenance owned by issue ${opts.id}` };
      }
      const updated = (seams.updateIssue || defaultUpdateIssue)(cfg, opts.id, designField);
      if (!updated || !updated.ok) return { ok: false, reason: 'already-published', error: updated && updated.error || 'cannot update the canonical issue' };
      return { ok: true, path: rel, anchor: opts.anchor || null, sha256, commit: current.head, designField, unchanged: true };
    }

    const absolute = path.join(cfg.targetRepoPath, ...rel.split('/'));
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, text);
    const added = git(cfg, ['add', '--', rel], 'stage approved design provenance');
    if (added.status !== 0) return { ok: false, reason: 'not-on-branch', error: failureText(added, `cannot stage ${rel}`) };
    const committed = git(cfg, ['commit', '-m', `planning: publish design provenance for ${opts.id}`, '--', rel], 'commit approved design provenance');
    if (committed.status !== 0) return { ok: false, reason: 'not-on-branch', error: failureText(committed, `cannot commit ${rel}`) };
    const made = head(cfg);
    if (!made.ok) return { ok: false, reason: 'not-on-branch', error: made.error };
    const pushed = git(cfg, ['push', cfg.targetRepoRemote, `HEAD:refs/heads/${expectedBranch}`], 'push approved design provenance');
    if (pushed.status !== 0) return { ok: false, reason: 'raced', error: failureText(pushed, 'provenance push was refused') };
    const updated = (seams.updateIssue || defaultUpdateIssue)(cfg, opts.id, designField);
    if (!updated || !updated.ok) return { ok: false, reason: 'already-published', error: updated && updated.error || 'cannot update the canonical issue' };
    return { ok: true, path: rel, anchor: opts.anchor || null, sha256, commit: made.head, designField, unchanged: false };
  } finally {
    try { (seams.release || lock.release)(ROOT, cfg.targetRepoPath, held.ownership); } catch { /* a stale lock is recoverable */ }
  }
}

function verify(opts, io = {}, seams = {}) {
  const out = io.out || console.log;
  const err = io.err || console.error;
  let cfg;
  try { cfg = (seams.loadConfig || loadConfig)(opts.config); }
  catch (e) { err(`design-provenance: ${e.message}`); return { ok: false, unknown: true, issues: [] }; }
  const at = opts.commit || head(cfg).head;
  if (!at) { err('design-provenance: cannot resolve the integration commit'); return { ok: false, unknown: true, issues: [] }; }
  const issues = [];
  for (const id of opts.ids || []) {
    const shown = (seams.bdJson || bdJson)(cfg, ['show', id]);
    if (!shown.ok) { err(`design-provenance: ${id}: ${shown.error}`); return { ok: false, unknown: true, issues }; }
    const issue = Array.isArray(shown.data) ? shown.data[0] : shown.data;
    const resolution = (seams.resolveDesign || design.resolveIssue)(issue, { repoPath: cfg.targetRepoPath, commit: at });
    issues.push({ id, resolution });
    for (const line of design.refusalLines(resolution, { issueId: id })) err(line);
    if (resolution.ok) out(`${id}: design provenance resolves at ${at}`);
  }
  return { ok: issues.every((item) => item.resolution.ok), issues };
}

function main(argv, out = console.log, err = console.error) {
  const opts = parseArgs(argv);
  if (opts.help) { out(USAGE); return EXIT_OK; }
  if (opts.error) { err(`design-provenance: ${opts.error}`); err(USAGE); return EXIT_USAGE; }
  if (opts.verb === 'publish') {
    const result = publish(opts, { out, err });
    if (!result.ok) { err(`design-provenance: ${result.reason}: ${result.error}`); return EXIT_REFUSED; }
    out(`${result.path}: ${result.unchanged ? 'already published' : `published at ${result.commit}`}`);
    out(result.designField);
    return EXIT_OK;
  }
  const result = verify(opts, { out, err });
  if (result.unknown) return EXIT_UNKNOWN;
  return result.ok ? EXIT_OK : EXIT_REFUSED;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = {
  main, parseArgs, publish, verify, EXIT_OK, EXIT_REFUSED, EXIT_USAGE, EXIT_UNKNOWN,
};
