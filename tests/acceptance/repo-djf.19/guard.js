// Frozen acceptance [guard] — repo-djf.19 existing managed-auth isolation.
// Criteria -> tests: C2 -> guard.js; C4 -> guard.js + test.js; C1/C3 -> test.js.
// Tests -> criteria: guard.js serves C2 (agent/verifier identities) and C4
// (agentCommand negative case and mandatory-regression contract).
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..', '..', '..');
const ENTRYPOINT = path.join(ROOT, 'pipeline', 'entrypoint.sh');
const CAPABILITY = 'PIPELINE_TESTING_NESTED_ENTRYPOINT';
let failed = 0;

function check(name, yes, detail = '') {
  console.log(`${yes ? 'ok' : 'FAIL'} - ${name}${yes ? '' : ` — ${detail}`}`);
  if (!yes) failed = 1;
}

let container = null;
try { container = require(path.join(ROOT, 'runner', 'container.js')); } catch {}
const cfg = {
  provider: 'codex', codexAuth: 'chatgpt', agentCommand: 'fixture-explicit-command',
  image: 'fixture:image', network: 'fixture-net', proxyUrl: 'http://fixture-proxy:8080',
};
const args = container && container.buildArgs(cfg, {
  containerName: 'repo-djf-19-guard', workspaceDir: 'fixture-workspace',
  pipelineDir: 'fixture-pipeline', issueId: 'repo-djf.19',
  authCache: { hostPath: 'fixture-private-cache' },
});
const values = Array.isArray(args) ? args : [];
const hasPair = (flag, value) => values.some((item, index) => item === value && values[index - 1] === flag);
check('C2 [guard] an explicit command keeps the managed ChatGPT root setup, durable-cache mount, and auth marker',
  hasPair('--user', 'root')
    && values.some(value => /:\/run\/pipeline-auth-host\/cache:rw$/.test(String(value)))
    && hasPair('-e', 'PIPELINE_CHATGPT_AUTH=1')
    && hasPair('-e', 'PIPELINE_AGENT_CMD=fixture-explicit-command'),
  JSON.stringify(values));
check('C4 [guard] production container arguments do not expose the nested-entrypoint test capability',
  !values.some(value => String(value).includes(CAPABILITY)), JSON.stringify(values));

const source = (() => { try { return fs.readFileSync(ENTRYPOINT, 'utf8'); } catch { return ''; } })();
function section(startNeedle, endNeedle) {
  const start = source.indexOf(startNeedle);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  return start >= 0 && end > start ? source.slice(start, end) : '';
}
const selection = section('AGENT_CMD=', '# When we own the invocation');
const functions = section('persist_chatgpt_auth() {', '# A successful implementation commit');
const unsafeStructuralLines = selection.split(/\r?\n/).filter(line => {
  const code = line.trim();
  return code && !code.startsWith('#') && code.includes('PIPELINE_AGENT_CMD')
    && code.includes('PIPELINE_CHATGPT_AUTH') && !code.includes(CAPABILITY);
});
check('C4 [guard] structurally, agentCommand alone cannot clear the managed-auth marker',
  selection.length > 0 && unsafeStructuralLines.length === 0, unsafeStructuralLines.join(' | '));

const harness = [
  'set -u',
  "PIPELINE_AGENT_CMD='fixture-explicit-command'",
  "AGENT_DEFAULT='fixture-default-command'",
  'PIPELINE_CHATGPT_AUTH=1',
  `${CAPABILITY}=`,
  "AGENT_FORMAT=''", "WS='/workspace'", "PIPE='/pipeline'",
  'die30() { printf "die30 %s\\n" "$*"; return 30; }',
  'mkdir() { printf "mkdir %s\\n" "$*"; }',
  'chmod() { printf "chmod %s\\n" "$*"; }',
  'cp() { printf "cp %s\\n" "$*"; }',
  'chown() { printf "chown %s\\n" "$*"; }',
  'mv() { printf "mv %s\\n" "$*"; }',
  'runuser() { printf "runuser %s\\n" "$*"; }',
  'env() { printf "env %s\\n" "$*"; }',
  'sh() { printf "sh %s\\n" "$*"; }',
  'node() { printf "node %s\\n" "$*"; }',
  selection, functions,
  'run_agent', 'run_verifier',
].join('\n');
const runtime = spawnSync('bash', ['-c', harness], { encoding: 'utf8', timeout: 30000 });
const trace = String(runtime.stdout || '');
const lines = trace.split(/\r?\n/).filter(Boolean);
const agentLaunch = lines.find(line => /^runuser -u node\b/.test(line)) || '';
const verifierLaunch = lines.find(line => /^runuser -u nobody\b/.test(line)) || '';
check('C2 [guard] at runtime an explicit managed agent launches as node with only the internal CODEX_HOME',
  runtime.status === 0 && agentLaunch.includes('CODEX_HOME=/root/.codex')
    && agentLaunch.includes('fixture-explicit-command')
    && !agentLaunch.includes('/run/pipeline-auth-host/cache'),
  JSON.stringify({ status: runtime.status, trace, stderr: runtime.stderr }));
check('C2 [guard] at runtime repository verification launches as nobody with all Codex credential variables absent',
  verifierLaunch.includes('-u CODEX_API_KEY') && verifierLaunch.includes('-u OPENAI_API_KEY')
    && verifierLaunch.includes('-u CODEX_HOME') && verifierLaunch.includes('node /pipeline/verify.js'),
  verifierLaunch || trace);
check('C4 [guard] at runtime agentCommand alone follows managed authentication rather than the root command path',
  agentLaunch.length > 0 && !lines.some(line => /^sh -c fixture-explicit-command\b/.test(line)), trace);

let project = null;
try { project = JSON.parse(fs.readFileSync(path.join(ROOT, 'pipeline.config.json'), 'utf8')); } catch {}
check('C4 [guard] the separately-run mandatory regression profile remains required and present',
  project && project.regressionPolicy === 'required'
    && project.regressionCommand === 'bash scripts/test-ci.sh'
    && fs.existsSync(path.join(ROOT, 'scripts', 'test-ci.sh')));
process.exitCode = failed;
