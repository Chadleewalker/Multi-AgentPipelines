'use strict';

// This module is also used by short-lived host readers.  On Windows, stdout to a
// pipe can otherwise still be buffered when such a reader exits immediately.
try {
  if (process.stdout && process.stdout._handle
      && typeof process.stdout._handle.setBlocking === 'function') {
    process.stdout._handle.setBlocking(true);
  }
} catch { /* stdout may not have a handle */ }

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ISSUE_STATES = Object.freeze(['open', 'blocked']);
const EVIDENCE_VERSION = 1;
const GIT_SAFE = ['-c', 'safe.directory=*'];
let evidenceSequence = 0;

function isSharedDocument(repoRelativePath) {
  const p = String(repoRelativePath || '').replace(/\\/g, '/');
  return /^[^/]+\.md$/i.test(p) || /^docs\/.+\.md$/i.test(p);
}

function git(repoDir, args, options = {}) {
  const result = spawnSync('git', [...GIT_SAFE, ...args], {
    cwd: repoDir,
    encoding: options.buffer ? null : 'utf8',
    input: options.input,
    env: options.env || process.env,
    timeout: 120000,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  return result;
}

function gitText(repoDir, args, options) {
  const r = git(repoDir, args, options);
  if (r.status !== 0) {
    const detail = String(r.stderr || r.error || '').trim();
    throw new Error(`git ${args[0]} exited ${r.status}${detail ? `: ${detail}` : ''}`);
  }
  return String(r.stdout || '').trim();
}

function rev(repoDir, ref) {
  const answer = gitText(repoDir, ['rev-parse', '--verify', `${ref}^{commit}`]);
  if (!/^[0-9a-f]{40,64}$/.test(answer)) throw new Error(`ref ${ref} did not resolve to a commit`);
  return answer;
}

function lines(value) {
  return String(value || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

function changedPaths(repoDir, from, to) {
  return lines(gitText(repoDir, ['diff', '--name-only', from, to])).sort();
}

function taskFacts(repoDir, forkPoint, task) {
  if (!task || typeof task.issueId !== 'string' || typeof task.branch !== 'string') {
    throw new Error('each task must name issueId and branch');
  }
  const head = rev(repoDir, task.branch);
  const paths = changedPaths(repoDir, forkPoint, head);
  const productPaths = paths.filter((p) => !isSharedDocument(p));
  const sharedPaths = paths.filter(isSharedDocument);
  const commits = lines(gitText(repoDir, ['rev-list', head, `^${forkPoint}`]));
  let codeTip = null;
  let mixed = false;
  for (const commit of commits) {
    const parents = lines(gitText(repoDir, ['rev-list', '--parents', '-n', '1', commit]))[0].split(/\s+/);
    const parent = parents[1] || `${commit}^`;
    const own = changedPaths(repoDir, parent, commit);
    if (own.some(isSharedDocument) && own.some((p) => !isSharedDocument(p))) mixed = true;
    if (codeTip === null) {
      const cumulative = changedPaths(repoDir, forkPoint, commit);
      if (cumulative.length > 0 && cumulative.every((p) => !isSharedDocument(p))) codeTip = commit;
    }
  }
  if (mixed) codeTip = null;
  return { issueId: task.issueId, branch: task.branch, head, codeTip, mixed,
    productPaths, sharedPaths };
}

function mergeTree(repoDir, a, b, candidatePaths) {
  const r = git(repoDir, ['merge-tree', '--write-tree', '--name-only', a, b]);
  const output = String(r.stdout || '');
  const first = lines(output)[0] || '';
  const known = new Set(candidatePaths || []);
  const conflicts = lines(output).filter((line) => known.has(line)).sort();
  if (r.status === 0 && /^[0-9a-f]{40,64}$/.test(first)) {
    return { ok: true, ready: true, tree: first, conflicts: [], output };
  }
  if (r.status === 1 && /^[0-9a-f]{40,64}$/.test(first)) {
    return { ok: true, ready: false, tree: first, conflicts, output };
  }
  return { ok: false, ready: false, tree: null, conflicts,
    error: `git merge-tree exited ${r.status}: ${String(r.stderr || '').trim()}` };
}

function docsBranch(batch) {
  return `batch/${safeRefPart(batch)}/docs-integration`;
}

function rebaseBranch(batch, issueId) {
  return `batch/${safeRefPart(batch)}/rebase-${safeRefPart(issueId)}`;
}

function safeRefPart(value) {
  const part = String(value || '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]|[-.]$/g, '');
  return part || 'unnamed';
}

function plan({ repoDir, integrationBranch, batch, tasks }) {
  try {
    if (!Array.isArray(tasks) || tasks.length === 0) throw new Error('tasks must be a non-empty array');
    const integrationHead = rev(repoDir, integrationBranch);
    const heads = tasks.map((task) => rev(repoDir, task.branch));
    const forkPoint = gitText(repoDir, ['merge-base', '--octopus', ...heads]);
    const rows = tasks.map((task) => taskFacts(repoDir, forkPoint, task));
    const sharedCounts = new Map();
    for (const row of rows) for (const p of row.sharedPaths) sharedCounts.set(p, (sharedCounts.get(p) || 0) + 1);
    const sharedPaths = [...sharedCounts].filter(([, count]) => count > 1).map(([p]) => p).sort();
    const pairwise = [];
    for (let i = 0; i < rows.length; i += 1) {
      for (let j = i + 1; j < rows.length; j += 1) {
        const a = rows[i]; const b = rows[j];
        const candidates = [...new Set([...a.productPaths, ...a.sharedPaths,
          ...b.productPaths, ...b.sharedPaths])];
        const result = mergeTree(repoDir, a.head, b.head, candidates);
        if (!result.ok) throw new Error(result.error);
        pairwise.push({ a: a.issueId, b: b.issueId, ready: result.ready,
          sharedPaths: a.sharedPaths.filter((p) => b.sharedPaths.includes(p)).sort(),
          conflicts: result.conflicts });
      }
    }
    const branch = docsBranch(batch);
    const contributions = rows.filter((r) => r.sharedPaths.length > 0)
      .map((r) => ({ issueId: r.issueId, paths: [...r.sharedPaths] }));
    const required = contributions.length > 0;
    const codeSteps = rows.filter((r) => r.codeTip).map((r, position) => ({
      position: position + 1, kind: 'code', ref: r.codeTip, issueId: r.issueId, blockedBy: [],
    }));
    const reviewSequence = [...codeSteps];
    if (required) reviewSequence.push({ position: reviewSequence.length + 1,
      kind: 'docs-integration', ref: branch, blockedBy: codeSteps.map((s) => s.ref),
      contributions: contributions.map((c) => c.issueId) });
    return { ok: true, batch, integrationBranch, integrationHead, forkPoint, autoMerge: false,
      tasks: rows, sharedPaths, pairwise, reviewSequence,
      docsIntegration: { required, branch, contributions } };
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
}

function temporaryIndex() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-batch-index-'));
  return { dir, file: path.join(dir, 'index') };
}

function modeAt(repoDir, commit, file) {
  const line = String(git(repoDir, ['ls-tree', commit, '--', file]).stdout || '').trim();
  const match = line.match(/^(\d{6})\s/);
  return match ? match[1] : '100644';
}

function fileAt(repoDir, commit, file) {
  const r = git(repoDir, ['show', `${commit}:${file}`], { buffer: true });
  return r.status === 0 ? Buffer.from(r.stdout) : null;
}

function hashBlob(repoDir, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-batch-blob-'));
  const file = path.join(dir, 'content');
  try {
    fs.writeFileSync(file, content);
    return gitText(repoDir, ['hash-object', '-w', '--no-filters', file]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function treeWithFiles(repoDir, baseCommit, sourceCommit, files) {
  const temp = temporaryIndex();
  const env = { ...process.env, GIT_INDEX_FILE: temp.file };
  try {
    gitText(repoDir, ['read-tree', baseCommit], { env });
    for (const file of files) {
      const content = fileAt(repoDir, sourceCommit, file);
      if (content === null) {
        const r = git(repoDir, ['update-index', '--force-remove', '--', file], { env });
        if (r.status !== 0) throw new Error(`could not remove ${file} from temporary tree`);
      } else {
        const blob = hashBlob(repoDir, content);
        gitText(repoDir, ['update-index', '--add', '--cacheinfo', modeAt(repoDir, sourceCommit, file), blob, file], { env });
      }
    }
    return gitText(repoDir, ['write-tree'], { env });
  } finally {
    fs.rmSync(temp.dir, { recursive: true, force: true });
  }
}

function commitTree(repoDir, tree, parents, message) {
  const args = ['commit-tree', tree];
  for (const parent of parents) args.push('-p', parent);
  args.push('-m', message);
  return gitText(repoDir, args);
}

function replaceTreeFiles(repoDir, tree, replacements) {
  const temp = temporaryIndex();
  const env = { ...process.env, GIT_INDEX_FILE: temp.file };
  try {
    gitText(repoDir, ['read-tree', tree], { env });
    for (const [file, content] of replacements) {
      const blob = hashBlob(repoDir, content);
      gitText(repoDir, ['update-index', '--add', '--cacheinfo', '100644', blob, file], { env });
    }
    return gitText(repoDir, ['write-tree'], { env });
  } finally {
    fs.rmSync(temp.dir, { recursive: true, force: true });
  }
}

function appendResolution(repoDir, forkPoint, current, incoming, file) {
  const base = fileAt(repoDir, forkPoint, file);
  const left = fileAt(repoDir, current, file);
  const right = fileAt(repoDir, incoming, file);
  if (!base || !left || !right || left.equals(base) || right.equals(base)
      || !left.subarray(0, base.length).equals(base)
      || !right.subarray(0, base.length).equals(base)) return null;
  const leftTail = left.subarray(base.length);
  const rightTail = right.subarray(base.length);
  return Buffer.concat([base, leftTail, leftTail.equals(rightTail) ? Buffer.alloc(0) : rightTail]);
}

function evidenceDir({ repoDir }) {
  return path.resolve(process.env.PIPELINE_BATCH_EVIDENCE_DIR || path.join(repoDir, 'runs', 'merge-batch'));
}

function recordFailure(repoDir, data, deps) {
  const issues = data.issueIds.map((issueId) => ({ issueId, state: 'blocked', reason: data.reason }));
  const record = { version: EVIDENCE_VERSION, kind: data.kind, batch: data.batch,
    at: new Date().toISOString(), integrationBranch: data.integrationBranch,
    integrationHead: data.integrationHead, forkPoint: data.forkPoint,
    paths: [...new Set(data.paths)].sort(), tasks: data.tasks,
    issues, recover: data.recover };
  const dir = evidenceDir({ repoDir });
  fs.mkdirSync(dir, { recursive: true });
  evidenceSequence += 1;
  const name = `${Date.now()}-${process.pid}-${evidenceSequence}-${safeRefPart(data.kind)}-${safeRefPart(data.batch)}.json`;
  const destination = path.join(dir, name);
  const temp = `${destination}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' });
  fs.renameSync(temp, destination);
  if (deps && typeof deps.setIssueState === 'function') {
    for (const issue of issues) deps.setIssueState(issue.issueId, issue.state, issue.reason);
  }
  return { record, evidence: destination, issues };
}

function integrateDocs({ repoDir, integrationBranch, batch, tasks, deps }) {
  const planned = plan({ repoDir, integrationBranch, batch, tasks });
  if (!planned.ok) return planned;
  const contributions = planned.docsIntegration.contributions;
  let current = planned.integrationHead;
  let finalTree = gitText(repoDir, ['rev-parse', `${current}^{tree}`]);
  try {
    for (const contribution of contributions) {
      const row = planned.tasks.find((r) => r.issueId === contribution.issueId);
      const docsTree = treeWithFiles(repoDir, planned.forkPoint, row.head, contribution.paths);
      const docsCommit = commitTree(repoDir, docsTree, [planned.forkPoint],
        `Docs contribution from ${row.issueId}`);
      const candidates = [...new Set([...contribution.paths, ...planned.sharedPaths])];
      const merged = mergeTree(repoDir, current, docsCommit, candidates);
      if (!merged.ok) throw Object.assign(new Error(merged.error), { conflictPaths: candidates });
      let tree = merged.tree;
      if (!merged.ready) {
        const replacements = [];
        for (const file of merged.conflicts) {
          const resolved = appendResolution(repoDir, planned.forkPoint, current, row.head, file);
          if (!resolved) throw Object.assign(new Error(`document ${file} requires human reconciliation`),
            { conflictPaths: merged.conflicts });
          replacements.push([file, resolved]);
        }
        if (replacements.length !== merged.conflicts.length || replacements.length === 0) {
          throw Object.assign(new Error('merge conflict paths could not be identified safely'),
            { conflictPaths: merged.conflicts.length ? merged.conflicts : candidates });
        }
        tree = replaceTreeFiles(repoDir, tree, replacements);
      }
      current = commitTree(repoDir, tree, [current, docsCommit], `Combine docs from ${row.issueId}`);
      finalTree = tree;
    }
    const commit = commitTree(repoDir, finalTree, [planned.integrationHead],
      `Batch ${batch}: documentation integration`);
    const branch = planned.docsIntegration.branch;
    const update = git(repoDir, ['update-ref', `refs/heads/${branch}`, commit,
      '0'.repeat(planned.integrationHead.length)]);
    if (update.status !== 0) throw new Error(`could not create ${branch}: ${String(update.stderr || '').trim()}`);
    return { ok: true, branch, commit, contributions };
  } catch (error) {
    const paths = error.conflictPaths || planned.sharedPaths;
    const saved = recordFailure(repoDir, { kind: 'docs-reconciliation', batch,
      integrationBranch, integrationHead: planned.integrationHead, forkPoint: planned.forkPoint,
      paths, tasks: planned.tasks.map((r) => ({ issueId: r.issueId, branch: r.branch, head: r.head })),
      issueIds: planned.tasks.map((r) => r.issueId), reason: 'docs-reconciliation',
      recover: `Resolve ${paths.join(', ')} with every named contribution, then retry batch ${batch}.` }, deps);
    return { ok: false, reason: 'docs-reconciliation', paths, evidence: saved.evidence,
      issues: saved.issues, error: error.message || String(error) };
  }
}

function rebaseTask({ repoDir, integrationBranch, batch, task, deps }) {
  let integrationHead; let forkPoint; let row;
  try {
    integrationHead = rev(repoDir, integrationBranch);
    const head = rev(repoDir, task.branch);
    forkPoint = gitText(repoDir, ['merge-base', integrationHead, head]);
    row = taskFacts(repoDir, forkPoint, task);
    const candidates = [...row.productPaths, ...row.sharedPaths];
    const merged = mergeTree(repoDir, integrationHead, row.head, candidates);
    if (!merged.ok || !merged.ready) {
      const paths = merged.conflicts.length ? merged.conflicts : candidates;
      throw Object.assign(new Error(merged.error || `rebase conflicts in ${paths.join(', ')}`),
        { conflictPaths: paths });
    }
    const commit = commitTree(repoDir, merged.tree, [integrationHead], `Batch ${batch}: rebase ${task.issueId}`);
    const branch = rebaseBranch(batch, task.issueId);
    const update = git(repoDir, ['update-ref', `refs/heads/${branch}`, commit,
      '0'.repeat(integrationHead.length)]);
    if (update.status !== 0) throw new Error(`could not create ${branch}: ${String(update.stderr || '').trim()}`);
    return { ok: true, branch, commit };
  } catch (error) {
    const paths = error.conflictPaths || [];
    const head = row ? row.head : (() => { try { return rev(repoDir, task.branch); } catch { return ''; } })();
    const saved = recordFailure(repoDir, { kind: 'rebase', batch, integrationBranch,
      integrationHead: integrationHead || '', forkPoint: forkPoint || '', paths,
      tasks: [{ issueId: task.issueId, branch: task.branch, head }], issueIds: [task.issueId],
      reason: 'rebase', recover: `Resolve ${paths.join(', ') || 'the recorded conflict'} and retry ${task.issueId} onto ${integrationBranch}.` }, deps);
    return { ok: false, reason: 'rebase', paths, evidence: saved.evidence,
      issues: saved.issues, error: error.message || String(error) };
  }
}

function listEvidence({ repoDir }) {
  const dir = evidenceDir({ repoDir });
  let names;
  try { names = fs.readdirSync(dir).filter((name) => name.endsWith('.json')).sort(); }
  catch { return []; }
  const records = [];
  for (const name of names) {
    try { records.push(JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))); }
    catch { /* an interrupted temp or malformed foreign file is not evidence */ }
  }
  return records.sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')));
}

function renderReport(planResult) {
  if (!planResult || planResult.ok !== true) return `Batch merge plan failed: ${planResult && planResult.error || 'unknown error'}`;
  const out = [`# Batch ${planResult.batch}`, '', `Integration branch: ${planResult.integrationBranch}`,
    `Automatic merge: ${planResult.autoMerge}`, '', '## Pairwise merge readiness', ''];
  for (const pair of planResult.pairwise) {
    out.push(`- ${pair.a} + ${pair.b}: ${pair.ready ? 'ready' : 'conflict'}${pair.conflicts.length ? ` (${pair.conflicts.join(', ')})` : ''}`);
  }
  out.push('', '## Shared paths', '');
  if (planResult.sharedPaths.length === 0) out.push('- none');
  else for (const file of planResult.sharedPaths) out.push(`- ${file}`);
  out.push('', '## Review order', '');
  for (const step of planResult.reviewSequence) {
    const label = step.issueId || step.ref;
    out.push(`${step.position}. ${step.kind}: ${label}${step.blockedBy.length ? ` (after ${step.blockedBy.join(', ')})` : ''}`);
  }
  out.push('', '## Tasks', '');
  for (const task of planResult.tasks) out.push(`- ${task.issueId}: ${task.branch}`);
  return `${out.join('\n')}\n`;
}

module.exports = { ISSUE_STATES, EVIDENCE_VERSION, isSharedDocument, plan, integrateDocs,
  rebaseTask, renderReport, evidenceDir, listEvidence };
