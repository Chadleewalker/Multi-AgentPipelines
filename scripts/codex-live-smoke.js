#!/usr/bin/env node
'use strict';
const path = require('path');
const { runSync } = require('../runner/process');
const codexAuthDefault = require('../runner/codex-auth');
const { CODEX_REQUIRED_EXEC_FLAGS, CREDENTIAL_NAMES, REASONING_EFFORTS, normalizeReasoningEffort, normalizeOutput } = require('../runner/agent-provider');
const DEFAULT_MODEL = 'gpt-5.6-terra';
function parseArgs(argv) { const out = { model: DEFAULT_MODEL, reasoningEffort: 'low', image: null }; for (let i=0;i<argv.length;i++) { const a=argv[i]; if (a === '--model') out.model=argv[++i]; else if(a === '--reasoning-effort') out.reasoningEffort=argv[++i]; else if(a === '--image') out.image=argv[++i]; else if(a === '-h'||a==='--help') out.help=true; else return { error:`unknown option "${a}"` }; } return out; }
function smokeArgs(opts) { return ['exec','--model',opts.model,'-c',`model_reasoning_effort="${normalizeReasoningEffort(opts.reasoningEffort)}"`,'-c','shell_environment_policy.ignore_default_excludes=false','-c',`shell_environment_policy.filters.${CREDENTIAL_NAMES.codex}="exclude"`,'--sandbox','read-only',...CODEX_REQUIRED_EXEC_FLAGS.filter(f=>f!=='--approve-for-me'),'--json','-']; }
function runChatgptContainerSmoke({ image, authCache, model, reasoningEffort, env = {}, run = runSync, out = console.log, err = console.error }) {
  const childEnv = { ...env }; delete childEnv.CODEX_API_KEY; delete childEnv.OPENAI_API_KEY; delete childEnv.CODEX_HOME;
  const args = ['run','--rm','--network',env.PIPELINE_NET || 'pipeline-net','-v',authCache.mount,'-e','CODEX_HOME=/root/.codex','-e',`HTTPS_PROXY=${env.PIPELINE_PROXY_URL || 'http://pipeline-proxy:3128'}`,'-e',`HTTP_PROXY=${env.PIPELINE_PROXY_URL || 'http://pipeline-proxy:3128'}`,'-e','NO_PROXY=localhost,127.0.0.1',image,'codex',...smokeArgs({model, reasoningEffort})];
  out('Authentication: ChatGPT managed session'); return run('docker', args, { env: childEnv, input: 'Reply with one short model name.\n' });
}
async function main(argv, io = {}) {
  const out=io.out||console.log, err=io.err||console.error, env=io.env||process.env, run=io.runSync||runSync, auth=io.codexAuth||codexAuthDefault, opts=parseArgs(argv);
  if(opts.error){err(`codex-live-smoke: ${opts.error}`);return 2;} if(opts.help){out('usage: CODEX_LIVE_SMOKE=1 node scripts/codex-live-smoke.js [--image IMAGE] [--model MODEL]');return 0;}
  if(env.CODEX_LIVE_SMOKE!=='1'){out('SKIP codex live smoke — set CODEX_LIVE_SMOKE=1 to make one real, read-only call.');return 0;}
  const image=opts.image||env.PIPELINE_CODEX_IMAGE; if(!image){err('codex-live-smoke: --image is required');return 2;}
  const pre=await Promise.resolve(auth.preflight({mode:'chatgpt',codexHome:env.CODEX_HOME,cacheRoot:env.PIPELINE_CODEX_CACHE})); if(!pre.ok){err(pre.reason);return 1;}
  let handle; try { handle=await Promise.resolve(auth.stageTaskCache({cacheRoot:pre.cacheRoot,taskId:'smoke',wait:true})); const result=runChatgptContainerSmoke({image,authCache:handle,model:opts.model,reasoningEffort:opts.reasoningEffort,env,run,out,err}); const raw=`${result.stdout||''}\n${result.stderr||''}`; const normalized=normalizeOutput('codex',raw,opts.model); if(result.status!==0||!normalized){err('codex-live-smoke: no structured Codex result.');return 1;} out(`Model that answered: ${normalized.model}`);out('PASS codex live smoke');return 0; } finally { if(handle) await Promise.resolve(auth.releaseTaskCache(handle)); }
}
if(require.main===module) Promise.resolve(main(process.argv.slice(2))).then(code=>process.exitCode=code,()=>process.exitCode=1);
module.exports={main,parseArgs,smokeArgs,runChatgptContainerSmoke,DEFAULT_MODEL};
