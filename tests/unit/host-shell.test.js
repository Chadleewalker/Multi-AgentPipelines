// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  resolveHostShell,
  probeHostShell,
  commandFor,
  PROBE_MARKER,
  PROBE_TIMEOUT_MS,
} = require('../../runner/host-shell');
const { loadConfig } = require('../../runner/config');
const { preflight } = require('../../runner/preflight');

const ROOT = path.resolve(__dirname, '..', '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'host-shell-'));
let passed = 0;
let failed = 0;
function check(label, condition, detail = '') {
  if (condition) { console.log(`ok - ${label}`); passed += 1; }
  else { console.log(`FAIL - ${label}${detail ? `: ${String(detail).slice(0, 400)}` : ''}`); failed += 1; }
}

const ok = () => ({ status: 0, stdout: PROBE_MARKER, stderr: '' });
const fail = (status) => ({ status, stdout: '', stderr: '' });

function fakeResolver({ probes = {}, where = [], calls = [] } = {}) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    if (command === 'where.exe') {
      return where.length ? { status: 0, stdout: `${where.join('\r\n')}\r\n`, stderr: '' } : fail(1);
    }
    return probes[command] || fail(40);
  };
}

try {
  {
    const calls = [];
    const configured = 'D:\\path\\to\\Git\\bin\\bash.exe';
    const got = resolveHostShell(configured, {
      platform: 'win32', execPath: 'D:\\path\\to\\node.exe',
      spawnSync: fakeResolver({ probes: { [configured]: ok() }, calls }),
      existsSync: () => false, env: {},
    });
    check('a configured verified Git Bash wins exactly',
      got.ok && got.command === configured && got.configured === true, JSON.stringify(got));
    check('a configured shell is probed once and never replaced by PATH discovery',
      calls.length === 1 && calls[0].command === configured);
    check('the probe disables profiles and passes host Node as an argument, not shell text',
      calls[0].args[0] === '--noprofile' && calls[0].args[1] === '--norc'
      && calls[0].args[calls[0].args.length - 1] === 'D:\\path\\to\\node.exe'
      && !calls[0].args[3].includes('D:\\path\\to\\node.exe'));
    check('the shell probe itself is bounded and force-killable',
      calls[0].options.timeout === PROBE_TIMEOUT_MS && calls[0].options.killSignal === 'SIGKILL');
  }

  {
    const wsl = 'C:\\Windows\\System32\\bash.exe';
    const gitBash = 'C:\\Program Files\\Git\\bin\\bash.exe';
    const calls = [];
    const got = resolveHostShell(wsl, {
      platform: 'win32', execPath: 'C:\\Program Files\\nodejs\\node.exe',
      spawnSync: fakeResolver({ probes: { [wsl]: fail(41), [gitBash]: ok() }, calls }),
      existsSync: (candidate) => candidate === gitBash,
      env: { ProgramFiles: 'C:\\Program Files' },
    });
    check('an explicitly configured WSL bash is refused rather than silently replaced',
      !got.ok && /not-git-bash/.test(got.reason) && calls.length === 1, JSON.stringify(got));
    check('the WSL refusal names the Git-for-Windows hostShell remedy',
      /hostShell/.test(got.reason) && /Git for Windows/.test(got.reason) && /WSL bash/.test(got.reason));
  }

  {
    const gitBash = 'C:\\Program Files\\Git\\bin\\bash.exe';
    const got = resolveHostShell(null, {
      platform: 'win32', execPath: 'C:\\Program Files\\nodejs\\node.exe',
      spawnSync: fakeResolver({ probes: { [gitBash]: ok() } }),
      existsSync: (candidate) => candidate === gitBash,
      env: { ProgramFiles: 'C:\\Program Files' },
    });
    check('Windows auto-resolution prefers an installed Git for Windows candidate',
      got.ok && got.command === gitBash && got.kind === 'git-bash', JSON.stringify(got));
  }

  {
    const wsl = 'C:\\Windows\\System32\\bash.exe';
    const gitBash = 'E:\\path\\to\\PortableGit\\usr\\bin\\bash.exe';
    const calls = [];
    const got = resolveHostShell(null, {
      platform: 'win32', execPath: 'E:\\path\\to\\node.exe', env: {}, existsSync: () => false,
      spawnSync: fakeResolver({
        where: [wsl, gitBash], probes: { [wsl]: fail(41), [gitBash]: ok() }, calls,
      }),
    });
    check('PATH discovery rejects WSL and continues to a verified portable Git Bash',
      got.ok && got.command === gitBash, JSON.stringify(got));
    check('PATH discovery probes candidates in where.exe order',
      calls.map((call) => call.command).join('|') === `where.exe|${wsl}|${gitBash}`,
      calls.map((call) => call.command).join('|'));
  }

  {
    const shell = 'C:\\path\\to\\Git\\bin\\bash.exe';
    const got = resolveHostShell(shell, {
      platform: 'win32', execPath: 'C:\\path\\to\\node.exe', env: {}, existsSync: () => true,
      spawnSync: fakeResolver({ probes: { [shell]: fail(42) } }),
    });
    check('Git Bash that cannot launch the exact host Node toolchain is refused',
      !got.ok && /cannot-run-host-node/.test(got.reason), JSON.stringify(got));
    check('the Node-toolchain refusal gives a precise install/config remedy',
      /Install Git for Windows/.test(got.reason) && /host Node toolchain/.test(got.reason));
  }

  {
    const got = resolveHostShell(null, {
      platform: 'win32', execPath: 'C:\\path\\to\\node.exe', env: {}, existsSync: () => false,
      spawnSync: fakeResolver(),
    });
    check('Windows with no Git Bash fails early and names that no candidate existed',
      !got.ok && /no compatible host shell/.test(got.reason)
      && /no Git Bash candidates found/.test(got.reason), JSON.stringify(got));
  }

  {
    const calls = [];
    const got = resolveHostShell(null, {
      platform: 'linux', execPath: '/usr/bin/node', env: {}, existsSync: () => false,
      spawnSync: fakeResolver({ probes: { bash: ok() }, calls }),
    });
    check('Linux remains portable: ordinary bash is the default',
      got.ok && got.command === 'bash' && got.kind === 'posix-bash', JSON.stringify(got));
    check('the Linux probe still proves the running host Node binary',
      calls.length === 1 && calls[0].args[calls[0].args.length - 1] === '/usr/bin/node');
  }

  check('commandFor uses the resolved config identity and preserves direct-test fallbacks',
    commandFor({ hostShell: '/chosen/bash' }) === '/chosen/bash'
    && commandFor({}, 'sh') === 'sh' && commandFor(null) === 'bash');

  {
    const r = probeHostShell('/x/bash', {
      platform: 'win32', execPath: '/x/node',
      spawnSync: () => ({ status: null, stdout: '', stderr: '', error: { code: 'ETIMEDOUT' } }),
    });
    check('a shell probe timeout is a named refusal, never a hang or pass', !r.ok && r.state === 'timed-out');
  }

  function configFile(name, hostShell) {
    const file = path.join(TMP, name);
    fs.writeFileSync(file, `${JSON.stringify({
      targetRepoPath: 'C:/path/to/project', targetRepoRemote: 'https://example.invalid/repo.git',
      image: 'fixture:local', ...(hostShell === '__absent__' ? {} : { hostShell }),
    }, null, 2)}\n`);
    return file;
  }
  check('run config accepts automatic null and an explicit shell path',
    loadConfig(configFile('auto.json', null)).hostShell === null
    && loadConfig(configFile('explicit.json', 'C:/path/to/Git/bin/bash.exe')).hostShell === 'C:/path/to/Git/bin/bash.exe');
  for (const [name, value] of [['blank', '  '], ['number', 7], ['false', false], ['object', {}]]) {
    let message = '';
    try { loadConfig(configFile(`${name}.json`, value)); } catch (error) { message = error.message; }
    check(`run config rejects ${name} hostShell by field name`, /hostShell/.test(message), message);
  }
  check('run.config.example.json documents automatic host-shell resolution',
    JSON.parse(fs.readFileSync(path.join(ROOT, 'run.config.example.json'), 'utf8')).hostShell === null);

  {
    const repoRoot = path.join(TMP, 'preflight-root');
    const target = path.join(TMP, 'preflight-target');
    fs.mkdirSync(repoRoot, { recursive: true });
    fs.mkdirSync(target, { recursive: true });
    const logLines = [];
    const log = {
      runId: 'host-shell-preflight',
      info(_trace, message) { logLines.push(message); },
      error(_trace, message) { logLines.push(message); },
    };
    const cfg = { targetRepoPath: target, hostShell: null };
    const result = preflight(cfg, repoRoot, log, {
      verifyRepoIdentity: () => ({ ok: true, remoteName: 'fixture', identity: 'repo:fixture/project' }),
      resolveHostShell: () => ({ ok: false, reason: 'planted incompatible shell' }),
    });
    check('preflight refuses an unsupported shell before any Docker/network work',
      !result.ok && result.shellUnavailable === true && result.reason === 'planted incompatible shell'
      && !logLines.some((line) => /docker|network|proxy/i.test(line)), JSON.stringify({ result, logLines }));
    const lockDir = path.join(repoRoot, 'runs', 'locks');
    check('an early shell refusal releases the project lock',
      !fs.existsSync(lockDir) || fs.readdirSync(lockDir).length === 0);
  }

  const preflightSource = fs.readFileSync(path.join(ROOT, 'runner', 'preflight.js'), 'utf8');
  const runSource = fs.readFileSync(path.join(ROOT, 'runner', 'run.js'), 'utf8');
  const publishSource = fs.readFileSync(path.join(ROOT, 'runner', 'publish.js'), 'utf8');
  check('the production shell gate precedes the Docker daemon check',
    preflightSource.indexOf('const shell = resolveShell(cfg.hostShell, { timeoutMs: cfg.lifecycleTimeoutMs })')
      < preflightSource.indexOf('const daemon = checkDocker(cfg)'));
  check('network scripts and task stubs use the one resolved shell identity',
    /sh\(cfg, commandFor\(cfg\)/.test(preflightSource) && /spawn\(commandFor\(cfg\)/.test(runSource));
  check('the host-side PR seam also uses the resolved shell identity',
    /hostShell:\s*commandFor\(cfg/.test(publishSource));
} catch (error) {
  check('the host-shell suite completed without throwing', false, error && error.stack);
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(`host shell: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
