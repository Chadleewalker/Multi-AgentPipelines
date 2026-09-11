// Frozen acceptance test — repo-djf.9: Codex can edit inside Docker isolation.
'use strict';

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..', '..');
const container = require(path.join(REPO, 'runner', 'container.js'));
const preflight = require(path.join(REPO, 'runner', 'preflight.js'));
let failed = 0;

function check(name, yes, detail = '') {
  console.log(`${yes ? 'ok' : 'FAIL'} - ${name}${yes || !detail ? '' : ` — ${detail}`}`);
  if (!yes) failed = 1;
}

function hasPair(args, key, value) {
  return args.some((arg, index) => arg === key && args[index + 1] === value);
}

function taskArgs(provider) {
  return container.buildArgs({
    image: 'fixture:pinned', network: 'fixture-net', proxyUrl: 'http://fixture-proxy:3128',
    provider, codexAuth: 'chatgpt', model: 'gpt-fixture', reasoningEffort: 'medium',
  }, {
    containerName: `task-${provider}`, workspaceDir: '/host/task', pipelineDir: '/host/pipeline',
    issueId: 'fixture', ...(provider === 'codex'
      ? { authCache: { hostPath: '/host/private-auth' } } : {}),
  });
}

const codexArgs = taskArgs('codex');
const claudeArgs = taskArgs('claude');
const entrypoint = fs.readFileSync(path.join(REPO, 'pipeline', 'entrypoint.sh'), 'utf8');
const preflightSource = fs.readFileSync(path.join(REPO, 'runner', 'preflight.js'), 'utf8');

check('C1 a Codex task delegates namespace syscalls to its inner workspace sandbox',
  hasPair(codexArgs, '--security-opt', 'seccomp=unconfined'), JSON.stringify(codexArgs));
check('C1 automatic review and the Codex workspace-write sandbox remain selected',
  /--approve-for-me/.test(entrypoint)
    && !/--sandbox\s+danger-full-access|--ask-for-approval\s+never|dangerously-bypass-approvals-and-sandbox/.test(entrypoint));
check('C1 the provider-specific Docker policy does not change Claude task argv',
  !hasPair(claudeArgs, '--security-opt', 'seccomp=unconfined'), JSON.stringify(claudeArgs));

check('C2 the corrected Codex task adds no privileged mode, capability, host PID, or Docker socket',
  !codexArgs.some((arg) => arg === '--privileged' || arg === '--cap-add'
    || arg === '--pid=host' || String(arg).includes('docker.sock')), JSON.stringify(codexArgs));
const mounts = codexArgs.filter((value, index) => codexArgs[index - 1] === '-v');
check('C2 workspace, read-only pipeline, and private auth remain the only task mounts',
  mounts.every((mount) => mount.endsWith(':/workspace') || mount.endsWith(':/pipeline:ro')
      || mount.endsWith(':/run/pipeline-auth-host/cache:rw'))
    && mounts.some((mount) => mount.endsWith(':/workspace'))
    && mounts.some((mount) => mount.endsWith(':/pipeline:ro'))
    && mounts.some((mount) => mount.endsWith(':/run/pipeline-auth-host/cache:rw')),
  JSON.stringify(mounts));

const engineCalls = [];
function namespaceEngine(cfg, command, args) {
  engineCalls.push({ command, args });
  if (!hasPair(args, '--security-opt', 'seccomp=unconfined')) {
    return { status: 1, stdout: '', stderr: 'bwrap: No permissions to create a new namespace' };
  }
  return { status: 0, stdout: '1000\n', stderr: '' };
}
const oldResult = namespaceEngine(null, 'docker', [
  'run', '--rm', '--network', 'none', '--user', 'node', '--entrypoint', 'codex',
  'fixture:pinned', 'sandbox', '--', 'true',
]);
engineCalls.length = 0;
const sandboxReady = typeof preflight.codexSandboxAvailable === 'function'
  ? preflight.codexSandboxAvailable({ image: 'fixture:pinned' }, namespaceEngine) : false;
const sandboxCall = engineCalls[0] || { command: '', args: [] };

check('C3 the deterministic engine reproduces the old bwrap namespace refusal',
  oldResult.status === 1 && /bwrap: No permissions to create a new namespace/.test(oldResult.stderr));
check('C3 preflight executes the real pinned sandbox helper with no network or credential',
  sandboxReady && engineCalls.length === 1 && sandboxCall.command === 'docker'
    && sandboxCall.args.includes('--network') && sandboxCall.args.includes('none')
    && sandboxCall.args.includes('--read-only') && sandboxCall.args.includes('--cap-drop')
    && sandboxCall.args.includes('ALL') && hasPair(sandboxCall.args, '--security-opt', 'no-new-privileges')
    && hasPair(sandboxCall.args, '--security-opt', 'seccomp=unconfined')
    && hasPair(sandboxCall.args, '--user', 'node')
    && hasPair(sandboxCall.args, '--entrypoint', 'codex')
    && sandboxCall.args.slice(-3).join(' ') === 'sandbox -- true'
    && !sandboxCall.args.some((arg) => /CODEX_API_KEY|OPENAI_API_KEY|auth\.json/.test(String(arg))),
  JSON.stringify(sandboxCall));
check('C3 a real namespace refusal is a failed capability probe, never a runnable image',
  typeof preflight.codexSandboxAvailable === 'function'
    && preflight.codexSandboxAvailable({ image: 'fixture:pinned' }, () => oldResult) === false);
check('C3 production binds the sandbox probe before network startup',
  preflightSource.indexOf('codexSandboxAvailable') >= 0
    && preflightSource.indexOf('codexSandboxAvailable') < preflightSource.indexOf('networkAttempted = true'));

const docs = fs.readFileSync(path.join(REPO, 'docs', 'control-plane.md'), 'utf8');
check('C4 operator guidance names the delegated seccomp boundary and retained Codex sandbox',
  /seccomp=unconfined/.test(docs) && /--approve-for-me/.test(docs)
    && /inner Codex sandbox|Codex.*inner sandbox/i.test(docs));

process.exitCode = failed;
