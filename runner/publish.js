// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// Push and PR creation — DESIGN.md §4.5, §4.11 (T16).
// The host holds every credential: the container never pushes. Push whenever the branch
// has commits (so stuck/tampered/failed work survives for review); open a PR only for
// verified success (exit 0 — "done" and "partial" alike, with partial flagged).
'use strict';
const { scanIntroducedObjects } = require('./credential-scan');
const { commandFor } = require('./host-shell');
const { runSync, failureText } = require('./process');
const CONTROL_PLANE = require('./control-plane');

const PR_ELIGIBLE_OUTCOMES = new Set(CONTROL_PLANE.publication.prEligibleOutcomes);

const git = (cfg, dir, args) => runSync('git', args, {
  cfg, kind: 'git', cwd: dir, label: `git ${args[0]}`,
});

// Never force: an earlier attempt's branch must survive (§4.2 gives re-runs a -rN name).
function pushBranch(dir, branch, log, traceId, cfg) {
  const r = git(cfg, dir, ['push', '--set-upstream', 'origin', branch]);
  if (r.status !== 0) {
    const err = failureText(r, 'git push failed');
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
  // §3.7, above the change summary for the same reason the report puts it there: a concern
  // rides on a task that otherwise looks clean, and the reviewer of THIS PR is the person
  // who can act on it. Structured artifact, not agent prose parsed out of a log (§4.5).
  const concerns = (status && Array.isArray(status.specConcerns)) ? status.specConcerns : [];
  if (concerns.length) {
    lines.push(`## ⚠ Spec concern${concerns.length === 1 ? '' : 's'} (${concerns.length})`);
    lines.push('');
    lines.push('The agent believes the frozen spec or its tests are wrong. This did **not** ' +
      'affect the outcome — a concern is evidence and never a gate (DESIGN.md §3.7). ' +
      'Changing a spec is legal in a planning session and nowhere else.');
    lines.push('');
    for (const c of concerns) {
      lines.push('> ' + String(c).trim().split('\n').join('\n> '));
      lines.push('');
    }
  }
  lines.push('## Change summary');
  lines.push('');
  lines.push(((status && status.changeSummary) || '(no change summary produced)').trim());
  lines.push('');
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
function openPr(dir, { branch, title, body, baseBranch, log, traceId, hostShell, cfg }) {
  const ghCmd = process.env.PIPELINE_GH_CMD;
  const base = baseBranch || 'main';
  const args = ['pr', 'create', '--base', base, '--head', branch, '--title', title, '--body', body];
  const r = ghCmd
    ? runSync(hostShell || 'sh', ['-c', ghCmd], {
      cfg,
      cwd: dir,
      label: 'GitHub PR creation seam',
      env: { ...process.env, PR_BRANCH: branch, PR_TITLE: title, PR_BODY: body },
    })
    : runSync('gh', args, { cfg, cwd: dir, label: 'GitHub PR creation' });
  if (r.status !== 0) {
    const err = failureText(r, 'GitHub PR creation failed');
    log.error(traceId, `PR creation failed for ${branch}: ${err}`);
    return { ok: false, error: err };
  }
  const url = (r.stdout || '').trim().split('\n').pop();
  if (!url) {
    const err = 'PR creation returned success without a URL';
    log.error(traceId, `PR creation failed for ${branch}: ${err}`);
    return { ok: false, error: err };
  }
  log.info(traceId, `opened PR: ${url}`);
  return { ok: true, url };
}

// Full publish step for one finished task.
function publish(cfg, ctx, log, traceId) {
  const {
    ws, outcome, hasCommits, issueMarkdown, status, verify, issue, runId, secrets = [],
  } = ctx;
  // `ok` is the settlement boundary consumed by run.js. `pushed: false` alone is
  // ambiguous: it is the correct no-op for a branch with no commits, but it is a
  // recoverable failure when git rejected a branch that did have commits.
  const result = { ok: true, pushed: false, branch: ws.branch, prUrl: null };

  // Projects can promote the regression layer from evidence to a publication gate. The
  // policy was captured from the fork-point config during workspace preparation, so an
  // implementation cannot remove it from its working tree. Exact pass only: fail, absent,
  // error, or a missing artifact are all an unavailable mandatory discriminator.
  if (ws.regressionPolicy === 'required'
      && (!verify || verify.regressions !== 'pass')) {
    const verdict = verify && verify.regressions ? verify.regressions : 'missing';
    result.ok = false;
    result.error = `required regression gate did not pass (${verdict})`;
    log.error(traceId, `${result.error}; ${ws.branch} is retained locally and will not be published`);
    return result;
  }

  if (!hasCommits) {
    log.info(traceId, 'no commits on the branch — nothing to push, no PR');
    return result;
  }

  // The credentialed host is an exfiltration boundary: scan the complete introduced Git
  // object graph before every push. This includes earlier blobs deleted from HEAD and raw
  // tree objects (tracked filenames). Findings identify only a kind and object id; matching
  // bytes — especially the injected subscription token — never enter a log or error.
  const disclosure = scanIntroducedObjects(ws.dir, ws.forkPoint, secrets,
    { timeoutMs: cfg.gitTimeoutMs });
  if (!disclosure.ok) {
    result.ok = false;
    result.error = `credential disclosure scan rejected ${ws.branch}: ${disclosure.reason}`;
    log.error(traceId, `${result.error}; branch retained locally and not pushed`);
    return result;
  }
  log.info(traceId, `credential disclosure scan passed (${disclosure.scannedObjects} introduced Git object(s))`);

  const pushed = pushBranch(ws.dir, ws.branch, log, traceId, cfg);
  result.pushed = pushed.ok;
  if (!pushed.ok) {
    result.ok = false;
    result.pushError = pushed.error;
    result.error = `push failed for ${ws.branch}${pushed.error ? `: ${pushed.error}` : ''}`;
    return result;
  }

  // PR only for verified success (§4.5). Stuck/tampered/failed branches are pushed and
  // linked from the report instead.
  if (!PR_ELIGIBLE_OUTCOMES.has(outcome.status)) {
    log.info(traceId, `outcome ${outcome.status}: branch pushed for review, no PR opened`);
    return result;
  }

  const title = `${issue.id}: ${issue.title || 'pipeline task'}${outcome.status === 'partial' ? ' [PARTIAL]' : ''}`;
  const body = buildPrBody({ issueMarkdown, status, verify, outcome, branch: ws.branch, runId });
  const pr = openPr(ws.dir, {
    branch: ws.branch, title, body, baseBranch: ws.defaultBranch, log, traceId,
    hostShell: commandFor(cfg, 'sh'), cfg,
  });
  if (pr.ok) result.prUrl = pr.url;
  else {
    result.ok = false;
    result.prError = pr.error;
    result.error = `PR creation failed for ${ws.branch}${pr.error ? `: ${pr.error}` : ''}`;
  }
  return result;
}

module.exports = { publish, buildPrBody, pushBranch, openPr, PR_ELIGIBLE_OUTCOMES };
