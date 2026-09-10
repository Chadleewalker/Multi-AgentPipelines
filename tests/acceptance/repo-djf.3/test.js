// Frozen acceptance test — repo-djf.3: ChatGPT subscription auth in isolated Codex workers.
// PAIRING: C1 auth-mode config/no fallback; C2 preflight ordering and remedies; C3 private
// task cache/no secret disclosure; C4 refresh, interruption and concurrent lifecycle; C5
// Docker-free coverage and opt-in pinned-image live smoke. guard.js solely proves C1 legacy API-key behaviour.
//
// Frozen interface: runner/codex-auth.js exports AUTH_MODES, validateConfig(raw), preflight(opts),
// stageTaskCache(opts), releaseTaskCache(handle), and withCacheLock(opts, fn). All accept dependency
// seams named fs/spawn/log for Docker-free operation. stageTaskCache returns { hostPath, containerPath,
// mount, cleanup }; preflight returns { ok, reason } and calls no mutation seam on refusal.
'use strict';
const crypto = require('crypto'); const fs = require('fs'); const os = require('os'); const path = require('path');
const { spawnSync } = require('child_process');
const REPO = path.resolve(__dirname, '..', '..', '..');
const AUTH_FILE = path.join(REPO, 'runner', 'codex-auth.js');
const SMOKE_FILE = path.join(REPO, 'scripts', 'codex-live-smoke.js');
let AUTH = null; try { AUTH = require(AUTH_FILE); } catch { /* C1 exposes the missing implementation */ }
let failed = 0;
function check(name, yes, detail = '') { console.log(`${yes ? 'ok' : 'FAIL'} - ${name}${yes || !detail ? '' : ` — ${detail}`}`); if (!yes) failed = 1; }
function tmp(name) { return fs.mkdtempSync(path.join(os.tmpdir(), `accept-djf3-${name}-`)); }
function secretSafe(value, secret) { const rendered = JSON.stringify(value); return (rendered === undefined ? String(value) : rendered).split(secret).join('<redacted>'); }
function textBelow(root) { const out = []; const walk = p => { for (const e of fs.readdirSync(p, { withFileTypes:true })) { const q=path.join(p,e.name); e.isDirectory() ? walk(q) : out.push(fs.readFileSync(q, 'utf8')); } }; walk(root); return out.join('\n'); }
function auth() { return AUTH && ['validateConfig','preflight','stageTaskCache','releaseTaskCache','withCacheLock'].every(k => typeof AUTH[k] === 'function') ? AUTH : null; }
const secret = `chatgpt-refresh-${crypto.randomBytes(18).toString('hex')}`;
const roots = [];
try {
  const a = auth();
  const config = a && a.validateConfig({ provider: 'codex', codexAuth: 'chatgpt' });
  const api = a && a.validateConfig({ provider: 'codex', codexAuth: 'api-key' });
  const invalid = a && a.validateConfig({ provider: 'codex', codexAuth: 'ambient' });
  // A deterministic rejection may be a falsy return or a structured { ok:false, reason }
  // refusal. The contract is explicit rejection with a useful diagnostic, not JavaScript
  // truthiness of a particular private helper result.
  const invalidRefused = !invalid || (invalid.ok === false && typeof invalid.reason === 'string' && invalid.reason.length > 0);
  check('C1 run configuration explicitly accepts only chatgpt and api-key Codex authentication modes and explicitly refuses another mode', !!a && config && config.codexAuth === 'chatgpt' && api && api.codexAuth === 'api-key' && invalidRefused, String(invalid && invalid.reason));
  let example = null; try { example = JSON.parse(fs.readFileSync(path.join(REPO, 'run.config.example.json'), 'utf8')); } catch {}
  check('C1 the checked-in run-config template declares ChatGPT auth without changing its canonical Claude defaults', !!example
    && example.provider === 'claude' && example.testAuthorProvider === 'claude' && example.testProbeProvider === 'claude'
    && example.model === 'opus' && example.testAuthorModel === 'opus' && example.testProbeModel === 'opus'
    && example.codexAuth === 'chatgpt');
  const noFallback = a && a.validateConfig({ provider: 'codex', codexAuth: 'chatgpt', CODEX_API_KEY: secret });
  check('C1 ChatGPT mode does not select or expose an API key as a fallback', !!noFallback && noFallback.credentialName !== 'CODEX_API_KEY' && !JSON.stringify(noFallback).includes(secret));

  let allowlist = []; try { allowlist = fs.readFileSync(path.join(REPO, 'docker', 'proxy-codex', 'allowlist.txt'), 'utf8').split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith('#')); } catch {}
  check('C5 the Codex proxy permits exactly the API and observed ChatGPT subscription hosts', JSON.stringify([...allowlist].sort()) === JSON.stringify(['ab.chatgpt.com', 'api.openai.com', 'chatgpt.com']));
  let dockerfile = ''; try { dockerfile = fs.readFileSync(path.join(REPO, 'docker', 'base', 'Dockerfile'), 'utf8'); } catch {}
  const traversal = dockerfile.search(/chmod\s+755\s+\/root/); const nonroot = dockerfile.search(/^USER\s+node\s*$/m);
  check('C5 the task image grants cache-path traversal before retaining the non-root node user', traversal >= 0 && nonroot > traversal && !dockerfile.slice(nonroot).includes('USER root'));

  const root = tmp('preflight'); roots.push(root); const calls = [];
  const missing = a && a.preflight({ mode: 'chatgpt', codexHome: path.join(root, 'no-session'), cacheRoot: path.join(root, 'cache'),
    mutate: n => calls.push(n), env: { CODEX_API_KEY: secret } });
  check('C2 missing or API-key-only ChatGPT login refuses before lock, Beads, network, workspace, or container mutation', !!missing && !missing.ok && /codex login|device/i.test(missing.reason || '') && calls.length === 0, JSON.stringify({ missing, calls }));
  fs.mkdirSync(path.join(root, 'home'), { recursive:true }); fs.writeFileSync(path.join(root, 'home', 'auth.json'), '{ malformed');
  const malformed = a && a.preflight({ mode: 'chatgpt', codexHome: path.join(root, 'home'), cacheRoot: path.join(root, 'cache'), mutate: n => calls.push(n) });
  check('C2 malformed or unreadable saved auth gives the same bounded login/device remedy and launches nothing', !!malformed && !malformed.ok && /codex login|device/i.test(malformed.reason || '') && calls.length === 0);

  const croot = tmp('container'); roots.push(croot); const userHome = path.join(croot, 'user-home'); const privateRoot = path.join(croot, 'private'); fs.mkdirSync(userHome, { recursive:true }); fs.writeFileSync(path.join(userHome, 'auth.json'), JSON.stringify({ tokens:{ access_token:secret } })); fs.writeFileSync(path.join(userHome, 'unrelated-provider-token'), secret);
  const staged = a && a.stageTaskCache({ codexHome:userHome, cacheRoot:privateRoot, taskId:'one', containerPath:'/root/.codex' });
  check('C3 helper staging makes a writable task-private cache rather than returning the operator Codex home', !!staged && staged.containerPath === '/root/.codex' && staged.hostPath.startsWith(privateRoot) && staged.hostPath !== userHome);
  // The launch, verifier, artifact, and log boundaries are observed through the real runner in
  // integration.js. Deliberately do not scan the source fixture: its auth.json is supposed to
  // contain this test's token.

  const lroot = tmp('lifecycle'); roots.push(lroot); const durable = path.join(lroot, 'durable'); fs.mkdirSync(durable, { recursive:true }); fs.writeFileSync(path.join(durable, 'auth.json'), JSON.stringify({ token:'before' }));
  const first = a && a.withCacheLock({ cacheRoot:durable }, () => { fs.writeFileSync(path.join(durable, 'auth.json'), JSON.stringify({ token:'after' })); return a.stageTaskCache({ cacheRoot:durable, taskId:'first' }); });
  const second = a && a.withCacheLock({ cacheRoot:durable }, () => a.stageTaskCache({ cacheRoot:durable, taskId:'second' }));
  const refreshed = fs.readFileSync(path.join(durable, 'auth.json'), 'utf8');
  check('C4 successful refresh persists to the host-private cache across sequential task launches', !!first && !!second && /after/.test(refreshed));
  const concurrent = a && Promise.all([1,2].map(n => a.withCacheLock({ cacheRoot:durable }, () => a.stageTaskCache({ cacheRoot:durable, taskId:`parallel-${n}` }))));
  check('C4 concurrent workers use the cache lifecycle lock and produce separate recoverable task copies', !!concurrent && typeof concurrent.then === 'function');
  const handle = staged; if (a && handle) a.releaseTaskCache(handle);
  check('C4 interruption/cleanup removes only a task copy and leaves the durable refreshed cache recoverable', !!a && fs.existsSync(path.join(durable,'auth.json')) && (!handle || !fs.existsSync(handle.hostPath)));

  let smoke = null; try { smoke = require(SMOKE_FILE); } catch {}
  const smokeArgs = smoke && smoke.smokeArgs && smoke.smokeArgs({ model:'gpt-5.6-terra', reasoningEffort:'low', authMode:'chatgpt' });
  const smokeRoot = tmp('smoke'); roots.push(smokeRoot);
  const smokeCache = {
    hostPath: path.join(smokeRoot, 'private-chatgpt-cache'), containerPath: '/root/.codex',
    mount: `${path.join(smokeRoot, 'private-chatgpt-cache')}:/root/.codex:rw`,
  };
  const taskImage = 'fixture:codex-task-image-pinned'; const smokeCalls = []; const smokeOutput = [];
  const runSmoke = (command, argv, options) => {
    smokeCalls.push({ command, argv: [...argv], env: { ...(options && options.env) } });
    return { status: 0, stdout: '', stderr: '' };
  };
  if (smoke && typeof smoke.runChatgptContainerSmoke === 'function') {
    smoke.runChatgptContainerSmoke({ image: taskImage, authCache: smokeCache, model: 'gpt-5.6-terra', reasoningEffort: 'low', env: { CODEX_API_KEY: secret, CODEX_HOME: userHome }, run: runSmoke, out: line => smokeOutput.push(String(line)), err: line => smokeOutput.push(String(line)) });
  }
  const dockerRun = smokeCalls.find(call => call.command === 'docker' && call.argv.includes('run'));
  const volumes = dockerRun ? dockerRun.argv.filter((arg, i) => dockerRun.argv[i - 1] === '-v') : [];
  const writableVolumes = volumes.filter(mount => !/:ro$/.test(mount));
  const apiKeyInjected = !!dockerRun && (dockerRun.argv.some(arg => arg === 'CODEX_API_KEY' || String(arg).startsWith('CODEX_API_KEY=')) || Object.prototype.hasOwnProperty.call(dockerRun.env, 'CODEX_API_KEY'));
  const reportsChatgpt = smokeOutput.some(line => /authentication.*chatgpt|chatgpt.*authentication/i.test(line));
  check('C5 allows the defensive CODEX_API_KEY child-shell filter, but rejects actual Docker/API-key injection', Array.isArray(smokeArgs) && smokeArgs.some(arg => String(arg).includes('shell_environment_policy.filters.CODEX_API_KEY')) && !apiKeyInjected, secretSafe(dockerRun && { argv: dockerRun.argv, hasApiKey: Object.prototype.hasOwnProperty.call(dockerRun.env, 'CODEX_API_KEY') }, secret));
  check('C5 opt-in live smoke observably invokes the configured pinned task image through its injected run seam, mounts only the private ChatGPT cache writable at /root/.codex, and reports ChatGPT authentication', !!smoke && typeof smoke.runChatgptContainerSmoke === 'function' && !!dockerRun && dockerRun.argv.includes(taskImage) && writableVolumes.length === 1 && writableVolumes[0] === smokeCache.mount && reportsChatgpt, secretSafe(dockerRun && { command: dockerRun.command, argv: dockerRun.argv, writableVolumes, output: smokeOutput }, secret));
  const suiteText = fs.readFileSync(__filename, 'utf8');
  check('C5 deterministic Docker-free suite explicitly covers both modes, refusal ordering, disclosure, refresh, interruption, concurrency, and live smoke', /api-key/.test(suiteText) && /refus/.test(suiteText) && /concurrent/.test(suiteText) && /live smoke/.test(suiteText));
} catch (e) { check('C1-C5 deterministic fixture harness executes', false, e.stack || String(e)); }
finally { for (const root of roots) try { fs.rmSync(root, { recursive:true, force:true }); } catch {} }
process.exit(failed);
