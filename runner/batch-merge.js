'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// A short-lived node reader can otherwise exit before a Windows pipe shim flushes stdout.
// Replace the async pipe writer at module load: callers resolve stdout.write before evaluating
// its argument, and setBlocking on the parent's libuv handle breaks nested spawnSync readers.
if (process.stdout && !process.stdout.__pipelineBlockingWrite) {
  process.stdout.write = function blockingWrite(chunk, encoding, callback) {
    let cb = callback; let enc = encoding;
    if (typeof enc === 'function') { cb = enc; enc = undefined; }
    fs.writeSync(1, Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), enc || 'utf8'));
    if (typeof cb === 'function') cb();
    return true;
  };
  Object.defineProperty(process.stdout, '__pipelineBlockingWrite', { value: true });
}

const ISSUE_STATES = Object.freeze(['open', 'blocked']);
const EVIDENCE_VERSION = 1;
const GIT_SAFE = ['-c', 'core.hooksPath=', '-c', 'commit.gpgsign=false'];
const TIMEOUT_MS = 120000;

function isSharedDocument(repoRelativePath) {
  const p = String(repoRelativePath || '').split(path.sep).join('/');
  return /^[^/]+\.md$/.test(p) || /^docs\/.+\.md$/.test(p);
}

function git(repoDir, args, options = {}) {
  return spawnSync('git', [...GIT_SAFE, ...args], {
    cwd: repoDir,
    encoding: options.encoding || 'utf8',
    input: options.input,
    env: options.env || process.env,
    timeout: options.timeout || TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
}

function gitText(repoDir, args, what, options) {
  const result = git(repoDir, args, options);
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim();
    throw new Error(`${what} failed (git exited ${result.status})${detail ? `: ${detail}` : ''}`);
  }
  return String(result.stdout || '').trim();
}

function resolveCommit(repoDir, ref, label) {
  const value = gitText(repoDir, ['rev-parse', '--verify', `${ref}^{commit}`], label);
  if (!/^[0-9a-f]{40,64}$/.test(value)) throw new Error(`${label} did not resolve to a commit`);
  return value;
}

function lines(value) {
  return String(value || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

function changedPaths(repoDir, from, to) {
  return lines(gitText(repoDir, ['diff', '--name-only', from, to], `diff ${from}..${to}`)).sort();
}

function commonFork(repoDir, heads) {
  if (!heads.length) throw new Error('a batch needs at least one task');
  return resolveCommit(repoDir,
    gitText(repoDir, ['merge-base', '--octopus', ...heads], 'find the batch fork point'),
    'batch fork point');
}

function conflictsFromMergeTree(output) {
  const all = lines(output);
  if (all.length <= 1) return [];
  const candidates = [];
  for (const line of all.slice(1)) {
    if (/^(Auto-merging|CONFLICT|warning:|hint:)/i.test(line)) continue;
    if (/^[0-9a-f]{40,64}$/.test(line)) continue;
    if (!line.includes('\0') && !/^(?:changed in both|added in both|removed in)/i.test(line)) {
      candidates.push(line);
    }
  }
  return [...new Set(candidates)].sort();
}

function mergeTree(repoDir, first, second, ephemeral = false) {
  let objectHome = null; let env = process.env;
  if (ephemeral) {
    objectHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-batch-objects-'));
    const objects = path.join(objectHome, 'objects');
    fs.mkdirSync(objects);
    const realObjects = path.resolve(repoDir,
      gitText(repoDir, ['rev-parse', '--git-path', 'objects'], 'locate repository objects'));
    env = { ...process.env, GIT_OBJECT_DIRECTORY: objects,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: realObjects };
  }
  try {
    const result = git(repoDir, ['merge-tree', '--write-tree', '--name-only', first, second], { env });
    if (result.status !== 0 && result.status !== 1) {
      throw new Error(`merge simulation failed (git exited ${result.status}): ${String(result.stderr || '').trim()}`);
    }
    const out = String(result.stdout || '');
    return {
      ready: result.status === 0,
      tree: (out.split(/\r?\n/)[0] || '').trim(),
      conflicts: result.status === 1 ? conflictsFromMergeTree(out) : [],
    };
  } finally {
    if (objectHome) fs.rmSync(objectHome, { recursive: true, force: true });
  }
}

function docsBranch(batch) {
  return `batch/${String(batch).replace(/[^A-Za-z0-9._-]+/g, '-')}/docs-integration`;
}

function rebaseBranch(batch, issueId) {
  return `batch/${String(batch).replace(/[^A-Za-z0-9._-]+/g, '-')}/rebase-${String(issueId).replace(/[^A-Za-z0-9._-]+/g, '-')}`;
}

function newestCodeTip(repoDir, forkPoint, head) {
  const commits = lines(gitText(repoDir, ['rev-list', head, `^${forkPoint}`], 'inspect task commits'));
  for (const commit of commits) {
    const paths = changedPaths(repoDir, forkPoint, commit);
    if (paths.length && paths.every((p) => !isSharedDocument(p))) return commit;
  }
  return null;
}

function inspectBatch({ repoDir, integrationBranch, batch, tasks }) {
  if (!repoDir || !integrationBranch || !batch || !Array.isArray(tasks) || !tasks.length) {
    throw new Error('repoDir, integrationBranch, batch, and a non-empty tasks array are required');
  }
  const integrationHead = resolveCommit(repoDir, integrationBranch, 'integration branch');
  const resolved = tasks.map((task) => {
    if (!task || !task.issueId || !task.branch) throw new Error('every task needs issueId and branch');
    return { issueId: String(task.issueId), branch: String(task.branch), head: resolveCommit(repoDir, task.branch, `task ${task.issueId}`) };
  });
  // Include integration so a one-task rebase still finds the task's fork point rather than
  // treating the task head itself as the common ancestor.
  const forkPoint = commonFork(repoDir, [integrationHead, ...resolved.map((task) => task.head)]);
  const rows = resolved.map((task) => {
    const allPaths = changedPaths(repoDir, forkPoint, task.head);
    const productPaths = allPaths.filter((p) => !isSharedDocument(p));
    const sharedPaths = allPaths.filter(isSharedDocument);
    const codeTip = newestCodeTip(repoDir, forkPoint, task.head);
    return { ...task, codeTip, mixed: productPaths.length > 0 && sharedPaths.length > 0 && !codeTip,
      productPaths, sharedPaths };
  });
  return { repoDir, batch: String(batch), integrationBranch: String(integrationBranch),
    integrationHead, forkPoint, tasks: rows };
}

function plan(args) {
  try {
    const batch = inspectBatch(args);
    const counts = new Map();
    for (const task of batch.tasks) for (const p of task.sharedPaths) counts.set(p, (counts.get(p) || 0) + 1);
    const sharedPaths = [...counts].filter(([, count]) => count > 1).map(([p]) => p).sort();
    const pairwise = [];
    for (let i = 0; i < batch.tasks.length; i += 1) {
      for (let j = i + 1; j < batch.tasks.length; j += 1) {
        const a = batch.tasks[i]; const b = batch.tasks[j];
        const simulated = mergeTree(batch.repoDir, a.head, b.head, true);
        pairwise.push({
          a: a.issueId, b: b.issueId, ready: simulated.ready,
          sharedPaths: a.sharedPaths.filter((p) => b.sharedPaths.includes(p)).sort(),
          conflicts: simulated.conflicts,
        });
      }
    }
    const contributions = batch.tasks.filter((task) => task.sharedPaths.length).map((task) => ({
      issueId: task.issueId, paths: task.sharedPaths.slice(),
    }));
    const branch = docsBranch(batch.batch);
    const codeSteps = batch.tasks.filter((task) => task.codeTip).map((task, position) => ({
      position: position + 1, kind: 'code', ref: task.codeTip, blockedBy: [], issueId: task.issueId,
    }));
    const reviewSequence = codeSteps.slice();
    if (contributions.length) reviewSequence.push({
      position: reviewSequence.length + 1, kind: 'docs-integration', ref: branch,
      blockedBy: codeSteps.map((step) => step.ref), contributions,
    });
    return { ok: true, batch: batch.batch, integrationBranch: batch.integrationBranch,
      integrationHead: batch.integrationHead, forkPoint: batch.forkPoint, autoMerge: false,
      tasks: batch.tasks.map(({ issueId, branch: taskBranch, head, codeTip, mixed, productPaths, sharedPaths: taskShared }) =>
        ({ issueId, branch: taskBranch, head, codeTip, mixed, productPaths, sharedPaths: taskShared })),
      sharedPaths, pairwise, reviewSequence,
      docsIntegration: { required: contributions.length > 0, branch, contributions } };
  } catch (error) {
    return { ok: false, error: error.message || String(error) };
  }
}

function readBlob(repoDir, commit, rel) {
  const result = git(repoDir, ['show', `${commit}:${rel}`]);
  if (result.status === 0) return String(result.stdout || '');
  if (result.status === 128 && !result.error) return null;
  throw new Error(`read ${rel} from ${commit} failed (git exited ${result.status}): ${String(result.stderr || '').trim()}`);
}

function mergeFile(repoDir, current, base, incoming) {
  if (current === incoming) return { ok: true, content: current };
  if (current === base) return { ok: true, content: incoming };
  if (incoming === base) return { ok: true, content: current };
  // Concurrent append-only edits are losslessly ordered by task order. Unlike merge=union,
  // this narrow rule cannot duplicate two competing replacements of an existing line.
  if (current !== null && base !== null && incoming !== null
      && current.startsWith(base) && incoming.startsWith(base)) {
    return { ok: true, content: base + current.slice(base.length) + incoming.slice(base.length) };
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-doc-merge-'));
  try {
    const ours = path.join(dir, 'ours'); const ancestor = path.join(dir, 'base');
    const theirs = path.join(dir, 'theirs');
    fs.writeFileSync(ours, current === null ? '' : current);
    fs.writeFileSync(ancestor, base === null ? '' : base);
    fs.writeFileSync(theirs, incoming === null ? '' : incoming);
    const result = spawnSync('git', ['merge-file', '-p', ours, ancestor, theirs], {
      encoding: 'utf8', timeout: TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, windowsHide: true,
    });
    if (result.status === 0) return { ok: true, content: String(result.stdout || '') };
    if (result.status === 1) return { ok: false };
    throw new Error(`git merge-file failed (exit ${result.status}): ${String(result.stderr || '').trim()}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function tempIndex(repoDir, startCommit, work) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-batch-index-'));
  const index = path.join(dir, 'index');
  const env = { ...process.env, GIT_INDEX_FILE: index };
  try {
    gitText(repoDir, ['read-tree', startCommit], 'seed temporary index', { env });
    return work(env);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function treeWithFiles(repoDir, startCommit, files) {
  return tempIndex(repoDir, startCommit, (env) => {
    let blobSequence = 0;
    for (const [rel, content] of files) {
      if (content === null) {
        gitText(repoDir, ['update-index', '--force-remove', '--', rel], `remove ${rel}`, { env });
      } else {
        // Do not use hash-object --stdin here. This module deliberately makes stdout blocking
        // for short-lived readers; on the managed Windows pipe shim that can prevent a
        // spawnSync child from observing EOF on its input pipe.
        blobSequence += 1;
        const blobFile = path.join(path.dirname(env.GIT_INDEX_FILE), `blob-${blobSequence}`);
        fs.writeFileSync(blobFile, content);
        const blob = gitText(repoDir, ['hash-object', '-w', blobFile], `write ${rel}`, { env });
        gitText(repoDir, ['update-index', '--add', '--cacheinfo', `100644,${blob},${rel}`], `stage ${rel}`, { env });
      }
    }
    return gitText(repoDir, ['write-tree'], 'write docs integration tree', { env });
  });
}

function commitTree(repoDir, tree, parents, message) {
  const args = ['commit-tree', tree];
  for (const parent of parents) args.push('-p', parent);
  args.push('-m', message);
  return gitText(repoDir, args, 'create review commit');
}

function evidenceDir({ repoDir }) {
  return path.resolve(process.env.PIPELINE_BATCH_EVIDENCE_DIR || path.join(repoDir, 'runs', 'merge-batch'));
}

let evidenceSequence = 0;
function writeEvidence(repoDir, record) {
  const dir = evidenceDir({ repoDir });
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString();
  const safeBatch = String(record.batch).replace(/[^A-Za-z0-9._-]+/g, '-');
  let file;
  do {
    evidenceSequence += 1;
    file = path.join(dir, `${stamp.replace(/[:.]/g, '-')}-${safeBatch}-${record.kind}-${process.pid}-${evidenceSequence}.json`);
  } while (fs.existsSync(file));
  const complete = { version: EVIDENCE_VERSION, ...record, at: stamp };
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(complete, null, 2)}\n`, { flag: 'wx' });
  fs.renameSync(temp, file);
  return file;
}

function failure(batch, kind, paths, tasks, deps, error) {
  const reason = kind === 'rebase' ? 'rebase' : 'docs-reconciliation';
  const message = String(error || `${reason} could not be completed`);
  const issues = tasks.map((task) => ({ issueId: task.issueId, state: 'blocked', reason: message }));
  const evidence = writeEvidence(batch.repoDir, {
    kind, batch: batch.batch, integrationBranch: batch.integrationBranch,
    integrationHead: batch.integrationHead, forkPoint: batch.forkPoint,
    paths: [...new Set(paths)].sort(),
    tasks: tasks.map(({ issueId, branch, head }) => ({ issueId, branch, head })), issues,
    recover: kind === 'rebase'
      ? `Resolve ${paths.join(', ') || 'the named conflict'} and retry rebaseTask for ${tasks[0].issueId}.`
      : `Reconcile ${paths.join(', ') || 'the named documents'} with both contributors, then retry integrateDocs.`,
  });
  const stateErrors = [];
  if (deps && typeof deps.setIssueState === 'function') {
    for (const issue of issues) {
      try { deps.setIssueState(issue.issueId, issue.state, issue.reason); }
      catch (stateError) { stateErrors.push(`${issue.issueId}: ${stateError.message || stateError}`); }
    }
  }
  return { ok: false, reason, paths: [...new Set(paths)].sort(), evidence, issues,
    error: stateErrors.length ? `${message}; issue-state update failed (${stateErrors.join('; ')})` : message };
}

function integrateDocs(args) {
  let batch;
  try {
    batch = inspectBatch(args);
    const files = new Map(); const conflicts = [];
    const allPaths = [...new Set(batch.tasks.flatMap((task) => task.sharedPaths))].sort();
    for (const rel of allPaths) {
      const base = readBlob(batch.repoDir, batch.forkPoint, rel);
      // Integration may have moved since the sibling fork. Treat its current document as the
      // first contributor so a docs branch cannot silently overwrite already-landed prose.
      let current = readBlob(batch.repoDir, batch.integrationHead, rel);
      for (const task of batch.tasks) {
        if (!task.sharedPaths.includes(rel)) continue;
        const merged = mergeFile(batch.repoDir, current, base, readBlob(batch.repoDir, task.head, rel));
        if (!merged.ok) { conflicts.push(rel); break; }
        current = merged.content;
      }
      if (!conflicts.includes(rel)) files.set(rel, current);
    }
    if (conflicts.length) return failure(batch, 'docs-reconciliation', conflicts, batch.tasks, args.deps,
      `docs reconciliation conflicted in ${conflicts.join(', ')}`);
    const branch = docsBranch(batch.batch);
    const fullRef = `refs/heads/${branch}`;
    if (git(batch.repoDir, ['show-ref', '--verify', '--quiet', fullRef]).status === 0) {
      return failure(batch, 'docs-reconciliation', allPaths, batch.tasks, args.deps,
        `review branch ${branch} already exists; inspect it before retrying`);
    }
    const tree = treeWithFiles(batch.repoDir, batch.integrationHead, files);
    const commit = commitTree(batch.repoDir, tree, [batch.integrationHead], `Batch ${batch.batch}: docs integration`);
    gitText(batch.repoDir, ['update-ref', fullRef, commit, '0000000000000000000000000000000000000000'],
      'create docs integration branch');
    return { ok: true, branch, commit,
      contributions: batch.tasks.filter((task) => task.sharedPaths.length)
        .map((task) => ({ issueId: task.issueId, paths: task.sharedPaths.slice() })) };
  } catch (error) {
    if (!batch) return { ok: false, reason: 'docs-reconciliation', paths: [], evidence: null, issues: [], error: error.message || String(error) };
    return failure(batch, 'docs-reconciliation', [], batch.tasks, args.deps, error.message || String(error));
  }
}

function rebaseTask(args) {
  let batch;
  try {
    batch = inspectBatch({ ...args, tasks: [args.task] });
    const task = batch.tasks[0];
    const commits = lines(gitText(batch.repoDir, ['rev-list', '--reverse', task.head, `^${batch.forkPoint}`],
      'list task commits'));
    let current = batch.integrationHead;
    for (const original of commits) {
      const simulated = mergeTree(batch.repoDir, current, original);
      if (!simulated.ready) return failure(batch, 'rebase', simulated.conflicts, [task], args.deps,
        `rebase conflicted in ${simulated.conflicts.join(', ') || 'an unnamed path'}`);
      current = commitTree(batch.repoDir, simulated.tree, [current],
        gitText(batch.repoDir, ['log', '-1', '--format=%B', original], 'read task commit message'));
    }
    const branch = rebaseBranch(batch.batch, task.issueId);
    const fullRef = `refs/heads/${branch}`;
    gitText(batch.repoDir, ['update-ref', fullRef, current, '0000000000000000000000000000000000000000'],
      'create rebased review branch');
    return { ok: true, branch, commit: current };
  } catch (error) {
    if (!batch) return { ok: false, reason: 'rebase', paths: [], evidence: null, issues: [], error: error.message || String(error) };
    return failure(batch, 'rebase', [], batch.tasks.slice(0, 1), args.deps, error.message || String(error));
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
    catch { /* An interrupted temporary or malformed unrelated file is not evidence. */ }
  }
  return records.sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')));
}

function renderReport(batchPlan) {
  if (!batchPlan || batchPlan.ok !== true) return `# Batch merge report\n\nUnable to plan: ${batchPlan && batchPlan.error ? batchPlan.error : 'unknown error'}\n`;
  const out = [`# Batch merge report: ${batchPlan.batch}`, '',
    `Integration: \`${batchPlan.integrationBranch}\` at \`${batchPlan.integrationHead}\``, '',
    '## Pairwise merge readiness', ''];
  if (!batchPlan.pairwise.length) out.push('- No task pairs.');
  for (const pair of batchPlan.pairwise) out.push(
    `- ${pair.a} + ${pair.b}: **${pair.ready ? 'ready' : 'conflict'}**${pair.conflicts.length ? ` — ${pair.conflicts.join(', ')}` : ''}`);
  out.push('', '## Shared paths', '');
  if (!batchPlan.sharedPaths.length) out.push('- None.');
  else for (const rel of batchPlan.sharedPaths) out.push(`- \`${rel}\``);
  out.push('', '## Required review order', '');
  for (const step of batchPlan.reviewSequence) {
    const label = step.issueId || 'docs-integration';
    const blocked = step.blockedBy.length ? `; after ${step.blockedBy.map((r) => `\`${r}\``).join(', ')}` : '; no prerequisite';
    out.push(`${step.position}. ${label} (${step.kind}) — \`${step.ref}\`${blocked}`);
  }
  out.push('', 'No automatic merge is performed.', '');
  return out.join('\n');
}

module.exports = {
  ISSUE_STATES,
  EVIDENCE_VERSION,
  isSharedDocument,
  plan,
  integrateDocs,
  rebaseTask,
  renderReport,
  evidenceDir,
  listEvidence,
};
