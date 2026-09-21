// Frozen acceptance test — repo-djf.15.
// C1: docs command output plus a final agent message stores only the final human summary.
// C2: Codex JSONL framing, large command output, and escaped newlines cannot contaminate it.
// C3: the resulting status artifact and report remain valid, deterministic, and offline.
// C3's existing green baseline is guard.js; this test is deliberately red before implementation.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..', '..', '..');
let failed = 0;
function check(name, yes, detail = '') {
  console.log(`${yes ? 'ok' : 'FAIL'} - ${name}${yes ? '' : ` — ${detail}`}`);
  if (!yes) failed = 1;
}
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const quote = (value) => `'${String(value).replace(/'/g, "'\\''")}'`;
const FINAL = 'Documented the verified change.\nKept the operational guidance concise.';
const NOISE = `COMMAND-OUTPUT-MUST-NOT-REACH-CHANGE-SUMMARY-${'x'.repeat(6000)}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-djf15-'));
const workspace = path.join(tmp, 'workspace');
const pipe = path.join(tmp, 'pipeline');
const home = path.join(tmp, 'home');
fs.mkdirSync(path.join(workspace, '.run'), { recursive: true });
fs.mkdirSync(pipe, { recursive: true });
fs.mkdirSync(home, { recursive: true });
for (const file of ['status.js', 'envelope.js']) {
  fs.copyFileSync(path.join(ROOT, 'pipeline', file), path.join(pipe, file));
}
fs.writeFileSync(path.join(pipe, 'verify.js'), 'process.exit(0);\n');
fs.writeFileSync(path.join(workspace, '.run', 'issue.md'), '# repo-djf.15 fixture\n');
const git = (args) => spawnSync('git', args, { cwd: workspace, encoding: 'utf8', env: { ...process.env, HOME: home } });
const initialized = git(['init', '-q']);
const committed = git(['-c', 'user.email=fixture@example.invalid', '-c', 'user.name=fixture', 'commit', '-q', '--allow-empty', '-m', 'seed']);
const agent = path.join(tmp, 'codex-jsonl-agent.js');
fs.writeFileSync(agent, [
  "'use strict';",
  "const fs = require('fs');",
  "const prompt = fs.readFileSync(0, 'utf8');",
  `const noise = ${JSON.stringify(NOISE)};`,
  `const final = ${JSON.stringify(FINAL)};`,
  "process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'repo-djf.15' }) + '\\n');",
  "process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', aggregated_output: noise } }) + '\\n');",
  "process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: prompt.includes('change summary') ? final : 'implementation turn' } }) + '\\n');",
].join('\n'));
let run = { status: null, stdout: '', stderr: 'git fixture initialization failed' };
if (initialized.status === 0 && committed.status === 0) {
  run = spawnSync('bash', [path.join(ROOT, 'pipeline', 'entrypoint.sh')], {
    encoding: 'utf8', timeout: 120000,
    env: {
      ...process.env, HOME: home, WORKSPACE: workspace, PIPELINE_DIR: pipe, ISSUE_ID: 'repo-djf.15',
      PIPELINE_PROVIDER: 'codex', PIPELINE_MAX_ATTEMPTS: '1',
      PIPELINE_AGENT_CMD: `${quote(process.execPath)} ${quote(agent)}`,
    },
  });
}
check('C1 docs-phase JSONL fixture exits successfully', run.status === 0, String(run.stderr || run.stdout || '').slice(-500));
const statusFile = path.join(workspace, '.run', 'status.json');
const status = readJson(statusFile);
const summary = status && status.changeSummary;
check('C1 docs phase records only the final human summary in status.json', summary === FINAL,
  typeof summary === 'string' ? summary.slice(0, 240) : 'missing changeSummary');
check('C2 JSONL framing, 6000-byte command output, and escaped final newlines do not contaminate changeSummary',
  summary === FINAL && summary.length <= 2000 && !summary.includes('COMMAND-OUTPUT-MUST-NOT-REACH'),
  typeof summary === 'string' ? `length=${summary.length}` : 'missing changeSummary');
let artifacts = null;
let report = null;
try { artifacts = require(path.join(ROOT, 'runner', 'artifact-schema.js')); } catch {}
try { report = require(path.join(ROOT, 'runner', 'report.js')); } catch {}
const parsed = artifacts && status && artifacts.parseArtifact('status', JSON.stringify(status), 'repo-djf.15');
check('C3 status.json from the docs phase satisfies the offline artifact schema', Boolean(parsed && parsed.ok));
const markdown = report && status && report.renderReport({
  runId: 'repo-djf.15-fixture', startedAt: '2026-09-12T00:00:00Z', finishedAt: '2026-09-12T00:00:01Z',
  tasks: [{ issueId: 'repo-djf.15', outcome: 'done', attempts: 1, changeSummary: summary }],
});
check('C3 report.md renders only the final human summary from the valid artifact',
  typeof markdown === 'string' && markdown.includes(FINAL) && !markdown.includes('COMMAND-OUTPUT-MUST-NOT-REACH'));
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
process.exitCode = failed;
