// Frozen acceptance test — repo-djf.19 credential-safe Codex JSONL commands.
// Criteria -> tests: C1 -> test.js; C2 -> guard.js; C3 -> test.js; C4 -> both files.
// Tests -> criteria: test.js serves C1 (bounded final agent_message), C3 (explicit
// nested-entrypoint capability), and C4 (production-config structural negative).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..', '..', '..');
const ENTRYPOINT = path.join(ROOT, 'pipeline', 'entrypoint.sh');
const CAPABILITY = 'PIPELINE_TESTING_NESTED_ENTRYPOINT';
const FINAL = 'Implemented the bounded result parser.\nPreserved credential isolation.';
const NOISE_MARKER = 'COMMAND-OUTPUT-MUST-NOT-BECOME-THE-HUMAN-SUMMARY';
let failed = 0;

function check(name, yes, detail = '') {
  console.log(`${yes ? 'ok' : 'FAIL'} - ${name}${yes ? '' : ` — ${detail}`}`);
  if (!yes) failed = 1;
}
const read = file => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } };
const json = file => { try { return JSON.parse(read(file)); } catch { return null; } };
const quote = value => `'${String(value).replace(/'/g, "'\\''")}'`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-djf19-'));

try {
  const pipe = path.join(tmp, 'summary-pipeline');
  const runDir = path.join(tmp, 'summary-run');
  fs.mkdirSync(pipe, { recursive: true });
  for (const file of ['status.js', 'envelope.js']) {
    fs.copyFileSync(path.join(ROOT, 'pipeline', file), path.join(pipe, file));
  }
  const large = `${NOISE_MARKER}-${'x'.repeat(128 * 1024)}`;
  const jsonl = path.join(tmp, 'codex-output.jsonl');
  fs.writeFileSync(jsonl, [
    JSON.stringify({ type: 'thread.started', thread_id: 'repo-djf.19' }),
    JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', aggregated_output: large } }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'intermediate message' } }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: FINAL } }),
  ].join('\n') + '\n');
  const init = spawnSync(process.execPath, [path.join(pipe, 'status.js'), 'init', 'repo-djf.19'], {
    encoding: 'utf8', env: { ...process.env, RUN_DIR: runDir },
  });
  const summarize = spawnSync(process.execPath, [path.join(pipe, 'status.js'), 'summary', jsonl], {
    encoding: 'utf8', env: { ...process.env, RUN_DIR: runDir },
  });
  const status = json(path.join(runDir, 'status.json'));
  check('C1 Codex JSONL records only the final completed agent_message as the human summary',
    init.status === 0 && summarize.status === 0 && status && status.changeSummary === FINAL,
    JSON.stringify({ init: init.status, summarize: summarize.status, summary: status && status.changeSummary }));
  check('C1 a large command record and escaped newlines remain framed, excluded, and bounded',
    status && status.changeSummary === FINAL && status.changeSummary.length <= 2000
      && !status.changeSummary.includes(NOISE_MARKER),
    status && typeof status.changeSummary === 'string' ? `length=${status.changeSummary.length}` : 'missing summary');

  const workspace = path.join(tmp, 'nested-workspace');
  const nestedPipe = path.join(tmp, 'nested-pipeline');
  const home = path.join(tmp, 'nested-home');
  fs.mkdirSync(path.join(workspace, '.run'), { recursive: true });
  fs.mkdirSync(nestedPipe, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  for (const file of ['status.js', 'envelope.js']) {
    fs.copyFileSync(path.join(ROOT, 'pipeline', file), path.join(nestedPipe, file));
  }
  fs.writeFileSync(path.join(nestedPipe, 'verify.js'), [
    "'use strict';", "const fs = require('fs');", "const path = require('path');",
    "const out = path.join(process.env.WORKSPACE, '.run', 'verifier-observations.jsonl');",
    "fs.appendFileSync(out, JSON.stringify({",
    "  api: Object.prototype.hasOwnProperty.call(process.env, 'CODEX_API_KEY'),",
    "  openai: Object.prototype.hasOwnProperty.call(process.env, 'OPENAI_API_KEY'),",
    "  home: Object.prototype.hasOwnProperty.call(process.env, 'CODEX_HOME'),",
    "}) + '\\n');",
  ].join('\n'));
  fs.writeFileSync(path.join(workspace, '.run', 'issue.md'), '# repo-djf.19 nested fixture\n');
  const git = argv => spawnSync('git', argv, {
    cwd: workspace, encoding: 'utf8', env: { ...process.env, HOME: home },
  });
  const initialized = git(['init', '-q']);
  const committed = git(['-c', 'user.email=fixture@example.invalid', '-c', 'user.name=fixture',
    'commit', '-q', '--allow-empty', '-m', 'seed']);
  const agent = path.join(tmp, 'nested-codex-agent.js');
  fs.writeFileSync(agent, [
    "'use strict';", "const fs = require('fs');", "const prompt = fs.readFileSync(0, 'utf8');",
    `const answer = ${JSON.stringify(FINAL)};`,
    "process.stdout.write(JSON.stringify({ type: 'item.completed', item: {",
    "  type: 'agent_message', text: prompt.includes('change summary') ? answer : 'implementation turn',",
    "} }) + '\\n');",
  ].join('\n'));
  let nested = { status: null, stdout: '', stderr: 'git fixture initialization failed' };
  if (initialized.status === 0 && committed.status === 0) {
    nested = spawnSync('bash', [ENTRYPOINT], {
      encoding: 'utf8', timeout: 120000,
      env: {
        ...process.env, HOME: home, WORKSPACE: workspace, PIPELINE_DIR: nestedPipe,
        ISSUE_ID: 'repo-djf.19', PIPELINE_PROVIDER: 'codex', PIPELINE_MAX_ATTEMPTS: '1',
        PIPELINE_CHATGPT_AUTH: '1', [CAPABILITY]: '1',
        PIPELINE_AGENT_CMD: `${quote(process.execPath)} ${quote(agent)}`,
        CODEX_API_KEY: 'must-not-reach-verifier', OPENAI_API_KEY: 'must-not-reach-verifier',
        CODEX_HOME: path.join(tmp, 'must-not-reach-verifier'),
      },
    });
  }
  const nestedStatus = json(path.join(workspace, '.run', 'status.json'));
  const observations = read(path.join(workspace, '.run', 'verifier-observations.jsonl'))
    .split(/\r?\n/).filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } });
  check('C3 the explicit nested-entrypoint test capability runs a stub without inherited managed-auth handling',
    nested.status === 0 && nestedStatus && nestedStatus.changeSummary === FINAL,
    JSON.stringify({ status: nested.status, signal: nested.signal,
      stdout: String(nested.stdout || '').slice(-300), stderr: String(nested.stderr || '').slice(-500) }));
  check('C3 the nested fixture still strips all Codex credential variables from every verifier call',
    observations.length > 0 && observations.every(value => value && !value.api && !value.openai && !value.home),
    JSON.stringify(observations));

  const entrypointSource = read(ENTRYPOINT);
  const containerSource = read(path.join(ROOT, 'runner', 'container.js'));
  const configSource = read(path.join(ROOT, 'runner', 'config.js'));
  const capabilityGate = entrypointSource.split(/\r?\n/).filter(line => {
    const code = line.trim();
    return code && !code.startsWith('#') && code.includes(CAPABILITY);
  });
  check('C3-C4 structurally the bypass requires the named test capability and an explicit command',
    capabilityGate.some(line => line.includes('PIPELINE_AGENT_CMD') && line.includes('1')),
    capabilityGate.join(' | ') || 'capability absent');
  check('C3-C4 production config and container launch code cannot transmit the test capability',
    capabilityGate.length > 0
      && !containerSource.includes(CAPABILITY) && !configSource.includes(CAPABILITY),
    capabilityGate.length > 0 ? 'production source unexpectedly names the capability' : 'capability absent');
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}
process.exitCode = failed;
