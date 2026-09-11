// Frozen acceptance test — repo-djf.3 public pinned-image ChatGPT smoke path.
'use strict';
const path = require('path');
const SMOKE = require('../../../scripts/codex-live-smoke');

let failed = 0;
function check(name, yes, detail = '') {
  console.log(`${yes ? 'ok' : 'FAIL'} - ${name}${yes || !detail ? '' : ` — ${detail}`}`);
  if (!yes) failed = 1;
}

const secret = 'must-not-reach-docker';
const sourceHome = path.resolve('operator-codex-home');
const taskImage = 'fixture:codex-task-image-pinned';
const privateCache = path.resolve('pipeline-private-codex-cache');
const handle = {
  hostPath: path.join(privateCache, 'tasks', 'smoke'),
  containerPath: '/root/.codex',
  mount: `${path.join(privateCache, 'tasks', 'smoke')}:/root/.codex:rw`,
  cacheRoot: privateCache,
};
const authCalls = [];
const fakeAuth = {
  preflight(options) { authCalls.push(['preflight', options]); return { ok: true, cacheRoot: privateCache }; },
  stageTaskCache(options) { authCalls.push(['stage', options]); return handle; },
  releaseTaskCache(value) { authCalls.push(['release', value]); },
};
const launches = [];
const output = [];
function run(command, argv, options = {}) {
  launches.push({ command, argv: [...argv], env: { ...(options.env || {}) }, input: options.input });
  return {
    status: 0,
    stdout: [
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'gpt fixture' } }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 2, output_tokens: 3 } }),
    ].join('\n'),
    stderr: '',
  };
}

async function main() {
try {
  const result = await SMOKE.main(
    ['--image', taskImage, '--model', 'gpt-5.6-terra', '--reasoning-effort', 'low'],
    {
      env: { CODEX_LIVE_SMOKE: '1', CODEX_API_KEY: secret, CODEX_HOME: sourceHome },
      runSync: run,
      codexAuth: fakeAuth,
      out: line => output.push(String(line)),
      err: line => output.push(String(line)),
    },
  );
  const docker = launches.find(call => call.command === 'docker' && call.argv[0] === 'run');
  const writable = docker ? docker.argv.filter((arg, index) => docker.argv[index - 1] === '-v' && !/:ro$/.test(arg)) : [];
  const mountedHome = docker && docker.argv.some((arg, index) => docker.argv[index - 1] === '-e' && arg === 'CODEX_HOME=/root/.codex');
  const clean = docker && !Object.prototype.hasOwnProperty.call(docker.env, 'CODEX_API_KEY')
    && !Object.prototype.hasOwnProperty.call(docker.env, 'CODEX_HOME')
    && !docker.argv.some(arg => arg === 'CODEX_API_KEY' || String(arg).includes(secret) || String(arg).includes(sourceHome));
  check('C5 the public opt-in smoke command stages and releases a private ChatGPT cache around one pinned-image Docker launch',
    result === 0 && authCalls.map(call => call[0]).join(',') === 'preflight,stage,release'
      && docker && docker.argv.includes(taskImage) && writable.length === 1 && writable[0] === handle.mount && mountedHome,
    JSON.stringify({ result, authCalls: authCalls.map(call => call[0]), docker: docker && docker.argv, writable }));
  check('C5 the public pinned-image smoke strips API-key and operator-home state and observably reports ChatGPT authentication and PASS',
    clean && output.some(line => /authentication.*chatgpt|chatgpt.*authentication/i.test(line))
      && output.some(line => /PASS.*live smoke/i.test(line)),
    JSON.stringify({ clean, output }));

  const emptyOutput = [];
  const emptyResult = await SMOKE.main(
    ['--image', taskImage, '--model', 'gpt-5.6-terra', '--reasoning-effort', 'low'],
    {
      env: { CODEX_LIVE_SMOKE: '1', CODEX_HOME: sourceHome },
      runSync: () => ({ status: 0, stdout: '', stderr: '' }),
      codexAuth: fakeAuth,
      out: line => emptyOutput.push(String(line)),
      err: line => emptyOutput.push(String(line)),
    },
  );
  check('C5 a zero-exit Docker process without a structured Codex answer is not reported as a passing live subscription smoke',
    emptyResult === 1 && !emptyOutput.some(line => /PASS.*live smoke/i.test(line)),
    JSON.stringify({ emptyResult, emptyOutput }));
} catch (error) {
  check('C5 public pinned-image smoke harness completes', false,
    error && (error.stack || error.message) || String(error));
}
}
main().catch(error => {
  check('C5 public pinned-image smoke async harness completes', false,
    error && (error.stack || error.message) || String(error));
}).finally(() => { process.exitCode = failed; });
