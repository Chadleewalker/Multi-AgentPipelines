// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0
'use strict';

// Docker-free proof for repo-tg8.5: Beads' local repository and the publication remote
// must identify the same project before preflight can reach any mutable system.
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..', '..');
const lock = require(path.join(ROOT, 'runner', 'lock.js'));
const { preflight } = require(path.join(ROOT, 'runner', 'preflight.js'));
const {
  normalizeRemoteIdentity, verifyRepoIdentity,
} = require(path.join(ROOT, 'runner', 'repo-identity.js'));

let passed = 0;
let failed = 0;
function check(name, condition, detail = '') {
  console.log(`${condition ? 'ok' : 'FAIL'} - ${name}${!condition && detail ? ` (${detail})` : ''}`);
  if (condition) passed += 1;
  else failed += 1;
}

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${String(result.stderr || result.stdout).trim()}`);
  }
  return String(result.stdout || '').trim();
}

function snapshot(dir) {
  const walk = (current, prefix = '') => {
    if (!fs.existsSync(current)) return [];
    return fs.readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
      const rel = path.join(prefix, entry.name);
      const full = path.join(current, entry.name);
      return entry.isDirectory() ? walk(full, rel) : [`${rel}:${fs.readFileSync(full, 'utf8')}`];
    });
  };
  return walk(dir).sort();
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'unit-repo-identity-'));
const globalLocks = path.join(tmp, 'global-locks');
const savedGlobal = process.env.PIPELINE_GLOBAL_LOCK_DIR;
process.env.PIPELINE_GLOBAL_LOCK_DIR = globalLocks;
const runId = `repo-identity-mismatch-${process.pid}`;
const runDir = path.join(ROOT, 'runs', runId);

try {
  const remoteA = path.join(tmp, 'remote-a.git');
  const remoteB = path.join(tmp, 'remote-b.git');
  const target = path.join(tmp, 'target');
  git(['init', '--quiet', '--bare', '--initial-branch=main', remoteA]);
  git(['init', '--quiet', '--bare', '--initial-branch=main', remoteB]);
  git(['clone', '--quiet', remoteA, target]);

  const same = verifyRepoIdentity({ targetRepoPath: target, targetRepoRemote: remoteA, gitTimeoutMs: 5000 });
  check('a working copy and its configured origin have one identity',
    same.ok && same.remoteName === 'origin' && same.identity.startsWith('file:'), JSON.stringify(same));

  const sameFileUrl = verifyRepoIdentity({
    targetRepoPath: target,
    targetRepoRemote: pathToFileURL(remoteA).href,
    gitTimeoutMs: 5000,
  });
  check('absolute-path and file-URL spellings compare equal', sameFileUrl.ok, JSON.stringify(sameFileUrl));

  const mismatch = verifyRepoIdentity({ targetRepoPath: target, targetRepoRemote: remoteB, gitTimeoutMs: 5000 });
  check('a different configured remote is rejected', mismatch.ok === false, JSON.stringify(mismatch));
  check('the mismatch diagnostic names both config sides and the mutation boundary',
    /targetRepoPath/.test(mismatch.reason) && /targetRepoRemote/.test(mismatch.reason)
      && /before Beads mutation or workspace creation/.test(mismatch.reason), mismatch.reason);

  const githubHttps = normalizeRemoteIdentity('https://User:secret@github.com/Owner/Project.git?ignored=1#fragment');
  const githubSsh = normalizeRemoteIdentity('git@github.com:owner/project.git');
  check('GitHub HTTPS and SSH locators normalize to the same repository', githubHttps === githubSsh,
    `${githubHttps} != ${githubSsh}`);
  check('normalized identities never retain URL credentials',
    !/User|secret/.test(String(githubHttps)), String(githubHttps));
  check('different network repositories remain distinct',
    githubHttps !== normalizeRemoteIdentity('https://github.com/owner/another.git'));
  check('a trailing separator does not change local identity',
    normalizeRemoteIdentity(`${remoteA}${path.sep}`) === normalizeRemoteIdentity(remoteA));
  check('a network locator treats the conventional trailing .git as optional',
    normalizeRemoteIdentity('https://example.test/owner/project.git')
      === normalizeRemoteIdentity('ssh://git@example.test/owner/project'));
  check('distinct local repo and repo.git paths are never conflated',
    normalizeRemoteIdentity(remoteA) !== normalizeRemoteIdentity(remoteA.replace(/\.git$/, '')));

  const noRemote = path.join(tmp, 'no-remote');
  git(['init', '--quiet', '--initial-branch=main', noRemote]);
  const unbound = verifyRepoIdentity({ targetRepoPath: noRemote, targetRepoRemote: remoteA, gitTimeoutMs: 5000 });
  check('a local repository with no fetch remote is rejected as unprovable',
    !unbound.ok && /no configured fetch remote/.test(unbound.reason), unbound.reason);

  // The real preflight ordering discriminator. Every later gate is a recorder. With a
  // mismatched fixture none may run, and both the global authority and observer mirror must
  // be gone when the refusal returns.
  const touched = [];
  const logLines = [];
  const log = {
    runId: 'identity-preflight',
    info(_trace, message) { logLines.push(String(message)); },
    error(_trace, message) { logLines.push(String(message)); },
  };
  const deps = {};
  for (const name of [
    'resolveHostShell', 'dockerAvailable', 'imageExists', 'networkUp', 'egressCheck',
    'recoverStaleIssues',
  ]) deps[name] = () => { touched.push(name); throw new Error(`${name} must be unreachable`); };
  const pre = preflight({
    targetRepoPath: target,
    targetRepoRemote: remoteB,
    gitTimeoutMs: 5000,
  }, ROOT, log, deps);
  check('preflight reports the mismatch as its own refusal class',
    !pre.ok && pre.identityMismatch === true, JSON.stringify(pre));
  check('identity refusal precedes shell, Docker, networking, and Beads recovery',
    touched.length === 0, touched.join(','));
  check('identity refusal releases the checkout observer lock', !fs.existsSync(lock.lockPath(ROOT, target)));
  check('identity refusal releases the host-global authority',
    !fs.existsSync(globalLocks) || fs.readdirSync(globalLocks).length === 0);

  // Exercise runner/run.js, not just the helper. A controlled temp root makes workspace
  // creation observable, while a sentinel .beads tree proves the local tracker was unchanged.
  const beadsDir = path.join(target, '.beads');
  fs.mkdirSync(beadsDir, { recursive: true });
  fs.writeFileSync(path.join(beadsDir, 'sentinel.txt'), 'unchanged\n');
  const beforeBeads = snapshot(beadsDir);
  const childTemp = path.join(tmp, 'child-temp');
  fs.mkdirSync(childTemp, { recursive: true });
  const cfgFile = path.join(tmp, 'mismatch.json');
  fs.writeFileSync(cfgFile, JSON.stringify({
    targetRepoPath: target,
    targetRepoRemote: remoteB,
    image: 'identity-test-image:never-reached',
    gitTimeoutMs: 5000,
  }));
  const child = spawnSync(process.execPath, [path.join(ROOT, 'runner', 'run.js'), '--config', cfgFile], {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
    env: {
      ...process.env,
      CLAUDE_CODE_OAUTH_TOKEN: 'identity-fixture-token',
      RUN_ID: runId,
      PIPELINE_GLOBAL_LOCK_DIR: globalLocks,
      TEMP: childTemp,
      TMP: childTemp,
      TMPDIR: childTemp,
    },
  });
  const childOutput = `${child.stdout || ''}${child.stderr || ''}`;
  check('the full runner aborts a mismatched fixture at preflight',
    child.status === 1 && /PREFLIGHT FAILED/.test(childOutput) && /repository identity mismatch/.test(childOutput),
    `status=${child.status} ${childOutput.slice(-800)}`);
  check('the mismatch run does not mutate the local Beads tree',
    JSON.stringify(snapshot(beadsDir)) === JSON.stringify(beforeBeads));
  check('the mismatch run creates no task workspace',
    fs.readdirSync(childTemp).every((name) => !/^pipeline-/.test(name)), fs.readdirSync(childTemp).join(','));
  check('the mismatch run reaches neither Docker nor a missing-image diagnostic',
    !/Docker daemon|image .* not found|network\/sidecar/.test(childOutput), childOutput.slice(-800));

  const runSource = fs.readFileSync(path.join(ROOT, 'runner', 'run.js'), 'utf8');
  const mainSource = runSource.slice(runSource.indexOf('async function main()'));
  check('the run-level preflight remains before both queue mutation and workspace preparation',
    mainSource.indexOf('const pre = preflight(') < mainSource.indexOf('const q = readyQueue(')
      && mainSource.indexOf('const pre = preflight(') < mainSource.indexOf('await drainQueue('));
} finally {
  if (savedGlobal === undefined) delete process.env.PIPELINE_GLOBAL_LOCK_DIR;
  else process.env.PIPELINE_GLOBAL_LOCK_DIR = savedGlobal;
  fs.rmSync(runDir, { recursive: true, force: true });
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`repo identity: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
