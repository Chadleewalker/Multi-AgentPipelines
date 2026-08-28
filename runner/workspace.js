// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// Per-task workspace preparation — DESIGN.md §4.2, §4.10 (T13).
// The host supplies the repo: a fresh clone from the GitHub remote (so every branch
// forks from canonical main), a task branch, `.run/` excluded from commits, and the
// issue exported read-only for the container. The container never talks to a git host.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseArtifact } = require('./artifact-schema');
const { exportMemory } = require('./memory');
const { runSync, failureText } = require('./process');

const git = (cfg, cwd, args, opts = {}) =>
  runSync('git', args, { cfg, kind: 'git', cwd, label: `git ${args[0]}`, ...opts });

// The project's integration branch (§4.2). Explicit `defaultBranch` in
// pipeline.config.json wins; otherwise ask the remote what its HEAD is (repos are
// `master` as often as `main`); "main" only as a last resort.
function detectDefaultBranch(dir, cfg) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'pipeline.config.json'), 'utf8'));
    if (cfg.defaultBranch) return cfg.defaultBranch;
  } catch { /* no config, or not readable yet */ }
  const r = git(cfg, dir, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  if (r.timedOut) throw new Error(failureText(r, 'git symbolic-ref failed'));
  if (r.status === 0) {
    const name = (r.stdout || '').trim().replace(/^origin\//, '');
    if (name) return name;
  }
  return 'main';
}

// Publication policy is read from the fork-point blob, never the agent-editable working
// tree. `required` means an exact regression PASS is part of settlement; every older config
// remains the historic evidence-only policy.
function regressionPolicyAt(dir, forkPoint, cfg) {
  const r = git(cfg, dir, ['show', `${forkPoint}:pipeline.config.json`]);
  if (r.timedOut) throw new Error(failureText(r, 'git show failed'));
  if (r.status !== 0) return 'evidence';
  try {
    const cfg = JSON.parse(r.stdout || '{}');
    return cfg.regressionPolicy === 'required' ? 'required' : 'evidence';
  } catch {
    return 'evidence';
  }
}

// Branch naming (§4.2): task/<issue-id>, suffixed -r2, -r3, … when the branch already
// exists on the remote (a re-run after a spec fix). Never force-push, so earlier
// attempts survive.
function chooseBranch(cloneDir, issueId, cfg) {
  const base = `task/${issueId}`;
  const ls = git(cfg, cloneDir, ['ls-remote', '--heads', 'origin', `${base}*`]);
  if (ls.status !== 0) {
    throw new Error(`cannot list existing task branches: ${failureText(ls, 'git ls-remote failed')}`);
  }
  const existing = new Set(
    (ls.stdout || '')
      .split('\n')
      .map((l) => l.split('refs/heads/')[1])
      .filter(Boolean)
      .map((s) => s.trim())
  );
  if (!existing.has(base)) return base;
  for (let n = 2; n < 100; n++) {
    const candidate = `${base}-r${n}`;
    if (!existing.has(candidate)) return candidate;
  }
  throw new Error(`no free branch name for ${base} (checked -r2..-r99)`);
}

// Prepare one task's workspace. Returns {ok, dir, branch, forkPoint} or {ok:false,reason}.
function prepare(cfg, issueId, issueMarkdown, log, traceId) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pipeline-${issueId}-`));
  const fail = (reason) => { discard(dir); return { ok: false, reason }; };

  try {
    // Fresh clone from the remote every task (§4.2): canonical main, no stale local state.
    // Force LF: this workspace exists only to be bind-mounted into a Linux container, and
    // a Windows host's autocrlf would make every file differ from its blob inside the
    // container — which the verifier's tamper diff would (correctly) read as tampering.
    const clone = git(cfg, undefined, [
      '-c', 'core.autocrlf=false', '-c', 'core.eol=lf',
      'clone', '--quiet', cfg.targetRepoRemote, dir,
    ], { label: 'git clone' });
    if (clone.status !== 0) return fail(`clone failed: ${failureText(clone, 'git clone failed')}`);

    const branch = chooseBranch(dir, issueId, cfg);
    if (branch !== `task/${issueId}`) {
      log.info(traceId, `branch task/${issueId} exists on the remote; using ${branch} (never force-pushing)`);
    }

    const defaultBranch = detectDefaultBranch(dir, cfg);
    const co = git(cfg, dir, ['checkout', '-q', '-b', branch, `origin/${defaultBranch}`]);
    if (co.status !== 0) {
      return fail(`branch creation failed off origin/${defaultBranch}: ${failureText(co, 'git checkout failed')}`);
    }
    log.info(traceId, `integration branch: ${defaultBranch}`);

    // Contract artifacts never enter commits (§4.10). The entrypoint also does this;
    // belt and braces, because a leaked .run/ would pollute every PR.
    const excludeFile = path.join(dir, '.git', 'info', 'exclude');
    fs.appendFileSync(excludeFile, '\n.run/\n');

    // The container's inputs: issue spec at .run/issue.md, project memory at
    // .run/memory.md (§4.10, §3.6). Both are read-only by contract, not by permission.
    const runDir = path.join(dir, '.run');
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'issue.md'), issueMarkdown);

    // Memory is a convenience input, not a precondition: a failed export is logged and
    // the run continues with the "(no memories recorded)" marker in place (§3.6).
    const mem = exportMemory(cfg, runDir);
    if (!mem.ok) log.info(traceId, `memory export failed (continuing): ${mem.error}`);
    else if (mem.count) log.info(traceId, `memory: exported ${mem.count} note(s) to .run/memory.md`);
    else log.info(traceId, 'memory: no notes recorded yet — container gets the empty marker');

    const fork = git(cfg, dir, ['rev-parse', 'HEAD']);
    const forkPoint = String(fork.stdout || '').trim();
    if (fork.status !== 0 || !/^[0-9a-f]{40,64}$/i.test(forkPoint)) {
      return fail(`cannot resolve workspace fork point: ${failureText(fork, 'git rev-parse failed')}`);
    }
    const regressionPolicy = regressionPolicyAt(dir, forkPoint, cfg);
    log.info(traceId, `workspace ready: ${dir} on ${branch} (fork point ${forkPoint.slice(0, 8)})`,
      { event: 'workspace.ready', data: { dir, branch, forkPoint } });
    return {
      ok: true,
      dir,
      branch,
      forkPoint,
      defaultBranch,
      regressionPolicy,
      memoryCount: mem.ok ? mem.count : null,
    };
  } catch (e) {
    return fail(e && e.message ? e.message : String(e));
  }
}

// Does the branch have commits beyond the fork point? (§4.5: push only what exists.)
function hasCommits(dir, forkPoint, cfg) {
  const r = git(cfg, dir, ['rev-list', '--count', `${forkPoint}..HEAD`]);
  if (r.status !== 0) throw new Error(`cannot determine whether ${forkPoint.slice(0, 12)}..HEAD has commits: ${failureText(r, 'git rev-list failed')}`);
  return Number((r.stdout || '0').trim()) > 0;
}

// Collect the container's contract artifacts into the run log folder (§4.12) before
// the workspace is discarded.
function collectArtifacts(dir, taskDir, expectedIssueId) {
  const out = {
    status: null,
    verify: null,
    contracts: {
      status: parseArtifact('status', null, expectedIssueId),
      verify: parseArtifact('verify', null, expectedIssueId),
    },
  };
  for (const name of ['status.json', 'verify.json']) {
    const kind = name.replace('.json', '');
    const src = path.join(dir, '.run', name);
    if (!fs.existsSync(src)) continue;
    const raw = fs.readFileSync(src, 'utf8');
    fs.writeFileSync(path.join(taskDir, name), raw);
    const contract = parseArtifact(kind, raw, expectedIssueId);
    out.contracts[kind] = contract;
    // Invalid bytes remain copied into the run's evidence directory, but no consumer sees
    // them as a structured artifact. A timeout can still leave a half-write; it is now a
    // named `malformed` contract state rather than an advisory null.
    if (contract.ok) out[kind] = contract.value;
  }
  // memory.md is an INPUT, collected so a finished run still shows what the container
  // was actually told (§3.6) — without it the In channel can only be inspected with
  // --keep, on a workspace that no longer exists. docs-err.txt is the docs phase's
  // stderr, split out by repo-52m and never collected until now.
  for (const f of ['agent-1.log', 'agent-2.log', 'agent-3.log', 'docs-out.txt', 'docs-err.txt', 'memory.md']) {
    const src = path.join(dir, '.run', f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(taskDir, f));
  }
  return out;
}

function discard(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows can hold locks briefly; the temp dir is disposable either way */
  }
}

module.exports = {
  prepare, chooseBranch, hasCommits, collectArtifacts, discard, regressionPolicyAt,
};
