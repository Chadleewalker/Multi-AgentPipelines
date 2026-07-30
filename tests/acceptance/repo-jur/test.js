// Frozen acceptance test — repo-jur: per-project Docker network and proxy, so two
// projects can run through the pipeline at once (DESIGN.md §4.8, §4.12). Written before
// implementation, from the spec alone; criteria C1–C6 below map 1:1 to the issue's
// "Done means" list. Plain Node, Docker-free.
//
// THE FROZEN INTERFACE. These tests pin three contracts the implementation must meet;
// everything else is free:
//   1. scripts/pipeline-net.sh and scripts/egress-check.sh take the network name, the
//      proxy container name and the proxy port from the environment as PIPELINE_NET,
//      PIPELINE_PROXY and PIPELINE_PROXY_PORT, each defaulting to today's value when
//      unset. Environment, not argv, because the same scripts already take BASE_IMG
//      that way — matching the existing idiom keeps one convention, not two.
//   2. runner/preflight.js exports networkUp(repoRoot, cfg, log, traceId),
//      networkDown(repoRoot, cfg) and egressCheck(repoRoot, cfg); each passes cfg's
//      names down to the script it shells. networkUp emits one info line naming both,
//      which is how criterion C5 reaches run.log.
//   3. loadConfig() fills cfg.network / cfg.proxyName by DERIVING them from the config
//      file's own name when the file names neither. Falling back to a shared constant
//      is the bug being fixed, so it must not be the default; a bare "run.config.json"
//      (no project segment, which is what the runner's own suites generate) keeps
//      today's names, which is what keeps those suites green.
//
// WHY THE FAKE docker IS GUARDED. The two shell scripts are exercised for real, with a
// recording stub earlier on PATH than the real binary. If that interception ever failed,
// the defaults case below would run a genuine `pipeline-net.sh down` and tear the
// network out from under a live run on this host. So the stub is proven to intercept
// before any script runs, and the whole file exits immediately if it does not — a
// broken harness must announce itself as broken rather than report either a pass or a
// pile of misleading failures (CLAUDE.md, "assert the artifact is right"). DOCKER_HOST
// is also pointed at a dead port for every script call, so even a stub that somehow
// failed to shadow the real docker could not reach a daemon to destroy anything.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
let failed = 0;
function check(name, cond) {
  console.log(`${cond ? 'ok' : 'FAIL'} - ${name}`);
  if (!cond) failed = 1;
}
const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
// Forward slashes everywhere a path crosses into bash: MSYS mangles backslashes.
const fwd = (p) => p.split(path.sep).join('/');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-jur-'));

// ---- the fake docker ---------------------------------------------------------------
// Records every invocation and never talks to a daemon. `network inspect` fails by
// default so the "create the network" path stays reachable; both exit codes are
// overridable for the negative cases.
const binDir = path.join(tmp, 'bin');
fs.mkdirSync(binDir, { recursive: true });
const dockerLog = path.join(tmp, 'docker-calls.log');
fs.writeFileSync(dockerLog, '');
const dockerStub = path.join(binDir, 'docker');
fs.writeFileSync(dockerStub, [
  '#!/bin/sh',
  '# fake docker (repo-jur acceptance): record argv, touch nothing.',
  `printf '%s\\n' "$*" >> '${fwd(dockerLog)}'`,
  'if [ "$1" = network ] && [ "$2" = inspect ]; then exit "${FAKE_DOCKER_INSPECT_EXIT:-1}"; fi',
  'exit "${FAKE_DOCKER_EXIT:-0}"',
  '',
].join('\n'));
fs.chmodSync(dockerStub, 0o755);

// Env for anything that shells a script: our stub first on PATH, no daemon reachable,
// and the three override variables scrubbed so the defaults case is genuinely default.
function scriptEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^path$/i.test(k)) delete env[k];
  env.PATH = `${fwd(binDir)}${path.delimiter}${process.env.PATH || ''}`;
  env.DOCKER_HOST = 'tcp://127.0.0.1:1';
  delete env.PIPELINE_NET;
  delete env.PIPELINE_PROXY;
  delete env.PIPELINE_PROXY_PORT;
  delete env.NODE_OPTIONS;
  return { ...env, ...extra };
}

// ---- harness gate: prove the stub intercepts before running anything real ----------
fs.writeFileSync(dockerLog, '');
const probe = spawnSync('bash', ['-c', 'docker jur-stub-self-check'],
  { encoding: 'utf8', timeout: 60000, env: scriptEnv() });
const intercepted = (read(dockerLog) || '').includes('jur-stub-self-check');
check('harness: the fake docker shadows the real one on PATH', intercepted);
if (!intercepted) {
  console.log('FAIL - HARNESS BROKEN: the docker stub did not intercept, so the script');
  console.log('       tests below would drive the real Docker daemon. Refusing to run');
  console.log(`       them. bash exit=${probe.status} stderr=${(probe.stderr || '').trim()}`);
  process.exit(1);
}

// ---- helpers -----------------------------------------------------------------------
function runScript(rel, args, extraEnv) {
  fs.writeFileSync(dockerLog, '');
  const r = spawnSync('bash', [path.join(ROOT, 'scripts', rel), ...args],
    { encoding: 'utf8', timeout: 120000, cwd: ROOT, env: scriptEnv(extraEnv) });
  return { r, log: read(dockerLog) || '' };
}
const toks = (s) => String(s).split(/\s+/).filter(Boolean);
const hasTok = (s, t) => toks(s).includes(t);
// The image tag `pipeline-proxy:local` legitimately contains the old proxy name and is
// shared on purpose, so match whole tokens — plus the proxy URL form, which would
// otherwise hide a stale `http://pipeline-proxy:3128` inside one token.
const namesDefaults = (s) =>
  hasTok(s, 'pipeline-net') || hasTok(s, 'pipeline-proxy') || /\/\/pipeline-proxy:/.test(s);
const ALPHA = { PIPELINE_NET: 'alpha-net', PIPELINE_PROXY: 'alpha-proxy' };
const BETA = { PIPELINE_NET: 'beta-net', PIPELINE_PROXY: 'beta-proxy' };

// ---- C6: no overrides means exactly today's behaviour ------------------------------
// This is what keeps the dozen suites that hard-code these names green.
const upDefault = runScript('pipeline-net.sh', ['up'], {});
check('C6 pipeline-net.sh up with no overrides exits 0', upDefault.r.status === 0);
check('C6 up with no overrides still names pipeline-net', hasTok(upDefault.log, 'pipeline-net'));
check('C6 up with no overrides still names pipeline-proxy', hasTok(upDefault.log, 'pipeline-proxy'));
check('C6 up with no overrides invents no other network',
  !hasTok(upDefault.log, 'alpha-net') && !hasTok(upDefault.log, 'beta-net'));

const downDefault = runScript('pipeline-net.sh', ['down'], {});
check('C6 pipeline-net.sh down with no overrides exits 0', downDefault.r.status === 0);
check('C6 down with no overrides still names pipeline-net', hasTok(downDefault.log, 'pipeline-net'));
check('C6 down with no overrides still names pipeline-proxy', hasTok(downDefault.log, 'pipeline-proxy'));

// ---- C1 + C3: the scripts act on the names they are given, and only those -----------
const upAlpha = runScript('pipeline-net.sh', ['up'], ALPHA);
check('C3 up honours PIPELINE_NET', hasTok(upAlpha.log, 'alpha-net'));
check('C3 up honours PIPELINE_PROXY', hasTok(upAlpha.log, 'alpha-proxy'));
check('C1 up touches no default-named network or proxy', !namesDefaults(upAlpha.log));
check('C1 up exits 0 under an override', upAlpha.r.status === 0);

// The one that matters most: teardown. Today's down() removes the global pair, which is
// exactly how one run's exit kills another run that is still working.
const downAlpha = runScript('pipeline-net.sh', ['down'], ALPHA);
check('C3 down honours PIPELINE_NET', hasTok(downAlpha.log, 'alpha-net'));
check('C3 down honours PIPELINE_PROXY', hasTok(downAlpha.log, 'alpha-proxy'));
check('C1 down removes NOTHING named by default', !namesDefaults(downAlpha.log));

const downBeta = runScript('pipeline-net.sh', ['down'], BETA);
check('C1 tearing down one project never names another project\'s network',
  hasTok(downBeta.log, 'beta-net') && !hasTok(downBeta.log, 'alpha-net'));
check('C1 tearing down one project never names another project\'s proxy',
  hasTok(downBeta.log, 'beta-proxy') && !hasTok(downBeta.log, 'alpha-proxy'));

// Bringing beta up must not disturb alpha either.
const upBeta = runScript('pipeline-net.sh', ['up'], BETA);
check('C1 bringing one project up names no other project\'s resources',
  hasTok(upBeta.log, 'beta-net') && !hasTok(upBeta.log, 'alpha-net') && !hasTok(upBeta.log, 'alpha-proxy'));

// The proxy IMAGE is shared on purpose — same content for every project. Per-projecting
// the tag as well would rebuild one squid image per project for no reason, and nothing
// else here would notice: every criterion above passes either way.
check('C1 the proxy image tag stays shared under an override',
  hasTok(upAlpha.log, 'pipeline-proxy:local') && hasTok(upBeta.log, 'pipeline-proxy:local'));
check('C6 the proxy image tag is unchanged with no override',
  hasTok(upDefault.log, 'pipeline-proxy:local'));

// ---- C4: the egress gate runs against the run's own network and proxy --------------
const egAlpha = runScript('egress-check.sh', [], { ...ALPHA, PIPELINE_PROXY_PORT: '3129' });
check('C4 egress check exits 0 when the probes pass', egAlpha.r.status === 0);
check('C4 egress check probes on the run\'s own network', hasTok(egAlpha.log, 'alpha-net'));
check('C4 egress check proxies through the run\'s own proxy and port',
  /\/\/alpha-proxy:3129/.test(egAlpha.log));
check('C4 egress check names no default network or proxy', !namesDefaults(egAlpha.log));

const egDefault = runScript('egress-check.sh', [], {});
check('C6 egress check with no overrides still uses pipeline-net', hasTok(egDefault.log, 'pipeline-net'));
check('C6 egress check with no overrides still uses the default proxy URL',
  /\/\/pipeline-proxy:3128/.test(egDefault.log));

// Still a gate: a failing probe must still abort the run, override or not.
const egFail = runScript('egress-check.sh', [], { ...ALPHA, FAKE_DOCKER_EXIT: '1' });
check('C4 egress check still fails the run when the allowlist does not hold',
  egFail.r.status !== 0);

// ---- C2 + C3: where the names come from when the config does not say ---------------
let loadConfig = null;
try { ({ loadConfig } = require(path.join(ROOT, 'runner', 'config.js'))); } catch { /* reported */ }
check('runner/config.js exposes loadConfig', typeof loadConfig === 'function');

const cfgDir = path.join(tmp, 'configs');
fs.mkdirSync(cfgDir, { recursive: true });
function writeConfig(name, extra = {}) {
  const p = path.join(cfgDir, name);
  fs.writeFileSync(p, JSON.stringify({
    targetRepoPath: 'C:/nonexistent-by-design',
    targetRepoRemote: 'https://example.invalid/x.git',
    image: 'pipeline-x:local',
    ...extra,
  }, null, 2));
  return p;
}
function load(p) {
  try { return loadConfig(p); } catch (e) { return { __error: e.message }; }
}

const alpha = load(writeConfig('run.config.alpha.json'));
const beta = load(writeConfig('run.config.beta.json'));
check('C2 a config naming no network still loads', !alpha.__error && !beta.__error);
check('C2 two projects that both say nothing get DIFFERENT networks',
  !!alpha.network && !!beta.network && alpha.network !== beta.network);
check('C2 two projects that both say nothing get DIFFERENT proxies',
  !!alpha.proxyName && !!beta.proxyName && alpha.proxyName !== beta.proxyName);
check('C2 the derived network is not the old shared constant', alpha.network !== 'pipeline-net');
check('C2 the derived proxy is not the old shared constant', alpha.proxyName !== 'pipeline-proxy');
check('C2 the derived names identify the project, so a human can read `docker ps`',
  String(alpha.network).toLowerCase().includes('alpha') &&
  String(alpha.proxyName).toLowerCase().includes('alpha'));
// A name Docker will actually accept: [a-zA-Z0-9][a-zA-Z0-9_.-]*
// Each of these pairs legality with ownness deliberately: "pipeline-net" is itself a
// legal name, so a legality-only check would read "ok" for every one of these while the
// feature was still entirely absent.
//
// Hostname-safe, not merely Docker-safe. The proxy name is handed to every task
// container as the host part of HTTPS_PROXY=http://<name>:<port>, so a name Docker
// accepts but DNS handles poorly (an underscore, a leading or trailing hyphen, mixed
// case) fails at run time, inside the container, where no Docker-free test can see it.
const SAFE_NAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
check('C2 the derived network is its own AND a legal, hostname-safe name',
  alpha.network !== 'pipeline-net' && SAFE_NAME.test(String(alpha.network)));
check('C2 the derived proxy is its own AND a legal, hostname-safe name',
  alpha.proxyName !== 'pipeline-proxy' && SAFE_NAME.test(String(alpha.proxyName)));

// Derivation must be a pure function of the config, not of the clock or the cwd:
// a paused-and-resumed run reloads its config and must find the same network.
const alphaAgain = load(path.join(cfgDir, 'run.config.alpha.json'));
check('C2 derivation is deterministic across loads',
  alpha.network !== 'pipeline-net' &&
  alphaAgain.network === alpha.network && alphaAgain.proxyName === alpha.proxyName);

// ...and across PROCESSES. A name built from a pid, a clock or a random suffix passes
// every check above, then breaks teardown: the `down` at run end computes a different
// name than the `up` did, so the network and proxy are orphaned and the next run of the
// same project collides with them. This is the check that rules that class out.
const probeCode = [
  `const { loadConfig } = require(${JSON.stringify(fwd(path.join(ROOT, 'runner', 'config.js')))});`,
  `const c = loadConfig(${JSON.stringify(fwd(path.join(cfgDir, 'run.config.alpha.json')))});`,
  'process.stdout.write(JSON.stringify({ network: c.network, proxyName: c.proxyName }));',
].join('\n');
const probeEnv = { ...process.env };
delete probeEnv.NODE_OPTIONS;
const probeRun = spawnSync(process.execPath, ['-e', probeCode],
  { encoding: 'utf8', timeout: 60000, env: probeEnv });
let otherProcess = null;
try { otherProcess = JSON.parse(probeRun.stdout || 'null'); } catch { /* reported next */ }
check('C2 harness: a second process could load the same config',
  !!otherProcess && typeof otherProcess.network === 'string');
check('C2 derivation is identical in a separate process (not pid-, clock- or random-derived)',
  !!otherProcess && otherProcess.network === alpha.network &&
  otherProcess.proxyName === alpha.proxyName && alpha.network !== 'pipeline-net');

// A project name that is not already a legal Docker name must be sanitised, not passed
// through — Docker rejects the name and the run dies at preflight for a silly reason.
const weird = load(writeConfig('run.config.My Weird+Project.json'));
check('C2 an awkward project name still derives its own, hostname-safe network',
  !weird.__error && SAFE_NAME.test(String(weird.network)) &&
  weird.network !== alpha.network && weird.network !== 'pipeline-net');
check('C2 an awkward project name still derives its own, hostname-safe proxy',
  !weird.__error && SAFE_NAME.test(String(weird.proxyName)) &&
  weird.proxyName !== alpha.proxyName && weird.proxyName !== 'pipeline-proxy');

// The runner's own suites generate a bare run.config.json in a temp dir. That case keeps
// today's names, which is the other half of C6.
const bare = load(writeConfig('run.config.json'));
check('C6 a bare run.config.json keeps the default network', bare.network === 'pipeline-net');
check('C6 a bare run.config.json keeps the default proxy', bare.proxyName === 'pipeline-proxy');

// C3: an explicit name always wins over derivation.
const explicit = load(writeConfig('run.config.gamma.json', {
  network: 'custom-net', proxyName: 'custom-proxy', proxyPort: 3200,
}));
check('C3 an explicit network is used verbatim', explicit.network === 'custom-net');
check('C3 an explicit proxy is used verbatim', explicit.proxyName === 'custom-proxy');

// The proxy URL the container is handed must be built from whichever name won. Derive
// the name but build the URL from the old constant and every task loses its egress.
check('C2 proxyUrl is built from the derived proxy name',
  alpha.proxyUrl === `http://${alpha.proxyName}:${alpha.proxyPort}`);
check('C3 proxyUrl is built from the explicit proxy name',
  explicit.proxyUrl === 'http://custom-proxy:3200');

// ---- C5: the runner passes the names down, and says which it used ------------------
// A fake repo root whose scripts record the environment they were handed. This is the
// join between the two halves: the scripts read these variables (proven above), so
// proving the runner sets them proves the whole path.
const fakeRoot = path.join(tmp, 'fakeroot');
fs.mkdirSync(path.join(fakeRoot, 'scripts'), { recursive: true });
const netRecord = path.join(tmp, 'net-record.txt');
const egressRecord = path.join(tmp, 'egress-record.txt');
function writeRecorder(name, record) {
  const p = path.join(fakeRoot, 'scripts', name);
  fs.writeFileSync(p, [
    '#!/bin/sh',
    '{',
    "  printf 'argv=%s\\n' \"$*\"",
    "  printf 'PIPELINE_NET=%s\\n' \"${PIPELINE_NET-}\"",
    "  printf 'PIPELINE_PROXY=%s\\n' \"${PIPELINE_PROXY-}\"",
    "  printf 'PIPELINE_PROXY_PORT=%s\\n' \"${PIPELINE_PROXY_PORT-}\"",
    `} >> '${fwd(record)}'`,
    'exit 0',
    '',
  ].join('\n'));
  fs.chmodSync(p, 0o755);
}
writeRecorder('pipeline-net.sh', netRecord);
writeRecorder('egress-check.sh', egressRecord);

let pf = null;
try { pf = require(path.join(ROOT, 'runner', 'preflight.js')); } catch { /* reported */ }
check('runner/preflight.js is requirable', pf !== null);
check('C5 preflight exports networkUp / networkDown / egressCheck',
  !!pf && typeof pf.networkUp === 'function' && typeof pf.networkDown === 'function' &&
  typeof pf.egressCheck === 'function');

const cfgAlpha = {
  targetRepoPath: 'C:/nonexistent-by-design',
  targetRepoRemote: 'https://example.invalid/x.git',
  image: 'pipeline-x:local',
  network: 'alpha-net',
  proxyName: 'alpha-proxy',
  proxyPort: 3128,
  proxyUrl: 'http://alpha-proxy:3128',
};
function fakeLog() {
  const lines = [];
  return { runId: 'RUNID', lines, info: (t, m) => lines.push(String(m)), error: (t, m) => lines.push(String(m)) };
}

fs.writeFileSync(netRecord, '');
const lg = fakeLog();
let upRes = null;
try { upRes = pf.networkUp(fakeRoot, cfgAlpha, lg, 'RUNID/preflight'); } catch (e) { upRes = { __error: e.message }; }
const netSeen = read(netRecord) || '';
check('C5 networkUp succeeds against the recorder', !!upRes && upRes.ok === true);
check('C5 networkUp hands the script the run\'s network', netSeen.includes('PIPELINE_NET=alpha-net'));
check('C5 networkUp hands the script the run\'s proxy', netSeen.includes('PIPELINE_PROXY=alpha-proxy'));
check('C5 networkUp hands the script the run\'s proxy port', netSeen.includes('PIPELINE_PROXY_PORT=3128'));
// Pinned to the value, not to the presence: "run.log mentions a network" is green for a
// line naming the shared default, which is the state this task exists to end.
check('C5 networkUp names both in the log the run writes',
  lg.lines.some((l) => l.includes('alpha-net') && l.includes('alpha-proxy')));
check('C5 the log line names no default network or proxy',
  lg.lines.length > 0 && !lg.lines.some((l) => namesDefaults(l)));

fs.writeFileSync(netRecord, '');
try { pf.networkDown(fakeRoot, cfgAlpha); } catch { /* asserted below */ }
const downSeen = read(netRecord) || '';
check('C5 networkDown hands the script the run\'s own network', downSeen.includes('PIPELINE_NET=alpha-net'));
check('C5 networkDown hands the script the run\'s own proxy', downSeen.includes('PIPELINE_PROXY=alpha-proxy'));
// Requires a name to have been passed at all, so this cannot pass by the script having
// been handed nothing — which is exactly today's behaviour and is not a fix.
check('C1 networkDown never falls back to the shared default',
  /PIPELINE_NET=\S/.test(downSeen) &&
  !/PIPELINE_NET=pipeline-net\b/.test(downSeen) && !/PIPELINE_PROXY=pipeline-proxy\b/.test(downSeen));

fs.writeFileSync(egressRecord, '');
let egRes = null;
try { egRes = pf.egressCheck(fakeRoot, cfgAlpha); } catch (e) { egRes = { __error: e.message }; }
const egSeen = read(egressRecord) || '';
check('C4 egressCheck succeeds against the recorder', !!egRes && egRes.ok === true);
check('C4 egressCheck is aimed at the run\'s own network', egSeen.includes('PIPELINE_NET=alpha-net'));
check('C4 egressCheck is aimed at the run\'s own proxy', egSeen.includes('PIPELINE_PROXY=alpha-proxy'));

process.exit(failed);
