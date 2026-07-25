// Per-task workspace preparation — DESIGN.md §4.2, §4.10 (T13).
// The host supplies the repo: a fresh clone from the GitHub remote (so every branch
// forks from canonical main), a task branch, `.run/` excluded from commits, and the
// issue exported read-only for the container. The container never talks to a git host.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const git = (cwd, args, opts = {}) =>
  spawnSync('git', args, { cwd, encoding: 'utf8', ...opts });

// Branch naming (§4.2): task/<issue-id>, suffixed -r2, -r3, … when the branch already
// exists on the remote (a re-run after a spec fix). Never force-push, so earlier
// attempts survive.
function chooseBranch(cloneDir, issueId) {
  const base = `task/${issueId}`;
  const ls = git(cloneDir, ['ls-remote', '--heads', 'origin', `${base}*`]);
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

  // Fresh clone from the remote every task (§4.2): canonical main, no stale local state.
  const clone = spawnSync('git', ['clone', '--quiet', cfg.targetRepoRemote, dir], { encoding: 'utf8' });
  if (clone.status !== 0) {
    return { ok: false, reason: `clone failed: ${(clone.stderr || '').trim()}` };
  }

  let branch;
  try {
    branch = chooseBranch(dir, issueId);
  } catch (e) {
    return { ok: false, reason: e.message };
  }
  if (branch !== `task/${issueId}`) {
    log.info(traceId, `branch task/${issueId} exists on the remote; using ${branch} (never force-pushing)`);
  }

  const co = git(dir, ['checkout', '-q', '-b', branch, 'origin/main']);
  if (co.status !== 0) {
    return { ok: false, reason: `branch creation failed: ${(co.stderr || '').trim()}` };
  }

  // Contract artifacts never enter commits (§4.10). The entrypoint also does this;
  // belt and braces, because a leaked .run/ would pollute every PR.
  const excludeFile = path.join(dir, '.git', 'info', 'exclude');
  fs.appendFileSync(excludeFile, '\n.run/\n');

  // The container's inputs: issue spec at .run/issue.md (§4.10).
  const runDir = path.join(dir, '.run');
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'issue.md'), issueMarkdown);

  const forkPoint = git(dir, ['rev-parse', 'HEAD']).stdout.trim();
  log.info(traceId, `workspace ready: ${dir} on ${branch} (fork point ${forkPoint.slice(0, 8)})`);
  return { ok: true, dir, branch, forkPoint };
}

// Does the branch have commits beyond the fork point? (§4.5: push only what exists.)
function hasCommits(dir, forkPoint) {
  const r = git(dir, ['rev-list', '--count', `${forkPoint}..HEAD`]);
  return r.status === 0 && Number((r.stdout || '0').trim()) > 0;
}

// Collect the container's contract artifacts into the run log folder (§4.12) before
// the workspace is discarded.
function collectArtifacts(dir, taskDir) {
  const out = { status: null, verify: null };
  for (const name of ['status.json', 'verify.json']) {
    const src = path.join(dir, '.run', name);
    if (!fs.existsSync(src)) continue;
    const raw = fs.readFileSync(src, 'utf8');
    fs.writeFileSync(path.join(taskDir, name), raw);
    try {
      out[name.replace('.json', '')] = JSON.parse(raw);
    } catch {
      /* best-effort: a timeout kill can leave a half-written file (§4.11) */
    }
  }
  for (const f of ['agent-1.log', 'agent-2.log', 'agent-3.log', 'docs-out.txt']) {
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

module.exports = { prepare, chooseBranch, hasCommits, collectArtifacts, discard };
