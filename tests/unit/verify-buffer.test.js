#!/usr/bin/env node
// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// The verifier's capture limit and its no-verdict rule — pipeline/verify.js and
// pipeline/verify-classify.js (change-log row `verify-nobuffer`, STATUS defect 12).
//
// Docker-free and network-free: the end-to-end cases build throwaway git repositories
// under the OS temp directory and drive the real verifier against them through
// process.execPath, so nothing here touches this repo's history or working tree.
//
// WHAT MAKES THE FIXTURES DISCRIMINATING (CLAUDE.md §3.6, "plausible and wrong"): the
// defect this suite exists to catch produced a NON-EMPTY, WELL-FORMED, FALSE result — a
// verify.json reading acceptance='fail' for a suite in which every assertion passed. So
// "the verifier ran and wrote a file" proves nothing here. Every case pins the verdict
// against a suite whose true colour is known independently of the verifier, and the two
// that matter most are the pair that differ ONLY in exit code while both printing past
// the old 1 MiB ceiling:
//
//   - passes + 1.2 MiB of output  -> must be 'pass' (the old code said 'fail')
//   - fails  + 1.2 MiB of output  -> must be 'fail' (the fix must not mask real failures
//                                    behind a big log, which is the way a careless fix
//                                    for this defect would weaken hard rule 2)
//
// Run from Git Bash:  node tests/unit/verify-buffer.test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const VERIFY = path.join(ROOT, 'pipeline', 'verify.js');
const { classify, MAX_BUFFER } = require(path.join(ROOT, 'pipeline', 'verify-classify.js'));

let failed = 0;
function pass(name) { console.log(`PASS  ${name}`); }
function fail(name, detail) {
  console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  failed = 1;
}
function check(name, cond, detail) { (cond ? pass : (n) => fail(n, detail))(name); return cond; }

// Never a literal address in this tracked file — the sanitize checker reads bytes.
const EMAIL = ['verify-buffer-test', 'example.invalid'].join('@');
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'vb-test', GIT_AUTHOR_EMAIL: EMAIL,
  GIT_COMMITTER_NAME: 'vb-test', GIT_COMMITTER_EMAIL: EMAIL,
};

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8', env: GIT_ENV });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${(r.stderr || '').trim()}`);
  return r.stdout;
}

// ---- the pure rule ------------------------------------------------------------------
// These are the branches an end-to-end case cannot reach cheaply: producing a real
// ETIMEDOUT costs 15 minutes and a real 64 MiB overflow costs 64 MiB.
{
  check('classify: clean exit is a pass', classify({ status: 0 }).verdict === 'pass');
  check('classify: nonzero exit is a failure', classify({ status: 1 }).verdict === 'fail');
  check('classify: a large nonzero exit is still a failure', classify({ status: 137 }).verdict === 'fail');

  const nobufs = classify({ status: null, error: { code: 'ENOBUFS' } });
  check('classify: ENOBUFS is an error, never a failure', nobufs.verdict === 'error');
  check('classify: ENOBUFS names the capture limit',
    /capture limit/.test(nobufs.why) && /ENOBUFS/.test(nobufs.why), nobufs.why);

  const timedOut = classify({ status: null, error: { code: 'ETIMEDOUT' } });
  check('classify: a timeout is an error, never a failure', timedOut.verdict === 'error');
  check('classify: the timeout names minutes, not a raw millisecond count',
    /minutes/.test(timedOut.why), timedOut.why);

  const signalled = classify({ status: null, signal: 'SIGKILL' });
  check('classify: an outside kill is an error', signalled.verdict === 'error');
  check('classify: the kill names its signal', /SIGKILL/.test(signalled.why), signalled.why);

  check('classify: a missing result is an error rather than a crash',
    classify(undefined).verdict === 'error');

  // The whole point of the row: every no-verdict branch must avoid the word the defect
  // used. If any of these ever reads 'fail' again, a correct task gets told it is wrong.
  for (const [label, res] of [
    ['ENOBUFS', { status: null, error: { code: 'ENOBUFS' } }],
    ['ETIMEDOUT', { status: null, error: { code: 'ETIMEDOUT' } }],
    ['signal', { status: null, signal: 'SIGTERM' }],
    ['bare null', { status: null }],
  ]) {
    check(`classify: ${label} is not reported as a failure`, classify(res).verdict !== 'fail');
  }

  check('the capture limit is far above the 1 MiB default that caused the defect',
    MAX_BUFFER >= 16 * 1024 * 1024, `MAX_BUFFER=${MAX_BUFFER}`);
}

// ---- end to end, against the real verifier ------------------------------------------

// A fixture repo whose acceptance command prints `bytes` of output and exits `code`.
// The emitter lives at the repo root, NOT under tests/acceptance/, because anything
// untracked or altered under a frozen path is tampering and the verifier would stop
// before it ever ran a suite.
function makeRepo(label, bytes, code) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `verify-buffer-${label}-`));
  fs.writeFileSync(path.join(dir, 'emit.js'),
    'const n = Number(process.argv[2]);\n'
    + 'const line = "x".repeat(99) + "\\n";\n'
    + 'let written = 0;\n'
    + 'while (written < n) { process.stdout.write(line); written += line.length; }\n'
    + 'process.stdout.write("SUITE-DONE\\n");\n'
    // Setting exitCode lets Node drain piped stdout before it exits. process.exit()
    // can truncate pending writes here, which made Linux CI lose SUITE-DONE while
    // Windows happened to retain it.
    + 'process.exitCode = Number(process.argv[3]);\n');
  fs.mkdirSync(path.join(dir, 'tests', 'acceptance', 'fix-001'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'tests', 'acceptance', 'fix-001', '01-case.sh'), '# fixture\n');
  fs.writeFileSync(path.join(dir, 'pipeline.config.json'), JSON.stringify({
    defaultBranch: 'master',
    // argv[2]=bytes argv[3]=exit code; the verifier appends the test dir, which is ignored.
    verifyCommand: `node emit.js ${bytes} ${code}`,
  }, null, 2) + '\n');

  git(dir, 'init', '-q', '-b', 'master');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'fixture');
  return dir;
}

function runVerifier(dir) {
  const r = spawnSync(process.execPath, [VERIFY], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...GIT_ENV, WORKSPACE: dir, ISSUE_ID: 'fix-001' },
  });
  let json = null;
  try {
    json = JSON.parse(fs.readFileSync(path.join(dir, '.run', 'verify.json'), 'utf8'));
  } catch { /* leave null — the checks below report it */ }
  return { rc: r.status, json, stderr: r.stderr };
}

const OVER = 1200000; // 1.2 MiB — past the 1 MiB default, well under the new limit.

// THE REGRESSION. Under the old code this came back acceptance='fail' with exit 1.
{
  const dir = makeRepo('pass-loud', OVER, 0);
  const { rc, json } = runVerifier(dir);
  if (check('loud pass: the verifier wrote a result', !!json)) {
    check('loud pass: a suite that passes while printing 1.2 MiB is a PASS',
      json.acceptance === 'pass', `acceptance=${json.acceptance} rc=${rc}`);
    check('loud pass: exits 0', rc === 0, `rc=${rc}`);
    check('loud pass: no error field', !json.error, json.error);
    // The capture must reach the END of the suite, not a truncated middle: the recorded
    // tail is what the next attempt and the PR body quote.
    check('loud pass: the evidence reaches the end of the run',
      /SUITE-DONE/.test(json.acceptanceOutput || ''));
  }
}

// THE GUARD. The fix must not buy the above by excusing big noisy failures.
{
  const dir = makeRepo('fail-loud', OVER, 1);
  const { rc, json } = runVerifier(dir);
  if (check('loud fail: the verifier wrote a result', !!json)) {
    check('loud fail: a suite that FAILS while printing 1.2 MiB is still a FAIL',
      json.acceptance === 'fail', `acceptance=${json.acceptance} rc=${rc}`);
    check('loud fail: exits 1', rc === 1, `rc=${rc}`);
  }
}

// Quiet cases, so the ordinary path is pinned by the same suite.
{
  const dir = makeRepo('pass-quiet', 100, 0);
  const { rc, json } = runVerifier(dir);
  check('quiet pass: passes and exits 0', !!json && json.acceptance === 'pass' && rc === 0);
}
{
  const dir = makeRepo('fail-quiet', 100, 1);
  const { rc, json } = runVerifier(dir);
  check('quiet fail: fails and exits 1', !!json && json.acceptance === 'fail' && rc === 1);
}

// Tampering still outranks everything — the gate's first job, unchanged by this row.
{
  const dir = makeRepo('tampered', 100, 0);
  fs.writeFileSync(path.join(dir, 'tests', 'acceptance', 'fix-001', '02-added.sh'), '# sneaked in\n');
  const { rc, json } = runVerifier(dir);
  if (check('tamper: the verifier wrote a result', !!json)) {
    check('tamper: an added frozen-path file is tampering, not a pass',
      json.acceptance === 'tampered', `acceptance=${json.acceptance}`);
    check('tamper: exits 3', rc === 3, `rc=${rc}`);
  }
}

console.log(failed ? '== VERIFY-BUFFER CHECKS FAILED ==' : '== ALL VERIFY-BUFFER CHECKS PASSED ==');
process.exit(failed);
