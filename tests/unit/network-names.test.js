// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// Unit suite for the per-project task network and proxy sidecar — DESIGN.md §4.8, §4.12
// (change-log row `repo-jur`). Re-runnable: the sweep picks it up through
// scripts/test-network-names.sh. Its coverage is the half of tests/acceptance/repo-jur/
// that outlives that task — a frozen acceptance directory is an artifact of a finished run
// and is never executed again, but this contract has to keep holding: the day the shared
// default comes back, two projects running at once silently destroy each other's route to
// Anthropic and the surviving run's agent fails in ways that read as the model's fault.
//
// Plain Node, no test framework, no Docker, no network, no real docker binary: run it as
// `node tests/unit/network-names.test.js` from the repo root. One line per check —
// `ok - <label>` / `FAIL - <label>` — and a non-zero exit if any check failed, matching
// tests/acceptance/README.md.
//
// WHAT IT DELIBERATELY DOES NOT COVER. The two shell scripts are exercised for real by the
// Docker suites (scripts/test-egress.sh, scripts/test-egress-check.sh and the dozen that
// name `pipeline-net` in a cleanup trap). Proving here that they default correctly would
// mean shadowing the real `docker` on PATH with a stub, and a PATH stub that failed to
// intercept on one host would either drive the live daemon or report every check as a
// genuine failure. So this suite stops at the runner: what names it computes, and what it
// hands the scripts. The recorder below is run through `bash`, the way preflight runs the
// real scripts, so no extensionless-stub execution is involved (the EFTYPE trap that
// tests/unit/memory.test.js documents).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const { loadConfig, deriveNames } = require(path.join(ROOT, 'runner', 'config.js'));
const preflight = require(path.join(ROOT, 'runner', 'preflight.js'));

let failed = 0;
function check(name, cond) {
  console.log(`${cond ? 'ok' : 'FAIL'} - ${name}`);
  if (!cond) failed = 1;
}
const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };

// A name Docker accepts AND DNS handles: the proxy name is the host part of every task
// container's HTTPS_PROXY, so an underscore, a capital or an edge hyphen fails at run time
// inside the container, where nothing on the host is watching.
const SAFE_NAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'unit-netnames-'));

// ---- derivation --------------------------------------------------------------------
function writeConfig(name, extra = {}) {
  const p = path.join(tmp, name);
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
check('a config naming no network still loads', !alpha.__error && !beta.__error);
check('two projects that name nothing get different networks',
  !!alpha.network && !!beta.network && alpha.network !== beta.network);
check('two projects that name nothing get different proxies',
  !!alpha.proxyName && !!beta.proxyName && alpha.proxyName !== beta.proxyName);
// Each check pairs ownness with legality on purpose: `pipeline-net` is itself a legal
// name, so a legality-only assertion reads green while the feature is entirely absent.
check('the derived network is its own AND hostname-safe',
  alpha.network !== 'pipeline-net' && SAFE_NAME.test(String(alpha.network)));
check('the derived proxy is its own AND hostname-safe',
  alpha.proxyName !== 'pipeline-proxy' && SAFE_NAME.test(String(alpha.proxyName)));
check('the derived names identify the project, so `docker ps` is readable',
  String(alpha.network).includes('alpha') && String(alpha.proxyName).includes('alpha'));

// Determinism is the whole reason derivation reads the file name and nothing else: `up` at
// run start, every task container and `down` at run end must agree, in one process or in
// several, across a pause and a resume. A pid-, clock- or random-derived name passes every
// uniqueness check above and then orphans the network at teardown.
const alphaAgain = load(path.join(tmp, 'run.config.alpha.json'));
check('derivation is deterministic across loads',
  alphaAgain.network === alpha.network && alphaAgain.proxyName === alpha.proxyName);

const probe = spawnSync(process.execPath, ['-e', [
  `const { loadConfig } = require(${JSON.stringify(path.join(ROOT, 'runner', 'config.js'))});`,
  `const c = loadConfig(${JSON.stringify(path.join(tmp, 'run.config.alpha.json'))});`,
  'process.stdout.write(JSON.stringify({ network: c.network, proxyName: c.proxyName }));',
].join('\n')], { encoding: 'utf8', timeout: 60000 });
let other = null;
try { other = JSON.parse(probe.stdout || 'null'); } catch { /* reported next */ }
check('harness: a second process could load the same config',
  !!other && typeof other.network === 'string');
check('derivation is identical in a separate process (not pid-, clock- or random-derived)',
  !!other && other.network === alpha.network && other.proxyName === alpha.proxyName);

// Sanitising is lossy, and two project names that reduce to the same label would collide
// exactly as the old shared default did.
const weird = load(writeConfig('run.config.My Weird+Project.json'));
const weird2 = load(writeConfig('run.config.my-weird-project.json'));
check('an awkward project name is sanitised, not passed through',
  !weird.__error && SAFE_NAME.test(String(weird.network)) && SAFE_NAME.test(String(weird.proxyName)));
check('two project names that reduce to the same label still differ',
  !weird2.__error && weird.network !== weird2.network && weird.proxyName !== weird2.proxyName);

// The other half of "the Docker suites stay green": a config with no project segment keeps
// the historical pair, and the suites generate exactly that (or a name of their own that is
// not a run.config at all).
const bare = load(writeConfig('run.config.json'));
check('a bare run.config.json keeps the default network', bare.network === 'pipeline-net');
check('a bare run.config.json keeps the default proxy', bare.proxyName === 'pipeline-proxy');
const suiteStyle = load(writeConfig('good.json'));
check('a config that is not a run.config.<project>.json keeps the default pair',
  suiteStyle.network === 'pipeline-net' && suiteStyle.proxyName === 'pipeline-proxy');
check('deriveNames is exported and agrees with loadConfig',
  deriveNames(path.join(tmp, 'run.config.alpha.json')).network === alpha.network &&
  deriveNames(path.join(tmp, 'run.config.json')).proxyName === 'pipeline-proxy');

// An explicit name always wins, and the URL follows whichever name won — derive the name
// but build the URL from anything else and every task proxies to a host that is not there.
const explicit = load(writeConfig('run.config.gamma.json', {
  network: 'custom-net', proxyName: 'custom-proxy', proxyPort: 3200,
}));
check('an explicit network is used verbatim', explicit.network === 'custom-net');
check('an explicit proxy is used verbatim', explicit.proxyName === 'custom-proxy');
check('proxyUrl is built from the derived proxy name',
  alpha.proxyUrl === `http://${alpha.proxyName}:${alpha.proxyPort}`);
check('proxyUrl is built from the explicit proxy name',
  explicit.proxyUrl === 'http://custom-proxy:3200');
const emptyName = load(writeConfig('run.config.delta.json', { network: '   ' }));
check('a present-but-empty network is rejected by name',
  !!emptyName.__error && /network/.test(emptyName.__error));

// ---- what the runner hands the scripts ---------------------------------------------
// A fake repo root whose scripts record the environment they were handed. preflight runs
// them through `bash`, exactly as it runs the real ones.
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
    `} >> '${record.split(path.sep).join('/')}'`,
    'exit 0',
    '',
  ].join('\n'));
  fs.chmodSync(p, 0o755);
}
writeRecorder('pipeline-net.sh', netRecord);
writeRecorder('egress-check.sh', egressRecord);

const cfg = {
  targetRepoPath: 'C:/nonexistent-by-design',
  targetRepoRemote: 'https://example.invalid/x.git',
  image: 'pipeline-x:local',
  network: 'unit-net',
  proxyName: 'unit-proxy',
  proxyPort: 3128,
  proxyUrl: 'http://unit-proxy:3128',
};
function fakeLog() {
  const lines = [];
  return { runId: 'RUNID', lines, info: (t, m) => lines.push(String(m)), error: (t, m) => lines.push(String(m)) };
}

fs.writeFileSync(netRecord, '');
const log = fakeLog();
let up = null;
try { up = preflight.networkUp(fakeRoot, cfg, log, 'RUNID/preflight'); } catch (e) { up = { __error: e.message }; }
const netSeen = read(netRecord) || '';
// The harness has to announce itself as broken rather than report a pile of failures that
// look like the runner's fault: if bash could not run the recorder, nothing below means
// anything (CLAUDE.md, "assert the artifact is right").
const recorderRan = netSeen.includes('argv=up');
check('harness: bash ran the recording pipeline-net.sh (if this fails, ignore the rest)', recorderRan);
check('networkUp reports success when the script exits 0', !!up && up.ok === true);
check('networkUp hands the script the run\'s network', netSeen.includes('PIPELINE_NET=unit-net'));
check('networkUp hands the script the run\'s proxy', netSeen.includes('PIPELINE_PROXY=unit-proxy'));
check('networkUp hands the script the run\'s proxy port', netSeen.includes('PIPELINE_PROXY_PORT=3128'));
// Pinned to the values, not to the presence of a line: "run.log mentions a network" is
// green for a line naming the shared default, which is the state this replaced.
check('networkUp names both in the log the run writes',
  log.lines.some((l) => l.includes('unit-net') && l.includes('unit-proxy')));
check('the log line names no default network or proxy',
  log.lines.length > 0 && !log.lines.some((l) => /(^|\s)pipeline-(net|proxy)(\s|$)|\/\/pipeline-proxy:/.test(l)));

fs.writeFileSync(netRecord, '');
try { preflight.networkDown(fakeRoot, cfg); } catch { /* asserted below */ }
const downSeen = read(netRecord) || '';
// Teardown is the call that used to kill another run: today's `down` removed the global
// pair whatever run invoked it.
check('networkDown hands the script the run\'s own network', downSeen.includes('PIPELINE_NET=unit-net'));
check('networkDown hands the script the run\'s own proxy', downSeen.includes('PIPELINE_PROXY=unit-proxy'));
check('networkDown never falls back to the shared default',
  /PIPELINE_NET=\S/.test(downSeen) && !/PIPELINE_NET=pipeline-net\b/.test(downSeen));

fs.writeFileSync(egressRecord, '');
let eg = null;
try { eg = preflight.egressCheck(fakeRoot, cfg); } catch (e) { eg = { __error: e.message }; }
const egSeen = read(egressRecord) || '';
check('egressCheck reports success when the gate exits 0', !!eg && eg.ok === true);
check('egressCheck is aimed at the run\'s own network', egSeen.includes('PIPELINE_NET=unit-net'));
check('egressCheck is aimed at the run\'s own proxy and port',
  egSeen.includes('PIPELINE_PROXY=unit-proxy') && egSeen.includes('PIPELINE_PROXY_PORT=3128'));

// A cfg with no names is an internal error, not a silent fall back to the shared pair:
// falling back is the whole defect, and it is invisible until two runs collide.
let guard = null;
try { preflight.networkDown(fakeRoot, {}); } catch (e) { guard = e.message; }
check('a cfg carrying no names throws instead of defaulting', typeof guard === 'string' && /network\/proxy/.test(guard));

process.exit(failed);
