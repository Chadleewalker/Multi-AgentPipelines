// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// Push and PR creation — DESIGN.md §4.5, §4.11 (T16).
// The host holds every credential: the container never pushes. Push whenever the branch
// has commits (so stuck/tampered/failed work survives for review); open a PR only for
// verified success (exit 0 — "done" and "partial" alike, with partial flagged).
'use strict';
const { spawnSync } = require('child_process');
const { runCommand } = require('./host-shell');

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
    // §4.4 (repo-cl9): the required build gate. Shown only when the target ran one — a
    // legacy target with no buildCommand keeps its previous, build-free evidence block.
    if (verify.build && verify.build !== 'absent') lines.push(`- Build: **${verify.build}**`);
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
    if (verify.build === 'fail' && verify.buildOutput) {
      lines.push('');
      lines.push('<details><summary>Build output</summary>');
      lines.push('');
      lines.push('```');
      lines.push(String(verify.buildOutput).slice(-3000).trim());
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

// The forge CLI that opens the review request (§6, change-log row `gitlab-forge`): `gh`
// for GitHub (a pull request), `glab` for GitLab (a merge request). Chosen by run.config's
// `forge`, never guessed from the remote URL — a self-hosted GitLab can live at any
// hostname. Both CLIs run on the host with the host's credentials, exactly like the push.
const FORGES = {
  github: {
    cli: 'gh',
    args: ({ branch, title, body, base }) =>
      ['pr', 'create', '--base', base, '--head', branch, '--title', title, '--body', body],
  },
  gitlab: {
    cli: 'glab',
    // --yes skips glab's interactive "submit?" prompt; the runner has no terminal.
    args: ({ branch, title, body, base }) =>
      ['mr', 'create', '--source-branch', branch, '--target-branch', base,
        '--title', title, '--description', body, '--yes'],
  },
};

// { cli, args } for one review request. Pure, so a Docker-free suite can pin the exact
// argv each forge receives without either CLI installed.
function prCommand(forge, { branch, title, body, baseBranch }) {
  const f = FORGES[forge || 'github'];
  if (!f) throw new Error(`unknown forge '${forge}'`);
  return { cli: f.cli, args: f.args({ branch, title, body, base: baseBranch || 'main' }) };
}

// The review request's URL from the CLI's output. `gh` prints the URL as its last line;
// `glab` prints a summary line and then the URL. Take the LAST http(s) URL in stdout, so
// neither format — nor a CLI that adds a trailing notice — records prose as the link.
// No URL at all is reported as a failure, never as an empty-but-ok result: the report and
// the verdict recorder both key on prUrl, and a request nobody can find is not published.
function extractPrUrl(stdout) {
  const urls = String(stdout || '').match(/https?:\/\/\S+/g);
  return urls ? urls[urls.length - 1] : null;
}

// PIPELINE_GH_CMD is a test seam — for either forge — so suites can verify PR assembly
// against a local bare remote without touching a live GitHub or GitLab.
function openPr(dir, { branch, title, body, baseBranch, forge, log, traceId }) {
  const ghCmd = process.env.PIPELINE_GH_CMD;
  const { cli, args } = prCommand(forge, { branch, title, body, baseBranch });
  const r = ghCmd
    ? runCommand(ghCmd, {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, PR_BRANCH: branch, PR_TITLE: title, PR_BODY: body, PR_CLI: cli },
    })
    : spawnSync(cli, args, { cwd: dir, encoding: 'utf8' });
  if (r.status !== 0) {
    const err = ((r.error && r.error.message) || (r.stderr || '') + (r.stdout || '')).trim();
    log.error(traceId, `PR creation failed for ${branch} (${cli}): ${err}`);
    return { ok: false, error: err };
  }
  const url = extractPrUrl(r.stdout);
  if (!url) {
    const err = `${cli} exited 0 but printed no URL: ${((r.stdout || '') + (r.stderr || '')).trim()}`;
    log.error(traceId, `PR creation unconfirmed for ${branch}: ${err}`);
    return { ok: false, error: err };
  }
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
  const pr = openPr(ws.dir, {
    branch: ws.branch, title, body, baseBranch: ws.defaultBranch, forge: cfg.forge, log, traceId,
  });
  if (pr.ok) result.prUrl = pr.url;
  else result.prError = pr.error;
  return result;
}

module.exports = { publish, buildPrBody, pushBranch, openPr, prCommand, extractPrUrl, FORGES };
