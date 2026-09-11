// Frozen acceptance integration proof — repo-djf.3.
// C1-C3 deliberately exercise the public runner seams instead of approving a standalone
// auth helper. Docker observation is an injected ChildProcess seam: this suite never puts a
// docker lookalike on PATH, which is unreliable on Windows and could reach a real daemon.
'use strict';
const crypto = require('crypto'); const fs = require('fs'); const os = require('os'); const path = require('path'); const { EventEmitter } = require('events');
const REPO = path.resolve(__dirname, '..', '..', '..');
const CONFIG = require(path.join(REPO, 'runner', 'config.js'));
const PREFLIGHT = require(path.join(REPO, 'runner', 'preflight.js'));
const CONTAINER_FILE = path.join(REPO, 'runner', 'container.js');
const RUN_FILE = path.join(REPO, 'runner', 'run.js');
const AUTH_FILE = path.join(REPO, 'runner', 'codex-auth.js');
let failed = 0;
function check(name, yes, detail = '') { console.log(`${yes ? 'ok' : 'FAIL'} - ${name}${yes || !detail ? '' : ` — ${detail}`}`); if (!yes) failed = 1; }
function tmp(name) { return fs.mkdtempSync(path.join(os.tmpdir(), `accept-djf3-${name}-`)); }
function secretSafe(value, secret) { const rendered = JSON.stringify(value); return (rendered === undefined ? String(value) : rendered).split(secret).join('<redacted>'); }
function config(root, raw) {
  const file = path.join(root, `run-${crypto.randomBytes(4).toString('hex')}.json`);
  fs.writeFileSync(file, JSON.stringify({ targetRepoPath: path.join(root, 'target'), targetRepoRemote: 'https://example.invalid/f.git', image: 'fixture:image', ...raw }));
  try { return { ok: true, cfg: CONFIG.loadConfig(file) }; } catch (e) { return { ok: false, reason: e.message || String(e) }; }
}
function readTree(root) { const pieces = []; const walk = p => { for (const e of fs.readdirSync(p, { withFileTypes: true })) { const q = path.join(p, e.name); e.isDirectory() ? walk(q) : pieces.push(fs.readFileSync(q, 'utf8')); } }; walk(root); return pieces.join('\n'); }

function fakeChildProcess(closeCode) {
  const child = new EventEmitter();
  child.stdout = { pipe() {} };
  child.stderr = { pipe() {} };
  process.nextTick(() => child.emit('close', closeCode));
  return child;
}

async function observeTaskLaunch(root, cfg, authCache, sourceHome, secret) {
  const emptyPath = path.join(root, 'no-host-docker');
  fs.mkdirSync(emptyPath, { recursive: true });
  const oldPath = process.env.PATH; const oldHome = process.env.CODEX_HOME; const oldKey = process.env.CODEX_API_KEY;
  // This is a safety belt for the pre-seam product only. It is not a fake executable: the
  // expected observation below comes solely from opts.spawn. If the runner ignores that seam,
  // its attempted host spawn fails harmlessly and the missing observation keeps C3 RED.
  process.env.PATH = emptyPath; process.env.CODEX_HOME = sourceHome; process.env.CODEX_API_KEY = secret;
  delete require.cache[require.resolve(CONTAINER_FILE)];
  const CONTAINER = require(CONTAINER_FILE);
  const taskDir = path.join(root, 'task'); const workspaceDir = path.join(root, 'workspace'); const pipelineDir = path.join(root, 'pipeline');
  fs.mkdirSync(taskDir, { recursive: true }); fs.mkdirSync(workspaceDir, { recursive: true }); fs.mkdirSync(pipelineDir, { recursive: true });
  let launch = null;
  const spawn = (command, argv, options) => {
    // Record the runner's real Docker invocation, but only the credential-relevant environment
    // facts so a failure can never print a host secret.
    launch = { command, argv: [...argv], env: {
      hasApiKey: Object.prototype.hasOwnProperty.call(options.env || {}, 'CODEX_API_KEY'),
      codexHome: (options.env || {}).CODEX_HOME === sourceHome ? 'operator-home' : null,
    } };
    return fakeChildProcess(0);
  };
  try {
    const result = await CONTAINER.runTask(cfg, { containerName: 'accept-djf3', workspaceDir, pipelineDir, issueId: 'repo-djf.3', taskDir, authCache, spawn, wallClockMinutes: 1, watchdogFactory: () => ({ fired: false, cancel: async () => {} }) }, { info() {}, error() {} }, 'accept-djf3');
    return { result, launch, taskDir, workspaceDir };
  } finally {
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    if (oldHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldHome;
    if (oldKey === undefined) delete process.env.CODEX_API_KEY; else process.env.CODEX_API_KEY = oldKey;
  }
}

async function main() {
  const roots = []; const secret = `chatgpt-refresh-${crypto.randomBytes(18).toString('hex')}`;
  try {
    const root = tmp('integration'); roots.push(root);
    const chatgpt = config(root, { provider: 'codex', codexAuth: 'chatgpt' }); const api = config(root, { provider: 'codex', codexAuth: 'api-key' }); const invalid = config(root, { provider: 'codex', codexAuth: 'ambient' });
    check('C1 runner/config.js selects each allowed Codex auth mode and returns an explicit refusal for another mode', chatgpt.ok && chatgpt.cfg.codexAuth === 'chatgpt' && api.ok && api.cfg.codexAuth === 'api-key' && invalid.ok === false && typeof invalid.reason === 'string' && invalid.reason.length > 0, JSON.stringify(invalid));

    // ChatGPT preparation may need to wait for its credential lane, but that must not turn the
    // established preflight API into an unconditional Promise. Existing Claude/API-key callers
    // and deterministic gate tests consume their immediate refusal synchronously.
    fs.mkdirSync(api.cfg.targetRepoPath, { recursive: true });
    const legacyPreflight = PREFLIGHT.preflight(api.cfg, root, { runId: 'accept-djf3-legacy', info() {}, error() {} }, {
      env: { CODEX_API_KEY: 'present-but-never-rendered' }, admitEntry: () => ({ ok: true, mode: 'standalone' }),
      verifyRepoIdentity: () => ({ ok: true, remoteName: 'fixture', identity: 'repo:fixture/project' }),
      resolveHostShell: () => ({ ok: false, reason: 'legacy synchronous refusal' }),
      dockerAvailable: () => { throw new Error('Docker must not run after the shell refusal'); },
    });
    check('C1-C2 ChatGPT waiting does not make legacy preflight asynchronous or reorder its existing refusal gates',
      legacyPreflight && typeof legacyPreflight.then !== 'function' && legacyPreflight.ok === false
        && legacyPreflight.shellUnavailable === true && legacyPreflight.reason === 'legacy synchronous refusal',
      JSON.stringify(legacyPreflight));

    for (const kind of ['missing', 'api-key-only', 'malformed']) {
      const sessionHome = path.join(root, `${kind}-session`); fs.mkdirSync(sessionHome, { recursive: true });
      if (kind === 'api-key-only') fs.writeFileSync(path.join(sessionHome, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: secret }));
      if (kind === 'malformed') fs.writeFileSync(path.join(sessionHome, 'auth.json'), '{ malformed');
      const logLines = []; const touched = []; const previousHome = process.env.CODEX_HOME; process.env.CODEX_HOME = sessionHome;
      let pre;
      try {
        pre = chatgpt.ok && await Promise.resolve(PREFLIGHT.preflight(chatgpt.cfg, REPO, { runId: 'accept-djf3', info: (_t, line) => logLines.push(String(line)), error() {} }, {
          env: { ...process.env, CODEX_HOME: sessionHome, CODEX_API_KEY: secret }, admitEntry: () => ({ ok: true, mode: 'standalone' }),
          verifyRepoIdentity: () => { touched.push('identity'); return { ok: false, reason: 'must not run' }; }, dockerAvailable: () => { touched.push('docker'); return { status: 1 }; }, networkUp: () => { touched.push('network'); return { ok: true }; }, recoverStaleIssues: () => { touched.push('beads'); return { recovered: [] }; },
        }));
      } finally { if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome; }
      check(`C2 runner/preflight refuses ${kind} ChatGPT state with a login/device remedy before lock or mutable runner seams`, !!pre && pre.ok === false && /codex login|device/i.test(pre.reason || '') && touched.length === 0 && !logLines.some(line => /project lock held/i.test(line)), JSON.stringify({ pre, touched, logLines }));
    }

    let AUTH = null; try { AUTH = require(AUTH_FILE); } catch {}
    const sourceHome = path.join(root, 'operator-codex'); const privateRoot = path.join(root, 'private-cache'); fs.mkdirSync(sourceHome, { recursive: true }); fs.writeFileSync(path.join(sourceHome, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: secret, refresh_token: secret } })); fs.writeFileSync(path.join(sourceHome, 'unrelated-token'), secret);
    const staged = AUTH && typeof AUTH.stageTaskCache === 'function' && await Promise.resolve(AUTH.stageTaskCache({ codexHome: sourceHome, cacheRoot: privateRoot, taskId: 'one', containerPath: '/root/.codex' }));
    const actual = staged && chatgpt.ok && await observeTaskLaunch(root, chatgpt.cfg, staged, sourceHome, secret);
    const cacheMountedWritable = actual && actual.launch && actual.launch.argv.some(arg => /:\/root\/\.codex:rw$/.test(arg));
    const safeLaunch = actual && actual.launch && actual.launch.command === 'docker'
      && actual.launch.env.hasApiKey === false && actual.launch.env.codexHome === null
      && actual.launch.argv.some((arg, i) => actual.launch.argv[i - 1] === '-e' && arg === 'CODEX_HOME=/root/.codex')
      && !actual.launch.argv.some(arg => arg === 'CODEX_API_KEY' || String(arg).startsWith('CODEX_API_KEY='));
    check('C3 runner/container.js consumes the injected spawn seam and points Codex at only the writable pipeline-owned cache, never the operator home or API key', !!actual && !!actual.launch && actual.result.exitCode === 0 && staged.hostPath.startsWith(privateRoot) && staged.hostPath !== sourceHome && cacheMountedWritable && safeLaunch, secretSafe(actual && actual.launch, secret));
    check('C3 runner/run.js awaits the credential-lane lease and supplies that cache to runTask, so a disconnected helper or fake launch cannot satisfy the suite', /await\s+(?:Promise\.resolve\()?\s*codexAuth\.stageTaskCache/.test(fs.readFileSync(RUN_FILE, 'utf8')) && /runTask\(cfg,\s*\{[\s\S]{0,1600}authCache/.test(fs.readFileSync(RUN_FILE, 'utf8')));
    const runSource = fs.readFileSync(RUN_FILE, 'utf8');
    check('C2 runner/run.js preserves the established preflight ordering and awaits a possibly asynchronous ChatGPT result before reading it',
      /const\s+pre\s*=\s*preflight\s*\(/.test(runSource)
        && /await\s+Promise\.resolve\(pre\)/.test(runSource));
    const verifier = fs.readFileSync(path.join(REPO, 'pipeline', 'entrypoint.sh'), 'utf8');
    check('C3 the staged secret never reaches workspace, task artifacts, container log, or the repository-controlled verifier environment', !!actual && !readTree(actual.workspaceDir).includes(secret) && !readTree(actual.taskDir).includes(secret) && /env\s+-u\s+CODEX_API_KEY/.test(verifier));
    if (AUTH && staged) await Promise.resolve(AUTH.releaseTaskCache(staged));
  } catch (e) { check('C1-C3 integration harness executes', false, e.stack || String(e)); }
  finally { for (const root of roots) try { fs.rmSync(root, { recursive: true, force: true }); } catch {} }
  process.exitCode = failed;
}
main();
