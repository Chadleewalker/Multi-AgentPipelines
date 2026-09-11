// Frozen acceptance test — repo-djf.3 public live-smoke completion includes cache cleanup.
'use strict';
const path = require('path');
const SMOKE = require('../../../scripts/codex-live-smoke');

let failed = 0;
function check(name, yes, detail = '') {
  console.log(`${yes ? 'ok' : 'FAIL'} - ${name}${yes || !detail ? '' : ` — ${detail}`}`);
  if (!yes) failed = 1;
}
function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function main() {
  const cacheRoot = path.resolve('pipeline-private-codex-cache-cleanup');
  const handle = {
    hostPath: path.join(cacheRoot, 'tasks', 'smoke'),
    containerPath: '/root/.codex',
    mount: `${path.join(cacheRoot, 'tasks', 'smoke')}:/root/.codex:rw`,
    cacheRoot,
  };
  let cleanupFinished = false;
  let preflightFinished = false;
  let stagingFinished = false;
  let launchedBeforeStaging = false;
  const auth = {
    preflight() {
      return delay(15).then(() => { preflightFinished = true; return { ok: true, cacheRoot }; });
    },
    stageTaskCache() {
      if (!preflightFinished) throw new Error('staged before preflight completed');
      return delay(20).then(() => { stagingFinished = true; return handle; });
    },
    releaseTaskCache(value) {
      if (value !== handle) throw new Error('wrong cache handle released');
      return delay(35).then(() => { cleanupFinished = true; });
    },
  };
  const runSync = () => {
    if (!stagingFinished) launchedBeforeStaging = true;
    return ({
    status: 0,
    stdout: [
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'gpt fixture' } }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 2, output_tokens: 3 } }),
    ].join('\n'),
    stderr: '',
    });
  };
  const output = [];
  const result = await SMOKE.main(
    ['--image', 'fixture:codex-task-image-pinned', '--model', 'gpt-5.6-terra'],
    {
      env: { CODEX_LIVE_SMOKE: '1', CODEX_HOME: path.resolve('operator-home') },
      codexAuth: auth,
      runSync,
      out: line => output.push(String(line)),
      err: line => output.push(String(line)),
    },
  );
  check('C5 public pinned-image smoke does not resolve success before asynchronous credential refresh persistence and task-cache cleanup finish',
    result === 0 && preflightFinished && stagingFinished && !launchedBeforeStaging && cleanupFinished
      && output.some(line => /PASS.*live smoke/i.test(line)),
    JSON.stringify({ result, preflightFinished, stagingFinished, launchedBeforeStaging, cleanupFinished, output }));
}

main().catch(error => {
  check('C5 asynchronous live-smoke cleanup harness completes', false,
    error && (error.stack || error.message) || String(error));
}).finally(() => { process.exitCode = failed; });
