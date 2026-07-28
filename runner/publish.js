// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// Push and PR creation — DESIGN.md §4.5, §4.11 (T16).
// The host holds every credential: the container never pushes. Push whenever the branch
// has commits (so stuck/tampered/failed work survives for review); open a PR only for
// verified success (exit 0 — "done" and "partial" alike, with partial flagged).
'use strict';
const { spawnSync } = require('child_process');
const { specConcerns, oneLine } = require('./concerns');

const git = (dir, args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });

// Never force: an earlier attempt's branch must survive (§4.2 gives re-runs a -rN name).
function pushBranch(dir, branch, log, traceId) {
  const r = git(dir, ['push', '--set-upstream', 'origin', branch]);
  if (r.status !== 0) {
    const err = (r.stderr || '').trim();
    log.error(traceId, `push failed for ${branch}: ${err}`);
    return { ok: false, error: err };
  }
  log.info(traceId, `pushed ${branch}`);
  return { ok: true };
}

// The PR body is assembled by the HOST from structured artifacts only — the issue spec,
// the docs-phase change summary, and the verifier evidence. No free-form agent prose is
// parsed (§4.5, §4.11).
function buildPrBody({ issueMarkdown, status, verify, outcome, branch, runId }) {
  const lines = [];
  lines.push('## Spec');
  lines.push('');
  lines.push((issueMarkdown || '(issue spec unavailable)').trim());
  lines.push('');
  lines.push('## Change summary');
  lines.push('');
  lines.push(((status && status.changeSummary) || '(no change summary produced)').trim());
  lines.push('');
  // Spec concerns after the change summary (§3.7): a reviewer reads what the task claims
  // to have done, then what the agent says is wrong with the task itself. Bounded by
  // concerns.js. This never decided whether this PR exists — that is §4.5's rule alone.
  const raised = specConcerns(status);
  if (raised.length) {
    lines.push('## Spec concerns');
    lines.push('');
    lines.push('The agent reported that the frozen spec or its tests may themselves be ' +
      'wrong (DESIGN.md §3.7). This is **evidence only**: it changed no outcome, no exit ' +
      'code and no Beads transition, and it did not decide whether this PR was opened. ' +
      'Changing a spec is a decision for the reviewer.');
    lines.push('');
    for (const c of raised) lines.push(`- ${oneLine(c)}`);
    lines.push('');
  }
  lines.push('## Verification evidence');
  lines.push('');
  if (verify) {
    lines.push(`- Acceptance tests: **${verify.acceptance}**`);
    lines.push(`- Regression suite: **${verify.regressions}**`);
    if (verify.acceptanceOutput) {
      lines.push('');
      lines.push('<details><summary>Acceptance output</summary>');
      lines.push('');
      lines.push('```');
      lines.push(String(verify.acceptanceOutput).slice(-3000).trim());
      lines.push('```');
      lines.push('');
      lines.push('</details>');
    }
  } else {
    lines.push('- (no verifier evidence collected)');
  }
  if (outcome.status === 'partial') {
    lines.push('');
    lines.push('> **PARTIAL — needs scrutiny.** Acceptance tests passed but the project\'s ' +
      'regression suite failed. Acceptance is the gate (DESIGN.md §4.4), so this task is ' +
      'complete by contract, but the regressions above should be reviewed before merging.');
  }
  const attempts = (status && status.attempts) || [];
  if (attempts.length > 1) {
    lines.push('');
    lines.push(`_Verified on attempt ${attempts.length} of 3._`);
  }
  lines.push('');
  lines.push(`_Pipeline run \`${runId}\` · branch \`${branch}\` · generated, do not edit._`);
  return lines.join('\n');
}

// `gh` is the documented host tool (§6). PIPELINE_GH_CMD is a test seam so suites can
// verify PR assembly against a local bare remote without touching a live GitHub.
function openPr(dir, { branch, title, body, baseBranch, log, traceId }) {
  const ghCmd = process.env.PIPELINE_GH_CMD;
  const base = baseBranch || 'main';
  const args = ['pr', 'create', '--base', base, '--head', branch, '--title', title, '--body', body];
  const r = ghCmd
    ? spawnSync('sh', ['-c', ghCmd], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, PR_BRANCH: branch, PR_TITLE: title, PR_BODY: body },
    })
    : spawnSync('gh', args, { cwd: dir, encoding: 'utf8' });
  if (r.status !== 0) {
    const err = ((r.stderr || '') + (r.stdout || '')).trim();
    log.error(traceId, `PR creation failed for ${branch}: ${err}`);
    return { ok: false, error: err };
  }
  const url = (r.stdout || '').trim().split('\n').pop();
  log.info(traceId, `opened PR: ${url}`);
  return { ok: true, url };
}

// Full publish step for one finished task.
function publish(cfg, ctx, log, traceId) {
  const { ws, outcome, hasCommits, issueMarkdown, status, verify, issue, runId } = ctx;
  const result = { pushed: false, branch: ws.branch, prUrl: null };

  if (!hasCommits) {
    log.info(traceId, 'no commits on the branch — nothing to push, no PR');
    return result;
  }

  const pushed = pushBranch(ws.dir, ws.branch, log, traceId);
  result.pushed = pushed.ok;
  if (!pushed.ok) {
    result.pushError = pushed.error;
    return result;
  }

  // PR only for verified success (§4.5). Stuck/tampered/failed branches are pushed and
  // linked from the report instead.
  if (outcome.status !== 'done' && outcome.status !== 'partial') {
    log.info(traceId, `outcome ${outcome.status}: branch pushed for review, no PR opened`);
    return result;
  }

  const title = `${issue.id}: ${issue.title || 'pipeline task'}${outcome.status === 'partial' ? ' [PARTIAL]' : ''}`;
  const body = buildPrBody({ issueMarkdown, status, verify, outcome, branch: ws.branch, runId });
  const pr = openPr(ws.dir, { branch: ws.branch, title, body, baseBranch: ws.defaultBranch, log, traceId });
  if (pr.ok) result.prUrl = pr.url;
  else result.prError = pr.error;
  return result;
}

module.exports = { publish, buildPrBody, pushBranch, openPr };
