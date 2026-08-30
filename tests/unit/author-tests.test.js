#!/usr/bin/env node
// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadConfig } = require('../../runner/config');
const A = require('../../scripts/author-tests');

let failures = 0;
function check(label, ok) { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) failures += 1; }
function capture() {
  const out = []; const err = [];
  return { out, err, io: { out: (s) => out.push(String(s)), err: (s) => err.push(String(s)) } };
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'author-tests-'));
const folder = path.join(tmp, 'issue-tree');
fs.mkdirSync(folder);
const cfg = { targetRepoPath: tmp, targetRepoRemote: 'x', image: 'x', wallClockMinutes: 2, model: 'sonnet', testAuthorModel: 'opus' };
const built = (state = 'write', extra = {}) => ({
  ok: true, state, cfg: { ...cfg, ...(extra.cfg || {}) }, branch: 'master', id: 'app-7',
  policy: { verifyCommand: 'sh tools/run-acceptance.sh' }, text: 'THE BRIEF',
  folder: state === 'ready' ? null : { dir: folder, branch: 'freeze-7', exists: true }, ...extra,
});

check('A1 missing arguments are usage errors', A.main([], capture().io) === A.EXIT_USAGE);
check('A2 unknown options are named', /unknown option/.test(A.parseArgs(['x', '--wat']).error));
{
  let builtUnsafe = false;
  check('A3 unsafe issue ids fail before brief or filesystem work',
    A.main(['../escape', '--config', 'x.json'], capture().io, {
      buildBrief: () => { builtUnsafe = true; return built(); },
    }) === A.EXIT_USAGE && !builtUnsafe);
}

{
  const c = capture(); let launch = 0;
  const rc = A.main(['app-7', '--config', 'x.json'], c.io, {
    buildBrief: () => built('write'),
    auditAuthorTree: () => ({ ok: true }),
    launchAuthor: (b, model) => { launch += 1; return { status: 0, stdout: 'agent report', stderr: '' }; },
    proveTests: () => ({ ok: true, attempt: 1, probe: path.join(tmp, 'probe'), evidence: 'RED/GREEN proof' }),
  });
  check('B1 write state launches exactly once and succeeds', rc === 0 && launch === 1);
  check('B2 selected testAuthorModel is reported explicitly', c.out.some((s) => s.includes('opus')));
  check('B3 worktree and agent output are reported', c.out.some((s) => s.includes(folder)) && c.out.includes('agent report'));
  check('B4 mandatory human freeze step is reported', c.out.some((s) => /Human approval is mandatory/.test(s)));
  check('B5 launcher states that it did not freeze, commit or push', c.out.some((s) => /No freeze, commit or push/.test(s)));
  check('B6 successful authoring requires and reports a fully proven green probe',
    c.out.some((s) => /fully proven/.test(s)) && c.out.some((s) => /--probe/.test(s)));
}

for (const state of ['ready', 'freeze', 're-gate']) {
  const c = capture(); let launch = 0;
  const rc = A.main(['app-7', '--config', 'x.json'], c.io, {
    buildBrief: () => built(state), launchAuthor: () => { launch += 1; return { status: 0 }; },
  });
  check(`C ${state} state does not launch an author`, rc === 0 && launch === 0 && c.out.some((s) => /no launch/.test(s)));
}

{
  const c = capture();
  const rc = A.main(['app-7', '--config', 'x.json'], c.io, {
    buildBrief: () => built('write', { cfg: { model: null, testAuthorModel: null } }),
  });
  check('D1 no model fails before launch and names both config choices', rc === A.EXIT_SETUP && /testAuthorModel or model/.test(c.err.join('\n')));
}

{
  const c = capture();
  const rc = A.main(['app-404', '--config', 'x.json'], c.io, {
    buildBrief: () => ({ ok: false, kind: 'issue', error: 'bd returned no issue for app-404' }),
  });
  check('D2 unknown issue is a setup failure and is named', rc === A.EXIT_SETUP && /app-404/.test(c.err.join('\n')));
}

{
  const c = capture();
  const rc = A.main(['app-7', '--config', 'x.json'], c.io, {
    buildBrief: () => built('write'), launchAuthor: () => ({ status: null, stdout: '', stderr: '', error: { code: 'ENOENT', message: 'spawnSync claude ENOENT' } }),
    auditAuthorTree: () => ({ ok: true }),
  });
  check('D3 missing Claude executable is a distinct agent failure with useful detail', rc === A.EXIT_AGENT && /ENOENT/.test(c.err.join('\n')));
  check('D4 a failed author is explicitly kept away from freeze', /Do not freeze/.test(c.err.join('\n')));
}

{
  let call;
  const r = A.launchAuthor(built('write'), 'opus', (cmd, args, opts) => { call = { cmd, args, opts }; return { status: 0 }; });
  check('E1 Claude receives the prompt on stdin, not in a shell string', r.status === 0 && call.opts.input === 'THE BRIEF\n');
  check('E2 model alias is an explicit argv value', call.args[call.args.indexOf('--model') + 1] === 'opus');
  check('E3 restricted mode and acceptEdits are both explicit', call.args.includes('--restricted')
    && call.args[call.args.indexOf('--permission-mode') + 1] === 'acceptEdits');
  check('E4 host session does not bypass permissions', !call.args.includes('--dangerously-skip-permissions')
    && !call.args.includes('bypassPermissions'));
  check('E5 only read/edit/search and Bash tools are exposed', call.args[call.args.indexOf('--tools') + 1] === A.AUTHOR_TOOLS);
  const allowed = call.args[call.args.indexOf('--allowedTools') + 1];
  check('E6 only the issue verifier is pre-authorized for Bash',
    allowed === 'Read,Edit,Write,Glob,Grep,Bash(sh tools/run-acceptance.sh tests/acceptance/app-7/)');
  check('E6b the verifier rule is exact, so a chained command cannot match its prefix',
    allowed.endsWith('Bash(sh tools/run-acceptance.sh tests/acceptance/app-7/)'));
  const denied = call.args[call.args.indexOf('--disallowedTools') + 1];
  for (const operation of ['commit', 'push', 'merge', 'rebase', 'reset']) {
    check(`E7 git ${operation} is explicitly denied`, denied.includes(`git ${operation}*`));
  }
  check('E8 Beads writes and freeze are explicitly denied', denied.includes('Bash(bd') && denied.includes('freeze.js'));
  check('E9 sessions are not persisted outside the issue tree', call.args.includes('--no-session-persistence'));
  check('E10 session cwd is the dedicated worktree', call.opts.cwd === folder);
  check('E11 session is bounded by wallClockMinutes', call.opts.timeoutMs === 120000);
  check('E12 validated hostEnv reaches the verifier without authorizing shell setup', (() => {
    let env;
    A.launchAuthor(built('write', { cfg: { hostEnv: { FIXTURE_BIN: '/fixture/bin' } } }), 'opus',
      (cmd, args, opts) => { env = opts.env; return { status: 0 }; });
    return env.FIXTURE_BIN === '/fixture/bin';
  })());
}

{
  const calls = [];
  const b = built('write', { folder: { dir: path.join(tmp, 'new-tree'), branch: 'freeze-8', exists: false } });
  const result = A.ensureWorktree(b, (cmd, args) => { calls.push([cmd, args]); return { status: calls.length === 1 ? 1 : 0 }; });
  check('F1 missing branch is created from the resolved integration branch', result.ok && calls[1][1].join(' ') === `worktree add -b freeze-8 ${b.folder.dir} master`);
  calls.length = 0;
  const reused = A.ensureWorktree(b, (cmd, args) => { calls.push([cmd, args]); return { status: calls.length === 1 ? 0 : 0 }; });
  check('F2 an existing issue branch is attached, never recreated', reused.ok && calls[1][1].join(' ') === `worktree add ${b.folder.dir} freeze-8`);
}

{
  const c = capture(); let builds = 0; let launchedText = null;
  const absent = built('write', { folder: { dir: folder, branch: 'freeze-9', exists: false }, text: 'create it first' });
  const present = built('write', { folder: { dir: folder, branch: 'freeze-9', exists: true }, text: 'work here now' });
  const rc = A.main(['app-9', '--config', 'x.json'], c.io, {
    buildBrief: () => (++builds === 1 ? absent : present),
    runSync: (cmd, args) => ({ status: args[0] === 'show-ref' ? 1 : 0 }),
    auditAuthorTree: () => ({ ok: true }),
    launchAuthor: (b) => { launchedText = b.text; return { status: 0, stdout: '', stderr: '' }; },
    proveTests: () => ({ ok: true, attempt: 1, probe: path.join(tmp, 'probe') }),
  });
  check('F3 a newly created worktree causes the brief to be rebuilt from git registry', rc === 0 && builds === 2);
  check('F4 the agent receives the refreshed work-here brief, not stale creation instructions', launchedText === 'work here now');
}

{
  const base = { targetRepoPath: tmp, targetRepoRemote: 'x', image: 'x' };
  const file = path.join(tmp, 'config.json');
  const rejects = (key, value) => { fs.writeFileSync(file, JSON.stringify({ ...base, [key]: value })); try { loadConfig(file); return false; } catch { return true; } };
  check('G1 testAuthorModel rejects empty/non-string aliases', rejects('testAuthorModel', '') && rejects('testAuthorModel', 7));
  check('G2 existing model field uses the same validation', rejects('model', '') && rejects('model', false));
  check('G3 option-shaped and unsafe model aliases are refused',
    rejects('testProbeModel', '--dangerously-skip-permissions') && rejects('testProbeModel', 'opus;whoami'));
  check('G4 probe attempts are bounded positive whole numbers',
    rejects('testProbeAttempts', 0) && rejects('testProbeAttempts', 1.5) && rejects('testProbeAttempts', 11));
  fs.writeFileSync(file, JSON.stringify({ ...base, model: 'sonnet' }));
  check('G5 model-only configs remain valid for fallback', loadConfig(file).model === 'sonnet');
  check('G6 an option-shaped Docker image cannot inject verifier-container flags', rejects('image', '--privileged'));
}

{
  const c = capture();
  const rc = A.main(['app-7', '--config', 'x.json'], c.io, {
    buildBrief: () => built('write'),
    auditAuthorTree: () => ({ ok: true }),
    launchAuthor: () => ({ status: 0 }),
    proveTests: () => ({ ok: false, kind: 'unproven', error: 'probe stayed red', probe: 'P' }),
  });
  check('H1 a failed green probe is a distinct refusal', rc === A.EXIT_PROBE && /not fully proven/.test(c.err.join('\n')));
  check('H2 a failed green probe never offers a freeze command', !c.out.concat(c.err).some((s) => /freeze\.js commit/.test(s)));
}

{
  const records = '?? tests/acceptance/app-7/new.js\0 M scenes/product.gd\0';
  const audit = A.auditAuthorTree(built('write'), () => ({ status: 0, stdout: records }));
  check('I1 author audit accepts its suite and rejects product changes',
    !audit.ok && /scenes\/product\.gd/.test(audit.error) && !/new\.js.*outside/.test(audit.error));
  const clean = A.auditAuthorTree(built('write'), () => ({ status: 0, stdout: '?? tests/acceptance/app-7/new.js\0' }));
  check('I2 author audit accepts changes confined to the issue suite', clean.ok);
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
