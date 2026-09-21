// Frozen acceptance [guard] — repo-3c6: existing guarantees and fixture controls.
// Criteria -> tests: C1 -> test.js R1; C2 -> test.js R2/R3 and guard G2;
// C3 -> test.js R4; C4 -> test.js R5 and guard G5; C5 -> test.js R6/R7,
// guard G4; C6 -> guard G1/G2/G3/G5/G6; C7 -> this new two-file suite.
// Tests -> criteria: every assertion has a C-number and stable G/R identifier.
// C7 is a delivery constraint, checked by the author's Git diff, not a new
// product behavior. No other acceptance suite or product file may be edited.
// Helpers below are shared with test.js; requiring this file runs no guards.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const ROOT = path.resolve(__dirname, '../../..');
const SHELL = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
const ENDPOINT = 'https://auth.openai.com/oauth/token';
const SECRET = 'repo-3c6-SYNTHETIC-refresh-secret';
const KEY = 'repo-3c6-SYNTHETIC-api-key';
const FIXTURE_NOW = Date.now();
const jwt = exp => `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify({ exp, sub: 'fixture-account' })).toString('base64url')}.fixture`;
function session(fresh = false) {
  return JSON.stringify({ auth_mode: 'chatgpt', last_refresh: fresh ? new Date(FIXTURE_NOW).toISOString() : '2000-01-01T00:00:00Z',
    tokens: { access_token: jwt(fresh ? Math.floor(FIXTURE_NOW / 1000) + 3600 : 946684800),
      id_token: jwt(4102444800), refresh_token: fresh ? `${SECRET}-rotated` : SECRET, account_id: 'fixture-account' } });
}
function write(file, data) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data, { mode: 0o600 }); return file; }
function temp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'repo-3c6-')); }
function remove(dir) {
  if (!path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(dir).startsWith('repo-3c6-')) throw new Error('unsafe fixture cleanup');
  fs.rmSync(dir, { recursive: true, force: true });
}
function check(name, yes, detail = '') {
  console.log(`${yes ? 'ok' : 'FAIL'} - ${name}${yes ? '' : ` — ${detail}`}`);
  if (!yes) process.exitCode = 1;
}
function clean(text) { return ![SECRET, KEY, jwt(946684800), jwt(4102444800), JSON.parse(session(true)).tokens.access_token].some(s => String(text).includes(s)); }
function inside(parent, child) { const rel = path.relative(parent, child); return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel); }
const AUTH_PATH = path.join(ROOT, 'runner/codex-auth.js');

// Observe the existing bounded process boundary, not an invented refresh API. The
// production preflight/auth modules are reloaded after installing the transport.
// Only a Docker run with a private auth handoff can rotate the synthetic session.
// A host `codex login status` reports success but NEVER changes any token.
// This is a deterministic CLI/transport fixture, not a live OAuth/Docker proof.
function transport(f) {
  return (command, args = [], options = {}) => {
    const text = args.join(' ');
    if (/login\s+status/.test(text)) { f.events.push('login-status'); return { status: 0, stdout: 'Logged in using ChatGPT', stderr: '' }; }
    if (!/(?:^|[\\/])docker(?:\.exe)?$/.test(command) || args[0] !== 'run') {
      f.unexpected.push(path.basename(command));
      return { status: 97, stdout: '', stderr: 'fixture: unsupported process boundary' };
    }
    const mounts = args.flatMap((a, i) => a === '-v' || a === '--volume' ? [args[i + 1]] : []);
    const credentials = mounts.map(m => /^(.*):(\/[^:]*?)(?::(rw|ro))?$/.exec(m)).filter(Boolean)
      .map(m => ({ host: m[1], target: m[2], mode: m[3] || 'rw' }))
      .filter(m => fs.existsSync(path.join(m.host, 'auth.json')));
    const handoff = credentials.find(m => inside(f.lane, m.host));
    const pairs = (flag, value) => args.some((a, i) => a === flag && args[i + 1] === value);
    const proxy = args.some(a => a === `HTTPS_PROXY=${f.cfg.proxyUrl}`);
    const env = options.env || {};
    const restricted = !!handoff && credentials.length === 1 && handoff.mode === 'rw'
      && pairs('--network', f.cfg.network) && proxy
      && /\bcodex\b/.test(text) && args.includes(f.cfg.image || 'fixture:image')
      && !args.some(a => /--privileged|--network=host|docker\.sock/.test(a))
      && !mounts.some(m => m.includes(f.home) || m.includes(f.target))
      && !env.CODEX_API_KEY && !env.OPENAI_API_KEY && !env.CODEX_HOME
      && clean(text) && !args.some(a => /entrypoint\.sh/.test(a));
    const locked = fs.existsSync(path.join(f.lane, '.lane.lock'));
    f.calls.push({ restricted, locked, handoff: handoff && handoff.host });
    f.events.push('refresh');
    if (!restricted || !locked) return { status: 96, stdout: '', stderr: 'fixture: refresh escaped lane-private restricted path' };
    const noise = `${SECRET} ${KEY} ${jwt(946684800)}\n`.repeat(100);
    if (f.outcome === 'denied') return { status: 1, stdout: noise, stderr: `401 invalid_grant ${noise}` };
    if (f.outcome === 'failed') return { status: 7, stdout: '', stderr: `connection failed ${noise}` };
    if (f.outcome === 'timeout') return { status: null, timedOut: true, stdout: noise, stderr: noise };
    let next = session(true);
    if (f.outcome === 'malformed') next = '{ broken refresh reply';
    if (f.outcome === 'expired') next = session(false);
    if (f.outcome === 'missing-access') { const s = JSON.parse(next); delete s.tokens.access_token; next = JSON.stringify(s); }
    if (f.outcome === 'missing-refresh') { const s = JSON.parse(next); delete s.tokens.refresh_token; next = JSON.stringify(s); }
    write(path.join(handoff.host, 'auth.json'), next);
    f.rotated = next;
    return { status: 0, stdout: '', stderr: '' };
  };
}

async function readiness({ outcome = 'success', roster = false, provider = 'codex', mode = 'chatgpt', fault = false } = {}) {
  const dir = temp();
  const f = { dir, lane: path.join(dir, 'lane'), home: path.join(dir, 'operator'), target: path.join(dir, 'target'),
    outcome, events: [], calls: [], unexpected: [], log: [], atomic: [], protections: [] };
  f.cfg = { provider, codexAuth: mode, targetRepoPath: f.target, targetRepoRemote: 'fixture',
    image: 'fixture:pinned-codex', network: 'repo-3c6-private', proxyName: 'repo-3c6-proxy',
    proxyPort: 3128, proxyUrl: 'http://repo-3c6-proxy:3128', lifecycleTimeoutMs: 1000,
    ...(roster ? { codexAuthCacheRoots: [f.lane] } : {}) };
  const durable = write(path.join(f.lane, 'auth.json'), session(false));
  write(path.join(f.home, 'auth.json'), session(true)); // Must not overwrite durable state from this newer seed.
  const processModule = require(path.join(ROOT, 'runner/process.js'));
  const original = processModule.runSync;
  const originalRename = fs.renameSync;
  const originalChmod = fs.chmodSync;
  const originalWrite = fs.writeFileSync;
  const modules = ['preflight.js', 'codex-auth.js'].map(n => path.join(ROOT, 'runner', n));
  const cached = modules.map(n => require.cache[n]);
  try {
    processModule.runSync = transport(f);
    for (const n of modules) delete require.cache[n];
    fs.chmodSync = (file, mode) => { if (inside(dir, String(file))) f.protections.push({ file: String(file), mode }); return originalChmod(file, mode); };
    fs.writeFileSync = (file, data, opts) => {
      if (typeof file === 'string' && path.resolve(file) === durable) f.events.push('in-place-durable-write');
      return originalWrite(file, data, opts);
    };
    fs.renameSync = (from, to) => {
      if (path.resolve(to) === durable) {
        f.atomic.push({ sameDirectory: path.dirname(from) === path.dirname(to),
          oldIntact: fs.readFileSync(to, 'utf8') === session(false),
          protected: f.protections.some(p => p.file === from && p.mode === 0o600),
          newFresh: JSON.parse(fs.readFileSync(from, 'utf8')).tokens.access_token === JSON.parse(session(true)).tokens.access_token });
        if (fault) throw new Error('fixture atomic rename denied');
      }
      return originalRename(from, to);
    };
    const deps = {
      env: { CODEX_HOME: f.home, PIPELINE_CODEX_CACHE: f.lane, CODEX_API_KEY: KEY, OPENAI_API_KEY: KEY },
      admitEntry: () => ({ ok: true, mode: 'supervisor-child', admission: { parent: { id: 'fixture', pid: process.pid }, nonce: 'fixture' } }),
      verifyRepoIdentity: () => ({ ok: true, remoteName: 'fixture', identity: 'fixture' }),
      resolveHostShell: () => ({ ok: true, command: SHELL, kind: 'fixture' }),
      dockerAvailable: () => ({ status: 0 }), imageExists: () => ({ status: 0 }),
      imageSupportsProvider: () => true, codexSandboxAvailable: () => true,
      networkUp: () => { f.events.push('network'); return { ok: true }; },
      networkDown: () => ({ ok: true }), egressCheck: () => ({ ok: true }),
      recoverStaleIssues: () => { f.events.push('beads-mutation'); return { recovered: [] }; },
    };
    const log = { runId: 'repo-3c6', info: (...x) => f.log.push(x.join(' ')), error: (...x) => f.log.push(x.join(' ')) };
    const returned = require(modules[0]).preflight(f.cfg, ROOT, log, deps);
    f.synchronous = !returned || typeof returned.then !== 'function';
    f.result = await returned;
    f.after = fs.readFileSync(durable, 'utf8');
    f.diagnostic = [f.result.reason || '', ...f.log].join('\n');
    f.recoverable = f.calls.some(c => c.handoff && fs.existsSync(path.join(c.handoff, 'auth.json')));
    f.mode = fs.statSync(durable).mode & 0o777;
    f.targetAbsent = !fs.existsSync(f.target);
    return f;
  } finally {
    processModule.runSync = original; fs.renameSync = originalRename; fs.chmodSync = originalChmod; fs.writeFileSync = originalWrite;
    modules.forEach((n, i) => { delete require.cache[n]; if (cached[i]) require.cache[n] = cached[i]; });
    remove(dir);
  }
}

// Execute the actual egress gate with a fake Docker transport and curl only. The
// gate's shell conditions and env-unsetting negative control execute unchanged.
// Each fixture invocation owns its temp PATH; no Docker, network, or real token.
function egress(scenario = 'healthy', profile = 'codex', control = false) {
  const dir = temp(); const trace = path.join(dir, 'trace');
  try {
    write(path.join(dir, 'docker'), `#!/usr/bin/env node\nconst cp=require('child_process');const a=process.argv.slice(2), e={...process.env};for(let i=0;i<a.length;i++)if(a[i]==='-e'){const v=a[++i],p=v.indexOf('=');if(p>=0)e[v.slice(0,p)]=v.slice(p+1);}const i=a.lastIndexOf('-c');if(i<0)process.exit(95);const pre='if command -v cygpath >/dev/null 2>&1; then FIXTURE_BIN=$(cygpath -u "$FIXTURE_BIN"); fi; export PATH="$FIXTURE_BIN:$PATH"; hash -r; [ "$(command -v curl)" = "$FIXTURE_BIN/curl" ] || { echo "HARNESS: nested curl shim absent"; exit 98; }; ';const r=cp.spawnSync(process.env.FIXTURE_SHELL,['-c',pre+a[i+1]],{env:e,stdio:'inherit'});process.exit(r.status===null?95:r.status);\n`);
    write(path.join(dir, 'timeout'), '#!/bin/sh\nshift\nexec "$@"\n');
    write(path.join(dir, 'curl'), `#!/usr/bin/env node
const fs=require('fs');const a=process.argv.slice(2), url=a.find(x=>/^https:/.test(x))||'';
const direct=!process.env.HTTPS_PROXY&&!process.env.HTTP_PROXY;
fs.appendFileSync(process.env.FIXTURE_TRACE,JSON.stringify({url,direct})+'\\n');
const s=process.env.FIXTURE_SCENARIO;let allowed=false;
if(direct)allowed=s==='direct-open';
else if(url==='https://github.com/')allowed=s==='github-open';
else if(url==='https://registry.npmjs.org/')allowed=s==='npm-open';
else if(url.startsWith('https://auth.openai.com/'))allowed=s!=='refresh-down';
else allowed=s!=='model-down';
process.stdout.write(allowed?'200':'000');process.exit(allowed?0:7);
`);
    for (const name of ['docker', 'curl', 'timeout']) fs.chmodSync(path.join(dir, name), 0o755);
    const bin = dir.replace(/\\/g, '/').replace(/^([A-Za-z]):\//, (_, drive) => `/${drive.toLowerCase()}/`);
    const env = { ...process.env, FIXTURE_BIN: bin, FIXTURE_TRACE: trace,
      FIXTURE_SCENARIO: scenario, FIXTURE_SHELL: SHELL, PIPELINE_PROXY_PROFILE: profile,
      PIPELINE_NET: 'repo-3c6-private', PIPELINE_PROXY: 'repo-3c6-proxy',
      FIXTURE_OAUTH: ENDPOINT, HTTPS_PROXY: 'http://repo-3c6-proxy:3128', HTTP_PROXY: 'http://repo-3c6-proxy:3128',
      BASH_ENV: '' };
    for (const name of ['CODEX_HOME', 'CODEX_API_KEY', 'OPENAI_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'MSYS_NO_PATHCONV', 'MSYS2_ARG_CONV_EXCL']) delete env[name];
    const command = control ? 'curl "$FIXTURE_OAUTH"' : 'bash scripts/egress-check.sh';
    const r = cp.spawnSync(SHELL, ['-c', 'export PATH="$FIXTURE_BIN:$PATH"; hash -r; for tool in docker curl timeout; do [ "$(command -v "$tool")" = "$FIXTURE_BIN/$tool" ] || { echo "HARNESS: shim not selected: $tool"; exit 98; }; done; ' + command],
      { cwd: ROOT, env, encoding: 'utf8', timeout: 15000 });
    return { status: r.status, output: `${r.stdout || ''}${r.stderr || ''}`, error: r.error && r.error.code,
      trace: fs.existsSync(trace) ? fs.readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [] };
  } finally { remove(dir); }
}

async function guards() {
  const auth = require(AUTH_PATH); const dir = temp();
  try {
    const lane = path.join(dir, 'lane'); const durable = write(path.join(lane, 'auth.json'), session(false));
    const handle = await auth.stageTaskCache({ cacheRoot: lane, taskId: 'guard', timeoutMs: 30, retryMs: 5 });
    let busy = false;
    try { await auth.stageTaskCache({ cacheRoot: lane, taskId: 'contender', timeoutMs: 30, retryMs: 5, staleMs: 0 }); }
    catch (e) { busy = /busy/.test(e.message); }
    check('C6 G1 [guard] a live owner excludes a second handoff; task receives a private copy',
      busy && inside(lane, handle.hostPath) && fs.readFileSync(path.join(handle.hostPath, 'auth.json'), 'utf8') === session(false));
    write(path.join(handle.hostPath, 'auth.json'), session(true));
    const faulty = Object.create(fs); faulty.renameSync = () => { throw new Error('fixture persistence failure'); };
    handle.fs = faulty; let failed = false;
    try { await auth.releaseTaskCache(handle); } catch { failed = true; }
    check('C2 C6 G2 [guard] failed persistence preserves prior durable bytes and recoverable task copy',
      failed && fs.readFileSync(durable, 'utf8') === session(false) && fs.existsSync(path.join(handle.hostPath, 'auth.json')));
    handle.fs = fs; await auth.recoverTaskCache(handle);
    check('C2 C6 G2 [guard] exclusive recovery persists rotated state and removes only the task copy',
      fs.readFileSync(durable, 'utf8') === session(true) && !fs.existsSync(handle.hostPath)
      && (process.platform === 'win32' || (fs.statSync(durable).mode & 0o777) === 0o600));
    // Positive and adversarial controls for exactly the transport used in red tests.
    const f = { lane, home: path.join(dir, 'home'), target: path.join(dir, 'target'), cfg: { network: 'fixture-net', proxyUrl: 'http://fixture:3128' },
      outcome: 'success', events: [], calls: [], unexpected: [] };
    const h = await auth.stageTaskCache({ cacheRoot: lane, taskId: 'transport' });
    const args = ['run', '--network', f.cfg.network, '-e', `HTTPS_PROXY=${f.cfg.proxyUrl}`, '-v', `${h.hostPath}:/private:rw`, 'fixture:image', 'codex', 'exec'];
    const exec = transport(f);
    const yes = exec('docker', args, { env: {} });
    const no = exec('docker', args.map(a => a === f.cfg.network ? 'host' : a), { env: {} });
    const login = exec('codex', ['login', 'status']);
    check('C1 C3 G3 [guard] fixture rotates only a locked private restricted handoff; login status is inert',
      yes.status === 0 && no.status !== 0 && login.status === 0 && f.calls.length === 2
      && f.calls[0].restricted && !f.calls[1].restricted);
    f.outcome = 'denied'; const denial = exec('docker', args, { env: {} });
    f.outcome = 'malformed'; exec('docker', args, { env: {} });
    check('C3 G3 [guard] refresh fixture really supplies denied diagnostics and malformed output',
      denial.status !== 0 && denial.stderr.includes(SECRET) && fs.readFileSync(path.join(h.hostPath, 'auth.json'), 'utf8') === '{ broken refresh reply');
    write(path.join(h.hostPath, 'auth.json'), session(true)); await auth.releaseTaskCache(h);
    const foreign = { pid: process.pid, createdAt: Date.now(), nonce: 'another-owner' };
    await auth.withCacheLock({ cacheRoot: lane }, () => write(path.join(lane, '.lane.lock'), JSON.stringify(foreign)));
    check('C6 G1 [guard] owner-aware release never deletes a replacement owner record',
      JSON.parse(fs.readFileSync(path.join(lane, '.lane.lock'), 'utf8')).nonce === foreign.nonce);
    fs.unlinkSync(path.join(lane, '.lane.lock'));
    const container = require(path.join(ROOT, 'runner/container.js'));
    const argsFor = container.buildArgs({ provider: 'codex', codexAuth: 'chatgpt', image: 'fixture', network: 'private', proxyUrl: 'http://fixture:3128' },
      { containerName: 'fixture', workspaceDir: path.join(dir, 'workspace'), pipelineDir: path.join(dir, 'pipeline'),
        issueId: 'repo-3c6', authCache: { hostPath: h.hostPath } });
    check('C6 G5 [guard] task container receives only task-private writable handoff and managed-auth marker',
      argsFor.some(a => /:\/run\/pipeline-auth-host\/cache:rw$/.test(a)) && argsFor.includes('PIPELINE_CHATGPT_AUTH=1')
      && !argsFor.includes('CODEX_API_KEY') && !argsFor.includes('OPENAI_API_KEY')
      && !argsFor.some(a => a.startsWith('CODEX_HOME=')));
  } finally { remove(dir); }
  for (const [provider, mode] of [['codex', 'api-key'], ['claude', 'chatgpt']]) {
    const r = await readiness({ provider, mode });
    check(`C6 G6 [guard] ${provider}/${mode} keeps synchronous admission and skips refresh`,
      r.result.ok && r.synchronous && r.calls.length === 0 && r.events.includes('beads-mutation'));
  }
  for (const scenario of ['healthy', 'model-down', 'github-open', 'npm-open', 'direct-open']) {
    const r = egress(scenario);
    check(`C5 G4 [guard] executable egress fixture ${scenario}`,
      !r.error && r.trace.length >= 4 && (scenario === 'healthy' ? r.status === 0 : r.status !== 0),
      `status=${r.status}; trace=${r.trace.length}; ${r.output.slice(0, 300)}`);
  }
  for (const scenario of ['healthy', 'refresh-down']) {
    const r = egress(scenario, 'codex', true);
    check(`C5 G4 [guard] OAuth transport control ${scenario}`,
      r.trace.length === 1 && r.trace[0].url === ENDPOINT && !r.trace[0].direct
      && (scenario === 'healthy' ? r.status === 0 && r.output === '200' : r.status === 7 && r.output === '000'),
      `status=${r.status}; trace=${r.trace.length}`);
  }
  const domains = fs.readFileSync(path.join(ROOT, 'docker/proxy/allowlist.txt'), 'utf8').split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith('#'));
  check('C4 C6 G5 [guard] Claude profile stays unchanged', domains.join(',') === 'api.anthropic.com,console.anthropic.com,statsig.anthropic.com');
  const entry = fs.readFileSync(path.join(ROOT, 'pipeline/entrypoint.sh'), 'utf8');
  const section = entry.slice(entry.indexOf('persist_chatgpt_auth() {'), entry.indexOf('# A successful implementation commit'));
  const script = ['set -u', 'PIPELINE_CHATGPT_AUTH=1', 'AGENT_CMD=fixture-agent', 'AGENT_FORMAT=', 'WS=/workspace', 'PIPE=/pipeline',
    ...['mkdir', 'chmod', 'cp', 'chown', 'mv', 'runuser', 'env', 'sh'].map(n => `${n}() { printf '${n} %s\\n' "$*"; }`),
    'die30() { exit 30; }', section, 'run_agent', 'run_verifier'].join('\n');
  const r = cp.spawnSync(SHELL, ['-c', script], { encoding: 'utf8', timeout: 10000 });
  check('C6 G5 [guard] agent runs as node; verifier as nobody with all Codex credential variables stripped',
    r.status === 0 && /runuser -u node .*CODEX_HOME=\/root\/\.codex/.test(r.stdout)
      && /runuser -u nobody .*env -u CODEX_API_KEY -u OPENAI_API_KEY -u CODEX_HOME .*node \/pipeline\/verify.js/.test(r.stdout),
    `status=${r.status}`);
  const run = fs.readFileSync(path.join(ROOT, 'runner/run.js'), 'utf8');
  check('C3 C6 G5 [guard] runner awaits preflight before proceeding into task work',
    /await\s+Promise\.resolve\(pre\)/.test(run) && /if\s*\(!resolvedPre\.ok\)/.test(run), 'preflight await/refusal boundary changed');
}
module.exports = { ROOT, ENDPOINT, SECRET, KEY, session, readiness, egress, clean, check };
if (require.main === module) guards().catch(e => { check('C1-C6 guard HARNESS BROKEN', false, String(e.stack)); });
