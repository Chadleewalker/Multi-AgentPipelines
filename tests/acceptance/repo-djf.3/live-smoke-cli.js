// Frozen acceptance test — repo-djf.3 public pinned-image ChatGPT smoke path.
'use strict';
const path = require('path');
const { spawnSync } = require('child_process');
const SMOKE = require('../../../scripts/codex-live-smoke');

let failed = 0;
function check(name, yes, detail = '') {
  console.log(`${yes ? 'ok' : 'FAIL'} - ${name}${yes || !detail ? '' : ` — ${detail}`}`);
  if (!yes) failed = 1;
}

const secret = 'must-not-reach-docker';
const openAiSecret = 'openai-key-must-not-reach-docker';
const sourceHome = path.resolve('operator-codex-home');
const taskImage = 'fixture:codex-task-image-pinned';
const privateCache = path.resolve('pipeline-private-codex-cache');
const taskNetwork = 'fixture-codex-internal-net';
const proxyUrl = 'http://fixture-codex-proxy:4312';
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
  const cliEnv = { ...process.env };
  delete cliEnv.CODEX_LIVE_SMOKE;
  delete cliEnv.CODEX_API_KEY;
  delete cliEnv.OPENAI_API_KEY;
  const cli = spawnSync(process.execPath, [require.resolve('../../../scripts/codex-live-smoke')], {
    env: cliEnv, encoding: 'utf8', timeout: 5000,
  });
  check('C5 the actual public smoke CLI awaits its asynchronous main function and exits cleanly when the opt-in flag is absent',
    cli.status === 0 && /SKIP.*live smoke/i.test(`${cli.stdout || ''}\n${cli.stderr || ''}`),
    JSON.stringify({ status: cli.status, signal: cli.signal,
      output: `${cli.stdout || ''}\n${cli.stderr || ''}`.slice(0, 500) }));

  const result = await SMOKE.main(
    ['--image', taskImage, '--model', 'gpt-5.6-terra', '--reasoning-effort', 'low'],
    {
      env: {
        CODEX_LIVE_SMOKE: '1', CODEX_API_KEY: secret, OPENAI_API_KEY: openAiSecret,
        CODEX_HOME: sourceHome,
        PIPELINE_NET: taskNetwork, PIPELINE_PROXY_URL: proxyUrl,
      },
      runSync: run,
      codexAuth: fakeAuth,
      out: line => output.push(String(line)),
      err: line => output.push(String(line)),
    },
  );
  const docker = launches.find(call => call.command === 'docker' && call.argv[0] === 'run');
  const writable = docker ? docker.argv.filter((arg, index) => docker.argv[index - 1] === '-v' && !/:ro$/.test(arg)) : [];
  const mountedHome = docker && docker.argv.some((arg, index) => docker.argv[index - 1] === '-e' && arg === 'CODEX_HOME=/root/.codex');
  const proxied = docker && docker.argv.some((arg, index) => docker.argv[index - 1] === '--network' && arg === taskNetwork)
    && docker.argv.some((arg, index) => docker.argv[index - 1] === '-e' && arg === `HTTPS_PROXY=${proxyUrl}`)
    && docker.argv.some((arg, index) => docker.argv[index - 1] === '-e' && arg === `HTTP_PROXY=${proxyUrl}`)
    && docker.argv.some((arg, index) => docker.argv[index - 1] === '-e' && arg === 'NO_PROXY=localhost,127.0.0.1');
  const clean = docker && !Object.prototype.hasOwnProperty.call(docker.env, 'CODEX_API_KEY')
    && !Object.prototype.hasOwnProperty.call(docker.env, 'OPENAI_API_KEY')
    && !Object.prototype.hasOwnProperty.call(docker.env, 'CODEX_HOME')
    && !docker.argv.some(arg => arg === 'CODEX_API_KEY' || arg === 'OPENAI_API_KEY'
      || String(arg).includes(secret) || String(arg).includes(openAiSecret) || String(arg).includes(sourceHome));
  check('C5 the public opt-in smoke command stages and releases a private ChatGPT cache around one pinned-image Docker launch',
    result === 0 && authCalls.map(call => call[0]).join(',') === 'preflight,stage,release'
      && docker && docker.argv.includes(taskImage) && writable.length === 1 && writable[0] === handle.mount
      && mountedHome && proxied,
    JSON.stringify({ result, authCalls: authCalls.map(call => call[0]), docker: docker && docker.argv, writable }));
  check('C5 the public live smoke uses the closed task network and deny-by-default Codex proxy rather than Docker default egress',
    proxied, JSON.stringify(docker && docker.argv));
  check('C5 the public pinned-image smoke strips both API-key spellings and operator-home state and observably reports ChatGPT authentication and PASS',
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
