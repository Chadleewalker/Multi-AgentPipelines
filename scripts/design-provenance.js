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
const { validateIssueId } = require('../runner/preparation-state');

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
const stdout = (line) => fs.writeSync(1, `${line}\n`);
const stderr = (line) => fs.writeSync(2, `${line}\n`);

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
  const target = lock.canonicalTarget(cfg.targetRepoPath);
  return runSync('git', ['-c', `safe.directory=${target}`, ...args], {
    cfg, kind: 'git', cwd: target, label,
  });
}

function checkedIssueId(value) {
  try { return { ok: true, id: validateIssueId(value) }; }
  catch (e) { return { ok: false, reason: 'invalid-id', error: e.message }; }
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

function remoteTip(cfg, branchName) {
  const ref = `refs/heads/${branchName}`;
  const result = git(cfg, ['ls-remote', '--exit-code', cfg.targetRepoRemote, ref],
    'read remote provenance integration ref');
  const match = result.status === 0
    ? /^([0-9a-f]{40,64})\s+/i.exec(String(result.stdout || '').trim()) : null;
  return match ? { ok: true, head: match[1] }
    : { ok: false, error: failureText(result, `cannot read remote integration ref ${ref}`) };
}

function fetchRemoteTip(cfg, branchName) {
  return git(cfg, ['fetch', '--no-tags', cfg.targetRepoRemote, `refs/heads/${branchName}`],
    'fetch remote provenance integration ref');
}

function remotelyReaches(cfg, branchName, commit) {
  const tip = remoteTip(cfg, branchName);
  if (!tip.ok) return tip;
  if (tip.head === commit) return { ok: true, head: tip.head };
  const fetched = fetchRemoteTip(cfg, branchName);
  if (fetched.status !== 0) {
    return { ok: false, head: tip.head, error: failureText(fetched, 'cannot fetch remote integration ref') };
  }
  const ancestor = git(cfg, ['merge-base', '--is-ancestor', commit, tip.head],
    'prove provenance commit is reachable from remote integration ref');
  return ancestor.status === 0
    ? { ok: true, head: tip.head }
    : { ok: false, head: tip.head, error: `remote integration ref ${tip.head} does not contain provenance commit ${commit}` };
}

function commitPaths(cfg, commit) {
  const shown = git(cfg, ['show', '--format=', '--name-only', commit],
    'inspect stranded provenance commit');
  if (shown.status !== 0) return null;
  return String(shown.stdout || '').split(/\r?\n/).filter(Boolean);
}

function parentOf(cfg, commit) {
  const result = git(cfg, ['rev-parse', `${commit}^`], 'read stranded provenance parent');
  const value = String(result.stdout || '').trim();
  return result.status === 0 && /^[0-9a-f]{40,64}$/i.test(value) ? value : null;
}

function realDirectory(value, label) {
  let stat;
  try { stat = fs.lstatSync(value); }
  catch (e) { return { ok: false, error: `${label} is unavailable: ${e.message}` }; }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    return { ok: false, error: `${label} must be a real non-symlink directory` };
  }
  return { ok: true };
}

function destination(cfg, id) {
  let target;
  try { target = fs.realpathSync(lock.canonicalTarget(cfg.targetRepoPath)); }
  catch (e) { return { ok: false, error: `canonical target repository is unavailable: ${e.message}` }; }
  const targetState = realDirectory(target, 'canonical target repository');
  if (!targetState.ok) return targetState;
  let current = target;
  for (const segment of ['docs', 'design']) {
    current = path.join(current, segment);
    const state = realDirectory(current, `provenance component ${segment}`);
    if (!state.ok) return state;
  }
  const provenance = path.join(current, 'provenance');
  let provenanceExists = true;
  try { fs.lstatSync(provenance); }
  catch (e) {
    if (e.code === 'ENOENT') provenanceExists = false;
    else return { ok: false, error: `provenance directory is unavailable: ${e.message}` };
  }
  if (!provenanceExists) {
    try { fs.mkdirSync(provenance, { mode: 0o755 }); }
    catch (e) { return { ok: false, error: `cannot create provenance directory: ${e.message}` }; }
  }
  const provenanceState = realDirectory(provenance, 'provenance directory');
  if (!provenanceState.ok) return provenanceState;
  let realProvenance;
  try { realProvenance = fs.realpathSync(provenance); }
  catch (e) { return { ok: false, error: `cannot resolve provenance directory: ${e.message}` }; }
  const fold = (value) => process.platform === 'win32' ? value.toLowerCase() : value;
  if (!fold(realProvenance).startsWith(`${fold(target)}${path.sep}`)) {
    return { ok: false, error: 'provenance directory escapes the canonical target repository' };
  }
  const filename = `${id}.md`;
  let names;
  try { names = fs.readdirSync(realProvenance); }
  catch (e) { return { ok: false, error: `cannot inspect provenance directory: ${e.message}` }; }
  const collision = names.find((name) => name.toLowerCase() === filename.toLowerCase() && name !== filename);
  if (collision) return { ok: false, error: `${filename} case-fold collides with existing ${collision}` };
  return {
    ok: true, target, directory: realProvenance, absolute: path.join(realProvenance, filename),
    rel: `${design.PROVENANCE_DIR}/${filename}`,
  };
}

function existingPathState(absolute) {
  try {
    const stat = fs.lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) return { exists: true, safe: false };
    return { exists: true, safe: true };
  } catch (e) {
    if (e.code === 'ENOENT') return { exists: false, safe: true };
    return { exists: true, safe: false, error: e.message };
  }
}

function defaultUpdateIssue(cfg, id, designField) {
  const result = bd(cfg, ['update', id, '--design', designField]);
  return result.status === 0 ? { ok: true } : { ok: false, error: String(result.stderr || result.stdout || 'bd update failed').trim() };
}

function publish(opts, io = {}, seams = {}) {
  const valid = checkedIssueId(opts && opts.id);
  if (!valid.ok) return valid;
  opts = { ...opts, id: valid.id };
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

    const dest = destination(cfg, opts.id);
    if (!dest.ok) return { ok: false, reason: 'already-published', error: dest.error };
    const { rel, absolute } = dest;
    const prior = blob(cfg, current.head, rel);
    const designField = `design-ref: ${rel}${opts.anchor ? `#${opts.anchor}` : ''}`;
    const sha256 = crypto.createHash('sha256').update(text, 'utf8').digest('hex');
    const disk = existingPathState(absolute);
    if (prior.exists) {
      if (prior.text !== text) {
        return { ok: false, reason: 'already-published', error: `${rel} is immutable provenance owned by issue ${opts.id}` };
      }
      if (!disk.exists || !disk.safe || fs.readFileSync(absolute, 'utf8') !== text) {
        return { ok: false, reason: 'already-published', error: `${rel} is not the unchanged tracked provenance file` };
      }
      let published = remotelyReaches(cfg, expectedBranch, current.head);
      if (!published.ok) {
        const tip = remoteTip(cfg, expectedBranch);
        const paths = commitPaths(cfg, current.head);
        const parent = parentOf(cfg, current.head);
        if (!tip.ok || !paths || paths.length !== 1 || paths[0] !== rel || parent !== tip.head) {
          return { ok: false, reason: 'raced', error: published.error || 'remote integration ref diverged from local provenance evidence' };
        }
        const pushed = git(cfg, ['push', cfg.targetRepoRemote, `HEAD:refs/heads/${expectedBranch}`],
          'complete stranded provenance push');
        published = remotelyReaches(cfg, expectedBranch, current.head);
        if (!published.ok) {
          return { ok: false, reason: 'raced', error: failureText(pushed, published.error || 'provenance push was refused') };
        }
      }
      const updated = (seams.updateIssue || defaultUpdateIssue)(cfg, opts.id, designField);
      if (!updated || !updated.ok) return { ok: false, reason: 'already-published', error: updated && updated.error || 'cannot update the canonical issue' };
      return { ok: true, path: rel, anchor: opts.anchor || null, sha256, commit: current.head, designField, unchanged: true };
    }

    if (disk.exists || !disk.safe) {
      return { ok: false, reason: 'already-published', error: `${rel} already exists outside the integration commit` };
    }
    try { fs.writeFileSync(absolute, text, { encoding: 'utf8', flag: 'wx' }); }
    catch (e) { return { ok: false, reason: 'already-published', error: `cannot exclusively create ${rel}: ${e.message}` }; }
    const added = git(cfg, ['add', '--', rel], 'stage approved design provenance');
    if (added.status !== 0) return { ok: false, reason: 'not-on-branch', error: failureText(added, `cannot stage ${rel}`) };
    const committed = git(cfg, ['commit', '-m', `planning: publish design provenance for ${opts.id}`, '--', rel], 'commit approved design provenance');
    if (committed.status !== 0) return { ok: false, reason: 'not-on-branch', error: failureText(committed, `cannot commit ${rel}`) };
    const made = head(cfg);
    if (!made.ok) return { ok: false, reason: 'not-on-branch', error: made.error };
    const pushed = git(cfg, ['push', cfg.targetRepoRemote, `HEAD:refs/heads/${expectedBranch}`], 'push approved design provenance');
    const published = remotelyReaches(cfg, expectedBranch, made.head);
    if (!published.ok) {
      return { ok: false, reason: 'raced', error: failureText(pushed, published.error || 'provenance push was refused') };
    }
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
  const ids = [];
  for (const raw of opts && opts.ids || []) {
    const valid = checkedIssueId(raw);
    if (!valid.ok) { err(`design-provenance: ${valid.error}`); return { ok: false, unknown: true, issues: [] }; }
    ids.push(valid.id);
  }
  let cfg;
  try { cfg = (seams.loadConfig || loadConfig)(opts.config); }
  catch (e) { err(`design-provenance: ${e.message}`); return { ok: false, unknown: true, issues: [] }; }
  const at = opts.commit || head(cfg).head;
  if (!at) { err('design-provenance: cannot resolve the integration commit'); return { ok: false, unknown: true, issues: [] }; }
  const issues = [];
  for (const id of ids) {
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

function main(argv, out = stdout, err = stderr) {
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
