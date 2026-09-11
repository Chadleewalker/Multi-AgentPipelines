#!/usr/bin/env node
'use strict';
const path = require('path');
const { CODEX_REQUIRED_EXEC_FLAGS, CREDENTIAL_NAMES, normalizeReasoningEffort, normalizeOutput } = require('../runner/agent-provider');
const codexAuthDefault = require('../runner/codex-auth');
const DEFAULT_MODEL = 'gpt-5.6-terra';
function parseArgs(argv) { const o = { model: DEFAULT_MODEL, reasoningEffort: 'medium', image: null }; for (let i = 0; i < argv.length; i++) { const a = argv[i]; if (a === '--model') o.model = argv[++i]; else if (a === '--image') o.image = argv[++i]; else if (a === '--reasoning-effort') o.reasoningEffort = argv[++i]; else if (a === '-h' || a === '--help') o.help = true; else return { error: `unknown option "${a}"` }; } return o; }
function smokeArgs(o) { return ['exec', '--model', o.model, '-c', `model_reasoning_effort="${normalizeReasoningEffort(o.reasoningEffort)}"`, '-c', 'shell_environment_policy.ignore_default_excludes=false', '-c', 'shell_environment_policy.filters.CODEX_API_KEY="exclude"', '--sandbox', 'read-only', ...CODEX_REQUIRED_EXEC_FLAGS.filter(x => x !== '--approve-for-me'), '--json', '-']; }
function runChatgptContainerSmoke({ image, authCache, model, reasoningEffort, env = process.env, run, out = console.log, err = console.error }) {
  out('Authentication: ChatGPT managed session (private task cache)');
  const childEnv = { ...env }; delete childEnv.CODEX_API_KEY; delete childEnv.CODEX_HOME; delete childEnv.CLAUDE_CODE_OAUTH_TOKEN;
  const args = ['run', '--rm', '-v', authCache.mount, '-e', 'CODEX_HOME=/root/.codex', image, 'codex', ...smokeArgs({ model, reasoningEffort })];
  return run('docker', args, { env: childEnv, input: 'Reply with one sentence naming your model.\n' });
}
async function main(argv, io = {}) {
  const out = io.out || console.log; const err = io.err || console.error; const env = io.env || process.env; const run = io.runSync || require('../runner/process').runSync; const auth = io.codexAuth || codexAuthDefault; const o = parseArgs(argv);
  if (o.error) { err(`codex-live-smoke: ${o.error}`); return 2; }
  if (o.help) { out('usage: CODEX_LIVE_SMOKE=1 node scripts/codex-live-smoke.js --image <pinned-image> [--model <alias>]'); return 0; }
  if (env.CODEX_LIVE_SMOKE !== '1') { out('SKIP codex live smoke — set CODEX_LIVE_SMOKE=1 to make one real, read-only call.'); return 0; }
  if (!o.image) { err('codex-live-smoke: --image is required for the pinned task image'); return 2; }
  const cacheRoot = env.PIPELINE_CODEX_CACHE || path.join(env.HOME || process.cwd(), '.pipeline-codex-chatgpt');
  const pre = await Promise.resolve(auth.preflight({ mode: 'chatgpt', codexHome: env.CODEX_HOME, cacheRoot, env }));
  if (!pre.ok) { err(`codex-live-smoke: ${pre.reason}`); return 1; }
  let handle; try {
    handle = await Promise.resolve(auth.stageTaskCache({ cacheRoot: pre.cacheRoot || cacheRoot, codexHome: env.CODEX_HOME, taskId: 'smoke', containerPath: '/root/.codex' }));
    const result = runChatgptContainerSmoke({ image: o.image, authCache: handle, model: o.model, reasoningEffort: o.reasoningEffort, env, run, out, err });
    const normalized = normalizeOutput('codex', `${result.stdout || ''}\n${result.stderr || ''}`, o.model);
    if (!normalized || result.status !== 0) { err(`codex-live-smoke: no structured Codex result (exit ${result.status}).`); return 1; }
    out(`Model that answered: ${normalized.model}`); out('PASS codex live smoke'); return 0;
  } finally { if (handle) await Promise.resolve(auth.releaseTaskCache(handle)); }
}
if (require.main === module) main(process.argv.slice(2)).then(code => { process.exitCode = code; });
module.exports = { main, parseArgs, smokeArgs, runChatgptContainerSmoke, DEFAULT_MODEL };
