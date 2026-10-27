#!/usr/bin/env node
// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// Unit suite for how runner/publish.js's openPr hands a PR body to gh (DESIGN.md §4.5;
// change-log row `pr-body-file`; STATUS defect 14).
//
// THE DEFECT: openPr passed the body as `--body <body>`. Windows caps one command line at
// about 32,000 characters, buildPrBody embeds the whole issue spec plus acceptance output,
// and a long spec pushed past the cap — spawnSync failed before gh started, the reason sat
// in r.error (never read), stdout and stderr were empty, and the log said
// `PR creation failed for <branch>: ` and nothing else. Two tasks of one real batch lost
// their PR that way.
//
// What this proves, and how each check would fail on the old code:
//   * a 100,000-character body reaches a stand-in gh BYTE-IDENTICAL through PR_BODY_FILE —
//     the same file real gh is handed — and the PR opens; the check pins the received
//     VALUE, not just that the call returned. (The cap itself is on the COMMAND LINE, so
//     the seam, which never put the body there, did not hit it: a 100,000-character
//     PR_BODY reaches a child on the reference host. What the seam cannot show is the
//     real-gh argv, which is why that half is checked at the source below.)
//   * PR_BODY still carries the body, long or short (existing suites read it);
//   * a tool that cannot START is logged with its reason — driven for real by emptying
//     PATH, for the seam branch and for the real-gh branch alike;
//   * the real-gh argv carries --body-file and never --body — a source check, because no
//     real gh runs here and a behavioural test of that branch would go quiet the moment
//     an edit dropped the flag (defect 12's lesson).
//
// Plain Node, no framework, no Docker, no network, no real gh. Fixtures live under one
// throwaway OS temp directory. The stand-in gh is a .js run through process.execPath,
// never a #!/bin/sh script (EFTYPE on the Windows host).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
let failed = 0;
let count = 0;
function check(label, ok) {
  count += 1;
  if (ok) console.log(`ok - ${label}`);
  else { failed += 1; console.log(`FAIL - ${label}`); }
}
const fwd = (p) => p.split(path.sep).join('/');
const q = (s) => `"${s}"`;

const { openPr } = require(path.join(ROOT, 'runner', 'publish.js'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-body-test-'));
const ws = path.join(tmp, 'ws');
fs.mkdirSync(ws);
const received = path.join(tmp, 'received.json');

// The stand-in records what reached it: the body file's content, whether PR_BODY was set
// and to what, and the branch and title; then prints a PR URL as gh does.
const ghStub = path.join(tmp, 'gh-stub.js');
fs.writeFileSync(ghStub, [
  "'use strict';",
  "const fs = require('fs');",
  'const e = process.env;',
  "const file = e.PR_BODY_FILE ? fs.readFileSync(e.PR_BODY_FILE, 'utf8') : null;",
  'fs.writeFileSync(process.env.STUB_RECEIVED, JSON.stringify({ file, bodyFile: e.PR_BODY_FILE, envBody: e.PR_BODY === undefined ? null : e.PR_BODY, branch: e.PR_BRANCH, title: e.PR_TITLE }));',
  "process.stdout.write('https://example.invalid/pr/7\\n');",
  '',
].join('\n'));

function logger() {
  const lines = [];
  return { lines, info(t, m) { lines.push(`INFO ${m}`); }, error(t, m) { lines.push(`ERROR ${m}`); } };
}
function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; }
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}
const seam = { PIPELINE_GH_CMD: `${q(process.execPath)} ${q(fwd(ghStub))}`, STUB_RECEIVED: received };

// ==== a body far past both Windows caps ==================================================
// Distinct, non-repeating content (line numbers) so a truncated or reordered copy cannot
// compare equal; a multi-byte character and a backtick so encoding and shell quoting are
// exercised too.
const bigLines = [];
for (let i = 0; bigLines.join('\n').length < 100000; i++) bigLines.push(`line ${i} — spec text with \`code\` and "quotes" $HOME`);
const big = bigLines.join('\n');
check(`fixture body is past the 32,767-character caps (${big.length} chars)`, big.length > 40000);
fs.rmSync(received, { force: true });
const L1 = logger();
const r1 = withEnv(seam, () => openPr(ws, { branch: 'task/app-1', title: 'app-1: long spec', body: big, baseBranch: 'main', log: L1, traceId: 't' }));
let got1 = null;
try { got1 = JSON.parse(fs.readFileSync(received, 'utf8')); } catch { got1 = null; }
check(`long body: openPr reports ok (got ${JSON.stringify(r1)})`, Boolean(r1) && r1.ok === true);
check('long body: the PR URL is the one the stand-in printed', Boolean(r1) && r1.url === 'https://example.invalid/pr/7');
check('long body: the stand-in was actually invoked', Boolean(got1));
check(`long body: the full body arrived byte-identical through PR_BODY_FILE (${got1 && got1.file ? got1.file.length : 0} of ${big.length} chars)`,
  Boolean(got1) && got1.file === big);
check('long body: PR_BODY still carries it, unchanged', Boolean(got1) && got1.envBody === big);
check('long body: branch and title still reach the seam', Boolean(got1) && got1.branch === 'task/app-1' && got1.title === 'app-1: long spec');
check('long body: body file is host-owned outside the workspace and removed afterward',
  Boolean(got1 && got1.bodyFile) && !path.resolve(got1.bodyFile).startsWith(path.resolve(ws) + path.sep) && !fs.existsSync(got1.bodyFile));
check('long body: "opened PR" logged, no failure logged',
  L1.lines.some((l) => l.includes('opened PR: https://example.invalid/pr/7')) && !L1.lines.some((l) => l.startsWith('ERROR')));

// ==== a short body keeps the existing seam contract ======================================
fs.rmSync(received, { force: true });
const small = 'a short body\nwith two lines';
const r2 = withEnv(seam, () => openPr(ws, { branch: 'task/app-2', title: 't', body: small, baseBranch: 'main', log: logger(), traceId: 't' }));
let got2 = null;
try { got2 = JSON.parse(fs.readFileSync(received, 'utf8')); } catch { got2 = null; }
check('short body: ok', Boolean(r2) && r2.ok === true);
check('short body: PR_BODY still carries it (existing suites read it)', Boolean(got2) && got2.envBody === small);
check('short body: PR_BODY_FILE carries it too', Boolean(got2) && got2.file === small);

// ==== a tool that cannot start is logged WITH its reason =================================
// Emptying PATH makes `sh` (the seam) and `gh` (the real branch) unresolvable, which is the
// same shape as the original failure: a non-numeric status, empty output, reason in r.error.
const L3 = logger();
const r3 = withEnv({ ...seam, PIPELINE_GH_CMD: 'missing-review-seam-command-987654321' }, () => openPr(ws, { branch: 'task/app-3', title: 't', body: small, baseBranch: 'main', log: L3, traceId: 't' }));
const e3 = L3.lines.find((l) => l.startsWith('ERROR PR creation failed for task/app-3')) || '';
check(`seam cannot start: openPr reports not ok (got ${JSON.stringify(r3)})`, Boolean(r3) && r3.ok === false);
check(`seam cannot start: the logged reason is not empty (${JSON.stringify(e3)})`,
  /missing-review-seam-command-987654321/.test(e3));
const L4 = logger();
const r4 = withEnv({ PIPELINE_GH_CMD: undefined, PATH: '', Path: undefined }, () => openPr(ws, { branch: 'task/app-4', title: 't', body: small, baseBranch: 'main', log: L4, traceId: 't' }));
const e4 = L4.lines.find((l) => l.startsWith('ERROR PR creation failed for task/app-4')) || '';
check('real gh cannot start: openPr reports not ok', Boolean(r4) && r4.ok === false);
check(`real gh cannot start: the logged reason names gh and the error (${JSON.stringify(e4)})`, /gh.*ENOENT/.test(e4));

// ==== the actual CLI branch, with a substituted leaf spawn (no real forge) =============
const cp = require('child_process');
const modulePath = require.resolve(path.join(ROOT, 'runner', 'publish.js'));
const cached = require.cache[modulePath];
const originalSpawn = cp.spawnSync;
let observed;
try {
  cp.spawnSync = (cli, args) => {
    const index = args.indexOf('--body-file');
    const bodyFile = index >= 0 ? args[index + 1] : null;
    observed = { cli, args, bodyFile, body: bodyFile ? fs.readFileSync(bodyFile, 'utf8') : null };
    return { status: 0, stdout: 'https://example.invalid/pr/9\n', stderr: '' };
  };
  delete require.cache[modulePath];
  const leaf = require(modulePath);
  const result = withEnv({ PIPELINE_GH_CMD: undefined }, () => leaf.openPr(ws,
    { branch: 'task/app-cli', title: 't', body: big, log: logger(), traceId: 't' }));
  check('actual GitHub argv uses body-file, not the large inline body', result.ok &&
    observed.cli === 'gh' && observed.args.includes('--body-file') &&
    !observed.args.includes('--body') && !observed.args.includes(big));
  check('actual GitHub body file preserves exact Unicode/newline bytes', observed.body === big);
  check('actual CLI body file is removed after success', Boolean(observed.bodyFile) && !fs.existsSync(observed.bodyFile));
} finally {
  cp.spawnSync = originalSpawn;
  require.cache[modulePath] = cached;
}
// A container-controlled .run junction must not redirect the host's body-file write.
const outside = path.join(tmp, 'outside'); fs.mkdirSync(outside);
const victim = path.join(outside, 'pr-body.md'); fs.writeFileSync(victim, 'keep');
fs.symlinkSync(outside, path.join(ws, '.run'), process.platform === 'win32' ? 'junction' : 'dir');
const protectedResult = withEnv(seam, () => openPr(ws,
  { branch: 'task/app-symlink', title: 't', body: big, log: logger(), traceId: 't' }));
check('workspace .run symlink cannot redirect a host body write', protectedResult.ok && fs.readFileSync(victim, 'utf8') === 'keep');

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
console.log(`${count - failed}/${count} checks passed`);
process.exit(failed ? 1 : 0);
