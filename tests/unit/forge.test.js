#!/usr/bin/env node
// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// Unit suite for the review-request forge — runner/publish.js's prCommand / extractPrUrl /
// openPr and runner/config.js's `forge` key (DESIGN.md §6, change-log row `gitlab-forge`).
// Re-runnable: the sweep picks it up through scripts/test-forge.sh.
//
// Plain Node, no test framework, no Docker, no network, no `bd`, and neither `gh` nor
// `glab` installed: the argv each forge receives is pinned through the pure prCommand, and
// the end-to-end route through publish() runs against a throwaway bare remote with the
// PIPELINE_GH_CMD seam standing in for the CLI. One line per check — `ok - <label>` /
// `FAIL - <label>` — and a non-zero exit if any check failed.
//
// What it guards, and why each one is a way this change could be quietly wrong:
//
//   * GitHub stays byte-identical. Every existing run config has no `forge` key, so the
//     default path must build exactly the argv it built before the key existed.
//   * The URL is the URL. `glab` prints a summary line before the link, and the old
//     "last line of stdout" rule happened to be right for `gh` only. A plausible-and-wrong
//     prUrl (a summary line recorded as the link) is the failure this repo's code
//     conventions single out, so the extractor is pinned against a fixture where the
//     last line is NOT the URL.
//   * "exited 0, printed no URL" is not success. It is reported as an error, never as an
//     ok result with an empty link.
//   * A forge CLI that is not installed fails the PR step by name — it does not throw
//     out of publish() and take the run's report with it.
//   * publish() actually routes by cfg.forge. A pure-function test cannot see a caller
//     that forgot to pass the key through, so this one goes through publish() itself.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const publishMod = require(path.join(ROOT, 'runner', 'publish.js'));
const { loadConfig, DEFAULTS } = require(path.join(ROOT, 'runner', 'config.js'));

let failed = 0;
function check(label, cond) {
  if (cond) console.log(`ok - ${label}`);
  else { console.log(`FAIL - ${label}`); failed = 1; }
}
function throws(fn) { try { fn(); return null; } catch (e) { return e; } }
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const quietLog = { info() {}, error() {} };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-test-'));
const saved = { gh: process.env.PIPELINE_GH_CMD, path: process.env.PATH };
function restoreEnv() {
  if (saved.gh === undefined) delete process.env.PIPELINE_GH_CMD; else process.env.PIPELINE_GH_CMD = saved.gh;
  process.env.PATH = saved.path;
}

// A seam stub as a .js file run through process.execPath — never a #!/bin/sh script,
// which spawnSync fails with EFTYPE on the Windows host (CLAUDE.md).
function stub(name, source) {
  const f = path.join(TMP, name);
  fs.writeFileSync(f, `'use strict';\n${source}\n`);
  return `"${process.execPath.split(path.sep).join('/')}" "${f.split(path.sep).join('/')}"`;
}

try {
  const req = { branch: 'task/x-1', title: 'x-1: thing', body: 'line one\nline two', baseBranch: 'master' };

  // ---- prCommand: the argv each forge receives ------------------------------------------
  check('default forge is github in the config defaults', DEFAULTS.forge === 'github');
  check('github argv is exactly the pre-forge gh pr create argv',
    same(publishMod.prCommand(undefined, req), {
      cli: 'gh',
      args: ['pr', 'create', '--base', 'master', '--head', 'task/x-1', '--title', 'x-1: thing', '--body', 'line one\nline two'],
    }));
  check('explicit github equals the default', same(publishMod.prCommand('github', req), publishMod.prCommand(undefined, req)));
  check('gitlab argv is glab mr create, source/target branch, non-interactive',
    same(publishMod.prCommand('gitlab', req), {
      cli: 'glab',
      args: ['mr', 'create', '--source-branch', 'task/x-1', '--target-branch', 'master',
        '--title', 'x-1: thing', '--description', 'line one\nline two', '--yes'],
    }));
  check('the body reaches glab as one argv element, newlines intact',
    publishMod.prCommand('gitlab', req).args.includes('line one\nline two'));
  check('a missing baseBranch targets main on both forges',
    publishMod.prCommand('github', { ...req, baseBranch: undefined }).args[3] === 'main'
    && publishMod.prCommand('gitlab', { ...req, baseBranch: undefined }).args[5] === 'main');
  const unk = throws(() => publishMod.prCommand('bitbucket', req));
  check('an unknown forge throws, naming it', !!unk && /bitbucket/.test(unk.message));

  // ---- extractPrUrl ---------------------------------------------------------------------
  check('gh: URL as the only line', publishMod.extractPrUrl('https://github.com/o/r/pull/7\n') === 'https://github.com/o/r/pull/7');
  const glabOut = [
    '',
    'Creating merge request for task/x-1 into master in grp/app',
    '',
    '!12 x-1: thing (task/x-1)',
    ' https://gitlab.example.test/grp/app/-/merge_requests/12',
    '',
  ].join('\n');
  check('glab: URL taken from its summary output',
    publishMod.extractPrUrl(glabOut) === 'https://gitlab.example.test/grp/app/-/merge_requests/12');
  const trailing = 'https://gitlab.example.test/grp/app/-/merge_requests/12\nA new version of glab is available\n';
  check('a trailing notice after the URL is not recorded as the link',
    publishMod.extractPrUrl(trailing) === 'https://gitlab.example.test/grp/app/-/merge_requests/12');
  check('CRLF output does not leak \\r into the URL',
    publishMod.extractPrUrl('https://gitlab.example.test/g/a/-/merge_requests/3\r\n') === 'https://gitlab.example.test/g/a/-/merge_requests/3');
  check('no URL -> null', publishMod.extractPrUrl('created\n') === null);
  check('empty / undefined output -> null', publishMod.extractPrUrl('') === null && publishMod.extractPrUrl(undefined) === null);

  // ---- openPr through the seam ----------------------------------------------------------
  const dir = TMP;
  process.env.PIPELINE_GH_CMD = stub('glab-like.js',
    "process.stdout.write('Creating merge request\\n\\n!4 t (b)\\n https://gitlab.example.test/g/a/-/merge_requests/4\\n');");
  let r = publishMod.openPr(dir, { ...req, forge: 'gitlab', log: quietLog, traceId: 't' });
  check('openPr: glab-shaped output -> ok with the MR URL',
    r.ok === true && r.url === 'https://gitlab.example.test/g/a/-/merge_requests/4');

  process.env.PIPELINE_GH_CMD = stub('silent.js', 'process.exit(0);');
  r = publishMod.openPr(dir, { ...req, forge: 'gitlab', log: quietLog, traceId: 't' });
  check('openPr: exit 0 with no URL is an error, not an empty success',
    r.ok === false && !r.url && /no URL/.test(r.error));

  process.env.PIPELINE_GH_CMD = stub('fails.js', "process.stderr.write('401 Unauthorized'); process.exit(1);");
  r = publishMod.openPr(dir, { ...req, forge: 'gitlab', log: quietLog, traceId: 't' });
  check('openPr: a failing CLI reports its own error text', r.ok === false && /401 Unauthorized/.test(r.error));

  // No seam, and a PATH on which no forge CLI can be found: the real spawn path.
  delete process.env.PIPELINE_GH_CMD;
  process.env.PATH = TMP;
  let threw = null;
  try { r = publishMod.openPr(dir, { ...req, forge: 'gitlab', log: quietLog, traceId: 't' }); } catch (e) { threw = e; }
  check('openPr: glab not installed fails the PR step, does not throw', !threw && r.ok === false);
  check('openPr: that failure names the missing CLI', !threw && /glab/.test(r.error));
  restoreEnv();

  // ---- publish() routes by cfg.forge ----------------------------------------------------
  const git = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8' });
  const bare = path.join(TMP, 'remote.git');
  const work = path.join(TMP, 'work');
  git(TMP, 'init', '--bare', '-q', '-b', 'main', bare);
  git(TMP, 'clone', '-q', bare, work);
  for (const [k, v] of [['user.name', 'forge-test'], ['user.email', 'forge-test@example.invalid'], ['commit.gpgsign', 'false']]) git(work, 'config', k, v);
  fs.writeFileSync(path.join(work, 'a.txt'), 'a\n');
  git(work, 'add', '.'); git(work, 'commit', '-q', '-m', 'base'); git(work, 'push', '-q', 'origin', 'main');
  git(work, 'switch', '-q', '-c', 'task/x-1');
  fs.writeFileSync(path.join(work, 'b.txt'), 'b\n');
  git(work, 'add', '.'); git(work, 'commit', '-q', '-m', 'work');

  const cliLog = path.join(TMP, 'cli.txt');
  process.env.PIPELINE_GH_CMD = stub('record-cli.js',
    `require('fs').appendFileSync(${JSON.stringify(cliLog)}, process.env.PR_CLI + '\\n');` +
    "process.stdout.write('https://review.example.test/' + process.env.PR_CLI + '/1\\n');");
  const ctx = (branch) => ({
    ws: { dir: work, branch, defaultBranch: 'main' },
    outcome: { status: 'done' },
    hasCommits: true,
    issueMarkdown: '# x-1: thing\n\nspec',
    status: {},
    verify: { acceptance: 'pass', regressions: 'absent' },
    issue: { id: 'x-1', title: 'thing' },
    runId: 'run-forge',
  });
  const viaGitlab = publishMod.publish({ forge: 'gitlab' }, ctx('task/x-1'), quietLog, 't');
  git(work, 'switch', '-q', '-c', 'task/x-1-r2');
  const viaDefault = publishMod.publish({}, ctx('task/x-1-r2'), quietLog, 't');
  const clis = fs.existsSync(cliLog) ? fs.readFileSync(cliLog, 'utf8').trim().split(/\r?\n/) : [];
  check('publish: branch pushed under forge gitlab', viaGitlab.pushed === true);
  check('publish: cfg.forge gitlab reaches the CLI choice (glab)', clis[0] === 'glab');
  check('publish: gitlab prUrl recorded', viaGitlab.prUrl === 'https://review.example.test/glab/1');
  check('publish: a config with no forge still uses gh', clis[1] === 'gh' && viaDefault.prUrl === 'https://review.example.test/gh/1');
  restoreEnv();

  // ---- config.js: the key is validated at load -------------------------------------------
  const cfgFile = path.join(TMP, 'run.config.forgetest.json');
  const base = { targetRepoPath: 'C:/x', targetRepoRemote: 'https://example.invalid/r.git', image: 'img:local' };
  const load = (extra) => { fs.writeFileSync(cfgFile, JSON.stringify({ ...base, ...extra })); return loadConfig(cfgFile); };
  check('config: no forge key -> github', load({}).forge === 'github');
  check('config: forge gitlab accepted', load({ forge: 'gitlab' }).forge === 'gitlab');
  for (const bad of ['GitLab', 'gitlab.com', '', 1, null]) {
    const e = throws(() => load({ forge: bad }));
    check(`config: forge ${JSON.stringify(bad)} rejected by name`, !!e && /'forge'/.test(e.message));
  }
  check('config and publish agree on the forge list',
    same(Object.keys(publishMod.FORGES).sort(), ['github', 'gitlab']));
} finally {
  restoreEnv();
  fs.rmSync(TMP, { recursive: true, force: true });
}

process.exit(failed);
