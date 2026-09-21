// [guard] Frozen acceptance guard — repo-djf.9: retain auth, isolation, watchdog, and Claude.
'use strict';

const fs = require('fs');
const path = require('path');
const REPO = path.resolve(__dirname, '..', '..', '..');
const { buildArgs } = require(path.join(REPO, 'runner', 'container.js'));
let failed = 0;

function check(name, yes, detail = '') {
  console.log(`${yes ? 'ok' : 'FAIL'} - ${name}${yes || !detail ? '' : ` — ${detail}`}`);
  if (!yes) failed = 1;
}

const entrypoint = fs.readFileSync(path.join(REPO, 'pipeline', 'entrypoint.sh'), 'utf8');
const containerSource = fs.readFileSync(path.join(REPO, 'runner', 'container.js'), 'utf8');
const codexArgs = buildArgs({
  image: 'fixture:pinned', network: 'fixture-net', proxyUrl: 'http://fixture-proxy:3128',
  provider: 'codex', codexAuth: 'chatgpt', model: 'gpt-fixture', reasoningEffort: 'medium',
}, {
  containerName: 'task-fixture', workspaceDir: '/host/task', pipelineDir: '/host/pipeline',
  issueId: 'fixture', authCache: { hostPath: '/host/private-auth' },
});
const claudeArgs = buildArgs({
  image: 'fixture:pinned', network: 'fixture-net', proxyUrl: 'http://fixture-proxy:3128',
  provider: 'claude', model: 'claude-fixture', reasoningEffort: 'medium',
}, {
  containerName: 'task-claude', workspaceDir: '/host/task', pipelineDir: '/host/pipeline',
  issueId: 'fixture',
});
const mounts = codexArgs.filter((value, index) => codexArgs[index - 1] === '-v');

check('C2 [guard] the outer Docker boundary keeps every host escape absent',
  !codexArgs.some((arg) => arg === '--privileged' || arg === '--cap-add' || arg === '--pid=host'
    || String(arg).includes('docker.sock')), JSON.stringify(codexArgs));
check('C2 [guard] the task keeps exactly workspace, read-only pipeline, and private auth mounts',
  mounts.every((mount) => mount.endsWith(':/workspace') || mount.endsWith(':/pipeline:ro')
      || mount.endsWith(':/run/pipeline-auth-host/cache:rw'))
    && mounts.some((mount) => mount.endsWith(':/workspace'))
    && mounts.some((mount) => mount.endsWith(':/pipeline:ro'))
    && mounts.some((mount) => mount.endsWith(':/run/pipeline-auth-host/cache:rw')),
  JSON.stringify(mounts));
check('C4 [guard] automatic review remains and no approval or sandbox bypass is selected',
  /--approve-for-me/.test(entrypoint)
    && !/danger-full-access|--ask-for-approval\s+never|dangerously-bypass-approvals-and-sandbox/.test(entrypoint));
check('C4 [guard] ChatGPT verification still drops API keys and CODEX_HOME and runs as nobody',
  /runuser -u nobody -- env -u CODEX_API_KEY -u OPENAI_API_KEY -u CODEX_HOME/.test(entrypoint));
check('C4 [guard] the ChatGPT model process still runs as the image node user',
  /runuser -u node --preserve-environment -- env CODEX_HOME=/.test(entrypoint));
check('C4 [guard] the Claude provider command and container security options remain unchanged',
  entrypoint.includes('AGENT_DEFAULT="claude -p --dangerously-skip-permissions${MODEL_ARG}"')
    && !claudeArgs.includes('seccomp=unconfined'), JSON.stringify(claudeArgs));
check('C4 [guard] the host watchdog remains independent of the task process',
  /createDeadlineWatchdog/.test(containerSource) && /docker',\s*args:\s*\['kill'/.test(containerSource));

process.exitCode = failed;
