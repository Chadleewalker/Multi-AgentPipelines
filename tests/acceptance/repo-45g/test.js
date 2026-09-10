// Frozen acceptance test — repo-45g: add the Codex GPT provider and switch the conveyor.
// The Beads issue is canonical. PAIRING: C1 §config, C2 §host-launch, C3 §container,
// C4 §egress, C5 §normalization, C6 §admission and image CLI capability, C7 §fixtures. guard.js alone proves
// C1's byte-for-byte legacy fallback plus the legacy portion of C2/C7. Every check labels
// its criterion; no orphan criterion or check is intentional.
//
// Frozen interface (necessary because the issue names behaviours, not a JS surface):
// runner/agent-provider.js exports PROVIDERS, REASONING_EFFORTS, CODEX_REQUIRED_EXEC_FLAGS,
// missingCodexCapabilities(helpText), normalizeOutput, and preflightProvider. runner/preflight.js
// exports imageSupportsProvider(cfg, provider, execute), whose execute seam has the existing
// sh(cfg, command, args, opts) signature. The existing author-tests.js and prove-tests.js launch
// through that one adapter. `normalizeOutput(provider, raw, configuredModel)` returns
// {provider, configuredModel, model, tokenUsage, finalText, rateLimit:{resetAt,evidence}}
// or null when no structured final or rate-limit outcome exists. `preflightProvider(cfg, deps)` returns
// {ok:false, remedy} before calling a supplied side-effect seam, or {ok:true}; deps has
// executable(), authenticated(), modelAvailable(), imageSupports(), egress(), and sideEffect().
// Amendment PR #90: runner/config.js exports
// loadProviderCredential(repoRoot, provider, env), returning { name, value } or null. Its optional
// env parameter makes the host credential boundary deterministic without changing process.env.
// The C3/C6 child-process fixture invokes container.runTask with opts.credential ({ name, value })
// and replaces only its Docker spawn, preserving the production launch construction boundary.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const REPO = path.resolve(__dirname, '..', '..', '..');
const GIT_BASH = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe');
const BASH = process.platform === 'win32' && fs.existsSync(GIT_BASH) ? GIT_BASH : 'bash';
const CONFIG = require(path.join(REPO, 'runner', 'config.js'));
const AUTHOR = require(path.join(REPO, 'scripts', 'author-tests.js'));
const PROBE = require(path.join(REPO, 'scripts', 'prove-tests.js'));
const CONTAINER = require(path.join(REPO, 'runner', 'container.js'));
const ADAPTER_FILE = path.join(REPO, 'runner', 'agent-provider.js');
let adapter = null; try { adapter = require(ADAPTER_FILE); } catch { adapter = null; }
const PREFLIGHT_FILE = path.join(REPO, 'runner', 'preflight.js');
let preflight = null; try { preflight = require(PREFLIGHT_FILE); } catch { preflight = null; }
const CODEX_REQUIRED_EXEC_FLAGS = [
  '--approve-for-me', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--strict-config',
];
const CODEX_058_EXEC_HELP = [
  'Codex 0.58.0',
  'Usage: codex exec [OPTIONS] [PROMPT]',
  'Options:',
  '  --model <MODEL>',
  '  --json',
].join('\n');
const CODEX_CURRENT_EXEC_HELP = [
  'Codex current',
  'Usage: codex exec [OPTIONS] [PROMPT]',
  'Options:',
  '  --approve-for-me',
  '  --ephemeral',
  '  --ignore-user-config',
  '  --ignore-rules',
  '  --strict-config',
].join('\n');
let failed = 0;
function check(name, yes, detail = '') {
  console.log(`${yes ? 'ok' : 'FAIL'} - ${name}${yes || !detail ? '' : ` — ${detail}`}`);
  if (!yes) failed = 1;
}
function capture(fn) {
  let call = null;
  const r = fn((command, args, opts) => { call = { command, args, opts }; return { status: 47, stdout: 'fake executable', stderr: '' }; });
  return { call, r };
}
function helpExecute(helpText, status = 0) {
  const calls = [];
  return {
    calls,
    execute(cfg, command, args, opts) {
      calls.push({ cfg, command, args, opts });
      return { status, stdout: helpText, stderr: '' };
    },
  };
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-45g-'));
let c3FixtureBase = null;
const credentialFixtureBases = [];
function config(raw, suffix) {
  const p = path.join(tmp, `run.config.${suffix}.json`);
  fs.writeFileSync(p, JSON.stringify({ targetRepoPath: 'C:/fixture', targetRepoRemote: 'https://example.invalid/x.git', image: 'fixture:codex', ...raw }));
  try { return { value: CONFIG.loadConfig(p), error: null }; } catch (e) { return { value: null, error: String(e.message || e) }; }
}
function launchView(call) {
  if (!call) return 'no fake-executable invocation';
  return JSON.stringify({ command: call.command, args: call.args,
    cwd: call.opts && call.opts.cwd, timeoutMs: call.opts && call.opts.timeoutMs,
    inputLength: String((call.opts && call.opts.input) || '').length });
}
const fwd = (p) => p.split(path.sep).join('/');
const bashKind = (() => {
  const probe = spawnSync(BASH, ['-c', 'uname -s'], { encoding: 'utf8', timeout: 60000 });
  return probe.status === 0 ? (probe.stdout || '').trim() : '';
})();
// A native Windows Node process can be paired with either Git Bash or WSL bash. Git
// Bash accepts C:/ paths; WSL needs /mnt/c. Native Linux paths already need no change.
const bashPath = (p) => {
  const out = fwd(p);
  const drive = /^([A-Za-z]):\/(.*)$/.exec(out);
  return drive && bashKind === 'Linux' ? `/mnt/${drive[1].toLowerCase()}/${drive[2]}` : out;
};
const shellQuote = (p) => `"${bashPath(p).replace(/"/g, '\\"')}"`;
const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
const readJson = (p) => { try { return JSON.parse(read(p)); } catch { return null; } };
function filesBelow(dir) {
  const found = [];
  const walk = (here) => {
    for (const ent of fs.readdirSync(here, { withFileTypes: true })) {
      const file = path.join(here, ent.name);
      if (ent.isDirectory()) walk(file);
      else if (ent.isFile()) found.push(file);
    }
  };
  walk(dir);
  return found;
}
function codexCredentialFixture(secret) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-45g-c3-'));
  const ws = path.join(base, 'workspace');
  const home = path.join(base, 'home');
  const pipe = path.join(base, 'pipeline');
  const codexCapture = path.join(base, 'codex-calls.json');
  const verifierCapture = path.join(base, 'verifier-calls.json');
  const codex = path.join(base, 'fake-codex.js');
  fs.mkdirSync(path.join(ws, '.run'), { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(pipe, { recursive: true });
  for (const name of ['status.js', 'envelope.js']) {
    fs.writeFileSync(path.join(pipe, name), fs.readFileSync(path.join(REPO, 'pipeline', name), 'utf8'));
  }
  // Store only a SHA-256 comparison value. The fixture proves the exact key reached
  // Codex without itself persisting that key in an argv capture or an artifact.
  fs.writeFileSync(codex, [
    "'use strict';",
    "const crypto = require('crypto'), fs = require('fs');",
    "let stdin = ''; try { stdin = fs.readFileSync(0, 'utf8'); } catch { /* empty */ }",
    "let calls = []; try { calls = JSON.parse(fs.readFileSync(process.env.C3_CODEX_CAPTURE, 'utf8')); } catch { /* first call */ }",
    "calls.push({ argv: process.argv.slice(2), keyHash: crypto.createHash('sha256').update(process.env.CODEX_API_KEY || '').digest('hex'), docs: stdin.includes('change summary') });",
    "fs.writeFileSync(process.env.C3_CODEX_CAPTURE, JSON.stringify(calls));",
    "process.stdout.write('fixture Codex completed\\n');",
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(pipe, 'verify.js'), [
    "'use strict';",
    "const fs = require('fs');",
    "let calls = []; try { calls = JSON.parse(fs.readFileSync(process.env.C3_VERIFIER_CAPTURE, 'utf8')); } catch { /* first call */ }",
    "calls.push({ inheritedCodexKey: Object.prototype.hasOwnProperty.call(process.env, 'CODEX_API_KEY') });",
    "fs.writeFileSync(process.env.C3_VERIFIER_CAPTURE, JSON.stringify(calls));",
    'process.exit(0);',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(ws, '.run', 'issue.md'), '# repo-45g C3 fixture\n');
  const git = (args) => spawnSync('git', args, { cwd: ws, encoding: 'utf8', env: { ...process.env, HOME: fwd(home) } });
  const initialized = git(['init', '-q']);
  const committed = git(['-c', 'user.email=fixture@example.invalid', '-c', 'user.name=fixture', 'commit', '-q', '--allow-empty', '-m', 'seed']);
  const run = (initialized.status === 0 && committed.status === 0)
    ? spawnSync(BASH, [bashPath(path.join(REPO, 'pipeline', 'entrypoint.sh'))], {
      encoding: 'utf8', timeout: 120000,
      env: {
        PATH: `${bashPath(path.dirname(process.execPath))}:${process.env.PATH || ''}`,
        HOME: bashPath(home),
        WORKSPACE: bashPath(ws),
        PIPELINE_DIR: bashPath(pipe),
        ISSUE_ID: 'repo-45g',
        PIPELINE_PROVIDER: 'codex',
        PIPELINE_AGENT_CMD: `${shellQuote(process.execPath)} ${shellQuote(codex)} exec --fixture-codex`,
        PIPELINE_MAX_ATTEMPTS: '1',
        CODEX_API_KEY: secret,
        C3_CODEX_CAPTURE: bashPath(codexCapture),
        C3_VERIFIER_CAPTURE: bashPath(verifierCapture),
      },
    })
    : { status: null, stdout: '', stderr: `fixture git failed: init=${initialized.status}, commit=${committed.status}` };
  const artifactTexts = filesBelow(base).map((file) => ({ file, text: read(file) || '' }));
  return {
    base, run, codexCalls: readJson(codexCapture) || [], verifierCalls: readJson(verifierCapture) || [], artifactTexts,
    status: readJson(path.join(ws, '.run', 'status.json')),
  };
}
function runProviderContainerFixture(base, provider, credential) {
  const capture = path.join(base, `${provider}-container-capture.json`);
  const script = [
    "'use strict';",
    "const Module = require('module'), EventEmitter = require('events');",
    'const originalLoad = Module._load;',
    'let call = null; const logs = [];',
    'Module._load = function(request, parent, isMain) {',
    "  if (request === 'child_process') {",
    '    const real = originalLoad.apply(this, arguments);',
    '    return { ...real, spawn(command, args, opts) {',
    '      call = { command, args, env: opts.env }; const child = new EventEmitter();',
    '      child.stdout = { pipe() {} }; child.stderr = { pipe() {} };',
    "      process.nextTick(() => child.emit('close', 0)); return child;",
    '    }};',
    '  }',
    "  if (request === 'fs') { const real = originalLoad.apply(this, arguments); return { ...real, createWriteStream() { return {}; } }; }",
    '  return originalLoad.apply(this, arguments);',
    '};',
    "const container = require(process.env.C3_CONTAINER_FILE);",
    "const crypto = require('crypto');",
    "const hash = (value) => crypto.createHash('sha256').update(value || '').digest('hex');",
    "const credential = { name: process.env.C3_CREDENTIAL_NAME, value: process.env.C3_CREDENTIAL_VALUE };",
    "const log = { info(trace, text) { logs.push(String(text)); }, error(trace, text) { logs.push(String(text)); } };",
    "container.runTask({ network: 'fixture-net', proxyUrl: 'http://fixture-proxy:3128', image: 'fixture:image', wallClockMinutes: 1 },",
    "  { containerName: 'fixture-' + process.env.C3_PROVIDER, workspaceDir: 'C:/fixture/workspace', pipelineDir: 'C:/fixture/pipeline',",
    "    issueId: 'repo-45g', taskDir: process.cwd(), credential, watchdogFactory: () => ({ fired: false, cancel: async () => {} }) }, log, 'fixture')",
    "  .then(() => console.log(JSON.stringify({ command: call && call.command, args: call && call.args, envKeys: Object.keys((call && call.env) || {}).sort(),",
    "    credentialHash: hash(call && call.env && call.env[credential.name]), logs })))",
    "  .catch(() => { process.exitCode = 1; });",
  ].join('\n');
  const run = spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8', timeout: 60000,
    env: {
      ...process.env, C3_CONTAINER_FILE: path.join(REPO, 'runner', 'container.js'), C3_PROVIDER: provider,
      C3_CREDENTIAL_NAME: credential && credential.name, C3_CREDENTIAL_VALUE: credential && credential.value,
    },
  });
  fs.writeFileSync(capture, run.stdout || '');
  return { run, capture: readJson(capture) };
}
function providerCredentialFixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-45g-credential-'));
  credentialFixtureBases.push(base);
  const envFile = path.join(base, '.env.pipeline');
  const planted = {
    codexFile: `codex-file-${crypto.randomBytes(12).toString('hex')}`,
    codexAmbient: `codex-ambient-${crypto.randomBytes(12).toString('hex')}`,
    claudeFile: `claude-file-${crypto.randomBytes(12).toString('hex')}`,
    claudeAmbient: `claude-ambient-${crypto.randomBytes(12).toString('hex')}`,
    codexBoth: `codex-both-${crypto.randomBytes(12).toString('hex')}`,
    claudeBoth: `claude-both-${crypto.randomBytes(12).toString('hex')}`,
  };
  const load = (provider, env) => typeof CONFIG.loadProviderCredential === 'function'
    ? CONFIG.loadProviderCredential(base, provider, env) : null;
  // Codex has no Claude fallback: first prove .env.pipeline and then ambient-only selection.
  fs.writeFileSync(envFile, `CODEX_API_KEY=${planted.codexFile}\n`);
  const codexFromFile = load('codex', {});
  fs.rmSync(envFile, { force: true });
  const codexFromAmbient = load('codex', { CODEX_API_KEY: planted.codexAmbient });
  const codexMissing = load('codex', {});
  // Claude retains its historical source order and missing-token outcome.
  fs.writeFileSync(envFile, `CLAUDE_CODE_OAUTH_TOKEN=${planted.claudeFile}\n`);
  const claudeFromFile = load('claude', {});
  fs.rmSync(envFile, { force: true });
  const claudeFromAmbient = load('claude', { CLAUDE_CODE_OAUTH_TOKEN: planted.claudeAmbient });
  const claudeMissing = load('claude', {});
  // These values deliberately differ. Each selected value then traverses real runTask launch
  // construction, while the subprocess replaces only `docker` and returns a redacted capture.
  fs.writeFileSync(envFile, [
    `CODEX_API_KEY=${planted.codexBoth}`,
    `CLAUDE_CODE_OAUTH_TOKEN=${planted.claudeBoth}`,
    '',
  ].join('\n'));
  const codexBoth = load('codex', {});
  const claudeBoth = load('claude', {});
  const codexTask = runProviderContainerFixture(base, 'codex', codexBoth);
  const claudeTask = runProviderContainerFixture(base, 'claude', claudeBoth);
  // .env.pipeline is input, not a runner artifact. Remove it before inspecting every generated
  // fixture artifact for either planted value, including any fake launch capture a future seam adds.
  fs.rmSync(envFile, { force: true });
  const artifacts = filesBelow(base).map((file) => read(file) || '');
  return {
    planted, codexFromFile, codexFromAmbient, codexMissing, claudeFromFile, claudeFromAmbient, claudeMissing,
    codexBoth, claudeBoth, codexTask, claudeTask, artifacts,
  };
}
try {
  // C1 — closed global/stage selections and reasoning validation.
  const codex = config({ provider: 'codex', model: 'gpt-5.3-codex', reasoningEffort: 'high',
    testAuthorProvider: 'codex', testAuthorReasoningEffort: 'medium',
    testProbeProvider: 'claude', testProbeReasoningEffort: 'low' }, 'codex');
  check('C1 run config accepts only the selected provider vocabulary globally and per author/probe stage',
    codex.error === null && codex.value.provider === 'codex' && codex.value.testAuthorProvider === 'codex' && codex.value.testProbeProvider === 'claude', codex.error || JSON.stringify(codex.value));
  check('C1 run config retains validated global and per-stage reasoning effort',
    codex.error === null && codex.value.reasoningEffort === 'high' && codex.value.testAuthorReasoningEffort === 'medium' && codex.value.testProbeReasoningEffort === 'low');
  const badProvider = config({ provider: 'openai' }, 'bad-provider');
  const badEffort = config({ provider: 'codex', reasoningEffort: 'thoughtful' }, 'bad-effort');
  check('C1 rejects a provider outside claude|codex by the field name before launch', !!badProvider.error && /provider/i.test(badProvider.error), badProvider.error);
  check('C1 rejects an invalid stage reasoning effort by the field name before launch', !!badEffort.error && /reasoning/i.test(badEffort.error), badEffort.error);
  const legacy = config({}, 'legacy');
  check('C1 absent provider fields normalize to Claude and retain Claude defaults',
    legacy.error === null && legacy.value.provider === 'claude' && legacy.value.testAuthorProvider === 'claude' && legacy.value.testProbeProvider === 'claude');

  // C2 — two deterministic fake executable launches. The fake status proves propagation.
  const codexSecret = `codex-${crypto.randomBytes(12).toString('hex')}`;
  const built = { id: 'repo-45g', suiteId: 'repo-45g', text: 'codex stdin prompt', policy: { verifyCommand: 'sh tools/run-acceptance.sh' },
    folder: { dir: 'C:/author fixture' }, cfg: { provider: 'codex', testAuthorProvider: 'codex', testProbeProvider: 'codex',
      model: 'gpt-5.6-terra', reasoningEffort: 'high', testAuthorReasoningEffort: 'high', testProbeReasoningEffort: 'medium', wallClockMinutes: 2,
      hostEnv: { HOST_ONLY: 'must-not-enter-probe', CODEX_API_KEY: codexSecret } } };
  const author = capture((run) => AUTHOR.launchAuthor(built, 'gpt-5.6-terra', run));
  const probe = capture((run) => PROBE.launchProbe(built, { probe: 'C:/probe fixture' }, 'gpt-5.6-terra', '', run));
  const authorArgs = [
    'exec', '--model', 'gpt-5.6-terra', '-c', 'model_reasoning_effort="high"',
    '-c', 'shell_environment_policy.ignore_default_excludes=false',
    '-c', 'shell_environment_policy.filters.CODEX_API_KEY="exclude"',
    '--approve-for-me', '--ephemeral', '--ignore-user-config', '--ignore-rules',
    '--strict-config', '--json', '-',
  ];
  const probeArgs = [
    'exec', '--model', 'gpt-5.6-terra', '-c', 'model_reasoning_effort="medium"',
    '-c', 'shell_environment_policy.ignore_default_excludes=false',
    '-c', 'shell_environment_policy.filters.CODEX_API_KEY="exclude"',
    '--approve-for-me', '--ephemeral', '--ignore-user-config', '--ignore-rules',
    '--strict-config', '--json', '-',
  ];
  check('C2 Codex test-author fake executable receives the exact noninteractive Codex argv and prompt stdin',
    author.call && author.call.command === 'codex' && JSON.stringify(author.call.args) === JSON.stringify(authorArgs)
      && author.call.opts.input === 'codex stdin prompt\n' && author.call.opts.timeoutMs === 120000, launchView(author.call));
  check('C2 Codex green-probe fake executable receives its exact noninteractive Codex argv and prompt stdin',
    probe.call && probe.call.command === 'codex' && JSON.stringify(probe.call.args) === JSON.stringify(probeArgs)
      && probe.call.opts.input.includes('GREEN PROBE') && probe.call.opts.timeoutMs === 120000, launchView(probe.call));
  check('C2 fake executable exit codes propagate unchanged and existing author/probe tree audits remain exported',
    author.r.status === 47 && probe.r.status === 47 && typeof AUTHOR.auditAuthorTree === 'function' && typeof PROBE.invariantErrors === 'function');
  let authorSource = ''; let probeSource = ''; try { authorSource = fs.readFileSync(path.join(REPO, 'scripts', 'author-tests.js'), 'utf8'); probeSource = fs.readFileSync(path.join(REPO, 'scripts', 'prove-tests.js'), 'utf8'); } catch { /* named check below */ }
  check('C2 one provider adapter constructs both host launch paths',
    fs.existsSync(ADAPTER_FILE) && /agent-provider/.test(authorSource) && /agent-provider/.test(probeSource));

  // C3 — credential is by name only in Docker argv; policy is handed to the CLI, not child shells.
  const secret = `codex-${crypto.randomBytes(12).toString('hex')}`;
  const dockerArgs = CONTAINER.buildArgs({ network: 'fixture-net', proxyUrl: 'http://fixture-proxy:3128', image: 'fixture:codex', provider: 'codex', model: 'gpt-5.6-terra', reasoningEffort: 'high' },
    { containerName: 'fixture-task', workspaceDir: 'C:/workspace', pipelineDir: 'C:/pipeline', issueId: 'repo-45g', token: secret });
  check('C3 Codex Docker argv passes CODEX_API_KEY only by environment-variable name, never the value or Claude token',
    dockerArgs.includes('CODEX_API_KEY') && !dockerArgs.join('\n').includes(secret) && !dockerArgs.includes('CLAUDE_CODE_OAUTH_TOKEN'), JSON.stringify(dockerArgs));
  const entry = fs.readFileSync(path.join(REPO, 'pipeline', 'entrypoint.sh'), 'utf8');
  const c3Fixture = codexCredentialFixture(secret);
  c3FixtureBase = c3Fixture.base;
  const secretHash = crypto.createHash('sha256').update(secret).digest('hex');
  const c3RunText = `${c3Fixture.run.stdout || ''}${c3Fixture.run.stderr || ''}`;
  const c3ArgvHasSecret = c3Fixture.codexCalls.some((call) => JSON.stringify(call.argv).includes(secret));
  const c3ArtifactHasSecret = c3Fixture.artifactTexts.some(({ text }) => text.includes(secret));
  check('C3 Codex credential-isolation fixture reaches verified success through the real entrypoint',
    c3Fixture.run.status === 0 && c3Fixture.status && Array.isArray(c3Fixture.status.attempts)
      && c3Fixture.status.attempts.length === 1 && c3Fixture.status.attempts[0].verifierResult === 'pass', c3Fixture.run.stderr);
  check('C3 both code- and docs-phase fake Codex invocations receive the exact Docker key only for those CLI calls',
    c3Fixture.codexCalls.some((call) => call.docs === false) && c3Fixture.codexCalls.some((call) => call.docs === true)
      && c3Fixture.codexCalls.every((call) => call.keyHash === secretHash), JSON.stringify(c3Fixture.codexCalls));
  check('C3 repository-controlled verifier invocations do not inherit CODEX_API_KEY',
    c3Fixture.verifierCalls.length > 0 && c3Fixture.verifierCalls.every((call) => call.inheritedCodexKey === false),
    JSON.stringify(c3Fixture.verifierCalls));
  check('C3 planted Codex key is absent from fake CLI argv, entrypoint logs, and every captured fixture artifact',
    !c3ArgvHasSecret && !c3RunText.includes(secret) && !c3ArtifactHasSecret,
    JSON.stringify({ argv: c3ArgvHasSecret, log: c3RunText.includes(secret), artifact: c3ArtifactHasSecret }));
  // PR #90 amendment — this is the host-side boundary, before preflight or Docker. The temporary
  // root keeps .env.pipeline selection deterministic; its fake Docker observes the real runTask
  // launch construction that hands exactly one selected credential to its child process.
  const providerCredentials = providerCredentialFixture();
  const isCredential = (credential, name, value) => credential
    && credential.name === name && credential.value === value;
  const codexLaunchIsolated = providerCredentials.codexTask.run.status === 0 && providerCredentials.codexTask.capture
    && providerCredentials.codexTask.capture.command === 'docker'
    && providerCredentials.codexTask.capture.args.includes('CODEX_API_KEY')
    && !providerCredentials.codexTask.capture.args.includes('CLAUDE_CODE_OAUTH_TOKEN')
    && providerCredentials.codexTask.capture.envKeys.includes('CODEX_API_KEY')
    && !providerCredentials.codexTask.capture.envKeys.includes('CLAUDE_CODE_OAUTH_TOKEN')
    && providerCredentials.codexTask.capture.credentialHash === crypto.createHash('sha256').update(providerCredentials.planted.codexBoth).digest('hex');
  const claudeLaunchIsolated = providerCredentials.claudeTask.run.status === 0 && providerCredentials.claudeTask.capture
    && providerCredentials.claudeTask.capture.command === 'docker'
    && providerCredentials.claudeTask.capture.args.includes('CLAUDE_CODE_OAUTH_TOKEN')
    && !providerCredentials.claudeTask.capture.args.includes('CODEX_API_KEY')
    && providerCredentials.claudeTask.capture.envKeys.includes('CLAUDE_CODE_OAUTH_TOKEN')
    && !providerCredentials.claudeTask.capture.envKeys.includes('CODEX_API_KEY')
    && providerCredentials.claudeTask.capture.credentialHash === crypto.createHash('sha256').update(providerCredentials.planted.claudeBoth).digest('hex');
  const plantedValues = Object.values(providerCredentials.planted);
  const launchArgvLeaks = [providerCredentials.codexTask.capture, providerCredentials.claudeTask.capture]
    .some((capture) => capture && plantedValues.some((value) => (capture.args || []).join('\n').includes(value)));
  const launchLogLeaks = [providerCredentials.codexTask.run, providerCredentials.claudeTask.run]
    .some((run) => plantedValues.some((value) => `${run.stdout || ''}${run.stderr || ''}`.includes(value)));
  const fixtureArtifactLeaks = providerCredentials.artifacts
    .some((text) => plantedValues.some((value) => text.includes(value)));
  check('C3/C6 provider-aware config boundary selects the exact Codex .env.pipeline or ambient CODEX_API_KEY with no Claude fallback',
    isCredential(providerCredentials.codexFromFile, 'CODEX_API_KEY', providerCredentials.planted.codexFile)
      && isCredential(providerCredentials.codexFromAmbient, 'CODEX_API_KEY', providerCredentials.planted.codexAmbient)
      && providerCredentials.codexMissing === null,
    JSON.stringify({ loader: typeof CONFIG.loadProviderCredential, codexMissing: providerCredentials.codexMissing === null }));
  check('C3/C6 provider-aware config boundary preserves Claude .env.pipeline and ambient selection plus its historical missing-token diagnostic',
    isCredential(providerCredentials.claudeFromFile, 'CLAUDE_CODE_OAUTH_TOKEN', providerCredentials.planted.claudeFile)
      && isCredential(providerCredentials.claudeFromAmbient, 'CLAUDE_CODE_OAUTH_TOKEN', providerCredentials.planted.claudeAmbient)
      && providerCredentials.claudeMissing === null
      && typeof CONFIG.missingCredentialDiagnostic === 'function'
      && CONFIG.missingCredentialDiagnostic('claude') === 'no CLAUDE_CODE_OAUTH_TOKEN (.env.pipeline or environment) — tasks cannot authenticate',
    JSON.stringify({ loader: typeof CONFIG.loadProviderCredential, diagnostic: typeof CONFIG.missingCredentialDiagnostic }));
  check('C3/C6 both planted provider credentials remain paired to their own environment-variable name at the bounded container launch seam',
    isCredential(providerCredentials.codexBoth, 'CODEX_API_KEY', providerCredentials.planted.codexBoth)
      && isCredential(providerCredentials.claudeBoth, 'CLAUDE_CODE_OAUTH_TOKEN', providerCredentials.planted.claudeBoth)
      && codexLaunchIsolated && claudeLaunchIsolated,
    JSON.stringify({ seam: 'runTask fake-docker', codex: !!codexLaunchIsolated, claude: !!claudeLaunchIsolated }));
  check('C3/C6 provider credential fixture never puts planted values in Docker argv, logs, or generated artifacts',
    !launchArgvLeaks && !launchLogLeaks && !fixtureArtifactLeaks,
    JSON.stringify({ argv: launchArgvLeaks, log: launchLogLeaks, artifact: fixtureArtifactLeaks }));
  check('C3 captured Codex launch keeps the authentication key in its process environment but not argv, with default and explicit secret-name filtering',
    author.call && author.call.opts.env.CODEX_API_KEY === codexSecret && !author.call.args.includes(codexSecret)
      && author.call.args.includes('shell_environment_policy.ignore_default_excludes=false')
      && author.call.args.includes('shell_environment_policy.filters.CODEX_API_KEY="exclude"'), launchView(author.call));
  check('C3 Codex declares the exact frozen exec capability roster and rejects every capability missing from planted Codex 0.58 help',
    adapter && JSON.stringify(adapter.CODEX_REQUIRED_EXEC_FLAGS) === JSON.stringify(CODEX_REQUIRED_EXEC_FLAGS)
      && typeof adapter.missingCodexCapabilities === 'function'
      && JSON.stringify(adapter.missingCodexCapabilities(CODEX_058_EXEC_HELP)) === JSON.stringify(CODEX_REQUIRED_EXEC_FLAGS),
    adapter ? JSON.stringify(adapter.CODEX_REQUIRED_EXEC_FLAGS) : 'agent provider unavailable');
  check('C3 Codex structural current exec --help containing every required capability has no missing capability',
    adapter && typeof adapter.missingCodexCapabilities === 'function'
      && JSON.stringify(adapter.missingCodexCapabilities(CODEX_CURRENT_EXEC_HELP)) === '[]');
  const dockerfile = fs.readFileSync(path.join(REPO, 'docker', 'base', 'Dockerfile'), 'utf8');
  const dockerBuildInstructions = dockerfile.replace(/\\\r?\n/g, ' ').split(/\r?\n/)
    .filter((line) => /^\s*RUN\s/.test(line));
  check('C3 Dockerfile pins @openai/codex@0.154.0 exactly and checks codex exec --help for every required capability at build time',
    /@openai\/codex@0\.154\.0(?=\s|$)/.test(dockerfile)
      && dockerBuildInstructions.some((instruction) => /codex\s+exec\s+--help/.test(instruction)
        && CODEX_REQUIRED_EXEC_FLAGS.every((flag) => instruction.includes(flag))), dockerfile);
  check('C3 source-level pin sanity specifically rejects incompatible @openai/codex@0.58.0',
    !/@openai\/codex@0\.58\.0(?=\s|$)/.test(dockerfile), dockerfile);
  // C4 — a dedicated concrete OpenAI deny-by-default profile; the Anthropic profile must survive.
  const codexAllow = path.join(REPO, 'docker', 'proxy-codex', 'allowlist.txt');
  const anthAllow = path.join(REPO, 'docker', 'proxy', 'allowlist.txt');
  const allowText = fs.existsSync(codexAllow) ? fs.readFileSync(codexAllow, 'utf8') : '';
  const netText = fs.readFileSync(path.join(REPO, 'scripts', 'pipeline-net.sh'), 'utf8') + fs.readFileSync(path.join(REPO, 'scripts', 'egress-check.sh'), 'utf8');
  check('C4 Codex selects a separate deny-by-default proxy profile containing only concrete OpenAI endpoints',
    fs.existsSync(codexAllow) && /^api\.openai\.com$/m.test(allowText) && !/anthropic|\*/i.test(allowText) && /codex/i.test(netText));
  check('C4 provider-aware egress preflight names reachable selected endpoint, blocked unrelated hosts, and blocked direct egress',
    /openai/i.test(netText) && /github\.com/.test(netText) && /registry\.npmjs\.org/.test(netText) && /direct/i.test(netText));

  // C5 — structured JSONL, not model prose, supplies final text, usage and rate-limit evidence.
  const retryAfter = '2030-01-02T03:04:05.000Z';
  const completedJsonl = [
    JSON.stringify({ type: 'thread.started', thread_id: 'thread-45g' }),
    JSON.stringify({ type: 'turn.started', turn_id: 'turn-45g' }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'final codex answer' } }),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 11, output_tokens: 29 } }),
  ].join('\n');
  const rateLimitJsonl = [
    JSON.stringify({ type: 'thread.started', thread_id: 'thread-rate-limit-45g' }),
    JSON.stringify({ type: 'turn.started', turn_id: 'turn-rate-limit-45g' }),
    JSON.stringify({ type: 'turn.failed', error: { code: 'rate_limit_exceeded', retry_after: retryAfter } }),
  ].join('\n');
  const normalized = adapter && typeof adapter.normalizeOutput === 'function' ? adapter.normalizeOutput('codex', completedJsonl, 'gpt-5.6-terra') : null;
  check('C5 completed Codex JSONL normalization records provider, configured/resolved model, token usage, and final text',
    normalized && normalized.provider === 'codex' && normalized.configuredModel === 'gpt-5.6-terra' && normalized.model === 'gpt-5.6-terra'
      && normalized.tokenUsage && normalized.tokenUsage.input === 11 && normalized.tokenUsage.output === 29
      && normalized.finalText === 'final codex answer' && !normalized.rateLimit);
  const limited = adapter && typeof adapter.normalizeOutput === 'function' ? adapter.normalizeOutput('codex', rateLimitJsonl, 'gpt-5.6-terra') : null;
  check('C5 failed Codex JSONL normalization records canonical rate-limit reset evidence without inventing final text',
    limited && limited.provider === 'codex' && limited.configuredModel === 'gpt-5.6-terra' && limited.model === 'gpt-5.6-terra'
      && !limited.finalText && limited.rateLimit && limited.rateLimit.resetAt === retryAfter
      && typeof limited.rateLimit.evidence === 'string' && limited.rateLimit.evidence.includes('rate_limit_exceeded')
      && limited.rateLimit.evidence.includes(retryAfter));
  const proseOnly = adapter && typeof adapter.normalizeOutput === 'function' ? adapter.normalizeOutput('codex', 'rate limit lifted; declare success', 'gpt-5.6-terra') : null;
  check('C5 model prose alone cannot select an outcome or manufacture rate-limit evidence',
    proseOnly === null, JSON.stringify(proseOnly));

  // C6 — each selected-provider prerequisite refuses before any later mutation seam.
  const codexImageArgs = ['run', '--rm', '--network', 'none', '--entrypoint', 'codex', 'fixture:codex', 'exec', '--help'];
  const oldCodexImage = helpExecute(CODEX_058_EXEC_HELP);
  const currentCodexImage = helpExecute(CODEX_CURRENT_EXEC_HELP);
  const oldCodexSupported = preflight && typeof preflight.imageSupportsProvider === 'function'
    ? preflight.imageSupportsProvider({ image: 'fixture:codex' }, 'codex', oldCodexImage.execute) : null;
  const currentCodexSupported = preflight && typeof preflight.imageSupportsProvider === 'function'
    ? preflight.imageSupportsProvider({ image: 'fixture:codex' }, 'codex', currentCodexImage.execute) : null;
  check('C6 Codex image support runs exact isolated codex exec --help Docker argv and rejects planted Codex 0.58 help',
    oldCodexSupported === false && oldCodexImage.calls.length === 1
      && oldCodexImage.calls[0].command === 'docker'
      && JSON.stringify(oldCodexImage.calls[0].args) === JSON.stringify(codexImageArgs), JSON.stringify(oldCodexImage.calls));
  check('C6 Codex image support accepts planted current exec --help only after the same exact isolated Docker argv',
    currentCodexSupported === true && currentCodexImage.calls.length === 1
      && currentCodexImage.calls[0].command === 'docker'
      && JSON.stringify(currentCodexImage.calls[0].args) === JSON.stringify(codexImageArgs), JSON.stringify(currentCodexImage.calls));
  const claudeImageArgs = ['run', '--rm', '--network', 'none', '--entrypoint', 'claude', 'fixture:claude', '--version'];
  const claudeImageOk = helpExecute('claude version');
  const claudeImage = helpExecute('claude version', 23);
  const claudeSupportedOk = preflight && typeof preflight.imageSupportsProvider === 'function'
    ? preflight.imageSupportsProvider({ image: 'fixture:claude' }, 'claude', claudeImageOk.execute) : null;
  const claudeSupported = preflight && typeof preflight.imageSupportsProvider === 'function'
    ? preflight.imageSupportsProvider({ image: 'fixture:claude' }, 'claude', claudeImage.execute) : null;
  check('C6 Claude image support preserves the historical exact claude --version Docker argv and status behavior',
    claudeSupportedOk === true && claudeImageOk.calls.length === 1
      && claudeImageOk.calls[0].command === 'docker'
      && JSON.stringify(claudeImageOk.calls[0].args) === JSON.stringify(claudeImageArgs)
      && claudeSupported === false && claudeImage.calls.length === 1
      && claudeImage.calls[0].command === 'docker'
      && JSON.stringify(claudeImage.calls[0].args) === JSON.stringify(claudeImageArgs), JSON.stringify(claudeImage.calls));
  const preflightCases = [
    ['executable', /install.*codex|codex.*path/i],
    ['authenticated', /codex login|CODEX_API_KEY|authenticat/i],
    ['modelAvailable', /model.*available|configure.*model/i],
    ['imageSupports', /image.*codex|codex.*image/i],
    ['egress', /egress.*api\.openai\.com|api\.openai\.com.*egress/i],
  ];
  for (const [missing, remedy] of preflightCases) {
    let effects = 0;
    const deps = {
      executable: () => true, authenticated: () => true, modelAvailable: () => true,
      imageSupports: () => true, egress: () => true, sideEffect: () => { effects += 1; },
    };
    deps[missing] = () => false;
    const readiness = adapter && typeof adapter.preflightProvider === 'function'
      ? adapter.preflightProvider({ provider: 'codex', model: 'gpt-5.6-terra', image: 'fixture:codex' }, deps) : null;
    check(`C6 missing selected Codex ${missing} independently refuses before any mutation and gives its actionable remedy`,
      readiness && readiness.ok === false && effects === 0 && typeof readiness.remedy === 'string' && remedy.test(readiness.remedy), JSON.stringify(readiness));
  }

  // C7 — the full Docker-free fixture surface and an explicitly opt-in read-only live smoke.
  const source = fs.readFileSync(__filename, 'utf8');
  check('C7 this Docker-free suite exercises author, probe, implementation command, credentials, JSONL output, rate-limit, and legacy-Claude paths',
    !!adapter && /test-author/.test(source) && /green-probe/.test(source) && /PIPELINE_AGENT_CMD/.test(entry) && /CODEX_API_KEY/.test(source) && /JSONL/.test(source) && /rate-limit/.test(source) && /legacy-Claude/.test(source));
  const liveSmoke = path.join(REPO, 'scripts', 'codex-live-smoke.js');
  const liveSmokeText = fs.existsSync(liveSmoke) ? fs.readFileSync(liveSmoke, 'utf8') : '';
  check('C7 a dedicated read-only live Codex smoke helper is opt-in and documents the configured GPT model',
    fs.existsSync(liveSmoke) && /CODEX_LIVE_SMOKE/.test(liveSmokeText) && /--sandbox/.test(liveSmokeText)
      && /read-only/.test(liveSmokeText) && /--ephemeral/.test(liveSmokeText)
      && /--model/.test(liveSmokeText) && /gpt-5\.6-terra/.test(liveSmokeText));
} catch (e) {
  failed = 1;
  console.log(`FAIL - HARNESS BROKEN: unexpected exception: ${e && e.stack ? e.stack : e}`);
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* disposable */ }
  try { if (c3FixtureBase) fs.rmSync(c3FixtureBase, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* disposable */ }
  for (const base of credentialFixtureBases) {
    try { fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* disposable */ }
  }
}
process.exit(failed);
